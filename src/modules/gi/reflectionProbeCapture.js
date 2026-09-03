import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  cos,
  equirectUV,
  float,
  instanceIndex,
  int,
  ivec2,
  mix,
  select,
  sin,
  step,
  texture,
  textureStore,
  uint,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { analyticDirectAt, emitterDirectAt } from "./giLight.js";
import { octahedralDirection, octahedralUV } from "./srcOctahedral.js";
import { MAX_REFLECTION_PROBES, REFL_PROBE_LEVEL_CONES, REFL_PROBE_LEVELS, REFL_PROBE_TILE } from "./reflectionProbes.js";

/**
 * REFLECTION-PROBE CAPTURE — a traced "cubemap render" with no camera in it
 * (plan §14 unit R-B; see reflectionProbes.js for why not a CubeCamera).
 *
 * One thread per octahedral texel: decode the texel's direction, trace it
 * through the static BVH from the probe's capture point, and shade the hit
 * with EXACTLY the resolve's hit-shading formula (createGiResolve's bvhShade
 * branch): albedo × (field gather + cone-shadowed emitter direct + analytic
 * direct) / π × intensity. A traced miss samples the scene HDRI through the
 * same env bundle giLight's env-on-miss term uses. Divergence between this
 * and the resolve's hit shading would read as "the probe reflects a
 * different world than the mirror does".
 *
 * THIS IS THE MARCHER IN ITS OWN PASS — the receipt that killed traced hit
 * shadows in the resolve (§14 item 0d receipt 1: register pressure collapses
 * the WHOLE kernel's occupancy, 66 ms at any hit count) is precisely why the
 * shadow cones are affordable here: 16 k texels in a dedicated kernel whose
 * register budget nothing else pays for.
 *
 * Amortization is the caller's job (GISystem round-robins ONE probe per due
 * frame); the kernel itself always captures the single probe the uniforms
 * point at, so re-aiming it is three uniform writes, never a rebuild.
 *
 * `__giProbeShadows = false` drops the emitter/sun cones from the capture
 * (unshadowed direct at hits — the A/B arm and the compile-cost escape hatch).
 */
