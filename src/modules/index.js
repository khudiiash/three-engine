import { registerModuleDefinition } from "../engine/modules.js";
import { physicsRapierModule } from "./physics-rapier/index.js";

/**
 * Built-in module catalog. Importing this file registers every definition;
 * nothing runs until a host enables a module on an engine (editor: Modules
 * panel / project.json `modules`; player: scene.json `modules`).
 *
 * Modules live outside src/engine but obey the same rule: no React, no
 * Tauri — they ship with exported games.
 */
registerModuleDefinition(physicsRapierModule);

export { physicsRapierModule };
