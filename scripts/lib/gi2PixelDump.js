// IN-PAGE HALF OF `run-gi2-cornell-ref.mjs` — WORLD POS, NORMAL AND IRRADIANCE
// AT EVERY STRIDED PIXEL OF ONE FRAME.
//
// It lives in a real module served by Vite for the reason every other §19 probe
// lib gives: a bare `import("three/tsl")` inside a `page.evaluate` is never
// transformed, so the specifier does not resolve, and importing three by URL
// mints a SECOND TSL instance whose nodes cannot be composed with the live
// gather's (the vite-module-duplication trap).
//
// ══ WHY NOT `createGi2StageDump` ═════════════════════════════════════════════
//
// ⭐⭐ MEASURED, 08-28, ON THE USER'S `Cornel.scene`: the stage dump's kernel
// returns 308 040 floats of EXACTLY ZERO — six dispatch attempts, `max 0` — on
// a frame whose `gather.buffers.litBuf` reads 42 825 non-zero entries and whose
// canvas has a mean of 17.3/255. The chain is alive; that kernel's dispatch is
// not. Its `Fn(...)().compute([ceil(w/8), ceil(h/8)], [8, 8, 1])` 2-D form is
// the only thing in this repo's probe libs that does not use the 1-D
// `instanceIndex` idiom, and it is the one that comes back empty.
//
// So this dump uses the idiom that is known to work here — `.compute(N)` over
// `instanceIndex`, exactly `gi2RayProbe.js`'s — rather than debugging a
// receipt that other probes depend on. [[probe-blind-statistics]]: a probe
// that returns a full, well-formatted table of zeros is the worst possible
// instrument, and the fix is a dispatch this repo can demonstrate is live.
//
// Layout per sample (3 × vec4, tightly packed, row-major over the strided grid):
//
//   0: worldPos.xyz              , gbuffer valid (0/1)
//   1: worldNormal.xyz           , irradiance BEFORE AO, luminance
//   2: irradiance AFTER  AO .xyz , the lit composite's luminance
//   3: THE WITNESS — (instanceIndex, stride, dumpW, 12345), written
//      unconditionally by every thread.
//
// ⭐⭐ THE WITNESS ROW IS NOT DECORATION. An all-zero readback has two causes
// that look identical — "the kernel never ran" and "every texture it read is
// empty" — and they call for opposite next steps. A row nothing in the frame
// can influence separates them in one read.
//
// `irradiance AFTER` is `gi2.textures.irradiance`, i.e. the texture every
// material actually samples — what the user's eye sees.
import { Fn, float, instanceIndex, instancedArray, int, ivec2, normalize, texture, uint, vec3, vec4 } from "three/tsl";

const OUT_VEC = 4;

/**
 * @param {object} args
 * @param {any}    args.renderer engine WebGPURenderer
 * @param {object} args.gi2      the live `createGi2System` object
 * @param {object} args.screen   `giSystem.state.screen` (for `gbuffer`)
 * @param {number} [args.stride] pixel stride of the dump grid
 */
