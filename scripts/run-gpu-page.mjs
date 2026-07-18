// Drives a GPU test page in Chrome and streams its console output.
// Usage: node scripts/run-gpu-page.mjs <url> [timeoutMs]
import puppeteer from "puppeteer-core";

const url = process.argv[2];
const timeoutMs = Number(process.argv[3]) || 90000;
if (!url) {
  console.error("usage: node scripts/run-gpu-page.mjs <url> [timeoutMs]");
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  // HEADED=1 gives unthrottled rAF + real GPU scheduling — required for
  // any timing measurements; headless "new" throttles occluded pages.
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPU",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage();
page.on("console", (message) => console.log(message.text()));
page.on("pageerror", (error) => console.log(`PAGEERROR ${error.message}`));
await page.goto(url, { waitUntil: "load", timeout: 30000 });
let lastShot = "";
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const state = await page.evaluate(() => ({
    done: document.documentElement.dataset.done === "true",
    shot: document.documentElement.dataset.shot || "",
  }));
  if (state.shot && state.shot !== lastShot) {
    lastShot = state.shot;
    await page.screenshot({ path: `scripts/gi-diag-${state.shot}.png` });
    console.log(`SHOT scripts/gi-diag-${state.shot}.png`);
  }
  if (state.done) break;
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (Date.now() >= deadline) console.log("RUNNER-TIMEOUT");
await browser.close();
process.exit(0);
