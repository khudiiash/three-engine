import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { EDITOR_LAYER } from "../src/engine/editorLayers.js";
import {
  SAMPLE_WIDTH,
  disposeAmbientSampler,
  frameCopyEnabled,
  sampleViewportColour,
} from "../src/editor/ambientGlow.js";
import { captureFrameDownsampled, frameCropFor } from "../src/editor/frameCopy.js";

/**
 * Thumbnails of the viewport come from the frame that was ALREADY rendered
 * (`src/editor/frameCopy.js`, consumed by `ambientGlow.js` and
 * `sceneThumbs.js`), never from the scene rendered a second time.
 *
 * Run with `node --test tests/ambient-glow-sample.test.mjs`.
 *
 * The claim this file exists for: `renderer.render(scene, camera)` is never
 * called for a sample or a scene preview. Both first re-rendered the scene
 * into a small target, and because a render target is its own three
 * `RenderContext` and the context id is part of the material cache key,
 * every scene material carried a SECOND compiled pipeline per thumbnail
 * context and every scene-wide change re-minted all of them (963 ms per light
 * toggle with the glow on against 698 ms with it off; the freeze ledger
 * printed `material key: renderContext (rt:1864x1240msaa4#0 → rt:32x21#2) x5`
 * and, on every autosave, `(rt:1866x1156msaa4#1 → rt:320x200#8)`). A fake
 * renderer records every call, so a regression back to a scene render — or
 * to `renderer.copyFramebufferToTexture`, which from a post-render hook
 * copies three's pre-tone-map intermediate target rather than the canvas —
 * shows up as a call that should not be there.
 *
 * Also pinned: the copy waits for a tick that PRESENTED (calling
 * `getCurrentTexture()` on a tick that drew nothing hands out a black texture
 * and presents it — the viewport would flash), a request nobody answers
 * resolves empty before the deadline instead of pinning the caller's in-flight
 * flag, one copy of the frame serves every request waiting on it (a save's
 * thumbnail must not cancel the glow's sample, nor the reverse), the copy
 * texture and targets are reused across samples and re-made on a canvas
 * resize, targets are `NoColorSpace` (the copied bytes are already the
 * display's), a target of another aspect gets the canvas's centre rather
 * than a squashed picture, and the `__ambientGlowFrameCopy = false` hatch
 * restores the old scene render with its borrowed state given back.
 */

const HEIGHT = 21;
const THUMB = { width: 320, height: 200 };
const CANVAS = { width: 1864, height: 1240 };
// The readback returns each pixel as (b, g, r, a) — the canvas is BGRA — with
// alpha 0, which the sampler must swap to RGB and force opaque.
const RAW = [10, 20, 30, 0];

function fakeRenderer({ canvasFormat = "bgra8unorm", webgpu = true } = {}) {
  const records = new Map();
  const log = { renders: [], copies: [], submits: [], initTextures: [], readbacks: [], currentTexture: 0 };
  const canvasTexture = { format: canvasFormat, label: "swapchain" };
  let currentTarget = null;
  const backend = {
    isWebGPUBackend: webgpu,
    isWebGLBackend: !webgpu,
    context: {
      getCurrentTexture() {
        log.currentTexture++;
        return canvasTexture;
      },
    },
    device: {
      createCommandEncoder: () => ({
        copyTextureToTexture: (src, dst, extent) => log.copies.push({ src, dst, extent }),
        finish: () => "commands",
      }),
      queue: { submit: (list) => log.submits.push(list) },
    },
    utils: { getPreferredCanvasFormat: () => canvasFormat },
    get(object) {
      let data = records.get(object);
      if (!data) {
        data = {};
        records.set(object, data);
      }
      return data;
    },
  };
  const renderer = {
    backend,
    domElement: { ...CANVAS },
    shadowMap: { autoUpdate: true },
    autoClear: true,
    _mrt: null,
    getMRT() {
      return this._mrt;
    },
    setMRT(mrt) {
      this._mrt = mrt;
    },
    getRenderTarget: () => currentTarget,
    setRenderTarget: (next) => {
      currentTarget = next;
    },
    initTexture(tex) {
      log.initTextures.push(tex);
      backend.get(tex).texture = { format: canvasFormat, width: tex.image.width, height: tex.image.height };
    },
    render(scene, camera) {
      log.renders.push({ scene, camera, target: currentTarget, autoClear: renderer.autoClear, mrt: renderer._mrt });
    },
    async readRenderTargetPixelsAsync(target, _x, _y, width, height) {
      log.readbacks.push({ target, width, height });
      const padded = Math.ceil((width * 4) / 256) * 256;
      const raw = new Uint8Array((height - 1) * padded + width * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) raw.set(RAW, y * padded + x * 4);
      }
      return raw;
    },
  };
  return { renderer, log, canvasTexture };
}

