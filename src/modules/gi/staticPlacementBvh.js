// Pure CPU packer for the instanced static-scene acceleration format.
//
// Unlike buildStaticSceneBvhWords (the shipped world-space triangle soup),
// this format emits one object-local BVH8 per geometryKey and a compact TLAS
// over placements. Every offset stored in a placement is relative to word 0
// of the returned Uint32Array, so the whole block can be copied into the
// occupancy `bits` tail without adding a storage binding.
//
// Packed header, 16 words:
//   +0 magic (`SBV2`)              +1 version
//   +2 flags                       +3 total word count
//   +4 TLAS node offset            +5 TLAS node words
//   +6 placement offset            +7 placement words
//   +8 BLAS node offset            +9 BLAS node words
//   +10 triangle offset            +11 triangle words
//   +12 UV offset (0 when absent)  +13 UV words
//   +14 unique BLAS count          +15 placement count
// Regions are kept separate so geometry data is one immutable suffix: a
// transform-only rebuild/refit touches TLAS nodes and placement records only.

import * as THREE from "three/webgpu";

import { buildBvhWords } from "./dynamicObjects.js";
import { STATIC_BVH_FORMAT_PLACEMENT, STATIC_BVH_PLACEMENT_BUILDER_ABI } from "./staticBvhFormats.js";
import {
  STATIC_TLAS_LEAF_BIT,
  STATIC_TLAS_NODE_WORDS,
  STATIC_TLAS_PLACEMENT_WORDS,
  buildStaticPlacementTlas,
  refitStaticPlacementTlas,
  traceStaticPlacementTlas,
} from "./staticPlacementTlas.js";

export const STATIC_PLACEMENT_BVH_MAGIC = 0x32564253; // "SBV2" in little endian
export const STATIC_PLACEMENT_BVH_VERSION = 1;
export const STATIC_PLACEMENT_BVH_HEADER_WORDS = 16;
export const STATIC_PLACEMENT_BVH_HAS_UV = 1;
export const STATIC_PLACEMENT_BVH_NODE_WORDS = 28;
export const STATIC_PLACEMENT_BVH_TRI_WORDS = 9;
export const STATIC_PLACEMENT_BVH_UV_WORDS = 3;

function geometryKeyOf(item, index) {
  const key = item?.geometryKey ?? item?.key;
  if (key == null || key === "") throw new TypeError(`static placement ${index} needs a geometryKey`);
  return key;
}

function matrixElements(matrix) {
  const values = matrix?.elements ?? matrix;
  if (!values || values.length !== 16) throw new TypeError("static placement matrix must contain 16 elements");
  return values;
}

function triangleCountOf(item) {
  const positions = item?.positions;
  if (!positions || positions.length < 9 || positions.length % 3 !== 0) return 0;
  const elementCount = item.index ? item.index.length : positions.length / 3;
  return Math.floor(elementCount / 3);
}

function makeLocalTriangleSoup(item, withUvs) {
  const positions = item.positions;
  const vertexCount = Math.floor(positions.length / 3);
  const triangleCount = triangleCountOf(item);
  const soup = new Float32Array(triangleCount * 9);
  const triangleUvs = withUvs ? new Float32Array(triangleCount * 6) : null;
  const localMin = [Infinity, Infinity, Infinity];
  const localMax = [-Infinity, -Infinity, -Infinity];
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    for (let corner = 0; corner < 3; corner++) {
      const element = triangle * 3 + corner;
      const vertex = Number(item.index ? item.index[element] : element);
      if (!Number.isInteger(vertex) || vertex < 0 || vertex >= vertexCount) {
        throw new RangeError(`static BLAS index ${vertex} is outside 0..${vertexCount - 1}`);
      }
      const source = vertex * 3;
      const target = triangle * 9 + corner * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = Number(positions[source + axis]);
        if (!Number.isFinite(value)) throw new TypeError("static BLAS positions must be finite");
        soup[target + axis] = value;
        // Bounds must enclose the actual f32 triangle words, not a potentially
        // narrower higher-precision source value.
        localMin[axis] = Math.min(localMin[axis], soup[target + axis]);
        localMax[axis] = Math.max(localMax[axis], soup[target + axis]);
      }
      if (triangleUvs) {
        const uvTarget = triangle * 6 + corner * 2;
        const uvSource = vertex * 2;
        const hasUv = item.uvs && uvSource + 1 < item.uvs.length;
        const u = hasUv ? Number(item.uvs[uvSource]) : 0.5;
        const v = hasUv ? Number(item.uvs[uvSource + 1]) : 0.5;
        triangleUvs[uvTarget] = Number.isFinite(u) ? u : 0.5;
        triangleUvs[uvTarget + 1] = Number.isFinite(v) ? v : 0.5;
      }
    }
  }
  return { soup, triangleUvs, triangleCount, localMin, localMax };
}

