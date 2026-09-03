// GPU gate for the newly-visible irradiance fallback. The synthetic target
// makes UNKNOWN-vs-dark explicit and tests the silhouette guard independently
// of probe convergence or scene timing.
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201").replace(/\/$/, "");
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));
let code = 1;
try {
  await page.goto(`${base}/scripts/gi-irr-fallback.html`, {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForFunction("globalThis.__GI_IRR_FALLBACK_RESULT__ !== undefined", {
    timeout: 120000,
  });
  const result = await page.evaluate("globalThis.__GI_IRR_FALLBACK_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log("gi-irr-fallback: PASS");
    code = 0;
  } else {
    console.error(`gi-irr-fallback: FAIL — ${result?.error ?? "assertion"}`);
    if (!result?.text) console.error(logs.slice(-20).join("\n"));
  }
} catch (error) {
  console.error(`gi-irr-fallback: FAIL — ${error.message}`);
  console.error(logs.slice(-20).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
