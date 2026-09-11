/**
 * ⭐⭐ ONE SKY, EVALUATED ON THE CPU, READ BY EVERYTHING.
 *
 * The sky is not only a picture. In this engine it is also:
 *   · the scene's image-based light (`scene.environment`),
 *   · what a GI ray brings back when it escapes (giConfig's `sceneSkyRadiance`
 *     and the per-bin tables in `srcSkyBins.js`),
 *   · the colour and brightness of the sun's directional light,
 *   · the colour of the fog.
 *
 * ⛔ THE TRAP THIS FILE EXISTS TO AVOID: computing those from four different
 * approximations. A sunset whose sky is orange, whose sun light is white and
 * whose fog is grey is the single most common way a procedural sky reads as
 * fake, and it is what happens when the shader owns the look and the lights
 * own a curve someone tuned separately. So the model is CPU-side and
 * authoritative: it fills a small equirect texture (which IS the environment
 * map, and which GI's sky bins can read because it is a half-float
 * `DataTexture` — see `describeSkySource`), and the same functions hand back
 * the light and fog colours derived from the very same radiance field.
 *
 * ⚠ AND THE CLOUDS IN HERE ARE ANALYTIC, NOT THE SHADER'S NOISE. Per-direction
 * cloud detail in the environment map would change every texel every frame,
 * which (a) re-triggers GI's ~15 ms sky-bin integration continuously and
 * (b) makes the indirect light flicker as clouds drift — against the project's
 * standing "no noise, no steps" gate. What clouds do to the LIGHT is take the
 * sun away and give it back as a bright grey dome, and that is a smooth
 * function of coverage, density and elevation. The visible cloud shapes live
 * in `skyNode.js`, on the pixels, where they cost nothing to the light.
 *
 * Model: Preetham et al. 1999 ("A Practical Analytic Model for Daylight") for
 * the daytime dome, extended below the horizon by a twilight-and-moon term,
 * and normalised so the hemisphere's irradiance matches a physical-ish target
 * rather than Preetham's kcd/m² (which overshoots and has no relationship to
 * a renderer's exposure).
 *
 * No `three` import — the caller wraps the returned typed array in a
 * `DataTexture`. That keeps this testable under bare Node.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

/**
 * ⭐ THE ONE CALIBRATION CONSTANT. Every other brightness in this module is a
 * ratio against it, so raising it brightens the whole day coherently — sun,
 * sky, cloud and fog together — instead of pulling the picture apart.
 * Chosen to sit where a three.js `DirectionalLight` looks like midday sun
 * under the engine's default neutral tone mapping at exposure 1.
 */
export const SUN_PEAK = 3.6;
/** Full-moon light, as a fraction of `SUN_PEAK`. Physically it is 4e-6 — a
 *  ratio no display can show — so this is the honest game cheat: about 1/70th
 *  of the midday sun, which is dark enough to read as night and bright enough
 *  to cast the soft shadow a full moon actually casts. `nightLight` scales it. */
const MOON_PEAK = 0.02;
/** Clear-sky hemispherical irradiance at zenith sun, as a fraction of SUN_PEAK. */
const SKY_CLEAR_FRACTION = 0.24;

/** Rayleigh optical depth at sea level, zenith, per RGB band. */
const TAU_RAYLEIGH = [0.0685, 0.1015, 0.2545];
/** Aerosol wavelength dependence, Ångström exponent 1.3, per RGB band. */
const MIE_BAND = [0.86, 1.0, 1.21];

/** xyY chromaticity of the night sky and of moonlight — cool, never neutral. */
const NIGHT_COLOR = [0.055, 0.09, 0.19];
const MOON_COLOR = [0.62, 0.72, 1.0];

/** CIE XYZ to linear sRGB. */
function xyzToRgb(X, Y, Z, out) {
  out[0] = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  out[1] = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  out[2] = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return out;
}

/** Preetham's five distribution coefficients for each of Y, x and y. */
function perezCoefficients(turbidity) {
  const T = turbidity;
  return {
    Y: [0.1787 * T - 1.463, -0.3554 * T + 0.4275, -0.0227 * T + 5.3251, 0.1206 * T - 2.5771, -0.067 * T + 0.3703],
    x: [-0.0193 * T - 0.2592, -0.0665 * T + 0.0008, -0.0004 * T + 0.2125, -0.0641 * T - 0.8989, -0.0033 * T + 0.0452],
    y: [-0.0167 * T - 0.2608, -0.095 * T + 0.0092, -0.0079 * T + 0.2102, -0.0441 * T - 1.6537, -0.0109 * T + 0.0529],
  };
}

