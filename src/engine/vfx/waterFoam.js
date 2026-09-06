import {
  Fn, attribute, cameraFar, cameraNear, cameraPosition, float, linearDepth, mix, normalWorld, positionLocal, positionWorld,
  screenUV, select, texture, vec2, vec3,
} from "three/tsl";
import { waterRimDistanceNode } from "./waterShape.js";
import { seaDisplacementAt, seaFoamNode, seaFoamWindowNode, seaJacobianAt } from "./waterSpectrum.js";

/**
 * ══ WHAT A WATER SURFACE ADDS ON TOP OF BEING A MIRROR ═════════════════════
 *
 * Foam and subsurface scattering. Both land on material slots
 * `waterSurfaceLook.js` owns, which is why they are composed there — three has
 * exactly one `emissiveNode` and two modules writing it would silently clobber
 * each other. The fine-scale NORMAL used to live here too, as the slope of a
 * value-noise field; it is the spectral sea's derivative cascades now
 * (`waterSpectrum.js#seaShadingSlopeNode`) — real waves, not noise.
 *
 * ⚠ THESE READ THE SOLVER, NOT A SLOT. The engine-owned slots exist for
 * consumers that must not rebuild when a water surface changes (the medium,
 * GI); a material already rebuilds with its own water, so it may read the
 * simulation directly and get the authored wave settings with it.
 */

// ── NOISE PRIMITIVES ────────────────────────────────────────────────────────
const hash = (p) => p.dot(vec2(127.1, 311.7)).sin().mul(43758.5453).fract();
const hash2 = (p) => vec2(p.dot(vec2(127.1, 311.7)), p.dot(vec2(269.5, 183.3))).sin().mul(43758.5453).fract();
const valueNoise = Fn(([p]) => {
  const i = p.floor().toVar(), f = p.fract().toVar();
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash(i), b = hash(i.add(vec2(1, 0))), c = hash(i.add(vec2(0, 1))), d = hash(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});
/**
 * Cellular (Worley) noise: the distance to the nearest and second-nearest of a
 * jittered lattice of points, both in cell units. `F2 − F1` is zero exactly on
 * the boundary between two cells and grows away from it, which is what draws
 * the NETWORK foam makes; `F1` alone is a field of round blobs, which is what
 * draws the bubbles and the holes in a sheet. The jitter drifts with `time`,
 * so the cells breathe slowly instead of sitting still like a texture.
 */
const cellular = Fn(([p, time]) => {
  const i = p.floor().toVar(), f = p.fract().toVar();
  const f1 = float(8).toVar(), f2 = float(8).toVar();
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    const g = vec2(x, y);
    const jitter = hash2(i.add(g)).mul(6.2831).add(time).sin().mul(.5).add(.5);
    const r = g.add(jitter).sub(f);
    const d = r.dot(r).toVar();
    const closer = d.lessThan(f1);
    f2.assign(select(closer, f1, f2.min(d)));
    f1.assign(select(closer, d, f1));
  }
  return vec2(f1.sqrt(), f2.sqrt());
});
const ANGLES = [.0, 1.1, 2.3, 3.9, 5.1, 2.7, 4.4, .6];
const SPEEDS = [.11, -.19, .31, -.43, .23, -.37, .53, -.29];

/** Fixed four octaves, each rotated so the lattice never lines up with itself.
 *  Used where the fractal is a breakup mask and its shape is not authored. */
function fbm(p, time, drift = 1) {
  let sum = float(0), amplitude = float(.5), scale = float(1);
  for (let i = 0; i < 4; i++) {
    const c = Math.cos(ANGLES[i]), s = Math.sin(ANGLES[i]);
    const q = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))).mul(scale)
      .add(time.mul(SPEEDS[i] * drift));
    sum = sum.add(valueNoise(q).mul(amplitude));
    amplitude = amplitude.mul(.5);
    scale = scale.mul(2.07);
  }
  return sum.mul(1.0667);          // four halving octaves sum to 0.9375
}

