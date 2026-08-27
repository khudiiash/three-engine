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
// ⚠ ONE DEVIATION FROM "PASS THE UNIFORM NODES IN", AND IT IS THE 3.2 API GAP.
// `createGiGather` mints its OWN `sunDir` / `sunColor` / `skyColor` uniforms
// and closes over them inside `probeTrace`. There is no way to hand it the
// system's nodes without editing `gatherProbes.js`, which this unit may not do.
// So the values are MIRRORED once per frame (three vector copies, in
// `syncLighting`) rather than duplicated as a second authored source: the
// system's uniform stays the only thing anyone writes, and the mirror is a
// read. Listed as an API ask — `createGiGather({ sun, sky })` accepting nodes
// removes it entirely.
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
//   · at a ray HIT — still open. A wall lit by a lamp the probe cannot see
//     reflects the lamp's light only once `injectLitFrame` or a fresh-slot
//     shade has written that voxel, so the SECOND bounce off an emitter-lit
//     surface arrives a few frames late instead of immediately. Closing it
//     means an emitter-slot NEE inside `shadeHit`, i.e. a `gatherProbes` edit.
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
import { createGiWindow } from "./windowStore.js";
import { createWindowTrace } from "./windowTrace.js";
import { createRadianceCache } from "./radianceCache.js";
import { createWindowVoxelizer } from "./windowVoxelize.js";
import { createWindowDynamic, moverBoxSoup } from "./windowDynamic.js";
import { createTriangleSoupBuilder, SoupSupersededError, PAL_NONE } from "./triangleSoup.js";
import { createGiGather, GATHER_TIERS, PAL_ENTRIES, STATS } from "./gatherProbes.js";

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
 * Quantize per-placement surfaces into the gather's 16-entry palette.
 *
 * §K.2 stores ONE BYTE per voxel, and §L.2 reads it as a material CLASS — a
 * scene-independent table, not a per-mesh array, which is what keeps every
 * kernel's WGSL free of scene numbers. The clustering is a fixed 3×3×3 albedo
 * lattice plus an emissive bucket, ranked by how much SURFACE each class
 * covers (placement count is the only area proxy available before the soup is
 * built) — never by mesh id, so adding a prop cannot renumber the palette and
 * strand every voxel already written with the old index.
 *
 * @param {Array<{albedo:number[], emissive:number}>} surfaces per placement
 * @returns {{palette: Array<{albedo:number[], emissive:number}>, index: number[]}}
 */
export function buildGi2Palette(surfaces) {
  const q = (v) => Math.min(2, Math.max(0, Math.round(Math.min(1, Math.max(0, v)) * 2)));
  const buckets = new Map();
  const keys = [];
  for (const s of surfaces) {
    const a = s?.albedo ?? [0.5, 0.5, 0.5];
    const e = s?.emissive ?? 0;
    // Emissive surfaces get their own classes: a lamp's albedo is irrelevant
    // next to what it emits, and merging it into a neutral class would put the
    // emission on every wall that shares the bucket.
    const key = e > 1e-4
      ? `e${q(Math.min(1, e / 8))}:${q(a[0])}${q(a[1])}${q(a[2])}`
      : `d${q(a[0])}${q(a[1])}${q(a[2])}`;
    keys.push(key);
    const b = buckets.get(key);
    if (b) {
      b.n++;
      b.r += a[0]; b.g += a[1]; b.b += a[2]; b.e += e;
    } else {
      buckets.set(key, { key, n: 1, r: a[0], g: a[1], b: a[2], e });
    }
  }
  const ranked = [...buckets.values()].sort((x, y) => y.n - x.n).slice(0, GI2_PAL_CLASSES);
  const slotOf = new Map(ranked.map((b, i) => [b.key, i]));
  const palette = Array.from({ length: PAL_ENTRIES }, () => ({ albedo: [0, 0, 0], emissive: 0 }));
  ranked.forEach((b, i) => {
    palette[i] = { albedo: [b.r / b.n, b.g / b.n, b.b / b.n], emissive: b.e / b.n };
  });
  // The last entry is "no surface" and MUST stay black: `palAt` clamps an
  // out-of-range byte (PAL_NONE = 255, an unvoxelized or stale cell) onto it,
  // and a non-black value there would light every hole in the window.
  palette[PAL_ENTRIES - 1] = { albedo: [0, 0, 0], emissive: 0 };
  // A placement whose class did not make the cut takes the nearest surviving
  // class rather than PAL_NONE — "no surface" means the ray hit nothing, and
  // handing it to a wall that simply lost a palette vote reads as a hole.
  const index = keys.map((k) => {
    const hit = slotOf.get(k);
    if (hit != null) return hit;
    return ranked.length ? 0 : PAL_NONE;
  });
  return { palette, index };
}

