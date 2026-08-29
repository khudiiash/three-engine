/**
 * GI compute-node eviction (src/modules/gi/releaseCompute.js).
 *
 *   node scripts/run-gi-compute-release-test.mjs
 *
 * WHAT THIS GUARDS. `GISystem#dispose` used to assume GC would reclaim a
 * finished build's compute work: "storage buffers are released with GC once
 * nothing references them". True of the scene graph, false of the renderer —
 * three keeps every dispatched compute node in `renderer._pipelines`/`_bindings`,
 * and a bind group holds strong references to every buffer it binds. Rebuilds
 * mint fresh nodes and three keys pipelines on node id, so nothing is ever
 * evicted: 516 pipelines for 68 kernels on Bistro, and ~2 GB of JS heap per GI
 * settings change (13.4 GB killed the WebGPU device outright, 2026-08-17).
 *
 * The risk here is UNDER-COLLECTION, and it is silent: a node the walk misses
 * is simply never evicted and the leak comes back for that pass only. The first
 * implementation used a key allowlist and missed `screen.resolve.compute`
 * because the wrapper hangs off `resolve` — so most of these check that the
 * walk still reaches every shape a pass can take, including ones added later.
 *
 * The other risk is walking too far: `state.light` is a real Object3D, and
 * following it climbs `parent` into the whole scene graph.
 */
import assert from "node:assert/strict";

const {
  collectStateComputeNodes,
  collectStateStorageAttributes,
  harvestStorageAttributes,
  releaseComputeNodes,
  releaseStorageAttributes,
} = await import("../src/modules/gi/releaseCompute.js");

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

/** three marks compute nodes with `isComputeNode`; that is the only signal. */
const node = (id) => ({ isComputeNode: true, id });

/** A renderer whose caches record what was evicted, in order. */
const spyRenderer = () => {
  const evicted = [];
  return {
    evicted,
    // `has`/`get` mirror three's real Bindings (a DataMap of per-node state):
    // releaseComputeNodes probes them BEFORE evicting, because `deleteForCompute`
    // on a node Bindings never initialized over-decrements the SHARED render
    // bind group's `usedTimes` and destroys a uniform buffer the scene is still
    // bound to (measured: 49 uncaptured device errors across four resize hops).
    _bindings: {
      has: (n) => n?.initialized === true,
      get: (n) => (n?.initialized ? { bindings: [] } : undefined),
      deleteForCompute: (n) => evicted.push(`bind:${n.id}`),
    },
    _pipelines: { delete: (n) => evicted.push(`pipe:${n.id}`) },
    _nodes: { delete: (n) => evicted.push(`node:${n.id}`) },
  };
};

const ids = (nodes) => nodes.map((n) => n.id).sort((a, b) => a - b);

check("collects a screen pass reached through its wrapper (screen.<pass>.compute)", () => {
  // The shape the allowlist version missed. `resolve` is not a name any hand
  // written field list would have predicted, and every screen pass looks
  // like this — so this is the case that must never regress.
  const a = node(1);
  const found = collectStateComputeNodes({ screen: { resolve: { compute: a } } });
  assert.deepEqual(ids(found), [1], "screen.resolve.compute must be collected");
});

check("collects from a passes array, a queue, and several wrappers at once", () => {
  const [a, b, c, d] = [node(1), node(2), node(3), node(4)];
  const found = collectStateComputeNodes({
    screen: { resolve: { compute: a }, lightShadowPass: { compute: d }, srcProbes: { passes: [b, c] } },
    queue: [c],
  });
  assert.deepEqual(ids(found), [1, 2, 3, 4]);
});

check("collects a pass added under a name nothing here knows about", () => {
  // The whole point of a general walk: a kernel added next year, hung off a
  // field invented next year, still gets evicted.
  const a = node(7);
  const found = collectStateComputeNodes({ screen: { someFuturePass: { compute: a } } });
  assert.deepEqual(ids(found), [7], "a general walk must not depend on the field's name");
});

