// SPLIT RADIANCE CASCADES — the per-slot surface PALETTE, without the field.
//
//     slot (u32) → { albedo, emitter, emissive, live }
//
// Eight u32 words per occupancy slot, written into a storage buffer by one
// 512-thread dispatch and read by whichever transport attributes a hit to a
// slot: `srcSurface.js` (cell-keyed: record → stamp → slot) and
// `srcBvhTrace.js` (BVH-keyed: leaf → placement → slot) both decode exactly
// these words. Plan §10, §10.1 — the field is on its way out and the BVH
// transport must not have to build an occupancy field to get a colour, so the
// palette's CPU side (the placement walk, the emitter index, the orphan audit,
// the mean albedo) and its GPU side (the pass) live here, keyed on nothing but
// a `bits` buffer, a word offset and a slot count.
//
// ══ THE LAYOUT, AND WHO OWNS IT ═════════════════════════════════════════════
//
//   +0..2  albedo rgb, f32 bits          +4..6  emissive rgb, f32 bits
//   +3     emitter id + 1 (0 = not a NEE light)
//   +7     live (1 = this slot has a resolved surface; 0 reads as UNATTRIBUTED)
//
// `SURFACE_PALETTE_WORDS` is still DECLARED in `occupancyField.js`, because the
// field sizes its own tail region with it and this file is forbidden to touch
// the field. It is re-exported here so a field-less consumer imports the
// stride from the palette and never from the field; when the field goes, the
// declaration moves here and nothing else changes.
//
// ══ THE THREE DECISIONS THIS FILE KEEPS (from `srcSurface.js`'s header) ═════
//
// **THE BRIDGE IS BY KEY.** `assignments[j]` is the registry's own numbering
// and `placement.slot` is the occupancy field's; they are different numbers for
// the same mesh (§12.9's crossed-numbering bug). The GPU sees ONE numbering —
// the occupancy slot, which is what indexes the palette — and the registry is
// reached by `slotKeyOf(mesh, instanceId)`, never by index. `crossNumbering` is
// the deliberate-failure arm that writes the entry under the registry's index
// so the gate can prove it fails.
//
// **A UNIFORM PLUS A DISPATCH, NOT A CPU WRITE.** `bits` is GPU-written every
// chain, so a CPU upload of it would clobber whatever shares the buffer. The
// palette is staged in a `uniformArray` of 2×vec4 per slot and copied in by a
// trivial compute pass, so a recolour is a uniform write plus 512 threads and
// the consumer's binding count stays at zero (R7).
//
// **THE EMITTER FLAG DOES NOT ZERO.** The palette carries `#slotSurface`'s
// output verbatim — already zeroed for a promoted (NEE-sampled) entry on the
// CPU — and `emitter` is a flag the consumer can ASSERT against. The failure
// that leaves is a surface whose material emits, whose published emissive is
// zero, and which no NEE seat claims: light deleted from BOTH paths, invisible
// to any GPU counter because nothing carries emission to notice. It is audited
// here and reported as `stats.emissiveOrphans`. Zero is the healthy reading.
//
// ══ TWO OWNERSHIP MODES, ONE SET OF WORDS ═══════════════════════════════════
//
// Given `{ paletteUniform, palettePass }`, the factory ADOPTS them: `sync`
// fills the caller's uniform and `passes` is the caller's pass, so a field that
// already built both (the occupancy field does — its tail region is sized for
// them) keeps dispatching exactly what it dispatched before and nothing is
// dispatched twice. Given neither, the factory builds its own pair with the
// same body. The words that land in `bits` are identical either way; the node
// test pins the uniform contents across the two modes.
//
// docs/GI_SCALE_PLAN.md §10, §10.1; docs/GI_SRC_REBUILD_PLAN.md §12.9, §12.29.

import * as THREE from "three/webgpu";
import { Fn, float, floatBitsToUint, instanceIndex, uint, uintBitsToFloat, uniform, uniformArray, vec3 } from "three/tsl";
import { SURFACE_PALETTE_WORDS } from "./occupancyField.js";
import { slotKeyOf } from "./slotRegistry.js";
import { resolveMaterialSurface } from "./voxelizeOnce.js";

