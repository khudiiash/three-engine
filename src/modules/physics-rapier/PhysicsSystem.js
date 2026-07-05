import * as THREE from "three/webgpu";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _parentQuat = new THREE.Quaternion();
const _mat = new THREE.Matrix4();

/**
 * Owns the Rapier world. Lifecycle mirrors play mode: the world is built
 * from the entity tree when playing starts and freed when it stops (the
 * editor restores its scene snapshot anyway). While playing it steps on a
 * fixed timestep, drives kinematic bodies from entity transforms, writes
 * dynamic body transforms back to entities, and dispatches collision events
 * to script hooks (onCollisionEnter/Exit, onTriggerEnter/Exit).
 *
 * Exposed as `engine.physics` for scripts:
 *   this.engine.physics.raycast(origin, direction, maxDistance) →
 *     { entity, point, normal, distance } | null
 *   this.engine.physics.setGravity([x, y, z])
 */
export class PhysicsSystem {
  constructor(engine, RAPIER) {
    this.engine = engine;
    this.RAPIER = RAPIER;
    this.world = null;
    this.eventQueue = null;
    this.gravity = [0, -9.81, 0];
    this.accumulator = 0;
    this.colliderEntity = new Map(); // collider handle -> entity
    this.dynamicBodies = []; // { entity, body }
    this.kinematicBodies = []; // { entity, body }

    this.unsubs = [
      engine.on("play-changed", (playing) => (playing ? this.#build() : this.#teardown())),
      engine.onUpdate((dt) => this.#tick(dt)),
    ];
    engine.physics = this;
    if (engine.playing) this.#build();
  }

  dispose() {
    for (const unsub of this.unsubs) unsub();
    this.#teardown();
    if (this.engine.physics === this) delete this.engine.physics;
  }

  setGravity([x, y, z]) {
    this.gravity = [x, y, z];
    if (this.world) this.world.gravity = new this.RAPIER.Vector3(x, y, z);
  }

  /** World-space ray query against the live physics world (play mode only). */
  raycast(origin, direction, maxDistance = 1000) {
    if (!this.world) return null;
    const dir = _pos.set(direction[0], direction[1], direction[2]).normalize();
    const ray = new this.RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: dir.x, y: dir.y, z: dir.z },
    );
    const hit = this.world.castRayAndGetNormal(ray, maxDistance, false);
    if (!hit) return null;
    const distance = hit.timeOfImpact ?? hit.toi;
    const point = ray.pointAt(distance);
    return {
      entity: this.colliderEntity.get(hit.collider.handle) ?? null,
      point: [point.x, point.y, point.z],
      normal: [hit.normal.x, hit.normal.y, hit.normal.z],
      distance,
    };
  }

  // ---- world build ----

  #build() {
    this.#teardown();
    const { RAPIER } = this;
    this.world = new RAPIER.World({ x: this.gravity[0], y: this.gravity[1], z: this.gravity[2] });
    this.eventQueue = new RAPIER.EventQueue(true);
    this.engine.scene.updateMatrixWorld(true);

    // Pass 1: a body per entity that has a rigidbody, or a static body per
    // collider-only entity with no rigidbody anywhere above it (compound
    // child colliders attach to the ancestor's body in pass 2).
    const bodyByEntity = new Map();
    for (const entity of this.engine.entities.values()) {
      const rb = entity.getComponent("rigidbody");
      const col = entity.getComponent("collider");
      if (!rb && !col) continue;
      if (!rb && this.#ancestorBodyEntity(entity)) continue;

      entity.object3D.getWorldPosition(_pos);
      entity.object3D.getWorldQuaternion(_quat);
      const type = rb?.props.bodyType ?? "fixed";
      const desc = (
        type === "dynamic" ? RAPIER.RigidBodyDesc.dynamic()
        : type === "kinematic" ? RAPIER.RigidBodyDesc.kinematicPositionBased()
        : RAPIER.RigidBodyDesc.fixed()
      )
        .setTranslation(_pos.x, _pos.y, _pos.z)
        .setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
      if (rb && type === "dynamic") {
        desc
          .setLinearDamping(rb.props.linearDamping)
          .setAngularDamping(rb.props.angularDamping)
          .setGravityScale(rb.props.gravityScale)
          .setCcdEnabled(!!rb.props.ccd)
          .enabledRotations(!rb.props.lockRotationX, !rb.props.lockRotationY, !rb.props.lockRotationZ);
      }
      const body = this.world.createRigidBody(desc);
      bodyByEntity.set(entity, body);
      if (rb) {
        rb.body = body;
        if (type === "dynamic") this.dynamicBodies.push({ entity, body });
        else if (type === "kinematic") this.kinematicBodies.push({ entity, body });
      }
    }

    // Pass 2: colliders, attached to their own body or the nearest ancestor's.
    for (const entity of this.engine.entities.values()) {
      const col = entity.getComponent("collider");
      if (!col) continue;
      const bodyEntity = bodyByEntity.has(entity) ? entity : this.#ancestorBodyEntity(entity);
      const body = bodyByEntity.get(bodyEntity);
      if (!body) continue;
      const desc = this.#colliderDesc(col, entity, bodyEntity);
      if (!desc) continue;
      const collider = this.world.createCollider(desc, body);
      col.collider = collider;
      this.colliderEntity.set(collider.handle, entity);
    }
  }

  #ancestorBodyEntity(entity) {
    for (let p = entity.parent; p; p = p.parent) {
      if (p.getComponent("rigidbody")) return p;
    }
    return null;
  }

