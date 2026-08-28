// @ts-check
import * as THREE from "three/webgpu";
import { Fn, float, max, mix, step, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import { EDITOR_LAYER, SELECTION_ACTIVE_LAYER, SELECTION_MASK_LAYER } from "../engine/editorLayers.js";
import { vmSingleton } from "./singleton.js";

/**
 * Blender-style silhouette outline for the selected entities.
 *
 * WHY NOT A BOUNDING BOX. The viewport used to bracket the selection with a
 * world-axis-aligned wireframe box (`THREE.BoxHelper` / `Box3Helper`). A box is
 * cheap and tells you the extents, but it is a poor SELECTION cue: it hides the
 * thing you just clicked behind eight lines that belong to no surface, it says
 * nothing about which of two overlapping objects you actually hit, and on a
 * rotated or non-convex mesh the box is mostly empty space. Every DCC app
 * solves this the same way — trace the object's own silhouette.
 *
 * HOW. Screen space, in three passes — mask + horizontal dilate PRE-render
 * (updateSelectionOutlineMask), the final composite either as one post-render
 * quad (direct frames) or inside the postprocess pipeline's output node
 * (applySelectionOutlineOverlay) when one owns the camera:
 *
 *   1. MASK. Render only the selected meshes into an RGBA8 target with a flat
 *      override material: red channel = "selected", green channel = "active"
 *      (Blender's distinction — the active object is the one an operation acts
 *      on, and it gets the lighter orange). Depth testing is off, so this is a
 *      pure union-of-coverage mask, not a visibility test.
 *   2. DILATE. Grow the mask by `radius` pixels horizontally into a second
 *      target, then vertically inside the composite. A separable max filter
 *      costs 2*(2r+1) taps instead of the (2r+1)^2 a single-pass disc would.
 *   3. COMPOSITE. `dilated AND NOT mask` is exactly the ring of pixels within
 *      `radius` of a silhouette edge but outside the object — the outline.
 *      Drawn as a fullscreen quad over the finished frame.
 *
 * A geometric alternative (the "inverted hull": re-draw the mesh inflated along
 * its normals with front faces culled) needs no render targets at all, but it
 * splits open at every hard edge — the exact corners of the exact cube in the
 * screenshot this was written from — because a hard edge has no shared normal
 * to inflate along. Screen space has no such failure mode and gives a constant
 * pixel width regardless of distance, which is what makes the cue readable on a
 * far-away prop.
 *
 * WHY THE MASK PASS IS SAFE. The selected meshes are isolated by moving them
 * onto {@link SELECTION_MASK_LAYER} / {@link SELECTION_ACTIVE_LAYER} and
 * pointing the camera's layer mask at exactly that bit. Both the layer masks
 * and `visible` are saved and restored inside the same synchronous block, so
 * nothing else in the frame can observe them — which matters, because
 * `mesh.layers.mask` is part of the static-batching key (see `batching.js`) and
 * a bit left set across a rebuild would quietly pull a selected mesh out of its
 * batch, or leak the bit onto a batch proxy and drag the whole batch into the
 * mask.
 *
 * COST, measured on a 400-mesh scene at 1400x900 (submit time per frame, the
 * number the stats overlay calls "GPU"): 3.3ms with nothing selected, 4.5ms
 * with one object, 5.2ms with a hundred, 6.8ms with a 400-mesh subtree. So the
 * floor is ~1.2ms — three extra render calls (mask, dilate, composite) plus the
 * output blit each one costs — and it grows only with how much of the scene is
 * actually selected. Nothing is allocated or rendered when the selection is
 * empty.
 *
 * ⭐⭐ WHAT THAT COST MODEL MISSED, AND THE TWO THINGS THAT FIX IT (2026-08-28).
 * "fps drops 2 times when the Bistro entity is selected". A 400-mesh subtree
 * was the biggest thing measured above; a 1 536-mesh import is not that scene,
 * and on it the mask pass submitted 850 depth-only draws EVERY FRAME. The frame
 * is CPU-bound at ~40 µs per draw (see the `bistro-cpu-is-draws` receipt) — so
 * the mask pass alone cost more than the picture it decorates: 44.5 ms of CPU
 * with the root selected against 20.8 ms without, 20 fps against 38. Neither
 * half of the old model was wrong; the missing terms were WHAT it draws and HOW
 * OFTEN.
 *
 *   WHAT — the main pass draws that subtree as 187 merge proxies, and the mask
 *   pass drew all 1 206 members individually, because the stamping loop
 *   force-shows every member a merge hid. A proxy's geometry IS its members
 *   concatenated in world space, so when the selection covers a WHOLE group the
 *   proxy's silhouette is identical and it is one draw instead of N. Partially
 *   covered groups keep the member path — stamping the proxy there would
 *   outline meshes nobody selected. See `coveredProxies`. Measured: 850 → 343
 *   draws per mask render, and the two masks agree on 450 912 covered texels
 *   with ZERO of 464 544 differing (`probe:outline-root`, which renders it both
 *   ways and compares the readback).
 *
 *   HOW OFTEN — the mask is a pure function of (selection, camera, target size,
 *   where those objects are). On a parked camera none of that moves, so the
 *   render is skipped entirely and the targets keep last frame's ring: a hit is
 *   ZERO draws, not cheaper ones. The declared inputs are the cache key; the
 *   undeclared ones (a script writing straight through `entity.position`) are
 *   caught by `stampFingerprint`, the per-frame audit contentKey.js's banner
 *   requires of every consumer. It walks the ~500 stamped objects, not the
 *   1 536 meshes beneath them, which is what keeps the audit cheaper than the
 *   thing it is guarding. Measured on an empty-scene box: 362 hits, 0 renders.
 *
 * TOGETHER, on Bistro with the root selected: the mask went from 850 draws
 * EVERY frame to 171 per frame parked and 330 orbiting; CPU 42.3 → 27.3 ms
 * parked (deselected 18.0) and 43.3 → 31.4 ms orbiting (deselected 19.2); fps
 * 20 → 32 parked (deselected 46) and 19 → 25 orbiting (deselected 38). The
 * "selecting halves the frame rate" report is 2.35x → 1.51x parked and
 * 2.26x → 1.64x orbiting. ⚠ Ratios move a few points run to run with what else
 * is on the GPU; the DRAW counts do not, which is why they are the receipt.
 *
 * ⚠ AND WHAT IS LEFT, NAMED. Parked is 1.5x rather than 1.0x for one reason
 * the receipt states outright — the scene's Player rig animates in the editor
 * and sits under the same prefab root, so exactly half the parked frames
 * re-render with `miss: pose` (66 of 132; zero `audit`, zero `content`). One
 * moving character re-submits all ~340 static draws because the mask is a
 * single target that must be cleared; a second target holding the static half
 * (blit it, then draw only the movers) would close that, and is not built. On a
 * selection with nothing animating the cache is total: 362 hits, 0 renders.
 * Orbiting is 1.64x because every frame there is a real mask render of the same
 * geometry the main pass already drew — the structural fix for THAT is writing
 * the mask inside the main pass, which this module's whole safety contract
 * exists to avoid.
 *
 * `selectionOutlineStats()` reports all of it: `maskDraws` (counted by the
 * renderer, not inferred), `hits`/`renders`, and `misses` BY REASON.
 *
 * KNOWN LIMITS, deliberate:
 *   - The outline is not occluded. A selected object behind a wall still shows
 *     its silhouette, because the mask pass has no scene depth to test against
 *     and reading the main pass's depth back would cost more than the whole
 *     effect. In an editor "where did my selection go" is worth more than strict
 *     occlusion; Blender hides it, we don't.
 *   - Edges are crisp, not antialiased — same as every other editor overlay
 *     here (grid, gizmo, debug draw). A 4x multisampled mask target would fix
 *     it if that ever reads as cheap-looking.
 *   - Particles (`THREE.Sprite`) and impostor-swapped LOD levels get no
 *     outline: the override material can't reproduce a sprite's billboard
 *     vertex transform, and an impostor's billboard doesn't live under the
 *     entity's own `object3D`.
 */

/** Blender's own theme colours: "Active Object" and "Object Selected". */
const ACTIVE_COLOR = 0xffa040;
const SELECTED_COLOR = 0xed5700;

/** Outline half-width in CSS pixels. Blender's is 2; thicker reads as a glow. */
const WIDTH_CSS_PX = 2;

/** Guards the unrolled tap loops on a hypothetical 8x-DPI display. */
const MAX_RADIUS = 6;

const SELECTED_BIT = 1 << SELECTION_MASK_LAYER;
const ACTIVE_BIT = 1 << SELECTION_ACTIVE_LAYER;

const _size = new THREE.Vector2();

/**
 * Every reason the frame cache can decline to answer, as a zeroed histogram.
 *
 * Named individually because "the cache never hits" is the same observation for
 * all of them and a different bug in each: `disabled` is the probe's own switch,
 * `cold` is the first frame of a selection, `notlive` means the ring was
 * cleared, and `selection`/`camera`/`size`/`dpi`/`content` are the declared key terms.
 * `pose` is a skinned/morphed mesh in the selection having moved — expected
 * work, not a fault. `audit` is the key agreeing while the walk disagreed about
 * anything ELSE — the only one of these that indicates a missing producer.
 */
const MISS_REASONS = {
  disabled: 0, cold: 0, notlive: 0,
  selection: 0, camera: 0, size: 0, dpi: 0, content: 0, audit: 0, pose: 0,
};

const state = vmSingleton("selectionOutline", () => ({
  /** @type {THREE.Object3D[]} Roots whose subtrees are outlined. */
  roots: [],
  /** @type {THREE.Object3D|null} The active root — drawn in the lighter colour. */
  activeRoot: null,
  /** @type {{mesh: THREE.Mesh, active: boolean}[]} Flattened, cached. */
  entries: [],
  /** Bumped by refreshEntries; the cheap "is this a different selection" term. */
  entriesRev: 0,
  /** How many selected meshes are skinned/morphed — receipt only, see refreshEntries. */
  animated: 0,
  /**
   * @type {THREE.Object3D[]|null} What the last mask render actually submitted
   * — merge/batch proxies plus the meshes that draw themselves. The audit walks
   * THIS, not `entries`, which is why the audit stays cheap on a 1 600-mesh
   * subtree that collapses to ~200 proxies.
   */
  stampObjects: null,
  /** @type {any} Frame cache: the declared key, the audit hash, and counters. */
  cache: null,
  /** @type {any} Last pass's receipt — see selectionOutlineStats. */
  stats: null,
  /** Set when the scene tree may have changed under a selected root. */
  dirty: false,
  enabled: true,
  /** Dilation radius in device pixels the current materials were built for. */
  radius: 0,
  /** @type {THREE.RenderTarget|null} */
  maskTarget: null,
  /** @type {THREE.RenderTarget|null} */
  dilateTarget: null,
  /** @type {THREE.QuadMesh|null} */
  quad: null,
  /** @type {THREE.NodeMaterial|null} */
  maskSelectedMaterial: null,
  /** @type {THREE.NodeMaterial|null} */
  maskActiveMaterial: null,
  /** @type {THREE.NodeMaterial|null} */
  dilateMaterial: null,
  /** @type {THREE.NodeMaterial|null} */
  compositeMaterial: null,
  /** @type {any} vec2 uniform: one texel of the current target. */
  texel: null,
  /**
   * True while the mask/dilate targets hold a live ring. Cleared (with a real
   * GPU clear of both targets) the frame the selection empties, so neither the
   * post-render composite nor the postprocess overlay can show a stale ring.
   */
  ringLive: false,
  /**
   * Float uniform: the current dilation radius, read per-tap by the overlay
   * node (see applySelectionOutlineOverlay) so a DPI change never forces the
   * postprocess pipeline to rebuild — its tap loop is unrolled to MAX_RADIUS
   * and gated at runtime.
   */
  overlayRadiusU: null,
}));

/**
 * Sets what the outline traces.
 *
 * @param {THREE.Object3D[]} roots Subtree roots to outline (usually one
 *   `entity.object3D` per selected entity).
 * @param {THREE.Object3D|null} [activeRoot] The root drawn in the active
 *   colour — Blender's "active object", i.e. the last one clicked.
 */
export function setSelectionOutline(roots, activeRoot = null) {
  state.roots = roots ?? [];
  state.activeRoot = activeRoot ?? null;
  state.dirty = true;
}

/**
 * Marks the cached mesh list stale. Call when the scene tree changes — a
 * prefab respawn rebuilds a selected entity's subtree behind our back, and the
 * cached `THREE.Mesh` references would outline a destroyed object.
 */
export function invalidateSelectionOutline() {
  state.dirty = true;
}

/** Hides/shows the outline without forgetting what is selected. */
export function setSelectionOutlineEnabled(enabled) {
  state.enabled = enabled !== false;
}

/* -------------------------------------------------------------------------- */

/**
 * Collects the drawable meshes under `root`.
 *
 * Editor-only subtrees are skipped WHOLE (an early return inside `traverse`
 * would still visit their children): a light's cone helper or a camera's body
 * model would otherwise inflate the silhouette of the entity it belongs to.
 */
function collectMeshes(root, active, out, seen) {
  if (!root) return;
  if (root.userData?.editorOnly || root.userData?.batchProxy) return;
  if (root.layers.isEnabled(EDITOR_LAYER)) return;
  if (root.isMesh && !root.isSprite && !seen.has(root)) {
    seen.add(root);
    out.push({ mesh: root, active });
  }
  for (const child of root.children) collectMeshes(child, active, out, seen);
}

function refreshEntries() {
  if (!state.dirty) return;
  state.dirty = false;
  const entries = [];
  const seen = new Set();
  // Active first: a mesh reachable from both the active root and another
  // selected root (a parent/child pair, both selected) belongs to the active
  // one, so `seen` must have claimed it before the plain pass runs.
  if (state.activeRoot) collectMeshes(state.activeRoot, true, entries, seen);
  for (const root of state.roots) {
    if (root === state.activeRoot) continue;
    collectMeshes(root, false, entries, seen);
  }
  state.entries = entries;
  // Bumped whenever the SET changes, so the frame cache below never has to
  // compare two mesh lists — a selection change is one integer apart.
  state.entriesRev = (state.entriesRev ?? 0) + 1;
  // ⭐⭐ THE SHAPES THAT MOVE WITHOUT MOVING. A skinned or morphed mesh changes
  // silhouette with no transform write, no visibility flip and no attribute
  // version bump — the pose lives in bone matrices and influence weights.
  //
  // The first version of the cache handled that by refusing to cache ANY
  // selection containing one, and on Bistro that turned out to be the whole
  // feature: the scene's `Player` rig sits under the same prefab root as the
  // 1 535 static building meshes, so ONE skinned character held every one of
  // them hostage and the cache never engaged once — 123 misses in 123 parked
  // frames, and `animated: 1` is the count that said so. A blanket opt-out
  // keyed on the presence of a hard case is not a conservative choice; it is
  // the feature not shipping.
  //
  // So they are WATCHED instead, exactly, in `stampFingerprint`. This count is
  // kept only as the receipt that a selection contains any.
  let animated = 0;
  for (const { mesh } of entries) {
    if (mesh.isSkinnedMesh || mesh.morphTargetInfluences?.length) animated++;
  }
  state.animated = animated;
}

/* ------------------------- cache-key ingredients -------------------------- */

/**
 * Exact float hashing. `Math.imul` over the IEEE bit pattern, not over the
 * value: two positions a micrometre apart must not collide, and a rounded or
 * quantised hash is exactly the "it only updates when you move far enough"
 * class of bug.
 */
const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);
const HASH_SEED = 2166136261;

