// The sculpt stroke costs O(brush area) per dab, and the O(terrain) work runs
// once per stroke. "Terrain sculpting is freezing" (2026-09-10): every dab used
// to go through the full apply — `pos.setY` over the whole grid, `compute-
// VertexNormals()` over ~525k triangles on a 512 grid, the bounding sphere, a
// full upload, and a re-seat of EVERY scatter layer — dozens of times a second.
//
// Drives the real TerrainComponent on a fake engine (the pattern from
// tests/terrain-attach.test.mjs). No GPU: the upload is asserted through the
// attribute's `updateRanges`, which both backends honour.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";
import { TerrainComponent, heightfieldNormals } from "../src/modules/terrain/TerrainComponent.js";
import { brushWeight } from "../src/editor/brush.js";
import { freeze } from "../src/engine/freezeLedger.js";

const SIZE = 12;
const RES = 8; // step 1.5, 81 vertices
const STEP = SIZE / RES;
const HALF = SIZE / 2;

function makeEngine() {
  const listeners = new Map();
  return {
    entities: new Map(), playing: false, scene: new THREE.Scene(),
    getEntity(id) { return this.entities.get(id); },
    on(name, fn) { const group = listeners.get(name) ?? new Set(); listeners.set(name, group); group.add(fn); return () => group.delete(fn); },
    emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); },
  };
}

/** A terrain, optionally with one entity-backed scatter layer (a box mesh). */
async function makeTerrain({ scatter = false } = {}) {
  const engine = makeEngine();
  const scatterLayers = [];
  if (scatter) {
    const rock = new Entity(engine, { id: "rock", name: "Rock" });
    engine.entities.set(rock.id, rock);
    rock.addComponent(new MeshComponent({ geometry: "box" }));
    scatterLayers.push({
      sourceType: "entity", sourceEntity: "rock",
      instances: [[1, 1], [-2, 2], [3, -3]].map(([x, z]) => ({ position: [x, 0, z], r: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] })),
    });
  }
  const entity = new Entity(engine, { id: "terrain", name: "Terrain" });
  engine.entities.set(entity.id, entity);
  const mesh = entity.addComponent(new MeshComponent({ geometry: "plane" }));
  const terrain = entity.addComponent(new TerrainComponent({ size: SIZE, resolution: RES, splatResolution: 16, scatterLayers }));
  await Promise.resolve();
  assert.equal(terrain.geometry.getAttribute("position").count, (RES + 1) ** 2);
  assert.equal(mesh.mesh.geometry, terrain.geometry);
  return { engine, entity, mesh, terrain };
}

/** Deterministic bumpy heights so normals are non-trivial everywhere, edges included. */
function seedHeights(terrain, seed = 1) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const heights = terrain.heightsArray;
  for (let i = 0; i < heights.length; i++) heights[i] = (random() * 2 - 1) * 2.5;
  // Heights must be in the geometry before a dab reads or compares anything.
  terrain.commitHeights();
}

/** three's own answer for the geometry as it stands, without touching it. */
function referenceNormals(geometry) {
  const clone = geometry.clone();
  clone.computeVertexNormals();
  return clone.getAttribute("normal").array;
}

function assertNormalsMatch(geometry, tolerance = 1e-3) {
  const actual = geometry.getAttribute("normal").array;
  const expected = referenceNormals(geometry);
  assert.equal(actual.length, expected.length);
  let worst = 0;
  for (let i = 0; i < actual.length; i++) worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
  assert.ok(worst < tolerance, `normals differ from computeVertexNormals() by ${worst}`);
  return worst;
}

const vertexXZ = (i) => [-HALF + (i % (RES + 1)) * STEP, -HALF + Math.floor(i / (RES + 1)) * STEP];

test("heightfieldNormals matches computeVertexNormals() exactly, edges and corners included", () => {
  const geometry = new THREE.PlaneGeometry(SIZE, SIZE, RES, RES);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.getAttribute("position");
  const heights = new Float32Array(pos.count);
  let state = 7;
  for (let i = 0; i < heights.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    heights[i] = (state / 4294967296 * 2 - 1) * 3;
    pos.setY(i, heights[i]);
  }
  const out = new Float32Array(pos.count * 3);
  heightfieldNormals(heights, RES, STEP, out);
  const expected = referenceNormals(geometry);
  let worst = 0;
  for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - expected[i]));
  assert.ok(worst < 1e-5, `analytic normals differ from three's by ${worst} (float32 noise is ~1e-7)`);

  // The central-difference approximation is NOT what three computes on a bumpy
  // grid — the exact six-triangle sum is the whole reason the helper exists.
  const cols = RES + 1;
  let centralWorst = 0;
  for (let r = 1; r < RES; r++) for (let c = 1; c < RES; c++) {
    const i = r * cols + c;
    const n = new THREE.Vector3(
      -(heights[i + 1] - heights[i - 1]) / (2 * STEP), 1, -(heights[i + cols] - heights[i - cols]) / (2 * STEP),
    ).normalize();
    centralWorst = Math.max(centralWorst, Math.abs(n.x - expected[i * 3]), Math.abs(n.z - expected[i * 3 + 2]));
  }
  assert.ok(centralWorst > 1e-2, `central differences would have passed (${centralWorst}); the fixture is too smooth`);

  // A rectangle writes only its rectangle.
  const partial = new Float32Array(pos.count * 3).fill(9);
  heightfieldNormals(heights, RES, STEP, partial, 2, 4, 3, 5);
  for (let i = 0; i < pos.count; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const inside = r >= 2 && r <= 4 && c >= 3 && c <= 5;
    for (let k = 0; k < 3; k++) {
      if (inside) assert.ok(Math.abs(partial[i * 3 + k] - expected[i * 3 + k]) < 1e-5);
      else assert.equal(partial[i * 3 + k], 9, `vertex ${i} outside the rectangle was written`);
    }
  }
});

