import { GISystem } from "./GISystem.js";
import { GlobalIlluminationComponent } from "./GlobalIlluminationComponent.js";

export { GISystem, GlobalIlluminationComponent };
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
  fibonacciDirections,
  octaTexelDirections,
  octaTexelDirection,
  computeMipLevels,
  RAYS_PER_PROBE,
  OCTA_RES,
  MIP_GAP,
} from "./giCompute.js";

/**
 * Global Illumination module — dynamic diffuse GI ("Lumen-lite").
 *
 * Add a Global Illumination component to any entity: it defines a world-space
 * volume in which the scene is voxelized (CPU, on scene changes only) and a
 * grid of irradiance probes is updated round-robin in WebGPU compute every
 * frame — direct sun with voxel-traced shadows, sky ambient, and one-bounce
 * feedback. Probe irradiance feeds into every lit material's indirect
 * diffuse through a custom light node; nothing per-material to configure.
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
    "Dynamic diffuse GI: voxelized scene + irradiance probe grid updated in compute. " +
    "Add a Global Illumination component to an entity to define the volume.",
  components: [GlobalIlluminationComponent],
  async setup(engine) {
    const system = new GISystem(engine);
    return { system, dispose: () => system.dispose() };
  },
};
