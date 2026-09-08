/**
 * A disabled entity is INERT: its components are DETACHED, not merely hidden.
 *
 * Reported 2026-09-06: a Global Illumination component inside a disabled
 * "Pool" entity kept building and dispatching its kernels over an empty scene
 * and failed every frame ("make sure the engine does not run ANY components
 * inside of a disabled entity"). The per-mode flags used to write only
 * `object3D.visible`; now `Entity.reconcileActivity` attaches and detaches the
 * components of an entity and its subtree as the flags, the tree and the
 * play mode change — and a detached component stores prop changes without
 * reacting, so nothing a subclass does on a prop change can wake it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Entity } from "../src/engine/Entity.js";
import { Component } from "../src/engine/components/Component.js";
import { registerComponent } from "../src/engine/components/registry.js";

const log = [];
const take = () => log.splice(0);

class Probe extends Component {
  static type = "test-activity-probe";
  static defaults = { n: 0 };
  static schema = [{ key: "n", label: "N", type: "number" }];
  onAttach() { log.push(`attach:${this.entity.name}`); }
  onDetach() { log.push(`detach:${this.entity.name}`); }
  onEnable() { log.push(`enable:${this.entity.name}`); }
  onDisable() { log.push(`disable:${this.entity.name}`); }
}
/** Re-runs onAttach itself on a prop change, as Model/Terrain/Instancer do. */
class SelfAttaching extends Component {
  static type = "test-activity-self";
  static defaults = { n: 0 };
  static schema = [{ key: "n", label: "N", type: "number" }];
  onAttach() { log.push(`attach:${this.entity.name}/self`); }
  onDetach() { log.push(`detach:${this.entity.name}/self`); }
  onPropChanged() { this.onDetach(); this.onAttach(); }
}
registerComponent(Probe);
registerComponent(SelfAttaching);

function makeEngine() {
  const engine = {
    playing: false,
    entities: new Map(),
    rootEntities: [],
    viewOnlyComponents: new Set(),
    scene: { add() {}, remove() {} },
    emit() {},
    on: () => () => {},
    createEntity({ id, name, parent = null } = {}) {
      const entity = new Entity(engine, { id, name });
      engine.entities.set(entity.id, entity);
      entity.setParent(parent);
      return entity;
    },
    /** The per-frame safety net in Engine.#tick. */
    walk() { for (const root of engine.rootEntities) root.reconcileActivity(true); },
  };
  return engine;
}

test("a component added to a disabled entity waits, detached, until the entity is enabled", () => {
  const engine = makeEngine();
  const pool = engine.createEntity({ name: "Pool" });
  pool.setEnabled(false);
  const probe = pool.addComponent("test-activity-probe");
  assert.deepEqual(take(), []);
  assert.equal(probe._attached, false);
  assert.equal(pool.activeInHierarchy, false);

  pool.setEnabled(true);
  assert.deepEqual(take(), ["attach:Pool"]);
  assert.equal(probe._attached, true);

  pool.setEnabled(false);
  assert.deepEqual(take(), ["detach:Pool"]);
  engine.walk(); engine.walk();
  assert.deepEqual(take(), [], "the walk is idempotent");
});

test("a prop change on a detached component is stored and does not attach it", () => {
  const engine = makeEngine();
  const pool = engine.createEntity({ name: "Pool" });
  pool.setEnabled(false);
  const probe = pool.addComponent("test-activity-probe");
  const self = pool.addComponent("test-activity-self");
  probe.setProp("n", 3);
  self.setProp("n", 4);
  assert.deepEqual(take(), []);
  assert.equal(probe.props.n, 3);
  assert.equal(self.props.n, 4);

  pool.setEnabled(true);
  assert.deepEqual(take().sort(), ["attach:Pool", "attach:Pool/self"]);
  self.setProp("n", 5);
  assert.deepEqual(take(), ["detach:Pool/self", "attach:Pool/self"], "attached: reacts as before");
});

test("a disabled ancestor disables the subtree whatever the children's flags say; reparenting follows", () => {
  const engine = makeEngine();
  const root = engine.createEntity({ name: "Root" });
  const pool = engine.createEntity({ name: "Pool" });
  pool.setEnabled(false);
  const child = engine.createEntity({ name: "Child", parent: pool });
  child.addComponent("test-activity-probe");
  assert.deepEqual(take(), []);
  assert.equal(child.enabled, true);
  assert.equal(child.activeInHierarchy, false);

  child.setParent(root);
  assert.deepEqual(take(), ["attach:Child"]);
  child.setParent(pool);
  assert.deepEqual(take(), ["detach:Child"]);

  const grandchild = engine.createEntity({ name: "Grandchild", parent: child });
  grandchild.addComponent("test-activity-probe");
  assert.deepEqual(take(), []);
  pool.setEnabled(true);
  assert.deepEqual(take(), ["attach:Child", "attach:Grandchild"]);
  child.setEnabled(false);
  assert.deepEqual(take(), ["detach:Child", "detach:Grandchild"]);
});