check("de-duplicates a node reachable by more than one path", () => {
  const a = node(1);
  const found = collectStateComputeNodes({ queue: [a, a], screen: { srcProbes: { passes: [a] } } });
  assert.equal(found.length, 1, "evicting the same node twice would be a wasted recompile");
});

check("does NOT walk into the scene graph via state.light", () => {
  // `state.light` is a real Object3D whose `parent` reaches the scene and every
  // object in it. Following it would be slow and would collect nodes belonging
  // to systems this build does not own.
  const scene = { isObject3D: true, children: [] };
  const light = { isObject3D: true, parent: scene, stray: node(99) };
  scene.children.push(light);
  const found = collectStateComputeNodes({ light, queue: [node(1)] });
  assert.deepEqual(ids(found), [1], "nothing below an Object3D may be collected");
});

check("survives a cyclic state without hanging", () => {
  const state = { queue: [node(1)] };
  state.screen = state;
  assert.deepEqual(ids(collectStateComputeNodes(state)), [1]);
});

check("evicts all THREE caches, bindings first and the node builder state last", () => {
  // Order is load-bearing. `Bindings.deleteForCompute` falls back to
  // `nodes.getForCompute(node)` to find the bind groups when its own entry is
  // gone, so the builder state must outlive it — dropping `_nodes` first would
  // make that lookup REBUILD the state we are discarding. And the bind groups
  // are what hold the buffers this whole fix exists to free.
  const renderer = spyRenderer();
  releaseComputeNodes(renderer, [{ isComputeNode: true, id: 1, initialized: true }]);
  assert.deepEqual(renderer.evicted, ["bind:1", "pipe:1", "node:1"]);
});

check("skips Bindings for a node Bindings never initialized", () => {
  // The crash guard: `deleteForCompute` on a never-dispatched node over-
  // decrements the SHARED render bind group's `usedTimes` (one BindGroup
  // instance shared by every render object and compute node) and destroys a
  // uniform buffer the whole scene still binds. A node with no Bindings entry
  // owns no bind group — skipping is the correct refcount, not a leak.
  const renderer = spyRenderer();
  releaseComputeNodes(renderer, [node(1)]);
  assert.deepEqual(renderer.evicted, ["pipe:1", "node:1"], "no bind eviction");
});

check("clearing only bindings+pipelines is NOT enough — _nodes must be evicted", () => {
  // Measured live: with `_nodes` left alone the heap still climbed 3223 → 4625
  // MB across a single GI quality change, because NodeManager holds each
  // compute node's builder state and that references the bindings.
  const renderer = spyRenderer();
  releaseComputeNodes(renderer, [node(1)]);
  assert.ok(
    renderer.evicted.includes("node:1"),
    "the NodeManager entry is the one that kept ~1.4 GB per rebuild alive",
  );
});

check("a node that was never dispatched does not abort the sweep", () => {
  // A build torn down mid compile-wave has nodes with no cache entry at all;
  // three throws rather than no-op. The rest of the generation must still go.
  const seen = [];
  const renderer = {
    _bindings: {
      has: (n) => n.initialized === true,
      get: (n) => (n.initialized ? { bindings: [] } : undefined),
      deleteForCompute: (n) => {
        if (n.id === 1) throw new Error("never dispatched");
        seen.push(n.id);
      },
    },
    _pipelines: { delete: () => {} },
  };
  const released = releaseComputeNodes(renderer, [
    { isComputeNode: true, id: 1, initialized: true },
    { isComputeNode: true, id: 2, initialized: true },
    { isComputeNode: true, id: 3, initialized: true },
  ]);
  assert.deepEqual(seen, [2, 3], "nodes after the throwing one must still be evicted");
  assert.equal(released, 2, "the failed node must not be counted as released");
});

