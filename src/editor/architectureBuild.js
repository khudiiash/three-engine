import * as THREE from "three/webgpu";
import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { BatchCommand } from "./commands/entityCommands.js";
import { AddComponentCommand, SetComponentPropCommand } from "./commands/componentCommands.js";
import { serializeEntity, instantiateEntity } from "../engine/serialize.js";
import { getComponentClass } from "../engine/components/registry.js";
import { generateArchitecture } from "../modules/architecture/blueprints.js";
import { BLOCKOUT_SHAPES } from "../modules/level-design/blockoutGeometry.js";

const GENERATED = "architecture:generated";
const ASSEMBLY = "architecture:assembly";
const clone = (value) => structuredClone(value);
const batched = (fn) => engine.batchHierarchy ? engine.batchHierarchy(fn) : fn();
const pieceOf = (entity) => entity?.getComponent?.("architecturepiece") ?? entity?.getComponent?.("blockout");

function requireArchitecture() {
  if (!getComponentClass("architecture") || !getComponentClass("architecturepiece")) {
    throw new Error('Enable the "architecture" module before creating architecture.');
  }
}

function requireEntity(id) {
  const entity = engine.getEntity(id);
  if (!entity) throw new Error(`No entity with id "${id}".`);
  return entity;
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e7) {
    throw new Error(`${label} must be a finite number between -10000000 and 10000000.`);
  }
  return value;
}

function vector(value, label, fallback = [0, 0, 0]) {
  const result = value ?? fallback;
  if (!Array.isArray(result) || result.length !== 3) throw new Error(`${label} must be [x, y, z].`);
  return result.map((n) => finiteNumber(n, label));
}

function matrixTransform(matrix) {
  const position = new THREE.Vector3(), scale = new THREE.Vector3(), quaternion = new THREE.Quaternion();
  matrix.decompose(position, quaternion, scale);
  const reconstructed = new THREE.Matrix4().compose(position, quaternion, scale);
  if (matrix.elements.some((value, i) => !Number.isFinite(value) || Math.abs(value - reconstructed.elements[i]) > 1e-5)) {
    throw new Error("This parent transform would shear the structure. Use an assembly with uniform scale.");
  }
  return { position: position.toArray(), rotation: new THREE.Euler().setFromQuaternion(quaternion).toArray().slice(0, 3), scale: scale.toArray() };
}

function worldMatrix(position, rotationY, rotation) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...vector(position, "Position")),
    rotation ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...vector(rotation, "Rotation")))
      : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), finiteNumber(rotationY ?? 0, "Rotation")),
    new THREE.Vector3(1, 1, 1),
  );
}

function localTransform(matrix, parent) {
  if (!parent) return matrixTransform(matrix);
  parent.object3D.updateWorldMatrix(true, false);
  const parentMatrix = parent.object3D.matrixWorld;
  if (Math.abs(parentMatrix.determinant()) < 1e-12) throw new Error("The parent has zero scale; placement is undefined.");
  return matrixTransform(parentMatrix.clone().invert().multiply(matrix));
}

function snapshot(name, transform = {}, components = [], children = [], generated = false) {
  return {
    id: THREE.MathUtils.generateUUID(), name, ...transform,
    components, children, tags: generated ? [GENERATED, ...(children.length ? [ASSEMBLY] : [])] : [],
  };
}

/** Serialized IDs are assigned BEFORE creating anything, including every child. */
class CreateArchitectureCommand {
  constructor(data, parentId, label) {
    this.data = clone(data);
    this.parentId = parentId ?? null;
    this.entityId = data.id;
    this.label = label;
  }
  do() {
    batched(() => {
      const parent = this.parentId ? requireEntity(this.parentId) : null;
      try {
        instantiateEntity(engine, this.data, parent);
      } catch (error) {
        const partial = engine.getEntity(this.entityId);
        if (partial) engine.destroyEntity(partial);
        throw error;
      }
    });
  }
  undo() {
    batched(() => {
      const entity = engine.getEntity(this.entityId);
      if (entity) engine.destroyEntity(entity);
    });
  }
}

