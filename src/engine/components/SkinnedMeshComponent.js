import { Component } from "./Component.js";
import {
  loadMaterialAsset,
  getMaterialInstance,
  subscribeMaterial,
} from "../materialAsset.js";

/**
 * Per-mesh handle inside an imported skeletal model (Unity's
 * SkinnedMeshRenderer analogue). The ancestor model component owns the GLB
 * scene — skinned geometry can't leave it (skeleton + clips live there) — so
 * this component *references* one of its meshes by child-index path and gives
 * it a normal entity presence: an inspector section (material / shadows), an
 * eye toggle, and viewport picking that selects this entity instead of the
 * whole rig.
 *
 * Created by the GLB import for every mesh in an animated model; not offered
 * in the Add Component menu (it's meaningless without a rig above it).
 */
export class SkinnedMeshComponent extends Component {
  static type = "skinnedmesh";
  static label = "Skinned Mesh";
  // Import-only: visible as an inspector section, hidden from Add Component.
  static importOnly = true;
  static defaults = {
    path: "", // child-index path of the mesh inside the model's GLB scene
    material: "", // .mat override; empty = the GLB's own material
    castShadow: true,
    receiveShadow: true,
  };
  static schema = [
    { key: "material", label: "Material", type: "asset", exts: ["mat"] },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  onAttach() {
    this.mesh = null;
    this.originalMaterial = null;
    this.generation = (this.generation ?? 0) + 1;
    // The owner model loads its GLB async — (re)bind whenever it announces.
    this.unsubModelLoaded = this.entity.engine.on("model-loaded", (entity) => {
      if (this.#ownerModel()?.entity === entity) this.#bind();
    });
    this.#bind();
  }

  onDetach() {
    this.generation = (this.generation ?? 0) + 1;
    this.unsubModelLoaded?.();
    this.unsubModelLoaded = null;
    this.materialUnsub?.();
    this.materialUnsub = null;
    this.#unbind();
  }

  onDisable() {
    if (this.mesh) this.mesh.visible = false;
  }

  onEnable() {
    if (this.mesh) this.mesh.visible = true;
  }

  onPropChanged(key) {
    if (!this.mesh) return;
    if (key === "material") this.#applyMaterial();
    else if (key === "castShadow" || key === "receiveShadow") this.mesh[key] = !!this.props[key];
    else if (key === "path") this.#bind();
  }

  /** The nearest ancestor model component owns this marker (nested rigs stay isolated). */
  #ownerModel() {
    for (let entity = this.entity?.parent; entity; entity = entity.parent) {
      const model = entity.getComponent("model");
      if (model) return model;
    }
    return null;
  }

  #bind() {
    this.#unbind();
    const model = this.#ownerModel();
    const mesh = resolveMesh(model?.root, this.props.path);
    if (!mesh) return; // model still loading (model-loaded will retry) or bad path
    this.mesh = mesh;
    this.originalMaterial = mesh.material;
    // Picking: clicking this mesh in the viewport selects this entity, not
    // the rig root (the model stamped its own id on every descendant).
    mesh.userData.entityId = this.entity.id;
    mesh.castShadow = this.props.castShadow !== false;
    mesh.receiveShadow = this.props.receiveShadow !== false;
    mesh.visible = this._enabled;
    this.#applyMaterial();
  }

  /** Releases the reference without touching model-owned resources. */
  #unbind() {
    if (!this.mesh) return;
    const ownerEntity = this.#ownerModel()?.entity;
    if (this.mesh.userData.entityId === this.entity.id && ownerEntity) {
      this.mesh.userData.entityId = ownerEntity.id;
    }
    if (this.originalMaterial) this.mesh.material = this.originalMaterial;
    this.mesh.visible = true;
    this.mesh = null;
    this.originalMaterial = null;
  }

  async #applyMaterial() {
    this.materialUnsub?.();
    this.materialUnsub = null;
    const mesh = this.mesh;
    const path = this.props.material;
    if (!path) {
      if (this.originalMaterial) mesh.material = this.originalMaterial;
      return;
    }
    const generation = ++this.generation;
    const shared = await loadMaterialAsset(path);
    if (generation !== this.generation || this.mesh !== mesh || !shared) return;
    // The model disposes every material it doesn't recognise on teardown;
    // registering ours protects the shared .mat instance (it lives in the
    // materialAsset cache and other meshes may use it).
    this.#ownerModel()?.sharedMaterials?.add(shared);
    mesh.material = shared;
    // Track surface↔volume instance swaps like MeshComponent does.
    this.materialUnsub = subscribeMaterial(path, () => {
      const next = getMaterialInstance(path);
      if (next && this.mesh === mesh) {
        this.#ownerModel()?.sharedMaterials?.add(next);
        mesh.material = next;
      }
    });
  }
}

/** Resolves a slash-separated child-index path to a mesh inside `root`. */
function resolveMesh(root, path) {
  if (!root || typeof path !== "string" || !path) return null;
  let object = root;
  for (const part of path.split("/")) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0) return null;
    object = object.children[index];
    if (!object) return null;
  }
  return object.isMesh ? object : null;
}
