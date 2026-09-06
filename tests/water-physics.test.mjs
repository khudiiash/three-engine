import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { PhysicsSystem, bodyDensitySI } from '../src/modules/physics-rapier/PhysicsSystem.js';
import { WaterPhysics, WATER_PHYSICS_DEFAULTS, queryWaterSurface } from '../src/engine/vfx/waterPhysics.js';
await RAPIER.init();
function rig() {
  const engine={playing:true,scene:new THREE.Scene(),on:()=>()=>{},onUpdate:()=>()=>{},config:{},entities:new Map()};
  const physics=new PhysicsSystem(engine,RAPIER);physics.world=new RAPIER.World({x:0,y:-9.81,z:0});physics.eventQueue=new RAPIER.EventQueue(true);
  const props={...WATER_PHYSICS_DEFAULTS,width:20,height:20,waterDepth:20,waveHeight:0};
  const wakes=[];const component={enabled:true,graphEnabled:true,entity:{enabled:true},props,resolvedProps:props,simulation:{mesh:new THREE.Mesh(),uniforms:{simTime:{value:0}},addWaterImpulse:(...args)=>wakes.push(args)}};
  const water=new WaterPhysics(component);engine.waterSurfaces=new Set([{applyBuoyancy:(p,dt)=>water.step(p,dt)}]);
  const add=(mass,size=1,x=0)=>{
    const body=physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x,1,0));
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(size/2,size/2,size/2).setMass(mass),body);
    const entity={object3D:new THREE.Object3D(),getComponent:()=>null};physics.dynamicBodies.push({body,entity});return body;
  };
  const step=(seconds)=>{for(let i=0;i<seconds*60;i++){component.simulation.uniforms.simTime.value+=1/60;physics.update(1/60);}};
  return {physics,component,add,step,wakes,dispose:()=>{physics.world.free();physics.eventQueue.free();}};
}
test('actual fixed-step Rapier buoyancy floats low density and sinks high density; equal mass different volume differs',()=>{
  const r=rig();try{
    const light=r.add(500,1,-4),dense=r.add(2000,1,0),small=r.add(500,.5,4),defaultMass=r.add(1,1,7);
    r.step(12);
    assert.ok(Math.abs(light.translation().y)<.12,`half-submerged equilibrium ${light.translation().y}`);
    assert.ok(dense.translation().y<-2,`dense sinks ${dense.translation().y}`);
    assert.ok(small.translation().y<-2,`same mass smaller volume sinks ${small.translation().y}`);
    assert.ok(defaultMass.translation().y>.3 && defaultMass.translation().y<.8,`light default floats stably ${defaultMass.translation().y}`);
    assert.ok(r.wakes.length>0,'entry displaces surface');
    assert.ok(r.component.waterPhysicsStats.displacedVolume>0);
  }finally{r.dispose();}
});
test('finite water bounds and disabling interaction remove force; drag damps motion',()=>{
  const r=rig();try{
    const body=r.add(1000);body.setTranslation({x:0,y:-2,z:0},true);body.setLinvel({x:4,y:0,z:0},true);
    r.step(1);assert.ok(Math.abs(body.linvel().x)<.5);
    r.component.enabled=false;const before=body.translation().y;r.step(1);assert.ok(body.translation().y<before-3);
    assert.equal(queryWaterSurface(r.component.simulation.mesh,r.component.props,0,{x:30,y:0,z:0}),null);
  }finally{r.dispose();}
});
test('transformed water height and footprint follow source simulation mesh',()=>{
  const mesh=new THREE.Mesh();mesh.position.set(3,5,-2);mesh.scale.set(2,1,3);
  assert.equal(queryWaterSurface(mesh,{width:2,height:2,waveHeight:0},0,{x:3,y:0,z:-2}).height,5);
  assert.equal(queryWaterSurface(mesh,{width:2,height:2,waveHeight:0},0,{x:6,y:0,z:-2}),null);
});