/** Zenith luminance (relative) and chromaticity for a sun at `thetaS`. */
function zenithValues(turbidity, thetaS) {
  const T = turbidity, t = thetaS, t2 = t * t, t3 = t2 * t;
  const chi = (4 / 9 - T / 120) * (Math.PI - 2 * t);
  const Y = (4.0453 * T - 4.971) * Math.tan(chi) - 0.2155 * T + 2.4192;
  const x =
    (0.00166 * t3 - 0.00375 * t2 + 0.00209 * t) * T * T +
    (-0.02903 * t3 + 0.06377 * t2 - 0.03202 * t + 0.00394) * T +
    (0.11693 * t3 - 0.21196 * t2 + 0.06052 * t + 0.25886);
  const y =
    (0.00275 * t3 - 0.0061 * t2 + 0.00317 * t) * T * T +
    (-0.04214 * t3 + 0.0897 * t2 - 0.04153 * t + 0.00516) * T +
    (0.15346 * t3 - 0.26756 * t2 + 0.0667 * t + 0.26688);
  return { Y: Math.max(0, Y), x, y };
}

/** F(theta, gamma) — the Perez distribution itself. */
function perez(cosTheta, gamma, cosGamma, c) {
  return perezTheta(cosTheta, c) * (1 + c[2] * Math.exp(c[3] * gamma) + c[4] * cosGamma * cosGamma);
}

/** The half of the distribution that depends only on the view's ELEVATION.
 *  Hoisted because an equirect fill shares it across a whole row — three of
 *  the six exponentials per texel, gone. */
function perezTheta(cosTheta, c) {
  return 1 + c[0] * Math.exp(c[1] / Math.max(0.02, cosTheta));
}

/**
 * Everything in the model that depends on the view's ELEVATION and nothing
 * else. Pass the result back in for every texel of one equirect row.
 *
 * ⭐ THE CLOUD SLAB IS IN HERE, and that is not an optimisation detail: its
 * `(1 - coverage) ** grazing` is a fractional `Math.pow`, which is ~100 ns,
 * and per texel it cost more than the whole Perez evaluation. Measured on the
 * first cut: a sunset fill took 18.5 ms against noon's 1.6 ms, entirely in
 * `Math.pow` calls whose arguments were constant along the row.
 */
export function skyRowTerms(cosTheta, p, out = new Float64Array(5)) {
  out[0] = perezTheta(cosTheta, p.coefficients.Y);
  out[1] = perezTheta(cosTheta, p.coefficients.x);
  out[2] = perezTheta(cosTheta, p.coefficients.y);
  const upper = Math.max(0, cosTheta);
  // Beer's law in the CLEAR fraction along a slab path that lengthens towards
  // the horizon — why an overcast sky is greyest at the horizon and keeps its
  // colour longest at the zenith.
  const grazing = clamp(0.38 / Math.max(upper, 0.035), 1, 3.2);
  out[3] = p.coverage > 0.001
    ? clamp01(1 - Math.pow(1 - clamp01(p.coverage * 0.995), grazing)) * (0.45 + 0.55 * p.density)
    : 0;
  // CIE standard overcast distribution (the zenith is three times the
  // horizon), times the grazing brightening. Without it a full overcast reads
  // as a flat grey card.
  out[4] = ((1 + 2 * upper) / 3) * (0.75 + 0.25 * grazing);
  return out;
}

/**
 * Kasten-Young relative air mass. The reason a low sun is red: at 1° the beam
 * travels ~38 atmospheres, and blue is gone long before red is.
 */
export function airMass(sinAltitude) {
  const altitudeDeg = Math.asin(clamp(sinAltitude, -1, 1)) * 180 / Math.PI;
  if (altitudeDeg < -3) return 40;
  return 1 / (Math.max(0.0001, sinAltitude) + 0.50572 * Math.pow(Math.max(0.5, altitudeDeg + 6.07995), -1.6364));
}

