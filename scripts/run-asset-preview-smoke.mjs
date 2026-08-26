// Every asset browser's detail pane shows something you can turn.
//
//   npx vite --port 5219
//   node scripts/run-asset-preview-smoke.mjs [url]
//
// HEADED=1 to watch it run, VERBOSE=1 for step tracing.
//
// `run-library-test.mjs` gates the wiring at source level and `run-fab-smoke`
// gates the APIs. Neither can see the thing that actually breaks a preview: a
// component that throws on render, a WebGPU context that never initialises, an
// iframe that resolves to a blank page. This boots the real editor, opens each
// keyless browser, clicks the first result, and looks for a canvas or a frame.
//
// Poly Pizza is absent for one reason: its API has no anonymous read tier, so
// browsing it at all needs a personal key, and a test that fails on a machine
// without one teaches nothing. Its preview path is the oldest of the five and
// is the one the others were modelled on.
//
// itch.io is absent because it sells archives of loose files, not models —
// there is nothing to preview, deliberately.
//
// Network: the panels reach their APIs through Tauri commands, which the shim
// does not implement. They are supplied here as `extraCommands` backed by
// curl — not `fetch`, because Fab sits behind Cloudflare whose challenge is
// fingerprint-based and serves Node's undici a 403 for a request curl gets a
// 200 for. See run-fab-smoke.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5219/";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-preview-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "Preview", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "scenes"), { recursive: true });
fs.writeFileSync(
  path.join(root, "scenes", "Empty.scene"),
  JSON.stringify({ version: 1, name: "Empty", entities: [] }, null, 2),
);

const curlText = (target) =>
  execFileSync("curl", ["-sL", "-H", "User-Agent: three-engine/0.1", target], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
const curlBytes = (target) =>
  execFileSync("curl", ["-sL", "-H", "User-Agent: three-engine/0.1", target], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });

const extraCommands = {
  fetch_fab_text: ({ url: u }) => curlText(u),
  fetch_text: ({ url: u }) => curlText(u),
  // `fetch_bytes` returns raw bytes over the IPC channel; the shim's transport
  // is JSON, so hand back the base64 envelope it already understands.
  fetch_bytes: ({ url: u }) => ({ __b64: curlBytes(u).toString("base64") }),
  fetch_sketchfab_text: ({ url: u }) => curlText(u),
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: root, verbose: !!process.env.VERBOSE, extraCommands });

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name) => process.env.VERBOSE && console.log(`  [step] ${name}`);

step("goto");
await page.goto(url, { waitUntil: "load", timeout: 45000 });
await wait(6000);

await page.evaluate(async (projectRoot) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore.getState().openProject(projectRoot).then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));

for (let i = 0; i < 60 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);
step("project open");

/**
 * The four browsers this can drive, and what a working preview looks like in
 * each. The selector is the assertion: a `canvas` means our own renderer came
 * up, an `iframe` means the provider's viewer was framed. Both answer "can you
 * turn it"; a bare `<img>` does not, and is what this exists to catch.
 */
const BROWSERS = [
  // Fab is the one browser that uses BOTH paths: its own viewer when the
  // listing publishes one (about one free listing in ten), and our renderer
  // reading the real archive otherwise. Either satisfies "can you turn it".
  { module: "fab", panel: "fab", label: "Fab",
    preview: "iframe.model-preview-embed, .model-preview-stage canvas" },
  { module: "polyhaven", panel: "polyhaven", label: "Poly Haven", preview: ".model-preview-stage canvas", tab: "Models" },
  { module: "ambientcg", panel: "ambientcg", label: "ambientCG", preview: ".model-preview-stage canvas", tab: "Models" },
  { module: "sketchfab", panel: "sketchfab", label: "Sketchfab", preview: "iframe.model-preview-embed" },
];

// A freshly opened project finishes hydrating its own module list AFTER
// `openProject` resolves, and that hydration overwrites whatever the store held.
// An enable issued in the gap is silently reverted — which surfaces as the
// panel's "enable this module" gate, i.e. looking exactly like a failed search.
// A real user cannot hit this (they click the toggle seconds later); a harness
// hits it every run on whichever module it enables first.
await wait(3000);