test('sphere displacement uses its actual volume, not its bounding box',()=>{
  const r=rig();try {
    const body=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,1,0));
    const volume=4/3*Math.PI*.5**3;
    r.physics.world.createCollider(RAPIER.ColliderDesc.ball(.5).setMass(volume*500),body);
    r.physics.dynamicBodies.push({body,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
    r.step(12);
    assert.ok(Math.abs(body.translation().y)<.1,`sphere halfvolume equilibrium ${body.translation().y}`);
  } finally {r.dispose();}
});

// ⭐ THE REGRESSION THAT MADE BUOYANCY DO NOTHING (2026-09-05). The user's pool
// is a Plane rotated -90° with a Z scale of 5.32, which gives the simulation
// mesh a world Y scale of 5.32 — and the old horizontality guard read
// `|inverse.elements[5]| < .2`, i.e. 1/scaleY, so it rejected the surface as
// "tilted" and every query answered null. Nothing floated, nothing sank and no
// error was raised. Every test above scales by at most 3 and none could see it.
test('a water plane scaled thicker than 5 units still has a surface (the 1/scale tilt guard)',()=>{
  const entity=new THREE.Object3D();
  entity.position.set(0,3.056076523902334,0);
  entity.rotation.set(-Math.PI/2,0,0);
  entity.scale.set(42.575011112071216,42.575011112071216,5.321876389008902);
  const mesh=new THREE.Mesh();
  mesh.matrixAutoUpdate=false;
  mesh.matrix.makeRotationX(Math.PI/2);
  entity.add(mesh);
  entity.updateMatrixWorld(true);
  const props={width:1,height:1,waveHeight:0,waterDepth:2};
  const surface=queryWaterSurface(mesh,props,0,{x:0,y:3,z:0});
  assert.ok(surface,'scaled water plane must still answer a surface height');
  assert.ok(Math.abs(surface.height-3.056076523902334)<1e-6,`surface at the plane ${surface.height}`);
  // waterDepth is LOCAL, so the world volume is depth × the mesh's world rise.
  assert.ok(Math.abs(surface.height-surface.bottom-2*5.321876389008902)<1e-6,`volume depth ${surface.height-surface.bottom}`);
  // Outside the (unit-geometry, 42.6× scaled) footprint there is still no water.
  assert.equal(queryWaterSurface(mesh,props,0,{x:40,y:3,z:0}),null);
});

test('a vertical water plane is rejected, and rejection is a tilt and not a scale',()=>{
  const flat=new THREE.Mesh();flat.scale.set(1,40,1);flat.updateMatrixWorld(true);
  assert.ok(queryWaterSurface(flat,{width:4,height:4,waveHeight:0},0,{x:0,y:0,z:0}),'a tall scale is not a tilt');
  const wall=new THREE.Mesh();wall.rotation.set(0,0,Math.PI/2);wall.updateMatrixWorld(true);
  assert.equal(queryWaterSurface(wall,{width:4,height:4,waveHeight:0},0,{x:0,y:0,z:0}),null,'a 90° tilt has no heightfield');
});

// A BOX SOURCE IS THE VOLUME. `waterDepth` stops being an authored optical
// number and becomes the box's own height, so a body sinks to the box floor and
// not to an invented depth — and the footprint is the box's X/Z, not a plane's.
test('a box water volume floats and sinks against its own geometry',()=>{
  const r=rig();try{
    // The component's resolved props are what physics reads; a Box source fills
    // them from geometry (GridSimulationComponent.sourceProps).
    Object.assign(r.component.props,{width:6,height:6,waterDepth:4,waveHeight:0});
    Object.assign(r.component.resolvedProps,r.component.props);
    const cork=r.add(200,1,-2),stone=r.add(4000,1,2);
    r.step(14);
    assert.ok(cork.translation().y>-.4,`the light body rides the surface ${cork.translation().y}`);
    assert.ok(stone.translation().y<-2,`the heavy one goes down ${stone.translation().y}`);
    // Same volume, different mass: the ONLY thing separating them is mass.
    assert.ok(cork.translation().y-stone.translation().y>1.5,'mass alone decides');
    // Outside the box's footprint there is no water at all.
    assert.equal(queryWaterSurface(r.component.simulation.mesh,r.component.resolvedProps,0,{x:4,y:0,z:0}),null);
  }finally{r.dispose();}
});

