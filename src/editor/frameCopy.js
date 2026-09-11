import * as THREE from "three/webgpu";
import { matchCaptureTargetFormat, readRenderTargetImage } from "../engine/renderTargetImage.js";

const { texture, uv, vec2, vec4, uniform } = THREE.TSL;

/**
 * A small picture of the frame that was ALREADY rendered — never a second
 * render of the scene.
 *
 * Two editor features want a thumbnail of the viewport: the ambient glow (a
 * 32×N sample two and a half times a second) and the scene preview (320×200
 * on every save). Both first did the obvious thing and re-rendered the scene
 * into a small target, and that cost far more than one small draw: a render
 * target is its own three `RenderContext`, the context id is part of the
 * material cache key, so EVERY scene material carried one more compiled node
 * graph and pipeline per thumbnail context, and every scene-wide change (a
 * light toggled, the environment, fog, a shadow map) re-minted all of them
 * again. Measured on the user's scene: a light off+on cycle blocked 963 ms
 * with the glow on against 698 ms with it off; the freeze ledger named both —
 * `material key: renderContext (rt:1864x1240msaa4#0 → rt:32x21#2) x5` and,
 * every ~20 s of autosave, `(rt:1866x1156msaa4#1 → rt:320x200#8)` as ~400 ms
 * of node builds plus synchronous 70 kB pipeline compiles. Worse, those
 * one-shot renders ran outside the engine's main draw, where pipelines
 * compile SYNCHRONOUSLY, so each re-mint parked the GPU process.
 *
 * So the picture on the canvas is COPIED, on the GPU, into a texture, and one
 * trivial quad (a fixed shader of a few kB, compiled once) averages it down
 * into the requested target, which the readback already knew how to read. No
 * scene material ever sees a thumbnail's context. The steps, and why each is
 * what it is:
 *
 *   · The copy is `copyTextureToTexture` from `context.getCurrentTexture()`,
 *     from an `engine.onPostRender` hook — the same frame, the same task, as
 *     the draw. A swapchain texture is only readable until it is presented at
 *     the end of the task, and the canvas is configured `COPY_SRC` for exactly
 *     this (three.webgpu.js:84068). It is what `readLiveCanvasImage` already
 *     does for screenshots, minus the 9 MB readback: the pixels stay on the
 *     GPU and only the thumbnail's bytes ever come back.
 *   · ⚠ NOT `renderer.copyFramebufferToTexture`. Outside a render its source
 *     is `this._renderTarget || this._getFrameBufferTarget()`
 *     (three.webgpu.js:62181-62195), and with tone mapping or sRGB output on —
 *     always, here — `_getFrameBufferTarget` (60606) hands back three's
 *     intermediate half-float MSAA target: the LINEAR, PRE-TONE-MAP scene, and
 *     under a Postprocess component a target that frame did not even write
 *     (the post graph blits its own pass to the canvas with tone mapping off).
 *     The canvas is the one place both paths agree on what the user sees.
 *   · ⚠ THE COPY WAITS FOR A PRESENTED FRAME. Calling `getCurrentTexture()`
 *     in a task that drew nothing does not return the last picture — it
 *     hands out a fresh black texture and marks the canvas for presentation,
 *     so the viewport would flash black on every tick the engine skipped its
 *     draw (no camera, a device swap, GI's `renderSuspended` compile wave,
 *     whose ticks run with no draw). The hook stays armed until the engine's
 *     own presented-frame record moves, and a request nobody answers resolves
 *     empty after a deadline rather than pinning the caller's in-flight flag.
 *   · One copy serves every request waiting on that frame: the glow and a
 *     save can land on the same tick, and the second must not cancel the
 *     first (a lost thumbnail request falls back to the scene render this
 *     module exists to avoid).
 *   · The copied bytes are the display's: tone-mapped and sRGB-encoded. Both
 *     the copy texture and the targets are `NoColorSpace`, so the quad moves
 *     them untouched and the readback returns what is on screen.
 *   · A target whose aspect differs from the canvas gets the canvas's CENTRE,
 *     cropped to the target's aspect (`frameCropFor`), never squashed into
 *     it. The old renders overrode the camera's aspect instead, which showed
 *     a wider or taller field of view; a crop is the honest "what is on
 *     screen", and for the glow (sized to the viewport's aspect) it is no
 *     crop at all.
 *   · The editor's own layers — the grid, gizmos, collider wireframes, the
 *     selection ring, the camera preview — ARE in the copied picture; the old
 *     renders masked them because they re-rendered and could. A halo is
 *     blurred to a few colours, so the gizmos vanish into it; a preview shows
 *     the scene as the user saw it when saving. The grid is the one candidate
 *     for a visible tint in the glow and, if it ever shows, a follow-up rather
 *     than a reason to render the scene twice.
 *
 * `globalThis.__ambientGlowFrameCopy = false` switches this off for every
 * caller (each keeps its old scene render as the fallback), and a WebGL
 * backend — which has no swapchain texture to copy — is refused the same way.
 */

