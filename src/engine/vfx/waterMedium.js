import * as THREE from "three/webgpu";
import { Fn, If, Loop, cameraPosition, float, fract, interleavedGradientNoise, mix, output, positionWorld, screenCoordinate, select, uniform, vec2, vec3, vec4 } from "three/tsl";
import { waterSlotPool } from "./waterSlots.js";
import { waterCausticGainLocalNode } from "./waterCaustics.js";
import { clipShapeNode } from "./waterShape.js";

/**
 * ══ UNDERWATER IS NOT A TOGGLE, IT IS A PATH LENGTH ════════════════════════
 *
 * "It is not a toggle on/off post process, if camera is half in water half
 * above, it must look correct" (user, 2026-09-05). Every screen-space "am I
 * submerged?" effect fails exactly there, because the answer is not one boolean
 * per FRAME — it is one number per PIXEL: how many metres of water lie between
 * the eye and whatever that pixel shows. A pixel looking at the sky over the
 * rim crosses none. The pixel beside it, looking at the same sky THROUGH the
 * surface, crosses the whole column. Nothing about that is a fade between two
 * modes, and no amount of blending two full-screen looks produces it.
 *
 * So this is a medium, attached where three already provides a per-fragment
 * hook over the finished colour: `scene.fogNode`. For each water slot the
 * eye→fragment segment is clipped against the volume box (`waterVolume.js`'s
 * shared definition, with the top face lifted onto the ACTUAL wave from the
 * slot's surface map) and the clipped length drives Beer-Lambert absorption
 * toward the water's own colour. Above water, outside every box, the length is
 * zero and the node is the identity — the same code path, costing one branch,
 * is what "not underwater" means.
 *
 * That one expression is simultaneously:
 *   · the underwater view when the eye is inside,
 *   · the correct half-and-half when the eye is ON the surface — the waterline
 *     lands where each ray first crosses the wave and wobbles with it, because
 *     the top face is sampled rather than assumed flat,
 *   · the depth tint on a submerged object seen from above, and
 *   · nothing at all for the rest of the scene.
 *
 * ⚠ **THE AUTHORED SCENE FOG IS REPLICATED HERE, NOT REPLACED.** three's
 * `getFogNode` prefers `scene.fogNode` over the one it builds from `scene.fog`,
 * so installing this naively would silently delete the project's own fog. Both
 * live in the one node; the atmosphere is applied first, then the water.
 *
 * ⚠ **INSTALLING THIS RECOMPILES EVERY MATERIAL** — it is part of three's
 * material cache key. It is therefore installed once, when a scene first has
 * water, and reads the ENGINE-OWNED slot textures (`waterSlots.js`) rather than
 * any component's, so a water surface changing resolution, moving, being
 * disabled or being deleted costs uniforms and never a rebuild.
 */

/** Robust slab clip. The tiny-but-SIGNED reciprocal is what makes a segment
 *  exactly parallel to a face behave: outside the slab both roots run off to
 *  the same infinity and reject, inside they straddle and constrain nothing. */
function clipSlab(t0, t1, origin, delta, min, max) {
  const safe = select(delta.abs().lessThan(1e-6), select(delta.greaterThanEqual(0), float(1e-6), float(-1e-6)), delta);
  const inv = float(1).div(safe);
  const lo = min.sub(origin).mul(inv), hi = max.sub(origin).mul(inv);
  t0.assign(t0.max(lo.min(hi)));
  t1.assign(t1.min(lo.max(hi)));
}

/**
 * World metres of water crossed between the eye and this fragment — the whole
 * effect in one number, and the one thing worth testing directly. Exported
 * because an image test of "half in, half out" has to argue from pixels about a
 * quantity it cannot see; this lets a smoke page read the quantity itself.
 */
export function waterCrossedLengthNode(slot) { return waterSegmentNode(slot, { shapeClip: true }).length; }

/**
 * The clipped segment: how far it runs through water, and how deep each END of
 * it is. Both depths, because the in-scatter integral needs the near one and
 * the slope — see `applyMedium`.
 */
