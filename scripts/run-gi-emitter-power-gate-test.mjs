/**
 * §18.7 — THE SIZE-AWARE EMITTER CULL (`minPower`, lightTree.js).
 *
 *   node scripts/run-gi-emitter-power-gate-test.mjs
 *
 * ⭐ WHY THIS EXISTS. This gate DELETES LIGHTS. A wrongly-kept emitter costs a
 * little time; a wrongly-culled one silently removes something the user
 * authored and leaves no error anywhere — which is exactly how §13.7g's
 * nineteen dead Bistro emitters went unnoticed for a whole session. So the
 * asymmetry is the thing under test, not just the arithmetic.
 *
 * THE RULE (user, 2026-08-25): "if it is a small emitter and its strength is
 * not really powerful, just skip it. The smaller the emitter size, the more
 * power it needs to actually be emitting any light into the scene."
 *
 * That is radiant power, `Phi = pi * A * L`. Gating on it rearranges to
 * `L >= P_min / (pi * A)`: required brightness rises as area falls, with no
 * size buckets anywhere.
 */
import assert from "node:assert/strict";
import * as THREE from "three";

const { emitterFromMesh, collectEmitters } = await import("../src/modules/gi/lightTree.js");

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

/**
 * A flat emissive quad of a given world size and authored radiance, so area and
 * radiance move independently — which is the whole point of the gate.
 */
