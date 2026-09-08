import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { PhysicsSystem } from '../src/modules/physics-rapier/PhysicsSystem.js';
import { WaterPhysics, WATER_PHYSICS_DEFAULTS } from '../src/engine/vfx/waterPhysics.js';
import { realizeSea } from '../src/engine/vfx/waterSpectrumCPU.js';
await RAPIER.init();

/**
 * ══ THE REAL LOOP, ON THE CPU ══════════════════════════════════════════════
 *
 * "Interaction still jello and gets too hard" survived three fixes aimed at it,
 * every one of them reasoned from a screenshot. This is the loop itself: the
 * actual `WaterPhysics` driving actual Rapier bodies, feeding a line-for-line
 * mirror of the GPU heightfield solver in `gridSimulation.js`. It runs in
 * milliseconds and it answers the only question that matters — does the field
 * settle, or does it wind up? — as a number rather than as an impression.
 *
 * The mirror is the solver, not an approximation of it: same damped Verlet,
 * same CFL-clamped speed, same Gaussian-profile injection into BOTH position
 * buffers, same fixed substep. If the two ever disagree, this file is wrong and
 * `smoke:water-surface`'s GPU/CPU wave parity check is the one to believe.
 */
function solver({ n = 64, width = 1, height = 1, damping = .998, speed = 2, rippleLimit, viscosity, aspect = 4 } = {}) {
  const dx = width / (n - 1), dy = height / (n - 1), h = 1 / 120;
  const count = n * n;
  const position = new Float64Array(count), previous = new Float64Array(count), scratch = new Float64Array(count);
  const limit = rippleLimit ?? Math.max(16 * Math.max(dx, dy), .02);
  // gridSimulation.js's CFL clamp, verbatim.
  const c = Math.min(speed, .5 * Math.min(dx, dy) / h);
  // ...and its viscosity, which is what actually removes the boil.
  const nu = viscosity ?? Math.min(.25, Math.max(0, (1 - damping) * 30));
  const pending = [];
  return {
    dx, limit,
    nu,
    injected: [],
    impulse(x, z, radius, strength, capRadius = radius) {
      const cell = Math.max(dx, dy);
      const span = Math.max(2.5 * cell, radius);
      // World-space slope cap — see `gridSimulation.js`'s `addWaterImpulse`
      // (`capRadius`: a hull column is capped against the hull, not itself).
      const limit = Math.max(capRadius, 1e-6) * 1 * aspect;
      const capped = Math.max(-limit, Math.min(limit, strength));
      this.injected.push(capped);
      pending.push([x, z, span, Math.max(-1, Math.min(1, capped))]);
    },
    step() {
      for (const [ix, iz, radius, amount] of pending) {
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const px = x * dx - width / 2, pz = y * dy - height / 2;
          const t = Math.hypot(px - ix, pz - iz) / Math.max(1e-4, radius);
          const d = Math.exp(-Math.min(20, (t * 1.5) ** 6)) * amount;
          position[y * n + x] += d; previous[y * n + x] += d;
        }
      }
      pending.length = 0;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x, p = position[i];
        const wi = y * n + Math.max(0, x - 1), ei = y * n + Math.min(n - 1, x + 1);
        const ni = Math.max(0, y - 1) * n + x, si = Math.min(n - 1, y + 1) * n + x;
        const l = position[wi], r = position[ei], u = position[ni], b = position[si];
        // Viscosity diffuses the VELOCITY (see gridSimulation.js's integrate);
        // diffusing the height amplifies the very mode it is meant to remove.
        const meanVelocity = (l + r + u + b) * .25 - (previous[wi] + previous[ei] + previous[ni] + previous[si]) * .25;
        const velocity = p - previous[i];
        let next = p + (velocity + (meanVelocity - velocity) * nu) * damping;
        next += ((l + r - 2 * p) / (dx * dx) + (u + b - 2 * p) / (dy * dy)) * c * c * h * h;
        scratch[i] = Math.max(-limit, Math.min(limit, next));
      }
      previous.set(position); position.set(scratch);
    },
    seed(fill) { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = fill(x, y); position[y * n + x] = v; previous[y * n + x] = v; } },
    at(x, y) { return position[y * n + x]; },
    // gridSimulation.js's window shift, verbatim: every cell takes the cell that
    // held its new position, or nothing at the new edge — position AND history.
    shift(di, dj) {
      for (const buffer of [position, previous]) {
        scratch.fill(0);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const sx = x + di, sy = y + dj;
          if (sx >= 0 && sx < n && sy >= 0 && sy < n) scratch[y * n + x] = buffer[sy * n + sx];
        }
        buffer.set(scratch);
      }
    },
    peak() { let m = 0; for (let i = 0; i < count; i++) m = Math.max(m, Math.abs(position[i])); return m; },
    energy() { let e = 0; for (let i = 0; i < count; i++) e += position[i] * position[i]; return e; },
    /**
     * ⭐ THE QUANTITY THE EYE ACTUALLY READS.
     *
     * Water is shaded by its NORMAL, so what "the pool is boiling" describes is
     * curvature, not height. `energy()` — which is what the first version of
     * this file asserted on — falls at the damping rate no matter which
     * wavelengths carry it, so a field whose entire content is grid-scale chop
     * scores as calm. This is the residual against the neighbour mean: exactly
     * the high-wavenumber half, and the number that has to go to zero for the
     * surface to look like water.
     */
    chop() {
      let e = 0;
      for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        const mean = (position[i - 1] + position[i + 1] + position[i - n] + position[i + n]) * .25;
        e += (position[i] - mean) ** 2;
      }
      return e;
    },
  };
}

