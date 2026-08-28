// §19 STAGE 5.3d — THE ADMITTED EMITTER'S DIRECT TERM, ANALYTIC AND FILTERED
//
// ⭐⭐⭐ THE ONE-SENTENCE VERSION: a seated lamp's FIRST bounce is computed the
// way the old path computed it and the way the offline reference computes it —
// an analytic solid angle times a SHADOW that is TRACED ONCE PER PIXEL AND THEN
// FILTERED — and the cascades carry only what a lamp bounces OFF something.
//
// ══ WHY THE OLD PATH LOOKED RIGHT, WHICH IS THE WHOLE OF THIS FILE ══════════
//
// §19 5.3 measured the pixel-analytic seat and shipped it OFF: gain 0.365, and
// the per-surface blotch σ went 45 → 95 %. The commit's own diagnosis was
// correct and incomplete — "a binary shadow ray against a voxelized lamp is a
// HARD ALIASED EDGE with no interpolation behind it. `emitterDirectPass` gets
// away with the same expression because it runs at a PROBE and the pixel reads
// eight of them". Both shipped paths interpolate. Neither of them traces one
// binary ray per pixel and shows it to the user.
//
// But the ENGINE path never interpolated either. `createGiEmitterShadowPass` in
// `giScreen.js` traces per pixel exactly like this — and then hands the result
// to `createGiLightShadowFilterPass` and two wide passes before anything
// samples it (`GISystem`: raw → filter → MID → wide₁ → WIDE → wide₂ →
// `emitterShadow`, and materials sample only the last one). The interpolation
// that made the old picture smooth is a CROSS-BILATERAL FILTER, not a probe
// lattice, and 5.3's arm was that chain with its filter cut off.
//
// ⚠ AND THE OLD CHAIN CANNOT SIMPLY BE RE-ENABLED. It is `inputs.emitter &&
// !GI2_PATH` in `GISystem` for two hard reasons, both still true: its marcher
// needs a DISTANCE ORACLE (`inputs.emitter.shadowTraceFn`), which GI2 does not
// have and does not want, and the full chain measured 10-20 ms — the §18
// mandate's whole frame budget for one term. So this is the same SHAPE on the
// window's own trace: one binary ray, then a separable cross-bilateral, at HALF
// RESOLUTION, in 2 dispatches of 7 taps.
//
// ══ NO DOUBLE COUNT, AND THE ARGUMENT IS THE REFERENCE'S OWN CONVENTION ═════
//
// `scripts/lib/gi2SceneReference.mjs` states it in its header:
//
//     E(p,n) = E_direct(p,n)          ← NEXT-EVENT over the emissive triangles
//            + (π/N) Σ_k Lo(hit_k)    ← cosine bounce, emission REMOVED at
//                                       every hit (NEE owns it)
//
// So the truth this gate scores against splits the lamp EXACTLY the way this
// file does: an analytic shadowed area-light term at the shading point, and a
// bounce integral in which a ray landing on the lamp brings back the lamp's
// ALBEDO bounce and NOT its emission. Matching it is therefore not a choice
// between two defensible conventions — it is the alignment, and the two ways of
// getting it wrong are opposite:
//
//   · KEEP the palette emission AND add this term → the lamp is counted twice
//     (§12.26.7's 2.60×);
//   · DROP both → 5.1/5.2's uniformly-too-dark picture (gain 0.303).
//
// `#gi2SlotEmissive` is the one place the choice is made: a PROMOTED emitter's
// `palEm` is `[0,0,0]`, so a ray that hits the lamp reads `ρ_lamp/π · E` out of
// the face cache and no emission at all. One representation, on the CPU, in the
// table both halves read. The ADMITTED-BUT-UNSEATED tier is untouched and still
// reaches the room geometrically through §19 5.3b's conserved palette emission
// — those lamps have no seat and therefore no analytic term to double.
//
// ══ WHAT THE FILTER IS ALLOWED TO TOUCH ═════════════════════════════════════
//
// The VISIBILITY only, never the irradiance. `Ω·cosθ·L` is an analytic function
// of the shading point that is already smooth; blurring it across a silhouette
// would leak a lamp's light onto a surface that does not face it. The filtered
// quantity is the 0..1 occlusion per slot — four slots, four channels, one
// RGBA16F at half res — and the analytic factor is evaluated per pixel at full
// precision and multiplied afterwards. That is `giLight.emitterDirectAt`'s own
// split (`emitterSlotShadow` is a texture; the solid angle is not), for the same
// reason.
//
// ⚠ AND THE COSINE-BACKFACING TEXEL STORES **1**, NOT 0. A texel whose surface
// cannot see the lamp has no visibility to report; storing 0 would drag a black
// value across the terminator into texels that CAN see it, which is the one
// artefact a bilateral filter cannot repair afterwards. The cosine already
// zeroes those pixels analytically.
import * as THREE from "three/webgpu";
import {
  Fn, If, Return, dot, float, instanceIndex, ivec2, max, mix, sqrt, step, texture, textureStore,
  uint, uniform, vec3, vec4,
} from "three/tsl";
import { emitterShapeGain } from "../emitterShapeGain.js";

