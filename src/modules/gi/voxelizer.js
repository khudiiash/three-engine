import * as THREE from "three/webgpu";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";
import { getVirtualGeometryRecord } from "../virtual-geometry/VirtualGeometrySystem.js";
import { getCoarsestClusterIndices } from "../virtual-geometry/clusterBuilder.js";

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

export function readConstantNodeColor(node, out) {
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
  if (
    obj.userData.engineOwned ||
    obj.userData.editorOnly ||
    obj.userData.vgeoDebug ||
    obj.userData.giDebug
  ) {
    return false;
  }
  // Editor-only helpers (gizmos, grid, camera models) live on layer 31.
  if (((obj.layers.mask >>> 0) & EDITOR_ONLY_MASK) !== 0) return false;
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
  // Layers are not inherited in Three, but editor helpers commonly mark only
  // their root. Prune the whole subtree when either convention is present.
  if (
    !root.isScene &&
    (root.userData?.editorOnly ||
      root.userData?.giDebug ||
      (((root.layers?.mask ?? 0) >>> 0) & EDITOR_ONLY_MASK) !== 0)
  ) {
    return;
  }
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

// Empty voxels reached by a six-connected flood from the clipmap boundary
// carry this bit in the otherwise-unused top bit of the packed normal word.
// Occupied voxels keep their existing RGB normal + bit-24 two-sided flag.
export const EXTERIOR_EMPTY_BIT = 0x80000000;

// Corner/junction/mesh-overlap cells hold triangles from multiple faces;
// their averaged or dominant normal is unreliable, so direct injection
// skips them and sample-time normal gates accept them (a normal test there
// paints black seams along every wall junction).
export const AMBIGUOUS_NORMAL_BIT = 0x08000000; // bit 27

/**
 * Marks empty space connected to the clipmap boundary.
 *
 * A plain voxel/probe miss cannot distinguish open sky from a sealed room:
 * both contain empty voxels. Encoding connectivity lets GPU transport return
 * sky only for the former. Opening a wall joins the room to the exterior on
 * the next staged voxel publish; closing it removes that connection.
 */
export function markExteriorEmptyVoxels(albedo, normal, dims) {
  const work = markExteriorEmptyVoxelsWork(albedo, normal, dims);
  let step;
  do step = work.next(); while (!step.done);
  return step.value;
}

/**
 * Time-sliced flood classification for the async voxel publish path. The
 * synchronous flood on a large grid (up to 160³ = 4M cells) blocked one
 * editor frame for tens of milliseconds every time a bake or recenter
 * published — one of the "freeze on camera/object movement" sources.
 */
export async function markExteriorEmptyVoxelsAsync(
  albedo,
  normal,
  dims,
  { signal, timeSliceMs = 4 } = {},
) {
  const work = markExteriorEmptyVoxelsWork(albedo, normal, dims);
  const slice = Math.max(1, timeSliceMs);
  while (true) {
    const deadline = performance.now() + slice;
    let step;
    do {
      if (signal?.cancelled) {
        work.return?.();
        return { cancelled: true, exterior: 0, sealed: 0, occupied: 0, twoSided: 0 };
      }
      step = work.next();
      if (step.done) return step.value;
    } while (performance.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function* markExteriorEmptyVoxelsWork(albedo, normal, dims) {
  const { x: dx, y: dy, z: dz } = dims;
  const count = dx * dy * dz;
  if (!count) return { exterior: 0, sealed: 0, occupied: 0, twoSided: 0 };

  // The target arrays are normally fresh, but clearing first also makes this
  // safe for reused staging arrays. Occupancy/sidedness tallies ride along to
  // diagnose enclosure classification without a second full sweep.
  let occupied = 0;
  let twoSided = 0;
  for (let i = 0; i < count; i++) {
    // Strip the exterior bit and the ambiguity bit before reclassifying.
    normal[i] = (normal[i] & 0x71ffffff) >>> 0;
    if ((albedo[i] >>> 24) !== 0) {
      occupied++;
      if ((normal[i] & 0x01000000) !== 0) twoSided++;
    }
    if ((i & 65535) === 65535) yield;
  }

  const queue = new Uint32Array(count);
  let head = 0;
  let tail = 0;
  const enqueue = (index) => {
    if ((albedo[index] >>> 24) !== 0) return;
    if ((normal[index] & EXTERIOR_EMPTY_BIT) !== 0) return;
    normal[index] = EXTERIOR_EMPTY_BIT;
    queue[tail++] = index;
  };

  // Seed every boundary face. Duplicate edges/corners are rejected by the
  // bit check, keeping the queue bounded to exactly `count`.
  for (let z = 0; z < dz; z++) {
    for (let y = 0; y < dy; y++) {
      enqueue(y * dx + z * dx * dy);
      enqueue(dx - 1 + y * dx + z * dx * dy);
    }
  }
  for (let z = 0; z < dz; z++) {
    for (let x = 0; x < dx; x++) {
      enqueue(x + z * dx * dy);
      enqueue(x + (dy - 1) * dx + z * dx * dy);
    }
  }
  for (let y = 0; y < dy; y++) {
    for (let x = 0; x < dx; x++) {
      enqueue(x + y * dx);
      enqueue(x + y * dx + (dz - 1) * dx * dy);
    }
  }

  while (head < tail) {
    const index = queue[head++];
    const z = Math.floor(index / (dx * dy));
    const rem = index - z * dx * dy;
    const y = Math.floor(rem / dx);
    const x = rem - y * dx;
    if (x > 0) enqueue(index - 1);
    if (x + 1 < dx) enqueue(index + 1);
    if (y > 0) enqueue(index - dx);
    if (y + 1 < dy) enqueue(index + dx);
    if (z > 0) enqueue(index - dx * dy);
    if (z + 1 < dz) enqueue(index + dx * dy);
    if ((head & 32767) === 0) yield;
  }

  // Ambiguous-normal tagging. A cell whose normal-side neighbour is also
  // occupied holds triangles from multiple faces (wall junction or mesh
  // overlap): its averaged/dominant normal is unreliable, so injection
  // skips it (corners are AO territory) and sample-time normal gates fall
  // back to accepting it. The former sealed/exterior face-component bits
  // were removed together with the binary enclosure gating.
  const occupiedAt = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= dx || y >= dy || z >= dz) return false;
    return (albedo[x + y * dx + z * dx * dy] >>> 24) !== 0;
  };
  for (let z = 0; z < dz; z++) {
    for (let y = 0; y < dy; y++) {
      for (let x = 0; x < dx; x++) {
        const i = x + y * dx + z * dx * dy;
        if ((albedo[i] >>> 24) === 0) continue;
        const word = normal[i];
        const nx = (word & 255) / 127.5 - 1;
        const ny = ((word >>> 8) & 255) / 127.5 - 1;
        const nz = ((word >>> 16) & 255) / 127.5 - 1;
        const sx = nx > 0.35 ? 1 : nx < -0.35 ? -1 : 0;
        const sy = ny > 0.35 ? 1 : ny < -0.35 ? -1 : 0;
        const sz = nz > 0.35 ? 1 : nz < -0.35 ? -1 : 0;
        const twoSidedCell = (word & 0x01000000) !== 0;
        let ambiguous = occupiedAt(x + sx, y + sy, z + sz);
        if (!ambiguous && twoSidedCell) {
          ambiguous = occupiedAt(x - sx, y - sy, z - sz);
        }
        if (ambiguous) {
          normal[i] = (word | AMBIGUOUS_NORMAL_BIT) >>> 0;
        }
      }
      yield;
    }
  }

  return {
    exterior: tail,
    sealed: count - occupied - tail,
    occupied,
    twoSided,
  };
}

/**
 * Re-runs ONLY the local ambiguous-normal tagging (the second half of
 * `markExteriorEmptyVoxelsWork`) over a bounded region, in place. Used by the
 * incremental region re-bake, which cannot afford the global exterior BFS —
 * and does not need it, because the lighting shaders read the ambiguous bit
 * (junction cells) but not the exterior bit. The tagging is purely local: each
 * occupied cell inspects its normal-side neighbour's occupancy, so a region
 * dilated by one voxel around the changed area reclassifies correctly without
 * touching the rest of the grid. Stale ambiguous bits inside the region are
 * stripped first so a cell that stopped being a junction clears its flag.
 *
 * `region` is {x0,y0,z0,x1,y1,z1} in voxel coordinates (half-open, already
 * clamped to the grid by the caller).
 */
export function reclassifyAmbiguousRegion(albedo, normal, dims, region) {
  const { x: dx, y: dy, z: dz } = dims;
  const { x0, y0, z0, x1, y1, z1 } = region;
  const occupiedAt = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= dx || y >= dy || z >= dz) return false;
    return (albedo[x + y * dx + z * dx * dy] >>> 24) !== 0;
  };
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = x + y * dx + z * dx * dy;
        const word = (normal[i] & ~AMBIGUOUS_NORMAL_BIT) >>> 0;
        if ((albedo[i] >>> 24) === 0) {
          normal[i] = word;
          continue;
        }
        const nx = (word & 255) / 127.5 - 1;
        const ny = ((word >>> 8) & 255) / 127.5 - 1;
        const nz = ((word >>> 16) & 255) / 127.5 - 1;
        const sx = nx > 0.35 ? 1 : nx < -0.35 ? -1 : 0;
        const sy = ny > 0.35 ? 1 : ny < -0.35 ? -1 : 0;
        const sz = nz > 0.35 ? 1 : nz < -0.35 ? -1 : 0;
        const twoSidedCell = (word & 0x01000000) !== 0;
        let ambiguous = occupiedAt(x + sx, y + sy, z + sz);
        if (!ambiguous && twoSidedCell) {
          ambiguous = occupiedAt(x - sx, y - sy, z - sz);
        }
        normal[i] = ambiguous ? (word | AMBIGUOUS_NORMAL_BIT) >>> 0 : word;
      }
    }
  }
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