function fakeEngine(renderer) {
  const hooks = new Set();
  const stats = { _presentHead: 0 };
  return {
    renderer,
    scene: new THREE.Scene(),
    stats,
    hooks,
    onPostRender(fn) {
      hooks.add(fn);
      return () => hooks.delete(fn);
    },
    /** One engine tick: the main draw presented (or was skipped), then the hooks. */
    tick({ drew = true } = {}) {
      if (drew) stats._presentHead = (stats._presentHead + 1) % 512;
      for (const fn of [...hooks]) fn();
    },
  };
}

function makeCamera() {
  const camera = new THREE.PerspectiveCamera();
  camera.layers.enable(EDITOR_LAYER);
  return camera;
}

function assertPixels(pixels, width, height) {
  assert.equal(pixels.length, width * height * 4);
  // BGRA swapped to RGB, alpha forced opaque.
  assert.deepEqual([...pixels.subarray(0, 4)], [30, 20, 10, 255]);
  assert.deepEqual([...pixels.subarray(pixels.length - 4)], [30, 20, 10, 255]);
}

test.afterEach(() => {
  delete globalThis.__ambientGlowFrameCopy;
  disposeAmbientSampler();
});

test("a sample is the presented frame copied and averaged by one quad — the scene is never rendered", async () => {
  const { renderer, log, canvasTexture } = fakeRenderer();
  const engine = fakeEngine(renderer);
  const camera = makeCamera();
  assert.equal(frameCopyEnabled(renderer), true);

  const pending = sampleViewportColour(engine, camera, HEIGHT);
  assert.equal(engine.hooks.size, 1, "the hook is armed synchronously, before any await");
  engine.tick();
  const pixels = await pending;
  assertPixels(pixels, SAMPLE_WIDTH, HEIGHT);

  // (a) never the scene.
  assert.equal(log.renders.filter((r) => r.scene === engine.scene).length, 0, "renderer.render(scene, camera) was called");
  assert.equal(log.renders.filter((r) => r.camera === camera).length, 0);

  // (b) the canvas copied into a three-allocated FramebufferTexture of the canvas's size and format …
  assert.equal(log.currentTexture, 1);
  assert.equal(log.initTextures.length, 1);
  const frame = log.initTextures[0];
  assert.equal(frame.isFramebufferTexture, true);
  assert.deepEqual([frame.image.width, frame.image.height], [CANVAS.width, CANVAS.height]);
  assert.equal(frame.colorSpace, THREE.NoColorSpace);
  assert.equal(log.copies.length, 1);
  assert.equal(log.copies[0].src.texture, canvasTexture);
  assert.equal(log.copies[0].dst.texture, renderer.backend.get(frame).texture);
  assert.deepEqual(log.copies[0].extent, [CANVAS.width, CANVAS.height, 1]);
  assert.equal(log.submits.length, 1, "the copy is submitted before the quad renders");

  // … then exactly one quad into the 32×N sample target, which the readback reads.
  assert.equal(log.renders.length, 1);
  const [draw] = log.renders;
  assert.equal(draw.scene.isQuadMesh, true);
  assert.equal(draw.scene.material.name, "frameCopy:downsample");
  assert.ok(draw.target?.isRenderTarget);
  assert.deepEqual([draw.target.width, draw.target.height], [SAMPLE_WIDTH, HEIGHT]);
  assert.equal(draw.target.texture.colorSpace, THREE.NoColorSpace, "the copied bytes are already display-encoded");
  assert.equal(draw.mrt, null);
  assert.equal(draw.autoClear, true);
  assert.equal(log.readbacks.length, 1);
  assert.equal(log.readbacks[0].target, draw.target);

  // Everything borrowed is given back, and the hook is gone.
  assert.equal(renderer.getRenderTarget(), null);
  assert.equal(renderer.getMRT(), null);
  assert.equal(engine.hooks.size, 0);
});

