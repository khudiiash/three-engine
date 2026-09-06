// SPLIT RADIANCE CASCADES — [E'] hit shading. The GPU twin of `srcRef.js`'s
// `makeHitShader`, line for line.
//
//     L_hit = emissive(H) + ρ(H)/π · Σ_lights direct(H)
//                         + ρ_loop(H)/π · E_secondary(H)
//
// Plan §4.4, and the executable spec is §12.26 — a CPU mirror whose 124 checks
// ran the whole of this before a line of it existed on the GPU. Every constant,
// every ordering and every early-out below is that mirror's, and where this file
// says a thing is measured, the measurement is §12.26's and not a guess.
//
// ══ THE THINGS THAT ARE ABSENT, AND WHY EACH ABSENCE IS STRUCTURAL ══════════
//
// **MOVERS ARE NOT A BRANCH.** §4.4 asks for "header mean albedo/emissive
// Lambert shading" for an exact dynamic hit, which is the same expression with
// the surface read from somewhere else — so provenance lives entirely in
// `surfaceAt` and this file never asks whether a hit moved. A mover-shaped `if`
// here is the shape of the bug where a moving crate lights the room differently
// from the identical static one beside it, and that bug is invisible until
// somebody picks the crate up.
//
// **THE SKY IS NOT HERE.** A ray that escapes composites the sky in
// `mergeCascades`, at the top cascade, exactly once. Adding it at the hit would
// double it for every ray that both misses and merges.
//
// **NO LOOP OVER LIGHTS WITH A BREAK.** The emitter pick is a running-sum
// select over an unrolled `MAX_EMITTERS`, the same divergence-free form
// `splitCascade` uses in the deposit. The one expensive thing — the shadow ray —
// is issued ONCE, after the pick, which is the entire point of NEE.
//
// ══ THE FACE-FORWARD FLIP IS HERE, AND THAT CONTRADICTS §12.17 ON PURPOSE ═══
//
// §12.17 concluded that the face-forward flip belongs at the engine boundary
// (`readPixel`) and never in a kernel, because a flip on one side of the
// CPU/GPU boundary made each side fill the half of the bin sphere the other
// never read. **The hit normal is not that normal.** It is produced by the trace
// inside this same kernel, one line earlier, and a record normal is sign-aligned
// to the occupancy gradient — it knows nothing about which side a particular ray
// approached from. Unflipped, every hit on the FAR face of a wall returns
// cos < 0 for every light and shades black: half the geometry in a closed room,
// dark. §12.26.4 gates it two ways — the flip only ever changes the SIGN, and a
// scene whose record normals are all reported the other way round shades
// bit-identically.
//
// ══ WHAT IS STILL STUBBED, NAMED SO IT CANNOT BE MISREAD AS FINISHED ════════
//
// · `surfaceAt` for STATIC hits does not exist yet. §12.9 deleted the coarse
//   surface-attribution grid (`cellAttr`/`slotAtlas`), and `SURFACE_MATERIAL_ID_WORD`
//   was long since repurposed as the complex-cell triangle range, so there is no
//   path on the GPU from a static hit to its material. Until `srcSurface.js`
//   lands, statics shade at `defaultAlbedo` with zero emission — a grey-box
//   bounce, correct in shape and wrong in colour, and `STAT_UNATTRIBUTED` counts
//   every hit it happened to. Movers already have theirs
//   (`moverSurfaceAt` → header words 34..39).
// · THE SECONDARY TERM IS NOT EVALUATED HERE AND MUST NOT BE. The formula above
//   is still the model — `E` gains the cache's irradiance and ρ/π multiplies
//   the sum — but the `E_secondary` half is computed by `srcSecondary.js` in a
//   PASS OF ITS OWN and added into the same bin. Inlining it cost 48 seconds of
//   pipeline compile (§12.39): `gatherAt` is 16 hash-find loops and 16 filtered
//   taps, and this shader used to be instantiated inside the deposit's ray loop,
//   which was the fattest kernel in the module.
//
// ══ THE FILE IS TWO HALVES NOW, AND THEY COMPILE IN DIFFERENT KERNELS ═══════
//
// §12.53. `createSrcHitShader` is still the whole expression and still the
// thing `test:gi-src-shade` gates against `srcRef.js` — but it is now a
// COMPOSITION of two factories that the engine builds separately:
//
//   · `createSrcHitAttribution` — surfaceAt, the face-forward flip and physical
//     first-bounce albedo. Cheap, and it needs the trace's hit record, so it
//     stays in [E]. R4's loop-only ceiling is applied in [J].
//   · `createSrcHitLighting` — the visibility marcher, the four rolled light
//     slots, the NEE emitter set and the analytic shapes. Expensive to COMPILE
//     (the marcher is ~1.2 s of shader compile per call site and this half has
//     two of them), and it needs nothing from the trace but P, n̂, ρ, Le and the
//     ray index — five values that fit in a hit-list entry. So it moves to [J].
//
// That is the whole of §12.49's named follow-on: the deposit was 179 kB and one
// pipeline of it measured 49-56 s of a cold boot, and §13.17 says two ~75 kB
// kernels compiling in parallel beat one monster by MORE than the byte ratio.
// The estimator is untouched — the same nodes are emitted in two kernels;
// [J] uses physical ρ for direct light and derives ρ_loop for feedback there.
// · `importance` defaults to the exact contribution. `lightTree.js` is unwired;
//   when it lands it supplies a bounds-based ranking, and §12.26.5 prices what
//   that can cost at **3.00× the standard error** — 9× the samples for equal
//   noise. The parameter exists so that gets measured rather than asserted away.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.4, §7 Phase 5, §12.26.

import { If, Loop, float, int, ivec2, mix, select, step, uint, vec3, vec4 } from "three/tsl";
import { MAX_LOOP_ALBEDO } from "./srcConfig.js";
import { hashKey } from "./srcMathTsl.js";
import { emitterSlotFactor, emitterSurfaceT } from "./giLight.js";
import { waterCausticGainNode } from "../../engine/vfx/waterCaustics.js";

/**
 * How far below the mean importance a contributing emitter may be ranked before
 * NEE floors its pick probability. Twin of `srcRef.js`'s constant of the same
 * name; see `neeIrradiance` for why it is a FRACTION and not an epsilon.
 */
export const IMPORTANCE_FLOOR_FRACTION = 1 / 1024;

/** Rec. 709 luminance — the scalar an importance heuristic ranks on. */
const LUMA = [0.2126, 0.7152, 0.0722];

/**
 * Deterministic [0, 1) from a ray index. `srcMathTsl.js`'s `hashKey` IS
 * `srcRef.js`'s `hashUnitFloat` before the divide — same PCG finalizer, same
 * constants, and `Math.imul` wraps mod 2^32 exactly as a WGSL u32 multiply does
 * — so this needs no second hash and cannot drift from the mirror.
 *
 * ⚠ THE DIVIDE IS THE ONE PLACE THE TWO SIDES CAN DISAGREE. A u32 above 2^24
 * rounds on its way into an f32, so `u` differs from the mirror's f64 by up to
 * ~2e-7 relative. That flips the emitter picked only when `u` lands within 2e-7
 * of a CDF boundary; the gate therefore compares the PICK STATISTICS rather than
 * asserting bit-equality, and asserts bit-equality of the hash itself only below
 * 2^24 where the conversion is exact.
 */
function hashUnit(n) {
  return float(hashKey(n)).div(4294967296);
}

/**
 * The ray arrives at the surface travelling along `dir`, so the outward normal
 * is the one OPPOSING it. Sign flip only — never a renormalize, never a
 * substitution (§12.26.4).
 */
export function faceForward(normal, dir) {
  const n = vec3(normal).toVar();
  return select(n.dot(vec3(dir)).greaterThan(0), n.negate(), n).toVar();
}

