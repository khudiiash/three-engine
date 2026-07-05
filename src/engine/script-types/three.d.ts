/**
 * Minimal ambient declarations for the `three` module. Scripts can `import
 * * as THREE from "three/webgpu"` to get type-safe access to the same
 * three classes the engine uses. The shape is intentionally a subset of
 * the full three API — covering what user scripts typically touch.
 *
 * In practice scripts reach into three via `this.THREE` (injected by
 * `ScriptComponent.#bind()`), but this ambient declaration supports
 * scripts that prefer a top-level import.
 */
declare module "three" {
  // Forward to the engine-typed classes so user scripts get the exact same
  // shapes via `import * as THREE from "three"` as they do via
  // `this.THREE.Vector3` from a `Script` subclass.
  export {
    ScriptVector2 as Vector2,
    ScriptVector3 as Vector3,
    ScriptEuler as Euler,
    ScriptQuaternion as Quaternion,
    ScriptMatrix4 as Matrix4,
    ScriptColor as Color,
    ScriptObject3D as Object3D,
    ScriptCamera as Camera,
    ScriptMathUtils as MathUtils,
    ScriptTHREE as THREE,
  } from "engine";
}

// The `three/webgpu` build the engine actually uses extends the same shape.
declare module "three/webgpu" {
  export * from "three";
}