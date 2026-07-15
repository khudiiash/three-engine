import * as THREE from "three/webgpu";
import { Component } from "./Component.js";

const SHADOW_TYPE_OPTIONS = ["BasicShadowMap", "PCFShadowMap", "PCFSoftShadowMap", "VSMShadowMap"];
const _ownerWorld = new THREE.Matrix4();
const _inverseOwnerWorld = new THREE.Matrix4();
const _worldRotation = new THREE.Quaternion();
const _direction = new THREE.Vector3();
const _lightWorld = new THREE.Vector3();
const _targetWorld = new THREE.Vector3();
const _cameraWorld = new THREE.Vector3();
const _shadowCentre = new THREE.Vector3();
const _shadowRight = new THREE.Vector3();
const _shadowUp = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

export class LightComponent extends Component {
  static type = "light";
  static label = "Light";
  static defaults = {
    kind: "directional",
    color: "#ffffff",
    intensity: 1,
    distance: 0, // point/spot: 0 = infinite
    angle: 45, // spot cone angle, degrees
    decay: 2, // physical light decay (point/spot). 0 = classic inverse-square-free.
    penumbra: 0, // spot: 0..1 softness at the cone edge
    castShadow: false,
    // Shadow-map settings (per-light). Mirrors three.js Light.shadow.* fields.
    shadowMapType: "PCFSoftShadowMap",
    shadowMapWidth: 2048,
    shadowMapHeight: 2048,
    shadowBias: -0.0005,
    shadowNormalBias: 0.02,
    shadowRadius: 1, // PCFSoft / VSM blur radius
    // Directional / spot shadow camera (orthographic frustum).
    shadowCamNear: 0.1,
    shadowCamFar: 100,
    shadowCamSize: 20, // orthographic half-extent (left/right/top/bottom = ±size)
    shadowCamFov: 90, // point-light cube: face FOV in degrees
    // Centre directional shadow coverage on the active camera without
    // inheriting that camera's rotation.
    shadowFollowCamera: false,
  };
  // Schema entries with `showIf` are auto-filtered by the Inspector; see
  // ComponentSection. `section` is just a label prefix in the inspector.
  static schema = [
    { key: "kind", label: "Type", type: "select", options: ["directional", "point", "spot", "ambient"] },
    { key: "color", label: "Color", type: "color" },
    { key: "intensity", label: "Intensity", type: "number", min: 0, step: 0.1 },
    { key: "distance", label: "Distance", type: "number", min: 0, step: 0.5, showIf: (p) => p.kind === "point" || p.kind === "spot" },
    { key: "decay", label: "Decay", type: "number", min: 0, max: 5, step: 0.1, showIf: (p) => p.kind === "point" || p.kind === "spot" },
    { key: "angle", label: "Angle°", type: "number", min: 1, max: 90, step: 1, showIf: (p) => p.kind === "spot" },
    { key: "penumbra", label: "Penumbra", type: "number", min: 0, max: 1, step: 0.05, showIf: (p) => p.kind === "spot" },
    { key: "castShadow", label: "Cast Shadow", type: "boolean", showIf: (p) => p.kind !== "ambient" },
    // Shadow-map controls. Master switch (castShadow) gates the rest via showIf
    // so the inspector stays tidy when shadows are off.
    { key: "shadowMapType", label: "Map Type", type: "select", options: SHADOW_TYPE_OPTIONS, showIf: (p) => p.kind !== "ambient" && p.castShadow, section: "Shadow" },
    { key: "shadowMapWidth", label: "Map Width", type: "number", min: 16, step: 256, showIf: (p) => p.kind !== "ambient" && p.castShadow, section: "Shadow" },
    { key: "shadowMapHeight", label: "Map Height", type: "number", min: 16, step: 256, showIf: (p) => p.kind !== "ambient" && p.castShadow, section: "Shadow" },
    { key: "shadowBias", label: "Bias", type: "number", step: 0.0005, showIf: (p) => p.kind !== "ambient" && p.castShadow, section: "Shadow" },
    { key: "shadowNormalBias", label: "Normal Bias", type: "number", step: 0.005, showIf: (p) => p.kind !== "ambient" && p.castShadow, section: "Shadow" },
    { key: "shadowRadius", label: "Radius", type: "number", min: 0, step: 0.5, showIf: (p) => p.kind !== "ambient" && p.castShadow, section: "Shadow" },
    { key: "shadowCamNear", label: "Cam Near", type: "number", min: 0, step: 0.1, showIf: (p) => (p.kind === "directional" || p.kind === "spot" || p.kind === "point") && p.castShadow, section: "Shadow" },
    { key: "shadowCamFar", label: "Cam Far", type: "number", min: 0, step: 1, showIf: (p) => (p.kind === "directional" || p.kind === "spot" || p.kind === "point") && p.castShadow, section: "Shadow" },
    { key: "shadowCamSize", label: "Frustum Size", type: "number", min: 0.1, step: 1, showIf: (p) => (p.kind === "directional" || p.kind === "spot") && p.castShadow, section: "Shadow" },
    { key: "shadowFollowCamera", label: "Follow Camera", type: "boolean", showIf: (p) => p.kind === "directional" && p.castShadow, section: "Shadow" },
    { key: "shadowCamFov", label: "Face FOV°", type: "number", min: 1, max: 179, step: 1, showIf: (p) => p.kind === "point" && p.castShadow, section: "Shadow" },
  ];