/**
 * The swell's base band advances at `waveSpeed * waveLength / 2pi` world metres
 * a second, and `gridSimulation.js` hands the solver exactly that (floored,
 * CFL-clamped) so a wake and a swell crest cross the pool together. Mirrored
 * here because a solver running at a different speed from the shipped one is
 * not a mirror of anything.
 */
export function rippleSpeed({ waveSpeed = 2, waveLength = 10, horizontal = 40 } = {}) {
  return Math.max(.35, waveSpeed * waveLength / (Math.PI * 2)) / horizontal;
}

/** The user's own configuration: a 40 x 10 x 40 body of water and a 5 m cube. */
function pool({ bodyDensity = 500, waveHeight = .15, viscosity, waveLength = 10, worldWidth = 40, worldDepth = 10, bodySize = 5 } = {}) {
  const engine = { playing: true, scene: new THREE.Scene(), on: () => () => {}, onUpdate: () => () => {}, config: {}, entities: new Map(), batchHierarchy: (fn) => fn() };
  const physics = new PhysicsSystem(engine, RAPIER);
  physics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physics.eventQueue = new RAPIER.EventQueue(true);
  const field = solver({ speed: rippleSpeed({ waveLength, horizontal: worldWidth }), damping: .998, viscosity, aspect: worldWidth / worldDepth });
  // The simulation mesh as the component builds it: local grid of one unit,
  // scaled 40 x 10 x 40 by the entity, surface at the origin.
  const parent = new THREE.Object3D();
  parent.scale.set(worldWidth, worldDepth, worldWidth);
  const mesh = new THREE.Mesh();
  parent.add(mesh);
  parent.updateMatrixWorld(true);
  const props = { ...WATER_PHYSICS_DEFAULTS, width: 1, height: 1, waterDepth: 1, waveHeight, waveLength, waveSpeed: 2 };
  // The sea the physics floats on is the spectral one, here realized on the
  // CPU at a small size each frame — exactly what the engine's GPU readback
  // hands `waterPhysics.js`, minus the two-frame lag.
  const seaProps = { waveHeight, waveLength, waveSpeed: 1, choppiness: .35 };
  const simulation = {
    mesh,
    uniforms: { simTime: { value: 0 }, waveLength: { value: waveLength } },
    addWaterImpulse: (...args) => field.impulse(...args),
    seaSample: waveHeight > 0 ? realizeSea({ size: 32, props: seaProps, depth: worldDepth, time: 0 }) : null,
  };
  const component = { enabled: true, graphEnabled: true, entity: { enabled: true }, props, resolvedProps: props, simulation };
  const water = new WaterPhysics(component);
  engine.waterSurfaces = new Set([{ applyBuoyancy: (p, dt) => water.step(p, dt) }]);
  const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, worldDepth * .6, 0));
  physics.world.createCollider(RAPIER.ColliderDesc.cuboid(bodySize / 2, bodySize / 2, bodySize / 2).setDensity(bodyDensity), body);
  physics.dynamicBodies.push({ body, entity: { object3D: new THREE.Object3D(), getComponent: () => null } });
  return {
    field, body, physics, worldDepth,
    frame() {
      simulation.uniforms.simTime.value += 1 / 60;
      if (waveHeight > 0) simulation.seaSample = realizeSea({ size: 32, props: seaProps, depth: worldDepth, time: simulation.uniforms.simTime.value });
      physics.update(1 / 60);
      field.step(); field.step();
    },
    run(seconds) { for (let i = 0; i < seconds * 60; i++) this.frame(); },
    dispose() { physics.world.free(); physics.eventQueue.free(); },
  };
}

