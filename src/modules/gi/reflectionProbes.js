import * as THREE from "three/webgpu";
import { Loop, float, mix, smoothstep, step, uint, uniform, uniformArray, vec2, vec3, vec4 } from "three/tsl";
import { octahedralUV } from "./srcOctahedral.js";

/**
 * BOX-PROJECTED REFLECTION PROBES (plan §14 unit R-B, 2026-08-21).
 *
 * The cheap, good, WORLD-space answer to "reflections that show lit surfaces
 * without SSR's only-what-is-on-screen blindness and without ultra's per-pixel
 * BVH cost": small octahedral radiance maps captured in-world at authored
 * points, parallax-corrected against an authored box, sampled in-material for
 * the price of two texture fetches.
 *
 * ── WHY OCTAHEDRAL TILES IN ONE 2D ATLAS, NOT CUBEMAPS ─────────────────────
 * The capture is a TRACE (reflectionProbeCapture.js), not a rasterized
 * CubeCamera render — the deferred GI terms are screen-keyed textures, so a
 * cube render would sample garbage GI, and the capture would inherit every
 * nested-render hazard renderGiGBuffer documents. A trace can write ANY
 * parameterization, so it writes the one this module already round-trips
 * texel-exactly (srcOctahedral's encode/decode pair, arbitrated by
 * run-gi-gather-invariance-test) into a single 2D atlas: one texture binding
 * in materials no matter how many probes, no cube-array support questions,
 * and per-probe rows keep every capture a contiguous region.
 *
 * ── ATLAS LAYOUT ───────────────────────────────────────────────────────────
 * Rows: one per probe slot (MAX_REFLECTION_PROBES). Columns: REFL_PROBE_LEVELS
 * roughness levels, each a REFL_PROBE_TILE² octahedral tile — level 0 sharp,
 * levels 1..N progressively cone-blurred by the capture's blur pass. Materials
 * pick a fractional level from their roughness (same smoothstep ladder the
 * cascade sharp/soft/rough mix uses) and lerp two tiles.
 */
export const MAX_REFLECTION_PROBES = 8;
// 256, NOT 128 (2026-08-21, "on high it reflects just some random mess"):
// a large FLAT mirror magnifies a small angular window of the octahedral
// tile across the whole surface — at 128² (~2°/texel) that reads as soft
// blurry blocks; 256² halves the texel angle and the capture is still only
// 65k rays, amortized one probe per 16 frames. Flat mirrors remain probes'
// structural worst case at ANY resolution (a sphere compresses the room, a
// plane blows texels up) — an authored flat mirror wants the
// PlanarReflectionComponent (exact, one scene render) or ultra's exact BVH;
// probes are the glossy/curved/every-tier answer.
export const REFL_PROBE_TILE = 256;
export const REFL_PROBE_LEVELS = 4;

/**
 * Blur cone half-angles (radians) per level, shared by the capture's blur
 * pass and — through the roughness→level ladder below — the material mix.
 * Level 0 is the raw trace (no cone).
 *
 * The LAST level is not a cone at all: the blur pass special-cases it as a
 * full COSINE-HEMISPHERE convolution — the tile stores E(dir)/π, so π × a
 * sample along the surface normal is the probe's irradiance estimate. Added
 * 2026-08-22 ("incorrect reflections in the perfect mirror"): the nested-
 * render irradiance fallback used the widest CONE level as if it were
 * irradiance, and a 26° cone along N misses the bright sunlit floor and
 * returns whatever saturated wall hue sits opposite the surface — the
 * mirrored room rendered as swirly green walls over a red-brown floor.
 * It also serves roughness→1 materials, whose GGX lobe is far wider than
 * 26°.
 */
export const REFL_PROBE_LEVEL_CONES = [0, 0.18, 0.45, Math.PI / 2];

export function createReflectionProbeAtlas() {
  const t = new THREE.StorageTexture(
    REFL_PROBE_TILE * REFL_PROBE_LEVELS,
    REFL_PROBE_TILE * MAX_REFLECTION_PROBES,
  );
  t.type = THREE.HalfFloatType;
  t.name = "giReflProbes";
  return t;
}

