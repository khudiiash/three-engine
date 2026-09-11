import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { bakeImpostorAtlas } from "../../engine/lod/impostorBake.js";
import { createImpostorGeometry, createImpostorMaterial } from "../../engine/lod/impostorMaterial.js";
import { createFoliagePrototype } from "./foliageGeometry.js";
import { collectSurfaceTriangles, reseatFoliageInstances, scatterFoliage } from "./foliageScatter.js";
import { createFoliageMaterial, createFoliageSurfaceMaterial, createFoliageUniforms, installFoliagePassHooks, setupFoliageImpostorMaterial, updateFoliageUniforms } from "./foliageMaterial.js";
import { foliageCellSize, foliageDetailDistances, foliageLodLevel, partitionFoliage } from "./foliageLod.js";
import { updateFoliageInteractions } from "./foliageInteraction.js";
import { deferFoliageDisposal, updateFoliageWarmup } from "./foliageWarmup.js";
import { sceneWind } from "../../engine/vfx/clothWind.js";

const atlasCaches = new WeakMap();
const bakeQueues = new WeakMap();
const shapeKeys = new Set(["species", "seed", "height", "width", "leafColor", "barkColor", "flowerColor"]);
const placementKeys = new Set(["distribution", "surface", "density", "maxInstances", "minSpacing", "seed", "minSlope", "maxSlope", "minAltitude", "maxAltitude", "alignToNormal", "minScale", "maxScale", "chunkSize"]);
const geometrySourceKeys = new Set(["geometry", "geometryAsset", "heights", "size", "resolution", "path", "enabled"]);
const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
const cameraPosition = new THREE.Vector3(), axisX = new THREE.Vector3(), axisY = new THREE.Vector3();
const viewportSize = new THREE.Vector2(), prototypeSize = new THREE.Vector3();
const levelNames = ["nearChunks", "midChunks", "impostorChunks", "culledChunks"];

function visibleEntity(entity, playing) {
  for (let node = entity; node; node = node.parent) {
    if (node.enabled === false || node[playing ? "enabledInGame" : "enabledInEditor"] === false || node.object3D?.visible === false || node._lodHidden === true) return false;
  }
  return true;
}

function instanceMatrix(instance) {
  position.fromArray(instance.position);
  quaternion.fromArray(instance.quaternion ?? [0, 0, 0, 1]);
  const s = Number(instance.scale) || 1;
  scale.setScalar(s);
  return matrix.compose(position, quaternion, scale);
}

function tagMesh(mesh, entityId) {
  Object.assign(mesh.userData, { entityId, foliageOwned: true, noBatch: true, noMerge: true, vfxSimulation: "foliage" });
  installFoliagePassHooks(mesh);
  return mesh;
}

function atlasKey(props) {
  return [...shapeKeys].map(key => `${key}:${props[key]}`).join("|");
}

/** Reuse the engine's normal/albedo octahedral atlas, serialized per renderer.
 * The bake draws synchronously before its first readback await. Restore the
 * renderer state immediately so ordinary frames remain correct during readback. */
function acquireAtlas(renderer, key, geometry, props) {
  let cache = atlasCaches.get(renderer);
  if (!cache) atlasCaches.set(renderer, cache = new Map());
  let entry = cache.get(key);
  if (entry) { entry.refs++; return entry; }
  entry = { refs: 1, atlas: null, material: null, error: null, cache, key };
  cache.set(key, entry);
  const sourceGeometry = geometry.clone();
  const sourceMaterial = createFoliageSurfaceMaterial(props);
  const source = new THREE.Mesh(sourceGeometry, sourceMaterial);
  renderer.__foliageAtlasPending = (renderer.__foliageAtlasPending ?? 0) + 1;
  const before = bakeQueues.get(renderer) ?? Promise.resolve();
  entry.promise = before.catch(() => {}).then(async () => {
    const toneMapping = renderer.toneMapping;
    const color = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    const promise = bakeImpostorAtlas(renderer, source, { frames: 4, tile: 64, hemisphere: true });
    renderer.toneMapping = toneMapping;
    renderer.setClearColor(color, alpha);
    const atlas = await promise;
    entry.atlas = atlas;
    entry.material = createImpostorMaterial(atlas, { alphaTest: .35, lit: true });
    entry.material.name = "Foliage · octahedral impostor";
    if (!entry.refs) { entry.material.dispose(); atlas.dispose(); }
    return entry;
  }).catch(error => { entry.error = error?.message ?? String(error); return entry; }).finally(() => {
    sourceGeometry.dispose(); sourceMaterial.dispose();
    renderer.__foliageAtlasPending = Math.max(0, (renderer.__foliageAtlasPending ?? 1) - 1);
  });
  bakeQueues.set(renderer, entry.promise);
  return entry;
}

