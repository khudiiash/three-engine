// @ts-check

/**
 * Depth-only merging for SHADOW passes.
 *
 * ## Why a second merge system, next to `merging.js`
 *
 * A shadow map is a full extra submission of every caster, from the light's
 * frustum rather than the camera's, so it is not reduced by view culling. On
 * the Bistro scene at ultra (2026-08-24) the two CSM cascades were 842 of the
 * frame's 1144 draws, and the profiler's own `floorIfMerged` said they could be
 * **8 and 6**:
 *
 * | pass | draws | floorIfMerged |
 * |---|---|---|
 * | ShadowMap 4096² (cascade 0) | 554 | 8 |
 * | main rt | 301 | 9 |
 * | ShadowMap 4096² (cascade 1) | 288 | 6 |
 *
 * `merging.js` cannot close that gap, and not because it is tuned wrong —
 * because it is answering a different question. It groups for the COLOUR pass,
 * so its key is material identity (`material.uuid`), texture-array signatures
 * and eleven shading scalars, and it refuses outright on `uberIncompatibility`.
 * The arithmetic closes to the unit: **125 merge proxies + 287 below the 3-mesh
 * threshold + 142 "custom colorNode" = 554**, cascade 0's draw count exactly.
 *
 * ## What a depth pass actually reads — the whole basis of this file
 *
 * three replaces every material in a shadow pass with ONE override
 * (`scene.overrideMaterial = getShadowMaterial(light)`, ShadowNode.js), and
 * `Renderer.js` (~3562-3590) shows precisely what survives that swap:
 *
 *     materialSide = scene.overrideMaterial.side;        // <- from the OVERRIDE
 *     overrideMaterial.positionNode = material.positionNode;   // if set
 *     overrideMaterial.alphaTest    = material.alphaTest;
 *     overrideMaterial.alphaMap     = material.alphaMap;
 *     overrideMaterial.displacementMap/Scale/Bias = material.displacement*;
 *     overrideMaterial.transparent  = material.transparent || transmission > 0;
 *
 * Colour, every map but `alphaMap`, `colorNode`, ORM, emissive — none of it is
 * read. Even `side` comes from the override, so it is NOT part of the key.
 * `Material.allowOverride` defaults true and nothing in this repo sets it
 * false, so this applies to every material in the scene.
 *
 * That is why this merge can be so much coarser than the colour one: for
 * ordinary opaque geometry every field above is identical, and the whole scene
 * collapses to a single key. What is left splitting it is LOCALITY, deliberately
 * — see `#splitByLocality`.
 *
 * ## The trade this file is making, stated honestly
 *
 * A merged proxy cannot be frustum-culled member-by-member, so a cascade draws
 * triangles it used to cull. This is a good trade only because the frame is
 * CPU-bound on submission: -800 draws is worth +1M depth-only triangles when
 * `renderEncode` is 76% of the tick. It stops being a good trade if the frame
 * ever becomes GPU-bound on shadow rasterisation, which is why the locality
 * split is kept rather than merging the scene into one object.
 *
 * ## Routing
 *
 * Proxies live on `SHADOW_PROXY_LAYER` ALONE and carry `castShadow = true`;
 * their originals keep layer 0 and get `castShadow = false`, which drops them
 * from the depth pass while leaving the colour pass untouched. See that
 * constant's header for the mask-inheritance trap that makes both halves of the
 * routing mandatory.
 */
import * as THREE from "three/webgpu";
import { mergeGeometries } from "./merging.js";
import {
  SHADOW_PROXY_LAYER,
  GI_DEPTH_LAYER,
  GI_DYNAMIC_LAYER,
  GI_MIRROR_LAYER,
  GI_SHARP_LAYER,
  EDITOR_LAYER,
  UI_LAYER,
  DEBUG_LAYER,
} from "./editorLayers.js";

/**
 * Below this a group is not worth a proxy: the merge would copy every vertex to
 * save one or two submissions, and the copy is permanent while the saving is
 * per-frame-small. Lower than `merging.js`' 3 because a depth merge copies only
 * positions — about a third the bytes for the same meshes.
 */
const MIN_GROUP_SIZE = 2;

/**
 * Triangle ceiling per proxy.
 *
 * Deliberately far above `merging.js`' 120k: that cap exists because GI has to
 * be able to REPRESENT a merged mesh (its surface records are per-mesh), and a
 * shadow proxy is invisible to GI — it is skipped by every GI scene walk via
 * the layer mask. What bounds it here is only the index type and the culling
 * trade, so it is set where a proxy still sits inside a cascade rather than
 * spanning the world.
 */
const MAX_PROXY_TRIANGLES = 400_000;

/** Shared empty result, so the per-frame accessor never allocates. */
const EMPTY_GROUPS = Object.freeze([]);