function localBoundsOf(item) {
  const positions = item.positions;
  const vertexCount = Math.floor((positions?.length ?? 0) / 3);
  const triangleCount = triangleCountOf(item);
  if (triangleCount < 1) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    for (let corner = 0; corner < 3; corner++) {
      const element = triangle * 3 + corner;
      const vertex = Number(item.index ? item.index[element] : element);
      if (!Number.isInteger(vertex) || vertex < 0 || vertex >= vertexCount) {
        throw new RangeError(`static BLAS index ${vertex} is outside 0..${vertexCount - 1}`);
      }
      for (let axis = 0; axis < 3; axis++) {
        const value = Math.fround(Number(positions[vertex * 3 + axis]));
        if (!Number.isFinite(value)) throw new TypeError("static BLAS positions must be finite");
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    }
  }
  return { min, max };
}

function buildLocalBlas(item, geometryKey, strategy, withUvs) {
  const local = makeLocalTriangleSoup(item, withUvs);
  if (local.triangleCount === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(local.soup, 3));
  const sequential = local.soup.length / 3 > 65535
    ? new Uint32Array(local.soup.length / 3)
    : new Uint16Array(local.soup.length / 3);
  for (let i = 0; i < sequential.length; i++) sequential[i] = i;
  geometry.setIndex(new THREE.BufferAttribute(sequential, 1));
  const uvScratch = withUvs ? new Float32Array(6) : null;
  const packed = buildBvhWords(
    geometry,
    8,
    null,
    strategy,
    withUvs
      ? (originalTriangle) => {
          uvScratch.set(local.triangleUvs.subarray(originalTriangle * 6, originalTriangle * 6 + 6));
          return uvScratch;
        }
      : null,
  );
  geometry.dispose();
  if (!packed) return null;
  return {
    geometryKey,
    source: item,
    localMin: local.localMin,
    localMax: local.localMax,
    packed,
    triangleCount: local.triangleCount,
  };
}

function addExact(a, b, label) {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value > 0xffffffff) {
    throw new RangeError(`static placement BVH ${label} exceeds the u32 word address space`);
  }
  return value;
}

/**
 * Builds the next static format beside the current monolithic packer.
 *
 * Input matches buildStaticSceneBvhWords, with one additional required field:
 * `geometryKey`. Repeated keys share a single object-local BLAS.
 */
