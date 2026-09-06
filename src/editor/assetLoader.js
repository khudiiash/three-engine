import { vmSingleton } from "./singleton.js";

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
// Source formats accepted by OS import/unpack. Only GLB is a runtime model
// asset; FBX is converted during import and must never reach ModelComponent.
export const MODEL_IMPORT_EXTENSIONS = ["glb", "fbx"];
export const TEXTURE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
export const SCRIPT_EXTENSIONS = ["js", "ts"];
export const MATERIAL_EXTENSIONS = ["mat"];
// Six-face cube map descriptor (JSON naming the face textures) — used as a
// scene skybox / IBL source. See src/engine/cubemapAsset.js.
export const CUBEMAP_EXTENSIONS = ["cubemap"];
// Equirectangular HDR panoramas — the other shape a sky comes in, and the one
// Poly Haven ships. See src/engine/environmentAsset.js.
export const HDRI_EXTENSIONS = ["hdr", "exr"];
// Everything the scene's sky slot (`settings.environment.cubemap`) accepts.
export const ENVIRONMENT_EXTENSIONS = [...CUBEMAP_EXTENSIONS, ...HDRI_EXTENSIONS];
// `.prefab` is the real thing (a linked, override-aware prefab asset).
// `.entity` is the legacy bare snapshot — still readable (it's upgraded to a
// prefab def on load), so old assets keep working.
export const PREFAB_EXTENSIONS = ["prefab", "entity"];
export const ANIMATOR_EXTENSIONS = ["anim"];
// Sequencer assets (.timeline) — keyframed properties plus animation, audio,
// event, activation and camera-shot tracks. See src/engine/timeline/.
export const TIMELINE_EXTENSIONS = ["timeline"];
export const GEOMETRY_EXTENSIONS = ["geom"];
// Post-process graphs (`.post`) — the node graph a camera's Postprocess
// component renders through. See src/modules/postprocessing/postAsset.js.
export const POST_EXTENSIONS = ["post"];
export const VFX_EXTENSIONS = ["vfx"];
// Sprite atlases (`.atlas`) — regions, pivots, nine-slice borders and sprite
// animations over an ordinary image. See src/engine/sprite/atlasAsset.js.
export const ATLAS_EXTENSIONS = ["atlas"];
// `.audio` is the JSON sidecar; the others are raw audio files the engine
// can decode straight away. AssetField filters both sidecars and raw files
// in one picker.
//
// The list is exactly what `decodeAudioData` handles in the browsers the engine
// targets — nothing is listed that would import cleanly and then fail to play.
// `flac` because Wikimedia Commons ships most field recordings that way;
// `m4a`/`opus`/`oga` because the Internet Archive does. Lossless is a poor
// choice to *ship* (5-10x an ogg), which is the Audio Editor's problem to flag,
// not the loader's.
export const AUDIO_EXTENSIONS = ["audio", "ogg", "oga", "wav", "mp3", "flac", "m4a", "opus"];
// Font files, used by UI Text and the Texture Editor's Text tool. Registered
// with the platform as generated `FontFace`s rather than by their declared
// family — see src/engine/ui/fontAsset.js for why.
export const FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2"];

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

/**
 * Recursively lists every project entry (files *and* folders) as the full
 * `list_dir` records, not just paths — the Assets panel needs size/date/type
 * to render its rows. Used for project-wide search, where "search" has to mean
 * the whole project and not just the folder that happens to be open.
 *
 * Sidecars (`.meta`, `.basis`) are included: callers hide them from the grid,
 * but the asset-flag loader reads the listing to learn which assets even have
 * a sidecar worth opening. Skips the scaffolded `engine-types/` directory,
 * which holds no project assets.
 */
export async function listProjectEntries(rootPath, depth = 8) {
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
    for (const entry of entries) {
      if (isEngineTypesPath(entry.path)) continue;
      out.push(entry);
      if (entry.is_dir) await walk(entry.path, d - 1);
    }
  }
  if (rootPath) await walk(rootPath, depth);
  return out;
}

/** Drops generated sidecars from a listing — they're managed via their asset
 *  (`.meta` / `.basis`) or live under Library as derived GI bake caches (`.sdf`). */
