import * as THREE from "three/webgpu";
import { Fn, If, cameraPosition, cos, dot, equirectUV, float, floor, hash, max, min, mix, positionWorldDirection, pow, sin, smoothstep, texture, uniform, vec2, vec3, vec4 } from "three/tsl";
import { getCloudNoiseTexture } from "./cloudNoise.js";

/**
 * ⭐ THE VISIBLE SKY — `scene.backgroundNode`, one full-screen shader.
 *
 * Everything that has to be SHARP lives here and nowhere else: the sun's and
 * the moon's discs, the stars, the cloud shapes. Everything that has to be
 * SMOOTH — the dome's own radiance, and therefore the light the scene
 * receives — comes out of `skyModel.js` as a small equirect texture that this
 * shader samples as its base layer. The split is the whole design:
 *
 *   · a 128×64 environment map is far too coarse to show a 0.5° sun, and
 *   · per-pixel cloud noise in an environment map would re-trigger GI's sky
 *     integration every frame and flicker the indirect light.
 *
 * So the picture gets the detail and the lighting gets the smooth field, and
 * both are the same sky because the shader's cloud colours are the ones the
 * model computed (`cloudLight`), not a second set someone tuned to match.
 *
 * ⚠ `scene.backgroundNode` IS AN ESTABLISHED SEAM, not a new one: GI's screen
 * passes and the foliage warmup already save and restore it around their own
 * renders (`giScreen.js`, `foliageWarmup.js`), and three's `Background`
 * prefers it over `scene.background` — so Scene Settings' skybox stays
 * exactly where it is and comes back the moment the Atmosphere is disabled.
 */

// ⛔⛔ NEVER `smoothstep(high, low, x)`. WGSL says a smoothstep whose low edge
// is not below its high edge is UNDEFINED, and this project renders through
// WGSL: a descending fade is `smoothstep(low, high, x).oneMinus()`. The
// reversed form appeared to work for months and then produced warm sun-disc
// colour at arbitrary points of the sky — soft purple blobs that moved with the
// sun, reported three times as "random colour spots".

/** Angular radii, radians. Both are ~0.26° in life and both are drawn larger:
 *  at a 60° field of view the true sun is two pixels across, which reads as a
 *  dead pixel rather than as the sun. The moon is larger still so its phase —
 *  which the model computes exactly — is actually visible. */
const SUN_RADIUS = 0.0047 * 2.2;
const MOON_RADIUS = 0.0047 * 3.2;
/** Cells per radian for the star lattice: ~0.8° spacing, ~1300 stars. */
const STAR_DENSITY = 70;
/** Keeps every lattice index positive before it is hashed as a uint. */
const STAR_SEED_BIAS = 1048576;
/** The cloud deck, in metres, and how many heights through it are sampled.
 *  Four is the point where adding another stops changing the silhouette and
 *  only costs taps. */
const CLOUD_BASE = 1400;
const CLOUD_TOP = 3200;
const CLOUD_SLICES = 4;
/** The four baked octaves of `cloudNoise`, weighted to stay inside [0,1]. */
export const CLOUD_OCTAVE_WEIGHTS = /*@__PURE__*/ vec4(0.5, 0.25, 0.15, 0.1);
const OCTAVE_WEIGHTS = CLOUD_OCTAVE_WEIGHTS;

export function createSkyUniforms() {
  return {
    // The model's dome, as an equirect. Assigned by `setSkyMap` once the
    // component has built its DataTexture.
    map: null,
    mapNode: null,
    sunDirection: uniform(new THREE.Vector3(0, 1, 0)),
    moonDirection: uniform(new THREE.Vector3(0, -1, 0)),
    sunDisc: uniform(new THREE.Color(1, 1, 1)),
    moonDisc: uniform(new THREE.Color(0.6, 0.7, 1)),
    /** The celestial pole in world space — stars turn about it, not about Y. */
    starAxis: uniform(new THREE.Vector3(0, 1, 0)),
    starAngle: uniform(0),
    starIntensity: uniform(0),
    cloudCoverage: uniform(0),
    cloudDensity: uniform(0.5),
    cirrus: uniform(0),
    cloudLight: uniform(new THREE.Color(1, 1, 1)),
    cloudShadow: uniform(new THREE.Color(0.35, 0.36, 0.4)),
    /** Tiles per metre, and the drift accumulated by the wind. */
    cloudScale: uniform(1 / 5200),
    cloudOffset: uniform(new THREE.Vector2()),
    cirrusOffset: uniform(new THREE.Vector2()),
    /** Lightning: a whole-sky additive spike, brightest inside the cloud. */
    flash: uniform(0),
    fogColor: uniform(new THREE.Color(0.5, 0.5, 0.55)),
    fogAmount: uniform(0),
    /** Author's overall gain on the picture. Never on the light. */
    exposure: uniform(1),
  };
}

