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
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light/.test(t) && !firstLight) firstLight = Date.now();
  if (/\[gi\] AO:|\[gi2\] (soup|first)|\[gi\] built/.test(t)) console.log(`    ${t.slice(0, 240)}`);
});
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
await wait(SETTLE * 1000);

// ── THE POSE: 2 m in front of the bistro's own doors ────────────────────────
//
// Derived, never authored. `Paris_BistroFrontBanner_01` is the "Le Petit Coin"
// banner and it hangs directly over the entrance, so its XZ is the doorway's;
// the street mesh gives the ground. The camera stands `STANDOFF` metres out
// along whichever horizontal direction is OPEN (a 24-ray ring through the live
// window picks it — the same trick §3.7's façade pose uses) and looks back at
// door height, so the frame fills the middle of the frame.
//
// ⭐⭐ AND THE STANDOFF IS SEARCHED, NOT ASSERTED. The first cut asserted
// 2.2 m and came back with a COMPLETELY EMPTY gbuffer — 0 of 112 992 valid
// pixels, confirmed by the gather's own `noiseDump` reading the same buffer
// inside the engine's chain, so the camera was standing inside something. A
// pose is only a pose if the frame has the subject in it, so each candidate is
// scored by what it actually renders (valid pixels, and the share of them at
// geometric DETAIL — the recesses this probe exists to measure) before one is
// picked.
const STANDOFF = process.env.STANDOFF ? [Number(process.env.STANDOFF)] : [2.2, 3, 4, 5, 6, 8];

// The gather's own half-res dump — 1.8 MB, one dispatch — as the pose scorer.
const quickLook = () => page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe;
  const g = globalThis.__gi2()?.gather;
  if (!g?.passes?.noiseDump || !g.buffers?.dirtyBuf) return { error: "no noise kernel" };
  await eng.renderer.computeAsync(g.passes.noiseDump);
  const noise = new Float32Array(await eng.renderer.getArrayBufferAsync(g.buffers.noiseBuf.value));
  const geo = new Float32Array(await eng.renderer.getArrayBufferAsync(g.buffers.dirtyBuf.value));
  let valid = 0; let edge = 0; let vert = 0; let near = 0; let sum = 0;
  const n = geo.length / 4;
  for (let i = 0; i < n; i++) {
    if (!(noise[i * 4 + 3] > 0.5)) continue;
    valid++;
    sum += noise[i * 4];
    if (noise[i * 4 + 2] > 0.5) edge++;
    if (Math.abs(geo[i * 4 + 1]) < 0.4) vert++;
    if (geo[i * 4] < 6) near++;
  }
  return { valid, of: n, edge, vert, near, mean: valid ? sum / valid : 0 };
});

async function doorsPose() {
  const bounds = async (needle) => {
    const list = (await call("entity.list", { nameContains: needle })).value ?? [];
    let agg = null;
    for (const e of list.slice(0, 24)) {
      const b = (await call("entity.getBounds", { id: e.id })).value;
      if (!b || b.empty) continue;
      agg ??= { min: [...b.min], max: [...b.max] };
      for (let i = 0; i < 3; i++) {
        agg.min[i] = Math.min(agg.min[i], b.min[i]);
        agg.max[i] = Math.max(agg.max[i], b.max[i]);
      }
    }
    return agg;
  };
  const banner = await bounds("FrontBanner");
  if (!banner) return null;
  const street = await bounds("Paris_Street_");
  const B = banner.min.map((v, i) => (v + banner.max[i]) / 2);
  const ground = street ? street.max[1] : banner.min[1] - 3.4;
  const eye = ground + 1.6;
  await call("viewport.setCamera", { position: [B[0], eye, B[2]], target: [B[0] + 4, eye, B[2]] });
  await settleFrames(60, 20000);
  const ring = await page.evaluate(async ({ o }) => {
    const eng = globalThis.__giEngineForProbe;
    const gi2 = globalThis.__gi2();
    if (!gi2?.trace || !eng?.renderer) return null;
    const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
    const shoot = createGi2RayShooter(gi2, eng.renderer);
    const dirs = [];
    for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; dirs.push([Math.cos(a), 0, Math.sin(a)]); }
    // ⚠ FIRED TWICE, AND THE SECOND ONE IS THE ANSWER. The shooter's kernel is
    // built on first use, and a fresh compute node's first `computeAsync`
    // compiles rather than runs — the ring came back 24 × tMax (every ray a
    // miss, from the middle of a Paris street) and the "most open direction"
    // was silently just direction 0.
    const rays = dirs.map((d) => ({ o, d, tMax: 30 }));
    await shoot(rays);
    const out = await shoot(rays);
    return dirs.map((d, i) => ({ d, t: out[i].hit ? out[i].t : 30 }));
  }, { o: [B[0], eye, B[2]] });
  if (!ring) return null;
  const D = ring.reduce((a, b) => (b.t > a.t ? b : a)).d;
  console.log(`  banner centre ${B.map((v) => v.toFixed(2))} ground ${ground.toFixed(2)}  open dir ` +
    `[${D.map((v) => v.toFixed(2))}]  ring t ${ring.map((r) => r.t.toFixed(1)).join(" ")}`);
  const cands = [];
  for (const s of STANDOFF) {
    cands.push({
      name: `out ${s}m`,
      position: [B[0] + D[0] * s, ground + 1.6, B[2] + D[2] * s],
      target: [B[0], ground + 1.15, B[2]],
    });
  }
  // The §3.7 façade pose, which is known to render, as the control candidate.
  cands.push({
    name: "3.7 façade-wide",
    position: [B[0] + D[0] * 6, ground + 1.65, B[2] + D[2] * 6],
    target: [B[0], ground + 2.2, B[2]],
  });
  let best = null;
  for (const c of cands) {
    await call("viewport.setCamera", { position: c.position, target: c.target });
    await settleFrames(30, 25000);
    const q = await quickLook();
    const score = (q.valid ?? 0) * ((q.edge ?? 0) / Math.max(1, q.valid ?? 1));
    console.log(`    pose ${c.name.padEnd(16)} valid ${String(q.valid ?? "—").padStart(6)}/${q.of ?? "—"} ` +
      `vert ${q.vert ?? "—"} near<6m ${q.near ?? "—"} detail ${q.valid ? ((100 * q.edge) / q.valid).toFixed(0) : "—"}% ` +
      `mean ${q.mean?.toFixed(4) ?? "—"}  score ${score.toFixed(0)}`);
    if ((q.valid ?? 0) > 0.3 * (q.of ?? 1) && (!best || score > best.score)) best = { ...c, score, q };
  }
  return best ? { ...best, ground, name: `doors ${best.name}` } : null;
}