/** Taps per axis inside each output pixel. 4×4 bilinear taps cover a spread
 *  of the canvas texels behind each pixel rather than one of them, so a thin
 *  bright edge sliding under the camera does not pop the pixel. */
const TAPS = 4;
/** How long a request waits for a presented frame before answering empty. */
export const FRAME_DEADLINE_MS = 1500;
/** Targets kept alive, by size. The glow and the preview need two. */
const MAX_TARGETS = 4;

/** Set once the frame copy has failed; every caller's fallback then takes
 *  over for the session so the feature stays alive, and the warning says so. */
let frameCopyBroken = false;
let warned = false;

/** Canvas-sized copy of the presented frame, and the quad that reads it. */
let frameTexture = null;
let quad = null;
let quadMaterial = null;
let taps = [];
let pixelUV = null;
let uvScale = null;
let uvOffset = null;
/** Sample targets by `${width}x${height}`, insertion-ordered for eviction. */
const targets = new Map();
/** Requests waiting for the next presented frame. */
const pending = [];
let hookOff = null;
let hookEngine = null;

/** True when this renderer takes the frame copy rather than a scene render. */
export function frameCopyEnabled(renderer) {
  return (
    globalThis.__ambientGlowFrameCopy !== false &&
    !frameCopyBroken &&
    !!renderer?.backend?.isWebGPUBackend
  );
}

/**
 * The part of the canvas a `width`×`height` picture shows: the centre, at the
 * target's aspect, as a UV scale and offset. `{1, 1, 0, 0}` when the aspects
 * already agree.
 */
export function frameCropFor(frameWidth, frameHeight, width, height) {
  const frameAspect = frameWidth / frameHeight;
  const aspect = width / height;
  let scaleX = 1;
  let scaleY = 1;
  if (Number.isFinite(frameAspect) && Number.isFinite(aspect) && frameAspect > 0 && aspect > 0) {
    if (frameAspect > aspect) scaleX = aspect / frameAspect;
    else if (frameAspect < aspect) scaleY = frameAspect / aspect;
  }
  return { scaleX, scaleY, offsetX: (1 - scaleX) / 2, offsetY: (1 - scaleY) / 2 };
}

function ensureTarget(renderer, width, height) {
  const key = `${width}x${height}`;
  let target = targets.get(key);
  if (target) return target;
  while (targets.size >= MAX_TARGETS) {
    const [oldestKey, oldest] = targets.entries().next().value;
    oldest.dispose();
    targets.delete(oldestKey);
  }
  target = new THREE.RenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    // The frame copy is already display-encoded and must pass through untouched.
    colorSpace: THREE.NoColorSpace,
  });
  target.texture.name = `frameCopy:${key}`;
  matchCaptureTargetFormat(renderer, target);
  targets.set(key, target);
  return target;
}

/**
 * The canvas-sized texture the frame is copied into, allocated by three so
 * the quad can bind it. Three gives a `FramebufferTexture` the canvas's own
 * format (three.webgpu.js:76592-76596) and `COPY_DST` (76608), which is
 * exactly what a `copyTextureToTexture` from the swapchain needs; a new one
 * is made when the canvas changes size, and the taps follow it.
 */
