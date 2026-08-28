// GI2 FLOOD PROBE — §19 Stage 4.3: WHICH TERM FLOODS THE WORLD PATH?
//
// ══ THE REPORT ═══════════════════════════════════════════════════════════════
//
// With `__gi2WorldProbes` on, Bistro's whole street reads RED (the "Le Petit
// Coin" neon, palette emissive class #59 = 10,0,0) or GREEN (emitter seats 2/3)
// — pavement, walls and chairs alike — while the screen path at the same pose
// shows normal colours. Orders of magnitude, not a tint.
//
// ══ THE METHOD — [[gi-colour-probe-method]] ══════════════════════════════════
//
// Read back ONE world probe's per-term contributions and find the FIRST term
// that is 100× the others. The split is exact rather than argued, because the
// two halves of a world probe's SH are written by two kernels in the same
// frame, in this order:
//
//     shPass    ASSIGNS  SH  =  Σ over the 64 oct texels of L·Δω·Y(d)
//     neePass   ADDS     SH +=  Σ over the emitter slots of rgb·Ω·vis·Y(wd)
//
// So re-running `shPass`'s projection ON THE CPU, out of the same `wpOct` the
// GPU read, gives the TRANSPORT term alone; subtracting it from the stored
// `wpInfo` SH gives the NEE term alone, WITH its visibility already applied.
// Recomputing `rgb·Ω` per slot on the CPU gives the same term UNOCCLUDED, and
// the ratio of the two is the shadow rays' effective visibility — which is the
// second question the flood raises (does emitter light pass walls here?).
//
// ⚠ THE PROBE IS SAMPLED, THE CONCLUSION IS A DISTRIBUTION. One probe can be
// unlucky; the receipt is the median share of the field each term carries over
// every live probe of every cascade, plus the worst offenders by name.
//
// ══ AND THE PAVEMENT, WHICH IS WHAT THE USER SAW ═════════════════════════════
//
// The same run also reports the pavement's own colour out of the gather's stage
// dump — mean irradiance, luminance and CHROMA (|R−G|/(R+G)) — so the fix has a
// receipt in the units of the complaint. Chroma, not hue: a flood is a channel
// imbalance and a mean can hide one.
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//
// Run:
//   OUT=/tmp/flood-screen.json node scripts/run-gi2-flood-probe.mjs
//   REF=/tmp/flood-screen.json FLAGS='{"__gi2WorldProbes":true}' \
//     node scripts/run-gi2-flood-probe.mjs
//
// Env: PROJECT · SCENE=Bistro · SETTLE=14 · FRAMES=240 · POSE · FLAGS · OUT ·
//      REF · PROBES=400 · HEADED=1
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { reportEmitterSeats } from "./lib/gi2EmitterWait.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 14);
const FRAMES = Number(process.env.FRAMES ?? 240);
const PROBES = Number(process.env.PROBES ?? 400);
const OUT = process.env.OUT ?? "";
const REF = process.env.REF ?? "";
const POSE_ENV = process.env.POSE ?? "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const chroma = (c) => Math.abs(c[0] - c[1]) / Math.max(1e-6, c[0] + c[1]);
const rgb2 = (a) => (a ? `[${a.map((v) => f(v, 3)).join(", ")}]` : "null");
const quant = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
const f = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : "—");

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
await page.evaluateOnNewDocument(() => { globalThis.__gi2NoiseDump = true; });
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
  if (/\[gi2\] (soup|first)|\[gi\] built|light tree|emitter (seats|delivery|SPLIT)|sparse/i.test(t)) {
    console.log(`    ${t.slice(0, 240)}`);
  }
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
  let fr = f0;
  while (fr - f0 < n && Date.now() < deadline) { await wait(400); fr = await gatherFrame(); }
  return fr - f0;
};

console.log(`\n══ ${SCENE} — the flood ══════════════════════════════════════`);
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

