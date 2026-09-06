import assert from "node:assert/strict";
import test from "node:test";
import { readRenderTargetImage, matchCaptureTargetFormat, installFramebufferCopyFormats } from "../src/engine/renderTargetImage.js";

/**
 * The two backend conventions for reading a render target back
 * (`src/engine/renderTargetImage.js`).
 *
 * Run with `node --test tests/render-target-image.test.mjs`.
 *
 * This is worth pinning because both ways of getting it wrong produce an image
 * rather than an error: the wrong row order gives a perfect picture upside
 * down, and the wrong padding gives one progressively sheared. The first
 * shipped — every editor screenshot and every `.geom` thumbnail was inverted on
 * WebGPU, because the WebGL bottom-up flip had been carried across to a backend
 * whose `copyTextureToBuffer` preserves texture order (row 0 = top).
 */

const WIDTH = 3;
const HEIGHT = 4;
const ROW_BYTES = WIDTH * 4;
const PADDED = Math.ceil(ROW_BYTES / 256) * 256;

/** Row `y` filled with the byte `y + 1`, so a row's identity is its value. */
const rowValue = (y) => y + 1;

function fakeRenderer(backend, buffer) {
  return { backend, readRenderTargetPixelsAsync: async () => buffer };
}

/** What the caller must always get back: tight rows, row 0 first. */
function assertTopDown(image) {
  assert.equal(image.length, ROW_BYTES * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const row = [...image.subarray(y * ROW_BYTES, (y + 1) * ROW_BYTES)];
    assert.deepEqual(row, new Array(ROW_BYTES).fill(rowValue(y)), `row ${y}`);
  }
}

test("WebGPU: unpads 256-byte rows and keeps them top-down", async () => {
  // three sizes the mapped buffer as (height-1)*paddedRow + rowBytes — the
  // final row really is short, so a reader that assumes height*paddedRow
  // over-reads the end of the buffer.
  const raw = new Uint8Array((HEIGHT - 1) * PADDED + ROW_BYTES);
  for (let y = 0; y < HEIGHT; y++) raw.fill(rowValue(y), y * PADDED, y * PADDED + ROW_BYTES);

  assertTopDown(await readRenderTargetImage(fakeRenderer({ isWebGPUBackend: true }, raw), {}, WIDTH, HEIGHT));
});

test("WebGL: unflips gl.readPixels' bottom-up tight rows", async () => {
  const raw = new Uint8Array(ROW_BYTES * HEIGHT);
  // Row 0 of the buffer is the BOTTOM of the image, so it holds the last row.
  for (let y = 0; y < HEIGHT; y++) raw.fill(rowValue(HEIGHT - 1 - y), y * ROW_BYTES, (y + 1) * ROW_BYTES);

  assertTopDown(await readRenderTargetImage(fakeRenderer({ isWebGLBackend: true }, raw), {}, WIDTH, HEIGHT));
});

test("an unrecognised backend is treated as WebGPU, not as WebGL", async () => {
  const raw = new Uint8Array((HEIGHT - 1) * PADDED + ROW_BYTES);
  for (let y = 0; y < HEIGHT; y++) raw.fill(rowValue(y), y * PADDED, y * PADDED + ROW_BYTES);

  assertTopDown(await readRenderTargetImage(fakeRenderer(undefined, raw), {}, WIDTH, HEIGHT));
});

test("a truncated buffer yields black rather than reading past the end", async () => {
  const raw = new Uint8Array(PADDED + ROW_BYTES); // two rows' worth, four asked for
  raw.fill(rowValue(0), 0, ROW_BYTES);
  raw.fill(rowValue(1), PADDED, PADDED + ROW_BYTES);

  const image = await readRenderTargetImage(fakeRenderer({ isWebGPUBackend: true }, raw), {}, WIDTH, HEIGHT);
  assert.equal(image.length, ROW_BYTES * HEIGHT);
  assert.deepEqual([...image.subarray(0, ROW_BYTES)], new Array(ROW_BYTES).fill(1));
  assert.deepEqual([...image.subarray(3 * ROW_BYTES)], new Array(ROW_BYTES).fill(0));
});


test("WebGPU canvas-compatible BGRA capture unpads and swaps red/blue without changing alpha", async () => {
  const raw = new Uint8Array(256 + 4);
  raw.set([20, 30, 200, 128], 0); raw.set([210, 40, 10, 64], 256);
  const renderer = fakeRenderer({ isWebGPUBackend:true, utils:{getPreferredCanvasFormat:()=>"bgra8unorm"} }, raw);
  const target = matchCaptureTargetFormat(renderer, {texture:{}});
  assert.equal(target.texture.internalFormat,"bgra8unorm");
  assert.deepEqual([...await readRenderTargetImage(renderer,target,1,2)],[200,30,20,128,10,40,210,64]);
});

test("capture format matching preserves WebGL and RGBA readback", async () => {
  const target = {texture:{}};
  const renderer=fakeRenderer({isWebGLBackend:true,utils:{getPreferredCanvasFormat:()=>"bgra8unorm"}},new Uint8Array([1,2,3,255]));
  matchCaptureTargetFormat(renderer,target);assert.equal(target.texture.internalFormat,undefined);
  assert.deepEqual([...await readRenderTargetImage(renderer,target,1,1)],[1,2,3,255]);
});

test("framebuffer copies reallocate only on context format changes and preserve depth", () => {
  let format="bgra8unorm",copies=0,updates=0;
  const renderer={backend:{isWebGPUBackend:true,get:()=>({}),utils:{getPreferredCanvasFormat:()=>format}},getRenderTarget:()=>null,copyFramebufferToTexture:()=>++copies};
  const texture={set needsUpdate(v){if(v)updates++;}};
  installFramebufferCopyFormats(renderer);installFramebufferCopyFormats(renderer);
  renderer.copyFramebufferToTexture(texture);renderer.copyFramebufferToTexture(texture);
  assert.equal(updates,1);assert.equal(copies,2);
  format="rgba16float";renderer.copyFramebufferToTexture(texture);assert.equal(texture.internalFormat,"rgba16float");assert.equal(updates,2);
  renderer.copyFramebufferToTexture({isDepthTexture:true});assert.equal(updates,2);assert.equal(copies,4);
});
