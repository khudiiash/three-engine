import * as THREE from 'three/webgpu';
import { createImpostorGeometry, createImpostorMaterial } from '../../src/engine/lod/impostorMaterial.js';
import { createFoliageUniforms, installFoliagePassHooks, setupFoliageImpostorMaterial } from '../../src/modules/foliage/foliageMaterial.js';
import { createGiGBuffer, renderGiGBuffer } from '../../src/modules/gi/giScreen.js';

const assert = (ok, label) => { if (!ok) throw new Error(label); };

// A recognizable narrow blade reaches almost to the billboard's bottom. Every
// view contains the same known silhouette so this isolates UV transport from
// atlas baking or octahedral view blending. It uses the production impostor
// geometry, material, wind wrapper and GI hooks, not a substitute shader.
function bladeAtlas() {
  const tile = 128, frames = 2, size = tile * frames;
  const color = new Uint8Array(size * size * 4), normal = new Uint8Array(color.length);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = ((x % tile) + .5) / tile, v = ((y % tile) + .5) / tile;
    const center = .5 + Math.sin(v * 5) * .03, halfWidth = .012 + .035 * (1 - v);
    const alpha = v > .01 && v < .96 && Math.abs(u - center) < halfWidth ? 255 : 0;
    const index = (y * size + x) * 4;
    color.set([90, 190, 65, alpha], index); normal.set([128, 128, 255, alpha], index);
  }
  const albedo = new THREE.DataTexture(color, size, size, THREE.RGBAFormat);
  const normals = new THREE.DataTexture(normal, size, size, THREE.RGBAFormat);
  for (const texture of [albedo, normals]) { texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true; }
  return { frames, tile, hemisphere: true, albedo, normal: normals };
}

function silhouette(pixels, isGbuffer = false) {
  let count = 0, rootX = 0, rootCount = 0, tipX = 0, tipCount = 0;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const index = (y * 256 + x) * 4;
    if (pixels[index + 3] <= (isGbuffer ? .5 : 127)) continue;
    count++;
    const worldY = 1.2 - (y + .5) / 256 * 2.4, height = (worldY + 1) / 2;
    if (height > .02 && height < .12) { rootX += x + .5; rootCount++; }
    if (height > .65 && height < .93) { tipX += x + .5; tipCount++; }
  }
  return { count, rootX: rootX / Math.max(rootCount, 1), tipX: tipX / Math.max(tipCount, 1), rootCount, tipCount };
}

export async function checkFoliageImpostorWind(renderer) {
  const atlas = bladeAtlas(), geometry = createImpostorGeometry(1);
  geometry.attributes.aCenter.setXYZ(0, 0, 0, 0); geometry.attributes.aSize.setX(0, 2);
  geometry.attributes.aAxisX.setXYZ(0, 1, 0, 0); geometry.attributes.aAxisY.setXYZ(0, 0, 1, 0); geometry.instanceCount = 1;
  const uniforms = createFoliageUniforms(); uniforms.direction.value.set(1, 0, 0); uniforms.gustStrength.value = 1.1;
  const material = setupFoliageImpostorMaterial(createImpostorMaterial(atlas, { lit: false, alphaTest: .35 }), uniforms, { species: 'grass' });
  const mesh = new THREE.Mesh(geometry, material); mesh.frustumCulled = false; installFoliagePassHooks(mesh);
  const scene = new THREE.Scene(); scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, .01, 10); camera.position.set(0, 0, 5);
  const target = new THREE.RenderTarget(256, 256); target.texture.colorSpace = THREE.SRGBColorSpace;
  const gbuffer = createGiGBuffer(256, 256);
  const oldTarget = renderer.getRenderTarget(), clear = new THREE.Color(), alpha = renderer.getClearAlpha(); renderer.getClearColor(clear);
  const capture = async (strength, time) => {
    uniforms.strength.value = strength; uniforms.time.value = time;
    renderer.setClearColor(0, 0); renderer.setRenderTarget(target); await renderer.compileAsync(scene, camera); renderer.render(scene, camera);
    return renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256);
  };
  try {
    const restingPixels = await capture(0, 0), blownPixels = await capture(.9, 0), laterPixels = await capture(.9, 3.85);
    const resting = silhouette(restingPixels), blown = silhouette(blownPixels), later = silhouette(laterPixels);
    const tipShift = blown.tipX - resting.tipX, rootShift = blown.rootX - resting.rootX;
    renderGiGBuffer(renderer, scene, camera, gbuffer);
    const giPositions = await renderer.backend.copyTextureToBuffer(gbuffer.position, 0, 0, 256, 256);
    const gi = silhouette(giPositions, true);
    let giWorldError = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const index = (y * 256 + x) * 4;
      if (giPositions[index + 3] > .5) giWorldError = Math.max(giWorldError, Math.abs(giPositions[index] - ((x + .5) / 256 * 2.4 - 1.2)));
    }
    const result = { resting, blown, later, tipShift, rootShift, giPixels: gi.count, giWorldError };
    assert(resting.rootCount > 30 && resting.tipCount > 30, `far blade has measured roots and tips: ${JSON.stringify(result)}`);
    assert(tipShift > 5 && rootShift >= 0 && rootShift < tipShift * .3 + 1, `far atlas silhouette follows wind while its bottom stays planted: ${JSON.stringify(result)}`);
    assert(Math.abs(later.tipX - blown.tipX) > 1 && blown.count / resting.count > .9 && blown.count / resting.count < 1.1, `far wind sways foliage rather than clipping away its atlas mask: ${JSON.stringify(result)}`);
    assert(Math.abs(gi.count - later.count) < 10 && Math.abs(gi.tipX - later.tipX) < .2 && giWorldError < .00001, `GI follows deformed geometry while atlas UVs follow the original surface: ${JSON.stringify(result)}`);
    const strip = document.createElement('canvas'); strip.width = 768; strip.height = 280; const ctx = strip.getContext('2d');
    ctx.fillStyle = '#263a36'; ctx.fillRect(0, 0, strip.width, strip.height); ctx.font = '14px sans-serif';
    const frame = document.createElement('canvas'); frame.width = frame.height = 256; const imageCtx = frame.getContext('2d');
    for (const [i, pixels] of [restingPixels, blownPixels, laterPixels].entries()) {
      imageCtx.putImageData(new ImageData(new Uint8ClampedArray(pixels), 256, 256), 0, 0); ctx.drawImage(frame, i * 256, 0);
      ctx.fillStyle = '#dbe8dd'; ctx.fillText(['Calm', 'Wind: 0.00 s', 'Wind: 3.85 s'][i], i * 256 + 12, 274);
    }
    globalThis.__FOLIAGE_FAR_WIND_FILMSTRIP__ = strip.toDataURL('image/png');
    return result;
  } finally {
    renderer.setClearColor(clear, alpha); renderer.setRenderTarget(oldTarget);
    target.dispose(); gbuffer.dispose(); geometry.dispose(); material.dispose(); atlas.albedo.dispose(); atlas.normal.dispose();
  }
}