/**
 * R4's albedo ceiling, and it SCALES rather than clamping per channel.
 *
 * The secondary cache makes the bounce a temporal fixed-point iteration:
 * frame k's hit shading reads frame k−1's irradiance. `bakeProbeIrradiance`
 * returns exactly π·L̄ for uniform radiance, so one turn of the loop maps
 * `L → ρ/π · (π·L) = ρ·L` and the iteration's gain is the spectral radius of ρ,
 * i.e. its LARGEST channel. §12.26.2 measured the tail increment ratio at
 * **0.9000 to four figures** against a `MAX_LOOP_ALBEDO` of 0.9, and the
 * uncapped canary at 1.0000 with no convergence at all — the strongest form R4
 * can take, because it says the clamp is not merely present but is the thing
 * setting the rate.
 *
 * Scaling and not `min(ρ, ceiling)` per channel because both forms satisfy the
 * bound and only one keeps the COLOUR, and colour bleed is the entire product.
 * Measured: a per-channel clip shifts a warm white's chromaticity by 1.75e-2;
 * scaling by `ceiling/peak` shifts it by 5.6e-17 and touches nothing at or below
 * the ceiling.
 */
export function clampLoopAlbedo(albedo, ceiling = MAX_LOOP_ALBEDO) {
  const a = vec3(albedo).max(vec3(0)).toVar();
  const peak = a.x.max(a.y).max(a.z).toVar();
  // `peak > ceiling` implies `peak > 0`, so the guard on the divide only exists
  // to keep the untaken side of the select finite.
  const k = select(peak.greaterThan(float(ceiling)), float(ceiling).div(peak.max(1e-6)), float(1));
  return { albedo: a.mul(k).toVar(), clamped: peak.greaterThan(float(ceiling)) };
}

/**
 * One analytic emitter slot, evaluated at a shading point: its UNSHADOWED
 * closed-form irradiance, the direction to it, and the distance at which a
 * shadow ray should stop.
 *
 * This is `srcRef.js`'s `emitter.irradianceAt(P, n̂)` and `emitter.sampleTarget(P)`
 * in one call, expressed through `giLight.js`'s existing shape family rather
 * than a second derivation. That reuse is R5's precondition, not a convenience:
 * the screen chain's analytic emitter direct evaluates `emitterSlotFactor` too,
 * so the two representations of one light are the SAME closed form and can
 * agree. §12.26.7 measured the handoff at **1.45% worst case** over three
 * receivers against a brute-force MC arbiter — approximate by construction,
 * because an analytic form factor times a single binary visibility cannot
 * resolve a partially-occluded emitter, and approximate in exactly the way the
 * screen chain already is.
 *
 * `maxT` stops at the emitter's own SURFACE (slab entry for boxes — a bounding
 * sphere stopped the ray well short of an elongated lamp's face and exempted
 * anything hugging it from occluding), less a margin that R2 derives from the
 * occupancy voxel.
 *
 * **`emitterCutoff` is deliberately NOT applied.** In the screen chain it exists
 * so that light too dim to TRACE is also too dim to SHOW — the old gate skipped
 * the march but kept the contribution, and dim emitter light then crossed walls
 * unshadowed and read clearly in dark adjacent rooms. This path always traces,
 * so the gate has nothing to protect, and the uncut closed form is exactly the
 * quantity §12.26.7 calibrated the 1.45% handoff against.
 */
function emitterTermsAt(slot, P, n, margin) {
  const toE = vec3(slot.center).sub(P).toVar();
  const dist = toE.length().max(1e-3).toVar();
  const dirTo = toE.div(dist).toVar();
  const cosTheta = dirTo.dot(n).toVar();
  const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
  // A slot with no radius is an empty seat, not a point light.
  const active = step(0.001, float(slot.radius));
  const E = vec3(slot.color).mul(emitterSlotFactor(slot, P, n, cosTheta, sinR)).mul(active).toVar();
  const maxT = emitterSurfaceT(slot, P, dirTo, dist).sub(margin).max(0).toVar();
  return { E, dirTo, maxT, luma: E.dot(vec3(...LUMA)).max(0).toVar() };
}

/**
 * One `giLight.js` LIGHT SLOT's irradiance at a hit, plus what a shadow ray
 * toward it needs. The engine's punctual lights — `analyticDirectAt`'s subject,
 * up to `MAX_GI_LIGHTS` of them, point and directional in one array.
 *
 * `vector` holds the world POSITION for a point light and the normalized
 * direction TOWARD the light for a directional one; `kind` selects between them
 * (the same convention `cascadeGather` and `analyticDirectAt` use, and reusing
 * it rather than re-deriving is what keeps SRC's hits agreeing with the screen
 * chain's pixels).
 *
 * ⚠ **THE COSINE IS CLAMPED HERE, NOT ABSOLUTE.** `analyticDirectAt` takes
 * `dot(dirTo, N).abs()` because it shades a FIELD CELL, which has no definite
 * side — a cell straddling a wall must light from either. A hit has a side: the
 * normal was face-forwarded against the ray one line earlier (§12.26.4), so
 * `abs()` here would light the back of every wall from a lamp in front of it and
 * do it smoothly enough to read as a leak rather than a sign error.
 *
 * The shadow ray is what SRC can do and the screen chain structurally cannot:
 * three's shadow map is view-frustum bound, and half of SRC's hits are behind
 * the camera or off screen entirely.
 */
function lightTermsAt(slot, P, n, margin, maxRay) {
  const isDir = float(slot.kind).toVar();
  const rel = vec3(slot.vector).sub(P).toVar();
  const dist = rel.length().max(1e-4).toVar();
  const dirTo = mix(rel.div(dist), vec3(slot.vector), isDir).toVar();
  // Inverse-square for a point light, none for a directional. `max(1)` is
  // `analyticDirectAt`'s own guard against a receiver inside the source.
  const atten = mix(float(1).div(dist.mul(dist).max(1)), float(1), isDir).toVar();
  if (slot.range) {
    // three's PointLight `distance` cutoff (0 = infinite). GI must die exactly
    // where the renderer's own direct light does, or the mismatch reads as light
    // being "cut" at a circle.
    const range = float(slot.range);
    const ratio = dist.div(range.max(1e-4)).clamp(0, 1);
    const r2 = ratio.mul(ratio);
    const win = r2.mul(r2).oneMinus().clamp(0, 1);
    atten.mulAssign(mix(float(1), win.mul(win), step(1e-3, range).mul(isDir.oneMinus())));
  }
  const cos = dirTo.dot(n).max(0).toVar();
  const active = float(slot.active ?? 1);
  return {
    E: vec3(slot.color).mul(atten).mul(cos).mul(active).toVar(),
    dirTo,
    cos,
    // A UNIFORM, not a build-time fact (R11 — adding a light must never
    // recompile). The water caustic lens is a property of a DISTANT source
    // refracting through a surface above the hit, so only a directional slot
    // may take it, and which slot that is can change without a rebuild.
    isDir,
    // A directional source has no distance, so its shadow ray runs the whole
    // medium. `kind` is a UNIFORM, so this cannot be a build-time choice between
    // a number and `null` — it has to be a node either way, and the volume
    // diagonal is the finite stand-in for infinity that WGSL can actually hold.
    maxT: mix(dist.sub(margin).max(0), float(maxRay), isDir).toVar(),
  };
}

