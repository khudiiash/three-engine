// GI2 — THE SHADOW BVH WORKER (rc5, one BVH2 over the window's triangle soup)
//
// A binned-SAH BVH2 built OFF THE MAIN THREAD over the world-space triangle soup
// `triangleSoup.worker.js` already produces. Nothing else: no three.js, no DOM,
// no material data. The soup hands over `Float32Array(triCount * 9)` of world
// p0 p1 p2 and this hands back a node array a WGSL any-hit kernel can walk with
// a fixed-size stack and nothing but two buffers bound.
//
// ══ WHY THE SOUP AND NOT THE SCENE GRAPH ═════════════════════════════════════
//
// Because the soup is ALREADY the flattened, placement-transformed, degenerate-
// culled, cap-obeying set of triangles the window cares about — and it is a pair
// of plain typed arrays, which is the only reason either of these builds can
// leave the main thread. Re-deriving triangles here would mean re-importing the
// serializer, the matrices, and every drop rule, and the two would drift.
//
// ══ THE NODE LAYOUT (LOAD-BEARING — the WGSL indexes these offsets) ══════════
//
//   nodes[i*8 + 0..2]  aabb min x,y,z
//   nodes[i*8 + 3]     INTERIOR: index of the RIGHT child.  LEAF: first triangle
//   nodes[i*8 + 4..6]  aabb max x,y,z
//   nodes[i*8 + 7]     INTERIOR: -1.0.  LEAF: triangle count, >= 1
//
// so the one test the GPU needs is `nodes[i*8+7] < 0.0` => interior. The LEFT
// child is always `i + 1`; only the right index has to be stored, which is what
// buys us 32 B/node — one cache line per two nodes — instead of 48.
//
// Indices are stored as float VALUES, not bit patterns: `f32(1234.0)`, read back
// with `u32(nodes[i*8+3])`. That is exact for every integer below 2^24
// (16,777,216) because f32 has a 24-bit significand, and it is a lie for every
// integer above it. Both counts are asserted against `F32_EXACT_MAX` below
// rather than left to produce a BVH that silently traverses the wrong subtree.
//
// There is NO separate triangle-index buffer. The builder permutes a Uint32
// index array while it splits and then materializes `tris` ONCE in leaf order,
// so a leaf is a contiguous run `[first, first+count)` of the output array and
// the GPU's inner loop is a straight sequential read. That costs one 36 B/tri
// copy at build time and saves an indirection on every single leaf triangle for
// the life of the BVH.
//
// ══ NODE-TESTABLE BY CONSTRUCTION ════════════════════════════════════════════
//
// `buildShadowBvh` is a PURE function of typed arrays and is exported. The worker
// plumbing at the bottom only runs inside a real WorkerGlobalScope, so a node
// script can import this file and test the SHIPPING builder — not a second
// implementation of it that is free to drift.

/** Bins per axis in the SAH sweep. 12 is the usual knee: 16 costs 33 % more
 *  binning work for a tree that measures within noise of it, 8 starts visibly
 *  quantizing splits on axis-aligned architecture. */
const BIN_COUNT = 12;

/** Traversal cost relative to one ray-triangle test, in SAH units. A node visit
 *  (one slab test + a stack push) is roughly as expensive as one Möller-Trumbore,
 *  so 1.0; this is what stops the sweep from splitting a clump of mutually
 *  overlapping triangles forever for no reduction in expected work. */
const TRAVERSAL_COST = 1.0;

/** Hard ceiling on a leaf, as a multiple of `maxLeafSize`. The SAH is allowed to
 *  decide "no split pays here" and stop, but a leaf is an UNBOUNDED serial loop
 *  in the shader — one 4000-triangle leaf is a frame spike no averaged tree
 *  quality number would ever show. Past this we force the median fallback and
 *  eat the slightly worse tree. */
const LEAF_CAP_FACTOR = 4;

/** f32 represents every integer exactly up to 2^24 and nothing above it. Every
 *  index this file writes into the node array is a float, so this is the real
 *  addressable limit of the format — not a tuning constant. */
const F32_EXACT_MAX = 16777216;

