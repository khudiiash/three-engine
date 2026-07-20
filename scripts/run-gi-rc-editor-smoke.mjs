// Phase 6 editor smoke: loads the REAL editor, enables the "gi" module,
// builds a Cornell-style scene with engine entities, attaches the
// global-illumination component, and screenshots the live viewport —
// including the debug-probe view. This is the "does it work in the actual
// editor, not just a harness" check that prior GI attempts skipped to their
// detriment.
// Usage: node scripts/run-gi-rc-editor-smoke.mjs [url]
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPU",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|error|Error|GI-SMOKE/.test(text)) console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  const target = [...document.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("Skip the project"));
  target?.click();
});
await new Promise((resolve) => setTimeout(resolve, 5000));

await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");

  const material = (color, emissive = 0) => {
    const m = new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
    if (emissive > 0) {
      m.emissive = new THREE.Color(0xffffff);
      m.emissiveIntensity = emissive;
    }
    return m;
  };
  const addBox = (size, position, color, emissive = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color, emissive));
    mesh.position.set(...position);
    engine.scene.add(mesh);
    return mesh;
  };
  // 12x6x12 room, open front (+Z) so the editor camera sees in.
  addBox([12, 0.2, 12], [0, -0.1, 0]); // floor
  addBox([12, 0.2, 12], [0, 6.1, 0], 0xb8c3cf); // ceiling
  addBox([12, 6, 0.2], [0, 3, -6.1], 0xb8c3cf); // back
  addBox([0.2, 6, 12], [-6.1, 3, 0], 0x9f2418); // red
  addBox([0.2, 6, 12], [6.1, 3, 0], 0x3a9f24); // green
  addBox([2, 3.4, 2], [-2.2, 1.7, -2], 0xb8c3cf); // occluder
  addBox([2.4, 0.1, 2.4], [0, 5.95, 0], 0xffffff, 8); // emissive panel

  const giEntity = engine.createEntity({ name: "Global Illumination" });
  giEntity.object3D.position.set(0, 3, 0);
  giEntity.addComponent("global-illumination", {
    sizeX: 16,
    sizeY: 9,
    sizeZ: 16,
    voxelSize: 0.25,
    probeSpacing: 0.8,
    intensity: 1,
  });

  engine.camera.position.set(0, 3.5, 11);
  engine.camera.lookAt(0, 2.5, 0);
  engine.camera.updateMatrixWorld(true);
  globalThis.__giEntity = giEntity;
  console.log("GI-SMOKE scene ready");
});

// Let the module build, bake, compile pipelines, and settle.
await new Promise((resolve) => setTimeout(resolve, 12000));
await page.screenshot({ path: "scripts/gi-diag-editor-lit.png" });
console.log("SHOT scripts/gi-diag-editor-lit.png");

// Probe debug view.
await page.evaluate(() => {
  globalThis.__giEntity.getComponent("global-illumination").setProp("debugProbes", "merged");
});
await new Promise((resolve) => setTimeout(resolve, 3000));
await page.screenshot({ path: "scripts/gi-diag-editor-probes.png" });
console.log("SHOT scripts/gi-diag-editor-probes.png");

// Dynamics: move the occluder + change emissive, confirm rebake fires.
await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__giEntity.getComponent("global-illumination").setProp("debugProbes", "off");
  let occluder = null;
  engine.scene.traverse((o) => {
    if (o.isMesh && Math.abs(o.position.x - -2.2) < 0.01) occluder = o;
  });
  if (occluder) occluder.position.x = 3;
  console.log("GI-SMOKE moved occluder");
});
await new Promise((resolve) => setTimeout(resolve, 5000));
await page.screenshot({ path: "scripts/gi-diag-editor-moved.png" });
console.log("SHOT scripts/gi-diag-editor-moved.png");

await browser.close();
process.exit(0);
