// EMITTER SEAT-SPARSE GATE — drives scripts/gi-emitter-seat-sparse.html.
//
// Plan §11.11's gate: the emitter-shadow pass marches ONE seat per pixel per
// dispatch on a 2×2 lattice and writes a −1 sentinel for the seats it did not
// march; `createGiLightShadowFilterPass` in `sparse` mode reconstructs those
// from the same-frame neighbours. This gate runs the SHIPPING filter on a
// synthetic gbuffer twice — once on a dense raw, once on the same raw with
// the lattice's sentinels — and diffs the two, plus the arms the dense arm
// cannot express:
//   • lattice   (CPU) every 2×2 block and 3×3 window of the pass's
//               k = (x + 2y + phase) mod n carries every live seat, n = 1..4;
//   • leak      no output channel ever carries the sentinel;
//   • empty     an empty seat (raw 1) stays exactly 1;
//   • island    a pixel with no same-plane neighbour: its own seat is its
//               own sample, the rest hold 1 — or its validated HISTORY when
//               the chain has one (the clip must not crush that history to
//               0 from an all-zero neighbourhood);
//   • dist      the width fill is NEAREST valid tap, never a mean — a
//               half-plane of width 0.2 fills to exactly {0, 0.2}.
//
// Run: node scripts/run-gi-emitter-seat-sparse-test.mjs [baseUrl]
import puppeteer from "puppeteer-core";

const base = (process.argv[2] ?? "http://localhost:5201/").replace(/\/$/, "");
const url = `${base}/scripts/gi-emitter-seat-sparse.html`;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));

let code = 1;
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("globalThis.__EMITTER_SEAT_RESULT__ !== undefined", { timeout: 120000 });
  const result = await page.evaluate("globalThis.__EMITTER_SEAT_RESULT__");
  if (result?.text) console.log(result.text);
  if (result?.pass) {
    console.log(`gi-emitter-seat-sparse: PASS — ${result.checks} checks on a ${result.grid} grid ` +
      `(worst smooth-channel sparse-vs-dense ${result.worstSmooth}, worst history blend ${result.worstHist})`);
    code = 0;
  } else {
    console.error(`gi-emitter-seat-sparse: FAIL — ${result?.error ?? `${result?.failures} checks`}`);
    if (!result?.text) console.error(logs.slice(-25).join("\n"));
  }
} catch (err) {
  console.error(`gi-emitter-seat-sparse: FAIL — ${err.message}`);
  console.error(logs.slice(-30).join("\n"));
} finally {
  await browser.close();
}
process.exit(code);