function releaseAtlas(entry) {
  if (!entry || --entry.refs > 0) return;
  entry.cache.delete(entry.key);
  entry.material?.dispose();
  entry.atlas?.dispose();
}

export class FoliageComponent extends Component {
  static type = "foliage";
  static label = "Foliage";
  static tags = ["world", "trees", "grass", "flowers", "terrain", "3d"];
  static defaults = {
    species: "oak", distribution: "single", surface: "", density: .15, maxInstances: 10000,
    seed: 1, height: 6, width: 4, leafColor: "#427a32", barkColor: "#654733", flowerColor: "#eed078",
    minSpacing: 0, minSlope: 0, maxSlope: 55, minAltitude: -10000, maxAltitude: 10000,
    alignToNormal: false, minScale: .8, maxScale: 1.2,
    wind: true, windStrength: .2, windSpeed: 1, windDirection: 35,
    windGustStrength: .6, windScale: 12, windTurbulence: .25,
    interaction: false, interactionStrength: .5, interactionRadius: 1,
    lodNear: 25, lodFar: 70, maxDistance: 180, chunkSize: 24,
    castShadow: true, receiveShadow: true,
  };
  static structuralProps = [...shapeKeys, ...placementKeys, "castShadow", "receiveShadow"];
  static schema = [
    { key: "species", label: "Species", type: "select", options: ["oak", "pine", "birch", "grass", "wildflowers"] },
    { key: "distribution", label: "Distribution", type: "select", options: ["single", "scatter"] },
    { key: "surface", label: "Surface", type: "entity" },
    ...["density", "maxInstances", "seed", "height", "width", "minSpacing", "minSlope", "maxSlope", "minAltitude", "maxAltitude", "minScale", "maxScale", "windStrength", "windSpeed", "windDirection", "windGustStrength", "windScale", "windTurbulence", "interactionStrength", "interactionRadius", "lodNear", "lodFar", "maxDistance", "chunkSize"].map(key => ({ key, label: key.replace(/([A-Z])/g, " $1"), type: "number", step: ["seed", "maxInstances"].includes(key) ? 1 : .1 })),
    ...["leafColor", "barkColor", "flowerColor"].map(key => ({ key, label: key.replace("Color", " Color"), type: "color" })),
    ...["alignToNormal", "wind", "interaction", "castShadow", "receiveShadow"].map(key => ({ key, label: key.replace(/([A-Z])/g, " $1"), type: "boolean" })),
    { key: "runInEditor", label: "Run In Editor", type: "boolean" },
  ];

  constructor(props) {
    super(props);
    this.root = null;
    this.chunks = [];
    this.renderMeshes = [];
    this.instances = [];
    this.uniforms = createFoliageUniforms();
    this._time = 0;
    this._generation = 0;
    this._lodProps = {};
    this._stats = { instances: 0, chunks: 0, drawCalls: 0, triangles: 0, nearChunks: 0, midChunks: 0, impostorChunks: 0, culledChunks: 0, impostorReady: false, status: "Detached", colliders: 0 };
  }

  get stats() { return { ...this._stats }; }