/**
 * NEE over the emitter set: rank by importance, pick one, ONE shadow ray,
 * divide by the pick probability.
 *
 * ══ THE IMPORTANCE IS THE CONTRIBUTION, WHICH MAKES ONE SAMPLE EXACT ════════
 *
 * With `p_i ∝ luminance(E_i)`, `E_i/p_i` is the SUM for whichever i is drawn:
 * one sample is not an unbiased estimate of the total, it **is** the total, to
 * 2.28e-16, for every ray index. All remaining variance is visibility.
 *
 * ⚠ **AND IT IS EXACT IN LUMINANCE, NOT PER CHANNEL.** The pdf is one scalar and
 * the signal has three components, so a draw that is exact in the ranked
 * quantity redistributes the other two: a red emitter drawn in place of a blue
 * one of equal luminance returns the right amount of light in the wrong hue.
 * §12.26.5 measured the spread over 4,000 draws at **740% per channel against
 * 2.28e-16 in luminance**, with a grey-emitter control collapsing to 1.14e-16.
 * This will arrive on screen as coloured noise nobody predicted. It is a
 * property of every importance-sampled NEE, not a bug in the tree, and the fix
 * if it ever matters is to rank per channel or spend samples. **Compare
 * estimators in the quantity they estimate** — a per-channel standard error
 * reported 1.17× for a change actually worth 3.00×.
 *
 * ══ THE FLOOR IS A DIAGNOSIS, NOT A REPAIR ═════════════════════════════════
 *
 * R1 in its sampling costume: an emitter with a nonzero contribution and a zero
 * pick probability is energy that vanishes with nothing to attribute it to. The
 * mirror's first version floored the weight at a fixed `1e-12` — which trades a
 * lost light for a **firefly**, because the estimator divides by the pdf, and
 * "fireflies are impossible by construction here" is a property this module
 * relies on.
 *
 * So the floor is a FRACTION of the mean importance among CONTRIBUTORS —
 * scale-invariant, because a light tree's importance is in units of its own and
 * is not comparable to an irradiance — which bounds the worst single-sample
 * weight at `contributors / floorFraction` times the mean. It binds only when an
 * importance function is wrong, so the exact-pdf case is untouched and the
 * zero-variance property survives. Measured on a zero-ranked VISIBLE emitter
 * over 200,000 draws: energy survives (2.08% off, inside its own 3σ), worst
 * single-sample weight 3577× the mean against the 4096 analytic bound, standard
 * error **37×** the correct ranking's. The floor keeps the energy, bounds the
 * firefly, and hands back the variance; the COUNTER is what says a ranking is
 * broken.
 *
 * ══ THE DRAWS ARE STRATIFIED ═══════════════════════════════════════════════
 *
 * `u = (s + hash)/S`, one draw per stratum. 1 → 4 samples cuts the standard
 * error **2.61×** where independent draws would give 2.00×. Asserting only "the
 * mean is still right" would have passed on a loop that draws the same light S
 * times and divides by S.
 */
function neeIrradiance(slots, P, n, rayIndex, {
  visibility,
  margin,
  samples = 1,
  importance = null,
  floorFraction = IMPORTANCE_FLOOR_FRACTION,
  count = null,
}) {
  const N = slots.length;
  const terms = slots.map((slot) => emitterTermsAt(slot, P, n, margin));

  // ── weights, and who can contribute at all ──────────────────────────────
  const contributes = terms.map((t) => t.luma.greaterThan(0).toVar());
  const weights = terms.map((t, i) => {
    const w = importance ? float(importance(slots[i], P, n)).max(0) : t.luma;
    return select(contributes[i], w, float(0)).toVar();
  });
  const contributors = float(0).toVar();
  for (const c of contributes) contributors.addAssign(select(c, float(1), float(0)));

  const out = vec3(0).toVar();
  If(contributors.greaterThan(0), () => {
    // The floor, relative to the importance's OWN scale.
    const sum = float(0).toVar();
    for (const w of weights) sum.addAssign(w);
    const floorW = select(sum.greaterThan(0), float(floorFraction).mul(sum).div(contributors), float(1)).toVar();
    const total = float(0).toVar();
    for (let i = 0; i < N; i++) {
      const bind = contributes[i].and(weights[i].lessThan(floorW)).toVar();
      weights[i].assign(select(bind, floorW, weights[i]));
      if (count) count.importanceFloored(select(bind, 1, 0));
      total.addAssign(weights[i]);
    }

    If(total.greaterThan(0), () => {
      for (let s = 0; s < samples; s++) {
        // One stratified draw per sample, offset by the ray index so two rays at
        // the same point do not pick the same light. A pure function of
        // (rayIndex, s) — no state to carry, which is the same property that
        // makes the deposit gate's synthetic trace bit-exact across the boundary.
        const u = float(s)
          .add(hashUnit(uint(rayIndex).mul(uint(0x9e37)).add(uint(s))))
          .div(samples)
          .toVar();

        // The pick, as a running sum with no break. Starts at the LAST index
        // rather than 0: the mirror falls back to the last emitter when floating
        // point leaves the CDF a hair under 1, and starting at 0 would silently
        // hand that case to a different light.
        const picked = int(N - 1).toVar();
        const acc = float(0).toVar();
        // 0 or 1 and never anything between, so the `< 0.5` test is exact. A
        // `== 0` on a float would be too, here — it is spelled this way because
        // a later edit that made `found` a running count would break silently.
        const found = float(0).toVar();
        for (let i = 0; i < N; i++) {
          acc.addAssign(weights[i].div(total));
          const take = found.lessThan(0.5).and(u.lessThan(acc)).toVar();
          picked.assign(select(take, int(i), picked));
          found.assign(select(take, float(1), found));
        }

        // Gather the picked emitter's terms. Four predicated copies, so the one
        // expensive thing below — the shadow ray — is issued once and not once
        // per emitter.
        const E = vec3(0).toVar();
        const w = float(0).toVar();
        const dirTo = vec3(0, 1, 0).toVar();
        const maxT = float(0).toVar();
        for (let i = 0; i < N; i++) {
          If(picked.equal(int(i)), () => {
            E.assign(terms[i].E);
            w.assign(weights[i]);
            dirTo.assign(terms[i].dirTo);
            maxT.assign(terms[i].maxT);
          });
        }

        If(w.greaterThan(0), () => {
          const v = visibility ? float(visibility(P, n, dirTo, maxT)).toVar() : float(1).toVar();
          // ONLY WHEN A RAY WAS ACTUALLY CAST. With `visibility` null the
          // `__giSrcNoShadow` arm reported a quarter of a million shadow rays it
          // never fired — the counter measured OPPORTUNITIES. Same defect class
          // as an eye check that prints `NO SCREENSHOT`: an instrument that
          // reports work it did not do is worse than no instrument, because the
          // number is used to rule causes OUT.
          if (count && visibility) count.shadowRays(1);
          // k = v / (pdf · S), with pdf = w/total.
          out.addAssign(E.mul(v.mul(total).div(w.mul(samples))));
        });
      }
    });
  });
  return out;
}

/**
 * THE ATTRIBUTION HALF — everything that needs the TRACE's hit record, and
 * nothing that needs a light. Runs in [E].
 *
 * Returns `attribute(hit, dir) → { P, n, rho, emissive, emitter }`:
 *
 *   · `P`        the shading point (the EXACT, unlifted hit)
 *   · `n`        the face-forwarded normal (see the header — the flip is here,
 *                on purpose, and §12.26.4 gates it two ways)
 *   · `rho`      physical 0..1 first-bounce albedo. [J] derives a 0.9-limited
 *                copy only for gathered feedback, so direct sun is not
 *                attenuated while the fixed point remains contractive.
 *   · `emissive` the raw emission. R5's zeroing is NOT applied here — it is a
 *                function of the NEE set, which is the lighting half's business
 *                (`createSrcHitLighting` takes the flag and does it there).
 *   · `emitter`  the R5 flag, `null` when the surface record has none.
 *
 * The three counters it owns are the three that describe a SURFACE rather than
 * a light: `shaded`, `unattributed` and `albedoClamped`. They stay on the same
 * dispatch that already counted them, so `unattributedRate` keeps its
 * historical denominator — every ray the deposit attributes, hit or miss —
 * across the §12.53 split. (Misses attribute garbage and always did; the
 * radiance is discarded by `own == N`, and only the DENOMINATOR sees them.)
 *
 * @param {object} options
 * @param {(hit, dir) => {albedo, emissive, emitter, valid}} options.surfaceAt
 *   THE ONE PLACE PROVENANCE LIVES. `emitter` is the index into `emitters` when
 *   the surface hit IS one of the NEE lights and < 0 otherwise. **That flag is
 *   R5's entire mechanism.** An emitter that is both sampled by NEE and emissive
 *   on contact delivers its energy twice, and the failure is invisible to every
 *   check that does not compare the two paths against each other: the image is
 *   simply brighter around lights, which reads as an artistic choice. §12.26.7
 *   measured it at **2.60×** on mean floor irradiance — and found that a single
 *   gather point could NOT see it (one floor point read 1.00×, because the ~57
 *   rays landing on the emitter spread thinly across the floor's probes and that
 *   point's eight held none). An energy claim wants an energy statistic.
 * @param {object} [options.count]  per-statistic incrementers; see
 *   `srcDeposit.js`'s STAT words.
 */
