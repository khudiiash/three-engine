import * as THREE from "three/webgpu";
import {
  Engine,
  enableEngineModule,
  registerBuiltInComponents,
} from "/src/engine/index.js";
import "/src/modules/index.js";

const result = document.getElementById("result");
const failures = [];
let phase = "startup";
const fail = (message) => {
  failures.push(`[${phase}] ${String(message)}`);
  result.textContent = `FAIL\n${failures.join("\n")}`;
  // Mirrored to the console so a headed-Chrome run with
  // --enable-logging=stderr can be grepped without DOM access.
  console.log(`GI-SMOKE FAIL [${phase}] ${String(message)}`);
};

globalThis.addEventListener("error", (event) => fail(event.error?.stack || event.message));
globalThis.addEventListener("unhandledrejection", (event) => fail(event.reason?.stack || event.reason));

registerBuiltInComponents();
const engine = new Engine();
await engine.init(document.getElementById("canvas"));
engine.setSize(640, 360);

engine.renderer.backend?.device?.addEventListener?.("uncapturederror", (event) => {
  fail(event.error?.message || event.error);
});

const camera = new THREE.PerspectiveCamera(60, 640 / 360, 0.1, 50);
camera.position.set(7, 6, 10);
camera.lookAt(0, 2, 0);
engine.camera = camera;
engine.scene.add(camera);

const standard = (color) => new THREE.MeshStandardNodeMaterial({
  color,
  roughness: 0.8,
  metalness: 0,
});
const addBox = (size, position, color) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), standard(color));
  mesh.position.set(...position);
  engine.scene.add(mesh);
  return mesh;
};

addBox([12, 0.2, 12], [0, -0.1, 0], 0xd8d8d8);
addBox([12, 8, 0.2], [0, 4, -6], 0xd8d8d8);
addBox([0.2, 8, 12], [-6, 4, 0], 0x9f2418);
addBox([0.2, 8, 12], [6, 4, 0], 0x3a9f24);
addBox([2.5, 4.5, 2.5], [-1.8, 2.25, -1], 0xd8d8d8);
addBox([2.5, 2.5, 2.5], [1.8, 1.25, 0.7], 0xd8d8d8);

// Perpetual mover: after ~3 motion polls it is flagged dynamic, leaves the
// CPU static grid, and must instead appear in the GPU splat pool.
const mover = addBox([1.5, 1.5, 1.5], [0, 1.5, 2.5], 0xe0a020);

const sunEntity = engine.createEntity({ name: "Sun" });
sunEntity.addComponent("light", {
  kind: "directional",
  color: "#fff4df",
  intensity: 3,
  castShadow: false,
});
sunEntity.object3D.rotation.set(-0.8, -0.7, 0);

const lampEntity = engine.createEntity({ name: "Off-screen Lamp" });
lampEntity.addComponent("light", {
  kind: "point",
  color: "#ffd7a0",
  intensity: 18,
  distance: 20,
  decay: 2,
  castShadow: false,
});
lampEntity.object3D.position.set(0, 5, 3);

const handle = await enableEngineModule(engine, "gi");
const giEntity = engine.createEntity({ name: "Automatic GI" });
const giComponent = giEntity.addComponent("global-illumination", {
  voxelRes: 48,
  probeSpacing: 1.5,
  probesPerFrame: 256,
  coneSteps: 6,
  reflections: false,
  rayProxies: true,
  triangleProbeRays: true,
});
globalThis.__giSmoke = { engine, handle, giComponent };