/** Beam transmittance per RGB band through `mass` atmospheres. */
export function beamTransmittance(mass, turbidity, out = [0, 0, 0]) {
  const aerosol = 0.04 * Math.max(0, turbidity - 1);
  for (let c = 0; c < 3; c++) {
    out[c] = Math.exp(-mass * (TAU_RAYLEIGH[c] + aerosol * MIE_BAND[c]));
  }
  return out;
}

const LUMA = [0.2126, 0.7152, 0.0722];
const luminance = (rgb) => rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];

/**
 * Everything the per-direction evaluation needs, computed once per sky update.
 *
 * @param {object} input
 * @param {number[]} input.sunDirection    unit vector towards the sun
 * @param {number[]} [input.moonDirection] unit vector towards the moon
 * @param {number} [input.moonIllumination] 0…1 lit fraction of the moon's disc
 * @param {object} [input.weather]         a blended weather vector
 * @param {number} [input.nightLight]      author's night brightness, 1 = default
 * @param {number} [input.intensity]       author's overall sky gain
 */
export function skyParameters({
  sunDirection = [0, 1, 0],
  moonDirection = [0, -1, 0],
  moonIllumination = 1,
  weather = {},
  nightLight = 1,
  intensity = 1,
} = {}) {
  const sunY = clamp(sunDirection[1], -1, 1);
  const moonY = clamp(moonDirection[1], -1, 1);
  const turbidity = clamp(weather.turbidity ?? 2.4, 1.8, 12);
  const coverage = clamp01(weather.cloudCover ?? 0);
  const density = clamp01(weather.cloudDensity ?? 0.5);
  // ⭐ ONE NUMBER FOR "HOW MUCH SKY THE CLOUD TOOK". Coverage alone is not it:
  // a sky fully covered by thin fair-weather cumulus is still bright.
  const cloudOpacity = coverage * (0.4 + 0.6 * density);

  // Day / twilight / night weights. The sun's disc is 0.53° across, but the
  // sky keeps changing for another 12° after it sets, which is why these
  // edges are so far apart: civil twilight is -6°, and the last colour is
  // gone by about -12°.
  const dayWeight = smoothstep(-0.07, 0.09, sunY);       // -4° … +5°
  const twilight = smoothstep(-0.21, 0.02, sunY) * (1 - dayWeight);

  // Preetham is a daytime model; below about 3° its zenith term runs away, so
  // the SHAPE is evaluated at a clamped sun and the FADE is done by weight.
  const thetaS = Math.acos(clamp(sunY, Math.cos(87 * Math.PI / 180) * 0 + 0.052, 1));
  const coefficients = perezCoefficients(turbidity);
  const zenith = zenithValues(turbidity, thetaS);
  const cosThetaS = Math.max(0.052, sunY);
  const denominator = {
    Y: perez(1, thetaS, cosThetaS, coefficients.Y),
    x: perez(1, thetaS, cosThetaS, coefficients.x),
    y: perez(1, thetaS, cosThetaS, coefficients.y),
  };

  // Beam transmittance towards each body: the light colours, and the tint the
  // twilight glow inherits.
  const sunTransmittance = beamTransmittance(airMass(sunY), turbidity);
  const moonTransmittance = beamTransmittance(airMass(moonY), turbidity);

  const sunBeam = luminance(sunTransmittance);
  const moonUp = clamp01(moonY * 4);
  const moonTerm = clamp01(moonIllumination) * moonUp * Math.max(0, nightLight);

  // ── THE IRRADIANCE TARGET ────────────────────────────────────────────────
  // What the whole dome must add up to, in the engine's own light units. The
  // fill normalises the Preetham field to hit exactly this, which is what
  // keeps "sky vs sun" honest across the day and under cloud.
  const above = clamp01(sunY);
  const directLuminance = SUN_PEAK * sunBeam * clamp01(weather.sunLight ?? 1);
  // ⭐⭐ THE SKY DOES NOT SWITCH OFF WHEN THE SUN CROSSES THE HORIZON.
  //
  // `clamp01(sunY)` is the right factor for the BEAM — a sun below the horizon
  // sends none — but using it for the sky's own light said that a sunset sky is
  // black, which is plainly false: civil twilight is a bright blue, and at 58°
  // N in July the sun never gets more than a few degrees under, so the "night"
  // is a white night. The user's scene sat at 2 a.m. with a new moon below the
  // horizon and measured a sky irradiance of 0.009 and a sun of exactly 0 —
  // reported, twice, as "night is pitch black". This offset keeps ~15 % of the
  // sky's brightness at the horizon and takes it to zero at about -10°, which
  // is where astronomical night actually begins.
  const skyAbove = clamp01((sunY + 0.17) / 1.17);
  const clearDiffuse = SKY_CLEAR_FRACTION * SUN_PEAK * Math.pow(skyAbove, 0.45);
  // ⚠ THE CLOUD DECK IS NOT A MIRROR POINTED AT THE GROUND. The light it takes
  // from the beam comes back as a bright dome — but most of it goes back to
  // SPACE, and how much depends on thickness. Without this factor a
  // thunderstorm came out brighter than the clear noon it replaced (measured:
  // sky irradiance 1.75 vs 0.84), which is the opposite of a storm.
  const cloudTransmission = 1 - 0.85 * density;
  const dayIrradiance = clearDiffuse * (1 - 0.55 * cloudOpacity)
    + SUN_PEAK * sunBeam * above * 0.45 * cloudOpacity * cloudTransmission;
  // ⚠ THE DAY-TO-NIGHT RATIO IS THE WHOLE FEELING OF A NIGHT SCENE, and it has
  // now been wrong in both directions. The first cut put it at 15:1 — a
  // full-moon night lit like an overcast afternoon. The correction went to
  // ~340:1 for a moonless night, which the user reported as "night is pitch
  // black": physically defensible, and useless in a game, where a night the
  // player cannot see into is a black screen rather than a night. ~45:1 under
  // a full moon and ~110:1 under none keeps silhouettes and a horizon while
  // staying unmistakably night; `nightLight` scales it per scene.
  const nightIrradiance = Math.max(0, nightLight) * (0.008 + 0.011 * moonTerm);
  // ⚠ THE LARGER OF THE TWO, not a blend weighted by how far up the sun is.
  // The old mix collapsed to the night floor the moment the sun dipped below
  // -4°, throwing away the twilight the term above now carries.
  const target = Math.max(1e-4, Math.max(nightIrradiance, dayIrradiance) * Math.max(0, intensity));

  const p = {
    sunDirection: [sunDirection[0], sunY, sunDirection[2]],
    moonDirection: [moonDirection[0], moonY, moonDirection[2]],
    sunY, moonY, turbidity, coverage, density, cloudOpacity,
    dayWeight, twilight,
    // ⛔ NOT `clamp01`. The property is documented 0…3 and the user had set 3
    // to fight a dark night; clamping it to 1 here made that control do nothing.
    nightLight: Math.max(0, nightLight),
    intensity: Math.max(0, intensity),
    coefficients, zenith, denominator,
    sunTransmittance, moonTransmittance, moonTerm, moonIllumination: clamp01(moonIllumination),
    directLuminance, target,
    // Filled in below — Preetham's kcd/m² into the engine's light units.
    preethamGain: 1,
    twilightGain: SKY_CLEAR_FRACTION * SUN_PEAK * 0.55,
    // The cloud deck's own colour: sunlit grey by day, deep grey at night,
    // and never pure white — a cloud reflects ~70 % and the underside less.
    cloudLight: cloudLighting(sunTransmittance, sunBeam, above, dayWeight, density, moonTerm, nightLight),
    // Filled by `fillSkyEquirect`, which is the only thing that can measure it.
    horizon: [0, 0, 0],
    irradiance: [0, 0, 0],
  };

  // ── PREETHAM INTO ENGINE UNITS ───────────────────────────────────────────
  // A 16×8 pre-pass over the DAY TERM ALONE (`_rawOnly`), so the gain that
  // brings Preetham's kcd/m² down to a light intensity is known before any
  // term authored in light intensities is mixed into it. The reference uses a
  // sun no lower than ~3°, or a sky whose day term has all but vanished would
  // ask for an unbounded gain and then leak it through the night mix's floor.
  p._rawOnly = true;
  const raw = sampleSkyIrradiance(p, 16, 8);
  p._rawOnly = false;
  const reference = SKY_CLEAR_FRACTION * SUN_PEAK * Math.pow(Math.max(above, 0.05), 0.45);
  p.preethamGain = clamp(reference / Math.max(1e-5, luminance(raw)), 1e-6, 1e4);
  return p;
}