function hashFloat(h, v) {
  _f32[0] = v;
  return Math.imul(h ^ _i32[0], 16777619) >>> 0;
}

function hashInt(h, v) {
  return Math.imul(h ^ (v | 0), 16777619) >>> 0;
}

/**
 * Everything about the camera that moves a silhouette on screen: the world
 * matrix (position + orientation) and the projection (fov, aspect, zoom, near,
 * far). `updateMatrixWorld` first because this runs in PRE-render, before the
 * renderer has refreshed it — hashing a stale matrix would hold the ring one
 * frame behind the camera, which reads as the outline "swimming".
 *
 * LIMIT: a camera parented under something that moved is only seen once that
 * parent's own matrix has been updated. The editor viewport camera is
 * unparented, so this is exact there.
 */
function cameraHash(camera) {
  camera.updateMatrixWorld();
  let h = HASH_SEED;
  const m = camera.matrixWorld.elements;
  for (let i = 0; i < 16; i++) h = hashFloat(h, m[i]);
  const p = camera.projectionMatrix.elements;
  for (let i = 0; i < 16; i++) h = hashFloat(h, p[i]);
  return h;
}

/**
 * THE AUDIT, in the sense contentKey.js means it.
 *
 * `engine.content.version` is a sufficient CHANGE signal and explicitly NOT a
 * proof of no change — `entity.position.x += 1` from a script, physics
 * write-back and an animation mixer all bypass its setters. Its own banner
 * requires every consumer to keep a cheap periodic re-walk. This is ours, and
 * it runs EVERY frame rather than every N because it walks the STAMP LIST
 * (~200 objects on Bistro once whole merge groups collapse to their proxies),
 * not the 1 600 meshes underneath it.
 *
 * What it covers: the object left the scene, was hidden or shown, moved,
 * had its geometry swapped or re-uploaded, was re-posed (bone matrices, morph
 * influences), or — for a batch proxy — had its instance matrices re-synced.
 * Rotation is sampled off-diagonally as well as on, so a 180° flip is not a
 * fixed point.
 *
 * What it does NOT cover, and does not need to: the mask renders with an
 * OVERRIDE material, so nothing a material does — including a `positionNode`
 * that animates vertices in the shader — can move this silhouette.
 */
