import * as THREE from "three/webgpu";
import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { instantiateEntity } from "../engine/serialize.js";
import { getComponentClass } from "../engine/components/registry.js";
import { normalizeArchitectureModel } from "../modules/architecture/formModel.js";

const clone = (value) => structuredClone(value);
const batched = (fn) => engine.batchHierarchy ? engine.batchHierarchy(fn) : fn();
const idFor = () => THREE.MathUtils.generateUUID();

export function getArchitectureModelRoot(entityOrId) {
  let entity = typeof entityOrId === "string" ? engine.getEntity(entityOrId) : entityOrId;
  while (entity) {
    if (entity.getComponent?.("architecture")?.props.model) return entity;
    entity = entity.parent;
  }
  return null;
}

function requireModelRoot(entityId) {
  const entity = engine.getEntity(entityId);
  if (!entity?.getComponent("architecture")?.props.model) throw new Error("Select a live Architecture model to edit.");
  return entity;
}

function vec3(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((number) => !Number.isFinite(number) || Math.abs(number) > 1e7)) throw new Error(`${label} must contain three finite coordinates.`);
  return value;
}

function placement({ position = [0, 0, 0], rotation = [0, 0, 0], rotationY, parentId } = {}) {
  const parent = parentId ? engine.getEntity(parentId) : null;
  if (parentId && !parent) throw new Error("The Architecture parent no longer exists.");
  if (rotationY !== undefined) rotation = [0, rotationY, 0];
  const desired = new THREE.Matrix4().compose(new THREE.Vector3(...vec3(position, "Position")), new THREE.Quaternion().setFromEuler(new THREE.Euler(...vec3(rotation, "Rotation"))), new THREE.Vector3(1, 1, 1));
  if (parent) {
    parent.object3D.updateWorldMatrix(true, false);
    if (Math.abs(parent.object3D.matrixWorld.determinant()) < 1e-12) throw new Error("The parent has zero scale.");
    desired.premultiply(parent.object3D.matrixWorld.clone().invert());
  }
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  desired.decompose(p, q, s);
  const actual = new THREE.Matrix4().compose(p, q, s);
  if (desired.elements.some((number, index) => !Number.isFinite(number) || Math.abs(number - actual.elements[index]) > 1e-5)) throw new Error("The parent transform would shear this model. Use uniform parent scale.");
  return { position: p.toArray(), rotation: new THREE.Euler().setFromQuaternion(q).toArray().slice(0, 3).map(value => value === 0 ? 0 : value), scale: s.toArray() };
}

class CreateArchitectureModelCommand {
  constructor(data, parentId) { this.data = clone(data); this.entityId = data.id; this.parentId = parentId ?? null; this.label = `Create ${data.name}`; }
  do() {
    batched(() => {
      const parent = this.parentId ? engine.getEntity(this.parentId) : null;
      if (this.parentId && !parent) throw new Error("The model parent no longer exists.");
      try { instantiateEntity(engine, this.data, parent); }
      catch (error) { const partial = engine.getEntity(this.entityId); if (partial) engine.destroyEntity(partial); throw error; }
    });
  }
  undo() { batched(() => { const entity = engine.getEntity(this.entityId); if (entity) engine.destroyEntity(entity); }); }
}

class SetArchitectureModelCommand {
  constructor(entityId, value, label) {
    this.entityId = entityId; this.value = clone(value); this.label = label;
    this.previous = clone(requireModelRoot(entityId).getComponent("architecture").props.model);
  }
  do() {
    const architecture = requireModelRoot(this.entityId).getComponent("architecture");
    const before = architecture.props.model;
    try { architecture.setProp("model", this.value); }
    catch (error) { architecture.setProp("model", before); throw error; }
  }
  undo() { requireModelRoot(this.entityId).getComponent("architecture").setProp("model", this.previous); }
}

/** A live model is one ordinary Mesh plus its editable source document. */
export function createArchitectureModel({ model = {}, position, rotation, rotationY, parentId = null, name = "Architecture", collision = true, clearFoliage = true, foliagePadding = .2, followTerrain = true, terrainId = "" } = {}) {
  if (!getComponentClass("architecture")) throw new Error("Enable Architecture before creating a model.");
  const normalized = normalizeArchitectureModel(model);
  const transform = placement({ position, rotation, rotationY, parentId });
  const entityId = idFor();
  const components = [
    { type: "mesh", props: { collision: "none", castShadow: true, receiveShadow: true } },
    { type: "architecture", props: { model: normalized, collision: collision !== false, followTerrain: followTerrain !== false, terrainId, settings: { clearFoliage: clearFoliage !== false, foliagePadding, collision: collision !== false } } },
  ];
  if (collision !== false && getComponentClass("collider")) components.push({ type: "collider", props: { shape: "concave", friction: .6, restitution: 0 } });
  const data = { id: entityId, name, ...transform, components, children: [] };
  commandBus.execute(new CreateArchitectureModelCommand(data, parentId));
  return { entityId };
}

/** Compatible with CommandBus beginPreview/endPreview/cancelPreview: every
 * pointer sample is visible, and one committed drag is one history entry. */
