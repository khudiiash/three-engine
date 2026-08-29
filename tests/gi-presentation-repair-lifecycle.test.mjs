import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/modules/gi/GISystem.js", import.meta.url),
  "utf8",
);

test("GI presentation repairs are invalidated before rebuild state changes", () => {
  const start = source.indexOf("  #dispose() {");
  const end = source.indexOf("\n  #", start + 16);
  assert.ok(start >= 0 && end > start, "#dispose body is present");
  const body = source.slice(start, end);
  const invalidate = body.indexOf("this._giTextureRepairGeneration =");
  const cancel = body.indexOf("this._giPresentationRepair?.cancel?.()");
  const readState = body.indexOf("const state = this.state");
  const clearState = body.indexOf("this.state = null");
  assert.ok(invalidate >= 0 && cancel > invalidate, "repair generation is invalidated and active repair canceled");
  assert.ok(cancel < readState && readState < clearState, "cancellation precedes all state mutation");
});

test("canceled repair callbacks become terminal-ready without publishing", () => {
  const start = source.indexOf("  #createGiTextureRepair(");
  const end = source.indexOf("\n  #", start + 28);
  assert.ok(start >= 0 && end > start, "repair factory is present");
  const body = source.slice(start, end);
  assert.match(body, /generation !==[\s\S]*return cancel\(\)/);
  assert.match(body, /complete: true, canceled: true/);
  const cancelBody = body.slice(body.indexOf("const cancel ="), body.indexOf("const repair ="));
  assert.doesNotMatch(cancelBody, /onComplete\?\.\(/);
});
