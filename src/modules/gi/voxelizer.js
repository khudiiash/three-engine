import * as THREE from "three/webgpu";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";

/**
 * CPU scene voxelizer for the GI module. Produces the static world
 * representation the GPU probe tracer marches through: a cubic-voxel grid
 * of packed albedo (u32: R|G<<8|B<<16|occupied<<24) and packed normals
 * (u32, xyz mapped to 0..255). CPU on purpose — the grid only rebuilds when
 * the scene changes (not per frame), coarse LODs keep triangle counts small,
 * and it sidesteps the whole storage-buffer-scatter/atomics dance a GPU
 * voxelizer needs. Lighting is injected on the GPU every frame, so voxel
 * data stays static under moving suns.
 */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e01 = new THREE.Vector3();
const _e02 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _color = new THREE.Color();
const _emissive = new THREE.Color();

/**
 * Reads a CPU-constant TSL expression without compiling a shader. Material
 * graphs wrap even their editable constants in VarNode/OperatorNode chains
 * (for example emissive is `uniform(color) * uniform(strength)`), so checking
 * only `node.value` misses the normal graph-authored case.
 *
 * This intentionally handles only constant inputs and basic arithmetic. A
 * texture, time, position, or other varying node returns null; sampling those
 * belongs in a UV-aware voxelizer rather than pretending they are uniform.
 */
function readConstantNode(node, seen = new Set(), depth = 0) {
  if (!node?.isNode || depth > 16 || seen.has(node)) return null;
  seen.add(node);

  if (node.isVarNode && node.node) return readConstantNode(node.node, new Set(seen), depth + 1);

  if (node.isInputNode) {
    const value = node.value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value?.isColor) return [value.r, value.g, value.b];
    if (value?.isVector2) return [value.x, value.y];
    if (value?.isVector3) return [value.x, value.y, value.z];
    if (value?.isVector4) return [value.x, value.y, value.z, value.w];
    return null;
  }

  if (node.isOperatorNode) {
    // Copy the recursion stack per branch: TSL graphs are DAGs and may reuse
    // the same constant on both sides of an operator without forming a cycle.
    const a = readConstantNode(node.aNode, new Set(seen), depth + 1);
    const b = readConstantNode(node.bNode, new Set(seen), depth + 1);
    if (a == null || b == null) return null;
    const aa = Array.isArray(a) ? a : [a];
    const bb = Array.isArray(b) ? b : [b];
    const length = Math.max(aa.length, bb.length);
    if (aa.length !== 1 && aa.length !== length) return null;
    if (bb.length !== 1 && bb.length !== length) return null;
    const result = new Array(length);
    for (let i = 0; i < length; i++) {
      const av = aa[aa.length === 1 ? 0 : i];
      const bv = bb[bb.length === 1 ? 0 : i];
      if (node.op === "+") result[i] = av + bv;
      else if (node.op === "-") result[i] = av - bv;
      else if (node.op === "*") result[i] = av * bv;
      else if (node.op === "/") result[i] = bv !== 0 ? av / bv : 0;
      else return null;
    }
    return length === 1 ? result[0] : result;
  }

  return null;
}

function readConstantNodeColor(node, out) {
  const value = readConstantNode(node);
  if (!Array.isArray(value) || value.length < 3 || !value.slice(0, 3).every(Number.isFinite)) return false;
  out.setRGB(value[0], value[1], value[2]);
  return true;
}

// three stores layer masks unsigned; `1 << 31` in JS is negative, so the
// comparison must normalize both sides or layer-31 objects never match.
const EDITOR_ONLY_MASK = (1 << EDITOR_LAYER) >>> 0;

/** True when a mesh should contribute to the GI voxel grid. */
export function isVoxelizableMesh(obj) {
  if (!obj.isMesh || obj.isSkinnedMesh) return false;
  if (!obj.geometry?.getAttribute?.("position")) return false;
  if (obj.userData.engineOwned || obj.userData.vgeoDebug || obj.userData.giDebug) return false;
  // Editor-only helpers (gizmos, grid, camera models) live on layer 31.
  if ((obj.layers.mask >>> 0) === EDITOR_ONLY_MASK) return false;
  return obj.visible;
}

/**
 * Visits every voxelizable mesh under `root`, pruning invisible subtrees.
 * scene.traverse would descend into hidden parents — and the engine hides
 * disabled entities by clearing the ROOT object's `visible`, so a plain
 * traverse voxelizes geometry that doesn't render (phantom voxels).
 */
