import { Component } from "../../engine/components/Component.js";

/**
 * Global Illumination via 3D Radiance Cascades.
 *
 * The entity's world position is the volume center; size props define the
 * world-space AABB the GI covers. One component is active at a time (last
 * attached wins — same convention as Environment).
 *
 * Structural props (size, voxel size, probe spacing, cascade shape) rebuild
 * the GPU pipeline; `intensity` and `debugProbes` apply live. Scene changes
 * (moved meshes, edited materials, moved lights) re-bake the voxel grid
 * automatically (debounced) when `autoRebake` is on — lighting itself
 * re-traces every frame regardless, so it reacts within a frame of the
 * voxels updating.
 */
export class GlobalIlluminationComponent extends Component {
  static type = "global-illumination";
  static label = "Global Illumination (RC)";
  static tags = ["rendering", "lighting", "gi", "radiance-cascades"];
  static defaults = {
    sizeX: 40,
    sizeY: 12,
    sizeZ: 40,
    voxelSize: 0.35,
    probeSpacing: 1.25,
    cascadeCount: 5,
    c0DirRes: 4,
    intensity: 1,
    bounce: 1,
    reflections: true,
    emissiveShadows: true,
    autoRebake: true,
    debugProbes: "off",
  };
  static schema = [
    { key: "sizeX", label: "Size X", type: "number", min: 4, max: 200, step: 1 },
    { key: "sizeY", label: "Size Y", type: "number", min: 2, max: 100, step: 1 },
    { key: "sizeZ", label: "Size Z", type: "number", min: 4, max: 200, step: 1 },
    { key: "voxelSize", label: "Voxel Size", type: "number", min: 0.1, max: 2, step: 0.05 },
    { key: "probeSpacing", label: "Probe Spacing", type: "number", min: 0.25, max: 8, step: 0.25 },
    { key: "cascadeCount", label: "Cascades", type: "number", min: 2, max: 6, step: 1 },
    { key: "c0DirRes", label: "C0 Dir Res", type: "select", options: [2, 4] },
    { key: "intensity", label: "Intensity", type: "number", min: 0, max: 10, step: 0.1 },
    // Fraction of secondary energy retained per pass — the pass itself is
    // an infinite-bounce feedback loop; values > 1 would diverge.
    { key: "bounce", label: "Bounce Energy", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "reflections", label: "GI Reflections", type: "boolean" },
    { key: "emissiveShadows", label: "Emissive Shadows", type: "boolean" },
    { key: "autoRebake", label: "Auto Re-bake", type: "boolean" },
    { key: "debugProbes", label: "Debug Probes", type: "select", options: ["off", "raw", "merged"] },
  ];

  get #system() {
    return this.entity?.engine?.modules?.get("gi")?.system ?? null;
  }

  onAttach() {
    this.#system?.attach(this);
  }

  onDetach() {
    this.#system?.detach(this);
  }

  onEnable() {
    this.#system?.attach(this);
  }

  onDisable() {
    // Keep attachment but drop runtime output; system checks `enabled` per
    // tick, and a disabled component's light should not linger.
    this.#system?.detach(this);
  }

  onPropChanged(key) {
    this.#system?.onComponentProp(this, key);
  }
}
