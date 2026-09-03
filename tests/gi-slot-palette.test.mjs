import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three/webgpu";
import { instancedArray, uint, uniformArray } from "three/tsl";

import { SURFACE_PALETTE_WORDS as FIELD_WORDS } from "../src/modules/gi/occupancyField.js";
import { slotKeyOf } from "../src/modules/gi/slotRegistry.js";
import { SURFACE_PALETTE_WORDS, createSrcSlotPalette } from "../src/modules/gi/srcSlotPalette.js";

/**
 * The field-less slot palette (`srcSlotPalette.js`): the CPU half of what
 * `createSrcSurfaceAttribution` used to own. Pinned here because the words it
 * stages are read by TWO transports (the cell-keyed occupancy lookup and the
 * BVH trace) and a drift between "what the field wrote" and "what the factory
 * writes" would be a colour bug with no GPU counter.
 *
 * Run with `node --test tests/gi-slot-palette.test.mjs`. No GPU: the pass is
 * built (a TSL compute node constructs fine under node) but never dispatched;
 * what is checked is the staging uniform, which is exactly what the pass
 * copies.
 */

const SLOTS = 8;
const WORD_OFFSET = 64;

const mesh = (name, { color = [1, 1, 1], emissive = [0, 0, 0], emissiveIntensity = 1 } = {}) => {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(...color),
      emissive: new THREE.Color(...emissive),
      emissiveIntensity,
    }),
  );
  m.name = name;
  return m;
};
const rgb = ([r, g, b]) => ({ r, g, b });
const surface = (color, emissive = [0, 0, 0]) => ({ color: rgb(color), emissive: rgb(emissive) });
const assign = (m, surf, instanceId = null) => ({ key: slotKeyOf(m, instanceId), surface: surf });
const atlas = (entries) => ({ assignments: entries, revision: 1, surfaceRevision: 1 });
const makeBits = () => instancedArray(WORD_OFFSET + SLOTS * SURFACE_PALETTE_WORDS, "uint");

const build = (overrides = {}) =>
  createSrcSlotPalette({
    bits: makeBits(),
    wordOffset: WORD_OFFSET,
    slots: SLOTS,
    placements: () => [],
    assignments: atlas([]),
    ...overrides,
  });

/** A fixture with two numberings that disagree — the §12.9 shape. */
function crossedFixture() {
  const A = mesh("A", { color: [1, 0, 0] });
  const B = mesh("B", { color: [0, 1, 0] });
  const C = mesh("C"); // occupies a slot, never seated an atlas entry
  const D = mesh("D", { color: [0, 0, 1] });
  // Registry numbering: B is 0, A is 1. Occupancy numbering: A is 5, B is 2.
  const slots = atlas([assign(B, surface([0, 1, 0])), assign(A, surface([1, 0, 0])), assign(D, surface([0, 0, 1]))]);
  const placements = [
    { mesh: A, instanceId: null, slot: 5 },
    { mesh: B, instanceId: null, slot: 2 },
    { mesh: C, instanceId: null, slot: 3 },
    { mesh: D, instanceId: null, slot: 99 }, // past the palette: overflow, not aliasing
  ];
  return { A, B, C, D, slots, placements };
}

test("the stride is the field's constant, re-exported rather than redeclared", () => {
  assert.equal(SURFACE_PALETTE_WORDS, 8);
  assert.equal(SURFACE_PALETTE_WORDS, FIELD_WORDS);
});

