// Surface graphs resolve solver settings; the solver itself runs on the GPU.
// Kept independent of three/React so saved documents can be validated headlessly.
const number = (key, label, value, min, max, step = .1) => ({ key, label, type: "number", default: value, min, max, step });
/**
 * ⚠ A DIRECTION, NOT A MAGNITUDE. Wind was a single number added to +Z, so a
 * curtain could only ever be blown one way — "our wind is only Z, we must be
 * able to choose any direction" (user). A scalar in a saved scene still loads:
 * `applyProps` reads it as [0, 0, wind], which is exactly what it used to mean.
 */
const vector = (key, label, value) => ({ key, label, type: "vec3", default: value });
const input = (key, type = "float") => ({ key, label: key, type });
const select = (key, label, value, options) => ({ key, label, type: "select", default: value, options });
const output = (type) => [{ key: "out", label: "out", type }];
export function simulationNodeTypes(kind) {
  if (!["cloth", "water"].includes(kind)) throw new Error(`Unknown simulation ${kind}`);
  const cloth = kind === "cloth";
  const solverParams = [number("damping", "Velocity retention", cloth ? .99 : .998, 0, 1, .001), ...(cloth
    ? [number("gravity", "Gravity", 9.81, -100, 100), vector("wind", "Wind (m/s²)", [0, 0, 2]), number("stiffness", "Stretch stiffness", .95, 0, 1, .01),
      number("shear", "Shear stiffness", 1, 0, 1, .01), number("bend", "Bend resistance", .1, 0, 1, .01),
      number("gust", "Wind gust strength", 0, 0, 100), number("gustFrequency", "Wind gust frequency", 1, 0, 10),
      select("pinning", "Pinned vertices", "top", ["top", "topCorners", "left", "leftCorners", "none"]),
      select("fabric", "Fabric", "cotton", ["cotton", "silk", "canvas"]),
      { key: "sceneCollision", label: "Scene colliders", type: "boolean", default: true },
      number("collisionRadius", "Contact thickness", .03, .001, 1, .005), number("friction", "Contact friction", .2, 0, 1, .01)]
    : [select("seaState", "Sea state", "custom", ["custom", "pool", "pond", "lake", "ocean"]),
      number("waveSpeed", "Wave speed (x real time)", 1, 0, 100), number("amplitude", "Initial ripple height", 0, 0, 10, .05),
      number("waveHeight", "Wave height (m)", .15, 0, 5, .05), number("waveLength", "Peak wavelength (m)", 4, .1, 1000),
      number("waveOctaves", "Short-wave octaves", 4, 1, 8, 1), number("waveGain", "Spectral tilt", .5, .2, .9, .05),
      number("waveDirection", "Wave direction (degrees)", 0, -180, 180, 1),
      number("current", "Current (m/s)", 0, -100, 100, .01), number("currentDirection", "Current direction (degrees)", 0, -180, 180, 1), number("choppiness", "Choppiness", .35, 0, 1, .01), number("rippleStrength", "Ripple strength", .6, 0, 2, .01), number("surfaceDetail", "Surface detail (normals)", .6, 0, 2, .05), { key: "caustics", label: "Caustics", type: "boolean", default: true }, number("causticIntensity", "Caustic intensity", 1, 0, 3, .05),
      // Off: no medium (the per-pixel fog every material pays), no caustics or
      // light shafts, no water body shell, no refraction of what lies below —
      // the lid shows the deep colour under its reflection. A performance
      // switch for water nobody looks into.
      { key: "underwater", label: "Underwater (medium, caustics, shafts, refraction)", type: "boolean", default: true }])];
  return {
    grid: { label: "Grid", category: "emitter", inputs: [input("width"), input("height"), input("resolution")], outputs: output("grid"), params: [
      number("resolution", "Grid resolution", cloth ? 32 : 128, 4, 512, 1), number("width", "Width", cloth ? 4 : 8, .1, 1000), number("height", "Height / depth", cloth ? 4 : 8, .1, 1000),
    ] },
    [kind]: { label: cloth ? "Cloth Solver" : "Water Solver", category: "simulation", inputs: [input("grid", "grid"), ...solverParams.filter((p) => p.type === "number").map((p) => input(p.key))], outputs: output("simulation"), params: solverParams },
    material: { label: "Surface Material", category: "value", inputs: [input("color", "color"), input("roughness")], outputs: output("surface"), params: [
      { key: "color", label: "Color", type: "color", default: cloth ? "#c85c3c" : "#168aab" }, number("roughness", "Roughness", cloth ? .85 : .15, 0, 1, .01),
      ...(cloth ? [number("sheen", "Fabric sheen", .2, 0, 1, .01),
        { key: "texture", label: "Fabric texture", type: "asset", default: "", exts: ["png", "jpg", "jpeg", "webp", "ktx2"] },
        number("weave", "Weave contrast", .08, 0, 1, .01), number("weaveScale", "Weave density", 80, 1, 500, 1),
      ] : [
        select("style", "Water style", "realistic", ["realistic", "stylized"]),
        { key: "deepColor", label: "Deep water color", type: "color", default: "#063a52" },
        number("waterDepth", "Optical depth (metres)", 2, 0, 100), number("fill", "Fill level", 1, .05, 1, .01), number("saturation", "Water saturation", .45, 0, 1, .01),
        number("transmission", "Refraction / transmission", .75, 0, 1, .01),
        number("foam", "Foam", .5, 0, 1, .01), number("foamThreshold", "Foam contact width (m)", .15, 0, 100, .01),
        number("splash", "Splash (spray amount)", 1, 0, 100, .05), number("splashSize", "Splash size", 1, 0, 100, .05), number("splashSpread", "Splash spread", 1, 0, 100, .05), number("splashScale", "Splash scale (how far it flies)", 1, 0, 100, .05),
        number("godRays", "God rays", 1, 0, 3, .01),
      ]),
    ] },
    output: { label: "Surface Output", category: "system", inputs: [input("sim", "simulation"), input("material", "surface")], outputs: [], params: [
      { key: "castShadow", label: "Cast shadows", type: "boolean", default: true }, { key: "receiveShadow", label: "Receive shadows", type: "boolean", default: true },
    ] },
    number: { label: "Number", category: "value", inputs: [], outputs: output("float"), params: [number("value", "Value", 1)] },
    color: { label: "Color", category: "value", inputs: [], outputs: output("color"), params: [{ key: "value", label: "Color", type: "color", default: "#ffffff" }] },
    add: { label: "Add", category: "math", inputs: [input("a"), input("b")], outputs: output("float"), params: [number("a", "A", 0), number("b", "B", 0)] },
    multiply: { label: "Multiply", category: "math", inputs: [input("a"), input("b")], outputs: output("float"), params: [number("a", "A", 1), number("b", "B", 1)] },
  };
}
export function simulationNodeDefaults(kind, type) {
  const meta = simulationNodeTypes(kind)[type];
  if (!meta) throw new Error(`Unknown ${kind} node ${type}`);
  return Object.fromEntries(meta.params.map((p) => [p.key, p.default]));
}
export function createSimulationGraph(kind, props = {}) {
  const types = ["grid", kind, "material", "output"];
  return { version: 1, nodes: types.map((type, i) => ({
    id: type, type, position: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 400 }, { x: 620, y: 60 }][i],
    props: Object.fromEntries(Object.entries(simulationNodeDefaults(kind, type)).map(([key, value]) => [key, props[key] ?? value])),
  })), edges: [
    { source: "grid", sourceHandle: "out", target: kind, targetHandle: "grid" },
    { source: kind, sourceHandle: "out", target: "output", targetHandle: "sim" },
    { source: "material", sourceHandle: "out", target: "output", targetHandle: "material" },
  ] };
}

