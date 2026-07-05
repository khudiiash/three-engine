/**
 * Type declarations for the `engine` bare specifier. Scripts import from this
 * specifier (e.g. `import { attribute } from "engine"`); at runtime the editor
 * rewrites it to a blob URL exporting the actual implementation (see
 * `scriptRuntime.js`). This file makes the same surface visible to the TS
 * language service so editor autocomplete / type-checking works.
 */
declare module "engine" {
  /**
   * Subset of `three`'s Object3D that scripts typically use.
   */
  export interface ScriptObject3D {
    name: string;
    position: ScriptVector3;
    rotation: ScriptEuler;
    quaternion: ScriptQuaternion;
    scale: ScriptVector3;
    visible: boolean;
    userData: Record<string, unknown>;
    parent: ScriptObject3D | null;
    children: ScriptObject3D[];
    layers: { mask: number; enable(index: number): void };
    lookAt(target: ScriptVector3 | ScriptObject3D): void;
    getWorldPosition(target: ScriptVector3): ScriptVector3;
    getWorldQuaternion(target: ScriptQuaternion): ScriptQuaternion;
    getWorldScale(target: ScriptVector3): ScriptVector3;
    traverse(fn: (obj: ScriptObject3D) => void): void;
  }

  /**
   * Subset of the runtime `Entity` class. Transform properties and the most
   * common Object3D methods are aliased directly on the entity so scripts
   * can write `this.entity.position.set(0, 1, 0)` instead of
   * `this.entity.object3D.position.set(0, 1, 0)`. The underlying
   * `object3D` is still typed and reachable for matrix ops and the
   * scene-graph tree.
   */
  export interface ScriptEntity {
    id: string;
    name: string;
    object3D: ScriptObject3D;
    parent: ScriptEntity | null;
    children: ScriptEntity[];

    // Transform aliases — get/set both delegate to object3D. Mutation via
    // `this.entity.position.x = 5` works because the getter returns the
    // same Vector3 instance the object3D owns. Setters also accept
    // `[x, y, z]` tuples, which is common for serialized transforms.
    position: ScriptVector3;
    rotation: ScriptEuler;
    quaternion: ScriptQuaternion;
    scale: ScriptVector3;
    visible: boolean;
    up: ScriptVector3;

    // Forwarded Object3D methods — taking the same args as Object3D.
    lookAt(target: ScriptVector3 | ScriptObject3D): void;
    getWorldPosition(target: ScriptVector3): ScriptVector3;
    getWorldQuaternion(target: ScriptQuaternion): ScriptQuaternion;
    getWorldScale(target: ScriptVector3): ScriptVector3;
    getWorldDirection(target: ScriptVector3): ScriptVector3;
    updateMatrix(): void;
    updateMatrixWorld(force?: boolean): void;

    addComponent(type: string, props?: Record<string, unknown>): unknown;
    getComponent<T = unknown>(type: string): T | undefined;
    removeComponent(type: string): void;
    setParent(parent: ScriptEntity | null): void;
    traverse(fn: (entity: ScriptEntity) => void): void;
    getTransform(): {
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
    };
    setTransform(t: {
      position?: [number, number, number];
      rotation?: [number, number, number];
      scale?: [number, number, number];
    }): void;
    /** THREE-style lookup of a child Object3D by exact name. Walks the entire
     *  three.js subtree (including meshes / helpers that are NOT entities). */
    getObjectByName(name: string): ScriptObject3D | null;
    /** Entity-aware lookup. Walks this entity's `children` (other entities
     *  only) depth-first and returns the first match, or null. Use this when
     *  you want to navigate to a child *entity* — `getObjectByName` returns a
     *  raw three.js Object3D which is missing the engine's component API,
     *  position/rotation aliases, and entity-tree navigation. */
    getEntityByName(name: string): ScriptEntity | null;

