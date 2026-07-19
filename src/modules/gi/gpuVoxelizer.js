import * as THREE from "three/webgpu";
import { getVirtualGeometryRecord } from "../virtual-geometry/VirtualGeometrySystem.js";
import { getCoarsestClusterIndices } from "../virtual-geometry/clusterBuilder.js";
import {
  Fn,
  If,
  Loop,
  uniform,
  storage,
  instanceIndex,
  float,
  int,
  uint,
  max,
  clamp,
  ceil,
  cross,
  length,
  distance,
  floor,
} from "three/tsl";
import {
  readMeshGIColors,
  readMeshGISidedness,
} from "./voxelizer.js";

/**
 * GPU voxelization of dynamic meshes. The CPU voxelizer bakes the *static*
 * world into per-volume static buffers; every GI update frame the live voxel
 * buffers are recomposed on the GPU as `live = static ⊕ dynamic splats`, so
 * perpetually moving objects (physics debris, vehicles, animated platforms)
 * keep bouncing and occluding light instead of dropping out of the grid.
 *
 * One shared pool holds every dynamic mesh's triangles in OBJECT space plus a
 * small per-mesh world-matrix table. Triangles upload only when the dynamic
 * SET changes; motion costs one 64×mat4 upload per frame. The splat pass
 * transforms and lattice-samples triangles exactly like the CPU voxelizer
 * (half-voxel barycentric spacing), writing packed albedo/normal/emissive.
 *
 * Races: overlapping triangles scatter to the same voxel with plain (non-
 * atomic) stores. Each written word is individually valid; the worst case is
 * one voxel taking either surface's color for a frame — invisible in GI.
 */

export const MAX_DYNAMIC_MESHES = 64;
export const DYNAMIC_TRI_CAPACITY = 32768;
// A single high-poly mover must not consume the whole pool (that starved every
// other mover) nor be dropped entirely (that made a detailed object vanish
// from GI the moment it started moving and only reappear ~1 s later when the
// static bake caught up — the "lighting redraws much later" lag). Instead each
// mesh is stride-decimated to fit this budget; GI is low frequency, so a coarse
// triangle subset still occludes and bounces correctly during motion, and the
// exact geometry lands on settle.
export const DYNAMIC_TRI_PER_MESH = 12288;
// vec4 records per triangle: [v0|meshIdx], [v1|-], [v2|-], [albedo|-], [emissive|-]
export const VEC4S_PER_TRI = 5;
// Caps the barycentric lattice per thread. Edges longer than ~24 voxels get
// undersampled (holes) — dynamic movers are prop/character scale, not terrain.
const MAX_SPLAT_STEPS = 48;

const _poolColor = new THREE.Color();
const _poolEmissive = new THREE.Color();

/** Shared dynamic-mesh triangle pool (one per GISystem, reused by every volume). */
export class DynamicVoxelPool {
  constructor() {
    this.triangles = new THREE.StorageBufferAttribute(
      new Float32Array(DYNAMIC_TRI_CAPACITY * VEC4S_PER_TRI * 4),
      4,
    );
    this.matrices = new THREE.StorageBufferAttribute(
      new Float32Array(MAX_DYNAMIC_MESHES * 16),
      4,
    );
    // Storage nodes are shared across every volume's splat pipeline, exactly
    // like a volume's uniforms are shared across its own passes.
    this.trianglesNode = storage(this.triangles, "vec4", DYNAMIC_TRI_CAPACITY * VEC4S_PER_TRI);
    this.matricesNode = storage(this.matrices, "vec4", MAX_DYNAMIC_MESHES * 4);
    this.triCountU = uniform(0, "uint");
    this.meshes = [];
    this.boxes = []; // per-mesh world AABB, refreshed by updateMatrices()
    this.maxDims = []; // largest world-AABB axis per mesh (sub-voxel gating)
    this.count = 0;
    this._signature = "";
    this._warnedCapacity = false;
  }

