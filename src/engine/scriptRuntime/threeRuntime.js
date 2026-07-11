/**
 * Pass-through proxy for `three/webgpu` reachable from user scripts loaded
 * via blob URL.
 *
 * The runtime is shipped as a `data:` URL (Vite inlines `new URL(...)`
 * references at build time). A `data:` URL has no module-resolution base,
 * so this file CANNOT use `import ... from "three/webgpu"` itself — the
 * inner imports would fail when the blob is loaded. Instead we read the
 * three.js surface from `globalThis.__ENGINE_THREE__`, which the engine
 * populates once at startup. The result is identical to the real
 * `three/webgpu` (same constructors, same singletons).
 *
 * User scripts that want the namespace idiom can keep writing
 * `import * as THREE from "three/webgpu"` — `linkEngineImports` rewrites
 * that to `from "<this-file-data-url>"`. Both `import { Vector3 }` and
 * `import * as THREE` resolve to the same three instance the engine uses.
 */
const T = globalThis.__ENGINE_THREE__;
if (!T) {
  throw new Error(
    "threeRuntime: globalThis.__ENGINE_THREE__ is not set. " +
      "The engine must finish booting before user scripts run.",
  );
}

export const Vector2 = T.Vector2;
export const Vector3 = T.Vector3;
export const Euler = T.Euler;
export const Quaternion = T.Quaternion;
export const Matrix4 = T.Matrix4;
export const Color = T.Color;
export const Object3D = T.Object3D;
export const Camera = T.Camera;
export const MathUtils = T.MathUtils;
export const Mesh = T.Mesh;
export const Group = T.Group;
export const Scene = T.Scene;
export const PerspectiveCamera = T.PerspectiveCamera;
export const OrthographicCamera = T.OrthographicCamera;
export const DirectionalLight = T.DirectionalLight;
export const AmbientLight = T.AmbientLight;
export const PointLight = T.PointLight;
export const SpotLight = T.SpotLight;
export const HemisphereLight = T.HemisphereLight;
export const Box3 = T.Box3;
export const Sphere = T.Sphere;
export const Raycaster = T.Raycaster;
export const Ray = T.Ray;
export const Plane = T.Plane;
export const Frustum = T.Frustum;
export const Clock = T.Clock;
export const WebGLRenderer = T.WebGLRenderer;
export const WebGPURenderer = T.WebGPURenderer;

export default T;