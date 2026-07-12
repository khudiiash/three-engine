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
const BASIS_LOAD_TIMEOUT_MS = 5000;

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
      console.warn(`Basis texture fallback for "${path}": ${err.message ?? err}`);
    }
  }

  if (!texture) texture = await imageLoader.loadAsync(await resolveAssetUrl(path));
  if (colorSpace) texture.colorSpace = colorSpace;
  applyTextureMeta(texture, meta);
  return texture;
}
