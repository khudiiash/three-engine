// The runtime never talks to Tauri/fs directly (so exported games can serve
// assets over plain HTTP). The editor swaps in a resolver at startup that
// turns project file paths into loadable blob: URLs.
let resolve = async (path) => path;

export function setAssetResolver(fn) {
  resolve = fn;
}

export function resolveAssetUrl(path) {
  return resolve(path);
}

// Sidecar `<asset>.meta` JSON (texture import settings etc.). The default
// loader returns null (no settings); the editor reads the file over Tauri,
// the player fetches it over HTTP.
let loadMeta = async () => null;

export function setAssetMetaLoader(fn) {
  loadMeta = fn;
}

export async function loadAssetMeta(path) {
  try {
    return await loadMeta(path);
  } catch {
    return null;
  }
}

// Same idea for script components: the editor supplies a loader that reads
// a script file, wraps it as an ES module, and reports a version so callers
// can tell whether the file changed since the last load (hot reload).
let loadScript = async () => ({ default: null, version: null });

export function setScriptLoader(fn) {
  loadScript = fn;
}

export function loadScriptModule(path) {
  return loadScript(path);
}
