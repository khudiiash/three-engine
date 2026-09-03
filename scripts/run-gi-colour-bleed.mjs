// WHERE DOES THE COLOUR GO? — tracing chromaticity from material to probe.
//
//   npx vite --port 5201        (in another terminal)
//   node scripts/run-gi-colour-bleed.mjs
//   PROJECT=C:/path SETTLE=35000 QUALITY=medium node scripts/run-gi-colour-bleed.mjs
//
// ══ WHY ═════════════════════════════════════════════════════════════════════
//
// `test:gi-probe-density` measured the live probe field on the user's cafe and
// found something nobody was looking for: it is **nearly monochromatic**.
// Chromaticity error between a probe and its own neighbours is p50 = 0.003, and
// a RANDOM probe from anywhere in the scene predicts any probe's colour within
// 0.05 in 94% of cases. Their Cycles reference shows obvious red bleeding from
// the awnings onto the fascia and the wall opposite; ours shows none.
//
// So the red is not being lost to probe resolution — it never arrives. This rig
// walks the chain from the authored material to the probe bins and says WHICH
// LINK drops the chroma. There are three candidates and they are distinguishable:
//
//   1. THE MATERIAL. `resolveMaterialSurface` returns the albedo GI will use.
//      If the awning already resolves grey — a texture-driven base colour, a
//      thin mesh sharing a record with its neutral underside — nothing
//      downstream can be coloured.
//   2. THE PALETTE. Attribution stamps a slot id per surface record and the
//      palette holds one albedo per slot. If the materials are colourful and the
//      palette is grey, the leak is the palette write or the record pool
//      (§12.25: a starved pool shades at the palette MEAN, which is grey by
//      construction — exactly this symptom).
//   3. THE TRANSPORT. If the palette is colourful and the probes are not, the
//      chroma is being diluted after the bounce — most likely by sky and sun
//      dominating each probe's bins, which would also explain the render being
//      brighter AND greyer than the reference rather than just greyer.
//
// The decisive comparison is (1) vs (2) vs (4=probes) side by side, in the same
// units, from the same frame. `unattributedRate` and the albedo-clamp tally are
// read alongside because both are known ways for a colour to become a mean.
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SETTLE = Number(process.env.SETTLE ?? 35000);
const QUALITY = process.env.QUALITY ?? "medium";
const GI_GLOBALS = process.env.GI_GLOBALS_JSON
  ? JSON.parse(process.env.GI_GLOBALS_JSON)
  : {};
const SCENE = (process.env.SCENE ?? `${PROJECT}/main.scene`).replaceAll("\\", "/");
const OUT = ".gi-shots/colour-bleed";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const DEFAULT_POSE = {
  position: [-12.180572876603646, 2.377470686992635, -0.8876293701536424],
  target: [5.121504134069502, 1.85371217060508, -1.7807895055111131],
};
// A focused scene can provide its saved camera without editing this Bistro
// fixture. Kept as JSON so position and target remain one atomic input.
const POSE = process.env.POSE_JSON ? JSON.parse(process.env.POSE_JSON) : DEFAULT_POSE;

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
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {}); // no writableRoot — the project is read-only

let built = false;
const giLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/^\[gi\]/.test(t)) giLines.push(t);
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene|refusing write|rapier/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});

await page.evaluateOnNewDocument((project, quality, globals) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  if (quality) globalThis.__giConfigOverride = { quality };
  for (const [key, value] of Object.entries(globals)) globalThis[key] = value;
}, PROJECT, QUALITY, GI_GLOBALS);

