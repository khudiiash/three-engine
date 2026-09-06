import * as THREE from "three/webgpu";
import { Fn, If, float, int, instanceIndex, instancedArray, select, storage, uniform, uniformArray, vec2, vec3, vec4, mix, positionLocal, Loop, dot, normalMap, textureStore, texture, ivec2 } from "three/tsl";
import { MAX_CLOTH_ANCHORS, resolveClothAnchors } from "./clothAnchors.js";
import { createWaterSpectrum, seaDisplacementAt, seaFoamNode, seaJacobianAt, seaFoldNode } from "./waterSpectrum.js";
import { GRAVITY } from "./waterSpectrumCPU.js";
import { WATER_CELL_METRES, waterAutoResolution, waterProfileRadius, waterVolumeShape } from "./waterVolume.js";
import { waterProfileRadiusNode, waterRimDistanceNode } from "./waterShape.js";
import { Vector2, Vector4 } from "three/webgpu";

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
/**
 * The window's edge is not a wall. Where it lies INSIDE the pool a wake that
 * reaches it must leave, not bounce back toward the eye off nothing; the
 * outer `SPONGE_CELLS` cells damp the field quadratically toward the edge
 * (`SPONGE_STRENGTH` per substep at the very edge — a wave crossing the band
 * at half a cell a step keeps a few percent). Where the edge IS the pool's
 * rim the reflection is physical and the sponge is off on that side.
 */
export const SPONGE_CELLS = 16, SPONGE_STRENGTH = .08;
/**
 * ══ THE LID OVER A WIDE POOL IS CLIPMAP RINGS ═══════════════════════════════
 *
 * A flat grid caps at 512² (a metre a vertex on a 500 m sea, a 5 m crest four
 * vertices wide). Over `CLIP_ABOVE_METRES` the lid is Babylon's idea instead
 * (oceanGeometry.ts): concentric levels of a `CLIP_SIZE`² lattice, level ℓ's
 * cell 2^ℓ times the pool cell, all centred on the eye — 4 cm at the feet, a
 * few metres at the horizon, ~4 k vertices a level. All levels share ONE
 * centre snapped to the coarsest cell, so every level's lattice contains the
 * finer one's and a level's hole IS the finer level's boundary: no trims, no
 * stitching. The outer band of a level morphs onto the coarser lattice so its
 * boundary lands on the next level's own vertices exactly (sea read at the
 * coarser mip, at the two coarse vertices whose edge the fine one sits on).
 * The mesh normal is flat everywhere, so a level change is a change of
 * tessellation only — the shading never sees it.
 */
