import * as THREE from "three/webgpu";
import { Fn, dFdx, dFdy, float, instanceIndex, ivec2, refract, texture, textureStore, uniform, uv as uvAttribute, varying, vec2, vec3, vec4 } from "three/tsl";
import { waterDetailSlopeAt } from "./waterFoam.js";

/**
 * ══ THE WATER SLOT POOL — WHY THE BINDINGS ARE ENGINE-OWNED ════════════════
 *
 * Three consumers need to read a water surface every frame: the underwater
 * medium (`waterMedium.js`, a node on `scene.fogNode`), the raster caustic
 * light, and the GI sun term inside `srcShade.js`. All three are compiled
 * graphs, and in this engine a graph that binds a texture belonging to a
 * COMPONENT is a graph that must be rebuilt whenever that component is — a
 * resolution edit, a detach, a play/stop. For the GI kernels that is a
 * multi-second compile wave; for `scene.fogNode` it is every material in the
 * project.
 *
 * So the textures do not belong to the water. A fixed pool of slots is
 * allocated once per engine and lives for its lifetime; a water surface CLAIMS
 * a slot and renders into it, and every consumer binds the slot. Water can
 * appear, change resolution and vanish without a single graph rebuild — an
 * empty slot simply publishes `active = 0`, which every consumer already reads
 * as "no water here".
 *
 * That is also why the slot textures are a FIXED 128², rather than the solver's
 * own grid: the size is part of the binding. A coarse solver is resampled up
 * (smoothly — the source is linearly filtered), which is the right direction
 * anyway, because a caustic is a lens and its detail should not step with the
 * simulation's cell size.
 */

export const MAX_WATER_SLOTS = 2;
// The medium's copy of the surface: what the underwater view clips against.
const SLOT_RESOLUTION = 512;
// The reference projects caustics at 1024 for a two-unit pool; the filaments
// are only ever as thin as this map and as the lens feeding it. A 60 m lake
// gets 6 cm texels here, which is about as fine as its lens can focus anyway.
const CAUSTIC_RESOLUTION = 1024;
/**
 * ⭐ **THE CAUSTIC GRID IS ITS OWN RESOLUTION, NOT THE SOLVER'S.**
 *
 * The refracted grid is rasterized, so the map is filled by construction — but
 * the lens is only as smooth as the grid that samples it. It used to be one
 * vertex per SOLVER cell (capped at 256), and the fine detail that actually
 * makes caustics was then sampled at 4 cm on a 5 m pool and at 47 cm on a 60 m
 * one: octaves below that spacing came back as an unrelated random slope at
 * every vertex, and the rasterizer drew those as a floor full of thin random
 * scratches ("caustics are random now, too low poly and unrealistic", user
 * 2026-09-06). At 60 m the lens had no detail at all and the floor was blank.
 *
 * 512² beams whatever the solver's grid, reading the solver's surface
 * bilinearly and bending by detail band-limited to THIS spacing (see
 * `waterDetailSlopeAt`'s `cutoff`). A quarter of a million vertices in one
 * draw is nothing; a lens made of aliasing was the whole problem.
 */
const CAUSTIC_GRID = 512;
// Ceiling on the compression ratio. An exactly focal point divides by zero, and
// a firefly in a LIGHT is a firefly in every bounce that light ever takes.
const MAX_FOCUS = 5;
const IOR = 1 / 1.333;

/**
 * ⭐ **AND IT CARRIES A MIP CHAIN, WHICH IS WHAT MAKES LIGHT SHAFTS SMOOTH.**
 *
 * The floor wants every filament this map can hold. The shafts do not: they are
 * an integral ALONG the beam, estimated from a dozen taps, and a dozen samples
 * of a high-contrast field is a noisy estimate however cleverly the taps are
 * dithered — the dither only decides whether the error looks like banding or
 * like grain. "Can we make the underwater godrays a bit smoother, less
 * dithered? They look too noisy... and probably they are changing way too fast"
 * (user, 2026-09-06) is both symptoms of that one variance.
 *
 * A prefiltered copy fixes it at the source, and a mip chain is a prefiltered
 * copy the hardware already knows how to build — the WebGPU backend generates
 * it after the pass that fills this target. The shafts read a coarse level and
 * the floor reads level 0, from the same texture and the same pass. The blur
 * also slows what they show: the fine structure is what moved fastest.
 */
function causticTarget(index) {
  const target = new THREE.RenderTarget(CAUSTIC_RESOLUTION, CAUSTIC_RESOLUTION, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false, stencilBuffer: false,
  });
  target.texture.name = `Water slot ${index} caustics`;
  return target;
}

