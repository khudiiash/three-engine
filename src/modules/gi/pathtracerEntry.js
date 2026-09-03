// Local hop so the path tracer is a src/ import, not a package specifier.
// Vite's dep optimizer rewrites `three-gpu-pathtracer/...` to
// `.vite/deps/*.js?v=HASH`, which 504s (Outdated Optimize Dep) the moment
// the optimizer re-runs. A relative file is transformed as linked ESM and
// shares the app's `three/webgpu` instance.
export { WebGPUPathTracer } from "../../../node_modules/three-gpu-pathtracer/src/webgpu/index.js";
