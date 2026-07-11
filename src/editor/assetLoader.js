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
// `.audio` is the JSON sidecar; the others are raw audio files the engine
// can decode straight away. AssetField filters both sidecars and raw files
// in one picker.
export const AUDIO_EXTENSIONS = ["audio", "ogg", "wav", "mp3"];

/** TypeScript declaration files (`.d.ts` / `.d.mts` / `.d.cts`) are never
 *  runtime scripts — they're ambient type-only declarations the editor
 *  scaffolds into the project root so the user's IDE can resolve
 *  `import { Script } from "engine"`. Always exclude them from the script
 *  picker regardless of the requested extensions. */
function isDeclarationFile(name) {
  // Matches .d.ts, .d.mts, .d.cts (the three TypeScript declaration file
  // flavors). The script-ext list intentionally accepts ".ts" so we have
  // to filter declaration files out by suffix — they're ambient types
  // only and can't be loaded as runtime modules.
  return /\.d\.(?:c|m)?ts$/i.test(name);
}

/** The `engine-types/` directory holds ambient TypeScript declarations copied
 *  in by `projectTypes.scaffoldProjectTypes` (see that module for the full
 *  rationale). None of its contents are valid script assets. */
function isEngineTypesPath(path) {
  return /[\\/]engine-types(?:[\\/]|$)/i.test(path);
}

/** Recursively lists project files matching the extensions (for asset pickers).
 *  Always skips TypeScript declaration files (`.d.ts` and friends) and anything
 *  inside the editor-scaffolded `engine-types/` directory — those are never
 *  runtime scripts. */
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
      if (e.is_dir) {
        // Skip the editor-scaffolded declarations directory entirely.
        if (isEngineTypesPath(e.path)) continue;
        await walk(e.path, d - 1);
      } else if (exts.includes(e.ext) && !isDeclarationFile(e.name) && !isEngineTypesPath(e.path)) {
        out.push(e.path);
      }
    }
  }
  if (rootPath) await walk(rootPath, depth);
  return out;
}

// esbuild-wasm's `initialize()` throws "Cannot call 'initialize' more than
// once" if called twice in the same VM. Vite's HMR can re-evaluate this
// module on dependency changes (e.g. when scriptRuntime.js gains a new
// import), which would reset the module-local `esbuildReady` cache while
// leaving the underlying esbuild-wasm module — and its own initialize
// state — untouched. Pin the cache to the global scope so the second
// evaluation reads the same promise the first one stored.
const ESBUILD_CACHE_KEY = Symbol.for("three-engine.esbuildReady");
const esbuildState = (globalThis[ESBUILD_CACHE_KEY] ??= { ready: null });

/** Lazily boots esbuild-wasm once per VM (used to transpile TS + decorators).
 *  Subsequent calls — including from HMR-reloaded instances of this module —
 *  return the same in-flight or settled promise. */
function getEsbuild() {
  if (!esbuildState.ready) {
    esbuildState.ready = (async () => {
      const esbuild = await import("esbuild-wasm");
      const wasmURL = (await import("esbuild-wasm/esbuild.wasm?url")).default;
      try {
        await esbuild.initialize({ wasmURL });
      } catch (err) {
        // `initialize` throws "Cannot call 'initialize' more than once"
        // when esbuild-wasm has already been initialized in this VM — a
        // legit case under Vite HMR when this module is re-evaluated
        // alongside its dependencies. Treat that as success and reuse
        // the loaded module. Re-throw only for genuine init failures.
        const msg = String(err?.message ?? "");
        if (!/cannot call .initialize. more than once/i.test(msg)) throw err;
      }
      return esbuild;
    })();
  }
  return esbuildState.ready;
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
  // `read_binary_file` returns raw bytes over the IPC channel, so `invoke`
  // resolves to an ArrayBuffer here (not a number array) — feed it to the
  // Blob directly. See the Rust command for why this matters for big models.
  const bytes = await invoke("read_binary_file", { path });
  const mime = MIME_BY_EXT[extOf(path)] ?? "application/octet-stream";
  const blob = new Blob([bytes], { type: mime });
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
  const code = await linkEngineImports(await transpileScript(raw));
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
