// GI diagnostic: STATIC emissive light + a MOVING NON-emissive occluder.
// Samples a fixed wall region's radiance rapidly to catch flicker (oscillation
// frame-to-frame) vs. smooth tracking. Logs lines prefixed DIAG.
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
camera.position.set(0, 3, 9); camera.lookAt(0, 2, 0);
engine.camera = camera; engine.scene.add(camera);

const standard = (c) => new THREE.MeshStandardNodeMaterial({ color: c, roughness: 0.9, metalness: 0 });
const addBox = (s, p, c = 0xd0d0d0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(...s), standard(c)); m.position.set(...p); engine.scene.add(m); return m; };
// Sealed room.
addBox([13, 0.5, 13], [0, -0.25, 0]); addBox([13, 0.5, 13], [0, 6.25, 0]);
addBox([13, 6, 0.5], [0, 3, -6.25]); addBox([13, 6, 0.5], [0, 3, 6.25]);
addBox([0.5, 6, 13], [-6.25, 3, 0]); addBox([0.5, 6, 13], [6.25, 3, 0]);

// STATIC emissive light on the left wall.
const em = new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 1 });
em.emissive = new THREE.Color(0xffffff); em.emissiveIntensity = 6;
const glow = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), em);
glow.position.set(-4, 2, 0); engine.scene.add(glow);

// Non-emissive occluder between the light and the back wall — this MOVES.
const occ = addBox([1, 2, 1], [-2, 2, 0], 0x808080);

const handle = await enableEngineModule(engine, "gi");
engine.createEntity({ name: "GI" }).addComponent("global-illumination", { probesPerFrame: 256, reflections: false, skyIntensity: 0 });
engine.start();
const system = handle.system;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, t, l) => { const s = performance.now(); while (performance.now() - s < t) { if (fn()) return true; await wait(100); } log(`TIMEOUT ${l}`); return false; };

  // RGBE8 decode (r,g,b mantissa + shared exponent in the high byte).
  const rgbeLum = (word) => {
    if (word === 0) return 0;
    const e = (word >>> 24) & 255;
    const scale = Math.pow(2, e - 128) / 255;
    return (((word & 255) + ((word >>> 8) & 255) + ((word >>> 16) & 255)) / 3) * scale;
  };

// Mean of a fixed back-wall region for a chosen buffer. `radiance` = the cone
// gather source; `voxEmissiveDirect` (RGBE) = the emissive receiver cache the
// deferred samples separately (where a moving occluder's shadow recomputes).
async function wallOf(bufName) {
  const vol = system.volumes[0];
  const raw = await engine.renderer.getArrayBufferAsync(vol.buffers[bufName]);
  const isFloat = bufName === "radiance";
  const arr = isFloat ? new Float32Array(raw) : new Uint32Array(raw);
  const { min, dims, voxelSize } = vol.grid;
  let sum = 0, n = 0;
  for (let gz = 0; gz < dims.z; gz++) for (let gy = 0; gy < dims.y; gy++) for (let gx = 0; gx < dims.x; gx++) {
    const wz = min.z + (gz + 0.5) * voxelSize;
    if (wz < 5.4) continue;
    const wx = min.x + (gx + 0.5) * voxelSize, wy = min.y + (gy + 0.5) * voxelSize;
    if (wx < -3 || wx > 3 || wy < 1 || wy > 4) continue;
    const i = gx + gy * dims.x + gz * dims.x * dims.y;
    const l = isFloat ? (arr[i * 4] + arr[i * 4 + 1] + arr[i * 4 + 2]) / 3 : rgbeLum(arr[i]);
    if (l > 1e-5) { sum += l; n++; }
  }
  return n ? sum / n : 0;
}
const wallRad = () => wallOf("voxEmissiveDirect");

// Report a series + flag flicker (sign flips in consecutive deltas).
async function series(label, sampler, count, gapMs, mover) {
  const vals = [];
  for (let i = 0; i < count; i++) {
    if (mover) mover(i / count);
    vals.push(await sampler());
    await wait(gapMs);
  }
  let flips = 0;
  for (let i = 2; i < vals.length; i++) {
    const d1 = vals[i - 1] - vals[i - 2], d2 = vals[i] - vals[i - 1];
    if (d1 * d2 < -1e-8 && Math.abs(d2) > 0.002) flips++;
  }
  log(`${label} vals=[${vals.map((v) => v.toFixed(3)).join(",")}] signFlips=${flips}/${count - 2}`);
}

await waitFor(() => system.volumes[0]?.hasRadiance === true, 60000, "hasRadiance");
await wait(4000);

// Baseline: occluder STILL — expect stable (few sign flips).
await series("STILL", wallRad, 12, 120, null);

// Occluder MOVING across the light's path — flicker = many sign flips.
log("MOVING occluder x=-3 -> x=-1 (across the light->wall path)");
await series("MOVING", wallRad, 16, 120, (k) => { occ.position.x = -3 + 2 * k; occ.updateMatrixWorld(true); });

// After stop — should settle stable.
await series("AFTER-STOP", wallRad, 12, 200, null);
log("signFlips high in MOVING but low in STILL/AFTER = motion-recompute flicker.");
engine.stop(); done();