  onAttach() {
    if (this.entity.engine._foliageModuleEnabled === false) return;
    if (this.root) this.onDetach();
    this._alive = true;
    this.root = new THREE.Group();
    this.root.name = "Foliage";
    // Keep ownership in the entity subtree for picking/framing while the
    // instance data and billboard shader remain explicitly in world space.
    this.root.matrixAutoUpdate = false;
    this.root.matrixWorldAutoUpdate = false;
    Object.assign(this.root.userData, { foliageOwned: true, entityId: this.entity.id });
    this.entity.object3D.add(this.root);
    const engine = this.entity.engine;
    this._unsub = [
      engine.onPreRender?.(() => this.update()),
      engine.on?.("component-changed", event => {
        if (!event || event.componentType === "foliage" || !geometrySourceKeys.has(event.key)) return;
        if (this._sourceIds?.has(event.entityId)) this._layoutDirty = true;
      }),
      engine.on?.("model-loaded", () => { this._checkSurface = true; }),
      engine.on?.("hierarchy-changed", () => { this._checkSurface = true; }),
      engine.on?.("component-added", () => { this._checkSurface = true; }),
      engine.on?.("component-removed", () => { this._checkSurface = true; }),
    ];
    this._shapeDirty = true;
    this._layoutDirty = true;
    this._resample = true;
    this._checkSurface = true;
    this.update(true);
  }

  onDetach() {
    this._alive = false;
    this._generation++;
    for (const unsub of this._unsub ?? []) unsub?.();
    this._unsub = [];
    this._disposeChunks();
    const oldGeometries = this.geometries;
    deferFoliageDisposal(this, () => { for (const geometry of oldGeometries ?? []) geometry.dispose(); });
    this.geometries = null;
    const oldMaterial = this.material; this.material = null;
    deferFoliageDisposal(this, () => oldMaterial?.dispose());
    const oldImpostorMaterial = this._impostorMaterial; this._impostorMaterial = null;
    deferFoliageDisposal(this, () => oldImpostorMaterial?.dispose());
    const oldAtlas = this._atlasEntry; this._atlasEntry = null;
    deferFoliageDisposal(this, () => releaseAtlas(oldAtlas));
    this.root?.removeFromParent(); this.root = null;
    this.instances = [];
    this._surfaceStamp = null;
    this._scatterResult = null;
    Object.assign(this._stats, { instances: 0, chunks: 0, drawCalls: 0, triangles: 0, impostorReady: false });
    this._stats.status = "Detached";
  }

  onDisable() { if (this.root) this.root.visible = false; }
  onEnable() { if (this.root) this.root.visible = true; }
  onPropChanged(key) {
    if (!this._alive) return;
    if (shapeKeys.has(key)) this._shapeDirty = true;
    if (placementKeys.has(key)) {
      this._layoutDirty = true;
      if (key !== "chunkSize") this._resample = true;
    }
    if (key === "surface" || key === "distribution") this._checkSurface = true;
    if (key === "castShadow" || key === "receiveShadow") {
      for (const mesh of this.renderMeshes) if (mesh) mesh[key] = !!this.props[key];
    }
    updateFoliageUniforms(this.uniforms, this.props, this._windTime ?? this._time, sceneWind(this.entity.engine));
    this._expandMotionBounds();
  }

  _expandMotionBounds() {
    const margin = this._motionMargin();
    if (margin <= (this._motionEnvelope ?? 0)) return;
    this._motionEnvelope = margin;
    for (const chunk of this.chunks) {
      const extra = Math.max(0, margin - chunk.motionMargin);
      if (!extra) continue;
      chunk.motionMargin = margin;
      chunk.bounds.expandByScalar(extra); chunk.sphere.radius += extra;
      for (const mesh of chunk.meshes.slice(0, 2)) {
        mesh.boundingBox.expandByScalar(extra); mesh.boundingSphere.radius += extra;
      }
      if (chunk.meshes[2]) {
        chunk.meshes[2].geometry.boundingSphere.copy(chunk.sphere);
        chunk.meshes[2].geometry.boundingBox.copy(chunk.bounds);
      }
    }
    this._batchDirty = true;
  }

  _resolveSurface() {
    if (this.props.distribution !== "scatter") return null;
    const engine = this.entity.engine;
    if (this.props.surface) return engine.getEntity?.(this.props.surface)?.object3D ?? null;
    if (this.entity.getComponent?.("terrain") || this.entity.getComponent?.("mesh") || this.entity.getComponent?.("model")) return this.entity.object3D;
    return this.entity.parent?.object3D ?? null;
  }

