// MULTI-COLOUR EMITTER SEAM PROBE (2026-08-19).
//
// THE REPORT: "with multiple emissive sources of DIFFERENT COLOURS the light
// does not blend smoothly — hard seams are visible" (user's Level, 52 tree
// emitters in warm 30/9.8/1.0 and cyan 1.1/20.2/30.0).
//
// THE SUSPECT, named by the code itself: `createGiEmitterTileCutPass` keeps the
// TOP FOUR emitters per tile out of N and drops the rest. §12.70 W4c's tail
// compensation `Σimp/Σimp(kept)` makes the delivered SCALAR ENERGY continuous
// across a set change — and says so in its own comment — but it says nothing
// about HUE: a tile that keeps 3 warm + 1 cyan and its neighbour that keeps
// 4 warm deliver the same energy in DIFFERENT COLOURS. That is a hue step with
// no brightness step, which is exactly the reported artifact, and it can only
// exist once the emitters disagree about colour.
//
// THE INSTRUMENT IS CAUSAL, NOT CORRELATIONAL. For every pair of ADJACENT
// TILES the rig reads the cut's own `idBuf` and computes the kept-set symmetric
// difference, then measures the CHROMA STEP across that same boundary in the
// rendered frame. Conditioning on setDiff is what makes this a measurement
// rather than a picture: tiles that agree on the set are the matched control
// for "how much does colour vary over 2 px anyway" — same scene, same lamps,
// same shading, same noise. An excess that appears ONLY where the set changes
// convicts the cut; equal numbers exonerate it and point at the SRC field.
//
// ⚠ Chroma is measured as a LUMINANCE-NORMALIZED chromaticity distance, not a
// colour difference: the whole point is a step that carries no brightness
// change. Reported as p50/p90/p99 per bucket — a seam is a TAIL, never a mean
// ([[gi-src-rebuild]] §13.7c's instrument lesson).
//
//   node scripts/run-gi-colour-seam-probe.mjs [url]
// Env:
//   LAMPS=24        emissive strips (alternating colours). >16 → tileSize 2,
//                   which is what the user's 52-emitter scene runs.
//   COLOURS=multi   `multi` = warm/cyan/magenta (the case under test);
//                   `mono`  = every lamp the same warm — THE NULL. A hue step
//                   is impossible when every emitter agrees on hue, so the
//                   setDiff≥1 excess MUST collapse here or the instrument is
//                   measuring something else.
//   ARM=default     comma set: nocut (__giEmitterTileCut=false), nocomp
//                   (__giTileCutCompensate=1), srcoff (__giSrcProbes=false),
//                   soft=<f> (__giTileCutFeather — the fix's dial)
//   QUALITY=high    GI preset
//   PNG=1           dump the frame + a setDiff overlay next to it
//   PROJECT=C:/path/to/GAME   measure the USER'S OWN SCENE instead of the
//                   synthetic room, booted READ-ONLY through the tauri shim.
//                   A rig scene is a hypothesis; the user's scene is the case.
//   POSE=px,py,pz,tx,ty,tz    camera for PROJECT mode (default: their pose)
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5335/";
const PROJECT = (process.env.PROJECT ?? "").replaceAll("\\", "/");
const POSE = (process.env.POSE ?? "3.27,3.10,9.54,0.61,-0.46,15.50").split(",").map(Number);
const lamps = Number(process.env.LAMPS ?? 24);
const colours = process.env.COLOURS ?? "multi";
const arm = process.env.ARM ?? "default";
const quality = process.env.QUALITY ?? "high";
const wantPng = process.env.PNG === "1";
// DUMP=1 writes the emitter shadow texture's four channels (FINAL over MID).
const DUMP = process.env.DUMP === "1";
// EXTRA={"__giEmitterWidePass":false} — arm ANY dev global without editing the
// rig. Attribution needs suspects turned off one at a time, and every suspect
// in this chain is already hatched.
const EXTRA = process.env.EXTRA ? JSON.parse(process.env.EXTRA) : null;
const OUT = ".gi-shots/colour-seam";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
let sawField = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] field ready:/.test(t)) sawField = true;
  if (/\[gi\] (built|emitter tile cut|emitter ledger|light tree|field ready|src probes|src pool)|PROBE/.test(t)) {
    console.log(`  ${t.slice(0, 220)}`);
  }
});
page.on("pageerror", (e) => {
  const msg = String(e.message ?? e);
  if (!/save_scene/.test(msg)) console.log(`pageerror: ${msg.slice(0, 200)}`);
});

