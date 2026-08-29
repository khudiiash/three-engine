// "REFLECTORS ARE JUST BLACK" (2026-08-26) — which stage went dark?
//
// The user's report arrived right after §18.17 wired TEXTURE SAMPLING into
// the one-BVH reflection path, and the editor's own `reflections-exact` debug
// view agrees with them: the exact BVH layer reads mean luma 0.027, non-black
// on 8.6% of texels, where the same scene measured 48.3% before. That view
// can say the layer is dark; it cannot say WHICH input went dark.
//
// ⭐ THE COLOUR-PROBE METHOD (memory: gi-colour-probe-method). Read back every
// stage of the chain in order and report each one's distribution — the FIRST
// wrong one is the source. Here the chain is:
//
//   1. the slot ALBEDO ATLAS       (a canvas, then a GPU blit over it)
//   2. the per-slot TILE TABLE     (rgba8: which tile, and "is it mapped")
//   3. the prepass HIT buffer      (t, dynFlag, oct normal)
//   4. the prepass COLOUR buffer   (albedo + hasAlbedo) ← what the atlas feeds
//   5. the RADIANCE buffer         (hit shading: albedo x light)
//
// A black 5 with a healthy 4 is a shading bug; a black 4 with a healthy 1 is
// the tile table or the UV; a black 1 is the atlas itself.
//
// It boots the USER'S REAL PROJECT, read-only — no writableRoot is passed, so
// the shim refuses every write command by construction.
//
//   node scripts/run-gi-reflect-black-probe.mjs
//   PROJECT=C:/path/to/project SETTLE=180000
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SETTLE = Number(process.env.SETTLE ?? 45000);
const VIEW = (process.env.VIEW ?? "1280x720").split("x").map(Number);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/reflection albedo atlas|gpu-blit|exact reflections|one-BVH|reflection tiers/.test(t)) {
    console.log(`  ${t.slice(0, 300)}`);
  }
});
page.on("pageerror", (e) => console.log(`  pageerror: ${String(e.message ?? e).slice(0, 200)}`));
await page.evaluateOnNewDocument((project) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
}, PROJECT);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
for (let i = 0; i < 300 && !built; i++) await wait(1000);
if (!built) { console.log("FAIL — never built"); await browser.close(); process.exit(1); }
// The atlas blit only runs once the compile wave has finished, and the
// reflection chain only fills after the field is ready — both are minutes on
// this scene, and reading before them is how an instrument reports 0% on a
// buffer that is 48% full eight seconds later.
await page.waitForFunction(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  return engine.modules?.get?.("gi")?.system?._fieldReadyOnce === true;
}, { timeout: 300000, polling: 3000 }).catch(() => console.log("  (field-ready wait timed out — reading anyway)"));
await wait(SETTLE);

