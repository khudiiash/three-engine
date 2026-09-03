// CPU-side format negotiation for the static exact-triangle acceleration.
// The placement payload is production-packable/cacheable now, but it must not
// become GPU-live until its TLAS traversal exists. Keeping that capability an
// explicit argument prevents a debug global from feeding SBV2 bytes to the
// legacy world-soup WGSL.

export const STATIC_BVH_FORMAT_WORLD = "world-v1";
export const STATIC_BVH_FORMAT_PLACEMENT = "placement-v1";

export const STATIC_BVH_WORLD_BUILDER_ABI = 1;
export const STATIC_BVH_PLACEMENT_BUILDER_ABI = 3;

export const STATIC_BVH_WORLD_PACKER_ID =
  "bvh8-node28-leaf8-slottri10-halfuv3-three-mesh-bvh-0.9.13";
export const STATIC_BVH_PLACEMENT_PACKER_ID =
  "sbv2-tlas8-stableplace24-local-bvh8-node28-tri9-halfuv3-three-mesh-bvh-0.9.13";

export function normalizeStaticBvhFormat(value) {
  const name = String(value ?? STATIC_BVH_FORMAT_WORLD).trim().toLowerCase();
  return name === STATIC_BVH_FORMAT_PLACEMENT || name === "placement" || name === "sbv2"
    ? STATIC_BVH_FORMAT_PLACEMENT
    : STATIC_BVH_FORMAT_WORLD;
}

export function staticBvhFormatDescriptor(requested, { placementTraversal = false } = {}) {
  const wanted = normalizeStaticBvhFormat(requested);
  const supported = wanted !== STATIC_BVH_FORMAT_PLACEMENT || placementTraversal === true;
  const format = supported ? wanted : STATIC_BVH_FORMAT_WORLD;
  return {
    requested: wanted,
    format,
    fallback: !supported,
    fallbackReason: supported ? null : "placement TLAS traversal is not compiled",
    builderAbi: format === STATIC_BVH_FORMAT_PLACEMENT
      ? STATIC_BVH_PLACEMENT_BUILDER_ABI
      : STATIC_BVH_WORLD_BUILDER_ABI,
    packerId: format === STATIC_BVH_FORMAT_PLACEMENT
      ? STATIC_BVH_PLACEMENT_PACKER_ID
      : STATIC_BVH_WORLD_PACKER_ID,
    artifactVersion: format === STATIC_BVH_FORMAT_PLACEMENT ? 2 : 1,
  };
}
