// @ts-check
import * as THREE from "three/webgpu";
import { PhysicsLayers } from "./layers.js";
import {
  collectCollisionMesh,
  collectCollisionMeshParts,
  collisionGeometryBounds,
  collisionMeshPartsFromGeometry,
  hasOwnedDeformingCollisionGeometry,
  hasOwnedStaticCollisionGeometry,
  mergeCollisionMeshes,
  scaleCollisionMesh,
  simplifyCollisionMesh,
} from "./collisionGeometry.js";

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;
const DEG2RAD = Math.PI / 180;

/**
 * Query origins/directions are typed `[x, y, z] | Vector3` (engine.d.ts), but
 * Rapier wants raw `{x, y, z}`. Indexing a THREE.Vector3 with `[0]` reads
 * `undefined` — no error, just a query fed NaN that silently never hits —
 * which is how the third-person camera's Avoid Walls cast and the crouch
 * ceiling check (both handed a Vector3) passed through everything. Coerce
 * both shapes here rather than making callers remember which is which.
 */
function xyz(v) {
  if (v && typeof v.x === "number") return { x: v.x, y: v.y, z: v.z };
  return { x: v?.[0] ?? 0, y: v?.[1] ?? 0, z: v?.[2] ?? 0 };
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _parentQuat = new THREE.Quaternion();
const _mat = new THREE.Matrix4();
const _colliderRotation = new THREE.Quaternion();
const _colliderEuler = new THREE.Euler();

const AUTO_COLLIDER_SOURCE_TYPES = ["mesh", "model", "objModel", "splineMesh"];
const AUTO_COLLIDER_DEFAULTS = {
  friction: 0.5,
  restitution: 0,
  isSensor: false,
  layer: "Default",
};

/**
 * Owns the Rapier world. Lifecycle mirrors play mode: the world is built
 * from the entity tree when playing starts and freed when it stops (the
 * editor restores its scene snapshot anyway). While playing it steps on a
 * fixed timestep, drives kinematic bodies from entity transforms, writes
 * dynamic body transforms back to entities, and dispatches collision events
 * to script hooks (onCollisionEnter/Exit, onTriggerEnter/Exit).
 *
 * Exposed as `engine.physics` for scripts:
 *   this.engine.physics.raycast(origin, direction, maxDistance) →
 *     { entity, point, normal, distance } | null
 *   this.engine.physics.setGravity([x, y, z])
 */
/**
 * How a dynamic body's colliders get their mass. `mass` splits an absolute
 * figure across them by volume; `density` hands Rapier the figure and lets it
 * derive the mass from each shape's OWN volume — which is the only one of the
 * two that survives the object being scaled. See RigidbodyComponent's schema.
 *
 * ── DENSITY IS AUTHORED IN g/cm³, RAPIER WANTS kg/m³ ──────────────────────
 *
 * Water is 1, oak 0.7, aluminium 2.7, steel 7.8 — the scale everyone already
 * carries in their head, and the one that makes "will this float?" readable at
 * a glance against water's 1. In SI those are 1000 / 700 / 2700 / 7800 and the
 * interesting digits are buried behind three zeros. One multiply here is the
 * whole cost of the better unit.
 */
const DENSITY_TO_SI = 1000;
/**
 * ⚠ SCENES AUTHORED BEFORE THE UNIT CHANGE carry kg/m³ (the old default was
 * 500). Nothing real is 30 g/cm³ — osmium, the densest element there is, is
 * 22.6 — so a figure above that can only be the old unit, and is converted
 * rather than silently making the object a million times heavier.
 */
export function bodyDensitySI(value) {
  const density = Number(value);
  if (!(density > 0)) return 0;
  return density > 30 ? density : density * DENSITY_TO_SI;
}
/**
 * Give a dynamic body its mass, either from a density or from an authored
 * figure split across its colliders by `weights` (their volumes).
 *
 * ⚠ TRIANGLE MESHES ARE FINE HERE, and it is worth writing down why, because
 * the opposite is widely repeated: Rapier DOES derive a trimesh's mass
 * properties from the volume its triangles enclose. Measured 2026-09-07
 * against the shipped `@dimforge/rapier3d-compat`: a closed unit-cube trimesh
 * at density 500 weighs 500.0 with the same inertia tensor as the equivalent
 * cuboid, inconsistent winding resolves to the same figure, and an open mesh
 * (the cube minus its lid) integrates to a sensible 0.83 of it. So density
 * mode needs no special case.
 *
 * The one shape that does break is a mesh enclosing NO volume — a single flat
 * sheet, a cut plane. Rapier resolves that to mass 0, and a dynamic body with
 * mass 0 has an inverse mass of 0, which means it never moves again: it looks
 * like the body silently stopped being dynamic. `degenerateLabel` turns that
 * into a nominal mass and one warning naming the entity.
 *
 * @param {string} [degenerateLabel] Entity name; pass it only for colliders
 *   whose `weights` are real volumes, which is every shape built here.
 */
function applyColliderMass(rb, colliders, weights, degenerateLabel = null) {
  if (rb?.props.bodyType !== "dynamic") return;
  if (rb.props.massMode === "density") {
    const density = bodyDensitySI(rb.props.density);
    if (!(density > 0)) return;
    for (const collider of colliders) collider.setDensity(density);
    if (degenerateLabel && weights?.length && !weights.some((weight) => weight > 1e-9)) {
      console.warn(
        `Collider on "${degenerateLabel}": the collision mesh encloses no volume, so its density resolves to ` +
          `zero mass and the body would never move. Using ${DEGENERATE_MASS} kg — give the shape thickness, ` +
          `or set the Rigidbody's mass mode to Mass.`,
      );
      for (const collider of colliders) collider.setMass(DEGENERATE_MASS / colliders.length);
    }
    return;
  }
  if (!(rb.props.mass > 0)) return;
  const total = weights?.reduce((sum, weight) => sum + weight, 0) ?? 0;
  for (let i = 0; i < colliders.length; i++) {
    colliders[i].setMass(rb.props.mass * (total > 0 ? weights[i] / total : 1 / colliders.length));
  }
}

/**
 * ⚠ A CONVEX HULL OF CONCAVE ARCHITECTURE IS A SOLID BLOCK, and Convex is the
 * default shape an auto-generated collider gets.
 *
 * The case that earned this (2026-09-07): the user's Sponza floor is one mesh
 * holding the ground AND the gallery 3.3 m above it — 7 vertices at y = 0 and
 * 16 at y = 3.32. Its convex hull is **713 m³ against the mesh's 162 m³**, a
 * solid brick filling the whole atrium from the floor to the balcony. Every
 * curtain in the room was inside it, and the cloth simulation tore itself
 * apart being pushed out of a collider it lived in. Nothing said so: the
 * collider "worked", the character stood on it, and the volume it actually
 * occupied was invisible.
 *
 * The ratio is the signal, not the size. A genuinely convex mesh hulls to
 * itself (ratio 1); a floor with a raised gallery, an archway, a horseshoe, a
 * bowl — anything with a concavity a body can occupy — hulls to several times
 * its own volume, and everything in that space is now inside a solid.
 *
 * Diagnostic only. Convex is often exactly right (a crate, a rock, a barrel),
 * and the author may want it here too — so this names the shape, the numbers
 * and the alternative, once per entity, and changes nothing.
 */
const HULL_SWALLOW_RATIO = 3;

function warnIfHullSwallowsMesh(pending, colliders) {
  try {
    if (!pending) return;
    const { name, entityId, meshVolume } = pending;
    let hullVolume = 0;
    for (const collider of colliders) hullVolume += collider.volume?.() ?? 0;
    if (globalThis.__physicsHullDebug) console.log(`[hull] ${name}: mesh ${meshVolume.toFixed(2)} hull ${hullVolume.toFixed(2)}`);
    if (!(meshVolume > 0) || !(hullVolume > meshVolume * HULL_SWALLOW_RATIO)) return;
    const seen = (PhysicsSystem._hullSwallowWarned ??= new Set());
    if (seen.has(entityId)) return;
    seen.add(entityId);
    console.warn(
      `Collider on "${name}": CONVEX collision fills ${hullVolume.toFixed(0)} m³ where the mesh itself is ` +
        `${meshVolume.toFixed(0)} m³ — ${(hullVolume / meshVolume).toFixed(0)}x larger. A convex hull cannot have a ` +
        `concavity, so everything in that space is now INSIDE a solid: cloth tears, bodies are pushed out, and ` +
        `characters stand on air. Use Concave collision for level geometry with openings, arches or a raised floor.`,
    );
  } catch {
    // A diagnostic must never be the reason a collider fails to build.
  }
}

/** The stand-in mass for a dynamic body whose collision mesh has no volume. */
const DEGENERATE_MASS = 1;

export class PhysicsSystem {
  constructor(engine, RAPIER) {
    this.engine = engine;
    this.RAPIER = RAPIER;
    this.world = null;
    this.eventQueue = null;
    this.gravity = [0, -9.81, 0];
    this.accumulator = 0;
    this.colliderEntity = new Map(); // collider handle -> entity
    // Layer index per collider handle. Queries filter on this rather than on
    // Rapier's interaction groups — see layers.js for why.
    this.colliderLayer = new Map(); // collider handle -> layer index
    // Cooked vertices stay runtime-derived, while the editable Collider that
    // selects their shape is a normal scene component.
    this.implicitColliderByEntity = new Map(); // entity -> collider[]
    // A visible Collider may own several native hulls. Rapier reports contacts
    // per native handle pair, while scripts expect one logical entity pair.
    this.nativeContactPairs = new Map();
    this.entityContactCounts = new Map();
    this.autoCollisionGeometry = new Map();
    this.autoCookQueue = new Set();
    this.autoCookHandle = null;
    this.autoCookUsesIdleCallback = false;
    this.autoCookWorld = null;
    this.autoCookBody = null;
    this.defaultColliderQueue = new Set();
    // Per-entity churn of the automatic collider within a second — see #autoColliderStorm.
    this.autoColliderChurn = new WeakMap();
    this.defaultColliderFlushPending = false;
    // Suppression (collision=none, CharacterController, source removal) also
    // removes generated components. Only an unguarded removal is a user's
    // explicit deletion and should persist a source-level opt-out.
    this.defaultColliderRemovalGuard = new WeakSet();
    this.disposed = false;
    this.dynamicBodies = []; // { entity, body }
    this.kinematicBodies = []; // { entity, body, prev, delta }
    this.characters = []; // { entity, cc } — kinematic character controllers
    this.joints = []; // { entity, joint }
    // entity -> RAPIER.RigidBody. Held on the system rather than being a local
    // of the world build, because entities now arrive after it: a pooled bullet
    // spawned mid-play needs the same three passes the build does, and a child
    // collider added later needs to find its ancestor's body.
    this.bodyByEntity = new Map();
    // Entities whose physics representation is stale (a component attached or
    // detached, an instance spawned). Flushed at the top of `update` and again
    // the moment a spawn completes — see `#flushDirty`.
    this.dirty = new Set();
    // Layer names + collision matrix. The editor writes project settings into
    // `engine.config.physicsLayers`; an exported build gets the same blob from
    // scene.json. `src/engine` stays physics-agnostic — it just carries it.
    this.layers = new PhysicsLayers(engine.config?.physicsLayers);

    this.unsubs = [
      engine.on("play-changed", (playing) => (playing ? this.#build() : this.#teardown())),
      engine.onUpdate((dt) => this.update(dt)),
      // A spawn is announced once its subtree is complete AND placed. Both
      // halves matter: a body built while the subtree was half-expanded has no
      // ancestor to attach a child collider to, and one built before the spawn
      // position was applied leaves the bullet falling from the muzzle's
      // authored origin. Flushed immediately rather than at the next update, so
      // a script's `onStart` can set a velocity on the thing it just spawned.
      engine.on("entity-spawned", (entity) => {
        this.markDirty(entity);
        this.sync();
      }),
      // A pooled entity is parked, not destroyed: its components stay attached,
      // so nothing else here would ever hear about it. Its body has to go all
      // the same, or the corridor fills with invisible walls where enemies died.
      engine.on("entity-despawned", (entity) => this.removeEntity(entity)),
      engine.on("component-added", (info) => this.#componentStructureChanged(info)),
      engine.on("component-removed", (info) => this.#componentStructureChanged(info)),
      // Mesh assets and legacy OBJ/GLB components attach asynchronously. Cook
      // their collision after the real geometry arrives, not from a placeholder.
      engine.on("model-loaded", (entity) => {
        // Loading reveals whether a GLB is static or skeletal/morphing. Re-run
        // visible default attachment as well as the geometry cook.
        this.#refreshAutoColliderSource(entity);
      }),
      engine.on("component-changed", (info) => {
        if (!info?.entityId) return;
        if (info.componentType === "rigidbody" || info.componentType === "charactercontroller") {
          this.#queueDefaultColliders();
          return;
        }
        if (info.componentType === "collider") {
          this.invalidateAutoCollider(engine.getEntity(info.entityId));
          return;
        }
        if (!["mesh", "model", "objModel", "splineMesh", "geometryModifiers"].includes(info.componentType)) return;
        if (info.componentType === "mesh" && !["geometry", "geometryAsset", "collision"].includes(info.key)) return;
        const entity = engine.getEntity(info.entityId);
        this.#refreshAutoColliderSource(entity);
      }),
      engine.on("hierarchy-changed", () => {
        // Component/source events queue their affected entity directly. A
        // generic hierarchy notification is also used as an editor refresh;
        // treating every one as collision invalidation recooked the whole
        // scene and rebuilt live Rapier handles in periodic timer batches.
        this.prewarmAutoColliders();
      }),
      engine.on("spline-changed", () => {
        for (const entity of engine.entities.values()) {
          if (entity.getComponent?.("splineMesh")) this.invalidateAutoCollider(entity);
        }
      }),
    ];
    engine.physics = this;
    this.#queueDefaultColliders();
    this.prewarmAutoColliders();
    if (engine.playing) this.#build();
  }

  dispose() {
    this.disposed = true;
    for (const unsub of this.unsubs) unsub();
    if (this.autoCookHandle != null) {
      if (this.autoCookUsesIdleCallback) globalThis.cancelIdleCallback?.(this.autoCookHandle);
      else clearTimeout(this.autoCookHandle);
    }
    this.autoCookHandle = null;
    this.autoCookQueue.clear();
    this.defaultColliderQueue.clear();
    this.defaultColliderFlushPending = false;
    this.autoCollisionGeometry.clear();
    this.#teardown();
    this.autoCookWorld?.free();
    this.autoCookWorld = null;
    this.autoCookBody = null;
    if (this.engine.physics === this) delete this.engine.physics;
  }

  setGravity([x, y, z]) {
    this.gravity = [x, y, z];
    if (this.world) this.world.gravity = new this.RAPIER.Vector3(x, y, z);
  }

  /** Remove a live character immediately when its component/entity is
   * detached during Play. Keeping this explicit prevents a resumed frame
   * from stepping a component whose public Rapier handles were cleared. */
  unregisterCharacter(cc) {
    const index = this.characters.findIndex((entry) => entry.cc === cc);
    if (index === -1) return;
    const [entry] = this.characters.splice(index, 1);
    this.#removeCharacterEntry(entry);
  }

  /**
   * Replaces the layer names + collision matrix. Applied live: every existing
   * collider's interaction groups are rewritten, so tweaking the matrix in
   * project settings takes effect without restarting Play.
   */
  setLayers(config) {
    this.layers.set(config ?? {});
    if (!this.world) return;
    for (const [handle, layerIndex] of this.colliderLayer) {
      this.world.getCollider(handle)?.setCollisionGroups(this.layers.groupsFor(layerIndex));
    }
  }

  #componentStructureChanged(info) {
    if (!info?.entityId) return;
    if (![...AUTO_COLLIDER_SOURCE_TYPES, "skinnedmesh", "rigidbody", "charactercontroller", "collider", "water"].includes(info.componentType)) return;
    let entity = this.engine.getEntity(info.entityId);
    if (!entity) return;
    // Imported rig render handles can live below their owning Model entity.
    // Re-evaluate that owner when a marker is attached or removed.
    if (info.componentType === "skinnedmesh") {
      for (let candidate = entity; candidate; candidate = candidate.parent) {
        if (candidate.getComponent?.("model")) {
          entity = candidate;
          break;
        }
      }
    }
    if (info.componentType === "collider"
      && info.component?.props?.autoGenerated
      && !this.defaultColliderRemovalGuard.has(entity)) {
      this.#setAutoCollisionMode(entity, "none");
    }
    this.#queueDefaultColliders(entity);
    this.invalidateAutoCollider(entity);
  }

  #queueDefaultColliders(entity = null) {
    if (this.disposed) return;
    if (entity) this.defaultColliderQueue.add(entity);
    else for (const candidate of this.engine.entities.values()) this.defaultColliderQueue.add(candidate);
    if (this.defaultColliderFlushPending) return;
    this.defaultColliderFlushPending = true;
    queueMicrotask(() => this.#flushDefaultColliders());
  }

  #refreshAutoColliderSource(entity) {
    if (!entity || this.disposed) return;
    this.#queueDefaultColliders(entity);
    this.invalidateAutoCollider(entity);

    // Model/Mesh announce their geometry swap just before their ready promise's
    // finally-handler clears assetLoadsPending. Re-run after that promise too;
    // otherwise the queued pass sees "pending", removes the placeholder, and
    // a static asynchronously-loaded asset never gets its collider back.
    const pending = [entity.getComponent?.("mesh"), entity.getComponent?.("model")]
      .filter((source) => source?.assetLoadsPending && typeof source.whenReady === "function");
    if (!pending.length) return;
    Promise.allSettled(pending.map((source) => source.whenReady())).then(() => {
      if (this.disposed || !this.engine.entities.has(entity.id)) return;
      this.#queueDefaultColliders(entity);
      this.invalidateAutoCollider(entity);
    });
  }

  /**
   * ── THE BOOT STORM THIS FLUSH USED TO BE (2026-09-07) ────────────────────
   *
   * `[engine] hierarchy-changed storm: 30 flushes within a second` on the
   * user's own project traced here: every pass that touched ANY entity emitted
   * a scene-wide "hierarchy-changed", and that event runs ~20 listeners that
   * each walk the scene (ZERO_FREEZE_PLAN §2.4). Two things were wrong.
   *
   * 1. The pass emitted per flush, and each `addComponent`/`removeComponent`
   *    inside it emits its own component events which re-queue entities — so
   *    a scene load produced a chain of flushes, each with its own fan-out.
   *    `batchHierarchy` holds the coalesced event until the whole pass is
   *    done: one event for the pass, whatever it touched.
   *
   * 2. AN AUTO COLLIDER THAT STARTS DISABLED CHANGES NOTHING ANY LISTENER CAN
   *    SEE. It attaches nothing to the scene graph, cooks no shape and builds
   *    no Rapier body until someone enables it (see the 2026-09-02 note
   *    below); `enabled` flipping later emits "hierarchy-changed" on its own.
   *    Announcing it scene-wide was 30 full fan-outs to report an inert row in
   *    the inspector — and the Inspector hears about it through
   *    "component-added" anyway.
   *
   * `globalThis.__physicsColliderFlushQuiet = false` restores the old
   * "any change emits" behaviour for a one-boot A/B.
   */
  #flushDefaultColliders() {
    this.defaultColliderFlushPending = false;
    if (this.disposed) return;
    this.engine.batchHierarchy(() => this.#flushDefaultCollidersPass());
  }

  #flushDefaultCollidersPass() {
    const queued = [...this.defaultColliderQueue];
    this.defaultColliderQueue.clear();
    let changed = false;
    for (const entity of queued) {
      if (!this.engine.entities.has(entity.id)) continue;
      const hasSource = AUTO_COLLIDER_SOURCE_TYPES.some((type) => entity.getComponent?.(type));
      const collider = entity.getComponent?.("collider");
      const sourcePending = this.#autoColliderSourcePending(entity);
      const deformingOnly = hasSource && this.#hasOnlyDeformingGeometry(entity);
      const suppressed = !hasSource
        || this.#autoCollisionMode(entity) === "none"
        || !!entity.getComponent?.("charactercontroller")
        || !!entity.getComponent?.("water")
        || sourcePending
        || deformingOnly;
      if (suppressed) {
        // Editing a generated default makes it authored state. Async loading
        // or skin detection may remove only an untouched automatic component.
        if (collider?.props?.autoGenerated && !collider.props.autoCustomized) {
          if (this.#autoColliderStorm(entity, "remove", { hasSource, sourcePending, deformingOnly, mode: this.#autoCollisionMode(entity) })) continue;
          const wasEnabled = collider.enabled !== false;
          this.defaultColliderRemovalGuard.add(entity);
          try {
            entity.removeComponent("collider");
          } finally {
            this.defaultColliderRemovalGuard.delete(entity);
          }
          // Same rule as the add below: taking away a collider that was never
          // enabled removes nothing from the scene.
          if (wasEnabled || globalThis.__physicsColliderFlushQuiet === false) changed = true;
        }
        continue;
      }
      // Authored collision is authoritative. Automatic collision is a real,
      // visible component, but it is attached after the current component
      // wave so a Collider later in serialized data can win without a race.
      if (collider) continue;
      const requested = this.#autoCollisionMode(entity);
      // ── ATTACHED DISABLED BY DEFAULT (2026-09-02) ──────────────────────
      // Enabling physics used to cook and build a native shape for EVERY
      // mesh in the scene; on Bistro that is 2.8 M triangles of hull and
      // trimesh cooking at scene load — the editor ran at 1 fps and the
      // harness tab died. The generated component still appears on every
      // entity (so it can be found and switched on in the Inspector, or by
      // `component_setProp enabled`), but it starts disabled: no cooking, no
      // native shape, no per-frame cost until the user turns it on. Project
      // Settings → Physics → "Auto colliders start enabled" restores the old
      // behaviour project-wide (`engine.config.physicsAutoColliders`).
      if (this.#autoColliderStorm(entity, "add", { hasSource, sourcePending, deformingOnly, mode: requested })) continue;
      const startsEnabled = this.#autoCollidersStartEnabled();
      entity.addComponent("collider", {
        shape: requested === "concave" ? "concave" : "convex",
        autoGenerated: true,
        enabled: startsEnabled,
      });
      // A DISABLED auto collider is not news: no scene-graph object, no cooked
      // shape, no body. Only an ENABLED one changes what the scene contains.
      if (startsEnabled || globalThis.__physicsColliderFlushQuiet === false) changed = true;
      this.invalidateAutoCollider(entity);
    }
    if (changed) this.engine.emit("hierarchy-changed");
    this.#scheduleAutoCook();
  }

  /**
   * ── A PING-PONG GUARD (2026-09-07) ──────────────────────────────────────
   * The flush adds an automatic collider, the add re-queues the entity, the
   * next flush finds it suppressed and removes it, the removal re-queues it,
   * and every pass emits "hierarchy-changed" — a microtask chain the editor's
   * React mirror reports as "Maximum update depth exceeded" (leaving Play,
   * user 2026-09-07). An entity the flush has changed eight times within a
   * second is left alone for the rest of that second, with the reasons on the
   * console once, so the chain breaks and the cause is named.
   */
  #autoColliderStorm(entity, action, why) {
    const now = (globalThis.performance?.now?.() ?? Date.now());
    let record = this.autoColliderChurn.get(entity);
    if (!record || now - record.since > 1000) { record = { since: now, count: 0, log: [] }; this.autoColliderChurn.set(entity, record); }
    record.count++; record.log.push(action);
    if (record.count === 8) console.warn(`[physics] auto collider ping-pong on "${entity.name}" (${entity.id}): ${record.log.join(",")} within a second — ${JSON.stringify(why)}; leaving it alone for this second`);
    return record.count >= 8;
  }

  /**
   * Queues geometry extraction + convex cooking outside the foreground frame.
   * The first Play still cooks a cache miss synchronously for correctness, but
   * ordinary editor use reaches Play with these derived shapes already warm.
   */
  prewarmAutoColliders(entity = null) {
    if (this.disposed) return;
    if (entity) {
      if (!this.autoCollisionGeometry.has(entity) && this.#needsCollisionGeometry(entity)) {
        this.autoCookQueue.add(entity);
      }
    }
    else {
      for (const candidate of this.engine.entities.values()) {
        if (!this.autoCollisionGeometry.has(candidate) && this.#needsCollisionGeometry(candidate)) {
          this.autoCookQueue.add(candidate);
        }
      }
    }
    this.#scheduleAutoCook();
  }

  /** Invalidates one derived collider after an asset/component geometry swap. */
  invalidateAutoCollider(entity) {
    if (!entity || this.disposed) return;
    this.autoCollisionGeometry.delete(entity);
    this.autoCookQueue.add(entity);
    this.#scheduleAutoCook();
  }

  #scheduleAutoCook() {
    if (this.autoCookHandle != null || !this.autoCookQueue.size || this.disposed) return;
    if (typeof globalThis.requestIdleCallback === "function") {
      this.autoCookUsesIdleCallback = true;
      this.autoCookHandle = globalThis.requestIdleCallback(
        (deadline) => this.#drainAutoCook(deadline),
        { timeout: 500 },
      );
    } else {
      this.autoCookUsesIdleCallback = false;
      this.autoCookHandle = setTimeout(() => this.#drainAutoCook(null), 0);
    }
  }

  #drainAutoCook(deadline) {
    this.autoCookHandle = null;
    if (this.disposed) return;
    const started = performance.now();
    const rebuilt = [];
    let first = true;
    while (this.autoCookQueue.size) {
      // `didTimeout` means the browser owed us a callback; it does NOT grant
      // an unlimited main-thread slice. Treating it that way drained every
      // queued hull after 500 ms and turned a legitimate bulk invalidation
      // into one large Play-mode freeze. Always retain the wall-clock ceiling;
      // `first` below still guarantees forward progress on a busy frame.
      const withinWallBudget = performance.now() - started < 4;
      const hasBudget = withinWallBudget
        && (!deadline || deadline.didTimeout || deadline.timeRemaining() > 1);
      if (!first && !hasBudget) break;
      first = false;
      const entity = this.autoCookQueue.values().next().value;
      this.autoCookQueue.delete(entity);
      if (!this.engine.entities.has(entity.id)) {
        this.autoCollisionGeometry.delete(entity);
        continue;
      }
      this.#cookAutoGeometry(entity);
      if (this.world) rebuilt.push(entity);
    }
    if (rebuilt.length) {
      for (const entity of rebuilt) this.markDirty(entity, { subtree: false });
      this.sync();
    }
    this.#scheduleAutoCook();
  }

  /**
   * Whether a generated default Collider is attached ENABLED. Project-wide,
   * read from the same config blob the layer matrix rides on: the editor sets
   * `engine.config.physicsAutoColliders` from Project Settings → Physics, and
   * an exported build ships the flag inside `config.physics` (→
   * `engine.config.physicsLayers`). Default off — see #flushDefaultColliders.
   */
  #autoCollidersStartEnabled() {
    const config = this.engine?.config;
    return config?.physicsAutoColliders?.startEnabled === true
      || config?.physicsLayers?.autoCollidersEnabled === true;
  }

  #autoCollisionMode(entity) {
    for (const type of AUTO_COLLIDER_SOURCE_TYPES) {
      const source = entity.getComponent?.(type);
      if (source) return source.props?.collision ?? "auto";
    }
    return "auto";
  }

  #setAutoCollisionMode(entity, mode) {
    for (const type of AUTO_COLLIDER_SOURCE_TYPES) {
      const source = entity.getComponent?.(type);
      if (source && source.props?.collision !== mode) source.setProp("collision", mode);
    }
  }

  #autoColliderSourcePending(entity) {
    return !!(entity.getComponent?.("mesh")?.assetLoadsPending
      || entity.getComponent?.("model")?.assetLoadsPending);
  }

  #hasOnlyDeformingGeometry(entity) {
    const deforming = !!entity.getComponent?.("skinnedmesh")
      || hasOwnedDeformingCollisionGeometry(entity.object3D, entity.id);
    return deforming && !hasOwnedStaticCollisionGeometry(entity.object3D, entity.id);
  }

  #hasCollisionGeometrySource(entity) {
    if (!entity || !AUTO_COLLIDER_SOURCE_TYPES.some((type) => entity.getComponent?.(type))) return false;
    const collider = entity.getComponent?.("collider");
    if (collider && (!collider.props.autoGenerated || collider.props.autoCustomized)) return true;
    // A water surface is a fluid boundary, not a solid rest-plane collider.
    if (entity.getComponent?.("water")) return false;
    // No component yet and defaults start disabled: the one that will be
    // attached is disabled, so there is nothing to cook and no implicit
    // native shape to build in the window before it lands.
    if (!collider && !this.#autoCollidersStartEnabled()) return false;
    const deformingOnly = this.#hasOnlyDeformingGeometry(entity);
    if (this.#autoColliderSourcePending(entity) || deformingOnly) return false;
    return this.#autoCollisionMode(entity) !== "none";
  }

  #needsCollisionGeometry(entity) {
    const collider = entity.getComponent?.("collider");
    if (entity.getComponent?.("charactercontroller")) return false;
    if (collider && !collider.enabled) return false;
    const shape = collider?.props?.shape;
    // A Custom collider's source is its authored asset, not rendered meshes —
    // it does not need (and may not have) a Mesh/Model on the entity.
    if (shape === "custom") return !!collider.props.geometryAsset;
    if (!this.#hasCollisionGeometrySource(entity)) return false;
    return !shape || shape === "convex" || shape === "concave" || shape === "mesh";
  }

  #hasAutoColliderSource(entity) {
    return this.#hasCollisionGeometrySource(entity)
      && !entity.getComponent?.("collider")
      && !entity.getComponent?.("charactercontroller");
  }

  #cookAutoGeometry(entity) {
    if (!this.#needsCollisionGeometry(entity)) {
      this.autoCollisionGeometry.set(entity, null);
      return null;
    }
    const collider = entity.getComponent?.("collider");
    if (collider?.props?.shape === "custom") return this.#cookCustomGeometry(entity, collider);
    const mesh = entity.getComponent?.("mesh");
    const model = entity.getComponent?.("model");
    if (mesh?.assetLoadsPending || model?.assetLoadsPending) {
      this.autoCollisionGeometry.set(entity, null);
      return null;
    }
    const options = {
      ownerEntityId: entity.getComponent?.("collider")?.props?.autoGenerated ? entity.id : null,
      bakeRootScale: false,
      includeSkinned: false,
    };
    const sourceParts = collectCollisionMeshParts(entity.object3D, options);
    const triangles = mergeCollisionMeshes(sourceParts);
    if (!triangles) {
      this.autoCollisionGeometry.set(entity, null);
      return null;
    }
    const convexParts = sourceParts
      .map((part) => this.#cookConvexMesh(part.vertices))
      .filter(Boolean);
    const concave = mergeCollisionMeshes(sourceParts.map((part) => simplifyCollisionMesh(part)));
    const cooked = {
      ...triangles,
      convexParts,
      concave,
      // Kept as a compatibility/fallback view for callers that require one
      // envelope. Runtime and preview prefer the separate island hulls.
      convex: convexParts.length === 1 ? convexParts[0] : this.#cookConvexMesh(triangles.vertices),
    };
    this.autoCollisionGeometry.set(entity, cooked);
    this.engine.emit("physics-collider-cooked", entity);
    return cooked;
  }

  /**
   * Cooks a Custom collider from its authored `.geom` asset. The component
   * owns the load (ColliderComponent.geometry, the shared refcounted
   * instance); until it arrives there is nothing to cook, and a geometry
   * whose recorded path no longer matches the picker is treated the same way
   * — a mid-swap cook must never build the OLD asset's shape.
   */
  #cookCustomGeometry(entity, collider) {
    const geometry = collider.geometry;
    if (!geometry || geometry.userData?.assetPath !== collider.props.geometryAsset) {
      this.autoCollisionGeometry.set(entity, null);
      return null;
    }
    const parts = collisionMeshPartsFromGeometry(geometry);
    const triangles = mergeCollisionMeshes(parts);
    if (!triangles) {
      this.autoCollisionGeometry.set(entity, null);
      return null;
    }
    const convexParts = parts
      .map((part) => this.#cookConvexMesh(part.vertices))
      .filter(Boolean);
    const concave = mergeCollisionMeshes(parts.map((part) => simplifyCollisionMesh(part)));
    const cooked = {
      ...triangles,
      convexParts,
      concave,
      convex: convexParts.length === 1 ? convexParts[0] : this.#cookConvexMesh(triangles.vertices),
    };
    this.autoCollisionGeometry.set(entity, cooked);
    this.engine.emit("physics-collider-cooked", entity);
    return cooked;
  }

  #cookConvexMesh(vertices) {
    if (!vertices || vertices.length < 12) return null;
    let collider = null;
    try {
      if (!this.autoCookWorld) {
        this.autoCookWorld = new this.RAPIER.World({ x: 0, y: 0, z: 0 });
        this.autoCookBody = this.autoCookWorld.createRigidBody(this.RAPIER.RigidBodyDesc.fixed());
      }
      const desc = this.RAPIER.ColliderDesc.convexHull(vertices);
      if (!desc) return null;
      collider = this.autoCookWorld.createCollider(desc, this.autoCookBody);
      const hullVertices = new Float32Array(collider.vertices());
      const rawIndices = collider.indices();
      const hullIndices = rawIndices ? new Uint32Array(rawIndices) : null;
      if (!hullIndices?.length) return null;
      return { vertices: hullVertices, indices: hullIndices };
    } catch {
      return null;
    } finally {
      if (collider) this.autoCookWorld?.removeCollider(collider, false);
    }
  }

  #getAutoGeometry(entity) {
    if (!this.autoCollisionGeometry.has(entity)) return this.#cookAutoGeometry(entity);
    return this.autoCollisionGeometry.get(entity);
  }

  /** Cached local-space triangles and convex hull used by the editor preview. */
  getCookedColliderGeometry(entity) {
    return this.autoCollisionGeometry.get(entity) ?? null;
  }

  // ---- queries ------------------------------------------------------------
  //
  // Every query takes the same options bag:
  //   layers  — only hit colliders on these layers (names). Omitted = all.
  //             Independent of the collision matrix (see layers.js).
  //   exclude — an entity (or array) whose colliders are ignored. This is the
  //             "don't shoot yourself" argument, and it is the single most
  //             common reason a naive raycast returns the wrong hit.
  //   solid   — treat shapes the origin is already inside as hits (default true)

  /** Builds the `filterPredicate` + exclusion args shared by every query. */
  #filter({ layers = null, exclude = null } = {}) {
    const mask = this.layers.maskFor(layers);
    const excluded = new Set();
    for (const entity of exclude == null ? [] : Array.isArray(exclude) ? exclude : [exclude]) {
      const target = typeof entity === "string" ? this.engine.getEntity(entity) : entity;
      // Excluding an entity excludes its whole subtree: a character's capsule
      // and the weapon model parented under it are one thing to the player.
      target?.traverse?.((e) => excluded.add(e.id));
    }
    const all = mask === 0xffff;
    if (all && !excluded.size) return null;
    return (collider) => {
      const handle = collider.handle;
      if (!all && !(mask & (1 << (this.colliderLayer.get(handle) ?? 0)))) return false;
      if (excluded.size) {
        const entity = this.colliderEntity.get(handle);
        if (entity && excluded.has(entity.id)) return false;
      }
      return true;
    };
  }

  #hitFromRay(ray, hit) {
    const distance = hit.timeOfImpact ?? hit.toi;
    const point = ray.pointAt(distance);
    return {
      entity: this.colliderEntity.get(hit.collider.handle) ?? null,
      point: [point.x, point.y, point.z],
      normal: hit.normal ? [hit.normal.x, hit.normal.y, hit.normal.z] : [0, 0, 0],
      distance,
    };
  }

  /**
   * Closest hit along a world-space ray, or null.
   *
   *     const hit = this.engine.physics.raycast(
   *       muzzle, forward, 100, { layers: ["Enemy", "Ground"], exclude: this.entity });
   */
  raycast(origin, direction, maxDistance = 1000, options = {}) {
    if (!this.world) return null;
    const ray = this.#ray(origin, direction);
    const hit = this.world.castRayAndGetNormal(
      ray, maxDistance, options.solid !== false, undefined, undefined, undefined, undefined, this.#filter(options),
    );
    return hit ? this.#hitFromRay(ray, hit) : null;
  }

  /** Every hit along the ray, nearest first — shotgun pellets, penetration. */
  raycastAll(origin, direction, maxDistance = 1000, options = {}) {
    if (!this.world) return [];
    const ray = this.#ray(origin, direction);
    const hits = [];
    this.world.intersectionsWithRay(
      ray, maxDistance, options.solid !== false,
      (hit) => {
        hits.push(this.#hitFromRay(ray, hit));
        return true; // keep going
      },
      undefined, undefined, undefined, undefined, this.#filter(options),
    );
    return hits.sort((a, b) => a.distance - b.distance);
  }

  /**
   * Sweeps a shape through the world and returns the first thing it would hit
   * — the query a ground check, a melee swing or a dash wants, because unlike
   * a ray it has thickness and cannot slip through a gap the character can't.
   */
  shapecast(shape, origin, direction, maxDistance = 1000, options = {}) {
    if (!this.world) return null;
    const desc = this.#shape(shape);
    if (!desc) return null;
    const o = xyz(origin);
    const d = xyz(direction);
    const dir = _pos.set(d.x, d.y, d.z).normalize();
    const rot = options.rotation
      ? { x: options.rotation[0], y: options.rotation[1], z: options.rotation[2], w: options.rotation[3] }
      : { x: 0, y: 0, z: 0, w: 1 };
    const hit = this.world.castShape(
      { x: o.x, y: o.y, z: o.z },
      rot,
      { x: dir.x * maxDistance, y: dir.y * maxDistance, z: dir.z * maxDistance },
      desc,
      0,
      1,
      options.stopAtPenetration !== false,
      undefined, undefined, undefined, undefined, this.#filter(options),
    );
    if (!hit) return null;
    // castShape's velocity is the full sweep, so time_of_impact is 0..1 along
    // it — convert back to world units so callers can compare it to a ray.
    const t = hit.time_of_impact ?? hit.timeOfImpact ?? 0;
    const w = hit.witness1;
    const n = hit.normal1;
    return {
      entity: this.colliderEntity.get(hit.collider.handle) ?? null,
      point: w ? [w.x, w.y, w.z] : [0, 0, 0],
      normal: n ? [n.x, n.y, n.z] : [0, 0, 0],
      distance: t * maxDistance,
    };
  }

  /** `shapecast` with a sphere — the usual ground/ledge probe. */
  spherecast(origin, radius, direction, maxDistance = 1000, options = {}) {
    return this.shapecast({ kind: "sphere", radius }, origin, direction, maxDistance, options);
  }

  /** `shapecast` with a box. `halfExtents` is half the size on each axis. */
  boxcast(origin, halfExtents, direction, maxDistance = 1000, options = {}) {
    return this.shapecast({ kind: "box", halfExtents }, origin, direction, maxDistance, options);
  }

  /** `shapecast` with a capsule (halfHeight excludes the caps, like Rapier). */
  capsulecast(origin, radius, halfHeight, direction, maxDistance = 1000, options = {}) {
    return this.shapecast({ kind: "capsule", radius, halfHeight }, origin, direction, maxDistance, options);
  }

  /**
   * Every entity whose collider overlaps a shape placed at `center`. The
   * explosion-damage / interaction-prompt / "who is in this room" query.
   * Entities are de-duplicated — a compound body counts once.
   */
  overlap(shape, center, options = {}) {
    if (!this.world) return [];
    const desc = this.#shape(shape);
    if (!desc) return [];
    const rot = options.rotation
      ? { x: options.rotation[0], y: options.rotation[1], z: options.rotation[2], w: options.rotation[3] }
      : { x: 0, y: 0, z: 0, w: 1 };
    const found = new Set();
    const c = xyz(center);
    this.world.intersectionsWithShape(
      { x: c.x, y: c.y, z: c.z },
      rot,
      desc,
      (collider) => {
        const entity = this.colliderEntity.get(collider.handle);
        if (entity) found.add(entity);
        return true;
      },
      undefined, undefined, undefined, undefined, this.#filter(options),
    );
    return [...found];
  }

  overlapSphere(center, radius, options = {}) {
    return this.overlap({ kind: "sphere", radius }, center, options);
  }

  overlapBox(center, halfExtents, options = {}) {
    return this.overlap({ kind: "box", halfExtents }, center, options);
  }

  overlapCapsule(center, radius, halfHeight, options = {}) {
    return this.overlap({ kind: "capsule", radius, halfHeight }, center, options);
  }

  #ray(origin, direction) {
    const o = xyz(origin);
    const d = xyz(direction);
    const dir = _pos.set(d.x, d.y, d.z).normalize();
    return new this.RAPIER.Ray(
      { x: o.x, y: o.y, z: o.z },
      { x: dir.x, y: dir.y, z: dir.z },
    );
  }

  /** Query shapes are built per call — they are tiny and Rapier copies them. */
  #shape(shape) {
    const { RAPIER } = this;
    if (!shape) return null;
    if (typeof shape.radius === "number" && shape.kind === "sphere") return new RAPIER.Ball(shape.radius);
    if (shape.kind === "box") {
      const [x, y, z] = shape.halfExtents ?? [0.5, 0.5, 0.5];
      return new RAPIER.Cuboid(x, y, z);
    }
    if (shape.kind === "capsule") return new RAPIER.Capsule(shape.halfHeight ?? 0.5, shape.radius ?? 0.5);
    console.warn(`physics: unknown query shape "${shape.kind}"`);
    return null;
  }

  // ---- world build ----

  #build() {
    this.#teardown();
    this.#flushDefaultColliders();
    const { RAPIER } = this;
    this.world = new RAPIER.World({ x: this.gravity[0], y: this.gravity[1], z: this.gravity[2] });
    this.eventQueue = new RAPIER.EventQueue(true);
    this.engine.scene.updateMatrixWorld(true);

    const entities = [...this.engine.entities.values()];
    // Three passes, and the order is the whole reason they are separate: a
    // collider needs its (possibly ancestral) body to exist, and a joint needs
    // the bodies at BOTH of its ends. `#addEntities` runs the same three for a
    // subtree that turns up after the world is already running.
    for (const entity of entities) this.#createBody(entity);
    for (const entity of entities) this.#createColliders(entity);
    this.#applyFallbackMass(entities);
    this.#buildJoints(entities);

    // Scene queries read acceleration structures that `step` maintains, so a
    // world that has never stepped answers EVERY raycast with null — including
    // one fired from a script's `onStart`, before the first frame. Prime them
    // with a zero-length step: nothing integrates, but the structures get
    // built. The event queue is passed (not drained) on purpose, so a body
    // that spawns already inside a trigger still reports its enter event on
    // the first real tick.
    this.world.timestep = 0;
    this.world.step(this.eventQueue);
    this.world.timestep = FIXED_DT;
    // Rapier's event queue only holds the LAST step's events, so the priming
    // step's have to be taken out now or the next step drops them — which
    // would silently swallow the enter event for anything that spawns already
    // inside a trigger. Held, not dispatched: scripts have not had their
    // `onStart` yet, and receiving `onTriggerEnter` before `onStart` would be
    // a genuinely confusing order. The first real tick delivers them.
    this._deferredEvents = [];
    this.#drainEvents(this._deferredEvents);
  }

  /**
   * Pass 1 for one entity: a body per entity that has a rigidbody, or a static
   * body per collider-only entity with no rigidbody anywhere above it (compound
   * child colliders attach to the ancestor's body in pass 2).
   */
  #createBody(entity) {
    const { RAPIER } = this;
    // Character controllers own their body + capsule collider exclusively.
    const cc = entity.getComponent("charactercontroller");
    if (cc) {
      this.#buildCharacter(entity, cc);
      return;
    }
    const rb = entity.getComponent("rigidbody");
    const col = entity.getComponent("collider");
    const implicit = this.#hasAutoColliderSource(entity);
    if (!rb && (!col || !col.enabled) && !implicit) return;
    if (!rb && this.#ancestorBodyEntity(entity)) return;

    entity.object3D.getWorldPosition(_pos);
    entity.object3D.getWorldQuaternion(_quat);
    // A body placed at NaN panics Rapier on the first step and poisons the wasm
    // module for the session — see #finiteDims. A broken transform is a much
    // smaller problem than a physics world that can never be stepped again.
    if (![_pos.x, _pos.y, _pos.z, _quat.x, _quat.y, _quat.z, _quat.w].every(Number.isFinite)) {
      console.error(
        `"${entity.name}" has a non-finite world transform, so no physics body was created for it. ` +
          "Check its position/rotation/scale and those of its ancestors.",
      );
      return;
    }
    const type = rb?.props.bodyType ?? "fixed";
    const desc = (
      type === "dynamic" ? RAPIER.RigidBodyDesc.dynamic()
      : type === "kinematic" ? RAPIER.RigidBodyDesc.kinematicPositionBased()
      : RAPIER.RigidBodyDesc.fixed()
    )
      .setTranslation(_pos.x, _pos.y, _pos.z)
      .setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
    if (rb && type === "dynamic") {
      desc
        .setLinearDamping(rb.props.linearDamping)
        .setAngularDamping(rb.props.angularDamping)
        .setGravityScale(rb.props.gravityScale)
        .setCcdEnabled(!!rb.props.ccd)
        .enabledRotations(!rb.props.lockRotationX, !rb.props.lockRotationY, !rb.props.lockRotationZ);
    }
    const body = this.world.createRigidBody(desc);
    this.bodyByEntity.set(entity, body);
    if (!rb) return;
    rb.body = body;
    if (type === "dynamic") this.dynamicBodies.push({ entity, body });
    // `prev`/`delta` track how far a kinematic body moved each step, so a
    // character standing on it can be carried along (see #carryVelocity).
    else if (type === "kinematic") {
      this.kinematicBodies.push({ entity, body, prev: [_pos.x, _pos.y, _pos.z], delta: [0, 0, 0] });
    }
  }

  /** Pass 2 for one entity: its collider, on its own body or its ancestor's. */
  #createColliders(entity) {
    if (entity.getComponent("charactercontroller")) return; // owns its own capsule
    const col = entity.getComponent("collider");
    if (col && !col.enabled) return;
    if (!col && !this.#hasAutoColliderSource(entity)) return;
    const bodyEntity = this.bodyByEntity.has(entity) ? entity : this.#ancestorBodyEntity(entity);
    const body = bodyEntity ? this.bodyByEntity.get(bodyEntity) : null;
    if (!body) return;
    const result = col
      ? this.#colliderDesc(col, entity, bodyEntity)
      : this.#implicitColliderDesc(entity, bodyEntity);
    if (!result) return;
    const descs = Array.isArray(result) ? result : [result];
    const colliders = [];
    try {
      for (const desc of descs) colliders.push(this.world.createCollider(desc, body));
    } catch (error) {
      for (const collider of colliders) this.world.removeCollider(collider, true);
      throw new Error(`Failed to create collider for "${entity.name}": ${error?.message ?? error}`, { cause: error });
    }
    if (this._pendingHullCheck) {
      warnIfHullSwallowsMesh(this._pendingHullCheck, colliders);
      this._pendingHullCheck = null;
    }
    if (col) {
      col.colliders = colliders;
      col.collider = colliders[0] ?? null;
    } else if (colliders.length) {
      this.implicitColliderByEntity.set(entity, colliders);
    }
    const layer = this.layers.indexOf(col?.props.layer ?? AUTO_COLLIDER_DEFAULTS.layer);
    for (const collider of colliders) {
      this.colliderEntity.set(collider.handle, entity);
      this.colliderLayer.set(collider.handle, layer);
    }
  }

  /**
   * Pass 3: rescue dynamic bodies that ended up weighing nothing.
   *
   * Mass is set on the COLLIDER descriptor, because that is the only way to get
   * an inertia tensor derived from the actual shape — a body given a bare
   * scalar mass tumbles like a point mass. The cost of that choice is that a
   * dynamic body with no mass-contributing collider has a mass of zero, and
   * Rapier applies gravity as a FORCE of `mass × g`: zero mass is zero force,
   * and an inverse mass of zero also swallows every `applyForce` and
   * `applyImpulse`. So the body sits in mid-air, perfectly still, ignoring
   * everything — while the Inspector goes on reading "Mass: 1".
   *
   * It is reached more easily than it looks: add a Rigidbody and press Play
   * before adding the Collider, remove a collider at runtime, or leave a body
   * whose only collider is a trigger. Falling back here rather than predicting
   * it in pass 1 means the question is asked of the world after the colliders
   * are actually in it, so it cannot disagree with them.
   */
  #applyFallbackMass(entities) {
    for (const entity of entities) {
      const body = this.bodyByEntity.get(entity);
      if (!body || !body.isDynamic() || body.mass() > 0) continue;
      const mass = entity.getComponent("rigidbody")?.props.mass;
      // `false`: nothing is asleep yet at build time, and waking a body here
      // would be a side effect of measuring it.
      body.setAdditionalMass(mass > 0 ? mass : 1, false);
    }
  }

  // ---- runtime registration ------------------------------------------------
  //
  // The world used to be built exactly once, from the entity tree, at Play.
  // Anything spawned afterwards — the bullet, the enemy, the pooled effect —
  // therefore had a Rigidbody component whose `body` stayed null forever: it
  // never fell, never collided, and nothing said so. The mirror was as bad:
  // destroying an entity mid-play left its collider in the world, so a corridor
  // slowly filled with invisible walls where enemies had died.

  /**
   * Marks an entity's physics representation stale. Cheap and idempotent —
   * components call it from `onAttach`, and the actual rebuild happens once per
   * flush no matter how many components on one entity ask for it.
   *
   * `subtree` defaults to true because the reason to rebuild is almost always
   * structural: a rigidbody appearing above a child collider changes which body
   * that collider belongs to, and the child has no way to know.
   */
  markDirty(entity, { subtree = true } = {}) {
    if (!entity) return;
    if (subtree) entity.traverse((e) => this.dirty.add(e));
    else this.dirty.add(entity);
  }

  /** Rebuilds everything marked dirty. Safe to call at any time. */
  sync() {
    this.#flushDirty({ prime: true });
  }

  /** Builds (or rebuilds) the physics representation of an entity subtree. */
  addEntity(entity) {
    this.markDirty(entity);
    this.#flushDirty({ prime: true });
  }

  /**
   * Removes an entity subtree from the world. Called from component teardown,
   * so it must tolerate being invoked for entities that were never in it.
   */
  removeEntity(entity, { subtree = true } = {}) {
    if (!this.world || !entity) return;
    const list = [];
    if (subtree) entity.traverse((e) => list.push(e));
    else list.push(entity);
    this.#removeEntities(list);
  }

  #flushDirty({ prime = false } = {}) {
    if (!this.world || !this.dirty.size) return;
    // An entity can be marked dirty and then destroyed in the same frame (spawn
    // an effect, kill it on the same tick); `removeEntity` already took its
    // bodies out, and rebuilding one that is no longer in the scene would put
    // a body back with nothing to own it.
    const list = [...this.dirty].filter((e) => this.engine.entities.has(e.id));
    this.dirty.clear();
    if (!list.length) return;
    // Only the affected subtrees, not the whole scene: this runs per spawn, and
    // a full `scene.updateMatrixWorld(true)` per bullet is the sort of cost that
    // makes pooling pointless. `updateWorldMatrix(true, true)` walks up to the
    // root for ancestry and down through the subtree.
    for (const entity of list) entity.object3D.updateWorldMatrix(true, true);
    this.#removeEntities(list);
    for (const entity of list) this.#createBody(entity);
    for (const entity of list) this.#createColliders(entity);
    this.#applyFallbackMass(list);
    this.#buildJoints(list);
    if (prime) this.#primeQueries();
  }

  /**
   * Makes a body created between steps visible to scene queries.
   *
   * Rapier maintains its query acceleration structures inside `step`, so a
   * collider added since the last one is invisible to every raycast until the
   * next — which means `spawn` a grenade and immediately `raycast` from it (a
   * script's `onStart`, the ordinary case) silently misses. A zero-length step
   * builds the structures without integrating anything: the same trick the
   * world build uses to make queries work before the first frame.
   *
   * The events it produces are held rather than dispatched, exactly as the
   * build does — a body that spawns already inside a trigger must still report
   * entering it, but not before its scripts have had their `onStart`.
   */
  #primeQueries() {
    const timestep = this.world.timestep;
    this.world.timestep = 0;
    this.world.step(this.eventQueue);
    this.world.timestep = timestep;
    this._deferredEvents ??= [];
    this.#drainEvents(this._deferredEvents);
  }

  /**
   * Frees the joints an entity owns, leaving its body alone. Detaching a
   * JointComponent means "this door is no longer hinged", not "this door is no
   * longer a physics object".
   */
  removeJoints(entity) {
    if (!this.world) return;
    for (let i = this.joints.length - 1; i >= 0; i--) {
      const entry = this.joints[i];
      if (entry.entity !== entity) continue;
      this.joints.splice(i, 1);
      const comp = entity.getComponent?.("joint");
      if (comp?.joint === entry.joint) comp.joint = null;
      this.world.removeImpulseJoint(entry.joint, true);
    }
  }

  /** Frees the Rapier objects owned by these entities, in dependency order. */
  #removeEntities(list) {
    const set = new Set(list);
    // Bodies about to be freed, by handle. Removing a body frees the colliders
    // attached to it, so a collider whose body is in this set must NOT also be
    // removed by hand — Rapier treats the second removal as a use-after-free.
    const doomed = new Set();
    for (const entity of list) {
      const body = this.bodyByEntity.get(entity);
      if (body) doomed.add(body.handle);
    }

    // Joints first: a joint outliving either of its bodies is a dangling
    // reference the next step reads.
    for (const entity of list) this.removeJoints(entity);

    for (const entity of list) {
      const cc = entity.getComponent?.("charactercontroller");
      if (cc) this.unregisterCharacter(cc);

      const col = entity.getComponent?.("collider");
      const explicitColliders = col?.colliders?.length
        ? [...col.colliders]
        : col?.collider ? [col.collider] : [];
      for (const collider of explicitColliders) {
        const handle = collider.handle;
        this.#forgetColliderContacts(handle);
        this.colliderEntity.delete(handle);
        this.colliderLayer.delete(handle);
        if (!doomed.has(collider.parent()?.handle)) this.world.removeCollider(collider, true);
      }
      if (col) {
        col.collider = null;
        col.colliders = [];
      }

      const implicitColliders = this.implicitColliderByEntity.get(entity) ?? [];
      if (implicitColliders.length) {
        this.implicitColliderByEntity.delete(entity);
        for (const implicit of implicitColliders) {
          this.#forgetColliderContacts(implicit.handle);
          this.colliderEntity.delete(implicit.handle);
          this.colliderLayer.delete(implicit.handle);
          if (!doomed.has(implicit.parent()?.handle)) this.world.removeCollider(implicit, true);
        }
      }

      const body = this.bodyByEntity.get(entity);
      if (!body) continue;
      this.bodyByEntity.delete(entity);
      // Colliders on this body that belong to OTHER entities (compound child
      // colliders) die with it, so their bookkeeping has to go too.
      for (const [handle, owner] of [...this.colliderEntity]) {
        const collider = this.world.getCollider(handle);
        if (collider && collider.parent()?.handle !== body.handle) continue;
        this.#forgetColliderContacts(handle);
        this.colliderEntity.delete(handle);
        this.colliderLayer.delete(handle);
        const comp = owner.getComponent?.("collider");
        if (comp) {
          comp.colliders = (comp.colliders ?? []).filter((collider) => collider.handle !== handle);
          comp.collider = comp.colliders[0] ?? null;
        }
        const implicit = this.implicitColliderByEntity.get(owner);
        if (implicit?.some((entry) => entry.handle === handle)) {
          const remaining = implicit.filter((entry) => entry.handle !== handle);
          if (remaining.length) this.implicitColliderByEntity.set(owner, remaining);
          else this.implicitColliderByEntity.delete(owner);
        }
      }
      this.dynamicBodies = this.dynamicBodies.filter((e) => e.body !== body);
      this.kinematicBodies = this.kinematicBodies.filter((e) => e.body !== body);
      const rb = entity.getComponent?.("rigidbody");
      if (rb?.body === body) rb.body = null;
      this.world.removeRigidBody(body);
    }
  }

  /**
   * Impulse joints (doors, ropes, swings, suspension). A JointComponent lives
   * on the entity holding the joint's own body and names the entity it is
   * attached to; leaving that blank pins the body to the world through a
   * hidden fixed body, which is how a swinging sign or a lamp cord is built.
   */
  #buildJoints(entities) {
    const { RAPIER } = this;
    const bodyByEntity = this.bodyByEntity;
    const v = (a) => ({ x: a?.[0] ?? 0, y: a?.[1] ?? 0, z: a?.[2] ?? 0 });
    for (const entity of entities) {
      const comp = entity.getComponent("joint");
      if (!comp) continue;
      const bodyA = bodyByEntity.get(entity) ?? entity.getComponent("rigidbody")?.body;
      if (!bodyA) {
        console.warn(`Joint on "${entity.name}": needs a Rigidbody on the same entity`);
        continue;
      }
      const p = comp.props;
      const other = p.connectedEntity ? this.engine.getEntity(p.connectedEntity) : null;
      if (p.connectedEntity && !other) {
        console.warn(`Joint on "${entity.name}": connected entity not found`);
        continue;
      }
      let bodyB = other ? bodyByEntity.get(other) ?? other.getComponent("rigidbody")?.body : null;
      if (other && !bodyB) {
        console.warn(`Joint on "${entity.name}": "${other.name}" has no Rigidbody`);
        continue;
      }
      if (!bodyB) {
        // Anchor to the world: a fixed body at this entity's current pose.
        entity.object3D.getWorldPosition(_pos);
        bodyB = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(_pos.x, _pos.y, _pos.z),
        );
      }
      const a1 = v(p.anchor);
      const a2 = v(p.connectedAnchor);
      const axis = v(p.axis?.some?.((n) => n !== 0) ? p.axis : [0, 1, 0]);
      let data = null;
      if (p.kind === "hinge") data = RAPIER.JointData.revolute(a1, a2, axis);
      else if (p.kind === "ball") data = RAPIER.JointData.spherical(a1, a2);
      else if (p.kind === "slider") data = RAPIER.JointData.prismatic(a1, a2, axis);
      else if (p.kind === "spring") data = RAPIER.JointData.spring(p.restLength, p.stiffness, p.damping, a1, a2);
      else if (p.kind === "rope") data = RAPIER.JointData.rope(Math.max(p.restLength, 0.0001), a1, a2);
      else data = RAPIER.JointData.fixed(a1, { x: 0, y: 0, z: 0, w: 1 }, a2, { x: 0, y: 0, z: 0, w: 1 });

      const joint = this.world.createImpulseJoint(data, bodyA, bodyB, true);
      // Connected bodies usually want to interpenetrate — a hinged door and
      // its frame overlap at the pivot by construction.
      joint.setContactsEnabled?.(!!p.enableCollision);
      // A hinge's limits and motor speed are ANGLES: authored in degrees
      // (a "±45" door reads wrong as radians), stored in degrees, converted
      // here. A slider's are distances and pass through untouched.
      const angular = p.kind === "hinge";
      const toNative = (value) => (angular ? value * DEG2RAD : value);
      if (p.limitsEnabled && (p.kind === "hinge" || p.kind === "slider")) {
        joint.setLimits?.(toNative(p.limitMin), toNative(p.limitMax));
      }
      if (p.motorEnabled && (p.kind === "hinge" || p.kind === "slider")) {
        joint.configureMotorVelocity?.(toNative(p.motorSpeed), p.motorMaxForce);
      }
      comp.joint = joint;
      this.joints.push({ entity, joint });
    }
  }

  #ancestorBodyEntity(entity) {
    for (let p = entity.parent; p; p = p.parent) {
      if (p.getComponent("rigidbody")) return p;
    }
    return null;
  }

  /**
   * Every dimension handed to Rapier, checked for being a finite number first.
   *
   * ⚠ A NaN OR INFINITE EXTENT IS NOT A BAD COLLIDER, IT IS A DEAD SESSION.
   * Rapier's rust panics on a non-finite shape inside `world.step`, and a panic
   * in wasm leaves the module's RefCell mutably borrowed forever — so every
   * subsequent call, in any frame, fails with "recursive use of an object
   * detected which would lead to unsafe aliasing in rust" or "null pointer
   * passed to rust". Play mode then throws once per frame and never recovers,
   * `play_set` reports failure for actions that succeeded, and only restarting
   * the editor clears it. Removing the offending entity does not help: the
   * module is already poisoned.
   *
   * It is reached more easily than a NaN usually is. A collider whose `size`
   * was stored as the STRING "[5, 6, 7]" (see api/props.js for how values used
   * to arrive as text) makes `size[0] / 2` NaN; so does a zero-scaled ancestor
   * fed through a degenerate matrix. The editor API refuses the string now, but
   * a scene saved while it did not, an imported model, or a script writing
   * props directly can all still produce one — and the cost of not checking is
   * out of all proportion to the cost of checking.
   *
   * Skipping the collider (returning null) is the survivable failure: the
   * entity has no collision, the console says exactly which entity and which
   * number, and the world keeps stepping.
   */
  #finiteDims(entity, shape, dims) {
    for (const [name, value] of Object.entries(dims)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) continue;
      console.error(
        `Collider on "${entity.name}": ${shape} ${name} is ${JSON.stringify(value)}, which is not a ` +
          "positive finite number. Skipping this collider — a non-finite shape crashes the physics " +
          "world and poisons it for the rest of the session. Check the component's size/radius/height " +
          "props and the entity's scale.",
      );
      return false;
    }
    return true;
  }

  #implicitColliderDesc(entity, bodyEntity) {
    const cooked = this.#getAutoGeometry(entity);
    if (!cooked) return null;

    const bodyType = bodyEntity.getComponent?.("rigidbody")?.props?.bodyType ?? "fixed";
    const mode = this.#autoCollisionMode(entity);
    // A standalone fixed surface keeps exact holes/doorways. Anything moving,
    // or acting as a child shape on a compound body, must be a solid convex
    // shape; Rapier trimeshes are hollow and unsuitable for moving bodies.
    const convex = (mode !== "concave" && mode !== "mesh") || entity !== bodyEntity || bodyType !== "fixed";

    entity.object3D.getWorldScale(_scale);
    const scaledParts = convex
      ? (cooked.convexParts?.length ? cooked.convexParts : cooked.convex ? [cooked.convex] : [])
          .map((part) => scaleCollisionMesh(part, _scale))
      : [scaleCollisionMesh(mode === "concave" ? cooked.concave ?? cooked : cooked, _scale)];
    if (!scaledParts.length || scaledParts.some((part) => !part?.vertices.every(Number.isFinite))) {
      console.warn(`Automatic collider on "${entity.name}": geometry has no valid ${convex ? "convex hull" : "triangles"}`);
      return null;
    }

    const shapes = scaledParts
      .map((part) => ({
        part,
        desc: convex
          ? this.RAPIER.ColliderDesc.convexHull(part.vertices)
          : this.RAPIER.ColliderDesc.trimesh(part.vertices, part.indices),
      }))
      .filter(({ desc }) => !!desc);
    if (!shapes.length) {
      console.warn(`Automatic collider on "${entity.name}": geometry has no three-dimensional convex hull`);
      return null;
    }

    for (const { desc } of shapes) {
      desc
        .setFriction(AUTO_COLLIDER_DEFAULTS.friction)
        .setRestitution(AUTO_COLLIDER_DEFAULTS.restitution)
        .setSensor(false)
        .setCollisionGroups(this.layers.groupsFor(AUTO_COLLIDER_DEFAULTS.layer))
        .setActiveEvents(this.RAPIER.ActiveEvents.COLLISION_EVENTS);
    }

    const rb = bodyEntity.getComponent?.("rigidbody");
    if (entity === bodyEntity) {
      // The label arms the zero-volume guard here too: a convex hull cannot be
      // built from coplanar points, but a very THIN one can still round to no
      // volume, and a dynamic body at mass 0 silently stops moving.
      applyColliderMass(
        rb,
        shapes.map(({ desc }) => desc),
        shapes.map(({ part }) => collisionMeshVolume(part)),
        entity.name,
      );
    }

    _pos.set(0, 0, 0);
    _quat.identity();
    if (entity !== bodyEntity) {
      _mat.copy(bodyEntity.object3D.matrixWorld).invert().multiply(entity.object3D.matrixWorld);
      const rel = new THREE.Vector3(), relQ = new THREE.Quaternion(), relS = new THREE.Vector3();
      _mat.decompose(rel, relQ, relS);
      _pos.copy(rel);
      _quat.copy(relQ);
    }
    if (![_pos.x, _pos.y, _pos.z, _quat.x, _quat.y, _quat.z, _quat.w].every(Number.isFinite)) {
      console.warn(`Automatic collider on "${entity.name}": collider pose is not finite`);
      return null;
    }
    return shapes.map(({ desc }) => desc
      .setTranslation(_pos.x, _pos.y, _pos.z)
      .setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }));
  }

  #colliderDesc(col, entity, bodyEntity) {
    const { RAPIER } = this;
    const {
      shape, size, radius, height, offset, rotation, autoCenter, autoFit,
      friction, restitution, isSensor,
    } = col.props;
    entity.object3D.getWorldScale(_scale);
    const sx = Math.abs(_scale.x), sy = Math.abs(_scale.y), sz = Math.abs(_scale.z);
    const maxS = Math.max(sx, sy, sz);
    const primitive = shape === "box" || shape === "sphere" || shape === "capsule";
    const fitBounds = primitive && (autoCenter || autoFit)
      ? collisionGeometryBounds(entity.object3D)
      : null;
    const fitSize = autoFit && fitBounds ? fitBounds.getSize(new THREE.Vector3()) : null;
    const bodyType = bodyEntity.getComponent?.("rigidbody")?.props?.bodyType ?? "fixed";
    // ── A DYNAMIC BODY KEEPS THE SHAPE IT WAS AUTHORED WITH (2026-09-07) ────
    //
    // `concave`, `mesh` and `custom` used to be silently downgraded to a
    // single convex hull on any dynamic body — which turns a boat hull into a
    // solid block, and a Custom collider is chosen precisely BECAUSE the
    // desired shape is not something a hull can express ("custom collision …
    // must be supported", 2026-09-07).
    //
    // The downgrade rested on a belief that is simply not true of the Rapier
    // build we ship: that a trimesh has no mass properties. Measured against
    // `@dimforge/rapier3d-compat` on 2026-09-07 — a closed unit-cube trimesh
    // on a dynamic body at density 500 weighs 500.0 with a cuboid's inertia
    // tensor, and it rests correctly on cuboid, convex-hull and trimesh
    // ground. See `applyColliderMass` for the full table.
    //
    // ⚠ THE REAL LIMITATION, which no shape substitution can hide, is that a
    // triangle mesh is a SURFACE with no interior. Two things follow, and both
    // were reproduced rather than assumed:
    //   · a small fast body crosses it in one step (a 0.05 m ball at 200 m/s
    //     went straight through; the same ball with CCD on stopped dead);
    //   · a body small enough to end up entirely INSIDE it generates no
    //     contact at all and falls out.
    // Those belong to the shape the author chose, so they are stated once,
    // with the remedy, instead of being "fixed" by quietly using a different
    // shape than the one on screen.
    //
    // `__physicsDynamicTrimesh = false` restores the old convex downgrade.
    const triangleShape = shape === "concave" || shape === "mesh" || shape === "custom";
    const dynamicTriangleMesh = bodyType === "dynamic" && triangleShape;
    const downgradeDynamic = dynamicTriangleMesh && globalThis.__physicsDynamicTrimesh === false;
    const runtimeShape = downgradeDynamic ? "convex" : shape;
    if (downgradeDynamic) {
      console.warn(
        `Collider on "${entity.name}": ${shape} collision downgraded to convex on a dynamic body ` +
          `(__physicsDynamicTrimesh = false).`,
      );
    } else if (dynamicTriangleMesh && !PhysicsSystem._dynamicTrimeshNoted) {
      PhysicsSystem._dynamicTrimeshNoted = true;
      console.log(
        `Collider on "${entity.name}": ${shape} collision on a dynamic body uses the exact triangles, and its ` +
          `mass comes from the volume they enclose. Note a triangle mesh has no interior: a small fast body can ` +
          `cross it in one step (enable CCD on its Rigidbody), and one small enough to fit inside it falls out.`,
      );
    }

    // ⚠ A TRIANGLE MESH IS NOT SOLID TO A POINT QUERY UNLESS IT IS `ORIENTED`.
    // Measured 2026-09-07: `collider.containsPoint` on a trimesh built without
    // the flag returns FALSE FOR EVERY POINT, inside or out — the flag is what
    // makes parry compute the vertex/edge pseudo-normals a containment test
    // needs. Buoyancy (`waterPhysics.js`) samples exactly that call to find how
    // much of a hull is under water, so a boat with a Custom collider would
    // float on nothing and sink without this. It is not free — the pseudo-normal
    // pass costs about 60 % on top of the build (11.4 → 18.5 ms for 28.8k
    // triangles) — so it is spent only where a point query can reach: buoyancy
    // skips every non-dynamic body, and so does this.
    const triFlags = dynamicTriangleMesh ? RAPIER.TriMeshFlags?.ORIENTED : undefined;

    let desc = null;
    let descs = null;
    let massWeights = null;
    if (runtimeShape === "box") {
      const fitted = fitSize
        ? [Math.max(fitSize.x, 0.001), Math.max(fitSize.y, 0.001), Math.max(fitSize.z, 0.001)]
        : size;
      const hx = (fitted?.[0] / 2) * sx, hy = (fitted?.[1] / 2) * sy, hz = (fitted?.[2] / 2) * sz;
      if (!this.#finiteDims(entity, "box", { "half-extent x": hx, "half-extent y": hy, "half-extent z": hz })) {
        return null;
      }
      desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    } else if (runtimeShape === "sphere") {
      const r = fitSize
        ? Math.hypot(fitSize.x * sx, fitSize.y * sy, fitSize.z * sz) / 2
        : radius * maxS;
      if (!this.#finiteDims(entity, "sphere", { radius: r })) return null;
      desc = RAPIER.ColliderDesc.ball(r);
    } else if (runtimeShape === "capsule") {
      const r = fitSize
        ? Math.max(fitSize.x * sx, fitSize.z * sz) / 2
        : radius * Math.max(sx, sz);
      const halfHeight = fitSize
        ? Math.max((fitSize.y * sy - r * 2) / 2, 0.0001)
        : (height / 2) * sy;
      if (!this.#finiteDims(entity, "capsule", { "half-height": halfHeight, radius: r })) return null;
      desc = RAPIER.ColliderDesc.capsule(halfHeight, r);
    } else if (runtimeShape === "convex") {
      const cooked = this.#getAutoGeometry(entity);
      if (shape === "custom" && !cooked) {
        // Never fall back to rendered meshes here: the whole point of a
        // Custom collider is a shape the render geometry does not have.
        console.warn(`Collider on "${entity.name}": custom geometry is missing or still loading`);
        return null;
      }
      // The SOURCE triangles the hulls stand in for, whichever path supplied
      // them — the hull-volume check below needs the thing being approximated,
      // and on a cold attach `cooked` is still null while the cook runs.
      const rendered = cooked ? null : collectCollisionMesh(entity.object3D, { includeSkinned: false });
      const convexSource = cooked?.concave ?? cooked ?? rendered;
      const hulls = cooked?.convexParts?.length
        ? cooked.convexParts.map((part) => scaleCollisionMesh(part, _scale))
        : cooked?.convex
          ? [scaleCollisionMesh(cooked.convex, _scale)]
          : [rendered].filter(Boolean);
      const shapes = hulls
        .map((hull) => ({
          hull,
          desc: RAPIER.ColliderDesc.convexHull(hull.vertices),
        }))
        .filter(({ desc }) => !!desc);
      descs = shapes.map(({ desc }) => desc);
      massWeights = shapes.map(({ hull }) => collisionMeshVolume(hull));
      // ⛔ MEASURED AFTER CREATION, NOT HERE. `massWeights` is the volume of
      // the SOURCE triangles, not of the hull Rapier builds from them — for
      // distributing mass across disconnected parts that is a fine proxy, and
      // for this check it is exactly the wrong number (it reported a ratio of
      // 1.00 on a mesh whose hull is four times its size). Rapier hands back
      // the real hull volume from `collider.volume()`, so the comparison waits
      // until the colliders exist.
      this._pendingHullCheck = { entityId: entity.id, name: entity.name,
        meshVolume: collisionMeshVolume(scaleCollisionMesh(convexSource, _scale)) };
      if (!descs.length) {
        console.warn(`Collider on "${entity.name}": convex shape found no geometry`);
        return null;
      }
    } else if (runtimeShape === "concave" || runtimeShape === "mesh") {
      const cooked = this.#getAutoGeometry(entity);
      const tri = cooked
        ? scaleCollisionMesh(runtimeShape === "concave" ? cooked.concave ?? cooked : cooked, _scale)
        : collectCollisionMesh(entity.object3D, { includeSkinned: false });
      if (!tri) {
        console.warn(`Collider on "${entity.name}": ${shape} shape found no geometry`);
        return null;
      }
      desc = RAPIER.ColliderDesc.trimesh(tri.vertices, tri.indices, triFlags);
      massWeights = [collisionMeshVolume(tri)];
    } else if (runtimeShape === "custom") {
      // Authored geometry at exact triangles — the user picked this asset for
      // its shape, so it is never simplified the way Concave is, and (since
      // 2026-09-07) never swapped for a convex hull on a dynamic body either.
      const cooked = this.#getAutoGeometry(entity);
      if (!cooked) {
        console.warn(`Collider on "${entity.name}": custom geometry is missing or still loading`);
        return null;
      }
      const tri = scaleCollisionMesh(cooked, _scale);
      if (!tri || !tri.vertices.every(Number.isFinite)) {
        console.warn(`Collider on "${entity.name}": custom geometry has no valid triangles`);
        return null;
      }
      desc = RAPIER.ColliderDesc.trimesh(tri.vertices, tri.indices, triFlags);
      massWeights = [collisionMeshVolume(tri)];
    } else if (runtimeShape === "heightfield") {
      const terrain = entity.getComponent("terrain");
      if (!terrain?.heightsArray) {
        console.warn(`Collider on "${entity.name}": heightfield shape requires a Terrain component`);
        return null;
      }
      desc = RAPIER.ColliderDesc.heightfield(
        terrain.resolution,
        terrain.resolution,
        toColumnMajor(terrain.heightsArray, terrain.resolution),
        { x: (terrain.props.size ?? 50) * sx, y: sy, z: (terrain.props.size ?? 50) * sz },
      );
    }
    const built = descs ?? (desc ? [desc] : []);
    if (!built.length) return null;

    for (const builtDesc of built) {
      builtDesc
        .setFriction(friction)
        .setRestitution(restitution)
        .setSensor(!!isSensor)
        .setCollisionGroups(this.layers.groupsFor(col.props.layer))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    }

    // A dynamic body's mass comes from its Rigidbody, not shape density.
    const rb = bodyEntity.getComponent("rigidbody");
    if (entity === bodyEntity) applyColliderMass(rb, built, massWeights, entity.name);

    // Collider pose relative to its body (child colliders + local offset).
    // Geometry-derived shapes already carry mesh offsets in their vertices;
    // primitive shapes can instead follow the rendered bounds automatically.
    _pos.fromArray(offset ?? [0, 0, 0]);
    if (autoCenter && (shape === "box" || shape === "sphere" || shape === "capsule")) {
      const center = fitBounds?.getCenter(new THREE.Vector3());
      if (center) _pos.add(center);
    }
    _pos.multiply(_scale);
    _colliderEuler.set(
      (rotation?.[0] ?? 0) * DEG2RAD,
      (rotation?.[1] ?? 0) * DEG2RAD,
      (rotation?.[2] ?? 0) * DEG2RAD,
    );
    _colliderRotation.setFromEuler(_colliderEuler);
    _quat.copy(_colliderRotation);
    if (entity !== bodyEntity) {
      _mat.copy(bodyEntity.object3D.matrixWorld).invert().multiply(entity.object3D.matrixWorld);
      const rel = new THREE.Vector3(), relQ = new THREE.Quaternion(), relS = new THREE.Vector3();
      _mat.decompose(rel, relQ, relS);
      _pos.applyQuaternion(relQ).add(rel);
      _quat.copy(relQ).multiply(_colliderRotation);
    }
    // Same reasoning as #finiteDims: a NaN pose panics the world just as surely
    // as a NaN extent, and `offset` is a vec3 prop like any other. Zero is a
    // legal translation, so this cannot go through #finiteDims' positive test.
    if (![_pos.x, _pos.y, _pos.z, _quat.x, _quat.y, _quat.z, _quat.w].every(Number.isFinite)) {
      console.error(
        `Collider on "${entity.name}": its pose is not finite (offset ${JSON.stringify(offset)}, ` +
          `world scale ${_scale.toArray().join(", ")}). Skipping this collider.`,
      );
      return null;
    }
    for (const builtDesc of built) {
      builtDesc
        .setTranslation(_pos.x, _pos.y, _pos.z)
        .setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
    }
    return built;
  }

  /** Builds a kinematic body + capsule + KinematicCharacterController for a
   *  character-controller entity, at its current world transform. */
  #buildCharacter(entity, cc) {
    const { RAPIER } = this;
    const p = cc.props;
    entity.object3D.getWorldPosition(_pos);
    entity.object3D.getWorldQuaternion(_quat);
    entity.object3D.getWorldScale(_scale);
    const sy = Math.abs(_scale.y);
    const sxz = Math.max(Math.abs(_scale.x), Math.abs(_scale.z));

    // Same non-finite guard as #colliderDesc, and for the same reason: a NaN
    // capsule panics Rapier inside `step`, and a wasm panic poisons the module
    // for the whole session rather than failing this one entity.
    const halfHeight = (p.height / 2) * sy, radius = p.radius * sxz;
    if (!this.#finiteDims(entity, "character capsule", { "half-height": halfHeight, radius })
      || ![_pos.x, _pos.y, _pos.z, ...(p.offset ?? [])].every(Number.isFinite)) {
      console.error(`Character controller on "${entity.name}" was not built — see above.`);
      return;
    }

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(_pos.x, _pos.y, _pos.z)
        .setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }),
    );

    const colDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius)
      .setTranslation(p.offset[0] * _scale.x, p.offset[1] * _scale.y, p.offset[2] * _scale.z)
      .setCollisionGroups(this.layers.groupsFor(p.layer));
    const collider = this.world.createCollider(colDesc, body);
    this.colliderEntity.set(collider.handle, entity);
    this.colliderLayer.set(collider.handle, this.layers.indexOf(p.layer));

    // Small skin gap keeps the capsule from snagging on the surfaces it slides
    // against; scaled with the body so it stays proportional.
    const controller = this.world.createCharacterController(Math.max(p.skinWidth, 0.001) * (sxz || 1));
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setMaxSlopeClimbAngle(p.slopeClimbAngle * DEG2RAD);
    controller.setMinSlopeSlideAngle(p.slopeSlideAngle * DEG2RAD);
    controller.setSlideEnabled(true);
    if (p.autostep) {
      controller.enableAutostep(p.autostepHeight * sy, p.autostepMinWidth * sxz, true);
    } else {
      controller.disableAutostep();
    }
    if (p.snapToGround) controller.enableSnapToGround(p.snapDistance * sy);
    else controller.disableSnapToGround();
    controller.setApplyImpulsesToDynamicBodies(!!p.pushDynamicBodies);

    cc.body = body;
    cc.collider = collider;
    cc.controller = controller;
    cc.grounded = false;
    // Retain the Rapier handles on the system entry too. Component teardown
    // deliberately clears its public handles, but the system still needs the
    // originals in order to remove them safely from the live world.
    this.characters.push({ entity, cc, body, collider, controller });
  }

  #removeCharacterEntry({ cc, body, collider, controller }) {
    if (collider) {
      this.#forgetColliderContacts(collider.handle);
      this.colliderEntity.delete(collider.handle);
      this.colliderLayer.delete(collider.handle);
    }
    if (this.world) {
      if (controller) this.world.removeCharacterController(controller);
      // Removing the rigid body also removes its attached capsule collider.
      if (body) this.world.removeRigidBody(body);
    }
    if (cc.body === body) cc.body = null;
    if (cc.collider === collider) cc.collider = null;
    if (cc.controller === controller) cc.controller = null;
    cc.grounded = false;
  }

  #teardown() {
    for (const { entity } of [...this.dynamicBodies, ...this.kinematicBodies]) {
      const rb = entity.getComponent("rigidbody");
      if (rb) rb.body = null;
    }
    for (const { cc } of this.characters) {
      cc.body = null;
      cc.collider = null;
      cc.controller = null;
      cc.grounded = false;
    }
    this.characters = [];
    for (const entity of this.colliderEntity.values()) {
      const col = entity.getComponent("collider");
      if (col) {
        col.collider = null;
        col.colliders = [];
      }
    }
    for (const { entity } of this.joints) {
      const comp = entity.getComponent("joint");
      if (comp) comp.joint = null;
    }
    this.joints = [];
    this.dynamicBodies = [];
    this.kinematicBodies = [];
    this.bodyByEntity.clear();
    this.dirty.clear();
    this.colliderEntity.clear();
    this.colliderLayer.clear();
    this.implicitColliderByEntity.clear();
    this.nativeContactPairs.clear();
    this.entityContactCounts.clear();
    this._deferredEvents = [];
    this.accumulator = 0;
    this.eventQueue?.free();
    this.eventQueue = null;
    this.world?.free();
    this.world = null;
  }

  // ---- per-frame stepping ----

  /**
   * Advances the world by `dt` seconds of GAME time (so pause and slow motion
   * reach physics). Public because a system's step is a legitimate thing for a
   * host to drive — the engine's update loop is just the usual caller.
   */
  update(dt) {
    if (!this.world || !this.engine.playing) return;

    // Entities that appeared or changed since the last step. The spawn path
    // flushes this itself; this is the safety net for everything else — an
    // additive scene loaded mid-game, a component added from the inspector
    // while playing, a script calling `addComponent` directly.
    this.#flushDirty();

    // Defensive reconciliation for component replacement/HMR and any caller
    // that cleared a component handle directly. Normally onDetach reaches
    // unregisterCharacter first; this closes the remaining stale-entry path.
    for (let i = this.characters.length - 1; i >= 0; i -= 1) {
      const entry = this.characters[i];
      const attached = entry.entity.getComponent("charactercontroller") === entry.cc;
      const handlesMatch = entry.cc.body === entry.body
        && entry.cc.collider === entry.collider
        && entry.cc.controller === entry.controller;
      if (attached && handlesMatch) continue;
      this.characters.splice(i, 1);
      this.#removeCharacterEntry(entry);
    }

    // Kinematic bodies follow their entity (scripts/animations drive them).
    if (this.kinematicBodies.length) this.engine.scene.updateMatrixWorld(true);
    for (const entry of this.kinematicBodies) {
      const { entity, body, prev } = entry;
      entity.object3D.getWorldPosition(_pos);
      entity.object3D.getWorldQuaternion(_quat);
      // How far the platform is about to move. A character standing on it adds
      // this to its own motion (see #stepCharacter) — without it, a moving
      // platform slides out from under the player, which is the single most
      // reported "my character controller is broken" symptom.
      entry.delta[0] = _pos.x - prev[0];
      entry.delta[1] = _pos.y - prev[1];
      entry.delta[2] = _pos.z - prev[2];
      prev[0] = _pos.x;
      prev[1] = _pos.y;
      prev[2] = _pos.z;
      body.setNextKinematicTranslation({ x: _pos.x, y: _pos.y, z: _pos.z });
      body.setNextKinematicRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
    }

    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * MAX_SUBSTEPS);
    let stepped = false;
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      this.world.timestep = FIXED_DT;
      // Resolve character motion before the step so the world advances the
      // kinematic bodies to their collision-free targets this substep.
      for (const entry of this.characters) this.#stepCharacter(entry, FIXED_DT);
      for (const water of this.engine.waterSurfaces ?? []) water.applyBuoyancy?.(this, FIXED_DT);
      this.world.step(this.eventQueue);
      stepped = true;
      this.#dispatchEvents();
    }
    if (!stepped) return;

    // Write dynamic body poses back to entities (world -> parent-local).
    for (const { entity, body } of this.dynamicBodies) {
      if (body.isSleeping()) continue;
      const t = body.translation();
      const r = body.rotation();
      const obj = entity.object3D;
      _pos.set(t.x, t.y, t.z);
      _quat.set(r.x, r.y, r.z, r.w);
      if (entity.parent) {
        entity.parent.object3D.updateWorldMatrix(true, false);
        obj.position.copy(_pos).applyMatrix4(_mat.copy(entity.parent.object3D.matrixWorld).invert());
        entity.parent.object3D.getWorldQuaternion(_parentQuat);
        obj.quaternion.copy(_parentQuat.invert().multiply(_quat));
      } else {
        obj.position.copy(_pos);
        obj.quaternion.copy(_quat);
      }
    }

    // Character controllers own position only — the entity keeps its own
    // rotation (scripts steer yaw directly on the transform).
    for (const { entity, cc, body } of this.characters) {
      const t = body.translation();
      _pos.set(t.x, t.y, t.z);
      const obj = entity.object3D;
      if (entity.parent) {
        entity.parent.object3D.updateWorldMatrix(true, false);
        obj.position.copy(_pos).applyMatrix4(_mat.copy(entity.parent.object3D.matrixWorld).invert());
      } else {
        obj.position.copy(_pos);
      }
    }
  }

  /** Integrates one character's velocity (with gravity) for a fixed step,
   *  resolves the move against the world, and queues the next kinematic pose. */
  #stepCharacter(entry, dt) {
    const { cc, body, collider, controller } = entry;
    const p = cc.props;
    const v = cc.velocity;
    if (p.applyGravity) v[1] += this.gravity[1] * (p.gravityScale ?? 1) * dt;

    // Carried motion from the platform the character stood on last step. One
    // step of lag is deliberate: the ground is only known *after* the solve,
    // and re-solving to remove the lag costs more than the half-frame of drift
    // it saves (invisible at 60 Hz).
    const carry = entry.platform?.delta;
    const t = body.translation();
    controller.computeColliderMovement(
      collider,
      {
        x: v[0] * dt + (carry?.[0] ?? 0),
        y: v[1] * dt + (carry?.[1] ?? 0),
        z: v[2] * dt + (carry?.[2] ?? 0),
      },
      // The controller sweeps its own query and does NOT inherit the capsule's
      // collision groups — without passing them it collides with every layer,
      // so a character on a layer excluded from Debris still bumped into it.
      undefined,
      this.layers.groupsFor(p.layer),
    );
    cc.grounded = controller.computedGrounded();
    // Zero out downward speed once grounded so gravity doesn't accumulate into
    // a huge value while standing still.
    if (cc.grounded && v[1] < 0) v[1] = 0;

    entry.platform = cc.grounded ? this.#groundPlatform(controller) : null;
    cc.platformEntity = entry.platform?.entity ?? null;

    const m = controller.computedMovement();
    body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
  }

  /**
   * The kinematic body the character is standing on, if any. Reads the
   * controller's own collision list rather than firing a second downward
   * query — it already knows exactly what it hit, and a separate raycast can
   * disagree with the solve at ledges.
   */
  #groundPlatform(controller) {
    const count = controller.numComputedCollisions?.() ?? 0;
    for (let i = 0; i < count; i++) {
      const hit = controller.computedCollision(i);
      const normal = hit?.normal1 ?? hit?.normal2;
      // Surfaces facing mostly upward are ground; a wall is not a platform.
      if (!normal || Math.abs(normal.y) < 0.5) continue;
      const handle = hit.collider?.handle ?? hit.colliderHandle;
      if (handle == null) continue;
      const entity = this.colliderEntity.get(handle);
      if (!entity) continue;
      const platform = this.kinematicBodies.find((k) => k.entity === entity);
      if (platform) return platform;
    }
    return null;
  }

  #drainEvents(into) {
    this.eventQueue.drainCollisionEvents((h1, h2, started) => into.push([h1, h2, started]));
  }

  #forgetColliderContacts(handle) {
    for (const [key, contact] of [...this.nativeContactPairs]) {
      if (contact.h1 !== handle && contact.h2 !== handle) continue;
      this.nativeContactPairs.delete(key);
      const count = this.entityContactCounts.get(contact.entityKey) ?? 0;
      if (count > 1) this.entityContactCounts.set(contact.entityKey, count - 1);
      else this.entityContactCounts.delete(contact.entityKey);
    }
    if (this._deferredEvents?.length) {
      this._deferredEvents = this._deferredEvents.filter(([h1, h2]) => h1 !== handle && h2 !== handle);
    }
  }

  #emitContact(a, b, sensor, started) {
    const hook = sensor
      ? (started ? "onTriggerEnter" : "onTriggerExit")
      : (started ? "onCollisionEnter" : "onCollisionExit");
    // `dispatch` reaches EVERY script on the entity, not just the first one.
    a.getComponent("script")?.dispatch(hook, b);
    b.getComponent("script")?.dispatch(hook, a);
    this.engine.emit(sensor ? "trigger" : "collision", { a, b, started });
  }

  #dispatchEvents() {
    const events = [];
    if (this._deferredEvents?.length) {
      events.push(...this._deferredEvents);
      this._deferredEvents.length = 0;
    }
    this.#drainEvents(events);
    for (const [h1, h2, started] of events) {
      const nativeKey = h1 < h2 ? `${h1}:${h2}` : `${h2}:${h1}`;
      if (started) {
        if (this.nativeContactPairs.has(nativeKey)) continue;
        const a = this.colliderEntity.get(h1);
        const b = this.colliderEntity.get(h2);
        if (!a || !b || a === b) continue;
        const sensor = !!(this.world.getCollider(h1)?.isSensor() || this.world.getCollider(h2)?.isSensor());
        const entityKey = a.id < b.id
          ? `${sensor ? "trigger" : "collision"}:${a.id}:${b.id}`
          : `${sensor ? "trigger" : "collision"}:${b.id}:${a.id}`;
        this.nativeContactPairs.set(nativeKey, { h1, h2, a, b, sensor, entityKey });
        const count = this.entityContactCounts.get(entityKey) ?? 0;
        this.entityContactCounts.set(entityKey, count + 1);
        if (count === 0) this.#emitContact(a, b, sensor, true);
        continue;
      }

      const contact = this.nativeContactPairs.get(nativeKey);
      if (!contact) continue;
      this.nativeContactPairs.delete(nativeKey);
      const count = this.entityContactCounts.get(contact.entityKey) ?? 0;
      if (count > 1) {
        this.entityContactCounts.set(contact.entityKey, count - 1);
        continue;
      }
      this.entityContactCounts.delete(contact.entityKey);
      this.#emitContact(contact.a, contact.b, contact.sensor, false);
    }
  }
}