export function waterSegmentNode(slot, { shapeClip = true } = {}) {
  const s = slot.uniforms;
  const a = s.inverse.mul(vec4(cameraPosition, 1)).xyz.toVar();
  const b = s.inverse.mul(vec4(positionWorld, 1)).xyz.toVar();
  const d = b.sub(a).toVar();
  const half = vec3(s.half).toVar();
  const t0 = float(0).toVar(), t1 = float(1).toVar();
  clipSlab(t0, t1, a.x, d.x, half.x.negate(), half.x);
  clipSlab(t0, t1, a.z, d.z, half.z.negate(), half.z);
  // A solid of revolution: one exact quadric clip on top of the slabs —
  // compiled only when a round pool exists (`pool.compileShape()`; 20 kB per
  // slot in every material otherwise). `__waterShapeClip = false` ablates.
  if (shapeClip && globalThis.__waterShapeClip !== false) clipShapeNode(vec4(s.shape), t0, t1, a, d);
  // THE TOP FACE IS THE WAVE, AND SAYING SO TAKES TWO PASSES. The entry point
  // is needed to sample the height and the height is needed to find the entry
  // point. Clip against the rest surface, sample there, clip again: one
  // refinement is enough, because the wave is small next to the volume and the
  // second crossing lands within a texel of the first.
  const flat0 = t0.toVar(), flat1 = t1.toVar();
  const top = float(0).toVar();
  clipSlab(flat0, flat1, a.y, d.y, half.y.negate(), float(0));
  If(flat1.greaterThanEqual(flat0), () => {
    const entry = a.add(d.mul(flat0.clamp(0, 1))).toVar();
    const uv = vec2(entry.x.div(half.x.mul(2)).add(.5), entry.z.div(half.z.mul(2)).add(.5)).clamp(.001, .999);
    top.assign(slot.nodes.surface.sample(uv).depth(slot.index).level(0).x);
  });
  clipSlab(t0, t1, a.y, d.y, top.sub(half.y), top);
  // The parameter is normalized along the same segment in both spaces, so the
  // fraction converts straight back to world metres without decomposing scale.
  const span = positionWorld.sub(cameraPosition).length();
  const length = t1.sub(t0).max(0).mul(span);
  const depthAt = (t) => top.sub(a.y.add(d.y.mul(t))).max(0).mul(s.rise);
  // `at` walks the clipped segment in LOCAL space, which is what the light
  // shafts march over — see `applyMedium`.
  return { length, near: depthAt(t0.clamp(0, 1)), far: depthAt(t1.clamp(0, 1)),
    at: (k) => a.add(d.mul(t0.add(t1.sub(t0).mul(k)))) };
}

/**
 * ══ LIGHT SHAFTS ARE THE CAUSTIC PATTERN, SEEN EDGE ON ═════════════════════
 *
 * Nothing new has to be simulated for them. The caustic map already says how
 * much sunlight is concentrated at a point in the volume; a shaft is what you
 * see when the eye looks ALONG that concentration instead of at the floor it
 * lands on. So the in-scatter, which was uniform along the ray, is modulated by
 * the caustic gain sampled at a handful of points down the segment.
 *
 * ⚠ THE TAPS ARE INSIDE THE `active` BRANCH FOR A REASON. This node is
 * `scene.fogNode`: it compiles into EVERY material in the project. Paying a
 * dozen texture reads on every pixel of every object would be a frame-rate
 * change for a scene that happens to contain a pond. Inside the branch the cost
 * lands only on pixels whose view ray actually crosses water, and the branch is
 * coherent — whole regions of the screen take it together.
 *
 * With `causticIntensity` at 0 the gain is exactly 1 everywhere, the mean is 1,
 * and this multiplies the in-scatter by 1: shafts cost their taps and change
 * nothing, without a second uniform to say so.
 */
/**
 * ⚠ SIXTEEN, NOT TEN — but the tap count was the small half. "Can we make the
 * underwater godrays a bit smoother, less dithered? They look too noisy... and
 * probably they are changing way too fast" (user, 2026-09-06) is one number,
 * the VARIANCE of a dozen samples of a high-contrast field, and the dither only
 * decides whether that variance looks like grain or like banding.
 *
 * ⛔ BAND-LIMITING THE LENS WAS TRIED AND REFUTED. Cutting the surface detail
 * that bends the caustic pass to three slow octaves reads as the obvious fix
 * and measured as a null: pixel-to-pixel noise 16.94 → 16.16, and it cost the
 * FLOOR its filaments, which are made by exactly the octaves being removed.
 * With the prefiltered map below it is worse than useless — same noise and MORE
 * temporal change (7.84 against 4.76), because a few coarse octaves leave large
 * high-contrast structures sweeping past while eight of them average into
 * something stable. Reverted.
 *
 * What worked is prefiltering: the shafts read a coarse MIP of the caustic map
 * (see `waterSlots.js`'s `causticTarget`) while the floor still reads level 0.
 * Measured on the same frame: noise 16.94 → 8.0, change over 0.2 s 12.41 →
 * 4.76, and the dotted grain is gone from the image.
 */
