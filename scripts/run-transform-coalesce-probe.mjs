// Probe for the entity.setTransform coalescing fix (editor-transform branch).
//
// Before the fix: every entity.setTransform call ran commandBus.execute(),
// which called useSceneStore.refresh() — a full re-mirror of every entity in
// the scene, replacing the store map and invalidating every React
// subscriber. A script/agent calling entity.setTransform once per frame (a
// per-frame drag) therefore minted one undo entry per frame AND paid a
// whole-scene React re-render per frame.
//
// After the fix: entity.setTransform runs commandBus.executeCoalesced(),
// which (a) updates only the moved entity's mirrored transform via the
// existing lazy updateTransform(), and (b) collapses a burst of same-entity
// calls arriving within 300ms of each other into the ONE undo entry already
// on top of the stack.
//
// This probe proves (b) directly and observably: a burst of N setTransform
// calls, each <300ms apart, followed by exactly ONE undo, must revert all
// the way back to the pre-burst pose — not just undo the last call.
//
//   node scripts/run-transform-coalesce-probe.mjs [url]
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:5212/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADLESS ? "new" : false,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 6000));

const out = await page.evaluate(async () => {
  const importLive = (path) => {
    const prefix = location.origin + path;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? path);
  };

  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  if (!engine.renderer) return { fatal: "engine has no renderer" };

  const Editor = globalThis.__editorApi;
  if (!Editor) return { fatal: "globalThis.__editorApi is missing" };

  const created = await Editor.call("entity.create", {
    name: "TxCoalesceProbe",
    transform: { position: [0, 0, 0] },
  });
  const id = created.id;

  const before = await Editor.call("entity.get", { id });
  const startPos = before.transform.position;

  // Burst: 20 calls, ~15ms apart (well inside the 300ms coalescing window),
  // ~300ms total — meant to model a per-frame drag from a script/MCP client.
  const N = 20;
  for (let i = 1; i <= N; i++) {
    await Editor.call("entity.setTransform", { id, position: [i, 0, 0] });
    await new Promise((r) => setTimeout(r, 15));
  }

  const afterBurst = await Editor.call("entity.get", { id });
  const mirrorLive = JSON.stringify(afterBurst.transform.position) === JSON.stringify([N, 0, 0]);

  const historyBeforeUndo = await Editor.history.get();

  Editor.history.undo(); // should undo the WHOLE burst in one step
  const afterOneUndo = await Editor.call("entity.get", { id });
  const revertedToStart = JSON.stringify(afterOneUndo.transform.position) === JSON.stringify(startPos);

  Editor.history.undo(); // should now undo entity.create itself
  const afterSecondUndo = (await Editor.call("entity.list", {})).some((e) => e.id === id);

  return {
    startPos,
    mirrorLive,
    burstFinalLabel: historyBeforeUndo.undoLabel,
    revertedToStart,
    afterBurstPos: afterBurst.transform.position,
    afterOneUndoPos: afterOneUndo.transform.position,
    entityGoneAfterSecondUndo: afterSecondUndo === false,
  };
});

console.log("raw:", JSON.stringify(out, null, 2));

if (out.fatal) {
  console.log(`FATAL: ${out.fatal}`);
  await browser.close();
  process.exit(1);
}

check("mirror stayed live across the burst (updateTransform, not stale)", out.mirrorLive, JSON.stringify(out.afterBurstPos));
check(
  "ONE undo reverts the whole 20-call burst back to the pre-burst pose",
  out.revertedToStart,
  `start=${JSON.stringify(out.startPos)} afterOneUndo=${JSON.stringify(out.afterOneUndoPos)}`,
);
check("a second undo removes the entity itself (burst really was ONE entry)", out.entityGoneAfterSecondUndo);
check("no console/page errors", errors.length === 0, errors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
