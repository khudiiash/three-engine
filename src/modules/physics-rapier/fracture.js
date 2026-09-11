import * as THREE from "three/webgpu";
import { Brush, Evaluator, INTERSECTION } from "three-bvh-csg";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";

/**
 * Voronoi fracture — turning one rendered object into the pieces it breaks
 * into.
 *
 * ## Why Voronoi cells and not a pre-authored break-up
 *
 * A destructible crate authored as twelve separate meshes is twelve meshes an
 * artist has to make, keep in sync with the intact model, and re-make when the
 * crate changes. A Voronoi cell decomposition derives them: scatter N sites
 * through the object's volume, give each site the region closer to it than to
 * any other, and intersect those regions with the object. The result tiles the
 * original exactly — no gaps, no overlap, every interior face shared with
 * exactly one neighbour — which is what makes the pieces look like they came
 * from the thing that broke rather than like debris dropped on top of it.
 *
 * ## How a cell is built
 *
 * A Voronoi cell is the intersection of half-spaces: for each other site, the
 * half-space on this site's side of the bisecting plane. So the cell starts as
 * the object's (slightly grown) bounding box and is clipped by one plane per
 * other site. Clipping a CONVEX polyhedron is exact and cheap — Sutherland–
 * Hodgman on each face plus one new cap face from the cut edges — and the
 * result stays convex, which matters twice over: the clip stays valid, and the
 * fragment's collider can be a convex hull (Rapier's fastest solid shape)
 * rather than a hollow triangle surface.
 *
 * The cell is then intersected with the real geometry by CSG (`three-bvh-csg`,
 * already a dependency for the boolean geometry modifier), which is what gives
 * the piece the object's actual surface, UVs and material on the outside and a
 * flat cut on the inside.
 *
 * ## What this file deliberately does not do
 *
 * Nothing here touches Rapier, entities or the scene — it is geometry in,
 * geometry out, so it runs headlessly in a test and can be called from a
 * background bake. `DestructibleComponent` owns everything about *when* a
 * fracture happens and what it spawns.
 *
 * ⚠ COST. One CSG intersection per (cell × source mesh) pair. On a 5k-triangle
 * crate at 12 pieces that is tens of milliseconds; on a 200k-triangle model at
 * 60 pieces it is seconds. It must therefore never run inside a click or a
 * frame that has to ship — `DestructibleComponent.prefracture()` is the
 * budgeted, cached path and the component uses it before the break, not
 * during.
 */

/** Same mulberry32 the instancer scatters with — one seed, one layout, forever. */
function makeRng(seed) {
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points closer together than this are the same point (metres). */
const WELD_EPSILON = 1e-6;
/** Half-space test tolerance — a vertex this close to the plane is ON it. */
const PLANE_EPSILON = 1e-7;

/**
 * A convex polyhedron as an array of faces, each an array of Vector3 wound
 * counter-clockwise seen from outside. The box the clipping starts from.
 */
function boxPolyhedron(min, max) {
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const [x0, y0, z0] = [min.x, min.y, min.z];
  const [x1, y1, z1] = [max.x, max.y, max.z];
  return [
    [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)], // +Z
    [v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0)], // -Z
    [v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)], // +X
    [v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)], // -X
    [v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), v(x0, y1, z0)], // +Y
    [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)], // -Y
  ];
}

/**
 * Clips a convex polyhedron by the half-space `dot(normal, p) <= offset`.
 * Returns the clipped faces, or null when nothing survives.
 *
 * The cut edges of every clipped face together form one closed convex polygon —
 * the cap. It is rebuilt by angle around its own centroid rather than by
 * chasing edge adjacency: adjacency needs exact shared vertices, and two faces
 * that cut the same edge produce the same point through two different
 * interpolations, which agree to within a float epsilon and not more.
 */