function materialMap(materials = {}) {
  if (!materials || typeof materials !== "object" || Array.isArray(materials)) throw new Error("Materials must map role names to material asset paths.");
  const result = {};
  for (const [role, path] of Object.entries(materials)) {
    if (typeof path !== "string") throw new Error(`Material for ${role} must be an asset path string.`);
    result[role] = path;
  }
  return result;
}

function pieceComponents(piece, settings) {
  const { material, ...props } = clone(piece.props ?? {});
  const collision = settings.collision !== false;
  const components = [
    { type: "mesh", props: {
      castShadow: true, receiveShadow: true,
      // Do not let Mesh's automatic convex collision fill doors or stairwells.
      collision: "none",
      material: settings.materials?.[piece.role] ?? settings.materials?.default ?? material ?? "",
    } },
    { type: "architecturepiece", props: { ...props, shape: piece.shape, size: clone(piece.size), role: piece.role ?? "" } },
  ];
  if (collision && getComponentClass("collider")) {
    components.push({ type: "collider", props: { shape: "concave", friction: 0.6, restitution: 0 } });
  }
  return components;
}

function pieceSnapshot(piece, settings, generated = true) {
  return snapshot(piece.name ?? piece.role ?? piece.shape, {
    position: clone(piece.position ?? [0, 0, 0]), rotation: clone(piece.rotation ?? [0, piece.rotationY ?? 0, 0]), scale: [1, 1, 1],
  }, pieceComponents(piece, settings), [], generated);
}

function generatedSnapshot(plan) {
  return snapshot("Generated architecture", {}, [], plan.buildings.map((building) => snapshot(
    building.name, { position: clone(building.position ?? [0, 0, 0]), rotation: [0, building.rotationY ?? 0, 0] }, [],
    building.floors.map((assembly) => snapshot(assembly.name, { position: [0, assembly.elevation ?? 0, 0] }, [],
      assembly.pieces.map((piece) => pieceSnapshot(piece, plan.settings)), true)), true,
  )), true);
}

/** A compact set of footprint samples, in the building's own coordinates. */
function footprintSamples(building) {
  if (building.footprint?.length >= 3) {
    const polygon = building.footprint;
    const box = new THREE.Box2().setFromPoints(polygon.map(([x, z]) => new THREE.Vector2(x, z)));
    const inside = (x, z, ring) => {
      let result = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
      }
      return result;
    };
    const samples = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      samples.push(new THREE.Vector3(a[0], 0, a[1]), new THREE.Vector3((a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2));
    }
    for (const u of [.1, .3, .5, .7, .9]) for (const v of [.1, .3, .5, .7, .9]) {
      const x = THREE.MathUtils.lerp(box.min.x, box.max.x, u), z = THREE.MathUtils.lerp(box.min.y, box.max.y, v);
      if (inside(x, z, polygon) && !(building.footprintHoles ?? []).some((hole) => inside(x, z, hole))) samples.push(new THREE.Vector3(x, 0, z));
    }
    return samples;
  }
  const bounds = new THREE.Box2();
  const direct = [];
  for (const assembly of building.floors) for (const piece of assembly.pieces) {
    const [x, , z] = piece.position ?? [0, 0, 0];
    const [sx, , sz] = piece.size;
    const c = Math.cos(piece.rotationY ?? 0), s = Math.sin(piece.rotationY ?? 0);
    const corners = piece.props?.footprint?.length ? piece.props.footprint : [[-sx / 2, -sz / 2], [sx / 2, -sz / 2], [sx / 2, sz / 2], [-sx / 2, sz / 2]];
    for (const [px, pz] of corners) {
      const point = new THREE.Vector2(x + px * c + pz * s, z - px * s + pz * c);
      bounds.expandByPoint(point);
      if (piece.props?.footprint?.length && direct.length < 64) direct.push(point);
    }
  }
  if (bounds.isEmpty()) return [new THREE.Vector3()];
  const points = [...direct];
  for (const u of [0, .25, .5, .75, 1]) for (const v of [0, .25, .5, .75, 1]) {
    points.push(new THREE.Vector2(THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, u), THREE.MathUtils.lerp(bounds.min.y, bounds.max.y, v)));
  }
  return points.map((point) => new THREE.Vector3(point.x, 0, point.y));
}

