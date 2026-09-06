import test from "node:test";
import assert from "node:assert/strict";

import { parseImageSize } from "../src/editor/imageDimensions.js";

/**
 * Hand-built byte fixtures — every format's header is a handful of bytes, so
 * the fixtures are exact what a file head contains. A probe that misparses
 * doesn't error anywhere; it silently returns the WRONG size and a search
 * filter quietly lies, so each format gets an exact-value assert.
 */

const u8 = (...bytes) => new Uint8Array(bytes);
const u16le = (v) => [v & 0xff, (v >> 8) & 0xff];
const u32le = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const u32be = (v) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

function png(width, height) {
  return u8(
    ...ascii("\x89PNG\r\n\x1a\n"),
    ...u32be(13), ...ascii("IHDR"),
    ...u32be(width), ...u32be(height),
    8, 6, 0, 0, 0,
  );
}

function jpeg(width, height, exifPad = 0) {
  const sof = u8(0xff, 0xc0, 0, 17, 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1);
  // A filler "APP1" segment standing in for EXIF — the SOF must be findable
  // through kilobytes of it.
  const filler = u8(0xff, 0xe1, ...u16be(exifPad + 2), ...new Array(exifPad).fill(0x42));
  return u8(...ascii("\xff\xd8\xff\xe0"), 0, 16, ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, ...filler, ...sof);
}
const u16be = (v) => [(v >> 8) & 0xff, v & 0xff];

function webpVp8x(width, height) {
  const w = width - 1, h = height - 1;
  return u8(
    ...ascii("RIFF"), ...u32le(26 + 10), ...ascii("WEBP"),
    ...ascii("VP8X"), ...u32le(10),
    0x10, 0, 0, 0, // flags: EXIF etc.
    0, 0, 0, // reserved
    w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff,
    h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff,
  );
}

function webpVp8(width, height) {
  return u8(
    ...ascii("RIFF"), ...u32le(30), ...ascii("WEBP"),
    ...ascii("VP8 "), ...u32le(10),
    0, 0, 0, // frame tag
    0x9d, 0x01, 0x2a,
    ...u16le(width - 1 | (0 << 14)), ...u16le(height - 1 | (0 << 14)),
  );
}

function webpVp8l(width, height) {
  const w = width - 1, h = height - 1;
  const bits = w | (h << 14);
  return u8(
    ...ascii("RIFF"), ...u32le(21), ...ascii("WEBP"),
    ...ascii("VP8L"), ...u32le(5),
    0x2f,
    bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff,
  );
}

const gif = (w, h) => u8(...ascii("GIF89a"), ...u16le(w), ...u16le(h), 0, 0, 0, 0);
const bmp = (w, h) => u8(
  ...ascii("BM"), ...u32le(70), 0, 0, 0, 0, ...u32le(54), // file header
  ...u32le(40), // DIB header size (BITMAPINFOHEADER)
  ...u32le(w), ...u32le(-h), 1, 0, 32, 0,
);

test("PNG reads IHDR dimensions", () => {
  assert.deepEqual(parseImageSize(png(1920, 1080)), { width: 1920, height: 1080, format: "png" });
  assert.deepEqual(parseImageSize(png(1, 1)), { width: 1, height: 1, format: "png" });
  assert.equal(parseImageSize(png(0, 100)), null, "zero width is not an image");
});

test("JPEG finds SOF through EXIF-sized filler", () => {
  assert.deepEqual(parseImageSize(jpeg(4032, 3024)), { width: 4032, height: 3024, format: "jpeg" });
  assert.deepEqual(parseImageSize(jpeg(800, 600, 2000)), { width: 800, height: 600, format: "jpeg" },
    "a 2KB EXIF block must not hide the SOF from a 4KB head");
});

test("WebP: all three chunk flavours", () => {
  assert.deepEqual(parseImageSize(webpVp8x(2048, 1536)), { width: 2048, height: 1536, format: "webp" });
  assert.deepEqual(parseImageSize(webpVp8(1024, 768)), { width: 1024, height: 768, format: "webp" });
  assert.deepEqual(parseImageSize(webpVp8l(511, 511)), { width: 511, height: 511, format: "webp" });
});

test("GIF and BMP", () => {
  assert.deepEqual(parseImageSize(gif(320, 240)), { width: 320, height: 240, format: "gif" });
  assert.deepEqual(parseImageSize(bmp(640, 480)), { width: 640, height: 480, format: "bmp" });
});

test("truncated and garbage heads return null instead of throwing", () => {
  assert.equal(parseImageSize(u8(0x89, 0x50, 0x4e, 0x47)), null, "PNG signature alone");
  assert.equal(parseImageSize(png(1920, 1080).slice(0, 18)), null, "PNG cut before IHDR finishes");
  assert.equal(parseImageSize(jpeg(800, 600, 2000).slice(0, 300)), null, "JPEG head ends before SOF");
  assert.equal(parseImageSize(u8(...ascii("RIFF"), ...u32le(30), ...ascii("WEBP"))), null, "WebP with no chunk");
  assert.equal(parseImageSize(u8(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)), null, "random bytes");
  assert.equal(parseImageSize(u8(0)), null, "one byte");
  assert.equal(parseImageSize(u8()), null, "empty");
  assert.equal(parseImageSize(new ArrayBuffer(0)), null, "empty ArrayBuffer");
});
