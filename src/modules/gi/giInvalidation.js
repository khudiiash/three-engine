// WHAT INVALIDATES WHAT — the two GI decisions that cost the most when they
// are wrong, kept pure so a gate can hold them.
//
// Both were live bugs on the user's Sponza (2026-09-09), and both had the same
// shape: a cheap signal was reused as the trigger for an expensive rebuild,
// because the cheap signal was the one that happened to be lying around.
//
//   · The exact-reflection BVH was resynced off `#computeFingerprint`, the
//     omnibus CONTENT hash — which folds every material's base colour and its
//     emissive×intensity. The BVH reads neither.
//   · The environment's material IBL was suppressed on `_fieldReadyOnce`, a
//     PER-TICK "the chain completed" flag that is cleared in eight places.
//     `scene.environmentNode` is half of three's node-builder dynamic cache
//     key, so every flip re-mints every lit material in the scene.
//
// See GISystem's call sites for the measured cost of each.

/**
 * The identity of the scene `buildBvhScene` would build.
 *
 * ONLY the mesh set and their geometry. Deliberately NOT here, with reasons:
 *
 *  · **material colour / emissive** — the BVH stores triangles. Albedo reaches
 *    it through the atlas, which has its own blit and its own pending queue
 *    (`pendingGpuTiles`), and emissive reaches the transport through the slot
 *    palette. On the user's Sponza the colours genuinely move after the scene
 *    is up: `computeCompressedTextureAverage` resolves KTX2 means on the GPU
 *    and re-tints the palette, which used to drop a fresh 214 663-triangle
 *    build to produce a byte-identical BVH.
 *  · **world matrices** — uniforms (`refreshTransforms` rewrites them per
 *    frame); the static-BVH path has its own refit for a placement that moved.
 *  · **mesh COUNT vs capacity** — the per-mesh tables are capacity-fixed at
 *    MAX_BVH_MESHES and the shader's loop bound is a live uniform, so seating
 *    a different number of meshes never changes the WGSL.
 *
 * What IS here is what changes the triangles or who owns them: the mesh set,
 * each mesh's eligibility (`buildBvhScene` excludes skinned and unindexed
 * geometry and anything over the per-mesh triangle cap), the geometry
 * identity, and the vertex/index data versions — the one vertex change that
 * really does need a new BLAS is a geometry EDIT, which bumps them.
 *
 * @param {Array<{mesh?: object}>} entries  GI placements; duplicates (one per
 *   instance of an InstancedMesh) collapse to one contribution, exactly as
 *   `#syncBvhScene`'s own `new Set(...)` does.
 * @returns {string} a stable hex key; equal keys mean an identical BVH.
 */
export function giBvhContentKey(entries) {
  if (!entries?.length) return "empty";
  let hash = 0x811c9dc5;
  const mix = (value) => {
    hash ^= (value | 0) & 0xffffffff;
    hash = Math.imul(hash, 0x01000193);
  };
  const seen = new Set();
  let counted = 0;
  for (const entry of entries) {
    const mesh = entry?.mesh;
    if (!mesh || seen.has(mesh)) continue;
    seen.add(mesh);
    counted++;
    mix(mesh.id ?? 0);
    mix(mesh.isSkinnedMesh ? 1 : 0);
    const geometry = mesh.geometry;
    mix(geometry?.id ?? 0);
    mix(geometry?.index?.count ?? 0);
    mix(geometry?.index?.version ?? 0);
    mix(geometry?.attributes?.position?.version ?? 0);
    mix(geometry?.attributes?.position?.count ?? 0);
  }
  return counted === 0 ? "empty" : (hash >>> 0).toString(16);
}

/**
 * Whether GI should be holding `scene.environmentNode` at black this tick.
 *
 * THE ARM IS A LATCH, NOT A LEVEL. `giLive` is the FIRST-install condition and
 * only that: suppressing the material IBL before the GI light is committed is
 * the "everything disappears, only the HDRI sky remains" report — the
 * background still draws the environment while every mesh loses its ambient
 * and the replacement light is not in the scene yet. But `giLive` is derived
 * from `_fieldReadyOnce`, which a rebuild, a half-built occupancy pyramid, a
 * dispatch waiting on a pipeline and a static-BVH rebuild all clear. Reading
 * it as a level handed the flat ambient back and took it away again around
 * each of those, and each flip re-minted every lit material: two
 * `[rebuilt: environment x11]` waves, 578 ms and 441 ms, inside a single GI
 * rebuild whose own compile wave had already reported "materials reused".
 *
 * Once GI has lit the scene, the honest answer to a transient is to stay put —
 * the end state is identical. The latch drops for the three things that
 * actually mean GI is no longer lighting this scene: the `__giKeepIBL` hatch,
 * the environment going away, and `dispose()`.
 *
 * @param {{keep?: boolean, hasEnvironment?: boolean, giLive?: boolean, latched?: boolean}} state
 * @returns {boolean}
 */
export function giEnvIblSuppressed({ keep = false, hasEnvironment = false, giLive = false, latched = false } = {}) {
  if (keep === true) return false;
  if (!hasEnvironment) return false;
  return giLive === true || latched === true;
}
