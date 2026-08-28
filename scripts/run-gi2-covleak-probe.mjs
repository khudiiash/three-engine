// §19 4.13 — drives scripts/gi2-covleak.html: the rotated Cornell's 5 cm wall,
// swept over many window placements at every tier.
//
// The gather rig takes ONE leak reading per world per battery, which is why the
// three-rays-of-ten-thousand event §AI.7 flagged reads as intermittent. This
// runs the same rays against the same fill over `PLACEMENTS` lattice phases, so
// the event either reproduces with a rate or does not exist.
//
// Run: node scripts/run-gi2-covleak-probe.mjs [url]
//      TIER=phone PLACEMENTS=24 node scripts/run-gi2-covleak-probe.mjs
import puppeteer from "puppeteer-core";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/scripts/gi2-covleak.html").replace(/\/$/, "");
const tiers = (process.env.TIER ?? "phone,high,ultra").split(",").map((t) => t.trim()).filter(Boolean);
const placements = process.env.PLACEMENTS ?? "12";
const worlds = process.env.WORLDS ?? "";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});

let failed = 0;
for (const tier of tiers) {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));
  const q = new URLSearchParams({ tier, placements });
  if (worlds) q.set("worlds", worlds);
  try {
    await page.goto(`${url}?${q}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("globalThis.__GI2_COVLEAK_RESULT__ !== undefined", { timeout: 1800000 });
    const r = await page.evaluate("globalThis.__GI2_COVLEAK_RESULT__");
    console.log(`── ${tier} ${"─".repeat(Math.max(0, 62 - tier.length))}`);
    if (r?.text) console.log(r.text.split("\n").map((l) => `  ${l}`).join("\n"));
    if (!r?.pass) {
      failed++;
      console.error(`  FAIL ${tier}: ${r?.error ?? `${r?.totalLeaks} leaks`}`);
      const noise = logs.filter((l) => /error|Error|fail/i.test(l)).slice(-6);
      if (noise.length) console.error(noise.map((l) => `    ${l}`).join("\n"));
    }
  } catch (e) {
    failed++;
    console.error(`  FAIL ${tier}: ${e.message}`);
    console.error(logs.slice(-10).map((l) => `    ${l}`).join("\n"));
  }
  await page.close();
}

await browser.close();
console.log(failed ? `\nFAIL — ${failed} tier(s) leaked` : "\nPASS — no tier leaked at any placement");
process.exit(failed ? 1 : 0);