// ── THE POSE ────────────────────────────────────────────────────────────────
// `run-gi2-farfield-probe`'s street overview, verbatim, and pinned by a
// reference file so the two arms measure the same street.
const refData = REF ? JSON.parse(readFileSync(REF, "utf8")) : null;
async function streetPose() {
  if (POSE_ENV) {
    const [e, a] = POSE_ENV.split("|").map((s) => s.split(",").map(Number));
    return { position: e, target: a, source: "POSE env" };
  }
  if (refData?.pose) return { ...refData.pose, source: `pinned by ${REF}` };
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
  const eye = ground + 1.65;
  await call("viewport.setCamera", { position: [B[0], eye, B[2]], target: [B[0] + 4, eye, B[2]] });
  await settleFrames(90, 30000);
  const ring = await page.evaluate(async ({ o }) => {
    const eng = globalThis.__giEngineForProbe;
    const gi2 = globalThis.__gi2();
    if (!gi2?.trace || !eng?.renderer) return null;
    const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
    const shoot = createGi2RayShooter(gi2, eng.renderer);
    const dirs = [];
    for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; dirs.push([Math.cos(a), 0, Math.sin(a)]); }
    const rays = dirs.map((d) => ({ o, d, tMax: 30 }));
    await shoot(rays);
    const out = await shoot(rays);
    return dirs.map((d, i) => ({ d, t: out[i].hit ? out[i].t : 30 }));
  }, { o: [B[0], eye, B[2]] });
  if (!ring) return null;
  const D = ring.reduce((a, b) => (b.t > a.t ? b : a)).d;
  const at = (k, y) => [B[0] + D[0] * k, y, B[2] + D[2] * k];
  return { position: at(22.0, ground + 4), target: at(2.0, ground + 3), source: "derived" };
}
const pose = await streetPose();
if (!pose) { console.log("FATAL: no street pose"); await browser.close(); process.exit(1); }
console.log(`  street-overview (${pose.source}): eye [${pose.position.map((v) => v.toFixed(2))}] ` +
  `→ [${pose.target.map((v) => v.toFixed(2))}]`);
await call("viewport.setCamera", { position: pose.position, target: pose.target });
await settleFrames(FRAMES);

// ── 1. THE SEATS, AS THE SHADERS SEE THEM ───────────────────────────────────
const slots = await page.evaluate(() => {
  const st = globalThis.__giSys()?.state;
  return (st?.emitterSlots ?? []).map((s, i) => ({
    i,
    center: [s.center.value.x, s.center.value.y, s.center.value.z],
    color: [s.color.value.r, s.color.value.g, s.color.value.b],
    radius: s.radius.value, reff: s.reff.value, kind: s.kind?.value ?? 0,
  }));
});
// ⭐ §18.15's DAMPING, AS IT ACTUALLY STANDS. A seat is fitted to the WHOLE
// mesh, so a mesh holding several separate emissive pieces gets one sphere with
// 1/fill too much projected area — and the correction is `_emitterFillByMesh`,
// which `#refreshEmitterSlots` reads with a `?? 1` DEFAULT. An empty map is
// therefore indistinguishable from "nothing needed damping", which is exactly
// the shape of a correction that has gone silently inert.
const fills = await page.evaluate(async () => {
  const cfg = await import("/src/modules/gi/giConfig.js");
  const sys = globalThis.__giSys();
  const byMesh = sys?._emitterFillByMesh ?? null;
  const infos = sys?._emitterInfos ?? [];
  const seatRows = infos.map((inf, i) => {
    const m = inf?.mesh;
    const g = m?.geometry;
    if (g && !g.boundingBox) g.computeBoundingBox();
    const bb = g?.boundingBox;
    return {
      i, mesh: m?.name ?? (inf?.provider ? "(provider)" : "-"),
      rgb: inf ? [inf.r ?? 0, inf.g ?? 0, inf.b ?? 0] : null,
      tris: g ? (g.index?.count ?? g.attributes?.position?.count ?? 0) / 3 : 0,
      localSize: bb ? [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z] : null,
      fill: m && byMesh ? (byMesh.get(m) ?? null) : null,
    };
  });
  const all = byMesh ? [...byMesh.values()] : [];
  return {
    mapSize: byMesh?.size ?? -1, seatRows,
    fillMin: all.length ? Math.min(...all) : null,
    fillP50: all.length ? all.slice().sort((a, b) => a - b)[Math.floor(all.length / 2)] : null,
    under: all.filter((v) => v < 0.999).length,
    treeCands: sys?._emitterCands?.length ?? 0,
    gi2Path: cfg.GI2_PATH, treeFlag: globalThis.__giLightTree,
    treeLive: !!globalThis.__giLightTreeLive,
    hasRegion: !!sys?._lightTreeRegion, hasUploader: !!sys?._lightTreeUploader,
    admitted: sys?._emitterAdmittedMeshes?.size ?? -1,
    candidates: sys?._emitterCandidateMeshes?.size ?? -1,
  };
});
console.log(`\n  18.15 seat fill: map size ${fills.mapSize}  under-1 entries ${fills.under}  ` +
  `min ${f(fills.fillMin ?? NaN, 5)}  p50 ${f(fills.fillP50 ?? NaN, 4)}   ` +
  `tree candidates ${fills.candidates} -> admitted ${fills.admitted}   seat cands ${fills.treeCands}`);
