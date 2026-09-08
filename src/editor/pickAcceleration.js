import * as THREE from "three/webgpu";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import { BudgetedQueue } from "../engine/scheduling.js";
import { freeze } from "../engine/freezeLedger.js";

/**
 * ⭐ PICKING WITHOUT A BRUTE-FORCE RAYCAST (docs/ZERO_FREEZE_PLAN.md §2.3,
 * Stage 5.1).
 *
 * The viewport's click handler is one
 * `raycaster.intersectObjects(engine.scene.children, true)` against stock
 * `THREE.Mesh.raycast`, which is a linear scan of EVERY TRIANGLE of every mesh
 * whose bounding sphere the ray crosses, collected into a sorted list of every
 * hit along the way. The same shape of loop, measured on the mesh editor's box
 * select over Sibenik's wall (`src/editor/mesh/viewport.js`), came to **1.3
 * billion ray-triangle tests on the main thread for one gesture**: "not slow,
 * indistinguishable from a hang". A click in a dense scene is the same
 * arithmetic, once.
 *
 * A bounds tree turns each mesh's query from O(triangles) into O(log
 * triangles). Two rules keep it from becoming its own freeze:
 *
 *   1. NEVER ON THE CLICK'S STACK. Building a tree over a million triangles is
 *      itself hundreds of milliseconds. The first click that would want one
 *      does the plain raycast and QUEUES the build; the queue drains in idle
 *      time and later clicks read the tree. A click is never made slower to
 *      make the next one faster.
 *   2. ONLY WHERE IT PAYS. Under PICK_BVH_MIN_TRIANGLES the stock scan is
 *      microseconds and the tree is pure memory, so small meshes keep the
 *      stock path. A whole-scene budget caps the total so a Bistro-class import
 *      cannot quietly cost hundreds of megabytes.
 *
 * `indirect: true` is deliberate: the default build REORDERS the geometry's
 * index buffer in place, and these are geometries the renderer is drawing this
 * frame. The indirect build leaves the index alone and pays one extra
 * Uint32Array of triangle ids instead — the right trade when the owner of the
 * buffer is the renderer and not us.
 *
 * Hatch: `globalThis.__editorPickBvh = false` — no trees are built and the
 * override falls straight through to stock `Mesh.raycast`.
 */

/** Below this a stock triangle scan is already microseconds. */
const PICK_BVH_MIN_TRIANGLES = 2_000;

/**
 * Total triangles we are willing to hold trees for. A MeshBVH costs roughly
 * 6-7 bytes per triangle of nodes plus 4 for the indirect buffer, so 12 M is
 * on the order of 130 MB — the point past which picking latency stops being
 * the scarce resource.
 */
const PICK_BVH_TRIANGLE_BUDGET = 12_000_000;

let builtTriangles = 0;
let scanQueued = false;

/** Builds drain in idle time; 500 ms is the longest a build may be starved. */
const bvhQueue = new BudgetedQueue({ sliceMs: 6, maxDelayMs: 500, name: "pickBvh" });

function triangleCount(geometry) {
  const index = geometry.index;
  if (index) return index.count / 3;
  return (geometry.attributes?.position?.count ?? 0) / 3;
}

/**
 * Installs the accelerated raycast on `THREE.Mesh.prototype`. Idempotent, and
 * safe for meshes that never get a tree: without `geometry.boundsTree` the
 * override is the stock function plus two property reads.
 */
export function installPickAcceleration() {
  // ⚠ The guard is on globalThis, not a module-level flag. Vite re-evaluates a
  // changed module under a new `?t=` URL (see vite/duplicateModuleGuard.js), so
  // a module-level `installed` resets to false while the PREVIOUS wrapper is
  // still on the prototype: the new install would capture that wrapper as its
  // "stock" function and every editor hot-reload would add a frame to every
  // raycast in the app, forever.
  if (globalThis.__pickRaycastInstalled) return;
  globalThis.__pickRaycastInstalled = true;
  const stockRaycast = THREE.Mesh.prototype.raycast;
  THREE.Mesh.prototype.raycast = function pickAcceleratedRaycast(raycaster, intersects) {
    const geometry = this.geometry;
    const tree = geometry?.boundsTree;
    if (tree) {
      // A tree over vertices that have since MOVED reports hits on geometry
      // that is not there — a silent wrong pick, which is worse than a slow
      // one. The position attribute's version is three's own "these vertices
      // changed" counter, so a stale tree is dropped rather than trusted.
      if (geometry.userData.pickBvhVersion === geometry.attributes?.position?.version) {
        acceleratedRaycast.call(this, raycaster, intersects);
        return;
      }
      builtTriangles = Math.max(0, builtTriangles - (geometry.userData.pickBvhTriangles ?? 0));
      geometry.boundsTree = null;
      geometry.userData.pickBvhTriangles = 0;
    }
    stockRaycast.call(this, raycaster, intersects);
  };
}

/**
 * Queues one scan of the scene, which queues one build per mesh that wants a
 * tree and has not got one. Cheap to call on every click: after the first it
 * is a boolean test until something invalidates it.
 */
export function schedulePickBoundsTrees(scene) {
  if (scanQueued || !scene || globalThis.__editorPickBvh === false) return;
  scanQueued = true;
  bvhQueue.push(() => {
    const pending = [];
    scene.traverse((object) => {
      if (!object.isMesh || object.isSkinnedMesh || object.isInstancedMesh || object.isBatchedMesh) return;
      const geometry = object.geometry;
      if (!geometry || geometry.boundsTree) return;
      // Editor-only overlays (gizmo pickers, collider outlines, the grid) are
      // either tiny or opt out of picking entirely; a tree for them is memory
      // spent on a mesh no ray will ever be tested against expensively.
      if (object.userData?.editorOnly) return;
      const triangles = triangleCount(geometry);
      if (triangles < PICK_BVH_MIN_TRIANGLES) return;
      pending.push({ geometry, triangles });
    });
    // Biggest first: the mesh that dominates a click's cost should be the one
    // covered when the budget runs out, not the one left over.
    pending.sort((a, b) => b.triangles - a.triangles);
    for (const { geometry, triangles } of pending) {
      bvhQueue.push(() => buildBoundsTree(geometry, triangles));
    }
  }, "pickBvh:scan");
}

function buildBoundsTree(geometry, triangles) {
  if (geometry.boundsTree || globalThis.__editorPickBvh === false) return;
  if (builtTriangles + triangles > PICK_BVH_TRIANGLE_BUDGET) return;
  const span = freeze.begin("pick:buildBoundsTree");
  try {
    geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
    geometry.userData.pickBvhVersion = geometry.attributes?.position?.version;
    geometry.userData.pickBvhTriangles = triangles;
    builtTriangles += triangles;
  } catch {
    // A degenerate or attribute-less geometry: leave it on the stock path.
    geometry.boundsTree = null;
  } finally {
    freeze.end(span);
  }
}

/**
 * Something added or replaced meshes, so the scene wants another scan. Existing
 * trees are kept — a tree is a property ON the geometry, so a geometry that
 * went away took its tree with it.
 */
export function invalidatePickBoundsTrees() {
  scanQueued = false;
}

/** For a receipt: how much of the budget the trees on screen are holding. */
export function pickBoundsTreeStats() {
  return { triangles: builtTriangles, budget: PICK_BVH_TRIANGLE_BUDGET, queued: bvhQueue.size };
}