    /**
     * Recursively collect every component matching `type` from this entity
     * and all descendants (depth-first). Always returns an array — empty
     * when nothing matches, never null/undefined, so callers can use
     * `arr.length === 0` as a clean "not found" check.
     *
     * Compare against `getComponent(type)` if you only want this entity
     * itself.
     *
     * Generic over `T` so callers can ask for a more specific component
     * shape (e.g. `findComponents<CameraComponent>("camera")`); the runtime
     * returns plain `Component` instances regardless. Cast where the static
     * typing matters, since component classes aren't part of the engine
     * ambient surface.
     */
    findComponents<T = unknown>(type: string): T[];
  }

  /** Union of every value shape an action can carry, for callers that don't
   *  know the action's type at compile time. Discriminate by reading the
   *  action via `input.getAction(name)?.type` — TypeScript will narrow the
   *  `value` field for you.
   *
   *  For vec2 actions the value is a real `THREE.Vector2` instance with full
   *  methods (`.length()`, `.normalize()`, `.dot()`, …), not a plain object —
   *  the engine's input manager allocates a Vector2 per vec2 action and mutates
   *  it in place each tick. */
  export type ScriptActionValue = boolean | number | ScriptVector2;

  /** A live action. The `type` field is the discriminant — TypeScript narrows
   *  `value` automatically:
   *    type === "button" → value: boolean
   *    type === "value"  → value: number
   *    type === "vec2"   → value: ScriptVector2 (THREE.Vector2) */
  export type ScriptAction =
    | ScriptButtonAction
    | ScriptValueAction
    | ScriptVec2Action;

  /** Coordinate space the resolved value lives in. Only meaningful for vec2
   *  actions — buttons and value axes are scalar-shaped either way.
   *    "world"  (default) — input-space: x = strafe-right, y = forward. The
   *                        consumer rotates by the camera / facing if it cares.
   *    "camera" — the InputManager has already rotated by the active camera's
   *               yaw. `value.x` = world X, `value.y` = world Z (the vec2's
   *               `y` slot holds depth so the consumer can write straight into
   *               `entity.position.z`). The manager falls back to input-space
   *               when no camera provider is wired (e.g. unit tests). */
  export type ScriptActionSpace = "world" | "camera";

  export interface ScriptButtonAction {
    name: string;
    type: "button";
    /** Per-frame resolved value: `true` when held, `false` when released.
     *  The `onAction` callback also receives this. */
    value: boolean;
    /** "any" | "all" | "min" — how multiple bindings combine. See
     *  InputAction.composite in src/engine/input/Action.js. */
    composite: ScriptActionComposite;
    /** Always "world" for buttons; surfaces here so the union shape stays
     *  consistent and code can read it without a type guard. */
    space: ScriptActionSpace;
    bindings: ScriptBindingDef[];
    wasDown: boolean;
    pressedThisFrame: boolean;
    releasedThisFrame: boolean;
  }

  export interface ScriptValueAction {
    name: string;
    type: "value";
    value: number;
    composite: ScriptActionComposite;
    /** Always "world" for value axes. */
    space: ScriptActionSpace;
    bindings: ScriptBindingDef[];
    wasDown: boolean;
    pressedThisFrame: boolean;
    releasedThisFrame: boolean;
  }

  export interface ScriptVec2Action {
    name: string;
    type: "vec2";
    /** Real `THREE.Vector2` instance with `.length()`, `.normalize()`, etc.
     *  The manager mutates this in place each tick, so the same reference is
     *  returned every read — don't snapshot it for later comparison without
     *  `.clone()`-ing first.
     *
     *  When `space === "camera"`, this is already in world coordinates (XZ
     *  plane). When `space === "world"`, it stays in input space (x = strafe,
     *  y = forward) and the script rotates by the camera or facing if it
     *  cares about world. */
    value: ScriptVector2;
    composite: ScriptActionComposite;
    space: ScriptActionSpace;
    bindings: ScriptBindingDef[];
    wasDown: boolean;
    pressedThisFrame: boolean;
    releasedThisFrame: boolean;
  }

