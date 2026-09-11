import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { ARCHITECTURE_PRESETS, generateArchitecture, normalizeArchitectureSettings } from '../src/modules/architecture/blueprints.js';
import { buildBlockoutGeometry, blockoutBoxes } from '../src/modules/level-design/blockoutGeometry.js';

const pieces = plan => plan.buildings.flatMap(b => b.floors.flatMap(f => f.pieces));
const count = plan => pieces(plan).length;
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
function mesh(p, elevation = 0) {
  const { geometry } = buildBlockoutGeometry(p.shape, { ...p.props, size: p.size });
  const m = new THREE.Mesh(geometry, material);
  m.position.fromArray(p.position); m.position.y += elevation;
  m.rotation.fromArray([...(p.rotation ?? [0, p.rotationY, 0]), 'XYZ']);
  m.updateMatrixWorld(true);
  return m;
}
function hit(m, origin, direction, far = Infinity) {
  return new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction), 0, far).intersectObject(m, false);
}
function downwardAt(m, x, z, y = 1000) { return hit(m, [x, y, z], [0, -1, 0]); }
function dispose(meshes) { for (const m of meshes) m.geometry.dispose(); }

test('all recipes emit finite bounded editable geometry and leave source settings untouched', () => {
  for (const preset of ARCHITECTURE_PRESETS) {
    const input = structuredClone({ preset: preset.id, ...preset.settings });
    const original = JSON.stringify(input), plan = generateArchitecture(input);
    assert.equal(JSON.stringify(input), original);
    assert.ok(count(plan) <= plan.settings.maxPieces, preset.id);
    assert.ok(plan.buildings.length > 0, preset.id);
    for (const p of pieces(plan)) {
      assert.ok(p.position.every(Number.isFinite), `${preset.id} ${p.name}`);
      assert.ok(p.size.every(n => Number.isFinite(n) && n > 0), `${preset.id} ${p.name}`);
      assert.ok(Number.isFinite(p.rotationY));
      assert.ok(['floor', 'wall', 'stair', 'ramp', 'box', 'column', 'platform'].includes(p.shape));
      assert.ok(p.role);
      const m = mesh(p);
      assert.ok(m.geometry.getAttribute('position').count > 0, p.name);
      assert.ok(m.geometry.boundingBox.min.toArray().every(Number.isFinite));
      m.geometry.dispose();
    }
  }
});

test('doors and windows are holes in both the rendered wall and the physics spans', () => {
  for (const preset of ['house', 'apartment', 'warehouse', 'courtyard', 'custom']) {
    const plan = generateArchitecture({ preset }), ground = plan.buildings[0].floors[0];
    const entrance = ground.pieces.find(p => p.name.endsWith(' entrance') && p.props.openings?.some(o => o.sill === 0));
    assert.ok(entrance, `${preset} needs a ground entrance`);
    const walls = ground.pieces.filter(p => p.shape === 'wall');
    for (const wall of walls) {
      const m = mesh(wall), physics = blockoutBoxes(wall.shape, { ...wall.props, size: wall.size });
      for (const opening of wall.props.openings ?? []) {
        const local = new THREE.Vector3(opening.offset, opening.sill + opening.height / 2, 2);
        const origin = m.localToWorld(local), direction = new THREE.Vector3(0, 0, -1).applyQuaternion(m.quaternion);
        assert.equal(new THREE.Raycaster(origin, direction, 0, 4).intersectObject(m).length, 0, `${preset} ${wall.name} blocks an opening`);
        // Runtime box layout is center/size; no solid may cover the same aperture.
        for (const box of physics) {
          const center = box.center;
          assert.ok(Array.isArray(center));
          assert.ok(!(Math.abs(opening.offset - center[0]) < box.size[0] / 2 - 1e-6 && Math.abs(opening.sill + opening.height / 2 - center[1]) < box.size[1] / 2 - 1e-6), 'collider blocks rendered opening');
        }
      }
      m.geometry.dispose();
    }
  }
});

