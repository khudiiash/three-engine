import { Component } from "../../engine/components/Component.js";

// Props that change the grid/probe/atlas shape — the system reallocates
// buffers and recompiles shaders for these. Everything else applies live
// (read into uniforms every frame).
const STRUCTURAL_KEYS = new Set([
  "sizeX",
  "sizeY",
  "sizeZ",
  "voxelRes",
  "probeSpacing",
  "probesPerFrame",
  "coneSteps",
  "reflections",
  "cascades",
]);

/**
 * Global Illumination volume (Lumen-lite): a box centered on this entity in
 * which dynamic diffuse GI is computed — the scene is voxelized on the CPU,
 * sunlight is injected on the GPU every frame (so a moving sun re-lights
 * instantly), and a grid of irradiance probes ray-traces the voxels in
 * compute, feeding indirect light + sky ambient into every lit material.
 * Multi-bounce comes from probe→voxel feedback across frames.
 *
 * Move the entity to move the volume. One volume is active at a time.
 * Works alongside SSGI: probes carry the low-frequency world-space light,
 * SSGI adds near-field contact detail on top.
 */
export class GlobalIlluminationComponent extends Component {
  static type = "global-illumination";
  static label = "Global Illumination";
  static tags = ["rendering", "lighting", "gi", "probes"];
  static defaults = {
    followCamera: false,
    forwardBias: 8,
    cascades: 2,
    sizeX: 40,
    sizeY: 20,
    sizeZ: 40,
    voxelRes: 64,
    probeSpacing: 2.5,
    probesPerFrame: 256,
    intensity: 1,
    aoStrength: 1,
    skyColor: "#87b7dc",
    skyIntensity: 1,
    bounce: 1,
    coneSteps: 10,
    reflections: true,
    reflectionIntensity: 1,
    hysteresis: 0.75,
    normalBias: 0.4,
    debugView: "off", // "off" | "probes" | "gi" | "voxels"
  };
  static schema = [
    { key: "followCamera", label: "Follow Camera", type: "boolean", section: "Volume" },
    { key: "forwardBias", label: "Forward Bias", type: "number", min: 0, step: 1, section: "Volume", showIf: (p) => p.followCamera === true },
    { key: "cascades", label: "Cascades", type: "number", min: 1, max: 3, step: 1, section: "Volume" },
    { key: "sizeX", label: "Size X", type: "number", min: 1, step: 1, section: "Volume" },
    { key: "sizeY", label: "Size Y", type: "number", min: 1, step: 1, section: "Volume" },
    { key: "sizeZ", label: "Size Z", type: "number", min: 1, step: 1, section: "Volume" },
    { key: "voxelRes", label: "Voxel Resolution", type: "number", min: 16, max: 160, step: 16, section: "Volume" },
    { key: "probeSpacing", label: "Probe Spacing", type: "number", min: 0.25, step: 0.25, section: "Probes" },
    { key: "probesPerFrame", label: "Probes / Frame", type: "number", min: 16, max: 1024, step: 16, section: "Probes" },
    { key: "intensity", label: "Intensity", type: "number", min: 0, step: 0.05 },
    { key: "bounce", label: "Bounce", type: "number", min: 0, max: 4, step: 0.1 },
    { key: "aoStrength", label: "AO Strength", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "coneSteps", label: "Cone Steps", type: "number", min: 4, max: 32, step: 1 },
    { key: "reflections", label: "Reflections", type: "boolean", section: "Reflections" },
    { key: "reflectionIntensity", label: "Reflection Intensity", type: "number", min: 0, step: 0.05, section: "Reflections", showIf: (p) => p.reflections !== false },
    { key: "skyColor", label: "Sky Color", type: "color", section: "Sky" },
    { key: "skyIntensity", label: "Sky Intensity", type: "number", min: 0, step: 0.05, section: "Sky" },
    { key: "hysteresis", label: "Temporal Blend", type: "number", min: 0, max: 0.99, step: 0.01, section: "Advanced" },
    { key: "normalBias", label: "Normal Bias", type: "number", min: 0, max: 2, step: 0.05, section: "Advanced" },
    { key: "debugView", label: "Debug View", type: "select", options: ["off", "probes", "gi", "voxels"], section: "Advanced" },
  ];

  get #system() {
    return this.entity?.engine?.modules?.get("gi")?.system ?? null;
  }

  onAttach() {
    this.#system?.activate(this);
  }

  onDetach() {
    this.#system?.deactivate(this);
  }

  onDisable() {
    this.#system?.deactivate(this);
  }

  onEnable() {
    this.#system?.activate(this);
  }

  onPropChanged(key) {
    const system = this.#system;
    if (!system || system.component !== this) return;
    if (STRUCTURAL_KEYS.has(key)) system.queueRebuild();
    else if (key === "debugView") system.setDebugView(this.props.debugView);
    // Live keys (intensity, sky, bounce, …) are read into uniforms each frame.
  }
}
