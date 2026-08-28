// EVERY GI DEBUG VIEW, ON THE PATH THAT IS ACTUALLY LIT (§19 4.3f, audits §AB)
//
// ══ WHAT THIS PROBE IS FOR ══════════════════════════════════════════════════
//
// The debug views are the instruments this module is debugged WITH, and under
// GI2 three of the seven were a silent no-op and a fourth was unreadable:
//
//   · `occupancy` / `sdf` / `src-probes` read SRC structures (`state.gizmos.
//     sdfView`, `occView`, `screen.srcProbes`) that GI2 does not build. The
//     switch moved, nothing was logged, the frame did not change.
//   · `indirect` sampled `_giTargets.irradiance`, which the GI2 gather never
//     writes (fixed at 4.3e), and then showed the IRRADIANCE raw — a daylit
//     street clipped to a white sheet, because the frame builds `albedo·E/π`
//     and not `E` (fixed at 4.3f).
//   · `reflections-exact` fell through to the generic "no source is armed"
//     hint, which reads as a transient. There is no BVH mirror tier on GI2 at
//     all; that is structural and now says so.
//
// So the probe measures, for EVERY mode: does it compile, does it draw, and is
// the picture in a readable range — with the per-view console receipt beside
// the pixels, because a coverage number alone cannot tell "the view is broken"
// from "the scene is dark here".
//
// ══ THE TRAPS THIS RIG HAS ALREADY PAID FOR, kept ═══════════════════════════
//
// 1. `gi.props.debugView = mode` DOES NOTHING — a raw props write skips the
//    accessor, so `onPropChanged` → `#applyDebugVisibility` never fires. Use
//    `setProp`. (Since 4.3f EVERY mode is on the prop, including the volume
//    views; the `__giDebugView` global is still the override and is exercised
//    by the `globalArm` below so the second path cannot rot.)
// 2. A full-page screenshot measures THE EDITOR'S CHROME — every arm scored
//    98.9% at identical luminance whether the overlay drew or not.
//    `viewport.screenshot` renders offscreen at the requested size.
// 3. **OrbitControls owns the camera.** Writing `engine.camera.position` +
//    `lookAt` is reverted on the next controls update. `viewport.setCamera` is
//    the supported path and calls `orbit.update()`.
// 4. The term views are only readable AFTER first light. Shot at scene-ready,
//    `indirect` measured 8.3% coverage — the pre-light state, not the view.
//
// ⚠ THE URL IS 5202 IN THIS WORKTREE, NEVER 5201 (private vite cache):
//     node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//
// Run:
//   npm run probe:gi-debug-views                        # the built-in rig
//   SCENE=Bistro npm run probe:gi-debug-views           # a real project scene
//   SCENE=Bistro POSE='x,y,z|x,y,z' HEADED=1 npm run probe:gi-debug-views
//
// Env: SCENE (bare name or full path; unset = the rig) · PROJECT · POSE ·
//      SETTLE · WIDTH/HEIGHT · HEADED
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "";
const SCENE_PATH = SCENE
  ? (SCENE.includes("/") || SCENE.includes("\\")
    ? SCENE.replaceAll("\\", "/")
    : `${PROJECT}/scenes/${SCENE}.scene`)
  : "";
