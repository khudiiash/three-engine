import * as THREE from 'three/webgpu';
import { float, mix, normalWorld, positionWorld, select, vec2, vec3, vec4 } from 'three/tsl';
import { CAUSTIC_RESOLUTION, CAUSTIC_WINDOW_METRES, waterSlotPool } from './waterSlots.js';
import { waterInsideNode, waterRimDistanceNode } from './waterShape.js';

const registered = new WeakSet();

/**
 * ══ CAUSTICS ARE A MAP, NOT A DERIVATIVE ═══════════════════════════════════
 *
 * This used to be evaluated per fragment with `dFdx`/`dFdy` over the refracted
 * footprint. That is a correct estimator and it can only ever run in a FRAGMENT
 * shader: screen-space derivatives do not exist in a compute shader, so the GI
 * kernels — the things that would carry a caustic into a BOUNCE — structurally
 * could not see it, and water lit the scene only in the one pass that happened
 * to be rasterizing. "On GI ... currently, GI almost does not work with water"
 * (user, 2026-09-05) is that, exactly.
 *
 * The compression is therefore measured once per slot texel in a compute pass
 * (`waterSlots.js`) and read here as a texture — by the raster light below AND
 * by `srcShade.js`'s sun term, from the same map, so a caustic that brightens a
 * pool floor is the same caustic the probes bounce off it. Same principle as
 * the MIT jeantimex/webgpu-water reference's projected caustic texture, moved
 * off the rasterizer; the TSL is original.
 *
 * ⚠ **THE MAP IS IN SURFACE PARAMETERIZATION, NOT FLOOR PARAMETERIZATION.**
 * Texel (x,y) stores the compression of the beam passing through THAT PART OF
 * THE SURFACE by the time it reaches the volume floor, so a receiver finds its
 * texel by walking back up the flat refracted ray. The reference instead SPLATS
 * each beam where it lands, which additionally sums overlapping folds; a gather
 * cannot, so a fold reads as one bright filament rather than two summed. That
 * is the one thing given up, and it buys a pass with no atomics, no scatter and
 * no per-frame clear — and a gain that is bounded by construction.
 */

/** Hard ceiling on the multiplier. The SRC deposit clamps a stored transfer
 *  (`ρ/π · V`) into [0,1], so a gain past ~π would clip on a near-white
 *  surface; clipping a highlight is the right failure, a firefly is not.
 *
 *  ⚠ Lowered from 4 once the surface stopped filtering the floor to a fifth of
 *  its brightness: a caustic allowed to add three times the sun on top of a
 *  floor that now receives all of it is not a filament, it is an exposure
 *  error, and the whole pool bottom went white. */
const MAX_GAIN = 2.5;

/**
 * The caustic GAIN at a world point — a MULTIPLIER on light arriving from
 * above, ≥ 0, and exactly 1 outside the water. `focus × transmittance`: the
 * wave lens concentrates the beam and the column absorbs it, which is why the
 * two are one number and not two effects that can be dialled apart.
 *
 * Pure texture reads and arithmetic — no derivatives — so this is callable from
 * a fragment shader AND from a GI compute kernel, which is the entire point.
 */
export function waterCausticGainNode(P, slot, normal = null) {
  return waterCausticGainLocalNode(slot.uniforms.inverse.mul(vec4(P, 1)).xyz, slot, 0, normal);
}

/**
 * The same lookup for a point already in the water's local space — which is
 * where `waterMedium.js` marches, and transforming each of its samples out to
 * world only to transform it straight back would be the whole cost of the
 * light shafts spent on nothing.
 */