for (const browserDef of BROWSERS) {
  step(`open ${browserDef.label}`);
  let enabled = false;
  for (let attempt = 0; attempt < 5 && !enabled; attempt++) {
    enabled = await page.evaluate(async (module) => {
      const { setModuleEnabled, useModulesStore } = await globalThis.__importLive("/src/editor/modules.js");
      await setModuleEnabled(module, true);
      return useModulesStore.getState().enabled.includes(module);
    }, browserDef.module);
    if (!enabled) await wait(1000);
  }
  check(`${browserDef.label}: the module enables`, enabled);
  await page.evaluate(async (panel) => {
    const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
    openPanel(panel);
  }, browserDef.panel);
  await wait(2000);

  const gated = await page.evaluate(() => !!document.querySelector(".ph-gate, .acg-gate"));
  check(`${browserDef.label}: the panel is not gated`, !gated);

  // Poly Haven and ambientCG open on their texture tab; the model preview only
  // exists on the model one.
  if (browserDef.tab) {
    const switched = await page.evaluate((label) => {
      const tab = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
      if (!tab) return false;
      tab.click();
      return true;
    }, browserDef.tab);
    check(`${browserDef.label}: has a ${browserDef.tab} tab`, switched);
    await wait(1200);
  }

  // The catalogue request is a real network round trip through curl.
  let tiles = 0;
  for (let i = 0; i < 40; i++) {
    tiles = await page.evaluate(() => document.querySelectorAll(".ph-tile, .acg-tile").length);
    if (tiles > 0) break;
    await wait(500);
  }
  check(
    `${browserDef.label}: the grid loads`,
    tiles > 0,
    tiles > 0 ? `${tiles} tiles` : await page.evaluate(() =>
      document.querySelector(".ph-status, .acg-status")?.textContent?.slice(0, 160) ?? "no status text either"),
  );
  if (tiles === 0) continue;

  // Several tiles, not one. Fab publishes its interactive viewer per LISTING,
  // and plenty of free listings have only stills — so "the first result has no
  // embed" is a fact about that listing, not a broken preview. The property
  // worth gating is that a browser CAN show one, which is what the equivalent
  // check in run-fab-smoke.mjs samples for at the API level.
  const attempts = Math.min(browserDef.preview.includes("iframe") ? 4 : 1, tiles);
  let found = false;
  for (let tile = 0; tile < attempts && !found; tile++) {
    await page.evaluate((index) => {
      document.querySelectorAll(".ph-tile, .acg-tile")[index]?.click();
    }, tile);
    await wait(2500);
    // Fab asks before downloading an archive over its size ceiling, so a large
    // listing shows a "Load 3D preview (…)" button instead of loading. Clicking
    // it is the user gesture the ceiling exists to require.
    await page.evaluate(() => {
      const button = [...document.querySelectorAll(".ph-detail button")]
        .find((b) => b.textContent.includes("Load 3D preview"));
      button?.click();
    });
    // The detail pane fetches (Fab), downloads an archive (ambientCG) or loads
    // a glTF (Poly Haven) before anything renders, so this waits rather than
    // polls once — ambientCG in particular is pulling a multi-megabyte ZIP.
    // A native Fab preview downloads an archive, so it gets the long budget
    // even though its selector also mentions an iframe.
    const budget = browserDef.preview === "iframe.model-preview-embed" ? 12 : 60;
    for (let i = 0; i < budget && !found; i++) {
      // A SIZED canvas, not merely a present one. `ModelPreview` renders its
      // <canvas> immediately and only creates the WebGPU renderer once the
      // model has loaded, so "the element exists" is true long before anything
      // is drawn — and for a Fab archive that gap is a multi-megabyte download.
      found = await page.evaluate(() => {
        if (document.querySelector("iframe.model-preview-embed")) return true;
        const canvas = document.querySelector(".model-preview-stage canvas");
        return !!canvas && canvas.width > 0 && canvas.clientWidth > 0;
      });
      if (!found) await wait(1000);
    }
  }
  check(
    `${browserDef.label}: the detail pane shows an interactive preview`,
    found,
    found ? browserDef.preview : `none of the first ${attempts} listings rendered ${browserDef.preview}`,
  );

  // Report which of the two paths this browser actually took, and surface the
  // preview's own error text when it took the native one and failed — "no
  // canvas" on its own does not distinguish "chose the embed" from "the model
  // would not load".
  const state = await page.evaluate(() => ({
    canvas: !!document.querySelector(".model-preview-stage canvas"),
    iframe: !!document.querySelector("iframe.model-preview-embed"),
    status: document.querySelector(".model-preview-stage .ph-status")?.textContent ?? null,
  }));
  step(`${browserDef.label}: ${JSON.stringify(state)}`);
  if (state.status) check(`${browserDef.label}: the preview did not error`, false, state.status);
  if (found && state.canvas) {
    check(
      `${browserDef.label}: the preview renders through our own WebGPU canvas`,
      true,
      "sized backing surface",
    );
  }
}

// Console gate. Third-party embeds are noisy about things we do not control
// (their own analytics, fonts, a sandbox they would like more of), so only
// errors that name our own code are fatal.
const ours = errors.filter(
  (text) => /\/src\/editor\/|ModelPreview|AssetPreview|previewSources|fab\.js/.test(text) || text.startsWith("pageerror:"),
);
check("no console errors from our own code", ours.length === 0, ours.slice(0, 3).join(" | "));

await browser.close();
fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`${failed.length} FAILED`);
  process.exit(1);
}
