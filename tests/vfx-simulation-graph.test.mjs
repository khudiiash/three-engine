import test from "node:test";
import assert from "node:assert/strict";
import { createSimulationGraph, evaluateSimulationGraph, setSimulationGraphProp } from "../src/engine/vfx/simulationGraph.js";
import { graphToFlow, flowToGraph } from "../src/editor/nodegraph/graphUtils.js";

for (const kind of ["cloth", "water"]) {
  test(`${kind}: existing flat settings survive graph creation and JSON roundtrip`, () => {
    const graph = createSimulationGraph(kind, { width: 17, roughness: .42, color: "#112233" });
    const config = evaluateSimulationGraph(kind, JSON.parse(JSON.stringify(graph)));
    assert.equal(config.width, 17); assert.equal(config.roughness, .42); assert.equal(config.color, "#112233");
    assert.equal(config.simulationEnabled, true);
    graph.edges = graph.edges.filter((e) => e.targetHandle !== "sim");
    assert.equal(evaluateSimulationGraph(kind, graph).simulationEnabled, false);
  });
  test(`${kind}: wired math changes grid dimensions; disconnect restores node value`, () => {
    const graph = createSimulationGraph(kind, { width: 6 });
    graph.nodes.push({ id: "number", type: "number", props: { value: 7 } }, { id: "mul", type: "multiply", props: { b: 2 } });
    graph.edges.push({ source: "number", target: "mul", targetHandle: "a" }, { source: "mul", target: "grid", targetHandle: "width" });
    assert.equal(evaluateSimulationGraph(kind, graph).width, 14);
    graph.nodes.find((n) => n.id === "mul").enabled = false;
    assert.equal(evaluateSimulationGraph(kind, graph).width, 6);
    const overridden = setSimulationGraphProp(kind, graph, "width", 9);
    assert.equal(evaluateSimulationGraph(kind, overridden).width, 9);
    assert.equal(graph.edges.length, 5, "inspector override leaves original graph available for undo");
  });
}
test("surface graphs reject cycles, dangling edges and invalid bundle connections", () => {
  const graph = createSimulationGraph("cloth");
  graph.edges.push({ source: "cloth", target: "grid", targetHandle: "width" });
  assert.throws(() => evaluateSimulationGraph("cloth", graph), /cycle/);
  graph.edges.pop();
  graph.edges.push({ source: "missing", target: "grid", targetHandle: "width" });
  assert.throws(() => evaluateSimulationGraph("cloth", graph), /dangling/);
  graph.edges.pop();
  graph.edges.push({ source: "material", target: "grid", targetHandle: "width" });
  assert.throws(() => evaluateSimulationGraph("cloth", graph), /Incompatible/);
});
test("React Flow roundtrip preserves disabled nodes and authoring metadata", () => {
  const graph = createSimulationGraph("cloth");
  Object.assign(graph.nodes[0], { enabled: false, label: "Custom grid", stackSystem: "cloth" });
  const flow = graphToFlow(graph);
  const restored = flowToGraph(flow.nodes, flow.edges);
  assert.equal(restored.nodes[0].enabled, false);
  assert.equal(restored.nodes[0].label, "Custom grid");
  flow.nodes[0].data.props.__enabled = true;
  assert.equal(flowToGraph(flow.nodes, flow.edges).nodes[0].enabled, true);
});