function clipPolyhedron(faces, normal, offset) {
  const out = [];
  const cut = [];
  for (const face of faces) {
    const kept = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const da = normal.dot(a) - offset;
      const db = normal.dot(b) - offset;
      if (da <= PLANE_EPSILON) kept.push(a);
      if ((da < -PLANE_EPSILON && db > PLANE_EPSILON) || (da > PLANE_EPSILON && db < -PLANE_EPSILON)) {
        const t = da / (da - db);
        const point = a.clone().lerp(b, t);
        kept.push(point);
        cut.push(point);
      }
    }
    if (kept.length >= 3) out.push(kept);
  }
  if (!out.length) return null;

  const cap = orderCapPolygon(cut, normal);
  if (cap) out.push(cap);
  return out;
}

/** The cap face for a clip: the cut points, welded, wound so its normal is +n. */
function orderCapPolygon(points, normal) {
  const unique = [];
  for (const point of points) {
    if (!unique.some((other) => other.distanceToSquared(point) < WELD_EPSILON * WELD_EPSILON)) unique.push(point);
  }
  if (unique.length < 3) return null;
  const centre = new THREE.Vector3();
  for (const point of unique) centre.add(point);
  centre.multiplyScalar(1 / unique.length);
  // Any two perpendicular directions in the plane; the sort only needs a
  // consistent frame, not a canonical one.
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(normal.x) > 0.9) u.set(0, 1, 0);
  u.crossVectors(normal, u).normalize();
  const w = new THREE.Vector3().crossVectors(normal, u);
  const sorted = unique
    .map((point) => {
      const d = point.clone().sub(centre);
      return { point, angle: Math.atan2(d.dot(w), d.dot(u)) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((entry) => entry.point);
  // `u × w = normal`, so increasing angle is counter-clockwise seen from +n —
  // the outward winding, since the kept half-space is behind the plane.
  return sorted;
}

/** Triangulates a convex-polygon face list into a position-only geometry. */
function polyhedronGeometry(faces) {
  const positions = [];
  for (const face of faces) {
    for (let i = 1; i < face.length - 1; i++) {
      positions.push(
        face[0].x, face[0].y, face[0].z,
        face[i].x, face[i].y, face[i].z,
        face[i + 1].x, face[i + 1].y, face[i + 1].z,
      );
    }
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  // The CSG evaluator carries a fixed attribute list across both operands; a
  // brush missing one of them reads garbage from the other's buffer.
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
  return geometry;
}

/** Signed volume of a closed triangle mesh — the piece's share of the mass. */
export function geometryVolume(geometry) {
  const position = geometry?.getAttribute?.("position");
  if (!position) return 0;
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;
  for (let i = 0; i < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    volume += a.dot(b.clone().cross(c)) / 6;
  }
  return Math.abs(volume);
}

/**
 * Every rendered mesh `root` owns, as geometry baked into `root`'s own local
 * frame plus the material it draws with.
 *
 * `ownerEntityId` is the same provenance filter the collision cook uses: a
 * child mesh ENTITY is its own object and must not be fractured by its
 * parent, while a plain THREE.Mesh added under the entity (an imported GLB's
 * submeshes, the editor's own proxies aside) belongs to it.
 */
export function collectFractureSources(root, ownerEntityId = null) {
  const sources = [];
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const local = new THREE.Matrix4();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!object.isMesh || object.isInstancedMesh) return;
    if (object.layers?.isEnabled?.(EDITOR_LAYER)) return;
    if (object.userData?.editorOnly || object.userData?.isHelper) return;
    if (ownerEntityId && object.userData?.entityId && object.userData.entityId !== ownerEntityId) return;
    const geometry = object.geometry;
    if (!geometry?.getAttribute?.("position")) return;
    const baked = geometry.clone();
    local.multiplyMatrices(inverse, object.matrixWorld);
    baked.applyMatrix4(local);
    if (!baked.getAttribute("normal")) baked.computeVertexNormals();
    if (!baked.getAttribute("uv")) {
      baked.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(baked.getAttribute("position").count * 2), 2));
    }
    baked.clearGroups();
    sources.push({ geometry: baked, material: object.material });
  });
  return sources;
}

