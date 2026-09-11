import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { PhysicsRig, capsuleBetween, ANG_X, ANG_Y, ANG_Z } from "./rig.js";
import { physicsLayerNames } from "./layerConfig.js";

/**
 * Turns an animated character into a physical one: a capsule per bone, joints
 * between them, and the skeleton posed by the simulation instead of by the
 * animator.
 *
 * ## Built from the rig it is given, not from a list of bone names
 *
 * Every other engine's ragdoll starts by asking which bone is the left thigh.
 * That mapping is a per-rig chore, it breaks on the first model that names
 * things differently, and it can only ever support humanoids. This builds
 * itself from the SKELETON'S OWN SHAPE instead: every bone that has a child
 * bone is a segment from its head to its child's head, that segment becomes a
 * capsule, and the capsule is jointed to the capsule of the nearest ancestor
 * bone that got one. A biped, a quadruped, a spider, a tentacle and a chain of
 * carriages all fall over correctly with no configuration.
 *
 * Two numbers keep it in proportion:
 *   `minBoneLength` — bones shorter than this get no body of their own (every
 *                     finger joint on a Mixamo rig is 2 cm; twenty extra
 *                     bodies per hand buys nothing and costs a lot);
 *   `maxBodies`     — a hard cap, honoured by keeping the LONGEST bones, which
 *                     is the same thing as keeping the limbs and dropping the
 *                     details.
 *
 * ## Activation is a property, not a call
 *
 * `active` is an ordinary prop, so an Events row can set it, a script can
 * write `ragdoll.active = true`, the Inspector has a checkbox for it, and it
 * serializes — a character authored dead stays dead. `activate()` /
 * `deactivate()` are conveniences over the same flag.
 *
 * While it is active the AnimationComponent and CharacterController are held
 * disabled through `setEnabledOverride`, which does NOT touch their authored
 * props: deactivating restores exactly what the author set, and nothing about
 * a death is saved into the scene.
 *
 * ## Joint limits, and the one thing Rapier's JS API will not do
 *
 * A spherical joint with no limits gives a rag, not a ragdoll — heads rotate
 * through chests. Rapier's wrapper exposes limits only on the single-axis
 * joints, but the underlying joint set takes them on any axis, so
 * `PhysicsRig.setAngularLimits` reaches through to it (guarded — see rig.js).
 * `jointLimit` is the half-angle of the cone every joint is allowed, in
 * degrees.
 */

const _bonePosition = new THREE.Vector3();
const _childPosition = new THREE.Vector3();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _bodyMatrix = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const DEG2RAD = Math.PI / 180;
const ONE = new THREE.Vector3(1, 1, 1);

const v3 = (v) => ({ x: v.x, y: v.y, z: v.z });

export class RagdollComponent extends Component {
  static type = "ragdoll";
  static label = "Ragdoll";
  static tags = ["physics", "play-mode", "3d", "animation"];
  /** Owns Rapier bodies directly — PhysicsSystem adopts it as a rig. */
  static physicsRig = true;
  static resetOnStop = true;

  static defaults = {
    active: false,
    // kg for the whole character, split across the bones by capsule volume.
    mass: 70,
    // Capsule radius as a fraction of the bone's length. 0.28 gives limbs that
    // look like limbs; higher reads as armour, lower as a skeleton.
    thickness: 0.28,
    minBoneLength: 0.06,
    maxBodies: 20,
    jointLimit: 40,
    // Damping keeps a ragdoll from windmilling: real bodies have muscles and
    // friction, and a jointed chain of capsules has neither.
    linearDamping: 0.05,
    angularDamping: 2,
    layer: "Default",
    // Whether bodies joined to each other also collide. Off: a shoulder and an
    // upper arm overlap by construction, and making them push each other apart
    // is how a ragdoll ends up vibrating.
    selfCollision: false,
    // Carry the character's motion into the ragdoll so a runner falls forward.
    inheritVelocity: true,
    // Track the entity to the root bone's body, so gameplay that follows the
    // character (a camera, a respawn point, culling) keeps working.
    followRoot: true,
  };

