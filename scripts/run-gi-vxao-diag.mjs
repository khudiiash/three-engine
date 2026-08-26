// VXAO STAGE PROBE + DATA CAPTURE.
//
// Two jobs, both about answering a "VXAO looks wrong" report with the FIRST
// wrong number rather than with a theory:
//
//   1. It replays the cone march on the CPU against the REAL voxel data and
//      prints every stage of it — per cone, per step, t / cell / lod / density
//      / coverage / alpha — beside the medium's own statistics, and beside the
//      value the GPU pass actually wrote at the same world point. A
//      disagreement between the last two is a shader bug; agreement moves the
//      question to the estimator, which is what (2) is for.
//   2. It writes scripts/.gi-vxao/vxao-dump.json — the density pyramid plus the
//      level-0 occupancy bits — so scripts/vxao-bench.mjs can score the march
//      against brute-force ray-cast ground truth OFFLINE, in seconds, instead
//      of a three-minute editor boot per variant. Every measured constant in
//      traceOccupancyConeAO was chosen against that bench.
//
//   npm run probe:gi-vxao-dump -- http://127.0.0.1:5201/
import puppeteer from "puppeteer-core";
import path from "node:path";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeVxaoProject, VXAO_POSE, VXAO_SUBJECTS } from "./lib/makeVxaoProject.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5211/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve("scripts/.gi-vxao").replaceAll("\\", "/");
await makeVxaoProject(root, { quality: process.env.QUALITY ?? "high" });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: path.resolve("scripts/.chrome-vxao-probe"),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {});
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/\[gi\] VXAO|occupancy|validation/i.test(t)) console.log("PAGE:", t.slice(0, 220));
});
await page.evaluateOnNewDocument((project) => {
  localStorage.clear();
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__engineLimitsCap = { maxStorageBuffersPerShaderStage: 8 };
  globalThis.__giVxao = true;
}, root);

await page.goto(url, { waitUntil: "load", timeout: 60_000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30_000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, root);
for (let i = 0; i < 180 && !built; i++) await wait(1000);
if (!built) throw new Error("GI never built");
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60_000 });
await page.evaluate((pose) => globalThis.__editorApi.call("viewport.setCamera", pose), VXAO_POSE);
await page.waitForFunction(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  return engine.modules.get("gi")?.system?._fieldReadyOnce === true;
}, { timeout: 90_000 });
await wait(12_000);