check("degrades to a no-op if three renames its caches", () => {
  // These are underscore-private. A three upgrade must cost us the leak we
  // already had, never a crash in the middle of a rebuild.
  assert.equal(releaseComputeNodes({}, [node(1)]), 0);
  assert.equal(releaseComputeNodes(null, [node(1)]), 0);
  assert.equal(releaseComputeNodes(spyRenderer(), null), 0);
});

check("ignores non-nodes handed to it", () => {
  const renderer = spyRenderer();
  releaseComputeNodes(renderer, [null, undefined, 42, "compute", { isComputeNode: true, id: 5, initialized: true }]);
  assert.deepEqual(renderer.evicted, ["bind:5", "pipe:5", "node:5"]);
});


// ════════════════════════════════════════════════════════ — THE BUFFERS
//
// Everything above evicts NODES. Measured on Bistro (three ultra↔high
// rebuilds): +1,853 MB of live GPU storage per rebuild with every storage
// bucket reading `gone 0`, because `Bindings._destroyBindings` (three,
// Bindings.js:245-289) has branches for uniform buffers and samplers and NONE
// for storage buffers. The only path to `GPUBuffer.destroy()` is
// `renderer._attributes.delete`, and these guard it.

/** A `StorageInstancedBufferAttribute` stand-in. */
const attr = (id, bytes = 4) => ({
  isBufferAttribute: true, id, array: new Uint32Array(bytes / 4),
});

/**
 * A renderer whose `_attributes`/`backend` behave like three's: `delete`
 * destroys, `has` is honest, and `info.memoryMap` pins every attribute ever
 * bound (Info.js:145 — a plain Map whose only `delete` is the one below).
 */
const bufferRenderer = (bound = []) => {
  const live = new Set(bound);
  const memoryMap = new Map(bound.map((a) => [a, { size: 1, type: "storageAttributes" }]));
  const deletes = [];
  return {
    deletes, live, memoryMap,
    _attributes: {
      has: (a) => live.has(a),
      delete: (a) => { deletes.push(a.id); live.delete(a); memoryMap.delete(a); },
    },
    backend: { has: (a) => live.has(a) },
    info: { memoryMap },
  };
};

check("destroys exactly once per bound attribute", () => {
  const a = attr(1), b = attr(2);
  const r = bufferRenderer([a, b]);
  assert.equal(releaseStorageAttributes(r, [a, b]), 2);
  assert.deepEqual(r.deletes, [1, 2]);
  assert.equal(r.memoryMap.size, 0, "info.memoryMap must stop pinning them");
});

check("no-ops on an attribute the backend never bound, and still unpins it", () => {
  // ⚠ THE CRASH THIS GUARDS: `WebGPUAttributeUtils.destroyAttribute` (:361-370)
  // does `backend.get(attr).buffer.destroy()` with no null check, and
  // `DataMap.get` CREATES the record — so one earlier `get` on an unbound
  // attribute is enough to walk `Attributes.delete` into `undefined.destroy()`.
  const ghost = attr(9);
  const r = bufferRenderer([]);
  r.memoryMap.set(ghost, { size: 1, type: "storageAttributes" });
  assert.equal(releaseStorageAttributes(r, [ghost]), 0, "must not call delete");
  assert.deepEqual(r.deletes, []);
  assert.equal(r.memoryMap.has(ghost), false, "the Map entry must still go");
});

check("is idempotent — a second release destroys nothing", () => {
  const a = attr(1);
  const r = bufferRenderer([a]);
  releaseStorageAttributes(r, [a]);
  assert.equal(releaseStorageAttributes(r, [a]), 0);
  assert.deepEqual(r.deletes, [1], "exactly one delete for one attribute");
});

check("storage release degrades to a no-op if three renames its caches", () => {
  assert.equal(releaseStorageAttributes({}, [attr(1)]), 0);
  assert.equal(releaseStorageAttributes(null, [attr(1)]), 0);
  assert.equal(releaseStorageAttributes(bufferRenderer(), null), 0);
});