export function buildStaticPlacementBvhWords(items, strategy = null, { uvs = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const unique = new Map();
  const itemKeys = new Array(items.length);
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const key = geometryKeyOf(item, index);
    itemKeys[index] = key;
    if (!unique.has(key)) unique.set(key, { item, firstIndex: index });
  }
  const orderedUnique = [...unique.entries()]
    .sort((a, b) => {
      const ak = `${typeof a[0]}:${String(a[0])}`;
      const bk = `${typeof b[0]}:${String(b[0])}`;
      return ak < bk ? -1 : ak > bk ? 1 : a[1].firstIndex - b[1].firstIndex;
    });
  const blases = [];
  const blasByKey = new Map();
  for (const [geometryKey, entry] of orderedUnique) {
    const blas = buildLocalBlas(entry.item, geometryKey, strategy, uvs === true);
    if (!blas) continue;
    blasByKey.set(geometryKey, blas);
    blases.push(blas);
  }

  const liveItems = items
    .map((item, index) => ({ item, geometryKey: itemKeys[index] }))
    .filter((entry) => blasByKey.has(entry.geometryKey));
  if (liveItems.length === 0) return null;
  const tlasNodeWordCount = (liveItems.length * 2 - 1) * STATIC_TLAS_NODE_WORDS;
  const placementWordCount = liveItems.length * STATIC_TLAS_PLACEMENT_WORDS;
  const blasNodeWordCount = blases.reduce((sum, blas) => addExact(sum, blas.packed.nodeWords, "node region"), 0);
  const triangleWordCount = blases.reduce((sum, blas) => addExact(sum, blas.packed.triWords, "triangle region"), 0);
  const uvWordCount = uvs === true
    ? blases.reduce((sum, blas) => addExact(sum, blas.packed.uvWordCount, "UV region"), 0)
    : 0;

  const tlasNodeWordOffset = STATIC_PLACEMENT_BVH_HEADER_WORDS;
  const placementWordOffset = addExact(tlasNodeWordOffset, tlasNodeWordCount, "placement offset");
  const blasNodeWordOffset = addExact(placementWordOffset, placementWordCount, "BLAS offset");
  const triangleWordOffset = addExact(blasNodeWordOffset, blasNodeWordCount, "triangle offset");
  const uvWordOffset = uvs === true ? addExact(triangleWordOffset, triangleWordCount, "UV offset") : 0;
  const totalWords = addExact(
    uvs === true ? uvWordOffset : triangleWordOffset,
    uvs === true ? uvWordCount : triangleWordCount,
    "total size",
  );

  let nodeCursor = blasNodeWordOffset;
  let triangleCursor = triangleWordOffset;
  let uvCursor = uvWordOffset;
  for (let index = 0; index < blases.length; index++) {
    const blas = blases[index];
    blas.index = index;
    blas.nodeWordOffset = nodeCursor;
    blas.nodeWordCount = blas.packed.nodeWords;
    blas.triangleWordOffset = triangleCursor;
    blas.triangleWordCount = blas.packed.triWords;
    blas.uvWordOffset = uvs === true ? uvCursor : 0;
    blas.uvWordCount = uvs === true ? blas.packed.uvWordCount : 0;
    nodeCursor += blas.nodeWordCount;
    triangleCursor += blas.triangleWordCount;
    uvCursor += blas.uvWordCount;
  }

  const placements = liveItems.map(({ item, geometryKey }, index) => {
    const blas = blasByKey.get(geometryKey);
    return {
      slot: item.slot,
      matrix: matrixElements(item.matrix),
      localMin: blas.localMin,
      localMax: blas.localMax,
      blasNodeBase: blas.nodeWordOffset,
      blasTriBase: blas.triangleWordOffset,
      blasUvBase: blas.uvWordOffset,
      geometryKey: blas.geometryKey,
      blasIndex: blas.index,
      sourceItem: item,
      inputIndex: index,
    };
  });
  const tlas = buildStaticPlacementTlas(placements);

  const words = new Uint32Array(totalWords);
  words[0] = STATIC_PLACEMENT_BVH_MAGIC;
  words[1] = STATIC_PLACEMENT_BVH_VERSION;
  words[2] = uvs === true ? STATIC_PLACEMENT_BVH_HAS_UV : 0;
  words[3] = totalWords;
  words[4] = tlasNodeWordOffset;
  words[5] = tlasNodeWordCount;
  words[6] = placementWordOffset;
  words[7] = placementWordCount;
  words[8] = blasNodeWordOffset;
  words[9] = blasNodeWordCount;
  words[10] = triangleWordOffset;
  words[11] = triangleWordCount;
  words[12] = uvWordOffset;
  words[13] = uvWordCount;
  words[14] = blases.length;
  words[15] = liveItems.length;

  words.set(tlas.nodeWords, tlasNodeWordOffset);
  words.set(tlas.placementWords, placementWordOffset);
  for (const blas of blases) {
    const packed = blas.packed;
    words.set(packed.words.subarray(0, packed.nodeWords), blas.nodeWordOffset);
    words.set(
      packed.words.subarray(packed.nodeWords, packed.nodeWords + packed.triWords),
      blas.triangleWordOffset,
    );
    if (uvs === true) {
      words.set(packed.words.subarray(packed.uvRel, packed.uvRel + packed.uvWordCount), blas.uvWordOffset);
    }
    delete blas.packed;
  }

  // Rebase the standalone TLAS views onto the production one-buffer result.
  // Its internal dirty ranges stay relative to `tlas.words`; callers add the
  // published TLAS offset when copying a refit into occupancy bits.
  tlas.words = words.subarray(tlasNodeWordOffset, placementWordOffset + placementWordCount);
  tlas.nodeWords = words.subarray(tlasNodeWordOffset, placementWordOffset);
  tlas.placementWords = words.subarray(placementWordOffset, blasNodeWordOffset);

  const layout = {
    headerWordOffset: 0,
    headerWordCount: STATIC_PLACEMENT_BVH_HEADER_WORDS,
    tlasNodeWordOffset,
    tlasNodeWordCount,
    placementWordOffset,
    placementWordCount,
    blasNodeWordOffset,
    blasNodeWordCount,
    triangleWordOffset,
    triangleWordCount,
    uvWordOffset,
    uvWordCount,
    totalWords,
  };
  const uniqueTriangleCount = blases.reduce((sum, blas) => sum + blas.triangleCount, 0);
  return {
    format: STATIC_BVH_FORMAT_PLACEMENT,
    builderAbi: STATIC_BVH_PLACEMENT_BUILDER_ABI,
    words,
    layout,
    tlas,
    blases,
    blasByKey: new Map(blases.map((blas) => [blas.geometryKey, blas])),
    placementCount: liveItems.length,
    blasCount: blases.length,
    triangleCount: uniqueTriangleCount,
    // Compatibility diagnostics used by the legacy integration shell. The
    // placement traversal reads the self-describing header, not these fields.
    triCount: uniqueTriangleCount,
    uvRel: uvWordOffset,
    uvWordCount,
    arity: 8,
    uvs: uvs === true,
  };
}

