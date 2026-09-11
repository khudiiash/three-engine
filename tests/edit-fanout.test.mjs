/**
 * ONE PARAMETER EDIT MUST NOT BE A SCENE-WIDE EVENT.
 *
 * Reported 2026-09-07: "changing a param freezes again. I spend more time
 * waiting than developing." The audit (ZERO_FREEZE_PLAN §2.4) found the shape:
 * `Component.setProp` emitted "hierarchy-changed" for EVERY property of EVERY
 * component, that event reaches ~20 listeners which each WALK THE SCENE, and a
 * NumberField scrub did the whole thing once per `pointermove`.
 *
 * These are the four claims Stage 1 rests on:
 *   1. an ordinary value edit emits "component-changed" and NOT
 *      "hierarchy-changed" (§1.1);
 *   2. a STRUCTURAL edit — one that adds or removes something from the scene
 *      graph — still emits it, because shadowMerge subscribes to that event
 *      ALONE and would otherwise bake a caster set that no longer exists;
 *   3. the React mirror can re-read ONE entity and leave every other mirror
 *      object's IDENTITY intact, or the Hierarchy re-renders anyway and §1.2
 *      buys nothing (§1.2);
 *   4. a burst of automatic-collider flushes is one event, not thirty — the
 *      `[engine] hierarchy-changed storm: 30 flushes within a second` line the
 *      user's own boot printed, traced to `#flushDefaultColliders` (§1.4).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Entity } from "../src/engine/Entity.js";
import { Component } from "../src/engine/components/Component.js";
import { registerComponent } from "../src/engine/components/registry.js";

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */

/** Overrides onPropChanged, so ONLY its declared structural keys are structural. */
class Widget extends Component {
  static type = "test-fanout-widget";
  static defaults = { intensity: 1, geometry: "box", flavour: "plain" };
  static schema = [
    { key: "intensity", label: "Intensity", type: "number" },
    // The opt-in marker unit 1.1 adds to the descriptor shape.
    { key: "geometry", label: "Geometry", type: "select", options: ["box", "sphere"], structural: true },
    { key: "flavour", label: "Flavour", type: "text" },
  ];
  onPropChanged() {}
}

/** Declares its structural keys on the class instead of the schema. */
class ClassListed extends Component {
  static type = "test-fanout-classlisted";
  static defaults = { path: "", tint: 0 };
  static schema = [
    { key: "path", label: "File", type: "asset" },
    { key: "tint", label: "Tint", type: "number" },
  ];
  static structuralProps = ["path"];
  onPropChanged() {}
}

/**
 * NO onPropChanged override — the base one runs `onDetach(); onAttach()`, so
 * every prop change literally replaces this component's objects in the scene
 * graph. Rule 4 of STRUCTURAL_PROPS: all of its props are structural.
 */
class Rebuilder extends Component {
  static type = "test-fanout-rebuilder";
  static defaults = { n: 0 };
  static schema = [{ key: "n", label: "N", type: "number" }];
}

registerComponent(Widget);
registerComponent(ClassListed);
registerComponent(Rebuilder);

function makeEngine() {
  const events = [];
  const engine = {
    playing: false,
    entities: new Map(),
    rootEntities: [],
    viewOnlyComponents: new Set(),
    scene: { add() {}, remove() {} },
    events,
    emit(event, payload) {
      events.push({ event, payload });
    },
    on: () => () => {},
    createEntity({ id, name, parent = null } = {}) {
      const entity = new Entity(engine, { id, name });
      engine.entities.set(entity.id, entity);
      entity.setParent(parent);
      return entity;
    },
    getEntity(id) {
      return engine.entities.get(id);
    },
    take() {
      return events.splice(0).map((e) => e.event);
    },
  };
  return engine;
}

/* -------------------------------------------------------------------------- */
/* §1.1 — classify setProp                                                     */

test("an ordinary value edit emits component-changed and NOT hierarchy-changed", () => {
  const engine = makeEngine();
  const entity = engine.createEntity({ name: "Widget" });
  const widget = entity.addComponent("test-fanout-widget");
  engine.take();

  widget.setProp("intensity", 2);
  assert.deepEqual(engine.take(), ["component-changed"]);
  assert.equal(widget.isStructuralProp("intensity"), false);

  widget.setProp("flavour", "salted");
  assert.deepEqual(engine.take(), ["component-changed"]);
});