// ══ THE PER-STAGE READ ══════════════════════════════════════════════════════
//
// One `page.evaluate`: the GPU dump, the canvas and the palette all come from
// the same parked frame, and the crops are chosen from the dump itself. Pass
// `pick` (arm 1's answer) to measure the SAME pixels again after the flip.
const readFrame = (pick) => page.evaluate(async ({ pick }) => {
  const eng = globalThis.__giEngineForProbe;
  const sys = globalThis.__giSys();
  const gi2 = globalThis.__gi2();
  const screen = sys?.state?.screen;
  if (!gi2?.gather || !screen?.gbuffer) return { error: "no gi2 / gbuffer" };
  const { createGi2StageDump } = await import("/scripts/lib/gi2StageProbe.js");
  const ws = await import("/src/modules/gi/window/windowStore.js");
  const stride = 2;
  const dump = createGi2StageDump({ renderer: eng.renderer, gi2, screen, stride });
  if (!dump) return { error: "no dump rig" };

  // The canvas FIRST, off a post-render, so the picture and the textures the
  // dump reads belong to the same settled frame (the camera is parked, so
  // "settled" is literal: nothing between them moves).
  const canvasLum = await new Promise((resolve) => {
    let n = 0;
    const off = eng.onPostRender(() => {
      if (++n < 2) return;
      off();
      const src = eng.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      c.getContext("2d").drawImage(src, 0, 0);
      const id = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      resolve({ w: c.width, h: c.height, data: id.data });
    });
  });

  const D = await dump.read();
  const { dumpW, dumpH, hasAo, hasShadow, width, height, aoWidth, aoHeight } = dump;
  const V = 6;
  const at = (i, v, c) => D[(i * V + v) * 4 + c];

  // sRGB -> linear: the canvas is display-encoded, and a ratio of two encoded
  // numbers is not the ratio of the two lights (⭐ the vxao lesson: 0.50
  // displays at 0.74).
  const toLin = (u8) => {
    const s = u8 / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const cScaleX = canvasLum.w / width;
  const cScaleY = canvasLum.h / height;
  const finalAt = (gx, gy) => {
    const cx = Math.min(canvasLum.w - 1, Math.round((gx * stride + 0.5) * cScaleX));
    const cy = Math.min(canvasLum.h - 1, Math.round((gy * stride + 0.5) * cScaleY));
    const o = (cy * canvasLum.w + cx) * 4;
    return [toLin(canvasLum.data[o]), toLin(canvasLum.data[o + 1]), toLin(canvasLum.data[o + 2])];
  };

  // ── albedo: the palette class the compositor itself indexes ───────────────
  const winW = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.win.attribute));
  const pal = gi2.gather.palette ?? [];
  const v0 = gi2.win.voxel0;
  const origins = gi2.win.origins;
  const levels = gi2.win.levels;
  const SURFACE_EPS = 0.1;
  const albedoAt = (P, Nn) => {
    const q = [P[0] - Nn[0] * v0 * SURFACE_EPS, P[1] - Nn[1] * v0 * SURFACE_EPS, P[2] - Nn[2] * v0 * SURFACE_EPS];
    let level = levels - 1;
    for (let l = levels - 1; l >= 0; l--) {
      const s = v0 * 2 ** l;
      const rx = Math.floor(q[0] / s) - origins[l * 3];
      const ry = Math.floor(q[1] / s) - origins[l * 3 + 1];
      const rz = Math.floor(q[2] / s) - origins[l * 3 + 2];
      if (rx >= 0 && ry >= 0 && rz >= 0 && rx < 64 && ry < 64 && rz < 64) level = l;
    }
    const s = v0 * 2 ** level;
    const cx = Math.floor(q[0] / s) & 63;
    const cy = Math.floor(q[1] / s) & 63;
    const cz = Math.floor(q[2] / s) & 63;
    const vi = cx | (cy << 6) | (cz << 12);
    const base = level * ws.LEVEL_WORDS;
    const pb = (winW[base + ws.PAL_OFF + (vi >> 2)] >>> ((vi & 3) * 8)) & 255;
    const e = pb === 255 ? null : pal[pb];
    return { level, pal: pb, albedo: e ? [e.x, e.y, e.z] : null };
  };

  // ── the façade plane, from the dump ───────────────────────────────────────
  //
  // Mode over the central 60% of the frame, quantized to 0.1 of a normal
  // component: whatever the camera is looking at is the plane every population
  // below is defined against.
  const key = (n) => `${Math.round(n[0] * 10)},${Math.round(n[1] * 10)},${Math.round(n[2] * 10)}`;
  const hist = new Map();
  const x0 = Math.floor(dumpW * 0.2); const x1 = Math.ceil(dumpW * 0.8);
  const y0 = Math.floor(dumpH * 0.2); const y1 = Math.ceil(dumpH * 0.8);
  let validCentre = 0; let totalCentre = 0;
  const bbox = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
  for (let gy = y0; gy < y1; gy++) {
    for (let gx = x0; gx < x1; gx++) {
      const i = gy * dumpW + gx;
      totalCentre++;
      if (!(at(i, 0, 3) > 0.5)) continue;
      validCentre++;
      for (let c = 0; c < 3; c++) {
        bbox.min[c] = Math.min(bbox.min[c], at(i, 0, c));
        bbox.max[c] = Math.max(bbox.max[c], at(i, 0, c));
      }
      const n = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
      // ⚠ NO |ny| FILTER. The first cut of this probe demanded a VERTICAL
      // surface and came back "no vertical surface in view" from a pose that
      // clearly had a façade in it — a filter deciding the receipt's subject is
      // a filter that can silently have no subject. The dominant plane of the
      // middle of the frame is whatever the camera is looking at, and if it is
      // the pavement the diagnostics below say so.
      const k = key(n);
      const e = hist.get(k) ?? { n: [0, 0, 0], c: 0 };
      e.n[0] += n[0]; e.n[1] += n[1]; e.n[2] += n[2]; e.c++;
      hist.set(k, e);
    }
  }
  let validAll = 0;
  for (let i = 0; i < dumpW * dumpH; i++) if (at(i, 0, 3) > 0.5) validAll++;
  // ⚠ CAN THE SHADOW COLUMN SEE ITS SUBJECT? Every crop reading exactly 0.000
  // has two readings — "this façade is in shade" (§3.7 picked the pose for
  // that) and "the target is unwritten" — and a crop table cannot tell them
  // apart. The whole-frame histogram can: if ANY pixel reads lit, the texture
  // is live and 0 on the façade is the answer, not the instrument.
  let shLit = 0; let shDark = 0; let shMid = 0; let shNone = 0;
  for (let i = 0; i < dumpW * dumpH; i++) {
    if (!(at(i, 0, 3) > 0.5)) continue;
    const v = at(i, 5, 0);
    if (v < -0.5) shNone++;
    else if (v > 0.9) shLit++;
    else if (v < 0.1) shDark++;
    else shMid++;
  }
  // ⭐ CAN THE INSTRUMENT SEE ITS SUBJECT? An all-zero dump has two causes —
  // "the frame really is empty" and "the kernel never wrote" — and they are
  // indistinguishable from the statistic. `nonZero` separates them, and the
  // gather's OWN `noiseDump` (which reads the same gbuffer through the same
  // texture node inside the ENGINE's chain) is the independent control.
  let nonZero = 0;
  for (let k = 0; k < D.length; k++) if (D[k] !== 0) nonZero++;
  let controlValid = null;
  try {
    const g = gi2.gather;
    if (g?.passes?.noiseDump && g.buffers?.dirtyBuf) {
      await eng.renderer.computeAsync(g.passes.noiseDump);
      const geo = new Float32Array(await eng.renderer.getArrayBufferAsync(g.buffers.dirtyBuf.value));
      let c = 0;
      for (let k = 3; k < geo.length; k += 4) if (geo[k] > 0.5) c++;
      controlValid = { valid: c, of: geo.length / 4 };
    }
  } catch (err) { controlValid = { error: String(err?.message ?? err).slice(0, 120) }; }
  const diag = {
    attempts: D.attempts, nonZero, controlValid,
    sunShadowFrame: { lit: shLit, dark: shDark, partial: shMid, noTarget: shNone },
    dump: [dumpW, dumpH], resolve: [width, height], canvas: [canvasLum.w, canvasLum.h],
    gbuffer: [screen.gbuffer.position?.image?.width ?? null, screen.gbuffer.position?.image?.height ?? null],
    validAll, floats: D.length,
    validCentre, totalCentre,
    bbox: validCentre ? { min: bbox.min.map((v) => +v.toFixed(2)), max: bbox.max.map((v) => +v.toFixed(2)) } : null,
    topNormals: [...hist.entries()].sort((a, b) => b[1].c - a[1].c).slice(0, 5)
      .map(([k, e]) => `${k}×${e.c}`),
    camera: [eng.camera?.position?.x, eng.camera?.position?.y, eng.camera?.position?.z].map((v) => +Number(v).toFixed(2)),
  };
  if (!hist.size) return { error: "no geometry in the middle of the frame", diag };
  const top = [...hist.values()].sort((a, b) => b.c - a.c)[0];
  const L = Math.hypot(top.n[0], top.n[1], top.n[2]);
  const FN = [top.n[0] / L, top.n[1] / L, top.n[2] / L];

  // Plane offsets along the façade normal, for every pixel that shares it.
  const dOf = new Float32Array(dumpW * dumpH).fill(NaN);
  const ds = [];
  for (let i = 0; i < dumpW * dumpH; i++) {
    if (!(at(i, 0, 3) > 0.5)) continue;
    const n = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
    if (n[0] * FN[0] + n[1] * FN[1] + n[2] * FN[2] < 0.9) continue;
    const d = at(i, 0, 0) * FN[0] + at(i, 0, 1) * FN[1] + at(i, 0, 2) * FN[2];
    dOf[i] = d;
    ds.push(d);
  }
  if (ds.length < 500) return { error: `only ${ds.length} façade-plane pixels`, diag };
  ds.sort((a, b) => a - b);
  // The FRONT plane is the mode of the top decile — the frame faces and the
  // flat wall are the same plane and they are the majority of what is in front.
  const frontD = ds[Math.floor(ds.length * 0.92)];

  const RECESS_MIN = 0.02; const RECESS_MAX = 0.20; const FLAT_TOL = 0.012;
  const cls = new Int8Array(dumpW * dumpH); // 0 none, 1 front, 2 recess
  for (let i = 0; i < dumpW * dumpH; i++) {
    const d = dOf[i];
    if (!Number.isFinite(d)) continue;
    const back = frontD - d;
    if (Math.abs(back) <= FLAT_TOL) cls[i] = 1;
    else if (back >= RECESS_MIN && back <= RECESS_MAX) cls[i] = 2;
  }

  // Distance (in dump pixels) from every front pixel to the nearest recess —
  // a 2-pass chamfer, which is enough to split "the frame beside the panel"
  // from "the flat wall half a metre away".
  const BIG = 1e6;
  const dist = new Float32Array(dumpW * dumpH).fill(BIG);
  for (let i = 0; i < dist.length; i++) if (cls[i] === 2) dist[i] = 0;
  for (let gy = 0; gy < dumpH; gy++) {
    for (let gx = 0; gx < dumpW; gx++) {
      const i = gy * dumpW + gx;
      let m = dist[i];
      if (gx > 0) m = Math.min(m, dist[i - 1] + 1);
      if (gy > 0) m = Math.min(m, dist[i - dumpW] + 1);
      dist[i] = m;
    }
  }
  for (let gy = dumpH - 1; gy >= 0; gy--) {
    for (let gx = dumpW - 1; gx >= 0; gx--) {
      const i = gy * dumpW + gx;
      let m = dist[i];
      if (gx < dumpW - 1) m = Math.min(m, dist[i + 1] + 1);
      if (gy < dumpH - 1) m = Math.min(m, dist[i + dumpW] + 1);
      dist[i] = m;
    }
  }
  // Metres per dump pixel at the plane — so "0.5 m away" is a world distance,
  // not a screen one. Taken from the world step between two adjacent front
  // pixels in the middle of the frame.
  let mPerPx = 0;
  {
    const samples = [];
    for (let gy = y0; gy < y1 && samples.length < 400; gy += 3) {
      for (let gx = x0; gx < x1 - 1; gx += 3) {
        const i = gy * dumpW + gx; const j = i + 1;
        if (cls[i] !== 1 || cls[j] !== 1) continue;
        samples.push(Math.hypot(at(j, 0, 0) - at(i, 0, 0), at(j, 0, 1) - at(i, 0, 1), at(j, 0, 2) - at(i, 0, 2)));
      }
    }
    samples.sort((a, b) => a - b);
    mPerPx = samples.length ? samples[Math.floor(samples.length / 2)] : 0.002;
  }
  const FRAME_MAX_PX = 12;
  // ⚠ "0.5 m FROM THE NEAREST RECESS" IS NOT ALWAYS REACHABLE, and asserting it
  // emptied the `wall` population outright on the first real run (0 pixels, so
  // every recess÷wall ratio printed "—"). A façade at 2.7 cm per dump pixel is
  // detail all the way across; the flat wall is whatever is FURTHEST from a
  // recess, so the threshold is that population's own upper quartile with a
  // floor, and `wallMinPx` is published so the reader knows how far "away"
  // actually got.
  const frontDists = [];
  for (let i = 0; i < dumpW * dumpH; i++) if (cls[i] === 1 && dist[i] < BIG) frontDists.push(dist[i]);
  frontDists.sort((a, b) => a - b);
  const WALL_MIN_PX = Math.max(FRAME_MAX_PX + 4,
    Math.min(Math.round(0.5 / Math.max(1e-4, mPerPx)),
      frontDists.length ? frontDists[Math.floor(frontDists.length * 0.75)] : 20));

  // ── the populations ──────────────────────────────────────────────────────
  const pop = { recess: [], recessDeep: [], frame: [], wall: [], halo: [], haloRef: [] };
  for (let gy = 0; gy < dumpH; gy++) {
    for (let gx = 0; gx < dumpW; gx++) {
      const i = gy * dumpW + gx;
      if (cls[i] === 2) {
        pop.recess.push(i);
        if (frontD - dOf[i] >= 0.05) pop.recessDeep.push(i);
        continue;
      }
      if (cls[i] !== 1) continue;
      if (dist[i] > 0 && dist[i] <= FRAME_MAX_PX) pop.frame.push(i);
      else if (dist[i] >= WALL_MIN_PX) pop.wall.push(i);
    }
  }

  // ── the halo: a flat surface pixel whose 2-px screen neighbourhood carries a
  // large DEPTH jump (the lamp cable and its like are thin foreground objects,
  // and the half-res AO upsample plus the AO march both see across them).
  // `haloRef` is the SAME surface far from any such jump — the control.
  const jump = new Uint8Array(dumpW * dumpH);
  for (let gy = 1; gy < dumpH - 1; gy++) {
    for (let gx = 1; gx < dumpW - 1; gx++) {
      const i = gy * dumpW + gx;
      if (!(at(i, 0, 3) > 0.5)) continue;
      const n = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
      const P = [at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)];
      let hit = 0;
      for (const j of [i - 1, i + 1, i - dumpW, i + dumpW]) {
        if (!(at(j, 0, 3) > 0.5)) { hit = 1; continue; }
        const dq = Math.abs((at(j, 0, 0) - P[0]) * n[0] + (at(j, 0, 1) - P[1]) * n[1] + (at(j, 0, 2) - P[2]) * n[2]);
        if (dq > 0.25) hit = 1;
      }
      jump[i] = hit;
    }
  }
  const jdist = new Float32Array(dumpW * dumpH).fill(BIG);
  for (let i = 0; i < jdist.length; i++) if (jump[i]) jdist[i] = 0;
  for (let gy = 0; gy < dumpH; gy++) for (let gx = 0; gx < dumpW; gx++) {
    const i = gy * dumpW + gx; let m = jdist[i];
    if (gx > 0) m = Math.min(m, jdist[i - 1] + 1);
    if (gy > 0) m = Math.min(m, jdist[i - dumpW] + 1);
    jdist[i] = m;
  }
  for (let gy = dumpH - 1; gy >= 0; gy--) for (let gx = dumpW - 1; gx >= 0; gx--) {
    const i = gy * dumpW + gx; let m = jdist[i];
    if (gx < dumpW - 1) m = Math.min(m, jdist[i + 1] + 1);
    if (gy < dumpH - 1) m = Math.min(m, jdist[i + dumpW] + 1);
    jdist[i] = m;
  }
  for (let i = 0; i < dumpW * dumpH; i++) {
    if (cls[i] !== 1) continue;
    if (jdist[i] >= 1 && jdist[i] <= 3) pop.halo.push(i);
    else if (jdist[i] > 12) pop.haloRef.push(i);
  }

  // ── the DARKEST pixels in the picture, wherever they are ─────────────────
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const finals = [];
  for (let i = 0; i < dumpW * dumpH; i++) {
    if (!(at(i, 0, 3) > 0.5)) continue;
    finals.push([i, lum(finalAt(i % dumpW, Math.floor(i / dumpW)))]);
  }
  finals.sort((a, b) => a[1] - b[1]);
  const darkest = finals.slice(0, Math.max(1, Math.floor(finals.length * 0.01))).map((e) => e[0]);

  // ⚠ CAPPED, AND EVENLY. Arm 2 has to measure the SAME pixels, so the index
  // lists cross the CDP wire — `wall` alone is tens of thousands of pixels and
  // a megabyte of JSON. An even stride keeps the sample spread over the whole
  // population instead of over its first corner.
  const cap = (a, n = 4000) => {
    if (a.length <= n) return a;
    const step = a.length / n;
    const o = [];
    for (let k = 0; k < n; k++) o.push(a[Math.floor(k * step)]);
    return o;
  };
  const chosen = pick ?? {
    recess: cap(pop.recess), recessDeep: cap(pop.recessDeep),
    frame: cap(pop.frame), wall: cap(pop.wall),
    halo: cap(pop.halo), haloRef: cap(pop.haloRef), darkest: cap(darkest),
  };

  // The front plane's centroid in the middle of the frame — what a straight-on
  // re-placement of the camera aims at (see `refine` in the runner).
  let cSum = [0, 0, 0]; let cN = 0;
  for (let gy = y0; gy < y1; gy++) {
    for (let gx = x0; gx < x1; gx++) {
      const i = gy * dumpW + gx;
      if (cls[i] !== 1) continue;
      for (let c = 0; c < 3; c++) cSum[c] += at(i, 0, c);
      cN++;
    }
  }
  const frontCentroid = cN ? cSum.map((v) => +(v / cN).toFixed(3)) : null;

  // ── the table ────────────────────────────────────────────────────────────
  const stats = (idx) => {
    if (!idx?.length) return null;
    const acc = { alb: [0, 0, 0], irrB: [0, 0, 0], irrA: [0, 0, 0], lit: [0, 0, 0], fin: [0, 0, 0] };
    let aoF = 0; let aoR = 0; let glo = 0; let n = 0; let nAlb = 0; let sh = 0;
    const aoList = []; const finList = []; const irrList = []; const shList = [];
    for (const i of idx) {
      if (!(at(i, 0, 3) > 0.5)) continue;
      const gx = i % dumpW; const gy = Math.floor(i / dumpW);
      const P = [at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)];
      const Nn = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
      const a = albedoAt(P, Nn);
      if (a.albedo) { acc.alb[0] += a.albedo[0]; acc.alb[1] += a.albedo[1]; acc.alb[2] += a.albedo[2]; nAlb++; }
      for (let c = 0; c < 3; c++) {
        acc.irrB[c] += at(i, 2, c);
        acc.irrA[c] += at(i, 3, c);
        acc.lit[c] += at(i, 4, c);
      }
      const f = finalAt(gx, gy);
      for (let c = 0; c < 3; c++) acc.fin[c] += f[c];
      aoF += at(i, 1, 3); aoR += at(i, 2, 3); glo += at(i, 3, 3);
      // The sun shadow is stored one channel per light and this scene has ONE
      // directional light, so channel 0 is the term; -1 means no shadow target.
      sh += at(i, 5, 0);
      aoList.push(at(i, 1, 3)); shList.push(at(i, 5, 0));
      finList.push(lum(f)); irrList.push(lum([at(i, 2, 0), at(i, 2, 1), at(i, 2, 2)]));
      n++;
    }
    if (!n) return null;
    const k = 1 / n;
    const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
    return {
      n,
      albedo: nAlb ? acc.alb.map((v) => v / nAlb) : null, nAlb,
      irrBefore: acc.irrB.map((v) => v * k),
      aoFiltered: aoF * k, aoRaw: aoR * k,
      aoP05: q(aoList, 0.05), aoP50: q(aoList, 0.5),
      sunShadow: sh * k, shP05: q(shList, 0.05), shP50: q(shList, 0.5),
      irrAfter: acc.irrA.map((v) => v * k),
      glossy: glo * k,
      lit: acc.lit.map((v) => v * k),
      final: acc.fin.map((v) => v * k),
      finalP05: q(finList, 0.05), finalP50: q(finList, 0.5),
      irrP05: q(irrList, 0.05), irrP50: q(irrList, 0.5),
    };
  };

  const out = { crops: {}, meta: {} };
  for (const k of Object.keys(chosen)) out.crops[k] = stats(chosen[k]);
  // ⭐ TWO QUESTIONS, TWO POPULATIONS. With a shared pick the table above
  // answers "did the OTHER arm's dark pixels get brighter"; this answers "is
  // this arm's own worst 1 % still dark", which is the question a self-selected
  // population is the right instrument for. Both are printed; neither replaces
  // the other.
  if (pick) {
    out.ownDarkest = stats(cap(darkest));
    out.ownWall = stats(cap(pop.wall));
    let nOther = 0; let nJ = 0;
    for (const i of darkest) {
      if (cls[i] !== 1 && cls[i] !== 2) nOther++;
      if (jdist[i] <= 3) nJ++;
    }
    out.ownDark = {
      n: darkest.length,
      offPlanePct: +(100 * nOther / Math.max(1, darkest.length)).toFixed(1),
      nearJunctionPct: +(100 * nJ / Math.max(1, darkest.length)).toFixed(1),
    };
  }

  // ⭐⭐ WHAT ARE THE BLACK PIXELS, GEOMETRICALLY? "the darkest 1 % reads 1.6 %
  // of the wall" is only an answer to the user's report if those pixels are AT
  // THE JUNCTIONS — a door panel inside its frame, a frame recess, the foot of
  // a planter. If they are instead scattered non-planar texels (glass, the
  // interior behind it, a dark material), the screenshot's black spots are the
  // scene's own materials and no GI stage owns them. The classifier is already
  // built; this only counts it over the population that matters.
  {
    const idx = chosen.darkest ?? [];
    let nRecess = 0; let nFront = 0; let nOther = 0; let nJunction = 0; let nFlat = 0;
    let depth = 0; let nDepth = 0; let nUp = 0;
    for (const i of idx) {
      if (cls[i] === 2) { nRecess++; depth += frontD - dOf[i]; nDepth++; } else if (cls[i] === 1) nFront++;
      else nOther++;
      if (jdist[i] <= 3) nJunction++; else nFlat++;
      if (at(i, 1, 1) > 0.7) nUp++;
    }
    out.dark = {
      n: idx.length,
      recessPct: idx.length ? +(100 * nRecess / idx.length).toFixed(1) : null,
      frontPct: idx.length ? +(100 * nFront / idx.length).toFixed(1) : null,
      offPlanePct: idx.length ? +(100 * nOther / idx.length).toFixed(1) : null,
      nearJunctionPct: idx.length ? +(100 * nJunction / idx.length).toFixed(1) : null,
      upFacingPct: idx.length ? +(100 * nUp / idx.length).toFixed(1) : null,
      meanRecessDepthCm: nDepth ? +(100 * depth / nDepth).toFixed(1) : null,
    };
    // The same three shares over the WHOLE valid frame — a share means nothing
    // without the base rate it is being compared against.
    let bR = 0; let bF = 0; let bO = 0; let bJ = 0; let bAll = 0;
    for (let i = 0; i < dumpW * dumpH; i++) {
      if (!(at(i, 0, 3) > 0.5)) continue;
      bAll++;
      if (cls[i] === 2) bR++; else if (cls[i] === 1) bF++; else bO++;
      if (jdist[i] <= 3) bJ++;
    }
    out.dark.base = {
      recessPct: +(100 * bR / bAll).toFixed(1),
      frontPct: +(100 * bF / bAll).toFixed(1),
      offPlanePct: +(100 * bO / bAll).toFixed(1),
      nearJunctionPct: +(100 * bJ / bAll).toFixed(1),
    };
  }
  out.meta = {
    diag,
    dumpW, dumpH, stride, width, height, hasAo, aoWidth, aoHeight,
    hasShadow, shadowSize: [dump.shadowWidth, dump.shadowHeight], shadowName: dump.shadowName,
    canvas: [canvasLum.w, canvasLum.h],
    facadeNormal: FN.map((v) => +v.toFixed(3)),
    frontCentroid,
    frontD: +frontD.toFixed(3),
    mPerPx: +mPerPx.toFixed(5),
    wallMinPx: WALL_MIN_PX,
    counts: Object.fromEntries(Object.entries(pop).map(([k, v]) => [k, v.length])),
    darkestPx: darkest.length,
    aoConfig: {
      cfgAo: sys?.config?.ao ?? null,
      strength: screen?.ao?.strength?.value ?? null,
      radius: screen?.ao?.radius?.value ?? null,
      derivedRadius: screen?.ao?.derivedRadius ?? null,
      aoPass: !!screen?.aoPass,
      aoTarget: screen?.aoPass?.target?.name ?? null,
      aoSize: screen?.aoPass ? [screen.aoPass.width, screen.aoPass.height] : null,
      aoOut: gi2.textures.irradiance?.name ?? null,
    },
    quality: sys?.config?.quality ?? null,
  };
  if (!pick) out.pick = chosen;
  return out;
}, { pick });

