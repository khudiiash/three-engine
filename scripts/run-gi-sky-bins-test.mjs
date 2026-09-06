// THE SKY-BIN GATE — does the CPU integration land every texel in the bin the
// kernels would read, and keep its energy? (§11.52, srcSkyBins.js)
//
//   npm run test:gi-sky-bins
//
// Bare Node, no GPU: the integrator is pure arithmetic over a texel array,
// and the one thing that can go wrong with it — a convention — is exactly
// what a GPU furnace cannot see (a uniform sky reads the same through every
// convention). So the gate is built on the ASYMMETRIC cases:
//
//   · one hot texel: its whole energy must land in ONE bin, and the bin's
//     centre, rotated the way the kernels rotate it, must point back at the
//     texel — that ties the CPU's inverse rotation and row/flip orientation
//     to the GPU's forward sample;
//   · the sum of solid angles must be 4π, and a uniform map must read as
//     itself in every bin (the furnace, as the control);
//   · a fine grid aggregated onto a coarse one must equal the coarse grid
//     integrated directly (the c0/c3 tables come from one pass);
//   · half floats must decode (the RGBE loader's default type).

import {
  aggregateBins, binCentreOf, binMeanTable, createSkyBinTables, describeSun, integrateEquirectBins,
  skyLumaCeiling,
} from "../src/modules/gi/srcSkyBins.js";
import { binMorton, dirToBin } from "../src/modules/gi/srcMath.js";

let failures = 0;
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

function floatToHalf(x) {
  const f = new Float32Array([x]);
  const u = new Uint32Array(f.buffer)[0];
  const sign = (u >>> 16) & 0x8000;
  let exp = ((u >>> 23) & 0xff) - 127 + 15;
  let mant = u & 0x7fffff;
  if (exp <= 0) return sign;                       // flush tiny values
  if (exp >= 31) return sign | 0x7c00;             // overflow → inf
  return sign | (exp << 10) | (mant >>> 13);
}

function uniformSource(width, height, rgb, { half = false, channels = 4, flipY = false } = {}) {
  const n = width * height * channels;
  const data = half ? new Uint16Array(n) : new Float32Array(n);
  for (let t = 0; t < width * height; t++) {
    for (let c = 0; c < 3; c++) data[t * channels + c] = half ? floatToHalf(rgb[c]) : rgb[c];
    if (channels === 4) data[t * channels + 3] = half ? floatToHalf(1) : 1;
  }
  return { data, width, height, channels, half, flipY };
}

// The kernels' rotation: rd = (d.x·cr + d.z·sr, d.y, d.z·cr − d.x·sr).
function rotateForward([x, y, z], yaw) {
  const cr = Math.cos(yaw), sr = Math.sin(yaw);
  return [x * cr + z * sr, y, z * cr - x * sr];
}
function rotateInverse([x, y, z], yaw) {
  const cr = Math.cos(yaw), sr = Math.sin(yaw);
  return [x * cr - z * sr, y, x * sr + z * cr];
}
// three's equirectUV inverse for the GPU-space texel (col, gpuRow).
function texelDirection(col, gpuRow, width, height) {
  const v = (gpuRow + 0.5) / height;
  const el = (v - 0.5) * Math.PI;
  const az = ((col + 0.5) / width - 0.5) * 2 * Math.PI;
  return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
}
const angleBetween = (a, b) => {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
};

// ── A. the furnace: a uniform map reads as itself in every bin ──────────────
for (const w of [4, 32]) {
  for (const yaw of [0, 1.3, -2.7]) {
    const src = uniformSource(256, 128, [1, 2, 3]);
    const bins = integrateEquirectBins(src, { yaw, w, maxColumns: 256 });
    const table = binMeanTable(bins);
    let worst = 0;
    let omega = 0;
    for (let m = 0; m < 2 * w * w; m++) {
      omega += bins.omega[m];
      worst = Math.max(worst, Math.abs(table[m * 4] - 1), Math.abs(table[m * 4 + 1] - 2), Math.abs(table[m * 4 + 2] - 3));
      if (table[m * 4 + 3] !== 1) worst = Infinity;
    }
    check(`furnace w=${w} yaw=${yaw}: every bin = (1,2,3)`, worst < 1e-5, `worst |Δ| ${worst.toExponential(2)}`);
    check(`furnace w=${w} yaw=${yaw}: Σ solid angle = 4π`, near(omega, 4 * Math.PI, 2e-4), `${omega.toFixed(5)} vs ${(4 * Math.PI).toFixed(5)}`);
  }
}