const SHAFT_TAPS = 24;
/** The mip the shafts read the caustic map at — 1024 >> 4 = 64 texels across
 *  the pool. A beam is a low-frequency thing; the filaments underneath it are
 *  what the taps could not resolve. */
const SHAFT_MIP = 5;
/**
 * ══ WHAT MAKES A SHAFT LOOK LIKE A SHAFT ═══════════════════════════════════
 *
 * "God rays underwater are quite good, but not very accurate, flickery, and
 * unrealistic" (user, 2026-09-06). Three things were missing from the physics
 * and each is one line:
 *
 *  1. THE SUN IS ABSORBED ON THE WAY DOWN. The beam at a tap was weighted only
 *     by the water between the tap and the EYE, so a column of light was as
 *     bright at the floor as at the surface — a uniform vertical stripe. The
 *     light concentrated at depth d has already crossed d metres of water
 *     (over the refracted slant), and that is why real shafts bloom just under
 *     the surface and die toward the bottom.
 *  2. WATER SCATTERS FORWARD. Suspended matter is far larger than a wavelength,
 *     so the phase function is strongly peaked along the light's own
 *     direction: looking UP toward the sun through the beams they are
 *     brilliant, looking DOWN at the floor they all but vanish, and from the
 *     side they are what the old isotropic term showed everywhere. That is the
 *     "accuracy" — the beams belonging to a direction. Henyey-Greenstein with
 *     g = 0.62, normalized to 1 for a side view so the authored brightness of
 *     the horizontal case is what it was.
 *  3. The flicker was the lens (see `waterSlots.js`); the shafts read a coarser
 *     mip of a smoother map and a few more taps.
 */
const SHAFT_G = .62;
const shaftPhase = (slot) => {
  const beam = vec3(slot.uniforms.toSunRefracted).negate();      // where the light is going
  const toEye = cameraPosition.sub(positionWorld).normalize();
  const cos = beam.dot(toEye);
  const g2 = SHAFT_G * SHAFT_G;
  const side = (1 - g2) / Math.pow(1 + g2, 1.5);
  const hg = float(1 - g2).mul(float(1 + g2).sub(cos.mul(2 * SHAFT_G)).max(1e-3).pow(-1.5));
  return hg.div(side).min(5);
};
/**
 * The sunlight scattered toward the eye along the ray, ABOVE what a uniformly
 * lit column would give — which is what a beam IS. Modulating the ambient haze
 * by the mean gain (the first attempt) can only tint something that is already
 * there and never produces a shaft; this ADDS the sun where the lens
 * concentrates it and nothing where it does not, so the beams stand clear of
 * the haze exactly as in a real tank.
 *
 * Each sample is attenuated by the water between it and the eye, so near beams
 * are bright and far ones fade — without that the column reads as a flat wash
 * of stripes.
 *
 * ⚠ THE START IS DITHERED PER PIXEL. Ten taps across twenty metres is one
 * sample every two metres, and a regular comb through a high-contrast caustic
 * field is visible banding. An interleaved-gradient offset turns the banding
 * into a fine dither the eye reads as haze — the same trick, and the same
 * function, the volumetric materials use.
 */
/** The beam's floor above the flat sun. The old map averaged above one, so
 *  the excess carried a haze of its own — the forward glow looking up at the
 *  sun on CALM water, where the filaments' excess alone is nothing ("god rays
 *  underwater got almost absent", user, 2026-09-06). */
