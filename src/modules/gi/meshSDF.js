import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  Break,
  uniform,
  uniformArray,
  texture3D,
  float,
  uint,
  vec3,
  min,
  max,
  dot,
  sqrt,
  length,
  clamp,
  normalize,
  mix,
  positionWorld,
  normalWorld,
} from "three/tsl";

/**
 * Per-mesh signed-ish distance fields for sun shadows — the Lumen approach.
 *
 * Every previous shadow representation (screen SDF trace, world visibility
 * cache, global-SDF sphere trace, voxel opacity cones) was built on the
 * camera-centered global voxel clipmaps and inherited the same failures:
 * fields realign whenever the camera moves (shadows reshape per step), 0.4–2m
 * hollow shells are degenerate up close, and coarse mips smear occluders into
 * false umbra. Object-space fields fix all three by construction: they are
 * anchored to the mesh (camera cannot change them), sized to the mesh (a prop
 * gets centimeter cells), and each object occludes only with its own field
 * (no cross-object smear).
 *
 * Pipeline: bake once per unique geometry on the CPU (shell rasterization →
 * border flood-fill marks solid interiors → two-pass 3D chamfer), pack every
 * field into ONE 3D texture atlas, upload a small per-frame instance table
 * (world→grid rows + bounding sphere + cell size), and per fragment trace the
 * few instances whose bounding sphere the sun ray crosses. Motion only
 * updates a matrix — the field never rebakes for transforms.
 */

export const MESH_SDF_SLOT = 40; // texels per axis per slot
export const MESH_SDF_CAPACITY = 24; // simultaneous shadow casters
export const MESH_SDF_PAD = 2; // border cells kept at BAND (safe clamped reads)
export const MESH_SDF_BAND = 10; // distance clamp, in cells
export const MESH_SDF_MAX_TRIS = 60000; // bake budget guard (CPU, one-off)
export const MESH_SDF_MAX_EXTENT = 60; // world meters; bigger meshes don't cast
const VEC4S_PER_INSTANCE = 6; // r0,r1,r2 (world→grid rows), sphere, params, spare
const TRACE_STEPS = 12;

// Chamfer weights for the two-pass distance transform.
const CHAMFER = [];
for (let dz = -1; dz <= 1; dz++) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const m = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      if (m === 0) continue;
      CHAMFER.push({ dx, dy, dz, w: Math.sqrt(m) });
    }
  }
}
const CHAMFER_FWD = CHAMFER.filter(
  ({ dx, dy, dz }) => dz < 0 || (dz === 0 && (dy < 0 || (dy === 0 && dx < 0))),
);
const CHAMFER_BWD = CHAMFER.filter((n) => !CHAMFER_FWD.includes(n));

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e01 = new THREE.Vector3();
const _e02 = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Bakes one geometry's OBJECT-SPACE distance field into a res³ grid.
 * Returns { data: Float32Array(res³) in CELL units clamped to BAND,
 *           gridMin: Vector3 (local), cell: number (local units) }.
 * The grid is a cube around the bounding box center sized to the largest
 * axis plus padding, so slots stay uniform and clamped border reads are open.
 */
