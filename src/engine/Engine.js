import * as THREE from "three/webgpu";
import { EventEmitter } from "./EventEmitter.js";
import { Entity } from "./Entity.js";
import { SCENE_SETTINGS_DEFAULTS, mergeSettings, applySettingsToScene } from "./sceneSettings.js";
import { InputManager } from "./input/index.js";
import { createDefaultMaps } from "./input/defaultMaps.js";

/**
 * Runtime core: owns the renderer, the three.js scene (source of truth)
 * and the entity tree. No React, no editor state — a built game ships this.
 */
export class Engine extends EventEmitter {
  constructor() {
    super();
    this.scene = new THREE.Scene();
    this.renderer = null;
    this.camera = null; // active camera (editor camera or a CameraComponent's)
    this.entities = new Map(); // id -> Entity
    this.rootEntities = [];
    this.timer = new THREE.Timer();
    this.updateCallbacks = new Set();
    // Callbacks fired after the main render. Use these for layered
    // effects that need to draw on top of the main scene (e.g. the
    // editor's camera-preview PIP), without the main render's
    // auto-clear wiping the PIP pixels.
    this.postRenderCallbacks = new Set();
    this.sceneName = "Untitled";
    this.playing = false;
    this.rendererReady = false;
    this.modules = new Map(); // module id -> setup handle (see modules.js)

    // Host-tunable runtime behavior (the editor writes project settings here).
    this.config = { scriptHotReload: true, scriptReloadIntervalMs: 750 };

    // Input: built by default with the Player/UI maps enabled; an editor-
    // provided snapshot (applyInput) replaces it. Attached once the canvas
    // exists (see init()).
    // Vector2 factory passed to the InputManager so `readValue("Move")` returns a
    // real `THREE.Vector2` instance (with `.length()`, `.normalize()`, …) instead
    // of a plain `{ x, y }` object. The factory is also threaded through
    // `applyInput()` below so a deserialized snapshot behaves the same way.
    this.input = new InputManager({
      Vector2: THREE.Vector2,
      // Vec2 actions with `space: "camera"` are rotated by `engine.camera`
      // each tick. The provider is a closure so swapping `engine.camera`
      // (e.g. on scene change) takes effect immediately — no need to
      // re-register the manager.
      cameraProvider: () => this.camera,
    });
    for (const m of createDefaultMaps()) this.input.addActionMap(m);
    this.input.enableMap("Player");
    this.input.enableMap("UI");
    this._inputTickUnsub = null; // tracked so applyInput can swap it cleanly

    // Scene environment settings (serialized with the scene). The ambient
    // light is engine-owned — not an entity, so it never serializes twice.
    this.settings = structuredClone(SCENE_SETTINGS_DEFAULTS);
    this.ambientLight = new THREE.AmbientLight();
    this.ambientLight.userData.engineOwned = true;
    this.scene.add(this.ambientLight);
    applySettingsToScene(this.settings, this.scene, this.ambientLight, null);
  }

  /** Merges + applies a scene-settings patch; emits "settings-changed". */
  applySettings(patch) {
    this.settings = mergeSettings(this.settings, patch ?? {});
    applySettingsToScene(this.settings, this.scene, this.ambientLight, this.renderer);
    this.emit("settings-changed", this.settings);
  }

  /** Toggles game-logic execution (ScriptComponent onStart/onUpdate/onDestroy). */
  setPlaying(playing) {
    if (playing === this.playing) return;
    this.playing = playing;
    if (!playing) this.input.reset();
    this.emit("play-changed", playing);
  }

  /**
   * Replaces the engine's input maps with a JSON snapshot (the form
   * InputManager.toJSON() produces). If `json` is null, restores the
   * built-in Player/UI defaults. Existing map definitions are removed.
   */
  applyInput(json) {
    const old = this.input;
    old.detach();
    this._inputTickUnsub?.();
    this._inputTickUnsub = null;
    const next = json
      ? InputManager.fromJSON(json, { Vector2: THREE.Vector2, cameraProvider: () => this.camera })
      : new InputManager({
          virtualJoysticks: "auto",
          virtualJoystickTheme: "dark",
          Vector2: THREE.Vector2,
          cameraProvider: () => this.camera,
        });
    if (!json) {
      for (const m of createDefaultMaps()) next.addActionMap(m);
      next.enableMap("Player");
      next.enableMap("UI");
    } else {
      // Restore the stack too — fromJSON carries it.
      for (const name of next.stack) next.enableMap(name);
    }
    next.attach(this.renderer?.domElement ?? this.canvas);
    this._inputTickUnsub = this.onUpdate((dt) => next.tick(dt));
    this.input = next;
    this.emit("input-changed", next);
  }

