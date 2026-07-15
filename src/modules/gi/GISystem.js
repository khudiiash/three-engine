import * as THREE from "three/webgpu";
import { instancedBufferAttribute, vertexStage, mix, vec3, vec4, Fn, If, texture, screenUV } from "three/tsl";
import { createDeferredGI } from "./giDeferred.js";
import {
  computeGrid,
  voxelizeRegionAsync,
  forEachVoxelizableMesh,
} from "./voxelizer.js";
import {
  createGINodes,
  computeMipLevels,
  fibonacciDirections,
  octaTexelDirections,
  GIProbeVolumeLight,
  GIProbeVolumeLightNode,
  RAYS_PER_PROBE,
  OCTA_RES,
} from "./giCompute.js";

// Debounce between a scene change and the (synchronous, CPU) re-voxelize.
// Batches bursts of hierarchy events (model load spawning many entities)
// while staying short enough that a dragged object re-lights promptly.
const REVOXELIZE_DELAY_MS = 120;

// Frames between transform-hash polls. Entity moves don't emit an engine
// event, so the system fingerprints voxelizable meshes' world matrices —
// this is what makes dragging an object update its GI.
const TRANSFORM_POLL_FRAMES = 10;

// Each cascade covers 4× the world size of the previous one (so 3 cascades
// span 16× the base volume) at coarser voxels — probe density falls off
// with distance while nearby GI stays sharp.
const CASCADE_SCALE = 4;

// One library registration per renderer instance (renderer rebuilds swap
// `renderer.library`, so this can't be a boolean).
const wiredLibraries = new WeakSet();

