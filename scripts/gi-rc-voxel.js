// RC PHASE 3 — cascades over a real, single-bake voxel grid.
//
// Same cascade trace + same-frame merge as Phases 1-2 (identical module
// code), but the ray medium is now actual scene meshes voxelized ONCE at
// load (src/modules/gi/voxelizeOnce.js) instead of the analytic room. If
// anything looks wrong here that looked right in Phase 2, the bug is in the
// voxel medium — the transport is already visually proven.
//
// The room is deliberately 24m long — the prior (deleted) GI attempt had a
// never-root-caused "near-zero indirect bounce beyond ~10m" symptom, so this
// scene puts the only light at one end and probes >15m away: the far half of
// the room must visibly receive light through the coarse cascades.
import * as THREE from "three/webgpu";
import { cameraPosition, instanceIndex, normalWorld, positionLocal, positionWorld, step, vec3 } from "three/tsl";
import { createRadianceCascades } from "/src/modules/gi/cascadeTrace.js";
import { createCascadeMerge } from "/src/modules/gi/cascadeMerge.js";
import { createIrradianceGather } from "/src/modules/gi/cascadeGather.js";
import { voxelizeOnce } from "/src/modules/gi/voxelizeOnce.js";

const result = document.getElementById("result");
const say = (text) => {
  if (result) result.textContent = text;
  console.log(`RC-VOXEL ${text.replaceAll("\n", " ")}`);
};
const finish = (ok, details) => {
  say(`${ok ? "PASS" : "FAIL"}\n${details}`);
  document.documentElement.dataset.done = "true";
};
globalThis.addEventListener("error", (event) => finish(false, event.error?.stack || event.message));
globalThis.addEventListener("unhandledrejection", (event) => finish(false, event.reason?.stack || event.reason));

// ---------------------------------------------------------------------------
// Scene: sealed 24 x 6 x 12 room. Emissive panel high on the -X end wall,
// red accent wall at -X, green wall at +X (>20m from the light), occluder
// column at x = -4.
// ---------------------------------------------------------------------------
const L = { x: 24, y: 6, z: 12 };
const BOUNDS = {
  min: new THREE.Vector3(-L.x / 2, 0, -L.z / 2),
  max: new THREE.Vector3(L.x / 2, L.y, L.z / 2),
};
const WALL_T = 0.3;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);

const meshes = [];
const addBox = (size, position, color, emissive = 0, emissiveColor = 0xffffff) => {
  // DoubleSide: the room is sealed, so the verification cameras sit INSIDE
  // it and must see the walls' interior faces.
  const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
  // voxelizeOnce reads .emissive/.emissiveIntensity — MeshBasicMaterial has
  // neither, so stash them on plainly (duck-typed, same fields Standard has).
  material.emissive = new THREE.Color(emissive > 0 ? emissiveColor : 0x000000);
  material.emissiveIntensity = emissive;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  scene.add(mesh);
  meshes.push(mesh);
  return mesh;
};

// Shell (walls face inward; boxes centered on the boundary planes).
addBox([L.x, WALL_T, L.z], [0, -WALL_T / 2, 0], 0xbfbfbf); // floor
addBox([L.x, WALL_T, L.z], [0, L.y + WALL_T / 2, 0], 0xbfbfbf); // ceiling
addBox([WALL_T, L.y, L.z], [-L.x / 2 - WALL_T / 2, L.y / 2, 0], 0xc21414); // -X red
addBox([WALL_T, L.y, L.z], [L.x / 2 + WALL_T / 2, L.y / 2, 0], 0x15a61a); // +X green
addBox([L.x, L.y, WALL_T], [0, L.y / 2, -L.z / 2 - WALL_T / 2], 0xbfbfbf); // -Z
addBox([L.x, L.y, WALL_T], [0, L.y / 2, L.z / 2 + WALL_T / 2], 0xbfbfbf); // +Z
// Occluder column near the light end.
addBox([1.2, 4.5, 1.2], [-4, 2.25, -1], 0xb3b3b8);
// Emissive panel: high on the -X end, just inside the red wall.
const LIGHT_POS = new THREE.Vector3(-L.x / 2 + 0.6, L.y - 0.8, 0);
addBox([0.15, 1.6, 2.4], [LIGHT_POS.x, LIGHT_POS.y, LIGHT_POS.z], 0xffffff, 10);

