import * as THREE from 'three/webgpu';
import { Fn, float, instanceIndex, normalLocal, uint, uniform, varyingProperty, vec3, vec4, vertexIndex } from 'three/tsl';
import { createFoliageMaterial, createFoliageUniforms, updateFoliageUniforms } from '../../src/modules/foliage/foliageMaterial.js';
import { createFoliagePrototype } from '../../src/modules/foliage/foliageGeometry.js';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const vector = a => new THREE.Vector3(...a);
const distance = (a, b) => vector(a).distanceTo(vector(b));
const row = (geometry, index) => Object.fromEntries(Object.entries(geometry.attributes).map(([key, attr]) => [key, Array.from({ length: attr.itemSize }, (_, k) => attr.getComponent(index, k))]));
const copy = sample => Object.fromEntries(Object.entries(sample).map(([key, values]) => [key, [...values]]));

// Probe genuine prototype attributes through the production material AFTER
// Three has applied its real instance matrix. A single shared interleaved
// buffer preserves the portable layout even with both matrix readers present.
function probeGeometry(samples) {
  const layout = Object.entries(samples[0]).map(([name, values]) => [name, values.length]);
  const stride = layout.reduce((n, [, size]) => n + size, 0);
  const data = new Float32Array(samples.length * 6 * stride);
  let offset = 0;
  for (const sample of samples) for (let corner = 0; corner < 6; corner++) for (const [name] of layout) { data.set(sample[name], offset); offset += sample[name].length; }
  const interleaved = new THREE.InterleavedBuffer(data, stride), geometry = new THREE.BufferGeometry();
  offset = 0;
  for (const [name, size] of layout) { geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(interleaved, size, offset)); offset += size; }
  return geometry;
}

async function createProbe(renderer, species, samples, capacity = 1, usage = THREE.DynamicDrawUsage) {
  const width = Math.ceil(samples.length / 16) * 16;
  const uniforms = createFoliageUniforms(), normalMode = uniform(0);
  const geometry = probeGeometry(samples), material = createFoliageMaterial(uniforms, { species, height: 8 });
  const source = material.positionNode, actual = varyingProperty('vec3'), normal = varyingProperty('vec3');
  material.positionNode = Fn(() => {
    actual.assign(source); normal.assign(normalLocal);
    const corner = vertexIndex.mod(uint(6));
    const x = corner.equal(uint(1)).or(corner.equal(uint(2))).or(corner.equal(uint(4))).select(.45, -.45);
    const y = corner.equal(uint(2)).or(corner.equal(uint(4))).or(corner.equal(uint(5))).select(.45, -.45);
    return vec3(float(vertexIndex.div(uint(6))).add(.5).add(x).div(width).mul(2).sub(1), float(1).sub(float(instanceIndex).add(.5).add(y).div(capacity).mul(2)), 0);
  })();
  material.fragmentNode = vec4(normalMode.greaterThan(.5).select(normal, actual), 1);
  material.depthTest = material.depthWrite = false; material.side = THREE.DoubleSide;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity); mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(usage);
  const scene = new THREE.Scene(); scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10); camera.position.z = 1;
  const target = new THREE.RenderTarget(width, capacity, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
  let matrix = new THREE.Matrix4();
  // The integrated fixture retains the engine's asynchronous pipeline wrapper;
  // certify compilation before the first measured draw, never settle a repack.
  const previousTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target); await renderer.compileAsync(scene, camera); renderer.setRenderTarget(previousTarget);
  return {
    uniforms,
    get matrix() { return matrix; },
    setMatrix(phase, count = capacity) {
      matrix = new THREE.Matrix4().compose(new THREE.Vector3(17 + phase * 3, 3 - phase, -8 + phase * 4), new THREE.Quaternion().setFromEuler(new THREE.Euler(.3 + phase * .2, .8, -.4)), new THREE.Vector3(1.3, .7 + phase * .3, 1.8));
      for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, matrix);
      mesh.count = count; mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, capacity * 16); mesh.instanceMatrix.needsUpdate = true;
    },
    async read(time, wind, normals = false) {
      updateFoliageUniforms(uniforms, { wind: true, windStrength: .2, windGustStrength: .6, windScale: 12, windTurbulence: .25 }, time, wind);
      normalMode.value = normals ? 1 : 0;
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, capacity);
      const values = Array.from({ length: samples.length }, (_, i) => [...data.slice(i * 4, i * 4 + 3)]);
      assert(values.flat().every(Number.isFinite), `${species} motion readback is finite`);
      return values;
    },
    dispose() { renderer.setRenderTarget(null); target.dispose(); geometry.dispose(); material.dispose(); mesh.dispose(); },
  };
}

