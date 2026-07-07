// Headless check of the Blender-style volume pin: builds graphs that wire a
// Volume node into Material Output's Volume socket, runs compileShaderGraph,
// and asserts the right mutations come back (specifically scatteringNode).
//
// Also exercises `materialAsset.applyMaterialDef` to confirm the
// auto-detection swaps to VolumeNodeMaterial and assigns the slot. Because
// `applyMaterialDef` triggers an async `compileShaderGraph`, each apply must
// be flushed before assertions read the material's `*Node` slots.
//
// Run: node scripts/test-volume-material.mjs
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { setAssetResolver } from "../src/engine/assetResolver.js";
import { compileShaderGraph, NODE_TYPES, OUTPUT_SLOTS } from "../src/engine/tslGraph.js";
import { applyMaterialDef, MATERIAL_DEFAULTS } from "../src/engine/materialAsset.js";

setAssetResolver(async (path) => path);

/** Let the microtask queue drain — `applyMaterialDef` enqueues an async
 *  `compileShaderGraph` whose resolution populates the material's `*Node`
 *  slots. None of these graphs load textures, but TSL node construction
 *  can be slow; 200ms is comfortable. */
const flush = () => new Promise((r) => setTimeout(r, 200));

const volumeSlot = OUTPUT_SLOTS.find((s) => s.key === "volume");
assert.ok(volumeSlot, "OUTPUT_SLOTS must declare a 'volume' socket");
assert.equal(volumeSlot.type, "volume");

// Blender-style Output: Surface + Volume + Displacement pins.
const surfaceSlot = OUTPUT_SLOTS.find((s) => s.key === "surface");
assert.ok(surfaceSlot, "OUTPUT_SLOTS must declare a 'surface' socket");
assert.equal(surfaceSlot.type, "surface");
assert.ok(OUTPUT_SLOTS.find((s) => s.key === "displacement"), "OUTPUT_SLOTS must declare a 'displacement' socket");
assert.ok(NODE_TYPES.principledBsdf, "principledBsdf must be registered");
assert.equal(NODE_TYPES.principledBsdf.out, "surface");

// --- Principled BSDF wired to Surface -> unpacks into *Node slots ---------
{
  const g = {
    nodes: [
      { id: "bsdf", type: "principledBsdf", props: {}, position: { x: -200, y: 0 } },
      { id: "out", type: "output", props: {}, position: { x: 0, y: 0 } },
    ],
    edges: [{ source: "bsdf", sourceHandle: "out", target: "out", targetHandle: "surface" }],
  };
  const result = await compileShaderGraph(g);
  const m = result?.mutations ?? {};
  assert.ok(m.colorNode, "Principled BSDF must populate colorNode via Surface");
  assert.ok(m.roughnessNode, "Principled BSDF must populate roughnessNode via Surface");
  assert.equal(m.scatteringNode, undefined, "surface-only graph must not populate scatteringNode");
  // Expensive channels stay unset unless wired (three's useTransmission/… gate).
  assert.equal(m.transmissionNode, undefined, "unwired transmission must stay unset");
  assert.equal(m.clearcoatNode, undefined, "unwired clearcoat must stay unset");
}