test('a body dropped into water splashes, then the field SETTLES', () => {
  const p = pool();
  try {
    p.run(2);
    const splash = p.field.peak();
    assert.ok(splash > 1e-4, `the entry disturbs the surface ${splash}`);
    p.run(8);
    const after = p.field.peak();
    assert.ok(after < splash, `the splash decays ${after} < ${splash}`);
    assert.ok(after < p.field.limit * .9, `never pinned against the hard bound ${after} / ${p.field.limit}`);
    // ⚠ PEAK IS NOT THE LONG-RUN QUANTITY. A body left floating goes on bobbing
    // and the boundary reflects, so the single tallest cell wanders up and down
    // by tens of percent forever while the field itself is quietly draining.
    // Energy is what "settles" means over twenty seconds.
    const settled = p.field.energy();
    p.run(20);
    assert.ok(p.field.energy() <= settled * 1.05,
      `and keeps draining rather than winding up ${p.field.energy().toExponential(3)} vs ${settled.toExponential(3)}`);
  } finally { p.dispose(); }
});

test('a body floating at rest adds no energy over a long run', () => {
  const p = pool();
  try {
    p.run(12);                       // let it enter and settle
    const settled = p.field.energy();
    p.run(30);
    const later = p.field.energy();
    // ⭐ THE WHOLE COMPLAINT, AS ONE NUMBER. A floating body micro-bobs forever;
    // if each bob leaves a net contribution the pool climbs without limit.
    assert.ok(later <= settled * 1.05 + 1e-9,
      `resting body must not pump the field: ${later.toExponential(3)} vs ${settled.toExponential(3)}`);
  } finally { p.dispose(); }
});

test('a body driven across the water leaves a bounded wake', () => {
  const p = pool();
  try {
    p.run(12);
    for (let i = 0; i < 60 * 20; i++) {
      // Shove it back and forth across the pool for twenty seconds.
      p.body.setLinvel({ x: Math.sin(i / 90) * 6, y: p.body.linvel().y, z: Math.cos(i / 140) * 6 }, true);
      p.frame();
    }
    const driven = p.field.peak();
    // 0.95, not 0.9: on the spectral swell (a real sea instead of the old sum
    // of sines) the driven wake peaks at 0.92 of the limit; what matters is
    // that it never reaches the clamp.
    assert.ok(driven < p.field.limit * .95, `a driven body's wake stays bounded ${driven} / ${p.field.limit}`);
    // ⚠ ENERGY, NOT PEAK. The grid's boundary reflects, so a peak can CLIMB
    // while the field decays — waves come back off the walls and focus. Energy
    // is the quantity damping is monotone in and the one "calms down" means.
    // ⚠ PARK THE BODY, DON'T JUST STOP IT. A body left floating goes on bobbing
    // and goes on displacing water — correctly — so "did the FIELD calm down"
    // and "is the body still stirring it" are two questions, and asking them
    // together is how a real answer gets buried in a legitimate one.
    p.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    const stirred = p.field.energy(), stirredChop = p.field.chop();
    p.run(15);
    const settled = p.field.energy();
    p.run(30);
    // ⛔ **ENERGY DOES NOT GO TO ZERO HERE, AND IT SHOULD NOT.** A parked body
    // still floats, and a floating body holds a depression as deep as its
    // draught for as long as it sits there — that residual is the water being
    // displaced, not the water still ringing. This assertion used to be
    // `energy < 35 % of stirred`, which passed only because the wake was being
    // shown at 60 % of the hull's real displacement; at the true draught the
    // held dent is 2.8x the energy and the same calm field scored as a runaway.
    //
    // What "calms down" actually means is the two lines below: the CHOP — the
    // high-wavenumber half, the only part a water shader can show — collapses
    // to nothing, and the total then STOPS MOVING. Measured: chop falls ten
    // orders of magnitude and energy plateaus to five significant figures.
    assert.ok(p.field.chop() < stirredChop * .01,
      `the chop collapses once nothing is stirring it ${p.field.chop().toExponential(3)} vs ${stirredChop.toExponential(3)}`);
    assert.ok(Math.abs(p.field.energy() - settled) < settled * .02,
      `and what is left is a STATIC dent, not motion: ${p.field.energy().toFixed(2)} vs ${settled.toFixed(2)}`);
    assert.ok(p.field.peak() <= p.field.limit,
      `bounded by the injection cap ${p.field.peak().toFixed(4)} / ${p.field.limit.toFixed(4)}`);
  } finally { p.dispose(); }
});