function terrainTargets(settings) {
  const terrains = [];
  const consider = (entity) => {
    const terrain = entity.getComponent?.("terrain");
    if (!terrain || terrain.enabled === false || entity.activeInHierarchy === false || !terrain.mesh?.geometry) return;
    terrain.mesh.updateWorldMatrix(true, false);
    terrain.mesh.geometry.computeBoundingBox();
    const bounds = terrain.mesh.geometry.boundingBox.clone().applyMatrix4(terrain.mesh.matrixWorld);
    terrains.push({ terrain, mesh: terrain.mesh, bounds });
  };
  if (settings.terrainId) {
    const target = requireEntity(settings.terrainId);
    if (!target.getComponent?.("terrain")) throw new Error("Terrain target must have a Terrain component.");
    consider(target);
  } else for (const root of engine.rootEntities) root.traverse(consider);
  return terrains;
}

function terrainHeight(target, point, raycaster) {
  const { mesh, terrain, bounds } = target;
  if (point.x < bounds.min.x || point.x > bounds.max.x || point.z < bounds.min.z || point.z > bounds.max.z) return null;
  const e = mesh.matrixWorld.elements;
  // Heightfields with a vertical local Y can use the live CPU sample. This is
  // the common case, and avoids ray-testing thousands of triangles per lot.
  if (terrain.heightAtLocal && Math.abs(e[1]) + Math.abs(e[9]) + Math.abs(e[4]) + Math.abs(e[6]) < 1e-8 && Math.abs(e[5]) > 1e-8) {
    const local = mesh.worldToLocal(point.clone());
    const localBounds = mesh.geometry.boundingBox;
    if (local.x < localBounds.min.x || local.x > localBounds.max.x || local.z < localBounds.min.z || local.z > localBounds.max.z) return null;
    local.y = terrain.heightAtLocal(local.x, local.z);
    return mesh.localToWorld(local).y;
  }
  raycaster.set(new THREE.Vector3(point.x, bounds.max.y + 1, point.z), new THREE.Vector3(0, -1, 0));
  raycaster.far = bounds.max.y - bounds.min.y + 2;
  return raycaster.intersectObject(mesh, false)[0]?.point.y ?? null;
}

