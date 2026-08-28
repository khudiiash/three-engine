// GI2 DOORS PROBE — who owns the BLACK spots at geometry junctions?
//
// The user's Bistro screenshot 5 (08-27 23:24) shows black dark spots where
// geometry meets geometry: door panels inside their frames, the frame recesses,
// under the planter pot, along the lamp cable. §19 Stage 3.11 REFUTED the
// voxel-self-occlusion hypothesis on a trim rig (contact-scale crops read
// 0.81-1.19 of a path-traced reference — too BRIGHT, not dark), so the spots
// have another owner.
//
// This probe does not argue about it. It reads back EVERY SCREEN STAGE at the
// SAME pixels of the SAME frame — the colour-probe method — and the first one
// that is dark names the owner:
//
//   albedo (palette class)                 material identity
//   irradiance BEFORE aoCompose            the gather / resolve
//   AO factor (raw and bilateral-filtered)  GTAO
//   irradiance AFTER aoCompose             the multiply
//   gi2 lit composite                      albedo x irradiance + glossy + em
//   the final canvas pixel                 everything, incl. sun + tonemap
//
// ⭐ THE CROPS ARE DERIVED, NOT CHOSEN. Bistro has no entity called "door" —
// the whole building is one prefab of `Bistro_Research_Exterior_Paris_*` meshes
// — so the three populations come out of the dump's own geometry: one façade
// normal, the FRONT plane (frame face / flat wall) and the pixels RECESSED
// behind it by 2-15 cm (the panel inside the frame). "Frame" is front-plane
// pixels within 12 dump-px of a recess; "wall" is front-plane pixels at least
// 0.5 m from every recess. A crop somebody picked by eye can land on the wrong
// plane; a population defined by the plane cannot.
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//   node scripts/run-gi2-doors-probe.mjs http://127.0.0.1:5202/
//
// Env: PROJECT · SCENE=Bistro · SETTLE=14 · FRAMES=240 · AO=both|on|off · HEADED=1
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { reportEmitterSeats } from "./lib/gi2EmitterWait.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 14);
const FRAMES = Number(process.env.FRAMES ?? 240);
const AO_ARMS = (process.env.AO ?? "both").toLowerCase();
// ⭐⭐ §19 3.13 — THE DARKEST 1 % IS SELF-SELECTED, SO ACROSS TWO BOOTS IT IS
// TWO DIFFERENT PIXEL SETS AND THE RATIO IS NOT A BEFORE/AFTER.
//
// Each arm ranks the frame by its OWN final luminance, so "the darkest 1 %"
// under the screen probes and under the world lattice are different places and
// a comparison between their two ratios says nothing about whether the cable
// got brighter. `PICK_OUT` writes this boot's populations to a file and
// `PICK_IN` reads them back into the next one — the pose, the resolution and
// the dump stride are identical across the two runs, so the indices name the
// same pixels. The world arm must be run with the SCREEN arm's pick.
const PICK_OUT = process.env.PICK_OUT ?? "";
const PICK_IN = process.env.PICK_IN ?? "";
// ⚠⚠ AND THE POSE HAS TO BE PINNED TOO, OR THE SHARED PICK IS A LIE. The pose
// is DERIVED (banner bounds, an openness ring, a scored standoff search) and it
// came back 11 cm apart on two boots of the same arm — at 2 m that is ~40 px of
// parallax, which moves a 1 124-pixel cable population off the cable and turns
// the receipt into a comparison between a cable and a wall. `POSE=ex,ey,ez|ax,
// ay,az` skips the derivation entirely; the runs that share a pick must share
// this too.
const POSE_ENV = process.env.POSE ?? "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
// The gather's own `noiseDump` is this probe's independent control for "did my
// kernel see the gbuffer at all" — it is only BUILT when a receipt asked for it
// before the gather factory runs.
await page.evaluateOnNewDocument(() => { globalThis.__gi2NoiseDump = true; });
// §19 3.13: the same pre-boot hatch the motion and boot probes already have.
// `FLAGS='{"__gi2WorldProbes":true}'` puts the diffuse path on the world-
// anchored lattice, and it has to be set BEFORE the gather factory runs — which
// is why it is a global and not an editor op.
await page.evaluateOnNewDocument((flags) => {
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, JSON.parse(process.env.FLAGS ?? "{}"));
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

let firstLight = 0;
// ⭐ UNFILTERED. The doors probe forwards only /[gi] AO:|[gi2] (soup|first)|[gi] built/,
// which matches neither `[gi2] shadow bvh ...` nor `[gi2] exact shadow rays: OFF` —
// so a whole session of "the BVH never built" was the FILTER, not the engine.
// Everything is captured here, warnings and errors included, because the question
// this script exists to answer is precisely which line does NOT appear.
const CONSOLE = [];
page.on("console", (m) => {
  const t = m.text();
  CONSOLE.push(`${m.type()}: ${t}`);
  if (/[gi2] first light/.test(t) && !firstLight) firstLight = Date.now();
  if (/[gi2?]/.test(t)) console.log(`    ${m.type()=="warning"?"WARN ":""}${t.slice(0,220)}`);
});
page.on("pageerror", (e) => CONSOLE.push(`pageerror: ${e.message}`));
page.on("pageerror", (e) => {
  const s = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(s)) console.log(`    pageerror: ${s.slice(0, 220)}`);
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
  globalThis.__gi2 = () => {
    const sys = globalThis.__giSys();
    return sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null;
  };
});

