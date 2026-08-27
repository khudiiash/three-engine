// GI2 STAGE 2.3 — drives scripts/gi2-voxelize.html and prints the two tables
// the plan's Stage 2.3 row asks for: CORRECTNESS (the trace's own three checks,
// run on a TRIANGLE-voxelized window instead of the analytic fill, plus the
// occupancy diff between them) and THROUGHPUT (frames to full occupancy per
// level, pairs/frame, ms/frame) at three tiers.
//
// A browser with a real adapter is required and is not a shortcut waiting to be
// removed: headless WebGPU has never worked in this repo, and a voxelization
// rate from a software adapter is a fiction every later budget would inherit.
//
// Run: node scripts/run-gi2-voxelize-probe.mjs [url]
//      TIER=high node scripts/run-gi2-voxelize-probe.mjs        (one tier)
//      RANDOM=0 …                                               (skip the 3 M scene)
//      RANDOM_TRIS=1000000 …                                    (smaller throughput scene)
import puppeteer from "puppeteer-core";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/scripts/gi2-voxelize.html").replace(/\/$/, "");
const tiers = (process.env.TIER ?? "phone,high,ultra").split(",").map((t) => t.trim()).filter(Boolean);
const wantRandom = process.env.RANDOM !== "0";
const randomTris = process.env.RANDOM_TRIS ?? null;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    // The 3 M-triangle soup is ~110 MB of f32 plus its cell listings; the
    // default renderer heap evicts it mid-build on some machines.
    "--js-flags=--max-old-space-size=4096",
  ],
});

let failed = 0;
const table = [];
for (const tier of tiers) {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));
  const q = new URLSearchParams({ tier });
  if (!wantRandom) q.set("random", "0");
  if (randomTris) q.set("randomTris", randomTris);
  const target = `${url}${url.includes("?") ? "&" : "?"}${q}`;
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction("globalThis.__GI2_VOX_RESULT__ !== undefined", { timeout: 900000 });
    const r = await page.evaluate("globalThis.__GI2_VOX_RESULT__");
    console.log(`\u2500\u2500 ${tier} ${"\u2500".repeat(Math.max(0, 62 - tier.length))}`);
    if (r?.text) console.log(r.text.split("\n").map((l) => `  ${l}`).join("\n"));
    if (r?.pass) {
      table.push({ tier, ...r });
    } else {
      failed++;
      console.error(`  FAIL ${tier}: ${r?.error ?? "no result"}`);
      const noise = logs.filter((l) => /error|Error|fail/i.test(l)).slice(-8);
      if (noise.length) console.error(noise.map((l) => `    ${l}`).join("\n"));
    }
  } catch (err) {
    failed++;
    console.error(`  FAIL ${tier}: ${err.message}`);
    console.error(logs.slice(-20).map((l) => `    ${l}`).join("\n"));
  }
  await page.close();
}
await browser.close();

if (table.length) {
  console.log("");
  console.log("CORRECTNESS \u2014 the trace's own three checks, on a TRIANGLE-voxelized window");
  console.log("tier     (a) dist   (b) leaks         (c) hand-off   pal illegal (ship/naive)   occ diff %");
  for (const t of table) {
    const leak = t.checks?.leak;
    const occ = (t.occDiff ?? []).map((r) => r.mismatchPct).join("/");
    console.log(
      `${t.tier.padEnd(9)}${(t.checks?.distance?.pass ? "PASS" : "FAIL").padEnd(11)}` +
      `${(leak ? `${leak.sealed}/${leak.rays} vs ${leak.controlPct}%` : "\u2014").padEnd(18)}` +
      `${(t.checks?.handoff?.hit ? `L${t.checks.handoff.level} t${t.checks.handoff.t.toFixed(2)}` : "FAIL").padEnd(15)}` +
      `${`${t.palette?.good?.corrupt ?? "?"} / ${t.palette?.naive?.corrupt ?? "?"}`.padEnd(26)}${occ}`,
    );
  }

  console.log("");
  console.log("THROUGHPUT \u2014 frames to 0 dirty bricks, pairs/frame, ms/frame");
  console.log("tier     scene    tris       frames  per-level frames   peak pairs   gpu ms   wall ms   overflow");
  for (const t of table) {
    const rows = [
      t.roomBuild && {
        scene: "room", tris: "\u2014", b: t.roomBuild, timing: t.roomTiming,
      },
      t.random && { scene: "random", tris: t.random.triangles, b: t.random, timing: t.random },
    ].filter(Boolean);
    for (const row of rows) {
      console.log(
        `${t.tier.padEnd(9)}${row.scene.padEnd(9)}${String(row.tris).padStart(9)}   ` +
        `${String(row.b.frames).padStart(6)}  ${(row.b.levelFrames ?? []).join("/").padStart(16)}   ` +
        `${String(row.b.peakPairs).padStart(10)}   ` +
        `${(row.timing?.gpuMsPerFrame == null ? "n/a" : row.timing.gpuMsPerFrame.toFixed(3)).padStart(6)}   ` +
        `${(row.timing?.wallMsPerFrame == null ? "n/a" : row.timing.wallMsPerFrame.toFixed(3)).padStart(7)}   ` +
        `${String(row.b.overflowed ?? 0).padStart(8)}`,
      );
    }
  }

  console.log("");
  const worst = table.reduce((n, t) => Math.max(n, Math.max(...t.kernels.map((k) => k.storageBindings))), 0);
  const wgVars = table.reduce((n, t) => n + t.kernels.reduce((m, k) => m + k.workgroupVars, 0), 0);
  console.log(`storage buffers, worst kernel: ${worst} (envelope 6); workgroup vars: ${wgVars}; ` +
    `voxelizer WGSL scene-free: ${table.every((t) => t.wgsl.every((c) => !c.foreign.length && !c.grepped.length))}`);
  for (const t of table) {
    const o = t.overflow;
    if (o) {
      console.log(`${t.tier}: overflow arm cap ${o.cap}/${o.fullCap} \u2192 ${o.framesLow} frames ` +
        `(vs ${o.framesFull}), ${o.overflowed} brick-overflows, ${o.occDiff} voxel bits differ`);
    }
  }
}

process.exit(failed ? 1 : 0);