  static schema = [
    { key: "active", label: "Active", type: "boolean" },
    { key: "mass", label: "Mass (kg)", type: "number", min: 0.1, step: 1 },
    { key: "thickness", label: "Thickness", type: "number", min: 0.05, max: 1, step: 0.01 },
    { key: "minBoneLength", label: "Min Bone (m)", type: "number", min: 0.001, step: 0.01 },
    { key: "maxBodies", label: "Max Bodies", type: "number", min: 2, max: 64, step: 1 },
    { key: "jointLimit", label: "Joint Limit (°)", type: "number", min: 0, max: 180, step: 5 },
    { key: "linearDamping", label: "Lin. Damping", type: "number", min: 0, step: 0.05 },
    { key: "angularDamping", label: "Ang. Damping", type: "number", min: 0, step: 0.1 },
    { key: "layer", label: "Layer", type: "select", options: physicsLayerNames },
    { key: "selfCollision", label: "Parts Collide", type: "boolean" },
    { key: "inheritVelocity", label: "Inherit Velocity", type: "boolean" },
    { key: "followRoot", label: "Move Entity", type: "boolean" },
  ];

  onAttach() {
    /** @type {any[]} One entry per simulated bone while active. */
    this.parts = [];
    this._rig = null;
    this._suspended = [];
    this.entity.engine?.physics?.registerRig(this);
  }

  onDetach() {
    this.entity?.engine?.physics?.unregisterRig(this);
    this.#resume();
    this.parts = [];
  }

  onPropChanged(key) {
    if (key === "active") {
      if (this.props.active) this.#build();
      else this.#teardown();
      return;
    }
    // Everything else shapes the bodies, so it only means anything on the next
    // activation — except while one is running, where rebuilding from the
    // CURRENT pose is what an author tweaking thickness expects to see.
    if (this.props.active) {
      this.#teardown();
      this.#build();
    }
  }

  onDisable() {
    this.#teardown();
  }

  onEnable() {
    this.entity?.engine?.physics?.registerRig(this);
    if (this.props.active) this.#build();
  }

  /* ---- script-facing API -------------------------------------------------- */

  /**
   * Goes limp.
   *
   *     ragdoll.activate();
   *     ragdoll.activate({ impulse: [0, 4, -12], bone: "Head" });
   *
   * @param {object} [options]
   * @param {number[]} [options.impulse] World-space kick, applied after the
   *   bodies exist — a hit, a blast, the thing that killed them.
   * @param {string} [options.bone] Which bone takes it; the root by default.
   */
  activate({ impulse = null, bone = null } = {}) {
    if (!this.props.active) this.setProp("active", true);
    else if (!this.parts.length) this.#build();
    if (impulse) this.applyImpulse(impulse, bone);
    return this.parts.length;
  }

  /** Hands the character back to its animator, in whatever pose it landed. */
  deactivate() {
    if (this.props.active) this.setProp("active", false);
    else this.#teardown();
  }

  /** Whether the simulation is currently driving the skeleton. */
  get simulating() {
    return this.parts.length > 0;
  }

  /** Kicks one bone (or the root) — `[x, y, z]` in world space, N·s. */
  applyImpulse([x, y, z], boneName = null) {
    const part = boneName ? this.parts.find((entry) => entry.bone.name === boneName) : this.parts[0];
    if (!part) return false;
    part.body.applyImpulse({ x, y, z }, true);
    return true;
  }

  /** The bones this ragdoll actually simulates, in build order. */
  getBones() {
    return this.parts.map((part) => part.bone.name);
  }

  /* ---- rig contract (see rig.js) ------------------------------------------ */

  buildRig() {
    if (this.props.active) this.#build();
  }

  clearRig() {
    this.#teardown();
  }

  /**
   * Poses the skeleton from the bodies.
   *
   * Parents before children, and BOTH the local transform and `matrixWorld`
   * are written: the local is what the scene's own matrix pass will recompute
   * from next frame, and the world is what this loop's remaining children —
   * and the skinning that runs before that pass — read this frame.
   */
  syncRig() {
    if (!this.parts.length) return;
    // A settled ragdoll is asleep in Rapier, and a sleeping body's pose does
    // not change — so a corridor of dead bodies costs nothing to keep lying
    // there. All-or-nothing rather than per part: a bone's world matrix moves
    // when its PARENT moves, so a still-awake hip has to re-pose the whole
    // chain below it.
    if (this.parts.every((part) => part.body.isSleeping())) return;
    const root = this.parts[0];
    if (this.props.followRoot && root) {
      // The entity follows the root body's TRANSLATION only. Taking its
      // rotation too would rotate the whole skeleton a second time, once
      // through the entity and once through the bones.
      const translation = root.body.translation();
      _position.set(translation.x, translation.y, translation.z);
      const object = this.entity.object3D;
      const offset = _bonePosition.copy(root.rootOffset).applyQuaternion(
        object.getWorldQuaternion(_quaternion),
      );
      _position.sub(offset);
      if (this.entity.parent) {
        this.entity.parent.object3D.updateWorldMatrix(true, false);
        _position.applyMatrix4(_inverse.copy(this.entity.parent.object3D.matrixWorld).invert());
      }
      object.position.copy(_position);
      object.updateMatrixWorld(true);
    }

    for (const part of this.parts) {
      const translation = part.body.translation();
      const rotation = part.body.rotation();
      _position.set(translation.x, translation.y, translation.z);
      _quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      _bodyMatrix.compose(_position, _quaternion, ONE);
      // boneWorld = bodyWorld * (bodyBind⁻¹ · boneBind), the constant offset
      // between the capsule and the bone it stands for.
      _matrix.multiplyMatrices(_bodyMatrix, part.bindOffset);
      const bone = part.bone;
      if (bone.parent) {
        _matrix.premultiply(_inverse.copy(bone.parent.matrixWorld).invert());
      }
      _matrix.decompose(_position, _quaternion, _scale);
      bone.position.copy(_position);
      bone.quaternion.copy(_quaternion);
      bone.updateMatrix();
      if (bone.parent) bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
      else bone.matrixWorld.copy(bone.matrix);
    }
  }