test("a dab moves only the vertices under the brush and uploads only their rows", async () => {
  const { terrain } = await makeTerrain();
  const pos = terrain.geometry.getAttribute("position");
  const nrm = terrain.geometry.getAttribute("normal");
  const before = Float32Array.from(pos.array);
  pos.clearUpdateRanges();
  nrm.clearUpdateRanges();
  const posVersion = pos.version, nrmVersion = nrm.version; // rotateX + the attach's full apply already bumped them
  const radius = 2;
  terrain.applyHeightBrush(new THREE.Vector3(0, 0, 0), { tool: "raise", radius, strength: 1, hardness: 0.5 });

  let moved = 0;
  for (let i = 0; i < pos.count; i++) {
    const [x, z] = vertexXZ(i);
    const dist = Math.hypot(x, z);
    assert.equal(pos.getX(i), before[i * 3]);
    assert.equal(pos.getZ(i), before[i * 3 + 2]);
    assert.equal(pos.getY(i), terrain.heightsArray[i], "geometry Y mirrors the live heights buffer");
    if (dist < radius) {
      assert.ok(pos.getY(i) > 0, `vertex ${i} at distance ${dist} should have been raised`);
      moved++;
    } else {
      assert.equal(pos.getY(i), before[i * 3 + 1], `vertex ${i} at distance ${dist} is outside the brush and moved`);
    }
  }
  assert.equal(moved, 5, "the centre and its four axis neighbours are the only vertices inside radius 2");

  // The brush box is rows/cols 2..6 (floor((0-2+6)/1.5) .. ceil((0+2+6)/1.5));
  // positions upload those rows, normals one ring further (1..7).
  const cols = RES + 1;
  assert.deepEqual(pos.updateRanges, [{ start: 2 * cols * 3, count: 5 * cols * 3 }]);
  assert.deepEqual(nrm.updateRanges, [{ start: 1 * cols * 3, count: 7 * cols * 3 }]);
  assert.equal(pos.version, posVersion + 1);
  assert.equal(nrm.version, nrmVersion + 1);

  // Mid-stroke normals are already exact, not an approximation to be fixed at
  // pointerup — otherwise the surface pops when the stroke ends.
  assertNormalsMatch(terrain.geometry);

  // A dab wholly off the grid touches nothing and uploads nothing.
  terrain.applyHeightBrush(new THREE.Vector3(500, 0, 500), { tool: "raise", radius, strength: 1 });
  assert.equal(pos.version, posVersion + 1);
  assert.equal(pos.updateRanges.length, 1);
});

test("after commitHeights the normals equal computeVertexNormals() within 1e-3", async () => {
  const { terrain } = await makeTerrain();
  seedHeights(terrain, 3);
  assertNormalsMatch(terrain.geometry);
  const dabs = [
    [[1.2, 0, -0.7], { tool: "raise", radius: 3, strength: 0.8, hardness: 0.3 }],
    [[-2, 0, 2], { tool: "noise", radius: 4, strength: 1, seed: 3 }],
    [[-6, 0, -6], { tool: "lower", radius: 3, strength: 1 }], // a corner: one-sided faces
    [[6, 0, 0], { tool: "sharpen", radius: 2.5, strength: 1 }], // an edge
    [[0, 0, 0], { tool: "smooth", radius: 5, strength: 1 }],
    [[2, 0, 3], { tool: "erode", radius: 3, strength: 0.7 }],
    [[-3, 0, -1], { tool: "flatten", radius: 3, strength: 0.6, flattenHeight: 1 }],
    [[1, 0, 1], { tool: "pinch", radius: 3, strength: 0.5 }],
    [[-1, 0, 4], { tool: "contrast", radius: 3, strength: 0.4 }],
  ];
  for (const [[x, y, z], opts] of dabs) {
    terrain.applyHeightBrush(new THREE.Vector3(x, y, z), opts);
    assertNormalsMatch(terrain.geometry); // exact mid-stroke, every tool
  }
  terrain.commitHeights();
  const worst = assertNormalsMatch(terrain.geometry);
  assert.ok(worst < 1e-5, `commit normals are the exact ones (${worst})`);
  const pos = terrain.geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i++) assert.equal(pos.getY(i), terrain.heightsArray[i]);
  assert.equal(pos.updateRanges.length, 0, "the commit is a whole-buffer upload");
  assert.equal(terrain.geometry.getAttribute("normal").updateRanges.length, 0);

  // The committed string round-trips to the same surface.
  const encoded = terrain.props.heights;
  assert.ok(encoded.length > 0);
  terrain.setProp("heights", "");
  assert.equal(terrain.heightAtLocal(0, 0), 0);
  terrain.setProp("heights", encoded);
  for (let i = 0; i < pos.count; i++) assert.equal(pos.getY(i), terrain.heightsArray[i]);
  assertNormalsMatch(terrain.geometry);
});