const out = await page.evaluate(async (subjects) => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const sys = engine.modules.get("gi")?.system;
  const occ = sys?.state?.volume?.occupancyField;
  const reader = await occ.readbackBits(engine.renderer);
  if (!reader) return { error: "bits readback unavailable" };

  const vox = reader.voxel;
  const org = reader.origin;
  const inv = { x: 1 / vox.x, y: 1 / vox.y, z: 1 / vox.z };
  const res0 = reader.levels[0].res;
  const voxMin = Math.min(vox.x, vox.y, vox.z);
  const finest = voxMin * 2;

  // How much medium is there, per level?
  const levelStats = [];
  for (let L = 1; L <= 4; L++) {
    const r = reader.levels[L].res;
    let nz = 0, sum = 0, max = 0, n = 0;
    for (let z = 0; z < r.z; z++) for (let y = 0; y < r.y; y++) for (let x = 0; x < r.x; x++) {
      const d = reader.getDensity(x, y, z, L);
      n++; if (d > 0) nz++;
      sum += d; if (d > max) max = d;
    }
    levelStats.push({ L, res: `${r.x}x${r.y}x${r.z}`, nonZero: nz, cells: n, meanByte: +(sum / n).toFixed(2), maxByte: max });
  }

  const triAt = (q, L) => {
    const scale = 2 ** L;
    const c = { x: q.x / scale - 0.5, y: q.y / scale - 0.5, z: q.z / scale - 0.5 };
    const b = { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) };
    const f = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const g = (dx, dy, dz) => reader.getDensity(b.x + dx, b.y + dy, b.z + dz, L) / 255;
    const d00 = g(0, 0, 0) * (1 - f.x) + g(1, 0, 0) * f.x;
    const d10 = g(0, 1, 0) * (1 - f.x) + g(1, 1, 0) * f.x;
    const d01 = g(0, 0, 1) * (1 - f.x) + g(1, 0, 1) * f.x;
    const d11 = g(0, 1, 1) * (1 - f.x) + g(1, 1, 1) * f.x;
    return (d00 * (1 - f.y) + d10 * f.y) * (1 - f.z) + (d01 * (1 - f.y) + d11 * f.y) * f.z;
  };
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

  // Exact replay of traceOccupancyConeAO.
  const march = (origin, dir, tMin, tMax, tanH, recvP, recvN, steps = 8, trace = null) => {
    const q0 = { x: (origin.x - org.x) * inv.x, y: (origin.y - org.y) * inv.y, z: (origin.z - org.z) * inv.z };
    const dq = { x: dir.x * inv.x, y: dir.y * inv.y, z: dir.z * inv.z };
    const reach = Math.max(tMax, finest);
    let t = Math.max(tMin, finest * 0.5);
    let alpha = 0;
    for (let i = 0; i < steps; i++) {
      if (t >= reach || alpha >= 0.995) break;
      const cell = Math.max(tanH * t, finest);
      const stepLen = cell;
      const tm = t + stepLen * 0.5;
      const qm = { x: q0.x + dq.x * tm, y: q0.y + dq.y * tm, z: q0.z + dq.z * tm };
      if (qm.x < 0 || qm.y < 0 || qm.z < 0 || qm.x >= res0.x || qm.y >= res0.y || qm.z >= res0.z) {
        trace?.push({ i, t: +t.toFixed(3), out: true });
        break;
      }
      const lod = Math.min(4, Math.max(1, Math.log2(cell / voxMin)));
      const lf = Math.floor(lod);
      const dens = triAt(qm, lf) * (1 - (lod - lf)) + triAt(qm, Math.min(4, lf + 1)) * (lod - lf);
      const pw = { x: qm.x * vox.x + org.x, y: qm.y * vox.y + org.y, z: qm.z * vox.z + org.z };
      const planeD = recvN.x * (pw.x - recvP.x) + recvN.y * (pw.y - recvP.y) + recvN.z * (pw.z - recvP.z);
      const above = smooth(voxMin * -0.25, voxMin * 0.75, planeD);
      const a = Math.min(1, Math.max(0, dens * above * (cell / voxMin)));
      const w = 1 - smooth(reach * 0.6, reach, tm);
      alpha += (1 - alpha) * a * w;
      trace?.push({
        i, t: +t.toFixed(3), cell: +cell.toFixed(3), lod: +lod.toFixed(2),
        dens: +dens.toFixed(4), above: +above.toFixed(2),
        a: +a.toFixed(4), w: +w.toFixed(2), alpha: +alpha.toFixed(4),
      });
      t += stepLen;
    }
    return 1 - alpha;
  };

  const TAN = Math.tan(Math.PI / 6);
  const SZ = Math.cos(Math.PI / 3), SR = Math.sin(Math.PI / 3);
  const evalPoint = (p, keepTrace) => {
    const P = { x: p[0], y: p[1], z: p[2] };
    const N = { x: 0, y: 1, z: 0 };
    const T = { x: 1, y: 0, z: 0 }, B = { x: 0, y: 0, z: 1 };
    const origin = { x: P.x, y: P.y + finest * 1.5, z: P.z };
    const tMin = finest * 0.5;
    const radius = 1; // the scene's authored aoRadius
    const reach = Math.max(radius * 4, finest * 6);
    const cones = [{ d: N, w: 1 / (1 + 5 * SZ), label: "axial" }];
    for (let k = 0; k < 5; k++) {
      const a = (k * 2 * Math.PI) / 5;
      cones.push({
        d: {
          x: N.x * SZ + T.x * Math.cos(a) * SR + B.x * Math.sin(a) * SR,
          y: N.y * SZ + T.y * Math.cos(a) * SR + B.y * Math.sin(a) * SR,
          z: N.z * SZ + T.z * Math.cos(a) * SR + B.z * Math.sin(a) * SR,
        },
        w: SZ / (1 + 5 * SZ),
        label: `side${k} az${Math.round((a * 180) / Math.PI)}`,
      });
    }
    let vis = 0;
    const per = [];
    for (const c of cones) {
      const tr = keepTrace ? [] : null;
      const v = march(origin, c.d, tMin, reach, TAN, P, N, 8, tr);
      vis += v * c.w;
      per.push({ label: c.label, dir: [+c.d.x.toFixed(2), +c.d.y.toFixed(2), +c.d.z.toFixed(2)], vis: +v.toFixed(4), trace: tr });
    }
    return { visibility: +vis.toFixed(4), per };
  };

  // Where is the occluder, in voxels, and what does the medium say there?
  const occCentre = { x: -4.8, y: 1.0, z: 0.85 };
  const occProbe = [];
  for (let L = 1; L <= 4; L++) {
    const v = reader.voxelOf(occCentre, L);
    occProbe.push({ L, v: [v.x, v.y, v.z], byte: reader.getDensity(v.x, v.y, v.z, L) });
  }
  // Straight line from hiddenFloor toward the occluder: what densities exist?
  const walk = [];
  for (let s = 0; s <= 12; s++) {
    const wx = -3.8 - s * 0.1;
    const p = { x: wx, y: 0.5, z: 0.85 };
    const q = { x: (p.x - org.x) * inv.x, y: (p.y - org.y) * inv.y, z: (p.z - org.z) * inv.z };
    walk.push({ x: +wx.toFixed(2), L1: +triAt(q, 1).toFixed(3), L2: +triAt(q, 2).toFixed(3), L3: +triAt(q, 3).toFixed(3) });
  }

  // Level-0 occupancy, packed 8 voxels/byte, base64. This is the GROUND TRUTH
  // the cone march is an estimator OF — offline reference AO is ray-cast
  // against exactly these bits.
  const nVox = res0.x * res0.y * res0.z;
  const packed = new Uint8Array(Math.ceil(nVox / 8));
  let bi = 0;
  for (let z = 0; z < res0.z; z++) for (let y = 0; y < res0.y; y++) for (let x = 0; x < res0.x; x++) {
    if (reader.get(x, y, z, 0)) packed[bi >> 3] |= 1 << (bi & 7);
    bi++;
  }
  let bin = "";
  for (let i = 0; i < packed.length; i += 8192) {
    bin += String.fromCharCode(...packed.subarray(i, Math.min(packed.length, i + 8192)));
  }
  const occupancyB64 = btoa(bin);

  // Whole density region, so variants of the march can be evaluated offline
  // instead of costing a 3-minute editor boot each.
  const densityDump = [];
  for (let L = 1; L <= 4; L++) {
    const r = reader.levels[L].res;
    const arr = new Array(r.x * r.y * r.z);
    let i = 0;
    for (let z = 0; z < r.z; z++) for (let y = 0; y < r.y; y++) for (let x = 0; x < r.x; x++) {
      arr[i++] = reader.getDensity(x, y, z, L);
    }
    densityDump.push({ L, res: [r.x, r.y, r.z], bytes: arr });
  }

  // WHAT THE GPU ACTUALLY WROTE. The CPU replay above is only a model of the
  // shader; this reads the shader's own output and pairs each texel with the
  // gbuffer world position it was computed from, so "is the estimator right"
  // and "can screen luminance see it" become separate questions.
  const screen = sys.state.screen;
  const pass = screen?.vxaoPass;
  let gpu = null;
  if (pass) {
    const renderer = engine.renderer;
    const vw = pass.width, vh = pass.height;
    const unpad = (raw, w, h, comps, Ctor) => {
      const rowBytes = w * comps * Ctor.BYTES_PER_ELEMENT;
      const padded = Math.ceil(rowBytes / 256) * 256;
      const src = new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length);
      const out = new Uint8Array(rowBytes * h);
      for (let y = 0; y < h; y++) {
        const from = y * padded;
        const avail = Math.max(0, Math.min(rowBytes, src.length - from));
        if (avail > 0) out.set(src.subarray(from, from + avail), y * rowBytes);
      }
      return new Ctor(out.buffer);
    };
    const vxRaw = await renderer.backend.copyTextureToBuffer(pass.target, 0, 0, vw, vh, 0);
    const vx = unpad(vxRaw, vw, vh, 4, Uint8Array);
    const gw = screen.gbuffer.width ?? screen.width;
    const gh = screen.gbuffer.height ?? screen.height;
    const posRaw = await renderer.backend.copyTextureToBuffer(screen.gbuffer.position, 0, 0, gw, gh, 0);
    const pos = unpad(posRaw, gw, gh, 4, Float32Array);
    const sx = gw / vw, sy = gh / vh;
    let min = 255, max = 0, sum = 0, n = 0;
    for (let i = 0; i < vw * vh; i++) {
      const v = vx[i * 4];
      if (v < min) min = v; if (v > max) max = v; sum += v; n++;
    }
    const at = (p) => {
      let best = null, bestD = Infinity;
      for (let py = 0; py < vh; py++) for (let px = 0; px < vw; px++) {
        const gx = Math.min(gw - 1, Math.floor((px + 0.5) * sx));
        const gy = Math.min(gh - 1, Math.floor((py + 0.5) * sy));
        const gi = (gy * gw + gx) * 4;
        if (pos[gi + 3] < 0.5) continue;
        const dx = pos[gi] - p[0], dy = pos[gi + 1] - p[1], dz = pos[gi + 2] - p[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = { px, py, v: vx[(py * vw + px) * 4] / 255 }; }
      }
      return best ? { ...best, dist: +Math.sqrt(bestD).toFixed(3) } : null;
    };
    gpu = {
      size: [vw, vh], gbuffer: [gw, gh],
      strength: screen.vxao?.strength?.value, radius: screen.vxao?.radius?.value,
      texMin: +(min / 255).toFixed(3), texMax: +(max / 255).toFixed(3), texMean: +(sum / n / 255).toFixed(3),
      subjects: Object.fromEntries(Object.entries(subjects).map(([k, p]) => [k, at(p)])),
    };
  }

  return {
    voxel: [vox.x, vox.y, vox.z], origin: [org.x, org.y, org.z],
    res0: [res0.x, res0.y, res0.z], densityDump, occupancyB64, gpu,
    occupiedVoxels: reader.stats.occupiedVoxels,
    levelStats, occProbe, walk,
    hiddenFloor: evalPoint(subjects.hiddenFloor, true),
    openFloor: evalPoint(subjects.openFloor, true),
    contact: evalPoint(subjects.contact, false),
  };
}, VXAO_SUBJECTS);