test('small circular facades open several panels when one panel is narrower than the entrance', () => {
  const plan = generateArchitecture({ footprint: 'circle', width: 6, depth: 6, sides: 48, wallThickness: 1, storeys: 1, roof: 'none' });
  const walls = plan.buildings[0].floors[0].pieces.filter(p => p.shape === 'wall').map(p => mesh(p));
  assert.equal(new THREE.Raycaster(new THREE.Vector3(0, 1, -5), new THREE.Vector3(0, 0, 1), 0, 4).intersectObjects(walls, false).length, 0);
  dispose(walls);
});

test('every U stair returns onto the next floor, with a real shaft and at least two metres headroom', () => {
  for (const settings of [{ preset: 'house' }, { preset: 'apartment' }, { preset: 'courtyard' }, { preset: 'custom' }, { footprint: 'l-shape', width: 18, depth: 16, wingWidth: 6, roof: 'flat' }, { footprint: 'circle', width: 16, depth: 16, roof: 'flat' }]) {
    const plan = generateArchitecture(settings), building = plan.buildings[0];
    const all = building.floors.flatMap(f => f.pieces.map(p => mesh(p, f.elevation)));
    let stairFloors = 0;
    for (let i = 0; i < building.floors.length - 1; i++) {
      const floor = building.floors[i], next = building.floors[i + 1];
      const flights = floor.pieces.filter(p => p.shape === 'stair');
      if (!flights.length) continue;
      stairFloors++;
      assert.equal(flights.length, 2);
      const slabs = next.pieces.filter(p => p.role === 'floor' || (p.role === 'roof' && p.shape === 'floor')).map(p => mesh(p, next.elevation));
      const landing = floor.pieces.find(p => p.name === 'Stair half landing');
      assert.ok(landing);
      close(landing.position[1], plan.settings.storeyHeight / 2);
      for (const flight of flights) {
        const m = mesh(flight, floor.elevation);
        const center = m.localToWorld(new THREE.Vector3(0, 0, 0));
        for (const slab of slabs) assert.equal(downwardAt(slab, center.x, center.z).length, 0, `${settings.preset ?? settings.footprint} slab seals the stairwell`);
        // Sample tread centres, not step risers: inspect actual upward collisions.
        for (const progress of [0.2, 0.5, 0.8]) {
          const steps = flight.props.steps, step = Math.min(steps - 1, Math.floor(steps * progress));
          const local = new THREE.Vector3(0, (step + 1) * flight.size[1] / steps + 0.02, -flight.size[2] / 2 + (step + 0.5) * flight.size[2] / steps);
          const origin = m.localToWorld(local);
          const collisions = new THREE.Raycaster(origin, new THREE.Vector3(0, 1, 0), 0, 1.98).intersectObjects(all, false);
          assert.equal(collisions.length, 0, `${settings.preset ?? settings.footprint} low stair ceiling`);
        }
        m.geometry.dispose();
      }
      const last = mesh(flights[1], floor.elevation);
      const exit = last.localToWorld(new THREE.Vector3(0, flights[1].size[1], flights[1].size[2] / 2 + 0.05));
      close(exit.y, next.elevation);
      assert.ok(slabs.some(slab => downwardAt(slab, exit.x, exit.z, exit.y + 0.1).length), 'last tread needs a landing at the next assembly elevation');
      last.geometry.dispose(); dispose(slabs);
    }
    assert.ok(stairFloors > 0, `${settings.preset ?? settings.footprint} has no stairs`);
    dispose(all);
  }
});

