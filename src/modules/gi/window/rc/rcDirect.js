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
  Fn, If, Return, cross, dot, float, instanceIndex, ivec2, max, mix, normalize, select, sign, sqrt, step, texture, textureStore,
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
const TAPS = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
const TAP_W = TAPS.map((t) => Math.exp(-(t * t) / (2 * 2.4 * 2.4)));
/**
 * §19 6.14 — THE PENUMBRA IS A FILTER WIDTH, NOT A SAMPLE COUNT. One ray per
 * texel, as before; what changed is that the ray reports its FIRST-HIT
 * distance and the filter's radius is the PCSS half-width that distance
 * implies, `lampHalf · t_occ / (d − t_occ)`, in metres at the receiver and
 * converted to texels through the gbuffer's own footprint along each filter
 * axis. `R_MAX` is half-res texels (24 full-res px). The 13 taps are spread
 * over the radius, so a wide penumbra is a 13-level ramp at half res filtered
 * twice — a monotone gradient, no steps a user can see, and no noise because
 * nothing here is stochastic.
 */
const R_MAX = 12;
/**
 * §19 6.25 — THE PENUMBRA FOLLOWS THE LAMP'S SIZE. The width is now the area
 * light's first-order law, W = L · (d_r − d_b) / d_b, with L the lamp's
 * projected extent perpendicular to the seat ray and d_b / d_r the lamp
 * SURFACE → blocker / receiver distances. It has no floor (a blocker near the
 * lamp legitimately makes the whole shadow penumbra), so the filter must reach
 * further than 24 px: a SECOND, coarse round of the same separable filter runs
 * at up to `R_MAX2` half-res texels over the fine round's output, and the
 * blocker search gets a strided second round of the same reach. 13 taps at
 * spacing ≤ R_MAX2/6 over a field already smoothed at σ ≈ 0.4·R_MAX stays a
 * gradient, not a staircase.
 */
