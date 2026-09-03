// Pure CPU builder/refitter for the static-placement TLAS.
//
// This module deliberately owns no THREE/TSL objects and creates no GPU
// bindings. Its Uint32Array outputs are designed to be copied into reserved
// regions of occupancyField's existing `bits` storage buffer.

export const STATIC_TLAS_NODE_WORDS = 8;
export const STATIC_TLAS_PLACEMENT_WORDS = 24;
export const STATIC_TLAS_LEAF_BIT = 0x80000000;
export const STATIC_TLAS_PLACEMENT_ACTIVE = 1;
export const STATIC_TLAS_PLACEMENT_HAS_UV = 2;

// Node, 8 words:
//   +0..5  world AABB min.xyz/max.xyz (f32 bits)
//   +6     internal left node + 1, or LEAF_BIT | placement index
//   +7     internal right node + 1, or 0 for a leaf
// Placement, 24 words:
//   +0..15 worldToLocal matrix (column-major f32 bits)
//   +16    local BLAS node base
//   +17    local BLAS triangle base (`indexBase` is a legacy input alias)
//   +18    reserved (`positionBase` is preserved as a legacy input alias)
//   +19    local BLAS UV base (0 when absent)
//   +20    occupancy slot
//   +21    flags (ACTIVE/HAS_UV)
//   +22..23 reserved

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

function f32Bits(value) {
  F32[0] = Number(value);
  return U32[0] >>> 0;
}

function nextDownF32(value) {
  if (Number.isNaN(value) || value === -Infinity) return value;
  F32[0] = value;
  if (F32[0] === -Infinity) return -Infinity;
  if (F32[0] === 0) {
    U32[0] = 0x80000001;
    return F32[0];
  }
  U32[0] = F32[0] > 0 ? (U32[0] - 1) >>> 0 : (U32[0] + 1) >>> 0;
  return F32[0];
}

function nextUpF32(value) {
  if (Number.isNaN(value) || value === Infinity) return value;
  F32[0] = value;
  if (F32[0] === Infinity) return Infinity;
  if (F32[0] === 0) {
    U32[0] = 1;
    return F32[0];
  }
  U32[0] = F32[0] > 0 ? (U32[0] + 1) >>> 0 : (U32[0] - 1) >>> 0;
  return F32[0];
}

function vector3(value, label) {
  const v = value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
    ? [value.x, value.y, value.z]
    : Array.from(value ?? []);
  if (v.length < 3 || !v.slice(0, 3).every(Number.isFinite)) {
    throw new TypeError(`static TLAS ${label} must contain three finite numbers`);
  }
  return [Number(v[0]), Number(v[1]), Number(v[2])];
}

function matrixElements(value) {
  const src = value?.elements ?? value;
  const out = Array.from(src ?? [], Number);
  if (out.length !== 16 || !out.every(Number.isFinite)) {
    throw new TypeError("static TLAS placement matrix must contain 16 finite numbers");
  }
  return out;
}

