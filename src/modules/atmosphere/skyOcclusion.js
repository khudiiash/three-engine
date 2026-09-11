import * as THREE from "three/webgpu";
import { Fn, float, max, positionWorld, smoothstep, texture, uniform, vec2, vec4 } from "three/tsl";

/**
 * ⭐⭐ WHAT CAN SEE THE SKY — one small top-down capture, read by everything.
 *
 * Rain that falls through a roof and snow that settles on the floor of a
 * covered market are the two artefacts that undo a weather system fastest,
 * and they are the same question asked twice: IS THERE ANYTHING ABOVE THIS
 * POINT? So it is answered once, into a 128×128 texture holding the height of
 * the highest surface over each square metre of the world around the camera,
 * and both consumers sample it:
 *
 *   · precipitation kills a drop whose world position is below the roof over it
 *   · the surface weather refuses to lie snow on ground that is under cover
 *
 * ⚠ IT IS A HEIGHT MAP, NOT A DEPTH BUFFER. A depth buffer would have to be
 * un-projected by every reader, and its precision is worst exactly where the
 * answer matters. Writing world Y as colour and letting the depth test keep
 * the highest surface makes the comparison a subtraction.
 *
 * ## WHAT IT COSTS, AND THE ONE THING THAT MADE IT EXPENSIVE
 *
 * The fill is trivial and the draw calls are ordinary. The bill that froze a
 * real scene for THIRTY SECONDS was one line of it: an override material needs
 * a render pipeline for every geometry/instancing variant in the scene
 * (foliage's instanced chunks worst of all), the driver parses WGSL on the
 * calling thread, and the first capture compiled all five of them inside one
 * frame — `renderPipeline_Atmosphere · height ×5`, 30.9 s of `waitingOnGpu` in
 * a single block of the user's freeze ledger. `compileAsync` moves exactly that
 * work off the main thread, and until it lands the map stays inert
 * (`strength` 0) and the world behaves as if it had no roofs.
 *
 * ⚠ What it does NOT cost, contrary to what this comment used to claim, is a
 * whole-scene material re-mint. three's `RenderObjects` chain-keys on the
 * render CONTEXT, so a second context gets its own render objects rather than
 * making the first one's fork; and with an override material the scene's own
 * materials never enter this pass at all — the chain key's material is this
 * one, for every object. One extra 128x128 pass at 2 Hz is the whole price.
 *
 * So `sheltered` is ON. Rain that falls through a roof is not a missing
 * feature, it is a broken one.
 */

const SIZE = 128;
/** Metres across. Big enough to cover the precipitation box and its margin. */
const EXTENT = 72;
/** Where the capture camera sits. Anything above this is not a roof. */
const CEILING = 400;
/** Nothing lower than this is "the sky" — the floor of the empty answer. */
const OPEN = -10000;
/** Metres per texel. The capture centre is SNAPPED to this — see `update`. */
const TEXEL = EXTENT / SIZE;
/** Metres of fade at the rim of the captured area, so a roof entering it ramps
 *  in over a few steps instead of appearing complete. */
const RIM = 6;
/** Seconds for `strength` to cross when the weather starts or stops needing an
 *  answer. It gates the whole shelter term in every patched material, so a
 *  step here is the entire world's snow and wet changing in ONE frame. */
const STRENGTH_EASE = 1.5;

export function createSkyOcclusionUniforms() {
  return {
    /** 0 while nothing needs it: every consumer multiplies out. */
    strength: uniform(0),
    /** World XZ the capture is centred on, and metres per side. */
    center: uniform(new THREE.Vector2()),
    extent: uniform(EXTENT),
    map: null,
    mapNode: null,
  };
}

/**
 * The height of whatever stands over `worldXZ`, or a very negative number when
 * nothing does. Outside the captured area the answer is always "open sky" —
 * the alternative (clamping to the edge) would smear a roof across the world.
 */
export const skyOcclusionHeight = /*@__PURE__*/ Fn(([u]) => {
  // The capture camera looks straight down with world +X to the right, so the
  // framebuffer's vertical axis runs against world Z.
  const local = vec2(
    positionWorld.x.sub(u.center.x).div(u.extent).add(0.5),
    float(0.5).sub(positionWorld.z.sub(u.center.y).div(u.extent)),
  );
  const inside = local.x.greaterThan(0).and(local.x.lessThan(1))
    .and(local.y.greaterThan(0)).and(local.y.lessThan(1));
  // ⚠ `.level(0)` IS REQUIRED, not an optimisation. The precipitation hoists
  // this whole test into its vertex shader (it is constant per quad), and WGSL
  // forbids an implicit-derivative `textureSample` outside a fragment stage.
  const sample = u.mapNode.sample(local).level(0);
  // ⚠ ALPHA IS THE SENTINEL, not a height of zero. The target is cleared with
  // alpha 0 and every drawn fragment writes 1, so "nothing above here" is
  // distinguishable from "a roof at y = 0" — which matters the moment a scene
  // has anything below the origin.
  const covered = inside.and(sample.a.greaterThan(0.5));
  return covered.select(sample.r, float(OPEN));
});