test("publishes each placement under its OCCUPANCY slot, bridged to the atlas by key", () => {
  const { slots, placements } = crossedFixture();
  const bits = makeBits();
  const p = createSrcSlotPalette({
    bits, wordOffset: WORD_OFFSET, slots: SLOTS, placements: () => placements, assignments: slots,
  });

  assert.deepEqual(p.palette, { bits, wordOffset: WORD_OFFSET, words: 8, slots: SLOTS });
  assert.equal(p.passes.length, 1, "one copy pass, built by the factory");
  assert.equal(p.debug.paletteSlots, SLOTS);
  assert.equal(p.debug.ownsUniform, true);

  // A is red at OCCUPANCY slot 5, B green at 2 — and NOT at their registry indices.
  assert.deepEqual(p.debug.paletteEntry(5), { albedo: [1, 0, 0], emitter: -1, emissive: [0, 0, 0], live: 1 });
  assert.deepEqual(p.debug.paletteEntry(2), { albedo: [0, 1, 0], emitter: -1, emissive: [0, 0, 0], live: 1 });
  assert.equal(p.debug.paletteEntry(0).live, 0, "registry index 0 (B) must not be written");
  assert.equal(p.debug.paletteEntry(1).live, 0, "registry index 1 (A) must not be written");
  // C has a slot but no atlas entry: live 0, so the GPU reads it as unattributed.
  assert.deepEqual(p.debug.paletteEntry(3), { albedo: [0, 0, 0], emitter: -1, emissive: [0, 0, 0], live: 0 });

  assert.equal(p.stats.live, 2);
  assert.equal(p.stats.unassigned, 1);
  assert.equal(p.stats.slotOverflow, 1);
  assert.equal(p.stats.emitters, 0);
  assert.equal(p.stats.emissiveOrphans, 0);
  assert.equal(p.stats.syncs, 1, "the factory syncs once on construction");
  // The fallback is the mean over LIVE slots (red + green), not a constant grey.
  assert.deepEqual(p.debug.fallbackAlbedo, [0.5, 0.5, 0]);
  assert.deepEqual(
    [p.fallbackAlbedo.value.x, p.fallbackAlbedo.value.y, p.fallbackAlbedo.value.z],
    [0.5, 0.5, 0],
    "the uniform the GPU reads is the same mean",
  );
});

test("with no live slot the fallback stays at the unreachable 0.5 grey", () => {
  const p = build();
  assert.equal(p.stats.live, 0);
  assert.deepEqual(p.debug.fallbackAlbedo, [0.5, 0.5, 0.5]);
});

test("crossNumbering (the deliberate-failure arm) writes under the registry's index", () => {
  const { slots, placements } = crossedFixture();
  const p = build({ placements: () => placements, assignments: slots, crossNumbering: true });
  assert.deepEqual(p.debug.paletteEntry(1).albedo, [1, 0, 0], "A lands at its registry index");
  assert.deepEqual(p.debug.paletteEntry(0).albedo, [0, 1, 0], "B lands at its registry index");
  assert.equal(p.debug.paletteEntry(5).live, 0, "and nothing at the occupancy slot");
  assert.equal(p.debug.paletteEntry(2).live, 0);
});

test("an instanced placement is keyed by mesh uuid + instance id", () => {
  const I = mesh("I", { color: [0.2, 0.4, 0.6] });
  const slots = atlas([assign(I, surface([0.2, 0.4, 0.6]), 3)]);
  const placements = [
    { mesh: I, instanceId: 3, slot: 4 },
    { mesh: I, instanceId: 7, slot: 6 }, // a different instance, never seated
  ];
  const p = build({ placements: () => placements, assignments: slots });
  assert.deepEqual(p.debug.paletteEntry(4).albedo, [0.2, 0.4, 0.6]);
  assert.equal(p.debug.paletteEntry(6).live, 0);
  assert.equal(p.stats.unassigned, 1);
});

