import * as THREE from "three/webgpu";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";
import {
  instancedBufferAttribute,
  vertexStage,
  mix,
  vec3,
  vec4,
  Fn,
  If,
  uniform,
  texture,
  screenUV,
  positionWorld,
  normalWorld,
} from "three/tsl";
import { createDeferredGI, createDeferredGISampler } from "./giDeferred.js";
import { QUALITY_PRESETS } from "./GlobalIlluminationComponent.js";
import { createSunShadowNode } from "./dfShadows.js"; // voxel-cone fallback (unused by default)
import { MeshSDFShadows, createMeshSDFSunShadowNode } from "./meshSDF.js";
import { CapsuleShadows, collectSkinnedMeshes } from "./capsuleShadows.js";
import {
  TriangleRayScene,
  clearRayProxyCache,
  RAY_BVH_NODE_STRIDE,
  RAY_GPU_DATA_CAPACITY_VEC4,
} from "./rayProxy.js";
import {
  computeGrid,
  voxelizeRegionAsync,
  forEachVoxelizableMesh,
  readMeshGIColors,
  EMISSIVE_SCALE,
  markExteriorEmptyVoxelsAsync,
  reclassifyAmbiguousRegion,
  shiftGrid,
  EXTERIOR_EMPTY_BIT,
  AMBIGUOUS_NORMAL_BIT,
} from "./voxelizer.js";
import { DynamicVoxelPool, createDynamicVoxelNodes } from "./gpuVoxelizer.js";
import {
  createGINodes,
  computeMipLevels,
  fibonacciDirections,
  octaTexelDirections,
  GIProbeVolumeLight,
  GIProbeVolumeLightNode,
  RAYS_PER_PROBE,
  OCTA_RES,
  MAX_LOCAL_LIGHTS,
} from "./giCompute.js";

// Debounce between a scene change and the (synchronous, CPU) re-voxelize.
// Batches bursts of hierarchy events (model load spawning many entities)
// while staying short enough that a dragged object re-lights promptly.
const REVOXELIZE_DELAY_MS = 120;

// Frames between transform-hash polls. Entity moves don't emit an engine
// event, so the system fingerprints voxelizable meshes' world matrices —
// this is what makes dragging an object update its GI.
const TRANSFORM_POLL_FRAMES = 1;
const SETTLE_POLL_COUNT = Math.ceil(60 / TRANSFORM_POLL_FRAMES);
const EMISSION_POLL_FRAMES = 6;

// Each cascade covers 4× the world size of the previous one (so 3 cascades
// span 16× the base volume) at coarser voxels — probe density falls off
// with distance while nearby GI stays sharp.
const CASCADE_SCALE = 4;
const AUTO_INNER_REACH = 8;
const AUTO_MAX_CASCADES = 3;
const AUTO_MAX_REACH = 128;
const AUTO_COVERAGE_MARGIN = 1.2;
// Four sweeps at the active-work hysteresis cap below retain under 1.6% of
// stale history. The former six-sweep window made edits take 3-5 seconds in a
// three-cascade scene even though the inner volume had already changed.
const CONVERGENCE_SWEEPS = 4;
const RECENTER_SWEEPS = 2;
const LIGHT_CONVERGENCE_SWEEPS = 6;

// Snappy convergence for cascades that currently contain a moving object.
// The visible EMA time constant is `lightingResponse` (default 0.5 s), giving
// ~1.8 s to settle — measured as the dominant term behind the "light lags
// several seconds after I move something" complaint. While a mover is present
// (and briefly after it settles) the inner cascade drops to this much shorter
// constant so bounce/AO track the object in ~0.3 s. The eye is following the
// mover then and tolerates the extra temporal noise; static scenes are
// untouched and keep the smooth default. GRACE keeps the fast response alive
// across the settle transition so convergence doesn't visibly stall the moment
// the dynamic gate releases and the volume falls back to round-robin.
const DYNAMIC_RESPONSE_SECONDS = 0.12;
const DYNAMIC_GRACE_FRAMES = 45;
// Extra probe windows per frame while a mover is present, to converge the
// multi-bounce field faster. Kept low (1) by default: higher values refresh
// the noisy 64-ray probes more often and flicker on moving objects. The
// Quality tier opts into a mild 2×; a proper fast+smooth path needs probe
// denoising, not just more sweeps. Custom mode uses this default.
const PROBE_MOTION_SWEEPS = 1;


/** Matches Object3D's rendered visibility, including hidden ancestors. */
function isEffectivelyVisible(object) {
  for (let current = object; current; current = current.parent) {
    if (current.visible === false) return false;
  }
  return true;
}

function createProbeLayout(probesPerFrame, probeCount) {
  const texelCount = probeCount * OCTA_RES * OCTA_RES;
  const rays = 0;
  const irradiance = rays + probesPerFrame * RAYS_PER_PROBE;
  const visibility = irradiance + texelCount;
  const irradianceScratch = visibility + texelCount;
  const visibilityScratch = irradianceScratch + texelCount;
  const rayDirs = visibilityScratch + texelCount;
  const texelDirs = rayDirs + RAYS_PER_PROBE;
  const total = texelDirs + OCTA_RES * OCTA_RES;
  return {
    rays,
    irradiance,
    visibility,
    irradianceScratch,
    visibilityScratch,
    rayDirs,
    texelDirs,
    total,
  };
}

// One library registration per renderer instance (renderer rebuilds swap
// `renderer.library`, so this can't be a boolean).
const wiredLibraries = new WeakSet();

/**
 * Projection-derived nested clipmap layout. Each cube is centered on the
 * camera position and encloses the full frustum segment out to `reach`.
 * Rotation therefore never scrolls/revoxelizes the world representation.
 */
export function computeAutoClipmapLayout(camera) {
  // GI beyond this range contributes no useful local detail but previously
  // forced an extra 2-km editor cascade (and all of its buffers/pipelines).
  const far = Math.min(
    AUTO_MAX_REACH,
    Math.max(1, Number.isFinite(camera?.far) ? camera.far : 128),
  );
  let cascadeCount = 1;
  while (
    cascadeCount < AUTO_MAX_CASCADES &&
    AUTO_INNER_REACH * CASCADE_SCALE ** (cascadeCount - 1) < far
  ) {
    cascadeCount++;
  }

  const outerScale = CASCADE_SCALE ** (cascadeCount - 1);
  const baseReach = Math.max(AUTO_INNER_REACH, far / outerScale);
  // Reserve a standard ultrawide-safe horizontal field so dock resizing and
  // dynamic resolution never require reallocating the GI clipmaps.
  const rawAspect = Math.min(
    4,
    Math.max(2.2, camera?.aspect || 16 / 9),
  );
  // Stable coverage buckets prevent dock/viewport resizing from repeatedly
  // reallocating every GI cascade while still reserving enough horizontal
  // coverage for the whole bucket.
  const aspect =
    rawAspect <= 2.2 ? 2.2 : rawAspect <= 3 ? 3 : 4;
  const perspective = camera?.isPerspectiveCamera !== false;
  const fov = Math.min(120, Math.max(1, camera?.fov || 60));
  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(fov * 0.5));
  const orthoHalfW = perspective
    ? 0
    : Math.abs((camera?.right ?? 1) - (camera?.left ?? -1)) /
      (2 * Math.max(camera?.zoom || 1, 1e-4));
  const orthoHalfH = perspective
    ? 0
    : Math.abs((camera?.top ?? 1) - (camera?.bottom ?? -1)) /
      (2 * Math.max(camera?.zoom || 1, 1e-4));

  const layouts = [];
  for (let idx = 0; idx < cascadeCount; idx++) {
    const scale = CASCADE_SCALE ** idx;
    const reach = baseReach * scale;
    // A clipmap is a world-space DETAIL tier, not a container for the entire
    // frustum slice. Enclosing the ultrawide frustum made the nominal 64^3
    // inner volume ~50 m wide (0.75-0.8 m voxels): both faces of ordinary
    // walls collapsed into one cell, their normal became arbitrary, and a
    // visibly lit red wall injected no bounce. Keep the dense tier local;
    // nested outer cascades cover pixels beyond it.
    const perspectiveHalfSpan = perspective
      ? reach
      : Math.max(reach, orthoHalfW, orthoHalfH);
    const radius = perspectiveHalfSpan * AUTO_COVERAGE_MARGIN;
    const diameter = Math.max(2, radius * 2);
    layouts.push({
      idx,
      scale,
      reach,
      forwardOffset: 0,
      size: new THREE.Vector3(diameter, diameter, diameter),
    });
  }
  return layouts;
}

/**
 * Runtime for the GI module: owns 1–3 camera-derived clipmap volumes (voxel grid,
 * probe buffers, compute passes each) and the scene light that feeds their
 * blended cone-traced lighting into materials. Driven by one active
 * GlobalIlluminationComponent at a time (last enabled wins).
 */