/** Resolve placement against the current transformed scene, without mutations. */
function fitPlan(plan, rootMatrix) {
  const settings = plan.settings;
  const terrains = settings.terrainFit === "highest" ? terrainTargets(settings) : [];
  const waters = settings.avoidWater ? [...(engine.waterSurfaces ?? [])].filter((water) => water.enabled !== false && water.graphEnabled !== false && water.entity?.activeInHierarchy !== false) : [];
  const raycaster = new THREE.Raycaster();
  const inverse = rootMatrix.clone().invert();
  let misses = 0;
  for (const building of plan.buildings) {
    if (!terrains.length && !waters.length) continue;
    const position = new THREE.Vector3(...(building.position ?? [0, 0, 0]));
    const buildingMatrix = rootMatrix.clone().multiply(new THREE.Matrix4().makeTranslation(...position.toArray())).multiply(new THREE.Matrix4().makeRotationY(building.rotationY ?? 0));
    let highest = null, waterHighest = null;
    for (const local of footprintSamples(building)) {
      const point = local.applyMatrix4(buildingMatrix);
      for (const terrain of terrains) {
        const height = terrainHeight(terrain, point, raycaster);
        if (height != null && Number.isFinite(height)) highest = Math.max(highest ?? -Infinity, height - point.y);
      }
      for (const water of waters) {
        const height = water.getSurfaceHeight?.(point.x, point.z);
        if (height != null && Number.isFinite(height)) waterHighest = Math.max(waterHighest ?? -Infinity, height + (settings.waterClearance ?? 0) - point.y);
      }
    }
    if (terrains.length && highest === null) misses++;
    // Water clearance can only lift a building. Terrain fitting establishes
    // the base elevation, preserving any explicit generator-local offset.
    const lift = Math.max(highest ?? 0, waterHighest ?? -Infinity);
    if (!Number.isFinite(lift) || lift === 0) continue;
    const world = position.clone().applyMatrix4(rootMatrix);
    world.y += lift;
    building.position = world.applyMatrix4(inverse).toArray();
  }
  if (settings.terrainFit === "highest" && !terrains.length) plan.warnings.push("No active Terrain surface is available; placement keeps the requested elevation.");
  if (misses) plan.warnings.push(`${misses} assembly footprint(s) missed the Terrain; their elevation was retained.`);
  if (settings.collision !== false && !getComponentClass("collider")) plan.warnings.push("Physics is disabled. Enable Physics and add colliders to make this architecture walkable.");
  return plan;
}

function summary(plan, entityId) {
  return {
    ...(entityId ? { entityId } : {}), kind: plan.kind, settings: clone(plan.settings),
    buildingCount: plan.buildings.length,
    pieceCount: plan.buildings.reduce((total, building) => total + building.floors.reduce((count, assembly) => count + assembly.pieces.length, 0), 0),
    warnings: [...new Set(plan.warnings)],
  };
}

function requireGeneratedPlan(plan) {
  if (!plan.buildings.length) throw new Error(plan.warnings.join(" ") || "The recipe produced no architecture. Adjust its settings before creating it.");
  return plan;
}

export function previewArchitecture(settings = {}, options = {}) {
  const parent = options.parentId ? requireEntity(options.parentId) : null;
  const matrix = worldMatrix(options.position, options.rotationY, options.rotation);
  localTransform(matrix, parent);
  const plan = fitPlan(generateArchitecture(settings), matrix);
  return { ...summary(plan), buildings: plan.buildings.map((building) => ({ name: building.name, position: clone(building.position), assemblyCount: building.floors.length })) };
}

/** Reuse a compiled recipe for a moving placement preview. Only placement
 * transforms are copied; geometry recipes stay shared and are never mutated. */
export function resolveArchitecturePlacement(plan, options = {}) {
  const parent = options.parentId ? requireEntity(options.parentId) : null;
  const matrix = worldMatrix(options.position, options.rotationY, options.rotation);
  localTransform(matrix, parent);
  return fitPlan({ ...plan, warnings: [...plan.warnings], buildings: plan.buildings.map((building) => ({ ...building, position: [...building.position] })) }, matrix);
}

export function createArchitecture(settings = {}, options = {}) {
  requireArchitecture();
  const parent = options.parentId ? requireEntity(options.parentId) : null;
  const matrix = worldMatrix(options.position, options.rotationY, options.rotation);
  const transform = localTransform(matrix, parent);
  const plan = fitPlan(requireGeneratedPlan(generateArchitecture(settings)), matrix);
  const generated = generatedSnapshot(plan);
  const data = snapshot(options.name ?? (plan.kind === "city" ? "City" : plan.kind === "assembly" ? "Architecture assembly" : "Architecture"), transform, [
    { type: "architecture", props: { settings: clone(plan.settings), generatedRootId: generated.id, version: 1 } },
  ], [generated]);
  commandBus.execute(new CreateArchitectureCommand(data, parent?.id, `Create ${data.name}`));
  return summary(plan, data.id);
}

function restoreSibling(entity, index) {
  const siblings = entity.parent?.children ?? engine.rootEntities;
  const current = siblings.indexOf(entity);
  if (current !== -1) siblings.splice(current, 1);
  siblings.splice(Math.min(index, siblings.length), 0, entity);
}

