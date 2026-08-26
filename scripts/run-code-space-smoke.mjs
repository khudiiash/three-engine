// Space (and Backspace) must reach the Code panel while a node graph is open.
//
// React Flow registers `panActivationKeyCode` ("Space") and `deleteKeyCode`
// ("Backspace") on WINDOW and skips them only for a target its `isInputDOMNode`
// recognises: INPUT / SELECT / TEXTAREA / [contenteditable] / inside `.nokey`.
// Monaco 0.55 renders its input as `div.native-edit-context` (EditContext, no
// textarea), which is none of those — so with any graph panel mounted anywhere
// in the layout, Space was preventDefault-ed before the EditContext saw it and
// typing a space inserted nothing.
//
//   npx vite --port 5217
//   node scripts/run-code-space-smoke.mjs [url]
//
// HEADED=1 to watch it run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5217/";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-codespace-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "CodeSpace", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
const FILE = path.join(root, "scripts", "Typing.ts").replaceAll("\\", "/");
fs.writeFileSync(FILE, "export default class Typing {}\n");
// A material to open the shader graph on — the panel needs a target before it
// mounts its React Flow canvas, and the canvas is the whole precondition.
const MAT = path.join(root, "Test.mat").replaceAll("\\", "/");
fs.writeFileSync(MAT, JSON.stringify({ type: "standard", props: {} }, null, 2));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await installTauriShim(page, { writableRoot: root, verbose: !!process.env.VERBOSE });

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

await page.evaluate(async (projectRoot) => {
  const importLive = (q) => {
    const prefix = location.origin + q;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? q);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  globalThis.__engine = await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore.getState().openProject(projectRoot).then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));
for (let i = 0; i < 90 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);

// The precondition: a React Flow canvas mounted somewhere in the layout. It does
// not have to be the visible tab — only mounted — but the shader graph is the
// one that opens without a scene selection, so use it.
await page.evaluate(async (mat) => {
  const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
  useSelectionStore.getState().selectAsset(mat);
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("shaderGraph");
}, MAT);
for (let i = 0; i < 60; i++) {
  if (await page.evaluate(() => !!document.querySelector(".react-flow"))) break;
  await wait(300);
}
check("a node graph is mounted (React Flow is listening on window)", await page.evaluate(() => !!document.querySelector(".react-flow")));

await page.evaluate(async (file) => {
  const { openCodeFile, useCodeStore } = await globalThis.__importLive("/src/editor/codeStore.js");
  openCodeFile(file);
  // The Code panel keeps every open tab mounted and hides the inactive ones, so
  // "the first .monaco-editor" is not necessarily the one on screen.
  useCodeStore.getState().activate(file);
}, FILE);
for (let i = 0; i < 120; i++) {
  if (await page.evaluate(() => !!document.querySelector(".code-panel .monaco-editor"))) break;
  await wait(100);
}
await wait(1500);
check("the Code panel mounts Monaco", await page.evaluate(() => !!document.querySelector(".code-panel .monaco-editor")));

// Which input surface this Monaco build renders — a textarea on older builds, a
// `div.native-edit-context` from 0.55 with EditContext on. Printed rather than
// asserted: the point is that the guard must not depend on it.
const surface = await page.evaluate(() => {
  if (document.querySelector(".code-panel .monaco-editor .native-edit-context")) return "div.native-edit-context";
  if (document.querySelector(".code-panel .monaco-editor textarea")) return "textarea";
  return "none";
});
console.log(`  monaco input surface: ${surface}`);
check(
  "the input surface sits inside a `nokey` host",
  await page.evaluate(
    () => !!document.querySelector(".code-panel .monaco-editor")?.closest(".nokey"),
  ),
);

// The visible editor's input surface — a `div.native-edit-context` on Monaco
// 0.55 (EditContext), a `textarea` on older builds. The Code panel keeps every
// open tab mounted, so the hidden ones have to be skipped by geometry.
await page.evaluate(() => {
  globalThis.__monacoInput = () =>
    [...document.querySelectorAll(".code-panel .monaco-editor")]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => el.querySelector(".native-edit-context") ?? el.querySelector("textarea"))
      .find(Boolean) ?? null;
});
check("the visible editor exposes an input surface", await page.evaluate(() => !!globalThis.__monacoInput()));

/** Focus Monaco's real input surface and type through the keyboard. */
async function typeIntoMonaco(text) {
  await page.evaluate(() => {
    globalThis.__monacoInput()?.focus();
  });
  await wait(200);
  await page.keyboard.type(text, { delay: 30 });
  await wait(400);
}

const modelText = () =>
  page.evaluate(async (file) => {
    const { getModel } = await globalThis.__importLive("/src/editor/code/monaco.js");
    return (await getModel(file)).getValue();
  }, FILE);

// Selecting the material also opened it as a Code tab and made it active, so
// re-activate the script now that everything has settled.
await page.evaluate(async (file) => {
  const { useCodeStore } = await globalThis.__importLive("/src/editor/codeStore.js");
  useCodeStore.getState().activate(file);
}, FILE);
await wait(1200);

// Start from a known cursor position: end of the buffer.
await page.evaluate(() => {
  globalThis.__monacoInput()?.focus();
});
await page.keyboard.down("Control");
await page.keyboard.press("End");
await page.keyboard.up("Control");

/* -------------------------------------------------------------------------- */
/* 1 — spaces land                                                             */
/* -------------------------------------------------------------------------- */

console.log("\ntyping with a graph panel open");
if (process.env.VERBOSE) {
  console.log(
    "  diag:",
    JSON.stringify(
      await page.evaluate(async () => {
        const host = document.querySelector(".code-panel .code-editor-host");
        globalThis.__monacoInput()?.focus();
        const store = (await globalThis.__importLive("/src/editor/codeStore.js")).useCodeStore.getState();
        return {
          monacoCount: document.querySelectorAll(".code-panel .monaco-editor").length,
          hostVisible: !!host && host.getBoundingClientRect().width > 0,
          active: document.activeElement?.className || document.activeElement?.tagName,
          files: store.files,
          activePath: store.activePath,
        };
      }),
    ),
  );
}
await typeIntoMonaco("const a = 1");
const afterType = await modelText();
check("the typed text reaches the buffer", afterType.includes("const"), JSON.stringify(afterType.slice(-24)));
check("its spaces are not swallowed", afterType.includes("const a = 1"), JSON.stringify(afterType.slice(-24)));

/* -------------------------------------------------------------------------- */
/* 2 — Backspace edits text instead of deleting graph nodes                    */
/* -------------------------------------------------------------------------- */

await page.keyboard.press("Backspace");
await wait(400);
const afterBack = await modelText();
check("Backspace deletes a character in the buffer", afterBack.endsWith("const a = "), JSON.stringify(afterBack.slice(-24)));

/* -------------------------------------------------------------------------- */

const bad = errors.filter((e) => !/favicon|WebGPU|GPUAdapter|Rapier|404/i.test(e));
if (bad.length) console.log(`\nconsole errors:\n  ${bad.slice(0, 8).join("\n  ")}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`project: ${root}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
