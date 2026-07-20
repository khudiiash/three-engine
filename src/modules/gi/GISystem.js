// GISystem — engine runtime for the Radiance Cascades GI module (Phase 6).
//
// Orchestrates the phase 0-5 verified pieces against a live engine scene:
//   voxelizeOnce (medium, CPU bake on scene CHANGES only)
//   createRadianceCascades + createCascadeMerge (per-frame GPU transport)
//   createIrradianceGather (canonical sampler — materials AND gizmos)
//   GICascadeLight (injects irradiance into every lit material)
//
// Deliberate simplicity carried over from the plan: ONE volume, fixed bounds
// centered on the owning entity, full re-bake on change (no clipmap, no
// recenter, no incremental voxelization, no temporal anything). Structural
// prop changes rebuild everything; transforms/material edits re-bake voxels;
// cascades re-trace every frame regardless — that is what makes lighting
// respond within a frame of the voxels changing.
import * as THREE from "three/webgpu";
import { instanceIndex, positionLocal, uniform } from "three/tsl";
import { createRadianceCascades } from "./cascadeTrace.js";
import { createCascadeMerge } from "./cascadeMerge.js";
import { createBounceFeedback, createIrradianceGather, createRadianceLookup } from "./cascadeGather.js";
import { voxelizeOnce, resolveMaterialSurface, serializeMeshForBake } from "./voxelizeOnce.js";
import { GICascadeLight, MAX_EMITTERS, registerGILight } from "./giLight.js";

const FINGERPRINT_INTERVAL_FRAMES = 5;
const REBAKE_DEBOUNCE_MS = 250;
const MAX_TRIS_PER_MESH = 100_000;
const MAX_AXIS_RES = 128;
const MAX_PROBE_AXIS = 48;

