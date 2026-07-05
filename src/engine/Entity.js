import * as THREE from "three/webgpu";
import { createId } from "../shared/ids.js";
import { createComponent } from "./components/registry.js";

/**
 * PlayCanvas-style entity: a scene-graph node wrapping an Object3D,
 * with components attached for rendering/behavior.
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
  }

  get name() {
    return this.object3D.name;
  }

  set name(value) {
    this.object3D.name = value;
  }

  addComponent(type, props) {
    if (this.components.has(type)) throw new Error(`Entity already has a "${type}" component`);
    const component = createComponent(type, this, props);
    this.components.set(type, component);
    component.onAttach();
    return component;
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