/** The build scratch is ONE interleaved record per triangle — box min, box max,
 *  centroid — not three parallel arrays. Every node visit reads all nine floats
 *  of a triangle it reaches through a scattered permutation index, so parallel
 *  arrays cost three cache misses where one record costs one. That is the whole
 *  reason this stride exists; the layout has no other meaning and never leaves
 *  the builder. */
const TB_STRIDE = 9;
const TB_MIN = 0;
const TB_MAX = 3;
const TB_CENT = 6;

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Number(process.hrtime.bigint() / 1000n) / 1000);

/** Half the surface area of an AABB. The SAH only ever compares areas to each
 *  other, so the factor of 2 is dropped; a degenerate (inverted) box scores 0. */
function halfArea(minX, minY, minZ, maxX, maxY, maxZ) {
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  if (!(dx > 0) && !(dy > 0) && !(dz > 0)) return 0;
  const ex = dx > 0 ? dx : 0, ey = dy > 0 ? dy : 0, ez = dz > 0 ? dz : 0;
  return ex * ey + ey * ez + ez * ex;
}

/**
 * Hoare quickselect over a slice of the permutation, ordering by one centroid
 * axis, so that position `k` holds the element it would hold if the slice were
 * sorted. Iterative for the same reason the build is: this runs on ranges of
 * millions and a recursive quickselect's worst case is a blown stack.
 *
 * Splitting at `k` after this gives EXACTLY `k - lo` triangles on the left no
 * matter how many centroids tie, which is what makes it a safe terminal fallback
 * — every other split rule here can degenerate, this one cannot.
 */
function selectNth(perm, lo, hi, k, tb, axis) {
  const off = TB_CENT + axis;
  let a = lo, b = hi; // inclusive
  while (a < b) {
    // Median-of-three pivot: cheap insurance against the sorted-input worst case,
    // and imported geometry arrives sorted along an axis more often than not.
    const mid = (a + b) >> 1;
    const va = tb[perm[a] * TB_STRIDE + off], vm = tb[perm[mid] * TB_STRIDE + off], vb = tb[perm[b] * TB_STRIDE + off];
    let pivot;
    if (va < vm) pivot = vm < vb ? vm : (va < vb ? vb : va);
    else pivot = va < vb ? va : (vm < vb ? vb : vm);
    let i = a, j = b;
    while (i <= j) {
      while (tb[perm[i] * TB_STRIDE + off] < pivot) i++;
      while (tb[perm[j] * TB_STRIDE + off] > pivot) j--;
      if (i <= j) {
        const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
        i++; j--;
      }
    }
    if (k <= j) b = j;
    else if (k >= i) a = i;
    else break; // k landed inside the equal-to-pivot gap; it is already in place
  }
}

/**
 * Builds a BVH2 over a world-space triangle soup. PURE: no DOM, no three.js, no
 * worker API — node calls this directly.
 *
 * @param {{
 *   tris: Float32Array,      // triCount * 9 floats, world p0 p1 p2
 *   triCount: number,
 *   maxLeafSize?: number,
 *   triCap?: number,
 * }} input
 */