export function waterCausticGainLocalNode(P, slot, level = 0, normal = null) {
  const s = slot.uniforms;
  const local = vec3(P).toVar();
  // ── A GRAZING BEAM'S FOOTPRINT IS STRETCHED, AND SO IS ITS READ ────────
  //
  // The map is measured on the floor, one texel per beam cell. A receiver
  // the beam meets at an angle sees each cell stretched by 1/cos — a
  // vertical wall under a high sun by five, ten times — and reading the
  // map at its full resolution along that stretch turned every filament
  // into a chain of dots that twinkled as the lens moved ("black stripes
  // quickly flickering all over the pool walls", 2026-09-06, underwater).
  // The mip for a stretch of 1/cos is log2(1/cos): the floor stays sharp,
  // the wall reads the soft elongated bands a real pool wall shows.
  const graze = normal ? vec3(normal).dot(vec3(s.toSunRefracted)).abs().max(.06) : null;
  const lod = graze ? float(level).add(graze.reciprocal().log2().clamp(0, 4)) : float(level);
  // ⚠ NOT BOUNDED BELOW BY THE VOLUME FLOOR. It used to be, and that excluded
  // the single most important receiver there is: the floor of the pool sits
  // exactly ON the volume's bottom plane, so `depth < D` was a coin flip on the
  // last bit and the tiles — the thing caustics are FOR — got a gain of 1. What
  // bounds the effect is being under the surface and inside its footprint;
  // light that reaches the floor carries on into whatever is standing there,
  // and `d` below simply stops accumulating at the volume's own depth.
  const depth = local.y.negate().toVar();
  const d = depth.min(s.half.y).toVar();
  // The map is in FLOOR parameterization, so follow this point's own beam DOWN
  // to where the splat recorded it rather than walking back up to the surface.
  const rise = s.flatRay.y.negate().max(.05);
  // ...but the beam must have ENTERED through the water: walked back UP to the
  // rest surface, its origin has to lie inside the lid's outline. A wall's
  // upper reaches on the up-sun side are lit by beams that came in over the
  // rim, through air — no lens, gain 1 — and reading the map for them found
  // its clipped border instead ("black stripes flickering on the pool walls").
  const origin = vec2(local.x.sub(s.flatRay.x.mul(d).div(rise)), local.z.sub(s.flatRay.z.mul(d).div(rise)));
  const inside = waterInsideNode(vec4(s.shape), s.half, local)
    .and(waterRimDistanceNode(vec4(s.shape), s.half, origin.x, origin.y).greaterThan(0));
  const remaining = s.half.y.sub(d).max(0).div(rise);
  const sample = vec2(
    local.x.add(s.flatRay.x.mul(remaining)),
    local.z.add(s.flatRay.z.mul(remaining)),
  );
  const { uv, edge } = causticWindowUv(sample, s);
  // `level` is the mip the caller wants: 0 for a receiver, which needs every
  // filament, and a coarse one for the light shafts, which are integrating
  // along the beam and cannot afford the variance. See `causticTarget`.
  const floorFocus = slot.nodes.caustic.sample(uv.clamp(.001, .999)).depth(slot.causticLayer).level(lod).x;
  // The map is measured AT the floor. A receiver higher in the column has had
  // less distance over which to focus, so the compression is interpolated
  // toward 1 at the surface rather than stamped at full strength on everything
  // submerged. Linear in depth is the first-order truth for a thin lens.
  const focus = mix(float(1), floorFocus, d.div(s.half.y.max(.001)).clamp(0, 1));
  // ⛔ NO TRANSMITTANCE HERE. It used to multiply the focus by `exp(-d·σ)`,
  // which reads as physics and is a category error in this node: the term below
  // can only ADD (see `WaterCausticLightNode`), so an attenuation folded into
  // it does not darken the floor — it deletes the caustic and leaves the sun
  // term it was modulating at full strength. Harmless while σ was a small raw
  // coefficient; the moment `saturation` gave it a realistic value the caustics
  // "almost completely vanished" (user, 2026-09-05) and nothing got darker.
  // The column's absorption belongs to `waterMedium.js`, where a ray knows what
  // it crossed and the result can go down as well as up.
  //
  // `strength` folds in both the author's intensity and "is this slot live at
  // all": at 0 the expression is exactly 1, so the caustic disappears without a
  // branch anywhere in any consumer, and above 1 it exaggerates the lens around
  // the same neutral point rather than scaling the light itself.
  const gain = float(1).add(focus.sub(1).mul(s.strength).mul(edge)).clamp(0, MAX_GAIN);
  return select(inside, gain, float(1));
}

/**
 * Where a landing point falls in the caustic WINDOW (see `waterSlots.js`'s
 * `causticCenter`), and how close to its rim: the gain fades to 1 over the
 * outer tenth so the window has no visible border as the camera moves.
 */
function causticWindowUv(sample, s) {
  const rel = sample.sub(vec2(s.causticCenter)).div(vec2(s.causticHalf).mul(2)).toVar();
  const uv = rel.add(.5);
  const edge = float(.5).sub(rel.abs().max(rel.abs().yx).x).mul(10).clamp(0, 1);
  return { uv, edge };
}