export function createSrcHitAttribution({
  surfaceAt,
  maxLoopAlbedo = MAX_LOOP_ALBEDO,
  count = null,
} = {}) {
  if (typeof surfaceAt !== "function") {
    throw new Error("createSrcHitAttribution: surfaceAt is required — it is where mover/static provenance lives");
  }
  return (hit, dir) => {
    const s = surfaceAt(hit, dir);
    const P = vec3(s.position ?? hit.exactPosition ?? hit.position).toVar();
    const n = faceForward(s.normal ?? hit.normal, dir);
    if (count) {
      count.shaded(1);
      if (s.valid != null) count.unattributed(select(float(s.valid).greaterThan(0.5), 0, 1));
    }
    // Physical first-bounce reflectance is [0,1]. R4's stricter 0.9 ceiling
    // exists only to make temporal feedback contract; applying it here also
    // attenuated direct sun/lamp light before it entered that loop.
    const rho = vec3(s.albedo).clamp(0, 1).toVar();
    const rhoLoop = clampLoopAlbedo(rho, maxLoopAlbedo);
    if (count) count.albedoClamped(select(rhoLoop.clamped, 1, 0));
    return {
      P,
      n,
      rho,
      emissive: vec3(s.emissive).toVar(),
      emitter: s.emitter != null ? float(s.emitter).toVar() : null,
    };
  };
}

/**
 * THE LIGHTING HALF — the sun, the punctual slots, the NEE emitter set, the
 * visibility marcher and R5's emission handoff. Runs in [J] since §12.53.
 *
 * Returns `light(P, n, rho, emissive, emitter, rayIndex) → vec3`, i.e.
 *
 *     Le' + ρ/π · Σ_lights direct(P, n̂)
 *
 * — the DIRECT half of §4.4's expression. The `E_secondary` half is added by
 * `srcSecondary.js` around this call, as `ρ/π · E_atlas`, so that the two terms
 * saturate against `Lmax` TOGETHER (one clamp, the inline form; §12.49's split
 * clamp is retired by the move, because both terms are now computed in one
 * kernel and there is nothing left to split).
 *
 * ⚠ **THIS IS THE EXPENSIVE HALF TO COMPILE, NOT TO RUN.** `visibility` is a
 * two-nested-loop BVH8 descent and it is instantiated at TWO call sites here
 * (the rolled light loop and NEE's single ray) — §13.14.5 measured ~1.2 s of
 * shader compile per call site. That is why it lives in a 64 kB kernel of its
 * own instead of inside the deposit's ray loop.
 *
 * @param {{direction: Node, irradiance: Node}} [options.sun]  a single
 *   directional source — `direction` points TOWARD it, `irradiance` is what a
 *   surface facing it square-on receives. This is `srcRef.js`'s `sunIrradiance`
 *   shape, kept so the CPU mirror stays the reference for this term.
 * @param {object[]} [options.lights]  `giLight.js` LIGHT slots (point and
 *   directional, `MAX_GI_LIGHTS` of them) — the engine path, one shadow ray per
 *   active slot. Independent of `sun`; the gate uses `sun`, the engine uses this.
 * @param {Node|number} [options.maxRay]  whole-medium ray bound, for a
 *   directional slot's shadow ray. Required when `lights` is non-empty.
 * @param {object[]} [options.emitters]  `giLight.js` emitter slots.
 * @param {(P, n, toLight, maxT) => Node} [options.visibility]  from
 *   `createSrcVisibility`. Its `maxT` is measured from the SURFACE point; the
 *   lift correction is that function's own (§12.26.3).
 * @param {Node} options.voxelSize  the DDA medium's quantization — every bias
 *   here tracks it (R2), and there is deliberately no default.
 * @param {object} [options.count]  per-statistic incrementers; see
 *   `srcDeposit.js`'s STAT words.
 * @param {{slot: Node}|true} [options.sunSplit]  §12.82. Names ONE source as
 *   "the sun": its irradiance is left OUT of the returned radiance and its
 *   visibility is returned beside it, so `[E]`/`[J]` can cache the transfer and
 *   `[F]` can close the term against the sun's CURRENT angle every frame. `true`
 *   splits the `sun` bundle; `{slot}` splits the LIGHT SLOT whose index equals
 *   that node (the engine path — `kind` is a uniform, so which slot is the sun
 *   is a runtime fact and cannot be a build-time choice). `srcDeposit.js`'s
 *   `BIN_SR` note carries the whole argument.
 *
 * @returns {(P, n, rho, Le, emitter, rayIndex) => {L: Node, sunVis: Node|null}}
 *   `L` is the radiance MINUS the split source; `sunVis` is that source's
 *   visibility at the hit (0 when the cosine gate skipped its ray), or null
 *   when nothing was split. `createSrcHitShader` recombines the two and is the
 *   form the gate diffs against `srcRef.js`.
 */
