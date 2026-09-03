import { strict as assert } from "node:assert";
import test from "node:test";

import {
  stampClassicFromNodes,
  syncPathTracerDisplayTransform,
} from "../src/modules/gi/giPathTracer.js";
import { resolveMaterialAlbedo } from "../src/modules/gi/materialNodeBindings.js";

function makeColor(r, g, b) {
  return {
    r, g, b,
    clone() { return makeColor(this.r, this.g, this.b); },
    copy(other) { this.r = other.r; this.g = other.g; this.b = other.b; return this; },
    setRGB(nr, ng, nb) { this.r = nr; this.g = ng; this.b = nb; return this; },
  };
}

test("stampClassicFromNodes copies a colorNode swatch onto .color", () => {
  const material = {
    color: makeColor(1, 1, 1),
    colorNode: { value: { r: 0.2, g: 0.4, b: 0.8 } },
    map: null,
  };
  const prev = stampClassicFromNodes(material);
  assert.ok(prev?.color);
  assert.equal(prev.color.r, 1);
  assert.equal(material.color.r, 0.2);
  assert.equal(material.color.g, 0.4);
  assert.equal(material.color.b, 0.8);
});

test("stampClassicFromNodes copies a colorNode texture onto .map", () => {
  const texture = { isTexture: true, uuid: "albedo" };
  const material = {
    color: makeColor(1, 1, 1),
    colorNode: { value: texture },
    map: null,
  };
  stampClassicFromNodes(material);
  assert.equal(material.map, texture);
});

test("stampClassicFromNodes does not overwrite an existing .map", () => {
  const existing = { isTexture: true, uuid: "keep" };
  const material = {
    color: makeColor(1, 1, 1),
    map: existing,
    colorNode: { value: { isTexture: true, uuid: "ignore" } },
  };
  stampClassicFromNodes(material);
  assert.equal(material.map, existing);
});

test("reflection albedo resolves a tinted texture from colorNode", () => {
  const texture = { isTexture: true, uuid: "node-albedo" };
  const tint = { r: 0.25, g: 0.5, b: 0.75 };
  const material = {
    color: makeColor(1, 1, 1),
    map: null,
    colorNode: {
      op: "*",
      aNode: { value: texture },
      bNode: { value: tint },
    },
  };
  const resolved = resolveMaterialAlbedo(material);
  assert.equal(resolved.map, texture);
  assert.deepEqual(resolved.tint, tint);
});

test("path tracer debug blit follows the viewport tone mapping and exposure", () => {
  const material = { toneMapping: 0, exposure: 1 };
  const tracer = { _blitQuad: { material } };
  const renderer = { toneMapping: 4, toneMappingExposure: 1.25 };
  assert.equal(syncPathTracerDisplayTransform(tracer, renderer), true);
  assert.equal(material.toneMapping, 4);
  assert.equal(material.exposure, 1.25);
  assert.equal(syncPathTracerDisplayTransform(tracer, renderer), false);
});
