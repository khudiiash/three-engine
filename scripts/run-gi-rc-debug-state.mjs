// Diagnostic: reproduce the bleed scene, dump ALL console output + scene
// light/shadow state to find why lighting went flat.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 700, deviceScaleFactor: 1 });
page.on("console", (message) => console.log(`${message.type()}: ${message.text()}`));
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
if (process.env.NO_GI) await page.evaluate(() => (globalThis.__noGI = true));
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((resolve) => setTimeout(resolve, 5000));

await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  if (!new URLSearchParams(location.search).has("noGI") && !globalThis.__noGI) {
    await enableEngineModule(engine, "gi");
  }

  const material = (color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(50, 0.2, 50), material(0xffffff));
  floor.position.set(0, -0.1, 0);
  floor.receiveShadow = true;
  engine.scene.add(floor);
  const redMaterial = material(0xffffff);
  redMaterial.colorNode = THREE.TSL.color(0xdd2211);
  const red = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), redMaterial);
  red.position.set(-1.5, 1, 0);
  red.castShadow = true;
  engine.scene.add(red);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(12, 18, 8);
  sun.castShadow = true;
  engine.scene.add(sun);
  engine.scene.add(sun.target);

  if (!globalThis.__noGI) {
    const giEntity = engine.createEntity({ name: "GI" });
    giEntity.object3D.position.set(0, 2, 0);
    giEntity.addComponent("global-illumination", { sizeX: 30, sizeY: 10, sizeZ: 30, voxelSize: 0.25, probeSpacing: 1 });
  }
  globalThis.__engine = engine;
});
await new Promise((resolve) => setTimeout(resolve, 9000));

const state = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const lights = [];
  engine.scene.traverse((o) => {
    if (o.isLight) lights.push(`${o.type} intensity=${o.intensity} visible=${o.visible} castShadow=${o.castShadow}`);
  });
  const gi = engine.modules.get("gi");
  const giState = gi?.system?.state;
  return {
    lights,
    shadowMapEnabled: engine.renderer?.shadowMap?.enabled,
    giBuilt: !!giState,
    giLightInScene: giState ? giState.light.parent === engine.scene : false,
    giGatherSet: giState ? !!giState.light.gatherFn : false,
    giIntensity: giState ? giState.light.intensityUniform.value : null,
    camera: engine.camera.position.toArray().map((v) => v.toFixed(1)),
    rendererType: engine.renderer?.constructor?.name,
  };
});
console.log("STATE:", JSON.stringify(state, null, 2));

// Capture any WebGPU validation errors + a render from this verified session.
await page.evaluate(() => {
  const engine = globalThis.__engine;
  engine.renderer.backend?.device?.addEventListener?.("uncapturederror", (event) => {
    console.error(`WEBGPU-ERROR: ${event.error?.message || event.error}`);
  });
  engine.camera.position.set(7, 4, 8);
  engine.camera.lookAt(-1.5, 0.5, 0);
  engine.camera.updateMatrixWorld(true);
});
await new Promise((resolve) => setTimeout(resolve, 3000));
await page.screenshot({ path: "scripts/gi-diag-debug-render.png" });
console.log("SHOT scripts/gi-diag-debug-render.png");
await browser.close();
process.exit(0);