function ensureFrameTexture(renderer, width, height) {
  if (frameTexture && frameTexture.image.width === width && frameTexture.image.height === height) {
    return frameTexture;
  }
  frameTexture?.dispose();
  frameTexture = new THREE.FramebufferTexture(width, height);
  frameTexture.name = "frameCopy:frame";
  frameTexture.colorSpace = THREE.NoColorSpace;
  // Bilinear, so each tap already averages the four texels under it.
  frameTexture.minFilter = THREE.LinearFilter;
  frameTexture.magFilter = THREE.LinearFilter;
  renderer.initTexture(frameTexture);
  for (const tap of taps) tap.value = frameTexture;
  return frameTexture;
}

/**
 * The quad that averages the frame down: `TAPS²` bilinear reads spread
 * inside each output pixel, summed. Built once; every tap shares one texture
 * binding (three keys texture uniforms by the texture's uuid), so the shader
 * binds one texture and one sampler whatever `TAPS` is.
 */
function ensureQuad() {
  if (quad) return quad;
  pixelUV = uniform(new THREE.Vector2(1 / 32, 1 / 18));
  uvScale = uniform(new THREE.Vector2(1, 1));
  uvOffset = uniform(new THREE.Vector2(0, 0));
  const material = new THREE.NodeMaterial();
  material.name = "frameCopy:downsample";
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  const base = uv().mul(uvScale).add(uvOffset);
  let sum = null;
  for (let j = 0; j < TAPS; j++) {
    for (let i = 0; i < TAPS; i++) {
      const offset = vec2((i + 0.5) / TAPS - 0.5, (j + 0.5) / TAPS - 0.5).mul(pixelUV);
      const tap = texture(frameTexture, base.add(offset));
      taps.push(tap);
      sum = sum ? sum.add(tap.rgb) : tap.rgb;
    }
  }
  // `fragmentNode` rather than `colorNode`: it skips the lighting setup and
  // the output transform entirely, so the bytes pass straight through.
  material.fragmentNode = vec4(sum.div(TAPS * TAPS), 1);
  quadMaterial = material;
  quad = new THREE.QuadMesh(material);
  return quad;
}

/** The GPU copy of the presented frame. Synchronous, from the post-render hook. */
function copyFrame(renderer) {
  const backend = renderer.backend;
  const canvas = renderer.domElement;
  const width = canvas?.width | 0;
  const height = canvas?.height | 0;
  if (!(width > 0 && height > 0)) throw new Error("The canvas has no size to capture.");

  const frame = ensureFrameTexture(renderer, width, height);
  const source = backend.context.getCurrentTexture();
  const destination = backend.get(frame)?.texture;
  if (!destination) throw new Error("The frame copy texture was not allocated.");
  if (source.format !== destination.format) {
    throw new Error(`The canvas is ${source.format} and the frame copy is ${destination.format}.`);
  }
  const encoder = backend.device.createCommandEncoder();
  encoder.copyTextureToTexture({ texture: source }, { texture: destination }, [width, height, 1]);
  backend.device.queue.submit([encoder.finish()]);
  return frame;
}

/** One quad render of the copied frame into `target`, cropped to its aspect. */
function downsampleInto(renderer, target) {
  const mesh = ensureQuad();
  const { scaleX, scaleY, offsetX, offsetY } = frameCropFor(
    frameTexture.image.width, frameTexture.image.height, target.width, target.height,
  );
  uvScale.value.set(scaleX, scaleY);
  uvOffset.value.set(offsetX, offsetY);
  pixelUV.value.set(scaleX / target.width, scaleY / target.height);
  const previousTarget = renderer.getRenderTarget();
  const previousMRT = renderer.getMRT();
  const previousAutoClear = renderer.autoClear;
  try {
    renderer.setMRT(null);
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    mesh.render(renderer);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(previousMRT);
    renderer.autoClear = previousAutoClear;
  }
}

/** Where the engine records a presented frame; `undefined` when it cannot say. */
function presentedHead(engine) {
  return engine.stats?._presentHead;
}

/**
 * The post-render hook. ONE function object for every request rather than a
 * closure per sample: the engine's frame audit keys its rows on the callback
 * identity, and a fresh closure two and a half times a second would fill it
 * with one-row ghosts.
 */