/**
 * Resolves a mesh's flat GI colors into `colorOut`/`emissiveOut`. Emissive is
 * returned pre-scaled by 1/EMISSIVE_SCALE (the packed-RGB8 storage scale).
 * Shared by the CPU voxelizer and the GPU dynamic-mesh splatter so an object
 * keeps the same voxel color while moving and after it settles.
 *
 * Base color: first material's color, linear. Node materials may carry their
 * albedo on a uniform colorNode instead of .color — prefer it when present so
 * graph-driven materials don't voxelize as white. In NodeMaterial,
 * emissiveNode replaces (rather than modifies) emissive × emissiveIntensity.
 */
export function readMeshGIColors(mesh, colorOut, emissiveOut) {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  colorOut.set(1, 1, 1);
  if (material?.color?.isColor) colorOut.copy(material.color);
  readConstantNodeColor(material?.colorNode, colorOut);

  emissiveOut.set(0, 0, 0);
  if (material?.emissiveNode?.isNode === true) {
    readConstantNodeColor(material.emissiveNode, emissiveOut);
  } else {
    if (material?.emissive?.isColor) emissiveOut.copy(material.emissive);
    const emissiveIntensity = Number.isFinite(material?.emissiveIntensity)
      ? material.emissiveIntensity
      : 1;
    emissiveOut.multiplyScalar(emissiveIntensity);
  }
  emissiveOut.multiplyScalar(1 / EMISSIVE_SCALE);
}