export function createSrcHitLighting({
  /**
   * ── §11.54: WATER CAUSTICS ARE A VISIBILITY, AND THAT IS WHY THEY BOUNCE ──
   *
   * Engine-owned water slots (`waterSlots.js`). Each contributes a MULTIPLIER
   * on light arriving from a distant source — `focus × transmittance`, exactly
   * 1 outside its volume — and it is applied to the slot's VISIBILITY rather
   * than to its irradiance. That placement is the whole trick:
   *
   *   · with the §12.82 sun split ARMED (the default), the irradiance is not
   *     stored at all — `sunVis` is, and it is re-closed against the current
   *     sun at [F]. A caustic folded into the irradiance would be thrown away
   *     every frame; folded into the visibility it rides in the cached TRANSFER
   *     and survives the close.
   *   · with the split off it lands in `E` at the hit, same as any shadow term.
   *
   * In both arms the probes therefore see a caustic-lit floor and BOUNCE it,
   * which is what "water must reflect light caustics onto objects" asks for and
   * what the old fragment-only `dFdx` estimator could not do from a kernel.
   *
   * The gain is bounded (≤ 4) because the deposit clamps a stored transfer into
   * [0,1]: a clipped highlight is the right failure, a firefly in a LIGHT is a
   * firefly in every bounce that light ever takes.
   */
  caustics = [],
  sun = null,
  lights = [],
  emitters = [],
  visibility = null,
  voxelSize = null,
  maxRay = null,
  neeEmitters = true,
  neeSamples = 1,
  importance = null,
  floorFraction = IMPORTANCE_FLOOR_FRACTION,
  lightTree = null,
  count = null,
  sunSplit = null,
  sunCompensation = null,
  // §11.10 — the sun's SHADOW MAP at hits, GISystem's bundle: `{ slot, count,
  // reversed, matrices[4], biases, normalBiases, sizes, bind(c, texel) }`.
  // The directional slot named by `slot` takes its visibility from a depth
  // texel instead of a BVH any-hit ray (one of the three descents every hit
  // paid); every other slot, and that slot on a hit outside every cascade,
  // still traces. Null keeps the kernel byte-identical to before.
  sunShadow = null,
  // §11.44: `{ buffer, rows, K, blockAt }` — per c0 block, `rows` packed
  // words of (lamp << 16 | vis·255 << 8 | samples). A tree sample whose
  // (block, lamp) row has K samples reads its mean visibility instead of
  // marching; otherwise it marches and folds the sample in (last writer
  // wins between two hits of one dispatch — a slower fill, never a wrong
  // one). Null = every sample marches (the pre-§11.44 kernel).
  visCache = null,
} = {}) {
  if (voxelSize == null) {
    throw new Error(
      "createSrcHitLighting: voxelSize is required — every bias here tracks the DDA " +
      "medium's quantization (R2), and inventing a default is how the wrong one ships",
    );
  }
  // The shadow ray must stop short of the emitter's own surface. Half a voxel,
  // for the same reason the trace's self-bias is a quarter of one: the
  // intersection was quantized by that voxel and nothing smaller is meaningful.
  if (lights.length && maxRay == null) {
    throw new Error(
      "createSrcHitLighting: maxRay is required when `lights` are supplied — a " +
      "directional slot's shadow ray runs the whole medium, and `kind` is a " +
      "uniform, so the bound cannot be chosen at build time",
    );
  }
  const margin = float(voxelSize).mul(0.5);
  // §12.62 W3: the light tree REPLACES the slot NEE when supplied — two NEE
  // estimators over overlapping light sets would double-deliver every emitter
  // both can reach. The slot set stays wired (the screen chain's direct and
  // R5's flag both still speak in slot indices); only the [J] pick changes.
  const useTree = lightTree != null;
  const useNee = neeEmitters && emitters.length > 0 && !useTree;
  // §12.82. `true` splits the `sun` bundle (the gate's path); `{slot}` splits a
  // LIGHT SLOT by runtime index (the engine's). Exactly one, and asking for the
  // slot form without slots is a wiring mistake that would silently split
  // nothing and leave the sun accumulating exactly as before.
  const splitSlot = sunSplit && sunSplit !== true ? sunSplit.slot : null;
  const splitBundle = sunSplit === true;
  // Independent of the lossy cached-normal sun split: this only names which
  // already-shaded analytic term may receive the owning-cascade compensation.
  const compensationSlot = sunCompensation && sunCompensation !== true
    ? sunCompensation.slot
    : null;
  const compensationBundle = sunCompensation === true;
  /**
   * ⚠ DIAGNOSTIC ONLY — DOUBLE-DELIVERS THE SUN ON PURPOSE.
   *
   * The split has two halves that a single image cannot separate: how much sun
   * it REMOVES from the accumulator, and how much the cached transfer DELIVERS
   * back at `[F]`. A picture that is darker than the un-split arm says only that
   * the second is smaller than the first, never by how much or which one is
   * wrong. With `keep`, the sun stays in `E` AND the transfer is still cached
   * and closed, so `keep − unsplit` is the delivered half on its own and
   * `unsplit − split` is the difference — two numbers from three runs.
   */
  const splitKeep = !!(sunSplit && sunSplit !== true && sunSplit.keep);
  if (splitBundle && !sun) {
    throw new Error(
      "createSrcHitLighting: sunSplit === true splits the `sun` bundle, and none was supplied — " +
      "the engine path passes `{slot}` instead (see §12.82)",
    );
  }
  if (splitSlot != null && !lights.length) {
    throw new Error(
      "createSrcHitLighting: sunSplit.slot names a LIGHT SLOT and no slots were supplied — " +
      "nothing would be split and the sun would keep accumulating, silently",
    );
  }
  const splitting = splitBundle || splitSlot != null;

  return (
    Pin,
    nIn,
    rhoIn,
    emissiveIn,
    emitterIn,
    rayIndex,
    sunGainIn = null,
    sunChromaGainIn = null,
  ) => {
    const P = vec3(Pin).toVar();
    const n = vec3(nIn).toVar();
    // One evaluation per hit, shared by every slot loop below: two texture
    // reads and no ray. Absent entirely when the scene has no water.
    const causticGain = caustics.length
      ? caustics.reduce((product, slot) => (product ? product.mul(waterCausticGainNode(P, slot)) : waterCausticGainNode(P, slot)), null).toVar()
      : null;
    const sunGain = sunGainIn == null ? float(1) : float(sunGainIn);
    const sunChromaGain = sunChromaGainIn == null ? sunGain : float(sunChromaGainIn);

    // ── E: irradiance arriving at the hit ───────────────────────────────────
    const E = vec3(0).toVar();
    // Raw irradiance from the one compensated analytic directional source.
    // Keeping it beside E lets the final Lambert product recover only the
    // albedo chroma that the cascade low-pass loses; no source separation is
    // stored in a bin and no new ray, pass or binding is introduced.
    const compensating = compensationBundle || compensationSlot != null;
    const sunRawE = compensating ? vec3(0).toVar() : null;
    /**
     * §12.82: the split source's VISIBILITY, and nothing else — no cosine and
     * no irradiance, because those are the two things `[F]` re-evaluates. It
     * stays 0 when the cosine gate skipped the ray, which is the honest answer:
     * a back-facing hit never tested the sun, so the bin caches no transfer and
     * waits for a ray rather than inventing one.
     */
    const sunVis = splitting ? float(0).toVar() : null;
    /**
     * ⭐ WHETHER THE SPLIT SOURCE COULD REACH THIS SURFACE AT ALL — 1 when the
     * cosine gate passed, 0 when the hit faces away. NOT the same as `sunVis`,
     * which is also 0 for a facing surface in shadow, and the difference is a
     * measured bug and not a nicety.
     *
     * `BIN_SN` holds ONE normal for a whole bin, LAST WRITE WINS. Written for
     * every hit, an AVERTED hit's normal lands in the bin and `[F]`'s
     * `max(0, n̂·l)` then reads 0 — silencing the transfer that the bin's OTHER,
     * sun-facing hits had accumulated over many frames. On the user's Level that
     * cost **44% of the picture's luma at leg0 and 21% at leg1**, and made the
     * blockiness WORSE (leg1 `checker` 0.0305 → 0.0557, rising instead of
     * settling) because which normal won flipped frame to frame.
     *
     * Gating the STORE on this makes the split unbiased across the two
     * populations: an averted hit contributes zero transfer (it never tested the
     * sun) while still counting in the denominator, so a bin that is half
     * averted delivers half the sun — which is the right answer — and the normal
     * describes the half that actually transfers.
     */
    const sunFacing = splitting ? float(0).toVar() : null;

    // The sun. The cosine is clamped at zero BEFORE the shadow ray, because a
    // back-facing surface needs no trace to know the answer — and that early-out
    // is most of what the sun term costs on the GPU.
    if (sun) {
      const l = vec3(sun.direction).toVar();
      const cos = n.dot(l).toVar();
      If(cos.greaterThan(0), () => {
        // No `maxT`: a directional source has no distance, and
        // `createSrcVisibility` reads the omission as "as far as the medium
        // goes" rather than as an unbounded literal WGSL cannot express.
        const v = visibility ? float(visibility(P, n, l, null)).toVar() : float(1).toVar();
        // Only when a ray was cast — see the NEE site's note.
        if (count && visibility) count.shadowRays(1);
        if (causticGain) v.mulAssign(causticGain);
        // Split: the ray still fires (visibility is the one term that cannot be
        // made analytic) but its product is not folded into E.
        if (splitBundle) { sunVis.assign(v); sunFacing.assign(1); }
        if (!splitBundle || splitKeep) {
          const raw = vec3(sun.irradiance).mul(cos).mul(v).toVar();
          E.addAssign(raw.mul(compensationBundle ? sunGain : float(1)));
          if (compensationBundle) sunRawE.addAssign(raw);
        }
      });
    }

    // The engine's punctual lights, ONE SHADOW RAY EACH. Unrolled because
    // `MAX_GI_LIGHTS` is 4 and compile-time; gated on the cosine for the same
    // reason the sun is, which is what keeps the cost proportional to the lights
    // a hit can actually see rather than to the lights the scene has.
    //
    // Four rays per hit is the honest parity-first cost and it is NOT where this
    // ends up: folding the light slots into the NEE set below collapses it to
    // one ray for lights AND emitters together, which is what `lightTree.js`
    // does and what §7's Phase 5 asks for. Measure before assuming it matters —
    // the cosine gate means most hits pay for one or none.
    // ⚠ THE LOOP BELOW IS A GPU LOOP, AND THAT IS THE WHOLE POINT (§13.14.5).
    //
    // It used to be `for (const slot of lights)` — a JS loop, so it unrolled at
    // graph-build time and each iteration inlined `visibility(...)`, i.e. a
    // whole 2-nested-loop BVH8 descent. `makeLightSlots()` always builds
    // MAX_GI_LIGHTS = 4 slots (correctly — that is R11: adding a light updates a
    // uniform and never recompiles), so this kernel emitted FOUR descents no
    // matter how many lights the scene had. Measured by stubbing call sites one
    // at a time — 4/3/2/1/0 inlinings gave 11814/11704/9739/8526/6938 ms — it is
    // ~1.2 s of shader COMPILE per call site, and this kernel is 66% of all the
    // compile work in a GI boot (26.1 s of 39.3 s across 75 kernels).
    //
    // Rolling it keeps every property that mattered: still one shadow ray per
    // light, still gated so an unlit or back-facing light costs no ray, still 4
    // uniform slots so a light edit never recompiles. The only thing that
    // changes is that the descent is written into the shader ONCE.
    //
    // The predicated gather is the shape `neeIrradiance` already uses below for
    // exactly this reason: funnel N cheap alternatives into ONE expensive call.
    // Here the funnel sits inside a loop so all N still get their own ray —
    // this is an EMISSION change, not an estimator change. Folding the lights
    // into the NEE set (which §7 Phase 5 does want) trades four deterministic
    // rays for one stochastic sample, and that is a variance change that needs
    // its own energy A/B and its own flicker arm. Not here.
    //
    // ── §12.82: ONE OF THESE SLOTS MAY BE "THE SUN", AND WHICH ONE IS A
    //    RUNTIME FACT. `kind` is a uniform (R11 — adding a light must never
    //    recompile), so the split cannot pick a slot at build time. It compares
    //    the slot index against a uniform instead, and the ONLY thing that
    //    changes for the chosen slot is where its product goes: the ray still
    //    fires, the counters still count it, and every other slot is emitted
    //    byte-identically to before.
    if (lights.length) {
      const terms = lights.map((slot) => lightTermsAt(slot, P, n, margin, maxRay));
      // ── §11.10: THE MAPPED SUN'S VISIBILITY IS A TEXEL, NOT A RAY ────────
      //
      // three's own shadow coordinate, replicated exactly (ShadowNode
      // `setupShadowCoord`): `pos = M × (P + n·normalBias)`, `/w`, y flipped,
      // z ± bias by the depth convention, in-frustum when uv ∈ [0,1] and
      // z ∈ [0,1]. The map is read with `textureLoad` — a comparison sampler
      // is fragment-only — and compared here with the same sense the
      // material's sampler uses (LessEqual, or GreaterEqual under reversed
      // depth). Cascades near → far, first containing frustum wins; a hit no
      // cascade covers returns −1 and the caller traces as before.
      const sunMapVisibility = sunShadow
        ? () => {
            const v = float(-1).toVar();
            const comp = ["x", "y", "z", "w"];
            for (let c = 0; c < sunShadow.matrices.length; c++) {
              If(v.lessThan(0).and(int(c).lessThan(sunShadow.count)), () => {
                const nb = sunShadow.normalBiases[comp[c]];
                const bias = sunShadow.biases[comp[c]];
                const size = sunShadow.sizes[comp[c]];
                const pos = sunShadow.matrices[c].mul(vec4(P.add(n.mul(nb)), 1)).toVar();
                const coord = pos.xyz.div(pos.w).toVar();
                const u = coord.x.toVar();
                const w = float(1).sub(coord.y).toVar();
                const z = (sunShadow.reversed ? coord.z.sub(bias) : coord.z.add(bias)).toVar();
                const inside = u.greaterThanEqual(0).and(u.lessThanEqual(1))
                  .and(w.greaterThanEqual(0)).and(w.lessThanEqual(1))
                  .and(z.greaterThanEqual(0)).and(z.lessThanEqual(1));
                If(inside, () => {
                  const texel = ivec2(
                    u.mul(size).clamp(0, size.sub(1)),
                    w.mul(size).clamp(0, size.sub(1)),
                  );
                  const d = float(sunShadow.bind(c, texel)).toVar();
                  v.assign(sunShadow.reversed
                    ? select(z.greaterThanEqual(d), float(1), float(0))
                    : select(z.lessThanEqual(d), float(1), float(0)));
                });
              });
            }
            return v;
          }
        : null;
      /** Is slot `idx` the mapped sun this frame? (null when no bundle) */
      const isMapped = (idx) => (sunShadow
        ? int(idx).equal(sunShadow.slot).and(sunShadow.count.greaterThan(0))
        : null);
      /**
       * The visibility of slot `idx` toward `dirTo`: the shadow map when the
       * slot is the mapped sun and the hit sits in a cascade, the any-hit ray
       * otherwise. Counts a shadow ray only when one fired.
       */
      const slotVisibility = (idx, dirTo, maxT) => {
        const mapped = isMapped(idx);
        if (!mapped || !sunMapVisibility) {
          const v = float(visibility(P, n, dirTo, maxT)).toVar();
          if (count) count.shadowRays(1);
          return v;
        }
        const v = float(1).toVar();
        const traced = float(1).toVar();
        If(mapped, () => {
          const m = sunMapVisibility();
          If(m.greaterThanEqual(0), () => { v.assign(m); traced.assign(0); });
        });
        If(traced.greaterThan(0), () => {
          v.assign(float(visibility(P, n, dirTo, maxT)));
          if (count) count.shadowRays(1);
        });
        return v;
      };
      /** Is slot `idx` (a node or a JS constant) the split sun? */
      const isSplit = (idx) => (splitSlot == null ? null : float(idx).equal(float(splitSlot)));
      /** Gain only the named analytic directional slot; every other source is 1. */
      const compensationFor = (idx) => (compensationSlot == null
        ? float(1)
        : select(float(idx).equal(float(compensationSlot)), sunGain, float(1)));
      /** Is slot `idx` the compensated directional source? */
      const isCompensation = (idx) => (compensationSlot == null
        ? null
        : float(idx).equal(float(compensationSlot)));
      if (!visibility || terms.length === 1) {
        // Nothing to win: with no ray there is no expensive call to share, and
        // with one light there is already exactly one call site. Kept as the
        // straight-line form so those two cases stay byte-identical to before.
        for (const [k, t] of terms.entries()) {
          If(t.E.x.max(t.E.y).max(t.E.z).greaterThan(0), () => {
            const v = visibility ? slotVisibility(k, t.dirTo, t.maxT) : float(1).toVar();
            if (causticGain) v.mulAssign(mix(float(1), causticGain, t.isDir));
            const mine = isSplit(k);
            const raw = t.E.mul(v).toVar();
            const included = mine && !splitKeep ? select(mine, float(0), float(1)) : float(1);
            if (mine) {
              sunVis.assign(select(mine, v, sunVis));
              // `t.E > 0` is the gate this sits under and it ALREADY carries the
              // cosine and `active` (see `lightTermsAt`), so reaching here IS
              // the cosine test — no second dot product.
              sunFacing.assign(select(mine, float(1), sunFacing));
              E.addAssign(raw.mul(compensationFor(k)).mul(included));
            } else {
              E.addAssign(raw.mul(compensationFor(k)));
            }
            const compensated = isCompensation(k);
            if (compensated) {
              sunRawE.addAssign(select(compensated, raw.mul(included), vec3(0)));
            }
          });
        }
      } else {
        Loop({ start: int(0), end: int(terms.length), type: "int", condition: "<" }, ({ i }) => {
          // `E` already carries cos and `active` (see `lightTermsAt`), so a
          // slot that is off, out of range, or behind the surface arrives here
          // as zero and the gate below skips its ray. That is why the old
          // `cos > 0 &&` half of the gate is gone rather than moved: it was
          // redundant with the `E > 0` half, and keeping both would suggest
          // they test different things.
          const Ei = vec3(0).toVar();
          const dirTo = vec3(0, 1, 0).toVar();
          const maxT = float(0).toVar();
          const isDir = causticGain ? float(0).toVar() : null;
          for (let k = 0; k < terms.length; k++) {
            const take = i.equal(int(k));
            Ei.assign(select(take, terms[k].E, Ei));
            dirTo.assign(select(take, terms[k].dirTo, dirTo));
            maxT.assign(select(take, terms[k].maxT, maxT));
            if (isDir) isDir.assign(select(take, terms[k].isDir, isDir));
          }
          If(Ei.x.max(Ei.y).max(Ei.z).greaterThan(0), () => {
            const v = slotVisibility(i, dirTo, maxT);
            if (causticGain) v.mulAssign(mix(float(1), causticGain, isDir));
            const mine = isSplit(i);
            const raw = Ei.mul(v).toVar();
            const included = mine && !splitKeep ? select(mine, float(0), float(1)) : float(1);
            if (mine) {
              sunVis.assign(select(mine, v, sunVis));
              sunFacing.assign(select(mine, float(1), sunFacing));
              E.addAssign(raw.mul(compensationFor(i)).mul(included));
            } else {
              E.addAssign(raw.mul(compensationFor(i)));
            }
            const compensated = isCompensation(i);
            if (compensated) {
              sunRawE.addAssign(select(compensated, raw.mul(included), vec3(0)));
            }
          });
        });
      }
    }

    if (useNee) {
      E.addAssign(neeIrradiance(emitters, P, n, rayIndex, {
        visibility, margin, samples: neeSamples, importance, floorFraction, count,
      }));
    }

    // ── §12.62 W3: NEE THROUGH THE LIGHT TREE ───────────────────────────────
    //
    // The estimator is `estimateLightTree`'s, verbatim: up to two samples from
    // the descent (the root may split), each contributing `E · v / pdf` where
    // `pdf` is the MARGINAL INCLUSION probability the descent returns and `E`
    // is the record's closed-form unoccluded irradiance. No importance floor
    // and no ranking pass here — the tree's pdf IS the ranking, and §12.26.5's
    // 3.00×-standard-error ceiling on a bounds-based pdf is what the flicker
    // arm of the W3 gate prices rather than asserts.
    //
    // The seed is a PURE FUNCTION of the ray index, exactly like the slot
    // draw above it replaces: no state, no frame term — the pick repeats
    // frame-to-frame at rest, which is the property the still floor's
    // temporal accumulation already relies on. (0x9e37 is the same odd
    // multiplier the stratified slot draw uses; the sampler's own counter RNG
    // decorrelates the per-descent draws from it.)
    //
    // ⚠ ONE visibility call site for BOTH samples — the predicated funnel the
    // rolled light loop above documents. `visibility` costs ~1.2 s of shader
    // compile PER CALL SITE (§13.14.5) and [J] carries the pole; two inline
    // sites here would put the §12.53 split's savings straight back.
    if (useTree) {
      const seed = hashKey(uint(rayIndex).mul(uint(0x9e37)));
      const s = lightTree.sample(P, n, seed);
      const picks = [
        { idx: s.index0, pdf: s.pdf0 },
        { idx: s.index1, pdf: s.pdf1 },
      ].map(({ idx, pdf }) => {
        const t = {
          E: vec3(0).toVar(),
          dirTo: vec3(0, 1, 0).toVar(),
          maxT: float(0).toVar(),
          pdf: float(0).toVar(),
          lamp: uint(0).toVar(),
        };
        If(float(idx).greaterThanEqual(0).and(float(pdf).greaterThan(0)), () => {
          const e = lightTree.evalAt(P, n, float(idx).toUint());
          t.E.assign(e.E);
          t.dirTo.assign(e.dirTo);
          // The cap stops at the emitter's own surface; the margin is R2's,
          // subtracted here exactly as `emitterTermsAt` does for a slot.
          t.maxT.assign(e.maxT.sub(margin).max(0));
          t.pdf.assign(pdf);
          t.lamp.assign(float(idx).toUint());
        });
        return t;
      });
      // §11.44: the hit's c0 block, looked up ONCE per hit; the (block, lamp)
      // rows below are the static world's answer to "does this lamp see
      // this probe", and a static lamp over a static surface does not change.
      const cacheOn = !!(visCache && visibility);
      const cacheSlot = cacheOn ? int(visCache.slotAt(P, count)).toVar() : null;
      const cacheRows = cacheOn ? uint(visCache.rows) : null;
      // One sample in eight on a converged row still marches and folds in —
      // a pure function of the ray index, so it never boils.
      const cacheRefresh = cacheOn ? hashKey(uint(rayIndex).mul(uint(0x85eb))).bitAnd(uint(7)).equal(uint(0)) : null;
      Loop({ start: int(0), end: int(picks.length), type: "int", condition: "<" }, ({ i }) => {
        const Ei = vec3(0).toVar();
        const dirTo = vec3(0, 1, 0).toVar();
        const maxT = float(0).toVar();
        const w = float(0).toVar();
        const lamp = uint(0).toVar();
        for (let k = 0; k < picks.length; k++) {
          const take = i.equal(int(k));
          Ei.assign(select(take, picks[k].E, Ei));
          dirTo.assign(select(take, picks[k].dirTo, dirTo));
          maxT.assign(select(take, picks[k].maxT, maxT));
          w.assign(select(take, picks[k].pdf, w));
          lamp.assign(select(take, picks[k].lamp, lamp));
        }
        If(Ei.x.max(Ei.y).max(Ei.z).greaterThan(0).and(w.greaterThan(0)), () => {
          const v = float(1).toVar();
          if (cacheOn) {
            const found = int(-1).toVar();
            const empty = int(-1).toVar();
            // The least-sampled row is the one a new lamp replaces when the
            // cell has no empty row: the lamps the tree picks often keep
            // their converged rows, the rare ones churn.
            const weakest = int(0).toVar();
            const weakestCnt = uint(0xffff).toVar();
            const cVis = float(0).toVar();
            const cVisByte = uint(0).toVar();
            const cCnt = uint(0).toVar();
            const rowBase = uint(cacheSlot.max(int(0))).mul(cacheRows).toVar();
            const inField = cacheSlot.greaterThanEqual(int(0));
            If(inField, () => {
              for (let j = 0; j < visCache.rows; j++) {
                const word = visCache.rowsBuf.element(rowBase.add(uint(j))).toVar();
                const cnt = word.bitAnd(uint(0xff)).toVar();
                const hit = cnt.greaterThan(uint(0)).and(word.shiftRight(uint(16)).equal(lamp)).and(found.lessThan(int(0)));
                If(hit, () => {
                  found.assign(int(j));
                  cVisByte.assign(word.shiftRight(uint(8)).bitAnd(uint(0xff)));
                  cVis.assign(float(cVisByte).div(255));
                  cCnt.assign(cnt);
                });
                If(cnt.equal(uint(0)).and(empty.lessThan(int(0))), () => { empty.assign(int(j)); });
                If(cnt.lessThan(weakestCnt), () => { weakestCnt.assign(cnt); weakest.assign(int(j)); });
              }
            });
            // ⭐ A CACHE MAY ANSWER ONLY WHERE ITS SAMPLES AGREE (§11.46).
            // The row is keyed by CELL and lamp, and a 0.7 m cell spans both
            // sides of every wall: the mean of a lit face and a shadowed face
            // is a half-lit answer handed to BOTH. Measured on the user's
            // Level with the mean served: direct luma at hits 0.041 → 0.015,
            // bounce/direct 1.35 → 6.22, far field 78,66,47 → 93,92,66 — the
            // picture flat, bright and desaturated ("lost its colour and
            // atmosphere"). Unanimity is exact instead: the count is capped
            // at 255, so ONE dissenting sample moves the stored byte off
            // 255/0 and every pick in that cell marches for ever after. The
            // saving stays where the answer is not in doubt — open floor,
            // deep shadow — and every boundary cell pays the ray it needs.
            const unanimous = cVisByte.equal(uint(255)).or(cVisByte.equal(uint(0)));
            const cached = found.greaterThanEqual(int(0))
              .and(cCnt.greaterThanEqual(uint(visCache.KU)))
              .and(unanimous)
              .and(cacheRefresh.not());
            If(cached, () => {
              v.assign(cVis);
              if (count) count.visCached(1);
            }).Else(() => {
              // ⚠ the ONE visibility call site of this loop (the compile
              // law the light loop above documents).
              v.assign(float(visibility(P, n, dirTo, maxT)));
              if (count) count.shadowRays(1);
              const slot = select(found.greaterThanEqual(int(0)), found, select(empty.greaterThanEqual(int(0)), empty, weakest)).toVar();
              if (count) {
                If(inField.not(), () => { count.visNoBlock(1); });
                If(inField.and(slot.lessThan(int(0))), () => { count.visNoRow(1); });
                If(found.greaterThanEqual(int(0)), () => { count.visFilling(1); });
              }
              If(inField.and(slot.greaterThanEqual(int(0))), () => {
                const known = found.greaterThanEqual(int(0));
                const n1 = select(known, cCnt.add(uint(1)), uint(1)).toVar();
                const mean = select(known, cVis.mul(float(cCnt)).add(v).div(float(n1)), v).clamp(0, 1).toVar();
                const word = lamp.shiftLeft(uint(16))
                  .bitOr(uint(mean.mul(255).add(0.5)).shiftLeft(uint(8)))
                  .bitOr(n1.min(uint(255)));
                visCache.rowsBuf.element(rowBase.add(uint(slot))).assign(word);
              });
            });
          } else {
            v.assign(visibility ? float(visibility(P, n, dirTo, maxT)) : float(1));
            if (count && visibility) count.shadowRays(1);
          }
          E.addAssign(Ei.mul(v).div(w));
        });
      });
    }

    // ── ρ/π · E with physical 0..1 first-bounce reflectance. R4's stricter
    //    0.9 ceiling belongs only to [J]'s recursive atlas term. ─────────────
    const rho = vec3(rhoIn).toVar();
    const out = rho.mul(E).mul(1 / Math.PI).toVar();
    if (sunRawE) {
      const neutral = rho.x.min(rho.y).min(rho.z).toVar();
      const chroma = rho.sub(vec3(neutral)).max(0).toVar();
      out.addAssign(chroma.mul(sunRawE).mul(sunChromaGain.sub(sunGain)).mul(1 / Math.PI));
    }

    // ── emission, and R5's zeroing ──────────────────────────────────────────
    const Le = vec3(emissiveIn).toVar();
    const emits = Le.x.max(Le.y).max(Le.z).greaterThan(0).toVar();
    // R5 under the tree (§12.62 W3): the flag still speaks in PROMOTED slot
    // indices, and the tree's emitter set is a superset of the promoted set —
    // so this zeroes exactly the emitters whose double-delivery the flag can
    // name. A NON-promoted tree emitter that is also emissive on contact
    // would deliver twice; today that cannot happen in production (statics'
    // promoted emissive is zeroed at palette bake, movers' at writeSurface,
    // and the production palette flag is always −1 — srcSurface's
    // `emitterMeshes` is unwired), and moving the WHOLE handoff onto the
    // tree's set is Unit W5's charter, not a branch here.
    if ((useNee || useTree) && emitterIn != null) {
      const isNeeLight = float(emitterIn).greaterThanEqual(0)
        .and(float(emitterIn).lessThan(emitters.length))
        .toVar();
      If(emits, () => {
        if (count) {
          count.emissiveZeroed(select(isNeeLight, 1, 0));
          count.emissiveHits(select(isNeeLight, 0, 1));
        }
        out.addAssign(select(isNeeLight, vec3(0), Le));
      });
    } else {
      If(emits, () => {
        if (count) count.emissiveHits(1);
        out.addAssign(Le);
      });
    }
    // §12.82: the TRANSFER, not the radiance — `ρ/π · V`, with no cosine and no
    // irradiance in it, because those are exactly the two factors that go stale
    // when the sun turns and exactly the two `[F]` re-evaluates. The `ρ` is the
    // SAME physical one the rest of the direct expression uses, so recombining the two
    // halves at the deposit's own sun angle is an algebraic identity — which is
    // what `createSrcHitShader` below does and what the gate asserts.
    return {
      L: out,
      sunVis,
      sunFacing,
      sunTransfer: sunVis ? rho.mul(sunVis).mul(1 / Math.PI).toVar() : null,
    };
  };
}