export const withoutSidecars = (entries) =>
  entries.filter(
    (entry) =>
      !entry.name.endsWith(".meta") &&
      !entry.name.endsWith(".basis") &&
      // The texture editor's layer stack, stored beside the image it belongs
      // to (see textureFile.js). Like `.meta`, it is an implementation detail
      // of an asset the user already sees, not an asset of its own.
      !entry.name.endsWith(".tex") &&
      // The audio editor's track stack, stored beside the sound it belongs to
      // (see audioFile.js). Same rationale as `.tex`.
      !entry.name.endsWith(".aud") &&
      !entry.name.endsWith(".sdf") &&
      !entry.name.endsWith(".gbvh"),
  );

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

/**
 * path -> object URL, and the set of things to tell when one is dropped.
 *
 * Both are VM-wide, not module-scope, and that is load-bearing rather than
 * tidiness. A second evaluation of this module (Vite's `?t=` twin, an HMR
 * update) used to get its OWN cache and its OWN listener set, which breaks the
 * live-update path in both directions: `invalidateBlobUrl` called on copy A
 * never reaches the geometry cache, the Assets-panel thumbnails or the frame
 * pacer, all of which subscribed through copy B; and the stale URL stays in
 * copy B's map, so the engine keeps resolving the OLD bytes. The symptom is
 * exactly the one this whole class of bug produces — the file on disk is
 * correct, so a restart looks like the fix.
 */
const cache = vmSingleton("assetLoaderCache", () => ({
  /** @type {Map<string, string>} path -> object URL */
  blobUrls: new Map(),
  /** @type {Map<string, Uint8Array>} path -> view into a shared native package */
  binaryAssets: new Map(),
  // Downstream caches that also key on asset path — the engine's decoded-geometry
  // cache, the Assets panel, the frame pacer. Registered by their owners rather
  // than imported here on purpose: this module is pulled in by lightweight editor
  // code (the Assets panel, asset flags) and must NOT drag `three/webgpu` behind it.
  /** @type {Set<(path: string) => void>} */
  listeners: new Set(),
}));
// A frontend hot update can reuse the pre-bulk-reader singleton created by an
// older evaluation of this module. Upgrade that object in place.
cache.binaryAssets ??= new Map();
const blobUrlCache = cache.blobUrls;
const binaryAssetCache = cache.binaryAssets;
const invalidationListeners = cache.listeners;

/** Subscribes `fn(path)` to every in-place asset overwrite. Returns an unsubscribe. */
export function onAssetInvalidated(fn) {
  invalidationListeners.add(fn);
  return () => invalidationListeners.delete(fn);
}

/** Drops a cached file URL after an editor overwrites an asset in place. */
export function invalidateBlobUrl(path) {
  const url = blobUrlCache.get(path);
  if (url) URL.revokeObjectURL(url);
  blobUrlCache.delete(path);
  binaryAssetCache.delete(path);
  for (const fn of invalidationListeners) fn(path);
}

/**
 * The file extension of `path`, lowercased and without the dot — `""` when
 * there isn't one.
 *
 * The dot has to be in the BASENAME, and there has to be a dot at all.
 * `split(".").pop()` returns the WHOLE STRING when the string contains no dot,
 * so every extension-less path — every FOLDER, most of all — used to report
 * its own full path as its extension. That is what made renaming a folder from
 * the Asset Inspector impossible: the rename appended the "extension" back on
 * and asked the filesystem for `NewName.c:/users/.../new folder`, which it
 * refused, and the refusal only ever reached the console. A dot anywhere in a
 * DIRECTORY name ("C:/My.Game/scripts/Rotator") produced the same nonsense for
 * files.
 *
 * A leading dot is a name, not an extension: `.gitignore` has no extension.
 */
