import * as THREE from "three/webgpu";
import { matchCaptureTargetFormat, readRenderTargetImage } from "../engine/renderTargetImage.js";
import { EDITOR_LAYER, PHYSICS_DEBUG_LAYER } from "../engine/editorLayers.js";

/**
 * The colour of what the viewport is looking at, small enough to be free.
 *
 * YouTube's ambient mode samples the video at a handful of pixels, blurs it
 * enormously and lays it behind the page, so the room around the picture
 * takes its light. This is the same trick against a live 3D scene, and the
 * whole design is about the word "notably" in the request: the sample is
 * 32 px wide, it is taken two and a half times a second, and every part of
 * it that could cost real time is switched off.
 *
 * WHY A SECOND RENDER RATHER THAN READING THE ONE ON SCREEN: a WebGPU
 * swapchain texture is not readable after it is presented, and the copy that
 * IS possible (`readLiveCanvasImage`) takes the whole canvas — some 17 MB a
 * frame at this window size, which is precisely the cost this feature must
 * not have. Re-rendering the scene into a 32×18 target costs one more draw
 * encode of a picture with 576 pixels in it.
 *
 * What is switched off for the sample, and why each one matters:
 *   · SHADOW MAPS. `renderer.render` re-renders every shadow map it thinks
 *     is dirty. That is the one thing here that could genuinely cost
 *     milliseconds, and a 32 px thumbnail has no use for a shadow atlas.
 *   · The editor's own layers — gizmos, the grid, collider wireframes.
 *     They are chrome, not the picture, and a green grid would tint the
 *     whole editor green.
 *
 * The caller decides WHEN; this module only knows how to take one sample.
 */

/** Sample width in pixels. The height follows the viewport's aspect. */
export const SAMPLE_WIDTH = 32;

let target = null;
let targetHeight = 0;
let warned = false;

function ensureTarget(renderer, height) {
  if (target && targetHeight === height) return target;
  target?.dispose();
  target = new THREE.RenderTarget(SAMPLE_WIDTH, height, {
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
  });
  matchCaptureTargetFormat(renderer, target);
  targetHeight = height;
  return target;
}

/** Frees the sample target. Call when the glow is switched off for good. */
export function disposeAmbientSampler() {
  target?.dispose();
  target = null;
  targetHeight = 0;
}

/** The sample height that matches a viewport of `aspect`, 8–32 px. */
export function sampleHeightFor(aspect) {
  if (!Number.isFinite(aspect) || aspect <= 0) return 18;
  return Math.max(8, Math.min(32, Math.round(SAMPLE_WIDTH / aspect)));
}

/**
 * The masked render, and NOTHING ELSE, in one synchronous turn.
 *
 * ⚠ THIS IS WHY IT IS A SEPARATE FUNCTION. The camera, its layer mask and
 * the renderer's shadow flag all belong to the LIVE VIEWPORT — this borrows
 * them. Restoring them in the `finally` of an async function restores them
 * after the first `await`, and the readback's await lasts at least a frame,
 * so the viewport drew its own frames with the editor layer still switched
 * off: the gizmos flickered for exactly as long as a sample was in flight,
 * and once the glow started sampling every frame during an orbit, that was
 * every frame of the orbit. Everything borrowed is given back before this
 * function returns, so no frame can ever observe the masked state.
 */
function renderSample(renderer, scene, camera, sampleTarget) {
  const previousTarget = renderer.getRenderTarget();
  const shadows = renderer.shadowMap;
  const shadowsAutoUpdated = shadows?.autoUpdate;
  const gizmosWereVisible = camera.layers.isEnabled(EDITOR_LAYER);
  const physicsWasVisible = camera.layers.isEnabled(PHYSICS_DEBUG_LAYER);
  try {
    if (shadows) shadows.autoUpdate = false;
    camera.layers.disable(EDITOR_LAYER);
    camera.layers.disable(PHYSICS_DEBUG_LAYER);
    renderer.setRenderTarget(sampleTarget);
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    if (shadows) shadows.autoUpdate = shadowsAutoUpdated;
    if (gizmosWereVisible) camera.layers.enable(EDITOR_LAYER);
    if (physicsWasVisible) camera.layers.enable(PHYSICS_DEBUG_LAYER);
  }
}

/**
 * One sample of the live scene as tightly packed RGBA, row 0 at the top.
 * Returns null when there is nothing to sample.
 */
export async function sampleViewportColour(renderer, scene, camera, height) {
  if (!renderer || !scene || !camera || !(height > 0)) return null;
  const sampleTarget = ensureTarget(renderer, height);
  try {
    renderSample(renderer, scene, camera, sampleTarget);
    // Past this point nothing of the viewport's is held: the picture is in
    // the sample target and the readback only reads that.
    const pixels = await readRenderTargetImage(renderer, sampleTarget, SAMPLE_WIDTH, height);
    // ⚠ FORCE OPAQUE. A target rendered with a transparent clear comes back
    // with alpha 0, and `putImageData` writes exactly that — a canvas of
    // fully transparent pixels, which is invisible no matter how bright the
    // colours in it are. `readLiveCanvasImage` forces alpha for the same
    // reason; the readback helper leaves it alone.
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    return pixels;
  } catch (error) {
    // A renderer mid-rebuild, a device loss, a scene being swapped: the glow
    // is decoration and must never be the thing that breaks a frame. It says
    // so ONCE though — a silent catch on a timer is how a broken feature
    // looks exactly like a subtle one.
    if (!warned) {
      warned = true;
      console.warn(`Ambient glow: sampling failed, the glow is off. ${error?.message ?? error}`);
    }
    return null;
  }
}

/**
 * True when two samples differ enough to be worth repainting. A still scene
 * would otherwise wake the compositor two and a half times a second forever.
 */
export function sampleChanged(previous, next, threshold = 3) {
  if (!previous || !next || previous.length !== next.length) return true;
  for (let i = 0; i < next.length; i += 4) {
    if (
      Math.abs(previous[i] - next[i]) > threshold ||
      Math.abs(previous[i + 1] - next[i + 1]) > threshold ||
      Math.abs(previous[i + 2] - next[i + 2]) > threshold
    ) {
      return true;
    }
  }
  return false;
}
