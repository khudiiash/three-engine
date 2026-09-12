/**
 * Per-platform component configs (src/engine/componentVariants.js +
 * Component.applyPlatformLayers).
 *
 * A component's `props` are its desktop values; `props.variants` carries up to
 * three partial override sets (mobile / portrait / landscape) that the engine
 * cascades into `props` for the platform it runs on. Every system keeps
 * reading `component.props.x`, so the contract this pins is entirely about
 * WHICH value sits in that slot, when it gets there, and what is saved:
 *
 *   - a component is BUILT from its phone values on a phone (the apply runs
 *     before `onAttach`, silently — no rebuild a frame later);
 *   - a context change (rotation, the editor's preview) writes through the
 *     ordinary prop path, so `onPropChanged` and the events fire for exactly
 *     the keys that moved;
 *   - `toJSON` writes the DESKTOP values whatever is applied, and leaving Play
 *     restores the phone layout rather than un-applying it;
 *   - three write paths with three meanings: `setProp` = the effective value
 *     (a script), `setBaseProp` = the desktop value, `setVariantProp` = one
 *     set's value; only the last two are what the editor commands use.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Entity } from "../src/engine/Entity.js";
import { Component } from "../src/engine/components/Component.js";
import { registerComponent } from "../src/engine/components/registry.js";
import {
  platformLayers,
  targetToPlatform,
  platformToTarget,
  editLayerFor,
  resolveVariantOverrides,
  normalizeVariants,
  VARIANT_EXCLUDED_KEYS,
} from "../src/engine/componentVariants.js";

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */

const log = [];
const take = () => log.splice(0);

/** Logs its lifecycle and every prop reaction — the only observable a system has. */
class Widget extends Component {
  static type = "test-variants-widget";
  static defaults = { size: [100, 100], opacity: 1, label: "hud" };
  static schema = [
    { key: "size", label: "Size", type: "vec2" },
    { key: "opacity", label: "Opacity", type: "number" },
    { key: "label", label: "Label", type: "text" },
  ];
  onAttach() { log.push(`attach size=${this.props.size.join("x")} opacity=${this.props.opacity}`); }
  onDetach() { log.push("detach"); }
  onPropChanged(key) { log.push(`changed:${key}`); }
}
/** No hooks of its own: disabling it DETACHES it (Component.stopsByDetaching). */
class Plain extends Component {
  static type = "test-variants-plain";
  static defaults = { n: 1 };
  static schema = [{ key: "n", label: "N", type: "number" }];
  onAttach() { log.push("plain:attach"); }
  onDetach() { log.push("plain:detach"); }
  onPropChanged() { log.push("plain:changed"); }
}
registerComponent(Widget);
registerComponent(Plain);

function makeEngine() {
  const events = [];
  const engine = {
    playing: false,
    entities: new Map(),
    rootEntities: [],
    viewOnlyComponents: new Set(),
    variantComponents: new Set(),
    platform: { platform: "desktop", orientation: "landscape" },
    get platformLayers() { return platformLayers(engine.platform); },
    /** The loop Engine.#resolvePlatform runs. */
    setPlatform(context) {
      engine.platform = context;
      const layers = engine.platformLayers;
      for (const component of engine.variantComponents) component.applyPlatformLayers(layers);
    },
    scene: { add() {}, remove() {} },
    events,
    emit(name, payload) { events.push([name, payload?.key]); },
    on: () => () => {},
    createEntity({ id, name, parent = null } = {}) {
      const entity = new Entity(engine, { id, name });
      engine.entities.set(entity.id, entity);
      entity.setParent(parent);
      return entity;
    },
    getEntity(id) { return engine.entities.get(id) ?? null; },
  };
  return engine;
}

const VARIANTS = {
  mobile: { size: [60, 60], label: "phone" },
  portrait: { size: [40, 80] },
};

/* -------------------------------------------------------------------------- */
/* the vocabulary                                                              */

test("a platform context resolves to a layer cascade, orientation on top of mobile", () => {
  assert.deepEqual(platformLayers({ platform: "desktop", orientation: "portrait" }), []);
  assert.deepEqual(platformLayers({ platform: "mobile", orientation: "landscape" }), ["mobile", "landscape"]);
  assert.deepEqual(platformLayers({ platform: "mobile", orientation: "portrait" }), ["mobile", "portrait"]);
  assert.deepEqual(platformLayers({ platform: "mobile", orientation: null }), ["mobile"]);
  assert.deepEqual(platformLayers(null), []);
});

