/**
 * GI'S COMPUTE DISPATCH MUST NEVER THROW FROM ITS OWN BOOKKEEPING.
 *
 * `giCompute` wraps every dispatch in a `try/finally` that closes a freeze span,
 * publishes the current pass name and accumulates build time. It sits on the
 * hottest path GI has: `#refreshDynamicObjects` calls it every single tick and
 * `#compileWave` calls it throughout a rebuild.
 *
 * ⛔ WHAT THIS EXISTS FOR (2026-09-07, user-reported). The span token was
 * declared with `const` INSIDE the `try` and read in the `finally` — a sibling
 * scope, not an enclosing one — so every dispatch threw
 * `ReferenceError: kernelSpan is not defined`. Three things made that far worse
 * than a normal bug:
 *
 *   · a `finally` that throws REPLACES the real error, so the failure reported
 *     itself rather than whatever it interrupted;
 *   · it fired per dispatch, so the console filled with hundreds of identical
 *     stacks and GI was never committed at all;
 *   · `node --check` cannot see it, and neither can a brace-depth scan — a
 *     `try` block and its `finally` sit at the SAME depth, which is precisely
 *     why the heuristic guard written for this was thrown away and the real
 *     function is driven instead.
 *
 * The renderer here is a stub because nothing under test needs a GPU: what is
 * being asserted is the function's own control flow.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { giCompute } from "../src/modules/gi/GISystem.js";
import { freeze } from "../src/engine/freezeLedger.js";

/** A renderer whose `compute` records what it was handed. */
function stubRenderer(onCompute = () => {}) {
  const dispatched = [];
  return {
    dispatched,
    compute(node) {
      dispatched.push(node);
      onCompute(node);
    },
  };
}

const node = (name) => ({ name, isNode: true });

test("a dispatch runs the node and leaves the span stack clean", () => {
  const renderer = stubRenderer();
  const before = freeze._stackName.length;

  giCompute(renderer, node("occupancy"));

  assert.equal(renderer.dispatched.length, 1, "the node reached the renderer");
  assert.equal(
    freeze._stackName.length, before,
    "every span opened by the dispatch is closed again — a leak here silently "
      + "re-parents every later span onto GI's",
  );
});

test("an array dispatches one node at a time, in order", () => {
  // Not cosmetic: three accepts an array, but an array dispatch attributes
  // every pipeline it creates to the ARRAY, so the per-pass name is lost.
  const renderer = stubRenderer();
  giCompute(renderer, [node("a"), node("b"), node("c")]);
  assert.deepEqual(renderer.dispatched.map((n) => n.name), ["a", "b", "c"]);
});

test("nulls in the list are skipped rather than dispatched", () => {
  const renderer = stubRenderer();
  giCompute(renderer, [null, node("real"), undefined]);
  assert.deepEqual(renderer.dispatched.map((n) => n.name), ["real"]);
});

test("⛔ a failing dispatch reports ITS OWN error, not the finally's", () => {
  // THE REGRESSION. With the span token out of scope, the `finally` threw a
  // ReferenceError over the top of the real failure, so the one message that
  // could have identified the broken kernel never reached the console.
  const boom = new Error("Return is not defined");
  const renderer = stubRenderer(() => { throw boom; });

  assert.throws(
    () => giCompute(renderer, node("gi:tileBake")),
    (error) => {
      assert.equal(
        error, boom,
        `the caller must see the dispatch's own error, got: ${error?.message ?? error}`,
      );
      // The type, not the text: the historical kernel failure was itself
      // "Return is not defined", so matching on the words would have flagged
      // the very error this test is supposed to let through. A ReferenceError
      // reaching the caller means the FINALLY's bookkeeping broke.
      assert.ok(
        !(error instanceof ReferenceError),
        `the finally must not throw over the dispatch's error: ${error?.message ?? error}`,
      );
      return true;
    },
  );

  // And the stack is still usable afterwards: a throw must not leave the span
  // stack unbalanced, or every later block is misattributed to this one.
  const after = freeze._stackName.length;
  giCompute(stubRenderer(), node("next"));
  assert.equal(freeze._stackName.length, after);
});