/**
 * A value that changes whenever a mesh's baked vertices would come out
 * different — a new geometry object, or the same one refilled in place.
 *
 * `geometry.id` covers the swap; the position attribute's `version` covers a
 * buffer rewritten under the same object, which is what an in-place LOD promote
 * does. Both are integers already maintained by three, so this costs two reads.
 */
function geometryStamp(mesh) {
  const geometry = mesh?.geometry;
  if (!geometry) return -1;
  return (geometry.id * 65536 + (geometry.attributes?.position?.version ?? 0)) >>> 0;
}

/** Triangles a geometry contributes to a merge, indexed or not. */
function triangleCountOf(geometry) {
  const count = geometry?.index ? geometry.index.count : geometry?.attributes?.position?.count ?? 0;
  return count / 3;
}

/** Cells per axis for the locality split; see `#splitByLocality`. */
const LOCALITY_CELLS_PER_AXIS = 4;


/** Frames a full motion sweep of every proxy is spread across. */
const WATCH_WINDOW_FRAMES = 4;

/**
 * Rebuild debounce. Mirrors `merging.js`' settling rule for the same reason: a
 * streaming load announces every mesh, and rebuilding per announcement copies
 * every merged vertex in the scene into fresh typed arrays each time.
 */
const SETTLE_MS = 400;
const MAX_DEFER_MS = 3000;

/**
 * GI's PRIVATE tag bits — written by `GISystem#collectMeshes` to route GI's own
 * passes, and invisible to any depth render. See `depthKeyOf`'s banner for why
 * they are masked out of the caster identity.
 */
const GI_TAG_BITS =
  ((1 << GI_MIRROR_LAYER) | (1 << GI_SHARP_LAYER) | (1 << GI_DYNAMIC_LAYER)) >>> 0;

/** Layers whose meshes are never real casters for this purpose. */
const SKIP_LAYERS =
  (1 << EDITOR_LAYER) | (1 << UI_LAYER) | (1 << DEBUG_LAYER) | (1 << SHADOW_PROXY_LAYER);

/**
 * Write a mesh's authored `castShadow` — UNLESS a shadow proxy owns it.
 *
 * ⚠ THE OWNERSHIP RULE, AND IT IS THE SAME BUG `MeshComponent#applyVisibility`
 * ALREADY CARRIES A BANNER FOR. `merging.js` claims a member by hiding it
 * (`visible = false`) and every component write to `visible` defers to that
 * claim, because a write that fires while a proxy holds the mesh RESURRECTS it
 * and its geometry draws twice — once as itself, once inside the proxy. On
 * Bistro that was the load/hang loop.
 *
 * This system claims through a DIFFERENT CHANNEL — `castShadow = false` — and
 * that channel had no guard at all. Four places write it
 * (`MeshComponent`:169 and :441, `ModelComponent`:62 and :192), and any of them
 * firing while a proxy holds the mesh puts the original back in the depth pass
 * with its triangles ALSO inside the proxy: the same double-draw, once per
 * cascade, and invisible in the colour pass so it reads as "shadows got slower"
 * rather than as a bug.
 *
 * Asymmetric on purpose, exactly like the visibility rule: turning casting OFF
 * can never resurrect anything, so it applies immediately. Turning it ON is
 * deferred to the owner — but the AUTHORED value is recorded either way, so
 * `#teardown` restores what the author asked for rather than a blanket `true`,
 * and the system is invalidated so the proxy is rebuilt without (or with) that
 * mesh.
 */
export function applyCastShadow(mesh, value, engine) {
  if (!mesh) return;
  const owned = !!mesh.userData.shadowMergedInto;
  if (owned) {
    // Remember what the author wants; #teardown replays it.
    mesh.userData.shadowCastAuthored = value;
    // The proxy's contents are now wrong either way — it either contains a
    // mesh that should no longer cast, or omits one that should.
    engine?.shadowMerge?.invalidate("castShadow-changed");
    if (value !== false) return;
  }
  mesh.castShadow = value;
}

/**
 * A caster's identity for a DEPTH pass, and nothing more.
 *
 * Every field here is one the override copies off the source material (see the
 * header); anything absent from this string is provably unread by a shadow
 * render. `positionNode` is keyed by node id because a custom vertex program
 * changes the silhouette and cannot be baked into merged world-space positions.
 */
