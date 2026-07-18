// Reproduces the user's exact scenario: a mesh with a .mat that has a
// Principled BSDF whose `color` input is set to red. Verifies that the
// shared material instance ends up with colorNode populated after a
// loadMaterialAsset round-trip with a stub fetch.
//
// Run: node scripts/test-material-render.mjs
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { setAssetResolver } from "../src/engine/assetResolver.js";
import { compileShaderGraph } from "../src/engine/tslGraph.js";

setAssetResolver(async (path) => path);

// --- Test 1: compileShaderGraph directly ---------------------------------
// Build the user's graph and confirm the compile populates colorNode.
{
  const graph = {
    nodes: [
      {
        id: "bsdf",
        type: "principledBsdf",
        props: {
          color: "#ff0000",
          roughness: 0.5,
          metalness: 0,
          ior: 1.5,
          specular: 0.5,
          specularColor: "#ffffff",
          emissive: "#000000",
          emissiveStrength: 1,
          alpha: 1,
        },
        position: { x: 200, y: 120 },
      },
      { id: "output", type: "output", props: {}, position: { x: 560, y: 150 } },
    ],
    edges: [{ source: "bsdf", sourceHandle: "out", target: "output", targetHandle: "surface" }],
  };
  const result = await compileShaderGraph(graph);
  assert.ok(result, "compile returned a result");
  assert.ok(result.mutations, "mutations present");
  assert.ok(result.mutations.colorNode, "colorNode populated from BSDF.color input");
  console.log("ok: compileShaderGraph produces colorNode for red BSDF");
}

// --- Test 2: loadMaterialAsset full round-trip ----------------------------
// Stubs fetch to return a .mat JSON, then verifies the cached material has
// colorNode populated after the async compile lands.
{
  // Intercept the URL resolution to give a synthetic .mat body. Use the
  // global `fetch` (loadMaterialAsset uses it for tauri asset URLs).
  const fakeMaterialJson = JSON.stringify({
    color: "#ffffff",
    roughness: 0.5,
    metalness: 0,
    shaderGraph: {
      nodes: [
        {
          id: "bsdf",
          type: "principledBsdf",
          props: { color: "#ff0000", roughness: 0.5, metalness: 0, ior: 1.5, specular: 0.5, specularColor: "#ffffff", emissive: "#000000", emissiveStrength: 1, alpha: 1 },
          position: { x: 0, y: 0 },
        },
        { id: "output", type: "output", props: {}, position: { x: 0, y: 0 } },
      ],
      edges: [{ source: "bsdf", sourceHandle: "out", target: "output", targetHandle: "surface" }],
    },
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => JSON.parse(fakeMaterialJson),
    text: async () => fakeMaterialJson,
  });

  try {
    const { loadMaterialAsset, getMaterialInstance, getMaterialColorPreview } = await import("../src/engine/materialAsset.js");
    const mat = await loadMaterialAsset("/fake/Red.mat");
    // First read: synchronous notify fired but compile is async.
    // Wait a couple of macrotask ticks so the .then() can resolve.
    await new Promise((r) => setTimeout(r, 50));
    const cached = getMaterialInstance("/fake/Red.mat");
    assert.ok(cached, "cached instance returned");
    assert.strictEqual(cached, mat, "cached instance is the same object");
    assert.ok(cached.colorNode, "after async compile, cached.colorNode is set");
    // The swatch helper must extract a usable #rrggbb string from the live
    // material's colorNode — even though the disk file says `color:
    // "#ffffff"` (the stale top-level field), the BSDF's colorNode wins.
    const preview = getMaterialColorPreview("/fake/Red.mat");
    assert.equal(preview, "#ff0000", "getMaterialColorPreview reads the live colorNode, not the stale top-level def.color");
    console.log("ok: loadMaterialAsset round-trip leaves colorNode populated");
    console.log("ok: getMaterialColorPreview returns the live BSDF color (not the stale top-level def.color)");
  } finally {
    globalThis.fetch = origFetch;
  }
}

console.log("All material-render checks passed.");