/** A node carrying a three-shaped `nodeBuilderState.bindings`. */
const boundNode = (id, attributes) => {
  const n = node(id);
  n.__bindings = [{
    bindings: attributes.map((a) => ({
      isStorageBuffer: true, nodeUniform: { value: a }, _buffer: a.array,
      _attribute: a, get attribute() { return this.nodeUniform.value; },
    })),
  }];
  return n;
};
const nodeStateRenderer = () => {
  const evicted = [];
  const _nodes = {
    getForComputeCalls: 0,
    has: (n) => n.__bindings !== undefined,
    get: (n) => ({ nodeBuilderState: { bindings: n.__bindings } }),
    delete: () => {},
    getForCompute() { _nodes.getForComputeCalls++; throw new Error("must never be called"); },
  };
  return {
    evicted, _nodes,
    _bindings: { deleteForCompute: (n) => evicted.push(`bind:${n.id}`) },
    _pipelines: { delete: () => {} },
  };
};

check("harvests what a node bound, and never calls getForCompute", () => {
  // ⚠ `NodeManager.getForCompute` (:451-471) REBUILDS the state it cannot
  // find — on this project's SRC kernels a 16-27 s recompile of exactly the
  // generation being discarded. `has` before `get`, never getForCompute.
  const a = attr(1), b = attr(2);
  const r = nodeStateRenderer();
  const harvest = new Set();
  releaseComputeNodes(r, [boundNode(10, [a, b])], harvest);
  assert.deepEqual([...harvest].map((x) => x.id).sort(), [1, 2]);
  assert.equal(r._nodes.getForComputeCalls, 0);
});

check("nulls the bind group's captured CPU array on the way out", () => {
  const a = attr(1, 64);
  const n = boundNode(10, [a]);
  const binding = n.__bindings[0].bindings[0];
  releaseComputeNodes(nodeStateRenderer(), [n]);
  assert.equal(binding._buffer, null, "Buffer._buffer holds the full CPU twin");
  assert.equal(binding._attribute, null);
});

check("a survivor's attributes are the KEEP set, and harvest never evicts", () => {
  // The set difference is the whole safety argument: two passes routinely bind
  // the same buffer, and an in-place resize keeps NODES while swapping buffers
  // under them.
  const shared = attr(1), orphanOnly = attr(2);
  const r = nodeStateRenderer();
  const survivor = boundNode(20, [shared]);
  const keep = harvestStorageAttributes(r, [survivor]);
  assert.deepEqual([...keep].map((x) => x.id), [1]);
  assert.deepEqual(r.evicted, [], "harvesting must not evict anything");

  const harvest = new Set();
  releaseComputeNodes(r, [boundNode(10, [shared, orphanOnly])], harvest);
  const doomed = [...harvest].filter((x) => !keep.has(x)).map((x) => x.id);
  assert.deepEqual(doomed, [2], "the shared buffer must survive its orphan");
});

check("collectStateStorageAttributes reads both published lists, at depth", () => {
  const a = attr(1), b = attr(2), c = attr(3);
  const found = collectStateStorageAttributes({
    volume: { occupancyField: { get storageAttributes() { return [a]; } } },
    screen: { srcProbes: { get cpuMirrors() { return [b]; } }, bvhReflect: { pass: { storageAttributes: [c] } } },
  });
  assert.deepEqual(found.map((x) => x.id).sort(), [1, 2, 3]);
});

check("collectStateStorageAttributes does not climb into the scene graph", () => {
  // `state.light` is a real Object3D; following `parent` reaches every mesh.
  const trap = attr(9);
  const light = { isObject3D: true, parent: { storageAttributes: [trap] } };
  assert.deepEqual(collectStateStorageAttributes({ light }), []);
});

check("collectStateStorageAttributes survives a getter that throws", () => {
  const a = attr(1);
  const found = collectStateStorageAttributes({
    broken: { get storageAttributes() { throw new Error("not built yet"); } },
    ok: { storageAttributes: [a] },
  });
  assert.deepEqual(found.map((x) => x.id), [1]);
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
