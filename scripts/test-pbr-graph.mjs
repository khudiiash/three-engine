// Regression test for the PBR graph builder's prop keys + edge handles.
//
// `buildPbrGraph` builds a Principled BSDF graph. The runtime compile
// (`compileShaderGraph` from `tslGraph.js`) reads `node.props[<input.key>]`
// where `<input.key>` matches the panel's input spec (e.g. `color`,
// `specularIntensity`, `emissive`). If `buildPbrGraph` writes the diffuse
// color under a different key than the compile reads, the value is silently
// dropped and the mesh renders with the default.
//
// Run: node scripts/test-pbr-graph.mjs
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { setAssetResolver } from "../src/engine/assetResolver.js";
import { compileShaderGraph } from "../src/engine/tslGraph.js";
import { buildPbrGraph } from "../src/editor/pbrMaterialGraph.js";

setAssetResolver(async (path) => path);

// --- Test 1: factor keys land in the props the runtime compile reads ----
{
  const { nodes } = buildPbrGraph({}, { factors: { color: "#ff0000" } });
  const bsdf = nodes.find((n) => n.type === "principledBsdf");
  assert.ok(bsdf, "graph contains a Principled BSDF node");
  assert.equal(
    bsdf.props.color,
    "#ff0000",
    "factors.color lands in Principled.props.color (tslGraph compile key)",
  );
  console.log("ok: factors.color → Principled.props.color");
}

{
  const { nodes } = buildPbrGraph({}, { factors: { specularColor: "#8888ff" } });
  const bsdf = nodes.find((n) => n.type === "principledBsdf");
  assert.equal(bsdf.props.specularColor, "#8888ff", "factors.specularColor → Principled.props.specularColor");
  console.log("ok: factors.specularColor → Principled.props.specularColor");
}

{
  const { nodes } = buildPbrGraph({}, { factors: { specularIntensity: 0.75 } });
  const bsdf = nodes.find((n) => n.type === "principledBsdf");
  assert.equal(bsdf.props.specularIntensity, 0.75, "factors.specularIntensity → Principled.props.specularIntensity");
  console.log("ok: factors.specularIntensity → Principled.props.specularIntensity");
}

{
  const { nodes } = buildPbrGraph({}, { factors: { opacity: 0.42 } });
  const bsdf = nodes.find((n) => n.type === "principledBsdf");
  assert.equal(bsdf.props.opacity, 0.42, "factors.opacity → Principled.props.opacity");
  console.log("ok: factors.opacity → Principled.props.opacity");
}

{
  const { nodes } = buildPbrGraph({}, { factors: { emissive: "#ff8800" } });
  const bsdf = nodes.find((n) => n.type === "principledBsdf");
  assert.equal(bsdf.props.emissive, "#ff8800", "factors.emissive → Principled.props.emissive");
  console.log("ok: factors.emissive → Principled.props.emissive");
}

{
  const { nodes } = buildPbrGraph({}, { factors: { thickness: 0.3 } });
  const bsdf = nodes.find((n) => n.type === "principledBsdf");
  assert.equal(bsdf.props.thickness, 0.3, "factors.thickness → Principled.props.thickness");
  console.log("ok: factors.thickness → Principled.props.thickness");
}

// --- Test 2: end-to-end compile of the builder's output ---------------
// Catches the case where the prop key is right but the edge targetHandle
// doesn't match — the compile reads `edges.find(e.targetHandle === handle)`
// so a mismatch silently drops the wired value.
{
  const { nodes, edges } = buildPbrGraph({}, { factors: { color: "#00ff00" } });
  const result = await compileShaderGraph({ nodes, edges });
  assert.ok(result, "PBR graph compiles");
  assert.ok(result.mutations, "mutations present");
  assert.ok(result.mutations.colorNode, "colorNode populated from factors.color");
  console.log("ok: PBR graph compiles and propagates factors.color to colorNode");
}

// --- Test 4: end-to-end legacy migration reproduces the "Red.mat renders
//              white" bug. A .mat with a stored `color` field that gets
//              migrated into a Principled BSDF must end up with `colorNode =
//              color(<stored color>)`. If the migration used the legacy
//              `baseColor` prop key, the runtime compile would default to
//              white and the mesh would render white.
{
  const { migrateLegacyGraph } = await import("../src/engine/shaderGraph.js");
  const legacy = {
    nodes: [
      { id: "c", type: "color", props: { value: "#112233" }, position: { x: 0, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "c", sourceHandle: "out", target: "o", targetHandle: "color" }],
  };
  const def = { color: "#ff0000", roughness: 0.5, metalness: 0 };
  const migrated = migrateLegacyGraph(legacy, def);
  // Sanity: migration seeded the tslGraph prop key, not the legacy one.
  const principled = migrated.nodes.find((n) => n.type === "principledBsdf");
  assert.equal(principled.props.color, "#ff0000", "migrated BSDF has the user's color under the tslGraph key");
  const result = await compileShaderGraph(migrated);
  assert.ok(result?.mutations?.colorNode, "colorNode populated by migrated graph");
  console.log("ok: legacy migration → runtime compile → colorNode survives end-to-end");
}

// --- Test 4b: legacy BSDF prop names (`baseColor`, `specular`, etc.)
//               authored by the previous shaderGraph.js runtime must still
//               render the right color in the current tslGraph runtime.
//               Without normalization the compile reads `node.props.color`
//               and gets the spec default white.
{
  const { migrateLegacyGraph } = await import("../src/engine/shaderGraph.js");
  // Looks like a modern BSDF graph but uses legacy prop names.
  const legacyStyled = {
    nodes: [
      {
        id: "bsdf", type: "principledBsdf",
        props: {
          baseColor: "#ff8800",
          roughness: 0.4,
          metalness: 0.1,
          ior: 1.5,
          specular: 0.5,
          specularTint: 0.2,
          anisotropic: 0,
          sheen: 0,
          sheenTint: 0.5,
          sheenRoughness: 0.3,
          clearcoat: 0,
          clearcoatRoughness: 0.03,
          transmission: 0,
          transmissionRoughness: 0,
          emission: "#000000",
          emissionStrength: 1,
          alpha: 1,
        },
        position: { x: 0, y: 0 },
      },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "bsdf", sourceHandle: "surface", target: "o", targetHandle: "surface" }],
  };
  const migrated = migrateLegacyGraph(legacyStyled, {});
  const result = await compileShaderGraph(migrated);
  assert.ok(result?.mutations?.colorNode, "legacy BSDF prop names → runtime colorNode");
  console.log("ok: legacy BSDF prop names normalized to tslGraph at runtime");
}

// --- Test 5: every tslGraph shader-node input spec has a .key ----------
// The editor panel reads `spec.key` to render labels/handles; a missing
// `key` would break the panel UI.
{
  const { NODE_TYPES } = await import("../src/engine/tslGraph.js");
  for (const type of ["principledBsdf", "emission"]) {
    for (const input of NODE_TYPES[type].inputs ?? []) {
      assert.ok(
        typeof input.key === "string" && input.key.length > 0,
        `${type} input has a non-empty .key (got ${JSON.stringify(input.key)})`,
      );
    }
  }
  console.log("ok: every tslGraph shader-node input spec has a .key");
}

console.log("All PBR-graph checks passed.");
