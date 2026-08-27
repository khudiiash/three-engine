// IN-PAGE HALF OF `run-gi2-doors-probe.mjs` — the §19 colour-probe method for
// the SCREEN chain (the dark spots at geometry junctions, user screenshot 5).
//
// It lives in a real module for the same reason `gi2RayProbe.js` does: a bare
// `import("three/tsl")` inside a `page.evaluate` is never transformed by Vite,
// so the specifier does not resolve, and importing three by URL would mint a
// SECOND TSL module instance whose nodes cannot be composed with the live
// gather's (the vite-module-duplication trap).
//
// ⭐ WHY A WHOLE-FRAME DUMP AND NOT THREE CROPS. "the door panel inside its
// frame" cannot be named in Bistro — there is no door entity, only
// `Bistro_Research_Exterior_Paris_Building_*` meshes — and a crop somebody
// chose by eye is a crop that can be wrong about which plane it landed on. So
// every stage is dumped for every (strided) pixel of ONE frame, and the CPU
// then picks its populations out of the SAME dump: the recessed plane, the
// front plane beside it, the flat wall half a metre away, and — with no extra
// pass — the darkest pixels in the picture, wherever they turn out to be.
//
// ⚠ EVERY STAGE COMES OUT OF ONE DISPATCH. An irradiance read from one frame
// against an AO factor from the next would let the frame's own temporal blend
// move under the comparison, which is precisely the confusion the colour-probe
// method exists to remove.
import { Fn, float, globalId, If, instancedArray, int, ivec2, normalize, Return, texture, uint, vec4 } from "three/tsl";

const OUT_VEC = 6;

/**
 * Build (once, cached on the gi2 object) a kernel that writes every screen
 * stage of a strided pixel grid into one storage buffer, and return a reader.
 *
 * Layout per sample (5 × vec4, tightly packed, row-major over the strided grid):
 *
 *   0: worldPos.xyz              , gbuffer valid (0/1)
 *   1: worldNormal.xyz           , AO factor (filtered — what aoCompose reads)
 *   2: irradiance BEFORE AO .xyz , AO factor (raw — before the bilateral)
 *   3: irradiance AFTER  AO .xyz , glossy luminance
 *   4: gi2 lit composite .xyz    , palette albedo luminance is NOT here (CPU)
 *   5: the GI-TRACED SUN SHADOW, rgba — one channel per light, exactly the
 *      texture `giLight` multiplies the direct term by. It is NOT part of
 *      GI2's `lit` composite (that has no direct term at all), so a frame that
 *      is black where every GI stage is healthy is only explainable once this
 *      column is on the table.
 *
 * `irradiance AFTER` is `gi2.textures.irradiance`, i.e. the texture every
 * material actually samples; when AO is off it IS the before texture and the
 * two columns are identical BY CONSTRUCTION, which is itself a receipt.
 *
 * @param {object} args
 * @param {any}    args.renderer engine WebGPURenderer
 * @param {object} args.gi2      the live `createGi2System` object
 * @param {object} args.screen   `giSystem.state.screen` (for `gbuffer`, `aoPass`)
 * @param {number} [args.stride] pixel stride of the dump grid (2 = half res)
 */
