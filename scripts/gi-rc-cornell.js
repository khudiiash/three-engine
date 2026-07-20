// RC CORNELL — multi-bounce feedback verification (deterministic, no editor).
//
// Reproduces the user's failing case: a Cornell box lit ONLY by an emissive
// ceiling panel (no analytic lights). Without the bounce-feedback pass the
// colored walls' voxels are black (they receive light only via GI) and
// nothing bleeds; with feedback, red/green must visibly tint the floor,
// boxes, and back wall. Renders bounce=0 and bounce=1 side by side.
import * as THREE from "three/webgpu";
import { cameraPosition, instanceIndex, normalWorld, positionLocal, positionWorld, step, uniform, vec3 } from "three/tsl";
import { createRadianceCascades } from "/src/modules/gi/cascadeTrace.js";
import { createCascadeMerge } from "/src/modules/gi/cascadeMerge.js";
import { createBounceFeedback, createIrradianceGather } from "/src/modules/gi/cascadeGather.js";
import { voxelizeOnce } from "/src/modules/gi/voxelizeOnce.js";

const result = document.getElementById("result");
const say = (text) => {
  if (result) result.textContent = text;
  console.log(`RC-CORNELL ${text.replaceAll("\n", " ")}`);
};
const finish = (ok, details) => {
  say(`${ok ? "PASS" : "FAIL"}\n${details}`);
  document.documentElement.dataset.done = "true";
};
globalThis.addEventListener("error", (event) => finish(false, event.error?.stack || event.message));
globalThis.addEventListener("unhandledrejection", (event) => finish(false, event.reason?.stack || event.reason));

// Cornell room: 10 wide × 6 high × 10 deep, open front (+Z). Wall thickness
// 0.3 > voxel size so opposite faces land in different cells (normal
// reliability stays high). NO analytic lights — emissive panel only.
const W = 10;
const H = 6;
const D = 10;
const T = 0.3;
const BOUNDS = {
  min: new THREE.Vector3(-W / 2 - 1, -1, -D / 2 - 1),
  max: new THREE.Vector3(W / 2 + 1, H + 1, D / 2 + 1),
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
const meshes = [];
const addBox = (size, position, color, emissive = 0) => {
  const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
  material.emissive = new THREE.Color(emissive > 0 ? 0xffffff : 0x000000);
  material.emissiveIntensity = emissive;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  scene.add(mesh);
  meshes.push(mesh);
  return mesh;
};
addBox([W, T, D], [0, -T / 2, 0], 0xcccccc); // floor
addBox([W, T, D], [0, H + T / 2, 0], 0xcccccc); // ceiling
addBox([W, H, T], [0, H / 2, -D / 2 - T / 2], 0xcccccc); // back
addBox([T, H, D], [-W / 2 - T / 2, H / 2, 0], 0xc21414); // red left
addBox([T, H, D], [W / 2 + T / 2, H / 2, 0], 0x15a61a); // green right
addBox([1.8, 3.6, 1.8], [-1.6, 1.8, -1.6], 0xcccccc); // tall box
addBox([1.8, 1.8, 1.8], [1.7, 0.9, 0.6], 0xcccccc); // short box
addBox([2.4, 0.1, 2.4], [0, H - 0.06, 0], 0xffffff, 10); // emissive panel

const volume = voxelizeOnce(meshes, BOUNDS, { x: 48, y: 32, z: 48 }, []);
const { cascades } = createRadianceCascades({
  bounds: BOUNDS,
  cascadeCount: 4,
  c0Grid: { x: 24, y: 16, z: 24 },
  c0DirRes: 4,
  t0: 0.8,
  farT: 40,
  sceneTrace: volume.createSceneTrace(),
});
const { mergeComputes } = createCascadeMerge(cascades);
const gather = createIrradianceGather(cascades);
const bounceGain = uniform(1);
const feedback = createBounceFeedback(cascades, volume, bounceGain);

async function main() {
  const canvas = document.getElementById("canvas");
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(canvas.width, canvas.height, false);
  await renderer.init();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2.2;

  const camera = new THREE.PerspectiveCamera(58, canvas.width / canvas.height, 0.1, 100);
  camera.position.set(0, 3.6, 11.5);
  camera.lookAt(0, 2.6, 0);

  // Gather-lit materials (same shading path as Phase 4).
  for (const mesh of meshes) {
    const source = mesh.material;
    const lit = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const albedo = vec3(source.color.r, source.color.g, source.color.b);
    const toCamera = cameraPosition.sub(positionWorld);
    const facing = step(0, normalWorld.dot(toCamera)).mul(2).sub(1);
    const N = normalWorld.mul(facing);
    const emissiveOut = vec3(
      source.emissive.r * source.emissiveIntensity,
      source.emissive.g * source.emissiveIntensity,
      source.emissive.b * source.emissiveIntensity,
    );
    lit.colorNode = albedo.mul(gather(positionWorld.add(N.mul(0.3)), N)).div(Math.PI).add(emissiveOut);
    mesh.material = lit;
  }

  const queue = [feedback];
  for (const cascade of cascades) queue.push(cascade.traceCompute);
  queue.push(...mergeComputes);

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const settle = async (frames) => {
    for (let i = 0; i < frames; i++) renderer.compute(queue);
    await renderer.renderAsync(scene, camera);
  };

  // Bounce OFF first (control): colored walls stay dark, no bleed expected.
  bounceGain.value = 0;
  await settle(4);
  say("cornell bounce=0 (control — walls dark, no bleed)");
  document.documentElement.dataset.shot = "cornell-bounce0";
  await wait(1800);

  // Bounce ON: run enough frames for the feedback series to converge.
  bounceGain.value = 1;
  await settle(16);
  say("cornell bounce=1 (multi-bounce — red/green bleed must be visible)");
  document.documentElement.dataset.shot = "cornell-bounce1";
  await wait(1800);

  finish(true, `occ=${volume.stats.occupiedCells}`);
}

main().catch((error) => finish(false, error?.stack || String(error)));