/** The four NEE slots are four channels. `MAX_EMITTERS` is 4 and always was. */
const SLOTS = 4;

/**
 * Gaussian-ish 7 taps, σ ≈ 1.5 texels at HALF res ≈ 3 px at full res, applied
 * separably twice (H then V). Wide enough to bury the voxel lamp's aliased
 * silhouette, narrow enough that the plane test still has neighbours to reject.
 */
const TAPS = [-3, -2, -1, 0, 1, 2, 3];
const TAP_W = [0.05, 0.12, 0.20, 0.26, 0.20, 0.12, 0.05];

/**
 * @param {object} o
 * @param {object} o.trace     `createWindowTrace`'s — CALLED, never rebuilt
 * @param {number} o.voxel0    the level-0 cell size (the ray's self-exclusion)
 * @param {Array<object>} o.emitters  GISystem's slot uniforms. Empty or absent →
 *   `null`, and NOT ONE NODE of this is built (the arm every pre-5.3d receipt
 *   was taken on).
 * @param {{position: object, normal: object}} o.gbuffer
 * @param {Node} o.camera  world camera position — the face-forward flip's, the
 *   SAME one `rcSystem.readPixel` and `rcMerge`'s resolve use.
 * @param {number} o.width   full-res gbuffer width (the grid is `ceil(w/2)`,
 *   `gatherProbes`' own rule and `rcMerge`'s)
 * @param {number} o.height
 */