function cloudLighting(sunTransmittance, sunBeam, above, dayWeight, density, moonTerm, nightLight) {
  // The lit top of the deck; the underside is this times the shading term in
  // `skyRadiance`. Denser cloud is a DARKER underside, not a brighter one.
  const lit = SUN_PEAK * 0.11 * sunBeam * Math.pow(above, 0.35) * (1 - 0.45 * density);
  const night = 0.006 * Math.max(0, nightLight) * (0.35 + 0.65 * moonTerm);
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const day = lit * mix(1, sunTransmittance[c] / Math.max(1e-4, sunBeam), 0.35);
    out[c] = mix(night * MOON_COLOR[c], day, dayWeight);
  }
  return out;
}

/**
 * Radiance towards `(dx, dy, dz)`, in the engine's light units.
 *
 * ⚠ NO SUN DISC. The disc is drawn by the background shader and carried as
 * light by the directional light; putting it in the environment map as well
 * is the "second sun" this project has already shipped once (GI's §11.53 sun
 * extraction exists to undo exactly that). The Mie aureole around the sun IS
 * sky and stays.
 */
export function skyRadiance(dx, dy, dz, p, out = [0, 0, 0], rowTerms = null) {
  const cosTheta = clamp(dy, -1, 1);
  const cosGamma = clamp(dx * p.sunDirection[0] + dy * p.sunY + dz * p.sunDirection[2], -1, 1);
  const gamma = Math.acos(cosGamma);
  const upper = Math.max(0.0, cosTheta);

  // ── DAY ──────────────────────────────────────────────────────────────────
  const c = p.coefficients, z = p.zenith, d = p.denominator;
  const terms = rowTerms ?? skyRowTerms(cosTheta, p);
  const cosGamma2 = cosGamma * cosGamma;
  const Y = z.Y * (terms[0] * (1 + c.Y[2] * Math.exp(c.Y[3] * gamma) + c.Y[4] * cosGamma2)) / d.Y;
  const x = z.x * (terms[1] * (1 + c.x[2] * Math.exp(c.x[3] * gamma) + c.x[4] * cosGamma2)) / d.x;
  const y = z.y * (terms[2] * (1 + c.y[2] * Math.exp(c.y[3] * gamma) + c.y[4] * cosGamma2)) / d.y;
  const yy = Math.max(1e-4, y);
  const X = (x / yy) * Y;
  const Z = ((1 - x - y) / yy) * Y;
  xyzToRgb(X, Y, Z, out);
  // ⭐ INTO THE ENGINE'S LIGHT UNITS, HERE, BEFORE ANYTHING IS MIXED IN.
  // Preetham's luminance is kcd/m²; the twilight, night and cloud terms below
  // are authored in the same units as a light's intensity. Mixing the two and
  // normalising afterwards is what produced a storm whose fog colour came out
  // at 3.4 while its sky irradiance was 0.48 — the cloud was the only term in
  // the right units, so the normaliser scaled everything else up to meet it.
  const dayGain = p.preethamGain;
  for (let i = 0; i < 3; i++) out[i] = Math.max(0, out[i]) * dayGain;
  // The calibration pre-pass wants this term and nothing else.
  if (p._rawOnly) return out;

  // ── TWILIGHT ─────────────────────────────────────────────────────────────
  // The band of colour that survives after the sun has set: sunlight that has
  // travelled a very long way through the atmosphere, so it wears the beam's
  // own transmittance and hugs the horizon and the sun's azimuth.
  if (p.twilight > 0) {
    const band = clamp01(1 - Math.abs(cosTheta) * 2.2);
    const towards = clamp01(0.5 + 0.5 * cosGamma);
    // Integer powers by multiplication: `Math.pow` here was half the cost of a
    // sunset fill (see `skyRowTerms`).
    const glow = band * band * towards * towards * towards;
    for (let i = 0; i < 3; i++) {
      out[i] = mix(out[i], out[i] * 0.35 + p.sunTransmittance[i] * glow * p.twilightGain, 1 - p.dayWeight);
    }
  }

  // ── NIGHT ────────────────────────────────────────────────────────────────
  // Airglow plus the moon's own halo. Held below the day term rather than
  // added to it, so a bright day never carries a blue floor.
  const nightWeight = 1 - Math.max(p.dayWeight, p.twilight);
  if (nightWeight > 0) {
    const cosMoon = clamp01(dx * p.moonDirection[0] + dy * p.moonY + dz * p.moonDirection[2]);
    // Two lobes: a tight halo and the broad scatter that lights a whole clear
    // night sky when the moon is full. Integer powers by squaring.
    const m2 = cosMoon * cosMoon, m4 = m2 * m2, m8 = m4 * m4;
    const halo = m8 * m8 * m8 * 0.5 + m4 * 0.12;
    const zenithFade = 0.55 + 0.45 * upper;
    for (let i = 0; i < 3; i++) {
      const night = p.nightLight * (NIGHT_COLOR[i] * 0.055 * zenithFade + MOON_COLOR[i] * halo * p.moonTerm * 0.5);
      out[i] = mix(out[i], Math.max(out[i] * 0.02, night), nightWeight);
    }
  }

  // ── CLOUD ────────────────────────────────────────────────────────────────
  // The slab's opacity and shape come from `skyRowTerms` — both depend only
  // on elevation. See the header for why this is an analytic dome and not the
  // shader's noise.
  if (terms[3] > 0) {
    const alpha = terms[3] * clamp01(dy * 8 + 0.55);
    for (let i = 0; i < 3; i++) out[i] = mix(out[i], p.cloudLight[i] * terms[4], alpha);
  }

  // Below the horizon the "sky" is ground bounce: the same light, darkened
  // and desaturated. It matters because half of every probe's rays point down.
  if (dy < 0) {
    const below = clamp01(-dy * 2.4);
    const groundLuma = 0.22;
    for (let i = 0; i < 3; i++) out[i] = mix(out[i], out[i] * groundLuma + p.directLuminance * 0.02, below);
  }

  for (let i = 0; i < 3; i++) out[i] = Math.max(0, out[i]);
  return out;
}

