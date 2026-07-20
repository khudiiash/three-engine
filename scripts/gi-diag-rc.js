import * as THREE from "three/webgpu";
import {
  Engine,
  enableEngineModule,
  registerBuiltInComponents,
} from "/src/engine/index.js";
// Legacy world-lattice diagnostic retained only for comparing the discarded
// experiment with the active screen-space implementation.
import { createRadianceCascades } from "/src/modules/gi/radianceCascades.js";
import "/src/modules/index.js";

const result = document.getElementById("result");
const finish = (ok, details) => {
  result.textContent = `${ok ? "PASS" : "FAIL"}\n${details}`;
  console.log(`RC-SPIKE ${ok ? "PASS" : "FAIL"} ${details.replaceAll("\n", " ")}`);
  document.documentElement.dataset.done = "true";
};
const hashWords = (words) => {
  let hash = 0x811c9dc5;
  for (const word of words) {
    hash ^= word;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const firstDifference = (a, b) => {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return index;
  }
  return a.length === b.length ? -1 : length;
};
globalThis.addEventListener("error", (event) =>
  finish(false, event.error?.stack || event.message));
globalThis.addEventListener("unhandledrejection", (event) =>
  finish(false, event.reason?.stack || event.reason));

registerBuiltInComponents();
const engine = new Engine();
await engine.init(document.getElementById("canvas"));
engine.setSize(640, 360);
const validationErrors = [];
engine.renderer.backend?.device?.addEventListener?.("uncapturederror", (event) => {
  validationErrors.push(event.error?.message || String(event.error));
});

const camera = new THREE.PerspectiveCamera(60, 640 / 360, 0.1, 60);
camera.position.set(0, 3, 4.5);
camera.lookAt(0, 2, -6);
engine.camera = camera;
engine.scene.add(camera);
const material = (color) => new THREE.MeshStandardNodeMaterial({
  color,
  roughness: 0.9,
  metalness: 0,
});
const addBox = (size, position, color = 0xd0d0d0) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
  mesh.position.set(...position);
  engine.scene.add(mesh);
  return mesh;
};
// Cornell-like sealed room. The sun lights exterior faces while interval
// rays originating inside must terminate black on their back faces.
addBox([13, 0.5, 13], [0, -0.25, 0]);
addBox([13, 0.5, 13], [0, 6.25, 0]);
addBox([13, 6, 0.5], [0, 3, -6.25]);
addBox([13, 6, 0.5], [0, 3, 6.25]);
addBox([0.5, 6, 13], [-6.25, 3, 0], 0xff0000); // red wall at -X
addBox([0.5, 6, 13], [6.25, 3, 0], 0x00ff00); // green wall at +X
const lamp = engine.createEntity({ name: "RC spike lamp" });
lamp.addComponent("light", {
  kind: "point",
  color: "#ffffff",
  intensity: 24,
  distance: 16,
  decay: 2,
  castShadow: false,
});
lamp.object3D.position.set(0, 4.5, 0);

const handle = await enableEngineModule(engine, "gi");
const giEntity = engine.createEntity({ name: "GI" });
giEntity.addComponent("global-illumination", {
  quality: "custom",
  voxelRes: 32,
  probesPerFrame: 128,
  coneSteps: 4,
  reflections: false,
  rayProxies: false,
});
engine.start();