const pose = POSE_ENV
  ? (() => {
    const [e, t] = POSE_ENV.split("|").map((v) => v.split(",").map(Number));
    return { name: "doors PINNED", position: e, target: t, ground: t[1] - 1.15, pinned: true };
  })()
  : await doorsPose();
if (!pose) { console.log("FATAL: no FrontBanner — cannot derive the doors pose"); await browser.close(); process.exit(1); }
console.log(`  coarse pose ${pose.name}  eye ${pose.position.map((v) => v.toFixed(2))} → ${pose.target.map((v) => v.toFixed(2))}`);
await call("viewport.setCamera", { position: pose.position, target: pose.target });
await settleFrames(60);

// ⭐ THE STRAIGHT-ON RE-PLACEMENT. The ring only says which way is OPEN; the
// coarse pose put the camera 25° off the façade, and a plane read obliquely
// hides half of every recess behind its own frame. So the façade's normal and
// the front plane's centroid come out of the DUMP, and the camera is put back
// on that normal at eye height — "2 m in front of the doors, looking at the
// doors" as a measured fact rather than a hope about a banner's bounding box.
if (!pose.pinned) {
  const probeMeta = (await readFrame(null))?.meta;
  const FN = probeMeta?.facadeNormal;
  const C = probeMeta?.frontCentroid;
  if (FN && C) {
    const cam = pose.position;
    const s = Math.sign((cam[0] - C[0]) * FN[0] + (cam[1] - C[1]) * FN[1] + (cam[2] - C[2]) * FN[2]) || 1;
    const N = FN.map((v) => v * s);
    // ⚠ DOOR HEIGHT, NOT THE COARSE POSE'S. The first refinement inherited the
    // winning coarse candidate's target — which was §3.7's façade-wide pose,
    // aimed 2.2 m up — so the "doors" crops were taken from the storey ABOVE
    // the doors. The height comes from the street mesh, like the pose does.
    const doorY = pose.ground + 1.15;
    const eyeY = pose.ground + 1.6;
    for (const d of [2.0, 2.4, 2.8, 3.2, 4.0]) {
      const p = [C[0] + N[0] * d, eyeY, C[2] + N[2] * d];
      const t = [C[0], doorY, C[2]];
      await call("viewport.setCamera", { position: p, target: t });
      await settleFrames(30, 25000);
      const q = await quickLook();
      console.log(`    straight-on ${d.toFixed(1)}m valid ${q.valid}/${q.of} detail ` +
        `${q.valid ? ((100 * q.edge) / q.valid).toFixed(0) : "—"}% near<6m ${q.near}`);
      if (q.valid > 0.5 * q.of) { pose.position = p; pose.target = t; pose.name = `doors straight-on ${d}m`; break; }
    }
  }
}
console.log(`  POSE ${pose.name}  eye ${pose.position.map((v) => v.toFixed(2))} → ${pose.target.map((v) => v.toFixed(2))}`);
await call("viewport.setCamera", { position: pose.position, target: pose.target });
await settleFrames(FRAMES);

