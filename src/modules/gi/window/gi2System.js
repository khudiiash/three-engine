// GI2 — THE ORCHESTRATOR (plan §19 Stage 3.4, audits §M)
//
// One object that owns the whole GI2 chain and hands `GISystem` four things:
// an ordered list of compute nodes per frame, two full-res screen textures,
// a receipt, and a dispose. Everything scene-shaped enters through `build()`;
// everything per-frame enters through `setCamera` / `setMovers` / the uniform
// mirrors in `passes()`.
//
// ══ WHY AN ORCHESTRATOR AND NOT SIX CALLS IN `#tick` ═════════════════════════
//
// The six modules under `window/` have a strict order (§M.2) and three of them
// do not exist until an off-thread promise lands. Spreading that across
// `#rebuild` and `#tick` would put the ordering contract in the one function
// this whole stage exists to shrink — and would make "GI2 is not built yet" a
// condition every call site has to re-derive. Here it is one flag and an empty
// pass list.
//
// ══ WHAT THIS FILE DELIBERATELY DOES NOT OWN ════════════════════════════════
//
//   · The g-buffer. `GISystem` already renders position+normal at resolve res
//     (`renderGiGBuffer`), holds it against a content key, and resizes it. GI2
//     consumes those two textures — it never renders a pass of its own.
//   · GTAO. Same pass, same target, same tier ladder as the old path; GI2 only
//     multiplies it into the resolved irradiance (§M.3's "AO stays GTAO").
//   · The sun, the emitter slots and the sky. They are `GISystem` uniforms in
//     the render group, written once per frame by `#updateLightUniforms` /
//     `#refreshEmitterSlots`, and they are passed IN.
//
// ✅ THE 3.2 API GAP IS CLOSED (Stage 3.5). `createGiGather` used to mint its
// OWN `sunDir` / `sunColor` / `skyColor` uniforms, so this unit MIRRORED three
// vectors into them every frame. It takes `{ sun, sky }` NODES now and mints
// only what it is not given (which is what keeps the harnesses working), so
// the system's uniforms are read by identity and `syncLighting` writes nothing
// but the camera. The historical note is kept because "why are there two
// sunDirs" is the question the mirror would otherwise leave behind.
//
// ══ THE EMITTER TERM (§M.3) ═════════════════════════════════════════════════
//
// The SRC irradiance texture carried emitter DIRECT diffuse + its shadow
// (`giLight.js`'s deferred branch: "Emitter direct + its shadow are already in
// the irradiance texture"). `gatherProbes` shades a RAY HIT against the sun and
// against one hard-coded rectangular panel (the Cornell rig's) — it has no
// emitter-slot NEE and nothing at the probe's own position. Two holes, and only
// the second one is this unit's to close:
//
//   · at the probe's POSITION — closed here, by `emitterDirectPass`: one
//     shadow ray per emitter slot per probe per frame through `traceWindow`,
//     projected into the probe's SH before the resolve reads it. This is the
//     term the irradiance texture used to carry, at probe resolution instead of
//     per pixel — the trade PLAN §4.4 names, and the reason
//     `emitterShadowPass` is not dispatched at all under `GI2_PATH`.
//   · at a ray HIT — CLOSED in Stage 3.5, inside `gatherProbes`' `shadeHit`
//     (this system passes `emitters` to `createGiGather`). It was not "a few
//     frames late": a fresh slot is shaded ONCE with α = 1 and never revisited,
//     so for any surface `injectLitFrame` cannot reach — everything off screen,
//     which is the whole point of the cache — the lamp's contribution was
//     permanently absent, not merely delayed. Same `Ω = min(π, π·reff²/d²)`,
//     same one shadow ray, same self-exclusion as the probe-position term.
//
// The projection is exact for the resolve's integrator, not an approximation of
// it: `probeFilter` writes `SH_i = Σ L(ω)·Δω·Y_i(ω)`, so an emitter delivering
// irradiance `L_e · Ω · cosθ` is added as `SH_i += L_e · Ω · Y_i(ω_e)` and the
// resolve's own cosine convolution supplies the `cosθ`. No new constant.
import * as THREE from "three/webgpu";
import {
  Fn, If, Return, dot, float, globalId, instancedArray, int, ivec2, normalize, select, smoothstep,
  sqrt, texture, textureStore, uint, vec3, vec4,
} from "three/tsl";
import { createSrcWorld } from "../srcVolume.js";
import {
  createGiWindow,
  // §19 3.17 — the census below reads the window buffer's own layout.
  BMASK_OFF as WIN_BMASK_OFF, BTAB_OFF as WIN_BTAB_OFF, LEVEL_WORDS as WIN_LEVEL_WORDS,
  OCC_OFF as WIN_OCC_OFF, WB_VALID as WIN_WB_VALID,
} from "./windowStore.js";
import { createWindowTrace } from "./windowTrace.js";
import { createRadianceCache } from "./radianceCache.js";
import { createWindowVoxelizer } from "./windowVoxelize.js";
import { createWindowDynamic, moverBoxSoup } from "./windowDynamic.js";
import { createTriangleSoupBuilder, SoupSupersededError, PAL_NONE } from "./triangleSoup.js";
import { createShadowBvhBuilder, createShadowBvhGpu, SHADOW_BVH_TRI_CAP } from "./shadowBvh.js";
import { createGiGather, GATHER_TIERS, PAL_ENTRIES, STATS } from "./gatherProbes.js";
import { createRcCascades } from "./rc/rcSystem.js";
import { rcHitPathEnabled } from "./rc/rcConfig.js";
import { rc5PixelNeeEnabled } from "../giConfig.js";
import { rc5BvhShadowEnabled } from "../giConfig.js";
import { rc5PathEnabled } from "../giConfig.js";
import { detachCpuMirror } from "../releaseCompute.js";

/** Real palette classes; entry `PAL_ENTRIES - 1` is reserved for "no surface". */
export const GI2_PAL_CLASSES = PAL_ENTRIES - 1;

/**
 * How many frames of coarse-first voxelizing a fresh window gets before the
 * budget flips to fine-first. §K.3's "coarse levels first at boot": L3 has 64×
 * fewer bricks per metre, so the whole window has occupancy within a handful of
 * frames and `first light` never waits on L0.
 */
const COARSE_FIRST_FRAMES = 90;

/**
 * ══ §19 STAGE 4.1 — WHERE THE MOVING FRAME GOES, AND ⛔ WHAT DOES NOT FIX IT ═
 *
 * THE REPORT: "60-70 fps static, heavy freezes when the camera moves." THE
 * MEASUREMENT (`probe:gi2-motion`, Bistro, ultra, 1650×970, per-kernel GPU
 * timestamps via `__giBatchCompute = false`): the whole GI2 pre-gbuffer chain
 * costs **0.14 ms** on a frame where the window did not scroll and **63 ms
 * median / 146 ms max** on a frame where it did. ONE kernel owns all of it —
 * `binPairs`. Every other GI2 kernel stays under 2 ms in both cases, the raster
 * half never exceeds 20 ms, and the CPU tick marks only ~20 ms of a 150 ms wall
 * clock: the frame is not slow, it is WAITING on a GPU submission that ran long.
 * That is also why `profile.frameStats`' EMA'd `gpuMs` shows nothing — 34 burst
 * frames in 901 move a smoothed mean by about a millisecond.
 *
 * ⛔⛔ REFUTED, WITH RECEIPTS: BOUNDING THE DIRTY-BRICK COUNT.
 *
 * The obvious budget — measure the pass, admit fewer dirty bricks next frame —
 * was built behind `setDirtyLimit` and MEASURED. It makes the report worse, and
 * by a lot. An in-boot sweep (one session, so one machine's contention across
 * every arm; `VOX_SWEEP=24,384,20480` on the dolly):
 *
 *     limit    voxelize ms med/max    moving frame med/max   frames > 50 ms
 *        24        42.9 / 78.8            89.1 / 333.4              35
 *       384         0.14 / 57.4           21.3 / 165.2               4
 *     20480         0.15 / 63.9           18.4 / 138.4               5
 *
 * 384 and "no limit at all" are indistinguishable; 24 is a catastrophe. Over a
 * whole three-arm run the controller took total voxelize GPU from **2 264 ms to
 * 23 915 ms** (10.5x) and the gather's valid probes from 7 128 to 1 392 — the
 * window never converged, so every frame paid instead of one in thirty.
 *
 * ⭐⭐ THE REASON, AND IT IS THE USEFUL PART: `binPairs` IS ONE THREAD PER
 * BRICK, AND THE PASS COSTS WHAT ITS SLOWEST THREAD COSTS. A brick's count walk
 * reads every triangle of every soup cell it overlaps. The soup grid is 4 m
 * (`SOUP_CELL_SIZE`), so an L0 brick (1 m at ultra) touches ~8 cells while an L4
 * brick (16 m) touches the loop's whole 6³ = 216 — at Bistro's density roughly
 * 16 k triangles for a fine brick against ~430 k for a coarse one, which is tens
 * of milliseconds of SERIAL work in a single lane. Running 2 048 such threads at
 * once costs barely more than running 24, because the GPU has the width. So
 * admitting fewer bricks buys no time; it only multiplies the number of frames
 * that each pay the worst brick's latency.
 *
 * ▶ THE LEVER IS PER-BRICK WORK, NOT PER-FRAME BRICKS. The kernel already
 * resumes on a PAIR cursor (§2.5); what it needs is a CELL cursor, so a brick
 * walks a bounded slice of its soup cells per frame and comes back. That changes
 * the resumption contract (both walks must agree on the first triangle, and the
 * voxel clear keys on "first instalment"), which is why it is named here rather
 * than attempted alongside a budget experiment.
 *
 * What survives: the MEASUREMENT. `counters.voxMs` / `voxMsPeak` publish the
 * pre-gbuffer chain's real GPU cost into `snapshot()`, so a burst is visible in
 * `profile.frameStats.gi2` with no readback and no suspended render loop — which
 * is what made all of the above knowable in the first place.
 */
const VOX_MS_BUDGET = { phone: 1.0, medium: 1.0, high: 2.0, ultra: 2.0 };
/** The boot allowance, held until the window reports occupancy. */
const VOX_BOOT_MS = 6.0;

/**
 * ══ THE VOLUME STAND-IN (§M.1) ═══════════════════════════════════════════════
 *
 * `createSrcVolume` refuses to exist without an occupancy field — correctly:
 * it is the SRC path's only distance source. Under `GI2_PATH` there is no
 * occupancy field, and ~40 `GISystem` call sites still read `state.volume.*`
 * (bounds, the world uniform bundle, `minCell` for the sub-cell emissive test,
 * `setBounds` on a refit). Every one of them is either optional-chained through
 * `occupancyField` or wants the WORLD bundle, which is pure arithmetic over the
 * bounds and needs no field at all.
 *
 * So GI2 supplies the spine and nothing else. The two trace factories return
 * `null` rather than throwing, because that is what their callers already test
 * for (`#buildLightShadow`: "no pyramid, no feature").
 */
export function createGi2Volume({ bounds, res = null, rayHitMode = undefined }) {
  const w = createSrcWorld(bounds, res, null);
  return {
    gi2: true,
    world: w,
    occupancyField: null,
    rayHitMode,
    distance: null,
    res,
    bounds,
    cell: w.cell.value,
    minCell: w.minCellValue,
    capWorld: w.capWorldValue,
    setBounds(next) {
      bounds?.min.copy(next.min);
      bounds?.max.copy(next.max);
      w.refit(next);
      this.minCell = w.minCellValue;
      this.capWorld = w.capWorldValue;
    },
    createSoftShadowTrace: () => null,
    createWidthProbe: () => null,
  };
}

/**
 * How many of the palette's classes are reserved for ADMITTED EMITTERS.
 *
 * §O.4's "reserve a band of 8". A lamp is one placement against a wall's four
 * hundred, so on any ranking a scene's emitters lose every vote — which is
 * how Bistro shipped `0 of 15 classes with emission` while its own resolver
 * was finding 95 lamps. The band takes them out of the contest entirely.
 *
 * The band sits at the TOP of the real range on purpose: `windowVoxelize`
 * merges a shared cell with `max(packed word)`, so a lamp that shares a voxel
 * with the wall behind it KEEPS ITS OWN CLASS instead of losing it. That is
 * the difference between a small emitter that emits and one that silently
 * does not.
 */
export const GI2_PAL_EMITTER_CLASSES = 8;

