import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { commandBus } from "../../commands/CommandBus.js";
import { SetComponentPropCommand } from "../../commands/componentCommands.js";
import { DEFAULT_PARTICLE_GRAPH, legacyPropsToGraph, P_NODE_TYPES } from "../../../engine/particleGraph.js";
import { VFX_MODULES, addVfxModule } from "../../vfxStack.js";
import { createSimulationGraph } from "../../../engine/vfx/simulationGraph.js";
import { createVfxAsset } from "../../../engine/vfx/vfxAsset.js";
import { readVfxDocument, writeVfxDocument, vfxDocumentPath } from "../../vfxAssets.js";
import { invoke } from "../../assetOps.js";
import { useProjectStore } from "../../store/projectStore.js";
import { normalizeEffectTimeline, createEffectPreset, EFFECT_KINDS } from "../../../engine/vfx/effectTimeline.js";

defineOp({
  name: "vfx.cloth.status", readOnly: true,
  description: "Inspect a live cloth simulation and the scene colliders it can use. Reports missing plane, active primitive/triangle collision fields and GPU position bounds without changing the scene.",
  params: { entityId: { type: "string", required: true }, readPositions: { type: "boolean", default: false } },
  async run({entityId, readPositions}) {
    const c = requireComponent(entityId, "cloth"), sim = c.simulation;
    const result = { entityId, enabled: c.enabled, error: c.surfaceError ?? null,
      simulated: !!sim, sceneCollision: c.resolvedProps?.sceneCollision !== false,
      primitiveCount: c.colliderField?.countUniform?.value ?? 0,
      triangleCount: c.meshColliderField?.triangleCount ?? 0,
      triangleCollisionAvailable: !!c.meshColliderField,
      triangleColliders: c.meshColliderField?.diagnostics ?? [],
      collisionError: c.meshColliderField?.error ?? null,
      colliders: [...engine.entities.values()].flatMap((entity) => { const collider=entity.getComponent("collider"); return collider ? [{id:entity.id,name:entity.name,shape:collider.props.shape,enabled:collider.enabled,sensor:!!collider.props.isSensor}] : []; }),
    };
    if (readPositions && sim && engine.renderer?.getArrayBufferAsync) {
      const { Vector3 } = await import("three/webgpu");
      const data = new Float32Array(await engine.renderer.getArrayBufferAsync(sim.positions.value));
      sim.mesh.updateWorldMatrix(true,false);
      const point=new Vector3(),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
      for(let i=0;i<sim.count;i++){point.set(data[i*4],data[i*4+1],data[i*4+2]).applyMatrix4(sim.mesh.matrixWorld);for(const [axis,value] of point.toArray().entries()){min[axis]=Math.min(min[axis],value);max[axis]=Math.max(max[axis],value);}}
      result.gpuBounds={min,max,vertices:sim.count};
    }
    return result;
  },
});

defineOp({
  name: "vfx.timeline.get", readOnly: true,
  description: "Read the separate VFX composition timeline and its transient playback state.",
  params: { entityId: { type: "string", required: true } },
  run: ({entityId}) => { const c = requireComponent(entityId, "vfx"); return { timeline: structuredClone(c.document ?? c.props.timeline ?? createEffectPreset()), time: c.time, state: c.state, elementKinds: EFFECT_KINDS }; },
});
defineOp({
  name: "vfx.timeline.set", undoable: true,
  description: "Replace a VFX composition with validated timed elements and animation curves. One undoable edit.",
  params: { entityId: { type: "string", required: true }, timeline: { type: "object", required: true } },
  run: ({entityId,timeline}) => { requireComponent(entityId,"vfx"); const document=normalizeEffectTimeline(timeline); commandBus.execute(new SetComponentPropCommand(entityId,"vfx","timeline",document)); return {entityId,timeline:document}; },
});
defineOp({
  name: "vfx.timeline.playback",
  description: "Preview a VFX timeline: play, pause, resume, stop or seek. Seeking poses layers and resets particle simulations.",
  params: { entityId: { type: "string", required: true }, action: { type: "string", enum: ["play","pause","resume","stop","seek"], required: true }, time: { type: "number", default: 0 } },
  run: ({entityId,action,time}) => { const c=requireComponent(entityId,"vfx"); c[action](time); return {entityId,time:c.time,state:c.state}; },
});