export class GISystem {
  constructor(engine) {
    this.engine = engine;
    this.component = null; // active GlobalIlluminationComponent
    // Cascade volumes, innermost first. Each is a self-contained clipmap:
    // { grid, counts, nodes, buffers, atlas, radianceAtlas, center,
    //   spacingVox, spacingWorld, probesPerFrame, baseProbe, voxelJob }
    this.volumes = [];
    this.light = null; // GIProbeVolumeLight currently in the scene
    this.debugMesh = null;
    this._shadowDebugMaterial = null;
    this.stats = { occupied: 0, meshes: 0, tris: 0, voxelMs: 0 };
    this._voxelsDirtyAt = 0; // 0 = clean, else timestamp of the dirtying event
    // A structural change (mesh added/removed, geometry/terrain swap) needs a
    // full-scene re-bake; a settled object move only needs its footprint
    // re-baked. _dirtyBoxes accumulates the world-space AABBs (old + new pose)
    // of settled movers so the debounced handler can rebake just those regions
    // instead of rescanning every triangle in the scene.
    this._structuralDirty = false;
    this._dirtyBoxes = [];
    // Signature of the voxelizable mesh SET (identity/geometry/material — NOT
    // transform). `hierarchy-changed` fires on every Component.setProp (for the
    // React mirror) and editor noise (autosave, async material reloads), so
    // treating each one as structural forced a ~200 ms full re-voxelize on
    // every move/edit. We only mark structural when this signature actually
    // changes (mesh added/removed, geometry or material swapped).
    this._meshSetSignature = null;
    this._rebuildQueued = false;
    this._frame = 0;
    this._deltaTime = 1 / 60;
    this._debugView = "off";
    this._voxelDebugGeneration = 0;
    // Per-mesh motion tracking. A transform change promotes the mesh to the
    // GPU dynamic layer immediately; waiting for several polls first caused
    // editor drags to launch expensive CPU rebuilds before classification.
    this._motion = new WeakMap(); // mesh -> { h, moving, still, dynamic }
    // GPU dynamic layer: shared triangle pool for meshes flagged dynamic, and
    // a per-volume "sees dynamics this frame" mask computed each tick.
    this._dynPool = null;
    this._dynActive = [];
    this._dynSynced = false;
    this._dynamicSetDirty = true;
    this._dynamicObjectsEnabled = null;
    // Direct visibility stays on Three's real-time shadow-map path. GI uses
    // one radius-aware PCF mode for every shadow-casting light and remembers
    // the renderer/light settings it temporarily overrides.
    this._shadowPatch = null;
    this._sceneHashReady = false;
    this._sun = { entity: null, stale: true };
    this._emissiveSources = [];
    this._emissiveSourceHash = null;
    this._emissiveSourcesDirty = true;
    this._localLights = [];
    this._localLightsDirty = true;
    this._layoutKey = "";
    this._cameraRef = null;
    this._voxelizeGeneration = 0;
    this._voxelizePromise = null;
    this._ambientSuppressed = false;
    this._ambientRestoreIntensity = null;
    this._deferred = null;
    this._deferredUniforms = null;
    this._deferredReady = null;
    this._giTextureNode = null;
    this._giDepthNode = null;
    this._giNormalNode = null;
    this._deferredSampleFn = null;
    this._deferredViewportKey = "";
    this._dfShadowReady = null;
    this._dfSunShadowNode = null;
    this._dfShadowUniforms = null;
    this._dfShadowVolumes = null;
    // Per-mesh SDF shadow state: bake cache + atlas persist for the session,
    // the candidate list refreshes on the motion-poll cadence.
    this._meshShadows = null;
    this._meshShadowList = null;
    this._capsuleShadows = null;
    this._skinnedList = null;
    // Stage 1 triangle proxy scene. It is completely dormant by default and
    // does not alter GI until the Stage 2 probe tracer explicitly consumes
    // its packed buffer.
    this._rayScene = null;
    this._raySceneBuild = null;
    this._raySceneSignal = null;
    this._raySceneDirty = true;
    this._rayBuffer = null;
    this._rayDataReady = false;
    this._rayLayout = null;
    this._rayUploadedTopologyVersion = -1;
    this._rayUploadedTransformVersion = -1;
    this._rayCapacityWarned = false;
    this._rayModeActive = false;
    this._workCursor = 0;

    this._offTick = engine.onUpdate((dt) => this.#tick(dt));
    // The deferred prepass runs in the pre-render phase, NOT here in update:
    // it renders the scene to build the screen-space GI the main draw samples,
    // so it must execute after physics/scripts write this frame's transforms.
    // Running it in onUpdate could beat physics to the character's new pose,
    // desyncing the GI from the main render (moving objects shimmer).
    this._offPreRender = engine.onPreRender(() => this.#runDeferred());
    this._offHier = engine.on("hierarchy-changed", () => {
      // Only re-voxelize if the mesh set actually changed — hierarchy-changed
      // also fires for every prop edit / autosave, and treating those as
      // structural was the ~200 ms full-rebuild-on-every-move spike.
      if (this.#markStructuralIfMeshSetChanged()) this.markRayProxiesDirty();
      this._sun.stale = true;
      this._emissiveSourcesDirty = true;
      this._localLightsDirty = true;
      this._dynamicSetDirty = true;
      // A mesh added after GI init has a material that never got the GI
      // light node — the "black until I move it" surfaces. Mark only new
      // materials (WeakSet-deduped) so this is cheap and spike-free.
      if (this.light) this.#invalidateLitMaterials();
    });
    // Re-voxelize when a mesh/model/terrain finishes loading or changes —
    // hierarchy-changed alone misses async geometry swaps.
    this._offComp = engine.on("component-changed", ({ componentType }) => {
      this._emissiveSourcesDirty = true;
      this._localLightsDirty = true;
      this._dynamicSetDirty = true;
      if (componentType === "mesh" || componentType === "model" || componentType === "terrain") {
        // Same gate: a mesh/model component-changed that didn't actually swap
        // geometry/material (e.g. a transform or unrelated prop) must not force
        // a full re-voxelize.
        if (this.#markStructuralIfMeshSetChanged()) this.markRayProxiesDirty();
        // Async geometry/material swaps bring new materials; give them the
        // GI node without waiting for the user to move the object.
        if (this.light) this.#invalidateLitMaterials();
      }
      if (componentType === "light") {
        this._sun.stale = true;
        this._localLightsDirty = true;
      }
    });
    this._offVirtualGeometry = engine.on("virtual-geometry-ready", () => {
      // The mesh was previously backed by an empty live draw range. Rebuild
      // its static voxels from the now-available camera-independent root cut.
      this.markVoxelsDirty();
      this.markRayProxiesDirty();
    });
    this._offVirtualGeometryChanged = engine.on("virtual-geometry-changed", () =>
      this.markRayProxiesDirty(),
    );
    this._offPlay = engine.on("play-changed", () => {
      this.markRayProxiesDirty();
    });
    this._offRenderer = engine.on("renderer-rebuilt", () => this.queueRebuild());
    // Editor gizmos can report the changed root immediately. Physics/scripts
    // still use the per-frame matrix poll, but editor lighting no longer waits
    // for an indirect hierarchy/component event or a background static bake.
    this._offTransform = engine.on("transform-changed", () => {
      // NOT force=true: forcing recompute of the WHOLE scene every frame of a
      // drag overwrote the baked matrices of matrixAutoUpdate=false objects
      // (imported models), so the poll saw ALL meshes "move" and promoted every
      // one to dynamic — an empty voxelize (all skipped) + a full-rebuild spike
      // on every move. A plain update still refreshes the moved (auto-update)
      // object, which is all the poll needs.
      this.engine.scene.updateMatrixWorld();
      this._localLightsDirty = true;
      if (this.#pollMotion()) {
        this._sceneHashReady = true;
        this._voxelsDirtyAt = performance.now();
      }
      this.#syncDynamicPool();
    });
  }

  /** Called by the component on attach/enable. Last activation wins. */
  activate(component) {
    this.component = component;
    this.queueRebuild();
  }

  deactivate(component) {
    if (this.component !== component) return;
    this.component = null;
    this.#teardownSceneObjects();
  }

  /** Structural prop changed (grid shape) — rebuild everything next tick. */
  queueRebuild() {
    this._rebuildQueued = true;
  }

  /**
   * Effective quality knobs. A `quality` preset ("performance"/"balanced"/
   * "quality") wins; "custom" (or unset) falls back to the individual advanced
   * props so power users keep full control.
   */
  #qualityParams() {
    const p = this.component?.props ?? {};
    const preset = QUALITY_PRESETS[p.quality];
    if (preset) return preset;
    return {
      voxelRes: Math.max(16, Math.min(160, Math.round(p.voxelRes) || 64)),
      giResScale: Math.min(1, Math.max(0.25, p.giResScale ?? 0.5)),
      probesPerFrame: Math.max(16, Math.round(p.probesPerFrame || 256)),
      coneSteps: p.coneSteps ?? 8,
      probeMotionSweeps: PROBE_MOTION_SWEEPS,
      realtimeInject: p.realtimeLighting === true,
      reflections: p.reflections !== false,
    };
  }

  /** Scene content changed — re-voxelize (debounced) without reallocating. */
  markVoxelsDirty() {
    this._structuralDirty = true;
    this._voxelsDirtyAt = performance.now();
  }

  /**
   * Signature of everything about the voxelizable mesh set that affects the
   * static bake — identity, geometry, draw range, material — but deliberately
   * NOT transform (moves go through the incremental/dynamic path). Cheap string
   * build, orders of magnitude cheaper than the full re-voxelize it prevents.
   */
  #voxelizableMeshSignature() {
    const parts = [];
    forEachVoxelizableMesh(this.engine.scene, (mesh) => {
      const geo = mesh.geometry;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      parts.push(
        `${mesh.uuid}:${geo?.id ?? 0}:${geo?.getAttribute?.("position")?.version ?? 0}:` +
          `${geo?.drawRange?.start ?? 0}:${geo?.drawRange?.count ?? -1}:${mat?.uuid ?? 0}`,
      );
    });
    parts.sort();
    return parts.join("|");
  }

  /**
   * Marks a structural re-voxelize ONLY when the mesh set genuinely changed.
   * `hierarchy-changed`/`component-changed` fire constantly for prop edits,
   * autosaves and async material reloads — none of which change what needs to
   * be voxelized — so gating on the signature is what stops the per-edit and
   * per-move full-rebuild spikes.
   */
  #markStructuralIfMeshSetChanged() {
    const sig = this.#voxelizableMeshSignature();
    if (sig === this._meshSetSignature) return false;
    this._meshSetSignature = sig;
    this._structuralDirty = true;
    this._voxelsDirtyAt = performance.now();
    return true;
  }

  /** Live environment/GI parameters changed without requiring reallocation. */
  markLightingDirty() {
    for (const vol of this.volumes) {
      this.#requestConvergence(vol, LIGHT_CONVERGENCE_SWEEPS);
    }
  }

  /** Invalidates only the opt-in Stage-1 triangle proxy scene. */
  markRayProxiesDirty() {
    this._raySceneDirty = true;
    this._rayDataReady = false;
    if (this._raySceneSignal) this._raySceneSignal.cancelled = true;
  }

  // ---- lifecycle -----------------------------------------------------------

  #rebuild() {
    this._rebuildQueued = false;
    this.#teardownSceneObjects();
    this._workCursor = 0;
    const c = this.component;
    if (!c) return;
    const p = c.props;
    if (
      p.rayProxies === true
    ) {
      if (!this._rayBuffer) {
        this._rayBuffer = new THREE.StorageBufferAttribute(
          new Float32Array(RAY_GPU_DATA_CAPACITY_VEC4 * 4),
          4,
        );
        this._rayUploadedTopologyVersion = -1;
        this._rayUploadedTransformVersion = -1;
        this._rayLayout = null;
        this._rayDataReady = false;
      }
    } else {
      this.#releaseStorageAttribute(this._rayBuffer);
      this._rayBuffer = null;
      clearRayProxyCache();
      this._rayLayout = null;
      this._rayDataReady = false;
      this._rayUploadedTopologyVersion = -1;
      this._rayUploadedTransformVersion = -1;
    }

    const camera = this.engine.camera;
    const layouts = computeAutoClipmapLayout(camera);
    this._cameraRef = camera;
    this._layoutKey = this.#cameraLayoutKey(camera);
    for (const layout of layouts) {
      this.#targetPosition(_worldPos);
      this.volumes.push(this.#buildVolume(p, layout.idx, _worldPos, layout));
    }
    this.#buildDeferred();

    // Diffuse GI is evaluated once in the half-resolution deferred compute
    // pass. Materials perform only four edge-aware reconstruction samples;
    // the expensive 3D cone trace is no longer duplicated for every lit
    // fragment and every overdraw layer.
    const reflections = this.#qualityParams().reflections;
    const specNodes = this.volumes[0].nodes;
    const volumes = this.volumes;
    const outerU = volumes[volumes.length - 1].nodes.uniforms;
    const combinedDiffuse = Fn(() =>
      // The persistent deferred texture is initialized black and written in
      // place. Sampling it unconditionally avoids compiling a ready=0 branch
      // into cached WebGPU render bundles that only refreshed after orbiting
      // the camera. Before the first compute pass this naturally returns zero.
      this._deferredSampleFn(positionWorld, normalWorld, screenUV),
    );

    // Only the inner cascade traces reflections (lite cascades opt out) —
    // a single cone, roughness-driven.
    const combinedSpecular =
      reflections && specNodes.createSpecularSampler
        ? Fn(() => {
            const result = vec3(0).toVar();
            const fade = specNodes.createFadeNode().toVar();
            If(fade.greaterThan(0.001), () => {
              result.assign(specNodes.createSpecularSampler().mul(fade));
            });
            return result;
          })
        : null;

    // Fresh light instance on purpose: the lights hash changes, so every lit
    // material recompiles against the NEW sampler nodes (an in-place factory
    // swap would leave built shaders pointing at freed buffers).
    this.light = new GIProbeVolumeLight();
    this.light.giFactories = {
      diffuse: () => combinedDiffuse(),
      specular: combinedSpecular ? () => combinedSpecular() : null,
    };
    this.engine.scene.add(this.light);
    // Materials (notably the shared default white material) may already have
    // a cached render bundle compiled before the custom GI light type was
    // registered. Camera motion happened to invalidate that bundle, making
    // GI appear only after the user moved. Bump every lit material version
    // now so the stationary first frame compiles against the current light
    // set and GI library.
    this.#invalidateLitMaterials(true);
    // Re-arm the radiance-ready + bounded deferred-resync so materials
    // recompile again once the freshly rebuilt volumes produce GI output.
    this._radianceMaterialsSynced = false;
    this._deferredResyncCount = 0;
    this._deferredResyncFrame = undefined;

    this._structuralDirty = true;
    this._voxelsDirtyAt = 1; // voxelize on the next tick (already "overdue")
    this._debugView = p.debugView ?? (p.debugProbes ? "probes" : "off");
    if (this._debugView !== "off") this.#buildDebugMesh();
  }

  /** Builds one cascade volume. `idx` 0 is the innermost/densest. */
  #buildVolume(p, idx, target, layout) {
    const q = this.#qualityParams();
    const scale = layout.scale;
    const size = layout.size.clone();
    const baseRes = q.voxelRes;
    // Outer cascades drop resolution — their voxels are 4× larger anyway,
    // and this keeps the added GPU cost of a cascade well under 1×.
    const res =
      idx === 0 ? baseRes : Math.max(32, Math.round(baseRes * 0.5));

    // Probe spacing snapped to a whole number of voxels: clipmap recenter
    // shifts must move probes by integer indices AND voxels by integer
    // cells, so the recenter quantum is one probe spacing.
    const voxelSize = Math.max(size.x, size.y, size.z, 1e-3) / res;
    let spacingVox = Math.max(
      1,
      Math.round(((p.probeSpacing || 1.5) * scale) / voxelSize),
    );
    // Probe irradiance is only the low-frequency multi-bounce feedback; the
    // visible first bounce comes from the full voxel radiance cone trace.
    // Bound the probe lattice aggressively in outer cascades to avoid the
    // previous 20k-probe volumes (large atlas/buffer memory, slow convergence)
    // while retaining dense near-field feedback.
    // Both outer cascades deliberately use the same shape. Besides being
    // sufficient for low-frequency feedback, identical dims/counts let Three
    // reuse their WGSL programs/pipelines instead of retaining a second full
    // set of near-identical driver objects.
    const probeAxisBudget = idx === 0 ? 18 : 4;
    spacingVox = Math.max(
      spacingVox,
      Math.ceil((res - 1) / Math.max(1, probeAxisBudget - 1)),
    );
    const spacingWorld = spacingVox * voxelSize;

    const center = new THREE.Vector3(
      Math.round(target.x / spacingWorld) * spacingWorld,
      Math.round(target.y / spacingWorld) * spacingWorld,
      Math.round(target.z / spacingWorld) * spacingWorld,
    );
    const grid = computeGrid(center, size, res);

    const clampCount = (n) =>
      Math.max(2, Math.min(probeAxisBudget, n));
    const counts = {
      x: clampCount(Math.floor((grid.dims.x - 1) / spacingVox) + 1),
      y: clampCount(Math.floor((grid.dims.y - 1) / spacingVox) + 1),
      z: clampCount(Math.floor((grid.dims.z - 1) / spacingVox) + 1),
    };
    const probeCount = counts.x * counts.y * counts.z;
    const probesPerFrame = Math.min(
      probeCount,
      Math.max(16, Math.round(q.probesPerFrame / 2 ** idx)),
    );
    const tilesPerRow = Math.ceil(Math.sqrt(probeCount));
    const atlasW = tilesPerRow * OCTA_RES;
    const atlasH = Math.ceil(probeCount / tilesPerRow) * OCTA_RES;

    const atlas = new THREE.StorageTexture(atlasW, atlasH);
    atlas.type = THREE.HalfFloatType;
    atlas.minFilter = THREE.LinearFilter;
    atlas.magFilter = THREE.LinearFilter;
    atlas.generateMipmaps = false;

    const mip = computeMipLevels(grid.dims);
    const radianceAtlas = new THREE.Storage3DTexture(mip.atlasDims.x, mip.atlasDims.y, mip.atlasDims.z);
    radianceAtlas.type = THREE.HalfFloatType;
    radianceAtlas.minFilter = THREE.LinearFilter;
    radianceAtlas.magFilter = THREE.LinearFilter;
    radianceAtlas.generateMipmaps = false;

    const sba = (arr, itemSize) => new THREE.StorageBufferAttribute(arr, itemSize);
    const probeLayout = createProbeLayout(probesPerFrame, probeCount);
    const probeArray = new Float32Array(probeLayout.total * 4);
    probeArray.set(
      fibonacciDirections(RAYS_PER_PROBE),
      probeLayout.rayDirs * 4,
    );
    probeArray.set(
      octaTexelDirections(),
      probeLayout.texelDirs * 4,
    );
    const buffers = {
      // Live grid: GPU-composited each update as static ⊕ dynamic splats.
      // Every reader (inject/shadow/probe marches) samples these.
      voxAlbedo: sba(new Uint32Array(grid.count), 1),
      voxNormal: sba(new Uint32Array(grid.count), 1),
      voxEmissive: sba(new Uint32Array(grid.count), 1),
      // Static grid: the CPU voxelizer's output, uploaded on publish.
      voxStaticAlbedo: sba(new Uint32Array(grid.count), 1),
      voxStaticNormal: sba(new Uint32Array(grid.count), 1),
      voxStaticEmissive: sba(new Uint32Array(grid.count), 1),
      voxDirect: sba(new Uint32Array(grid.count), 1), // GPU-written direct-emission cache
      voxDirectStaging: sba(new Uint32Array(grid.count), 1),
      // Incident irradiance from emissive proxies only. Raster lights are
      // excluded because Three already evaluates their direct term.
      voxEmissiveDirect: sba(new Uint32Array(grid.count), 1),
      voxEmissiveDirectStaging: sba(new Uint32Array(grid.count), 1),
      radiance: sba(new Float32Array(grid.count * 4), 4),
      mips: sba(new Float32Array(Math.max(1, mip.mipTexelCount) * 4), 4),
      probeData: sba(probeArray, 4),
      lightData: sba(new Float32Array(MAX_LOCAL_LIGHTS * 5 * 4), 4),
    };
    // Exact proxy rays are valuable in the near field. Embedding the large
    // TLAS/BLAS traversal shader into every coarse cascade compiled multiple
    // near-identical heavyweight pipelines and was a major driver-memory
    // multiplier; outer cascades keep the cheaper voxel probe marcher.
    if (this._rayBuffer && idx === 0) buffers.rayData = this._rayBuffer;

    const nodes = createGINodes({
      dims: grid.dims,
      counts,
      probesPerFrame,
      tilesPerRow,
      atlasW,
      atlasH,
      mip,
      coneSteps: q.coneSteps,
      reflections: q.reflections,
      // Outer cascades carry low-frequency light only: fewer, wider cones
      // and no specular — less WGSL in every material, cheaper blend zones.
      lite: idx > 0,
      buffers,
      probeLayout,
      rayTracing: !!buffers.rayData,
      rayDataCapacity: RAY_GPU_DATA_CAPACITY_VEC4,
      atlas,
      radianceAtlas,
    });
    nodes.uniforms.gridMin.value.copy(grid.min);
    nodes.uniforms.updateGridMin.value.copy(grid.min);
    nodes.uniforms.cascadeCenter.value.copy(center);
    nodes.uniforms.voxelSize.value = grid.voxelSize;
    nodes.uniforms.spacing.value.setScalar(spacingWorld);
    nodes.uniforms.probeMaxDistance.value =
      grid.voxelSize *
      Math.hypot(grid.dims.x, grid.dims.y, grid.dims.z);

    this._dynPool ??= new DynamicVoxelPool();
    const dynNodes = createDynamicVoxelNodes({
      dims: grid.dims,
      gridMin: nodes.uniforms.updateGridMin,
      voxelSize: nodes.uniforms.voxelSize,
      buffers,
      pool: this._dynPool,
    });
    return {
      grid,
      counts,
      nodes,
      buffers,
      atlas,
      radianceAtlas,
      center,
      spacingVox,
      spacingWorld,
      probesPerFrame,
      reach: layout.reach,
      baseProbe: 0,
      directChunk: 0,
      directStepsRemaining: 0,
      directInitialized: false,
      emissiveInitialized: false,
      emissiveBlendStepsRemaining: 0,
      lastEmissiveBlendFrame: -1,
      lastRadianceFrame: -1,
      localLightHash: "",
      hasRadiance: false,
      cascadeBlend: 1,
      cascadeTarget: 1,
      updatesRemaining: 0,
      pendingUpdate: false, // set on recenter: refresh this frame, not on turn
      pendingRecenter: null,
      dynNodes,
      staticDirty: false, // CPU published fresh static voxels; live needs a re-copy
      // Consumed one pass per frame at startup so pipeline compiles never
      // pile into a single frame. Order matters: live-grid compose passes
      // first (they feed the direct cache), then direct cache.
      warmupQueue: [
        dynNodes.copyNode,
        dynNodes.splatNode,
        nodes.injectDirectNode,
        nodes.publishDirectNode,
        nodes.blendEmissiveDirectNode,
        nodes.injectNode,
        ...nodes.mipPasses,
        nodes.copyNode,
        nodes.traceNode,
        nodes.integrateNode,
        nodes.probeShiftSaveNode,
        nodes.probeShiftApplyNode,
      ],
      voxelReady: false,
      voxelJob: null,
    };
  }

  /** (Re)creates the deferred pass at the renderer's current half-res. */
  #buildDeferred() {
    const renderer = this.engine.renderer;
    renderer?.getDrawingBufferSize?.(_size);
    const old = this._deferred;
    if (old) {
      old.passNode?.dispose?.();
      old.resolveNode?.dispose?.();
      old.clearNode?.dispose?.();
    }
    // Preserve texture identity across every rebuild. Texture UUIDs are part
    // of Three's cached WebGPU bindings/render bundles; replacing and later
    // destroying those objects can leave an already-recorded bundle pointing
    // at a dead GPUTexture. A fixed half-res buffer naturally stretches with
    // screenUV when the viewport changes.
    const resScale = this.#qualityParams().giResScale;
    // Keep the full drawing-buffer size stable across rebuilds (the GI buffers
    // are fixed and stretch via screenUV on viewport resize). Only reuse the
    // textures when the target resolution is unchanged — a resScale change must
    // allocate at the new size.
    const width = old ? old.fullWidth : Math.max(4, _size.x || 4);
    const height = old ? old.fullHeight : Math.max(4, _size.y || 4);
    const reuse = old && old.resScale === resScale;
    this._deferred = createDeferredGI({
      width,
      height,
      resScale,
      volumes: this.volumes,
      uniforms: this._deferredUniforms,
      resources: reuse ? old.resources : undefined,
    });
    // Initialize attachment/storage usage before the GI light can sample
    // these textures. If a texture is first seen as a sampled binding and
    // only later as a render/storage target, Three upgrades its GPU usage by
    // destroying and recreating it during frame encoding; cached commands in
    // that same submit still point at the destroyed allocation.
    renderer?.initRenderTarget?.(this._deferred.gbuffer);
    for (const target of [
      this._deferred.giTexture,
      this._deferred.rawTexture,
    ]) {
      renderer?.initTexture?.(target);
    }
    renderer?.compute?.(this._deferred.clearNode);
    this._deferredNeedsClear = false;
    this._deferredUniforms = this._deferred.uniforms;
    this._deferredSize = { w: width, h: height };
    this._deferredViewportKey = `${_size.x}x${_size.y}`;