  export type ScriptActionComposite = "any" | "all" | "min";

  /** Plain-object description of one binding (the shape `addActionMap` accepts
   *  and the shape `ActionMap.toJSON()` produces). The runtime auto-detects
   *  composites from shape, but you can mark them with `kind: "composite"` or
   *  `kind: "binding"` to be explicit. */
  export type ScriptBindingDef =
    | ScriptBindingPlain
    | ScriptBindingExplicit
    | ScriptCompositeDef
    | ScriptCompositeShorthand;

  /** Shorthand composite — `{ type: "1d" | "2d", parts }` with no `kind`.
   *  The runtime detects this from the shape (a regular binding has a
   *  `path`, not a `parts` map) and upgrades it to a Composite. The
   *  serialized form (`ActionMap.toJSON()`) always uses the explicit
   *  `kind: "composite"` form so round-trips are stable. */
  export interface ScriptCompositeShorthand {
    type: "1d" | "2d";
    parts: ScriptCompositeParts;
  }

  /** Shorthand: just a `path` — the manager creates a regular binding. */
  export interface ScriptBindingPlain {
    path: string;
    negate?: boolean;
    scale?: number;
  }

  /** Explicit form of a regular binding. */
  export interface ScriptBindingExplicit {
    kind: "binding";
    id?: string;
    path: string;
    negate?: boolean;
    scale?: number;
  }

  /** Joins multiple sub-bindings into one logical value:
   *    type "2d" → { up, down, left, right } → { x, y } in [-1..1]^2
   *    type "1d" → { negative, positive }   → number in [-1..1]
   *  Each `parts.<slot>` is itself a `ScriptBindingDef`. */
  export interface ScriptCompositeDef {
    kind: "composite";
    id?: string;
    type: "1d" | "2d";
    parts: ScriptCompositeParts;
  }

  export interface ScriptCompositeParts {
    up?: ScriptBindingDef;
    down?: ScriptBindingDef;
    left?: ScriptBindingDef;
    right?: ScriptBindingDef;
    negative?: ScriptBindingDef;
    positive?: ScriptBindingDef;
  }

  /** Shape `addActionMap` accepts (and `toJSON()` produces). */
  export interface ScriptActionMapDef {
    name: string;
    /** Which device groups this map listens to. `null` = listen to all
     *  schemes the manager was constructed with (defaults to
     *  ["KeyboardMouse", "Gamepad", "Touch"]). */
    schemes?: string[] | null;
    actions: ScriptActionDef[];
  }

  export interface ScriptActionDef {
    name: string;
    type: "button" | "value" | "vec2";
    composite?: ScriptActionComposite;
    /** Coordinate space the resolved vec2 lives in. Only affects vec2
     *  actions; ignored for buttons and value axes. Default: "world". */
    space?: ScriptActionSpace;
    bindings?: ScriptBindingDef[];
  }

  /** Live action map. Read-only view exposed via `input.getMap(name)`. */
  export interface ScriptActionMap {
    name: string;
    schemes: string[] | null;
    actions: Map<string, ScriptAction>;
  }

  export type ScriptUnsub = () => void;

