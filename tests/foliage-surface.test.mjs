import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createFoliageMaterial, createFoliageSurfaceMaterial, createFoliageUniforms, updateFoliageUniforms } from "../src/modules/foliage/foliageMaterial.js";
import { getFoliageSurfaceTextures } from "../src/modules/foliage/foliageSurfaceTexture.js";
import { createFoliageMatrixSync } from "../src/modules/foliage/foliageWind.js";
import Attributes from "three/src/renderers/common/Attributes.js";
import { AttributeType } from "three/src/renderers/common/Constants.js";

const coverage = image => image.data.reduce((count, value, i) => count + (i % 4 === 3 && value >= 128 ? 1 : 0), 0) / (image.width * image.height);

test("tree sprays contain separated small leaves and retain silhouette coverage through useful mips", () => {
  for (const species of ["oak", "birch", "pine"]) {
    const { leaves, bark } = getFoliageSurfaceTextures(species);
    const fraction = coverage(leaves.image);
    assert.ok(fraction > .15 && fraction < .45, `${species}: a spray contains open air, not a solid card`);
    if (species === "pine") {
      let innerPixels = 0, innerOpaque = 0;
      for (let y = 51; y < 204; y++) for (let x = 102; x < 153; x++) {
        innerPixels++; if (leaves.image.data[(y * 256 + x) * 4 + 3] >= 128) innerOpaque++;
      }
      assert.ok(innerOpaque / innerPixels < .65, "fascicle bases leave gaps instead of a continuous opaque broadleaf-like core");
    }
    for (const mip of leaves.mipmaps.filter(image => image.width >= 8)) assert.ok(Math.abs(coverage(mip) - fraction) < .03, `${species} ${mip.width}px: alpha-test coverage survives minification`);
    assert.equal(coverage(bark.image), 1, "tree trunks stay solid");
    assert.equal(leaves.wrapS, THREE.ClampToEdgeWrapping);
    assert.equal(bark.wrapS, THREE.RepeatWrapping);
    assert.notEqual(leaves, bark, "bark and foliage cannot bleed into each other at distant mip levels");
    assert.equal(getFoliageSurfaceTextures(species).leaves, leaves, "different tree instances share the same small texture");
    const alpha = (x, y) => leaves.image.data[(y * 256 + x) * 4 + 3];
    assert.equal(alpha(0, 0), 0); assert.equal(alpha(255, 255), 0);
    assert.ok(new Set([...bark.image.data].filter((_, i) => i % 4 === 0)).size > 30, "bark has actual visible surface variation");
  }
});

test("foliage inherits live scene wind with legacy scalar compatibility and zero-force calm", () => {
  const uniforms = createFoliageUniforms();
  const props = { wind: true, windStrength: .8, windGustStrength: .6, windDirection: 180, windSpeed: 9 };
  updateFoliageUniforms(uniforms, props, 42);
  assert.deepEqual(uniforms.direction.value.toArray(), [0, 0, 1]);
  assert.equal(uniforms.strength.value, .8); assert.equal(uniforms.speed.value, 1); assert.equal(uniforms.time.value, 42);
  updateFoliageUniforms(uniforms, props, 50, { vector: [-3, 4, 0], gust: 5, gustFrequency: .25 });
  assert.ok(uniforms.direction.value.distanceTo(new THREE.Vector3(-.6, .8, 0)) < 1e-12);
  assert.equal(uniforms.strength.value, 4); assert.equal(uniforms.speed.value, .25); assert.equal(uniforms.gustStrength.value, .3);
  updateFoliageUniforms(uniforms, props, 55, { vector: -4, gust: 0, gustFrequency: 2 });
  assert.deepEqual(uniforms.direction.value.toArray(), [0, 0, -1]);
  updateFoliageUniforms(uniforms, props, 60, { vector: [0, 0, 0], gust: 0 });
  assert.equal(uniforms.strength.value, 0); assert.ok(uniforms.direction.value.toArray().every(Number.isFinite));
});

