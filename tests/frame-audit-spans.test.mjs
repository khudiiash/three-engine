import test from "node:test";
import assert from "node:assert/strict";
import { exclusiveSpanTotals } from "../src/engine/frameAudit.js";

const ms = (totals, name) => +(totals.get(name) ?? 0).toFixed(3);

test("nested spans bill the innermost, never twice", () => {
  // three's frame callback runs 0..10; the engine's tick runs 2..8 inside it.
  const totals = exclusiveSpanTotals([
    { label: "raf", kind: "raf", start: 0, end: 10 },
    { label: "engine tick", kind: "engine", start: 2, end: 8 },
  ]);
  assert.equal(ms(totals, "engine tick"), 6);
  assert.equal(ms(totals, "raf"), 4); // 0..2 and 8..10, not 10
  assert.equal(ms(totals, "raf") + ms(totals, "engine tick"), 10);
});

test("adjacent spans are not treated as nested", () => {
  const totals = exclusiveSpanTotals([
    { label: "a", kind: "raf", start: 0, end: 5 },
    { label: "b", kind: "raf", start: 5, end: 9 },
  ]);
  assert.equal(ms(totals, "a"), 5);
  assert.equal(ms(totals, "b"), 4);
});

test("gaps between spans are billed to nobody", () => {
  const totals = exclusiveSpanTotals([
    { label: "a", kind: "raf", start: 0, end: 2 },
    { label: "b", kind: "raf", start: 6, end: 7 },
  ]);
  assert.equal(ms(totals, "a") + ms(totals, "b"), 3);
});

test("repeated calls accumulate under one name", () => {
  const totals = exclusiveSpanTotals([
    { label: "loop", kind: "raf", start: 0, end: 1 },
    { label: "loop", kind: "raf", start: 10, end: 12 },
    { label: "loop", kind: "raf", start: 20, end: 20.5 },
  ]);
  assert.equal(ms(totals, "loop"), 3.5);
});

test("three levels deep still bill once", () => {
  const totals = exclusiveSpanTotals([
    { label: "outer", kind: "raf", start: 0, end: 10 },
    { label: "middle", kind: "raf", start: 1, end: 9 },
    { label: "inner", kind: "engine", start: 4, end: 5 },
  ]);
  assert.equal(ms(totals, "outer"), 2);
  assert.equal(ms(totals, "middle"), 7);
  assert.equal(ms(totals, "inner"), 1);
  assert.equal(ms(totals, "outer") + ms(totals, "middle") + ms(totals, "inner"), 10);
});

test("a zero-length span is ignored rather than charged", () => {
  const totals = exclusiveSpanTotals([{ label: "a", kind: "raf", start: 3, end: 3 }]);
  assert.equal(totals.size, 0);
});