if (PROJECT) {
  // READ-ONLY by construction: no `writableRoot`, so every write command the
  // editor issues against the user's project is refused by the shim. This rig
  // observes their scene; it must never be able to change it.
  await installTauriShim(page, {});
  await page.evaluateOnNewDocument((project, armStr, extra) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    const flags = new Set(String(armStr).split(",").map((s) => s.trim()).filter(Boolean));
    if (flags.has("nocut")) { globalThis.__giEmitterTileCut = false; globalThis.__giSrcLightTree = false; }
    if (flags.has("nocomp")) globalThis.__giTileCutCompensate = 1;
    if (flags.has("srcoff")) globalThis.__giSrcProbes = false;
    for (const f of flags) {
      const m = /^soft=([\d.]+)$/.exec(f);
      if (m) globalThis.__giTileCutFeather = Number(m[1]);
    }
    if (extra) for (const [k, v] of Object.entries(extra)) globalThis[k] = v;
  }, PROJECT, arm, EXTRA);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 120000 });
  // `__editorApi` exists before the viewport panel mounts, and `viewport.*`
  // throws "No viewport is open" until it does — so POLL rather than assume.
  await page.evaluate(async (p) => {
    const end = performance.now() + 120_000;
    for (;;) {
      try {
        await globalThis.__editorApi.call("viewport.setCamera", {
          position: [p[0], p[1], p[2]], target: [p[3], p[4], p[5]],
        });
        return;
      } catch (e) {
        if (performance.now() > end) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, POSE);
} else {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await new Promise((r) => setTimeout(r, 5000));
}

const result = await page.evaluate(async ({ lamps, colours, arm, quality, wantPng, projectMode, extra, dumpShadow }) => {
  globalThis.__editorKeepRendering = true;
  if (!projectMode) globalThis.__giConfigOverride = { emissiveShadows: true };
  const flags = new Set(String(arm).split(",").map((s) => s.trim()).filter(Boolean));
  if (flags.has("nocut")) { globalThis.__giEmitterTileCut = false; globalThis.__giSrcLightTree = false; }
  if (flags.has("nocomp")) globalThis.__giTileCutCompensate = 1;
  if (flags.has("srcoff")) globalThis.__giSrcProbes = false;
  for (const f of flags) {
    const m = /^soft=([\d.]+)$/.exec(f);
    if (m) globalThis.__giTileCutFeather = Number(m[1]);
  }

  const { THREE } = await import("/src/engine/index.js");
  const lampMeshes = [];
  let engine, system;
  if (projectMode) {
    // THE USER'S OWN SCENE, already open and already GI-built by the editor's
    // normal boot. Nothing here creates, moves or saves anything — the census
    // below only reads the cut's buffers and the presented frame.
    // `ensureEngine` RETURNS THE LIVE ONE — it is a singleton accessor, not a
    // constructor, so this reaches the editor's own engine without touching
    // the scene. (Going via `entities.live(id).engine` needs an entity that
    // has a live proxy, which a freshly-opened project does not guarantee.)
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    engine = await ensureEngine();
    if (!engine) return { fail: "could not reach the engine through the editor api" };
    system = engine.modules?.get?.("gi")?.system ?? null;
    if (!system) return { fail: "the gi module is not enabled in this project" };
  } else {
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  for (const entity of [...engine.entities.values()]) engine.destroyEntity(entity);
  for (const child of [...engine.scene.children]) if (child.isMesh) engine.scene.remove(child);
  // Anonymised geometry: the GI merge path keys on `parameters`, and two lamps
  // that share a BoxGeometry signature can be welded into one emitter — which
  // would quietly reduce the emitter count the whole rig is parameterised on.
  const anon = (g) => { const n = g.toNonIndexed(); n.parameters = undefined; n.type = "BufferGeometry"; return n; };

  const ROOM = 24;
  const grey = new THREE.MeshStandardNodeMaterial({ color: 0x9a9a9a, roughness: 0.9 });
  const floor = new THREE.Mesh(anon(new THREE.BoxGeometry(ROOM, 0.3, ROOM)), grey);
  floor.position.y = -0.15;
  const meshes = [floor];
  // Four walls: an enclosed room is what makes the indirect term real, and the
  // user's scene is a room. They are also what the lamps are mounted on.
  for (const [dx, dz, sx, sz] of [[1, 0, 0.3, ROOM], [-1, 0, 0.3, ROOM], [0, 1, ROOM, 0.3], [0, -1, ROOM, 0.3]]) {
    const w = new THREE.Mesh(anon(new THREE.BoxGeometry(sx, 6, sz)), grey);
    w.position.set(dx * ROOM / 2, 3, dz * ROOM / 2);
    meshes.push(w);
  }

  // THE LAMPS. Radiances copied from the user's own emitter ledger so the
  // chroma separation under test is the one their scene actually has.
  const PALETTE = colours === "mono"
    ? [[30.0, 9.8, 1.0]]
    : [[30.0, 9.8, 1.0], [1.1, 20.2, 30.0], [24.0, 2.0, 26.0]];
  for (let i = 0; i < lamps; i++) {
    const rgb = PALETTE[i % PALETTE.length];
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 0.9 });
    // strength rides in the colour (radiance), exactly as the ledger reads it.
    mat.emissive = new THREE.Color(rgb[0] / 30, rgb[1] / 30, rgb[2] / 30);
    mat.emissiveIntensity = 30;
    // Strips around the perimeter at head height, evenly spaced along the walls.
    const t = (i + 0.5) / lamps;
    const side = Math.floor(t * 4), u = (t * 4 - side - 0.5) * (ROOM - 2);
    const long = 1.6, thin = 0.25;
    const horiz = side % 2 === 0;
    const m = new THREE.Mesh(
      anon(new THREE.BoxGeometry(horiz ? long : thin, thin, horiz ? thin : long)),
      mat,
    );
    const edge = ROOM / 2 - 0.5;
    if (side === 0) m.position.set(u, 2.6, -edge);
    else if (side === 1) m.position.set(edge, 2.6, u);
    else if (side === 2) m.position.set(u, 2.6, edge);
    else m.position.set(-edge, 2.6, u);
    lampMeshes.push(m);
    meshes.push(m);
  }
  engine.scene.add(...meshes);
  for (const m of meshes) m.updateMatrixWorld(true);

  const gi = engine.createEntity({ name: "GI Colour Seam Probe" });
  gi.addComponent("global-illumination", { quality });
  system = engine.modules.get("gi").system;

  // The user's pose: elevated, looking down the floor at ~40°.
  const cam0 = engine.camera;
  cam0.fov = 60;
  cam0.position.set(0, 7.0, 9.0);
  cam0.lookAt(0, 0, -1);
  cam0.updateProjectionMatrix();
  cam0.updateMatrixWorld(true);
  }
  const cam = engine.camera;

  const deadline = performance.now() + 120_000;
  let screen = null;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    screen = system.state?.screen ?? null;
    if (screen && (system.state?.volume?.occupancyField?.stats?.dispatches ?? 0) > 3) break;
  }
  if (!screen) return { fail: "GI never built a screen bundle" };
  {
    const end = performance.now() + 90_000;
    let quiet = 0;
    while (performance.now() < end && quiet < 6) {
      await new Promise((r) => setTimeout(r, 250));
      const d = system.state?.volume?.occupancyField?.debugIncremental;
      quiet = globalThis.__giPendingComputePipelines?.size === 0 && d && !d.dirty && !d.staticDirty ? quiet + 1 : 0;
    }
  }
  // SRC needs real time to converge; a transient field is a noisy control.
  await new Promise((r) => setTimeout(r, 8000));

  // ── DUMP=1 — LOOK AT THE CHANNEL, DO NOT INFER IT ────────────────────────
  // Every arm so far has bisected by turning a suspect off and reading the
  // frame. That says WHICH STAGE owns the seam and never says what the stage's
  // own output looks like. The emitter shadow texture is four packed
  // visibilities (one per kept emitter, id-keyed) at the emitter buffer's own
  // resolution — if the seam is a shadow, it is visible HERE as a hard edge in
  // one channel, and if it is not, the whole shadow hypothesis dies in one
  // picture. `Mid` is the pre-wide tap, so the pair also separates "the raw
  // mask has an edge" from "the penumbra passes made one".
  let shadowDump = null;
  if (dumpShadow && screen.targets?.emitterShadow) {
    try {
      const W = screen.emitterShadowWidth ?? screen.width;
      const H = screen.emitterShadowHeight ?? screen.height;
      const stride = Math.ceil((W * 4) / 256) * 256;
      const grab = async (t) => {
        const data = await engine.renderer.backend.copyTextureToBuffer(t, 0, 0, W, H);
        return { data, W, H, stride };
      };
      const paint = (img, chan) => {
        const c = document.createElement("canvas");
        c.width = img.W; c.height = img.H;
        const ctx = c.getContext("2d");
        const im = ctx.createImageData(img.W, img.H);
        for (let y = 0; y < img.H; y++) {
          for (let x = 0; x < img.W; x++) {
            const v = img.data[y * img.stride + x * 4 + chan];
            const o = (y * img.W + x) * 4;
            im.data[o] = v; im.data[o + 1] = v; im.data[o + 2] = v; im.data[o + 3] = 255;
          }
        }
        ctx.putImageData(im, 0, 0);
        return c;
      };
      const fin = await grab(screen.targets.emitterShadow);
      const mid = screen.targets.emitterShadowMid ? await grab(screen.targets.emitterShadowMid) : null;
      // 4 channels across, FINAL on the top row and MID underneath.
      const sheet = document.createElement("canvas");
      sheet.width = fin.W * 4 + 12; sheet.height = fin.H * (mid ? 2 : 1) + 4;
      const g = sheet.getContext("2d");
      g.fillStyle = "#c00"; g.fillRect(0, 0, sheet.width, sheet.height);
      for (let k = 0; k < 4; k++) {
        g.drawImage(paint(fin, k), k * (fin.W + 4), 0);
        if (mid) g.drawImage(paint(mid, k), k * (fin.W + 4), fin.H + 4);
      }
      shadowDump = { png: sheet.toDataURL("image/png"), W: fin.W, H: fin.H, hasMid: !!mid };
    } catch (e) { shadowDump = { fail: String(e?.message ?? e) }; }
  }

  // Per-pass GPU cost, so a seam fix that is secretly a 3x cost increase says
  // so in the same run that claims the win.
  let passMs = null;
  if (projectMode) {
    try {
      const r = await globalThis.__editorApi.call("profile.giPasses", { samples: 40 });
      passMs = r?.value ?? r;
    } catch { /* profiling is optional */ }
  }

  const live = globalThis.__giTileCutLive;
  const renderer = engine.renderer;
  // ── THE OTHER SUSPECT, read rather than argued ──────────────────────────
  // If the cut is no longer where the steps are, the next candidate is the
  // SRC gather: a probe population that cannot hold the surface degenerates
  // from trilinear interpolation to whichever few corners exist, and that is
  // flat cells with creases between them. `meanCorners` (out of 8) is the
  // number that says so, and `dropped` is the pool refusing inserts.
  let srcStats = null;
  try {
    const s = await screen.srcProbes?.readStats?.(renderer);
    if (s) {
      srcStats = {
        spacing0: s.spacing0,
        gather: s.gather ? {
          meanCorners: s.gather.meanCorners, empty: s.gather.empty,
          lit: s.gather.lit, pixels: s.gather.pixels,
        } : null,
        cascades: (s.cascades ?? []).map((c) => ({
          live: c.live, cap: c.cap ?? c.capacity, dropped: c.failedInserts ?? c.dropped,
        })),
        reanchors: s.reanchors,
      };
    }
  } catch { /* telemetry is optional — never fail the census on it */ }
  const treeCount = globalThis.__giLightTreeLive?.emitterCount
    ?? system.state?.lightTreeRegion?.emitterCount ?? null;

  // ── the frame, captured inside onPostRender (a WebGPU canvas read outside
  // the frame callback returns a blank buffer) ─────────────────────────────
  const frame = await new Promise((resolve) => {
    let n = 0;
    const off = engine.onPostRender(() => {
      if (++n < 3) return;
      off();
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      resolve({ w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data, canvas: c, ctx });
    });
  });

  if (!live) {
    return { fail: "no __giTileCutLive (the cut is not armed on this arm)", cutArmed: false, treeCount,
      srcStats,
      shadowDump,
      png: wantPng ? frame.canvas.toDataURL("image/png") : null,
      canvas: { w: frame.w, h: frame.h } };
  }

  const pos = new Float32Array(await renderer.getArrayBufferAsync(live.posBuf.value));
  const ids = new Uint32Array(await renderer.getArrayBufferAsync(live.idBuf.value));
  const { tilesX, tilesY, tileSize, emitterW, emitterH } = live;
  const EMPTY = 0xffffffff;
  // Floats per tile in `posBuf`: [P.xyz, valid][N.xyz, comp][w0..w3] — the
  // third vec4 is §13.8's per-channel soft-cut weight.
  const TILE_F = 12;

  // ── tile → canvas, with the y convention PROVEN rather than assumed ──────
  // Each tile carries the world position its ranking was taken at, so the
  // mapping can be checked against the camera's own projection. Getting the
  // flip wrong mirrors the whole census and would still produce a plausible
  // number, which is why this is a measurement and not a comment.
  const sx = frame.w / emitterW, sy = frame.h / emitterH;
  const v = new THREE.Vector3();
  const projErr = (flip) => {
    let sum = 0, n = 0;
    for (let t = 0; t < tilesX * tilesY; t += 37) {
      if (!(pos[t * TILE_F + 3] > 0.5)) continue;
      v.set(pos[t * TILE_F], pos[t * TILE_F + 1], pos[t * TILE_F + 2]).project(cam);
      const px = (v.x * 0.5 + 0.5) * frame.w;
      const py = (flip ? 1 - (v.y * 0.5 + 0.5) : v.y * 0.5 + 0.5) * frame.h;
      const tx = (t % tilesX + 0.5) * tileSize * sx;
      const ty = (Math.floor(t / tilesX) + 0.5) * tileSize * sy;
      sum += Math.hypot(px - tx, py - ty); n++;
      if (n > 400) break;
    }
    return n ? sum / n : Infinity;
  };
  const errFlip = projErr(true), errNo = projErr(false);
  const flipY = errFlip <= errNo;
  const mapErr = Math.min(errFlip, errNo);

  // Linear-light chromaticity of a canvas rect. sRGB decode first — a step
  // measured on encoded bytes is a step in a nonlinear space and reads
  // differently in shadow than in light for no physical reason.
  const srgb = (b) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const LUT = new Float32Array(256);
  for (let i = 0; i < 256; i++) LUT[i] = srgb(i);
  const D = frame.data;
  const rectMean = (x0, y0, x1, y1) => {
    let r = 0, g = 0, b = 0, n = 0;
    const xa = Math.max(0, Math.round(x0)), xb = Math.min(frame.w, Math.round(x1));
    const ya = Math.max(0, Math.round(y0)), yb = Math.min(frame.h, Math.round(y1));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const o = (y * frame.w + x) * 4;
        r += LUT[D[o]]; g += LUT[D[o + 1]]; b += LUT[D[o + 2]]; n++;
      }
    }
    return n ? [r / n, g / n, b / n, n] : null;
  };
  const tileRect = (tx, ty) => {
    const x0 = tx * tileSize * sx, x1 = (tx + 1) * tileSize * sx;
    const yy = flipY ? ty : tilesY - 1 - ty;
    const y0 = yy * tileSize * sy, y1 = (yy + 1) * tileSize * sy;
    return [x0, y0, x1, y1];
  };

  const setOf = (t) => {
    const s = [];
    for (let k = 0; k < 4; k++) { const id = ids[t * 4 + k]; if (id !== EMPTY) s.push(id); }
    return s;
  };
  const symDiff = (a, b) => {
    let d = 0;
    for (const x of a) if (!b.includes(x)) d++;
    for (const x of b) if (!a.includes(x)) d++;
    return d;
  };

  // ── the census ───────────────────────────────────────────────────────────
  // FLOOR ONLY, and away from the lamps: a wall tile next to a floor tile is a
  // genuine geometric edge and would load every bucket equally, but the lamps
  // themselves are emissive PIXELS whose colour has nothing to do with delivery
  // (the §13-era trap: a lamp in frame passes a brightness gate with the whole
  // transport severed).
  const lampXZ = [];
  for (const m of lampMeshes) lampXZ.push([m.position.x, m.position.z]);
  // ⚠ THE EDITOR DRAWS A 3D-CURSOR CROSSHAIR AT THE CANVAS CENTRE and it is a
  // few px of saturated red/green sitting on the floor. The first run's mono
  // NULL read a p99 chroma excess of ×16 off SIX tiles, all of them at
  // (35..37, 17..19) — the crosshair, not the GI. Excluded by position, and
  // named here because a tail statistic will find any overlay you leave in.
  const cTx = Math.floor(tilesX / 2), cTy = Math.floor(tilesY / 2);
  // THE FLOOR IS FOUND, NOT ASSUMED — the user's scene has no rig-authored
  // slab at y=0. Take the up-facing valid tiles, use their MEDIAN height, and
  // keep the band around it: one continuous receiving plane, which is what
  // makes an adjacent-tile pair a comparison of LIGHT rather than of geometry.
  const upY = [];
  for (let t = 0; t < tilesX * tilesY; t++) {
    if (pos[t * TILE_F + 3] > 0.5 && pos[t * TILE_F + 5] >= 0.8) upY.push(pos[t * TILE_F + 1]);
  }
  upY.sort((a, b) => a - b);
  const floorY = upY.length ? upY[Math.floor(upY.length / 2)] : 0;
  const onFloor = (t) => {
    const tx = t % tilesX, ty = Math.floor(t / tilesX);
    if (Math.abs(tx - cTx) <= 4 && Math.abs(ty - cTy) <= 4) return false;
    if (!(pos[t * TILE_F + 3] > 0.5)) return false;
    if (Math.abs(pos[t * TILE_F + 1] - floorY) > 0.4) return false;
    if (pos[t * TILE_F + 5] < 0.8) return false;           // N.y — up-facing only
    const x = pos[t * TILE_F], z = pos[t * TILE_F + 2];
    for (const [lx, lz] of lampXZ) if ((x - lx) ** 2 + (z - lz) ** 2 < 4) return false;
    return true;
  };

  const buckets = new Map();     // setDiff → { chroma:[], lum:[] }
  const push = (d, chroma, lum) => {
    if (!buckets.has(d)) buckets.set(d, { chroma: [], lum: [] });
    const b = buckets.get(d);
    b.chroma.push(chroma); b.lum.push(lum);
  };
  const worst = [];
  const chromaOf = (c) => { const s = c[0] + c[1] + c[2]; return s > 1e-6 ? [c[0] / s, c[1] / s, c[2] / s] : null; };
  const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  const cache = new Map();
  const meanOf = (t) => {
    if (cache.has(t)) return cache.get(t);
    const [x0, y0, x1, y1] = tileRect(t % tilesX, Math.floor(t / tilesX));
    const m = rectMean(x0, y0, x1, y1);
    cache.set(t, m);
    return m;
  };

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const t = ty * tilesX + tx;
      if (!onFloor(t)) continue;
      // ⚠⚠ THE BASELINE IS FIXED IN EMITTER PIXELS, NOT IN TILES, AND THAT IS
      // THE WHOLE VALIDITY OF A tileSize A/B. Neighbouring TILES are `tileSize`
      // emitter-px apart, so comparing tileSize 1 against tileSize 2 with a
      // one-tile offset measures the step over HALF the world distance — and a
      // smooth gradient then reads ~half as steep for free. The first run of
      // that A/B reported a 40% win that was mostly this. `PAIR_TX` emitter
      // pixels is the same physical baseline in every arm.
      const PAIR_TX = 2;
      const stride = Math.max(1, Math.round(PAIR_TX / tileSize));
      for (const [ox, oy] of [[stride, 0], [0, stride]]) {
        const nx2 = tx + ox, ny2 = ty + oy;
        if (nx2 >= tilesX || ny2 >= tilesY) continue;
        const u = ny2 * tilesX + nx2;
        if (!onFloor(u)) continue;
        // Reject pairs that straddle a real depth/orientation step — the
        // census must not count geometry as if it were the cut.
        const dp = Math.hypot(pos[t * TILE_F] - pos[u * TILE_F], pos[t * TILE_F + 1] - pos[u * TILE_F + 1], pos[t * TILE_F + 2] - pos[u * TILE_F + 2]);
        if (dp > 0.6) continue;
        const a = meanOf(t), b = meanOf(u);
        if (!a || !b || a[3] < 2 || b[3] < 2) continue;
        const ca = chromaOf(a), cb = chromaOf(b);
        if (!ca || !cb) continue;
        const la = lumOf(a), lb = lumOf(b);
        if (la < 0.002 || lb < 0.002) continue;
        const dChroma = Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2]);
        const dLum = Math.abs(la - lb) / (0.5 * (la + lb));
        const d = symDiff(setOf(t), setOf(u));
        push(d, dChroma, dLum);
        if (d >= 1) worst.push({ tx, ty, d, dChroma, dLum });
      }
    }
  }

  const q = (arr, f) => {
    if (!arr.length) return NaN;
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.round(f * (s.length - 1)))];
  };
  const summarize = (b) => ({
    n: b.chroma.length,
    chroma: { p50: q(b.chroma, 0.5), p90: q(b.chroma, 0.9), p99: q(b.chroma, 0.99) },
    lum: { p50: q(b.lum, 0.5), p90: q(b.lum, 0.9), p99: q(b.lum, 0.99) },
  });
  const out = {};
  for (const [d, b] of [...buckets.entries()].sort((a, c) => a[0] - c[0])) out[d] = summarize(b);
  // The pooled "any set change" bucket — the headline comparison against 0.
  const anyC = [], anyL = [];
  for (const [d, b] of buckets) if (d >= 1) { anyC.push(...b.chroma); anyL.push(...b.lum); }
  // ⚠ THE RATIO IS NOT THE ANSWER ON ITS OWN. A fix that smooths the seam but
  // sprays new steps over the control improves every ratio here while making
  // the picture worse — the first §13.8 attempt did exactly that. So the
  // POOLED distribution over EVERY measured boundary ships beside the ratios,
  // and it is the number that has to fall.
  const allC = [], allL = [];
  for (const [, b] of buckets) { allC.push(...b.chroma); allL.push(...b.lum); }
  const any = anyC.length ? { n: anyC.length, chroma: { p50: q(anyC, 0.5), p90: q(anyC, 0.9), p99: q(anyC, 0.99) },
    lum: { p50: q(anyL, 0.5), p90: q(anyL, 0.9), p99: q(anyL, 0.99) } } : null;

  worst.sort((a, b) => b.dChroma - a.dChroma);

  // Is the fade actually ENGAGING? The marginal channel's weight over the
  // measured floor — all 1.000 means the feather is off or never binds, and
  // then any improvement below came from somewhere else.
  const wMin = [];
  for (let t = 0; t < tilesX * tilesY; t++) {
    if (!onFloor(t)) continue;
    wMin.push(Math.min(pos[t * TILE_F + 8], pos[t * TILE_F + 9], pos[t * TILE_F + 10], pos[t * TILE_F + 11]));
  }
  wMin.sort((a, b) => a - b);
  const wq = (f) => (wMin.length ? wMin[Math.min(wMin.length - 1, Math.round(f * (wMin.length - 1)))] : NaN);

  // ── the picture: frame on the left, setDiff overlay on the right ─────────
  let png = null;
  if (wantPng) {
    const c2 = document.createElement("canvas");
    c2.width = frame.w * 2 + 8; c2.height = frame.h;
    const g = c2.getContext("2d");
    g.fillStyle = "#c00"; g.fillRect(0, 0, c2.width, c2.height);
    g.drawImage(frame.canvas, 0, 0);
    g.drawImage(frame.canvas, frame.w + 8, 0);
    g.globalAlpha = 0.75;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const t = ty * tilesX + tx;
        if (!onFloor(t) || tx + 1 >= tilesX) continue;
        const u = ty * tilesX + tx + 1;
        if (!onFloor(u)) continue;
        const d = symDiff(setOf(t), setOf(u));
        if (!d) continue;
        const [x0, y0, , y1] = tileRect(tx, ty);
        g.fillStyle = d >= 2 ? "#ff2020" : "#ffd020";
        g.fillRect(frame.w + 8 + x0 + tileSize * sx - 1, y0, 2, Math.max(1, y1 - y0));
      }
    }
    png = c2.toDataURL("image/png");
  }

  return {
    cutArmed: true,
    tilesX, tilesY, tileSize, emitterW, emitterH,
    canvas: { w: frame.w, h: frame.h },
    resolve: `${screen.width}x${screen.height}`,
    treeCount,
    compCap: live.compCap ?? null,
    feather: live.feather ?? null,
    srcStats,
    wMin: { n: wMin.length, p05: wq(0.05), p25: wq(0.25), p50: wq(0.5), p95: wq(0.95) },
    shadowDump, passMs,
    flipY, mapErr,
    buckets: out, any,
    pooled: allC.length
      ? { n: allC.length, chroma: { p50: q(allC, 0.5), p90: q(allC, 0.9), p99: q(allC, 0.99) },
          lum: { p50: q(allL, 0.5), p90: q(allL, 0.9), p99: q(allL, 0.99) } }
      : null,
    worst: worst.slice(0, 8),
    png,
  };
}, { lamps, colours, arm, quality, wantPng, projectMode: !!PROJECT, extra: EXTRA, dumpShadow: DUMP });

