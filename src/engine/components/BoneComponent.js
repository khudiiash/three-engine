import { Component } from "./Component.js";

/**
 * Internal marker for an attachment point in an imported skeletal model.
 *
 * `path` addresses a Bone in the GLB scene graph by its child-index path.
 * It is deliberately not a bone implementation of its own: ModelComponent
 * reads this marker and mirrors the animated GLB bone onto the entity's
 * Object3D. That keeps the entity tree editable/serializable while a child
 * (a weapon, VFX, etc.) follows the real animation rig.
 */
export class BoneComponent extends Component {
  static type = "bone";
  static label = "Bone";
  static internal = true;
  static defaults = { path: "" };
  static schema = [];

  onAttach() {
    this.#ownerModel()?.bindSkeletonEntities();
  }

  onDetach() {
    // Rebuild the owner's map so a removed marker stops receiving pose data.
    const model = this.#ownerModel();
    // Entity.removeComponent invokes onDetach before deleting from its map.
    // Defer one microtask so the marker is no longer discoverable.
    queueMicrotask(() => model?.bindSkeletonEntities());
  }

  #ownerModel() {
    for (let entity = this.entity.parent; entity; entity = entity.parent) {
      const model = entity.getComponent("model");
      if (model) return model;
    }
    return null;
  }
}
