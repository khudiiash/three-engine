import { invoke, joinPath } from "./assetOps.js";
import { invalidateBlobUrl } from "./assetLoader.js";
import { useProjectStore } from "./store/projectStore.js";
import { parseVfxAsset, serializeVfxAsset, publishVfxAsset } from "../engine/vfx/vfxAsset.js";

function resolved(path) {
  const raw = String(path ?? "").replaceAll("\\", "/");
  const prefix = /^(\/|[A-Za-z]:\/)/.exec(raw)?.[0];
  if (!prefix) throw new Error("VFX assets require an absolute project path.");
  const parts = [];
  for (const part of raw.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) throw new Error("Invalid VFX asset path."); parts.pop(); }
    else parts.push(part);
  }
  return prefix + parts.join("/");
}

export function vfxDocumentPath(path) {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project to use VFX assets.");
  const raw = String(path ?? "");
  const target = resolved(/^(\/|[A-Za-z]:[\\/])/.test(raw) ? raw : joinPath(root, raw));
  if (!target.toLowerCase().startsWith(`${resolved(root).toLowerCase()}/`)) throw new Error("VFX assets must be inside the open project.");
  if (!/\.vfx$/i.test(target)) throw new Error("VFX assets use the .vfx extension.");
  return target;
}

export async function readVfxDocument(path) {
  return parseVfxAsset(await invoke("read_text_file", { path: vfxDocumentPath(path) }));
}

export async function writeVfxDocument(path, document) {
  const target = vfxDocumentPath(path);
  const contents = serializeVfxAsset(document);
  await invoke("save_scene", { path: target, contents });
  invalidateBlobUrl(target);
  await publishVfxDocument(target, document);
  return target;
}

export async function createVfxDocument(fileName, document) {
  let name = String(fileName ?? "").trim();
  if (!name || /[\\/:*?"<>|]/.test(name) || name === "." || name === "..") throw new Error("Enter a filename without folders or reserved characters.");
  if (!/\.vfx$/i.test(name)) name += ".vfx";
  const { currentPath, refresh } = useProjectStore.getState();
  const requested = vfxDocumentPath(joinPath(currentPath, name));
  // Read the directory now: cached asset-browser entries can miss a recent save.
  const entries = await invoke("list_dir", { path: currentPath });
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  let available = name, suffix = 1;
  while (names.has(available.toLowerCase())) available = `${name.slice(0, -4)} ${suffix++}.vfx`;
  const target = requested.slice(0, requested.lastIndexOf("/") + 1) + available;
  await writeVfxDocument(target, document);
  await refresh();
  return target;
}

/** Notify absolute and project-relative references to the same document. */
export async function publishVfxDocument(path, document) {
  const target = vfxDocumentPath(path);
  publishVfxAsset(target, document);
  const relative = target.slice(resolved(useProjectStore.getState().rootPath).length + 1);
  if (path !== target) publishVfxAsset(path, document);
  publishVfxAsset(relative, document);
  const { engine } = await import("./engineInstance.js");
  for (const entity of engine.entities?.values?.() ?? []) {
    for (const kind of ["particles", "cloth", "water"]) {
      const alias = entity.getComponent?.(kind)?.props?.asset;
      if (!alias || alias === target) continue;
      try { if (vfxDocumentPath(alias).toLowerCase() === target.toLowerCase()) publishVfxAsset(alias, document); } catch {}
    }
  }
}