export function buildShadowBvh({ tris, triCount, maxLeafSize = 8, triCap = Infinity }) {
  const tStart = nowMs();
  const leafSize = Math.max(1, Math.floor(maxLeafSize) || 1);
  const leafCap = leafSize * LEAF_CAP_FACTOR;

  // ── 0. WHAT WE ACTUALLY BUILD OVER ─────────────────────────────────────────
  //
  // The cap keeps a PREFIX and that is deliberate, not lazy: the soup builder
  // sorts placements largest-first before it writes, so triangle 0..N of the
  // soup is the big geometry — the walls, the floors, the terrain — and what a
  // prefix drops is the small props. Those are exactly the shadow casters whose
  // absence is least visible, so a truncated shadow BVH degrades by losing fine
  // contact detail rather than by losing a wall.
  const inCount = Math.max(0, Math.floor(triCount) || 0);
  const capReq = triCap == null || !Number.isFinite(triCap) ? Infinity : Math.max(0, Math.floor(triCap));
  // The format's own ceiling is folded into the cap rather than thrown on, so a
  // 20 M-triangle scene produces a working 16 M-triangle BVH instead of an error.
  const cap = Math.min(capReq, F32_EXACT_MAX - 1);
  const n = Math.min(inCount, cap);
  const truncated = n < inCount;

  if (n < 1) {
    // One node, and it is a leaf of zero triangles with an INVERTED box. The
    // shader needs no empty-BVH branch: the slab test on min > max can never
    // report a hit, and `nodes[7] = 0` runs an empty leaf loop.
    const nodes = new Float32Array(8);
    nodes[0] = 1e30; nodes[1] = 1e30; nodes[2] = 1e30;
    nodes[4] = -1e30; nodes[5] = -1e30; nodes[6] = -1e30;
    nodes[3] = 0; nodes[7] = 0;
    const emptyTris = new Float32Array(0);
    return {
      nodeCount: 1,
      triCount: 0,
      nodes,
      tris: emptyTris,
      bytes: nodes.byteLength,
      stats: {
        buildMs: nowMs() - tStart, maxDepth: 0, leafCount: 1, meanLeafTris: 0,
        triCap: capReq, truncated, trisIn: inCount,
        nodeGrowths: 0, sahSplits: 0, medianSplits: 0, sahLeafStops: 0, leafCapForced: 0,
        aabb: null,
      },
    };
  }

  // ── 1. THE SCRATCH ─────────────────────────────────────────────────────────
  //
  // 36 B/tri of scratch (box min, box max, centroid — one record, see TB_STRIDE)
  // on top of the soup's own 36 B/tri. That is the trade the whole builder is:
  // every node visit reads one precomputed record instead of 36 B of vertices
  // plus nine comparisons, and a BVH is ~20 visits deep per triangle, so the
  // one-time write pays for itself an order of magnitude over. It is all
  // released when the worker's message returns; only `nodes` and the reordered
  // `tris` are transferred.
  const tb = new Float32Array(n * TB_STRIDE);
  const perm = new Uint32Array(n);
  let rootMinX = Infinity, rootMinY = Infinity, rootMinZ = Infinity;
  let rootMaxX = -Infinity, rootMaxY = -Infinity, rootMaxZ = -Infinity;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
    const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
    const nx = Math.min(ax, bx, cx), ny = Math.min(ay, by, cy), nz = Math.min(az, bz, cz);
    const xx = Math.max(ax, bx, cx), xy = Math.max(ay, by, cy), xz = Math.max(az, bz, cz);
    // These mins/maxes are exact: they are chosen FROM f32 values, so storing
    // them back into a Float32Array rounds nothing and the node boxes stay
    // conservative. (Had they been computed — a midpoint, an average — they
    // would need rounding outward here or the box could exclude its own
    // triangle and the traversal would miss hits the brute force finds.)
    const b6 = t * 6;
    box[b6] = nx; box[b6 + 1] = ny; box[b6 + 2] = nz;
    box[b6 + 3] = xx; box[b6 + 4] = xy; box[b6 + 5] = xz;
    const c3 = t * 3;
    cent[c3] = (ax + bx + cx) / 3;
    cent[c3 + 1] = (ay + by + cy) / 3;
    cent[c3 + 2] = (az + bz + cz) / 3;
    perm[t] = t;
    if (nx < rootMinX) rootMinX = nx; if (xx > rootMaxX) rootMaxX = xx;
    if (ny < rootMinY) rootMinY = ny; if (xy > rootMaxY) rootMaxY = xy;
    if (nz < rootMinZ) rootMinZ = nz; if (xz > rootMaxZ) rootMaxZ = xz;
  }

  // ── 2. THE NODE POOL ───────────────────────────────────────────────────────
  //
  // 2*ceil(n/leafSize) is the exact node count of a tree whose every leaf is
  // full; real leaves underfill, so this is a good guess and not a bound. A
  // growth is therefore a normal event to be COUNTED, not an error to be thrown
  // — the alternative (a bound that always holds: 2n-1 nodes) would allocate 8x
  // the memory to avoid a doubling that costs one memcpy.
  let nodeCap = 2 * Math.ceil(n / leafSize) + 64;
  let nodes = new Float32Array(nodeCap * 8);
  let nodeCount = 0;
  let nodeGrowths = 0;
  const ensureNodes = (need) => {
    if (need <= nodeCap) return;
    while (nodeCap < need) nodeCap *= 2;
    if (nodeCap * 8 > F32_EXACT_MAX * 8) throw new Error(`[shadowBvh] node count ${nodeCap} exceeds the f32 exact-integer range`);
    const grown = new Float32Array(nodeCap * 8);
    grown.set(nodes.subarray(0, nodeCount * 8));
    nodes = grown;
    nodeGrowths++;
  };

  // ── 3. THE WORK STACK ──────────────────────────────────────────────────────
  //
  // Iterative because 3 M triangles is 20+ levels of a tree whose SAH splits can
  // be arbitrarily unbalanced — a recursive builder's depth is bounded by the
  // DATA, and JS gives you ~10 k frames before it takes the tab with it.
  //
  // The entry is 4 ints: (start, count, patchParent, depth). `patchParent` is the
  // thing that makes `left == i + 1` work. A node cannot know its right child's
  // index when it splits, because the whole left subtree gets allocated in
  // between; so a node is assigned its index when it is POPPED, and the right
  // child carries the index of the parent slot it must write itself into. Push
  // right then left, and LIFO order guarantees the left child is the very next
  // pop after its parent — i.e. exactly `parent + 1`.
  let stackCap = 256;
  let stack = new Int32Array(stackCap * 4);
  let sp = 0;
  const push = (start, count, patch, depth) => {
    if (sp >= stackCap) {
      stackCap *= 2;
      const grown = new Int32Array(stackCap * 4);
      grown.set(stack);
      stack = grown;
    }
    const s = sp * 4;
    stack[s] = start; stack[s + 1] = count; stack[s + 2] = patch; stack[s + 3] = depth;
    sp++;
  };
  push(0, n, -1, 0);

  // Bin scratch, allocated once for the whole build: all three axes are binned in
  // ONE pass over the range, because the read of the triangle box — not the
  // arithmetic — is what the sweep costs.
  const binCount = new Int32Array(3 * BIN_COUNT);
  const binMin = new Float64Array(3 * BIN_COUNT * 3);
  const binMax = new Float64Array(3 * BIN_COUNT * 3);
  const rightArea = new Float64Array(BIN_COUNT);
  const rightCount = new Int32Array(BIN_COUNT);
  // Per-node axis scratch, hoisted OUT of the loop. These were `[x, y, z]`
  // literals inside it, which is a million short-lived arrays on a real scene —
  // measurably more time in GC than in the sweep they served.
  const ext = new Float64Array(3);
  const cLo = new Float64Array(3);
  const scale = new Float64Array(3);

  let maxDepth = 0;
  let leafCount = 0;
  let leafTris = 0;
  let sahSplits = 0;
  let medianSplits = 0;
  let sahLeafStops = 0;
  let leafCapForced = 0;

  while (sp > 0) {
    sp--;
    const s = sp * 4;
    const start = stack[s], count = stack[s + 1], patch = stack[s + 2], depth = stack[s + 3];

    ensureNodes(nodeCount + 1);
    const self = nodeCount++;
    if (patch >= 0) nodes[patch * 8 + 3] = self; // I am somebody's right child
    if (depth > maxDepth) maxDepth = depth;

    // Node bounds and centroid bounds in the same pass — the centroid bounds are
    // what the bins are laid over, and using them instead of the node bounds is
    // the difference between a sweep that resolves the split and one that spends
    // half its bins on empty space beside a flat wall.
    let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
    let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let i = start; i < start + count; i++) {
      const t = perm[i], b6 = t * 6, c3 = t * 3;
      const x0 = box[b6], y0 = box[b6 + 1], z0 = box[b6 + 2];
      const x1 = box[b6 + 3], y1 = box[b6 + 4], z1 = box[b6 + 5];
      if (x0 < bMinX) bMinX = x0; if (x1 > bMaxX) bMaxX = x1;
      if (y0 < bMinY) bMinY = y0; if (y1 > bMaxY) bMaxY = y1;
      if (z0 < bMinZ) bMinZ = z0; if (z1 > bMaxZ) bMaxZ = z1;
      const cx = cent[c3], cy = cent[c3 + 1], cz = cent[c3 + 2];
      if (cx < cMinX) cMinX = cx; if (cx > cMaxX) cMaxX = cx;
      if (cy < cMinY) cMinY = cy; if (cy > cMaxY) cMaxY = cy;
      if (cz < cMinZ) cMinZ = cz; if (cz > cMaxZ) cMaxZ = cz;
    }
    const no = self * 8;
    nodes[no] = bMinX; nodes[no + 1] = bMinY; nodes[no + 2] = bMinZ;
    nodes[no + 4] = bMaxX; nodes[no + 5] = bMaxY; nodes[no + 6] = bMaxZ;

    if (count <= leafSize) {
      nodes[no + 3] = start; nodes[no + 7] = count;
      leafCount++; leafTris += count;
      continue;
    }

    // ── 3a. THE SAH SWEEP ────────────────────────────────────────────────────
    const parentArea = halfArea(bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ);
    ext[0] = cMaxX - cMinX; ext[1] = cMaxY - cMinY; ext[2] = cMaxZ - cMinZ;
    cLo[0] = cMinX; cLo[1] = cMinY; cLo[2] = cMinZ;
    // `BIN_COUNT * (1 - eps) / extent` keeps the bin index of the maximum
    // centroid at BIN_COUNT-1 without a clamp in the inner loop; the clamp is
    // still there for the NaN and denormal-extent cases the eps cannot fix.
    let anyAxis = false;
    for (let a = 0; a < 3; a++) {
      scale[a] = 0;
      if (ext[a] > 0) { scale[a] = (BIN_COUNT * (1 - 1e-6)) / ext[a]; anyAxis = true; }
    }

    let bestAxis = -1, bestSplit = -1, bestCost = Infinity;
    if (anyAxis) {
      binCount.fill(0);
      binMin.fill(Infinity);
      binMax.fill(-Infinity);
      // Unrolled over the three axes with the scale/origin in registers. The
      // rolled version re-read `scale[a]`/`cLo[a]` and re-branched 3n times for
      // values that are constant across the whole node; on 500 k triangles that
      // alone was a fifth of the build.
      const sx = scale[0], sy = scale[1], sz = scale[2];
      const lx = cLo[0], ly = cLo[1], lz = cLo[2];
      for (let i = start; i < start + count; i++) {
        const t = perm[i], b6 = t * 6, c3 = t * 3;
        const x0 = box[b6], y0 = box[b6 + 1], z0 = box[b6 + 2];
        const x1 = box[b6 + 3], y1 = box[b6 + 4], z1 = box[b6 + 5];
        if (sx !== 0) {
          let k = ((cent[c3] - lx) * sx) | 0;
          if (k < 0) k = 0; else if (k >= BIN_COUNT) k = BIN_COUNT - 1;
          binCount[k]++;
          const m = k * 3;
          if (x0 < binMin[m]) binMin[m] = x0; if (x1 > binMax[m]) binMax[m] = x1;
          if (y0 < binMin[m + 1]) binMin[m + 1] = y0; if (y1 > binMax[m + 1]) binMax[m + 1] = y1;
          if (z0 < binMin[m + 2]) binMin[m + 2] = z0; if (z1 > binMax[m + 2]) binMax[m + 2] = z1;
        }
        if (sy !== 0) {
          let k = ((cent[c3 + 1] - ly) * sy) | 0;
          if (k < 0) k = 0; else if (k >= BIN_COUNT) k = BIN_COUNT - 1;
          const bi = BIN_COUNT + k;
          binCount[bi]++;
          const m = bi * 3;
          if (x0 < binMin[m]) binMin[m] = x0; if (x1 > binMax[m]) binMax[m] = x1;
          if (y0 < binMin[m + 1]) binMin[m + 1] = y0; if (y1 > binMax[m + 1]) binMax[m + 1] = y1;
          if (z0 < binMin[m + 2]) binMin[m + 2] = z0; if (z1 > binMax[m + 2]) binMax[m + 2] = z1;
        }
        if (sz !== 0) {
          let k = ((cent[c3 + 2] - lz) * sz) | 0;
          if (k < 0) k = 0; else if (k >= BIN_COUNT) k = BIN_COUNT - 1;
          const bi = 2 * BIN_COUNT + k;
          binCount[bi]++;
          const m = bi * 3;
          if (x0 < binMin[m]) binMin[m] = x0; if (x1 > binMax[m]) binMax[m] = x1;
          if (y0 < binMin[m + 1]) binMin[m + 1] = y0; if (y1 > binMax[m + 1]) binMax[m + 1] = y1;
          if (z0 < binMin[m + 2]) binMin[m + 2] = z0; if (z1 > binMax[m + 2]) binMax[m + 2] = z1;
        }
      }
      for (let a = 0; a < 3; a++) {
        if (scale[a] === 0) continue;
        // Suffix pass: everything from bin b to the end, so the forward pass can
        // score a split in O(1) per candidate instead of O(BIN_COUNT).
        let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity;
        let rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity;
        let rn = 0;
        for (let b = BIN_COUNT - 1; b >= 1; b--) {
          const bi = a * BIN_COUNT + b, m = bi * 3;
          if (binCount[bi] > 0) {
            if (binMin[m] < rx0) rx0 = binMin[m]; if (binMax[m] > rx1) rx1 = binMax[m];
            if (binMin[m + 1] < ry0) ry0 = binMin[m + 1]; if (binMax[m + 1] > ry1) ry1 = binMax[m + 1];
            if (binMin[m + 2] < rz0) rz0 = binMin[m + 2]; if (binMax[m + 2] > rz1) rz1 = binMax[m + 2];
            rn += binCount[bi];
          }
          rightArea[b] = rn > 0 ? halfArea(rx0, ry0, rz0, rx1, ry1, rz1) : 0;
          rightCount[b] = rn;
        }
        let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity;
        let lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity;
        let ln = 0;
        for (let b = 0; b < BIN_COUNT - 1; b++) {
          const bi = a * BIN_COUNT + b, m = bi * 3;
          if (binCount[bi] > 0) {
            if (binMin[m] < lx0) lx0 = binMin[m]; if (binMax[m] > lx1) lx1 = binMax[m];
            if (binMin[m + 1] < ly0) ly0 = binMin[m + 1]; if (binMax[m + 1] > ly1) ly1 = binMax[m + 1];
            if (binMin[m + 2] < lz0) lz0 = binMin[m + 2]; if (binMax[m + 2] > lz1) lz1 = binMax[m + 2];
            ln += binCount[bi];
          }
          const rnb = rightCount[b + 1];
          if (ln === 0 || rnb === 0) continue; // a split that keeps every triangle on one side is not a split
          const cost = halfArea(lx0, ly0, lz0, lx1, ly1, lz1) * ln + rightArea[b + 1] * rnb;
          if (cost < bestCost) { bestCost = cost; bestAxis = a; bestSplit = b + 1; }
        }
      }
    }

    // ── 3b. SPLIT OR STOP ────────────────────────────────────────────────────
    //
    // The comparison is in SAH units of "expected ray-triangle tests": a leaf
    // costs `area * count`, a split costs `area * TRAVERSAL_COST` for the visit
    // plus the two children's expected work. When the split does not win, the
    // triangles overlap each other so thoroughly that no plane separates them,
    // and subdividing would only add node visits to the same triangle list.
    if (bestAxis >= 0 && bestCost + TRAVERSAL_COST * parentArea >= parentArea * count && count <= leafCap) {
      sahLeafStops++;
      nodes[no + 3] = start; nodes[no + 7] = count;
      leafCount++; leafTris += count;
      continue;
    }

    let mid = -1;
    if (bestAxis >= 0) {
      // Partition in place with the SAME bin formula the sweep scored, so the
      // realized child counts are exactly the ones the cost was computed from.
      // Anything else (a plane position, a recomputed midpoint) reintroduces
      // rounding disagreements that show up as one-sided splits.
      const a = bestAxis, sc = scale[a], lo = cLo[a];
      let i = start, j = start + count - 1;
      while (i <= j) {
        const t = perm[i];
        let k = ((cent[t * 3 + a] - lo) * sc) | 0;
        if (k < 0) k = 0; else if (k >= BIN_COUNT) k = BIN_COUNT - 1;
        if (k < bestSplit) { i++; }
        else { perm[i] = perm[j]; perm[j] = t; j--; }
      }
      mid = i;
      if (mid <= start || mid >= start + count) mid = -1; // degenerate after all
      else sahSplits++;
    }
    if (mid < 0) {
      // Median fallback on the widest CENTROID axis (widest node axis would pick
      // the axis a single long triangle stretches, not the one the population is
      // spread along). Exactly half the triangles go each way regardless of ties,
      // so this branch can never fail to make progress — which is why the depth
      // of this tree is bounded and the stack above is safe.
      let a = 0;
      if (ext[1] > ext[a]) a = 1;
      if (ext[2] > ext[a]) a = 2;
      mid = start + (count >> 1);
      selectNth(perm, start, start + count - 1, mid, cent, a);
      medianSplits++;
      if (count > leafCap) leafCapForced++;
    }

    nodes[no + 7] = -1;
    // Right first, left second: the pop order is then (self, left, ... , right),
    // which is what makes the left child land at `self + 1`. The right child is
    // the one that patches slot 3 of this node when it finally comes up.
    push(mid, start + count - mid, self, depth + 1);
    push(start, mid - start, -1, depth + 1);
  }

  if (nodeCount > F32_EXACT_MAX) throw new Error(`[shadowBvh] node count ${nodeCount} exceeds the f32 exact-integer range`);
  const tBuild = nowMs();

  // ── 4. MATERIALIZE ─────────────────────────────────────────────────────────
  //
  // One pass, gathering by the permutation. After this a leaf is a contiguous
  // run and the index array is dead — it never reaches the GPU.
  const outTris = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const src = perm[i] * 9, dst = i * 9;
    outTris[dst] = tris[src]; outTris[dst + 1] = tris[src + 1]; outTris[dst + 2] = tris[src + 2];
    outTris[dst + 3] = tris[src + 3]; outTris[dst + 4] = tris[src + 4]; outTris[dst + 5] = tris[src + 5];
    outTris[dst + 6] = tris[src + 6]; outTris[dst + 7] = tris[src + 7]; outTris[dst + 8] = tris[src + 8];
  }

  // A view of the exact length over the (over-)allocated pool, copied down only
  // when the slack is worth a copy — same rule as the soup: transferring 1 MB of
  // unused tail beats memcpying 24 MB to reclaim it.
  let nodesOut = nodeCount * 8 === nodes.length ? nodes : new Float32Array(nodes.buffer, 0, nodeCount * 8);
  if (nodes.length - nodeCount * 8 > 65536) nodesOut = nodesOut.slice();
  const tEnd = nowMs();

  return {
    nodeCount,
    triCount: n,
    nodes: nodesOut,
    tris: outTris,
    bytes: nodesOut.byteLength + outTris.byteLength,
    // ── receipts ─────────────────────────────────────────────────────────────
    stats: {
      buildMs: tEnd - tStart,
      maxDepth,
      leafCount,
      meanLeafTris: leafCount > 0 ? leafTris / leafCount : 0,
      triCap: capReq,
      truncated,
      trisIn: inCount,
      maxLeafSize: leafSize,
      nodeGrowths,
      sahSplits,
      medianSplits,
      sahLeafStops,
      leafCapForced,
      treeMs: tBuild - tStart,
      reorderMs: tEnd - tBuild,
      aabb: [rootMinX, rootMinY, rootMinZ, rootMaxX, rootMaxY, rootMaxZ],
    },
  };
}

