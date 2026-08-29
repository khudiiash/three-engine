// GI2 — THE TRIANGLE SOUP WORKER (plan §4.1, audits §K.3, Stage 2.2)
//
// One packed world-space triangle soup + a coarse uniform grid of triangle
// index ranges, built OFF THE MAIN THREAD from `serializeMeshForBake` output.
// This is what `binPairs` reads: a brick asks "which triangles are near me",
// gets a 4 m cell's range, AABB-rejects, and appends (brick, triangle) pairs.
//
// ══ WHY A WORKER AT ALL ══════════════════════════════════════════════════════
//
// The soup is ~36 B/tri and Bistro is 3 M triangles: 108 MB of fp32 that has to
// be produced by transforming 9 M vertices by their placement matrix, then
// counting-sorted into cells. On the main thread that is a ~1 s freeze at scene
// open — the exact stall §19 exists to delete. Nothing here touches three.js:
// the ONLY input is the plain `{positions, index}` records `serializeMeshForBake`
// already produces plus a `Float32Array(16)` per placement, which is precisely
// what makes the work movable.
//
// ══ THE CONTRACT (what `windowVoxelize.js` codes against) ════════════════════
//
//   soup = {
//     triCount: u32,
//     tris:    Float32Array(triCount * 9)     // world-space p0 p1 p2
//     triPal:  Uint32Array(ceil(triCount/4))  // 1 B palette index per tri,
//                                             // tri i -> word i>>2, byte i&3
//                                             // (little-endian), 255 = none
//     grid: { origin: [x,y,z], cell: 4.0, dim: [nx,ny,nz] }
//     cellRange: Uint32Array(nx*ny*nz * 2)    // (start, count) into cellTris
//     cellTris:  Uint32Array(sum of counts)   // triangle indices
//     bytes: total
//   }
//
// `origin` is the scene AABB min floored to a `cell` multiple; a triangle is
// listed in EVERY cell its AABB overlaps (conservative — the consumer does the
// exact test), so `sum(count) >= triCount`.
//
// ══ NODE-TESTABLE BY CONSTRUCTION ════════════════════════════════════════════
//
// `buildTriangleSoup` is a PURE function of plain arrays and is exported. The
// worker plumbing below only runs inside a real WorkerGlobalScope, so
// `scripts/run-gi2-soup-test.mjs` imports this file in node and tests the real
// build — not a re-implementation of it that can drift from the shipping one.

/** Default coarse-grid cell size in metres (audits §K.3). */
export const SOUP_CELL_SIZE = 4.0;
/** Palette index meaning "no material" (byte 0xFF in `triPal`). */
export const PAL_NONE = 255;

// A triangle is dropped when |(p1-p0) × (p2-p0)|² is at or below this, i.e.
// area ≤ 5e-10 m². Written as `!(lenSq > eps)` at the call site so NaN — a
// vertex that came in non-finite — falls into the same branch instead of
// silently poisoning the scene AABB and, through it, the whole grid.
const DEGENERATE_CROSS_SQ = 1e-18;

// Safety valve: a scene whose AABB is absurd (a stray vertex at 1e6 m) would
// ask for a cellRange of billions of cells. Doubling the cell size until the
// grid fits keeps the build finite; the real fix for such a scene is upstream,
// so the grown `cell` is reported in `grid.cell` and in `stats.cellGrowths`.
const MAX_CELLS = 1 << 22; // 4 M cells = 32 MB of cellRange

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Number(process.hrtime.bigint() / 1000n) / 1000);

/**
 * Accepts every shape a caller might plausibly hold geometries in: a Map, a
 * plain object, an array of `{key, positions, index}`, or an array of
 * `[key, value]` entries. Returns a Map.
 */
export function normalizeGeometries(geometries) {
  if (geometries instanceof Map) return geometries;
  const map = new Map();
  if (!geometries) return map;
  if (Array.isArray(geometries)) {
    for (const entry of geometries) {
      if (!entry) continue;
      if (Array.isArray(entry)) map.set(entry[0], entry[1]);
      else map.set(entry.key ?? entry.geometryKey, entry);
    }
    return map;
  }
  for (const key of Object.keys(geometries)) map.set(key, geometries[key]);
  return map;
}