// ── B. one hot texel: one bin, all the energy, and the bin looks back at it ──
{
  const W = 512, H = 256;
  const cases = [
    { col: 300, row: 96, flipY: true, yaw: 0 },
    { col: 300, row: 96, flipY: false, yaw: 0 },
    { col: 77, row: 140, flipY: true, yaw: 1.9 },
    { col: 420, row: 60, flipY: true, yaw: -0.8 },
  ];
  for (const { col, row, flipY, yaw } of cases) {
    for (const w of [4, 32]) {
      const src = uniformSource(W, H, [0, 0, 0], { flipY });
      src.data[(row * W + col) * 4] = 1e5;            // file-row addressing
      const bins = integrateEquirectBins(src, { yaw, w, maxColumns: W });
      const gpuRow = flipY ? H - 1 - row : row;
      const t = texelDirection(col, gpuRow, W, H);
      const d = rotateInverse(t, yaw);
      const { i, j } = dirToBin(d[0], d[1], d[2], w);
      const expectM = binMorton(i, j);
      let hot = -1, hotCount = 0, energy = 0;
      for (let m = 0; m < 2 * w * w; m++) {
        if (bins.sum[m * 3] > 0) { hot = m; hotCount++; energy += bins.sum[m * 3]; }
      }
      const el = ((gpuRow + 0.5) / H - 0.5) * Math.PI;
      const dOmega = (2 * Math.PI / W) * (Math.PI / H) * Math.cos(el);
      const tag = `hot texel (${col},${row}) flipY=${flipY} yaw=${yaw} w=${w}`;
      check(`${tag}: one bin, the expected one`, hotCount === 1 && hot === expectM, `bins lit ${hotCount}, got ${hot}, expected ${expectM}`);
      check(`${tag}: energy preserved`, near(energy, 1e5 * dOmega, 1e-5), `${energy.toExponential(6)} vs ${(1e5 * dOmega).toExponential(6)}`);
      // The GPU would tap the env at R(yaw)·binCentre — that direction must
      // lie inside the bin that received the texel, i.e. within the bin's
      // angular extent of the texel. Equal-area bins: at w=32 a bin is ≤ 6°
      // across away from the grid poles; w=4 bins are ~45°.
      const rd = rotateForward(binCentreOf(hot, w), yaw);
      const ang = angleBetween(rd, t);
      const limit = w === 32 ? 8 : 50;
      check(`${tag}: rotated bin centre points back at the texel`, ang <= limit, `${ang.toFixed(2)}° (limit ${limit}°)`);
    }
  }
  // Block pre-summing (the 2k-map path): energy exact, bin unchanged for a
  // texel that is not on a bin border.
  const src = uniformSource(W, H, [0, 0, 0], { flipY: true });
  src.data[(96 * W + 300) * 4] = 1e5;
  const fine = integrateEquirectBins(src, { yaw: 0.4, w: 32, maxColumns: W });
  const blocked = integrateEquirectBins(src, { yaw: 0.4, w: 32, maxColumns: W / 4 });
  let sameBin = true, eFine = 0, eBlocked = 0;
  for (let m = 0; m < 2 * 32 * 32; m++) {
    eFine += fine.sum[m * 3]; eBlocked += blocked.sum[m * 3];
    if ((fine.sum[m * 3] > 0) !== (blocked.sum[m * 3] > 0)) sameBin = false;
  }
  check("block pre-summing keeps the energy and the bin", sameBin && near(eFine, eBlocked, 1e-6), `${eFine.toExponential(5)} vs ${eBlocked.toExponential(5)}`);
}

// ── C. aggregation: fine → coarse equals coarse integrated directly ─────────
{
  const W = 256, H = 128;
  const src = uniformSource(W, H, [0, 0, 0]);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let t = 0; t < W * H; t++) {
    src.data[t * 4] = rnd(); src.data[t * 4 + 1] = rnd() * 3; src.data[t * 4 + 2] = rnd() < 0.001 ? 5000 : rnd();
  }
  const fine = integrateEquirectBins(src, { yaw: 0.7, w: 32, maxColumns: W });
  const agg = binMeanTable(aggregateBins(fine, 4));
  const direct = binMeanTable(integrateEquirectBins(src, { yaw: 0.7, w: 4, maxColumns: W }));
  let worst = 0;
  for (let k = 0; k < agg.length; k++) worst = Math.max(worst, Math.abs(agg[k] - direct[k]) / Math.max(1e-6, Math.abs(direct[k])));
  check("aggregate(w=32 → 4) equals direct w=4", worst < 1e-4, `worst rel Δ ${worst.toExponential(2)}`);
}