  #colliderDesc(col, entity, bodyEntity) {
    const { RAPIER } = this;
    const { shape, size, radius, height, offset, friction, restitution, isSensor } = col.props;
    entity.object3D.getWorldScale(_scale);
    const sx = Math.abs(_scale.x), sy = Math.abs(_scale.y), sz = Math.abs(_scale.z);
    const maxS = Math.max(sx, sy, sz);

    let desc = null;
    if (shape === "box") {
      desc = RAPIER.ColliderDesc.cuboid((size[0] / 2) * sx, (size[1] / 2) * sy, (size[2] / 2) * sz);
    } else if (shape === "sphere") {
      desc = RAPIER.ColliderDesc.ball(radius * maxS);
    } else if (shape === "capsule") {
      desc = RAPIER.ColliderDesc.capsule((height / 2) * sy, radius * Math.max(sx, sz));
    } else if (shape === "mesh") {
      const tri = collectTrimesh(entity.object3D);
      if (!tri) {
        console.warn(`Collider on "${entity.name}": mesh shape found no geometry`);
        return null;
      }
      desc = RAPIER.ColliderDesc.trimesh(tri.vertices, tri.indices);
    }
    if (!desc) return null;

    desc
      .setFriction(friction)
      .setRestitution(restitution)
      .setSensor(!!isSensor)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    // A dynamic body's mass comes from its Rigidbody, not shape density.
    const rb = bodyEntity.getComponent("rigidbody");
    if (rb?.props.bodyType === "dynamic" && entity === bodyEntity && rb.props.mass > 0) {
      desc.setMass(rb.props.mass);
    }