  _inspectSurface(source) {
    const stamps = [];
    this._sourceIds = new Set();
    const visit = object => {
      if (object.userData?.foliageOwned || object.userData?.batchProxy || object.userData?.mergeProxy || object.userData?.impostorQuad) return;
      const visible = object.visible !== false || !!object.userData?.batchedInto || !!object.userData?.mergedInto;
      stamps.push(`${object.uuid}:${visible}`);
      if (object.userData?.entityId) this._sourceIds.add(object.userData.entityId);
      if (object.isMesh && object.geometry?.attributes?.position) {
        object.updateWorldMatrix(true, false);
        const geometry = object.geometry;
        stamps.push(`${object.uuid}:${geometry.uuid}:${geometry.attributes.position.version}:${geometry.index?.version ?? 0}:${object.instanceMatrix?.version ?? 0}:${object.matrixWorld.elements.join(",")}`);
      }
      for (const child of object.children ?? []) visit(child);
    };
    if (source) visit(source);
    if (this.props.distribution === "single") {
      this.entity.object3D.updateWorldMatrix(true, false);
      stamps.push(this.entity.object3D.matrixWorld.elements.join(","));
    }
    return stamps.join("|");
  }

  _rebuildShape() {
    this._shapeDirty = false;
    this._generation++;
    this._disposeChunks();
    const oldGeometries = this.geometries;
    deferFoliageDisposal(this, () => { for (const geometry of oldGeometries ?? []) geometry.dispose(); });
    this.geometries = [createFoliagePrototype(this.props, 0), createFoliagePrototype(this.props, 1)];
    if (this.material && this._materialSpecies !== this.props.species) {
      const oldMaterial = this.material; this.material = null;
      deferFoliageDisposal(this, () => oldMaterial.dispose());
    }
    this.material ??= createFoliageMaterial(this.uniforms, this.props);
    this._materialSpecies = this.props.species;
    this.geometries[0].boundingBox.getSize(prototypeSize);
    this._prototypeSize = Math.max(prototypeSize.x, prototypeSize.y, prototypeSize.z);
    const oldImpostorMaterial = this._impostorMaterial; this._impostorMaterial = null;
    deferFoliageDisposal(this, () => oldImpostorMaterial?.dispose());
    const oldAtlas = this._atlasEntry; this._atlasEntry = null;
    deferFoliageDisposal(this, () => releaseAtlas(oldAtlas));
    this._layoutDirty = true;
  }

  _motionMargin() {
    let maxScale = Math.max(1, Number(this.props.minScale) || 1, Number(this.props.maxScale) || 1);
    if (this.props.distribution === "single") {
      this.entity.object3D.getWorldScale(scale);
      maxScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    }
    // The shader clamps blade curvature and tree joint angles, so this envelope
    // remains valid even when Scene wind changes sharply. Tree displacement
    // grows with limb length and world scale, not the old translation strength.
    const meadow = this.props.species === "grass" || this.props.species === "wildflowers";
    return 1 + (meadow ? 1.1 : .35) * (this._prototypeSize || Number(this.props.height) || 1) * maxScale;
  }

  _disposeChunks() {
    const renderMeshes = this.renderMeshes, chunks = this.chunks;
    this.renderMeshes = []; this.chunks = [];
    for (const mesh of renderMeshes) mesh?.removeFromParent();
    for (const chunk of chunks) for (const mesh of chunk.meshes) mesh?.removeFromParent();
    // A compiler may still hold an old render object after its async node build.
    // Withdraw it immediately, then release its captured resources when it exits.
    deferFoliageDisposal(this, () => {
      for (let lod = 0; lod < renderMeshes.length; lod++) {
        const mesh = renderMeshes[lod];
        if (!mesh) continue;
        if (lod === 2) mesh.geometry.dispose();
        mesh.dispose?.();
      }
      for (const chunk of chunks) for (let lod = 0; lod < chunk.meshes.length; lod++) {
        const mesh = chunk.meshes[lod];
        if (!mesh) continue;
        if (lod === 2) mesh.geometry.dispose();
        mesh.dispose?.();
      }
    });
    this._batchDirty = true;
  }

