// @ts-check
// ROOM DERIVATION FROM A BLOCKOUT (§15 U4b — auto per-room reflection probes).
//
// The level-design module has walls and storeys but no "room" object, and the
// live round that motivated this proved nobody will hand-author the missing
// structure: the user's first probe was one 30×10×30 box on the level root,
// lying on the floor, spanning three rooms — the exact cross-room box that
// paints phantom walls. So the rooms are DERIVED, here, where the knowledge
// of what a wall is lives; consumers (the GI system's auto probe placement)
// call `levelRooms(level)` through duck typing and never import this module's
// internals.
//
// The algorithm is a 2-D occupancy fill per storey:
//
//   1. rasterize every wall piece's footprint onto a coarse XZ grid —
//      IGNORING its door/window openings, because an opening connects two
//      rooms in 3-D space while the rooms remain two rooms (a flood fill that
//      respects doorways would derive one probe for the whole flat, which is
//      the cross-room failure again);
//   2. flood-fill from the grid border to find the EXTERIOR;
//   3. the remaining free cells, connected 4-ways, are the rooms.
//
// A room's box is its cells' bounding rect × the storey height — blockout
// rooms are overwhelmingly rectangular, and box-projected probes degrade
// gracefully on the L-shaped exceptions (the box feather already handles
// "box not exactly the room"). The capture point deliberately obeys the U4a
// placement receipt: it is the free CELL nearest the rect centre (never the
// centroid, which lands inside a wall on concave rooms) at eye height —
// capture-point clearance is a placement rule, not a nicety.
import * as THREE from "three";

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();

/**
 * Derive the rooms of a blockout level.
 *
 * @param {import("./LevelComponent.js").LevelComponent} level
 * @param {object} [opts]
 * @param {number} [opts.cell]     raster cell in metres
 * @param {number} [opts.minArea]  reject regions smaller than this (m²)
 * @param {number} [opts.maxRooms] biggest-first cap on the result
 * @returns {Array<{key: string, center: number[], size: number[], capture: number[], area: number}>}
 */