const triCountOf = (geo) => {
  if (!geo?.positions) return 0;
  const n = geo.index ? geo.index.length : geo.positions.length / 3;
  return Math.max(0, Math.floor(n / 3));
};

/**
 * BufferGeometry groups use draw-element ranges. Convert them once to sorted
 * triangle ranges so the hot soup loop only advances a cursor. Gaps retain
 * material slot 0, which is both three.js's ordinary fallback and the legacy
 * one-palette-per-placement behaviour.
 */
const triangleGroupsOf = (geo, triCount) => (geo?.groups ?? [])
  .map((g) => {
    const start = Math.max(0, Math.floor(Number(g?.start) || 0));
    const count = Math.max(0, Math.floor(Number(g?.count) || 0));
    return {
      start: Math.min(triCount, Math.floor(start / 3)),
      end: Math.min(triCount, Math.ceil((start + count) / 3)),
      materialIndex: Math.max(0, Math.floor(Number(g?.materialIndex) || 0)),
    };
  })
  .filter((g) => g.end > g.start)
  .sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.materialIndex - b.materialIndex));

/**
 * Builds the packed soup + coarse grid. PURE: no DOM, no three.js, no worker
 * API — node calls this directly.
 *
 * @param {{
 *   geometries: Map<string, {positions: Float32Array, index: (Uint16Array|Uint32Array|null), groups?: Array}>|Array|Object,
 *   placements: Array<{geometryKey: string, matrix: ArrayLike<number>, pal?: number, pals?: ArrayLike<number>}>,
 *   cellSize?: number,
 *   triCap?: number,
 * }} input
 */