// --- Wiring an expensive channel turns it on -----------------------------
{
  const g = {
    nodes: [
      { id: "f", type: "float", props: { value: 1 }, position: { x: -400, y: 0 } },
      { id: "bsdf", type: "principledBsdf", props: {}, position: { x: -200, y: 0 } },
      { id: "out", type: "output", props: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { source: "f", sourceHandle: "out", target: "bsdf", targetHandle: "transmission" },
      { source: "bsdf", sourceHandle: "out", target: "out", targetHandle: "surface" },
    ],
  };
  const m = (await compileShaderGraph(g))?.mutations ?? {};
  assert.ok(m.transmissionNode, "wired transmission must populate transmissionNode");
}

assert.ok(NODE_TYPES.volumeScatter, "volumeScatter must be registered");
assert.ok(NODE_TYPES.volumeAbsorption, "volumeAbsorption must be registered");
assert.ok(NODE_TYPES.principledVolume, "principledVolume must be registered");
assert.equal(NODE_TYPES.volumeScatter.cat, "volume");
assert.equal(NODE_TYPES.volumeAbsorption.cat, "volume");
assert.equal(NODE_TYPES.principledVolume.cat, "volume");

const baseGraph = () => ({
  nodes: [
    { id: "out", type: "output", props: {}, position: { x: 0, y: 0 } },
  ],
  edges: [],
});

async function compileFull(g) {
  return (await compileShaderGraph(g)) ?? {};
}
async function compile(g) {
  return (await compileShaderGraph(g))?.mutations ?? {};
}
const isVolumeMat = (m) => m?.userData?.isVolumeMaterial === true;

// --- Surface-only: nothing on Volume socket -> not a volume ---------------
{
  const r = await compileFull(baseGraph());
  assert.equal(r.isVolume, false, "empty graph must not be a volume");
}

// --- Volume Scatter wired -> colorNode set + isVolume --------------------
{
  const g = {
    nodes: [
      { id: "sc", type: "volumeScatter", props: {}, position: { x: -200, y: 0 } },
      { id: "out", type: "output", props: {}, position: { x: 0, y: 0 } },
    ],
    edges: [{ source: "sc", sourceHandle: "out", target: "out", targetHandle: "volume" }],
  };
  const r = await compileFull(g);
  assert.ok(r.isVolume, "Volume Scatter wired to Volume must flag isVolume");
  assert.ok(r.mutations.__volume, "Volume Scatter must populate a __volume bundle");
  assert.equal(typeof r.mutations.__volume.scattering, "function", "bundle must expose scattering()");
  assert.equal(typeof r.mutations.__volume.steps, "number", "bundle must carry a step count");
}

// --- Volume Absorption wired -> colorNode set ----------------------------
{
  const g = {
    nodes: [
      { id: "ab", type: "volumeAbsorption", props: {}, position: { x: -200, y: 0 } },
      { id: "out", type: "output", props: {}, position: { x: 0, y: 0 } },
    ],
    edges: [{ source: "ab", sourceHandle: "out", target: "out", targetHandle: "volume" }],
  };
  const r = await compileFull(g);
  assert.ok(r.isVolume && r.mutations.__volume, "Volume Absorption must flag isVolume + __volume");
}

// --- Principled Volume wired -> colorNode set ----------------------------
{
  const g = {
    nodes: [
      { id: "pv", type: "principledVolume", props: {}, position: { x: -200, y: 0 } },
      { id: "out", type: "output", props: {}, position: { x: 0, y: 0 } },
    ],
    edges: [{ source: "pv", sourceHandle: "out", target: "out", targetHandle: "volume" }],
  };
  const r = await compileFull(g);
  assert.ok(r.isVolume && r.mutations.__volume, "Principled Volume must flag isVolume + __volume");
}

// --- Wiring nodes into a volume's density compiles (ray-position remap) ---
// Position (Local) → Noise → Volume Scatter.density → Output.volume. In a
// volume graph the position source must resolve to the raymarch sample, so
// this must compile to a __volume bundle without throwing.
{
  const g = {
    nodes: [
      { id: "pos", type: "positionLocal", props: {}, position: { x: -600, y: 0 } },
      { id: "nz", type: "noise", props: {}, position: { x: -400, y: 0 } },
      { id: "sc", type: "volumeScatter", props: { steps: 16 }, position: { x: -200, y: 0 } },
      { id: "out", type: "output", props: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { source: "pos", sourceHandle: "out", target: "nz", targetHandle: "pos" },
      { source: "nz", sourceHandle: "out", target: "sc", targetHandle: "density" },
      { source: "sc", sourceHandle: "out", target: "out", targetHandle: "volume" },
    ],
  };
  const r = await compileFull(g);
  assert.ok(r.isVolume && r.mutations.__volume, "wired volume density must still yield a __volume bundle");
  assert.equal(r.mutations.__volume.steps, 16, "node steps param must flow into the bundle");
  assert.equal(typeof r.mutations.__volume.scattering, "function", "scattering closure must survive wiring");
}

// --- materialAsset: surface def stays on MeshPhysicalNodeMaterial --------
{
  const entry = { def: { ...MATERIAL_DEFAULTS } };
  applyMaterialDef(entry, { ...MATERIAL_DEFAULTS });
  await flush();
  assert.ok(entry.material instanceof THREE.MeshPhysicalNodeMaterial,
    "surface def should instantiate MeshPhysicalNodeMaterial");
  assert.equal(entry.isVolume, false);
}

// --- materialAsset: volume def switches to the unlit volume material -----
{
  const entry = { def: { ...MATERIAL_DEFAULTS } };
  applyMaterialDef(entry, {
    ...MATERIAL_DEFAULTS,
    shaderGraph: {
      nodes: [
        { id: "pv", type: "principledVolume", props: {}, position: { x: 0, y: 0 } },
        { id: "out", type: "output", props: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ source: "pv", sourceHandle: "out", target: "out", targetHandle: "volume" }],
    },
  });
  await flush();
  assert.ok(isVolumeMat(entry.material), "volume def should instantiate the tagged volume material");
  assert.ok(entry.material.isVolumeNodeMaterial, "volume def should instantiate a VolumeNodeMaterial");
  assert.ok(entry.material.transparent && entry.material.depthWrite === false,
    "volume material must be transparent with depthWrite off");
  assert.equal(entry.isVolume, true);
  assert.equal(typeof entry.material.scatteringNode, "function", "Volume material must set scatteringNode");
  assert.ok(entry.material.steps >= 1, "Volume material must set a step count");
}

// --- materialAsset: Surface + Volume both wired → volume still wins ------
{
  const entry = { def: { ...MATERIAL_DEFAULTS } };
  applyMaterialDef(entry, {
    ...MATERIAL_DEFAULTS,
    shaderGraph: {
      nodes: [
        { id: "bsdf", type: "principledBsdf", props: { color: "#ff0000" }, position: { x: -400, y: 0 } },
        { id: "pv", type: "principledVolume", props: {}, position: { x: 0, y: 0 } },
        { id: "out", type: "output", props: {}, position: { x: 200, y: 0 } },
      ],
      edges: [
        { source: "bsdf", sourceHandle: "out", target: "out", targetHandle: "surface" },
        { source: "pv", sourceHandle: "out", target: "out", targetHandle: "volume" },
      ],
    },
  });
  await flush();
  assert.ok(isVolumeMat(entry.material), "both sockets wired: volume must win");
  assert.equal(entry.isVolume, true);
  assert.equal(typeof entry.material.scatteringNode, "function", "Volume material must set scatteringNode");
}

// --- materialAsset: switching back to surface swaps the material back ----
{
  const entry = { def: { ...MATERIAL_DEFAULTS }, isVolume: true };
  entry.material = new THREE.MeshBasicNodeMaterial();
  entry.material.userData.isVolumeMaterial = true;
  applyMaterialDef(entry, { ...MATERIAL_DEFAULTS });
  await flush();
  assert.ok(entry.material instanceof THREE.MeshPhysicalNodeMaterial,
    "switching back to surface must swap the instance");
  assert.equal(entry.isVolume, false);
}

console.log("All volume material checks passed.");