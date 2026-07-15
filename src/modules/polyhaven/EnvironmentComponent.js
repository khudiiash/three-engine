import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { resolveAssetUrl } from "../../engine/assetResolver.js";

/**
 * HDRI environment: image-based lighting + optional skybox background from an
 * equirectangular .hdr/.exr asset (the format PolyHaven ships). Attaching it
 * takes over `scene.environment` (and `scene.background` when enabled);
 * detaching restores whatever the scene settings had before.
 *
 * One environment is active at a time — the last attached component wins.
 * Registered by the `polyhaven` module, but works with any HDR asset.
 */
export class EnvironmentComponent extends Component {
  static type = "environment";
  static label = "Environment (HDRI)";
  static tags = ["rendering", "lighting", "hdri", "skybox"];
  static defaults = {
    hdri: "",
    background: true,
    intensity: 1,
    blur: 0,
    rotation: 0, // degrees around Y
  };
  static schema = [
    { key: "hdri", label: "HDRI", type: "asset", exts: ["hdr", "exr"] },
    { key: "background", label: "Show as Sky", type: "boolean" },
    { key: "intensity", label: "Intensity", type: "number", min: 0, step: 0.1 },
    { key: "blur", label: "Background Blur", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "rotation", label: "Rotation°", type: "number", min: 0, max: 360, step: 1 },
  ];

  #texture = null;
  #generation = 0;
  #prev = null; // { background, environment } captured before we took over

  onAttach() {
    this.#reload();
  }

  onDetach() {
    this.#generation++;
    this.#release();
  }

  onDisable() {
    this.#unapply();
  }

  onEnable() {
    this.#apply();
  }

  onPropChanged(key) {
    if (key === "hdri") this.#reload();
    else this.#apply();
  }

  get #scene() {
    return this.entity?.engine?.scene ?? null;
  }

  async #reload() {
    const generation = ++this.#generation;
    this.#release();
    const path = this.props.hdri;
    if (!path) return;
    let texture;
    try {
      texture = await this.#loadEquirect(path);
    } catch (err) {
      console.error(`Environment: couldn't load "${path}": ${err.message ?? err}`);
      return;
    }
    // A newer reload/detach happened while we were fetching — drop the result.
    if (generation !== this.#generation) {
      texture.dispose();
      return;
    }
    texture.mapping = THREE.EquirectangularReflectionMapping;
    this.#texture = texture;
    this.#apply();
  }

  async #loadEquirect(path) {
    const url = await resolveAssetUrl(path);
    if (/\.exr$/i.test(path)) {
      const { EXRLoader } = await import("three/addons/loaders/EXRLoader.js");
      return new EXRLoader().loadAsync(url);
    }
    const { RGBELoader } = await import("three/addons/loaders/RGBELoader.js");
    return new RGBELoader().loadAsync(url);
  }

  /** Pushes texture + params onto the scene, capturing prior state once. */
  #apply() {
    const scene = this.#scene;
    if (!scene || !this.#texture || !this._enabled) return;
    if (!this.#prev) {
      this.#prev = { background: scene.background, environment: scene.environment };
    }
    const rad = THREE.MathUtils.degToRad(this.props.rotation ?? 0);
    scene.environment = this.#texture;
    scene.environmentIntensity = this.props.intensity ?? 1;
    scene.environmentRotation.set(0, rad, 0);
    if (this.props.background !== false) {
      scene.background = this.#texture;
      scene.backgroundIntensity = this.props.intensity ?? 1;
      scene.backgroundBlurriness = this.props.blur ?? 0;
      scene.backgroundRotation.set(0, rad, 0);
    } else if (scene.background === this.#texture) {
      scene.background = this.#prev.background;
    }
  }

  /** Undoes #apply — restores only what we set, keeps the loaded texture. */
  #unapply() {
    const scene = this.#scene;
    if (!scene || !this.#prev) return;
    if (scene.environment === this.#texture) scene.environment = this.#prev.environment;
    if (scene.background === this.#texture) {
      scene.background = this.#prev.background;
      scene.backgroundBlurriness = 0;
    }
    this.#prev = null;
  }

  /** Full teardown: scene restore + texture disposal. */
  #release() {
    this.#unapply();
    this.#texture?.dispose();
    this.#texture = null;
  }
}
