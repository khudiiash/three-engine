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
      // THE MATERIAL-FACING IRRADIANCE WHEN AO IS ON — see gi2TextureGeneration.
      aoOut.version = ++gi2TextureGeneration;
    }
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
    });
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

    return { before, after, all: [...before, ...after] };
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
  const retireGather = (dead, deadAo, deadNodes) => {
    if (!dead && !deadAo) return;
    if (globalThis.__gi2ResizeDisposeNow === true) {
      dead?.dispose();
      deadAo?.dispose();
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
      },
    });
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
    aoOut = null;
    aoCompose = null;
    buildGather();
    stampVoxNames();
    retireGather(old, oldAo, [oldEmitterDirect, oldAoCompose]);
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
      // `b?.value`: a harness-only buffer (the crop pair) is null on the
      // engine path — see `crops: 0` above.
      if (gather) for (const b of Object.values(gather.buffers)) list.push(b?.value);
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
    notePassesRan() { if (scrollInLastList) pendingScroll = false; },
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
