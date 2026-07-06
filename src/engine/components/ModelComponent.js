import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Component } from "./Component.js";
import { resolveAssetUrl } from "../assetResolver.js";
import { loadMaterialAsset } from "../materialAsset.js";

const loader = new GLTFLoader();

export class ModelComponent extends Component {
  static type = "model";
  static label = "Model";
  static defaults = {
    path: "",
    materials: {}, // GLTF material name -> .mat asset path override
    castShadow: true,
    receiveShadow: true,
  };
  static schema = [
    { key: "path", label: "File", type: "asset", exts: ["glb"] },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  onAttach() {
    this.root = null;
    this.clips = [];
    this.sharedMaterials = new Set(); // .mat-backed materials we must not dispose
    this.generation = (this.generation ?? 0) + 1;
    if (this.props.path) this.#load(this.props.path, this.generation);
  }

  async #load(path, generation) {
    try {
      const url = await resolveAssetUrl(path);
      const gltf = await loader.loadAsync(url);
      if (generation !== this.generation) return; // detached/reloaded meanwhile
      this.root = gltf.scene;
      this.clips = gltf.animations ?? [];
      this.root.userData.entityId = this.entity.id;
      this.root.traverse((obj) => {
        obj.userData.entityId = this.entity.id;
        if (obj.isMesh) {
          obj.castShadow = this.props.castShadow !== false;
          obj.receiveShadow = this.props.receiveShadow !== false;
        }
      });
      this.entity.object3D.add(this.root);
      await this.#applyMaterialOverrides(generation);
      // Honour the enabled flag at load time — visible by default, hidden if
      // the user saved the scene with the component disabled.
      this.root.visible = this._enabled;
      this.entity.engine.emit("model-loaded", this.entity);
    } catch (err) {
      console.error(`Failed to load model "${path}": ${err.message}`);
    }
  }

  /** Swaps named GLTF materials for shared .mat assets (props.materials). */
  async #applyMaterialOverrides(generation) {
    const overrides = this.props.materials ?? {};
    if (!this.root || !Object.keys(overrides).length) return;
    const meshes = [];
    this.root.traverse((obj) => obj.isMesh && meshes.push(obj));
    for (const mesh of meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const replaced = await Promise.all(
        mats.map(async (mat) => {
          const matPath = mat?.name != null ? overrides[mat.name] : null;
          if (!matPath) return mat;
          const shared = await loadMaterialAsset(matPath);
          this.sharedMaterials.add(shared);
          if (mat && !this.sharedMaterials.has(mat)) mat.dispose();
          return shared;
        }),
      );
      if (generation !== this.generation) return;
      mesh.material = Array.isArray(mesh.material) ? replaced : replaced[0];
    }
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    if (!this.root) return;
    this.entity.object3D.remove(this.root);
    this.root.traverse((obj) => {
      obj.geometry?.dispose();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        if (mat && !this.sharedMaterials.has(mat)) mat.dispose();
      }
    });
    this.root = null;
    this.clips = [];
    this.sharedMaterials.clear();
  }

  onDisable() {
    if (this.root) this.root.visible = false;
  }

  onEnable() {
    if (this.root) this.root.visible = true;
  }

  onPropChanged(key) {
    if ((key === "castShadow" || key === "receiveShadow") && this.root) {
      this.root.traverse((obj) => {
        if (obj.isMesh) obj[key] = this.props[key] !== false;
      });
      return;
    }
    this.onDetach();
    this.onAttach();
  }
}
