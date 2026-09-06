import { Matrix4, Vector3 } from "three/webgpu";

/**
 * THE WATER VOLUME — one definition of "where the water is", shared by every
 * consumer that needs it: buoyancy (`waterPhysics.js`), the rendered body
 * (`gridSimulation.js`'s skirt), the caustic map (`waterSlots.js`), the
 * underwater medium (`waterMedium.js`) and the GI sun term.
 *
 * The simulation mesh's local origin sits ON the rest surface, so in its local
 * space the water is the axis-aligned box
 *
 *     x ∈ [-width/2, width/2]   y ∈ [-depth, 0]   z ∈ [-height/2, height/2]
 *
 * whose TOP face is displaced by the wave heightfield. `width`/`height` are the
 * source mesh's own geometry extent (a Plane's size, or a Box's X/Z size) and
 * `depth` is `waterDepth` — which a Box source overrides with its Y size, so a
 * box of water is exactly the box the author drew.
 *
 * Every quantity here is LOCAL. World space is reached through the mesh matrix
 * and nothing in this file assumes that matrix is axis-aligned — the one thing
 * a heightfield genuinely requires is that its local +Y is roughly the world
 * vertical, and `waterSurfaceFrame` is where that is tested, ONCE.
 */

const finite = (v, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Number(v) : fallback));

/** The local box, in the source mesh's own units. */
export function waterVolumeExtent(props = {}) {
  return {
    halfX: finite(props.width, 4, .1, 1000) / 2,
    halfZ: finite(props.height, 4, .1, 1000) / 2,
    depth: finite(props.waterDepth, 2, .01, 1000),
  };
}

/**
 * The mesh's world frame, reduced to what a heightfield query needs.
 *
 * ⚠ **THE HORIZONTALITY TEST IS ON THE AXIS, NOT ON A MATRIX ELEMENT.** It used
 * to read `|inverse.elements[5]| < .2`, which is not a tilt at all — for an
 * axis-aligned mesh that element is 1/scaleY, so the test actually said "reject
 * any water scaled thicker than 5 units", and it silently returned a query that
 * answered `null` everywhere. The user's own pool (a Plane rotated -90° with a
 * Z scale of 5.32, giving the sim mesh a Y scale of 5.32 and an inverse element
 * of 0.188) fell through it, and buoyancy therefore did nothing at all while
 * every unit test — none of which scales past 3 — passed (2026-09-05).
 *
 * `up` is the normalized local +Y in world space: its `.y` IS the cosine of the
 * tilt, independent of scale, which is the quantity the guard always meant.
 */
export function waterSurfaceFrame(mesh) {
  mesh.updateWorldMatrix(true, false, true);
  const inverse = new Matrix4().copy(mesh.matrixWorld).invert();
  const up = new Vector3(0, 1, 0).transformDirection(mesh.matrixWorld);
  // The UNNORMALIZED local +Y: one local unit of height is this many world
  // metres of rise. `matrixWorld.elements[5]` is its world-Y component, and
  // that — not the inverse's — is what converts a local height to a world one.
  const axisX = new Vector3().setFromMatrixColumn(mesh.matrixWorld, 0);
  const axisY = new Vector3().setFromMatrixColumn(mesh.matrixWorld, 1);
  const axisZ = new Vector3().setFromMatrixColumn(mesh.matrixWorld, 2);
  // World metres per local unit on each axis. The wave field is authored in
  // METRES (see `gridSimulation.js`'s `surfacePosition`), so both sides of the
  // CPU/GPU parity have to scale into it and back the same way.
  const scale = new Vector3(Math.max(1e-4, axisX.length()), Math.max(1e-4, axisY.length()), Math.max(1e-4, axisZ.length()));
  return { inverse, up, axisY, scale, rise: axisY.y, horizontal: up.y > .2 };
}

/**
 * ══ SATURATION IS A SIGHT RANGE ════════════════════════════════════════════
 *
 * "This is basically how deep we can see in the water. Saturation 1 means we
 * don't see through water at all. 0.5 — we see something underwater that is not
 * further than half of the height of the volume. The deeper the object, the
 * dimmer it appears" (user, 2026-09-06).
 *
 * So the dial is a DISTANCE, expressed as a fraction of the volume's own depth,
 * and the coefficient is derived from it:
 *
 *     range R = depth · (1 − s) / (2s)        σ = 3 / R
 *
 * which is the only simple form that hits all three points the spec names:
 * R(0) = ∞ (crystal clear, everything visible however deep), R(0.5) = half the
 * depth, R(1) = 0 (nothing gets through). Three optical depths is what "as far
 * as you can see" means — 5 % of the light left, the edge of visible.
 *
 * ⚠ EARLIER THIS WAS `T(depth) = 1 − s`, which is right at both ends and far
 * too gentle everywhere between: at 0.5 an object at half depth still came
 * through at 71 % when the spec says it should be at the limit of sight. The
 * ends agreeing is not the same as the dial meaning anything.
 *
 * Returned PER UNIT OF LOCAL DEPTH, because every other water quantity is in
 * the surface's own units; `waterCaustics.js` divides by `rise` where it needs
 * world metres.
 */
export function waterSaturation(props = {}, localDepth = 1) {
  const depth = Math.max(1e-4, Number(localDepth) || 1);
  if (Number.isFinite(Number(props.saturation))) return Math.min(1, Math.max(0, Number(props.saturation)));
  // Scenes authored before the dial existed carry the raw coefficient; invert
  // the relation rather than dropping their look on the floor.
  const legacy = Number(props.absorption);
  if (!Number.isFinite(legacy)) return .3;
  const tau = Math.max(0, legacy) * depth;
  return Math.min(1, Math.max(0, tau / (6 + tau)));
}

/** The extinction per local unit that realizes a sight range over `depth`. */
export function waterExtinction(saturation, localDepth = 1) {
  const s = Math.min(.999, Math.max(0, Number(saturation) || 0));
  if (s <= 0) return 0;
  const depth = Math.max(1e-4, Number(localDepth) || 1);
  return 6 * s / ((1 - s) * depth);
}

/**
 * ══ THE GRID FOLLOWS THE WATER'S SIZE, NOT A NUMBER IN A FIELD ═════════════
 *
 * "Impact from object hitting the water looks quite good, but only at specific
 * scale. Make it larger, and it does not work" (user, 2026-09-06). A fixed
 * 128² grid over a 5 m pool has 4 cm cells and a half-metre body spans twelve
 * of them; over a 60 m lake the same grid has 47 cm cells and the same body
 * is barely one — every wake floor, every Nyquist fade and every foam term
 * then works in CELLS and the look changes with the box. The resolution is
 * therefore derived from the world footprint at a fixed cell size, capped
 * where a single heightfield stops being the right representation.
 *
 * ⚠ 4 cm is the cell size the user's own pool was authored at and liked; it
 * is kept as the target so a 5 m pool costs what it did.
 */
export const WATER_CELL_METRES = .04;
export const WATER_MIN_RESOLUTION = 48;
export const WATER_MAX_RESOLUTION = 512;
export function waterAutoResolution(worldSize) {
  const size = Number(worldSize);
  if (!Number.isFinite(size) || size <= 0) return 128;
  return Math.min(WATER_MAX_RESOLUTION, Math.max(WATER_MIN_RESOLUTION, Math.round(size / WATER_CELL_METRES)));
}
