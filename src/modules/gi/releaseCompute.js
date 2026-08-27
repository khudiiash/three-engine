// @ts-check

/**
 * Evicts a GI build's compute nodes from the RENDERER's caches.
 *
 * ## Why `#dispose()` was not enough
 *
 * `GISystem#dispose` closes with:
 *
 *     // Compute nodes / storage buffers are released with GC once nothing
 *     // references them; three's storage attributes hold no scene-graph refs.
 *
 * True of the scene graph, false of the renderer. Every dispatched compute node
 * gets an entry in `renderer._pipelines` and `renderer._bindings`, and a BIND
 * GROUP holds strong references to every buffer and texture it binds. So the
 * old build's `bits` allocation (449 MB on Bistro), its occupancy field
 * (360 MB) and its SRC store (142 MB) stay reachable from the renderer after
 * `state.volume.dispose()` has run — `dispose()` frees the objects it knows
 * about and the renderer quietly keeps the memory.
 *
 * The tell is in the boot log: **516 pipelines compiled for 68 kernels**, about
 * 7.6 generations' worth. Every rebuild mints fresh compute nodes and three
 * keys pipelines on node id, so a rebuild is a guaranteed cache miss — the old
 * generation is never evicted, just orphaned in a cache that never shrinks.
 *
 * Measured symptom (user, 2026-08-17): "each time I change gi settings, it
 * rebuilds and memory heap is still climbing, currently having 6GB" — ~2 GB per
 * rebuild, flat while idle. At 13.4 GB the WebGPU device died outright
 * ("Instance dropped in popErrorScope").
 *
 * ## What this does
 *
 * `Bindings.deleteForCompute` destroys the bind groups (the thing actually
 * holding the buffers) and drops the node's cache entry; `Pipelines.delete`
 * drops the compiled pipeline. Both are three's own per-object eviction paths —
 * the same ones it calls when a compute node is disposed through channels GI
 * does not use.
 *
 * ⚠ ONLY EVER CALL THIS ON A NODE THE CALLER IS THROWING AWAY. Evicting a node
 * that is still dispatched costs a full recompile of that kernel — on this
 * project's SRC kernels that is 16-27 seconds, not a hitch.
 *
 * Defensive throughout: these are three's underscore-private caches (the same
 * ones `outputDither.js` already reaches into), so a three upgrade that renames
 * them must degrade to "leaks as before", never to a crash mid-rebuild.
 *
 * @param {any} renderer
 * @param {Iterable<any>} nodes
 * @param {?Set<any>} harvest when given, receives every STORAGE ATTRIBUTE the
 *   evicted nodes bound — read out of the builder state BEFORE it is dropped,
 *   because after the eviction nothing can enumerate it again. The caller owns
 *   the destroy (`releaseStorageAttributes`) and owns the set DIFFERENCE
 *   against the survivors: an attribute a surviving node still binds must
 *   never be destroyed.
 * @returns {number} how many nodes were evicted
 */
