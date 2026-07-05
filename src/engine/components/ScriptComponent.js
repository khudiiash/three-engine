import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { loadScriptModule } from "../assetResolver.js";

const RELOAD_CHECK_INTERVAL = 0.75; // seconds

/**
 * Runs a user script file against this entity. A script module default-exports
 * a class or plain object with optional onStart(ctx)/onUpdate(ctx, dt)/
 * onDestroy(ctx) lifecycle hooks; `ctx` gives it { entity, engine, THREE }
 * instead of letting it import engine internals directly.
 *
 * Lifecycle only runs while `engine.playing` is true — editing the scene
 * with a script attached doesn't execute game logic. The file itself is
 * still polled and re-imported on change (hot reload) regardless of play
 * state, so edits are picked up as soon as Play starts.
 */
export class ScriptComponent extends Component {
  static type = "script";
  static label = "Script";
  static defaults = { path: "", attributes: {} };
  static schema = [{ key: "path", label: "File", type: "asset", exts: ["js", "ts"] }];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    this.moduleVersion = null;
    this.instance = null;
    this.running = false;
    this.reloadTimer = 0;
    this.unsubUpdate = this.entity.engine.onUpdate((dt) => this.#tick(dt));
    this.unsubPlayChanged = this.entity.engine.on("play-changed", (playing) => this.#setRunning(playing));
    if (this.props.path) this.#reloadModule();
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.#setRunning(false);
    this.unsubUpdate?.();
    this.unsubPlayChanged?.();
    this.instance = null;
  }

  onPropChanged(key) {
    if (key === "attributes") return this.#applyAttributes();
    if (key !== "path") return super.onPropChanged();
    this.#setRunning(false);
    this.moduleVersion = null;
    this.instance = null;
    if (this.props.path) this.#reloadModule();
  }

  /** Attribute descriptors declared by the loaded script (via @attribute). */
  getAttributeDefs() {
    return this.instance?.constructor?.attributes ?? {};
  }

  /** Writes saved attribute values (falling back to defaults) onto the instance. */
  #applyAttributes() {
    if (!this.instance) return;
    for (const [key, def] of Object.entries(this.getAttributeDefs())) {
      const saved = this.props.attributes?.[key];
      this.instance[key] = saved !== undefined ? saved : (def.default ?? this.instance[key]);
    }
  }

  /** Scripts are their own context: this.entity / this.engine / this.THREE / this.input. */
  #bind(instance) {
    if (!instance) return instance;
    instance.entity = this.entity;
    instance.engine = this.entity.engine;
    instance.THREE = THREE;
    instance.input = this.entity.engine.input;
    return instance;
  }

  #setRunning(running) {
    if (running === this.running) return;
    this.running = running;
    if (running) this.instance?.onStart?.();
    else this.instance?.onDestroy?.();
  }

  async #reloadModule() {
    const generation = this.generation;
    try {
      const mod = await loadScriptModule(this.props.path);
      if (generation !== this.generation || mod.version === this.moduleVersion) return;

      const wasRunning = this.running;
      const oldInstance = this.instance;
      const Impl = mod.default;
      this.instance = this.#bind(typeof Impl === "function" ? new Impl() : (Impl ?? null));
      this.moduleVersion = mod.version;
      this.#applyAttributes();
      // Hot swap while running: if the script defines onHotReload, hand it the
      // old instance to carry state over instead of a destroy/start cycle.
      if (wasRunning && this.instance?.onHotReload) {
        this.instance.onHotReload(oldInstance);
        this.entity.engine.emit("script-loaded", this);
        return;
      }
      if (wasRunning) oldInstance?.onDestroy?.();
      this.running = false;
      if (wasRunning || this.entity.engine.playing) this.#setRunning(true);
      this.entity.engine.emit("script-loaded", this);
    } catch (err) {
      console.error(`Script "${this.props.path}" failed to load: ${err.message}`);
    }
  }

  #tick(dt) {
    const config = this.entity.engine.config ?? {};
    const interval = (config.scriptReloadIntervalMs ?? RELOAD_CHECK_INTERVAL * 1000) / 1000;
    this.reloadTimer += dt;
    if (this.reloadTimer >= interval) {
      this.reloadTimer = 0;
      if (this.props.path && config.scriptHotReload !== false) this.#reloadModule();
    }
    if (this.running) this.instance?.onUpdate?.(dt);
  }
}
