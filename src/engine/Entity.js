import * as THREE from "three/webgpu";
import { createId } from "../shared/ids.js";
import { createComponent, getComponentClass } from "./components/registry.js";

/**
 * PlayCanvas-style entity: a scene-graph node wrapping an Object3D,
 * with components attached for rendering/behavior.
 *
 * For ergonomics, transform properties (`position`, `rotation`, `scale`,
 * `quaternion`, `visible`, `name`) and the most common Object3D methods
 * (`lookAt`, `getWorldPosition`, etc.) are aliased directly on the entity,
 * so scripts can write `this.entity.position.set(0, 1, 0)` instead of
 * `this.entity.object3D.position.set(0, 1, 0)`. The three.js Object3D
 * remains the source of truth and remains reachable via `entity.object3D`
 * for anything not aliased (matrix ops, scene-graph children, etc.).
 *
 * `entity.children` and `entity.parent` deliberately stay separate from
 * `object3D.children` / `object3D.parent` — they refer to other Entities,
 * not raw three nodes.
 */
export class Entity {
  constructor(engine, { id, name = "Entity" } = {}) {
    this.engine = engine;
    this.id = id ?? createId();
    this.object3D = new THREE.Object3D();
    this.object3D.name = name;
    this.object3D.userData.entityId = this.id;
    this.components = new Map();
    this.parent = null;
    this.children = [];
    // Entity-wide view-only toggle. When true, every component on this
    // entity opts into frustum gating unless it has `props.viewOnly`
    // explicitly set false. Defaults to false to match the prior behaviour
    // (no implicit gating). Serialised with the entity.
    this.viewOnly = false;
    // Per-mode enabled flags. An entity is "enabled in editor" when it
    // contributes to the scene while not in play mode; "enabled in game"
    // is the equivalent during play. Toggling false hides the entity's
    // Object3D subtree (so its MeshComponent / LightComponent / etc. all
    // drop out of the render) — the entity itself remains in the tree, so
    // scripts can still read/write it and inspectors still show it.
    // Inherits to descendants via the per-frame resolver in Engine.#tick;
    // a parent disabled in editor disables its whole subtree unless the
    // child has its own override set. Serialised with the entity.
    this.enabledInEditor = true;
    this.enabledInGame = true;
    // Prefab bookkeeping. `prefab` ({ guid, path }) is set only on the root of
    // a prefab instance and is what makes it one; `fid` / `fidPath` address
    // this entity inside the prefab it came from. All three are absent on
    // ordinary entities and are stripped by Unpack. See engine/prefab/expand.js.
    this.prefab = null;
    this.fid = null;
    this.fidPath = null;
  }

  // ---- Transform aliases (delegate to object3D) --------------------------

  get name() {
    return this.object3D.name;
  }

  set name(value) {
    this.object3D.name = value;
  }

  get position() {
    return this.object3D.position;
  }

  set position(value) {
    // Accept Vector3-like (x/y/z) or [x, y, z] tuple — common in scripts
    // and from serialized transforms.
    if (Array.isArray(value)) this.object3D.position.fromArray(value);
    else this.object3D.position.copy(value);
  }

  get rotation() {
    return this.object3D.rotation;
  }

  set rotation(value) {
    if (Array.isArray(value)) this.object3D.rotation.set(value[0], value[1], value[2]);
    else this.object3D.rotation.copy(value);
  }

  get quaternion() {
    return this.object3D.quaternion;
  }

  set quaternion(value) {
    this.object3D.quaternion.copy(value);
  }

  get scale() {
    return this.object3D.scale;
  }

  set scale(value) {
    if (Array.isArray(value)) this.object3D.scale.fromArray(value);
    else this.object3D.scale.copy(value);
  }

  get visible() {
    return this.object3D.visible;
  }

  set visible(value) {
    this.object3D.visible = value;
  }

  get up() {
    return this.object3D.up;
  }

  set up(value) {
    this.object3D.up.copy(value);
  }

  getObjectByName(name) {
    return this.object3D.getObjectByName(name);
  }

