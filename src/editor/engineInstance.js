// The editor's runtime engine. The actual Engine class plus all component
// classes and shader/particle graphs live in a heavy module graph (pulls in
// three/webgpu and registers every component at module load). To keep the
// boot path cheap we defer that import — and the `new Engine()` itself —
// until the first `await ensureEngine()` at a real entry point. The throw
// on direct `engine.X` access exists to catch any consumer that forgets to
// await; replace with `engineInstance` once it's resolved.

let engineInstance = null;
let loaderPromise = null;

async function loadEngine() {
  if (engineInstance) return engineInstance;
  if (!loaderPromise) {
    loaderPromise = (async () => {
      const [{ Engine, setAssetResolver, setScriptLoader, setAssetMetaLoader }, { toBlobUrl, loadScriptModule, readAssetMeta }] =
        await Promise.all([import("../engine/index.js"), import("./assetLoader.js")]);
      const inst = new Engine();
      // The runtime stays fs-agnostic; the editor supplies the actual
      // path -> URL resolution (Tauri fs read -> blob: URL) and script
      // loading so components can stay portable.
      setAssetResolver(toBlobUrl);
      setScriptLoader(loadScriptModule);
      setAssetMetaLoader(readAssetMeta);
      engineInstance = inst;
      return inst;
    })();
  }
  return loaderPromise;
}

/** Resolves to the singleton Engine. Safe to await multiple times. */
export function ensureEngine() {
  return loadEngine();
}

/**
 * Backwards-compatible shim. The Proxy returns `engineInstance` once it's
 * resolved and throws a helpful error during the load window — that window
 * is short (the engine is awaited in `EditorShell`'s mount effect before any
 * UI interaction is possible), and the throw makes any forgotten `await`
 * obvious instead of silently returning undefined.
 */
export const engine = new Proxy(function () {}, {
  get(_target, prop) {
    if (prop === "then") return undefined; // not a thenable
    if (!engineInstance) {
      if (import.meta.env?.DEV) {
        throw new Error(
          "engine accessed before `await ensureEngine()` — fix the consumer to await.",
        );
      }
      throw new Error("engine not initialized; await ensureEngine() first");
    }
    const value = engineInstance[prop];
    return typeof value === "function" ? value.bind(engineInstance) : value;
  },
  // Without a set trap, writes like `engine.camera = ...` would land on the
  // dummy Proxy target and silently never reach the real engine.
  set(_target, prop, value) {
    if (!engineInstance) {
      throw new Error("engine assigned before `await ensureEngine()` — fix the consumer to await.");
    }
    engineInstance[prop] = value;
    return true;
  },
});