function onFrameRendered() {
  const engine = hookEngine;
  if (!engine || pending.length === 0) return;
  const head = presentedHead(engine);
  // Only requests armed BEFORE this present are due; a tick that ran the
  // hooks but drew nothing leaves every request waiting — see the header.
  const due = pending.filter((request) => head === undefined || head !== request.head);
  if (due.length === 0) return;
  let copied = false;
  for (const request of due) {
    try {
      if (!copied) {
        copyFrame(engine.renderer);
        copied = true;
      }
      downsampleInto(engine.renderer, request.target);
      settle(request, () => request.resolve(true));
    } catch (error) {
      settle(request, () => request.reject(error));
    }
  }
}

function settle(request, finish) {
  const index = pending.indexOf(request);
  if (index >= 0) pending.splice(index, 1);
  if (request.timer) clearTimeout(request.timer);
  request.timer = null;
  if (pending.length === 0) {
    hookOff?.();
    hookOff = null;
    hookEngine = null;
  }
  finish();
}

function cancelAll(answer) {
  for (const request of [...pending]) settle(request, () => request.resolve(answer));
}

/**
 * Arms the hook for the next presented frame. Resolves `true` once the frame
 * is in `target`, `false` when no frame came before the deadline.
 */
function armForNextFrame(engine, target, deadlineMs) {
  return new Promise((resolve, reject) => {
    // One engine at a time; a request from another one retires the old ones.
    if (hookEngine && hookEngine !== engine) cancelAll(false);
    const request = { target, resolve, reject, head: presentedHead(engine), timer: null };
    pending.push(request);
    if (!hookOff) {
      hookEngine = engine;
      hookOff = engine.onPostRender(onFrameRendered);
    }
    request.timer = setTimeout(() => settle(request, () => resolve(false)), deadlineMs);
  });
}

/**
 * The next presented frame, averaged down to `width`×`height`, as tightly
 * packed RGBA with row 0 at the top and alpha forced opaque — the layout
 * `imageDataToDataUrl` and `putImageData` expect. Returns null when the frame
 * copy is unavailable (WebGL, the hatch, a failure earlier in the session),
 * when no frame was presented within the deadline, or when the copy failed;
 * the caller then takes its own fallback.
 *
 * @param {any} engine  The engine: `renderer`, `onPostRender`, `stats`.
 */
export async function captureFrameDownsampled(engine, { width, height, deadlineMs = FRAME_DEADLINE_MS }) {
  const renderer = engine?.renderer;
  if (!renderer || !(width > 0) || !(height > 0)) return null;
  if (!frameCopyEnabled(renderer) || typeof engine.onPostRender !== "function") return null;
  const target = ensureTarget(renderer, Math.round(width), Math.round(height));
  try {
    const captured = await armForNextFrame(engine, target, deadlineMs);
    if (!captured) return null;
  } catch (error) {
    // The copy or the quad failed: something about this device disagrees
    // with the design, and guessing again every sample would spam. Say so
    // once and let every caller's fallback carry the session.
    if (!frameCopyBroken) {
      frameCopyBroken = true;
      console.warn(
        `Frame copy: capturing the presented frame failed, callers fall back to re-rendering ` +
          `the scene for the rest of the session (a second pipeline per material). ${error?.message ?? error}`,
      );
    }
    return null;
  }
  try {
    const pixels = await readRenderTargetImage(renderer, target, target.width, target.height);
    // ⚠ FORCE OPAQUE. A target rendered with a transparent clear comes back
    // with alpha 0, and `putImageData` writes exactly that — a canvas of
    // fully transparent pixels, which is invisible no matter how bright the
    // colours in it are. `readLiveCanvasImage` forces alpha for the same
    // reason; the readback helper leaves it alone.
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    return pixels;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(`Frame copy: the readback failed. ${error?.message ?? error}`);
    }
    return null;
  }
}

/** Frees every target, the frame copy and the quad. Everything is re-made lazily. */
export function disposeFrameCopy() {
  cancelAll(false);
  for (const target of targets.values()) target.dispose();
  targets.clear();
  frameTexture?.dispose();
  frameTexture = null;
  quadMaterial?.dispose();
  quadMaterial = null;
  quad = null;
  taps = [];
  pixelUV = null;
  uvScale = null;
  uvOffset = null;
}