export function releaseComputeNodes(renderer, nodes, harvest = null) {
  if (!renderer || !nodes) return 0;
  const bindings = renderer._bindings;
  const pipelines = renderer._pipelines;
  // `renderer._nodes` is a `NodeManager extends DataMap` holding each compute
  // node's BUILDER STATE — which references the bindings, which reference the
  // buffers. Evicting bindings + pipelines without it still leaked ~1.4 GB per
  // GI rebuild on Bistro (measured 2026-08-17: heap 3223 → 4625 MB across one
  // quality change with only the first two caches cleared).
  const nodeCache = renderer._nodes;
  if (!bindings && !pipelines && !nodeCache) return 0;
  let released = 0;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    try {
      // ── §19 STAGE 0.2b: HARVEST BEFORE EVICTING ────────────────────────
      // `Bindings._destroyBindings` (three renderers/common/Bindings.js:245)
      // has branches for UNIFORM buffers and samplers and NONE for storage
      // buffers, so everything below frees the bind group and the pipeline and
      // leaves the GPU buffer — 1,853 MB per rebuild on Bistro, measured. The
      // only path to `GPUBuffer.destroy()` is `renderer._attributes.delete`,
      // and this builder state is the ONLY enumeration of what this node bound
      // that cannot go stale. Read it here or lose it.
      forEachStorageBinding(renderer, node, (binding) => {
        const attribute = binding.attribute;   // live getter on NodeStorageBuffer
        if (harvest && attribute) harvest.add(attribute);
        // §I.2 — `StorageBuffer` (StorageBuffer.js:19) passes `attribute.array`
        // to `Buffer` (Buffer.js:44), which stores it as `_buffer`, at FIRST
        // BIND. `NodeStorageBuffer` overrides both the `buffer` and `attribute`
        // getters, so nothing ever reads these two fields back — but they hold
        // the full CPU twin, and `detachCpuMirror`'s zero-length swap cannot
        // reach them. Null on the way out; `Buffer.release()` is three's own
        // name for exactly this move.
        if (binding.nodeUniform !== undefined) {
          binding._buffer = null;
          binding._attribute = null;
        }
      });
      // Bindings first: it reads `nodes.getForCompute(node)` to find the bind
      // groups when its own cache entry is already gone, so evicting the
      // pipeline first would leave the bind groups — and the buffers — alive.
      bindings?.deleteForCompute?.(node);
      pipelines?.delete?.(node);
      // LAST, and that is not cosmetic: `deleteForCompute` above falls back to
      // `nodes.getForCompute(node)` to find the bind groups when its own entry
      // has already gone. Dropping the builder state first would make that
      // lookup rebuild the very state we are trying to discard.
      nodeCache?.delete?.(node);
      released++;
    } catch {
      // A node that was never dispatched has no cache entry to delete. That is
      // the common case for a build torn down during its compile wave, and it
      // must not abort the rest of the sweep.
    }
  }
  return released;
}

/**
 * Walks the STORAGE BUFFER bindings of one or more compute nodes, out of
 * three's node-builder state.
 *
 * `renderer._nodes` is a `NodeManager extends DataMap`; `get(node)
 * .nodeBuilderState.bindings` is an array of `BindGroup`, each with its own
 * `.bindings` array of `Binding` objects — the same array
 * `Bindings._createBindings` (Bindings.js:200-224) walks to decide what to
 * create, and the `isStorageBuffer` branch there is what put every one of
 * these attributes into `renderer._attributes` and `info.memoryMap` in the
 * first place.
 *
 * ⚠ TWO RULES, BOTH LOAD-BEARING:
 *   · `has` BEFORE `get`. `DataMap.get` (DataMap.js:29-41) CREATES the record
 *     when it is missing, so probing a node that was never dispatched would
 *     seed a permanent empty entry.
 *   · NEVER `nodes.getForCompute(node)` (NodeManager.js:451-471). It REBUILDS
 *     the state it cannot find — on this project's SRC kernels a 16-27 s
 *     recompile, of exactly the generation we are throwing away.
 *
 * @param {any} renderer
 * @param {any} nodes a compute node, or an iterable of them
 * @param {(binding: any) => void} fn
 */
function forEachStorageBinding(renderer, nodes, fn) {
  const nodeCache = renderer?._nodes;
  if (!nodeCache || typeof nodeCache.has !== "function" || !nodes) return;
  const list = nodes[Symbol.iterator] && typeof nodes !== "function" ? nodes : [nodes];
  for (const node of list) {
    if (!node || typeof node !== "object") continue;
    let groups = null;
    try {
      if (nodeCache.has(node) !== true) continue;
      groups = nodeCache.get(node)?.nodeBuilderState?.bindings ?? null;
    } catch { continue; }
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const bindings = group?.bindings;
      if (!Array.isArray(bindings)) continue;
      for (const binding of bindings) {
        if (binding?.isStorageBuffer !== true) continue;
        try { fn(binding); } catch { /* one bad binding must not stop the sweep */ }
      }
    }
  }
}

/**
 * Every storage attribute the given (SURVIVING) compute nodes bind — the KEEP
 * set for a swap-site diff. Read-only: evicts nothing, nulls nothing.
 *
 * @param {any} renderer
 * @param {Iterable<any>} nodes
 * @param {Set<any>} [into]
 * @returns {Set<any>}
 */
export function harvestStorageAttributes(renderer, nodes, into = new Set()) {
  forEachStorageBinding(renderer, nodes, (binding) => {
    const attribute = binding.attribute;
    if (attribute) into.add(attribute);
  });
  return into;
}