/**
 * Fracture sites: `count` points inside `bounds`.
 *
 * `pattern: "impact"` clusters them around `focus` — cube-rooting a uniform
 * random radius gives a uniform density in the SPHERE, so raising it to a
 * higher power instead concentrates the sites near the centre, which is what
 * makes an impact produce a shattered middle and a few big outer pieces
 * instead of an evenly diced object.
 */
function fractureSites(bounds, { count, seed, pattern, focus }) {
  const rng = makeRng(seed);
  const size = bounds.getSize(new THREE.Vector3());
  const centre = bounds.getCenter(new THREE.Vector3());
  const sites = [];
  const radius = Math.max(size.x, size.y, size.z) * 0.5;
  const origin = pattern === "impact" && focus ? focus.clone() : centre;
  for (let i = 0; i < count; i++) {
    if (pattern === "impact") {
      const r = radius * Math.pow(rng(), 2.2);
      const theta = rng() * Math.PI * 2;
      const phi = Math.acos(2 * rng() - 1);
      const point = new THREE.Vector3(
        origin.x + r * Math.sin(phi) * Math.cos(theta),
        origin.y + r * Math.sin(phi) * Math.sin(theta),
        origin.z + r * Math.cos(phi),
      );
      // A site outside the object contributes a cell that clips to nothing;
      // clamping keeps the piece count close to what was asked for.
      sites.push(point.clamp(bounds.min, bounds.max));
      continue;
    }
    sites.push(new THREE.Vector3(
      bounds.min.x + rng() * size.x,
      bounds.min.y + rng() * size.y,
      bounds.min.z + rng() * size.z,
    ));
  }
  return sites;
}

/**
 * Fractures `sources` (from `collectFractureSources`) into pieces.
 *
 * Returns `[{ offset, volume, parts: [{ geometry, material }] }]`, where each
 * piece's geometry is recentred on its own centre of bounds and `offset` says
 * where that centre was — a rigid body has to be built around its own origin,
 * or the piece spins about a point somewhere outside itself.
 *
 * @param {{geometry: THREE.BufferGeometry, material: any}[]} sources
 * @param {object} [options]
 * @param {number} [options.pieces] How many cells to attempt.
 * @param {number} [options.seed]
 * @param {"uniform"|"impact"} [options.pattern]
 * @param {THREE.Vector3} [options.focus] Impact point, in the same local frame.
 */
export function fractureGeometry(sources, options = {}) {
  return [...fractureSteps(sources, options)];
}

/**
 * `fractureGeometry` one piece at a time.
 *
 * ⚠ THE FRACTURE MUST BE INTERRUPTIBLE, because it is the one part of this
 * feature big enough to be a freeze: a 60-piece cut of a dense model is
 * seconds of CSG, and the editor's rule is that no authoring action blocks the
 * frame (docs/ZERO_FREEZE_PLAN.md). Each cell is independent once the sites
 * are chosen, so the loop yields between them and `DestructibleComponent`
 * drains it against an idle budget. Callers that genuinely want it all at once
 * (a test, a headless bake) use `fractureGeometry`.
 */