const SUN_HAZE_EXCESS = .2;
function shaftNode(slot, segment, tau, sigma) {
  const jitter = fract(interleavedGradientNoise(screenCoordinate));
  const total = vec3(0).toVar();
  // The sun's path to a point at depth d is d over the refracted ray's slant.
  const slant = float(1).div(vec3(slot.uniforms.toSunRefracted).y.max(.25));
  // `__waterShaftMip` is the harness's dial for the sweep in
  // scripts/water-premium-smoke.html; the shipped value is SHAFT_MIP.
  const mip = Number.isFinite(globalThis.__waterShaftMip) ? globalThis.__waterShaftMip : SHAFT_MIP;
  // ⚠ A GPU LOOP, NOT A JS ONE. A JS `for` here unrolled 24 copies of the
  // caustic lookup — per slot, into EVERY material in the scene (this node is
  // `scene.fogNode`): a plain floor material compiled a 362 kB fragment shader
  // and the editor froze 10–15 s on every material it minted (user,
  // 2026-09-06). One copy, one loop.
  // Two terms in one beam. The HAZE is the sun's whole light at water's
  // own albedo — the forward glow looking up at it, which the excess alone
  // cannot give (its mean along a ray is nothing). The SHAFTS are the
  // filaments' EXCESS over the flat sun, at the water colour's albedo (near
  // one), which is what reads as a ray; carried at the haze's albedo they
  // flattened away — "our underwater godrays got broken" (user, 2026-09-06).
  const shaftAlbedo = vec3(slot.uniforms.scatter).mul(4).clamp(0, 1);
  Loop({ start: 0, end: SHAFT_TAPS }, ({ i }) => {
    const k = float(i).add(jitter).div(SHAFT_TAPS);
    // The beam's EXCESS over the mean, positive half: the shafts are the
    // filaments' light above the flat sun, and only that reads as a ray.
    // Carrying the whole beam at a tenth of the albedo flattened them to a
    // haze — "our underwater godrays got broken" (user, 2026-09-06).
    const gain = waterCausticGainLocalNode(segment.at(k), slot, mip, null, { volume: true });
    // The excess is clamped: a filament at the map's cap (5) is a one-frame
    // spike along a ray, and the shafts flickered at 4.3× smooth motion.
    // The haze OUTSIDE the clamp: the map is skewed (most cells below one, a
    // few filaments far above), so a bias inside the clamp vanished into the
    // dark cells and the forward glow with it. A true floor plus the
    // positive excess keeps both.
    const beam = shaftAlbedo.mul(gain.sub(1).clamp(0, 1.5).add(SUN_HAZE_EXCESS));
    const depth = mix(segment.near, segment.far, k);
    const reach = sigma.mul(depth).mul(slant).negate().exp();
    total.addAssign(tau.mul(k).negate().exp().mul(reach).mul(beam));
  });
  return total.div(SHAFT_TAPS);
}

/**
 * ══ SINGLE SCATTERING, SOLVED RATHER THAN SAMPLED ══════════════════════════
 *
 * Absorption is Beer-Lambert and was never the hard half. The in-scatter is:
 * light scattered toward the eye from every point along the ray, where the
 * SOURCE at each point is itself dimmed by the depth it sits at, and the result
 * is dimmed again by the water between that point and the eye.
 *
 * ⛔ EVALUATING THAT AT THE SEGMENT'S MIDPOINT IS WRONG WHERE IT MATTERS MOST.
 * In a thick medium virtually all the light that reaches the eye is scattered
 * in the first metre — the rest never gets out — so the midpoint's depth
 * under-lights the haze by the whole optical thickness. Turned all the way up,
 * a pool went BLACK instead of opaque, and objects inside it stayed perfectly
 * legible as silhouettes against it (measured: a sphere 4 m down held 49 units
 * of contrast at saturation 1, when the request was "we can't see through it at
 * all"). Milky, not dark, is the correct failure.
 *
 * With depth linear along the ray the integral has a closed form. For a ray of
 * optical thickness `τ = σL`, entering at depth `d0` and descending with slope
 * `m = Δdepth/L`:
 *
 *     L_in = S · e^(−σ·d0) · τ · (1 − e^(−τ(1+m))) / (τ(1+m))
 *
 * Three checks worth keeping: σ = 0 gives exactly zero (genuinely clear water,
 * not merely faint); straight down through a thick column gives S/2, which is
 * the milky plate; and a deep horizontal ray gives S·e^(−σ·d), which is why the
 * bottom of a pool is dark while its surface is bright. `(1 + m)` passes through
 * zero for a ray running along a depth contour, and the `x/(1−e^−x)` form is
 * finite there, so the guard is on the division and not on the geometry.
 */
