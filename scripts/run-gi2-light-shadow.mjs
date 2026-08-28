// ⭐⭐ §19 STAGE 4.0 — DOES `Shadow Source = "gi"` ACTUALLY DARKEN A FLOOR?
//
//   node scripts/run-gi2-light-shadow.mjs http://127.0.0.1:5202/
//   ELEVATION=75 QUALITY=high  (dials)
//
// The sibling of `run-gi-sun-leak.mjs`, built on the same rig and the same
// linear-luminance sampling, asking the opposite question. Sunleak asks "does
// light arrive where geometry says it must not"; this asks "does a light on
// Shadow Source `gi` actually STOP at geometry" — which under `GI2_PATH` was a
// live regression rather than a missing feature: `#buildLightShadow` bails on
// `!occ?.voxel`, GI2 has no occupancy field, so the option shipped in the
// inspector, hid thirteen shadow-map rows, and silently handed the light back
// to three's tiny fallback map.
//
// ⭐ THE ASSERTION IS AN ISOLATION, NOT A LOOK. When the GI system claims a
// light it assigns `light.shadow.shadowNode`, which REPLACES three's own
// shadow-map sampling in every material. So on this rig a dark floor under the
// box can only have come from the GI trace: if the trace wrote its
// load-bearing default of 1 everywhere (a broken pass, a bundle that never
// built, a slot that never claimed), the floor under the box would be FULLY
// LIT — brighter than the map-mode control, not darker.
//
// Both sample points are projected from WORLD coordinates through the live
// camera, so the crops follow the geometry rather than a hand-tuned pixel that
// a resize or an fov change silently moves off the subject.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/").replace(/\/$/, "");
const ELEVATION = Number(process.env.ELEVATION ?? 75);
const QUALITY = process.env.QUALITY ?? "high";
// The gate: the shadowed floor must read below this fraction of the lit floor.
const RATIO = Number(process.env.RATIO ?? 0.2);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  protocolTimeout: 600000,
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
// ⭐ §19 3.16 — `FLAGS='{"__gi2WorldProbes":true}'` RUNS THIS GATE ON THE WORLD
// PROBE PATH, OUT OF THE SHIPPING BINARY. §V.8 and §W.10 recorded the same
// caveat twice in a row: these engine gates run the SHIPPING path because the
// flip has not happened, so a green tree says the tree is green and says
// NOTHING about the path being flipped to. The gi2 probes have had this hook
// since 3.13; the engine gates did not, which is why "the first time the world
// path runs it" was still true at 3.16.
await page.evaluateOnNewDocument(
  (f) => { Object.assign(globalThis, f); },
  JSON.parse(process.env.FLAGS ?? "{}"),
);
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\]|\[gi2\]|GI-LS/.test(t)) console.log(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

// ── the rig ────────────────────────────────────────────────────────────────
//
// A grey floor and one box FLOATING at y = 3. Floating on purpose: a box
// resting on the floor hides its own contact shadow from every camera that can
// also see lit floor, and the two crops have to be visible in the SAME frame
// or the comparison is between two different exposures.
// Sun direction is (0, -sin el, -cos el), so the caster's shadow lands
// `centreY / sin(el)` metres along it — a little way toward -z of the box's
// own footprint. Both points are floor points, 2 cm up so they are never
// z-fighting with the slab's top face.
const SHADOW_POINT = [0, 0.02, -0.8];
const LIT_POINT = [5.5, 0.02, 4.0];

await page.evaluate(async ({ ELEVATION, QUALITY }) => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;

  const mat = (r, g, b) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    m.color.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
    return m;
  };
  const box = (size, position, material, name) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    engine.scene.add(mesh);
    return mesh;
  };

  box([24, 0.4, 24], [0, -0.2, 0], mat(0.6, 0.6, 0.6), "floor");
  box([2.4, 2.4, 2.4], [0, 3, 0], mat(0.55, 0.55, 0.55), "caster");

  const lightEntity = engine.createEntity({ name: "Sun" });
  lightEntity.addComponent("light", {
    kind: "directional", intensity: 3, color: "#ffffff",
    // The whole point of the rig. `castShadow` is the master switch the
    // inspector gates `shadowMode` behind, so both are required.
    castShadow: true, shadowMode: "gi", sourceAngle: 0.53,
  });
  // ⚠ A DIRECTIONAL LIGHT'S AIM IS ITS ROTATION, NEVER ITS POSITION.
  // `LightComponent.#syncDirectionalTransform` PINS the owner to the world
  // origin every frame ("their position is meaningless") and derives the
  // emitted direction from the owner's -Z. Setting `object3D.position` — which
  // is what the neighbouring sun-leak rig does, and gets away with because it
  // only needs the sun to be OUTSIDE a sealed box — leaves the light aimed
  // along -Z, i.e. horizontally: the floor's N·L is then 0, the whole frame is
  // black, and both crops read the same near-zero number. Rotating -el about
  // X aims it at (0, -sin el, -cos el).
  const el = (ELEVATION * Math.PI) / 180;
  lightEntity.object3D.rotation.set(-el, 0, 0);
  lightEntity.object3D.updateMatrixWorld(true);

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.addComponent("global-illumination", { autoFit: true, quality: QUALITY, intensity: 1, enabled: true });
  globalThis.__giEntity = giEntity;

  // Off to the side and low, so the floating box does not occlude its own
  // shadow and a large patch of unshadowed floor is in the same frame.
  engine.camera.position.set(9, 4.5, 11);
  engine.camera.lookAt(0, 0.6, 0);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-LS scene ready");
}, { ELEVATION, QUALITY });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await page.waitForFunction(
  () => [...document.querySelectorAll("canvas")].some((c) => c.width > 400 && c.height > 300),
  { timeout: 60000 },
);
await settle(14000);
await page.evaluate(() => {
  globalThis.__engine.scene.traverse((o) => {
    if (o.isGridHelper || o.isLineSegments || o.type === "AxesHelper") o.visible = false;
  });
});
await settle(2500);

