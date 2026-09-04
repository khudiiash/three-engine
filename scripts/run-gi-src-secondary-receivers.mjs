import puppeteer from "puppeteer-core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new", userDataDir: await mkdtemp(join(tmpdir(), "gi-secondary-receivers-")),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox"],
});
try {
  const page = await browser.newPage();
  page.on("console", (message) => console.log(message.text()));
  page.on("pageerror", (error) => console.error(error.stack || error.message));
  const base = (process.argv[2] || "http://127.0.0.1:5283").replace(/\/$/, "");
  await page.goto(`${base}/scripts/gi-src-secondary-receivers.html`);
  await page.waitForFunction(() => globalThis.__GI_SECONDARY_RECEIVERS_RESULT__ !== undefined, { timeout: 90000 });
  const result = await page.evaluate(() => globalThis.__GI_SECONDARY_RECEIVERS_RESULT__);
  console.log(JSON.stringify(result)); process.exitCode = result.pass ? 0 : 1;
} finally { await browser.close(); }