export function createReflectionProbeCapture({
  scratch, history, bvhScene, gatherAt, emitter, lightSlots, env, normalOffset, intensity, cap = 6,
  uniforms, staticOcclude = null, dynOcclude = null, shadowReach = null,
}) {
  const { centerU, maxDistU, rowU, jitterU, alphaU } = uniforms;
  const capU = uniform(cap);
  const shadows = globalThis.__giProbeShadows !== false;
  const historyNode = history ? texture(history) : null;

  const compute = Fn(() => {
    const i = instanceIndex.toVar();
    const coord = ivec2(i.mod(uint(REFL_PROBE_TILE)).toInt(), i.div(uint(REFL_PROBE_TILE)).toInt());
    // JITTERED octahedral decode + EMA over rounds (2026-08-21, "still
    // shitty": a FLAT mirror magnifies per-texel shading variance — cone
    // shadow estimates, single gather samples, hit/miss alternation at
    // skylight rims — into a screen-wide stipple). Each capture round
    // offsets every ray sub-texel (a CPU-fed R2 point via `jitterU`) and
    // blends into the previous round through `alphaU` — supersampling paid
    // across the rounds the probe was already re-capturing anyway. The
    // decode is octahedralDirection's fold verbatim with the jitter
    // replacing its fixed +0.5 texel centre.
    const fx = float(coord.x).add(jitterU.x).div(REFL_PROBE_TILE).mul(2).sub(1).toVar();
    const fy = float(coord.y).add(jitterU.y).div(REFL_PROBE_TILE).mul(2).sub(1).toVar();
    const nz = float(1).sub(fx.abs()).sub(fy.abs()).toVar();
    const fold = nz.negate().max(0).toVar();
    const sxs = step(0, fx).mul(2).sub(1);
    const sys = step(0, fy).mul(2).sub(1);
    const dir = vec3(fx.sub(sxs.mul(fold)), fy.sub(sys.mul(fold)), nz).normalize().toVar();
    const origin = vec3(centerU).toVar();
    const out = vec3(0).toVar();
    // DEPTH-IN-ALPHA (§15 U4a, 2026-08-22): the trace already knows how far
    // the surface it shaded is — store hit distance in the texel's alpha so
    // the sampler can reproject by what the probe actually SAW instead of by
    // the authored box (box projection relocates interior partitions onto
    // box faces — the user's "phantom wall"). Miss stays 0 = "no depth", the
    // sampler falls back to pure box projection there (env texels).
    const tOut = float(0).toVar();
    const hit = bvhScene.firstHit(origin, dir, float(maxDistU));
    If(hit.t.greaterThanEqual(0), () => {
      tOut.assign(hit.t.max(1e-3));
      const hitP = origin.add(dir.mul(hit.t)).toVar();
      // The hit's face normal, flipped toward the incoming ray — same
      // convention (and same reason) as the resolve's bvhShade branch: a
      // back-facing gather samples the field on the far side of the wall.
      const nRaw = vec3(hit.normal).normalize().toVar();
      const nFace = select(nRaw.dot(dir).lessThan(0), nRaw, nRaw.negate()).toVar();
      const shadePoint = hitP.add(nFace.mul(normalOffset)).toVar();
      const E = (gatherAt ? vec3(gatherAt(shadePoint, nFace).irradiance) : vec3(0)).toVar();
      if (emitter) {
        // §16 R3a — THE RECORD MARCH, NOT THE CONE (2026-08-24; the atlas
        // twin of createGiBvhHitShade's 08-22 fix). This used to force
        // `recordShadowTrace: null`, so the cone's threshold admissions over
        // the voxel-quantized distance field etched the black-cross lattice
        // INTO THE ATLAS — where the jitter+EMA rounds only blur it into the
        // permanent mottle every probe lookup then reflects. Same diet as
        // the hit shade (24× luma admission, 4 m march cap); this kernel is
        // 65k threads amortized one probe per 4+ frames, so the march prices
        // a capture round, not a frame. It IS the boot's slowest single
        // compile — `__giProbeRecordShadows = false` returns to the cone for
        // the compile-size A/B.
        const hitParams = shadows && emitter.shadowTraceFn
          ? {
              ...emitter,
              recordShadowTrace: globalThis.__giProbeRecordShadows === false
                ? null
                : (emitter.recordShadowTrace ?? null),
              traceCutoffScale: 24,
              // ⚠ §18.15: THIS WAS LEFT AT 4 WHEN ITS TWIN WENT TO 16. Both
              // this file's header and createGiBvhHitShade's state that the
              // formula is identical on purpose, "one formula, two consumers"
              // — and §18.14 raised the hit shade's march cap to 16 m without
              // this one, so a captured probe and a traced reflection of the
              // same surface disagreed about which occluders exist. Reads the
              // same hatch as the hit shade for the same reason.
              // ▶ DEBT, carried from §18.14: still a constant in METRES. It
              // wants to be a fraction of the GI volume extent, which GISystem
              // knows and neither kernel does.
              maxTraceDistance: Number.isFinite(Number(globalThis.__giHitEmitterMarchCap))
                ? Number(globalThis.__giHitEmitterMarchCap)
                : 16,
            }
          : { ...emitter, shadowSample: () => float(1) };
        E.addAssign(emitterDirectAt(hitParams, hitP, nFace, shadePoint, { rolled: globalThis.__giRolledDirect !== false }).irradiance);
      }
      if (lightSlots?.length) {
        // §18.16 — EXACT BVH VISIBILITY, the atlas twin of the hit shade's
        // own move (see createGiBvhHitShade's banner). The cone this replaces
        // is the same voxel-lattice etcher R3a already removed from the
        // EMITTER arm three units ago; leaving it on the sun arm baked the
        // black crosses into the atlas, where the jitter+EMA rounds only blur
        // them into permanent mottle that every probe lookup then reflects.
        // The 6 m cap goes with it: a BVH ray costs traversal depth, not
        // distance, so `shadowReach` (the medium's diagonal, as a node) is
        // affordable where a 6 m march cap never was.
        const bvhLightShadows = staticOcclude && globalThis.__giHitBvhShadows !== false;
        const sunReach = float(shadowReach ?? 64).toVar();
        const lightShadowFn = shadows && bvhLightShadows
          ? (dirTo, isDir, pointDist) => {
              const tMin = float(1e-3);
              const near = pointDist.sub(float(normalOffset).mul(2)).max(tMin.mul(2)).toVar();
              const maxT = mix(near, sunReach, isDir).toVar();
              const st = staticOcclude(shadePoint, dirTo, tMin, maxT);
              const vis = float(1).toVar();
              if (st) vis.assign(select(st.x.greaterThanEqual(0), float(0), float(1)));
              if (dynOcclude) {
                const dh = dynOcclude(shadePoint, dirTo, tMin, maxT, hitP);
                if (dh) vis.mulAssign(float(dh).clamp(0, 1).oneMinus());
              }
              return vis;
            }
          : shadows && emitter?.shadowTraceFn
            ? (dirTo, isDir, pointDist, cosH) => {
                const capT = float(6);
                const maxT = mix(pointDist.sub(0.3), capT, isDir).min(capT).max(0).toVar();
                return emitter.shadowTraceFn(shadePoint, dirTo, maxT, float(32), cosH, vec3(0), float(0), null);
              }
            : null;
        // ONE-SIDED, for the same reason and by the same rule as
        // createGiBvhHitShade (§18.10): `nFace` is a face-forwarded HIT normal,
        // not a field cell. Keeping the two in step is deliberate — this file's
        // header and the hit shade's both state that the formula is identical
        // on purpose, "one formula, two consumers", and a cosine convention
        // that differed between them would put a probe capture and a traced
        // reflection of the SAME surface at different brightnesses.
        E.addAssign(analyticDirectAt(lightSlots, hitP, nFace, lightShadowFn, true, { rolled: globalThis.__giRolledDirect !== false }));
      }
      out.assign(vec3(hit.albedo).mul(E).mul(1 / Math.PI).mul(intensity));
      // The glossy chain's hue-preserving luminance cap, same default: a hot
      // bin or a near-emitter hit must not become a white blob every material
      // in the box then reflects.
      const lum = out.x.mul(0.2126).add(out.y.mul(0.7152)).add(out.z.mul(0.0722)).toVar();
      out.mulAssign(float(capU).div(lum.max(capU)));
    }).Else(() => {
      // Traced miss — the ray PROVED the environment is visible here, the
      // same claim giLight's env-on-miss term keys on, sampled through the
      // same persistent bundle (placeholder texture + intensity 0 when no
      // environment is set, so this is inert exactly when that term is).
      if (env) {
        const cr = cos(env.rotY).toVar();
        const sr = sin(env.rotY).toVar();
        const rd = vec3(
          dir.x.mul(cr).add(dir.z.mul(sr)),
          dir.y,
          dir.z.mul(cr).sub(dir.x.mul(sr)),
        ).toVar();
        // `.level(0)` is REQUIRED, not style: this is a compute kernel, and
        // implicit-derivative sampling is illegal there (same rule the BVH
        // atlas lookup in bvhScene.js follows).
        out.assign(vec3(env.node.sample(equirectUV(rd)).level(0).xyz).mul(env.intensity).mul(intensity));
      }
    });
    // EMA against the probe's own history row (read here, WRITTEN by the
    // blur pass after this one — split across the two dispatches because a
    // WGSL storage texture can't be read and stored in one pass). alphaU is
    // 1 on a dirty/first capture (history is the old world — replace it)
    // and the accumulation rate otherwise.
    if (historyNode) {
      const prev = historyNode.load(ivec2(coord.x, coord.y.add(int(rowU).mul(REFL_PROBE_TILE))));
      out.assign(mix(vec3(prev.xyz), out, float(alphaU).clamp(0, 1)));
      // Depth rides the same EMA — the geometry is static, so this only
      // smooths the sub-texel jitter at silhouettes; a hit/miss rim texel
      // averages toward a small t, which step(0.05, t) in the sampler still
      // reads as valid depth on the hit side.
      tOut.assign(mix(prev.w, tOut, float(alphaU).clamp(0, 1)));
    }
    textureStore(scratch, coord, vec4(out, tOut));
  })().compute(REFL_PROBE_TILE * REFL_PROBE_TILE);

  return { compute, cap: capU };
}