test("the neighbour-reading tools see the same snapshot the full copy gave them", async () => {
  const { terrain } = await makeTerrain();
  seedHeights(terrain, 11);
  const cols = RES + 1;
  const src = Float32Array.from(terrain.heightsArray); // the old full `heights.slice()`
  const centre = new THREE.Vector3(0.4, 0, -0.9);
  const radius = 3.2, strength = 0.9, hardness = 0.5;
  terrain.applyHeightBrush(centre, { tool: "smooth", radius, strength, hardness });
  for (let i = 0; i < src.length; i++) {
    const [x, z] = vertexXZ(i);
    const dist = Math.hypot(x - centre.x, z - centre.z);
    let expected = src[i];
    if (dist <= radius) {
      const r = Math.floor(i / cols), c = i % cols;
      let sum = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr > RES || cc < 0 || cc > RES) continue;
        sum += src[rr * cols + cc];
        n++;
      }
      const amt = strength * brushWeight(dist / radius, { curve: null, hardness });
      expected = src[i] + (sum / n - src[i]) * Math.min(1, amt);
    }
    assert.ok(Math.abs(terrain.heightsArray[i] - expected) < 1e-6, `vertex ${i}: ${terrain.heightsArray[i]} vs ${expected}`);
  }
});

test("a dab never re-seats the scatter layers; the commit does, once", async () => {
  const { terrain } = await makeTerrain({ scatter: true });
  assert.equal(terrain.scatterSources[0].length, 1, "the box mesh is the layer's one source");
  const original = terrain.scatterPlacementMatrix;
  let placements = 0;
  terrain.scatterPlacementMatrix = function (...args) { placements++; return original.apply(this, args); };
  const spans = [];
  const begin = freeze.begin;
  freeze.begin = function (name) { spans.push(name); return begin.call(this, name); };
  try {
    const bounding = terrain.geometry.boundingSphere.radius;
    for (let k = 0; k < 6; k++) {
      terrain.applyHeightBrush(new THREE.Vector3(1 + k * 0.3, 0, 1), { tool: "raise", radius: 2.5, strength: 1 });
    }
    assert.equal(placements, 0, "six dabs re-seated no scatter instance");
    assert.deepEqual([...new Set(spans)], ["terrain:brush"]);
    assert.ok(terrain.geometry.boundingSphere.radius >= bounding, "the sphere only grows mid-stroke");

    spans.length = 0;
    terrain.commitHeights();
    assert.equal(placements, 3, "the commit re-seated each of the three instances exactly once");
    assert.deepEqual(spans, ["terrain:stroke-commit", "terrain:scatter"]);
    const seated = terrain.scatterSources[0][0].mesh;
    const m = new THREE.Matrix4();
    seated.getMatrixAt(0, m);
    const y = new THREE.Vector3().setFromMatrixPosition(m).y;
    assert.ok(Math.abs(y - terrain.heightAtLocal(1, 1)) < 1e-5, "an instance sits on the sculpted surface");

    // The editor follows the commit with SetTerrainHeightsCommand.do(), i.e.
    // setProp("heights", <the committed string>): that must not repeat the
    // decode and the full pass the commit just did.
    const live = terrain.heightsArray;
    terrain.setProp("heights", terrain.props.heights);
    assert.equal(placements, 3, "echoing the committed string re-seated nothing");
    assert.equal(terrain.heightsArray, live, "and did not replace the live buffer");

    // Undo carries a different string and takes the full path.
    terrain.setProp("heights", "");
    assert.equal(placements, 6, "undo re-seated every instance");
    assert.equal(terrain.heightAtLocal(1, 1), 0);
    assertNormalsMatch(terrain.geometry);
  } finally {
    freeze.begin = begin;
    terrain.scatterPlacementMatrix = original;
  }
  assert.equal(freeze._stackName.length, 0, "every span was closed");
});