  async init(canvas) {
    // Re-init (viewport rebuild / dev HMR): retire the old renderer first so
    // its still-running animation loop can't render through the new,
    // not-yet-initialized one.
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
    }
    this.rendererReady = false;
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio ?? 1);
    await this.renderer.init();
    // Renderer-side settings (tone mapping, shadows) couldn't apply earlier.
    applySettingsToScene(this.settings, this.scene, this.ambientLight, this.renderer);
    this.rendererReady = true;
    // Wire input once the canvas exists (the manager listens on it directly).
    if (!this.input.attached) {
      this.input.attach(canvas);
      this._inputTickUnsub = this.onUpdate((dt) => this.input.tick(dt));
    }
    return this.getBackendName();
  }

  getBackendName() {
    const backend = this.renderer?.backend;
    if (!backend) return "none";
    return backend.isWebGPUBackend ? "WebGPU" : "WebGL2 (fallback)";
  }

  start() {
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  stop() {
    this.renderer.setAnimationLoop(null);
  }

  #tick() {
    this.timer.update();
    const dt = this.timer.getDelta();
    for (const fn of this.updateCallbacks) fn(dt);
    // rendererReady guards the re-init window (init() swaps the renderer
    // asynchronously; rendering before its backend resolves throws).
    if (this.camera && this.rendererReady) this.renderer.render(this.scene, this.camera);
    // Post-render passes draw on top of the main render's pixels. The
    // WebGPU backend's render pass starts with `loadOp: Clear`, so any
    // post-render `renderer.render(...)` would wipe the canvas — callers
    // must temporarily disable `autoClear` (and re-enable it) to preserve
    // the main scene underneath.
    for (const fn of this.postRenderCallbacks) fn();
  }

  /** Register a per-frame callback; returns an unsubscribe function. */
  onUpdate(fn) {
    this.updateCallbacks.add(fn);
    return () => this.updateCallbacks.delete(fn);
  }

  /**
   * Register a callback that fires after the main render each frame.
   * Use for layered effects (camera preview, gizmo overlays) that need
   * to draw on top of the main scene. The callback is responsible for
   * setting up its own render state (scissor, viewport, autoClear) so
   * the main render's pixels survive.
   */
  onPostRender(fn) {
    this.postRenderCallbacks.add(fn);
    return () => this.postRenderCallbacks.delete(fn);
  }

  setSize(width, height) {
    if (!this.renderer || width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    if (this.camera?.isPerspectiveCamera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }

  createEntity({ id, name = "Entity", parent = null } = {}) {
    const entity = new Entity(this, { id, name });
    this.entities.set(entity.id, entity);
    entity.setParent(parent);
    this.emit("hierarchy-changed");
    return entity;
  }

  destroyEntity(entity) {
    // Remove children first (bottom-up) so component teardown sees a live tree.
    for (const child of [...entity.children]) this.destroyEntity(child);
    entity.dispose();
    if (entity.parent) {
      const idx = entity.parent.children.indexOf(entity);
      if (idx !== -1) entity.parent.children.splice(idx, 1);
      entity.parent.object3D.remove(entity.object3D);
    } else {
      const idx = this.rootEntities.indexOf(entity);
      if (idx !== -1) this.rootEntities.splice(idx, 1);
      this.scene.remove(entity.object3D);
    }
    this.entities.delete(entity.id);
    this.emit("hierarchy-changed");
  }

  getEntity(id) {
    return this.entities.get(id);
  }

  clear() {
    for (const entity of [...this.rootEntities]) this.destroyEntity(entity);
    this.sceneName = "Untitled";
    this.applySettings(structuredClone(SCENE_SETTINGS_DEFAULTS));
    this.emit("hierarchy-changed");
  }

  dispose() {
    this.stop();
    this.clear();
    this._inputTickUnsub?.();
    this._inputTickUnsub = null;
    this.input.detach();
    this.rendererReady = false;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