test("editor targets round-trip through platform contexts", () => {
  for (const target of ["desktop", "mobile", "portrait", "landscape"]) {
    assert.equal(platformToTarget(targetToPlatform(target)), target, target);
  }
  assert.deepEqual(targetToPlatform("mobile"), { platform: "mobile", orientation: null });
  assert.deepEqual(targetToPlatform("bogus"), { platform: "desktop", orientation: null });
});

test("the cascade: later layers win, keys a layer does not name fall through", () => {
  assert.deepEqual(resolveVariantOverrides(VARIANTS, ["mobile", "portrait"]), { size: [40, 80], label: "phone" });
  assert.deepEqual(resolveVariantOverrides(VARIANTS, ["mobile", "landscape"]), { size: [60, 60], label: "phone" });
  assert.deepEqual(resolveVariantOverrides(VARIANTS, []), {});
  assert.deepEqual(resolveVariantOverrides(null, ["mobile"]), {});
});

test("the edit layer is the topmost ACTIVE set the component has, else the base", () => {
  assert.equal(editLayerFor(VARIANTS, ["mobile", "portrait"]), "portrait");
  assert.equal(editLayerFor(VARIANTS, ["mobile", "landscape"]), "mobile", "no landscape set → the mobile one");
  assert.equal(editLayerFor(VARIANTS, []), null, "desktop preview edits the base");
  assert.equal(editLayerFor(null, ["mobile", "portrait"]), null, "a component with no sets edits the base");
});

test("normalizeVariants drops empty, unknown and excluded content", () => {
  assert.equal(normalizeVariants({}), null);
  assert.equal(normalizeVariants({ tablet: { n: 1 } }), null, "unknown layer");
  assert.equal(normalizeVariants([1]), null);
  assert.deepEqual(
    normalizeVariants({ mobile: { n: 1, viewOnly: true, variants: {} }, portrait: {} }),
    { mobile: { n: 1 }, portrait: {} },
    "excluded keys go, an empty set stays (the author chose to have one)",
  );
  assert.ok(VARIANT_EXCLUDED_KEYS.has("editorEnabled") && !VARIANT_EXCLUDED_KEYS.has("enabled"));
});

/* -------------------------------------------------------------------------- */
/* applying                                                                    */

test("a component is BUILT from its phone values on a phone — applied before onAttach, silently", () => {
  const engine = makeEngine();
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget", { variants: VARIANTS });
  assert.deepEqual(take(), ["attach size=40x80 opacity=1"], "no changed:* before attach");
  assert.deepEqual(w.props.size, [40, 80]);
  assert.equal(w.props.label, "phone");
  assert.equal(w.props.opacity, 1, "a key no layer names is the base");
  assert.ok(engine.variantComponents.has(w), "registered for platform changes");
  assert.deepEqual(w.platformLayers, ["mobile", "portrait"]);
});

test("a context change writes through the ordinary prop path for exactly the keys that moved", () => {
  const engine = makeEngine();
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget", { variants: VARIANTS });
  take();
  engine.events.length = 0;

  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  assert.deepEqual(take().sort(), ["changed:label", "changed:size"]);
  assert.deepEqual(w.props.size, [40, 80]);

  // Rotate: portrait's size leaves, mobile's takes over; label is unchanged.
  engine.setPlatform({ platform: "mobile", orientation: "landscape" });
  assert.deepEqual(take(), ["changed:size"]);
  assert.deepEqual(w.props.size, [60, 60]);
  assert.equal(w.props.label, "phone");

  // Back to desktop: everything restored.
  engine.setPlatform({ platform: "desktop", orientation: "landscape" });
  assert.deepEqual(take().sort(), ["changed:label", "changed:size"]);
  assert.deepEqual(w.props.size, [100, 100]);
  assert.equal(w.props.label, "hud");
  assert.equal(w._variantBase, null, "nothing kept aside once nothing is applied");

  const emitted = engine.events.filter(([name]) => name === "component-changed").map(([, key]) => key);
  assert.ok(emitted.includes("size") && emitted.includes("label"), "the precise event fired per key");
  assert.ok(!engine.events.some(([name]) => name === "hierarchy-changed"), "a value edit is not structural");
});

test("re-applying the same layers is idempotent — nothing fires when nothing moved", () => {
  const engine = makeEngine();
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget", { variants: VARIANTS });
  take();
  w.applyPlatformLayers(["mobile", "portrait"]);
  assert.deepEqual(take(), []);
});

test("a component with no sets is untouched by platform changes and never registered", () => {
  const engine = makeEngine();
  const e = engine.createEntity({ name: "Light" });
  const w = e.addComponent("test-variants-widget");
  take();
  assert.equal(w.variants, null);
  assert.ok(!("variants" in w.props), "no empty `variants` key is stored");
  assert.ok(!engine.variantComponents.has(w));
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  assert.deepEqual(take(), []);
  assert.deepEqual(w.props.size, [100, 100]);
});