// ── half-float packing ─────────────────────────────────────────────────────
// The environment texture is RGBA16F for two reasons that are both hard
// requirements: WebGPU cannot filter RGBA32F without an optional feature (a
// float32 sky would sample as blocky nearest-neighbour), and GI's
// `describeSkySource` accepts exactly float or half data textures.
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
export function floatToHalf(value) {
  _f32[0] = value;
  const bits = _u32[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0); // inf / nan
  exponent -= 127 - 15;
  if (exponent >= 0x1f) return sign | 0x7bff;                            // clamp to max
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign + ((mantissa + 0x1000) >>> 13);
  }
  // ⛔⛔ `+`, NEVER `|`, AND THIS ONE CHARACTER WAS THE "RANDOM COLOUR SPOTS".
  //
  // Rounding the mantissa up can CARRY out of it — `(mantissa + 0x1000) >>> 13`
  // is then 0x400, which is the exponent field's lowest bit and must be ADDED
  // to the exponent. OR-ing it works only while that bit is clear, i.e. while
  // the exponent is EVEN; for an odd exponent the carry lands on a bit that is
  // already 1 and disappears, leaving the exponent one too low — the value
  // comes back HALVED.
  //
  // So any channel of any texel that happened to sit just under a power-of-two
  // boundary with an odd exponent was written at half its brightness. One
  // channel of one texel, bilinearly smeared across ~3° of sky: a soft coloured
  // blob (green missing reads as purple) that moves as the sky changes.
  // Measured on the user's own settings: a green texel of 0.25 among neighbours
  // averaging 0.502, and a rendered pixel of 0.27 where the model said 0.497.
  //
  // It reached everything that reads this map — the picture, the IBL and GI's
  // sky bins — which is why the spots survived every attempt to find them in
  // the sky's own maths.
  return sign + (exponent << 10) + ((mantissa + 0x1000) >>> 13);
}