test("removing a component from a disabled entity fires no onDetach; dispose likewise", () => {
  const engine = makeEngine();
  const pool = engine.createEntity({ name: "Pool" });
  pool.addComponent("test-activity-probe");
  pool.addComponent("test-activity-self");
  take();
  pool.setEnabled(false);
  assert.deepEqual(take().sort(), ["detach:Pool", "detach:Pool/self"]);
  pool.removeComponent("test-activity-probe");
  pool.dispose();
  assert.deepEqual(take(), []);
  assert.equal(pool.components.size, 0);
});

test("one enabled flag, both modes; visibleInEditor is a viewing aid that never detaches", () => {
  const engine = makeEngine();
  const playground = engine.createEntity({ name: "Playground" });
  playground.setEnabled(false);
  playground.addComponent("test-activity-probe");
  assert.deepEqual(take(), []);

  engine.playing = true; engine.walk();
  assert.deepEqual(take(), [], "disabled stays detached in play mode");
  assert.equal(playground.activeInHierarchy, false);
  playground.setEnabled(true);
  assert.deepEqual(take(), ["attach:Playground"]);
  engine.playing = false; engine.walk();
  assert.deepEqual(take(), [], "enabled stays attached back in edit mode");

  playground.setVisibleInEditor(false);
  assert.deepEqual(take(), [], "hiding in the editor detaches nothing");
  assert.equal(playground.visibleInEditor, false);
  assert.equal(playground.enabledInEditor, false, "the old name reads the viewing aid");
  assert.equal(playground.enabledInGame, true, "the old game name reads enabled");
  playground.setEnabledInGame(false);
  assert.deepEqual(take(), ["detach:Playground"], "the old game setter is setEnabled");
});

test("a component with no hooks of its own stops by detaching, and rebuilds on enable", () => {
  const engine = makeEngine();
  const box = engine.createEntity({ name: "Box" });
  const self = box.addComponent("test-activity-self");
  assert.deepEqual(take(), ["attach:Box/self"]);
  assert.equal(self.stopsByDetaching, true);
  self.setProp("enabled", false);
  assert.deepEqual(take(), ["detach:Box/self"], "disabled = detached");
  self.setProp("n", 3);
  assert.deepEqual(take(), [], "a prop change while disabled builds nothing");
  self.setProp("enabled", true);
  assert.deepEqual(take(), ["attach:Box/self"], "enabled = built again, from its props");
  assert.equal(self.props.n, 3);
  // Disabled when its entity goes inactive and active again: never built.
  self.setProp("enabled", false);
  take();
  box.setEnabled(false);
  assert.deepEqual(take(), [], "nothing to detach");
  box.setEnabled(true);
  assert.deepEqual(take(), [], "not built while disabled");
  self.setProp("enabled", true);
  assert.deepEqual(take(), ["attach:Box/self"]);
});

test("editorEnabled pauses a component while editing and resumes it on play", () => {
  const engine = makeEngine();
  const fx = engine.createEntity({ name: "Fx" });
  const probe = fx.addComponent("test-activity-probe");
  assert.deepEqual(take(), ["attach:Fx"]);
  probe.setProp("editorEnabled", false);
  assert.deepEqual(take(), ["disable:Fx"]);
  assert.equal(probe.enabled, false);
  engine.playing = true;
  probe.reconcileEnabled();
  assert.deepEqual(take(), ["enable:Fx"], "play mode: the pause lifts");
  engine.playing = false;
  probe.reconcileEnabled();
  assert.deepEqual(take(), ["disable:Fx"], "stopped again: paused again");
  probe.setProp("editorEnabled", true);
  assert.deepEqual(take(), ["enable:Fx"]);
});

test("enable overrides on a detached component fire no hooks and hold once attached", () => {
  const engine = makeEngine();
  const pool = engine.createEntity({ name: "Pool" });
  pool.setEnabled(false);
  const probe = pool.addComponent("test-activity-probe");
  probe.setEnabledOverride(false);
  probe.setEnabled(false);
  assert.deepEqual(take(), []);
  assert.equal(probe.enabled, false);
  pool.setEnabled(true);
  assert.deepEqual(take(), ["attach:Pool"]);
  assert.equal(probe.enabled, false);
  probe.setEnabledOverride(null);
  probe.setEnabled(true);
  assert.deepEqual(take(), ["enable:Pool"]);
});
