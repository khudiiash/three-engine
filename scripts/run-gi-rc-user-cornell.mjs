// Mirrors the user's Cornell setup that showed NO bleed: thin PLANE walls
// (deliberately facing OUT of the room — the hostile orientation), an
// engine point-light component near the ceiling, standard materials lit via
// the GI light node, user's exact GI settings. Bleed must survive all of it.
// Usage: node scripts/run-gi-rc-user-cornell.mjs [url]
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-UC|pageerror/i.test(text)) console.log(`${message.type()}: ${text}`);
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

  const material = (color) =>
    new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });

  // Ground: big plane like the user's.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), material(0xffffff));
  ground.rotation.x = -Math.PI / 2;
  engine.scene.add(ground);

  // Thin plane walls — normals deliberately facing OUT of the room.
  const addWall = (color, position, rotationY) => {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), material(color));
    wall.position.set(...position);
    wall.rotation.y = rotationY;
    engine.scene.add(wall);
    return wall;
  };
  addWall(0xd42410, [-4, 3, 0], -Math.PI / 2); // red left, normal → -X (outward)
  addWall(0x27b515, [4, 3, 0], Math.PI / 2); // green right, normal → +X (outward)
  addWall(0xffffff, [0, 3, -4], Math.PI); // back, normal → -Z (outward)
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), material(0xffffff));
  ceiling.position.set(0, 6, 0);
  ceiling.rotation.x = Math.PI / 2; // normal → -Y (into room, this one correct)
  engine.scene.add(ceiling);

  // Boxes like the user's.
  const tall = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3.4, 1.6), material(0xffffff));
  tall.position.set(-1.2, 1.7, -1.2);
  engine.scene.add(tall);
  const small = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), material(0xffffff));
  small.position.set(1.4, 0.7, 0.6);
  engine.scene.add(small);

  // Glossy metal sphere — exercises the cascade-radiance indirect specular.
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 48, 32),
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.15, metalness: 0.95 }),
  );
  sphere.position.set(-0.2, 0.9, 1.6);
  engine.scene.add(sphere);

  // Emissive ceiling panel — sole light source, so the boxes/sphere MUST
  // cast visible soft area shadows on the floor (the new DDA shadow pass).
  const panelMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 });
  panelMaterial.emissive = new THREE.Color(0xffffff);
  panelMaterial.emissiveIntensity = 14;
  const panel = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.08, 32), panelMaterial);
  panel.position.set(0, 5.9, 0);
  engine.scene.add(panel);

  const giEntity = engine.createEntity({ name: "GI" });
  giEntity.object3D.position.set(0, 3, 0);
  giEntity.addComponent("global-illumination", {
    sizeX: 20,
    sizeY: 20,
    sizeZ: 20,
    voxelSize: 0.1,
    probeSpacing: 0.5,
    cascadeCount: 5,
    c0DirRes: 4,
    intensity: 1,
    bounce: 1,
  });

  engine.camera.position.set(0, 3.4, 9.5);
  engine.camera.lookAt(0, 2.4, 0);
  engine.camera.updateMatrixWorld(true);
  console.log("GI-UC scene ready (outward-facing plane walls, point light component)");
});

await new Promise((resolve) => setTimeout(resolve, 14000));
// Re-assert the camera right before capture — the editor's viewport
// controls can overwrite engine.camera during the settle wait.
await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  engine.camera.position.set(0, 3.4, 9.5);
  engine.camera.lookAt(0, 2.4, 0);
  engine.camera.updateMatrixWorld(true);
});
await new Promise((resolve) => setTimeout(resolve, 600));
await page.screenshot({ path: "scripts/gi-diag-user-cornell.png" });
console.log("SHOT scripts/gi-diag-user-cornell.png");
await browser.close();
process.exit(0);
