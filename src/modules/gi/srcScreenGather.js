// SPLIT RADIANCE CASCADES — [I] THE SCREEN GATHER. THE BLOCKS GO AWAY.
//
// Per shading point: the ≤8 nearest c0 probes, sparse-trilinear-renormalized,
// each contributing ONE filtered tile sample in the point's normal direction,
// blended across the LOD overlap band. `srcRef.js`'s `gatherPixel` is the
// mirror and `test:gi-src-gather` diffs the two.
//
// This replaces `srcGather.js`, which assigned ONE probe per pixel with NO
// interpolation — the reason every frame since §12.17 has been ~0.6 m
// rectangles. Those rectangles were the probe cells at the correct spacing, so
// no amount of probe density was ever going to remove them; interpolation is.
//
// ══ IT IS A CLOSURE FIRST AND A PASS SECOND, AND THAT IS THE POINT ═════════
//
// `gatherAt(position, normal)` answers for an ARBITRARY WORLD POINT. Three call
// sites want that and they are not the same shape:
//
//   • the primary diffuse term, once per gbuffer pixel — which runs here, in
//     its own compute pass, and hands `createGiResolve` a texture;
//   • the EXACT-REFLECTION HIT, at a world point no screen texture can answer
//     for. That call site has been on `gather == null` since the transport died
//     (§12.17.3) and this is the unit that brings it back;
//   • [J]'s SECOND BOUNCE (`srcSecondary.js`), once per entry of the deposit's
//     hit list — a set of world points with no screen grid at all, which is why
//     omitting `readPixel` here builds the closure and nothing else.
//
// One definition, three call sites. The alternative — a screen pass plus a
// separate closure for reflections — is two implementations of the same
// integral, and the one nobody looks at drifts.
//
// ══ WHY THE PRIMARY TERM STILL GOES THROUGH A TEXTURE ══════════════════════
//
// The resolve kernel already carries the gbuffer, the emitter slots, the
// occupancy pyramid and the BVH against a PORTABLE limit of EIGHT storage
// buffers per stage. `gatherAt` costs two of them (see the lookup below), which
// is affordable ONCE — for the reflection path, which is a single call — and
// not per-pixel on top of everything else the resolve wants. So the primary
// term is computed here, at half res, and sampled as a texture; a texture
// binding is free of that limit.
//
// ══ TWO STORAGE BUFFERS, NOT THREE, AND `hashBlock` IS WHY ═════════════════
//
// The natural corner lookup is three fetches: `hashKeys` → hash slot,
// `hashSlot` → probe index, `probeTable[probe].block` → the tile. Three storage
// buffers in a kernel that has none to spare.
//
// So the frame publishes `hashBlock`, one word per c0 hash slot holding that
// slot's BIN BLOCK directly. It is written by a pass over the hash region that
// already ran everything it needs, it costs 128 KB at the engine default, and
// it collapses the lookup to `hashKeys` + `hashBlock`. The probe INDEX is never
// needed here — only its tile — so carrying it was pure indirection.
//
// ══ COVERAGE IS FOLDED INTO THE WEIGHT, AND IT IS R1 APPLIED TWICE ═════════
//
// The atlas's alpha is 1 where a texel found a known bin and 0 where it did not
// (§12.21.4). Filtered, it is `Σ w_tap` over the covered taps, exactly as the
// filtered rgb is `Σ w_tap · E`. So each corner contributes
//
//     numerator   += rgb · w_corner        (already Σ w_tap·E inside)
//     denominator += a   · w_corner        (already Σ w_tap   inside)
//
// and ONE division at the end is the coverage-weighted mean over every
// contributing texel of every contributing probe. Consequences, both wanted:
//
//   • a probe that knows NOTHING about this direction (a = 0) drops out of the
//     interpolation and the others renormalize — the same treatment
//     `sparseGather` gives a probe that does not exist;
//   • a probe whose tap STRADDLES the edge of what it knows contributes in
//     proportion to what it knows.
//
// Dividing per tap instead would give every probe an equal vote regardless of
// how much of its tap was real. §12.21.4 measured 6.7% of claimed-tile texels
// carrying no information, so this is not a corner case.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.1 [I], §12.18.7 unit 5, §12.10.1.

import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  atomicAdd,
  atomicMax,
  atomicMin,
  atomicStore,
  float,
  floor,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  ivec3,
  mix,
  reflect,
  select,
  texture,
  textureStore,
  uint,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { MAX_LODS, W0 } from "./srcConfig.js";
import {
  chebyshev,
  latticeOrigin,
  latticeOriginCell,
  lodAtDistance,
  lodBlend,
  packProbeKey,
  probeSpacing,
} from "./srcMathTsl.js";
import { LOS_OCC_HI, LOS_OCC_LO, LOS_PATH_HI, LOS_PATH_LO, gatherLosWeight, gatherNormalBias, gatherNormalWeightExp, gatherSmoothWeights, worldKeysEnabled } from "./srcMath.js";
import { SLOT_EMPTY } from "./srcProbes.js";

