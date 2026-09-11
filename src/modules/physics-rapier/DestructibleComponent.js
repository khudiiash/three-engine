import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { BudgetedQueue } from "../../engine/scheduling.js";
import { physicsLayerNames } from "./layerConfig.js";
import { collectFractureSources, fractureSteps } from "./fracture.js";

/**
 * An object that breaks into pieces.
 *
 * Add it to anything with rendered geometry: the object is cut into Voronoi
 * fragments (see fracture.js), and when it breaks the intact mesh is swapped
 * for one dynamic rigid body per piece, thrown outward from the impact.
 *
 * ## The three ways to break
 *
 *   trigger = "impact"  — Rapier reports the CONTACT FORCE of each hit and the
 *                         object breaks when one exceeds `strength`. This is
 *                         the one that needs engine support: force reporting is
 *                         a per-collider opt-in (`PhysicsSystem.watchContactForce`)
 *                         because arming it scene-wide would put a force
 *                         accumulation on every crate resting on every floor.
 *   trigger = "event"   — breaks when a named event fires, on this entity or
 *                         globally. The explosion decides what breaks, not the
 *                         geometry: one `explode` event, ten walls listening.
 *   trigger = "manual"  — only `destructible.break()` from a script, an Events
 *                         action, or the Inspector's Break button.
 *
 * ## Why the fracture is baked before the break, and cached
 *
 * Cutting the pieces is CSG, which is milliseconds per piece — far too much to
 * spend in the frame something explodes, and the editor's standing rule is
 * that nothing blocks a frame (docs/ZERO_FREEZE_PLAN.md). So `prefracture`
 * (on by default) bakes the pieces in idle time as soon as the component is
 * attached, and the result is cached by geometry + settings so that a Play,
 * Stop, Play cycle re-uses one bake. The break itself is then only entity
 * creation. A break with no bake ready still works — it cuts on the spot and
 * says so once — because a piece of debris arriving late is worse than a
 * hitch.
 *
 * ## What happens to the original
 *
 * It is hidden and taken out of the physics world, not destroyed: `reset()`
 * puts it back, which is what lets a level restart, a checkpoint reload, or an
 * editor Stop return an intact wall. `props` never change when something
 * breaks, so nothing about a broken object is saved into the scene.
 */

/**
 * Baked fragments, keyed by entity + the settings that shaped them. Module
 * scope rather than the component, because `resetOnStop` detaches and
 * re-attaches this component on every Stop — a cache on the instance would
 * re-bake the whole scene's destructibles every time the user pressed Play.
 */
const bakeCache = new Map();
const BAKE_CACHE_MAX = 24;

function cacheKey(entity, props) {
  return `${entity.id}|${props.pieces}|${props.seed}|${props.pattern}`;
}

function cachePut(key, fragments) {
  bakeCache.set(key, fragments);
  while (bakeCache.size > BAKE_CACHE_MAX) {
    const oldest = bakeCache.keys().next().value;
    disposeFragments(bakeCache.get(oldest));
    bakeCache.delete(oldest);
  }
}

function disposeFragments(fragments) {
  for (const fragment of fragments ?? []) {
    for (const part of fragment.parts) part.geometry.dispose();
  }
}

/** Milliseconds of cutting before a bake hands the thread back. */
const BAKE_SLICE_MS = 8;

/** Idle-time bakes. Shared by every destructible so ten of them still yield. */
const bakeQueue = new BudgetedQueue({ sliceMs: 8, maxDelayMs: 400, name: "destructibleBake" });

/** Render components hidden while the object is in pieces. */
const RENDER_COMPONENTS = ["mesh", "model", "objModel", "skinnedmesh", "instancer", "splineMesh"];

const _matrix = new THREE.Matrix4();
const _parentInverse = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _velocity = new THREE.Vector3();

export class DestructibleComponent extends Component {
  static type = "destructible";
  static label = "Destructible";
  static tags = ["physics", "play-mode", "3d"];
  // Broken/intact is runtime state. A Stop has to arm the wall again, and the
  // debris is gone with the play session that made it.
  static resetOnStop = true;

