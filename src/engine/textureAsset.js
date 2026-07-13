import * as THREE from "three/webgpu";
import { resolveAssetUrl, loadAssetMeta } from "./assetResolver.js";
import { applyTextureMeta } from "./textureMeta.js";

const imageLoader = new THREE.TextureLoader();
let textureRenderer = null;
let basisLoader = null;
let basisLoaderPromise = null;
let basisCompressionEnabled = false;

// A broken/unsupported worker or GPU transcode can leave KTX2Loader's promise
// pending forever without rejecting. Shader-graph compilation waits for every
// referenced texture, so one such task leaves the material permanently white
// and subsequent graph edits appear to do nothing. The editable source image
// is always retained specifically as a safe fallback; do not wait forever
// before using it.
//
// The 30s budget is generous on purpose: KTX2 transcoding spawns a worker
// that on first run JIT-compiles the Basis Universal WASM, which on some
// hardware takes well over 5s. The previous 5s default produced a flood of
// false-positive fallback warnings on cold startup. Once the worker is warm
// (within the same editor session) subsequent transcodes are sub-second.
const BASIS_LOAD_TIMEOUT_MS = 30000;

// One-time summary so a flood of slow transcodes doesn't drown the console.
// We surface the first timeout via a normal `console.info` (the source PNG
// fallback already covers it — the user just gets to know it happened).
let basisTimeoutNotified = false;

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
    basisLoaderPromise = import("three/addons/loaders/KTX2Loader.js").then(({ KTX2Loader }) => {
      basisLoader = new KTX2Loader().detectSupport(textureRenderer);
      return basisLoader;
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

  if (basisCompressionEnabled && meta?.basis?.enabled) {
    try {
      const loader = await getBasisLoader();
      if (loader) {
        texture = await loadBasisWithTimeout(
          loader,
          await resolveAssetUrl(`${path}.basis`),
        );
      }
    } catch (err) {
      // The timeout / transcode failure falls back to the source PNG below,
      // which is always available — no need for the user to act. Demote the
      // log to a one-shot `info` so a cold-start transcode storm doesn't
      // bury real warnings from their scene.
      if (!basisTimeoutNotified) {
        basisTimeoutNotified = true;
        console.info(
          `Basis transcoding is slow on this machine; falling back to source PNGs ` +
            `for compressed textures. First failure: "${path}" — ${err.message ?? err}`,
        );
      }
    }
  }

  if (!texture) texture = await imageLoader.loadAsync(await resolveAssetUrl(path));
  if (colorSpace) texture.colorSpace = colorSpace;
  applyTextureMeta(texture, meta);
  return texture;
}