// ⭐ "IT JUMPS OFF THE SURFACE AS IT WAS CONCRETE" (user, 2026-09-05). A 4 m
// crate authored at 0.9 kg is 70,000x lighter than the water it displaces, so
// its buoyancy spring is k = rho*g*A = 157 kN/m against 0.9 kg — 418 rad/s,
// seven times the fixed step. Explicitly integrated it delivered a full
// terminal velocity every submerged frame and the crate pogoed out of the
// water. The implicit spring term must settle it without touching where it
// floats.
test('an absurdly light body settles on the surface instead of pogoing',()=>{
  const r=rig();try{
    const body=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,3,0));
    r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(2,2,2).setMass(.9),body);
    r.physics.dynamicBodies.push({body,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
    r.step(10);
    const heights=[];
    for(let i=0;i<180;i++){r.component.simulation.uniforms.simTime.value+=1/60;r.physics.update(1/60);heights.push(body.translation().y);}
    const low=Math.min(...heights),high=Math.max(...heights);
    assert.ok(high-low<.25,`settled, not pogoing: swing ${(high-low).toFixed(3)} m over 3 s`);
    // And it still floats where Archimedes says: 0.9 kg displaces 0.0009 m^3,
    // so a 4 m cube sits with its underside a fraction of a millimetre wet.
    assert.ok(Math.abs(body.translation().y-2)<.05,`riding the waterline ${body.translation().y}`);
    assert.ok(Math.abs(body.linvel().y)<.3,`and not still climbing ${body.linvel().y}`);
  }finally{r.dispose();}
});

// The wake is a DISPLACEMENT PAIR (jeantimex/webgpu-water's `sphere.frag`):
// the body's footprint is released where it was and pressed in where it is. Two
// things must hold, and the first is why the water stopped behaving like jelly.
test('a floating body at rest injects nothing, and its footprint is its waterplane',()=>{
  const r=rig();try{
    const body=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,2.4,0));
    r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(2,2,2).setDensity(500),body);
    r.physics.dynamicBodies.push({body,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
    r.step(14);
    r.wakes.length=0;
    r.step(4);
    // ⚠ NOT "a pair every step". It used to be, and asserting the MECHANISM
    // rather than the PROPERTY is what let the chatter through: a body riding a
    // swell walks the waterline across the quadrature grid, so `plane` and
    // `volume` step, so the pair fired every frame with a slightly different
    // footprint each time and left a ring behind. The deadband and the
    // footprint low-pass in `waterPhysics.js` mean a settled body may emit
    // nothing at all for seconds, which is the point.
    const deepest=r.wakes.length?Math.max(...r.wakes.map(([,,,depth])=>Math.abs(depth))):0;
    const net=r.wakes.reduce((sum,[,,,depth])=>sum+depth,0);
    // ⭐ THE CANCELLATION. A rate-based impulse accumulated for as long as a body
    // sat there and rang it off; a displacement pair sums to zero — and one that
    // is never issued sums to zero too.
    assert.ok(Math.abs(net)<Math.max(deepest*.05,1e-9),`at rest the pair cancels: net ${net} against ${deepest}`);
    // The footprint, whenever one IS issued, is the waterplane and not the
    // draught: sqrt(16/pi) = 2.26 m, against cbrt(displaced volume).
    r.wakes.length=0;
    body.setLinvel({x:3,y:0,z:0},true);
    r.step(.5);
    const widest=Math.max(...r.wakes.map(([,,radius])=>radius));
    assert.ok(widest>1.5,`footprint is the waterplane, not the draught: ${widest.toFixed(2)} m`);
  }finally{r.dispose();}
});