/**
 * ══ THE CAUSTIC THAT GOES UP ═══════════════════════════════════════════════
 *
 * "Still no caustics from water outside, like we have a pier on the beach — its
 * bottom must have caustics" (user, 2026-09-06). The wave surface reflects as
 * well as refracting, and the reflected beams focus in exactly the same way:
 * the wobbling light on the underside of a jetty is the same lens seen from the
 * other side.
 *
 * It needs no second map. The stored compression belongs to a piece of SURFACE,
 * and the map is indexed by where that piece's refracted beam lands; so to ask
 * "how focused is the light leaving surface point S upward", walk S down the
 * flat refracted ray to the floor and read there. The reflected beam is bent by
 * curvature the same way the refracted one is — the angles differ, the focusing
 * does not, to first order.
 *
 * Weighted by the surface's real Fresnel reflectance (~2 % with the sun high),
 * which sounds like nothing and is not: a downward-facing surface over water
 * receives no direct sun at all, so this is the only light it has.
 */
export function waterCausticAboveNode(P, slot) {
  const s = slot.uniforms;
  const local = s.inverse.mul(vec4(P, 1)).xyz.toVar();
  const height = local.y.toVar();
  // Back down the reflected beam to the surface it left — and that point, not
  // the receiver, is what must lie on the water: a wall beside the pool is lit
  // by the mirrored sun wherever its beam meets the surface inside the outline.
  const ray = vec3(s.mirrorRay).toVar();            // LOCAL units, pointing down
  const climb = ray.y.negate().max(.05);
  const surfaceX = local.x.add(ray.x.mul(height).div(climb));
  const surfaceZ = local.z.add(ray.z.mul(height).div(climb));
  const inside = waterRimDistanceNode(vec4(s.shape), s.half, surfaceX, surfaceZ).greaterThan(0).and(height.greaterThan(0));
  // ...and from there down the FLAT refracted ray, because that is the
  // parameterization the map is stored in.
  const rise = s.flatRay.y.negate().max(.05);
  const reach = s.half.y.div(rise);
  const { uv, edge } = causticWindowUv(vec2(surfaceX.add(s.flatRay.x.mul(reach)), surfaceZ.add(s.flatRay.z.mul(reach))), s);
  const focus = slot.nodes.caustic.sample(uv.clamp(.001, .999)).depth(slot.causticLayer).level(0).x;
  // The pattern softens with distance from the surface, as a real one does —
  // over the volume's own depth, so it is scale-free like everything else here.
  const spread = height.div(s.half.y.max(.001)).clamp(0, 1);
  const lens = mix(focus, float(1), spread.smoothstep(0, 1.5));
  return select(inside, lens.mul(s.strength).mul(edge).clamp(0, MAX_GAIN), float(0));
}

export class WaterCausticLight extends THREE.Light {
  constructor(pool) { super(0xffffff, 1); this.type = 'WaterCausticLight'; this.waterPool = pool; this.userData.engineOwned = true; }
}

/**
 * The RASTER half, and it is deliberately the POSITIVE half only.
 *
 * `context.irradiance` is a sum, so a multiplier can only be expressed here as
 * the DIFFERENCE from the unmodified sun: `E·cos·(gain − 1)`. That reproduces
 * `E·cos·gain` exactly wherever the sun actually reaches — and nowhere else,
 * because this node cannot see three's shadow map. In shadow the true term is
 * zero and the difference is not, so the negative half (absorption, `gain < 1`)
 * would subtract light that was never delivered and drive the pixel to black.
 * Clamped at zero it can only ADD a highlight the sun could have carried, which
 * is bounded and wrong in the safe direction; the absorption half belongs to
 * `waterMedium.js`, where a view ray knows how much water it actually crossed.
 *
 * ONE light serves the whole pool. It is a scene light, so adding or removing
 * it recompiles every material — doing that per water surface made a second
 * pool in a scene cost a full compile wave.
 */
export class WaterCausticLightNode extends THREE.AnalyticLightNode {
  static get type() { return 'WaterCausticLightNode'; }
  setup(builder) {
    if (!builder.context.irradiance || builder.object?.userData?.vfxSimulation === 'water') return;
    for (const slot of this.light.waterPool.slots) {
      const s = slot.uniforms;
      const gain = waterCausticGainNode(positionWorld, slot, normalWorld);
          // Underwater the incoming beam is the REFRACTED one, steeper than the
      // sun's own direction, so that is the cosine a caustic arrives with. The
      // term is zero outside the volume regardless (`gain - 1` is), so this
      // needs no branch. A DOWNWARD-facing surface still receives nothing, and
      // that is not a gap: no refracted sunbeam reaches the underside of
      // anything. Light there arrives by bounce, which is the GI path's job.
  const cos = normalWorld.dot(s.toSunRefracted).max(0);
      builder.context.irradiance.addAssign(s.radiance.mul(cos).mul(gain.sub(1).max(0)));
      // ...and the same lens reflected upward, onto whatever overhangs the
      // water. A DOWNWARD-facing normal is the whole audience for this term:
      // `toSunMirror` points down, so every other surface in the scene gets a
      // cosine of zero and pays one clamped dot product for it.
      const under = normalWorld.dot(s.toSunMirror).max(0);
      builder.context.irradiance.addAssign(
        s.radiance.mul(under).mul(s.reflectance).mul(waterCausticAboveNode(positionWorld, slot)));
    }
  }
}

