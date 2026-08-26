// LEVEL ROOM DERIVATION GATE (§15 U4b) — pure Node, no GPU: `levelRooms`
// flood-fills wall footprints into per-storey rooms, and this gate asserts
// the properties the auto reflection probes stand on:
//
//   1. a two-room flat with a DOOR OPENING in the partition derives TWO
//      rooms, not one — openings are deliberately rasterized solid, because
//      a doorway connects rooms in 3-D while they remain two rooms (the
//      cross-room probe box is the phantom-wall failure);
//   2. room boxes land on the rooms' inner extents (box projection is only
//      "nearly exact" when the box IS the room);
//   3. capture points sit INSIDE their room at eye height (U4a's clearance
//      receipt: a capture point in a wall poisons every lookup);
//   4. an unenclosed layout derives NOTHING (three walls enclose no room);
//   5. rotated walls (the yaw-snapped norm) rasterize where they stand.
//
//   node scripts/run-level-rooms-test.mjs
import * as THREE from "three";
import { levelRooms } from "../src/modules/level-design/rooms.js";

let pass = true;
const say = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) pass = false;
};

/** A minimal stand-in for a Blockout piece: props + a world transform. */
function wall(x, z, length, { yaw = 0, openings = [] } = {}) {
  const object3D = new THREE.Object3D();
  object3D.position.set(x, 0, z);
  object3D.rotation.y = yaw;
  object3D.updateMatrixWorld(true);
  return { props: { shape: "wall", size: [length, 3, 0.2], openings }, entity: { object3D } };
}

/** A minimal stand-in for a LevelComponent over loose pieces (no floors). */
function fakeLevel(pieces) {
  const object3D = new THREE.Object3D();
  object3D.updateMatrixWorld(true);
  return {
    props: { storeyHeight: 3 },
    entity: { object3D },
    floors: () => [],
    pieces: () => pieces,
  };
}

// ── the two-room flat: 8×4 outer shell, partition at x=0 with a door ───────
const HALF = Math.PI / 2;
const flat = fakeLevel([
  wall(0, -2, 8),
  wall(0, 2, 8),
  wall(-4, 0, 4, { yaw: HALF }),
  wall(4, 0, 4, { yaw: HALF }),
  wall(0, 0, 4, { yaw: HALF, openings: [{ offset: 1.5, width: 1, height: 2.1, sill: 0 }] }),
]);
const rooms = levelRooms(flat);
say("two-room flat derives exactly 2 rooms (door does not merge them)",
  rooms.length === 2, `got ${rooms.length}`);
if (rooms.length === 2) {
  const byX = [...rooms].sort((a, b) => a.center[0] - b.center[0]);
  const near = (v, want, tol) => Math.abs(v - want) <= tol;
  say("room centres land at (±2, 1.5, 0)",
    near(byX[0].center[0], -2, 0.35) && near(byX[1].center[0], 2, 0.35) &&
    byX.every((r) => near(r.center[1], 1.5, 0.01) && near(r.center[2], 0, 0.35)),
    byX.map((r) => r.center.map((v) => v.toFixed(2)).join(",")).join("  |  "));
  say("room boxes span the inner extents (~3.8 × 3 × 3.8)",
    byX.every((r) => near(r.size[0], 3.8, 0.6) && near(r.size[1], 3, 0.01) && near(r.size[2], 3.8, 0.6)),
    byX.map((r) => r.size.map((v) => v.toFixed(2)).join("x")).join("  |  "));
  say("capture points sit inside their room at eye height",
    byX.every((r) =>
      Math.abs(r.capture[0] - r.center[0]) <= r.size[0] / 2 &&
      Math.abs(r.capture[2] - r.center[2]) <= r.size[2] / 2 &&
      near(r.capture[1], 1.65, 0.1)),
    byX.map((r) => r.capture.map((v) => v.toFixed(2)).join(",")).join("  |  "));
}

// ── an unenclosed layout: three walls make no room ─────────────────────────
const open = fakeLevel([
  wall(0, -2, 8),
  wall(-4, 0, 4, { yaw: HALF }),
  wall(4, 0, 4, { yaw: HALF }),
]);
say("three walls enclose nothing", levelRooms(open).length === 0,
  `got ${levelRooms(open).length}`);

// ── a single sealed room, walls at 45° (worst case for the yaw snap) ───────
const diag = fakeLevel([
  wall(0, -2.83, 8, { yaw: Math.PI / 4 }),
  wall(0, 2.83, 8, { yaw: Math.PI / 4 }),
  wall(-2.83, 0, 8, { yaw: -Math.PI / 4 }),
  wall(2.83, 0, 8, { yaw: -Math.PI / 4 }),
]);
const diagRooms = levelRooms(diag);
say("a rotated sealed room still derives one room", diagRooms.length === 1,
  `got ${diagRooms.length}`);

console.log(pass ? "\nALL PASS" : "\nFAIL");
process.exit(pass ? 0 : 1);