export function evaluateSimulationGraph(kind, graph) {
  const registry = simulationNodeTypes(kind);
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) throw new Error("Simulation graph needs nodes and edges.");
  const byId = new Map();
  for (const node of graph.nodes) {
    if (!node.id || byId.has(node.id)) throw new Error("Simulation node IDs must be unique.");
    if (!registry[node.type] && !["__frame", "__reroute"].includes(node.type)) throw new Error(`Unknown simulation node ${node.type}`);
    byId.set(node.id, node);
  }
  const outputs = graph.nodes.filter((node) => node.type === "output");
  if (outputs.length !== 1) throw new Error("A surface simulation needs exactly one Surface Output.");
  const incoming = new Map();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) throw new Error("Simulation graph contains a dangling connection.");
    const key = `${edge.target}:${edge.targetHandle}`;
    if (incoming.has(key)) throw new Error("Only one connection is allowed per input.");
    incoming.set(key, edge);
  }
  const resolveEdge = (edge, seen = new Set()) => {
    if (!edge) return null;
    const node = byId.get(edge.source);
    if (node.type !== "__reroute") return edge;
    if (seen.has(node.id)) throw new Error("Simulation graph contains a cycle.");
    seen.add(node.id);
    return resolveEdge(graph.edges.find((e) => e.target === node.id), seen);
  };
  // Validate unused branches too: reconnecting one must never expose a latent cycle.
  const visit = (id, visiting, visited) => {
    if (visiting.has(id)) throw new Error("Simulation graph contains a cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of graph.edges.filter((e) => e.target === id)) visit(edge.source, visiting, visited);
    visiting.delete(id); visited.add(id);
  };
  const visited = new Set();
  for (const node of graph.nodes) visit(node.id, new Set(), visited);
  for (const edge of graph.edges) {
    const target = byId.get(edge.target);
    if (target.type === "__reroute") continue;
    const resolved = resolveEdge(edge);
    const source = resolved && byId.get(resolved.source);
    const from = source && registry[source.type]?.outputs.find((p) => p.key === (resolved.sourceHandle ?? "out"));
    const to = registry[target.type]?.inputs.find((p) => p.key === edge.targetHandle);
    if (!to || (resolved && (!from || from.type !== to.type))) throw new Error("Incompatible simulation connection.");
  }
  const cache = new Map();
  const evaluate = (node) => {
    if (!node || node.enabled === false) return null;
    if (cache.has(node.id)) return cache.get(node.id);
    const meta = registry[node.type];
    const values = simulationNodeDefaults(kind, node.type);
    for (const p of meta.params) {
      let value = node.props?.[p.key] ?? p.default;
      if (meta.inputs.some((port) => port.key === p.key)) value = read(node.id, p.key) ?? value;
      if (p.type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${meta.label}: ${p.label} must be finite.`);
        value = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, value));
        if (p.key === "resolution") value = Math.round(value);
      } else if (p.type === "color" && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${meta.label}: use a six-digit hex color.`);
      else if (p.type === "select" && !p.options.includes(value)) throw new Error(`${meta.label}: invalid ${p.label}.`);
      else if (p.type === "boolean" && typeof value !== "boolean") throw new Error(`${meta.label}: ${p.label} must be a boolean.`);
      values[p.key] = value;
    }
    let result = values;
    if (node.type === "number" || node.type === "color") result = values.value;
    if (node.type === "add") result = values.a + values.b;
    if (node.type === "multiply") result = values.a * values.b;
    if (node.type === kind) result = { ...(read(node.id, "grid") ?? simulationNodeDefaults(kind, "grid")), ...values };
    if (typeof result === "number" && !Number.isFinite(result)) throw new Error("Simulation expression overflow.");
    cache.set(node.id, result);
    return result;
  };
  const read = (id, key) => {
    const edge = resolveEdge(incoming.get(`${id}:${key}`));
    return edge ? evaluate(byId.get(edge.source)) : null;
  };
  const node = outputs[0];
  const sim = read(node.id, "sim");
  return { ...simulationNodeDefaults(kind, "grid"), ...simulationNodeDefaults(kind, kind), ...simulationNodeDefaults(kind, "material"),
    ...simulationNodeDefaults(kind, "output"), ...sim, ...read(node.id, "material"), ...evaluate(node), simulationEnabled: node.enabled !== false && sim !== null };
}

/** Inspector overrides become explicit graph values; unrelated wiring is kept. */
export function setSimulationGraphProp(kind, graph, key, value) {
  const registry = simulationNodeTypes(kind);
  const copy = structuredClone(graph);
  // Apply to every matching authoring node so switching outputs does not restore stale values.
  const targets = new Set();
  for (const node of copy.nodes) if (registry[node.type]?.params.some((p) => p.key === key)) {
    node.props = { ...node.props, [key]: value }; targets.add(node.id);
  }
  copy.edges = copy.edges.filter((edge) => !(targets.has(edge.target) && edge.targetHandle === key));
  return copy;
}
