import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { PhysicsRig } from "./rig.js";
import { physicsLayerNames } from "./layerConfig.js";

/**
 * Links a run of objects into a chain — a rope, a bridge, a hanging sign, a
 * tank track, a string of lanterns.
 *
 * ## Two sources, because a chain is authored two ways
 *
 *   source = "children"  — every child entity is a link, in hierarchy order.
 *                          This is the one you build by hand: parent five
 *                          objects, add Chain, press Play. Links without a
 *                          Rigidbody get a dynamic one while playing (turn
 *                          `Create Bodies` off to require them explicitly).
 *
 *   source = "instances" — the entity's Instancer supplies the links, and the
 *                          chain is built over its INSTANCES. An Array-mode
 *                          Instancer with `count: 30` is already a row of
 *                          thirty evenly spaced copies; this turns that row
 *                          into thirty jointed bodies without creating thirty
 *                          entities, and writes the simulated poses straight
 *                          back into the instance matrices. Thirty links cost
 *                          one draw call.
 *
 * ⚠ INSTANCES ARE NOT ENTITIES, which is exactly why the bodies for them are
 * built as a rig (see rig.js) rather than through the usual Rigidbody path.
 * Their colliders are still registered against this entity, so a raycast that
 * hits a link reports the chain, and collision events reach its scripts.
 *
 * ## Anchors, and why they are computed rather than authored
 *
 * A JointComponent asks the author for anchors in each body's local space,
 * which is right for a door (the hinge is a specific edge) and wrong for a
 * chain (the link joins its neighbour wherever the neighbour happens to be).
 * So each joint is placed at the MIDPOINT between the two links it connects,
 * expressed in each body's own frame — one number, `slack`, then covers "how
 * loose", which is the only thing an author actually wants to say.
 */

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _axis = new THREE.Vector3();
const _anchorA = new THREE.Vector3();
const _anchorB = new THREE.Vector3();
const _size = new THREE.Vector3();

const v3 = (v) => ({ x: v.x, y: v.y, z: v.z });

export class ChainComponent extends Component {
  static type = "chain";
  static label = "Chain";
  static tags = ["physics", "play-mode", "3d"];
  /** Owns Rapier bodies directly — PhysicsSystem adopts it as a rig. */
  static physicsRig = true;
  static resetOnStop = true;

  static defaults = {
    source: "children",
    jointKind: "ball",
    axis: [0, 0, 1],
    // Metres of extra length per joint. 0 is a rigid articulated chain; a
    // positive value is rope — the links may drift apart by this much.
    slack: 0,
    stiffness: 200,
    damping: 10,
    // Anchor the first/last link to the world (or to `attachTo`) so the chain
    // hangs instead of falling.
    pinFirst: true,
    pinLast: false,
    attachTo: "",
    loop: false,
    linkCollision: false,
    createBodies: true,
    // instances only ---------------------------------------------------------
    linkShape: "auto",
    linkMass: 1,
    layer: "Default",
    friction: 0.5,
    restitution: 0,
    linearDamping: 0.1,
    angularDamping: 0.5,
  };

  static schema = [
    { key: "source", label: "Links From", type: "select", options: ["children", "instances"] },
    { key: "jointKind", label: "Joint", type: "select", options: ["ball", "hinge", "fixed", "rope", "spring"] },
    { key: "axis", label: "Hinge Axis", type: "vec3", showIf: (p) => p.jointKind === "hinge" },
    { key: "slack", label: "Slack", type: "number", min: 0, step: 0.05 },
    { key: "stiffness", label: "Stiffness", type: "number", min: 0, step: 10, showIf: (p) => p.jointKind === "spring" },
    { key: "damping", label: "Damping", type: "number", min: 0, step: 1, showIf: (p) => p.jointKind === "spring" },
    { key: "pinFirst", label: "Pin First", type: "boolean" },
    { key: "pinLast", label: "Pin Last", type: "boolean" },
    { key: "attachTo", label: "Hangs From", type: "entity" },
    { key: "loop", label: "Close Loop", type: "boolean" },
    { key: "linkCollision", label: "Links Collide", type: "boolean" },
    { key: "createBodies", label: "Create Bodies", type: "boolean", showIf: (p) => p.source === "children" },
    { key: "linkShape", label: "Link Shape", type: "select", options: ["auto", "box", "sphere", "capsule", "convex"], showIf: (p) => p.source === "instances" },
    { key: "linkMass", label: "Link Mass (kg)", type: "number", min: 0.001, step: 0.1 },
    { key: "layer", label: "Layer", type: "select", options: physicsLayerNames, showIf: (p) => p.source === "instances" },
    { key: "friction", label: "Friction", type: "number", min: 0, max: 2, step: 0.05, showIf: (p) => p.source === "instances" },
    { key: "restitution", label: "Bounciness", type: "number", min: 0, max: 1, step: 0.05, showIf: (p) => p.source === "instances" },
    { key: "linearDamping", label: "Lin. Damping", type: "number", min: 0, step: 0.05 },
    { key: "angularDamping", label: "Ang. Damping", type: "number", min: 0, step: 0.05 },
  ];

