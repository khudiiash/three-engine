/**
 * ENABLING A LIGHT'S SHADOW MUST NOT REPLACE THE LIGHT.
 *
 * Reported 2026-09-10: "even when I simply enable shadow map on the light, it
 * freezes". `LightComponent.onPropChanged` used to answer `castShadow` (and
 * every other shadow-shaped prop) with `onDetach(); #buildLight()` — a NEW
 * THREE.Light, so a new `light.id`, a new shadow camera and target, a GI
 * contract the GI module has to re-claim, a ShadowFreeze state that starts
 * over, and an extra dispose of a map three was going to replace anyway.
 *
 * What three r185 actually does with the flip (read, with line numbers in
 * `onPropChanged`'s ledger): `castShadow` is its OWN bit in the scene's
 * `LightsNode` hash, so flipping it on the EXISTING light re-mints every lit
 * material exactly once, and `AnalyticLightNode.setup` builds or disposes the
 * branch from that. That wave is inherent — it is the shadow branch being
 * compiled into every receiver — and the light swap added nothing to it but
 * the identity churn. The swap now stays only where three offers no hash bit:
 * `shadowMapType` (a filter read once into a cached node), `shadowMode`,
 * `csm*` (a different custom node) and `kind`.
 *
 * No GPU: three's classes construct headlessly, and every claim here is about
 * what the component hands three, not what three draws with it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as THREE from "three/webgpu";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { Entity } from "../src/engine/Entity.js";
import { LightComponent } from "../src/engine/components/LightComponent.js";
import { registerComponent } from "../src/engine/components/registry.js";

// `addComponent(Class)` resolves the class to its type string and builds from
// the REGISTRY; unregistered, "light" becomes a data-only placeholder whose
// `.light` never exists.
registerComponent(LightComponent);

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */

/**
 * The engine a LightComponent touches: pre-render + renderer-rebuilt hooks
 * (a directional light subscribes to both), the shadow settings
 * `#configureShadow` reads, and a renderer whose `info.frame` is the
 * per-render counter the in-place guard watches. `webgpu` puts a WebGPU
 * backend flag on it so `#isCSMUsable` can say yes.
 */
function makeEngine({ webgpu = false } = {}) {
  const engine = {
    playing: false,
    entities: new Map(),
    rootEntities: [],
    viewOnlyComponents: new Set(),
    scene: { add() {}, remove() {} },
    settings: { shadow: { autoUpdate: true } },
    camera: null,
    renderer: {
      info: { frame: 0 },
      backend: { isWebGPUBackend: webgpu },
    },
    emit() {},
    on: () => () => {},
    onPreRender: () => () => {},
    /** A render happened: three's `nodeFrame.frameId` moved. */
    render() { engine.renderer.info.frame++; },
  };
  return engine;
}

function makeLight(engine, props = {}) {
  const entity = new Entity(engine, { name: "Sun" });
  const component = entity.addComponent(LightComponent, props);
  return { entity, component };
}

/* -------------------------------------------------------------------------- */
/* (a) castShadow in place                                                     */

test("toggling castShadow keeps the same THREE.Light and writes light.castShadow", () => {
  const engine = makeEngine();
  const { component } = makeLight(engine, { kind: "directional", castShadow: false });
  const light = component.light;
  assert.ok(light.isDirectionalLight);
  assert.equal(light.castShadow, false);
  const target = light.target;
  const shadowCamera = light.shadow.camera;
  const disposed = [];
  light.dispose = () => disposed.push("light");
  light.shadow.map = { dispose: () => disposed.push("map") };

  component.setProp("castShadow", true);
  engine.render();
  assert.equal(component.light, light, "the light object must survive the flip");
  assert.equal(light.castShadow, true);
  assert.equal(light.target, target, "the target survives");
  assert.equal(light.shadow.camera, shadowCamera, "the shadow camera survives");
  // Everything #buildLight publishes after construction is still right.
  assert.equal(light.userData.giShadowMode, "map");
  assert.deepEqual(light.userData.giShadowMaps(), [light.shadow], "the GI contract sees the map");
  assert.equal(light.shadow.mapSize.width, 2048, "the authored map size is applied");
  assert.equal(light.shadow.needsUpdate, true, "a light born under a frozen-shadow project gets its one render");
  assert.equal(light.shadow.shadowNode, undefined, "no custom node: three's own map lookup");
  assert.deepEqual(disposed, [], "the wave disposes the old branch, not the component — no early null-shadowMap window");

  component.setProp("castShadow", false);
  engine.render();
  assert.equal(component.light, light, "and back off, still the same light");
  assert.equal(light.castShadow, false);
  assert.deepEqual(light.userData.giShadowMaps(), [], "the contract reports no maps while off");
  assert.deepEqual(disposed, []);
});