test("a structural edit still emits hierarchy-changed — from the schema, the class, or the base rebuild", () => {
  const engine = makeEngine();
  const entity = engine.createEntity({ name: "Widget" });

  // 1. `structural: true` on the schema descriptor.
  const widget = entity.addComponent("test-fanout-widget");
  engine.take();
  widget.setProp("geometry", "sphere");
  assert.deepEqual(engine.take(), ["component-changed", "hierarchy-changed"]);
  assert.equal(widget.isStructuralProp("geometry"), true);

  // 2. `static structuralProps` on the class.
  const listed = entity.addComponent("test-fanout-classlisted");
  engine.take();
  listed.setProp("path", "models/tree.glb");
  assert.deepEqual(engine.take(), ["component-changed", "hierarchy-changed"]);
  listed.setProp("tint", 0.5);
  assert.deepEqual(engine.take(), ["component-changed"]);

  // 3. No onPropChanged override: the base rebuilds by detach/attach, so the
  //    objects leave and re-enter the graph and EVERY prop is structural.
  const rebuilder = entity.addComponent("test-fanout-rebuilder");
  engine.take();
  rebuilder.setProp("n", 7);
  assert.deepEqual(engine.take(), ["component-changed", "hierarchy-changed"]);
});

test("`enabled` is always structural — a disabled component detaches from the graph", () => {
  const engine = makeEngine();
  const entity = engine.createEntity({ name: "Widget" });
  const widget = entity.addComponent("test-fanout-widget");
  engine.take();
  widget.setProp("enabled", false);
  assert.deepEqual(engine.take(), ["component-changed", "hierarchy-changed"]);
});

test("the hatch restores the old fan-out: every prop structural", () => {
  const engine = makeEngine();
  const entity = engine.createEntity({ name: "Widget" });
  const widget = entity.addComponent("test-fanout-widget");
  globalThis.__engineStructuralProps = false;
  try {
    engine.take();
    widget.setProp("intensity", 3);
    assert.deepEqual(engine.take(), ["component-changed", "hierarchy-changed"]);
  } finally {
    delete globalThis.__engineStructuralProps;
  }
});

test("the real components' structural keys are the ones the listeners need", async () => {
  const { registerBuiltInComponents, getComponentClass } = await import("../src/engine/index.js");
  registerBuiltInComponents();
  const engine = makeEngine();
  const entity = engine.createEntity({ name: "Probe" });

  // A light's intensity/colour write in place, and since 2026-09-10 so does
  // `castShadow` (LightComponent.#castShadowInPlace keeps the THREE.Light);
  // its `kind`/`shadowMode`/csm shape still replace the THREE.Light.
  const LightComponent = getComponentClass("light");
  const light = new LightComponent();
  light.entity = entity;
  for (const key of ["intensity", "color", "shadowBias", "shadowCamSize", "csmSplitLambda", "castShadow"]) {
    assert.equal(light.isStructuralProp(key), false, `light.${key} must not be structural`);
  }
  for (const key of ["kind", "shadowMode", "csm"]) {
    assert.equal(light.isStructuralProp(key), true, `light.${key} must be structural`);
  }

  // A mesh's geometry/material/shadow flags move it between merge groups,
  // batch groups and the shadow-merge caster set. `collision` and the gi*
  // trio do NOT: physics filters "component-changed" by exactly those keys and
  // GI re-queues its rebake check from the same event.
  const MeshComponent = getComponentClass("mesh");
  const mesh = new MeshComponent();
  mesh.entity = entity;
  for (const key of ["geometry", "geometryAsset", "material", "material4", "castShadow", "receiveShadow"]) {
    assert.equal(mesh.isStructuralProp(key), true, `mesh.${key} must be structural`);
  }
  for (const key of ["collision", "giMobility", "giTrace", "giProxy"]) {
    assert.equal(mesh.isStructuralProp(key), false, `mesh.${key} must not be structural`);
  }
});

/* -------------------------------------------------------------------------- */
/* §1.2 — the mirror updates one entity                                        */