const POSE_ENV = process.env.POSE ?? "";
const SETTLE = Number(process.env.SETTLE ?? (SCENE ? 10 : 3));
const WIDTH = Number(process.env.WIDTH ?? 480);
const HEIGHT = Number(process.env.HEIGHT ?? 320);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── THE MODES, AND WHAT EACH ONE IS GATED ON ────────────────────────────────
//
// `nonBlack` gates the PICTURE (share of screenshot texels above black);
// `receipt` names the console line that must appear. A mode with neither is
// REPORTED, not gated — `reflections-exact` on GI2 is deliberately in that
// class, because "no mirror tier yet" is the correct answer, not a failure.
const MODES = [
  { id: "indirect", nonBlack: 0.60, meanRange: [0.15, 0.70], p95Max: 0.95, clipMax: 0.05, receipt: /debug view "indirect"/ },
  { id: "ao", receipt: /debug view "ao"/, aoP50: [0.5, 1.0] },
  { id: "reflections", receipt: /debug view "reflections"/ },
  { id: "reflections-exact", report: true },
  { id: "occupancy", nonBlackGi2: 0.60, receipt: /debug view "occupancy"/ },
  { id: "sdf", nonBlackGi2: 0.60, receipt: /debug view "sdf"/ },
  { id: "src-probes", report: true, receipt: /debug view "src-probes"/ },
];

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
await page.setViewport({ width: SCENE ? 1650 : 1280, height: SCENE ? 970 : 860, deviceScaleFactor: 1 });
if (SCENE) {
  await installTauriShim(page, {});
  await page.evaluateOnNewDocument((project) => {
    globalThis.__editorKeepRendering = true;
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  }, PROJECT);
}

const errors = [];
let firstLightSeen = false;
// Console lines the GI system prints about debug views, bucketed by the mode
// that was selected when they arrived. The receipt IS half the instrument.
let currentMode = "boot";
const receipts = new Map();
page.on("pageerror", (error) => errors.push(error.message ?? String(error)));
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi2?\] (first light|field ready)/.test(text)) firstLightSeen = true;
  if (/\[gi\] debug view|GI-DV/.test(text)) {
    if (!receipts.has(currentMode)) receipts.set(currentMode, []);
    receipts.get(currentMode).push(text);
    for (const line of text.split("\n")) console.log(`      ${line}`);
  } else if (/\[gi2?\].*(rror|ailed|FAIL)/.test(text)) {
    console.log(`      ${text.slice(0, 200)}`);
  }
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });

// ── BOOT: a real project, or the built-in rig ───────────────────────────────
if (SCENE) {
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
  const opened = await page.evaluate(
    async (path) => {
      try { return { ok: true, v: await globalThis.__editorApi.call("scene.open", { path }) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    },
    SCENE_PATH,
  );
  if (!opened.ok) {
    console.log(`FATAL scene.open ${SCENE_PATH}: ${opened.error}`);
    await browser.close();
    process.exit(1);
  }
  console.log(`opened ${SCENE_PATH}`);
} else {
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await wait(5000);
  await page.evaluate(async () => {
    const { THREE } = await import("/src/engine/index.js");
    await import("/src/modules/index.js");
    const { enableEngineModule } = await import("/src/engine/modules.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    await enableEngineModule(engine, "gi");
    globalThis.__engine = engine;
    // A headless page is never focused, and a frozen viewport returns the same
    // stale frame to every arm — indistinguishable from "the overlay never drew".
    globalThis.__editorApi.viewport.freezeWhenUnfocused(false);

    const material = (color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
    // A room with the features each view exists to expose: a floor a ray can
    // hug, a thin wall (about one voxel), a pillar and a sphere so both flat
    // and curved silhouettes are judgeable — and four DIFFERENT albedos, so the
    // occupancy view's palette colouring has something to be wrong about.
    const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); engine.scene.add(mesh); return mesh; };
    add(new THREE.Mesh(new THREE.BoxGeometry(12, 0.3, 12), material(0xcccccc)), 0, -0.15, 0);
    add(new THREE.Mesh(new THREE.BoxGeometry(12, 5, 0.3), material(0x999999)), 0, 2.5, -6);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 5, 12), material(0x99bb99)), -6, 2.5, 0);
    add(new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.12), material(0xbb8844)), -3, 1.5, 1);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 3, 0.5), material(0xb0b0b0)), 1.5, 1.5, 0);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.8, 32, 24), material(0x4466aa)), 3.2, 0.8, 1.5);
    const lamp = add(new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), material(0xffffff)), -1, 3.4, 2);
    lamp.material.emissive = new THREE.Color(0xffffff);
    lamp.material.emissiveIntensity = 30;
    // ⚠ A SUN, OR THE `indirect` VIEW HAS NOTHING TO SHOW. Without one this rig
    // has a single small emitter and the gather resolves ~5% of the frame above
    // black — a correct answer that reads exactly like a broken view, and one
    // that no brightness gate can be written against. `#collectLightObjects`
    // takes any visible directional/point light straight off the scene graph.
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(6, 12, 5);
    engine.scene.add(sun);

    const giEntity = engine.createEntity({ name: "GI" });
    const gi = giEntity.addComponent("global-illumination", { autoFit: true, quality: "high", intensity: 1 });
    globalThis.__gi = gi;
    console.log("GI-DV rig ready");
  });
}