export function* fractureSteps(sources, {
  pieces = 12,
  seed = 1,
  pattern = "uniform",
  focus = null,
} = {}) {
  const usable = (sources ?? []).filter((source) => source?.geometry?.getAttribute?.("position")?.count >= 3);
  if (!usable.length || pieces < 2) return;

  const bounds = new THREE.Box3();
  for (const source of usable) {
    source.geometry.computeBoundingBox();
    bounds.union(source.geometry.boundingBox);
  }
  if (bounds.isEmpty()) return;
  // The cell box has to contain the object with room to spare: a cell that
  // ends exactly on the surface leaves the CSG intersecting two coplanar
  // faces, which is the one configuration boolean evaluators get wrong.
  const grown = bounds.clone().expandByVector(bounds.getSize(new THREE.Vector3()).multiplyScalar(0.05).addScalar(0.01));

  const sites = fractureSites(bounds, { count: pieces, seed, pattern, focus });
  const evaluator = new Evaluator();
  evaluator.attributes = ["position", "normal", "uv"];
  evaluator.useGroups = false;

  // ⚠ ONE BRUSH PER SOURCE, NOT ONE PER CUT. `Brush.prepareGeometry` builds the
  // half-edge/BVH structures the evaluator walks and caches them on the brush
  // by geometry hash — so a brush rebuilt inside the cell loop pays that build
  // once per PIECE, which on a dense model is most of the fracture's cost and
  // all of it avoidable.
  const sourceBrushes = usable.map((source) => {
    const brush = new Brush(source.geometry);
    brush.updateMatrixWorld(true);
    return brush;
  });

  const bisectorNormal = new THREE.Vector3();
  const midpoint = new THREE.Vector3();
  for (let i = 0; i < sites.length; i++) {
    let faces = boxPolyhedron(grown.min, grown.max);
    for (let j = 0; j < sites.length && faces; j++) {
      if (i === j) continue;
      bisectorNormal.subVectors(sites[j], sites[i]);
      const length = bisectorNormal.length();
      if (length < WELD_EPSILON) continue; // two sites landed on each other
      bisectorNormal.multiplyScalar(1 / length);
      midpoint.addVectors(sites[i], sites[j]).multiplyScalar(0.5);
      faces = clipPolyhedron(faces, bisectorNormal, bisectorNormal.dot(midpoint));
    }
    if (!faces) continue;
    const cell = polyhedronGeometry(faces);
    if (!cell) continue;
    const cellBrush = new Brush(cell);
    cellBrush.updateMatrixWorld(true);

    const parts = [];
    for (let s = 0; s < usable.length; s++) {
      const piece = intersect(evaluator, sourceBrushes[s], cellBrush);
      if (!piece) continue;
      parts.push({ geometry: piece, material: usable[s].material });
    }
    cell.dispose();
    if (!parts.length) continue;

    const pieceBounds = new THREE.Box3();
    for (const part of parts) {
      part.geometry.computeBoundingBox();
      pieceBounds.union(part.geometry.boundingBox);
    }
    const offset = pieceBounds.getCenter(new THREE.Vector3());
    let volume = 0;
    for (const part of parts) {
      part.geometry.translate(-offset.x, -offset.y, -offset.z);
      part.geometry.computeBoundingBox();
      part.geometry.computeBoundingSphere();
      volume += geometryVolume(part.geometry);
    }
    yield { offset, volume, parts };
  }
}

/** One CSG intersection, or null when the cell misses this mesh entirely. */
function intersect(evaluator, sourceBrush, cellBrush) {
  let result = null;
  try {
    result = evaluator.evaluate(sourceBrush, cellBrush, INTERSECTION).geometry;
  } catch (error) {
    console.warn(`Fracture: a piece could not be cut (${error?.message ?? error}); skipping it.`);
    return null;
  }
  const position = result?.getAttribute?.("position");
  if (!position || position.count < 3) {
    result?.dispose?.();
    return null;
  }
  // Copied out rather than kept: the evaluator's buffers are grown to the
  // worst case it has seen, so a fragment of 30 triangles can otherwise hold
  // the allocation of the biggest piece in the object — times every piece.
  const copy = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const attribute = result.getAttribute(name);
    if (attribute) copy.setAttribute(name, new THREE.BufferAttribute(attribute.array.slice(0, attribute.count * attribute.itemSize), attribute.itemSize));
  }
  if (result.index) copy.setIndex(new THREE.BufferAttribute(result.index.array.slice(0, result.index.count), 1));
  return copy;
}