  _rebuildLayout(source) {
    this._layoutDirty = false;
    if (this.props.distribution === "single") {
      this.entity.object3D.updateWorldMatrix(true, false);
      this.entity.object3D.matrixWorld.decompose(position, quaternion, scale);
      this.instances = [{ position: position.toArray(), quaternion: quaternion.toArray(), normal: [0, 1, 0], scale: 1, matrix: this.entity.object3D.matrixWorld.clone() }];
    } else {
      const surface = source ? collectSurfaceTriangles(source, this.props) : null;
      let result = null;
      if (surface && !this._resample && this._scatterResult?.surface.topologyKey === surface.topologyKey) {
        const candidates = this._scatterResult.instances;
        const reseated = reseatFoliageInstances(surface, candidates);
        if (!reseated.invalid) result = { ...this._scatterResult, surface, instances: candidates };
      }
      if (!result && surface) result = scatterFoliage(surface, this.props);
      const exclusions = this.entity.engine.architecture?.snapshot();
      this.instances = exclusions ? (result?.instances ?? []).filter(instance => !exclusions.excludes(instance.position)) : result?.instances ?? [];
      this._scatterResult = result;
    }
    this._resample = false;
    const cellSize = foliageCellSize(this.props);
    const partition = partitionFoliage(this.instances, cellSize);
    const reuse = partition.length === this.chunks.length && partition.every((item, index) => item.key === this.chunks[index].key && item.instances.length === this.chunks[index].instances.length);
    if (reuse) {
      for (let index = 0; index < partition.length; index++) {
        const chunk = this.chunks[index];
        chunk.instances = partition[index].instances;
        chunk.bounds.makeEmpty();
        chunk.detailBounds.makeEmpty();
        for (let i = 0; i < chunk.instances.length; i++) chunk.meshes[0].setMatrixAt(i, chunk.instances[i].matrix ?? instanceMatrix(chunk.instances[i]));
        chunk.meshes[0].instanceMatrix.needsUpdate = true;
        for (const mesh of chunk.meshes.slice(0, 2)) {
          mesh.computeBoundingBox(); mesh.computeBoundingSphere();
          chunk.detailBounds.union(mesh.boundingBox);
          const margin = this._motionMargin();
          mesh.boundingSphere.radius += margin; mesh.boundingBox.expandByScalar(margin);
          chunk.bounds.union(mesh.boundingBox);
        }
        chunk.bounds.getBoundingSphere(chunk.sphere);
        this._measureChunkPlants(chunk);
        chunk.motionMargin = this._motionMargin();
        if (chunk.meshes[2]) this._writeImpostor(chunk, chunk.meshes[2].geometry);
      }
    } else this._disposeChunks();
    for (const item of reuse ? [] : partition) {
      const chunk = { ...item, meshes: [], level: -1, sphere: new THREE.Sphere(), bounds: new THREE.Box3(), detailBounds: new THREE.Box3(), motionMargin: this._motionMargin() };
      for (let lod = 0; lod < 2; lod++) {
        const mesh = tagMesh(new THREE.InstancedMesh(this.geometries[lod], this.material, item.instances.length), this.entity.id);
        mesh.name = `Foliage ${this.props.species} · LOD${lod} · ${item.key}`;
        mesh.castShadow = !!this.props.castShadow;
        mesh.receiveShadow = !!this.props.receiveShadow;
        if (lod === 0) {
          for (let i = 0; i < item.instances.length; i++) mesh.setMatrixAt(i, item.instances[i].matrix ?? instanceMatrix(item.instances[i]));
          mesh.instanceMatrix.needsUpdate = true;
        } else mesh.instanceMatrix = chunk.meshes[0].instanceMatrix;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        chunk.detailBounds.union(mesh.boundingBox);
        // Vertex motion must stay inside frustum/shadow culling bounds.
        const margin = this._motionMargin();
        mesh.boundingSphere.radius += margin;
        mesh.boundingBox.expandByScalar(margin);
        chunk.bounds.union(mesh.boundingBox);
        mesh.visible = lod === 0;
        chunk.meshes.push(mesh);
      }
      chunk.bounds.getBoundingSphere(chunk.sphere);
      this._measureChunkPlants(chunk);
      this.chunks.push(chunk);
    }
    if (this._atlasEntry?.atlas) this._buildImpostors();
    this._buildRenderBatches();
    this._batchDirty = true;
    this._stats.instances = this.instances.length;
    this._stats.chunks = this.chunks.length;
    this._stats.effectiveCellSize = cellSize;
    this._motionEnvelope = this._motionMargin();
    this._stats.status = this.instances.length ? "Ready" : "Choose a mesh or Terrain surface";
    this.entity.engine.emit?.("hierarchy-changed");
  }