test("a scene preview is the same copy averaged to 320×200 — the scene is never rendered", async () => {
  const { renderer, log } = fakeRenderer();
  const engine = fakeEngine(renderer);

  const pending = captureFrameDownsampled(engine, THUMB);
  assert.equal(engine.hooks.size, 1);
  engine.tick();
  const pixels = await pending;
  assertPixels(pixels, THUMB.width, THUMB.height);

  assert.equal(log.renders.filter((r) => r.scene === engine.scene).length, 0, "renderer.render(scene, camera) was called");
  assert.equal(log.copies.length, 1);
  assert.equal(log.renders.length, 1);
  assert.equal(log.renders[0].scene.isQuadMesh, true);
  assert.deepEqual([log.renders[0].target.width, log.renders[0].target.height], [THUMB.width, THUMB.height]);
  assert.equal(log.readbacks.length, 1);
  assert.deepEqual([log.readbacks[0].width, log.readbacks[0].height], [THUMB.width, THUMB.height]);
  assert.equal(engine.hooks.size, 0);
});

test("one copy of the frame serves every request waiting on it — a save does not cancel the glow", async () => {
  const { renderer, log } = fakeRenderer();
  const engine = fakeEngine(renderer);

  const glow = sampleViewportColour(engine, makeCamera(), HEIGHT);
  const thumb = captureFrameDownsampled(engine, THUMB);
  assert.equal(engine.hooks.size, 1, "one hook for both");
  engine.tick();
  const [glowPixels, thumbPixels] = await Promise.all([glow, thumb]);
  assertPixels(glowPixels, SAMPLE_WIDTH, HEIGHT);
  assertPixels(thumbPixels, THUMB.width, THUMB.height);

  assert.equal(log.currentTexture, 1, "the canvas was copied once");
  assert.equal(log.copies.length, 1);
  assert.equal(log.renders.length, 2, "one quad per target");
  assert.notEqual(log.renders[0].target, log.renders[1].target);
  assert.equal(log.renders.filter((r) => r.scene === engine.scene).length, 0);
  assert.equal(engine.hooks.size, 0);
});

test("a tick that drew nothing is not captured: the hook waits for a presented frame", async () => {
  const { renderer, log } = fakeRenderer();
  const engine = fakeEngine(renderer);

  const pending = sampleViewportColour(engine, makeCamera(), HEIGHT);
  engine.tick({ drew: false });
  assert.equal(log.currentTexture, 0, "getCurrentTexture() on an undrawn tick would present a black canvas");
  assert.equal(log.copies.length, 0);
  assert.equal(engine.hooks.size, 1, "still armed");

  engine.tick();
  assertPixels(await pending, SAMPLE_WIDTH, HEIGHT);
  assert.equal(log.copies.length, 1);
  assert.equal(engine.hooks.size, 0);
});

test("a frame that never comes resolves null before the deadline and disarms", async () => {
  const { renderer, log } = fakeRenderer();
  const engine = fakeEngine(renderer);

  const pixels = await sampleViewportColour(engine, makeCamera(), HEIGHT, { deadlineMs: 10 });
  assert.equal(pixels, null);
  const thumb = await captureFrameDownsampled(engine, { ...THUMB, deadlineMs: 10 });
  assert.equal(thumb, null, "the preview then takes its own fallback");
  assert.equal(engine.hooks.size, 0);
  assert.equal(log.copies.length, 0);
  assert.equal(log.renders.length, 0);
});

