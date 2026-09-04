// Viewport-screenshot hotkey smoke (Shift+Alt+S → PNG on disk).
//
// Gates the whole path the chord travels, because every way it can fail is
// SILENT — a keydown that matches nothing throws nowhere, a write to a
// misconfigured folder surfaces only as a toast nobody reads, and a Mac user
// pressing Option+Shift+S produces `key: "Í"`, a character no chord grammar
// was written to expect:
//
//   1. The default binding resolves and a REAL CDP keypress (Shift+Alt+S,
//      through keyScope and EditorChrome's dispatcher, not a faked event)
//      writes a PNG into the folder configured in project.json, named
//      `<prefix>-<date>_<time>.png`, with PNG magic bytes — the capture is the
//      LIVE canvas readback, so an all-black or zero-byte file means the
//      WebGPU copy path broke, not that the key didn't fire.
//   2. The macOS case: a synthetic keydown with `key: "Í"` (what Option+Shift+S
//      reports on a US layout) but `code: "KeyS"` is dispatched through the
//      REAL window listener and must produce a second file — keyTokenFromEvent
//      reading the physical key is the whole reason Alt-chords work there.
//   3. The visibility bindings this shares chordMatches with still hold:
//      H matches H, and plain h does not match Shift+H.
//   4. The clipboard second delivery: both captures put the saved file's PATH
//      on the clipboard through `plugin:clipboard-manager|write_text` (stood
//      in for by a shim handler — there is no OS clipboard to read back here).
//   5. The capture is the LIVE canvas, not a re-render: a raw WebGPU
//      fullscreen pass painting pure red is registered as a post-render
//      callback — the same slot the GI path tracer blits from — and the
//      readback must see it. A capture that re-renders the scene would come
//      back without any post-render overlay, which is the bug this replaces.
//
// The project is created with `settings.screenshot.folder` pointed inside the
// harness scratch root, because the shim refuses write commands anywhere else
// (the same guard every other smoke lives under).
//
//   npx vite --port 5279 --strictPort
//   node scripts/run-screenshot-hotkey-smoke.mjs [url]
//
// HEADED=1 to watch it run, VERBOSE=1 for step tracing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5279/";

// --- a throwaway project with the screenshot folder pre-configured ----------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-shot-"));
const shotsDir = path.join(root, "Shots");
fs.mkdirSync(shotsDir, { recursive: true });
fs.writeFileSync(
  path.join(root, "project.json"),
  JSON.stringify(
    {
      name: "ScreenshotSmoke",
      version: 1,
      settings: { screenshot: { folder: shotsDir, prefix: "shot" } },
    },
    null,
    2,
  ),
);

// The clipboard plugin has no Rust side in a harness, so the shim would
// reject `plugin:clipboard-manager|write_text` — stand in for it and record
// every call instead. That gates the second delivery without needing a real
// OS clipboard to read back (asserting "paste it and look" is the plugin's
// contract, not ours).
const clipboardCalls = [];

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, {
  writableRoot: root,
  verbose: !!process.env.VERBOSE,
  extraCommands: {
    "plugin:clipboard-manager|write_text": async (args) => {
      clipboardCalls.push(args?.text ?? "");
      return null;
    },
  },
});

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

await page.goto(url, { waitUntil: "load", timeout: 45000 });

// Warm the module chunk the hotkey dynamic-imports BEFORE any project state
// exists. On a cold dev server the first import of a new dependency makes
// vite's optimizeDeps discover it and RELOAD the page — which would silently
// swallow the first keypress's save. The import races the reload, so both
// outcomes land here; what matters is that discovery is over by the time the
// chord fires.
await page.evaluate(async () => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
  await Promise.allSettled([
    importLive("/src/editor/viewportScreenshot.js"),
    importLive("/src/editor/keybindings.js"),
  ]);
});
await wait(2500);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

await page.evaluate(async (projectRoot) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  globalThis.__engine = await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore
    .getState()
    .openProject(projectRoot)
    .then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));

for (let i = 0; i < 60 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);

// The capture renders its own frame through the renderer, so it needs the
// renderer actually ready — a boot that is still resolving its backend would
// fail the write for reasons the chord has nothing to do with.
let rendererReady = false;
for (let i = 0; i < 60; i++) {
  rendererReady = await page.evaluate(
    () => !!globalThis.__engine?.renderer?.domElement?.isConnected,
  );
  if (rendererReady) break;
  await wait(500);
}
check("renderer is up with a project open", rendererReady);
if (!rendererReady) {
  console.log(errors.slice(0, 10).join("\n"));
  await browser.close();
  process.exit(1);
}

// --- 1. chord logic, in the real module graph -------------------------------

const chordChecks = await page.evaluate(async () => {
  const { chordMatches } = await globalThis.__importLive("/src/editor/keybindings.js");
  const mac = { key: "Í", code: "KeyS", ctrlKey: false, shiftKey: true, altKey: true, metaKey: false, repeat: false };
  return {
    "default binding matches Shift+Alt+S": chordMatches(
      { key: "S", code: "KeyS", ctrlKey: false, shiftKey: true, altKey: true, metaKey: false, repeat: false },
      "Shift+Alt+S",
    ),
    "mac Option+Shift+S (key Í) matches": chordMatches(mac, "Shift+Alt+S"),
    "H binding unbroken": chordMatches(
      { key: "h", code: "KeyH", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false },
      "H",
    ),
    "plain h does not match Shift+H": !chordMatches(
      { key: "h", code: "KeyH", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false },
      "Shift+H",
    ),
  };
});
for (const [name, ok] of Object.entries(chordChecks)) check(name, ok);