  _measureChunkPlants(chunk) {
    let maxScale = 0;
    for (const instance of chunk.instances) {
      if (instance.matrix) {
        instance.matrix.decompose(position, quaternion, scale);
        maxScale = Math.max(maxScale, Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
      } else maxScale = Math.max(maxScale, instance.scale || 1);
    }
    chunk.plantSize = this._prototypeSize * maxScale;
  }

  _requestAtlas() {
    const engine = this.entity.engine;
    if (this._atlasEntry || !this.geometries || !this.chunks.length || !engine.renderer || engine.rendererReady === false || engine.impostors?.baking) return;
    const generation = this._generation;
    const entry = this._atlasEntry = acquireAtlas(engine.renderer, atlasKey(this.props), this.geometries[0], this.props);
    entry.promise.then(() => {
      if (!this._alive || this._generation !== generation || this._atlasEntry !== entry) return;
      if (entry.error) { this._stats.status = `Impostor unavailable: ${entry.error}`; return; }
      this._buildImpostors();
      this.entity.engine.emit?.("hierarchy-changed");
    });
  }

  _buildImpostors() {
    const entry = this._atlasEntry;
    if (!entry?.atlas || !this.root) return;
    if (!this._impostorMaterial) {
      this._impostorMaterial = entry.material.clone();
      // Three r185 NodeMaterial.copy misses Material's inherited alphaTest
      // accessor. Without this, a wind-enabled clone draws the empty atlas
      // background as an opaque black rectangle.
      this._impostorMaterial.alphaTest = entry.material.alphaTest;
      setupFoliageImpostorMaterial(this._impostorMaterial, this.uniforms, this.props);
    }
    for (const chunk of this.chunks) {
      if (chunk.meshes[2]) continue;
      const geometry = createImpostorGeometry(chunk.instances.length);
      this._writeImpostor(chunk, geometry);
      const mesh = tagMesh(new THREE.Mesh(geometry, this._impostorMaterial), this.entity.id);
      mesh.userData.impostorQuad = true;
      mesh.raycast = (raycaster, intersections) => chunk.meshes[0].raycast(raycaster, intersections);
      mesh.name = `Foliage ${this.props.species} · Impostor · ${chunk.key}`;
      mesh.castShadow = !!this.props.castShadow;
      mesh.receiveShadow = !!this.props.receiveShadow;
      mesh.visible = false;
      chunk.meshes.push(mesh);
    }
    this._buildRenderBatches();
    this._batchDirty = true;
  }

  /** Spatial chunks choose detail, while only three shared meshes submit it.
   * Separate draw objects per tiny grass cell cost more CPU than their blades
   * cost GPU time, and each InstancedMesh also creates a shader variant. */
  _buildRenderBatches() {
    if (!this.root || !this.instances.length) return;
    for (let lod = 0; lod < 3; lod++) {
      if (this.renderMeshes[lod] || (lod === 2 && !this._impostorMaterial)) continue;
      const mesh = lod === 2
        ? new THREE.Mesh(createImpostorGeometry(this.instances.length), this._impostorMaterial)
        : new THREE.InstancedMesh(this.geometries[lod], this.material, this.instances.length);
      tagMesh(mesh, this.entity.id);
      mesh.name = `Foliage ${this.props.species} · batch LOD${lod}`;
      mesh.castShadow = !!this.props.castShadow; mesh.receiveShadow = !!this.props.receiveShadow;
      mesh.visible = false;
      // Three uploads DynamicDrawUsage on every render pass, even when its
      // version has not changed. Placements change only on an explicit repack;
      // both Three's Instance node and our wind reader mirror that version.
      if (lod < 2) { mesh.count = 0; mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage); }
      else {
        mesh.userData.impostorQuad = true;
        mesh.geometry.instanceCount = 0;
        for (const key of ["aCenter", "aSize", "aAxisX", "aAxisY"]) mesh.geometry.attributes[key].setUsage(THREE.StaticDrawUsage);
        mesh.raycast = (raycaster, intersections) => {
          for (const chunk of this.chunks) if (chunk.level === 2) chunk.meshes[0].raycast(raycaster, intersections);
        };
      }
      this.renderMeshes[lod] = mesh; this.root.add(mesh);
    }
  }