export { SURFACE_PALETTE_WORDS };

/** Below this a resolved emissive counts as "this material does not emit". */
export const EMISSIVE_EPSILON = 1e-4;

/**
 * Builds the palette copy pass: 2×vec4 per slot out of `paletteUniform`, eight
 * u32 words per slot into `bits` at `wordOffset + slot * SURFACE_PALETTE_WORDS`.
 * The body is the occupancy field's, verbatim — a second author of these words
 * would be a second numbering.
 */
function buildPalettePass(bits, wordOffset, slots, paletteUniform) {
  return Fn(() => {
    const s = instanceIndex.toVar();
    const a = paletteUniform.element(s.mul(uint(2)).toInt()).toVar();
    const e = paletteUniform.element(s.mul(uint(2)).add(uint(1)).toInt()).toVar();
    const base = uint(wordOffset).add(s.mul(uint(SURFACE_PALETTE_WORDS))).toVar();
    bits.element(base).assign(floatBitsToUint(a.x));
    bits.element(base.add(uint(1))).assign(floatBitsToUint(a.y));
    bits.element(base.add(uint(2))).assign(floatBitsToUint(a.z));
    // Emitter id + 1, carried through a float lane. Slot counts are ≤ 512
    // and emitter ids ≤ MAX_EMITTERS, so the round-trip is exact.
    bits.element(base.add(uint(3))).assign(a.w.max(0).round().toUint());
    bits.element(base.add(uint(4))).assign(floatBitsToUint(e.x));
    bits.element(base.add(uint(5))).assign(floatBitsToUint(e.y));
    bits.element(base.add(uint(6))).assign(floatBitsToUint(e.z));
    // LIVE: 1 when this slot has a real resolved surface. An occupancy
    // placement whose mesh never seated an atlas slot has a stamp but no
    // colour, and without this word its palette entry would read as black —
    // R1's silent dark vote, arriving as data rather than as an absence.
    bits.element(base.add(uint(7))).assign(e.w.max(0).round().toUint());
  })().compute(Math.max(1, slots));
}

/**
 * The per-slot surface palette: CPU sync + GPU pass + TSL reader.
 *
 * @param {object} options
 * @param {Node} options.bits  a TSL `instancedArray(…, "uint")` storage node —
 *   any host buffer with `slots * SURFACE_PALETTE_WORDS` free words at
 *   `wordOffset`. The palette rides whatever buffer the consumer already binds.
 * @param {number} options.wordOffset  first word of the palette region in `bits`.
 * @param {number} options.slots  palette capacity, in occupancy slots.
 * @param {() => Array<{mesh: object, instanceId?: number|null, slot: number}>} options.placements
 *   the CURRENT placements — a function, because the array identity moves on a
 *   content rebuild and that identity is part of the change detection.
 * @param {{assignments: Array<object|null>, revision: number, surfaceRevision: number}} options.assignments
 *   the slot atlas (`SlotRegistry`). Read for its surfaces and its two
 *   revisions; never for its slot NUMBERS — see the header.
 * @param {() => Array<object|null>} [options.emitterMeshes]  the NEE emitter
 *   set, as meshes, index-aligned with the `emitters` array the hit shader
 *   gets. Interior nulls are expected (`_emitterInfos` parks seats).
 * @param {object|null} [options.count]  accepted so `createSrcSurfaceAttribution`
 *   can forward its options verbatim; the palette itself has no GPU lane to
 *   count on, so it is unused here (the retry/miss counters belong to the
 *   cell-keyed lookup that wraps this).
 * @param {boolean} [options.crossNumbering]  TEST ONLY. Writes the palette under
 *   the registry's numbering instead of the occupancy slot — §12.9's
 *   crossed-numbering bug, on purpose, so the gate can prove it fails.
 * @param {Node|null} [options.paletteUniform]  an existing 2×vec4-per-slot
 *   `uniformArray` to fill instead of allocating one.
 * @param {Node|null} [options.palettePass]  an existing compute pass that reads
 *   `paletteUniform`; requires `paletteUniform`. When given, `passes` is this
 *   pass and the factory builds none — so a field that owns both keeps
 *   dispatching exactly one copy.
 */
