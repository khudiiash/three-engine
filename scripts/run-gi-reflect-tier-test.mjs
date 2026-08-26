/**
 * §18 — the reflection quality LADDER (`giReflectTierOf`, src/modules/gi/giLight.js).
 *
 *   node scripts/run-gi-reflect-tier-test.mjs
 *
 * The ladder decides how FINELY a surface's reflection is sampled, never which
 * path it takes. So every check here is about the tier being RIGHT, and about
 * the two traps that have already cost this project a night each:
 *
 *  - the packed glTF metallicRoughness map, whose BLUE channel is metalness
 *    (~0 on every dielectric) — reading min-RGB promoted the entire scene
 *    (§16 R4's "0 mirror, 24 dynamic-roughness" blindness);
 *  - `staticRoughnessOf` returning a NUMBER for a mapped material, where the
 *    scalar is only a multiplier on the map.
 */
import assert from "node:assert/strict";

const { giReflectTierOf, GI_REFLECT_TIER, giRoughnessFloorStats } = await import(
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

const T = GI_REFLECT_TIER;
const named = (t) => Object.keys(T).find((k) => T[k] === t) ?? String(t);

/** A material with an authored constant roughness and no map. */
const constMat = (roughness) => ({ roughness });
/** A material whose roughness comes from a map, with an optional scalar factor. */
const mapMat = (tex, roughness = 1) => ({ roughnessMap: tex, roughness });

// ---- authored constants -----------------------------------------------------

check("polished glass (authored 0.05) is SHARP", () => {
  assert.equal(giReflectTierOf(constMat(0.05)), T.SHARP);
});

check("satin (authored 0.25) is MEDIUM", () => {
  assert.equal(giReflectTierOf(constMat(0.25)), T.MEDIUM);
});

check("plaster (authored 0.8) is COARSE", () => {
  assert.equal(giReflectTierOf(constMat(0.8)), T.COARSE);
});

check("a perfect mirror (authored 0) is SHARP", () => {
  assert.equal(giReflectTierOf(constMat(0)), T.SHARP);
});

// ---- mapped roughness -------------------------------------------------------

check("⭐ a mapped material is NOT tiered by its scalar multiplier", () => {
  // `staticRoughnessOf` hands back `material.roughness` even when a map is
  // present. Reading that as the surface roughness would tier the whole scene
  // by a number that is only a multiplier.
  const tex = {};
  const mat = mapMat(tex, 1.0); // multiplier 1.0 would read as "fully rough"
  giRoughnessFloorStats.set(tex, { r: 0, g: 0.04, b: 0, min: 0 });
  assert.equal(
    giReflectTierOf(mat), T.SHARP,
    "the MAP's floor decides, not the scalar sitting next to it",
  );
});

check("⭐⭐ a packed glTF metallicRoughness map reads GREEN, not min-RGB", () => {
  // B = metalness ~ 0 on every dielectric texel, so min-RGB is ~0 and would
  // call rough plaster a mirror — this is exactly the §16 R4 blindness that
  // kept 24 of 39 Sponza materials misclassified.
  const tex = {};
  giRoughnessFloorStats.set(tex, { r: 0, g: 0.74, b: 0, min: 0 });
  assert.equal(
    giReflectTierOf(mapMat(tex)), T.COARSE,
    "min-RGB would say SHARP here and promote the entire scene",
  );
});

check("a genuinely smooth mapped surface is SHARP", () => {
  const tex = {};
  giRoughnessFloorStats.set(tex, { r: 0.06, g: 0.06, b: 0.06, min: 0.06 });
  assert.equal(giReflectTierOf(mapMat(tex)), T.SHARP);
});

check("the scalar factor still scales the map's floor", () => {
  // floor 0.5 x factor 0.2 = 0.10 -> SHARP. A material can be authored smooth
  // by multiplying a rough map down, and the tier has to follow.
  const tex = {};
  giRoughnessFloorStats.set(tex, { r: 0.5, g: 0.5, b: 0.5, min: 0.5 });
  assert.equal(giReflectTierOf(mapMat(tex, 0.2)), T.SHARP);
});

check("a legacy number-shaped stat still reads as the floor", () => {
  const tex = {};
  giRoughnessFloorStats.set(tex, 0.9); // pre per-channel stats
  assert.equal(giReflectTierOf(mapMat(tex)), T.COARSE);
});

// ---- the unknown cases, which must not guess --------------------------------

check("⭐ an UNRESOLVED floor is MEDIUM — never SHARP, never COARSE", () => {
  // The stat resolves asynchronously on the GPU. Guessing SHARP would spend
  // the whole frame budget on plaster until it lands; guessing COARSE would
  // ship a visibly blurry mirror. The middle is the only honest answer.
  const tex = {};
  assert.equal(
    giReflectTierOf(mapMat(tex)), T.MEDIUM,
    `unresolved floor tiered as ${named(giReflectTierOf(mapMat(tex)))}`,
  );
});

check("a null material is COARSE, not a crash", () => {
  assert.equal(giReflectTierOf(null), T.COARSE);
  assert.equal(giReflectTierOf(undefined), T.COARSE);
});

// ---- the property that makes this safe where R4 was not ---------------------

check("⭐⭐ the ladder is TOTAL — every material lands on a tier", () => {
  // R4 was refuted because it moved materials OUT of the reflection path and
  // took their energy with them. This function can only ever return a
  // sampling RATE, so there is no "excluded" answer to return by mistake.
  const samples = [
    null, {}, constMat(0), constMat(1), constMat(0.5),
    mapMat({}), mapMat({}, 0), { roughness: undefined },
  ];
  for (const m of samples) {
    const t = giReflectTierOf(m);
    assert.ok(
      t === T.SHARP || t === T.MEDIUM || t === T.COARSE,
      `got ${t} for ${JSON.stringify(m)} — every input must map to a tier`,
    );
  }
});

check("tiers are monotonic in roughness", () => {
  let prev = -1;
  for (const r of [0, 0.05, 0.12, 0.2, 0.35, 0.5, 0.9, 1]) {
    const t = giReflectTierOf(constMat(r));
    assert.ok(t >= prev, `roughness ${r} tiered ${named(t)} after ${named(prev)} — not monotonic`);
    prev = t;
  }
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
