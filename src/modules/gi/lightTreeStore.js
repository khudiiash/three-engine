// THE LIGHT TREE'S OWN HOME, FOR THE PATH THAT HAS NO OCCUPANCY FIELD
// (plan §19 Stage 3.5)
//
// ══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════
//
// The packed light tree (`lightTree.js` → `buildLightTree`) is a block of u32
// WORDS, and until now the only place it could live was the DYNAMIC OBJECT
// SET's bump allocator — `_dynSet.createRegionUploader`, which reserves words
// inside the occupancy field's `bits` buffer. That was a sound choice while
// the field existed: one allocator over one region, so the tree can never
// overlap a BVH block or a card table.
//
// Under `GI2_PATH` there IS no occupancy field and therefore no `_dynSet`, so
// the tree simply was not built — `__giLightTreeLive` stayed null and
// `test:gi-lighttree-mover` failed on "tree unreadable" rather than on
// anything it measures. Note what that hid: the failure was STRUCTURAL, and a
// structural failure and a real regression in `#refreshLightTree` present
// identically to the gate. The tree's own bookkeeping — the pose scan, the
// stable mesh order, the repack, the capacity refusal — never depended on the
// dynamic set at all. ONE call did.
//
// So this is that one call, standing on its own ~15 KB buffer instead of on
// 136 MB of someone else's.
//
// ══ WHY A STAGING BUFFER AND A COPY KERNEL, FOR OUR OWN BUFFER ══════════════
//
// Writing `bitsBuffer.value.array` and setting `needsUpdate` looks like it
// should be enough, and it is not: under GI2 nothing has BOUND the tree yet
// (its consumers — the NEE descent and the emitter tile cut — read
// `occupancyField.bits` and are off on this path), and a storage buffer no
// kernel ever binds is never created on the device. A harness readback then
// fails on a buffer that "exists" only in JavaScript. The copy kernel binds
// both buffers, which is what makes the region real — and it is the same
// staging-plus-copy contract `dynamicObjects.createRegionUploader` runs on, so
// a future consumer moving between the two hosts sees one behaviour.
//
// ══ THE DIRTY FLAG CLEARS ON CONFIRM, NOT ON OFFER ══════════════════════════
//
// `giCompute` DEFERS a batch whose pipelines are still compiling, which on a
// boot frame is every batch. An uploader that cleared `dirty` when its pass
// was put in the list would drop the write on exactly those frames and freeze
// the tree at whatever the buffer happened to hold. `pendingPasses()` offers;
// `confirmUploads()` clears; the caller is the only thing that knows which
// happened. (Same rule, same reason, as `gi2System.notePassesRan`.)
import { Fn, instanceIndex, instancedArray, storage, uint } from "three/tsl";

/**
 * A standalone word region for the packed light tree.
 *
 * @param {number} capacityWords total u32 words to reserve (the tree's own
 *   growth-floor reservation; see GISystem's `LIGHT_TREE_MIN_CAPACITY_EMITTERS`)
 */
export function createLightTreeStore(capacityWords) {
  // A floor rather than a bare max: a region of a handful of words is a region
  // whose first re-pack is refused, and the whole point of the reservation is
  // that a scene can SPAWN emissives into it.
  const cap = Math.max(1024, Math.ceil(Number(capacityWords) || 0));
  const bitsBuffer = instancedArray(new Uint32Array(cap), "uint");
  bitsBuffer.value.name = "giLightTreeWords";
  const bits = storage(bitsBuffer.value, "uint", cap);
  const uploaders = [];
  let nextWord = 0;
  let disposed = false;

  const store = {
    /** Names this host in a log line without a `instanceof` anywhere. */
    lightTreeStore: true,
    capacityWords: cap,
    /** The node a consumer binds (the descent, when it arrives on this path). */
    bits,
    /** The attribute a harness reads back — the `_dynSet.bits` equivalent. */
    bitsBuffer,

    /** §19 Stage 0.2b — everything that dies with this store. */
    get storageAttributes() {
      const out = [bitsBuffer.value];
      for (const u of uploaders) out.push(u.staging.value);
      return out.filter((a) => a?.isBufferAttribute === true);
    },

    /**
     * The one call the light tree actually needed from `_dynSet`. Same shape,
     * same contract: `write(words)` returns false when the pack does not fit
     * and the region keeps its last good contents.
     */
    createRegionUploader(maxWords) {
      const n = Number.isFinite(maxWords) ? Math.max(0, Math.trunc(maxWords)) : 0;
      if (disposed || n === 0 || nextWord + n > cap) return null;
      const abs = nextWord;
      nextWord += n;
      const staging = instancedArray(new Uint32Array(n), "uint");
      const compute = Fn(() => {
        bits.element(uint(abs).add(instanceIndex)).assign(staging.element(instanceIndex));
      })().compute(n);
      compute.__giPassName ??= "gi2.lightTreeUpload";
      const handle = {
        // `abs` and `rel` are the same number here — this store IS the region,
        // where `_dynSet`'s sat at an offset inside the field. Both are
        // published so a reader written against either host works unchanged.
        abs, rel: abs, capacity: n, dirty: false,
        write(words) {
          if (words.length > n) return false;
          const array = staging.value.array;
          array.set(words);
          // Zero the tail: a SHRINKING tree would otherwise leave the previous
          // pack's words readable past the new header's extents.
          if (words.length < array.length) array.fill(0, words.length);
          staging.value.needsUpdate = true;
          handle.dirty = true;
          return true;
        },
      };
      uploaders.push({ handle, compute, staging });
      return handle;
    },

    /** The copy kernels with bytes waiting. Does NOT clear `dirty` — see above. */
    pendingPasses() {
      const out = [];
      for (const u of uploaders) if (u.handle.dirty) out.push(u.compute);
      return out;
    },

    /** "The list I just gave you was actually submitted." */
    confirmUploads() {
      for (const u of uploaders) u.handle.dirty = false;
    },

    describe: () => ({ capacityWords: cap, usedWords: nextWord, regions: uploaders.length }),

    dispose() {
      disposed = true;
      for (const attr of store.storageAttributes) {
        attr.array = attr.array?.constructor ? new attr.array.constructor(0) : new Uint32Array(0);
        attr.dispose?.();
      }
      uploaders.length = 0;
    },
  };
  return store;
}