/** Ties the model's equirect texture into the graph. Call once per texture. */
export function setSkyMap(uniforms, map) {
  uniforms.map = map;
  uniforms.mapNode = texture(map);
  return uniforms;
}

/** Rodrigues rotation — the stars turn about the celestial pole. */
const rotateAbout = /*@__PURE__*/ Fn(([vector, axis, angle]) => {
  const c = cos(angle), s = sin(angle);
  return vector.mul(c).add(axis.cross(vector).mul(s)).add(axis.mul(axis.dot(vector).mul(float(1).sub(c))));
});

/** One fetch: the four baked octaves, weighted. */
const cloudTap = /*@__PURE__*/ Fn(([uvNode]) => dot(texture(getCloudNoiseTexture()).sample(uvNode), OCTAVE_WEIGHTS));

/**
 * Eight octaves in two fetches (see `cloudNoise.js`), at incommensurate scales
 * so the 128-texel tile never reads as a grid.
 */
export const cloudFbm = /*@__PURE__*/ Fn(([uvNode]) => {
  const a = cloudTap(uvNode);
  const b = cloudTap(uvNode.mul(0.31).add(vec2(3.7, 1.9)));
  return a.mul(0.62).add(b.mul(0.38));
});

/**
 * Where a view ray crosses a horizontal layer, in tile coordinates.
 *
 * ⚠ THE HORIZON IS WHERE EVERY CLOUD PLANE FALLS APART: `t` grows without
 * bound as the ray flattens, so the texture coordinate runs at an unbounded
 * rate and the layer aliases into noise. Two defences, both free: the density
 * fades out over the last few degrees, and the texture keeps its mip chain —
 * the GPU's own derivative picks the top mip down there, which is the layer's
 * average, which is exactly what distance should look like.
 */
const layerUv = /*@__PURE__*/ Fn(([direction, altitude, scale, offset]) => {
  const t = min(altitude.div(max(direction.y, 0.02)), 90000);
  // ⚠ THE CAMERA'S OWN POSITION BELONGS IN HERE. Without it the field is
  // anchored to the viewer: the whole deck travels with you, so walking a
  // kilometre never brings a different cloud overhead and the sun's occlusion
  // (computed in world space on the CPU) disagrees with the picture.
  return cameraPosition.xz.add(direction.xz.mul(t)).mul(scale).add(offset);
});

/**
 * ⭐ COVERAGE IS A QUANTILE, NOT A NUMBER YOU SUBTRACT.
 *
 * The field is a sum of octaves, so it is roughly normal about 0.47 with a
 * standard deviation of 0.096 — NOT uniform over [0,1]. A linear
 * coverage-to-threshold map is therefore wrong at both ends and wrong in the
 * middle: it left isolated round blobs at low coverage (the user's "random
 * colour circles") and a solid lid by 0.6, where a "cloudy" day should still
 * be more sky than cloud. This cubic is a least-squares fit to the field's own
 * measured quantile curve, so `cloudCover: 0.3` really does cover about 30 %
 * of the sky. The extra push near 1 closes the last holes, which the fit
 * cannot do because the distribution's tail is longer than a cubic.
 */
export const CLOUD_QUANTILE = [0.6774, -0.8659, 1.4382, -1.0065];

/** The field value above which cloud exists, for a given coverage. Exported so
 *  the cloud SHADOW on the ground is thresholded identically to the cloud in
 *  the sky — two formulas would be two different skies. */
export const cloudThreshold = /*@__PURE__*/ Fn(([coverage]) => float(CLOUD_QUANTILE[0])
  .add(coverage.mul(CLOUD_QUANTILE[1]))
  .add(coverage.mul(coverage).mul(CLOUD_QUANTILE[2]))
  .add(coverage.mul(coverage).mul(coverage).mul(CLOUD_QUANTILE[3]))
  .sub(smoothstep(0.88, 1.0, coverage).mul(0.35)));

