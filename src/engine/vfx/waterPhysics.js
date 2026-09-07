import { Quaternion, Vector3 } from 'three/webgpu';
import { seaHeightAt } from './waterSpectrumCPU.js';
import { waterInsideXZ, waterSurfaceFrame, waterVolumeExtent, waterVolumeShape } from './waterVolume.js';

/**
 * ══ WATER IS WATER, AND MOST OF THESE WERE NEVER SETTINGS ══════════════════
 *
 * `buoyancy` is a real choice — does this pool push things around or not. The
 * rest are properties OF WATER or numerical constants dressed up as art
 * direction, and every one of them was a field an author had to have an opinion
 * about ("there are many params I don't understand and I think we should throw
 * out or keep physically-water constant", user 2026-09-05):
 *
 *  · `waterDensity` is 1000 kg/m³. That is what water weighs.
 *  · `fluidDrag` / `angularDrag` are the linear and angular resistance of that
 *    fluid. A real coefficient depends on hull shape and Reynolds number, which
 *    this solver cannot know; one number for water is the honest simplification
 *    and a second number for the author to guess is not.
 *  · `wakeStrength` is how much of a hull's displacement a HEIGHTFIELD is
 *    allowed to show, given it cannot part around a hull at all. It is a
 *    property of the representation, not of the scene.
 *
 * ⚠ **AND THE CONSTANTS WIN OVER A SAVED SCENE.** They were spread FIRST for
 * one revision, so a project that had set `waterDensity: 1` — which is what the
 * old kg/m³ field invited, since it let you author bodies on a water-is-1 scale
 * — kept overriding water's real density from a field that no longer existed.
 * A body at 0.96 g/cm³ then sank like a stone against 1 kg/m³ of water, and no
 * control anywhere explained why. A constant that a stale prop can beat is not
 * a constant.
 */
export const WATER_PHYSICS_DEFAULTS = Object.freeze({ buoyancy:true });
/** Water, as a fluid. Not authored. */
export const WATER_CONSTANTS = Object.freeze({ waterDensity:1000, fluidDrag:3, angularDrag:2,
  // How much of a hull's displacement a heightfield is allowed to show. 0.15
  // was picked while the impulse clamp made everything above it identical, so
  // it was never measured against anything; the reference dents its pool by
  // something close to the sphere's own radius. Now that the clamp bounds the
  // per-cell SLOPE instead of a third of the width, this reaches that.
  //
  // ⭐ AND IT IS 1, NOT 0.6 — the hull's ACTUAL draught, with no artistic
  // reduction. A floating body sits in a depression as deep as it is submerged;
  // showing 60 % of that was a hedge from when the clamp was the thing bounding
  // the dent, and it cost most of the visible trace: on the reported 0.5 m crate
  // at 0.3 g/cm³ it was the difference between an 8.9 cm dent and a 15 cm one.
  // "I see some tiny trace on water from the red cube, but it is super tiny, it
  // should be more notable" (user, 2026-09-06). Above 1 it would be inventing
  // water that the body never displaced.
  wakeStrength:1 });
/** Seconds of a body's descent that the surface has not had time to escape.
 *  Sets how much of a falling body's speed becomes splash depth. */
const IMPACT_TIME=.12;
const finite=(v,d,min=0,max=1e6)=>Number.isFinite(Number(v))?Math.min(max,Math.max(min,Number(v))):d;

/** Surface query over the shared water volume (`waterVolume.js`), on the
 * SEA THE EYE SEES: `sea` is the spectral cascades' displacement read back
 * from the GPU (`gridSimulation`'s `seaSample`), sampled with Babylon's
 * inverse-displacement iteration. Without one the sea is flat. The GPU
 * disturbance ripples are not read back. Coordinates and returned heights are
 * world-space.
 *
 * The tilt guard and the local→world height conversion both live in
 * `waterSurfaceFrame` — see its header for the scale-vs-tilt confusion that
 * used to turn every scaled-up water plane's buoyancy off without a word. */
