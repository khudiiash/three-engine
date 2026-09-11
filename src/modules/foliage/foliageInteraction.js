import * as THREE from "three/webgpu";
import { writeParticleCollider } from "../../engine/particleColliders.js";
import { FOLIAGE_INTERACTION_LIMIT } from "./foliageMaterial.js";

const fields = new WeakMap();
const scratchPosition = new THREE.Vector3();

function active(entity, playing) {
  for (let node = entity; node; node = node.parent) {
    if (node.enabled === false || node[playing ? "enabledInGame" : "enabledInEditor"] === false) return false;
  }
  return true;
}

/** One registry scan per engine every half second, shared by all foliage
 * components. Only the nearest eight actors enter the vertex uniforms. */
export function updateFoliageInteractions(engine, uniforms, cameraPosition, time, enabled) {
  for (const row of uniforms.colliders) row.center.value.w = 0;
  if (!enabled || !engine) return 0;
  let field = fields.get(engine);
  if (!field) fields.set(engine, field = { candidates: [], scanned: -Infinity, packed: new Float32Array(16 * FOLIAGE_INTERACTION_LIMIT), count: 0 });
  // Component clocks have different ages and pause independently. A shared
  // registry must use one engine-independent monotonic clock instead.
  const now = performance.now() / 1000;
  if (now - field.scanned >= .5) {
    field.scanned = now;
    field.frame = null;
    field.candidates = [];
    for (const entity of engine.entities?.values?.() ?? []) {
      const collider = entity.getComponent?.("collider");
      const character = entity.getComponent?.("charactercontroller");
      if (collider || character) field.candidates.push({ entity, collider, character });
    }
  }
  const frame = engine.renderer?.info?.frame;
  const sameFrame = Number.isFinite(frame) && frame === field.frame && cameraPosition.equals(field.camera);
  if (!sameFrame) {
  const nearest = [];
  for (const candidate of field.candidates) {
    const { entity } = candidate;
    if (!active(entity, engine.playing) || (engine.getEntity && engine.getEntity(entity.id) !== entity)) continue;
    const character = entity.getComponent?.("charactercontroller");
    let collider = entity.getComponent?.("collider");
    if (character?.enabled !== false && character) collider = { enabled: true, props: { ...character.props, shape: "capsule", autoFit: false, autoCenter: false } };
    if (!collider || collider.enabled === false || collider.props.isSensor) continue;
    if (!["box", "sphere", "capsule", "convex"].includes(collider.props.shape ?? "box")) continue;
    entity.object3D.getWorldPosition(scratchPosition);
    const distance = scratchPosition.distanceToSquared(cameraPosition);
    let index = nearest.findIndex(item => distance < item.distance);
    if (index < 0) index = nearest.length;
    if (index < FOLIAGE_INTERACTION_LIMIT) {
      nearest.splice(index, 0, { entity, collider, distance });
      if (nearest.length > FOLIAGE_INTERACTION_LIMIT) nearest.pop();
    }
  }
  const data = field.packed;
  let count = 0;
  for (const { entity, collider } of nearest) {
    if (!writeParticleCollider(entity, collider, data, count * 16)) continue;
    count++;
  }
  field.count = count;
  field.frame = frame;
  field.camera ??= new THREE.Vector3();
  field.camera.copy(cameraPosition);
  }
  for (let i = 0; i < field.count; i++) {
    const base = i * 16, row = uniforms.colliders[i], data = field.packed;
    row.center.value.set(data[base + 1], data[base + 2], data[base + 3], data[base] + 1);
    row.x.value.fromArray(data, base + 4);
    row.y.value.fromArray(data, base + 8);
    row.z.value.fromArray(data, base + 12);
  }
  return field.count;
}