// ── what the SYSTEM says it built, before any pixel is read ────────────────
const rig = await page.evaluate(({ SHADOW_POINT, LIT_POINT }) => {
  const engine = globalThis.__engine;
  const sys = engine.modules?.get("gi")?.system;
  const ls = sys?.state?.screen?.lightShadow ?? null;
  const canvas = [...document.querySelectorAll("canvas")].find((c) => c.width > 400 && c.height > 300);
  const rect = canvas.getBoundingClientRect();
  const cam = engine.camera;
  cam.updateMatrixWorld(true);
  // Plain-number world → viewport projection: clip = P · V · p. Written out
  // rather than borrowed from a second copy of THREE, because the only thing
  // that matters is that it uses THIS camera's live matrices.
  const project = ([x, y, z]) => {
    const e = cam.matrixWorldInverse.elements;
    const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const q = cam.projectionMatrix.elements;
    const cx = q[0] * vx + q[4] * vy + q[8] * vz + q[12];
    const cy = q[1] * vx + q[5] * vy + q[9] * vz + q[13];
    const cw = q[3] * vx + q[7] * vy + q[11] * vz + q[15];
    return [
      Math.round(rect.left + ((cx / cw) * 0.5 + 0.5) * rect.width),
      Math.round(rect.top + (0.5 - (cy / cw) * 0.5) * rect.height),
    ];
  };
  const light = [...engine.entities.values()].find((e) => e.name === "Sun")?.getComponent("light")?.light;
  return {
    bundle: !!ls,
    kind: ls?.gi2 ? "gi2-window" : ls ? "src-occupancy" : "none",
    span: ls?.span ?? null,
    pass: !!sys?.state?.screen?.lightShadowPass,
    filter: !!sys?.state?.screen?.lightShadowFilterPass,
    claimed: sys?._lightShadowNodes?.size ?? 0,
    shadowNode: !!light?.shadow?.shadowNode,
    mode: light?.userData?.giShadowMode ?? null,
    giShadowSlots: (sys?.state?.lightSlots ?? []).filter((s) => (s.giShadow?.value ?? 0) > 0.5).length,
    // Is the chain actually being dispatched? `_gi2Passes.all` is the exact
    // ordered list the last tick submitted.
    chain: (sys?._gi2Passes?.all ?? []).map((n) => n?.__giPassName).filter((n) => /lightShadow/i.test(n ?? "")),
    shadowPx: project(SHADOW_POINT),
    litPx: project(LIT_POINT),
    canvasRect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
    sunDir: (() => {
      const l = [...engine.entities.values()].find((e) => e.name === "Sun")?.getComponent("light")?.light;
      if (!l?.target) return null;
      const a = l.getWorldPosition(new l.position.constructor());
      const b = l.target.getWorldPosition(new l.position.constructor());
      const d = b.sub(a);
      const n = Math.hypot(d.x, d.y, d.z) || 1;
      return [+(d.x / n).toFixed(3), +(d.y / n).toFixed(3), +(d.z / n).toFixed(3)];
    })(),
  };
}, { SHADOW_POINT, LIT_POINT });