test('a body that moves leaves the water it was holding down behind it',()=>{
  const r=rig();try{
    const body=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,2.4,0));
    r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(2,2,2).setDensity(500),body);
    r.physics.dynamicBodies.push({body,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
    r.step(14);
    r.wakes.length=0;
    body.setLinvel({x:4,y:0,z:0},true);
    r.step(.4);
    const xs=r.wakes.map(([x])=>x);
    assert.ok(Math.max(...xs)-Math.min(...xs)>.3,`the released and pressed footprints separate ${Math.max(...xs)-Math.min(...xs)}`);
    const net=r.wakes.reduce((sum,[,,,depth])=>sum+depth,0);
    const deepest=Math.max(...r.wakes.map(([,,,depth])=>Math.abs(depth)));
    assert.ok(Math.abs(net)<deepest*.6,'and the pair still very nearly conserves what it moved');
  }finally{r.dispose();}
});

// ⭐ DENSITY IS SCALE-FREE, WHICH IS THE WHOLE POINT. An absolute mass is a
// property of one size: scale the object and the number that floated it is
// wrong by the cube of the scale, which is why "still not floating" survived
// three correct buoyancy fixes (user, 2026-09-05). 500 kg/m^3 floats half out
// of the water at ANY size.
test('a body authored by DENSITY floats the same at any scale',()=>{
  const r=rig();try{
    const float=(half)=>{
      const body=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(half*4,half+1,0));
      r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(half,half,half).setDensity(500),body);
      r.physics.dynamicBodies.push({body,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
      return body;
    };
    const small=float(.5),large=float(2);
    r.step(16);
    // Half-submerged means the centre rides the waterline, whatever the size.
    assert.ok(Math.abs(small.translation().y)<.15,`0.5 m cube at 500 kg/m3 ${small.translation().y}`);
    assert.ok(Math.abs(large.translation().y)<.25,`2 m cube at the SAME density ${large.translation().y}`);
    // And density still decides float vs sink.
    const stone=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-6,1,0));
    r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(1,1,1).setDensity(2400),stone);
    r.physics.dynamicBodies.push({body:stone,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
    r.step(10);
    assert.ok(stone.translation().y<-3,`2400 kg/m3 sinks ${stone.translation().y}`);
  }finally{r.dispose();}
});

// ⭐ THE SUBMERGED FRACTION EQUALS THE DENSITY RATIO. This is the whole of
// Archimedes and it is the answer to "0.96 against water 1.0 and it sinks like
// a rock" (user, 2026-09-05): 0.96 floats with 96% of itself UNDER, which on a
// 5 m cube leaves 20 cm showing. Also pins that the ratio is what matters — the
// same pair at 1000/960 must behave identically to 1/0.96.
test('the fraction submerged is the body density, because water is 1',()=>{
  // ⚠ THIS USED TO SWEEP THE WATER DENSITY TOO, and cannot any more: water is a
  // CONSTANT 1 g/cm³ now (`WATER_CONSTANTS`) and the constant deliberately beats
  // anything a saved scene left in its props. That is the whole point of the
  // unit — with water pinned at 1, the authored density IS the fraction that
  // ends up under the surface, and "will this float?" is "is it under 1?".
  const settle=(bodyDensity)=>{
    const r=rig();try{
      Object.assign(r.component.props,{width:40,height:40,waterDepth:20,waveHeight:0});
      Object.assign(r.component.resolvedProps,r.component.props);
      const body=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,3,0));
      r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(2.5,2.5,2.5).setDensity(bodyDensitySI(bodyDensity)),body);
      r.physics.dynamicBodies.push({body,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
      r.step(40);
      return (2.5-body.translation().y)/5;   // fraction of the 5 m cube under water
    } finally { r.dispose(); }
  };
  for(const density of [.5,.05,.96]) {
    const fraction=settle(density);
    assert.ok(Math.abs(fraction-density)<.03,
      `body at ${density} g/cm³: ${(fraction*100).toFixed(1)}% under, expected ${(density*100).toFixed(0)}%`);
  }
  // And the legacy unit reaches the same place, which is what the migration is for.
  assert.ok(Math.abs(settle(960)-.96)<.03,'a scene authored in kg/m³ still floats where it did');
});

