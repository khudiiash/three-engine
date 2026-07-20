// RC SPIKE — Phases 0-1: analytic scene + full cascade hierarchy (trace only).
//
// Phase 0 proved: compute dispatch + probe grid + instanced gizmos work
// (single grid, shared direction set). Phase 1 (this version) builds the
// real cascade hierarchy via src/modules/gi/cascadeTrace.js: probe spacing
// ×2 / directions ×4 / interval ×2 per cascade, one thread per ray.
// NO merge yet — each cascade's gizmos show only its OWN interval radiance,
// so c0 should look near-black except right next to emitters (its rays are
// short), while coarser cascades pick up the room's far field. That
// contrast is the point of the visual; Phase 2's merge folds them together.
//
// Verified by LOOKING at headed-Chrome screenshots (gi-diag-phase1-c*.png),
// never by a printed pass/fail alone.
import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  float,
  int,
  instanceIndex,
  max,
  min,
  positionLocal,
  vec3,
} from "three/tsl";
import { createRadianceCascades } from "/src/modules/gi/cascadeTrace.js";
import { createCascadeMerge } from "/src/modules/gi/cascadeMerge.js";

const result = document.getElementById("result");
const say = (text) => {
  if (result) result.textContent = text;
  console.log(`RC-SPIKE ${text.replaceAll("\n", " ")}`);
};
const finish = (ok, details) => {
  say(`${ok ? "PASS" : "FAIL"}\n${details}`);
  document.documentElement.dataset.done = "true";
};
globalThis.addEventListener("error", (event) => finish(false, event.error?.stack || event.message));
globalThis.addEventListener("unhandledrejection", (event) => finish(false, event.reason?.stack || event.reason));

// ---------------------------------------------------------------------------
// Analytic test room (Phase 0-2 scene): 10x6x10, open +Z front, red left
// wall, green right wall, occluder box, emissive ceiling panel.
// ---------------------------------------------------------------------------
const ROOM = { halfX: 5, halfZ: 5, floorY: 0, ceilY: 6 };
const LIGHT = { halfX: 1, halfZ: 1, intensity: 6 };
const OCCLUDER = { center: new THREE.Vector3(-1.6, 1.6, -0.8), half: new THREE.Vector3(1.0, 1.6, 1.0) };
const ALBEDO = {
  floor: vec3(0.75, 0.75, 0.75),
  ceiling: vec3(0.75, 0.75, 0.75),
  back: vec3(0.75, 0.75, 0.75),
  left: vec3(0.75, 0.08, 0.08),
  right: vec3(0.08, 0.65, 0.1),
  occluder: vec3(0.7, 0.7, 0.72),
};

// Face ids: 0=-X(red) 1=+X(green) 2=floor 3=ceiling 4=back(-Z) 5=open front(+Z) 6=occluder
function traceRoom(origin, dir) {
  const bestT = float(1e6).toVar();
  const faceId = int(-1).toVar();
  const consider = (id, t, validCond) => {
    If(validCond.and(t.greaterThan(1e-4)).and(t.lessThan(bestT)), () => {
      bestT.assign(t);
      faceId.assign(int(id));
    });
  };
  consider(0, float(-ROOM.halfX).sub(origin.x).div(dir.x), dir.x.lessThan(-1e-6));
  consider(1, float(ROOM.halfX).sub(origin.x).div(dir.x), dir.x.greaterThan(1e-6));
  consider(2, float(ROOM.floorY).sub(origin.y).div(dir.y), dir.y.lessThan(-1e-6));
  consider(3, float(ROOM.ceilY).sub(origin.y).div(dir.y), dir.y.greaterThan(1e-6));
  consider(4, float(-ROOM.halfZ).sub(origin.z).div(dir.z), dir.z.lessThan(-1e-6));
  consider(5, float(ROOM.halfZ).sub(origin.z).div(dir.z), dir.z.greaterThan(1e-6));

  const oMin = OCCLUDER.center.clone().sub(OCCLUDER.half);
  const oMax = OCCLUDER.center.clone().add(OCCLUDER.half);
  const invX = float(1).div(dir.x);
  const invY = float(1).div(dir.y);
  const invZ = float(1).div(dir.z);
  const tx1 = float(oMin.x).sub(origin.x).mul(invX);
  const tx2 = float(oMax.x).sub(origin.x).mul(invX);
  const ty1 = float(oMin.y).sub(origin.y).mul(invY);
  const ty2 = float(oMax.y).sub(origin.y).mul(invY);
  const tz1 = float(oMin.z).sub(origin.z).mul(invZ);
  const tz2 = float(oMax.z).sub(origin.z).mul(invZ);
  const tNear = max(max(min(tx1, tx2), min(ty1, ty2)), min(tz1, tz2)).toVar();
  const tFar = min(min(max(tx1, tx2), max(ty1, ty2)), max(tz1, tz2)).toVar();
  If(tNear.lessThan(tFar).and(tFar.greaterThan(0)).and(tNear.lessThan(bestT)), () => {
    If(tNear.greaterThan(1e-4), () => {
      bestT.assign(tNear);
      faceId.assign(int(6));
    }).Else(() => {
      bestT.assign(float(0.001));
      faceId.assign(int(6));
    });
  });

  return { bestT, faceId };
}