export function createSrcSlotPalette({
  bits,
  wordOffset,
  slots,
  placements,
  assignments,
  emitterMeshes = () => [],
  // `count` is accepted (see the JSDoc) and deliberately not destructured: the
  // palette has no GPU lane to count on, so naming it here would be a lie.
  crossNumbering = false,
  paletteUniform = null,
  palettePass = null,
} = {}) {
  if (!bits || typeof bits.element !== "function") {
    throw new Error("createSrcSlotPalette: `bits` must be a TSL storage node (instancedArray) — the palette has nowhere to land");
  }
  if (!(Number.isInteger(wordOffset) && wordOffset >= 0)) {
    throw new Error(`createSrcSlotPalette: wordOffset must be a non-negative integer word index, got ${wordOffset}`);
  }
  if (!(Number.isInteger(slots) && slots >= 0)) {
    throw new Error(`createSrcSlotPalette: slots must be a non-negative integer, got ${slots}`);
  }
  if (typeof placements !== "function") {
    throw new Error("createSrcSlotPalette: `placements` must be a function returning the CURRENT placements array");
  }
  if (!Array.isArray(assignments?.assignments)) {
    throw new Error("createSrcSlotPalette: `assignments` must be the slot atlas (an object with an `assignments` array)");
  }
  if (palettePass && !paletteUniform) {
    throw new Error("createSrcSlotPalette: a caller-owned palettePass reads a caller-owned paletteUniform — pass both or neither");
  }
  if (paletteUniform && paletteUniform.array?.length !== slots * 2) {
    throw new Error(
      `createSrcSlotPalette: paletteUniform holds ${paletteUniform.array?.length ?? "?"} vec4s, ` +
        `but ${slots} slots need ${slots * 2} (2 per slot)`,
    );
  }

  const words = SURFACE_PALETTE_WORDS;
  const ownsUniform = !paletteUniform;
  if (ownsUniform) {
    paletteUniform = uniformArray(Array.from({ length: slots * 2 }, () => new THREE.Vector4()), "vec4");
  }
  if (!palettePass) palettePass = buildPalettePass(bits, wordOffset, slots, paletteUniform);

  // The colour an unattributed hit shades at: the mean albedo over live slots,
  // refreshed by `sync`. A UNIFORM and not a baked constant, for both of R11's
  // reasons — the right grey is a property of the scene (a dark scene's
  // fallback must be dark, or the unattributed fraction reads as bright
  // patches), and it must be able to move without recompiling the graph.
  const fallbackAlbedo = uniform(new THREE.Vector3(0.5, 0.5, 0.5));

  const stats = {
    /** Palette entries with a resolved surface. */
    live: 0,
    /** Occupancy placements with no atlas assignment — they shade at the mean. */
    unassigned: 0,
    /** Placements whose occupancy slot is past the palette (see `sync`). */
    slotOverflow: 0,
    /**
     * Surfaces whose material emits, whose published emissive is zero, and
     * which are NOT in the NEE set: light deleted from both paths. Zero is the
     * healthy reading; nonzero is a promotion-bookkeeping bug, caught before it
     * reaches the image. See the header — a GPU counter structurally cannot see
     * this one, because nothing carries emission to notice.
     */
    emissiveOrphans: 0,
    /** NEE-flagged palette entries. Should equal the live emitter seat count. */
    emitters: 0,
    syncs: 0,
  };

  // Change detection. `revision` moves on a seat/clear/drag, `surfaceRevision`
  // on a recolour, the placements array identity on a content rebuild, and the
  // emitter stamp when a seat turns over — a recolour therefore costs one
  // palette upload and touches nothing else.
  let seenRevision = -1;
  let seenSurfaceRevision = -1;
  let seenPlacements = null;
  let seenPlacementCount = -1;
  let seenEmitterStamp = "";
  // Material → resolved surface, keyed the way `dynamicObjects.writeSurface`
  // keys its own: a shader-graph walk per slot per sync would be paid on every
  // seat change for an answer that only moves when the material does.
  const materialCache = new Map(); // "id:version" -> resolveMaterialSurface result

  const resolveCached = (mesh) => {
    const material = Array.isArray(mesh?.material) ? mesh.material[0] : mesh?.material;
    const key = `${material?.id ?? -1}:${material?.version ?? 0}`;
    let hit = materialCache.get(key);
    if (!hit) {
      hit = resolveMaterialSurface(mesh?.material, mesh?.name);
      materialCache.set(key, hit);
    }
    return hit;
  };

  /**
   * @param {boolean} [force] rewrite even when nothing changed. Only a gate
   *   needs this — it is how an arm that deliberately corrupted the palette
   *   puts the real one back, and without it the early-out below would leave
   *   the corruption in place for every arm after it.
   */
  function sync(force = false) {
    const current = placements() ?? [];
    const emitters = emitterMeshes() ?? [];
    let emitterStamp = "";
    for (let i = 0; i < emitters.length; i++) emitterStamp += `${emitters[i]?.uuid ?? "-"},`;
    if (
      !force &&
      assignments.revision === seenRevision &&
      assignments.surfaceRevision === seenSurfaceRevision &&
      current === seenPlacements &&
      current.length === seenPlacementCount &&
      emitterStamp === seenEmitterStamp
    ) {
      return;
    }
    seenRevision = assignments.revision;
    seenSurfaceRevision = assignments.surfaceRevision;
    seenPlacements = current;
    seenPlacementCount = current.length;
    seenEmitterStamp = emitterStamp;
    stats.syncs++;

    // THE BRIDGE, AND IT IS BY KEY. `assignments[j]` is the registry's own
    // numbering and has nothing to do with `placement.slot`; the only thing the
    // two share is the placement identity. Matching on that identity is what
    // makes a remap unnecessary rather than merely correct.
    const byKey = new Map();
    for (const assignment of assignments.assignments) {
      if (assignment) byKey.set(assignment.key, assignment);
    }
    const emitterOf = new Map();
    for (let i = 0; i < emitters.length; i++) {
      if (emitters[i]) emitterOf.set(emitters[i], i);
    }

    const array = paletteUniform.array;
    for (let i = 0; i < array.length; i++) array[i].set(0, 0, 0, 0);
    stats.live = 0;
    stats.unassigned = 0;
    stats.slotOverflow = 0;
    stats.emissiveOrphans = 0;
    stats.emitters = 0;
    let sumR = 0, sumG = 0, sumB = 0;

    for (const placement of current) {
      // `_occSlotNext` is monotonic and never reused, so a long session of
      // spawns and despawns can hand out a slot past the palette. It lands as
      // UNATTRIBUTED (counted) rather than as another mesh's colour, which is
      // the correct direction for an aliasing failure. Logged in §12.29.
      if (!(placement.slot >= 0 && placement.slot < slots)) {
        stats.slotOverflow++;
        continue;
      }
      const assignment = byKey.get(slotKeyOf(placement.mesh, placement.instanceId));
      if (!assignment?.surface) {
        stats.unassigned++;
        continue;
      }
      // THE DELIBERATE-FAILURE ARM. Writing the entry under the REGISTRY's
      // index instead of the occupancy slot is §12.9's crossed-numbering bug,
      // reproduced exactly: both numbers exist, both look like slot ids, and
      // the picture is simply somebody else's colour.
      const index = crossNumbering ? assignments.assignments.indexOf(assignment) : placement.slot;
      if (!(index >= 0 && index < slots)) continue;
      const { color, emissive } = assignment.surface;
      const emitterIndex = emitterOf.has(placement.mesh) ? emitterOf.get(placement.mesh) : -1;
      if (emitterIndex >= 0) stats.emitters++;

      // The both-zero check. `assignment.surface.emissive` is `#slotSurface`'s
      // output, already zeroed for a promoted entry; if it is zero, the mesh's
      // material emits, and no NEE seat claims it, then this surface's light
      // exists on neither path.
      const publishedDark =
        Math.abs(emissive.r) < EMISSIVE_EPSILON &&
        Math.abs(emissive.g) < EMISSIVE_EPSILON &&
        Math.abs(emissive.b) < EMISSIVE_EPSILON;
      if (publishedDark && emitterIndex < 0) {
        const raw = resolveCached(placement.mesh);
        const k = raw.emissiveIntensity ?? 1;
        const emits =
          (raw.emissive?.r ?? 0) * k > EMISSIVE_EPSILON ||
          (raw.emissive?.g ?? 0) * k > EMISSIVE_EPSILON ||
          (raw.emissive?.b ?? 0) * k > EMISSIVE_EPSILON;
        if (emits) stats.emissiveOrphans++;
      }

      array[index * 2].set(color.r, color.g, color.b, emitterIndex + 1);
      array[index * 2 + 1].set(emissive.r, emissive.g, emissive.b, 1);
      stats.live++;
      sumR += color.r;
      sumG += color.g;
      sumB += color.b;
    }

    // The fallback is the scene's own mean, not a constant grey. With no live
    // slot at all the palette is empty and nothing can read it, so the 0.5 is
    // unreachable rather than a tuned default.
    if (stats.live > 0) {
      fallbackAlbedo.value.set(sumR / stats.live, sumG / stats.live, sumB / stats.live);
    }
  }

  // ── the read ──────────────────────────────────────────────────────────────

  /**
   * Palette words for slot index `s` (a u32 node), unpacked. No clamp: the
   * caller owns the slot's provenance (a stamp, a BVH leaf) and a wrapped
   * index here would be another mesh's colour rather than an error.
   */
  const paletteAt = (s) => {
    const base = uint(wordOffset).add(s.mul(uint(words))).toVar();
    return {
      albedo: vec3(
        uintBitsToFloat(bits.element(base)),
        uintBitsToFloat(bits.element(base.add(uint(1)))),
        uintBitsToFloat(bits.element(base.add(uint(2)))),
      ).toVar(),
      emitter: float(bits.element(base.add(uint(3)))).sub(1).toVar(),
      /** Diagnostic only: the raw word 0, numerically. See `debugProbe`. */
      rawWord0: float(bits.element(base)).toVar(),
      base,
      emissive: vec3(
        uintBitsToFloat(bits.element(base.add(uint(4)))),
        uintBitsToFloat(bits.element(base.add(uint(5)))),
        uintBitsToFloat(bits.element(base.add(uint(6)))),
      ).toVar(),
      live: float(bits.element(base.add(uint(7)))).toVar(),
    };
  };

  sync();

  return {
    // One pass, `slots` threads, and it is the whole cost of a recolour.
    passes: [palettePass],
    sync,
    stats,
    /** The shape every transport consumes (`srcBvhTrace.js`, `GISystem`). */
    palette: { bits, wordOffset, words, slots },
    paletteAt,
    fallbackAlbedo,
    /** Diagnostics for the gate — never read by the frame path. */
    debug: {
      paletteSlots: slots,
      /** True when this factory allocated the staging uniform (vs. adopted the field's). */
      ownsUniform,
      get fallbackAlbedo() {
        return [fallbackAlbedo.value.x, fallbackAlbedo.value.y, fallbackAlbedo.value.z];
      },
      paletteEntry(slot) {
        const a = paletteUniform.array[slot * 2];
        const e = paletteUniform.array[slot * 2 + 1];
        return {
          albedo: [a.x, a.y, a.z],
          emitter: a.w - 1,
          emissive: [e.x, e.y, e.z],
          live: e.w,
        };
      },
    },
    dispose() {
      materialCache.clear();
      seenPlacements = null;
    },
  };
}