export function buildTriangleSoup(input) {
  const tStart = nowMs();
  const geometries = normalizeGeometries(input?.geometries);
  const placements = input?.placements ?? [];
  let cell = Number(input?.cellSize) > 0 ? Number(input.cellSize) : SOUP_CELL_SIZE;
  const triCap = input?.triCap == null || !Number.isFinite(input.triCap)
    ? Infinity
    : Math.max(0, Math.floor(input.triCap));

  // ── 1. WHAT FITS ───────────────────────────────────────────────────────────
  //
  // The cap is a TIER budget (phone 1 M tris, audits §K.3), and which triangles
  // it keeps is a quality decision, not an accident of scene order: sort
  // placements LARGEST FIRST and take a prefix, so what falls off the end is
  // the small props — the same shape as the BVH's 128-mesh rule. A single
  // placement bigger than the whole cap is the one exception: it is taken
  // partially rather than leaving the soup empty (a phone with one 2 M-triangle
  // terrain mesh must still get occupancy for the terrain).
  const entries = [];
  let missingGeometry = 0;
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const geo = geometries.get(p?.geometryKey);
    const sourceN = triCountOf(geo);
    if (!geo || sourceN < 1) { missingGeometry++; continue; }
    const groups = triangleGroupsOf(geo, sourceN);
    const active = p.active == null ? null : Array.from(p.active, Boolean);
    let n = sourceN;
    if (active) {
      n = 0;
      let groupAt = 0;
      for (let t = 0; t < sourceN; t++) {
        while (groupAt < groups.length && t >= groups[groupAt].end) groupAt++;
        const group = groupAt < groups.length && t >= groups[groupAt].start
          ? groups[groupAt]
          : null;
        const materialIndex = group?.materialIndex ?? 0;
        if (active[materialIndex] ?? active[0] ?? false) n++;
      }
      if (n < 1) continue;
    }
    entries.push({
      index: i,
      geo,
      n,
      sourceN,
      take: 0,
      matrix: p.matrix,
      pal: (p.pal ?? PAL_NONE) & 255,
      pals: p.pals == null ? null : Array.from(p.pals, (v) => (v == null ? null : v & 255)),
      active,
      groups,
      owner: (Number.isFinite(p.slot) ? p.slot : i) & 0xffff,
    });
  }
  const order = entries.slice().sort((a, b) => (b.n - a.n) || (a.index - b.index));
  let budget = triCap;
  let taken = 0;
  let stopped = false;
  const cut = [];
  for (const e of order) {
    if (stopped) { cut.push({ placement: e.index, tris: e.n }); continue; }
    if (e.n <= budget) { e.take = e.n; budget -= e.n; taken += e.n; continue; }
    if (taken === 0 && budget > 0) { e.take = budget; taken += budget; budget = 0; }
    if (e.take < e.n) cut.push({ placement: e.index, tris: e.n - e.take });
    stopped = true;
  }
  const truncated = cut.length > 0;
  const tPlan = nowMs();

  // ── 2. THE SOUP ────────────────────────────────────────────────────────────
  const tris = new Float32Array(taken * 9);
  const palWords = new Uint32Array((taken + 3) >> 2);
  // §19 6.21 — the triangle's OWNER (its placement slot), 2 × u16 per word, so
  // the shadow BVH can drop a placement's triangles the frame it becomes a mover.
  // Keep a one-word sentinel for an empty soup. The returned view below also
  // promises at least one word, and constructing that view over a zero-byte
  // allocation throws before a legal `triCap: 0` build can return.
  const ownerWords = new Uint32Array(Math.max(1, (taken + 1) >> 1));
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let w = 0; // write cursor, in TRIANGLES
  let dropped = 0;
  for (const e of entries) {
    if (e.take < 1) continue;
    const m = e.matrix;
    const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
    const m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
    const m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
    const m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];
    const pos = e.geo.positions;
    const idx = e.geo.index;
    const pals = e.pals;
    const groups = e.groups;
    const active = e.active;
    let groupAt = 0;
    let activeWritten = 0;
    const owner = e.owner;
    for (let t = 0; t < e.sourceN && activeWritten < e.take; t++) {
      while (groupAt < groups.length && t >= groups[groupAt].end) groupAt++;
      const group = groupAt < groups.length && t >= groups[groupAt].start
        ? groups[groupAt]
        : null;
      const materialIndex = group?.materialIndex ?? 0;
      if (active && !(active[materialIndex] ?? active[0] ?? false)) continue;
      // The cap has always counted source triangles before degenerate removal;
      // keep that contract while making the source prefix an ACTIVE prefix.
      activeWritten++;
      const pal = group && pals?.[group.materialIndex] != null
        ? pals[group.materialIndex]
        : e.pal;
      const base = t * 3;
      const i0 = (idx ? idx[base] : base) * 3;
      const i1 = (idx ? idx[base + 1] : base + 1) * 3;
      const i2 = (idx ? idx[base + 2] : base + 2) * 3;
      // Column-major (THREE.Matrix4.elements), with the perspective divide
      // three's own applyMatrix4 does — placement matrices are affine, so `w`
      // is 1 and the branch never costs anything, but a caller that hands in a
      // projection matrix gets the same answer as three rather than garbage.
      let x = pos[i0], y = pos[i0 + 1], z = pos[i0 + 2];
      let pw = m3 * x + m7 * y + m11 * z + m15;
      let iw = pw === 1 ? 1 : (pw !== 0 ? 1 / pw : 1);
      const x0 = (m0 * x + m4 * y + m8 * z + m12) * iw;
      const y0 = (m1 * x + m5 * y + m9 * z + m13) * iw;
      const z0 = (m2 * x + m6 * y + m10 * z + m14) * iw;
      x = pos[i1]; y = pos[i1 + 1]; z = pos[i1 + 2];
      pw = m3 * x + m7 * y + m11 * z + m15;
      iw = pw === 1 ? 1 : (pw !== 0 ? 1 / pw : 1);
      const x1 = (m0 * x + m4 * y + m8 * z + m12) * iw;
      const y1 = (m1 * x + m5 * y + m9 * z + m13) * iw;
      const z1 = (m2 * x + m6 * y + m10 * z + m14) * iw;
      x = pos[i2]; y = pos[i2 + 1]; z = pos[i2 + 2];
      pw = m3 * x + m7 * y + m11 * z + m15;
      iw = pw === 1 ? 1 : (pw !== 0 ? 1 / pw : 1);
      const x2 = (m0 * x + m4 * y + m8 * z + m12) * iw;
      const y2 = (m1 * x + m5 * y + m9 * z + m13) * iw;
      const z2 = (m2 * x + m6 * y + m10 * z + m14) * iw;

      // Non-finite first (one add chain), then zero area. Both land in the
      // same `dropped` bucket: neither can be voxelized and both would corrupt
      // the scene AABB every later cell index is derived from.
      if (!Number.isFinite(x0 + y0 + z0 + x1 + y1 + z1 + x2 + y2 + z2)) { dropped++; continue; }
      const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
      const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      if (!(cx * cx + cy * cy + cz * cz > DEGENERATE_CROSS_SQ)) { dropped++; continue; }

      const o = w * 9;
      tris[o] = x0; tris[o + 1] = y0; tris[o + 2] = z0;
      tris[o + 3] = x1; tris[o + 4] = y1; tris[o + 5] = z1;
      tris[o + 6] = x2; tris[o + 7] = y2; tris[o + 8] = z2;
      palWords[w >> 2] |= pal << ((w & 3) * 8);
      ownerWords[w >> 1] |= owner << ((w & 1) * 16);
      w++;

      if (x0 < minX) minX = x0; if (x0 > maxX) maxX = x0;
      if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
      if (x2 < minX) minX = x2; if (x2 > maxX) maxX = x2;
      if (y0 < minY) minY = y0; if (y0 > maxY) maxY = y0;
      if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
      if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2;
      if (z0 < minZ) minZ = z0; if (z0 > maxZ) maxZ = z0;
      if (z1 < minZ) minZ = z1; if (z1 > maxZ) maxZ = z1;
      if (z2 < minZ) minZ = z2; if (z2 > maxZ) maxZ = z2;
    }
  }
  const triCount = w;
  // Views of the exact length over the (possibly larger) allocation. The
  // allocation is only compacted when the drops were big enough to be worth a
  // 36 B/tri copy — transferring a 108 MB buffer with 1 % slack beats copying
  // 108 MB to reclaim 1 MB.
  let trisOut = triCount === taken ? tris : new Float32Array(tris.buffer, 0, triCount * 9);
  const palLen = (triCount + 3) >> 2;
  let palOut = palLen === palWords.length ? palWords : new Uint32Array(palWords.buffer, 0, palLen);
  const ownerLen = Math.max(1, (triCount + 1) >> 1);
  let ownerOut = ownerLen === ownerWords.length ? ownerWords : new Uint32Array(ownerWords.buffer, 0, ownerLen);
  if (taken - triCount > 65536) ownerOut = ownerOut.slice();
  if (taken - triCount > 65536) {
    trisOut = trisOut.slice();
    palOut = palOut.slice();
  }
  const tSoup = nowMs();

  // ── 3. THE COARSE GRID ─────────────────────────────────────────────────────
  let originX = 0, originY = 0, originZ = 0;
  let nx = 1, ny = 1, nz = 1;
  let cellGrowths = 0;
  if (triCount > 0) {
    for (;;) {
      originX = Math.floor(minX / cell) * cell;
      originY = Math.floor(minY / cell) * cell;
      originZ = Math.floor(minZ / cell) * cell;
      nx = Math.max(1, Math.floor((maxX - originX) / cell) + 1);
      ny = Math.max(1, Math.floor((maxY - originY) / cell) + 1);
      nz = Math.max(1, Math.floor((maxZ - originZ) / cell) + 1);
      if (nx * ny * nz <= MAX_CELLS) break;
      cell *= 2;
      cellGrowths++;
    }
  }
  const cellCount = nx * ny * nz;
  const cellRange = new Uint32Array(cellCount * 2);
  const counts = new Uint32Array(cellCount);

  // Counting sort, pass A: count. The per-triangle cell span is recomputed in
  // the scatter pass rather than stored — storing it would be 24 B/tri (72 MB
  // on Bistro) to save a sequential re-read of an array that is already hot.
  const inv = 1 / cell;
  let entryTotal = 0;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
    const cx2 = tris[o + 6], cy2 = tris[o + 7], cz2 = tris[o + 8];
    const x0 = clampi(Math.floor((Math.min(ax, bx, cx2) - originX) * inv), 0, nx - 1);
    const x1 = clampi(Math.floor((Math.max(ax, bx, cx2) - originX) * inv), 0, nx - 1);
    const y0 = clampi(Math.floor((Math.min(ay, by, cy2) - originY) * inv), 0, ny - 1);
    const y1 = clampi(Math.floor((Math.max(ay, by, cy2) - originY) * inv), 0, ny - 1);
    const z0 = clampi(Math.floor((Math.min(az, bz, cz2) - originZ) * inv), 0, nz - 1);
    const z1 = clampi(Math.floor((Math.max(az, bz, cz2) - originZ) * inv), 0, nz - 1);
    for (let z = z0; z <= z1; z++) {
      const zb = nx * ny * z;
      for (let y = y0; y <= y1; y++) {
        const yb = zb + nx * y;
        for (let x = x0; x <= x1; x++) counts[yb + x]++;
      }
    }
    entryTotal += (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
  }
  // Prefix sum into (start, count) pairs; `cursor` walks the starts as the
  // scatter fills them.
  const cursor = new Uint32Array(cellCount);
  let acc = 0;
  for (let c = 0; c < cellCount; c++) {
    cellRange[c * 2] = acc;
    cellRange[c * 2 + 1] = counts[c];
    cursor[c] = acc;
    acc += counts[c];
  }
  const cellTris = new Uint32Array(acc);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
    const cx2 = tris[o + 6], cy2 = tris[o + 7], cz2 = tris[o + 8];
    const x0 = clampi(Math.floor((Math.min(ax, bx, cx2) - originX) * inv), 0, nx - 1);
    const x1 = clampi(Math.floor((Math.max(ax, bx, cx2) - originX) * inv), 0, nx - 1);
    const y0 = clampi(Math.floor((Math.min(ay, by, cy2) - originY) * inv), 0, ny - 1);
    const y1 = clampi(Math.floor((Math.max(ay, by, cy2) - originY) * inv), 0, ny - 1);
    const z0 = clampi(Math.floor((Math.min(az, bz, cz2) - originZ) * inv), 0, nz - 1);
    const z1 = clampi(Math.floor((Math.max(az, bz, cz2) - originZ) * inv), 0, nz - 1);
    for (let z = z0; z <= z1; z++) {
      const zb = nx * ny * z;
      for (let y = y0; y <= y1; y++) {
        const yb = zb + nx * y;
        for (let x = x0; x <= x1; x++) cellTris[cursor[yb + x]++] = t;
      }
    }
  }
  const tGrid = nowMs();

  const bytes = trisOut.byteLength + palOut.byteLength + cellRange.byteLength + cellTris.byteLength;
  return {
    triCount,
    tris: trisOut,
    triPal: palOut,
    triOwner: ownerOut,
    grid: { origin: [originX, originY, originZ], cell, dim: [nx, ny, nz] },
    cellRange,
    cellTris,
    bytes,
    // ── receipts (audits §K.8) ───────────────────────────────────────────────
    dropped,
    truncated,
    cut,
    stats: {
      placements: placements.length,
      placementsBuilt: entries.reduce((n, e) => n + (e.take > 0 ? 1 : 0), 0),
      missingGeometry,
      trisRequested: entries.reduce((n, e) => n + e.n, 0),
      trisTaken: taken,
      cellCount,
      cellEntries: entryTotal,
      cellGrowths,
      aabb: triCount > 0 ? [minX, minY, minZ, maxX, maxY, maxZ] : null,
      planMs: tPlan - tStart,
      soupMs: tSoup - tPlan,
      gridMs: tGrid - tSoup,
      buildMs: tGrid - tStart,
    },
  };
}

