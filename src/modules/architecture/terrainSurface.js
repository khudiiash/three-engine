import * as THREE from "three/webgpu";

/** A cheap snapshot of the live Terrain surface, including transformed parents.
 * The brush maintains a conservative sphere, so no full bounds scan is needed
 * for each dab. Upright heightfields sample their rendered grid triangles. */
export function captureTerrainSurface(terrain) {
  const mesh = terrain?.mesh;
  if (!mesh?.geometry || !terrain.heightsArray?.length || terrain.enabled === false || terrain.entity?.activeInHierarchy === false) return null;
  mesh.updateWorldMatrix(true, false);
  if (Math.abs(mesh.matrixWorld.determinant()) < 1e-12) return null;
  const half = (terrain.props.size ?? 50) / 2;
  const sphere = mesh.geometry.boundingSphere;
  const minY = sphere ? sphere.center.y - sphere.radius : -1e6, maxY = sphere ? sphere.center.y + sphere.radius : 1e6;
  const localBounds = new THREE.Box3(new THREE.Vector3(-half, minY, -half), new THREE.Vector3(half, maxY, half));
  const matrix = mesh.matrixWorld.clone(), e = matrix.elements;
  return { terrain, mesh, matrix, inverse: matrix.clone().invert(), localBounds, bounds: localBounds.clone().applyMatrix4(matrix),
    upright: Math.abs(e[1]) + Math.abs(e[9]) + Math.abs(e[4]) + Math.abs(e[6]) < 1e-8 && Math.abs(e[5]) > 1e-8,
    revision: terrain._surfaceRevision ?? 0 };
}