/**
 * 1 where the sky is open, 0 under a roof, with a soft edge so a wall's
 * shadow does not have a hard line at its foot.
 *
 * `bias` lifts the test above the surface being asked about: the ground itself
 * is IN the height map, so without it every point would report itself covered.
 */
export const skyExposure = /*@__PURE__*/ Fn(([u, bias]) => {
  const roof = skyOcclusionHeight(u);
  const clearance = roof.sub(positionWorld.y.add(bias));
  // Covered when something stands more than `bias` above; the smoothstep is
  // the fade, in metres.
  // ⚠ AND IT FADES AT THE RIM OF THE CAPTURE. The map is a window that follows
  // the camera, so a roof thirty-six metres away CROSSES INTO IT — and with a
  // hard edge everything beneath that roof lost its snow in a single frame as
  // you walked. The last few metres ramp instead, which turns a pop into a
  // sweep nobody reads as an event.
  const distance = max(
    positionWorld.x.sub(u.center.x).abs(),
    positionWorld.z.sub(u.center.y).abs(),
  );
  // ⛔ ASCENDING EDGES + `.oneMinus()`. `smoothstep(high, low, x)` is UNDEFINED
  // in WGSL and this project renders through WGSL — it is the exact shape that
  // produced the "random colour spots" in the sky for three reports running.
  const half = u.extent.mul(0.5);
  const rim = smoothstep(half.sub(RIM), half, distance).oneMinus();
  const covered = smoothstep(0.0, 0.6, clearance).mul(u.strength).mul(rim);
  return float(1).sub(covered).clamp(0, 1);
});

/**
 * The capture itself. Nothing in here is per-frame: `update` decides when it
 * has become worth re-rendering.
 */
