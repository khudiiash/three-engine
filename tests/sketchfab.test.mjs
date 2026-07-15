import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { buildAttribution, packSketchfabArchive } from "../src/editor/sketchfab.js";

test("packs Sketchfab's scene.gltf ZIP layout into a GLB", async () => {
  const zip = new JSZip();
  zip.file("scene.gltf", JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ uri: "scene.bin", byteLength: 12 }],
    bufferViews: [],
    images: [],
  }));
  zip.file("scene.bin", new Uint8Array(12));
  const glb = await packSketchfabArchive(await zip.generateAsync({ type: "uint8array" }));
  assert.deepEqual([...glb.slice(0, 4)], [0x67, 0x6c, 0x54, 0x46]);
});

test("attribution includes creator, source, and license", () => {
  const text = buildAttribution({
    name: "Chair",
    author: "Artist",
    sourceUrl: "https://sketchfab.com/model",
    license: "CC Attribution",
  });
  assert.match(text, /Creator: Artist/);
  assert.match(text, /Source: https:\/\/sketchfab\.com\/model/);
  assert.match(text, /License: CC Attribution/);
});