export function createWaterSurfaceQuery(mesh, props, time, sea = null) {
  const frame=waterSurfaceFrame(mesh);
  if(!frame.horizontal) return () => null;
  const extent=waterVolumeExtent(props), shape=waterVolumeShape(props);
  // One local unit of height is `rise` world metres of rise. A degenerate
  // (flattened) mesh has none, and then no depth is expressible.
  if(!(Math.abs(frame.rise)>1e-6)) return () => null;
  return (point) => {
  const world=new Vector3(point.x,point.y,point.z),local=world.clone().applyMatrix4(frame.inverse);
  if(!waterInsideXZ(shape,extent,local.x,local.z)) return null;
  const height=sea?.cascades?.length?seaHeightAt(sea.cascades,local.x*frame.scale.x+(sea.scroll?.x??0),local.z*frame.scale.z+(sea.scroll?.z??0))/frame.scale.y:0;
  const worldHeight=world.y+(height-local.y)*frame.rise;
  return {height:worldHeight,bottom:worldHeight-extent.depth*Math.abs(frame.rise),localX:local.x,localZ:local.z};
  };
}
export const queryWaterSurface=(mesh,props,time,point,sea=null)=>createWaterSurfaceQuery(mesh,props,time,sea)(point);

function localBounds(collider) {
  const shape=collider.shape;
  if(shape.halfExtents) return new Vector3(shape.halfExtents.x,shape.halfExtents.y,shape.halfExtents.z);
  if(Number.isFinite(shape.radius)) return new Vector3(shape.radius,shape.radius+(shape.halfHeight??0),shape.radius);
  const vertices=shape.vertices;
  if(vertices?.length) {
    const low=new Vector3(Infinity,Infinity,Infinity),high=new Vector3(-Infinity,-Infinity,-Infinity);
    for(let i=0;i<vertices.length;i+=3) { const p=new Vector3(vertices[i],vertices[i+1],vertices[i+2]);low.min(p);high.max(p); }
    return {half:high.clone().sub(low).multiplyScalar(.5),center:high.add(low).multiplyScalar(.5)};
  }
  return null;
}

/** Volume quadrature of actual Rapier colliders (including cooked convex hulls).
 * Fixed-step impulses avoid persistent addForce accumulation. Volume, not a
 * mass threshold, determines displaced water; drag is integrated implicitly. */
