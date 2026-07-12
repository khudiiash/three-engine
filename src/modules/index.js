import { registerModuleDefinition } from "../engine/modules.js";
import { physicsRapierModule } from "./physics-rapier/index.js";
import { dracoModule } from "./draco/index.js";
import { basisModule } from "./basis/index.js";
import { terrainModule } from "./terrain/index.js";
import { virtualGeometryModule } from "./virtual-geometry/index.js";
import { postprocessingModule } from "./postprocessing/index.js";
import { polyhavenModule } from "./polyhaven/index.js";

/**
 * Built-in module catalog. Importing this file registers every definition;
 * nothing runs until a host enables a module on an engine (editor: Modules
 * panel / project.json `modules`; player: scene.json `modules`).
 *
 * Modules live outside src/engine but obey the same rule: no React, no
 * Tauri — they ship with exported games.
 */
registerModuleDefinition(physicsRapierModule);
registerModuleDefinition(dracoModule);
registerModuleDefinition(basisModule);
registerModuleDefinition(terrainModule);
registerModuleDefinition(virtualGeometryModule);
registerModuleDefinition(postprocessingModule);
registerModuleDefinition(polyhavenModule);

export { physicsRapierModule, dracoModule, basisModule, terrainModule, virtualGeometryModule, postprocessingModule, polyhavenModule };
