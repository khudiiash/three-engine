import { Component } from "../../engine/components/Component.js";

// Props that change the grid/probe/atlas shape — the system reallocates
// buffers and recompiles shaders for these. Everything else applies live
// (read into uniforms every frame).
// Graphics tiers. Selecting one auto-fills the detailed params below (so
// switching to "custom" starts from the preset's real values). `realtimeInject`
// maps to the `realtimeLighting` prop. Shared with GISystem, which reads the
// effective values through these directly.
export const QUALITY_PRESETS = {
  performance: { voxelRes: 48, giResScale: 0.5, probesPerFrame: 128, coneSteps: 6, probeMotionSweeps: 1, realtimeInject: false, reflections: false },
  balanced: { voxelRes: 64, giResScale: 0.5, probesPerFrame: 256, coneSteps: 8, probeMotionSweeps: 1, realtimeInject: false, reflections: true },
  quality: { voxelRes: 96, giResScale: 1.0, probesPerFrame: 384, coneSteps: 12, probeMotionSweeps: 2, realtimeInject: true, reflections: true },
};

const isCustom = (p) => p.quality === "custom";

const STRUCTURAL_KEYS = new Set([
  "quality",
  "giResScale",
  "voxelRes",
  "probeSpacing",
  "probesPerFrame",
  "coneSteps",
  "reflections",
  "rayProxies",
  "emissiveRayVisibility",
  "softShadows",
]);

/**
 * Camera-driven global illumination (Lumen-lite). Nested clipmaps derive
 * coverage from the active camera's projection and useful visible range,
 * then scroll in probe-sized increments as the camera moves.
 *
 * The component entity is now only an owner/serialization anchor. Legacy
 * follow/size/cascade props are ignored so existing scenes load without a
 * migration while coverage becomes fully automatic.
 */