const _fp = { stat: 0, anim: 0 };

function stampFingerprint(objects) {
  let h = hashInt(HASH_SEED, objects.length);
  let a = HASH_SEED;
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    h = hashInt(h, o.id);
    h = hashInt(h, o.parent ? 1 : 0);
    h = hashInt(h, o.visible ? 1 : 0);
    const e = o.matrixWorld.elements;
    h = hashFloat(h, e[0]);
    h = hashFloat(h, e[1]);
    h = hashFloat(h, e[5]);
    h = hashFloat(h, e[6]);
    h = hashFloat(h, e[10]);
    h = hashFloat(h, e[12]);
    h = hashFloat(h, e[13]);
    h = hashFloat(h, e[14]);
    const g = o.geometry;
    h = hashInt(h, g?.id ?? 0);
    h = hashInt(h, g?.attributes?.position?.version ?? 0);
    if (o.isInstancedMesh) {
      h = hashInt(h, o.count);
      h = hashInt(h, o.instanceMatrix?.version ?? 0);
    }
    // ⭐ THE POSE. A skinned mesh's silhouette is its bone matrices and nothing
    // above sees them; a morph target's is its influence weights. Both are
    // small contiguous arrays, so watching them exactly costs less than the one
    // draw it saves — and it is what lets a selection that merely CONTAINS a
    // character still cache the 1 500 static meshes beside it.
    //
    // ⚠ ONE FRAME LATE, deliberately. `skeleton.update()` runs inside the
    // renderer, so in PRE-render `boneMatrices` still holds last frame's pose:
    // the first frame of a movement re-renders the mask one frame after it
    // began. On a 2 px ring over a moving character that is not observable, and
    // the alternative — forcing a skeleton update here — would do the animation
    // system's work twice every frame to fix a frame of lag nobody can see.
    const bones = o.isSkinnedMesh ? o.skeleton?.boneMatrices : null;
    if (bones) {
      // Strided so a 4 000-bone rig cannot turn the audit into the cost. Every
      // bone contributes its translation column; a rotation-only change still
      // moves a child bone's translation, so nothing static hashes as moving.
      const stride = bones.length > 4096 ? 16 * Math.ceil(bones.length / 4096) : 16;
      for (let b = 12; b < bones.length; b += stride) {
        a = hashFloat(a, bones[b]);
        a = hashFloat(a, bones[b + 1]);
        a = hashFloat(a, bones[b + 2]);
      }
    }
    const morphs = o.morphTargetInfluences;
    if (morphs) for (let m = 0; m < morphs.length; m++) a = hashFloat(a, morphs[m]);
  }
  _fp.stat = h;
  _fp.anim = a;
  return _fp;
}

/** A member's stand-in in the main pass, or null if it draws itself. */
function proxyOf(mesh) {
  const data = mesh.userData;
  if (!data) return null;
  return data.mergedInto ?? data.batchedInto ?? null;
}