/**
 * Matches the normal orientation used by Three's visible material lighting:
 * 0 = front side, 1 = double sided, -1 = back side.
 */
export function readMeshGISidedness(mesh) {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (material?.side === THREE.DoubleSide) return 1;
  if (material?.side === THREE.BackSide) return -1;
  return 0;
}

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
  const normalSamples = new Uint32Array(regionCount);
  const dominantWeight = new Float32Array(regionCount);
  const dominantNormal = new Float32Array(regionCount * 3);
  const normalFlags = new Uint8Array(regionCount);
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
    const result = yield* voxelizeMesh(
      mesh,
      target.albedo,
      target.emissive,
      normalAccum,
      normalSamples,
      dominantWeight,
      dominantNormal,
      normalFlags,
      touched,
      min,
      voxelSize,
      dims,
      region,
    );
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
        const samples = normalSamples[ri] || 1;
        // Orthogonal surfaces sharing one voxel used to average into a
        // diagonal normal, so colored corners received light from a
        // direction no real face had. Preserve smooth/curved surfaces when
        // their samples agree, but fall back to the largest contributing
        // triangle when coherence drops below ~37°.
        const coherence = len / samples;
        if (coherence < 0.8 && dominantWeight[ri] > 0) {
          nx = dominantNormal[ri * 3];
          ny = dominantNormal[ri * 3 + 1];
          nz = dominantNormal[ri * 3 + 2];
        } else if (len > 1e-6) {
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
            (Math.round((nz * 0.5 + 0.5) * 255) << 16) |
            ((normalFlags[ri] & 1) << 24)) >>>
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

