import * as THREE from "three/webgpu";
import { Component } from "./Component.js";
import { EDITOR_LAYER } from "../editorLayers.js";

export class CameraComponent extends Component {
  static type = "camera";
  static label = "Camera";
  static defaults = {
    fov: 60,
    near: 0.1,
    far: 1000,
    // Preview / follow state travels with the camera component so it
    // stays attached to the entity that owns it (the user picks the
    // camera, the follow target lives on that camera). `showPreview`
    // and `followInViewport` are editor-only at runtime — the shipped
    // player simply ignores them — but we keep them on the component
    // anyway so the inspector's per-camera toggle round-trips cleanly
    // through save/load.
    showPreview: true,
    followTarget: null, // entity id (string) or null
    followInViewport: false,
    followInGame: false,
  };
  static schema = [
    { key: "fov", label: "FOV", type: "number", min: 1, max: 179, step: 1 },
    { key: "near", label: "Near", type: "number", min: 0.001, step: 0.1 },
    { key: "far", label: "Far", type: "number", min: 1, step: 10 },
  ];

  onAttach() {
    const { fov, near, far } = this.props;
    this.camera = new THREE.PerspectiveCamera(fov, 16 / 9, near, far);
    this.camera.userData.entityId = this.entity.id;
    this.entity.object3D.add(this.camera);
    this.model = buildCameraModel();
    this.model.traverse((child) => child.layers.set(EDITOR_LAYER));
    this.model.visible = this._enabled;
    this.entity.object3D.add(this.model);
    this.unsubUpdate = this.entity.engine.onUpdate(() => {
      if (!this.entity.engine.playing) return;
      this.applyLookAt(!!this.props.followInGame, this.entity.engine);
    });
  }

  onDetach() {
    if (!this.camera) return;
    this.entity.object3D.remove(this.camera);
    this.camera = null;
    if (this.model) {
      this.entity.object3D.remove(this.model);
      this.model.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      this.model = null;
    }
    if (this.unsubUpdate) {
      this.unsubUpdate();
      this.unsubUpdate = null;
    }
  }

  onDisable() {
    // Hide the editor gizmo (lens + frustum helper) and stop following the
    // target while disabled. The PerspectiveCamera itself stays attached so
    // toggling back on restores its FOV/transform without a rebuild.
    if (this.model) this.model.visible = false;
  }

  onEnable() {
    if (this.model) this.model.visible = true;
  }

  onPropChanged(key) {
    if (!this.camera) return;
    if (key === "fov" || key === "near" || key === "far") {
      this.camera[key] = this.props[key];
      this.camera.updateProjectionMatrix();
    }
    // showPreview / followTarget / followInViewport / followInGame are
    // consumed by the editor (preview toggle) and by the per-frame follow
    // tick; no three.js camera property to push.
  }

  /**
   * Returns the engine entity this camera should currently follow, or null
   * if no follow is configured / the configured target no longer exists.
   * Resolves the stored id string against the live engine — the engine
   * passed in is the one the component lives on.
   */
  resolveFollowTarget(engine) {
    const id = this.props.followTarget;
    if (!id) return null;
    return engine.getEntity(id) ?? null;
  }

  /**
   * When `enabled` is true and a follow target is configured, rotates the
   * camera entity so its -Z points at the target's world position. Position
   * is left alone (the user controls where the camera sits; the camera
   * always "looks at" the target).
   *
   * Safe to call every frame; uses a scratch vector to avoid allocations.
   */
  applyLookAt(enabled, engine) {
    if (!this.camera) return;
    if (!enabled) return;
    const target = this.resolveFollowTarget(engine);
    if (!target) return;
    const targetPos = _scratchTargetPos;
    target.object3D.getWorldPosition(targetPos);
    // The PerspectiveCamera lives as a child of the entity's object3D, so
    // rotating the entity rotates the camera. Object3D.lookAt orients +Z
    // at the target, but a PerspectiveCamera looks down its local -Z — so
    // we flip 180° around Y right after, giving us an entity orientation
    // whose -Z faces the target. Using the entity (not the camera) keeps
    // the gizmo and follow in sync: rotating the entity rotates the camera
    // and the editor's frustum helper together, instead of just the child.
    const obj = this.entity.object3D;
    obj.lookAt(targetPos);
    obj.rotateY(Math.PI);
  }
}

const _scratchTargetPos = new THREE.Vector3();

/**
 * Procedural camera mesh: a small boxy body with a cylindrical lens and a
 * wireframe frustum cone pointing along the entity's local -Z (which is
 * where a real PerspectiveCamera also looks). No extra rotation on the
 * group itself — the geometry is authored so the lens sits on the -Z face
 * directly.
 *
 * The whole model is pushed onto `EDITOR_LAYER` by the caller (see
 * `onAttach`), so it only renders to cameras that have that layer enabled
 * (the editor orbit camera). Picking still finds it because the editor's
 * raycaster tests every layer.
 */
function buildCameraModel() {
  const group = new THREE.Group();
  const bodyGeo = new THREE.BoxGeometry(0.35, 0.25, 0.45);
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  group.add(body);

  const vfGeo = new THREE.BoxGeometry(0.18, 0.07, 0.18);
  const vf = new THREE.Mesh(vfGeo, bodyMat);
  vf.position.set(0, 0.16, 0.05);
  group.add(vf);

  const lensGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.18, 24);
  lensGeo.rotateX(Math.PI / 2); // cylinder is Y-up by default; face it forward.
  const lensMat = new THREE.MeshBasicMaterial({ color: 0x3a3d44 });
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.position.set(0, 0, -0.28);
  group.add(lens);

  group.translateZ(0.325);

  return group;
}