function storageTexture(name) {
  const map = new THREE.StorageTexture(SLOT_RESOLUTION, SLOT_RESOLUTION);
  map.type = THREE.HalfFloatType;
  map.format = THREE.RGBAFormat;
  map.minFilter = map.magFilter = THREE.LinearFilter;
  map.name = name;
  return map;
}

function createSlot(index) {
  return {
    index,
    owner: null,
    // (height, normal.xyz) in the water's local space — the medium's top face.
    surface: storageTexture(`Water slot ${index} surface`),
    // The caustic lens at the volume floor. A RENDER TARGET, not a storage
    // texture: the refracted grid is drawn into it (see `createWaterCausticPass`).
    causticTarget: causticTarget(index),
    uniforms: {
      inverse: uniform(new THREE.Matrix4()),
      // (halfX, depth, halfZ), local units.
      half: uniform(new THREE.Vector3(1, 1, 1)),
      rise: uniform(1),
      sigma: uniform(new THREE.Vector3()),
      scatter: uniform(new THREE.Color(0, 0, 0)),
      // The refracted sun through a FLAT surface, in local units: what a
      // receiver walks back up to find the cell its light came through.
      flatRay: uniform(new THREE.Vector3(0, -1, 0)),
      toSun: uniform(new THREE.Vector3(0, 1, 0)),
      // Toward the sun as a SUBMERGED receiver sees it — bent toward the
      // vertical by Snell. A caustic is carried by the refracted beam, so this
      // is the direction its cosine belongs to; `toSun` is the dry one.
      toSunRefracted: uniform(new THREE.Vector3(0, 1, 0)),
      // Toward the sun's MIRROR IMAGE, for a receiver above the water: the
      // direction the reflected beam arrives from, which points downward, so a
      // downward-facing surface has a positive cosine with it and everything
      // else has none. This is what lights the underside of a pier.
      toSunMirror: uniform(new THREE.Vector3(0, -1, 0)),
      // ...and the same direction in LOCAL units, for walking back down to the
      // surface. `toSunMirror` is a world direction and is only ever dotted
      // with a world normal; mixing the two spaces on a non-uniformly scaled
      // pool is the bug `flatRay` exists to avoid.
      mirrorRay: uniform(new THREE.Vector3(0, -1, 0)),
      // The surface's Fresnel reflectance at the sun's own incidence — about
      // 2 % overhead, rising steeply as the sun gets low. Small, and it is the
      // ONLY light a downward face over water gets, which is why it reads.
      reflectance: uniform(.02),
      radiance: uniform(new THREE.Color(0, 0, 0)),
      absorption: uniform(.2),
      strength: uniform(0),
      active: uniform(0),
    },
    // Bound once by every consumer; the sampler nodes are shared so a graph
    // that reads two slots still binds two textures, not four.
    nodes: null,
  };
}

/** The engine's pool. Created on the first water surface, kept for the session
 *  — releasing it would recompile everything a second time for nothing. */
export function waterSlotPool(engine) {
  if (engine.waterSlots) return engine.waterSlots;
  const slots = Array.from({ length: MAX_WATER_SLOTS }, (_, i) => createSlot(i));
  for (const slot of slots) {
    slot.caustic = slot.causticTarget.texture;
    slot.nodes = { surface: texture(slot.surface), caustic: texture(slot.caustic) };
  }
  engine.waterSlots = {
    slots,
    claim(owner) {
      const free = slots.find((slot) => slot.owner === null || slot.owner === owner);
      if (free) free.owner = owner;
      return free ?? null;
    },
    release(owner) { for (const slot of slots) if (slot.owner === owner) { slot.owner = null; slot.uniforms.active.value = 0; slot.uniforms.strength.value = 0; } },
    /** Slots a consumer should actually read this frame. */
    live() { return slots.filter((slot) => slot.owner && slot.uniforms.active.value > 0); },
  };
  return engine.waterSlots;
}

/**
 * The kernel that fills one slot from one solver, and the only place the two
 * meet. Reads the simulation's own surface texture (linearly filtered, so the
 * resample is smooth) and writes both slot maps.
 *
 * ⚠ **SNELL RUNS IN WORLD SPACE.** A water mesh is routinely non-uniformly
 * scaled — the user's pool is 42.6 × 5.3 × 42.6 — and a non-uniform scale is
 * not a similarity, so refracting a direction that had been pushed through the
 * inverse matrix bends it by the SCALE as well as by the water. The normal goes
 * local→world through the normal matrix, Snell runs there, and only the result
 * comes back for the landing arithmetic.
 */
/**
 * The solver resample: one stable 256^2 copy of the wave surface for the medium
 * to read. The caustic half of the slot is a DRAW, not a dispatch — see below.
 */