  /** Upload only when the selected chunk set changes, never for wind or camera
   * rotation. Whole typed-array ranges copy without touching individual plants.
   * Offscreen selected chunks stay present so their shadows remain correct. */
  _commitBatches() {
    this._batchDirty = false;
    for (let lod = 0; lod < this.renderMeshes.length; lod++) {
      const mesh = this.renderMeshes[lod];
      if (!mesh) continue;
      const bounds = lod === 2 ? (mesh.geometry.boundingBox ??= new THREE.Box3()) : (mesh.boundingBox ??= new THREE.Box3());
      bounds.makeEmpty(); let count = 0;
      for (const chunk of this.chunks) {
        if (chunk.level !== lod) continue;
        const source = chunk.meshes[lod];
        if (!source) continue;
        bounds.union(chunk.bounds);
        if (lod < 2) mesh.instanceMatrix.array.set(source.instanceMatrix.array, count * 16);
        else for (const key of ["aCenter", "aSize", "aAxisX", "aAxisY"]) {
          const destination = mesh.geometry.attributes[key];
          destination.array.set(source.geometry.attributes[key].array, count * destination.itemSize);
        }
        count += chunk.instances.length;
      }
      mesh.visible = count > 0;
      if (lod < 2) {
        mesh.count = count;
        mesh.instanceMatrix.clearUpdateRanges();
        if (count) mesh.instanceMatrix.addUpdateRange(0, count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        bounds.getBoundingSphere(mesh.boundingSphere ??= new THREE.Sphere());
      } else {
        mesh.geometry.instanceCount = count;
        for (const key of ["aCenter", "aSize", "aAxisX", "aAxisY"]) {
          const attribute = mesh.geometry.attributes[key];
          attribute.clearUpdateRanges();
          if (count) attribute.addUpdateRange(0, count * attribute.itemSize);
          attribute.needsUpdate = true;
        }
        bounds.getBoundingSphere(mesh.geometry.boundingSphere);
      }
    }
  }

  _writeImpostor(chunk, geometry) {
      const entry = this._atlasEntry;
      const attrs = geometry.attributes;
      for (let i = 0; i < chunk.instances.length; i++) {
        const instance = chunk.instances[i];
        const transform = instance.matrix ?? instanceMatrix(instance);
        transform.decompose(position, quaternion, scale);
        position.copy(entry.atlas.center).applyMatrix4(transform);
        axisX.set(1, 0, 0).applyQuaternion(quaternion);
        axisY.set(0, 1, 0).applyQuaternion(quaternion);
        attrs.aCenter.setXYZ(i, position.x, position.y, position.z);
        attrs.aSize.setX(i, entry.atlas.radius * 2 * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)));
        attrs.aAxisX.setXYZ(i, axisX.x, axisX.y, axisX.z);
        attrs.aAxisY.setXYZ(i, axisY.x, axisY.y, axisY.z);
      }
      geometry.instanceCount = chunk.instances.length;
      for (const attribute of Object.values(attrs)) attribute.needsUpdate = true;
      geometry.boundingSphere.copy(chunk.sphere);
      geometry.boundingBox = chunk.bounds.clone();
  }

  /** Public for diagnostic fixtures; normally driven by Engine.onPreRender. */
  update(force = false) {
    if (!this._alive || !this.root) return;
    const engine = this.entity.engine;
    this.reconcileEnabled();
    this.root.visible = this.enabled && visibleEntity(this.entity, engine.playing);
    if (!this.root.visible || engine.simulationSuspended === true) return;
    // `_time` is the component's general timer (surface-check cadence,
    // interactions) — it always advances. The WIND clock is `_windTime` below,
    // and THAT is what "Run In Editor" freezes.
    this._time += Math.min(.1, Math.max(0, Number(engine.deltaTime) || 0));
    const source = this._resolveSurface();
    const architecture = engine.architecture?.snapshot();
    const architectureStamp = architecture?.revision ?? -1;
    if (this._architectureStamp !== architectureStamp) {
      this._architectureStamp = architectureStamp;
      if (this.props.distribution === "scatter") this._layoutDirty = true;
    }
    if (force || this._checkSurface || this._time - (this._lastSurfaceCheck ?? -Infinity) > .15) {
      this._checkSurface = false;
      this._lastSurfaceCheck = this._time;
      const stamp = this._inspectSurface(source);
      if (stamp !== this._surfaceStamp || source !== this._surfaceRoot) this._layoutDirty = true;
      this._surfaceStamp = stamp;
      this._surfaceRoot = source;
    }
    // A newly painted layer joins the same moving gust field as older layers.
    // Engine elapsed time is already pause/time-scale aware and hitch clamped.
    // "Run In Editor" freezes the WIND by holding this clock: the sway is
    // f(windTime, …), so a held windTime is a static snapshot. Advance it only
    // when animating; seed it once if never set so the shader never sees NaN.
    const foliageAnimating = this.shouldAnimate;
    if (foliageAnimating || this._windTime == null) {
      this._windTime = Number.isFinite(engine.elapsedTime) ? engine.elapsedTime : this._time;
    }
    // Tell shadowFreeze the foliage is a STATIC caster while its wind clock is
    // held: the vertex shader displaces off a frozen time, so the shadow is
    // constant and the map can freeze at rest. `vfxSimulation` stays set (GI
    // keeps foliage out of the static BVH, physics skips it); only this extra
    // hint changes. Set every frame so LOD chunks streamed in later inherit it.
    for (const mesh of this.renderMeshes) { if (mesh?.userData) mesh.userData.vfxStatic = !foliageAnimating; }
    updateFoliageUniforms(this.uniforms, this.props, this._windTime, sceneWind(engine));
    try {
      if (this._shapeDirty) this._rebuildShape();
      if (this._layoutDirty) this._rebuildLayout(source);
    } catch (error) {
      this._shapeDirty = this._layoutDirty = false;
      this._stats.status = `Foliage: ${error?.message ?? String(error)}`;
      return;
    }
    this._expandMotionBounds();
    const camera = engine.camera;
    if (camera) camera.getWorldPosition(cameraPosition); else cameraPosition.set(0, 0, 0);
    this._stats.colliders = updateFoliageInteractions(engine, this.uniforms, cameraPosition, this._time, this.props.interaction);
    this._requestAtlas();
    const impostorReady = !!this._atlasEntry?.atlas;
    Object.assign(this._stats, { drawCalls: 0, triangles: 0, vertices: 0, nearChunks: 0, midChunks: 0, impostorChunks: 0, culledChunks: 0, impostorReady });
    viewportSize.set(0, 0);
    engine.renderer?.getDrawingBufferSize?.(viewportSize);
    const projectionScale = camera?.isPerspectiveCamera && viewportSize.y > 0 ? viewportSize.y * Math.abs(camera.projectionMatrix.elements[5]) * .5 : 0;
    for (const chunk of this.chunks) {
      const distance = chunk.detailBounds.distanceToPoint(cameraPosition);
      foliageDetailDistances(this.props, projectionScale, chunk.plantSize, this._lodProps);
      const previous = chunk.level;
      chunk.level = foliageLodLevel(distance, chunk.level, this._lodProps, impostorReady);
      if (previous !== chunk.level) this._batchDirty = true;
      this._stats[levelNames[chunk.level]]++;
      for (let i = 0; i < chunk.meshes.length; i++) chunk.meshes[i].visible = i === chunk.level;
      if (chunk.level < 3) {
        const geometry = chunk.meshes[chunk.level]?.geometry;
        this._stats.triangles += ((geometry?.index?.count ?? geometry?.attributes.position.count ?? 0) / 3) * chunk.instances.length;
        this._stats.vertices += (geometry?.attributes.position.count ?? 0) * chunk.instances.length;
      }
    }
    if (this._batchDirty) this._commitBatches();
    this._stats.drawCalls = this.renderMeshes.reduce((sum, mesh) => sum + (mesh?.visible ? 1 : 0), 0);
    updateFoliageWarmup(this);
  }
}
