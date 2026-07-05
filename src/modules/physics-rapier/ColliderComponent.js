import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";

const GIZMO_COLOR = 0x2df098;

/**
 * Collision shape. Pairs with a Rigidbody on the same entity (or the nearest
 * ancestor Rigidbody — child colliders form a compound body). A collider with
 * no Rigidbody anywhere above it becomes static level geometry.
 *
 * `shape: "mesh"` builds a trimesh from the entity's rendered geometry at
 * play start (static/kinematic use only — Rapier trimeshes are hollow).
 * Shows a wireframe gizmo on the editor-only layer.
 */
export class ColliderComponent extends Component {
  static type = "collider";
  static label = "Collider";
  static defaults = {
    shape: "box",
    size: [1, 1, 1],
    radius: 0.5,
    height: 1,
    offset: [0, 0, 0],
    friction: 0.5,
    restitution: 0,
    isSensor: false,
  };
  static schema = [
    { key: "shape", label: "Shape", type: "select", options: ["box", "sphere", "capsule", "mesh"] },
    { key: "size", label: "Size", type: "vec3", showIf: (p) => p.shape === "box" },
    { key: "radius", label: "Radius", type: "number", min: 0.01, step: 0.05, showIf: (p) => p.shape === "sphere" || p.shape === "capsule" },
    { key: "height", label: "Height", type: "number", min: 0.01, step: 0.05, showIf: (p) => p.shape === "capsule" },
    { key: "offset", label: "Offset", type: "vec3", showIf: (p) => p.shape !== "mesh" },
    { key: "friction", label: "Friction", type: "number", min: 0, max: 2, step: 0.05 },
    { key: "restitution", label: "Bounciness", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "isSensor", label: "Is Trigger", type: "boolean" },
  ];

  onAttach() {
    this.collider = null; // assigned by PhysicsSystem while playing
    this.#buildGizmo();
  }

  onDetach() {
    this.collider = null;
    this.#disposeGizmo();
  }

  #buildGizmo() {
    const { shape, size, radius, height, offset } = this.props;
    let geometry = null;
    if (shape === "box") {
      geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(size[0], size[1], size[2]));
    } else if (shape === "sphere") {
      geometry = new THREE.WireframeGeometry(new THREE.SphereGeometry(radius, 12, 8));
    } else if (shape === "capsule") {
      geometry = new THREE.WireframeGeometry(new THREE.CapsuleGeometry(radius, height, 4, 8));
    }
    if (!geometry) return; // mesh shape: the rendered mesh is its own outline

    this.gizmo = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: GIZMO_COLOR, transparent: true, opacity: 0.7, depthTest: false }),
    );
    this.gizmo.position.fromArray(offset);
    this.gizmo.layers.set(EDITOR_LAYER);
    this.gizmo.userData.engineOwned = true;
    this.gizmo.raycast = () => {}; // never intercept viewport picking
    this.entity.object3D.add(this.gizmo);
  }

  #disposeGizmo() {
    if (!this.gizmo) return;
    this.entity.object3D.remove(this.gizmo);
    this.gizmo.geometry.dispose();
    this.gizmo.material.dispose();
    this.gizmo = null;
  }
}
