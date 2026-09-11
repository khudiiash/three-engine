/**
 * WGSL BYTE-STABILITY — the receipt the disk cache needs.
 *
 * three names an unnamed storage buffer after its process-wide node id
 * (`NodeBuffer_55143`), so the same graph produces different WGSL text on
 * every boot and Chromium's compiled-shader disk cache — keyed on that text —
 * never serves the second boot. `canonicalizeWgsl` renames those identifiers
 * to per-module ordinals; `WgslRegistry` scores a boot against the previous
 * one so `profile.freezes.wgsl` can say whether the rename bought the hit.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeWgsl, hashText, WgslRegistry } from "../src/engine/wgslStable.js";

const KERNEL_BOOT_1 = `
struct NodeBuffer_55143Struct { data : array<u32> };
@group(0) @binding(3) var<storage, read> NodeBuffer_55143 : NodeBuffer_55143Struct;
@group(0) @binding(4) var<storage, read_write> NodeBuffer_55470 : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> giStaticBvh8 : array<u32>;
fn main() { let a = NodeBuffer_55470[0]; let b = NodeBuffer_55143.data[1]; let c = NodeBuffer_55470[2]; }
`;
/** The same graph on a boot where 1 200 more nodes were created first. */
const KERNEL_BOOT_2 = KERNEL_BOOT_1.replaceAll("55143", "56343").replaceAll("55470", "56670");

test("the same graph canonicalises to the same text across boots", () => {
  assert.notEqual(hashText(KERNEL_BOOT_1), hashText(KERNEL_BOOT_2), "the raw text differs, which is the whole problem");
  const a = canonicalizeWgsl(KERNEL_BOOT_1);
  const b = canonicalizeWgsl(KERNEL_BOOT_2);
  assert.equal(a, b);
  assert.equal(hashText(a), hashText(b));
});

test("ordinals follow first appearance and a named buffer is left alone", () => {
  const out = canonicalizeWgsl(KERNEL_BOOT_1);
  assert.match(out, /NodeBuffer_0Struct \{/, "the first id seen becomes 0, struct suffix included");
  assert.match(out, /var<storage, read> NodeBuffer_0 : NodeBuffer_0Struct/);
  assert.match(out, /var<storage, read_write> NodeBuffer_1 :/);
  assert.ok(out.includes("giStaticBvh8"), "an explicitly named buffer keeps its name");
  assert.ok(!out.includes("55143") && !out.includes("55470"), "no node id survives");
  assert.equal(canonicalizeWgsl(out), out, "idempotent");
});

test("text without id-derived names passes through untouched", () => {
  const plain = "fn main() { let nodeUniform7 = 1.0; var nodeVar3 : f32; }";
  assert.equal(canonicalizeWgsl(plain), plain);
  assert.equal(canonicalizeWgsl(""), "");
});

test("the registry scores a boot against the previous one, raw and canonical", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };

  const boot1 = new WgslRegistry(storage);
  boot1.record("compute_bvhHitShade", KERNEL_BOOT_1);
  boot1.record("fragment_MeshPhysical", "fn main() { let x = 1.0; }");
  boot1.persist();
  const first = boot1.summary();
  assert.equal(first.modules, 2);
  assert.equal(first.previousBoot, null, "nothing to compare with on the first boot");
  assert.equal(first.renamed, 1);

  const boot2 = new WgslRegistry(storage);
  boot2.record("compute_bvhHitShade", KERNEL_BOOT_2);
  boot2.record("fragment_MeshPhysical", "fn main() { let x = 1.0; }");
  boot2.record("compute_newKernel", "fn main() { let y = 2.0; }");
  const second = boot2.summary();
  assert.equal(second.previousBoot.modules, 2);
  assert.equal(second.rawHitsFromLastBoot, 1, "only the id-free material text matches byte for byte");
  assert.equal(second.canonicalHitsFromLastBoot, 2, "canonically the kernel matches too");
  assert.equal(second.rescuedByRename, 1, "…which is the rename's receipt");
  assert.deepEqual(second.stillUnstable.map((m) => m.label), ["compute_newKernel"]);
});

test("the text handed to the device is the canonical one, and the dump returns it", () => {
  const registry = new WgslRegistry(null);
  const entry = registry.record("compute_k", KERNEL_BOOT_1);
  assert.equal(entry.code, canonicalizeWgsl(KERNEL_BOOT_1));
  assert.equal(registry.module(0).code, entry.code);
  assert.equal(registry.list()[0].label, "compute_k");
  const raw = registry.record("compute_raw", KERNEL_BOOT_1, { canonical: false });
  assert.equal(raw.code, KERNEL_BOOT_1, "the A/B arm sends three's text through");
  assert.equal(raw.renamed, false);
});