const shot = await page.screenshot({ type: "png" });
await sharp(shot).toFile("scripts/gi-diag-gi2-light-shadow.png");
const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
const toLin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const patch = (cx, cy, n = 6) => {
  const vals = [];
  for (let dy = -n; dy <= n; dy++) {
    for (let dx = -n; dx <= n; dx++) {
      const x = Math.min(info.width - 1, Math.max(0, cx + dx));
      const y = Math.min(info.height - 1, Math.max(0, cy + dy));
      const i = (y * info.width + x) * info.channels;
      vals.push(0.2126 * toLin(data[i]) + 0.7152 * toLin(data[i + 1]) + 0.0722 * toLin(data[i + 2]));
    }
  }
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
};

const shadowLum = patch(rig.shadowPx[0], rig.shadowPx[1]);
const litLum = patch(rig.litPx[0], rig.litPx[1]);
const ratio = litLum > 1e-6 ? shadowLum / litLum : Number.POSITIVE_INFINITY;

console.log(`\n=== Shadow Source "gi", elevation ${ELEVATION}deg, quality ${QUALITY} ===`);
console.log(
  `rig: bundle=${rig.bundle} (${rig.kind}, span ${rig.span == null ? "n/a" : rig.span.toFixed(1)} m) ` +
    `pass=${rig.pass} filter=${rig.filter} claimedLights=${rig.claimed} shadowNode=${rig.shadowNode} ` +
    `giShadowMode=${rig.mode} giShadowSlots=${rig.giShadowSlots}`,
);
console.log(`chain: ${rig.chain.length ? rig.chain.join(" -> ") : "(no lightShadow kernel in _gi2Passes.all)"}`);
console.log(`canvas: ${rig.canvasRect.join(",")}  image ${info.width}x${info.height}  sun dir ${rig.sunDir}`);
console.log(`crops: shadowed floor @${rig.shadowPx} = ${shadowLum.toFixed(5)}   lit floor @${rig.litPx} = ${litLum.toFixed(5)}`);
// A COARSE MAP of the canvas, so a failure is debuggable without opening the
// PNG: if every cell reads the same, the crops are not the problem.
{
  const [rx, ry, rw, rh] = rig.canvasRect;
  const rows = [];
  for (let j = 0; j < 6; j++) {
    const cells = [];
    for (let i = 0; i < 8; i++) {
      cells.push(patch(Math.round(rx + rw * ((i + 0.5) / 8)), Math.round(ry + rh * ((j + 0.5) / 6)), 3).toFixed(3));
    }
    rows.push(`  ${cells.join(" ")}`);
  }
  console.log("canvas luminance map (8x6):");
  for (const row of rows) console.log(row);
}
console.log(`ratio: ${ratio.toFixed(4)} (gate <= ${RATIO})`);

const checks = [
  ["a light-shadow bundle was built", rig.bundle === true],
  ["the trace + bilateral exist", rig.pass === true && rig.filter === true],
  ["the light claimed a gi shadowNode", rig.claimed === 1 && rig.shadowNode === true],
  ["the slot asks for a gi shadow", rig.giShadowSlots === 1],
  ["the chain is dispatched", rig.chain.length >= 1],
  // Without a lit reference the ratio is meaningless — a black frame would
  // pass a ratio gate trivially (memory: can the instrument see its subject?).
  ["the lit floor is actually lit", litLum > 0.02],
  ["the shadowed floor is dark", ratio <= RATIO],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? "GI-LS ALL PASS" : `GI-LS ${failed} FAILED`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
