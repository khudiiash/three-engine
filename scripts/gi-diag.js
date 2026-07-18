// GI diagnostic: sealed room, GPU buffer readbacks, wall move response.
// Logs lines prefixed DIAG so the runner can grep them.
import * as THREE from "three/webgpu";
import {
  Engine,
  enableEngineModule,
  registerBuiltInComponents,
} from "/src/engine/index.js";
import "/src/modules/index.js";

const log = (message) => console.log(`DIAG ${message}`);
const done = () => {
  document.documentElement.dataset.done = "true";
};
globalThis.addEventListener("error", (event) => {
  log(`PAGEERROR ${event.error?.stack || event.message}`);
  done();
});
globalThis.addEventListener("unhandledrejection", (event) => {
  log(`PAGEERROR ${event.reason?.stack || event.reason}`);
  done();
});

registerBuiltInComponents();
const engine = new Engine();
await engine.init(document.getElementById("canvas"));
engine.setSize(640, 360);

const camera = new THREE.PerspectiveCamera(60, 640 / 360, 0.1, 80);
// Camera inside the room so cascade 0 covers the interior.
camera.position.set(0, 3, 4.5);
camera.lookAt(0, 2, -6);
engine.camera = camera;
engine.scene.add(camera);

const standard = (color) =>
  new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
const addBox = (size, position, color = 0xd0d0d0) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), standard(color));
  mesh.position.set(...position);
  engine.scene.add(mesh);
  return mesh;
};

// Sealed 12 × 6 × 12 room, 0.5 m thick shell, interior fully enclosed.
addBox([13, 0.5, 13], [0, -0.25, 0]); // floor
addBox([13, 0.5, 13], [0, 6.25, 0]); // ceiling
addBox([13, 6, 0.5], [0, 3, -6.25]); // back wall (this one moves later)
const frontWall = addBox([13, 6, 0.5], [0, 3, 6.25]);
addBox([0.5, 6, 13], [-6.25, 3, 0], 0x9f2418);
addBox([0.5, 6, 13], [6.25, 3, 0], 0x3a9f24);
// Exterior ground so outside probes have a bounce surface.
addBox([60, 0.5, 60], [0, -1.0, 0], 0x808080);

const sunEntity = engine.createEntity({ name: "Sun" });
sunEntity.addComponent("light", {
  kind: "directional",
  color: "#fff4df",
  intensity: 3,
  castShadow: false,
});
sunEntity.object3D.rotation.set(-0.8, -0.7, 0);

const handle = await enableEngineModule(engine, "gi");
const giEntity = engine.createEntity({ name: "GI" });
giEntity.addComponent("global-illumination", {
  probesPerFrame: 256,
  coneSteps: 8,
  reflections: false,
  rayProxies: false,
  triangleProbeRays: false,
});

engine.start();
const system = handle.system;

// Instrument pipeline creation and per-frame stalls to find what blocks the
// main thread during startup.
{
  const renderer = engine.renderer;
  const backend = renderer.backend;
  const wrap = (obj, name) => {
    const original = obj[name].bind(obj);
    obj[name] = (...args) => {
      const c0 = performance.now();
      const value = original(...args);
      const ms = performance.now() - c0;
      if (ms > 30) {
        const label =
          args[0]?.computeProgram?.name ||
          args[0]?.cacheKey?.slice?.(0, 60) ||
          "?";
        log(`${name} ${ms.toFixed(0)}ms ${label}`);
      }
      return value;
    };
  };
  wrap(backend, "createComputePipeline");
  wrap(backend, "createRenderPipeline");
  wrap(backend, "createProgram");
  const originalRender = renderer.render.bind(renderer);
  renderer.render = (...args) => {
    const c0 = performance.now();
    const value = originalRender(...args);
    const ms = performance.now() - c0;
    if (ms > 100) log(`render ${ms.toFixed(0)}ms`);
    return value;
  };
  const originalCompute = renderer.compute.bind(renderer);
  renderer.compute = (...args) => {
    const c0 = performance.now();
    const value = originalCompute(...args);
    const ms = performance.now() - c0;
    if (ms > 100) log(`compute ${ms.toFixed(0)}ms ${args[0]?.name || ""}`);
    return value;
  };
  let lastFrameAt = performance.now();
  const frameTimer = () => {
    const now = performance.now();
    const gap = now - lastFrameAt;
    lastFrameAt = now;
    if (gap > 150) log(`slowFrame gap=${gap.toFixed(0)}ms`);
    if (document.documentElement.dataset.done !== "true") {
      requestAnimationFrame(frameTimer);
    }
  };
  requestAnimationFrame(frameTimer);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, timeoutMs, label) => {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (fn()) return performance.now() - t0;
    await wait(100);
  }
  log(`TIMEOUT waiting for ${label}`);
  return -1;
};