// ---------------------------------------------------------------------------
// Voxelize once + build the cascade stack over it.
// ---------------------------------------------------------------------------
const VOXEL_RES = { x: 96, y: 24, z: 48 }; // 0.25m cells
const bakeStart = performance.now();
const volume = voxelizeOnce(meshes, BOUNDS, VOXEL_RES, {
  position: LIGHT_POS.clone().add(new THREE.Vector3(0.6, 0, 0)), // just off the panel face
  color: new THREE.Color(1, 0.95, 0.85),
  intensity: 30,
});
const bakeMs = performance.now() - bakeStart;

const { cascades } = createRadianceCascades({
  bounds: BOUNDS,
  cascadeCount: 5,
  c0Grid: { x: 32, y: 8, z: 16 },
  // 16 dirs at c0: enough angular support for the Phase 4 cosine gather
  // (4 dirs would band hard against surface normals).
  c0DirRes: 4,
  t0: 1.0,
  farT: 60,
  sceneTrace: volume.createSceneTrace(),
});
const { mergeComputes } = createCascadeMerge(cascades);
const gatherIrradiance = createIrradianceGather(cascades);

// ---------------------------------------------------------------------------
// Render + screenshots: merged c0 from two angles (light end / far end).
// ---------------------------------------------------------------------------
async function main() {
  const canvas = document.getElementById("canvas");
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(canvas.width, canvas.height, false);
  await renderer.init();

  const camera = new THREE.PerspectiveCamera(70, canvas.width / canvas.height, 0.1, 200);

  const makeGizmos = (cascade, buffer) => {
    const spacing = (BOUNDS.max.x - BOUNDS.min.x) / cascade.grid.x;
    const geometry = new THREE.SphereGeometry(spacing * 0.09, 10, 8);
    const material = new THREE.MeshBasicNodeMaterial();
    material.positionNode = positionLocal.add(cascade.probePositionOf(instanceIndex.toFloat()));
    const raw = buffer.element(instanceIndex).mul(10);
    material.colorNode = raw.div(raw.add(1));
    const mesh = new THREE.InstancedMesh(geometry, material, cascade.probeCount);
    mesh.frustumCulled = false;
    mesh.visible = false;
    const identity = new THREE.Matrix4();
    const array = mesh.instanceMatrix.array;
    for (let i = 0; i < mesh.count; i++) array.set(identity.elements, i * 16);
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    return mesh;
  };
  const rawC0 = makeGizmos(cascades[0], cascades[0].averages);
  const mergedC0 = makeGizmos(cascades[0], cascades[0].mergedAverages);
  const mergedC1 = makeGizmos(cascades[1], cascades[1].mergedAverages);

  const queue = [];
  for (const cascade of cascades) queue.push(cascade.traceCompute);
  for (const cascade of cascades) queue.push(cascade.averageCompute);
  queue.push(...mergeComputes);
  const computeStart = performance.now();
  renderer.compute(queue);
  const computeMs = performance.now() - computeStart;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const showOnly = (mesh) => {
    for (const m of [rawC0, mergedC0, mergedC1]) m.visible = m === mesh;
  };
  // All camera positions are INSIDE the sealed room.
  const views = [
    {
      mesh: mergedC0,
      label: "merged c0, light end",
      shot: "phase3-light-end",
      pos: [-1, 3.5, 5],
      look: [-11, 2.5, -2],
    },
    {
      mesh: mergedC0,
      label: "merged c0, FAR end (>15m from light)",
      shot: "phase3-far-end",
      pos: [1, 3.5, 5],
      look: [11, 2.5, -2],
    },
    {
      mesh: rawC0,
      label: "raw c0, far end (contrast reference)",
      shot: "phase3-far-end-raw",
      pos: [1, 3.5, 5],
      look: [11, 2.5, -2],
    },
    {
      mesh: mergedC1,
      label: "merged c1, whole room",
      shot: "phase3-c1-overview",
      pos: [0, 5.2, 5.2],
      look: [0, 0.5, -2],
    },
  ];
  for (const view of views) {
    showOnly(view.mesh);
    camera.position.set(...view.pos);
    camera.lookAt(...view.look);
    say(
      `phase3 ${view.label} | bake ${bakeMs.toFixed(0)}ms submit ${computeMs.toFixed(1)}ms | ` +
        `tris ${volume.stats.triangles} occ ${volume.stats.occupiedCells} lit ${volume.stats.litCells}`,
    );
    await renderer.renderAsync(scene, camera);
    document.documentElement.dataset.shot = view.shot;
    // The runner's poll + screenshot can take >1s; keep this view on screen
    // long enough that the capture can't race into the next view.
    await wait(1800);
  }

  // -------------------------------------------------------------------------
  // PHASE 4 — the meshes themselves shaded by the gather (no G-buffer, no
  // deferred resolve: positionWorld/normalWorld straight into the material).
  // The gather call here is the same createIrradianceGather() function any
  // future screen-space path must reuse.
  // -------------------------------------------------------------------------
  showOnly(null);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2.0;
  for (const mesh of meshes) {
    const source = mesh.material;
    const lit = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const albedo = vec3(source.color.r, source.color.g, source.color.b);
    // Interior faces are backfaces of outward-normal boxes: face-forward the
    // normal toward the camera so the gather integrates the correct
    // hemisphere on both sides.
    const toCamera = cameraPosition.sub(positionWorld);
    const facing = step(0, normalWorld.dot(toCamera)).mul(2).sub(1);
    const N = normalWorld.mul(facing);
    const emissiveOut = vec3(
      source.emissive.r * source.emissiveIntensity,
      source.emissive.g * source.emissiveIntensity,
      source.emissive.b * source.emissiveIntensity,
    );
    // Normal-offset the sample point (plan §3.2 leak-control step (a)): half
    // a voxel off the surface so the receiver's own wall voxels don't
    // dominate the visibility/trilinear footprint.
    const samplePoint = positionWorld.add(N.mul(0.35));
    lit.colorNode = albedo.mul(gatherIrradiance(samplePoint, N)).div(Math.PI).add(emissiveOut);
    mesh.userData.contextMaterial = source;
    mesh.material = lit;
  }

  const litViews = [
    { label: "LIT render, light end", shot: "phase4-lit-light-end", pos: [-1, 3.5, 5], look: [-11, 2.5, -2] },
    { label: "LIT render, FAR end (>15m)", shot: "phase4-lit-far-end", pos: [1, 3.5, 5], look: [11, 2.5, -2] },
    {
      label: "LIT render, FAR end at +8 exposure (transport ≠ zero check)",
      shot: "phase4-lit-far-end-exposed",
      pos: [1, 3.5, 5],
      look: [11, 2.5, -2],
      exposure: 8,
    },
    { label: "LIT render + c0 probes A/B", shot: "phase4-lit-probes", pos: [-1, 3.5, 5], look: [-11, 2.5, -2] },
  ];
  for (const view of litViews) {
    if (view.shot === "phase4-lit-probes") mergedC0.visible = true;
    renderer.toneMappingExposure = view.exposure ?? 2.0;
    camera.position.set(...view.pos);
    camera.lookAt(...view.look);
    say(`phase4 ${view.label}`);
    await renderer.renderAsync(scene, camera);
    document.documentElement.dataset.shot = view.shot;
    await wait(1800);
  }
  mergedC0.visible = false;

  // -------------------------------------------------------------------------
  // PHASE 5 — dynamics via re-bake-on-change: an emissive box moves across
  // the room; each move triggers ONE full CPU re-bake into the same GPU
  // buffer + a fresh cascade pass. The orange glow must follow the box.
  // -------------------------------------------------------------------------
  renderer.toneMappingExposure = 2.0;
  const moverMaterial = new THREE.MeshBasicNodeMaterial();
  moverMaterial.colorNode = vec3(1, 0.55, 0.15).mul(4);
  moverMaterial.emissive = new THREE.Color(1, 0.55, 0.15);
  moverMaterial.emissiveIntensity = 15;
  moverMaterial.color = new THREE.Color(0, 0, 0);
  const mover = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), moverMaterial);
  scene.add(mover);
  meshes.push(mover);

  const moverStops = [-6, 0, 6];
  for (let i = 0; i < moverStops.length; i++) {
    mover.position.set(moverStops[i], 1.2, -1);
    const rebakeStart = performance.now();
    volume.rebake(meshes, {
      position: LIGHT_POS.clone().add(new THREE.Vector3(0.6, 0, 0)),
      color: new THREE.Color(1, 0.95, 0.85),
      intensity: 30,
    });
    const rebakeMs = performance.now() - rebakeStart;
    renderer.compute(queue);
    camera.position.set(moverStops[i] * 0.5, 4, 5.3);
    camera.lookAt(moverStops[i] * 0.7, 1, -4);
    say(`phase5 emissive mover at x=${moverStops[i]} | rebake ${rebakeMs.toFixed(0)}ms`);
    await renderer.renderAsync(scene, camera);
    document.documentElement.dataset.shot = `phase5-move-${i}`;
    await wait(1800);
  }

  finish(true, `bake=${bakeMs.toFixed(0)}ms occupied=${volume.stats.occupiedCells} lit=${volume.stats.litCells}`);
}

main().catch((error) => finish(false, error?.stack || String(error)));
