import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createEffectElement, createEffectPreset, normalizeEffectTimeline, evaluateEffectElement, sampleEffectCurve } from "../src/engine/vfx/effectTimeline.js";
import { VfxComponent } from "../src/engine/components/VfxComponent.js";
import { rewriteComponentAssets } from "../src/editor/build/assetRefs.js";
import { legacySurfaceModules } from "../src/engine/vfx/legacyModules.js";

test("effect curves respect hold, interpolation and element start boundaries", () => {
  const e = createEffectElement("ring", "r"); e.start = 2; e.duration = 1;
  e.keys.scale = [{time:0,value:0},{time:1,value:4}];
  assert.equal(evaluateEffectElement(e,1).active,false);
  assert.equal(evaluateEffectElement(e,2).active,true);
  assert.equal(evaluateEffectElement(e,2.5).scale,2);
  assert.equal(evaluateEffectElement(e,3).active,false);
  assert.equal(sampleEffectCurve([{time:0,value:1,interpolation:"step"},{time:1,value:3}],.99),1);
  assert.equal(sampleEffectCurve([{time:0,value:1,interpolation:"step"},{time:1,value:3}],1),3);
  assert.equal(sampleEffectCurve([{time:0,value:0,interpolation:"smooth"},{time:1,value:1}],.25),.15625);
});
test("effect normalization preserves authored data while rejecting parent cycles", () => {
  const a=createEffectElement("group","a"),b=createEffectElement("sprite","b");b.parent="a";
  a.keys.scale=[{time:1,value:2},{time:0,value:1},{time:1,value:4}];
  const doc=normalizeEffectTimeline({elements:[a,b]});
  assert.deepEqual(doc.elements[0].keys.scale.map(k=>k.value),[1,4]);
  a.parent="b";assert.throws(()=>normalizeEffectTimeline({elements:[a,b]}),/cycle/);
  assert.throws(()=>normalizeEffectTimeline({elements:[b,b]}),/unique/);
  assert.equal(doc.elements[0].parent,"");
});
function runtime(document) {
  const updates=new Set(),events=new Map();
  const engine={onUpdate(fn){updates.add(fn);return()=>updates.delete(fn);},on(name,fn){events.set(name,fn);return()=>events.delete(name);},isPlaying:false};
  const entity={id:"fx",object3D:new THREE.Group(),engine};
  const c=new VfxComponent({timeline:document});c.entity=entity;c.onAttach();
  return {c,entity,updates,events,tick(dt){for(const fn of updates)fn(dt);}};
}
test("effect lifecycle: parent timing, pause, seek, wrap, restart and disposal",()=>{
  const p=createEffectElement("group","parent"),r=createEffectElement("ring","ring");
  p.start=1;p.duration=2;r.parent=p.id;r.duration=4;r.keys.scale=[{time:0,value:1},{time:4,value:5}];
  const {c,entity,tick,updates}=runtime({duration:4,loop:true,elements:[p,r]});
  c.play();assert.equal(c.elements.get("ring").group.visible,false);
  tick(1.5);assert.equal(c.elements.get("ring").group.visible,true);assert.equal(c.elements.get("ring").group.scale.x,2.5);
  c.pause();tick(1);assert.equal(c.time,1.5);
  c.seek(2);assert.equal(c.elements.get("ring").group.scale.x,3);
  c.resume();tick(3);assert.equal(c.time,1);
  c.stop();assert.equal(c.root.visible,false);c.play();assert.equal(c.root.visible,true);
  const old=c.root;c.setProp("timeline",createEffectPreset("Aura"));assert.equal(old.parent,null);
  c.onDetach();assert.equal(entity.object3D.children.length,0);assert.equal(updates.size,0);
});
test("effect once completion fires once and freezes until restarted",()=>{
  const {c,tick}=runtime({...createEffectPreset(),loop:false});let finished=0;c.on("finished",()=>finished++);
  c.play();tick(4);tick(4);assert.equal(finished,1);assert.equal(c.state,"stopped");assert.equal(c.time,3);c.onDetach();
});
test("timeline completion and hidden ownership disable particle work without resurrecting stopped effects", async () => {
  const particles = createEffectElement("particles", "sparks"); particles.duration = 20;
  particles.graph = { nodes: [{ id: "system", type: "system", props: { capacity: 4 } }], edges: [] };
  const { c, entity, tick, updates } = runtime({ duration: 1, loop: false, elements: [particles] });
  await new Promise((resolve) => setImmediate(resolve));
  const particle = c.elements.get("sparks").particle;
  try {
    assert.equal(c.root.visible, false, "stopped attach does not preview an effect implicitly");
    c.play(); assert.equal(particle.enabled, true);
    const parent = new THREE.Group(); parent.add(entity.object3D); parent.visible = false;
    tick(.2); assert.equal(particle.enabled, false); assert.equal(c.time, 0);
    parent.visible = true; tick(.2); assert.equal(particle.enabled, true);
    c.pause(); assert.equal(particle.paused, true); c.resume(); assert.equal(particle.paused, false);
    tick(2);
    assert.equal(c.state, "stopped"); assert.equal(particle.enabled, false); assert.equal(particle.paused, true);
    c.setEnabled(false); c.setEnabled(true);
    assert.equal(c.root.visible, false); assert.equal(particle.enabled, false);
  } finally { c.onDetach(); }
  assert.equal(updates.size, 0);
});
test("billboards use current parent transforms regardless of list order and follow the camera while paused", () => {
  const child = createEffectElement("sprite", "child"), parent = createEffectElement("group", "parent");
  child.parent = parent.id; parent.duration = child.duration = 5;
  parent.keys.rotationY = [{ time: 0, value: 0 }, { time: 2, value: 120 }];
  const { c, entity, tick } = runtime({ duration: 5, elements: [child, parent] });
  const camera = entity.engine.camera = new THREE.PerspectiveCamera(); camera.rotation.set(.2, .3, .1);
  const world = new THREE.Quaternion(), expected = new THREE.Quaternion();
  try {
    c.play(); tick(1);
    c.elements.get("child").object.getWorldQuaternion(world); camera.getWorldQuaternion(expected);
    assert.ok(world.angleTo(expected) < 1e-6, "child tracks new parent rotation in this frame");
    c.pause(); camera.rotation.y = -.8; tick(.5);
    c.elements.get("child").object.getWorldQuaternion(world); camera.getWorldQuaternion(expected);
    assert.ok(world.angleTo(expected) < 1e-6, "camera movement does not require unpausing the timeline");
  } finally { c.onDetach(); }
});
test("stale texture failures do not overwrite the replacement timeline error state", async () => {
  const original = THREE.TextureLoader.prototype.loadAsync;
  let rejectOld;
  THREE.TextureLoader.prototype.loadAsync = () => new Promise((_, reject) => { rejectOld = reject; });
  const sprite = createEffectElement("sprite", "textured"); sprite.texture = "old.png";
  const { c } = runtime({ elements: [sprite] });
  try {
    await Promise.resolve();
    c.setProp("timeline", { elements: [] });
    rejectOld(new Error("old failed")); await Promise.resolve(); await Promise.resolve();
    assert.equal(c.assetError, null);
  } finally { c.onDetach(); THREE.TextureLoader.prototype.loadAsync = original; }
});
test("texture completion respects a paused flipbook scrub immediately", async () => {
  const original = THREE.TextureLoader.prototype.loadAsync;
  let resolveTexture;
  THREE.TextureLoader.prototype.loadAsync = () => new Promise((resolve) => { resolveTexture = resolve; });
  const sprite = createEffectElement("sprite", "flipbook"); sprite.texture = "sheet.png"; sprite.columns = 4; sprite.rows = 2; sprite.fps = 8;
  const { c } = runtime({ duration: 5, elements: [sprite] });
  try {
    await Promise.resolve(); c.seek(.25);
    const texture = new THREE.Texture(); resolveTexture(texture); await Promise.resolve(); await Promise.resolve();
    assert.equal(texture.offset.x, .5); assert.equal(texture.offset.y, .5);
    assert.equal(c.state, "paused");
  } finally { c.onDetach(); THREE.TextureLoader.prototype.loadAsync = original; }
});
test("effect export includes layer textures, particle documents and inline graph textures",()=>{
  const component={type:"vfx",props:{timeline:{elements:[{texture:"C:/p/glow.png",asset:"C:/p/sparks.vfx",graph:{nodes:[{type:"system",props:{texture:"C:/p/spark.png"}}],edges:[]}}]}}};
  const docs=[];rewriteComponentAssets(component,{getSchema:()=>[],claim:p=>`assets/${p.split('/').at(-1)}`,claimDoc:p=>`assets/${p.split('/').at(-1)}`,add:(...a)=>docs.push(a)});
  const e=component.props.timeline.elements[0];assert.equal(e.texture,"assets/glow.png");assert.equal(e.asset,"assets/sparks.vfx");assert.equal(e.graph.nodes[0].props.texture,"assets/spark.png");assert.deepEqual(docs,[["vfx","C:/p/sparks.vfx"]]);
});
test("legacy surface module migration only upgrades referenced kinds under old VFX",()=>{
  const json={entities:[{components:[{type:"cloth"}],children:[{components:[{type:"water"}]}]}]};
  assert.deepEqual(legacySurfaceModules({modules:new Map()},json),[]);
  assert.deepEqual(legacySurfaceModules({modules:new Map([["vfx",{}]])},json),["cloth","water"]);
  assert.deepEqual(legacySurfaceModules({modules:new Map([["vfx",{}],["cloth",{}]])},json),["water"]);
});