// ── D. half floats decode ──────────────────────────────────────────────────
for (const value of [0.25, 1, 4, 1024, 65504]) {
  const src = uniformSource(64, 32, [value, value / 2, 0], { half: true });
  const table = binMeanTable(integrateEquirectBins(src, { w: 4, maxColumns: 64 }));
  check(`half float ${value} decodes`, near(table[0], value, 1e-3) && near(table[1], value / 2, 1e-3) && table[2] === 0, `read ${table[0]}, ${table[1]}, ${table[2]}`);
}
{
  const src = uniformSource(64, 32, [2, 2, 2], { channels: 3 });
  const table = binMeanTable(integrateEquirectBins(src, { w: 4, maxColumns: 64 }));
  check("RGB (3-channel) source reads", near(table[0], 2, 1e-6) && near(table[2], 2, 1e-6));
}

// ── E. the table manager: builds, keys, throttle, late widths, fallback ────
{
  let clock = 0;
  const mgr = createSkyBinTables({ minIntervalMs: 100, maxColumns: 256, now: () => clock });
  const b1 = mgr.beginBuild();
  const t4 = b1.tableFor(4);
  check("manager: a table before any update is not ready", t4.ready.value === 0);
  check("manager: a build's view publishes its attributes", b1.storageAttributes.length === 1 && b1.storageAttributes[0] === t4.node.value);
  const src = uniformSource(256, 128, [0.5, 1, 2]);
  const ran = mgr.update(src, 0, "tex:1");
  check("manager: first update integrates and fills", ran && mgr.runs === 1 && t4.ready.value === 1 && near(t4.array[1], 1, 1e-6) && near(t4.array[2], 2, 1e-6), `runs ${mgr.runs}, ready ${t4.ready.value}, g ${t4.array[1]}`);
  check("manager: same key does not re-run", mgr.update(src, 0, "tex:1") === false && mgr.runs === 1);
  clock = 50;
  check("manager: a yaw change inside the throttle window is deferred", mgr.update(src, 0.3, "tex:1") === false && mgr.runs === 1);
  clock = 200;
  check("manager: the deferred change runs once the window passes", mgr.update(src, 0.3, "tex:1") === true && mgr.runs === 2);
  const t32 = b1.tableFor(32);
  check("manager: a wider table asked after an integration waits, not ready", t32.ready.value === 0);
  clock = 400;
  mgr.update(src, 0.3, "tex:1");
  check("manager: the next update fills the wider table and keeps the narrow one", mgr.runs === 3 && t32.ready.value === 1 && t4.ready.value === 1 && near(t32.array[0], 0.5, 1e-6) && near(t4.array[0], 0.5, 1e-6), `runs ${mgr.runs}, ready ${t32.ready.value}/${t4.ready.value}`);
  // A second build (a GI rebuild) gets ITS OWN attributes, filled at once
  // from the cached integration — never the first build's, which the
  // teardown is about to retire.
  const b2 = mgr.beginBuild();
  const t4b = b2.tableFor(4);
  check("manager: a rebuild's table is a different attribute", t4b.node.value !== t4.node.value && b2.storageAttributes[0] === t4b.node.value);
  check("manager: a rebuild's table is filled from the cache at once", t4b.ready.value === 1 && near(t4b.array[2], 2, 1e-6) && mgr.runs === 3, `ready ${t4b.ready.value}, runs ${mgr.runs}`);
  clock = 600;
  mgr.update(null, 0.3, null);
  check("manager: an unreadable source drops every build's tables to the texture tap", t4.ready.value === 0 && t32.ready.value === 0 && t4b.ready.value === 0);
  clock = 800;
  mgr.update(src, 0.3, "tex:2");
  check("manager: a new texture version refills both builds", t4.ready.value === 1 && t32.ready.value === 1 && t4b.ready.value === 1 && mgr.runs === 5, `runs ${mgr.runs}`);
  const b3 = mgr.beginBuild();
  b3.tableFor(4);
  check("manager: only the last two builds are kept", mgr.builds === 2);
  // `needsUpdate` is a setter that bumps `version`; the upload path keys on it.
  check("manager: the GPU node sees the same array and was marked for upload", t4b.node.value.array === t4b.array && t4b.node.value.version > 0, `version ${t4b.node.value.version}`);
}

