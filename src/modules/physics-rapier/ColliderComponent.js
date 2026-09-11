import * as THREE from "three/webgpu";
import { Component } from "../../engine/components/Component.js";
import { PHYSICS_DEBUG_LAYER } from "../../engine/editorLayers.js";
import { physicsLayerNames } from "./layerConfig.js";
import { collisionGeometryBounds } from "./collisionGeometry.js";
import { acquireGeometryAsset, releaseGeometryAsset } from "../../engine/geometryAsset.js";
import { BudgetedQueue } from "../../engine/scheduling.js";
import { freeze } from "../../engine/freezeLedger.js";

const GIZMO_COLOR = 0x2df098;
const DEG2RAD = Math.PI / 180;
/** Shapes whose preview is the cooked collision geometry rather than a gizmo. */
const GEOMETRY_SHAPES = ["convex", "concave", "mesh", "custom"];

/**
 * ⭐ THE 10-SECOND CLICK (docs/ZERO_FREEZE_PLAN.md §2.3, Stage 5.2).
 *
 * `#buildOutline` ran on the CLICK'S OWN STACK, from scratch, on every
 * selection change: `ViewportPanel.setCollidersVisible` walks every entity on
 * every selection change and hands the selected one `setDebugVisible(true,
 * true)`, and `#disposeOutline` had already thrown the previous build away.
 * The build itself is a synchronous `THREE.EdgesGeometry` over the cooked
 * collision surface — on a `mesh` collider that is EVERY SOURCE TRIANGLE of
 * the model — plus, on the convex path, a per-float `Array.push` into a plain
 * JS array. The Colliders layer is on by default in this project, so a model
 * with an enabled concave/mesh collider paid that on every click, and paid it
 * again on the click that deselected it.
 *
 * Three things make it free, in order of how much they pay:
 *
 *   1. NOT ON THE CLICK'S STACK. The build is queued and drains in idle time
 *      (or at `maxDelayMs`, so it cannot starve behind a busy editor). The
 *      click itself now does a Map lookup and, on a miss, a queue push. A
 *      build whose request was withdrawn before it drained — the usual case
 *      when someone arrows down the hierarchy — never runs at all.
 *   2. CACHED. The cooked geometry object is replaced wholesale by every
 *      re-cook (`PhysicsSystem.autoCollisionGeometry`), so its identity is an
 *      exact revision key: re-selecting the same entity reuses the geometry
 *      instead of extracting the same edges again. The collider's local pose
 *      is NOT part of the key — `#placeOutline` puts it on the LineSegments,
 *      never into the vertices — so moving a collider does not invalidate it.
 *   3. BOUNDED. Past OUTLINE_TRIANGLE_BUDGET the edge extraction is replaced
 *      by the cooked surface's bounding-box wireframe. An outline that dense
 *      is a green smear on screen anyway; what it is not is worth a
 *      multi-second block.
 *
 * Hatch: `globalThis.__editorColliderOutlineAsync = false` restores the
 * synchronous, uncached build.
 */
const OUTLINE_TRIANGLE_BUDGET = 150_000;

/** Cached edge geometries, newest last. Bounded so a scene walk cannot grow it. */
const OUTLINE_CACHE_MAX = 32;
const outlineCache = new Map();

/** Stable ids for cooked-geometry objects, so a cache key can be a string. */
const cookedIds = new WeakMap();
let nextCookedId = 1;
function cookedRevision(cooked) {
  if (!cooked || typeof cooked !== "object") return "none";
  let id = cookedIds.get(cooked);
  if (id === undefined) cookedIds.set(cooked, (id = nextCookedId++));
  return id;
}

function cacheGet(key) {
  const hit = outlineCache.get(key);
  if (hit === undefined) return null;
  // Re-insert so the eviction order is least-recently-USED, not oldest-built:
  // a Map iterates in insertion order, and delete+set is how you move an entry
  // to the back of one.
  outlineCache.delete(key);
  outlineCache.set(key, hit);
  return hit;
}

