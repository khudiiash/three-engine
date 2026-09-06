import {
  Fn, attribute, cameraFar, cameraNear, cameraPosition, float, linearDepth, mix, positionLocal, positionWorld,
  screenUV, select, texture, vec2, vec3, viewportDepthTexture,
} from "three/tsl";

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
export function waterFoamNode(u, sceneDepth = null) {
  // ⚠ WRAPPED IN `Fn`, AND IT HAS TO BE. `toVar()` and `addAssign` allocate on
  // the builder's STACK, and a node factory called straight from a material
  // build has no stack — "No stack defined for assign operation". Anything here
  // that declares a variable belongs inside one of these.
  return Fn(() => waterFoamBody(u, sceneDepth))();
}
function waterFoamBody(u, sceneDepth) {
  const p = worldXZ(u);
  const clock = waveClock(u);
  const drift = clock.mul(.5);

  // The solver's own foam, and the contact term.
  const simulated = attribute("waterFoam", "float").clamp(0, 1);
  // ⚠ THE SCENE DEPTH COMES FROM A TEXTURE THAT OWNS ITS RENDER TARGET when
  // one is published (`engine.scenePass`, the post chain's 1-sample beauty
  // pass): three's shared viewport depth is declared with the sample count
  // of whichever target is current when the shader is BUILT, and a pipeline
  // built against the MSAA canvas then fails to bind in the 1-sample pass
  // the scene is actually rendered in. Without a published pass the shared
  // one is right, because build and render share the canvas.
  const depthNode = sceneDepth ? texture(sceneDepth, screenUV) : viewportDepthTexture();
  const behind = linearDepth(depthNode).sub(linearDepth());
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
  const q = p.add(warp);
  const lineWidth = mix(float(.2), float(.55), v);
  const coarse = cellular(q.mul(.9), drift), fine = cellular(q.mul(2.6).add(warp.mul(1.5)), drift.mul(1.3));
  const filament = (cells, width) => cells.y.sub(cells.x).div(width).clamp(0, 1).oneMinus().pow(1.6);
  const grain = fbm(p.mul(6), clock, 2).mul(.9).add(.35);
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
  const specks = fbm(p.mul(11), clock, 1.5).smoothstep(.6, .78).mul(fbm(p.mul(2.5), clock, .8).smoothstep(.4, .7));

  const sheetMask = v.smoothstep(.5, .82);
  const webMask = v.smoothstep(.05, .38);
  const speckMask = v.smoothstep(.015, .16);
  const foam = sheetMask.mul(sheet).max(webMask.mul(network)).max(speckMask.mul(specks)).clamp(0, 1);
  return foam.mul(u.foam.smoothstep(0, .15));
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