console.log(`opening ${PROJECT} (read-only), quality ${QUALITY}`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
// A project remembers its last-open scene globally. Opening the project alone
// can therefore measure a previous project's Sponza while confidently labeling
// the result GAME; always name the requested scene before waiting for GI.
built = false;
const opened = await page.evaluate(async (scene) => globalThis.__editorApi.call("scene.open", { path: scene }), SCENE);
if (opened?.ok === false) throw new Error(`scene.open ${SCENE}: ${opened.error}`);
for (let i = 0; i < 300 && !built; i++) {
  await wait(1000);
  if (i % 20 === 19) console.log(`  waiting for the GI build… ${i + 1}s`);
}
if (!built) throw new Error("the GI build never completed");

await page.evaluate(async (p) => {
  await globalThis.__editorApi.call("viewport.setCamera", p);
}, POSE);
console.log(`settling ${(SETTLE / 1000).toFixed(0)}s…`);
await wait(SETTLE);

const data = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const ids = await api.call("entity.list", {});
  const anyId = (ids.value ?? ids)?.[0]?.id;
  const engine = api.entities.live(anyId)?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const out = { errors: [] };

  // ── LINK 1: THE MATERIALS, as GI itself resolves them ────────────────────
  // Imported dynamically so this rig uses the SAME resolver the voxel path and
  // the light tree use — reading `material.color` instead would be a different
  // question, and for engine material assets it is often a stale black.
  try {
    const mod = await import("/src/modules/gi/voxelizeOnce.js");
    const resolve = mod.resolveMaterialSurface;
    const mats = [];
    const reds = [];
    engine.scene.traverse((o) => {
      if (!o.isMesh || o.userData?.__giDebug) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m) return;
      let area = 0;
      const pos = o.geometry?.attributes?.position;
      if (pos) area = pos.count; // vertex count as a cheap size proxy
      try {
        // `{ color, emissive, emissiveIntensity }` — `color` IS the bounce
        // albedo, already multiplied by the base map's average.
        const c = resolve(m, o.name)?.color ?? null;
        if (!c) return;
        const r = c.r ?? 0, gg = c.g ?? 0, bb = c.b ?? 0;
        mats.push([r, gg, bb, area]);
        // ── THE RED SURFACES, with world bounds. These are the sources the
        // bleed is supposed to come from, found by their own resolved albedo
        // rather than by name — the awnings are `mesh` like everything else in
        // this GLB, so a name match would find nothing.
        // ⚠ THIS THRESHOLD WAS FAR TOO PERMISSIVE AT FIRST — `sat > 0.35` and
        // `r >= g,b` matched 198 surfaces, and Bistro is a WARM scene: terracotta,
        // wood chairs, sandstone all pass. 7130 of 9846 probes then landed in the
        // "within 0.5 m of a red surface" bucket and only FOUR in "beyond 12 m",
        // so the near/far comparison was near-vs-nothing. A "red surface" has to
        // mean the awnings, not everything that is not blue: red must dominate
        // both other channels outright.
        const mx = Math.max(r, gg, bb);
        if (mx > 0.08 && r > gg * 1.8 && r > bb * 1.8 && (mx - Math.min(r, gg, bb)) / mx > 0.5) {
          o.updateWorldMatrix(true, false);
          const g2 = o.geometry;
          if (!g2.boundingBox) g2.computeBoundingBox();
          const bmin = g2.boundingBox.min.clone().applyMatrix4(o.matrixWorld);
          const bmax = g2.boundingBox.max.clone().applyMatrix4(o.matrixWorld);
          reds.push({
            c: [(bmin.x + bmax.x) / 2, (bmin.y + bmax.y) / 2, (bmin.z + bmax.z) / 2],
            h: [Math.abs(bmax.x - bmin.x) / 2, Math.abs(bmax.y - bmin.y) / 2, Math.abs(bmax.z - bmin.z) / 2],
            rgb: [r, gg, bb],
          });
        }
      } catch { /* one material must not fail the walk */ }
    });
    out.materials = mats;
    out.reds = reds;
    // ⚠ THE LIVE CHROMA DIAL. §13.7b added `__giBounceSaturation` to damp bounce
    // chroma toward luminance — built for the OPPOSITE complaint ("dirty colors",
    // 2026-08-16, saturated blotches on neutral stone). Default 1 = untouched,
    // but if anything has set it below 1 then every number below is explained
    // and the answer is a dial, not a bug. Read it, do not assume it.
    out.bounceSaturation = globalThis.__giBounceSaturation ?? null;
    out.noTextureTint = globalThis.__giNoTextureTint ?? null;
  } catch (e) {
    out.errors.push(`material walk: ${e.message}`);
  }

  // ── LINK 2: THE PALETTE ─────────────────────────────────────────────────
  // The CPU side is a uniformArray of Vector4 pairs (albedo, emission) per
  // slot, so no GPU readback is needed — this is exactly what the palette pass
  // uploads.
  // `state.volume.occupancyField` — the ONE path. The first run guessed three
  // wrong ones, reported "no palette reachable", and then fell through the
  // verdict tree below because the tree was gated on a link the rig had failed
  // to find. A missing input must not read as an inconclusive result.
  const field = sys?.state?.volume?.occupancyField ?? null;
  const attr = field?.surfaceAttribution ?? null;
  if (attr?.paletteUniform) {
    const arr = attr.paletteUniform.array ?? attr.paletteUniform.value ?? [];
    const pal = [];
    for (let s = 0; s < attr.paletteSlots; s++) {
      const a = arr[s * 2];
      if (!a) continue;
      pal.push([a.x ?? 0, a.y ?? 0, a.z ?? 0, a.w ?? 0]);
    }
    out.palette = pal;
    out.paletteSlots = attr.paletteSlots;
    out.recordCapacity = attr.recordCapacity;
  } else {
    out.errors.push(`no palette reachable (field=${!!field} attr=${!!attr})`);
  }

  // ── LINK 3: THE DEPOSIT TALLIES ─────────────────────────────────────────
  const src = sys?.state?.screen?.srcProbes;
  try {
    if (src?.deposit?.readStats) out.deposit = await src.deposit.readStats(engine.renderer);
  } catch (e) { out.errors.push(`deposit stats: ${e.message}`); }

  // The hit list is the exact surface signal crossing [E] -> [J]. It already
  // exists in the tail of the bin scratch store, so reading it here adds no GI
  // resource or production instrumentation. Keep the values as native f32;
  // RGBA8 would erase the small chromatic remainder this rig is looking for.
  try {
    if (src?.binStore?.scratch && src.binStore.hitCapacity > 0) {
      const dep = await import("/src/modules/gi/srcDeposit.js");
      const words = new Uint32Array(await engine.renderer.getArrayBufferAsync(src.binStore.scratch.value));
      const count = Math.min(words[src.binStore.hitListBase] >>> 0, src.binStore.hitCapacity);
      const bits = new ArrayBuffer(4), bv = new DataView(bits);
      const asFloat = (u) => { bv.setUint32(0, u >>> 0, true); return bv.getFloat32(0, true); };
      const ownerOf = (slotWord) => {
        let owner = 0;
        for (let c = 1; c < src.binStore.cascades.length; c++) {
          if (slotWord >= src.binStore.cascades[c].binBase * dep.BIN_WORDS) owner = c;
        }
        return owner;
      };
      const all = [0, 1, 2, 3].map(() => ({ n: 0, red: 0, rho: [0, 0, 0], cos: 0 }));
      const sunIdx = sys?.state?.sunSlot?.value ?? -1;
      const sun = sys?.state?.lightSlots?.[sunIdx] ?? null;
      const sv = sun?.vector?.value;
      const sd = sv ? [sv.x ?? 0, sv.y ?? 0, sv.z ?? 0] : [0, 0, 0];
      for (let i = 0; i < count; i++) {
        const e = src.binStore.hitListBase + 1 + i * dep.SEC_HIT_WORDS;
        const rho = [asFloat(words[e + dep.SEC_RHO]), asFloat(words[e + dep.SEC_RHO + 1]), asFloat(words[e + dep.SEC_RHO + 2])];
        const n = [asFloat(words[e + dep.SEC_N]), asFloat(words[e + dep.SEC_N + 1]), asFloat(words[e + dep.SEC_N + 2])];
        const owner = ownerOf(words[e + dep.SEC_SLOT] >>> 0);
        const a = all[owner] ?? all[0];
        a.n++;
        a.rho[0] += rho[0]; a.rho[1] += rho[1]; a.rho[2] += rho[2];
        const red = rho[0] > 0.08 && rho[0] > rho[1] * 1.8 && rho[0] > rho[2] * 1.8;
        if (red) {
          a.red++;
          a.cos += Math.max(0, n[0] * sd[0] + n[1] * sd[1] + n[2] * sd[2]);
        }
      }
      out.hitSignal = {
        count,
        sun: { index: sunIdx, direction: sd, color: sun?.color?.value ? [sun.color.value.r, sun.color.value.g, sun.color.value.b] : [0, 0, 0] },
        cascades: all.map((a, cascade) => ({
          cascade, n: a.n, red: a.red,
          redPct: a.n ? 100 * a.red / a.n : 0,
          meanRho: a.n ? a.rho.map((v) => v / a.n) : [0, 0, 0],
          meanRedSunCos: a.red ? a.cos / a.red : 0,
        })),
      };
    }
  } catch (e) { out.errors.push(`native hit list: ${e.message}`); }

  // ── LINK 4: THE PROBES ──────────────────────────────────────────────────
  if (src?.store && src?.binStore) {
    const store = src.store, binStore = src.binStore;
    const table = new Uint32Array(await engine.renderer.getArrayBufferAsync(store.probeTable.value));
    // Packed halves (plan §11.4 A1) — the store decodes to 4 channels per bin.
    const payload = binStore.decodePayload(await engine.renderer.getArrayBufferAsync(binStore.payload.value));
    const PW = 8, P_FLAGS = 2, P_BLOCK = 7, ALIVE = 1, EMPTY = 0xffffffff;
    const probes = [];
    for (const c of store.cascades) {
      const bc = binStore.cascades.find((b) => b.cascade === c.cascade);
      if (!bc) continue;
      for (let i = 0; i < c.probeCapacity; i++) {
        const base = (c.probeBase + i) * PW;
        if (!(table[base + P_FLAGS] & ALIVE)) continue;
        const block = table[base + P_BLOCK];
        if (block === EMPTY || block >= bc.blockCapacity) continue;
        let r = 0, g = 0, b = 0, n = 0;
        // PER-BIN chroma too: a probe's DIRECTIONAL bins are where a red bounce
        // from one side would live. Averaging over direction first is exactly
        // how a red patch on one wall becomes a grey mean, so the peak-saturation
        // bin is reported separately from the probe's mean.
        let bestSat = 0, bestBin = null;
        const bb = bc.binBase + block * bc.bins;
        for (let d = 0; d < bc.bins; d++) {
          const w = (bb + d) * 4;
          if (!(payload[w + 3] >= 0)) continue;
          const br = payload[w], bg = payload[w + 1], bl = payload[w + 2];
          r += br; g += bg; b += bl; n++;
          const mx = Math.max(br, bg, bl), mn = Math.min(br, bg, bl);
          if (mx > 1e-5) {
            const sat = (mx - mn) / mx;
            if (sat > bestSat) { bestSat = sat; bestBin = [br, bg, bl]; }
          }
        }
        if (n === 0) continue;
        probes.push([c.cascade, r / n, g / n, b / n, bestSat, ...(bestBin ?? [0, 0, 0]), table[base + 0], block]);
      }
    }
    out.probes = probes;
    // The lattice anchor, so a key's CELL can be turned back into a world
    // position — see the `anchor` accessor's note in srcSystem.js.
    out.anchor = src.anchor ?? null;
    out.spacing0 = src.spacing0 ?? null;
  } else {
    out.errors.push("no live SRC probe store");
  }

  // ── LINKS 5/6: THE ACTUAL SCREEN INTEGRAL ────────────────────────────────
  // Probe-bin means are intentionally directionless; a receiver samples a
  // cosine hemisphere, so read the real screen gather and the resolve target
  // before concluding that a colourful field makes a colourful image.
  try {
    const unpad = (raw, w, h, comps, Ctor) => {
      const rowBytes = w * comps * Ctor.BYTES_PER_ELEMENT;
      const padded = Math.ceil(rowBytes / 256) * 256;
      const srcBytes = new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length);
      const dst = new Uint8Array(rowBytes * h);
      for (let y = 0; y < h; y++) {
        const from = y * padded;
        const available = Math.max(0, Math.min(rowBytes, srcBytes.length - from));
        if (available > 0) dst.set(srcBytes.subarray(from, from + available), y * rowBytes);
      }
      return new Ctor(dst.buffer);
    };
    const f16 = (h) => {
      const s = (h & 0x8000) ? -1 : 1;
      const e = (h >> 10) & 0x1f;
      const m = h & 0x3ff;
      if (e === 0) return s * m * 2 ** -24;
      if (e === 31) return m ? NaN : s * Infinity;
      return s * (m + 1024) * 2 ** (e - 25);
    };
    const gposTex = sys?.state?.screen?.gbuffer?.position ?? null;
    const gw = gposTex?.image?.width ?? 0;
    const gh = gposTex?.image?.height ?? 0;
    const gpos = gposTex && gw && gh
      ? unpad(await engine.renderer.backend.copyTextureToBuffer(gposTex, 0, 0, gw, gh, 0), gw, gh, 4, Float32Array)
      : null;
    const finish = (a) => {
      if (!a.n) return { n: 0, rgb: [0, 0, 0], sat: 0, meanSat: 0, rg: 0 };
      const rgb = [a.r / a.n, a.g / a.n, a.b / a.n];
      const mx = Math.max(...rgb);
      return {
        n: a.n,
        rgb,
        sat: mx > 1e-6 ? (mx - Math.min(...rgb)) / mx : 0,
        meanSat: a.sat / a.n,
        rg: rgb[1] > 1e-6 ? rgb[0] / rgb[1] : 0,
      };
    };
    const add = (a, r, g, b) => {
      const mx = Math.max(r, g, b);
      a.r += r; a.g += g; a.b += b; a.n++;
      a.sat += mx > 1e-6 ? (mx - Math.min(r, g, b)) / mx : 0;
    };
    const summarizeTexture = async (texture, label) => {
      if (!texture) return null;
      const w = texture.image?.width ?? texture.width ?? 0;
      const h = texture.image?.height ?? texture.height ?? 0;
      if (!w || !h) return null;
      // Native rgba16f avoids the diagnostic blit's rgba8 clamp: this scene's
      // sun drives the gather above 1, where clipping each channel made a red
      // sample look white before the statistic ever saw it.
      const raw = await engine.renderer.backend.copyTextureToBuffer(texture, 0, 0, w, h, 0);
      const px = unpad(raw, w, h, 4, Uint16Array);
      let r = 0, g = 0, b = 0, n = 0, satSum = 0, strong = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (!(f16(px[i + 3]) > 0)) continue;
        const cr = f16(px[i]), cg = f16(px[i + 1]), cb = f16(px[i + 2]);
        if (![cr, cg, cb].every(Number.isFinite)) continue;
        const mx = Math.max(cr, cg, cb);
        if (!(mx > 1e-5)) continue;
        const s = (mx - Math.min(cr, cg, cb)) / mx;
        r += cr; g += cg; b += cb; satSum += s; strong += s > 0.25 ? 1 : 0; n++;
      }
      const regions = {};
      if (gpos) {
        const accum = new Map();
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const gx = Math.min(gw - 1, Math.floor((x + 0.5) * gw / w));
          const gy = Math.min(gh - 1, Math.floor((y + 0.5) * gh / h));
          const go = (gy * gw + gx) * 4;
          if (!(gpos[go + 3] > 0.5)) continue;
          const p = [gpos[go], gpos[go + 1], gpos[go + 2]];
          const o = (y * w + x) * 4;
          if (!(f16(px[o + 3]) > 0)) continue;
          const c = [f16(px[o]), f16(px[o + 1]), f16(px[o + 2])];
          if (!c.every(Number.isFinite)) continue;
          const names = [];
          if (Math.abs(p[1]) < 0.08) {
            names.push("floor:all");
            if (p[2] < -2) names.push("floor:z<-2");
            else if (p[2] < 0) names.push("floor:-2..0");
            else if (p[2] < 1) names.push("floor:0..1");
            else if (p[2] < 2.3) names.push("floor:1..2.3");
            if (Math.abs(p[0]) < 1.5) names.push("floor:centre");
            else names.push("floor:side");
          }
          if (Math.abs(p[2] - 1.7661) < 0.08) names.push("red:front");
          if (Math.abs(p[2] - 0.3334) < 0.08) names.push("white:front");
          for (const name of names) {
            if (!accum.has(name)) accum.set(name, { r: 0, g: 0, b: 0, sat: 0, n: 0 });
            add(accum.get(name), ...c);
          }
        }
        for (const [name, a] of accum) regions[name] = finish(a);
      }
      return { label, size: [w, h], n, rgb: n ? [r / n, g / n, b / n] : [0, 0, 0], sat: n ? satSum / n : 0, strongPct: n ? 100 * strong / n : 0, regions };
    };
    // [H]'s native atlas. RGB is premultiplied by alpha coverage; recover E
    // before computing chromaticity, and retain coverage separately so a
    // sparse-red-vs-dense-neutral weighting bias is directly visible.
    if (src?.tiles?.atlas) {
      const tex = src.tiles.atlas;
      const w = tex.image?.width ?? 0, h = tex.image?.height ?? 0;
      const raw = await engine.renderer.backend.copyTextureToBuffer(tex, 0, 0, w, h, 0);
      const px = unpad(raw, w, h, 4, Uint16Array);
      const blocks = [];
      const ts = src.tiles.tileSize, perRow = src.tiles.layout.perRow;
      for (let block = 0; block < src.tiles.blocks; block++) {
        const bx = (block % perRow) * ts, by = Math.floor(block / perRow) * ts;
        let rr = 0, gg = 0, bb = 0, cov = 0, satSum = 0, n = 0;
        for (let y = 0; y < ts; y++) for (let x = 0; x < ts; x++) {
          const o = ((by + y) * w + bx + x) * 4;
          const c = f16(px[o + 3]);
          if (!(c > 1e-6)) continue;
          const r = f16(px[o]) / c, g = f16(px[o + 1]) / c, b = f16(px[o + 2]) / c;
          if (![r, g, b].every(Number.isFinite)) continue;
          const mx = Math.max(r, g, b);
          rr += r; gg += g; bb += b; cov += c; n++;
          satSum += mx > 1e-6 ? (mx - Math.min(r, g, b)) / mx : 0;
        }
        if (n) blocks.push([block, rr / n, gg / n, bb / n, satSum / n, cov / n, n]);
      }
      out.tileBlocks = blocks;
    }
    const targets = sys?.state?.screen?.targets;
    out.screenStages = [];
    for (const [texture, label] of [
      [src?.gather?.target, "5. screen gather (pre-resolve)"],
      [targets?.irradianceRaw, "6. resolve raw (pre-temporal)"],
      [targets?.irradiance, "7. resolved irradiance (material input)"],
    ]) {
      const stage = await summarizeTexture(texture, label);
      if (stage) out.screenStages.push(stage);
    }
  } catch (e) {
    out.errors.push(`screen stages: ${e.message}`);
  }
  return out;
});

