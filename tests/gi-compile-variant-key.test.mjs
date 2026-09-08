/**
 * THE COMPILE WAVE'S VARIANT KEY — the line between "warmed" and "compiles in
 * the frame the camera turns onto it".
 *
 * The wave walks ONE object per pipeline variant and warms it. If the key
 * SPLITS where three's program key does not, the wave does redundant work: a
 * node-graph build and a `createShaderModule` over 180-250 kB of WGSL, per
 * duplicate. That is what keying on `material.uuid` did — uuid is the one
 * field `RenderObject.getMaterialCacheKey` explicitly skips, so every material
 * INSTANCE was a variant.
 *
 * ⚠ But MERGING is the dangerous direction, and it is why this file exists.
 * Two objects on one key means one of them is never compiled, and nothing says
 * so: the wave reports success, the scene looks right, and the first time the
 * camera turns onto the un-warmed material the editor freezes for a
 * synchronous pipeline creation — the exact failure `asyncRenderPipelines.js`
 * and the wave were both built to prevent, arriving by a new road. So every
 * fork three's key has is asserted here, against hand-built objects rather
 * than a live renderer, because the property is structural and must hold
 * without a GPU.
 *
 * Reference: three r185 `RenderObject.getMaterialCacheKey` / `getGeometryCacheKey`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { giCompileVariantKey } from "../src/modules/gi/GISystem.js";

/** A material shaped like three's, with only the fields the key reads. */
function material(overrides = {}) {
  const mat = {
    type: "MeshPhysicalNodeMaterial",
    uuid: `uuid-${Math.random()}`,
    name: "",
    version: 0,
    visible: true,
    opacity: 1,
    side: 0,
    transparent: false,
    alphaTest: 0,
    ...overrides,
  };
  // Stock materials have no node slots, so their cache key is just the type.
  mat.customProgramCacheKey = overrides.customProgramCacheKey ?? (() => mat.type);
  return mat;
}

function geometry(attributes = ["position", "normal", "uv"], extra = {}) {
  const attrs = {};
  for (const name of attributes) attrs[name] = { itemSize: 3 };
  return { attributes: attrs, morphAttributes: {}, index: {}, ...extra };
}

function mesh(mat, geo = geometry(), extra = {}) {
  return { material: mat, geometry: geo, receiveShadow: false, ...extra };
}

test("two instances of the same stock material share ONE variant", () => {
  // The whole point: `uuid` differs, the program does not.
  const a = mesh(material());
  const b = mesh(material());
  assert.equal(giCompileVariantKey(a), giCompileVariantKey(b));
});

test("the uuid hatch restores per-instance variants", () => {
  globalThis.__giWaveVariantKey = "uuid";
  try {
    const a = mesh(material());
    const b = mesh(material());
    assert.notEqual(giCompileVariantKey(a), giCompileVariantKey(b), "the A/B arm must fork per instance again");
  } finally {
    delete globalThis.__giWaveVariantKey;
  }
});

test("side is kept EXACTLY — it is an enum three preserves, not a boolean", () => {
  const front = mesh(material({ side: 0 }));
  const back = mesh(material({ side: 1 }));
  const double = mesh(material({ side: 2 }));
  const keys = new Set([front, back, double].map((m) => giCompileVariantKey(m)));
  assert.equal(keys.size, 3, "front, back and double-sided are three different programs");
});

test("node identity forks the variant, because that is where it forks three's key", () => {
  // A material with wired node slots reports its node hash through
  // `customProgramCacheKey`; two such materials are different programs even
  // when every plain property matches.
  const a = mesh(material({ customProgramCacheKey: () => "MeshPhysicalNodeMaterial|nodes:111" }));
  const b = mesh(material({ customProgramCacheKey: () => "MeshPhysicalNodeMaterial|nodes:222" }));
  assert.notEqual(giCompileVariantKey(a), giCompileVariantKey(b));
});