  onAttach() {
    /** @type {any[]} One entry per link while playing: { body, entity?, index? }. */
    this.links = [];
    this._rig = null;
    this._addedBodies = [];
    this.entity.engine?.physics?.registerRig(this);
  }

  onDetach() {
    this.entity?.engine?.physics?.unregisterRig(this);
    this.links = [];
  }

  onPropChanged() {
    // Every property here changes the SHAPE of the rig (which links, which
    // joint, where the anchors are), so the honest response to any of them is
    // to build it again. Cheap: a chain is tens of bodies, not a scene.
    this.rebuild();
  }

  onDisable() {
    this.clearRig();
  }

  onEnable() {
    this.entity?.engine?.physics?.registerRig(this);
    this.rebuild();
  }

  /** Tears the chain down and builds it again from the current props. */
  rebuild() {
    const physics = this.entity?.engine?.physics;
    if (!physics?.world) return false;
    this.clearRig();
    this.buildRig(physics);
    return true;
  }

  /* ---- rig contract (see rig.js) ----------------------------------------- */

  buildRig(physics) {
    if (!this.enabled || !physics.world) return;
    this._rig = new PhysicsRig(physics, this.entity);
    this.links = this.props.source === "instances"
      ? this.#buildInstanceLinks(physics)
      : this.#buildChildLinks(physics);
    if (this.links.length < 2) {
      if (this.links.length) {
        console.warn(`Chain on "${this.entity.name}": needs at least two links, found ${this.links.length}.`);
      }
      return;
    }
    this.#connect(physics);
  }

  clearRig() {
    this._rig?.clear();
    this._rig = null;
    // Bodies this chain added to link entities are its own doing and must not
    // outlive it — a second Play would otherwise find them already there and
    // treat them as authored.
    for (const entity of this._addedBodies) {
      if (entity.getComponent?.("rigidbody")) entity.removeComponent("rigidbody");
    }
    this._addedBodies = [];
    this.links = [];
  }

  syncRig() {
    if (this.props.source !== "instances" || !this.links.length) return;
    const instanced = this.#instancedMesh();
    if (!instanced) return;
    // A chain that has stopped swinging is asleep in Rapier; re-writing the
    // same matrices (and recomputing the bounding sphere) every frame for a
    // rope that is not moving is pure waste.
    if (this.links.every((link) => link.body.isSleeping())) return;
    // Instance matrices live in the InstancedMesh's own space, so each body's
    // world pose has to come back through it — the mesh may be parented to the
    // entity (the usual case) or to the scene (a scatter over another entity).
    _inverse.copy(instanced.matrixWorld).invert();
    for (const link of this.links) {
      const translation = link.body.translation();
      const rotation = link.body.rotation();
      _position.set(translation.x, translation.y, translation.z);
      _quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      _matrix.compose(_position, _quaternion, link.scale);
      _matrix.premultiply(_inverse);
      instanced.setMatrixAt(link.index, _matrix);
    }
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere?.();
  }

  /* ---- links ------------------------------------------------------------- */