/**
 * ⭐ **THE DETAIL RUNS ON THE WAVES' CLOCK, NOT ON THE WALL.**
 *
 * `simTime` is elapsed seconds. The swell multiplies it by `waveSpeed`
 * (the spectral sea's clock) and the fine detail did not, so the two were
 * only ever coincidentally in step: set the waves slow and the detail — and the
 * caustic lens it bends, and the god rays that lens makes — kept scrolling at
 * the same fixed rate. Measured with the waves STOPPED, where the answer has to
 * be zero: the caustic map still turned over 4.2 % of itself every tenth of a
 * second. "They don't match the surface speed" (user, 2026-09-06), exactly.
 *
 * The 0.25 is the rate itself, and it is deliberately about four times slower
 * than the constant it replaces — the same report asks for these to "update
 * slower and smoother", and a detail field is ripples riding a swell, not
 * weather of its own.
 */
function waveClock(u) { return u.simTime.mul(u.speed).mul(.25); }

/** Where this fragment is in WORLD metres, for noise that does not change size
 *  with the pool. */
const worldXZ = (u) => vec2(positionLocal.x.mul(u.waveScale.x), positionLocal.z.mul(u.waveScale.z));

/**
 * ══ FOAM ═══════════════════════════════════════════════════════════════════
 *
 * ⭐ **FOAM IS ONE NUMBER PER POINT — HOW MUCH — AND THE LOOK IS A FUNCTION
 * OF THAT NUMBER.** The number comes from two places:
 *
 *  · THE SIMULATED FIELD (`gridSimulation.js`) — entrained by steep water, by
 *    crests two waves built between them, and by anything churning the
 *    surface; it spreads, persists and decays, so a patch drifts and dissolves
 *    instead of blinking with the wave that made it.
 *  · CONTACT — how close the opaque scene is behind this fragment. Not a
 *    property of water at all, just a depth comparison.
 *
 * What the number DRAWS is taken from the photographs (and the sea): fresh,
 * dense foam is a white SHEET with holes in it; as it thins it breaks into a
 * NETWORK of filaments along the boundaries of the cells the bubbles drain
 * into — the web every aerial photograph of a wake shows — and the last of it
 * is a scatter of single BUBBLES. So a high value draws the sheet, a middle
 * value the web, a low value specks; and because the field decays over a few
 * seconds, one patch goes through all three in order, sheet → web → specks,
 * which is what foam actually does.
 *
 * ⛔ THE PREVIOUS VERSION CARVED A BLOB FIELD WITH VALUE NOISE. Value noise
 * has structure at one scale per octave and no lines in it at all, so foam
 * came out as soft-edged white blotches at every strength ("it is not
 * realistic", user 2026-09-06, with a photograph of the network beside it).
 * The network is a Worley boundary, not a threshold on a blob.
 *
 * `foam` decides how much of the surface counts as foamy (it moves the
 * generation threshold in the solver) and gates this on or off; it is not a
 * dimmer, because half-transparent foam is a grey wash and not less foam.
 */
