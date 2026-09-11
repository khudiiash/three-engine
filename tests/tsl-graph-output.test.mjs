// The Material Output as the three.js material.
//
// The contract: one Output socket per `*Node` slot the chosen material class
// reads, the retired Principled BSDF / Emission graphs migrate into direct
// wires WITHOUT changing what they render, and no channel three treats as a
// feature switch is ever populated unless the user actually asked for it.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MATERIAL_CLASS,
  MATERIAL_CLASSES,
  MATERIAL_NODE_SLOTS,
  NODE_TYPES,
  OUTPUT_SLOT_SPECS,
  compileShaderGraph,
  generateTslCode,
  materialClassOf,
  migrateGraph,
  outputSlotsFor,
} from "../src/engine/tslGraph.js";

const output = (props = {}, id = "out") => ({ id, type: "output", props, position: { x: 0, y: 0 } });
const graph = (nodes, edges = []) => ({ nodes, edges });
const slotsOf = (result) => Object.keys(result.mutations).sort();

// ── the registry itself ─────────────────────────────────────────────────────

test("every Output socket names a real three.js material slot", () => {
  // The whole point of the rework: these keys are not our vocabulary, they are
  // three's. A typo here is a slot that silently never renders.
  for (const spec of OUTPUT_SLOT_SPECS) {
    if (spec.key === "volume") continue;
    assert.match(spec.slot, /Node$/, `${spec.key} -> ${spec.slot}`);
    assert.ok(spec.on.length > 0, `${spec.key} is readable by no material class`);
    for (const cls of spec.on) assert.ok(MATERIAL_CLASSES[cls], `${spec.key}: unknown class ${cls}`);
  }
});

test("the Output exposes every slot the asset layer clears", () => {
  // MATERIAL_NODE_SLOTS is what applyGraphMutations nulls between compiles. A
  // slot the Output can drive but that list forgets would leak across edits.
  const fromOutput = OUTPUT_SLOT_SPECS.filter((s) => s.slot).map((s) => s.slot);
  assert.deepEqual([...MATERIAL_NODE_SLOTS].sort(), [...fromOutput].sort());
});

test("the Blender shader nodes are gone from the palette", () => {
  assert.equal(NODE_TYPES.principledBsdf, undefined);
  assert.equal(NODE_TYPES.emission, undefined);
  assert.ok(!Object.values(NODE_TYPES).some((d) => d.cat === "shader"));
});

test("a material class only exposes the slots three gives that class", () => {
  const keys = (cls) => new Set(outputSlotsFor(cls).map((s) => s.key));
  const physical = keys("physical");
  const standard = keys("standard");
  const basic = keys("basic");

  // Physical is the superset; Basic has neither the PBR pair nor the extras.
  assert.ok(physical.has("clearcoat") && physical.has("iridescence") && physical.has("transmission"));
  assert.ok(standard.has("roughness") && !standard.has("clearcoat"));
  assert.ok(!basic.has("roughness") && !basic.has("metalness"));
  assert.ok(basic.has("color") && basic.has("opacity"));
  // Class-specific slots stay on their class.
  assert.ok(keys("phong").has("shininess") && !physical.has("shininess"));
  assert.ok(keys("points").has("size") && !physical.has("size"));
  assert.ok(keys("sprite").has("rotation") && !physical.has("rotation"));
  assert.ok(keys("volume").has("volume") && !physical.has("volume"));
});

// ── the feature-switch rule ─────────────────────────────────────────────────

test("an untouched Output drives only the channels a plain surface already pays for", async () => {
  // three's useClearcoat / useTransmission / useIridescence / useSheen /
  // useAnisotropy getters switch their lighting path ON the instant the node
  // is non-null, even at 0. A default graph that populated them would make
  // every material in the project pay for features nobody asked for.
  const result = await compileShaderGraph(graph([output()]));
  assert.deepEqual(slotsOf(result), [
    "aoNode",
    "colorNode",
    "emissiveNode",
    "iorNode",
    "metalnessNode",
    "opacityNode",
    "roughnessNode",
    "specularColorNode",
    "specularIntensityNode",
  ]);
});

test("wiring a channel is what turns it on", async () => {
  const g = graph(
    [output(), { id: "f", type: "float", props: { value: 0.4 } }],
    [{ source: "f", sourceHandle: "out", target: "out", targetHandle: "clearcoat" }],
  );
  const result = await compileShaderGraph(g);
  assert.ok(result.mutations.clearcoatNode, "clearcoat wired");
  assert.equal(result.mutations.transmissionNode, undefined, "transmission left alone");
});

test("slots the chosen class cannot read are not assigned", async () => {
  // The wire stays in the saved graph so switching back restores it, but a
  // MeshBasicNodeMaterial must never be handed a roughnessNode.
  const g = graph(
    [output({ material: "basic" }), { id: "f", type: "float", props: { value: 0.2 } }],
    [{ source: "f", sourceHandle: "out", target: "out", targetHandle: "roughness" }],
  );
  const result = await compileShaderGraph(g);
  assert.equal(result.materialClass, "basic");
  assert.equal(result.mutations.roughnessNode, undefined);
  assert.ok(result.mutations.colorNode, "basic still drives colour");
});