class RebuildArchitectureCommand {
  constructor(root, generated, settings) {
    this.rootId = root.id;
    const architecture = root.getComponent("architecture");
    const old = architecture.props.generatedRootId ? engine.getEntity(architecture.props.generatedRootId) : null;
    if (old && old.parent !== root) throw new Error("The generated group was moved outside its Architecture root. Return it before regenerating.");
    this.previous = old ? clone(serializeEntity(old)) : null;
    this.previousIndex = old ? root.children.indexOf(old) : root.children.length;
    this.previousSettings = clone(architecture.props.settings ?? {});
    this.previousRootId = architecture.props.generatedRootId ?? "";
    this.generated = generated;
    this.settings = clone(settings);
    this.label = `Regenerate ${root.name}`;
    this.preserved = [];
    if (old) {
      const visit = (entity) => {
        for (const child of entity.children) {
          if (!child.tags?.includes(GENERATED)) {
            child.object3D.updateWorldMatrix(true, false);
            this.preserved.push({ id: child.id, parentId: entity.id, index: entity.children.indexOf(child),
              before: clone(child.getTransform()), after: localTransform(child.object3D.matrixWorld.clone(), root) });
          } else visit(child);
        }
      };
      visit(old);
      // These entities remain live during replacement. Remove their snapshots
      // so undo cannot accidentally instantiate the same IDs a second time.
      const preservedIds = new Set(this.preserved.map((entry) => entry.id));
      const prune = (node) => { node.children = (node.children ?? []).filter((child) => !preservedIds.has(child.id)); node.children.forEach(prune); };
      prune(this.previous);
    }
  }
  do() {
    batched(() => {
      const root = requireEntity(this.rootId);
      for (const item of this.preserved) {
        const entity = requireEntity(item.id);
        entity.setParent(root);
        entity.setTransform(item.after);
      }
      const old = this.previous ? engine.getEntity(this.previous.id) : null;
      if (old) engine.destroyEntity(old);
      try {
        const created = instantiateEntity(engine, this.generated, root);
        restoreSibling(created, this.previousIndex);
        root.getComponent("architecture").setProp("generatedRootId", this.generated.id);
        root.getComponent("architecture").setProp("settings", clone(this.settings));
      } catch (error) {
        this.undo();
        throw error;
      }
    });
  }
  undo() {
    batched(() => {
      const root = requireEntity(this.rootId);
      const generated = engine.getEntity(this.generated.id);
      if (generated) engine.destroyEntity(generated);
      if (this.previous) restoreSibling(instantiateEntity(engine, this.previous, root), this.previousIndex);
      for (const item of this.preserved) {
        const entity = requireEntity(item.id);
        entity.setParent(requireEntity(item.parentId));
        entity.setTransform(item.before);
        restoreSibling(entity, item.index);
      }
      root.getComponent("architecture").setProp("generatedRootId", this.previousRootId);
      root.getComponent("architecture").setProp("settings", clone(this.previousSettings));
    });
  }
}

/** Explicit regeneration replaces only the owned generated branch. */
export function rebuildArchitecture(entityId, settings = {}) {
  requireArchitecture();
  const root = requireEntity(entityId);
  const architecture = root.getComponent("architecture");
  if (!architecture) throw new Error("Select an Architecture root to regenerate.");
  root.object3D.updateWorldMatrix(true, false);
  if (Math.abs(root.object3D.matrixWorld.determinant()) < 1e-12) throw new Error("Architecture has zero scale; placement is undefined.");
  const plan = fitPlan(requireGeneratedPlan(generateArchitecture({ ...clone(architecture.props.settings ?? {}), ...settings })), root.object3D.matrixWorld);
  const command = new RebuildArchitectureCommand(root, generatedSnapshot(plan), plan.settings);
  commandBus.execute(command);
  const result = summary(plan, entityId);
  if (command.preserved.length) result.warnings.push(`${command.preserved.length} hand-authored assembly/assemblies were kept under the Architecture root.`);
  return result;
}