export function bakeMeshSDF(geometry, res = MESH_SDF_SLOT) {
  const pos = geometry.getAttribute("position");
  if (!pos) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const size = bbox.getSize(new THREE.Vector3());
  const maxAxis = Math.max(size.x, size.y, size.z, 1e-3);
  const interior = res - 2 * MESH_SDF_PAD - 2;
  const cell = maxAxis / Math.max(1, interior);
  const center = bbox.getCenter(new THREE.Vector3());
  const gridMin = new THREE.Vector3(
    center.x - (res / 2) * cell,
    center.y - (res / 2) * cell,
    center.z - (res / 2) * cell,
  );

  const count = res * res * res;
  // state: 0 = unknown, 1 = shell, 2 = outside
  const state = new Uint8Array(count);
  const idx = (x, y, z) => x + y * res + z * res * res;

  // Shell rasterization: barycentric lattice at half-cell spacing (the same
  // scheme the CPU voxelizer uses — watertight enough for occlusion).
  const index = geometry.index;
  const drawCount = index
    ? Math.min(index.count, geometry.drawRange.count ?? index.count)
    : Math.min(pos.count, geometry.drawRange.count ?? pos.count);
  const triCount = Math.floor(drawCount / 3);
  const start = geometry.drawRange.start ?? 0;
  for (let t = 0; t < triCount; t++) {
    const read = (corner, out) => {
      const i = index ? index.getX(start + t * 3 + corner) : start + t * 3 + corner;
      out.fromBufferAttribute(pos, i);
    };
    read(0, _v0);
    read(1, _v1);
    read(2, _v2);
    _e01.subVectors(_v1, _v0);
    _e02.subVectors(_v2, _v0);
    const maxEdge = Math.max(_e01.length(), _e02.length(), _v2.distanceTo(_v1));
    const steps = Math.min(512, Math.max(1, Math.ceil((maxEdge / cell) * 2)));
    const inv = 1 / steps;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        _p.copy(_v0)
          .addScaledVector(_e01, i * inv)
          .addScaledVector(_e02, j * inv);
        const x = Math.floor((_p.x - gridMin.x) / cell);
        const y = Math.floor((_p.y - gridMin.y) / cell);
        const z = Math.floor((_p.z - gridMin.z) / cell);
        if (x < 0 || y < 0 || z < 0 || x >= res || y >= res || z >= res) continue;
        state[idx(x, y, z)] = 1;
      }
    }
  }

  // Flood-fill "outside" from the borders through empty cells. Whatever the
  // flood cannot reach is enclosed → solid interior (occludes like the
  // shell), which is what makes rays unable to tunnel through closed meshes.
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  const push = (x, y, z) => {
    const i = idx(x, y, z);
    if (state[i] !== 0) return;
    state[i] = 2;
    queue[tail++] = i;
  };
  for (let a = 0; a < res; a++) {
    for (let b = 0; b < res; b++) {
      push(a, b, 0);
      push(a, b, res - 1);
      push(a, 0, b);
      push(a, res - 1, b);
      push(0, a, b);
      push(res - 1, a, b);
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const z = Math.floor(i / (res * res));
    const rem = i - z * res * res;
    const y = Math.floor(rem / res);
    const x = rem - y * res;
    if (x > 0) push(x - 1, y, z);
    if (x < res - 1) push(x + 1, y, z);
    if (y > 0) push(x, y - 1, z);
    if (y < res - 1) push(x, y + 1, z);
    if (z > 0) push(x, y, z - 1);
    if (z < res - 1) push(x, y, z + 1);
  }

  // Distance init: solid (shell + enclosed interior) = 0, open = BAND.
  const dist = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    dist[i] = state[i] === 2 ? MESH_SDF_BAND : 0;
  }

  // Two-pass 3D chamfer transform (≈7% metric error — fine for penumbrae).
  const sweep = (neighbors, reverse) => {
    for (let s = 0; s < count; s++) {
      const i = reverse ? count - 1 - s : s;
      if (dist[i] === 0) continue;
      const z = Math.floor(i / (res * res));
      const rem = i - z * res * res;
      const y = Math.floor(rem / res);
      const x = rem - y * res;
      let best = dist[i];
      for (const { dx, dy, dz, w } of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= res || ny >= res || nz >= res) continue;
        const candidate = dist[idx(nx, ny, nz)] + w;
        if (candidate < best) best = candidate;
      }
      dist[i] = Math.min(best, MESH_SDF_BAND);
    }
  };
  sweep(CHAMFER_FWD, false);
  sweep(CHAMFER_BWD, true);

  return { data: dist, gridMin, cell };
}