if (result.fail && !result.cutArmed) {
  console.log(`\nNOTE: ${result.fail}`);
}
if (!sawField) console.log("⚠ no `field ready` line — the field may not have been built");

console.log(`\nlamps ${lamps} (${colours})  arm=${arm}  quality=${quality}`);
if (result.cutArmed) {
  console.log(`tree emitters ${result.treeCount}  tiles ${result.tilesX}×${result.tilesY} @ tileSize ${result.tileSize}` +
    `  emitter buf ${result.emitterW}×${result.emitterH}  resolve ${result.resolve}  canvas ${result.canvas.w}×${result.canvas.h}`);
  console.log(`tile→canvas map: flipY=${result.flipY}  residual ${result.mapErr.toFixed(2)} px  (a broken map reads tens of px)`);
  if (result.srcStats) {
    const st = result.srcStats;
    console.log(`SRC: s0 ${st.spacing0}  gather meanCorners ${st.gather?.meanCorners?.toFixed(2) ?? "?"}/8  empty ${st.gather?.empty ?? "?"}  ` +
      `cascades ${st.cascades.map((c) => `${c.live}/${c.cap}${c.dropped ? ` DROPPED ${c.dropped}` : ""}`).join(" ")}  reanchors ${st.reanchors}`);
  }
  console.log(`tail compensation cap ${result.compCap}   soft-cut feather ${result.feather ?? "?"}`);
  if (result.wMin) {
    console.log(`marginal-channel weight over the measured floor (n=${result.wMin.n}): ` +
      `p05 ${result.wMin.p05.toFixed(3)}  p25 ${result.wMin.p25.toFixed(3)}  p50 ${result.wMin.p50.toFixed(3)}  p95 ${result.wMin.p95.toFixed(3)}` +
      `   (all 1.000 = the fade never binds)`);
  }
  console.log(`\nADJACENT FLOOR TILE PAIRS, bucketed by kept-set symmetric difference.`);
  console.log(`  setDiff 0 is the MATCHED CONTROL: same scene, same 2-px scale, same noise, sets agree.\n`);
  console.log(`  ${"setDiff".padEnd(9)}${"pairs".padStart(8)}   Δchroma p50 / p90 / p99      Δlum(rel) p50 / p90 / p99`);
  for (const [d, s] of Object.entries(result.buckets)) {
    console.log(`  ${String(d).padEnd(9)}${String(s.n).padStart(8)}   ` +
      `${s.chroma.p50.toFixed(4)} / ${s.chroma.p90.toFixed(4)} / ${s.chroma.p99.toFixed(4)}      ` +
      `${s.lum.p50.toFixed(4)} / ${s.lum.p90.toFixed(4)} / ${s.lum.p99.toFixed(4)}`);
  }
  const ctrl = result.buckets["0"];
  if (ctrl && result.any) {
    const rc = (k) => result.any.chroma[k] / Math.max(1e-9, ctrl.chroma[k]);
    const rl = (k) => result.any.lum[k] / Math.max(1e-9, ctrl.lum[k]);
    console.log(`\n  ${"≥1 (pooled)".padEnd(9)}${String(result.any.n).padStart(8)}   ` +
      `${result.any.chroma.p50.toFixed(4)} / ${result.any.chroma.p90.toFixed(4)} / ${result.any.chroma.p99.toFixed(4)}      ` +
      `${result.any.lum.p50.toFixed(4)} / ${result.any.lum.p90.toFixed(4)} / ${result.any.lum.p99.toFixed(4)}`);
    console.log(`\nVERDICT  Δchroma excess over the control: p50 ×${rc("p50").toFixed(2)}  p90 ×${rc("p90").toFixed(2)}  p99 ×${rc("p99").toFixed(2)}`);
    console.log(`         Δlum    excess over the control: p50 ×${rl("p50").toFixed(2)}  p90 ×${rl("p90").toFixed(2)}  p99 ×${rl("p99").toFixed(2)}`);
    console.log(`         (~×1 everywhere = the cut is NOT the seam. A chroma excess with Δlum ≈ ×1 is`);
    console.log(`          the predicted signature: the tail compensation conserves ENERGY, not HUE.)`);
    const frac = result.any.n / (result.any.n + ctrl.n);
    console.log(`         set changes on ${(frac * 100).toFixed(1)}% of measured floor boundaries`);
  }
  if (result.pooled) {
    const p = result.pooled;
    console.log(`\nPOOLED over ALL ${p.n} measured boundaries (the number a fix must actually lower):`);
    console.log(`         Δchroma p50 ${p.chroma.p50.toFixed(4)}  p90 ${p.chroma.p90.toFixed(4)}  p99 ${p.chroma.p99.toFixed(4)}`);
    console.log(`         Δlum    p50 ${p.lum.p50.toFixed(4)}  p90 ${p.lum.p90.toFixed(4)}  p99 ${p.lum.p99.toFixed(4)}`);
  }
  if (result.worst?.length) {
    console.log(`\n  worst boundaries: ${result.worst.map((w) => `(${w.tx},${w.ty}) d${w.d} Δc ${w.dChroma.toFixed(3)}`).join("  ")}`);
  }
}
if (wantPng && result.png) {
  const f = `${OUT}/seam-${colours}-${lamps}-${arm.replace(/[^\w]+/g, "_")}.png`;
  writeFileSync(f, Buffer.from(result.png.split(",")[1], "base64"));
  console.log(`\nwrote ${f}  (left: frame — right: same frame with set-change boundaries marked)`);
}
if (result.passMs) {
  const rows = Array.isArray(result.passMs?.passes) ? result.passMs.passes : (Array.isArray(result.passMs) ? result.passMs : null);
  if (rows) {
    const top = rows.filter((p) => /emitter|resolve|cut/i.test(p.name ?? "")).slice(0, 8);
    console.log(`
GPU per-pass ms: ${top.map((p) => `${p.name} ${Number(p.ms ?? p.gpuMs ?? 0).toFixed(2)}`).join("  ")}`);
  } else {
    console.log(`
profile.giPasses: ${JSON.stringify(result.passMs).slice(0, 400)}`);
  }
}
if (result.shadowDump?.png) {
  const fn = `${OUT}/shadow-${arm.replace(/[^w]+/g, "_")}.png`;
  writeFileSync(fn, Buffer.from(result.shadowDump.png.split(",")[1], "base64"));
  console.log(`
wrote ${fn} — emitter shadow channels 0..3 (${result.shadowDump.W}x${result.shadowDump.H}), FINAL top${result.shadowDump.hasMid ? ", MID bottom" : ""}`);
} else if (result.shadowDump?.fail) {
  console.log(`
shadow dump failed: ${result.shadowDump.fail}`);
}
await browser.close();