export function createArchitectureAssembly({ name = "Assembly", parentId = null, position = [0, 0, 0], rotationY = 0, rotation } = {}) {
  requireArchitecture();
  const parent = parentId ? requireEntity(parentId) : null;
  const data = snapshot(name, localTransform(worldMatrix(position, rotationY, rotation), parent), [
    { type: "architecture", props: { settings: { kind: "assembly" }, generatedRootId: "", version: 1 } },
  ]);
  data.tags = [ASSEMBLY];
  commandBus.execute(new CreateArchitectureCommand(data, parentId, `Create ${name}`));
  return { entityId: data.id, pieceCount: 0, warnings: [] };
}

export function createArchitecturePiece({ shape = "box", position = [0, 0, 0], size = [1, 1, 1], rotationY = 0, rotation, props = {}, parentId = null, collision = true, name, createAssembly = false } = {}) {
  requireArchitecture();
  if (!BLOCKOUT_SHAPES.includes(shape)) throw new Error(`Unknown architecture shape "${shape}".`);
  const dimensions = vector(size, "Size");
  if (dimensions.some((n) => n <= 0 || n > 10000)) throw new Error("Piece dimensions must be greater than 0 and at most 10000 metres.");
  // Reuse the generator's bounded validation for openings, polygons and all
  // custom piece data before any entity or history entry exists.
  const validated = generateArchitecture({ kind: "assembly", pieces: [{ name: name ?? `${shape[0].toUpperCase()}${shape.slice(1)}`, shape, size: dimensions, position: [0, 0, 0], rotationY: 0, props, role: props.role ?? shape }] });
  const piece = validated.buildings[0].floors[0].pieces[0];
  const parent = parentId ? requireEntity(parentId) : null;
  const data = pieceSnapshot(piece, { collision }, false);
  Object.assign(data, localTransform(worldMatrix(position, rotationY, rotation), parent));
  const created = createAssembly && !parent ? snapshot("Architecture", {}, [
    { type: "architecture", props: { settings: { kind: "assembly", collision }, generatedRootId: "", version: 1 } },
  ], [data]) : data;
  commandBus.execute(new CreateArchitectureCommand(created, parentId, `Draw ${data.name}`));
  return { entityId: data.id, ...(created !== data ? { assemblyId: created.id } : {}), pieceCount: 1, warnings: collision && !getComponentClass("collider") ? ["Physics is disabled; no collider was added."] : [] };
}

export function duplicateArchitectureAssembly(entityId, { name, position } = {}) {
  const source = requireEntity(entityId);
  const data = clone(serializeEntity(source));
  const ids = new Map();
  const reidentify = (node, owned = false) => {
    const old = node.id;
    node.id = THREE.MathUtils.generateUUID();
    ids.set(old, node.id);
    if (!owned) node.tags = (node.tags ?? []).filter((tag) => tag !== GENERATED);
    const childOwned = owned || (node.components ?? []).some((component) => component.type === "architecture");
    (node.children ?? []).forEach((child) => reidentify(child, childOwned));
  };
  reidentify(data);
  const remap = (node) => {
    for (const component of node.components ?? []) {
      if (component.type === "architecture" && ids.has(component.props.generatedRootId)) component.props.generatedRootId = ids.get(component.props.generatedRootId);
    }
    (node.children ?? []).forEach(remap);
  };
  remap(data);
  data.name = name ?? `${source.name} Copy`;
  if (position) {
    source.object3D.updateWorldMatrix(true, false);
    const matrix = source.object3D.matrixWorld.clone().setPosition(...vector(position, "Position"));
    Object.assign(data, localTransform(matrix, source.parent));
  }
  commandBus.execute(new CreateArchitectureCommand(data, source.parent?.id, `Duplicate ${source.name}`));
  let pieceCount = 0;
  source.traverse((entity) => { if (pieceOf(entity)) pieceCount++; });
  return { entityId: data.id, pieceCount, warnings: [] };
}

