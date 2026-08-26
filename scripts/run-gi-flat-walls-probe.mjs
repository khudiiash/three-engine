// FLAT-WALLS PROBE (2026-08-20).
//
// THE REPORT: "our GI looks so flat — there is no light coming from the
// emitters onto the vertical walls" (the user's Level: 51 tree emitters, all
// of them long thin `Glow_*` strips, in a 31 x 16 x 31 m multi-storey
// blockout).
//
// THE INSTRUMENT IS A RATIO AGAINST GROUND TRUTH, NOT A PICTURE. "Flat" is a
// judgement about an image; it cannot convict anything on its own, because a
// dim wall is equally consistent with (a) the wall genuinely facing away from
// every lamp and (b) a transport that drops the lamps it should deliver. So
// for every sampled surface point this rig computes what the emitter set
// SHOULD deliver — the exact Lambert form factor of every fitted emitter
// shape, summed over all N of them, `emitterShapes.js`'s own CPU reference,
// the same functions the GPU path mirrors — and divides the RENDERED
// radiance by it.
//
//     eff = renderLuma / (albedoLuma * E_analytic_luma)
//
// If the transport delivers what the geometry says it should, `eff` is the
// same constant on a floor and on a wall. A systematically LOWER `eff` on
// vertical normals is the reported bug with a number on it; equal numbers
// exonerate the transport and point at authoring (the lamps really are
// pointed at the floor) or at tone mapping.
//
// Samples come from a CPU raycast through the editor's own camera, so every
// sample carries its exact world position, its exact face normal and its
// exact material — no gbuffer readback, no 256-byte row padding, no guessing
// which pixel is a wall.
//
// ══ THE SECOND METRIC: WHAT THE TOP-4 CUT IS CLIPPING ══════════════════════
//
// `createGiEmitterTileCutPass` keeps the four most important emitters per tile
// and compensates the dropped tail by `Sum(imp) / Sum(imp kept)` CAPPED AT 2
// (§12.70 W4c). The cap's own comment says "with 54 emitters the ratio sits
// near the cap over most of a room". This scene has 51. So the rig also
// reports, per sample, the true `Sum(all) / Sum(top 4)` over the analytic
// contributions — which is what the compensation is estimating — bucketed by
// orientation. A median well above 2 means the direct emitter term is clipped
// by construction, everywhere, and by how much.
//
//   node scripts/run-gi-flat-walls-probe.mjs [url]
// Env:
//   PROJECT=C:/Users/Khudiiash/Documents/GAME   the user's own project, booted
//                   READ-ONLY through the tauri shim. Required — a rig scene
//                   is a hypothesis, their scene is the case.
//   POSE=px,py,pz,tx,ty,tz   camera (default: the screenshot's pose)
//   ARM=default     comma set: nocomp (__giTileCutCompensate=1),
//                   comp=<n> (__giTileCutCompensate=<n>, e.g. 64 = uncapped),
//                   srcoff (__giSrcProbes=false — direct term only),
//                   noamb (scene ambient light to 0)
//   GRID=48         rays across; the vertical count follows the aspect
//   PNG=1           dump the measured frame
//   EXTRA={"__giX":false}   arm any dev global
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5335/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const POSE = (process.env.POSE ?? "3.27,3.10,9.54,0.61,-0.46,15.50").split(",").map(Number);
const arm = process.env.ARM ?? "default";
const grid = Number(process.env.GRID ?? 48);
const wantPng = process.env.PNG === "1";
const settle = Number(process.env.SETTLE ?? 6000);
const EXTRA = process.env.EXTRA ? JSON.parse(process.env.EXTRA) : null;
const OUT = ".gi-shots/flat-walls";
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
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] (built|emitter tile cut|emitter ledger|light tree|field ready|src probes|diffuse indirect|thinner)|PROBE/.test(t)) {
    console.log(`  ${t.slice(0, 260)}`);
  }
});
page.on("pageerror", (e) => {
  const msg = String(e.message ?? e);
  if (!/save_scene/.test(msg)) console.log(`pageerror: ${msg.slice(0, 400)}`);
});
if (process.env.DEBUG === "1") {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`  [${m.type()}] ${m.text().slice(0, 500)}`);
  });
}

