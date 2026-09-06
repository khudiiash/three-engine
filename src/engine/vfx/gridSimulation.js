import * as THREE from "three/webgpu";
import { Fn, If, float, int, instanceIndex, instancedArray, select, storage, uniform, uniformArray, vec2, vec3, vec4, mix, positionLocal, Loop, dot, normalMap, textureStore, texture, ivec2 } from "three/tsl";
import { MAX_CLOTH_ANCHORS, resolveClothAnchors } from "./clothAnchors.js";
import { createWaterSpectrum, seaDisplacementAt, seaFoamNode, seaJacobianAt } from "./waterSpectrum.js";
import { GRAVITY } from "./waterSpectrumCPU.js";
import { waterAutoResolution } from "./waterVolume.js";
import { Vector2 } from "three/webgpu";

/**
 * ══ THE RIPPLE WINDOW ══════════════════════════════════════════════════════
 *
 * "Impact from object hitting the water looks quite good, but only at
 * specific scale … we need to adjust our water to any scale" (user,
 * 2026-09-06). The interactive ripple solver is a heightfield of fixed cell
 * COUNT, so its cell SIZE grew with the box: 4 cm on a 5 m pool, 47 cm on a
 * 60 m lake, a metre on a sea — and a half-metre body's splash is a dozen
 * cells in the first and none in the last. The sea (the spectral cascades)
 * already tiles in metres; the ripples now do too: the solver covers a
 * window of `RIPPLE_WINDOW_METRES` around the camera, or the whole pool when
 * that is smaller, at the same cells a pool has. The window follows the
 * camera in whole-cell steps (the field is shifted, not resampled), and the
 * render mesh — which covers the whole pool — samples the window as a
 * texture, zero outside it. A wake far from the eye is a wake nobody sees.
 */
export const RIPPLE_WINDOW_METRES = 32;
import { waterExtinction, waterSaturation } from "./waterVolume.js";
import { releaseComputeNodes, releaseStorageAttributes } from "../../modules/gi/releaseCompute.js";
import { projectClothMeshContact, projectClothClosedContact } from "./clothMeshContact.js";
import { createWaterCausticPass, createWaterSlotKernel } from "./waterSlots.js";

// Room for many bodies' displacement PAIRS in one frame.
/** The deepest dent, as a fraction of its own world-space width. */
const MAX_DENT_SLOPE = 1;
const IMPULSE_CAPACITY = 64;
const _axisX = new THREE.Vector3(), _axisY = new THREE.Vector3(), _axisZ = new THREE.Vector3();
const finite = (v, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Number(v) : fallback));
export function gridConfig(props = {}) {
  // 512 is `WATER_MAX_RESOLUTION` (waterVolume.js): a water surface's grid is
  // derived from its world size at a fixed cell, and this is where it stops.
  return { resolution: Math.round(finite(props.resolution, 32, 4, 512)), width: finite(props.width, 4, .1, 1000), height: finite(props.height, 4, .1, 1000) };
}

/** Bounded GPU surface solvers. Cloth uses Jacobi distance constraints; water
 * uses the damped wave equation, not a volumetric liquid solver. All neighbor
 * reads are from a separate buffer: no cross-workgroup read/write races.
 * Largest compute graph binds four storage buffers, within portable WebGPU. */