/** Legacy convenience: the assembly itself remains unconstrained in 3D. */
export function duplicateArchitectureFloor(entityId, { elevation, name } = {}) {
  const source = requireEntity(entityId);
  const architecture = architectureOf(source)?.getComponent("architecture");
  const nextY = finiteNumber(elevation ?? source.object3D.position.y + (architecture?.props.settings?.storeyHeight ?? 3), "Elevation");
  source.object3D.updateWorldMatrix(true, false);
  const point = source.object3D.position.clone();
  point.y = nextY;
  if (source.parent) source.parent.object3D.localToWorld(point);
  return duplicateArchitectureAssembly(entityId, { name, position: point.toArray() });
}

export function architectureOf(entity) {
  for (let node = entity; node; node = node.parent) if (node.getComponent?.("architecture")) return node;
  return null;
}

export function applyArchitectureMaterials(entityId, materials) {
  const root = requireEntity(entityId);
  const paths = materialMap(materials);
  const commands = [];
  root.traverse((entity) => {
    const piece = pieceOf(entity);
    const mesh = entity.getComponent?.("mesh");
    if (!piece || !mesh) return;
    const material = paths[piece.props.role] ?? paths.default;
    if (material !== undefined && mesh.props.material !== material) commands.push(new SetComponentPropCommand(entity.id, "mesh", "material", material));
  });
  const updated = commands.length;
  const architecture = root.getComponent?.("architecture");
  if (architecture) commands.push(new SetComponentPropCommand(entityId, "architecture", "settings", {
    ...clone(architecture.props.settings ?? {}), materials: { ...(architecture.props.settings?.materials ?? {}), ...paths },
  }));
  if (commands.length) {
    const command = new BatchCommand(commands, "Apply architecture materials");
    commandBus.execute({ label: command.label, do: () => batched(() => command.do()), undo: () => batched(() => command.undo()) });
  }
  return { entityId, updated, pieceCount: updated, warnings: [] };
}

export function listArchitecture() {
  const result = [];
  for (const root of engine.rootEntities) root.traverse((entity) => {
    const architecture = entity.getComponent?.("architecture");
    if (!architecture) return;
    let pieceCount = 0;
    entity.traverse((child) => { if (pieceOf(child)) pieceCount++; });
    result.push({ entityId: entity.id, name: entity.name, settings: clone(architecture.props.settings ?? {}), generatedRootId: architecture.props.generatedRootId ?? "", pieceCount,
      model: architecture.props.model ? clone(architecture.props.model) : null });
  });
  return result;
}

/** Repair a structure authored before Physics was enabled. */
export function addArchitectureColliders(entityId) {
  const root = requireEntity(entityId);
  if (!getComponentClass("collider")) throw new Error("Enable Physics before adding architecture collision.");
  const commands = [];
  root.traverse((entity) => {
    const architecture = entity.getComponent("architecture");
    const model = architecture?.props.model;
    if ((!pieceOf(entity) && !model) || entity.getComponent("collider")) return;
    // A live model owns its root mesh. Preserve an explicit collision opt-out
    // when repairing models authored before the Physics module was enabled.
    if (model && architecture.props.collision === false) return;
    if (entity.getComponent("mesh")?.props.collision !== "none") commands.push(new SetComponentPropCommand(entity.id, "mesh", "collision", "none"));
    commands.push(new AddComponentCommand(entity.id, "collider", { shape: "concave", friction: .6, restitution: 0 }));
  });
  const added = commands.filter((command) => command instanceof AddComponentCommand).length;
  if (commands.length) {
    const command = new BatchCommand(commands, "Add architecture collision");
    commandBus.execute({ label: command.label, do: () => batched(() => command.do()), undo: () => batched(() => command.undo()) });
  }
  return { entityId, added };
}