/**
 * The direction convention, spelled out once: three's `equirectUV` and GI's
 * `srcSkyBins` agree on u = atan2(z, x)/2π + ½, v = asin(y)/π + ½, and a
 * `DataTexture` with `flipY = false` puts v = 0 in row 0. Every loop below
 * therefore walks rows from the nadir up.
 */
export function equirectDirection(column, row, width, height, out = [0, 0, 0]) {
  const elevation = ((row + 0.5) / height - 0.5) * Math.PI;
  const azimuth = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
  const cosEl = Math.cos(elevation);
  out[0] = cosEl * Math.cos(azimuth);
  out[1] = Math.sin(elevation);
  out[2] = cosEl * Math.sin(azimuth);
  return out;
}

/**
 * Cosine-weighted irradiance of the upper hemisphere, from a coarse sample of
 * the model. Used to normalise the fill; also the honest answer to "how much
 * light is the sky giving" for anything that asks.
 */
export function sampleSkyIrradiance(p, width = 24, height = 12, out = [0, 0, 0]) {
  out[0] = out[1] = out[2] = 0;
  const direction = [0, 0, 0], radiance = [0, 0, 0];
  let weight = 0;
  for (let row = Math.floor(height / 2); row < height; row++) {
    const elevation = ((row + 0.5) / height - 0.5) * Math.PI;
    const cosEl = Math.cos(elevation), sinEl = Math.sin(elevation);
    if (sinEl <= 0) continue;
    // dω = cosEl dφ dθ, and the cosine of incidence on a horizontal surface
    // is sinEl — the two together are the row's whole weight.
    const rowWeight = cosEl * sinEl;
    for (let column = 0; column < width; column++) {
      equirectDirection(column, row, width, height, direction);
      skyRadiance(direction[0], direction[1], direction[2], p, radiance);
      for (let c = 0; c < 3; c++) out[c] += radiance[c] * rowWeight;
      weight += rowWeight;
    }
  }
  const scale = weight > 0 ? Math.PI / weight : 0;
  for (let c = 0; c < 3; c++) out[c] *= scale;
  return out;
}