function groupsForBlade(geometry, predicate) {
  const all = Array.from({ length: geometry.attributes.position.count }, (_, i) => row(geometry, i));
  const first = all.find(predicate);
  assert(first, 'motion metadata exists');
  const key = first.foliageBlade.slice(0, 3).join(',');
  const same = all.filter(sample => sample.foliageBlade.slice(0, 3).join(',') === key && predicate(sample));
  const unique = new Map(same.map(sample => [sample.position.join(','), sample]));
  return [...unique.values()];
}

function centerline(samples, values) {
  const groups = new Map();
  samples.forEach((sample, i) => { const t = sample.foliageBlade[3]; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(vector(values[i])); });
  return [...groups].sort((a, b) => a[0] - b[0]).map(([, points]) => points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length));
}

function fittedArcLength(points) {
  const a = points[0], b = points[Math.floor(points.length / 2)], c = points.at(-1);
  const doubleArea = b.clone().sub(a).cross(c.clone().sub(a)).length();
  const radius = a.distanceTo(b) * b.distanceTo(c) * a.distanceTo(c) / (2 * doubleArea);
  return points.slice(1).reduce((sum, point, i) => sum + 2 * radius * Math.asin(Math.min(1, points[i].distanceTo(point) / (2 * radius))), 0);
}

async function grassMotion(renderer, capacity, usage = THREE.DynamicDrawUsage) {
  const geometry = createFoliagePrototype({ species: 'grass', seed: 37, height: 1, width: .6 }, 0);
  const samples = groupsForBlade(geometry, sample => sample.foliageCurve[2] >= 0); geometry.dispose();
  const probe = await createProbe(renderer, 'grass', samples, capacity, usage);
  let rootError = 0, arcError = 0, restError = 0, tipMotion = 0, normalMotion = 0;
  const calm = { vector: [0, 0, 0], gust: 0, gustFrequency: 1 }, storm = { vector: [0, 0, -10], gust: 10, gustFrequency: 1 };
  let previousTip, firstNormal;
  try {
    probe.setMatrix(0);
    const rest = await probe.read(0, calm);
    rest.forEach((p, i) => { restError = Math.max(restError, vector(p).distanceTo(vector(samples[i].position).applyMatrix4(probe.matrix))); });
    for (let frame = 0; frame < 24; frame++) {
      // Repack and vary active count on EVERY consecutive draw; no settling
      // frames may conceal an old root matrix beside a new position matrix.
      probe.setMatrix((frame % 3) * .6, frame % 2 ? capacity : Math.min(3, capacity));
      const values = await probe.read(frame * .23, storm), inverse = probe.matrix.clone().invert();
      const local = values.map(value => vector(value).applyMatrix4(inverse).toArray());
      samples.forEach((sample, i) => { if (sample.foliageBlade[3] === 0) rootError = Math.max(rootError, distance(local[i], sample.position)); });
      const centers = centerline(samples, local), length = fittedArcLength(centers);
      arcError = Math.max(arcError, Math.abs(length - samples[0].foliageBlade[2]));
      if (previousTip) tipMotion = Math.max(tipMotion, centers.at(-1).distanceTo(previousTip));
      previousTip = centers.at(-1);
    }
    probe.setMatrix(0);
    firstNormal = await probe.read(0, storm, true);
    const laterNormal = await probe.read(2, storm, true);
    normalMotion = Math.max(...firstNormal.map((n, i) => distance(n, laterNormal[i])));
    const result = { capacity, usage: usage === THREE.StaticDrawUsage ? 'static' : 'dynamic', frames: 24, restError, rootError, arcError, tipMotion, normalMotion, samples: samples.length };
    assert(restError < 1e-5 && rootError < 1e-5 && arcError < .0005, `actual curved grass remains pinned and preserves arc length during repacks: ${JSON.stringify(result)}`);
    assert(tipMotion > .003 && normalMotion > .005, `curved grass and its normals respond to strong weather: ${JSON.stringify(result)}`);
    return result;
  } finally { probe.dispose(); }
}

