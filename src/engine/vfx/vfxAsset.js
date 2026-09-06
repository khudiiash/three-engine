import { resolveAssetUrl } from "../assetResolver.js";
import { P_NODE_TYPES } from "../particleGraph.js";
import { evaluateSimulationGraph } from "./simulationGraph.js";

const cache = new Map();
const pending = new Map();
const listeners = new Map();
const keyOf = (path) => String(path ?? "").replaceAll("\\", "/");
const clone = (value) => structuredClone(value);

/** Versioned reusable VFX document. Validation never discards editor metadata. */
export function parseVfxAsset(json) {
  const doc = typeof json === "string" ? JSON.parse(json) : clone(json);
  if (!doc || doc.version !== 1 || !["particles", "cloth", "water"].includes(doc.kind)) throw new Error("Invalid VFX version or simulation kind.");
  const graph = doc.graph;
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) throw new Error("VFX graph requires nodes and edges.");
  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || !node.id || ids.has(node.id) || typeof node.type !== "string") throw new Error("VFX node IDs must be unique strings.");
    if (doc.kind === "particles" && !Object.hasOwn(P_NODE_TYPES, node.type) && !["__frame", "__reroute"].includes(node.type)) throw new Error(`Unknown particle node ${node.type}.`);
    ids.add(node.id);
  }
  const incoming = new Map();
  const inputKeys = new Set();
  for (const edge of graph.edges) {
    if (!edge || !ids.has(edge.source) || !ids.has(edge.target)) throw new Error("VFX graph contains a dangling connection.");
    const inputKey = JSON.stringify([edge.target, edge.targetHandle]);
    if (inputKeys.has(inputKey)) throw new Error("VFX inputs accept only one connection.");
    inputKeys.add(inputKey);
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge.source);
  }
  const visiting = new Set(), visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error("VFX graph contains a cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const source of incoming.get(id) ?? []) visit(source);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  if (doc.kind !== "particles") evaluateSimulationGraph(doc.kind, graph);
  else {
    if (!graph.nodes.some((node) => node.type === "system")) throw new Error("Particle VFX requires a System node.");
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const edge of graph.edges) {
      const source = byId.get(edge.source), target = byId.get(edge.target);
      const outputs = source.type === "__reroute" ? [{ key: "out" }] : P_NODE_TYPES[source.type]?.outputs ?? [];
      const inputs = target.type === "__reroute" ? [{ key: "in" }] : P_NODE_TYPES[target.type]?.inputs ?? [];
      if (!outputs.some((port) => port.key === (edge.sourceHandle ?? "out")) || !inputs.some((port) => port.key === edge.targetHandle)) throw new Error("Particle VFX contains an invalid connection handle.");
    }
  }
  return doc;
}
export function createVfxAsset(kind, graph) { return parseVfxAsset({ version: 1, kind, graph }); }
export function serializeVfxAsset(doc) { return JSON.stringify(parseVfxAsset(doc), null, 2) + "\n"; }

/** Remove authoring-only helpers for particle compilation, retaining the saved document. */
export function vfxRuntimeGraph(graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const inputs = new Map(graph.edges.map((edge) => [edge.target, edge]));
  const source = (edge, seen = new Set()) => {
    if (!edge || seen.has(edge.source)) return null;
    if (byId.get(edge.source)?.type !== "__reroute") return edge;
    seen.add(edge.source);
    return source(inputs.get(edge.source), seen);
  };
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !["__frame", "__reroute"].includes(node.type)),
    edges: graph.edges.filter((edge) => !["__frame", "__reroute"].includes(byId.get(edge.target)?.type)).flatMap((edge) => {
      const resolved = source(edge);
      return resolved ? [{ ...edge, source: resolved.source, sourceHandle: resolved.sourceHandle }] : [];
    }),
  };
}

/** Missing/malformed assets leave the component's inline fallback available. */
export async function loadVfxAsset(path) {
  const key = keyOf(path);
  if (!key) return null;
  if (cache.has(key)) return clone(cache.get(key));
  if (!pending.has(key)) {
    const task = (async () => {
      try {
        const response = await fetch(await resolveAssetUrl(path));
        if (!response.ok) return cache.get(key) ?? null;
        const doc = parseVfxAsset(await response.json());
        // A save published while fetch was in flight must win.
        if (!cache.has(key)) cache.set(key, doc);
        return cache.get(key);
      } catch { return cache.get(key) ?? null; }
    })();
    pending.set(key, task);
    task.finally(() => { if (pending.get(key) === task) pending.delete(key); });
  }
  return clone(await pending.get(key));
}
export function publishVfxAsset(path, doc) {
  const key = keyOf(path), validated = parseVfxAsset(doc);
  if (!key) throw new Error("VFX asset path is required.");
  cache.set(key, validated);
  for (const cb of listeners.get(key) ?? []) cb(clone(validated));
  return clone(validated);
}
export function subscribeVfxAsset(path, cb) {
  const key = keyOf(path);
  if (!listeners.has(key)) listeners.set(key, new Set());
  const group = listeners.get(key); group.add(cb);
  return () => { group.delete(cb); if (!group.size) listeners.delete(key); };
}

/** One binding per component; cancellation covers reassignment and detach. */
export function bindVfxAsset(component, onChange) {
  component._unbindVfxAsset?.();
  component._vfxAssetGraph = null;
  component.vfxAssetError = null;
  let active = true, revision = 0;
  const path = component.props.asset;
  const apply = (doc) => {
    if (!active) return;
    component._vfxAssetGraph = doc?.kind === component.constructor.type ? doc.graph : null;
    component.vfxAssetError = !doc ? "VFX asset could not be loaded." : doc.kind !== component.constructor.type ? `Expected ${component.constructor.type} VFX, received ${doc.kind}.` : null;
    onChange();
    component.entity?.engine?.emit?.("component-changed", { entityId: component.entity.id, componentType: component.constructor.type, key: "asset" });
    component.entity?.engine?.emit?.("hierarchy-changed");
    component.emit?.("changed", "asset");
  };
  const unsubscribe = path ? subscribeVfxAsset(path, (doc) => { revision++; apply(doc); }) : null;
  if (path) loadVfxAsset(path).then((doc) => { if (revision === 0) apply(doc); });
  component._unbindVfxAsset = () => { active = false; unsubscribe?.(); };
}