  #instancedMesh() {
    const instancer = this.entity.getComponent("instancer");
    return instancer?.instancedMesh ?? null;
  }

  /** Child entities, in order, each with a body to join. */
  #buildChildLinks(physics) {
    const links = [];
    for (const child of this.entity.children) {
      if (!child.enabled) continue;
      // ⚠ A BODY IS NOT ENOUGH — IT HAS TO BE A DYNAMIC ONE. A link with a
      // Collider and no Rigidbody already HAS a body: the static one every
      // collider-only entity gets. Joint five of those together and the chain
      // is built, holds, and never moves — which reads as "the joints did
      // nothing" rather than as "the links are level geometry".
      let body = physics.bodyByEntity.get(child);
      if (body && !body.isDynamic() && this.props.createBodies) {
        physics.removeEntity(child, { subtree: false });
        body = null;
      }
      if (!body && this.props.createBodies) {
        child.addComponent("rigidbody", {
          bodyType: "dynamic",
          mass: this.props.linkMass,
          linearDamping: this.props.linearDamping,
          angularDamping: this.props.angularDamping,
        });
        this._addedBodies.push(child);
        // Builds the body (and any collider the child already had) now: the
        // joints below need both ends to exist before the next step.
        physics.addEntity(child);
        body = physics.bodyByEntity.get(child);
      }
      if (!body?.isDynamic()) {
        console.warn(
          `Chain on "${this.entity.name}": link "${child.name}" has no dynamic Rigidbody and Create Bodies is off.`,
        );
        continue;
      }
      links.push({ body, entity: child });
    }
    return links;
  }

  /** One body per Instancer instance, with a collider matching the source mesh. */
  #buildInstanceLinks(physics) {
    const instanced = this.#instancedMesh();
    if (!instanced) {
      console.warn(`Chain on "${this.entity.name}": "instances" needs an Instancer component with a built mesh.`);
      return [];
    }
    const instancer = this.entity.getComponent("instancer");
    if (instancer?.props.motion) {
      console.warn(
        `Chain on "${this.entity.name}": the Instancer's Motion also writes instance matrices every frame, so the ` +
          "chain and the motion will fight over them. Turn Motion off.",
      );
    }
    instanced.updateMatrixWorld(true);
    const rig = this._rig;
    const links = [];
    const colliders = [];
    for (let i = 0; i < instanced.count; i++) {
      instanced.getMatrixAt(i, _matrix);
      _matrix.premultiply(instanced.matrixWorld);
      _matrix.decompose(_position, _quaternion, _scale);
      const body = rig.dynamicBody(_position, _quaternion, {
        linearDamping: this.props.linearDamping,
        angularDamping: this.props.angularDamping,
      });
      const desc = this.#linkColliderDesc(physics, instanced.geometry, _scale);
      if (desc) {
        desc.setFriction(this.props.friction).setRestitution(this.props.restitution).setMass(this.props.linkMass);
        colliders.push(rig.collider(desc, body, { layer: this.props.layer }));
      } else {
        // No shape means no mass, and a massless dynamic body never moves —
        // the failure that looks like "physics is off". See applyColliderMass.
        body.setAdditionalMass(this.props.linkMass, false);
      }
      links.push({ body, index: i, scale: _scale.clone() });
    }
    return links;
  }

  /** The shape one instance gets, sized from the instanced geometry. */
  #linkColliderDesc(physics, geometry, scale) {
    const { RAPIER } = physics;
    geometry.computeBoundingBox?.();
    const box = geometry.boundingBox;
    if (!box) return null;
    box.getSize(_size);
    const half = {
      x: Math.max((_size.x * Math.abs(scale.x)) / 2, 1e-3),
      y: Math.max((_size.y * Math.abs(scale.y)) / 2, 1e-3),
      z: Math.max((_size.z * Math.abs(scale.z)) / 2, 1e-3),
    };
    const shape = this.props.linkShape === "auto"
      ? ((geometry.getAttribute("position")?.count ?? 0) <= 2000 ? "convex" : "box")
      : this.props.linkShape;
    if (shape === "sphere") return RAPIER.ColliderDesc.ball(Math.max(half.x, half.y, half.z));
    if (shape === "capsule") {
      const radius = Math.max(half.x, half.z);
      return RAPIER.ColliderDesc.capsule(Math.max(half.y - radius, 1e-3), radius);
    }
    if (shape === "convex") {
      const position = geometry.getAttribute("position");
      if (position) {
        const points = new Float32Array(position.count * 3);
        for (let i = 0; i < position.count; i++) {
          points[i * 3] = position.getX(i) * scale.x;
          points[i * 3 + 1] = position.getY(i) * scale.y;
          points[i * 3 + 2] = position.getZ(i) * scale.z;
        }
        const hull = RAPIER.ColliderDesc.convexHull(points);
        if (hull) return hull;
      }
    }
    return RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z);
  }

  /* ---- joints ------------------------------------------------------------ */

  #connect(physics) {
    const last = this.links.length - 1;
    for (let i = 0; i < last; i++) this.#link(physics, this.links[i].body, this.links[i + 1].body);
    if (this.props.loop && this.links.length > 2) this.#link(physics, this.links[last].body, this.links[0].body);

    // The ends. `attachTo`'s body when there is one, otherwise a fixed body at
    // the link's own position — which is what makes a chain HANG rather than
    // drop to the floor as one long noodle.
    const anchorEntity = this.props.attachTo ? this.entity.engine.getEntity(this.props.attachTo) : null;
    const anchorBody = anchorEntity ? physics.bodyByEntity.get(anchorEntity) : null;
    if (anchorEntity && !anchorBody) {
      console.warn(`Chain on "${this.entity.name}": "${anchorEntity.name}" has no Rigidbody to hang from.`);
    }
    if (this.props.pinFirst) this.#pin(physics, this.links[0].body, anchorBody);
    if (this.props.pinLast) this.#pin(physics, this.links[last].body, anchorBody);
  }

  /** One joint between two neighbouring links, anchored at their midpoint. */
  #link(physics, bodyA, bodyB) {
    const { RAPIER } = physics;
    const ta = bodyA.translation();
    const tb = bodyB.translation();
    const gap = Math.hypot(tb.x - ta.x, tb.y - ta.y, tb.z - ta.z);
    _position.set((ta.x + tb.x) / 2, (ta.y + tb.y) / 2, (ta.z + tb.z) / 2);
    this.#localAnchor(bodyA, _position, _anchorA);
    this.#localAnchor(bodyB, _position, _anchorB);

    const kind = this.props.jointKind;
    let data;
    if (kind === "hinge") {
      // The authored axis is a WORLD direction (an author points at "the pins
      // run along Z"), while Rapier wants it in each body's own frame — which
      // for a chain that curves is a different vector per link.
      const rotation = bodyA.rotation();
      _quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w).invert();
      _axis.fromArray(this.props.axis.some?.((n) => n !== 0) ? this.props.axis : [0, 0, 1]).normalize().applyQuaternion(_quaternion);
      data = RAPIER.JointData.revolute(v3(_anchorA), v3(_anchorB), v3(_axis));
    } else if (kind === "fixed") {
      data = RAPIER.JointData.fixed(v3(_anchorA), { x: 0, y: 0, z: 0, w: 1 }, v3(_anchorB), { x: 0, y: 0, z: 0, w: 1 });
    } else if (kind === "rope") {
      data = RAPIER.JointData.rope(Math.max(gap + this.props.slack, 1e-4), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    } else if (kind === "spring") {
      data = RAPIER.JointData.spring(gap + this.props.slack, this.props.stiffness, this.props.damping, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    } else {
      // Ball, the default: the anchors are pulled apart by `slack` along the
      // chain so a loose chain rattles instead of behaving like a rigid rod.
      if (this.props.slack > 0) {
        // ⚠ IN EACH BODY'S OWN FRAME. The anchors are local, so a world-space
        // offset added to them slides the joint sideways on any link that is
        // rotated — which on a hanging chain is all of them below the first.
        const half = this.props.slack / 2;
        const along = _axis.set(tb.x - ta.x, tb.y - ta.y, tb.z - ta.z).normalize().multiplyScalar(half);
        const ra = bodyA.rotation();
        const rb = bodyB.rotation();
        _anchorA.add(along.clone().applyQuaternion(_quaternion.set(ra.x, ra.y, ra.z, ra.w).invert()));
        _anchorB.sub(along.clone().applyQuaternion(_quaternion.set(rb.x, rb.y, rb.z, rb.w).invert()));
      }
      data = RAPIER.JointData.spherical(v3(_anchorA), v3(_anchorB));
    }
    this._rig.joint(data, bodyA, bodyB, this.props.linkCollision);
  }

  /** Fixes one end of the chain to another body, or to the world. */
  #pin(physics, body, anchorBody) {
    const { RAPIER } = physics;
    const translation = body.translation();
    _position.set(translation.x, translation.y, translation.z);
    this.#localAnchor(body, _position, _anchorA);
    const target = anchorBody ?? this._rig.fixedBody(_position);
    this.#localAnchor(target, _position, _anchorB);
    this._rig.joint(RAPIER.JointData.spherical(v3(_anchorA), v3(_anchorB)), body, target, false);
  }

  /** A world point in a body's local frame. */
  #localAnchor(body, worldPoint, out) {
    const translation = body.translation();
    const rotation = body.rotation();
    out.set(worldPoint.x - translation.x, worldPoint.y - translation.y, worldPoint.z - translation.z);
    _quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w).invert();
    return out.applyQuaternion(_quaternion);
  }
}