    if (this._giTextureNode) {
      // Materials keep these exact nodes; resizing only rebinds their values.
      this._giTextureNode.value = this._deferred.giTexture;
      this._giDepthNode.value = this._deferred.gbuffer.depthTexture;
      this._giNormalNode.value = this._deferred.gbuffer.texture;
    } else {
      this._giTextureNode = texture(this._deferred.giTexture);
      this._giDepthNode = texture(this._deferred.gbuffer.depthTexture);
      this._giNormalNode = texture(this._deferred.gbuffer.texture);
      this._deferredSampleFn = createDeferredGISampler({
        giTextureNode: this._giTextureNode,
        depthTextureNode: this._giDepthNode,
        normalTextureNode: this._giNormalNode,
        uniforms: this._deferredUniforms,
      });
    }
    this._deferredReady ??= uniform(0);
    if (!old) this._deferredReady.value = 0;
    this._dfShadowReady ??= uniform(0);
    this._dfShadowReady.value = 0;
    this._dfSunShadowNode?.dispose?.();
    if (this.component?.props?.softShadows === true) {
      // Experimental direct sun shadows allocate their object-space atlas
      // only when explicitly enabled.
      this._meshShadows ??= new MeshSDFShadows();
      this._capsuleShadows ??= new CapsuleShadows();
      const dfSunShadow = createMeshSDFSunShadowNode({
        meshShadows: this._meshShadows,
        capsules: this._capsuleShadows,
        readyUniform: this._dfShadowReady,
      });
      this._dfSunShadowNode = dfSunShadow.node;
      this._dfShadowUniforms = dfSunShadow.uniforms;
    } else {
      this._meshShadows?.atlas?.texture?.dispose?.();
      this._meshShadows = null;
      this._capsuleShadows = null;
      this._dfSunShadowNode = null;
      this._dfShadowUniforms = null;
    }
  }

  #releaseStorageAttribute(attribute) {
    if (!attribute) return;
    const attributes = this.engine.renderer?._attributes;
    if (attributes?.has?.(attribute)) attributes.delete(attribute);
    attribute.dispose?.();
  }

  #disposeVolumeResources(vol) {
    const computeNodes = new Set([
      vol.nodes.injectDirectNode,
      vol.nodes.publishDirectNode,
      vol.nodes.blendEmissiveDirectNode,
      vol.nodes.injectNode,
      ...vol.nodes.mipPasses,
      vol.nodes.copyNode,
      vol.nodes.traceNode,
      vol.nodes.integrateNode,
      vol.nodes.probeShiftSaveNode,
      vol.nodes.probeShiftApplyNode,
      vol.dynNodes.copyNode,
      vol.dynNodes.splatNode,
    ]);
    for (const node of computeNodes) node?.dispose?.();

    const attributes = new Set(Object.values(vol.buffers));
    attributes.delete(this._rayBuffer);
    for (const attribute of attributes) {
      this.#releaseStorageAttribute(attribute);
    }
    vol.atlas.dispose();
    vol.radianceAtlas.dispose();
  }

  #teardownSceneObjects({ preserveDeferred = true } = {}) {
    this._voxelizeGeneration++;
    this._voxelizePromise = null;
    if (this.light) {
      this.engine.scene.remove(this.light);
      this.light.dispose?.();
      this.light = null;
      this.#invalidateLitMaterials(true);
    }
    this.#removeDebugMesh();
    for (const vol of this.volumes) {
      this.#cancelVoxelize(vol);
      this.#disposeVolumeResources(vol);
    }
    this.volumes = [];
    this._dynActive.length = 0;
    this._dynPool?.sync([]);
    this._dynSynced = false;
    this._dynamicSetDirty = true;
    this._dynamicObjectsEnabled = null;
    this._emissiveSources.length = 0;
    this._emissiveSourceHash = null;
    this._emissiveSourcesDirty = true;
    this._localLights.length = 0;
    this._localLightsDirty = true;
    this._meshShadowList = null;
    this._skinnedList = null;
    if (this._raySceneSignal) this._raySceneSignal.cancelled = true;
    this._rayScene?.cancelBuild();
    this._rayScene = null;
    this._raySceneBuild = null;
    this._raySceneSignal = null;
    this._rayDataReady = false;
    this._rayLayout = null;
    this._rayUploadedTopologyVersion = -1;
    this._rayUploadedTransformVersion = -1;
    this._raySceneDirty = true;
    this.#restoreRealtimeShadows();
    if (!preserveDeferred) {
      this._deferred?.passNode?.dispose?.();
      this._deferred?.resolveNode?.dispose?.();
      this._deferred?.clearNode?.dispose?.();
      // These targets are system-owned. Leaving them undisposed kept their
      // GPU allocations alive after GI/module teardown and compounded memory
      // on repeated editor sessions or renderer changes.
      this._deferred?.dispose?.();
      this._deferred = null;
      this._deferredUniforms = null;
      this._deferredReady = null;
      this._giTextureNode = null;
      this._giDepthNode = null;
      this._giNormalNode = null;
      this._deferredSampleFn = null;
      this._deferredViewportKey = "";
      this._dfShadowReady = null;
      this._dfSunShadowNode?.dispose?.();
      this._dfSunShadowNode = null;
      this._dfShadowUniforms = null;
    }
    this.#restoreAmbient();
  }

  dispose() {
    this._offTick?.();
    this._offPreRender?.();
    this._offHier?.();
    this._offComp?.();
    this._offVirtualGeometry?.();
    this._offVirtualGeometryChanged?.();
    this._offPlay?.();
    this._offRenderer?.();
    this._offTransform?.();
    if (this._raySceneSignal) this._raySceneSignal.cancelled = true;
    this._rayScene?.cancelBuild();
    this._rayScene = null;
    clearRayProxyCache();
    this.#teardownSceneObjects({ preserveDeferred: false });
    this.#releaseStorageAttribute(this._rayBuffer);
    this._rayBuffer = null;
    if (this._dynPool) {
      this.#releaseStorageAttribute(this._dynPool.triangles);
      this.#releaseStorageAttribute(this._dynPool.matrices);
      this._dynPool = null;
    }
    this._meshShadows?.atlas?.texture?.dispose?.();
    this._meshShadows = null;
    this._capsuleShadows = null;
    this.component = null;
  }

  // ---- per-frame -----------------------------------------------------------

  #tick(dt = 1 / 60) {
    if (Number.isFinite(dt) && dt > 0) this._deltaTime = Math.min(dt, 0.1);
    const engine = this.engine;
    const c = this.component;
    if (!c || !engine.rendererReady || !engine.renderer) return;
    if (c.enabled === false) return;
    // Do not allocate render targets against a canvas generation that is
    // about to be replaced. Engine pauses rendering while this promise is
    // active; GI also pauses its update/rebuild work so its first deferred
    // resources are created only after the final size is installed.
    if (engine._resizeInFlight) return;
    this.#wireRenderer(engine.renderer);

    const layoutKey = this.#cameraLayoutKey(engine.camera);
    const cameraChanged = engine.camera !== this._cameraRef;
    if (cameraChanged) {
      this._cameraRef = engine.camera;
    }
    if (
      this.volumes.length &&
      (cameraChanged || layoutKey !== this._layoutKey)
    ) {
      this.queueRebuild();
    }
    if (this._rebuildQueued) this.#rebuild();
    if (!this.volumes.length) return;
    this.#syncRayProxyScene();
    this.#syncAmbient();

    // Position-centered clipmaps do not move when the camera merely rotates.
    // Translation still snaps probe-aligned, so surviving voxel/probe data
    // scrolls without resampling or visible swimming.
    for (const vol of this.volumes) {
      this.#targetPosition(_worldPos);
      this.#maybeRecenter(vol, _worldPos);
    }

    // Poll for moved geometry: transforms don't emit engine events, so a
    // cheap world-matrix fingerprint over voxelizable meshes catches drags,
    // physics, and scripted motion. Perpetually-moving meshes go dynamic
    // (excluded) instead of re-triggering voxelization every poll.
    if (++this._frame % TRANSFORM_POLL_FRAMES === 0) {
      if (this.#pollMotion() && this._sceneHashReady) {
        this._voxelsDirtyAt = performance.now();
      }
      this._sceneHashReady = true;
    }
    if (this._rayScene?.refit()) {
      this._rayScene.updateDebugObject(
        this._debugView === "ray-proxies" ? this.debugMesh : null,
      );
    }
    this.#syncRayDataUpload();

    if (this._voxelsDirtyAt && performance.now() - this._voxelsDirtyAt > REVOXELIZE_DELAY_MS) {
      this._voxelsDirtyAt = 0;
      const boxes = this._dirtyBoxes;
      this._dirtyBoxes = [];
      const anyReady = this.volumes.some((v) => v.voxelReady);
      if (this._structuralDirty || !anyReady) {
        // Mesh added/removed or geometry swapped (or nothing baked yet): the
        // whole scene must be rescanned.
        this._structuralDirty = false;
        this.#voxelizeAll();
      } else if (boxes.length) {
        // Only settled object footprints changed — rebake just those regions.
        this.#voxelizeIncremental(boxes);
      }
      // else: a first-motion promotion set the dirty flag but there is nothing
      // to bake yet (the mover lives in the GPU dynamic layer until it
      // settles). Skipping avoids the wasteful mid-drag full rescan that used
      // to fire ~120 ms into every drag.
    }

    // Dynamic meshes (perpetual movers the CPU voxelizer excludes) splat into
    // the live grid on the GPU. Triangles re-upload only when the dynamic set
    // changes; motion costs a small matrix-table upload per frame.
    this.#syncDynamicPool();

    // Per-mesh SDF shadow casters: candidate list refreshes on the motion-
    // poll cadence; transforms rewrite every frame (movers must not lag) and
    // at most one new geometry bakes per frame.
    if (
      this.component.props.softShadows === true &&
      this._meshShadows
    ) {
      if (this._frame % TRANSFORM_POLL_FRAMES === 0 || !this._meshShadowList) {
        const list = [];
        forEachVoxelizableMesh(this.engine.scene, (mesh) => list.push(mesh));
        this._meshShadowList = list;
        this._skinnedList = collectSkinnedMeshes(this.engine.scene);
      }
      this.#targetPosition(_worldPos);
      this._meshShadows.update(this._meshShadowList, _worldPos);
      // Characters: capsule endpoints follow bones every frame.
      this._capsuleShadows?.update(this._skinnedList ?? []);
    }

    const sun = this.#findSun();
    this.#syncRealtimeShadows(sun);
    this.#updateDFShadowUniforms(sun);
    const sunMoved = this.#sunChanged(sun);
    if (
      this._localLightsDirty ||
      this._frame % EMISSION_POLL_FRAMES === 0
    ) {
      this._localLightsDirty = false;
      this._localLights = this.#collectEmissionSources(sun);
    }
    const localLights = this._localLights;
    for (const vol of this.volumes) {
      this.#updateUniforms(vol, sun);
      const localLightsMoved = this.#updateLocalLights(vol, localLights);
      if (sunMoved || localLightsMoved) {
        this.#requestDirectRefresh(vol);
      }
    }

    const r = engine.renderer;

    // Pipeline warm-up. Measured on the diagnostic scene: the first dispatch
    // of each pass stalls until the GPU process finishes compiling its
    // pipeline (multi-second for the heavy shadow/trace shaders), and the
    // former one-pass-per-frame queue strung those compiles END TO END —
    // that serialization, not voxelization, was the 15-25 s startup.
    // Dispatching every volume's passes in one frame lets Dawn compile them
    // on its worker pool in parallel, so total warmup cost collapses to
    // roughly the single slowest pipeline.
    let warmed = false;
    for (const volume of this.volumes) {
      while (volume.warmupQueue.length) {
        r.compute(volume.warmupQueue.shift());
        warmed = true;
      }
    }
    if (warmed) return;

    // Exactly one volume receives GI maintenance per frame. Pending atomic
    // publishes take priority; all other lighting, SDF, motion and probe work
    // advances round-robin so no edit can stack every cascade.
    let selectedIndex = this.volumes.findIndex(
      (candidate) => candidate.voxelReady && candidate.pendingUpdate,
    );
    if (selectedIndex < 0) {
      if (
        (this._dynActive[0] === true ||
          this.volumes[0].directStepsRemaining > 0) &&
        this.#volumeNeedsWork(this.volumes[0])
      ) {
        selectedIndex = 0;
      }
    }
    if (selectedIndex < 0) {
      for (let offset = 0; offset < this.volumes.length; offset++) {
        const index =
          (this._workCursor + offset) % this.volumes.length;
        if (this.#volumeNeedsWork(this.volumes[index])) {
          selectedIndex = index;
          break;
        }
      }
    }
    if (selectedIndex < 0) return;
    this._workCursor = (selectedIndex + 1) % this.volumes.length;

    const vol = this.volumes[selectedIndex];
    vol.pendingUpdate = false;

    // Recompose current geometry. Indirect visibility uses a bounded voxel
    // march, so no global JFA/SDF snapshot or its large seed buffers are
    // needed. A recenter builds direct light against updateGridMin while the
    // previous complete atlas remains visible at gridMin.
    const dynActive = this._dynActive[selectedIndex] === true;
    if (vol.staticDirty || dynActive) {
      vol.staticDirty = false;
      r.compute(vol.dynNodes.copyNode);
      if (dynActive) r.compute(vol.dynNodes.splatNode);
      if (vol.pendingRecenter && !vol.pendingRecenter.prepared) {
        vol.pendingRecenter.prepared = true;
        vol.directInitialized = false;
        vol.directChunk = 0;
        vol.directStepsRemaining = Math.max(
          vol.directStepsRemaining,
          vol.nodes.directChunks,
        );
      } else if (!vol.pendingRecenter) {
        this.#requestDirectRefresh(vol, {
          initial: !vol.directInitialized,
        });
      }
    }

    const responseBase = Math.min(
      2,
      Math.max(0.05, this.component.props.lightingResponse ?? 0.5),
    );
    // Accelerate the EMA where a mover is (or just was) present. dynActive is
    // the per-frame overlap test; the grace window carries the fast response
    // through the ~1 s settle so the tail doesn't drop back to the slow
    // constant the instant motion stops.
    const recentlyDynamic =
      dynActive ||
      this._frame - (vol.lastDynamicFrame ?? -1e9) < DYNAMIC_GRACE_FRAMES;
    const lightingResponse = recentlyDynamic
      ? Math.min(responseBase, DYNAMIC_RESPONSE_SECONDS)
      : responseBase;
    // Emissive receiver cache (room surfaces lit BY emissive meshes) blend
    // cap. A motion-time 0.85 was tried to snap a moving emissive light, but it
    // made the cache JUMP whenever ANYTHING moved — moving a non-emissive
    // occluder near the light flickered its shadow. A moving emissive already
    // tracks via the voxEmissive splat, so keep the smooth 0.18 always;
    // real-time occluder shadows come from realtimeInject (un-chunking), which
    // updates the whole cache coherently in one frame rather than snapping a
    // partial blend.
    const emissiveCap = 0.18;
    let completedDirectSweep = false;
    if (vol.directStepsRemaining > 0) {
      const sweeps = Math.max(
        1,
        Math.min(8, Math.ceil(lightingResponse * 4)),
      );
      vol.nodes.uniforms.directBlend.value = vol.directInitialized
        ? 1 - Math.exp(-4 / sweeps)
        : 1;
      // One direct chunk per frame normally. In the Quality tier's real-time
      // mode, process the WHOLE direct+emissive light cache in one frame while
      // a mover is present, so a moving light/occluder's shadow and first
      // bounce update immediately instead of over ~16 frames. This is real GPU
      // cost, paid only during motion and only when the user opts in.
      const chunkBudget =
        recentlyDynamic && this.#qualityParams().realtimeInject
          ? vol.nodes.directChunks
          : 1;
      for (let chunk = 0; chunk < chunkBudget; chunk++) {
        vol.nodes.uniforms.directChunk.value = vol.directChunk;
        r.compute(vol.nodes.injectDirectNode);
        // Expose each changed residue immediately; untouched cells keep
        // history until their turn instead of waiting for an atomic sweep.
        vol.directChunk =
          (vol.directChunk + 1) % vol.nodes.directChunks;
        vol.directStepsRemaining--;
        if (vol.directChunk === 0) {
          completedDirectSweep = true;
          if (!vol.directInitialized) vol.directInitialized = true;
        }
      }
      if (completedDirectSweep) {
        r.compute(vol.nodes.publishDirectNode);
        const initialEmissive =
          !vol.emissiveInitialized || !!vol.pendingRecenter;
        const elapsedFrames =
          vol.lastEmissiveBlendFrame < 0
            ? 1
            : Math.max(
                1,
                this._frame - vol.lastEmissiveBlendFrame,
              );
        const elapsed = elapsedFrames * this._deltaTime;
        vol.nodes.uniforms.emissiveBlend.value = initialEmissive
          ? 1
          : Math.min(
              emissiveCap,
              Math.max(
                0.025,
                1 - Math.exp(-elapsed / lightingResponse),
              ),
            );
        r.compute(vol.nodes.blendEmissiveDirectNode);
        vol.emissiveInitialized = true;
        vol.lastEmissiveBlendFrame = this._frame;
        if (
          vol.directStepsRemaining === 0 &&
          !vol.pendingRecenter
        ) {
          vol.emissiveBlendStepsRemaining = Math.max(
            vol.emissiveBlendStepsRemaining,
            Math.min(
              120,
              Math.max(
                4,
                Math.ceil(
                  (3 * lightingResponse * 60) /
                    Math.max(1, this.volumes.length),
                ),
              ),
            ),
          );
        }
      }
      // Initial/recentered content stays hidden until the first complete
      // staging sweep. Later partial sweeps remain invisible while radiance
      // continues converging from the last complete direct target.
      if (!vol.directInitialized) return;
    }

    // Continue converging the visible emissive receiver cache after the
    // expensive shadow target sweep is complete. This is a cheap full-volume
    // blend and avoids atomic lighting/shadow patches.
    if (
      !completedDirectSweep &&
      vol.directStepsRemaining === 0 &&
      vol.emissiveBlendStepsRemaining > 0 &&
      !vol.pendingRecenter
    ) {
      const elapsedFrames =
        vol.lastEmissiveBlendFrame < 0
          ? 1
          : Math.max(
              1,
              this._frame - vol.lastEmissiveBlendFrame,
            );
      const elapsed = elapsedFrames * this._deltaTime;
      vol.nodes.uniforms.emissiveBlend.value = Math.min(
        emissiveCap,
        Math.max(
          0.025,
          1 - Math.exp(-elapsed / lightingResponse),
        ),
      );
      r.compute(vol.nodes.blendEmissiveDirectNode);
      vol.lastEmissiveBlendFrame = this._frame;
      vol.emissiveBlendStepsRemaining--;
    }

    // Fade the old cascade completely into its parent before replacing its
    // coordinate system. The new cache fades back in after publication.
    if (vol.pendingRecenter && vol.cascadeBlend > 0.02) return;

    const elapsedFrames =
      vol.lastRadianceFrame < 0
        ? 1
        : Math.max(1, this._frame - vol.lastRadianceFrame);
    const elapsed = elapsedFrames * this._deltaTime;
    const publishingRecenter = !!vol.pendingRecenter;
    vol.nodes.uniforms.radianceBlend.value =
      vol.hasRadiance && !publishingRecenter
      ? Math.min(
          0.35,
          Math.max(
            0.03,
            1 - Math.exp(-elapsed / lightingResponse),
          ),
        )
      : 1;
    vol.nodes.uniforms.feedbackWeight.value =
      vol.hasRadiance && !publishingRecenter ? 1 : 0;
    vol.lastRadianceFrame = this._frame;

    r.compute(vol.nodes.injectNode);
    // Publish accumulated radiance to the pyramid sampled by the visible
    // cone gather, then advance the same volume's probe window.
    for (const pass of vol.nodes.mipPasses) r.compute(pass);
    r.compute(vol.nodes.copyNode);
    const firstRadiance = !vol.hasRadiance;
    vol.hasRadiance = true;
    // The moment GI actually produces output, FORCE every lit material to
    // recompile with the GI light node. Materials compiled during the
    // GI-absent startup window (or that the incremental WeakSet marked
    // before the node took) otherwise stay GI-less — flat-lit by the
    // constant ambient, identical whether the room is sealed or open. This
    // is the reason the editor showed no GI while the headless probes were
    // correct. Runs once (guarded), so no per-frame recompile cost.
    if (firstRadiance && !this._radianceMaterialsSynced) {
      this._radianceMaterialsSynced = true;
      this.#invalidateLitMaterials(true);
    }

    if (publishingRecenter) {
      const pending = vol.pendingRecenter;
      // Content, atlas coordinates, and surviving probe histories become
      // visible together only after the new direct/radiance cache is complete.
      vol.center.copy(pending.newCenter);
      vol.grid.min.copy(pending.newMin);
      vol.nodes.uniforms.gridMin.value.copy(pending.newMin);
      if (pending.teleport) {
        vol.nodes.uniforms.probeShift.value.set(vol.counts.x, 0, 0);
        vol.nodes.uniforms.reseedSky.value = 1;
      } else {
        vol.nodes.uniforms.probeShift.value.set(
          pending.steps.x,
          pending.steps.y,
          pending.steps.z,
        );
        vol.nodes.uniforms.reseedSky.value = 0;
      }
      r.compute(vol.nodes.probeShiftSaveNode);
      r.compute(vol.nodes.probeShiftApplyNode);
      vol.pendingRecenter = null;
      vol.cascadeTarget = 1;
      vol.nodes.uniforms.feedbackWeight.value = 1;
    }

    // Multi-bounce feedback: one probe window normally, several per frame
    // while a mover is present so the bounce field catches up near real time.
    const probeSweeps = recentlyDynamic
      ? this.#qualityParams().probeMotionSweeps
      : 1;
    for (let s = 0; s < probeSweeps; s++) {
      vol.nodes.uniforms.baseProbe.value = vol.baseProbe;
      r.compute(vol.nodes.traceNode);
      r.compute(vol.nodes.integrateNode);
      vol.baseProbe =
        (vol.baseProbe + vol.probesPerFrame) % vol.nodes.probeCount;
    }
    if (vol.updatesRemaining > 0) vol.updatesRemaining--;

  }

  #syncRayProxyScene() {
    const enabled =
      this.component?.props?.rayProxies === true ||
      this.component?.props?.triangleProbeRays === true ||
      this._debugView === "ray-proxies";
    if (!enabled) {
      if (this._raySceneSignal) this._raySceneSignal.cancelled = true;
      this._rayScene?.cancelBuild();
      this._rayScene = null;
      this._raySceneBuild = null;
      this._raySceneSignal = null;
      this._raySceneDirty = true;
      this._rayDataReady = false;
      return;
    }
    this._rayScene ??= new TriangleRayScene();
    if (!this._raySceneDirty || this._raySceneBuild) return;
    this._raySceneDirty = false;
    const signal = { cancelled: false };
    const rayScene = this._rayScene;
    this._raySceneSignal = signal;
    const build = rayScene
      .rebuild(this.engine.scene, { signal })
      .then((result) => {
        if (
          signal.cancelled ||
          result.cancelled ||
          this._rayScene !== rayScene
        ) {
          return;
        }
        this.stats.rayProxies = { ...rayScene.stats };
        if (this._debugView === "ray-proxies") this.#buildDebugMesh("ray-proxies");
      })
      .catch((error) => {
        console.error(`GI ray proxy build failed: ${error.message ?? error}`);
        this._raySceneDirty = true;
      })
      .finally(() => {
        if (this._raySceneSignal === signal) this._raySceneSignal = null;
        if (this._raySceneBuild === build) this._raySceneBuild = null;
      });
    this._raySceneBuild = build;
  }

  #syncRayDataUpload() {
    const requested =
      this.component?.props?.rayProxies === true &&
      (this.component?.props?.emissiveRayVisibility === true ||
        this.component?.props?.triangleProbeRays === true);
    const rayScene = this._rayScene;
    const buffer = this._rayBuffer;
    if (!requested || !rayScene || !buffer || this._raySceneBuild) {
      this._rayDataReady = false;
      this.#setRayModeActive(false);
      return;
    }

    const packed = rayScene.packGPUData();
    if (packed.layout.totalVec4s > RAY_GPU_DATA_CAPACITY_VEC4) {
      if (!this._rayCapacityWarned) {
        this._rayCapacityWarned = true;
        console.warn(
          `[gi] triangle ray scene needs ${packed.layout.totalVec4s.toLocaleString()} vec4s; ` +
            `capacity is ${RAY_GPU_DATA_CAPACITY_VEC4.toLocaleString()}. Falling back to voxel probe rays.`,
        );
      }
      this._rayDataReady = false;
      this.#setRayModeActive(false);
      return;
    }

    const target = buffer.array;
    buffer.clearUpdateRanges();
    let changed = false;
    if (this._rayUploadedTopologyVersion !== rayScene.topologyVersion) {
      const floatCount = packed.layout.totalVec4s * 4;
      target.set(packed.data.subarray(0, floatCount), 0);
      buffer.addUpdateRange(0, floatCount);
      this._rayUploadedTopologyVersion = rayScene.topologyVersion;
      this._rayUploadedTransformVersion = rayScene.transformVersion;
      changed = true;
    } else if (
      this._rayUploadedTransformVersion !== rayScene.transformVersion
    ) {
      const tlasStart = packed.layout.tlasNodes.offset * 4;
      const tlasCount = packed.layout.tlasNodes.count * 4;
      target.set(
        packed.data.subarray(tlasStart, tlasStart + tlasCount),
        tlasStart,
      );
      buffer.addUpdateRange(tlasStart, tlasCount);

      const instanceStart = packed.layout.instances.offset * 4;
      const instanceCount = packed.layout.instances.count * 4;
      target.set(
        packed.data.subarray(
          instanceStart,
          instanceStart + instanceCount,
        ),
        instanceStart,
      );
      if (instanceCount > 0) {
        buffer.addUpdateRange(instanceStart, instanceCount);
      }
      this._rayUploadedTransformVersion = rayScene.transformVersion;
      changed = true;
    }
    if (changed) buffer.needsUpdate = true;
    this._rayLayout = packed.layout;
    this._rayDataReady = true;
    this.#setRayModeActive(true);
  }

  #setRayModeActive(active) {
    active = !!active;
    if (this._rayModeActive === active) return;
    this._rayModeActive = active;
    for (const volume of this.volumes) {
      this.#requestDirectRefresh(volume, {
        initial: !volume.directInitialized,
      });
      this.#requestConvergence(volume, CONVERGENCE_SWEEPS);
    }
  }

  /**
   * Half-res world-normal + depth prepass, then the screen-space cone-trace
   * compute. Runs after the volumes update so it samples fresh radiance,
   * and before the engine's main render so materials see this frame's GI.
   */
  #runDeferred() {
    const engine = this.engine;
    const camera = engine.camera;
    const d = this._deferred;
    if (!d || !camera) return;
    if (!this.component || this.component.enabled === false || !this.volumes.length) return;
    if (this._deferredNeedsClear) {
      this._deferredNeedsClear = false;
      engine.renderer.compute(d.clearNode);
    }
    // Hold off until the compute pipelines are warmed and the volumes have
    // produced radiance — otherwise the prepass samples an empty atlas (and
    // adds its own pipeline compile to the warmup stall).
    if (this.volumes.some((v) => v.warmupQueue.length)) return;
    if (!this.volumes[0].hasRadiance) return;

    const renderer = engine.renderer;
    const scene = engine.scene;
    renderer.getDrawingBufferSize(_size);
    const viewportKey = `${_size.x}x${_size.y}`;
    if (viewportKey !== this._deferredViewportKey) {
      this._deferredViewportKey = viewportKey;
      // Deferred buffers deliberately keep their original dimensions. They
      // are addressed in normalized UVs, so canvas/DPR changes need no target
      // mutation and temporal history survives dock/viewport resizing. This
      // also avoids Three submitting a cached render context that references
      // a just-retired attachment generation.
    }
    const prevOverride = scene.overrideMaterial;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevTarget = renderer.getRenderTarget?.() ?? null;
    const prevAutoClear = renderer.autoClear;
    const prevAutoClearColor = renderer.autoClearColor;
    const prevAutoClearDepth = renderer.autoClearDepth;
    const editorLayerWasEnabled = camera.layers.isEnabled(EDITOR_LAYER);
    const hiddenEditorOnly = hideEditorOnlySubtrees(scene);
    try {
      renderer.shadowMap.autoUpdate = false; // don't re-render shadow maps for the prepass
      // The GI receiver buffers describe exactly this frame. Inheriting a
      // postprocess/UI renderer state with autoClear disabled retained stale
      // depth/normals, making newly visible objects sample flat old GI until
      // camera motion happened to overwrite those pixels.
      renderer.autoClear = true;
      renderer.autoClearColor = true;
      renderer.autoClearDepth = true;
      camera.layers.disable(EDITOR_LAYER);
      scene.overrideMaterial = d.normalMaterial;
      renderer.setRenderTarget(d.gbuffer);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      scene.overrideMaterial = prevOverride;
      if (editorLayerWasEnabled) camera.layers.enable(EDITOR_LAYER);
      restoreHiddenSubtrees(hiddenEditorOnly);
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.autoClear = prevAutoClear;
      renderer.autoClearColor = prevAutoClearColor;
      renderer.autoClearDepth = prevAutoClearDepth;
    }
    // Capture the camera matrices AFTER the prepass render: the camera is a
    // child of the (physics-driven) character, so its matrixWorld is only
    // refreshed by the scene.updateMatrixWorld() inside render() above.
    // Reading it before would reconstruct GI world positions from a stale
    // pose and re-introduce the moving-object shimmer.
    d.update(camera);
    renderer.compute(d.passNode);
    renderer.compute(d.resolveNode);
    if (this._deferredReady) this._deferredReady.value = 1;
    // Bounded startup material re-sync. GI now visibly resolves, but a scene
    // that finishes loading (or a material that compiled) DURING the GI-absent
    // startup window can be left without the GI graph — the "objects stay
    // flat until I move them / fly the camera around" report. The incremental
    // WeakSet invalidator skips anything already marked, so those are stuck.
    // Re-force ALL lit materials a handful of times over the first ~4 s after
    // GI becomes visible: force ignores the WeakSet, so every material present
    // during load is guaranteed to recompile with the GI node. Bounded, so
    // there is no steady-state recompile cost.
    if (this._deferredResyncCount === undefined) this._deferredResyncCount = 0;
    if (this._deferredResyncCount < 5) {
      if (this._deferredResyncFrame === undefined) this._deferredResyncFrame = this._frame;
      if (this._frame - this._deferredResyncFrame >= this._deferredResyncCount * 45) {
        this._deferredResyncCount++;
        this.#invalidateLitMaterials(true);
      }
    }
  }

  #cameraLayoutKey(camera) {
    if (!camera) return "none";
    const rawAspect = Math.min(
      4,
      Math.max(2.2, Number(camera.aspect) || 16 / 9),
    );
    const aspectBucket =
      rawAspect <= 2.2 ? "std" : rawAspect <= 3 ? "ultra" : "max";
    return [
      camera.isPerspectiveCamera ? "p" : "o",
      Number(camera.fov || 0).toFixed(1),
      aspectBucket,
      Math.min(AUTO_MAX_REACH, Number(camera.far || 0)).toFixed(0),
    ].join(":");
  }

  #requestConvergence(vol, sweeps = CONVERGENCE_SWEEPS) {
    const updatesPerSweep = Math.max(
      1,
      Math.ceil(vol.nodes.probeCount / Math.max(1, vol.probesPerFrame)),
    );
    vol.updatesRemaining = Math.max(
      vol.updatesRemaining || 0,
      updatesPerSweep * Math.max(1, sweeps),
    );
  }

  /**
   * Schedules an interleaved direct-light refresh instead of invalidating the
   * whole voxel cache in one frame. Response time controls how many complete
   * chunk sweeps chase the latest lighting; each sweep converges
   * exponentially and the probe/radiance field follows during the same work.
   */
  #requestDirectRefresh(vol, { initial = false } = {}) {
    const response = Math.min(
      2,
      Math.max(0.05, this.component?.props?.lightingResponse ?? 0.5),
    );
    const sweeps = initial
      ? 1
      : Math.max(1, Math.min(8, Math.ceil(response * 4)));
    vol.directStepsRemaining = Math.max(
      vol.directStepsRemaining || 0,
      vol.nodes.directChunks * sweeps,
    );
    this.#requestConvergence(
      vol,
      initial ? 1 : LIGHT_CONVERGENCE_SWEEPS,
    );
  }

  #volumeNeedsWork(vol) {
    return (
      vol.voxelReady &&
      (
        vol.pendingUpdate ||
        vol.staticDirty ||
        vol.pendingRecenter ||
        vol.directStepsRemaining > 0 ||
        vol.emissiveBlendStepsRemaining > 0 ||
        vol.updatesRemaining > 0
      )
    );
  }

  #syncAmbient() {
    const ambient = this.engine.ambientLight;
    if (!ambient) return;
    const suppress = this.component?.props?.replaceAmbient !== false;
    if (suppress) {
      if (!this._ambientSuppressed) {
        this._ambientRestoreIntensity = ambient.intensity;
        this._ambientSuppressed = true;
      }
      if (ambient.intensity !== 0) ambient.intensity = 0;
    } else {
      this.#restoreAmbient();
    }
  }

  #restoreAmbient() {
    if (!this._ambientSuppressed) return;
    const ambient = this.engine.ambientLight;
    if (ambient) {
      const configured = this.engine.settings?.ambientIntensity;
      ambient.intensity = Number.isFinite(configured)
        ? configured
        : (this._ambientRestoreIntensity ?? 0.3);
    }
    this._ambientSuppressed = false;
    this._ambientRestoreIntensity = null;
  }

  /**
   * Three's DirectionalLight inherits Object3D.getWorldDirection(), but its
   * real lighting direction is defined by position -> target (rotation alone
   * is explicitly ignored by Three). Using getWorldDirection here made the GI
   * incident light unrelated to the visibly rendered light.
   */
  #lightTravelDirection(light, out) {
    light.getWorldPosition(_lightSourceWorld);
    light.target?.getWorldPosition?.(_lightTargetWorld);
    return out
      .copy(_lightTargetWorld)
      .sub(_lightSourceWorld)
      .normalize();
  }

  /** True when the sun's direction/color changed beyond noise since last frame. */
  #sunChanged(sun) {
    let key = 0;
    if (sun) {
      this.#lightTravelDirection(sun, _sunDir);
      key =
        _sunDir.x * 11.1 +
        _sunDir.y * 23.3 +
        _sunDir.z * 47.7 +
        sun.color.r * 5.1 +
        sun.color.g * 7.3 +
        sun.color.b * 9.7 +
        sun.intensity * 13.9;
    }
    const changed = this._sunKey === undefined || Math.abs(key - this._sunKey) > 1e-4;
    this._sunKey = key;
    return changed;
  }

  #wireRenderer(renderer) {
    const library = renderer.library;
    if (!library || wiredLibraries.has(library)) return;
    library.addLight(GIProbeVolumeLightNode, GIProbeVolumeLight);
    wiredLibraries.add(library);
  }

  /**
   * One diagnostic line per static publish. `sealed 0` in a scene with a
   * closed room means the flood classified the interior as exterior (wall
   * gaps at this cascade's voxel size); a high twoSided fraction means the
   * walls are DoubleSide and the radiance sidedness gates pass them through.
   */
  #logEnclosure(vol, enclosure) {
    const cascade = this.volumes.indexOf(vol);
    const pct = enclosure.occupied
      ? Math.round((enclosure.twoSided / enclosure.occupied) * 100)
      : 0;
    console.log(
      `[gi] cascade${cascade} enclosure: occupied ${enclosure.occupied}` +
        ` (twoSided ${pct}%), exterior ${enclosure.exterior},` +
        ` sealed ${enclosure.sealed}`,
    );
  }

  /**
   * Recompiles lit materials so they pick up the GI light node.
   *
   * `force` (light set entered/left the scene) re-marks EVERY lit material.
   * The default incremental mode marks only materials this system has not
   * invalidated before, tracked in a WeakSet. That is what fixes surfaces
   * that stayed black until moved/orbited: a material compiled before the
   * GI light registered — or a mesh added after GI init — never got the GI
   * sampler, and nothing recompiled it until an unrelated scene edit did.
   * Marking each material exactly once, right after it appears, avoids the
   * recompile-storm spikes that re-marking everything on every edit caused.
   */
  #invalidateLitMaterials(force = false) {
    this._giMaterials ??= new WeakSet();
    this.engine.scene.traverse((object) => {
      const list = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of list) {
        if (!material || material.lights === false) continue;
        if (!force && this._giMaterials.has(material)) continue;
        material.needsUpdate = true;
        this._giMaterials.add(material);
      }
    });
  }

  /**
   * Walks voxelizable meshes, updating each one's motion record. Returns
   * true when a mesh appeared, entered the dynamic layer, or settled. Motion
   * enters the GPU path on the first observed transform change, so dragging
   * never repeatedly voxelizes the moving mesh on the CPU. One time-sliced
   * static rebuild removes its old footprint; another bakes its final pose
   * after roughly one second without transform changes.
   */
  #pollMotion() {
    let dirty = false;
    forEachVoxelizableMesh(this.engine.scene, (o) => {
      const e = o.matrixWorld.elements;
      // Hash every affine matrix component so rotations around arbitrary
      // axes and shear/non-uniform scale cannot evade motion detection.
      const h =
        e[0] * 1.1 + e[1] * 1.7 + e[2] * 2.3 +
        e[4] * 3.1 + e[5] * 4.1 + e[6] * 5.3 +
        e[8] * 6.1 + e[9] * 7.3 + e[10] * 8.7 +
        e[12] * 11.1 + e[13] * 13.3 + e[14] * 17.1;
      let rec = this._motion.get(o);
      if (!rec) {
        rec = {
          h,
          moving: 0,
          still: 0,
          dynamic: false,
          settling: false,
          box: this.#meshWorldBox(o),
        };
        this._motion.set(o, rec);
        dirty = true;
        return;
      }
      if (h !== rec.h) {
        const interruptedBake = rec.settling;
        rec.h = h;
        const oldBox = rec.box;
        rec.box = this.#meshWorldBox(o);
        rec.moving++;
        rec.still = 0;
        rec.settling = false;
        if (rec.dynamic) {
          // A pose being baked moved again. A settling mesh may already have
          // its footprint stamped into static at oldBox; clear it now (and
          // remember the region) so the eventual incremental rebake restores
          // it and no ghost survives. A still-dynamic mesh (not settling) has
          // no static footprint yet, so nothing to clear.
          if (interruptedBake) {
            this.#clearStaticFootprint(oldBox);
            (rec.staleBoxes ??= []).push(oldBox);
            dirty = true;
          }
          return;
        }
        rec.dynamic = true;
        this._dynamicSetDirty = true;
        // Remove the baked old pose immediately. Otherwise an opening wall
        // remains an occluder until the multi-second background rebake
        // publishes, then lighting jumps suddenly. The live dynamic splat
        // supplies the new pose on this same update cycle. Remember the
        // cleared region so the settle-time incremental rebake restores any
        // neighbouring geometry the AABB clear also wiped.
        this.#clearStaticFootprint(oldBox);
        (rec.staleBoxes ??= []).push(oldBox);
        dirty = true;
      } else {
        rec.moving = 0;
        rec.still++;
        if (
          rec.dynamic &&
          !rec.settling &&
          rec.still >= SETTLE_POLL_COUNT
        ) {
          rec.settling = true;
          // The mover has come to rest: its footprint must return to the
          // static grid. Record the regions to re-bake — every region the
          // AABB clears wiped plus the mesh's final resting pose — so the
          // debounced handler can rebake just these boxes instead of the
          // whole scene. A null box (missing geometry bounds) forces the full
          // path as a safe fallback.
          if (rec.staleBoxes?.length) {
            for (const b of rec.staleBoxes) this._dirtyBoxes.push(b);
            rec.staleBoxes.length = 0;
          }
          // A null box means the mesh has no geometry bounds — nothing to bake
          // incrementally, and NOT a reason to force a full-scene re-voxelize
          // (that was a per-move spike when a degenerate mesh settled). Just
          // skip it; a genuine structural change will rebuild if needed.
          if (rec.box) this._dirtyBoxes.push(rec.box.clone());
          dirty = true;
        }
      }
    });
    return dirty;
  }

  #meshWorldBox(mesh) {
    const geometry = mesh.geometry;
    if (!geometry?.boundingBox) geometry?.computeBoundingBox?.();
    if (!geometry?.boundingBox) return null;
    return geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  }

  /**
   * Uploads ONLY the changed voxel span of the static buffers instead of the
   * whole buffer. three's WebGPU backend honours `updateRanges` (partial
   * `writeBuffer`); a plain `needsUpdate` re-uploads the entire buffer — tens
   * of MB at high voxelRes, ~46 ms of `writeBuffer` on every re-voxelize (the
   * measured "hitch when I move"). We mark the contiguous linear span from the
   * region's min to max cell (over-covers only the rows between, still a small
   * fraction of the grid for a normal object).
   */
  #uploadVoxelRegion(vol, x0, y0, z0, x1, y1, z1) {
    const { dims } = vol.grid;
    const stride = dims.x * dims.y;
    const minIdx = x0 + y0 * dims.x + z0 * stride;
    const maxIdx = (x1 - 1) + (y1 - 1) * dims.x + (z1 - 1) * stride;
    const count = Math.max(1, maxIdx - minIdx + 1);
    for (const buf of [
      vol.buffers.voxStaticAlbedo,
      vol.buffers.voxStaticNormal,
      vol.buffers.voxStaticEmissive,
    ]) {
      buf.addUpdateRange(minIdx, count);
      buf.needsUpdate = true;
    }
  }

  #clearStaticFootprint(box) {
    if (!box || box.isEmpty()) return;
    for (const vol of this.volumes) {
      if (!vol.voxelReady) continue;
      const { min, dims, voxelSize } = vol.grid;
      const x0 = Math.max(0, Math.floor((box.min.x - min.x) / voxelSize));
      const y0 = Math.max(0, Math.floor((box.min.y - min.y) / voxelSize));
      const z0 = Math.max(0, Math.floor((box.min.z - min.z) / voxelSize));
      const x1 = Math.min(dims.x, Math.floor((box.max.x - min.x) / voxelSize) + 1);
      const y1 = Math.min(dims.y, Math.floor((box.max.y - min.y) / voxelSize) + 1);
      const z1 = Math.min(dims.z, Math.floor((box.max.z - min.z) / voxelSize) + 1);
      if (x0 >= x1 || y0 >= y1 || z0 >= z1) continue;
      const albedo = vol.buffers.voxStaticAlbedo.array;
      const normal = vol.buffers.voxStaticNormal.array;
      const emissive = vol.buffers.voxStaticEmissive.array;
      for (let z = z0; z < z1; z++) {
        for (let y = y0; y < y1; y++) {
          let index = x0 + y * dims.x + z * dims.x * dims.y;
          for (let x = x0; x < x1; x++, index++) {
            albedo[index] = 0;
            normal[index] = 0;
            emissive[index] = 0;
          }
        }
      }
      this.#uploadVoxelRegion(vol, x0, y0, z0, x1, y1, z1);
      vol.staticDirty = true;
      vol.pendingUpdate = true;
      // Do not interpret a long idle period as elapsed transition time. That
      // made the first post-edit radiance step take the 35% cap and visibly
      // jump; start the response clock now so opacity/light fade from frame 1.
      vol.lastRadianceFrame = this._frame;
      this.#requestConvergence(vol, CONVERGENCE_SWEEPS);
    }
  }

  #skipMesh = (mesh) => {
    const rec = this._motion.get(mesh);
    return rec?.dynamic === true && rec.settling !== true;
  };

  /** Retires dynamic copies only after their settled static bake is complete. */
  #finalizeSettledDynamics() {
    let changed = false;
    forEachVoxelizableMesh(this.engine.scene, (mesh) => {
      const rec = this._motion.get(mesh);
      if (!rec?.dynamic || !rec.settling) return;
      rec.dynamic = false;
      rec.settling = false;
      changed = true;
    });
    if (changed) {
      this._dynSynced = false;
      this._dynamicSetDirty = true;
    }
  }

  /**
   * Keeps the GPU dynamic layer in sync: re-extracts the triangle pool when
   * the dynamic mesh set changes (on the motion-poll cadence), refreshes the
   * world-matrix table every frame, and computes which volumes the movers
   * overlap. Volumes that see dynamics are kept converging so the round-robin
   * serves them (and their live grid recomposes) while motion lasts; once
   * everything settles the volumes converge back to zero per-frame work.
   */
  #syncDynamicPool() {
    const pool = this._dynPool;
    this._dynActive.length = 0;
    if (!pool) return;
    const enabled = this.component?.props?.dynamicObjects !== false;
    if (enabled !== this._dynamicObjectsEnabled) {
      this._dynamicObjectsEnabled = enabled;
      this._dynamicSetDirty = true;
    }
    if (!enabled) {
      if (pool.count) pool.sync([]);
      return;
    }
    if (this._dynamicSetDirty || !this._dynSynced) {
      this._dynSynced = true;
      this._dynamicSetDirty = false;
      const list = [];
      forEachVoxelizableMesh(this.engine.scene, (mesh) => {
        if (this._motion.get(mesh)?.dynamic) list.push(mesh);
      });
      pool.sync(list);
    }
    if (!pool.count) return;
    pool.updateMatrices();
    for (let i = 0; i < this.volumes.length; i++) {
      const vol = this.volumes[i];
      const active = this.#volumeSeesDynamics(vol, pool);
      this._dynActive[i] = active;
      if (active && vol.voxelReady) {
        vol.lastDynamicFrame = this._frame;
        this.#requestConvergence(vol, 1);
      }
    }
  }

  /**
   * True when any pooled mesh's world AABB intersects this volume AND the
   * mesh isn't sub-voxel there. Outer cascades skip small movers entirely —
   * a crate can't fill one 4× voxel, but its per-frame refresh would still
   * rerun the cascade's whole shadow-march pass.
   */
  #volumeSeesDynamics(vol, pool) {
    const { min, dims, voxelSize } = vol.grid;
    _dynGridBox.min.copy(min);
    _dynGridBox.max.set(
      min.x + dims.x * voxelSize,
      min.y + dims.y * voxelSize,
      min.z + dims.z * voxelSize,
    );
    for (let i = 0; i < pool.meshes.length; i++) {
      if (pool.maxDims[i] < voxelSize * 0.75) continue;
      if (pool.boxes[i]?.intersectsBox(_dynGridBox)) return true;
    }
    return false;
  }

  /** Camera-position center shared by every nested clipmap. */
  #targetPosition(out) {
    const cam = this.engine.camera;
    if (cam) {
      cam.getWorldPosition(out);
      return out;
    }
    return this.component.entity.object3D.getWorldPosition(out);
  }

  /**
   * Scrolls one cascade toward `target` in whole probe-spacing steps.
   * Voxels shift on the CPU (row memcpys) and only newly exposed slabs
   * re-voxelize; probe irradiance shifts on the GPU via scratch-copy +
   * gather, with the octa atlas rewritten in the same pass. A jump larger
   * than the grid falls back to a full rebuild of the content.
   */
  #maybeRecenter(vol, target) {
    // A completed staging voxelization may still be building its direct and
    // radiance cache. Keep the currently published origin stable until that
    // atomic publish finishes.
    if (vol.pendingRecenter) return;
    const sw = vol.spacingWorld;
    // Deadband: don't chase every probe-spacing step — recenter only once
    // the target drifts ~20% of the volume from center. An orbiting camera
    // with forward bias otherwise swings the target enough to recenter
    // nearly every frame: constant CPU shifts + slab voxelizes + buffer
    // uploads + probe reseeds (the "flickers hard when moving" report).
    const dx = target.x - vol.center.x;
    const dy = target.y - vol.center.y;
    const dz = target.z - vol.center.z;
    const { dims, voxelSize } = vol.grid;
    const band = (axisDim) => Math.max(sw, axisDim * voxelSize * 0.16);
    if (
      Math.abs(dx) < band(dims.x) &&
      Math.abs(dy) < band(dims.y) &&
      Math.abs(dz) < band(dims.z)
    ) {
      return;
    }
    const steps = {
      x: Math.round(dx / sw),
      y: Math.round(dy / sw),
      z: Math.round(dz / sw),
    };
    if (!steps.x && !steps.y && !steps.z) return;
    const sVox = {
      x: steps.x * vol.spacingVox,
      y: steps.y * vol.spacingVox,
      z: steps.z * vol.spacingVox,
    };
    const teleport =
      Math.abs(sVox.x) >= dims.x || Math.abs(sVox.y) >= dims.y || Math.abs(sVox.z) >= dims.z;

    // Keep serving the last complete volume while its initial build is in
    // flight. Once ready, the normal staged recenter path below catches up.
    if (!vol.voxelReady) return;

    // Survivor path: single-flight, staged, atomic (see #recenterVoxelize).
    // Skip if ANY cascade already has a voxelize job running — that both
    // prevents cascades from stacking their voxelization into one frame (the
    // 8→40ms spike) and lets the in-flight job finish. The volume holds its
    // correct old center until the job swaps the new content in; the deadband
    // tolerates that lag.
    // Do not start a new recenter until the previous one's light cache has
    // REALIGNED to the new center. injectDirect rebuilds both the sun and the
    // emissive receiver caches over ~16 chunked frames (hidden by the cascade
    // fade); a fresh recenter that interrupts that leaves the direct/emissive
    // cache misaligned to the new center — the "lighting settles wrong" report
    // once recentering became frequent enough to overlap. (Only the realign
    // sweep is gated, not the slower emissive refinement blend, which can be
    // interrupted harmlessly.)
    if (
      this.volumes.some(
        (v) => v.voxelJob || v.pendingRecenter || v.directStepsRemaining > 0,
      )
    ) {
      return;
    }
    const newCenter = new THREE.Vector3(
      vol.center.x + steps.x * sw,
      vol.center.y + steps.y * sw,
      vol.center.z + steps.z * sw,
    );
    const newMin = new THREE.Vector3(
      vol.grid.min.x + sVox.x * voxelSize,
      vol.grid.min.y + sVox.y * voxelSize,
      vol.grid.min.z + sVox.z * voxelSize,
    );
    this.#recenterVoxelize(vol, newMin, newCenter, steps, teleport);
  }

  #cancelVoxelize(vol) {
    const job = vol?.voxelJob;
    if (!job) return false;
    job.token.cancelled = true;
    vol.voxelJob = null;
    return true;
  }

  /**
   * Rebakes only the regions touched by settled movers, in place, into the
   * existing static buffers — the cheap path that replaces a full-scene
   * rescan on every object move. Cost is proportional to the changed
   * footprint, not the scene triangle count.
   *
   * Per volume: union the changed world boxes into a voxel region (already
   * dilated a voxel when accumulated), clamp to the grid, and — unless the
   * region covers a large fraction of the grid, where a full rebake is
   * simpler — voxelize just that region from every intersecting mesh, then
   * reclassify ambiguous cells locally. The global exterior BFS is skipped:
   * the lighting shaders read the ambiguous (junction) bit but not the
   * exterior bit, so a bounded local pass is sufficient.
   *
   * Writing in place is safe against the GPU: the live grid only re-reads the
   * static buffers when `staticDirty` fires (the copy pass), which is set only
   * after the bake completes and `needsUpdate` re-uploads the finished buffer.
   */
  #voxelizeIncremental(boxes) {
    if (!boxes.length) return;
    const promises = [];
    for (const vol of this.volumes) {
      if (!vol.voxelReady) continue;
      const { min, dims, voxelSize } = vol.grid;
      // Convert each dirty box to a clamped, 1-voxel-dilated region. Baking
      // them SEPARATELY (not as one bounding union) is what keeps a long drag
      // cheap: the start and end footprints are each small even when far
      // apart, whereas their union could span — and rebuild — most of the
      // volume (the "200 ms spike when I move an object" report).
      const regions = [];
      for (const b of boxes) {
        if (!b || b.isEmpty()) continue;
        const r = {
          x0: Math.max(0, Math.floor((b.min.x - min.x) / voxelSize) - 1),
          y0: Math.max(0, Math.floor((b.min.y - min.y) / voxelSize) - 1),
          z0: Math.max(0, Math.floor((b.min.z - min.z) / voxelSize) - 1),
          x1: Math.min(dims.x, Math.floor((b.max.x - min.x) / voxelSize) + 2),
          y1: Math.min(dims.y, Math.floor((b.max.y - min.y) / voxelSize) + 2),
          z1: Math.min(dims.z, Math.floor((b.max.z - min.z) / voxelSize) + 2),
        };
        if (r.x0 >= r.x1 || r.y0 >= r.y1 || r.z0 >= r.z1) continue;
        regions.push(r);
      }
      if (!regions.length) continue;
      // Merge only regions that actually overlap, so an in-place nudge does
      // not bake the same cells twice while a far drag stays two small boxes.
      const merged = [];
      const overlaps = (a, c) =>
        a.x0 < c.x1 && c.x0 < a.x1 && a.y0 < c.y1 && c.y0 < a.y1 && a.z0 < c.z1 && c.z0 < a.z1;
      for (const r of regions) {
        const m = merged.find((c) => overlaps(r, c));
        if (m) {
          m.x0 = Math.min(m.x0, r.x0); m.y0 = Math.min(m.y0, r.y0); m.z0 = Math.min(m.z0, r.z0);
          m.x1 = Math.max(m.x1, r.x1); m.y1 = Math.max(m.y1, r.y1); m.z1 = Math.max(m.z1, r.z1);
        } else {
          merged.push({ ...r });
        }
      }
      const totalCells = merged.reduce(
        (s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0) * (r.z1 - r.z0),
        0,
      );
      if (totalCells > vol.grid.count * 0.4) {
        // Genuinely large change: a full rebake is not much dearer.
        promises.push(this.#voxelize(vol));
        continue;
      }
      this.#cancelVoxelize(vol);
      const token = { cancelled: false };
      const grid = {
        ...vol.grid,
        min: vol.grid.min.clone(),
        dims: { ...vol.grid.dims },
      };
      const target = {
        albedo: vol.buffers.voxStaticAlbedo.array,
        normal: vol.buffers.voxStaticNormal.array,
        emissive: vol.buffers.voxStaticEmissive.array,
      };
      const run = async () => {
        for (const r of merged) {
          if (token.cancelled) return;
          const result = await voxelizeRegionAsync(
            this.engine.scene, grid, target, r,
            { skip: this.#skipMesh, signal: token, timeSliceMs: 5 },
          );
          if (token.cancelled || result?.cancelled || vol.voxelJob?.token !== token) return;
          // Reclassify ambiguous cells one voxel beyond the baked region: a
          // cell's junction status depends on its neighbours' occupancy.
          reclassifyAmbiguousRegion(target.albedo, target.normal, grid.dims, {
            x0: Math.max(0, r.x0 - 1), y0: Math.max(0, r.y0 - 1), z0: Math.max(0, r.z0 - 1),
            x1: Math.min(dims.x, r.x1 + 1), y1: Math.min(dims.y, r.y1 + 1), z1: Math.min(dims.z, r.z1 + 1),
          });
        }
      };
      const promise = run()
        .then(() => {
          if (token.cancelled || vol.voxelJob?.token !== token) return;
          vol.voxelJob = null;
          // Upload only the baked regions (+ the 1-voxel ambiguous halo), not
          // the whole multi-MB buffer.
          for (const r of merged) {
            this.#uploadVoxelRegion(
              vol,
              Math.max(0, r.x0 - 1), Math.max(0, r.y0 - 1), Math.max(0, r.z0 - 1),
              Math.min(dims.x, r.x1 + 1), Math.min(dims.y, r.y1 + 1), Math.min(dims.z, r.z1 + 1),
            );
          }
          vol.staticDirty = true;
          vol.pendingUpdate = true;
          vol.lastRadianceFrame = this._frame;
          this.#requestConvergence(vol, CONVERGENCE_SWEEPS);
          if (vol === this.volumes[0] && this._debugView === "voxels") {
            this.#buildDebugMesh();
          }
        })
        .catch((err) => {
          if (!token.cancelled) {
            console.error(`[gi] incremental voxelization failed: ${err.message}`);
          }
        })
        .finally(() => {
          if (vol.voxelJob?.token === token) vol.voxelJob = null;
        });
      vol.voxelJob = { token, promise };
      promises.push(promise);
    }
    // Retire settled dynamic copies once their static footprint has landed, so
    // the mover stops costing a per-frame splat without a one-frame vanish.
    Promise.all(promises).then(() => this.#finalizeSettledDynamics());
  }

  /** Full scene rebuilds run one cascade at a time to avoid stacked slices. */
  #voxelizeAll() {
    const generation = ++this._voxelizeGeneration;
    for (const vol of this.volumes) {
      this.#cancelVoxelize(vol);
      vol.pendingRecenter = null;
      vol.cascadeTarget = 1;
      vol.nodes.uniforms.updateGridMin.value.copy(vol.grid.min);
    }
    const run = async () => {
      for (const vol of this.volumes) {
        if (generation !== this._voxelizeGeneration) return;
        await this.#voxelize(vol);
      }
      if (generation === this._voxelizeGeneration) {
        this.#finalizeSettledDynamics();
      }
    };
    this._voxelizePromise = run().finally(() => {
      if (generation === this._voxelizeGeneration) this._voxelizePromise = null;
    });
  }

  #voxelize(vol) {
    this.#cancelVoxelize(vol);
    const t0 = performance.now();
    const { dims } = vol.grid;
    // Build off to the side. Compute keeps using the previous complete grid
    // until all channels can be published atomically.
    const target = {
      albedo: new Uint32Array(vol.grid.count),
      normal: new Uint32Array(vol.grid.count),
      emissive: new Uint32Array(vol.grid.count),
    };
    const grid = { ...vol.grid, min: vol.grid.min.clone(), dims: { ...vol.grid.dims } };
    const token = { cancelled: false };
    const promise = voxelizeRegionAsync(
      this.engine.scene,
      grid,
      target,
      { x0: 0, y0: 0, z0: 0, x1: dims.x, y1: dims.y, z1: dims.z },
      {
        skip: this.#skipMesh,
        signal: token,
        // Nothing useful is on screen before the first bake publishes, so
        // the initial build takes most of the frame budget: at the old 2 ms
        // slice (plus the browser's ~4 ms setTimeout clamp between slices)
        // a couple of seconds of CPU voxelization stretched into the
        // reported 15–25 s startup. Content rebakes stay small enough to
        // coexist with interactive editing.
        timeSliceMs: vol.voxelReady ? 5 : 12,
      },
    )
      .then(async (result) => {
        if (token.cancelled || result.cancelled || vol.voxelJob?.token !== token) return result;
        const enclosure = await markExteriorEmptyVoxelsAsync(
          target.albedo,
          target.normal,
          grid.dims,
          { signal: token },
        );
        if (token.cancelled || vol.voxelJob?.token !== token) return result;
        vol.voxelJob = null;
        this.#logEnclosure(vol, enclosure);
        vol.buffers.voxStaticAlbedo.array.set(target.albedo);
        vol.buffers.voxStaticNormal.array.set(target.normal);
        vol.buffers.voxStaticEmissive.array.set(target.emissive);
        // Whole-buffer change: clear any pending partial range so three
        // uploads the entire buffer, not just a stale region.
        vol.buffers.voxStaticAlbedo.clearUpdateRanges();
        vol.buffers.voxStaticNormal.clearUpdateRanges();
        vol.buffers.voxStaticEmissive.clearUpdateRanges();
        vol.buffers.voxStaticAlbedo.needsUpdate = true;
        vol.buffers.voxStaticNormal.needsUpdate = true;
        vol.buffers.voxStaticEmissive.needsUpdate = true;
        vol.staticDirty = true; // live grid recomposes on this volume's next update
        vol.voxelReady = true;
        vol.pendingUpdate = true;
        this.#requestConvergence(vol, CONVERGENCE_SWEEPS);
        if (vol === this.volumes[0]) {
          if (this._debugView === "voxels") this.#buildDebugMesh();
          this.stats = {
            occupied: result.occupied,
            meshes: result.meshes,
            tris: result.tris,
            voxelMs: performance.now() - t0,
          };
        }
        return result;
      })
      .catch((err) => {
        if (!token.cancelled) console.error(`[gi] voxelization failed: ${err.message}`);
      });
    vol.voxelJob = { token, promise };
    return promise;
  }

  /**
   * Survivor-preserving recenter as a single-flight, time-sliced voxelize
   * into STAGING at the new center, swapped in atomically on completion.
   * Nothing moves until the swap, which is what fixes both symptoms at once:
   *   - No spike: voxelization is spread over frames, and #maybeRecenter's
   *     single-flight guard keeps two cascades from voxelizing in one frame.
   *   - No white flash: the live grid is never partially empty. The old
   *     approach shifted survivors and uploaded ZEROED exposed slabs before
   *     filling them — for a few frames those cones hit nothing and returned
   *     sky, flashing the surface white.
   * The buffers, gridMin, and probe shift all publish in the same frame, so
   * materials never sample new coordinates against old content. The volume
   * lags its target by the job's handful of frames (deadband tolerates it).
   */
  #recenterVoxelize(vol, newMin, newCenter, steps, teleport = false) {
    this.#cancelVoxelize(vol);
    const { dims } = vol.grid;
    const target = {
      albedo: new Uint32Array(vol.grid.count),
      normal: new Uint32Array(vol.grid.count),
      emissive: new Uint32Array(vol.grid.count),
    };
    const grid = { ...vol.grid, min: newMin.clone(), dims: { ...dims } };
    const token = { cancelled: false };
    // Voxel shift in whole voxels (probe steps × voxels-per-probe-spacing).
    const sVox = {
      x: steps.x * vol.spacingVox,
      y: steps.y * vol.spacingVox,
      z: steps.z * vol.spacingVox,
    };
    // A full-volume rebuild takes seconds and, being single-flight, BLOCKS
    // every further recenter until it finishes — so the clipmap could not keep
    // up with the camera, lagged far behind, and caught up in one lurching
    // recenter with a deep fade-to-coarse (the "old lighting flashes" report).
    // Instead scroll the survivors (toroidal shift) and re-voxelize only the
    // newly exposed boundary slabs; the boundary is a small fraction of the
    // volume, so this completes in a frame or two and tracks the camera.
    const canShift =
      !teleport &&
      Math.abs(sVox.x) < dims.x &&
      Math.abs(sVox.y) < dims.y &&
      Math.abs(sVox.z) < dims.z;

    // The exposed slabs after shifting by sVox: for each axis the boundary on
    // the side the volume moved toward (its cells scrolled in as zeros).
    const exposedSlabs = () => {
      const full = { x0: 0, y0: 0, z0: 0, x1: dims.x, y1: dims.y, z1: dims.z };
      const slabs = [];
      if (sVox.x > 0) slabs.push({ ...full, x0: dims.x - sVox.x });
      else if (sVox.x < 0) slabs.push({ ...full, x1: -sVox.x });
      if (sVox.y > 0) slabs.push({ ...full, y0: dims.y - sVox.y });
      else if (sVox.y < 0) slabs.push({ ...full, y1: -sVox.y });
      if (sVox.z > 0) slabs.push({ ...full, z0: dims.z - sVox.z });
      else if (sVox.z < 0) slabs.push({ ...full, z1: -sVox.z });
      return slabs;
    };

    const build = async () => {
      if (!canShift) {
        // Teleport / grid-sized jump: no survivors, rebuild everything.
        const r = await voxelizeRegionAsync(
          this.engine.scene, grid, target,
          { x0: 0, y0: 0, z0: 0, x1: dims.x, y1: dims.y, z1: dims.z },
          { skip: this.#skipMesh, signal: token, timeSliceMs: 6 },
        );
        if (token.cancelled || r.cancelled) return { cancelled: true };
        await markExteriorEmptyVoxelsAsync(target.albedo, target.normal, grid.dims, { signal: token });
        return { cancelled: token.cancelled };
      }
      // Scroll survivors into target, then fill only the exposed slabs.
      const scratch = new Uint32Array(vol.grid.count);
      target.albedo.set(vol.buffers.voxStaticAlbedo.array); shiftGrid(target.albedo, dims, sVox, scratch);
      target.normal.set(vol.buffers.voxStaticNormal.array); shiftGrid(target.normal, dims, sVox, scratch);
      target.emissive.set(vol.buffers.voxStaticEmissive.array); shiftGrid(target.emissive, dims, sVox, scratch);
      for (const region of exposedSlabs()) {
        if (token.cancelled) return { cancelled: true };
        const r = await voxelizeRegionAsync(
          this.engine.scene, grid, target, region,
          { skip: this.#skipMesh, signal: token, timeSliceMs: 6 },
        );
        if (token.cancelled || r.cancelled) return { cancelled: true };
        // Local ambiguous re-tag at the seam (survivors kept their bits under
        // the shift; only the new slab + its one-voxel border need it).
        reclassifyAmbiguousRegion(target.albedo, target.normal, dims, {
          x0: Math.max(0, region.x0 - 1), y0: Math.max(0, region.y0 - 1), z0: Math.max(0, region.z0 - 1),
          x1: Math.min(dims.x, region.x1 + 1), y1: Math.min(dims.y, region.y1 + 1), z1: Math.min(dims.z, region.z1 + 1),
        });
      }
      return { cancelled: token.cancelled };
    };

    const promise = build()
      .then(async (result) => {
        if (token.cancelled || result?.cancelled || vol.voxelJob?.token !== token) return;
        vol.voxelJob = null;
        // Publish only the static staging data here. Direct lighting and the
        // radiance pyramid are built over subsequent bounded update frames;
        // the visible origin remains unchanged until all of them are ready.
        vol.buffers.voxStaticAlbedo.array.set(target.albedo);
        vol.buffers.voxStaticNormal.array.set(target.normal);
        vol.buffers.voxStaticEmissive.array.set(target.emissive);
        // Whole-buffer change: clear any pending partial range so three
        // uploads the entire buffer, not just a stale region.
        vol.buffers.voxStaticAlbedo.clearUpdateRanges();
        vol.buffers.voxStaticNormal.clearUpdateRanges();
        vol.buffers.voxStaticEmissive.clearUpdateRanges();
        vol.buffers.voxStaticAlbedo.needsUpdate = true;
        vol.buffers.voxStaticNormal.needsUpdate = true;
        vol.buffers.voxStaticEmissive.needsUpdate = true;
        vol.staticDirty = true; // live grid recomposes on this volume's next update
        vol.nodes.uniforms.updateGridMin.value.copy(newMin);
        vol.pendingRecenter = {
          newMin: newMin.clone(),
          newCenter: newCenter.clone(),
          steps: { ...steps },
          teleport,
          prepared: false,
        };
        vol.cascadeTarget = 0;
        vol.voxelReady = true;
        this.#requestConvergence(
          vol,
          teleport ? CONVERGENCE_SWEEPS : RECENTER_SWEEPS,
        );
        // pendingUpdate makes the round-robin start the staged direct cache
        // on the next render frame.
        vol.pendingUpdate = true;
        if (this._debugView !== "off" && vol === this.volumes[0]) this.#buildDebugMesh();
      })
      .catch((err) => {
        if (!token.cancelled) console.error(`[gi] recenter voxelize failed: ${err.message}`);
      });
    vol.voxelJob = { token, promise };
  }

  /**
   * Snapshots every scene emission source once per frame. The primary
   * directional light keeps its dedicated cached path; additional
   * directionals, point/spot lights, and emissive-mesh proxies share the
   * bounded source buffer below. Emissive voxels preserve the visible/glowing
   * surface; the proxy supplies its finite-area direct irradiance so a small
   * source still lights the scene when it is off-screen or missed by a cone.
   */
  #collectEmissionSources(sun) {
    const result = [];
    this.engine.scene.traverse((light) => {
      if (
        !light?.isLight ||
        light === sun ||
        light.isGIProbeVolumeLight ||
        light.isAmbientLight ||
        !isEffectivelyVisible(light) ||
        (!light.isDirectionalLight && !light.isPointLight && !light.isSpotLight) ||
        !(light.intensity > 0)
      ) {
        return;
      }

      _localLightDir.set(0, 0, -1);
      _localLightPos.set(0, 0, 0);
      let range = Infinity;
      let outerCos = -1;
      let innerCos = -1;
      let type = 0;
      let decay = 0;
      if (light.isDirectionalLight) {
        type = 2;
        // Match Three's target-based directional-light convention.
        this.#lightTravelDirection(light, _localLightDir);
      } else {
        light.getWorldPosition(_localLightPos);
        const configuredRange = Number(light.distance) || 0;
        range =
          configuredRange > 0
            ? configuredRange
            : Math.min(
                64,
                Math.max(8, Math.sqrt(Math.max(light.intensity, 0) / 0.01)),
              );
        decay = Math.max(0, Number(light.decay) || 0);
      }
      if (light.isSpotLight) {
        type = 1;
        light.target.getWorldPosition(_localLightTarget);
        _localLightDir
          .copy(_localLightTarget)
          .sub(_localLightPos)
          .normalize();
        outerCos = Math.cos(light.angle);
        innerCos = Math.cos(light.angle * (1 - light.penumbra));
      }

      result.push({
        intensity: light.intensity,
        position: _localLightPos.clone(),
        direction: _localLightDir.clone(),
        range,
        color: light.color.clone().multiplyScalar(light.intensity),
        type,
        // For punctual lights the existing Radius control becomes a physical
        // source-size hint for SDF GI shadows. A small nonzero default avoids
        // mathematically hard voxel-quantized penumbras.
        sourceRadius:
          type === 2
            ? 0
            : Math.max(0.05, (Number(light.shadow?.radius) || 0) * 0.1),
        outerCos,
        innerCos,
        decay,
      });
    });

    // Material graphs compile asynchronously and shared .mat assets can
    // update without replacing the mesh. Periodically rescan the inexpensive
    // constant emissive slots so a graph that finished after the first GI
    // tick cannot remain invisible to lighting forever.
    if (this._frame % 30 === 0) this._emissiveSourcesDirty = true;
    if (this._emissiveSourcesDirty) {
      this._emissiveSourcesDirty = false;
      const nextSources = [];
      forEachVoxelizableMesh(this.engine.scene, (mesh) => {
        readMeshGIColors(mesh, _emissionAlbedo, _emissionColor);
        _emissionColor.multiplyScalar(EMISSIVE_SCALE);
        if (
          Math.max(
            _emissionColor.r,
            _emissionColor.g,
            _emissionColor.b,
          ) > 1e-4
        ) {
          nextSources.push({
            mesh,
            radiance: _emissionColor.clone(),
          });
        }
      });
      const nextHash = nextSources
        .map(
          ({ mesh, radiance }) =>
            `${mesh.uuid}:${radiance.r.toFixed(5)},${radiance.g.toFixed(5)},${radiance.b.toFixed(5)}`,
        )
        .sort()
        .join("|");
      if (
        this._emissiveSourceHash !== null &&
        nextHash !== this._emissiveSourceHash
      ) {
        this._voxelsDirtyAt = performance.now();
      }
      this._emissiveSourceHash = nextHash;
      this._emissiveSources = nextSources;
    }

    for (const source of this._emissiveSources) {
      const mesh = source.mesh;
      if (
        !isEffectivelyVisible(mesh) ||
        !mesh.geometry?.getAttribute?.("position")
      ) {
        continue;
      }
      _emissionColor.copy(source.radiance);
      const peak = Math.max(
        _emissionColor.r,
        _emissionColor.g,
        _emissionColor.b,
      );
      if (!(peak > 1e-4)) continue;

      mesh.updateWorldMatrix(true, false);
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      geometry.boundingBox.getCenter(_emissionPosition);
      _emissionPosition
        .applyMatrix4(mesh.matrixWorld);
      geometry.boundingBox.getSize(_emissionBoxSize);
      const me = mesh.matrixWorld.elements;
      _emissionAxisX.set(me[0], me[1], me[2]);
      _emissionAxisY.set(me[4], me[5], me[6]);
      _emissionAxisZ.set(me[8], me[9], me[10]);
      const axes = [
        {
          span: _emissionBoxSize.x * _emissionAxisX.length(),
          direction: _emissionAxisX,
        },
        {
          span: _emissionBoxSize.y * _emissionAxisY.length(),
          direction: _emissionAxisY,
        },
        {
          span: _emissionBoxSize.z * _emissionAxisZ.length(),
          direction: _emissionAxisZ,
        },
      ].sort((a, b) => b.span - a.span);
      const basisU = axes[0].direction.clone().normalize();
      const basisV = axes[1].direction.clone().normalize();
      const halfWidth = Math.max(0.01, axes[0].span * 0.5);
      const halfHeight = Math.max(0.01, axes[1].span * 0.5);
      const halfThickness = Math.max(0.001, axes[2].span * 0.5);
      const radius = Math.hypot(halfWidth, halfHeight);
      // Largest transformed bounding-box face becomes a stable rectangular
      // area proxy. Four shader samples integrate its visibility instead of
      // casting one inaccurate point-source shadow from the centre.
      const area = Math.min(
        16,
        Math.max(0.04, 4 * halfWidth * halfHeight),
      );
      const color = _emissionColor.clone().multiplyScalar(area);
      const intensity = Math.max(color.r, color.g, color.b);
      const range = Math.min(
        64,
        Math.max(radius * 2 + 1, radius + Math.sqrt(intensity / 0.01)),
      );
      result.push({
        intensity,
        position: _emissionPosition.clone(),
        range,
        color,
        type: 3,
        basisU,
        basisV,
        halfWidth,
        halfHeight,
        halfThickness,
        sourceRadius: radius,
        outerCos: -1,
        innerCos: -1,
        decay: 2,
      });
    }
    return result;
  }

  /**
   * Uploads the strongest bounded emission sources affecting this clipmap:
   * additional directionals, point/spot lights, and off-volume emissive
   * proxies. Sources may sit outside the voxel box as long as their influence
   * overlaps it, preserving off-screen lighting around the camera.
   */
  #updateLocalLights(vol, localLights) {
    const candidates = [];
    const gridMax = _gridMax.copy(vol.grid.min).add(
      _gridExtent.set(
        vol.grid.dims.x,
        vol.grid.dims.y,
        vol.grid.dims.z,
      ).multiplyScalar(vol.grid.voxelSize),
    );

    for (const light of localLights) {
      if (light.type === 2) {
        // Directional sources overlap every clipmap. Weight them highly so a
        // nearby punctual source cannot evict an infinite light accidentally.
        candidates.push({ ...light, score: light.intensity * 4 });
        continue;
      }
      // Sphere/AABB intersection: retain sources just outside the volume if
      // their light can still reach receivers inside it.
      _closestPoint.copy(light.position).clamp(vol.grid.min, gridMax);
      if (
        _closestPoint.distanceToSquared(light.position) >
        light.range * light.range
      ) {
        continue;
      }
      const centerDistanceSq = light.position.distanceToSquared(vol.center);
      candidates.push({
        ...light,
        score:
          light.intensity /
          (1 + centerDistanceSq / Math.max(light.range * light.range, 1)),
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates.slice(0, MAX_LOCAL_LIGHTS);
    const signature = selected
      .map(
        (entry) => {
          const orientation =
            entry.type === 3
              ? `${entry.basisU.x.toFixed(3)},${entry.basisU.y.toFixed(3)},${entry.basisU.z.toFixed(3)},` +
                `${entry.basisV.x.toFixed(3)},${entry.basisV.y.toFixed(3)},${entry.basisV.z.toFixed(3)},` +
                `${entry.halfWidth.toFixed(3)},${entry.halfHeight.toFixed(3)},${entry.halfThickness.toFixed(3)}`
              : `${entry.direction.x.toFixed(3)},${entry.direction.y.toFixed(3)},${entry.direction.z.toFixed(3)},` +
                `${entry.outerCos.toFixed(3)},${entry.innerCos.toFixed(3)},${entry.decay.toFixed(2)},` +
                `${entry.sourceRadius.toFixed(3)}`;
          return (
            `${entry.position.x.toFixed(3)},${entry.position.y.toFixed(3)},${entry.position.z.toFixed(3)},` +
            `${entry.range.toFixed(3)},${entry.color.r.toFixed(3)},${entry.color.g.toFixed(3)},${entry.color.b.toFixed(3)},` +
            `${entry.type},${orientation}`
          );
        },
      )
      .join("|");
    if (signature === vol.localLightHash) {
      vol.nodes.uniforms.localLightCount.value = selected.length;
      return false;
    }
    vol.localLightHash = signature;

    const lightData = vol.buffers.lightData.array;
    lightData.fill(0);
    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i];
      const o = i * 20;
      lightData.set(
        [entry.position.x, entry.position.y, entry.position.z, entry.range],
        o,
      );
      lightData.set(
        [entry.color.r, entry.color.g, entry.color.b, entry.type],
        o + 4,
      );
      if (entry.type === 3) {
        lightData.set(
          [
            entry.basisU.x,
            entry.basisU.y,
            entry.basisU.z,
            entry.halfWidth,
          ],
          o + 8,
        );
        lightData.set(
          [
            entry.basisV.x,
            entry.basisV.y,
            entry.basisV.z,
            entry.halfHeight,
          ],
          o + 12,
        );
        lightData.set(
          [0, 0, 0, entry.halfThickness],
          o + 16,
        );
      } else {
        lightData.set(
          [
            entry.direction.x,
            entry.direction.y,
            entry.direction.z,
            entry.outerCos,
          ],
          o + 8,
        );
        lightData.set(
          [entry.innerCos, entry.decay, entry.sourceRadius, 0],
          o + 12,
        );
        lightData.set([0, 0, 0, 0], o + 16);
      }
    }
    vol.buffers.lightData.needsUpdate = true;
    vol.nodes.uniforms.localLightCount.value = selected.length;
    return true;
  }

  #updateUniforms(vol, sun) {
    const u = vol.nodes.uniforms;
    const p = this.component.props;
    u.cascadeHalfExtent.value =
      Math.min(
        vol.grid.dims.x,
        vol.grid.dims.y,
        vol.grid.dims.z,
      ) *
      vol.grid.voxelSize *
      0.5;
    const response = Math.min(
      2,
      Math.max(0.05, p.lightingResponse ?? 0.5),
    );
    const cascadeAlpha = 1 - Math.exp(-this._deltaTime / response);
    this.#targetPosition(_worldPos);
    u.cascadeCenter.value.copy(_worldPos);
    vol.cascadeBlend +=
      (vol.cascadeTarget - vol.cascadeBlend) * cascadeAlpha;
    if (Math.abs(vol.cascadeTarget - vol.cascadeBlend) < 1e-3) {
      vol.cascadeBlend = vol.cascadeTarget;
    }
    u.cascadeBlend.value = vol.cascadeBlend;
    u.intensity.value = Math.max(0, p.intensity ?? 1);
    u.bounce.value = Math.max(0, p.bounce ?? 1);
    const configuredHysteresis = Math.min(
      0.99,
      Math.max(0, p.hysteresis ?? 0.8),
    );
    // A finite invalidation/convergence window must actually reach the new
    // solution. With e.g. 0.97 history and six sweeps, 83% of black/stale
    // lighting survived; moving an object merely kept scheduling sweeps until
    // it eventually looked correct. While work is pending, converge with a
    // bounded half-life, then restore the user's high steady-state stability.
    const idx = this.volumes.indexOf(vol);
    const recentlyDynamic =
      this._dynActive[idx] === true ||
      this._frame - (vol.lastDynamicFrame ?? -1e9) < DYNAMIC_GRACE_FRAMES;
    const pendingWork =
      vol.updatesRemaining > 0 ||
      vol.directStepsRemaining > 0 ||
      vol.emissiveBlendStepsRemaining > 0 ||
      vol.staticDirty ||
      vol.pendingRecenter;
    // 0.35 during any convergence work (moving or not). An earlier 0.15
    // motion cap converged faster but made probes adopt their noisy 64-ray
    // estimate too aggressively — visible flicker on moving objects. 0.35
    // keeps enough history to stay stable; speed comes from more sweeps +
    // realtimeInject, not from starving the temporal filter.
    u.hysteresis.value =
      recentlyDynamic || pendingWork
        ? Math.min(configuredHysteresis, 0.35)
        : configuredHysteresis;
    u.connectivityGate.value = this._dynActive[idx] === true ? 0 : 1;
    u.aoStrength.value = Math.min(1, Math.max(0, p.aoStrength ?? 0.4));
    u.aoRadius.value = Math.min(12, Math.max(1, p.aoRadius ?? 2.5));
    u.normalBias.value = Math.max(0, p.normalBias ?? 0.3);
    u.reflectionIntensity.value = Math.max(0, p.reflectionIntensity ?? 1);
    u.baseProbe.value = vol.baseProbe;
    u.probeMaxDistance.value =
      vol.grid.voxelSize *
      Math.hypot(
        vol.grid.dims.x,
        vol.grid.dims.y,
        vol.grid.dims.z,
      );
    _color.set(p.skyColor || "#87b7dc");
    _color.multiplyScalar(Math.max(0, p.skyIntensity ?? 1));
    if (vol.hasRadiance) {
      u.skyColor.value.lerp(
        _color,
        Math.min(0.35, 1 - Math.exp(-this._deltaTime / response)),
      );
    } else {
      u.skyColor.value.copy(_color);
    }
    const rayDataAvailable =
      this._rayDataReady &&
      !!vol.buffers.rayData &&
      !!this._rayLayout;
    const rayVisibilityEnabled =
      p.rayProxies === true &&
      p.emissiveRayVisibility === true &&
      rayDataAvailable;
    const rayEnabled =
      p.rayProxies === true &&
      rayDataAvailable &&
      p.triangleProbeRays === true;
    u.rayTracingEnabled.value = rayEnabled ? 1 : 0;
    u.rayVisibilityEnabled.value = rayVisibilityEnabled ? 1 : 0;
    if (rayDataAvailable) {
      u.rayTlasNodeCount.value =
        this._rayScene.tlasNodes.length / RAY_BVH_NODE_STRIDE;
      u.rayTlasNodesOffset.value = this._rayLayout.tlasNodes.offset;
      u.rayTlasInstancesOffset.value =
        this._rayLayout.tlasInstances.offset;
      u.rayInstancesOffset.value = this._rayLayout.instances.offset;
    } else {
      u.rayTlasNodeCount.value = 0;
    }

    if (sun) {
      this.#lightTravelDirection(sun, _sunDir);
      u.sunDir.value.copy(_sunDir);
      u.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
    } else {
      u.sunColor.value.setRGB(0, 0, 0);
    }
  }

  #updateDFShadowUniforms(sun) {
    if (!sun || !this._dfShadowUniforms) {
      this.#updateDFShadowReady(null);
      return;
    }
    // Direction from the receiver toward the directional source.
    this.#lightTravelDirection(sun, _sunDir);
    this._dfShadowUniforms.sunDirToLight.value.copy(_sunDir).negate();
    const radius = Math.max(0, Number(sun.shadow?.radius) || 0);
    this._dfShadowUniforms.softness.value = Math.min(
      0.12,
      Math.max(0.025, 0.025 + radius * 0.015),
    );
    const outer = this.volumes[Math.min(3, this.volumes.length - 1)];
    this._dfShadowUniforms.maxDistance.value = outer
      ? Math.min(
          512,
          Math.max(
            32,
            Math.max(
              outer.grid.dims.x,
              outer.grid.dims.y,
              outer.grid.dims.z,
            ) * outer.grid.voxelSize,
          ),
        )
      : 128;
    this.#updateDFShadowReady(sun);
  }

  #updateDFShadowReady(sun) {
    if (!this._dfShadowReady) return;
    // Per-mesh SDF shadows depend only on the instance table (an empty table
    // shades nothing), so the gate is simply "a sun exists to shadow".
    this._dfShadowReady.value = sun && this._meshShadows ? 1 : 0;
  }

  /**
   * Keeps visible analytic direct lighting consistent with GI visibility.
   * LightComponent intentionally defaults castShadow off for standalone
   * performance, but leaving it off while GI is active lets Three's raster
   * direct term pass through sealed rooms independently of the correctly
   * shadowed voxel transport. Active directional/point/spot lights therefore
   * receive normal shadow maps while GI is enabled. The optional DF path
   * replaces only the primary sun's shadow lookup.
   */
  #syncRealtimeShadows(sun) {
    const shadowMap = this.engine.renderer?.shadowMap;
    const autoDirectShadows =
      this.component?.props?.directShadows !== false;
    const dfEnabled =
      this.component?.props?.softShadows === true &&
      !!this._dfSunShadowNode;
    if (
      !shadowMap ||
      !this.volumes.length ||
      (!autoDirectShadows && !dfEnabled)
    ) {
      this.#restoreRealtimeShadows();
      return;
    }

    let patch = this._shadowPatch;
    if (!patch || patch.shadowMap !== shadowMap || !patch.lights) {
      this.#restoreRealtimeShadows();
      patch = this._shadowPatch = {
        shadowMap,
        lights: new Map(),
      };
    }

    const active = new Set();
    for (const entity of this.engine.entities.values()) {
      const component = entity.components?.get?.("light");
      const light = component?.light;
      if (
        component?.enabled === false ||
        !light?.shadow ||
        light.intensity <= 0 ||
        !isEffectivelyVisible(light) ||
        (!light.isDirectionalLight &&
          !light.isPointLight &&
          !light.isSpotLight)
      ) {
        continue;
      }
      if (autoDirectShadows || (dfEnabled && light === sun)) {
        active.add(light);
      }
    }

    for (const light of active) {
      let record = patch.lights.get(light);
      if (!record) {
        record = {
          castShadow: light.castShadow,
          shadowNode: light.shadow?.shadowNode,
          appliedShadowNode: light.shadow?.shadowNode,
        };
        patch.lights.set(light, record);
      }
      if (!light.castShadow) {
        light.castShadow = true;
        // A light that never cast shadows carries untuned bias values.
        // With bias/normalBias at 0, the depth map leaks direct sun through
        // butt-joined wall panels as bright blocky seams along every corner
        // — an artifact that looks like (and was chased as) a GI leak.
        if (
          light.shadow.bias === 0 &&
          light.shadow.normalBias === 0
        ) {
          record.bias = 0;
          record.normalBias = 0;
          light.shadow.bias = -0.0002;
          light.shadow.normalBias = 0.05;
        }
        light.shadow.needsUpdate = true;
      }
      const currentShadowNode = light.shadow?.shadowNode;
      const applied = record.appliedShadowNode;
      // The CSM node is replaced wholesale on renderer rebuilds and on
      // csm/csmCascades/csmMode/csmMaxFar changes; the patch must treat that
      // as a normal external swap and keep tracking the new node instead of
      // restoring the disposed one.
      const wasExternallyReplaced =
        currentShadowNode && applied && currentShadowNode !== applied;
      if (wasExternallyReplaced) {
        record.shadowNode = currentShadowNode;
      }
      const desiredShadowNode =
        dfEnabled && light === sun
          ? this._dfSunShadowNode
          : record.shadowNode;
      if (light.shadow.shadowNode !== desiredShadowNode) {
        light.shadow.shadowNode = desiredShadowNode;
        light.shadow.needsUpdate = true;
      }
      record.appliedShadowNode = desiredShadowNode;
    }

    for (const [light, record] of patch.lights) {
      if (active.has(light)) continue;
      const currentShadowNode = light.shadow?.shadowNode;
      const wasExternallyReplaced =
        currentShadowNode &&
        record.appliedShadowNode &&
        currentShadowNode !== record.appliedShadowNode;
      light.castShadow = record.castShadow;
      if (light.shadow) {
        if (!wasExternallyReplaced) light.shadow.shadowNode = record.shadowNode;
        if (record.bias !== undefined) {
          light.shadow.bias = record.bias;
          light.shadow.normalBias = record.normalBias;
        }
        light.shadow.needsUpdate = true;
      }
      patch.lights.delete(light);
    }
  }

  #restoreRealtimeShadows() {
    const patch = this._shadowPatch;
    if (!patch) return;
    this._shadowPatch = null;
    if (patch.lights) {
      for (const [light, record] of patch.lights) {
        light.castShadow = record.castShadow;
        if (light.shadow) {
          const currentShadowNode = light.shadow?.shadowNode;
          const wasExternallyReplaced =
            currentShadowNode &&
            record.appliedShadowNode &&
            currentShadowNode !== record.appliedShadowNode;
          if (!wasExternallyReplaced) light.shadow.shadowNode = record.shadowNode;
          if (record.bias !== undefined) {
            light.shadow.bias = record.bias;
            light.shadow.normalBias = record.normalBias;
          }
          light.shadow.needsUpdate = true;
        }
      }
    } else if (patch.sun) {
      // Compatibility with an in-memory pre-update patch during hot reload.
      patch.sun.castShadow = patch.prevSunCastShadow;
      if (patch.sun.shadow) {
        patch.sun.shadow.shadowNode = patch.prevSunShadowNode;
        patch.sun.shadow.needsUpdate = true;
      }
    }
    if (this._dfShadowReady) this._dfShadowReady.value = 0;
  }

  #findSun() {
    const currentComponent =
      this._sun.entity?.components?.get?.("light") ?? null;
    const currentLight = currentComponent?.light ?? null;
    const currentValid =
      currentLight?.isDirectionalLight === true &&
      currentComponent.enabled !== false &&
      currentLight.intensity > 0 &&
      isEffectivelyVisible(currentLight);

    // Visibility toggles do not necessarily emit component-changed. Validate
    // the cached sun every frame and periodically rescan so a newly revealed
    // directional light can become active without a hierarchy mutation.
    if (
      this._sun.stale ||
      !currentValid ||
      this._frame % EMISSION_POLL_FRAMES === 0
    ) {
      this._sun.stale = false;
      this._sun.entity = null;
      for (const entity of this.engine.entities.values()) {
        const lc = entity.components?.get?.("light");
        const light = lc?.light;
        if (
          light?.isDirectionalLight &&
          lc.enabled !== false &&
          light.intensity > 0 &&
          isEffectivelyVisible(light)
        ) {
          this._sun.entity = entity;
          break;
        }
      }
    }
    const result = this._sun.entity?.components?.get?.("light")?.light ?? null;
    return result && isEffectivelyVisible(result) ? result : null;
  }

  // ---- debug visualization ---------------------------------------------------
  // Three modes bisect the pipeline (innermost cascade only): "voxels" shows
  // the CPU voxelization, "probes" the compute-updated octa atlas, and "gi"
  // the full cone-traced diffuse exactly as materials see it.

  setDebugView(mode) {
    this._debugView = mode;
    if (mode && mode !== "off" && this.volumes.length) this.#buildDebugMesh(mode);
    else this.#removeDebugMesh();
  }

  #buildDebugMesh(mode = this._debugView) {
    this.#removeDebugMesh();
    const vol = this.volumes[0];
    if (!vol || !mode || mode === "off") return;
    if (mode === "voxels") {
      this.#buildVoxelDebugMesh(vol).catch((error) => {
        if (this._debugView === "voxels") {
          console.warn(
            `[gi] live voxel debug readback failed: ${error.message ?? error}`,
          );
        }
      });
      return;
    }
    if (mode === "gi-only") {
      if (!this._deferredSampleFn) return;
      // Full-screen receiver diagnostic: show only the resolved GI/AO input
      // before the physical material combines base color, raster direct
      // lights, environment IBL, or emissive. This makes transport leaks and
      // missing receivers unambiguous in one screenshot.
      const mat = new THREE.MeshBasicNodeMaterial();
      mat.lights = false;
      mat.fog = false;
      mat.side = THREE.DoubleSide;
      mat.colorNode = this._deferredSampleFn(
        positionWorld,
        normalWorld,
        screenUV,
      ).xyz;
      this.engine.scene.overrideMaterial = mat;
      this._shadowDebugMaterial = mat;
      return;
    }
    if (mode === "shadow") {
      // Material-space shadows have no screen texture to blit — instead
      // render the whole scene through an override material whose color IS
      // the traced sun visibility (white = lit). Artifacts visible here are
      // the SDF/trace; artifacts only in the lit scene are GI or wiring.
      if (!this._dfSunShadowNode) return;
      const mat = new THREE.MeshBasicNodeMaterial();
      mat.lights = false;
      mat.fog = false;
      mat.colorNode = vec3(this._dfSunShadowNode);
      this.engine.scene.overrideMaterial = mat;
      this._shadowDebugMaterial = mat;
      return;
    }
    if (mode === "ray-proxies") {
      if (!this._rayScene?.instances.length) {
        this.markRayProxiesDirty();
        return;
      }
      const group = this._rayScene.createDebugObject();
      this.engine.scene.add(group);
      this.debugMesh = group;
      return;
    }
    if (mode === "enclosure") {
      this.#buildEnclosureDebugMesh(vol);
      return;
    }
    const { x: cx, y: cy, z: cz } = vol.counts;
    const count = cx * cy * cz;
    const radius = Math.min(vol.grid.voxelSize, 0.5) * 0.8;
    const geo = new THREE.SphereGeometry(radius, 12, 8);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode =
      mode === "gi" ? vol.nodes.createGIDebugColorNode() : vol.nodes.createDebugColorNode();
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.userData.giDebug = true;
    mesh.userData.engineOwned = true;
    mesh.frustumCulled = false;
    const sp = vol.nodes.uniforms.spacing.value;
    const m = new THREE.Matrix4();
    let i = 0;
    // Instance order MUST match the shader's linear probe index (x fastest).
    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        for (let x = 0; x < cx; x++) {
          m.setPosition(
            vol.grid.min.x + x * sp.x,
            vol.grid.min.y + y * sp.y,
            vol.grid.min.z + z * sp.z,
          );
          mesh.setMatrixAt(i++, m);
        }
      }
    }
    this.engine.scene.add(mesh);
    this.debugMesh = mesh;
  }

  /**
   * Enclosure classification, visualized (innermost cascade, CPU static
   * grid). Blue markers fill empty space classified SEALED — a closed room
   * must fill with blue, and a single missing-blue scene means the flood
   * escaped through a voxel-scale gap and every sealed-room guarantee is
   * legitimately off. Orange markers show AMBIGUOUS (junction / mesh-overlap)
   * occupied cells — the cells that receive no direct injection and are
   * gated by component only.
   */
  /**
   * One-shot GPU readback of the three energy stages (direct cache →
   * combined radiance → probe irradiance) for cascade 0. Printed when the
   * enclosure debug view is (re)selected: the first stage whose numbers
   * collapse to ~zero is where transport dies — no more guessing.
   */
  async #logRadianceStats(vol) {
    const renderer = this.engine.renderer;
    if (!renderer?.getArrayBufferAsync || !vol?.voxelReady) return;
    try {
      const [dirBuf, radBuf, probeBuf] = await Promise.all([
        renderer.getArrayBufferAsync(vol.buffers.voxDirect),
        renderer.getArrayBufferAsync(vol.buffers.radiance),
        renderer.getArrayBufferAsync(vol.buffers.probeData),
      ]);
      const dir = new Uint32Array(dirBuf);
      const rad = new Float32Array(radBuf);
      const probes = new Float32Array(probeBuf);
      let occupied = 0;
      let dirLit = 0;
      let dirMax = 0;
      let dirSum = 0;
      let radLit = 0;
      let radMax = 0;
      let radSum = 0;
      for (let i = 0; i < dir.length; i++) {
        if (rad[i * 4 + 3] < 0.25) continue;
        occupied++;
        const word = dir[i];
        const exponent = word >>> 24;
        if (exponent > 0) {
          const scale = Math.pow(2, exponent - 128) / 255;
          const dl =
            (((word & 255) + ((word >>> 8) & 255) + ((word >>> 16) & 255)) /
              3) *
            scale;
          if (dl > 1e-4) dirLit++;
          if (dl > dirMax) dirMax = dl;
          dirSum += dl;
        }
        const rl = (rad[i * 4] + rad[i * 4 + 1] + rad[i * 4 + 2]) / 3;
        if (rl > 1e-4) radLit++;
        if (rl > radMax) radMax = rl;
        radSum += rl;
      }
      const layout = createProbeLayout(
        vol.probesPerFrame,
        vol.nodes.probeCount,
      );
      const texels = vol.nodes.probeCount * OCTA_RES * OCTA_RES;
      let probeLit = 0;
      let probeMax = 0;
      let probeSum = 0;
      for (let t = 0; t < texels; t++) {
        const base = (layout.irradiance + t) * 4;
        const l = (probes[base] + probes[base + 1] + probes[base + 2]) / 3;
        if (l > 1e-4) probeLit++;
        if (l > probeMax) probeMax = l;
        probeSum += l;
      }
      const mean = (sum, n) => (sum / Math.max(1, n)).toFixed(4);
      console.log(
        `[gi] energy c0: occupied ${occupied}` +
          ` | direct lit ${dirLit}, max ${dirMax.toFixed(3)}, mean ${mean(dirSum, occupied)}` +
          ` | radiance lit ${radLit}, max ${radMax.toFixed(3)}, mean ${mean(radSum, occupied)}` +
          ` | probes lit ${probeLit}/${texels}, max ${probeMax.toFixed(3)}, mean ${mean(probeSum, texels)}`,
      );
    } catch (error) {
      console.warn(`[gi] energy readback failed: ${error.message ?? error}`);
    }
  }

  #buildEnclosureDebugMesh(vol) {
    this.#logRadianceStats(vol);
    const normals = vol.buffers.voxStaticNormal.array;
    const { dims, min, voxelSize } = vol.grid;
    const total = dims.x * dims.y * dims.z;
    const sealed = [];
    const ambiguous = [];
    for (let i = 0; i < total; i++) {
      const word = normals[i];
      if ((word & 0x00ffffff) === 0) {
        if ((word & EXTERIOR_EMPTY_BIT) === 0) sealed.push(i);
      } else if ((word & AMBIGUOUS_NORMAL_BIT) !== 0) {
        ambiguous.push(i);
      }
    }
    console.log(
      `[gi] enclosure view: ${sealed.length} sealed empty cells, ` +
        `${ambiguous.length} ambiguous occupied cells (cascade 0)`,
    );
    const subsample = (list, budget) => {
      const stride = Math.max(1, Math.ceil(list.length / budget));
      const out = [];
      for (let j = 0; j < list.length; j += stride) out.push(list[j]);
      return out;
    };
    const group = new THREE.Group();
    group.userData.giDebug = true;
    group.userData.engineOwned = true;
    const addMarkers = (indices, color, scale) => {
      if (!indices.length) return;
      const geo = new THREE.BoxGeometry(
        voxelSize * scale,
        voxelSize * scale,
        voxelSize * scale,
      );
      const mat = new THREE.MeshBasicMaterial({ color });
      const mesh = new THREE.InstancedMesh(geo, mat, indices.length);
      mesh.frustumCulled = false;
      const m = new THREE.Matrix4();
      for (let j = 0; j < indices.length; j++) {
        const i = indices[j];
        const z = Math.floor(i / (dims.x * dims.y));
        const rem = i - z * dims.x * dims.y;
        const y = Math.floor(rem / dims.x);
        const x = rem - y * dims.x;
        m.setPosition(
          min.x + (x + 0.5) * voxelSize,
          min.y + (y + 0.5) * voxelSize,
          min.z + (z + 0.5) * voxelSize,
        );
        mesh.setMatrixAt(j, m);
      }
      group.add(mesh);
    };
    addMarkers(subsample(sealed, 30000), 0x3377ff, 0.22);
    addMarkers(subsample(ambiguous, 15000), 0xff7722, 0.4);
    this.engine.scene.add(group);
    this.debugMesh = group;
  }

  /**
   * Sparse markers at occupied LIVE voxels. The old debug view used nearly
   * cell-sized opaque cubes and stopped after the first 60k linear indices.
   * Surface shells therefore looked like filled slabs, and the cutoff showed
   * up as large horizontal/rectangular blocks. Reading the composited GPU
   * grid also means moving-object splats are represented instead of showing
   * only the stale CPU static layer.
   */
  async #buildVoxelDebugMesh(vol) {
    const generation = ++this._voxelDebugGeneration;
    let vox = vol.buffers.voxStaticAlbedo.array;
    const renderer = this.engine.renderer;
    if (renderer?.getArrayBufferAsync && vol.voxelReady) {
      const gpuData = await renderer.getArrayBufferAsync(
        vol.buffers.voxAlbedo,
      );
      if (
        generation !== this._voxelDebugGeneration ||
        this._debugView !== "voxels" ||
        vol !== this.volumes[0]
      ) {
        return;
      }
      vox = new Uint32Array(gpuData);
    }

    const { dims } = vol.grid;
    let occupiedCount = 0;
    for (let i = 0; i < vox.length; i++) {
      if ((vox[i] >>> 24) !== 0) occupiedCount++;
    }
    const maxMarkers = 60000;
    const stride = Math.max(
      1,
      Math.ceil(occupiedCount / maxMarkers),
    );
    const occupied = [];
    let ordinal = 0;
    for (let i = 0; i < vox.length; i++) {
      if ((vox[i] >>> 24) === 0) continue;
      if (ordinal++ % stride === 0) occupied.push(i);
    }
    if (!occupied.length) return;
    const s = vol.grid.voxelSize;
    // Deliberate gaps make the surface-sample nature of the occupancy field
    // visible. A 0.9-cell cube made adjacent surface voxels read as a solid
    // volume even though no interior cells were occupied.
    const markerSize = s * 0.38;
    const geo = new THREE.BoxGeometry(
      markerSize,
      markerSize,
      markerSize,
    );
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.lights = false;
    mat.fog = false;
    const mesh = new THREE.InstancedMesh(geo, mat, occupied.length);
    mesh.userData.giDebug = true;
    mesh.userData.engineOwned = true;
    mesh.frustumCulled = false;
    // Node materials don't consume setColorAt's instanceColor — feed the
    // per-voxel albedo as an explicit instanced attribute instead.
    const colors = new Float32Array(occupied.length * 3);
    const m = new THREE.Matrix4();
    for (let k = 0; k < occupied.length; k++) {
      const i = occupied[k];
      const z = Math.floor(i / (dims.x * dims.y));
      const rem = i - z * dims.x * dims.y;
      const y = Math.floor(rem / dims.x);
      const x = rem - y * dims.x;
      m.setPosition(
        vol.grid.min.x + (x + 0.5) * s,
        vol.grid.min.y + (y + 0.5) * s,
        vol.grid.min.z + (z + 0.5) * s,
      );
      mesh.setMatrixAt(k, m);
      const packed = vox[i];
      colors[k * 3] = (packed & 0xff) / 255;
      colors[k * 3 + 1] = ((packed >>> 8) & 0xff) / 255;
      colors[k * 3 + 2] = ((packed >>> 16) & 0xff) / 255;
    }
    const colorAttr = new THREE.InstancedBufferAttribute(colors, 3);
    mat.colorNode = vertexStage(instancedBufferAttribute(colorAttr, "vec3"));
    this.engine.scene.add(mesh);
    this.debugMesh = mesh;
    this.stats.voxelDebug = {
      occupied: occupiedCount,
      shown: occupied.length,
      live: vox !== vol.buffers.voxStaticAlbedo.array,
    };
  }

  #removeDebugMesh() {
    this._voxelDebugGeneration++;
    if (this._shadowDebugMaterial) {
      if (this.engine.scene.overrideMaterial === this._shadowDebugMaterial) {
        this.engine.scene.overrideMaterial = null;
      }
      this._shadowDebugMaterial.dispose();
      this._shadowDebugMaterial = null;
    }
    if (!this.debugMesh) return;
    this.engine.scene.remove(this.debugMesh);
    const materials = new Set();
    this.debugMesh.traverse?.((object) => {
      object.geometry?.dispose?.();
      const list = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of list) if (material) materials.add(material);
    });
    for (const material of materials) material.dispose?.();
    this.debugMesh = null;
  }
}