  /**
   * Rebuilds the triangle pool if the dynamic mesh set (or any pooled
   * geometry) changed. Returns true when a rebuild happened.
   */
  sync(meshes) {
    const capped = meshes.slice(0, MAX_DYNAMIC_MESHES);
    if (meshes.length > MAX_DYNAMIC_MESHES && !this._warnedCapacity) {
      this._warnedCapacity = true;
      console.warn(`[gi] more than ${MAX_DYNAMIC_MESHES} dynamic meshes; extras won't affect GI`);
    }
    const signature = capped
      .map((m) => {
        const vgRecord = getVirtualGeometryRecord(m);
        const geometry = vgRecord?.original ?? m.geometry;
        const material = Array.isArray(m.material) ? m.material[0] : m.material;
        return (
          `${m.uuid}:${geometry?.id}:` +
          `${geometry?.getAttribute?.("position")?.version ?? 0}:` +
          `${geometry?.index?.version ?? 0}:` +
          `${vgRecord?.dag ? "root" : `${geometry?.drawRange?.start ?? 0}:${geometry?.drawRange?.count ?? "all"}`}:` +
          `${material?.uuid ?? "none"}:${material?.side ?? THREE.FrontSide}`
        );
      })
      .join("|");
    if (signature === this._signature) return false;
    this._signature = signature;

    const arr = this.triangles.array;
    this.meshes = [];
    let tri = 0;
    for (const mesh of capped) {
      // As with static voxelization, never consume Virtual Geometry's
      // camera-selected live draw range (which can still be empty when motion
      // begins). Use the complete camera-independent root cut.
      const vgRecord = getVirtualGeometryRecord(mesh);
      const geometry = vgRecord?.original ?? mesh.geometry;
      const pos = geometry?.getAttribute?.("position");
      if (!pos) continue;
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
      if (triCount <= 0) continue;
      // Fit the mesh into the remaining pool by stride-decimation rather than
      // dropping it: emit every `stride`-th triangle up to `budget`.
      const remaining = DYNAMIC_TRI_CAPACITY - tri;
      if (remaining <= 0) {
        if (!this._warnedCapacity) {
          this._warnedCapacity = true;
          console.warn(`[gi] dynamic triangle pool full (${DYNAMIC_TRI_CAPACITY}); skipping ${mesh.name || mesh.uuid.slice(0, 8)}`);
        }
        continue;
      }
      const budget = Math.min(triCount, remaining, DYNAMIC_TRI_PER_MESH);
      const stride = Math.max(1, Math.ceil(triCount / budget));
      const emitCount = Math.min(budget, Math.floor((triCount - 1) / stride) + 1);
      const meshIdx = this.meshes.length;
      readMeshGIColors(mesh, _poolColor, _poolEmissive);
      const sidedness = readMeshGISidedness(mesh);
      const cr = Math.min(1, Math.max(0, _poolColor.r));
      const cg = Math.min(1, Math.max(0, _poolColor.g));
      const cb = Math.min(1, Math.max(0, _poolColor.b));
      const er = Math.min(1, Math.max(0, _poolEmissive.r));
      const eg = Math.min(1, Math.max(0, _poolEmissive.g));
      const eb = Math.min(1, Math.max(0, _poolEmissive.b));
      for (let t = 0; t < emitCount; t++) {
        const srcTri = t * stride; // stride-decimated source triangle
        const base = (tri + t) * VEC4S_PER_TRI * 4;
        for (let corner = 0; corner < 3; corner++) {
          const drawIndex = drawStart + srcTri * 3 + corner;
          const i = indexOverride
            ? indexOverride[drawIndex]
            : index
              ? index.getX(drawIndex)
              : drawIndex;
          const o = base + corner * 4;
          arr[o] = pos.getX(i);
          arr[o + 1] = pos.getY(i);
          arr[o + 2] = pos.getZ(i);
          arr[o + 3] = 0;
        }
        arr[base + 3] = meshIdx; // v0.w carries the matrix-table index
        arr[base + 12] = cr;
        arr[base + 13] = cg;
        arr[base + 14] = cb;
        arr[base + 15] = sidedness;
        arr[base + 16] = er;
        arr[base + 17] = eg;
        arr[base + 18] = eb;
        arr[base + 19] = 0;
      }
      tri += emitCount;
      this.meshes.push(mesh);
    }
    this.count = tri;
    this.triCountU.value = tri;
    if (tri > 0) this.triangles.needsUpdate = true;
    return true;
  }

  /**
   * Per-frame: refresh the world-matrix table and each mesh's world AABB.
   * Explicit updateWorldMatrix because GI ticks in the update phase, before
   * render's scene-wide matrix refresh — physics/scripts already moved the
   * objects this frame and the splat should not lag them.
   */
  updateMatrices() {
    if (!this.meshes.length) return;
    const arr = this.matrices.array;
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      mesh.updateWorldMatrix(true, false);
      arr.set(mesh.matrixWorld.elements, i * 16);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = (this.boxes[i] ??= new THREE.Box3());
      box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      this.maxDims[i] = Math.max(
        box.max.x - box.min.x,
        box.max.y - box.min.y,
        box.max.z - box.min.z,
      );
    }
    this.matrices.needsUpdate = true;
  }
}

/**
 * Builds the two per-volume compute passes of the dynamic layer:
 *   copyNode  — live voxel buffers ← static (CPU-baked) buffers.
 *   splatNode — scatter the pool's triangles into the live buffers, one
 *               thread per triangle, world transform applied on the GPU.
 * `gridMin`/`voxelSize` are the volume's live uniforms, so recenters and
 * rebuilds need no extra wiring here.
 */