const shotFiles = () =>
  fs.existsSync(shotsDir)
    ? fs.readdirSync(shotsDir).filter((f) => f.endsWith(".png"))
    : [];

// --- 2. the real keypress writes the file -----------------------------------

const before = shotFiles();
// puppeteer's combined "Shift+Alt+S" string is not a recognised key
// descriptor — hold the modifiers down explicitly, which is also closer to
// the real gesture.
await page.keyboard.down("Shift");
await page.keyboard.down("Alt");
await page.keyboard.press("KeyS");
await page.keyboard.up("Alt");
await page.keyboard.up("Shift");

let firstShot = null;
for (let i = 0; i < 40; i++) {
  const now = shotFiles();
  const added = now.find((f) => !before.includes(f));
  if (added) {
    firstShot = added;
    break;
  }
  await wait(250);
}
check("Shift+Alt+S writes a PNG", !!firstShot, firstShot ?? "no new file after 10s");
if (firstShot) {
  check(
    "file is named <prefix>-<timestamp>.png",
    /^shot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/.test(firstShot),
    firstShot,
  );
  const header = fs.readFileSync(path.join(shotsDir, firstShot)).subarray(0, 8);
  check("file carries PNG magic", header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47);
  const size = fs.statSync(path.join(shotsDir, firstShot)).size;
  check("capture is not an empty frame", size > 1000, `${size} bytes`);
}

// --- 3. the macOS composed-key event, through the real listener -------------

await wait(1200); // land in a later second so the timestamp cannot collide
await page.evaluate(() => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Í", // what macOS reports for Option+Shift+S on a US layout
      code: "KeyS",
      shiftKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
});

const afterFirst = shotFiles();
let macShot = null;
for (let i = 0; i < 40; i++) {
  const now = shotFiles();
  const added = now.find((f) => !afterFirst.includes(f));
  if (added) {
    macShot = added;
    break;
  }
  await wait(250);
}
check("macOS Option+Shift+S keydown writes a PNG", !!macShot, macShot ?? "no new file after 10s");

// --- 4. both captures also put the saved path on the clipboard --------------

check("every capture writes clipboard text", clipboardCalls.length === 2, `${clipboardCalls.length} calls`);
const expectedPath = firstShot ? path.join(shotsDir, firstShot) : null;
check(
  "clipboard holds the saved file's path",
  !!expectedPath && clipboardCalls[0] === expectedPath,
  expectedPath ? `got: ${clipboardCalls[0]}` : "no first shot to compare",
);

// --- 5. the capture is the LIVE canvas (post-render overlays included) ------

// Headless suites are never focused, and the fully-idle editor STOPS the loop
// — the hatch every GPU probe uses to keep frames flowing.
await page.evaluate(() => {
  globalThis.__editorKeepRendering = true;
});

const redGate = await page.evaluate(async () => {
  const { readLiveCanvasImage } = await globalThis.__importLive("/src/engine/renderTargetImage.js");
  const eng = globalThis.__engine;
  const backend = eng.renderer.backend;
  const device = backend.device;
  // A fullscreen triangle in pure red, drawn as a POST-render callback — the
  // same slot the GI path tracer blits from, and invisible to any capture
  // that re-renders the scene instead of reading the canvas.
  const shader = device.createShaderModule({
    code: `
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
        let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
        return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
      }
      @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }
    `,
  });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format: backend.utils.getPreferredCanvasFormat() }] },
  });
  const offRed = eng.onPostRender(() => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: backend.context.getCurrentTexture().createView(), loadOp: "load", storeOp: "store" },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  });
  // This hook registers AFTER the red blit's, so within a frame it reads the
  // canvas with the overlay already on it — the same ordering the screenshot
  // hotkey relies on.
  const image = await new Promise((resolve, reject) => {
    const offRead = eng.onPostRender(async () => {
      offRead();
      try {
        resolve(await readLiveCanvasImage(eng.renderer));
      } catch (err) {
        reject(err);
      }
    });
    setTimeout(() => {
      offRead();
      reject(new Error("no frame rendered for the red gate"));
    }, 5000);
  });
  offRed();
  let red = 0;
  const total = image.width * image.height;
  for (let i = 0; i < total; i++) {
    if (image.data[i * 4] > 200 && image.data[i * 4 + 1] < 60 && image.data[i * 4 + 2] < 60) red++;
  }
  return { red, total };
});
check(
  "capture includes post-render overlay (red blit)",
  redGate.red > redGate.total * 0.9,
  `${redGate.red}/${redGate.total} red px`,
);

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : "\nALL PASS");
if (errors.length) console.log(`\nconsole errors (${errors.length}):\n${errors.slice(0, 8).join("\n")}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