/**
 * The normalising gain, the hemisphere's irradiance and the horizon colour —
 * everything the LIGHTS and the FOG need, without touching a texture.
 *
 * ⭐ THIS IS WHY THE SUN CAN MOVE SMOOTHLY WHILE THE SKY MAP UPDATES FOUR
 * TIMES A SECOND. Filling the equirect is the expensive half (~1.6 ms) and is
 * throttled; this half is ~150 model evaluations, about 20 µs, so it runs
 * EVERY frame and the light's colour, the fog and the cloud tint never step.
 * A stepping sun colour on a smoothly rotating sun is the exact artefact that
 * makes a day-night cycle read as a slideshow.
 */
export function measureSky(p) {
  const measured = sampleSkyIrradiance(p);
  // Normalise on LUMINANCE, never per channel: per-channel normalisation
  // would drive every sky towards neutral grey and delete the sunset.
  p.gain = p.target / Math.max(1e-6, luminance(measured));
  for (let c = 0; c < 3; c++) p.irradiance[c] = measured[c] * p.gain;

  // The fog's colour is the horizon's, so it is sampled where the fog is: a
  // ring at ~4° elevation, all the way round.
  const radiance = [0, 0, 0];
  const sum = [0, 0, 0];
  const RING = 12;
  const sinEl = 0.07, cosEl = Math.sqrt(1 - sinEl * sinEl);
  const rowTerms = skyRowTerms(sinEl, p);
  for (let i = 0; i < RING; i++) {
    const azimuth = (i / RING) * 2 * Math.PI;
    skyRadiance(cosEl * Math.cos(azimuth), sinEl, cosEl * Math.sin(azimuth), p, radiance, rowTerms);
    for (let c = 0; c < 3; c++) sum[c] += radiance[c];
  }
  for (let c = 0; c < 3; c++) p.horizon[c] = (sum[c] / RING) * p.gain;
  return p;
}

/**
 * Fills an RGBA half-float equirect with the sky at the gain `measureSky` set.
 *
 * ⭐ IT FILLS ROWS, NOT THE WHOLE TEXTURE. A full 128×64 costs ~1.6 ms warm
 * (a third of it in the half-float packing), and a 1.6 ms spike four times a
 * second is a tenth of the frame budget arriving as a hitch — against the
 * project's 60 fps floor. So the caller slices it: `{ rowStart, rowCount }`
 * fills a band and publishes the texture once the last band lands. Row order
 * is bottom-up (v = 0 is row 0), and a half-refreshed sky is a few rows of
 * very slightly older sun, which is invisible: the sun moves 0.004° a frame.
 *
 * @param {Uint16Array} data  RGBA16F texels, length width*height*4
 */