/**
 * ⭐ A RECEIPT FOR THE ONE THING A SCREENSHOT CANNOT SETTLE.
 *
 * "Still seeing all the way to the bottom at saturation 1" is a report about a
 * number nobody can see. The GPU harness renders the same pool, with the same
 * props, and goes opaque — so when the live editor does not, the disagreement
 * is in a value, and the only way to find out WHICH is to print them where the
 * console can be read. σ is the whole effect; the sight range is what the author
 * asked for; `active` says the slot is armed at all.
 *
 * Throttled to real changes, so a scene that is behaving says this once.
 */
const reported = new WeakMap();
function reportSaturation(slot, simulation) {
  const s = slot.uniforms;
  const saturation = simulation.uniforms.saturation.value;
  // The MEAN of the three channels: `deepColor` only decides which wavelength
  // dies first, so the mean is the coefficient the sight range was authored as.
  const sigma = (s.sigma.value.x + s.sigma.value.y + s.sigma.value.z) / 3;
  const last = reported.get(slot);
  if (last && Math.abs(last.saturation - saturation) < .01 && Math.abs(last.sigma - sigma) < sigma * .1) return;
  reported.set(slot, { saturation, sigma });
  const column = s.half.value.y * s.rise.value;
  const range = sigma > 0 ? 3 / sigma : Infinity;
  console.log(`[water] slot ${slot.index}: saturation ${saturation.toFixed(2)} → sight range ${
    range === Infinity ? "unlimited" : `${range.toFixed(2)} m`} through a ${column.toFixed(2)} m column (σ ${
    sigma.toFixed(1)}/m, active ${s.active.value})`);
}

/** One caustic light per engine, alive while any water surface is. */
export function installWaterCausticLight(engine) {
  if (engine._waterCausticLight) return engine._waterCausticLight;
  const renderer = engine?.renderer;
  const pool = waterSlotPool(engine);
  if (!renderer) return null;
  if (!registered.has(renderer)) { renderer.library.addLight(WaterCausticLightNode, WaterCausticLight); registered.add(renderer); }
  const light = new WaterCausticLight(pool);
  engine.scene.add(light);
  engine._waterCausticLight = light;
  return light;
}
export function removeWaterCausticLight(engine) {
  engine._waterCausticLight?.removeFromParent();
  engine._waterCausticLight = null;
}

/**
 * Per-frame slot upkeep for one water surface: the matrices the kernel and
 * every consumer read, the optical constants, and the sun the lens is aimed at.
 */
const scatterSource = new THREE.Color(), up0 = new THREE.Vector3(), _eye = new THREE.Vector3();
/** How far a refracted ray may walk before it exits, in world metres. Small on
 *  purpose: past a few tens of centimetres the screen-space sample leaves the
 *  water's own silhouette and starts drawing the bank. */