function layoutFromWords(words) {
  if (!(words instanceof Uint32Array) || words.length < STATIC_PLACEMENT_BVH_HEADER_WORDS) {
    throw new TypeError("static placement BVH payload is missing its header");
  }
  if (words[0] !== STATIC_PLACEMENT_BVH_MAGIC || words[1] !== STATIC_PLACEMENT_BVH_VERSION) {
    throw new Error("static placement BVH payload has an unsupported ABI");
  }
  const layout = {
    headerWordOffset: 0,
    headerWordCount: STATIC_PLACEMENT_BVH_HEADER_WORDS,
    tlasNodeWordOffset: words[4],
    tlasNodeWordCount: words[5],
    placementWordOffset: words[6],
    placementWordCount: words[7],
    blasNodeWordOffset: words[8],
    blasNodeWordCount: words[9],
    triangleWordOffset: words[10],
    triangleWordCount: words[11],
    uvWordOffset: words[12],
    uvWordCount: words[13],
    totalWords: words[3],
  };
  const hasUv = (words[2] & STATIC_PLACEMENT_BVH_HAS_UV) !== 0;
  const placementCount = words[15];
  const triangleCount = layout.triangleWordCount / STATIC_PLACEMENT_BVH_TRI_WORDS;
  const contiguous =
    layout.tlasNodeWordOffset === STATIC_PLACEMENT_BVH_HEADER_WORDS &&
    layout.placementWordOffset === layout.tlasNodeWordOffset + layout.tlasNodeWordCount &&
    layout.blasNodeWordOffset === layout.placementWordOffset + layout.placementWordCount &&
    layout.triangleWordOffset === layout.blasNodeWordOffset + layout.blasNodeWordCount &&
    (!hasUv
      ? layout.uvWordOffset === 0 && layout.uvWordCount === 0 &&
        layout.totalWords === layout.triangleWordOffset + layout.triangleWordCount
      : layout.uvWordOffset === layout.triangleWordOffset + layout.triangleWordCount &&
        layout.totalWords === layout.uvWordOffset + layout.uvWordCount);
  if (
    !contiguous || layout.totalWords !== words.length ||
    layout.tlasNodeWordCount !== (placementCount * 2 - 1) * STATIC_TLAS_NODE_WORDS ||
    layout.placementWordCount !== placementCount * STATIC_TLAS_PLACEMENT_WORDS ||
    layout.blasNodeWordCount % STATIC_PLACEMENT_BVH_NODE_WORDS !== 0 ||
    !Number.isInteger(triangleCount) ||
    (hasUv && layout.uvWordCount !== triangleCount * STATIC_PLACEMENT_BVH_UV_WORDS)
  ) {
    throw new Error("static placement BVH payload layout is inconsistent");
  }
  return {
    layout,
    hasUv,
    placementCount,
    blasCount: words[14],
    triangleCount,
  };
}

