// IN-PAGE HALF OF `run-gi2-runner-probe.mjs` — E AT NAMED PIXELS, PER FRAME.
//
// It lives in a real module served by Vite for the reason `gi2RayProbe.js` and
// `gi2StageProbe.js` give: a bare `import("three/tsl")` inside a
// `page.evaluate` is never transformed, so the specifier does not resolve, and
// importing three by URL mints a SECOND TSL instance whose nodes cannot be
// composed with the live gather's (the vite-module-duplication trap).
//
// ══ WHY NOT `createGi2StageDump` ═════════════════════════════════════════════
//
// The stage dump reads EVERY strided pixel of one frame — 38 MB at stride 2 —
// and the runner receipt needs 480 consecutive frames. Worse, a fixed WORLD
// point read out of a strided grid lands on a DIFFERENT pixel each frame as the
// camera moves, so the grid's own quantisation would manufacture exactly the
// steps this probe exists to measure. [[probe-blind-statistics]]
//
// So this kernel is given the pixel list the CPU projected THIS frame, and
// reads six things at each of them:
//
//   0  gbuffer world position .xyz , valid (0/1)   ← the identity check: the
//      CPU keeps a sample only when this is within a tolerance of the world
//      point it asked for, so an occluded or off-surface tap is DROPPED rather
//      than silently contributing another surface's irradiance.
//   1  irradiance AFTER AO .xyz (`gi2.textures.irradiance` — the texture every
//      material samples, i.e. what the user's eye sees) , gbuffer normal .y
//   2  irradiance BEFORE AO .xyz (`gather.textures.irradiance`, the resolve's
//      own output after §19 3.12's image blend) , the lit composite's luminance
//   3.. `diagBuf`, exactly as `resolveHalf` wrote it: `DC` CASCADE rows
//        (cov, freshCov, claim, visCov/cov), then §19 4.9's FALLBACK row
//        (faceCov, tail, csum) — and in that LAST row's `.w`, the resolve's
//        own luminance BEFORE `resolveUpsample`'s image blend.
//
// ⭐⭐ THE LAST ROW IS WHAT MAKES THE ATTRIBUTION A MEASUREMENT. A jump in the
// final irradiance with the pre-blend luminance steady is the ACCUMULATOR
// switching validity; a jump in both is the FIELD. A jump in `fresh` is a probe
// that was re-keyed and is ramping (§19 4.3c `wpSeedRamp`); a jump in `cov` or
// `claim` with `fresh` flat is the eight-corner hand-off (`wpCovFull`); a jump
// in `vis` alone is the Chebyshev test switching. Every candidate mechanism the
// §AE brief lists has its own column, read out of the SAME registers the
// composite was built from rather than re-derived from an argument about them.
//
// ⚠ `diagBuf` EXISTS ONLY WHEN `globalThis.__gi2NoiseDump = true` WAS SET
// BEFORE BOOT (`wantNoise` gates the BUILD in `gatherProbes.js`). Without it
// this returns `hasDiag: false` and the caller must say so rather than report a
// table of zeros.
//
// ⚠ AND THE PIXELS MUST BE EVEN. `resolveHalf` dispatches over the half-res
// grid and each thread reads the gbuffer at `2·gx, 2·gy` — so the diag row that
// describes a full-res pixel is the one at `px>>1, py>>1` ONLY when `px`/`py`
// are even. The caller snaps; this file clamps and documents.
import { Fn, float, instanceIndex, instancedArray, int, ivec2, texture, uint, vec4 } from "three/tsl";

const MAX_PTS = 1024;

/**
 * Build (once, cached on the gi2 object) a kernel that reads every GI2 screen
 * stage plus the §19 3.18 diagnostics at an arbitrary list of pixels.
 *
 * @param {object} args
 * @param {any}    args.renderer engine WebGPURenderer
 * @param {object} args.gi2      the live `createGi2System` object
 * @param {object} args.screen   `giSystem.state.screen` (for `gbuffer`)
 */