/** Gather telemetry — the same five failures `srcGather.js` learned to separate. */
export const GG_PIXELS = 0;   // pixels with a valid gbuffer sample
export const GG_LIT = 1;      // ...that came out above zero
export const GG_EMPTY = 2;    // ...that found no probe with coverage at all
export const GG_SUM = 3;
export const GG_MIN = 4;
export const GG_MAX = 5;
export const GG_CORNERS = 6;  // Σ corners that had a BLOCK
/**
 * Σ corners that had COVERAGE — i.e. whose tile actually knew something in the
 * pixel's direction (`tap.w > 0`), which is the only kind of corner that moves
 * the answer.
 *
 * ⚠ `GG_CORNERS` COULD NOT SEE THE FAILURE IT WAS BUILT FOR. Its increment sits
 * inside `If(block != SLOT_EMPTY)`, so it counts corners that exist, never
 * corners that VOTE — and the shell's renormalisation divides by `wsum`, which
 * is coverage. A shell whose eight probes all exist and all know nothing about
 * this direction reads `meanCorners 8.0` and returns the answer of however few
 * corners had coverage; at one, that is a CONSTANT over the whole cell, which
 * is a literal block. `meanCovered` is the number that separates "the lattice is
 * thin" from "the lattice is there and silent". Read them as a PAIR.
 */
export const GG_COVERED = 7;
export const GG_WORDS = 8;
const LUM_FIXED = 4096;

/**
 * The trilinear corner offsets, in `srcMath.js`'s `trilinearCorners` order:
 * corner k is `(k&1, (k>>1)&1, k>>2)`. Same ordering as `srcMerge.js` uses, for
 * the same reason — a gate compares corner k against corner k.
 */
const CORNERS = Array.from({ length: 8 }, (_, k) => [k & 1, (k >> 1) & 1, (k >> 2) & 1]);

/**
 * Build the position-indexed probe gather.
 *
 * @param {object} store   from `createSrcProbeStore`
 * @param {object} tiles   from `createSrcTileAtlas`
 * @param {object} options
 * @param {object} options.lookup  `createSrcHashBlockLookup`'s closure —
 *   key → bin block, or SLOT_EMPTY
 * @param {Node|number} options.spacing0
 * @param {Node} options.camera  world camera position; the LOD metric's centre
 * @param {Node} options.anchor  the SAME lattice anchor the population used
 * @param {Node} [options.lodBias]  added to the fractional LOD before the shell
 *   split — [J]'s dial for reading the field COARSER than the shading point's
 *   own LOD (srcConfig's `SECONDARY_LOD_OFFSET`). ABSENT on the screen pass,
 *   deliberately: no node is added and the graph is byte-identical to the one
 *   every pre-[J] gate measured.
 * @param {(i) => object} [options.readPixel]  the gbuffer, as a closure. Omit
 *   it (with `width`/`height`) to build the CLOSURE ONLY — `gatherAt` and
 *   nothing else. `srcSecondary.js` wants the integral at a hit list, not at a
 *   screen grid, and building the pass anyway would allocate a storage texture
 *   nothing ever samples and a dispatch nothing ever runs.
 * @param {number} [options.width]  gbuffer width
 * @param {number} [options.height]
 */