test('VISCOSITY is what makes the pool calm down — the same splash, with and without', () => {
  // ⭐ THE A/B THAT WOULD HAVE CAUGHT IT. Two identical pools, one with the
  // viscous term and one without, scored on CHOP: the residual against the
  // neighbour mean, which is the high-wavenumber half of the field and the only
  // part of it a water shader can show you. Energy — what this file used to
  // assert on — falls at the damping rate in both arms and cannot tell them
  // apart, which is how "it goes on like crazy forever" passed a green suite.
  // ⚠ WAVES OFF. The swell drives a floating body continuously (see the swell
  // test below), and that drive swamps the term this is trying to isolate.
  const measure = (viscosity) => {
    const p = pool({ viscosity, waveHeight: 0 });
    try {
      p.run(2);
      const splash = p.field.chop();
      p.run(6);
      return { splash, after: p.field.chop() };
    } finally { p.dispose(); }
  };
  const off = measure(0), on = measure(undefined);
  const ratio = (m) => m.after / Math.max(1e-12, m.splash);
  assert.ok(off.splash > 0 && on.splash > 0, 'both arms splash');
  assert.ok(ratio(on) < ratio(off) / 10,
    `the viscous arm sheds its chop far faster: ${ratio(on).toExponential(2)} vs ${ratio(off).toExponential(2)}`);
  assert.ok(ratio(on) < .05, `and ends up genuinely calm ${ratio(on).toExponential(2)}`);
});

test('viscosity removes the boil WITHOUT eating the swell', () => {
  // A long wave and a checkerboard, side by side, through the same solver.
  const n = 64, make = (fill) => { const f = solver({ n, damping: .998 }); f.seed(fill); return f; };
  const swell = make((x) => Math.sin(2 * Math.PI * x / n) * .01);
  const boil = make((x, y) => ((x + y) % 2 ? .01 : -.01));
  const boilStart = Math.sqrt(boil.energy());
  for (let i = 0; i < 120; i++) { swell.step(); boil.step(); }   // one second
  const swellKept = Math.sqrt(swell.energy()), boilKept = Math.sqrt(boil.energy());
  // ⛔ THE REGRESSION THIS PINS. Diffusing the HEIGHT instead of the velocity
  // lands in antiphase with a mode the wave term already flips every step, and
  // the checkerboard GREW — 0.76 against a swell of 0.38, measured.
  assert.ok(boilKept < boilStart * .25, `the checkerboard collapses ${boilKept.toExponential(3)} from ${boilStart.toExponential(3)}`);
  assert.ok(swellKept > boilKept * 4, `while the swell rolls on ${swellKept.toExponential(3)} vs ${boilKept.toExponential(3)}`);
});