export class WaterPhysics {
  constructor(component) { this.component=component;this.samples=new WeakMap();this.previousVolumes=new WeakMap();this.previousWakes=new WeakMap();this.wakeFilter=new WeakMap();this.splashAt=new WeakMap();this.surfaceMemo=new WeakMap();this.time=0; }
  /**
   * ⭐ GIVE THE WATER BACK BEFORE FORGETTING THE BODY.
   *
   * The wake is a displacement PAIR, so the last thing any body leaves behind is
   * a dent held open by nothing but the record that it is there. Dropping that
   * record — which is what happens the moment a body submerges completely, sinks
   * out of the volume, or drifts past the footprint — abandons the dent, and the
   * solver then radiates it forever: "surface interaction is triggered by the
   * object even when it is fully submerged" (user, 2026-09-05).
   *
   * Releasing first makes leaving the surface conserve displacement exactly the
   * way crossing it does.
   */
  releaseWake(body) {
    const previous=this.previousWakes.get(body);
    if(!previous)return;
    this.previousWakes.delete(body);this.wakeFilter.delete(body);
    for(const column of previous.columns) this.component.simulation?.addWaterImpulse?.(column.x,column.z,column.radius,column.depth,column.cap);
  }
  sampleCollider(collider) {
    const volume=collider.volume();
    if(!(volume>0)||collider.isSensor()) return null;
    let cached=this.samples.get(collider);
    if(cached?.volume===volume) return cached;
    const bound=localBounds(collider);if(!bound)return null;
    const half=bound.half??bound,center=bound.center??new Vector3();
    const rotation=new Quaternion().copy(collider.rotation()),translation=new Vector3().copy(collider.translation());
    const points=[];
    for(let y=0;y<4;y++)for(let z=0;z<4;z++)for(let x=0;x<4;x++) {
      const p=new Vector3((x+.5)/2-1,(y+.5)/2-1,(z+.5)/2-1).multiply(half).add(center);
      if(collider.containsPoint(p.clone().applyQuaternion(rotation).add(translation))) points.push(p);
    }
    if(!points.length)return null;
    cached={volume,points,cellHalf:half.clone().multiplyScalar(.25)};this.samples.set(collider,cached);return cached;
  }
  step(physics,dt) {
    const c=this.component,p={...WATER_PHYSICS_DEFAULTS,...c.resolvedProps,...Object.fromEntries(Object.keys(WATER_PHYSICS_DEFAULTS).map(k=>[k,c.props[k]??WATER_PHYSICS_DEFAULTS[k]])),...WATER_CONSTANTS};
    if(!c.enabled||!c.graphEnabled||p.buoyancy===false||!c.simulation)return;
    for(let e=c.entity;e;e=e.parent)if(e.enabled===false)return;
    this.time+=dt;
    const mesh=c.simulation.mesh,time=c.simulation.uniforms?.simTime?.value??this.time;
    // The sea as the GPU last handed it back — the surface the eye sees, a
    // frame or two ago. Flat until the first copy lands.
    const query=createWaterSurfaceQuery(mesh,p,time,c.simulation.seaSample??null);
    const density=finite(p.waterDensity,1000,.01),drag=finite(p.fluidDrag,3,0,100),angular=finite(p.angularDrag,2,0,100);
    const gravity=new Vector3(...physics.gravity);
    let displaced=0,bodies=0;
    for(const {body,entity} of physics.dynamicBodies) {
      if(entity===c.entity||!body.isDynamic()||!(body.mass()>0))continue;
      const contacts=[],waterline=[];let volume=0,plane=0,total=0;
      // ── THE FOOTPRINT IS THE HULL'S COLUMNS (2026-09-07) ─────────────────
      // One circle per body made a boat press a round dent ("the contact
      // shape is completely wrong"). An ELONGATED hull (aspect ≥ 1.8) is a
      // row of columns along its long axis — up to four, each as wide as the
      // hull, pressed by its own draught and released by the exact record of
      // its press — so the dent is the shape of the hull. ⚠ A COMPACT BODY IS
      // ONE DENT, exactly as before: split into a grid, a crate's columns were
      // narrower than the slope cap lets a dent be deep (a falling crate's
      // splash read no harder than its floating draught), and sixteen
      // overlapping columns re-emitted with wandering centroids pumped the
      // field (the interaction tests: energy wound up, the wake hit the clamp).
      const columns=new Map();let bhalfMax=0;
      for(let i=0;i<body.numColliders();i++) {
        const collider=body.collider(i),sample=this.sampleCollider(collider);if(!sample)continue;
        const q=new Quaternion().copy(collider.rotation()),t=new Vector3().copy(collider.translation());
        const bound=localBounds(collider),bhalf=bound?.half??bound??sample.cellHalf.clone().multiplyScalar(4),bcenter=bound?.center??new Vector3();
        const longX=bhalf.x>=bhalf.z,longHalf=Math.max(bhalf.x,bhalf.z),shortHalf=Math.max(1e-6,Math.min(bhalf.x,bhalf.z));
        bhalfMax=Math.max(bhalfMax,longHalf);
        const aspect=longHalf/shortHalf;
        const bins=aspect>=1.8?Math.min(4,Math.round(aspect)):1;
        const columnArea=(2*shortHalf)*(2*longHalf/bins),columnSpacing=2*longHalf/bins;
        // Smooth immersion over each quadrature cell's vertical extent.
        const ex=new Vector3(sample.cellHalf.x,0,0).applyQuaternion(q),ey=new Vector3(0,sample.cellHalf.y,0).applyQuaternion(q),ez=new Vector3(0,0,sample.cellHalf.z).applyQuaternion(q);
        const radius=Math.max(.001,Math.abs(ex.y)+Math.abs(ey.y)+Math.abs(ez.y));
        for(const local of sample.points) {
          const point=local.clone().applyQuaternion(q).add(t),surface=query(point);if(!surface)continue;
          const cell=sample.volume/sample.points.length;
          total+=cell;
          // ── SMOOTH IMMERSION, BECAUSE dV/dz IS DIFFERENTIATED BELOW ───────
          //
          // The linear overlap makes `fraction` a ramp, so its derivative — the
          // waterplane — is a STEP: as the waterline sweeps a cell it jumps on
          // and off at full value. A body riding a swell walks the waterline
          // across a whole layer of cells at a time, so `plane` stepped by a
          // layer's worth every wave, and that is what the wake kept re-emitting
          // long after the body had stopped doing anything interesting.
          //
          // ⛔ AND THE RAMP STAYS LINEAR. Smoothstep looks like the obvious
          // improvement and is two bugs: it BIASES the immersion (the straddling
          // cell reports `s(t)` where the truth is `t`, which with four sample
          // layers moved a 0.96 crate from 96 % under to 92 %), and its
          // derivative is not a partition of unity — with box cells exactly one
          // layer is ever partial, so a linear ramp already sums to a CONSTANT
          // waterplane as the surface sweeps, while `6u(1-u)` swings between
          // zero and 1.5x and takes the buoyancy spring's stiffness to zero
          // wherever the waterline lands on a cell boundary. A four-metre crate
          // at 0.9 kg started pogoing again on exactly that.
          const band=2*radius;
          const under=Math.max(0,Math.min(1,(surface.height-(point.y-radius))/band));
          const below=Math.max(0,Math.min(1,(surface.bottom-(point.y-radius))/band));
          const fraction=Math.max(0,under-below);
          if(fraction<=0)continue;
          // ── dV/dz AT THE FREE SURFACE, AND ONLY THERE ──────────────────────
          //
          // This is the waterplane area: the stiffness of the buoyancy spring,
          // and — via `plane/silhouette` — the test for "is this body AT the
          // surface" that decides whether it dents one.
          //
          // ⛔ IT USED TO BE `fraction < 1`, WHICH IS ALSO TRUE AT THE BOTTOM.
          // A cell straddling the volume's FLOOR is partly outside the water
          // too, so a body resting on the bed of the pool reported a waterplane
          // as large as if it were floating — and went on emitting wake at the
          // point above it for ever, jittering with every contact micro-motion.
          // "The surface continues to wobble as if the object is entering water
          // each frame ... must calm down when the cube submerged" (user,
          // 2026-09-05): it was still entering, as far as this line could tell.
          // The free surface is the only plane a body can dent.
          // dV/dz AT THE FREE SURFACE, and nowhere else: `under` strictly inside
          // (0,1) is precisely "this cell straddles the waterline". A cell that
          // straddles only the volume's FLOOR is partly dry too, and counting
          // it told a body resting on the bed of the pool that it still had a
          // full waterplane — so it went on emitting wake at the point above it
          // for ever ("the surface continues to wobble as if the object is
          // entering water each frame ... must calm down when the cube
          // submerged", user 2026-09-05).
          if(under>0&&under<1){
            plane+=cell/band;
            // Only the hull's OUTLINE sheds foam: the quadrature's border
            // samples (a 4 × 4 grid per collider). Every straddling sample
            // once seeded a flat disc and a box hull became a white slab of
            // its whole footprint ("a rectangle of foam", user, 2026-09-07).
            const gx=Math.max(0,Math.min(3,Math.floor(((local.x-bcenter.x)/Math.max(1e-6,bhalf.x)*.5+.5)*4))),gz=Math.max(0,Math.min(3,Math.floor(((local.z-bcenter.z)/Math.max(1e-6,bhalf.z)*.5+.5)*4)));
            if(gx<=0||gx>=3||gz<=0||gz>=3)waterline.push({collider:i,gx,gz,point,width:Math.max(.2,Math.min(1,Math.min(bhalf.x,bhalf.z)*.15))});
          }
          const v=cell*fraction;volume+=v;contacts.push({point,volume:v,surface});
          // This point's column: the quadrature's (x, z) cell, merged to `bins`.
          const along=longX?(local.x-bcenter.x)/Math.max(1e-6,bhalf.x):(local.z-bcenter.z)/Math.max(1e-6,bhalf.z);
          const kb=Math.max(0,Math.min(bins-1,Math.floor((along*.5+.5)*bins)));
          const key=`${i}:${kb}`;
          const column=columns.get(key)??{x:0,z:0,volume:0,area:columnArea,spacing:columnSpacing};
          column.x+=point.x*v;column.z+=point.z*v;column.volume+=v;columns.set(key,column);
        }
      }
      if(!volume){this.previousVolumes.set(body,0);this.releaseWake(body);continue;}
      // ── BUOYANCY IS A STIFF SPRING, AND A STIFF SPRING NEEDS AN IMPLICIT STEP ─
      //
      // The restoring force is `rho*g*A` per metre of submersion, so the natural
      // frequency is `sqrt(rho*g*A/m)` — and `m` is the BODY's mass, which an
      // author is free to make absurd. The user's 4 m crate at 0.9 kg gives
      // k = 157 kN/m against 0.9 kg: 418 rad/s, seven times the step rate. An
      // explicit step cannot integrate that. It delivered a full terminal
      // velocity (g/drag = 3.3 m/s) every frame the crate was submerged, so the
      // crate left the water at 3.3 m/s, flew half a metre and fell back —
      // "it jumps off the surface as it was concrete" (user, 2026-09-05).
      //
      // Backward Euler on the same spring adds `dt^2*k/m` to the denominator and
      // is unconditionally stable. It is also self-selecting: a body of ordinary
      // density contributes ~0.005 and nothing about it changes, while the crate
      // contributes 48 and settles instead of launching. Archimedes' equilibrium
      // is untouched — at rest the spring term multiplies a zero displacement.
      const mass=body.mass(),fluidMass=volume*density;
      const stiffness=density*Math.abs(gravity.y)*plane;
      const denominator=1+(drag*fluidMass*dt+stiffness*dt*dt)/mass;
      const buoyancy=gravity.clone().multiplyScalar(-density*dt/denominator);
      const velocity=new Vector3().copy(body.linvel());
      for(const contact of contacts) body.applyImpulseAtPoint(buoyancy.clone().multiplyScalar(contact.volume),contact.point,true);
      // Include Rapier's upcoming gravity in the implicit drag solve. This
      // retains Archimedes' equilibrium even when water is denser than a body.
      const dragImpulse=velocity.clone().addScaledVector(gravity,dt*body.gravityScale()).multiplyScalar(-mass*(1-1/denominator));
      body.applyImpulse(dragImpulse,true);
      const spin=body.angvel(),retain=1/(1+angular*fluidMass*dt/mass);
      body.setAngvel({x:spin.x*retain,y:spin.y*retain,z:spin.z*retain},true);
      // ── THE WAKE IS A DISPLACEMENT PAIR, NOT AN IMPULSE ─────────────────────
      //
      // Ported from the MIT jeantimex/webgpu-water reference's `sphere.frag`,
      // which adds the body's footprint where it WAS and subtracts it where it
      // IS. Two properties follow, and both are the difference between water and
      // jelly:
      //
      //  · A body at rest sends two identical opposite terms and injects exactly
      //    nothing. Nothing accumulates and nothing rings.
      //  · What is injected is a DISPLACEMENT — the water the body actually
      //    moved — rather than a rate. Injecting a rate every frame piles up for
      //    as long as the body moves and then rings it off: "wiggling like a
      //    jello" (user, 2026-09-05).
      //
      // The footprint is the WATERPLANE (`sqrt(A/pi)`), and its depth is the mean
      // submersion `volume/A`, both of which the buoyancy solve above already
      // has. `wakeStrength` scales how much of that displacement the surface is
      // allowed to show, since a heightfield cannot actually part around a hull.
      const prior=this.previousVolumes.get(body)??volume;this.previousVolumes.set(body,volume);
      const surface=query(new Vector3().copy(body.translation()));
      if(surface){
        const scale=mesh.getWorldScale(new Vector3());
        const flat=Math.max(.001,Math.sqrt(Math.abs(scale.x*scale.z)));
        // ── ⛔ `volume / plane` IS UNBOUNDED, AND THAT IS TWO BUGS AT ONCE ────
        //
        // `plane` is the WATERPLANE — the area of the cells that straddle the
        // surface — so it collapses to zero as a body finishes submerging while
        // the displaced volume does not. The footprint `sqrt(plane/pi)` shrank
        // to nothing and the depth `volume/plane` ran away to infinity, so a
        // body on its way under injected a needle: a dent one cell wide and as
        // deep as the clamp allowed, re-emitted every frame. That is both
        // reports — "the ripple itself is too small compared to the object
        // size" and "vibrates too fast even after the object went completely
        // underwater" (user, 2026-09-05) — from one division.
        //
        // The footprint is the body's SILHOUETTE, which does not collapse: the
        // waterplane while it straddles, and its cube-equivalent cross-section
        // once it does not (exact for a box, within 20 % for a sphere). And the
        // dent fades out with the part of the body still in the air, because a
        // fully submerged body does not dent a surface at all — the water
        // closes over it. Both ends are now continuous, so nothing has to be
        // released abruptly at the moment of submersion.
        const silhouette=Math.max(plane,Math.cbrt(Math.max(total,1e-9))**2);
        const radius=Math.sqrt(silhouette/Math.PI)/flat;
        // ⛔ AND THE FADE IS ON THE WATERPLANE, NOT ON HOW MUCH IS IN THE AIR.
        //
        // Fading by `emerged/volume` reads as the same idea and is a different
        // quantity: a crate at 0.96 density floats 96 % under, so that ratio is
        // 0.04 and it scaled the splash of a five-metre box down to nothing —
        // the thing simply vanished into the water without disturbing it.
        //
        // What actually decides whether a body dents a surface is whether its
        // cross-section is AT that surface, and `plane` — the area of the cells
        // straddling the waterline — is exactly that measure. It is 1 for
        // anything floating, however deep it sits, and collapses only as the
        // top passes under, which is when the water genuinely closes over it.
        // Same number as before, used as a RATIO instead of as a divisor.
        const straddle=Math.min(1,plane/silhouette);
        // ── A SPLASH IS THE ENTRY, NOT THE DRAUGHT ──────────────────────────
        //
        // The static displacement is what a floating body looks like a second
        // after it lands. What it looks like ON THE WAY IN is the surface being
        // driven down at the body's own speed, and that transient is the entire
        // splash: "water does not react to objects falling into it" (user,
        // 2026-09-06) was a dent sized only by how deep the hull eventually
        // sits. A tenth of a second of the descent is the extra depth the water
        // has not had time to get out of the way of; it decays to nothing as
        // the body slows, so a resting body is untouched by this and the pair
        // still cancels exactly.
        const sinking=Math.max(0,-body.linvel().y);
        const draught=volume/silhouette+sinking*IMPACT_TIME;
        const depth=finite(p.wakeStrength,.15,0,2)*draught*straddle/Math.max(.001,Math.abs(scale.y));
        const previous=this.previousWakes.get(body);
        // ── THE ENTRY THROWS SPRAY (2026-09-07) ────────────────────────────
        // A body meeting the water faster than a metre a second — its first
        // contact, or a slam later — hands the sea a splash seed (local x, z,
        // radius, entry speed): a crown of spray whose particles return as
        // foam (waterSpectrum.js). Half a second between crowns per body.
        if(sinking>1&&(!previous||sinking>2.5)){
          const last=this.splashAt.get(body)??-Infinity;
          if(this.time-last>.5){this.splashAt.set(body,this.time);c.simulation.addWaterSplash?.(surface.localX,surface.localZ,radius,sinking);}
        }
        // ⚠ A DEADBAND, AND IT IS NOT A POLISH ITEM. The pair only cancels when
        // the two footprints are IDENTICAL. A body resting on water never is —
        // the solver leaves it micro-bobbing — so every substep emitted a dipole
        // of net-zero volume but POSITIVE energy, and at 0.998 damping the pool
        // wound itself up until "energy grows infinitely" (user, 2026-09-05).
        //
        // Below a quarter-cell of movement and 2% of depth change there is
        // nothing to say, so nothing is said. Crucially `previousWakes` is NOT
        // updated when skipping: the next real emission still releases from the
        // last place the water was actually pressed, so the pairs telescope and
        // the displacement stays conserved across any number of skipped steps.
        // ⛔ AND THE SWELL MUST NOT BE ABLE TO TRIGGER IT.
        //
        // The continuous wave field and the ripple solver are separate fields
        // that add (`gridSimulation.js`'s `surfacePosition`), and they had
        // exactly one coupling — this test — which is the wrong one. A floating
        // body rides the swell, so its submerged volume and its waterplane area
        // wobble every single frame; the 2%-of-depth band cleared on every one
        // of them, and each emission released a footprint of one radius and
        // pressed one of a slightly different radius. Two Gaussians of unequal
        // width do not cancel: what is left is a thin ring, injected 60 times a
        // second, and a body sitting still on a wave "behaves as the object
        // constantly vibrating" (user, 2026-09-05).
        //
        // Two changes, both about making the pair cancel EXACTLY in the case
        // that matters. The radius is held until it has really changed, so a
        // release always uses the width its press used. And the depth band gets
        // an absolute floor tied to the footprint, because 2% of a deep dent is
        // far below what the swell moves it by and below anything the grid can
        // show.
        // ⛔ AND THE FOOTPRINT ITSELF IS A NOISY ESTIMATE. `plane` and `volume`
        // come out of a QUADRATURE over the hull, so every time the waterline
        // crosses a sample cell they step. A body riding a swell walks the
        // waterline through that grid continuously, which is how two fields
        // that never interact still managed to drive each other: the swell's
        // motion was re-emitted, frame after frame, as wake. Each emission
        // released one footprint and pressed a slightly different one, and two
        // Gaussians of unequal width leave a ring — "the ripples from a
        // floating object behave as the object constantly vibrating" (user,
        // 2026-09-05).
        //
        // The displacement a hull makes is a slowly varying thing, so it is
        // low-passed before the deadband ever sees it, and the deadband then
        // compares the SMOOTHED footprint against the one actually pressed.
        // The release always replays the exact record of its press, so pairs
        // cancel to the bit however long the gap between them.
        const filter=this.wakeFilter.get(body)??{x:surface.localX,z:surface.localZ,radius,depth};
        const k=Math.min(1,dt/.08);
        filter.x+=(surface.localX-filter.x)*k;filter.z+=(surface.localZ-filter.z)*k;
        filter.radius+=(radius-filter.radius)*k;filter.depth+=(depth-filter.depth)*k;
        this.wakeFilter.set(body,filter);
        const moved=previous?Math.hypot(filter.x-previous.x,filter.z-previous.z):Infinity;
        const changed=previous?Math.abs(filter.depth-previous.depth):Infinity;
        // The deadband decides WHEN (the body as a whole, smoothed); the
        // columns say WHAT: each in-water column of the hull, pressed by its
        // own draught, and every one released again by the exact record of
        // its press, so the pair still cancels to the bit.
        if(moved>filter.radius*.15||changed>Math.max(Math.abs(filter.depth)*.08,filter.radius*.02)){
          const strength=finite(p.wakeStrength,.15,0,2);
          const pressed=[];
          // A compact body: the smoothed whole-body footprint, bit for bit as
          // before (the tests' numbers). Only an elongated hull is columns.
          const split=[...columns.values()].some((column)=>column.spacing<Math.max(bhalfMax)*2-1e-6);
          if(!split) pressed.push({x:filter.x,z:filter.z,radius:filter.radius,depth:filter.depth,cap:filter.radius});
          else for(const column of columns.values()){
            if(!(column.volume>0))continue;
            const at=query(new Vector3(column.x/column.volume,0,column.z/column.volume));if(!at)continue;
            // A column is as wide as the hull: its own footprint caps its depth,
            // exactly as a compact body's does.
            const columnRadius=Math.sqrt(column.area/Math.PI)/flat;
            const columnDraught=column.volume/column.area+sinking*IMPACT_TIME;
            const columnDepth=strength*columnDraught*straddle/Math.max(.001,Math.abs(scale.y));
            pressed.push({x:at.localX,z:at.localZ,radius:columnRadius,depth:columnDepth,cap:columnRadius});
          }
          if(pressed.length){
            if(previous)for(const column of previous.columns)c.simulation.addWaterImpulse?.(column.x,column.z,column.radius,column.depth,column.cap);
            for(const column of pressed)c.simulation.addWaterImpulse?.(column.x,column.z,column.radius,-column.depth,column.cap);
            this.previousWakes.set(body,{x:filter.x,z:filter.z,radius:filter.radius,depth:filter.depth,columns:pressed});
          }
        }
        // ── CONTACT FOAM IS BORN IN THE FIELD (2026-09-07) ───────────────
        // The waterline ring the lid draws is pinned to the hull; the foam a
        // hull sheds must live in the ripple field, which the current carries
        // ("the contact foam does not follow the current"). Each waterline
        // sample of the hull hands the field foam in proportion to the hull's
        // speed THROUGH the water — its velocity against the current — with
        // a dead zone so a hull bobbing at rest sheds nothing.
        if(waterline.length){
          const cur=finite(p.current,0,-10,10),curDir=finite(p.currentDirection,0,-180,180)*Math.PI/180;
          const vel=body.linvel();
          const rvx=vel.x-cur*Math.cos(curDir),rvz=vel.z-cur*Math.sin(curDir);
          const through=Math.hypot(rvx,rvz);
          // ── CONTACT SPRAY (2026-09-07) ─────────────────────────────────
          // A hull moving through the water throws spray off its LEADING
          // waterline — bow spray — (through − 1) × 30 drops a second per
          // leading sample (waterSpectrum.js's counted seeds), at six
          // tenths of its speed through the water.
          // Sixty drops a second per leading sample per metre a second over
          // the first, thrown at the full speed through the water: a boat
          // held in a 5 m/s current takes the whole sea on its bow ("there
          // must be a huge amount of force of water hitting the front of
          // the boat", user, 2026-09-07).
          if(through>1.5&&dt>0){
            const rate=(through-1)*60*dt;
            for(let i=0;i<waterline.length;i+=2){
              const at=query(waterline[i].point);if(!at)continue;
              const lead=(at.localX-filter.x)*rvx+(at.localZ-filter.z)*rvz;
              if(lead>0)c.simulation.addWaterSplash?.(at.localX,at.localZ,.5/flat,through,rate);
            }
          }
          // ── A WAVE SLAMMING THE HULL (2026-09-07) ────────────────────────
          // The water rising against the hull counts as much as the hull
          // falling into the water: the surface's climb at the body over
          // the last tick plus the body's own sinking, over 1.5 m/s, throws
          // counted spray off the whole waterline ("they don't appear on
          // wave collisions", user).
          const memo=this.surfaceMemo.get(body);
          const rising=memo&&dt>0?(surface.height-memo)/dt:0;
          this.surfaceMemo.set(body,surface.height);
          const slam=sinking+Math.max(0,Math.min(12,rising));
          if(slam>1.5&&dt>0){
            const rate=(slam-1)*20*dt;
            for(let i=0;i<waterline.length;i+=2){
              const at=query(waterline[i].point);if(!at)continue;
              c.simulation.addWaterSplash?.(at.localX,at.localZ,.4/flat,slam*.6,rate);
            }
          }
          // A quarter per second at full speed: the field's 2.5 s life makes a
          // steady band of ~0.6 — patches and streaks, not a sheet (1.5/s
          // saturated the footprint white, "still mostly a blob", 2026-09-07).
          const amount=finite(p.wakeStrength,.15,0,2)*Math.min(1,Math.max(0,through-.2)/3)*.25;
          if(amount>0){
            // THE OUTLINE AS A LINE: the border samples are metres apart on a
            // hull (four per side), so the waterline is drawn BETWEEN
            // consecutive border samples, a disc of the band's own width
            // (0.2–1 m, in the water's local units) every two widths.
            const seed=(point,width)=>{const at=query(point);if(at)c.simulation.addWaterFoam?.(at.localX,at.localZ,width/flat,amount);};
            const order=[[0,0],[1,0],[2,0],[3,0],[3,1],[3,2],[3,3],[2,3],[1,3],[0,3],[0,2],[0,1]];
            const byCollider=new Map();
            for(const sample of waterline){if(!byCollider.has(sample.collider))byCollider.set(sample.collider,new Map());byCollider.get(sample.collider).set(`${sample.gx}:${sample.gz}`,sample);}
            for(const ring of byCollider.values()){
              for(let k=0;k<order.length;k++){
                const a=ring.get(`${order[k][0]}:${order[k][1]}`),b=ring.get(`${order[(k+1)%order.length][0]}:${order[(k+1)%order.length][1]}`);
                if(!a){continue;}
                if(!b){seed(a.point,a.width);continue;}
                const n=Math.max(1,Math.ceil(a.point.distanceTo(b.point)/(2*a.width)));
                for(let j=0;j<n;j++)seed(a.point.clone().lerp(b.point,j/n),a.width);
              }
            }
          }
        }
      } else this.releaseWake(body);
      void prior;
      displaced+=volume;bodies++;
    }
    c.waterPhysicsStats={bodies,displacedVolume:displaced,density};
  }
}
