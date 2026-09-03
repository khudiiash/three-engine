// ── THE TRANSPORT BVH IS NOT THE RENDER MESH (§10.3, 2026-09-02) ────────────
//
// The static BVH8 answers every GI ray: the probe transport's closest hit,
// the shade's sun and NEE shadow rays, the emitter shadow marches, the sun
// shadow at reflection hits. On the user's Bistro it held 2.83 M triangles
// (147 MB) and a ray cost ~650 ns across its ~4 descents; the world chain was
// 24–27 ms per dispatch and the emitter shadow pass 11–12 ms.
//
// Diffuse GI does not need render-mesh precision. The probe lattice is
// 0.35 m; a surface displaced by a centimetre changes no bounce anyone can
// see, and a shadow ray blocked by a 1 cm-simplified wall is blocked all the
// same. So meshes that only the DIFFUSE and SHADOW paths look at are
// simplified with meshoptimizer's edge-collapse simplifier (already in the
// tree for virtual geometry) under an ABSOLUTE error bound, with mesh
// borders LOCKED so adjacent meshes that share a wall never open a crack
// (a crack is a leak, and a leak fails the GI gate before any fps number).
//
// What stays exact: meshes whose material can show a mirror image (static
// roughness below the exact-reflection weight's 0.45 cut-off — those are the
// ones `traceStaticBvhSlot` resolves pixel-for-pixel), and anything under
// `minTriangles` (small props cost nothing to keep).
//
// The simplified index references the ORIGINAL vertices, so per-vertex UVs
// (the reflection atlas path) stay valid without remapping. The disk cache
// keys on the digested inputs (positions + index), so a simplified build has
// its own artifact and an unsimplified one is never mistaken for it.
//
// `__giBvhSimplify = false` keeps every mesh exact (rebuild).
import { staticRoughnessOf } from "./giLight.js";

export const STATIC_BVH_SIMPLIFY_ERROR_M = 0.01;
export const STATIC_BVH_SIMPLIFY_RATIO = 0.25;
export const STATIC_BVH_SIMPLIFY_MIN_TRIANGLES = 5000;
/** Below this static roughness a material can show a sharp reflection — keep exact. */
export const STATIC_BVH_SIMPLIFY_ROUGHNESS_MIN = 0.45;

let simplifier = null;
let loading = null;
let loadFailed = null;

/** Starts loading meshoptimizer's simplifier (WASM); idempotent. */
export function preloadStaticBvhSimplifier() {
  if (simplifier || loadFailed) return Promise.resolve(simplifier);
  loading ??= import("meshoptimizer")
    .then(async (m) => {
      await m.MeshoptSimplifier.ready;
      simplifier = m.MeshoptSimplifier;
      return simplifier;
    })
    .catch((error) => {
      loadFailed = error;
      console.warn(`[gi] transport BVH simplifier unavailable — meshes stay exact: ${error?.message ?? error}`);
      return null;
    });
  return loading;
}

export function staticBvhSimplifierReady() {
  return simplifier != null;
}

/** Same walk giLight's material bucket uses; null = per-pixel (dynamic). */
export function transportKeepsExact(mesh) {
  // Fail exact: a placement without a mesh or material is not a licence to
  // simplify something that might be a mirror.
  if (!mesh) return true;
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (!material) return true;
  const roughness = staticRoughnessOf(material);
  // A per-pixel roughness (texture-driven) may be mirror-like somewhere —
  // keep it exact rather than guess.
  if (roughness == null) return true;
  return roughness < STATIC_BVH_SIMPLIFY_ROUGHNESS_MIN;
}

const cache = new Map(); // `${geometryKey}|${error}|${ratio}` → { index, before, after }

function triangleCountOf(positions, index) {
  const elements = index ? index.length : Math.floor(positions.length / 3);
  return Math.floor(elements / 3);
}

/**
 * Returns the index to build the transport BLAS from: the simplified one when
 * the simplifier is ready and the mesh qualifies, otherwise `index` itself.
 * `stats` (optional) accumulates { meshes, before, after, skippedNotReady }.
 */
export function simplifyStaticBvhIndex(geometryKey, positions, index, {
  targetError = STATIC_BVH_SIMPLIFY_ERROR_M,
  ratio = STATIC_BVH_SIMPLIFY_RATIO,
  minTriangles = STATIC_BVH_SIMPLIFY_MIN_TRIANGLES,
  stats = null,
} = {}) {
  if (globalThis.__giBvhSimplify === false) return index;
  if (!(positions instanceof Float32Array) || positions.length < 9) return index;
  const before = triangleCountOf(positions, index);
  if (before < minTriangles) return index;
  if (!simplifier) {
    if (stats) stats.skippedNotReady = (stats.skippedNotReady ?? 0) + 1;
    preloadStaticBvhSimplifier();
    return index;
  }
  const key = `${geometryKey}|${targetError}|${ratio}`;
  let entry = cache.get(key);
  if (!entry || entry.positions !== positions) {
    const source = index
      ? (index instanceof Uint32Array ? index : Uint32Array.from(index))
      : Uint32Array.from({ length: before * 3 }, (_, i) => i);
    const target = Math.max(3, Math.floor((source.length * ratio) / 3) * 3);
    let out = null;
    try {
      const [simplified] = simplifier.simplify(
        source, positions, 3, target, targetError, ["ErrorAbsolute", "LockBorder"],
      );
      if (simplified && simplified.length >= 3 && simplified.length < source.length) out = simplified;
    } catch (error) {
      console.warn(`[gi] transport BVH simplify failed for ${geometryKey}: ${error?.message ?? error}`);
    }
    entry = { positions, index: out ?? index, before, after: out ? out.length / 3 : before };
    cache.set(key, entry);
  }
  if (stats) {
    stats.meshes = (stats.meshes ?? 0) + 1;
    stats.before = (stats.before ?? 0) + entry.before;
    stats.after = (stats.after ?? 0) + entry.after;
  }
  return entry.index;
}

/** Drops cached simplifications (a geometry edit re-simplifies on demand). */
export function clearStaticBvhSimplifyCache() {
  cache.clear();
}