export function extOf(path) {
  const base = String(path ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Git LFS keeps a large binary out of the repo, leaving a ~130-byte text stub
 * in the working tree and fetching the real bytes on checkout. A clone made
 * without LFS installed — and, far more often, a "Download ZIP" from a web UI,
 * which never expands them at all — leaves those stubs behind under the
 * original file names. They then reach an importer looking like nothing but a
 * corrupt model or texture.
 *
 * Returns the byte count the pointer promises (so a caller can say how much is
 * actually missing), or null when these bytes are not a pointer.
 *
 * Worth naming explicitly rather than letting a parser fail: "no FBX header
 * found" sends someone back to their DCC tool to re-export a file that was
 * never downloaded, while `git lfs pull` fixes it in one command.
 */
export function lfsPointerSize(head) {
  const bytes =
    typeof head === "string"
      ? null
      : ArrayBuffer.isView(head)
        ? new Uint8Array(head.buffer, head.byteOffset, head.byteLength)
        : new Uint8Array(head);
  // The spec fixes the version line first, so 200 bytes is always enough.
  const text = typeof head === "string" ? head : new TextDecoder().decode(bytes.subarray(0, 200));
  if (!text.startsWith("version https://git-lfs.github.com/spec/v1")) return null;
  return Number(text.match(/\bsize (\d+)/)?.[1] ?? 0);
}

/** The message an importer should surface for an unexpanded LFS pointer. */
export function lfsPointerMessage(fileName, size) {
  const mb = size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1024).toFixed(0)} KB`;
  return (
    `${fileName} is a Git LFS pointer, not the file itself — the real ${mb} was never downloaded. ` +
    `Run "git lfs pull" in the repository you got it from (or download it from that project's ` +
    `releases page); a "Download ZIP" from a web UI always leaves these stubs behind.`
  );
}

/**
 * Writes bytes to a project file over the RAW IPC channel.
 *
 * The obvious `invoke("write_binary_file", { path, contents: Array.from(bytes) })`
 * ships every byte as a JSON number — roughly 4 characters of text per byte,
 * built by a JS loop, serialized, then parsed again in Rust. A 40MB texture or
 * geometry buffer becomes ~160MB of JSON and many seconds of frozen UI.
 *
 * `write_binary_file_raw` takes the payload as the request body instead, so the
 * bytes are handed to the OS unchanged. The destination path travels as a
 * header, which may only hold visible ASCII — hence the percent-encoding, which
 * the Rust side reverses.
 */
let rawWriteSupported = true;

export async function writeBinaryFile(path, bytes) {
  const { invoke } = await import("@tauri-apps/api/core");
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // The Puppeteer Tauri shim implements the legacy JSON command, not Tauri's
  // raw IPC request body. Calling the raw form there cannot be represented by
  // `exposeFunction` and never resolves, so use the compatible route directly.
  if (globalThis.__tauriShimInvoke) {
    await invoke("write_binary_file", { path, contents: Array.from(payload) });
    invalidateBlobUrl(path);
    return;
  }
  if (rawWriteSupported) {
    try {
      await invoke("write_binary_file_raw", payload, {
        headers: { path: encodeURIComponent(path) },
      });
      invalidateBlobUrl(path);
      return;
    } catch (error) {
      // A *write* failure (bad path, disk full) must surface. Only fall back
      // when the command itself is unavailable — an app binary older than this
      // frontend, which happens whenever the web layer reloads without a
      // `cargo build`. Latch it so one probe covers the whole session.
      const message = String(error?.message ?? error);
      if (!/not (?:found|allowed)|unknown command|unhandled command|missing .*command/i.test(message)) throw error;
      console.warn(
        `write_binary_file_raw unavailable (${message}) — falling back to the ` +
          "slower JSON-array write. Rebuild the Tauri app to restore fast binary writes.",
      );
      rawWriteSupported = false;
    }
  }
  await invoke("write_binary_file", { path, contents: Array.from(payload) });
  invalidateBlobUrl(path);
}

const bytesView = (value) => {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
};

/**
 * Writes a fixed metadata header plus a large raw payload as one atomic file.
 *
 * The two views deliberately stay separate: joining them would allocate and
 * copy Bistro's ~158 MB BVH on the JS heap. The native command writes both to
 * a unique sibling temp, flushes it, then performs a platform-safe replace.
 * There is intentionally NO legacy JSON fallback; expanding a payload this
 * large into Array.from(...) is worse than treating persistence as unavailable.
 */