export function waterFoamNode(u, sceneDepth = null, spectrum = null, flow = null) {
  // ⚠ WRAPPED IN `Fn`, AND IT HAS TO BE. `toVar()` and `addAssign` allocate on
  // the builder's STACK, and a node factory called straight from a material
  // build has no stack — "No stack defined for assign operation". Anything here
  // that declares a variable belongs inside one of these.
  return Fn(() => waterFoamBody(u, sceneDepth, spectrum, flow))();
}
function waterFoamBody(u, sceneDepth, spectrum, flow) {
  const p = worldXZ(u);
  const clock = waveClock(u);
  const drift = clock.mul(.5);
  // ── THE WAKE PATTERN RIDES THE FLOW ──────────────────────────────────
  // The pattern's coordinates follow the water: the drift the solver
  // accumulated (`flowTexture` .zw, local units) where the ripple window is,
  // so a wake's sheet and web move with the water they float on instead of
  // sitting still while it passes ("a static pattern", user, 2026-09-07).
  let carried = vec2(0);
  if (flow) {
    const t = vec2(positionLocal.x.sub(u.rippleCenter.x).div(u.rippleHalf.x.mul(2)).add(.5), positionLocal.z.sub(u.rippleCenter.y).div(u.rippleHalf.y.mul(2)).add(.5));
    const inside = t.x.greaterThan(0).and(t.x.lessThan(1)).and(t.y.greaterThan(0)).and(t.y.lessThan(1));
    const d = flow.sample(t.clamp(0, 1)).zw;
    carried = select(inside, vec2(d.x.mul(u.waveScale.x), d.y.mul(u.waveScale.z)), vec2(0));
  }
  const pw = p.sub(carried);

  // The solver's own foam, and the contact term.
  // ── WHITECAPS, PER PIXEL ──────────────────────────────────────────────
  //
  // The field's foam arrives per VERTEX, and a clipmap ring's vertices are
  // metres apart and sample the Jacobian at coarse mips, where its extremes
  // average away — an ocean at full choppiness showed no whitecaps at all
  // (the ocean arm, 2026-09-06). The fold is read here at the pixel from the
  // same cascades the shading normal reads, band-limited by their own mips.
  // The ripple field's foam: wakes, splashes, a rim's churn — drawn with the
  // sheet / network / flecks below. The SEA's whitecaps are a separate value
  // and a separate look (the end of this function).
  const simulated = attribute("waterFoam", "float").clamp(0, 1);
  let sea = null;
  if (spectrum) {
    // The whitecap MEMORY (waterSpectrum.js, the foam window) carries the
    // streaks and the distance; the instantaneous gate keeps the fold's own
    // edge crisp where the eye is close enough to see it.
    const cross = seaDisplacementAt(spectrum, p).w;
    sea = seaFoamWindowNode(spectrum, p).max(seaFoamNode(seaJacobianAt(spectrum, p, cross), u.foam)).toVar();
  }
  // The width itself is modulated, so the shoreline is ragged rather than a
  // uniform ring offset from the geometry.
  const ragged = fbm(p.mul(.7), clock, .7);
  const width = u.foamThreshold.max(.02).mul(ragged.mul(1.1).add(.45));
  // ── CONTACT: SCENE DEPTH ONLY FROM A PASS THAT OWNS IT ─────────────────
  //
  // Whatever the water touches foams at the waterline. The general answer
  // is the scene depth behind the fragment, but three's shared
  // `viewportDepthTexture()` is declared with the sample count of whichever
  // render target is current when the shader is BUILT (the MSAA canvas,
  // during GI's compile wave) and then bound in whatever pass draws the
  // water — a 1-sample one gets a 1×1 placeholder instead: "Sample count (1)
  // … doesn't match expectation (multisampled: 1)" (live editor,
  // 2026-09-06). So scene depth is read ONLY from a pass that owns its depth
  // texture (`engine.scenePass`, the post chain's beauty pass — its sample
  // count is a property of the texture). Without one, contact is the pool's
  // own rim: the box's edges in world metres, which binds nothing at all.
  const halfW = u.waveScale.x.mul(u.halfExtent.x), halfH = u.waveScale.z.mul(u.halfExtent.z);
  // Metres to the lid's outline: the box's rim, or a round pool's wall.
  const boxRim = halfW.sub(p.x.abs()).min(halfH.sub(p.y.abs()));
  const roundRim = waterRimDistanceNode(u.shape, u.halfExtent, p.x.div(u.waveScale.x), p.y.div(u.waveScale.z)).mul(u.waveScale.x.min(u.waveScale.z));
  const toRim = select(u.shape.x.lessThan(.5), boxRim, roundRim).max(0);
  const rimContact = toRim.smoothstep(width.mul(.15), width).oneMinus();
  let contact = rimContact;
  if (sceneDepth) {
    const behind = linearDepth(texture(sceneDepth, screenUV)).sub(linearDepth());
    const metres = behind.mul(cameraFar.sub(cameraNear)).max(0);
    contact = metres.smoothstep(width.mul(.15), width).oneMinus().max(rimContact);
  }
  const amount = simulated.max(contact.mul(.9)).toVar();

  // Patchiness: a slow, large fractal modulates the amount by ±25 % so the
  // sheet's edge and the web's density vary along a crest rather than
  // following the solver's cells.
  const patch = fbm(p.mul(.55), clock, .6);
  const v = amount.mul(patch.mul(.5).add(.75)).clamp(0, 1).toVar();

  // ── THE NETWORK ────────────────────────────────────────────────────────
  //
  // ⛔ A CELL BOUNDARY DRAWN AS A THIN HARD LINE IS A VORONOI DIAGRAM, NOT
  // FOAM — "the foam patterns look quite weird" (user, 2026-09-06, with a
  // screenshot of exactly that: crisp polygons and a sky of white dots). What
  // the photograph has is WIDE, SOFT filaments whose density varies along
  // their length, joining irregular blobs rather than polygons. So the lattice
  // is DOMAIN-WARPED by a low-frequency fractal before the cells are found
  // (no straight edges, no regular polygons), the filament is a soft falloff
  // of the edge distance a few times wider than before, and a fine fractal
  // rides along it so it thins and thickens like a real strand.
  const warp = vec2(fbm(p.mul(.35).add(vec2(3.1, 7.7)), clock, .5), fbm(p.mul(.35).add(vec2(-5.3, 2.9)), clock, .5)).sub(.5).mul(1.6);
  const q = pw.add(warp);
  const lineWidth = mix(float(.2), float(.55), v);
  const coarse = cellular(q.mul(.9), drift), fine = cellular(q.mul(2.6).add(warp.mul(1.5)), drift.mul(1.3));
  const filament = (cells, width) => cells.y.sub(cells.x).div(width).clamp(0, 1).oneMinus().pow(1.6);
  const grain = fbm(pw.mul(6), clock, 2).mul(.9).add(.35);
  const network = filament(coarse, lineWidth).mul(.95).add(filament(fine, lineWidth.mul(.9)).mul(.6)).clamp(0, 1).mul(grain).toVar();

  // ── THE SHEET ──────────────────────────────────────────────────────────
  // White, with warped holes of two sizes where the water shows through, and
  // a fine texture so it never reads as a flat fill.
  const holesA = cellular(q.mul(5), drift.mul(1.7)).x.smoothstep(.2, .5).oneMinus();
  const holesB = cellular(q.mul(13), drift.mul(2.3)).x.smoothstep(.14, .38).oneMinus();
  const sheet = float(.9).add(grain.mul(.15)).sub(holesA.mul(.45)).sub(holesB.mul(.25)).clamp(0, 1);

  // ── THE FLECKS ─────────────────────────────────────────────────────────
  // The last of a patch: soft irregular flecks from a fractal threshold —
  // never round dots, which read as stars on the water.
  const specks = fbm(pw.mul(11), clock, 1.5).smoothstep(.6, .78).mul(fbm(pw.mul(2.5), clock, .8).smoothstep(.4, .7));

  const sheetMask = v.smoothstep(.5, .82);
  const webMask = v.smoothstep(.05, .38);
  const speckMask = v.smoothstep(.015, .16);
  const wake = sheetMask.mul(sheet).max(webMask.mul(network)).max(speckMask.mul(specks)).clamp(0, 1);
  if (!sea) return wake.mul(u.foam.smoothstep(0, .15));

  // ── THE WHITECAPS (2026-09-07) ──────────────────────────────────────
  //
  // A breaking crest is a ragged sheet that dissolves into STREAKS along the
  // wind and then into bubbles — never the wake's lattice, which at sea
  // scale read as lace over hundreds of metres. The memory (0–1, decaying
  // from the fold) is cut by a fractal stretched four to one along the wave
  // direction: fresh foam is a sheet with bubbles in it, older foam only
  // where the streaks run, and the last of it a few bubbles. The texture is
  // finer than a pixel past a few tens of metres, so it fades out with
  // distance and the mip-filtered COVERAGE takes over as a soft tone — the
  // horizon is a stipple, not a speckle.
  // The memory's values are SMALL (linear, at the ocean preset, harness
  // 2026-09-07: median .05, p90 .28, p99 .64 — the gate opens a little,
  // often, and decays). A SHEET above .3 (its edge eaten by the bubbles),
  // STREAKS where the stretched fractal falls under three times the value
  // (a tenth of the area at the median, nearly all of a fresh patch), the
  // bubbles' own texture over both — with holes, or under a sun the foam
  // clips to a flat white. (Distance fades written as 1 − smoothstep: the
  // reversed-edge form is undefined in GLSL and not worth a doubt in WGSL.)
  const wind = vec2(u.waveCos, u.waveSin);
  const along = p.dot(wind), across = p.y.mul(wind.x).sub(p.x.mul(wind.y));
  const streak = fbm(vec2(along.mul(.18), across.mul(1.6)), clock, .5);
  const bubbles = fbm(p.mul(4.5), clock, 1.6);
  const metres = positionWorld.sub(cameraPosition).length();
  const bubbleDetail = metres.smoothstep(15, 60).oneMinus(), streakDetail = metres.smoothstep(60, 240).oneMinus();
  // Against the real thing (a storm sea beside ours, user 2026-09-07): foam
  // is SPARSE — a sheet only where a crest has just broken, thin streaks
  // drawn along the crests behind it, holes in both — never patches.
  const capSheet = sea.sub(bubbles.mul(.25).mul(bubbleDetail)).smoothstep(.7, .95);
  const streaks = sea.mul(1.3).sub(mix(float(.5), streak, streakDetail)).div(.25).clamp(0, 1);
  const capTexture = mix(float(.8), bubbles.mul(.7).add(.35), bubbleDetail);
  const near = capSheet.max(streaks.mul(.8)).mul(capTexture).clamp(0, 1);
  // Far: the mip-filtered coverage itself, as a tone.
  const far = sea.smoothstep(.2, .8).mul(.6);
  const whitecap = mix(near, far, metres.smoothstep(60, 240));
  return wake.max(whitecap).mul(u.foam.smoothstep(0, .15));
}