test("NEE seats flag their slot by index (+1 in the word); an unclaimed dark-published emitter is an orphan", () => {
  // E1: emits, published dark (promoted → zeroed on the CPU), claimed by seat 1.
  const E1 = mesh("E1", { emissive: [1, 1, 1], emissiveIntensity: 5 });
  // E2: emits, published dark, claimed by NOBODY — light deleted from both paths.
  const E2 = mesh("E2", { emissive: [0, 0, 1], emissiveIntensity: 1 });
  // E3: emits, published emissive intact — carried on the contact path, no seat needed.
  const E3 = mesh("E3", { emissive: [1, 0, 0], emissiveIntensity: 2 });
  // E4: does not emit at all, published dark — nothing to orphan.
  const E4 = mesh("E4");
  const slots = atlas([
    assign(E1, surface([1, 1, 1], [0, 0, 0])),
    assign(E2, surface([1, 1, 1], [0, 0, 0])),
    assign(E3, surface([1, 1, 1], [2, 0, 0])),
    assign(E4, surface([0.3, 0.3, 0.3], [0, 0, 0])),
  ]);
  const placements = [
    { mesh: E1, slot: 0 }, { mesh: E2, slot: 1 }, { mesh: E3, slot: 2 }, { mesh: E4, slot: 3 },
  ];
  const p = build({
    placements: () => placements,
    assignments: slots,
    emitterMeshes: () => [null, E1], // a parked seat, then E1 at index 1
  });
  assert.equal(p.debug.paletteEntry(0).emitter, 1, "E1's emitter index is its seat index");
  assert.equal(p.debug.paletteEntry(1).emitter, -1);
  assert.equal(p.debug.paletteEntry(2).emitter, -1);
  assert.deepEqual(p.debug.paletteEntry(2).emissive, [2, 0, 0], "published emissive is carried verbatim");
  assert.equal(p.stats.emitters, 1);
  assert.equal(p.stats.emissiveOrphans, 1, "E2 alone is an orphan");
  assert.equal(p.stats.live, 4);
});

test("change detection: a no-op sync is free; force, a recolour, a rebuild, a seat turnover and a revision each re-sync", () => {
  const A = mesh("A", { color: [1, 0, 0] });
  const slots = atlas([assign(A, surface([1, 0, 0]))]);
  let placements = [{ mesh: A, slot: 0 }];
  let emitters = [];
  const p = build({ placements: () => placements, assignments: slots, emitterMeshes: () => emitters });
  assert.equal(p.stats.syncs, 1);

  p.sync();
  assert.equal(p.stats.syncs, 1, "nothing moved: no rewrite");
  p.sync(true);
  assert.equal(p.stats.syncs, 2, "force rewrites");

  // A recolour: surfaceRevision moves, the entry follows, `revision` untouched.
  slots.assignments[0].surface = surface([0, 0, 1]);
  p.sync();
  assert.equal(p.stats.syncs, 2, "a mutated surface without a revision bump is invisible by design");
  slots.surfaceRevision++;
  p.sync();
  assert.equal(p.stats.syncs, 3);
  assert.deepEqual(p.debug.paletteEntry(0).albedo, [0, 0, 1]);

  // A content rebuild: same contents, new array identity.
  placements = [{ mesh: A, slot: 0 }];
  p.sync();
  assert.equal(p.stats.syncs, 4);

  // A seat turnover.
  emitters = [A];
  p.sync();
  assert.equal(p.stats.syncs, 5);
  assert.equal(p.debug.paletteEntry(0).emitter, 0);
  assert.equal(p.stats.emitters, 1);

  // A seat/clear/drag.
  slots.revision++;
  p.sync();
  assert.equal(p.stats.syncs, 6);

  // A growth in place (same array, pushed) is a change too.
  const B = mesh("B", { color: [0, 1, 0] });
  slots.assignments.push(assign(B, surface([0, 1, 0])));
  placements.push({ mesh: B, slot: 1 });
  p.sync();
  assert.equal(p.stats.syncs, 7);
  assert.equal(p.stats.live, 2);

  // dispose() forgets what it saw, so the next sync is a real one.
  p.dispose();
  p.sync();
  assert.equal(p.stats.syncs, 8);
});

