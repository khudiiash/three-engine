import { MATERIAL_DEFAULTS } from "../engine/materialAsset.js";

/** Make an entity name safe as a material filename while keeping it readable. */
export function materialStemForEntity(name) {
  const stem = String(name ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return stem || "Mesh";
}

/** Choose a collision-free filename using the same suffix style as Assets. */
export function uniqueMaterialName(entityName, entries = []) {
  const stem = materialStemForEntity(entityName);
  const names = new Set(entries.map((entry) => String(entry?.name ?? "").toLowerCase()));
  const base = `${stem}.mat`;
  if (!names.has(base.toLowerCase())) return base;
  for (let index = 1; ; index++) {
    const candidate = `${stem} ${index}.mat`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Persist the first edit made to the virtual Default material. The callbacks
 * keep filesystem and scene mutation policy in the panel while making the
 * path/naming/write sequence independently testable.
 */
export async function createDefaultMaterialFork({
  rootPath,
  entityName,
  graph,
  listDirectory,
  saveFile,
}) {
  if (!rootPath) throw new Error("Open a project before editing the Default material.");
  const directory = `${String(rootPath).replace(/[\\/]$/, "")}/materials`;
  let entries = [];
  try {
    entries = await listDirectory(directory);
  } catch {
    // The project's materials folder is intentionally created on first use.
  }
  const path = `${directory}/${uniqueMaterialName(entityName, entries)}`;
  const def = { ...MATERIAL_DEFAULTS, shaderGraph: graph };
  await saveFile(path, JSON.stringify(def, null, 2));
  return path;
}