/**
 * SCRATCH → ATLAS: copies the captured tile into the probe's level-0 slot and
 * cone-blurs it into the roughness levels, all in one dispatch.
 *
 * A separate pass (and a separate SOURCE texture) because WGSL storage
 * textures are write-only — the capture cannot both write level 0 and read it
 * back for the blur. The scratch is one TILE² texture reused by every probe;
 * the row uniform aims the writes.
 *
 * The blur is a fixed golden-spiral cone of taps in DIRECTION space (build a
 * tangent basis, tilt by up to the level's cone half-angle, re-encode through
 * octahedralUV) — direction-space taps keep the kernel honest across the oct
 * map's fold, where a texel-space kernel would blur across the seam into a
 * direction 90° away.
 */
export function createReflectionProbeBlur({ scratch, atlas, history = null, uniforms }) {
  const { rowU } = uniforms;
  const scratchNode = texture(scratch);
  // 32 at TILE 256: the level-1 cone disc spans ~29 texels of the source —
  // fewer taps than this and the gaussian starts to shimmer between texels.
  const TAPS = 32;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  const compute = Fn(() => {
    const i = instanceIndex.toVar();
    const x = i.mod(uint(REFL_PROBE_TILE)).toInt().toVar();
    const y = i.div(uint(REFL_PROBE_TILE)).toInt().toVar();
    const rowBase = rowU.mul(REFL_PROBE_TILE).toVar();
    // `src` carries hit distance in alpha (capture pass) — the verbatim copy
    // is what puts depth in the atlas' level-0 tile, where the sampler's
    // parallax reprojection reads it. Blur levels below write alpha 1; depth
    // is only ever read from level 0.
    const src = scratchNode.load(ivec2(x, y)).toVar();
    textureStore(atlas, ivec2(x, y.add(rowBase)), src);
    // The EMA history commit — the scratch already holds the blended
    // result (capture pass), this makes it next round's `prev`.
    if (history) textureStore(history, ivec2(x, y.add(rowBase)), src);
    const dir = vec3(octahedralDirection(float(i), REFL_PROBE_TILE)).toVar();
    // Tangent basis — pick the up-vector the direction is least aligned with.
    const up = select(dir.y.abs().lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0)).toVar();
    const T = dir.cross(up).normalize().toVar();
    const B = dir.cross(T).toVar();
    for (let level = 1; level < REFL_PROBE_LEVELS; level++) {
      if (level === REFL_PROBE_LEVELS - 1) {
        // THE IRRADIANCE TILE (2026-08-22) — a full cosine-hemisphere
        // convolution, NOT a cone: the disc-tilt kernel below degenerates as
        // the cone approaches 90° (tan → ∞), and irradiance needs the whole
        // hemisphere anyway. Cosine-WEIGHTED golden-spiral directions around
        // `dir` (r = √u, z = √(1−u)) make every tap weight 1 — the cosine
        // is in the distribution — so the tile stores mean(L) = E(dir)/π.
        // giLight's nested-render fallback samples this along N and ×π.
        const COS_TAPS = 64;
        const sum = vec3(0).toVar();
        for (let k = 0; k < COS_TAPS; k++) {
          const u1 = (k + 0.5) / COS_TAPS;
          const r = Math.sqrt(u1);
          const z = Math.sqrt(1 - u1);
          const a = k * GOLDEN;
          const tapDir = T.mul(Math.cos(a) * r).add(B.mul(Math.sin(a) * r)).add(dir.mul(z)).normalize();
          const uvT = octahedralUV(tapDir, REFL_PROBE_TILE);
          const tap = scratchNode.load(ivec2(
            uvT.u.floor().toInt().clamp(0, REFL_PROBE_TILE - 1),
            uvT.v.floor().toInt().clamp(0, REFL_PROBE_TILE - 1),
          ));
          sum.addAssign(vec3(tap.xyz));
        }
        textureStore(
          atlas,
          ivec2(x.add(level * REFL_PROBE_TILE), y.add(rowBase)),
          vec4(sum.div(COS_TAPS), 1),
        );
        continue;
      }
      const tanCone = Math.tan(REFL_PROBE_LEVEL_CONES[level]);
      const sum = vec3(0).toVar();
      let wsum = 0;
      for (let k = 0; k < TAPS; k++) {
        // Golden-spiral disc: radius √(k/N), angle k·golden — even coverage,
        // no ring artifacts, and the JS-constant offsets fold into the WGSL.
        const r = Math.sqrt((k + 0.5) / TAPS) * tanCone;
        const a = k * GOLDEN;
        const ox = Math.cos(a) * r;
        const oy = Math.sin(a) * r;
        // Gaussian-ish falloff over the disc keeps the lobe peaked like a
        // GGX lobe rather than a flat cone.
        const w = Math.exp(-2 * (r / Math.max(tanCone, 1e-4)) * (r / Math.max(tanCone, 1e-4)));
        const tapDir = dir.add(T.mul(ox)).add(B.mul(oy)).normalize();
        const uvT = octahedralUV(tapDir, REFL_PROBE_TILE);
        const tap = scratchNode.load(ivec2(
          uvT.u.floor().toInt().clamp(0, REFL_PROBE_TILE - 1),
          uvT.v.floor().toInt().clamp(0, REFL_PROBE_TILE - 1),
        ));
        sum.addAssign(vec3(tap.xyz).mul(w));
        wsum += w;
      }
      textureStore(
        atlas,
        ivec2(x.add(level * REFL_PROBE_TILE), y.add(rowBase)),
        vec4(sum.div(wsum), 1),
      );
    }
  })().compute(REFL_PROBE_TILE * REFL_PROBE_TILE);

  return { compute };
}