// ── migration ───────────────────────────────────────────────────────────────

const legacyBsdf = (props = {}, extraNodes = [], extraEdges = []) =>
  graph(
    [{ id: "bsdf", type: "principledBsdf", props, position: { x: 0, y: 0 } }, output(), ...extraNodes],
    [{ source: "bsdf", sourceHandle: "out", target: "out", targetHandle: "surface" }, ...extraEdges],
  );

test("a Principled BSDF becomes Output props, values intact", () => {
  const m = migrateGraph(legacyBsdf({ color: "#336699", roughness: 0.25, metalness: 1, ior: 1.7 }));
  assert.ok(!m.nodes.some((n) => n.type === "principledBsdf"), "the BSDF is gone");
  const out = m.nodes.find((n) => n.type === "output");
  assert.equal(out.props.color, "#336699");
  assert.equal(out.props.roughness, 0.25);
  assert.equal(out.props.metalness, 1);
  assert.equal(out.props.ior, 1.7);
  assert.equal(m.edges.length, 0, "the surface edge is consumed, not left dangling");
});

test("a wire into a BSDF channel re-targets to the same Output socket", () => {
  const m = migrateGraph(
    legacyBsdf(
      {},
      [{ id: "t", type: "texture", props: { path: "a.png" }, position: { x: 0, y: 0 } }],
      [{ source: "t", sourceHandle: "out", target: "bsdf", targetHandle: "color" }],
    ),
  );
  assert.deepEqual(m.edges, [{ source: "t", sourceHandle: "out", target: "out", targetHandle: "color" }]);
});

test("migration is idempotent", () => {
  const once = migrateGraph(legacyBsdf({ color: "#abcdef", roughness: 0.3 }));
  const twice = migrateGraph(once);
  assert.deepEqual(twice, once);
});

test("an Emission shader migrates to its constants plus emissive", () => {
  const g = graph(
    [{ id: "em", type: "emission", props: { color: "#ff8800", strength: 1 }, position: { x: 0, y: 0 } }, output()],
    [{ source: "em", sourceHandle: "out", target: "out", targetHandle: "surface" }],
  );
  const out = migrateGraph(g).nodes.find((n) => n.type === "output");
  // An Emission surface was black, fully rough and non-metal — its only light
  // is its own. Those constants have to be spelled out now.
  assert.equal(out.props.color, "#000000");
  assert.equal(out.props.roughness, 1);
  assert.equal(out.props.metalness, 0);
  assert.equal(out.props.emissive, "#ff8800");
});

test("a wired emissive strength survives as an explicit Multiply", async () => {
  // three applies `emissiveIntensity` to `material.emissive` but NOT to
  // `emissiveNode`, so the strength cannot just be dropped.
  const m = migrateGraph(
    legacyBsdf(
      { emissive: "#ffffff" },
      [{ id: "f", type: "float", props: { value: 3 }, position: { x: 0, y: 0 } }],
      [{ source: "f", sourceHandle: "out", target: "bsdf", targetHandle: "emissiveStrength" }],
    ),
  );
  const mul = m.nodes.find((n) => n.type === "multiply");
  assert.ok(mul, "a Multiply carries the strength");
  assert.ok(
    m.edges.some((e) => e.source === mul.id && e.target === "out" && e.targetHandle === "emissive"),
    "and it feeds the Output's emissive",
  );
  assert.equal(m.nodes.find((n) => n.type === "output").props.emissive, undefined, "no stale constant left behind");
  const result = await compileShaderGraph(m);
  assert.ok(result.mutations.emissiveNode, "and it still compiles to an emissive node");
});

test("a legacy Volume graph keeps its material class", () => {
  const g = graph(
    [{ id: "v", type: "volumeScatter", props: { steps: 16 }, position: { x: 0, y: 0 } }, output()],
    [{ source: "v", sourceHandle: "out", target: "out", targetHandle: "volume" }],
  );
  // Readable before migration (the asset layer picks the class up front) and
  // written down by it.
  assert.equal(materialClassOf(g), "volume");
  assert.equal(migrateGraph(g).nodes.find((n) => n.type === "output").props.material, "volume");
});

test("a migrated BSDF compiles to the same slots the BSDF drove", async () => {
  const result = await compileShaderGraph(migrateGraph(legacyBsdf({ color: "#112233", roughness: 0.9 })));
  assert.equal(result.materialClass, DEFAULT_MATERIAL_CLASS);
  assert.deepEqual(slotsOf(result), [
    "aoNode",
    "colorNode",
    "emissiveNode",
    "iorNode",
    "metalnessNode",
    "opacityNode",
    "roughnessNode",
    "specularColorNode",
    "specularIntensityNode",
  ]);
});