    // Collider pose relative to its body (child colliders + local offset).
    _pos.fromArray(shape === "mesh" ? [0, 0, 0] : offset).multiply(_scale);
    _quat.identity();
    if (entity !== bodyEntity) {
      _mat.copy(bodyEntity.object3D.matrixWorld).invert().multiply(entity.object3D.matrixWorld);
      const rel = new THREE.Vector3(), relQ = new THREE.Quaternion(), relS = new THREE.Vector3();
      _mat.decompose(rel, relQ, relS);
      _pos.applyQuaternion(relQ).add(rel);
      _quat.copy(relQ);
    }
    desc.setTranslation(_pos.x, _pos.y, _pos.z).setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
    return desc;
  }

  #teardown() {
    for (const { entity } of [...this.dynamicBodies, ...this.kinematicBodies]) {
      const rb = entity.getComponent("rigidbody");
      if (rb) rb.body = null;
    }
    for (const entity of this.colliderEntity.values()) {
      const col = entity.getComponent("collider");
      if (col) col.collider = null;
    }
    this.dynamicBodies = [];
    this.kinematicBodies = [];
    this.colliderEntity.clear();
    this.accumulator = 0;
    this.eventQueue?.free();
    this.eventQueue = null;
    this.world?.free();
    this.world = null;
  }

  // ---- per-frame stepping ----

  #tick(dt) {
    if (!this.world || !this.engine.playing) return;

    // Kinematic bodies follow their entity (scripts/animations drive them).
    if (this.kinematicBodies.length) this.engine.scene.updateMatrixWorld(true);
    for (const { entity, body } of this.kinematicBodies) {
      entity.object3D.getWorldPosition(_pos);
      entity.object3D.getWorldQuaternion(_quat);
      body.setNextKinematicTranslation({ x: _pos.x, y: _pos.y, z: _pos.z });
      body.setNextKinematicRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
    }

    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * MAX_SUBSTEPS);
    let stepped = false;
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      this.world.timestep = FIXED_DT;
      this.world.step(this.eventQueue);
      stepped = true;
      this.#dispatchEvents();
    }
    if (!stepped) return;

    // Write dynamic body poses back to entities (world -> parent-local).
    for (const { entity, body } of this.dynamicBodies) {
      if (body.isSleeping()) continue;
      const t = body.translation();
      const r = body.rotation();
      const obj = entity.object3D;
      _pos.set(t.x, t.y, t.z);
      _quat.set(r.x, r.y, r.z, r.w);
      if (entity.parent) {
        entity.parent.object3D.updateWorldMatrix(true, false);
        obj.position.copy(_pos).applyMatrix4(_mat.copy(entity.parent.object3D.matrixWorld).invert());
        entity.parent.object3D.getWorldQuaternion(_parentQuat);
        obj.quaternion.copy(_parentQuat.invert().multiply(_quat));
      } else {
        obj.position.copy(_pos);
        obj.quaternion.copy(_quat);
      }
    }
  }

  #dispatchEvents() {
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      const e1 = this.colliderEntity.get(h1);
      const e2 = this.colliderEntity.get(h2);
      if (!e1 || !e2) return;
      const sensor = this.world.getCollider(h1)?.isSensor() || this.world.getCollider(h2)?.isSensor();
      const hook = sensor
        ? (started ? "onTriggerEnter" : "onTriggerExit")
        : (started ? "onCollisionEnter" : "onCollisionExit");
      e1.getComponent("script")?.instance?.[hook]?.(e2);
      e2.getComponent("script")?.instance?.[hook]?.(e1);
      this.engine.emit(sensor ? "trigger" : "collision", { a: e1, b: e2, started });
    });
  }
}

/**
 * Merges every rendered mesh under the entity's Object3D (skipping
 * editor-only helpers) into one trimesh, in the entity's world frame
 * relative to itself — i.e. vertices carry the world scale and child
 * offsets, since Rapier shapes can't scale.
 */
function collectTrimesh(root) {
  const verts = [];
  const indices = [];
  root.updateWorldMatrix(true, false);
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rootScale = new THREE.Vector3();
  root.getWorldScale(rootScale);
  const local = new THREE.Matrix4();
  const v = new THREE.Vector3();

  root.traverse((child) => {
    if (!child.isMesh || !child.geometry?.attributes?.position) return;
    if (child.layers.mask === 1 << EDITOR_LAYER) return; // editor-only helper
    child.updateWorldMatrix(true, false);
    local.copy(invRoot).multiply(child.matrixWorld);
    const pos = child.geometry.attributes.position;
    const base = verts.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(local).multiply(rootScale);
      verts.push(v.x, v.y, v.z);
    }
    const index = child.geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(base + i);
    }
  });

  if (!verts.length) return null;
  return { vertices: new Float32Array(verts), indices: new Uint32Array(indices) };
}
