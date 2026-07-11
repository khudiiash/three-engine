import { TerrainComponent } from "./TerrainComponent.js";

/**
 * Terrain module. Adds a heightmap-sculpted, splatmap-painted ground surface
 * (the Terrain component). Optional and off by default — enable it per project
 * (editor Modules panel / project.json `modules`) so games that don't use
 * terrain never ship the component.
 *
 * There's no per-engine runtime system to install: the component owns its own
 * geometry/material and is driven entirely by data + the editor's brush tools,
 * so the module just contributes the component class. Physics collision for a
 * terrain comes from the Rapier module's Collider `heightfield` shape, which
 * reads this component when both modules are enabled.
 */
export const terrainModule = {
  id: "terrain",
  name: "Terrain",
  version: "1.0.0",
  description:
    "Heightmap terrain with a sculpt brush " +
    "and up to four splatmap-blended PBR material layers you paint by hand.",
  components: [TerrainComponent],
};