const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Every distinct ArrayBuffer a built soup owns — the postMessage transfer list. */
export function soupTransferables(soup) {
  return [...new Set([soup.tris.buffer, soup.triPal.buffer, soup.triOwner?.buffer, soup.cellRange.buffer, soup.cellTris.buffer].filter(Boolean))];
}

// ── WORKER PLUMBING ──────────────────────────────────────────────────────────
//
// Guarded on a REAL WorkerGlobalScope so this module is a plain library in node
// (the gate test imports it) and in any main-thread bundle that happens to pull
// it in. `self` alone is not enough — some bundlers and test shims define it.
const isWorkerScope = typeof self !== "undefined"
  && typeof WorkerGlobalScope !== "undefined"
  && self instanceof WorkerGlobalScope;

if (isWorkerScope) {
  self.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== "build") return;
    try {
      const soup = buildTriangleSoup(msg.input);
      soup.gen = msg.gen;
      self.postMessage({ type: "done", gen: msg.gen, soup }, soupTransferables(soup));
    } catch (err) {
      self.postMessage({
        type: "error",
        gen: msg.gen,
        message: err?.message ?? String(err),
        stack: err?.stack ?? null,
      });
    }
  };
  // Lets the main thread time the SPAWN separately from the build: a cold
  // worker start is a real cost the first scene open pays and nothing else does.
  self.postMessage({ type: "ready" });
}