test("writing the same castShadow value again is a no-op, not a wave", () => {
  const engine = makeEngine();
  const { component } = makeLight(engine, { kind: "point", castShadow: true });
  const light = component.light;
  const disposed = [];
  light.dispose = () => disposed.push("light");
  component.setProp("castShadow", true);
  assert.equal(component.light, light);
  assert.equal(light.castShadow, true);
  assert.deepEqual(disposed, []);
});

test("an ambient light has no shadow and simply keeps its object", () => {
  const engine = makeEngine();
  const { component } = makeLight(engine, { kind: "ambient" });
  const light = component.light;
  component.setProp("castShadow", true);
  assert.equal(component.light, light);
  assert.equal(light.shadow, undefined);
});

/* -------------------------------------------------------------------------- */
/* (b) shadowMapType — no hash bit, so the swap stays                          */

test("changing shadowMapType still replaces the light — a filter swap has no hash bit to ride", () => {
  const engine = makeEngine();
  const { component } = makeLight(engine, { kind: "directional", castShadow: true, shadowMapType: "PCFSoftShadowMap" });
  const before = component.light;
  assert.equal(before.shadow.type, THREE.PCFSoftShadowMap);
  assert.equal(before.shadow.filterNode, undefined);

  component.setProp("shadowMapType", "PCSSShadowMap");
  const after = component.light;
  assert.notEqual(after, before, "three reads shadow.filterNode ONCE into the ShadowNode's cached graph; only a new light.id re-mints it");
  assert.equal(after.shadow.type, THREE.PCFShadowMap, "PCSS rides three's PCF sampler");
  assert.ok(after.shadow.filterNode, "with the PCSS filter on the new light");
  assert.equal(after.castShadow, true);
});

/* -------------------------------------------------------------------------- */
/* (c) kind                                                                    */

test("changing kind still replaces the light", () => {
  const engine = makeEngine();
  const { component } = makeLight(engine, { kind: "directional", castShadow: true });
  const before = component.light;
  component.setProp("kind", "point");
  assert.notEqual(component.light, before);
  assert.ok(component.light.isPointLight);
  assert.equal(component.light.castShadow, true, "castShadow carried onto the new light");
});

/* -------------------------------------------------------------------------- */
/* (d) map size disposes the map exactly once                                  */

test("a map size change keeps the light and disposes the shadow map exactly once", () => {
  const engine = makeEngine();
  const { component } = makeLight(engine, { kind: "directional", castShadow: true });
  const light = component.light;
  let mapDisposes = 0;
  let lightDisposes = 0;
  light.shadow.map = { dispose: () => { mapDisposes++; } };
  light.dispose = () => { lightDisposes++; };

  component.setProp("shadowMapWidth", 1024);
  assert.equal(component.light, light);
  assert.equal(light.shadow.mapSize.width, 1024);
  assert.equal(light.shadow.mapSize.height, 2048);
  assert.equal(mapDisposes, 1, "the map is disposed once so three reallocates it at the new size");
  assert.equal(lightDisposes, 0, "the light itself is never disposed for a size change");
});

/* -------------------------------------------------------------------------- */
/* the one case that must still swap: two flips with no render between         */

test("two castShadow flips with no render in between fall back to the swap (no wave would come)", () => {
  const engine = makeEngine();
  const { component } = makeLight(engine, { kind: "directional", castShadow: false });
  const first = component.light;

  component.setProp("castShadow", true);
  assert.equal(component.light, first, "first flip: in place, the hash moved and a wave is due");

  // No render happened. Flipping back lands the hash exactly where the
  // compiled materials already are — nothing would re-mint, so the old
  // branch (and any custom node the first flip disposed) would stay compiled
  // in. A new light.id is the wave.
  component.setProp("castShadow", false);
  assert.notEqual(component.light, first, "second flip before a render: the light is swapped");
  assert.equal(component.light.castShadow, false);

  // After a render the next flip is in place again — and so is the one after
  // the next render, because the fresh light started the guard over.
  engine.render();
  const second = component.light;
  component.setProp("castShadow", true);
  assert.equal(component.light, second);
  engine.render();
  component.setProp("castShadow", false);
  assert.equal(component.light, second);
});

