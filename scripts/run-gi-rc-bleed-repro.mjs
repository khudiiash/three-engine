// Repro: user's outdoor scene — directional sun, big white floor, red box +
// white box — reported "works, but no color bleed". Diagnoses where the
// bounce energy goes: shots from the sunlit side vs shadow side, at GI
// intensity 1 and 3, plus the merged-probe field near the red box.
// Usage: node scripts/run-gi-rc-bleed-repro.mjs [url]
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-BLEED|pageerror|error/i.test(text)) console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

await page.goto(url, { waitUntil: "load", timeout: 30000 });
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
  await enableEngineModule(engine, "gi");

  const material = (color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(50, 0.2, 50), material(0xffffff));
  floor.position.set(0, -0.1, 0);
  floor.receiveShadow = true;
  engine.scene.add(floor);
  // Reproduce the engine material-asset shape: real color lives in
  // colorNode, `.color` sits at stale white. The voxel bake must resolve
  // the colorNode or this box bleeds WHITE (the reported bug).
  const redMaterial = material(0xffffff);
  redMaterial.colorNode = THREE.TSL.color(0xdd2211);
  const red = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), redMaterial);
  red.position.set(-1.5, 1, 0);
  red.castShadow = true;
  engine.scene.add(red);
  const white = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material(0xffffff));
  white.position.set(1.5, 1, 0);
  white.castShadow = true;
  engine.scene.add(white);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(12, 18, 8);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  engine.scene.add(sun);
  engine.scene.add(sun.target);
  engine.scene.background = new THREE.Color(0xbfe3ff);

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.object3D.position.set(0, 2, 0);
  giEntity.addComponent("global-illumination", {
    sizeX: 30,
    sizeY: 10,
    sizeZ: 30,
    voxelSize: 0.25,
    probeSpacing: 1,
    intensity: 1,
  });
  globalThis.__gi = giEntity.getComponent("global-illumination");
  globalThis.__engine = engine;
  console.log("GI-BLEED scene ready; sun from (12,18,8) → sunlit faces are +X/+Y/+Z");
});
await new Promise((resolve) => setTimeout(resolve, 10000));

const setCam = async (pos, look) => {
  await page.evaluate(
    ({ pos, look }) => {
      const engine = globalThis.__engine;
      engine.camera.position.set(...pos);
      engine.camera.lookAt(...look);
      engine.camera.updateMatrixWorld(true);
    },
    { pos, look },
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
};

// Shot 1: from the SUNLIT side (sun at +X+Z, so stand at +X+Z looking back).
await setCam([8, 3, 8], [-1.5, 0.5, 0]);
await page.screenshot({ path: "scripts/gi-diag-bleed-sunlit-i1.png" });
console.log("SHOT scripts/gi-diag-bleed-sunlit-i1.png");

// Shot 2: same view, GI intensity 3.
await page.evaluate(() => globalThis.__gi.setProp("intensity", 3));
await new Promise((resolve) => setTimeout(resolve, 1200));
await page.screenshot({ path: "scripts/gi-diag-bleed-sunlit-i3.png" });
console.log("SHOT scripts/gi-diag-bleed-sunlit-i3.png");

// Shot 3: shadow side (user's angle), intensity 3.
await setCam([-3, 3, -9], [0, 0.5, 0]);
await page.screenshot({ path: "scripts/gi-diag-bleed-shadowside-i3.png" });
console.log("SHOT scripts/gi-diag-bleed-shadowside-i3.png");

// Shot 4: merged probe field near the boxes, close in on the sunlit side.
await page.evaluate(() => globalThis.__gi.setProp("debugProbes", "merged"));
await new Promise((resolve) => setTimeout(resolve, 1500));
await setCam([5, 3, 5], [-1.5, 1, 0]);
await page.screenshot({ path: "scripts/gi-diag-bleed-probes.png" });
console.log("SHOT scripts/gi-diag-bleed-probes.png");

await browser.close();
process.exit(0);