function applyMedium(rgb, slot, { shapeClip, lid = false }) {
  applyMediumSegment(rgb, slot, lid ? waterLidSegmentNode(slot) : waterSegmentNode(slot, { shapeClip }));
}
/**
 * The segment for a fragment ON THE LID. `waterSegmentNode` clips the eye
 * ray at the surface height sampled where the ray crosses the rest plane;
 * on a metre of swell a trough fragment lies well below that, and metres of
 * "water" were counted along a grazing ray to a point reached through air —
 * every trough a hard-edged sheet of the scatter colour (the ocean arm,
 * 2026-09-06). The lid IS the interface: no path from above, all of it from
 * below.
 */
export function waterLidSegmentNode(slot) {
  const s = slot.uniforms;
  const a = s.inverse.mul(vec4(cameraPosition, 1)).xyz.toVar();
  const b = s.inverse.mul(vec4(positionWorld, 1)).xyz.toVar();
  const below = a.y.lessThan(0);
  const span = positionWorld.sub(cameraPosition).length();
  return {
    length: select(below, span, float(0)),
    near: a.y.negate().max(0).mul(s.rise),
    far: float(0),
    at: (k) => a.add(b.sub(a).mul(k)),
  };
}
/**
 * The medium over an EXPLICIT segment — { near, far (depths below the
 * surface, metres), length (metres), at(k) → world point } — for a ray that
 * is not the eye's: the water's BVH-traced refraction (2026-09-06) shades
 * its hit through the same absorption, in-scatter and shafts.
 */
export function applyMediumSegment(rgb, slot, segment) {
  const s = slot.uniforms;
  If(s.active.greaterThan(0), () => {
    const sigma = vec3(s.sigma);
    const length = segment.length.toVar();
    const tau = sigma.mul(length).toVar();
    // Depth gradient along the ray, dimensionless: +1 straight down, 0 level.
    // Depth changes at most one metre per metre travelled, so this is in
    // [-1, 1] and `1 + slope` in [0, 2] — the exponent below can never go
    // negative and the only degenerate case is a ray running exactly level or
    // exactly upward, where the epsilon makes `(1 - e^-a)/a` its own limit, 1.
    const slope = segment.far.sub(segment.near).div(length.max(1e-4)).clamp(-1, 1);
    const a = tau.mul(slope.add(1)).add(1e-5).toVar();
    const shape = a.negate().exp().oneMinus().div(a);
    const inScatter = vec3(s.scatter).mul(sigma.mul(segment.near).negate().exp()).mul(tau).mul(shape).toVar();
    // ── LIGHT SHAFTS, AND ONLY WHEN THERE IS A LENS TO MAKE THEM ─────────
    //
    // Nested inside `active`, so a scene with no caustics pays one coherent
    // branch and not ten texture reads on every pixel of every material —
    // `scene.fogNode` compiles into all of them, and that is the whole reason
    // the tap count is what it is.
    If(s.strength.greaterThan(0), () => {
      // Scattered sunlight, tinted by the water it is travelling through. The
      // albedo is the water's own colour: a beam in green water is green.
      // The water's own colour, near one, as the shafts' albedo: it stays sane
      // because the beam term above averages to nearly nothing along a ray —
      // the floor keeps its brightness and the filaments read as rays.
      // The albedos live inside the beam (haze + shafts, see shaftNode).
      inScatter.addAssign(vec3(s.radiance).mul(shaftNode(slot, segment, tau, sigma)).mul(tau.min(2)).mul(shaftPhase(slot)).mul(s.shafts));
    });
    rgb.assign(rgb.mul(tau.negate().exp()).add(inScatter));
  });
}

/** three's own atmospheric fog, replicated so installing this node does not
 *  delete the project's authored `scene.fog`. Uniform-driven: editing colour or
 *  range writes a uniform, and only changing its KIND rebuilds. */
function sceneFog(rgb, fog, atmosphere) {
  if (!fog) return;
  const depth = positionWorld.sub(cameraPosition).length();
  const factor = fog.isFogExp2
    ? atmosphere.density.mul(atmosphere.density).mul(depth).mul(depth).negate().exp().oneMinus()
    : depth.sub(atmosphere.near).div(atmosphere.far.sub(atmosphere.near).max(1e-4)).clamp(0, 1);
  rgb.assign(rgb.mul(factor.oneMinus()).add(vec3(atmosphere.color).mul(factor)));
}