  getEntityByName(name) {
    for (const child of this.children) {
      if (child.name === name) return child;
      const hit = child.getEntityByName(name);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Recursively collect every component matching `type` from this entity
   * and all descendants (depth-first). Always returns an array — empty when
   * nothing matches, never null/undefined, so callers can use
   * `arr.length === 0` as a clean "not found" check.
   *
   * Lookup matches `Component.type` (the static `type` string on the
   * Component subclass, e.g. "camera", "script", "model"), NOT the entity
   * name. Compare against `getComponent(type)` if you only want this
   * entity itself.
   *
   * "find*" returning an array (not the first hit) matches the
   * `querySelectorAll` convention. Generic over `T` in the TS surface so
   * callers can ask for a specific component shape; the runtime returns
   * whatever `Component` instance is in the map.
   */
  findComponents(type) {
    const out = [];
    if (this.components.has(type)) out.push(this.components.get(type));
    for (const child of this.children) {
      const hits = child.findComponents(type);
      if (hits.length) out.push(...hits);
    }
    return out;
  }

  // ---- Object3D methods (forwarded) --------------------------------------

  lookAt(target) {
    this.object3D.lookAt(target);
  }

  getWorldPosition(target) {
    return this.object3D.getWorldPosition(target);
  }

  getWorldQuaternion(target) {
    return this.object3D.getWorldQuaternion(target);
  }

  getWorldScale(target) {
    return this.object3D.getWorldScale(target);
  }

  getWorldDirection(target) {
    return this.object3D.getWorldDirection(target);
  }

  updateMatrix() {
    this.object3D.updateMatrix();
  }

  updateMatrixWorld(force) {
    this.object3D.updateMatrixWorld(force);
  }

  // ---- Entity tree (distinct from the scene-graph children/parent) -----

  addComponent(type, props) {
    if (this.components.has(type)) throw new Error(`Entity already has a "${type}" component`);
    const ComponentClass = getComponentClass(type);
    for (const requirement of ComponentClass?.requiredComponents ?? []) {
      const requiredType = typeof requirement === "string" ? requirement : requirement.type;
      if (!requiredType || this.components.has(requiredType)) continue;
      this.addComponent(requiredType, typeof requirement === "string" ? {} : requirement.props ?? {});
    }
    const component = createComponent(type, this, props);
    this.components.set(type, component);
    component.onAttach();
    return component;
  }

  /**
   * Sets the entity-wide viewOnly flag and refreshes every component's
   * cached `_viewOnlyActive` so their per-frame checks pick up the new
   * state immediately. Components that have `props.viewOnly === false`
   * explicitly stay disabled from gating (the entity toggle is an OR,
   * not an override — see `Component._viewOnlyActive`).
   */
  setViewOnly(value) {
    const next = !!value;
    if (next === this.viewOnly) return;
    this.viewOnly = next;
    for (const c of this.components.values()) {
      c._viewOnlyActive = !!c.props.viewOnly || next;
      c._inView = null; // force a fresh decision next frame
    }
  }

  /**
   * Sets the "enabled in editor" flag. The actual `object3D.visible` is
   * recomputed by the engine each frame (parent wins unless this entity
   * has an explicit override), so we don't need to walk descendants
   * here — they pick up the new state automatically. Emits
   * "hierarchy-changed" so the React mirror (and the inspector) refresh.
   */
  setEnabledInEditor(value) {
    const next = !!value;
    if (next === this.enabledInEditor) return;
    this.enabledInEditor = next;
    this.engine.emit("hierarchy-changed");
  }

  /** Sets the "enabled in game" flag (mirrors setEnabledInEditor). */
  setEnabledInGame(value) {
    const next = !!value;
    if (next === this.enabledInGame) return;
    this.enabledInGame = next;
    this.engine.emit("hierarchy-changed");
  }

  removeComponent(type) {
    const component = this.components.get(type);
    if (!component) return;
    component.onDetach();
    this.components.delete(type);
  }

  getComponent(type) {
    return this.components.get(type);
  }

  setParent(parent) {
    if (this.parent) {
      const idx = this.parent.children.indexOf(this);
      if (idx !== -1) this.parent.children.splice(idx, 1);
    } else {
      const idx = this.engine.rootEntities.indexOf(this);
      if (idx !== -1) this.engine.rootEntities.splice(idx, 1);
    }
    this.parent = parent ?? null;
    if (parent) {
      parent.children.push(this);
      parent.object3D.add(this.object3D);
    } else {
      this.engine.rootEntities.push(this);
      this.engine.scene.add(this.object3D);
    }
  }

  /** Depth-first walk over this entity and all descendants. */
  traverse(fn) {
    fn(this);
    for (const child of this.children) child.traverse(fn);
  }

  getTransform() {
    return {
      position: this.object3D.position.toArray(),
      rotation: [this.object3D.rotation.x, this.object3D.rotation.y, this.object3D.rotation.z],
      scale: this.object3D.scale.toArray(),
    };
  }

  setTransform({ position, rotation, scale }) {
    if (position) this.object3D.position.fromArray(position);
    if (rotation) this.object3D.rotation.set(rotation[0], rotation[1], rotation[2]);
    if (scale) this.object3D.scale.fromArray(scale);
  }

  dispose() {
    for (const type of [...this.components.keys()]) this.removeComponent(type);
  }
}