export function createDynamicVoxelNodes({ dims, gridMin, voxelSize, buffers, pool }) {
  const voxelCount = dims.x * dims.y * dims.z;
  const voxAlbedo = storage(buffers.voxAlbedo, "uint", voxelCount);
  const voxNormal = storage(buffers.voxNormal, "uint", voxelCount);
  const voxEmissive = storage(buffers.voxEmissive, "uint", voxelCount);
  const staticAlbedo = storage(buffers.voxStaticAlbedo, "uint", voxelCount);
  const staticNormal = storage(buffers.voxStaticNormal, "uint", voxelCount);
  const staticEmissive = storage(buffers.voxStaticEmissive, "uint", voxelCount);

  const copyNode = Fn(() => {
    const vi = instanceIndex;
    If(vi.lessThan(uint(voxelCount)), () => {
      voxAlbedo.element(vi).assign(staticAlbedo.element(vi));
      voxNormal.element(vi).assign(staticNormal.element(vi));
      voxEmissive.element(vi).assign(staticEmissive.element(vi));
    });
  })().compute(voxelCount);

  const pack888 = (v) => {
    const c = clamp(v, 0, 1).mul(255).add(0.5);
    return c.x
      .toUint()
      .bitOr(c.y.toUint().shiftLeft(uint(8)))
      .bitOr(c.z.toUint().shiftLeft(uint(16)));
  };

  const splatNode = Fn(() => {
    const ti = instanceIndex;
    If(ti.lessThan(pool.triCountU), () => {
      const base = ti.mul(uint(VEC4S_PER_TRI));
      const r0 = pool.trianglesNode.element(base).toVar();
      const p1 = pool.trianglesNode.element(base.add(uint(1))).xyz.toVar();
      const p2 = pool.trianglesNode.element(base.add(uint(2))).xyz.toVar();
      const albedoRecord = pool.trianglesNode.element(base.add(uint(3))).toVar();
      const albedo = albedoRecord.xyz;
      const sidedness = albedoRecord.w;
      const emissive = pool.trianglesNode.element(base.add(uint(4))).xyz;
      const mi = r0.w.toUint().mul(uint(4));
      const c0 = pool.matricesNode.element(mi).xyz.toVar();
      const c1 = pool.matricesNode.element(mi.add(uint(1))).xyz.toVar();
      const c2 = pool.matricesNode.element(mi.add(uint(2))).xyz.toVar();
      const c3 = pool.matricesNode.element(mi.add(uint(3))).xyz.toVar();
      const v0 = c0.mul(r0.x).add(c1.mul(r0.y)).add(c2.mul(r0.z)).add(c3).toVar();
      const v1 = c0.mul(p1.x).add(c1.mul(p1.y)).add(c2.mul(p1.z)).add(c3).toVar();
      const v2 = c0.mul(p2.x).add(c1.mul(p2.y)).add(c2.mul(p2.z)).add(c3).toVar();
      const e01 = v1.sub(v0).toVar();
      const e02 = v2.sub(v0).toVar();
      // World-space cross product: normals stay correct under any affine
      // transform (including non-uniform scale) without an inverse-transpose.
      const nrm = cross(e01, e02).toVar();
      const nl = length(nrm).toVar();
      If(nl.greaterThan(1e-12), () => {
        const N = nrm.div(nl).toVar();
        If(sidedness.lessThan(-0.5), () => {
          N.assign(N.negate());
        });
        const packedAlbedo = pack888(albedo).bitOr(uint(255).shiftLeft(uint(24))).toVar();
        const normalFlags = uint(0).toVar();
        If(sidedness.greaterThan(0.5), () => {
          normalFlags.assign(uint(1).shiftLeft(uint(24)));
        });
        const packedNormal = pack888(N.mul(0.5).add(0.5))
          .bitOr(normalFlags)
          .toVar();
        const packedEmissive = pack888(emissive).toVar();
        const maxEdge = max(length(e01), max(length(e02), distance(v2, v1)));
        // Half-voxel barycentric spacing, same as the CPU sampler.
        const steps = clamp(ceil(maxEdge.div(voxelSize).mul(2)), 1, MAX_SPLAT_STEPS).toVar();
        const stepsI = steps.toInt().toVar();
        const inv = float(1).div(steps).toVar();
        Loop({ start: int(0), end: stepsI, type: "int", condition: "<=", name: "si" }, ({ si }) => {
          Loop(
            { start: int(0), end: stepsI.sub(si), type: "int", condition: "<=", name: "sj" },
            ({ sj }) => {
              const p = v0
                .add(e01.mul(float(si).mul(inv)))
                .add(e02.mul(float(sj).mul(inv)));
              const g = p.sub(gridMin).div(voxelSize).toVar();
              If(
                g.x
                  .greaterThanEqual(0)
                  .and(g.y.greaterThanEqual(0))
                  .and(g.z.greaterThanEqual(0))
                  .and(g.x.lessThan(dims.x))
                  .and(g.y.lessThan(dims.y))
                  .and(g.z.lessThan(dims.z)),
                () => {
                  const c = floor(g);
                  const vi = c.x
                    .add(c.y.mul(dims.x))
                    .add(c.z.mul(dims.x * dims.y))
                    .toUint();
                  voxAlbedo.element(vi).assign(packedAlbedo);
                  voxNormal.element(vi).assign(packedNormal);
                  voxEmissive.element(vi).assign(packedEmissive);
                },
              );
            },
          );
        });
      });
    });
  })().compute(DYNAMIC_TRI_CAPACITY);

  return { copyNode, splatNode };
}
