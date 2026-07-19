// GI diagnostic: a MOVING EMISSIVE box is the only light in a room. Measures
// whether the room walls track the light during a continuous drag or stay
// frozen at the origin until it stops. Logs lines prefixed DIAG.
import * as THREE from "three/webgpu";
import {
  Engine,
  enableEngineModule,
  registerBuiltInComponents,
} from "/src/engine/index.js";
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
camera.position.set(0, 3, 9);
camera.lookAt(0, 2, 0);
engine.camera = camera;
engine.scene.add(camera);

const standard = (color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
const addBox = (size, position, color = 0xd0d0d0) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), standard(color));
  mesh.position.set(...position);
  engine.scene.add(mesh);
  return mesh;
};

// Sealed 12 × 6 × 12 room so the emissive box is the dominant light.
addBox([13, 0.5, 13], [0, -0.25, 0]);
addBox([13, 0.5, 13], [0, 6.25, 0]);
addBox([13, 6, 0.5], [0, 3, -6.25]);
addBox([13, 6, 0.5], [0, 3, 6.25]);
addBox([0.5, 6, 13], [-6.25, 3, 0]);
addBox([0.5, 6, 13], [6.25, 3, 0]);

// The single light: a bright emissive box, starts on the LEFT (x = -4).
const emissiveMat = new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 1 });
emissiveMat.emissive = new THREE.Color(0xffffff);
emissiveMat.emissiveIntensity = 6;
const glowSize = new URLSearchParams(location.search).has("small") ? 0.15 : 1;
log(`glow size=${glowSize}`);
const glow = new THREE.Mesh(new THREE.BoxGeometry(glowSize, glowSize, glowSize), emissiveMat);
glow.position.set(-4, 2, 0);
engine.scene.add(glow);

const handle = await enableEngineModule(engine, "gi");
const giEntity = engine.createEntity({ name: "GI" });
giEntity.addComponent("global-illumination", {
  probesPerFrame: 256,
  reflections: false,
  // No sun in this scene: skyIntensity low so emissive dominates the readback.
  skyIntensity: 0.0,
});
engine.start();
const system = handle.system;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs, label) => {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await wait(100);
  }
  log(`TIMEOUT ${label}`);
  return false;
};

const RAYS = 64, TEXELS = 64;

// Mean probe irradiance for probes whose world x is in [xMin, xMax] (a vertical
// slab of the room) — "left" vs "right" tracks where the light is bright.
async function readSlabs(label) {
  const vol = system.volumes[0];
  const [probeBuf, radBuf] = await Promise.all([
    engine.renderer.getArrayBufferAsync(vol.buffers.probeData),
    engine.renderer.getArrayBufferAsync(vol.buffers.radiance),
  ]);
  const probes = new Float32Array(probeBuf);
  const rad = new Float32Array(radBuf); // vec4 per voxel cell (surface radiance)
  const { min, dims, voxelSize } = vol.grid;
  // Radiance directly reflects inject(direct + emissive-direct + feedback) —
  // isolates the emissive receiver cache from probe hysteresis.
  const radSlab = (xMin, xMax) => {
    let sum = 0, n = 0;
    for (let gz = 0; gz < dims.z; gz++)
      for (let gy = 0; gy < dims.y; gy++)
        for (let gx = 0; gx < dims.x; gx++) {
          const wx = min.x + (gx + 0.5) * voxelSize;
          if (wx < xMin || wx > xMax) continue;
          const i = gx + gy * dims.x + gz * dims.x * dims.y;
          const l = (rad[i * 4] + rad[i * 4 + 1] + rad[i * 4 + 2]) / 3;
          if (l > 1e-5) { sum += l; n++; }
        }
    return n ? sum / n : 0;
  };
  const rL = radSlab(-6.5, -4.5); // left wall region
  const rR = radSlab(4.5, 6.5); // right wall region
  const pool = system._dynPool;
  const poolIdx = pool?.meshes?.indexOf(glow) ?? -1;
  log(`${label} RAD leftWall=${rL.toFixed(4)} rightWall=${rR.toFixed(4)} R/L=${(rR / Math.max(rL, 1e-6)).toFixed(2)}`
    + ` | voxelSize=${voxelSize.toFixed(3)} dynActive0=${system._dynActive?.[0] === true}`
    + ` glowInPool=${poolIdx >= 0} glowMaxDim=${poolIdx >= 0 ? pool.maxDims[poolIdx]?.toFixed(2) : "n/a"}`
    + ` gate=${(0.75 * voxelSize).toFixed(3)}`);
  const counts = vol.counts;
  const spacing = vol.nodes.uniforms.spacing.value;
  const irrOff = RAYS + TEXELS + vol.probesPerFrame * RAYS;
  const slab = (xMin, xMax) => {
    let sum = 0, n = 0;
    for (let p = 0; p < counts.x * counts.y * counts.z; p++) {
      const pz = Math.floor(p / (counts.x * counts.y));
      const rem = p - pz * counts.x * counts.y;
      const py = Math.floor(rem / counts.x);
      const px = rem - py * counts.x;
      const wx = min.x + px * spacing.x;
      const wy = min.y + py * spacing.y;
      const wz = min.z + pz * spacing.z;
      if (wx < xMin || wx > xMax || wy < 0.5 || wy > 5.5 || wz < -5.5 || wz > 5.5) continue;
      let s = 0;
      for (let t = 0; t < TEXELS; t++) {
        const b = (irrOff + p * TEXELS + t) * 4;
        s += (probes[b] + probes[b + 1] + probes[b + 2]) / 3;
      }
      sum += s / TEXELS; n++;
    }
    return n ? sum / n : 0;
  };
  const left = slab(-6, -2);
  const right = slab(2, 6);
  log(`${label} leftMean=${left.toFixed(4)} rightMean=${right.toFixed(4)} R/L=${(right / Math.max(left, 1e-6)).toFixed(2)}`);
  return { left, right };
}