const fmt3 = (a) => (a ? `[${a.map((v) => v.toFixed(4)).join(" ")}]` : "—");
const lum = (a) => (a ? 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2] : null);
const show = (tag, r) => {
  if (!r || r.error) {
    console.log(`  ${tag}: ${r?.error ?? "no result"}`);
    if (r?.diag) console.log(`     diag ${JSON.stringify(r.diag)}`);
    return;
  }
  const m = r.meta;
  console.log(`\n  ── ${tag} ──`);
  console.log(`     diag ${JSON.stringify(m.diag)}`);
  console.log(`     façade n ${JSON.stringify(m.facadeNormal)} frontD ${m.frontD}  ${m.mPerPx * 100} cm/dump-px  ` +
    `resolve ${m.width}x${m.height} canvas ${m.canvas.join("x")}  quality ${m.quality}`);
  console.log(`     AO: cfg.ao ${m.aoConfig.cfgAo}  pass ${m.aoConfig.aoPass} ${JSON.stringify(m.aoConfig.aoSize)} ` +
    `target ${m.aoConfig.aoTarget} radius ${m.aoConfig.radius ?? m.aoConfig.derivedRadius} strength ${m.aoConfig.strength} ` +
    `→ materials sample ${m.aoConfig.aoOut}`);
  console.log(`     populations ${JSON.stringify(m.counts)}  darkest1% ${m.darkestPx}px  wallMinPx ${m.wallMinPx}`);
  console.log(`     shadow target ${m.shadowName ?? "NONE"} ${JSON.stringify(m.shadowSize)}`);
  if (r.dark) {
    console.log(`     WHAT IS BLACK (darkest 1%, n ${r.dark.n}): recess ${r.dark.recessPct}% (base ${r.dark.base.recessPct}%)  ` +
      `front-plane ${r.dark.frontPct}% (base ${r.dark.base.frontPct}%)  off-plane ${r.dark.offPlanePct}% (base ${r.dark.base.offPlanePct}%)  ` +
      `within 3px of a depth jump ${r.dark.nearJunctionPct}% (base ${r.dark.base.nearJunctionPct}%)  ` +
      `up-facing ${r.dark.upFacingPct}%  mean recess depth ${r.dark.meanRecessDepthCm ?? "—"} cm`);
  }
  console.log(`     crop        n     albedo(lum)  irrBefore(lum)   AOfilt AOraw   SUNsh  irrAfter(lum)  lit(lum)   final(lum)  final/irrA`);
  for (const [k, c] of Object.entries(r.crops)) {
    if (!c) { console.log(`     ${k.padEnd(9)}  —`); continue; }
    console.log(`     ${k.padEnd(9)} ${String(c.n).padStart(6)}  ` +
      `${(lum(c.albedo) ?? NaN).toFixed(4).padStart(8)}  ` +
      `${(lum(c.irrBefore)).toFixed(4).padStart(10)}  ` +
      `${c.aoFiltered.toFixed(3).padStart(6)} ${c.aoRaw.toFixed(3).padStart(5)} ` +
      `${c.sunShadow.toFixed(3).padStart(6)}  ` +
      `${(lum(c.irrAfter)).toFixed(4).padStart(10)}  ` +
      `${(lum(c.lit)).toFixed(4).padStart(8)}  ` +
      `${(lum(c.final)).toFixed(4).padStart(8)}  ` +
      `${(lum(c.final) / Math.max(1e-9, lum(c.irrAfter))).toFixed(4).padStart(9)}`);
  }
  for (const [k, c] of Object.entries(r.crops)) {
    if (!c) continue;
    console.log(`       ${k.padEnd(9)} rgb  alb ${fmt3(c.albedo)} irrB ${fmt3(c.irrBefore)} irrA ${fmt3(c.irrAfter)} ` +
      `lit ${fmt3(c.lit)} fin ${fmt3(c.final)}  aoP05 ${c.aoP05?.toFixed(3)} aoP50 ${c.aoP50?.toFixed(3)} ` +
      `shP05 ${c.shP05?.toFixed(3)} shP50 ${c.shP50?.toFixed(3)} ` +
      `finP05 ${c.finalP05?.toFixed(4)} irrP05 ${c.irrP05?.toFixed(4)}`);
  }
  const R = (a, b) => (a != null && b ? `${((100 * a) / b).toFixed(1)}%`.padStart(7) : "      —");
  const c = r.crops;
  const ratio = (aK, bK) => {
    const A = c[aK]; const B = c[bK];
    if (!A || !B) { console.log(`     RATIOS ${`${aK}÷${bK}`.padEnd(20)} —`); return; }
    console.log(`     RATIOS ${`${aK}÷${bK}`.padEnd(20)} alb ${R(lum(A.albedo), lum(B.albedo))}  ` +
      `irrBefore ${R(lum(A.irrBefore), lum(B.irrBefore))}  AO ${R(A.aoFiltered, B.aoFiltered)}  ` +
      `SUNsh ${R(A.sunShadow, B.sunShadow)}  ` +
      `irrAfter ${R(lum(A.irrAfter), lum(B.irrAfter))}  lit ${R(lum(A.lit), lum(B.lit))}  ` +
      `final ${R(lum(A.final), lum(B.final))}  ` +
      `f/irr ${R(lum(A.final) / Math.max(1e-9, lum(A.irrAfter)), lum(B.final) / Math.max(1e-9, lum(B.irrAfter)))}`);
  };
  for (const a of ["recess", "recessDeep", "darkest"]) { ratio(a, "frame"); ratio(a, "wall"); }
  if (r.ownDarkest && r.ownWall) {
    const A = r.ownDarkest; const B = r.ownWall;
    console.log(`     RATIOS ownDarkest÷ownWall (this arm's OWN worst 1 %, n ${A.n}): ` +
      `irrBefore ${R(lum(A.irrBefore), lum(B.irrBefore))}  final ${R(lum(A.final), lum(B.final))}  ` +
      `| off-plane ${r.ownDark.offPlanePct} %  within 3px of a depth jump ${r.ownDark.nearJunctionPct} %`);
  }
  ratio("frame", "wall");
  ratio("halo", "haloRef");
};

