import * as THREE from 'three/webgpu';
import { Fn, float, instanceIndex, instancedArray, uint, uniform, varyingProperty, vec3, vec4, vertexIndex } from 'three/tsl';
import { createFoliageMaterial, createFoliageSurfaceMaterial, createFoliageUniforms, installFoliagePassHooks, setupFoliageImpostorMaterial, updateFoliageUniforms } from '../../src/modules/foliage/foliageMaterial.js';
import { foliageWindField } from '../../src/modules/foliage/foliageWind.js';
import { createFoliagePrototype } from '../../src/modules/foliage/foliageGeometry.js';
import { bakeImpostorAtlas } from '../../src/engine/lod/impostorBake.js';
import { createGiGBuffer, renderGiGBuffer } from '../../src/modules/gi/giScreen.js';
import { checkFoliageImpostorWind } from './foliageImpostorWindCheck.js';
import { checkFoliageMotion } from './foliageMotionCheck.js';

const assert = (ok, label) => { if (!ok) throw new Error(label); };
const covered = data => data.reduce((n, v, i) => n + (i % 4 === 3 && v > .5 ? 1 : 0), 0);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rgbDifference = (a, b) => { let changed = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 8) changed++; return changed; };

async function checkSurface(renderer) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-.6, .6, .6, -.6, .1, 10); camera.position.z = 3;
  const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  const count = geometry.attributes.position.count;
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  geometry.setAttribute('foliagePart', new THREE.Float32BufferAttribute(new Float32Array(count).fill(1), 1));
  const material = createFoliageSurfaceMaterial({ species: 'oak' });
  const mesh = new THREE.Mesh(geometry, material); installFoliagePassHooks(mesh); scene.add(mesh);
  const gbuffer = createGiGBuffer(192, 192);
  renderGiGBuffer(renderer, scene, camera, gbuffer);
  const positions = await renderer.backend.copyTextureToBuffer(gbuffer.position, 0, 0, 192, 192);
  const normals = await renderer.backend.copyTextureToBuffer(gbuffer.normal, 0, 0, 192, 192);
  const hook = mesh.onBeforeRender; mesh.onBeforeRender = () => {}; gbuffer.material.needsUpdate = true;
  renderGiGBuffer(renderer, scene, camera, gbuffer);
  const unmasked = await renderer.backend.copyTextureToBuffer(gbuffer.position, 0, 0, 192, 192);
  mesh.onBeforeRender = hook;
  const distinctNormals = new Set();
  for (let i = 0; i < positions.length; i += 4) if (positions[i + 3] > .5) distinctNormals.add(`${normals[i]},${normals[i + 1]},${normals[i + 2]}`);
  const result = { maskedPixels: covered(positions), rectanglePixels: covered(unmasked), distinctNormals: distinctNormals.size };
  assert(result.maskedPixels > 1000 && result.maskedPixels < result.rectanglePixels * .5, `near leaves retain alpha in GI: ${JSON.stringify(result)}`);
  assert(result.distinctNormals > 100, `GI keeps actual leaf vein normals: ${JSON.stringify(result)}`);

  const atlas = await bakeImpostorAtlas(renderer, mesh, { frames: 4, tile: 64, hemisphere: false });
  let colorPixels = 0, normalPixels = 0, alphaMismatch = 0;
  for (let i = 3; i < atlas.albedoData.length; i += 4) {
    const a = atlas.albedoData[i] > 127, b = atlas.normalData[i] > 127;
    colorPixels += a; normalPixels += b; alphaMismatch += a !== b;
  }
  result.atlas = { colorPixels, normalPixels, alphaMismatch };
  assert(colorPixels > 500 && alphaMismatch < colorPixels * .03, `color and normal atlas retain the SAME holes: ${JSON.stringify(result.atlas)}`);
  atlas.dispose();

  // Native Three shadow overrides do not forward opacityNode. An ordinary
  // opaque card is the control for the actual cutout card's native shadow.
  const receiver = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshStandardNodeMaterial({ color: 'white', roughness: 1 }));
  receiver.position.z = -.1; receiver.receiveShadow = true; scene.add(receiver);
  mesh.castShadow = true; material.colorWrite = false; material.depthWrite = false;
  const sun = new THREE.DirectionalLight('white', 3); sun.position.set(0, 0, 3); sun.castShadow = true;
  sun.shadow.mapSize.set(256, 256); sun.shadow.camera.left = sun.shadow.camera.bottom = -.7; sun.shadow.camera.right = sun.shadow.camera.top = .7;
  sun.shadow.camera.near = .1; sun.shadow.camera.far = 10; scene.add(sun); scene.add(new THREE.AmbientLight('white', .15));
  const target = new THREE.RenderTarget(192, 192);
  const shadowEnabled = renderer.shadowMap.enabled; renderer.shadowMap.enabled = true;
  const capture = async () => { sun.shadow.needsUpdate = true; renderer.setRenderTarget(target); await renderer.compileAsync(scene, camera); renderer.render(scene, camera); return renderer.readRenderTargetPixelsAsync(target, 0, 0, 192, 192); };
  const leafShadow = await capture();
  const mask = material.maskShadowNode; material.maskShadowNode = null; material.needsUpdate = true;
  const rectangle = new THREE.MeshStandardNodeMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
  mesh.material = rectangle;
  const rectangleShadow = await capture();
  result.shadowChangedPixels = rgbDifference(leafShadow, rectangleShadow);
  result.shadowEnergy = [leafShadow.reduce((a, b) => a + b, 0), rectangleShadow.reduce((a, b) => a + b, 0)];
  assert(result.shadowChangedPixels > 1000, `native shadow uses leaf cutout: ${JSON.stringify(result)}`);
  material.maskShadowNode = mask; rectangle.dispose(); mesh.material = material; renderer.shadowMap.enabled = shadowEnabled;
  renderer.setRenderTarget(null); target.dispose(); gbuffer.dispose(); geometry.dispose(); material.dispose(); receiver.geometry.dispose(); receiver.material.dispose(); sun.shadow.dispose();
  return result;
}

