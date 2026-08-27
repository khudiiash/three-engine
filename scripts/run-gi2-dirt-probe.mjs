// GI2 DIRT PROBE — §19 Stage 3.8's per-stage readback (the colour-probe method)
//
// Stage 3.7 left ONE number un-met: a Bistro façade brick's voxel faces still
// disagree by ~107 % of their mean at 9.3 shade samples each. Sample noise
// would have fallen ~2.5× with 7× the samples and did not, so the residual is
// SYSTEMATIC per-voxel disagreement on a flat, one-material wall.
//
// This probe does not argue about it. It reads back EVERY STAGE of one wall
// brick and prints the first one that varies:
//
//   (a) OCCUPANCY + the six face bits, per voxel   — the window
//   (b) the palette class byte + its albedo        — the material identity
//   (c) the cache RGBE + the sample count n        — per (voxel, face)
//   (d) the same, split by the wall's OUTWARD face vs the other five
//
// and then runs the A/B arms that can only be decided by switching a stage OFF
// (`ARMS=1`): injection off, sky-at-hit off, re-shade off.
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//   node scripts/run-gi2-dirt-probe.mjs http://127.0.0.1:5202/
//
// Env: PROJECT · SCENE=Bistro · SETTLE=14 · ARMS=1 · HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 14);
const ARMS = process.env.ARMS === "1";
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
// `NOISE` off would leave the energy control blind; the dump kernel is built
// only when a receipt asked for it BEFORE the gather factory runs.
await page.evaluateOnNewDocument(() => { globalThis.__gi2NoiseDump = true; });
if (process.env.LEGACY === "1") {
  await page.evaluateOnNewDocument(() => { globalThis.__gi2EntryFaceLegacy = true; });
}
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