export function levelRooms(level, { cell = 0.25, minArea = 2, maxRooms = 16 } = {}) {
  const rooms = [];
  const storeys = [];
  const floors = level.floors?.() ?? [];
  if (floors.length) {
    for (const floorEntity of floors) {
      const comp = floorEntity.getComponent("levelfloor");
      storeys.push({
        elevation: floorEntity.object3D.getWorldPosition(_p).y,
        height: comp?.storeyHeight ?? level.props.storeyHeight ?? 3,
        pieces: comp?.pieces?.() ?? [],
      });
    }
  } else {
    // A floor-less level (pieces parented straight under it) is one storey.
    storeys.push({
      elevation: level.entity.object3D.getWorldPosition(_p).y,
      height: level.props.storeyHeight ?? 3,
      pieces: level.pieces?.() ?? [],
    });
  }

  storeys.forEach((storey, storeyIndex) => {
    const walls = storey.pieces.filter((piece) => piece?.props?.shape === "wall");
    if (walls.length < 3) return; // an open plan cannot enclose anything

    // World-space footprint bounds over every wall's local box corners.
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const wallData = [];
    for (const wall of walls) {
      const object = wall.entity?.object3D;
      if (!object) continue;
      object.updateWorldMatrix(true, false);
      const size = wall.props.size ?? [4, 3, 0.2];
      const hx = Math.max(0.01, size[0] / 2);
      const sy = Math.max(0.01, size[1]);
      const hz = Math.max(0.01, size[2] / 2);
      const inverse = _m.copy(object.matrixWorld).invert().clone();
      let wMinX = Infinity, wMinZ = Infinity, wMaxX = -Infinity, wMaxZ = -Infinity;
      for (const [cx, cz] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]]) {
        _p.set(cx, 0, cz).applyMatrix4(object.matrixWorld);
        wMinX = Math.min(wMinX, _p.x); wMaxX = Math.max(wMaxX, _p.x);
        wMinZ = Math.min(wMinZ, _p.z); wMaxZ = Math.max(wMaxZ, _p.z);
      }
      minX = Math.min(minX, wMinX); maxX = Math.max(maxX, wMaxX);
      minZ = Math.min(minZ, wMinZ); maxZ = Math.max(maxZ, wMaxZ);
      wallData.push({ inverse, hx, sy, hz, wMinX, wMaxX, wMinZ, wMaxZ });
    }
    if (!wallData.length || !isFinite(minX)) return;

    // Grid over the storey bounds, margin of two cells so the border is
    // provably exterior. The cap trades resolution for a bound on cost —
    // 512² cells at 0.25 m spans a 128 m level before coarsening.
    let c = cell;
    while ((maxX - minX) / c > 512 || (maxZ - minZ) / c > 512) c *= 2;
    const pad = c * 0.75;
    const ox = minX - 2 * c, oz = minZ - 2 * c;
    const nx = Math.ceil((maxX - minX) / c) + 4;
    const nz = Math.ceil((maxZ - minZ) / c) + 4;
    // 0 free, 1 wall, 2 exterior, ≥3 room id
    const grid = new Uint16Array(nx * nz);
    const midY = storey.elevation + storey.height / 2;

    for (const w of wallData) {
      const x0 = Math.max(0, Math.floor((w.wMinX - pad - ox) / c));
      const x1 = Math.min(nx - 1, Math.ceil((w.wMaxX + pad - ox) / c));
      const z0 = Math.max(0, Math.floor((w.wMinZ - pad - oz) / c));
      const z1 = Math.min(nz - 1, Math.ceil((w.wMaxZ + pad - oz) / c));
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          _p.set(ox + (gx + 0.5) * c, midY, oz + (gz + 0.5) * c).applyMatrix4(w.inverse);
          // The half-storey test tolerates parapets and half walls without
          // letting a floor-hugging kerb wall carve phantom rooms.
          if (Math.abs(_p.x) <= w.hx + pad && Math.abs(_p.z) <= w.hz + pad &&
              _p.y >= -0.5 && _p.y <= w.sy + 0.5) {
            grid[gz * nx + gx] = 1;
          }
        }
      }
    }

    // Exterior fill from the border (4-connected BFS over free cells).
    const queue = [];
    const push = (gx, gz, mark) => {
      const i = gz * nx + gx;
      if (grid[i] === 0) { grid[i] = mark; queue.push(gx, gz); }
    };
    for (let gx = 0; gx < nx; gx++) { push(gx, 0, 2); push(gx, nz - 1, 2); }
    for (let gz = 0; gz < nz; gz++) { push(0, gz, 2); push(nx - 1, gz, 2); }
    const flood = (mark) => {
      while (queue.length) {
        const gz = queue.pop(), gx = queue.pop();
        if (gx > 0) push(gx - 1, gz, mark);
        if (gx < nx - 1) push(gx + 1, gz, mark);
        if (gz > 0) push(gx, gz - 1, mark);
        if (gz < nz - 1) push(gx, gz + 1, mark);
      }
    };
    flood(2);

    // Remaining free cells → rooms.
    let nextRoom = 3;
    const regions = new Map(); // mark → {cells, minGx, maxGx, minGz, maxGz}
    for (let gz = 1; gz < nz - 1; gz++) {
      for (let gx = 1; gx < nx - 1; gx++) {
        if (grid[gz * nx + gx] !== 0) continue;
        const mark = nextRoom++;
        push(gx, gz, mark);
        flood(mark);
        regions.set(mark, { cells: 0, minGx: nx, maxGx: 0, minGz: nz, maxGz: 0 });
      }
    }
    for (let gz = 0; gz < nz; gz++) {
      for (let gx = 0; gx < nx; gx++) {
        const r = regions.get(grid[gz * nx + gx]);
        if (!r) continue;
        r.cells++;
        r.minGx = Math.min(r.minGx, gx); r.maxGx = Math.max(r.maxGx, gx);
        r.minGz = Math.min(r.minGz, gz); r.maxGz = Math.max(r.maxGz, gz);
      }
    }

    for (const [mark, r] of regions) {
      const area = r.cells * c * c;
      if (area < minArea) continue;
      // The inflation ate `pad` into the room from every wall face — hand it
      // back so the box reaches the walls' inner faces, which is what makes
      // box projection nearly exact on a rectangular room.
      const sizeX = (r.maxGx - r.minGx + 1) * c + 2 * pad;
      const sizeZ = (r.maxGz - r.minGz + 1) * c + 2 * pad;
      const cx = ox + ((r.minGx + r.maxGx + 1) / 2) * c;
      const cz = oz + ((r.minGz + r.maxGz + 1) / 2) * c;
      // Capture point: the room's free cell nearest the rect centre (the rect
      // centre itself sits inside a wall on L-shaped rooms), at eye height.
      let best = null, bestD = Infinity;
      for (let gz = r.minGz; gz <= r.maxGz; gz++) {
        for (let gx = r.minGx; gx <= r.maxGx; gx++) {
          if (grid[gz * nx + gx] !== mark) continue;
          const wx = ox + (gx + 0.5) * c, wz = oz + (gz + 0.5) * c;
          const d = (wx - cx) * (wx - cx) + (wz - cz) * (wz - cz);
          if (d < bestD) { bestD = d; best = [wx, wz]; }
        }
      }
      if (!best) continue;
      rooms.push({
        key: `${storeyIndex}:${r.minGx},${r.minGz},${r.maxGx},${r.maxGz}`,
        center: [cx, storey.elevation + storey.height / 2, cz],
        size: [sizeX, storey.height, sizeZ],
        capture: [best[0], storey.elevation + Math.min(1.7, storey.height * 0.55), best[1]],
        area,
      });
    }
  });

  rooms.sort((a, b) => b.area - a.area);
  return rooms.slice(0, maxRooms);
}