  static defaults = {
    pieces: 12,
    pattern: "uniform",
    seed: 1,
    trigger: "impact",
    // Newtons. A 1 kg body at 10 m/s stopped in one 1/60 s step is ~600 N, so
    // the default breaks under a solid hit and survives being leaned on.
    strength: 600,
    breakEvent: "",
    // Metres per second, outward from the break point. Velocity rather than
    // impulse so a heavy piece and a light one from the same wall move
    // together, which is what an explosion looks like.
    scatter: 1.5,
    spin: 2,
    inheritVelocity: true,
    debrisLifetime: 8,
    debrisLayer: "Default",
    // kg for the whole object, split across the pieces by volume. 0 takes the
    // figure from the entity's own Rigidbody.
    debrisMass: 0,
    friction: 0.6,
    restitution: 0.1,
    prefracture: true,
    // Pieces are re-fractured when they break again, this many times over.
    // Off by default: a second break multiplies the body count.
    depth: 0,
  };

  static schema = [
    { key: "pieces", label: "Pieces", type: "number", min: 2, max: 128, step: 1 },
    { key: "pattern", label: "Pattern", type: "select", options: ["uniform", "impact"] },
    { key: "seed", label: "Seed", type: "number", min: 0, step: 1 },
    { key: "trigger", label: "Breaks On", type: "select", options: ["impact", "event", "manual"] },
    { key: "strength", label: "Strength (N)", type: "number", min: 1, step: 50, showIf: (p) => p.trigger === "impact" },
    { key: "breakEvent", label: "Event", type: "event", showIf: (p) => p.trigger === "event" },
    { key: "scatter", label: "Scatter (m/s)", type: "number", min: 0, step: 0.25 },
    { key: "spin", label: "Spin", type: "number", min: 0, step: 0.5 },
    { key: "inheritVelocity", label: "Inherit Velocity", type: "boolean" },
    { key: "debrisMass", label: "Debris Mass (kg)", type: "number", min: 0, step: 0.5 },
    { key: "debrisLayer", label: "Debris Layer", type: "select", options: physicsLayerNames },
    { key: "debrisLifetime", label: "Debris Lifetime (s)", type: "number", min: 0, step: 1 },
    { key: "friction", label: "Friction", type: "number", min: 0, max: 2, step: 0.05 },
    { key: "restitution", label: "Bounciness", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "depth", label: "Re-break Depth", type: "number", min: 0, max: 3, step: 1 },
    { key: "prefracture", label: "Bake Ahead", type: "boolean" },
  ];

  onAttach() {
    // ⚠ NOT `this.pieces`. Every authored prop is mirrored as an accessor on
    // the component (Component.installPropAccessors), so a field of the same
    // name as the `pieces` prop would route `this.pieces = []` straight into
    // `setProp("pieces", [])` and wipe the piece count.
    /** @type {any[]} Entities this component spawned; empty while intact. */
    this.debris = [];
    this.broken = false;
    this._baking = false;
    this._hidden = [];
    this._unsubs = [];
    this.#subscribe();
    this.#watchGeometry();
    // ⚠ STOPPING PLAY REBUILDS THE WALL, AND `resetOnStop` IS NOT ENOUGH TO
    // DO IT. That marker is honoured by the editor's scene reconcile, so a
    // host that simply calls `engine.setPlaying(false)` — a test, the player,
    // a game restarting its own level — never detaches this component and the
    // wall stays broken. Worse, hiding the source uses `setEnabledOverride`,
    // which is transient state the props snapshot does not restore: the wall
    // would come back invisible and non-colliding with an Inspector still
    // reading "enabled". Listening for the stop makes the promise in this
    // class's header true for every host.
    this._unsubPlay = this.entity.engine?.on?.("play-changed", (playing) => {
      if (!playing) this.reset();
    });
    if (this.props.prefracture) this.prefracture();
  }

