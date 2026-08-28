// GI TEXTURE-AVERAGE PROBE — §19 stage 4.3: DOES THE GPU BLIT ANSWER ABOUT THE
// TEXTURE IT WAS HANDED?
//
// ══ THE REPORT ═══════════════════════════════════════════════════════════════
//
// Bistro renders GREEN — pavement, walls, chairs — on BOTH GI paths, in 16 px
// tile blocks that move with the camera. The user's console this boot shows
// FOUR different roughness maps' §16 R4 floor readbacks reading IDENTICALLY
// `r 0.00 g 0.74 b 0.00`, and the emitter seats reading rgb [0, 10, 0] for
// lamps that raster WHITE. Every one of those numbers comes out of the same
// 32²-quad blit — `computeCompressedTextureAverage` / `readTexturePixelsGPU`
// in `giScreen.js` — which builds a FRESH `NodeMaterial` (`colorNode =
// texture(tex)`) per call and renders it on a `QuadMesh`.
//
// ⭐ A CACHE KEYED ON STRUCTURE CANNOT TELL TWO OF THOSE CALLS APART. That is
// the hypothesis, and it is decidable in one boot: hand the helper colours
// whose answer is known.
//
// ══ THE GATE ═════════════════════════════════════════════════════════════════
//
//   · each synthetic solid comes back within 0.02 of its own colour, AND
//   · the real KTX2 maps come back pairwise DISTINCT.
//
// A failure that returns ONE colour for every call names the blit. A failure
// where the synthetics are right and only the compressed maps collide names the
// compressed upload/binding instead. ⭐ The repeated RED, run last, separates
// "the first call's texture sticks" from "the last one wins".
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//
// Run:  node scripts/run-gi-texavg-probe.mjs
// Env:  PROJECT · SCENE=Bistro · SETTLE=12 · HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 12);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : "—");
const rgb = (a) => (a ? `[${a.map((v) => f(v, 3)).join(", ")}]` : "null");
const dist = (a, b) => (a && b ? Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i]))) : Infinity);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--js-flags=--expose-gc",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

let firstLight = 0;
const texAvgLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t) && !firstLight) firstLight = Date.now();
  if (/bounce albedo|texture-averages|R4 floor|retint/i.test(t)) texAvgLines.push(t.slice(0, 200));
});
page.on("pageerror", (e) => {
  const s = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(s)) console.log(`    pageerror: ${s.slice(0, 200)}`);
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__giEngineForProbe = mod.engine;
  globalThis.__giSys = () => mod.engine?.modules?.get?.("gi")?.system ?? null;
});
const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });

console.log(`\n══ ${SCENE} — does the blit answer about its own texture? ══════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{
  const dl = Date.now() + 240000;
  while (Date.now() < dl && !firstLight) await wait(250);
}
console.log(`  first light ${firstLight ? "yes" : "NEVER"} — settling ${SETTLE}s`);
await wait(SETTLE * 1000);

const res = await page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe;
  const { runTexAvgProbe } = await import("/scripts/lib/giTexAvgProbe.js");
  try {
    return await runTexAvgProbe({ renderer: eng.renderer, scene: eng.scene });
  } catch (err) { return { error: err?.stack ?? String(err) }; }
});
if (res.error) { console.log(`FATAL in-page: ${res.error.slice(0, 600)}`); await browser.close(); process.exit(1); }

console.log(`\n  scene textures: ${res.counts.textures} (${res.counts.compressed} compressed)`);
console.log(`\n  ── computeCompressedTextureAverage, synthetic solids ─────────`);
let synFail = 0;
for (const r of res.rows) {
  const d = dist(r.avg, r.want);
  if (!(d <= 0.02)) synFail++;
  console.log(`    ${r.key.padEnd(6)} want ${rgb(r.want)}  got ${rgb(r.avg)}   ` +
    `Δmax ${f(d, 4)}  ${d <= 0.02 ? "ok" : "WRONG"}`);
}
console.log(`\n  ── readTexturePixelsGPU, same five ──────────────────────────`);
let pixFail = 0;
for (let i = 0; i < res.pixRows.length; i++) {
  const want = res.rows[i].want;
  const d = dist(res.pixRows[i].mean, want);
  if (!(d <= 0.02)) pixFail++;
  console.log(`    ${res.pixRows[i].key.padEnd(6)} want ${rgb(want)}  got ${rgb(res.pixRows[i].mean)}   ` +
    `Δmax ${f(d, 4)}  ${d <= 0.02 ? "ok" : "WRONG"}`);
}
console.log(`\n  ── the real maps ────────────────────────────────────────────`);
for (const r of res.real) {
  console.log(`    ${(r.name ?? "").slice(0, 34).padEnd(34)} ${r.slot.padEnd(13)} ` +
    `${r.compressed ? "KTX2" : "cpu "} ${r.size.padStart(9)}  ${r.uuid}  avg ${rgb(r.avg)}`);
}
let realCollisions = 0;
for (let i = 0; i < res.real.length; i++) {
  for (let j = i + 1; j < res.real.length; j++) {
    if (dist(res.real[i].avg, res.real[j].avg) < 1e-4) realCollisions++;
  }
}
console.log(`\n    pairwise identical real averages: ${realCollisions}`);
if (texAvgLines.length) {
  console.log(`\n  console (bounce albedo / retint):`);
  for (const l of texAvgLines.slice(0, 8)) console.log(`    ${l}`);
}

// ── STEP 2: WHERE DOES THE GREEN ENTER? ──────────────────────────────────────
const cen = await page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe;
  const sys = globalThis.__giSys();
  const gi2 = sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null;
  const { runPaletteCensus } = await import("/scripts/lib/giTexAvgProbe.js");
  try {
    return await runPaletteCensus({ renderer: eng.renderer, scene: eng.scene, giSys: sys, gi2 });
  } catch (err) { return { error: err?.stack ?? String(err) }; }
});
let greenClasses = 0;
if (cen.error) {
  console.log(`
  census FAILED: ${cen.error.slice(0, 500)}`);
} else {
  const gd = (a) => a[1] > 1.8 * Math.max(a[0], a[2]) && a[1] > 1e-4;
  greenClasses = cen.classes.filter((c) => gd(c.albedo)).length;
  const greenEm = cen.classes.filter((c) => gd(c.em)).length;
  console.log(`
  ── the GI2 palette, as the shaders read it ──────────────────`);
  console.log(`    live classes ${cen.classes.length}   GREEN-dominant albedo ${greenClasses}   ` +
    `green-dominant emission ${greenEm}`);
  const ch = cen.classes.map((c) => {
    const mx = Math.max(...c.albedo) || 1e-6;
    return Math.abs(c.albedo[0] - c.albedo[1]) / Math.max(1e-6, c.albedo[0] + c.albedo[1]);
  }).sort((a, b) => a - b);
  console.log(`    class chroma |R−G|/(R+G):  p05 ${f(ch[Math.floor(ch.length * 0.05)] ?? 0, 3)}  ` +
    `p50 ${f(ch[Math.floor(ch.length * 0.5)] ?? 0, 3)}  p95 ${f(ch[Math.floor(ch.length * 0.95)] ?? 0, 3)}`);
  for (const c of cen.classes.slice(0, 10)) {
    console.log(`      #${String(c.i).padStart(2)} albedo ${rgb(c.albedo)} mean ${f(c.mean, 3)}` +
      (c.em.some((v) => v > 1e-5) ? `  EMISSION ${rgb(c.em)}` : "") + (gd(c.albedo) ? "   ← GREEN" : ""));
  }
  console.log(`
  ── resolveMaterialSurface over ${cen.matCount} materials ─────────────`);
  const gc = cen.rows.filter((r) => r.greenColor).length;
  const ge = cen.rows.filter((r) => r.greenEmissive).length;
  console.log(`    green-dominant resolved ALBEDO ${gc}   green-dominant resolved EMISSIVE ${ge}`);
  for (const s of cen.suspects.slice(0, 8)) {
    console.log(`      ${(s.name ?? "").slice(0, 24).padEnd(24)} ${s.uuid}  ` +
      `color ${rgb(s.color)}  base ${rgb(s.base)}  em ${rgb(s.emissive)}×${f(s.intensity, 2)}  ` +
      `nodes[c${s.hasColorNode ? 1 : 0} e${s.hasEmissiveNode ? 1 : 0}]`);
    console.log(`        maps ${JSON.stringify(s.maps)}`);
    for (const [k, v] of Object.entries(s.mapAverages ?? {})) {
      console.log(`        avg(${k.padEnd(13)}) ${rgb(v)}`);
    }
  }
  console.log(`
  ── the emitter seats ────────────────────────────────────────`);
  for (const s of cen.seats) {
    const inf = cen.infos[s.i] ?? {};
    const g = s.color[1] / Math.max(1e-6, Math.max(s.color[0], s.color[2]));
    console.log(`      slot ${s.i}  rgb ${rgb(s.color)}  greenRatio ${f(g, 2)}  reff ${f(s.reff, 2)}  ` +
      `radius ${f(s.radius, 2)}`);
    console.log(`        from mesh "${(inf.mesh ?? "").slice(0, 30)}" mat "${(inf.mat ?? "").slice(0, 24)}" ` +
      `mat.emissive ${rgb(inf.matEmissive)}×${f(inf.matIntensity ?? 1, 2)} ` +
      `emissiveMap ${inf.emissiveMap ?? "—"} emissiveNode ${inf.hasEmissiveNode ? "yes" : "no"}`);
  }
}