/**
 * ══ SUBSURFACE SCATTERING — THE GLOW THROUGH A CREST ═══════════════════════
 *
 * Looking toward the sun through the thin water at the top of a wave, light that
 * entered the far side scatters out toward the eye and the crest lights up from
 * within. One dot product, and it is the cue that most separates water from a
 * polished surface.
 */
/** The sea's raw whitecap value at the pixel (memory ∨ instantaneous gate) — a probe. */
export function seaFoamValueNode(u, spectrum) {
  if (!spectrum) return float(0);
  return Fn(() => {
    const p = worldXZ(u);
    const cross = seaDisplacementAt(spectrum, p).w;
    return seaFoamWindowNode(spectrum, p).max(seaFoamNode(seaJacobianAt(spectrum, p, cross), u.foam));
  })();
}
/** Where on its wave a point sits: 0 in the trough, 1 on the crest — IN
 *  METRES (a lid's local units times its scale against the authored heights;
 *  on a lid scaled by three the raw ratio saturated and every swell became a
 *  hard-edged green sheet, 2026-09-06). Only a sea with real waves has thin
 *  crests: the term fades in between 10 and 50 cm of wave height, so a pool's
 *  ripples never turn green. */
function crestNode(u) {
  const range = u.waveHeight.add(u.amplitude).max(.001);
  const height = positionLocal.y.mul(u.waveScale.y);
  return height.div(range).mul(.5).add(.5).clamp(0, 1).mul(range.smoothstep(.1, .5));
}
/**
 * ⭐ THE COLOUR GRADIENT ON THE WATER ITSELF. Thin water at a crest absorbs
 * less and scatters more toward the eye than the deep body in a trough — the
 * real sea is lighter and greener along its crests ("you see color gradients
 * on the water itself, subsurface scattering, which we lack", user,
 * 2026-09-07). A multiplier on the transmitted radiance: ×1 in the trough,
 * brighter and toward green at the crest.
 */
export function waterCrestGradientNode(u) {
  return mix(vec3(1), vec3(.8, 1.4, 1.25), crestNode(u).smoothstep(.35, 1));
}
export function waterSubsurfaceNode(u, slot) {
  const toEye = cameraPosition.sub(positionWorld).normalize();
  const toSun = vec3(slot.uniforms.toSun);
  // Light that entered the far side of a crest and scatters out toward the
  // eye — strongest looking toward the sun through the wave (the demo's
  // distorted back-light), never quite absent — in the colour thin water
  // hands on: the in-scatter colour pushed toward a bright teal, not the
  // body's own dark blue, which glowed invisibly against itself.
  const backlit = toEye.dot(toSun.negate().add(normalWorld.mul(.3)).normalize()).max(0).pow(4);
  const crest = crestNode(u).smoothstep(.5, 1).pow(1.5);
  const tint = vec3(.5, 1.7, 1.3);
  return vec3(slot.uniforms.scatter).mul(tint).mul(crest).mul(backlit.mul(1.2).add(.25));
}

/** Kept for the surface smoke, which asserts crest foam exists at all. */
export function waterCrestFoamNode(u) { return waterFoamNode(u); }
