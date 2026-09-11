import * as THREE from "three/webgpu";
import { getEntityBoundingSphere } from "../viewFrustum.js";
import { EventEmitter } from "../EventEmitter.js";

const _scratchSphere = new THREE.Sphere();

/**
 * Keys that are part of the Component API itself — never mirrored as prop
 * accessors, even when a subclass also stores a prop of the same name
 * (e.g. SplineComponent's curve `type` stays on `props.type` so it cannot
 * shadow `component.type`, the registered id).
 */
const RESERVED_PROP_KEYS = new Set([
  "entity",
  "type",
  "props",
  "enabled",
  "editorEnabled",
  "viewOnly",
  "constructor",
]);

/**
 * ── WHICH PROPERTIES ARE "STRUCTURE" (2026-09-07, ZERO_FREEZE_PLAN §1.1) ────
 *
 * THE FAILURE: `setProp` emitted "hierarchy-changed" for EVERY property of
 * EVERY component, and that event reaches ~20 listeners that each WALK THE
 * SCENE — the React mirror, `merging.invalidate`, `shadowMerge`,
 * `batching.invalidate`, `OcclusionSystem`, GI's rebake fingerprint,
 * `PhysicsSystem.prewarmAutoColliders`, the selection outline, the
 * selection-mask prewarm, the live-preview `exportGame()`. A boolean on a
 * light and a re-parent of 5 000 entities therefore delivered the IDENTICAL
 * signal; that is the user's "changing a parameter freezes the editor", and,
 * once per `pointermove`, why a slider drag stalls the editor.
 *
 * THE RULE NOW: a property emits "hierarchy-changed" only when it is
 * STRUCTURAL — when the change adds or removes something from the scene
 * graph, or moves a mesh in or out of a set some system BAKES (shadowMerge's
 * caster set, merging's groups, a decal's projection targets). Everything
 * else emits only "component-changed", which carries entityId/componentType/
 * key and which every system with a precise interest already subscribes to
 * (merging and batching filter it by componentType, physics by key, GI
 * re-queues its rebake check from it, the mirror re-reads one entity).
 *
 * Four ways to be structural, checked in this order:
 *   1. the schema descriptor says so — `{ key: "path", …, structural: true }`;
 *   2. the class lists it — `static structuralProps = ["path"]`;
 *   3. the table below, for keys that predate the marker;
 *   4. the component has NOT overridden `onPropChanged`, so the base
 *      implementation rebuilds it by `onDetach(); onAttach()` on EVERY prop —
 *      it literally replaces its objects in the scene graph, which is
 *      structural by definition (Cloth, Pool, PlanarReflection, Joint, Bone,
 *      ImpulseSource, LevelFloor today).
 *
 * ⚠ The table lives here rather than in each component's own schema because
 * these keys' structural meaning is owned by the LISTENERS, not the component:
 * `shadowMerge` subscribes to "hierarchy-changed" ALONE (no component-changed
 * hook at all), so a `castShadow` or geometry swap that stopped emitting it
 * would leave the shadow merge baking a caster set that no longer exists —
 * a stale silhouette standing where the object used to be. A NEW property
 * should declare `structural: true` in its own schema instead of growing this.
 *
 * `globalThis.__engineStructuralProps = false` restores the old behaviour
 * (every prop structural) for a one-boot A/B.
 */
const STRUCTURAL_PROPS = new Map([
  // Geometry/material swaps change what merging groups, what shadowMerge bakes
  // into its proxies, what batching can instance and what a decal projects
  // onto. `collision` is NOT here: PhysicsSystem has a component-changed hook
  // keyed on exactly ["geometry","geometryAsset","collision"]. The gi* trio is
  // not here either: GISystem re-queues its rebake check from
  // "component-changed" with no key filter.
  ["mesh", ["geometry", "geometryAsset", "material", "material2", "material3", "material4", "material5", "material6", "material7", "material8", "castShadow", "receiveShadow"]],
  ["skinnedmesh", ["geometry", "material", "castShadow", "receiveShadow"]],
  ["model", ["path", "castShadow", "receiveShadow"]],
  ["objModel", ["path", "castShadow", "receiveShadow"]],
  // Every one of these regenerates the swept tube — a different geometry in
  // the graph, not a different value on the same one.
  ["splineMesh", ["path", "profile", "width", "height", "radius", "sides", "density", "capEnds", "material", "castShadow", "receiveShadow"]],
  // LightComponent.onPropChanged replaces the THREE.Light instance for these
  // (see its own comment: three must not retain an AnalyticLightNode compiled
  // against the old shadow node), so the object in the scene is a new one.
  // `intensity`, `color`, the csm tuning and every shadow-camera number write
  // in place and are NOT structural — the light-intensity edit this whole unit
  // exists for. `castShadow` left this list on 2026-09-10: it is applied IN
  // PLACE now (LightComponent.#castShadowInPlace — same THREE.Light, same
  // shadow camera), so nothing leaves or enters the graph; the material
  // re-mint it costs is three's own and rides `component-changed`. The rare
  // fallback that still swaps the light emits `hierarchy-changed` itself.
  ["light", ["kind", "shadowMode", "shadowMapType", "csm", "csmCascades", "csmFade"]],
  // Instancing count/mode/source add and remove InstancedMesh objects.
  ["instancer", ["mode", "count", "pathEntity"]],
  // The impostor bakes a billboard from another entity and swaps it in.
  ["impostor", ["source", "castShadow", "receiveShadow"]],
]);

