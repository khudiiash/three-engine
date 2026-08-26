/**
 * §16 R4 roughness-floor classification — CHANNEL correctness gate.
 *
 *   node scripts/run-gi-roughness-floor-test.mjs
 *
 * WHAT THIS GUARDS (the 2026-08-24 Sponza regression): the floor stat was
 * p5 of per-texel min(RGB), pitched as "a lower bound for any channel". On a
 * glTF PACKED metallicRoughness texture B is METALNESS ≈ 0 on every
 * dielectric texel, so min-RGB read ~0 on every such map — the floor never
 * cleared a gate and every packed-map material stayed a reflection consumer
 * (Sponza: 24/39 dynamic-roughness, 22.7 ms/frame of prepass + hit shade
 * for a scene with no mirrors). The fix stores PER-CHANNEL p5s and the
 * source walk names the channel the material actually samples (three's
 * roughnessMap convention is G; a graph SplitNode names its own).
 */
import assert from "node:assert/strict";

// Floor-based classification is OPT-IN since 2026-08-24 late (the hit-shade
// energy findings — see giRoughnessBucketOf's banner). This gate tests the
// machinery ARMED, which is how the future roughness-tiered design will run.
globalThis.__giRoughnessFloorClassify = true;

const { giRoughnessBucketOf, giRoughnessFloorStats, giRoughnessSourceOf } = await import(
  "../src/modules/gi/giLight.js"
);

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

const tex = () => ({ isTexture: true, image: { width: 4, height: 4 } });

check("roughnessMap source names the G channel (three's PBR sampling convention)", () => {
  const map = tex();
  const src = giRoughnessSourceOf({ roughnessMap: map, roughness: 1 });
  assert.equal(src.tex, map);
  assert.equal(src.channel, "g", "roughnessMap is sampled .g — min-RGB is the packed-map trap");
});

check("a packed metallicRoughness map (B=metalness≈0) classifies by its G floor", () => {
  // The regression case: G (roughness) floor 0.8, B (metalness) 0 → min 0.
  // min-RGB kept this a consumer forever; the G floor demotes it to the
  // DIRECTIONAL bucket — never diffuse-only (see the bucket-1 note in
  // giRoughnessBucketOf: bucket 2 compiled out the directional chain and
  // shadowed walls went visibly dark, user-reported same night).
  const map = tex();
  giRoughnessFloorStats.set(map, { r: 0.5, g: 0.8, b: 0, min: 0 });
  const bucket = giRoughnessBucketOf({ roughnessMap: map, roughness: 1 });
  assert.equal(bucket, 1, `G floor 0.8 must demote to bucket 1 — NEVER 2: diffuse-only compiles out the directional chain, the 2026-08-24 "too dark" regression (got ${bucket})`);
});

check("a genuinely glossy map stays a consumer (G floor below the mirror gate)", () => {
  const map = tex();
  giRoughnessFloorStats.set(map, { r: 0.9, g: 0.2, b: 0, min: 0 });
  const bucket = giRoughnessBucketOf({ roughnessMap: map, roughness: 1 });
  assert.equal(bucket, 3, "a surface whose roughness dips to 0.2 CAN consume reflections");
});

check("the factor still scales the channel floor across a gate", () => {
  // G floor 0.5 × factor 1.5 = 0.75 > the mirror gate → bucket 1.
  const map = tex();
  giRoughnessFloorStats.set(map, { r: 0, g: 0.5, b: 0, min: 0 });
  const bucket = giRoughnessBucketOf({ roughnessMap: map, roughness: 1.5 });
  assert.equal(bucket, 1);
});

check("a legacy number-shaped stat still classifies (pre per-channel writers)", () => {
  const map = tex();
  giRoughnessFloorStats.set(map, 0.7);
  const bucket = giRoughnessBucketOf({ roughnessMap: map, roughness: 1 });
  assert.equal(bucket, 1, "a number stat is the old min floor and must keep working");
});

check("a graph SplitNode swizzle names its channel", () => {
  const map = tex();
  const node = {
    isSplitNode: true,
    components: "r",
    node: { isTextureNode: true, value: map },
  };
  const src = giRoughnessSourceOf({ roughnessNode: node });
  assert.equal(src.tex, map);
  assert.equal(src.channel, "r");
});

check("TSL's NORMALIZED xyzw swizzle maps back to rgb — the live-graph shape", () => {
  // ⚠ THE CASE THE FIRST LIVE TEST FAILED ON: TSL's proxy constructs
  // `.g` as SplitNode(node, 'y') (setProtoSwizzle normalizes to xyzw), so
  // every real material graph carries x/y/z, never r/g/b. Four drain
  // cycles reported "no flips" against fully resolved 0.57-1.00 G floors
  // because 'y' fell through to the min fallback (0 on packed maps).
  const map = tex();
  for (const [component, expected] of [["x", "r"], ["y", "g"], ["z", "b"]]) {
    const src = giRoughnessSourceOf({
      roughnessNode: { isSplitNode: true, components: component, node: { isTextureNode: true, value: map } },
    });
    assert.equal(src.channel, expected, `'${component}' must read the ${expected}-channel floor`);
  }
  // And end-to-end: a packed map read through the normalized '.y' split
  // must classify by its G floor exactly like the roughnessMap case.
  giRoughnessFloorStats.set(map, { r: 0, g: 0.8, b: 0, min: 0 });
  const bucket = giRoughnessBucketOf({
    roughnessNode: { isSplitNode: true, components: "y", node: { isTextureNode: true, value: map } },
  });
  assert.equal(bucket, 1, "normalized-swizzle graph must leave the consumer set on a high G floor");
});

check("an unknown-channel graph read falls back to the min floor (conservative)", () => {
  // No swizzle in the walk → channel null → stats.min. min 0 keeps the
  // material a consumer — the SAFE direction (never strips a real mirror).
  const map = tex();
  giRoughnessFloorStats.set(map, { r: 0.9, g: 0.9, b: 0.9, min: 0 });
  const node = { isTextureNode: true, value: map };
  const src = giRoughnessSourceOf({ roughnessNode: node });
  assert.equal(src.channel ?? null, null);
  const bucket = giRoughnessBucketOf({ roughnessNode: node });
  assert.equal(bucket, 3, "unknown channel must stay conservative (consumer)");
});

check("an alpha/multi-component swizzle keeps the conservative fallback", () => {
  const map = tex();
  for (const components of ["a", "rg", "xyz"]) {
    const src = giRoughnessSourceOf({
      roughnessNode: { isSplitNode: true, components, node: { isTextureNode: true, value: map } },
    });
    assert.equal(src.channel ?? null, null, `components "${components}" must not name a floor channel`);
  }
});

check("a swizzle × factor graph keeps both the channel and the factor", () => {
  const map = tex();
  const node = {
    isOperatorNode: true,
    op: "*",
    aNode: { isSplitNode: true, components: "g", node: { isTextureNode: true, value: map } },
    bNode: { isConstNode: true, value: 2 },
  };
  const src = giRoughnessSourceOf({ roughnessNode: node });
  assert.equal(src.channel, "g");
  assert.equal(src.factor, 2);
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