export function forEachVoxelizableMesh(root, fn) {
  if (root.visible === false) return;
  // Skip skeletons and everything rigged to them: an animated character is a
  // moving object, not static world geometry. Voxelizing its body/wings/armor
  // bakes an occluder into the grid that then lags behind as it moves — the
  // "wing-shaped ghost" left on the ground. Pruning the SkinnedMesh and Bone
  // subtrees keeps character rigs out of the GI grid entirely.
  if (root.isBone || root.isSkinnedMesh) return;
  if (isVoxelizableMesh(root)) fn(root);
  for (const child of root.children) forEachVoxelizableMesh(child, fn);
}

/** Linear voxel index for integer coords inside a (dims.x, dims.y, dims.z) grid. */
export function voxelIndex(x, y, z, dims) {
  return x + y * dims.x + z * dims.x * dims.y;
}

/**
 * Grid geometry derived from a world-space box: cubic voxels sized so the
 * largest axis fits `res` voxels; the other axes get proportionally fewer.
 * Returns { min: Vector3, voxelSize, dims: {x,y,z}, count }.
 */
export function computeGrid(center, size, res) {
  const maxAxis = Math.max(size.x, size.y, size.z, 1e-3);
  const voxelSize = maxAxis / res;
  const dims = {
    x: Math.max(1, Math.min(res, Math.ceil(size.x / voxelSize))),
    y: Math.max(1, Math.min(res, Math.ceil(size.y / voxelSize))),
    z: Math.max(1, Math.min(res, Math.ceil(size.z / voxelSize))),
  };
  const min = new THREE.Vector3(
    center.x - (dims.x * voxelSize) / 2,
    center.y - (dims.y * voxelSize) / 2,
    center.z - (dims.z * voxelSize) / 2,
  );
  return { min, voxelSize, dims, count: dims.x * dims.y * dims.z };
}

/**
 * Voxelizes every eligible mesh in `scene` into the given grid.
 * Returns { albedo: Uint32Array, normal: Uint32Array, occupied, meshes, tris }.
 *
 * Triangles are point-sampled on a barycentric lattice at half-voxel spacing
 * — not exact conservative rasterization, but watertight enough for GI (a
 * missed sliver voxel just means slightly less occlusion). Albedo comes from
 * the material's base color (textures are ignored — GI wants the low
 * frequency response anyway); normals accumulate per voxel and normalize at
 * the end so shared corners average their faces.
 */
export function voxelizeScene(scene, grid, opts = {}) {
  const albedo = new Uint32Array(grid.count);
  const normal = new Uint32Array(grid.count);
  const emissive = new Uint32Array(grid.count);
  const stats = voxelizeRegion(
    scene,
    grid,
    { albedo, normal, emissive },
    { x0: 0, y0: 0, z0: 0, x1: grid.dims.x, y1: grid.dims.y, z1: grid.dims.z },
    opts,
  );
  return { albedo, normal, emissive, ...stats };
}

// Emissive is HDR-ish (emissiveIntensity can exceed 1); it packs into RGB8
// at 1/EMISSIVE_SCALE and unpacks ×EMISSIVE_SCALE on the GPU.
export const EMISSIVE_SCALE = 8;

const _meshBox = new THREE.Box3();
const _regionBox = new THREE.Box3();

/**
 * Voxelizes only the voxels inside `region` (voxel coords, exclusive max),
 * writing into full-grid `target.albedo` / `target.normal` arrays. The
 * region is cleared first, and only meshes whose world AABB intersects it
 * are visited — this is what makes clipmap scrolling cheap: a camera step
 * re-voxelizes a thin slab, not the world.
 */
export function voxelizeRegion(scene, grid, target, region, { skip } = {}) {
  const work = voxelizeRegionWork(scene, grid, target, region, { skip });
  let step;
  do step = work.next(); while (!step.done);
  return step.value;
}

/**
 * Time-sliced variant used for full GI rebuilds. It produces exactly the
 * same buffers as voxelizeRegion(), but yields to the browser between small
 * triangle batches so loading a large scene cannot freeze the editor for
 * several seconds. `signal.cancelled` is deliberately a tiny dependency-free
 * cancellation token; callers normally voxelize into staging arrays and only
 * publish a completed result.
 */