/**
 * The structural key set for a component class, computed once per class.
 *
 * Memoised because `setProp` runs on the pointermove path: a linear scan of
 * LightComponent's 28-entry schema per scrub frame is the kind of cost this
 * unit exists to delete. `hasOwnProperty` so a subclass never inherits its
 * parent's set.
 */
function structuralKeysFor(cls) {
  if (Object.prototype.hasOwnProperty.call(cls, "__structuralKeys")) return cls.__structuralKeys;
  const set = new Set(STRUCTURAL_PROPS.get(cls.type) ?? []);
  for (const key of cls.structuralProps ?? []) set.add(key);
  for (const entry of cls.schema ?? []) if (entry?.structural === true && entry.key) set.add(entry.key);
  Object.defineProperty(cls, "__structuralKeys", { value: set, configurable: true });
  return set;
}

/**
 * Install get/set mirrors for every authored prop so scripts can write
 * `light.intensity = 2` instead of `light.setProp("intensity", 2)`. Sets
 * go through `setProp` so `onPropChanged` still runs.
 *
 * Important: do not also store runtime objects under the same name as a prop
 * (e.g. LightComponent keeps the CSM node in `#csm`, while `props.csm` is the
 * authored boolean). An accessor on that name would intercept `this.csm = …`
 * and shove the object into props.
 */