/**
 * ⚠ AN EVICTED GEOMETRY MAY STILL BE ON SCREEN. Play mode requests an outline
 * for EVERY collider, so the cache overflows with live entries in it —
 * `dispose()` on one of those frees the GPU buffers of a LineSegments the
 * renderer draws next frame, which in WebGPU is a destroyed-resource error and
 * (this project has been here before, see [[playstop-device-destroy]]) a lost
 * device. So the cache refcounts: eviction marks, and the last outline to let
 * go is what actually disposes.
 */
function cachePut(key, geometry) {
  outlineCache.set(key, geometry);
  while (outlineCache.size > OUTLINE_CACHE_MAX) {
    const oldest = outlineCache.keys().next().value;
    const evicted = outlineCache.get(oldest);
    outlineCache.delete(oldest);
    if (!evicted) continue;
    evicted.userData.outlineEvicted = true;
    if (!(evicted.userData.outlineRefs > 0)) evicted.dispose();
  }
}

/**
 * Drains in the host's idle time, or at 120 ms, whichever comes first — the
 * outline has to look instant, and it must never be inside the click.
 */
const outlineQueue = new BudgetedQueue({ sliceMs: 6, maxDelayMs: 120, name: "colliderOutline" });

/**
 * Collision shape. Pairs with a Rigidbody on the same entity (or the nearest
 * ancestor Rigidbody — child colliders form a compound body). A collider with
 * no Rigidbody anywhere above it becomes static level geometry.
 *
 * `shape: "convex"` builds a solid convex hull from rendered geometry.
 * `shape: "concave"` builds a reduced triangle surface, while `shape: "mesh"`
 * preserves every source triangle. Both triangle shapes work on a DYNAMIC body
 * too (since 2026-09-07 — Rapier reads their mass from the volume the
 * triangles enclose), but they are surfaces with no interior: a small fast
 * body can cross one in a single step unless its Rigidbody has CCD on, and one
 * small enough to fit inside generates no contact at all.
 * `shape: "heightfield"` reads the entity's sibling Terrain component
 * (resolution/heights/size) and builds a Rapier heightfield — requires a
 * Terrain component on the same entity (static/kinematic use only).
 * `shape: "custom"` builds from an authored `.geom` asset picked in the
 * Inspector instead of the entity's rendered meshes — the collision shape no
 * longer has to match what is drawn (a low-poly proxy under a dense render
 * mesh, or a collider on an entity with no mesh at all).
 * Convex, Concave, Mesh and Custom build on-demand outlines from their cooked
 * collision geometry: selection-only in Edit, or for every collider when
 * enabled in Play.
 */
/**
 * Below this many cooked triangles the edge extraction is under a millisecond,
 * and deferring it costs more than it saves.
 *
 * ⚠ THE DEFERRAL IS NOT FREE, AND TWO GATES SAID SO. Queueing EVERY outline
 * broke `run-physics-test`'s "the convex preview draws every cooked
 * disconnected hull" and "a disabled geometry collider remembers its requested
 * preview": both select and then assert the outline exists, which is the
 * contract a person also relies on — a collider you select should be outlined
 * in the frame you selected it, not the frame after. The freeze this whole
 * unit exists to remove is a HEAVY extraction (a cooked model of hundreds of
 * thousands of triangles), so the split is by size: small ones stay
 * synchronous and keep the contract, big ones queue and cost the click
 * nothing. `__editorColliderOutlineSyncBelow` moves the line; 0 defers
 * everything (the behaviour the gates rejected).
 */
const OUTLINE_SYNC_TRIANGLE_LIMIT = 20_000;

/** Cooked triangles this shape would have to trace, for the sync/defer split. */
function cookedTriangleCount(cooked, shape) {
  if (!cooked) return 0;
  if (shape === "convex") {
    const hulls = cooked.convexParts?.length ? cooked.convexParts : cooked.convex ? [cooked.convex] : [];
    let triangles = 0;
    for (const hull of hulls) triangles += (hull?.indices?.length ?? 0) / 3;
    return triangles;
  }
  const surface = shape === "concave" ? cooked.concave : cooked;
  return (surface?.indices?.length ?? 0) / 3;
}