test("the copy texture and the targets are reused; a canvas resize re-makes the copy", async () => {
  const { renderer, log } = fakeRenderer();
  const engine = fakeEngine(renderer);
  const camera = makeCamera();

  let pending = sampleViewportColour(engine, camera, HEIGHT);
  engine.tick();
  await pending;
  pending = sampleViewportColour(engine, camera, HEIGHT);
  engine.tick();
  await pending;
  assert.equal(log.initTextures.length, 1, "one copy texture for two samples");
  assert.equal(log.readbacks[0].target, log.readbacks[1].target, "one sample target for two samples");
  assert.equal(log.renders.length, 2);
  assert.equal(log.renders[0].scene, log.renders[1].scene, "one quad");

  let disposed = 0;
  log.initTextures[0].addEventListener("dispose", () => disposed++);
  renderer.domElement.width = 900;
  renderer.domElement.height = 600;
  pending = sampleViewportColour(engine, camera, HEIGHT);
  engine.tick();
  await pending;
  assert.equal(log.initTextures.length, 2);
  assert.deepEqual([log.initTextures[1].image.width, log.initTextures[1].image.height], [900, 600]);
  assert.equal(disposed, 1, "the old copy is released");
  assert.deepEqual(log.copies[2].extent, [900, 600, 1]);
});

test("a target of another aspect shows the canvas's centre, never a squashed picture", () => {
  // Same aspect: the whole frame.
  assert.deepEqual(frameCropFor(1600, 1000, 320, 200), { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 });
  // A wider canvas than the target: crop the sides.
  const wide = frameCropFor(2000, 1000, 320, 200);
  assert.equal(wide.scaleY, 1);
  assert.ok(Math.abs(wide.scaleX - 0.8) < 1e-9);
  assert.ok(Math.abs(wide.offsetX - 0.1) < 1e-9);
  assert.equal(wide.offsetY, 0);
  // A taller canvas than the target: crop top and bottom.
  const tall = frameCropFor(800, 1200, 320, 200);
  assert.equal(tall.scaleX, 1);
  assert.ok(Math.abs(tall.scaleY - 800 / 1200 / 1.6) < 1e-9);
  assert.ok(Math.abs(tall.offsetY - (1 - tall.scaleY) / 2) < 1e-9);
  // Garbage sizes crop nothing rather than producing NaN uniforms.
  assert.deepEqual(frameCropFor(0, 0, 320, 200), { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 });
});

test("the hatch restores the scene re-render, with the borrowed state given back", async () => {
  globalThis.__ambientGlowFrameCopy = false;
  const { renderer, log } = fakeRenderer();
  const engine = fakeEngine(renderer);
  const camera = makeCamera();
  assert.equal(frameCopyEnabled(renderer), false);

  const pixels = await sampleViewportColour(engine, camera, HEIGHT);
  assertPixels(pixels, SAMPLE_WIDTH, HEIGHT);
  assert.equal(engine.hooks.size, 0, "no post-render hook on the fallback");
  assert.equal(log.copies.length, 0);
  assert.equal(log.currentTexture, 0);
  assert.equal(log.renders.length, 1);
  const [draw] = log.renders;
  assert.equal(draw.scene, engine.scene);
  assert.equal(draw.camera, camera);
  assert.deepEqual([draw.target.width, draw.target.height], [SAMPLE_WIDTH, HEIGHT]);
  assert.equal(draw.target.texture.colorSpace, THREE.SRGBColorSpace, "the scene render encodes on the way in");
  assert.equal(renderer.getRenderTarget(), null);
  assert.equal(renderer.shadowMap.autoUpdate, true);
  assert.equal(camera.layers.isEnabled(EDITOR_LAYER), true);

  // The preview refuses too, so sceneThumbs takes captureViewportFrame.
  assert.equal(await captureFrameDownsampled(engine, THUMB), null);
  assert.equal(engine.hooks.size, 0);
});

test("a WebGL backend has no swapchain to copy and takes the scene render", async () => {
  const { renderer, log } = fakeRenderer({ webgpu: false });
  const engine = fakeEngine(renderer);
  assert.equal(frameCopyEnabled(renderer), false);

  const pixels = await sampleViewportColour(engine, makeCamera(), HEIGHT);
  assert.equal(pixels.length, SAMPLE_WIDTH * HEIGHT * 4);
  assert.equal(log.renders.length, 1);
  assert.equal(log.renders[0].scene, engine.scene);
  assert.equal(log.copies.length, 0);
  assert.equal(await captureFrameDownsampled(engine, THUMB), null);
});