async function flowerMotion(renderer) {
  const geometry = createFoliagePrototype({ species: 'wildflowers', seed: 37 }, 0);
  const stem = groupsForBlade(geometry, sample => sample.foliageCurve[2] === -1);
  const roots = stem.filter(sample => sample.foliageBlade[3] === 0);
  const heads = stem.filter(sample => sample.foliageBlade[3] === 1).slice(0, 32);
  const samples = [...roots, ...heads]; geometry.dispose();
  const probe = await createProbe(renderer, 'wildflowers', samples);
  let rootError = 0, headDistanceError = 0, headMotion = 0;
  try {
    probe.setMatrix(0);
    const inverse = probe.matrix.clone().invert();
    const rest = await probe.read(0, { vector: [0, 0, 0], gust: 0 });
    for (let frame = 0; frame < 20; frame++) {
      const actual = await probe.read(frame * .19, { vector: [0, 0, -10], gust: 10, gustFrequency: 1 });
      const local = actual.map(value => vector(value).applyMatrix4(inverse).toArray());
      roots.forEach((sample, i) => { rootError = Math.max(rootError, distance(local[i], sample.position)); });
      for (let i = roots.length + 1; i < samples.length; i++) headDistanceError = Math.max(headDistanceError, Math.abs(distance(local[roots.length], local[i]) - distance(samples[roots.length].position, samples[i].position)));
      headMotion = Math.max(headMotion, distance(actual.at(-1), rest.at(-1)));
    }
    const result = { rootError, headDistanceError, headMotion, headVertices: heads.length };
    assert(rootError < 1e-5 && headDistanceError < 1e-5 && headMotion > .01, `flower heads sway as attached rigid parts without stretching petals: ${JSON.stringify(result)}`);
    return result;
  } finally { probe.dispose(); }
}

async function treeMotion(renderer) {
  const geometry = createFoliagePrototype({ species: 'oak', seed: 37 }, 0);
  const all = Array.from({ length: geometry.attributes.position.count }, (_, i) => row(geometry, i));
  const tip = all.find(sample => sample.treeLeafAxis[3] === 1 && sample.uv[1] > .99 && sample.treeBranch[3] > .2);
  assert(tip, 'tree has a flexible attached leaf');
  const anchor = copy(tip); anchor.position = anchor.treeLeaf.slice(0, 3); anchor.uv[1] = 0;
  const barkAnchor = copy(anchor); barkAnchor.treeLeafAxis[3] = 0;
  const noFlutterTip = copy(tip); noFlutterTip.uv[1] = 0;
  const root = copy(barkAnchor); root.position = [0, 0, 0]; root.treeBranch = [0, 0, 0, 0];
  const samples = [root, anchor, barkAnchor, tip, noFlutterTip]; geometry.dispose();
  const probe = await createProbe(renderer, 'oak', samples, 1100);
  let rootError = 0, jointError = 0, flutterMotion = 0, branchMotion = 0, normalMotion = 0, restError = 0;
  try {
    probe.setMatrix(0);
    const rest = await probe.read(0, { vector: [0, 0, 0], gust: 0 });
    rest.forEach((p, i) => { restError = Math.max(restError, vector(p).distanceTo(vector(samples[i].position).applyMatrix4(probe.matrix))); });
    const restNormal = await probe.read(0, { vector: [0, 0, 0], gust: 0 }, true);
    for (let frame = 0; frame < 24; frame++) {
      const actual = await probe.read(frame * .13, { vector: [0, 0, -10], gust: 10, gustFrequency: 1 });
      rootError = Math.max(rootError, distance(actual[0], rest[0]));
      jointError = Math.max(jointError, distance(actual[1], actual[2]));
      flutterMotion = Math.max(flutterMotion, distance(actual[3], actual[4]));
      branchMotion = Math.max(branchMotion, distance(actual[1], rest[1]));
    }
    const normals = await probe.read(1.3, { vector: [0, 0, -10], gust: 10, gustFrequency: 1 }, true);
    normalMotion = Math.max(...normals.map((normal, i) => distance(normal, restNormal[i])));
    const result = { capacity: 1100, restError, rootError, jointError, flutterMotion, branchMotion, normalMotion };
    assert(restError < 1e-5 && rootError < 1e-5 && jointError < 1e-5, `tree joints remain attached and calm is exact: ${JSON.stringify(result)}`);
    assert(flutterMotion > .0005 && branchMotion > .01 && normalMotion > .005, `tree branches and leaves have separate motion with changing normals: ${JSON.stringify(result)}`);
    return result;
  } finally { probe.dispose(); }
}

export async function checkFoliageMotion(renderer) {
  const grass = [];
  for (const usage of [THREE.DynamicDrawUsage, THREE.StaticDrawUsage]) for (const capacity of [4, 1100]) grass.push(await grassMotion(renderer, capacity, usage));
  const result = { grass, flowers: await flowerMotion(renderer), tree: await treeMotion(renderer) };
  console.log('FOLIAGE articulated motion checks', JSON.stringify(result));
  return result;
}