// Every logical vertex is duplicated into a six-vertex pixel-sized quad. The
// wrapper evaluates the PRODUCTION positionNode after Three's actual instancing,
// writes that result to a varying, then moves only the diagnostic raster quad.
// Float color readback captures the actual vertex shader without a writable
// vertex storage buffer or a CPU reimplementation of its transformations.
function instrumentPosition(material, samples, capacity) {
  const original = material.positionNode;
  const actual = varyingProperty('vec3');
  material.positionNode = Fn(() => {
    actual.assign(original);
    const corner = vertexIndex.mod(uint(6));
    const x = corner.equal(uint(1)).or(corner.equal(uint(2))).or(corner.equal(uint(4))).select(.45, -.45);
    const y = corner.equal(uint(2)).or(corner.equal(uint(4))).or(corner.equal(uint(5))).select(.45, -.45);
    return vec3(float(vertexIndex.div(uint(6))).add(.5).add(x).div(samples).mul(2).sub(1), float(1).sub(float(instanceIndex).add(.5).add(y).div(capacity).mul(2)), 0);
  })();
  material.fragmentNode = vec4(actual, 1); material.depthTest = false; material.depthWrite = false; material.side = THREE.DoubleSide;
}

function bladeGeometry() {
  const positions = [], normals = [], colors = [], blades = [], weights = [], uvs = [];
  for (const t of [0, .25, .5, .75, 1]) for (let i = 0; i < 6; i++) {
    positions.push(.22, t, -.17 + .16 * t * t); normals.push(0, 0, 1); colors.push(1, 1, 1);
    blades.push(.22, -.17, 1.017, t); weights.push(t); uvs.push(0, t);
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, array, size] of [['position', positions, 3], ['normal', normals, 3], ['color', colors, 3], ['foliageBlade', blades, 4], ['foliageWind', weights, 1], ['uv', uvs, 2]]) geometry.setAttribute(name, new THREE.Float32BufferAttribute(array, size));
  return geometry;
}

