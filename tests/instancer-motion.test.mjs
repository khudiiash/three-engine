import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { InstanceMotion, wrapRange } from "../src/engine/instancerMotion.js";

/**
 * The InstancerComponent's per-frame Motion layer (instancerMotion.js).
 * These pin the three models' semantics — scroll WRAPS over the layout's own
 * bounding box, boids FLOCK and stay in that same box, rotation SPINS in
 * place — plus the two properties everything else leans on: seeded
 * determinism, and a clamped dt so a hitch cannot teleport the flock. There
 * is deliberately NO volume parameter: the layout defines the volume.
 */

/** An InstancedMesh laid out along +Z at z = i. */
function makeMesh(n) {
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
    n,
  );
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    m.makeTranslation(0, 0, i);
    mesh.setMatrixAt(i, m);
  }
  mesh.count = n;
  return mesh;
}

function instancePosition(mesh, i, out = new THREE.Vector3()) {
  return out.setFromMatrixPosition(new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, i * 16));
}

test("wrapRange folds values into [min, max] and a flat axis is left alone", () => {
  assert.equal(wrapRange(6, -5, 5), -4);
  assert.equal(wrapRange(-6, -5, 5), 4);
  assert.equal(wrapRange(5, -5, 5), -5);
  assert.equal(wrapRange(-5, -5, 5), -5, "already inside the range stays put");
  assert.ok(Math.abs(wrapRange(12345, -5, 5)) <= 5, "large values still fold");
  assert.equal(wrapRange(3, 2, 2), 3, "no extent → no wrapping");
});

test("scroll wraps over the LAYOUT's own bounding box — no volume parameter", () => {
  const mesh = makeMesh(5); // base z = 0..4
  const clock = { t: 0 };
  const motion = new InstanceMotion(mesh, {
    motionMode: "scroll",
    motionDirection: [0, 0, 1],
    motionSpeed: 2,
  }, 0, clock);

  // One second of 60 Hz frames (dt is clamped per frame, so long elapses
  // must be simulated as the frames they would have been).
  for (let i = 0; i < 60; i++) motion.update(1 / 60);
  assert.ok(Math.abs(clock.t - 1) < 1e-9, "the shared clock advanced");

  // Base z = i, +2 after one second, folded back into the layout's own
  // [0, 4] span: leaving +4 re-enters at 0.
  const expected = [2, 3, 0, 1, 2];
  for (let i = 0; i < 5; i++) {
    const p = instancePosition(mesh, i);
    assert.ok(Math.abs(p.z - expected[i]) < 1e-6, `instance ${i}: z ${p.z} ≈ ${expected[i]}`);
    assert.ok(Math.abs(p.x) < 1e-6 && Math.abs(p.y) < 1e-6, "other axes untouched");
  }
});

test("scroll drifts freely along an axis the layout has no extent on", () => {
  const mesh = makeMesh(4); // a line: y span is 0
  const motion = new InstanceMotion(mesh, {
    motionMode: "scroll",
    motionDirection: [0, 1, 0],
    motionSpeed: 2,
  }, 0, { t: 0 });
  for (let i = 0; i < 60; i++) motion.update(1 / 60);
  for (let i = 0; i < 4; i++) {
    const p = instancePosition(mesh, i);
    assert.ok(Math.abs(p.y - 2) < 1e-6, `a flat axis cannot wrap — instance ${i} drifted, not folded`);
  }
});

test("scroll is continuous — two half-second steps land where one second did", () => {
  const a = makeMesh(3);
  const b = makeMesh(3);
  const props = { motionMode: "scroll", motionDirection: [1, 0, 0], motionSpeed: 3 };
  const ma = new InstanceMotion(a, props, 0, { t: 0 });
  const mb = new InstanceMotion(b, props, 0, { t: 0 });
  for (let i = 0; i < 30; i++) ma.update(1 / 60);
  for (let i = 0; i < 30; i++) ma.update(1 / 60);
  for (let i = 0; i < 60; i++) mb.update(1 / 60);
  for (let i = 0; i < 3; i++) {
    assert.ok(instancePosition(a, i).distanceTo(instancePosition(b, i)) < 1e-6,
      "the clock (not the call count) drives the offset");
  }
});

test("rotation spins in place around the axis, lockstep with zero jitter", () => {
  const mesh = makeMesh(4);
  const motion = new InstanceMotion(mesh, {
    motionMode: "rotation",
    motionAxis: [0, 1, 0],
    motionSpeed: 90, // degrees per second
    motionSpinJitter: 0,
  }, 0, { t: 0 });
  for (let i = 0; i < 120; i++) motion.update(1 / 60); // two seconds → 180°

  const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, i * 16);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), q, s);
    assert.ok(Math.abs(p.z - i) < 1e-6, "rotation mode never moves the instance");
    assert.ok(q.angleTo(expected) < 1e-5, `instance ${i} rotated 180° around Y`);
    assert.ok(Math.abs(s.x - 1) < 1e-6, "scale untouched");
  }
});