  onDetach() {
    this.#unsubscribe();
    for (const unsub of this._unsubGeometry ?? []) unsub();
    this._unsubGeometry = [];
    this._unsubPlay?.();
    this._unsubPlay = null;
    // The debris belongs to this component: leaving it behind on a Stop or a
    // component removal is how a scene fills with rubble nothing owns.
    this.#destroyPieces();
    // ⚠ AND THE SOURCE HAS TO COME BACK. Hiding it is done with
    // `setEnabledOverride`, which is TRANSIENT state — it is deliberately not
    // in `props`, so leaving Play (which restores the scene from the props
    // snapshot) does NOT clear it. A wall broken during Play would come back
    // from Stop invisible and non-colliding, with an Inspector still reading
    // "enabled" for every component involved, and nothing but re-adding the
    // component to undo it.
    this.#showSource();
    this.broken = false;
  }

  onPropChanged(key) {
    // Deliberately NOT the base class's detach/attach: that would unsubscribe,
    // destroy the debris and re-bake on every keystroke in the Inspector.
    if (key === "pieces" || key === "seed" || key === "pattern") {
      this.#invalidateBake();
      if (this.props.prefracture) this.prefracture();
      return;
    }
    if (key === "prefracture" && this.props.prefracture) {
      this.prefracture();
      return;
    }
    if (key === "trigger" || key === "breakEvent" || key === "strength") {
      this.#unsubscribe();
      this.#subscribe();
    }
  }

  onDisable() {
    this.#unsubscribe();
  }

  onEnable() {
    this.#subscribe();
  }