/**
 * ⭐⭐ §19 STAGE 0.2b — THE ONLY PATH TO `GPUBuffer.destroy()` FOR A GI BUFFER.
 *
 * ## The chain, verified in three's own source
 *
 *   `renderer._attributes.delete(attr)`
 *     → `Attributes.delete` (renderers/common/Attributes.js:46-58): calls
 *       `super.delete` first (`DataMap.delete`, DataMap.js:49-64 — returns
 *       `null` when the map never held the object) and does the rest ONLY on a
 *       non-null result;
 *     → `backend.destroyAttribute(attr)` (WebGPUBackend.js:2595)
 *     → `WebGPUAttributeUtils.destroyAttribute` (:361-370):
 *       `backend.get(attr).buffer.destroy()` then `backend.delete(attr)`;
 *     → `info.destroyAttribute(attr)` (Info.js:324-338): `memoryMap.delete` and
 *       the `storageAttributes` / `storageAttributesSize` counters come back
 *       down.
 *
 * That last one is why nothing short of this frees anything.
 * `Info.memoryMap` (Info.js:145) is a plain **`Map`**, `_createAttribute`
 * (:264-273) `set`s every storage attribute into it at first bind, and its only
 * `delete` is the line above — so until this runs, the attribute is strongly
 * reachable from the renderer, the backend's `WeakMap` entry keyed by it can
 * never die, and the GPU buffer is not even GC-reclaimable. Measured on Bistro:
 * `memoryMap` +733/+790/+934 entries per rebuild, live GPU buffers +730/+763/
 * +927, `gone 0` for every single storage bucket.
 *
 * ## Why the two `has` guards are not defensive noise
 *
 * `WebGPUAttributeUtils.destroyAttribute` does `data.buffer.destroy()` with no
 * null check. `DataMap.get` CREATES a record, so a single earlier `get` on an
 * attribute that never bound leaves a seeded-but-empty `{}` — enough to make
 * `Attributes.delete` walk straight into `undefined.destroy()`. Probing BOTH
 * maps with `has` is what makes this safe on an attribute that never bound, and
 * idempotent on one already destroyed (the second call sees no entry).
 *
 * @param {any} renderer
 * @param {Iterable<any>} attrs storage ATTRIBUTES (`node.value`), not nodes
 * @returns {number} how many GPU buffers were destroyed
 */
export function releaseStorageAttributes(renderer, attrs) {
  const attributes = renderer?._attributes;
  const backend = renderer?.backend;
  if (!attributes || !attrs) return 0;
  let released = 0;
  for (const attr of attrs) {
    if (!attr) continue;
    try {
      if (attributes.has?.(attr) === true && backend?.has?.(attr) === true) {
        attributes.delete(attr);
        released++;
      } else {
        // Never bound (or already destroyed): there is no GPU buffer and no
        // backend record, but `info.memoryMap` may still be pinning it — drop
        // that and nothing else.
        renderer.info?.memoryMap?.delete?.(attr);
      }
      // ⚠ THE CPU TWIN DIES EITHER WAY, and that is deliberately OUTSIDE the
      // branch above: an attribute the backend never bound still carries its
      // full JS array, and "never reached the GPU" is not a reason to keep it.
      // `detachCpuMirror` may already have done this for a GPU-only buffer;
      // for the KEEP set (the CPU-written buffers — `vertexBuffer`, `pairWork`,
      // `localToWorld`, the region-uploader staging) this is the ONLY place it
      // ever happens, and by here the attribute is unbindable anyway.
      if (attr.array && attr.array.length > 0) {
        attr.__giBytes = attr.array.byteLength;
        attr.array = new attr.array.constructor(0);
      }
    } catch {
      // A three rename must degrade to "leaks as before", never to a crash
      // mid-rebuild.
    }
  }
  return released;
}