/**
 * Decides, per proxy, whether the selection covers the WHOLE group.
 *
 * ⭐ WHY THIS IS THE WHOLE FIX. The main pass draws Bistro's 1 204 merged
 * meshes as 189 proxies; the mask pass was drawing all 1 204 individually,
 * because the stamping loop force-shows every merged member. The frame is
 * CPU-bound at ~40 µs per draw, so selecting the root doubled the frame — the
 * mask cost more than the picture. A proxy's geometry IS its members
 * concatenated in world space (merging.js) and a batch's instance matrices ARE
 * its members' world matrices (batching.js), so when every member is selected
 * IN THE SAME CHANNEL the proxy's silhouette is identical, pixel for pixel,
 * to the union of theirs.
 *
 * A PARTIALLY covered group keeps the member path: stamping the proxy there
 * would outline meshes the user did not select, which is a correctness bug,
 * not a performance trade. Mixed channels (some members active, some merely
 * selected) are partial for the same reason — one draw carries one colour.
 *
 * @return {Map<any, boolean>} proxy → active channel, for fully covered groups.
 */
function coveredProxies(entries) {
  // The escape hatch, and the receipt rig in one. `run-outline-root-probe.mjs`
  // renders the SAME selection both ways and compares the mask texel for texel
  // — a claim of "identical silhouette" that is measured rather than argued
  // needs a way to draw the other one. Also the one-line revert if a proxy is
  // ever found whose geometry is NOT its members.
  if (/** @type {any} */ (globalThis).__outlineNoProxyCollapse) return new Map();
  /** @type {Map<any, {count: number, active: boolean, mixed: boolean}>} */
  const cover = new Map();
  for (const { mesh, active } of entries) {
    if (!mesh.parent) continue;
    const proxy = proxyOf(mesh);
    if (!proxy) continue;
    const seen = cover.get(proxy);
    if (!seen) cover.set(proxy, { count: 1, active, mixed: false });
    else {
      seen.count++;
      if (seen.active !== active) seen.mixed = true;
    }
  }
  const covered = new Map();
  for (const [proxy, seen] of cover) {
    // `proxyMemberCount` absent ⇒ a proxy from a build that predates the
    // accessor, or something else entirely wearing `mergedInto`. Unknown total
    // is never "covered": fall back to the members, which is always correct.
    const total = proxy.userData?.proxyMemberCount ?? 0;
    if (!total || seen.mixed || seen.count !== total) continue;
    // A proxy the engine has hidden or detached draws nothing; its members do.
    if (!proxy.parent || !proxy.visible) continue;
    // ⚠ NOT A PROXY INSIDE A RENDER BUNDLE. `merging.js#proxyParent` parks the
    // proxies under a `BundleGroup` when `performance.renderBundles` is on, and
    // a bundle RECORDS its render list and replays it — the recording is keyed
    // on (group, camera, render context), so the mask pass's two channel
    // sub-passes share one recording and the second would replay the first's
    // list. The members are outside the bundle and draw honestly, so falling
    // back to them is both correct and free. (renderBundles is off by default
    // and measured net-zero while GI is on — see the render-bundles receipt.)
    if (proxy.parent.isBundleGroup) continue;
    covered.set(proxy, seen.active);
  }
  return covered;
}

function ensureTargets(width, height) {
  if (!state.maskTarget) {
    state.maskTarget = makeTarget(width, height, "selectionOutlineMask");
    state.dilateTarget = makeTarget(width, height, "selectionOutlineDilate");
  }
  if (state.maskTarget.width !== width || state.maskTarget.height !== height) {
    state.maskTarget.setSize(width, height);
    state.dilateTarget?.setSize(width, height);
  }
}

function makeTarget(width, height, name) {
  const target = new THREE.RenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    // Nearest everywhere: the mask is binary coverage, and a filtered tap
    // would report "half covered" for texels the dilation then grows from.
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    // Sampling past the edge must not wrap an outline around the screen.
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    // Linear, not sRGB: these hold coverage, not colour. Declaring sRGB would
    // make the backend pick an `-srgb` format and encode the 1.0s on write.
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  target.texture.name = name;
  return target;
}

/**
 * Flat mask material. `side: DoubleSide` because coverage is all we want: a
 * single-sided plane viewed from behind still has a silhouette.
 */
function makeMaskMaterial(channel) {
  const material = new THREE.NodeMaterial();
  material.colorNode = channel === "active" ? vec4(0, 1, 0, 1) : vec4(1, 0, 0, 1);
  material.side = THREE.DoubleSide;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  material.toneMapped = false;
  material.name = `selectionOutlineMask:${channel}`;
  return material;
}

/**
 * Builds the two fullscreen materials for a given dilation radius.
 *
 * The tap loops are unrolled in JS rather than expressed as a TSL `Loop` over a
 * uniform bound, so the shader has no dynamic branching and the radius is a
 * compile-time constant. The trade is a rebuild when the radius changes, which
 * happens only when the display's pixel ratio does.
 */
function buildFullscreenMaterials(radius) {
  const maskTexture = state.maskTarget.texture;
  const dilateTexture = state.dilateTarget.texture;
  const texel = state.texel;
  const activeColor = uniform(new THREE.Color(ACTIVE_COLOR));
  const selectedColor = uniform(new THREE.Color(SELECTED_COLOR));

  state.dilateMaterial?.dispose();
  state.compositeMaterial?.dispose();

  // Pass 2: horizontal max.
  const dilate = new THREE.NodeMaterial();
  dilate.colorNode = Fn(() => {
    const base = uv();
    let acc = /** @type {any} */ (texture(maskTexture, base));
    for (let i = 1; i <= radius; i++) {
      const offset = vec2(texel.x.mul(i), 0);
      acc = max(acc, texture(maskTexture, base.add(offset)));
      acc = max(acc, texture(maskTexture, base.sub(offset)));
    }
    return acc;
  })();
  dilate.depthTest = false;
  dilate.depthWrite = false;
  dilate.fog = false;
  dilate.toneMapped = false;
  dilate.name = "selectionOutlineDilate";

  // Pass 3: vertical max, minus the mask itself, blended over the frame.
  const composite = new THREE.NodeMaterial();
  composite.colorNode = Fn(() => {
    const base = uv();
    let grown = /** @type {any} */ (texture(dilateTexture, base));
    for (let i = 1; i <= radius; i++) {
      const offset = vec2(0, texel.y.mul(i));
      grown = max(grown, texture(dilateTexture, base.add(offset)));
      grown = max(grown, texture(dilateTexture, base.sub(offset)));
    }
    const mask = texture(maskTexture, base);
    // Subtracting BOTH channels — not just the matching one — is what keeps a
    // selected object's outline from being painted across the interior of the
    // active object in front of it. Without scene depth that overlap is the
    // one artefact you'd actually notice.
    const inside = max(mask.r, mask.g);
    const edge = max(grown.r, grown.g).mul(inside.oneMinus());
    const color = mix(selectedColor, activeColor, step(0.5, grown.g));
    return vec4(color, edge);
  })();
  composite.transparent = true;
  composite.depthTest = false;
  composite.depthWrite = false;
  composite.fog = false;
  composite.toneMapped = false;
  composite.name = "selectionOutlineComposite";

  state.dilateMaterial = dilate;
  state.compositeMaterial = composite;
  state.radius = radius;
}

