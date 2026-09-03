/**
 * Stable runtime identifiers for the GI ray/scene query.
 *
 * OccupancyLegacy and the Phase-1 HybridBrickBox path are implemented. Later
 * modes deliberately resolve back to legacy until their GPU path is complete,
 * so selecting an experimental mode can never silently turn GI off.
 */
export const RayHitMode = Object.freeze({
  OccupancyLegacy: 0,
  HybridBrickBox: 1,
  HybridPlane: 2,
  HybridPlaneCoverage: 3,
  HybridExactComplex: 4,
  // §10 (2026-09-02): the transport traces the static BVH8 + movers; the
  // occupancy tracer is not built for the transport at all. The occupancy
  // consumers that remain (the resolve's record march, the emitter shadow
  // pass) keep HybridExactComplex as their `activeMode` until they move.
  Bvh: 5,
});

export const RAY_HIT_MODE_OPTIONS = Object.freeze([
  "occupancy-legacy",
  "hybrid-brick-box",
  "hybrid-plane",
  "hybrid-plane-coverage",
  "hybrid-exact-complex",
  "bvh",
]);

const MODE_BY_NAME = Object.freeze({
  "occupancy-legacy": RayHitMode.OccupancyLegacy,
  "hybrid-brick-box": RayHitMode.HybridBrickBox,
  "hybrid-plane": RayHitMode.HybridPlane,
  "hybrid-plane-coverage": RayHitMode.HybridPlaneCoverage,
  "hybrid-exact-complex": RayHitMode.HybridExactComplex,
  "bvh": RayHitMode.Bvh,
});

export function normalizeRayHitMode(value) {
  if (Number.isInteger(value) && value >= RayHitMode.OccupancyLegacy && value <= RayHitMode.Bvh) {
    return value;
  }
  return MODE_BY_NAME[String(value ?? "").toLowerCase()] ?? RayHitMode.OccupancyLegacy;
}

export function rayHitModeName(mode) {
  return RAY_HIT_MODE_OPTIONS[normalizeRayHitMode(mode)];
}

/**
 * `rayHitMode: "auto"` — the mode follows the QUALITY PRESET, which is the
 * right default because the ladder's whole trade is memory/cost vs hit
 * precision and that is exactly what the presets already arbitrate.
 *
 * high/custom land on EXACT-COMPLEX, not plane-coverage. The original
 * "can't tell the modes apart in a still" evaluation predates the record
 * march: with shadows resolved through the records, the difference is
 * exactly where a still shows it — a non-axis-aligned caster's silhouette
 * cells contain an EDGE (two faces), which fails the simple-plane fit, and
 * without a triangle pool every such cell falls back to occupied-box hits.
 * That quantized every rotated cube's and every trim/arch edge's shadow to
 * full voxels while the flat-face interiors stayed sub-voxel exact. The
 * triangle pool's memory cost (~2 tris x 36 B per failed-fit cell) is the
 * price of correct silhouettes — and, §12.68 measured, of correct TRANSPORT
 * ENERGY: every preset pays it now (see AUTO_MODE_BY_QUALITY below).
 */
const AUTO_MODE_BY_QUALITY = Object.freeze({
  // low was HybridBrickBox until 2026-08-05 ("holes in the voxel mesh, light
  // leaks" — box origin-lift dead zone), then HybridPlane until 2026-08-14.
  //
  // ══ WHY LOW/MEDIUM ARE EXACT-COMPLEX TOO (§12.68 PRESET ENERGY) ══════════
  //
  // HybridPlane is not merely "quantized silhouettes": any occupied cell
  // WITHOUT a usable simple-plane record — complex fit (edges, trim, curved
  // mouldings, foliage), pool overflow, unfitted — keeps occupied-BOX hit
  // semantics, so a ray crossing the EMPTY part of such a voxel stops on a
  // phantom hull. On real content at low/medium voxel sizes that is a
  // TRANSPORT ENERGY SINK, not an edge artifact. Measured on the user's
  // Sponza (medium, same pose, single-knob A/B — everything else identical:
  // same 0.164 m occupancy grid, same s₀ 0.6, same 26 330 rays/frame):
  //
  //             hitRate   mean free path   GI screen mean   deep-arch cells
  //   plane      0.984        2.00 m           0.358          0.08–0.10
  //   exact      0.966        3.92 m           1.486          0.27–0.30
  //
  // Half the free path ⇒ rays die on phantom boxes near their birth surface
  // instead of reaching the sun-lit courtyard or the sky, and the deposit
  // carries the phantom's (dark) radiance with T = 0 — a multiplicative ~4.2×
  // GI collapse concentrated in exactly the GI-only interiors ("medium is too
  // dark in most places, low doubled"). Attribution was innocent (1–3% both
  // arms); ray budget was innocent (ultra fires 8× low's rays at the same
  // screen mean). A preset may buy noise and coarseness; it must not lose
  // energy — so hit precision is now preset-independent and the presets keep
  // trading rays, probe density and resolution only. Measured cost at medium
  // on Sponza: +35 MB triangle pool, GPU 5.6 → 6.4 ms on the capped 4070.
  // `__giRayHitMode = "hybrid-plane"` remains the A/B hatch.
  //
  // ══ §10 (2026-09-02): "auto" IS THE FIELD-LESS BVH BUILD ══════════════════
  //
  // Every tier now sends the SRC transport to the static BVH8 + movers
  // (srcBvhTrace.js) and allocates NO occupancy pyramid (GISystem
  // `#makeSceneHost`). The pyramid was the largest allocation (274 MB on
  // Bistro + 628 MB of CPU mirrors), the only structure re-minted by camera
  // motion (every slide of its 40 m box re-voxelized the world and held the
  // screen — the user's frozen GI image under motion), and the reason the
  // field had a box at all (outside it: a constant far field, photographed
  // as black patches). Level receipt: host 7.3 MB vs 82 MB, same probe/tile
  // counts, diffuse at 4.1 s after build, walk clean. The exact-complex
  // occupancy build stays reachable — `rayHitMode: "hybrid-exact-complex"`
  // on the component or `__giRayHitMode` from a harness — and the voxel-
  // native rigs (gi-occupancy, gi-spawn, gi-gather-los) pin it.
  low: RayHitMode.Bvh,
  medium: RayHitMode.Bvh,
  high: RayHitMode.Bvh,
  ultra: RayHitMode.Bvh,
});