// ══ A SUBMERGING BODY MUST NOT INJECT A NEEDLE ══════════════════════════════
//
// `plane` is the WATERPLANE — the area of the quadrature cells that straddle
// the surface — so it collapses to zero as a body finishes going under while
// the displaced volume does not. The old footprint `sqrt(plane/pi)` and depth
// `volume/plane` therefore ran to zero and to infinity together: a dent one
// cell wide, as deep as the impulse clamp allowed, re-emitted every frame. Both
// halves of "the ripple itself is too small compared to the object size" and
// "vibrates too fast even after the object went completely underwater" (user,
// 2026-09-05) are that one division.
test('a body that sinks stops denting the surface, and its footprint never collapses',()=>{
  const r=rig();try{
    const body=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,3,0));
    r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(1,1,1).setDensity(2600),body);
    r.physics.dynamicBodies.push({body,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
    // Entry and the crossing itself: whatever is emitted here must stay the
    // size of the BODY, never a sub-grid spike.
    r.step(3);
    const crossing=r.wakes.filter(([,,radius])=>radius>0);
    assert.ok(crossing.length>0,'going under does disturb the surface');
    const narrowest=Math.min(...crossing.map(([,,radius])=>radius));
    const deepest=Math.max(...crossing.map(([,,,depth])=>Math.abs(depth)));
    // sqrt(4/pi) = 1.13 m for a 2 m cube; half of that is already generous.
    assert.ok(narrowest>.5,`the footprint stays the body's own size: ${narrowest.toFixed(3)} m`);
    // The static draught of a 2 m cube can never exceed 2 m, and the entry adds
    // a tenth of a second of the descent — about 0.75 m from this 3 m drop. A
    // needle would be tens of metres deep and one cell wide, which is what the
    // radius assertion above and this one bound from either side.
    assert.ok(deepest<3,`and the dent stays bounded by the draught plus the entry: ${deepest.toFixed(3)} m`);
    // Well under by now, and the surface has closed over it.
    assert.ok(body.translation().y<-1,`the body has sunk clear ${body.translation().y.toFixed(2)}`);
    // ⚠ Let the dent FADE first. Going under legitimately releases the water
    // the body was holding down — that is the point — so what is being asked
    // here is whether anything is still being injected once it has.
    r.step(2);
    r.wakes.length=0;
    r.step(3);
    const residual=r.wakes.reduce((sum,[,,,depth])=>sum+Math.abs(depth),0);
    assert.ok(residual<.01,`a body long submerged dents nothing at all: ${residual.toExponential(2)}`);
  }finally{r.dispose();}
});

