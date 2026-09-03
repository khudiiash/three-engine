import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  captureGiMaterialLightShape,
  copyGiLightState,
  giMaterialLightShapeMatches,
} from "../src/modules/gi/giMaterialLightLifecycle.js";

function fixture() {
  const node = () => ({});
  return {
    id: 7,
    intensityUniform: node(),
    normalOffset: node(),
    emitterSlots: [node()],
    giIrradianceNode: node(),
    giEmitterShadowNode: node(),
    giRadianceNode: node(),
    giPositionNode: node(),
    giScreenTexel: node(),
    giViewProj: node(),
    giNestedView: node(),
    giEmitterShadowTexel: node(),
    bvhReflectTexture: node(),
    bvhReflectColorTexture: node(),
    giEnvMiss: { node: node(), intensity: node(), rotY: node() },
    giProbes: { node: node(), slots: [node()] },
    emitterTileKeyed: true,
    approximateReflections: false,
    bvhReflectShaded: true,
    hitLighting: false,
    shadowRange: node(),
  };
}

test("material light shape accepts wrapper renewal but rejects captured-node changes", () => {
  const light = fixture();
  const snapshot = captureGiMaterialLightShape(light);
  light.giEnvMiss = { ...light.giEnvMiss };
  light.giProbes = { ...light.giProbes };
  assert.equal(giMaterialLightShapeMatches(snapshot, light), true);

  light.normalOffset = {};
  assert.equal(giMaterialLightShapeMatches(snapshot, light), false);
});

test("material light shape rejects capability/slot changes", () => {
  const light = fixture();
  const snapshot = captureGiMaterialLightShape(light);
  light.bvhReflectTexture = null;
  assert.equal(giMaterialLightShapeMatches(snapshot, light), false);

  const second = fixture();
  const secondSnapshot = captureGiMaterialLightShape(second);
  second.emitterSlots = [...second.emitterSlots];
  assert.equal(giMaterialLightShapeMatches(secondSnapshot, second), false);
});

test("slow-path transfer preserves GI state without copying light identity", () => {
  const source = fixture();
  const target = { id: 99 };
  copyGiLightState(target, source);
  assert.equal(target.id, 99);
  assert.equal(target.normalOffset, source.normalOffset);
  assert.equal(target.giIrradianceNode, source.giIrradianceNode);
  assert.equal(target.shadowRange, source.shadowRange);
});

test("GISystem keeps compute-only rebuilds off the material cache path", async () => {
  const source = await readFile(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
  assert.match(source, /#dispose\(\{ preserveMaterialLight: true \}\)/);
  assert.match(source, /giMaterialLightShapeMatches\(previousMaterialShape, light\)/);
  assert.match(source, /#compileWave\(\{ materialWarm \}\)/);
  assert.match(source, /preserveMaterialLight \? false : purgeNodeBuilderCache/);
  assert.match(source, /Object\.assign\(light, \{[\s\S]*emitterSlots: null,[\s\S]*giIrradianceNode: null,[\s\S]*bvhReflectTexture: null/);
  assert.match(source, /if \(materialWarm\) this\._warmedScenePass = null/);
});
