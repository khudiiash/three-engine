/**
 * SPLITTING A GEOMETRY INTO ITS DISCONNECTED PIECES.
 *
 * An imported model routinely packs several unrelated surfaces into one mesh —
 * Sponza ships its curtains three and four to a `.geom` — and almost every
 * per-object decision then has to be made for the group instead of the thing:
 * one cloth component for three curtains, one collider, one material slot, one
 * enabled flag. Worse, any quantity DERIVED from the mesh is derived from all
 * of them at once, which is its own class of bug (a single thin curtain in a
 * file dragged every other curtain's contact radius to half what it needed).
 *
 * ⛔⛔ ISLANDS ARE FOUND ON WELDED POSITIONS, NEVER ON INDICES. A model with UV
 * seams, split normals or per-face materials stores the SAME point several
 * times — Sponza's curtain has 7 739 vertices for 7 174 distinct positions —
 * and index connectivity would call every seam a separate piece, shattering one
 * curtain into dozens of ribbons. Two triangles that meet in space are one
 * surface however many vertices the exporter used to say so.
 */

/** Coincident within this distance is the same point. */
export const ISLAND_WELD_EPSILON = 1e-5;

/**
 * Welds coincident vertices and returns a representative id per vertex.
 *
 * ⚠ A quantised hash key ALONE is not a weld: two points 0.4 eps apart can
 * land either side of a cell boundary and never be compared. The 27-cell
 * neighbourhood search is what makes the epsilon mean what it says.
 */
