import assert from "node:assert/strict";
import test from "node:test";
import { DepthTexture, DirectionalLight, PerspectiveCamera } from "three/webgpu";
import * as TSL from "three/tsl";
import { godrays } from "three/addons/tsl/display/GodraysNode.js";
import { compilePostGraph } from "../src/modules/postprocessing/postGraph.js";

/**
 * GOD RAYS → THE DEPTH-AWARE COMPOSITE, AND WHAT IT WILL ACCEPT.
 *
 * Run with `node --test tests/post-godrays.test.mjs`.
 *
 * The bug this pins (user, 2026-08-23 — "input → god rays → output"):
 *
 *     THREE.TSL: TypeError: blendNode.sample is not a function
 *
 * `depthAwareBlend` samples all three of its inputs at SHIFTED uvs — that is
 * the whole point of it, pushing the sample away from a depth edge so the
 * rays do not halo — so each one has to be texture-LIKE. `GodraysNode` is a
 * `TempNode`; the thing with `.sample()` is the `passTexture` wrapper it
 * builds internally and hands out through `getTextureNode()`, which is also
 * what three's own usage example composites.
 *
 * ⚠ WHY A UNIT TEST AND NOT AN EYE: the failure is a THROW during TSL build,
 * on a stack that names no graph node and no effect type, and it takes the
 * user's whole post chain with it. It is exactly the shape a cheap CPU-side
 * assertion catches and a screenshot does not.
 */

const CAMERA = new PerspectiveCamera(50, 1, 0.1, 1000);

/** A directional light with just enough shadow for GodraysNode to build. */
function shadowCastingLight() {
  const light = new DirectionalLight(0xffffff, 1);
  light.castShadow = true;
  // The builder gates on this exact path before it constructs anything (a
  // light can lose its map by switching Shadow Source to "gi"), and
  // GodraysNode reads the depth texture at construction.
  light.shadow.map = { depthTexture: new DepthTexture(4, 4) };
  return light;
}

/** `input → godrays → output`, wired the way the panel wires it. */
const GODRAYS_GRAPH = {
  nodes: [
    { id: "in", type: "input", props: {}, position: { x: 0, y: 0 } },
    { id: "gr", type: "godrays", props: {}, position: { x: 0, y: 0 } },
    { id: "out", type: "output", props: {}, position: { x: 0, y: 0 } },
  ],
  edges: [
    { source: "in", sourceHandle: "color", target: "gr", targetHandle: "color" },
    { source: "in", sourceHandle: "depth", target: "gr", targetHandle: "depth" },
    { source: "gr", sourceHandle: "out", target: "out", targetHandle: "color" },
  ],
};

/**
 * Compiles the graph with a REAL `godrays` and a recording `depthAwareBlend`,
 * so the assertion is about what the builder hands the addon rather than about
 * a stub of our own.
 *
 * `beautyNode`/`depthNode` are real texture nodes because the composite path
 * is gated on them being samplable — passing `vec4(0)` would take the additive
 * fallback and the test would pass while proving nothing.
 */
function compileGodrays({ colorSamplable = true, depthSamplable = true } = {}) {
  const seen = [];
  const samplableNode = (value) => {
    const node = TSL.nodeObject(value);
    node.sample = () => node;
    return node;
  };
  const beautyNode = colorSamplable ? samplableNode(TSL.vec4(0, 0, 0, 1)) : TSL.vec4(0, 0, 0, 1);
  const depthNode = depthSamplable ? samplableNode(TSL.float(0.5)) : TSL.float(0.5);
  const compiled = compilePostGraph(GODRAYS_GRAPH, {
    camera: CAMERA,
    beautyNode,
    depthNode,
    normalNode: TSL.vec3(0, 1, 0),
    metalnessNode: TSL.float(1),
    roughnessNode: TSL.float(0.2),
    temps: new Set(),
    godrays,
    godraysLight: shadowCastingLight(),
    depthAwareBlend: (base, blend, depth, camera) => {
      seen.push({ base, blend, depth, camera });
      return base;
    },
  });
  return { compiled, seen };
}

test("the composite receives a SAMPLABLE blend node, not the GodraysNode", () => {
  const { seen } = compileGodrays();
  assert.equal(seen.length, 1, "the depth-aware composite ran");
  const { blend } = seen[0];
  // The regression, stated as the thing that actually threw.
  assert.equal(
    typeof blend.sample, "function",
    "depthAwareBlend samples the blend node at a shifted uv — a TempNode has no .sample",
  );
  // And it must still be the god rays result, not some other node that
  // happens to be samplable.
  assert.ok(blend.isTextureNode || blend.isPassTextureNode, "the blend node is the effect's texture node");
});

test("GodraysNode itself is NOT samplable — this is why the wrapper is needed", () => {
  // If a three upgrade ever gives GodraysNode its own `.sample`, the fix above
  // becomes redundant rather than wrong — but we should find out from here and
  // not from a stack trace.
  const node = godrays(TSL.float(0.5), CAMERA, shadowCastingLight());
  assert.equal(typeof node.sample, "undefined");
  assert.equal(typeof node.getTextureNode, "function");
});

test("an unsamplable input degrades to the additive composite instead of throwing", () => {
  // The base colour is not always a texture node (a chain can hand god rays a
  // computed colour). That must lose the soft edge handling, never the build.
  const { seen, compiled } = compileGodrays({ colorSamplable: false });
  assert.equal(seen.length, 0, "the depth-aware path was skipped");
  assert.ok(compiled, "the graph still compiled");
});

test("an unsamplable DEPTH also degrades rather than throwing", () => {
  // depthAwareBlend.js:55 samples the depth node too, so it is gated on the
  // same rule — this arm exists because the first version of the guard
  // checked only the base colour.
  const { seen, compiled } = compileGodrays({ depthSamplable: false });
  assert.equal(seen.length, 0, "the depth-aware path was skipped");
  assert.ok(compiled, "the graph still compiled");
});
