import * as THREE from "three/webgpu";
import { instancedArray, uniform } from "three/tsl";

const MAX_COLLIDERS = 64;
// 4 vec4 rows per collider: [type, cx, cy, cz], [right.xyz, halfX|radius], [up.xyz, halfY], [fwd.xyz, halfZ]
const FLOATS_PER_COLLIDER = 16;

const TYPE_BOX = 0;
const TYPE_SPHERE = 1;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _offset = new THREE.Vector3();

/**
 * Per-engine singleton that gathers every `ColliderComponent` in the scene
 * into a small GPU storage buffer each frame, so particle systems can test
 * against them in a compute shader without any dependency on Rapier/the
 * physics module. Only analytic shapes are supported (box, sphere; capsule
 * is approximated as a sphere at its center) — trimesh colliders are
 * skipped, since compute-shader BVH traversal is out of scope.
 *
 * Lazily created on first use (`entity.engine.particleColliders ??= ...`)
 * and only does work while at least one particle system has requested it.
 */
export class ParticleColliderField {
  constructor(engine) {
    this.engine = engine;
    this.data = new Float32Array(MAX_COLLIDERS * FLOATS_PER_COLLIDER);
    this.buffer = instancedArray(this.data, "vec4");
    this.countUniform = uniform(0, "int");
    this.activeUsers = 0;
  }

  /** Called by a ParticleComponent when a system with sceneCollision attaches/detaches. */
  addUser() {
    this.activeUsers++;
  }

  removeUser() {
    this.activeUsers = Math.max(0, this.activeUsers - 1);
  }

  dispose() {
    if (this.engine.particleColliders === this) delete this.engine.particleColliders;
  }

  /** Upload the current scene colliders immediately before particle compute. */
  refresh() {
    if (this.activeUsers <= 0) return;
    let count = 0;
    for (const entity of this.engine.entities.values()) {
      if (count >= MAX_COLLIDERS) break;
      const col = entity.getComponent?.("collider");
      if (!col || col.enabled === false) continue;
      const { shape } = col.props;
      if (shape !== "box" && shape !== "sphere" && shape !== "capsule") continue; // mesh: unsupported

      entity.object3D.updateWorldMatrix(true, false);
      entity.object3D.getWorldPosition(_pos);
      entity.object3D.getWorldQuaternion(_quat);
      entity.object3D.getWorldScale(_scale);
      _right.set(1, 0, 0).applyQuaternion(_quat);
      _up.set(0, 1, 0).applyQuaternion(_quat);
      _fwd.set(0, 0, 1).applyQuaternion(_quat);

      const base = count * FLOATS_PER_COLLIDER;
      const offset = col.props.offset ?? [0, 0, 0];
      // Collider offsets are entity-local, so scale and rotate them before
      // adding the entity's world position.
      _offset.fromArray(offset).multiply(_scale).applyQuaternion(_quat).add(_pos);
      const cx = _offset.x;
      const cy = _offset.y;
      const cz = _offset.z;

      if (shape === "box") {
        const size = col.props.size ?? [1, 1, 1];
        this.data.set(
          [
            TYPE_BOX, cx, cy, cz,
            _right.x, _right.y, _right.z, (size[0] / 2) * _scale.x,
            _up.x, _up.y, _up.z, (size[1] / 2) * _scale.y,
            _fwd.x, _fwd.y, _fwd.z, (size[2] / 2) * _scale.z,
          ],
          base,
        );
      } else {
        // sphere or capsule (approximated as a sphere at its center).
        const radius = (col.props.radius ?? 0.5) * Math.max(_scale.x, _scale.y, _scale.z);
        this.data.set(
          [TYPE_SPHERE, cx, cy, cz, 0, 0, 0, radius, 0, 0, 0, radius, 0, 0, 0, radius],
          base,
        );
      }
      count++;
    }
    this.countUniform.value = count;
    this.buffer.value.needsUpdate = true;
  }
}

export const PARTICLE_COLLIDER_TYPE_BOX = TYPE_BOX;
export const PARTICLE_COLLIDER_TYPE_SPHERE = TYPE_SPHERE;
export const PARTICLE_COLLIDER_MAX = MAX_COLLIDERS;