export function createWaterSlotKernel({ slot, surfaceTexture, resolution }) {
  const n = resolution;
  const c = {
    normalMatrix: uniform(new THREE.Matrix3()),
    toLocal: uniform(new THREE.Matrix3()),
    sun: uniform(new THREE.Vector3(0, -1, 0)),
  };
  // Map uv to the solver texture's uv. Texel (x,y) of an n x n surface texture
  // is grid VERTEX (x,y), so the vertices span [0.5/n, (n-0.5)/n] and a naive
  // `uv` would sample half a cell off at both rims.
  const toSource = (at) => at.mul((n - 1) / n).add(.5 / n);
  const resolve = Fn(() => {
    const i = instanceIndex.toInt().toVar();
    const px = i.mod(SLOT_RESOLUTION).toVar(), py = i.div(SLOT_RESOLUTION).toVar();
    const at = vec2(px.toFloat().add(.5).div(SLOT_RESOLUTION), py.toFloat().add(.5).div(SLOT_RESOLUTION));
    textureStore(slot.surface, ivec2(px, py), texture(surfaceTexture, toSource(at)).level(0));
  })().compute(SLOT_RESOLUTION * SLOT_RESOLUTION);
  resolve.__giPassName = "waterSlotSurface";
  return { compute: [resolve], uniforms: c, toSource };
}

/**
 * == CAUSTICS ARE A RASTERIZED PROJECTION, WHICH IS WHY THEY HAVE EDGES =====
 *
 * Two earlier attempts and why each looked wrong:
 *
 *  1. A per-texel area ratio measured in the SOURCE parameterization, gathered
 *     by walking back up the flat ray. Correct to first order, and it reads as
 *     soft mottling: caustics are bright because many parts of the surface focus
 *     onto the SAME place, and a gather can only report what one of them did.
 *  2. Point-splatting beams into an atomic accumulator. That sums folds, but the
 *     map is only as dense as the beams, so it needs a reconstruction filter,
 *     and the filter is exactly what removes the filaments again.
 *
 * The reference (MIT jeantimex/webgpu-water, itself a port of Evan Wallace's
 * pool) does neither: it DRAWS the refracted grid into the caustic texture. Each
 * vertex is projected to where its beam lands on the volume floor, and the
 * fragment reads the compression straight off the rasterizer as the ratio of the
 * undisturbed footprint to the drawn one — `length(dFdx) * length(dFdy)` of two
 * interpolants. Rasterization fills every texel a triangle covers, so there is
 * no sparsity and no filter; additive blending sums the folds, so a caustic is
 * bright exactly where several parts of the surface aim at one place. That is
 * the whole difference, and it is why this needs a draw call and not a kernel.
 *
 * The user asked for "the same texture the reference uses". It does not have
 * one: `public/` holds `tiles.jpg` and a skybox, and the caustics are computed
 * every frame from the live surface. This is that computation.
 *
 * THE MAP IS IN FLOOR PARAMETERIZATION - a receiver samples where its own beam
 * LANDS, not where it entered. See `waterCausticGainNode`.
 */
