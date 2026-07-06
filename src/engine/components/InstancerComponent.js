import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { loadMaterialAsset, getDefaultMaterial } from "../materialAsset.js";

/**
 * Hardware-instanced duplicates of a source mesh (Blender Array modifier +
 * Hair-particle-style scatter). Reads the geometry from the entity's own
 * MeshComponent — if absent, the component stays inert and emits a console
 * warning. One component per entity, because there is only one source mesh
 * per entity to instance; for multiple instance groups use child entities.
 *
 * Two distribution paradigms share a single THREE.InstancedMesh back-end:
 *
 *   mode = "array"   — Array modifier: count copies along a per-step offset
 *                      (position/rotation/scale). With just three offset vec3s
 *                      and a count you can build linear stacks, grids,
 *                      circles, spirals, helices, etc. Seeded RNG mixes jitter.
 *
 *   mode = "scatter" — Hair-particle-style random scattering inside a shape:
 *                      sphere, box, circle, disc, or on the surface of the
 *                      source mesh. Seeded RNG so reloads reproduce layout.
 *
 * Per-instance variation (both modes):
 *   - random rotation around Y (or full) — rotationJitter
 *   - random uniform scale — scaleJitter
 *   - align to surface normal — onMesh mode only
 *
 * Material is the source mesh's material by default, or a .mat asset if the
 * `material` prop is set. Materials are shared — never disposed by us.
 */
const MODES = ["array", "scatter"];
const SCATTER_SHAPES = ["sphere", "box", "circle", "disc", "onMesh"];

export class InstancerComponent extends Component {
  static type = "instancer";
  static label = "Instancer";
  static defaults = {
    mode: "array", // "array" | "scatter"
    count: 10,
    seed: 0,

    // Array-mode: per-step offset applied to instance i (i ∈ [0, count)).
    // instance_i = T * instance_{i-1} where T = compose(offsetPos, offsetRot, offsetScale).
    arrayOffsetPosition: [1, 0, 0],
    arrayOffsetRotation: [0, 0, 0], // degrees (Euler XYZ), converted to radians on use
    arrayOffsetScale: [0, 0, 0], // additive, e.g. -0.05 = shrink 5% per step

    // Scatter-mode: random distribution shape.
    scatterShape: "sphere", // "sphere" | "box" | "circle" | "disc" | "onMesh"
    scatterSize: [1, 1, 1], // [radius] for sphere/circle/disc; [hx, hy, hz] for box; ignored for onMesh
    scatterAlignToNormal: false, // only meaningful for "onMesh"

    // "onMesh" only: scatter across a target mesh owned by another entity,
    // optionally restricted to triangles within `scatterRadius` (geodesic
    // world-space distance) of `scatterSurfaceCenter`. Empty entity id =
    // use the local MeshComponent (existing behaviour).
    scatterSurfaceEntity: "",
    scatterSurfaceShape: "whole", // "whole" | "radius" — only meaningful when scatterShape === "onMesh"
    scatterRadius: 1, // world-space distance cap when scatterSurfaceShape === "radius"
    scatterSurfaceCenter: [0, 0, 0], // world-space point to measure from

    // Per-instance jitter (both modes).
    rotationJitter: 0, // 0 = none, 1 = full random orientation, 0..1 blends with Y-only random
    scaleJitter: 0, // ± fraction (e.g. 0.2 = ±20% random scale)

    // Material override. Empty string means "use the source mesh's material".
    material: "",

    castShadow: true,
    receiveShadow: true,
  };

