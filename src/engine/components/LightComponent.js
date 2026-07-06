import * as THREE from "three/webgpu";
import { Component } from "./Component.js";

export class LightComponent extends Component {
  static type = "light";
  static label = "Light";
  static defaults = {
    kind: "directional",
    color: "#ffffff",
    intensity: 1,
    distance: 0, // point/spot: 0 = infinite
    angle: 45, // spot cone angle, degrees
    castShadow: false,
  };
  static schema = [
    { key: "kind", label: "Type", type: "select", options: ["directional", "point", "spot", "ambient"] },
    { key: "color", label: "Color", type: "color" },
    { key: "intensity", label: "Intensity", type: "number", min: 0, step: 0.1 },
    { key: "distance", label: "Distance", type: "number", min: 0, step: 0.5, showIf: (p) => p.kind === "point" || p.kind === "spot" },
    { key: "angle", label: "Angle", type: "number", min: 1, max: 90, step: 1, showIf: (p) => p.kind === "spot" },
    { key: "castShadow", label: "Cast Shadow", type: "boolean", showIf: (p) => p.kind !== "ambient" },
  ];

  onAttach() {
    const { kind, color, intensity, distance, angle } = this.props;
    switch (kind) {
      case "point":
        this.light = new THREE.PointLight(color, intensity, distance);
        break;
      case "spot":
        this.light = new THREE.SpotLight(color, intensity, distance, THREE.MathUtils.degToRad(angle));
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
      this.light.castShadow = !!this.props.castShadow;
      this.light.shadow.mapSize.set(2048, 2048);
      this.light.shadow.bias = -0.0005;
      if (this.light.isDirectionalLight) {
        // Wide enough for a typical scene; tightening it is a future setting.
        const cam = this.light.shadow.camera;
        cam.left = cam.bottom = -20;
        cam.right = cam.top = 20;
        cam.far = 100;
      }
    }
    this.entity.object3D.add(this.light);
    // Directional/spot lights aim at their target; keep the target with the entity
    // so rotating the entity re-aims the light.
    if (this.light.target) {
      this.light.target.position.set(0, 0, -1);
      this.entity.object3D.add(this.light.target);
    }
    // Honour the enabled flag at attach time.
    this.light.visible = this._enabled;
  }

  onDetach() {
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
    if (key === "kind" || !this.light) {
      super.onPropChanged();
      return;
    }
    if (key === "color") this.light.color.set(this.props.color);
    else if (key === "angle") {
      if (this.light.isSpotLight) this.light.angle = THREE.MathUtils.degToRad(this.props.angle);
    } else if (key === "castShadow") {
      if (this.light.shadow) this.light.castShadow = !!this.props.castShadow;
    } else if (key in this.light) this.light[key] = this.props[key];
  }
}
