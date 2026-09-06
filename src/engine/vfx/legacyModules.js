/** Upgrade scene surface references formerly owned by the vfx module. */
export function legacySurfaceModules(engine, json) {
  if (!engine.modules?.has("vfx")) return [];
  const kinds = new Set();
  const walk = (nodes) => { for (const node of nodes ?? []) { for (const c of node.components ?? []) if (["cloth", "water"].includes(c.type) && !engine.modules.has(c.type)) kinds.add(c.type); walk(node.children); } };
  walk(json.entities);
  return [...kinds];
}
export async function migrateLegacySurfaceModules(engine, json) {
  const ids = legacySurfaceModules(engine, json);
  if (!ids.length) return;
  const { registerModuleDefinition, enableEngineModule } = await import("../modules.js");
  for (const id of ids) {
    const definition = id === "cloth" ? (await import("../../modules/cloth/index.js")).clothModule : (await import("../../modules/water/index.js")).waterModule;
    registerModuleDefinition(definition);
    await enableEngineModule(engine, id);
  }
}
