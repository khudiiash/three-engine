// Auto-fit smoke: Cornell scene with autoFit:true (no meaningful size props),
// verifies (1) the volume wraps the scene and lighting matches the manual
// setup, (2) adding distant content triggers an automatic refit that covers
// it. Usage: node scripts/run-gi-rc-autofit.mjs [url]
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-FIT|pageerror/.test(text)) console.log(`${message.type()}: ${text}`);
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
  addBox([12, 0.2, 12], [0, -0.1, 0]);
  addBox([12, 0.2, 12], [0, 6.1, 0], 0xb8c3cf);
  addBox([12, 6, 0.2], [0, 3, -6.1], 0xb8c3cf);
  addBox([0.2, 6, 12], [-6.1, 3, 0], 0x9f2418);
  addBox([0.2, 6, 12], [6.1, 3, 0], 0x3a9f24);
  addBox([2, 3.4, 2], [-2.2, 1.7, -2], 0xb8c3cf);
  addBox([2.4, 0.1, 2.4], [0, 5.95, 0], 0xffffff, 8);

  const giEntity = engine.createEntity({ name: "Global Illumination" });
  // Entity far from the scene + tiny sizes: auto-fit must ignore both.
  giEntity.object3D.position.set(50, 50, 50);
  giEntity.addComponent("global-illumination", {
    autoFit: true,
    sizeX: 4,
    sizeY: 2,
    sizeZ: 4,
    voxelSize: 0.25,
    probeSpacing: 0.8,
    intensity: 1,
  });

  engine.camera.position.set(0, 3.5, 11);
  engine.camera.lookAt(0, 2.5, 0);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-FIT scene ready");
});

await new Promise((resolve) => setTimeout(resolve, 12000));
await page.screenshot({ path: "scripts/gi-diag-autofit.png" });
console.log("SHOT scripts/gi-diag-autofit.png");

// Add a second lit room far outside the current volume → refit must fire.
await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const m = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
  m.emissive = new THREE.Color(0xff8822);
  m.emissiveIntensity = 10;
  const panel = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 2), m);
  panel.position.set(24, 3, 0);
  engine.scene.add(panel);
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(10, 0.2, 10),
    new THREE.MeshStandardNodeMaterial({ color: 0x8899ff, roughness: 0.9 }),
  );
  floor.position.set(24, -0.1, 0);
  engine.scene.add(floor);
  console.log("GI-FIT distant content added");
});
await new Promise((resolve) => setTimeout(resolve, 9000));
await page.screenshot({ path: "scripts/gi-diag-autofit-refit.png" });
console.log("SHOT scripts/gi-diag-autofit-refit.png");
await browser.close();
process.exit(0);