test("the A/B hatch restores the swap", () => {
  const engine = makeEngine();
  const { component } = makeLight(engine, { kind: "directional", castShadow: false });
  const before = component.light;
  globalThis.__lightCastShadowInPlace = false;
  try {
    component.setProp("castShadow", true);
    assert.notEqual(component.light, before);
    assert.equal(component.light.castShadow, true);
  } finally {
    delete globalThis.__lightCastShadowInPlace;
  }
});

/* -------------------------------------------------------------------------- */
/* the CSM node follows castShadow on the same light                           */

test("castShadow off disposes our CSM node and clears the slot; on rebuilds it", () => {
  const engine = makeEngine({ webgpu: true });
  const { component } = makeLight(engine, { kind: "directional", castShadow: true, csm: true });
  const light = component.light;
  const csm = light.shadow.shadowNode;
  assert.ok(csm instanceof CSMShadowNode, "a WebGPU directional light with csm on carries the CSM node");
  assert.equal(csm.fade, true, "csmFade reaches the node");

  engine.render();
  component.setProp("castShadow", false);
  assert.equal(component.light, light, "still the same light");
  assert.equal(light.castShadow, false);
  assert.equal(light.shadow.shadowNode, undefined, "the slot is handed back — no CSM without shadows");
  assert.equal(light.shadow.autoUpdate, true, "and re-armed the safe way (autoUpdate, never needsUpdate alone)");

  engine.render();
  component.setProp("castShadow", true);
  assert.equal(component.light, light);
  const rebuilt = light.shadow.shadowNode;
  assert.ok(rebuilt instanceof CSMShadowNode, "the CSM node is rebuilt for the new branch");
  assert.notEqual(rebuilt, csm, "a fresh one — the old was disposed with its cascades");
  assert.equal(light.shadow.filterNode !== undefined, true, "the radius-aware PCF filter the cascades clone");
});

/* -------------------------------------------------------------------------- */
/* gi mode: our placeholder, and never the GI module's node                    */

test("gi mode: the placeholder is ours to set and clear; a node the GI module owns is never touched", () => {
  const engine = makeEngine();
  const { component } = makeLight(engine, { kind: "directional", castShadow: true, shadowMode: "gi" });
  const light = component.light;
  assert.equal(light.userData.giShadowMode, "gi");
  assert.equal(light.castShadow, true, "castShadow STAYS true: three compiles a shadow branch only for casters");
  assert.equal(light.shadow.autoUpdate, false, "the 16x16 fallback map is frozen");
  assert.equal(light.shadow.mapSize.width, 16);
  const placeholder = light.shadow.shadowNode;
  assert.ok(placeholder && placeholder.isNode === true, "the inert float(1) sits in the slot from frame 1");
  assert.deepEqual(light.userData.giShadowMaps(), [], "the GI module traces this light itself");

  engine.render();
  component.setProp("castShadow", false);
  assert.equal(component.light, light);
  assert.equal(light.userData.giShadowMode, "map", "no shadows: nothing for the GI module to trace");
  assert.equal(light.shadow.shadowNode, undefined, "our placeholder is cleared");
  assert.equal(light.shadow.mapSize.width, 2048, "the map configuration is the authored one again");

  engine.render();
  component.setProp("castShadow", true);
  assert.equal(light.userData.giShadowMode, "gi");
  assert.ok(light.shadow.shadowNode?.isNode === true, "and the placeholder is back");
  assert.equal(light.shadow.mapSize.width, 16);

  // The GI module claimed the light: its node is in the slot now. Both flips
  // must leave it alone — its release path (GISystem#releaseLightShadowNode)
  // hands the light back only when it finds its OWN node there.
  const foreign = { isNode: true, owner: "gi" };
  light.shadow.shadowNode = foreign;
  engine.render();
  component.setProp("castShadow", false);
  assert.equal(light.shadow.shadowNode, foreign, "off: the GI module's node stays for the module to release");
  engine.render();
  component.setProp("castShadow", true);
  assert.equal(light.shadow.shadowNode, foreign, "on: the GI module still owns the slot");
  assert.equal(component.light, light);
});

/* -------------------------------------------------------------------------- */
/* the structural classification is unchanged (Component.js is not ours here)  */

test("castShadow is NOT structural any more — nothing leaves the graph on the in-place path", () => {
  const engine = makeEngine();
  const { component } = makeLight(engine, { kind: "directional" });
  assert.equal(component.isStructuralProp("castShadow"), false);
  assert.equal(component.isStructuralProp("kind"), true);
  assert.equal(component.isStructuralProp("intensity"), false);
});