test("refreshEntity re-reads one entity and keeps every other mirror object's identity", async () => {
  const { useSceneStore, sceneMirrorStats, attachSceneEngine } = await import("../src/editor/store/sceneStore.js");
  const engine = makeEngine();
  const a = engine.createEntity({ id: "a", name: "A" });
  const b = engine.createEntity({ id: "b", name: "B" });
  const c = engine.createEntity({ id: "c", name: "C" });
  a.addComponent("test-fanout-widget");
  b.addComponent("test-fanout-widget");
  engine.sceneName = "Fixture";
  engine.rootEntities = [a, b, c];

  // The store reads the engine through a module-local cache that
  // `ensureEngine()` fills in the editor. Publish this fixture into it the
  // same way, then drive the store directly.
  attachSceneEngine(engine);

  useSceneStore.getState().refresh();
  const before = useSceneStore.getState().entities;
  assert.equal(Object.keys(before).length, 3);
  const fullBefore = sceneMirrorStats.full;

  b.getComponent("test-fanout-widget").props.intensity = 42;
  useSceneStore.getState().refreshEntity("b");

  const after = useSceneStore.getState().entities;
  assert.notEqual(after, before, "the map object must be replaced or zustand sees nothing");
  assert.equal(after.a, before.a, "an untouched entity's mirror must keep its identity");
  assert.equal(after.c, before.c, "an untouched entity's mirror must keep its identity");
  assert.notEqual(after.b, before.b, "the touched entity must be re-read");
  assert.equal(after.b.components["test-fanout-widget"].intensity, 42);
  assert.equal(sceneMirrorStats.full, fullBefore, "no full rebuild happened");

  // An id the mirror has never seen is STRUCTURE and belongs to refresh() —
  // inserting it here would publish a tree whose rootIds do not close.
  const d = engine.createEntity({ id: "d", name: "D" });
  d.addComponent("test-fanout-widget");
  const incrementalBefore = sceneMirrorStats.incremental;
  useSceneStore.getState().refreshEntity("d");
  assert.equal(useSceneStore.getState().entities.d, undefined);
  assert.equal(sceneMirrorStats.incremental, incrementalBefore, "an unknown id counts as nothing");
});

/* -------------------------------------------------------------------------- */
/* §1.2 / §1.3 — the command bus: one refresh per edit, one entry per drag      */

/**
 * Seeds the editor's engine handle so `CommandBus` (which reaches the engine
 * through a Proxy that throws until `ensureEngine()` resolves) can run against
 * a fixture. `vmSingleton` hands back the same object the module captured, so
 * writing `.instance` is exactly what `ensureEngine` does.
 */
async function attachEditorEngine(engine) {
  const { vmSingleton } = await import("../src/editor/singleton.js");
  const state = vmSingleton("engineInstance", () => ({ instance: null, loader: null }));
  state.instance = engine;
  const { attachSceneEngine } = await import("../src/editor/store/sceneStore.js");
  attachSceneEngine(engine);
}

test("a drag is ONE undo entry, and it undoes to the value the drag started from", async () => {
  const engine = makeEngine();
  const entity = engine.createEntity({ id: "w", name: "Widget" });
  const widget = entity.addComponent("test-fanout-widget");
  await attachEditorEngine(engine);
  const { commandBus } = await import("../src/editor/commands/CommandBus.js");
  const { useSceneStore } = await import("../src/editor/store/sceneStore.js");
  useSceneStore.getState().refresh();
  commandBus.clearHistory();

  const setTo = (v) => ({
    label: `Set intensity`,
    from: widget.props.intensity,
    do() { widget.setProp("intensity", v); },
    undo() { widget.setProp("intensity", this.from); },
  });

  // The scrub: 40 pointer frames, each applied so the viewport shows it.
  commandBus.beginPreview();
  for (let i = 1; i <= 40; i++) commandBus.execute(setTo(i));
  assert.equal(widget.props.intensity, 40, "the viewport must see every previewed value");
  assert.equal(commandBus.undoStack.length, 0, "a preview pushes nothing while it runs");

  commandBus.endPreview();
  assert.equal(commandBus.undoStack.length, 1, "a whole drag is ONE entry");

  commandBus.undo();
  assert.equal(widget.props.intensity, 1, "undo restores the value the drag started from");
  commandBus.redo();
  assert.equal(widget.props.intensity, 40, "redo replays the value it was released on");
});

test("a value edit does not rebuild the whole mirror — the incremental read already did", async () => {
  const engine = makeEngine();
  const a = engine.createEntity({ id: "a", name: "A" });
  const b = engine.createEntity({ id: "b", name: "B" });
  const widget = a.addComponent("test-fanout-widget");
  b.addComponent("test-fanout-widget");
  await attachEditorEngine(engine);
  const { commandBus } = await import("../src/editor/commands/CommandBus.js");
  const { useSceneStore, sceneMirrorStats } = await import("../src/editor/store/sceneStore.js");

  // The editor's own wiring, which `oncePerVm` skips headlessly: the mirror
  // subscribes to "component-changed" and re-reads exactly the entity named.
  const listeners = {
    "component-changed": (info) => useSceneStore.getState().refreshEntity(info?.entityId),
  };
  engine.emit = (event, payload) => {
    engine.events.push({ event, payload });
    listeners[event]?.(payload);
  };

  useSceneStore.getState().refresh();
  const before = { ...sceneMirrorStats };
  const mirrorBefore = useSceneStore.getState().entities;

  commandBus.execute({
    label: "Set intensity",
    do() { widget.setProp("intensity", 9); },
    undo() { widget.setProp("intensity", 1); },
  });
  await new Promise((r) => queueMicrotask(r));

  assert.equal(sceneMirrorStats.incremental, before.incremental + 1, "the one entity was re-read");
  assert.equal(sceneMirrorStats.full, before.full, "and the scene-sized rebuild was skipped");
  const mirrorAfter = useSceneStore.getState().entities;
  assert.equal(mirrorAfter.b, mirrorBefore.b, "an untouched row keeps its identity across an edit");
  assert.equal(mirrorAfter.a.components["test-fanout-widget"].intensity, 9);
});