const REFRACTION_METRES = .22;
export function updateWaterSlot({ engine, slot, kernel, mesh, simulation, props = {} }) {
  const s = slot.uniforms;
  mesh.updateWorldMatrix(true, false, true);
  s.inverse.value.copy(mesh.matrixWorld).invert();
  const toLocal = new THREE.Matrix3().setFromMatrix4(s.inverse.value);
  const axisX = new THREE.Vector3().setFromMatrixColumn(mesh.matrixWorld, 0);
  const axisY = new THREE.Vector3().setFromMatrixColumn(mesh.matrixWorld, 1);
  const axisZ = new THREE.Vector3().setFromMatrixColumn(mesh.matrixWorld, 2);
  s.rise.value = Math.max(1e-4, axisY.length());
  // ── REFRACTION IS A WORLD OFFSET, AND `thickness` IS A LOCAL ONE ─────────
  //
  // three refracts by displacing the transmission sample along the refracted
  // ray by `thickness x modelScale` (PhysicalLightingModel's
  // `getVolumeTransmissionRay`). `thickness` was the volume depth, which on a
  // pool scaled ten metres wide threw the exit point ten metres sideways: the
  // water sampled the SHORE and drew it back as a smeared double image. So it
  // was set to zero, and then there was no refraction at all — "refraction is
  // gone", and later "does not seem to be working" (user, 2026-09-06).
  //
  // Both are the same units mistake. The offset that belongs here is the
  // lateral walk of a ray crossing a shallow layer of water — centimetres, not
  // metres — so it is authored in WORLD metres and divided by the largest model
  // scale on the way in. The `transmission` dial scales it, which is what makes
  // that one slider read as "refraction" at all.
  const scale = Math.max(1e-4, axisX.length(), axisY.length(), axisZ.length());
  simulation.uniforms.refraction.value = REFRACTION_METRES * (simulation.uniforms.transmission.value ?? 1) / scale;
  s.half.value.set(simulation.extent.halfX, Math.max(.01, simulation.extent.depth), simulation.extent.halfZ);
  s.up.value.set(0, 1, 0).transformDirection(mesh.matrixWorld);
  if (simulation.shape) s.shape.value.set(simulation.shape.kind, simulation.shape.radius, simulation.shape.centerY, simulation.shape.height);
  // ── THE CAUSTIC WINDOW FOLLOWS THE CAMERA, SNAPPED TO ITS TEXELS ────────
  //
  // Half-size: the pool, or `CAUSTIC_WINDOW_METRES` across, whichever is
  // smaller — in local units per axis, because the box is anisotropic.
  // Centre: the camera's local XZ, kept inside the pool so the window never
  // hangs over the rim, then rounded to a whole texel so a moving camera
  // slides the window in steps the pattern cannot see.
  const wx = Math.min(s.half.value.x, CAUSTIC_WINDOW_METRES / 2 / Math.max(1e-4, axisX.length()));
  const wz = Math.min(s.half.value.z, CAUSTIC_WINDOW_METRES / 2 / Math.max(1e-4, axisZ.length()));
  s.causticHalf.value.set(Math.max(1e-4, wx), Math.max(1e-4, wz));
  const eye = engine?.camera ? engine.camera.getWorldPosition(_eye).applyMatrix4(s.inverse.value) : _eye.set(0, 0, 0);
  const tx = 2 * wx / CAUSTIC_RESOLUTION, tz = 2 * wz / CAUSTIC_RESOLUTION;
  const cx = Math.max(-(s.half.value.x - wx), Math.min(s.half.value.x - wx, eye.x));
  const cz = Math.max(-(s.half.value.z - wz), Math.min(s.half.value.z - wz, eye.z));
  s.causticCenter.value.set(Math.round(cx / tx) * tx, Math.round(cz / tz) * tz);
  const absorption = Math.max(0, Number(simulation.uniforms.absorption.value ?? .2));
  s.absorption.value = absorption;
  // ── `absorption` IS THE EXTINCTION; `deepColor` IS ONLY ITS HUE ──────────
  //
  // three's transmission model reads the pair as `T = attenuationColor ^
  // (d/attenuationDistance)`, i.e. σ = −ln(deepColor)·absorption, and taking
  // that literally over a REAL path length turns a swimming pool opaque: the
  // default `#063a52` is dark enough that −ln is ~4 per channel, so a 3 m slant
  // at absorption 0.2 leaves 2–20% and the tiles vanish. The old material-only
  // tint hid this because it was never integrated over a path at all.
  //
  // Normalizing −ln to a mean of one keeps deepColor doing what an author
  // expects — deciding WHICH wavelengths die first — while `absorption` alone
  // sets how murky the water is.
  //
  // ⚠ AND IT IS PER LOCAL UNIT, hence the `/ rise`. Every other quantity the
  // component authors — `waterDepth`, `waveHeight`, the wave length — is in the
  // surface's own units and scales with the mesh, so a water box scaled up has
  // bigger waves and a deeper volume. Extinction per WORLD metre would be the
  // one quantity that did not, and the same authored number would read as a
  // clear pool at one scale and a silt bed at another.
  const deep = simulation.uniforms.deepColor.value;
  const k = [deep.r, deep.g, deep.b].map((c) => -Math.log(Math.min(.999, Math.max(1e-3, c))));
  const mean = Math.max(1e-3, (k[0] + k[1] + k[2]) / 3);
  const perMetre = (i) => k[i] / mean * absorption / s.rise.value;
  s.sigma.value.set(perMetre(0), perMetre(1), perMetre(2));
  reportSaturation(slot, simulation);
  scatterSource.copy(simulation.uniforms.color.value);

  let source = null;
  engine.scene.traverseVisible((object) => {
    if (object.isDirectionalLight && object.intensity > 0 && (!source || object.intensity > source.intensity)) source = object;
  });
  const visible = mesh.visible && props.caustics !== false;
  s.active.value = mesh.visible ? 1 : 0;
  if (!source) { s.scatter.value.setRGB(0, 0, 0); s.strength.value = 0; s.radiance.value.setRGB(0, 0, 0); return; }
  source.updateWorldMatrix(true, false, true);
  source.target.updateWorldMatrix(true, false, true);
  const from = new THREE.Vector3(), to = new THREE.Vector3();
  source.getWorldPosition(from); source.target.getWorldPosition(to);
  const ray = to.sub(from).normalize();
  // ── IN-SCATTER IS A RADIANCE, AND IT WAS BEING FED AN ALBEDO ────────────
  //
  // The haze the medium mixes toward used to be `waterColour × min(1, sun
  // intensity)` — the colour swatch itself, at full brightness, as though the
  // water were an emissive sheet. Over any real path that term wins, and a pool
  // seen from the side or from underneath became a flat plate of `#168aab` with
  // the scene painted faintly on it. It is also most of why the caustics read
  // as weak: the receiver they land on had already been washed out.
  //
  // What belongs here is the radiance a diffuse scatterer of that colour would
  // have under the light actually reaching it: `E/π`, with `E` the downwelling
  // irradiance — the sun's own cosine included, so the haze dims as the sun
  // gets low instead of glowing at midnight. `waterMedium.js` then attenuates
  // it again over the depth the segment actually sits at.
  const luma = source.color.r * .2126 + source.color.g * .7152 + source.color.b * .0722;
  const downwelling = source.intensity * luma * Math.max(0, -ray.y);
  s.scatter.value.copy(scatterSource).multiplyScalar(downwelling / Math.PI);
  if (!visible) { s.strength.value = 0; s.radiance.value.setRGB(0, 0, 0); return; }
  kernel?.update?.();
  for (const stage of [kernel, simulation.causticPass]) {
    if (!stage) continue;
    stage.uniforms.sun.value.copy(ray);
    stage.uniforms.normalMatrix.value.getNormalMatrix(mesh.matrixWorld);
    stage.uniforms.toLocal.value.copy(toLocal);
  }
  s.toSun.value.copy(ray).negate();
  s.toSunRefracted.value.copy(refractVector(ray, up0.set(0, 1, 0).transformDirection(mesh.matrixWorld), 1 / 1.333)).negate().normalize();
  // The sun's mirror image, and the surface's reflectance toward it. Schlick
  // against water's 0.02 normal-incidence reflectance: 2 % with the sun
  // overhead and climbing hard as it drops toward the horizon, which is exactly
  // when a jetty's underside lights up.
  s.toSunMirror.value.set(-ray.x, ray.y, -ray.z).normalize();
  s.mirrorRay.value.copy(s.toSunMirror.value).applyMatrix3(toLocal);
  const cosSun = Math.min(1, Math.abs(ray.y));
  s.reflectance.value = .02 + .98 * (1 - cosSun) ** 5;
  // The flat-surface refracted ray in LOCAL units — what a receiver walks back
  // up to find its texel. Refracted in world space against the mesh's real up.
  const up = new THREE.Vector3(0, 1, 0).transformDirection(mesh.matrixWorld);
  s.flatRay.value.copy(refractVector(ray, up, 1 / 1.333)).applyMatrix3(toLocal);
  // 1 is the PHYSICAL gain, not a taste setting: `1 + (focus*T - 1)*strength`
  // is exactly `focus*T` there. Below it the lens is damped and above it
  // exaggerated, both around the same neutral point.
  s.strength.value = Math.max(0, Math.min(3, Number(props.causticIntensity ?? 1)));
  s.radiance.value.copy(source.color).multiplyScalar(source.intensity);
}

/** Snell on the CPU, matching WGSL's `refract` including total internal
 *  reflection (which returns the zero vector — parked straight down here). */
export function refractVector(incident, normal, eta) {
  const dot = incident.dot(normal);
  const k = 1 - eta * eta * (1 - dot * dot);
  if (k < 0) return new THREE.Vector3(0, -1, 0);
  return new THREE.Vector3().copy(incident).multiplyScalar(eta).addScaledVector(normal, -(eta * dot + Math.sqrt(k)));
}