let firstLight = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light/.test(t) && !firstLight) firstLight = Date.now();
  if (/\[gi2\] (soup|first)/.test(t)) console.log(`    ${t.slice(0, 200)}`);
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
  globalThis.__gi2 = () => {
    const sys = mod.engine?.modules?.get?.("gi")?.system;
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
const settleFrames = async (n, capMs = 120000) => {
  const f0 = await gatherFrame();
  const deadline = Date.now() + capMs;
  let f = f0;
  while (f - f0 < n && Date.now() < deadline) { await wait(400); f = await gatherFrame(); }
  return f - f0;
};

console.log(`\n══ ${SCENE} ═══════════════════════════════════════════════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{
  const dl = Date.now() + 240000;
  while (Date.now() < dl && !firstLight) await wait(250);
}
console.log(`  first light ${firstLight ? "yes" : "NEVER"} — settling ${SETTLE}s`);
await wait(SETTLE * 1000);

// ── the pose: the café façade in shade, derived from the scene (3.7 §P.5) ───
async function bistroPose() {
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
  await settleFrames(90, 20000);
  const ring = await page.evaluate(async ({ o }) => {
    const eng = globalThis.__giEngineForProbe;
    const gi2 = globalThis.__gi2();
    if (!gi2?.trace || !eng?.renderer) return null;
    const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
    const shoot = createGi2RayShooter(gi2, eng.renderer);
    const dirs = [];
    for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; dirs.push([Math.cos(a), 0, Math.sin(a)]); }
    const out = await shoot(dirs.map((d) => ({ o, d, tMax: 30 })));
    return dirs.map((d, i) => ({ d, t: out[i].hit ? out[i].t : 30 }));
  }, { o: [B[0], eye, B[2]] });
  if (!ring) return null;
  const D = ring.reduce((a, b) => (b.t > a.t ? b : a)).d;
  return {
    name: "facade-wide",
    position: [B[0] + D[0] * 6, eye, B[2] + D[2] * 6],
    target: [B[0], ground + 2.2, B[2]],
  };
}

// ── THE PER-STAGE READBACK ──────────────────────────────────────────────────
//
// One `page.evaluate`, because every stage has to be read out of the SAME frame
// — a window buffer from one frame against a cache from the next would let a
// scroll move the origin under the comparison.
const readStages = (pose) => page.evaluate(async ({ pose }) => {
  const rc = await import("/src/modules/gi/window/radianceCache.js");
  const ws = await import("/src/modules/gi/window/windowStore.js");
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  if (!gi2?.cache) return { error: "no gi2 cache" };
  const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
  const shoot = createGi2RayShooter(gi2, eng.renderer);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const nz = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const fwd = nz(sub(pose.target, pose.position));
  const right = nz(cross(fwd, [0, 1, 0]));
  const up = nz(cross(right, fwd));
  // ⭐⭐ FOURTEEN BRICKS CANNOT SETTLE ANYTHING. §P.1's fan is 7×5 rays and
  // yields ~14 bricks, and the median σ/mean over 14 samples of a heavy-tailed
  // distribution moved 26 → 82 % between two runs of the SAME binary at the
  // SAME pose — a run-to-run spread wider than any change worth making. The
  // shooter caps at 64 rays per dispatch, so the fan is fired in BATCHES: the
  // same angular grid at eight jittered sub-offsets, 8 × 35 rays, which walks
  // over the façade at a fraction of a brick and lands ~10× the bricks for
  // eight readbacks of a buffer that is already resident.
  const hits = [];
  for (let b = 0; b < 8; b++) {
    const ox = ((b % 3) - 1) * 0.03;
    const oy = (Math.floor(b / 3) - 1) * 0.03;
    const rays = [];
    for (let i = -3; i <= 3; i++) {
      for (let j = -2; j <= 2; j++) {
        const a = i * 0.09 + ox;
        const c = j * 0.09 + oy;
        rays.push({
          o: pose.position,
          d: nz([fwd[0] + right[0] * a + up[0] * c,
            fwd[1] + right[1] * a + up[1] * c,
            fwd[2] + right[2] * a + up[2] * c]),
          tMax: 30,
        });
      }
    }
    hits.push(...await shoot(rays));
  }
  const words = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.cache.attribute));
  const winW = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.win.attribute));
  const off = gi2.cache.describe().offsets;
  const pal = gi2.gather?.palette ?? [];
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const stat = (a) => {
    if (!a.length) return null;
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
    return { n: a.length, mean: m, sd, cv: (100 * sd) / Math.max(1e-9, m) };
  };
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

  const lvOf = (cx, cy, cz) => (cx & 3) | ((cy & 3) << 2) | ((cz & 3) << 4);
  const bricks = [];
  const seen = new Set();
  for (const h of hits) {
    if (!h.hit || h.level !== 0) continue;
    const face = h.faceId;
    if (face === 2 || face === 3) continue; // a façade is VERTICAL
    const vi = h.voxelIdx;
    const cx = vi & 63; const cy = (vi >> 6) & 63; const cz = (vi >> 12) & 63;
    const b = (cx >> 2) | ((cy >> 2) << 4) | ((cz >> 2) << 8);
    const key = b + ":" + face;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = words[off.MAP_OFF + b];
    if (!m) continue;
    const slot = m - 1;
    const axis = face >> 1;
    const key3 = [cx & 3, cy & 3, cz & 3][axis];
    // The 16 voxels of the brick that share the hit's own layer along the
    // face axis — the slab, exactly as §P.1's receipt picks it.
    const slab = [];
    for (let k = 0; k < 64; k++) {
      const l3 = [k & 3, (k >> 2) & 3, (k >> 4) & 3];
      if (l3[axis] !== key3) continue;
      // The window's own toroidal voxel index for this in-brick voxel.
      const wcx = ((cx >> 2) << 2) | l3[0];
      const wcy = ((cy >> 2) << 2) | l3[1];
      const wcz = ((cz >> 2) << 2) | l3[2];
      const wvi = wcx | (wcy << 6) | (wcz << 12);
      const occ = (winW[ws.OCC_OFF + (wvi >> 5)] >>> (wvi & 31)) & 1;
      // ⭐ IS THE FACE'S OWN SAMPLE POINT IN THE OPEN? `faceSamplePoint` puts
      // the shade point on the voxel's outward face PLANE and the trace then
      // biases it half a cell further along the normal — i.e. into the voxel
      // IN FRONT. A conservatively-voxelized wall is two cells thick wherever
      // its plane falls near a cell boundary, so for the INNER of the two that
      // voxel is SOLID: the sun ray is blocked at once and all four sky rays
      // start inside the wall. Two neighbouring voxels of one flat wall that
      // differ in this bit cannot agree, however many samples they take.
      const nrmOf = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][face];
      const occAt = (x, y, z) => {
        const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12);
        return (winW[ws.OCC_OFF + (i >> 5)] >>> (i & 31)) & 1;
      };
      const frontOcc = occAt(wcx + nrmOf[0], wcy + nrmOf[1], wcz + nrmOf[2]);
      const front2 = occAt(wcx + 2 * nrmOf[0], wcy + 2 * nrmOf[1], wcz + 2 * nrmOf[2]);
      const backOcc = occAt(wcx - nrmOf[0], wcy - nrmOf[1], wcz - nrmOf[2]);
      const fb = (winW[ws.FACE_OFF + (wvi >> 2)] >>> ((wvi & 3) * 8)) & 255;
      const pb = (winW[ws.PAL_OFF + (wvi >> 2)] >>> ((wvi & 3) * 8)) & 255;
      const faces = [];
      for (let f = 0; f < 6; f++) {
        const w = words[off.DATA_OFF + slot * 384 + k * 6 + f];
        faces.push({
          f, rgb: rc.unpackRgbe(w),
          n: gi2.cache.readCount(words, slot, k, f),
          bit: (fb >>> f) & 1,
        });
      }
      // ⭐⭐ §19 STAGE 3.9 — bits 6-7 of the face byte are the voxel's DOMINANT
      // NORMAL AXIS now (0 = not known, 1/2/3 = X/Y/Z), written by the SAT's
      // area-weighted argmax. Read here so the probe can say two things 3.8
      // could only assert: whether the voxelizer named an axis at all, and
      // whether the slots this façade actually carries radiance in are the ones
      // that axis allows.
      slab.push({ lv: k, occ, faceBits: fb, ax: (fb >>> 6) & 3, palByte: pb, faces, frontOcc, front2, backOcc });
    }
    if (slab.length !== 16) continue;
    bricks.push({ face, axis, key3, slot, slab });
  }
  if (!bricks.length) return { error: "no façade bricks found", hits: hits.filter((h) => h.hit).length };

  // ── the four stage tables ──────────────────────────────────────────────
  const occN = []; const bitFull = []; const bitOut = [];
  const classN = []; const classAlbCv = []; const multiClass = [];
  const outCv = []; const outN = []; const outWritten = [];
  const otherCv = []; const otherWritten = [];
  const bitPattern = new Map();
  const nHist = new Map();
  // ⭐ THE DECOMPOSITION. §P.1's own metric scores every WRITTEN word in the
  // layer, wall and air alike; these five buckets say which part of it moves.
  const cv37 = [];        // §P.1's metric, reproduced exactly
  const cvAir = [];       // the layer's UNOCCUPIED voxels — nothing should be here
  const cvSameCls = [];   // occupied AND one palette class: H2 removed
  const cvShaded = [];    // occupied, n > 0: the shade estimator alone
  const cvInjOnly = [];   // occupied, n == 0 but written: injection alone
  const airFrac = []; const airVsWall = [];
  const cvOpen = []; const cvBuried = []; const buriedFrac = []; const buriedRatio = [];
  const cvOpenSameCls = [];
  // ⭐⭐ §19 STAGE 3.9's OWN RECEIPT — the mis-attributed slots, counted.
  //
  // A wall voxel has ONE surface. Every cache word it holds on an axis that is
  // not its dominant one is a word no honest producer should ever have written,
  // and under 3.8's entry-face rule they ARE written — by the grazing rays that
  // "hit" the façade through a face it does not have, whose shade point
  // `ORIGIN_ESCAPE` then walked out into open sun. That is the 78-87× half of
  // the BURIED split, named directly instead of inferred from a spread.
  let axAll = 0; let axKnown = 0; let misWritten = 0; const misErr = [];
  for (const br of bricks) {
    const wall = br.slab.filter((v) => v.occ === 1);
    occN.push(wall.length);
    // ⚠ MASK WITH 63. §19 Stage 3.9 put the dominant AXIS in bits 6-7 of the
    // same byte, so `faceBits === 63` — 3.8's test for "this voxel carries all
    // six blocking bits" — is now false for every voxel that names an axis, and
    // would have reported Bistro's 95 % as 0 % without one line of the reader
    // changing meaning.
    bitFull.push(wall.filter((v) => (v.faceBits & 63) === 63).length);
    bitOut.push(wall.filter((v) => ((v.faceBits >>> br.face) & 1) === 1).length);
    for (const v of wall) bitPattern.set(v.faceBits & 63, (bitPattern.get(v.faceBits & 63) ?? 0) + 1);
    const classes = new Set(wall.map((v) => v.palByte));
    classN.push(classes.size);
    multiClass.push(classes.size > 1 ? 1 : 0);
    // ── §19 Stage 3.9: the mis-attributed slots (see the note above) ──────
    for (const v of wall) {
      axAll++;
      if (!v.ax) continue;
      axKnown++;
      const dom = v.ax - 1;
      const domFaces = [v.faces[dom * 2], v.faces[dom * 2 + 1]].filter((f) => f.rgb).map((f) => lum(f.rgb));
      const wrong = v.faces.filter((f) => (f.f >> 1) !== dom && f.rgb).map((f) => lum(f.rgb));
      if (!wrong.length) continue;
      misWritten++;
      if (domFaces.length && domFaces[0] > 1e-9) {
        misErr.push(Math.abs(Math.max(...wrong) - domFaces[0]) / domFaces[0]);
      }
    }
    // ── the decomposition, all on the OUTWARD face ───────────────────────
    {
      const all = br.slab.filter((v) => v.faces[br.face].rgb).map((v) => lum(v.faces[br.face].rgb));
      const s = stat(all); if (s && all.length >= 6) cv37.push(s.cv);
      const air = br.slab.filter((v) => v.occ === 0 && v.faces[br.face].rgb);
      airFrac.push(all.length ? air.length / all.length : 0);
      const sa = stat(air.map((v) => lum(v.faces[br.face].rgb)));
      if (sa && air.length >= 4) cvAir.push(sa.cv);
      const wallVals = wall.filter((v) => v.faces[br.face].rgb).map((v) => lum(v.faces[br.face].rgb));
      const sw = stat(wallVals);
      if (sa && sw && sw.mean > 1e-9) airVsWall.push(sa.mean / sw.mean);
      // the biggest single palette class in this slab
      const byCls = new Map();
      for (const v of wall) {
        if (!v.faces[br.face].rgb) continue;
        (byCls.get(v.palByte) ?? byCls.set(v.palByte, []).get(v.palByte)).push(lum(v.faces[br.face].rgb));
      }
      const big = [...byCls.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      const sc = stat(big); if (sc && big.length >= 6) cvSameCls.push(sc.cv);
      const sh = wall.filter((v) => v.faces[br.face].rgb && v.faces[br.face].n > 0)
        .map((v) => lum(v.faces[br.face].rgb));
      const ss = stat(sh); if (ss && sh.length >= 6) cvShaded.push(ss.cv);
      const io = wall.filter((v) => v.faces[br.face].rgb && v.faces[br.face].n === 0)
        .map((v) => lum(v.faces[br.face].rgb));
      const si = stat(io); if (si && io.length >= 4) cvInjOnly.push(si.cv);
      // ── the BURIED-FACE split ────────────────────────────────────────
      const lit = wall.filter((v) => v.faces[br.face].rgb);
      const open = lit.filter((v) => v.frontOcc === 0);
      const bur = lit.filter((v) => v.frontOcc === 1);
      buriedFrac.push(lit.length ? bur.length / lit.length : 0);
      const sO = stat(open.map((v) => lum(v.faces[br.face].rgb)));
      const sB = stat(bur.map((v) => lum(v.faces[br.face].rgb)));
      if (sO && open.length >= 5) cvOpen.push(sO.cv);
      if (sB && bur.length >= 5) cvBuried.push(sB.cv);
      if (sO && sB && sO.mean > 1e-9) buriedRatio.push(sB.mean / sO.mean);
      // the same, restricted to ONE palette class — H2 and the buried bit
      // removed together, which is what "a flat one-material wall" means.
      const byCls2 = new Map();
      for (const v of open) (byCls2.get(v.palByte) ?? byCls2.set(v.palByte, []).get(v.palByte))
        .push(lum(v.faces[br.face].rgb));
      const big2 = [...byCls2.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      const s2 = stat(big2); if (s2 && big2.length >= 5) cvOpenSameCls.push(s2.cv);
    }
    const albs = [...classes].filter((c) => c < pal.length).map((c) => {
      const p = pal[c];
      return 0.2126 * p.x + 0.7152 * p.y + 0.0722 * p.z;
    });
    const s = stat(albs);
    if (s) classAlbCv.push(s.cv);
    // (c)/(d): the OUTWARD face vs the other five.
    const ov = []; const on = [];
    for (const v of wall) {
      const fc = v.faces[br.face];
      if (fc.rgb) { ov.push(lum(fc.rgb)); on.push(fc.n); }
      nHist.set(fc.n, (nHist.get(fc.n) ?? 0) + 1);
    }
    outWritten.push(wall.length ? ov.length / wall.length : 0);
    const so = stat(ov);
    if (so && ov.length >= 6) { outCv.push(so.cv); outN.push(on.reduce((a, x) => a + x, 0) / on.length); }
    const others = [];
    let owr = 0; let ocount = 0;
    for (const v of wall) {
      for (let f = 0; f < 6; f++) {
        if (f === br.face) continue;
        ocount++;
        if (v.faces[f].rgb) { owr++; others.push(lum(v.faces[f].rgb)); }
      }
    }
    otherWritten.push(ocount ? owr / ocount : 0);
    const sot = stat(others);
    if (sot && others.length >= 8) otherCv.push(sot.cv);
  }

  // ── a per-brick dump of ONE brick, for eyes ───────────────────────────
  const b0 = bricks[0];
  const dump = b0.slab.filter((v) => v.occ === 1).map((v) => ({
    lv: v.lv, bits: v.faceBits, pal: v.palByte,
    out: v.faces[b0.face].rgb ? +lum(v.faces[b0.face].rgb).toFixed(4) : null,
    n: v.faces[b0.face].n, fo: v.frontOcc, f2: v.front2, bo: v.backOcc,
    written: v.faces.map((f) => (f.rgb ? 1 : 0)).join(""),
  }));

  return {
    bricks: bricks.length,
    occPerSlab: med(occN),
    bitFullFrac: med(occN) ? med(bitFull) / med(occN) : null,
    bitOutFrac: med(occN) ? med(bitOut) / med(occN) : null,
    bitPatterns: [...bitPattern.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, c]) => `${k.toString(2).padStart(6, "0")}×${c}`),
    classesPerSlab: med(classN), classAlbCvMedian: med(classAlbCv),
    multiClassFrac: multiClass.length ? multiClass.reduce((a, x) => a + x, 0) / multiClass.length : 0,
    cv37: med(cv37), cvAir: med(cvAir), cvSameCls: med(cvSameCls),
    cvShaded: med(cvShaded), cvInjOnly: med(cvInjOnly),
    airFrac: med(airFrac), airVsWall: med(airVsWall),
    nCv37: cv37.length, nCvAir: cvAir.length, nCvSame: cvSameCls.length,
    nCvShaded: cvShaded.length, nCvInj: cvInjOnly.length,
    axKnownPct: axAll ? (100 * axKnown) / axAll : null,
    misPct: axAll ? (100 * misWritten) / axAll : null,
    misErrPct: misErr.length ? 100 * med(misErr) : null,
    axWallVoxels: axAll,
    cvOpen: med(cvOpen), cvBuried: med(cvBuried), buriedFrac: med(buriedFrac),
    buriedRatio: med(buriedRatio), cvOpenSameCls: med(cvOpenSameCls),
    nCvOpen: cvOpen.length, nCvBuried: cvBuried.length, nCvOpenSame: cvOpenSameCls.length,
    outCvMedian: med(outCv), outCvMin: outCv.length ? Math.min(...outCv) : null,
    outCvMax: outCv.length ? Math.max(...outCv) : null,
    outNMedian: med(outN), outWrittenFrac: med(outWritten),
    otherCvMedian: med(otherCv), otherWrittenFrac: med(otherWritten),
    nHist: [...nHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, c]) => `n${k}×${c}`).join(" "),
    dumpFace: b0.face, dump,
  };
}, { pose });

// ── THE ENERGY CONTROL: is the frame still lit? ─────────────────────────────
//
// ⭐ A SPREAD THAT FELL BECAUSE THE CACHE WENT BLACK IS NOT A FIX, and a
// coefficient of variation cannot tell the two apart (0/0 reads as 0 %). So the
// spread is never reported without the MEAN beside it: the façade's own
// irradiance against the sunlit pavement's, out of the same dump the §P.5 dirt
// receipt uses.
const energy = () => page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe;
  const g = globalThis.__gi2()?.gather;
  const r = eng?.renderer;
  if (!g?.passes?.noiseDump || !g.buffers?.dirtyBuf) return { error: "no noise kernel" };
  await r.computeAsync(g.passes.noiseDump);
  const noise = new Float32Array(await r.getArrayBufferAsync(g.buffers.noiseBuf.value));
  const geo = new Float32Array(await r.getArrayBufferAsync(g.buffers.dirtyBuf.value));
  const fac = []; const pav = [];
  for (let i = 0; i < geo.length / 4; i++) {
    if (!(noise[i * 4 + 3] > 0.5)) continue;
    const ny = geo[i * 4 + 1];
    const v = noise[i * 4];
    if (Math.abs(ny) < 0.4) fac.push(v);
    else if (ny > 0.8) pav.push(v);
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const p75 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.75)] : null);
  const u = g.uniforms;
  const rgb = (n) => {
    const v = n?.value;
    if (!v) return null;
    return [v.x ?? v[0], v.y ?? v[1], v.z ?? v[2]].map((q) => +Number(q).toFixed(4));
  };
  const st = g.stats ? await g.stats() : null;
  return {
    facadePx: fac.length, pavementPx: pav.length,
    facadeMean: mean(fac), pavementP75: p75(pav),
    sky: rgb(u.skyColor), sun: rgb(u.sunColor), stats: st,
  };
});

const pose = await bistroPose();
if (!pose) { console.log("FATAL: no FrontBanner — cannot derive the pose"); await browser.close(); process.exit(1); }
console.log(`  pose ${pose.name}  eye ${pose.position.map((v) => v.toFixed(1))} → ${pose.target.map((v) => v.toFixed(1))}`);

const show = (tag, r) => {
  if (r?.error) { console.log(`  ${tag}: ${r.error}`); return; }
  console.log(`\n  ── ${tag} ── ${r.bricks} façade bricks, ${r.occPerSlab} occupied voxels per 16-voxel slab`);
  console.log(`     (a) FACE BITS  full-63 ${(100 * r.bitFullFrac).toFixed(0)}%  outward-bit set ${(100 * r.bitOutFrac).toFixed(0)}%   ${r.bitPatterns.join(" ")}`);
  console.log(`     (a2) §3.9 AXIS ${r.axKnownPct?.toFixed(0) ?? "—"}% of ${r.axWallVoxels} wall voxels name a dominant axis; ` +
    `MIS-ATTRIBUTED SLOTS ${r.misPct?.toFixed(1) ?? "—"}% of them, off by ${r.misErrPct?.toFixed(0) ?? "—"}%`);
  console.log(`     (b) PALETTE    ${r.classesPerSlab} distinct classes per slab (${(100 * r.multiClassFrac).toFixed(0)}% of slabs multi-class), their albedo σ/mean ${r.classAlbCvMedian?.toFixed(1) ?? "—"}%`);
  console.log(`     (c) CACHE out  σ/mean ${r.outCvMedian?.toFixed(1)}% [${r.outCvMin?.toFixed(0)}…${r.outCvMax?.toFixed(0)}]  n̄ ${r.outNMedian?.toFixed(1)}  written ${(100 * r.outWrittenFrac).toFixed(0)}%`);
  console.log(`     (d) CACHE oth  σ/mean ${r.otherCvMedian?.toFixed(1) ?? "—"}%  written ${(100 * r.otherWrittenFrac).toFixed(0)}%   counts ${r.nHist}`);
  const p = (v) => (v == null ? "  —  " : `${v.toFixed(1)}%`.padStart(6));
  console.log(`     ══ DECOMPOSITION of the outward face's slab spread ══`);
  console.log(`        §P.1 metric (all written, wall+air)  ${p(r.cv37)}   (${r.nCv37} slabs)`);
  console.log(`        AIR voxels only                      ${p(r.cvAir)}   ${(100 * r.airFrac).toFixed(0)}% of written words are AIR, at ${r.airVsWall?.toFixed(2) ?? "—"}× the wall's mean`);
  console.log(`        WALL voxels only                     ${p(r.outCvMedian)}`);
  console.log(`        WALL, one palette class              ${p(r.cvSameCls)}   (${r.nCvSame} slabs)`);
  console.log(`        WALL, shaded (n>0)                   ${p(r.cvShaded)}`);
  console.log(`        WALL, inject-only (n==0)             ${p(r.cvInjOnly)}   (${r.nCvInj} slabs)`);
  console.log(`     ══ THE BURIED-FACE SPLIT (is the shade point's own cell solid?) ══`);
  console.log(`        BURIED faces (front cell occupied)   ${(100 * r.buriedFrac).toFixed(0)}% of lit wall voxels, at ${r.buriedRatio?.toFixed(2) ?? "—"}× the open ones' mean`);
  console.log(`        OPEN   only                          ${p(r.cvOpen)}   (${r.nCvOpen} slabs)`);
  console.log(`        BURIED only                          ${p(r.cvBuried)}   (${r.nCvBuried} slabs)`);
  console.log(`        OPEN + one palette class             ${p(r.cvOpenSameCls)}   (${r.nCvOpenSame} slabs)`);
  console.log(`     dump (face ${r.dumpFace}): ${r.dump.map((d) => `[v${d.lv} b${d.bits.toString(2).padStart(6, "0")} p${d.pal} L${d.out} n${d.n} fo${d.fo}${d.f2}${d.bo} w${d.written}]`).join(" ")}`);
};

await call("viewport.setCamera", { position: pose.position, target: pose.target });
await settleFrames(240);
{
  const e = await energy();
  console.log(`  ENERGY: façade ${e.facadeMean?.toFixed(4)} over ${e.facadePx} px vs sunlit pavement p75 ` +
    `${e.pavementP75?.toFixed(4)} over ${e.pavementPx} px → ${((100 * e.facadeMean) / e.pavementP75).toFixed(1)} %` +
    `   sky ${JSON.stringify(e.sky)} sun ${JSON.stringify(e.sun)}`);
  if (e.stats) console.log(`  STATS: ${JSON.stringify(e.stats).slice(0, 400)}`);
}
show(process.env.LEGACY === "1" ? "LEGACY entry-face (3.7 rule)" : "EXPOSED-FACE rule", await readStages(pose));

if (ARMS) {
  const arm = async (tag, set) => {
    await page.evaluate(async ({ set }) => {
      const gi2 = globalThis.__gi2();
      const u = gi2.gather.uniforms;
      for (const [k, v] of Object.entries(set)) if (u[k]) u[k].value = v;
      // A world accumulator cannot be A/B'd without being emptied first.
      await globalThis.__giEngineForProbe.renderer.computeAsync(gi2.cache.clearPass);
    }, { set });
    await settleFrames(320);
    show(tag, await readStages(pose));
  };
  await arm("ARM injectAlpha=0 (H4 off)", { injectAlpha: 0 });
  await arm("ARM injectAlpha=0 + skyAtHit=0 (H4+H3 off)", { injectAlpha: 0, skyAtHit: 0 });
  await arm("ARM inject only (shadeProb=0, sky off)", { injectAlpha: 0.25, skyAtHit: 0, shadeProb: 0 });
}

await browser.close();
