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
// Large open receiver extending well beyond c0. This catches coherent
// low-direction ray bands and spatial-cascade boundary stripes that the
// original 12 m Cornell floor could not expose.
addBox([120, 0.1, 120], [0, -0.25, 0], 0xb8c3cf);
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
const smokeMode = new URLSearchParams(location.search).get("mode");
const smokeDebugView = new URLSearchParams(location.search).get("debug") ?? "off";
const smokeShot = new URLSearchParams(location.search).has("shot");
// The required no-query smoke uses the bounded three-cascade configuration so
// its compile + resize + rebuild sequence completes inside the portable 70 s
// deadline. Use ?mode=cascades-balanced for the extended five-cascade tier.
const cascadesSmoke = smokeMode == null || smokeMode.startsWith("cascades");
const balancedCascadesSmoke = smokeMode === "cascades-balanced";
const giComponent = giEntity.addComponent("global-illumination", {
  quality: cascadesSmoke && !balancedCascadesSmoke ? "custom" : "balanced",
  voxelRes: 48,
  probeSpacing: 1.5,
  probesPerFrame: 256,
  coneSteps: 6,
  reflections: balancedCascadesSmoke,
  rayProxies: true,
  triangleProbeRays: true,
  cascadeCount: 3,
  c0Spacing: 0.75,
  c0Directions: 24,
  intervalScale: 0.75,
  debugView: smokeDebugView,
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
let rcAlignedAfterMotion = false;
let energyCheckStarted = false;
let energyCheck = null;
const rcIsAligned = () => {
  const rc0 = handle.system._radianceCascades?.cascades?.[0];
  const volume0 = handle.system.volumes[0];
  if (!rc0 || !volume0) return false;
  // The world-space RC lattice re-anchors c0 to its source clipmap centre each
  // frame, snapped to a whole probe spacing. Verify the probe origin matches.
  const { counts, spacing } = rc0.layout;
  const expected = volume0.center.clone().sub(
    new THREE.Vector3(counts.x, counts.y, counts.z).multiplyScalar(spacing * 0.5),
  );
  expected.set(
    Math.round(expected.x / spacing) * spacing,
    Math.round(expected.y / spacing) * spacing,
    Math.round(expected.z / spacing) * spacing,
  );
  return rc0.trace.uniforms.probeGridMin.value.distanceTo(expected) <= 1e-5;
};
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
  if (moved && rcIsAligned()) rcAlignedAfterMotion = true;
  if (ready && resized && moved && !rebuilt && elapsed > 6500) {
    phase = "rebuild";
    rebuilt = true;
    rcAlignedAfterMotion = false;
    giComponent.setProp("voxelRes", 64);
  }
  if (
    ready && resized && moved && rebuilt && rcAlignedAfterMotion &&
    elapsed > 11000
  ) {
    phase = "complete";
    if (!energyCheckStarted) {
      energyCheckStarted = true;
      const rc = handle.system._radianceCascades;
      const deferred = handle.system._deferred;
      const c0 = rc.cascades[0];
      Promise.all([
        engine.renderer.backend.copyTextureToBuffer(
          c0.mergedTexture,
          0,
          0,
          c0.layout.atlasWidth,
          c0.layout.atlasHeight,
          0,
        ),
        engine.renderer.backend.copyTextureToBuffer(
          deferred.giTexture,
          0,
          0,
          deferred.width,
          deferred.height,
          0,
        ),
      ]).then(([probeData, resolvedData]) => {
        const rgbTexels = (data) => {
          let count = 0;
          for (let i = 0; i + 2 < data.length; i += 4) {
            if (data[i] || data[i + 1] || data[i + 2]) count++;
          }
          return count;
        };
        const half = (h) => {
          const s = (h & 0x8000) >> 15; const e = (h & 0x7c00) >> 10; const f = h & 0x03ff;
          if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
          if (e === 0x1f) return NaN;
          return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
        };
        const stats = (data) => {
          const isH = data.constructor === Uint16Array;
          const v = (x) => (isH ? half(x) : x);
          let mn = [1e9, 1e9, 1e9]; let mx = [-1e9, -1e9, -1e9]; let n = 0;
          for (let i = 0; i + 2 < data.length; i += 4) {
            for (let c = 0; c < 3; c++) {
              const val = v(data[i + c]);
              mn[c] = Math.min(mn[c], val); mx[c] = Math.max(mx[c], val);
            }
            n++;
          }
          const range = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
          return { n, min: mn, max: mx, range };
        };
        console.log(`[gi-tmp] probe stats ${JSON.stringify(stats(probeData))}`);
        console.log(`[gi-tmp] resolved stats ${JSON.stringify(stats(resolvedData))}`);
        {
          const isH = resolvedData.constructor === Uint16Array;
          const v = (x) => (isH ? half(x) : x);
          const W2 = deferred.width; const H2 = deferred.height;
          const rowTexels = Math.round(resolvedData.length / 4 / H2);
          const at2 = (x, y) => (y * rowTexels + x) * 4;
          const sample = (fx, fy) => {
            const x = Math.min(W2 - 1, Math.max(0, Math.round(fx * W2)));
            const y = Math.min(H2 - 1, Math.max(0, Math.round(fy * H2)));
            const i = at2(x, y);
            return [v(resolvedData[i]), v(resolvedData[i + 1]), v(resolvedData[i + 2]), v(resolvedData[i + 3])];
          };
          const pts = {
            "near-red-wall(0.1,0.6)": sample(0.1, 0.6),
            "center-floor(0.5,0.85)": sample(0.5, 0.85),
            "near-green-wall(0.9,0.6)": sample(0.9, 0.6),
            "wall-mid-left(0.15,0.4)": sample(0.15, 0.4),
            "wall-mid-right(0.85,0.4)": sample(0.85, 0.4),
          };
          console.log(`[gi-tmp] spatial samples ${JSON.stringify(pts)}`);
        }
        energyCheck = {
          probeRGB: rgbTexels(probeData),
          resolvedRGB: rgbTexels(resolvedData),
        };
      }).catch((error) => {
        energyCheck = { error: error?.stack || String(error) };
      });
      requestAnimationFrame(poll);
      return;
    }
    if (!energyCheck) {
      requestAnimationFrame(poll);
      return;
    }
    engine.stop();
    if (energyCheck.error) {
      fail(`GI energy readback failed: ${energyCheck.error}`);
      document.documentElement.dataset.done = "true";
      return;
    }
    if (energyCheck.probeRGB < 1 || energyCheck.resolvedRGB < 1) {
      fail(
        `GI produced no RGB energy; probes=${energyCheck.probeRGB}, ` +
        `resolved=${energyCheck.resolvedRGB}`,
      );
      document.documentElement.dataset.done = "true";
      return;
    }
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
      (handle.system._deferred
        ? `deferred=${handle.system._deferred.width}x${handle.system._deferred.height}\n`
        : "materialSpaceRC=true\n") +
      "resize=true\nmotion=true\nrebuild=true\nhistoryContinuous=true\n" +
      `localLights=${injectedLocalLights}\ndynamicPoolTris=${handle.system._dynPool?.count ?? 0}\n` +
      `triangleRayVec4s=${handle.system._rayLayout?.totalVec4s ?? 0}\n` +
      `probeRGB=${energyCheck.probeRGB}\nresolvedRGB=${energyCheck.resolvedRGB}\n` +
      "rcAligned=true";
    console.log("GI-SMOKE PASS");
    if (smokeShot) document.documentElement.dataset.shot = "rc-smoke";
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