test("a repeated dispatch of the same node stays quiet and keeps working", () => {
  // The second dispatch takes the already-built path, which skips the span
  // entirely — the branch where the token is 0 rather than a real handle. That
  // branch is the one a `freeze.end(undefined)` would hide in.
  const renderer = stubRenderer();
  const shared = node("gi:lightTree");
  giCompute(renderer, shared);
  giCompute(renderer, shared);
  giCompute(renderer, shared);
  assert.equal(renderer.dispatched.length, 3, "every dispatch still reaches the renderer");
  assert.equal(freeze._stackName.length, 0);
});

// ── §11.56: built kernels dispatch as one compute pass ─────────────────────
test("built nodes in a list go to the renderer as ONE array, in order; unbuilt ones split the group", () => {
  const renderer = stubRenderer();
  const a = node("a"), b = node("b"), c = node("c");
  // First pass: all unbuilt → three singles (each builds alone, in its span).
  giCompute(renderer, [a, b, c]);
  assert.deepEqual(renderer.dispatched.map((n) => Array.isArray(n) ? n.map((m) => m.name) : n.name), ["a", "b", "c"]);
  // Second pass: all built → one array call carrying the same order.
  renderer.dispatched.length = 0;
  giCompute(renderer, [a, b, c]);
  assert.equal(renderer.dispatched.length, 1, "one renderer.compute call for three built nodes");
  assert.ok(Array.isArray(renderer.dispatched[0]));
  assert.deepEqual(renderer.dispatched[0].map((n) => n.name), ["a", "b", "c"]);
  assert.ok(Number.isInteger(renderer.dispatched[0].id), "the group array carries an id (three keys its timestamp UID on context.id)");
  // The same composition reuses the same array object (stable pass data).
  const first = renderer.dispatched[0];
  renderer.dispatched.length = 0;
  giCompute(renderer, [a, b, c]);
  assert.equal(renderer.dispatched[0], first);
  // A new node in the middle splits the group: [a] | d (single, unbuilt) | [b, c].
  const d = node("d");
  renderer.dispatched.length = 0;
  giCompute(renderer, [a, d, b, c]);
  assert.deepEqual(
    renderer.dispatched.map((n) => Array.isArray(n) ? n.map((m) => m.name) : n.name),
    ["a", "d", ["b", "c"]],
  );
  assert.equal(freeze._stackName.length, 0);
});

test("a single built node still dispatches as a node, not a one-element array", () => {
  const renderer = stubRenderer();
  const solo = node("solo");
  giCompute(renderer, solo);
  giCompute(renderer, solo);
  assert.equal(renderer.dispatched.length, 2);
  assert.ok(!Array.isArray(renderer.dispatched[1]));
});

test("`__giComputeGroups = false` restores one call per node", () => {
  const renderer = stubRenderer();
  const a = node("a"), b = node("b");
  giCompute(renderer, [a, b]);
  globalThis.__giComputeGroups = false;
  try {
    renderer.dispatched.length = 0;
    giCompute(renderer, [a, b]);
    assert.deepEqual(renderer.dispatched.map((n) => n.name), ["a", "b"]);
  } finally {
    delete globalThis.__giComputeGroups;
  }
});

test("a throw inside a group still reports the group and leaves the span stack clean", () => {
  const boom = new Error("bind group invalid");
  const a = node("a"), b = node("b");
  giCompute(stubRenderer(), [a, b]);
  const renderer = stubRenderer((n) => { if (Array.isArray(n)) throw boom; });
  assert.throws(() => giCompute(renderer, [a, b]), (e) => e === boom);
  assert.equal(freeze._stackName.length, 0);
});