import { writeFileSync } from "node:fs";
const dumpPath = "scripts/.gi-vxao/vxao-dump.json";
writeFileSync(dumpPath, JSON.stringify(out, null, 1));
console.log(`wrote ${dumpPath}`);
console.log(`voxel ${out.voxel?.map((v) => v.toFixed(4))} origin ${out.origin?.map((v) => v.toFixed(2))}`);
console.log(`level0 ${out.res0?.join("x")}, occupied voxels ${out.occupiedVoxels}`);
for (const s of out.levelStats ?? []) {
  console.log(` L${s.L} ${s.res.padEnd(14)} nonZero ${String(s.nonZero).padStart(8)}/${s.cells}  mean ${s.meanByte}  max ${s.maxByte}`);
}
console.log("occluder-centre density byte:", JSON.stringify(out.occProbe));
console.log("walk hiddenFloor → occluder (y=0.5, trilinear fraction):");
for (const w of out.walk ?? []) console.log(`  x ${String(w.x).padStart(6)}  L1 ${w.L1}  L2 ${w.L2}  L3 ${w.L3}`);
for (const key of ["hiddenFloor", "openFloor", "contact"]) {
  const r = out[key];
  if (!r) continue;
  console.log(`${key}: visibility ${r.visibility} :: ${r.per.map((p) => `${p.label}=${p.vis}`).join("  ")}`);
}
console.log("GPU vxao texture:", JSON.stringify(out.gpu, null, 1));
if (out.error) console.log("ERROR", out.error);
await browser.close();