/* -------------------------------------------------------------------------- */
/* §1.5 — a settle that holds a storm without holding a single edit             */

test("batching regroups ONE change at once and makes a burst wait for the settle", async () => {
  const { BatchSystem } = await import("../src/engine/batching.js");
  const engine = {
    playing: false,
    entities: new Map(),
    scene: { updateMatrixWorld() {}, add() {}, remove() {} },
    on: () => () => {},
  };
  const system = new BatchSystem(engine);
  system.setEnabled(true);

  system.sync();
  assert.equal(system._dirty, false, "the FIRST grouping never waits — a boot must not show unbatched draws");

  // One deliberate change (an eye toggle, one material swap). A batch's inputs
  // include VISIBILITY, so holding this for the settle would leave the entity
  // drawing through its batch — the ghost `scripts/run-batching-test.mjs`
  // caught as `expected 9 instances, got 10`.
  system.invalidate();
  system.sync();
  assert.equal(system._dirty, false, "a single invalidation is not a storm and must be shown at once");

  // A burst — a scene load, a prefab expansion, a `component-changed` storm.
  system.invalidate();
  system.invalidate();
  system.invalidate();
  system.sync();
  assert.equal(system._dirty, true, "a burst waits instead of regrouping once per event");

  // …and is never starved: MAX_DEFER_MS releases it even while events keep
  // arriving. Reaching back through the clock is how the ceiling is testable
  // without sleeping two seconds.
  system._dirtySince = performance.now() - 5000;
  system.sync();
  assert.equal(system._dirty, false, "the starve ceiling releases a scene that never settles");

  globalThis.__engineBatchingSettle = false;
  try {
    system.invalidate();
    system.invalidate();
    system.sync();
    assert.equal(system._dirty, false, "the hatch regroups on the next frame again");
  } finally {
    delete globalThis.__engineBatchingSettle;
  }
});

/**
 * ⛔⛔ CLAIM 5, AND THE ONE STAGE 1 BROKE: SOMEONE STILL HAS TO REDRAW.
 *
 * Claim 1 above is that an ordinary value edit no longer emits
 * "hierarchy-changed". That is the whole point of the unit — and it is also a
 * removal, because that event was doing a second job nobody had written down:
 * it was the signal the editor's frame pacer used to WAKE A SUSPENDED VIEWPORT.
 *
 * So the fan-out went away and so did the redraw. "most prop changes do not
 * display immediately in the editor, only after restarting the editor" (user,
 * 2026-09-08) — restarting was not fixing anything, it was just the next thing
 * that woke the loop.
 *
 * A test for claim 1 alone passes happily in that world, which is exactly why
 * this one exists beside it.
 */
test("⭐ a non-structural edit still reaches the viewport's wake list", async () => {
  const { VIEWPORT_WAKE_EVENTS } = await import("../src/editor/editorFramePacing.js");

  // Every event a value edit can produce has to be in the list, or the picture
  // the user is looking at is stale until something else happens to it.
  const engine = makeEngine();
  const widget = engine.createEntity({ name: "Widget" }).addComponent("test-fanout-widget");
  engine.take();
  widget.setProp("intensity", 4);
  const emitted = engine.take();

  assert.ok(emitted.length > 0, "a value edit must emit something");
  for (const event of emitted) {
    assert.ok(VIEWPORT_WAKE_EVENTS.includes(event),
      `"${event}" is emitted by an ordinary prop edit but does not wake the viewport`);
  }
  // Stated directly, so the list cannot be trimmed back by accident.
  assert.ok(VIEWPORT_WAKE_EVENTS.includes("component-changed"));
  assert.ok(VIEWPORT_WAKE_EVENTS.includes("hierarchy-changed"));
});