/**
 * §4.4's hit shading, ASSEMBLED — attribution then lighting, one call, one
 * `vec3`. Returns `shadeHit(hit, dir, rayIndex) → vec3`, the exact shape
 * `createSrcDepositFrame` takes as its `shadeHit` option.
 *
 * ⚠ **IT RETURNS A `vec3` EVEN UNDER §12.82's SPLIT**, by closing the sun term
 * against the sun the deposit is actually looking at. That is not a convenience
 * for old callers: it is the IDENTITY the split has to satisfy, and putting it
 * here means `test:gi-src-shade` — which diffs this against `srcRef.js`'s
 * un-split `makeHitShader` — gates the split for free. If the two halves ever
 * stop summing to the whole, that gate says so before any image does.
 *
 * This is the ONE-KERNEL form. The engine has not used it since §12.53 (it
 * builds the two halves separately and puts them in [E] and [J]), and what
 * keeps it is that it is the form `test:gi-src-shade` gates against
 * `srcRef.js`'s `makeHitShader` and the form `scripts/gi-src-deposit.html`
 * traces with — one expression, comparable to the mirror line for line, with no
 * hit list or second dispatch in the way. A divergence between this and the
 * split pair is therefore a divergence between two compositions of the SAME two
 * factories, which is a class of bug the composition cannot have.
 */
