import * as THREE from "three/webgpu";
import {
  Engine,
  enableEngineModule,
  registerBuiltInComponents,
} from "/src/engine/index.js";
import "/src/modules/index.js";

// Steady-state GPU timing for the world-space Radiance Cascades path. Isolates
// the RC trace+merge compute from the deferred pass/resolve so we can size the
// cost of each preset independently. Reports averaged GPU milliseconds by
// batching K dispatches behind a single onSubmittedWorkDone fence.

const result = document.getElementById("result");
const finish = (text) => {
  result.textContent = text;
  console.log(`RC-PERF ${text.replaceAll("\n", " | ")}`);
  document.documentElement.dataset.done = "true";
};
globalThis.addEventListener("error", (e) => finish(`ERROR ${e.error?.stack || e.message}`));
globalThis.addEventListener("unhandledrejection", (e) => finish(`ERROR ${e.reason?.stack || e.reason}`));

const params = new URLSearchParams(location.search);
const quality = params.get("quality") || "balanced";
const W = Number(params.get("w") || 1600);
const H = Number(params.get("h") || 900);

registerBuiltInComponents();
const engine = new Engine();
await engine.init(document.getElementById("canvas"));
engine.setSize(W, H);
const renderer = engine.renderer;
const device = renderer.backend.device;
const validationErrors = [];
device?.addEventListener?.("uncapturederror", (e) =>
  validationErrors.push(e.error?.message || String(e.error)));

const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 80);
camera.position.set(8, 6, 11);
camera.lookAt(0, 2, 0);
engine.camera = camera;
engine.scene.add(camera);

const mat = (color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85, metalness: 0 });
const addBox = (size, position, color = 0xd0d0d0) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat(color));
  mesh.position.set(...position);
  engine.scene.add(mesh);
  return mesh;
};
// A room plus interior clutter, with an open floor extending beyond c0 so the
// coarse cascades and cascade-boundary transitions are exercised too.
addBox([14, 0.4, 14], [0, -0.2, 0]);
addBox([120, 0.1, 120], [0, -0.35, 0], 0xb8c3cf);
addBox([14, 8, 0.4], [0, 4, -7]);
addBox([0.4, 8, 14], [-7, 4, 0], 0x9f2418);
addBox([0.4, 8, 14], [7, 4, 0], 0x3a9f24);
addBox([3, 5, 3], [-2.5, 2.5, -1.5]);
addBox([2.5, 2.5, 2.5], [2.2, 1.25, 1]);
addBox([1.6, 1.6, 1.6], [0, 0.8, 2.5], 0xe0a020);

const sun = engine.createEntity({ name: "Sun" });
sun.addComponent("light", { kind: "directional", color: "#fff4df", intensity: 3, castShadow: false });
sun.object3D.rotation.set(-0.8, -0.7, 0);
const lamp = engine.createEntity({ name: "Lamp" });
lamp.addComponent("light", { kind: "point", color: "#ffd7a0", intensity: 18, distance: 22, decay: 2, castShadow: false });
lamp.object3D.position.set(0, 5, 2);

const handle = await enableEngineModule(engine, "gi");
const gi = engine.createEntity({ name: "GI" });
gi.addComponent("global-illumination", { quality });
engine.start();

const started = performance.now();
const timeBatch = async (fn, iters) => {
  // Warm the fence, then batch `iters` dispatches behind one fence and divide.
  await device.queue.onSubmittedWorkDone();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  await device.queue.onSubmittedWorkDone();
  return (performance.now() - t0) / iters;
};

const poll = async () => {
  const ready = handle.system?._deferredReady?.value === 1;
  const warm = handle.system.volumes?.every((v) => v.warmupQueue.length === 0);
  if (!ready || !warm) {
    if (performance.now() - started > 60000) {
      finish("TIMEOUT waiting for GI warmup");
      return;
    }
    requestAnimationFrame(poll);
    return;
  }
  engine.stop();
  const rc = handle.system._radianceCascades;
  const d = handle.system._deferred;
  const skyU = handle.system.volumes[0].nodes.uniforms;
  const center = handle.system.volumes[0].center;

  const rcOnly = () => { rc.update(center, skyU.skyColor.value, 1); rc.compute(renderer); };
  const deferred = () => {
    rc.update(center, skyU.skyColor.value, 1);
    rc.compute(renderer);
    renderer.compute(d.passNode);
    renderer.compute(d.resolveNode);
  };

  // Discard the first timed batch (pipeline/bind-group warm), then measure.
  await timeBatch(rcOnly, 4);
  const rcMs = await timeBatch(rcOnly, 40);
  const deferredMs = await timeBatch(deferred, 40);

  const cascadeInfo = rc.cascades.map((c) =>
    `c${c.layout.index}:${c.layout.counts.x}x${c.layout.counts.y}x${c.layout.counts.z}` +
    `x${c.layout.directionCount}d(${(c.layout.rayCount / 1e3).toFixed(0)}k)`).join(" ");
  finish(
    `quality=${quality} ${W}x${H}\n` +
    `cascades=${rc.cascades.length} totalRays=${(rc.totalRays / 1e6).toFixed(2)}M ` +
    `mem=${(rc.totalBytes / 1048576).toFixed(1)}MB\n` +
    `${cascadeInfo}\n` +
    `rcTraceMergeMs=${rcMs.toFixed(3)}\n` +
    `rc+pass+resolveMs=${deferredMs.toFixed(3)}\n` +
    `passResolveMs=${(deferredMs - rcMs).toFixed(3)}\n` +
    `validationErrors=${validationErrors.length}` +
    (validationErrors.length ? `\n${validationErrors.slice(0, 3).join("\n")}` : ""),
  );
};
requestAnimationFrame(poll);
