import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import {
  compilePostGraph,
  INPUT_PORT_LABELS,
  loadTRAA,
  PP_NODE_TYPES,
} from "../src/modules/postprocessing/postGraph.js";

assert.equal(INPUT_PORT_LABELS.velocity, "Velocity");
assert.deepEqual(
  PP_NODE_TYPES.traa.inputs.map((input) => input.key),
  ["color", "depth", "velocity"],
);

const traa = await loadTRAA();
assert.equal(typeof traa, "function");

const texture = new THREE.Texture();
const colorNode = TSL.texture(texture);
const depthNode = TSL.texture(texture);
const velocityNode = TSL.texture(texture);
const graph = {
  nodes: [
    { id: "input", type: "input", props: {} },
    { id: "traa", type: "traa", props: {} },
    { id: "output", type: "output", props: {} },
  ],
  edges: [
    { source: "input", sourceHandle: "color", target: "traa", targetHandle: "color" },
    { source: "input", sourceHandle: "depth", target: "traa", targetHandle: "depth" },
    { source: "input", sourceHandle: "velocity", target: "traa", targetHandle: "velocity" },
    { source: "traa", sourceHandle: "out", target: "output", targetHandle: "color" },
  ],
};
const compiled = compilePostGraph(graph, {
  camera: new THREE.PerspectiveCamera(),
  beautyNode: colorNode,
  depthNode,
  velocityNode,
  traa,
});

assert.equal(compiled.output.isTRAANode, true);

const originalWarn = console.warn;
console.warn = () => {};
const msaaCompiled = compilePostGraph(graph, {
  camera: new THREE.PerspectiveCamera(),
  beautyNode: colorNode,
  depthNode,
  velocityNode,
  traa,
  msaaEnabled: true,
});
console.warn = originalWarn;
assert.equal(msaaCompiled.output, colorNode, "TRAA safely bypasses while MSAA is enabled");
console.log("TRAA post-process graph checks passed.");