  export interface ScriptInputManager {
    /** Currently active device group ("KeyboardMouse" | "Gamepad" | "Touch"). */
    activeScheme: string;
    /** Device groups the manager is configured to track. */
    schemes: string[];
    /** True while the action is currently held down (latched last frame). */
    isPressed(actionName: string): boolean;
    /** True for the single tick the action transitioned to held. */
    wasPressedThisFrame(actionName: string): boolean;
    /** True for the single tick the action transitioned to released. */
    wasReleasedThisFrame(actionName: string): boolean;
    /** Current resolved value of the action. Shape depends on the action's
     *  type — narrow via `getAction(name)?.type` if you need to know.
     *  For vec2 actions this is a real `THREE.Vector2` (mutated in place
     *  each tick), so you can call `.length()`, `.normalize()`, `.dot()`,
     *  etc. directly.
     *  Returns `0` when the action isn't found. */
    readValue(actionName: string): ScriptActionValue;
    /** Subscribe to press events for one action. Callback receives the
     *  action's current `value` — boolean for buttons, number for value
     *  actions, `{ x, y }` for vec2 actions. */
    onAction(
      name: string,
      cb: (value: ScriptActionValue) => void,
    ): ScriptUnsub;
    /** Subscribe to release events for one action. Callback receives no
     *  arguments (the action name is already known from the `name` param). */
    onRelease(name: string, cb: () => void): ScriptUnsub;
    /** Looks up a live action by name. Returns `null` if no active map
     *  defines it. The returned action is the same instance the manager
     *  updates each tick, so reading `.value` after `getAction` gives you
     *  the current frame's value with a properly-typed shape. */
    getAction(name: string): ScriptAction | null;
    /** Looks up a live action map by name. */
    getMap(name: string): ScriptActionMap | null;
    /** Adds (or replaces) an action map. Accepts the runtime `ActionMap`
     *  instance directly, or the plain-object shape used by `toJSON()`. */
    addActionMap(def: ScriptActionMapDef): ScriptActionMap;
    /** Removes an action map. Idempotent. */
    removeActionMap(name: string): void;
    /** Pushes the map onto the top of the active stack. */
    enableMap(name: string): void;
    /** Pops the map from the stack and resets its actions. */
    disableMap(name: string): void;
    /** Replaces the entire active stack with a single map. */
    setActiveMap(name: string): void;
    /** True if the map is currently on the stack. */
    isMapActive(name: string): boolean;
    /** Replaces the camera provider used for vec2 actions whose `space` is
     *  `"camera"`. The callback is invoked each tick and should return a
     *  `THREE.Camera` (anything with `getWorldDirection(target)` works) or
     *  `null`. The Engine wires `() => engine.camera` automatically; calling
     *  this from a script lets you pin a different camera for a sub-scene. */
    setCameraProvider(fn: (() => unknown) | null): void;
    /** Re-runs scheme auto-detection based on the most recent device input. */
    detectScheme(): string;
    /** Force-pin the active scheme. */
    setScheme(scheme: string): void;
    /** Round-trip the entire manager to a plain object (for save/load). */
    toJSON(): unknown;
    /** Clears all transient state (values, edge latches, devices). */
    reset(): void;
  }

  export interface ScriptEngineConfig {
    scriptHotReload: boolean;
    scriptReloadIntervalMs: number;
  }

  export interface ScriptSceneSettings {
    toneMapping: string;
    exposure: number;
    ambientColor: string;
    ambientIntensity: number;
    backgroundColor: string;
    shadowsEnabled: boolean;
    shadowType: "basic" | "pcf" | "pcfSoft" | "vsm";
  }

  export interface ScriptPhysicsHandle {
    raycast(
      origin: ScriptVector3,
      direction: ScriptVector3,
      maxDist: number,
    ): {
      entity: ScriptEntity | null;
      point: ScriptVector3;
      normal: ScriptVector3;
      distance: number;
    } | null;
    setGravity(v: [number, number, number]): void;
  }

  export interface ScriptEngine {
    scene: { children: unknown[]; background: unknown; environment: unknown; fog: unknown };
    camera: ScriptCamera | null;
    renderer: unknown;
    entities: Map<string, ScriptEntity>;
    rootEntities: ScriptEntity[];
    playing: boolean;
    config: ScriptEngineConfig;
    settings: ScriptSceneSettings;
    input: ScriptInputManager;
    physics?: ScriptPhysicsHandle;
    onUpdate(fn: (dt: number) => void): ScriptUnsub;
    onPostRender(fn: () => void): ScriptUnsub;
    on(event: string, fn: (...args: any[]) => void): ScriptUnsub;
    off(event: string, fn: (...args: any[]) => void): void;
    emit(event: string, ...args: any[]): void;
    getEntity(id: string): ScriptEntity | null;
    createEntity(opts?: { id?: string; name?: string; parent?: ScriptEntity | null }): ScriptEntity;
    destroyEntity(entity: ScriptEntity): void;
  }