export function createGi2PointSampler({ renderer, gi2, screen }) {
  const gather = gi2?.gather;
  const gbuffer = screen?.gbuffer;
  if (!gather || !gbuffer) return null;
  const width = gi2.width;
  const height = gi2.height;
  const halfW = Math.max(1, Math.ceil(width / 2));
  const halfH = Math.max(1, Math.ceil(height / 2));
  const diagBuf = gather.buffers?.diagBuf ?? null;
  const DV = diagBuf ? (gather.buffers?.diagVec ?? 0) : 0;
  /**
   * §19 4.9: how many of those rows are CASCADES. Row `DV - 1` is the
   * FALLBACK row — `(faceCov, tail, csum, luma)` — and a caller that scores it
   * as another cascade reads `faceCov` as `cov`.
   */
  const DC = diagBuf ? (gather.buffers?.diagCasc ?? DV) : 0;
  const OUT_VEC = 3 + DV;

  const irrAfterTex = gi2.textures.irradiance;
  const irrBeforeTex = gather.textures.irradiance;
  const litTex = gather.textures.lit;

  // ⚠ KEYED ON EVERY TEXTURE IDENTITY IT BINDS — a resize or an `ao` flip
  // rebuilds the gather, and a cached kernel would keep sampling the dead
  // textures ("Destroyed texture used in a submit"). Same rule as
  // `gi2StageProbe.js`; a key change simply builds a second kernel.
  const key = [
    width, height, DV,
    gbuffer.position.uuid, gbuffer.normal.uuid,
    irrAfterTex.uuid, irrBeforeTex.uuid, litTex.uuid,
    diagBuf ? "diag" : "nodiag",
  ].join("|");

  const holder = (gi2.__probePointRigs ??= new Map());
  let rig = holder.get(key);
  if (!rig) {
    const ptIn = instancedArray(new Float32Array(MAX_PTS * 4), "vec4");
    const ptOut = instancedArray(new Float32Array(MAX_PTS * OUT_VEC * 4), "vec4");
    const posNode = texture(gbuffer.position);
    const nrmNode = texture(gbuffer.normal);
    const irrANode = texture(irrAfterTex);
    const irrBNode = texture(irrBeforeTex);
    const litNode = texture(litTex);

    const pass = Fn(() => {
      const i = instanceIndex.toVar();
      const p = ptIn.element(i).toVar();
      const px = p.x.toInt().clamp(int(0), int(width - 1)).toVar();
      const py = p.y.toInt().clamp(int(0), int(height - 1)).toVar();
      const coord = ivec2(px, py);
      const g = posNode.load(coord).toVar();
      const n = nrmNode.load(coord).toVar();
      const ia = irrANode.load(coord).toVar();
      const ib = irrBNode.load(coord).toVar();
      const li = litNode.load(coord).toVar();
      const b = i.mul(uint(OUT_VEC)).toVar();
      // `p.w` rides through as the caller's own tag (which series the pixel
      // belongs to), so the reduction never has to trust its own index maths.
      ptOut.element(b).assign(vec4(g.xyz, g.w));
      ptOut.element(b.add(uint(1))).assign(vec4(ia.xyz, n.y));
      ptOut.element(b.add(uint(2))).assign(vec4(ib.xyz,
        li.x.mul(0.2126).add(li.y.mul(0.7152)).add(li.z.mul(0.0722))));
      if (diagBuf) {
        const hx = px.div(int(2)).clamp(int(0), int(halfW - 1)).toVar();
        const hy = py.div(int(2)).clamp(int(0), int(halfH - 1)).toVar();
        const db = hy.toUint().mul(uint(halfW)).add(hx.toUint()).mul(uint(DV)).toVar();
        for (let c = 0; c < DV; c++) {
          ptOut.element(b.add(uint(3 + c))).assign(diagBuf.element(db.add(uint(c))));
        }
      } else {
        for (let c = 0; c < DV; c++) ptOut.element(b.add(uint(3 + c))).assign(vec4(float(0)));
      }
    })().compute(MAX_PTS);
    pass.__giPassName = "probe.gi2point";
    rig = { ptIn, ptOut, pass };
    holder.set(key, rig);
  }

  const { ptIn, ptOut, pass } = rig;

  /** Load the pixel list into the input buffer. Pixels are `[x, y]`. */
  const upload = (pixels) => {
    const arr = ptIn.value.array;
    const n = Math.min(MAX_PTS, pixels.length);
    for (let i = 0; i < n; i++) {
      const p = pixels[i];
      arr[i * 4] = p[0];
      arr[i * 4 + 1] = p[1];
      arr[i * 4 + 2] = 0;
      arr[i * 4 + 3] = 0;
    }
    // ⚠ THE TAIL IS PARKED ON PIXEL 0, NOT LEFT STALE. A slot the caller did
    // not fill this frame still runs (the dispatch is a fixed MAX_PTS), and a
    // stale coordinate would read a real pixel and look like data.
    for (let i = n; i < MAX_PTS; i++) { arr[i * 4] = 0; arr[i * 4 + 1] = 0; }
    ptIn.value.needsUpdate = true;
    return n;
  };

  return {
    MAX_PTS, OUT_VEC, DV, DC, hasDiag: !!diagBuf, width, height, halfW, halfH,
    /**
     * Dispatch on THIS frame and issue the readback immediately. The copy is
     * encoded when `getArrayBufferAsync` is CALLED, so deferring the call into
     * a `.then()` would read whatever frame happened to be current by then —
     * the same trap `run-gi2-motion-probe`'s `grainTick` documents.
     *
     * @returns {Promise<Float32Array>|null}
     */
    dispatch(pixels) {
      const n = upload(pixels);
      if (!n) return null;
      renderer.compute(pass);
      return renderer.getArrayBufferAsync(ptOut.value).then((b) => new Float32Array(b));
    },
    /** Awaited variant, for one-off calls outside the frame loop. */
    async sample(pixels) {
      upload(pixels);
      await renderer.computeAsync(pass);
      return new Float32Array(await renderer.getArrayBufferAsync(ptOut.value));
    },
  };
}
