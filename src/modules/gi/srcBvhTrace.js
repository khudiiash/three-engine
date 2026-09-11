// ── THE TRANSPORT ON THE BVH (§10, 2026-09-02) ──────────────────────────────
//
// The SRC transport's three geometric questions — where does this ray hit,
// can this hit see that light, what surface is it — answered by the static
// BVH8 + the dynamic-object set instead of the dense occupancy pyramid and
// its per-cell surface records. Same contracts as srcTrace.js /
// srcSurface.js so srcSystem swaps them by mode:
//
//   createSrcBvhSceneTrace(dyn, world)      → (origin, dir, tMax) ⇒ { hit, t,
//       position, exactPosition, normal, dynObj, slot, uvPacked, voxel: null }
//   createSrcBvhVisibility(dyn, world)      → (point, normal, toLight, maxT) ⇒ 0|1
//   createSrcBvhSurfaceAttribution(...)     → { surfaceAtHit(hit, dir) ⇒
//       { position, normal, albedo, emissive, emitter, valid }, passes, sync,
//       stats, dispose }
//
// WHY. The pyramid was the largest allocation (274 MB on Bistro + 628 MB of
// CPU mirrors until detached), the only structure re-minted by camera motion
// (every slide of its 40 m box re-voxelized 17.7 M work items and held the
// screen), and the reason the field had a box at all — outside it the far
// field is a constant, which the user photographs as black patches. Every
// job it did has a BVH twin that already ships: the exact reflections trace
// this BVH8 (`traceStaticBvhSlot`, packed t / oct-normal / uv / slot), the
// sun at reflection hits moved to a BVH any-hit ray this month for quality
// reasons, movers carry OBB + per-mover BVH (`dyn.trace`), and the slot
// palette (albedo / emissive / emitter per placement) is keyed by the same
// slot number the BVH stores per triangle. The hashed, anchor-relative probe
// lattice never needed the box — it follows the camera by construction.
//
// What the pyramid gave the transport that this does not (yet): nothing for
// the hit itself; the per-cell record fallback for a hit on an unattributed
// cell becomes the palette's mean albedo, exactly as the reflections do.
import { If, float, int, ivec2, select, uint, uintBitsToFloat, vec2, vec3 } from "three/tsl";
import { octDecodeTSL } from "./rayHit/rayHitTSL.js";
// ── EPSILONS, NOT CELLS ─────────────────────────────────────────────────────
// srcTrace.js lifts shadow-ray origins 0.75 cells and hit positions 0.5 cells
// off the surface because the pyramid's voxels are conservative: a ray that
// starts inside the voxel it hit would re-hit it. That was 16 cm on the
// Level. A BVH triangle has no thickness, so a 16 cm lift starts the shadow
// ray on the OTHER side of every wall thinner than that — the first field-
// less walk read the waypoints 40–50 % brighter than the pyramid (leg 1:
// 0.079 → 0.121), which is light through thin walls, not exposed light. The
// exact shadow arms already use ~0.02 cells (2 mm); the transport uses the
// same class of margin here.
const BVH_LIFT_M = 0.004;
const BVH_SELF_BIAS_M = 0.002;

/** `traceStaticBvhSlot` packs two 12-bit lanes per float: hi·4096 + lo, each 0..4095. */
function unpack12(q) {
  const hi = q.div(4096).floor().toVar();
  return vec2(hi, q.sub(hi.mul(4096))).div(4095);
}

/**
 * Closest hit through the static BVH8, then the movers; the nearer wins.
 * `dyn` is the dynamic-object set (dynamicObjects.js) that owns the static
 * BVH (`traceStaticBvhSlot`) and the mover trace (`trace`).
 */