export class ColliderComponent extends Component {
  static type = "collider";
  static label = "Collider";
  static tags = ["physics", "play-mode", "3d"];
  static defaults = {
    shape: "box",
    size: [1, 1, 1],
    radius: 0.5,
    height: 1,
    // `.geom` asset path for shape "custom". Empty elsewhere.
    geometryAsset: "",
    offset: [0, 0, 0],
    rotation: [0, 0, 0],
    autoFit: true,
    autoCenter: true,
    // True only for the visible default inserted by PhysicsSystem.
    autoGenerated: false,
    // Becomes true after the user edits a generated default. Provenance stays
    // intact so collision still collects only geometry owned by this entity.
    autoCustomized: false,
    friction: 0.5,
    restitution: 0,
    isSensor: false,
    // Which collision layer this collider is on. The project's layer matrix
    // (Project Settings → Physics) decides which layers actually interact —
    // that is how a projectile stops hitting the player who fired it.
    layer: "Default",
  };
  static schema = [
    { key: "shape", label: "Shape", type: "select", options: ["box", "sphere", "capsule", "convex", "concave", "mesh", "custom", "heightfield"] },
    { key: "geometryAsset", label: "Geometry", type: "asset", exts: ["geom"], showIf: (p) => p.shape === "custom" },
    { key: "layer", label: "Layer", type: "select", options: physicsLayerNames },
    { key: "autoFit", label: "Fit to Mesh", type: "boolean", showIf: (p) => p.shape === "box" || p.shape === "sphere" || p.shape === "capsule" },
    { key: "size", label: "Size", type: "vec3", showIf: (p) => p.shape === "box" && !p.autoFit },
    { key: "radius", label: "Radius", type: "number", min: 0.01, step: 0.05, showIf: (p) => (p.shape === "sphere" || p.shape === "capsule") && !p.autoFit },
    { key: "height", label: "Height", type: "number", min: 0.01, step: 0.05, showIf: (p) => p.shape === "capsule" && !p.autoFit },
    { key: "offset", label: "Offset", type: "vec3" },
    { key: "rotation", label: "Rotation", type: "vec3" },
    { key: "autoCenter", label: "Auto Center", type: "boolean", showIf: (p) => p.shape === "box" || p.shape === "sphere" || p.shape === "capsule" },
    { key: "friction", label: "Friction", type: "number", min: 0, max: 2, step: 0.05 },
    { key: "restitution", label: "Bounciness", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "isSensor", label: "Is Trigger", type: "boolean" },
  ];