/**
 * §19 Stage 0.2b — §I.2, the half `detachCpuMirror` cannot reach on its own.
 *
 * `attr.array = new ctor(0)` frees nothing while the generation is LIVE,
 * because `Buffer._buffer` captured the original array at first bind, strictly
 * before the detach can run. That field lives on a `Binding` inside a
 * `BindGroup` inside a `NodeBuilderState` — reachable from the owning compute
 * NODE and from nowhere else (three's `_bindings` is a `WeakMap` keyed by bind
 * group, which cannot be enumerated). So the detach has to be walked back from
 * the nodes.
 *
 * Only ever nulls `_buffer` for an attribute the caller has ALREADY detached,
 * and only on a `NodeStorageBuffer` (`nodeUniform !== undefined`), whose
 * `buffer` and `attribute` getters both bypass these fields.
 *
 * @param {any} renderer
 * @param {Iterable<any>} nodes
 * @param {Iterable<any>|Set<any>} attrs the detached attributes
 * @returns {number} how many captures were dropped
 */
export function nullStorageBindingArrays(renderer, nodes, attrs) {
  if (!attrs) return 0;
  const want = attrs instanceof Set ? attrs : new Set(attrs);
  if (want.size === 0) return 0;
  let dropped = 0;
  forEachStorageBinding(renderer, nodes, (binding) => {
    if (binding.nodeUniform === undefined || binding._buffer === null) return;
    if (!want.has(binding.attribute)) return;
    binding._buffer = null;
    dropped++;
  });
  return dropped;
}

/**
 * Every storage ATTRIBUTE a GI `state` owns, from the owners' published lists.
 *
 * The sibling of `collectStateComputeNodes`, and it exists for the one class
 * the node harvest cannot cover: an attribute bound by something OUTSIDE the
 * compute nodes (a material's render pipeline), or by a node whose builder
 * state was already dropped. On a swap site this is also half of the KEEP set,
 * so under-collecting here destroys a live buffer — which is why every owner
 * publishes a SUPERSET of its `cpuMirrors` (the CPU-written buffers die at
 * teardown too, they just may not be detached).
 *
 * `storageAttributes` and `cpuMirrors` are GETTERS on the resizable owners, so
 * they are read, never walked into.
 *
 * @param {any} state
 * @returns {any[]}
 */
