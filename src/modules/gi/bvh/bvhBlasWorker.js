// The exact-reflection BLAS builder, off the main thread.
//
// `bvhScene.js` packs one three-mesh-bvh `MeshBVH` per geometry into the flat
// buffers its GPU traversal reads. That build is an SAH-style partition over
// every triangle — ~200 ms for 200k triangles, one to two seconds for a 700k-
// triangle terrain — and it used to run synchronously inside `frame:preRender`
// every time a geometry was (re)seated. This worker takes COPIES of the
// position/index arrays and hands back the packed roots plus the index the
// build reordered, so the main thread only pays two memcpys and the pack.
//
// ⛔ NOT three-mesh-bvh's own `GenerateMeshBVHWorker`. That helper TRANSFERS
// the live geometry's `position.array.buffer` and `index.array.buffer` into
// the worker for the duration of the build (the renderer would upload a
// detached, zero-length attribute for one to two seconds), then swaps the
// geometry's arrays for the returned ones, and it re-applies
// `geometry.groups` inside the worker — which is exactly the multi-root
// build `packGeometryBlas` strips groups to avoid (a BoxGeometry has six).
//
// `buildBlasFromArrays` is exported as a pure function so the same code runs
// under plain node (tests, and the in-process fallback) with no Worker.
import { BufferAttribute, BufferGeometry } from "three";
import { MeshBVH } from "three-mesh-bvh";

/**
 * Builds one MeshBVH from flat copies of a geometry's arrays.
 *
 * @param {{ position: Float32Array, index: Uint32Array, options?: object|null }} job
 * @returns {{ roots: ArrayBuffer[], index: Uint32Array }} the packed BVH roots
 *   (three-mesh-bvh's 32-byte node layout) and the SAME `index` array, now in
 *   the triangle order the roots' leaf offsets refer to.
 */
export function buildBlasFromArrays({ position, index, options = null }) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3, false));
  geometry.setIndex(new BufferAttribute(index, 1, false));
  // No groups, on purpose: one BVH root (see packGeometryBlas in bvhScene.js).
  const bvh = new MeshBVH(geometry, { ...(options ?? {}) });
  return { roots: bvh._roots, index: geometry.index.array };
}

// Only a real worker scope installs the message handler — importing this
// module on the main thread or under node must be side-effect free.
const scope = typeof self !== "undefined"
  && typeof WorkerGlobalScope !== "undefined"
  && self instanceof WorkerGlobalScope
  ? self
  : null;

if (scope) {
  scope.onmessage = ({ data }) => {
    const { id, position, index, options } = data ?? {};
    try {
      const t0 = performance.now();
      const built = buildBlasFromArrays({ position, index, options });
      const transfer = [...built.roots, built.index.buffer];
      scope.postMessage({ id, roots: built.roots, index: built.index, buildMs: performance.now() - t0 }, transfer);
    } catch (error) {
      scope.postMessage({ id, error: String(error?.message ?? error) });
    }
  };
}