function hideEditorOnlySubtrees(root) {
  const hidden = [];
  root.traverse((obj) => {
    if (!obj.userData?.editorOnly && !obj.userData?.giDebug) return;
    for (let parent = obj.parent; parent && parent !== root; parent = parent.parent) {
      if (parent.userData?.editorOnly || parent.userData?.giDebug) return;
    }
    hidden.push({ obj, visible: obj.visible });
    obj.visible = false;
  });
  return hidden;
}

function restoreHiddenSubtrees(hidden) {
  for (const { obj, visible } of hidden) obj.visible = visible;
}

const _worldPos = new THREE.Vector3();
const _size = new THREE.Vector2();
const _sunDir = new THREE.Vector3();
const _lightSourceWorld = new THREE.Vector3();
const _lightTargetWorld = new THREE.Vector3();
const _color = new THREE.Color();
const _gridMax = new THREE.Vector3();
const _gridExtent = new THREE.Vector3();
const _dynGridBox = new THREE.Box3();
const _closestPoint = new THREE.Vector3();
const _localLightPos = new THREE.Vector3();
const _localLightTarget = new THREE.Vector3();
const _localLightDir = new THREE.Vector3();
const _emissionAlbedo = new THREE.Color();
const _emissionColor = new THREE.Color();
const _emissionPosition = new THREE.Vector3();
const _emissionBoxSize = new THREE.Vector3();
const _emissionAxisX = new THREE.Vector3();
const _emissionAxisY = new THREE.Vector3();
const _emissionAxisZ = new THREE.Vector3();