export const CLIP_ABOVE_METRES = 64, CLIP_SIZE = 65;
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
  const scaled = kind === "water" && !!worldScale;
  const winW = scaled ? Math.min(width, RIPPLE_WINDOW_METRES / scaleX) : width;
  const winH = scaled ? Math.min(height, RIPPLE_WINDOW_METRES / scaleZ) : height;
  // "Windowed" means the window is SMALLER than the pool: only then does it
  // move, and only then is its edge open water rather than the rim.
  const windowed = scaled && (winW < width * .999 || winH < height * .999);
  const w = kind === "water" ? (scaled ? waterAutoResolution(Math.max(winW * scaleX, winH * scaleZ)) : n) : n;
  const wCount = w * w, sx = winW / (w - 1), sz = winH / (w - 1);
  // ── THE LID: a flat n×n grid, or clipmap rings over a wide pool ───────────
  const clip = kind === "water" && scaled && Math.max(width * scaleX, height * scaleZ) > CLIP_ABOVE_METRES;
  const clipCell = { x: WATER_CELL_METRES / scaleX, z: WATER_CELL_METRES / scaleZ };   // level 0, local units
  // Enough levels that the coarsest one spans the pool with a cell to spare
  // for the centre's snap (63 cells ≥ the footprint).
  const clipLevels = clip ? Math.max(1, Math.ceil(Math.log2(Math.max(width / clipCell.x, height / clipCell.z) / (CLIP_SIZE - 2))) + 1) : 0;
  const clipHalf = (CLIP_SIZE - 1) / 2;
  const clipCoarsest = { x: clipCell.x * 2 ** Math.max(0, clipLevels - 1), z: clipCell.z * 2 ** Math.max(0, clipLevels - 1) };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // ── THE SHAPE: a box, or a solid of revolution (see waterVolume.js) ───────
  const shape = kind === "water" ? waterVolumeShape(props) : null;
  const round = !!shape && shape.kind !== 0;
  // A round shell follows its profile down in rings; a box has a top and a
  // bottom ring and a floor quad, as it always had.
  const SHELL_RINGS = round ? 12 : 2;
  // ── THE SEA IS A SEPARATE FIELD, TILING IN WORLD METRES ───────────────────
  //
  // The spectral cascades (`waterSpectrum.js`) do not know how big this box
  // is: they tile in metres and the surface kernel samples them at its own
  // vertices' world positions. A harness that builds a solver directly gets
  // one of its own; the component may hand one in.
  const ownsSpectrum = kind === "water" && !givenSpectrum;
  const spectrum = kind === "water" ? (givenSpectrum ?? createWaterSpectrum(seaQuality ?? {})) : null;
  const count = clip ? clipLevels * CLIP_SIZE * CLIP_SIZE : n * n, dx = width / (n - 1), dy = height / (n - 1);
  // The rim ring's vertices per edge: the flat grid's own, or the outer
  // level's lattice (so the shell's top meets the lid's boundary exactly).
  const rimN = clip ? CLIP_SIZE : n;
  const rimRest = (ix, iz) => clip
    ? [clamp((ix - clipHalf) * clipCoarsest.x, -width / 2, width / 2), clamp((iz - clipHalf) * clipCoarsest.z, -height / 2, height / 2)]
    : [ix * dx - width / 2, iz * dy - height / 2];
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
  const ringLength = kind === "water" ? 4 * rimN : 0;
  const WALL_TOP = count, WALL_BOTTOM = count + ringLength * (SHELL_RINGS - 1), FLOOR = count + ringLength * SHELL_RINGS;
  const total = kind === "water" ? FLOOR + (round ? 1 : 4) : count;
  const ringCell = (k) => {
    const e = Math.floor(k / rimN), i = k % rimN;
    return e === 0 ? [i, 0] : e === 1 ? [rimN - 1, i] : e === 2 ? [rimN - 1 - i, rimN - 1] : [0, rimN - 1 - i];
  };
  const ringNormal = (k) => {
    const e = Math.floor(k / rimN);
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
    // The same per cascade, UNCLAMPED (negative where the mesh cell is finer
    // than the cascade's texel): what a clipmap level adds its index to.
    seaLodRaw: [uniform(0), uniform(0), uniform(0)],
    // The ripple window in LOCAL units: its centre and half extent (half the
    // texture's span, so uv = (local − centre) / (2·half) + ½).
    rippleCenter: uniform(new Vector2(0, 0)),
    rippleHalf: uniform(new Vector2(w * sx / 2, w * sz / 2)),
    rippleShift: uniform(new Vector2(0, 0)),
    // Which sides of the window lie inside the pool (west, east, north, south).
    rippleSponge: uniform(new Vector4(0, 0, 0, 0)),
    // The clipmap's shared centre (local x, z), snapped to the coarsest cell.
    clipCenter: uniform(new Vector2(0, 0)),
    // The volume's shape (kind, radius, centerY, height) — see waterShape.js.
    shape: uniform(new Vector4(shape?.kind ?? 0, shape?.radius ?? .5, shape?.centerY ?? 0, shape?.height ?? 1)),
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
  const gridRest = (ix, iy) => vec3(ix.toFloat().mul(dx).sub(width / 2), 0, iy.toFloat().mul(dy).sub(height / 2));
  // A round lid: every grid point outside the cross-section is pulled radially
  // onto its outline, so the lid's edge hugs the shape and the triangles
  // beyond it collapse onto the rim.
  const lidRadius = () => waterProfileRadiusNode(u.shape, float(0));
  const lidClamp = (rest) => {
    if (!round) return rest;
    const rr = vec2(rest.x, rest.z).length();
    const k = lidRadius().div(rr.max(1e-6)).min(1);
    return vec3(rest.x.mul(k), rest.y, rest.z.mul(k));
  };
  const insideLid = (x, z) => waterRimDistanceNode(u.shape, u.halfExtent, x, z).greaterThan(0);
  const initial = (ix, iy) => kind === "cloth"
    ? vec3(ix.toFloat().mul(dx).sub(width / 2), float(height).sub(iy.toFloat().mul(dy)), 0)
    : lidClamp(gridRest(ix, iy));
  // A solver cell's rest position in LOCAL units: the window's centre plus
  // the cell's offset from the window's middle.
  const cellLocal = (ix, iy) => vec3(u.rippleCenter.x.add(ix.toFloat().sub((w - 1) / 2).mul(sx)), 0, u.rippleCenter.y.add(iy.toFloat().sub((w - 1) / 2).mul(sz)));
  // The sea's fold foam at a LOCAL point as an instantaneous level: the
  // persistent field's steady state under a fold is several times its source
  // (3 per second against a 3.5 s e-fold), and this is what stands in for the
  // field where the window has not been — beyond it, and in cells just in.
  const farFoamAt = (local, lods) => {
    if (kind !== "water" || !spectrum) return float(0);
    const world = vec2(local.x.mul(u.waveScale.x), local.z.mul(u.waveScale.z));
    // With the whitecap memory (waterSpectrum.js) the sea's foam is not the
    // field's business at all: the pixels read the memory directly, with the
    // whitecap look, and the field carries only what INTERACTION makes —
    // wakes, splashes, a rim's churn — with the wake look. One value with
    // two looks was a seam at the window's edge.
    if (spectrum.foam) return float(0);
    const sea = seaDisplacementAt(spectrum, world, lods);
    return seaFoamNode(seaJacobianAt(spectrum, world, sea.w, lods), u.foam).mul(4).clamp(0, 1);
  };
  // The lid's foam at a rest point: the window's persistent field where the
  // window is, the sea's instantaneous fold foam beyond it (blended over the
  // window's outer band), so an ocean's whitecaps do not stop 16 m from the eye.
  const lidFoamAt = (rest, ripple) => {
    const t = rippleUv(rest);
    const margin = t.x.min(t.x.oneMinus()).min(t.y).min(t.y.oneMinus());
    const core = margin.smoothstep(.5 / w, (SPONGE_CELLS + .5) / w);
    return ripple.w.max(farFoamAt(rest, u.seaLod).mul(core.oneMinus()));
  };
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
  const shiftFrom = (source, seedFoam) => Fn(() => {
    const di = u.rippleShift.x.toInt(), dj = u.rippleShift.y.toInt();
    const sxi = x.add(di), syi = y.add(dj);
    const valid = sxi.greaterThanEqual(0).and(sxi.lessThan(w)).and(syi.greaterThanEqual(0)).and(syi.lessThan(w));
    const src = source.element(syi.clamp(0, w - 1).mul(w).add(sxi.clamp(0, w - 1)));
    const rest = cellLocal(x, y);
    // A cell entering the window starts with the foam the sea is making there
    // right now (`farFoamAt`), not with none — the persistent field takes
    // seconds to fill, and a bare band at the leading edge would show.
    const fresh = seedFoam ? farFoamAt(rest, u.seaLodSolver) : float(0);
    scratch.element(index).assign(vec4(rest.x, select(valid, src.y, float(0)), rest.z, select(valid, src.w, fresh)));
  })().compute(wCount);
  const shiftInto = (target) => Fn(() => { target.element(index).assign(scratch.element(index)); })().compute(wCount);
  const shiftKernels = kind === "water" ? [shiftFrom(positions, true), shiftInto(positions), shiftFrom(previous, false), shiftInto(previous)] : [];
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
      // Beyond a round outline the neighbour is the wall: it holds this cell's
      // own height, and no wave crosses it (a Neumann boundary, as the window
      // edge and the box rim already are).
      const wallOr = (ix, iy, value) => (round ? select(insideLid(cellLocal(ix, iy).x, cellLocal(ix, iy).z), value, p.y) : value);
      const l = wallOr(x.sub(1), y, positions.element(west).y), r = wallOr(x.add(1), y, positions.element(east).y);
      const t = wallOr(x, y.sub(1), positions.element(north).y), b = wallOr(x, y.add(1), positions.element(south).y);
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
      // ⚠ THE WALL RULE APPLIES TO THE HISTORY TOO. The viscosity averages the
      // neighbours' VELOCITIES, height minus history; a dry neighbour whose
      // height reads as this cell's own (the wall) but whose history reads
      // its zeroed value contributes height/4 as a "velocity" every substep —
      // positive feedback that took a cylinder's whole field to the ripple
      // limit within a splash (premium ?shape=cylinder, 2026-09-06).
      const oldOr = (ix, iy, value) => (round ? select(insideLid(cellLocal(ix, iy).x, cellLocal(ix, iy).z), value, old.y) : value);
      const meanVelocity = l.add(r).add(t).add(b).mul(.25)
        .sub(oldOr(x.sub(1), y, previous.element(west).y).add(oldOr(x.add(1), y, previous.element(east).y))
          .add(oldOr(x, y.sub(1), previous.element(north).y)).add(oldOr(x, y.add(1), previous.element(south).y)).mul(.25));
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
    if (round) {
      const wet = select(insideLid(next.x, next.z), float(1), float(0));
      next.y.mulAssign(wet); next.w.mulAssign(wet);
      previous.element(index).y.mulAssign(wet);
    }
    if (kind === "water" && windowed) {
      // The sponge: position AND history scaled together, so the amplitude
      // shrinks without a velocity kick (see `SPONGE_CELLS`).
      const fx = x.toFloat(), fy = y.toFloat();
      const edge = (d, on) => d.div(SPONGE_CELLS).clamp(0, 1).oneMinus().mul(on);
      const s = edge(fx, u.rippleSponge.x).max(edge(float(w - 1).sub(fx), u.rippleSponge.y))
        .max(edge(fy, u.rippleSponge.z)).max(edge(float(w - 1).sub(fy), u.rippleSponge.w));
      const f = float(1).sub(s.mul(s).mul(SPONGE_STRENGTH));
      next.y.mulAssign(f);
      previous.element(index).y.mulAssign(f);
    }
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
    if (round) return waterRimDistanceNode(u.shape, u.halfExtent, p.x, p.z).div(mx.min(mz)).clamp(0, 1);
    return float(width / 2).sub(p.x.abs()).div(mx).clamp(0, 1).mul(float(height / 2).sub(p.z.abs()).div(mz).clamp(0, 1));
  };
  const seaAt = (p) => seaDisplacementAt(spectrum, vec2(p.x.mul(u.waveScale.x), p.z.mul(u.waveScale.z)), u.seaLod);
  // The composed surface at a lid rest point, the sea read `lodShift` mips
  // above the finest lid cell's. One function for both lid layouts and the rim.
  const lidSurfaceAt = (rest, lodShift = null) => {
    const world = vec2(rest.x.mul(u.waveScale.x), rest.z.mul(u.waveScale.z));
    // ⛔ A CLIPMAP LEVEL SHIFTS THE UNCLAMPED LOD. Level k's cell is 2^k of
    // the finest, so it reads each cascade at max(0, log2(cell/texel) + k) —
    // the RAW ratio, negative for a swell whose texel is a metre and a mesh
    // cell of centimetres. Adding k to the CLAMPED base pushed the swell
    // cascade to mip k from level 1 on, and by level 4 (a 60 cm cell) a
    // 24 m wave was averaged out of the geometry: the sea was flat except
    // for "the tiny rect in the centre that actually does some waves"
    // (user, 2026-09-07, a 500 m ocean seen from a metre up).
    const lods = lodShift ? u.seaLodRaw.map((l) => l.add(lodShift).max(0)) : u.seaLod;
    const sea = seaDisplacementAt(spectrum, world, lods);
    const hold = edgeHold(rest);
    const ripple = rippleAt(rest);
    return vec3(rest.x.add(sea.x.div(u.waveScale.x).mul(hold)), ripple.x.add(sea.y.div(u.waveScale.y)), rest.z.add(sea.z.div(u.waveScale.z).mul(hold)));
  };
  // ── CLIPMAP RINGS (see CLIP_ABOVE_METRES) ─────────────────────────────────
  const clipRest = (level, i, j) => {
    const cell = float(2).pow(level.toFloat());
    return lidClamp(vec3(
      u.clipCenter.x.add(i.toFloat().sub(clipHalf).mul(cell).mul(clipCell.x)).clamp(-width / 2, width / 2), 0,
      u.clipCenter.y.add(j.toFloat().sub(clipHalf).mul(cell).mul(clipCell.z)).clamp(-height / 2, height / 2)));
  };
  const clipRestUnclamped = (level, i, j) => {
    const cell = float(2).pow(level.toFloat());
    return vec3(u.clipCenter.x.add(i.toFloat().sub(clipHalf).mul(cell).mul(clipCell.x)), 0, u.clipCenter.y.add(j.toFloat().sub(clipHalf).mul(cell).mul(clipCell.z)));
  };
  const clipPoint = (level, i, j) => {
    const lf = level.toFloat();
    const fine = lidSurfaceAt(clipRest(level, i, j), lf);
    // The two coarse-lattice vertices whose edge this vertex sits on (itself,
    // twice, when it is one): odd i → its x neighbours, odd j → its z
    // neighbours, both odd → the quad's split diagonal, which the index buffer
    // runs from (i+1, j−1) to (i−1, j+1).
    const pi = i.mod(2), pj = j.mod(2), both = pi.mul(pj).mul(2);
    const a = lidSurfaceAt(clipRest(level, i.sub(pi).add(both), j.sub(pj)), lf.add(1));
    const b = lidSurfaceAt(clipRest(level, i.add(pi).sub(both), j.add(pj)), lf.add(1));
    const d = i.toFloat().sub(clipHalf).abs().max(j.toFloat().sub(clipHalf).abs()).div(clipHalf);
    const morph = select(level.equal(int(clipLevels - 1)), float(0), d.smoothstep(.7, .95));
    return mix(fine, a.add(b).mul(.5), morph);
  };
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
    const jacobianFoam = spectrum?.foam ? float(0) : seaFoldNode(jacobian).mul(u.foam.smoothstep(0, .2)); // the FOLD seeds the field only without the whitecap memory (waterSpectrum.js)
    const rise = u.waveScale.y;
    const rippleX = positions.element(east).y.sub(positions.element(west).y).div(2 * sx);
    const rippleZ = positions.element(south).y.sub(positions.element(north).y).div(2 * sz);
    const steepWorld = vec2(rippleX.mul(rise).div(u.waveScale.x), rippleZ.mul(rise).div(u.waveScale.z)).length();
    const churn = positions.element(index).y.sub(previous.element(index).y).mul(rise).div(h).abs();
    // ── FOAM IS MADE BY BREAKING WATER, NOT BY MOTION ─────────────────────
    //
    // "Too much foam on interaction, even though I reduced foam to 0.2" (user,
    // 2026-09-06, a pool white from rim to rim under a bobbing crate). The
    // churn gate opened at 0.12 m/s — a centimetre ripple at 2 Hz — and the
    // `foam` dial never touched it (it sets the wave-fold threshold only).
    // Foam entrains air where water BREAKS: a crest steeper than ~25°, or
    // water thrown upward at splash speed (half a metre a second and up). The
    // whole interaction source now sits behind the dial, so 0.2 means a fifth
    // of the foam a splash would make.
    const source = u.foam.mul(steepWorld.smoothstep(.45, .9).mul(.5).add(churn.smoothstep(.5, 1.5).mul(3))).add(jacobianFoam.mul(3));
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
    // ⭐ THE MESH NORMAL IS FLAT. Both slopes — the window's ripples and the
    // sea's cascades — are composed per PIXEL from textures
    // (`waterSurfaceLook.js`), so a splash reads the same on a 4 cm mesh and
    // on a 40 cm one; the geometry only has to be displaced.
    if (clip) {
      const level = index.div(CLIP_SIZE * CLIP_SIZE), r = index.mod(CLIP_SIZE * CLIP_SIZE);
      const i = r.mod(CLIP_SIZE), j = r.div(CLIP_SIZE);
      const rest = clipRest(level, i, j).toVar();
      normals.element(index).assign(vec3(0, 1, 0));
      output.element(index).assign(clipPoint(level, i, j));
      if (foamOut) foamOut.element(index).assign(lidFoamAt(rest, rippleAt(rest)));
      return;
    }
    const p = initial(rx, ry).toVar();
    normals.element(index).assign(vec3(0, 1, 0));
    output.element(index).assign(lidSurfaceAt(p));
    if (foamOut) foamOut.element(index).assign(lidFoamAt(p, rippleAt(p)));
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
      const jacobianFoam = spectrum?.foam ? float(0) : seaFoldNode(jacobian).mul(u.foam.smoothstep(0, .2)); // the FOLD seeds the field only without the whitecap memory (waterSpectrum.js)
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
    const m = rimN - 1;
    const k = index.sub(count).toVar();
    If(k.lessThan(ringLength * SHELL_RINGS), () => {
      const ring = k.mod(ringLength).toVar(), j = k.div(ringLength).toVar();
      const edge = ring.div(rimN).toVar(), along = ring.mod(rimN).toVar();
      const ix = int(0).toVar(), iz = int(0).toVar(), outward = vec3(0).toVar();
      If(edge.equal(int(0)), () => { ix.assign(along); iz.assign(int(0)); outward.assign(vec3(0, 0, -1)); })
        .ElseIf(edge.equal(int(1)), () => { ix.assign(int(m)); iz.assign(along); outward.assign(vec3(1, 0, 0)); })
        .ElseIf(edge.equal(int(2)), () => { ix.assign(int(m).sub(along)); iz.assign(int(m)); outward.assign(vec3(0, 0, 1)); })
        .Else(() => { ix.assign(int(0)); iz.assign(int(m).sub(along)); outward.assign(vec3(-1, 0, 0)); });
      if (round) {
        // Ring j sits at its height on the profile, along the direction of
        // the grid's rim point; ring 0 is the lid's own boundary vertex (the
        // same rest, the same surface), so the shell meets the lid exactly.
        const grid = clip ? clipRestUnclamped(int(clipLevels - 1), ix, iz) : gridRest(ix, iz);
        const dir = vec2(grid.x, grid.z).normalize();
        const yj = u.waterDepth.negate().mul(j.toFloat().div(SHELL_RINGS - 1));
        const rho = waterProfileRadiusNode(u.shape, yj);
        const slope = waterProfileRadiusNode(u.shape, yj.add(1e-3)).sub(waterProfileRadiusNode(u.shape, yj.sub(1e-3))).div(2e-3);
        // ⚠ THE LID'S OWN EXPRESSION, bit for bit — `lidClamp(grid)` is what the
        // lid vertex at this rim point computes; `dir · radius` is the same
        // point in exact arithmetic and a few ulps off in float, which a wake
        // piled against the wall turns into a millimetre seam.
        // (Over 64 m the lid is clipmap rings and its rim vertex is the outer
        // level's `clipPoint` — the sea at that level's mip — so the shell
        // must take exactly that, not the flat-grid expression.)
        const top = clip ? clipPoint(int(clipLevels - 1), ix, iz) : lidSurfaceAt(lidClamp(grid));
        if (foamOut) foamOut.element(index).assign(float(0));
        normals.element(index).assign(vec3(dir.x, slope.negate(), dir.y).normalize());
        output.element(index).assign(select(j.equal(int(0)), top, vec3(dir.x.mul(rho), yj, dir.y.mul(rho))));
        return;
      }
      const rim = (clip ? clipPoint(int(clipLevels - 1), ix, iz) : surfacePosition(iz.mul(n).add(ix))).toVar();
      if(foamOut)foamOut.element(index).assign(float(0));
      normals.element(index).assign(outward);
      output.element(index).assign(vec3(rim.x, select(k.lessThan(ringLength), rim.y, u.waterDepth.negate()), rim.z));
    }).Else(() => {
      if (round) {
        // The one vertex the bottom fan closes on.
        if (foamOut) foamOut.element(index).assign(float(0));
        normals.element(index).assign(vec3(0, -1, 0));
        output.element(index).assign(vec3(0, u.waterDepth.negate(), 0));
        return;
      }
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
  if (clip) {
    // The rings' rest lattice about the origin (the kernel re-centres it every
    // frame); level ℓ > 0 leaves the hole the finer level fills. The quad split
    // is the flat grid's — `clipPoint`'s diagonal rule depends on it.
    const hole0 = (CLIP_SIZE - 1) / 4, hole1 = hole0 * 3;
    for (let level = 0; level < clipLevels; level++) {
      const cell = 2 ** level, base = level * CLIP_SIZE * CLIP_SIZE;
      for (let j = 0; j < CLIP_SIZE; j++) for (let i = 0; i < CLIP_SIZE; i++) {
        const v = base + j * CLIP_SIZE + i;
        const px = clamp((i - clipHalf) * cell * clipCell.x, -width / 2, width / 2), pz = clamp((j - clipHalf) * cell * clipCell.z, -height / 2, height / 2);
        positionAttribute.setXYZ(v, px, 0, pz); normalAttribute.setXYZ(v, 0, 1, 0);
        uv[v * 2] = px / width + .5; uv[v * 2 + 1] = .5 - pz / height;
        if (i === CLIP_SIZE - 1 || j === CLIP_SIZE - 1) continue;
        if (level > 0 && i >= hole0 && i < hole1 && j >= hole0 && j < hole1) continue;
        indices.push(v, v + CLIP_SIZE, v + 1, v + 1, v + CLIP_SIZE, v + CLIP_SIZE + 1);
      }
    }
  } else for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const i = iy * n + ix; uv[i * 2] = ix / (n - 1); uv[i * 2 + 1] = 1 - iy / (n - 1);
    // Keep an authored rest surface on the CPU for editor picking/bounds.
    // Render and shadow passes read the GPU-deformed attribute. Raycasts are
    // intentionally rest-surface approximations, not collision geometry.
    let px = ix * dx - width / 2, pz = iy * dy - height / 2;
    if (round) { const k = Math.min(1, waterProfileRadius(shape, 0) / Math.max(1e-6, Math.hypot(px, pz))); px *= k; pz *= k; }
    positionAttribute.setXYZ(i, px, kind === "cloth" ? height - iy * dy : 0, kind === "cloth" ? 0 : pz);
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
      const [px, pz] = rimRest(ix, iz);
      if (round) {
        const len = Math.hypot(px, pz) || 1, ux = px / len, uz = pz / len;
        for (let j = 0; j < SHELL_RINGS; j++) {
          const py = -restDepth * j / (SHELL_RINGS - 1), rho = waterProfileRadius(shape, py);
          const slot = WALL_TOP + j * ringLength;
          positionAttribute.setXYZ(slot + k, ux * rho, py, uz * rho);
          normalAttribute.setXYZ(slot + k, ux, 0, uz);
          uv[(slot + k) * 2] = k / ringLength; uv[(slot + k) * 2 + 1] = 1 - j / (SHELL_RINGS - 1);
          if (j === SHELL_RINGS - 1 || k % rimN === rimN - 1) continue;
          const next = k + 1, TOP = slot, BOT = slot + ringLength;
          indices.push(TOP + k, TOP + next, BOT + k, TOP + next, BOT + next, BOT + k);
        }
        if (k % rimN !== rimN - 1) indices.push(WALL_BOTTOM + k, WALL_BOTTOM + k + 1, FLOOR);
        continue;
      }
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
      if (k % rimN === rimN - 1) continue;
      const next = k + 1;
      indices.push(WALL_TOP + k, WALL_TOP + next, WALL_BOTTOM + k, WALL_TOP + next, WALL_BOTTOM + next, WALL_BOTTOM + k);
    }
    if (round) {
      positionAttribute.setXYZ(FLOOR, 0, -restDepth, 0); normalAttribute.setXYZ(FLOOR, 0, -1, 0); uv[FLOOR * 2] = .5; uv[FLOOR * 2 + 1] = .5;
    } else {
      const corners = [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]];
      for (let c = 0; c < 4; c++) {
        positionAttribute.setXYZ(FLOOR + c, corners[c][0], -restDepth, corners[c][1]);
        normalAttribute.setXYZ(FLOOR + c, 0, -1, 0);
        uv[(FLOOR + c) * 2] = c === 1 || c === 2 ? 1 : 0; uv[(FLOOR + c) * 2 + 1] = c >= 2 ? 1 : 0;
      }
      indices.push(FLOOR, FLOOR + 1, FLOOR + 2, FLOOR, FLOOR + 2, FLOOR + 3);
    }
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
  // The LID: the medium (scene.fogNode) treats it as the interface — no water
  // path to it from above, the whole path from below (waterMedium.js).
  if (kind === "water") mesh.userData.waterLid = true;
  mesh.userData.giGpuGrid = { positionAttribute, resolution: n };
  if(waterSurfaceTexture)mesh.userData.waterSurfaceTexture=waterSurfaceTexture;
  mesh.userData.noBatch = true;
  mesh.userData.noMerge = true;
  // ⚠ A WATER LID NEVER CASTS A SHADOW-MAP SHADOW. It transmits 98 % of the
  // sun; its "shadow" on the pool floor is the caustic gain (focus ×
  // absorption). Cast as an opaque occluder it blacked out the floor under
  // every pool, and the lens had nothing to modulate — "caustics are way too
  // dim, even when increased intensity" (user, 2026-09-06; their Water had
  // castShadow on). Cloth is opaque and casts.
  mesh.frustumCulled = false; mesh.castShadow = kind !== "water"; mesh.receiveShadow = true;
  // The shell: a clear Fresnel interface and nothing else. Transmission 1 with
  // no thickness means it tints nothing — everything a viewer sees through the
  // side of the body has already been attenuated by the medium over the exact
  // path it took, and tinting again here would be that water counted twice.
  const skirtMaterial = skirtGeometry
    // ⚠ depthTest STAYS ON. With it off the shell painted over the lid wherever
    // it rasterized, regardless of what was in front — a flat lighter quad
    // sitting across the near corner of every pool, which no amount of looking
    // at the surface shader explains.
    // ⚠ POLYGON OFFSET: a water box sized to its pool's interior puts this
    // shell's side faces exactly ON the pool's walls, and two coincident
    // surfaces z-fight into flickering stripes underwater (user's scene,
    // 2026-09-06; a 1 % scale nudge was the workaround). Pushed a little
    // deeper, the shell yields to whatever wall it touches; the medium still
    // tints that wall by the water the eye's ray crossed.
    ? new THREE.MeshPhysicalNodeMaterial({ roughness: .06, metalness: 0, transmission: 1, thickness: 0, ior: 1.333,
        transparent: true, depthWrite: false, depthTest: true, side: THREE.FrontSide,
        polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 })
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
  // Where the eye wants the window; the tick moves it (see `followCamera`).
  let targetCenter = null;
  // The eye in the sea's metres (local × scale), for the whitecap memory window.
  let seaEye = null;
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
    if (shape) { const s = waterVolumeShape(p); Object.assign(shape, s); u.shape.value.set(s.kind, s.radius, s.centerY, s.height); }
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
      // ⚠ NOT `material.transmission`: the surface look refracts for itself
      // (`waterSurfaceLook.js`) and keeps three's transmission OFF — its ray
      // is scaled per axis by the mesh. The dial lives in `u.transmission`.
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
    mesh.castShadow = kind !== "water" && p.castShadow !== false; mesh.receiveShadow = p.receiveShadow !== false;
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
      seaEye = [(Number(x) || 0) * u.waveScale.value.x, (Number(z) || 0) * u.waveScale.value.z];
      if (!windowed) return;
      targetCenter = {
        x: Math.max(-(width / 2 - winW / 2), Math.min(width / 2 - winW / 2, Number(x) || 0)),
        z: Math.max(-(height / 2 - winH / 2), Math.min(height / 2 - winH / 2, Number(z) || 0)),
        eyeX: clamp(Number(x) || 0, -width / 2, width / 2), eyeZ: clamp(Number(z) || 0, -height / 2, height / 2),
      };
    },
    /** The window's centre in local units (a Vector2: x, z). */
    get rippleCenter() { return u.rippleCenter.value; },
    /** The volume's shape (kind, radius, centerY, height) in local units — see waterVolume.js. */
    shape,
    /** Every compute kernel by name, for the compile-timing smoke. */
    kernels: { integrate, commit, injectWater, foamField, rippleWrite, surface, shift0: shiftKernels[0], shift1: shiftKernels[1], shift2: shiftKernels[2], shift3: shiftKernels[3] },
    /** The lid's layout: clipmap rings over a wide pool, or null for the flat grid. */
    clip: clip ? { levels: clipLevels, size: CLIP_SIZE, cell: clipCell, get center() { return u.clipCenter.value; } } : null,
    /** The sea as the CPU last saw it — `waterPhysics.js` floats bodies on this. */
    get seaSample() { return seaSample; },
    /** Harness aid: force every cascade to mip 0 for a bit-level parity check. */
    seaLodOverride: null,
    /** The window edge's absorbing band — off only for a harness control arm. */
    sponge: true,
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
        // ⛔ THE CLIPMAP'S CELL AT THE EYE, not the base grid's. The base grid
        // is the 32 m window at 512 (a metre of local width over a 500 m
        // sea reads as a METRE here), and the LOD it set put every clipmap
        // level three mips too coarse: the swell survived only the innermost
        // rings ("the tiny rect in the centre that actually does some
        // waves", user, 2026-09-07). Level 0 is WATER_CELL_METRES; the levels
        // add their index to the raw ratio (see lidSurfaceAt).
        const vertexCell = clip
          ? Math.max(clipCell.x * u.waveScale.value.x, clipCell.z * u.waveScale.value.z)
          : Math.max(dx * u.waveScale.value.x, dy * u.waveScale.value.z);                  // the render mesh's
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
          u.seaLodRaw[i].value = simulation.seaLodOverride ?? Math.max(-16, Math.log2(Math.max(1e-6, vertexCell / (c.L / spectrum.size))));
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
      if (!initialized) { queue.push(init); initialized = true; targetCenter = null; }
      if (targetCenter && clip) {
        // The rings' centre snaps to the coarsest cell so every level's lattice
        // stays inside the next one's (see CLIP_ABOVE_METRES).
        u.clipCenter.value.set(
          clamp(Math.round(targetCenter.eyeX / clipCoarsest.x) * clipCoarsest.x, -width / 2, width / 2),
          clamp(Math.round(targetCenter.eyeZ / clipCoarsest.z) * clipCoarsest.z, -height / 2, height / 2));
      }
      if (targetCenter) {
        // The window moves here, in whole cells, and the field moves with it in
        // the same queue — a centre that moved before its field would put this
        // frame's ripples a step from where they were made.
        const di = Math.round((targetCenter.x - u.rippleCenter.value.x) / sx), dj = Math.round((targetCenter.z - u.rippleCenter.value.y) / sz);
        if (di || dj) {
          u.rippleCenter.value.x += di * sx; u.rippleCenter.value.y += dj * sz;
          u.rippleShift.value.set(di, dj);
          queue.push(...shiftKernels);
        }
        targetCenter = null;
      }
      if (windowed) {
        // A side is sponged where the window's edge lies inside the pool
        // (`simulation.sponge = false` is the harness's control arm).
        const c = u.rippleCenter.value;
        if (!simulation.sponge) u.rippleSponge.value.set(0, 0, 0, 0); else u.rippleSponge.value.set(
          c.x - winW / 2 > -width / 2 + sx ? 1 : 0, c.x + winW / 2 < width / 2 - sx ? 1 : 0,
          c.y - winH / 2 > -height / 2 + sz ? 1 : 0, c.y + winH / 2 < height / 2 - sz ? 1 : 0);
      }
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
        try { causticPass.render(renderer, { sun: anchorEngine?.waterSlots?.sun ?? null, shadowNode: anchorEngine?.waterSlots?.sunShadowNode ?? null }); } finally { globalThis.__giNestedRender = nested; }
      }
      // The sea advances before the surface reads it; the foam field and the
      // ripple texture follow the substeps and precede the render surface.
      // Its own submission, and its mips made before anything samples them
      // (see waterSpectrum.js `generateMipmaps`).
      if (spectrum) {
        const seaQueue = spectrum.passes(delta, elapsed, { eye: seaEye, foam: u.foam.value });
        if (seaQueue.length) { renderer.compute(seaQueue); spectrum.generateMipmaps(renderer); }
      }
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