/**
 * @param {object} opts
 * @param {THREE.WebGPURenderer} opts.renderer
 * @param {object} opts.engine
 * @param {"phone"|"medium"|"high"|"ultra"} opts.tier
 * @param {number} opts.resolveWidth
 * @param {number} opts.resolveHeight
 * @param {{position: THREE.Texture, normal: THREE.Texture}} opts.gbuffer
 * @param {Array} [opts.lights]     GISystem light slots (`makeLightSlots`)
 * @param {Array} [opts.emitters]   GISystem emitter slots (uniform nodes)
 * @param {object} [opts.lightTree] the W1 region, when one exists
 * @param {{sky: object, ao: object}} [opts.env]
 * @param {object} [opts.shared]    cross-rebuild cache (the soup and its worker)
 */
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
  const cache = createRadianceCache(win, { tier });

  let gather = null;
  let voxelizer = null;
  let dynamic = null;
  let soup = null;
  let emitterDirect = null;
  let aoCompose = null;
  let aoOut = null;

  let frame = 0;
  let disposed = false;
  let coarseFrames = 0;
  let cacheCleared = false;
  const t0 = performance.now();
  const marks = { build: 0, soup: 0, voxelizer: 0, occupancy: new Map(), firstLight: 0 };
  const counters = {
    soupTris: 0, soupMB: 0, soupBuildMs: 0, soupStallMs: 0, soupDropped: 0, soupTruncated: false,
    palClasses: 0, movers: 0, moverTris: 0, scrolls: 0,
  };
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
    }
    gather = createGiGather({
      win, trace, cache,
      positionTexture: gbuffer.position,
      normalTexture: gbuffer.normal,
      width, height, tier,
      crops: 8,
    });
    gather.uniforms.projScale.value = projScaleOf(camera, height);
    for (const [key, node] of Object.entries(gather.passes)) {
      const stamp = (n, i) => {
        if (n && typeof n === "object") n.__giPassName ??= i == null ? `gi2.${key}` : `gi2.${key}#${i}`;
      };
      if (Array.isArray(node)) node.forEach(stamp);
      else stamp(node);
    }
    emitterDirect = emitters?.length ? buildEmitterDirectPass() : null;
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

    const surfaces = placements.map((p) => ({ albedo: p.albedo ?? [0.5, 0.5, 0.5], emissive: p.emissive ?? 0 }));
    const { palette, index } = buildGi2Palette(surfaces);
    counters.palClasses = palette.filter((e, i) => i < GI2_PAL_CLASSES
      && (e.albedo[0] + e.albedo[1] + e.albedo[2] + e.emissive) > 0).length;
    gather.setPalette(palette);
    const soupPlacements = placements.map((p, i) => ({
      geometryKey: p.geometryKey, matrix: p.matrix, pal: index[i], slot: p.slot,
    }));

    // The soup survives a rebuild whose geometry did not change — a GI rebuild
    // is triggered by a quality change, a resize, a refit and a light edit far
    // more often than by a mesh appearing, and re-running a 3 M-triangle worker
    // pass for a resize is three seconds of first-light latency bought for
    // nothing.
    let built = null;
    if (soupKey != null && store.soupKey === soupKey && store.soup) {
      built = store.soup;
      counters.soupBuildMs = 0;
      counters.soupStallMs = 0;
    } else {
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
      `; palette ${counters.palClasses} of ${GI2_PAL_CLASSES} classes`,
    );

    soup = uploadSoup(built);
    voxelizer = createWindowVoxelizer(win, soup, tier);
    dynamic = createWindowDynamic(win, voxelizer, tier);
    stampVoxNames();
    setMovers(movers);
    marks.voxelizer = performance.now();
    return true;
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
   * Mirror the system's lighting uniforms into the gather's own (see the header
   * note on the 3.2 API gap). `sun` is stored TOWARD the light by GISystem's
   * light slots; the gather's `sunDir` is the direction light TRAVELS.
   */
  const syncLighting = () => {
    const u = gather.uniforms;
    // `sunSlot` is GISystem's §12.82 uniform: the index of the one directional
    // slot it treats analytically, −1 for none. Read `.value` every frame —
    // adding, hiding or dimming a light reshuffles the slot list and must never
    // cost a GI rebuild (R11), so the index genuinely moves.
    const sunSlot = env?.sunSlot?.value ?? env?.sunSlot ?? -1;
    const slot = lights && sunSlot >= 0 && sunSlot < lights.length ? lights[sunSlot] : null;
    if (slot && slot.active.value > 0.5) {
      const v = slot.vector.value;
      u.sunDir.value.set(-v.x, -v.y, -v.z);
      u.sunColor.value.set(slot.color.value.r, slot.color.value.g, slot.color.value.b);
    } else {
      u.sunColor.value.set(0, 0, 0);
    }
    const sky = env?.sky?.value;
    if (sky) u.skyColor.value.set(sky.r, sky.g, sky.b);
    // The Cornell panel is the harness rig's emitter and has no scene source —
    // zero its radiance so `shadeHit`'s NEE compiles to a no-op contribution.
    // Scene emitters arrive through `emitterDirectPass` instead.
    u.panelRadiance.value.set(0, 0, 0);
    u.camPos.value.copy(camPos);
    u.viewProj.value.copy(viewProj);
    u.prevViewProj.value.copy(prevViewProj);
    u.projScale.value = projScaleOf(camera, height);
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
    syncLighting();

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

    // ── after the g-buffer prepass ────────────────────────────────────────
    //
    // `clearStats` FIRST: the gather's counters are atomics that would
    // otherwise read as lifetime totals, and every §L.7 receipt is a
    // per-frame number. Striped and uniform-gated, so it is ~0.01 ms.
    if (!aoCompose && env?.ao?.node) aoCompose = buildAoComposePass();
    const after = [
      gather.passes.clearStats,
      gather.passes.hzbBuild,
      ...gather.passes.hzbReduce,
      gather.passes.probePlace,
      gather.passes.probeTrace,
      gather.passes.probeFilter,
    ];
    if (emitterDirect) after.push(emitterDirect);
    after.push(gather.passes.resolve);
    // GTAO's own dispatches. `#armGtaoPass` appends them to whatever list the
    // transport hands it — on the SRC path that was `srcProbes.passes`, here it
    // is an array GISystem publishes as `ao.computes`. Read at PASS-BUILD time,
    // not captured at construction: this system is created before the AO pass
    // exists (it has to be — the AO pass reads the resolve's own size), so the
    // array is empty on the first read and filled a few lines later.
    for (const p of env?.ao?.computes ?? []) after.push(p);
    // AO lands on the resolved irradiance, before anything reads it: the
    // composite's lit frame feeds both `injectLitFrame` and the next frame's
    // screen segment, and an unoccluded lit frame would put the AO-less answer
    // into the cache and read it back as light.
    if (aoCompose) after.push(aoCompose);
    after.push(gather.passes.composite, gather.passes.inject);

    return { before, after, all: [...before, ...after] };
  };

  const setSize = (w, h) => {
    const nw = Math.max(16, Math.round(w));
    const nh = Math.max(16, Math.round(h));
    if (nw === width && nh === height) return false;
    width = nw;
    height = nh;
    const old = gather;
    const oldAo = aoOut;
    aoOut = null;
    aoCompose = null;
    buildGather();
    oldAo?.dispose();
    stampVoxNames();
    old?.dispose();
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
          console.log(
            `[gi2] first light — ${lastGather.probesValid} valid probes, ` +
            `${lastGather.windowHits} window hits / ${lastGather.screenHits} screen hits / ` +
            `${lastGather.skyMiss} sky, ${out.msToFirstLight} ms after the GI2 build started`,
          );
        }
      }
      if (voxelizer) {
        lastVox = await voxelizer.stats(r);
        out.voxelizer = lastVox;
        // Per-level time-to-first-occupancy (§K.8): the first frame each level
        // reported a built brick.
        for (const lvl of lastVox.perLevel ?? []) {
          if ((lvl.built > 0 || lvl.pairs > 0) && !marks.occupancy.has(lvl.level)) {
            marks.occupancy.set(lvl.level, Math.round(performance.now() - t0));
            console.log(`[gi2] first occupancy L${lvl.level} at ${marks.occupancy.get(lvl.level)} ms`);
          }
        }
        // ⚠ BLIND-INSTRUMENT GUARD. Every voxelizer counter is PER FRAME and
        // reset by the next frame's `resetCtr`, and a small scene's window
        // fills in one or two frames — so a sampler that reads every frame can
        // still land after the fill and see the (correct) all-zero steady
        // state. "No occupancy" would then be indistinguishable from "no
        // voxelizer", which is the failure this stage actually had. A ray that
        // came back from the STATIC window is proof of occupancy that no
        // sampling rate can miss, so it stamps an UPPER BOUND rather than
        // leaving the receipt empty.
        if (!marks.occupancy.size && (lastGather?.windowHits ?? 0) > 0 && marks.voxelizer) {
          const at = Math.round(performance.now() - t0);
          for (let l = 0; l < win.levels; l++) marks.occupancy.set(l, at);
          out.occupancyBound = true;
          console.log(`[gi2] first occupancy: ≤ ${at} ms (the window filled between two stat samples — ` +
            "the per-frame counters had already returned to their settled zeros; " +
            `${lastGather.windowHits} rays came back from it)`);
        }
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
    voxelizer: voxelizer?.describe() ?? null,
    dynamic: dynamic?.describe() ?? null,
  });

  return {
    tier, win, trace, cache,
    get gather() { return gather; },
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
      if (gather) for (const b of Object.values(gather.buffers)) list.push(b.value);
      return list.filter((a) => a?.isBufferAttribute === true);
    },
    /** Everything `collectStateComputeNodes` has to see. */
    get computeNodes() {
      return passesForRelease();
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
      const levelsSeen = marks.occupancy.size >= win.levels;
      const settled = levelsSeen || (marks.voxelizer && performance.now() - marks.voxelizer > 20_000);
      return settled ? 30 : 1;
    },
    /**
     * "The list `passes()` last returned was actually submitted." Only the
     * caller knows — `giCompute` can defer a whole batch on a boot frame — and
     * the scroll is the one pass whose effect is a ONE-SHOT re-key that nothing
     * downstream re-requests. Same shape as the SRC path's `_srcRanOnce`.
     */
    notePassesRan() { if (scrollInLastList) pendingScroll = false; },
    get transportAlive() {
      return (lastGather?.probesValid ?? 0) > 0 && (lastGather?.windowHits ?? 0) > 0;
    },
    dispose() {
      disposed = true;
      aoOut?.dispose();
      aoOut = null;
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
    return list.filter((n) => n?.isComputeNode === true);
  }
}