test('custom concave footprints preserve the exact outline and upper shaft hole', () => {
  const customFootprint = [[-10, -8], [10, -8], [10, 8], [3, 8], [3, 0], [-3, 0], [-3, 8], [-10, 8]];
  const plan = generateArchitecture({ preset: 'custom', customFootprint, storeys: 3 });
  const building = plan.buildings[0];
  assert.deepEqual(building.footprint, customFootprint);
  const slabs = building.floors.flatMap(f => f.pieces.filter(p => p.shape === 'floor').map(p => mesh(p, f.elevation)));
  for (const slab of slabs) {
    assert.equal(downwardAt(slab, 0, 5).length, 0, 'the concave notch must remain empty');
    assert.ok(downwardAt(slab, 8, 0).length > 0, 'the right wing must retain its floor');
  }
  assert.ok(building.floors[1].pieces.find(p => p.shape === 'floor').props.holes.length);
  dispose(slabs);
});

test('courtyards remain open through floors, foundation and roof', () => {
  const plan = generateArchitecture({ preset: 'courtyard' });
  const slabs = plan.buildings[0].floors.flatMap(f => f.pieces.filter(p => p.shape === 'floor').map(p => mesh(p, f.elevation)));
  for (const slab of slabs) assert.equal(downwardAt(slab, 0, 0).length, 0);
  dispose(slabs);
});

test('city seed replay is exact, changes architecture, and keeps buildings inside their street setbacks', () => {
  const input = { preset: 'city', seed: 42, rows: 4, columns: 3, variation: 0.9 };
  const first = generateArchitecture(input), same = generateArchitecture(input), different = generateArchitecture({ ...input, seed: 43 });
  assert.deepEqual(first, same);
  assert.notDeepEqual(first.buildings, different.buildings);
  assert.equal(first.buildings.length, 13);
  const s = first.settings, cellW = s.width + s.setback * 2 + s.streetWidth, cellD = s.depth + s.setback * 2 + s.streetWidth;
  for (const b of first.buildings.slice(1)) {
    for (const [x, z] of b.footprint) {
      assert.ok(Math.abs(x) <= cellW / 2 - s.streetWidth / 2 - s.setback + 1e-6);
      assert.ok(Math.abs(z) <= cellD / 2 - s.streetWidth / 2 - s.setback + 1e-6);
    }
  }
  const roads = first.buildings[0].floors[0].pieces;
  for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
    const a = roads[i], b = roads[j];
    const overlapX = (a.size[0] + b.size[0]) / 2 - Math.abs(a.position[0] - b.position[0]);
    const overlapZ = (a.size[2] + b.size[2]) / 2 - Math.abs(a.position[2] - b.position[2]);
    assert.ok(overlapX < 1e-6 || overlapZ < 1e-6, 'road junctions have overlapping coplanar faces');
  }
});

test('large or non-finite inputs are bounded before generation, and budgets never cut buildings in half', () => {
  const s = normalizeArchitectureSettings({ width: Infinity, depth: NaN, storeys: 1e20, rows: 1e20, columns: -10, windowSpacing: 0, maxPieces: 0 });
  assert.equal(s.width, 12); assert.equal(s.depth, 10); assert.equal(s.storeys, 32);
  assert.equal(s.rows, 12); assert.equal(s.columns, 1); assert.equal(s.windowSpacing, 1); assert.equal(s.maxPieces, 32);
  const oversized = generateArchitecture({ preset: 'tower', storeys: 1e50, maxPieces: 40 });
  assert.ok(count(oversized) <= 40); assert.ok(oversized.warnings.length);
  assert.equal(oversized.buildings[0].floors.at(-1).name, 'Roof');
  const city = generateArchitecture({ preset: 'city', rows: 12, columns: 12, storeys: 32, maxPieces: 500 });
  assert.ok(count(city) <= 500); assert.ok(city.warnings.length);
  for (const b of city.buildings.slice(1)) assert.equal(b.floors.at(-1).name, 'Roof');
  const tiny = generateArchitecture({ preset: 'city', rows: 12, columns: 12, maxPieces: 32 });
  assert.equal(tiny.buildings.length, 0); assert.match(tiny.warnings[0], /street network/);
});