  /**
   * Drops every listener and the force watch.
   *
   * ⚠ SUBSCRIBE AND UNSUBSCRIBE MUST BE SYMMETRIC. `onEnable` subscribes, so
   * an `onDisable` that dropped only the force watch left the event listener
   * behind: a disabled wall kept a live subscription (saved from acting on it
   * only by the handler's own `enabled` check — a second line of defence, not
   * a mechanism), and every off/on cycle added another one.
   */
  #unsubscribe() {
    for (const unsub of this._unsubs ?? []) unsub();
    this._unsubs = [];
    this.entity?.engine?.physics?.unwatchContactForce(this.entity);
  }

  #subscribe() {
    const engine = this.entity?.engine;
    if (!engine) return;
    const { trigger, breakEvent, strength } = this.props;

    if (trigger === "impact") {
      engine.physics?.watchContactForce(this.entity, Math.max(strength, 1));
      this._unsubs.push(engine.on("contact-force", ({ a, b, magnitude, point }) => {
        if (!engine.playing || this.broken || !this.enabled) return;
        if (a !== this.entity && b !== this.entity) return;
        if (magnitude < this.props.strength) return;
        this.break({ point, by: a === this.entity ? b : a });
      }));
      return;
    }

    engine.physics?.unwatchContactForce(this.entity);
    if (trigger !== "event" || !breakEvent) return;
    // Both scopes: an event declared `entity` is emitted on this entity, a
    // global one on the engine, and an author wiring "explode" should not have
    // to know which the catalog says before the wall reacts to it.
    const handler = (...args) => {
      if (!engine.playing || this.broken || !this.enabled) return;
      const point = Array.isArray(args[0]) && args[0].length === 3 ? args[0] : null;
      this.break({ point });
    };
    this._unsubs.push(engine.on(breakEvent, handler));
    this._unsubs.push(this.entity.on(breakEvent, handler));
  }

  /**
   * Throws the bake away when the thing being broken changes shape.
   *
   * The cache key is the entity plus the fracture settings, and neither says
   * anything about the GEOMETRY — so swapping a crate's mesh, or loading the
   * model the component was added to before it finished loading, would break
   * the new object into the old one's pieces. Subscribed for as long as the
   * component lives, since the swap can happen while it is disabled.
   */
  #watchGeometry() {
    const engine = this.entity?.engine;
    if (!engine) return;
    const invalidate = (info) => {
      if (info && info.entityId !== this.entity?.id) return;
      if (info && !["mesh", "model", "objModel", "skinnedmesh", "geometryModifiers"].includes(info.componentType)) return;
      if (info?.componentType === "mesh" && !["geometry", "geometryAsset"].includes(info.key)) return;
      this.#invalidateBake();
      if (this.props.prefracture && this.enabled) this.prefracture();
    };
    this._unsubGeometry = [
      engine.on("component-changed", invalidate),
      engine.on("model-loaded", (entity) => {
        if (entity === this.entity) invalidate(null);
      }),
    ];
  }

  #invalidateBake() {
    const key = cacheKey(this.entity, this.props);
    disposeFragments(bakeCache.get(key));
    bakeCache.delete(key);
    this._fragments = null;
  }

  /* ---- baking ------------------------------------------------------------ */

  /** Whether the pieces are already cut, i.e. whether a break will hitch. */
  isBaked() {
    return !!bakeCache.get(cacheKey(this.entity, this.props))?.length;
  }

  /**
   * Cuts the pieces now (in idle slices) so the break itself is free.
   *
   * Safe to call repeatedly — a cached bake returns immediately, and a bake
   * already running is not started twice. Returns the piece count.
   */
  async prefracture() {
    const cached = bakeCache.get(cacheKey(this.entity, this.props));
    if (cached) return cached.length;
    if (this._baking) return this._baking;
    this._baking = new Promise((resolve) => {
      bakeQueue.push(async () => {
        const fragments = await this.#bake();
        this._baking = false;
        resolve(fragments.length);
      }, `destructible:${this.entity?.id}`);
    });
    return this._baking;
  }

  /**
   * The bake itself: one piece per turn of the loop, yielding to the host
   * between them. `focus` shapes an "impact" pattern around a hit point.
   */
  async #bake(focus = null) {
    const entity = this.entity;
    if (!entity) return [];
    entity.object3D.updateMatrixWorld(true);
    const sources = collectFractureSources(entity.object3D, entity.id);
    if (!sources.length) {
      console.warn(`Destructible on "${entity.name}": nothing to fracture — the entity has no rendered mesh of its own.`);
      return [];
    }
    const fragments = [];
    let sliceStart = performance.now();
    for (const fragment of fractureSteps(sources, {
      pieces: this.props.pieces,
      seed: this.props.seed,
      pattern: this.props.pattern,
      focus,
    })) {
      fragments.push(fragment);
      if (performance.now() - sliceStart < BAKE_SLICE_MS) continue;
      // A macrotask, not a microtask: a microtask queue drains before the
      // browser gets the thread back, so awaiting one would spread the bake
      // over nothing at all and still block the frame.
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
      // Detached mid-bake (the entity was deleted, or Play stopped) — stop
      // cutting pieces for something that is no longer there.
      if (this._attached === false) break;
    }
    for (const source of sources) source.geometry.dispose();
    if (!focus) cachePut(cacheKey(entity, this.props), fragments);
    this._fragments = fragments;
    return fragments;
  }

  /** The baked pieces, cutting them synchronously if the bake never ran. */
  #fragmentsNow(focus) {
    const key = cacheKey(this.entity, this.props);
    const cached = bakeCache.get(key);
    // A cached bake serves every break except an impact-shaped one, whose
    // cells are clustered around a hit point this one did not know about.
    if (cached?.length && !(focus && this.props.pattern === "impact")) return cached;
    this.entity.object3D.updateMatrixWorld(true);
    const sources = collectFractureSources(this.entity.object3D, this.entity.id);
    if (!sources.length) return [];
    if (!cached && this.props.prefracture) {
      console.warn(
        `Destructible on "${this.entity.name}": broke before its fracture was baked, so the pieces were cut ` +
          "inside the frame. Call prefracture() (or leave Bake Ahead on and give it a moment) to avoid the hitch.",
      );
    }
    const fragments = [...fractureSteps(sources, {
      pieces: this.props.pieces,
      seed: this.props.seed,
      pattern: this.props.pattern,
      focus,
    })];
    for (const source of sources) source.geometry.dispose();
    // An impact-shaped cut belongs to the hit that caused it, not to the
    // object, so it is never cached under the object's key.
    if (this.props.pattern !== "impact") cachePut(key, fragments);
    return fragments;
  }

  /* ---- breaking ---------------------------------------------------------- */

  /**
   * Breaks the object now.
   *
   *     this.entity.getComponent("destructible").break();
   *     destructible.break({ point: [x, y, z], scatter: 6 });
   *
   * @param {object} [options]
   * @param {number[]} [options.point] World-space origin of the break.
   * @param {number} [options.scatter] Overrides the authored outward speed.
   * @param {any} [options.by] The entity that caused it, passed to `onBreak`.
   * @returns {boolean} False when it was already broken or has no pieces.
   */
  break({ point = null, scatter = this.props.scatter, by = null } = {}) {
    const engine = this.entity?.engine;
    if (!engine || this.broken) return false;
    const world = this.entity.object3D;
    world.updateMatrixWorld(true);

    // The impact pattern needs the hit in the object's own frame.
    let focus = null;
    if (this.props.pattern === "impact" && point) {
      focus = new THREE.Vector3(point[0], point[1], point[2])
        .applyMatrix4(_matrix.copy(world.matrixWorld).invert());
    }
    const fragments = this.#fragmentsNow(focus);
    if (!fragments.length) {
      console.warn(`Destructible on "${this.entity.name}": no pieces to break into.`);
      return false;
    }

    const origin = point
      ? new THREE.Vector3(point[0], point[1], point[2])
      : world.getWorldPosition(new THREE.Vector3());
    const inherited = this.props.inheritVelocity
      ? this.entity.getComponent("rigidbody")?.getLinearVelocity?.() ?? [0, 0, 0]
      : [0, 0, 0];

    this.broken = true;
    this.#hideSource();
    // The mass shares are computed BEFORE the pieces exist, because a piece's
    // mass has to go on its Rigidbody: `applyColliderMass` puts an authored
    // figure on the collider DESCRIPTOR, which is the only place Rapier will
    // take it. Adding it afterwards leaves the shape's own density-derived
    // mass underneath, and the debris comes out heavier than the wall was.
    const totalMass = this.#debrisMass();
    const totalVolume = fragments.reduce((sum, fragment) => sum + fragment.volume, 0) || 1;
    this.debris = fragments.map((fragment, index) => this.#spawnPiece(
      fragment,
      index,
      totalMass > 0 ? Math.max((fragment.volume / totalVolume) * totalMass, 0.01) : 0,
    ));
    // Build the bodies before touching them: the pieces' components marked
    // themselves dirty, and a velocity written to a null body is silently lost.
    engine.physics?.sync();

    for (let i = 0; i < this.debris.length; i++) {
      const piece = this.debris[i];
      const rigidbody = piece.getComponent("rigidbody");
      if (!rigidbody?.body) continue;
      piece.object3D.getWorldPosition(_position);
      _velocity.subVectors(_position, origin);
      if (_velocity.lengthSq() < 1e-8) _velocity.set(0, 1, 0);
      _velocity.normalize().multiplyScalar(scatter);
      rigidbody.setLinearVelocity([
        _velocity.x + inherited[0],
        _velocity.y + inherited[1],
        _velocity.z + inherited[2],
      ]);
      if (this.props.spin > 0) {
        const spin = this.props.spin;
        rigidbody.setAngularVelocity([
          (Math.random() * 2 - 1) * spin,
          (Math.random() * 2 - 1) * spin,
          (Math.random() * 2 - 1) * spin,
        ]);
      }
      if (this.props.debrisLifetime > 0) engine.despawn(piece, this.props.debrisLifetime);
    }

    this.entity.getComponent("script")?.dispatch("onBreak", { point: origin.toArray(), by, pieces: this.debris.length });
    this.entity.emit?.("broken", this.debris.length);
    engine.emit("destructible-broken", { entity: this.entity, pieces: this.debris.length, point: origin.toArray() });
    return true;
  }

  /** Puts the object back together — the debris goes, the original returns. */
  reset() {
    if (!this.broken) return false;
    this.#destroyPieces();
    this.#showSource();
    this.broken = false;
    return true;
  }

  /** kg for the whole object: the authored figure, or its Rigidbody's. */
  #debrisMass() {
    if (this.props.debrisMass > 0) return this.props.debrisMass;
    const rigidbody = this.entity.getComponent("rigidbody");
    if (!rigidbody || rigidbody.props.massMode === "density") return 0; // Rapier derives it
    return rigidbody.props.mass ?? 0;
  }

  #spawnPiece(fragment, index, mass) {
    const engine = this.entity.engine;
    const parent = this.entity.parent ?? null;
    const piece = engine.createEntity({ name: `${this.entity.name} Piece ${index + 1}`, parent });

    // World pose of the piece = the source's, offset by where the piece sat
    // inside it. Converted back to the parent's space so the entity's own
    // transform is what the editor and the serializer expect.
    _matrix.copy(this.entity.object3D.matrixWorld)
      .multiply(new THREE.Matrix4().makeTranslation(fragment.offset.x, fragment.offset.y, fragment.offset.z));
    if (parent) {
      parent.object3D.updateWorldMatrix(true, false);
      _matrix.premultiply(_parentInverse.copy(parent.object3D.matrixWorld).invert());
    }
    _matrix.decompose(_position, _quaternion, _scale);
    piece.object3D.position.copy(_position);
    piece.object3D.quaternion.copy(_quaternion);
    piece.object3D.scale.copy(_scale);
    piece.object3D.updateMatrixWorld(true);

    for (const part of fragment.parts) {
      const mesh = new THREE.Mesh(part.geometry, part.material ?? undefined);
      // Provenance, exactly as an imported model's submeshes carry it: it is
      // what makes the collision cook and the viewport picker treat these
      // meshes as belonging to this entity.
      mesh.userData.entityId = piece.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      piece.object3D.add(mesh);
    }

    const density = this.entity.getComponent("rigidbody")?.props;
    piece.addComponent("rigidbody", {
      bodyType: "dynamic",
      // With no figure to split (the source weighs itself by density, or has
      // no Rigidbody at all), the piece inherits the density and Rapier
      // derives its mass from the shape — which is the scale-free answer.
      ...(mass > 0
        ? { massMode: "mass", mass }
        : { massMode: "density", density: density?.density ?? 1.2 }),
      angularDamping: 0.2,
      ccd: false,
    });
    // Convex: a fragment IS a convex cell of the original (intersected with
    // it), so a hull is the exact shape rather than an approximation of it —
    // and it is the only shape Rapier treats as solid on a moving body.
    piece.addComponent("collider", {
      shape: "convex",
      layer: this.props.debrisLayer,
      friction: this.props.friction,
      restitution: this.props.restitution,
    });
    if (this.props.depth > 0) {
      piece.addComponent("destructible", {
        ...this.props,
        pieces: Math.max(3, Math.round(this.props.pieces / 2)),
        depth: this.props.depth - 1,
        seed: this.props.seed + index + 1,
        prefracture: false,
      });
    }
    return piece;
  }

  #destroyPieces() {
    const engine = this.entity?.engine;
    for (const piece of this.debris ?? []) {
      // The geometry is owned by the bake cache and shared with the next
      // break, so only the entity goes.
      if (engine?.entities.has(piece.id)) engine.destroyEntity(piece);
    }
    this.debris = [];
  }

  #hideSource() {
    this._hidden = [];
    for (const type of RENDER_COMPONENTS) {
      const component = this.entity.getComponent(type);
      if (!component || !component.enabled) continue;
      component.setEnabledOverride(false);
      this._hidden.push(component);
    }
    // The collider AND the body: an override on the collider alone leaves a
    // rigidbody behind, and the next dirty flush (which disabling the collider
    // itself queues) would rebuild the wall's body under the debris.
    for (const type of ["collider", "rigidbody"]) {
      const component = this.entity.getComponent(type);
      if (!component?.enabled) continue;
      component.setEnabledOverride(false);
      this._hidden.push(component);
    }
    // Out of the world in the same frame: a wall whose pieces have spawned
    // must stop stopping bullets, and the collider's override alone would not
    // take effect until something rebuilt it.
    this.entity.engine?.physics?.removeEntity(this.entity, { subtree: false });
  }

  #showSource() {
    for (const component of this._hidden) component.setEnabledOverride(null);
    this._hidden = [];
    this.entity.engine?.physics?.addEntity(this.entity);
  }
}