export async function voxelizeRegionAsync(
  scene,
  grid,
  target,
  region,
  { skip, signal, timeSliceMs = 6 } = {},
) {
  const work = voxelizeRegionWork(scene, grid, target, region, { skip });
  const slice = Math.max(1, timeSliceMs);
  while (true) {
    const deadline = performance.now() + slice;
    let step;
    do {
      if (signal?.cancelled) {
        work.return?.();
        return { cancelled: true, occupied: 0, meshes: 0, tris: 0, meshLog: [] };
      }
      step = work.next();
      if (step.done) return step.value;
    } while (performance.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function* voxelizeRegionWork(scene, grid, target, region, { skip } = {}) {
  const { min, voxelSize, dims } = grid;
  const { x0, y0, z0, x1, y1, z1 } = region;
  const rx = x1 - x0;
  const ry = y1 - y0;
  const rz = z1 - z0;
  const regionCount = rx * ry * rz;
  if (regionCount <= 0) return { occupied: 0, meshes: 0, tris: 0, meshLog: [] };

  // Clear the region in the target grids (row-contiguous along x).
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      const row = voxelIndex(x0, y, z, dims);
      target.albedo.fill(0, row, row + rx);
      target.normal.fill(0, row, row + rx);
      target.emissive?.fill(0, row, row + rx);
    }
    yield;
  }

  const normalAccum = new Float32Array(regionCount * 3);
  const touched = new Uint8Array(regionCount);

  _regionBox.min.set(min.x + x0 * voxelSize, min.y + y0 * voxelSize, min.z + z0 * voxelSize);
  _regionBox.max.set(min.x + x1 * voxelSize, min.y + y1 * voxelSize, min.z + z1 * voxelSize);

  const meshes = [];
  forEachVoxelizableMesh(scene, (obj) => {
    if (skip && skip(obj)) return;
    // World-AABB rejection: keeps cost proportional to local geometry.
    obj.updateWorldMatrix(true, false);
    if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
    _meshBox.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);
    if (_meshBox.intersectsBox(_regionBox)) meshes.push(obj);
  });

  let tris = 0;
  const meshLog = [];
  for (const mesh of meshes) {
    const result = yield* voxelizeMesh(mesh, target.albedo, target.emissive, normalAccum, touched, min, voxelSize, dims, region);
    tris += result.tris;
    if (meshLog.length < 12) meshLog.push(`${mesh.name || mesh.uuid.slice(0, 8)}#${result.albedoHex}`);
  }

  // Finalize: pack accumulated normals for every occupied region voxel.
  let occupied = 0;
  for (let z = 0; z < rz; z++) {
    for (let y = 0; y < ry; y++) {
      for (let x = 0; x < rx; x++) {
        const ri = x + y * rx + z * rx * ry;
        if (!touched[ri]) continue;
        occupied++;
        let nx = normalAccum[ri * 3];
        let ny = normalAccum[ri * 3 + 1];
        let nz = normalAccum[ri * 3 + 2];
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-6) {
          nx /= len;
          ny /= len;
          nz /= len;
        } else {
          nx = 0;
          ny = 1;
          nz = 0;
        }
        target.normal[voxelIndex(x + x0, y + y0, z + z0, dims)] =
          (Math.round((nx * 0.5 + 0.5) * 255) |
            (Math.round((ny * 0.5 + 0.5) * 255) << 8) |
            (Math.round((nz * 0.5 + 0.5) * 255) << 16)) >>>
          0;
      }
    }
    yield;
  }
  return { occupied, meshes: meshes.length, tris, meshLog };
}

/**
 * Shifts a full-grid array's content by -shift voxels (gather: dst reads
 * dst+shift), zero-filling what scrolls in. Used when the clipmap recenters:
 * surviving voxels move, only the exposed slabs need re-voxelizing.
 * `scratch` must be a same-length array of the same type.
 */
export function shiftGrid(arr, dims, shift, scratch) {
  const { x: dx, y: dy, z: dz } = dims;
  const sx = shift.x;
  for (let z = 0; z < dz; z++) {
    const srcZ = z + shift.z;
    const zOk = srcZ >= 0 && srcZ < dz;
    for (let y = 0; y < dy; y++) {
      const srcY = y + shift.y;
      const row = (z * dy + y) * dx;
      if (!zOk || srcY < 0 || srcY >= dy) {
        scratch.fill(0, row, row + dx);
        continue;
      }
      const srcRow = (srcZ * dy + srcY) * dx;
      const xLo = Math.max(0, -sx);
      const xHi = Math.min(dx, dx - sx);
      if (xLo > 0) scratch.fill(0, row, row + xLo);
      if (xHi < dx) scratch.fill(0, row + xHi, row + dx);
      if (xHi > xLo) scratch.set(arr.subarray(srcRow + xLo + sx, srcRow + xHi + sx), row + xLo);
    }
  }
  arr.set(scratch);
}

