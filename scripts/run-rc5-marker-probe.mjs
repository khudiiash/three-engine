// RC5 MARKER RECEIPT — minimal probe for the rc5-marker fix.
//
// Boots a scene, captures console output for `[gi2] first light` and the
// `[gi] transport never produced light` watchdog, then reads
// `profile.frameStats.giTransport`.
//
// Env: PROJECT, SCENE, URL (default http://127.0.0.1:5208/), WAIT_MS (default 20000)
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? process.env.URL ?? "http://127.0.0.1:5208/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const WAIT_MS = Number(process.env.WAIT_MS ?? 20000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
await page.evaluateOnNewDocument((flags) => {
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, JSON.parse(process.env.FLAGS ?? "{}"));

const lines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] transport never produced light|\[gi2\] rc: no `resolveHalf`/.test(t)) {
    lines.push(t);
    console.log(`    ${t}`);
  }
});
page.on("pageerror", (e) => console.log(`    pageerror: ${(e.stack ?? e.message ?? String(e)).slice(0, 300)}`));

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });

const call = async (op, args = {}) => {
  try {
    return await page.evaluate(async ({ op, args }) => {
      try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    }, { op, args });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
};

console.log(`\n== opening ${SCENE}.scene ==`);
const openRes = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
console.log(`  scene.open: ${JSON.stringify(openRes).slice(0, 200)}`);

console.log(`  waiting ${WAIT_MS} ms for first light / watchdog...`);
await wait(WAIT_MS);

const stats = await call("profile.frameStats", {});
const giTransport = stats?.value?.giTransport;
console.log(`\n  profile.frameStats.giTransport = ${JSON.stringify(giTransport)}`);
console.log(`  __gi2Rc5 = ${await page.evaluate(() => globalThis.__gi2Rc5)}`);
console.log(`  captured lines: ${lines.length}`);
for (const l of lines) console.log(`    - ${l}`);

await browser.close();