/* -------------------------------------------------------------------------- */
/* saving                                                                      */

test("toJSON writes the DESKTOP values whatever is applied, and carries the sets", () => {
  const engine = makeEngine();
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget", { variants: VARIANTS });
  assert.deepEqual(w.props.size, [40, 80], "the scene shows the phone value");
  const json = w.toJSON();
  assert.deepEqual(json.props.size, [100, 100], "the file keeps the desktop value");
  assert.equal(json.props.label, "hud");
  assert.deepEqual(json.props.variants, VARIANTS);
  assert.deepEqual(w.baseProps.size, [100, 100]);
  assert.deepEqual(w.getBaseProp("size"), [100, 100]);
  assert.equal(w.getBaseProp("opacity"), 1, "a key no layer names reads straight from props");
});

test("a saved scene loads into the same effective values on the same platform", () => {
  const engine = makeEngine();
  engine.setPlatform({ platform: "mobile", orientation: "landscape" });
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget", { variants: VARIANTS });
  const saved = JSON.parse(JSON.stringify(w.toJSON()));

  const engine2 = makeEngine();
  engine2.setPlatform({ platform: "mobile", orientation: "landscape" });
  const w2 = engine2.createEntity({ name: "Hud" }).addComponent(saved.type, saved.props);
  assert.deepEqual(w2.props, w.props);
  assert.deepEqual(w2.toJSON(), saved);
});

/* -------------------------------------------------------------------------- */
/* the three write paths                                                       */

test("setProp (a script) moves the effective value only; the desktop value is kept for saving", () => {
  const engine = makeEngine();
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget", { variants: VARIANTS });
  take();
  w.setProp("size", [1, 1]);
  assert.deepEqual(take(), ["changed:size"]);
  assert.deepEqual(w.props.size, [1, 1]);
  assert.deepEqual(w.toJSON().props.size, [100, 100]);
  assert.deepEqual(w.variants.portrait.size, [40, 80], "the authored set is not rewritten by a runtime write");
  // The next context change re-resolves from the authored sets.
  engine.setPlatform({ platform: "mobile", orientation: "landscape" });
  assert.deepEqual(w.props.size, [60, 60]);
});

test("setBaseProp changes what is saved; the scene keeps showing the applied layer", () => {
  const engine = makeEngine();
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget", { variants: VARIANTS });
  take();
  engine.events.length = 0;
  w.setBaseProp("size", [300, 300]);
  assert.deepEqual(take(), [], "no rebuild: the effective value did not move");
  assert.deepEqual(w.props.size, [40, 80]);
  assert.deepEqual(w.toJSON().props.size, [300, 300]);
  assert.ok(engine.events.some(([name, key]) => name === "component-changed" && key === "size"), "the inspector is told");
  // On a key no layer overrides it IS setProp.
  w.setBaseProp("opacity", 0.5);
  assert.deepEqual(take(), ["changed:opacity"]);
  assert.equal(w.props.opacity, 0.5);
  // Back on desktop the new base shows.
  engine.setPlatform({ platform: "desktop", orientation: "landscape" });
  assert.deepEqual(w.props.size, [300, 300]);
});

test("setVariantProp on the ACTIVE layer moves the scene; on an inactive one only the set", () => {
  const engine = makeEngine();
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget", { variants: VARIANTS });
  take();
  w.setVariantProp("portrait", "size", [50, 90]);
  assert.deepEqual(take(), ["changed:size"]);
  assert.deepEqual(w.props.size, [50, 90]);
  assert.deepEqual(w.variants.portrait.size, [50, 90]);

  w.setVariantProp("landscape", "opacity", 0.2);
  assert.deepEqual(take(), [], "landscape is not applied in portrait");
  assert.equal(w.props.opacity, 1);
  assert.equal(w.variants.landscape.opacity, 0.2, "a new set is created on first write");

  // A mobile write shadowed by portrait's own value changes nothing visible…
  w.setVariantProp("mobile", "size", [70, 70]);
  assert.deepEqual(take(), []);
  assert.deepEqual(w.props.size, [50, 90]);
  // …until the portrait override is cleared and the key falls through to mobile.
  w.clearVariantProp("portrait", "size");
  assert.deepEqual(take(), ["changed:size"]);
  assert.deepEqual(w.props.size, [70, 70]);
  assert.ok(w.hasVariant("portrait"), "an emptied set stays until removed explicitly");
  assert.deepEqual(w.variants.portrait, {});

  engine.setPlatform({ platform: "mobile", orientation: "landscape" });
  assert.equal(w.props.opacity, 0.2, "the landscape set applies once landscape is active");
  assert.deepEqual(w.props.size, [70, 70]);
});

