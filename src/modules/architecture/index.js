import { ArchitectureComponent } from "./ArchitectureComponent.js";
import { ArchitecturePieceComponent } from "./ArchitecturePieceComponent.js";
import { LevelComponent } from "../level-design/LevelComponent.js";
import { LevelFloorComponent } from "../level-design/LevelFloorComponent.js";
import { BlockoutComponent } from "../level-design/BlockoutComponent.js";
import { ArchitectureEnvironment } from "./architectureEnvironment.js";
import { ArchitectureTerrainSystem } from "./ArchitectureTerrainSystem.js";

export const architectureModule = {
  id: "architecture",
  aliases: ["level-design"],
  name: "Architecture",
  version: "2.0.0",
  category: "World",
  tags: ["architecture", "building", "city", "bridge", "structure", "assembly", "level", "world", "3d"],
  description: "Freeform structures and assemblies, parametric buildings, custom footprints and seeded cities. Editable mesh parts integrate with terrain, water, foliage, physics and global illumination. Storeys are optional building settings.",
  // Legacy types remain readable in old scenes; new authoring uses the two
  // independent Architecture types exclusively.
  components: [ArchitectureComponent, ArchitecturePieceComponent, LevelComponent, LevelFloorComponent, BlockoutComponent],
  setup(engine) {
    const environment = new ArchitectureEnvironment(engine);
    engine.architecture = environment;
    const terrainSystem = new ArchitectureTerrainSystem(engine);
    engine.architectureTerrain = terrainSystem;
    // A scene can be opened before its optional module is enabled. Restore
    // those inert records without requiring a scene reload.
    for (const entity of engine.entities?.values?.() ?? []) {
      for (const cls of architectureModule.components) {
        const component = entity.getComponent(cls.type);
        if (component?.missingType === cls.type) {
          const props = structuredClone(component.props);
          entity.removeComponent(cls.type); entity.addComponent(new cls(props));
        }
      }
    }
    return { dispose() {
      terrainSystem.dispose(); environment.dispose();
      if (engine.architecture === environment) delete engine.architecture;
      if (engine.architectureTerrain === terrainSystem) delete engine.architectureTerrain;
    } };
  },
};
export { ArchitectureComponent, ArchitecturePieceComponent };