export function createSrcBvhSceneTrace(dyn, world, { movers = true } = {}) {
  if (!dyn?.traceStaticBvhSlot) {
    throw new Error("createSrcBvhSceneTrace: the dynamic-object set has no static BVH — build it first");
  }
  const moverTrace = movers && dyn.enabled && typeof dyn.trace === "function";
  // `tMinWorld` (§11.13, optional): a ray SEGMENT [tMin, tMax] along the same
  // origin — the deposit traces cascade 0–1 first and, only when that
  // cleared, the far intervals from their near bound. Null keeps the
  // self-intersection epsilon every other caller relies on.
  const traceFn = (origin, dir, tMaxWorld, _n = null, tMinWorld = null) => {
    const o = vec3(origin).toVar();
    const d = vec3(dir).toVar();
    // A self-intersection epsilon, not a quarter cell (see the header).
    const tMin = (tMinWorld != null
      ? float(tMinWorld).max(float(BVH_SELF_BIAS_M))
      : float(BVH_SELF_BIAS_M)).toVar();
    const tMax = float(tMaxWorld).toVar();
    const hit = float(0).toVar();
    const t = float(-1).toVar();
    const normal = vec3(0, 1, 0).toVar();
    const slot = float(-1).toVar();
    const uvPacked = float(0).toVar();
    const dynObj = float(-1).toVar();
    // §11.15: 1 when the winning mover hit was reached from INSIDE the mover.
    const insideMover = float(0).toVar();
    const s = dyn.traceStaticBvhSlot(o, d, tMin, tMax);
    // `traceStaticBvhSlot` returns JS `null` when the static BVH is not built
    // yet — a rebuild-ordering race (a light move / preset change / re-enable
    // rebuilds this kernel before the BVH lands). Reading `s.x` then crashed
    // the whole `src:deposit` kernel BUILD ("Cannot read properties of null" /
    // "trace is not a function") and GI stayed DARK. When it is null, skip the
    // hit branch and leave `hit = 0` (a clean miss); the
    // `static-bvh-manifest-stale` rebuild rebuilds this with the BVH ready and
    // GI lights immediately. In steady state `s` is always a node.
    if (s != null) {
      If(s.x.greaterThanEqual(0), () => {
        hit.assign(1);
        t.assign(s.x);
        normal.assign(octDecodeTSL(unpack12(s.y).mul(2).sub(1)));
        slot.assign(s.w);
        uvPacked.assign(s.z);
      });
    }
    if (moverTrace) {
      // §11.15 THE SELF-WALL. A skinned proxy is a fat hull: the receiver's
      // true skin sits centimetres INSIDE it, and the box/sphere intersectors
      // report a ray born inside as a hit AT tMin whose normal faces the ray
      // — indistinguishable from a legitimate front face. Every transport
      // ray leaving a character pixel therefore "hit" the character itself
      // at t ≈ 0: [J] shaded that hit with the mover's albedo (the Y Bot:
      // white, R4-clamped to 0.9) times the gather at the ORIGIN — the
      // character's own irradiance — and deposited it straight back into the
      // same probe. A loop of gain 0.9 converges at 10× (measured: mover
      // hits gathered E = 8.46 luma against 0.14 at static hits; the
      // character rendered clipped white and lit the whole corridor 2× the
      // path tracer, plan §11.14). `excludePoint` is §14 Q2's signed
      // on-or-inside self-exclusion, the same one every shadow marcher passes:
      // a proxy containing the ray's origin cannot occlude it. Other proxies
      // (the next limb, the floor under a foot) still do.
      const m = dyn.trace(o, d, tMin, tMax, { objId: true, excludePoint: o });
      If(m.hit.greaterThan(0.5).and(hit.lessThan(0.5).or(m.t.lessThan(t))), () => {
        hit.assign(1);
        t.assign(m.t);
        normal.assign(m.normal);
        dynObj.assign(m.obj);
        slot.assign(-1);
        insideMover.assign(select(m.inside, float(1), float(0)));
      });
    }
    // The attribution face-forwards the normal against the ray; here it is the
    // geometric normal as traced, like the DDA path returned it.
    const exactPosition = o.add(d.mul(t.max(0))).toVar();
    const position = exactPosition.add(normal.mul(float(BVH_LIFT_M))).toVar();
    const hitT = select(hit.greaterThan(0.5), t.max(1e-4), float(-1)).toVar();
    return {
      hit,
      t: hitT,
      position,
      exactPosition,
      normal,
      dynObj: moverTrace ? dynObj : null,
      insideMover: moverTrace ? insideMover : null,
      slot,
      uvPacked,
      // No voxel key: hits are attributed by SLOT (surfaceAtHit), never by cell.
      voxel: null,
    };
  };
  // §11.13: the result's NON-NULL fields, declared up front — the deposit's
  // two-segment loop must size its result vars before the loop body is built
  // (a TSL loop body runs at shader build, not at graph construction).
  traceFn.fields = ["hit", "t", "position", "exactPosition", "normal", "slot", "uvPacked", ...(moverTrace ? ["dynObj", "insideMover"] : [])];
  return traceFn;
}

