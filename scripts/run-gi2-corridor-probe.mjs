// GI2 §19 STAGE 3.15 — THE FAR-FIELD REFERENCE, WITH TRUTH IN IT.
//
// 3.14's flip verdict failed on a gate that had no reference: "far façades read
// 1.61× THE SCREEN PATH, against ±15 %". The verdict's own closing note says
// what was wrong with it — "1.6× the screen path is not the same claim as 1.6×
// the truth", and the screen path is the arm that reads a dark recess at 10.4 %
// of its wall. So this replaces it: the SAME analytic room the Cornell rig
// arbitrates, stretched to 60 m along Z, measured against the SAME CPU path
// tracer, at 5 / 15 / 30 / 50 m from the camera.
//
// ⭐ THE GATE IS THE FLAT ROOM'S OWN BRACKET, NOT A NEW NUMBER. Cornell parity
// asks whether the GPU's irradiance sits between the 1-bounce reference and
// 1.15× the 4-bounce reference; a crop that does is "bracketed". This asks the
// identical question at four distances, so "the corridor is in the same bracket
// as the flat room" is a comparison of two bracket counts and not of two
// quantities with different units. The per-crop ratios are printed either way,
// because a bracket count summarises away the direction of a miss.
//
// Arms (all out of ONE binary, one shader cache, one page — the discipline
// every §19 receipt since 3.13 has followed):
//   ARMS=3.15        world probes, cascades, INTERVAL merge   (default)
//   ARMS=3.14        world probes, cascades, no intervals     (`?intervals=0`)
//   ARMS=3.13        one lattice with the boundary clamp      (`?casc=1`)
//   ARMS=3.12        the screen path                          (`?world=0`)
//   ARMS=3.15-bias   3.15 with the surface bias scaled by the SAMPLED cascade
//                    (`?perCasc=1`) — the BIAS-INDEPENDENCE TELL
//
// Run: node scripts/run-gi2-corridor-probe.mjs [url]
//      ARMS=3.15,3.14 TIER=ultra node scripts/run-gi2-corridor-probe.mjs
import puppeteer from "puppeteer-core";
import { lum, makeReference } from "./lib/gi2Reference.mjs";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/scripts/gi2-corridor.html").replace(/\/$/, "");
const tiers = (process.env.TIER ?? "ultra").split(",").map((t) => t.trim()).filter(Boolean);
const arms = (process.env.ARMS ?? "3.16,3.15").split(",").map((t) => t.trim()).filter(Boolean);
const SPP = Number(process.env.SPP ?? 150000);
const FRAMES = process.env.FRAMES ?? "";

/** Each arm's query, and nothing else about it. */
const ARM_QUERY = {
  // §19 3.16 — the default arm is all three fixes ON; "3.15" is the SAME
  // BINARY with `fix316=0`, which is what makes the two columns comparable.
  "3.16": "",
  "3.16+reach": "reach=1",
  "3.16-place": "reach=0&split=0",
  "3.16-reach": "place=0&split=0&reach=1",   // reach ships OFF — refuted, see worldProbes
  "3.16-split": "place=0&reach=0",
  "3.15": "fix316=0",
  "3.14": "intervals=0&fix316=0",
  "3.13": "casc=1&intervals=0&fix316=0",
  "3.12": "world=0",
  "3.15-bias": "fix316=0&perCasc=1",
  "3.16-bias": "perCasc=1",
  "3.15-prop": "covFull=1",
  "3.15-r8": "r0=8",
  "3.15-r2": "r0=2",
  "3.15-r12": "r0=12",
  "3.15-r16": "r0=16",
  "3.15-gate1": "covFull=0.25",
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});

let failed = 0;
const table = [];