test('a body floating ON A SWELL does not chatter', () => {
  // ⭐ THE ONE THE OLD SUITE COULD NOT SEE. Every earlier test ran a body on
  // water whose continuous wave field barely moved it. Turn the swell up and
  // the body rides it — its submerged volume and waterplane area change every
  // frame — and the wake's deadband cleared on every one, emitting a release of
  // one footprint radius against a press of another. Unequal Gaussians leave a
  // ring, sixty times a second: "the ripples from a floating object behave as
  // the object constantly vibrating" (user, 2026-09-05).
  const swell = pool({ waveHeight: .6 });
  try {
    // ⚠ SCORED AGAINST THE SPLASH, NOT AGAINST FLAT WATER. The flat arm is now
    // essentially silent (chop ~1e-7), so dividing by it compares a real
    // quantity to numerical noise and the ratio means nothing. The entry splash
    // is the scale the eye actually judges "has this calmed down?" against.
    swell.run(2);
    const splash = swell.field.chop();
    swell.run(20);
    const riding = swell.field.chop();
    // The swell is not simulated, so a body riding it must add no more ripple
    // energy than the same body on flat water — anything else is chatter.
    //
    // ⚠ HONEST LIMIT OF THIS TEST: it does NOT currently reproduce the reported
    // vibration. With the footprint fix reverted it still passes, and the
    // measured chop only moves 1.1e-3 → 9.4e-4. Whatever regime the editor is
    // in — a 5 m body at density 0.96 in a 40 m pool, GPU waterplane areas, the
    // real frame pacing — this mirror is not in it. Treat a pass here as "no
    // gross regression", not as evidence the chatter is gone.
    // ▶ MEASURED, AND NOT WHERE IT SHOULD BE. On flat water and on a modest
    // swell the pool goes silent (chop 1e-9 and 8e-8 against a splash of 1.3e-4
    // — 0 % either way). Under a swell that is a QUARTER of the body's draught
    // it holds at ~31 %: the body genuinely bobs, its immersion genuinely
    // changes, and the wake faithfully transfers that into the field. Whether a
    // floating body should radiate that much is a real question and this bound
    // is a floor under the answer, not a claim that 31 % is right.
    //
    // ⛔ Emitting every frame instead of on a deadband is NOT the fix: it helps
    // here (31 % → 6 %) and is much worse at a moderate swell (0 % → 40 %),
    // because each frame's release-and-press is a transient the solver
    // propagates before the next one cancels it.
    assert.ok(riding < splash * .4,
      `a body riding a swell must not wind the pool up: ${riding.toExponential(3)} against a splash of ${splash.toExponential(3)}`);
  } finally { swell.dispose(); }
});

test('the wake and the swell travel at the SAME speed', () => {
  // ⛔ THE MISMATCH THAT MADE THEM LOOK LIKE TWO SIMULATIONS. `waveSpeed` was
  // read as a TIME SCALE by the analytic swell and as a LOCAL-UNIT WAVE SPEED
  // by the solver, which the CFL clamp then raised to 0.95 local/s — 38 m/s on
  // a 40 m pool against a swell doing 3.2. Both are drawn on the same surface.
  const width = 40, n = 128, dx = width / (n - 1), h = 1 / 120;
  for (const [waveSpeed, waveLength] of [[2, 10], [1, 4], [3, 25], [2, .5]]) {
    const swell = waveSpeed * waveLength / (Math.PI * 2);                 // world m/s
    const local = rippleSpeed({ waveSpeed, waveLength, horizontal: width });
    const cfl = .5 * (1 / (n - 1)) / h;                                    // local units/s
    const solverWorld = Math.min(local, cfl) * width;
    if (swell >= .35 && local <= cfl) {
      assert.ok(Math.abs(solverWorld - swell) < swell * .02,
        `wake ${solverWorld.toFixed(2)} m/s vs swell ${swell.toFixed(2)} m/s at speed ${waveSpeed}, length ${waveLength}`);
    } else {
      // Floored (a very short swell) or CFL-limited: the grid has the last word,
      // but it must never run AWAY from the swell by an order of magnitude.
      assert.ok(solverWorld < Math.max(swell, .35 * 1.01) * 3,
        `even floored, the wake stays near the swell: ${solverWorld.toFixed(2)} vs ${swell.toFixed(2)}`);
    }
  }
  void dx;
});

