import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import {
  loadMaterialAsset,
  getDefaultMaterial,
  isVolumeMaterial,
  getMaterialInstance,
  isMaterialRenderable,
  subscribeMaterial,
} from "../materialAsset.js";
import { loadGeometryAsset } from "../geometryAsset.js";

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
    geometryAsset: "",
    material: "", // .mat asset path; empty = default white
    castShadow: true,
    receiveShadow: true,
  };
  static schema = [
    { key: "geometry", label: "Geometry", type: "select", options: Object.keys(geometryFactories) },
    { key: "geometryAsset", label: "Geometry Asset", type: "asset", exts: ["geom"] },
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
    if (this.props.geometryAsset) this.#loadGeometry(this.props.geometryAsset);
    if (this.props.material) this.#loadSharedMaterial(this.props.material);
    // Honour the enabled flag at attach time.
    this.mesh.visible = this.enabled;
  }

  onDetach() {
    if (!this.mesh) return;
    this.geometryGeneration = (this.geometryGeneration ?? 0) + 1;
    this.sharedGeneration = (this.sharedGeneration ?? 0) + 1;
    this.materialUnsub?.();
    this.materialUnsub = null;
    this.entity.object3D.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
  }

  onDisable() {
    if (this.mesh) this.mesh.visible = false;
  }

  onEnable() {
    // A material with nothing wired to Surface/Volume must stay hidden even
    // when the component is enabled.
    if (this.mesh) this.mesh.visible = this.materialRenderable !== false;
  }

  async #loadSharedMaterial(path) {
    const generation = (this.sharedGeneration = (this.sharedGeneration ?? 0) + 1);
    await loadMaterialAsset(path);
    if (generation !== this.sharedGeneration || !this.mesh) return;
    // Re-adopt on every change: the shared instance is swapped when the .mat
    // flips surface ↔ volume, and its renderable state flips when the graph's
    // Surface/Volume wiring changes.
    this.materialUnsub?.();
    this.materialUnsub = subscribeMaterial(path, () => this.#applySharedMaterial(path));
    this.#applySharedMaterial(path);
  }

  async #loadGeometry(path) {
    const generation = (this.geometryGeneration = (this.geometryGeneration ?? 0) + 1);
    try {
      const geometry = await loadGeometryAsset(path);
      if (generation !== this.geometryGeneration || !this.mesh) {
        geometry.dispose();
        return;
      }
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
      this.#announceSwap("geometryAsset"); // same stale-reference problem as material
    } catch (err) {
      console.warn(`Couldn't load geometry asset "${path}": ${err}`);
    }
  }

  #applySharedMaterial(path) {
    if (!this.mesh) return;
    this.mesh.material = getMaterialInstance(path) ?? getDefaultMaterial();
    this.materialRenderable = isMaterialRenderable(path);
    // A volume material renders nothing on the box's faces — the geometry is
    // just the raymarch container, so it must be the unit box that
    // `unitBoxMask` clips against. Snap non-box geometry to one.
    if (isVolumeMaterial(path) && (this.props.geometry !== "box" || this.props.geometryAsset)) {
      this.geometryGeneration = (this.geometryGeneration ?? 0) + 1;
      console.warn(`Mesh "${this.entity?.name ?? this.entity?.id}" uses a volume .mat — snapping geometry to box for correct raymarch bounds.`);
      this.mesh.geometry.dispose();
      this.mesh.geometry = new THREE.BoxGeometry(1, 1, 1);
      this.props.geometry = "box";
      this.props.geometryAsset = "";
    }
    this.mesh.visible = this.enabled && this.materialRenderable !== false;
    // `mesh.material` is a *new object* now — the shared .mat instance replaced
    // the placeholder default we were created with. Anything that captured the
    // old reference (terrain scatter builds InstancedMeshes from this mesh) is
    // holding a stale material and would render white forever. This resolve is
    // async and isn't a `setProp`, so nothing else announces it.
    this.#announceSwap("material");
  }

  #announceSwap(key) {
    this.entity?.engine?.emit?.("component-changed", {
      entityId: this.entity?.id,
      componentType: this.type,
      key,
    });
  }

  onPropChanged(key) {
    if (key === "geometry" || !this.mesh) {
      super.onPropChanged();
      return;
    }
    if (key === "geometryAsset") {
      this.geometryGeneration = (this.geometryGeneration ?? 0) + 1;
      if (this.props.geometryAsset) {
        this.#loadGeometry(this.props.geometryAsset);
      } else {
        this.mesh.geometry.dispose();
        const makeGeometry = geometryFactories[this.props.geometry] ?? geometryFactories.box;
        this.mesh.geometry = makeGeometry();
      }
    } else if (key === "material") {
      this.sharedGeneration = (this.sharedGeneration ?? 0) + 1;
      this.materialUnsub?.();
      this.materialUnsub = null;
      if (this.props.material) {
        this.#loadSharedMaterial(this.props.material);
      } else {
        this.mesh.material = getDefaultMaterial();
        this.materialRenderable = true;
        this.mesh.visible = this.enabled;
      }
    } else if (key === "castShadow" || key === "receiveShadow") {
      this.mesh[key] = !!this.props[key];
    }
  }
}