test("rotation jitter is deterministic per seed and changes speeds, not positions", () => {
  const build = () => {
    const mesh = makeMesh(6);
    const motion = new InstanceMotion(mesh, {
      motionMode: "rotation", motionAxis: [0, 1, 0], motionSpeed: 60, motionSpinJitter: 1,
    }, 7, { t: 0 });
    motion.update(1);
    return mesh;
  };
  const a = build();
  const b = build();
  for (let i = 0; i < 6; i++) {
    const ma = new THREE.Matrix4().fromArray(a.instanceMatrix.array, i * 16);
    const mb = new THREE.Matrix4().fromArray(b.instanceMatrix.array, i * 16);
    assert.ok(ma.equals(mb), `same seed → same spin for instance ${i}`);
    const p = new THREE.Vector3().setFromMatrixPosition(ma);
    assert.ok(Math.abs(p.z - i) < 1e-6, "positions stay on the layout");
  }
});

test("boids are caged in the LAYOUT's bounding box, flat axes thickened by the neighbour radius", () => {
  const mesh = makeMesh(12); // base z = 0..11, x/y flat
  const maxSpeed = 2;
  const nbr = 2;
  const motion = new InstanceMotion(mesh, {
    motionMode: "boids",
    motionSpeed: maxSpeed,
    motionNeighborRadius: nbr,
    motionSeparationRadius: 0.5,
    motionCohesion: 1,
    motionAlignment: 1,
    motionSeparation: 1.5,
  }, 3, { t: 0 });

  const dt = 1 / 60;
  for (let step = 0; step < 600; step++) motion.update(dt); // 10 simulated seconds

  // Derived cage: layout box [0,11] on z, and the flat x/y axes get ±nbr/2.
  const lo = [-1, -1, 0];
  const hi = [1, 1, 11];
  for (let i = 0; i < 12; i++) {
    const p = instancePosition(mesh, i);
    assert.ok(
      p.x >= lo[0] - 1e-6 && p.x <= hi[0] + 1e-6 &&
      p.y >= lo[1] - 1e-6 && p.y <= hi[1] + 1e-6 &&
      p.z >= lo[2] - 1e-6 && p.z <= hi[2] + 1e-6,
      `boid ${i} stayed inside the layout's cage (at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`,
    );
  }
  // …and it actually USED the thickened flat axes — a zero-volume cage would
  // have pinned every boid to x = y = 0.
  let offPlane = 0;
  for (let i = 0; i < 12; i++) {
    const p = instancePosition(mesh, i);
    if (Math.abs(p.x) > 1e-3 || Math.abs(p.y) > 1e-3) offPlane++;
  }
  assert.ok(offPlane > 0, "the flock spreads into the thickness the flat axes were given");
  const speeds = motion.simVel.reduce((acc, v, idx) => {
    const a = idx / 3 | 0;
    acc[a] = Math.hypot(motion.simVel[a * 3], motion.simVel[a * 3 + 1], motion.simVel[a * 3 + 2]);
    return acc;
  }, []);
  for (const s of speeds) {
    assert.ok(s <= maxSpeed + 1e-6, `speed ${s.toFixed(3)} clamped to max`);
    assert.ok(s >= maxSpeed * 0.35 - 1e-6, `speed ${s.toFixed(3)} above the min — no frozen boids`);
  }
});

test("boids from the same seed produce the same flock", () => {
  const run = () => {
    const mesh = makeMesh(8);
    const motion = new InstanceMotion(mesh, {
      motionMode: "boids", motionSpeed: 2,
    }, 11, { t: 0 });
    for (let step = 0; step < 30; step++) motion.update(1 / 60);
    return [...motion.simPos];
  };
  assert.deepEqual(run(), run(), "seeded streams → identical simulation");
});

test("a huge dt is clamped — a hitch cannot teleport the flock", () => {
  const mesh = makeMesh(4);
  const motion = new InstanceMotion(mesh, {
    motionMode: "boids", motionSpeed: 2,
  }, 0, { t: 0 });
  motion.update(100); // a 100-second freeze frame
  assert.ok(motion.clock.t <= 0.1, "the clamped dt advanced the clock, not the hitch");
  for (let i = 0; i < 4; i++) {
    const p = instancePosition(mesh, i);
    // Base layout was z = i; one clamped tenth of a second at ≤2 u/s cannot
    // move an instance more than a fraction of a unit.
    assert.ok(Math.abs(p.z - i) < 0.5, `instance ${i} barely moved (z ${p.z.toFixed(3)})`);
  }
});
