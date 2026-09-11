import * as THREE from "three/webgpu";
import { getArchitectureTerrainGroups, translateArchitectureTerrainGroup } from "./terrainFormGroups.js";
import { captureTerrainSurface, highestTerrainUnderGroup, terrainDirtyWorldBounds } from "./terrainSurface.js";

const EPS = 1e-5;
const matrixKey = object => { object.updateWorldMatrix(true, false); return object.matrixWorld.elements.join(","); };
const enabled = component => component.enabled !== false && component.props.followTerrain !== false && component.entity.activeInHierarchy !== false;
const overlapsXZ = (a, b) => a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.z <= b.max.z && a.max.z >= b.min.z;
const sampleBounds = samples => new THREE.Box3().setFromPoints(samples.map(point => new THREE.Vector3(...point)));
const pieceOf = entity => entity.getComponent?.("architecturepiece") ?? entity.getComponent?.("blockout");

/** Follows terrain as derived scene state. Clearance is persisted; sculpt
 * history owns only the terrain, so its undo restores every connected building
 * without manufacturing additional editor commands or accumulating offsets. */
export class ArchitectureTerrainSystem {
  constructor(engine) {
    this.engine = engine;
    this.records = new Map(); this.surfaces = new Map(); this.changes = new Map(); this.errors = new Map();
    this.raycaster = new THREE.Raycaster(); this.dirty = true; this.reconcile = true; this.lastPoll = -Infinity; this.applying = false;
    this.unsub = [
      engine.on?.("terrain-surface-changed", event => this._surfaceChanged(event)),
      engine.on?.("component-changed", event => this._componentChanged(event)),
      engine.on?.("component-added", event => {
        this.reconcile = this.dirty = true;
        const entity = engine.getEntity(event?.entityId);
        if (event?.componentType === "architecture") this._register(entity?.getComponent("architecture"));
        if (event?.componentType === "terrain") this._surfaceChanged({ entityId: entity.id, component: entity.getComponent("terrain"), phase: "committed" });
        if (["architecturepiece", "blockout"].includes(event?.componentType)) this._legacyChanged(entity);
      }),
      engine.on?.("component-removed", event => { this.reconcile = this.dirty = true; this._legacyChanged(engine.getEntity(event?.entityId)); }),
      engine.on?.("hierarchy-changed", () => { if (!this.applying) this.reconcile = this.dirty = true; }),
      engine.on?.("play-changed", () => { this.reconcile = this.dirty = true; }),
      engine.onPreRender?.(() => this.update()),
    ];
    this.update({ force: true });
  }

  _surfaceChanged(event) {
    const terrain = event?.component ?? this.engine.getEntity(event?.entityId)?.getComponent("terrain");
    const surface = captureTerrainSurface(terrain);
    if (!surface) { this.surfaces.delete(event?.entityId); this.dirty = true; return; }
    const id = terrain.entity.id, previous = this.changes.get(id), bounds = terrainDirtyWorldBounds(surface, event?.rect);
    if (previous) bounds.union(previous.bounds);
    this.surfaces.set(id, surface);
    this.changes.set(id, { bounds, committed: event?.phase !== "preview" || !!previous?.committed });
    this.dirty = true;
  }

  _componentChanged(event) {
    if (!event || this.applying || event.terrainFollowing) return;
    const entity = this.engine.getEntity(event.entityId);
    if (event.componentType === "terrain" && ["heights", "size", "resolution", "enabled", "editorEnabled"].includes(event.key)) {
      // Native Terrain heights emit a dedicated event, including script commits.
      // The command's same-string echo must not widen its already queued rect.
      if (event.key !== "heights" || !this.changes.has(event.entityId)) this._surfaceChanged({ entityId: event.entityId, phase: "committed" });
    } else if (event.componentType === "architecture") {
      const component = entity?.getComponent("architecture"); this._register(component);
      const record = this.records.get(component);
      if (record && ["model", "terrainId", "generatedRootId"].includes(event.key)) record.recapture = true;
      this.dirty = true;
    } else if (["architecturepiece", "blockout"].includes(event.componentType)) {
      for (let node = entity; node; node = node.parent) {
        const record = this.records.get(node.getComponent?.("architecture"));
        if (record) { record.recapture = true; break; }
      }
      this.dirty = true;
    }
  }

  _legacyChanged(entity) {
    for (let node = entity; node; node = node.parent) {
      const record = this.records.get(node.getComponent?.("architecture"));
      if (record && !record.component.props.model) { record.recapture = true; return; }
    }
  }

  _register(component) {
    if (!component || this.records.has(component)) return;
    const record = { component, model: component.props.model, matrix: matrixKey(component.entity.object3D), groups: [], recapture: false, needsApply: true, pending: new Set(), active: enabled(component) };
    this.records.set(component, record);
    // Capture before the first brush dab even if creation and sculpt happen in
    // the same frame. Existing saved bindings remain authoritative on reload.
    this._capture(record, { prune: false });
  }