// ── code generation ─────────────────────────────────────────────────────────

test("generated code assigns material slots and names the class", () => {
  const code = generateTslCode(graph([output({ material: "standard", color: "#ff0000" })]));
  assert.match(code, /new THREE\.MeshStandardNodeMaterial\(\)/);
  assert.match(code, /material\.colorNode = color\('#ff0000'\)/);
  assert.match(code, /material\.roughnessNode = /);
  // Standard has no clearcoat to emit.
  assert.ok(!code.includes("clearcoatNode"));
});

test("volume graphs compile through the bundle, not a slot assignment", async () => {
  const g = graph(
    [{ id: "v", type: "volumeScatter", props: { steps: 8 }, position: { x: 0, y: 0 } }, output({ material: "volume" })],
    [{ source: "v", sourceHandle: "out", target: "out", targetHandle: "volume" }],
  );
  const result = await compileShaderGraph(g);
  assert.equal(result.materialClass, "volume");
  assert.equal(result.isVolume, true);
  assert.ok(result.mutations.__volume, "the raymarch bundle is what reaches the asset layer");
  assert.equal(result.mutations.__volume.steps, 8);
  assert.equal(result.mutations.colorNode, undefined, "a volume drives no surface slot");
});

// ── the importer ────────────────────────────────────────────────────────────
// buildPbrGraph is what every GLB / Poly Haven import writes. Its output has to
// land on the stock-PBR fast path, or the whole import wave pays for a program
// each (§13.15).

const { buildPbrGraph } = await import("../src/editor/pbrMaterialGraph.js");
const { matchStockPbr } = await import("../src/engine/tslGraph.js");

test("an imported PBR graph wires straight into the Output", () => {
  const g = buildPbrGraph({ diffuse: "d.png", arm: "orm.png", normal: "n.png" });
  assert.ok(!g.nodes.some((n) => n.type === "principledBsdf"), "no BSDF middleman");
  const out = g.nodes.find((n) => n.type === "output");
  const targets = new Set(g.edges.filter((e) => e.target === out.id).map((e) => e.targetHandle));
  assert.ok(targets.has("color") && targets.has("roughness") && targets.has("metalness") && targets.has("normal"));
  assert.ok(!targets.has("surface"), "the surface socket is retired");
});

test("the canonical import shape still reaches the stock-PBR fast path", () => {
  const stock = matchStockPbr(buildPbrGraph({ diffuse: "d.png", arm: "orm.png", normal: "n.png" }, { armHasAo: false }));
  assert.ok(stock, "matched");
  assert.equal(stock.map, "d.png");
  assert.equal(stock.normalMap, "n.png");
  assert.equal(stock.roughnessMap, "orm.png");
  assert.equal(stock.metalnessMap, "orm.png");
  // A wired channel REPLACES the scalar on the graph path while three
  // MULTIPLIES the map by it, so the factors have to be pinned to 1.
  assert.equal(stock.roughness, 1);
  assert.equal(stock.metalness, 1);
});

test("emissive strength is emitted as a real Multiply, not dropped", async () => {
  // No emissive MAP here on purpose: a texture node cannot decode without a
  // DOM, so anything downstream of one compiles to null in this runner. The
  // constant path exercises the same rewrite.
  const g = buildPbrGraph({}, { factors: { emissive: "#ffffff", emissiveStrength: 4 } });
  const mul = g.nodes.find((n) => n.id === "mul_emissiveStrength");
  assert.ok(mul, "the strength is a node");
  assert.ok(
    g.edges.some((e) => e.source === mul.id && e.target === "out" && e.targetHandle === "emissive"),
    "feeding the Output's emissive",
  );
  const out = g.nodes.find((n) => n.type === "output");
  assert.equal(out.props.emissive, undefined, "and the constant it replaced is gone");
  const result = await compileShaderGraph(g);
  assert.ok(result.mutations.emissiveNode, "and it compiles");
});

test("an emissive MAP is multiplied by the strength too", () => {
  const g = buildPbrGraph({ emissive: "e.png" }, { factors: { emissiveStrength: 4 } });
  const mul = g.nodes.find((n) => n.id === "mul_emissiveStrength");
  assert.ok(mul, "the strength is a node");
  // The texture's edge is re-pointed INTO the multiply rather than left racing
  // it for the same socket.
  assert.ok(g.edges.some((e) => e.source === "tex_emissive" && e.target === mul.id && e.targetHandle === "a"));
  assert.equal(g.edges.filter((e) => e.target === "out" && e.targetHandle === "emissive").length, 1);
});

test("emissive strength of 1 leaves the graph alone", () => {
  const g = buildPbrGraph({ diffuse: "d.png" }, { factors: { emissiveStrength: 1 } });
  assert.ok(!g.nodes.some((n) => n.id === "mul_emissiveStrength"));
  assert.ok(matchStockPbr(g), "so the material still reaches the fast path");
});