await browser.close();
for (const e of data.errors ?? []) console.log(`  ⚠ ${e}`);

// ── THE COMPARISON ─────────────────────────────────────────────────────────
//
// ONE metric across all four links so they are directly comparable:
// SATURATION = (max - min) / max on the linear RGB triple. Chosen over a
// chromaticity distance because it needs no reference white and is meaningful
// for a single sample — "how far is this from grey" is precisely the question.
const sat = (r, g, b) => {
  const mx = Math.max(r, g, b);
  if (!(mx > 1e-6)) return 0;
  return (mx - Math.min(r, g, b)) / mx;
};
const pctile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const summarize = (label, sats) => {
  const s = sats.slice().sort((a, b) => a - b);
  const strong = s.filter((v) => v > 0.25).length;
  return {
    label, n: s.length,
    p50: pctile(s, 0.5), p90: pctile(s, 0.9), p99: pctile(s, 0.99), max: s[s.length - 1] ?? 0,
    strongPct: s.length ? (100 * strong) / s.length : 0,
  };
};

const rows = [];
if (data.materials?.length) {
  rows.push(summarize("1. material albedo (resolveMaterialSurface)", data.materials.map((m) => sat(m[0], m[1], m[2]))));
}
if (data.palette?.length) {
  // Slots never assigned sit at (0,0,0) and would read as saturation 0, which
  // would dilute the very statistic being measured. Only slots carrying an
  // albedo count.
  const used = data.palette.filter((p) => p[0] + p[1] + p[2] > 1e-6);
  rows.push(summarize(`2. palette albedo (${used.length}/${data.palette.length} slots written)`, used.map((p) => sat(p[0], p[1], p[2]))));
}
if (data.probes?.length) {
  rows.push(summarize("4. probe MEAN over directions", data.probes.map((p) => sat(p[1], p[2], p[3]))));
  rows.push(summarize("4b. probe PEAK directional bin", data.probes.map((p) => p[4])));
  // The screen integral reads the MERGED c0 tiles, while the aggregate above
  // pools every cascade. A colourful coarse cascade beside a grey c0 can make
  // "the probes carry colour" true while saying nothing about the field the
  // screen actually samples. Keep the aggregate for historical comparisons,
  // but split the same statistic by cascade so the hand-off and tile/gather
  // hypotheses are distinguishable in one run.
  const cascades = [...new Set(data.probes.map((p) => p[0]))].sort((a, b) => a - b);
  for (const c of cascades) {
    const probes = data.probes.filter((p) => p[0] === c);
    rows.push(summarize(`4c. c${c} probe MEAN over directions`, probes.map((p) => sat(p[1], p[2], p[3]))));
    rows.push(summarize(`4d. c${c} probe PEAK directional bin`, probes.map((p) => p[4])));
  }
}