// ⛔ AND A BODY THAT FLOATS DEEP STILL MAKES A SPLASH. Fading the dent by how
// much of the body is in the AIR looks like the same idea as fading it by
// whether the body is at the surface, and is not: a crate at 0.96 density rides
// 96 % under, so that ratio is 0.04 and a five-metre box entered the water
// without disturbing it at all (user video, 2026-09-05). The waterplane is the
// measure that says "this body is at the surface", and it is ~1 for anything
// afloat however deep it sits.
test('a body floating deep still dents the surface by its draught',()=>{
  const r=rig();try{
    const body=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,4,0));
    r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(1,1,1).setDensity(960),body);
    r.physics.dynamicBodies.push({body,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
    // THE ENTRY ITSELF — which is what the video shows, and what was missing.
    r.step(3);
    const deepest=Math.max(...r.wakes.map(([,,,depth])=>Math.abs(depth)));
    const widest=Math.max(...r.wakes.map(([,,radius])=>radius));
    // draught = volume/silhouette = 0.96 * 2 m, so the 0.15 default gives about
    // 0.29 m of dent. Fading by `emerged/volume` gave 0.012 — a five-metre box
    // entering the water without disturbing it.
    assert.ok(deepest>.1,`the dent is the draught, not the freeboard: ${deepest.toFixed(3)} m`);
    assert.ok(widest>.9,`and it is the body's own width: ${widest.toFixed(2)} m`);
    // ...and it really is floating, not resting on the bottom twenty metres down.
    r.step(25);
    const y=body.translation().y;
    assert.ok(y>-1.1&&y<.2,`riding the waterline at 0.96 density: ${y.toFixed(3)}`);
  }finally{r.dispose();}
});

// ══ UNITS ═══════════════════════════════════════════════════════════════════
test('body density is authored in g/cm3, and old kg/m3 scenes still work',()=>{
  // Water is 1, oak 0.7, steel 7.8 — so "does it float?" reads straight off the
  // number. Rapier wants SI, and one multiply is the whole cost of that.
  assert.equal(bodyDensitySI(1),1000,'water');
  assert.equal(bodyDensitySI(.96),960,'the reported crate');
  assert.equal(bodyDensitySI(7.8),7800,'steel');
  // ⚠ Nothing real is 30 g/cm3 (osmium, the densest element, is 22.6), so a
  // figure above that can only be a scene authored before the unit changed.
  assert.equal(bodyDensitySI(500),500,'the old default passes through unscaled');
  assert.equal(bodyDensitySI(0),0,'and nonsense is refused');
});

test('a scene that still carries waterDensity 1 floats a 0.96 body anyway',()=>{
  // ⛔ THE CONSTANT HAS TO BEAT THE SAVED PROP. `waterDensity` was a field once,
  // and the kg/m3 label invited setting it to 1 so bodies could be authored on
  // a water-is-1 scale. With the field gone, a stale 1 in the scene file would
  // otherwise leave water a thousand times too light for ever.
  const r=rig();try{
    r.component.props.waterDensity=1;r.component.resolvedProps.waterDensity=1;
    const body=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,3,0));
    r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(1,1,1).setDensity(bodyDensitySI(.96)),body);
    r.physics.dynamicBodies.push({body,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
    r.step(30);
    assert.ok(body.translation().y>-1.1,`floats despite the stale prop: ${body.translation().y.toFixed(2)}`);
  }finally{r.dispose();}
});

test('a body resting on the bed of the pool stops disturbing the surface',()=>{
  // ⛔ THE CASE EVERY OTHER TEST MISSED: the rig's water has no floor, so a
  // sinking body falls out of the volume entirely and is released. A real pool
  // has a bed, the body comes to rest ON it — and its bottom cells straddle the
  // volume's BOTTOM plane, which the old `fraction < 1` counted as waterplane.
  const r=rig();try{
    const floor=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0,-20.5,0));
    r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(10,.5,10),floor);
    const body=r.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,2,0));
    r.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(.5,.5,.5).setDensity(bodyDensitySI(5)),body);
    r.physics.dynamicBodies.push({body,entity:{object3D:new THREE.Object3D(),getComponent:()=>null}});
    r.step(14);
    const y=body.translation().y;
    assert.ok(y<-19&&y>-20.2,`it is on the bed, inside the water: ${y.toFixed(2)}`);
    r.wakes.length=0;
    r.step(4);
    const injected=r.wakes.reduce((sum,[,,,depth])=>sum+Math.abs(depth),0);
    assert.ok(injected<.01,`and it dents nothing from down there: ${injected.toExponential(2)} over 4 s`);
  }finally{r.dispose();}
});
