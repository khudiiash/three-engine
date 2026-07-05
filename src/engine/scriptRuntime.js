/**
 * Runtime support for user scripts. Scripts import from the bare specifier
 * "engine" (e.g. `import { Script, attribute, Vector3 } from "engine"`),
 * which blob-URL / data-URL module imports can't resolve to anything — so
 * loaders rewrite it to the absolute URL of `./scriptRuntime/runtime.js`
 * via linkEngineImports() before importing.
 *
 * `runtime.js` is a real ES module that:
 *   - Defines `Script` (empty base class for typed `this` access) and
 *     the `attribute` decorator. ScriptComponent injects `entity` /
 *     `engine` / `THREE` / `input` on every script instance regardless
 *     of base class, so the runtime base exists only to make
 *     `extends Script` a typed no-op.
 *   - Re-exports three.js classes (Vector2 / Vector3 / Quaternion /
 *     Euler / Matrix4 / Color / Object3D / Camera / MathUtils) so user
 *     scripts can `import { Vector3 } from "engine"` and get the same
 *     constructor the engine itself uses — real instances with full
 *     methods, not just a type alias.
 *
 * ## Why an absolute URL (not a relative path)
 *
 * Users import scripts via `import(blobUrl)` from a blob or data URL,
 * which is a non-hierarchical scheme. Import specifiers inside such
 * scripts are resolved against the blob's URL — but a relative path
 * ("./runtime.js") can't be resolved against a non-hierarchical base,
 * and an absolute path ("/src/engine/.../runtime.js") looks like a
 * scheme-relative URL which the browser tries to resolve against the
 * blob's (nonexistent) scheme. Either way the browser refuses with
 * "Invalid relative url or base scheme isn't hierarchical".
 *
 * `new URL('…', import.meta.url).href` produces an absolute http(s)
 * URL — fully qualified, no base needed — in both dev (Vite serves
 * `scriptRuntime.js` from a real origin) and prod (Vite emits chunks
 * under the same origin as `index.html`). The resulting `from "http…"`
 * inside a blob/data URL resolves directly against the absolute URL
 * the browser already knows about.
 *
 * ## Lazy resolution
 *
 * `import.meta.url` is the URL of THIS file. Once scriptRuntime.js is
 * loaded, that URL is fixed for the lifetime of the runtime, so we cache
 * the resolved runtime URL on first call. Asynchronous so callers
 * (assetLoader, player/main) can `await linkEngineImports(...)` without
 * re-engineering existing promise-based flows.
 */
// `import.meta.url` is `undefined` in classic scripts but always present
// in ES modules. `scriptRuntime.js` is imported as ESM from the editor
// shell and from the player entry, so the URL is reliably available.
//
// Vite/Rollup statically analyze `new URL(..., import.meta.url)` calls and
// resolve them at build time — in production the runtime is inlined as a
// base64 data URL into scriptRuntime.js's chunk; in dev the dev server
// URL is used directly. We pass that absolute URL through to user scripts
// (which load from blob URLs) so it bypasses any base-URL resolution.
const RUNTIME_URL =
  typeof import.meta.url === "string" && import.meta.url
    ? new URL("./scriptRuntime/runtime.js", import.meta.url).href
    : null;

// Synchronous helper: when `import.meta.url` is known (the production /
// dev browser case), the URL is computable up-front. Synchronous callers
// (e.g. tests, hot reload) can read this without awaiting anything.
export function getRuntimeUrlSync() {
  if (RUNTIME_URL) return RUNTIME_URL;
  throw new Error(
    "getRuntimeUrlSync() called outside an ES module context; " +
      "import.meta.url is not available. Use getRuntimeUrl() instead."
  );
}

let cachedRuntimeUrl = null;
let runtimeUrlPromise = null;

/** Asynchronously resolves the runtime module URL. In Vite-bundled code
 *  (editor + player) this is just the cached absolute URL — the promise
 *  exists for API symmetry with the prior blob-fallback design and for
 *  tests running in plain Node, where there is no `import.meta.url`.
 *  In that case we emit a small data: URL that hardcodes `Script` and
 *  `attribute` (math classes aren't reachable from any URL here; tests
 *  that need them import them directly from three/webgpu). */
export async function getRuntimeUrl() {
  if (cachedRuntimeUrl) return cachedRuntimeUrl;
  if (runtimeUrlPromise) return runtimeUrlPromise;

  if (RUNTIME_URL) {
    cachedRuntimeUrl = RUNTIME_URL;
    return cachedRuntimeUrl;
  }

  runtimeUrlPromise = (async () => {
    // No `import.meta.url` (plain Node tests) — fall back to a data URL
    // that hardcodes just `Script` and `attribute`. Math classes can't
    // be reached through a URL on Node (blob: is rejected, and there's
    // no portable way to embed three.js in a data URL); tests that need
    // them import them directly from "three/webgpu".
    const fallback = encodeURIComponent(`
export class Script {}
export function attribute(options = {}) {
  return function (target, key) {
    const ctor = target.constructor ?? target;
    if (!Object.prototype.hasOwnProperty.call(ctor, "attributes")) {
      ctor.attributes = { ...ctor.attributes };
    }
    ctor.attributes[key] = options;
  };
}
`);
    cachedRuntimeUrl = `data:text/javascript;charset=utf-8,${fallback}`;
    return cachedRuntimeUrl;
  })();
  return runtimeUrlPromise;
}

/** Rewrites `from "engine"` / `import "engine"` to the runtime module URL.
 *  Async because the URL resolution is potentially async (data URL fallback
 *  in tests). Browser callers (assetLoader, player main) already work with
 *  promises. If you need a sync entry point, see `getRuntimeUrlSync`. */
export async function linkEngineImports(code) {
  const url = await getRuntimeUrl();
  return code.replace(
    /((?:from|import)\s*)(["'])engine\2/g,
    (_, lead, q) => `${lead}${q}${url}${q}`,
  );
}