function localBoundsFromBlasRoot(words, nodeBase) {
  const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  const origin = [floats[nodeBase], floats[nodeBase + 1], floats[nodeBase + 2]];
  const exponent = words[nodeBase + 3] >>> 0;
  const step = [
    2 ** ((exponent & 0xff) - 128),
    2 ** (((exponent >>> 8) & 0xff) - 128),
    2 ** (((exponent >>> 16) & 0xff) - 128),
  ];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let child = 0; child < 8; child++) {
    if ((words[nodeBase + 4 + child] >>> 0) === 0) continue;
    const low = words[nodeBase + 12 + child * 2] >>> 0;
    const high = words[nodeBase + 13 + child * 2] >>> 0;
    const childMin = [
      origin[0] + (low & 0xff) * step[0],
      origin[1] + ((low >>> 8) & 0xff) * step[1],
      origin[2] + ((low >>> 16) & 0xff) * step[2],
    ];
    const childMax = [
      origin[0] + ((low >>> 24) & 0xff) * step[0],
      origin[1] + (high & 0xff) * step[1],
      origin[2] + ((high >>> 8) & 0xff) * step[2],
    ];
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], childMin[axis]);
      max[axis] = Math.max(max[axis], childMax[axis]);
    }
  }
  if (![...min, ...max].every(Number.isFinite)) {
    throw new Error("static placement BVH has an empty BLAS root");
  }
  return { min, max };
}

/** Validates the self-describing payload and returns its immutable layout. */
export function staticPlacementBvhLayout(words) {
  return layoutFromWords(words);
}

/**
 * Rehydrates the small refit metadata around a zero-copy disk payload. BLAS
 * construction is deliberately not repeated; only local bounds and the binary
 * TLAS parent/leaf maps are rebuilt from the signed source items.
 */