console.log(`    GI2_PATH ${fills.gi2Path}  __giLightTree ${fills.treeFlag}  treeLive ${fills.treeLive}  ` +
  `region ${fills.hasRegion}  uploader ${fills.hasUploader}`);
for (const r of fills.seatRows) {
  console.log(`    seat ${r.i} "${(r.mesh ?? "").slice(0, 30)}"  info rgb ${rgb2(r.rgb)}  ` +
    `tris ${r.tris}  local size ${r.localSize ? r.localSize.map((v) => f(v, 2)).join("x") : "-"}  ` +
    `FILL ${r.fill === null ? "MISSING -> x1" : f(r.fill, 5)}`);
}

console.log(`\n  emitter seats (${slots.length}):`);
for (const s of slots) {
  const act = s.radius > 1e-5 && s.color[0] + s.color[1] + s.color[2] > 1e-6;
  console.log(`    ${s.i}  ${act ? "ACTIVE" : "  off "}  rgb [${s.color.map((v) => f(v, 4))}]  ` +
    `reff ${f(s.reff, 3)}  radius ${f(s.radius, 3)}  centre [${s.center.map((v) => v.toFixed(1))}]  ` +
    `Lmax·Ωmax ${f(Math.max(...s.color) * Math.PI, 4)}`);
}

// ── 2. THE PICTURE — pavement and façades, in the units of the complaint ────
const shot = await page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  const { createGi2StageDump } = await import("/scripts/lib/gi2StageProbe.js");
  const dump = createGi2StageDump({
    renderer: eng.renderer, gi2, screen: globalThis.__giSys().state.screen, stride: 2,
  });
  const D = await dump.read();
  const V = 6;
  const at = (i, v, c) => D[(i * V + v) * 4 + c];
  const cam = [eng.camera.position.x, eng.camera.position.y, eng.camera.position.z];
  const n = D.length / (V * 4);
  const pave = []; const facade = [];
  for (let i = 0; i < n; i++) {
    if (!(at(i, 0, 3) > 0.5)) continue;
    const P = [at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)];
    const ny = at(i, 1, 1);
    const d = Math.hypot(P[0] - cam[0], P[1] - cam[1], P[2] - cam[2]);
    const E = [at(i, 2, 0), at(i, 2, 1), at(i, 2, 2)];
    const N = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
    const row = { i, d: +d.toFixed(2), E, P, N };
    if (ny > 0.8) pave.push(row); else if (Math.abs(ny) <= 0.5) facade.push(row);
  }
  const g = gi2?.gather;
  return {
    pave, facade, cam, total: n,
    worldProbes: !!g?.worldProbes,
    world: g?.world?.describe?.() ?? null,
  };
});

