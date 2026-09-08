import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE STASH/ADOPT PIPELINE CACHE (PostprocessComponent) trades on one
 * invariant: a stashed bundle is a COMPLETE, restorable pipeline — every field
 * `#disposePipeline` clears must travel into the bundle, or an adopt restores
 * a HALF pipeline. That is not hypothetical: the first version of the bundle
 * omitted the editor overlay pass, and `#applyEditorHelpers` had baked that
 * pass's textures into the stashed `outputNode` — the next camera's build
 * disposed the overlay out from under the stash, and adopting it later
 * restored a pipeline sampling a disposed PassNode.
 *
 * The engine can't run these paths without a GPU, so this pins the invariant
 * structurally: every `this.x = null` inside the dispose paths must be listed
 * in `PIPELINE_BUNDLE_FIELDS`, and the fields that must TRAVEL (the overlay
 * state and `_passCamera`) must be on the list even though dispose doesn't
 * null them.
 */
const src = readFileSync(
  fileURLToPath(new URL("../src/modules/postprocessing/PostprocessComponent.js", import.meta.url)),
  "utf8",
);

function extractBundleFields() {
  const m = src.match(/static PIPELINE_BUNDLE_FIELDS = \[([^\]]*)\]/s);
  assert.ok(m, "PIPELINE_BUNDLE_FIELDS found");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function slice(from, to) {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a) : src.length;
  assert.ok(a >= 0, `marker ${from} found`);
  return src.slice(a, b);
}

test("every field dispose nulls is in the stashable bundle", () => {
  const fields = new Set(extractBundleFields());
  const bodies =
    slice("#disposePipeline({ keepStashes = false } = {}) {", "handleResize(") +
    slice("#disposeEditorOverlayPass()", "static PIPELINE_BUNDLE_FIELDS");
  const nulled = [...bodies.matchAll(/this\.(\w+) = null/g)].map((m) => m[1]);
  assert.ok(nulled.length >= 8, "sanity: the dispose paths really clear fields");
  for (const key of nulled) {
    assert.ok(fields.has(key), `"${key}" is nulled by dispose but missing from PIPELINE_BUNDLE_FIELDS`);
  }
});

test("the overlay state and the pass camera travel with a bundle", () => {
  const fields = extractBundleFields();
  for (const key of ["editorOverlayPass", "_overlaySeedQuad", "_overlayLiveU", "_passCamera", "keepaliveTemps"]) {
    assert.ok(fields.includes(key), `"${key}" must be stashed with the pipeline`);
  }
});

test("the stash nulls fields BEFORE withdrawing the published scene pass", () => {
  // #unpublishScenePass only withdraws when this.scenePass is already null —
  // the withdraw must run after the bundle takes the fields, or
  // engine.scenePass keeps pointing at a pass the component no longer owns.
  const body = slice("#stashPipelineFor(camera) {", "#adoptPipelineFor(camera) {");
  const stashNulled = body.indexOf("this[key] = null");
  const unpublish = body.indexOf("#unpublishScenePass()");
  assert.ok(stashNulled >= 0 && unpublish >= 0, "both steps present");
  assert.ok(stashNulled < unpublish, "fields move first, unpublish second");
});

test("a camera swap never drops the other camera's stashed bundle", () => {
  // Anchor on the METHOD (a "#syncRenderCamera(" call site fires first in onAttach).
  const sync = slice("#syncRenderCamera() {", "ownsCamera(");
  const keep = sync.includes("#disposePipeline({ keepStashes: true })");
  const adopt = sync.includes("#adoptPipelineFor(next)");
  assert.ok(keep, "a camera-path dispose must keep stashes");
  assert.ok(adopt, "the null-pipeline path still tries adoption before rebuilding");
});

test("an eligible camera with no pipeline self-heals — and a failed build is caught, not voided", () => {
  // THE REPORT: post missing after scene load AND missing in the exported
  // build, appearing only after an unrelated parameter edit forced a rebuild.
  // A load-time build that aborted or REJECTED left the component
  // permanently pipelineless — every `void this.#ensurePipeline(...)` call
  // site swallowed the rejection, and nothing ever retried. ownsCamera runs
  // every frame the engine consults its overrides, so the retry lives there.
  const owns = slice("ownsCamera(", "#syncRenderCamera() {");
  const iAllowed = owns.indexOf("if (!allowed) return false;");
  const iHeal = owns.indexOf("#ensurePipeline(\"self-heal (eligible, no pipeline)\")");
  assert.ok(iAllowed >= 0, "ownsCamera still gates on `allowed`");
  assert.ok(iHeal > iAllowed, "an allowed-but-pipelineless camera kicks a rebuild");
  assert.ok(owns.includes("!this._buildInFlight"), "a pending build is never double-kicked");
  const ensure = slice("async #ensurePipeline(", "#ensurePipelineInner(reason = \"unspecified\")");
  assert.ok(ensure.includes("catch (err)"), "#ensurePipeline must catch — a rejection in a `void` call dies silently");
});

test("a godrays graph compiled without a light rebuilds when one appears — and the rebuild bypasses the hot-param exit", () => {
  // THE BUILD REPORT, root cause: god rays compile against a light snapshot
  // taken at build time, but at boot that light has NO shadow map yet (three
  // renders maps after the first frame; scene settings can apply after the
  // components attach). findGodraysLight correctly refuses a mapless light,
  // the node compiles marching nothing, and nothing ever re-ran the
  // resolution — god rays stayed dark until an edit forced a rebuild, and
  // forever in the preview build where nobody edits. render() now polls for
  // the light when a compile wanted it and got none, and the rebuild MUST
  // bypass the hot-param early return: the graph signature is identical by
  // construction, so the early return would swallow exactly this rebuild
  // (observed live: the watcher fired, the flag reset, god rays stayed dark).
  const render = slice("  render(engine) {", "  // ---------");
  const iAwait = render.indexOf("this._godraysAwaitingLight");
  const iKick = render.indexOf("#ensurePipeline(\"godrays light appeared\")");
  assert.ok(iAwait >= 0 && iKick > iAwait, "render() polls while god rays await a light, and kicks the rebuild");
  assert.ok(render.includes("findGodraysLight(engine)"), "only a REAL shadow-mapped light ends the wait (no GI-fallback loop)");

  const inner = slice("#ensurePipelineInner(reason = \"unspecified\") {", "    this.generation++");
  const iExit = inner.indexOf("if (!reresolveGodraysLight && signature === this.signature");
  assert.ok(iExit >= 0, "the hot-param early return knows about the godrays re-resolve");
  const iDef = inner.indexOf("const reresolveGodraysLight = reason === \"godrays light appeared\";");
  assert.ok(iDef >= 0 && iDef < iExit, "the exemption is derived from the reason, before the exit");
});