const out = await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const { readTexturePixelsGPU } = await import("/src/modules/gi/giScreen.js");
  const engine = await ensureEngine();
  const renderer = engine.renderer;
  const sys = engine.modules?.get?.("gi")?.system ?? null;
  if (!sys) return { error: "no gi system" };

  const unpad = (raw, w, h, comps, Ctor) => {
    const rowBytes = w * comps * Ctor.BYTES_PER_ELEMENT;
    const padded = Math.ceil(rowBytes / 256) * 256;
    const src = new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length);
    const dst = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      const from = y * padded;
      const avail = Math.max(0, Math.min(rowBytes, src.length - from));
      if (avail > 0) dst.set(src.subarray(from, from + avail), y * rowBytes);
    }
    return new Ctor(dst.buffer);
  };
  const f16 = (h) => {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 2 ** -24;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (m + 1024) * 2 ** (e - 25);
  };
  const summarize = (get, n, label) => {
    let sum = 0, nz = 0, max = 0;
    for (let i = 0; i < n; i++) { const v = get(i); sum += v; if (v > 1e-4) nz++; if (v > max) max = v; }
    return { label, mean: sum / Math.max(1, n), nonBlackPct: (100 * nz) / Math.max(1, n), max, n };
  };

  const report = {};

  // ── 1. the atlas, as the shader currently sees it ────────────────────────
  const sa = sys._slotAtlas ?? null;
  if (!sa) report.atlas = { error: "sys._slotAtlas is null — the textured path is not armed" };
  else {
    const bound = sa.atlasTextureNode?.value ?? null;
    const px = bound ? await readTexturePixelsGPU(renderer, bound, 64) : null;
    report.atlas = {
      materialCount: sa.materialCount,
      slots: sa.slots,
      atlasSize: sa.atlasSize,
      atlasTile: sa.atlasTile,
      atlasGrid: sa.atlasGrid,
      hasBlitTarget: !!sa.blitTarget,
      pendingGpuTiles: sa.pendingGpuTiles?.length ?? 0,
      boundIsBlit: !!(sa.blitTarget && bound === sa.blitTarget.texture),
      boundIsCanvas: bound === sa.atlasTexture,
      boundName: bound?.name ?? bound?.constructor?.name ?? null,
      boundColorSpace: bound?.colorSpace ?? null,
      ...(px
        ? summarize((i) => (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 765, px.length / 4, "atlas 64x64")
        : { error: "readback failed" }),
    };
    // 1b. THE TWO HALVES OF THE ATLAS, SEPARATELY. The shader samples one
    // texture but two writers produced it: the CPU canvas (solid material
    // colours here, because every Sponza map is KTX2 and the 2D context
    // cannot decode one) and the GPU blit that overwrites it. Reading only
    // the bound result cannot say which of them went dark.
    const shot = async (tex, label) => {
      if (!tex) return { label, error: "absent" };
      try {
        const q = await readTexturePixelsGPU(renderer, tex, 64);
        return q ? summarize((i) => (q[i * 4] + q[i * 4 + 1] + q[i * 4 + 2]) / 765, q.length / 4, label)
          : { label, error: "readback failed" };
      } catch (e) { return { label, error: String(e).slice(0, 120) }; }
    };
    report.atlasCanvas = await shot(sa.atlasTexture, "slot canvas");
    report.atlasBlit = await shot(sa.blitTarget?.texture, "slot blit");
    const seated = sys._bvhScene ?? sys.state?.bvhScene ?? null;
    report.seatedAtlas = await shot(seated?.atlasTextureNode?.value, "seated atlas (bound)");
    report.seatedCanvas = await shot(seated?.atlasTexture, "seated canvas");

    // ── 2. the tile table, CPU side (what was uploaded) ────────────────────
    const d = sa.data ?? null;
    if (d) {
      const rows = [];
      let mapped = 0;
      for (let s = 0; s < sa.slots; s++) {
        const o = s * 4;
        if (d[o + 3] > 0) { mapped++; if (rows.length < 8) rows.push(`${s}:(${d[o]},${d[o + 1]})`); }
      }
      report.tileTable = { mapped, of: sa.slots, sample: rows.join(" ") };
    }
  }

  const cam = engine.camera;
  report.camera = { pos: cam?.position?.toArray?.().map((v) => +v.toFixed(2)) ?? null };
  const gb = sys.state?.screen?.gbuffer?.position ?? null;
  if (gb) {
    const gw = gb.image?.width ?? sys.state.screen.width, gh = gb.image?.height ?? sys.state.screen.height;
    const g = unpad(await renderer.backend.copyTextureToBuffer(gb, 0, 0, gw, gh, 0), gw, gh, 4, Float32Array);
    let cov = 0;
    for (let i = 0; i < gw * gh; i++) if (g[i * 4 + 3] > 0.5) cov++;
    report.gbuffer = { size: [gw, gh], coveredPct: (100 * cov) / (gw * gh) };
  }

  // ── 3/4/5. the three reflection buffers ──────────────────────────────────
  const t = sys._giBvhTarget ?? null;
  if (!t) report.buffers = { error: "no _giBvhTarget" };
  else {
    const readHalf = async (tex, label) => {
      // §19 6.11: the radiance target only exists when `bvhHitShade` is armed
      // (never under GI2 — the hit shade reads the retired lattice), so an
      // absent stage is a report line, not a crash of the whole instrument.
      if (!tex) return { label, error: "absent (stage not armed)" };
      const w = tex.image?.width ?? tex.width, h = tex.image?.height ?? tex.height;
      if (!w || !h) return { label, error: "no size" };
      // A target no pass has ever bound has no GPU texture behind it yet
      // (`bvhRadiance` under GI2) — the backend throws on `.format`.
      try {
        const a = unpad(await renderer.backend.copyTextureToBuffer(tex, 0, 0, w, h, 0), w, h, 4, Uint16Array);
        return { w, h, a };
      } catch (e) { return { label, error: `readback failed (${String(e).slice(0, 80)})` }; }
    };
    const hit = await readHalf(t.bvhReflect, "hit");
    const col = await readHalf(t.bvhColor, "colour");
    const rad = await readHalf(t.bvhRadiance, "radiance");
    if (hit.a) {
      let hits = 0;
      for (let i = 0; i < hit.w * hit.h; i++) if (f16(hit.a[i * 4]) >= 0) hits++;
      report.hitBuffer = { size: [hit.w, hit.h], hitPct: (100 * hits) / (hit.w * hit.h) };
    }
    if (col.a) {
      const n = col.w * col.h;
      let shaded = 0;
      for (let i = 0; i < n; i++) if (f16(col.a[i * 4 + 3]) > 0.5) shaded++;
      report.colourBuffer = {
        size: [col.w, col.h],
        hasAlbedoPct: (100 * shaded) / n,
        ...summarize((i) => (f16(col.a[i * 4]) + f16(col.a[i * 4 + 1]) + f16(col.a[i * 4 + 2])) / 3, n, "albedo"),
      };
    }
    if (rad.a) {
      const n = rad.w * rad.h;
      report.radianceBuffer = {
        size: [rad.w, rad.h],
        ...summarize((i) => (f16(rad.a[i * 4]) + f16(rad.a[i * 4 + 1]) + f16(rad.a[i * 4 + 2])) / 3, n, "radiance"),
      };
    }
  }
  return report;
});

console.log("\n" + JSON.stringify(out, null, 2));
await browser.close();
