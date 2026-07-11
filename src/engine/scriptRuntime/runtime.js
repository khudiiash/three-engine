/**
 * Runtime module exposed to user scripts as `import ... from "engine"`.
 *
 * Lives as a real ES module that Vite bundles into a `data:` URL referenced
 * from `scriptRuntime.js`. Because the data URL has no module-resolution
 * base, we can't `import from "three/webgpu"` here — we instead pull three
 * classes from `globalThis.__ENGINE_THREE__`, which the engine populates at
 * startup. Same constructors, same singletons as the engine itself.
 *
 * Two kinds of exports live here:
 *   1. Engine-specific surface — `Script` (empty base class) and the
 *      `attribute` decorator. `ScriptComponent` injects `entity` /
 *      `engine` / `THREE` / `input` on every script instance regardless
 *      of base class, so `extends Script` is a typed no-op.
 *   2. three.js classes — `Vector2` / `Vector3` / `Quaternion` /
 *      `Euler` / `Matrix4` / `Color` / `Object3D` / `Camera` /
 *      `MathUtils`. Re-exported so user scripts can do
 *      `import { Vector3 } from "engine"` and get the same constructor
 *      the engine uses.
 *
 * Scripts that prefer the three.js idiom can still do
 * `import * as THREE from "three/webgpu"` — `linkEngineImports` rewrites
 * that to a separate `threeRuntime` data URL that exposes the same
 * surface as a namespace.
 */
const T = globalThis.__ENGINE_THREE__;
if (!T) {
  throw new Error(
    "runtime: globalThis.__ENGINE_THREE__ is not set. " +
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

/**
 * Base class scripts extend for full IntelliSense on `this.entity`,
 * `this.engine`, `this.THREE`, `this.input`, plus the lifecycle methods.
 *
 * The runtime DOES NOT require extending this class — `ScriptComponent`
 * injects the four context properties on every script instance regardless
 * of its base class. This class exists purely as a type-system helper.
 */
export class Script {}

/**
 * Class-field decorator that registers the field in the class's static
 * `attributes` map. The editor reads that map to render Inspector fields
 * and `ScriptComponent` applies saved values on start.
 */
export function attribute(options = {}) {
  return function (target, key) {
    const ctor = target.constructor ?? target;
    if (!Object.prototype.hasOwnProperty.call(ctor, "attributes")) {
      ctor.attributes = { ...ctor.attributes };
    }
    ctor.attributes[key] = options;
  };
}