import { GISystem } from "./GISystem.js";
import { GlobalIlluminationComponent } from "./GlobalIlluminationComponent.js";

export { GISystem, GlobalIlluminationComponent };
export { computeAutoClipmapLayout } from "./GISystem.js";
export {
  voxelizeScene,
  voxelizeRegion,
  voxelizeRegionAsync,
  shiftGrid,
  computeGrid,
  isVoxelizableMesh,
  voxelIndex,
} from "./voxelizer.js";
export { createDeferredGI } from "./giDeferred.js";
export {
  DynamicVoxelPool,
  createDynamicVoxelNodes,
  MAX_DYNAMIC_MESHES,
  DYNAMIC_TRI_CAPACITY,
  VEC4S_PER_TRI,
} from "./gpuVoxelizer.js";
export { createSDFNodes, SDF_MAX, SDF_CONVERGE_FRAMES } from "./sdfField.js";
export { createSunShadowNode } from "./dfShadows.js";
export {
  bakeMeshSDF,
  MeshSDFAtlas,
  MeshSDFShadows,
  createMeshSDFSunShadowNode,
  MESH_SDF_SLOT,
  MESH_SDF_CAPACITY,
} from "./meshSDF.js";
export {
  CapsuleShadows,
  extractSkinnedCapsules,
  collectSkinnedMeshes,
  MAX_CAPSULES,
} from "./capsuleShadows.js";
export {
  TriangleRayScene,
  clearRayProxyCache,
  buildRayProxyAsset,
  buildRayProxyBLAS,
  hashRayProxySource,
  RAY_PROXY_VERSION,
  RAY_PROXY_MIN_TRIANGLES,
  RAY_PROXY_MAX_TRIANGLES,
  RAY_BVH_NODE_STRIDE,
  RAY_TRIANGLE_STRIDE,
  RAY_BVH_LEAF_SIZE,
  RAY_GPU_DATA_CAPACITY_VEC4,
} from "./rayProxy.js";
export {
  fibonacciDirections,
  octaTexelDirections,
  octaTexelDirection,
  computeMipLevels,
  RAYS_PER_PROBE,
  OCTA_RES,
  MIP_GAP,
  MAX_LOCAL_LIGHTS,
} from "./giCompute.js";

/**
 * Global Illumination module — dynamic diffuse GI ("Lumen-lite").
 *
 * Add a Global Illumination component to any entity: the active camera
 * automatically receives nested voxel/probe clipmaps covering its frustum.
 * Directional/point/spot lights, sky, emissive surfaces, and multi-bounce
 * feedback update through one WebGPU radiance field; diffuse GI is evaluated
 * once at half resolution and reconstructed edge-aware in lit materials.
 * The screen resolve is deterministic and history-free. Temporal response
 * lives in the world-space radiance/opacity cache, probes, and smoothly
 * faded clipmap publication, so camera motion cannot create reprojection
 * trails or diagonal history patterns.
 *
 * Designed to compose with the postprocessing module's SSGI: probes provide
 * the world-space low-frequency GI (including off-screen light), SSGI layers
 * near-field contact detail on top.
 */
export const giModule = {
  id: "gi",
  name: "Global Illumination",
  version: "1.0.0",
  category: "Rendering",
  tags: ["rendering", "lighting", "gi", "probes", "voxel", "compute"],
  description:
    "Camera-driven dynamic GI: automatic clipmaps, unified light/emissive injection, " +
    "off-volume emitter coverage, occlusion-aware multi-bounce, temporally accumulated " +
    "probe gathering, GPU-voxelized dynamic objects, shadow-map direct lighting, and " +
    "opt-in triangle probe rays with directional visibility moments.",
  components: [GlobalIlluminationComponent],
  async setup(engine) {
    const system = new GISystem(engine);
    return { system, dispose: () => system.dispose() };
  },
};