  static schema = [
    { key: "mode", label: "Mode", type: "select", options: MODES },
    { key: "count", label: "Count", type: "number", min: 1, max: 1_000_000, step: 1 },
    { key: "seed", label: "Seed", type: "number", min: 0, step: 1 },

    // Array-mode fields (showIf: mode === "array").
    { key: "arrayOffsetPosition", label: "Offset Position", type: "vec3", showIf: (p) => p.mode === "array" },
    { key: "arrayOffsetRotation", label: "Offset Rotation", type: "vec3", showIf: (p) => p.mode === "array" },
    { key: "arrayOffsetScale", label: "Offset Scale", type: "vec3", showIf: (p) => p.mode === "array" },

    // Scatter-mode fields (showIf: mode === "scatter").
    { key: "scatterShape", label: "Shape", type: "select", options: SCATTER_SHAPES, showIf: (p) => p.mode === "scatter" },
    { key: "scatterSize", label: "Size", type: "vec3", showIf: (p) => p.mode === "scatter" && p.scatterShape !== "onMesh" },
    { key: "scatterAlignToNormal", label: "Align to Normal", type: "boolean", showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" },
    // Surface-target controls (only when scatterShape === "onMesh").
    { key: "scatterSurfaceEntity", label: "Surface Entity", type: "text", showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" },
    { key: "scatterSurfaceShape", label: "Surface Mode", type: "select", options: ["whole", "radius"], showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" },
    { key: "scatterRadius", label: "Radius", type: "number", min: 0, step: 0.1, showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" && p.scatterSurfaceShape === "radius" },
    { key: "scatterSurfaceCenter", label: "Center", type: "vec3", showIf: (p) => p.mode === "scatter" && p.scatterShape === "onMesh" && p.scatterSurfaceShape === "radius" },

    // Both modes.
    { key: "rotationJitter", label: "Rotation Jitter", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "scaleJitter", label: "Scale Jitter", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "material", label: "Material Override", type: "asset", exts: ["mat"] },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  onAttach() {
    const meshComponent = this.entity.getComponent?.("mesh");
    if (!meshComponent || !meshComponent.mesh) {
      console.warn(
        `InstancerComponent on entity "${this.entity.name ?? this.entity.id}" requires a MeshComponent with an attached mesh. Add a Mesh component first.`,
      );
      this.instancedMesh = null;
      return;
    }

    const sourceMesh = meshComponent.mesh;
    const maxCount = Math.max(1, Math.floor(this.props.count));

    this.instancedMesh = new THREE.InstancedMesh(sourceMesh.geometry, sourceMesh.material, maxCount);
    this.instancedMesh.userData.entityId = this.entity.id;
    this.instancedMesh.castShadow = !!this.props.castShadow;
    this.instancedMesh.receiveShadow = !!this.props.receiveShadow;
    // We own a clone of the geometry only if the source has already disposed.
    // To be safe and predictable we never dispose the source's geometry here;
    // we share its geometry (the source mesh component owns disposal of it).
    this._ownsGeometry = false;

    // When the surface target is a different entity, instances must live in
    // world space (so they follow the target's transform). We park the
    // InstancedMesh directly under the engine scene in that case. Self-scatter
    // and non-surface modes keep the original parent so the Instancer entity's
    // transform still moves the instances.
    const targetEntityId = this.props.scatterSurfaceEntity;
    const targetEntity = targetEntityId ? this.entity?.engine?.getEntity?.(targetEntityId) : null;
    this._parent = targetEntity && targetEntity !== this.entity ? this.entity.engine.scene : this.entity.object3D;

    this.#fillMatrices(maxCount);

    if (this.props.material) this.#loadSharedMaterial(this.props.material);
    else this.instancedMesh.material = sourceMesh.material;

    this._parent.add(this.instancedMesh);
    this.instancedMesh.visible = this._enabled;
  }

  onDetach() {
    if (!this.instancedMesh) return;
    this.sharedGeneration = (this.sharedGeneration ?? 0) + 1;
    this._parent?.remove(this.instancedMesh);
    this._parent = null;
    if (this._ownsGeometry) this.instancedMesh.geometry.dispose();
    this.instancedMesh = null;
  }

  onDisable() {
    if (this.instancedMesh) this.instancedMesh.visible = false;
  }

  onEnable() {
    if (this.instancedMesh) this.instancedMesh.visible = true;
  }

  /**
   * Bumps the seed by 1 and rebuilds matrices — handy editor button so the
   * user can re-roll the random layout without typing a new seed.
   */
  regenerate() {
    this.props.seed = (this.props.seed ?? 0) + 1;
    this.onDetach();
    this.onAttach();
    this.entity?.engine?.emit?.("component-changed", {
      entityId: this.entity?.id,
      componentType: this.type,
      key: "seed",
    });
    this.entity?.engine?.emit?.("hierarchy-changed");
  }

  async #loadSharedMaterial(path) {
    const generation = (this.sharedGeneration = (this.sharedGeneration ?? 0) + 1);
    const shared = await loadMaterialAsset(path);
    if (generation !== this.sharedGeneration || !this.instancedMesh) return;
    this.instancedMesh.material = shared;
  }

  onPropChanged(key) {
    if (!this.instancedMesh) {
      // No source mesh yet — re-attaching will rebuild once a MeshComponent appears.
      if (key === "mode" || key === "count" || key === "seed" ||
          key === "arrayOffsetPosition" || key === "arrayOffsetRotation" || key === "arrayOffsetScale" ||
          key === "scatterShape" || key === "scatterSize" || key === "scatterAlignToNormal" ||
          key === "rotationJitter" || key === "scaleJitter") {
        this.onAttach();
        return;
      }
      if (key === "castShadow" || key === "receiveShadow") return;
      return;
    }
    if (key === "material") {
      this.sharedGeneration = (this.sharedGeneration ?? 0) + 1;
      if (this.props.material) this.#loadSharedMaterial(this.props.material);
      else {
        const src = this.entity.getComponent?.("mesh")?.mesh;
        this.instancedMesh.material = src?.material ?? getDefaultMaterial();
      }
      return;
    }
    if (key === "castShadow" || key === "receiveShadow") {
      this.instancedMesh[key] = !!this.props[key];
      return;
    }
    // Anything that affects the layout / count: full rebuild.
    this.onDetach();
    this.onAttach();
  }

  // ---------------------------------------------------------------------------
  // Matrix layout
  // ---------------------------------------------------------------------------

  #fillMatrices(count) {
    const mesh = this.instancedMesh;
    const rng = makeRng(this.props.seed ?? 0);

    const tmp = new THREE.Matrix4();
    const tmpPos = new THREE.Vector3();
    const tmpQuat = new THREE.Quaternion();
    const tmpScale = new THREE.Vector3(1, 1, 1);

    if (this.props.mode === "array") {
      const offPos = new THREE.Vector3().fromArray(vec3From(this.props.arrayOffsetPosition, 1, 0, 0));
      const offRotDeg = vec3From(this.props.arrayOffsetRotation, 0, 0, 0);
      const offScale = new THREE.Vector3().fromArray(vec3From(this.props.arrayOffsetScale, 0, 0, 0));

      const pos = new THREE.Vector3(0, 0, 0);
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3(1, 1, 1);
      const offQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(offRotDeg[0]),
          THREE.MathUtils.degToRad(offRotDeg[1]),
          THREE.MathUtils.degToRad(offRotDeg[2]),
          "XYZ",
        ),
      );

      const hasOffsetRotation = offRotDeg[0] || offRotDeg[1] || offRotDeg[2];
      const hasOffsetScale = offScale.x || offScale.y || offScale.z;

      for (let i = 0; i < count; i++) {
        composeInto(tmp, pos, quat, scale);
        applyJitter(tmp, this.props, rng);
        mesh.setMatrixAt(i, tmp);

        // Step the instance transform: rotation accumulated first (so the
        // subsequent position offset is rotated into the new local frame —
        // this is what makes spirals, helices, and circles work). Scale
        // accumulates additively (e.g. -0.05 per step → shrink 5% per copy).
        if (hasOffsetRotation) quat.multiply(offQuat);
        // Rotate the offset position by the current orientation, then translate.
        pos.add(offPos.clone().applyQuaternion(quat));
        if (hasOffsetScale) {
          scale.x += offScale.x;
          scale.y += offScale.y;
          scale.z += offScale.z;
        }
      }
    } else {
      // scatter
      const shape = this.props.scatterShape ?? "sphere";
      const size = vec3From(this.props.scatterSize, 1, 1, 1);
      const alignToNormal = !!this.props.scatterAlignToNormal && shape === "onMesh";

      // Pick the source mesh for surface modes. Defaults to the local
      // MeshComponent; can be overridden by `scatterSurfaceEntity` (any
      // entity with a MeshComponent in the scene).
      const surfaceMesh = resolveSurfaceMesh(this.entity, this.props);
      const onSurface = shape === "onMesh" && surfaceMesh;
      const surfaceIsForeign = !!this.props.scatterSurfaceEntity && surfaceMesh
        && this.entity.engine.getEntity(this.props.scatterSurfaceEntity) !== this.entity;

      // Surface sampler: world-space if sampling a foreign mesh, object-space
      // if sampling our own mesh (since the InstancedMesh shares the same
      // parent transform). The sampler returns points in the InstancedMesh's
      // parent space — exactly what `setMatrixAt` wants.
      let surfaceSampler = null;
      if (onSurface) {
        const surfaceShape = this.props.scatterSurfaceShape ?? "whole";
        if (surfaceShape === "radius") {
          const radius = Math.max(0, this.props.scatterRadius ?? 0);
          const center = vec3From(this.props.scatterSurfaceCenter, 0, 0, 0);
          // Geodesic sampler is always world-space (the InstancedMesh is
          // parented to engine.scene when the surface is foreign; for self
          // surface with radius mode, we also force world-space sampling for
          // consistency, since `center` is interpreted as a world point).
          if (!surfaceIsForeign) surfaceMesh.updateWorldMatrix(true, false);
          surfaceSampler = makeGeodesicSurfaceSampler(surfaceMesh, radius, center);
        } else {
          surfaceSampler = makeLocalSurfaceSampler(surfaceMesh, surfaceIsForeign);
        }
      }

      for (let i = 0; i < count; i++) {
        const [px, py, pz, nx, ny, nz] = samplePoint(shape, size, rng, surfaceSampler);
        tmpPos.set(px, py, pz);

        if (alignToNormal && surfaceSampler) {
          tmpQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(nx, ny, nz).normalize());
        } else {
          tmpQuat.identity();
        }

        tmpScale.set(1, 1, 1);
        composeInto(tmp, tmpPos, tmpQuat, tmpScale);
        applyJitter(tmp, this.props, rng);
        mesh.setMatrixAt(i, tmp);
      }
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
  }
}

// -----------------------------------------------------------------------------
// Helpers (module-private)
// -----------------------------------------------------------------------------

function vec3From(v, dx, dy, dz) {
  if (Array.isArray(v) && v.length === 3) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  return [dx, dy, dz];
}

/**
 * Mulberry32 — tiny seeded RNG. Same seed → same instance layout on reload.
 */
function makeRng(seed) {
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function composeInto(out, pos, quat, scale) {
  out.compose(pos, quat, scale);
}

/**
 * Apply per-instance rotation and scale jitter on top of `matrix`. Both
 * jitter passes operate on the matrix's rotation/scale columns only and
 * preserve the translation column — we extract pos/quat/scale once, mutate
 * quat and scale, and recompose at the end. Mutating the matrix piecewise
 * (e.g. with `makeRotationFromQuaternion`) silently zeros translation.
 *
 * rotationJitter = 0 → no rotation noise.
 * rotationJitter = 1 → fully random orientation (uniform on the sphere).
 * rotationJitter ∈ (0, 1) → blends Y-only random with full random.
 * scaleJitter     = fraction; final scale = 1 + (rand*2-1) * scaleJitter, uniform on xyz.
 */
function applyJitter(matrix, props, rng) {
  const rj = props.rotationJitter ?? 0;
  const sj = props.scaleJitter ?? 0;
  if (rj <= 0 && sj <= 0) return;

  // Decompose once, mutate quat/scale, recompose once.
  const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
  const quat = new THREE.Quaternion().setFromRotationMatrix(matrix);
  const scale = new THREE.Vector3().setFromMatrixScale(matrix);

  if (rj > 0) {
    let jitterQuat;
    if (rj >= 1) {
      // Uniform random unit quaternion (Marsaglia).
      const u1 = rng(), u2 = rng(), u3 = rng();
      const s1 = Math.sqrt(1 - u1);
      const s2 = Math.sqrt(u1);
      jitterQuat = new THREE.Quaternion(
        s1 * Math.sin(2 * Math.PI * u2),
        s1 * Math.cos(2 * Math.PI * u2),
        s2 * Math.sin(2 * Math.PI * u3),
        s2 * Math.cos(2 * Math.PI * u3),
      );
    } else {
      // Y-only random rotation, then slerp toward full random by rj.
      jitterQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
      const u1 = rng(), u2 = rng(), u3 = rng();
      const s1 = Math.sqrt(1 - u1);
      const s2 = Math.sqrt(u1);
      const randQuat = new THREE.Quaternion(
        s1 * Math.sin(2 * Math.PI * u2),
        s1 * Math.cos(2 * Math.PI * u2),
        s2 * Math.sin(2 * Math.PI * u3),
        s2 * Math.cos(2 * Math.PI * u3),
      );
      jitterQuat.slerp(randQuat, rj);
    }
    // Left-multiply: jitter applies in instance-local frame on top of the
    // existing orientation.
    quat.multiply(jitterQuat);
  }

  if (sj > 0) {
    const factor = 1 + (rng() * 2 - 1) * sj;
    scale.multiplyScalar(factor);
  }

  matrix.compose(pos, quat, scale);
}

/**
 * Sample a random point for a scatter shape.
 * Returns [x, y, z, nx, ny, nz]. Normal is zero unless shape is "onMesh"
 * (the surface sampler sets it).
 */
function samplePoint(shape, size, rng, surfaceSampler) {
  if (shape === "onMesh" && surfaceSampler) return surfaceSampler(rng);
  if (shape === "sphere") {
    // Uniform inside a sphere of radius size[0] (rejection sampling).
    const r = size[0];
    for (let i = 0; i < 8; i++) {
      const x = rng() * 2 - 1;
      const y = rng() * 2 - 1;
      const z = rng() * 2 - 1;
      const l2 = x * x + y * y + z * z;
      if (l2 <= 1) return [x * r, y * r, z * r, 0, 1, 0];
    }
    return [0, 0, 0, 0, 1, 0];
  }
  if (shape === "box") {
    const [hx, hy, hz] = size;
    return [(rng() * 2 - 1) * hx, (rng() * 2 - 1) * hy, (rng() * 2 - 1) * hz, 0, 1, 0];
  }
  if (shape === "circle") {
    // Ring: radius = size[0], thickness = size[1] (or 0 for a thin ring).
    const R = size[0];
    const t = size[1] ?? 0;
    const radius = t > 0 ? R - rng() * t : R;
    const theta = rng() * Math.PI * 2;
    return [Math.cos(theta) * radius, 0, Math.sin(theta) * radius, 0, 1, 0];
  }
  if (shape === "disc") {
    // Filled disc on XZ plane, radius = size[0].
    const R = size[0];
    const r = Math.sqrt(rng()) * R;
    const theta = rng() * Math.PI * 2;
    return [Math.cos(theta) * r, 0, Math.sin(theta) * r, 0, 1, 0];
  }
  // Fallback.
  return [0, 0, 0, 0, 1, 0];
}

/**
 * Resolve the mesh to sample on for `scatterShape === "onMesh"`. Defaults to
 * the local MeshComponent; honours `scatterSurfaceEntity` if it points to an
 * existing entity with a mesh.
 *
 * Returns null if no usable mesh is found — the scatter branch should then
 * skip sampling entirely so we don't crash on a half-configured component.
 */
function resolveSurfaceMesh(entity, props) {
  const targetId = props?.scatterSurfaceEntity;
  if (targetId) {
    const engine = entity?.engine;
    const targetEntity = engine?.getEntity?.(targetId);
    if (targetEntity) {
      if (targetEntity === entity) {
        // Picked ourselves — same as empty.
        return entity.getComponent?.("mesh")?.mesh ?? null;
      }
      const targetMeshComp = targetEntity.getComponent?.("mesh");
      if (targetMeshComp?.mesh) return targetMeshComp.mesh;
      console.warn(
        `InstancerComponent on "${entity.name ?? entity.id}": surface target "${targetEntity.name ?? targetId}" has no MeshComponent — falling back to local mesh.`,
      );
    } else {
      console.warn(
        `InstancerComponent on "${entity.name ?? entity.id}": surface target "${targetId}" not found — falling back to local mesh.`,
      );
    }
  }
  return entity.getComponent?.("mesh")?.mesh ?? null;
}

/**
 * Face-weighted surface sampler. Returns points in `mesh.parent`'s space
 * (the InstancedMesh's parent) for self-scatter, or world-space for foreign
 * scatter (when the InstancedMesh is parented to engine.scene).
 */
function makeLocalSurfaceSampler(mesh, foreign) {
  const raw = makeRawSurfaceSampler(mesh);
  if (!raw || !foreign) return raw;
  const tmp = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  return (rng) => {
    const [x, y, z, nx, ny, nz] = raw(rng);
    mesh.updateWorldMatrix(true, false);
    tmp.set(x, y, z).applyMatrix4(mesh.matrixWorld);
    nrm.set(nx, ny, nz).transformDirection(mesh.matrixWorld).normalize();
    return [tmp.x, tmp.y, tmp.z, nrm.x, nrm.y, nrm.z];
  };
}

/**
 * Geodesic surface sampler: Dijkstra from the triangle closest to
 * `centerWorld` over world-space centroid distances, restricted to triangles
 * whose shortest-path distance is ≤ `radiusWorld`. Returns points already in
 * `parent` space (the InstancedMesh's parent — must be engine.scene /
 * world root for this sampler to be correct).
 */
function makeGeodesicSurfaceSampler(mesh, radiusWorld, centerWorld) {
  if (!mesh?.geometry || radiusWorld <= 0) return null;
  const geom = mesh.geometry;
  const index = geom.getIndex();
  const posAttr = geom.getAttribute?.("position");
  if (!posAttr) return null;
  const position = posAttr.array;
  const triCount = index ? index.count / 3 : position.length / 9;
  if (triCount === 0) return null;

  // World positions for each triangle vertex + world-space centroid.
  mesh.updateWorldMatrix(true, false);
  const tmp = new THREE.Vector3();
  const worldVerts = new Float32Array(triCount * 9);
  const worldCentroids = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    let i0, i1, i2;
    if (index) { i0 = index.getX(t * 3); i1 = index.getX(t * 3 + 1); i2 = index.getX(t * 3 + 2); }
    else        { i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2; }
    for (let k = 0; k < 3; k++) {
      const idx = k === 0 ? i0 : k === 1 ? i1 : i2;
      const o = idx * 3;
      tmp.set(position[o] ?? 0, position[o + 1] ?? 0, position[o + 2] ?? 0).applyMatrix4(mesh.matrixWorld);
      const w = t * 9 + k * 3;
      worldVerts[w] = tmp.x; worldVerts[w + 1] = tmp.y; worldVerts[w + 2] = tmp.z;
    }
    const cx = (worldVerts[t * 9]     + worldVerts[t * 9 + 3] + worldVerts[t * 9 + 6]) / 3;
    const cy = (worldVerts[t * 9 + 1] + worldVerts[t * 9 + 4] + worldVerts[t * 9 + 7]) / 3;
    const cz = (worldVerts[t * 9 + 2] + worldVerts[t * 9 + 5] + worldVerts[t * 9 + 8]) / 3;
    worldCentroids[t * 3] = cx;
    worldCentroids[t * 3 + 1] = cy;
    worldCentroids[t * 3 + 2] = cz;
  }

  // Seed triangle = closest centroid to centerWorld.
  let seed = 0;
  let bestD = Infinity;
  for (let t = 0; t < triCount; t++) {
    const dx = worldCentroids[t * 3]     - centerWorld[0];
    const dy = worldCentroids[t * 3 + 1] - centerWorld[1];
    const dz = worldCentroids[t * 3 + 2] - centerWorld[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD) { bestD = d2; seed = t; }
  }

  // Triangle adjacency via vertex→tri lookup.
  const vertexTris = new Map();
  const pushVT = (key, tri) => {
    let s = vertexTris.get(key);
    if (!s) vertexTris.set(key, (s = []));
    s.push(tri);
  };
  for (let t = 0; t < triCount; t++) {
    let i0, i1, i2;
    if (index) { i0 = index.getX(t * 3); i1 = index.getX(t * 3 + 1); i2 = index.getX(t * 3 + 2); }
    else        { i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2; }
    pushVT(i0, t); pushVT(i1, t); pushVT(i2, t);
  }
  const adj = new Array(triCount);
  for (let t = 0; t < triCount; t++) adj[t] = new Set();
  for (const tris of vertexTris.values()) {
    for (let i = 0; i < tris.length; i++) {
      for (let j = i + 1; j < tris.length; j++) {
        adj[tris[i]].add(tris[j]);
        adj[tris[j]].add(tris[i]);
      }
    }
  }
  vertexTris.clear();

  // Dijkstra with a tiny array-based heap.
  const dist = new Float32Array(triCount);
  dist.fill(Infinity);
  dist[seed] = 0;
  const visited = new Uint8Array(triCount);
  const heap = [[seed, 0]];
  const edgeLen = (a, b) => Math.hypot(
    worldCentroids[a * 3]     - worldCentroids[b * 3],
    worldCentroids[a * 3 + 1] - worldCentroids[b * 3 + 1],
    worldCentroids[a * 3 + 2] - worldCentroids[b * 3 + 2],
  );
  while (heap.length) {
    let mi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i][1] < heap[mi][1]) mi = i;
    const [t, d] = heap.splice(mi, 1)[0];
    if (visited[t]) continue;
    visited[t] = 1;
    if (d > dist[t]) continue;
    for (const n of adj[t]) {
      const nd = d + edgeLen(t, n);
      if (nd < dist[n]) { dist[n] = nd; heap.push([n, nd]); }
    }
  }

  // CDF over triangles within radius (weighted by world-space area).
  const reachable = [];
  let total = 0;
  const areas = new Float32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    if (dist[t] <= radiusWorld) {
      const a = triangleArea(worldVerts, t * 9);
      areas[t] = a;
      total += a;
      reachable.push(t);
    }
  }
  if (total <= 0 || reachable.length === 0) return null;
  const cdf = new Float32Array(reachable.length);
  let acc = 0;
  for (let i = 0; i < reachable.length; i++) {
    acc += areas[reachable[i]];
    cdf[i] = acc;
  }

  // Sampler: pick a triangle from `reachable` by area-weighted CDF, then
  // barycentric in world-space (we already have worldVerts) — which is also
  // the InstancedMesh's parent space since it's parented to engine.scene.
  return (rng) => {
    const r = rng() * total;
    let lo = 0, hi = reachable.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1; else hi = mid;
    }
    const t = reachable[lo];
    const wv = t * 9;

    let u = rng(), v_ = rng();
    if (u + v_ > 1) { u = 1 - u; v_ = 1 - v_; }
    const ww = 1 - u - v_;
    tmp.set(
      worldVerts[wv]     * ww + worldVerts[wv + 3] * u + worldVerts[wv + 6] * v_,
      worldVerts[wv + 1] * ww + worldVerts[wv + 4] * u + worldVerts[wv + 7] * v_,
      worldVerts[wv + 2] * ww + worldVerts[wv + 5] * u + worldVerts[wv + 8] * v_,
    );

    // World-space normal from the same triangle.
    const ax = worldVerts[wv + 3] - worldVerts[wv];
    const ay = worldVerts[wv + 4] - worldVerts[wv + 1];
    const az = worldVerts[wv + 5] - worldVerts[wv + 2];
    const bx = worldVerts[wv + 6] - worldVerts[wv];
    const by = worldVerts[wv + 7] - worldVerts[wv + 1];
    const bz = worldVerts[wv + 8] - worldVerts[wv + 2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    return [tmp.x, tmp.y, tmp.z, nx / nl, ny / nl, nz / nl];
  };
}