// Caps the barycentric lattice so one enormous triangle (a ground plane)
// can't stall the rebuild; 1024 steps covers a 512-voxel-long edge at the
// half-voxel sample spacing used below.
const MAX_EDGE_STEPS = 1024;

function* voxelizeMesh(mesh, albedo, emissive, normalAccum, touched, min, voxelSize, dims, region) {
  const geometry = mesh.geometry;
  const pos = geometry.getAttribute("position");
  const index = geometry.index;
  const triCount = (index ? index.count : pos.count) / 3;
  mesh.updateWorldMatrix(true, false);
  // Snapshot transforms for async rebuild consistency. Indexed meshes reuse
  // vertices heavily, so transform every unique position once instead of
  // repeating Matrix4 work for all three corners of every triangle.
  const matrix = mesh.matrixWorld.clone();
  let worldPositions = null;
  if (index && index.count > pos.count * 1.5) {
    worldPositions = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      _p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      worldPositions[i * 3] = _p.x;
      worldPositions[i * 3 + 1] = _p.y;
      worldPositions[i * 3 + 2] = _p.z;
      if (i > 0 && (i & 4095) === 0) yield;
    }
  }
  const { x0, y0, z0, x1, y1, z1 } = region;
  const rx = x1 - x0;
  const rxy = rx * (y1 - y0);

  // Base color: first material's color, linear. Node materials may carry
  // their albedo on a uniform colorNode instead of .color — prefer it when
  // present so graph-driven materials don't voxelize as white.
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  _color.set(1, 1, 1);
  if (material?.color?.isColor) _color.copy(material.color);
  readConstantNodeColor(material?.colorNode, _color);
  const packedAlbedo =
    (Math.round(Math.min(1, _color.r) * 255) |
      (Math.round(Math.min(1, _color.g) * 255) << 8) |
      (Math.round(Math.min(1, _color.b) * 255) << 16) |
      (255 << 24)) >>>
    0;

  // Emissive: `emissive × emissiveIntensity` (or a uniform emissiveNode),
  // packed at 1/EMISSIVE_SCALE so intensities up to EMISSIVE_SCALE survive.
  _emissive.set(0, 0, 0);
  // In NodeMaterial, emissiveNode replaces (rather than modifies)
  // material.emissive * emissiveIntensity. Graph-authored emission is usually
  // a constant expression such as color * strength, which the helper above
  // resolves. Plain Three materials take the scalar-property path.
  const hasEmissiveNode = material?.emissiveNode?.isNode === true;
  if (hasEmissiveNode) readConstantNodeColor(material.emissiveNode, _emissive);
  else {
    if (material?.emissive?.isColor) _emissive.copy(material.emissive);
    const emissiveIntensity = Number.isFinite(material?.emissiveIntensity)
      ? material.emissiveIntensity
      : 1;
    _emissive.multiplyScalar(emissiveIntensity);
  }
  _emissive.multiplyScalar(1 / EMISSIVE_SCALE);
  const packedEmissive =
    (Math.round(Math.max(0, Math.min(1, _emissive.r)) * 255) |
      (Math.round(Math.max(0, Math.min(1, _emissive.g)) * 255) << 8) |
      (Math.round(Math.max(0, Math.min(1, _emissive.b)) * 255) << 16)) >>>
    0;

  const readVertex = (tri, corner, out) => {
    const i = index ? index.getX(tri * 3 + corner) : tri * 3 + corner;
    if (worldPositions) out.fromArray(worldPositions, i * 3);
    else out.fromBufferAttribute(pos, i).applyMatrix4(matrix);
  };

  // Region bounds in world space, padded half a voxel so boundary samples
  // aren't lost to floating-point edges.
  const pad = voxelSize * 0.5;
  const wx0 = min.x + x0 * voxelSize - pad;
  const wy0 = min.y + y0 * voxelSize - pad;
  const wz0 = min.z + z0 * voxelSize - pad;
  const wx1 = min.x + x1 * voxelSize + pad;
  const wy1 = min.y + y1 * voxelSize + pad;
  const wz1 = min.z + z1 * voxelSize + pad;

  // Lattice-samples one (sub)triangle with the ORIGINAL face normal in _n.
  const sampleTri = (a, b, c) => {
    _e01.subVectors(b, a);
    _e02.subVectors(c, a);
    const maxEdge = Math.max(_e01.length(), _e02.length(), c.distanceTo(b));
    const steps = Math.min(MAX_EDGE_STEPS, Math.max(1, Math.ceil((maxEdge / voxelSize) * 2)));
    const inv = 1 / steps;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        _p.copy(a)
          .addScaledVector(_e01, i * inv)
          .addScaledVector(_e02, j * inv);
        const vx = Math.floor((_p.x - min.x) / voxelSize);
        const vy = Math.floor((_p.y - min.y) / voxelSize);
        const vz = Math.floor((_p.z - min.z) / voxelSize);
        if (vx < x0 || vy < y0 || vz < z0 || vx >= x1 || vy >= y1 || vz >= z1) continue;
        const gi = voxelIndex(vx, vy, vz, dims);
        albedo[gi] = packedAlbedo;
        if (emissive) emissive[gi] = packedEmissive;
        const ri = vx - x0 + (vy - y0) * rx + (vz - z0) * rxy;
        touched[ri] = 1;
        normalAccum[ri * 3] += _n.x;
        normalAccum[ri * 3 + 1] += _n.y;
        normalAccum[ri * 3 + 2] += _n.z;
      }
    }
  };

  for (let t = 0; t < triCount; t++) {
    // Indexed production meshes commonly contain hundreds of thousands of
    // tiny triangles. Yielding per triangle would add generator overhead;
    // batches of 256 stay comfortably below the async scheduler's frame
    // budget while keeping the synchronous API fast.
    if (t > 0 && (t & 255) === 0) yield;
    readVertex(t, 0, _v0);
    readVertex(t, 1, _v1);
    readVertex(t, 2, _v2);
    _e01.subVectors(_v1, _v0);
    _e02.subVectors(_v2, _v0);
    _n.crossVectors(_e01, _e02);
    const area2 = _n.length();
    if (area2 < 1e-12) continue;
    _n.divideScalar(area2);

    // Triangle AABB vs region: reject outsiders outright; clip triangles
    // that straddle the region so sampling cost tracks the REGION size, not
    // the triangle size. Without this a world-sized ground triangle costs a
    // full ~500k-sample walk per slab — the clipmap-scroll freeze.
    const tminx = Math.min(_v0.x, _v1.x, _v2.x);
    const tmaxx = Math.max(_v0.x, _v1.x, _v2.x);
    const tminy = Math.min(_v0.y, _v1.y, _v2.y);
    const tmaxy = Math.max(_v0.y, _v1.y, _v2.y);
    const tminz = Math.min(_v0.z, _v1.z, _v2.z);
    const tmaxz = Math.max(_v0.z, _v1.z, _v2.z);
    if (tminx > wx1 || tmaxx < wx0 || tminy > wy1 || tmaxy < wy0 || tminz > wz1 || tmaxz < wz0) {
      continue;
    }
    if (tminx >= wx0 && tmaxx <= wx1 && tminy >= wy0 && tmaxy <= wy1 && tminz >= wz0 && tmaxz <= wz1) {
      sampleTri(_v0, _v1, _v2);
      continue;
    }
    const poly = clipPolyToBox([_v0, _v1, _v2], wx0, wy0, wz0, wx1, wy1, wz1);
    for (let k = 2; k < poly.length; k++) sampleTri(poly[0], poly[k - 1], poly[k]);
  }
  return { tris: triCount, albedoHex: _color.getHexString() };
}

