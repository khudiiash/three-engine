import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import {
  applyMaterialPipeline,
  MATERIAL_PIPELINE_DEFAULTS,
  MATERIAL_VOLUME_PIPELINE_DEFAULTS,
} from "../src/engine/materialAsset.js";

test("applies serialized surface pipeline state", () => {
  const material = new THREE.MeshPhysicalNodeMaterial();
  applyMaterialPipeline(material, {
    cullMode: "none",
    depthTest: false,
    depthWrite: false,
    depthFunc: "greater",
    colorWrite: false,
    transparent: true,
    blendMode: "additive",
    alphaTest: 0.35,
    alphaHash: true,
    premultipliedAlpha: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: 3,
    wireframe: true,
    toneMapped: false,
    fog: false,
  });

  assert.equal(material.side, THREE.DoubleSide);
  assert.equal(material.depthTest, false);
  assert.equal(material.depthWrite, false);
  assert.equal(material.depthFunc, THREE.GreaterDepth);
  assert.equal(material.colorWrite, false);
  assert.equal(material.transparent, true);
  assert.equal(material.blending, THREE.AdditiveBlending);
  assert.equal(material.alphaTest, 0.35);
  assert.equal(material.alphaHash, true);
  assert.equal(material.premultipliedAlpha, true);
  assert.equal(material.polygonOffset, true);
  assert.equal(material.polygonOffsetFactor, -2);
  assert.equal(material.polygonOffsetUnits, 3);
  assert.equal(material.wireframe, true);
  assert.equal(material.toneMapped, false);
  assert.equal(material.fog, false);
});

test("uses volume-safe defaults for partially authored volume state", () => {
  const material = new THREE.VolumeNodeMaterial();
  material.userData.isVolumeMaterial = true;
  applyMaterialPipeline(material, { alphaTest: 0.2 });

  assert.equal(material.side, THREE.BackSide);
  assert.equal(material.depthTest, MATERIAL_VOLUME_PIPELINE_DEFAULTS.depthTest);
  assert.equal(material.depthWrite, MATERIAL_VOLUME_PIPELINE_DEFAULTS.depthWrite);
  assert.equal(material.transparent, MATERIAL_VOLUME_PIPELINE_DEFAULTS.transparent);
  assert.equal(material.blending, THREE.AdditiveBlending);
  assert.equal(material.alphaTest, 0.2);
  assert.equal(MATERIAL_PIPELINE_DEFAULTS.depthWrite, true);
});