  onAttach() {
    this._outlineRequested ??= false;
    this._debugGizmoRequested ??= true;
    // A queued outline build is withdrawn by bumping the generation; see
    // `#buildOutline` and the OUTLINE_TRIANGLE_BUDGET header.
    this._outlinePending = false;
    this._outlineGeneration = (this._outlineGeneration ?? 0) + 1;
    this.collider = null; // assigned by PhysicsSystem while playing
    this.colliders = [];
    // Shared `.geom` instance for shape "custom", loaded below and read by
    // PhysicsSystem when it cooks. Refcounted — release, never dispose.
    this.geometry = null;
    this._customGeometryGeneration = 0;
    // See RigidbodyComponent.onAttach: entities arrive after the world is
    // built, and nothing else tells the world they did.
    this.entity.engine?.physics?.markDirty(this.entity, { subtree: false });
    this.#buildGizmo();
    // Heightfield gizmo mirrors the sibling terrain's surface — rebuild it
    // whenever that terrain's heights (or size/resolution) change so the
    // collision preview keeps matching what the user just sculpted.
    if (this.props.shape === "heightfield") {
      this._terrainUnsub = this.entity.engine?.on?.("component-changed", (info) => {
        if (info?.entityId === this.entity.id && info?.componentType === "terrain") this.#rebuildGizmo();
      });
    }
    this._geometryUnsub = this.entity.engine?.on?.("component-changed", (info) => {
      const fittedPrimitive = (this.props.autoCenter || this.props.autoFit)
        && ["box", "sphere", "capsule"].includes(this.props.shape);
      if (fittedPrimitive && info?.entityId === this.entity.id && info?.componentType === "mesh") this.#rebuildGizmo();
    });
    this._modelUnsub = this.entity.engine?.on?.("model-loaded", (entity) => {
      const fittedPrimitive = (this.props.autoCenter || this.props.autoFit)
        && ["box", "sphere", "capsule"].includes(this.props.shape);
      if (fittedPrimitive && entity === this.entity) this.#rebuildGizmo();
    });
    this._cookUnsub = this.entity.engine?.on?.("physics-collider-cooked", (entity) => {
      if (entity !== this.entity || !this._outlineRequested
        || !GEOMETRY_SHAPES.includes(this.props.shape)) return;
      this.#disposeOutline();
      this.#buildOutline();
    });
    // A custom collider's `.geom` arrives asynchronously; the cook and the
    // outline both (re)run when it lands (see #loadCustomGeometry).
    if (this.props.shape === "custom" && this.props.geometryAsset) {
      this.#loadCustomGeometry(this.props.geometryAsset);
    }
  }

  onDetach() {
    const physics = this.entity.engine?.physics;
    // Before clearing the handle — that is what the world removes it by.
    physics?.removeEntity(this.entity, { subtree: false });
    physics?.markDirty(this.entity, { subtree: false });
    this.collider = null;
    this.colliders = [];
    this._terrainUnsub?.();
    this._terrainUnsub = null;
    this._geometryUnsub?.();
    this._geometryUnsub = null;
    this._modelUnsub?.();
    this._modelUnsub = null;
    this._cookUnsub?.();
    this._cookUnsub = null;
    this.#releaseCustomGeometry();
    this.#disposeGizmo();
    this.#disposeOutline();
  }

  onDisable() {
    if (this.gizmo) this.gizmo.visible = false;
    if (this.outline) this.outline.visible = false;
    const physics = this.entity.engine?.physics;
    physics?.removeEntity(this.entity, { subtree: false });
    physics?.markDirty(this.entity, { subtree: false });
    physics?.invalidateAutoCollider(this.entity);
  }

  onEnable() {
    if (this.gizmo) this.gizmo.visible = this._debugGizmoRequested;
    if (this._outlineRequested) {
      if (this.outline) this.outline.visible = true;
      else this.#buildOutline();
    }
    const physics = this.entity.engine?.physics;
    physics?.invalidateAutoCollider(this.entity);
    physics?.markDirty(this.entity, { subtree: false });
  }

  /**
   * Switching a generated default ON is authoring it (2026-09-02: defaults
   * attach disabled). The automatic pass reaps UNTOUCHED defaults — when a
   * model reloads, or a skin is detected — and would otherwise re-attach the
   * user's enabled collider as a disabled one.
   */
  setEnabled(value) {
    const changed = super.setEnabled(value);
    if (changed && value !== false && this.props.autoGenerated) this.props.autoCustomized = true;
    return changed;
  }

  onPropChanged(key) {
    if (key !== "autoGenerated" && key !== "autoCustomized") this.props.autoCustomized = true;
    // The base implementation detaches and re-attaches, which rebuilds the
    // gizmo for the new shape and (re)loads a custom collider's asset — so a
    // shape switch cannot leave the previous shape's preview behind.
    super.onPropChanged(key, this.props[key]);
    if (this._outlineRequested) {
      this.#disposeOutline();
      this.#buildOutline();
    }
  }