  /* ---- building ----------------------------------------------------------- */

  /** Every bone under this entity's loaded model, roots first. */
  #skeletonBones() {
    const root = this.entity.getComponent("model")?.root
      ?? this.entity.getComponent("skinnedmesh")?.mesh?.skeleton?.bones?.[0]?.parent
      ?? this.entity.object3D;
    const bones = [];
    root.traverse?.((object) => {
      if (object.isBone) bones.push(object);
    });
    return bones;
  }

  /**
   * The bones worth a body, as `{ bone, from, to, length }` in world space.
   *
   * A bone's segment runs to its FARTHEST child bone rather than to the mean
   * of them: at a hip or a shoulder the mean points into the torso and gives a
   * stub, while the farthest child is the limb that is actually there.
   */
  #segments(bones) {
    const segments = [];
    for (const bone of bones) {
      const children = bone.children.filter((child) => child.isBone);
      if (!children.length) continue;
      bone.getWorldPosition(_bonePosition);
      let best = null;
      let bestDistance = 0;
      for (const child of children) {
        const distance = child.getWorldPosition(_childPosition).distanceTo(_bonePosition);
        if (distance <= bestDistance) continue;
        bestDistance = distance;
        best = _childPosition.clone();
      }
      if (!best || bestDistance < this.props.minBoneLength) continue;
      segments.push({ bone, from: _bonePosition.clone(), to: best, length: bestDistance });
    }
    if (segments.length <= this.props.maxBodies) return segments;
    // Over the cap: keep the longest bones (the limbs), then restore the
    // skeleton's own order so parents are still built before their children.
    const keep = new Set([...segments].sort((a, b) => b.length - a.length).slice(0, this.props.maxBodies));
    return segments.filter((segment) => keep.has(segment));
  }

  #build() {
    const engine = this.entity?.engine;
    const physics = engine?.physics;
    if (!physics?.world || !this.enabled || this.parts.length) return;

    this.entity.object3D.updateMatrixWorld(true);
    const bones = this.#skeletonBones();
    if (!bones.length) {
      console.warn(`Ragdoll on "${this.entity.name}": no skeleton found — it needs a Model (or SkinnedMesh) with bones.`);
      return;
    }
    const segments = this.#segments(bones);
    if (segments.length < 2) {
      console.warn(
        `Ragdoll on "${this.entity.name}": only ${segments.length} bone(s) are longer than ${this.props.minBoneLength} m. ` +
          "Lower Min Bone, or check the model's scale.",
      );
      return;
    }

    // The character's own motion, taken before its controller is suspended.
    const inherited = this.props.inheritVelocity ? this.#characterVelocity() : [0, 0, 0];
    this.#suspend();

    const rig = new PhysicsRig(physics, this.entity);
    this._rig = rig;
    const parts = [];
    const byBone = new Map();

    // ⚠ MASS BEFORE THE COLLIDER EXISTS. A collider's mass is part of its
    // DESCRIPTOR; setting it afterwards leaves the body weighing what Rapier's
    // default density gives it, which for a limb-sized capsule is under a
    // tenth of a kilogram — a 70 kg character that a footstep can punt across
    // the room. So the capsules are measured first, and each descriptor is
    // built already carrying its share of the total.
    const capsules = segments.map((segment) => {
      const radius = Math.max(segment.length * this.props.thickness, 0.01);
      return capsuleBetween(segment.from, segment.to, radius)
        // A bone shorter than twice its radius cannot be a capsule; a ball of
        // the same radius is the shape it wants to be anyway.
        ?? { centre: segment.from.clone().lerp(segment.to, 0.5), quaternion: new THREE.Quaternion(), halfHeight: 0, radius, length: segment.length };
    });
    const volumes = capsules.map((capsule) =>
      Math.PI * capsule.radius * capsule.radius * (capsule.halfHeight * 2 + (4 / 3) * capsule.radius));
    const totalVolume = volumes.reduce((a, b) => a + b, 0) || 1;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const capsule = capsules[i];
      const body = rig.dynamicBody(capsule.centre, capsule.quaternion, {
        linearDamping: this.props.linearDamping,
        angularDamping: this.props.angularDamping,
      });
      body.setLinvel({ x: inherited[0], y: inherited[1], z: inherited[2] }, false);
      const desc = capsule.halfHeight > 0
        ? physics.RAPIER.ColliderDesc.capsule(capsule.halfHeight, capsule.radius)
        : physics.RAPIER.ColliderDesc.ball(capsule.radius);
      desc
        .setFriction(0.6)
        .setRestitution(0)
        .setMass(Math.max((volumes[i] / totalVolume) * this.props.mass, 1e-3));
      rig.collider(desc, body, { layer: this.props.layer });

      // The constant that takes the body's pose back to the bone's pose.
      _bodyMatrix.compose(capsule.centre, capsule.quaternion, ONE);
      const part = {
        bone: segment.bone,
        body,
        bindOffset: _inverse.copy(_bodyMatrix).invert().multiply(segment.bone.matrixWorld).clone(),
        rootOffset: new THREE.Vector3(),
      };
      parts.push(part);
      byBone.set(segment.bone, part);
    }

    // Joints: each part to the nearest ancestor bone that also has one.
    const limit = this.props.jointLimit * DEG2RAD;
    for (const part of parts) {
      const parent = this.#parentPart(part.bone, byBone);
      if (!parent) continue;
      part.bone.getWorldPosition(_bonePosition);
      const joint = rig.joint(
        physics.RAPIER.JointData.spherical(
          v3(localPoint(parent.body, _bonePosition, _position)),
          v3(localPoint(part.body, _bonePosition, _position)),
        ),
        parent.body,
        part.body,
        this.props.selfCollision,
      );
      if (limit > 0) rig.setAngularLimits(joint, -limit, limit, [ANG_X, ANG_Y, ANG_Z]);
    }

    // Where the entity sits relative to its root body, so `followRoot` can
    // move the entity without the skeleton sliding inside it.
    if (parts.length) {
      const rootTranslation = parts[0].body.translation();
      parts[0].rootOffset
        .set(rootTranslation.x, rootTranslation.y, rootTranslation.z)
        .sub(this.entity.object3D.getWorldPosition(_position))
        .applyQuaternion(this.entity.object3D.getWorldQuaternion(_quaternion).invert());
    }

    this.parts = parts;
  }

  #teardown() {
    if (!this.parts.length && !this._rig) return;
    this._rig?.clear();
    this._rig = null;
    this.parts = [];
    this.#resume();
  }

  /** The nearest ancestor bone with a body of its own. */
  #parentPart(bone, byBone) {
    for (let parent = bone.parent; parent; parent = parent.parent) {
      const part = byBone.get(parent);
      if (part) return part;
      if (!parent.isBone) break;
    }
    return null;
  }

  #characterVelocity() {
    const character = this.entity.getComponent("charactercontroller");
    if (character?.getVelocity) return character.getVelocity();
    const rigidbody = this.entity.getComponent("rigidbody");
    return rigidbody?.getLinearVelocity?.() ?? [0, 0, 0];
  }

  /**
   * Holds the components that would fight the simulation for the skeleton.
   *
   * `setEnabledOverride` rather than `setProp("enabled")`: the author's own
   * value is untouched, so `#resume` restores exactly what was there and a
   * death never edits the scene.
   */
  #suspend() {
    this._suspended = [];
    for (const type of ["animation", "ik", "charactercontroller"]) {
      const component = this.entity.getComponent(type);
      if (!component || !component.enabled) continue;
      component.setEnabledOverride(false);
      this._suspended.push(component);
    }
  }

  #resume() {
    for (const component of this._suspended ?? []) component.setEnabledOverride(null);
    this._suspended = [];
  }
}

/** A world point in a body's local frame. */
function localPoint(body, worldPoint, out) {
  const translation = body.translation();
  const rotation = body.rotation();
  out.set(worldPoint.x - translation.x, worldPoint.y - translation.y, worldPoint.z - translation.z);
  return out.applyQuaternion(new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w).invert());
}
