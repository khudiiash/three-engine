import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { resolveAssetUrl } from "../assetResolver.js";
import { AnimatorRuntime } from "../animGraph.js";

/**
 * Plays a .anim animation-controller asset against the sibling Model
 * component's clips. The state machine runs while playing (and, if
 * `playInEditor` is set, as an editor preview). Scripts drive it via
 *   entity.getComponent("animation").setNumber/setBool/setTrigger/play(...)
 */
export class AnimationComponent extends Component {
  static type = "animation";
  static label = "Animation";
  static defaults = { controller: "", playInEditor: true };
  static schema = [
    { key: "controller", label: "Controller", type: "asset", exts: ["anim"] },
    { key: "playInEditor", label: "Preview in Editor", type: "boolean" },
  ];

  onAttach() {
    this.generation = (this.generation ?? 0) + 1;
    this.graph = null;
    this.mixer = null;
    this.runtime = null;
    this.unsubUpdate = this.entity.engine.onUpdate((dt) => this.#tick(dt));
    // The model loads async — rebuild once its clips exist.
    this.unsubModel = this.entity.engine.on("model-loaded", (entity) => {
      if (entity === this.entity) this.#rebuild();
    });
    if (this.props.controller) this.#loadController(this.generation);
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.unsubUpdate?.();
    this.unsubModel?.();
    this.#teardownRuntime();
  }

  onPropChanged(key) {
    if (key === "playInEditor") return;
    this.#teardownRuntime();
    this.graph = null;
    if (this.props.controller) this.#loadController(this.generation);
  }

  /** Editor hook: run an in-memory graph (live preview of unsaved edits). */
  applyGraph(graph) {
    this.graph = graph;
    this.#rebuild();
  }

  /** Names of the clips available on the sibling model (editor UI). */
  getClipNames() {
    return (this.entity.getComponent("model")?.clips ?? []).map((c) => c.name);
  }

  // --- script-facing parameter API -----------------------------------------
  setNumber(name, value) {
    this.runtime?.setParam(name, value);
  }

  setBool(name, value) {
    this.runtime?.setParam(name, !!value);
  }

  setTrigger(name) {
    this.runtime?.setTrigger(name);
  }

  getParam(name) {
    return this.runtime?.getParam(name);
  }

  play(stateName, fade = 0.2) {
    this.runtime?.play(stateName, fade);
  }

  get currentState() {
    return this.runtime?.currentState?.name ?? null;
  }
  // --------------------------------------------------------------------------

  async #loadController(generation) {
    try {
      const url = await resolveAssetUrl(this.props.controller);
      const graph = await (await fetch(url)).json();
      if (generation !== this.generation) return;
      this.graph = graph;
      this.#rebuild();
    } catch (err) {
      console.error(`Failed to load animator "${this.props.controller}": ${err.message}`);
    }
  }

  #rebuild() {
    this.#teardownRuntime();
    const model = this.entity.getComponent("model");
    if (!this.graph || !model?.root || !model.clips?.length) return;
    this.mixer = new THREE.AnimationMixer(model.root);
    this.runtime = new AnimatorRuntime(this.graph, this.mixer, model.clips);
  }

  #teardownRuntime() {
    this.runtime?.dispose();
    if (this.mixer) {
      const root = this.mixer.getRoot();
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(root);
      // Return skinned meshes to their bind pose instead of freezing mid-clip.
      root?.traverse?.((obj) => obj.isSkinnedMesh && obj.skeleton?.pose());
    }
    this.mixer = null;
    this.runtime = null;
  }

  #tick(dt) {
    if (!this.runtime) return;
    if (this.entity.engine.playing || this.props.playInEditor) this.runtime.update(dt);
  }
}