console.log("\nSATURATION = (max-min)/max on linear RGB. 0 = grey, 1 = fully saturated.\n");
console.log("link                                                 n      p50    p90    p99    max   >0.25");
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(48)}${String(r.n).padStart(6)}  ` +
    `${r.p50.toFixed(3)} ${r.p90.toFixed(3)} ${r.p99.toFixed(3)} ${r.max.toFixed(3)}  ${r.strongPct.toFixed(1)}%`,
  );
}
if (data.screenStages?.length) {
  console.log("\nactual screen-integral stages (native linear rgba16f readback):");
  for (const s of data.screenStages) {
    console.log(
      `  ${s.label.padEnd(42)} n=${String(s.n).padStart(4)}  ` +
      `rgb ${s.rgb.map((v) => v.toFixed(3)).join("/")}  sat ${s.sat.toFixed(3)}  ` +
      `>0.25 ${s.strongPct.toFixed(1)}%`,
    );
    for (const [name, q] of Object.entries(s.regions ?? {})) {
      console.log(
        `    ${name.padEnd(18)} n=${String(q.n).padStart(5)} ` +
        `rgb ${q.rgb.map((v) => v.toFixed(3)).join("/")} R/G ${q.rg.toFixed(2)} ` +
        `sat(mean) ${q.sat.toFixed(3)} mean(sat) ${q.meanSat.toFixed(3)}`,
      );
    }
  }
}
if (data.hitSignal) {
  console.log(`\nnative [E] -> [J] hit signal: ${data.hitSignal.count} hits; sun ${data.hitSignal.sun.index} ` +
    `dir ${data.hitSignal.sun.direction.map((v) => v.toFixed(3)).join("/")}`);
  for (const c of data.hitSignal.cascades) {
    if (!c.n) continue;
    console.log(
      `  c${c.cascade}: ${c.n} hits, ${c.red} red (${c.redPct.toFixed(1)}%), ` +
      `rho ${c.meanRho.map((v) => v.toFixed(3)).join("/")}, red sun cosine ${c.meanRedSunCos.toFixed(3)}`,
    );
  }
}
if (data.tileBlocks?.length) {
  const agg = (list) => {
    const a = { n: 0, r: 0, g: 0, b: 0, sat: 0, cov: 0 };
    for (const q of list) { a.n++; a.r += q[1]; a.g += q[2]; a.b += q[3]; a.sat += q[4]; a.cov += q[5]; }
    return a.n ? { n: a.n, rgb: [a.r / a.n, a.g / a.n, a.b / a.n], sat: a.sat / a.n, cov: a.cov / a.n } : null;
  };
  const all = agg(data.tileBlocks);
  const red = agg(data.tileBlocks.filter((q) => q[1] > q[2] * 1.4 && q[1] > q[3] * 1.4));
  console.log(`\nnative [H] c0 tile atlas (${data.tileBlocks.length} covered blocks): ` +
    `rgb ${all.rgb.map((v) => v.toFixed(3)).join("/")} sat ${all.sat.toFixed(3)} coverage ${all.cov.toFixed(3)}`);
  if (red) console.log(`  red-dominant blocks ${red.n}: rgb ${red.rgb.map((v) => v.toFixed(3)).join("/")} ` +
    `sat ${red.sat.toFixed(3)} coverage ${red.cov.toFixed(3)}`);
}

// ── IS THE TINT THE RIGHT SIZE? THE SPATIAL TEST ───────────────────────────
//
// Statistics over the whole probe population cannot answer "is the red bleed
// too weak" — they only say the field is mostly grey, which a mostly-grey scene
// would also produce. The question is DIFFERENTIAL: do probes that sit next to a
// red surface carry more red than probes that do not?
//
// Measured on the probe field, NOT on the rendered image, and deliberately so:
// the render passes through AgX and a post graph, and AgX is a matrix plus a
// curve — it mixes channels, so an R/G ratio read off a screenshot is a tone
// curve as much as a radiometric quantity ([[gi-harness-viewport-traps]] and the
// emitter-size rig both had to turn tone mapping off for exactly this reason).
// The probe bins are linear radiance, pre-everything.
if (data.probes?.length && data.reds?.length && data.anchor && data.spacing0) {
  const KEY_AXIS_BITS = 9, KEY_AXIS_MASK = (1 << KEY_AXIS_BITS) - 1, KEY_AXIS_OFFSET = 256;
  const [ax, ay, az] = data.anchor;
  // Distance from a point to a red surface's world AABB — the surface is a
  // plate, not a point, and using its centre would push every probe under an
  // awning into the "far" bucket.
  const distToBox = (p, red) => {
    let d2 = 0;
    for (let k = 0; k < 3; k++) {
      const delta = Math.max(0, Math.abs(p[k] - red.c[k]) - red.h[k]);
      d2 += delta * delta;
    }
    return Math.sqrt(d2);
  };
  const BUCKETS = [0.5, 1.5, 4, 12, Infinity];
  const acc = BUCKETS.map(() => ({ n: 0, r: 0, g: 0, b: 0, sat: 0, peak: 0 }));
  for (const p of data.probes) {
    const key = p[8] >>> 0;
    const lod = ((key >>> 28) & 0xf) - 1;
    if (lod < 0) continue;
    const spacing = data.spacing0 * (1 << p[0]) * (1 << lod);
    const ox = Math.round(ax / spacing) * spacing;
    const oy = Math.round(ay / spacing) * spacing;
    const oz = Math.round(az / spacing) * spacing;
    const world = [
      ox + (((key >>> 18) & KEY_AXIS_MASK) - KEY_AXIS_OFFSET) * spacing,
      oy + (((key >>> 9) & KEY_AXIS_MASK) - KEY_AXIS_OFFSET) * spacing,
      oz + ((key & KEY_AXIS_MASK) - KEY_AXIS_OFFSET) * spacing,
    ];
    let best = Infinity;
    for (const red of data.reds) {
      const d = distToBox(world, red);
      if (d < best) best = d;
      if (best <= BUCKETS[0]) break;
    }
    const bi = BUCKETS.findIndex((t) => best < t);
    const a = acc[bi < 0 ? BUCKETS.length - 1 : bi];
    a.n++; a.r += p[1]; a.g += p[2]; a.b += p[3];
    a.sat += sat(p[1], p[2], p[3]); a.peak += p[4];
  }
  console.log(`\n${data.reds.length} strongly-red surfaces found by resolved albedo. Probes bucketed by distance to the nearest one:\n`);
  console.log("distance to red surface     probes   mean R/G   mean sat   peak-bin sat");
  const labels = ["< 0.5 m", "0.5 - 1.5 m", "1.5 - 4 m", "4 - 12 m", "> 12 m"];
  for (let i = 0; i < acc.length; i++) {
    const a = acc[i];
    if (!a.n) { console.log(`  ${labels[i].padEnd(24)}${String(a.n).padStart(7)}`); continue; }
    console.log(
      `  ${labels[i].padEnd(24)}${String(a.n).padStart(7)}   ` +
      `${(a.r / Math.max(a.g, 1e-9)).toFixed(4).padStart(8)}   ` +
      `${(a.sat / a.n).toFixed(4).padStart(8)}   ${(a.peak / a.n).toFixed(4).padStart(12)}`,
    );
  }
  // ⚠⚠ A RATIO NEEDS A DENOMINATOR WITH SAMPLES IN IT. The first run divided by
  // the ">12 m" bucket, which held FOUR probes whose mean R and G were both
  // ~0 — and printed "R/G LIFT = 1037463429×" followed by a confident verdict
  // that the bleed was working. An unguarded ratio is not a measurement, and a
  // rig that states a conclusion from four samples is worse than one that says
  // nothing. Both ends must be populated, and the far end must be non-black.
  const MIN_SAMPLES = 100;
  const near = acc.find((a) => a.n >= MIN_SAMPLES);
  const far = acc.slice().reverse().find((a) => a.n >= MIN_SAMPLES && a.g / a.n > 1e-5);
  if (!near || !far || near === far) {
    console.log(
      `\n  ⚠ NO VERDICT: need >=${MIN_SAMPLES} probes at both ends with a non-black far bucket ` +
      `(got near=${near?.n ?? 0}, far=${far?.n ?? 0}). Move the pose, or the red-surface filter is wrong.`,
    );
  } else {
    // SATURATION FALLOFF IS THE HEADLINE, NOT R/G. R/G on a near-grey mean is
    // noise — the first run's table had the 4-12 m bucket reading a HIGHER R/G
    // (1.0564) than the <0.5 m one (1.0375) while its saturation was 26× lower,
    // which is what a ratio of two small similar numbers does. Saturation is
    // signed-free, well-conditioned, and monotonic in exactly the quantity asked
    // about: how far from grey is this probe.
    const nearSat = near.sat / near.n, farSat = far.sat / far.n;
    const ratio = nearSat / Math.max(farSat, 1e-9);
    console.log(
      `\n  SATURATION next to a red surface vs far from one: ${nearSat.toFixed(4)} vs ${farSat.toFixed(4)} (${ratio.toFixed(1)}×)\n` +
      `  R/G, for reference only (ill-conditioned on a near-grey mean): ` +
      `${(near.r / Math.max(near.g, 1e-9)).toFixed(4)} vs ${(far.r / Math.max(far.g, 1e-9)).toFixed(4)}\n` +
      (ratio > 1.5
        ? `  THE BLEED IS DELIVERED AND IT IS LOCAL${ratio > 3 ? "." : ", BUT BROAD."} Coloured bounce falls off with\n` +
          "  distance from coloured geometry, which is what it should do — so every link from\n" +
          "  material to probe is working. Whether the ABSOLUTE magnitude matches a path\n" +
          "  tracer cannot be settled here: it needs the reference frame, measured with the\n" +
          "  same tone curve on both sides.\n"
        : "  ⛔ NO LOCAL LIFT. Probes touching a red surface are barely more saturated than\n" +
          "  distant ones, so coloured bounce is not reaching neighbouring probes and the\n" +
          "  peak-bin saturation is something else (an emitter, a sky gradient). The bug is\n" +
          "  in the bounce, not in the averaging.\n"),
    );
  }
} else if (data.probes?.length) {
  console.log(`\n⚠ spatial test skipped: reds=${data.reds?.length ?? 0} anchor=${JSON.stringify(data.anchor)} spacing0=${data.spacing0}`);
}

console.log(
  `\nchroma dials: __giBounceSaturation = ${data.bounceSaturation ?? "unset (1, untouched)"}` +
  `, __giNoTextureTint = ${data.noTextureTint ?? "unset (tint on)"}`,
);
if (data.deposit) {
  const d = data.deposit;
  // ⚠⚠ `unattributedRate` HAS A MISLEADING DENOMINATOR AND IT NEARLY COST A
  // WRONG DIAGNOSIS. It counts every ray the deposit shades — HIT OR MISS — and
  // a MISS has no surface to attribute, so it is unattributed by definition.
  // The first run read 58.9% and it looks exactly like the documented
  // record-pool starvation failure (§12.25, "three quarters of static hits shade
  // at the palette MEAN"). It was not: 13178 unattributed against 13474 misses
  // means essentially every miss and almost no HIT. The number that answers "is
  // attribution working" is unattributed-among-HITS, so that is what is printed
  // first here and the historical rate second.
  const misses = Math.max(0, (d.shaded ?? 0) - (d.hits ?? 0));
  const unattrHits = Math.max(0, (d.unattributed ?? 0) - misses);
  const hitRate = d.hits ? (100 * unattrHits) / d.hits : -1;
  const legacy = d.shaded ? (100 * (d.unattributed ?? 0)) / d.shaded : -1;
  console.log(
    `\ndeposit: ${d.rays} rays, ${d.hits} hits (${misses} misses = ` +
    `${d.shaded ? ((100 * misses) / d.shaded).toFixed(0) : "?"}% of shaded rays hit SKY)\n` +
    `  unattributed HITS: ~${unattrHits} of ${d.hits} (${hitRate.toFixed(1)}%)  <-- the attribution health number\n` +
    `  historical unattributedRate (hit+miss denominator): ${legacy.toFixed(1)}%  <-- do NOT read as failure` +
    (d.albedoClamped !== undefined
      ? `\n  albedo-clamped: ${d.albedoClamped} of ${d.hits} hits (${d.hits ? ((100 * d.albedoClamped) / d.hits).toFixed(0) : "?"}%)`
      : ""),
  );
}

// ── THE VERDICT ────────────────────────────────────────────────────────────
const mat = rows.find((r) => r.label.startsWith("1."));
const pal = rows.find((r) => r.label.startsWith("2."));
const pro = rows.find((r) => r.label.startsWith("4. "));
const peak = rows.find((r) => r.label.startsWith("4b"));
console.log("");
// ⚠ THE PEAK-vs-MEAN TEST RUNS FIRST AND DOES NOT NEED THE PALETTE. The first
// run had decisive data — peak directional bin 37.8% strongly saturated against
// a probe mean of 4.1%, with materials at 32.8% — and reported "no single link
// dominates", because every branch of this tree was gated on the palette link
// the rig had failed to reach. A decision tree must not require an input that is
// merely nice to have.
if (peak && pro && mat && peak.strongPct > Math.max(10, pro.strongPct * 2)) {
  console.log(
    `THE COLOUR IS IN THE FIELD AND IS AVERAGED AWAY ON THE WAY OUT.\n` +
    `  materials ${mat.strongPct.toFixed(0)}% strongly coloured → probe PEAK bin ` +
    `${peak.strongPct.toFixed(0)}% → probe MEAN ${pro.strongPct.toFixed(0)}%.\n` +
    "  The deposit and attribution are carrying the chroma per DIRECTION; the loss is in\n" +
    "  the hemisphere integral. Some of that is physics — a small awning subtends a small\n" +
    "  solid angle — so the question is the RATIO of coloured bounce to neutral sky in\n" +
    "  each probe, NOT whether a link is broken. Read the miss rate below: every miss\n" +
    "  deposits neutral sky, and that is the term the tint competes against.\n" +
    "  ⛔ THIS IS NOT A PROBE-PLACEMENT PROBLEM. Finer probes resolve the same average.",
  );
} else if (mat && pal && mat.strongPct > 5 && pal.strongPct < mat.strongPct / 3) {
  console.log(
    "VERDICT: THE PALETTE IS THE LEAK. The scene's materials are colourful and the\n" +
    "palette that GI shades from is not — look at the record pool first (§12.25: a\n" +
    "starved pool shades at the palette MEAN, which is grey by construction) and at\n" +
    "the palette write, not at probe placement.",
  );
} else if (pal && pro && pal.strongPct > 5 && pro.strongPct < pal.strongPct / 3) {
  console.log(
    "VERDICT: THE TRANSPORT IS THE LEAK. GI knows the surfaces are coloured — the\n" +
    "palette carries the chroma — and the probes still come out grey. The chroma is\n" +
    "being diluted after the bounce." +
    (peak && peak.strongPct > (pro?.strongPct ?? 0) * 2
      ? "\n  ⚠ AND THE PEAK DIRECTIONAL BIN IS FAR MORE SATURATED THAN THE PROBE MEAN,\n" +
        "  so the colour IS in the field, per-direction, and is being averaged away on\n" +
        "  the way out. Suspect the gather/resolve, not the deposit."
      : "\n  The peak directional bin is no more saturated than the mean, so the colour is\n" +
        "  absent per-direction too — suspect sky/sun dominating every bin, or the\n" +
        "  bounce not multiplying by albedo at all."),
  );
} else if (mat && mat.strongPct <= 5) {
  console.log(
    "VERDICT: THE MATERIALS ALREADY RESOLVE GREY. Whatever the transport does, there\n" +
    "is no chroma entering it — check `resolveMaterialSurface` on the awning\n" +
    "specifically (a texture-driven base colour resolves to its mean) before\n" +
    "touching anything downstream.",
  );
} else {
  console.log("VERDICT: no single link dominates — read the table; the drop is gradual or the rig is missing a link.");
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(OUT, `colour-bleed-${stamp}.json`);
writeFileSync(file, JSON.stringify({
  pose: POSE, quality: QUALITY, rows, screenStages: data.screenStages ?? null,
  hitSignal: data.hitSignal ?? null, tileBlocks: data.tileBlocks ?? null,
  deposit: data.deposit ?? null,
  errors: data.errors, giLines: giLines.slice(0, 60),
}, null, 2));
console.log(`\nwrote ${file}`);