const inRoom = (x, y, z) =>
  x > -5.5 && x < 5.5 && y > 0.4 && y < 5.6 && z > -5.5 && z < 5.5;

async function readStats(label) {
  const vol = system.volumes[0];
  const renderer = engine.renderer;
  const [albedoBuf, probeBuf, radBuf, mipBuf] = await Promise.all([
    renderer.getArrayBufferAsync(vol.buffers.voxAlbedo),
    renderer.getArrayBufferAsync(vol.buffers.probeData),
    renderer.getArrayBufferAsync(vol.buffers.radiance),
    renderer.getArrayBufferAsync(vol.buffers.mips),
  ]);
  const albedo = new Uint32Array(albedoBuf);
  const probes = new Float32Array(probeBuf);
  const rad = new Float32Array(radBuf); // level-0 radiance, vec4 per cell
  const mips = new Float32Array(mipBuf); // aniso bins, vec4 per (bin,cell)
  const { dims, min, voxelSize } = vol.grid;

  // Level-0 radiance: is there ANY lit surface energy, and what colour?
  // (Probes bypass the aniso mips; the visible cone gather reads the mips.
  // Split them to localise where colour bleed is lost.)
  let radLit = 0;
  let radR = 0;
  let radG = 0;
  let radB = 0;
  let radMax = 0;
  for (let i = 0; i < dims.x * dims.y * dims.z; i++) {
    const r = rad[i * 4];
    const g = rad[i * 4 + 1];
    const b = rad[i * 4 + 2];
    const l = (r + g + b) / 3;
    if (l > 1e-4) {
      radLit++;
      radR += r;
      radG += g;
      radB += b;
      if (l > radMax) radMax = l;
    }
  }
  // Aniso mip level 1: how much energy actually made it into the six bins
  // the cone gather samples. bufOffset for level 1 is 0; count = level-1
  // cell count; 6 bins consecutive.
  // Level-1 dims = max(1, dim>>1); bufOffset 0; 6 bins consecutive.
  const l1 = {
    x: Math.max(1, dims.x >> 1),
    y: Math.max(1, dims.y >> 1),
    z: Math.max(1, dims.z >> 1),
  };
  const count1 = l1.x * l1.y * l1.z;
  let mipLit = 0;
  let mipMax = 0;
  for (let k = 0; k < count1 * 6 && (k + 1) * 4 <= mips.length; k++) {
    const l = (mips[k * 4] + mips[k * 4 + 1] + mips[k * 4 + 2]) / 3;
    if (l > 1e-4) mipLit++;
    if (l > mipMax) mipMax = l;
  }
  log(
    `${label} RADIANCE lit=${radLit} max=${radMax.toFixed(3)}` +
      ` meanRGB=(${(radR / Math.max(1, radLit)).toFixed(3)},${(radG / Math.max(1, radLit)).toFixed(3)},${(radB / Math.max(1, radLit)).toFixed(3)})` +
      ` | MIP1 lit=${mipLit} max=${mipMax.toFixed(3)}`,
  );

  // Occupancy checks: ceiling slab and a vertical column at room centre.
  let ceilingHits = 0;
  let ceilingCells = 0;
  const total = dims.x * dims.y * dims.z;
  let occupiedTotal = 0;
  for (let i = 0; i < total; i++) {
    if (albedo[i] >>> 24) occupiedTotal++;
  }
  for (let gx = 0; gx < dims.x; gx++) {
    for (let gz = 0; gz < dims.z; gz++) {
      const wx = min.x + (gx + 0.5) * voxelSize;
      const wz = min.z + (gz + 0.5) * voxelSize;
      if (wx < -5 || wx > 5 || wz < -5 || wz > 5) continue;
      // Does ANY cell in the ceiling's y-range contain geometry?
      let hit = false;
      for (let gy = 0; gy < dims.y; gy++) {
        const wy = min.y + (gy + 0.5) * voxelSize;
        if (wy < 5.9 || wy > 6.6) continue;
        const i = gx + gy * dims.x + gz * dims.x * dims.y;
        if (albedo[i] >>> 24) { hit = true; break; }
      }
      ceilingCells++;
      if (hit) ceilingHits++;
    }
  }

  // Probe irradiance stats, interior vs exterior.
  const layout = system.volumes[0].nodes ? vol : vol; // keep linter calm
  const counts = vol.counts;
  const probeCount = counts.x * counts.y * counts.z;
  const spacing = vol.nodes.uniforms.spacing.value;
  const irradianceBase = vol.probeLayoutIrradiance ?? null;
  // Recover the layout from the module (same math as createProbeLayout).
  const RAYS = 64;
  const TEXELS = 64;
  const rayDirsOff = 0;
  const texelDirsOff = rayDirsOff + RAYS;
  const raysOff = texelDirsOff + TEXELS;
  const irrOff = raysOff + vol.probesPerFrame * RAYS;
  let inSum = 0, inN = 0, outSum = 0, outN = 0, inMax = 0;
  for (let p = 0; p < probeCount; p++) {
    const pz = Math.floor(p / (counts.x * counts.y));
    const rem = p - pz * counts.x * counts.y;
    const py = Math.floor(rem / counts.x);
    const px = rem - py * counts.x;
    const wx = min.x + px * spacing.x;
    const wy = min.y + py * spacing.y;
    const wz = min.z + pz * spacing.z;
    let sum = 0;
    for (let t = 0; t < TEXELS; t++) {
      const base = (irrOff + p * TEXELS + t) * 4;
      sum += (probes[base] + probes[base + 1] + probes[base + 2]) / 3;
    }
    const mean = sum / TEXELS;
    if (inRoom(wx, wy, wz)) {
      inSum += mean; inN++;
      if (mean > inMax) inMax = mean;
    } else if (wy > 0.5 && wy < 12) {
      outSum += mean; outN++;
    }
  }
  log(
    `${label} occupied=${occupiedTotal}/${total}` +
      ` ceilingCover=${ceilingHits}/${ceilingCells}` +
      ` probeIn=${inN ? (inSum / inN).toFixed(4) : "n/a"} (n=${inN}, max=${inMax.toFixed(4)})` +
      ` probeOut=${outN ? (outSum / outN).toFixed(4) : "n/a"} (n=${outN})`,
  );
  return { inMean: inN ? inSum / inN : 0, outMean: outN ? outSum / outN : 0 };
}