/** Triangle area from a flat 9-float worldVerts entry. */
function triangleArea(worldVerts, baseIdx) {
  const ax = worldVerts[baseIdx + 3] - worldVerts[baseIdx];
  const ay = worldVerts[baseIdx + 4] - worldVerts[baseIdx + 1];
  const az = worldVerts[baseIdx + 5] - worldVerts[baseIdx + 2];
  const bx = worldVerts[baseIdx + 6] - worldVerts[baseIdx];
  const by = worldVerts[baseIdx + 7] - worldVerts[baseIdx + 1];
  const bz = worldVerts[baseIdx + 8] - worldVerts[baseIdx + 2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/**
 * Raw face-weighted surface sampler. Returns object-space points and
 * object-space normals. (rng, triangleIndex) -> [x, y, z, nx, ny, nz]. If
 * `triangleIndex` is omitted, picks one weighted by area.
 *
 * Returns null if the geometry has no usable position data.
 */
function makeRawSurfaceSampler(mesh) {
  if (!mesh?.geometry) return null;
  const geom = mesh.geometry;
  const posAttr = geom.getAttribute?.("position");
  if (!posAttr) return null;

  const index = geom.getIndex();
  const position = posAttr.array;
  const triCount = index ? index.count / 3 : position.length / 9;

  // Build cumulative area table (object-space).
  const cdf = new Float32Array(triCount);
  let total = 0;
  const v = (i) => {
    const o = i * 3;
    return [position[o] ?? 0, position[o + 1] ?? 0, position[o + 2] ?? 0];
  };

  for (let t = 0; t < triCount; t++) {
    let i0, i1, i2;
    if (index) {
      i0 = index.getX(t * 3);
      i1 = index.getX(t * 3 + 1);
      i2 = index.getX(t * 3 + 2);
    } else {
      i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2;
    }
    const A = v(i0), B = v(i1), C = v(i2);
    const ax = B[0] - A[0], ay = B[1] - A[1], az = B[2] - A[2];
    const cx = C[0] - A[0], cy = C[1] - A[1], cz = C[2] - A[2];
    // |cross(B-A, C-A)| / 2
    const cxx = ay * cz - az * cy;
    const cyy = az * cx - ax * cz;
    const czz = ax * cy - ay * cx;
    const area = 0.5 * Math.sqrt(cxx * cxx + cyy * cyy + czz * czz);
    total += area;
    cdf[t] = total;
  }
  if (total <= 0) return null;

  const triAt = (rng, t) => {
    let i0, i1, i2;
    if (index) { i0 = index.getX(t * 3); i1 = index.getX(t * 3 + 1); i2 = index.getX(t * 3 + 2); }
    else        { i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2; }
    const A = v(i0), B = v(i1), C = v(i2);
    let u = rng(), v_ = rng();
    if (u + v_ > 1) { u = 1 - u; v_ = 1 - v_; }
    const w = 1 - u - v_;
    const x = A[0] * w + B[0] * u + C[0] * v_;
    const y = A[1] * w + B[1] * u + C[1] * v_;
    const z = A[2] * w + B[2] * u + C[2] * v_;
    const ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2];
    const fx = C[0] - A[0], fy = C[1] - A[1], fz = C[2] - A[2];
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    return [x, y, z, nx / nl, ny / nl, nz / nl];
  };

  return (rng, triangleIndex) => {
    let t = triangleIndex;
    if (t === undefined) {
      const r = rng() * total;
      let lo = 0, hi = triCount - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < r) lo = mid + 1; else hi = mid;
      }
      t = lo;
    }
    return triAt(rng, t);
  };
}