// READ-ONLY by construction: no `writableRoot`, so every write the editor
// issues against the user's project is refused by the shim.
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project, armStr, extra) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  const flags = new Set(String(armStr).split(",").map((s) => s.trim()).filter(Boolean));
  if (flags.has("nocomp")) globalThis.__giTileCutCompensate = 1;
  if (flags.has("srcoff")) globalThis.__giSrcProbes = false;
  // The 2026-08-20 horizon-clip A/B: `noclip` restores the pre-fix emitter
  // form factor, which clamped a straddling face to zero.
  if (flags.has("noclip")) globalThis.__giPolyHorizonClip = false;
  for (const f of flags) {
    const m = /^comp=([\d.]+)$/.exec(f);
    if (m) globalThis.__giTileCutCompensate = Number(m[1]);
  }
  if (extra) for (const [k, v] of Object.entries(extra)) globalThis[k] = v;
}, PROJECT, arm, EXTRA);

await page.goto(url, { waitUntil: "load", timeout: 90000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 90000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
await page.evaluate(async (p) => {
  const end = performance.now() + 180_000;
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

const result = await page.evaluate(async ({ arm, grid, wantPng, settle }) => {
  const flags = new Set(String(arm).split(",").map((s) => s.trim()).filter(Boolean));
  globalThis.__editorKeepRendering = true;

  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  if (!engine) return { fail: "no engine" };
  // POLL. The GI module is enabled by the project's own boot, which races the
  // harness — `ensureEngine` resolves well before the module list is applied.
  let system = null;
  {
    const end = performance.now() + 180_000;
    for (;;) {
      system = engine.modules?.get?.("gi")?.system ?? null;
      if (system) break;
      if (performance.now() > end) {
        return {
          fail: "gi module not enabled",
          modules: [...(engine.modules?.keys?.() ?? [])],
          entities: engine.entities?.size ?? -1,
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  // ...and then for the field itself: a system with no field has nothing to say.
  {
    const end = performance.now() + 180_000;
    while (!system.state && performance.now() < end) await new Promise((r) => setTimeout(r, 500));
  }
  const { THREE } = await import("/src/engine/index.js");
  const { collectEmitters } = await import("/src/modules/gi/lightTree.js");
  const { refShapeFactor, EMITTER_KIND } = await import("/src/modules/gi/emitterShapes.js");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Let the field settle at this pose. SRC is temporal: reading one frame after
  // a camera jump measures the transient, not the answer.
  await sleep(settle);

  const renderer = engine.renderer;
  const scene = engine.scene;
  const camera = engine.camera ?? engine.activeCamera ?? null;
  if (!camera) return { fail: "no camera" };

  // ── MEASURE IN LINEAR LIGHT ────────────────────────────────────────────────
  // AgX is a strong, saturating, monotone curve. A ratio measured through it is
  // not the ratio of the radiances, and the whole metric here IS a ratio. This
  // is live renderer state only — nothing is written to the project.
  const prevTone = renderer.toneMapping;
  const prevExposure = renderer.toneMappingExposure;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;

  // Optional arm: kill the scene's flat unoccluded ambient so the measurement
  // sees only what the lamps deliver.
  const ambients = [];
  if (flags.has("noamb")) {
    scene.traverse((o) => {
      if (o.isAmbientLight || o.isHemisphereLight) { ambients.push([o, o.intensity]); o.intensity = 0; }
    });
  }
  // ── ARM `bright`: RAISE THE ALBEDO, LIVE, AND SEE WHAT THE BOUNCE DOES ─────
  //
  // The level authors every surface at #707070 / #807d97, which reads as "mid
  // grey" in a colour picker and is 0.16 / 0.21 LINEAR reflectance. A closed
  // diffuse enclosure amplifies direct light by 1/(1-rho), so rho = 0.16 caps
  // every bounce in the room at +19% no matter how good the transport is.
  // This arm sets the same surfaces to 0.7 linear (Blender's default grey is
  // 0.8) and changes NOTHING else, so the delta is the bounce's headroom.
  // Live renderer state only — no .mat file is touched, and the shim would
  // refuse the write anyway.
  const restoreAlbedo = [];
  let brightened = 0;
  if (flags.has("bright")) {
    const seen = new Set();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        const em = m.emissive;
        const isEmitter = em && (em.r + em.g + em.b) > 1e-4;
        if (isEmitter || !m.color) continue;
        restoreAlbedo.push([m, m.color.clone()]);
        m.color.setRGB(0.7, 0.7, 0.7, THREE.LinearSRGBColorSpace);
        m.needsUpdate = true;
        brightened++;
      }
    });
    // The GI bounce palette re-tints on its own scan cadence, not on the frame.
    await sleep(9000);
  }
  await sleep(2500);

  // ── THE EMITTER SET, AS THE LIGHT TREE ITSELF SEES IT ──────────────────────
  const emitters = collectEmitters(scene).filter((e) => e && e.rgb);
  const bz = (e) => {
    const x = e.bx, y = e.by;
    return [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  };
  const shapes = emitters.map((e) => ({
    kind: e.kind,
    center: e.centre,
    half: e.half,
    bx: e.bx,
    by: e.by,
    bz: bz(e),
    radius: e.angularRadius,
    rgb: e.rgb,
  }));
  const emitterMeshes = new Set(emitters.map((e) => e.mesh));

  // ── SAMPLES: A CPU RAYCAST THROUGH THE EDITOR'S OWN CAMERA ─────────────────
  // Every sample carries its exact P, its exact face normal and its exact
  // material — which is what makes "this pixel is a wall" a fact rather than a
  // gbuffer-normal guess.
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const targets = [];
  scene.traverse((o) => {
    if (!o.isMesh || o.visible === false) return;
    if (o.userData?.__giDebug || o.userData?.editorOnly) return;
    targets.push(o);
  });

  const W = grid;
  const H = Math.max(4, Math.round(grid * (renderer.domElement.height / renderer.domElement.width)));
  const samples = [];
  const nm = new THREE.Matrix3();
  const nrm = new THREE.Vector3();
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const ndcX = ((i + 0.5) / W) * 2 - 1;
      const ndcY = 1 - ((j + 0.5) / H) * 2;
      raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
      const hits = raycaster.intersectObjects(targets, false);
      const hit = hits.find((h) => h.face && !emitterMeshes.has(h.object));
      if (!hit) continue;
      nm.getNormalMatrix(hit.object.matrixWorld);
      nrm.copy(hit.face.normal).applyMatrix3(nm).normalize();
      // Face the normal at the camera — a box's back face is not what this
      // pixel shows, and the renderer shades the visible side.
      const toCam = camera.position.clone().sub(hit.point);
      if (nrm.dot(toCam) < 0) nrm.multiplyScalar(-1);
      const mat = Array.isArray(hit.object.material) ? hit.object.material[0] : hit.object.material;
      const col = mat?.color ? mat.color.clone() : new THREE.Color(0.5, 0.5, 0.5);
      const emissive = mat?.emissive ? mat.emissive.getHex() : 0;
      samples.push({
        u: (i + 0.5) / W,
        v: (j + 0.5) / H,
        P: [hit.point.x, hit.point.y, hit.point.z],
        N: [nrm.x, nrm.y, nrm.z],
        albedo: [col.r, col.g, col.b],
        emissiveHex: emissive,
        dist: hit.distance,
        name: hit.object.name || "",
      });
    }
  }

  // ── ANALYTIC GROUND TRUTH ──────────────────────────────────────────────────
  // Unshadowed first (the pure geometric bound), then with ONE visibility ray
  // per emitter centre. Unshadowed is the honest upper bound; shadowed is the
  // number a correct renderer should land near for a diffuse surface.
  const LUMA = [0.2126, 0.7152, 0.0722];
  const shadowRay = new THREE.Raycaster();
  shadowRay.firstHitOnly = true;
  const from = new THREE.Vector3();
  const dir = new THREE.Vector3();
  for (const s of samples) {
    const E = [0, 0, 0];
    const Evis = [0, 0, 0];
    const contrib = [];
    for (let k = 0; k < shapes.length; k++) {
      const sh = shapes[k];
      const f = refShapeFactor(sh, s.P, s.N);
      if (!(f > 0)) { contrib.push(0); continue; }
      const c = [sh.rgb[0] * f, sh.rgb[1] * f, sh.rgb[2] * f];
      E[0] += c[0]; E[1] += c[1]; E[2] += c[2];
      contrib.push(c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]);
      // Visibility: centre-to-centre, stopped just short of the emitter.
      from.set(s.P[0] + s.N[0] * 0.02, s.P[1] + s.N[1] * 0.02, s.P[2] + s.N[2] * 0.02);
      dir.set(sh.center[0] - from.x, sh.center[1] - from.y, sh.center[2] - from.z);
      const d = dir.length();
      dir.divideScalar(d);
      shadowRay.set(from, dir);
      shadowRay.far = Math.max(0.01, d - Math.max(0.05, sh.radius));
      const blocked = shadowRay.intersectObjects(targets, false)
        .some((h) => !emitterMeshes.has(h.object));
      if (!blocked) { Evis[0] += c[0]; Evis[1] += c[1]; Evis[2] += c[2]; }
    }
    s.E = E;
    s.Evis = Evis;
    s.Elum = E[0] * LUMA[0] + E[1] * LUMA[1] + E[2] * LUMA[2];
    s.EvisLum = Evis[0] * LUMA[0] + Evis[1] * LUMA[1] + Evis[2] * LUMA[2];
    // WHAT THE TOP-4 CUT CLIPS: Sum(all) / Sum(top 4) over this receiver's own
    // contributions — the quantity the tail compensation estimates and caps.
    contrib.sort((a, b) => b - a);
    const total = contrib.reduce((a, b) => a + b, 0);
    const kept = contrib.slice(0, 4).reduce((a, b) => a + b, 0);
    s.cutRatio = kept > 1e-20 ? total / kept : 1;
    s.contributors = contrib.filter((c) => c > total * 0.01).length;
  }

  // ── THE RENDERED FRAME ─────────────────────────────────────────────────────
  const canvas = renderer.domElement;
  const cw = canvas.width;
  const ch = canvas.height;
  const off = new OffscreenCanvas(cw, ch);
  const ctx = off.getContext("2d");
  // WebGPU canvases are not persistently readable; draw the live canvas into a
  // 2D one on the same frame the renderer presented.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  ctx.drawImage(canvas, 0, 0);
  const img = ctx.getImageData(0, 0, cw, ch).data;
  const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const pixelAt = (u, v) => {
    const x = Math.min(cw - 1, Math.max(0, Math.round(u * cw)));
    const y = Math.min(ch - 1, Math.max(0, Math.round(v * ch)));
    const o = (y * cw + x) * 4;
    return [
      srgbToLinear(img[o] / 255),
      srgbToLinear(img[o + 1] / 255),
      srgbToLinear(img[o + 2] / 255),
    ];
  };

  const buckets = {
    "up (N.y > 0.8)": [],
    "vertical (|N.y| < 0.3)": [],
    "down (N.y < -0.8)": [],
  };
  const classify = (ny) => (ny > 0.8 ? "up (N.y > 0.8)" : ny < -0.8 ? "down (N.y < -0.8)" : Math.abs(ny) < 0.3 ? "vertical (|N.y| < 0.3)" : null);

  for (const s of samples) {
    if (s.emissiveHex) continue;               // a lamp's own pixels are not delivered light
    const b = classify(s.N[1]);
    if (!b) continue;
    const rgb = pixelAt(s.u, s.v);
    s.render = rgb;
    s.renderLum = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
    s.albedoLum = s.albedo[0] * LUMA[0] + s.albedo[1] * LUMA[1] + s.albedo[2] * LUMA[2];
    buckets[b].push(s);
  }

  const pct = (arr, p) => {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(p * a.length))];
  };
  // A LAMBERTIAN RECEIVER OUTPUTS `albedo/pi * E`, so a transport that
  // delivered the analytic irradiance EXACTLY reads eff == 1 here. Above 1 is
  // the extra terms the render also carries (indirect bounce, scene ambient,
  // the 12 punctual lights); below 1 is light the emitter set says should be
  // there and is not.
  const stat = (list) => {
    const eff = list
      .filter((s) => s.EvisLum > 1e-6 && s.albedoLum > 1e-3)
      .map((s) => (s.renderLum / (s.albedoLum * s.EvisLum)) * Math.PI);
    const effU = list
      .filter((s) => s.Elum > 1e-6 && s.albedoLum > 1e-3)
      .map((s) => (s.renderLum / (s.albedoLum * s.Elum)) * Math.PI);
    // ── FLATNESS IS A RANGE, NOT A LEVEL ────────────────────────────────────
    // "Flat" means the image compresses contrast the scene actually has. So
    // measure the DYNAMIC RANGE the geometry calls for (p90/p10 of the
    // analytic irradiance) against the range the frame delivers (p90/p10 of
    // render/albedo). Equal = faithful. Delivered range much smaller than
    // analytic range IS flatness, with a number.
    const refl = list.filter((s) => s.albedoLum > 1e-3).map((s) => s.renderLum / s.albedoLum);
    const eVals = list.map((s) => s.EvisLum);
    const range = (a) => {
      const lo = pct(a, 0.1);
      const hi = pct(a, 0.9);
      return lo > 1e-9 ? hi / lo : Infinity;
    };
    return {
      n: list.length,
      renderLum_p50: +pct(list.map((s) => s.renderLum), 0.5).toFixed(5),
      analyticVis_p50: +pct(eVals, 0.5).toFixed(4),
      analyticAll_p50: +pct(list.map((s) => s.Elum), 0.5).toFixed(4),
      // THE HEADLINE. Same number on a floor and on a wall = the transport is
      // orientation-fair; a lower one on the wall is the reported bug.
      eff_p50: +pct(eff, 0.5).toFixed(3),
      eff_p25: +pct(eff, 0.25).toFixed(3),
      eff_p75: +pct(eff, 0.75).toFixed(3),
      effUnshadowed_p50: +pct(effU, 0.5).toFixed(3),
      // FLATNESS.
      analyticRange_p90_p10: +range(eVals).toFixed(2),
      renderRange_p90_p10: +range(refl).toFixed(2),
      // What the top-4 cut is clipping at this orientation, against its cap of 2.
      cutRatio_p50: +pct(list.map((s) => s.cutRatio), 0.5).toFixed(2),
      cutRatio_p90: +pct(list.map((s) => s.cutRatio), 0.9).toFixed(2),
      contributors_p50: pct(list.map((s) => s.contributors), 0.5),
      shadowFraction_p50: +pct(list.filter((s) => s.Elum > 1e-6).map((s) => s.EvisLum / s.Elum), 0.5).toFixed(3),
    };
  };

  const out = {
    emitters: emitters.length,
    samples: samples.length,
    brightened,
    tileCut: {
      horizonClip: globalThis.__giPolyHorizonClip !== false,
      compensate: globalThis.__giTileCutCompensate ?? "(default 2)",
      lightTree: globalThis.__giSrcLightTree !== false,
      srcProbes: globalThis.__giSrcProbes !== false,
    },
    ledgerTop: [...emitters].sort((a, b) => b.power - a.power).slice(0, 4).map((e) => ({
      name: e.mesh?.name || "mesh",
      kind: e.kind,
      power: +e.power.toFixed(1),
      area: +e.area.toFixed(2),
      fill: +(e.fill ?? 1).toFixed(3),
      rgb: e.rgb.map((v) => +v.toFixed(2)),
    })),
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, stat(v)])),
  };
  if (wantPng) out.png = off.convertToBlob ? null : null;

  renderer.toneMapping = prevTone;
  renderer.toneMappingExposure = prevExposure;
  for (const [o, i] of ambients) o.intensity = i;
  return out;
}, { arm, grid, wantPng, settle });

if (wantPng) {
  const shot = await page.screenshot({ encoding: "base64" });
  writeFileSync(`${OUT}/frame-${arm.replaceAll(/[^\w]/g, "_")}.png`, Buffer.from(shot, "base64"));
}

console.log(`\nARM=${arm}  emitters=${result.emitters} samples=${result.samples} ` +
  `tileCut=${JSON.stringify(result.tileCut)}`);
for (const [k, v] of Object.entries(result.buckets ?? {})) {
  if (!v.n) continue;
  console.log(`  ${k.padEnd(24)} n=${String(v.n).padStart(4)}  eff ${v.eff_p50} (${v.eff_p25}..${v.eff_p75})  ` +
    `render ${v.renderLum_p50}  E ${v.analyticVis_p50}  vis ${v.shadowFraction_p50}  ` +
    `range analytic ${v.analyticRange_p90_p10} vs render ${v.renderRange_p90_p10}  ` +
    `cut ${v.cutRatio_p50}/${v.cutRatio_p90} over ${v.contributors_p50} contributors`);
}
if (result.fail) console.log(JSON.stringify(result, null, 2));
await browser.close();