const t0 = performance.now();
let frames = 0;
const countFrames = () => {
  frames++;
  if (document.documentElement.dataset.done !== "true") requestAnimationFrame(countFrames);
};
requestAnimationFrame(countFrames);
const phase = async (label, fn) => {
  const ms = await waitFor(fn, 40000, label);
  log(
    `phase ${label}=${(performance.now() - t0).toFixed(0)}ms (+${ms.toFixed(0)}ms) frames=${frames}`,
  );
};
await phase("volumesBuilt", () => system.volumes.length > 0);
await phase("voxelReady0", () => system.volumes[0]?.voxelReady === true);
await phase("voxelReadyAll", () => system.volumes.every((v) => v.voxelReady));
await phase("warmupDone", () => system.volumes.every((v) => !v.warmupQueue?.length));
await phase("directInit0", () => system.volumes[0]?.directInitialized === true);
await phase("hasRadiance0", () => system.volumes[0]?.hasRadiance === true);
await phase("deferredReady", () => system._deferredReady?.value === 1);
log(
  `probeBudget vol0 probes=${system.volumes[0].nodes.probeCount} perFrame=${system.volumes[0].probesPerFrame} updatesRemaining=${system.volumes[0].updatesRemaining}`,
);

// Let probes converge in the sealed state.
await wait(6000);
const sealed = await readStats("SEALED");
document.documentElement.dataset.shot = "sealed";
await wait(500);

// Animate the wall down like a real gizmo DRAG (continuous motion keeps it
// in the GPU dynamic layer), sampling interior brightness DURING the drag
// and after release — this reproduces the "accumulate then fade" the direct
// position-set could not.
log("DRAGGING front wall down over 2.5s");
const startY = frontWall.position.y;
const endY = -1;
const dragMs = 2500;
const dragStart = performance.now();
let lastSample = 0;
while (performance.now() - dragStart < dragMs) {
  const k = (performance.now() - dragStart) / dragMs;
  frontWall.position.y = startY + (endY - startY) * k;
  frontWall.updateMatrixWorld(true);
  await wait(50);
  const now = performance.now() - dragStart;
  if (now - lastSample > 500) {
    lastSample = now;
    await readStats(`DRAG@${Math.round(now)}ms`);
  }
}
frontWall.position.y = endY;
frontWall.updateMatrixWorld(true);
log("RELEASED wall");
let elapsed = 0;
for (const target of [700, 1500, 3000, 5000, 9000, 13000]) {
  await wait(target - elapsed);
  elapsed = target;
  await readStats(`AFTER@${target}ms`);
}
const open = await readStats("OPEN");
document.documentElement.dataset.shot = "open";
await wait(500);

log(
  `RESPONSE inMeanSealed=${sealed.inMean.toFixed(4)} inMeanOpen=${open.inMean.toFixed(4)}` +
    ` ratio=${(open.inMean / Math.max(sealed.inMean, 1e-6)).toFixed(2)}`,
);
engine.stop();
done();