/**
 * The per-slot data materials read — ONE uniform array per field, plus the
 * live slot count, so the sampler below is a LOOP and not eight unrolled
 * copies of itself.
 *
 * ⭐⭐ WHY (2026-09-02, the material wave): with the slots as sixteen scalar
 * `uniform(Vector4)` nodes the sampler was unrolled once per slot, and every
 * mirror-capable material fragment carried EIGHT copies of the box
 * projection + two depth-parallax refinements + two atlas fetches — measured
 * on the user's Level with the WGSL dumped from three's program cache:
 * **327 kB with probes, 75 kB with `__giReflectionProbes = false`** (the
 * exact-blend prefilter, the other suspect, was 7 kB). That 250 kB was the
 * whole of the 13–39 s material wave, the ~100 ms TSL build of every
 * material first seen on a camera turn, and the driver cache's miss rate.
 * A uniform ARRAY is the same bytes to the GPU; the difference is that
 * `element(i)` inside a `Loop` generates one body. Writers use `at(i)` and
 * call `syncCount()` after a change; nothing about a probe short of its
 * existence is a rebuild, exactly as before.
 *
 *   posFeather[i] = (center.xyz, feather metres)
 *   halfActive[i] = (half-extents.xyz, active 0/1)
 *   count         = one past the highest ACTIVE slot (the loop bound)
 */