/** One shared 3D texture atlas: slots laid out along X. */
export class MeshSDFAtlas {
  constructor() {
    this.width = MESH_SDF_SLOT * MESH_SDF_CAPACITY;
    const texels = this.width * MESH_SDF_SLOT * MESH_SDF_SLOT;
    this.data = new Uint16Array(texels);
    this.data.fill(THREE.DataUtils.toHalfFloat(MESH_SDF_BAND)); // empty = open
    this.texture = new THREE.Data3DTexture(
      this.data,
      this.width,
      MESH_SDF_SLOT,
      MESH_SDF_SLOT,
    );
    this.texture.name = "giMeshSDFAtlas";
    this.texture.format = THREE.RedFormat;
    this.texture.type = THREE.HalfFloatType;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.wrapR = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  write(slot, dist) {
    const res = MESH_SDF_SLOT;
    const w = this.width;
    const slotX = slot * res;
    for (let z = 0; z < res; z++) {
      for (let y = 0; y < res; y++) {
        const srcRow = y * res + z * res * res;
        const dstRow = slotX + y * w + z * w * res;
        for (let x = 0; x < res; x++) {
          this.data[dstRow + x] = THREE.DataUtils.toHalfFloat(dist[srcRow + x]);
        }
      }
    }
    this.texture.needsUpdate = true;
  }
}

const _worldToLocal = new THREE.Matrix4();
const _gridFromWorld = new THREE.Matrix4();
const _scratchMat = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

/**
 * Runtime manager: bake cache + slot allocation + the per-frame instance
 * table (a small uniform array — fragment-stage friendly, uploaded whole).
 */
export class MeshSDFShadows {
  constructor() {
    this.atlas = new MeshSDFAtlas();
    this.instanceValues = Array.from(
      { length: MESH_SDF_CAPACITY * VEC4S_PER_INSTANCE },
      () => new THREE.Vector4(),
    );
    this.instancesNode = uniformArray(this.instanceValues);
    this.countU = uniform(0, "uint");
    this._bakes = new Map(); // geometry key → { slot, gridMin, cell } | "skip"
    this._slotNext = 0;
    this.count = 0;
  }

  #geometryKey(geometry) {
    const pos = geometry.getAttribute("position");
    return `${geometry.id}:${pos?.version ?? 0}:${geometry.drawRange?.count ?? -1}`;
  }

  /**
   * Ranks candidate meshes by distance to the camera, bakes at most ONE new
   * geometry per call (bakes are one-off CPU work), and rewrites the
   * instance table from current world transforms. Movers cost a matrix
   * update only.
   */
  update(meshes, cameraPos) {
    const ranked = [];
    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      if (!geometry?.getAttribute?.("position")) continue;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      _sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
      if (_sphere.radius * 2 > MESH_SDF_MAX_EXTENT) continue; // terrain-scale: skip
      ranked.push({
        mesh,
        distSq: _sphere.center.distanceToSquared(cameraPos),
        center: _sphere.center.clone(),
        radius: _sphere.radius,
      });
    }
    ranked.sort((a, b) => a.distSq - b.distSq);

