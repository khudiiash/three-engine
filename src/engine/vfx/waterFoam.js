import {
  Fn, attribute, cameraFar, cameraNear, cameraPosition, float, linearDepth, mix, positionLocal, positionWorld,
  select, vec2, vec3, viewportDepthTexture,
} from "three/tsl";

/**
 * ══ WHAT A WATER SURFACE ADDS ON TOP OF BEING A MIRROR ═════════════════════
 *
 * Foam, fine-scale normals and subsurface scattering. All of them land on the
 * material slots `waterSurfaceLook.js` owns, which is why they are composed
 * there — three has exactly one `emissiveNode` and two modules writing it would
 * silently clobber each other.
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
const MAX_DETAIL_OCTAVES = 8;

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
 * The AUTHORED ladder: `waveOctaves` gates how many are live and `waveGain` is
 * the amplitude ratio between them, normalized so the total never moves.
 *
 * ⭐ THIS is where those two controls do visible work. On the HEIGHT field they
 * almost cannot: a 128² grid over ten metres has 7.6 cm cells, so every octave
 * past the fourth is at or below Nyquist and is faded out — "changing detail
 * octaves or octave falloff change nothing" (user, 2026-09-06) was the grid
 * saying so. Sub-cell structure exists only in the normal, so the ladder has to
 * reach the normal.
 *
 * ⭐ **AND IT IS BAND-LIMITED TO WHOEVER IS SAMPLING IT.** `cutoff` is a
 * wavelength in WORLD metres below which octaves fade out, exactly like
 * `waterWaves.js`'s `bandGain` on the height field. A fragment shader can leave
 * it unset — pixels are dense — but the caustic pass evaluates this once per
 * grid vertex, and an octave finer than the vertex spacing does not come back
 * as detail there: it comes back as an unrelated random slope at every vertex,
 * which the rasterizer turns into a floor full of thin random scratches ("too
 * low poly and unrealistic", user 2026-09-06). Fading those octaves makes the
 * lens as smooth as the grid that samples it, and the filaments that are left
 * are the ones a lens that size can actually make.
 */
const DETAIL_SCALE = 2.2;          // base octave ≈ 0.45 m
const DETAIL_STEP = .05;
function authoredFbm(p, time, u, cutoff = null) {
  let sum = float(0), weight = float(0), amplitude = float(1), scale = float(1);
  let wavelength = 1 / DETAIL_SCALE;
  for (let i = 0; i < MAX_DETAIL_OCTAVES; i++) {
    const c = Math.cos(ANGLES[i]), s = Math.sin(ANGLES[i]);
    let live = u.waveOctaves.sub(i).clamp(0, 1);
    if (cutoff) live = live.mul(float(2 * wavelength).div(cutoff.max(1e-4)).sub(1).clamp(0, 1));
    const share = amplitude.mul(live);
    const q = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))).mul(scale)
      .add(time.mul(SPEEDS[i]));
    sum = sum.add(valueNoise(q).mul(share));
    weight = weight.add(share);
    amplitude = amplitude.mul(u.waveGain);
    scale = scale.mul(2.07);
    wavelength /= 2.07;
  }
  return sum.div(weight.max(.02));
}