// ⭐ THE SEATS' OWN SHARE OF EVERY MEASURED PIXEL, ANALYTICALLY.
//
// The seat NEE is `rgb · min(pi, pi·reff²/d²) · max(0, n·wd) · vis`, and every
// term but `vis` is knowable on the CPU from the slot uniforms. So the same
// pixels the dump measured are asked what the seats could deliver to them at
// vis = 1 — an UPPER BOUND, but an exact one, and if the upper bound is already
// a fraction of a per cent then the seats cannot be the flood, while if it is a
// multiple of the measured irradiance they are the only candidate left.
const seatShare = (rows, cam) => {
  if (!rows.length || !slots.length) return null;
  let sum = [0, 0, 0]; let meas = [0, 0, 0]; let n = 0;
  const worst = [];
  for (const r of rows) {
    const P = r.P ?? null;
    if (!P) continue;
    const N = r.N;
    const E = [0, 0, 0];
    for (const s of slots) {
      if (!(s.radius > 1e-5) || s.color[0] + s.color[1] + s.color[2] <= 1e-6) continue;
      const wv = [s.center[0] - P[0], s.center[1] - P[1], s.center[2] - P[2]];
      const d2 = Math.max(1e-4, wv[0] * wv[0] + wv[1] * wv[1] + wv[2] * wv[2]);
      const d = Math.sqrt(d2);
      const cos = Math.max(0, (wv[0] * N[0] + wv[1] * N[1] + wv[2] * N[2]) / d);
      if (cos <= 1e-3) continue;
      const reff = Math.max(1e-3, s.reff);
      const om = Math.min(Math.PI, Math.PI * reff * reff / d2);
      for (let k = 0; k < 3; k++) E[k] += s.color[k] * om * cos;
    }
    for (let k = 0; k < 3; k++) { sum[k] += E[k]; meas[k] += r.E[k]; }
    n++;
    worst.push({ d: r.d, E, m: r.E });
  }
  if (!n) return null;
  worst.sort((a, b) => lum(b.E) - lum(a.E));
  return {
    n, seat: sum.map((v) => v / n), measured: meas.map((v) => v / n),
    worst: worst.slice(0, 3),
  };
};
const popStats = (rows, label) => {
  if (!rows.length) { console.log(`    ${label}: none`); return null; }
  const mean = [0, 1, 2].map((c) => rows.reduce((a, r) => a + r.E[c], 0) / rows.length);
  const Ls = rows.map((r) => lum(r.E)).sort((a, b) => a - b);
  const Cs = rows.map((r) => chroma(r.E)).sort((a, b) => a - b);
  console.log(`    ${label}: n ${rows.length}  mean rgb [${mean.map((v) => f(v, 4))}]  ` +
    `lum p50 ${f(quant(Ls, 0.5))}  mean lum ${f(Ls.reduce((a, b) => a + b, 0) / Ls.length)}  ` +
    `chroma(mean) ${f(chroma(mean), 4)}  chroma p50 ${f(quant(Cs, 0.5), 4)}`);
  return { n: rows.length, mean, lum: Ls.reduce((a, b) => a + b, 0) / Ls.length, chroma: chroma(mean) };
};
console.log(`\n  path: ${shot.worldProbes ? "WORLD CASCADES" : "screen probes"}` +
  (shot.world ? ` (${shot.world.cascades} × ${shot.world.cells}³, extents ${shot.world.extents.join("/")} m)` : ""));
const paveStat = popStats(shot.pave, "pavement (n.y > 0.8)");
const facStat = popStats(shot.facade, "façades  (|n.y| ≤ 0.5)");
for (const [label, rows] of [["pavement", shot.pave], ["façades ", shot.facade]]) {
  const sh = seatShare(rows, shot.cam);
  if (!sh) continue;
  console.log(`    seat NEE upper bound on the ${label}: rgb [${sh.seat.map((v) => f(v, 4))}]  ` +
    `lum ${f(lum(sh.seat))}  chroma ${f(chroma(sh.seat), 3)}   ` +
    `= ${f(100 * lum(sh.seat) / Math.max(1e-6, lum(sh.measured)), 1)} % of the measured ` +
    `[${sh.measured.map((v) => f(v, 4))}]`);
  for (const w of sh.worst) {
    console.log(`      worst-lit sample ${f(w.d, 1)} m: seat ${rgb2(w.E)} vs measured ${rgb2(w.m)}`);
  }
}