export function resolveAutoRayHitMode(quality) {
  return AUTO_MODE_BY_QUALITY[String(quality ?? "").toLowerCase()] ?? RayHitMode.Bvh;
}

/**
 * Resolves authoring properties and diagnostic globals into one immutable
 * build configuration. All four hybrid phases are implemented: HybridBrickBox
 * (Phase 1), HybridPlane (Phase 2), HybridPlaneCoverage (Phase 3) and
 * HybridExactComplex (Phase 4). Unknown future values keep the explicit
 * legacy fallback so a stale saved mode can never silently turn GI off.
 *
 * `enableSkipDistance` is an OPT-OUT, not an opt-in: the conservative coarse
 * pyramid ride in the hybrid traces shipped always-on inside Phase 1, so this
 * flag is only the Phase-5 A/B kill switch. It defaults ON; set
 * `globalThis.__giRayHitSkipDistance = false` or the component prop
 * `rayHitSkipDistance: false` to disable it for a comparison run.
 *
 * `enableShadowRecords` is the matching Phase-5 kill switch for RECORD-AWARE
 * SHADOW DISTANCE: the soft-shadow oracle sharpening an occupied neighbour's
 * voxel-AABB gap with that voxel's fitted SIMPLE plane, which is what unstairs
 * the shadow silhouettes. It defaults ON too; `__giRayHitShadowRecords = false`
 * or the prop `rayHitShadowRecords: false` reverts to the pure box gap, and the
 * two arms differ in WGSL (a separate compiled oracle variant), not in a runtime
 * predicate.
 */
export function resolveRayHitConfig(props = {}, runtime = globalThis) {
  const rawMode = runtime.__giRayHitMode ?? props.rayHitMode;
  const autoMode = String(rawMode ?? "").toLowerCase() === "auto";
  const requestedMode = autoMode
    ? resolveAutoRayHitMode(props.quality)
    : normalizeRayHitMode(rawMode);
  // "bvh" (or the `__giSrcBvhTrace = true` hatch on any mode) sends the
  // TRANSPORT to the BVH; the occupancy consumers that remain run at
  // exact-complex, the mode the BVH path replaced for the transport.
  const bvhTransport = requestedMode === RayHitMode.Bvh || runtime.__giSrcBvhTrace === true;
  const occupancyMode = requestedMode === RayHitMode.Bvh ? RayHitMode.HybridExactComplex : requestedMode;
  const activeMode = occupancyMode >= RayHitMode.HybridBrickBox &&
    occupancyMode <= RayHitMode.HybridExactComplex
    ? occupancyMode
    : RayHitMode.OccupancyLegacy;
  return Object.freeze({
    requestedMode,
    activeMode,
    bvhTransport,
    autoMode,
    fallbackToLegacy: requestedMode !== activeMode,
    enableProfiling: runtime.__giRayHitProfiling === true || props.rayHitProfiling === true,
    enableSkipDistance: runtime.__giRayHitSkipDistance !== false && props.rayHitSkipDistance !== false,
    enableShadowRecords: runtime.__giRayHitShadowRecords !== false && props.rayHitShadowRecords !== false,
    enableRayConeLOD: runtime.__giRayHitConeLOD === true,
    enableDynamicOverlay: runtime.__giRayHitDynamicOverlay === true,
    enableComplexTriangles: runtime.__giRayHitComplexTriangles === true,
    visualizeTraversal: runtime.__giRayHitVisualizeTraversal === true,
    validateAgainstLegacy: runtime.__giRayHitValidateLegacy === true,
    validateAgainstCPU: runtime.__giRayHitValidateCPU === true,
  });
}