/** Every distinct ArrayBuffer a built BVH owns — the postMessage transfer list. */
export function shadowBvhTransferables(bvh) {
  return [...new Set([bvh.nodes.buffer, bvh.tris.buffer])];
}

// ── WORKER PLUMBING ──────────────────────────────────────────────────────────
//
// Guarded on a REAL WorkerGlobalScope so this module is a plain library in node
// (the correctness gate imports it) and in any main-thread bundle that happens to
// pull it in. `self` alone is not enough — some bundlers and test shims define it.
const isWorkerScope = typeof self !== "undefined"
  && typeof WorkerGlobalScope !== "undefined"
  && self instanceof WorkerGlobalScope;

if (isWorkerScope) {
  self.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== "build") return;
    try {
      const bvh = buildShadowBvh(msg.input);
      bvh.gen = msg.gen;
      self.postMessage({ type: "done", gen: msg.gen, bvh }, shadowBvhTransferables(bvh));
    } catch (err) {
      self.postMessage({
        type: "error",
        gen: msg.gen,
        message: err?.message ?? String(err),
        stack: err?.stack ?? null,
      });
    }
  };
  // Lets the main thread time the SPAWN separately from the build: a cold worker
  // start is a real cost the first scene open pays and nothing else does.
  self.postMessage({ type: "ready" });
}