test("tree atlas source retains leaf masks and normals while grass retains its original fragment path", () => {
  for (const species of ["oak", "birch", "pine"]) {
    const surface = createFoliageSurfaceMaterial({ species });
    const living = createFoliageMaterial(createFoliageUniforms(), { species });
    assert.equal(surface.positionNode, null, "atlas plants must not freeze a passing gust into their silhouette");
    assert.ok(surface.opacityNode && surface.normalNode && surface.colorNode);
    assert.ok(surface.maskShadowNode, "the shadow pass cannot rely on Three forwarding opacityNode");
    assert.equal(surface.alphaTest, living.alphaTest);
    assert.equal(surface.emissiveNode, null, "leaf backscatter must not become unlit emissive foliage");
    assert.ok(living.positionNode);
    surface.dispose(); living.dispose();
  }
  for (const species of ["grass", "wildflowers"]) {
    const surface = createFoliageSurfaceMaterial({ species });
    assert.equal(surface.opacityNode, null); assert.equal(surface.normalNode, null); assert.equal(surface.colorNode, null);
    assert.equal(surface.alphaTest, 0);
    assert.equal(getFoliageSurfaceTextures(species), null);
    surface.dispose();
  }
});

test("foliage matrix mirrors synchronize before Three uploads static attributes, including partial repacks", () => {
  function fixture(lateSync = false) {
    const source = new THREE.InstancedBufferAttribute(new Float32Array(1100 * 16), 16);
    const mirrors = [0, 1].map(() => new THREE.InstancedInterleavedBuffer(source.array, 16, 1));
    const unrelated = new THREE.InstancedInterleavedBuffer(new Float32Array(source.array.length), 16, 1);
    const compiled = [], sync = createFoliageMatrixSync(source, compiled);
    // The list is populated AFTER the material's TSL function creates its hook.
    for (const mirror of [...mirrors, unrelated]) for (let column = 0; column < 4; column++) compiled.push({ node: { attribute: new THREE.InterleavedBufferAttribute(mirror, 4, column * 4) } });
    const uploaded = new WeakMap(); let writes = 0;
    const attributes = new Attributes({
      createAttribute(attribute) { uploaded.set(attribute.data, attribute.data.array.slice()); },
      updateAttribute(attribute) {
        writes++;
        const mirror = attribute.data, destination = uploaded.get(mirror);
        if (mirror.updateRanges.length) for (const range of mirror.updateRanges) destination.set(mirror.array.subarray(range.start, range.start + range.count), range.start);
        else destination.set(mirror.array);
        mirror.clearUpdateRanges();
      },
    }, { createAttribute() {} });
    const draw = () => {
      if (!lateSync) sync(); // renderer.nodes.updateBefore()
      for (const mirror of mirrors) attributes.update(compiled.find(entry => entry.node.attribute.data === mirror).node.attribute, AttributeType.VERTEX);
      if (lateSync) sync(); // renderer.nodes.updateForRender(): OLD ordering
    };
    draw();
    const repack = (start, count, value) => {
      source.array.fill(value, start, start + count); source.clearUpdateRanges(); source.addUpdateRange(start, count); source.needsUpdate = true;
      draw();
    };
    return { source, mirrors, unrelated, uploaded, repack, draw, get writes() { return writes; } };
  }
  const actual = fixture();
  actual.repack(0, actual.source.array.length, 3);
  for (const mirror of actual.mirrors) assert.deepEqual(actual.uploaded.get(mirror), actual.source.array, "both position and blade-root mirrors see the repack in its FIRST draw");
  actual.repack(0, 3 * 16, 7);
  for (const mirror of actual.mirrors) {
    const values = actual.uploaded.get(mirror);
    assert.equal(values[0], 7); assert.equal(values[3 * 16 - 1], 7); assert.equal(values[3 * 16], 3);
    assert.deepEqual(values, actual.source.array, "partial prefix updates preserve the untouched instance tail");
  }
  assert.equal(actual.unrelated.version, 0, "array ownership excludes unrelated vertex buffers");
  assert.deepEqual(actual.source.updateRanges, [{ start: 0, count: 48 }], "one mirror's upload cannot consume the other mirror's source ranges");
  const writes = actual.writes;
  for (let frame = 0; frame < 20; frame++) actual.draw();
  assert.equal(actual.writes, writes, "unchanged static matrices produce no additional uploads");
  const old = fixture(true);
  old.repack(0, old.source.array.length, 9);
  for (const mirror of old.mirrors) assert.equal(old.uploaded.get(mirror)[0], 0, "the old late hook demonstrably misses the same-frame upload");
});