/**
 * Renders the outline's MASK and horizontal-DILATE passes into the module's
 * offscreen targets. This is the half of the effect that makes nested
 * `renderer.render()` calls and manual `setRenderTarget` swaps, so it MUST run
 * in the engine's PRE-render phase, next to the GI gbuffer and the occluder
 * pass — the sanctioned slot for nested renders.
 *
 * ⚠ WHY THE SPLIT EXISTS (2026-08-13): this whole effect used to run
 * post-render, after the frame was presented. With a PostprocessComponent
 * active, the frame is owned by three's RenderPipeline, and
 * PostprocessComponent's own header documents the rule the old shape broke:
 * manual target swapping outside the renderer's managed frame desynchronizes
 * the WebGPU backend's cached render state. The result was SILENT canvas
 * corruption (no validation errors) from the first selection onward —
 * reproduced deterministically on the user's project by
 * scripts/run-outline-postfx-repro.mjs. Post-render now draws at most ONE
 * fullscreen quad (compositeSelectionOutline), and with a postprocess pipeline
 * active it draws nothing at all — the ring composites INSIDE the pipeline via
 * applySelectionOutlineOverlay.
 *
 * Every piece of renderer/scene state this touches is restored before it
 * returns, including the layer masks it stamps on the selected meshes and the
 * previous render target.
 *
 * @param {object} options
 * @param {THREE.WebGPURenderer} options.renderer
 * @param {THREE.Scene} options.scene
 * @param {THREE.Camera} options.camera
 * @param {number} [options.width] Mask resolution (defaults to the renderer's
 *   drawing buffer).
 * @param {number} [options.height]
 * @param {number} [options.pixelRatio] Device pixels per CSS pixel, for keeping
 *   the outline the same apparent thickness on a HiDPI display.
 * @param {boolean} [options.playing] Play mode never shows the editor outline;
 *   passing true clears any live ring instead of rendering one.
 * @param {number} [options.contentVersion] `engine.content.HIERARCHY` — not
 *   `.version`. See the cache block for why the broad counter cannot be used
 *   here. Part of the cache key; omitting it only costs a redraw the audit
 *   would have caught anyway, so the offscreen screenshot path need not thread
 *   it.
 * @param {number} [options.contentFull] `engine.content.version`, recorded but
 *   NOT part of the key — the receipt for the paragraph above.
 * @return {boolean} True when the targets now hold a live ring.
 */
