import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildShadowBvh } from "../src/modules/gi/window/shadowBvh.worker.js";
import { bvhAnyHit } from "../scripts/lib/shadowBvhMirror.mjs";

const packOwners = (values) => {
  const words = new Uint32Array((values.length + 1) >> 1);
  values.forEach((owner, tri) => { words[tri >> 1] |= owner << ((tri & 1) * 16); });
  return words;
};

test("an emitter owner cannot occlude its own direct-shadow ray", () => {
  // Two parallel quads. Owner 7 is the sampled emitter; owner 9 is a real
  // blocker behind it. Rejecting 7 must reveal 9, not make the ray clear.
  const tris = new Float32Array([
    -1, -1, 2, 1, -1, 2, 1, 1, 2,
    -1, -1, 2, 1, 1, 2, -1, 1, 2,
    -1, -1, 4, 1, -1, 4, 1, 1, 4,
    -1, -1, 4, 1, 1, 4, -1, 1, 4,
  ]);
  const bvh = buildShadowBvh({ tris: tris.slice(), triCount: 4, maxLeafSize: 2 });
  const owners = packOwners([7, 7, 9, 9]);
  const ro = [0, 0, 0], rd = [0, 0, 1];

  assert.equal(bvhAnyHit(bvh, tris, ro, rd, 5, { owners }).hit, 1);
  assert.equal(bvhAnyHit(bvh, tris, ro, rd, 5, { owners, skipOwner: 7 }).hit, 1,
    "the unrelated owner still blocks");
  const excluded = new Uint32Array(32);
  excluded[9 >> 5] |= 1 << (9 & 31);
  assert.equal(bvhAnyHit(bvh, tris, ro, rd, 5, { owners, skipOwner: 7, excluded }).hit, 0,
    "the sampled emitter is rejected independently of the global mover mask");
});

test("dynamic emitter clearance is a ray/OBB entry, not a fixed two-cell trim", () => {
  const P = [5, 5, 0], Q = [1, 0.9, 0], v0 = 0.25;
  const d = Math.hypot(...Q.map((q, i) => q - P[i]));
  const rd = Q.map((q, i) => (q - P[i]) / d);
  const expanded = [1 + 2 * v0, 1 + 2 * v0, 1 + 2 * v0];
  let entry = -Infinity;
  for (let a = 0; a < 3; a++) {
    const safe = Math.abs(rd[a]) > 1e-6 ? rd[a] : (rd[a] >= 0 ? 1e-6 : -1e-6);
    const t0 = (-expanded[a] - P[a]) / safe;
    const t1 = (expanded[a] - P[a]) / safe;
    entry = Math.max(entry, Math.min(t0, t1));
  }
  const bounded = Math.max(v0 * 0.5, entry - v0 * 0.5);
  const oldFixedTrim = d - 2 * v0;
  assert.ok(bounded < oldFixedTrim - 0.1,
    `grazing ray still entered the dilated emitter: bounded=${bounded}, old=${oldFixedTrim}`);
});

test("shipping graph wires both exact and dynamic source exclusion without a new buffer", async () => {
  const [bvh, direct, system] = await Promise.all([
    readFile(new URL("../src/modules/gi/window/shadowBvh.js", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/gi/window/rc/rcDirect.js", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8"),
  ]);
  assert.match(bvh, /ow == skipOwner/);
  assert.match(direct, /uint\(slot\.owner\)/);
  assert.match(direct, /vox:\s*voxelEntry\(qdir\)/);
  assert.doesNotMatch(direct, /vox:\s*dq\.sub\(float\(2 \* v0\)\)/);
  assert.match(system, /owner:\s*uniform\(0xffffffff, "uint"\)/);
  assert.match(system, /_gi2StaticOwnerOf = ownerOf/);
});