    let written = 0;
    let bakedThisCall = false;
    for (const entry of ranked) {
      if (written >= MESH_SDF_CAPACITY) break;
      const geometry = entry.mesh.geometry;
      const key = this.#geometryKey(geometry);
      let bake = this._bakes.get(key);
      if (bake === "skip") continue;
      if (!bake) {
        if (bakedThisCall) continue; // budget: one bake per frame
        const index = geometry.index;
        const tris = (index ? index.count : geometry.getAttribute("position").count) / 3;
        if (tris > MESH_SDF_MAX_TRIS || this._slotNext >= MESH_SDF_CAPACITY) {
          this._bakes.set(key, "skip");
          continue;
        }
        bakedThisCall = true;
        const result = bakeMeshSDF(geometry);
        if (!result) {
          this._bakes.set(key, "skip");
          continue;
        }
        bake = { slot: this._slotNext++, gridMin: result.gridMin, cell: result.cell };
        this.atlas.write(bake.slot, result.data);
        this._bakes.set(key, bake);
      }

      // world → grid-cell coords as one affine: g = (worldToLocal·p − gridMin)/cell
      entry.mesh.updateWorldMatrix(true, false);
      _worldToLocal.copy(entry.mesh.matrixWorld).invert();
      _gridFromWorld
        .makeScale(1 / bake.cell, 1 / bake.cell, 1 / bake.cell)
        .multiply(
          _scratchMat.makeTranslation(-bake.gridMin.x, -bake.gridMin.y, -bake.gridMin.z),
        )
        .multiply(_worldToLocal);
      const e = _gridFromWorld.elements;
      // World-space cell size: local cell × mean world scale (conservative
      // enough for near-uniform scales; wildly non-uniform scaling will make
      // penumbrae slightly wrong, not leak).
      const sx = Math.hypot(entry.mesh.matrixWorld.elements[0], entry.mesh.matrixWorld.elements[1], entry.mesh.matrixWorld.elements[2]);
      const sy = Math.hypot(entry.mesh.matrixWorld.elements[4], entry.mesh.matrixWorld.elements[5], entry.mesh.matrixWorld.elements[6]);
      const sz = Math.hypot(entry.mesh.matrixWorld.elements[8], entry.mesh.matrixWorld.elements[9], entry.mesh.matrixWorld.elements[10]);
      const cellWorld = bake.cell * Math.cbrt(Math.max(1e-6, sx * sy * sz));

      const base = written * VEC4S_PER_INSTANCE;
      this.instanceValues[base].set(e[0], e[4], e[8], e[12]);
      this.instanceValues[base + 1].set(e[1], e[5], e[9], e[13]);
      this.instanceValues[base + 2].set(e[2], e[6], e[10], e[14]);
      this.instanceValues[base + 3].set(
        entry.center.x,
        entry.center.y,
        entry.center.z,
        entry.radius,
      );
      this.instanceValues[base + 4].set(bake.slot * MESH_SDF_SLOT, cellWorld, 0, 0);
      written++;
    }
    this.count = written;
    this.countU.value = written;
  }
}

/**
 * Material node for `light.shadow.shadowNode`: per fragment, reject
 * instances whose bounding sphere the sun ray misses, sphere-trace the rest
 * through their object-space fields. Camera-independent by construction.
 */