function shadeHit(origin, dir, bestT, faceId) {
  const out = vec3(0).toVar();
  const hitPos = origin.add(dir.mul(bestT)).toVar();

  const directLight = (pos, normal) => {
    const lightCenter = vec3(0, ROOM.ceilY - 0.05, 0);
    const toLight = lightCenter.sub(pos).toVar();
    const dist = toLight.length().toVar();
    const lightDir = toLight.div(dist).toVar();
    const ndotl = normal.dot(lightDir).max(0).toVar();
    const contribution = vec3(0).toVar();
    If(ndotl.greaterThan(0), () => {
      const shadowOrigin = pos.add(normal.mul(1e-3));
      const shadow = traceRoom(shadowOrigin, lightDir);
      If(shadow.bestT.greaterThan(dist.sub(0.02)), () => {
        const atten = float(1).div(max(dist.mul(dist), 1));
        contribution.assign(vec3(1).mul(LIGHT.intensity).mul(atten).mul(ndotl));
      });
    });
    return contribution;
  };

  If(faceId.equal(int(5)).or(faceId.equal(int(-1))), () => {
    out.assign(vec3(0));
  })
    .ElseIf(faceId.equal(int(3)), () => {
      const inPanel = hitPos.x.abs().lessThan(LIGHT.halfX).and(hitPos.z.abs().lessThan(LIGHT.halfZ));
      If(inPanel, () => {
        out.assign(vec3(1).mul(LIGHT.intensity));
      }).Else(() => {
        out.assign(ALBEDO.ceiling.mul(directLight(hitPos, vec3(0, -1, 0))));
      });
    })
    .ElseIf(faceId.equal(int(2)), () => {
      out.assign(ALBEDO.floor.mul(directLight(hitPos, vec3(0, 1, 0))));
    })
    .ElseIf(faceId.equal(int(0)), () => {
      out.assign(ALBEDO.left.mul(directLight(hitPos, vec3(1, 0, 0))));
    })
    .ElseIf(faceId.equal(int(1)), () => {
      out.assign(ALBEDO.right.mul(directLight(hitPos, vec3(-1, 0, 0))));
    })
    .ElseIf(faceId.equal(int(4)), () => {
      out.assign(ALBEDO.back.mul(directLight(hitPos, vec3(0, 0, 1))));
    })
    .ElseIf(faceId.equal(int(6)), () => {
      out.assign(ALBEDO.occluder.mul(0.15));
    });

  return out;
}

// Adapter to the cascade builder's sceneTrace contract: t < 0 means miss.
// The open front face (id 5) and true no-hit are the only "miss" cases.
const sceneTrace = (origin, dir) => {
  const { bestT, faceId } = traceRoom(origin, dir);
  const rad = shadeHit(origin, dir, bestT, faceId);
  const isMiss = faceId.equal(int(5)).or(faceId.equal(int(-1)));
  const t = bestT.toVar();
  If(isMiss, () => {
    t.assign(-1);
  });
  return { rad, t };
};

// ---------------------------------------------------------------------------
// Cascade hierarchy: c0 16x8x16 × 4 dirs, 4 cascades.
//   rays: c0 8192, c1 4096, c2 2048, c3 1024 → 15360 total.
// ---------------------------------------------------------------------------
const BOUNDS = {
  min: new THREE.Vector3(-ROOM.halfX, ROOM.floorY, -ROOM.halfZ),
  max: new THREE.Vector3(ROOM.halfX, ROOM.ceilY, ROOM.halfZ),
};
const { cascades } = createRadianceCascades({
  bounds: BOUNDS,
  cascadeCount: 4,
  c0Grid: { x: 16, y: 8, z: 16 },
  c0DirRes: 2,
  t0: 0.7,
  farT: 100,
  sceneTrace,
});
// Phase 2: same-frame merge, coarse → fine, black sky (open front stays dark).
const { mergeComputes } = createCascadeMerge(cascades);