function* voxelizeMesh(
  mesh,
  albedo,
  emissive,
  normalAccum,
  normalSamples,
  dominantWeight,
  dominantNormal,
  normalFlags,
  touched,
  min,
  voxelSize,
  dims,
  region,
) {
  // A virtualized mesh's live geometry contains the camera-distance-selected
  // render cut. It starts at drawRange=0 and changes as the camera moves, so
  // consuming it here made static objects disappear from GI until the camera
  // happened to select their clusters. Use the camera-independent, complete
  // root cut against the original vertex stream instead.
  const vgRecord = getVirtualGeometryRecord(mesh);
  const geometry = vgRecord?.original ?? mesh.geometry;
  const pos = geometry.getAttribute("position");
  const index = geometry.index;
  const indexOverride = vgRecord?.dag
    ? getCoarsestClusterIndices(vgRecord.dag)
    : null;
  const sourceCount = indexOverride?.length ?? (index ? index.count : pos.count);
  const drawStart = indexOverride
    ? 0
    : Math.max(0, Math.min(sourceCount, geometry.drawRange?.start || 0));
  const requestedCount = indexOverride ? sourceCount : geometry.drawRange?.count;
  const drawCount = Number.isFinite(requestedCount)
    ? Math.max(0, Math.min(sourceCount - drawStart, requestedCount))
    : sourceCount - drawStart;
  const triCount = Math.floor(drawCount / 3);
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

  readMeshGIColors(mesh, _color, _emissive);
  const sidedness = readMeshGISidedness(mesh);
  const doubleSided = sidedness > 0;
  const flipNormal = sidedness < 0;
  const packedAlbedo =
    (Math.round(Math.min(1, _color.r) * 255) |
      (Math.round(Math.min(1, _color.g) * 255) << 8) |
      (Math.round(Math.min(1, _color.b) * 255) << 16) |
      (255 << 24)) >>>
    0;
  const packedEmissive =
    (Math.round(Math.max(0, Math.min(1, _emissive.r)) * 255) |
      (Math.round(Math.max(0, Math.min(1, _emissive.g)) * 255) << 8) |
      (Math.round(Math.max(0, Math.min(1, _emissive.b)) * 255) << 16)) >>>
    0;

  const readVertex = (tri, corner, out) => {
    const drawIndex = drawStart + tri * 3 + corner;
    const i = indexOverride
      ? indexOverride[drawIndex]
      : index
        ? index.getX(drawIndex)
        : drawIndex;
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
  // This is a generator because a single world-sized floor/wall triangle can
  // contain hundreds of thousands of lattice samples. Yielding only between
  // triangles made the nominally async voxelizer block one editor frame for
  // 100–200 ms while an object was being dragged.
  const sampleTri = function* (a, b, c, faceWeight) {
    _e01.subVectors(b, a);
    _e02.subVectors(c, a);
    const maxEdge = Math.max(_e01.length(), _e02.length(), c.distanceTo(b));
    const steps = Math.min(MAX_EDGE_STEPS, Math.max(1, Math.ceil((maxEdge / voxelSize) * 2)));
    const inv = 1 / steps;
    let samples = 0;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        // Keep each synchronous generator slice small even for one huge
        // triangle. The outer scheduler still enforces its wall-clock budget.
        if (++samples % 1024 === 0) yield;
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
        normalSamples[ri]++;
        if (doubleSided) normalFlags[ri] = 1;
        if (faceWeight > dominantWeight[ri]) {
          dominantWeight[ri] = faceWeight;
          dominantNormal[ri * 3] = _n.x;
          dominantNormal[ri * 3 + 1] = _n.y;
          dominantNormal[ri * 3 + 2] = _n.z;
        }
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
    if (flipNormal) _n.negate();

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
      yield* sampleTri(_v0, _v1, _v2, area2);
      continue;
    }
    const poly = clipPolyToBox([_v0, _v1, _v2], wx0, wy0, wz0, wx1, wy1, wz1);
    for (let k = 2; k < poly.length; k++) {
      yield* sampleTri(poly[0], poly[k - 1], poly[k], area2);
    }
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