  onAttach() {
    this.#buildLight();
  }

  onDetach() {
    this.unsubPreRender?.();
    this.unsubPreRender = null;
    if (!this.light) return;
    if (this.light.target) this.entity.object3D.remove(this.light.target);
    this.entity.object3D.remove(this.light);
    this.light.dispose?.();
    this.light = null;
  }

  onDisable() {
    if (this.light) this.light.visible = false;
  }

  onEnable() {
    if (this.light) this.light.visible = true;
  }

  onPropChanged(key) {
    // Switching `kind` swaps the entire three.js light instance (point vs
    // spot vs directional have different constructors and shadow camera
    // shapes). Tear the old one down and rebuild from current props.
    if (key === "kind" || !this.light) {
      this.onDetach();
      this.#buildLight();
      return;
    }
    this.#applyShadowProp(key);
    if (key === "color") this.light.color.set(this.props.color);
    else if (key === "intensity") this.light.intensity = this.props.intensity;
    else if (key === "distance") {
      if ("distance" in this.light) this.light.distance = this.props.distance;
    } else if (key === "decay") {
      if ("decay" in this.light) this.light.decay = this.props.decay;
    } else if (key === "penumbra") {
      if ("penumbra" in this.light) this.light.penumbra = this.props.penumbra;
    } else if (key === "angle") {
      if (this.light.isSpotLight) this.light.angle = THREE.MathUtils.degToRad(this.props.angle);
    } else if (key === "castShadow") {
      if (this.light.shadow) this.light.castShadow = !!this.props.castShadow;
    } else if (key in this.light) this.light[key] = this.props[key];
  }

  #buildLight() {
    const {
      kind,
      color,
      intensity,
      distance,
      angle,
      decay,
      penumbra,
      castShadow,
      shadowMapWidth,
      shadowMapHeight,
      shadowCamNear,
      shadowCamFar,
      shadowCamSize,
      shadowCamFov,
    } = this.props;