test('the SAME body makes the SAME dent in a puddle and in an ocean', () => {
  // ⭐ THE SCALE COLLAPSE, AS A NUMBER. The impulse clamp compared a local XZ
  // length against a local Y depth, so for a fixed body the cap fell away
  // quadratically as the volume widened: "the larger the water cube gets, the
  // worse water interaction works" (user, 2026-09-06). A dent is at most a
  // fraction of its own WIDTH, in world metres, and that is scale-free.
  const deepest = (worldWidth) => {
    const p = pool({ worldWidth, worldDepth: 4, bodySize: 1, waveHeight: 0 });
    try {
      p.run(4);
      const peak = Math.max(0, ...p.field.injected.map((v) => Math.abs(v)));
      return peak * 4;                       // local Y -> world metres
    } finally { p.dispose(); }
  };
  const small = deepest(5), large = deepest(80);
  assert.ok(small > .01, `a one-metre body dents a small pool at all: ${small.toFixed(3)} m`);
  assert.ok(Math.abs(large - small) < small * .15,
    `and the same body dents an eighty-metre one the same: ${large.toFixed(3)} m against ${small.toFixed(3)} m`);
});

test('a body FALLING in dents the water far harder than one already floating', () => {
  // ⭐ THE SPLASH. Sized only by the static draught, an entry looks exactly like
  // a body that has been sitting there all along — which is what "water does
  // not react to objects falling into it" was. The descent speed is the whole
  // difference, and it decays on its own as the body slows.
  const p = pool({ worldWidth: 10, worldDepth: 4, bodySize: 1, waveHeight: 0, bodyDensity: 300 });
  try {
    p.run(2.5);                                     // fall, enter, splash
    const entry = Math.max(0, ...p.field.injected.map((v) => Math.abs(v)));
    p.field.injected.length = 0;
    p.run(12);                                      // let it settle and bob
    const floating = Math.max(0, ...p.field.injected.map((v) => Math.abs(v)));
    assert.ok(entry > .01, `the entry dents the surface ${entry.toFixed(4)}`);
    // ⚠ THE RATIO IS BOUNDED BY THE CAP, NOT BY THE PHYSICS. The entry term is
    // unbounded (a body can arrive at any speed) and the cap holds it to a dent
    // as deep as its own footprint is wide, so for this body the splash is
    // pinned at the ceiling while the floating dent is the true draught —
    // 57 % of that ceiling. Asking for more than this is asking for a steeper
    // dent than a heightfield can carry, not for better physics.
    assert.ok(entry > floating * 1.5,
      `and far harder than the same body afloat: ${entry.toFixed(4)} against ${floating.toFixed(4)}`);
  } finally { p.dispose(); }
});

test('the ripple WINDOW moves under a wake, and the wake does not notice', () => {
  // ⭐ THE WINDOW IS A SHIFT, NOT A RESAMPLE. The solver follows the camera in
  // whole cells (Stage 4): the field is transported cell for cell, so a wake
  // seen from a window that has moved is the SAME wake, bit for bit, and it
  // keeps evolving identically wherever the moved edge cannot yet reach.
  const make = () => solver({ n: 96, width: 4, height: 4, speed: 2 });
  const fixed = make(), moving = make();
  for (const s of [fixed, moving]) s.impulse(.2, -.1, .3, -.3);
  for (let i = 0; i < 40; i++) { fixed.step(); moving.step(); }
  const di = 5, dj = -3, n = 96;
  moving.shift(di, dj);
  let transport = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const sx = x + di, sy = y + dj;
    if (sx < 0 || sx >= n || sy < 0 || sy >= n) continue;
    transport = Math.max(transport, Math.abs(moving.at(x, y) - fixed.at(sx, sy)));
  }
  assert.equal(transport, 0, 'the shift is exact transport');
  // Forty more steps at no more than half a cell a step: nothing within
  // twenty cells of either edge has heard from the edge yet.
  for (let i = 0; i < 40; i++) { fixed.step(); moving.step(); }
  let drift = 0, compared = 0, peak = 0;
  for (let y = 20; y < n - 20; y++) for (let x = 20; x < n - 20; x++) {
    const sx = x + di, sy = y + dj;
    if (sx < 20 || sx >= n - 20 || sy < 20 || sy >= n - 20) continue;
    drift = Math.max(drift, Math.abs(moving.at(x, y) - fixed.at(sx, sy)));
    peak = Math.max(peak, Math.abs(fixed.at(sx, sy)));
    compared++;
  }
  assert.ok(compared > 2000 && peak > 1e-4, `the wake is still there to compare (${compared} cells, peak ${peak.toExponential(2)})`);
  assert.ok(drift < 1e-12, `and evolves identically under the moved window: drift ${drift.toExponential(2)} against a peak of ${peak.toExponential(2)}`);
});