export function adoptStaticPlacementBvhWords(words, items) {
  if (!Array.isArray(items)) throw new TypeError("static placement BVH adoption needs source items");
  const decoded = layoutFromWords(words);
  if (items.length !== decoded.placementCount) {
    throw new Error("static placement BVH item count does not match the artifact");
  }
  const placementWords = words.subarray(
    decoded.layout.placementWordOffset,
    decoded.layout.placementWordOffset + decoded.layout.placementWordCount,
  );
  const liveSlots = new Set();
  for (let inputIndex = 0; inputIndex < items.length; inputIndex++) {
    const item = items[inputIndex];
    const slot = Number(item.slot);
    if (!Number.isInteger(slot) || liveSlots.has(slot)) throw new Error(`duplicate or invalid static placement slot ${slot}`);
    liveSlots.add(slot);
  }
  const floatWords = new Float32Array(words.buffer, words.byteOffset, words.length);
  const placements = new Array(decoded.placementCount);
  const slotToPlacement = new Map();
  for (let placementIndex = 0; placementIndex < decoded.placementCount; placementIndex++) {
    const base = placementIndex * STATIC_TLAS_PLACEMENT_WORDS;
    // ABI 3 preserves source order, so transient live slots can be patched
    // without using them to identify (and invalidate) the cached geometry.
    const source = { item: items[placementIndex], inputIndex: placementIndex };
    const slot = Number(source.item.slot) >>> 0;
    placementWords[base + 20] = slot;
    // Validate the live transform shape now, but deliberately do NOT walk the
    // geometry. Conservative local bounds are recovered from the packed BLAS
    // root below, which keeps warm adoption independent of triangle count.
    const matrix = matrixElements(source.item.matrix);
    const absolute = decoded.layout.placementWordOffset + base;
    const worldToLocal = Array.from(floatWords.subarray(absolute, absolute + 16));
    const flags = placementWords[base + 21] >>> 0;
    placements[placementIndex] = {
      source: source.item,
      sourceItem: source.item,
      inputIndex: source.inputIndex,
      slot,
      matrix,
      worldToLocal,
      flags,
      blasNodeBase: placementWords[base + 16],
      blasTriBase: placementWords[base + 17],
      indexBase: placementWords[base + 17],
      positionBase: placementWords[base + 18],
      blasUvBase: placementWords[base + 19],
      uvBase: placementWords[base + 19],
      geometryKey: source.item.geometryKey ?? source.item.key,
      localMin: null,
      localMax: null,
      worldBounds: null,
    };
    slotToPlacement.set(slot, placementIndex);
  }

  // Rehydrate the small parent/leaf maps directly from the artifact topology.
  // Re-running buildStaticPlacementTlas here used to require local bounds and
  // therefore defeated the disk cache by touching every source triangle.
  const nodeCount = decoded.layout.tlasNodeWordCount / STATIC_TLAS_NODE_WORDS;
  const parentByNode = new Int32Array(nodeCount);
  parentByNode.fill(-2);
  parentByNode[0] = -1;
  const leafByPlacement = new Int32Array(decoded.placementCount);
  leafByPlacement.fill(-1);
  const stack = [0];
  let visited = 0;
  while (stack.length) {
    const node = stack.pop();
    const base = decoded.layout.tlasNodeWordOffset + node * STATIC_TLAS_NODE_WORDS;
    const first = words[base + 6] >>> 0;
    const second = words[base + 7] >>> 0;
    const bounds = {
      min: [floatWords[base], floatWords[base + 1], floatWords[base + 2]],
      max: [floatWords[base + 3], floatWords[base + 4], floatWords[base + 5]],
    };
    if (![...bounds.min, ...bounds.max].every(Number.isFinite)) {
      throw new Error(`static placement BVH TLAS node ${node} has invalid bounds`);
    }
    visited++;
    if ((first & STATIC_TLAS_LEAF_BIT) !== 0) {
      const placementIndex = first & ~STATIC_TLAS_LEAF_BIT;
      if (second !== 0 || placementIndex >= placements.length || leafByPlacement[placementIndex] !== -1) {
        throw new Error(`static placement BVH TLAS leaf ${node} is invalid`);
      }
      leafByPlacement[placementIndex] = node;
      placements[placementIndex].worldBounds = bounds;
      continue;
    }
    if (first === 0 || second === 0 || (second & STATIC_TLAS_LEAF_BIT) !== 0) {
      throw new Error(`static placement BVH TLAS node ${node} has invalid children`);
    }
    const left = first - 1;
    const right = second - 1;
    if (
      left >= nodeCount || right >= nodeCount || left === right || left === node || right === node ||
      parentByNode[left] !== -2 || parentByNode[right] !== -2
    ) {
      throw new Error(`static placement BVH TLAS node ${node} has invalid topology`);
    }
    parentByNode[left] = node;
    parentByNode[right] = node;
    stack.push(right, left);
  }
  if (
    visited !== nodeCount || parentByNode.some((parent) => parent === -2) ||
    leafByPlacement.some((leaf) => leaf < 0)
  ) {
    throw new Error("static placement BVH TLAS topology is incomplete");
  }

  const leafBySlot = new Map();
  const parentChainBySlot = new Map();
  const localBoundsByNodeBase = new Map();
  for (let placementIndex = 0; placementIndex < placements.length; placementIndex++) {
    const placement = placements[placementIndex];
    const leaf = leafByPlacement[placementIndex];
    leafBySlot.set(placement.slot, leaf);
    const chain = [];
    for (let node = leaf; node >= 0; node = parentByNode[node]) chain.push(node);
    parentChainBySlot.set(placement.slot, Int32Array.from(chain));
    if (
      placement.blasNodeBase < decoded.layout.blasNodeWordOffset ||
      placement.blasNodeBase >= decoded.layout.triangleWordOffset ||
      (placement.blasNodeBase - decoded.layout.blasNodeWordOffset) % STATIC_PLACEMENT_BVH_NODE_WORDS !== 0 ||
      placement.blasTriBase < decoded.layout.triangleWordOffset ||
      placement.blasTriBase >= (decoded.layout.uvWordOffset || decoded.layout.totalWords) ||
      (placement.blasTriBase - decoded.layout.triangleWordOffset) % STATIC_PLACEMENT_BVH_TRI_WORDS !== 0 ||
      (placement.blasUvBase !== 0 && (
        !decoded.hasUv || placement.blasUvBase < decoded.layout.uvWordOffset ||
        placement.blasUvBase >= decoded.layout.totalWords ||
        (placement.blasUvBase - decoded.layout.uvWordOffset) % STATIC_PLACEMENT_BVH_UV_WORDS !== 0
      ))
    ) {
      throw new Error(`static placement BVH slot ${placement.slot} references an invalid BLAS range`);
    }
    let localBounds = localBoundsByNodeBase.get(placement.blasNodeBase);
    if (!localBounds) {
      localBounds = localBoundsFromBlasRoot(words, placement.blasNodeBase);
      localBoundsByNodeBase.set(placement.blasNodeBase, localBounds);
    }
    placement.localMin = localBounds.min;
    placement.localMax = localBounds.max;
  }
  const artifactTlasWords = words.subarray(decoded.layout.tlasNodeWordOffset, decoded.layout.blasNodeWordOffset);
  const tlas = {
    words: artifactTlasWords,
    nodeWords: words.subarray(decoded.layout.tlasNodeWordOffset, decoded.layout.placementWordOffset),
    placementWords,
    layout: {
      nodeWordOffset: 0,
      nodeWordCount: decoded.layout.tlasNodeWordCount,
      placementWordOffset: decoded.layout.tlasNodeWordCount,
      placementWordCount: decoded.layout.placementWordCount,
      totalWords: artifactTlasWords.length,
    },
    placements,
    rootNode: 0,
    parentByNode,
    leafByPlacement,
    slotToPlacement,
    leafBySlot,
    parentChainBySlot,
  };
  const adopted = {
    format: STATIC_BVH_FORMAT_PLACEMENT,
    builderAbi: STATIC_BVH_PLACEMENT_BUILDER_ABI,
    words,
    layout: decoded.layout,
    tlas,
    blases: [],
    blasByKey: new Map(),
    placementCount: decoded.placementCount,
    blasCount: decoded.blasCount,
    triangleCount: decoded.triangleCount,
    triCount: decoded.triangleCount,
    uvRel: decoded.layout.uvWordOffset,
    uvWordCount: decoded.layout.uvWordCount,
    arity: 8,
    uvs: decoded.hasUv,
    adopted: true,
    localBoundsByGeometryKey: new Map(
      placements.map((placement) => [
        placement.geometryKey,
        { min: placement.localMin, max: placement.localMax },
      ]),
    ),
  };
  // The disk payload's TLAS prefix is merely a seed. Refit it to authored
  // transforms every time; this is O(placements log placements), scans zero
  // triangles, and keeps the large BLAS/triangle/UV suffix byte-identical.
  for (const placement of placements) {
    refitStaticPlacementTlas(tlas, placement.slot, {
      matrix: placement.source.matrix,
      localMin: placement.localMin,
      localMax: placement.localMax,
    });
  }
  return adopted;
}