/**
 * Quantize per-placement surfaces into the gather's class table.
 *
 * §K.2 stores ONE BYTE per voxel and §L.2 reads it as a material CLASS — a
 * scene-independent table, not a per-mesh array, which is what keeps every
 * kernel's WGSL free of scene numbers.
 *
 * ⭐⭐ §19 STAGE 4.0b — WHAT REPLACED THE 3-LEVEL LATTICE, AND WHY (audits §O.4).
 *
 * The old clustering was a fixed 3×3×3 albedo lattice ranked by PLACEMENT
 * COUNT. Measured over Bistro's 131 materials / 1532 placements it used SEVEN
 * of its 27 possible buckets and carried 0.1113 mean absolute per-channel
 * albedo error; a weighted median cut at the same class count is 9× better and
 * at 64 classes is 140× better. Two things changed:
 *
 *   1. **A weighted MEDIAN CUT, not a lattice.** Deterministic, ~1500 points,
 *      microseconds on the CPU, once per build. Boxes split along their widest
 *      channel at the WEIGHTED median, so classes land where the scene's
 *      colours actually are instead of where a fixed grid says they might be.
 *   2. **Ranked by AREA, not by placement count.** Count is a proxy for area
 *      only when every placement is the same size, and in an imported scene it
 *      is not: 400 cobblestones and one facade are 400 votes against 1 for a
 *      surface the facade dominates. The weight here is the placement's world
 *      bounding-box surface area, which is what a ray is actually likely to
 *      hit.
 *
 * ⚠ THE ASSIGNMENT IS BAKED, THE TABLE IS NOT. A class index is written into
 * the soup's `triPal` and into every voxel's `pal` byte; the colours are two
 * uniform arrays. So this function's OUTPUT INDEX must be a function of facts
 * that do not change while a build lives — which is why the emitter test below
 * is `emitter` (a static flag the caller derives from "does this material have
 * an emissive expression at all", `emissivePending` included) and NOT the
 * resolved emissive value, and why a re-tint (`#retintGi2Palette`) recomputes
 * the class MEANS against this same assignment instead of re-clustering.
 *
 * @param {Array<{albedo:number[], emissive:number[]|number, area:number,
 *   emitter:boolean, matKey:string}>} surfaces per placement
 * @returns {{palette: Array<{albedo:number[], emissive:number[]}>,
 *   index: number[], emitterClasses: number[]}}
 */
export function buildGi2Palette(surfaces) {
  const rgbOf = (e) => (Array.isArray(e) ? [e[0] ?? 0, e[1] ?? 0, e[2] ?? 0] : [e ?? 0, e ?? 0, e ?? 0]);
  const items = surfaces.map((s) => {
    const a = s?.albedo ?? [0.5, 0.5, 0.5];
    const e = rgbOf(s?.emissive ?? 0);
    return {
      a: [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0],
      e,
      // ⚠ A ZERO WEIGHT MUST NOT EXIST. A degenerate placement (a flat quad's
      // world box has zero area on one axis, a prop with no bounding box has
      // none at all) would be invisible to every weighted median and could
      // land the whole population on one side of a split.
      w: Math.max(1e-6, s?.area ?? 1),
      emitter: !!s?.emitter,
      // The MATERIAL's identity. Both halves of the palette bucket on it,
      // because it is the one property of a placement that a re-tint cannot
      // change — see the diffuse block below for what happens when the key is a
      // colour instead.
      mk: s?.matKey ?? s?.emitterKey ?? "",
    };
  });

  const palette = Array.from({ length: PAL_ENTRIES }, () => ({ albedo: [0, 0, 0], emissive: [0, 0, 0] }));
  const index = new Array(items.length).fill(PAL_NONE);

  // ── THE EMITTER BAND ──────────────────────────────────────────────────────
  //
  // Grouped by the caller's `matKey` — a MATERIAL identity, i.e. a fact
  // that cannot move under a re-tint. Ranked by area × emitted luminance so a
  // material whose placements were all CULLED by the power gate (it resolves
  // to zero emission, by design) sinks to the tail and shares the last class
  // instead of evicting a lamp that actually lights the scene.
  const emitGroups = new Map();
  items.forEach((it, i) => {
    if (!it.emitter) return;
    const g = emitGroups.get(it.mk) ?? { key: it.mk, w: 0, score: 0, ar: 0, ag: 0, ab: 0, er: 0, eg: 0, eb: 0, idx: [] };
    const lum = 0.2126 * it.e[0] + 0.7152 * it.e[1] + 0.0722 * it.e[2];
    g.w += it.w;
    g.score += it.w * lum;
    g.ar += it.w * it.a[0]; g.ag += it.w * it.a[1]; g.ab += it.w * it.a[2];
    g.er += it.w * it.e[0]; g.eg += it.w * it.e[1]; g.eb += it.w * it.e[2];
    g.idx.push(i);
    emitGroups.set(it.mk, g);
  });
  const emitRanked = [...emitGroups.values()].sort((x, y) => (y.score - x.score) || (y.w - x.w) || (x.key < y.key ? -1 : 1));
  const emitCount = Math.min(emitRanked.length, GI2_PAL_EMITTER_CLASSES);
  const emitBase = GI2_PAL_CLASSES - emitCount;
  if (emitCount > 0) {
    // The tail beyond the band folds into the band's LAST class; its mean is
    // the area-weighted mean of everything in it, which for a tail of culled
    // materials is zero.
    const tail = { w: 0, ar: 0, ag: 0, ab: 0, er: 0, eg: 0, eb: 0, idx: [] };
    emitRanked.forEach((g, gi) => {
      const cls = emitBase + Math.min(gi, emitCount - 1);
      if (gi >= emitCount - 1) {
        tail.w += g.w;
        tail.ar += g.ar; tail.ag += g.ag; tail.ab += g.ab;
        tail.er += g.er; tail.eg += g.eg; tail.eb += g.eb;
        for (const i of g.idx) tail.idx.push(i);
      } else {
        palette[cls] = {
          albedo: [g.ar / g.w, g.ag / g.w, g.ab / g.w],
          emissive: [g.er / g.w, g.eg / g.w, g.eb / g.w],
        };
      }
      for (const i of g.idx) index[i] = cls;
    });
    if (tail.w > 0) {
      palette[emitBase + emitCount - 1] = {
        albedo: [tail.ar / tail.w, tail.ag / tail.w, tail.ab / tail.w],
        emissive: [tail.er / tail.w, tail.eg / tail.w, tail.eb / tail.w],
      };
    }
  }

  // ── THE DIFFUSE POPULATION ────────────────────────────────────────────────
  //
  // ⭐⭐ THE UNIT IS THE **MATERIAL**, NOT THE PLACEMENT, AND THAT IS NOT AN
  // OPTIMISATION — IT IS THE ONLY THING THAT SURVIVES THE RE-TINT.
  //
  // A placement's albedo at BUILD time is not the albedo it will have. Bistro's
  // `.mat color` is `#ffffff` on 1447 of 1532 placements and the real colour is
  // the mean of a COMPRESSED diffuse map, which the CPU canvas cannot decode —
  // it arrives later, off the GPU averager (`pendingTextureAverages`). So at
  // the moment this function runs, every diffuse placement in that scene is
  // pure white. Clustering by VALUE there collapses to ONE box (there is
  // nothing to split), the assignment is then frozen at one class for the life
  // of the build, and the re-tint can only ever repaint that single class.
  //
  // ⛔ MEASURED, on the first build of this design: `palette 9 of 63 classes`
  // on Bistro — one diffuse class for 508 placements — while the Level, whose
  // materials carry flat authored colours, happily used 43. The instrument that
  // caught it is the class census itself, which is why §O.4 asked for it.
  //
  // Bucketing by material identity fixes it by construction: the key is a fact
  // that no re-tint can change, and the top-K materials by AREA each get an
  // EXACT class — zero quantization error, better than any k-means could do —
  // while only the tail shares. The median cut below then operates on BUCKETS,
  // and only when a scene has more diffuse materials than classes.
  const buckets = new Map();
  items.forEach((it, i) => {
    if (it.emitter) return;
    const b = buckets.get(it.mk) ?? { w: 0, r: 0, g: 0, b: 0, idx: [] };
    b.w += it.w;
    b.r += it.w * it.a[0]; b.g += it.w * it.a[1]; b.b += it.w * it.a[2];
    b.idx.push(i);
    buckets.set(it.mk, b);
  });
  const K = Math.max(1, emitBase);
  const groups = [...buckets.entries()].map(([key, b]) => ({
    key, w: b.w, idx: b.idx, a: [b.r / b.w, b.g / b.w, b.b / b.w],
  }));
  if (groups.length) {
    // Deterministic input order — the median cut's tie-breaks and the final
    // ranking both read it, so two builds of the same scene must see the same
    // list. Area first (that is the ranking that matters), key as the tiebreak.
    groups.sort((x, y) => (y.w - x.w) || (x.key < y.key ? -1 : 1));
    let boxes = groups.map((_, i) => [i]);
    if (boxes.length > K) {
      // More materials than classes: merge them with a WEIGHTED MEDIAN CUT over
      // the bucket colours, largest colour-error box first. A box's error is
      // its widest channel extent × the area sitting in it — splitting the
      // widest-but-empty box first is how a median cut wastes its classes.
      boxes = [groups.map((_, i) => i)];
      const spread = (box) => {
        let lo = [1e9, 1e9, 1e9];
        let hi = [-1e9, -1e9, -1e9];
        let w = 0;
        for (const i of box) {
          const g = groups[i];
          w += g.w;
          for (let c = 0; c < 3; c++) { if (g.a[c] < lo[c]) lo[c] = g.a[c]; if (g.a[c] > hi[c]) hi[c] = g.a[c]; }
        }
        let axis = 0;
        let ext = -1;
        for (let c = 0; c < 3; c++) { const d = hi[c] - lo[c]; if (d > ext) { ext = d; axis = c; } }
        return { axis, ext, w, cost: ext * w };
      };
      while (boxes.length < K) {
        let best = -1;
        let bestCost = 0;
        let bestInfo = null;
        for (let b = 0; b < boxes.length; b++) {
          if (boxes[b].length < 2) continue;
          const s = spread(boxes[b]);
          if (s.ext <= 1e-6) continue;
          if (s.cost > bestCost) { bestCost = s.cost; best = b; bestInfo = s; }
        }
        if (best < 0) {
          // ⭐ THE COLOURS CANNOT DISCRIMINATE (every remaining bucket is the
          // same white). Spend the rest of the budget on AREA instead of
          // leaving it unused: peel the biggest material out of the biggest box
          // as its own class. That is exactly the placement a ray is most
          // likely to hit, and it makes the class count a function of the
          // scene rather than of how far the texture decode happened to get.
          let bi = -1;
          let bw = 0;
          for (let b = 0; b < boxes.length; b++) {
            if (boxes[b].length < 2) continue;
            const s = spread(boxes[b]);
            if (s.w > bw) { bw = s.w; bi = b; }
          }
          if (bi < 0) break;
          const box = boxes[bi];
          box.sort((x, y) => (groups[y].w - groups[x].w) || (x - y));
          boxes.splice(bi, 1, box.slice(0, 1), box.slice(1));
          continue;
        }
        const box = boxes[best];
        const axis = bestInfo.axis;
        box.sort((x, y) => (groups[x].a[axis] - groups[y].a[axis]) || (x - y));
        const half = bestInfo.w / 2;
        let acc = 0;
        // `cut` stays in [1, len-1] BY CONSTRUCTION — an empty half would be a
        // class that quantizes nothing and a box that never shrinks.
        let cut = 1;
        for (let k = 0; k < box.length - 1; k++) {
          acc += groups[box[k]].w;
          cut = k + 1;
          if (acc >= half) break;
        }
        boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
      }
    }
    // Ranked by area so class 0 is the scene's biggest surface — the fallback a
    // placement takes when nothing else can be said about it.
    const scored = boxes.map((box) => {
      let w = 0; let r = 0; let g = 0; let b = 0;
      for (const i of box) { const q = groups[i]; w += q.w; r += q.w * q.a[0]; g += q.w * q.a[1]; b += q.w * q.a[2]; }
      return { box, w, albedo: [r / w, g / w, b / w] };
    }).sort((x, y) => y.w - x.w);
    scored.forEach((s, ci) => {
      palette[ci] = { albedo: s.albedo, emissive: [0, 0, 0] };
      for (const gi of s.box) for (const i of groups[gi].idx) index[i] = ci;
    });
  }

  // The last entry is "no surface" and MUST stay black: `palAt` clamps an
  // out-of-range byte (PAL_NONE = 255, an unvoxelized or stale cell) onto it,
  // and a non-black value there would light every hole in the window.
  palette[PAL_ENTRIES - 1] = { albedo: [0, 0, 0], emissive: [0, 0, 0] };
  const emitterClasses = [];
  for (let c = emitBase; c < emitBase + emitCount; c++) emitterClasses.push(c);
  return { palette, index, emitterClasses };
}