const R_MAX2 = 64;
const DILATE_STRIDE = 6;
const QUAD_SPREAD = globalThis.__giQuadSpread ?? 0.5;

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
  trace, voxel0, emitters, gbuffer, camera, width, height, bvh = null, traceDyn = null,
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
  /** §19 6.14 — the PCSS half-width in METRES per slot, raw then dilated (A → B → A). */
  const penA = mk("rcEmitterPen");
  const penB = mk("rcEmitterPenTmp");
  const penAN = texture(penA);
  const penBN = texture(penB);

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
  /**
   * §19 6.12 — THE RAW-PASS RECEIPT. At 1 the raw pass stores, for slot 0,
   * `(valid, cosθ, h, readyU + 10·reach)` instead of visibility and both filters become a
   * centre-tap copy, so a readback of `texture` says WHICH gate a texel took —
   * "vis = 1.000 everywhere" is otherwise three different failures.
   */
  const debugU = uniform(0);
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
    const pen = [float(0).toVar(), float(0).toVar(), float(0).toVar(), float(0).toVar()];
    const dbg = vec4(0, 0, 0, 0).toVar();
    If(s.valid, () => {
      dbg.x.assign(1);
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
          if (k === 0) If(debugU.lessThan(1.5), () => { dbg.y.assign(dot(Nf, wd)); });
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
            // §19 6.12 — computed AFTER `slab` (below): the voxel arm's clearance
            // is the OBB slab exit plus TWO level-0 cells, not `radius + v0/2`.
            // Measured on Cornell (voxel arm, back wall): every lit ray stopped
            // at t = reach − 0.09 m with `hit = 1` — inside the lamp's OWN bits.
            // The lamp's bits are cell-snapped (≤ v0 past its surface) and then
            // dilated by one cell (+ v0), so the conservative clearance past the
            // slab exit is 2·v0; `radius + v0/2` was 0.87 m from the centre of a
            // lamp whose bits reach 0.96 m along a diagonal. Direct read 0 at
            // every wall pixel, lit or not.
            const reachVox = float(0).toVar();
            // ⭐⭐⭐ AND THE EXACT ARM'S CLEARANCE IS THE OBB'S SLAB EXIT, NOT
            // THE BOUNDING SPHERE — this is the "no shadow on the wall behind
            // the tall box" report.
            //
            // `radius` is the emitter's BOUNDING SPHERE, so for a TALL box it
            // is the half-DIAGONAL: a metre or more on a lamp whose actual
            // half-width is 15 cm. Stopping the ray `radius` short of the seat
            // centre therefore carves a metre-wide sphere out of every shadow
            // ray aimed at it, and anything inside that sphere — including the
            // emitter's OWN body, which is exactly what should be shadowing
            // the wall behind it — is never tested. The wall reads unshadowed
            // and the lamp appears to shine through itself.
            //
            // `exHalf` is already the conservative world-axis OBB that GISystem
            // documents as "the OBB the sphere-arm marchers exclude", so the
            // right quantity is the slab EXIT along this ray: from the centre,
            // travelling back toward the shading point, the ray leaves the box
            // at `min_i(exHalf_i / |wd_i|)`. For a sphere fit (`exHalf` set to
            // `radius` on every axis) an axis-aligned ray gives back `radius`
            // exactly, so nothing spherical moves; for a tall box seen from the
            // side it gives the half-WIDTH, and the box occludes again.
            //
            // ⚠ Clamped ABOVE by `clear`: the slab exit must never exceed the
            // bounding sphere, or a numerically tiny `wd` component would push
            // the stop point past the lamp and let the lamp shadow itself —
            // the failure this whole stage exists to delete.
            // ⭐⭐⭐ §19 6.14 — THE SLAB IS TAKEN IN THE EMITTER'S OWN FRAME.
            // `exHalf` is the exclusion box's half-extent along `bx/by/bz`
            // (`shapeExclusionHalf`: a BOX kind stores its LOCAL half-extents,
            // a capsule its axis length + cap radius), so a world-axis slab
            // against a rotated cube measured the wrong box: from the ceiling
            // straight above the lamp the ray stopped at the cube's local
            // half-height while its rotated top face reached higher, the ray
            // ended INSIDE the lamp, and the lamp shadowed the ceiling with its
            // own silhouette. Here the ray direction is expressed in the OBB
            // frame; the ray runs THROUGH the centre by construction, so its
            // entry into the box is exactly `d − min_i(exHalf_i / |wd·b_i|)`
            // and the emitter's own triangles/voxels are never on the segment.
            const ex = vec3(slot.exHalf).abs().max(1e-4).toVar();
            const ld = vec3(dot(wd, vec3(slot.bx)), dot(wd, vec3(slot.by)), dot(wd, vec3(slot.bz))).abs().max(1e-6).toVar();
            const slab = ex.x.div(ld.x).min(ex.y.div(ld.y)).min(ex.z.div(ld.z)).toVar();
            // §19 6.12 — AND A MARGIN BEFORE THE SLAB EXIT: a ray stopped exactly
            // on the face lands on the "hit" side of Möller-Trumbore's `t < maxT`.
            // 0.1 % of the distance (4 mm at 4 m) is 10⁴ f32 ulps.
            const reachBvh = d.sub(slab.min(clear)).sub(d.mul(1e-3).max(2e-3)).max(1e-3).toVar();
            reachVox.assign(d.sub(slab.min(clear)).sub(float(2 * v0)).max(v0 * 0.5));
            // The ray now returns WHERE it stopped, not only whether. `tOcc`
            // is −1 for a clear ray on the exact arm; the voxel arm's `t` is
            // whatever the DDA reports, masked by `hit` below.
            // ⭐⭐ §19 6.25b — THE PENUMBRA STRUCTURE COMES FROM GEOMETRY, THE
            // FILTER ONLY FILLS THE LEVELS. 6.25 proved a blurred BINARY mask
            // cannot keep an umbra once the physical width W is comparable to
            // the shadow: the wall's dip was erased at both lamp sizes. So the
            // texel now traces FOUR shadow rays, one to the centre of each 2×2
            // quadrant of the emitter's face that faces the receiver (the face
            // is the centre ray's slab-exit axis, in the emitter's frame; the
            // four points are the same for every pixel — nothing stochastic).
            // visibility = the mean: a fully blocked texel stays 0 by
            // construction, a texel that sees two quadrants reads 0.5, and the
            // truth's dip depth follows. Each ray ends ON its face point (minus
            // the arm's margin), so the lamp's own body is never on the
            // segment: the near face's plane separates the receiver from the
            // box whenever the centre ray enters through it.
            const axq = ex.div(ld).toVar();
            const isX = axq.x.lessThanEqual(axq.y).and(axq.x.lessThanEqual(axq.z));
            const isY = isX.not().and(axq.y.lessThanEqual(axq.z));
            const isZ = isX.not().and(isY.not());
            const ldsS = vec3(dot(wd, vec3(slot.bx)), dot(wd, vec3(slot.by)), dot(wd, vec3(slot.bz))).toVar();
            const bxv = vec3(slot.bx).toVar(), byv = vec3(slot.by).toVar(), bzv = vec3(slot.bz).toVar();
            const faceN = select(isX, bxv.mul(sign(ldsS.x)), select(isY, byv.mul(sign(ldsS.y)), bzv.mul(sign(ldsS.z)))).toVar();
            const faceE = select(isX, ex.x, select(isY, ex.y, ex.z)).toVar();
            const tU = select(isX, byv, bxv).toVar();
            const eU = select(isX, ex.y, ex.x).mul(QUAD_SPREAD).toVar();
            const tV = select(isZ, byv, bzv).toVar();
            const eV = select(isZ, ex.y, ex.z).mul(QUAD_SPREAD).toVar();
            const F = centre.sub(faceN.mul(faceE)).toVar();
            // §19 6.25c receipt: debug 2 → (axis + 10·[sign>0], F.xyz) for slot 0
            if (k === 0) {
              If(debugU.greaterThan(1.5), () => {
                const code = select(isX, float(0), select(isY, float(1), float(2)))
                  .add(select(isX, ldsS.x, select(isY, ldsS.y, ldsS.z)).greaterThan(0).select(float(10), float(0)));
                dbg.assign(vec4(code, F.x, F.y, F.z));
              });
            }
            const quad = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => {
              const Q = F.add(tU.mul(eU.mul(a))).add(tV.mul(eV.mul(b)));
              const wq = Q.sub(P).toVar();
              const dq = sqrt(dot(wq, wq).max(1e-6)).toVar();
              if (QUAD_SPREAD < 0) return { pt: centre.sub(wd.mul(slab.min(clear))).toVar(), dir: wd, bvh: reachBvh, vox: reachVox }; // isolation: the centre ray x4
              return { pt: Q.toVar(), dir: wq.div(dq).toVar(), bvh: dq.sub(dq.mul(1e-3).max(2e-3)).max(1e-3).toVar(), vox: dq.sub(float(2 * v0)).max(v0 * 0.5).toVar() };
            });
            const hSum = float(0).toVar();
            const h = float(0).toVar();
            const tOcc = float(-1).toVar();
            // the voxel arm's four rays; the width's t is the NEAREST blocker
            const voxQuad = () => {
              for (const q of quad) {
                const tr = traceWindow(P, q.dir, q.vox, Nf);
                hSum.addAssign(tr.hit);
                If(tr.hit.greaterThan(0.5).and(tOcc.lessThan(0).or(tr.t.lessThan(tOcc))), () => { tOcc.assign(tr.t.max(0)); });
              }
              h.assign(step(0, tOcc));
            };
            if (BVH) {
              If(BVH.readyU.equal(0), () => { voxQuad(); }).Else(() => {
                // §19 6.21 — MOVERS ARE NOT IN THE TREE (their placement bit is
                // excluded the frame they move); the K.5 dynamic mirror answers
                // for them at their live pose. visibility = static ∧ dynamic
                // per quadrant ray, and the PCSS `tOcc` is the CENTRE ray's
                // nearer blocker of the two.
                // §19 6.25d — ONE call: the four quadrant rays and the centre's
                // nearest-t traverse inside gi2BvhQuadVis over one binding set.
                const qv = BVH.quadVisFrom(P, wd, reachBvh, quad[0].pt, quad[1].pt, quad[2].pt, quad[3].pt, float(1e-3), Nf).toVar();
                hSum.assign(qv.x);
                if (traceDyn) {
                  for (const q of quad) hSum.addAssign(traceDyn.traceWindow(P, q.dir, q.vox, Nf).hit);
                  hSum.assign(hSum.min(4));
                }
                tOcc.assign(qv.y);
                if (traceDyn) {
                  const td = traceDyn.traceWindow(P, wd, reachVox, Nf);
                  const tdT = td.t.toVar();
                  If(td.hit.greaterThan(0.5).and(tOcc.lessThan(0).or(tdT.lessThan(tOcc))), () => { tOcc.assign(tdT.max(0)); });
                }
                h.assign(step(0, tOcc));
              });
            } else {
              voxQuad();
              if (k === 0) If(debugU.lessThan(1.5), () => { dbg.y.assign(tOcc); }); // 6.12 receipt
            }
            // five levels; a fully blocked texel stays 0 — the umbra survives
            if (globalThis.__giVisFromH) v[k].assign(float(1).sub(h)); // isolation A: the 6.25 expression
            else v[k].assign(float(1).sub(hSum.mul(0.25).clamp(0, 1)));
            // §19 6.25 — THE PENUMBRA WIDTH BY CONSTRUCTION. Area light of
            // extent L seen from a planar blocker: full width at the receiver
            //   W = L · (d_r − d_b) / d_b = L · t_occ / d_b,
            // d_r = lamp SURFACE → receiver (the seat ray's end at the OBB
            // entry, exact since 6.14), d_b = d_r − t_occ = lamp surface →
            // blocker. L is the OBB's projected extent PERPENDICULAR to the
            // ray (the geometric mean of its support along two perpendicular
            // axes; a cube seen face-on gives its edge, a sphere fit its
            // diameter), NOT the bounding sphere and NOT the largest axis.
            //
            // ⛔ NO FLOOR on d_b beyond a numerical ε. 6.14 floored it at the
            // lamp's half-size, which made W = t_occ for every blocker within
            // a lamp-half of the lamp — both Cornell lamps are — so the ×2 lamp
            // measured the same 9 px ramp as the ×1 (the user's report). A
            // blocker touching the lamp legitimately turns the whole shadow
            // into penumbra; the filter's reach (R_MAX2) is the only cap.
            const lds = vec3(dot(wd, vec3(slot.bx)), dot(wd, vec3(slot.by)), dot(wd, vec3(slot.bz))).toVar();
            const pickX = ld.x.lessThanEqual(ld.y).and(ld.x.lessThanEqual(ld.z));
            const pickY = ld.y.lessThanEqual(ld.z);
            const seed = select(pickX, vec3(1, 0, 0), select(pickY, vec3(0, 1, 0), vec3(0, 0, 1))).toVar();
            const pu = normalize(cross(lds, seed)).toVar();
            const pv = cross(lds, pu).toVar();
            const su = dot(ex, pu.abs()).toVar();
            const sv = dot(ex, pv.abs()).toVar();
            const lampL = sqrt(su.mul(sv)).mul(2).toVar();
            const dSurf = d.sub(slab.min(clear)).max(1e-3).toVar();
            // §19 6.25b — guarded at 5 % of d_r: a mover's own voxels on the
            // dynamic arm report t ≈ reach, and d_b → ε blew W up to the whole
            // wall. And the blur's width is ONE QUADRANT's penumbra, W/4 — the
            // four hard edges are already spread across W by the geometry.
            const dBlk = dSurf.sub(tOcc.max(0)).max(dSurf.mul(0.05)).toVar();
            pen[k].assign(h.mul(lampL).mul(tOcc.max(0)).div(dBlk).mul(0.25));
            if (k === 0) { If(debugU.lessThan(1.5), () => { dbg.z.assign(h); dbg.w.assign(BVH ? BVH.readyU.add(reachBvh.mul(10)) : reachVox); }); }
          });
        });
      }
    });
    const outV = vec4(v[0], v[1], v[2], v[3]).toVar();
    If(debugU.greaterThan(0.5), () => { outV.assign(dbg); });
    textureStore(visA, ivec2(gx.toInt(), gy.toInt()), outV);
    textureStore(penA, ivec2(gx.toInt(), gy.toInt()), vec4(pen[0], pen[1], pen[2], pen[3]));
  })().compute(halfW * halfH);
  // §19 6.12 — the slot re-binds this kernel when the worker's tree lands.
  if (BVH) BVH.attach?.(rawPass);

  // ── [B] THE BLOCKER SEARCH: THE PENUMBRA GROWS OUTSIDE THE HARD EDGE ─────
  //
  // A clear ray carries no blocker distance, so an unoccluded texel next to a
  // shadow would keep radius 0 and the ramp would live only INSIDE the
  // geometric edge. The standard PCSS blocker search fixes that: a texel
  // adopts a neighbour's radius when it lies within that radius of the
  // neighbour — in WORLD metres, through the gbuffer, so a far surface behind
  // a near edge is not reached and no depth test is needed. Separable, max.
  const dilatePass = (srcNode, dstTex, dx, dy, stride = 1) => Fn(() => {
    const i = instanceIndex.toVar();
    const gx = i.mod(halfWU).toVar();
    const gy = i.div(halfWU).toVar();
    If(gy.greaterThanEqual(halfHU), () => { Return(); });
    const c = surfaceAt(gx, gy);
    const r = srcNode.load(ivec2(gx.toInt(), gy.toInt())).toVar();
    If(c.valid, () => {
      const P0 = vec3(c.P).toVar();
      for (let o = -R_MAX; o <= R_MAX; o++) {
        if (o === 0) continue;
        const sx = gx.toInt().add(o * dx * stride).max(0).min(halfWU.toInt().sub(1)).toUint().toVar();
        const sy = gy.toInt().add(o * dy * stride).max(0).min(halfHU.toInt().sub(1)).toUint().toVar();
        const s = surfaceAt(sx, sy);
        If(s.valid, () => {
          const rn = srcNode.load(ivec2(sx.toInt(), sy.toInt())).toVar();
          const dv = vec3(s.P).sub(P0).toVar();
          const dist = sqrt(dot(dv, dv)).toVar();
          r.assign(r.max(rn.mul(step(vec4(dist), rn))));
        });
      }
    });
    textureStore(dstTex, ivec2(gx.toInt(), gy.toInt()), r);
  })().compute(halfW * halfH);
  const dilH = dilatePass(penAN, penB, 1, 0);
  const dilV = dilatePass(penBN, penA, 0, 1);
  // §19 6.25 — the coarse round: the fine round has already spread every
  // blocker's radius ±R_MAX, so a stride-6 search reaches ±72 texels with no
  // gap a stride can fall through. Same world-distance test, same W.
  const dilH2 = dilatePass(penAN, penB, 1, 0, DILATE_STRIDE);
  const dilV2 = dilatePass(penBN, penA, 0, 1, DILATE_STRIDE);

  // ── [F] THE SEPARABLE CROSS-BILATERAL, TWICE, AT THE PCSS RADIUS ─────────
  //
  // Plane distance and normal agreement, the same two rejections
  // `createGiLightShadowFilterPass` and `resolveUpsample` both use. A tap on a
  // different surface contributes NOTHING, so a penumbra is softened along the
  // wall it lies on and never across the corner it stops at. §19 6.14: the 13
  // taps are spread over `radius = clamp(penumbra / footprint, 1, R_MAX)`
  // texels, where `footprint` is the world size of one half-res texel along
  // this pass's axis, read off the gbuffer's neighbour on the same plane — a
  // grazing wall is foreshortened and its blur shrinks with it. The radius is
  // the largest of the four slots' (one loop, not four).
  const filterPass = (srcNode, dstTex, dx, dy, coarse = false) => Fn(() => {
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
      const pw = penAN.load(ivec2(gx.toInt(), gy.toInt())).toVar();
      const rW = pw.x.max(pw.y).max(pw.z).max(pw.w).toVar();
      const fp = float(1e9).toVar();
      for (const sgn of [1, -1]) {
        const nx = gx.toInt().add(sgn * dx).max(0).min(halfWU.toInt().sub(1)).toUint().toVar();
        const ny = gy.toInt().add(sgn * dy).max(0).min(halfHU.toInt().sub(1)).toUint().toVar();
        const n = surfaceAt(nx, ny);
        const dv = vec3(n.P).sub(P0).toVar();
        const same = n.valid.and(N0.dot(dv).abs().lessThan(0.05)).and(N0.dot(vec3(n.N)).greaterThan(0.9));
        If(same, () => { fp.assign(fp.min(sqrt(dot(dv, dv)).max(1e-5))); });
      }
      // §19 6.25 — fine round: the radius up to R_MAX. Coarse round: the SAME
      // radius when it exceeds R_MAX (up to R_MAX2), else 0 — every tap then
      // lands on the centre and the pass is the identity.
      const rAll = rW.div(fp).toVar();
      const rT = coarse
        ? select(rAll.greaterThan(R_MAX), rAll.min(R_MAX2), float(0)).toVar()
        : rAll.clamp(1, R_MAX).toVar();
      for (let t = 0; t < TAPS.length; t++) {
        const off = rT.mul(TAPS[t] / 6).round().toInt().toVar();
        const sx = gx.toInt().add(off.mul(dx)).max(0).min(halfWU.toInt().sub(1)).toUint().toVar();
        const sy = gy.toInt().add(off.mul(dy)).max(0).min(halfHU.toInt().sub(1)).toUint().toVar();
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
    If(debugU.greaterThan(0.5), () => { out.assign(srcNode.load(ivec2(gx.toInt(), gy.toInt()))); });
    textureStore(dstTex, ivec2(gx.toInt(), gy.toInt()), out);
  })().compute(halfW * halfH);

  const hPass = filterPass(visAN, visB, 1, 0);
  const vPass = filterPass(visBN, visA, 0, 1);
  const hPass2 = filterPass(visAN, visB, 1, 0, true);
  const vPass2 = filterPass(visBN, visA, 0, 1, true);

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
    passes: [rawPass, dilH, dilV, dilH2, dilV2, hPass, vPass, hPass2, vPass2],
    directAt,
    /** The FILTERED visibility (V writes back into A) — for a debug read. */
    texture: visA,
    /** §19 6.14 — the DILATED PCSS half-width (metres) per slot — for a debug read. */
    penumbra: penA,
    /** The gbuffer textures this pass CAPTURED at build — for the stale-binding receipt. */
    bound: { position: gbuffer.position, normal: gbuffer.normal },
    /** The BVH slot this kernel CAPTURED at build — identity receipt vs `gi2.shadowBvh`. */
    bvhSlot: BVH,
    uniforms: { rcDirectWidth: widthU, rcDirectHeight: heightU, rcDirectShadow: shadowU, rcDirectDebug: debugU },
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
      penA.dispose?.();
      penB.dispose?.();
    },
  };
}