/** Edge hardness for a given cloud density — shared for the same reason. */
export const cloudHardness = /*@__PURE__*/ Fn(([density]) => mix(float(5.5), float(11), density));

/** Henyey-Greenstein: the forward lobe that puts a silver lining on a cloud
 *  the sun is behind. */
const henyeyGreenstein = /*@__PURE__*/ Fn(([cosAngle, g]) => {
  const gg = g.mul(g);
  const denominator = float(1).add(gg).sub(g.mul(2).mul(cosAngle)).max(1e-4);
  // Normalised over the sphere: peaks at ~1.75 for g = 0.72 and bottoms at
  // ~0.008. Leaving the 4π out (as the first cut did) makes the peak 22 and
  // every cloud edge a white blowout.
  return float(1).sub(gg).div(denominator.mul(denominator.sqrt()).mul(4 * Math.PI));
});

/**
 * The background colour for one view direction. Returns linear RGB in the
 * engine's light units — the same units `skyModel.js` normalises the dome to.
 */
export function skyColorNode(u) {
  return Fn(() => {
    // The direction the background sphere's vertex points, which is what
    // three's own equirect background uses. Not `positionWorld`: the
    // background mesh is drawn with a custom vertex node at the far plane.
    const direction = positionWorldDirection.toVar();
    const up = direction.y;

    // Bisect hatches for the spot hunt, read at graph-build time.
    if ((globalThis.__atmosphereSkip ?? "").includes("constant")) return vec3(0.2, 0.4, 0.8);
    if ((globalThis.__atmosphereSkip ?? "").includes("dome")) return u.mapNode.sample(equirectUV(direction)).rgb;
    // ── THE DOME ──────────────────────────────────────────────────────────
    const color = u.mapNode.sample(equirectUV(direction)).rgb.toVar();
    // Declared out here because the lightning flash reads it after the
    // cloud branch has closed.
    const cloudAlpha = float(0).toVar();

    // ── STARS ─────────────────────────────────────────────────────────────
    // Bisect hatches, read at GRAPH BUILD time (the node is built once, when
    // the sky is installed), so they must be set before the scene boots.
    const skip = globalThis.__atmosphereSkip ?? "";
    if (!skip.includes("stars")) {
    // ⭐ BRANCHED, NOT MULTIPLIED OUT. `starIntensity` is 0 by day, so the
    // lattice's result vanishes — but every hash and every rotation still RUNS
    // for every pixel of every daytime frame. The condition is a uniform, so
    // the whole warp takes the same side of it and the branch is free.
    If(u.starIntensity.greaterThan(0.001), () => {
    const starred = rotateAbout(direction, u.starAxis, u.starAngle);
    const cell = starred.mul(STAR_DENSITY);
    const cellIndex = floor(cell);
    const seed = cellIndex.x.mul(157).add(cellIndex.y.mul(4331)).add(cellIndex.z.mul(97)).add(STAR_SEED_BIAS);
    const starPresent = smoothstep(0.962, 0.985, hash(seed));
    const offset = vec3(hash(seed.add(1)), hash(seed.add(2)), hash(seed.add(3)));
    const distance = cell.sub(cellIndex).sub(offset).length();
    // Twinkle is real — it is the atmosphere, not the star — and it is what
    // stops a static lattice reading as a texture.
    const twinkle = float(0.65).add(sin(hash(seed.add(4)).mul(90).add(u.starAngle.mul(220))).mul(0.35));
    const star = smoothstep(0.012, 0.075, distance).oneMinus().mul(starPresent).mul(twinkle).mul(u.starIntensity);
    // Warm and cool stars from the same hash: a field of identical white
    // points is the tell that says "procedural".
    // ⚠ NEARLY WHITE. The first cut ran the tint from orange to blue at full
    //   saturation and a night sky came out as coloured confetti.
    const starTint = mix(vec3(1.0, 0.94, 0.86), vec3(0.88, 0.93, 1.0), hash(seed.add(5)));
    color.addAssign(starTint.mul(star).mul(smoothstep(-0.02, 0.06, up)));
    });
    }

    // ── SUN ───────────────────────────────────────────────────────────────
    if (!skip.includes("sun")) {
    // Chord length rather than an angle: `acos(dot)` loses its precision
    // exactly where a 0.5° disc lives, and |a - b| ≈ the angle for small ones.
    const sunOffset = direction.sub(u.sunDirection).length();
    const inSun = smoothstep(SUN_RADIUS * 0.86, SUN_RADIUS, sunOffset).oneMinus();
    const limb = float(1).sub(pow(min(sunOffset.div(SUN_RADIUS), 1), 2).mul(0.35));
    color.addAssign(u.sunDisc.mul(inSun).mul(limb));
    }

    // ── MOON ──────────────────────────────────────────────────────────────
    if (!skip.includes("moon")) {
    // A lit sphere, not a disc: build its local frame, lift the fragment onto
    // the sphere and light it with the real sun direction. That is what puts
    // the crescent's horns on the correct side of the sky — the one lunar
    // detail everybody notices and no curve can fake.
    const moonOffset = direction.sub(u.moonDirection).length();
    const inMoon = smoothstep(MOON_RADIUS * 0.94, MOON_RADIUS, moonOffset).oneMinus();
    const right = u.moonDirection.cross(vec3(0, 1, 0)).normalize().toVar();
    const upAxis = right.cross(u.moonDirection).normalize();
    const toFragment = direction.sub(u.moonDirection);
    const du = dot(toFragment, right).div(MOON_RADIUS);
    const dv = dot(toFragment, upAxis).div(MOON_RADIUS);
    const height = max(float(1).sub(du.mul(du)).sub(dv.mul(dv)), 0).sqrt();
    const normal = right.mul(du).add(upAxis.mul(dv)).add(u.moonDirection.mul(height)).normalize();
    // A little ambient so the dark limb is a silhouette rather than a hole.
    const lit = max(dot(normal, u.sunDirection), 0).mul(0.97).add(0.03);
    color.addAssign(u.moonDisc.mul(inMoon).mul(lit));
    }

    // ── CLOUD ─────────────────────────────────────────────────────────────
    // ⭐ A SLAB IN SLICES, NOT A THRESHOLD ON A PLANE.
    //
    // The first cut was one plane with `smoothstep(edge, edge+w, fbm)`. Two
    // things were wrong with it and the user saw both: the fbm is a sum of
    // four octaves, so it is roughly Gaussian about 0.5 — at low coverage the
    // threshold sits out in the 1 % tail and the only survivors are small
    // ROUND ISOLATED BLOBS ("random colour circles in the sky"), and a single
    // plane has no interior, so there is nothing to shade and the sky reads
    // flat however pretty the gradient behind it is.
    //
    // So the deck is sampled at several heights and composited front to back.
    // That costs a few more taps and buys the three things that make a cloud
    // look like a cloud: PARALLAX (the slices slide against each other as the
    // camera turns), SELF-SHADOWING (each slice reads the field again towards
    // the sun, so the undersides go dark and the tops stay lit), and a
    // FORWARD-SCATTERING lobe, which is what a silver lining actually is.
    // ⭐⭐ AND THE WHOLE DECK IS BRANCHED TOO, on two conditions that between
    // them cover most frames: there is no cloud to draw when coverage is zero
    // (a uniform — the entire draw takes one side), and there is none BELOW
    // THE HORIZON either, which in an ordinary view is half the screen and in
    // an interior is all of it. Measured at 400×250 with a cloudy sky filling
    // the frame, the slab is 0.54 ms; the branch is what stops that being paid
    // by pixels that could never have shown a cloud.
    const horizon = smoothstep(0.02, 0.16, up);
    If(u.cloudCoverage.greaterThan(0.015).and(up.greaterThan(0.0)), () => {
    const baseUv = layerUv(direction, float(CLOUD_BASE), u.cloudScale, u.cloudOffset);
    // One low-frequency warp tap, shared by every slice: the difference
    // between "noise, thresholded" and something with billow to it.
    const warp = cloudTap(baseUv.mul(0.17)).sub(0.5).mul(0.55);
    // Coverage is a quantile of the field — see `cloudThreshold`.
    const threshold = cloudThreshold(u.cloudCoverage).toVar();
    // Harder edges than the first cut: with the field's 0.096 standard
    // deviation, 3.2 spread a cloud's edge over three of them and the deck read
    // as haze — at 5.5 a 'cloudy' sky is actually cloudy.
    const hardness = cloudHardness(u.cloudDensity).toVar();
    // ⚠ THE FLOOR IS WHAT KEEPS A NEARLY-CLEAR SKY EMPTY. Below it the deck
    // fades out completely rather than leaving the few brightest blobs of the
    // field behind — those isolated survivors are the "colour spots".
    const cloudPresent = smoothstep(0.06, 0.18, u.cloudCoverage).mul(horizon).toVar();
    const forward = max(dot(direction, u.sunDirection), 0);
    // Two lobes: a tight forward one for the rim, a broad one for the body.
    const phase = henyeyGreenstein(forward, float(0.72)).mul(0.7)
      .add(henyeyGreenstein(forward, float(0.2)).mul(0.3)).toVar();

    const cloudColor = vec3(0).toVar();
    for (let slice = 0; slice < CLOUD_SLICES; slice++) {
      // Bottom slice first: the viewer is underneath, so front-to-back is
      // simply upwards, and the near slices occlude the far ones correctly.
      const height = (slice + 0.5) / CLOUD_SLICES;
      const altitude = CLOUD_BASE + (CLOUD_TOP - CLOUD_BASE) * height;
      // Higher slices scroll fractionally faster — the shear that stops a
      // stack of layers from reading as one flat sheet.
      const uvNode = layerUv(direction, float(altitude), u.cloudScale, u.cloudOffset.mul(1 + height * 0.35));
      const shape = cloudFbm(uvNode.add(warp));
      // A cumulus profile: flat-bottomed, billowing through the middle,
      // thinning out to wisps at the top.
      const profile = Math.min(1, 0.35 + height * 2.2) * (1 - Math.max(0, height - 0.45) * 1.5);
      const density = shape.mul(profile).sub(threshold).mul(hardness).clamp(0, 1).toVar();
      // Self-shadowing: read the field again one step towards the sun and a
      // little higher — what the sunlight had to pass through to get here.
      const occlusion = cloudTap(uvNode.add(warp).add(u.sunDirection.xz.mul(0.09 + 0.05 * height)))
        .mul(profile).sub(threshold).mul(hardness).clamp(0, 1);
      const lit = occlusion.mul(2.1).negate().exp();               // Beer
      // Powder: the darkening at the very edge of a lit cloud, which is what
      // stops a cloud from looking like cotton wool.
      const powder = float(1).sub(density.mul(2.4).negate().exp());
      const slab = mix(u.cloudShadow, u.cloudLight.mul(phase.mul(0.55).add(0.75)), lit.mul(powder));
      const contribution = density.mul(cloudPresent).mul(float(1).sub(cloudAlpha));
      cloudColor.addAssign(slab.mul(contribution));
      cloudAlpha.addAssign(contribution);
    }

    // Cirrus: higher, thinner, stretched by the wind into streaks. Composited
    // UNDER the cumulus because it is above it — a high cloud is behind a low
    // one from down here.
    const cirrusUv = layerUv(direction, float(7200), u.cloudScale.mul(0.55), u.cirrusOffset);
    const cirrusShape = cloudFbm(vec2(cirrusUv.x.mul(0.32), cirrusUv.y.mul(1.8)));
    const cirrusMask = smoothstep(0.5, 0.8, cirrusShape).mul(u.cirrus).mul(horizon).mul(0.6);
    color.assign(mix(color, u.cloudLight.mul(phase.mul(0.35).add(0.85)), cirrusMask));
    color.assign(mix(color, cloudColor.div(max(cloudAlpha, 0.001)), cloudAlpha));
    });

    // ── LIGHTNING ─────────────────────────────────────────────────────────
    // Brightest inside the deck — that is where the discharge is — with
    // enough spill to light the clear sky around it.
    color.addAssign(vec3(0.62, 0.68, 0.9).mul(u.flash).mul(cloudAlpha.mul(2.2).add(0.35)));

    // ── FOG SWALLOWS THE HORIZON ──────────────────────────────────────────
    // three's fog never touches the background, so without this the sky stays
    // crisp above a scene that has vanished into fog and the horizon reads as
    // a cut-out. It blends into the very colour the fog was given.
    if (!skip.includes("fog")) {
      const fogBand = smoothstep(-0.04, 0.34, up).oneMinus().mul(u.fogAmount);
      color.assign(mix(color, u.fogColor, fogBand));
    }

    return color.mul(u.exposure);
  })();
}