function installPropAccessors(component) {
  const keys = new Set([
    ...Object.keys(component.props ?? {}),
    ...Object.keys(component.constructor.defaults ?? {}),
    ...(component.constructor.schema ?? []).map((entry) => entry?.key).filter(Boolean),
  ]);
  for (const key of keys) {
    if (RESERVED_PROP_KEYS.has(key)) continue;
    // Don't shadow methods / accessors already defined on the prototype chain
    // (e.g. AnimationComponent.play, CharacterControllerComponent.move).
    let proto = Object.getPrototypeOf(component);
    let shadowed = false;
    while (proto && proto !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(proto, key)) {
        shadowed = true;
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
    if (shadowed) continue;
    if (Object.prototype.hasOwnProperty.call(component, key)) continue;
    Object.defineProperty(component, key, {
      get() {
        return this.props[key];
      },
      set(value) {
        this.setProp(key, value);
      },
      enumerable: true,
      configurable: true,
    });
  }
}

/**
 * Base class for all components. Subclasses must define:
 *   static type       — unique string id ("mesh", "light", ...)
 *   static label      — display name for the editor
 *   static defaults   — default props object
 *   static schema     — property descriptors used by the inspector:
 *                       [{ key, label, type: "number"|"color"|"select"|"text"|"boolean",
 *                          min?, max?, step?, options? }]
 *
 *                       A descriptor may also declare `module: "<moduleId>"`
 *                       when the property only does something while an
 *                       OPTIONAL module is enabled (MeshComponent's
 *                       `collision` belongs to physics-rapier, its `gi*`
 *                       selects to gi). The inspector hides such a row until
 *                       that module is installed and groups the installed
 *                       ones under the module's name. For a select whose
 *                       OPTION list is what depends on a module (the light's
 *                       "gi" shadow source), `optionModules` maps option
 *                       value → module id and the module's absence removes
 *                       just that choice.
 *
 *                       A descriptor may declare `structural: true` when
 *                       changing that property adds or removes something from
 *                       the scene graph (see STRUCTURAL_PROPS above). Default
 *                       false: an ordinary value edit notifies only
 *                       "component-changed", not the ~20 scene-walking
 *                       listeners of "hierarchy-changed".
 * and may override onAttach/onDetach/onPropChanged.
 *
 * Constructed with just `props` — `new MeshComponent({ geometry: "sphere" })`
 * — and has no entity until `Entity.addComponent` attaches it (`onAttach()`
 * runs at that point, not in the constructor).
 *
 * Subclasses may also set:
 *   static tags       — short string array of free-form editor tags, used by
 *                       the Modules panel to filter / group components
 *                       (e.g. ["physics", "play-mode", "3d"]). Pure metadata;
 *                       never read by the runtime.
 *
 * Every component has two built-in meta-toggles (default true). They are
 * not part of `schema` — the inspector renders them in the section header
 * alongside the existing eye (enabled) and remove buttons.
 *
 *   - `enabled` — when false, the component stops contributing to the
 *     runtime (no rendering, no ticking) without being detached. Data and
 *     three.js objects are preserved so toggling back on restores state.
 *
 *   - `viewOnly` — when true, the component's runtime work pauses while
 *     its entity is outside the camera frustum. Re-enabled the moment
 *     the entity re-enters. Designed to win more performance than it
 *     spends: see `viewFrustum.js` for the per-frame cost analysis.
 *
 * To opt into enabled, subclasses override `onDisable()` / `onEnable()`.
 * To opt into viewOnly, subclasses gate their `#tick` / per-frame work
 * behind `this.isInView()` (or `if (!this.viewOnly || this.isInView())`).
 *
 * Extends `EventEmitter` for local, per-instance pub-sub — every component
 * gets `changed`/`destroyed` for free (see `ComponentEventMap` in
 * engine.d.ts), fired from `setProp` and `Entity.removeComponent` below. A
 * subclass with its own events (e.g. `TimelineComponent`'s `finished`)
 * just calls `this.emit(...)`; its own `.d.ts` interface types the payload
 * via `ComponentBase<Props, OwnEventMap>`.
 */
/**
 * Whether a component takes part in per-frame frustum gating.
 *
 * Two ways in: the AUTHORED `viewOnly` flag (the component's own or its
 * entity's), and `static viewGated = true` on the class — for a component
 * whose off-screen work is pure waste by construction rather than by an
 * author's choice.
 *
 * ⛔⛔ THE SECOND EXISTS BECAUSE A GATE WITHOUT IT IS DEAD CODE. `_inView` is
 * resolved only for components in `engine.viewOnlyComponents`, and nothing
 * else ever writes it — so `isInView()` on a component that never opted in
 * reads `null !== false`, which is TRUE, forever. The cloth solver has gated
 * its tick on `isInView()` since it was written and it had never once fired:
 * ten Sponza curtains all ticked every frame at ~0.65 ms of CPU each, on a
 * frame where cloth was 76 % of the whole CPU budget.
 */
function viewGatedBy(component) {
  return !!component.props.viewOnly || !!component.entity?.viewOnly
    || /** @type {any} */ (component.constructor).viewGated === true;
}

export class Component extends EventEmitter {
  // Default: no tags. Subclasses override with a string array (e.g.
  // `static tags = ["physics", "play-mode"]`). Pure editor metadata; the
  // runtime never reads this. Defined on the base class so reading
  // `MyComponent.tags` is always safe even for subclasses that don't set it.
  static tags = [];

  // Leaving Play mode restores the scene by diffing the snapshot against the
  // live tree (see serialize.js `reconcileScene`), so components normally
  // survive it untouched — that's what keeps loaded models and the GI bake
  // alive across a stop. Components whose runtime state is NOT in `props` (a
  // playing sound, an animation state machine's position, a script instance's
  // fields) set this to true and get detached + re-attached instead, so the
  // next Play starts from a clean slate.
  static resetOnStop = false;

  constructor(props = {}) {
    super();
    // Set by `Entity.addComponent` when this instance is attached — a
    // component can now be constructed standalone (`new MeshComponent(props)`)
    // before it has anywhere to live.
    this.entity = null;
    // `enabled` lives outside the subclass `defaults` spread so it's always
    // present even if a subclass forgets to declare it. Subclasses that want
    // to hide it from the inspector schema simply don't add it to `schema`.
    this.props = { enabled: true, ...this.constructor.defaults, ...props };
    // Tracks the current effective state. We compare against `props.enabled`
    // in `setEnabled` so external mutation (loading a saved scene, undo/redo)
    // is reconciled on the next enable/disable call.
    this._enabled = this.props.enabled !== false;
    // Whether an Entity has this component attached right now: `true` after
    // `onAttach`, `false` after `onDetach` (or never attached because the
    // entity is disabled — see Entity.reconcileActivity). Left `undefined` for
    // a component something other than an Entity attaches by hand (a
    // VfxComponent's element particles), which the guards below leave alone.
    this._attached = undefined;
    // Cached "currently visible per frustum" decision. Updated once per
    // frame by `updateViewVisibility` (called from the engine's main loop
    // when this component is `viewOnly`). `null` = not yet decided.
    this._inView = null;
    // Cached viewOnly boolean (resolved against the entity's own flag once
    // per `setProp` cycle). Avoids re-reading the entity every frame.
    this._viewOnlyActive = viewGatedBy(this);
    // Mirror every authored prop as `comp.intensity` / `comp.intensity = 2`
    // (routed through setProp). Scripts shouldn't have to dig into `.props`.
    installPropAccessors(this);
  }

  /**
   * Whether this component participates in per-frame frustum gating.
   *
   * Backed by an accessor rather than a plain field so that flipping it keeps
   * `engine.viewOnlyComponents` in sync. The engine's main loop iterates that
   * registry instead of walking every entity's component map each frame —
   * view-only components are a small minority, but the walk to find them cost
   * a nested Map iteration over the WHOLE scene every frame, which is exactly
   * the kind of per-frame O(scene) work that makes a 10k-entity scene stutter.
   */
  /**
   * Re-resolve frustum gating now that this component has an entity.
   *
   * ⛔ THE CONSTRUCTOR CANNOT REGISTER. `_viewOnlyActive`'s setter adds to
   * `engine.viewOnlyComponents`, and at construction `this.entity` is still
   * undefined — so the registry lookup misses and the write is silently
   * dropped. Until this ran at attach, a component was gated only if something
   * later wrote `viewOnly` through `setProp`, which meant an authored
   * `viewOnly: true` in a scene file never took effect either.
   */
  refreshViewGate() {
    const wanted = viewGatedBy(this);
    // The setter early-outs when the value is unchanged, and it is already
    // `true` from the constructor — so clear it first to force the registry
    // write that had nowhere to go back then.
    if (wanted && this.__viewOnlyActive === true) this.__viewOnlyActive = false;
    this._viewOnlyActive = wanted;
    this._inView = null;
  }

  get _viewOnlyActive() {
    return this.__viewOnlyActive === true;
  }

  set _viewOnlyActive(value) {
    const next = !!value;
    if (next === this.__viewOnlyActive) return;
    this.__viewOnlyActive = next;
    const registry = this.entity?.engine?.viewOnlyComponents;
    if (!registry) return;
    if (next) registry.add(this);
    else registry.delete(this);
  }

  get type() {
    return this.constructor.type;
  }

  /**
   * Effective enabled state: composes the user-facing `props.enabled` with
   * any external override. Override wins when set; null = "no override".
   * Reserved for future transient-control hooks — currently the only
   * path that mutates this externally is `setEnabledOverride`, used in
   * tests and any future system that needs to gate a component without
   * touching its saved props.
   */
  get enabled() {
    if (this._enabledOverride === false) return false;
    if (this._enabledOverride === true) return true;
    // Paused for editing: off while the editor is stopped, on in play mode.
    if (this.props.editorEnabled === false && !this.entity?.engine?.playing) return false;
    return this.props.enabled !== false;
  }

  /**
   * ── "RUN IN EDITOR" (2026-09-10) ────────────────────────────────────────
   * Whether this component's ANIMATION / SIMULATION should advance THIS frame.
   * The editor contract: a sim advances in PLAY mode, and while EDITING only
   * when the component opts in with its `runInEditor` toggle (DEFAULT OFF — an
   * undefined prop reads as false via the `=== true` test). This is what keeps
   * a static editor cheap: a day/night clock, wave sim, cloth solve, particle
   * emit or wind sway advancing every editor frame forced GI to re-transport
   * and re-mint the scene and dropped the editor to 30 fps. RENDERING IS NOT
   * gated by this — a frozen component still draws its current (static)
   * snapshot; only its clock stops. A `simulationSuspended` hold (a
   * geometry-edit overlay, say) still overrides both.
   */
  get shouldAnimate() {
    const engine = this.entity?.engine;
    if (!engine || engine.simulationSuspended === true) return false;
    return engine.playing === true || this.props?.runInEditor === true;
  }

  /**
   * True for a component with no onDisable/onEnable of its own. Disabling
   * such a component DETACHES it (onDetach; onAttach again when enabled), so
   * "disabled" always means "does nothing" — a component that never opted in
   * used to keep rendering and ticking with its eye switched off.
   */
  get stopsByDetaching() {
    return this.onDisable === Component.prototype.onDisable && this.onEnable === Component.prototype.onEnable;
  }

  /**
   * True if this component should pause its runtime work while its entity
   * is outside the camera frustum. Resolves once per `setProp` cycle —
   * the entity-level flag is read here, not per frame, so this stays a
   * cheap boolean check.
   */
  get viewOnly() {
    return this._viewOnlyActive;
  }

  /** Called after the component is added to its entity. Build three.js objects here. */
  onAttach() {}

  /** Called before removal. Tear down three.js objects here. */
  onDetach() {}

  /**
   * Called when `enabled` flips false. Override to hide or pause the
   * component's runtime side-effects. The default is a no-op — components
   * with no side-effects (data-only) don't need to override this.
   */
  onDisable() {}

  /** Called when `enabled` flips true. The mirror of `onDisable`. */
  onEnable() {}

  /** Called after a prop changes. Default: rebuild by detach/attach. */
  onPropChanged() {
    // A prop change on a component its entity has detached (the entity is
    // disabled) must not attach it: the props are stored, and the entity's
    // reconcile attaches from them when it becomes active. Likewise one that
    // is disabled and stops by detaching: it is built from its props on enable.
    if (this._attached === false) return;
    if (!this._enabled && this.stopsByDetaching) return;
    this.onDetach();
    this.onAttach();
  }

  /**
   * Reconciles the effective enabled state (composed from `props.enabled`
   * and any external override) with the cached `_enabled` and dispatches
   * onEnable/onDisable when it actually changes. Cheap; called every
   * frame from gated components to pick up override changes without
   * bookkeeping from the caller.
   */
  reconcileEnabled() {
    const effective = this.enabled;
    if (effective === this._enabled) return false;
    this._enabled = effective;
    // No hooks on a detached component: there is no state to enable or
    // disable, and `onAttach` reads `this.enabled` when the entity comes back.
    if (this._attached === false) return true;
    if (this.stopsByDetaching) {
      if (effective) this.onAttach();
      else this.onDetach();
    } else if (effective) this.onEnable();
    else this.onDisable();
    return true;
  }

  /**
   * Persisted setter for "works while editing". Off, the component does
   * nothing while the editor is stopped (the same stop as `enabled` false)
   * and resumes the moment play starts. Writes `props.editorEnabled`.
   */
  setEditorEnabled(value) {
    const next = value !== false;
    if (next === (this.props.editorEnabled !== false)) return false;
    this.props.editorEnabled = next;
    return this.reconcileEnabled();
  }

  /**
   * Persisted setter for the runtime state. Writes to `props.enabled`
   * so the decision survives save/load and the inspector reflects it.
   * Most callers (the eye toggle, undo/redo) should use this. External
   * consumers that want a transient override should use
   * `setEnabledOverride` instead.
   */
  setEnabled(value) {
    const next = value !== false;
    if (next === (this.props.enabled !== false)) return false;
    this.props.enabled = next;
    return this.reconcileEnabled();
  }

  /**
   * Sets a transient override on the effective enabled state. Unlike
   * `setEnabled` this does NOT touch `props.enabled` — the user's stored
   * preference is preserved. Pass `null` to clear the override.
   *
   * Effective state = props.enabled && (override ?? true).
   */
  setEnabledOverride(value) {
    const next = value === null ? null : value !== false;
    if (next === this._enabledOverride) return false;
    this._enabledOverride = next;
    return this.reconcileEnabled();
  }

  /**
   * Whether changing `key` is a change to the SCENE'S STRUCTURE — see
   * STRUCTURAL_PROPS at the top of this file for what that buys and what it
   * costs to get it wrong. Public so the editor (and the tests) can ask the
   * same question the emit path asks.
   */
  isStructuralProp(key) {
    // THE HATCH: `globalThis.__engineStructuralProps = false` makes every prop
    // structural again, i.e. restores the pre-2026-09-07 fan-out, so a
    // regression can be A/B'd in one boot without a rebuild.
    if (globalThis.__engineStructuralProps === false) return true;
    if (structuralKeysFor(this.constructor).has(key)) return true;
    // A component that has not overridden onPropChanged is rebuilt by
    // `onDetach(); onAttach()` on every prop change — its objects leave and
    // re-enter the scene graph, which no listener can hear any other way.
    return this.onPropChanged === Component.prototype.onPropChanged;
  }

  setProp(key, value) {
    if (key === "enabled" || key === "editorEnabled") {
      // Routing through the setters so the onEnable/onDisable hooks fire
      // and `_enabled` stays in sync. Skip the generic onPropChanged
      // (which would detach/reattach and tear down three.js state).
      const changed = key === "enabled" ? this.setEnabled(value) : this.setEditorEnabled(value);
      if (changed) {
        const engine = this.entity?.engine;
        engine?.emit?.("component-changed", {
          entityId: this.entity?.id,
          componentType: this.type,
          key,
        });
        // ALWAYS STRUCTURAL: a disabled component detaches (Entity.
        // reconcileActivity) — its mesh leaves the scene graph, its collider
        // stops existing, its light is removed from the lighting graph. Every
        // scene-walking listener has to re-read.
        engine?.emit?.("hierarchy-changed");
        this.emit("changed", key);
      }
      return;
    }
    if (key === "viewOnly") {
      // Meta-toggle: never triggers detach/attach. Refresh the resolved
      // boolean (component flag OR entity flag) so `this.viewOnly` reads
      // stay O(1) per frame, and reset the cached view-decision so the
      // first per-frame test after a change picks up the new state.
      this.props.viewOnly = !!value;
      this._viewOnlyActive = viewGatedBy(this);
      this._inView = null;
      const engine = this.entity?.engine;
      engine?.emit?.("component-changed", {
        entityId: this.entity?.id,
        componentType: this.type,
        key,
      });
      this.emit("changed", key);
      return;
    }
    this.props[key] = value;
    // Detached (the entity is disabled): store the prop, react on re-attach.
    // Gated here rather than in each subclass's onPropChanged, several of
    // which re-run `this.onAttach()` themselves.
    // Nor on one disabled and stopped by detaching: nothing is built to react,
    // and a subclass that rebuilds itself on a prop change must not wake it.
    if (this._attached !== false && (this._enabled || !this.stopsByDetaching)) this.onPropChanged(key, value);
    // Two events, both for editor consumers:
    //   - "component-changed" is the PRECISE signal and it fires for every
    //     property: it carries entityId/componentType/key, the React mirror
    //     re-reads exactly that one entity from it (sceneStore.refreshEntity),
    //     and the camera-follow section, merging, batching, physics and GI all
    //     filter it down to what they actually care about.
    //   - "hierarchy-changed" is the SCENE-WIDE signal — ~20 listeners that
    //     each walk the scene — and now fires only for a STRUCTURAL property
    //     (see STRUCTURAL_PROPS at the top of this file). It used to fire for
    //     every property of every component, which is the fan-out behind
    //     "changing a parameter freezes the editor".
    // "changed" is the local, per-instance equivalent for scripts/other
    // components listening on THIS component specifically.
    const engine = this.entity?.engine;
    engine?.emit?.("component-changed", {
      entityId: this.entity?.id,
      componentType: this.type,
      key,
    });
    if (this.isStructuralProp(key)) engine?.emit?.("hierarchy-changed");
    this.emit("changed", key);
  }

  toJSON() {
    return { type: this.type, props: { ...this.props } };
  }

  /**
   * True when this component's entity is currently inside the active
   * camera's frustum. Components that opt into `viewOnly` should consult
   * this once per frame and skip per-frame work when it returns false.
   *
   * Components that aren't viewOnly never get their visibility tested;
   * the getter returns true by default so existing code that doesn't
   * know about viewOnly keeps behaving correctly.
   */
  isInView() {
    return this._inView !== false;
  }

  /**
   * Per-frame decision point. Called by the engine once per frame for
   * every component whose `viewOnly` flag (component or entity) is true.
   * Tests the entity's world bounding sphere against the shared frustum
   * and caches the result on `_inView` for the rest of the frame.
   *
   * The sphere is recomputed only when the entity (or an ancestor) moves,
   * so this is one frustum-sphere test in the steady state.
   */
  updateViewVisibility(viewFrustum) {
    if (!viewFrustum?.isReady()) {
      this._inView = true;
      return;
    }
    const sphere = _scratchSphere;
    const ok = getEntityBoundingSphere(this.entity, sphere);
    if (!ok) {
      this._inView = true;
      return;
    }
    this._inView = viewFrustum.frustum.intersectsSphere(sphere);
  }
}
