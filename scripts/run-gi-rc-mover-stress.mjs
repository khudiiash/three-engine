// Moving-object stress: same editor Cornell as the smoke, but the occluder
// is dragged back and forth continuously for several seconds while every
// "[gi] worker rebake" line is captured — verifies the worker switches to
// INCREMENTAL region bakes after its first (full) job and stays fast.
// Usage: node scripts/run-gi-rc-mover-stress.mjs [url]
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
const rebakes = [];
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-STRESS|pageerror/.test(text)) {
    console.log(`${message.type()}: ${text}`);
    const match = text.match(/worker rebake (\d+)ms \[(\w+)\]/);
    if (match) rebakes.push({ ms: Number(match[1]), mode: match[2] });
  }
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
  globalThis.__mover = addBox([2, 3.4, 2], [-2.2, 1.7, -2], 0xb8c3cf);
  addBox([2.4, 0.1, 2.4], [0, 5.95, 0], 0xffffff, 8);

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
  console.log("GI-STRESS scene ready");
});

await new Promise((resolve) => setTimeout(resolve, 10000));

// Drag: oscillate the occluder for ~8 seconds at 60Hz position updates.
await page.evaluate(async () => {
  const start = performance.now();
  await new Promise((done) => {
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      if (t > 8) {
        done();
        return;
      }
      globalThis.__mover.position.x = -2.2 + Math.sin(t * 1.2) * 4;
      requestAnimationFrame(tick);
    };
    tick();
  });
  console.log("GI-STRESS drag done");
});
await new Promise((resolve) => setTimeout(resolve, 3000));
await page.screenshot({ path: "scripts/gi-diag-mover-stress.png" });
console.log("SHOT scripts/gi-diag-mover-stress.png");

const incremental = rebakes.filter((r) => r.mode === "incremental");
const full = rebakes.filter((r) => r.mode === "full");
const avg = (list) => (list.length ? (list.reduce((s, r) => s + r.ms, 0) / list.length).toFixed(1) : "n/a");
console.log(
  `GI-STRESS summary: ${rebakes.length} rebakes — ${incremental.length} incremental (avg ${avg(incremental)}ms), ` +
    `${full.length} full (avg ${avg(full)}ms)`,
);
await browser.close();
process.exit(0);
