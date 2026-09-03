import assert from "node:assert/strict";
import test from "node:test";
import {
  addGeneratedAnimatorState,
  suggestGeneratedClipName,
  uniqueGeneratedClipName,
} from "../src/editor/kimodoIntegration.js";

test("a prompt becomes a compact generated clip name", () => {
  assert.equal(suggestGeneratedClipName("  a person walks forward, steadily  "), "APersonWalks");
  assert.equal(suggestGeneratedClipName("!!!"), "Generated");
});

test("generated clips never shadow an older same-named clip", () => {
  assert.equal(uniqueGeneratedClipName("Walk", ["Idle", "Walk"]), "Walk 2");
  assert.equal(uniqueGeneratedClipName("Walk", ["walk", "Walk 2"]), "Walk 3");
  assert.equal(uniqueGeneratedClipName("Attack", ["Idle", "Walk"]), "Attack");
});

test("the first generated clip becomes the layer entry state", () => {
  let serial = 0;
  const result = addGeneratedAnimatorState({
    nodes: [
      { id: "__start__", type: "startState", data: {}, position: { x: 0, y: 0 } },
      { id: "__any__", type: "anyState", data: {}, position: { x: 0, y: 0 } },
    ],
    edges: [],
    clipName: "QuickTurn",
    makeId: (prefix) => `${prefix}-${++serial}`,
  });
  const state = result.nodes.find((node) => node.type === "animState");
  assert.equal(state.data.state.clip, "QuickTurn");
  assert.equal(state.data.state.name, "QuickTurn");
  assert.equal(state.selected, true);
  assert.deepEqual(result.edges.map((edge) => [edge.source, edge.target]), [["__start__", state.id]]);
});

test("generation does not disturb an established entry transition", () => {
  const existing = {
    id: "idle",
    type: "animState",
    position: { x: 0, y: 0 },
    selected: true,
    data: { state: { id: "idle", name: "Idle", clip: "Idle" } },
  };
  const result = addGeneratedAnimatorState({
    nodes: [existing],
    edges: [{ id: "entry", source: "__start__", target: "idle", selected: true, data: { kind: "start" } }],
    clipName: "Wave",
    makeId: (prefix) => `${prefix}-new`,
  });
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].target, "idle");
  assert.equal(result.edges[0].selected, false);
  assert.equal(result.nodes.find((node) => node.id === "idle").selected, false);
  assert.equal(result.nodes.find((node) => node.id === result.stateId).selected, true);
});