/**
 * ⭐ **THE DETAIL RUNS ON THE WAVES' CLOCK, NOT ON THE WALL.**
 *
 * `simTime` is elapsed seconds. The swell multiplies it by `waveSpeed`
 * (`waterWaves.js`'s `evaluate`) and the fine detail did not, so the two were
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
export function waterFoamNode(u) {
  // ⚠ WRAPPED IN `Fn`, AND IT HAS TO BE. `toVar()` and `addAssign` allocate on
  // the builder's STACK, and a node factory called straight from a material
  // build has no stack — "No stack defined for assign operation". Anything here
  // that declares a variable belongs inside one of these.
  return Fn(() => waterFoamBody(u))();
}
function waterFoamBody(u) {
  const p = worldXZ(u);
  const clock = waveClock(u);
  const drift = clock.mul(.5);

  // The solver's own foam, and the contact term.
  const simulated = attribute("waterFoam", "float").clamp(0, 1);
  const behind = linearDepth(viewportDepthTexture()).sub(linearDepth());
  const metres = behind.mul(cameraFar.sub(cameraNear)).max(0);
  // The width itself is modulated, so the shoreline is ragged rather than a
  // uniform ring offset from the geometry.
  const ragged = fbm(p.mul(.7), clock, .7);
  const width = u.foamThreshold.max(.02).mul(ragged.mul(1.1).add(.45));
  const contact = metres.smoothstep(width.mul(.15), width).oneMinus();
  const amount = simulated.max(contact.mul(.9)).toVar();

  // Patchiness: a slow, large fractal modulates the amount by ±25 % so the
  // sheet's edge and the web's density vary along a crest rather than
  // following the solver's cells.
  const patch = fbm(p.mul(.55), clock, .6);
  const v = amount.mul(patch.mul(.5).add(.75)).clamp(0, 1).toVar();

  // ── THE NETWORK ────────────────────────────────────────────────────────
  // Two scales of cell boundary: metre-scale cells and the smaller cells
  // inside them, the lines thickening as the foam gets denser. Their
  // brightness is broken up by a fine fractal so no filament is uniform.
  const lineWidth = mix(float(.05), float(.24), v);
  const coarse = cellular(p.mul(1.15), drift), fine = cellular(p.mul(3.7), drift.mul(1.3));
  const webA = coarse.y.sub(coarse.x).smoothstep(float(0), lineWidth).oneMinus();
  const webB = fine.y.sub(fine.x).smoothstep(float(0), lineWidth.mul(.85)).oneMinus();
  const grain = fbm(p.mul(9), clock, 2).mul(.7).add(.5);
  const network = webA.max(webB.mul(.75)).mul(grain).toVar();

  // ── THE SHEET ──────────────────────────────────────────────────────────
  // White, with holes of two sizes where the water shows through, and a
  // fine texture so it never reads as a flat fill.
  const holesA = cellular(p.mul(7), drift.mul(1.7)).x.smoothstep(.16, .42).oneMinus();
  const holesB = cellular(p.mul(17), drift.mul(2.3)).x.smoothstep(.12, .34).oneMinus();
  const sheet = float(.92).add(grain.mul(.16)).sub(holesA.mul(.55)).sub(holesB.mul(.3)).clamp(0, 1);

  // ── THE BUBBLES ────────────────────────────────────────────────────────
  // Single specks, 2–3 cm across, on a lattice most of whose cells are empty.
  const dots = cellular(p.mul(22), drift.mul(.8)).x.smoothstep(.14, .3).oneMinus();
  const sparse = valueNoise(p.mul(6).add(drift)).smoothstep(.45, .7);
  const specks = dots.mul(sparse);

  const sheetMask = v.smoothstep(.5, .82);
  const webMask = v.smoothstep(.05, .38);
  const speckMask = v.smoothstep(.015, .16);
  const foam = sheetMask.mul(sheet).max(webMask.mul(network)).max(speckMask.mul(specks)).clamp(0, 1);
  return foam.mul(u.foam.smoothstep(0, .15));
}

/**
 * ══ FINE SURFACE DETAIL — THE SLOPE OF A NOISE FIELD ═══════════════════════
 *
 * A 128² grid over ten metres cannot hold a wave finer than ~20 cm, and real
 * water is full of structure well below that. Geometry cannot get there; a
 * NORMAL can, and this is the difference between water and a corrugated sheet.
 *
 * ⛔ **IT MUST BE NOISE, NOT A SUM OF SINES.** The first version added six
 * directional sinusoids with fixed headings, and a handful of plane waves
 * summed together is a periodic lattice — on screen, a regular cross-hatch of
 * dots: "those surface detail looks like dotted noise. Incorrect" (user,
 * 2026-09-06). Picking cleverer angles cannot fix it; the interference of N
 * pure frequencies is always periodic. A fractal surface needs a fractal.
 *
 * These are forward differences of the authored FBM — three evaluations instead
 * of one, which is the honest price of a derivative value noise will not give
 * in closed form.
 *
 * ⚠ AND IT FADES WITH DISTANCE. Detail finer than a pixel aliases, and analytic
 * noise has no mip chain to fall back on, so far water would shimmer exactly
 * where a real sea goes smooth and specular. In world metres, so a pond and a
 * lake behave the same.
 */
export function waterDetailSlopeNode(u) {
  return Fn(() => {
    const distance = positionWorld.sub(cameraPosition).length();
    return waterDetailSlopeAt(worldXZ(u), u).mul(distance.smoothstep(40, 8));
  })();
}

/**
 * The same slopes at an ARBITRARY world XZ, with no distance fade — for the
 * caustic pass, which evaluates them per grid vertex in a pass that has no
 * fragment and no camera. `cutoff` (world metres) fades out the octaves that
 * grid cannot carry; see `authoredFbm`.
 *
 * ⭐ THE CAUSTIC LENS NEEDS THIS. It used to refract through the solver's
 * geometric normals alone, so on any gentle swell there was nothing to focus:
 * `causticIntensity` scaled a lens that did not exist — "as well as caustics
 * intensity, nothing changes" (user, 2026-09-06). Real caustics come from
 * exactly the fine structure the grid cannot hold, which is why they have to be
 * bent by the same detail the surface is shaded with. Same field, one lens.
 */
export function waterDetailSlopeAt(world, u, cutoff = null) {
  const p = world.mul(DETAIL_SCALE);
  const clock = waveClock(u);
  const here = authoredFbm(p, clock, u, cutoff).toVar();
  const along = authoredFbm(p.add(vec2(DETAIL_STEP, 0)), clock, u, cutoff);
  const across = authoredFbm(p.add(vec2(0, DETAIL_STEP)), clock, u, cutoff);
  return vec2(along.sub(here), across.sub(here)).div(DETAIL_STEP).mul(u.surfaceDetail.mul(.22));
}


/**
 * ══ SUBSURFACE SCATTERING — THE GLOW THROUGH A CREST ═══════════════════════
 *
 * Looking toward the sun through the thin water at the top of a wave, light that
 * entered the far side scatters out toward the eye and the crest lights up from
 * within. One dot product, and it is the cue that most separates water from a
 * polished surface.
 */
export function waterSubsurfaceNode(u, slot) {
  const toEye = cameraPosition.sub(positionWorld).normalize();
  const toSun = vec3(slot.uniforms.toSun);
  const through = toEye.dot(toSun).negate().max(0).pow(3);
  const range = u.waveHeight.add(u.amplitude).max(.001);
  const crest = positionLocal.y.div(range).mul(.5).add(.5).clamp(0, 1).smoothstep(.35, 1);
  const tint = mix(vec3(u.color), vec3(1), .25);
  return vec3(slot.uniforms.scatter).mul(tint).mul(through.mul(crest).mul(1.6));
}

/** Kept for the surface smoke, which asserts crest foam exists at all. */
export function waterCrestFoamNode(u) { return waterFoamNode(u); }
