import * as THREE from "three/webgpu";
import { resolveAssetUrl, loadAssetMeta } from "./assetResolver.js";
import { applyTextureMeta } from "./textureMeta.js";

const imageLoader = new THREE.TextureLoader();
let textureRenderer = null;
let basisLoader = null;
let basisLoaderPromise = null;
let basisCompressionEnabled = false;

// A broken/unsupported worker or GPU transcode can leave KTX2Loader's promise
// pending forever without rejecting (three's WorkerPool never listens for the
// worker's `error` event, so a worker that dies at startup simply never
// replies). Shader-graph compilation waits for every referenced texture, so one
// such task leaves the material permanently white. The editable source image is
// always retained specifically as a safe fallback; do not wait forever.
//
// A warm worker transcodes in well under a second, so anything past a few
// seconds is a broken worker, not a slow one — don't budget for the hang.
const BASIS_LOAD_TIMEOUT_MS = 5000;

// A hung/broken transcoder fails the same way for every texture. Without this
// latch each one independently burns the full timeout, turning a single fault
// into minutes of white geometry on startup. First failure disables Basis for
// the session; the source images load in ~400ms.
let basisDisabledForSession = false;

async function loadBasisWithTimeout(loader, url) {
  let timer = null;
  let timedOut = false;
  const pending = loader.loadAsync(url);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Basis transcode timed out after ${BASIS_LOAD_TIMEOUT_MS}ms`));
    }, BASIS_LOAD_TIMEOUT_MS);
  });

  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
    // Promise.race cannot cancel KTX2Loader. If its worker eventually returns
    // after the timeout, dispose that unused GPU texture instead of leaking it.
    if (timedOut) pending.then((texture) => texture?.dispose?.()).catch(() => {});
  }
}

/** Controlled by the optional Basis engine module. */
export function setBasisCompressionEnabled(enabled) {
  basisCompressionEnabled = enabled === true;
}

/** Must be called after renderer.init(); selects the best GPU target format. */
export function configureTextureAssetLoader(nextRenderer) {
  if (!nextRenderer) return;
  // Keep Basis code and WASM off the startup path until a compressed asset is
  // actually requested. Re-detect after renderer rebuilds.
  textureRenderer = nextRenderer;
  basisLoader?.detectSupport(nextRenderer);
}

async function getBasisLoader() {
  if (!textureRenderer) return null;
  if (!basisLoaderPromise) {
    basisLoaderPromise = import("three/addons/loaders/KTX2Loader.js").then(async ({ KTX2Loader }) => {
      // The transcoder binaries live in `public/basis/` (copied from three's
      // libs), exactly like the Draco decoder — and the path is RELATIVE for
      // the same reason: it resolves against the document URL, so an exported
      // game served from a subpath still finds them.
      //
      // Setting this explicitly is NOT optional. Left empty, KTX2Loader
      // resolves the transcoder via `new URL('../libs/basis/...',
      // import.meta.url)`. Vite pre-bundles KTX2Loader into
      // `/node_modules/.vite/deps/`, so that relative URL points at a path that
      // does not exist — and the dev server's SPA fallback answers it with
      // `index.html` and a 200. FileLoader sees success, the worker gets built
      // with HTML as its source, dies on `<!doctype html>`, and (because
      // WorkerPool ignores worker errors) never replies at all. Every texture
      // then hangs until the timeout below. See git history for the 20s
      // white-geometry startup this caused.
      const loader = new KTX2Loader().setTranscoderPath("basis/").detectSupport(textureRenderer);
      await loader.init();

      // WorkerPool has no 'error' handling, so without this a broken worker is
      // completely silent. Keep the failure loud.
      const createWorker = loader.workerPool.workerCreator;
      loader.workerPool.setWorkerCreator(() => {
        const worker = createWorker();
        worker.addEventListener("error", (e) =>
          console.error(`Basis transcode worker failed: ${e.message} (${e.filename}:${e.lineno})`),
        );
        return worker;
      });

      basisLoader = loader;
      return loader;
    });
  }
  return basisLoaderPromise;
}

/**
 * Loads an image asset, preferring its generated `<path>.basis` KTX2 when the
 * per-asset toggle is enabled. A missing/stale derivative safely falls back to
 * the source image, which keeps projects portable and source assets editable.
 */
export async function loadTextureAsset(path, { colorSpace = null } = {}) {
  const meta = await loadAssetMeta(`${path}.meta`);
  let texture = null;

  if (basisCompressionEnabled && meta?.basis?.enabled && !basisDisabledForSession) {
    try {
      const loader = await getBasisLoader();
      if (loader) {
        texture = await loadBasisWithTimeout(loader, await resolveAssetUrl(`${path}.basis`));
      }
    } catch (err) {
      // The source image is always retained, so this is recoverable — but a
      // transcoder that fails once fails for everything, so stop paying the
      // timeout per texture and take the fallback for the rest of the session.
      basisDisabledForSession = true;
      console.warn(
        `Basis transcoding failed; using source images for the rest of this session. ` +
          `First failure: "${path}" — ${err.message ?? err}`,
      );
    }
  }

  if (!texture) texture = await imageLoader.loadAsync(await resolveAssetUrl(path));
  if (colorSpace) texture.colorSpace = colorSpace;
  applyTextureMeta(texture, meta);
  return texture;
}