// ── 3. THE PER-TERM READBACK — transport vs NEE, at every live probe ────────
let terms = null;
if (shot.worldProbes) {
  terms = await page.evaluate(async ({ slots, maxProbes }) => {
    const eng = globalThis.__giEngineForProbe;
    const g = globalThis.__gi2().gather;
    const w = g.world.describe();
    const { octTable } = await import("/src/modules/gi/window/gatherProbes.js");
    const OCTR = w.oct; const OCT = OCTR * OCTR;
    const tbl = octTable(OCTR).map((v) => [v.x, v.y, v.z, v.w]);
    const OW = w.octWords;
    const NC = w.cascades; const C = w.cells; const CB = Math.log2(C); const CELLS = w.cellCount;
    const LW = 2 * CELLS + w.blocks + 8;
    const INFO_VEC = 12;
    const info = new Float32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpInfo.value));
    const oct = new Uint32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpOct.value));
    const list = new Uint32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpList.value));
    const decode = (word) => {
      const e = (word >>> 24) - 128;
      const s = Math.pow(2, e) / 255;
      return [(word & 255) * s, ((word >>> 8) & 255) * s, ((word >>> 16) & 255) * s];
    };
    const nOf = (word) => (word >>> 24) & 63;
    const Y = (d) => [
      0.282095,
      0.488603 * d[1], 0.488603 * d[2], 0.488603 * d[0],
      1.092548 * d[0] * d[1], 1.092548 * d[1] * d[2],
      0.315392 * (3 * d[2] * d[2] - 1), 1.092548 * d[0] * d[2],
      0.546274 * (d[0] * d[0] - d[1] * d[1]),
    ];
    const shEval = (L, n) => {
      const c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
      const out = [];
      for (let k = 0; k < 3; k++) {
        out.push(Math.max(0,
          L[8][k] * c1 * (n[0] * n[0] - n[1] * n[1])
          + L[6][k] * c3 * n[2] * n[2]
          + L[0][k] * c4 - L[6][k] * c5
          + L[4][k] * 2 * c1 * n[0] * n[1]
          + L[7][k] * 2 * c1 * n[0] * n[2]
          + L[5][k] * 2 * c1 * n[1] * n[2]
          + L[3][k] * 2 * c2 * n[0]
          + L[1][k] * 2 * c2 * n[1]
          + L[2][k] * 2 * c2 * n[2]));
      }
      return out;
    };
    const cam = [eng.camera.position.x, eng.camera.position.y, eng.camera.position.z];
    const rows = [];
    for (let cc = 0; cc < NC; cc++) {
      const live = list[cc * LW + 2 * CELLS + w.blocks];
      const stride = Math.max(1, Math.floor(live / Math.ceil(maxProbes / NC)));
      for (let li = 0; li < live; li += stride) {
        const cell = list[cc * LW + CELLS + li];
        const gc = cc * CELLS + cell;
        const b = gc * INFO_VEC * 4;
        const state = info[b + 3];
        if (!(state > 0.5)) continue;
        const P = [info[b], info[b + 1], info[b + 2]];
        const faced = state > 1.5;
        const fN = [info[b + 4], info[b + 5], info[b + 6]];
        // SH as the GPU stored it (shPass + neePass)
        const SHt = [];
        for (let i = 0; i < 9; i++) {
          const o = b + (3 + i) * 4;
          SHt.push([info[o], info[o + 1], info[o + 2]]);
        }
        // shPass, re-run on the CPU out of the same oct map — the TRANSPORT term
        const base = gc * OCT * OW;
        let acc = [0, 0, 0]; let wsum = 0;
        for (let t = 0; t < OCT; t++) {
          const a = base + t * OW;
          if (!(nOf(oct[a + 1]) > 0)) continue;
          const e = tbl[t];
          const cw = (faced ? Math.max(0, e[0] * fN[0] + e[1] * fN[1] + e[2] * fN[2]) : 1) * e[3];
          const r = decode(oct[a]);
          acc = [acc[0] + r[0] * cw, acc[1] + r[1] * cw, acc[2] + r[2] * cw];
          wsum += cw;
        }
        const fill = [acc[0] / Math.max(wsum, 1e-6), acc[1] / Math.max(wsum, 1e-6), acc[2] / Math.max(wsum, 1e-6)];
        const anyData = wsum > 1e-6;
        const SHo = Array.from({ length: 9 }, () => [0, 0, 0]);
        let maxTexel = 0; let maxDir = [0, 0, 0];
        for (let t = 0; t < OCT; t++) {
          const a = base + t * OW;
          const e = tbl[t];
          const has = nOf(oct[a + 1]) > 0;
          const front = faced ? (e[0] * fN[0] + e[1] * fN[1] + e[2] * fN[2]) > 0 : true;
          const val = has ? decode(oct[a]) : ((front && anyData) ? fill : [0, 0, 0]);
          const m = Math.max(val[0], val[1], val[2]);
          if (m > maxTexel) { maxTexel = m; maxDir = [e[0], e[1], e[2]]; }
          const y = Y([e[0], e[1], e[2]]);
          for (let i = 0; i < 9; i++) {
            SHo[i][0] += val[0] * e[3] * y[i];
            SHo[i][1] += val[1] * e[3] * y[i];
            SHo[i][2] += val[2] * e[3] * y[i];
          }
        }
        const SHn = SHt.map((v, i) => [v[0] - SHo[i][0], v[1] - SHo[i][1], v[2] - SHo[i][2]]);
        // the NEE term as `emitterSh` would build it with vis = 1
        const SHu = Array.from({ length: 9 }, () => [0, 0, 0]);
        const perSlot = [];
        for (const s of slots) {
          const act = s.radius > 1e-5 && s.color[0] + s.color[1] + s.color[2] > 1e-6;
          if (!act) { perSlot.push(0); continue; }
          const wv = [s.center[0] - P[0], s.center[1] - P[1], s.center[2] - P[2]];
          const d2 = Math.max(1e-4, wv[0] * wv[0] + wv[1] * wv[1] + wv[2] * wv[2]);
          const d = Math.sqrt(d2);
          const wd = [wv[0] / d, wv[1] / d, wv[2] / d];
          if (faced && (wd[0] * fN[0] + wd[1] * fN[1] + wd[2] * fN[2]) <= 1e-3) { perSlot.push(0); continue; }
          const reff = Math.max(1e-3, s.reff);
          const om = Math.min(Math.PI, Math.PI * reff * reff / d2);
          const y = Y(wd);
          for (let i = 0; i < 9; i++) {
            SHu[i][0] += s.color[0] * om * y[i];
            SHu[i][1] += s.color[1] * om * y[i];
            SHu[i][2] += s.color[2] * om * y[i];
          }
          perSlot.push(0.2126 * s.color[0] * om + 0.7152 * s.color[1] * om + 0.0722 * s.color[2] * om);
        }
        const N = faced ? fN : [0, 1, 0];
        const Et = shEval(SHt, N); const Eo = shEval(SHo, N);
        const En = shEval(SHn, N); const Eu = shEval(SHu, N);
        rows.push({
          cc, gc, P: P.map((v) => +v.toFixed(2)), faced,
          d: +Math.hypot(P[0] - cam[0], P[1] - cam[1], P[2] - cam[2]).toFixed(1),
          Et, Eo, En, Eu, maxTexel: +maxTexel.toFixed(4), maxDir: maxDir.map((v) => +v.toFixed(2)),
          perSlot: perSlot.map((v) => +v.toFixed(5)),
        });
      }
    }
    return { rows, live: Array.from({ length: NC }, (_, c) => list[c * LW + 2 * CELLS + w.blocks]), w };
  }, { slots, maxProbes: PROBES });

  console.log(`\n  ── the per-term readback ─────────────────────────────────`);
  console.log(`  live probes per cascade: ${terms.live.join(" / ")}   sampled ${terms.rows.length}`);
  for (let cc = 0; cc < terms.w.cascades; cc++) {
    const rows = terms.rows.filter((r) => r.cc === cc);
    if (!rows.length) continue;
    const stat = (get) => {
      const s = rows.map(get).sort((a, b) => a - b);
      return `p50 ${f(quant(s, 0.5))} p95 ${f(quant(s, 0.95))} max ${f(s[s.length - 1])}`;
    };
    const shareNee = rows.map((r) => lum(r.En) / Math.max(1e-6, lum(r.Et))).sort((a, b) => a - b);
    const visEff = rows.filter((r) => lum(r.Eu) > 1e-5)
      .map((r) => lum(r.En) / lum(r.Eu)).sort((a, b) => a - b);
    console.log(`\n   cascade ${cc} (spacing ${terms.w.spacings[cc]} m), n ${rows.length}`);
    console.log(`     E total     ${stat((r) => lum(r.Et))}`);
    console.log(`     E transport ${stat((r) => lum(r.Eo))}     (shPass, re-run on the CPU)`);
    console.log(`     E nee       ${stat((r) => lum(r.En))}     (wpInfo − transport = neePass)`);
    console.log(`     E nee UNOCC ${stat((r) => lum(r.Eu))}     (rgb·Ω, vis = 1)`);
    console.log(`     nee share of the field   p50 ${f(quant(shareNee, 0.5), 3)}  ` +
      `p95 ${f(quant(shareNee, 0.95), 3)}`);
    console.log(`     effective shadow vis     p50 ${f(quant(visEff, 0.5), 3)}  ` +
      `p05 ${f(quant(visEff, 0.05), 3)}  (n ${visEff.length})`);
    console.log(`     max oct texel radiance   ${stat((r) => r.maxTexel)}`);
    const chr = rows.map((r) => chroma(r.Et)).sort((a, b) => a - b);
    console.log(`     probe chroma |R−G|/(R+G) p50 ${f(quant(chr, 0.5), 3)}  p95 ${f(quant(chr, 0.95), 3)}`);
  }
  const worst = [...terms.rows].sort((a, b) => lum(b.Et) - lum(a.Et)).slice(0, 6);
  console.log(`\n   the six brightest probes:`);
  for (const r of worst) {
    console.log(`     c${r.cc} ${r.faced ? "face" : "air "} at [${r.P}] ${r.d} m  ` +
      `E [${r.Et.map((v) => f(v, 3))}]  transport [${r.Eo.map((v) => f(v, 3))}]  ` +
      `nee [${r.En.map((v) => f(v, 3))}]  maxTexel ${f(r.maxTexel, 3)} → [${r.maxDir}]  ` +
      `slots [${r.perSlot.map((v) => f(v, 4))}]`);
  }
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({
    pose: { position: pose.position, target: pose.target },
    worldProbes: shot.worldProbes, pave: paveStat, facade: facStat,
    paveRows: shot.pave.map((r) => ({ i: r.i, L: +lum(r.E).toFixed(6), c: +chroma(r.E).toFixed(6) })),
  }));
  console.log(`\n  reference written to ${OUT}`);
}
if (refData?.pave && paveStat) {
  const rc = refData.pave.chroma; const rl = refData.pave.lum;
  console.log(`\n  ── against ${REF} (${refData.worldProbes ? "world" : "screen"}) ───────────`);
  console.log(`     pavement chroma  ${f(paveStat.chroma, 4)} vs ${f(rc, 4)}   ` +
    `Δ ${f(Math.abs(paveStat.chroma - rc), 4)}  ` +
    `${Math.abs(paveStat.chroma - rc) <= 0.10 ? "PASS (≤ 0.10)" : "FAIL (> 0.10)"}`);
  console.log(`     pavement lum     ${f(paveStat.lum, 4)} vs ${f(rl, 4)}   ` +
    `ratio ${f(paveStat.lum / Math.max(1e-6, rl), 3)}  ` +
    `${Math.abs(paveStat.lum / Math.max(1e-6, rl) - 1) <= 0.30 ? "PASS (±30 %)" : "FAIL (±30 %)"}`);
}

await browser.close();