    switch (kind) {
      case "point":
        // PointLight: constructor (color, intensity, distance, decay).
        this.light = new THREE.PointLight(color, intensity, distance, decay);
        break;
      case "spot":
        // SpotLight: constructor (color, intensity, distance, angle, penumbra, decay).
        this.light = new THREE.SpotLight(
          color,
          intensity,
          distance,
          THREE.MathUtils.degToRad(angle),
          penumbra,
          decay,
        );
        break;
      case "ambient":
        this.light = new THREE.AmbientLight(color, intensity);
        break;
      case "directional":
      default:
        this.light = new THREE.DirectionalLight(color, intensity);
        break;
    }
    this.light.userData.entityId = this.entity.id;
    if (this.light.shadow) {
      this.#configureShadow({
        shadowMapWidth,
        shadowMapHeight,
        shadowCamNear,
        shadowCamFar,
        shadowCamSize,
        shadowCamFov,
      });
      this.light.castShadow = !!castShadow;
    }
    this.entity.object3D.add(this.light);
    // Directional/spot lights aim at their target; keep the target with the entity
    // so rotating the entity re-aims the light.
    if (this.light.target) {
      this.light.target.position.set(0, 0, -1);
      this.entity.object3D.add(this.light.target);
    }
    // Resolve after scripts and physics have finalized this frame's camera
    // and entity transforms. This also makes translation and non-uniform
    // parent scale incapable of changing a directional light's angle.
    if (this.light.isDirectionalLight) {
      this.unsubPreRender = this.entity.engine.onPreRender(() => this.#syncDirectionalTransform());
      this.#syncDirectionalTransform();
    }
    // Honour the enabled flag at attach time.
    this.light.visible = this._enabled;
  }

  #syncDirectionalTransform() {
    if (!this.light?.isDirectionalLight || !this.light.target) return;

    const owner = this.entity.object3D;
    owner.updateWorldMatrix(true, false);
    _ownerWorld.copy(owner.matrixWorld);
    _inverseOwnerWorld.copy(_ownerWorld).invert();
    owner.getWorldQuaternion(_worldRotation);
    _direction.set(0, 0, -1).applyQuaternion(_worldRotation).normalize();

    if (this.props.shadowFollowCamera && this.entity.engine.camera) {
      this.entity.engine.camera.getWorldPosition(_cameraWorld);
      _shadowCentre.copy(_cameraWorld);
      // Stabilize the orthographic projection: snap its lateral origin to
      // whole shadow-map texels so tiny camera movements do not make every
      // shadow edge crawl across the texture.
      _shadowRight.crossVectors(_direction, _worldUp);
      if (_shadowRight.lengthSq() < 1e-8) _shadowRight.set(1, 0, 0);
      else _shadowRight.normalize();
      _shadowUp.crossVectors(_shadowRight, _direction).normalize();
      const worldUnits = this.props.shadowCamSize * 2;
      const texelX = worldUnits / Math.max(1, this.props.shadowMapWidth);
      const texelY = worldUnits / Math.max(1, this.props.shadowMapHeight);
      const projectedX = _shadowCentre.dot(_shadowRight);
      const projectedY = _shadowCentre.dot(_shadowUp);
      _shadowCentre.addScaledVector(_shadowRight, Math.round(projectedX / texelX) * texelX - projectedX);
      _shadowCentre.addScaledVector(_shadowUp, Math.round(projectedY / texelY) * texelY - projectedY);
      // The orthographic shadow camera sees only forward along the light
      // direction. Put the view camera midway through its depth interval so
      // nearby casters are retained on both sides of the viewer.
      const depthCentre = (this.props.shadowCamNear + this.props.shadowCamFar) * 0.5;
      _lightWorld.copy(_shadowCentre).addScaledVector(_direction, -depthCentre);
    } else {
      _lightWorld.setFromMatrixPosition(_ownerWorld);
    }

    _targetWorld.copy(_lightWorld).add(_direction);
    this.light.position.copy(_lightWorld).applyMatrix4(_inverseOwnerWorld);
    this.light.target.position.copy(_targetWorld).applyMatrix4(_inverseOwnerWorld);
    this.light.updateMatrix();
    this.light.target.updateMatrix();
  }

  // Map shadow-type name → three.js constant. Built lazily and reused.
  static #shadowTypeMap = null;
  static #getShadowTypeMap() {
    if (!this.#shadowTypeMap) {
      this.#shadowTypeMap = {
        BasicShadowMap: THREE.BasicShadowMap,
        PCFShadowMap: THREE.PCFShadowMap,
        PCFSoftShadowMap: THREE.PCFSoftShadowMap,
        VSMShadowMap: THREE.VSMShadowMap,
      };
    }
    return this.#shadowTypeMap;
  }

  #configureShadow({ shadowMapWidth, shadowMapHeight, shadowCamNear, shadowCamFar, shadowCamSize, shadowCamFov }) {
    const s = this.light.shadow;
    // mapSize is a Vector2 — set both axes separately; for point lights both
    // must match (cube faces are square).
    s.mapSize.set(shadowMapWidth, shadowMapHeight);
    s.bias = this.props.shadowBias;
    s.normalBias = this.props.shadowNormalBias;
    s.radius = this.props.shadowRadius;
    const typeMap = LightComponent.#getShadowTypeMap();
    if (this.props.shadowMapType in typeMap) {
      s.type = typeMap[this.props.shadowMapType];
    }
    const cam = s.camera;
    if (this.light.isDirectionalLight || this.light.isSpotLight) {
      // Orthographic frustum: ±shadowCamSize on each side.
      cam.left = -shadowCamSize;
      cam.right = shadowCamSize;
      cam.top = shadowCamSize;
      cam.bottom = -shadowCamSize;
      cam.near = shadowCamNear;
      cam.far = shadowCamFar;
      cam.updateProjectionMatrix();
    } else if (this.light.isPointLight) {
      // Point lights render to a cube map with a perspective camera.
      cam.near = shadowCamNear;
      cam.far = shadowCamFar;
      cam.fov = Math.min(179, Math.max(1, shadowCamFov));
      cam.updateProjectionMatrix();
    }
  }

  #applyShadowProp(key) {
    const s = this.light?.shadow;
    if (!s) return;
    switch (key) {
      case "shadowMapWidth":
      case "shadowMapHeight":
        s.mapSize.set(this.props.shadowMapWidth, this.props.shadowMapHeight);
        s.map?.dispose?.();
        break;
      case "shadowBias":
        s.bias = this.props.shadowBias;
        break;
      case "shadowNormalBias":
        s.normalBias = this.props.shadowNormalBias;
        break;
      case "shadowRadius":
        s.radius = this.props.shadowRadius;
        break;
      case "shadowMapType": {
        const map = LightComponent.#getShadowTypeMap();
        s.type = map[this.props.shadowMapType] ?? THREE.PCFSoftShadowMap;
        // PCFSoft / VSM cache depth/blur textures; dispose to force reallocate
        // on the new type so the next frame doesn't render with stale data.
        s.dispose?.();
        break;
      }
      case "shadowCamNear":
      case "shadowCamFar":
      case "shadowCamSize":
      case "shadowCamFov": {
        const cam = s.camera;
        if (this.light.isDirectionalLight || this.light.isSpotLight) {
          const size = this.props.shadowCamSize;
          cam.left = -size;
          cam.right = size;
          cam.top = size;
          cam.bottom = -size;
          cam.near = this.props.shadowCamNear;
          cam.far = this.props.shadowCamFar;
          cam.updateProjectionMatrix();
        } else if (this.light.isPointLight) {
          cam.near = this.props.shadowCamNear;
          cam.far = this.props.shadowCamFar;
          cam.fov = this.props.shadowCamFov;
          cam.updateProjectionMatrix();
        }
        break;
      }
    }
  }
}