function weldVertices(positions, epsilon) {
  const count = positions.length / 3;
  const weldOf = new Int32Array(count).fill(-1);
  const cells = new Map();
  const reps = [];
  const cellOf = (v, k) => Math.floor(positions[v * 3 + k] / epsilon);
  for (let v = 0; v < count; v++) {
    const cx = cellOf(v, 0), cy = cellOf(v, 1), cz = cellOf(v, 2);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const candidate of list) {
            const r = reps[candidate];
            if (Math.abs(positions[v * 3] - positions[r * 3]) <= epsilon
              && Math.abs(positions[v * 3 + 1] - positions[r * 3 + 1]) <= epsilon
              && Math.abs(positions[v * 3 + 2] - positions[r * 3 + 2]) <= epsilon) { found = candidate; break; }
          }
        }
      }
    }
    if (found < 0) {
      found = reps.length;
      reps.push(v);
      const key = `${cx},${cy},${cz}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(found);
    }
    weldOf[v] = found;
  }
  return { weldOf, weldCount: reps.length };
}

/**
 * Which connected piece each vertex and each triangle belongs to.
 *
 * Connectivity is through shared WELDED positions, so a seam does not divide a
 * surface. A vertex referenced by no triangle gets island -1 and is dropped by
 * the split rather than becoming a piece of its own.
 */
export function geometryIslands(definition, { weldEpsilon = ISLAND_WELD_EPSILON } = {}) {
  const positions = definition?.positions;
  if (!positions?.length) return { count: 0, islandOfVertex: new Int32Array(0), islandOfTriangle: new Int32Array(0), triangleCount: 0 };
  const vertexCount = positions.length / 3;
  const indices = definition.indices ?? null;
  const triangleCount = Math.floor((indices ? indices.length : vertexCount) / 3);
  const corner = (t, j) => (indices ? indices[t * 3 + j] : t * 3 + j);

  const { weldOf, weldCount } = weldVertices(positions, weldEpsilon);

  // Union-find over welded vertices, joined by every triangle.
  const parent = new Int32Array(weldCount);
  for (let i = 0; i < weldCount; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let t = 0; t < triangleCount; t++) {
    const a = weldOf[corner(t, 0)], b = weldOf[corner(t, 1)], c = weldOf[corner(t, 2)];
    union(a, b); union(b, c);
  }

  // Number the roots in first-appearance order, so island 0 is the piece whose
  // first triangle comes first — stable across runs and readable in a report.
  const label = new Map();
  const islandOfTriangle = new Int32Array(triangleCount).fill(-1);
  for (let t = 0; t < triangleCount; t++) {
    const root = find(weldOf[corner(t, 0)]);
    let id = label.get(root);
    if (id === undefined) { id = label.size; label.set(root, id); }
    islandOfTriangle[t] = id;
  }
  const islandOfVertex = new Int32Array(vertexCount).fill(-1);
  for (let t = 0; t < triangleCount; t++) {
    for (let j = 0; j < 3; j++) islandOfVertex[corner(t, j)] = islandOfTriangle[t];
  }
  return { count: label.size, islandOfVertex, islandOfTriangle, triangleCount };
}

/** Copies the `stride`-wide rows named by `keep` out of a flat array. */
function gatherFlat(source, keep, stride, ArrayType) {
  if (!source) return null;
  const out = new ArrayType(keep.length * stride);
  for (let i = 0; i < keep.length; i++) {
    const from = keep[i] * stride;
    for (let k = 0; k < stride; k++) out[i * stride + k] = source[from + k];
  }
  return out;
}

/** Same, for an `{ array, itemSize }` attribute record. */
function gatherAttribute(attribute, keep) {
  const stride = attribute?.itemSize ?? 0;
  if (!attribute?.array || !(stride > 0)) return null;
  const Type = attribute.array.constructor ?? Float32Array;
  return { ...attribute, array: gatherFlat(attribute.array, keep, stride, Type) };
}

/**
 * Splits a geometry definition into one definition per connected piece.
 *
 * Returns the definitions in island order. A geometry with a single piece
 * returns a one-element array holding a copy, so callers do not need a special
 * case — but `geometryIslands(...).count` is the cheap way to ask first.
 *
 * ⚠ EDIT-MODE TOPOLOGY IS DROPPED. `editMesh`, `edges` and `hiddenEdges` are
 * the geometry editor's own record of polygons, per-corner UVs and edge flags,
 * indexed against the ORIGINAL vertex numbering. Remapping them is a separate
 * job and getting it subtly wrong would corrupt a mesh the moment someone
 * opened it in Edit Mode — losing them costs a re-derive on next open, which is
 * what the editor already does for any imported mesh. `droppedEditTopology`
 * says when it happened so a caller can tell the user rather than guess.
 */
export function splitGeometryIslands(definition, options = {}) {
  const { count, islandOfVertex, islandOfTriangle, triangleCount } = geometryIslands(definition, options);
  if (!count) return [];

  const positions = definition.positions;
  const indices = definition.indices ?? null;
  const corner = (t, j) => (indices ? indices[t * 3 + j] : t * 3 + j);
  const vertexCount = positions.length / 3;

  // A triangle's material, so the split can rebuild `groups` rather than lose
  // multi-material meshes to a single slot.
  const materialOfTriangle = new Int32Array(triangleCount).fill(0);
  let hasGroups = false;
  for (const group of definition.groups ?? []) {
    if (![group?.start, group?.count, group?.materialIndex].every(Number.isInteger)) continue;
    hasGroups = true;
    for (let i = 0; i < group.count; i += 3) {
      const t = (group.start + i) / 3;
      if (Number.isInteger(t) && t >= 0 && t < triangleCount) materialOfTriangle[t] = group.materialIndex;
    }
  }

  const droppedEditTopology = !!(definition.editMesh || definition.edges?.length || definition.hiddenEdges?.length);

  const out = [];
  for (let id = 0; id < count; id++) {
    // Keep this island's vertices in their ORIGINAL order, so anything that
    // reads the buffers positionally sees the same sequence it always did.
    const keep = [];
    const remap = new Int32Array(vertexCount).fill(-1);
    for (let v = 0; v < vertexCount; v++) if (islandOfVertex[v] === id) { remap[v] = keep.length; keep.push(v); }
    if (!keep.length) continue;

    const tris = [];
    for (let t = 0; t < triangleCount; t++) if (islandOfTriangle[t] === id) tris.push(t);
    const newIndices = new Uint32Array(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
      for (let j = 0; j < 3; j++) newIndices[i * 3 + j] = remap[corner(tris[i], j)];
    }

    // Groups, rebuilt as runs. Triangles keep their relative order inside an
    // island and the source groups are contiguous, so runs are all that is
    // needed — no sort, and a single-material mesh emits nothing.
    const groups = [];
    if (hasGroups) {
      let start = 0;
      for (let i = 1; i <= tris.length; i++) {
        if (i < tris.length && materialOfTriangle[tris[i]] === materialOfTriangle[tris[start]]) continue;
        groups.push({ start: start * 3, count: (i - start) * 3, materialIndex: materialOfTriangle[tris[start]] });
        start = i;
      }
    }

    const piece = {
      version: definition.version,
      morphTargetsRelative: !!definition.morphTargetsRelative,
      positions: gatherFlat(positions, keep, 3, Float32Array),
      indices: newIndices,
      groups,
    };
    const uvs = gatherFlat(definition.uvs, keep, 2, Float32Array);
    if (uvs) piece.uvs = uvs;
    const normals = gatherFlat(definition.normals, keep, 3, Float32Array);
    if (normals) piece.normals = normals;

    const attributes = {};
    for (const [name, attribute] of Object.entries(definition.attributes ?? {})) {
      const gathered = gatherAttribute(attribute, keep);
      if (gathered) attributes[name] = gathered;
    }
    if (Object.keys(attributes).length) piece.attributes = attributes;

    const morphAttributes = {};
    for (const [name, targets] of Object.entries(definition.morphAttributes ?? {})) {
      if (!Array.isArray(targets)) continue;
      const gathered = targets.map((target) => gatherAttribute(target, keep)).filter(Boolean);
      if (gathered.length === targets.length) morphAttributes[name] = gathered;
    }
    if (Object.keys(morphAttributes).length) piece.morphAttributes = morphAttributes;

    piece.islandIndex = id;
    piece.droppedEditTopology = droppedEditTopology;
    out.push(piece);
  }
  return out;
}