test('invalid polygon and hole topology fails before emitting geometry', () => {
  assert.throws(() => generateArchitecture({ footprint: 'custom', customFootprint: [[0, 0], [5, 5], [0, 5], [5, 0]] }), /crossing/);
  assert.throws(() => generateArchitecture({ footprint: 'custom', customFootprint: [[0, 0], [1, 0], [2, 0]] }), /overlapping|enclose/);
  assert.throws(() => generateArchitecture({ footprint: 'custom', customFootprint: [[0, 0], [Infinity, 2], [2, 2]] }), /finite/);
  const footprint = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
  const emit = holes => generateArchitecture({ kind: 'assembly', pieces: [{ shape: 'floor', props: { footprint, holes } }] });
  assert.throws(() => emit([[[4, 4], [6, 4], [6, 6], [4, 6]]]), /inside/);
  assert.throws(() => emit([[[0, 0], [3, 0], [3, 3], [0, 3]], [[1, 1], [4, 1], [4, 4], [1, 4]]]), /overlap/);
  assert.throws(() => emit([[[-5, -2], [-3, -2], [-3, 2], [-5, 2]]]), /touches/);
});

test('freeform assemblies preserve arbitrary elevations, full rotations, custom material roles and integration settings', () => {
  const input = { kind: 'assembly', pieces: [
    { name: 'Suspended diagonal truss', shape: 'box', size: [8, 0.3, 0.4], position: [20, 80, -15], rotation: [0.2, 0.4, 0.6], role: 'trim', props: { material: 'materials/steel.mat' } },
    { name: 'Below-ground service ramp', shape: 'ramp', size: [3, 6, 12], position: [-12, -25, 4], rotationY: Math.PI / 2 },
  ], materials: { default: 'default.mat', trim: 'steel.mat', wall: 'brick.mat' }, terrainFit: 'highest', terrainId: 'hill', avoidWater: true, waterClearance: 1.5, clearFoliage: true, foliagePadding: 2, collision: false };
  const original = structuredClone(input), plan = generateArchitecture(input);
  assert.equal(plan.buildings[0].floors.length, 1);
  const [truss, ramp] = pieces(plan);
  assert.deepEqual(truss.position, [20, 80, -15]); assert.deepEqual(truss.rotation, [0.2, 0.4, 0.6]);
  assert.equal(ramp.position[1], -25); assert.equal(truss.role, 'trim'); assert.equal(truss.props.material, 'materials/steel.mat');
  for (const key of ['materials', 'terrainFit', 'terrainId', 'avoidWater', 'waterClearance', 'clearFoliage', 'foliagePadding', 'collision']) assert.deepEqual(plan.settings[key], input[key]);
  assert.deepEqual(input, original);
  const footprint = plan.buildings[0].footprint, minX = Math.min(...footprint.map(p => p[0])), maxX = Math.max(...footprint.map(p => p[0]));
  for (const p of pieces(plan)) {
    const m = mesh(p), b = new THREE.Box3().setFromObject(m);
    assert.ok(b.min.x >= minX - 1e-6 && b.max.x <= maxX + 1e-6, 'assembly footprint must include rotated pieces');
    m.geometry.dispose();
  }
});

test('bridge deck and both approaches join at the same elevation and have open entry ends', () => {
  const plan = generateArchitecture({ preset: 'bridge' }), list = pieces(plan), deck = list.find(p => p.name === 'Bridge deck');
  const approaches = list.filter(p => p.shape === 'ramp');
  assert.equal(approaches.length, 2);
  for (const ramp of approaches) {
    const m = mesh(ramp), high = m.localToWorld(new THREE.Vector3(0, ramp.size[1], ramp.size[2] / 2));
    close(high.y, deck.position[1]); close(Math.abs(high.z), deck.size[2] / 2);
    m.geometry.dispose();
  }
  for (const p of list.filter(p => p.shape === 'wall')) assert.ok(Math.abs(p.position[0]) > 1, 'entry blocked by a transverse rail');
});
