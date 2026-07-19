// GI diagnostic: drive the camera toward a wall and watch the recenter fade.
// The inner cascade fades to its coarse parent on each recenter (cascadeBlend
// dips toward 0) — that dip IS the "old lighting" flash. Logs DIAG lines.
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

const camera = new THREE.PerspectiveCamera(60, 640 / 360, 0.1, 80);
camera.position.set(0, 2, 18);
camera.lookAt(0, 2, -20);
engine.camera = camera;
engine.scene.add(camera);

const standard = (c) => new THREE.MeshStandardNodeMaterial({ color: c, roughness: 0.9, metalness: 0 });
const addBox = (s, p, c = 0xd0d0d0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(...s), standard(c));
  m.position.set(...p); engine.scene.add(m); return m;
};
// A long corridor the camera flies down toward a far wall.
addBox([12, 0.5, 60], [0, -0.25, -10]); // floor
addBox([12, 8, 0.5], [0, 4, -40], 0x9f2418); // far wall (target)
addBox([0.5, 8, 60], [-6, 4, -10], 0x3a9f24);
addBox([0.5, 8, 60], [6, 4, -10]);

const sun = engine.createEntity({ name: "Sun" });
sun.addComponent("light", { kind: "directional", color: "#fff4df", intensity: 3, castShadow: false });
sun.object3D.rotation.set(-0.8, -0.5, 0);

const handle = await enableEngineModule(engine, "gi");
const gi = engine.createEntity({ name: "GI" });
gi.addComponent("global-illumination", { probesPerFrame: 256 });
engine.start();
const system = handle.system;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, t, l) => { const s = performance.now(); while (performance.now() - s < t) { if (fn()) return true; await wait(100); } log(`TIMEOUT ${l}`); return false; };

await waitFor(() => system.volumes[0]?.hasRadiance === true, 60000, "hasRadiance");
await wait(3000);

// Per-frame monitor of the inner cascade's fade + recenter activity. Records
// the min cascadeBlend (deepest fade = worst flash) and how many recenters fire.
let recenterCount = 0;
let minBlend = 1;
let dipEvents = 0;
let wasFaded = false;
const vol0 = system.volumes[0];
let prevPending = false;
const monitor = () => {
  const b = vol0.cascadeBlend ?? 1;
  if (b < minBlend) minBlend = b;
  const pending = !!vol0.pendingRecenter;
  if (pending && !prevPending) recenterCount++;
  prevPending = pending;
  const faded = b < 0.8;
  if (faded && !wasFaded) dipEvents++;
  wasFaded = faded;
  if (document.documentElement.dataset.done !== "true") requestAnimationFrame(monitor);
};
requestAnimationFrame(monitor);

// Fly the camera SLOWLY down the corridor so recenters have time to keep up.
log("FLYING camera z=12 -> z=-12 over 10s (SLOW ~2.4u/s)");
const t0 = performance.now(), flyMs = 10000;
let lastLog = 0;
while (performance.now() - t0 < flyMs) {
  const k = (performance.now() - t0) / flyMs;
  camera.position.z = 12 - 24 * k;
  camera.updateMatrixWorld(true);
  await wait(30);
  const now = performance.now() - t0;
  if (now - lastLog > 400) {
    lastLog = now;
    const g = vol0.grid;
    const worldZ = g.dims.z * g.voxelSize;
    const band = Math.max(vol0.spacingWorld, g.dims.z * g.voxelSize * 0.16);
    const drift = Math.abs(camera.position.z - vol0.center.z);
    const perVol = system.volumes.map((v, i) =>
      `c${i}[job=${!!v.voxelJob} pend=${!!v.pendingRecenter} ready=${v.voxelReady} ctrZ=${v.center.z.toFixed(1)}]`).join(" ");
    log(`t=${Math.round(now)}ms camZ=${camera.position.z.toFixed(1)} drift0=${drift.toFixed(1)}/band${band.toFixed(1)} blend0=${(vol0.cascadeBlend ?? 1).toFixed(3)} :: ${perVol}`);
  }
}
log(`SUMMARY recenters=${recenterCount} fadeDips(<0.8)=${dipEvents} minCascadeBlend=${minBlend.toFixed(3)}`);
log("A minCascadeBlend near 0 + multiple fadeDips = the inner cascade repeatedly fell to the coarse parent = the flash.");
engine.stop();
done();