export function sampleTerrainSurface(surface, x, z, raycaster = new THREE.Raycaster()) {
  if (!surface || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const { terrain, mesh, matrix, inverse, bounds, localBounds } = surface;
  if (x < bounds.min.x - 1e-7 || x > bounds.max.x + 1e-7 || z < bounds.min.z - 1e-7 || z > bounds.max.z + 1e-7) return null;
  if (surface.upright) {
    const point = new THREE.Vector3(x, 0, z).applyMatrix4(inverse);
    if (point.x < localBounds.min.x - 1e-7 || point.x > localBounds.max.x + 1e-7 || point.z < localBounds.min.z - 1e-7 || point.z > localBounds.max.z + 1e-7) return null;
    const size = terrain.props.size ?? 50, resolution = terrain._gridResolution;
    const c = THREE.MathUtils.clamp((point.x / size + .5) * resolution, 0, resolution), r = THREE.MathUtils.clamp((point.z / size + .5) * resolution, 0, resolution);
    const c0 = Math.min(resolution - 1, Math.floor(c)), r0 = Math.min(resolution - 1, Math.floor(r)), u = c - c0, v = r - r0;
    const cols = resolution + 1, index = r0 * cols + c0, heights = terrain.heightsArray;
    const a = heights[index], b = heights[index + 1], d = heights[index + cols], e = heights[index + cols + 1];
    // PlaneGeometry uses the diagonal from top-right to bottom-left.
    point.y = u + v <= 1 ? a + (b - a) * u + (d - a) * v : e + (d - e) * (1 - u) + (b - e) * (1 - v);
    return point.applyMatrix4(matrix).y;
  }
  raycaster.layers.mask = mesh.layers.mask;
  raycaster.set(new THREE.Vector3(x, bounds.max.y + 1, z), new THREE.Vector3(0, -1, 0));
  raycaster.near = 0; raycaster.far = bounds.max.y - bounds.min.y + 2;
  return raycaster.intersectObject(mesh, false)[0]?.point.y ?? null;
}

/** Dirty grid rectangles become conservative world bounds. Full height extents
 * intentionally cover both the old and new footprints of a tilted terrain. */
export function terrainDirtyWorldBounds(surface, rect) {
  if (!rect) return surface.bounds.clone();
  const step = (surface.terrain.props.size ?? 50) / surface.terrain._gridResolution, half = (surface.terrain.props.size ?? 50) / 2;
  return new THREE.Box3(new THREE.Vector3(-half + Math.max(0, rect.cMin - 1) * step, surface.localBounds.min.y, -half + Math.max(0, rect.rMin - 1) * step),
    new THREE.Vector3(-half + Math.min(surface.terrain._gridResolution, rect.cMax + 1) * step, surface.localBounds.max.y, -half + Math.min(surface.terrain._gridResolution, rect.rMax + 1) * step)).applyMatrix4(surface.matrix);
}

function insidePolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i], dx = b[0] - a[0], dz = b[2] - a[2];
    const cross = (x - a[0]) * dz - (z - a[2]) * dx;
    if (Math.abs(cross) < 1e-7 && x >= Math.min(a[0], b[0]) - 1e-7 && x <= Math.max(a[0], b[0]) + 1e-7 && z >= Math.min(a[2], b[2]) - 1e-7 && z <= Math.max(a[2], b[2]) + 1e-7) return true;
    if ((a[2] > z) !== (b[2] > z) && x < (b[0] - a[0]) * (z - a[2]) / (b[2] - a[2]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Exact maximum of the rendered heightfield below the foundation polygons:
 * terrain vertices inside, polygon vertices, and boundary/triangle-edge
 * crossings. A small peak between coarse building samples cannot penetrate a
 * floor, and an uncovered courtyard cannot lift the surrounding building. */
export function highestTerrainUnderGroup(surface, group, raycaster) {
  let highest = null;
  const accept = value => { if (value !== null && Number.isFinite(value)) highest = Math.max(highest ?? -Infinity, value); };
  for (const point of group.samplesWorldXYZ) accept(sampleTerrainSurface(surface, point[0], point[2], raycaster));
  const { terrain, matrix, inverse } = surface, resolution = terrain._gridResolution, cols = resolution + 1, size = terrain.props.size ?? 50, step = size / resolution, half = size / 2;
  const vertex = (r, c) => new THREE.Vector3(-half + c * step, terrain.heightsArray[r * cols + c], -half + r * step).applyMatrix4(matrix);
  for (const polygon of group.foundationPolygonsWorldXYZ ?? []) {
    if (polygon.length < 3) continue;
    const localBounds = new THREE.Box3();
    for (const point of polygon) {
      if (surface.upright) localBounds.expandByPoint(new THREE.Vector3(...point).applyMatrix4(inverse));
      else for (const y of [surface.bounds.min.y, surface.bounds.max.y]) localBounds.expandByPoint(new THREE.Vector3(point[0], y, point[2]).applyMatrix4(inverse));
      accept(sampleTerrainSurface(surface, point[0], point[2], raycaster));
    }
    const c0 = Math.max(0, Math.floor((localBounds.min.x + half) / step)), c1 = Math.min(resolution, Math.ceil((localBounds.max.x + half) / step));
    const r0 = Math.max(0, Math.floor((localBounds.min.z + half) / step)), r1 = Math.min(resolution, Math.ceil((localBounds.max.z + half) / step));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const point = vertex(r, c);
      if (insidePolygon(point.x, point.z, polygon)) accept(point.y);
    }
    if (surface.upright) {
      // Every rendered grid edge lies on c=k, r=k, or c+r=k. Along a polygon
      // edge the piecewise-linear height can peak only at these intersections.
      for (let i = 0; i < polygon.length; i++) {
        const a = new THREE.Vector3(...polygon[i]).applyMatrix4(inverse), b = new THREE.Vector3(...polygon[(i + 1) % polygon.length]).applyMatrix4(inverse);
        const ac = (a.x + half) / step, ar = (a.z + half) / step, bc = (b.x + half) / step, br = (b.z + half) / step;
        for (const [start, end] of [[ac, bc], [ar, br], [ac + ar, bc + br]]) {
          if (Math.abs(end - start) < 1e-9) continue;
          for (let k = Math.ceil(Math.max(0, Math.min(start, end))); k <= Math.min(resolution * 2, Math.floor(Math.max(start, end))); k++) {
            const t = (k - start) / (end - start), point = a.clone().lerp(b, t).applyMatrix4(matrix);
            accept(sampleTerrainSurface(surface, point.x, point.z, raycaster));
          }
        }
      }
    } else {
      // Tilt changes the projected grid; intersect its real 3D edges with each
      // vertical foundation boundary, retaining the highest covered surface.
      const crossing = (a, b, p, q) => {
        const dx = b.x - a.x, dz = b.z - a.z, px = q[0] - p[0], pz = q[2] - p[2], denominator = dx * pz - dz * px;
        if (Math.abs(denominator) < 1e-10) return;
        const x = p[0] - a.x, z = p[2] - a.z, t = (x * pz - z * px) / denominator, u = (x * dz - z * dx) / denominator;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) accept(a.y + t * (b.y - a.y));
      };
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
        const a = vertex(r, c), b = vertex(r, c + 1), d = vertex(r + 1, c), e = vertex(r + 1, c + 1);
        for (const [start, end] of [[a, b], [a, d], [b, d], [b, e], [d, e]]) for (let i = 0; i < polygon.length; i++) crossing(start, end, polygon[i], polygon[(i + 1) % polygon.length]);
      }
    }
  }
  return highest;
}
