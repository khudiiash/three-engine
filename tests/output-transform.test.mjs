import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three/webgpu";
import { applyOutputTransform, installDirectOutput, outputPolicy, withRealOutput } from "../src/engine/outputTransform.js";

test("the direct policy tells the renderer 'none/working' and hands the real transform to the materials", () => {
  const off = outputPolicy({ direct: false, toneMapping: THREE.NeutralToneMapping, outputColorSpace: THREE.SRGBColorSpace });
  assert.equal(off.renderer.toneMapping, THREE.NeutralToneMapping);
  assert.equal(off.inline, null);
  const on = outputPolicy({ direct: true, toneMapping: THREE.NeutralToneMapping, outputColorSpace: THREE.SRGBColorSpace });
  assert.equal(on.renderer.toneMapping, THREE.NoToneMapping);
  assert.equal(on.renderer.outputColorSpace, THREE.LinearSRGBColorSpace);
  assert.deepEqual(on.inline, { toneMapping: THREE.NeutralToneMapping, outputColorSpace: THREE.SRGBColorSpace });
});

test("installing on a renderer stub sets none/working, a context node with getOutput, and re-arms only on a change", () => {
  const renderer = { toneMapping: THREE.LinearToneMapping, outputColorSpace: THREE.SRGBColorSpace, toneMappingExposure: 1, contextNode: null, isOutputTarget: true };
  const holder = installDirectOutput(renderer, { toneMapping: THREE.LinearToneMapping, outputColorSpace: THREE.SRGBColorSpace });
  assert.equal(renderer.toneMapping, THREE.NoToneMapping);
  assert.equal(renderer.outputColorSpace, THREE.LinearSRGBColorSpace);
  assert.ok(renderer.contextNode, "a context node is installed");
  const first = renderer.contextNode;
  assert.equal(typeof first.getFlowContextData?.().getOutput, "function");
  const version0 = first.version ?? 0;
  // Same values again: no re-mint (same version).
  applyOutputTransform(renderer, { toneMapping: THREE.LinearToneMapping, exposure: 1.5 });
  assert.equal(renderer.contextNode, first);
  assert.equal(first.version ?? 0, version0);
  assert.equal(renderer.toneMappingExposure, 1.5);
  // A different tone mapping: the same node, one version bump (the cache key moves once).
  applyOutputTransform(renderer, { toneMapping: THREE.AgXToneMapping });
  assert.equal(renderer.contextNode, first);
  assert.equal(first.version, version0 + 1);
  assert.equal(holder.toneMapping, THREE.AgXToneMapping);
  assert.equal(renderer.toneMapping, THREE.NoToneMapping, "the renderer itself never tone-maps on this path");
  // Idempotent install.
  assert.equal(installDirectOutput(renderer), holder);
});

test("the getOutput hook wraps only the output target's materials", () => {
  const renderer = { toneMapping: THREE.NoToneMapping, outputColorSpace: THREE.SRGBColorSpace, contextNode: null, isOutputTarget: true };
  installDirectOutput(renderer, { toneMapping: THREE.NeutralToneMapping, outputColorSpace: THREE.SRGBColorSpace });
  const { getOutput } = renderer.contextNode.getFlowContextData();
  assert.equal(typeof getOutput, "function");
  const color = { isNode: true, marker: "color" };
  const offscreen = getOutput(color, { renderer: { isOutputTarget: false } });
  assert.equal(offscreen, color, "an offscreen build keeps linear colour");
  const onscreen = getOutput(color, { renderer: { isOutputTarget: true } });
  assert.ok(onscreen && onscreen !== color, "the output target's build is wrapped");
});

test("withRealOutput hands the real transform to a render override and restores none/working after", () => {
  const renderer = { toneMapping: THREE.NoToneMapping, outputColorSpace: THREE.SRGBColorSpace, contextNode: null, isOutputTarget: true };
  installDirectOutput(renderer, { toneMapping: THREE.ACESFilmicToneMapping, outputColorSpace: THREE.SRGBColorSpace });
  let seen = null;
  withRealOutput(renderer, () => { seen = [renderer.toneMapping, renderer.outputColorSpace]; });
  assert.deepEqual(seen, [THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace]);
  assert.equal(renderer.toneMapping, THREE.NoToneMapping);
  assert.equal(renderer.outputColorSpace, THREE.LinearSRGBColorSpace);
  // Without the install it is a plain call.
  const plain = { toneMapping: THREE.AgXToneMapping };
  assert.equal(withRealOutput(plain, () => 42), 42);
});