function depthKeyOf(mesh, material, casts) {
  const geometry = mesh.geometry;
  // A merged buffer is one attribute set. `uv` only matters when something
  // samples it, which in a depth pass means alpha or displacement.
  const needsUv = !!(material.alphaMap || material.displacementMap);
  const hasUv = !!geometry.attributes.uv;
  return [
    // ⚠ NORMALS ARE PART OF THE IDENTITY EVEN THOUGH NO DEPTH PASS READS THEM.
    // `mergeGeometries` keeps an attribute only if EVERY member has it, so one
    // normal-less member in a bucket silently strips normals from the whole
    // proxy — and this proxy set is also GI's g-buffer geometry (see
    // GI_DEPTH_LAYER), where a missing normal is a shaded-with-garbage bug
    // rather than a dropped optimisation. Splitting the bucket costs one extra
    // proxy on a scene that mixes the two and keeps the guarantee local.
    geometry.attributes.normal ? "n" : "-",
    // ⚠ A PROXY CARRIES ONE `castShadow` FOR ALL ITS MEMBERS, so mixing the two
    // kinds would either add shadows nothing authored or delete shadows that
    // were. Keying on it makes each proxy homogeneous and the inherited flag
    // exact.
    casts ? "cast" : "nocast",
    material.alphaTest || 0,
    material.alphaMap?.uuid ?? "-",
    material.displacementMap?.uuid ?? "-",
    material.displacementMap ? (material.displacementScale ?? 1) : 0,
    material.displacementMap ? (material.displacementBias ?? 0) : 0,
    material.positionNode?.isNode ? `p${material.positionNode.id}` : "-",
    needsUv ? (hasUv ? "uv" : "NOUV") : "-",
    // The proxy inherits this, and a caster on a filtered layer must not be
    // folded in with one on layer 0.
    //
    // ⛔⛔ §19 STAGE 0.3 — GI'S OWN TAG BITS ARE MASKED OUT, AND THAT IS A
    // TERMINATION ARGUMENT, NOT A TIDY-UP. GI re-tags the scene from
    // `GISystem#collectMeshes` every time it learns something about a material
    // (a roughness floor landing off an async GPU readback, a bucket flip, a
    // skinned mesh appearing). Those bits sat inside this mask, so each of
    // those discoveries changed a caster's depth key, which invalidated this
    // system, which DESTROYED AND REBUILT every proxy — new meshes, which GI
    // then re-tags, which is where the user's `mergedRebuilds 29,
    // mergedRebuiltBy "gi-layer-tags"` came from (one rebuild per drain cycle,
    // forever, each one also re-minting the GI field and un-freezing every
    // shadow map).
    //
    // The bits are provably irrelevant HERE: a depth pass reads position,
    // alpha and displacement (see the header), and this key's job is to decide
    // which casters may share ONE baked buffer. `GI_MIRROR_LAYER` says a
    // material reads a reflection and `GI_DYNAMIC_LAYER` says a surface
    // deforms — neither changes one vertex of a depth proxy, and a deforming
    // mesh is refused by `#collectCasters` before it ever reaches this key.
    // Anything GI wants to say about a proxy's CONTENTS has to come through a
    // channel of its own, not through a mask this system reads for a different
    // question.
    (mesh.layers.mask >>> 0) & ~GI_TAG_BITS & ~(1 << SHADOW_PROXY_LAYER),
    // ⚠ THE ONE GI BIT THAT STILL BUCKETS — AND STILL NEVER INVALIDATES.
    //
    // GI's g-buffer prepass draws this proxy set and parks a whole group when
    // ANY member is `GI_SHARP_LAYER` (it needs those meshes to write their own
    // depth exactly — see giScreen.js `renderGiGBuffer`). Keeping the bit as a
    // grouping input means a rebuild that happens for some OTHER reason puts
    // the sharp meshes in their own proxy, so parking costs only them
    // (measured 2026-08-25: 8 of 63 groups parked, dragging 197 of 550 merged
    // meshes back into per-mesh draws).
    //
    // It is a HINT, never a trigger: nothing in this file compares keys after a
    // build, so a bit that flips later simply waits for the next natural
    // rebuild. Re-introducing an invalidation on it re-opens the loop above.
    (mesh.layers.mask >>> 0) & (1 << GI_SHARP_LAYER) ? "sharp" : "-",
  ].join("|");
}

/**
 * Per-frame depth-merging of the scene's static shadow casters.
 *
 * ⚠ OPT-IN while it is being proven (`engine.shadowMerge.setEnabled(true)`, or
 * scene settings `performance.shadowMerging`). It rewrites `castShadow` across
 * the scene, so a bug here is a scene with no shadows rather than a slow one.
 */