/**
 * Boolean visibility from a hit point toward a light: any-hit through the
 * static BVH8, then (optionally) the movers. Same lift/self-bias convention as
 * createSrcVisibility so the two arms shadow the same way.
 */
export function createSrcBvhVisibility(dyn, world, { movers = false } = {}) {
  if (!dyn?.traceStaticBvh) {
    throw new Error("createSrcBvhVisibility: the dynamic-object set has no static BVH — build it first");
  }
  const moverTrace = movers && dyn.enabled && typeof dyn.trace === "function";
  const diagonal = () => vec3(world.size).length();
  return (point, normal, toLight, maxT = null) => {
    const lift = float(BVH_LIFT_M).toVar();
    const selfBias = float(BVH_SELF_BIAS_M).toVar();
    const p = vec3(point).toVar();
    const l = vec3(toLight).toVar();
    const origin = p.add(vec3(normal).mul(lift)).toVar();
    const budget = (maxT == null
      ? diagonal()
      : p.add(l.mul(float(maxT))).sub(origin).length()
    ).toVar();
    const v = float(1).toVar();
    const st = dyn.traceStaticBvh(origin, l, selfBias, budget, { anyHit: true });
    // `traceStaticBvh` returns JS `null` when the static BVH is not built yet
    // (rebuild-ordering race — a light move / preset change / post toggle
    // rebuilds this shade kernel before the BVH lands). Reading `st.x` then
    // crashed the kernel BUILD and GI went dark. Null → leave `v = 1` (no
    // occlusion this transient frame); the `static-bvh-manifest-stale` rebuild
    // re-emits this arm with the BVH ready. In steady state `st` is a node.
    if (st != null) {
      If(st.x.greaterThanEqual(0), () => { v.assign(0); });
    }
    if (moverTrace) {
      If(v.greaterThan(0.5), () => {
        // §11.15: the shadow ray from a hit excludes the proxy it starts in,
        // like every other shadow marcher (see the transport's note above).
        const m = dyn.trace(origin, l, selfBias, budget, { excludePoint: origin, excludeNormal: vec3(normal) });
        If(m.hit.greaterThan(0.5), () => { v.assign(0); });
      });
    }
    return v;
  };
}

/**
 * Surface attribution for BVH hits: the hit's SLOT indexes the placement
 * palette (albedo · emitter+1 · emissive · live — the eight words
 * srcSurface.js's palette pass publishes), the optional albedo atlas replaces
 * the mean albedo with the textured texel at the hit's UV (the reflections'
 * §18.17 path), and a mover hit reads the dynamic set's per-object surface.
 *
 * `palette` is `{ bits, wordOffset, words, slots }` (the occupancy field's
 * `surfaceAttribution` region today; its own buffer once the field is gone),
 * `atlas` the slot atlas bundle `{ node, tiles, slots, grid, tilePx }` or null.
 */