/**
 * Runtime for the GI module: owns 1–3 cascaded clipmap volumes (voxel grid,
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
    this.stats = { occupied: 0, meshes: 0, tris: 0, voxelMs: 0 };
    this._voxelsDirtyAt = 0; // 0 = clean, else timestamp of the dirtying event
    this._rebuildQueued = false;
    this._frame = 0;
    this._debugView = "off";
    // Per-mesh motion tracking. Meshes that move poll after poll (bone-
    // animated armor pieces, physics debris) are flagged dynamic and drop
    // out of voxelization until they settle — otherwise every animation
    // frame re-triggers a full CPU re-voxelize.
    this._motion = new WeakMap(); // mesh -> { h, moving, still, dynamic }
    this._sceneHashReady = false;
    this._sun = { entity: null, stale: true };

    this._offTick = engine.onUpdate(() => this.#tick());
    // The deferred prepass runs in the pre-render phase, NOT here in update:
    // it renders the scene to build the screen-space GI the main draw samples,
    // so it must execute after physics/scripts write this frame's transforms.
    // Running it in onUpdate could beat physics to the character's new pose,
    // desyncing the GI from the main render (moving objects shimmer).
    this._offPreRender = engine.onPreRender(() => this.#runDeferred());
    this._offHier = engine.on("hierarchy-changed", () => {
      this._voxelsDirtyAt = performance.now();
      this._sun.stale = true;
    });
    // Re-voxelize when a mesh/model/terrain finishes loading or changes —
    // hierarchy-changed alone misses async geometry swaps.
    this._offComp = engine.on("component-changed", ({ componentType }) => {
      if (componentType === "mesh" || componentType === "model" || componentType === "terrain") {
        this._voxelsDirtyAt = performance.now();
      }
      if (componentType === "light") this._sun.stale = true;
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

  /** Scene content changed — re-voxelize (debounced) without reallocating. */
  markVoxelsDirty() {
    this._voxelsDirtyAt = performance.now();
  }

  // ---- lifecycle -----------------------------------------------------------

  #rebuild() {
    this._rebuildQueued = false;
    this.#teardownSceneObjects();
    const c = this.component;
    if (!c) return;
    const p = c.props;

    this.#targetPosition(_worldPos);
    const cascades = Math.max(1, Math.min(3, Math.round(p.cascades ?? 2)));
    for (let i = 0; i < cascades; i++) {
      this.volumes.push(this.#buildVolume(p, i, _worldPos));
    }

    // Per-material world-space GI: each lit material cone-traces the GI
    // directly at its own world position/normal. Unlike the deferred
    // screen-space pass this has NO half-res reconstruction and NO screen-
    // space history, so it can't produce the camera-rotation ghosting or the
    // grazing-angle grain that plagued the deferred approach — the grain that
    // remains is full-res and world-locked (temporally stable). Costs more
    // per-material compile + per-fragment work, which the GPU budget absorbs.
    const reflections = p.reflections !== false;
    const specNodes = this.volumes[0].nodes;
    const volumes = this.volumes;
    // Sky fallback beyond the outermost cascade (matches the old deferred
    // pass): ambient sky where no volume covers the point.
    const outerU = volumes[volumes.length - 1].nodes.uniforms;

    // Branched cascade blend: the inner (sharp) cascade wins where it covers,
    // the outer stack is only evaluated where the inner fade < 1 — a plain
    // mix() chain would cone-trace every cascade on every fragment.
    const combinedDiffuse = Fn(() => {
      const result = vec4(outerU.skyColor.mul(outerU.intensity), 1).toVar();
      const emit = (i) => {
        if (i >= volumes.length) return;
        const nodes = volumes[i].nodes;
        const fade = nodes.createFadeNode().toVar();
        If(fade.lessThan(0.999), () => emit(i + 1));
        If(fade.greaterThan(0.001), () => {
          result.assign(mix(result, nodes.createDiffuseSampler(), fade));
        });
      };
      emit(0);
      return result;
    });

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

    this._voxelsDirtyAt = 1; // voxelize on the next tick (already "overdue")
    this._debugView = p.debugView ?? (p.debugProbes ? "probes" : "off");
    if (this._debugView !== "off") this.#buildDebugMesh();
  }

  /** Builds one cascade volume. `idx` 0 is the innermost/densest. */
  #buildVolume(p, idx, target) {
    const scale = CASCADE_SCALE ** idx;
    const size = new THREE.Vector3(
      Math.max(1, p.sizeX) * scale,
      // Height grows slower — outer cascades chase horizon range, not sky.
      Math.max(1, p.sizeY) * Math.min(scale, 2 ** idx),
      Math.max(1, p.sizeZ) * scale,
    );
    const baseRes = Math.max(16, Math.min(160, Math.round(p.voxelRes) || 64));
    // Outer cascades drop resolution — their voxels are 4× larger anyway,
    // and this keeps the added GPU cost of a cascade well under 1×.
    const res = idx === 0 ? baseRes : Math.max(48, Math.round(baseRes * 0.75));

    // Probe spacing snapped to a whole number of voxels: clipmap recenter
    // shifts must move probes by integer indices AND voxels by integer
    // cells, so the recenter quantum is one probe spacing.
    const voxelSize = Math.max(size.x, size.y, size.z, 1e-3) / res;
    const spacingVox = Math.max(1, Math.round(((p.probeSpacing || 2.5) * scale) / voxelSize));
    const spacingWorld = spacingVox * voxelSize;

    const center = new THREE.Vector3(
      Math.round(target.x / spacingWorld) * spacingWorld,
      Math.round(target.y / spacingWorld) * spacingWorld,
      Math.round(target.z / spacingWorld) * spacingWorld,
    );
    const grid = computeGrid(center, size, res);

    const clampCount = (n) => Math.max(2, Math.min(28, n));
    const counts = {
      x: clampCount(Math.floor((grid.dims.x - 1) / spacingVox) + 1),
      y: clampCount(Math.floor((grid.dims.y - 1) / spacingVox) + 1),
      z: clampCount(Math.floor((grid.dims.z - 1) / spacingVox) + 1),
    };
    const probeCount = counts.x * counts.y * counts.z;
    const probesPerFrame = Math.min(
      probeCount,
      Math.max(16, Math.round((p.probesPerFrame || 256) / 2 ** idx)),
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
    const buffers = {
      voxAlbedo: sba(new Uint32Array(grid.count), 1),
      voxNormal: sba(new Uint32Array(grid.count), 1),
      voxEmissive: sba(new Uint32Array(grid.count), 1),
      voxDirect: sba(new Uint32Array(grid.count), 1), // GPU-written sun cache
      radiance: sba(new Float32Array(grid.count * 4), 4),
      mips: sba(new Float32Array(Math.max(1, mip.mipTexelCount) * 4), 4),
      rays: sba(new Float32Array(probesPerFrame * RAYS_PER_PROBE * 4), 4),
      irradiance: sba(new Float32Array(probeCount * OCTA_RES * OCTA_RES * 4), 4),
      probeScratch: sba(new Float32Array(probeCount * OCTA_RES * OCTA_RES * 4), 4),
      rayDirs: sba(fibonacciDirections(RAYS_PER_PROBE), 4),
      texelDirs: sba(octaTexelDirections(), 4),
    };

    const nodes = createGINodes({
      dims: grid.dims,
      counts,
      probesPerFrame,
      tilesPerRow,
      atlasW,
      atlasH,
      mip,
      coneSteps: p.coneSteps,
      reflections: p.reflections !== false,
      // Outer cascades carry low-frequency light only: fewer, wider cones
      // and no specular — less WGSL in every material, cheaper blend zones.
      lite: idx > 0,
      buffers,
      atlas,
      radianceAtlas,
    });
    nodes.uniforms.gridMin.value.copy(grid.min);
    nodes.uniforms.voxelSize.value = grid.voxelSize;
    nodes.uniforms.spacing.value.setScalar(spacingWorld);

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
      baseProbe: 0,
      directDirty: true, // sun cache needs a first fill
      pendingUpdate: false, // set on recenter: refresh this frame, not on turn
      pendingProbeShift: false, // set when a recenter swap needs a probe shift
      // Consumed one pass per frame at startup so pipeline compiles never
      // pile into a single frame. Order matters: direct cache first.
      warmupQueue: [
        nodes.injectDirectNode,
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
    const width = Math.max(4, _size.x || 4);
    const height = Math.max(4, _size.y || 4);
    const old = this._deferred;
    this._deferred = createDeferredGI({ width, height, volumes: this.volumes });
    this._deferredSize = { w: width, h: height };
    if (this._giSampleNode) {
      // Materials hold this exact node — swapping .value rebinds without
      // a recompile (same trick as the probe atlas ping-pong).
      this._giSampleNode.value = this._deferred.giTexture;
    } else {
      this._giSampleNode = texture(this._deferred.giTexture, screenUV);
    }
    old?.dispose();
  }

  #teardownSceneObjects() {
    if (this.light) {
      this.engine.scene.remove(this.light);
      this.light.dispose?.();
      this.light = null;
    }
    this.#removeDebugMesh();
    for (const vol of this.volumes) {
      this.#cancelVoxelize(vol);
      vol.atlas.dispose();
      vol.radianceAtlas.dispose();
    }
    this.volumes = [];
    this._deferred?.dispose();
    this._deferred = null;
    this._giSampleNode = null;
  }

  dispose() {
    this._offTick?.();
    this._offPreRender?.();
    this._offHier?.();
    this._offComp?.();
    this.#teardownSceneObjects();
    this.component = null;
  }

  // ---- per-frame -----------------------------------------------------------

  #tick() {
    const engine = this.engine;
    const c = this.component;
    if (!c || !engine.rendererReady || !engine.renderer) return;
    if (c.enabled === false) return;
    this.#wireRenderer(engine.renderer);

    if (this._rebuildQueued) this.#rebuild();
    if (!this.volumes.length) return;

    // Clipmap scrolling: every cascade follows the target (camera or
    // entity) in its own probe-spacing quantum.
    this.#targetPosition(_worldPos);
    for (const vol of this.volumes) this.#maybeRecenter(vol, _worldPos);

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

    if (this._voxelsDirtyAt && performance.now() - this._voxelsDirtyAt > REVOXELIZE_DELAY_MS) {
      this._voxelsDirtyAt = 0;
      for (const vol of this.volumes) this.#voxelize(vol);
    }

    const sun = this.#findSun();
    const sunMoved = this.#sunChanged(sun);
    for (const vol of this.volumes) {
      this.#updateUniforms(vol, sun);
      if (sunMoved) vol.directDirty = true;
    }

    const r = engine.renderer;

    // Pipeline warm-up: WebGPU compute pipelines compile synchronously on
    // first dispatch. Running one brand-new pass per frame spreads ~30
    // pipeline compiles over half a second of frames instead of stalling
    // the first frame for seconds.
    const warming = this.volumes.find((v) => v.warmupQueue.length);
    if (warming) {
      const pass = warming.warmupQueue.shift();
      if (pass === warming.nodes.injectDirectNode) warming.directDirty = false;
      r.compute(pass);
      return;
    }

    // Round-robin: one cascade updates per frame — flat GPU cost however
    // many cascades run; probe hysteresis hides the staggering. A cascade
    // that just recentered updates the SAME frame regardless (its gridMin
    // uniform already moved, so serving one more frame from the old
    // radiance atlas would visibly jump — the camera-move flicker).
    const roundRobin = this.volumes[this._frame % this.volumes.length];
    for (const vol of this.volumes) {
      if (vol !== roundRobin && !vol.pendingUpdate) continue;
      vol.pendingUpdate = false;
      if (vol.pendingProbeShift) {
        // A recenter just swapped in: shift surviving probe irradiance to the
        // new grid and refresh the octa atlas before this volume relights, so
        // materials never sample stale probe tiles. Dispatched here (not from
        // the recenter promise) so r.compute stays inside the frame loop.
        vol.pendingProbeShift = false;
        r.compute(vol.nodes.probeShiftSaveNode);
        r.compute(vol.nodes.probeShiftApplyNode);
      }
      if (vol.directDirty) {
        // The shadow-march pass only reruns when the sun or the voxels
        // actually changed — a static sun costs nothing per frame.
        vol.directDirty = false;
        r.compute(vol.nodes.injectDirectNode);
      }
      r.compute(vol.nodes.injectNode);
      // Downsample the fresh radiance into the pyramid, then publish it to
      // the 3D atlas texture the per-pixel cone tracer samples.
      for (const pass of vol.nodes.mipPasses) r.compute(pass);
      r.compute(vol.nodes.copyNode);
      r.compute(vol.nodes.traceNode);
      r.compute(vol.nodes.integrateNode);
      vol.baseProbe = (vol.baseProbe + vol.probesPerFrame) % vol.nodes.probeCount;
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
    // Hold off until the compute pipelines are warmed and the volumes have
    // produced radiance — otherwise the prepass samples an empty atlas (and
    // adds its own pipeline compile to the warmup stall).
    if (this.volumes.some((v) => v.warmupQueue.length)) return;

    // Follow canvas size (debounced by the poll cadence, not per-frame).
    if (this._frame % 30 === 0) {
      engine.renderer.getDrawingBufferSize(_size);
      if (
        _size.x > 0 &&
        (Math.abs(_size.x - this._deferredSize.w) > 1 || Math.abs(_size.y - this._deferredSize.h) > 1)
      ) {
        this.#buildDeferred();
      }
    }

    const renderer = engine.renderer;
    const scene = engine.scene;
    const prevOverride = scene.overrideMaterial;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false; // don't re-render shadow maps for the prepass
    scene.overrideMaterial = d.normalMaterial;
    renderer.setRenderTarget(d.gbuffer);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    scene.overrideMaterial = prevOverride;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    // Capture the camera matrices AFTER the prepass render: the camera is a
    // child of the (physics-driven) character, so its matrixWorld is only
    // refreshed by the scene.updateMatrixWorld() inside render() above.
    // Reading it before would reconstruct GI world positions from a stale
    // pose and re-introduce the moving-object shimmer.
    d.update(camera);
    renderer.compute(d.passNode);
  }

  /** True when the sun's direction/color changed beyond noise since last frame. */
  #sunChanged(sun) {
    let key = 0;
    if (sun) {
      sun.getWorldDirection(_sunDir);
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
   * Walks voxelizable meshes, updating each one's motion record. Returns
   * true when a *static* mesh moved, appeared, or a dynamic one settled —
   * the cases worth a re-voxelize. A mesh that moves 3 polls in a row is
   * flagged dynamic (skipped by the voxelizer via #skipMesh) until it holds
   * still for 6 polls.
   */
  #pollMotion() {
    let dirty = false;
    forEachVoxelizableMesh(this.engine.scene, (o) => {
      const e = o.matrixWorld.elements;
      const h = e[12] * 3.7 + e[13] * 7.9 + e[14] * 13.3 + e[0] * 1.1 + e[5] * 2.3 + e[10] * 5.1;
      let rec = this._motion.get(o);
      if (!rec) {
        rec = { h, moving: 0, still: 0, dynamic: false };
        this._motion.set(o, rec);
        dirty = true; // new mesh entered the scene
        return;
      }
      if (h !== rec.h) {
        rec.h = h;
        rec.moving++;
        rec.still = 0;
        if (rec.dynamic) return; // already excluded — its motion is free
        if (rec.moving >= 3) {
          rec.dynamic = true; // went perpetual — drop it from the grid
          dirty = true;
        } else {
          dirty = true; // a static mesh moved (drag, teleport, physics rest)
        }
      } else {
        rec.moving = 0;
        rec.still++;
        if (rec.dynamic && rec.still >= 6) {
          rec.dynamic = false; // settled — bring it back into the grid
          dirty = true;
        }
      }
    });
    return dirty;
  }

  #skipMesh = (mesh) => this._motion.get(mesh)?.dynamic === true;

  /**
   * Where the volumes should center: the active camera (open world), pushed
   * forward along the view so most of the budget covers what's on screen,
   * or the component's entity for hand-placed volumes.
   */
  #targetPosition(out) {
    const cam = this.engine.camera;
    const p = this.component?.props;
    if (p?.followCamera && cam) {
      cam.getWorldPosition(out);
      const bias = Math.max(0, p.forwardBias ?? 8);
      if (bias > 0) {
        cam.getWorldDirection(_camDir);
        out.addScaledVector(_camDir, bias);
      }
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
    const band = (axisDim) => Math.max(sw, axisDim * voxelSize * 0.2);
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

    if (teleport || !vol.voxelReady) {
      // Nothing worth preserving. Apply the move now, clear to empty, and
      // rebuild in time slices so warping to a distant camera can't freeze
      // the editor; probes reseed from sky (reseedSky = 1). This immediate
      // path is rare (large jumps), so its transient reset is acceptable.
      this.#cancelVoxelize(vol);
      vol.center.x += steps.x * sw;
      vol.center.y += steps.y * sw;
      vol.center.z += steps.z * sw;
      vol.grid.min.x += sVox.x * voxelSize;
      vol.grid.min.y += sVox.y * voxelSize;
      vol.grid.min.z += sVox.z * voxelSize;
      vol.nodes.uniforms.gridMin.value.copy(vol.grid.min);
      this.#clearVoxelBuffers(vol);
      vol.voxelReady = false;
      this.#voxelize(vol);
      vol.nodes.uniforms.probeShift.value.set(vol.counts.x, 0, 0); // out of range → sky seed
      vol.nodes.uniforms.reseedSky.value = 1;
      const r = this.engine.renderer;
      r.compute(vol.nodes.probeShiftSaveNode);
      r.compute(vol.nodes.probeShiftApplyNode);
      vol.pendingUpdate = true;
      if (this._debugView !== "off" && vol === this.volumes[0]) this.#buildDebugMesh();
      return;
    }

    // Survivor path: single-flight, staged, atomic (see #recenterVoxelize).
    // Skip if ANY cascade already has a voxelize job running — that both
    // prevents cascades from stacking their voxelization into one frame (the
    // 8→40ms spike) and lets the in-flight job finish. The volume holds its
    // correct old center until the job swaps the new content in; the deadband
    // tolerates that lag.
    if (this.volumes.some((v) => v.voxelJob)) return;
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
    this.#recenterVoxelize(vol, newMin, newCenter, steps);
  }

  #cancelVoxelize(vol) {
    const job = vol?.voxelJob;
    if (!job) return false;
    job.token.cancelled = true;
    vol.voxelJob = null;
    return true;
  }

  #clearVoxelBuffers(vol) {
    for (const buffer of [vol.buffers.voxAlbedo, vol.buffers.voxNormal, vol.buffers.voxEmissive]) {
      buffer.array.fill(0);
      buffer.needsUpdate = true;
    }
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
      { skip: this.#skipMesh, signal: token, timeSliceMs: 6 },
    )
      .then((result) => {
        if (token.cancelled || result.cancelled || vol.voxelJob?.token !== token) return result;
        vol.voxelJob = null;
        vol.buffers.voxAlbedo.array.set(target.albedo);
        vol.buffers.voxNormal.array.set(target.normal);
        vol.buffers.voxEmissive.array.set(target.emissive);
        vol.buffers.voxAlbedo.needsUpdate = true;
        vol.buffers.voxNormal.needsUpdate = true;
        vol.buffers.voxEmissive.needsUpdate = true;
        vol.voxelReady = true;
        vol.directDirty = true; // fresh voxels — refill the sun cache
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
  #recenterVoxelize(vol, newMin, newCenter, steps) {
    this.#cancelVoxelize(vol);
    const { dims } = vol.grid;
    const target = {
      albedo: new Uint32Array(vol.grid.count),
      normal: new Uint32Array(vol.grid.count),
      emissive: new Uint32Array(vol.grid.count),
    };
    const grid = { ...vol.grid, min: newMin.clone(), dims: { ...dims } };
    const token = { cancelled: false };
    const promise = voxelizeRegionAsync(
      this.engine.scene,
      grid,
      target,
      { x0: 0, y0: 0, z0: 0, x1: dims.x, y1: dims.y, z1: dims.z },
      { skip: this.#skipMesh, signal: token, timeSliceMs: 4 },
    )
      .then((result) => {
        if (token.cancelled || result.cancelled || vol.voxelJob?.token !== token) return;
        vol.voxelJob = null;
        // Atomic swap: content + center + probe shift, all this frame.
        vol.buffers.voxAlbedo.array.set(target.albedo);
        vol.buffers.voxNormal.array.set(target.normal);
        vol.buffers.voxEmissive.array.set(target.emissive);
        vol.buffers.voxAlbedo.needsUpdate = true;
        vol.buffers.voxNormal.needsUpdate = true;
        vol.buffers.voxEmissive.needsUpdate = true;
        vol.center.copy(newCenter);
        vol.grid.min.copy(newMin);
        vol.nodes.uniforms.gridMin.value.copy(newMin);
        vol.nodes.uniforms.probeShift.value.set(steps.x, steps.y, steps.z);
        vol.nodes.uniforms.reseedSky.value = 0; // survivors edge-extend, no sky pop
        vol.voxelReady = true;
        vol.directDirty = true;
        // Defer the probe-shift compute + atlas refresh to the next tick's
        // render phase (r.compute must run inside the frame loop, not from
        // this promise microtask). pendingUpdate makes the round-robin serve
        // this volume that frame.
        vol.pendingProbeShift = true;
        vol.pendingUpdate = true;
        if (this._debugView !== "off" && vol === this.volumes[0]) this.#buildDebugMesh();
      })
      .catch((err) => {
        if (!token.cancelled) console.error(`[gi] recenter voxelize failed: ${err.message}`);
      });
    vol.voxelJob = { token, promise };
  }

  #updateUniforms(vol, sun) {
    const u = vol.nodes.uniforms;
    const p = this.component.props;
    u.intensity.value = Math.max(0, p.intensity ?? 1);
    u.bounce.value = Math.max(0, p.bounce ?? 1);
    u.hysteresis.value = Math.min(0.99, Math.max(0, p.hysteresis ?? 0.75));
    u.aoStrength.value = Math.min(1, Math.max(0, p.aoStrength ?? 1));
    u.normalBias.value = Math.max(0, p.normalBias ?? 0.4);
    u.reflectionIntensity.value = Math.max(0, p.reflectionIntensity ?? 1);
    u.baseProbe.value = vol.baseProbe;
    _color.set(p.skyColor || "#87b7dc");
    u.skyColor.value.copy(_color).multiplyScalar(Math.max(0, p.skyIntensity ?? 1));

    if (sun) {
      sun.getWorldDirection(_sunDir).negate(); // Object3D forward is +Z; lights aim -Z
      u.sunDir.value.copy(_sunDir).normalize();
      u.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
    } else {
      u.sunColor.value.setRGB(0, 0, 0);
    }
  }

  #findSun() {
    if (this._sun.stale) {
      this._sun.stale = false;
      this._sun.entity = null;
      for (const entity of this.engine.entities.values()) {
        const lc = entity.components?.get?.("light");
        if (lc?.light?.isDirectionalLight && lc.enabled !== false) {
          this._sun.entity = entity;
          break;
        }
      }
    }
    return this._sun.entity?.components?.get?.("light")?.light ?? null;
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
      this.#buildVoxelDebugMesh(vol);
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

  /** Instanced cubes at occupied voxels, tinted by their CPU-side albedo. */
  #buildVoxelDebugMesh(vol) {
    const vox = vol.buffers.voxAlbedo.array;
    const { dims } = vol.grid;
    const occupied = [];
    for (let i = 0; i < vox.length && occupied.length < 60000; i++) {
      if (vox[i] !== 0) occupied.push(i);
    }
    if (!occupied.length) return;
    const s = vol.grid.voxelSize;
    const geo = new THREE.BoxGeometry(s * 0.9, s * 0.9, s * 0.9);
    const mat = new THREE.MeshBasicNodeMaterial();
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
  }

  #removeDebugMesh() {
    if (!this.debugMesh) return;
    this.engine.scene.remove(this.debugMesh);
    this.debugMesh.geometry.dispose();
    this.debugMesh.material.dispose();
    this.debugMesh = null;
  }
}

const _worldPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _size = new THREE.Vector2();
const _sunDir = new THREE.Vector3();
const _color = new THREE.Color();