  _legacyGroups(component) {
    const generated = this.engine.getEntity(component.props.generatedRootId);
    const entities = generated?.children?.length ? generated.children : [component.entity];
    return entities.flatMap(entity => {
      const bounds = new THREE.Box3();
      entity.traverse(node => {
        const piece = pieceOf(node), mesh = piece?.mesh ?? node.getComponent?.("mesh")?.mesh;
        if (!mesh || !piece || piece.enabled === false || !mesh.geometry?.attributes.position?.count) return;
        mesh.updateWorldMatrix(true, false); mesh.geometry.computeBoundingBox();
        bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
      });
      if (bounds.isEmpty()) return [];
      const baseWorldY = entity.object3D.getWorldPosition(new THREE.Vector3()).y;
      const samplesWorldXYZ = [];
      for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) samplesWorldXYZ.push([THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, x / 4), baseWorldY, THREE.MathUtils.lerp(bounds.min.z, bounds.max.z, z / 4)]);
      return [{ key: `entity:${entity.id}`, entity, formIds: [], baseWorldY, samplesWorldXYZ }];
    });
  }

  _groups(record) {
    const { component } = record, object = component.entity.object3D;
    object.updateWorldMatrix(true, false);
    return component.props.model ? getArchitectureTerrainGroups(component.props.model, object.matrixWorld) : this._legacyGroups(component);
  }

  _height(component, group, binding = null) {
    const targetId = component.props.terrainId || component.props.settings?.terrainId || binding?.terrainId;
    const surfaces = targetId ? [this.surfaces.get(targetId)].filter(Boolean) : [...this.surfaces.values()];
    let highest = null, terrainId = null;
    const bounds = group.bounds ?? sampleBounds(group.samplesWorldXYZ);
    for (const surface of surfaces) {
      if (!overlapsXZ(bounds, surface.bounds)) continue;
      const height = highestTerrainUnderGroup(surface, group, this.raycaster);
      if (height !== null && Number.isFinite(height) && (highest === null || height > highest)) { highest = height; terrainId = surface.terrain.entity.id; }
    }
    return highest === null ? null : { height: highest, terrainId };
  }

  _capture(record, { rebuild = true, prune = true } = {}) {
    const { component } = record;
    const groups = rebuild ? this._groups(record) : record.groups, previousBindings = component.props.terrainBindings ?? {}, bindings = { ...previousBindings }, keys = new Set();
    let changed = false;
    for (const group of groups) {
      group.bounds ??= sampleBounds(group.samplesWorldXYZ);
      keys.add(group.key);
      const previous = bindings[group.key], membership = group.formIds.join("\0");
      if (record.recapture || !previous || !Number.isFinite(previous.offset) || !Number.isFinite(previous.referenceTerrainHeight) || (previous.formIds ?? []).join("\0") !== membership) {
        const hit = this._height(component, group, record.recapture ? null : previous);
        if (hit) {
          const retainOffset = !record.recapture && previous && Number.isFinite(previous.offset) && (previous.formIds ?? []).join("\0") === membership;
          const offset = retainOffset ? previous.offset : group.baseWorldY - hit.height;
          const value = { offset, terrainId: hit.terrainId, formIds: [...group.formIds], referenceTerrainHeight: group.baseWorldY - offset };
          if (component.props.model) {
            const members = new Set(group.formIds);
            value.positions = Object.fromEntries(component.props.model.forms.filter(form => members.has(form.id)).map(form => [form.id, [...form.position]]));
            value.openings = Object.fromEntries(component.props.model.openings.filter(opening => members.has(opening.formId)).map(opening => [opening.id, [...opening.position]]));
          } else value.referencePosition = group.entity.object3D.position.toArray();
          bindings[group.key] = value; changed = true;
        }
      }
      if (group.entity) group.pose = matrixKey(group.entity.object3D);
    }
    if (prune) for (const key of Object.keys(bindings)) if (!keys.has(key)) { delete bindings[key]; changed = true; }
    if (changed) component.props.terrainBindings = bindings;
    record.groups = groups; record.model = component.props.model; record.matrix = matrixKey(component.entity.object3D);
    record.recapture = false;
  }

  _discover() {
    const live = new Set(), terrains = new Set();
    for (const entity of this.engine.entities?.values?.() ?? []) {
      const terrain = entity.getComponent?.("terrain");
      if (terrain?.mesh && terrain.enabled !== false && entity.activeInHierarchy !== false) {
        terrains.add(entity.id);
        const previous = this.surfaces.get(entity.id);
        if (!previous || previous.terrain !== terrain || previous.matrix.elements.join(",") !== matrixKey(terrain.mesh) || previous.revision !== (terrain._surfaceRevision ?? 0)) this._surfaceChanged({ entityId: entity.id, component: terrain, phase: "committed" });
      }
    }
    for (const id of this.surfaces.keys()) if (!terrains.has(id)) this.surfaces.delete(id);
    for (const entity of this.engine.entities?.values?.() ?? []) {
      const component = entity.getComponent?.("architecture");
      if (component) { live.add(component); this._register(component); }
    }
    for (const component of this.records.keys()) if (!live.has(component)) { this.records.delete(component); this.errors.delete(component.entity.id); }
  }

  _commit(record) {
    const { component } = record;
    if (!record.pending.size && !component._terrainPreviewDirty) return;
    // Removal/scene teardown may precede the next reconciliation frame. Never
    // rebuild a detached component and resurrect its already disposed mesh.
    if (component._attached === false || this.engine.getEntity(component.entity.id) !== component.entity || component.entity.getComponent("architecture") !== component) { record.pending.clear(); return; }
    this.applying = true;
    try {
      if (component.props.model) component.applyTerrainModel(component.props.model, { preview: false });
      else {
        for (const group of record.groups) if (group.entity) this.engine.physics?.markDirty?.(group.entity, { subtree: true });
        this.engine.emit?.("hierarchy-changed");
      }
    } finally { this.applying = false; }
    record.pending.clear(); record.model = component.props.model;
  }

  /** Called from pre-render; force is useful after synchronous imports/tests. */
  update({ force = false } = {}) {
    if (this.disposed || this.applying) return;
    const now = performance.now(), poll = force || now - this.lastPoll >= 200;
    if (!poll && !this.dirty && !this.reconcile) return;
    if (poll || this.reconcile) { this._discover(); this.lastPoll = now; this.reconcile = false; }
    const changes = new Map(this.changes); this.changes.clear(); this.dirty = false;
    for (const record of this.records.values()) {
      const { component } = record;
      try {
        const active = enabled(component);
        if (!active) { this._commit(record); record.active = false; continue; }
        if (!record.active) { record.recapture = true; record.active = true; }
        if (record.model !== component.props.model || record.matrix !== matrixKey(component.entity.object3D) || record.groups.some(group => group.entity && group.pose !== matrixKey(group.entity.object3D))) record.recapture = true;
        const authored = record.recapture;
        if (authored) this._capture(record);
        else if (changes.size && record.groups.some(group => !component.props.terrainBindings?.[group.key])) this._capture(record, { rebuild: false });
        // Authored repositioning establishes new clearance. A terrain edit
        // applies the saved absolute relationship; it never recaptures itself.
        if (authored) { record.needsApply = false; this._commit(record); continue; }
        let nextModel = component.props.model, moved = false, committed = false;
        for (const group of record.groups) {
          const binding = component.props.terrainBindings?.[group.key];
          if (!binding) continue;
          const change = changes.get(binding.terrainId), bounds = group.bounds;
          const affected = record.needsApply || (change && overlapsXZ(bounds, change.bounds));
          if (change?.committed && record.pending.has(binding.terrainId)) committed = true;
          if (!affected) continue;
          const hit = this._height(component, group, binding);
          if (!hit) continue;
          const delta = hit.height + binding.offset - group.baseWorldY;
          if (Math.abs(delta) <= EPS) continue;
          committed ||= !change || change.committed;
          record.pending.add(hit.terrainId); moved = true;
          if (nextModel) {
            // Derive each pose from the saved baseline, not accumulated deltas.
            // Returning terrain to its original heights restores exact numbers.
            const anchored = { ...nextModel,
              forms: nextModel.forms.map(form => binding.positions?.[form.id] ? { ...form, position: binding.positions[form.id] } : form),
              openings: nextModel.openings.map(opening => binding.openings?.[opening.id] ? { ...opening, position: binding.openings[opening.id] } : opening) };
            nextModel = translateArchitectureTerrainGroup(anchored, group.formIds, hit.height - binding.referenceTerrainHeight, component.entity.object3D.matrixWorld);
          }
          else {
            const object = group.entity.object3D, point = new THREE.Vector3(...binding.referencePosition);
            if (object.parent) object.parent.localToWorld(point);
            point.y += hit.height - binding.referenceTerrainHeight;
            if (object.parent) object.parent.worldToLocal(point);
            object.position.copy(point); object.updateWorldMatrix(true, true);
          }
          group.baseWorldY += delta;
          const points = new Set([...group.samplesWorldXYZ, ...(group.foundationPolygonsWorldXYZ ?? []).flat()]);
          for (const point of points) point[1] += delta;
        }
        if (moved && nextModel) {
          this.applying = true;
          try { component.applyTerrainModel(nextModel, { preview: !committed }); } finally { this.applying = false; }
          if (committed) record.pending.clear();
        } else if (moved && !committed) this.engine.emit?.("architecture-terrain-preview", { entityId: component.entity.id });
        if (committed) this._commit(record);
        record.needsApply = false; record.model = component.props.model;
        record.matrix = matrixKey(component.entity.object3D);
        for (const group of record.groups) if (group.entity) group.pose = matrixKey(group.entity.object3D);
        this.errors.delete(component.entity.id);
      } catch (error) {
        this.errors.set(component.entity.id, error.message);
        this.engine.emit?.("architecture-terrain-error", { entityId: component.entity.id, message: error.message });
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    for (const record of this.records.values()) this._commit(record);
    this.disposed = true;
    for (const unsub of this.unsub) unsub?.();
    this.records.clear(); this.surfaces.clear(); this.changes.clear(); this.errors.clear();
  }
}
