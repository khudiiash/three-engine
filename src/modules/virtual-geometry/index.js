import { VirtualGeometrySystem } from "./VirtualGeometrySystem.js";

export {
  refreshVirtualGeometryAsset,
  setVirtualGeometryDebugVisible,
  VIRTUAL_GEOMETRY_META_DEFAULTS,
} from "./VirtualGeometrySystem.js";

/**
 * Virtual geometry module — Nanite-style cluster LOD for high-density static
 * meshes. Unreal-style asset workflow: no component to add — a model opts in
 * via its import settings (asset inspector → Virtual Geometry), and every
 * Model component using it renders through the pipeline automatically.
 *
 * The model is preprocessed once into a hierarchy of ~128-triangle clusters
 * with per-cluster error bounds (meshoptimizer WASM, loaded lazily on first
 * use); at runtime the system picks, per frame, the set of clusters whose
 * projected screen-space error stays under the asset's pixel threshold —
 * near geometry renders full detail, distant geometry collapses to a handful
 * of triangles, crack-free, in one draw call per source mesh.
 */
export const virtualGeometryModule = {
  id: "virtual-geometry",
  name: "Virtual Geometry",
  version: "1.0.0",
  category: "Optimization",
  tags: ["lod", "mesh", "cluster", "nanite", "wasm", "rendering"],
  description:
    "Nanite-style cluster LOD: models opted in via their import settings render " +
    "with a triangle count that follows screen-space error instead of mesh density.",
  components: [],
  async setup(engine) {
    const system = new VirtualGeometrySystem(engine);
    return { system, dispose: () => system.dispose() };
  },
};