export function createSrcScreenGather(store, tiles, {
  lookup,
  spacing0,
  camera,
  anchor,
  readPixel = null,
  width = 0,
  height = 0,
  lodBias = null,
  maxLods = MAX_LODS,
  w0 = W0,
  // §15 U3 — the occupancy field's one-bit world-space test
  // (`occField.occupiedAtWorld`) + the world bundle the lift is sized from.
  // OPTIONAL: an instance built without them (a gate page with no engine)
  // simply cannot arm LOS and keeps the exact pre-U3 graph. A BIT test, not
  // the distance oracle: the oracle's 27-voxel near field at the march's
  // call count priced the gather ×18 (los-gate run 9); the march only ever
  // asks "is this sample inside geometry", which is one word fetch.
  losOccupied = null,
  losWorld = null,
} = {}) {
  void store;
  void w0;
  // §13.7d, hatch-gated until a rig prices it (the flip discipline: an OFF
  // arm that is the default). `srcRef.js`'s mirror reads the SAME global, or
  // `test:gi-src-gather` would diff a weighted GPU against an unweighted CPU
  // and call the fix a regression.
  // `true` = the standard DDGI square; a NUMBER is the exponent, and it is the
  // strength dial — 2 removes the most leak and costs the most brightness
  // (measured on Bistro: awning cavity −42%, but the whole frame −35%), 1 is
  // the soft half of that. See plan §13.7d for the ledger.
  // §14 Q9: default-armed at exponent 1 through the shared reader — see
  // `gatherNormalWeightExp` in srcMath.js for the ledger and the hatch.
  // §15 U3 — LOS validity supersedes the tangent-plane heuristic when armed:
  // both answer "should this probe vote here", and the plane test is the
  // approximation (it suppresses by GEOMETRY SIDE, LOS by measured occupancy —
  // the plane test's Q9c corner-brightening came from suppressing probes the
  // point could actually see). Armed only when the caller supplied the
  // distance closure; a closure-less instance keeps the pre-U3 graph.
  const losArmed = gatherLosWeight() && !!losOccupied && !!losWorld;
  // The boot receipt the gate asserts (the §12.70 rule: identical-across-arms
  // readings mean "same code path" until an armed line proves otherwise).
  // SCREEN instances only (readPixel present): the closure-only secondary
  // instance is EXPECTED to lack the distance closure and must not cry wolf.
  if (readPixel && gatherLosWeight() && !losArmed) {
    console.warn("[gi] gather: LOS validity requested but NOT armed — no distance closure at this screen instance");
  } else if (readPixel && losArmed) {
    console.info(`[gi] gather: LOS validity ARMED (voxel ${losWorld.minCellValue ?? losWorld.minCell?.value ?? "?"})`);
  }
  const nwExp = losArmed ? 0 : gatherNormalWeightExp();
  const normalWeight = nwExp > 0;
  // §13.9, shared with the CPU mirror through one reader.
  //
  // ⭐ AND IT IS A LIVE UNIFORM, NOT A BUILD CONSTANT (2026-08-23). Every
  // cross-BOOT A/B on the user's Level is swamped: the plan's own method rule
  // says this scene needs "N≥4 boots per arm with medians+spread, or a
  // within-boot dial" because the healthy boot-to-boot spread is ~2×. A build
  // constant forces the expensive option. As a uniform, one boot can render
  // BOTH arms at the same pose, the same convergence state and the same GPU
  // clock — a PAIRED comparison, which is the only kind this scene supports
  // cheaply.
  //
  // The mix is over the WEIGHT PARAMETER only, so at 0 the graph evaluates the
  // identical arithmetic the pre-uniform build did (`mix(t, s, 0) == t`), and
  // the uniform defaults to the shared reader — so `test:gi-src-gather` still
  // diffs the same configuration the CPU mirror is in. `__giGatherSmoothLive`
  // pins it per frame for the paired probe.
  const smoothWeights = gatherSmoothWeights();
  const smoothU = uniform(smoothWeights ? 1 : 0);
  /** §12.88's normal bias in metres — see `gatherAt`. Live, defaults to 0. */
  const biasU = uniform(gatherNormalBias());
  /**
   * §12.89 — how much of the §15 U3 LOS suppression to apply, 0..1. Only
   * meaningful when `losArmed` compiled the march in; 1 is the shipped armed
   * behaviour and 0 is the identity. See the `mix` at the suppression site.
   */
  const losStrengthU = uniform(1);

  /**
   * THE GATHER. One world point, one normal, one irradiance.
   *
   * Inlined at both call sites — the screen pass below and
   * `createGiResolve`'s exact-reflection hit — so there is one integral, not
   * two that happen to agree today.
   *
   * `sampleDir` (optional, §12.71b v2): the direction the tile taps are
   * taken in, when it is not the surface normal — the glossy pass feeds the
   * REFLECTION vector here. The normal keeps every other job it has: the
   * lattice-side weighting (§13.7d's one-sided plane test asks "is this
   * probe on my surface's side", a question about the SURFACE, not about
   * the lobe being read) and the LOD stencil. When absent the tap direction
   * IS the normal and the graph is byte-identical to what every gather gate
   * measured.
   */
  const gatherAt = (position, normal, sampleDir = null, lodOffset = null) => {
    const N = vec3(normal).normalize().toVar();
    // ── §12.88: SAMPLE THE LATTICE FROM IN FRONT OF THE SURFACE ────────────
    //
    // `P` was the raw gbuffer position, so the four corners BEHIND the shaded
    // face sat up to `s0` behind it — 0.45 m on the user's Level, against
    // 0.25 m partition walls, i.e. squarely in the next room, voting at full
    // trilinear weight with nothing to stop them (every geometric guard in this
    // file is opt-in and off: the plane test, the LOS march, the C1 weights).
    // Offsetting along the normal is geometric, not heuristic — the far corner
    // reaches `s0 − β` past the surface, so the leak through a wall of
    // thickness `w` is exactly zero once `β > s0 − w`.
    //
    // ⚠ A LIVE UNIFORM AND ZERO BY DEFAULT. Zero reproduces the pre-§12.88
    // graph exactly (`P = position`), so every gather gate measures what it
    // always did; the uniform is what lets one boot sweep β at one pose, which
    // is the only A/B this scene supports. `gatherNormalBias()` is the shared
    // reader — the CPU mirror reads it too, or the twin diff would call an
    // armed default a regression.
    const P = vec3(position).add(N.mul(biasU)).toVar();
    const S = sampleDir ? vec3(sampleDir).normalize().toVar() : N;
    const lodF = lodAtDistance(chebyshev(P, camera), spacing0, maxLods).toVar();
    // The bias is RE-CLAMPED to the same window `lodAtDistance` returns. A
    // negative bias would otherwise select a lattice finer than any the
    // population inserts at (every corner misses, silently) and a positive one
    // past the last shell would index a LOD the 4-bit key cannot hold.
    if (lodBias) lodF.assign(lodF.add(float(lodBias)).clamp(0, maxLods - 1));
    // ⭐ §19 5.5a — A SECOND, PER-CALL OFFSET, AND IT IS THE PAPER'S LOBE DIAL.
    //
    // `lodBias` above is a BUILD constant — one number for the whole gather.
    // The glossy read needs a NODE, because §3.2's rule is "a rougher lobe is
    // read from a coarser cascade" and roughness is a uniform the material side
    // moves. Same re-clamp, same window, and `null` (every caller but
    // `rcMerge`'s glossy arm) leaves the graph byte-identical to what every
    // gather gate measured.
    if (lodOffset) lodF.assign(lodF.add(float(lodOffset)).clamp(0, maxLods - 1));
    // `lodShells` on the CPU returns one or two shells; a GPU kernel cannot
    // branch on a list length, so both are written out and the second is
    // guarded by its own weight. `min(maxLods - 1)` matches the mirror's clamp
    // exactly — a point past the last shell samples the last shell rather than
    // an empty one.
    const base = floor(lodF).min(maxLods - 1).toVar();
    const blend = lodBlend(lodF).toVar();

    const out = vec3(0).toVar();
    const shellTotal = float(0).toVar();
    const cornersHit = uint(0).toVar();
    const cornersCovered = uint(0).toVar();

    // §15 U3 — LOS shared pieces, hoisted: the march start is the shaded point
    // lifted ONE OCCUPANCY VOXEL off its surface, so samples hugging the own
    // wall read a free radius ≈ the lift and pass the tight threshold below —
    // the hugging-ray false positive is excluded by GEOMETRY, not by a plane
    // heuristic. `losMinCell` is the occupancy voxel scale (world.cell mirrors
    // occField.voxel), which is what makes every threshold voxel-relative and
    // resolution-independent.
    const losMinCell = losArmed ? float(losWorld.minCell).toVar() : null;
    const losStart = losArmed ? P.add(N.mul(losMinCell)).toVar() : null;

    /** One LOD shell's sparse-trilinear, coverage-weighted gather. */
    const shell = (lod, shellWeight) => {
      const s = probeSpacing(0, lod, spacing0).toVar();
      const origin = latticeOrigin(anchor, s).toVar();
      const f = P.sub(origin).div(s).toVar();
      const cell0 = floor(f).toVar();
      const t = f.sub(cell0).toVar();
      // §13.9 — C1 ACROSS CELL FACES. Plain trilinear steps its GRADIENT at
      // every face, and a gradient step is a visible line. `3t²−2t³` has zero
      // derivative at t=0 and t=1, so the two cells sharing a face agree on
      // the slope as well as the value. `cell0` and the corner KEYS are
      // untouched — this reshapes the weights only, so the population, the
      // hash and the coverage renormalization are all exactly as before.
      // `mix(t, 3t²−2t³, smoothU)`: at 0 this is bit-identical to the C0
      // weights, at 1 it is §13.9's C1 weights, and in between it is a live
      // dial — see `smoothU`'s note above for why a dial and not a constant.
      t.assign(mix(t, t.mul(t).mul(float(3).sub(t.mul(2))), smoothU));
      // ── S1: THE CORNER KEYS MUST BE IN THE SAME COORDINATE SYSTEM THE
      // POPULATION WROTE ────────────────────────────────────────────────────
      //
      // `cell0` is LOCAL to the lattice origin, which is what the interpolation
      // and the §13.7d facing test below both want (they work in offsets from
      // `origin`, and that keeps the f32 subtraction camera-relative — trap 4).
      // The KEY, under world-absolute keying, is indexed by the WORLD cell. The
      // two differ by exactly the origin's own integer cell, so the lookup gets
      // the shift and nothing else does.
      //
      // Getting this wrong is silent: every corner lookup would miss, the
      // renormalized gather would return "absent" for all eight, and GI would go
      // uniformly dark with a perfectly healthy probe population behind it.
      const cellShift = worldKeysEnabled()
        ? latticeOriginCell(anchor, s).toVar()
        : null;
      const baseCell = ivec3(int(cell0.x), int(cell0.y), int(cell0.z)).toVar();
      if (cellShift) baseCell.assign(baseCell.add(cellShift));

      const acc = vec3(0).toVar();
      const wsum = float(0).toVar();
      for (let k = 0; k < 8; k++) {
        const [dx, dy, dz] = CORNERS[k];
        const weight = (dx ? t.x : float(1).sub(t.x))
          .mul(dy ? t.y : float(1).sub(t.y))
          .mul(dz ? t.z : float(1).sub(t.z))
          .toVar();
        // ── §13.7d: THE PROBE MUST BE ON THIS SURFACE'S SIDE ────────────────
        //
        // The trilinear weight is a function of POSITION ONLY, so until this
        // line a probe sitting on the far side of the surface being shaded
        // contributed exactly as much as one in front of it. On thin geometry
        // that is a direct leak: an awning's sunlit TOP and its shaded
        // UNDERSIDE share a cell (the live Bistro reports 373 of 636 meshes
        // thinner than two cells), so the underside gathered the top's probes
        // and came back bright — the user's "too bright in the areas under the
        // red covers", and, repeated across every thin surface in the scene,
        // the "flat, lacking contrast" that goes with it.
        //
        // The standard DDGI wrap weight: `((n·d) * 0.5 + 0.5)²`, smooth rather
        // than a hard cutoff, because a hard one puts a visible seam exactly
        // where the tangent plane cuts the cell. The floor keeps a fully
        // back-facing corner from making `wsum` collapse to zero — the
        // renormalization below then divides by what actually contributed, so
        // a surface with every probe behind it goes DARK rather than BLACK.
        if (normalWeight) {
          // §14 Q9c: ONE-SIDED over SIGNED PLANE DISTANCE — third form, and
          // the geometry says this one is lattice-silent. The DDGI direction
          // wrap modulated FRONT probes (grid DOTS); the one-sided DIRECTION
          // cosine fixed that but still varied with the pixel's LATERAL
          // offset to each behind-probe (cos = −b/√(b²+lat²)), which beats
          // at the lattice period as soft SQUARES — both were the same
          // mistake: weighting by a quantity that changes as the pixel
          // slides along its own flat wall. The signed plane distance
          // `(probe − P)·N` does not: in-plane motion leaves it untouched,
          // so on a flat wall every corner's weight is a constant and the
          // gather is pure (weighted) trilinear — no pattern, by
          // construction. Probes deeper than 0.35·spacing behind the
          // tangent plane fade to the 1e-3 floor (wsum stays alive; a
          // surface with every probe behind it goes DARK, not black).
          const pd = origin.add(cell0.add(vec3(dx, dy, dz)).mul(s)).sub(P).dot(N).toVar();
          const t = pd.div(s.mul(0.35)).add(1).clamp(0, 1).toVar();
          const oneSided = t.mul(t).mul(float(3).sub(t.mul(2))).toVar();
          const shaped = nwExp === 1 ? oneSided : oneSided.pow(float(nwExp));
          weight.mulAssign(shaped.max(1e-3));
        }
        // ── §15 U3: THE PROBE MUST SEE THE POINT ───────────────────────────
        //
        // Four samples along lifted-P → probe, each ONE occupancy-bit fetch:
        // a sample inside geometry (a wall's interior — conservative
        // voxelization bulges ~a voxel, so even a 10 cm partition holds a
        // sample) collapses the corner's weight. The hugging-ray false
        // positive is excluded by GEOMETRY, not by a threshold: the start is
        // lifted one voxel off the surface, so a sample skimming the own
        // wall sits in a FREE voxel. t stops at 0.85 so a probe hugging its
        // own surface is not convicted by its own voxel.
        //
        // The suppression is RELATIVE by construction: acc and wsum carry the
        // same factor, so a uniformly-suppressed point renormalizes back to
        // the blocked probes' mean (R1 — an absence is never a dark vote);
        // only the RATIO between visible and blocked corners moves, which is
        // exactly "the field answers from probes on this side of the wall".
        if (losArmed) {
          const probePos = origin.add(cell0.add(vec3(dx, dy, dz)).mul(s)).toVar();
          const seg = probePos.sub(losStart).toVar();
          const LOS_TS = [0.25, 0.45, 0.65, 0.85];
          const blocked = float(0).toVar();
          for (const tf of LOS_TS) {
            const x = losStart.add(seg.mul(tf));
            // Per-sample shoulder (LOS_OCC_LO), then the PATH shoulder over
            // their mean (LOS_PATH_LO) — see both in srcMath. Hand-rolled
            // smootherstep rather than importing `smoothstep`, matching the
            // plane weight twenty lines up.
            const t = float(losOccupied(x)).sub(LOS_OCC_LO)
              .div(LOS_OCC_HI - LOS_OCC_LO).clamp(0, 1).toVar();
            blocked.addAssign(t.mul(t).mul(float(3).sub(t.mul(2))));
          }
          const b = blocked.div(LOS_TS.length).sub(LOS_PATH_LO)
            .div(LOS_PATH_HI - LOS_PATH_LO).clamp(0, 1).toVar();
          const vis = float(1).sub(b.mul(b).mul(float(3).sub(b.mul(2)))).toVar();
          // ⭐ STRENGTH IS A LIVE UNIFORM (§12.89, 2026-08-24), so ONE boot can
          // sweep the guard at ONE pose on a converged field. `losArmed` is a
          // BUILD flag — it compiles the march in or out — so it could only
          // ever be A/B'd across boots, and this scene's boot-to-boot spread is
          // ~2×, which is wider than any effect worth measuring. At strength 0
          // the suppression is the identity and the arm is the unguarded
          // baseline WITH the march's cost still paid, which is the honest
          // control: it prices the guard and its effect separately.
          weight.mulAssign(mix(float(1), vis.max(1e-3), losStrengthU));
        }
        If(weight.greaterThan(0), () => {
          // `secondary` is 0: the multibounce cache is Phase 5's caller, not a
          // parameter here. Out-of-window cells pack to KEY_EMPTY and the WGSL
          // find answers "absent" for key 0 by its first line, so an
          // unrepresentable corner is a missing corner with no extra guard.
          const block = lookup(
            packProbeKey(int(lod), uint(0), baseCell.add(ivec3(dx, dy, dz))),
          ).toVar();
          If(block.notEqual(uint(SLOT_EMPTY)), () => {
            // ONE hardware-bilinear tap. rgb is `Σ w_tap·E` over the covered
            // taps and a is `Σ w_tap` over the same ones — see the header on
            // why both ride the accumulation instead of dividing here.
            const tap = tiles.sampleTileRGBA(block, S).toVar();
            acc.addAssign(tap.xyz.mul(weight));
            wsum.addAssign(tap.w.mul(weight));
            cornersHit.addAssign(uint(1));
            // The corner EXISTS (above) vs the corner VOTES (here) — see
            // GG_COVERED's header for why the difference is the whole
            // block-vs-thin-lattice question.
            If(tap.w.greaterThan(0), () => { cornersCovered.addAssign(uint(1)); });
          });
        });
      }
      // `wsum` is COVERAGE, not corner count. A shell whose every probe exists
      // and knows nothing about this direction has corners but no coverage, and
      // dividing by the corner weight would hand the pixel a black vote from a
      // probe that never claimed to know (the mirror makes the same
      // distinction, and it is the whole of R1).
      If(wsum.greaterThan(0), () => {
        out.addAssign(acc.div(wsum).mul(shellWeight));
        shellTotal.addAssign(shellWeight);
      });
    };

    shell(base, float(1).sub(blend));
    // The overlap band is the top 10% of each LOD's span, so most points take
    // this branch uniformly false and pay nothing. Guarded on the WEIGHT rather
    // than unconditionally, because the second shell is eight more hash lookups
    // and eight more taps.
    If(blend.greaterThan(0).and(base.add(1).lessThan(float(maxLods))), () => {
      shell(base.add(1), blend);
    });

    // A SHELL WITH NO PROBES MUST NOT DARKEN THE POINT — the shell that did
    // find some carries full weight. Same renormalize-don't-zero rule, one
    // level up from the corners.
    If(shellTotal.greaterThan(0), () => { out.assign(out.div(shellTotal)); });
    // `known` (2026-08-22, the black-rectangle fix): whether ANY coverage was
    // found. A point with none returns irradiance 0 — which is an ABSENCE,
    // not a measurement of darkness — and every consumer that renders it as
    // black is violating R1 at the display. The screen pass carries this in
    // the target's alpha so the temporal filter can hold history instead.
    return { irradiance: out, corners: cornersHit, covered: cornersCovered, known: shellTotal.greaterThan(0) };
  };

  // CLOSURE-ONLY, and the header's first section is the whole argument for it:
  // this module is a gather that HAPPENS to own a screen pass, not a screen
  // pass that exposes a gather. [J] wants the integral over a hit list, so it
  // takes the closure and stops here — no storage texture, no dispatch, and
  // (importantly) no `__giSrcTargetVersion` bump, which would make the
  // resolve's texture look re-created to a build that never asked for one.
  if (!readPixel) {
    return { gatherAt, width: 0, height: 0, dispose() {} };
  }

  // ── the screen pass ───────────────────────────────────────────────────────
  const target = new THREE.StorageTexture(width, height);
  target.type = THREE.HalfFloatType;
  target.name = "giSrcGather";
  target.version = (globalThis.__giSrcTargetVersion = (globalThis.__giSrcTargetVersion ?? 0) + 1);

  const stats = instancedArray(new Uint32Array(GG_WORDS), "uint").toAtomic();
  // §19 0.5b: a UNIFORM, not the JS number it was — `uint(widthU)` baked the
  // gather grid's width into the WGSL, so the pixel reconstruction was new
  // source at every viewport size. Same reasoning as giScreen's
  // `screenSizeUniforms`; the height never appears in this kernel, only in
  // the dispatch count, which `ComputeNode.count` already carries as a
  // uniform of its own.
  const widthU = uniform(width, "uint");

  const reset = Fn(() => {
    for (let w = 0; w < GG_WORDS; w++) {
      atomicStore(stats.element(uint(w)), uint(w === GG_MIN ? 0xffffffff : 0));
    }
  })().compute(1);

  const compute = Fn(() => {
    const i = instanceIndex.toVar();
    const coord = ivec2(i.mod(widthU).toInt(), i.div(widthU).toInt());
    const E = vec3(0).toVar();
    // Validity rides the ALPHA: 1 where the gather found coverage, 0 where it
    // found nothing (no probes, no known bins — the resolve and the temporal
    // filter must treat that as "unknown", never as "black"). Background
    // pixels stay 0 too, which nothing samples.
    const known = float(0).toVar();
    const px = readPixel(i);
    If(px.valid, () => {
      atomicAdd(stats.element(uint(GG_PIXELS)), uint(1));
      // The normal arrives ALREADY faced toward the camera (srcSystem's
      // `readPixel`) — the same vector the deposit filled these probes' bins
      // along, so the hemisphere this reads is the hemisphere that was filled.
      const g = gatherAt(px.position, px.normal);
      E.assign(g.irradiance);
      known.assign(select(g.known, float(1), float(0)));
      atomicAdd(stats.element(uint(GG_CORNERS)), g.corners);
      atomicAdd(stats.element(uint(GG_COVERED)), g.covered);
      If(g.corners.equal(uint(0)), () => {
        atomicAdd(stats.element(uint(GG_EMPTY)), uint(1));
      });
      const lum = E.x.mul(0.2126).add(E.y.mul(0.7152)).add(E.z.mul(0.0722)).toVar();
      If(lum.greaterThan(0), () => {
        const fx = lum.mul(LUM_FIXED).toUint().toVar();
        atomicAdd(stats.element(uint(GG_LIT)), uint(1));
        atomicAdd(stats.element(uint(GG_SUM)), fx);
        atomicMin(stats.element(uint(GG_MIN)), fx);
        atomicMax(stats.element(uint(GG_MAX)), fx);
      });
    });
    textureStore(target, coord, vec4(E, known));
  })().compute(width * height);

  return {
    /** The shared integral. `createGiResolve` inlines this for reflection hits. */
    gatherAt,
    reset,
    compute,
    target,
    stats,
    /**
     * §19 Stage 0.2b — the GPU buffers that die with this bundle. Published so
     * a swap site can tell "this generation's" from "the survivor's" (the KEEP
     * half of `#sweepOrphanedComputes`' diff) and so a teardown destroys them:
     * three's `Bindings._destroyBindings` has no storage branch, so evicting
     * the compute nodes returns the bind groups and leaves every byte.
     */
    get storageAttributes() {
      return [stats].map((n) => n?.value).filter(Boolean);
    },
    /**
     * §13.9's C0↔C1 weight dial, live. GISystem pushes `__giGatherSmoothLive`
     * into it each frame when that global is set, so a probe can render both
     * arms in ONE boot at ONE pose — the within-boot dial the plan's method
     * rule asks for on this scene. Unset, it holds the shared reader's value.
     */
    smoothWeights: smoothU,
    /** §12.88's normal bias, live — `__giGatherNormalBiasLive` pins it. */
    normalBias: biasU,
    /** §12.89's LOS suppression strength, live — `__giGatherLosLive` pins it. */
    losStrength: losStrengthU,
    /** Whether the LOS march was compiled in at all (a BUILD decision). */
    losArmed,
    /** The resolve's primary-diffuse input: one texture load, no storage bindings. */
    node: texture(target),
    width,
    height,
    /**
     * §19 0.5b — a resize as a uniform write. NOTE the srcProbes system as a
     * whole still re-mints on resize (its per-pixel BUFFERS change length),
     * so this exists so the re-minted node's WGSL is the SAME TEXT as the
     * retired one's: three's node cache and the driver's pipeline cache both
     * hit, and the resize stops paying a compile for this kernel.
     */
    setSize(w, h) {
      widthU.value = w;
      target.setSize(w, h);
      compute.count = w * h;
      return true;
    },

    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) return { dispatched: false, pixels: 0, lit: 0 };
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      const lit = v[GG_LIT] >>> 0;
      const pixels = v[GG_PIXELS] >>> 0;
      const rawMin = v[GG_MIN] >>> 0;
      const min = rawMin === 0xffffffff ? 0 : rawMin / LUM_FIXED;
      const max = (v[GG_MAX] >>> 0) / LUM_FIXED;
      return {
        dispatched: true,
        pixels,
        lit,
        // Pixels that found no probe with coverage anywhere in their stencil.
        // Distinct from "lit == 0": this one is about the POPULATION, and it is
        // the number that separates "GI is dark here" from "GI has nothing here".
        empty: v[GG_EMPTY] >>> 0,
        // Mean contributing corners per pixel, out of 8 (or 16 across the
        // overlap band). Below ~4 means the c0 population is thinner than the
        // trilinear stencil wants and the renormalization is carrying the
        // result — which is legal, and worth seeing.
        meanCorners: pixels > 0 ? (v[GG_CORNERS] >>> 0) / pixels : 0,
        // The corners that actually VOTED. `meanCorners` counts corners with a
        // block; this counts corners whose tile knew this direction. A large
        // gap between the two means the lattice is present but SILENT, and the
        // renormalisation is handing whole cells the answer of one probe —
        // which is a flat plateau the width of a cell. See GG_COVERED.
        meanCovered: pixels > 0 ? (v[GG_COVERED] >>> 0) / pixels : 0,
        meanLum: lit > 0 ? (v[GG_SUM] >>> 0) / lit / LUM_FIXED : 0,
        minLum: min,
        maxLum: max,
        // A gather with no interpolation is FLAT across a probe cell; a smooth
        // one is not. Contrast alone cannot tell them apart — that is what the
        // gate's gradient arm is for — but a zero here means no variation at
        // all, which is the one reading that is unambiguous.
        contrast: max > 0 ? 1 - min / max : 0,
      };
    },

    dispose() {
      stats?.value?.dispose?.();
      target.dispose?.();
    },
  };
}