export function createWaterCausticPass({ slot, surfaceTexture, resolution, width, height, uniforms = null }) {
  const n = CAUSTIC_GRID;
  const u = slot.uniforms;
  const c = {
    normalMatrix: uniform(new THREE.Matrix3()),
    toLocal: uniform(new THREE.Matrix3()),
    sun: uniform(new THREE.Vector3(0, -1, 0)),
  };
  const toSource = (at) => at.mul((resolution - 1) / resolution).add(.5 / resolution);
  // One vertex per sample of the surface. PlaneGeometry's `uv` is exactly the
  // [0,1] parameterization this needs, and its own positions are never used -
  // `vertexNode` replaces them outright.
  const geometry = new THREE.PlaneGeometry(1, 1, n - 1, n - 1);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });

  const at = uvAttribute();
  const texel = 1 / resolution;
  const sampleAt = (dx, dy) => texture(surfaceTexture, toSource(at.add(vec2(dx * texel, dy * texel)))).level(0);
  const info = sampleAt(0, 0);
  /**
   * ⭐ **THE LENS READS A LOW-PASSED NORMAL, AND THAT IS NOT A CHEAT.**
   *
   * Focus is a SECOND derivative of the surface, so it is dominated by the
   * finest structure the height field carries — which is also the structure
   * that changes fastest and is least trustworthy, sitting at the solver's own
   * Nyquist. Measured on the reported pool: the caustic map turned over 13.9 %
   * of itself every tenth of a second on a gentle swell, i.e. the whole pattern
   * replaced in under a second. "The caustics along with god rays are still
   * quite crazy. Can we update them slower and smoother?" (user, 2026-09-06).
   *
   * There is a physical scale to stop at. An undulation of wavelength λ focuses
   * at a distance that shrinks with λ, so structure much finer than the water
   * is deep has already come to a focus and defocused again long before the
   * floor — it contributes a soft wash, never a filament. Averaging over about
   * a cell and a half is that cutoff, cheaply: five taps, and only the NORMAL
   * is smoothed. The height stays sharp because it positions the beam rather
   * than aiming it.
   */
  const LENS_CELLS = 2.5;
  const lensNormal = sampleAt(0, 0).yzw.mul(2)
    .add(sampleAt(LENS_CELLS, 0).yzw).add(sampleAt(-LENS_CELLS, 0).yzw)
    .add(sampleAt(0, LENS_CELLS).yzw).add(sampleAt(0, -LENS_CELLS).yzw)
    .div(6);
  const half = vec3(u.half);
  const rest = vec3(at.x.sub(.5).mul(width), 0, at.y.sub(.5).mul(height));
  // Where this sample's beam lands, and where it WOULD have landed through a
  // flat surface. The ratio of those two footprints is the whole effect.
  // ⭐ BENT BY THE FINE DETAIL TOO, not only by the grid. See
  // `waterDetailSlopeAt`: a lens made of the solver's normals alone cannot
  // focus anything a gentle swell does not already focus, and real caustics are
  // made by exactly the structure the grid cannot hold.
  //
  // ⚠ INSIDE AN `Fn`, and it has to be: `waterDetailSlopeAt` declares variables,
  // and this pass builds its vertex graph at construction time where there is
  // no builder stack — "No stack defined for assign operation". Anything that
  // declares belongs in one of these, which is the second time that has caught
  // me in this file's neighbourhood.
  //
  // ⭐ AND BAND-LIMITED TO THIS GRID. `cutoff` is three vertex spacings in
  // world metres: octaves finer than that are faded out of the lens rather
  // than sampled as noise. What survives is exactly the structure this many
  // beams can resolve into filaments.
  const spacing = Math.max(width, height) / (n - 1);
  const localNormal = uniforms
    ? Fn(() => {
        const world = vec2(rest.x.mul(uniforms.waveScale.x), rest.z.mul(uniforms.waveScale.z));
        const cutoff = uniforms.waveScale.x.max(uniforms.waveScale.z).mul(spacing * 3);
        const slope = waterDetailSlopeAt(world, uniforms, cutoff);
        const n = vec3(lensNormal);
        return vec3(n.x.sub(slope.x), n.y, n.z.sub(slope.y)).normalize();
      })()
    : vec3(lensNormal);
  const worldNormal = c.normalMatrix.mul(localNormal).normalize();
  const ray = c.toLocal.mul(refract(c.sun, worldNormal, IOR));
  const displaced = vec3(rest.x, info.x, rest.z);
  const hit = half.y.negate().sub(displaced.y).div(ray.y.min(-.05)).max(0);
  const landed = vec3(displaced.x.add(ray.x.mul(hit)), half.y.negate(), displaced.z.add(ray.z.mul(hit)));
  const flat = vec3(u.flatRay);
  const flatHit = half.y.negate().div(flat.y.min(-.05)).max(0);
  const reference = vec3(rest.x.add(flat.x.mul(flatHit)), half.y.negate(), rest.z.add(flat.z.mul(flatHit)));

  const newPos = varying(landed, "waterCausticNew");
  const oldPos = varying(reference, "waterCausticOld");
  // Draw in the floor's own space: the map covers the volume footprint exactly,
  // so a landing point maps straight to NDC.
  material.vertexNode = vec4(landed.x.div(half.x), landed.z.div(half.z).negate(), 0, 1);
  material.colorNode = Fn(() => {
    const oldArea = dFdx(oldPos).length().mul(dFdy(oldPos).length());
    const newArea = dFdx(newPos).length().mul(dFdy(newPos).length());
    return vec3(oldArea.div(newArea.max(1e-12)).clamp(0, MAX_FOCUS));
  })();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const previousClear = new THREE.Color();
  return {
    uniforms: c,
    /** One small draw per visible water surface, before the frame's own render. */
    render(renderer) {
      if (!renderer?.isWebGPURenderer) return;
      const target = renderer.getRenderTarget();
      const alpha = renderer.getClearAlpha();
      renderer.getClearColor(previousClear);
      renderer.setRenderTarget(slot.causticTarget);
      renderer.setClearColor(0x000000, 1);
      renderer.render(scene, camera);
      renderer.setClearColor(previousClear, alpha);
      renderer.setRenderTarget(target);
    },
    dispose() { geometry.dispose(); material.dispose(); scene.remove(mesh); },
  };
}
