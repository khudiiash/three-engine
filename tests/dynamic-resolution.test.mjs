import assert from "node:assert/strict";
import test from "node:test";
import { drsBudgetMs } from "../src/engine/dynamicResolution.js";

test("the DRS budget is the authored target capped at the display's peak callback rate", () => {
  assert.equal(drsBudgetMs(120, 0), 1000 / 120); // no evidence yet: authored
  assert.equal(drsBudgetMs(120, 121), 1000 / 120); // a 120 Hz display keeps the authored aim
  assert.equal(drsBudgetMs(120, 60), 1000 / 60); // a phone at 60 Hz aims at 60, not 120
  assert.equal(drsBudgetMs(60, 120), 1000 / 60); // never raises the authored aim
  assert.equal(drsBudgetMs(0, 60), 1000 / 60); // unauthored: 60
  assert.equal(drsBudgetMs(120, 12), 1000 / 120); // a stalled boot is not a display rate
});