export function fillSkyEquirect(data, width, height, p, { rowStart = 0, rowCount = height } = {}) {
  const gain = p.gain ?? 1;
  const radiance = [0, 0, 0];
  const rowTerms = new Float64Array(5);
  const end = Math.min(height, rowStart + rowCount);

  for (let row = Math.max(0, rowStart); row < end; row++) {
    const elevation = ((row + 0.5) / height - 0.5) * Math.PI;
    const cosEl = Math.cos(elevation), sinEl = Math.sin(elevation);
    skyRowTerms(Math.max(0, sinEl), p, rowTerms);
    for (let column = 0; column < width; column++) {
      const azimuth = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
      skyRadiance(cosEl * Math.cos(azimuth), sinEl, cosEl * Math.sin(azimuth), p, radiance, rowTerms);
      const index = (row * width + column) * 4;
      data[index] = floatToHalf(radiance[0] * gain);
      data[index + 1] = floatToHalf(radiance[1] * gain);
      data[index + 2] = floatToHalf(radiance[2] * gain);
      data[index + 3] = 0x3c00; // 1.0
    }
  }
  if (end >= height) p.complete = true;
  return p;
}

/**
 * The scene's one shadow-casting celestial light.
 *
 * ⭐ ONE LIGHT, NOT TWO. A second directional light for the moon would double
 * every shadow map and every GI light slot for a body that is 400 000 times
 * dimmer than the sun; instead the sun's own light hands over to the moon at
 * dusk, when both are near zero and the swap cannot be seen. `body` says
 * which one is currently driving so the inspector and MCP can report it.
 */
export function celestialLight(p) {
  const sunFade = smoothstep(-0.035, 0.02, p.sunY);
  const sunIntensity = p.directLuminance * sunFade;
  const beam = Math.max(1e-4, luminance(p.sunTransmittance));
  const sunColor = [
    p.sunTransmittance[0] / beam, p.sunTransmittance[1] / beam, p.sunTransmittance[2] / beam,
  ];
  // Normalise the hue to a maximum of 1 so the light's colour never doubles
  // as a second intensity control.
  const peak = Math.max(sunColor[0], sunColor[1], sunColor[2], 1e-4);
  for (let c = 0; c < 3; c++) sunColor[c] /= peak;

  const moonIntensity = SUN_PEAK * MOON_PEAK * p.moonTerm * (1 - p.dayWeight)
    * luminance(p.moonTransmittance) * (0.3 + 0.7 * clamp01(1 - p.cloudOpacity * 0.8));
  const total = sunIntensity + moonIntensity;
  const sunShare = total > 1e-6 ? sunIntensity / total : (p.sunY > p.moonY ? 1 : 0);
  const direction = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    direction[c] = mix(p.moonDirection[c], p.sunDirection[c], sunShare);
  }
  // Renormalise: a lerp between two unit vectors is not one, and a light
  // direction that shortens as the two bodies oppose each other would tilt
  // the shadows without changing anything visible about the sky.
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  for (let c = 0; c < 3; c++) direction[c] /= length;

  const color = [0, 0, 0];
  for (let c = 0; c < 3; c++) color[c] = mix(MOON_COLOR[c], sunColor[c], sunShare);

  return {
    direction,
    color,
    intensity: total,
    body: sunShare >= 0.5 ? "sun" : "moon",
    sunIntensity,
    moonIntensity,
  };
}

/**
 * Fog colour: the horizon band of the very same sky, warmed slightly towards
 * the sun. Reading it off the model rather than authoring it is what stops
 * the "grey fog at sunset" tell.
 */
export function fogColor(p, out = [0, 0, 0]) {
  // ⚠ BOTH TERMS MUST BE IN THE NORMALISED SPACE. `horizon` comes out of the
  // filled texture (already gained); `cloudLight` is gained once by the fill.
  // Mixing a gained value with a raw one produced a fog colour of 9.7 under a
  // storm whose sky irradiance was 0.6 — a white wall instead of weather.
  for (let c = 0; c < 3; c++) {
    out[c] = Math.max(0, p.horizon[c] * (1 - 0.18 * p.cloudOpacity) + p.cloudLight[c] * 0.35 * p.cloudOpacity);
  }
  return out;
}