// ── G. §11.53: THE SUN IS NOT SKY ──────────────────────────────────────────
//
// A uniform sky with one hot spot above the horizon. The ceiling must sit
// above the sky and below the spot; the excess must be exactly the spot's
// energy above the ceiling, point back at it in the WORLD frame (the yaw
// undone), and the extracted table must be the furnace again except for the
// spot's own bin, which reads the CEILING there (a clamped texel is not a
// hole). A wide bright region is sky, not a sun; aggregation carries the
// per-bin excess; the manager extracts by default and keeps on the hatch.
{
  const W = 256, H = 128;
  const setTexel = (src, fileRow, col, v) => {
    const o = (fileRow * W + col) * 4;
    src.data[o] = v; src.data[o + 1] = v; src.data[o + 2] = v;
  };
  for (const { yaw, flipY } of [{ yaw: 0, flipY: true }, { yaw: 1.1, flipY: true }, { yaw: -2.2, flipY: false }]) {
    const src = uniformSource(W, H, [1, 1, 1], { flipY });
    const col = 200, gpuRow = 100;                                 // elevation +50.6°
    setTexel(src, flipY ? H - 1 - gpuRow : gpuRow, col, 1e4);
    const { ceiling, percentileLuma } = skyLumaCeiling(src, { stride: 1 });
    const tag = `sun yaw=${yaw} flipY=${flipY}`;
    check(`${tag}: the ceiling sits between the sky and the spot`, ceiling > 1 && ceiling < 1e4 && near(percentileLuma, 1, 0.02), `ceiling ${ceiling.toFixed(3)}, p99.9 ${percentileLuma.toFixed(4)}`);
    const bins = integrateEquirectBins(src, { yaw, w: 32, maxColumns: W, ceiling });
    const sun = describeSun(bins);
    const el = ((gpuRow + 0.5) / H - 0.5) * Math.PI;
    const dOmega = (2 * Math.PI / W) * (Math.PI / H) * Math.cos(el);
    check(`${tag}: the excess is the spot's energy above the ceiling`, near(sun.energy, (1e4 - ceiling) * dOmega, 1e-3) && sun.texels === 1, `${sun.energy.toExponential(4)} vs ${((1e4 - ceiling) * dOmega).toExponential(4)}, texels ${sun.texels}`);
    const dWorld = rotateInverse(texelDirection(col, gpuRow, W, H), yaw);
    check(`${tag}: its direction is the spot's, in the world frame`, angleBetween(sun.dir, dWorld) < 1, `${angleBetween(sun.dir, dWorld).toFixed(2)}°`);
    check(`${tag}: elevation reads the spot's`, near(sun.elevationDeg, el * 180 / Math.PI, 0.02), `${sun.elevationDeg.toFixed(2)}° vs ${(el * 180 / Math.PI).toFixed(2)}°`);
    check(`${tag}: present (share ≥ 2 %)`, sun.present && sun.share > 0.02, `share ${(sun.share * 100).toFixed(1)} %`);
    const kept = binMeanTable(bins);
    const extracted = binMeanTable(bins, null, { sun: "extract" });
    let hot = -1;
    for (let m = 0; m < 2 * 32 * 32; m++) if (bins.sun.binOmega[m] > 0) hot = m;
    let worst = 0;
    for (let m = 0; m < 2 * 32 * 32; m++) {
      if (m === hot) continue;
      worst = Math.max(worst, Math.abs(extracted[m * 4] - 1), Math.abs(extracted[m * 4 + 1] - 1), Math.abs(extracted[m * 4 + 2] - 1));
    }
    const hotExpect = (bins.omega[hot] - dOmega + ceiling * dOmega) / bins.omega[hot];
    check(`${tag}: the extracted table is the furnace again`, hot >= 0 && worst < 1e-5, `worst |Δ| ${worst.toExponential(2)}`);
    check(`${tag}: the spot's bin reads the ceiling, not a hole`, near(extracted[hot * 4], hotExpect, 1e-3), `${extracted[hot * 4].toFixed(4)} vs ${hotExpect.toFixed(4)}`);
    check(`${tag}: the kept table still carries the spot`, kept[hot * 4] > 10 * extracted[hot * 4], `${kept[hot * 4].toFixed(2)} vs ${extracted[hot * 4].toFixed(4)}`);
  }
  {
    // A cloud bank: a 21-row band at 10× the sky is 5 % of the sphere — sky.
    const src = uniformSource(W, H, [1, 1, 1], { flipY: true });
    for (let fr = 17; fr <= 37; fr++) for (let x = 0; x < W; x++) setTexel(src, fr, x, 10);
    const { ceiling } = skyLumaCeiling(src, { stride: 1 });
    check("cloud bank: the ceiling clears a wide bright region", ceiling > 10, `ceiling ${ceiling.toFixed(2)}`);
    const bins = integrateEquirectBins(src, { w: 32, maxColumns: W, ceiling });
    const sun = describeSun(bins);
    check("cloud bank: nothing is a sun", !sun.present && sun.energy === 0, `share ${sun.share}, energy ${sun.energy}`);
    const table = binMeanTable(bins, null, { sun: "extract" });
    let peak = 0;
    for (let m = 0; m < 2 * 32 * 32; m++) peak = Math.max(peak, table[m * 4]);
    check("cloud bank: the extracted table is the whole map", near(peak, 10, 1e-5), `peak ${peak.toFixed(4)}`);
  }
  {
    // Aggregation carries the per-bin excess exactly.
    const src = uniformSource(W, H, [1, 1, 1], { flipY: true });
    setTexel(src, 30, 100, 5e3);
    const { ceiling } = skyLumaCeiling(src, { stride: 1 });
    const fine = integrateEquirectBins(src, { yaw: 0.5, w: 32, maxColumns: W, ceiling });
    const agg = aggregateBins(fine, 4);
    const direct = integrateEquirectBins(src, { yaw: 0.5, w: 4, maxColumns: W, ceiling });
    let worst = 0;
    for (let m = 0; m < 32; m++) {
      worst = Math.max(worst, Math.abs(agg.sun.sum[m * 3] - direct.sun.sum[m * 3]), Math.abs(agg.sun.binOmega[m] - direct.sun.binOmega[m]));
    }
    check("aggregate carries the sun's per-bin excess", worst < 1e-6 && agg.sun.energy === fine.sun.energy && agg.eUp === fine.eUp, `worst |Δ| ${worst.toExponential(2)}`);
  }
  {
    // The manager: extract by default, keep on the hatch, and the receipt names it.
    let clock = 0;
    const mgr = createSkyBinTables({ minIntervalMs: 100, maxColumns: 256, now: () => clock });
    const t4 = mgr.beginBuild().tableFor(4);
    const src = uniformSource(W, H, [1, 1, 1], { flipY: true });
    setTexel(src, 30, 100, 1e4);
    mgr.update(src, 0, "sun:1");
    const first = mgr.last;
    check("manager: a sunny map fills in extract mode", mgr.mode === "extract" && first.sun.extracted && first.sun.present, `mode ${mgr.mode}`);
    let peak = 0;
    for (let m = 0; m < 32; m++) peak = Math.max(peak, t4.array[m * 4]);
    check("manager: the extracted table's brightest bin is the sky", peak < 1.5, `peak ${peak.toFixed(3)}`);
    check("manager: the receipt's peak is the table's", near(first.peakBinLuma, peak, 1e-3), `${first.peakBinLuma.toFixed(4)} vs ${peak.toFixed(4)}`);
    check("manager: sky irradiance = whole − sun when extracted", near(first.skyUpIrradianceLuma, first.upIrradianceLuma - first.sun.upIrradiance, 1e-6) && first.sun.upIrradiance > 0);
    clock += 200;
    const ran = mgr.update(src, 0, "sun:1", { extractSun: false });
    check("manager: the hatch off re-integrates and keeps the sun", ran && mgr.mode === "keep" && !mgr.last.sun.extracted && mgr.last.sun.present && mgr.runs === 2, `mode ${mgr.mode}, runs ${mgr.runs}`);
    let peak2 = 0;
    for (let m = 0; m < 32; m++) peak2 = Math.max(peak2, t4.array[m * 4]);
    check("manager: the kept table carries the spot", peak2 > 10 * peak && near(mgr.last.skyUpIrradianceLuma, mgr.last.upIrradianceLuma, 1e-9), `peak ${peak2.toFixed(3)} vs ${peak.toFixed(3)}`);
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