  #rebuildGizmo() {
    this.#disposeGizmo();
    this.#buildGizmo();
  }

  #buildGizmo() {
    const { shape, size, radius, height, offset, rotation, autoCenter, autoFit } = this.props;
    const bounds = (autoCenter || autoFit) && (shape === "box" || shape === "sphere" || shape === "capsule")
      ? collisionGeometryBounds(this.entity.object3D)
      : null;
    const fitSize = autoFit && bounds ? bounds.getSize(new THREE.Vector3()) : null;
    let geometry = null;
    if (shape === "box") {
      const boxSize = fitSize
        ? [Math.max(fitSize.x, 0.001), Math.max(fitSize.y, 0.001), Math.max(fitSize.z, 0.001)]
        : size;
      geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(boxSize[0], boxSize[1], boxSize[2]));
    } else if (shape === "sphere") {
      const fittedRadius = fitSize ? fitSize.length() / 2 : radius;
      geometry = new THREE.WireframeGeometry(new THREE.SphereGeometry(fittedRadius, 12, 8));
    } else if (shape === "capsule") {
      const fittedRadius = fitSize ? Math.max(fitSize.x, fitSize.z) / 2 : radius;
      const fittedHeight = fitSize ? Math.max(fitSize.y - fittedRadius * 2, 0.01) : height;
      geometry = new THREE.WireframeGeometry(new THREE.CapsuleGeometry(fittedRadius, fittedHeight, 4, 8));
    } else if (shape === "heightfield") {
      geometry = buildHeightfieldWireframe(this.entity);
    }
    if (!geometry) return; // geometry-derived shape: the viewport requests its cooked outline on demand

    this.gizmo = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: GIZMO_COLOR, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    this.gizmo.position.fromArray(offset);
    if (autoCenter && (shape === "box" || shape === "sphere" || shape === "capsule")) {
      const center = bounds?.getCenter(new THREE.Vector3());
      if (center) this.gizmo.position.add(center);
    }
    this.gizmo.rotation.set(
      (rotation?.[0] ?? 0) * DEG2RAD,
      (rotation?.[1] ?? 0) * DEG2RAD,
      (rotation?.[2] ?? 0) * DEG2RAD,
    );
    // Defer to scene depth so the wireframe hides behind walls instead of
    // painting over them; the previous `depthTest: false` made colliders
    // look like they sit in front of every solid object in the scene.
    this.gizmo.renderOrder = 1;
    this.gizmo.visible = this.enabled && this._debugGizmoRequested;
    this.gizmo.layers.set(PHYSICS_DEBUG_LAYER);
    this.gizmo.userData.engineOwned = true;
    this.gizmo.userData.editorOnly = true;
    this.gizmo.raycast = () => {}; // never intercept viewport picking
    this.entity.object3D.add(this.gizmo);
  }

  #disposeGizmo() {
    if (!this.gizmo) return;
    this.entity.object3D.remove(this.gizmo);
    this.gizmo.geometry.dispose();
    this.gizmo.material.dispose();
    this.gizmo = null;
  }

  // ---- on-demand outline (convex / reduced concave / exact mesh) ----

  /**
   * Geometry-derived colliders build no permanent wireframe of their own.
   * This traces one on demand: Edit requests only the selected collider, while
   * Play requests every collider when its Colliders layer is enabled.
   *
   * The outline comes from the cooked data actually fed to Rapier, so Convex
   * shows its hulls, Concave its reduced surface, and Mesh every source triangle.
   */
  setOutlineVisible(visible) {
    this._outlineRequested = !!visible;
    if (!visible) return this.#disposeOutline();
    if (!this.enabled) return;
    // Primitive shapes already draw a real gizmo; a second outline on top of
    // one would only z-fight with it.
    if (this.outline || this.gizmo) return;
    this.#buildOutline();
  }

  /**
   * Requests the cooked outline. Synchronous for a CACHE HIT (a Map lookup)
   * and for a small cooked surface; a big miss is queued, so the click that
   * caused it never pays the edge extraction. See the OUTLINE_TRIANGLE_BUDGET
   * header for what this used to cost.
   */
  #buildOutline() {
    if (!this.enabled) return;
    // Only geometry-derived shapes draw a cooked outline. A primitive or the
    // heightfield already shows its real gizmo — and the outline this method
    // could otherwise build for them traces the entity's RENDERED meshes,
    // which is how changing shape used to leave the baked auto collider
    // sitting on screen next to the new shape's gizmo.
    if (!GEOMETRY_SHAPES.includes(this.props.shape)) return;
    if (this.outline) return;
    const cooked = this.entity.engine?.physics?.getCookedColliderGeometry?.(this.entity);
    if (!this.#hasCookedSurface(cooked)) {
      // Nothing to trace yet: the cook is what produces it, and
      // `physics-collider-cooked` calls back here when it lands.
      this.entity.engine?.physics?.prewarmAutoColliders?.(this.entity);
      return;
    }
    const key = `${cookedRevision(cooked)}:${this.props.shape}`;
    const cached = globalThis.__editorColliderOutlineAsync === false ? null : cacheGet(key);
    if (cached) return this.#adoptOutlineGeometry(cached, true);
    if (globalThis.__editorColliderOutlineAsync === false) {
      const geometry = this.#extractOutlineGeometry(cooked);
      if (geometry) this.#adoptOutlineGeometry(geometry, false);
      return;
    }
    // Small enough to be imperceptible: do it now and keep the "selected means
    // outlined, this frame" contract the gates encode.
    const syncLimit = Number(globalThis.__editorColliderOutlineSyncBelow ?? OUTLINE_SYNC_TRIANGLE_LIMIT);
    if (cookedTriangleCount(cooked, this.props.shape) <= syncLimit) {
      const geometry = this.#extractOutlineGeometry(cooked);
      if (!geometry) return;
      cachePut(key, geometry);
      this.#adoptOutlineGeometry(geometry, true);
      return;
    }
    // One queued build per component: a second selection of the same entity
    // before the first drained must not extract the same edges twice.
    if (this._outlinePending) return;
    this._outlinePending = true;
    const generation = (this._outlineGeneration ??= 0);
    outlineQueue.push(() => {
      this._outlinePending = false;
      // Withdrawn before it ran — the selection moved on, the component was
      // disabled, detached, or its shape changed. This is the common case
      // when someone arrows down the hierarchy, and it is why the queue is
      // cheaper than a debounce: the work is never done at all.
      if (generation !== this._outlineGeneration) return;
      if (!this._outlineRequested || !this.enabled || this.outline) return;
      if (!GEOMETRY_SHAPES.includes(this.props.shape)) return;
      const live = this.entity?.engine?.physics?.getCookedColliderGeometry?.(this.entity);
      if (live !== cooked || !this.entity?.object3D) return;
      const built = cacheGet(key) ?? this.#extractOutlineGeometry(cooked);
      if (!built) return;
      cachePut(key, built);
      this.#adoptOutlineGeometry(built, true);
    }, `collider:${this.entity?.id}`);
  }

  /** True when the cook has produced something this shape can trace. */
  #hasCookedSurface(cooked) {
    if (!cooked) return false;
    if (this.props.shape === "convex") return !!(cooked.convexParts?.length || cooked.convex);
    return !!(this.props.shape === "concave" ? cooked.concave : cooked);
  }

  /**
   * The edge extraction itself, off the click's stack. Named in the freeze
   * ledger so that if it ever blocks again the ledger says which stage did.
   */
  #extractOutlineGeometry(cooked) {
    const span = freeze.begin("collider:buildOutline");
    try {
      if (this.props.shape === "convex") {
        const hulls = cooked?.convexParts?.length
          ? cooked.convexParts
          : cooked?.convex ? [cooked.convex] : [];
        if (!hulls.length) return null;
        let triangles = 0;
        for (const hull of hulls) triangles += (hull.indices?.length ?? 0) / 3;
        if (triangles > OUTLINE_TRIANGLE_BUDGET) return boundsWireframe(hulls);
        const positions = [];
        for (const hull of hulls) {
          const surface = new THREE.BufferGeometry();
          surface.setAttribute("position", new THREE.BufferAttribute(hull.vertices, 3));
          surface.setIndex(new THREE.BufferAttribute(hull.indices, 1));
          const edges = new THREE.EdgesGeometry(surface);
          const edgePositions = edges.attributes.position.array;
          for (let i = 0; i < edgePositions.length; i++) positions.push(edgePositions[i]);
          edges.dispose();
          surface.dispose();
        }
        return new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.Float32BufferAttribute(positions, 3),
        );
      }
      // Concave previews its reduced surface; Mesh and Custom the exact triangles.
      const surface = this.props.shape === "concave" ? cooked?.concave : cooked;
      if (!surface) return null;
      // Past the budget an edge extraction is minutes of `EdgesGeometry` for a
      // green smear no one can read. The box is the honest reduction: it still
      // says where the collider is and how big it is.
      if ((surface.indices?.length ?? 0) / 3 > OUTLINE_TRIANGLE_BUDGET) return boundsWireframe([surface]);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(surface.vertices, 3));
      geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));
      const edges = new THREE.EdgesGeometry(geometry);
      geometry.dispose();
      return edges;
    } finally {
      freeze.end(span);
    }
  }

  /** Wraps a built (possibly shared) geometry in the outline LineSegments. */
  #adoptOutlineGeometry(geometry, shared) {
    if (this.outline || !this.entity?.object3D) return;
    this.outline = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: GIZMO_COLOR, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    // A cached geometry outlives this LineSegments; only the last holder to
    // let go of an EVICTED one may dispose it (see cachePut).
    this.outline.userData.sharedOutlineGeometry = shared;
    if (shared) geometry.userData.outlineRefs = (geometry.userData.outlineRefs ?? 0) + 1;
    this.#placeOutline(this.entity.object3D);
  }

  /** Applies the editor viewport's visual-only Colliders layer state. */
  setDebugVisible(gizmoVisible, outlineVisible = gizmoVisible) {
    this._debugGizmoRequested = !!gizmoVisible;
    if (this.gizmo) this.gizmo.visible = this.enabled && this._debugGizmoRequested;
    // Preserve the layer request while disabled. onEnable builds/restores the
    // outline so a component eye-toggle cannot desynchronise the Layers menu.
    this.setOutlineVisible(!!outlineVisible);
  }

  #placeOutline(root) {
    // Geometry-derived shapes keep their authored vertex offsets, then apply
    // this optional collider-local pose on top.
    this.outline.position.fromArray(this.props.offset ?? [0, 0, 0]);
    this.outline.rotation.set(
      (this.props.rotation?.[0] ?? 0) * DEG2RAD,
      (this.props.rotation?.[1] ?? 0) * DEG2RAD,
      (this.props.rotation?.[2] ?? 0) * DEG2RAD,
    );
    this.outline.renderOrder = 1;
    this.outline.visible = this.enabled;
    this.outline.layers.set(PHYSICS_DEBUG_LAYER);
    this.outline.userData.engineOwned = true;
    this.outline.userData.editorOnly = true;
    this.outline.raycast = () => {}; // never intercept viewport picking
    root.add(this.outline);
  }

  #disposeOutline() {
    // Cancels any queued build. Bumped even with no outline on screen, because
    // the thing being withdrawn is usually a build that has not run yet.
    this._outlineGeneration = (this._outlineGeneration ?? 0) + 1;
    if (!this.outline) return;
    this.entity.object3D.remove(this.outline);
    // A shared geometry belongs to the outline cache — disposing it here is
    // what would make the cache hand out freed buffers on the next selection.
    const geometry = this.outline.geometry;
    if (!this.outline.userData.sharedOutlineGeometry) {
      geometry.dispose();
    } else {
      geometry.userData.outlineRefs = Math.max(0, (geometry.userData.outlineRefs ?? 1) - 1);
      if (geometry.userData.outlineEvicted && geometry.userData.outlineRefs === 0) geometry.dispose();
    }
    this.outline.material.dispose();
    this.outline = null;
  }

  // ---- custom geometry source (shape "custom") ---------------------------

  /**
   * Loads the authored `.geom` this collider is cut from, as the shared
   * refcounted instance (the same cache every Mesh borrows from — two
   * colliders on one asset cook it once). Cooking is synchronous on the
   * physics side, so until this resolves there simply is no collider; when
   * the geometry lands, invalidating hands the new shape to the world and
   * rebuilding the outline previews it.
   */
  async #loadCustomGeometry(path) {
    const generation = (this._customGeometryGeneration = (this._customGeometryGeneration ?? 0) + 1);
    try {
      const geometry = await acquireGeometryAsset(path);
      // Superseded mid-load: another asset was picked, the shape moved off
      // "custom", or the component was detached (generation bumped on release).
      if (generation !== this._customGeometryGeneration
        || this.props.shape !== "custom"
        || this.props.geometryAsset !== path) {
        releaseGeometryAsset(geometry);
        return;
      }
      this.geometry = geometry;
      this.entity.engine?.physics?.invalidateAutoCollider(this.entity);
      if (this._outlineRequested) {
        this.#disposeOutline();
        this.#buildOutline();
      }
    } catch (error) {
      console.warn(`Collider on "${this.entity?.name ?? this.entity?.id}": couldn't load geometry "${path}": ${error?.message ?? error}`);
    }
  }

  #releaseCustomGeometry() {
    if (!this.geometry) return;
    // Cancels any in-flight load so a late resolution releases its instance
    // instead of reviving geometry for a shape that moved on.
    this._customGeometryGeneration = (this._customGeometryGeneration ?? 0) + 1;
    releaseGeometryAsset(this.geometry);
    this.geometry = null;
  }
}