/** The per-frame gather line, for the telemetry log. */
export function formatSrcGather(g) {
  if (!g?.dispatched) return "";
  return `gather ${g.lit}/${g.pixels} lit (${g.meanCorners.toFixed(1)} corners, ` +
    `${(g.meanCovered ?? 0).toFixed(1)} COVERED` +
    (g.empty ? `, ${g.empty} EMPTY` : "") +
    `), E ${g.minLum.toFixed(3)}..${g.maxLum.toFixed(3)} mean ${g.meanLum.toFixed(3)}`;
}

/**
 * THE GLOSSY GATHER (§12.71b v2) — the diffuse pass's integral, fed the
 * REFLECTION vector, at half the gather's resolution.
 *
 * §12.71b established that `sampleTileRGBA(block, dir)` along the reflected
 * ray IS the cosine-lobe-blurred environment term giLight's specular slot
 * wants — and then shipped opt-in, because its first form inlined the lookup
 * into the resolve at RESOLVE res with no temporal pass behind it: raw
 * single-bin probe noise on every glossy pixel ("flickering white blobs on
 * the metallic embroidery"). This pass is the affordable form of the same
 * integral:
 *
 *   · its OWN half-res grid — a glossy lobe is already an angular blur, so a
 *     2× spatial carrier is far below what the signal can represent (the same
 *     argument the diffuse gather's SRC_GATHER_SCALE note makes, without the
 *     silhouette objection: giLight blends the exact-BVH hit over this on
 *     mirror pixels, which is where silhouettes matter);
 *   · a LUMINANCE CAP at the write (`__giGlossyCap` pins the uniform) — the
 *     firefly clamp that keeps one hot bin from becoming a white blob the
 *     temporal filter would then smear;
 *   · TWO outputs, `target` + `raw`, the §12.65 fail-safe topology verbatim:
 *     GISystem runs the radiance temporal filter raw → target, and a filter
 *     whose pipeline never lands degrades to this pass's un-filtered write
 *     instead of a black specular term.
 *
 * The de-duplication worry from §12.71b's ledger is answered by R5, not by
 * code here: tree/NEE emitters' FIELD emission is zeroed at bake time, so the
 * bins this reads carry lit surfaces, not the emitter disks the resolve's
 * emitter-direct term already delivers.
 *
 * The hist pair lives here (not in giScreen's targets) because it must match
 * THIS pass's grid and lifetime — a srcProbes rebuild replaces the whole
 * chain, and specular history is cheap to re-earn.
 */