export class GlobalIlluminationComponent extends Component {
  static type = "global-illumination";
  static label = "Global Illumination";
  static tags = ["rendering", "lighting", "gi", "probes"];
  static defaults = {
    // Graphics tier. "performance"/"balanced"/"quality" drive voxelRes, GI
    // resolution, probes, cone steps, motion-time probe sweeps, and real-time
    // light injection as a bundle; "custom" uses the individual props below.
    quality: "balanced",
    // GI compute resolution vs. screen (custom mode only): 0.5 half-res (fast,
    // blockier), 1.0 full-res (smooth). This is the main "blocky lighting" fix.
    giResScale: 0.5,
    // Custom mode: process the whole direct+emissive light cache in one frame
    // while a mover is present (real-time shadow/first-bounce, costs GPU while
    // moving). The presets set this for you.
    realtimeLighting: false,
    voxelRes: 64,
    probeSpacing: 1.5,
    probesPerFrame: 256,
    intensity: 1,
    aoStrength: 0.4,
    aoRadius: 2.5,
    skyColor: "#87b7dc",
    skyIntensity: 1,
    bounce: 1,
    coneSteps: 8,
    // Default tier is "balanced", which enables reflections — keep the raw prop
    // in sync so the first build (before any preset change fires) matches.
    reflections: true,
    reflectionIntensity: 1,
    hysteresis: 0.8,
    lightingResponse: 0.5,
    normalBias: 0.3,
    dynamicObjects: true,
    // GI transport can shadow its cached bounce, but Three still evaluates
    // analytic lights directly on visible materials. Keep those direct terms
    // physically occluded even when a LightComponent left castShadow at its
    // performance-oriented default false.
    directShadows: true,
    // Experimental exact source-side gate for emissive panels. Keep it off by
    // default: the proxy scene becomes ready asynchronously, and without an
    // instance-id return the endpoint ray cannot reliably distinguish a real
    // blocker from the emitter's own proxy triangle. That ambiguity made
    // correct emissive bounce fade out several seconds later.
    emissiveRayVisibility: false,
    // Stage 1 only: builds/refits the proxy BLAS/TLAS but does not switch the
    // probe tracer until Stage 2 is enabled.
    rayProxies: false,
    // Stage 2 A/B switch. Requires rayProxies; false keeps the proven voxel
    // probe marcher without changing direct shadows or the visible gather.
    triangleProbeRays: false,
    // Experimental distance-field/capsule sun shadows. OFF = the sun keeps
    // three's normal shadow maps.
    softShadows: false,
    replaceAmbient: true,
    debugView: "off", // "off" | "gi-only" | "probes" | "gi" | "voxels" | "enclosure" | "shadow" | "ray-proxies"
  };
  static schema = [
    // Only the tier + Intensity show by default; every other knob appears under
    // "custom" (game-style: pick a tier, or go custom to tune everything).
    { key: "quality", label: "Quality", type: "select", options: ["performance", "balanced", "quality", "custom"], section: "Volume" },
    { key: "intensity", label: "Intensity", type: "number", min: 0, step: 0.05 },
    { key: "giResScale", label: "GI Resolution", type: "number", min: 0.25, max: 1, step: 0.25, section: "Volume", showIf: isCustom },
    { key: "realtimeLighting", label: "Real-time Lighting (heavier)", type: "boolean", section: "Volume", showIf: isCustom },
    { key: "voxelRes", label: "Voxel Resolution", type: "number", min: 16, max: 160, step: 16, section: "Volume", showIf: isCustom },
    { key: "probeSpacing", label: "Probe Spacing", type: "number", min: 0.25, step: 0.25, section: "Probes", showIf: isCustom },
    { key: "probesPerFrame", label: "Probes / Frame", type: "number", min: 16, max: 1024, step: 16, section: "Probes", showIf: isCustom },
    { key: "bounce", label: "Bounce", type: "number", min: 0, max: 4, step: 0.1, showIf: isCustom },
    { key: "aoStrength", label: "AO Strength", type: "number", min: 0, max: 1, step: 0.05, showIf: isCustom },
    { key: "aoRadius", label: "AO Radius (Voxels)", type: "number", min: 1, max: 12, step: 0.5, showIf: isCustom },
    { key: "coneSteps", label: "Cone Steps", type: "number", min: 4, max: 32, step: 1, showIf: isCustom },
    { key: "reflections", label: "Reflections", type: "boolean", section: "Reflections", showIf: isCustom },
    { key: "reflectionIntensity", label: "Reflection Intensity", type: "number", min: 0, step: 0.05, section: "Reflections", showIf: (p) => isCustom(p) && p.reflections !== false },
    { key: "skyColor", label: "Sky Color", type: "color", section: "Sky", showIf: isCustom },
    { key: "skyIntensity", label: "Sky Intensity", type: "number", min: 0, step: 0.05, section: "Sky", showIf: isCustom },
    { key: "hysteresis", label: "Temporal Blend", type: "number", min: 0, max: 0.99, step: 0.01, section: "Advanced", showIf: isCustom },
    { key: "lightingResponse", label: "Lighting Response (s)", type: "number", min: 0.05, max: 2, step: 0.05, section: "Advanced", showIf: isCustom },
    { key: "normalBias", label: "Normal Bias", type: "number", min: 0, max: 2, step: 0.05, section: "Advanced", showIf: isCustom },
    { key: "dynamicObjects", label: "Dynamic Objects", type: "boolean", section: "Advanced", showIf: isCustom },
    { key: "directShadows", label: "Auto Direct Shadows", type: "boolean", section: "Advanced", showIf: isCustom },
    { key: "emissiveRayVisibility", label: "Exact Emissive Visibility", type: "boolean", section: "Advanced", showIf: isCustom },
    { key: "rayProxies", label: "Triangle Ray Proxies (experimental)", type: "boolean", section: "Advanced", showIf: isCustom },
    { key: "triangleProbeRays", label: "Use Triangle Probe Rays", type: "boolean", section: "Advanced", showIf: (p) => isCustom(p) && p.rayProxies === true },
    { key: "softShadows", label: "DF Sun Shadows (experimental)", type: "boolean", section: "Advanced", showIf: isCustom },
    { key: "replaceAmbient", label: "Replace Flat Ambient", type: "boolean", section: "Advanced", showIf: isCustom },
    { key: "debugView", label: "Debug View", type: "select", options: ["off", "gi-only", "probes", "gi", "voxels", "enclosure", "shadow", "ray-proxies"], section: "Advanced", showIf: isCustom },
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
    if (key === "quality") {
      // Selecting a preset auto-fills the detailed params so the inspector's
      // "custom" view shows the preset's real values (and the user can tweak
      // from there). "custom" leaves the current values untouched.
      const preset = QUALITY_PRESETS[this.props.quality];
      if (preset) {
        this.setProp("voxelRes", preset.voxelRes);
        this.setProp("giResScale", preset.giResScale);
        this.setProp("probesPerFrame", preset.probesPerFrame);
        this.setProp("coneSteps", preset.coneSteps);
        this.setProp("realtimeLighting", preset.realtimeInject);
        this.setProp("reflections", preset.reflections);
      }
      system.queueRebuild();
      return;
    }
    if (STRUCTURAL_KEYS.has(key)) {
      if (key === "rayProxies") system.markRayProxiesDirty();
      system.queueRebuild();
    }
    else if (key === "debugView") system.setDebugView(this.props.debugView);
    else if (key === "skyColor" || key === "skyIntensity") {
      system.markLightingDirty();
    }
    // Live keys (intensity, sky, bounce, …) are read into uniforms each frame.
  }
}