// The two switch paths, both exercised. `setProp` is the inspector's; the
// global is the console override that has to beat it.
//
// ⚠⚠ THE ENGINE COMES FROM `engineInstance.js`, NOT FROM A GLOBAL THE RIG SET.
// On the real-project arm nothing sets `__engine`, so a lookup through it
// returns null — and then `setProp` silently no-ops, every arm renders whatever
// the SCENE saved, and the table reads "all seven views identical to the
// control". Measured exactly that way once: Bistro.scene carries
// `debugView: "indirect"` from the user's own session, so the "off" control was
// the indirect view and every Δ was the noise floor.
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__engine ??= mod.engine;
  const sys = () => (globalThis.__engine ?? mod.engine)?.modules?.get?.("gi")?.system ?? null;
  globalThis.__giSysForProbe = sys;
  globalThis.__giComponent = () => globalThis.__gi ?? sys()?.component ?? null;
  globalThis.__setPropView = (mode) => { globalThis.__giComponent()?.setProp?.("debugView", mode); };
  globalThis.__setGlobalView = (mode) => {
    if (mode === "off") delete globalThis.__giDebugView;
    else globalThis.__giDebugView = mode;
  };
});

// ⚠ AO AND REFLECTIONS MUST BE ON, OR TWO VIEWS HAVE NOTHING TO SHOW.
//
// Measured on Bistro: the `ao` view reported "NO SOURCE — no source texture is
// armed", which is the CORRECT answer for a scene saved with the Ambient
// Occlusion toggle off — `#armGtaoPass` returns null and `env.ao.node` with it.
// A gate on the AO factor's distribution is then unmeasurable, and a probe that
// silently reports the scene's authoring choice as a failure is worse than one
// that changes it and says so. Both flips are STRUCTURAL (a GI rebuild), so
// they happen here, before the first-light wait, and cost one build rather than
// two.
{
  // ⚠ AND IT HAS TO WAIT FOR THE COMPONENT. `scene.open` resolves before the GI
  // component attaches, so the first version of this ran against a null and
  // silently did nothing — the receipt then reported `props ao=false` and the
  // AO gate failed on a scene the probe believed it had already fixed.
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (await page.evaluate(() => !!globalThis.__giComponent?.())) break;
    await wait(500);
  }
  const forced = await page.evaluate(() => {
    const c = globalThis.__giComponent?.();
    if (!c) return null;
    const was = { ao: c.props?.ao, reflections: c.props?.reflections };
    if (c.props?.ao === false) c.setProp("ao", true);
    if (c.props?.reflections === false) c.setProp("reflections", true);
    return was;
  });
  if (!forced) console.log("⚠ no GI component found — ao/reflections left as the scene saved them");
  else if (forced.ao === false || forced.reflections === false) {
    console.log(`forced ao/reflections ON for the measurement (scene had ao=${forced.ao}, reflections=${forced.reflections})`);
    firstLightSeen = false;
  }
}