export function createSkyOcclusion() {
  const uniforms = createSkyOcclusionUniforms();
  const target = new THREE.RenderTarget(SIZE, SIZE, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    generateMipmaps: false,
  });
  target.texture.name = "Atmosphere · sky occlusion";
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
  uniforms.map = target.texture;
  uniforms.mapNode = texture(target.texture);

  // Orthographic, looking straight down. `near`/`far` bracket the whole slab
  // so the depth test keeps the HIGHEST surface over each texel.
  const camera = new THREE.OrthographicCamera(-EXTENT / 2, EXTENT / 2, EXTENT / 2, -EXTENT / 2, 0.1, CEILING * 2);
  camera.up.set(0, 0, -1);
  camera.rotation.set(-Math.PI / 2, 0, 0);

  // World height as colour. `depthWrite` on, so the nearest to the capture
  // camera — the highest — is what survives.
  const material = new THREE.MeshBasicNodeMaterial();
  material.name = "Atmosphere · height";
  material.colorNode = vec4(positionWorld.y, positionWorld.y, positionWorld.y, 1);
  material.fog = false;
  material.side = THREE.DoubleSide;

  // ⛔ THE WARM-UP NEEDS ITS OWN, ENORMOUS FRUSTUM. `compileAsync` builds a
  // render list, and a render list is FRUSTUM CULLED: warming through the
  // 72 m capture camera compiled only what happened to be under it, and every
  // geometry variant outside — the rest of the level, the far foliage chunks —
  // compiled synchronously later, on the frame the capture first met it. That
  // is the user's "when switching to/from rain/snow, editor freezes". This
  // camera sees the whole world, so the warm-up covers every variant once.
  const warmCamera = new THREE.OrthographicCamera(-1e4, 1e4, 1e4, -1e4, 0.1, 2e4);
  warmCamera.up.set(0, 0, -1);
  warmCamera.rotation.set(-Math.PI / 2, 0, 0);
  warmCamera.position.set(0, 1e4 * 0.5, 0);
  warmCamera.updateMatrixWorld(true);

  const center = new THREE.Vector2(Infinity, Infinity);
  let elapsed = Infinity;
  /** "cold" until the pipelines have been compiled off the main thread. */
  let warmth = "cold";

  /**
   * Compiles every variant of the height material, off the main thread, at a
   * moment nobody is waiting — called at ATTACH, not when it starts to rain.
   */
  function warmUp(engine) {
    const renderer = engine?.renderer, scene = engine?.scene;
    if (warmth !== "cold" || !renderer || !scene) return;
    warmth = "warming";
    // ⛔⛔ THE RESTORE IS SYNCHRONOUS, AND A `finally` HERE IS A BUG.
    //
    // `scene.overrideMaterial` is GLOBAL. Holding it across the whole of
    // `compileAsync` — hundreds of milliseconds while the driver parses WGSL —
    // means every frame the VIEWPORT draws in that window is drawn with this
    // height ramp: the entire picture turns into a grey gradient and back.
    // That is the user's "everything started blinking bright and dark", and I
    // put it there myself trying to fix something else.
    //
    // Restoring on the next line is correct, and three's own source says why:
    // `compileAsync` walks the scene and RECORDS an item per draw — object,
    // material, camera, lights — in one synchronous pass, and only then awaits,
    // item by item. The first `await` in it comes after the traversal
    // (`this._initialized` is long true in a running editor), so by the time
    // the call returns to us every item is already holding this material.
    const previousOverride = scene.overrideMaterial;
    let compiling = null;
    try {
      scene.overrideMaterial = material;
      compiling = renderer.compileAsync?.(scene, warmCamera);
    } finally {
      scene.overrideMaterial = previousOverride;
    }
    Promise.resolve(compiling)
      .catch((error) => console.warn("[atmosphere] sky occlusion warm-up failed", error))
      .finally(() => { warmth = "warm"; });
  }

  return {
    uniforms,
    target,
    warm: warmUp,
    /**
     * Re-captures when it is worth it. `hidden` is the atmosphere's own root,
     * which must not write itself into the map — rain is not a roof.
     *
     * @returns {boolean} whether this call rendered
     */
    update(engine, { dt = 0, needed = false, hidden = null } = {}) {
      // ⭐⭐ EASED, NOT SWITCHED. `strength` gates the shelter term inside EVERY
      // patched material in the scene, so assigning `needed ? 1 : 0` changed
      // the snow and the wet on the whole world between two frames the instant
      // the accumulators crossed 0.01 — the user's "rain/snow on meshes update
      // in jumps". A second and a half of crossfade costs nothing and is the
      // difference between weather arriving and a switch being thrown.
      const want = needed ? 1 : 0;
      const rate = Math.min(1, Math.max(0, dt) / STRENGTH_EASE);
      uniforms.strength.value += (want - uniforms.strength.value) * rate;
      if (Math.abs(uniforms.strength.value - want) < 0.002) uniforms.strength.value = want;
      if (!needed && uniforms.strength.value <= 0) return false;
      const renderer = engine.renderer, scene = engine.scene, view = engine.camera;
      if (!renderer || !scene || !view) return false;
      // The pipelines are compiled at ATTACH (`warmUp`), off the main thread.
      // Reaching here cold means the component never called it — warm now
      // rather than compiling five variants inside this frame.
      if (warmth === "cold") { warmUp(engine); uniforms.strength.value = 0; return false; }
      if (warmth !== "warm") { uniforms.strength.value = 0; return false; }
      view.getWorldPosition(_position);
      elapsed += dt;
      // ⭐⭐⭐ THE CENTRE IS SNAPPED TO THE TEXEL GRID, AND THIS IS THE WHOLE
      // REASON THE PATTERN USED TO CRAWL.
      //
      // The map is a window that follows the camera. Re-centring it on the raw
      // camera position moves the grid by a fraction of a texel, so every world
      // point lands somewhere new inside its texel and the bilinear answer for
      // ground that has not moved CHANGES — twice a second, everywhere at once.
      // That is what "snow patterns update in jumps" actually was: not the
      // accumulation stepping (that is eased over nine seconds) but the mask
      // under it being re-quantised against a sliding lattice. Snapping to
      // whole texels means the window only ever shifts by whole cells, so a
      // fixed point in the world samples the same cell every capture and the
      // pattern is welded to the ground.
      const snapX = Math.round(_position.x / TEXEL) * TEXEL;
      const snapZ = Math.round(_position.z / TEXEL) * TEXEL;
      const moved = Math.hypot(snapX - center.x, snapZ - center.y);
      // Nothing to do until the window actually shifts a cell. The two-second
      // floor is for geometry that MOVED under a static camera.
      if (moved < TEXEL * 0.5 && elapsed < 2) return false;
      center.set(snapX, snapZ);
      elapsed = 0;
      uniforms.center.value.copy(center);
      camera.position.set(center.x, CEILING, center.y);
      camera.updateMatrixWorld(true);

      const previousTarget = renderer.getRenderTarget();
      const previousOverride = scene.overrideMaterial;
      const previousBackground = scene.background;
      const previousBackgroundNode = scene.backgroundNode;
      const wasVisible = hidden?.visible;
      renderer.getClearColor(_clearColor);
      const previousAlpha = renderer.getClearAlpha();
      // ⚠ EVERYTHING BORROWED IS GIVEN BACK IN A `finally`. This swaps five
      // pieces of shared renderer and scene state; one throw in the middle
      // leaves the scene with no sky and the renderer pointed at a 128×128
      // target, which is a broken editor rather than a missing feature.
      try {
        if (hidden) hidden.visible = false;
        scene.overrideMaterial = material;
        // No sky in a height map: the background would paint the whole texture
        // with a roof at whatever the sky's "height" happened to shade to.
        scene.background = null;
        scene.backgroundNode = null;
        renderer.setRenderTarget(target);
        // Alpha 0 IS "open sky" — see `skyOcclusionHeight`.
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(scene, camera);
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.setClearColor(_clearColor, previousAlpha);
        scene.overrideMaterial = previousOverride;
        scene.background = previousBackground;
        scene.backgroundNode = previousBackgroundNode;
        if (hidden) hidden.visible = wasVisible;
      }
      return true;
    },
    dispose() {
      target.dispose();
      material.dispose();
    },
  };
}

const _position = new THREE.Vector3();
const _clearColor = new THREE.Color();