// ── STEP 2b: THE EMISSIVE NODE GRAPHS ────────────────────────────────────────
const graphs = await page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe;
  const { dumpEmissiveGraphs } = await import("/scripts/lib/giTexAvgProbe.js");
  try { return dumpEmissiveGraphs(eng.scene, globalThis.__giSys()); }
  catch (err) { return { error: err?.stack ?? String(err) }; }
});
if (graphs.error) console.log(`
  graph dump FAILED: ${graphs.error.slice(0, 400)}`);
else {
  console.log(`
  ── emissiveNode graphs (${graphs.total} materials carry one) ──────`);
  const show = (n, ind) => {
    if (!n) return;
    const v = n.val
      ? ` value=${n.val.kind}${n.val.rgb ? ` rgb[${n.val.rgb.map((x) => f(x, 3))}]` : ""}` +
        `${n.val.xyz ? ` xyzw[${n.val.xyz.map((x) => f(x, 3))}]` : ""}` +
        `${n.val.kind === "number" ? ` = ${f(n.val.v, 3)}` : ""}` +
        `${n.val.uuid ? ` ${n.val.uuid}${n.val.compressed ? " KTX2" : ""}` : ""}`
      : "";
    console.log(`${ind}${n.cls}${n.op ? `(op=${JSON.stringify(n.op)})` : ""}` +
      `${n.components ? ` .${n.components}` : ""}${n.nodeType ? ` :${n.nodeType}` : ""}${v}`);
    show(n.a, ind + "  a "); show(n.b, ind + "  b "); show(n.inner, ind + "  n ");
  };
  for (const r of graphs.rows) {
    console.log(`
    "${(r.mesh ?? "").slice(0, 28)}" ${r.mat} ${r.uuid}` +
      `${r.seated ? "  ★SEATED" : ""}${r.pureHue ? "  ⚠PURE-HUE" : ""}`);
    console.log(`      resolved emissive ${rgb(r.resolved)} × ${f(r.intensity, 3)}   ` +
      `material.emissive ${rgb(r.matEmissive)} × ${f(r.matIntensity, 2)}`);
    show(r.graph, "      ");
  }
}

const pass = synFail === 0 && pixFail === 0 && realCollisions === 0;
console.log(`\n  VERDICT: ${pass ? "PASS" : "FAIL"} — ` +
  `${synFail} synthetic average(s) wrong, ${pixFail} pixel read(s) wrong, ` +
  `${realCollisions} colliding real pair(s)`);
if (synFail) {
  const first = res.rows[0];
  const same = res.rows.filter((r) => dist(r.avg, first.avg) < 1e-4).length;
  console.log(`  ⭐ ${same} of ${res.rows.length} synthetic calls returned the FIRST call's colour ` +
    `${rgb(first.avg)} — the blit is answering about a texture it was not handed.`);
}
await browser.close();
process.exit(pass ? 0 : 1);