async function checkWindMatrices(renderer, capacity, usage = THREE.DynamicDrawUsage) {
  const samples = 5, uniforms = createFoliageUniforms(); uniforms.strength.value = .85;
  const geometry = bladeGeometry(), material = createFoliageMaterial(uniforms, { species: 'grass' });
  instrumentPosition(material, samples, capacity);
  const mesh = new THREE.InstancedMesh(geometry, material, capacity); mesh.frustumCulled = false; mesh.count = 3;
  mesh.instanceMatrix.setUsage(usage);
  const matrices = [];
  const setMatrices = (phase, changedCount = capacity) => {
    for (let i = 0; i < changedCount; i++) {
      const matrix = new THREE.Matrix4().compose(new THREE.Vector3(17 + i * .015 + phase * 3, 3 - phase, -8 + phase * 4), new THREE.Quaternion().setFromEuler(new THREE.Euler(.3 + phase * .2, .8, -.4)), new THREE.Vector3(1.3, .7 + phase * .3, 1.8));
      matrices[i] = matrix; mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, changedCount * 16);
    mesh.instanceMatrix.needsUpdate = true;
  };
  setMatrices(0);
  const scene = new THREE.Scene(); scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10); camera.position.z = 1;
  const target = new THREE.RenderTarget(samples, capacity, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
  const capture = async time => { uniforms.time.value = time; renderer.setRenderTarget(target); renderer.render(scene, camera); return renderer.readRenderTargetPixelsAsync(target, 0, 0, samples, capacity); };
  const first = await capture(0);
  const expectedAt = (instance, sample) => new THREE.Vector3(.22, sample / 4, -.17 + .16 * (sample / 4) ** 2).applyMatrix4(matrices[instance]).toArray();
  // WebGPU Float32 texture readback retains the 256-byte padded row stride.
  const rowStride = Math.ceil(samples * 16 / 256) * 64;
  const read = (data, instance, sample) => { const offset = instance * rowStride + sample * 4; return Array.from(data.slice(offset, offset + 3)); };
  let rootError = 0, radiusError = 0;
  const verify = (data, count) => {
    for (let i = 0; i < count; i++) {
      const root = expectedAt(i, 0); rootError = Math.max(rootError, distance(read(data, i, 0), root));
      for (let j = 1; j < samples; j++) radiusError = Math.max(radiusError, Math.abs(distance(read(data, i, j), root) - distance(expectedAt(i, j), root)));
    }
  };
  verify(first, 3);
  const later = await capture(3.2);
  const movingTip = distance(read(first, 0, 4), read(later, 0, 4));
  setMatrices(1); mesh.count = capacity;
  const repacked = await capture(4.5); verify(repacked, capacity);
  // Consecutive frames, no settle delay: this is the rotating-camera LOD
  // compaction regression, where one old root matrix produces a giant blade.
  for (let frame = 0; frame < 20; frame++) {
    setMatrices(frame % 2 ? -4 : 5);
    mesh.count = frame % 3 ? capacity : 3;
    verify(await capture(5 + frame / 60), mesh.count);
  }
  mesh.count = capacity;
  // A partial upload must refresh the repacked prefix and retain the untouched
  // tail, in both version-driven static and always-uploaded dynamic paths.
  setMatrices(2, 3); verify(await capture(8), capacity);
  uniforms.strength.value = 0;
  const zero = await capture(10);
  let zeroError = 0;
  for (let i = 0; i < capacity; i++) for (let j = 0; j < samples; j++) zeroError = Math.max(zeroError, distance(read(zero, i, j), expectedAt(i, j)));
  const response = { wind: true, windStrength: .85, windGustStrength: .6 };
  updateFoliageUniforms(uniforms, response, 1.5, { vector: [0, 0, 2], gust: 2, gustFrequency: .5 });
  const sceneA = await capture(1.5);
  updateFoliageUniforms(uniforms, response, 1.5, { vector: [-5, 1, 0], gust: 4, gustFrequency: 2 });
  const sceneB = await capture(1.5); verify(sceneB, capacity);
  const sceneEditMotion = distance(read(sceneA, 0, 4), read(sceneB, 0, 4));
  updateFoliageUniforms(uniforms, response, 2, { vector: [0, 0, 0], gust: 0, gustFrequency: 3 });
  const calm = await capture(2);
  const calmError = distance(read(calm, 0, 4), expectedAt(0, 4));
  const result = { capacity, usage: usage === THREE.StaticDrawUsage ? 'static' : 'dynamic', consecutiveRepacks: 20, partialUpdateInstances: 3, rootError, radiusError, zeroError, movingTip, sceneEditMotion, calmError };
  if (rootError > .0001) console.log('FOLIAGE vertex diagnostic', JSON.stringify({ capacity, length: first.length, roots: Array.from({ length: capacity }, (_, i) => read(first, i, 0)), zeroRoots: Array.from({ length: capacity }, (_, i) => read(zero, i, 0)), first: Array.from(first.slice(0, 80)), expected: expectedAt(0, 0) }));
  assert(rootError < .0001 && radiusError < .0001 && zeroError < .0001, `actual ${capacity > 1000 ? 'attribute' : 'UBO'} instance wind keeps transformed roots, length and matrix repacks: ${JSON.stringify(result)}`);
  assert(movingTip > .002, `traveling gust moves actual blade tip over time: ${JSON.stringify(result)}`);
  assert(sceneEditMotion > .05 && calmError < .0001, `scene wind edits affect already-compiled foliage, calm scene stops it: ${JSON.stringify(result)}`);
  renderer.setRenderTarget(null); target.dispose(); geometry.dispose(); material.dispose(); mesh.dispose();
  return result;
}