export function createSrcHitShader({
  surfaceAt,
  maxLoopAlbedo = MAX_LOOP_ALBEDO,
  count = null,
  ...lighting
} = {}) {
  const attribute = createSrcHitAttribution({ surfaceAt, maxLoopAlbedo, count });
  const light = createSrcHitLighting({ ...lighting, count });
  // What `[F]` will multiply the cached transfer by. The composer needs the
  // same pair, or "recombined" would mean "recombined against something else".
  const closeSun = sunTerm(lighting);
  return (hit, dir, rayIndex, sunGain = null, sunChromaGain = null) => {
    const a = attribute(hit, dir);
    const r = light(
      a.P,
      a.n,
      a.rho,
      a.emissive,
      a.emitter,
      rayIndex,
      sunGain,
      sunChromaGain,
    );
    if (!r.sunTransfer) return r.L;
    const { direction, irradiance } = closeSun();
    return r.L.add(r.sunTransfer.mul(irradiance).mul(vec3(a.n).dot(direction).max(0)));
  };
}

/**
 * The `{direction, irradiance}` of whichever source §12.82 split out — the pair
 * `[F]` closes the cached transfer against, resolved from the same options the
 * lighting factory was built from so the two cannot drift apart.
 *
 * ⚠ **RETURNS A THUNK, and that is not style.** For a light slot the pair is a
 * predicated select over the slot uniforms, i.e. real nodes with `toVar()`s in
 * them, and a node built outside a kernel body belongs to whichever builder
 * happens to be open. `[F]` and the composer are different kernels; each calls
 * this inside its own.
 *
 * `vector` is already the direction TOWARD a directional light and `color`
 * already carries its intensity (see `lightTermsAt`, whose `atten` is 1 for
 * `kind == 1`), so no conversion happens here — a conversion is precisely where
 * the two sides would drift.
 */
export function sunTerm({ sun = null, lights = [], sunSplit = null } = {}) {
  if (!sunSplit) return null;
  if (sunSplit === true) {
    return () => ({ direction: vec3(sun.direction).toVar(), irradiance: vec3(sun.irradiance).toVar() });
  }
  const idx = sunSplit.slot;
  return () => {
    const direction = vec3(0, 1, 0).toVar();
    const irradiance = vec3(0).toVar();
    for (const [k, slot] of lights.entries()) {
      const take = float(idx).equal(float(k));
      direction.assign(select(take, vec3(slot.vector), direction));
      // `active` is folded in here rather than left to the resolve: a slot that
      // goes dark must stop delivering on the very frame it does, and `[F]` has
      // no other way to know — the cached transfer knows nothing about it.
      irradiance.assign(select(take, vec3(slot.color).mul(float(slot.active ?? 1)), irradiance));
    }
    return { direction, irradiance };
  };
}
