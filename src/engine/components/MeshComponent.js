import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { loadMaterialAsset, getDefaultMaterial } from "../materialAsset.js";

const geometryFactories = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  sphere: () => new THREE.SphereGeometry(0.5, 32, 16),
  plane: () => new THREE.PlaneGeometry(1, 1),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
  cone: () => new THREE.ConeGeometry(0.5, 1, 32),
  torus: () => new THREE.TorusGeometry(0.4, 0.15, 16, 48),
};

/**
 * Geometry + a material asset reference. All surface properties live in the
 * .mat asset (shared instance, see materialAsset.js); with no material
 * assigned the mesh uses the shared default white material. Meshes never
 * dispose materials — they don't own them.
 */
export class MeshComponent extends Component {
  static type = "mesh";
  static label = "Mesh";
  static defaults = {
    geometry: "box",
    material: "", // .mat asset path; empty = default white
    castShadow: true,
    receiveShadow: true,
  };
  static schema = [
    { key: "geometry", label: "Geometry", type: "select", options: Object.keys(geometryFactories) },
    { key: "material", label: "Material", type: "asset", exts: ["mat"] },
    { key: "castShadow", label: "Cast Shadow", type: "boolean" },
    { key: "receiveShadow", label: "Receive Shadow", type: "boolean" },
  ];

  onAttach() {
    const makeGeometry = geometryFactories[this.props.geometry] ?? geometryFactories.box;
    this.mesh = new THREE.Mesh(makeGeometry(), getDefaultMaterial());
    this.mesh.userData.entityId = this.entity.id;
    this.mesh.castShadow = !!this.props.castShadow;
    this.mesh.receiveShadow = !!this.props.receiveShadow;
    this.entity.object3D.add(this.mesh);
    if (this.props.material) this.#loadSharedMaterial(this.props.material);
  }

  onDetach() {
    if (!this.mesh) return;
    this.sharedGeneration = (this.sharedGeneration ?? 0) + 1;
    this.entity.object3D.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
  }

  async #loadSharedMaterial(path) {
    const generation = (this.sharedGeneration = (this.sharedGeneration ?? 0) + 1);
    const shared = await loadMaterialAsset(path);
    if (generation !== this.sharedGeneration || !this.mesh) return;
    this.mesh.material = shared;
  }

  onPropChanged(key) {
    if (key === "geometry" || !this.mesh) {
      super.onPropChanged();
      return;
    }
    if (key === "material") {
      this.sharedGeneration = (this.sharedGeneration ?? 0) + 1;
      if (this.props.material) this.#loadSharedMaterial(this.props.material);
      else this.mesh.material = getDefaultMaterial();
    } else if (key === "castShadow" || key === "receiveShadow") {
      this.mesh[key] = !!this.props[key];
    }
  }
}
