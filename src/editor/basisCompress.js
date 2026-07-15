import { useModulesStore } from "./modules.js";
import { useProjectStore } from "./store/projectStore.js";
import { useAssetProcessingStore } from "./store/assetProcessingStore.js";
import { basename } from "./store/projectStore.js";
import {
  invalidateBlobUrl,
  listProjectAssets,
  readAssetMeta,
  TEXTURE_EXTENSIONS,
} from "./assetLoader.js";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export function isBasisEnabled() {
  return useModulesStore.getState().enabled.includes("basis");
}

async function writeMeta(path, basis) {
  const current = (await readAssetMeta(`${path}.meta`)) ?? {};
  const next = { ...current, basis };
  await invoke("save_scene", {
    path: `${path}.meta`,
    contents: JSON.stringify(next, null, 2),
  });
  return next;
}

/** Compresses a texture source without replacing it. */
export async function compressTextureBasis(path) {
  return useAssetProcessingStore.getState().track(
    (p) => `Compressing ${basename(p)}…`,
    (p) => compressTextureBasisImpl(p),
    path,
  );
}

async function compressTextureBasisImpl(path) {
  const info = await invoke("compress_texture_basis", { path });
  invalidateBlobUrl(`${path}.basis`);
  await writeMeta(path, { enabled: true, ...info });
  return info;
}

/** Applies the inspector override and creates/removes its derivative. */
export async function setTextureBasisEnabled(path, enabled) {
  if (enabled && !isBasisEnabled()) {
    throw new Error("Enable the Basis Compression module first");
  }
  if (enabled) return compressTextureBasis(path);
  await invoke("delete_path", { path: `${path}.basis` }).catch(() => {});
  invalidateBlobUrl(`${path}.basis`);
  await writeMeta(path, { enabled: false });
  return null;
}

/** Compresses every texture that has not explicitly opted out. */
export async function compressAllProjectTextures() {
  return useAssetProcessingStore.getState().track(
    "Compressing project textures…",
    () => compressAllProjectTexturesImpl(),
  );
}

async function compressAllProjectTexturesImpl() {
  const root = useProjectStore.getState().rootPath;
  if (!root) return { compressed: 0, failed: 0 };
  const paths = await listProjectAssets(root, TEXTURE_EXTENSIONS, 20);
  let compressed = 0;
  let failed = 0;
  for (const path of paths) {
    const meta = await readAssetMeta(`${path}.meta`);
    if (meta?.basis?.enabled === false) continue;
    try {
      await compressTextureBasisImpl(path);
      compressed++;
    } catch (err) {
      failed++;
      console.warn(`Basis compression skipped for ${path}: ${err.message ?? err}`);
    }
  }
  return { compressed, failed };
}

/** Import hook: the module is a global default, explicit asset opt-out wins. */
export async function autoCompressTexture(path) {
  if (!isBasisEnabled()) return null;
  const meta = await readAssetMeta(`${path}.meta`);
  if (meta?.basis?.enabled === false) return null;
  return compressTextureBasis(path);
}
