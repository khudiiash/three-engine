// Definitive voxel-reflection visibility test. A metalness=1 sphere has NO
// diffuse — its entire appearance is the specular reflection (GI voxel cone in
// context.radiance). If reflections work it shows the coloured room; if the
// specular path is dead it renders black. A diffuse white sphere beside it
// proves the capture + lighting pipeline itself works (isolates "reflections
// broken" from "capture broken").
import * as THREE from "three/webgpu";
import { Engine, enableEngineModule, registerBuiltInComponents } from "/src/engine/index.js";
import "/src/modules/index.js";

const log = (m) => console.log(`DIAG ${m}`);
const done = () => { document.documentElement.dataset.done = "true"; };
globalThis.addEventListener("error", (e) => { log(`PAGEERROR ${e.error?.stack || e.message}`); done(); });
globalThis.addEventListener("unhandledrejection", (e) => { log(`PAGEERROR ${e.reason?.stack || e.reason}`); done(); });

registerBuiltInComponents();
const engine = new Engine();
await engine.init(document.getElementById("canvas"));
engine.setSize(640, 360);
const camera = new THREE.PerspectiveCamera(55, 640 / 360, 0.1, 80);
camera.position.set(0, 2.5, 8); camera.lookAt(0, 1.5, 0);
engine.camera = camera; engine.scene.add(camera);

// Strongly coloured room: RED left wall, GREEN right wall, white floor/ceiling/back.
const wall = (s, p, c) => { const m = new THREE.Mesh(new THREE.BoxGeometry(...s), new THREE.MeshStandardNodeMaterial({ color: c, roughness: 0.9 })); m.position.set(...p); engine.scene.add(m); return m; };
wall([14, 0.5, 14], [0, -0.25, 0], 0xdddddd); // floor
wall([14, 0.5, 14], [0, 7.25, 0], 0xdddddd);  // ceiling
wall([14, 8, 0.5], [0, 3.5, -6.5], 0xdddddd);  // back
wall([0.5, 8, 14], [-6.5, 3.5, 0], 0xff1010);  // RED left
wall([0.5, 8, 14], [6.5, 3.5, 0], 0x10ff10);   // GREEN right

// Mirror-metal sphere (LEFT-of-centre on screen) + diffuse white sphere (RIGHT).
const metalSphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.3, 48, 48),
  new THREE.MeshStandardNodeMaterial({ color: 0xffffff, metalness: 1.0, roughness: 0.05 }),
);
metalSphere.position.set(-2, 1.5, 0); engine.scene.add(metalSphere);
const diffuseSphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.3, 48, 48),
  new THREE.MeshStandardNodeMaterial({ color: 0xffffff, metalness: 0, roughness: 1 }),
);
diffuseSphere.position.set(2, 1.5, 0); engine.scene.add(diffuseSphere);

const dir = new THREE.DirectionalLight(0xffffff, 1.5); dir.position.set(2, 6, 5);
engine.scene.add(dir); engine.scene.add(new THREE.AmbientLight(0xffffff, 0.3));

const handle = await enableEngineModule(engine, "gi");
const comp = engine.createEntity({ name: "GI" }).addComponent("global-illumination", { quality: "balanced" });
engine.start();
const system = handle.system;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, t, l) => { const s = performance.now(); while (performance.now() - s < t) { if (fn()) return true; await wait(100); } log(`TIMEOUT ${l}`); return false; };

await waitFor(() => system.volumes[0]?.hasRadiance === true, 60000, "hasRadiance");
log(`specularFactory=${typeof system.light?.giFactories?.specular === "function"}`);
await wait(3000);

// Capture the real engine frame into an RT.
async function frame() {
  const rt = new THREE.RenderTarget(640, 360, { type: THREE.HalfFloatType });
  engine.renderer.setRenderTarget(rt);
  engine.renderer.render(engine.scene, camera);
  engine.renderer.setRenderTarget(null);
  const buf = await engine.renderer.readRenderTargetPixelsAsync(rt, 0, 0, 640, 360, 0);
  rt.dispose();
  return buf;
}
// Half-float bit → float decode.
function h2f(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}
function regionMean(buf, x0, x1, y0, y1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * 640 + x) * 4;
    r += h2f(buf[i]); g += h2f(buf[i + 1]); b += h2f(buf[i + 2]); n++;
  }
  return { r: r / n, g: g / n, b: b / n };
}

const buf = await frame();
// Screen: metal sphere ~x 180-300, diffuse sphere ~x 360-480, both y ~130-260.
const metal = regionMean(buf, 190, 300, 130, 250);
const diffuse = regionMean(buf, 360, 470, 130, 250);
// Metal sphere left edge (faces RED wall) vs right edge (faces GREEN wall).
const metalLeft = regionMean(buf, 175, 205, 150, 230);
const metalRight = regionMean(buf, 285, 315, 150, 230);
const f3 = (o) => `(${o.r.toFixed(3)},${o.g.toFixed(3)},${o.b.toFixed(3)})`;
log(`METAL sphere mean=${f3(metal)} brightness=${(metal.r + metal.g + metal.b).toFixed(3)}`);
log(`DIFFUSE sphere mean=${f3(diffuse)} brightness=${(diffuse.r + diffuse.g + diffuse.b).toFixed(3)}`);
log(`METAL left(→red wall)=${f3(metalLeft)}  right(→green wall)=${f3(metalRight)}`);
const metalLit = metal.r + metal.g + metal.b > 0.05;
const diffuseLit = diffuse.r + diffuse.g + diffuse.b > 0.05;
const directional = metalLeft.r > metalLeft.g + 0.02 && metalRight.g > metalRight.r + 0.02;
log(`VERDICT captureWorks=${diffuseLit} reflectionsVisible=${metalLit} roomReflected(red-left/green-right)=${directional}`);
engine.stop(); done();