export function createGi2PixelDump({ renderer, gi2, screen, stride = 4 }) {
  const gather = gi2?.gather;
  const gbuffer = screen?.gbuffer;
  if (!gather || !gbuffer) return null;
  const width = gi2.width;
  const height = gi2.height;
  const irrAfterTex = gi2.textures.irradiance;
  const irrBeforeTex = gather.textures.irradiance;
  const litTex = gather.textures.lit;

  // ⚠ KEYED ON EVERY TEXTURE IDENTITY IT BINDS — a resize or an `ao` flip
  // rebuilds the gather, and a cached kernel would keep sampling the dead
  // textures ("Destroyed texture used in a submit").
  const key = [
    width, height, stride, gbuffer.position.uuid, gbuffer.normal.uuid,
    irrAfterTex.uuid, irrBeforeTex.uuid, litTex.uuid,
  ].join("|");
  const holder = gi2.__probePixelDumps ??= new Map();
  let rig = holder.get(key);
  if (!rig) {
    const dumpW = Math.max(1, Math.floor(width / stride));
    const dumpH = Math.max(1, Math.floor(height / stride));
    const count = dumpW * dumpH;
    const out = instancedArray(new Float32Array(count * OUT_VEC * 4), "vec4");
    const posNode = texture(gbuffer.position);
    const nrmNode = texture(gbuffer.normal);
    const irrANode = texture(irrAfterTex);
    const irrBNode = texture(irrBeforeTex);
    const litNode = texture(litTex);
    const L = (c) => c.x.mul(0.2126).add(c.y.mul(0.7152)).add(c.z.mul(0.0722));

    const pass = Fn(() => {
      const i = instanceIndex.toVar();
      const gy = i.div(uint(dumpW)).toVar();
      const gx = i.sub(gy.mul(uint(dumpW))).toVar();
      const coord = ivec2(gx.mul(uint(stride)).toInt().clamp(int(0), int(width - 1)),
        gy.mul(uint(stride)).toInt().clamp(int(0), int(height - 1)));
      const g = posNode.load(coord).toVar();
      const n = normalize(nrmNode.load(coord).xyz.add(vec3(1e-9))).toVar();
      const irrA = irrANode.load(coord).toVar();
      const irrB = irrBNode.load(coord).toVar();
      const lit = litNode.load(coord).toVar();
      const base = i.mul(uint(OUT_VEC)).toVar();
      out.element(base).assign(vec4(g.xyz, g.w));
      out.element(base.add(uint(1))).assign(vec4(n, L(irrB)));
      out.element(base.add(uint(2))).assign(vec4(irrA.xyz, L(lit)));
      out.element(base.add(uint(3))).assign(vec4(i.toFloat(), float(stride), float(dumpW), float(12345)));
    })().compute(count);
    pass.__giPassName = "probe.gi2pixels";
    rig = { out, pass, dumpW, dumpH, stride, count };
    holder.set(key, rig);
  }

  return {
    dumpW: rig.dumpW, dumpH: rig.dumpH, stride: rig.stride, width, height,
    /**
     * ⭐⭐ THE FIRST DISPATCH OF A FRESH NODE WRITES NOTHING — a compute node the
     * engine has never seen has no pipeline, and `computeAsync` returns after
     * KICKING OFF the compile rather than after running the kernel. So this
     * dispatches, reads, and repeats while the buffer is entirely zero, and
     * returns `attempts` so a caller can say which of "empty frame" and "empty
     * instrument" it is looking at.
     */
    /**
     * ⭐⭐ DISPATCH, LET A REAL FRAME GO BY, THEN READ — AND CHECK THE WITNESS.
     *
     * MEASURED 08-28: `await renderer.computeAsync(pass)` followed immediately
     * by `getArrayBufferAsync` came back with the witness row EMPTY on 6 of 6
     * attempts at one dump size and on 1 of 2 at another, while the very same
     * buffer read back 3150/3150 witnesses once three rendered frames had
     * passed. The dispatch is not lost, it is not yet SUBMITTED — and a probe
     * that reads before the submit reports a scene with nothing in it.
     *
     * So the loop is: dispatch (the engine's own synchronous idiom), await
     * `awaitFrame` a few times so the engine's own submit carries it, read, and
     * repeat while the WITNESS is incomplete. The witness — not a sample of the
     * payload — is the termination test, because an all-zero payload is a legal
     * answer for a dark scene and an empty witness never is.
     *
     * @param {() => Promise<void>} awaitFrame resolves on the next post-render
     */
    async read(awaitFrame, maxAttempts = 6, framesPerAttempt = 3) {
      let data = null;
      let attempts = 0;
      for (let k = 0; k < maxAttempts; k++) {
        renderer.compute(rig.pass);
        for (let g = 0; g < framesPerAttempt; g++) await awaitFrame();
        data = new Float32Array(await renderer.getArrayBufferAsync(rig.out.value));
        attempts = k + 1;
        let w = 0;
        for (let j = OUT_VEC * 4 - 1; j < data.length; j += OUT_VEC * 4) if (data[j] === 12345) w++;
        data.witness = w;
        if (w === rig.count) break;
      }
      data.attempts = attempts;
      return data;
    },
    /** Dispatch SYNCHRONOUSLY (the engine's own idiom) — no await, no submit. */
    dispatchSync() { renderer.compute(rig.pass); },
    async readBuffer() {
      const d = new Float32Array(await renderer.getArrayBufferAsync(rig.out.value));
      let w = 0;
      for (let j = OUT_VEC * 4 - 1; j < d.length; j += OUT_VEC * 4) if (d[j] === 12345) w++;
      d.witness = w;
      return d;
    },
  };
}

export const GI2_PIXEL_OUT_VEC = OUT_VEC;