export async function writeAssetBinaryAtomic(path, header, payload) {
  const headerBytes = bytesView(header);
  const payloadBytes = bytesView(payload);
  if (headerBytes.byteLength !== 128) {
    throw new RangeError(`Atomic artifact header must be 128 bytes, got ${headerBytes.byteLength}`);
  }
  if (globalThis.__tauriShimInvoke) {
    throw new Error("Atomic raw binary writes require the native Tauri command");
  }
  let encodedHeader = "";
  for (const byte of headerBytes) encodedHeader += byte.toString(16).padStart(2, "0");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_binary_file_raw_atomic", payloadBytes, {
    headers: {
      path: encodeURIComponent(path),
      "artifact-header": encodedHeader,
    },
  });
  invalidateBlobUrl(path);
  return true;
}

/** Reads raw project bytes without a blob URL or JSON expansion. Derived-data
 * consumers (notably GI's packed BVH cache) need ownership of the ArrayBuffer
 * only until their GPU staging upload has been submitted. */
export async function readAssetBinary(path) {
  const cached = binaryAssetCache.get(path);
  if (cached) return cached;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const bytes = await invoke("read_binary_file", { path });
    if (bytes instanceof ArrayBuffer) return bytes;
    if (ArrayBuffer.isView(bytes)) {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return new Uint8Array(bytes ?? []).buffer;
  } catch {
    return null;
  }
}

const BINARY_PACKAGE_MAGIC = 0x314b5042; // "BPK1" in little endian
let bulkReadSupported = true;

function adoptBinaryPackage(paths, value) {
  const bytes = bytesView(value);
  if (bytes.byteLength < 8) throw new Error("truncated binary asset package");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0, true) !== BINARY_PACKAGE_MAGIC) throw new Error("invalid binary asset package");
  const count = header.getUint32(4, true);
  if (count !== paths.length || 8 + count * 8 > bytes.byteLength) {
    throw new Error("binary asset package index does not match request");
  }
  let payload = 8 + count * 8;
  for (let index = 0; index < count; index++) {
    const record = 8 + index * 8;
    const present = header.getUint32(record, true) !== 0;
    const length = header.getUint32(record + 4, true);
    if (payload + length > bytes.byteLength) throw new Error("truncated binary asset payload");
    if (present) {
      binaryAssetCache.set(
        paths[index],
        new Uint8Array(bytes.buffer, bytes.byteOffset + payload, length),
      );
    }
    payload += (length + 3) & ~3;
  }
}

async function preloadIndividually(paths, invoke) {
  // Compatibility with an older native executable during frontend HMR. Keep
  // enough reads in flight to hide IPC latency without flooding the bridge
  // with Bistro's ~1,500 requests at once.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(32, paths.length) }, async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      try {
        const value = await invoke("read_binary_file", { path });
        binaryAssetCache.set(path, bytesView(value));
      } catch {
        // The component loader reports an authored missing asset in context.
      }
    }
  });
  await Promise.all(workers);
}

/**
 * Preloads authored geometry, material, and texture bytes into one shared
 * IPC-backed buffer. Source images and their optional Basis siblings travel in
 * the same package so material loading does not resume per-file native IPC.
 */
export async function preloadAssetBinaries(paths) {
  const candidates = [];
  for (const path of paths ?? []) {
    if (typeof path !== "string") continue;
    if (/\.(?:geom|mat|basis|ktx2|png|jpe?g|webp)$/i.test(path)) candidates.push(path);
    // Basis-enabled textures load the generated sibling first. Reading both
    // variants in one native sweep is still vastly cheaper than hundreds of
    // per-texture IPC calls, and guarantees the source fallback is resident.
    if (/\.(?:png|jpe?g|webp)$/i.test(path)) candidates.push(`${path}.basis`);
  }
  const pending = [...new Set(candidates)].filter((path) => !binaryAssetCache.has(path));
  if (!pending.length) return 0;
  const { invoke } = await import("@tauri-apps/api/core");
  if (bulkReadSupported) {
    try {
      adoptBinaryPackage(pending, await invoke("read_binary_files", { paths: pending }));
      return pending.filter((path) => binaryAssetCache.has(path)).length;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not (?:found|allowed)|unknown command|unhandled command|missing .*command/i.test(message)) throw error;
      bulkReadSupported = false;
      console.warn("read_binary_files unavailable; using concurrent individual asset reads until the Tauri app is rebuilt.");
    }
  }
  await preloadIndividually(pending, invoke);
  return pending.filter((path) => binaryAssetCache.has(path)).length;
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
  const packed = binaryAssetCache.get(path);
  // `read_binary_file` returns raw bytes over the IPC channel, so `invoke`
  // resolves to an ArrayBuffer here (not a number array) — feed it to the
  // Blob directly. See the Rust command for why this matters for big models.
  let bytes = packed;
  if (!bytes) {
    const { invoke } = await import("@tauri-apps/api/core");
    bytes = await invoke("read_binary_file", { path });
  }
  const mime = MIME_BY_EXT[extOf(path)] ?? "application/octet-stream";
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(path, url);
  return url;
}

