import { PostprocessComponent } from "./PostprocessComponent.js";

/**
 * Postprocessing module — node-graph screen-space effects for cameras.
 *
 * Adds the Postprocess component (attach it to any camera entity). When the
 * camera is active, the engine defers its main render to the component,
 * which renders the scene to an offscreen beauty target and runs a
 * WebGPU-native TSL graph (built via React Flow in Window → Post Process)
 * to the canvas. The graph is anchored by three auto-fed inputs (Color,
 * Depth, Normal) and ends at a single Output node — every effect node in
 * between (SSGI, SSR, color grading, vignette, grain, …) plugs into that
 * pipeline.
 *
 * The compile is graph-driven and TSL-only; it works on the WebGPU
 * backend AND on the WebGL2 fallback because three.js's `RenderPipeline`
 * is backend-agnostic. No WASM, no heavy CPU work per frame.
 */
export const postprocessingModule = {
  id: "postprocessing",
  name: "Post Processing",
  version: "1.0.0",
  category: "Rendering",
  tags: ["rendering", "camera", "screen-space", "graph", "ssgi", "ssr"],
  description:
    "Node-graph screen-space effects for cameras. Add a Postprocess component to any camera, " +
    "then open Window → Post Process to wire SSGI, SSR, color grading, and effects.",
  components: [PostprocessComponent],
};