export function collectStateStorageAttributes(state) {
  const found = new Set();
  if (!state) return [];
  const seen = new Set();
  const take = (list) => {
    if (!Array.isArray(list)) return;
    for (const attr of list) if (attr?.isBufferAttribute === true) found.add(attr);
  };
  const visit = (value, depth) => {
    if (!value || depth > 6 || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    // Same bail-outs as `collectStateComputeNodes` (an Object3D would climb
    // `parent` into the whole scene graph), plus `isNode`: `state` is threaded
    // with TSL graphs that are large, cyclic and never own a published list.
    if (
      value.isObject3D === true || value.isTexture === true ||
      value.isMaterial === true || value.isRenderTarget === true ||
      value.isBufferGeometry === true || value.isRenderer === true ||
      value.isNode === true
    ) return;
    try { take(value.storageAttributes); } catch { /* a getter may not be ready */ }
    try { take(value.cpuMirrors); } catch { /* ditto */ }
    for (const key of Object.keys(value)) {
      if (key === "storageAttributes" || key === "cpuMirrors") continue;
      visit(value[key], depth + 1);
    }
  };
  visit(state, 0);
  return [...found];
}

/**
 * Purges three's MATERIAL node-builder cache.
 *
 * The compute-node eviction above did not stop the heap climbing (measured
 * 2026-08-17: an identical `high` config read 1992 MB on its first build and
 * 6394 MB two rebuilds later, with GPU texture memory returning to exactly
 * 118 MB both times — so the GPU side is clean and this is pure JS heap).
 *
 * The compute kernels were never the bulk. A GI rebuild re-injects GI's nodes
 * into EVERY material, and on this project each material's fragment shader is
 * 180-250 kB of WGSL over a node graph many times that size in JS objects —
 * 116 materials of it. `NodeManager.nodeBuilderCache` is a plain `Map` keyed by
 * a material CACHE KEY, so a rebuild does not overwrite the old entries, it
 * adds new ones beside them under new keys. Nothing prunes them: the per-object
 * `delete()` path only runs for objects three is told about, and a GI rebuild
 * tells it about nothing.
 *
 * `NodeManager.dispose()` is three's own reset for this (`this.nodeBuilderCache
 * = new Map()`), and calling it costs a rebuild of the node states — which is
 * exactly what the GI rebuild that follows is about to do anyway, so the work
 * is not additional, only the eviction is.
 *
 * ⚠ GLOBAL, NOT GI-SCOPED. This drops cached node state for post-processing and
 * every other material too. That is safe (three rebuilds lazily on next use)
 * but it is not free, so it belongs ONLY on a teardown that is already followed
 * by a full recompile. `__giPurgeNodeCache = false` disables it.
 *
 * @param {any} renderer
 * @returns {boolean} whether the cache was purged
 */
export function purgeNodeBuilderCache(renderer) {
  if (globalThis.__giPurgeNodeCache === false) return false;
  const nodeCache = renderer?._nodes;
  if (typeof nodeCache?.dispose !== "function") return false;
  try {
    nodeCache.dispose();
    return true;
  } catch {
    return false;
  }
}

/**
 * Every compute node a GI `state` owns, de-duplicated.
 *
 * Deliberately a SCAN rather than a hand-written field list: the chain is
 * assembled across a dozen sites (`queue.push(...)`, `srcProbes.passes.push`),
 * and a list that has to be updated whenever a pass is added would silently
 * stop covering the newest kernels — which is the failure mode that produced
 * this leak in the first place. `isComputeNode` is three's own marker.
 *
 * @param {any} state
 * @returns {any[]}
 */
export function collectStateComputeNodes(state) {
  const found = new Set();
  if (!state) return [];
  const seen = new Set();
  const visit = (value, depth) => {
    if (!value || depth > 4 || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    // three marks compute nodes with `isComputeNode`; `.compute` is the wrapper
    // shape GI stores for its screen passes (`screen.resolve.compute`).
    if (value.isComputeNode === true) {
      found.add(value);
      return;
    }
    // ⚠ A KEY ALLOWLIST IS NOT ENOUGH — the first version of this used one and
    // silently missed `screen.resolve.compute`, because the wrapper is reached
    // through `resolve`, a name no list would have predicted. Every screen pass
    // has that shape (`screen.<passName>.compute`), so the walk has to be
    // general or it under-collects exactly the newest passes.
    //
    // Bounded instead by depth + the `seen` set, plus these bail-outs: `state`
    // holds `state.light`, a real Object3D, and walking into it would climb
    // `parent` into the whole scene graph. Nothing below any of these is ever a
    // compute node.
    if (
      value.isObject3D === true || value.isTexture === true ||
      value.isMaterial === true || value.isRenderTarget === true ||
      value.isBufferGeometry === true || value.isRenderer === true
    ) return;
    for (const key of Object.keys(value)) visit(value[key], depth + 1);
  };
  visit(state, 0);
  return [...found];
}

/**
 * Drops the JS-side twin of a GPU-only storage buffer.
 *
 * ## The mechanism (verified against three r1xx
 * `WebGPUAttributeUtils.createAttribute`)
 *
 * `instancedArray(new Uint32Array(N))` builds a
 * `StorageInstancedBufferAttribute`. The FIRST time it is bound, three creates
 * the GPU buffer `mappedAtCreation` and does
 * `new array.constructor(buffer.getMappedRange()).set(array)` — one copy, then
 * `buffer.unmap()`. From that moment the JS array is dead weight: nothing reads
 * it again unless the owner writes it CPU-side and bumps `version`
 * (`Attributes.update` → `updateAttribute`, which is the ONLY other reader).
 *
 * On Bistro that dead weight is ~1.1 GB (`bits` alone is 449 MB), and it is
 * pinned for the process's life by the closure that allocated it.
 *
 * ## Why a zero-length view of the same constructor is the safe replacement
 *
 * Everything downstream that touches `.array` after upload reads only its TYPE,
 * never its contents or length:
 *
 *   · `BufferAttribute.count` is fixed at construction (`array.length /
 *     itemSize`) and is what every dispatch-count and binding-size path uses.
 *   · `NodeStorageBuffer.buffer` is a live getter over `nodeUniform.value.array`
 *     — so it follows the swap rather than pinning the old array (a stored
 *     reference would have made this unsafe; `StorageBuffer`'s base class DOES
 *     store one, and the node subclass overriding it is what saves us).
 *   · Bind-group creation reads `backend.get(binding.attribute).buffer` — the
 *     GPU buffer, never the CPU array (`WebGPUBindingUtils.createBindings`).
 *   · `getArrayBufferAsync` sizes its readback from `bufferGPU.size`.
 *   · `createShaderVertexBuffers` reads `array.BYTES_PER_ELEMENT`, which lives
 *     on the constructor — preserved by construction here.
 *
 * A DEVICE LOSS does not resurrect the need for the mirror: `renderer-rebuilt`
 * makes GISystem `#dispose()` and rebuild from scratch, so every buffer is
 * re-minted with a fresh array against the new device. Nothing ever re-uploads
 * a detached attribute (three re-creates a GPU buffer only when its
 * `Attributes` entry was deleted, which happens for geometry attributes through
 * `Geometries`' dispose handler and never for a standalone storage buffer).
 *
 * ⚠ NEVER call this on an attribute the owner writes CPU-side later
 * (`addUpdateRange` + `needsUpdate`). `updateAttribute` would then upload zero
 * bytes and the write would silently vanish. In GI that is the KEEP set:
 * `vertexBuffer`, `indexBuffer`, `pairWork`, `localToWorld`, the dynamic-object
 * staging/uploader buffers, and every `uniformArray`.
 *
 * @param {any} renderer
 * @param {any} attr a `StorageInstancedBufferAttribute` (`node.value`)
 * @returns {boolean} true when the mirror is gone (or was already gone); false
 *   when the buffer has not been uploaded yet — the caller retries next tick.
 */
export function detachCpuMirror(renderer, attr) {
  const array = attr?.array;
  if (!array) return false;
  if (array.length === 0) return true; // already detached
  const backend = renderer?.backend;
  // `has` before `get`: three's DataMap.get CREATES the entry, so probing with
  // `get` on an attribute that was never bound would seed a permanent empty
  // record for a buffer that may never exist.
  if (typeof backend?.has !== "function" || !backend.has(attr)) return false;
  let data = null;
  try { data = backend.get(attr); } catch { return false; }
  if (!data || data.buffer === undefined) return false;
  try {
    // BEFORE the swap — `readbackBits`' mappable-staging cap and the bits
    // ladder both size themselves off this, and reading 0 would make a 449 MB
    // buffer look free.
    attr.__giBytes = array.byteLength;
    attr.array = new array.constructor(0);
  } catch {
    return false;
  }
  // ── §19 STAGE 0.2b / §I.2: THE SWAP ABOVE FREES NOTHING ON ITS OWN ──────
  //
  // `NodeStorageBuffer`'s constructor chain
  // (NodeStorageBuffer.js:23 → StorageBuffer.js:19 → Buffer.js:44) stored
  // `attribute.array` as `Buffer._buffer` at FIRST BIND — strictly before this
  // function can run, because the GPU buffer has to exist for the guard above
  // to pass. So the 709-759 MB `[gi] detached N CPU mirrors` reports is a
  // bookkeeping line about the LIVE generation, not a free: the arrays stay
  // pinned until `_destroyBindings` drops the bind group, i.e. until the
  // teardown that would have dropped them anyway.
  //
  // `nullStorageBindingArrays` reaches the compute-side captures. This reaches
  // ALL of them, including a material's bind group, which is enumerable from
  // nowhere: detaching the ArrayBuffer frees the pages no matter who still
  // holds a view. Nothing reads it back — `NodeStorageBuffer` overrides the
  // `buffer` and `attribute` getters, `WebGPUBindingUtils.createBindings`
  // (:320-324) resolves a storage binding through `backend.get(attr).buffer`
  // (the GPU buffer), and the storage path never touches `Buffer.byteLength`.
  // `__giDetachTransfer = false` is the hatch.
  try {
    const buffer = array.buffer;
    if (
      globalThis.__giDetachTransfer !== false &&
      array.byteOffset === 0 && buffer && array.byteLength === buffer.byteLength &&
      typeof buffer.transfer === "function" && buffer.detached !== true
    ) {
      buffer.transfer(0);
    }
  } catch { /* older engine, or a shared buffer: the zero-length swap stands */ }
  return true;
}

/** Byte size of a storage attribute, mirror attached or not. */
export function cpuMirrorBytes(attr) {
  return attr?.__giBytes ?? attr?.array?.byteLength ?? 0;
}