/**
 * One medium per engine, driven from the engine's water slot pool. `sync` runs
 * after every water component's own tick and only ever writes uniforms; the
 * node itself is rebuilt exclusively when the authored fog changes KIND, which
 * is a project setting and not a frame.
 */
export function installWaterMedium(engine) {
  if (engine._waterMedium) return engine._waterMedium;
  const pool = waterSlotPool(engine);
  const atmosphere = { color: uniform(new THREE.Color()), near: uniform(1), far: uniform(1000), density: uniform(0) };
  let fogKey = null;
  // ── COMPILED FOR THE POOLS THAT EXIST, NOT FOR EVERY SLOT ─────────────
  //
  // This node goes into EVERY material. Two slots and four primitives'
  // quadric clips compiled unconditionally were 63 kB of fragment shader per
  // material (the floor of the bindings smoke: 114 kB with the shaft loop,
  // 362 kB before it). It is built for the slots claimed and the shapes in
  // use, and rebuilt — one compile wave, on the rare event — when a second
  // pool or a first round one appears.
  let compiled = { count: 1, round: false };
  const build = (fog) => {
    compiled = pool.compileShape();
    // ⚠ `Fn((builder) => …)`: a body with one parameter and no inputs is
    // handed the node builder, and the fog is built once per material — so
    // the lid (`userData.waterLid`) gets its own segment rule.
    engine.scene.fogNode = Fn((builder) => {
      const lid = builder?.object?.userData?.waterLid === true;
      const rgb = output.rgb.toVar();
      sceneFog(rgb, fog, atmosphere);
      for (const slot of pool.slots.slice(0, compiled.count)) applyMedium(rgb, slot, { shapeClip: compiled.round, lid });
      return vec4(rgb, output.a);
    })();
    pool.compiled = compiled;
  };
  // ── AND A CENSUS, BECAUSE ONE OPTED-OUT MATERIAL HIDES THE WHOLE EFFECT ──
  //
  // `material.fog === false` removes this node from that material entirely.
  // A lake bed imported with fog off would show through water of any density,
  // at any saturation, and nothing about the water would be wrong — which is
  // exactly the shape of "still seeing all the way to the bottom at saturation
  // 1" (user, 2026-09-06) when the same pool goes opaque in the harness.
  // Deferred, because at install time the scene is usually still loading.
  setTimeout(() => {
    if (!engine._waterMedium) return;
    // ⚠ COUNT SCENE CONTENT, NOT THE EDITOR'S FURNITURE. The gizmos, the grid,
    // the collider overlay and GI's own internals are all legitimately
    // `fog: false`, and a raw census drowns the one thing worth knowing — is
    // anything the CAMERA LOOKS THROUGH THE WATER AT opted out — in sixty
    // helpers. Only objects belonging to an entity are the author's.
    const owned = new Set();
    for (const entity of engine.entities?.values?.() ?? []) entity.object3D?.traverse?.((o) => owned.add(o));
    let total = 0, opted = 0; const names = [];
    engine.scene.traverse((object) => {
      const m = object.material; if (!m || !owned.has(object)) return;
      for (const material of Array.isArray(m) ? m : [m]) {
        total++;
        if (material.fog !== false) continue;
        opted++;
        if (names.length < 8) names.push(material.name || object.name || material.type);
      }
    });
    console.log(`[water] medium armed on scene.fogNode — ${total} scene materials, ${opted} with fog:false${
      opted ? ` (no underwater at all on: ${names.join(", ")}${opted > names.length ? ", …" : ""})` : ""}`);
  }, 4000);

  const stop = engine.onUpdate?.(() => {
    const fog = engine.scene.fog ?? null;
    const key = fog ? (fog.isFogExp2 ? "exp2" : "range") : "none";
    const want = pool.compileShape();
    if (key !== fogKey || want.count > compiled.count || (want.round && !compiled.round)) { fogKey = key; build(fog); }
    if (fog) {
      atmosphere.color.value.copy(fog.color);
      if (fog.isFogExp2) atmosphere.density.value = fog.density;
      else { atmosphere.near.value = fog.near; atmosphere.far.value = fog.far; }
    }
  });
  engine._waterMedium = {
    pool,
    dispose() {
      stop?.();
      engine.scene.fogNode = null;
      engine._waterMedium = null;
    },
  };
  return engine._waterMedium;
}
