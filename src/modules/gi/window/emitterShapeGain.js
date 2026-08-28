// §19 STAGE 5.3d — THE SEAT'S SOLID ANGLE IS A **MEAN**, AND THIS IS THE
// DIRECTIONAL FACTOR THAT TURNS IT BACK INTO AN ACTUAL PROJECTED AREA.
//
// ⭐⭐⭐ THE MEASUREMENT THAT FORCED THIS FILE. §19 5.3 shipped the pixel-
// analytic seat term OFF at gain 0.365 and 5.3d re-armed it with a filter: the
// silhouette outlier collapsed (`Box·-X` 1.85 → 0.47) and the picture went
// UNIFORMLY DARK — global gain 0.493 with every surface down by roughly the
// same factor. A uniform deficit under a term that is otherwise correct is a
// SCALE, and the scale is spelled out in `emitterShapes.shapeMeanProjRadius`:
//
//     π · r_eff²  =  S / 4   ← Cauchy: the MEAN projected area of a convex body
//
// So `Ω = π·r_eff²/d²` is the solid angle this emitter subtends **averaged over
// every direction**, and every path in the repository uses it as though it were
// the solid angle it subtends FROM HERE. For a sphere those are the same number
// and nobody ever noticed. For the user's Cornell lamp — a closed box 4.47 m² in
// area and thinner than a GI cell — a receiver on the floor sees the whole
// bottom face (≈ S/2) while the seat hands it S/4: a factor of exactly two,
// which is the deficit measured.
//
// ══ WHAT THIS RETURNS, AND WHY ITS MEAN IS 1 BY CONSTRUCTION ════════════════
//
// For a box with half-extents `h` on axes `bx, by, bz`, the area projected onto
// a plane perpendicular to `d` is
//
//     A(d) = 4·( hy·hz·|d·bx| + hx·hz·|d·by| + hx·hy·|d·bz| )
//
// (each face pair contributes its area times the cosine; exactly one face of
// each pair faces `d`). Averaging `|d·b|` over the sphere gives ½, so
//
//     E[A] = 2·( hx·hy + hy·hz + hz·hx )  =  S/4  =  π·r_eff²
//
// — the very quantity `shapeMeanProjRadius` returns for `EMITTER_KIND.BOX`.
// Therefore `gain(d) = A(d) / E[A]` has mean **exactly 1** over the sphere, and
// `Ω' = π·r_eff²·gain(d)/d²` is the true projected solid angle while remaining
// energy-identical to the old expression when averaged over receivers. Nothing
// is scaled up: light is moved from the directions that never saw the lamp's
// face to the ones that do, which is what a silhouette IS.
//
// ⚠ BOX KIND ONLY, AND THAT IS A REFUSAL RATHER THAN AN OVERSIGHT. `A(d)` above
// is the box's, and `fitEmitterShape` fits six other kinds whose true
// directional profile is not this expression — a SPHERE's gain is identically 1
// and this formula would give it ±15 %, which is a fabricated silhouette on a
// shape that has none. Every non-box kind returns 1 and is byte-identical to
// what it was. Extending it is a per-kind derivation beside
// `shapeMeanProjRadius`'s own switch, not a generalisation of this one.
//
// ⚠ AND BOTH HALVES OF THE TRANSPORT CALL IT. The pixel's direct term
// (`rcDirect`) and the face cache's slot NEE (`gatherProbes.shadeTerms`) are the
// first and second bounce of the SAME lamp; a gain applied to one of them would
// make every surface's ratio carry the difference between them. One definition,
// two call sites — which is the only shape in which "one lamp, one energy on
// every path" is checkable.
import { dot, float, select, vec3 } from "three/tsl";

/** `EMITTER_KIND.BOX`. Imported as a literal so this module stays a leaf. */
const KIND_BOX = 1;

/**
 * Build the directional gain closure for ONE emitter slot.
 *
 * @param {object} slot  a GISystem emitter-slot uniform bag — `kind`, `half`,
 *   `bx`, `by`, `bz`.
 * @returns {(d: Node) => Node} `gain(d)`, mean 1 over the sphere, 1 exactly for
 *   every non-box kind. `d` is the unit direction between receiver and lamp;
 *   the expression is sign-free, so which way it points does not matter.
 */
export function emitterShapeGain(slot) {
  return (d) => {
    const h = vec3(slot.half).abs().toVar();
    const ax = h.y.mul(h.z).toVar();
    const ay = h.x.mul(h.z).toVar();
    const az = h.x.mul(h.y).toVar();
    const proj = ax.mul(dot(d, vec3(slot.bx)).abs())
      .add(ay.mul(dot(d, vec3(slot.by)).abs()))
      .add(az.mul(dot(d, vec3(slot.bz)).abs()))
      .toVar();
    const mean = ax.add(ay).add(az).mul(0.5).toVar();
    // A degenerate fit (two half-extents at zero — a needle) has no projected
    // area to speak of and `proj/mean` would be 0/0. Falls back to the mean,
    // i.e. to exactly what the seat did before this file existed.
    const ok = float(slot.kind).equal(float(KIND_BOX)).and(mean.greaterThan(1e-8));
    return select(ok, proj.div(mean.max(1e-8)), float(1));
  };
}