test("adopts a caller's uniform + pass, fills that uniform, and stages the same words as an owned pair", () => {
  const { slots, placements } = crossedFixture();
  const E = mesh("E", { emissive: [1, 1, 1] });
  slots.assignments.push(assign(E, surface([0.5, 0.5, 0.5], [3, 2, 1])));
  placements.push({ mesh: E, slot: 7 });
  const emitterMeshes = () => [E];

  const fieldUniform = uniformArray(Array.from({ length: SLOTS * 2 }, () => new THREE.Vector4()), "vec4");
  const fieldPass = { sentinel: "the field's palettePass" };
  const adopted = build({
    placements: () => placements, assignments: slots, emitterMeshes,
    paletteUniform: fieldUniform, palettePass: fieldPass,
  });
  assert.equal(adopted.passes.length, 1);
  assert.equal(adopted.passes[0], fieldPass, "the field's pass, not a second one");
  assert.equal(adopted.debug.ownsUniform, false);

  const owned = build({ placements: () => placements, assignments: slots, emitterMeshes });
  assert.notEqual(owned.passes[0], fieldPass);

  // The staged words are what the pass copies; they must agree slot for slot,
  // and the adopted one must have landed in the CALLER's array.
  for (let s = 0; s < SLOTS; s++) {
    assert.deepEqual(adopted.debug.paletteEntry(s), owned.debug.paletteEntry(s), `slot ${s}`);
    const a = fieldUniform.array[s * 2];
    const e = fieldUniform.array[s * 2 + 1];
    assert.deepEqual(adopted.debug.paletteEntry(s), {
      albedo: [a.x, a.y, a.z], emitter: a.w - 1, emissive: [e.x, e.y, e.z], live: e.w,
    });
  }
  assert.deepEqual(adopted.debug.paletteEntry(7), { albedo: [0.5, 0.5, 0.5], emitter: 0, emissive: [3, 2, 1], live: 1 });
  assert.equal(fieldUniform.array[7 * 2].w, 1, "word 3 stages emitter index + 1");
  assert.deepEqual(adopted.stats, owned.stats);
});

test("the TSL reader decodes the eight words at wordOffset + slot * words", () => {
  const p = build();
  const r = p.paletteAt(uint(3));
  for (const key of ["albedo", "emitter", "emissive", "live", "base", "rawWord0"]) {
    assert.ok(r[key] != null && typeof r[key] === "object", `paletteAt returns a node for ${key}`);
  }
});

test("the factory's copy pass writes the eight words exactly as the field's pass does", async () => {
  // Byte-identity is a claim about the PASS BODY, so pin it on the source: the
  // eight `bits.element(...).assign(...)` lines must be the same text in both
  // files. A drift here is a second author of the palette words.
  const wordWrites = (source, from) => {
    const start = source.indexOf(from);
    assert.ok(start >= 0, `pass anchor "${from}" found`);
    const end = source.indexOf(".compute(Math.max(1,", start);
    assert.ok(end > start, "pass ends in a compute() dispatch");
    return source
      .slice(start, end)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("bits.element("));
  };
  const field = await readFile(new URL("../src/modules/gi/occupancyField.js", import.meta.url), "utf8");
  const factory = await readFile(new URL("../src/modules/gi/srcSlotPalette.js", import.meta.url), "utf8");
  const fieldWrites = wordWrites(field, "const palettePass = attributionEnabled");
  const factoryWrites = wordWrites(factory, "function buildPalettePass(");
  assert.equal(fieldWrites.length, SURFACE_PALETTE_WORDS, "the field writes every word");
  assert.deepEqual(factoryWrites, fieldWrites);
  // And the field's own pass stays in the surface attribution's `passes`: the
  // wrapper adopts, it does not rebuild.
  const surface = await readFile(new URL("../src/modules/gi/srcSurface.js", import.meta.url), "utf8");
  assert.match(surface, /paletteUniform,\s*palettePass,\s*\}\)/, "srcSurface hands the field's pair to the factory");
  assert.match(surface, /passes: palette\.passes/);
});

test("refuses the shapes that would silently publish nothing", () => {
  assert.throws(() => build({ bits: null }), /bits/);
  assert.throws(() => build({ placements: [] }), /placements/);
  assert.throws(() => build({ assignments: [] }), /assignments/);
  assert.throws(() => build({ wordOffset: -1 }), /wordOffset/);
  assert.throws(() => build({ slots: 2.5 }), /slots/);
  assert.throws(() => build({ palettePass: {} }), /both or neither/);
  const short = uniformArray([new THREE.Vector4()], "vec4");
  assert.throws(() => build({ paletteUniform: short }), /2 per slot/);
});