for (const tier of tiers) {
  for (const arm of arms) {
    const q = ARM_QUERY[arm];
    if (q === undefined) { console.error(`unknown arm "${arm}"`); failed++; continue; }
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => logs.push(m.text()));
    page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));
    const parts = [`tier=${encodeURIComponent(tier)}`, q, FRAMES ? `frames=${FRAMES}` : ""].filter(Boolean);
    const target = `${url}?${parts.join("&")}`;
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForFunction("globalThis.__GI2_CORRIDOR_RESULT__ !== undefined", { timeout: 1800000 });
      const r = await page.evaluate("globalThis.__GI2_CORRIDOR_RESULT__");
      console.log(`── ${tier} / ${arm} ${"─".repeat(Math.max(0, 52 - tier.length - arm.length))}`);
      if (r?.text) console.log(r.text.split("\n").map((l) => `  ${l}`).join("\n"));
      if (!r?.pass) {
        failed++;
        console.error(`  FAIL ${tier}/${arm}: ${r?.error ?? "no result"}`);
        console.error(logs.filter((l) => /error|Error|fail/i.test(l)).slice(-8).map((l) => `    ${l}`).join("\n"));
        await page.close();
        continue;
      }

      // ── the reference, at three depths ─────────────────────────────────────
      //
      // ⭐ THREE DEPTHS, FOR THE REASON THE CORNELL PARITY GIVES. The GPU cache
      // holds a ONE-bounce answer for a face nothing has injected into yet, and
      // multibounce arrives only through the cache's own convergence. A gather
      // that matches b1 and misses b4 is a cache that has not finished feeding
      // itself; a gather that misses b1 is a broken estimator. One ratio cannot
      // tell those apart, and in a 60 m corridor — where a far crop's light has
      // bounced two or three times to get there — the difference between b1 and
      // b4 is the whole far field.
      const refs = {
        1: makeReference(r.scene, r.palette, r.light, 1),
        2: makeReference(r.scene, r.palette, r.light, 2),
        4: makeReference(r.scene, r.palette, r.light, 4),
      };
      const rows = [];
      r.crops.forEach((c, i) => {
        // ⚠ THE REFERENCE IS EVALUATED AT THE GBUFFER'S OWN POINT AND NORMAL,
        // not at the world point the page asked for. A crop is a pixel and a
        // pixel lands where the rasterizer put it; at 50 m down a corridor the
        // two differ by centimetres, and a reference computed at the wrong one
        // is a reference for a different place on the same wall.
        const p = c.pos;
        const n = c.nrm;
        const bad = !(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) > 0.5) || c.samples < 0.5;
        const E1 = bad ? [0, 0, 0] : refs[1].irradiance(p, n, SPP, 0x9e37 + i);
        const E2 = bad ? [0, 0, 0] : refs[2].irradiance(p, n, SPP, 0x9e37 + i);
        const E4 = bad ? [0, 0, 0] : refs[4].irradiance(p, n, SPP, 0x9e37 + i);
        rows.push({
          name: c.name, d: c.d, kind: c.kind, skipped: bad,
          gpu: lum(c.irr), b1: lum(E1), b2: lum(E2), b4: lum(E4),
          ratio: lum(c.irr) / Math.max(1e-9, lum(E4)),
          ratio1: lum(c.irr) / Math.max(1e-9, lum(E1)),
        });
      });
      const scored = rows.filter((x) => !x.skipped);
      // The Cornell parity's bracket, verbatim: at least the 1-bounce answer,
      // at most 1.15 × the 4-bounce one.
      const inBracket = (x) => x.ratio <= 1.15 && x.ratio1 >= 0.85;
      const bracketed = scored.filter(inBracket).length;
      const walls = scored.filter((x) => x.kind === "wall");
      const wallBr = walls.filter(inBracket).length;

      console.log(`  CORRIDOR PARITY (GPU irradiance ÷ CPU path tracer, ${SPP} spp)`);
      console.log("    crop           gpu       b1       b2       b4    ÷b4    ÷b1  bracket");
      for (const x of rows) {
        console.log(`    ${x.name.padEnd(12)}` +
          (x.skipped ? "  (no gbuffer sample — crop off surface)" :
            `${x.gpu.toFixed(4).padStart(8)}${x.b1.toFixed(4).padStart(9)}` +
            `${x.b2.toFixed(4).padStart(9)}${x.b4.toFixed(4).padStart(9)}` +
            `${x.ratio.toFixed(3).padStart(7)}${x.ratio1.toFixed(3).padStart(7)}` +
            `   ${inBracket(x) ? "yes" : "NO "}`));
      }
      console.log(`  bracketed ${bracketed}/${scored.length} (walls ${wallBr}/${walls.length})`);
      const byD = {};
      for (const x of scored) (byD[x.d] ??= []).push(x.ratio);
      console.log(`  ÷b4 by distance: ${Object.entries(byD)
        .map(([d, v]) => `${d}m ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)}`).join("  ")}`);

      table.push({
        tier, arm, bracketed, scored: scored.length, wallBr, walls: walls.length, rows,
        live: r.live, world: r.describe?.world ?? null,
      });
      await page.close();
    } catch (e) {
      failed++;
      console.error(`  FAIL ${tier}/${arm}: ${e.message}`);
      console.error(logs.slice(-10).map((l) => `    ${l}`).join("\n"));
      try { await page.close(); } catch { /* already gone */ }
    }
  }
}

console.log("\n══ CORRIDOR SUMMARY ══════════════════════════════════════════════");
console.log("  tier   arm         bracketed   walls    ÷b4 @5m   @15m   @30m   @50m");
for (const t of table) {
  const at = (d) => {
    const v = t.rows.filter((x) => !x.skipped && x.d === d && x.kind === "wall").map((x) => x.ratio);
    return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(3).padStart(7) : "      —";
  };
  console.log(`  ${t.tier.padEnd(6)} ${t.arm.padEnd(11)} ${`${t.bracketed}/${t.scored}`.padStart(7)}` +
    ` ${`${t.wallBr}/${t.walls}`.padStart(7)} ${at(5)}${at(15)}${at(30)}${at(50)}`);
}

await browser.close();
process.exit(failed ? 1 : 0);