/**
 * The bounded fallback: the box the cooked surface occupies, as edges, baked
 * at the surface's own centre so `#placeOutline` can still apply the
 * collider's local pose on top. Used past OUTLINE_TRIANGLE_BUDGET, where the
 * real edge extraction is a multi-second block for a shape the user reads as a
 * solid green blob anyway.
 */
function boundsWireframe(surfaces) {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const surface of surfaces) {
    const vertices = surface?.vertices;
    if (!vertices) continue;
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      box.expandByPoint(point.set(vertices[i], vertices[i + 1], vertices[i + 2]));
    }
  }
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const box3d = new THREE.BoxGeometry(Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4));
  const edges = new THREE.EdgesGeometry(box3d);
  box3d.dispose();
  edges.translate(centre.x, centre.y, centre.z);
  return edges;
}

/**
 * Wireframe that traces the sibling Terrain's collision surface, for the
 * `heightfield` collider shape. Sampled on a coarse grid (the full heightmap
 * would be far too dense as line segments) at the terrain's live heights, and
 * lifted a hair above the surface to avoid z-fighting. Returns null if the
 * entity has no Terrain component yet (e.g. the collider was added first).
 */
function buildHeightfieldWireframe(entity) {
  const terrain = entity?.getComponent?.("terrain");
  if (!terrain?.heightsArray || typeof terrain.heightAtLocal !== "function") return null;
  const size = terrain.props?.size ?? 50;
  // Match the live height buffer, including clamped/fractional authored input.
  const segments = Math.min(32, terrain._gridResolution);
  const plane = new THREE.PlaneGeometry(size, size, segments, segments);
  plane.rotateX(-Math.PI / 2);
  const pos = plane.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrain.heightAtLocal(pos.getX(i), pos.getZ(i)) + 0.02);
  }
  pos.needsUpdate = true;
  const wire = new THREE.WireframeGeometry(plane);
  plane.dispose();
  return wire;
}