// ── ARM 1: the scene exactly as authored ────────────────────────────────────
const entities = (await call("entity.list", {})).value ?? [];
const giEntity = entities.find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
const authoredAo = await page.evaluate(() => globalThis.__giSys()?.config?.ao ?? null);
console.log(`  GI entity ${giEntity?.name ?? "NONE"} (${giEntity?.id ?? "—"})   config.ao as opened = ${authoredAo}`);

const loadedPick = PICK_IN ? JSON.parse(readFileSync(PICK_IN, "utf8")) : null;
if (loadedPick) console.log(`  pick loaded from ${PICK_IN} — measuring the OTHER arm's pixels ` +
  `(${Object.entries(loadedPick).map(([k, v]) => `${k} ${v.length}`).join(", ")})`);
const first = await readFrame(loadedPick);
show(`ARM ao=${authoredAo} (AS AUTHORED)${loadedPick ? " — SHARED PICK" : ""}`, first);
const pick = loadedPick ?? first?.pick ?? null;
if (PICK_OUT && first?.pick) {
  writeFileSync(PICK_OUT, JSON.stringify(first.pick));
  console.log(`  pick written to ${PICK_OUT}`);
}

// ── §19 3.13: WHY are these pixels dark on the world path? ──────────────────
//
// The lattice can only fail a pixel in one of two ways — no live probe in the
// eight cells around it, or every one of them refused by the face gate — and
// those have different fixes. So the same picked pixels are asked, on the CPU,
// through the SAME addressing the resolve uses.
if (pick?.darkest) {
  const lat = await page.evaluate(async ({ idx }) => {
    const eng = globalThis.__giEngineForProbe;
    const gi2 = globalThis.__gi2();
    const g = gi2?.gather;
    if (!g?.worldProbes || !g.world) return { skip: "not a world-probe build" };
    const w = g.world.describe();
    const { createGi2StageDump } = await import("/scripts/lib/gi2StageProbe.js");
    const dump = createGi2StageDump({ renderer: eng.renderer, gi2, screen: globalThis.__giSys().state.screen, stride: 2 });
    const D = await dump.read();
    const V = 6;
    const at = (i, v, c) => D[(i * V + v) * 4 + c];
    const info = new Float32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpInfo.value));
    const list = new Uint32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpList.value));
    // ⭐ §19 3.14 — THE SAME QUESTION, ONCE PER CASCADE. "No live corner" is
    // only a fault if NO cascade had one: the resolve composites finest-first,
    // and a pixel c0 cannot reach is c1's or c2's — which is this stage's whole
    // claim. So the walk reports per cascade AND the combined "reached by
    // nothing", which is the number the thin-feature gate actually rests on.
    const NC = w.cascades ?? 1;
    const C = w.cells; const CB = Math.log2(C); const CELLS = w.cellCount;
    const LW = 2 * CELLS + w.blocks + 8;
    const SPS = w.spacings ?? [w.spacing];
    const origins = Array.from({ length: NC }, (_, c) => (g.uniforms[`wpOrigin${c}`] ?? g.uniforms.wpOrigin).value);
    const per = Array.from({ length: NC }, () => ({ noCorner: 0, faceOnly: 0, sumAlive: 0, sumAdm: 0 }));
    let n = 0; let noneAnywhere = 0;
    const depths = [];
    for (const i of idx) {
      if (!(at(i, 0, 3) > 0.5)) continue;
      const P = [at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)];
      const N = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
      let anyAlive = 0;
      for (let cc = 0; cc < NC; cc++) {
        const SP = SPS[cc];
        const o = origins[cc];
        const bias = g.uniforms.wpBias.value * SP;
        const Pb = P.map((v, k) => v + N[k] * bias);
        const base = Pb.map((v) => Math.floor(v / SP - 0.5));
        let alive = 0; let adm = 0;
        for (let c = 0; c < 8; c++) {
          const wc = [base[0] + (c & 1), base[1] + ((c >> 1) & 1), base[2] + ((c >> 2) & 1)];
          const rel = [wc[0] - o.x, wc[1] - o.y, wc[2] - o.z];
          if (rel.some((v) => v < 0 || v >= C)) continue;
          const cell = cc * CELLS
            + ((wc[0] & (C - 1)) | ((wc[1] & (C - 1)) << CB) | ((wc[2] & (C - 1)) << (2 * CB)));
          const st = info[(cell * 3 + 0) * 4 + 3];
          const rdy = info[(cell * 3 + 2) * 4 + 3];
          if (!(st > 0.5) || !(rdy > 0.5)) continue;
          alive++;
          const fN = [info[(cell * 3 + 1) * 4], info[(cell * 3 + 1) * 4 + 1], info[(cell * 3 + 1) * 4 + 2]];
          const wf = st > 1.5 ? Math.max(0, N[0] * fN[0] + N[1] * fN[1] + N[2] * fN[2]) : 1;
          if (wf > 0) adm++;
        }
        per[cc].sumAlive += alive; per[cc].sumAdm += adm;
        if (alive === 0) per[cc].noCorner++; else if (adm === 0) per[cc].faceOnly++;
        anyAlive += alive;
      }
      n++;
      if (anyAlive === 0) noneAnywhere++;
      depths.push(Math.hypot(P[0] - eng.camera.position.x, P[1] - eng.camera.position.y, P[2] - eng.camera.position.z));
    }
    depths.sort((a, b) => a - b);
    const pct = (v) => +(100 * v / Math.max(1, n)).toFixed(1);
    return {
      n, cascades: NC, extents: w.extents ?? [w.extent], slots: w.slots ?? [w.traceSlots],
      live: Array.from({ length: NC }, (_, c) => list[c * LW + 2 * CELLS + w.blocks]),
      cells: CELLS,
      noneAnywherePct: pct(noneAnywhere),
      arms: per.map((p) => ({
        noCornerPct: pct(p.noCorner), faceRejectPct: pct(p.faceOnly),
        meanAlive: +(p.sumAlive / Math.max(1, n)).toFixed(2),
        meanAdmissible: +(p.sumAdm / Math.max(1, n)).toFixed(2),
      })),
      depthP50: +(depths[Math.floor(depths.length / 2)] ?? 0).toFixed(2),
      depthP95: +(depths[Math.floor(depths.length * 0.95)] ?? 0).toFixed(2),
    };
  }, { idx: pick.darkest });
  if (lat?.skip) console.log(`  lattice diagnostic: ${lat.skip}`);
  else if (lat) {
    console.log(`  LATTICE at the darkest pixels (n ${lat.n}): ${lat.cascades} cascade(s); ` +
      `pixel distance p50 ${lat.depthP50} m p95 ${lat.depthP95} m; ` +
      `NO live corner in ANY cascade: ${lat.noneAnywherePct} %`);
    for (let c = 0; c < lat.cascades; c++) {
      const a = lat.arms[c];
      console.log(`    c${c} (${lat.extents[c]} m, ${lat.slots[c]} slots/frame): live ${lat.live[c]}/${lat.cells}; ` +
        `of the 8 corners ${a.meanAlive} alive / ${a.meanAdmissible} admissible; ` +
        `${a.noCornerPct} % no live corner, ${a.faceRejectPct} % all face-rejected`);
    }
  }
}

// ── ARM 2: flip `ao`. STRUCTURAL — it rebuilds the whole GI chain ───────────
if (AO_ARMS === "both" && giEntity && pick) {
  const want = !(authoredAo !== false);
  console.log(`\n  flipping component ao → ${want} (structural: full GI rebuild) …`);
  const r = await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: "ao", value: want });
  if (!r.ok) console.log(`    setProp failed: ${r.error}`);
  await wait(6000);
  await settleFrames(FRAMES);
  const nowAo = await page.evaluate(() => globalThis.__giSys()?.config?.ao ?? null);
  show(`ARM ao=${nowAo} (FLIPPED)`, await readFrame(pick));
}

await browser.close();
