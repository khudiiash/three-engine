import * as THREE from "three/webgpu";

/**
 * A set of Rapier bodies a COMPONENT owns directly, rather than through the
 * entity tree.
 *
 * ## Why some bodies are not entities
 *
 * Everything in `PhysicsSystem`'s three build passes exists because an entity
 * has a Rigidbody or a Collider on it. That is the right model for a crate,
 * and the wrong one for the twenty capsules of a ragdoll: skeleton bones are
 * not entities, they are `THREE.Bone`s inside a loaded GLB, and turning each
 * into an entity so it can have a body would put twenty rows in the Hierarchy
 * per character, all of them recreated on every activation, none of them
 * anything an author wants to select. The same is true of a chain built over
 * an Instancer: instances are matrices in an `InstancedMesh`, and they cannot
 * be entities without giving up the instancing that is the point of them.
 *
 * So Ragdoll and Chain build their bodies here instead. A rig:
 *
 *   · is created only while the world exists — the component registers itself
 *     with `PhysicsSystem.registerRig` and gets `buildRig` / `clearRig` /
 *     `syncRig` calls at exactly the points the world is built, torn down and
 *     stepped, so a component never has to guess whether Play has started;
 *   · registers its colliders in the SAME maps the entity path uses, so a
 *     raycast that hits a ragdoll's forearm reports the character's entity and
 *     a collision event on a chain link reaches the chain's scripts;
 *   · frees in dependency order (joints, colliders, bodies), which is the
 *     ordering Rapier treats as use-after-free if you get it wrong.
 */
export class PhysicsRig {
  /**
   * @param {any} physics The live PhysicsSystem.
   * @param {any} entity The entity every collider reports as its owner.
   */
  constructor(physics, entity) {
    this.physics = physics;
    this.entity = entity;
    this.world = physics.world;
    this.bodies = [];
    this.colliders = [];
    this.joints = [];
  }

  get RAPIER() {
    return this.physics.RAPIER;
  }

  /** A dynamic body at a world pose. */
  dynamicBody(position, quaternion, { linearDamping = 0, angularDamping = 0, ccd = false, gravityScale = 1 } = {}) {
    const desc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w })
      .setLinearDamping(linearDamping)
      .setAngularDamping(angularDamping)
      .setGravityScale(gravityScale)
      .setCcdEnabled(ccd);
    return this.body(desc);
  }

  /** A fixed body — what a chain or ragdoll is pinned to when nothing else is. */
  fixedBody(position, quaternion = null) {
    const desc = this.RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z);
    if (quaternion) desc.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });
    return this.body(desc);
  }

  body(desc) {
    const body = this.world.createRigidBody(desc);
    this.bodies.push(body);
    return body;
  }

  /**
   * A collider on one of this rig's bodies. Registered in the system's
   * handle→entity and handle→layer maps, which is what makes it answer scene
   * queries and collision events as the owning entity rather than as nothing.
   */
  collider(desc, body, { layer = "Default", entity = this.entity } = {}) {
    desc
      .setCollisionGroups(this.physics.layers.groupsFor(this.physics.layers.indexOf(layer)))
      .setActiveEvents(this.RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(desc, body);
    this.colliders.push(collider);
    this.physics.colliderEntity.set(collider.handle, entity);
    this.physics.colliderLayer.set(collider.handle, this.physics.layers.indexOf(layer));
    return collider;
  }

  joint(data, bodyA, bodyB, contacts = false) {
    const joint = this.world.createImpulseJoint(data, bodyA, bodyB, true);
    joint.setContactsEnabled?.(contacts);
    this.joints.push(joint);
    return joint;
  }

  /**
   * Cone / twist limits on a spherical joint.
   *
   * ⚠ NOT IN THE TYPED API. `SphericalImpulseJoint` extends `ImpulseJoint`,
   * not `UnitImpulseJoint`, so it has no `setLimits` — the wrapper only
   * exposes limits for the one-degree-of-freedom joints. The underlying
   * `RawImpulseJointSet.jointSetLimits(handle, axis, min, max)` takes any axis
   * and is what the wrapper's own `setLimits` calls, so this reaches it
   * through the same `rawSet` field. Guarded rather than assumed: a Rapier
   * upgrade that renames the field costs a ragdoll its joint limits (floppy,
   * still simulating) instead of throwing on the first activation.
   */
  setAngularLimits(joint, minRadians, maxRadians, axes = [ANG_X, ANG_Y, ANG_Z]) {
    const rawSet = joint?.rawSet;
    if (typeof rawSet?.jointSetLimits !== "function") return false;
    try {
      for (const axis of axes) rawSet.jointSetLimits(joint.handle, axis, minRadians, maxRadians);
      return true;
    } catch (error) {
      console.warn(`Physics rig: joint limits are unavailable in this Rapier build (${error?.message ?? error}).`);
      return false;
    }
  }

  /** Frees everything this rig created, joints first. Safe to call twice. */
  clear() {
    const world = this.world;
    if (world && !this.physics.disposed) {
      for (const joint of this.joints) {
        try {
          world.removeImpulseJoint(joint, true);
        } catch { /* the world may already have dropped it with its bodies */ }
      }
      // Removing a body frees its colliders, so the collider handles are only
      // unregistered here — removing them by hand as well is the
      // use-after-free `PhysicsSystem.#removeEntities` documents.
      for (const collider of this.colliders) {
        this.physics.forgetCollider?.(collider.handle);
      }
      for (const body of this.bodies) {
        try {
          world.removeRigidBody(body);
        } catch { /* already gone with the world */ }
      }
    }
    this.joints.length = 0;
    this.colliders.length = 0;
    this.bodies.length = 0;
  }
}

/** `RawJointAxis` values — the wasm enum, which the wrapper does not re-export. */
export const ANG_X = 3;
export const ANG_Y = 4;
export const ANG_Z = 5;

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/**
 * A capsule between two world points, as the pose and dimensions Rapier wants.
 *
 * Capsules are built along their own local Y, so the rotation is whatever takes
 * +Y onto the segment. Returns null for a segment too short to be a capsule at
 * this radius — the caller decides whether that bone is skipped or merged.
 */
export function capsuleBetween(from, to, radius) {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = direction.length();
  if (!(length > 1e-5)) return null;
  const halfHeight = length / 2 - radius;
  if (!(halfHeight > 1e-4)) return null;
  const centre = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.multiplyScalar(1 / length),
  );
  return { centre, quaternion, halfHeight, radius, length };
}

/** World position/rotation of an Object3D, without allocating at the call site. */
export function worldPose(object, position = _position, quaternion = _quaternion) {
  object.matrixWorld.decompose(position, quaternion, _scale);
  return { position, quaternion };
}