/** The one TILE² scratch the capture writes and the blur reads. */
export function createReflectionProbeScratch() {
  const t = new THREE.StorageTexture(REFL_PROBE_TILE, REFL_PROBE_TILE);
  t.type = THREE.HalfFloatType;
  t.name = "giReflProbeScratch";
  return t;
}

/**
 * Level-0 EMA history, one row per probe slot (the jitter/EMA loop's `prev`).
 * Its own texture rather than the atlas' level-0 column because the capture
 * READS it while the atlas is a store-only target elsewhere in the chain.
 */
export function createReflectionProbeHistory() {
  const t = new THREE.StorageTexture(REFL_PROBE_TILE, REFL_PROBE_TILE * MAX_REFLECTION_PROBES);
  t.type = THREE.HalfFloatType;
  t.name = "giReflProbeHistory";
  return t;
}

/** Capture-aim uniforms — a handful of writes re-aim both kernels at another probe. */
export function createReflectionProbeUniforms() {
  return {
    centerU: uniform(new THREE.Vector3()),
    maxDistU: uniform(24),
    rowU: uniform(0, "int"),
    // Sub-texel ray offset for this capture round (a CPU-fed R2 point).
    jitterU: uniform(new THREE.Vector2(0.5, 0.5)),
    // EMA rate: 1 = replace (dirty/first round), else the accumulation rate.
    alphaU: uniform(1),
  };
}

export { MAX_REFLECTION_PROBES, REFL_PROBE_TILE };