/**
 * @param {object} opts
 * @param {THREE.WebGPURenderer} opts.renderer
 * @param {object} opts.engine
 * @param {"phone"|"medium"|"high"|"ultra"} opts.tier
 * @param {number} opts.resolveWidth
 * @param {number} opts.resolveHeight
 * @param {{position: THREE.Texture, normal: THREE.Texture}} opts.gbuffer
 * @param {Array} [opts.lights]     GISystem light slots (`makeLightSlots`) —
 *   unread since Stage 3.5 removed the lighting mirror (the sun arrives as
 *   `env.sun`, two nodes). Kept on the signature because the slot list is what
 *   a per-slot GI2 direct term would take, and dropping and re-adding a
 *   parameter is a bigger diff than an honest note.
 * @param {Array} [opts.emitters]   GISystem emitter slots (uniform nodes)
 * @param {object} [opts.lightTree] the W1 region, when one exists
 * @param {{sky: object, ao: object}} [opts.env]
 * @param {object} [opts.shared]    cross-rebuild cache (the soup and its worker)
 */
/**
 * ⭐⭐ §19 STAGE 4.1 — WHY A RESIZE MUST STAMP A VERSION ON ITS NEW TEXTURES.
 *
 * three invalidates a cached bind group ONLY when
 * `binding.generation !== textureData.generation` (Bindings.js:380), and
 * `textureData.generation` is just `texture.version` (Textures.js:310). A
 * freshly constructed `StorageTexture` has version 0 — so repointing
 * `_giRadianceNode.value` from one brand-new texture to another is INVISIBLE to
 * that check (`NodeSampledTexture.update()` returning true only re-reads the
 * value; it does not force the rebind), and every material's cached bind group
 * keeps naming the PREVIOUS texture. Destroy that texture and every later
 * submit fails with
 *
 *   Destroyed texture [Texture "gi2Glossy"] used in a submit
 *
 * — measured on this exact tree: 212 of them across four resize hops WITH the
 * deferred-retire queue already in place. ⭐⭐ THE QUEUE ALONE ONLY MOVES THE
 * CRASH THREE FRAMES LATER, because the stale binding is never repaired; the
 * unique version is what makes the swap actually rebind. `createGiTargets`
 * learned this on the SRC path (`++targetGeneration`) and the GI2 gather was
 * built without it. Storage textures take the `createTexture` branch regardless
 * of version, so nothing else changes.
 */
let gi2TextureGeneration = 0;