// ---------------------------------------------------------------------------
// Render + per-cascade screenshot cycle
// ---------------------------------------------------------------------------
async function main() {
  const canvas = document.getElementById("canvas");
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(canvas.width, canvas.height, false);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070a);
  const camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 100);
  camera.position.set(0, 3.2, 12.5);
  camera.lookAt(0, 2.8, 0);

  const addSlab = (size, position, color) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ color }));
    mesh.position.set(...position);
    scene.add(mesh);
    return mesh;
  };
  const wallT = 0.1;
  addSlab([ROOM.halfX * 2, wallT, ROOM.halfZ * 2], [0, ROOM.floorY - wallT / 2, 0], 0xbfbfbf);
  addSlab([ROOM.halfX * 2, wallT, ROOM.halfZ * 2], [0, ROOM.ceilY + wallT / 2, 0], 0xbfbfbf);
  addSlab([wallT, ROOM.ceilY, ROOM.halfZ * 2], [-ROOM.halfX - wallT / 2, ROOM.ceilY / 2, 0], 0xc21414);
  addSlab([wallT, ROOM.ceilY, ROOM.halfZ * 2], [ROOM.halfX + wallT / 2, ROOM.ceilY / 2, 0], 0x15a61a);
  addSlab([ROOM.halfX * 2, ROOM.ceilY, wallT], [0, ROOM.ceilY / 2, -ROOM.halfZ - wallT / 2], 0xbfbfbf);
  addSlab(
    [OCCLUDER.half.x * 2, OCCLUDER.half.y * 2, OCCLUDER.half.z * 2],
    [OCCLUDER.center.x, OCCLUDER.center.y, OCCLUDER.center.z],
    0xb3b3b8,
  );
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(LIGHT.halfX * 2, 0.05, LIGHT.halfZ * 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  panel.position.set(0, ROOM.ceilY - 0.03, 0);
  scene.add(panel);

  // Gizmo InstancedMeshes: per cascade, one mesh showing the RAW own-interval
  // average and one showing the MERGED average — the Phase 2 visual is their
  // difference (merged c0 must inherit the whole room's light field).
  const makeGizmos = (cascade, buffer) => {
    const spacing = (BOUNDS.max.x - BOUNDS.min.x) / cascade.grid.x;
    const geometry = new THREE.SphereGeometry(spacing * 0.22, 10, 8);
    const material = new THREE.MeshBasicNodeMaterial();
    material.positionNode = positionLocal.add(cascade.probePositionOf(instanceIndex.toFloat()));
    const raw = buffer.element(instanceIndex).mul(8);
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
  const rawGizmos = cascades.map((c) => makeGizmos(c, c.averages));
  const mergedGizmos = cascades.map((c) => makeGizmos(c, c.mergedAverages));

  // One batched submit: all traces, raw averages, then merges coarse→fine
  // (createCascadeMerge returns them pre-ordered, averaging included).
  const queue = [];
  for (const cascade of cascades) queue.push(cascade.traceCompute);
  for (const cascade of cascades) queue.push(cascade.averageCompute);
  queue.push(...mergeComputes);
  renderer.compute(queue);

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const showOnly = (mesh) => {
    for (const m of [...rawGizmos, ...mergedGizmos]) m.visible = m === mesh;
  };
  const shots = [
    { mesh: rawGizmos[0], label: "c0 RAW (own 0.7m interval only)", shot: "phase2-c0-raw" },
    { mesh: mergedGizmos[0], label: "c0 MERGED (full same-frame hierarchy)", shot: "phase2-c0-merged" },
    { mesh: mergedGizmos[1], label: "c1 MERGED", shot: "phase2-c1-merged" },
  ];
  for (const step of shots) {
    showOnly(step.mesh);
    say(`phase2 ${step.label}`);
    await renderer.renderAsync(scene, camera);
    document.documentElement.dataset.shot = step.shot;
    await wait(900);
  }

  finish(true, `cascades=${cascades.length} rays=${cascades.reduce((n, c) => n + c.probeCount * c.dirCount, 0)}`);
}

main().catch((error) => finish(false, error?.stack || String(error)));
