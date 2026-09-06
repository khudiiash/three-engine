import { P_NODE_TYPES, nodeDefaults } from "../engine/particleGraph.js";
import { stripHelpers } from "./nodegraph/graphUtils.js";

// The stack is an authoring view of the existing graph document. No conversion
// on load: shared branches, custom expressions and layout metadata survive.
export const VFX_MODULES = [
  ...Object.entries(P_NODE_TYPES).filter(([, m]) => m.category === "emitter").map(([type, m]) => ({ id: type, label: m.label, group: "Spawn", type })),
  ...Object.entries(P_NODE_TYPES).filter(([, m]) => m.category === "force").map(([type, m]) => ({ id: type, label: m.label, group: "Motion", type })),
  { id: "gradient", label: "Color over life", group: "Appearance", type: "gradient", target: "color" },
  { id: "color", label: "Solid color", group: "Appearance", type: "color", target: "color" },
  { id: "size", label: "Size", group: "Appearance", type: "float", target: "size", props: { value: 0.1 } },
  { id: "sizeLife", label: "Size over life", group: "Appearance", type: "remap", target: "size", props: { outMin: 0.15, outMax: 0 } },
  { id: "opacity", label: "Fade over life", group: "Appearance", type: "remap", target: "opacity", props: { outMin: 1, outMax: 0 } },
];

export function nextVfxId(graph, prefix = "vfx") {
  const ids = new Set(graph.nodes.map((node) => node.id));
  let i = 1;
  while (ids.has(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

export function connectVfxInput(graph, target, targetHandle, source, sourceHandle = "out") {
  const targetNode = graph.nodes.find((node) => node.id === target);
  const input = P_NODE_TYPES[targetNode?.type]?.inputs?.find((port) => port.key === targetHandle);
  if (!input) throw new Error("Unknown VFX input.");
  const edges = graph.edges.filter((edge) => edge.target !== target || edge.targetHandle !== targetHandle);
  if (source) {
    const sourceNode = graph.nodes.find((node) => node.id === source);
    const output = P_NODE_TYPES[sourceNode?.type]?.outputs?.find((port) => port.key === sourceHandle);
    if (!output) throw new Error("Unknown VFX output.");
    if (!vfxPortsCompatible(output.type, input.type)) throw new Error("These VFX input and output types are incompatible.");
    // A dropdown must not make it possible to create a recursive expression.
    const seen = new Set();
    const reaches = (id) => {
      if (id === target) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return edges.filter((edge) => edge.target === id).some((edge) => reaches(edge.source));
    };
    if (reaches(source)) throw new Error("This input would create a cycle.");
    edges.push({ source, sourceHandle, target, targetHandle });
  }
  return { ...graph, edges };
}

export function vfxPortsCompatible(output, input) {
  return output === input || output === "any" || input === "any" || output === "float" || (output === "color" && input === "vec3") || (output === "vec3" && input === "color");
}

export function addVfxNode(graph, type, systemId) {
  if (!P_NODE_TYPES[type]) throw new Error(`Unknown VFX module: ${type}`);
  const id = nextVfxId(graph);
  const node = { id, type, props: nodeDefaults(type), position: { x: 0, y: graph.nodes.length * 100 }, stackSystem: systemId };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, id };
}

export function addVfxModule(graph, systemId, recipe) {
  if (!graph.nodes.some((node) => node.id === systemId && node.type === "system")) throw new Error("Select a simulation first.");
  let { graph: next, id } = addVfxNode(graph, recipe.type, systemId);
  next = { ...next, nodes: next.nodes.map((node) => node.id === id ? { ...node, label: recipe.label, props: { ...node.props, ...recipe.props } } : node) };
  const category = P_NODE_TYPES[recipe.type].category;
  if (category === "emitter") {
    next = connectVfxInput(next, systemId, "position", id, "pos");
    next = connectVfxInput(next, systemId, "velocity", id, "dir");
  } else if (category === "force") {
    const previous = stripHelpers(next).edges.find((edge) => edge.target === systemId && edge.targetHandle === "force");
    if (previous) {
      const added = addVfxNode(next, "add", systemId);
      next = connectVfxInput(added.graph, added.id, "a", previous.source, previous.sourceHandle);
      next = connectVfxInput(next, added.id, "b", id);
      next = connectVfxInput(next, systemId, "force", added.id);
    } else next = connectVfxInput(next, systemId, "force", id);
  } else if (recipe.target) next = connectVfxInput(next, systemId, recipe.target, id);
  return { graph: next, id };
}

export function vfxBranchIds(graph, systemId) {
  const ids = new Set();
  const visit = (id) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const edge of graph.edges) if (edge.target === id) visit(edge.source);
  };
  visit(systemId);
  return ids;
}

export function removeVfxNode(graph, id) {
  const node = graph.nodes.find((item) => item.id === id);
  if (node?.type === "system" && graph.nodes.filter((item) => item.type === "system").length <= 1) throw new Error("Keep at least one simulation.");
  return { ...graph, nodes: graph.nodes.filter((item) => item.id !== id), edges: graph.edges.filter((edge) => edge.source !== id && edge.target !== id) };
}
