// Drives scripts/gi-gpu-smoke.html arms and reports pass/fail.
// Usage: node drive-gi-gpu-smoke.mjs "<query1>" "<query2>" ...
import puppeteer from "puppeteer-core";

// `GI_SMOKE_PAGE` overrides the page — which exists so a suspected regression
// can be A/B'd against a checked-out copy of the same harness at another
// commit, on the same adapter, in the same session. Cross-session comparisons
// of this smoke are not meaningful (compile waves swing several-fold).
const base = process.env.GI_SMOKE_PAGE ?? "http://localhost:5201/scripts/gi-gpu-smoke.html";
const arms = process.argv.slice(2);
if (!arms.length) arms.push("?dynobj=2", "?mode=hybrid-exact-complex&dynobj=2");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
let failed = 0;
for (const arm of arms) {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.message}`));
  try {
    await page.goto(base + arm, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction("globalThis.__GI_SMOKE_RESULT__ !== undefined", { timeout: 120000 });
    const result = await page.evaluate("globalThis.__GI_SMOKE_RESULT__");
    if (result?.pass) {
      console.log(`PASS ${arm} — storage ${result.storageLimit}`);
      // Near-limit kernels (the page logs any at ≥6 storage buffers, named) —
      // the planning constraint for adding a binding to an existing kernel.
      // CENSUS and NOTE join STORAGE: the census says HOW MANY kernels the
      // binding audit actually saw, which is the difference between "no kernel
      // is over 8 storage buffers" and "no kernel was looked at" — the exact
      // blindness §19 Stage 3.4 hit when GI2 emptied every list this page knew
      // about. NOTE reports an arm that does not apply to the built transport.
      for (const l of logs) {
        if (/^GI-SMOKE (STORAGE|CENSUS|NOTE)/.test(l)) console.log(`  ${l}`);
      }
      // The `?src=1` arm's whole output is these numbers; a bare PASS would
      // hide the probe counts and the hash load the arm exists to report.
      if (result.srcProbes) {
        console.log(`  src probes: ${result.srcProbes.dispatches} dispatches, ` +
          `${result.srcProbes.megabytes}MB, gizmoPixels ${result.srcProbes.gizmoPixels}, ` +
          result.srcProbes.cascades
            .map((c, i) => `c${i} ${c.live} live/load ${c.load}/steps ${c.steps}` +
              (c.failed ? ` FAILED ${c.failed}` : ""))
            .join("  "));
        // The scaffold ray pass's numbers are the input to the `Lmax` decision
        // §12.13.4 left open, so they get printed rather than merely asserted.
        const r = result.srcProbes.rays;
        if (r) {
          console.log(`  src rays: ${r.count} traced = ${r.budget} budgeted ` +
            `(${r.perPixel}/px), hit ${(r.hitRate * 100).toFixed(1)}%, ` +
            `mean t ${r.meanT}m, max t ${r.maxT}m`);
          console.log(`  src deposits: ${r.deposits} (${r.perRay}/ray) into ` +
            `${(r.bins / 1e6).toFixed(2)}M bins, ${r.clamped} clamped`);
        }
        // The merge's own line. `to sky` is the range instrument — the share of
        // merged bins whose parent chain reached the top cascade, i.e. how much
        // of the frame gets the full-reach answer rather than a c0-only one.
        const mg = result.srcProbes.merge;
        if (mg) {
          console.log(`  src merge: ${mg.merged}/${mg.bins} known bins merged ` +
            `(${mg.corners}/8 corners, ${mg.orphanRate}% orphan, ` +
            `${mg.resolvedRate}% to sky), ${mg.sky} top-cascade bins skied`);
        }
        // [H]. Nothing reads the atlas until [I], so `coverage` is the number
        // that says the bake is connected: it is bounded above by the share of
        // blocks a live probe holds, and `knownBins` separates "few probes"
        // from "probes with no merged data".
        const tl = result.srcProbes.tiles;
        if (tl) {
          console.log(`  src tiles: ${tl.lit}/${tl.owned} texels lit in claimed tiles ` +
            `(${tl.claimed}%; ${tl.coverage}% of the ${tl.tiles}-tile pool), ` +
            `${tl.knownBins}/${tl.totalBins} known bins per texel, E ${tl.minLum}..${tl.maxLum}`);
        }
        // [I]. `corners` is the number that says the picture is INTERPOLATED:
        // at 1.0 this is the old one-probe-per-pixel resolve and the ~0.6m
        // probe-cell blocks are still there.
        const g = result.srcProbes.gather;
        if (g) {
          console.log(`  src gather: sky ${g.sky}, ${g.lit}/${g.pixels} pixels lit ` +
            `(${g.empty} no-probe), ${g.corners}/8 probes per pixel, ` +
            `lum ${g.minLum}..${g.maxLum} mean ${g.meanLum}, contrast ${g.contrast}`);
        }
      }
      // ── THE GI2 TRANSPORT TALLY (§19 Stage 3.4) ──────────────────────────
      //
      // `result.srcProbes` and `result.gi2` are mutually exclusive by
      // construction — the page reports whichever transport it actually BUILT,
      // detected by presence (`screen.srcProbes` vs `screen.gi2`) rather than
      // from a build flag it cannot read. So this is the GI2 spelling of the
      // block above, and it exists for the same reason: on a GI2 build a bare
      // PASS would hide every number the arm produced, which is how a
      // transport that budgets rays and lands none reads as green.
      //
      // ⚠ EVERY COUNTER HERE IS PER-FRAME (the gather's atomics are cleared at
      // the top of each frame), so these are the last rendered frame's
      // numbers, not lifetime totals. `rays` is the exception and is
      // structural: probes × rays-per-probe, fixed when the gather is built.
      if (result.gi2) {
        const g = result.gi2;
        console.log(`  gi2 transport: ${g.rays} rays/frame over ${g.probes} probes ` +
          `(tier ${g.tier}, ${g.built ? "built" : "NOT BUILT"}, frame ${g.frame}), ` +
          `probesValid ${g.probesValid}/${g.probesPlaced}, reproj ${g.reprojHits}, ` +
          `launched ${g.raysLaunched} traced ${g.raysTraced}`);
        console.log(`  gi2 hits: window ${g.windowHits}, screen ${g.screenHits}, ` +
          `sky ${g.skyMiss}, handoffs ${g.handoffs}, first light ${g.msToFirstLight}ms`);
        // The CACHE-WRITE line. `injectWrites` is the radiance cache's write
        // counter and `freshShades` the fresh-slot shade count — together they
        // say whether the frame put anything INTO the cache or only read it,
        // which is the difference between a transport that is converging and
        // one that is replaying a stale window.
        console.log(`  gi2 cache: ${g.injectWrites} writes, ${g.freshShades} fresh shades, ` +
          `${g.alphaForced} alpha-forced, ${g.cacheMB}MB cache / ${g.windowMB}MB window`);
        console.log(`  gi2 medium: ${g.soupTris} soup tris (${g.soupMB}MB), ` +
          `${g.palClasses} palette classes, ${g.movers} movers, ` +
          `voxelizer ${g.voxelizerBuilt ? "built" : "none"}, ` +
          `dynamic ${g.dynamicBuilt ? "built" : "none"}`);
        if (g.statsError) console.log(`  gi2 stats error: ${g.statsError}`);
      }
      const unfed = logs.find((l) => l.includes("traversal counters unfed"));
      if (unfed) console.log(`  note: ${unfed.replace("GI-SMOKE NOTE ", "")}`);
    } else {
      failed++;
      console.error(`FAIL ${arm}:`, JSON.stringify(result).slice(0, 400));
      // The receipts the arm DID produce before it died. The binding audit runs
      // early and the transport assertions late, so an arm that fails on a
      // transport check has usually already answered the one question that is
      // transport-independent - is any kernel over the portable 8-storage-buffer
      // limit - and printing only the error threw that away.
      for (const l of logs) {
        if (/^GI-SMOKE (STORAGE|CENSUS|NOTE)/.test(l)) console.log(`  ${l}`);
      }
      console.error(logs.filter((l) => /error|Error|fail/i.test(l)).slice(-8).join("\n"));
    }
  } catch (err) {
    failed++;
    console.error(`FAIL ${arm}: ${err.message}`);
    console.error(logs.slice(-12).join("\n"));
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