const started = performance.now();
const poll = async () => {
  const sourceReady = handle.system.volumes[0]?.hasRadiance &&
    handle.system.volumes.every((volume) => volume.warmupQueue.length === 0);
  if (!sourceReady) {
    if (performance.now() - started > 65000) {
      engine.stop();
      finish(false, "timed out waiting for the voxel radiance source");
      return;
    }
    requestAnimationFrame(poll);
    return;
  }

  engine.stop();
  const rc = createRadianceCascades({
    volumes: handle.system.volumes,
    cascadeCount: 3,
    c0Counts: { x: 16, y: 16, z: 16 },
    c0Spacing: 0.75,
    c0Directions: 24,
    intervalScale: 12,
  });
  rc.update(new THREE.Vector3(0, 3, 0), new THREE.Color(0.5, 0.7, 1), 1);
  const compileStarted = performance.now();
  rc.compute(engine.renderer);
  await engine.renderer.backend.device.queue.onSubmittedWorkDone();
  const compileMs = performance.now() - compileStarted;
  const readAtlas = (cascade, texture) => engine.renderer.backend.copyTextureToBuffer(
    texture,
    0,
    0,
    cascade.layout.atlasWidth,
    cascade.layout.atlasHeight,
    0,
  );
  const firstPass = await Promise.all(rc.cascades.map(async (cascade) => ({
    interval: await readAtlas(cascade, cascade.intervalTexture),
    merged: await readAtlas(cascade, cascade.mergedTexture),
  })));
  rc.compute(engine.renderer);
  await engine.renderer.backend.device.queue.onSubmittedWorkDone();
  const secondPass = await Promise.all(rc.cascades.map(async (cascade) => ({
    interval: await readAtlas(cascade, cascade.intervalTexture),
    merged: await readAtlas(cascade, cascade.mergedTexture),
  })));
  const cascadeDetails = rc.cascades.map((cascade, index) => {
    const first = firstPass[index];
    const second = secondPass[index];
    return {
      intervalHash: hashWords(first.interval),
      mergedHash: hashWords(first.merged),
      repeatIntervalDifference: firstDifference(first.interval, second.interval),
      repeatMergedDifference: firstDifference(first.merged, second.merged),
      mergeDifference: firstDifference(first.interval, first.merged),
    };
  });
  const cascade = rc.cascades[0];
  const pixels = firstPass[0].interval;
  let occupied = 0;
  let energetic = 0;
  // rgba16f; zero/non-zero is sufficient for this structural spike gate.
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] !== 0) occupied++;
    if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0) energetic++;
  }

  // Colour-bleed tripwire. The Cornell room has a red (-X) and a green (+X)
  // wall lit by the interior lamp. If directional bounce is intact, the merged
  // c0 field must carry BOTH red-dominant and green-dominant rays; a broken or
  // desaturated gather produces neither. copyTextureToBuffer returns rgba16f,
  // so decode the half-float bit patterns to real magnitudes before comparing.
  const halfToFloat = (h) => {
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
    if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
    return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
  };
  const bleed = (buffer) => {
    const isHalf = buffer.constructor === Uint16Array;
    const val = (x) => (isHalf ? halfToFloat(x) : x);
    let red = 0;
    let green = 0;
    let sumR = 0;
    let sumG = 0;
    for (let i = 0; i + 3 < buffer.length; i += 4) {
      const r = val(buffer[i]);
      const g = val(buffer[i + 1]);
      const b = val(buffer[i + 2]);
      sumR += r;
      sumG += g;
      if (r + g + b < 0.02) continue;
      if (r > g * 1.25 && r > b * 1.25) red++;
      if (g > r * 1.25 && g > b * 1.25) green++;
    }
    return {
      red,
      green,
      sumR: sumR.toFixed(1),
      sumG: sumG.toFixed(1),
    };
  };
  const intervalBleed = bleed(firstPass[0].interval);
  const mergedBleed = bleed(firstPass[0].merged);
  const redBleed = mergedBleed.red;
  const greenBleed = mergedBleed.green;
  const details = [
    `rays=${cascade.layout.rayCount}`,
    `atlas=${cascade.layout.atlasWidth}x${cascade.layout.atlasHeight}`,
    `occupied=${occupied}`,
    `energetic=${energetic}`,
    `interval[red=${intervalBleed.red},green=${intervalBleed.green},maxG=${intervalBleed.maxG}]`,
    `merged[red=${mergedBleed.red},green=${mergedBleed.green},maxG=${mergedBleed.maxG}]`,
    ...cascadeDetails.map((entry, index) =>
      `c${index} interval=${entry.intervalHash} merged=${entry.mergedHash} ` +
      `mergeDiff=${entry.mergeDifference} repeatI=${entry.repeatIntervalDifference} ` +
      `repeatM=${entry.repeatMergedDifference}`),
    `compileAndDispatchMs=${compileMs.toFixed(1)}`,
    `validationErrors=${validationErrors.length}`,
  ].join("\n");
  const ok = occupied > 0 && energetic > 0 &&
    energetic < cascade.layout.rayCount &&
    redBleed > 0 && greenBleed > 0 &&
    cascadeDetails.at(-1).mergeDifference === -1 &&
    cascadeDetails.every((entry) => entry.repeatIntervalDifference === -1 &&
      entry.repeatMergedDifference === -1) &&
    validationErrors.length === 0;
  rc.dispose();
  finish(ok, validationErrors.length ? `${details}\n${validationErrors.join("\n")}` : details);
};
requestAnimationFrame(poll);