export function createSrcBvhSurfaceAttribution({ palette, atlas = null, dyn = null, count = null, fallbackAlbedo = null }) {
  if (!palette?.bits) {
    throw new Error("createSrcBvhSurfaceAttribution: a slot palette is required — without it every static hit is grey");
  }
  const stats = { atlasSampled: 0 };
  const paletteAt = (slotF) => {
    const s = uint(float(slotF).max(0)).min(uint(Math.max(0, (palette.slots ?? 768) - 1))).toVar();
    const base = uint(palette.wordOffset).add(s.mul(uint(palette.words))).toVar();
    return {
      slot: s,
      albedo: vec3(
        uintBitsToFloat(palette.bits.element(base)),
        uintBitsToFloat(palette.bits.element(base.add(uint(1)))),
        uintBitsToFloat(palette.bits.element(base.add(uint(2)))),
      ).toVar(),
      emitter: float(palette.bits.element(base.add(uint(3)))).sub(1).toVar(),
      emissive: vec3(
        uintBitsToFloat(palette.bits.element(base.add(uint(4)))),
        uintBitsToFloat(palette.bits.element(base.add(uint(5)))),
        uintBitsToFloat(palette.bits.element(base.add(uint(6)))),
      ).toVar(),
      live: float(palette.bits.element(base.add(uint(7)))).toVar(),
    };
  };
  const surfaceAtHit = (hit, dir) => {
    const albedo = vec3(fallbackAlbedo ?? vec3(0.5)).toVar();
    const emissive = vec3(0).toVar();
    const emitter = float(-1).toVar();
    const valid = float(0).toVar();
    const isStatic = hit.slot != null ? float(hit.slot).greaterThanEqual(0) : float(1).greaterThan(0);
    If(isStatic, () => {
      const p = paletteAt(hit.slot ?? 0);
      const attributed = p.live.greaterThan(0.5).toVar();
      albedo.assign(select(attributed, p.albedo, albedo));
      emissive.assign(select(attributed, p.emissive, vec3(0)));
      emitter.assign(select(attributed, p.emitter, float(-1)));
      valid.assign(select(attributed, float(1), float(0)));
      if (atlas && hit.uvPacked != null) {
        // The reflections' textured path (§18.17): the tile table maps slot →
        // atlas tile (xy in 1/255, w = mapped), the hit's packed UV picks the
        // texel with a half-texel inset so LINEAR filtering never bleeds a
        // neighbouring tile in.
        const grid = Math.max(1, atlas.grid ?? 12);
        const tl = atlas.tiles.load(ivec2(p.slot.toInt(), int(0))).toVar();
        const tileXY = vec2(tl.x, tl.y).mul(255).add(0.5).floor().toVar();
        const inset = 0.5 / Math.max(1, atlas.tilePx ?? 128);
        const auv = tileXY.add(unpack12(float(hit.uvPacked)).clamp(inset, 1 - inset)).div(grid).toVar();
        const texel = atlas.node.sample(auv).level(0).rgb.toVar();
        albedo.assign(select(tl.w.greaterThan(0.5).and(attributed), texel, albedo));
      }
    });
    if (dyn?.surfaceAt && hit.dynObj != null) {
      If(float(hit.dynObj).greaterThanEqual(0), () => {
        const who = dyn.splitObj(hit.dynObj);
        const m = dyn.surfaceAt(who.index);
        albedo.assign(m.albedo);
        emissive.assign(m.emissive);
        emitter.assign(float(-1));
        valid.assign(float(1));
      });
    }
    if (count?.missed) count.missed(float(1).sub(valid));
    return {
      position: hit.exactPosition,
      normal: hit.normal,
      albedo: albedo.clamp(0, 1).toVar(),
      emissive,
      emitter,
      valid,
    };
  };
  return {
    surfaceAtHit,
    passes: [],
    sync() {},
    stats,
    dispose() {},
  };
}