engine.start();
const started = performance.now();
phase = "warming";
let resized = false;
let moved = false;
let rebuilt = false;
let historyStarted = false;
let historyDropped = false;
let dynSeen = false;
let triangleRaysSeen = false;
const poll = () => {
  if (failures.length) {
    engine.stop();
    document.documentElement.dataset.done = "true";
    return;
  }
  // Keep the mover perpetually in motion so the GI system classifies it
  // dynamic and routes it through the GPU splat path.
  const t = performance.now() * 0.002;
  mover.position.set(Math.sin(t) * 2, 1.5, 2.5 + Math.cos(t) * 1.5);
  if (handle.system._dynPool?.count > 0 && handle.system._dynActive?.some(Boolean)) {
    dynSeen = true;
  }
  if (
    handle.system._rayDataReady &&
    handle.system.volumes.some(
      (volume) => volume.nodes.uniforms.rayTracingEnabled.value === 1,
    )
  ) {
    triangleRaysSeen = true;
  }
  const ready = handle.system?._deferredReady?.value === 1;
  const historyValid =
    handle.system?._deferred?.uniforms?.historyValid?.value === 1;
  if (ready && historyValid) historyStarted = true;
  if (historyStarted && (!ready || !historyValid)) historyDropped = true;
  const elapsed = performance.now() - started;
  if (ready && !resized && elapsed > 1800) {
    phase = "resize";
    resized = true;
    engine.setSize(800, 400);
    camera.aspect = 2;
    camera.updateProjectionMatrix();
  }
  if (ready && resized && !moved && elapsed > 4500) {
    phase = "motion";
    moved = true;
    camera.position.set(-8, 7, 8);
    camera.lookAt(0, 2, -1);
  }
  if (ready && resized && moved && !rebuilt && elapsed > 6500) {
    phase = "rebuild";
    rebuilt = true;
    giComponent.setProp("voxelRes", 64);
  }
  if (ready && resized && moved && rebuilt && elapsed > 11000) {
    phase = "complete";
    engine.stop();
    if (historyDropped) {
      fail("Temporal history or resolved GI dropped during resize/rebuild");
      document.documentElement.dataset.done = "true";
      return;
    }
    const injectedLocalLights = Math.max(
      0,
      ...handle.system.volumes.map(
        (volume) => volume.nodes.uniforms.localLightCount.value,
      ),
    );
    if (injectedLocalLights < 1) {
      fail("Point/spot light influence was not injected into any clipmap");
      document.documentElement.dataset.done = "true";
      return;
    }
    if (!dynSeen) {
      fail("Mover never entered the GPU dynamic splat pool");
      document.documentElement.dataset.done = "true";
      return;
    }
    if (!triangleRaysSeen) {
      fail("Triangle probe rays never became active");
      document.documentElement.dataset.done = "true";
      return;
    }
    result.textContent =
      `PASS\nvolumes=${handle.system.volumes.length}\n` +
      `deferred=${handle.system._deferred.width}x${handle.system._deferred.height}\n` +
      "resize=true\nmotion=true\nrebuild=true\nhistoryContinuous=true\n" +
      `localLights=${injectedLocalLights}\ndynamicPoolTris=${handle.system._dynPool?.count ?? 0}\n` +
      `triangleRayVec4s=${handle.system._rayLayout?.totalVec4s ?? 0}`;
    console.log("GI-SMOKE PASS");
    document.documentElement.dataset.done = "true";
    return;
  }
  // Software/headless WebGPU can spend roughly half a second compiling each
  // deliberately frame-spread startup pipeline. Three cascades currently
  // require more than 40 warmup frames, so a 20 s wall-clock deadline could
  // expire before the engine had a chance to publish its first radiance.
  if (elapsed > 60000) {
    const volumes = handle.system.volumes.map((volume, index) =>
      `v${index}{warm=${volume.warmupQueue.length},voxel=${volume.voxelReady ? 1 : 0},` +
      `direct=${volume.directStepsRemaining}/${volume.directInitialized ? 1 : 0},` +
      `radiance=${volume.hasRadiance ? 1 : 0},updates=${volume.updatesRemaining}}`,
    ).join(" ");
    fail(
      `Timed out waiting for deferred GI; ready=${ready ? 1 : 0}, ` +
      `frame=${handle.system._frame}, ${volumes}`,
    );
    engine.stop();
    document.documentElement.dataset.done = "true";
    return;
  }
  requestAnimationFrame(poll);
};
requestAnimationFrame(poll);