export class GISystem {
  constructor(engine) {
    this.engine = engine;
    this.component = null;
    this.state = null; // { volume, cascades, queue, light, gizmos, meshes, lights }
    this._frame = 0;
    this._fingerprint = "";
    this._rebakeTimer = null;
    this._rebuildQueued = false;
    this._unsubs = [
      engine.onPreRender(() => this.#tick()),
      engine.on?.("hierarchy-changed", () => this.#queueRebakeCheck()) ?? (() => {}),
      engine.on?.("component-changed", () => this.#queueRebakeCheck()) ?? (() => {}),
      engine.on?.("model-loaded", () => this.#queueRebakeCheck()) ?? (() => {}),
    ];
  }

  /** One active component at a time (Environment convention: last wins). */
  attach(component) {
    if (this.component === component) return;
    this.component = component;
    this.requestRebuild();
  }

  detach(component) {
    if (this.component !== component) return;
    this.component = null;
    this.#dispose();
  }

  onComponentProp(component, key) {
    if (this.component !== component) return;
    if (key === "intensity" || key === "bounce" || key === "enabled") {
      this.#applyLiveProps();
    } else if (key === "debugProbes") {
      this.#applyDebugVisibility();
    } else if (key === "autoRebake") {
      // read on the fly, nothing to do
    } else {
      // Structural (size/resolution/cascade shape): grids and dispatch sizes
      // are baked into the compute graphs as constants — rebuild. But ONLY
      // on a real value change: editor autosave re-writes props with
      // unchanged values, and a no-op write must not trigger a 300ms+
      // synchronous rebuild.
      const signature = this.#structuralSignature(component);
      if (signature !== this._structuralSig) {
        this._structuralSig = signature;
        this.requestRebuild();
      }
    }
  }

  #structuralSignature(component) {
    const p = component.props;
    return JSON.stringify([
      p.sizeX,
      p.sizeY,
      p.sizeZ,
      p.voxelSize,
      p.probeSpacing,
      p.cascadeCount,
      p.c0DirRes,
      p.reflections,
      p.emissiveShadows,
    ]);
  }

  requestRebuild() {
    this._rebuildQueued = true;
  }

  dispose() {
    for (const unsub of this._unsubs) unsub?.();
    this._unsubs = [];
    if (this._rebakeTimer) clearTimeout(this._rebakeTimer);
    this.#dispose();
    this.component = null;
  }

  // -------------------------------------------------------------------------

  #tick() {
    const component = this.component;
    if (!component || !component.enabled) return;
    const renderer = this.engine.renderer;
    if (!renderer) return;
    registerGILight(renderer);

    if (this._rebuildQueued) {
      this._rebuildQueued = false;
      this.#rebuild();
    }
    const state = this.state;
    if (!state) return;

    // Cascades re-trace + re-merge EVERY frame — 1-frame response to any
    // voxel content change, no temporal accumulation to converge.
    renderer.compute(state.queue);

    this._frame++;
    if (this._frame % FINGERPRINT_INTERVAL_FRAMES === 0 && component.props.autoRebake !== false) {
      this.#checkFingerprint();
    }
  }

  #rebuild() {
    this.#dispose();
    const component = this.component;
    const engine = this.engine;
    if (!component || !engine.scene) return;

    const props = component.props;
    const center = new THREE.Vector3();
    component.entity.object3D.getWorldPosition(center);
    const half = new THREE.Vector3(props.sizeX / 2, props.sizeY / 2, props.sizeZ / 2);
    const bounds = {
      min: center.clone().sub(half),
      max: center.clone().add(half),
    };

    const voxelSize = Math.max(0.05, props.voxelSize || 0.3);
    const res = {
      x: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(props.sizeX / voxelSize))),
      y: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(props.sizeY / voxelSize))),
      z: Math.min(MAX_AXIS_RES, Math.max(4, Math.round(props.sizeZ / voxelSize))),
    };
    const probeSpacing = Math.max(0.25, props.probeSpacing || 1.25);
    const c0Grid = {
      x: Math.min(MAX_PROBE_AXIS, Math.max(2, Math.round(props.sizeX / probeSpacing))),
      y: Math.min(MAX_PROBE_AXIS, Math.max(2, Math.round(props.sizeY / probeSpacing))),
      z: Math.min(MAX_PROBE_AXIS, Math.max(2, Math.round(props.sizeZ / probeSpacing))),
    };

    if (res.x * res.y * res.z > 1_500_000) {
      console.warn(
        `[gi] ${res.x}x${res.y}x${res.z} voxels is heavy (ray-march steps scale with 1/voxelSize). ` +
          `For a ${props.sizeX}m volume, voxelSize ~${(props.sizeX / 100).toFixed(2)} is usually plenty.`,
      );
    }

    const meshes = this.#collectMeshes();
    const lights = this.#collectLights();
    const t0 = performance.now();
    const volume = voxelizeOnce(meshes, bounds, res, lights);

    const { cascades } = createRadianceCascades({
      bounds,
      cascadeCount: Math.min(6, Math.max(2, props.cascadeCount || 5)),
      c0Grid,
      c0DirRes: props.c0DirRes === 2 ? 2 : 4,
      t0: probeSpacing,
      farT: Math.max(props.sizeX, props.sizeY, props.sizeZ) * 2,
      sceneTrace: volume.createSceneTrace(),
    });
    const { mergeComputes } = createCascadeMerge(cascades);
    const gather = createIrradianceGather(cascades);
    // Multi-bounce: voxel radiance ← base + albedo·E/π every frame. Runs
    // FIRST (reads last frame's merged field) so this frame's trace sees
    // bounced energy — this is what makes emissive-only scenes bleed.
    const bounceGain = uniform(Math.min(1, Math.max(0, props.bounce ?? 1)));
    const feedbackCompute = createBounceFeedback(cascades, volume, bounceGain);

    const queue = [feedbackCompute];
    for (const cascade of cascades) queue.push(cascade.traceCompute);
    for (const cascade of cascades) queue.push(cascade.averageCompute);
    queue.push(...mergeComputes);

    // Fresh light instance per rebuild ON PURPOSE: the lights-hash change is
    // what forces materials to recompile against the new gather's buffers.
    const light = new GICascadeLight();
    light.gatherFn = gather;
    if (props.reflections !== false) {
      light.radianceFn = createRadianceLookup(cascades, 2);
      // Finest-angular cascade for low-roughness reflections (spatially
      // coarser, but a mirror's sharpness is set by angular resolution).
      const sharpLevel = Math.min(3, cascades.length - 1);
      light.radianceSharpFn = sharpLevel > 2 ? createRadianceLookup(cascades, sharpLevel) : null;
      // Low-roughness materials get a real per-pixel voxel ray (mirror look).
      light.mirrorTraceFn = volume.createSceneTrace();
    }
    light.normalOffset = Math.max(0.1, voxelSize * 1.2);
    if (props.emissiveShadows !== false) {
      light.shadowTraceFn = volume.createSoftShadowTrace();
      light.shadowMargin = Math.max(0.2, voxelSize * 2.5);
      light.emitterSlots = Array.from({ length: MAX_EMITTERS }, () => ({
        center: uniform(new THREE.Vector3()),
        radius: uniform(0),
        color: uniform(new THREE.Color(0, 0, 0)),
      }));
    }
    engine.scene.add(light);
    this.#updateEmitters(light, meshes);

    const gizmos = this.#buildGizmos(cascades, bounds);
    for (const mesh of gizmos.all) engine.scene.add(mesh);

    this.state = { volume, cascades, queue, light, gizmos, meshes, lights, bounds, center, bounceGain };
    this._structuralSig = this.#structuralSignature(component);
    this._fingerprint = this.#computeFingerprint(meshes, this.#collectLightObjects());
    this.#applyLiveProps();
    this.#applyDebugVisibility();
    console.log(
      `[gi] built: ${res.x}x${res.y}x${res.z} voxels, c0 ${c0Grid.x}x${c0Grid.y}x${c0Grid.z}, ` +
        `${cascades.length} cascades, ${meshes.length} meshes, ${lights.length} lights, ` +
        `bake ${(performance.now() - t0).toFixed(0)}ms ` +
        `(occ ${volume.stats.occupiedCells}, lit ${volume.stats.litCells}, emissive ${volume.stats.emissiveCells})`,
    );
  }

  #dispose() {
    const state = this.state;
    if (!state) return;
    this.state = null;
    state.volume?.dispose?.();
    state.light?.removeFromParent();
    for (const mesh of state.gizmos?.all ?? []) {
      mesh.removeFromParent();
      mesh.geometry?.dispose();
      mesh.material?.dispose();
    }
    // Compute nodes / storage buffers are released with GC once nothing
    // references them; three's storage attributes hold no scene-graph refs.
  }

  #applyLiveProps() {
    const state = this.state;
    if (!state) return;
    state.light.intensityUniform.value = this.component?.props.intensity ?? 1;
    // Hard-clamped to [0,1]: bounce is "how much secondary energy survives
    // each pass", and any in-loop gain above 1 makes the feedback series
    // diverge (white-out) in enclosed scenes — old saved props may still
    // carry values up to 4 from the earlier schema. Artistic exaggeration
    // belongs to `intensity`, which sits OUTSIDE the loop.
    state.bounceGain.value = Math.min(1, Math.max(0, this.component?.props.bounce ?? 1));
  }

  #applyDebugVisibility() {
    const state = this.state;
    if (!state) return;
    const mode = this.component?.props.debugProbes ?? "off";
    state.gizmos.raw.visible = mode === "raw";
    state.gizmos.merged.visible = mode === "merged";
  }

  /**
   * Fills the light's emitter-slot uniforms from the brightest emissive
   * meshes (world bounding sphere + resolved radiance). Uniforms, not baked
   * constants, so emitter moves/edits re-aim the shadows on rebake without
   * a material recompile. Unused slots get radius 0 (zero contribution).
   */
  #updateEmitters(light, meshes) {
    if (!light?.emitterSlots) return;
    const found = [];
    for (const mesh of meshes) {
      const surface = resolveMaterialSurface(mesh.material, mesh.name);
      const r = surface.emissive.r * surface.emissiveIntensity;
      const g = surface.emissive.g * surface.emissiveIntensity;
      const b = surface.emissive.b * surface.emissiveIntensity;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luminance < 0.5) continue;
      const geometry = mesh.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const center = geometry.boundingSphere.center.clone().applyMatrix4(mesh.matrixWorld);
      const scale = new THREE.Vector3();
      mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      const radius = geometry.boundingSphere.radius * Math.max(scale.x, scale.y, scale.z);
      found.push({ center, radius, r, g, b, luminance });
    }
    found.sort((a, b) => b.luminance - a.luminance);
    if (found.length > MAX_EMITTERS) {
      console.warn(`[gi] ${found.length} emissive emitters; shadow rays cover the brightest ${MAX_EMITTERS}`);
    }
    light.emitterSlots.forEach((slot, i) => {
      const emitter = found[i];
      if (emitter) {
        slot.center.value.copy(emitter.center);
        slot.radius.value = emitter.radius;
        slot.color.value.setRGB(emitter.r, emitter.g, emitter.b);
      } else {
        slot.radius.value = 0;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Scene collection

  #collectMeshes() {
    const meshes = [];
    const visit = (object) => {
      if (object.visible === false) return;
      if (object.isMesh && !object.isInstancedMesh && !object.userData.__giDebug) {
        const position = object.geometry?.attributes?.position;
        const material = Array.isArray(object.material) ? object.material[0] : object.material;
        const triCount = (object.geometry?.index?.count ?? position?.count ?? 0) / 3;
        // Editor-only helpers live on layer 31 (mask compared unsigned —
        // 1<<31 is negative in JS int32).
        const editorOnly = ((object.layers.mask >>> 0) & 0x80000000) !== 0 && (object.layers.mask >>> 0) === 0x80000000;
        if (position && material && !material.transparent && !editorOnly && triCount <= MAX_TRIS_PER_MESH) {
          meshes.push(object);
        } else if (triCount > MAX_TRIS_PER_MESH) {
          console.warn(`[gi] skipping "${object.name || "mesh"}" (${Math.round(triCount)} tris > cap)`);
        }
      }
      for (const child of object.children) visit(child);
    };
    if (this.engine.scene) visit(this.engine.scene);
    return meshes;
  }

  #collectLightObjects() {
    const lights = [];
    this.engine.scene?.traverse((object) => {
      if ((object.isDirectionalLight || object.isPointLight) && object.visible && object.intensity > 0) {
        lights.push(object);
      }
    });
    return lights;
  }

  #collectLights() {
    const entries = [];
    for (const light of this.#collectLightObjects()) {
      const color = light.color.clone();
      if (light.isDirectionalLight) {
        light.updateWorldMatrix(true, false);
        light.target.updateWorldMatrix(true, false);
        const from = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
        const to = new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld);
        const direction = to.sub(from);
        if (direction.lengthSq() < 1e-8) direction.set(0, -1, 0);
        entries.push({ type: "directional", direction: direction.normalize(), color, intensity: light.intensity });
      } else {
        const position = new THREE.Vector3();
        light.getWorldPosition(position);
        entries.push({ type: "point", position, color, intensity: light.intensity });
      }
    }
    return entries;
  }

  // -------------------------------------------------------------------------
  // Change detection: cheap fingerprint every N frames; any difference →
  // debounced full re-bake into the same GPU buffer. Center drift beyond a
  // probe spacing → full rebuild (bounds are baked constants).

  #queueRebakeCheck() {
    // Events can fire in bursts (autosave, prop noise); the actual decision
    // happens in the throttled fingerprint check.
    this._frame = -1; // forces the next tick's modulo to hit
  }

  #checkFingerprint() {
    const state = this.state;
    const component = this.component;
    if (!state || !component) return;

    const center = new THREE.Vector3();
    component.entity.object3D.getWorldPosition(center);
    if (center.distanceTo(state.center) > Math.max(0.5, (component.props.probeSpacing || 1.25) * 0.5)) {
      this.requestRebuild();
      return;
    }

    const meshes = this.#collectMeshes();
    const lights = this.#collectLightObjects();
    const fingerprint = this.#computeFingerprint(meshes, lights);
    if (fingerprint === this._fingerprint) return;
    // Throttle REQUESTS (not detection): editor drags emit change events
    // every frame, which forces the fingerprint check every frame — without
    // this, mesh serialization runs per-frame during a drag. Leaving
    // _fingerprint un-updated makes the next check retry, so no edit is lost.
    const now = performance.now();
    if (now - (this._lastRebakeAt ?? 0) < 70) return;
    this._lastRebakeAt = now;
    this._fingerprint = fingerprint;

    // No debounce: the fingerprint check's 15-frame cadence is the rate
    // limit, and the worker coalesces in-flight requests (latest wins) — so
    // continuous edits (dragging a wall) stream re-bakes at worker cadence
    // while the main thread only pays for mesh serialization (~ms).
    const current = this.state;
    const records = meshes.map(serializeMeshForBake).filter(Boolean);
    current.volume.rebakeAsync(records, this.#collectLights()).then((result) => {
      if (!result || this.state !== current) return;
      this.#updateEmitters(current.light, this.#collectMeshes());
      const { occupiedCells, litCells, emissiveCells } = current.volume.stats;
      console.log(
        `[gi] worker rebake ${result.elapsed.toFixed(0)}ms (occ ${occupiedCells}, lit ${litCells}, emissive ${emissiveCells})`,
      );
    });
  }

  #computeFingerprint(meshes, lights) {
    let hash = 0x811c9dc5;
    const mix = (value) => {
      hash ^= value & 0xffffffff;
      hash = Math.imul(hash, 0x01000193);
    };
    const mixFloat = (f) => mix(Math.round(f * 1000));
    for (const mesh of meshes) {
      mix(mesh.id);
      const e = mesh.matrixWorld.elements;
      for (let i = 0; i < 16; i++) mixFloat(e[i]);
      // Resolve through colorNode/emissiveNode (same path the bake uses) so
      // shader-graph/material-asset color edits fingerprint correctly.
      const surface = resolveMaterialSurface(mesh.material);
      mixFloat(surface.color.r);
      mixFloat(surface.color.g);
      mixFloat(surface.color.b);
      mixFloat(surface.emissive.r * surface.emissiveIntensity);
      mixFloat(surface.emissive.g * surface.emissiveIntensity);
      mixFloat(surface.emissive.b * surface.emissiveIntensity);
      mix(mesh.geometry?.id ?? 0);
    }
    for (const light of lights) {
      mix(light.id);
      mix(light.color.getHex());
      mixFloat(light.intensity);
      const e = light.matrixWorld.elements;
      mixFloat(e[12]);
      mixFloat(e[13]);
      mixFloat(e[14]);
    }
    return (hash >>> 0).toString(16);
  }

  // -------------------------------------------------------------------------

  #buildGizmos(cascades, bounds) {
    const c0 = cascades[0];
    const spacing = (bounds.max.x - bounds.min.x) / c0.grid.x;
    const make = (buffer) => {
      const geometry = new THREE.SphereGeometry(Math.min(spacing * 0.12, 0.15), 8, 6);
      const material = new THREE.MeshBasicNodeMaterial();
      material.positionNode = positionLocal.add(c0.probePositionOf(instanceIndex.toFloat()));
      const raw = buffer.element(instanceIndex).mul(8);
      material.colorNode = raw.div(raw.add(1));
      const mesh = new THREE.InstancedMesh(geometry, material, c0.probeCount);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.userData.__giDebug = true;
      const identity = new THREE.Matrix4();
      const array = mesh.instanceMatrix.array;
      for (let i = 0; i < mesh.count; i++) array.set(identity.elements, i * 16);
      mesh.instanceMatrix.needsUpdate = true;
      return mesh;
    };
    const raw = make(c0.averages);
    const merged = make(c0.mergedAverages);
    return { raw, merged, all: [raw, merged] };
  }
}