export function createReflectionProbeSlots() {
  const posFeather = uniformArray(
    Array.from({ length: MAX_REFLECTION_PROBES }, () => new THREE.Vector4(0, 0, 0, 0.5)),
    "vec4",
  );
  const halfActive = uniformArray(
    Array.from({ length: MAX_REFLECTION_PROBES }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4",
  );
  const count = uniform(0, "uint");
  return {
    posFeather,
    halfActive,
    count,
    /** The two Vector4s of slot `i` — write them in place. */
    at(i) {
      return { posFeather: posFeather.array[i], halfActive: halfActive.array[i] };
    },
    /** Re-derive the loop bound from the active flags. Call after any write. */
    syncCount() {
      let n = 0;
      for (let i = 0; i < MAX_REFLECTION_PROBES; i++) if (halfActive.array[i].w > 0) n = i + 1;
      count.value = n;
      return n;
    },
    /** Deactivate every slot (the reflections-off path). */
    clear() {
      for (let i = 0; i < MAX_REFLECTION_PROBES; i++) halfActive.array[i].w = 0;
      count.value = 0;
    },
  };
}

/**
 * Sample the probe set at world point P along reflection dir R.
 *
 * `bundle` = { node, slots } — the atlas texture node plus the slot table
 * from `createReflectionProbeSlots`.
 * Returns { rgb, weight }: the radiance (pre-multiplied by GI intensity at
 * capture time, matching reflectedOut/bvhOut's convention) and the feathered
 * coverage in [0,1] the caller mixes by.
 *
 * BOX PROJECTION (BPCEM): the naive lookup direction R is correct only at the
 * capture point; everywhere else a flat wall would smear. Intersect (P, R)
 * with the probe's box, then look up the direction from the CAPTURE POINT to
 * that intersection — walls land where they are. Nearly exact when the box
 * matches the room, which in this engine's level-design blockouts it does.
 *
 * Overlapping probes cross-fade by feathered containment; the weight sum also
 * hands the caller a smooth 0 at the boxes' edges, so probe reflections fade
 * into the glossy-field term instead of cutting.
 *
 * ONE LOOP BODY (see createReflectionProbeSlots): the slot count is a uniform
 * bound, so an inactive slot costs nothing and a scene with one probe pays
 * one iteration. Inside the body the discipline is the old one — pure
 * dataflow, no gated sample (the 2026-08-01 codegen trap): a non-containing
 * slot contributes through weight 0, and every fetch is `.level(0)`
 * (textureSampleLevel, legal in any control flow).
 */
export function sampleReflectionProbes(bundle, P, R, roughness) {
  const atlasW = REFL_PROBE_TILE * REFL_PROBE_LEVELS;
  const atlasH = REFL_PROBE_TILE * MAX_REFLECTION_PROBES;
  const slots = bundle.slots;
  const sum = vec3(0).toVar();
  const wsum = float(0).toVar();
  // Fractional blur level from the roughness the BSDF shades with — the same
  // ladder shape as the cascade sharp/soft/rough mix, anchored to the blur
  // cones the capture actually baked.
  const levelF = smoothstep(0.05, 0.25, roughness)
    .add(smoothstep(0.25, 0.55, roughness))
    .add(smoothstep(0.55, 0.9, roughness))
    .clamp(0, REFL_PROBE_LEVELS - 1)
    .toVar();
  const l0 = levelF.floor().min(REFL_PROBE_LEVELS - 2).toVar();
  const lt = levelF.sub(l0).clamp(0, 1).toVar();
  // Ray/box exit sign along R — slot-independent, hoisted. step-derived
  // (±1, never 0 — `sign(0)` would zero the divisor).
  const sgn = vec3(
    step(0, R.x).mul(2).sub(1),
    step(0, R.y).mul(2).sub(1),
    step(0, R.z).mul(2).sub(1),
  ).toVar();
  const rSafe = sgn.mul(vec3(R).abs().max(1e-5)).toVar();
  const enable = globalThis.__giProbeDepthParallax !== false ? 1 : 0;
  const Pv = vec3(P).toVar();
  const Rv = vec3(R).toVar();
  Loop({ start: uint(0), end: uint(slots.count), type: "uint", condition: "<" }, ({ i }) => {
    const pf = vec4(slots.posFeather.element(i)).toVar();
    const ha = vec4(slots.halfActive.element(i)).toVar();
    const center = pf.xyz.toVar();
    const half = ha.xyz.toVar();
    const local = Pv.sub(center).toVar();
    // Feathered containment: distance to the nearest face, in metres, ramped
    // over the feather. Negative outside → clamp 0.
    const inset = half.sub(local.abs());
    const w = inset.x.min(inset.y).min(inset.z)
      .div(pf.w.max(1e-3)).clamp(0, 1)
      .mul(ha.w).toVar();
    // A degenerate axis falls out of the min() via a huge t rather than
    // dividing by zero.
    const tExit = half.mul(sgn).sub(local).div(rSafe);
    const tHit = tExit.x.min(tExit.y).min(tExit.z).max(1e-3);
    // Direction from the capture point (the box centre) to the box hit —
    // the parallax correction itself. Division-guarded normalize: on an
    // inactive slot this vector is arbitrary, and a NaN here would poison
    // the sum THROUGH the zero weight (0 × NaN = NaN).
    const dv = local.add(Rv.mul(tHit));
    const dirP = dv.div(dv.length().max(1e-5)).toVar();
    const rowBase = float(i).mul(REFL_PROBE_TILE).toVar();
    // DEPTH-AWARE PARALLAX (§15 U4a, 2026-08-22). Box projection is exact
    // only for geometry ON the box faces — an interior partition captured by
    // a room-spanning probe gets relocated onto a box face and shows up as a
    // wall that does not exist (the user's "phantom wall"), and a probe box
    // that mismatches the room shears every reflection. The capture is a
    // trace, so the level-0 tile's ALPHA carries the distance the probe
    // actually saw along each direction: use the box-projected direction as
    // the initial guess, read the stored depth there, land the world point
    // W0 the probe saw, project it onto the receiver's reflection ray for a
    // travel estimate s, and re-aim the lookup at the ray point P + R·s.
    // Miss texels store depth 0 → step() keeps pure box projection (env).
    const refine = (dirIn) => {
      const uvI = octahedralUV(dirIn, REFL_PROBE_TILE);
      const uvDi = vec2(
        uvI.u.clamp(0.5, REFL_PROBE_TILE - 0.5).div(atlasW),
        uvI.v.clamp(0.5, REFL_PROBE_TILE - 0.5).add(rowBase).div(atlasH),
      );
      const tI = float(bundle.node.sample(uvDi).level(0).w);
      const ok = step(0.05, tI).mul(enable);
      const Wi = center.add(dirIn.mul(tI));
      const si = vec3(Wi).sub(Pv).dot(Rv).max(0.05);
      const dci = Pv.add(Rv.mul(si)).sub(center);
      const dirCi = dci.div(dci.length().max(1e-5));
      const mixed = mix(dirIn, dirCi, ok);
      return mixed.div(mixed.length().max(1e-5)).toVar();
    };
    // TWO iterations: the first jumps from the box guess to the depth
    // field's neighbourhood, the second converges within it (measured on the
    // offset-probe gate arm: one iteration recovered ~60% of the
    // displacement-lost hue anchoring, the box-only control collapsed to the
    // field baseline). Cost: two extra level-0 fetches per slot.
    const dirF = refine(refine(dirP));
    const uvT = octahedralUV(dirF, REFL_PROBE_TILE);
    // Half-texel inset keeps the bilinear tap inside this tile — the atlas
    // packs levels side by side and probes row by row, and a tap that
    // crosses a seam blends another probe's world in.
    const u = uvT.u.clamp(0.5, REFL_PROBE_TILE - 0.5).toVar();
    const v = uvT.v.clamp(0.5, REFL_PROBE_TILE - 0.5).add(rowBase).div(atlasH).toVar();
    const uvA = vec2(u.add(l0.mul(REFL_PROBE_TILE)).div(atlasW), v);
    const uvB = vec2(u.add(l0.add(1).mul(REFL_PROBE_TILE)).div(atlasW), v);
    // `.level(0)` — textureSampleLevel: legal in any control flow, and the
    // atlas has no mips anyway (roughness blur is the LEVELS axis).
    const sA = vec3(bundle.node.sample(uvA).level(0));
    const sB = vec3(bundle.node.sample(uvB).level(0));
    sum.addAssign(mix(sA, sB, lt).mul(w));
    wsum.addAssign(w);
  });
  return {
    rgb: sum.div(wsum.max(1e-4)),
    weight: wsum.clamp(0, 1),
  };
}