test("GI's roughness bucket rides customProgramCacheKey and forks", () => {
  // `GISystem.#markObservedMaterial` appends `|gi<bucket>`; the buckets
  // generate different code in GICascadeLightNode.setup.
  const mirror = mesh(material({ customProgramCacheKey: () => "MeshPhysicalNodeMaterial|gi0" }));
  const diffuse = mesh(material({ customProgramCacheKey: () => "MeshPhysicalNodeMaterial|gi2" }));
  assert.notEqual(giCompileVariantKey(mirror), giCompileVariantKey(diffuse));
});

test("transparency and alphaTest fork", () => {
  const opaque = mesh(material());
  const blended = mesh(material({ transparent: true }));
  const cut = mesh(material({ alphaTest: 0.5 }));
  const keys = new Set([opaque, blended, cut].map((m) => giCompileVariantKey(m)));
  assert.equal(keys.size, 3);
});

test("the geometry's attribute set forks, and its ORDER does not", () => {
  const mat = material();
  const uvd = mesh(mat, geometry(["position", "normal", "uv"]));
  const plain = mesh(mat, geometry(["position", "normal"]));
  assert.notEqual(giCompileVariantKey(uvd), giCompileVariantKey(plain));
  // three sorts the attribute names; a different declaration order is the same
  // vertex layout and must not buy a second compile.
  const reordered = mesh(mat, geometry(["uv", "normal", "position"]));
  assert.equal(giCompileVariantKey(uvd), giCompileVariantKey(reordered));
});

test("morph targets fork by attribute id, as three's geometry key does", () => {
  const mat = material();
  const none = mesh(mat, geometry());
  const morphed = mesh(mat, geometry(["position"], { morphAttributes: { position: [{ id: 7 }] } }));
  const morphedOther = mesh(mat, geometry(["position"], { morphAttributes: { position: [{ id: 8 }] } }));
  assert.notEqual(giCompileVariantKey(none), giCompileVariantKey(morphed));
  assert.notEqual(giCompileVariantKey(morphed), giCompileVariantKey(morphedOther));
});

test("a skinned mesh forks on BONE COUNT, not on the skeleton object", () => {
  const mat = material();
  const geo = geometry();
  const small = mesh(mat, geo, { skeleton: { bones: new Array(12) } });
  const big = mesh(mat, geo, { skeleton: { bones: new Array(40) } });
  const sameCount = mesh(mat, geo, { skeleton: { bones: new Array(12) } });
  assert.notEqual(giCompileVariantKey(small), giCompileVariantKey(big));
  assert.equal(giCompileVariantKey(small), giCompileVariantKey(sameCount), "two rigs of the same size share a program");
});

test("every InstancedMesh is its own variant — three appends object.uuid", () => {
  const mat = material();
  const geo = geometry();
  const a = mesh(mat, geo, { isInstancedMesh: true, uuid: "inst-a" });
  const b = mesh(mat, geo, { isInstancedMesh: true, uuid: "inst-b" });
  assert.notEqual(
    giCompileVariantKey(a), giCompileVariantKey(b),
    "merging these would leave one instanced mesh compiling in the frame that first draws it",
  );
});

test("receiveShadow forks", () => {
  const mat = material();
  const geo = geometry();
  assert.notEqual(
    giCompileVariantKey(mesh(mat, geo, { receiveShadow: true })),
    giCompileVariantKey(mesh(mat, geo, { receiveShadow: false })),
  );
});

test("a multi-material mesh keys on every slot", () => {
  const geo = geometry();
  const one = mesh([material(), material({ side: 1 })], geo);
  const two = mesh([material(), material({ side: 2 })], geo);
  assert.notEqual(giCompileVariantKey(one), giCompileVariantKey(two));
});

test("a material whose cache key throws falls back to per-instance, never to a merge", () => {
  const angry = material({
    customProgramCacheKey: () => {
      throw new Error("node graph is mid-rebuild");
    },
  });
  const other = material({
    customProgramCacheKey: () => {
      throw new Error("node graph is mid-rebuild");
    },
  });
  const a = giCompileVariantKey(mesh(angry));
  const b = giCompileVariantKey(mesh(other));
  assert.notEqual(a, b, "the fallback must be conservative — two unknowns are two variants, not one");
});