export function createMeshSDFSunShadowNode({ meshShadows, capsules = null, readyUniform }) {
  const uniforms = {
    sunDirToLight: uniform(new THREE.Vector3(0, 1, 0)),
    // Penumbra aperture ≈ tan(half sun angle).
    softness: uniform(0.04),
    // Compatibility with existing callers; the per-instance trace is bounded
    // by each caster's sphere, so no global range is needed.
    maxDistance: uniform(256),
  };
  const atlasTex = texture3D(meshShadows.atlas.texture);
  const inst = meshShadows.instancesNode;
  const atlasDims = vec3(
    MESH_SDF_SLOT * MESH_SDF_CAPACITY,
    MESH_SDF_SLOT,
    MESH_SDF_SLOT,
  );

  const node = Fn(() => {
    const P = positionWorld;
    const N = normalize(normalWorld);
    const L = normalize(uniforms.sunDirToLight);
    const visibility = float(1).toVar();

    If(dot(N, L).greaterThan(0), () => {
      Loop(
        { start: uint(0), end: meshShadows.countU, type: "uint", condition: "<", name: "mi" },
        ({ mi }) => {
          If(visibility.lessThan(0.004), () => {
            Break();
          });
          const base = mi.mul(uint(VEC4S_PER_INSTANCE));
          const sphere = inst.element(base.add(uint(3)));
          const params = inst.element(base.add(uint(4)));
          const cellW = params.y;
          // Ray/bounding-sphere interval along L from the receiver.
          const oc = sphere.xyz.sub(P).toVar();
          const b = dot(oc, L).toVar();
          const perpSq = dot(oc, oc).sub(b.mul(b));
          const rSq = sphere.w.mul(sphere.w);
          If(b.add(sphere.w).greaterThan(cellW).and(perpSq.lessThan(rSq)), () => {
            const half = sqrt(max(rSq.sub(perpSq), 0));
            const r0 = inst.element(base).toVar();
            const r1 = inst.element(base.add(uint(1))).toVar();
            const r2 = inst.element(base.add(uint(2))).toVar();
            const tEnd = b.add(half);
            // Start at the sphere entry (or just off the receiver). The
            // receiver's own field needs the usual shell-escape lift.
            const t = max(b.sub(half), cellW).toVar();
            const biased = P.add(N.mul(cellW)).toVar();
            Loop(TRACE_STEPS, () => {
              If(t.greaterThan(tEnd), () => {
                Break();
              });
              const pos = biased.add(L.mul(t));
              const g = vec3(
                dot(r0.xyz, pos).add(r0.w),
                dot(r1.xyz, pos).add(r1.w),
                dot(r2.xyz, pos).add(r2.w),
              );
              // Clamped border reads return the border cell's true (BAND-
              // clamped) distance — for a sample outside the slot that
              // UNDERestimates clearance, which only shrinks steps. Safe.
              const gc = clamp(
                g,
                vec3(0.5),
                vec3(MESH_SDF_SLOT - 0.5),
              );
              const uvw = gc.add(vec3(params.x, 0, 0)).div(atlasDims);
              const dCells = atlasTex.sample(uvw).level(0).x;
              const dWorld = dCells.mul(cellW).mul(0.9);
              If(dCells.lessThan(0.5), () => {
                visibility.assign(0);
                Break();
              });
              // Horizon/self-plane guard: the biased ray sits `cell + t·(L·N)`
              // above the receiver's own plane, so at grazing sun angles a
              // flat caster paints a false soft shadow on ITSELF that ends
              // abruptly at its bounding sphere (the circular-bulge
              // artifact). Only samples meaningfully closer than that own-
              // plane clearance are foreign occluders worth darkening for.
              const selfClear = cellW.add(t.mul(dot(N, L))).mul(0.85);
              If(dWorld.lessThan(selfClear), () => {
                visibility.assign(
                  min(
                    visibility,
                    max(dWorld.sub(cellW.mul(0.25)), 0).div(
                      uniforms.softness.mul(max(t, cellW)),
                    ),
                  ),
                );
              });
              // Empty-space steps may span the full stored band — a large
              // caster's bounding sphere is many meters across, and a tight
              // step cap exhausts the budget mid-sphere, quitting rays lit
              // (angular notch artifacts in big wall shadows).
              t.addAssign(clamp(dWorld, cellW.mul(0.5), cellW.mul(MESH_SDF_BAND * 0.8)));
            });
          });
        },
      );

      // Skinned characters: analytic capsule shadows (see capsuleShadows.js).
      // Exact ray↔segment distance per capsule — no field, no texture.
      if (capsules) {
        Loop(
          { start: uint(0), end: capsules.countU, type: "uint", condition: "<", name: "ci" },
          ({ ci }) => {
            If(visibility.lessThan(0.004), () => {
              Break();
            });
            const a = capsules.node.element(ci.mul(uint(2))).toVar();
            const bEnd = capsules.node.element(ci.mul(uint(2)).add(uint(1))).xyz;
            const radius = a.w;
            const pa = a.xyz.sub(P).toVar();
            const ba = bEnd.sub(a.xyz).toVar();
            // Closest approach between the sun ray (P, L) and the segment:
            // minimize |M(pa + ba·s)|² with M projecting out the ray
            // direction; M-inner products reduce to x·y − (x·L)(y·L).
            const paL = dot(pa, L);
            const baL = dot(ba, L);
            const denom = max(dot(ba, ba).sub(baL.mul(baL)), 1e-6);
            const s = clamp(
              dot(pa, ba).sub(paL.mul(baL)).negate().div(denom),
              0,
              1,
            );
            const q = pa.add(ba.mul(s)).toVar(); // segment point rel. receiver
            const t = dot(q, L).toVar(); // along-ray distance of that point
            // Behind-the-receiver capsules (or ones overlapping it — the
            // character's own leg at its feet) must not shadow.
            If(t.greaterThan(radius.mul(0.5)), () => {
              const dPerp = length(q.sub(L.mul(t))).sub(radius);
              visibility.assign(
                min(visibility, max(dPerp, 0).div(uniforms.softness.mul(t))),
              );
            });
          },
        );
      }
    });

    const s = clamp(visibility, 0, 1);
    const smooth = s.mul(s).mul(float(3).sub(s.mul(2)));
    return mix(float(1), smooth, readyUniform);
  })();

  return { node, uniforms };
}