export function createSrcGlossyGather(gatherAt, { readPixel, width, height, camera, cap = 6 }) {
  const mkTex = (name, type) => {
    const t = new THREE.StorageTexture(width, height);
    t.type = type;
    t.name = name;
    t.version = (globalThis.__giSrcTargetVersion = (globalThis.__giSrcTargetVersion ?? 0) + 1);
    return t;
  };
  const target = mkTex("giSrcGlossy", THREE.HalfFloatType);
  const raw = mkTex("giSrcGlossyRaw", THREE.HalfFloatType);
  const hist = mkTex("giSrcGlossyHist", THREE.HalfFloatType);
  const histPos = mkTex("giSrcGlossyHistPos", THREE.FloatType);
  const capU = uniform(cap);
  // §19 0.5b — see the note on the diffuse gather's `widthU` above.
  const widthU = uniform(width, "uint");

  const compute = Fn(() => {
    const i = instanceIndex.toVar();
    const coord = ivec2(i.mod(widthU).toInt(), i.div(widthU).toInt());
    const E = vec3(0).toVar();
    const px = readPixel(i);
    If(px.valid, () => {
      const P = vec3(px.position).toVar();
      // Already camera-faced by readPixel — the same hemisphere the bins
      // were filled along.
      const N = vec3(px.normal).toVar();
      const R = reflect(P.sub(vec3(camera)).normalize(), N).toVar();
      // ÷π: cosine-hemisphere irradiance → the outgoing-radiance scale the
      // specular slot multiplies by F (§12.71b's convention, unchanged).
      E.assign(vec3(gatherAt(P, N, R).irradiance).mul(1 / Math.PI));
      // The firefly clamp — soft luminance cap, hue-preserving.
      const lum = E.x.mul(0.2126).add(E.y.mul(0.7152)).add(E.z.mul(0.0722)).toVar();
      E.mulAssign(float(capU).div(lum.max(capU)));
    });
    textureStore(target, coord, vec4(E, 1));
    textureStore(raw, coord, vec4(E, 1));
  })().compute(width * height);

  return {
    compute,
    target,
    raw,
    hist,
    histPos,
    /** The resolve's glossy input: one texture sample, no storage bindings. */
    node: texture(target),
    cap: capU,
    width,
    height,
    /** §19 0.5b — see the diffuse gather's `setSize`. */
    setSize(w, h) {
      widthU.value = w;
      for (const t of [target, raw, hist, histPos]) t.setSize(w, h);
      compute.count = w * h;
      return true;
    },
    dispose() {
      target.dispose?.();
      raw.dispose?.();
      hist.dispose?.();
      histPos.dispose?.();
    },
  };
}