const entityParam = { type: "string", required: true, description: "Entity with the requested simulation component." };
function document(entityId) {
  const component = engine.getEntity(entityId)?.getComponent("particles");
  if (!component) throw new Error("Add a particles component to this entity first with component.add.");
  return structuredClone(component.effectiveGraph ?? component.props.graph ?? (component.props.startColor !== undefined
    ? legacyPropsToGraph(component.props) : DEFAULT_PARTICLE_GRAPH));
}
function commit(entityId, graph, label) {
  if (engine.getEntity(entityId)?.getComponent("particles")?.props.asset) throw new Error("This effect uses a shared .vfx asset. Edit it with vfx.set(path), or clear the asset with vfx.assign.");
  commandBus.execute(new SetComponentPropCommand(entityId, "particles", "graph", graph, label));
  return { entityId, graph };
}

defineOp({
  name: "vfx.modules",
  description: "List particle graph recipes and node parameter schemas. Cloth and water have their own modules; the separate VFX composition uses vfx.timeline operations.",
  readOnly: true,
  params: {},
  run: () => ({ modules: VFX_MODULES, nodeTypes: P_NODE_TYPES, simulations: ["particles", "cloth", "water"] }),
});

defineOp({
  name: "vfx.get",
  description: "Read a particle, cloth or water graph from an entity or .vfx file, including disabled nodes and preserved connections.",
  readOnly: true,
  params: {
    entityId: { ...entityParam, required: false },
    path: { type: "string", description: "Absolute .vfx project path, instead of entityId." },
    kind: { type: "string", enum: ["particles", "cloth", "water"], default: "particles" },
  },
  async run({ entityId, path, kind }) {
    if (path) return { path, ...await readVfxDocument(path) };
    const comp = requireComponent(entityId, kind);
    const graph = comp.effectiveGraph ?? comp.props.graph ?? defaultGraph(kind, comp.props);
    return { entityId, kind, asset: comp.props.asset ?? "", graph: structuredClone(graph) };
  },
});

const kindParam = { type: "string", enum: ["particles", "cloth", "water"], default: "particles", description: "Simulation component type." };
function requireComponent(entityId, kind) {
  const comp = engine.getEntity(entityId)?.getComponent(kind);
  if (!comp) throw new Error(`Entity needs a ${kind} component. Add it with component.add first.`);
  return comp;
}
function defaultGraph(kind, props = {}) {
  return kind === "particles" ? (props.startColor !== undefined ? legacyPropsToGraph(props) : structuredClone(DEFAULT_PARTICLE_GRAPH)) : createSimulationGraph(kind, props);
}

defineOp({
  name: "vfx.create",
  description: "Create a reusable .vfx file. Refuses an existing path. Optionally seed from an entity and assign the result to a matching component.",
  params: {
    path: { type: "string", required: true, description: "Absolute project filename; .vfx is appended if missing." },
    kind: kindParam,
    graph: { type: "object", description: "Graph to store; defaults to a fresh simulation graph." },
    fromEntityId: { type: "string", description: "Copy this entity's effective graph." },
    assignTo: { type: "string", description: "Entity with a matching simulation component." },
  },
  async run({ path, kind, graph, fromEntityId, assignTo }) {
    const target = vfxDocumentPath(/\.vfx$/i.test(path) ? path : `${path}.vfx`);
    let exists = false;
    try { await invoke("stat_file", { path: target }); exists = true; } catch {}
    if (exists) throw new Error("VFX file already exists. Use vfx.set to edit it.");
    const source = fromEntityId ? requireComponent(fromEntityId, kind) : null;
    if (assignTo) requireComponent(assignTo, kind);
    const doc = createVfxAsset(kind, graph ?? source?.effectiveGraph ?? source?.props.graph ?? defaultGraph(kind, source?.props));
    await writeVfxDocument(target, doc);
    await useProjectStore.getState().refresh();
    if (assignTo) commandBus.execute(new SetComponentPropCommand(assignTo, kind, "asset", target));
    return { path: target, kind, graph: doc.graph, assignedTo: assignTo ?? null };
  },
});