export function createGridSimulation(kind, props = {}, { colliderField = null, meshColliderField = null, colliderEntityId = null, material: sourceMaterial = null, sourceGeometry = null, anchorEngine = null, waterSlot = null, spectrum: givenSpectrum = null, seaQuality = null, worldScale = null } = {}) {
  if (kind === "cloth" && !sourceMaterial) throw new Error("Cloth requires the existing plane material.");
  const { resolution: n, width, height } = gridConfig(props);
  // ── THE SOLVER'S OWN GRID: A WINDOW IN METRES ─────────────────────────────
  //
  // `n` is the RENDER mesh over the whole pool. The ripple solver runs on `w`
  // cells over a window of `RIPPLE_WINDOW_METRES` — the whole pool when the
  // pool is smaller — so its cells are the same size at any scale. `worldScale`
  // (metres per local unit) is what makes the window a size in metres; a
  // harness that passes none gets the whole pool, as before.
  const scaleX = Math.max(1e-4, worldScale?.x ?? 1), scaleZ = Math.max(1e-4, worldScale?.z ?? 1);
  const windowed = kind === "water" && !!worldScale;
  const winW = windowed ? Math.min(width, RIPPLE_WINDOW_METRES / scaleX) : width;
  const winH = windowed ? Math.min(height, RIPPLE_WINDOW_METRES / scaleZ) : height;
  const w = kind === "water" ? (windowed ? waterAutoResolution(Math.max(winW * scaleX, winH * scaleZ)) : n) : n;
  const wCount = w * w, sx = winW / (w - 1), sz = winH / (w - 1);
  // ── THE SEA IS A SEPARATE FIELD, TILING IN WORLD METRES ───────────────────
  //
  // The spectral cascades (`waterSpectrum.js`) do not know how big this box
  // is: they tile in metres and the surface kernel samples them at its own
  // vertices' world positions. A harness that builds a solver directly gets
  // one of its own; the component may hand one in.
  const ownsSpectrum = kind === "water" && !givenSpectrum;
  const spectrum = kind === "water" ? (givenSpectrum ?? createWaterSpectrum(seaQuality ?? {})) : null;
  const count = n * n, dx = width / (n - 1), dy = height / (n - 1);
  // ── THE WATER BODY IS A BOX, AND THESE ARE THE VERTICES THAT CLOSE IT ─────
  //
  // The solver owns `count` heightfield vertices and nothing else. The SKIRT —
  // four walls hanging from the rim to the volume floor, plus that floor — is
  // extra geometry written by the SAME surface kernel from the SAME buffers, so
  // a wall's top edge IS the surface's own rim vertex and cannot crack away
  // from it as a separately-simulated mesh would. The walls carry their own
  // copies of the rim because they need an OUTWARD normal, not the surface's
  // up-normal; sharing the vertices would smooth-shade the corner and light a
  // wall as though it were the top of the water.
  //
  // Depth is a UNIFORM. Deepening the water moves these vertices on the GPU and
  // rebuilds nothing — which is why `waterDepth` is not in the rebuild list.
  // FOUR SEPARATE WALLS, NOT ONE LOOP. Each edge owns n vertices including both
  // of its corners, so the corners are DUPLICATED — walls that shared them
  // interpolated a -Z normal into a +X one across the last cell of every edge
  // and lit a visible seam into all four corners of the body. Duplicated, each
  // wall is flat to its own normal and the corner is the hard edge it is.
  const ringLength = kind === "water" ? 4 * n : 0;
  const WALL_TOP = count, WALL_BOTTOM = count + ringLength, FLOOR = count + ringLength * 2;
  const total = kind === "water" ? FLOOR + 4 : count;
  const ringCell = (k) => {
    const e = Math.floor(k / n), i = k % n;
    return e === 0 ? [i, 0] : e === 1 ? [n - 1, i] : e === 2 ? [n - 1 - i, n - 1] : [0, n - 1 - i];
  };
  const ringNormal = (k) => {
    const e = Math.floor(k / n);
    return e === 0 ? [0, 0, -1] : e === 1 ? [1, 0, 0] : e === 2 ? [0, 0, 1] : [-1, 0, 0];
  };
  const positions = instancedArray(wCount, "vec4");
  const previous = instancedArray(wCount, "vec4");
  const scratch = instancedArray(wCount, "vec4");
  // The window's field as a texture: (height, normal.x, normal.z, foam) per
  // cell, for the render mesh, the fragment, the medium and the caustic lens.
  const rippleTexture = kind === "water" ? new THREE.StorageTexture(w, w) : null;
  if (rippleTexture) { rippleTexture.type = THREE.HalfFloatType; rippleTexture.format = THREE.RGBAFormat; rippleTexture.minFilter = rippleTexture.magFilter = THREE.LinearFilter; rippleTexture.wrapS = rippleTexture.wrapT = THREE.ClampToEdgeWrapping; rippleTexture.name = "Water ripple window"; }
  // ── FOAM IS SIMULATED, NOT STAMPED ────────────────────────────────────────
  //
  // A shading-time foam mask can only ever describe the surface AT THIS INSTANT,
  // so it appears and vanishes with the wave that made it and reads as a decal
  // ("our foam sucks hard"). Real foam is entrained by breaking water, then
  // PERSISTS and decays while the wave that made it moves on — the history is
  // the whole look. So it is a field: generated per cell from the solver's own
  // steepness, crest sharpness and vertical churn, accumulated, and faded.
  //
  // ⚠ IT COSTS NO STORAGE BUFFER. The state vectors are vec4 and only xyz were
  // ever used, so foam rides in `.w` through integrate/commit for free, which
  // matters — this engine's portable budget is eight per stage.
  const foamAttribute = kind === "water" ? new THREE.StorageBufferAttribute(total, 1) : null;
  const foamOut = foamAttribute ? storage(foamAttribute, "float", total) : null;
  const normalAttribute = new THREE.StorageBufferAttribute(total, 3);
  const normals = storage(normalAttribute, "vec3", total);
  const positionAttribute = new THREE.StorageBufferAttribute(total, 3);
  const output = storage(positionAttribute, "vec3", total);
  const waterSurfaceTexture = rippleTexture;
  const u = { damping: uniform(.99), gravity: uniform(9.81), wind: uniform(1), stiffness: uniform(.9), speed: uniform(2), amplitude: uniform(.3) };
  Object.assign(u, {
    shear: uniform(1), bend: uniform(.1), gust: uniform(0), gustFrequency: uniform(1), simTime: uniform(0), pin: uniform(0),
    waveHeight: uniform(0), waveLength: uniform(4), waveCos: uniform(1), waveSin: uniform(0),
    // Per-cascade mip the surface kernel reads the sea at — the level whose
    // texel is no finer than this grid's cell (render mesh / solver). See `tick`.
    seaLod: [uniform(0), uniform(0), uniform(0)],
    seaLodSolver: [uniform(0), uniform(0), uniform(0)],
    // The ripple window in LOCAL units: its centre and half extent (half the
    // texture's span, so uv = (local − centre) / (2·half) + ½).
    rippleCenter: uniform(new Vector2(0, 0)),
    rippleHalf: uniform(new Vector2(w * sx / 2, w * sz / 2)),
    rippleShift: uniform(new Vector2(0, 0)),
    waveOctaves: uniform(4), waveGain: uniform(.5), surfaceDetail: uniform(.6),
    choppiness: uniform(.35), rippleStrength: uniform(.25),
    color: uniform(new THREE.Color()), deepColor: uniform(new THREE.Color()), waterDepth: uniform(2), absorption: uniform(0), saturation: uniform(.35),
    foam: uniform(0), foamThreshold: uniform(.15), stylized: uniform(0),
    transmission: uniform(.75),
    // Local-space thickness for three's screen-space refraction — see
    // `updateWaterSlot`, which is the only place that knows the mesh's scale.
    refraction: uniform(0), collisionSkip: uniform(-1, "int"), meshCollisionSkip: uniform(-1, "int"),
    collisionRadius: uniform(.03), friction: uniform(.2),
    // World metres per local unit, published every tick from the mesh matrix.
    waveScale: uniform(new THREE.Vector3(1, 1, 1)),
    rippleLimit: uniform(1), viscosity: uniform(.02), rippleSpeed: uniform(2), roughness: uniform(.12),
    foamDecay: uniform(.99), foamRate: uniform(.05), foamSpread: uniform(0),
    // The lid's own half extents in local units (for the rim contact foam).
    halfExtent: uniform(new THREE.Vector3(width / 2, 0, height / 2)),
  });
  const simulationWorld = uniform(new THREE.Matrix4()), simulationInverse = uniform(new THREE.Matrix4());
  const anchorRows = Array.from({length:MAX_CLOTH_ANCHORS},()=>new THREE.Vector4(0,0,0,-1));
  const anchors = uniformArray(anchorRows, "vec4"), anchorCount = uniform(0,"int");
  let authoredAnchors = props.anchors ?? [];
  let authoredWaveLength = 4;
  const impulseRows=Array.from({length:IMPULSE_CAPACITY},()=>new THREE.Vector4());
  const impulses=uniformArray(impulseRows,"vec4"),impulseCount=uniform(0,"int"),pendingImpulses=[];
  const collisionWorld = colliderField ? simulationWorld : null;
  const collisionInverse = colliderField ? simulationInverse : null;
  const h = 1 / 120;
  const index = instanceIndex.toInt();
  // Solver cell coordinates (w×w); the render mesh has its own below.
  const x = index.mod(w), y = index.div(w);
  const initial = (ix, iy) => kind === "cloth"
    ? vec3(ix.toFloat().mul(dx).sub(width / 2), float(height).sub(iy.toFloat().mul(dy)), 0)
    : vec3(ix.toFloat().mul(dx).sub(width / 2), 0, iy.toFloat().mul(dy).sub(height / 2));
  // A solver cell's rest position in LOCAL units: the window's centre plus
  // the cell's offset from the window's middle.
  const cellLocal = (ix, iy) => vec3(u.rippleCenter.x.add(ix.toFloat().sub((w - 1) / 2).mul(sx)), 0, u.rippleCenter.y.add(iy.toFloat().sub((w - 1) / 2).mul(sz)));
  // Where a LOCAL point falls in the ripple texture, and whether it is inside.
  const rippleUv = (local) => vec2(local.x.sub(u.rippleCenter.x).div(u.rippleHalf.x.mul(2)).add(.5), local.z.sub(u.rippleCenter.y).div(u.rippleHalf.y.mul(2)).add(.5));
  const rippleInside = (uv) => uv.x.greaterThan(.5 / w).and(uv.x.lessThan(1 - .5 / w)).and(uv.y.greaterThan(.5 / w)).and(uv.y.lessThan(1 - .5 / w));
  const rippleAt = (local) => {
    if (!rippleTexture) return vec4(0);
    const uv = rippleUv(local);
    return select(rippleInside(uv), texture(rippleTexture, uv).level(0), vec4(0));
  };
  const pinned = () => u.pin.equal(0).and(y.equal(0))
    .or(u.pin.equal(1).and(y.equal(0)).and(x.equal(0).or(x.equal(n - 1))))
    .or(u.pin.equal(2).and(x.equal(0)))
    .or(u.pin.equal(3).and(x.equal(0)).and(y.equal(0).or(y.equal(n - 1))));
  const applyEntityAnchor = (point) => {
    Loop({start:0,end:anchorCount},({i})=>{
      const anchor=anchors.element(i);
      If(index.equal(anchor.w.toInt()),()=>{ point.assign(anchor.xyz); });
    });
  };
  const init = Fn(() => {
    const p = (kind === "water" ? cellLocal(x, y) : initial(x, y)).toVar();
    if (kind === "water") {
      const radius = x.toFloat().sub((w - 1) / 2).div(w * .1).pow(2).add(y.toFloat().sub((w - 1) / 2).div(w * .1).pow(2));
      p.y.assign(radius.negate().exp().mul(u.amplitude));
    }
    positions.element(index).assign(vec4(p, 0));
    previous.element(index).assign(vec4(p, 0));
    scratch.element(index).assign(vec4(p, 0));
  })().compute(wCount);
  // ── THE WINDOW MOVES IN WHOLE CELLS, AND THE FIELD MOVES WITH IT ───────────
  //
  // `rippleShift` is the step in cells. Each cell takes the height, velocity
  // history and foam of the cell that held its new position, or nothing at
  // the window's new edge; every cell's rest position is rewritten for the
  // new centre. Two dispatches per buffer (through `scratch`), only on the
  // frames the camera crosses a cell.
  const shiftFrom = (source) => Fn(() => {
    const di = u.rippleShift.x.toInt(), dj = u.rippleShift.y.toInt();
    const sxi = x.add(di), syi = y.add(dj);
    const valid = sxi.greaterThanEqual(0).and(sxi.lessThan(w)).and(syi.greaterThanEqual(0)).and(syi.lessThan(w));
    const src = source.element(syi.clamp(0, w - 1).mul(w).add(sxi.clamp(0, w - 1)));
    const rest = cellLocal(x, y);
    scratch.element(index).assign(vec4(rest.x, select(valid, src.y, float(0)), rest.z, select(valid, src.w, float(0))));
  })().compute(wCount);
  const shiftInto = (target) => Fn(() => { target.element(index).assign(scratch.element(index)); })().compute(wCount);
  const shiftKernels = kind === "water" ? [shiftFrom(positions), shiftInto(positions), shiftFrom(previous), shiftInto(previous)] : [];
  const integrate = Fn(() => {
    const p = positions.element(index).xyz.toVar();
    const old = previous.element(index).xyz;
    const next = p.add(p.sub(old).mul(u.damping)).toVar();
    if (kind === "cloth") {
      const gust = u.simTime.mul(u.gustFrequency).mul(Math.PI * 2).add(p.x.mul(.8)).add(p.y.mul(.6)).sin().mul(u.gust.add(u.wind.abs().mul(.35)))
        .add(u.simTime.mul(.731).add(p.y.mul(1.4)).sin().mul(u.wind.abs()).mul(.15));
      const localForce = simulationInverse.mul(vec4(0, u.gravity.negate(), u.wind.add(gust), 0)).xyz;
      next.addAssign(localForce.mul(h * h));
      If(pinned(), () => { next.assign(initial(x, y)); });
      applyEntityAnchor(next);
    } else {
      const at = (ix, iy) => iy.mul(w).add(ix);
      const west = at(x.sub(1).max(0), y), east = at(x.add(1).min(w - 1), y);
      const north = at(x, y.sub(1).max(0)), south = at(x, y.add(1).min(w - 1));
      const l = positions.element(west).y, r = positions.element(east).y;
      const t = positions.element(north).y, b = positions.element(south).y;
      // ── CFL, WITH ACTUAL HEADROOM ───────────────────────────────────────
      //
      // The 2-D limit is on the SUM of the two axes' coefficients, and each is
      // `(speed·h/dx)²`. At the old 0.65 that sum was 0.845 — inside the limit
      // and with almost nothing to spare, so any injected high-frequency energy
      // sat on grid-scale modes that barely decayed and wound the field up into
      // spikes (user, 2026-09-05). At 0.5 the sum is 0.5, which leaves the
      // margin an explicit solver needs to be forgiving of what is poured into
      // it. Ripples propagate a little slower; nothing else changes.
      // ── ONE BODY OF WATER, ONE WAVE SPEED ───────────────────────────────
      //
      // `u.speed` is the authored `waveSpeed`, and the two halves of this
      // surface were reading it as two different quantities: the analytic swell
      // uses it as a TIME SCALE (its base band's phase speed works out to
      // `speed·waveLength/2π`, ~3.2 m/s on the reported pool) while the solver
      // took it as a LOCAL-UNIT wave speed and then had it raised by the CFL
      // clamp to 0.95 local/s — **38 m/s in world terms, twelve times the
      // swell**. Both fields are drawn on the same surface, so a body's wake
      // shot away from it while the swell it was sitting on barely moved:
      // "waves and water reaction to objects are two completely separate
      // processes ... a visual contradiction" (user, 2026-09-05).
      //
      // They are separate FIELDS and, for a linear wave equation, summing them
      // is exactly right — superposition is not an approximation. What was
      // wrong was never the split; it was that the two carried different
      // physics. `rippleSpeed` is published from the swell's own phase speed
      // (`gridSimulation`'s tick), so a ripple and a swell crest cross the pool
      // together and read as one water.
      const speed = u.rippleSpeed.min(.5 * Math.min(sx, sz) / h);
      // ── VISCOSITY: WHY "IT NEVER CALMS DOWN" SURVIVED THREE FIXES ────────
      //
      // `u.damping` scales VELOCITY, so it removes every wavelength at the same
      // rate. Real water does not — viscous dissipation grows with curvature,
      // so ripples die in a moment and a swell rolls on. Without that the
      // field's grid-scale content, which is most of what a body's footprint
      // injects (a 5 m crate spans eight cells of a 64² grid), sits on modes
      // with no group velocity: it does not propagate away and it decays only
      // as slowly as the swell. The pool "goes on like crazy forever" (user,
      // 2026-09-05) while its total ENERGY decays politely the whole time —
      // which is exactly why the interaction test passed. It measured height.
      // What the eye reads is SLOPE.
      //
      // ⛔ AND IT HAS TO DIFFUSE THE VELOCITY, NOT THE HEIGHT. Smoothing the
      // POSITION looks like the same idea and is the opposite of it: at Nyquist
      // the wave term already flips the mode's sign every step, so a position
      // smoothing lands in antiphase and AMPLIFIES it by (1 + 2ν) per step —
      // measured, in `water-interaction.test.mjs`, as a checkerboard that grew
      // while a swell decayed. Diffusing the Verlet velocity multiplies exactly
      // that mode by (1 − 2ν) instead, and leaves a long wave alone because a
      // long wave's neighbours share its velocity.
      const meanVelocity = l.add(r).add(t).add(b).mul(.25)
        .sub(previous.element(west).y.add(previous.element(east).y)
          .add(previous.element(north).y).add(previous.element(south).y).mul(.25));
      const velocity = p.y.sub(old.y);
      next.y.assign(p.y.add(velocity.add(meanVelocity.sub(velocity).mul(u.viscosity)).mul(u.damping)));
      next.y.addAssign(l.add(r).sub(p.y.mul(2)).div(sx * sx).add(t.add(b).sub(p.y.mul(2)).div(sz * sz)).mul(speed.mul(speed)).mul(h * h));
      next.x.assign(p.x); next.z.assign(p.z);
      // Foam is generated in the SURFACE kernel, not here — see `heightfieldVertex`.
    }
    previous.element(index).assign(vec4(p, 0));
    scratch.element(index).assign(vec4(next, positions.element(index).w));
  })().compute(wCount);
  // ── A BODY DISPLACES WATER; IT DOES NOT PUMP IT ───────────────────────────
  //
  // The profile is a near-flat-topped bump, `exp(-(1.5t)^6)`, taken from the
  // MIT jeantimex/webgpu-water reference's `sphere.frag`. It replaced a Mexican
  // hat, `(1-r^2)e^{-r^2}`, whose negative outer lobe pulled the surface up
  // around every dent and rang.
  //
  // ⚠ AND THE CALLER SENDS TWO OF THESE PER BODY PER FRAME: the footprint ADDED
  // at where the body was, and SUBTRACTED at where it is now. That pairing is
  // the whole trick and it is why the reference's water is calm. A body at rest
  // sends two identical, opposite terms that cancel to the bit, so a floating
  // object injects NOTHING; only actual motion leaves a residue, and that
  // residue is a displacement rather than a rate. Injecting a rate every frame
  // — which is what this used to do — accumulates for as long as the body is
  // moving and then rings it off, "wiggling like a jello" (user, 2026-09-05).
  //
  // Height only, both buffers, so the surface is MOVED rather than given
  // momentum: the wave equation supplies the momentum on the next step.
  const injectWater = kind === "water" ? Fn(()=>{
    const p=positions.element(index).xyz;
    const displacement=float(0).toVar();
    Loop({start:0,end:impulseCount},({i})=>{
      const impulse=impulses.element(i);
      const t=p.x.sub(impulse.x).pow(2).add(p.z.sub(impulse.y).pow(2)).sqrt().div(impulse.z.max(1e-4));
      displacement.addAssign(t.mul(1.5).pow(6).min(20).negate().exp().mul(impulse.w));
    });
    positions.element(index).y.addAssign(displacement);
    previous.element(index).y.addAssign(displacement);
  })().compute(wCount) : null;
  const constrain = (source, target) => Fn(() => {
    const p = source.element(index).xyz.toVar();
    const correction = vec3(0).toVar();
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1], [-2, 0], [2, 0], [0, -2], [0, 2]]) {
      const nx = x.add(ox), ny = y.add(oy);
      If(nx.greaterThanEqual(0).and(nx.lessThan(n)).and(ny.greaterThanEqual(0)).and(ny.lessThan(n)), () => {
        const delta = source.element(ny.mul(n).add(nx)).xyz.sub(p);
        const len = delta.length().max(.00001);
        const rest = Math.hypot(ox * dx, oy * dy);
        const weight = Math.abs(ox) === 2 || Math.abs(oy) === 2 ? u.bend : ox !== 0 && oy !== 0 ? u.shear : float(1);
        correction.addAssign(delta.mul(len.sub(rest).div(len)).mul(weight));
      });
    }
    p.addAssign(correction.mul(u.stiffness).div(float(4).add(u.shear.mul(4)).add(u.bend.mul(4))));
    If(pinned(), () => { p.assign(initial(x, y)); });
    applyEntityAnchor(p);
    target.element(index).assign(vec4(p, 0));
  })().compute(count);
  const solveA = kind === "cloth" ? constrain(scratch, positions) : null;
  const solveB = kind === "cloth" ? constrain(positions, scratch) : null;
  // ⚠ A HARD BOUND ON THE DISTURBANCE FIELD, AND IT IS A SAFETY NET, NOT A
  // MODEL. Nothing in an explicit wave solver guarantees it cannot diverge —
  // one steep injection, one authored speed, one resolution change — and a
  // diverged heightfield does not fail quietly: it fills the screen with
  // grid-scale spikes. The bound is generous (sixteen cells, or the authored
  // initial amplitude) so ordinary water never reaches it, and it turns a
  // catastrophe into a visible-but-bounded ripple that damping then removes.
  const commit = Fn(() => {
    const next = scratch.element(index).toVar();
    if (kind === "water") next.y.assign(next.y.clamp(u.rippleLimit.negate(), u.rippleLimit));
    positions.element(index).assign(next);
  })().compute(wCount);
  // Final authoritative pins also run when dt is zero: editor gizmo motion
  // updates the attachment immediately, and collision cannot dislodge it.
  const pinEntities = kind === "cloth" ? Fn(()=>{
    Loop({start:0,end:anchorCount},({i})=>{
      const anchor=anchors.element(i);
      If(index.equal(anchor.w.toInt()),()=>{
        positions.element(index).assign(vec4(anchor.xyz,0));
        previous.element(index).assign(vec4(anchor.xyz,0));
        scratch.element(index).assign(vec4(anchor.xyz,0));
      });
    });
  })().compute(count) : null;
  // One-way contact, after each fixed-step constraint solve. Four bound storage
  // buffers: current/previous positions and the primitive/triangle collider fields.
  const collide = kind === "cloth" && colliderField ? Fn(() => {
    {
      const point = collisionWorld.mul(vec4(positions.element(index).xyz, 1)).xyz.toVar();
      const old = collisionWorld.mul(vec4(previous.element(index).xyz, 1)).xyz;
      const velocity = point.sub(old).toVar();
      const resolve = (normal, push) => {
        point.addAssign(normal.mul(push));
        const normalVelocity = dot(velocity, normal);
        If(normalVelocity.lessThan(0), () => { velocity.subAssign(normal.mul(normalVelocity)); });
        velocity.mulAssign(u.friction.oneMinus());
      };
      If(pinned().not(), () => {
      Loop({ start: 0, end: colliderField.countUniform }, ({ i }) => {
        If(i.notEqual(u.collisionSkip), () => {
        const base = i.mul(4);
        const a = colliderField.buffer.element(base), b = colliderField.buffer.element(base.add(1));
        const c = colliderField.buffer.element(base.add(2)), d = colliderField.buffer.element(base.add(3));
        const center = a.yzw;
        If(a.x.lessThan(.5), () => {
          const extent = vec3(b.w, c.w, d.w), rel = point.sub(center);
          const local = vec3(dot(rel, b.xyz), dot(rel, c.xyz), dot(rel, d.xyz));
          const clamped = local.clamp(extent.negate(), extent);
          const closest = center.add(b.xyz.mul(clamped.x)).add(c.xyz.mul(clamped.y)).add(d.xyz.mul(clamped.z));
          const delta = point.sub(closest), distance = delta.length();
          If(distance.greaterThan(.00001), () => {
            If(distance.lessThan(u.collisionRadius), () => resolve(delta.div(distance), u.collisionRadius.sub(distance)));
          }).Else(() => {
            const penetration = extent.sub(local.abs());
            If(penetration.x.lessThanEqual(penetration.y).and(penetration.x.lessThanEqual(penetration.z)), () => {
              resolve(b.xyz.mul(local.x.greaterThanEqual(0).select(1, -1)), penetration.x.add(u.collisionRadius));
            }).ElseIf(penetration.y.lessThanEqual(penetration.z), () => {
              resolve(c.xyz.mul(local.y.greaterThanEqual(0).select(1, -1)), penetration.y.add(u.collisionRadius));
            }).Else(() => resolve(d.xyz.mul(local.z.greaterThanEqual(0).select(1, -1)), penetration.z.add(u.collisionRadius)));
          });
        }).Else(() => {
          const delta = point.sub(center), distance = delta.length(), radius = b.w.add(u.collisionRadius);
          If(distance.lessThan(radius), () => {
            const normal = distance.greaterThan(.00001).select(delta.div(distance.max(.00001)), vec3(0, 1, 0));
            resolve(normal, radius.sub(distance));
          });
        });
        });
      });
      if (meshColliderField) Loop({ start: 0, end: 3 }, () => {
        projectClothMeshContact({ field: meshColliderField, skip: u.meshCollisionSkip, point, old, velocity, radius: u.collisionRadius, friction: u.friction });
      });
      });
      if (meshColliderField) projectClothClosedContact({ field: meshColliderField, skip: u.meshCollisionSkip, point, velocity, radius: u.collisionRadius, friction: u.friction });
      positions.element(index).assign(vec4(collisionInverse.mul(vec4(point, 1)).xyz, 0));
      previous.element(index).assign(vec4(collisionInverse.mul(vec4(point.sub(velocity), 1)).xyz, 0));
    }
  })().compute(count) : null;
  // Resolve spatial cloth edges as well as temporal vertex motion. In a cloth
  // initially cutting through an open collider, every vertex can be well away
  // from its surface while a grid edge crosses it. Propagate the side of the
  // pinned boundary through a Jacobi snapshot; no thread reads another thread's
  // newly corrected positions. Contact can therefore untangle the existing pose.
  const collideEdges = kind === "cloth" && meshColliderField ? Fn(() => {
    const point = simulationWorld.mul(vec4(positions.element(index).xyz, 1)).xyz.toVar();
    If(pinned().not(), () => {
      const old = simulationWorld.mul(vec4(previous.element(index).xyz, 1)).xyz;
      const velocity = point.sub(old).toVar();
      const sideX = int(0).toVar(), sideY = int(0).toVar();
      If(x.lessThan(int(n / 2)), () => { sideX.assign(x.sub(int(1)).max(int(0))); }).Else(() => { sideX.assign(x.add(int(1)).min(int(n - 1))); });
      If(y.lessThan(int(n / 2)), () => { sideY.assign(y.sub(int(1)).max(int(0))); }).Else(() => { sideY.assign(y.add(int(1)).min(int(n - 1))); });
      const leftPinned = u.pin.equal(2).or(u.pin.equal(3));
      const primary = int(0).toVar(), lateral = int(0).toVar(), diagonal = int(index).toVar();
      If(leftPinned, () => {
        primary.assign(sideY.mul(int(n)).add(x));
        If(x.greaterThan(int(0)), () => { primary.assign(index.sub(int(1))); });
        lateral.assign(sideY.mul(int(n)).add(x));
        If(x.greaterThan(int(0)).and(y.lessThan(int(n - 1))), () => { diagonal.assign(index.add(int(n)).sub(int(1))); });
      }).Else(() => {
        primary.assign(y.mul(int(n)).add(sideX));
        If(y.greaterThan(int(0)), () => { primary.assign(index.sub(int(n))); });
        lateral.assign(y.mul(int(n)).add(sideX));
        If(y.greaterThan(int(0)).and(x.lessThan(int(n - 1))), () => { diagonal.assign(index.sub(int(n)).add(int(1))); });
      });
      for (const predecessor of [lateral, diagonal, primary]) {
        If(predecessor.notEqual(index), () => {
          const anchor = simulationWorld.mul(vec4(positions.element(predecessor).xyz, 1)).xyz.toVar();
          projectClothMeshContact({ field: meshColliderField, skip: u.meshCollisionSkip, point, old: anchor, velocity, radius: u.collisionRadius, friction: u.friction });
        });
      }
      projectClothClosedContact({ field: meshColliderField, skip: u.meshCollisionSkip, point, velocity, radius: u.collisionRadius, friction: u.friction });
      previous.element(index).assign(vec4(simulationInverse.mul(vec4(point.sub(velocity), 1)).xyz, 0));
    });
    scratch.element(index).assign(vec4(simulationInverse.mul(vec4(point, 1)).xyz, 0));
  })().compute(count) : null;
  // ── THE SEA IS SAMPLED IN WORLD METRES; THE RIPPLES ARE LOCAL ─────────────
  //
  // The vertex's rest XZ in world metres addresses the spectral cascades,
  // which tile in metres whatever the box's size; the displacement comes back
  // in metres and is converted into the mesh's own anisotropic units. The
  // horizontal displacement is real: a crest moves toward its own front, which
  // is what makes it sharp and a trough broad — a heightfield of sines cannot
  // do that, and it was most of why the old surface read as corrugated card.
  //
  // ── THE WALL IS A BOUNDARY: NO HORIZONTAL MOTION AT THE RIM ──────────────
  //
  // The sea's displacement is x, y AND z, and a rim vertex carried sideways
  // takes the wall hanging from it along — the whole body sheared with the
  // waves ("only the top surface should animate", user 2026-09-06). Water
  // meeting a wall has no horizontal velocity, so the horizontal part fades
  // to zero over a margin inside the edge (`edgeHold`); the height does not,
  // which is the waterline the walls follow. Local units, per axis, because
  // the box is anisotropic; capped at two metres so a lake's rim is not a
  // seven-metre dead band.
  const edgeHold = (p) => {
    const mx = float(Math.min(width, height) * .12).min(float(2).div(u.waveScale.x));
    const mz = float(Math.min(width, height) * .12).min(float(2).div(u.waveScale.z));
    return float(width / 2).sub(p.x.abs()).div(mx).clamp(0, 1).mul(float(height / 2).sub(p.z.abs()).div(mz).clamp(0, 1));
  };
  const seaAt = (p) => seaDisplacementAt(spectrum, vec2(p.x.mul(u.waveScale.x), p.z.mul(u.waveScale.z)), u.seaLod);
  // Render vertex coordinates (n×n) and the rest of a render vertex.
  const rx = index.mod(n), ry = index.div(n);
  const restOf = (i) => initial(i.mod(n), i.div(n));
  const surfacePosition = (i) => {
    if (kind !== "water") return positions.element(i).xyz;
    const p = restOf(i);
    const d = seaAt(p), hold = edgeHold(p);
    const ripple = rippleAt(p);
    return vec3(p.x.add(d.x.div(u.waveScale.x).mul(hold)), ripple.x.add(d.y.div(u.waveScale.y)), p.z.add(d.z.div(u.waveScale.z).mul(hold)));
  };
  // ── THE FOAM FIELD LIVES ON THE SOLVER'S CELLS ─────────────────────────────
  //
  // Once per tick, after the substeps: the field's sources (the ripple's own
  // steepness and churn, the sea's folds at the cell's world position),
  // spread toward the neighbours and the 3.5 s decay. Reads the neighbours'
  // foam from `scratch.w` — which `integrate` copied from `positions.w` and
  // nothing in this dispatch writes — and its own from `positions.w`.
  const foamField = kind === "water" ? Fn(() => {
    const at = (ix, iy) => iy.mul(w).add(ix);
    const west = at(x.sub(1).max(0), y), east = at(x.add(1).min(w - 1), y);
    const north = at(x, y.sub(1).max(0)), south = at(x, y.add(1).min(w - 1));
    const p = positions.element(index).xyz;
    const world = vec2(p.x.mul(u.waveScale.x), p.z.mul(u.waveScale.z));
    const sea = seaDisplacementAt(spectrum, world, u.seaLodSolver).toVar();
    const jacobian = seaJacobianAt(spectrum, world, sea.w, u.seaLodSolver);
    const jacobianFoam = seaFoamNode(jacobian, u.foam);
    const rise = u.waveScale.y;
    const rippleX = positions.element(east).y.sub(positions.element(west).y).div(2 * sx);
    const rippleZ = positions.element(south).y.sub(positions.element(north).y).div(2 * sz);
    const steepWorld = vec2(rippleX.mul(rise).div(u.waveScale.x), rippleZ.mul(rise).div(u.waveScale.z)).length();
    const churn = positions.element(index).y.sub(previous.element(index).y).mul(rise).div(h).abs();
    const source = steepWorld.smoothstep(.35, .8).mul(.14).add(churn.smoothstep(.12, 1).mul(3.5)).add(jacobianFoam.mul(3));
    const around = scratch.element(west).w.add(scratch.element(east).w).add(scratch.element(north).w).add(scratch.element(south).w).mul(.25);
    const spread = mix(positions.element(index).w, around, u.foamSpread);
    positions.element(index).w.assign(spread.mul(u.foamDecay).add(source.mul(u.foamRate)).clamp(0, 1));
  })().compute(wCount) : null;
  // The window as a texture: height, the ripple normal's x and z, foam.
  const rippleWrite = kind === "water" ? Fn(() => {
    const at = (ix, iy) => iy.mul(w).add(ix);
    const west = at(x.sub(1).max(0), y), east = at(x.add(1).min(w - 1), y);
    const north = at(x, y.sub(1).max(0)), south = at(x, y.add(1).min(w - 1));
    const rippleX = positions.element(east).y.sub(positions.element(west).y).div(2 * sx);
    const rippleZ = positions.element(south).y.sub(positions.element(north).y).div(2 * sz);
    const nrm = vec3(rippleX.negate(), 1, rippleZ.negate()).normalize();
    textureStore(rippleTexture, ivec2(x, y), vec4(positions.element(index).y, nrm.x, nrm.z, positions.element(index).w));
  })().compute(wCount) : null;
  const heightfieldVertex = () => {
    if (kind !== "water") {
      const at = (ix, iy) => iy.mul(n).add(ix);
      const west = at(x.sub(1).max(0), y), east = at(x.add(1).min(n - 1), y);
      const north = at(x, y.sub(1).max(0)), south = at(x, y.add(1).min(n - 1));
      const l = positions.element(west).xyz, r = positions.element(east).xyz, t = positions.element(north).xyz, b = positions.element(south).xyz;
      normals.element(index).assign(r.sub(l).cross(t.sub(b)).normalize());
      output.element(index).assign(positions.element(index).xyz);
      return;
    }
    // A render vertex: its rest, the sea there, and the window's ripple there.
    const p = initial(rx, ry).toVar();
    const world = vec2(p.x.mul(u.waveScale.x), p.z.mul(u.waveScale.z));
    const sea = seaDisplacementAt(spectrum, world, u.seaLod).toVar();
    const hold = edgeHold(p);
    const ripple = rippleAt(p).toVar();
    const point = vec3(p.x.add(sea.x.div(u.waveScale.x).mul(hold)), ripple.x.add(sea.y.div(u.waveScale.y)), p.z.add(sea.z.div(u.waveScale.z).mul(hold))).toVar();
    // ⭐ THE MESH NORMAL IS FLAT. Both slopes — the window's ripples and the
    // sea's cascades — are composed per PIXEL from textures
    // (`waterSurfaceLook.js`), so a splash reads the same on a 4 cm mesh and
    // on a 40 cm one; the geometry only has to be displaced.
    normals.element(index).assign(vec3(0, 1, 0));
    output.element(index).assign(point);
    if (foamOut) foamOut.element(index).assign(ripple.w);
    if (false) {
      // ── FOAM IS MEASURED AGAINST THE FIELD'S OWN STEEPNESS ───────────────
      //
      // ⛔ AND IT HAS TO BE MEASURED HERE, NOT IN THE INTEGRATOR. The
      // integrator only ever sees the RIPPLE field; the visible waves are the
      // analytic swell, which `surfacePosition` adds afterwards. Foam generated
      // there was therefore blind to every wave in the scene — it could only
      // respond to wakes — which is most of why it read as "random spots".
      //
      // ⛔ AND ABSOLUTE THRESHOLDS WERE THE OTHER HALF. A 0.12 world steepness
      // sounds like the one-in-seven breaking limit and is nothing of the kind
      // here: the reported lake runs at an AMBIENT steepness of 0.126, so a
      // fixed threshold at 0.12 fires over the entire surface at once. What
      // makes foam is being steeper than the water around you, so the
      // comparison is against the field's own characteristic steepness,
      // `2πH/L` — and then a lone swell crest scores zero while a place where
      // two trains cross scores one. That IS the wave-collision term; it needs
      // no special case, because superposition is what makes the steep spot.
      // ── FOAM: THE SEA'S JACOBIAN, THE RIPPLES' CHURN, ONE VALUE ──────────
      //
      // Babylon's foam is a MEMORY of the Jacobian of the horizontal
      // displacement — where the surface folded over itself, and how long ago
      // — summed over the cascades and read here from `displacement.w`. That
      // is the wave-driven half: breaking crests and the streaks they leave,
      // from the geometry that actually broke, not from a threshold on a
      // slope. The ripple field's own churn (a body slamming in, a crater's
      // steep rim) is the other half and lives in `positions.w`, spreading and
      // decaying as a field. `waterFoam.js` says what a value DRAWS.
      const jacobian = seaJacobianAt(spectrum, world, sea.w, u.seaLod);
      const jacobianFoam = seaFoamNode(jacobian, u.foam);
      const rise = u.waveScale.y;
      const steepWorld = vec2(rippleX.mul(rise).div(u.waveScale.x), rippleZ.mul(rise).div(u.waveScale.z)).length();
      const churn = positions.element(index).y.sub(previous.element(index).y).mul(rise).div(h).abs();
      // Per-second rates against a 3.5 s e-folding decay: a splash or a
      // breaking crest lays a SHEET in a fifth of a second; a steep crater
      // rim settles at a network. The sea's folds feed the SAME field, so
      // their foam spreads, persists and dissolves exactly like a wake's.
      const source = steepWorld.smoothstep(.35, .8).mul(.14).add(churn.smoothstep(.12, 1).mul(3.5)).add(jacobianFoam.mul(3));
      // ── FOAM SPREADS, AND THE NEIGHBOURS ARE READ FROM `scratch` ────────
      //
      // A patch of foam widens and softens as it ages; without that a splash
      // leaves a hard-edged stamp the exact shape of the footprint. Diffusing
      // toward the neighbour mean is the whole model. ⚠ The neighbours' foam is
      // read from `scratch.w`, which `integrate` copies from `positions.w` and
      // nothing in THIS dispatch writes — reading `positions.w` here would race
      // the threads that are writing their own. `u.foamSpread` is a physical
      // diffusivity converted to this grid's cells per tick, so a pond and a
      // lake spread foam at the same metres per second.
      const around = scratch.element(west).w.add(scratch.element(east).w).add(scratch.element(north).w).add(scratch.element(south).w).mul(.25);
      const own = positions.element(index).w;
      const spread = mix(own, around, u.foamSpread);
      const carried = spread.mul(u.foamDecay).add(source.mul(u.foamRate)).clamp(0, 1).toVar();
      positions.element(index).w.assign(carried);
      foamOut.element(index).assign(carried);
    }
  };
  // The skirt's own vertices. Reads only `positions` (committed by the previous
  // dispatch) and the depth uniform, so nothing here races the solver.
  const skirtVertex = kind === "water" ? () => {
    const m = n - 1;
    const k = index.sub(count).toVar();
    If(k.lessThan(ringLength * 2), () => {
      const ring = k.mod(ringLength).toVar();
      const edge = ring.div(n).toVar(), along = ring.mod(n).toVar();
      const ix = int(0).toVar(), iz = int(0).toVar(), outward = vec3(0).toVar();
      If(edge.equal(int(0)), () => { ix.assign(along); iz.assign(int(0)); outward.assign(vec3(0, 0, -1)); })
        .ElseIf(edge.equal(int(1)), () => { ix.assign(int(m)); iz.assign(along); outward.assign(vec3(1, 0, 0)); })
        .ElseIf(edge.equal(int(2)), () => { ix.assign(int(m).sub(along)); iz.assign(int(m)); outward.assign(vec3(0, 0, 1)); })
        .Else(() => { ix.assign(int(0)); iz.assign(int(m).sub(along)); outward.assign(vec3(-1, 0, 0)); });
      const rim = surfacePosition(iz.mul(n).add(ix)).toVar();
      if(foamOut)foamOut.element(index).assign(float(0));
      normals.element(index).assign(outward);
      output.element(index).assign(vec3(rim.x, select(k.lessThan(ringLength), rim.y, u.waterDepth.negate()), rim.z));
    }).Else(() => {
      const corner = k.sub(ringLength * 2).toVar();
      if(foamOut)foamOut.element(index).assign(float(0));
      normals.element(index).assign(vec3(0, -1, 0));
      output.element(index).assign(vec3(
        select(corner.equal(int(1)).or(corner.equal(int(2))), float(width / 2), float(-width / 2)),
        u.waterDepth.negate(),
        select(corner.greaterThanEqual(int(2)), float(height / 2), float(-height / 2)),
      ));
    });
  } : null;
  const surface = Fn(() => {
    if (!skirtVertex) { heightfieldVertex(); return; }
    If(index.lessThan(count), heightfieldVertex).Else(skirtVertex);
  })().compute(total);
  const geometry = new THREE.BufferGeometry();
  const indices = [], uv = new Float32Array(total * 2);
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const i = iy * n + ix; uv[i * 2] = ix / (n - 1); uv[i * 2 + 1] = 1 - iy / (n - 1);
    // Keep an authored rest surface on the CPU for editor picking/bounds.
    // Render and shadow passes read the GPU-deformed attribute. Raycasts are
    // intentionally rest-surface approximations, not collision geometry.
    positionAttribute.setXYZ(i, ix * dx - width / 2, kind === "cloth" ? height - iy * dy : 0, kind === "cloth" ? 0 : iy * dy - height / 2);
    normalAttribute.setXYZ(i, 0, kind === "water" ? 1 : 0, kind === "cloth" ? 1 : 0);
    if (ix < n - 1 && iy < n - 1) indices.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
  }
  const gridIndexCount = indices.length;
  if (kind === "water") {
    // Rest positions only — the kernel overwrites them on its first dispatch.
    // They still have to be right, because editor picking, the bounding box and
    // the very first frame all read the CPU attribute before any compute runs.
    const restDepth = finite(props.waterDepth, 2, .01, 1000);
    for (let k = 0; k < ringLength; k++) {
      const [ix, iz] = ringCell(k), nrm = ringNormal(k);
      const px = ix * dx - width / 2, pz = iz * dy - height / 2;
      for (const [slot, py] of [[WALL_TOP, 0], [WALL_BOTTOM, -restDepth]]) {
        positionAttribute.setXYZ(slot + k, px, py, pz);
        normalAttribute.setXYZ(slot + k, nrm[0], nrm[1], nrm[2]);
        uv[(slot + k) * 2] = k / ringLength; uv[(slot + k) * 2 + 1] = slot === WALL_TOP ? 1 : 0;
      }
      // ⚠ WINDING IS OUTWARD, AND IT MATTERS NOW. While the body was drawn
      // double-sided this was invisible — the normal attribute carried the
      // shading and the winding carried nothing. Single-sided culling (see
      // `syncWaterFacing`) reads it, and inverted here it culled every face a
      // viewer outside the water can see and drew the ones behind them.
      // No quad spans a corner: the last vertex of an edge and the first of the
      // next occupy the same place but belong to different walls.
      if (k % n === n - 1) continue;
      const next = k + 1;
      indices.push(WALL_TOP + k, WALL_TOP + next, WALL_BOTTOM + k, WALL_TOP + next, WALL_BOTTOM + next, WALL_BOTTOM + k);
    }
    const corners = [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]];
    for (let c = 0; c < 4; c++) {
      positionAttribute.setXYZ(FLOOR + c, corners[c][0], -restDepth, corners[c][1]);
      normalAttribute.setXYZ(FLOOR + c, 0, -1, 0);
      uv[(FLOOR + c) * 2] = c === 1 || c === 2 ? 1 : 0; uv[(FLOOR + c) * 2 + 1] = c >= 2 ? 1 : 0;
    }
    indices.push(FLOOR, FLOOR + 1, FLOOR + 2, FLOOR, FLOOR + 2, FLOOR + 3);
  }
  // ⚠ THE SHELL IS ITS OWN MESH, SHARING THE SAME VERTICES.
  //
  // The lid wears the AUTHORED water material, whose graph is written for a
  // surface: `builtin:Water.mat` samples `mx_noise_float(positionLocal * 24)`
  // and a foam ramp on `positionLocal.y`. Those are correct on a lid whose
  // local extent is one unit and catastrophic on a wall that spans the whole
  // volume depth and a floor that spans the whole footprint — 960 noise periods
  // across one quad, which aliases into hard vertical banding ("something gets
  // stretched hard in there", user 2026-09-05).
  //
  // So the shell is drawn with an engine-owned INTERFACE material instead: a
  // clear, transmissive Fresnel boundary with no surface detail at all, which
  // is what the side of a body of water actually is. The tint of what lies
  // beyond it is the medium's job, not this material's. Same attributes, same
  // storage buffers, same kernel — only the index buffer and the material
  // differ, so the shell can never disagree with the lid about where the rim is.
  const skirtGeometry = kind === "water" ? new THREE.BufferGeometry() : null;
  if (skirtGeometry) {
    geometry.setIndex(indices.slice(0, gridIndexCount));
    skirtGeometry.setIndex(indices.slice(gridIndexCount));
    skirtGeometry.setAttribute("position", positionAttribute);
    skirtGeometry.setAttribute("normal", normalAttribute);
    skirtGeometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  } else geometry.setIndex(indices);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("normal", normalAttribute); geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (foamAttribute) geometry.setAttribute("waterFoam", foamAttribute);
  if (kind === "cloth" && Array.isArray(sourceMaterial) && sourceGeometry?.groups?.length) {
    // Preserve a PlaneGeometry's authored triangle/material regions at the new
    // solver resolution. Material objects themselves stay entirely Mesh-owned.
    const sx = sourceGeometry.parameters?.widthSegments ?? 1, sy = sourceGeometry.parameters?.heightSegments ?? 1;
    let runStart = 0, previousMaterial = null;
    for (let i = 0; i < indices.length; i += 3) {
      let px = 0, py = 0;
      for (let j = 0; j < 3; j++) { px += uv[indices[i + j] * 2] * sx / 3; py += (1 - uv[indices[i + j] * 2 + 1]) * sy / 3; }
      const cx = Math.min(sx - 1, Math.floor(px)), cy = Math.min(sy - 1, Math.floor(py));
      const sourceIndex = (cy * sx + cx) * 6 + (px - cx + py - cy > 1 ? 3 : 0);
      const slot = sourceGeometry.groups.find((group) => sourceIndex >= group.start && sourceIndex < group.start + group.count)?.materialIndex ?? 0;
      if (previousMaterial !== null && slot !== previousMaterial) { geometry.addGroup(runStart, i - runStart, previousMaterial); runStart = i; }
      previousMaterial = slot;
    }
    geometry.addGroup(runStart, indices.length - runStart, previousMaterial ?? 0);
  }
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, kind === "cloth" ? height / 2 : 0, 0), Math.hypot(width, height) * 2);
  const ownsMaterial=kind === "water" && !sourceMaterial;
  const material = sourceMaterial ?? new THREE.MeshPhysicalNodeMaterial({ color: "#168aab", roughness: .15, metalness: 0, side: THREE.DoubleSide });

  if (ownsMaterial) {
    material.ior = 1.333; material.clearcoat = 1; material.clearcoatRoughness = .08;
    // Authored optical depth, not screen-space depth: robust without a depth pass
    // and equally available in editor, player, shadows and GI material sampling.
    const depth = u.waterDepth.add(positionLocal.y).max(0);
    const absorption = depth.mul(u.absorption).negate().exp().oneMinus();
    const variation=positionLocal.x.mul(.73).add(positionLocal.z.mul(1.17)).add(u.simTime.mul(.04)).sin()
      .mul(positionLocal.x.mul(1.31).sub(positionLocal.z.mul(.57)).sub(u.simTime.mul(.031)).sin()).mul(.07);
    const tint = mix(u.color, u.deepColor, absorption.add(variation).clamp(0,1));
    const bands = tint.mul(5).floor().div(5);
    const base = mix(tint, bands, u.stylized.mul(.65));
    const crest = positionLocal.y.sub(u.foamThreshold).div(u.waveHeight.add(u.amplitude).max(.01)).clamp(0, 1);
    const breakup=positionLocal.x.mul(8.37).add(positionLocal.z.mul(5.13)).add(u.simTime.mul(.31)).sin()
      .mul(positionLocal.x.mul(4.73).sub(positionLocal.z.mul(9.17)).sub(u.simTime.mul(.23)).sin()).mul(.3).add(.7);
    const foam = mix(crest.smoothstep(0, .35), crest.step(.15), u.stylized).mul(u.foam).mul(breakup);
    material.colorNode = mix(base, vec3(.92, .97, 1), foam);
    // Sub-grid ripples perturb the tangent normal while geometric normals
    // retain the swell/wake slopes used by lighting and planar reflections.
    const microX=positionLocal.x.mul(37.13).add(positionLocal.z.mul(21.7)).sub(u.simTime.mul(2.3)).sin();
    const microY=positionLocal.z.mul(43.7).sub(positionLocal.x.mul(17.3)).add(u.simTime.mul(1.79)).sin();
    const microStrength=u.rippleStrength.mul(.1).mul(u.waveHeight.min(1));
    material.normalNode=normalMap(vec3(microX.mul(microStrength),microY.mul(microStrength),1).normalize().mul(.5).add(.5));
    material.transmissionNode = u.transmission.mul(foam.oneMinus());
    // ⛔ NOT `waterDepth`. three's `getVolumeTransmissionRay` multiplies this by
    // the model's own scale, so a one-unit-deep box scaled to ten metres put the
    // refracted exit point TEN METRES sideways and sampled whatever was standing
    // on the far shore. That is the "second, broken reflection" the planar
    // mirror was blamed for and deleted over. `refraction` is a bounded world
    // offset expressed in local units — see `updateWaterSlot`.
    material.thicknessNode = u.refraction;
  }
  if (ownsMaterial) material.userData.surfaceUniforms = u;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = kind === "cloth" ? "Cloth" : "Water";
  mesh.userData.vfxSimulation = kind;
  mesh.userData.giGpuGrid = { positionAttribute, resolution: n };
  if(waterSurfaceTexture)mesh.userData.waterSurfaceTexture=waterSurfaceTexture;
  mesh.userData.noBatch = true;
  mesh.userData.noMerge = true;
  mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
  // The shell: a clear Fresnel interface and nothing else. Transmission 1 with
  // no thickness means it tints nothing — everything a viewer sees through the
  // side of the body has already been attenuated by the medium over the exact
  // path it took, and tinting again here would be that water counted twice.
  const skirtMaterial = skirtGeometry
    // ⚠ depthTest STAYS ON. With it off the shell painted over the lid wherever
    // it rasterized, regardless of what was in front — a flat lighter quad
    // sitting across the near corner of every pool, which no amount of looking
    // at the surface shader explains.
    ? new THREE.MeshPhysicalNodeMaterial({ roughness: .06, metalness: 0, transmission: 1, thickness: 0, ior: 1.333,
        transparent: true, depthWrite: false, depthTest: true, side: THREE.FrontSide })
    : null;
  const skirtMesh = skirtGeometry ? new THREE.Mesh(skirtGeometry, skirtMaterial) : null;
  if (skirtMesh) {
    skirtMaterial.userData.giWater = true;
    skirtMesh.name = "Water body";
    skirtMesh.userData.vfxSimulation = kind;
    skirtMesh.userData.noBatch = true; skirtMesh.userData.noMerge = true;
    skirtMesh.frustumCulled = false; skirtMesh.castShadow = false; skirtMesh.receiveShadow = false;
    skirtGeometry.boundingSphere = geometry.boundingSphere;
    mesh.add(skirtMesh);
  }
  // The slot pass resamples this solver into the engine-owned water slot (the
  // medium's surface map and the caustic lens). It reads the surface texture
  // AFTER `surface` has written it, so it is a dispatch of its own and never a
  // stage of that kernel.
  const slotKernel = kind === "water" && waterSlot
    ? createWaterSlotKernel({ slot: waterSlot, rippleTexture, rippleResolution: w, width, height, uniforms: u, spectrum, edgeHold })
    : null;
  // The caustic half is a DRAW, not a dispatch — see `createWaterCausticPass`.
  const causticPass = kind === "water" && waterSlot
    ? createWaterCausticPass({ slot: waterSlot, rippleTexture, rippleResolution: w, width, height, uniforms: u, spectrum })
    : null;
  let pendingShift = null;
  const steps = kind === "cloth" ? [integrate, solveA, solveB, solveA, solveB, solveA, solveB, solveA, solveB, commit] : [integrate, commit];
  if (collide) steps.push(collide);
  if (collideEdges) steps.push(collideEdges, commit, collideEdges, commit, collide);
  if (pinEntities) steps.push(pinEntities);
  let initialized = false, accumulator = 0, elapsed = 0;
  // The sea's settings and its CPU copy (for buoyancy), see `tick`.
  let lastProps = props, configuredDepth = 0, seaSample = null, seaReadbackPending = false, seaFrame = 0;
  const updateBounds = () => {
    // GPU positions cannot be read synchronously by the culler/GI tracker.
    // Cover the maximum ballistic excursion, including completely unpinned cloth.
    const excursion = kind === "cloth" ? (u.pin.value === 4 || u.stiffness.value < .1 ? .5 * Math.hypot(u.gravity.value, Math.abs(u.wind.value) * 1.5 + u.gust.value) * elapsed * elapsed : 0) : u.amplitude.value + u.waveHeight.value * 1.75 + 2;
    // The skirt hangs the whole volume depth below the rest surface, so the
    // culling sphere has to reach it or a submerged camera looking up loses the
    // water it is inside.
    let radius = Math.hypot(width, height) * 2 + excursion + (kind === "water" ? u.waterDepth.value : 0);
    for(let i=0;i<anchorCount.value;i++) radius=Math.max(radius,new THREE.Vector3(anchorRows[i].x,anchorRows[i].y,anchorRows[i].z).distanceTo(geometry.boundingSphere.center)+Math.hypot(width,height)*2);
    geometry.boundingSphere.radius = radius;
    geometry.boundingBox ??= new THREE.Box3();
    geometry.boundingBox.setFromCenterAndSize(geometry.boundingSphere.center, new THREE.Vector3(radius * 2, radius * 2, radius * 2));
    if (kind === "water") {
      // Transport sampling needs the sheet's footprint, not the deliberately
      // oversized culling sphere (which dilutes an 8^3 gather across empty air).
      const bounds = mesh.userData.giVfxBounds ??= new THREE.Box3();
      bounds.min.set(-width / 2, -u.waterDepth.value - excursion, -height / 2);
      bounds.max.set(width / 2, excursion, height / 2);
    }
  };
  const update = (p) => {
    authoredAnchors = p.anchors ?? [];
    // Cloth's damping is a fabric property an author tunes; water's is the
    // solver's numerical loss AND (see `integrate`) the source of its viscosity,
    // so it is fixed. Two effects behind one slider is not a control.
    u.damping.value = kind === "cloth" ? finite(p.damping, .99, 0, 1) : .998;
    // ── HOW MUCH VISCOSITY, AND WHY IT RIDES `damping` ──────────────────
    //
    // Thirty times the per-step velocity loss, capped at the diffusion step's
    // own stability limit. At the authored default (0.998) that is 0.06: a
    // grid-scale mode keeps 0.878 per substep and is gone inside a tenth of a
    // second, a ripple eight cells across fades over about a second, and a
    // swell twenty cells across loses a third of itself per second. The first
    // pass at 0.02 was measurably right and visibly too gentle — "better, yet
    // still broken ... needs to calm down a lot faster" (user, 2026-09-05).
    //
    // It is deliberately not a new dial. `damping` already means "how lossy is
    // this water", and tying the two makes the coupling the intuitive one:
    // damping toward 1 gives long-lived ripples AND less smoothing; lower
    // damping gives a pond that settles.
    u.viscosity.value = Math.min(.25, Math.max(0, (1 - u.damping.value) * 30));
    u.gravity.value = finite(p.gravity, 9.81, -100, 100);
    u.wind.value = finite(p.wind, 2, -100, 100);
    u.stiffness.value = finite(p.stiffness, .95, 0, 1);
    u.collisionRadius.value = finite(p.collisionRadius, .03, .001, 1); u.friction.value = finite(p.friction, .2, 0, 1);
    const fabric = p.fabric === "silk" ? .35 : p.fabric === "canvas" ? 1.5 : 1;
    u.shear.value = finite(p.shear, 1, 0, 1);
    u.bend.value = Math.min(1, finite(p.bend, .1, 0, 1) * fabric);
    u.gust.value = finite(p.gust, 0, 0, 100);
    u.gustFrequency.value = finite(p.gustFrequency, 1, 0, 10);
    u.pin.value = Math.max(0, ["top", "topCorners", "left", "leftCorners", "none"].indexOf(p.pinning ?? "top"));
    u.waveHeight.value = finite(p.waveHeight, .15, 0, 5);
    u.choppiness.value=finite(p.choppiness,.35,0,1);u.rippleStrength.value=finite(p.rippleStrength,.6,0,2);
    u.waveOctaves.value=finite(p.waveOctaves,4,1,8);u.waveGain.value=finite(p.waveGain,.5,.2,.9);
    u.surfaceDetail.value=finite(p.surfaceDetail,.6,0,2);
    // ⚠ ROUGHNESS IS PUBLISHED FOR EVERY WATER, not only the generated
    // material. Setting it on `material.roughness` inside `ownsMaterial`
    // left it dead for every water using an authored one — which is every
    // water in practice — and that is the fourth control to have had this
    // exact shape after colour, saturation and foam. A property of the
    // WATER belongs on the water.
    if (kind === "water") u.roughness.value = finite(p.roughness, .12, 0, 1);
    authoredWaveLength = finite(p.waveLength, 4, .1, 100);
    u.waveLength.value = authoredWaveLength;
    const direction = finite(p.waveDirection, 0, -180, 180) * Math.PI / 180;
    u.waveCos.value = Math.cos(direction); u.waveSin.value = Math.sin(direction);
    u.waterDepth.value = finite(p.waterDepth, 2, 0, 100);
    // `absorption` is DERIVED now — see `waterSaturation`. The uniform stays
    // because it is what the shading graph, the caustic transmittance and the
    // medium all integrate over a path; the authored number is the end state.
    u.saturation.value = waterSaturation(p, u.waterDepth.value);
    u.absorption.value = waterExtinction(u.saturation.value, u.waterDepth.value);
    u.foam.value = finite(p.foam, .25, 0, 1); u.foamThreshold.value = finite(p.foamThreshold, .15, 0, 5);
    u.transmission.value = finite(p.transmission, .75, 0, 1);
    u.stylized.value = p.style === "stylized" ? 1 : 0;
    // ⚠ BOTH WATER COLOURS ARE PUBLISHED WHETHER OR NOT THE MATERIAL IS OURS.
    // `u.color` used to be written only inside the `ownsMaterial` branch below,
    // because only the built-in shading graph read it — so every water surface
    // using an AUTHORED material (which is the normal case: `builtin:Water.mat`)
    // left it at `new THREE.Color()`, i.e. WHITE. Nothing showed it until the
    // underwater medium started reading the same pair, and then a pool's
    // interior washed out to a pale haze ("why water has that weird color
    // inside?", user 2026-09-05). A uniform that describes the WATER belongs to
    // the water, not to whichever material happens to be on it.
    if (kind === "water") u.color.value.set(p.color ?? "#168aab");
    if (skirtMaterial) { skirtMaterial.color.copy(u.color.value); skirtMaterial.attenuationColor.copy(u.deepColor.value ?? skirtMaterial.attenuationColor); }
    u.deepColor.value.set(p.deepColor ?? "#063a52");
    if (ownsMaterial) {
      const hadTransmission = material.transmission > 0;
      material.transmission = u.transmission.value;
      if (hadTransmission !== (material.transmission > 0)) material.needsUpdate = true;
      material.thickness = u.refraction.value;
      material.attenuationColor.copy(u.deepColor.value);
      material.attenuationDistance = u.absorption.value > 0 ? 1 / u.absorption.value : 1e6;
    }
    // ⚠ 1, NOT 2: the sea's dispersion is physical now, so this is a
    // multiplier on the clock and 1 is real time.
    u.speed.value = finite(p.waveSpeed, 1, 0, 100);
    u.amplitude.value = finite(p.amplitude, .3, 0, 10);
    if (spectrum) {
      lastProps = p;
      configuredDepth = Math.max(.05, u.waterDepth.value * u.waveScale.value.y);
      spectrum.configure(p, configuredDepth);
    }
    // ⚠ IN THE VOLUME'S OWN UNITS, NOT IN CELLS. Sixteen cells was the whole
    // bound, and cells are a fixed fraction of the grid: at 512² a 3 m deep
    // pool's sixteen cells are 9 cm, which would have capped every splash the
    // finer grid was bought to show. Half the depth is a bound a diverged field
    // still cannot pass, and one no real splash reaches.
    u.rippleLimit.value = Math.max(u.amplitude.value * 1.5, 16 * Math.max(sx, sz), .5 * u.waterDepth.value, .02);
    if (ownsMaterial) {
    material.color.set(p.color ?? (kind === "cloth" ? "#c85c3c" : "#168aab"));
    u.color.value.copy(material.color);
    material.roughness = finite(p.roughness, kind === "cloth" ? .85 : .15, 0, 1);
    mesh.castShadow = p.castShadow !== false; mesh.receiveShadow = p.receiveShadow !== false;
    }
    updateBounds();
  };
  update(props);
  const simulation = { mesh, skirtMesh, skirtMaterial, positions, count, resolution: n, vertexCount: total, init, surface, steps, uniforms: u,waterSurfaceTexture,slotKernel,causticPass,
    spectrum, rippleTexture,
    /** The solver's grid and its window, in local units. */
    ripple: { resolution: w, cellX: sx, cellZ: sz, windowWidth: winW, windowHeight: winH, windowed },
    /**
     * Keep the ripple window on the eye. `x`/`z` are the camera in LOCAL
     * units; the centre is clamped inside the pool and snapped to whole
     * cells, and a change queues the field shift for the next tick.
     */
    followCamera(x, z) {
      if (!windowed) return;
      const cx = Math.max(-(width / 2 - winW / 2), Math.min(width / 2 - winW / 2, Number(x) || 0));
      const cz = Math.max(-(height / 2 - winH / 2), Math.min(height / 2 - winH / 2, Number(z) || 0));
      const di = Math.round((cx - u.rippleCenter.value.x) / sx), dj = Math.round((cz - u.rippleCenter.value.y) / sz);
      if (!di && !dj) return;
      u.rippleCenter.value.x += di * sx; u.rippleCenter.value.y += dj * sz;
      pendingShift = { x: (pendingShift?.x ?? 0) + di, y: (pendingShift?.y ?? 0) + dj };
    },
    /** The sea as the CPU last saw it — `waterPhysics.js` floats bodies on this. */
    get seaSample() { return seaSample; },
    /** Harness aid: force every cascade to mip 0 for a bit-level parity check. */
    seaLodOverride: null,
    // The local water box, for buoyancy, the caustic lookup and the medium.
    extent: { halfX: width / 2, halfZ: height / 2, get depth() { return u.waterDepth.value; } },
    update,
    addWaterImpulse(x,z,radius,strength) {
      if(kind!=="water" || ![x,z,radius,strength].every(Number.isFinite))return false;
      // ⚠ DROP IN PAIRS. Callers emit a displacement PAIR (release where the body
      // was, press where it is), and discarding one half of one leaves a term
      // that presses the surface down with nothing ever releasing it — a slow
      // one-way pump. Dropping two keeps every surviving pair balanced.
      while(pendingImpulses.length>=IMPULSE_CAPACITY-1)pendingImpulses.splice(0,2);
      // ⚠ AND THE DENT MAY NOT BE A CLIFF. A displacement deeper than its own
      // footprint is a sub-grid discontinuity, and an explicit solver turns one
      // of those into grid-scale ringing rather than into a wave. Capping the
      // slope at a third keeps every injection something the grid can carry.
      // ⚠ A FOOTPRINT NARROWER THAN A FEW CELLS IS NOISE, NOT A SPLASH. The
      // reference's sphere covers ~32 cells of its grid; a 5 m body in a 40 m
      // pool at resolution 64 covers eight, and the profile's shoulder then
      // falls inside a single cell — a step function, which an explicit solver
      // answers with grid-scale ringing. Two and a half cells is the narrowest
      // dent this grid can actually carry.
      // ⚠⚠ AND THE DEPTH BOUND IS ON THE SLOPE THE GRID CARRIES, NOT ON A THIRD
      // OF THE WIDTH. `span/3` was arbitrary, and it was the binding constraint
      // on every body anyone has ever floated: a 0.5 m crate in a 5 m pool has
      // a footprint SEVEN CELLS wide, and a third of that is a 3.8 cm dent no
      // matter what `wakeStrength` says — so an author's setting of 1 did
      // exactly what 0.15 did and "nothing changed about the water interaction"
      // was literally true (user, 2026-09-05).
      //
      // What an explicit solver cannot carry is a height step across ONE CELL.
      // A dent of depth D over a footprint R has slope ~D/R and so costs
      // D·cell/R per cell; holding that under a third gives D ≤ R²/(3·cell),
      // which lets a well-resolved footprint be as deep as it is wide — what
      // the reference's sphere does — while a footprint two or three cells
      // across still gets the gentle old bound, for the same reason it did.
      const cell = Math.max(sx, sz);
      const span = Math.max(2.5 * cell, radius);
      // ── THE SLOPE CAP IS A WORLD QUANTITY, AND IT WAS MIXING AXES ────────
      //
      // `span` is a local XZ length and `strength` is a local Y depth, and a
      // water box is routinely far wider than it is deep — the reported lake is
      // 9.7 x 1.94, five to one. Comparing the two directly measured a slope in
      // the wrong units and, worse, one that got wronger as the pool grew: for
      // a FIXED body the footprint shrinks in local units as the box widens, so
      // the cap fell away quadratically. Measured on the same 0.39 m cube: an
      // 11.7 cm dent in a 2 m pool, 4 cm at 10 m, 3.2 cm at 20 m and beyond.
      // That is both reports at once — "water interaction is gone" and "the
      // larger the water cube gets, the worse it works" (user, 2026-09-06).
      //
      // In world metres the rule is simply that a dent is at most a fraction of
      // its own width, which is scale-free by construction: the same body makes
      // the same dent in a puddle and in an ocean. Resolvability is already
      // handled — `span` is floored at two and a half cells above.
      // ⚠ THE CAP USES THE BODY'S OWN FOOTPRINT, NOT THE FLOORED `span`. The
      // floor exists so a tiny body still injects something the GRID can carry;
      // letting it into the cap makes the ceiling grow with the pool, because
      // the floor is a fixed number of CELLS and cells are a fixed fraction of
      // the volume. A one-metre body then dented an eighty-metre lake harder
      // than a five-metre one — the same scale bug, wearing the other sign.
      // The steepest dent a heightfield is asked to carry, as a world slope:
      // as deep as it is wide. A body entering at speed craters the water by
      // about its own radius, which is what the reference shows and what an
      // 0.7 ceiling was quietly refusing — with the wake at its true draught
      // this ceiling, not the physics, had become the thing setting how big a
      // splash could be. The per-CELL slope is a different and much gentler
      // number, because `span` is floored at two and a half cells.
      const aspect = Math.max(u.waveScale.value.x, u.waveScale.value.z) / Math.max(1e-4, u.waveScale.value.y);
      const limit = Math.max(radius, 1e-6) * MAX_DENT_SLOPE * aspect;
      const capped = Math.max(-limit, Math.min(limit, strength));
      pendingImpulses.push([x,z,span,Math.max(-1,Math.min(1,capped))]);
      return true;
    },
    restart() { initialized = false; accumulator = 0; elapsed = 0; u.simTime.value = 0; pendingImpulses.length=0; spectrum?.restart(); updateBounds(); },
    tick(renderer, dt) {
      if (!renderer?.isWebGPURenderer) return;
      const queue = [];
      mesh.updateWorldMatrix(true, false, true); simulationWorld.value.copy(mesh.matrixWorld); simulationInverse.value.copy(mesh.matrixWorld).invert();
      const delta = finite(dt, 0, 0, .05);
      if (kind === "water") {
        mesh.matrixWorld.extractBasis(_axisX, _axisY, _axisZ);
        u.waveScale.value.set(Math.max(1e-4, _axisX.length()), Math.max(1e-4, _axisY.length()), Math.max(1e-4, _axisZ.length()));
        // ⚠ NYQUIST. Now that a wavelength is in metres, an author can ask a
        // 40 m pool for half-metre ripples across cells 60 cm wide. A
        // heightfield cannot carry that: it aliases into incoherent spikes, and
        // the caustics it feeds turn to noise. The grid's own cell size is the
        // floor, so asking for finer detail gives the finest detail this
        // resolution HAS rather than a broken version of what was asked for.
        const cell = Math.max(sx * u.waveScale.value.x, sz * u.waveScale.value.z);          // the solver's
        const vertexCell = Math.max(dx * u.waveScale.value.x, dy * u.waveScale.value.z);    // the render mesh's
        // The ripple solver runs at the swell's PHYSICAL phase speed — the
        // deep-water c = sqrt(g·λp/2π) of the peak wave, times the authored
        // time scale — so a wake and a crest cross the pool together. Local
        // units, floored so a still pool still carries its wakes, CFL-clamped
        // in the kernel because the grid has the final say.
        const horizontal = Math.max(1e-4, Math.max(u.waveScale.value.x, u.waveScale.value.z));
        const peakSpeed = Math.sqrt(GRAVITY * (spectrum?.settings?.waveLength ?? u.waveLength.value) / (2 * Math.PI));
        u.rippleSpeed.value = Math.max(.35, Math.max(.05, u.speed.value) * peakSpeed) / horizontal;
        // Each cascade is read at the mip whose texel is no finer than this
        // grid's cell, so a coarse mesh over a big lake samples a smooth sea
        // instead of aliasing the capillary cascade into spikes.
        if (spectrum) spectrum.cascades.forEach((c, i) => {
          u.seaLod[i].value = simulation.seaLodOverride ?? Math.max(0, Math.log2(Math.max(1, vertexCell / (c.L / spectrum.size))));
          u.seaLodSolver[i].value = simulation.seaLodOverride ?? Math.max(0, Math.log2(Math.max(1, cell / (c.L / spectrum.size))));
        });
        // The box's depth in metres reaches the spectrum (the TMA shallow-water
        // correction); re-realize it when that has really changed.
        const depthWorld = Math.max(.05, u.waterDepth.value * u.waveScale.value.y);
        if (spectrum && Math.abs(depthWorld - configuredDepth) > .2 * configuredDepth) { configuredDepth = depthWorld; spectrum.configure(lastProps, depthWorld); }
        // Foam accumulates per TICK (the surface kernel runs once a frame, not
        // once a substep), so its rates are the frame's — otherwise a fast
        // machine foams differently from a slow one.
        // ⭐ A PATCH LIVES FOR SECONDS. e-folding 3.5 s: a sheet (≥ 0.5) laid
        // down by a breaking crest is a network by 3 s, single bubbles by 8 s
        // and gone by 12 s — the sheet → web → specks sequence `waterFoam.js`
        // draws. The rate is set so a crest has to stay steep for about a
        // second to lay a sheet; a passing ripple leaves only threads.
        u.foamDecay.value = Math.exp(-delta / 3.5);
        u.foamRate.value = delta;
        // 0.015 m²/s of spread, in cells per tick — bounded well inside the
        // four-neighbour blend's stability.
        u.foamSpread.value = Math.min(.5, .015 * delta / Math.max(1e-6, cell * cell));
      }
      if(kind === "cloth") anchorCount.value=resolveClothAnchors(authoredAnchors,anchorEngine,simulationInverse.value,n,anchorRows);
      if (colliderField) {
        colliderField.refresh();
        u.collisionSkip.value = colliderField.entityIndices?.get(colliderEntityId) ?? -1;
        if (meshColliderField) { meshColliderField.refresh(); u.meshCollisionSkip.value = meshColliderField.entityIndices?.get(colliderEntityId) ?? -1; }
      }
      if (!initialized) { queue.push(init); initialized = true; pendingShift = null; }
      if (pendingShift) { u.rippleShift.value.set(pendingShift.x, pendingShift.y); queue.push(...shiftKernels); pendingShift = null; }
      if(injectWater) {
        impulseCount.value=pendingImpulses.length;
        for(let i=0;i<pendingImpulses.length;i++)impulseRows[i].fromArray(pendingImpulses[i]);
        if(pendingImpulses.length)queue.push(injectWater);
        pendingImpulses.length=0;
      }
      accumulator += delta; elapsed += delta; u.simTime.value = elapsed;
      updateBounds();
      for (let i = 0; accumulator + 1e-9 >= h && i < 6; i++, accumulator -= h) queue.push(...steps);
      if(pinEntities)queue.push(pinEntities);
      // ⚠ THE CAUSTIC DRAW GOES FIRST, AND NOT AFTER THE DISPATCH.
      //
      // It is a nested `renderer.render` into a render target. Issued right
      // after `renderer.compute(...)` it landed inside the backend's compute
      // encoding and took the material's object bind group with it — "Binding
      // size for [Buffer] is zero ... While encoding [ComputePassEncoder]"
      // followed by every water pipeline failing on the poisoned group (user,
      // 2026-09-05). Drawing before the queue keeps the two encoders apart.
      //
      // The cost is that the caustics describe the PREVIOUS frame's surface,
      // which at 60 Hz is 16 ms of lag on a pattern that moves like water. The
      // The GI nesting flag says this is not the frame's own render, so GI must
      // not treat it as one.
      if (causticPass) {
        const nested = globalThis.__giNestedRender;
        globalThis.__giNestedRender = true;
        try { causticPass.render(renderer); } finally { globalThis.__giNestedRender = nested; }
      }
      // The sea advances before the surface reads it; the foam field and the
      // ripple texture follow the substeps and precede the render surface.
      if (spectrum) queue.push(...spectrum.passes(delta, elapsed));
      if (foamField) queue.push(foamField, rippleWrite);
      queue.push(surface);
      if (slotKernel) queue.push(...slotKernel.compute);
      renderer.compute(queue);
      // ── THE SEA, FOR THE CPU ──────────────────────────────────────────────
      //
      // Buoyancy floats on the sea the eye sees: the cascades that carry
      // height are copied back every other frame (Babylon's method), a frame
      // or two behind, which nothing floating can notice. Until the first copy
      // lands the sea is flat to the physics.
      if (spectrum && !seaReadbackPending && (seaFrame++ & 1) === 0) {
        seaReadbackPending = true;
        spectrum.readback(renderer).then((sample) => { if (sample) seaSample = sample; }).catch(() => {}).finally(() => { seaReadbackPending = false; });
      }
    },
    dispose(renderer) {
      if (ownsSpectrum) spectrum.dispose(renderer);
      mesh.removeFromParent(); if (ownsMaterial) material.dispose();
      skirtMesh?.removeFromParent(); skirtMaterial?.dispose(); skirtGeometry?.dispose();
      causticPass?.dispose();
      releaseComputeNodes(renderer, [init, integrate, solveA, solveB, commit, surface, collide, collideEdges, pinEntities,injectWater, foamField, rippleWrite, ...shiftKernels, ...(slotKernel?.compute ?? [])].filter(Boolean));
      geometry.dispose();
      waterSurfaceTexture?.dispose();

      releaseStorageAttributes(renderer, [positions.value, previous.value, scratch.value, normalAttribute, positionAttribute, foamAttribute].filter(Boolean));
    },
  };
  return simulation;
}
