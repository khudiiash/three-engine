// §19 Stage 5.1 — drives scripts/gi2-rc.html: the ported radiance cascades'
// gate (interval census, anchor census, leak, cost, one probe's directions).
//
// Run: node scripts/run-gi2-rc-probe.mjs [url]
//      TIER=ultra,phone FRAMES=8 node scripts/run-gi2-rc-probe.mjs
import puppeteer from "puppeteer-core";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/scripts/gi2-rc.html").replace(/\/$/, "");
const tiers = (process.env.TIER ?? "ultra,high,phone").split(",").map((t) => t.trim()).filter(Boolean);
const frames = process.env.FRAMES ?? "8";
const w = process.env.W ?? "1280";
const h = process.env.H ?? "720";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});

let failed = 0;
const results = {};
for (const tier of tiers) {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));
  try {
    await page.goto(`${url}?${new URLSearchParams({ tier, frames, w, h })}`,
      { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("globalThis.__GI2_RC_RESULT__ !== undefined", { timeout: 1800000 });
    const r = await page.evaluate("globalThis.__GI2_RC_RESULT__");
    results[tier] = r;
    console.log(`── ${tier} ${"─".repeat(Math.max(0, 62 - tier.length))}`);
    if (r?.text) console.log(r.text.split("\n").map((l) => `  ${l}`).join("\n"));
    if (!r?.pass) {
      failed++;
      console.error(`  FAIL ${tier}: ${r?.error ?? JSON.stringify(r?.gate)}`);
      const noise = logs.filter((l) => /error|Error|fail/i.test(l)).slice(-8);
      if (noise.length) console.error(noise.map((l) => `    ${l}`).join("\n"));
    }
  } catch (e) {
    failed++;
    console.error(`  FAIL ${tier}: ${e.message}`);
    console.error(logs.slice(-12).map((l) => `    ${l}`).join("\n"));
  }
  await page.close();
}

await browser.close();
console.log(failed ? `\nFAIL — ${failed} tier(s)` : "\nPASS — every tier met the 5.1 gate");
process.exit(failed ? 1 : 0);
