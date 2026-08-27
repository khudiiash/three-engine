// GI2 STAGE 2.4 — drives scripts/gi2-trace.html and prints the rays/s table.
//
// This is the FIRST Stage 2 receipt (audits §K.8): "probe:gi2-trace rays/s at
// 3 tiers (K.4 alone, synthetic scene) — every ray budget bends to it". It also
// carries Stage 2.4's other gate, "< 6 storage buffers", and the 5 cm wall's
// leak pair from Stage 2.3's row, measured against the analytic fill instead of
// the triangle voxelizer that does not exist yet.
//
// A browser with a real adapter is required and is not a shortcut waiting to be
// removed: headless WebGPU has never worked in this repo, and a compute
// throughput number from a software adapter would be a fiction the ray budgets
// then inherit.
//
// Run: node scripts/run-gi2-trace-probe.mjs [url]
//      TIER=high node scripts/run-gi2-trace-probe.mjs      (one tier)
//      TIER=phone,high,ultra …                             (the default table)
import puppeteer from "puppeteer-core";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/scripts/gi2-trace.html").replace(/\/$/, "");
const tiers = (process.env.TIER ?? "phone,high,ultra").split(",").map((t) => t.trim()).filter(Boolean);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});

let failed = 0;
const table = [];
for (const tier of tiers) {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));
  const target = `${url}${url.includes("?") ? "&" : "?"}tier=${encodeURIComponent(tier)}`;
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("globalThis.__GI2_TRACE_RESULT__ !== undefined", { timeout: 300000 });
    const r = await page.evaluate("globalThis.__GI2_TRACE_RESULT__");
    console.log(`── ${tier} ${"─".repeat(Math.max(0, 60 - tier.length))}`);
    if (r?.text) console.log(r.text.split("\n").map((l) => `  ${l}`).join("\n"));
    if (r?.pass) {
      table.push({ tier, ...r.throughput, leak: r.checks?.leak, trace: r.trace, kernels: r.kernels });
    } else {
      failed++;
      console.error(`  FAIL ${tier}: ${r?.error ?? "no result"}`);
      // The page's own log already carries the failing check; only console
      // noise the page could not print is worth adding.
      const noise = logs.filter((l) => /error|Error|fail/i.test(l)).slice(-6);
      if (noise.length) console.error(noise.map((l) => `    ${l}`).join("\n"));
    }
  } catch (err) {
    failed++;
    console.error(`  FAIL ${tier}: ${err.message}`);
    console.error(logs.slice(-15).map((l) => `    ${l}`).join("\n"));
  }
  await page.close();
}
await browser.close();

if (table.length) {
  console.log("");
  console.log("RAYS/S — the number every Stage 3 ray budget is priced against");
  console.log("tier     rays/frame   gpu ms   rays/s (gpu)   rays/s (wall)   hit%   steps/ray   leak control");
  for (const t of table) {
    console.log(
      `${t.tier.padEnd(9)}${String(t.rays).padStart(10)}   ` +
      `${t.gpuMsPerFrame == null ? "    n/a" : t.gpuMsPerFrame.toFixed(3).padStart(7)}   ` +
      `${t.raysPerSecGpu == null ? "         n/a" : ((t.raysPerSecGpu / 1e6).toFixed(2) + " M/s").padStart(12)}   ` +
      `${((t.raysPerSecWall / 1e6).toFixed(2) + " M/s").padStart(13)}   ` +
      `${(100 * t.hitRate).toFixed(1).padStart(5)}   ` +
      `${String(t.meanSteps).padStart(9)}   ` +
      `${t.leak ? `${t.leak.sealed}/${t.leak.rays} vs ${t.leak.controlPct}%` : "—"}`,
    );
  }
  const worst = table.reduce((n, t) => Math.max(n, Math.max(...t.kernels.map((k) => k.storageBindings))), 0);
  console.log(`storage buffers, worst kernel: ${worst} (envelope 6); trace kernel ${(table[0].trace.bytes / 1024).toFixed(1)} kB, scene-free`);
}

process.exit(failed ? 1 : 0);
