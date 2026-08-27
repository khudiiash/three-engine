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
  console.log("THE PER-LEVEL CULL (2.5 §1) — frames to 0 dirty PER LEVEL, cull off vs on, one session");
  console.log("tier     scene    cull  frames   per-level frames   last   pairs total     dust     gpu ms");
  for (const t of table) {
    const rows = [
      t.cullRoom && ["room", t.cullRoom.off, t.cullRoom.on, null],
      t.cullRandom && ["random", t.cullRandom.off, t.cullRandom.on, t.cullRandom],
    ].filter(Boolean);
    for (const [scene, off, on, meta] of rows) {
      for (const [tag, r] of [["off", off], ["on ", on]]) {
        const lf = (r.levelFrames ?? []).join("/");
        const last = r.levelFrames ? `L${r.levelFrames.indexOf(Math.max(...r.levelFrames))}` : "—";
        console.log(
          `${t.tier.padEnd(9)}${scene.padEnd(9)}${tag}  ${String(r.frames).padStart(6)}   ${lf.padStart(16)}   ` +
          `${last.padStart(4)}   ${String(r.totalPairs ?? r.peak ?? "—").padStart(11)}   ` +
          `${String(r.dustVoxels ?? r.dust ?? 0).padStart(6)}   ` +
          `${(r.gpuMsPerFrame == null ? "n/a" : r.gpuMsPerFrame.toFixed(3)).padStart(8)}`,
        );
      }
      if (meta) {
        console.log(`${" ".repeat(9)}└─ coarsest is L${meta.coarsest}; last level to finish ` +
          `L${meta.lastLevelOff} → L${meta.lastLevelOn}; L${meta.coarsest} reached 0 dirty at frame ` +
          `${meta.off.levelFrames[meta.coarsest]} → ${meta.on.levelFrames[meta.coarsest]}`);
      }
    }
  }

  console.log("");
  console.log("THE RESUMABLE BRICK (2.5 §2) — a cap BELOW one brick's whole demand");
  console.log("tier     cap     biggest brick   frames (vs full)   resumptions   deepest cursor   occ diff   pal diff");
  for (const t of table) {
    const c = t.cursor;
    if (!c) continue;
    console.log(
      `${t.tier.padEnd(9)}${String(c.cap).padEnd(8)}${String(c.biggestBrick).padStart(13)}   ` +
      `${`${c.frames} (${c.framesFull})`.padStart(16)}   ${String(c.resumed).padStart(11)}   ` +
      `${String(c.maxCursor).padStart(14)}   ${String(c.occDiff).padStart(8)}   ${String(c.palDiff).padStart(8)}`,
    );
  }

  console.log("");
  console.log("THE DYNAMIC LAYER (2.5 §4) — a 1 m box crossing 3 m in 60 frames");
  console.log("tier     hits    wrong t   ghosts (lag)    sweep   static bits   gpu ms/frame   voxels/frame");
  for (const t of table) {
    const m = t.movers;
    if (!m) continue;
    console.log(
      `${t.tier.padEnd(9)}${`${m.frames - m.misses}/${m.frames}`.padEnd(8)}${String(m.wrongT).padStart(7)}   ` +
      `${`${m.staleHits}/${m.staleTested} (${m.lag})`.padStart(12)}   ${`${m.ghosts}/${m.frames}`.padStart(6)}   ` +
      `${(m.staticUnchanged ? "unchanged" : "CHANGED").padStart(11)}   ` +
      `${(m.gpuMsPerFrame == null ? "n/a" : m.gpuMsPerFrame.toFixed(4)).padStart(12)}   ` +
      `${String(m.dyn?.voxelsSet ?? "—").padStart(12)}`,
    );
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