export function setArchitectureModel(entityId, model, label = "Edit architecture") {
  requireModelRoot(entityId);
  const normalized = normalizeArchitectureModel(model);
  commandBus.execute(new SetArchitectureModelCommand(entityId, normalized, label));
  return { entityId };
}
export const replaceArchitectureModel = setArchitectureModel;

function rows(entityId) { return clone(requireModelRoot(entityId).getComponent("architecture").props.model); }
function ensureUnique(model, id) {
  if ([...(model.forms ?? []), ...(model.paths ?? []), ...(model.openings ?? [])].some((row) => row.id === id)) throw new Error(`Architecture item "${id}" already exists.`);
}
function addRow(entityId, collection, item, label, returnKey) {
  const model = rows(entityId);
  const id = item.id || idFor();
  ensureUnique(model, id);
  model[collection] ??= [];
  model[collection].push({ ...clone(item), id });
  const normalized = normalizeArchitectureModel(model);
  if (!normalized[collection].some((row) => row.id === id)) throw new Error(`The ${collection} limit was reached.`);
  setArchitectureModel(entityId, normalized, label);
  return { entityId, [returnKey]: id };
}
function updateRow(entityId, collection, id, patch, label, returnKey) {
  const model = rows(entityId), index = model[collection]?.findIndex((row) => row.id === id) ?? -1;
  if (index < 0) throw new Error(`Architecture ${collection} item "${id}" does not exist.`);
  model[collection][index] = { ...model[collection][index], ...clone(patch), id };
  if (collection === "openings" && !model.forms.some((form) => form.id === model[collection][index].formId)) throw new Error("The opening must reference an existing building form.");
  const normalized = normalizeArchitectureModel(model);
  if (!normalized[collection].some((row) => row.id === id)) throw new Error(`Architecture ${collection} item is incomplete.`);
  setArchitectureModel(entityId, normalized, label);
  return { entityId, [returnKey]: id };
}
function removeRow(entityId, collection, id, label, returnKey) {
  const model = rows(entityId), index = model[collection]?.findIndex((row) => row.id === id) ?? -1;
  if (index < 0) throw new Error(`Architecture ${collection} item "${id}" does not exist.`);
  model[collection].splice(index, 1);
  if (collection === "forms") model.openings = (model.openings ?? []).filter((opening) => opening.formId !== id);
  setArchitectureModel(entityId, model, label);
  return { entityId, [returnKey]: id };
}

export function addArchitectureForm(entityId, form = {}, options = {}) {
  if (entityId) return addRow(entityId, "forms", form, "Add building form", "formId");
  const formId = form.id || idFor();
  const result = createArchitectureModel({ ...options, model: { version: 1, cellSize: options.cellSize ?? 3, forms: [{ ...clone(form), id: formId }], paths: [], openings: [] } });
  return { ...result, formId };
}
export function updateArchitectureForm(entityId, formId, patch) {
  const model = rows(entityId), index = model.forms.findIndex((form) => form.id === formId);
  if (index < 0) throw new Error(`Architecture forms item "${formId}" does not exist.`);
  const previous = model.forms[index];
  model.forms[index] = { ...previous, ...clone(patch), id: formId };
  const normalized = normalizeArchitectureModel(model), next = normalized.forms[index];
  if (patch.position || patch.size || patch.rotationY !== undefined) {
    const frame = (form) => new THREE.Matrix4().compose(new THREE.Vector3(...form.position), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), form.rotationY), new THREE.Vector3(...form.size));
    const transform = frame(next).multiply(frame(previous).invert()), normalMatrix = new THREE.Matrix3().getNormalMatrix(transform);
    for (const opening of normalized.openings) if (opening.formId === formId) {
      opening.position = new THREE.Vector3(...opening.position).applyMatrix4(transform).toArray();
      opening.normal = new THREE.Vector3(...opening.normal).applyMatrix3(normalMatrix).normalize().toArray();
    }
  }
  setArchitectureModel(entityId, normalized, "Shape building form");
  return { entityId, formId };
}
export const removeArchitectureForm = (entityId, formId) => removeRow(entityId, "forms", formId, "Remove building form", "formId");

export function addArchitectureOpening(entityId, opening = {}) {
  const model = rows(entityId);
  if (!model.forms?.some((form) => form.id === opening.formId)) throw new Error("The opening must reference an existing building form.");
  return addRow(entityId, "openings", opening, "Place facade opening", "openingId");
}
export const updateArchitectureOpening = (entityId, openingId, patch) => updateRow(entityId, "openings", openingId, patch, "Edit facade opening", "openingId");
export const removeArchitectureOpening = (entityId, openingId) => removeRow(entityId, "openings", openingId, "Remove facade opening", "openingId");

export const addArchitecturePath = (entityId, path) => addRow(entityId, "paths", path, "Draw architecture path", "pathId");
export const updateArchitecturePath = (entityId, pathId, patch) => updateRow(entityId, "paths", pathId, patch, "Shape architecture path", "pathId");
export const removeArchitecturePath = (entityId, pathId) => removeRow(entityId, "paths", pathId, "Remove architecture path", "pathId");