defineOp({
  name: "vfx.set",
  description: "Write a shared .vfx graph and refresh all linked instances, or edit an unlinked entity graph through undo history. Kind follows the existing file when path is given.",
  params: {
    path: { type: "string", description: "Existing .vfx path to update." },
    entityId: { type: "string", description: "Unlinked entity to update instead of a file." },
    kind: kindParam,
    graph: { type: "object", required: true },
  },
  async run({ path, entityId, kind, graph }) {
    if (path) {
      const previous = await readVfxDocument(path);
      const doc = createVfxAsset(previous.kind, graph);
      await writeVfxDocument(path, { ...previous, ...doc });
      return { path, kind: doc.kind, graph: doc.graph };
    }
    const comp = requireComponent(entityId, kind);
    if (comp.props.asset) throw new Error("This entity uses a shared .vfx. Pass its path, or clear the asset slot first.");
    const doc = createVfxAsset(kind, graph);
    commandBus.execute(new SetComponentPropCommand(entityId, kind, "graph", doc.graph));
    return { entityId, kind, graph: doc.graph };
  },
});

defineOp({
  name: "vfx.assign",
  description: "Assign a .vfx file to a matching simulation component, or clear its asset slot to restore the inline graph. Undoable; mismatched simulation kinds are rejected.",
  undoable: true,
  params: { entityId: entityParam, kind: kindParam, path: { type: "string", default: "", description: "Absolute .vfx path, or empty to clear." } },
  async run({ entityId, kind, path }) {
    requireComponent(entityId, kind);
    if (path) {
      const doc = await readVfxDocument(path);
      if (doc.kind !== kind) throw new Error(`Cannot assign ${doc.kind} VFX to ${kind}.`);
      path = vfxDocumentPath(path);
    }
    commandBus.execute(new SetComponentPropCommand(entityId, kind, "asset", path));
    return { entityId, kind, path };
  },
});

defineOp({
  name: "vfx.addModule",
  description: "Add and automatically connect a VFX graph recipe to a particle system. Use vfx.modules for module IDs and vfx.get for system node IDs. One undoable edit.",
  undoable: true,
  params: {
    entityId: entityParam,
    systemId: { type: "string", required: true, description: "Target System node ID." },
    moduleId: { type: "string", required: true, description: "Recipe ID returned by vfx.modules." },
  },
  run: ({ entityId, systemId, moduleId }) => {
    const recipe = VFX_MODULES.find((entry) => entry.id === moduleId);
    if (!recipe) throw new Error(`Unknown VFX module "${moduleId}". Use vfx.modules.`);
    const result = addVfxModule(document(entityId), systemId, recipe);
    return { ...commit(entityId, result.graph, `Add ${recipe.label}`), nodeId: result.id };
  },
});

defineOp({
  name: "vfx.setEnabled",
  description: "Enable or bypass a particle graph node without deleting its parameters or connections. One undoable edit.",
  undoable: true,
  params: {
    entityId: entityParam,
    nodeId: { type: "string", required: true, description: "Node ID from vfx.get." },
    enabled: { type: "boolean", required: true, description: "Whether this module participates in simulation." },
  },
  run: ({ entityId, nodeId, enabled }) => {
    const graph = document(entityId);
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    if (!node || !P_NODE_TYPES[node.type]) throw new Error(`Unknown VFX node "${nodeId}".`);
    node.enabled = enabled;
    return commit(entityId, graph, `${enabled ? "Enable" : "Disable"} ${node.label ?? P_NODE_TYPES[node.type].label}`);
  },
});