function localBoundsOf(input) {
  const minValue = input.localMin ?? input.boundsMin ?? input.localBounds?.min;
  const maxValue = input.localMax ?? input.boundsMax ?? input.localBounds?.max;
  if (minValue != null && maxValue != null) {
    const min = vector3(minValue, "local min");
    const max = vector3(maxValue, "local max");
    if (min.some((v, i) => v > max[i])) throw new RangeError("static TLAS local bounds are inverted");
    return { min, max };
  }
  const positions = input.positions;
  if (!positions?.length || positions.length % 3 !== 0) {
    throw new TypeError("static TLAS placement needs local bounds or xyz positions");
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = Number(positions[i + axis]);
      if (!Number.isFinite(value)) throw new TypeError("static TLAS positions must be finite");
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

/** Column-major mat4 inverse. Returns null for a singular placement. */
function invertMat4(a) {
  const n11 = a[0], n21 = a[1], n31 = a[2], n41 = a[3];
  const n12 = a[4], n22 = a[5], n32 = a[6], n42 = a[7];
  const n13 = a[8], n23 = a[9], n33 = a[10], n43 = a[11];
  const n14 = a[12], n24 = a[13], n34 = a[14], n44 = a[15];

  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 -
    n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 +
    n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 -
    n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 +
    n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;
  const detInv = 1 / det;
  return [
    t11 * detInv,
    (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv,
    (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv,
    (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv,
    t12 * detInv,
    (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv,
    (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv,
    (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv,
    t13 * detInv,
    (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv,
    (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv,
    (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv,
    t14 * detInv,
    (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv,
    (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv,
    (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv,
  ];
}

function transformPoint(matrix, x, y, z) {
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const iw = w !== 0 ? 1 / w : 1;
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) * iw,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) * iw,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) * iw,
  ];
}

function transformDirection(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z,
    matrix[1] * x + matrix[5] * y + matrix[9] * z,
    matrix[2] * x + matrix[6] * y + matrix[10] * z,
  ];
}

function worldBounds(localMin, localMax, matrix) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p = transformPoint(
      matrix,
      corner & 1 ? localMax[0] : localMin[0],
      corner & 2 ? localMax[1] : localMin[1],
      corner & 4 ? localMax[2] : localMin[2],
    );
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], p[axis]);
      max[axis] = Math.max(max[axis], p[axis]);
    }
  }
  // GPU f32 storage must remain a conservative superset of the JS result.
  return {
    min: min.map(nextDownF32),
    max: max.map(nextUpF32),
  };
}

function writeBounds(words, nodeIndex, bounds) {
  const base = nodeIndex * STATIC_TLAS_NODE_WORDS;
  for (let axis = 0; axis < 3; axis++) {
    words[base + axis] = f32Bits(bounds.min[axis]);
    words[base + 3 + axis] = f32Bits(bounds.max[axis]);
  }
}

function readBounds(floatWords, nodeIndex) {
  const base = nodeIndex * STATIC_TLAS_NODE_WORDS;
  return {
    min: [floatWords[base], floatWords[base + 1], floatWords[base + 2]],
    max: [floatWords[base + 3], floatWords[base + 4], floatWords[base + 5]],
  };
}

function unionNodeBounds(floatWords, left, right) {
  const a = readBounds(floatWords, left);
  const b = readBounds(floatWords, right);
  return {
    min: a.min.map((v, axis) => Math.min(v, b.min[axis])),
    max: a.max.map((v, axis) => Math.max(v, b.max[axis])),
  };
}

function writePlacement(words, placementIndex, placement) {
  const base = placementIndex * STATIC_TLAS_PLACEMENT_WORDS;
  const inverse = placement.worldToLocal ?? new Array(16).fill(0);
  for (let i = 0; i < 16; i++) words[base + i] = f32Bits(inverse[i]);
  words[base + 16] = placement.blasNodeBase >>> 0;
  words[base + 17] = placement.blasTriBase >>> 0;
  words[base + 18] = placement.positionBase >>> 0;
  words[base + 19] = placement.blasUvBase >>> 0;
  words[base + 20] = placement.slot >>> 0;
  words[base + 21] = placement.flags >>> 0;
  words[base + 22] = 0;
  words[base + 23] = 0;
}

function normalizePlacement(input, index) {
  const slot = Number(input.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot > 0x7fffffff) {
    throw new RangeError("static TLAS placement slot must be a non-negative 31-bit integer");
  }
  const { min: localMin, max: localMax } = localBoundsOf(input);
  const matrix = matrixElements(input.matrix);
  const worldToLocal = invertMat4(matrix);
  const active = input.active !== false && worldToLocal !== null;
  const blasTriBase = Number(input.blasTriBase ?? input.triBase ?? input.indexBase ?? 0) >>> 0;
  const blasUvBase = Number(input.blasUvBase ?? input.uvBase ?? 0) >>> 0;
  let flags = Number(input.flags ?? 0) >>> 0;
  flags = active ? (flags | STATIC_TLAS_PLACEMENT_ACTIVE) : (flags & ~STATIC_TLAS_PLACEMENT_ACTIVE);
  flags = blasUvBase !== 0 ? (flags | STATIC_TLAS_PLACEMENT_HAS_UV) : (flags & ~STATIC_TLAS_PLACEMENT_HAS_UV);
  return {
    source: input,
    inputIndex: index,
    slot,
    localMin,
    localMax,
    matrix,
    worldToLocal,
    flags,
    blasNodeBase: Number(input.blasNodeBase ?? 0) >>> 0,
    blasTriBase,
    // Keep the old names available to callers of the standalone TLAS while
    // the new static-scene packer uses the exact node/triangle/UV vocabulary.
    indexBase: blasTriBase,
    positionBase: Number(input.positionBase ?? 0) >>> 0,
    blasUvBase,
    uvBase: blasUvBase,
    worldBounds: worldBounds(localMin, localMax, matrix),
  };
}

function coalesceNodeRanges(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const ranges = [];
  for (const index of sorted) {
    const wordOffset = index * STATIC_TLAS_NODE_WORDS;
    const previous = ranges[ranges.length - 1];
    if (previous && previous.wordOffset + previous.wordCount === wordOffset) {
      previous.wordCount += STATIC_TLAS_NODE_WORDS;
    } else {
      ranges.push({ wordOffset, wordCount: STATIC_TLAS_NODE_WORDS });
    }
  }
  return ranges;
}

/** Build a deterministic binary TLAS over placement world bounds. */
export function buildStaticPlacementTlas(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return null;
  // Keep authored input order. Occupancy slots are runtime registry handles;
  // sorting/tie-breaking by them made identical scene topology serialize
  // differently after a rebuild and prevented offline cache reuse.
  const placements = inputs.map(normalizePlacement);
  const slotToPlacement = new Map();
  for (let i = 0; i < placements.length; i++) {
    if (slotToPlacement.has(placements[i].slot)) throw new RangeError(`duplicate static TLAS slot ${placements[i].slot}`);
    slotToPlacement.set(placements[i].slot, i);
  }

  const nodes = [];
  const parentByNode = [];
  const leafByPlacement = new Int32Array(placements.length);
  const centroid = (placementIndex, axis) => {
    const b = placements[placementIndex].worldBounds;
    return (b.min[axis] + b.max[axis]) * 0.5;
  };
  const build = (ids, parent) => {
    const nodeIndex = nodes.length;
    nodes.push(null);
    parentByNode[nodeIndex] = parent;
    if (ids.length === 1) {
      const placementIndex = ids[0];
      nodes[nodeIndex] = { leaf: placementIndex, bounds: placements[placementIndex].worldBounds };
      leafByPlacement[placementIndex] = nodeIndex;
      return nodeIndex;
    }
    const cmin = [Infinity, Infinity, Infinity];
    const cmax = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) {
      for (let axis = 0; axis < 3; axis++) {
        const value = centroid(id, axis);
        cmin[axis] = Math.min(cmin[axis], value);
        cmax[axis] = Math.max(cmax[axis], value);
      }
    }
    let axis = 0;
    if (cmax[1] - cmin[1] > cmax[axis] - cmin[axis]) axis = 1;
    if (cmax[2] - cmin[2] > cmax[axis] - cmin[axis]) axis = 2;
    ids.sort((a, b) => centroid(a, axis) - centroid(b, axis) || placements[a].inputIndex - placements[b].inputIndex);
    const middle = ids.length >> 1;
    const left = build(ids.slice(0, middle), nodeIndex);
    const right = build(ids.slice(middle), nodeIndex);
    const a = nodes[left].bounds;
    const b = nodes[right].bounds;
    nodes[nodeIndex] = {
      left,
      right,
      bounds: {
        min: a.min.map((v, i) => Math.min(v, b.min[i])),
        max: a.max.map((v, i) => Math.max(v, b.max[i])),
      },
    };
    return nodeIndex;
  };
  build(placements.map((_, index) => index), -1);

  const nodeWordCount = nodes.length * STATIC_TLAS_NODE_WORDS;
  const placementWordOffset = nodeWordCount;
  const placementWordCount = placements.length * STATIC_TLAS_PLACEMENT_WORDS;
  const words = new Uint32Array(nodeWordCount + placementWordCount);
  const nodeWords = words.subarray(0, nodeWordCount);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    writeBounds(nodeWords, i, node.bounds);
    const base = i * STATIC_TLAS_NODE_WORDS;
    if (node.leaf != null) {
      nodeWords[base + 6] = (STATIC_TLAS_LEAF_BIT | node.leaf) >>> 0;
      nodeWords[base + 7] = 0;
    } else {
      nodeWords[base + 6] = node.left + 1;
      nodeWords[base + 7] = node.right + 1;
    }
  }
  const placementWords = words.subarray(placementWordOffset);
  placements.forEach((placement, index) => writePlacement(placementWords, index, placement));
  const parent = Int32Array.from(parentByNode);
  const leafBySlot = new Map();
  const parentChainBySlot = new Map();
  placements.forEach((placement, index) => {
    const leaf = leafByPlacement[index];
    leafBySlot.set(placement.slot, leaf);
    const chain = [];
    for (let node = leaf; node >= 0; node = parent[node]) chain.push(node);
    parentChainBySlot.set(placement.slot, Int32Array.from(chain));
  });
  return {
    words,
    nodeWords,
    placementWords,
    layout: {
      nodeWordOffset: 0,
      nodeWordCount,
      placementWordOffset,
      placementWordCount,
      totalWords: words.length,
    },
    placements,
    rootNode: 0,
    parentByNode: parent,
    leafByPlacement,
    slotToPlacement,
    leafBySlot,
    parentChainBySlot,
  };
}

/**
 * Refit one placement without changing topology. Returns upload-ready dirty
 * ranges relative to the node and placement regions.
 */
export function refitStaticPlacementTlas(tlas, slot, update) {
  if (!tlas) throw new TypeError("static TLAS is required");
  const placementIndex = tlas.slotToPlacement.get(slot);
  if (placementIndex == null) return null;
  const previous = tlas.placements[placementIndex];
  // Rehydrated disk placements point `source` at authored geometry, which
  // intentionally has no packed BLAS addresses. Carry those immutable record
  // fields forward explicitly so a transform refit cannot zero them.
  const packedFields = {
    blasNodeBase: previous.blasNodeBase,
    blasTriBase: previous.blasTriBase,
    positionBase: previous.positionBase,
    blasUvBase: previous.blasUvBase,
    flags: previous.flags,
  };
  const source = update?.matrix || Array.isArray(update) || ArrayBuffer.isView(update) || update?.elements
    ? { ...previous.source, ...packedFields, ...(update?.matrix ? update : { matrix: update }) }
    : { ...previous.source, ...packedFields, ...update };
  source.slot = previous.slot;
  const next = normalizePlacement(source, previous.inputIndex);
  tlas.placements[placementIndex] = next;
  writePlacement(tlas.placementWords, placementIndex, next);

  const chain = Array.from(tlas.parentChainBySlot.get(slot));
  const floats = new Float32Array(tlas.nodeWords.buffer, tlas.nodeWords.byteOffset, tlas.nodeWords.length);
  writeBounds(tlas.nodeWords, chain[0], next.worldBounds);
  for (let i = 1; i < chain.length; i++) {
    const node = chain[i];
    const base = node * STATIC_TLAS_NODE_WORDS;
    const left = tlas.nodeWords[base + 6] - 1;
    const right = tlas.nodeWords[base + 7] - 1;
    writeBounds(tlas.nodeWords, node, unionNodeBounds(floats, left, right));
  }
  const nodeRanges = coalesceNodeRanges(chain);
  return {
    slot,
    placementIndex,
    leafNode: chain[0],
    nodeIndices: Int32Array.from(chain),
    nodeRanges,
    placementRange: {
      wordOffset: placementIndex * STATIC_TLAS_PLACEMENT_WORDS,
      wordCount: STATIC_TLAS_PLACEMENT_WORDS,
    },
    packedRanges: [
      ...nodeRanges,
      {
        wordOffset: tlas.layout.placementWordOffset + placementIndex * STATIC_TLAS_PLACEMENT_WORDS,
        wordCount: STATIC_TLAS_PLACEMENT_WORDS,
      },
    ],
  };
}

function rayAabb(origin, direction, bounds, tMin, tMax) {
  let enter = tMin;
  let exit = tMax;
  for (let axis = 0; axis < 3; axis++) {
    const d = direction[axis];
    if (Math.abs(d) < 1e-20) {
      if (origin[axis] < bounds.min[axis] || origin[axis] > bounds.max[axis]) return null;
      continue;
    }
    let a = (bounds.min[axis] - origin[axis]) / d;
    let b = (bounds.max[axis] - origin[axis]) / d;
    if (a > b) [a, b] = [b, a];
    enter = Math.max(enter, a);
    exit = Math.min(exit, b);
    if (exit < enter) return null;
  }
  return { enter, exit };
}

function candidateResult(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? { t: value, value } : null;
  return Number.isFinite(value.t) ? { t: value.t, value } : null;
}

function testPlacement(tlas, placementIndex, origin, direction, tMin, bestT, intersectPlacement) {
  const placement = tlas.placements[placementIndex];
  const pbase = placementIndex * STATIC_TLAS_PLACEMENT_WORDS;
  const flags = tlas.placementWords[pbase + 21];
  if ((flags & STATIC_TLAS_PLACEMENT_ACTIVE) === 0) return null;
  const inverseF32 = new Float32Array(
    tlas.placementWords.buffer,
    tlas.placementWords.byteOffset + pbase * 4,
    16,
  );
  const originLocal = transformPoint(inverseF32, origin[0], origin[1], origin[2]);
  const directionLocal = transformDirection(inverseF32, direction[0], direction[1], direction[2]);
  return candidateResult(intersectPlacement({
    placement,
    placementIndex,
    slot: tlas.placementWords[pbase + 20],
    originLocal,
    directionLocal,
    tMin,
    tMax: bestT,
  }));
}

function placementActive(tlas, placementIndex) {
  return (tlas.placementWords[placementIndex * STATIC_TLAS_PLACEMENT_WORDS + 21] & STATIC_TLAS_PLACEMENT_ACTIVE) !== 0;
}

function candidateWins(candidate, slot, tMin, bestT, best) {
  return candidate && candidate.t >= tMin && (
    candidate.t < bestT ||
    (candidate.t === bestT && (best == null || slot < best.slot))
  );
}

/** CPU mirror of the future TLAS traversal. */
export function traceStaticPlacementTlas(tlas, originValue, directionValue, options = {}) {
  if (!tlas) return null;
  const origin = vector3(originValue, "ray origin");
  const direction = vector3(directionValue, "ray direction");
  const tMin = Number(options.tMin ?? 0);
  let bestT = Number(options.tMax ?? Infinity);
  const intersectPlacement = options.intersectPlacement;
  const floats = new Float32Array(tlas.nodeWords.buffer, tlas.nodeWords.byteOffset, tlas.nodeWords.length);
  const stack = [tlas.rootNode];
  let best = null;
  while (stack.length) {
    const node = stack.pop();
    const interval = rayAabb(origin, direction, readBounds(floats, node), tMin, bestT);
    if (!interval) continue;
    const base = node * STATIC_TLAS_NODE_WORDS;
    const leftRef = tlas.nodeWords[base + 6];
    const rightRef = tlas.nodeWords[base + 7];
    if ((leftRef & STATIC_TLAS_LEAF_BIT) !== 0 && rightRef === 0) {
      const placementIndex = leftRef & ~STATIC_TLAS_LEAF_BIT;
      const candidate = !placementActive(tlas, placementIndex)
        ? null
        : intersectPlacement
        ? testPlacement(tlas, placementIndex, origin, direction, tMin, bestT, intersectPlacement)
        : { t: interval.enter, value: interval.enter };
      const slot = tlas.placements[placementIndex].slot;
      if (candidateWins(candidate, slot, tMin, bestT, best)) {
        bestT = candidate.t;
        best = { t: candidate.t, placementIndex, slot, value: candidate.value };
      }
      continue;
    }
    const left = leftRef - 1;
    const right = rightRef - 1;
    const li = rayAabb(origin, direction, readBounds(floats, left), tMin, bestT);
    const ri = rayAabb(origin, direction, readBounds(floats, right), tMin, bestT);
    if (li && ri) {
      if (li.enter <= ri.enter) stack.push(right, left);
      else stack.push(left, right);
    } else if (li) stack.push(left);
    else if (ri) stack.push(right);
  }
  return best;
}

/** Brute-force placement reference using the same packed records/callback. */
export function traceStaticPlacementBruteForce(tlas, originValue, directionValue, options = {}) {
  if (!tlas) return null;
  const origin = vector3(originValue, "ray origin");
  const direction = vector3(directionValue, "ray direction");
  const tMin = Number(options.tMin ?? 0);
  let bestT = Number(options.tMax ?? Infinity);
  const intersectPlacement = options.intersectPlacement;
  const floats = new Float32Array(tlas.nodeWords.buffer, tlas.nodeWords.byteOffset, tlas.nodeWords.length);
  let best = null;
  for (let placementIndex = 0; placementIndex < tlas.placements.length; placementIndex++) {
    const leaf = tlas.leafByPlacement[placementIndex];
    const interval = rayAabb(origin, direction, readBounds(floats, leaf), tMin, bestT);
    if (!interval || !placementActive(tlas, placementIndex)) continue;
    const candidate = intersectPlacement
      ? testPlacement(tlas, placementIndex, origin, direction, tMin, bestT, intersectPlacement)
      : { t: interval.enter, value: interval.enter };
    const slot = tlas.placements[placementIndex].slot;
    if (candidateWins(candidate, slot, tMin, bestT, best)) {
      bestT = candidate.t;
      best = { t: candidate.t, placementIndex, slot, value: candidate.value };
    }
  }
  return best;
}