export function createGi2System({
  renderer, engine, tier = "high", resolveWidth, resolveHeight, gbuffer,
  lights = null, emitters = null, lightTree = null, env = null, shared = null,
}) {
  if (!GATHER_TIERS[tier]) throw new Error(`gi2: unknown tier "${tier}"`);
  const store = shared ?? {};
  let width = Math.max(16, Math.round(resolveWidth));
  let height = Math.max(16, Math.round(resolveHeight));

  // ── the scene-independent half: built once, never rebuilt by content ──────
  const win = createGiWindow(tier, { dynamic: true });
  const trace = createWindowTrace(win);
  // ⭐ §19 STAGE 5.3b — the SECONDARY (irradiance) region is built only for the
  // cascades. On the shipped chain `erc` is false and the cache allocates
  // exactly the words 5.3 allocated, which is "RC5 off is byte-identical"
  // stated where the memory is spent rather than only where the kernels are.
  const cache = createRadianceCache(win, {
    tier, erc: rc5PathEnabled() && rcHitPathEnabled(),
  });

  let gather = null;
  let voxelizer = null;
  let dynamic = null;
  let soup = null;
  /**
   * §19 STAGE 5.5b — `createShadowBvhGpu`'s handle once the worker BVH lands,
   * `null` until then. NOT awaited anywhere: first light is served by the voxel
   * arm exactly as 5.4d shipped, and the exact arm arrives as a SWAP —
   * `swapShadowBvh` rebuilds the gather the same way `setSize` does and nothing
   * else in the system knows it happened.
   */
  let shadowBvh = null;
  let emitterDirect = null;
  let aoCompose = null;
  let aoOut = null;
  /**
   * §19 STAGE 5.1 — the ported radiance cascades, or `null`. Built with the
   * gather and retired with it: every kernel in it closes over the gather's
   * `shadeHit`, its uniform bag and its palette, so it cannot outlive one.
   */
  let rc = null;
  const RC5 = rc5PathEnabled();
  /**
   * §19 5.4b — the old world path is not BUILT under RC5 (`worldProbes`' LEAN
   * arm), so its resolve must not be DISPATCHED either. One name, read once,
   * so the two halves of the cut cannot disagree.
   */
  const RC5_CUT = RC5 && (globalThis.__gi2Rc5Cut ?? 1) !== 0;

  let frame = 0;
  let disposed = false;
  let coarseFrames = 0;
  /**
   * ⭐⭐ §19 STAGE 3.14 — THE LATTICE'S CPU MIRRORS, DRAINED (audits §I.2).
   *
   * `instancedArray(new Uint32Array(n))` keeps the full typed array alive for
   * the life of the attribute: three uploads it once and then never reads it,
   * but `Buffer._buffer` captured it at first bind and `info.memoryMap` pins
   * the attribute forever (§I.1). One 32³ lattice was 22 MB of that and nobody
   * noticed; THREE cascades are 70 MB, which is more than the whole rest of
   * GI2's JS side, and the flip is gated on a heap number.
   *
   * `detachCpuMirror` transfers the ArrayBuffer to zero length — a real free,
   * not a bookkeeping line — but only AFTER the buffer has been uploaded, so
   * the queue is drained from `passes()` (see the note there for why NOT from
   * `notePassesRan`) and an entry that is not ready yet stays in the list and
   * is retried. The list empties and stops costing anything. Receipt, from the
   * Bistro motion run's console census: `[gi2] detached 4 lattice CPU
   * mirror(s) — 66.8 MB of JS heap the GPU buffers do not need`.
   *
   * ⚠ ONLY GPU-ONLY BUFFERS GO IN HERE. `worldProbes.cpuMirrors()` publishes
   * exactly its four, every one of which is written by a kernel and read by a
   * kernel; `readLive` reads a READBACK copy, never `attr.array`. Anything the
   * CPU writes later (`addUpdateRange` + `needsUpdate`) would silently upload
   * zero bytes — see `detachCpuMirror`'s own warning.
   */
  let mirrorQueue = [];
  let cacheCleared = false;
  const t0 = performance.now();
  const marks = { build: 0, soup: 0, voxelizer: 0, occupancy: new Map(), firstLight: 0 };
  /**
   * §19 Stage 4.3b: first light against the SCENE-OPEN clock, or null when the
   * light has not arrived (or the engine predates the stamp). Null, never 0 —
   * "has not happened" and "happened instantly" are different answers and a
   * gate must not be able to confuse them.
   */
  const firstLightFromSceneOpen = () => (marks.firstLight && engine?.sceneOpenAt
    ? Math.round(marks.firstLight - engine.sceneOpenAt) : null);
  const counters = {
    soupTris: 0, soupMB: 0, soupBuildMs: 0, soupStallMs: 0, soupDropped: 0, soupTruncated: false,
    palClasses: 0, palEmissiveClasses: 0, palEmitterBand: 0, movers: 0, moverTris: 0, scrolls: 0,
    // §19 Stage 4.1's receipts, and the reason the stage found anything:
    // `voxMs` is the LAST measured GPU cost of the pre-gbuffer chain,
    // `voxMsPeak` the worst since the build, `voxOverBudget` how many samples
    // exceeded the frame's allowance. They ride `snapshot()`, so they cost no
    // readback — which is the whole point, because a burst is exactly what a
    // 30-frame readback cadence and an EMA'd `gpuMs` are both blind to.
    voxMs: 0, voxMsPeak: 0, voxBudgetMs: VOX_BOOT_MS, voxSamples: 0, voxOverBudget: 0,
  };
  // The class assignment this build baked into the soup and the voxel bytes —
  // the ONLY thing `#retintGi2Palette` may reuse (see `build`).
  let paletteAssign = null;
  let lastVox = null;
  let lastDyn = null;
  let lastGather = null;

  // ── camera / lighting mirrors ─────────────────────────────────────────────
  const camPos = new THREE.Vector3();
  const viewProj = new THREE.Matrix4();
  const prevViewProj = new THREE.Matrix4();
  let camera = null;
  let placed = false;
  let pendingScroll = true;
  let scrollInLastList = false;

  // ══════════════════════════════════════════════════════ THE GATHER + ITS PASSES
  //
  // Rebuilt on resize (its buffers and its two output textures are sized to the
  // resolve), which is why every consumer outside this module reads
  // `gi2.textures.*` through a PERSISTENT `texture()` node whose `.value` is
  // repointed — the same contract `_giShadowPosNode` already has.
  const buildGather = () => {
    // ══ WHY AO GETS ITS OWN OUTPUT TEXTURE ═══════════════════════════════════
    //
    // The obvious shape — read the gather's `irradiance`, multiply, store back
    // into it — DOES NOT COMPILE. A storage texture that is both sampled and
    // written inside one kernel is bound ONCE, as `texture_2d<f32>`, and WGSL
    // then rejects `textureStore` on it:
    //
    //   no matching call to 'textureStore(texture_2d<f32>, vec2<u32>, vec4<f32>)'
    //
    // Its cost is one more RGBA16F at resolve res (~6 MB at 1650×970) and one
    // full-res copy, which is what the multiply already was. What it BUYS,
    // besides compiling, is that the gather's own `composite` pass still reads
    // the UNOCCLUDED irradiance — GTAO is a shading-time term, and folding it
    // into the radiance the cache remembers would compound it every bounce.
    if (env?.ao && !aoOut) {
      aoOut = new THREE.StorageTexture(width, height);
      aoOut.name = "gi2IrradianceAo";
      aoOut.type = THREE.HalfFloatType;
      aoOut.generateMipmaps = false;
      aoOut.minFilter = THREE.NearestFilter;
      aoOut.magFilter = THREE.NearestFilter;
      // THE MATERIAL-FACING IRRADIANCE WHEN AO IS ON — see gi2TextureGeneration.
      aoOut.version = ++gi2TextureGeneration;
    }
    // ⭐⭐ §19 4.3f — THE PALETTE SURVIVES THE REBUILD, AND IT DID NOT BEFORE.
    //
    // `setSize` replaces the gather, and the palette lives ON the gather as two
    // `uniformArray`s. `setPalette` is called exactly twice in the tree — from
    // `build` and from `#retintGi2Palette` — and NEITHER runs on a resize,
    // which by design does not rebuild. So every viewport drag zeroed the
    // albedo and emissive tables: from then on every ray hit shaded against
    // albedo 0 and no palette class carried emission, until the next full GI
    // build put them back.
    //
    // ⚠ FOUND BY THE OCCUPANCY DEBUG VIEW, not by a lighting receipt — its
    // console line reports "N classes carry colour", and after a resize hop it
    // printed 0. A term whose loss shows up as "the bounce got a bit darker"
    // has no other tell; a view that names the number does.
    //
    // Copying the LIVE VECTORS (rather than re-running `setPalette` from a
    // stored source) is what makes this correct for both writers: the re-tint
    // path writes through the gather's own arrays too, so whatever the last
    // word was, this carries it.
    const prev = gather;
    gather = createGiGather({
      win, trace, cache,
      positionTexture: gbuffer.position,
      normalTexture: gbuffer.normal,
      width, height, tier,
      // ⭐ §19 STAGE 4.0 — ZERO, SO `gi2.crop` CANNOT EXIST ON THE ENGINE PATH.
      // It is a harness receipt (526 kB of WGSL, 11.8 s of driver compile at
      // 4.3a) that nothing in a frame dispatches, yet it rode `computeNodes`
      // — the OWNERSHIP list — into every consumer that walks it. The harness
      // pages construct their own gather and pass their own crop count; see
      // `createGiGather`'s note at the buffers.
      crops: 0,
      // §19 Stage 3.5 — THE 3.2 API GAP IS CLOSED (see the header note, now
      // historical). The gather takes the system's own nodes; nothing is
      // mirrored, and there is one authored description of the sun, of the
      // sky, and of each emitter slot.
      sun: env?.sun ?? null,
      sky: env?.sky ? { color: env.sky } : null,
      // Slot NEE at every ray hit — second-bounce lamp light without waiting
      // for `injectLitFrame` to see the surface. Same four slots the per-probe
      // `emitterDirectPass` below reads, same solid-angle expression.
      emitters: emitters ?? null,
      // ⭐⭐ §19 STAGE 5.3 — the face cache becomes DIRECT ONLY when the
      // cascades own the picture. See `createGiGather`'s `rc5` note: the sky
      // rays and `injectLitFrame` both write TOTAL radiance into the same
      // words the merged field is about to contribute again at every hit.
      rc5: RC5 && rcHitPathEnabled(),
    });
    if (prev?.palette?.length) {
      const n = Math.min(prev.palette.length, gather.palette.length);
      for (let i = 0; i < n; i++) {
        gather.palette[i].copy(prev.palette[i]);
        gather.paletteEmissive[i].copy(prev.paletteEmissive[i]);
      }
    }
    // ⭐⭐ THE REBIND STAMP (see `gi2TextureGeneration`). Only the two textures
    // MATERIALS sample need it — `irradiance` (when AO is off it is the one
    // `_giIrradianceNode` points at) and `glossy` (`_giRadianceNode`). `lit` and
    // the two halves are read by COMPUTE passes, which are re-recorded every
    // frame off the live node and were never able to go stale.
    gather.textures.irradiance.version = ++gi2TextureGeneration;
    gather.textures.glossy.version = ++gi2TextureGeneration;
    gather.uniforms.projScale.value = projScaleOf(camera, height);
    // The Cornell panel is the harness rig's emitter and has no scene source.
    // Zeroed ONCE, at build: `shadeHit`'s panel NEE then contributes nothing
    // for the life of the gather, and scene emitters arrive through the slot
    // NEE above and through `emitterDirectPass`.
    gather.uniforms.panelRadiance.value.set(0, 0, 0);
    for (const [key, node] of Object.entries(gather.passes)) {
      const stamp = (n, i) => {
        if (n && typeof n === "object") n.__giPassName ??= i == null ? `gi2.${key}` : `gi2.${key}#${i}`;
      };
      if (Array.isArray(node)) node.forEach(stamp);
      else stamp(node);
    }
    // ⭐⭐ §19 STAGE 3.14 — NOT ON THE WORLD PATH. `emitterDirectPass` is one
    // thread per SCREEN PROBE, adding each emitter slot's analytic solid angle
    // into `probeSh`; under world probes there are no screen probes, `probeSh`
    // has no reader, and `worldProbes`' own `neePass` already does exactly this
    // job at every lattice probe, off the SAME `emitterSh` expression — so the
    // energy is identical and this dispatch was writing a buffer nothing reads.
    // Harmless by construction (3.13 kept `probeSh` at full size precisely so
    // it would be) and still a kernel to compile, a pass to record and a bind
    // group to keep alive on every frame of every world-path boot.
    emitterDirect = (emitters?.length && !gather.worldProbes) ? buildEmitterDirectPass() : null;
    // ⭐ §19 STAGE 5.1 — THE CASCADES, BESIDE THE WORLD PROBES AND NOT INSTEAD
    // OF THEM. `RC5_PATH` off builds not one node of this (and imports nothing
    // from `srcProbes`/`srcDeposit` into any live chain), which is the gate
    // "the shipped path stays byte-identical" stated as code rather than as an
    // intention. The kit is the gather's PUBLISHED closures — one definition of
    // the hit estimator, reached from two kernels.
    rc = RC5
      ? createRcCascades({
        win,
        trace,
        cache,
        gbuffer,
        width,
        height,
        tier,
        // §19 5.3 — the seated emitters' direct term at the pixel. The same
        // four slots `emitterDirectPass` reads on the screen path and
        // `worldProbes.neePass` reads on the world one; the cascades had no
        // carrier for a promoted lamp at all until this.
        emitters: rc5PixelNeeEnabled() ? (emitters ?? null) : null,
        kit: {
          u: gather.uniforms,
          dominantFace: gather.internals.dominantFace,
          faceSamplePoint: gather.internals.faceSamplePoint,
          shadeHit: gather.internals.shadeHit,
          // §19 5.3 — the albedo/emission [J] deposits with, from the same two
          // tables and under the same two rules `shadeHit` reads them.
          hitPalette: gather.internals.hitPalette,
          // §19 5.3c — the emitter's PROJECTED-AREA share for one ray. `null`
          // on the isotropic arm, where the cache word is still the carrier.
          hitEmissionRay: gather.internals.hitEmissionRay,
        },
        // ⭐⭐ §19 STAGE 5.2 — THE DESTINATION IS THE ENGINE'S OWN HALF-RES
        // TEXTURE, AND THAT IS THE WHOLE RESOLVE. `resolveUpsample` reads this,
        // writes `textures.irradiance`, and everything after it — the 3.12
        // accumulator, GTAO's compose, the lit-frame injection, the material
        // hook, the `indirect` view, every `probe:gi2-*` — is unchanged and
        // cannot tell which estimator filled it. See `rcMerge.js`.
        irradianceHalf: gather.textures.irradianceHalf,
        // §19 5.5a — the specular half of the same destination. 5.4b's cut
        // removed `resolveHalf`, which was `glossyHalf`'s only writer; the
        // cascades take over BOTH stores or the frame has no specular term.
        glossyHalf: gather.textures.glossyHalf,
        // §19 STAGE 5.5b — the exact triangle shadow arm, or `null` while the
        // worker is still building it. Read HERE, at graph-build time, which is
        // exactly why `swapShadowBvh` has to rebuild the gather rather than
        // poke a uniform: the two arms are different kernels.
        shadowBvh: rc5BvhShadowEnabled() ? shadowBvh : null,
      })
      : null;
    if (rc) {
      rc.frameOrder.forEach((n, i) => {
        if (n && typeof n === "object") n.__giPassName ??= `gi2.rc#${i}`;
      });
    }
    // The new gather's lattice buffers, queued for their mirror detach. Re-set
    // (not appended) because a resize replaces the gather and the DEAD one's
    // attributes go to the retire queue, which frees them outright.
    mirrorQueue = gather.world?.cpuMirrors?.() ?? [];
    // AO is armed LAZILY (first `passes()`), never here: `#armGtaoPass` assigns
    // `ao.node` after the screen chain is built, and this system is constructed
    // before it so its two textures can be the ones the chain points at. A
    // kernel built against `ao.node === null` would compile the AO term out and
    // stay that way for the life of the build.
    aoCompose = null;
  };

  const projScaleOf = (cam, h) => (cam?.isPerspectiveCamera
    ? (h / 2) / Math.tan((cam.fov * Math.PI) / 360)
    : h / 2);

  // ══════════════════════════════════════════ SHADER: emitter direct at the probe
  //
  // One thread per probe. For each active emitter slot: the analytic solid
  // angle `min(π, π·reff²/d²)` — the SAME expression `giLight.emitterDirectAt`
  // uses, so an emitter delivers the same energy on both paths — one shadow ray
  // through the window, and an SH add.
  //
  // The shadow ray stops SHORT of the emitter's own body (`reff` plus half a
  // level-0 cell): the lamp's own geometry is voxelized, so a ray run to the
  // full distance is occluded by the very light it is sampling. `shadeHit`'s
  // panel NEE carries the identical correction for the identical reason.
  const buildEmitterDirectPass = () => {
    const { probeW, probeH, probeCount, uniforms: u } = gather;
    const probeMeta = gather.buffers.probeMeta;
    const probeSh = gather.buffers.probeSh;
    const { traceWindow } = trace;
    const v0 = win.voxel0;
    const META_VEC = 3;
    const metaIdx = (half, probe, slot) => half.mul(uint(probeCount * META_VEC))
      .add(probe.mul(uint(META_VEC))).add(uint(slot));
    const shIdx = (probe, c) => probe.mul(uint(9)).add(uint(c));

    return Fn(() => {
      const gx = globalId.x.toVar();
      const gy = globalId.y.toVar();
      If(gx.greaterThanEqual(u.probeWU).or(gy.greaterThanEqual(u.probeHU)), () => { Return(); });
      const probe = gy.mul(u.probeWU).add(gx).toVar();
      const a = probeMeta.element(metaIdx(u.curBase, probe, uint(0))).toVar();
      If(a.w.lessThan(0.5), () => { Return(); });
      const p = a.xyz.toVar();
      const n = normalize(probeMeta.element(metaIdx(u.curBase, probe, uint(1))).xyz).toVar();

      // Accumulated as ONE delta and written once: nine read-modify-writes per
      // emitter would be nine dependent buffer round-trips for a term that is
      // additive by construction.
      const sh = [];
      for (let i = 0; i < 9; i++) sh.push(vec3(0).toVar());

      for (const slot of emitters) {
        const centre = vec3(slot.center).toVar();
        const reff = float(slot.reff).max(1e-3).toVar();
        const rgb = vec3(slot.color).toVar();
        // `radius` is the bounding sphere and doubles as the ACTIVE gate
        // (`#refreshEmitterSlots` zeroes a retired slot's radius).
        const active = float(slot.radius).greaterThan(1e-5)
          .and(rgb.x.add(rgb.y).add(rgb.z).greaterThan(1e-6));
        If(active, () => {
          const wv = centre.sub(p).toVar();
          const d2 = dot(wv, wv).max(1e-4).toVar();
          const d = sqrt(d2).toVar();
          const wd = wv.div(d).toVar();
          const cosX = dot(n, wd).toVar();
          If(cosX.greaterThan(1e-3), () => {
            // min(π, π r²/d²) — the sphere's solid angle, saturating when the
            // receiver is inside it.
            const omega = float(Math.PI).min(float(Math.PI).mul(reff.mul(reff)).div(d2)).toVar();
            const reach = d.sub(reff).sub(float(v0 * 0.5)).max(v0 * 0.5).toVar();
            const vis = float(1).sub(traceWindow(p, wd, reach, n).hit).toVar();
            If(vis.greaterThan(0.001), () => {
              const c = rgb.mul(omega).mul(vis).toVar();
              sh[0].addAssign(c.mul(0.282095));
              sh[1].addAssign(c.mul(wd.y.mul(0.488603)));
              sh[2].addAssign(c.mul(wd.z.mul(0.488603)));
              sh[3].addAssign(c.mul(wd.x.mul(0.488603)));
              sh[4].addAssign(c.mul(wd.x.mul(wd.y).mul(1.092548)));
              sh[5].addAssign(c.mul(wd.y.mul(wd.z).mul(1.092548)));
              sh[6].addAssign(c.mul(wd.z.mul(wd.z).mul(3).sub(1).mul(0.315392)));
              sh[7].addAssign(c.mul(wd.x.mul(wd.z).mul(1.092548)));
              sh[8].addAssign(c.mul(wd.x.mul(wd.x).sub(wd.y.mul(wd.y)).mul(0.546274)));
            });
          });
        });
      }
      for (let i = 0; i < 9; i++) {
        const idx = shIdx(probe, i);
        const cur = probeSh.element(idx).toVar();
        probeSh.element(idx).assign(vec4(cur.xyz.add(sh[i]), 0));
      }
    })().compute([Math.ceil(probeW / 8), Math.ceil(probeH / 8)], [8, 8, 1]);
  };

  // ══════════════════════════════════════════ SHADER: AO onto the resolved diffuse
  //
  // §M.3's "AO stays GTAO". The old path multiplied it inside `createGiResolve`;
  // GI2's resolve lives in `gatherProbes` and knows nothing about AO, so the
  // multiply is its own kernel over the irradiance texture — read, scale,
  // store, in place.
  //
  // The half-res upsample is the SAME position/normal-weighted 2×2 the resolve
  // used, and for the same measured reason: hardware bilinear magnification
  // crosses silhouettes and haloes a pillar's occlusion onto the floor beside
  // it. GLOSSY IS NOT TOUCHED — reflections carry their own visibility, and
  // obscuring them twice reads as dirt (the old resolve's rule, kept).
  const buildAoComposePass = () => {
    const ao = env.ao;
    const aoNode = ao.node;
    if (!aoNode) return null;
    const aoW = ao.width ?? aoNode.value?.image?.width ?? Math.max(16, Math.round(width * 0.5));
    const aoH = ao.height ?? aoNode.value?.image?.height ?? Math.max(16, Math.round(height * 0.5));
    const irrNode = texture(gather.textures.irradiance);
    const posNode = texture(gbuffer.position);
    const nrmNode = texture(gbuffer.normal);
    const u = gather.uniforms;
    const toLowX = aoW / width;
    const toLowY = aoH / height;
    const toFullX = width / aoW;
    const toFullY = height / aoH;

    return Fn(() => {
      const px = globalId.x.toVar();
      const py = globalId.y.toVar();
      If(px.greaterThanEqual(u.widthU).or(py.greaterThanEqual(u.heightU)), () => { Return(); });
      const coord = ivec2(px.toInt(), py.toInt());
      const g = posNode.load(coord).toVar();
      // A sky pixel still has to be COPIED — this is a separate texture, and an
      // untouched texel holds whatever the last frame's geometry put there.
      If(g.w.lessThan(0.5), () => {
        textureStore(aoOut, coord, irrNode.load(coord));
        Return();
      });
      const P = g.xyz.toVar();
      const N = normalize(nrmNode.load(coord).xyz).toVar();
      const lowX = px.toFloat().add(0.5).mul(toLowX).sub(0.5).toVar();
      const lowY = py.toFloat().add(0.5).mul(toLowY).sub(0.5).toVar();
      const baseX = lowX.floor().toVar();
      const baseY = lowY.floor().toVar();
      const fx = lowX.sub(baseX).toVar();
      const fy = lowY.sub(baseY).toVar();
      const value = float(0).toVar();
      const weight = float(0).toVar();
      const tap = (dx, dy) => {
        const bl = (dx === 0 ? fx.oneMinus() : fx).mul(dy === 0 ? fy.oneMinus() : fy);
        const lx = baseX.add(dx).toInt().clamp(int(0), int(aoW - 1)).toVar();
        const ly = baseY.add(dy).toInt().clamp(int(0), int(aoH - 1)).toVar();
        const gxi = lx.toFloat().add(0.5).mul(toFullX).toInt().clamp(int(0), int(width - 1));
        const gyi = ly.toFloat().add(0.5).mul(toFullY).toInt().clamp(int(0), int(height - 1));
        const tapP = posNode.load(ivec2(gxi, gyi)).toVar();
        const tapN = normalize(nrmNode.load(ivec2(gxi, gyi)).xyz).toVar();
        const sameNormal = smoothstep(0.7, 0.95, dot(tapN, N).abs());
        const sameDepth = float(1).sub(smoothstep(0.12, 0.75, dot(N, tapP.xyz.sub(P)).abs()));
        const w = select(tapP.w.greaterThan(0.5), sameNormal.mul(sameDepth), float(0)).mul(bl).toVar();
        value.addAssign(aoNode.load(ivec2(lx, ly)).x.mul(w));
        weight.addAssign(w);
      };
      tap(0, 0); tap(1, 0); tap(0, 1); tap(1, 1);
      // A disocclusion has no trustworthy low-res neighbour; unoccluded beats
      // importing a wall's dark factor across the silhouette for a frame.
      const factor = select(weight.greaterThan(1e-4), value.div(weight.max(1e-4)), float(1)).toVar();
      const c = irrNode.load(coord).toVar();
      textureStore(aoOut, coord, vec4(c.xyz.mul(factor), c.w));
    })().compute([Math.ceil(width / 8), Math.ceil(height / 8)], [8, 8, 1]);
  };

  buildGather();

  // ══════════════════════════════════════════════════════════════════ BUILD
  //
  // Async by construction and NOT awaited by the caller: the window exists the
  // moment this returns (so `setCamera` and the trace are live), the soup is
  // built off-thread, and the voxelizer + dynamic layer are created when it
  // lands. Until then `passes()` returns the gather chain alone — which reads
  // an empty window and resolves black, exactly as a first frame should.
  const build = async ({ geometries, placements, movers = [], soupKey = null } = {}) => {
    marks.build = performance.now();
    voxelizer = null;
    dynamic = null;
    soup = null;
    cacheCleared = false;
    coarseFrames = 0;
    placed = false;
    win.reset();

    const surfaces = placements.map((p) => ({
      albedo: p.albedo ?? [0.5, 0.5, 0.5],
      emissive: p.emissive ?? 0,
      area: p.area ?? 1,
      emitter: !!p.emitter,
      matKey: p.matKey ?? "",
    }));
    const { palette, index, emitterClasses } = buildGi2Palette(surfaces);
    const emLum = (e) => (Array.isArray(e) ? (e[0] + e[1] + e[2]) / 3 : (e ?? 0));
    counters.palClasses = palette.filter((e, i) => i < GI2_PAL_CLASSES
      && (e.albedo[0] + e.albedo[1] + e.albedo[2] + emLum(e.emissive)) > 0).length;
    // §O.4's missing receipt: how many classes actually CARRY emission. "16
    // classes" and "0 of them emit" were the same number for three sessions
    // because nobody published the second one.
    counters.palEmissiveClasses = palette.filter((e, i) => i < GI2_PAL_CLASSES && emLum(e.emissive) > 0).length;
    counters.palEmitterBand = emitterClasses.length;
    gather.setPalette(palette);
    // ⭐ §19 Stage 4.0b — WHAT A RE-TINT NEEDS, AND ONLY THAT (audits §O.5(c)).
    //
    // The class ASSIGNMENT (this `index`, keyed to the placement list that
    // produced it) is what got baked into `triPal` and the voxel bytes. A
    // re-tint re-resolves the materials and recomputes each class's MEAN
    // against this same assignment — never re-clusters, because re-clustering
    // would renumber classes the world is already written with.
    paletteAssign = {
      classOf: index,
      keys: placements.map((p) => p.key ?? null),
      emitterClasses,
      classCount: PAL_ENTRIES,
    };
    const soupPlacements = placements.map((p, i) => ({
      geometryKey: p.geometryKey, matrix: p.matrix, pal: index[i], slot: p.slot,
    }));

    // The soup survives a rebuild whose geometry did not change — a GI rebuild
    // is triggered by a quality change, a resize, a refit and a light edit far
    // more often than by a mesh appearing, and re-running a 3 M-triangle worker
    // pass for a resize is three seconds of first-light latency bought for
    // nothing.
    // ── §19 STAGE 4.3b (§R.2) — HOW MANY TIMES THE WORKER RAN, THIS SCENE ────
    //
    // The gate is "1 per scene open with merging on", and neither half of that
    // could be read before: `store` outlives the GI2 system (it survives a
    // resize on purpose), so a raw counter would carry the Level's builds into
    // Bistro's number. Keyed on the engine's own scene-open stamp, which is the
    // same anchor `firstLightFromSceneOpenMs` uses.
    const sceneOpenAt = engine?.sceneOpenAt ?? 0;
    if (store.soupBuildsFor !== sceneOpenAt) {
      store.soupBuildsFor = sceneOpenAt;
      store.soupBuilds = 0;
    }
    let built = null;
    if (soupKey != null && store.soupKey === soupKey && store.soup) {
      built = store.soup;
      counters.soupBuildMs = 0;
      counters.soupStallMs = 0;
      // ⭐ THE KEY HELD. Said out loud because "the soup was not rebuilt" is
      // invisible otherwise — the only evidence used to be the ABSENCE of a
      // build line, and an absence is not a receipt.
      console.log(`[gi2] soup unchanged — the placement key held (${store.soupBuilds} worker run` +
        `${store.soupBuilds === 1 ? "" : "s"} this scene open); no re-voxelize of the static set`);
    } else {
      store.soupBuilds = (store.soupBuilds ?? 0) + 1;
      const builder = (store.builder ??= createTriangleSoupBuilder());
      try {
        built = await builder.build({
          geometries, placements: soupPlacements,
          triCap: tier === "phone" || tier === "medium" ? 1_000_000 : undefined,
        });
      } catch (err) {
        if (err instanceof SoupSupersededError || err?.superseded) return false;
        console.warn(`[gi2] triangle soup failed: ${err?.message ?? err} — the window stays empty`);
        return false;
      }
      counters.soupBuildMs = builder.lastBuildMs;
      counters.soupStallMs = builder.lastStallMs;
      store.soup = built;
      store.soupKey = soupKey;
    }
    if (disposed) return false;

    marks.soup = performance.now();
    counters.soupTris = built.triCount;
    counters.soupMB = +(built.bytes / 1048576).toFixed(1);
    counters.soupDropped = built.dropped ?? 0;
    counters.soupTruncated = !!built.truncated;
    console.log(
      `[gi2] soup ${built.triCount} tris, ${counters.soupMB} MB, built in ` +
      `${Math.round(counters.soupBuildMs)} ms off-thread (main thread blocked ` +
      `${counters.soupStallMs.toFixed(1)} ms)` +
      (built.truncated ? ` — TRUNCATED at the tier cap, ${built.dropped} triangles dropped` : "") +
      `; palette ${counters.palClasses} of ${GI2_PAL_CLASSES} classes, ` +
      `${counters.palEmissiveClasses} with emission (${counters.palEmitterBand} in the reserved emitter band)`,
    );

    soup = uploadSoup(built);
    // ── §19 STAGE 5.5b — THE BVH, FIRED AND NOT AWAITED ──────────────────────
    //
    // Deliberately AFTER `uploadSoup` and BEFORE the voxelizer: the worker owns
    // its copy from this instant, so its build overlaps everything below —
    // voxelization, the dynamic set, the whole pipeline compile wave. On a
    // scene where that wave is seconds long the tree lands inside it and the
    // swap is invisible; on a trivial scene the build is milliseconds. Neither
    // case blocks first light, because nothing here is awaited.
    //
    // ⚠ THE COPY IS MANDATORY. `build()` TRANSFERS the array, and `built.tris`
    // is still referenced by the `instancedArray` above (and by `store.soup`,
    // which survives a rebuild) — transferring it would detach a buffer the
    // renderer is about to upload. The copy is freed the moment the worker
    // takes ownership; the reordered tree it sends back is the only lasting
    // allocation.
    kickShadowBvh(built);
    voxelizer = createWindowVoxelizer(win, soup, tier);
    dynamic = createWindowDynamic(win, voxelizer, tier);
    stampVoxNames();
    setMovers(movers);
    marks.voxelizer = performance.now();
    return true;
  };

  /**
   * Starts (or restarts) the exact-shadow BVH build for a soup. Fire and
   * forget: every failure path here ends with `shadowBvh` still `null` and the
   * voxel arm still serving, which is a picture the user has already seen
   * rather than a black frame.
   */
  const kickShadowBvh = (built) => {
    if (!rc5BvhShadowEnabled() || !built?.triCount) return;
    // ⛔ NOT ON PHONE. The tree is tens of MB of storage buffer on top of a
    // budget the phone tier is already at, and a 64-deep stack of `u32` per
    // thread is a register cost a tile GPU pays badly. The voxel arm is the
    // phone arm, and it is stated here rather than inside a tier table so the
    // reason travels with the decision.
    if (tier === "phone") {
      console.log("[gi2] exact shadow rays: OFF on the phone tier — the voxel arm serves");
      return;
    }
    const builder = (store.bvhBuilder ??= createShadowBvhBuilder());
    const t0 = performance.now();
    builder.build({ tris: built.tris.slice(), triCount: built.triCount, triCap: SHADOW_BVH_TRI_CAP })
      .then((bvh) => {
        if (disposed) return;
        const wall = performance.now() - t0;
        console.log(
          `[gi2] shadow bvh ${bvh.triCount} tris, ${bvh.nodeCount} nodes, ` +
          `${(bvh.bytes / 1048576).toFixed(1)} MB, built in ${Math.round(bvh.stats?.buildMs ?? 0)} ms ` +
          `off-thread (${Math.round(wall)} ms wall, depth ${bvh.stats?.maxDepth ?? "?"})` +
          (bvh.stats?.truncated ? ` — TRUNCATED at the ${SHADOW_BVH_TRI_CAP} triangle cap` : ""),
        );
        const gpu = createShadowBvhGpu(bvh);
        if (gpu) swapShadowBvh(gpu);
      })
      .catch((err) => {
        // A superseding build is routine (two scene opens in a row), a real
        // failure is not — but neither is fatal, so both are one line and the
        // voxel arm keeps the frame.
        console.warn(`[gi2] shadow bvh unavailable: ${err?.message ?? err} — the direct term stays on the voxels`);
      });
  };

  const uploadSoup = (g) => {
    return {
      tris: instancedArray(g.tris, "float"),
      triPal: instancedArray(g.triPal, "uint"),
      cellRange: instancedArray(g.cellRange, "uint"),
      cellTris: instancedArray(g.cellTris, "uint"),
      origin: g.grid.origin, cell: g.grid.cell, dim: g.grid.dim,
    };
  };

  const stampVoxNames = () => {
    const stamp = (list, prefix) => list?.forEach((n, i) => {
      if (n && typeof n === "object") n.__giPassName ??= `${prefix}#${i}`;
    });
    stamp(voxelizer?.passes([0, 0, 0], null), "gi2.voxelize");
    stamp(dynamic?.passes(), "gi2.dyn");
    const all = [win.scrollPass, win.statsResetPass, win.clearStaticPass, cache.allocPass, cache.clearPass];
    all.forEach((n, i) => { if (n && typeof n === "object") n.__giPassName ??= `gi2.window#${i}`; });
    if (emitterDirect) emitterDirect.__giPassName ??= "gi2.emitterDirect";
    if (aoCompose) aoCompose.__giPassName ??= "gi2.aoCompose";
  };

  // ══════════════════════════════════════════════════════════════════ PER FRAME
  const setCamera = (cam) => {
    camera = cam ?? camera;
    if (!camera) return null;
    camera.updateMatrixWorld(true);
    camPos.setFromMatrixPosition(camera.matrixWorld);
    prevViewProj.copy(viewProj);
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!placed) prevViewProj.copy(viewProj);
    const receipt = win.setCamera([camPos.x, camPos.y, camPos.z]);
    rc?.setCamera([camPos.x, camPos.y, camPos.z]);
    // THE SCROLL IS NOT A PER-FRAME PASS. It re-keys every brick the camera's
    // move invalidated, and on a frame with no move it is a 4096-thread
    // dispatch that writes nothing. `win.setCamera` already answers "did the
    // origin actually step"; that answer is the gate.
    if (receipt.scrolled || !placed) {
      pendingScroll = true;
      if (receipt.scrolled) counters.scrolls++;
    }
    placed = true;
    return receipt;
  };

  const setMovers = (list) => {
    if (!dynamic) return null;
    const packed = [];
    for (const m of list ?? []) {
      if (!m) continue;
      const mover = m.soup
        ? m
        : { ...m, soup: moverBoxSoup(m.min ?? [-0.5, -0.5, -0.5], m.max ?? [0.5, 0.5, 0.5], m.pal ?? PAL_NONE) };
      packed.push(mover);
    }
    const receipt = dynamic.setMovers(packed);
    counters.movers = packed.length;
    counters.moverTris = receipt?.triangles ?? 0;
    return receipt;
  };

  /**
   * The per-frame CAMERA uniforms, and only those.
   *
   * ⭐ §19 Stage 3.5 — THE LIGHTING MIRROR IS GONE. Stage 3.4 copied three
   * vectors here every frame (the sun's direction and colour, the sky's
   * radiance) because `createGiGather` minted its own uniforms and there was
   * no way to hand it the system's. It takes `{sun, sky}` NODES now
   * (`buildGather` passes them), so the values are read by identity: the
   * engine writes them once, where it computes them (`#updateLightUniforms`),
   * and there is no second place for them to be wrong.
   *
   * ⚠ `env.sunSlot` is consequently NOT read here any more. Picking the
   * analytic sun out of the slot list is `#updateLightUniforms`' job and it
   * already does it — reading the index a second time to re-derive the same
   * answer was the mirror, not a safeguard.
   */
  const syncLighting = () => {
    const u = gather.uniforms;
    u.camPos.value.copy(camPos);
    u.viewProj.value.copy(viewProj);
    u.prevViewProj.value.copy(prevViewProj);
    u.projScale.value = projScaleOf(camera, height);
  };

  // ═══════════ §19 STAGE 4.1: THE PRE-GBUFFER CHAIN'S REAL GPU COST ═════════
  //
  // ⛔ NOT A CONTROLLER ANY MORE — see the `VOX_MS_BUDGET` header for the sweep
  // that refuted spending an ms budget by admitting fewer dirty bricks. What
  // is left is the measurement, which is what named the mechanism and is worth
  // keeping on its own: it costs one Map lookup a frame and it is the only
  // per-frame GPU number in this module that a burst cannot hide from.
  //
  // three's `WebGPUTimestampQueryPool` keeps a Map from a pass's uid to its
  // resolved GPU duration, and `backend.get(list).timestampUID` is that uid for
  // the array `giCompute` batched. So the chain's real cost is readable a few
  // frames later with no extra query, no readback and no suspended render loop.
  //
  // ⚠ READ THE POOL DIRECTLY, NOT THROUGH `backend.getTimestamp(uid)`: that
  // accessor picks its pool from the uid PREFIX, and a batched ARRAY has no
  // `isComputeNode`, so its uid says `r:` while its timestamp lives in the
  // COMPUTE pool — the accessor would look in the wrong one and warn. Consuming
  // the entry also stops three's Map, which nothing else in the engine reads and
  // nothing ever clears, from growing for the life of the session.
  const voxPending = [];
  let lastBeforeList = null;

  /** The window has filled and first light has arrived — `statsCadence`'s test. */
  const windowSettled = () =>
    (marks.occupancy.size >= win.levels && marks.firstLight > 0) ||
    (marks.voxelizer > 0 && performance.now() - marks.voxelizer > 20_000);

  const applyVoxSample = (ms) => {
    counters.voxMs = +ms.toFixed(3);
    counters.voxMsPeak = Math.max(counters.voxMsPeak, counters.voxMs);
    counters.voxBudgetMs = windowSettled() ? (VOX_MS_BUDGET[tier] ?? 2.0) : VOX_BOOT_MS;
    if (ms >= counters.voxBudgetMs) counters.voxOverBudget++;
    counters.voxSamples++;
  };

  /** Collect whatever the renderer's last timestamp resolve landed for our chain. */
  const drainVoxTimings = (r) => {
    if (!voxPending.length) return;
    const pools = r?.backend?.timestampQueryPool;
    if (!pools) { voxPending.length = 0; return; }
    const keep = [];
    // ⚠ THE COMPUTE POOL, AND ONLY IT. The uid's `r:` prefix is a lie of
    // three's own making (an array has no `isComputeNode`), but the timestamp
    // is written by `initTimestampQuery(COMPUTE, uid)` — so compute is where it
    // is, and consulting the render pool as a fallback would only expose this
    // to a uid collision with a render context that happens to share an id.
    const map = pools.compute?.timestamps;
    for (const p of voxPending) {
      let ms;
      if (map?.has(p.uid)) { ms = map.get(p.uid); map.delete(p.uid); }
      if (ms === undefined) {
        // ~4 s of frames to resolve, then drop: a pass whose queries were
        // evicted never lands and would otherwise hold this list forever.
        p.age = (p.age ?? 0) + 1;
        if (p.age < 240) keep.push(p);
        continue;
      }
      applyVoxSample(ms);
    }
    voxPending.length = 0;
    for (const p of keep) voxPending.push(p);
  };

  /**
   * §M.2's frame order. Returns the compute nodes in the order they must be
   * dispatched; the caller submits them (through `giCompute`'s batched submit),
   * which is what lets GI2 ride the same budget, freeze bisect and skip ledger
   * every other GI pass rides.
   *
   * The g-buffer prepass and GTAO are NOT in this list — the caller runs them,
   * between `passes(frame).before` and `passes(frame).after`. One list with a
   * split point rather than two calls, so the order stays readable in one place.
   */
  const passes = (frameIndex = frame) => {
    frame = frameIndex >>> 0;
    if (!gather) return { before: [], after: [], all: [] };
    gather.beginFrame(frame);
    // §19 5.1 — the cascades' own per-frame drivers: the R2 jitter, the frame
    // stamp the decay recognises a fresh block by, and the ray phase. Camera and
    // anchor are set in `setCamera`, where the window's are.
    rc?.beginFrame(frame);
    syncLighting();
    // §19 Stage 4.1: whatever the renderer's last timestamp resolve landed for
    // the pre-gbuffer chain. Publishes into `snapshot()`; drives nothing.
    drainVoxTimings(renderer);
    // §19 3.14 — the lattice's CPU mirrors, once its kernels have bound them.
    //
    // ⚠ HERE AND NOT IN `notePassesRan`, WHICH IS WHAT IT LOOKED LIKE IT WANTED.
    // That call only fires when the PRE-GBUFFER batch lands, and on a boot where
    // the voxelizer's pipelines keep the batch deferred it never fires at all —
    // so a queue drained from there could stay full for the life of the session,
    // silently, which is the shape of the shadow-freeze bug (a caller-position
    // dependency). `passes()` runs unconditionally every frame, and the real
    // precondition (has this buffer been uploaded?) is checked inside
    // `detachCpuMirror`, where it is a fact rather than an assumption.
    if (mirrorQueue.length) {
      const before = mirrorQueue.length;
      let freed = 0;
      mirrorQueue = mirrorQueue.filter((attr) => {
        const bytes = attr?.array?.byteLength ?? 0;
        if (!detachCpuMirror(renderer, attr)) return true;
        freed += bytes;
        return false;
      });
      // ⚠ ONE LINE, ONCE, AND ONLY WHEN THE QUEUE EMPTIES. §19 4.1 measured a
      // per-frame `console.log` on a CDP-attached page at 21 ms of frame time.
      if (freed > 0 && mirrorQueue.length === 0) {
        console.log(`[gi2] detached ${before} lattice CPU mirror(s) — ` +
          `${(freed / 1048576).toFixed(1)} MB of JS heap the GPU buffers do not need`);
      }
    }

    const before = [];
    // The window's own bookkeeping. `statsResetPass` every frame (its receipts
    // are per-frame); the scroll only when the origin actually stepped.
    before.push(win.statsResetPass);
    // ⚠ `pendingScroll` IS NOT CLEARED HERE, and that cost a debugging round.
    // The caller submits through `giCompute`, which DEFERS dispatches while
    // their pipelines are still compiling — and the scroll is the first GI2
    // kernel of a boot, so it is exactly the one that gets deferred. Clearing
    // the flag at list-build time meant the scroll was "done" on a frame it
    // never ran: every brick kept its zeroed table with no VALID marker, the
    // voxelizer's `dirtyCount` found 0 dirty bricks FOREVER (its own
    // `CTR_INVALID` counter read 16384 = every brick of every level), and the
    // static window stayed empty through a boot that otherwise looked healthy.
    // `notePassesRan()` clears it, and only the caller can say whether it ran.
    if (pendingScroll) {
      before.push(win.scrollPass);
      scrollInLastList = true;
    } else {
      scrollInLastList = false;
    }
    if (!cacheCleared && cache.clearPass) {
      before.push(cache.clearPass);
      cacheCleared = true;
    }
    if (voxelizer) {
      if (coarseFrames < COARSE_FIRST_FRAMES) {
        voxelizer.setCoarseFirst(true);
        coarseFrames++;
        if (coarseFrames === COARSE_FIRST_FRAMES) voxelizer.setCoarseFirst(false);
      }
      before.push(...voxelizer.passes(camPos, null));
      before.push(cache.allocPass);
    }
    if (dynamic) before.push(...dynamic.passes());
    // The array the caller will hand to `giCompute`, kept so `notePassesRan`
    // can ask the backend for its timestamp uid. Stored rather than passed back
    // through a new argument: only the caller knows whether the batch actually
    // landed, and `notePassesRan` is already the place it says so.
    lastBeforeList = before;

    // ── after the g-buffer prepass ────────────────────────────────────────
    //
    // `clearStats` FIRST: the gather's counters are atomics that would
    // otherwise read as lifetime totals, and every §L.7 receipt is a
    // per-frame number. Striped and uniform-gated, so it is ~0.01 ms.
    if (!aoCompose && env?.ao?.node) aoCompose = buildAoComposePass();
    // ══ THE CHAIN IS `frameOrder`, NOT A HAND-WRITTEN LIST ═══════════════════
    //
    // Stage 3.4 listed `passes.*` by hand and that list was already wrong the
    // day it was written: 3.3 had SPLIT `probeFilter` into a prep + an SH
    // bilateral (`probeShFilter`) and split `resolve` into `resolveHalf` +
    // `resolveUpsample`, and a hand list cannot pick up a split — it fails
    // SILENTLY (the new kernel simply never runs; here it meant the SH
    // bilateral never ran and the FULL-RES resolve did, 1.02 → 1.93 ms).
    // `gather.frameOrder` is the gather's own order and it is the only thing
    // read here. This consumer's two extra kernels splice into a copy of it at
    // points named by IDENTITY, never by index:
    //
    //   · the emitter SH add goes immediately BEFORE `resolveHalf` — the
    //     first kernel that READS the filtered half of `probeSh`, which is
    //     exactly where the term has to be for the resolve to integrate it;
    //   · GTAO + its compose go immediately AFTER `resolveUpsample`, which is
    //     the kernel that writes the full-res irradiance they scale.
    const after = [gather.passes.clearStats];
    for (const node of gather.frameOrder) {
      if (emitterDirect && node === gather.passes.resolveHalf) after.push(emitterDirect);
      // ⭐⭐ §19 STAGE 5.2 — THE CASCADES SIT BETWEEN THE TWO HALVES OF THE
      // RESOLVE, AND BOTH SIDES ARE FORCED.
      //
      // AFTER `resolveHalf`: their population and their deposit both read the
      // G-BUFFER (rendered between `before` and `after`), and their own resolve
      // OVERWRITES `irradianceHalf` — which only means anything if it runs
      // after the kernel that wrote it. BEFORE `resolveUpsample`: that is the
      // kernel that magnifies the half-res image into the texture materials
      // bind, so a cascade chain dispatched after it would be a frame late and
      // GTAO would compose occlusion onto the world probes' answer, not this
      // one. 5.1 pushed them at the END of the list, which was correct while
      // nothing downstream read them.
      //
      // ⭐⭐⭐ §19 STAGE 5.4b — UNDER RC5 THE CASCADES TAKE `resolveHalf`'s
      // PLACE INSTEAD OF STANDING BEHIND IT.
      //
      // 5.2's splice ran BOTH: the world resolve wrote `irradianceHalf` and
      // `rcMerge` overwrote every texel of it a few kernels later. The user
      // paid for that twice over — the world resolve is the lattice's only
      // consumer, so keeping it also kept three lattices alive (~13 kernels,
      // ~70 MB, the slowest pipeline of the boot). `worldProbes` LEAN now
      // builds none of it; dropping the resolve here is what makes that safe,
      // because a resolve reading a 4-word lattice is a kernel computing zero.
      //
      // ⚠ `glossyHalf` HAS NO OTHER WRITER YET — see the report's gatherProbes
      // patch. Until it lands, RC5 + this cut is an irradiance-only frame.
      if (rc && node === gather.passes.resolveHalf) {
        if (RC5_CUT) { after.push(...rc.frameOrder); continue; }
        after.push(node);
        after.push(...rc.frameOrder);
        continue;
      }
      after.push(node);
      if (node === gather.passes.resolveUpsample) {
        // GTAO's own dispatches. `#armGtaoPass` appends them to whatever list
        // the transport hands it — on the SRC path that was `srcProbes.passes`,
        // here it is an array GISystem publishes as `ao.computes`. Read at
        // PASS-BUILD time, not captured at construction: this system is created
        // before the AO pass exists (it has to be — the AO pass reads the
        // resolve's own size), so the array is empty on the first read and
        // filled a few lines later.
        for (const p of env?.ao?.computes ?? []) after.push(p);
        // AO lands on the resolved irradiance, before anything reads it: the
        // composite's lit frame feeds both `injectLitFrame` and the next
        // frame's screen segment, and an unoccluded lit frame would put the
        // AO-less answer into the cache and read it back as light.
        if (aoCompose) after.push(aoCompose);
      }
    }

    // ⚠ 5.1's tail push is GONE — the chain is spliced by identity above. A
    // build whose gather somehow published no `resolveHalf` would drop the
    // cascades silently, so it is asserted rather than assumed.
    if (rc && !after.includes(rc.frameOrder[0])) {
      console.warn("[gi2] rc: no `resolveHalf` in the gather's frame order — cascades appended at the tail");
      after.push(...rc.frameOrder);
    }

    // `scrollInList` so the caller's chain-shape receipt can EXCLUDE the one
    // pass that is spliced in and out frame by frame under a moving camera —
    // otherwise "the shape changed" is true on every other frame and the log
    // that reports it becomes the stall (§19 Stage 4.1).
    return { before, after, all: [...before, ...after], scrollInList: scrollInLastList };
  };

  // ══════════════════════════════════════════════ RESIZE HANDS THE OLD GATHER OVER
  //
  // ⭐⭐ A RESIZE MAY NOT DESTROY A TEXTURE THE SCENE PASS IS ABOUT TO SAMPLE.
  //
  // `gi2Glossy` and `gi2Irradiance` are read by EVERY material in the scene,
  // through the persistent `_giRadianceNode` / `_giIrradianceNode`. Repointing
  // `.value` is not enough on its own: Stage 1.2 removed the per-object bind
  // group refresh, so a material that was already bound for this frame still
  // names the PREVIOUS texture when the scene pass is encoded. Destroying it
  // inside `setSize` — which runs from `#tick`, i.e. strictly BEFORE the frame
  // is encoded — is therefore a use-after-free, and WebGPU reports it as
  //
  //   Destroyed texture [Texture "gi2Glossy"] used in a submit
  //
  // on the user's editor every time the frame governor moves the resolve
  // (~30 s apart on Bistro). The old path never hit it because
  // `createGiTargets` keeps texture IDENTITY across a resize (§19 0.5b) —
  // `StorageTexture.setSize` drops only the GPU texture, so three re-creates
  // the bind group off the same JS object — and `#retireTargets` defers the
  // real destroy by three frames on top of that.
  //
  // The gather cannot keep identity yet (its factory mints its own textures and
  // takes none), so it takes the OTHER half: NOTHING HERE IS DESTROYED ON THE
  // SPOT. The dead gather — its five textures, the AO output, its own storage
  // buffers and every compute node bound to them — is parked on `retired`, and
  // GISystem takes it into the SAME three-frame queue (`#retireTargets`), which
  // frees it only after the frames that can still name it have been submitted.
  //
  // ⚠ THE LIST IS SCOPED TO WHAT THE RESIZE ACTUALLY REPLACED. `win`, `cache`,
  // the voxelizer and the soup all SURVIVE a resize, so `passesForRelease()`
  // and the `storageAttributes` getter — which publish those too — must NOT be
  // used here: releasing a survivor's buffer is the same crash wearing a
  // different message ("Destroyed buffer used in a submit").
  //
  // ⚠ `__gi2ResizeDisposeNow = true` RESTORES THE BROKEN BEHAVIOUR ON PURPOSE.
  // A fix for a crash is only believable next to a run that still crashes:
  // without this hatch `run-gi-resize-probe`'s "0 uncaptured device errors"
  // could equally mean "the listener never attached", which is the blind-
  // instrument reading this project has been burned by before. It is the arm,
  // not an option — nothing should ever ship with it set.
  const retired = [];
  const retireGather = (dead, deadAo, deadNodes, deadRc = null) => {
    if (!dead && !deadAo && !deadRc) return;
    if (globalThis.__gi2ResizeDisposeNow === true) {
      dead?.dispose();
      deadAo?.dispose();
      deadRc?.dispose();
      return;
    }
    const storageAttributes = dead
      ? Object.values(dead.buffers).map((b) => b?.value).filter((a) => a?.isBufferAttribute === true)
      : [];
    const computeNodes = [];
    if (dead) {
      for (const p of Object.values(dead.passes)) {
        if (Array.isArray(p)) computeNodes.push(...p);
        else computeNodes.push(p);
      }
    }
    for (const n of deadNodes ?? []) computeNodes.push(n);
    // §19 5.1 — the cascades go with the gather they closed over, through the
    // SAME three-frame queue: their storage attributes must be released (a
    // dropped reference is not a freed buffer here) and their compute nodes
    // must outlive every frame that can still name them.
    if (deadRc) {
      storageAttributes.push(...deadRc.storageAttributes());
      computeNodes.push(...deadRc.frameOrder);
    }
    retired.push({
      storageAttributes,
      computeNodes: computeNodes.filter((n) => n?.isComputeNode === true),
      // ⭐⭐ THE TEXTURES MATERIALS ARE STILL BOUND TO. Repointing the persistent
      // nodes does NOT reach a material's bind group on the GI2 path — see
      // GISystem#rebindStaleGiTextures, which walks these to force the rebind
      // three would have done itself if the per-object refresh still existed.
      materialTextures: [dead?.textures.irradiance, dead?.textures.glossy, deadAo].filter(Boolean),
      dispose() {
        dead?.dispose();
        deadAo?.dispose();
        deadRc?.dispose();
      },
    });
  };

  /**
   * ⭐⭐ §19 STAGE 5.5b — THE SWAP, AND IT IS A REBUILD ON PURPOSE.
   *
   * The exact arm binds two storage buffers the voxel arm does not, so the two
   * are different WGSL and no uniform can choose between them at run time. That
   * leaves exactly one honest way to serve first light on the voxel arm and
   * still end up on the exact one: build the gather without the BVH, and
   * REBUILD it — once, when the worker's tree lands — through the very path
   * `setSize` already uses for the same reason.
   *
   * The cost is one pipeline compile of the direct pass, off the first-light
   * path, once per scene open. The alternative (awaiting the BVH before the
   * first frame) puts a multi-second worker build in front of first light,
   * which is the exact cost §19 exists to have deleted; and the other
   * alternative (a capacity-sized buffer filled in place) would allocate
   * 72 MB on every scene whether or not it needed one.
   *
   * ⚠ RETIRE THE OLD GATHER, do not just drop it — `emitterDirect` and
   * `aoCompose` bind textures and buffers that belong to the dead one, the same
   * three-object dance `setSize` performs. Getting this wrong leaks a whole
   * cascade set per swap.
   */
  const swapShadowBvh = (gpu) => {
    if (!gpu || disposed) return false;
    shadowBvh = gpu;
    const old = gather;
    const oldAo = aoOut;
    const oldEmitterDirect = emitterDirect;
    const oldAoCompose = aoCompose;
    const oldRc = rc;
    aoOut = null;
    aoCompose = null;
    buildGather();
    stampVoxNames();
    retireGather(old, oldAo, [oldEmitterDirect, oldAoCompose], oldRc);
    console.log(
      `[gi2] exact shadow rays LIVE — ${gpu.triCount} tris / ${gpu.nodeCount} nodes, ` +
      `${gpu.mb.toFixed(1)} MB on the GPU; the direct term is off the voxels`,
    );
    return true;
  };

  const setSize = (w, h) => {
    const nw = Math.max(16, Math.round(w));
    const nh = Math.max(16, Math.round(h));
    if (nw === width && nh === height) return false;
    width = nw;
    height = nh;
    const old = gather;
    const oldAo = aoOut;
    // ⚠ CAPTURED BEFORE `buildGather()`, WHICH REASSIGNS BOTH. `emitterDirect`
    // binds `gather.buffers.probeMeta` and `aoCompose` binds
    // `gather.textures.irradiance` + `aoOut`; both belong to the DEAD gather and
    // are re-minted against the new one, so both are retired with it.
    const oldEmitterDirect = emitterDirect;
    const oldAoCompose = aoCompose;
    const oldRc = rc;
    aoOut = null;
    aoCompose = null;
    buildGather();
    stampVoxNames();
    retireGather(old, oldAo, [oldEmitterDirect, oldAoCompose], oldRc);
    return true;
  };

  // ══════════════════════════════════════════════════════════════════ RECEIPTS
  //
  // ONE readback per call, and every counter in it is already on the GPU for
  // its own reasons (§K.8 + §L.7). `probesValid`/`windowHits` are what
  // `_transportAlive` is latched from — the GI2 equivalent of "rays fired AND
  // something deposited", and the same fail-open contract: until it latches,
  // the scene keeps its environment IBL.
  const stats = async (r = renderer) => {
    const out = {
      tier,
      built: !!voxelizer,
      frame,
      windowMB: win.describe().totalMB,
      cacheMB: cache.describe().totalMB,
      probes: gather?.probeCount ?? 0,
      rays: (gather?.probeCount ?? 0) * (gather?.R ?? 0),
      ...counters,
      msToSoup: marks.soup ? Math.round(marks.soup - t0) : 0,
      msToVoxelizer: marks.voxelizer ? Math.round(marks.voxelizer - t0) : 0,
      msToFirstLight: marks.firstLight ? Math.round(marks.firstLight - t0) : 0,
      // ⭐⭐ §19 STAGE 4.3b — THE NUMBER THE USER ACTUALLY COUNTS (audits §R).
      //
      // `msToFirstLight` is measured from the GI2 BUILD, i.e. from the moment
      // GI stopped waiting — it was 2.8 s on a Bistro boot the user measured at
      // 31 s, because 26.9 s of that boot was spent in front of the build, in
      // `#readyToRebuild`. This one is measured from `engine.sceneOpenAt`
      // (stamped by `Engine#clear`, which `deserializeScene` calls first), so
      // the two numbers together say WHERE the time went instead of hiding it.
      firstLightFromSceneOpenMs: firstLightFromSceneOpen(),
      soupBuilds: store.soupBuilds ?? 0,
      occupancyMs: Object.fromEntries(marks.occupancy),
    };
    if (!r) return out;
    try {
      if (gather) {
        const u32 = new Uint32Array(await r.getArrayBufferAsync(gather.buffers.statsBuf.value));
        lastGather = gather.readStats(u32);
        Object.assign(out, lastGather);
        // §K.8's time-to-first-light: the first frame on which any ray came
        // back from the window with radiance. Stamped from the receipt rather
        // than from a pixel readback — a mean over the frame can be argued
        // about, a hit count cannot.
        if (!marks.firstLight && (lastGather.windowHits > 0 || lastGather.screenHits > 0)) {
          marks.firstLight = performance.now();
          out.msToFirstLight = Math.round(marks.firstLight - t0);
          out.firstLightFromSceneOpenMs = firstLightFromSceneOpen();
          console.log(
            `[gi2] first light — ${lastGather.probesValid} valid probes, ` +
            `${lastGather.windowHits} window hits / ${lastGather.screenHits} screen hits / ` +
            `${lastGather.skyMiss} sky, ${out.msToFirstLight} ms after the GI2 build started` +
            // §R: the headline. Quoted second, so the build-relative number the
            // whole stage has been read against stays legible next to it.
            (out.firstLightFromSceneOpenMs != null
              ? ` — ${out.firstLightFromSceneOpenMs} ms FROM SCENE OPEN` : ""),
          );
        }
        // ⭐⭐ §19 3.17 — THE PER-CASCADE LIVE COUNT, IN THE RECEIPT EVERY PROBE
        // ALREADY READS. §V.3 named "c2 live 0/32768 on Bistro" from a rig page
        // that happens to print it; three stages of ENGINE-path receipts could
        // not see the same fact, because nothing on this path read `wpList`. It
        // is `LIST_WORDS · NC · 4` bytes at the stats cadence, and it is the
        // only witness to "this cascade exists at all".
        // ⭐ §19 3.17 — THE WINDOW CENSUS, opt-in (`__gi2WindowCensus = true`).
        // "L4 never printed first occupancy" is a claim about a COUNTER; this
        // reads the buffer the trace and `allocPass` actually sample, per level:
        // occupied voxels, brickMask bits, and the brick-table state histogram.
        // 3.9 MB of readback, so it is behind a flag and off on every gate.
        if (globalThis.__gi2WindowCensus === true) {
          try {
            const wb = new Uint32Array(await r.getArrayBufferAsync(win.attribute));
            const pc = (x) => { let n = 0; while (x) { x &= x - 1; n++; } return n; };
            out.windowCensus = Array.from({ length: win.levels }, (_, l) => {
              const base = l * WIN_LEVEL_WORDS;
              let occ = 0;
              for (let w = 0; w < 8192; w++) occ += pc(wb[base + WIN_OCC_OFF + w]);
              let mask = 0;
              for (let w = 0; w < 128; w++) mask += pc(wb[base + WIN_BMASK_OFF + w]);
              const state = {};
              let invalid = 0;
              for (let b = 0; b < 4096; b++) {
                const t = base + WIN_BTAB_OFF + b * 2;
                if ((wb[t] & WIN_WB_VALID) === 0) invalid++;
                const s = wb[t + 1];
                state[s] = (state[s] ?? 0) + 1;
              }
              return { level: l, occVoxels: occ, brickMaskBits: mask, invalidWb: invalid, state };
            });
          } catch (err) { out.windowCensusError = err?.message ?? String(err); }
        }
        if (gather.world) {
          try {
            const lw = new Uint32Array(await r.getArrayBufferAsync(gather.world.buffers.wpList.value));
            out.worldLive = gather.world.readLive(lw);
            out.worldCells = gather.world.cellCount;
          } catch { /* a lattice disposed mid-rebuild */ }
        }
      }
      if (voxelizer) {
        lastVox = await voxelizer.stats(r);
        out.voxelizer = lastVox;
        // Per-level time-to-first-occupancy (§K.8).
        //
        // ⭐ READ THE CUMULATIVE WORD (§19 Stage 3.5). `built`/`pairs` are PER
        // FRAME and a small scene's window fills in one or two of them, so a
        // sampler that reads every frame could still land after the fill and
        // see the (correct) all-zero settled state — "no occupancy" was then
        // indistinguishable from "no voxelizer", and the guard below had to
        // stamp an UPPER BOUND to say anything at all. `cumBuilt` is never
        // reset, so the first sample that sees it non-zero bounds the event by
        // ONE sampling interval rather than by however long the harness took
        // to look, and the bound path is now a fallback for a voxelizer too
        // old to publish it rather than the normal answer.
        for (const lvl of lastVox.perLevel ?? []) {
          const occupied = (lvl.cumBuilt ?? 0) > 0 || lvl.built > 0 || lvl.pairs > 0;
          if (occupied && !marks.occupancy.has(lvl.level)) {
            marks.occupancy.set(lvl.level, Math.round(performance.now() - t0));
            console.log(`[gi2] first occupancy L${lvl.level} at ${marks.occupancy.get(lvl.level)} ms` +
              ((lvl.cumBuilt ?? 0) > 0 ? ` (${lvl.cumBuilt} bricks built so far)` : ""));
          }
        }
        // ⚠ BLIND-INSTRUMENT GUARD, kept as a FALLBACK. A ray that came back
        // from the STATIC window is proof of occupancy that no sampling rate
        // can miss, so if the cumulative counters somehow said nothing this
        // still stamps an upper bound rather than leaving the receipt empty.
        if (!marks.occupancy.size && (lastGather?.windowHits ?? 0) > 0 && marks.voxelizer) {
          const at = Math.round(performance.now() - t0);
          for (let l = 0; l < win.levels; l++) marks.occupancy.set(l, at);
          out.occupancyBound = true;
          console.log(`[gi2] first occupancy: ≤ ${at} ms (UPPER BOUND — no level reported a cumulative ` +
            `built brick, yet ${lastGather.windowHits} rays came back from the window)`);
        }
        out.cumBuilt = Object.fromEntries(
          (lastVox.perLevel ?? []).map((l) => [l.level, l.cumBuilt ?? 0]),
        );
        out.occupancyMs = Object.fromEntries(marks.occupancy);
      }
      if (dynamic) {
        lastDyn = await dynamic.stats(r);
        out.dynamic = lastDyn;
      }
    } catch (err) {
      out.statsError = err?.message ?? String(err);
    }
    return out;
  };

  /** The cheap synchronous view — no readback, for `profile.frameStats`. */
  const snapshot = () => ({
    tier,
    built: !!voxelizer,
    frame,
    windowMB: win.describe().totalMB,
    cacheMB: cache.describe().totalMB,
    probes: gather?.probeCount ?? 0,
    raysPerFrame: (gather?.probeCount ?? 0) * (gather?.R ?? 0),
    width, height,
    ...counters,
    msToSoup: marks.soup ? Math.round(marks.soup - t0) : 0,
    msToVoxelizer: marks.voxelizer ? Math.round(marks.voxelizer - t0) : 0,
    msToFirstLight: marks.firstLight ? Math.round(marks.firstLight - t0) : 0,
    // §19 Stage 4.3b (§R.4): the readback-free half of the boot receipt, so
    // `profile.frameStats.gi2` can answer "how long from scene open" without
    // suspending the frame.
    firstLightFromSceneOpenMs: firstLightFromSceneOpen(),
    soupBuilds: store.soupBuilds ?? 0,
    occupancyMs: Object.fromEntries(marks.occupancy),
    gather: lastGather,
    voxelizer: lastVox,
    dynamic: lastDyn,
  });

  const describe = () => ({
    tier,
    window: win.describe(),
    cache: cache.describe(),
    gather: gather?.describe() ?? null,
    rc5: RC5,
    rc: rc?.describe() ?? null,
    voxelizer: voxelizer?.describe() ?? null,
    dynamic: dynamic?.describe() ?? null,
  });

  return {
    tier, win, trace, cache,
    /**
     * `{ classOf, keys, emitterClasses, classCount }` for the build that is
     * live, or null before the first one. See `build` — a re-tint reuses this
     * and never re-clusters.
     */
    get paletteAssign() { return paletteAssign; },
    get gather() { return gather; },
    /**
     * §19 5.3 — the live cascade system, for the receipts. `describe()` already
     * rides `describe`, but the deposit's and [J]'s TALLIES need the renderer
     * (they are GPU readbacks), and a gate that cannot read `secondaryOverflow`
     * cannot tell a dim second bounce from a hit list that dropped a third of
     * its entries — the two look identical in every image statistic.
     */
    get rc() { return rc; },
    get voxelizer() { return voxelizer; },
    get dynamic() { return dynamic; },
    get width() { return width; },
    get height() { return height; },
    get textures() {
      // `aoOut` when AO is on (see `buildAoComposePass`), the gather's own
      // resolve output otherwise. Whichever it is, THIS is the texture the
      // persistent `giIrradianceNode` points at and every material samples.
      return {
        irradiance: aoOut ?? gather.textures.irradiance,
        glossy: gather.textures.glossy,
        lit: gather.textures.lit,
        raw: gather.textures.irradiance,
      };
    },
    /** Everything `collectStateStorageAttributes` has to see (§0.2b). */
    get storageAttributes() {
      const list = [win.attribute, cache.attribute];
      if (voxelizer) list.push(voxelizer.workAttribute, voxelizer.ctrAttribute);
      if (dynamic) {
        list.push(dynamic.scratchAttribute, dynamic.trisBuffer.value,
          dynamic.metaBuffer.value, dynamic.xformBuffer.value);
      }
      if (soup) list.push(soup.tris.value, soup.triPal.value, soup.cellRange.value, soup.cellTris.value);
      // `b?.value`: a harness-only buffer (the crop pair) is null on the
      // engine path — see `crops: 0` above.
      if (gather) for (const b of Object.values(gather.buffers)) list.push(b?.value);
      if (rc) list.push(...rc.storageAttributes());
      return list.filter((a) => a?.isBufferAttribute === true);
    },
    /** Everything `collectStateComputeNodes` has to see. */
    get computeNodes() {
      return passesForRelease();
    },
    /**
     * The bundles a resize orphaned, handed over ONCE (the list is emptied).
     *
     * Same contract the occupancy field's `takeRetiredStorageAttributes` has,
     * and for the same reason: this module has no way to know when a frame is
     * safely past a submit, and GISystem's `#retireTargets` queue does. Each
     * bundle is exactly that queue's shape — `{storageAttributes, computeNodes,
     * dispose()}`. Returns `null` when there is nothing to hand over, so the
     * caller's per-tick sweep costs one property read.
     */
    takeRetired() {
      if (retired.length === 0) return null;
      const out = retired.slice();
      retired.length = 0;
      return out;
    },
    build, setSize, setCamera, setMovers, passes, stats, snapshot, describe,
    /**
     * How often the caller should pay for a `stats()` readback, in frames.
     *
     * ⚠ THE COUNTERS ARE PER-FRAME, AND THE WINDOW FILLS IN A HANDFUL OF THEM.
     * A fixed 30-frame cadence measured a SETTLED window — every counter zero,
     * which is the correct steady state — and therefore never saw a single
     * `built` brick, so `first occupancy` read "none" on a boot whose rays were
     * hitting geometry 30 % of the time. The gate's own instrument was blind to
     * its subject. Sample tightly while the fill is in flight, then back off.
     */
    statsCadence() {
      if (!voxelizer) return 12;
      // ⚠⚠ AND FIRST LIGHT IS ONE OF THE THINGS THE TIGHT CADENCE IS FOR
      // (§19 Stage 3.5). This used to back off the moment every level had
      // reported occupancy — which was safe only because the per-frame
      // counters made that a slow, staggered event. The cumulative counter
      // stamps every level on the FIRST sample that sees any brick, so the
      // back-off arrived while the gather's pipelines were still compiling,
      // and `first light` — which is stamped at READBACK time, not at the
      // event — was then measured up to 30 frames late. On Bistro that read
      // 9.8 s for a boot whose rays came back at ~5.
      //
      // ⭐ A CADENCE THAT BACKS OFF BEFORE THE LAST THING IT MEASURES HAS
      // HAPPENED IS AN INSTRUMENT MEASURING ITS OWN SAMPLING RATE.
      const filled = marks.occupancy.size >= win.levels && marks.firstLight > 0;
      const settled = filled || (marks.voxelizer && performance.now() - marks.voxelizer > 20_000);
      return settled ? 30 : 1;
    },
    /**
     * "The list `passes()` last returned was actually submitted." Only the
     * caller knows — `giCompute` can defer a whole batch on a boot frame — and
     * the scroll is the one pass whose effect is a ONE-SHOT re-key that nothing
     * downstream re-requests. Same shape as the SRC path's `_srcRanOnce`.
     */
    notePassesRan() {
      if (scrollInLastList) pendingScroll = false;
      // §19 Stage 4.1 — and it belongs HERE for the same reason `pendingScroll`
      // does: a deferred batch produced no GPU pass, so asking the backend for
      // its timestamp would attribute the PREVIOUS frame's uid to this frame's
      // dirty limit and teach the controller a lie.
      if (!lastBeforeList || !renderer?.backend) return;
      try {
        const uid = renderer.backend.get(lastBeforeList)?.timestampUID;
        if (uid && voxelizer) voxPending.push({ uid, age: 0 });
        // Bounded: a device that never resolves must not grow this forever.
        if (voxPending.length > 32) voxPending.splice(0, voxPending.length - 32);
      } catch { /* a context three did not track — the seed's fallback covers it */ }
    },
    get transportAlive() {
      return (lastGather?.probesValid ?? 0) > 0 && (lastGather?.windowHits ?? 0) > 0;
    },
    dispose() {
      disposed = true;
      // A bundle the caller never took (a rebuild landing within a tick of a
      // resize). `dispose()` itself only ever runs FROM the retire queue —
      // GISystem hands this whole system to `#retireTargets` — so by here the
      // deferral has already been paid and destroying is safe.
      for (const bundle of retired) bundle.dispose();
      retired.length = 0;
      aoOut?.dispose();
      aoOut = null;
      rc?.dispose();
      rc = null;
      gather?.dispose();
      voxelizer?.dispose();
      dynamic?.dispose();
      cache.dispose();
      win.dispose();
      if (soup) {
        for (const key of ["tris", "triPal", "cellRange", "cellTris"]) {
          const attr = soup[key]?.value;
          if (!attr) continue;
          attr.array = attr.array?.constructor ? new attr.array.constructor(0) : new Uint32Array(0);
          attr.dispose?.();
        }
      }
      soup = null;
      gather = null;
      voxelizer = null;
      dynamic = null;
    },
  };

  function passesForRelease() {
    const list = [win.scrollPass, win.statsResetPass, win.clearStaticPass, win.clearDynamicPass,
      cache.allocPass, cache.clearPass];
    if (voxelizer) list.push(...voxelizer.passes(null, null), voxelizer.markAllDirty());
    if (dynamic) list.push(...dynamic.passes());
    if (gather) {
      for (const p of Object.values(gather.passes)) {
        if (Array.isArray(p)) list.push(...p);
        else list.push(p);
      }
    }
    if (emitterDirect) list.push(emitterDirect);
    if (aoCompose) list.push(aoCompose);
    if (rc) list.push(...rc.frameOrder);
    return list.filter((n) => n?.isComputeNode === true);
  }
}