  // Minimal three.js surface scripts reach into. Mirrors the subset of the
  // three/webgpu build actually used by `engine/Engine.js` and scripts.
  export class ScriptVector2 {
    constructor(x?: number, y?: number);
    x: number; y: number;
    set(x: number, y: number): this;
    copy(v: ScriptVector2): this;
    clone(): ScriptVector2;
    add(v: ScriptVector2): this;
    sub(v: ScriptVector2): this;
    multiplyScalar(s: number): this;
    divideScalar(s: number): this;
    length(): number;
    lengthSq(): number;
    normalize(): this;
    dot(v: ScriptVector2): number;
    distanceTo(v: ScriptVector2): number;
    lerp(v: ScriptVector2, alpha: number): this;
    toArray(): [number, number];
    fromArray(arr: ArrayLike<number>): this;
    equals(v: ScriptVector2): boolean;
    static distance(a: ScriptVector2, b: ScriptVector2): number;
  }
  export class ScriptVector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number; y: number; z: number;
    set(x: number, y: number, z: number): this;
    copy(v: ScriptVector3): this;
    clone(): ScriptVector3;
    add(v: ScriptVector3): this;
    sub(v: ScriptVector3): this;
    multiplyScalar(s: number): this;
    divideScalar(s: number): this;
    length(): number;
    lengthSq(): number;
    normalize(): this;
    dot(v: ScriptVector3): number;
    cross(v: ScriptVector3): this;
    distanceTo(v: ScriptVector3): number;
    lerp(v: ScriptVector3, alpha: number): this;
    applyEuler(e: ScriptEuler): this;
    applyQuaternion(q: ScriptQuaternion): this;
    toArray(): [number, number, number];
    fromArray(arr: ArrayLike<number>): this;
    equals(v: ScriptVector3): boolean;
    static distance(a: ScriptVector3, b: ScriptVector3): number;
  }
  export class ScriptEuler {
    constructor(x?: number, y?: number, z?: number, order?: string);
    x: number; y: number; z: number; order: string;
    set(x: number, y: number, z: number, order?: string): this;
    toArray(): [number, number, number];
  }
  export class ScriptQuaternion {
    constructor(x?: number, y?: number, z?: number, w?: number);
    x: number; y: number; z: number; w: number;
    set(x: number, y: number, z: number, w: number): this;
    identity(): this;
    copy(q: ScriptQuaternion): this;
    clone(): ScriptQuaternion;
    setFromAxisAngle(axis: ScriptVector3, angle: number): this;
    setFromEuler(euler: ScriptEuler): this;
    inverse(): this;
    multiply(q: ScriptQuaternion): this;
    slerp(qb: ScriptQuaternion, t: number): this;
    toArray(): [number, number, number, number];
  }
  export class ScriptMatrix4 {
    constructor();
    identity(): this;
    copy(m: ScriptMatrix4): this;
    clone(): ScriptMatrix4;
    compose(position: ScriptVector3, quaternion: ScriptQuaternion, scale: ScriptVector3): this;
    decompose(position: ScriptVector3, quaternion: ScriptQuaternion, scale: ScriptVector3): this;
    invert(): this;
    multiply(m: ScriptMatrix4): this;
    elements: number[];
  }
  export class ScriptColor {
    constructor(color?: string | number | ScriptColor);
    r: number; g: number; b: number;
    set(value: string | number | ScriptColor): this;
    copy(c: ScriptColor): this;
    setRGB(r: number, g: number, b: number): this;
    multiplyScalar(s: number): this;
    lerp(c: ScriptColor, alpha: number): this;
    getHex(): number;
    getHexString(): string;
  }
  export class ScriptCamera {
    isPerspectiveCamera: boolean;
    aspect: number;
    near: number; far: number;
    updateProjectionMatrix(): void;
  }
  export const ScriptMathUtils: {
    clamp(v: number, min: number, max: number): number;
    lerp(x: number, y: number, t: number): number;
    degToRad(d: number): number;
    radToDeg(r: number): number;
    randFloat(low: number, high: number): number;
    randInt(low: number, high: number): number;
  };

  /** Three namespace surface scripts reach into (aliases the engine's three import). */
  export const ScriptTHREE: {
    Vector2: typeof ScriptVector2;
    Vector3: typeof ScriptVector3;
    Euler: typeof ScriptEuler;
    Quaternion: typeof ScriptQuaternion;
    Matrix4: typeof ScriptMatrix4;
    Color: typeof ScriptColor;
    /** Object3D is interface-only in this declaration file — we don't ship a
     *  concrete class for it. Scripts typically use the typed accessors on
     *  `ScriptEntity` (`.position`, `.rotation`, …) instead. */
    Object3D: unknown;
    Camera: typeof ScriptCamera;
    MathUtils: typeof ScriptMathUtils;
    REVISION: string;
  };

  /**
   * Schema for an `@attribute`-decorated field. The editor reads this off the
   * loaded class (`static attributes`) and renders an Inspector field of the
   * matching kind (`number` / `text` / `boolean` / `select` / `vec3`).
   *
   * Constraints on `min`/`max`/`step` only apply to numeric fields. The
   * `options` array supplies values for `select` fields.
   */
  export interface AttributeOptions {
    type?: "number" | "text" | "boolean" | "select" | "vec3";
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: Array<string | number>;
    label?: string;
  }

  /**
   * Class-field decorator that registers the field in the class's static
   * `attributes` map. The editor reads that map to render Inspector fields
   * and `ScriptComponent` applies saved values on start.
   */
  export function attribute(options?: AttributeOptions): PropertyDecorator;

  // Re-export math classes under their three.js names. Both type-only
  // (`import type { Vector2 } from "engine"`) and value forms work — at
  // runtime the re-exports resolve to the actual three.js constructors
  // (see src/engine/scriptRuntime/runtime.js), so `import { Vector3 } from
  // "engine"; new Vector3()` gives you a real THREE.Vector3 instance.
  //
  // The type-only declarations stay because some user code prefers
  // `import type { … }` for compile-time-only handles (smaller emitted
  // code, no runtime dependency on the engine module). The value forms
  // match the runtime exports.
  export type Vector2 = ScriptVector2;
  export const Vector2: typeof ScriptVector2;
  export type Vector3 = ScriptVector3;
  export const Vector3: typeof ScriptVector3;
  export type Euler = ScriptEuler;
  export const Euler: typeof ScriptEuler;
  export type Quaternion = ScriptQuaternion;
  export const Quaternion: typeof ScriptQuaternion;
  export type Matrix4 = ScriptMatrix4;
  export const Matrix4: typeof ScriptMatrix4;
  export type Color = ScriptColor;
  export const Color: typeof ScriptColor;
  export type Object3D = ScriptObject3D;
  export const Object3D: typeof ScriptObject3D;
  export type Camera = ScriptCamera;
  export const Camera: typeof ScriptCamera;
  export const MathUtils: typeof ScriptMathUtils;
  export type Entity = ScriptEntity;

  /**
   * Base class scripts extend for full IntelliSense on `this.entity`,
   * `this.engine`, `this.THREE`, `this.input`, plus the lifecycle methods.
   *
   * The runtime DOES NOT require extending this class — `ScriptComponent`
   * injects the four context properties on every script instance regardless
   * of its base class. This class exists purely as a type-system helper.
   */
  export class Script {
    entity: ScriptEntity;
    engine: ScriptEngine;
    THREE: typeof ScriptTHREE;
    input: ScriptInputManager | null;

    onStart?(): void;
    onUpdate?(dt: number): void;
    onDestroy?(): void;
    onHotReload?(oldInstance: Script): void;
  }
}