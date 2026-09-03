// Render the retargeted kimodo clips on the Y Bot and save frames as PNGs —
// the visual half of `npm run test:kimodo`'s numeric checks. Numeric checks
// prove the transfer is exact; only eyes (the user's or the agent's, reading
// the PNGs back) prove the result LOOKS like walking instead of a rig
// shredded by a subtle quaternion-order bug that happens to preserve
// directions.
//
//   npx vite --port 5219 &
//   node scripts/run-kimodo-preview.mjs [url]
//
// Frames land in artifacts/kimodo/preview-*.png.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5219/scripts/kimodo-preview.html";
const artifacts = path.join(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/kimodo");
// Optional args: <glbFile basename> <clip name> — defaults to the first walk.
const GLB = `/artifacts/kimodo/${process.argv[3] ?? "Walking.glb"}`;
const CLIP = process.argv[4] ?? "Walking";
const TAG = process.argv[5] ?? CLIP.toLowerCase();
// One stride ~0.63s in the source motion; four samples across it show both
// legs passing, contact, and the arm counter-swing.
const TIMES = [0, 0.16, 0.32, 0.48, 0.63];

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 1000, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error(`pageerror: ${e.stack ?? e.message}`));
page.on("console", (m) => m.type() === "error" && console.error(`console: ${m.text()}`));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
for (let i = 0; i < 60 && !(await page.evaluate(() => !!globalThis.__kimodoPreview)); i++) {
  await new Promise((r) => setTimeout(r, 250));
}
if (!(await page.evaluate(() => !!globalThis.__kimodoPreview))) throw new Error("preview harness never loaded");
const info = await page.evaluate(async (glbUrl) => globalThis.__kimodoPreview.boot(glbUrl), GLB);
console.log(`clips: ${info.clips.join(", ")}`);
if (!info.clips.includes(CLIP)) throw new Error(`no ${CLIP} clip in ${GLB}`);

fs.mkdirSync(artifacts, { recursive: true });
for (const t of TIMES) {
  await page.evaluate((clip, time) => globalThis.__kimodoPreview.show(clip, time), CLIP, t);
  const file = path.join(artifacts, `preview-${TAG}-${t.toFixed(2)}.png`);
  await page.screenshot({ path: file });
  console.log(`wrote ${file}`);
}

// The same instants on the RAW SOMA skeleton — the ground truth the Y Bot
// frames are judged against (arms out on both sides = faithful transfer of a
// stiff-armed generation; arms out only on the Y Bot = a transfer bug). Only
// for the default walk, whose raw streams sit beside the GLB.
if (TAG === "walking") {
  await page.reload({ waitUntil: "load" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!globalThis.__kimodoPreview)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const soma = await page.evaluate((dir) => globalThis.__kimodoPreview.bootSoma(dir), "/artifacts/kimodo/walk-raw");
  console.log(`soma frames: ${soma.frames}`);
  for (const t of TIMES) {
    await page.evaluate((time) => globalThis.__kimodoPreview.showSoma(Math.round(time * 30)), t);
    const file = path.join(artifacts, `preview-soma-${t.toFixed(2)}.png`);
    await page.screenshot({ path: file });
    console.log(`wrote ${file}`);
  }
}
await browser.close();