// Sutherland–Hodgman clip of a convex polygon against an axis-aligned box.
// Points are Vector3s from a shared pool (valid until the next call).
const _clipPool = Array.from({ length: 24 }, () => new THREE.Vector3());
let _clipPoolNext = 0;
const _poolVec = () => _clipPool[_clipPoolNext++ % _clipPool.length];

function clipPolyToBox(points, x0, y0, z0, x1, y1, z1) {
  _clipPoolNext = 0;
  let poly = points;
  // [axis, boundary, keepBelow]
  const planes = [
    ["x", x0, false],
    ["x", x1, true],
    ["y", y0, false],
    ["y", y1, true],
    ["z", z0, false],
    ["z", z1, true],
  ];
  for (const [axis, bound, keepBelow] of planes) {
    if (poly.length < 3) return [];
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i];
      const prev = poly[(i + poly.length - 1) % poly.length];
      const curIn = keepBelow ? cur[axis] <= bound : cur[axis] >= bound;
      const prevIn = keepBelow ? prev[axis] <= bound : prev[axis] >= bound;
      if (curIn !== prevIn) {
        const tEdge = (bound - prev[axis]) / (cur[axis] - prev[axis]);
        out.push(_poolVec().copy(prev).lerp(cur, tEdge));
      }
      if (curIn) out.push(cur);
    }
    poly = out;
  }
  return poly;
}