export function createRcEmitterDirect({
  trace, voxel0, emitters, gbuffer, camera, width, height, bvh = null,
}) {
  if (!emitters?.length) return null;
  const { traceWindow } = trace;
  const v0 = voxel0;
  /**
   * §19 5.5b — the exact arm, or `null`. A JS-time constant, not a uniform:
   * the two arms are different KERNELS (one binds two extra storage buffers),
   * so the choice is made where the graph is built and a build that has no BVH
   * emits not one node of the traversal. `gi2System` swaps arms by rebuilding
   * this pass when the worker's BVH lands, which is also why the voxel arm can
   * serve first light with no special case here.
   */
  const BVH = bvh ?? null;
  const slots = emitters.slice(0, SLOTS);
  const halfW = Math.max(1, Math.ceil(width / 2));
  const halfH = Math.max(1, Math.ceil(height / 2));

  /**
   * TWO textures, not three: [F1] reads `visA` and writes `visB`, [F2] reads
   * `visB` and writes `visA`. Nothing is ever sampled and stored inside one
   * kernel — that does not compile (a storage texture bound for sampling is
   * `texture_2d<f32>` and `textureStore` refuses it) and it is also the reason
   * `gi2System` gives AO its own output texture.
   */
  const mk = (name) => {
    const t = new THREE.StorageTexture(halfW, halfH);
    t.name = name;
    t.type = THREE.HalfFloatType;
    t.generateMipmaps = false;
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    return t;
  };
  const visA = mk("rcEmitterVis");
  const visB = mk("rcEmitterVisTmp");

  const posN = texture(gbuffer.position);
  const nrmN = texture(gbuffer.normal);
  const visAN = texture(visA);
  const visBN = texture(visB);
  /**
   * §19 5.3e — THE SHADOW BYPASS, and it is an instrument rather than a knob.
   *
   * `directAt` is a product of two things with very different smoothness: an
   * ANALYTIC `Ω·cosθ·L` that is a rational function of the shading point, and a
   * TRACED 0..1 visibility that is a binary ray against 0.25 m occupancy bits.
   * A blotch measurement on their product cannot say which one carries the
   * structure. At 0 the visibility is replaced by 1 everywhere and what remains
   * is the analytic factor alone, so `σ(E_shipped − E_bypassed)` is exactly the
   * spatial structure the SHADOW contributed — the number the 5.3e attribution
   * turns on. Default 1; the shipped graph gains one `mix` against a uniform.
   */
  const shadowU = uniform(1);
  const widthU = uniform(width, "uint");
  const heightU = uniform(height, "uint");
  const halfWU = uniform(halfW, "uint");
  const halfHU = uniform(halfH, "uint");

  /**
   * The half-res thread's own full-res texel. `rcMerge`'s resolve maps EXACTLY
   * this way (top-left of the 2×2 quad) and so does `gatherProbes`'
   * `makeResolve(half)` — a different centre here would filter a visibility
   * computed on one surface and multiply it into another.
   */
  const fullTexel = (gx, gy) => ivec2(
    gx.mul(uint(2)).min(widthU.sub(uint(1))).toInt(),
    gy.mul(uint(2)).min(heightU.sub(uint(1))).toInt(),
  );

  /**
   * The surface behind a half-res texel, with the CAMERA-FACED normal —
   * `rcSystem.readPixel`'s expression verbatim, because the hemisphere a lamp
   * lights has to be the hemisphere the field was filled over.
   */
  const surfaceAt = (gx, gy) => {
    const t = fullTexel(gx, gy);
    const g = posN.load(t).toVar();
    const nrm = nrmN.load(t).xyz.toVar();
    const len2 = nrm.dot(nrm).toVar();
    const Nn = nrm.div(sqrt(max(len2, float(1e-12)))).toVar();
    const facing = step(0, Nn.dot(vec3(camera).sub(g.xyz))).mul(2).sub(1).toVar();
    return {
      P: g.xyz,
      valid: g.w.greaterThan(0.5).and(len2.greaterThan(0.25)),
      N: Nn.mul(facing).toVar(),
    };
  };
  /** vec4 component by JS index — no dynamic indexing, four names. */
  const comp = (v, k) => [v.x, v.y, v.z, v.w][k];

  // ── [S] THE RAW VISIBILITY, ONE BINARY WINDOW RAY PER SLOT PER TEXEL ──────
  const rawPass = Fn(() => {
    const i = instanceIndex.toVar();
    const gx = i.mod(halfWU).toVar();
    const gy = i.div(halfWU).toVar();
    If(gy.greaterThanEqual(halfHU), () => { Return(); });
    const s = surfaceAt(gx, gy);
    const v = [float(1).toVar(), float(1).toVar(), float(1).toVar(), float(1).toVar()];
    If(s.valid, () => {
      const P = vec3(s.P).toVar();
      const Nf = vec3(s.N).toVar();
      for (let k = 0; k < slots.length; k++) {
        const slot = slots[k];
        const centre = vec3(slot.center).toVar();
        const reff = float(slot.reff).max(1e-3).toVar();
        const rgb = vec3(slot.color).toVar();
        const active = float(slot.radius).greaterThan(1e-5)
          .and(rgb.x.add(rgb.y).add(rgb.z).greaterThan(1e-6));
        If(active, () => {
          const wv = centre.sub(P).toVar();
          const d = sqrt(dot(wv, wv).max(1e-4)).toVar();
          const wd = wv.div(d).toVar();
          // ⚠ THE COSINE GATE STORES 1, NOT 0 — see the header. A backfacing
          // texel has no visibility to report and its analytic factor is
          // already zero; a stored 0 would bleed across the terminator.
          If(dot(Nf, wd).greaterThan(1e-3), () => {
            // ⭐⭐⭐ THE RAY STOPS SHORT OF THE LAMP'S OWN BODY — AND THE
            // CLEARANCE IS `radius`, THE BOUNDING SPHERE, NOT `reff`.
            //
            // `reff` is the MEAN-PROJECTED-AREA radius (Cauchy's S/4; see
            // `emitterShapes.shapeMeanProjRadius`) and for a SPHERE the two are
            // the same number, which is why every path in the repository has
            // spelled this `reff` and nothing ever showed it. The user's
            // Cornell lamp is a CUBE: S = 4.47 m² gives `reff` 0.60 while the
            // body reaches 0.74 m to its corners, so a ray stopped at
            // `d − 0.60 − v0/2` ENDS INSIDE THE LAMP'S OWN VOXELS on every
            // diagonal approach, is occluded by the very light it is sampling,
            // and writes BLACK. That is a shadow term that is half-dark and
            // blotchy in exactly the direction-dependent pattern measured
            // (5.3d arm 1: gain 0.49, blotch σ 40-85 %) — the same failure the
            // panel block in `gatherProbes` spends a page on, arriving through
            // the seat instead of through the panel.
            //
            // `radius` is documented AS the self-exclusion quantity where the
            // slots are filled (`GISystem`: "radius stays the bounding sphere —
            // trace self-exclusion and the active gate"). `max` with `reff`
            // makes it a provable no-op for every spherical fit, where the two
            // are equal by construction.
            //
            // §19 5.5b — AND THE VOXEL SLACK IS GONE ON THE EXACT ARM. The
            // extra `v0/2` above is the WINDOW ray's cost of living: its
            // occupancy bits are DILATED, so a ray must stop half a cell short
            // of the lamp shell or the lamp's own bits shadow it. Exact
            // triangles have no dilation, so the exact arm stops at the
            // bounding sphere and nothing else, and a receiver pressed against
            // the lamp keeps its contact shadow instead of losing the last
            // 12.5 cm of it.
            const clear = float(slot.radius).max(reff).toVar();
            // The voxel arm's reach and the exact arm's are DIFFERENT NUMBERS,
            // so both are computed and the branch picks one. Cheap: two
            // subtractions, no trace.
            const reachVox = d.sub(clear).sub(float(v0 * 0.5)).max(v0 * 0.5).toVar();
            const reachBvh = d.sub(clear).max(1e-3).toVar();
            // ⭐⭐⭐ THE ONE LINE STAGE 5.5b EXISTS FOR. `traceWindow` asks the
            // voxels whether anything is between here and the lamp; `anyHitFrom`
            // asks the TRIANGLES. The difference only shows on a ray that starts
            // ON geometry — which is every ray in this pass — and it is the
            // difference between a lamp-mesh face that is lit and one that is
            // black. See `window/shadowBvh.js`.
            const h = float(0).toVar();
            if (BVH) {
              // ⭐⭐ A RUNTIME BRANCH ON A UNIFORM, NOT A JS-TIME CHOICE — and
              // that is what makes 5.5b free of a mid-session rebuild. Both
              // arms are compiled into ONE kernel; `readyU` is uniform across
              // every invocation, so a warp takes one side and the other costs
              // nothing. When the worker's tree lands, `slot.fill` swaps the
              // storage attributes and flips this uniform: no pass rebuilt, no
              // texture re-created, no material left bound to a dead one.
              If(BVH.readyU.equal(0), () => {
                h.assign(traceWindow(P, wd, reachVox, Nf).hit);
              }).Else(() => {
                h.assign(BVH.anyHitFrom(P, wd, reachBvh, Nf));
              });
            } else {
              h.assign(traceWindow(P, wd, reachVox, Nf).hit);
            }
            v[k].assign(float(1).sub(h));
          });
        });
      }
    });
    textureStore(visA, ivec2(gx.toInt(), gy.toInt()), vec4(v[0], v[1], v[2], v[3]));
  })().compute(halfW * halfH);

  // ── [F] THE SEPARABLE CROSS-BILATERAL, TWICE ─────────────────────────────
  //
  // Plane distance and normal agreement, the same two rejections
  // `createGiLightShadowFilterPass` and `resolveUpsample` both use. A tap on a
  // different surface contributes NOTHING, so a penumbra is softened along the
  // wall it lies on and never across the corner it stops at.
  const filterPass = (srcNode, dstTex, dx, dy) => Fn(() => {
    const i = instanceIndex.toVar();
    const gx = i.mod(halfWU).toVar();
    const gy = i.div(halfWU).toVar();
    If(gy.greaterThanEqual(halfHU), () => { Return(); });
    const c = surfaceAt(gx, gy);
    const acc = vec4(0).toVar();
    const wsum = float(0).toVar();
    If(c.valid, () => {
      const P0 = vec3(c.P).toVar();
      const N0 = vec3(c.N).toVar();
      for (let t = 0; t < TAPS.length; t++) {
        const sx = gx.toInt().add(TAPS[t] * dx).max(0).min(halfWU.toInt().sub(1)).toUint().toVar();
        const sy = gy.toInt().add(TAPS[t] * dy).max(0).min(halfHU.toInt().sub(1)).toUint().toVar();
        const s = surfaceAt(sx, sy);
        // ⚠ REJECTION WEIGHTS ARE EPSILONS, NEVER ZEROS is the gather's rule;
        // here a rejected tap really is absent, and the `wsum` division
        // renormalises over what was accepted — the centre tap always is, so
        // the denominator can never be zero.
        const planar = N0.dot(vec3(s.P).sub(P0)).abs().lessThan(0.05).toVar();
        const aligned = N0.dot(vec3(s.N)).greaterThan(0.9).toVar();
        If(s.valid.and(planar).and(aligned), () => {
          const w = float(TAP_W[t]).toVar();
          acc.addAssign(srcNode.load(ivec2(sx.toInt(), sy.toInt())).mul(w));
          wsum.addAssign(w);
        });
      }
    });
    const out = vec4(1, 1, 1, 1).toVar();
    If(wsum.greaterThan(0), () => { out.assign(acc.div(wsum)); });
    textureStore(dstTex, ivec2(gx.toInt(), gy.toInt()), out);
  })().compute(halfW * halfH);

  const hPass = filterPass(visAN, visB, 1, 0);
  const vPass = filterPass(visBN, visA, 0, 1);

  /**
   * The direct irradiance from every ACTIVE slot at a shading point, with this
   * texel's FILTERED visibility.
   *
   * `Ω = min(π, π·r_eff²/d²)`, `L·Ω·cosθ·vis` — byte for byte what `shadeTerms`'
   * slot loop, `gi2System`'s `emitterDirectPass`, `worldProbes.neePass` and
   * `giLight.emitterDirectAt` all compute, so one lamp delivers one energy on
   * every path and a brightness difference between two of them is a bug rather
   * than a convention.
   */
  const gainOf = slots.map((slot) => emitterShapeGain(slot));
  const directAt = (P, n, gx, gy) => {
    const vis = mix(vec4(1, 1, 1, 1), visAN.load(ivec2(gx.toInt(), gy.toInt())), shadowU).toVar();
    const E = vec3(0).toVar();
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k];
      const centre = vec3(slot.center).toVar();
      const reff = float(slot.reff).max(1e-3).toVar();
      const rgb = vec3(slot.color).toVar();
      const active = float(slot.radius).greaterThan(1e-5)
        .and(rgb.x.add(rgb.y).add(rgb.z).greaterThan(1e-6));
      If(active, () => {
        const wv = centre.sub(P).toVar();
        const d2 = dot(wv, wv).max(1e-4).toVar();
        const d = sqrt(d2).toVar();
        const wd = wv.div(d).toVar();
        const cosX = dot(n, wd).toVar();
        If(cosX.greaterThan(1e-3), () => {
          // §19 5.3d — the seat's `Ω` is the emitter's MEAN projected solid
          // angle (`emitterShapes.shapeMeanProjRadius` is Cauchy's S/4); this
          // is the directional factor that makes it the one it subtends FROM
          // HERE. Mean 1 over the sphere, so the lamp's total power is
          // unchanged and only its silhouette moves. `emitterShapeGain`'s
          // header carries the derivation and the measurement.
          const g = gainOf[k](wd);
          const omega = float(Math.PI)
            .min(float(Math.PI).mul(reff.mul(reff)).mul(g).div(d2)).toVar();
          E.addAssign(rgb.mul(omega).mul(cosX).mul(comp(vis, k).clamp(0, 1)));
        });
      });
    }
    return E;
  };

  return {
    /** [S] → [F.h] → [F.v]. Spliced before the pixel resolve that reads them. */
    passes: [rawPass, hPass, vPass],
    directAt,
    /** The FILTERED visibility (V writes back into A) — for a debug read. */
    texture: visA,
    uniforms: { rcDirectWidth: widthU, rcDirectHeight: heightU, rcDirectShadow: shadowU },
    halfW,
    halfH,
    setSize(w, h) {
      const nw = Math.max(1, Math.round(w));
      const nh = Math.max(1, Math.round(h));
      if (Math.ceil(nw / 2) * Math.ceil(nh / 2) > halfW * halfH) return false;
      widthU.value = nw;
      heightU.value = nh;
      halfWU.value = Math.max(1, Math.ceil(nw / 2));
      halfHU.value = Math.max(1, Math.ceil(nh / 2));
      return true;
    },
    dispose() {
      visA.dispose?.();
      visB.dispose?.();
    },
  };
}
