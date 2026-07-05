/**
 * Runtime module exposed to user scripts as `import ... from "engine"`.
 *
 * Lives as a real ES module (not a generated blob) so it can `import`
 * three.js classes and re-export them. The runtime blob path in
 * `scriptRuntime.js` is replaced with this file's URL via Vite's `?url`
 * import.
 *
 * Two kinds of exports live here:
 *
 *   1. Engine-specific surface — `Script` (empty base class) and the
 *      `attribute` decorator. The runtime doesn't require users to extend
 *      `Script`; `ScriptComponent` injects `entity` / `engine` / `THREE`
 *      / `input` on every script instance regardless of base class. The
 *      base class exists purely so `extends Script` is a typed no-op and
 *      so `this.entity` etc. autocomplete.
 *
 *   2. three.js classes — `Vector2` / `Vector3` / `Quaternion` /
 *      `Euler` / `Matrix4` / `Color` / `Object3D` / `Camera` /
 *      `MathUtils`. Re-exported so user scripts can do
 *      `import { Vector3 } from "engine"` and get the same constructor
 *      the engine itself uses (real `THREE.Vector3` instances with full
 *      methods, not just a type alias).
 *
 * Scripts that prefer the three.js idiom can still do
 * `import * as THREE from "three/webgpu"` — both paths return identical
 * runtime values.
 */
import {
  Vector2,
  Vector3,
  Euler,
  Quaternion,
  Matrix4,
  Color,
  Object3D,
  Camera,
  MathUtils,
} from "three/webgpu";

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

// Re-export three.js classes. Same instances the engine uses internally,
// so `new Vector3()` here gives you a Vector3 the engine can hand back to
// you (entity.position, etc.) without type-mismatch surprises.
export { Vector2, Vector3, Euler, Quaternion, Matrix4, Color, Object3D, Camera, MathUtils };