function quad(sizeMetres, radiance) {
  const geometry = new THREE.PlaneGeometry(sizeMetres, sizeMetres);
  const material = new THREE.MeshStandardMaterial({
    emissive: new THREE.Color(radiance, radiance, radiance),
    emissiveIntensity: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.updateWorldMatrix(true, false);
  return mesh;
}

/** Area of `quad`, for deriving the expected power independently of the code. */
const areaOf = (size) => size * size;
const powerOf = (size, radiance) => Math.PI * areaOf(size) * radiance;

// ---- the physics the gate is built on ---------------------------------------

check("⭐ power is pi * A * L — the emitter reports it, and it is not radiance", () => {
  const e = emitterFromMesh(quad(2, 0.4));
  assert.ok(e, "a 2 m emissive quad must produce an emitter");
  assert.ok(
    Math.abs(e.power - powerOf(2, 0.4)) < 1e-6,
    `power ${e.power} != pi*A*L ${powerOf(2, 0.4)}`,
  );
  assert.ok(Math.abs(e.area - areaOf(2)) < 1e-6);
});

check("⭐⭐ SAME BRIGHTNESS, DIFFERENT SIZE — the gate separates them", () => {
  // This is the user's case exactly: a decorative bulb and an illuminated sign
  // authored at the same emissive value. A radiance gate cannot tell them
  // apart; that was the bug.
  const bulb = quad(0.02, 0.4);   // 2 cm
  const sign = quad(2, 0.4);      // 2 m
  const minPower = 0.05;
  assert.equal(
    emitterFromMesh(bulb, { minPower }), null,
    "the 2 cm bulb must be culled",
  );
  assert.ok(
    emitterFromMesh(sign, { minPower }),
    "the 2 m sign at the SAME radiance must survive",
  );
});

check("the two differ by ~4 orders of magnitude in delivered power", () => {
  // The margin is what makes 0.05 a separator between bimodal populations
  // rather than a tuning dial. If this ratio ever collapses, the threshold
  // stops being safe and this test should fail loudly.
  const bulb = emitterFromMesh(quad(0.02, 0.4));
  const sign = emitterFromMesh(quad(2, 0.4));
  const ratio = sign.power / bulb.power;
  assert.ok(ratio > 1e3, `sign/bulb power ratio ${ratio.toExponential(1)} — expected > 1000`);
});

// ---- the rule itself: required radiance scales as 1/area --------------------

check("⭐⭐ A SMALL EMITTER CAN STILL QUALIFY IF IT IS BRIGHT ENOUGH", () => {
  // The user's rule is not "skip small emitters" — it is "the smaller it is,
  // the more power it needs". A tiny but genuinely fierce emitter must live.
  const minPower = 0.05;
  const size = 0.02;
  // Solve L for exactly the threshold, then step either side of it.
  const needed = minPower / (Math.PI * areaOf(size));
  assert.equal(emitterFromMesh(quad(size, needed * 0.5), { minPower }), null);
  assert.ok(
    emitterFromMesh(quad(size, needed * 2), { minPower }),
    `a ${size} m emitter at radiance ${needed * 2} must survive the gate`,
  );
});

check("⭐ required radiance rises as area falls — the rule, checked at 3 sizes", () => {
  const minPower = 0.05;
  const requiredFor = (size) => {
    // Bisect the smallest radiance that survives, and compare across sizes.
    let lo = 0;
    let hi = 1e6;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (emitterFromMesh(quad(size, mid), { minPower })) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const big = requiredFor(2);
  const mid = requiredFor(0.2);
  const small = requiredFor(0.02);
  assert.ok(mid > big * 50, `0.2 m needs ${mid}, 2 m needs ${big} — expected ~100x`);
  assert.ok(small > mid * 50, `0.02 m needs ${small}, 0.2 m needs ${mid} — expected ~100x`);
});

// ---- the asymmetry: this gate deletes lights, so it must fail OPEN ----------

check("⭐⭐ minPower 0 admits everything — the old behaviour is exactly restorable", () => {
  const bulb = quad(0.02, 0.4);
  assert.ok(emitterFromMesh(bulb, { minPower: 0 }), "minPower 0 must not cull");
  assert.ok(emitterFromMesh(bulb), "no minPower at all must not cull");
});

check("a real lamp is nowhere near the gate", () => {
  // The Bistro ledger logs P=1.8e+1 for a real lamp. Anything of that order
  // must clear 0.05 by a margin no plausible authoring change closes.
  const lamp = emitterFromMesh(quad(0.25, 20));
  assert.ok(lamp, "a bright 25 cm lamp must survive");
  assert.ok(lamp.power > 0.05 * 20, `lamp power ${lamp.power} is uncomfortably close to the gate`);
});

check("a mesh that emits NOTHING is still null, gate or no gate", () => {
  const dark = quad(2, 0);
  assert.equal(emitterFromMesh(dark), null);
  assert.equal(emitterFromMesh(dark, { minPower: 0 }), null);
});

check("⭐ the cull is measured on AUTHORED radiance, before fill damping", () => {
  // §13.7g damps `rgb` by `fill` for sparse emitters. Culling on the DAMPED
  // value would delete exactly the scattered-geometry emitters that correction
  // exists to rescue — a sparse string scores fill ~1e-4, so its damped
  // radiance rounds to nothing while its true power is large.
  // A dense quad has fill ~1, so this asserts the ordering holds where we can
  // construct it: power must equal pi*A*L_authored regardless.
  const e = emitterFromMesh(quad(1, 0.1));
  assert.ok(Math.abs(e.power - Math.PI * 1 * 0.1) < 1e-6,
    `power ${e.power} was damped before the gate saw it`);
});

// ---- monotonicity: no size or brightness can invert the decision ------------

check("the gate is monotonic in BOTH size and brightness", () => {
  const minPower = 0.05;
  const survives = (size, radiance) => !!emitterFromMesh(quad(size, radiance), { minPower });
  // Brighter never turns a survivor into a cull.
  for (const size of [0.02, 0.1, 0.5, 2]) {
    let seenSurvivor = false;
    for (const radiance of [0.01, 0.1, 1, 10, 100]) {
      const ok = survives(size, radiance);
      if (seenSurvivor) assert.ok(ok, `size ${size} survived dimmer but not at ${radiance}`);
      if (ok) seenSurvivor = true;
    }
  }
  // Bigger never turns a survivor into a cull.
  for (const radiance of [0.01, 0.1, 1, 10]) {
    let seenSurvivor = false;
    for (const size of [0.02, 0.1, 0.5, 2]) {
      const ok = survives(size, radiance);
      if (seenSurvivor) assert.ok(ok, `radiance ${radiance} survived smaller but not at ${size}`);
      if (ok) seenSurvivor = true;
    }
  }
});

// ---- §18.11: THE CULL IS RELATIVE TO THE SCENE, NOT AN ABSOLUTE WATTAGE -----
//
// ⛔ The absolute default above was measured wrong and SHIPPED. `0.05` was
// justified from TWO data points — "a lamp is 1.8e+1, a bulb is 8e-4, four
// orders apart, so anything between separates two clearly bimodal populations
// with wide margin". The very next scene refuted it: on the user's Bistro that
// gate culled 26 emitters, took the light tree 114 -> 88, and left a green neon
// as the dominant chromatic source ("all reflections are greenish").
//
// Emitter powers are a broad CONTINUUM whose scale is a property of how a scene
// was authored. These checks pin the property that replaced the constant.

const scene = (specs) => specs.map(([size, radiance]) => quad(size, radiance));

check("⭐⭐ a UNIFORMLY-LIT scene loses NOTHING — the constant's exact failure", () => {
  // ~100 roughly-equal emitters: each holds ~1% of scene power, far above the
  // 0.2% fraction. This is the Bistro case the absolute gate got wrong.
  const meshes = scene(Array.from({ length: 100 }, () => [0.3, 0.5]));
  const out = collectEmitters(meshes, { minPowerFraction: 0.002, split: false });
  assert.equal(out.length, 100, `culled ${100 - out.length} of a uniformly-lit scene`);
});

check("⭐⭐ tiny bulbs beside real lamps ARE still culled", () => {
  const meshes = scene([
    ...Array.from({ length: 10 }, () => [0.25, 20]),
    ...Array.from({ length: 100 }, () => [0.02, 0.4]),
  ]);
  const out = collectEmitters(meshes, { minPowerFraction: 0.002, split: false });
  assert.equal(out.length, 10, `expected only the 10 lamps, got ${out.length}`);
});

check("⭐⭐ THE GATE CAN NEVER EMPTY THE TREE", () => {
  // Every emitter equally weak. Culling is MOST wrong here — a gate that can
  // black out a room is worse than one that keeps some waste.
  const meshes = scene(Array.from({ length: 8 }, () => [0.01, 0.01]));
  const out = collectEmitters(meshes, { minPowerFraction: 0.9, split: false });
  assert.ok(out.length > 0, "a fraction near 1 emptied the light tree");
});

check("⭐ UNIT-INVARIANT — the same scene 1000x brighter culls the same set", () => {
  // The whole point of a fraction. An absolute gate cannot do this, which is
  // why it could not survive meeting a second scene.
  const build = (k) => scene([
    ...Array.from({ length: 5 }, () => [0.25, 20 * k]),
    ...Array.from({ length: 50 }, () => [0.02, 0.4 * k]),
  ]);
  const dim = collectEmitters(build(1), { minPowerFraction: 0.002, split: false });
  const bright = collectEmitters(build(1000), { minPowerFraction: 0.002, split: false });
  assert.equal(dim.length, bright.length,
    `1000x brightness culled differently (${dim.length} vs ${bright.length})`);
});

check("fraction 0 disables the cull entirely", () => {
  const meshes = scene([[0.25, 20], ...Array.from({ length: 20 }, () => [0.02, 0.4])]);
  const out = collectEmitters(meshes, { minPowerFraction: 0, split: false });
  assert.equal(out.length, 21);
});

check("the cull reports what it removed", () => {
  const meshes = scene([[0.25, 20], ...Array.from({ length: 20 }, () => [0.02, 0.4])]);
  const out = collectEmitters(meshes, { minPowerFraction: 0.002, split: false });
  assert.ok(out.cullStats, "collectEmitters must publish cullStats");
  assert.equal(out.cullStats.culled, 20);
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
