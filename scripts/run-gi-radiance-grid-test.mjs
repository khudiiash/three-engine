/**
 * Gate for the reflection radiance grid (§18 W4, giScreen.createGiBvhTarget).
 *
 * The divisor that sizes `bvhRadiance` used to be a per-tier constant chosen
 * against a fixed 1.6 M-pixel ultra resolve. Once the frame governor could
 * scale that resolve by 5x, the constant became a quality cliff — at rung 3 one
 * reflection sample covered a 5.4 x 5.4 screen block, which is what the user
 * saw as blocky speckle on chrome.
 *
 * This pins the two properties the fix has to have at once, because they pull
 * against each other: magnification must stay near the shipped value at every
 * rung, AND the cost must stay monotonic in the rung or the governor's ladder
 * breaks.
 *
 * Pure arithmetic — no renderer, no GPU. The formula is the thing under test.
 */
import assert from "node:assert";

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

// Mirrors createGiBvhTarget's divisor block. Kept in step by the assertion at
// the bottom, which reads the real source and fails if the constants drift.
const TARGET_RADIANCE_TEXELS = 178_000;
function radianceDivisor(width, height, capDiv = 3) {
  const solved = Math.sqrt((width * height) / TARGET_RADIANCE_TEXELS);
  return capDiv <= 1 ? capDiv : Math.min(capDiv, Math.max(2, solved));
}
const radianceTexels = (w, h, cap = 3) => {
  const d = radianceDivisor(w, h, cap);
  return Math.max(1, Math.round(w / d)) * Math.max(1, Math.round(h / d));
};

/** The governor's ladder, as resolve sizes at ultra on an 1878x1000 buffer. */
const LADDER = [1, 0.72, 0.52, 0.37, 0.27, 0.19].map((scale) => {
  const px = Math.min(1878 * 1000, 1_600_000) * scale;
  const aspect = 1878 / 1000;
  const h = Math.sqrt(px / aspect);
  return { scale, width: Math.round(h * aspect), height: Math.round(h) };
});

check("⭐ full-quality ultra is UNCHANGED — same grid, to the texel", () => {
  // ⚠ ASSERT THE GRID, NOT THE DIVISOR. The solved value at rung 0 is 2.998,
  // not 3, and an equality test on the divisor fails on that while the texture
  // it produces is identical (578x308 either way). The texture is the thing
  // that has a cost and an appearance; the divisor is an intermediate.
  const { width, height } = LADDER[0];
  const before = Math.max(1, Math.round(width / 3)) * Math.max(1, Math.round(height / 3));
  assert.equal(radianceTexels(width, height, 3), before, "rung 0 must produce the shipped grid exactly");
});

check("⭐⭐ magnification never collapses the way the constant divisor let it", () => {
  const screenPx = 1878 * 1000;
  const linearMag = (rung) => Math.sqrt(screenPx / radianceTexels(rung.width, rung.height));
  const baseline = linearMag(LADDER[0]);
  for (const rung of LADDER) {
    const mag = linearMag(rung);
    // ⚠ THE NEGATIVE CONTROL'S TARGET. With a fixed divisor of 3 the bottom
    // rung reaches ~7.4x — one sample per 7x7 screen block. Allowing 1.35x the
    // full-quality magnification keeps every rung inside roughly a 4.4x block.
    // ⚠ 1.6x, not 1.0x: below rung 2 the divisor hits its floor of 2 and
    // magnification MUST start degrading, because holding it there would make
    // radiance texels stop falling with the rung and break the ladder (see the
    // monotonicity check below). What this rules out is the CLIFF — a constant
    // divisor of 3 reaches 2.28x the full-quality magnification at the bottom
    // rung, i.e. one reflection sample per 7.4 x 7.4 screen block.
    assert.ok(
      mag <= baseline * 1.6,
      `rung ${rung.scale}: ${mag.toFixed(2)}x magnification vs ${baseline.toFixed(2)}x at full quality`,
    );
  }
});

check("⛔ COST STAYS MONOTONIC — a cheaper rung can never cost more radiance texels", () => {
  // If this fails the governor's ladder is broken, not just the image: it would
  // descend a rung, measure a SLOWER frame, and descend again forever. This is
  // what the `Math.max(2, ...)` floor exists for.
  let previous = Infinity;
  for (const rung of LADDER) {
    const texels = radianceTexels(rung.width, rung.height);
    assert.ok(
      texels <= previous,
      `rung ${rung.scale} costs ${texels} radiance texels, more than the rung above it (${previous})`,
    );
    previous = texels;
  }
});

check("⛔ the divisor is never below 2 unless the full-res hatch asked for it", () => {
  for (const rung of LADDER) {
    assert.ok(radianceDivisor(rung.width, rung.height, 3) >= 2, `rung ${rung.scale} went below the floor`);
  }
  // `__giHitShadeFull` passes capDiv 1 and must still mean full-res.
  assert.equal(radianceDivisor(LADDER[0].width, LADDER[0].height, 1), 1, "the full-res hatch must survive");
});

check("the caller's tier divisor is still a CEILING, never raised", () => {
  for (const rung of LADDER) {
    assert.ok(
      radianceDivisor(rung.width, rung.height, 2) <= 2,
      "a tier that asked for div 2 must never be given 3",
    );
  }
});

// Guards the copy above against drifting from the implementation.
const source = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../src/modules/gi/giScreen.js", import.meta.url), "utf8"),
);
check("the constants here still match giScreen.js", () => {
  assert.ok(
    source.includes("const TARGET_RADIANCE_TEXELS = 178_000;"),
    "TARGET_RADIANCE_TEXELS drifted from this gate's copy",
  );
  assert.ok(
    source.includes("Math.min(capDiv, Math.max(2, solved))")
      && source.includes("const solved = Math.sqrt((width * height) / TARGET_RADIANCE_TEXELS);"),
    "the divisor formula drifted from this gate's copy",
  );
});

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