/**
 * Refits one placement in place and exposes upload views over only the dirty
 * TLAS/record words. Offsets are relative to the packed block's word 0.
 */
export function refitStaticPlacementBvh(packed, slot, update) {
  if (packed?.format !== STATIC_BVH_FORMAT_PLACEMENT || !packed.tlas) {
    throw new TypeError("a live static placement BVH is required");
  }
  const placementIndex = packed.tlas.slotToPlacement.get(slot);
  const previous = placementIndex == null ? null : packed.tlas.placements[placementIndex];
  let resolvedUpdate = update;
  if (previous && (!previous.localMin || !previous.localMax)) {
    const key = previous.geometryKey ?? geometryKeyOf(previous.source, previous.inputIndex);
    const memo = (packed.localBoundsByGeometryKey ??= new Map());
    let bounds = memo.get(key);
    if (!bounds) {
      bounds = localBoundsOf(previous.source);
      if (!bounds) throw new Error(`static placement BVH slot ${slot} has no triangles`);
      memo.set(key, bounds);
    }
    resolvedUpdate = update?.matrix
      ? { ...update, localMin: bounds.min, localMax: bounds.max }
      : Array.isArray(update) || ArrayBuffer.isView(update) || update?.elements
        ? { matrix: update, localMin: bounds.min, localMax: bounds.max }
        : { ...update, localMin: bounds.min, localMax: bounds.max };
  }
  const dirty = refitStaticPlacementTlas(packed.tlas, slot, resolvedUpdate);
  if (!dirty) return null;
  const uploads = dirty.packedRanges.map((range) => {
    const wordOffset = packed.layout.tlasNodeWordOffset + range.wordOffset;
    return {
      wordOffset,
      wordCount: range.wordCount,
      words: packed.words.subarray(wordOffset, wordOffset + range.wordCount),
    };
  });
  return { ...dirty, uploads };
}