function collisionMeshVolume({ vertices, indices }) {
  let sixVolume = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const ai = indices[i] * 3, bi = indices[i + 1] * 3, ci = indices[i + 2] * 3;
    const ax = vertices[ai], ay = vertices[ai + 1], az = vertices[ai + 2];
    const bx = vertices[bi], by = vertices[bi + 1], bz = vertices[bi + 2];
    const cx = vertices[ci], cy = vertices[ci + 1], cz = vertices[ci + 2];
    sixVolume += ax * (by * cz - bz * cy)
      + ay * (bz * cx - bx * cz)
      + az * (bx * cy - by * cx);
  }
  const volume = Math.abs(sixVolume) / 6;
  return Number.isFinite(volume) ? volume : 0;
}

/**
 * TerrainComponent.heightsArray is row-major over (z-row, x-col) — it comes
 * straight from PlaneGeometry's vertex order (see TerrainComponent's
 * #applyHeightsToGeometry). Rapier's ColliderDesc.heightfield wants the same
 * (row, col) samples in column-major order (nalgebra convention: index =
 * row + col * (nrows+1)) — this just transposes the storage, not the terrain.
 */
function toColumnMajor(heights, resolution) {
  const cols = resolution + 1;
  const out = new Float32Array(heights.length);
  for (let r = 0; r <= resolution; r++) {
    for (let c = 0; c <= resolution; c++) {
      out[r + c * cols] = heights[r * cols + c];
    }
  }
  return out;
}