test("removeVariant restores the base and drops the key when the last set goes", () => {
  const engine = makeEngine();
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget", { variants: { portrait: { size: [40, 80] } } });
  take();
  w.removeVariant("portrait");
  assert.deepEqual(take(), ["changed:size"]);
  assert.deepEqual(w.props.size, [100, 100]);
  assert.equal(w.variants, null);
  assert.ok(!("variants" in w.props));
  assert.ok(!engine.variantComponents.has(w), "unregistered");
  assert.deepEqual(w.toJSON().props, { enabled: true, size: [100, 100], opacity: 1, label: "hud" });
});

test("setVariant creates an empty set (the inspector's toggle) and undo removes it again", () => {
  const engine = makeEngine();
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget");
  w.setVariant("mobile", {});
  assert.deepEqual(w.variants, { mobile: {} });
  assert.ok(engine.variantComponents.has(w));
  w.setVariant("mobile", null);
  assert.equal(w.variants, null);
  assert.ok(!engine.variantComponents.has(w));
});

test("the whole-variants write (undo/redo, prefab apply) re-resolves the applied context", () => {
  const engine = makeEngine();
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget");
  take();
  w.setProp("variants", VARIANTS);
  assert.deepEqual(take().sort(), ["changed:label", "changed:size"]);
  assert.deepEqual(w.props.size, [40, 80]);
  w.setProp("variants", {});
  assert.deepEqual(take().sort(), ["changed:label", "changed:size"]);
  assert.deepEqual(w.props.size, [100, 100]);
  assert.equal(w.variants, null);
});

test("keys that describe how the author works cannot vary per platform", () => {
  const engine = makeEngine();
  const w = engine.createEntity({ name: "Hud" }).addComponent("test-variants-widget");
  assert.throws(() => w.setVariantProp("mobile", "viewOnly", true), /cannot vary/);
  assert.throws(() => w.setVariantProp("tablet", "size", [1, 1]), /Unknown platform variant/);
  assert.ok(!("variants" in w.props));
});

/* -------------------------------------------------------------------------- */
/* enabled                                                                     */

test("`enabled` per platform: a phone-only component is never built on desktop, and vice versa", () => {
  const engine = makeEngine();
  take();
  const e = engine.createEntity({ name: "Sticks" });
  // Desktop: the mobile set says enabled, the base says disabled.
  const p = e.addComponent("test-variants-plain", { enabled: false, variants: { mobile: { enabled: true } } });
  assert.deepEqual(take(), [], "disabled on desktop: not built");
  assert.equal(p.enabled, false);

  engine.setPlatform({ platform: "mobile", orientation: "landscape" });
  assert.deepEqual(take(), ["plain:attach"], "enabled by the mobile set: built through the enable hook");
  assert.equal(p.props.enabled, true);
  assert.equal(p.toJSON().props.enabled, false, "saved as the desktop value");

  engine.setPlatform({ platform: "desktop", orientation: "landscape" });
  assert.deepEqual(take(), ["plain:detach"]);
  assert.equal(p.enabled, false);
});

test("a component disabled by its phone set is not built on the phone (silent pre-attach path)", () => {
  const engine = makeEngine();
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  const e = engine.createEntity({ name: "Cursor" });
  const p = e.addComponent("test-variants-plain", { variants: { mobile: { enabled: false } } });
  assert.deepEqual(take(), [], "no attach, and no stray detach on a never-built component");
  assert.equal(p._attached, true, "attached to the entity, just disabled");
  assert.equal(p.enabled, false);
  engine.setPlatform({ platform: "desktop", orientation: "landscape" });
  assert.deepEqual(take(), ["plain:attach"]);
});

/* -------------------------------------------------------------------------- */
/* detached entities                                                           */

test("a disabled entity's components take the platform change without reacting, then build right on enable", () => {
  const engine = makeEngine();
  const e = engine.createEntity({ name: "Hud" });
  const w = e.addComponent("test-variants-widget", { variants: VARIANTS });
  take();
  e.setEnabled(false);
  assert.deepEqual(take(), ["detach"]);
  engine.setPlatform({ platform: "mobile", orientation: "portrait" });
  assert.deepEqual(take(), [], "detached: stored, not reacted to");
  assert.deepEqual(w.props.size, [40, 80]);
  e.setEnabled(true);
  assert.deepEqual(take(), ["attach size=40x80 opacity=1"]);
});