/** Reads a sidecar .meta JSON file; null when absent/invalid. */
/** Writes derived binary data (e.g. baked mesh SDFs) next to its asset. */
export async function writeAssetBinary(path, bytes) {
  await writeBinaryFile(path, bytes);
  return true;
}

export async function readAssetMeta(metaPath) {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return JSON.parse(await invoke("read_text_file", { path: metaPath }));
  } catch {
    return null;
  }
}

/**
 * Reads a scene file for `engine.loadScene`. Scenes are addressed by
 * PROJECT-RELATIVE path ("scenes/Level2.scene") so the exact same string a
 * script passes here also works in an exported build, where it is fetched as
 * a relative URL. An absolute path is accepted too — the editor's own
 * open-scene flow already has one in hand.
 */
export async function readSceneJson(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const { useProjectStore } = await import("./store/projectStore.js");
  const root = useProjectStore.getState().rootPath;
  const isAbsolute = /^([a-zA-Z]:[\\/]|\/)/.test(path);
  const full = isAbsolute || !root ? path : `${root}/${path}`;
  return JSON.parse(await invoke("load_scene", { path: full }));
}

/** path -> { version, default }. VM-wide for the same reason as the blob cache
 *  above: a duplicated module with its own cache re-imports every script on the
 *  next hot-reload poll, resetting each script's module state. */
const scriptModuleCache = vmSingleton("scriptModuleCache", () => new Map());

/** Cheap sniff: HTML / XML payloads can land in script slots when a project
 *  file with the wrong extension is dropped onto a script entity. esbuild
 *  will happily transpile them and the browser only fails once the JS parser
 *  hits `<html>` or `<!doctype`. Reject up-front with a clear error so the
 *  user sees "this isn't a script" instead of "Unexpected identifier 'html'". */
function looksLikeHtml(source) {
  if (typeof source !== "string") return false;
  const head = source.trimStart().slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml");
}

/**
 * Rewrites a module-import failure into the sentence that fixes it.
 *
 * The common one by far is importing an editor-only symbol from `"engine"`:
 * the browser then complains that `scriptRuntime/runtime.js` has no export
 * named `executeInEditMode` — an internal proxy path the user never wrote,
 * and no mention of the specifier they did write. Every other failure passes
 * through untouched.
 */
async function explainImportError(err) {
  const message = err?.message ?? String(err);
  const missing = /does not provide an export named ['"]?([A-Za-z_$][\w$]*)/.exec(message)?.[1];
  if (!missing) return message;
  try {
    const { specifierExporting } = await import("../engine/scriptRuntime.js");
    const home = await specifierExporting(missing);
    if (home) {
      return `"${missing}" comes from the "${home}" module — write \`import { ${missing} } from "${home}";\`.`;
    }
    return `nothing exports "${missing}". Check the spelling, or which module it belongs to.`;
  } catch {
    return message;
  }
}

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
  if (looksLikeHtml(raw)) {
    throw new Error(`Script "${path}" looks like HTML/markup, not JavaScript or TypeScript`);
  }
  let code;
  try {
    const { linkEngineImports } = await import("../engine/scriptRuntime.js");
    code = await linkEngineImports(await transpileScript(raw));
  } catch (err) {
    throw new Error(`Failed to transpile script "${path}": ${err.message ?? err}`);
  }
  const blob = new Blob([code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ url);
    const entry = { version, default: mod.default ?? null };
    scriptModuleCache.set(path, entry);
    return entry;
  } catch (err) {
    throw new Error(`Failed to import script "${path}": ${await explainImportError(err)}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
