// Bisect helper: screenshot the live player build from a fixed camera.
//   node scripts/_tmp-shot.mjs <label>
import puppeteer from "puppeteer-core";

const label = process.argv[2] ?? "shot";
const url = "http://localhost:50845/";
const out = "C:/Users/KHUDII~1/AppData/Local/Temp/claude/c--Users-Khudiiash-Documents-JS-engine/9f9a2651-5132-4c87-b6fb-e5ecd4574dec/scratchpad";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 640 });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon")) errs.push(m.text()); });

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await new Promise((r) => setTimeout(r, 28000));

await page.evaluate(() => {
  const e = globalThis.__engine;
  if (!e?.camera) return;
  e.camera.position.set(12, 8, 14);
  e.camera.lookAt(0, 1, 0);
  e.camera.updateMatrixWorld(true);
});
await new Promise((r) => setTimeout(r, 8000));

// Mean luminance: a blown-out frame reads near 1, the good frame ~0.2.
const stats = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (!c) return null;
  return { w: c.width, h: c.height };
});
await page.screenshot({ path: `${out}/bisect-${label}.png` });
console.log(label, "canvas:", JSON.stringify(stats), "errors:", errs.length ? errs.slice(0, 3) : "none");
await browser.close();