export class ShadowMergeSystem {
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    /** @type {any[]} live proxies, each with the members it stands in for. */
    this.groups = [];
    this._dirty = true;
    this._dirtiedAt = 0;
    this._dirtySince = 0;
    this._building = false;
    this._mergeCountSeen = 0;
    this._watchCursor = 0;
    /**
     * Members caught moving. PERMANENT for the session, exactly as
     * `merging.js` treats `_unstable`: a thing that moved once is a mover, and
     * re-absorbing it would just invalidate again on its next step.
     */
    this._movers = new WeakSet();
    /** @type {Array<() => void>} */
    this._unsubscribe = [];
    /** Receipt, in the shape `profile.frameStats` reports it. */
    this.stats = { proxies: 0, replaced: 0, triangles: 0 };
  }

  setEnabled(enabled) {
    const next = enabled !== false;
    if (next === this.enabled) return;
    this.enabled = next;
    if (!next) {
      for (const off of this._unsubscribe ?? []) off();
      this._unsubscribe = [];
      this.#teardown();
      return;
    }
    // ⚠ WHILE PLAYING THE MERGE IS FROZEN, for the same reason `merging.js`
    // freezes: "static merging" means baked at load and left alone, and
    // reacting to a running game's scene graph re-copies every merged vertex
    // for a spawned projectile that has no bearing on the set.
    const invalidate = (reason) => {
      if (this.engine.playing) return;
      this.invalidate(reason);
    };
    this._unsubscribe = [
      this.engine.on("hierarchy-changed", () => invalidate("hierarchy-changed")),
      this.engine.on("play-changed", () => this.invalidate("play-changed")),
    ];
    this.invalidate("enabled");
  }

  invalidate(reason = "unknown") {
    this._dirty = true;
    this._reason = reason;
    this._dirtiedAt = performance.now();
    if (this._dirtySince === 0) this._dirtySince = this._dirtiedAt;
  }

  /**
   * ⚠ MUST RUN AFTER `merging.sync()`, and that is structural, not ordering
   * taste: the set this replaces is whatever the depth pass draws TODAY, which
   * includes `merging.js`' own batch proxies. Running first would merge the
   * originals that merging is about to hide, and then merging would hide
   * meshes this system had already taken `castShadow` from.
   */
  sync() {
    if (!this.enabled || this._building) return;
    // ⚠ FOLLOW `merging.js` REBUILD-FOR-REBUILD. Its batch proxies ARE part of
    // this system's caster set, and it settles on its own clock — so the two
    // are invalidated by the same events but do not necessarily rebuild on the
    // same frame. Without this the shadow merge can bake a set of proxies
    // merging replaces moments later, leaving this holding `castShadow` from
    // meshes that no longer exist and a proxy for geometry nothing draws.
    const mergeCount = this.engine.merging?._rebuildCount ?? 0;
    if (mergeCount !== this._mergeCountSeen) {
      this._mergeCountSeen = mergeCount;
      this.invalidate("merging-rebuilt");
    }
    if (!this._dirty && this.groups.length) this.#watchForMotion();
    if (!this._dirty && this.groups.length === 0) return;
    if (this._dirty) {
      const now = performance.now();
      const settling = now - (this._dirtiedAt ?? 0) < SETTLE_MS;
      const starving = now - (this._dirtySince ?? now) > MAX_DEFER_MS;
      if (settling && !starving && this.groups.length > 0) return;
      this._building = true;
      try {
        this.#rebuild();
      } finally {
        this._building = false;
        this._dirty = false;
        this._dirtySince = 0;
      }
    }
  }

  /**
   * Catch a member whose baked contents went stale — it MOVED, or its GEOMETRY
   * was replaced underneath it.
   *
   * ⚠ THIS IS NOT OPTIONAL FOR A GAME ENGINE. A merge bakes world-space
   * positions, so a caster that moves afterwards leaves its shadow behind —
   * a stale silhouette standing where the object used to be, which reads as a
   * lighting bug and not as a merge bug. `merging.js` carries the identical
   * watcher for the identical reason; this system needs its OWN because it
   * absorbs a strictly larger set (every caster, including the ~429 meshes
   * merging refuses), so merging's watcher does not cover them.
   *
   * ## ⭐⭐ THE GEOMETRY HALF, AND THE BUG THAT PROVED IT WAS MISSING
   *
   * Watching only the MATRIX assumes a mesh's vertices are settled by the time
   * it is merged. They are not: this project streams geometry (binary `.geom`
   * loads, the virtual-geometry cluster LOD's IN-PLACE SWAP), so a mesh can be
   * present, positioned and shadow-casting while still holding a placeholder.
   * A proxy baked then keeps the placeholder FOREVER, because nothing in
   * `depthKeyOf` or this watcher looks at geometry identity.
   *
   * MEASURED on Bistro (2026-08-25), cold reload vs the same scene settled —
   * identical camera, identical 38 proxy draws in the shadow pass:
   *
   * | | triangles per proxy | shadow pass total |
   * |---|---|---|
   * | cold boot | **15 977** | 757 731 |
   * | settled | **52 597** | 2 828 266 |
   *
   * ⇒ the shadow map was missing 73% of its geometry, so most of the scene
   * simply stopped casting. Reported by the user as "shadows are broken after
   * each reload, have to change bias to fix them" — and the bias is exactly
   * right as a clue: it is one of the few edits that invalidates the merge, so
   * the rebuild finally bakes the real geometry.
   *
   * ⚠ `merging.js` is NOT affected, which is why the colour pass looked
   * identical cold and settled (2 175 421 triangles both times). It defers a
   * build until the ready-mesh population stops growing (`MAX_LOAD_DEFER_MS`,
   * `_lastPopulation`); this system only has a 2 s settle. Watching the
   * geometry is the better fix of the two because it is self-correcting: it
   * catches ANY later swap, not just the ones that happen during loading.
   *
   * Amortised over `WATCH_WINDOW_FRAMES` on a round-robin cursor, like
   * merging's: comparing 16 matrix elements for every member every frame would
   * spend more CPU than the draw calls it saves.
   */
  #watchForMotion() {
    const total = this.groups.length;
    if (!total) return;
    const window = Math.max(1, Math.ceil(total / WATCH_WINDOW_FRAMES));
    const start = this._watchCursor % total;
    const end = Math.min(total, start + window);
    for (let g = start; g < end; g++) {
      const group = this.groups[g];
      const { members, matrices, geometries } = group;
      for (let i = 0; i < members.length; i++) {
        // ⚠ GEOMETRY FIRST, and NOT via `_movers`. A swap is a one-time event
        // (the real asset arrived); parking the mesh as a permanent "mover"
        // would answer a load with a permanent draw-call regression, which is
        // the opposite of what this system exists for.
        if (geometries && geometryStamp(members[i]) !== geometries[i]) {
          this.invalidate("caster-geometry-swapped");
          return;
        }
        const current = members[i].matrixWorld.elements;
        const cached = matrices[i];
        for (let e = 0; e < 16; e++) {
          if (current[e] === cached[e]) continue;
          this.invalidate("caster-moved");
          // A mover will keep moving; rebuilding it into a fresh proxy every
          // frame is worse than not merging it. Remember it and leave it out.
          this._movers.add(members[i]);
          return;
        }
      }
    }
    this._watchCursor = end >= total ? 0 : end;
  }

  /**
   * Every mesh three would draw into a shadow map right now.
   *
   * The bail rules mirror `shadowFreeze.js`' conservative rule and for the same
   * reason: a skinned or morphing mesh deforms in the VERTEX SHADER, so its
   * silhouette is not a function of the world-space vertices this file would
   * bake. Instanced meshes keep their per-instance transforms in a buffer that
   * a merge cannot flatten. Both stay unmerged and keep casting normally.
   */
  #collectCasters() {
    const casters = [];
    const scene = this.engine?.scene;
    if (!scene) return casters;
    scene.traverse((object) => {
      if (!object.isMesh || object.visible === false) return;
      // ⚠ NON-CASTERS ARE COLLECTED TOO, and `casts` goes in the depth key so
      // every proxy is homogeneous and inherits the right flag. This system
      // began as a shadow-only merge, but GI's g-buffer prepass now draws the
      // same proxies (see GI_DEPTH_LAYER) and its set is EVERY opaque mesh, not
      // just the casting ones — on Bistro the non-casters were most of the 222
      // draws that survived the first cut. A `castShadow = false` proxy is
      // simply absent from the depth pass, exactly as its members were.
      // Belt to the `visible` brace above: `merging.js` hides the members it
      // absorbed, so they are already skipped — but it is the HIDING that is
      // incidental and the ownership that is the real fact. Reading ownership
      // directly means a change to how merging hides members cannot silently
      // start double-counting every merged mesh (once as itself, once inside
      // the batch proxy that already contains its triangles).
      if (object.userData?.mergedInto) return;
      // Caught moving before — see #watchForMotion. Left unmerged so it casts
      // its own, correct, shadow every frame.
      if (this._movers.has(object)) return;
      if (object.isSkinnedMesh || object.morphTargetInfluences?.length) return;
      if (object.isInstancedMesh || object.isBatchedMesh) return;
      if (((object.layers.mask >>> 0) & SKIP_LAYERS) !== 0) return;
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      // A multi-material mesh draws once per group in the depth pass too, and
      // flattening its groups is colour-pass work this file has no reason to do.
      if (!material || Array.isArray(object.material)) return;
      if (material.allowOverride === false) return;
      // Transparent casters take a different path through the shadow render
      // object function; leave them exactly as they are.
      if (material.transparent === true || (material.transmission ?? 0) > 0) return;
      const geometry = object.geometry;
      if (!geometry?.attributes?.position?.count) return;
      casters.push({ mesh: object, material, casts: object.castShadow === true });
    });
    return casters;
  }

  /**
   * Split a group into spatial cells so a cascade can still reject most of it.
   *
   * Without this the whole scene becomes one proxy with a scene-sized bound,
   * which no shadow frustum can ever cull — every cascade would then rasterise
   * every triangle in the world. The cell count is deliberately COARSE (4 per
   * axis, so at most 64 cells and in practice far fewer occupied): this system
   * is spending triangles to buy draw calls, and a fine grid would hand the
   * draw calls straight back.
   */
  #splitByLocality(members) {
    if (members.length <= MIN_GROUP_SIZE) return [members];
    const box = new THREE.Box3();
    const centre = new THREE.Vector3();
    const bounds = new THREE.Box3();
    const centres = [];
    for (const member of members) {
      box.setFromObject(member.mesh);
      box.getCenter(centre);
      centres.push(centre.clone());
      bounds.expandByPoint(centre);
    }
    const size = bounds.getSize(new THREE.Vector3());
    const cells = new Map();
    for (let i = 0; i < members.length; i++) {
      const c = centres[i];
      const ix = size.x > 0 ? Math.min(LOCALITY_CELLS_PER_AXIS - 1, Math.floor(((c.x - bounds.min.x) / size.x) * LOCALITY_CELLS_PER_AXIS)) : 0;
      const iy = size.y > 0 ? Math.min(LOCALITY_CELLS_PER_AXIS - 1, Math.floor(((c.y - bounds.min.y) / size.y) * LOCALITY_CELLS_PER_AXIS)) : 0;
      const iz = size.z > 0 ? Math.min(LOCALITY_CELLS_PER_AXIS - 1, Math.floor(((c.z - bounds.min.z) / size.z) * LOCALITY_CELLS_PER_AXIS)) : 0;
      const key = (ix << 8) | (iy << 4) | iz;
      const cell = cells.get(key);
      if (cell) cell.push(members[i]);
      else cells.set(key, [members[i]]);
    }
    // ⚠ RE-MERGE THE DEBRIS RATHER THAN DISCARD IT. Dicing manufactures
    // undersized cells, and a cell of one is strictly worse than not dicing at
    // all — it costs the same draw it would have cost unmerged. Everything
    // below the threshold goes back into one remainder group.
    const out = [];
    const remainder = [];
    for (const cell of cells.values()) {
      if (cell.length >= MIN_GROUP_SIZE) out.push(cell);
      else remainder.push(...cell);
    }
    if (remainder.length >= MIN_GROUP_SIZE) out.push(remainder);
    return out;
  }

  /**
   * ⭐ Dice a cell down to the triangle cap instead of throwing it away (§18 W1).
   *
   * `#buildProxy` opens with `if (tris > MAX_PROXY_TRIANGLES) return null`, and
   * `#rebuild`'s `if (!group) continue` used to drop EVERY member of that cell
   * back to drawing itself. So the rule read "a cell of 400k triangles merges;
   * a cell of 401k does not merge AT ALL" — and the denser the cell, the more
   * draws its failure cost. Exactly backwards, and silent: `stats` counts the
   * proxies that were built and says nothing about the cells that produced none.
   *
   * MEASURED on Bistro (ultra, settled, parked): GI's g-buffer prepass drew 246
   * objects of which only 32 were proxies, while `Paris_Building_*` (26 draws)
   * and `Paris_StringLights_*` (30 draws) — dense, spatially clustered,
   * identical depth keys, the ideal merge candidates — sat in dropped cells.
   *
   * The cap itself is unchanged; a chunk is still spatially local because the
   * cell it came from was. A single mesh ABOVE the cap can never merge with
   * anything, so it is emitted alone and `#rebuild`'s MIN_GROUP_SIZE test then
   * leaves it drawing itself — which is what it was doing anyway.
   */
  #splitByTriangleCap(members) {
    let total = 0;
    for (const member of members) total += triangleCountOf(member.mesh.geometry);
    if (total <= MAX_PROXY_TRIANGLES) return [members];
    const out = [];
    let chunk = [];
    let tris = 0;
    for (const member of members) {
      const own = triangleCountOf(member.mesh.geometry);
      // Flush BEFORE adding, so a chunk never exceeds the cap — except when a
      // single member does on its own, which no split can help.
      if (chunk.length > 0 && tris + own > MAX_PROXY_TRIANGLES) {
        out.push(chunk);
        chunk = [];
        tris = 0;
      }
      chunk.push(member);
      tris += own;
    }
    if (chunk.length > 0) out.push(chunk);
    return out;
  }

  #rebuild() {
    // ⭐ A RECEIPT FOR HOW OFTEN, NOT JUST HOW MUCH. `stats.proxies` looks
    // identical whether this ran once at load or forty times since, and a
    // rebuild is expensive twice over: it re-copies every merged vertex, and it
    // hands `ShadowFreezeSystem` a fresh set of proxy object ids, which changes
    // its content fingerprint and un-freezes every shadow map. A scene reporting
    // healthy proxies with `frozen: 0` on a parked camera is exactly that, and
    // there was no way to see it. Reported as `shadows.mergedRebuilds`.
    this.rebuilds = (this.rebuilds ?? 0) + 1;
    this.lastRebuildReason = this._reason;
    this.#teardown();
    const casters = this.#collectCasters();
    if (!casters.length) return;

    const byKey = new Map();
    for (const caster of casters) {
      const key = depthKeyOf(caster.mesh, caster.material, caster.casts);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(caster);
      else byKey.set(key, [caster]);
    }

    let replaced = 0;
    let triangles = 0;
    for (const [key, members] of byKey) {
      if (members.length < MIN_GROUP_SIZE) continue;
      for (const cell of this.#splitByLocality(members)) {
        if (cell.length < MIN_GROUP_SIZE) continue;
        // §18 W1: the triangle cap dices the cell here rather than deleting it
        // inside #buildProxy. Chunks below MIN_GROUP_SIZE are the same debris
        // #splitByLocality already refuses to make proxies of.
        for (const chunk of this.#splitByTriangleCap(cell)) {
          if (chunk.length < MIN_GROUP_SIZE) continue;
          const group = this.#buildProxy(chunk, key);
          if (!group) continue;
          this.groups.push(group);
          replaced += chunk.length;
          triangles += group.triangles;
        }
      }
    }
    this.stats = {
      proxies: this.groups.length,
      replaced,
      triangles,
      // Split out because "the shadow merge is working" and "GI's prepass is
      // getting the benefit" are different questions with different failure
      // modes — a scene whose geometry carries no normals reads healthy on the
      // first and delivers nothing on the second, silently.
      gbufferProxies: this.groups.reduce((n, g) => n + (g.gbufferSafe ? 1 : 0), 0),
      gbufferReplaced: this.groups.reduce((n, g) => n + (g.gbufferSafe ? g.members.length : 0), 0),
    };
  }

  /**
   * The proxies GI's g-buffer prepass may draw in place of their members.
   *
   * Returns the live array rather than a copy: this is read once per frame on
   * the render path, and the caller only iterates it.
   *
   * @returns {any[]}
   */
  gbufferGroups() {
    if (!this.enabled) return EMPTY_GROUPS;
    return this.groups;
  }

  /** @returns {any | null} */
  #buildProxy(members, key) {
    const sample = members[0].material;
    const needsUv = !!(sample.alphaMap || sample.displacementMap);
    // `normal` is not read by ANY depth override — it is here for GI's g-buffer
    // prepass, which draws this same proxy set (see GI_DEPTH_LAYER) and writes
    // world normals. Asking for it costs 12 bytes a vertex; the alternative is a
    // second full copy of the scene's geometry for a pass that merges on exactly
    // the same key. `mergeGeometries` applies the normal matrix per member, so
    // the baked normals are world-space like the positions.
    const wanted = needsUv ? ["position", "normal", "uv"] : ["position", "normal"];

    // Still enforced, and still a hard refusal: #splitByTriangleCap has already
    // diced the cell, so reaching here over the cap means ONE member is bigger
    // than the whole budget and no split exists that would help.
    let tris = 0;
    for (const member of members) tris += triangleCountOf(member.mesh.geometry);
    if (tris > MAX_PROXY_TRIANGLES) return null;

    const geometry = mergeGeometries(members, null, wanted);
    if (!geometry) return null;
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    // A minimal depth material, NOT the author's. It exists only to carry the
    // handful of fields the override copies off it; giving the proxy a real PBR
    // material would put another full material through GI's injection and
    // compile wave for a mesh no colour pass ever draws.
    const material = new THREE.MeshBasicNodeMaterial();
    material.alphaTest = sample.alphaTest || 0;
    if (sample.alphaMap) material.alphaMap = sample.alphaMap;
    if (sample.displacementMap) {
      material.displacementMap = sample.displacementMap;
      material.displacementScale = sample.displacementScale ?? 1;
      material.displacementBias = sample.displacementBias ?? 0;
    }
    if (sample.positionNode?.isNode) material.positionNode = sample.positionNode;

    const proxy = new THREE.Mesh(geometry, material);
    // Homogeneous by construction — `casts` is part of the depth key.
    const casts = members[0].casts !== false;
    proxy.name = `DepthMerged(${members.length}${casts ? "" : ",nocast"})`;
    proxy.castShadow = casts;
    // Never a receiver: it is not in the colour pass at all.
    proxy.receiveShadow = false;
    proxy.frustumCulled = true;
    // ⭐ THE PER-OBJECT REFRESH OPT-OUT, AND IT IS REACHABLE HERE BECAUSE OF
    // WHICH MATERIAL THE OBSERVER IS BUILT FROM.
    //
    // `NodeMaterialObserver.needsRefresh()` returns true immediately when
    // `hasNode` is set, and only reaches `renderObject.object.static` after
    // that. On a GI scene `hasNode` is true for nearly everything — GI stamps
    // `giMonitorNode` on every lit material, and an uber material carries
    // colorNode/normalNode/roughnessNode/metalnessNode of its own — so `static`
    // is normally dead code.
    //
    // A PROXY IS THE EXCEPTION. It is only ever drawn through
    // `scene.overrideMaterial` (the shadow depth override, and GI's g-buffer
    // material), and the observer is built from the OVERRIDE, not from the
    // mesh's own material. Those two carry no node slots at all, so `hasNode`
    // is false and this flag actually lands: three then skips
    // `updateBefore` → `geometries/nodes/bindings.updateForRender` →
    // `updateAfter` for this object entirely, which is the ~35 µs per draw that
    // dominates a submission-bound frame.
    //
    // Safe by construction rather than by promise: a proxy's vertices are baked
    // in world space, its matrix never changes (`matrixAutoUpdate = false`),
    // and every content change REBUILDS it — `#watchForMotion` invalidates on a
    // member that moved, and `#teardown` disposes the mesh outright. There is
    // no mutate-in-place path for `static` to go stale against.
    //
    // ⛔ REFUTED 2026-08-25 — "the CAMERA is an input this ignores". I removed
    // this flag on the theory that a frozen per-object binding leaves a stale
    // MODEL-VIEW when the shadow camera recentres, and that it explained the
    // user's detached shadows. It does not, and the receipt is one grep:
    // `modelViewMatrix` only takes three's CPU-computed path when
    // `renderer.highPrecision` is set (`Renderer.js` :1137-1145), and NOTHING
    // in this engine sets it. It therefore resolves to
    // `mediumpModelViewMatrix = cameraViewMatrix.mul(modelWorldMatrix)`
    // (`ModelNode.js` :138) — composed IN THE SHADER from a camera-group
    // uniform that is updated every render independently of `needsRefresh`.
    // Only `modelWorldMatrix` is per-object, and for a proxy that is a constant
    // identity. ⚠ Detached shadows survived removing this, which is what
    // exposed the theory; check `highPrecision` before re-running that argument.
    proxy.static = true;
    proxy.matrixAutoUpdate = false;
    proxy.raycast = () => {};
    // ⚠ `set`, NOT `enable` — this is the one exclusive layer in the engine.
    // Enabling would leave layer 0 on and draw the proxy in the colour pass.
    proxy.layers.set(SHADOW_PROXY_LAYER);
    // ⚠ ASK THE BUILT GEOMETRY, NEVER THE REQUEST. `wanted` above is a request:
    // `mergeGeometries` drops any attribute a single member lacks, so a bucket
    // that slipped through with one normal-less member produces a proxy the
    // g-buffer would shade from nothing. Eligibility is read back off the result
    // — the one place that cannot be wrong — and an ineligible proxy simply
    // never gets the bit, so its members keep drawing themselves.
    const gbufferSafe = !!geometry.attributes.normal;
    if (gbufferSafe) proxy.layers.enable(GI_DEPTH_LAYER);
    proxy.userData.shadowProxy = true;
    proxy.userData.engineOwned = true;
    // ⚠ BELT TO THE LAYER MASK'S BRACE, and worth the redundancy: GI has more
    // than one scene walk, and a proxy adopted by any of them voxelizes the
    // same triangles a second time and claims a second set of surface records.
    // `__giDebug` is GI's OWN opt-out for engine-owned meshes that are not
    // world geometry (GISystem.js:1702, :12152), so it stays honoured by
    // construction if a future walk is added; the layer test only covers the
    // walks that read layers today.
    proxy.userData.__giDebug = true;
    this.engine.scene.add(proxy);

    const restored = [];
    const matrices = [];
    // What each member's vertices looked like at BAKE TIME. See #watchForMotion:
    // streamed geometry can be replaced under a mesh that never moves, and
    // without this the proxy keeps the placeholder for the session.
    const geometries = [];
    for (const member of members) {
      restored.push(member.mesh);
      matrices.push(Float64Array.from(member.mesh.matrixWorld.elements));
      geometries.push(geometryStamp(member.mesh));
      member.mesh.userData.shadowMergedInto = proxy;
      // What the author asked for, so #teardown can replay it instead of
      // guessing. ⚠ READ FROM THE MEMBER, not hardcoded `true`: non-casters are
      // collected too now, and replaying `true` onto one would hand the scene a
      // shadow its author switched off — silently, and only after a teardown.
      member.mesh.userData.shadowCastAuthored = member.casts === true;
      member.mesh.castShadow = false;
    }
    return { key, mesh: proxy, members: restored, matrices, geometries, triangles: tris, gbufferSafe };
  }

  /** Give every original its `castShadow` back and drop the proxies. */
  #teardown() {
    for (const group of this.groups) {
      for (const mesh of group.members) {
        // Only restore what we took: an original the author has since edited,
        // or one already re-parented away, must not be forced back on.
        if (mesh.userData.shadowMergedInto === group.mesh) {
          // The AUTHORED value, not a blanket `true` — `merging.js#teardown`
          // recomputes visibility the same way, and for the same reason: an
          // author who switched casting off while the proxy held the mesh must
          // not have it switched back on when the proxy lets go.
          mesh.castShadow = mesh.userData.shadowCastAuthored !== false;
          delete mesh.userData.shadowMergedInto;
          delete mesh.userData.shadowCastAuthored;
        }
      }
      group.mesh.parent?.remove(group.mesh);
      group.mesh.geometry?.dispose?.();
      group.mesh.material?.dispose?.();
    }
    this.groups = [];
    this.stats = { proxies: 0, replaced: 0, triangles: 0, gbufferProxies: 0, gbufferReplaced: 0 };
  }

  dispose() {
    for (const off of this._unsubscribe ?? []) off();
    this._unsubscribe = [];
    this.#teardown();
  }
}
