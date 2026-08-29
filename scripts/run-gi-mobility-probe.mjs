// GI §19 6.22 — GI MOBILITY IS THE CLASSIFICATION (receipts on the Cornell box).
//
//   (a) at rest: `contentKey.transforms` bumps over REST_S seconds must be 0, and
//       which slot moved (name) when it is not; cpuMs alongside.
//   (b) tall block → "static", moved 1 m: movers 0, no dynamic voxels, ONE warn.
//   (c) tall block → "dynamic": movers 1, dynamic.voxelsSet > 0.
//   (d) tall block → "auto": movers 0 at rest; after a move movers 1; after the
//       settle window movers 0 again; soupBuilds reported.
//
//   node scripts/run-gi-mobility-probe.mjs http://127.0.0.1:5204/
//   Env: PROJECT · SCENE=Cornel · REST_S=5 · SETTLE=6 · BLOCK=Tall · HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = (process.argv[2] ?? "http://127.0.0.1:5204/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const REST_S = Number(process.env.REST_S ?? 5);
const SETTLE = Number(process.env.SETTLE ?? 6);
const BLOCK = process.env.BLOCK ?? "tall";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const marks = { firstLight: 0, lines: [] };
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light/.test(t) && !marks.firstLight) marks.firstLight = Date.now();
  if (/\[gi2\]|GI static|mobility|\[gi\] rebuild/i.test(t)) { marks.lines.push(t.slice(0, 220)); console.log(`    ${t.slice(0, 220)}`); }
});
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
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
  globalThis.__eng = mod.engine;
  globalThis.__sys = () => mod.engine?.modules?.get?.("gi")?.system ?? null;
});
const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });

const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(2); }
{ const d = Date.now() + 180000; while (Date.now() < d && !marks.firstLight) await wait(250); }
console.log(marks.firstLight ? `first light — settling ${SETTLE}s` : "⚠ no first light");
await wait(SETTLE * 1000);

const gi2 = async () => (await call("profile.gi2", {})).value;
const fs = async () => (await call("profile.frameStats", {})).value;
const mob = async () => page.evaluate(() => globalThis.__sys()?._gi2Stats?.mobility ?? globalThis.__sys()?.gi2MobilityCounts?.() ?? null);

// ── (a) rest ─────────────────────────────────────────────────────────────────
const restProbe = async (label) => {
  const a = await page.evaluate(() => {
    const c = globalThis.__eng.content;
    globalThis.__slotMoved = new Map();
    const sys = globalThis.__sys();
    const atlas = sys?.state?.atlas;
    const tick = () => {
      if (!globalThis.__slotWatch) return;
      const as = atlas?.assignments ?? [];
      for (const asg of as) {
        if (!asg) continue;
        const e = atlas.worldMatrixOf(asg).elements;
        const cache = asg.matrixCache;
        for (let k = 0; k < 16; k++) if (Math.abs(cache[k] - e[k]) > 1e-7) {
          const n = asg.mesh?.name || asg.mesh?.userData?.entityId || "?";
          globalThis.__slotMoved.set(n, (globalThis.__slotMoved.get(n) ?? 0) + 1); break;
        }
      }
      requestAnimationFrame(tick);
    };
    globalThis.__slotWatch = true; requestAnimationFrame(tick);
    return { t: c.counts.transforms, v: c.version, reason: c.lastReason };
  });
  await wait(REST_S * 1000);
  const b = await page.evaluate(() => {
    globalThis.__slotWatch = false;
    const c = globalThis.__eng.content;
    return { t: c.counts.transforms, v: c.version, reason: c.lastReason, moved: [...globalThis.__slotMoved.entries()] };
  });
  const f = await fs();
  const g = await gi2();
  console.log(`(a) ${label}: transforms bumps in ${REST_S}s = ${b.t - a.t} (lastReason ${b.reason}); ` +
    `slots that moved: ${JSON.stringify(b.moved)}; cpuMs ${f?.cpuMs ?? f?.cpu?.ms ?? "?"} fps ${f?.fps ?? "?"}; ` +
    `movers ${g?.movers} dynVox ${g?.dynamic?.voxelsSet ?? "?"} soupBuilds ${g?.soupBuilds} mobility ${JSON.stringify(g?.mobility ?? (await mob()))}`);
  return b.t - a.t;
};
await restProbe("rest");

// ── the tall block ───────────────────────────────────────────────────────────
const list = (await call("entity.list", {})).value ?? [];
let block = list.find((e) => new RegExp(BLOCK, "i").test(e.name) && e.components?.some?.((c) => (c.type ?? c) === "mesh"));
if (!block) block = list.find((e) => /box|block|cube/i.test(e.name) && e.components?.some?.((c) => (c.type ?? c) === "mesh"));
if (!block) { console.log("FATAL: no block entity; names: " + list.map((e) => e.name).join(", ")); await browser.close(); process.exit(2); }
const pos0 = block.transform?.position ?? [0, 0, 0];
console.log(`block: "${block.name}" ${block.id} at ${JSON.stringify(pos0)}`);
const setMob = async (v) => call("component.setProp", { id: block.id, type: "mesh", key: "giMobility", value: v })
  .then(async (r) => r.ok ? r : call("component.setProp", { id: block.id, type: "mesh", prop: "giMobility", value: v }));
const moveTo = (p) => call("entity.setTransform", { id: block.id, position: p });
const readAt = async (label) => {
  const g = await gi2();
  console.log(`  ${label}: movers ${g?.movers} dynVox ${g?.dynamic?.voxelsSet ?? "?"} soupBuilds ${g?.soupBuilds} mobility ${JSON.stringify(g?.mobility ?? (await mob()))}`);
  return g;
};

// (b) static
console.log("(b) static, move +1 m x");
console.log("   setProp:", JSON.stringify((await setMob("static")).value ?? "err").slice(0, 120));
await wait(500);
const warnsBefore = marks.lines.filter((l) => /GI static and moved/.test(l)).length;
await moveTo([pos0[0] + 1, pos0[1], pos0[2]]);
await wait(2500);
await readAt("static after move");
await moveTo([pos0[0] + 1.2, pos0[1], pos0[2]]);
await wait(1000);
const warns = marks.lines.filter((l) => /GI static and moved/.test(l)).length - warnsBefore;
console.log(`   one-time warn fired: ${warns} (expect 1 across two moves)`);

// (c) dynamic
console.log("(c) dynamic");
await setMob("dynamic");
await wait(2500);
await readAt("dynamic at rest");
await moveTo([pos0[0] - 1, pos0[1], pos0[2]]);
await wait(300);
await readAt("dynamic moving");

// (d) auto
console.log("(d) auto");
await setMob("auto");
await moveTo(pos0);
await wait(4000);
await readAt("auto at rest (post-rebuild)");
await moveTo([pos0[0] + 0.8, pos0[1], pos0[2]]);
await wait(300);
await readAt("auto right after move");
for (let i = 0; i < 8; i++) { await wait(1000); await readAt(`auto +${i + 1}s`); }
await restProbe("rest after (d)");
await browser.close();