async function checkWindField(renderer) {
  const uniforms = createFoliageUniforms(), source = instancedArray(new Float32Array([0, 0, 0, 0, .01, 0, .01, 0, 14, 0, 19, 0, 2, 0, 0, 0]), 'vec4'), output = instancedArray(4, 'vec4');
  const dispatchStamp = uniform(0), dispatchAttempts = [];
  const kernel = Fn(() => { output.element(instanceIndex).assign(vec4(foliageWindField(uniforms, source.element(instanceIndex).xyz), 0, dispatchStamp)); })().compute(4);
  kernel.name = 'Foliage wind field probe';
  const read = async time => {
    uniforms.time.value = time; dispatchStamp.value++;
    const expected = dispatchStamp.value, deadline = performance.now() + 15000;
    let attempts = 0;
    // GI's retained async-compute backend can resolve computeAsync before its
    // first pipeline exists, then replay the dispatch later. Queue completion
    // alone cannot wait for work that has not been submitted yet. Every output
    // row writes a unique stamp in the SAME dispatch as the sampled field;
    // keep the requested time fixed until the GPU certifies that dispatch.
    while (performance.now() < deadline) {
      attempts++; await renderer.computeAsync(kernel);
      const data = new Float32Array(await renderer.getArrayBufferAsync(output.value));
      if ([3, 7, 11, 15].every(index => data[index] === expected)) { dispatchAttempts.push(attempts); return data; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Foliage wind probe dispatch ${expected} never completed (${attempts} attempts)`);
  };
  const first = await read(0), later = await read(1);
  const result = { neighborDifference: Math.abs(first[0] - first[4]), distantDifference: Math.abs(first[0] - first[8]), travelingError: Math.abs(first[0] - later[12]), dispatchAttempts };
  assert(result.neighborDifference < .003 && result.distantDifference > .025 && result.travelingError < .001, `shared GPU wind is spatially coherent and travels: ${JSON.stringify(result)}`);
  return result;
}

async function checkSpeciesAtlases(renderer) {
  const results = [];
  for (const species of ['oak', 'birch', 'pine', 'grass', 'wildflowers']) {
    const geometry = createFoliagePrototype({ species, seed: 42 }, 1);
    const material = createFoliageSurfaceMaterial({ species });
    const atlas = await bakeImpostorAtlas(renderer, new THREE.Mesh(geometry, material), { frames: 4, tile: 64 });
    let colorPixels = 0, normalPixels = 0, mismatch = 0;
    for (let i = 3; i < atlas.albedoData.length; i += 4) {
      const a = atlas.albedoData[i] > 127, b = atlas.normalData[i] > 127;
      colorPixels += a; normalPixels += b; mismatch += a !== b;
    }
    const result = { species, colorPixels, normalPixels, mismatch };
    assert(colorPixels > 100 && mismatch < colorPixels * .03, `actual ${species} color/normal bake agrees on coverage: ${JSON.stringify(result)}`);
    results.push(result); atlas.dispose(); material.dispose(); geometry.dispose();
  }
  return results;
}

/** Actual runtime far material against bright sky: GI can preserve alpha while
 * a faulty cloned MAIN material draws black rectangular atlas backgrounds. */
export async function checkFoliageImpostorMain(renderer, actualMesh, camera) {
  const target = new THREE.RenderTarget(320, 200); target.texture.colorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('white');
  scene.add(new THREE.AmbientLight('white', 2));
  const mesh = new THREE.Mesh(actualMesh.geometry, actualMesh.material); mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false; mesh.matrix.copy(actualMesh.matrixWorld); scene.add(mesh);
  const oldTarget = renderer.getRenderTarget(), threshold = mesh.material.alphaTest;
  const capture = async () => { renderer.setRenderTarget(target); await renderer.compileAsync(scene, camera); renderer.render(scene, camera); return renderer.readRenderTargetPixelsAsync(target, 0, 0, 320, 200); };
  try {
    const masked = await capture();
    mesh.material.alphaTest = 0; mesh.material.needsUpdate = true;
    const rectangle = await capture();
    const dark = pixels => { let n = 0; for (let i = 0; i < pixels.length; i += 4) if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 240) n++; return n; };
    const result = { threshold, maskedPixels: dark(masked), rectanglePixels: dark(rectangle) };
    assert(threshold > 0 && result.maskedPixels > 20 && result.maskedPixels < result.rectanglePixels * .75, `main impostors retain cutout against bright sky: ${JSON.stringify(result)}`);
    return result;
  } finally { mesh.material.alphaTest = threshold; mesh.material.needsUpdate = true; renderer.setRenderTarget(oldTarget); target.dispose(); }
}

async function captureWindSequence(renderer) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#263a36');
  scene.add(new THREE.AmbientLight('#d4e5ff', 1.2)); const sun = new THREE.DirectionalLight('#fff3ca', 3); sun.position.set(-3, 6, 2); scene.add(sun);
  const uniforms = createFoliageUniforms(); uniforms.strength.value = .9; uniforms.gustStrength.value = 1.1;
  const geometry = createFoliagePrototype({ species: 'grass', seed: 42, height: 1, width: .6 }, 0);
  const material = createFoliageMaterial(uniforms, { species: 'grass' });
  const mesh = new THREE.InstancedMesh(geometry, material, 120); scene.add(mesh);
  for (let i = 0; i < 120; i++) mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation((i % 15) * .24 - 1.7, 0, Math.floor(i / 15) * .25 - .8));
  mesh.instanceMatrix.needsUpdate = true;
  const camera = new THREE.PerspectiveCamera(42, 1.6, .01, 100); camera.position.set(2.6, 1.5, 4.1); camera.lookAt(0, .45, 0);
  const target = new THREE.RenderTarget(384, 240);
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const strip = document.createElement('canvas'); strip.width = 384 * 4; strip.height = 264 * 2; const ctx = strip.getContext('2d');
  ctx.fillStyle = '#17221f'; ctx.fillRect(0, 0, strip.width, strip.height); ctx.font = '14px sans-serif';
  const frame = document.createElement('canvas'); frame.width = 384; frame.height = 240; const frameCtx = frame.getContext('2d');
  let first, last;
  for (let i = 0; i < 8; i++) {
    uniforms.time.value = i * .55; renderer.setRenderTarget(target); renderer.render(scene, camera);
    const pixels = new Uint8ClampedArray(await renderer.readRenderTargetPixelsAsync(target, 0, 0, 384, 240));
    frameCtx.putImageData(new ImageData(pixels, 384, 240), 0, 0);
    const x = i % 4 * 384, y = Math.floor(i / 4) * 264; ctx.drawImage(frame, x, y); ctx.fillStyle = '#d8e5dc'; ctx.fillText(`${(i * .55).toFixed(2)} s`, x + 10, y + 258);
    if (i === 0) first = pixels; last = pixels;
  }
  globalThis.__FOLIAGE_WIND_FILMSTRIP__ = strip.toDataURL('image/png');
  const changedPixels = rgbDifference(first, last); assert(changedPixels > 500, `actual grass sequence moves: ${changedPixels}`);
  renderer.setRenderTarget(null); target.dispose(); geometry.dispose(); material.dispose(); mesh.dispose();
  return { frames: 8, duration: 3.85, changedPixels };
}

export async function runFoliageGpuChecks(renderer) {
  const target = renderer.getRenderTarget(), toneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  try {
    const surface = await checkSurface(renderer); console.log('FOLIAGE surface checks', JSON.stringify(surface));
    const windMatrices = [];
    for (const usage of [THREE.DynamicDrawUsage, THREE.StaticDrawUsage]) for (const capacity of [4, 1100]) windMatrices.push(await checkWindMatrices(renderer, capacity, usage));
    const windField = await checkWindField(renderer);
    const articulatedMotion = await checkFoliageMotion(renderer);
    const speciesAtlases = await checkSpeciesAtlases(renderer);
    const windSequence = await captureWindSequence(renderer);
    const impostorWind = await checkFoliageImpostorWind(renderer);
    return { surface, windMatrices, windField, articulatedMotion, speciesAtlases, windSequence, impostorWind };
  } finally { renderer.setRenderTarget(target); renderer.toneMapping = toneMapping; }
}