const call = async (op, args = {}) => {
  try {
    return await page.evaluate(async ({ op, args }) => {
      try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    }, { op, args });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
};
const gatherFrame = () => page.evaluate(() => globalThis.__gi2()?.gather?.frame ?? 0);
const settleFrames = async (n, capMs = 180000) => {
  const f0 = await gatherFrame();
  const deadline = Date.now() + capMs;
  let f = f0;
  while (f - f0 < n && Date.now() < deadline) { await wait(400); f = await gatherFrame(); }
  return f - f0;
};

console.log(`\n══ ${SCENE} — the doors ═══════════════════════════════════════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{
  const dl = Date.now() + 240000;
  while (Date.now() < dl && !firstLight) await wait(250);
}
console.log(`  first light ${firstLight ? "yes" : "NEVER"} — settling ${SETTLE}s`);

// ⭐ `first light` is GEOMETRY-ready, and a .mat's emissiveNode lands with the
// MATERIAL tail — up to ~27 s later on Bistro. Reading emitters before that
// reports 0 seats on a scene with four lamps. Waited for explicitly, and AHEAD
// of the settle, so SETTLE stays a settle rather than an accidental (and far
// too short) emitter wait.
await reportEmitterSeats(page);
await wait(SETTLE * 1000);

// ── THE QUESTION ───────────────────────────────────────────────────────────
const hit = (re) => CONSOLE.filter((l) => re.test(l));
console.log(`
══ kickShadowBvh verdict ══════════════════════════════════`);
for (const l of hit(/shadow bvh|exact shadow rays|soup d+ tris/)) console.log(`  ${l.slice(0,240)}`);
const built = hit(/\[gi2\] shadow bvh \d+ tris/);
const bailed = hit(/exact shadow rays: OFF/);
const unavail = hit(/shadow bvh unavailable/);
console.log(built.length ? `  VERDICT: BUILT` : bailed.length ? `  VERDICT: BAILED (size/tier gate)` : unavail.length ? `  VERDICT: THREW` : `  VERDICT: kickShadowBvh produced NO line at all`);
const g = await page.evaluate(() => { const s = globalThis.__gi2?.(); const sys = globalThis.__giSys?.(); return { slot: !!s, ready: s?.shadowBvhReady ?? null, seats: sys?._emitterInfos?.filter(Boolean).length ?? 0, maxTris: globalThis.__gi2Rc5BvhShadowMax ?? null, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0)/1048576) }; });
console.log(`  gate __gi2Rc5BvhShadowMax=${g.maxTris}  seats=${g.seats}  heap=${g.heapMB}MB`);
await browser.close();
process.exit(0);