export function updateSelectionOutlineMask({ renderer, scene, camera, width, height, pixelRatio, playing = false, contentVersion, contentFull }) {
  if (!renderer || !scene || !camera) return false;
  const wants = !playing && state.enabled && state.roots.length > 0;
  if (wants) refreshEntries();
  if (!wants || state.entries.length === 0) {
    clearRing(renderer);
    return false;
  }

  let w = width;
  let h = height;
  if (!w || !h) {
    renderer.getDrawingBufferSize(_size);
    w = _size.width;
    h = _size.height;
  }
  if (!w || !h) return false;

  ensureTargets(w, h);
  if (!state.quad) state.quad = new THREE.QuadMesh();
  if (!state.texel) state.texel = uniform(new THREE.Vector2());
  if (!state.maskSelectedMaterial) {
    state.maskSelectedMaterial = makeMaskMaterial("selected");
    state.maskActiveMaterial = makeMaskMaterial("active");
  }
  state.texel.value.set(1 / w, 1 / h);

  const ratio = pixelRatio ?? renderer.getPixelRatio();
  const radius = Math.max(1, Math.min(MAX_RADIUS, Math.round(WIDTH_CSS_PX * ratio)));
  if (!state.compositeMaterial || state.radius !== radius) buildFullscreenMaterials(radius);
  if (state.overlayRadiusU) state.overlayRadiusU.value = radius;

  // ---------------------------- THE STATIC CACHE ----------------------------
  //
  // The mask is a pure function of (what is selected, where the camera is, how
  // big the target is, where those objects are). None of that changes on a
  // parked camera, and re-deriving it every frame is what made "selected" cost
  // as much as "drawn". The targets persist between frames — nothing else
  // writes them and we only clear them on purpose (clearRing) — so a hit is
  // literally zero GPU work, not a cheaper redraw.
  //
  // The key is the declared inputs; `stampFingerprint` is the audit that
  // catches the undeclared ones (see its own header). Both must agree.
  //
  // `__outlineNoCache` (with `__outlineNoProxyCollapse`) reproduces the exact
  // pre-08-28 behaviour, so `run-outline-root-probe.mjs` can measure before and
  // after in ONE boot of a scene that takes minutes to reach first light — a
  // cross-session A/B on this engine is not a controlled experiment (the GI
  // compile wave, the merge budget and the frame governor all differ boot to
  // boot). Also the revert switch if the cache is ever caught holding a stale
  // ring in the field.
  //
  // ⭐ AND EVERY MISS SAYS WHICH TERM MOVED. A cache that silently never hits
  // looks exactly like a cache that is working — the frame is simply as slow as
  // before, and there is nothing to read. `misses` is a histogram by reason, so
  // "the camera is not actually parked", "the content key churns", "something
  // in the selection is animating" and "an undeclared writer is moving the
  // geometry" are four different lines instead of one absent hit count. On the
  // day this shipped it separated the third from the fourth on Bistro, which is
  // the difference between "expected work" and "a producer is missing".
  //
  // THE KEY'S CONTENT TERM IS `content.HIERARCHY`, NOT `.version`.
  //
  // `.version` moves for ANY change the engine announces, and most of those
  // cannot touch this mask: a material edit (the mask uses an override
  // material), a settings change, and `visibility-resolve`, which bumps every
  // time occlusion culling or LOD flips one mesh anywhere in the scene.
  // `.hierarchy` is the one axis the stamp fingerprint genuinely cannot see —
  // an object APPEARING under a selected root — and even that is belt and
  // braces, because `hierarchy-changed` already calls
  // `invalidateSelectionOutline` (ViewportPanel), which moves `entriesRev`.
  // Everything else the mask depends on is measured directly, on the objects
  // themselves.
  //
  // ⚠ AND THAT NARROWING IS NOT WHY THE CACHE WORKS — it is insurance, and the
  // honest measurement says so: on parked Bistro `contentChurn` came back 0 of
  // 131 frames, i.e. `.version` was stable and the broad key would have hit
  // too. The receipt is kept live rather than deleted because "the content key
  // is quiet on THIS scene" is not a property of the engine: a scene with
  // occlusion culling actively flipping meshes would churn it every frame, and
  // then the broad key would silently cost the whole feature. Read
  // `contentChurn` before blaming this term for anything.
  const cache = (state.cache ??= {
    key: null, fpStat: 0, fpAnim: 0, hits: 0, renders: 0, audits: 0,
    frames: 0, contentChurn: 0, lastContentFull: null,
    misses: { ...MISS_REASONS },
  });
  cache.misses ??= { ...MISS_REASONS };
  cache.frames = (cache.frames ?? 0) + 1;
  if (contentFull !== undefined) {
    if (cache.lastContentFull != null && contentFull !== cache.lastContentFull) cache.contentChurn++;
    cache.lastContentFull = contentFull;
  }
  const key = {
    rev: state.entriesRev ?? 0,
    cam: cameraHash(camera),
    w, h, radius,
    content: contentVersion ?? null,
  };
  const prev = cache.key;
  // ⚠ ONE REASON PER LINE, NOT ONE BUCKET FOR ALL OF THEM. The first version of
  // this collapsed "the switch is off", "no ring live", "nothing cached yet"
  // and "the selection holds a skinned mesh" into a single `off`, and the probe
  // then reported `off:123` for a cache that was refusing to engage — a count
  // that named the symptom and hid all four candidate causes. Splitting them is
  // what identified the real one (a character under the building's prefab root)
  // in one run instead of four. An instrument that cannot distinguish its own
  // failure modes is not an instrument.
  let miss = null;
  if (/** @type {any} */ (globalThis).__outlineNoCache) miss = "disabled";
  else if (!prev || !state.stampObjects) miss = "cold";
  else if (!state.ringLive) miss = "notlive";
  else if (prev.rev !== key.rev) miss = "selection";
  else if (prev.cam !== key.cam) miss = "camera";
  else if (prev.w !== key.w || prev.h !== key.h) miss = "size";
  else if (prev.radius !== key.radius) miss = "dpi";
  else if (prev.content !== key.content) miss = "content";
  else {
    const fp = stampFingerprint(state.stampObjects);
    if (fp.stat !== cache.fpStat) {
      // ⭐ THE KEY SAID "NOTHING CHANGED" AND THE WALK DISAGREED, about
      // something that is not a pose — the same shape of hole contentKey.js's
      // `auditDisagreed` reports (a script writing straight through
      // `entity.position`, physics write-back, a geometry swap nobody
      // announced). Redrawing heals it on the spot; a CLIMBING `audits` is the
      // receipt that a producer is missing somewhere and should be fixed there.
      miss = "audit";
      cache.audits++;
    } else if (fp.anim !== cache.fpAnim) {
      // ⭐⭐ NOT A HOLE — AN ANIMATION IS PLAYING INSIDE THE SELECTION, and it
      // is kept a SEPARATE reason for two reasons that both matter. It would
      // otherwise be counted as `audit` and read as a bug in the producer set
      // (that is exactly how it read on Bistro at first: 66 "audits" on a
      // parked camera, which is alarming until you know that the scene's Player
      // rig sits under the same prefab root as the 1 535 building meshes and is
      // animating in the editor). And it names the ONE remaining cost on a
      // parked camera: one moving character forces all ~340 static draws to be
      // re-submitted, because the mask is one target that has to be cleared.
      // The fix, if that ever matters, is a second target holding the static
      // half — blit it, then draw only the movers on top. Not built: it is a
      // third render target and a new clear/blit path through the file's
      // stability contract, for a case that is free the moment nothing in the
      // selection is animating.
      miss = "pose";
    }
  }
  if (!miss) {
    cache.hits++;
    return true;
  }
  cache.misses[miss] = (cache.misses[miss] ?? 0) + 1;
  cache.lastMiss = miss;

  // Stamp the isolation layer. `visible` is forced only for meshes a SYSTEM
  // hid while still drawing them — a static-batching member renders through
  // its proxy, so its own flag says nothing about whether it is on screen
  // (batching.js sets it false by design). A mesh the USER hid stays hidden
  // and gets no outline, which is the honest answer.
  //
  // ⭐ WHOLE GROUPS COLLAPSE TO THEIR PROXY FIRST — see `coveredProxies`. What
  // is left in `state.entries` after that is only the meshes the main pass
  // draws individually anyway, so the mask pass now costs what the picture
  // costs instead of a multiple of it.
  const covered = coveredProxies(state.entries);
  const stamped = [];
  /** The objects the mask actually submits — what the next frame's audit walks. */
  const stampObjects = [];
  let hasActive = false;
  let hasSelected = false;
  for (const [proxy, active] of covered) {
    stamped.push({ mesh: proxy, mask: proxy.layers.mask, visible: proxy.visible });
    stampObjects.push(proxy);
    proxy.layers.mask = active ? ACTIVE_BIT : SELECTED_BIT;
    if (active) hasActive = true;
    else hasSelected = true;
  }
  for (const { mesh, active } of state.entries) {
    if (!mesh.parent) continue; // removed from the scene since we collected it
    const proxy = proxyOf(mesh);
    if (proxy && covered.has(proxy)) continue; // its proxy carries it
    const forceVisible = !mesh.visible && !!proxy;
    if (!mesh.visible && !forceVisible) continue;
    stamped.push({ mesh, mask: mesh.layers.mask, visible: mesh.visible });
    stampObjects.push(mesh);
    mesh.layers.mask = active ? ACTIVE_BIT : SELECTED_BIT;
    if (forceVisible) mesh.visible = true;
    if (active) hasActive = true;
    else hasSelected = true;
  }
  if (stamped.length === 0) {
    clearRing(renderer);
    return false;
  }
  // ⚠ `render.drawCalls`, NOT `render.calls`. The latter counts RENDER CALLS —
  // one per `renderer.render()` — so it reported "1" for a pass submitting 850
  // draws, and the first run of the probe printed "1 mask draw" for the exact
  // pass this change exists to shrink. `drawCalls`
  // accumulates per draw and resets once per animation frame (Info.reset), so a
  // delta across this synchronous block is exactly this pass.
  const callsBefore = renderer.info?.render?.drawCalls ?? 0;
  let maskDraws = 0;

  // Cast: three's own runtime takes `(renderer, scene, state)` for both of
  // these — its shipped `@types` declaration drops the `scene` parameter.
  const utils = /** @type {any} */ (THREE.RendererUtils);
  const rendererState = utils.resetRendererAndSceneState(renderer, scene);
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevAutoClearColor = renderer.autoClearColor;
  const prevAutoClearDepth = renderer.autoClearDepth;
  const prevCameraMask = camera.layers.mask;
  // Belt to precompileSelectionOutlineMasks' guard: the narrowed camera layers
  // already keep lights out of these renders, but a shadow update inside a
  // nested override render is the empty-fragment-struct pipeline trap, and
  // this is cheap insurance against a light ever landing on a mask layer.
  const prevShadows = renderer.shadowMap.enabled;
  try {
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(state.maskTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.autoClearColor = true;
    renderer.autoClearDepth = true;

    // Two draws because `scene.overrideMaterial` is a scene-wide switch: one
    // per channel, each seeing only its own layer bit. The second must not
    // clear what the first wrote.
    if (hasSelected) {
      scene.overrideMaterial = state.maskSelectedMaterial;
      camera.layers.mask = SELECTED_BIT;
      renderer.render(scene, camera);
      renderer.autoClear = false;
      renderer.autoClearColor = false;
    }
    if (hasActive) {
      scene.overrideMaterial = state.maskActiveMaterial;
      camera.layers.mask = ACTIVE_BIT;
      renderer.render(scene, camera);
    }
    scene.overrideMaterial = null;
    // The receipt the whole fix is judged on: how many draws the mask pass
    // actually submitted, counted by the renderer rather than inferred from
    // the stamp list (frustum culling removes some of what we stamped).
    // `info` is reset once per animation frame, so a delta taken inside this
    // synchronous block is exactly this pass. Read before the dilate quad so
    // the number is geometry draws, not geometry + 1.
    maskDraws = (renderer.info?.render?.drawCalls ?? 0) - callsBefore;

    renderer.setRenderTarget(state.dilateTarget);
    renderer.autoClear = true;
    renderer.autoClearColor = true;
    state.quad.material = state.dilateMaterial;
    state.quad.render(renderer);
  } finally {
    camera.layers.mask = prevCameraMask;
    for (const { mesh, mask, visible } of stamped) {
      mesh.layers.mask = mask;
      mesh.visible = visible;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.autoClearColor = prevAutoClearColor;
    renderer.autoClearDepth = prevAutoClearDepth;
    renderer.shadowMap.enabled = prevShadows;
    utils.restoreRendererAndSceneState(renderer, scene, rendererState);
  }
  // AFTER the restore, never inside the stamped window: the loop above forces
  // merged members visible and rewrites their layer bits, and a fingerprint
  // taken there would describe a state no later frame can ever reproduce —
  // every subsequent frame would "detect a change" and redraw.
  state.stampObjects = stampObjects;
  cache.key = key;
  {
    const fp = stampFingerprint(stampObjects);
    cache.fpStat = fp.stat;
    cache.fpAnim = fp.anim;
  }
  cache.renders++;
  state.stats = {
    entries: state.entries.length,
    proxies: covered.size,
    meshes: stamped.length - covered.size,
    stamped: stamped.length,
    maskDraws,
    animated: state.animated ?? 0,
    renders: cache.renders,
    hits: cache.hits,
    audits: cache.audits,
  };
  state.ringLive = true;
  return true;
}

/**
 * What the last mask pass did, for probes and `profile.*` receipts.
 *
 * `maskDraws` is the number this whole change exists to move: the draws the
 * mask pass submitted, counted by the renderer. `hits` is how many frames since
 * the last real render cost nothing at all, and `audits` is how many times the
 * declared cache key claimed "unchanged" while the stamp-list walk disagreed —
 * a non-zero, CLIMBING audits count means a producer is missing, exactly as
 * contentKey.js describes.
 */
/**
 * The live mask/dilate targets — for a probe that needs to read the ring back
 * as PIXELS. Not part of the effect's contract: nothing in the editor may hold
 * these across a `renderer-rebuilt` (see the stability note on
 * applySelectionOutlineOverlay), and nothing may render into them.
 */
export function selectionOutlineTargets() {
  return { mask: state.maskTarget, dilate: state.dilateTarget };
}

export function selectionOutlineStats() {
  return {
    ...(state.stats ?? { entries: 0, proxies: 0, meshes: 0, stamped: 0, maskDraws: 0 }),
    ringLive: state.ringLive,
    hits: state.cache?.hits ?? 0,
    renders: state.cache?.renders ?? 0,
    audits: state.cache?.audits ?? 0,
    // WHY it re-rendered, by reason. Read this before concluding the cache
    // does not work: "never hits" is the same observation for six different
    // causes, and only this separates them.
    misses: { ...(state.cache?.misses ?? {}) },
    lastMiss: state.cache?.lastMiss ?? null,
    // Frames this function was asked for a mask, and how many of them saw
    // `engine.content.version` move. A churn equal to `frames` is the receipt
    // that the broad content key is unusable as a cache term on this scene.
    frames: state.cache?.frames ?? 0,
    contentChurn: state.cache?.contentChurn ?? 0,
  };
}

/**
 * Clears the mask/dilate targets the frame the ring should disappear
 * (deselection, play mode, disabled). One real GPU clear, then nothing until
 * the next selection — the overlay/composite read transparent black and draw
 * no ring. Freshly created WebGPU textures are zero-initialized by spec, so a
 * never-rendered target needs no clear.
 */
function clearRing(renderer) {
  // Unconditionally, even on the early return: the cache holds the ONLY reason
  // a later frame may skip the mask render, and a cleared (or never-rendered)
  // target must never be reachable through it. Dropping `stampObjects` here
  // also lets go of the meshes — a deselected subtree must not stay pinned.
  if (state.cache) state.cache.key = null;
  state.stampObjects = null;
  if (!state.ringLive) return;
  state.ringLive = false;
  if (!state.maskTarget || !renderer) return;
  const prevTarget = renderer.getRenderTarget();
  const prevColor = new THREE.Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();
  try {
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(state.maskTarget);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(state.dilateTarget);
    renderer.clear(true, false, false);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
  }
}

/**
 * Draws the finished ring over `target` (the canvas when null) as ONE
 * fullscreen quad — no nested scene renders, no camera or layer state.
 *
 * Only for frames the engine renders DIRECTLY (`renderer.render`). When a
 * postprocess pipeline owns the frame, do not call this — the ring composites
 * inside the pipeline via applySelectionOutlineOverlay instead, because even
 * a single manual target swap after `RenderPipeline.render()` lands in the
 * corruption class documented at the top of updateSelectionOutlineMask.
 *
 * @param {object} options
 * @param {THREE.WebGPURenderer} options.renderer
 * @param {THREE.RenderTarget|null} [options.target]
 * @return {boolean} True when the quad was drawn.
 */
export function compositeSelectionOutline({ renderer, target = null }) {
  if (!renderer || !state.ringLive || !state.compositeMaterial || !state.quad) return false;
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevAutoClearColor = renderer.autoClearColor;
  const prevAutoClearDepth = renderer.autoClearDepth;
  try {
    // autoClear off or the WebGPU pass starts with `loadOp: Clear` and wipes
    // everything drawn before us.
    renderer.setRenderTarget(target);
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    state.quad.material = state.compositeMaterial;
    state.quad.render(renderer);
  } finally {
    renderer.autoClear = prevAutoClear;
    renderer.autoClearColor = prevAutoClearColor;
    renderer.autoClearDepth = prevAutoClearDepth;
    renderer.setRenderTarget(prevTarget);
  }
  return true;
}

/**
 * Mask + composite in one call — the OFFSCREEN path (viewport.screenshot ops),
 * which owns its whole render sequence and passes an explicit target. The live
 * viewport must NOT use this: its two halves belong to different frame phases
 * (see updateSelectionOutlineMask).
 */
export function renderSelectionOutline({ renderer, scene, camera, target = null, width, height, pixelRatio }) {
  if (!updateSelectionOutlineMask({ renderer, scene, camera, width, height, pixelRatio })) return false;
  return compositeSelectionOutline({ renderer, target });
}

/**
 * Wraps a postprocess chain's output colour with the selection ring — the
 * "separate pass" that lets the outline coexist with the postprocessing
 * module. PostprocessComponent calls this (via `engine.viewportOverlayNode`)
 * once per pipeline compile; selection changes only change the CONTENT of the
 * mask/dilate textures, never the node graph, so selecting never rebuilds the
 * postprocess pipeline.
 *
 * Stability contract: the targets are created here if they don't exist yet
 * (2×2, zero-filled ⇒ no ring) and are only ever `setSize`d afterwards, which
 * keeps the texture OBJECTS the pipeline binds valid. disposeSelectionOutline
 * breaks that contract, which is why it must only run on `renderer-rebuilt` —
 * the same event that rebuilds every postprocess pipeline anyway.
 *
 * The vertical-dilate tap loop is unrolled to MAX_RADIUS and each tap is
 * gated by a radius uniform, so a DPI change (radius change) is a uniform
 * write, not a recompile. The ring colour passes through the pipeline's tone
 * mapping, so it reads a touch dimmer than the direct-render path's — a known,
 * accepted difference.
 *
 * @param {any} colorNode The chain's output colour node.
 * @return {any} The colour node with the ring mixed in.
 */
export function applySelectionOutlineOverlay(colorNode) {
  if (!state.texel) state.texel = uniform(new THREE.Vector2(0.5, 0.5));
  if (!state.maskTarget) {
    state.maskTarget = makeTarget(2, 2, "selectionOutlineMask");
    state.dilateTarget = makeTarget(2, 2, "selectionOutlineDilate");
  }
  state.overlayRadiusU ??= uniform(0);
  const maskTexture = state.maskTarget.texture;
  const dilateTexture = state.dilateTarget.texture;
  const texel = state.texel;
  const radiusU = state.overlayRadiusU;
  const activeColor = uniform(new THREE.Color(ACTIVE_COLOR));
  const selectedColor = uniform(new THREE.Color(SELECTED_COLOR));
  return Fn(() => {
    const base = uv();
    let grown = /** @type {any} */ (texture(dilateTexture, base));
    for (let i = 1; i <= MAX_RADIUS; i++) {
      const gate = step(float(i), radiusU);
      const offset = vec2(0, texel.y.mul(i));
      grown = max(grown, texture(dilateTexture, base.add(offset)).mul(gate));
      grown = max(grown, texture(dilateTexture, base.sub(offset)).mul(gate));
    }
    const mask = texture(maskTexture, base);
    // Same ring maths as the composite material — see buildFullscreenMaterials
    // for why BOTH channels subtract.
    const inside = max(mask.r, mask.g);
    const edge = max(grown.r, grown.g).mul(inside.oneMinus());
    const ring = mix(selectedColor, activeColor, step(0.5, grown.g));
    const beauty = vec4(colorNode);
    return vec4(mix(beauty.rgb, ring, edge), beauty.a);
  })();
}

/**
 * Pre-compiles the mask materials' render pipelines against every mesh
 * currently in view, so selecting an object never compiles mid-frame.
 *
 * WHY: a WebGPU render pipeline is per material × geometry layout × render
 * context. The mask pass draws the selected meshes with an override material
 * into its own RGBA8/no-depth target, so the FIRST time any given mesh is
 * selected, that pipeline does not exist yet and compiles synchronously inside
 * the frame — the reported "it lags each time I select another object".
 * `renderer.compileAsync` walks the same projection path `render` does, so
 * running it with the override + the mask target bound builds exactly the
 * pipelines the mask pass will ask for, off the critical path.
 *
 * compileAsync's setup (projection, render-object creation, pipeline REQUESTS)
 * is synchronous — its only awaits are `init()` (already done) and the final
 * pipeline promises — so the override/target are restored immediately after
 * the call returns and the compiles finish in the background.
 *
 * LIMIT: `compileAsync` frustum-culls, so this warms the meshes the camera can
 * currently see — which covers click-selection by construction. Selecting an
 * OFF-SCREEN entity from the hierarchy can still compile on first draw; call
 * this again after big camera jumps if that ever reads as a hitch.
 */
export async function precompileSelectionOutlineMasks({ renderer, scene, camera }) {
  if (!renderer || !scene || !camera) return;
  if (!state.maskSelectedMaterial) {
    state.maskSelectedMaterial = makeMaskMaterial("selected");
    state.maskActiveMaterial = makeMaskMaterial("active");
  }
  if (!state.maskTarget) {
    state.maskTarget = makeTarget(2, 2, "selectionOutlineMask");
    state.dilateTarget = makeTarget(2, 2, "selectionOutlineDilate");
  }
  // ⚠ LIGHTS MUST BE HIDDEN DURING THE PROJECTION, for two reasons that both
  // matter. (1) With a light in the render list, compileAsync ALSO compiles
  // the shadow-map pass, and the shadow pass applies scene.overrideMaterial —
  // compiling this colorNode material into a depth-only context whose
  // fragment output struct is EMPTY: an invalid WGSL pipeline ("structures
  // must have at least one member"), the exact class that poisoned command
  // buffers via the occluder pass. (2) Pipelines key on the lights node, and
  // the REAL mask pass renders with camera layers that exclude every light —
  // warming with lights hidden builds exactly the no-lights variant the mask
  // pass will bind. Hide → synchronous projection → restore happens inside
  // one JS task per material, so no rendered frame ever sees the scene dark.
  const lights = [];
  scene.traverse((obj) => {
    if (obj.isLight && obj.visible) lights.push(obj);
  });
  for (const material of [state.maskSelectedMaterial, state.maskActiveMaterial]) {
    const prevOverride = scene.overrideMaterial;
    const prevTarget = renderer.getRenderTarget();
    // (3) MRT must be NULLED, not merely inherited: GI's compile wave pins the
    // postprocess pass's MRT on the renderer across a multi-second await
    // (PassNode.compileAsync restores only at the end), and this warm can run
    // inside that window. Compiling the mask — or the scene BACKGROUND, which
    // ignores overrideMaterial — under that leaked MRT builds fragments whose
    // output struct is EMPTY: the same invalid-pipeline class as (1). Seen
    // live 2026-08-14 as "fragment_Background.material: structures must have
    // at least one member" during boot on the user's Sponza.
    const prevMrt = renderer.getMRT();
    let pending = null;
    try {
      for (const light of lights) light.visible = false;
      scene.overrideMaterial = material;
      renderer.setRenderTarget(state.maskTarget);
      renderer.setMRT(null);
      pending = renderer.compileAsync(scene, camera);
    } finally {
      renderer.setMRT(prevMrt);
      renderer.setRenderTarget(prevTarget);
      scene.overrideMaterial = prevOverride;
      for (const light of lights) light.visible = true;
    }
    await pending;
  }
}

/** Frees the targets and materials. The selection itself is forgotten too. */
export function disposeSelectionOutline() {
  state.maskTarget?.dispose();
  state.dilateTarget?.dispose();
  state.maskSelectedMaterial?.dispose();
  state.maskActiveMaterial?.dispose();
  state.dilateMaterial?.dispose();
  state.compositeMaterial?.dispose();
  state.maskTarget = null;
  state.dilateTarget = null;
  state.maskSelectedMaterial = null;
  state.maskActiveMaterial = null;
  state.dilateMaterial = null;
  state.compositeMaterial = null;
  state.quad = null;
  state.radius = 0;
  state.ringLive = false;
  state.roots = [];
  state.activeRoot = null;
  state.entries = [];
  // The targets these described are gone; a surviving key would let the next
  // frame skip the render that has to repopulate the NEW ones.
  state.cache = null;
  state.stampObjects = null;
  state.stats = null;
}
