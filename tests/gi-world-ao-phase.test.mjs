import assert from "node:assert/strict";
import {
  GI_WORLD_AO_PHASE_PERIOD,
  GI_WORLD_AO_PHASE_STRIDE_Y,
  GI_WORLD_AO_VISIBILITY_POWER,
  giAoFilterWeights,
  giWorldAoResponse,
} from "../src/modules/gi/giScreen.js";

const mod = (x, n) => ((x % n) + n) % n;
const stateAt = (x, y) => mod(x + GI_WORLD_AO_PHASE_STRIDE_Y * y, GI_WORLD_AO_PHASE_PERIOD);

// Axial is deliberately repeated: two states encode its 2/7 quadrature
// weight, while each side cone owns one state and therefore 1/7.
const samples = [0.13, 0.13, 0.22, 0.41, 0.57, 0.79, 0.94];
const expected = samples.reduce((a, b) => a + b, 0) / samples.length;
const phase = giAoFilterWeights(2, true);

assert.equal(GI_WORLD_AO_PHASE_PERIOD, 7);
assert.equal(GI_WORLD_AO_VISIBILITY_POWER, 2);
assert.equal(giWorldAoResponse(1), 1, "an exactly open cone must remain exactly open");
assert.ok(Math.abs(giWorldAoResponse(0.9555) - 0.9130) < 5e-4, "hidden reference response drifted");
assert.ok(Math.abs(giWorldAoResponse(0.9907) - 0.9815) < 5e-4, "open reference response drifted");
assert.equal(phase.supportRadius, 3);
assert.ok(Math.abs(phase.gtao.reduce((a, b) => a + b, 0) - 1) < 1e-12);
assert.equal(phase.gtao[0], 0, "world phase resolve must not widen GTAO contacts");
assert.equal(phase.gtao.at(-1), 0, "world phase resolve must not widen GTAO contacts");

for (let y = 0; y < GI_WORLD_AO_PHASE_PERIOD; y++) {
  for (let x = 0; x < GI_WORLD_AO_PHASE_PERIOD; x++) {
    let filtered = 0;
    for (let k = -phase.supportRadius; k <= phase.supportRadius; k++) {
      filtered += samples[stateAt(x + k, y)] * phase.world[k + phase.supportRadius];
    }
    assert.ok(
      Math.abs(filtered - expected) < 1e-12,
      `phase (${x},${y}) changed the world-AO quadrature: ${filtered} != ${expected}`,
    );
  }
}

// An empty hemisphere is exactly neutral. This is the open-surface invariant:
// AO may reveal an occluder, but it may never weaken fill where there is none.
for (let x = 0; x < GI_WORLD_AO_PHASE_PERIOD; x++) {
  let open = 0;
  for (let k = -phase.supportRadius; k <= phase.supportRadius; k++) {
    open += phase.world[k + phase.supportRadius];
  }
  assert.ok(Math.abs(open - 1) < 1e-12, `open phase ${x} did not preserve visibility 1`);
}

console.log("GI WORLD AO PHASE PASS");