function traceBvh8(words, nodeBase, triangleBase, origin, direction, tMin, tMax) {
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  const nonzero = (value) => Math.abs(value) < 1e-9 ? (value >= 0 ? 1e-9 : -1e-9) : value;
  const inverse = direction.map((value) => 1 / nonzero(value));
  const stack = [1];
  let bestT = tMax;
  let hit = false;
  let guard = 0;
  while (stack.length && guard++ < 768) {
    const reference = stack.pop();
    if (reference === 0) continue;
    if ((reference & 0x80000000) !== 0) {
      const start = reference & 0x00ffffff;
      const count = (reference >>> 24) & 0x7f;
      for (let triangle = 0; triangle < count; triangle++) {
        const base = triangleBase + (start + triangle) * STATIC_PLACEMENT_BVH_TRI_WORDS;
        const a = [f32[base], f32[base + 1], f32[base + 2]];
        const b = [f32[base + 3], f32[base + 4], f32[base + 5]];
        const c = [f32[base + 6], f32[base + 7], f32[base + 8]];
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const h = [
          direction[1] * e2[2] - direction[2] * e2[1],
          direction[2] * e2[0] - direction[0] * e2[2],
          direction[0] * e2[1] - direction[1] * e2[0],
        ];
        const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
        if (Math.abs(det) < 1e-10) continue;
        const invDet = 1 / det;
        const s = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
        const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) * invDet;
        const q = [
          s[1] * e1[2] - s[2] * e1[1],
          s[2] * e1[0] - s[0] * e1[2],
          s[0] * e1[1] - s[1] * e1[0],
        ];
        const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * invDet;
        const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * invDet;
        if (u >= -1e-4 && v >= -1e-4 && u + v <= 1.0001 && t > tMin && t < bestT) {
          bestT = t;
          hit = true;
        }
      }
      continue;
    }
    const base = nodeBase + (reference - 1) * STATIC_PLACEMENT_BVH_NODE_WORDS;
    const originNode = [f32[base], f32[base + 1], f32[base + 2]];
    const exponent = words[base + 3];
    const step = [
      2 ** ((exponent & 0xff) - 128),
      2 ** (((exponent >>> 8) & 0xff) - 128),
      2 ** (((exponent >>> 16) & 0xff) - 128),
    ];
    const children = [];
    for (let child = 0; child < 8; child++) {
      const childReference = words[base + 4 + child];
      if (childReference === 0) continue;
      const low = words[base + 12 + child * 2];
      const high = words[base + 13 + child * 2];
      const bmin = [
        originNode[0] + (low & 0xff) * step[0],
        originNode[1] + ((low >>> 8) & 0xff) * step[1],
        originNode[2] + ((low >>> 16) & 0xff) * step[2],
      ];
      const bmax = [
        originNode[0] + ((low >>> 24) & 0xff) * step[0],
        originNode[1] + (high & 0xff) * step[1],
        originNode[2] + ((high >>> 8) & 0xff) * step[2],
      ];
      let enter = tMin;
      let exit = bestT;
      for (let axis = 0; axis < 3; axis++) {
        const near = (bmin[axis] - origin[axis]) * inverse[axis];
        const far = (bmax[axis] - origin[axis]) * inverse[axis];
        enter = Math.max(enter, Math.min(near, far));
        exit = Math.min(exit, Math.max(near, far));
      }
      if (exit >= enter) children.push([enter, childReference]);
    }
    children.sort((a, b) => a[0] - b[0]);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i][1]);
  }
  return hit ? bestT : null;
}

/** CPU mirror of the packed TLAS + object-local BVH8 traversal. */
export function traceStaticPlacementBvh(packed, origin, direction, options = {}) {
  if (!packed) return null;
  return traceStaticPlacementTlas(packed.tlas, origin, direction, {
    tMin: Number(options.tMin ?? 0),
    tMax: Number(options.tMax ?? Infinity),
    intersectPlacement: ({ placement, originLocal, directionLocal, tMin, tMax }) => {
      const t = traceBvh8(
        packed.words,
        placement.blasNodeBase,
        placement.blasTriBase,
        originLocal,
        directionLocal,
        tMin,
        tMax,
      );
      return t == null ? null : { t };
    },
  });
}