const EMBED = new URLSearchParams(location.search).has("embed");

// Mean surface radiance of FLOOR cells (y≈0) in a ring around the box
// footprint — measures whether an emissive box embedded in the floor lights
// the floor it sits in (the junction/AMBIGUOUS-cell bug).
async function readFloorRing(label, cx) {
  const vol = system.volumes[0];
  const [radBuf, normBuf] = await Promise.all([
    engine.renderer.getArrayBufferAsync(vol.buffers.radiance),
    engine.renderer.getArrayBufferAsync(vol.buffers.voxNormal),
  ]);
  const rad = new Float32Array(radBuf);
  const norm = new Uint32Array(normBuf);
  const { min, dims, voxelSize } = vol.grid;
  // Split floor-contact cells by the AMBIGUOUS_NORMAL bit (27): the junction
  // cells at the box/floor interface are the ones the fix targets.
  let ambSum = 0, ambN = 0, ambLit = 0, plainSum = 0, plainN = 0;
  for (let gz = 0; gz < dims.z; gz++)
    for (let gy = 0; gy < dims.y; gy++)
      for (let gx = 0; gx < dims.x; gx++) {
        const wx = min.x + (gx + 0.5) * voxelSize;
        const wy = min.y + (gy + 0.5) * voxelSize;
        const wz = min.z + (gz + 0.5) * voxelSize;
        if (wy < -0.5 || wy > 0.6) continue; // floor + box-contact band
        const d = Math.hypot(wx - cx, wz - 0);
        if (d > 1.4) continue; // box footprint + immediate contact ring
        const i = gx + gy * dims.x + gz * dims.x * dims.y;
        if ((norm[i] & 0x00ffffff) === 0) continue; // empty cell
        const l = (rad[i * 4] + rad[i * 4 + 1] + rad[i * 4 + 2]) / 3;
        const ambiguous = (norm[i] & 0x08000000) !== 0;
        if (ambiguous) { ambSum += l; ambN++; if (l > 1e-4) ambLit++; }
        else { plainSum += l; plainN++; }
      }
  log(`${label} CONTACT ambiguousCells=${ambN} ambLit=${ambLit} ambMean=${ambN ? (ambSum / ambN).toFixed(4) : "0"}`
    + ` | plainCells=${plainN} plainMean=${plainN ? (plainSum / plainN).toFixed(4) : "0"}`);
}

await waitFor(() => system.volumes[0]?.hasRadiance === true, 40000, "hasRadiance");

if (EMBED) {
  // Sink the emissive box into the floor (floor top at y=0; box spans y∈[-0.4,0.6]).
  glow.position.set(0, 0.1, 0);
  glow.updateMatrixWorld(true);
  system.markVoxelsDirty?.();
  await wait(6000);
  await readFloorRing("EMBED", 0);
  await wait(2000);
  await readFloorRing("EMBED2", 0);
  engine.stop();
  done();
  throw new Error("__DONE__"); // stop the module here in embed mode
}

await wait(4000); // converge with the light on the LEFT
await readSlabs("START(light@-4)");

// Drag the glow LEFT→RIGHT over 2.5 s, sampling throughout.
log("DRAG glow -4 -> +4 over 2.5s");
const dragMs = 2500, t0 = performance.now();
let lastSample = 0;
while (performance.now() - t0 < dragMs) {
  const k = (performance.now() - t0) / dragMs;
  glow.position.x = -4 + 8 * k;
  glow.updateMatrixWorld(true);
  await wait(50);
  const now = performance.now() - t0;
  if (now - lastSample > 500) { lastSample = now; await readSlabs(`DRAG@${Math.round(now)}ms(light@${(glow.position.x).toFixed(1)})`); }
}
glow.position.x = 4;
glow.updateMatrixWorld(true);
log("RELEASED glow@+4");
let elapsed = 0;
for (const target of [300, 700, 1200, 2000, 3500, 6000]) {
  await wait(target - elapsed); elapsed = target;
  await readSlabs(`AFTER@${target}ms`);
}
log("EXPECT: during drag rightMean should rise and leftMean fall (light tracks). If right stays low until AFTER, emissive is frozen.");
engine.stop();
done();