// ── FIRST LIGHT, then the pose ──────────────────────────────────────────────
{
  const t0 = Date.now();
  while (!firstLightSeen && Date.now() - t0 < 180000) await wait(250);
  console.log(`first light ${firstLightSeen ? `seen after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "NOT seen — shooting anyway"}`);
  await wait(SETTLE * 1000);
}

const call = async (op, args = {}) => page.evaluate(
  async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  },
  { op, args },
);

/**
 * ⭐⭐ THE POSE IS MEASURED, NOT TYPED — AND THAT IS THE WHOLE POINT.
 *
 * Two poses were tried by hand and both produced a receipt that looked like a
 * broken shader:
 *
 *   · `run-gi2-flood-probe`'s eye-level street pose (`ground + 1.65` at the
 *     front banner) put the camera INSIDE the occupied set. The voxelization is
 *     CONSERVATIVE — a 0.25 m cell is marked if a triangle merely touches it —
 *     so an eye-level pose in a street is routinely inside a wall, a kerb or the
 *     pavement slab. Every ray then hits in its first cell: `sdf` came back ONE
 *     colour on 100 % of the frame and `occupancy` two.
 *   · A three-quarter overview off `Box3.setFromObject(scene)` put it outside
 *     the window's reach — the box includes whatever the scene's largest object
 *     is — and every view came back 0 % non-black.
 *
 * So the pose is CHOSEN BY MEASUREMENT: a handful of candidates around the
 * scene's own geometry, scored by how many distinct colours the OCCUPANCY view
 * puts up. That number is exactly the property both failures violated (one ray
 * for the whole frame, or no rays at all), it costs one small screenshot per
 * candidate, and it cannot be fooled by a scene edit that moves the street.
 *
 * `POSE=` still forces any pose.
 */
async function sceneBounds() {
  return page.evaluate(async () => {
    // ⭐ THE GI VOLUME'S OWN BOUNDS, not `Box3.setFromObject(scene)`. The scene
    // box is whatever the largest object in it is — a sky dome, a ground plane,
    // an off-screen prop — and an overview framed on THAT put the camera 200 m
    // away with nothing in the window. `state.bounds` is what GI's auto-fit
    // decided the CONTENT is, which is by definition the thing these views are
    // about.
    const sys = globalThis.__giSysForProbe?.();
    const b = sys?.state?.bounds;
    if (b?.min && b?.max) {
      return { min: b.min.toArray(), max: b.max.toArray(), source: "gi auto-fit bounds" };
    }
    const { THREE } = await import("/src/engine/index.js");
    const box = new THREE.Box3();
    const one = new THREE.Box3();
    let n = 0;
    globalThis.__engine.scene.traverse((o) => {
      if (!o.isMesh || o.userData?.__giDebug) return;
      one.setFromObject(o);
      if (!one.isEmpty() && Number.isFinite(one.min.x)) { box.union(one); n++; }
    });
    if (!n || box.isEmpty()) return null;
    return { min: box.min.toArray(), max: box.max.toArray(), source: `${n} meshes` };
  });
}

/** Distinct 5-bit colours in a small capture — the "is this one ray" number. */
async function poseScore() {
  const shot = await page.evaluate(
    async () => globalThis.__editorApi.viewport.screenshot({ width: 160, height: 110, includeGizmos: true }),
  );
  const { data, info } = await sharp(Buffer.from(shot.__image.base64, "base64"))
    .raw().toBuffer({ resolveWithObject: true });
  const seen = new Set();
  let nonBlack = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const j = i * info.channels;
    if (data[j] + data[j + 1] + data[j + 2] > 12) nonBlack++;
    seen.add((data[j] >> 3) * 1024 + (data[j + 1] >> 3) * 32 + (data[j + 2] >> 3));
  }
  return { colours: seen.size, nonBlack: nonBlack / (info.width * info.height) };
}

/** The volume views' second pose — see `aim()`. Null when POSE= pins one. */
let overview = null;
/** The pose the main arms are shot at, so the overview detour can come back. */
let bestPose = null;

async function aim() {
  if (POSE_ENV) {
    const [e, a] = POSE_ENV.split("|").map((s) => s.split(",").map(Number));
    await call("viewport.setCamera", { position: e, target: a });
    return `POSE env ${POSE_ENV}`;
  }
  if (!SCENE) {
    await call("viewport.setCamera", { position: [0, 1.6, 4.5], target: [0, 1.2, -2] });
    return "rig: inside the room";
  }
  const box = await sceneBounds();
  if (!box) return "no mesh bounds — camera left where the scene opened";
  const c = box.min.map((v, i) => (v + box.max[i]) / 2);
  const size = box.min.map((v, i) => box.max[i] - v);
  const ground = box.min[1];
  const span = Math.max(size[0], size[2]);
  const candidates = [];
  // Eye level in the middle of the scene, one per cardinal heading: the pose a
  // person actually judges a street from.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const eye = [c[0], ground + 2.0, c[2]];
    candidates.push({ eye, target: [c[0] + dx * span, ground + 2.0, c[2] + dz * span], label: `eye-level ${dx},${dz}` });
  }
  // And two elevated three-quarter views from just outside the footprint —
  // close enough to stay inside the window's reach, high enough to clear a roof.
  for (const [dx, dz] of [[1, 0.7], [-1, -0.7]]) {
    const eye = [c[0] + dx * span * 0.55, ground + Math.max(6, size[1] * 0.9), c[2] + dz * span * 0.55];
    candidates.push({ eye, target: [c[0], ground + size[1] * 0.3, c[2]], label: `overview ${dx},${dz}` });
  }
  // Scored with the OCCUPANCY view on — the one view whose failure mode is a
  // single flat colour.
  await page.evaluate(() => { globalThis.__setGlobalView("occupancy"); });
  let best = null;
  const scored = [];
  for (const cand of candidates) {
    await call("viewport.setCamera", { position: cand.eye, target: cand.target });
    await wait(1400);
    const s = await poseScore();
    scored.push(`${cand.label} c=${s.colours} nb=${(s.nonBlack * 100).toFixed(0)}%`);
    // ⭐ EYE LEVEL WINS WHENEVER IT IS USABLE, and "usable" is the same number
    // the search exists to protect: more than a handful of distinct colours in
    // the occupancy view means the camera is not standing inside a voxel.
    //
    // The overview candidates are the FALLBACK, not the preference. They score
    // higher on raw variety (a bird's-eye shot of a city is all geometry) but
    // they are the wrong frame for the three term views: measured from 26 m up
    // over this sunlit street, the white-albedo `indirect` view reads mean 0.75
    // / p95 0.99 — a bright picture rather than an unreadable one, but not the
    // pose anybody quotes. Eye level in the street is.
    const usable = s.colours > 8 && s.nonBlack > 0.15;
    const rank = (cand.label.startsWith("eye-level") && usable ? 1000 : 0)
      + s.colours * Math.min(1, s.nonBlack / 0.35);
    if (!best || rank > best.rank) best = { ...cand, rank, ...s };
  }
  await page.evaluate(() => { globalThis.__setGlobalView("off"); });
  await call("viewport.setCamera", { position: best.eye, target: best.target });
  await wait(1500);
  console.log(`  pose search over ${box.source} [${box.min.map((v) => v.toFixed(0))}]..[${box.max.map((v) => v.toFixed(0))}]: ${scored.join(" | ")}`);
  // ⭐⭐ AND THE SECOND POSE IS KEPT, because ONE pose cannot serve both halves
  // of this probe. At eye level 61 % of a street frame is SKY, and the volume
  // views draw a miss as BLACK by construction — so "occupancy non-black on
  // >60 % of texels" is unreachable there no matter how correct the view is.
  // From the overview it is 93 %. The term views are the mirror image: the
  // overview's white-albedo `indirect` reads mean 0.75 / p95 0.99 because the
  // frame really is a sunlit city seen from above. So the term receipts are
  // quoted at eye level and the volume coverage gate is measured from the
  // overview, and each number is taken where it means something.
  overview = candidates.find((c) => c.label.startsWith("overview") && c !== best) ?? null;
  bestPose = best;
  return `${best.label} — eye [${best.eye.map((v) => v.toFixed(1)).join(", ")}] -> ` +
    `[${best.target.map((v) => v.toFixed(1)).join(", ")}], ${best.colours} distinct colours in the occupancy view`;
}

console.log(`pose: ${await aim()}`);
await wait(3000);

const path = await page.evaluate(() => {
  const sys = globalThis.__giSysForProbe?.();
  const field = sys?.component?.constructor?.schema?.find?.((f) => f.key === "debugView");
  const options = typeof field?.options === "function" ? field.options() : field?.options;
  return {
    gi2: !!(sys?._gi2),
    modes: options ?? null,
    // The two sources a "NO SOURCE" line can be about, read directly: a gate
    // that cannot say WHY the AO view is empty is the blind-instrument failure
    // this module documents at four other sites.
    props: { ao: sys?.component?.props?.ao, reflections: sys?.component?.props?.reflections },
    aoPass: !!sys?.state?.screen?.aoPass?.target,
    worldProbes: !!sys?._gi2?.gather?.worldProbes,
  };
});
console.log(
  `live path: ${path.gi2 ? "GI2" : "SRC"}; probes: ${path.worldProbes ? "world lattice" : "screen"}; ` +
  `props ao=${path.props.ao} reflections=${path.props.reflections}; aoPass armed=${path.aoPass}
` +
  `inspector offers: ${path.modes?.join(", ") ?? "?"}`,
);

// ── ONE ARM ─────────────────────────────────────────────────────────────────
async function shoot(mode, { viaGlobal = false } = {}) {
  currentMode = viaGlobal ? `${mode}-global` : mode;
  await page.evaluate(({ m, viaGlobal }) => {
    if (viaGlobal) { globalThis.__setPropView("off"); globalThis.__setGlobalView(m); }
    else { globalThis.__setGlobalView("off"); globalThis.__setPropView(m); }
  }, { m: mode, viaGlobal });
  // The term views arm a ONE-SHOT readback ~120 frames after selection; the
  // volume views print at once. 5 s covers both at 30+ fps.
  await wait(5000);
  const wiring = await page.evaluate(() => {
    const sys = globalThis.__giSysForProbe?.();
    const g = sys?.state?.gizmos;
    return {
      prop: globalThis.__giComponent()?.props?.debugView ?? null,
      global: globalThis.__giDebugView ?? null,
      term: g?.debugView ? g.debugView.visible : null,
      gi2View: g?.gi2View ? g.gi2View.mesh.visible : null,
      srcSdf: g?.sdfView ? g.sdfView.visible : null,
      srcOcc: g?.occView ? g.occView.visible : null,
    };
  });
  const before = errors.length;
  // `includeGizmos: true` IS REQUIRED: `viewport.screenshot` disables
  // EDITOR_LAYER when gizmos are excluded. The control is taken with the SAME
  // setting, or the Δ measures the editor GRID.
  const shot = await page.evaluate(
    async (w, h) => globalThis.__editorApi.viewport.screenshot({ width: w, height: h, includeGizmos: true }),
    WIDTH, HEIGHT,
  );
  const png = Buffer.from(shot.__image.base64, "base64");
  await sharp(png).toFile(`scripts/gi-diag-view-${mode}${viaGlobal ? "-global" : ""}.png`);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  const px = [];
  let sum = 0;
  let nonBlack = 0;
  for (let i = 0; i < total; i++) {
    const idx = i * info.channels;
    const L = 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
    if (L > 3) nonBlack++;
    sum += L;
    px.push(L);
  }
  const sorted = [...px].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] / 255;
  return {
    mode,
    nonBlack: nonBlack / total,
    // ⭐ THE NUMBER THE USER'S COMPLAINT WAS ACTUALLY ABOUT. "Blown to white"
    // is not a high mean — a bright scene has one — it is a large share of
    // pixels PINNED at the top, where the picture has no information left. A
    // brightness band alone cannot tell those apart at every pose; this can.
    clipped: px.reduce((n, L) => n + (L >= 250 ? 1 : 0), 0) / total,
    mean: sum / total / 255,
    p50: q(0.5),
    p95: q(0.95),
    px,
    wiring,
    errors: errors.slice(before),
    lines: receipts.get(currentMode) ?? [],
  };
}

/** Mean absolute per-pixel luminance difference — the control comparison. */
const diff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.px.length; i++) s += Math.abs(a.px[i] - b.px[i]);
  return s / a.px.length;
};

// Controls first — twice, because the second measures the frame-to-frame noise
// every comparison below sits on.
const off = await shoot("off");
const off2 = await shoot("off");
const noise = diff(off2, off);
console.log(`\ncontrol: off nonBlack=${(off.nonBlack * 100).toFixed(1)}% mean=${off.mean.toFixed(3)}; noise floor Δ=${noise.toFixed(2)}`);

const results = [];
for (const spec of MODES) results.push({ spec, r: await shoot(spec.id) });
// One mode through the GLOBAL override, so the second switch path cannot rot.
const globalArm = await shoot("occupancy", { viaGlobal: true });

// The volume views again, from the overview — the pose their COVERAGE number
// means something at. See `aim()`.
const wide = new Map();
if (overview) {
  await call("viewport.setCamera", { position: overview.eye, target: overview.target });
  await wait(2500);
  for (const id of ["occupancy", "sdf", "src-probes"]) wide.set(id, await shoot(id));
  await call("viewport.setCamera", { position: bestPose.eye, target: bestPose.target });
}
await page.evaluate(() => { globalThis.__setGlobalView("off"); globalThis.__setPropView("off"); });

// ── THE TABLE ───────────────────────────────────────────────────────────────
console.log("\nview                 nonBlack   clip    mean    p50    p95   Δ(off)  drew");
const row = (r, label) => {
  const drew = r.wiring.term || r.wiring.gi2View || r.wiring.srcSdf || r.wiring.srcOcc;
  console.log(
    `${label.padEnd(20)} ${(r.nonBlack * 100).toFixed(1).padStart(7)}% ` +
    `${(r.clipped * 100).toFixed(1).padStart(5)}% ` +
    `${r.mean.toFixed(3).padStart(6)} ${r.p50.toFixed(3).padStart(6)} ${r.p95.toFixed(3).padStart(6)} ` +
    `${diff(r, off).toFixed(2).padStart(7)}  ${drew ? "yes" : "no"}`,
  );
};
for (const { r } of results) row(r, r.mode);
row(globalArm, "occupancy(global)");
for (const [id, r] of wide) row(r, `${id} (overview)`);

// ── GATES ───────────────────────────────────────────────────────────────────
let failures = 0;
const gate = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
console.log("");
for (const { spec, r } of results) {
  gate(r.errors.length === 0, `${spec.id}: compiles + draws with no page error`,
    r.errors.length ? JSON.stringify(r.errors.slice(0, 2)) : "");
  if (spec.receipt) {
    const found = r.lines.some((l) => spec.receipt.test(l));
    gate(found, `${spec.id}: printed its console receipt`, found ? "" : "no `[gi] debug view` line arrived");
  }
  if (spec.nonBlack != null) {
    gate(r.nonBlack > spec.nonBlack, `${spec.id}: non-black on >${(spec.nonBlack * 100).toFixed(0)}% of texels`,
      `${(r.nonBlack * 100).toFixed(1)}%`);
  }
  if (spec.nonBlackGi2 != null && path.gi2) {
    // Measured from the OVERVIEW arm when there is one — see `aim()`. At eye
    // level most of a street frame is sky, and a miss is black on purpose.
    const w = wide.get(spec.id) ?? r;
    gate(w.nonBlack > spec.nonBlackGi2,
      `${spec.id}: non-black on >${(spec.nonBlackGi2 * 100).toFixed(0)}% of texels` +
      `${wide.has(spec.id) ? " (overview pose)" : ""}`,
      `${(w.nonBlack * 100).toFixed(1)}%`);
  }
  if (spec.meanRange) {
    gate(r.mean >= spec.meanRange[0] && r.mean <= spec.meanRange[1],
      `${spec.id}: displayed mean luma in [${spec.meanRange.join(", ")}]`, r.mean.toFixed(3));
  }
  if (spec.p95Max != null) {
    gate(r.p95 < spec.p95Max, `${spec.id}: displayed p95 < ${spec.p95Max} (not blown)`, r.p95.toFixed(3));
  }
  if (spec.clipMax != null) {
    gate(r.clipped < spec.clipMax, `${spec.id}: pinned-at-white on <${(spec.clipMax * 100).toFixed(0)}% of texels`,
      `${(r.clipped * 100).toFixed(1)}%`);
  }
  if (spec.aoP50) {
    // The AO receipt carries the FACTOR's own distribution, which the picture
    // cannot: the quad sRGB-decodes it, so a screenshot p50 is not the factor.
    const m = /AO: mean [\d.]+ min [\d.]+ p05 [\d.]+ p50 ([\d.]+)/.exec(r.lines.join(" "));
    gate(m != null && Number(m[1]) >= spec.aoP50[0] && Number(m[1]) <= spec.aoP50[1],
      `ao: factor p50 in [${spec.aoP50.join(", ")}]`, m ? m[1] : "no distribution in the receipt");
  }
  if (spec.report) {
    console.log(`      (${spec.id} is REPORTED, not gated: ${r.lines[0]?.split("\n")[0]?.slice(0, 140) ?? "no line"})`);
  }
}
gate(globalArm.errors.length === 0, "the __giDebugView global still drives a view",
  globalArm.errors.length ? JSON.stringify(globalArm.errors.slice(0, 2)) : "");

// ── THE RESIZE HOPS, WITH EACH VIEW ON ──────────────────────────────────────
//
// ⭐⭐ THE FAILURE THIS GATE EXISTS FOR: `gi2System.setSize` REBUILDS THE GATHER
// and hands its old textures to a retire queue. Every debug view that samples
// one of them is a material holding a destroyed texture three frames later —
// the "Destroyed texture [Texture "gi2Glossy"] used in a submit" class this
// module has already paid for twice. The repair is the per-frame
// `texU.value !== sampled` swap plus `#rebindStaleGiTextures`, and NEITHER is
// exercised by a probe that leaves the view off.
//
// The volume view is the other half of the gate and it is the interesting one:
// it binds `win.buffer`, which SURVIVES a resize, and a repointable
// `texture()` node for the irradiance — chosen precisely so a resize cannot
// strand it. This proves that choice rather than asserting it.
{
  const before = errors.length;
  const gpuErrors = [];
  const listener = (m) => {
    const t = m.text();
    if (/[Dd]estroyed|used in a submit|Invalid.*Texture|Buffer.*destroyed/.test(t)) gpuErrors.push(t.slice(0, 160));
  };
  page.on("console", listener);
  const hops = [1_600_000, 700_000, 1_200_000, 420_000, 1_600_000];
  for (const view of ["indirect", "occupancy", "src-probes"]) {
    await page.evaluate((m) => { globalThis.__setPropView("off"); globalThis.__setGlobalView(m); }, view);
    await wait(1500);
    for (const px of hops) {
      await page.evaluate((v) => { globalThis.__giResolveMaxPixels = v; }, px);
      await wait(2200);
    }
  }
  await page.evaluate(() => {
    globalThis.__setGlobalView("off");
    globalThis.__setPropView("off");
    delete globalThis.__giResolveMaxPixels;
  });
  await wait(2000);
  page.off("console", listener);
  const newErrors = errors.slice(before);
  gate(newErrors.length === 0 && gpuErrors.length === 0,
    `${hops.length} resize hops x 3 views ON leave no destroyed-texture error`,
    [...newErrors.slice(0, 2), ...gpuErrors.slice(0, 2)].join(" | "));
}

gate(errors.length === 0, "0 page errors across every arm", errors.length ? JSON.stringify(errors.slice(0, 3)) : "");

console.log(failures ? `\ngi-debug-views: ${failures} FAILURE(S)` : "\ngi-debug-views: all gates PASS");
await browser.close();
process.exit(failures ? 1 : 0);