export function createGi2StageDump({ renderer, gi2, screen, stride = 2 }) {
  const gather = gi2.gather;
  const gbuffer = screen?.gbuffer;
  if (!gather || !gbuffer) return null;
  const width = gi2.width;
  const height = gi2.height;
  const aoPass = screen?.aoPass ?? null;
  const aoTex = aoPass?.target ?? null;
  const aoRawTex = aoPass?.rawTarget ?? null;
  const aoW = aoPass?.width ?? 1;
  const aoH = aoPass?.height ?? 1;
  const irrBeforeTex = gather.textures.irradiance;
  const irrAfterTex = gi2.textures.irradiance;
  const shTex = screen?.targets?.lightShadow ?? null;
  const shW = screen?.shadowWidth ?? shTex?.image?.width ?? 1;
  const shH = screen?.shadowHeight ?? shTex?.image?.height ?? 1;

  // ⚠ THE RIG IS KEYED ON EVERY TEXTURE IDENTITY IT BINDS. Flipping the `ao`
  // prop is STRUCTURAL (`#structuralSignature`), so it destroys the gather, the
  // AO pass and `aoOut` and builds new ones — a cached kernel would keep
  // sampling the dead pair and WebGPU would refuse the submit ("Destroyed
  // texture used in a submit"), which is the §19 0.5b resize trap read from the
  // harness side. A key change simply builds a second kernel.
  const key = [
    width, height, stride,
    gbuffer.position.uuid, gbuffer.normal.uuid,
    irrBeforeTex.uuid, irrAfterTex.uuid,
    gather.textures.lit.uuid, gather.textures.glossy.uuid,
    aoTex?.uuid ?? "none", aoRawTex?.uuid ?? "none", aoW, aoH,
    shTex?.uuid ?? "none", shW, shH,
  ].join("|");

  const cacheHolder = gi2.__probeStageRigs ??= new Map();
  let rig = cacheHolder.get(key);
  if (!rig) {
    const dumpW = Math.max(1, Math.floor(width / stride));
    const dumpH = Math.max(1, Math.floor(height / stride));
    const count = dumpW * dumpH;
    const out = instancedArray(new Float32Array(count * OUT_VEC * 4), "vec4");

    const posNode = texture(gbuffer.position);
    const nrmNode = texture(gbuffer.normal);
    const irrBeforeNode = texture(irrBeforeTex);
    const irrAfterNode = texture(irrAfterTex);
    const litNode = texture(gather.textures.lit);
    const gloNode = texture(gather.textures.glossy);
    const aoNode = aoTex ? texture(aoTex) : null;
    const aoRawNode = aoRawTex ? texture(aoRawTex) : null;
    const shNode = shTex ? texture(shTex) : null;
    const toLowX = aoW / width;
    const toLowY = aoH / height;
    const toShX = shW / width;
    const toShY = shH / height;

    const pass = Fn(() => {
      const gx = globalId.x.toVar();
      const gy = globalId.y.toVar();
      If(gx.greaterThanEqual(uint(dumpW)).or(gy.greaterThanEqual(uint(dumpH))), () => { Return(); });
      const px = gx.mul(uint(stride)).toInt().toVar();
      const py = gy.mul(uint(stride)).toInt().toVar();
      const coord = ivec2(px, py);
      const g = posNode.load(coord).toVar();
      const n = normalize(nrmNode.load(coord).xyz).toVar();
      const irrB = irrBeforeNode.load(coord).toVar();
      const irrA = irrAfterNode.load(coord).toVar();
      const lit = litNode.load(coord).toVar();
      const glo = gloNode.load(coord).toVar();
      // The SAME nearest-texel map `buildAoComposePass` uses for its 2×2 base
      // (its bilinear weights average four of these); a probe that resampled
      // the AO differently would be measuring its own filter.
      const aoF = float(1).toVar();
      const aoR = float(1).toVar();
      if (aoNode) {
        const lx = px.toFloat().add(0.5).mul(toLowX).sub(0.5).floor().toInt()
          .clamp(int(0), int(aoW - 1)).toVar();
        const ly = py.toFloat().add(0.5).mul(toLowY).sub(0.5).floor().toInt()
          .clamp(int(0), int(aoH - 1)).toVar();
        aoF.assign(aoNode.load(ivec2(lx, ly)).x);
        if (aoRawNode) aoR.assign(aoRawNode.load(ivec2(lx, ly)).x);
      }
      const base = gy.mul(uint(dumpW)).add(gx).mul(uint(OUT_VEC)).toVar();
      const gloLum = glo.x.mul(0.2126).add(glo.y.mul(0.7152)).add(glo.z.mul(0.0722)).toVar();
      out.element(base).assign(vec4(g.xyz, g.w));
      out.element(base.add(uint(1))).assign(vec4(n, aoF));
      out.element(base.add(uint(2))).assign(vec4(irrB.xyz, aoR));
      out.element(base.add(uint(3))).assign(vec4(irrA.xyz, gloLum));
      out.element(base.add(uint(4))).assign(vec4(lit.xyz, 0));
      if (shNode) {
        const sx = px.toFloat().add(0.5).mul(toShX).sub(0.5).floor().toInt()
          .clamp(int(0), int(shW - 1)).toVar();
        const sy = py.toFloat().add(0.5).mul(toShY).sub(0.5).floor().toInt()
          .clamp(int(0), int(shH - 1)).toVar();
        out.element(base.add(uint(5))).assign(shNode.load(ivec2(sx, sy)));
      } else {
        out.element(base.add(uint(5))).assign(vec4(-1, -1, -1, -1));
      }
    })().compute([Math.ceil(dumpW / 8), Math.ceil(dumpH / 8)], [8, 8, 1]);
    pass.__giPassName = "probe.gi2stages";

    rig = { out, pass, dumpW, dumpH, stride, hasAo: !!aoNode, hasShadow: !!shNode };
    cacheHolder.set(key, rig);
  }

  return {
    dumpW: rig.dumpW,
    dumpH: rig.dumpH,
    stride: rig.stride,
    hasAo: rig.hasAo,
    hasShadow: rig.hasShadow,
    width,
    height,
    aoWidth: aoW,
    aoHeight: aoH,
    shadowWidth: shW,
    shadowHeight: shH,
    shadowName: shTex?.name ?? null,
    /**
     * ⭐⭐ THE FIRST DISPATCH OF A FRESH NODE WRITES NOTHING. A compute node the
     * engine has never seen has no pipeline, and `computeAsync` returns after
     * KICKING OFF the compile rather than after running the kernel — the same
     * "lazy pipeline" §19 4.3b measured on the boot path. It cost this probe
     * three boots reading a perfectly empty buffer while the gather's own
     * `noiseDump`, whose pipeline the frame had already built, read 112 992 of
     * 112 992 valid pixels off the SAME gbuffer.
     *
     * So the read is not "dispatch once and trust it": it dispatches, reads,
     * and repeats while the buffer is entirely zero. An all-zero result is
     * indistinguishable from a frame with nothing in it, which is exactly the
     * blind-instrument trap — `attempts` is returned so the caller can say
     * which of the two it is looking at.
     */
    async read(maxAttempts = 4) {
      let data = null;
      let attempts = 0;
      for (let k = 0; k < maxAttempts; k++) {
        await renderer.computeAsync(rig.pass);
        data = new Float32Array(await renderer.getArrayBufferAsync(rig.out.value));
        attempts = k + 1;
        let live = false;
        for (let j = 0; j < data.length; j += 997) if (data[j] !== 0) { live = true; break; }
        if (live) break;
      }
      data.attempts = attempts;
      return data;
    },
  };
}

export const GI2_STAGE_OUT_VEC = OUT_VEC;
