const MIME_BY_EXT = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  hdr: "application/octet-stream",
};

export const MODEL_EXTENSIONS = ["glb"];
export const TEXTURE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
export const SCRIPT_EXTENSIONS = ["js", "ts"];
export const MATERIAL_EXTENSIONS = ["mat"];
export const PREFAB_EXTENSIONS = ["entity"];
export const ANIMATOR_EXTENSIONS = ["anim"];

/** Recursively lists project files matching the extensions (for asset pickers). */
export async function listProjectAssets(rootPath, exts, depth = 4) {
  const { invoke } = await import("@tauri-apps/api/core");
  const out = [];
  async function walk(path, d) {
    if (d < 0) return;
    let entries;
    try {
      entries = await invoke("list_dir", { path });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.is_dir) await walk(e.path, d - 1);
      else if (exts.includes(e.ext)) out.push(e.path);
    }
  }
  if (rootPath) await walk(rootPath, depth);
  return out;
}

let esbuildReady = null;

/** Lazily boots esbuild-wasm once (used to transpile TS + decorators). */
function getEsbuild() {
  if (!esbuildReady) {
    esbuildReady = (async () => {
      const esbuild = await import("esbuild-wasm");
      const wasmURL = (await import("esbuild-wasm/esbuild.wasm?url")).default;
      await esbuild.initialize({ wasmURL });
      return esbuild;
    })();
  }
  return esbuildReady;
}

/** TS/decorators -> plain JS with "engine" imports linked to the runtime blob. */
export async function transpileScript(code) {
  const esbuild = await getEsbuild();
  const result = await esbuild.transform(code, {
    loader: "ts",
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  return result.code;
}

const blobUrlCache = new Map(); // path -> object URL

export function extOf(path) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Reads a project file's bytes over Tauri and returns a cached blob: URL.
 * Only self-contained formats (.glb, plain images) are safe here — a blob
 * URL has no base path, so a .gltf referencing sibling .bin/textures would
 * fail to resolve those references.
 */
export async function toBlobUrl(path) {
  const cached = blobUrlCache.get(path);
  if (cached) return cached;
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("read_binary_file", { path });
  const mime = MIME_BY_EXT[extOf(path)] ?? "application/octet-stream";
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(path, url);
  return url;
}

/** Reads a sidecar .meta JSON file; null when absent/invalid. */
export async function readAssetMeta(metaPath) {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return JSON.parse(await invoke("read_text_file", { path: metaPath }));
  } catch {
    return null;
  }
}

const scriptModuleCache = new Map(); // path -> { version, default }

/**
 * Loads a script file as an ES module, keyed by mtime so unchanged files are
 * never re-imported (re-importing would reset any module-level state). This
 * is the hot-reload check: callers re-invoke it periodically and compare the
 * returned `version` to what they last saw.
 */
export async function loadScriptModule(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const version = await invoke("stat_file", { path });
  const cached = scriptModuleCache.get(path);
  if (cached && cached.version === version) return cached;

  const raw = await invoke("read_text_file", { path });
  const { linkEngineImports } = await import("../engine/scriptRuntime.js");
  const code = linkEngineImports(await transpileScript(raw));
  const blob = new Blob([code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ url);
    const entry = { version, default: mod.default ?? null };
    scriptModuleCache.set(path, entry);
    return entry;
  } finally {
    URL.revokeObjectURL(url);
  }
}
