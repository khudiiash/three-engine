// GLOBAL ILLUMINATION — THE WHOLE CONFIGURATION, IN ONE TABLE.
//
// The GI component exposes THREE authored lighting controls: the five-point
// `bounce`, `ao`, and `reflections` quality tiers. `quality` remains a hidden
// compatibility alias mirrored from Bounce. Every other number the module runs
// on is here, and this file is the only place any of them is written down.
//
// ══ WHY THERE IS ONLY ONE KNOB ═════════════════════════════════════════════
//
// The component used to declare 27 properties — volume size, voxel size, probe
// spacing, cascade count, bounce energy, bleed saturation, two smoothing rates,
// three AO fields, three resolve budgets, four ray-hit switches, sky colour and
// intensity, boot ambient, a debug view. They accumulated one session at a
// time, each defensible on its own, and together they turned every lighting
// question into a search:
//
//   "GI looks wrong" → which of the 27 is it?
//
// That is the wrong shape for this feature. GI is not a look to be dialled in;
// it is either CORRECT or it is BROKEN, and a knob that can make it wrong is a
// bug generator with a label on it. Resource budgets are a different kind of
// thing: they trade COST against ACCURACY, and every level is supposed to be
// correct. Their legacy tier survives internally rather than in the UI.
//
// ══ WHAT MOVED RATHER THAN DIED ════════════════════════════════════════════
//
// Two things were not tuning knobs and did not belong here in the first place:
//
// · **Sky light** (`skyColor`/`skyIntensity`) is a LIGHT SOURCE, not a dial.
//   It now comes from the scene's own environment — `scene.environment` and
//   `scene.environmentIntensity`, which is where three.js, the Scene Settings
//   panel and the HDRI Environment component already put image-based lighting.
//   GI reads it instead of owning a second, competing copy. See
//   `sceneSkyRadiance` below.
//
// · **The debug view** was never a lighting parameter — it draws an overlay and
//   has no path to the lit image at all. It is a developer instrument, so it
//   moved to `globalThis.__giDebugView` and out of the authored surface.
//
// ══ WHAT ABOUT SCENES THAT ALREADY SAVED THE OLD PROPS? ════════════════════
//
// They load. An undeclared property is ignored, so the extra keys sit inert
// until the next save drops them. A scene that had `intensity: 2` renders at 1
// afterwards, and that is the intended consequence rather than an accident: the
// point of the collapse is that no stored value can be quietly responsible for
// how the lighting looks.
//
// docs/GI_SRC_REBUILD_PLAN.md §6.

/** The presets, in cost order. The one and only authored choice. */
export const GI_QUALITY_LEVELS = ["low", "medium", "high", "ultra"];
const TIERS = new Set(GI_QUALITY_LEVELS);

/**
 * The debug view modes exposed on the GI component, in inspector order.
 *
 * - "off" (default): no overlay.
 * - "indirect": the diffuse-irradiance term only — what the SRC gather
 *   computed, before AO darkens it. What "indirect light" actually IS in this
 *   build, with no contact shading mixed in.
 * - "ao": the obscurance factor (1 = no occlusion, 0 = fully occluded) as a
 *   greyscale. Shipping GTAO provides contact visibility; the optional world
 *   occupancy channel is combined into the same factor. Lets you see what is
 *   darkening your corners.
 * - "reflections": the glossy radiance term only — what mirrors see, before
 *   it gets multiplied by a material's specular response.
 * - "path-tracer": three-gpu-pathtracer's WebGPU backend over the same scene.
 *   Ground truth for "is GI the right energy?", not a GI term. It replaces
 *   the rasterized frame rather than overlaying a buffer.
 *
 * The legacy `sdf` / `occupancy` / `src-probes` modes stay on the global
 * (`globalThis.__giDebugView`) — those touch DIFFERENT data (the SDF distance
 * field, the voxel occupancy pyramid, the SRC probe gizmos) and have never
 * had a component prop.
 */
export const GI_DEBUG_VIEWS = [
  "off",
  "indirect",
  // "ao" is the factor the RESOLVE APPLIES. Shipping uses GTAO alone;
  // `__giWorldAo = true` opts into the experimental occupancy diagnostic,
  // and `__giAoRaytraced = true` replaces GTAO with RTAO.
  "ao",
  // "reflections" is the glossy field WEIGHTED BY FRESNEL, which is what
  // turns it from "a blurry copy of the scene" (the raw buffer holds a
  // radiance at every pixel, including the ~96% of a dielectric surface that
  // never shows it) into the layer the frame actually adds.
  // "reflections-exact" is the traced BVH layer — the sharp arm ultra runs,
  // which no view could show before.
  "reflections",
  "reflections-exact",
  "path-tracer",
];
const DEBUG_VIEWS = new Set(GI_DEBUG_VIEWS);
/**
 * The subset drawn by the fullscreen TERM overlay (`#buildDebugView`), as
 * opposed to the volume/gizmo views ("sdf", "occupancy", "src-probes")
 * that are console-only, and "path-tracer" which is a live renderer rather
 * than a buffer sample. Kept beside the list so adding a mode to one and
 * not the other is impossible.
 */
export const GI_TERM_DEBUG_VIEWS = new Set(
  GI_DEBUG_VIEWS.filter((v) => v !== "off" && v !== "path-tracer"),
);

/**
 * The tier a stored value selects for.
 *
 * Unrecognised — an old scene's "custom", a typo, an unset field — resolves to
 * "medium", the component's own default. It used to resolve to "high", which
 * made a corrupt value the most expensive setting; with the advanced fields
 * gone there is no "custom" to mean "hand-edited" any more, so the honest
 * fallback is the default rather than the ceiling.
 */
export function giQualityTier(quality) {
  return TIERS.has(quality) ? quality : "medium";
}

/** Persisted GI term controls are five exact radio levels. Booleans remain
 * accepted so scenes authored with the previous on/off UI migrate losslessly. */
export function giTermLevel(value, fallback = 1) {
  if (value === false) return 0;
  if (value === true) return 1;
  const numeric = Number(value);
  const clamped = Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : fallback;
  return Math.round(clamped * 4) / 4;
}

/** Map a persisted five-point rail value to Off/null or a real quality tier. */
export function giTermTier(value, fallback = 1) {
  const level = giTermLevel(value, fallback);
  return level <= 0 ? null : GI_QUALITY_LEVELS[Math.round(level * 4) - 1];
}

function maxTier(...tiers) {
  let best = "low";
  for (const tier of tiers) {
    if (tier && GI_QUALITY_LEVELS.indexOf(tier) > GI_QUALITY_LEVELS.indexOf(best)) best = tier;
  }
  return best;
}

/**
 * Screen-space AO resolution is a quality property, not a fixed performance
 * shortcut. Ultra and High keep one AO estimate per resolve pixel because AO
 * is cheap relative to the rest of GI and magnifying its spatial pattern is a
 * disproportionate visual loss. Medium keeps most of that detail at 0.8;
 * only Low takes the half-resolution path. The global override is
 * intentionally accepted by the caller and routed through here so probes can
 * still sweep the whole 0.25..1 range without changing presets.
 */
export function giGtaoResolutionScale(quality, requested = Number.NaN) {
  const override = Number(requested);
  if (Number.isFinite(override)) return Math.min(1, Math.max(0.25, override));
  // §11.35: on ultra/high the scale is relative to the AO g-buffer — the
  // VIEWPORT's resolution (capped at GI_AO_MAX_PIXELS) — since that is where
  // the prepass renders on those tiers; medium/low keep the resolve's
  // g-buffer as their source, so their scales are unchanged in pixels.
  return { low: 0.5, medium: 0.8, high: 0.75, ultra: 1 }[giQualityTier(quality)];
}

/**
 * GTAO coverage by quality tier. Ultra evaluates five fixed angular slices at
 * every full-resolution pixel while retaining stable radial strata
 * across neighbours; this avoids both angular stipple and repeated edge bands
 * without temporal reuse. Quarter-rate tiers distribute both dimensions.
 */
export function giGtaoSamplingPreset(quality) {
  switch (giQualityTier(quality)) {
    // §11.35: the filter is ±2 at the VIEWPORT's resolution now (the AO
    // buffer is the viewport on ultra/high) — r3 was sized for a half-res
    // buffer, where it was already a ±6 viewport-pixel blur.
    case "ultra": return { slices: 5, steps: 4, spatialJitter: false, filterRadius: 2 };
    case "high": return { slices: 3, steps: 3, spatialJitter: true, filterRadius: 2 };
    case "medium": return { slices: 2, steps: 3, spatialJitter: true, filterRadius: 2 };
    default: return { slices: 2, steps: 2, spatialJitter: true, filterRadius: 2 };
  }
}

/**
 * AO reach in cascade-0 intervals — FOUR (2.24 m at s0 0.35), §11.35.
 *
 * The history, because this number has moved three times: two intervals
 * (1.12 m) once read as a detached duplicate silhouette around props — at
 * HALF resolution with a ±3 texel filter, i.e. a 12-viewport-pixel blur of
 * the contact ring; it was cut to one interval (0.56 m, "contact only") on
 * the argument that SRC carries the longer-range visibility. The user's
 * verdict on Bistro against the path tracer: "blurry, low radius" — at
 * Bistro's viewing distances one interval is a few pixels wide, and the
 * arches, eaves and balconies that the tracer darkens over metres got
 * nothing. With the AO at the viewport's resolution and a ±2 px filter,
 * four intervals was judged "now its good" live on Bistro (2026-09-04).
 * `__giGtaoIntervals` overrides for an A/B.
 */
export function giGtaoRadiusIntervals(requested = Number.NaN) {
  const value = Number(requested);
  return Math.max(0.5, Math.min(8, Number.isFinite(value) && value > 0 ? value : 4));
}

/**
 * The most expensive tier THIS DEVICE is allowed to run, or null for "no
 * ceiling" (every desktop GPU).
 *
 * WHY A CEILING RATHER THAN A SECOND LADDER: every cost a preset controls is
 * keyed on the tier NAME (see BY_TIER's note — `QUALITY_BUDGETS` for
 * cells/probes, the trace step ladder, `AUTO_MODE_BY_QUALITY`, `SRC_QUALITY`
 * for s₀/rays/w₀). Clamping the name therefore moves all of them at once, and
 * cannot drift from them the way a parallel set of mobile constants would.
 *
 * WHAT IT IS FOR. There was no platform tier at all, so a phone and a laptop
 * on battery ran the tier the scene authored on a desktop — at `ultra` that is
 * 393,216 transport rays per frame against an occupancy field sized from a
 * 2.8M-cell budget. Two user-visible consequences:
 *
 *  · MOBILE: GI allocation is measured in hundreds of MB per build (a real
 *    scene reached 449MB of occupancy bits alone) and the JS/GPU retention per
 *    rebuild is ~2GB; a device that runs out does not fail politely, it is
 *    LOST, and every pipeline with it — reported as "everything disappears,
 *    only the HDRI sky remains", because the sky is drawn by the background
 *    and needs none of the pipelines that just died.
 *  · SAFARI/APPLE: WebGPU there generally lands on an integrated GPU, and the
 *    same workload runs at a small fraction of the speed. `medium` keeps the
 *    transport and the half-res resolve while dropping the exact-BVH
 *    reflections and the biggest ray budgets.
 *
 * `__giDeviceTier` overrides the detection — `null`/`"none"` removes the
 * ceiling, a tier name forces one. Harnesses need it (headless Chrome on a
 * desktop detects no ceiling, so every existing gate is unaffected either way)
 * and so does anyone reproducing a phone's tier on a workstation.
 */
export function giDeviceTierCeiling(runtime = globalThis) {
  const forced = runtime?.__giDeviceTier;
  if (forced === null || forced === "none") return null;
  if (TIERS.has(forced)) return forced;
  const nav = runtime?.navigator;
  if (!nav) return null;
  const ua = String(nav.userAgent ?? "");
  // `userAgentData.mobile` is the only non-heuristic answer; the UA regex is
  // the fallback for the engines that do not ship it (every WebKit today).
  // iPadOS reports a desktop UA, hence the touch-points clause: a Mac has
  // maxTouchPoints 0, an iPad reports 5.
  const isMobile = nav.userAgentData?.mobile === true
    || /Android|iPhone|iPod|Mobile|Windows Phone/i.test(ua)
    || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  if (isMobile) return "low";
  // Safari and every other WebKit shell: "Safari" with no Chrome/Chromium
  // token. Chromium's UA carries Safari too, which is why both are excluded.
  const isAppleWebKit = /Apple/.test(String(nav.vendor ?? ""))
    && /Safari/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  if (isAppleWebKit) return "medium";
  return null;
}

let warnedClamp = false;

/** `tier` clamped to `ceiling` using GI_QUALITY_LEVELS' cost order. */
function clampTier(tier, ceiling) {
  if (!ceiling) return tier;
  const want = GI_QUALITY_LEVELS.indexOf(tier);
  const cap = GI_QUALITY_LEVELS.indexOf(ceiling);
  return want > cap ? ceiling : tier;
}

/**
 * Values that do NOT vary by preset, at exactly the defaults the 27-property
 * component shipped.
 *
 * Holding them constant is what makes the collapse provably a surface change:
 * the emitter-shadow probe and the GPU smoke must produce identical numbers
 * across it. Any decision to let a tier turn one of these on belongs in its own
 * commit, with the measurement that justifies it.
 *
 * Several are constant because the feature they name is PARKED — the dense
 * radiance cascades were deleted in the SRC rebuild (plan §12.8) and Split
 * Radiance Cascades restores the consumers in Phase 3-5. `bounce`,
 * `bleedSaturation`, `temporalBlend` and `probeSmoothing` are those. They stay
 * wired at their old defaults so the code paths that read them keep compiling
 * and mean the same thing when the transport returns.
 */
const CONSTANT = {
  // The volume always fits the scene. Manual size/voxel/spacing fields are
  // gone: auto-fit derives all three from the quality budget (GISystem's
  // QUALITY_BUDGETS), and a hand-set volume is exactly the kind of stored
  // value that silently stops matching the scene it was authored against.
  autoFit: true,

  // Artistic gain on indirect light, OUTSIDE the bounce loop. 1 = physical,
  // and physical is the only setting a correctness-shaped feature should have.
  intensity: 1,

  // Parked with the dense transport (plan §12.8). Kept at their defaults.
  bounce: 1,
  bleedSaturation: 1,
  temporalBlend: 0.25,
  probeSmoothing: 0.02,

  // GI reflections — the glossy radiance chain, the materials' specular
  // sample of it, and (at ultra) the exact-BVH mirror path. AUTHORABLE since
  // 2026-08-21: the component declares a `reflections` toggle (see
  // resolveGiConfig below), because "no reflections" is a look/cost CHOICE
  // in the same class as `quality` — it removes a term wholesale, it cannot
  // mis-tune one.
  reflections: true,

  // "auto" follows the preset through RayHitConfig's AUTO_MODE_BY_QUALITY —
  // since §10 (2026-09-02) every tier resolves to "bvh": the field-less build
  // that traces the static BVH8 + movers and allocates no occupancy pyramid.
  // The named occupancy modes are still implemented and still reachable from
  // a harness or the component prop; they are simply not an authored choice,
  // because "which intersection test does my lighting use" is not a question
  // a scene should have an opinion about.
  rayHitMode: "auto",
  rayHitProfiling: false,
  rayHitSkipDistance: true,

  // The emitter SYSTEM — despite the name, this gates far more than shadow
  // rays: the MAX_EMITTERS uniform slots, the per-frame promotion of emissive
  // meshes into them, the analytic receiver-direct term, and the slots SRC's
  // hit shader samples with NEE (`useNee = emitters.length > 0` is a
  // BUILD-time decision in srcShade.js).
  //
  // ON, and under SRC it cannot be otherwise: the promotion set is the NEE set
  // AND the analytic-direct set (R5, plan §12.29 — bake-time zeroing hands an
  // emitter's energy to exactly these two consumers), so with the slots absent
  // an emissive mesh's light is deleted from BOTH paths. That was the shipped
  // state this line fixes: "emissives do not work" (user, 2026-08-11) — SRC
  // compiled with `emitters: []` and the boot line read "4 lights, 0 emitters".
  //
  // What OFF used to buy is still bought elsewhere: with zero PROMOTED
  // emitters the warm-up skips the emitter-shadow chain outright and the
  // per-frame skips drop the trace and its bilateral (the "CAPABILITY IS NOT
  // USE" checks in GISystem) — so a scene with no emissive meshes pays
  // uniforms, not passes. Session 38's frame-cost concern was the cost of
  // emitters that EXIST, which is the feature working, not overhead.
  // `__giConfigOverride = { emissiveShadows: false }` remains the hatch.
  emissiveShadows: true,

  // Indirect-only ambient occlusion. The shipping `createGiGtaoPass` solves
  // CONTACT visibility from the full-resolution gbuffer. SRC already carries
  // long-range blocker visibility, so the occupancy-world experiment is OFF
  // by default: it removed bounce energy, printed a broad low-frequency mask,
  // and paid another trace for visibility transport already owns.
  // `__giWorldAo = true` is the explicit diagnostic opt-in. It remains outside
  // resolve, binding the existing occupancy buffer only in the AO kernel and
  // staying inside the portable storage-buffer budget.
  // AO still only modulates INDIRECT diffuse lighting; direct light and exact
  // reflection rays retain their traced visibility.
  // `__giConfigOverride = { ao: false }` is the measurement hatch, and the
  // component declares an `ao` toggle (same argument as `reflections`).
  ao: true,
  // 0.8/0.8 since the first live look (2026-08-21, "AO is quite weak"):
  // 0.6/0.6 was tuned against the rig; on real scenes the emitter-direct
  // share leaves the indirect term — the only thing AO modulates — carrying
  // less of the image, so the ceiling has to work harder to read at all.
  //
  // `aoRadius` is retained as the component/config mirror, but the shipping
  // GTAO radius is derived from cascade-0 spacing in #armGtaoPass; metre-scale
  // constants cannot track scenes with different lattice scales. Strength is
  // live; `__giVxaoOverride = {strength}` is the shipping-pass measurement
  // hatch (the slot name is historical).
  // 0.85 → 0.75 same night: with the union actually engaging both rings,
  // 0.85 over-darkened the shadowed side ("started to look bad") — the
  // ceiling now works against a term that finally reaches it.
  aoStrength: 0.75,
  aoRadius: 0.5,

  // Cost CEILINGS in total pixels, not quality levels — what the machine can
  // afford. The resolve is sized from the drawing buffer, so a maximized 4K
  // viewport would otherwise quadruple the traced pixel count at an unchanged
  // scale (measured 9ms → 22ms GPU). Past the budget the resolve shrinks
  // isotropically and the position-validated bilateral reconstructs the edges.
  resolveMaxPixels: 1_600_000,
  lightShadowMaxPixels: 1_900_000,

  // A placeholder hemisphere while the field builds. OFF: it adds a light the
  // scene does not contain, with no outliner row, so the only honest default is
  // one nobody gets by surprise.
  bootAmbient: false,
};

/**
 * What each preset actually buys. Two entries — and the shortness is the point.
 *
 * Everything else a preset controls is already keyed on the tier NAME further
 * down (GISystem's `QUALITY_BUDGETS` for cells/probes/probe-axis, its trace
 * step ladder, `RayHitConfig`'s AUTO_MODE_BY_QUALITY, `SRC_QUALITY` for s₀,
 * rays-per-pixel and w₀). Duplicating those here would be a second definition
 * of the same ladder, which is how this module got 27 properties in the first
 * place.
 */
const BY_TIER = {
  // Half-res resolve. GI-traced light shadows and AO are computed at this
  // resolution, so their edges blend across silhouettes when upsampled — "bad
  // corners" under a bright sun. Ultra pays ~4× the resolve to remove it.
  // `resolveMaxPixels` (2026-09-11): the pixel CEILING is a tier property
  // too. One 1.6 M ceiling for every tier meant the presets stopped changing
  // anything past ~1440p — on the user's 2872×1532 browser canvas low, medium
  // and high all resolved 1.1 M pixels and ultra 1.6 M, so "changing GI
  // quality does not change fps". Every screen pass and the transport's
  // population are per-resolve-pixel (measured: halving the ceiling took
  // 5.8 ms off a 17.5 ms compute frame), so the ceiling IS the preset's cost
  // on a large screen. Below the ceiling nothing changes: a 1570×962 editor
  // viewport resolves 0.38 M at low–high and 0.75 M at ultra, under every
  // value here. The position-validated bilateral reconstructs the edges.
  low: { resolveScale: 0.5, exactReflections: false, resolveMaxPixels: 400_000 },
  medium: { resolveScale: 0.5, exactReflections: false, resolveMaxPixels: 600_000 },
  // HIGH TAKES EXACT REFLECTIONS TOO (2026-08-22, with §14 R-A). The old
  // "ultra only" line was priced when hit shading lived inside the resolve
  // (the 66 ms register-pressure receipt); in its own pass, high's half-res
  // resolve runs the prepass + hit shade at a quarter of ultra's pixels,
  // and the consumer gate (#bvhReflectionsEnabled) still keeps every
  // mirror-less scene from paying anything. The driver was user-visible: a
  // FLAT authored mirror can never resolve through a reflection probe (the
  // oct-tile magnification limit) — at high it either gets the exact arm or
  // it gets mush. Low/medium stay probes-only: that is still the
  // 100-200ms-workload protection for the tiers defined as cheap.
  high: { resolveScale: 0.5, exactReflections: true, resolveMaxPixels: 900_000 },
  // Ultra keeps twice HIGH's screen-sample budget (0.7071² / 0.5² = 2), but
  // no longer traces every physical display pixel. Bistro's 1.6M-pixel full
  // resolve spent 25–40 ms in screen-sized GI work alone; the position/normal
  // validated reconstruction already used by every cheaper tier preserves
  // silhouettes while this scale nearly halves resolve, AO, shadow and exact-
  // reflection pixels. This is the tier's bounded performance contract: more
  // samples than HIGH, full world/probe/ray quality, never an unbounded 1:1
  // screen-space bill.
  ultra: { resolveScale: Math.SQRT1_2, exactReflections: true, resolveMaxPixels: 1_600_000 },
};

/**
 * The resolve ceiling on a PORTABLE device (the device tier ceiling is set —
 * a phone or an Apple WebKit). The user's iPhone ran the Sponza build at
 * 20 fps: at the mobile "low" ceiling a 1704×786 canvas still resolves
 * 0.33 M GI pixels, and the screen chain that costs ~2.5 ms on a laptop 4070
 * at that size is the whole frame on a phone GPU. `__giResolveMaxPixels`
 * still overrides.
 */
const GI_MOBILE_RESOLVE_MAX_PIXELS = 250_000;
/** The world transport's ceiling on a portable device, Hz (see `worldUpdateHz` below). */
const GI_MOBILE_WORLD_UPDATE_HZ = 15;
/**
 * The transport's ray budget on a portable device, as a scale on the tier's
 * ceiling and per-probe cap (see `worldRayScale` below). 0.35 is the scale
 * §11.9 already applies under camera motion — the budget the temporal
 * accumulation is known to average without visible noise.
 */
const GI_MOBILE_WORLD_RAY_SCALE = 0.35;

/** The lower of two tier names (null = no ceiling). */
function minTier(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return GI_QUALITY_LEVELS.indexOf(a) <= GI_QUALITY_LEVELS.indexOf(b) ? a : b;
}

/**
 * The settled configuration for a component's props.
 *
 * Returns a PROPS-SHAPED object on purpose: every existing consumer
 * (`qualityTierOf`, `resolveRayHitConfig`, `#structuralSignature`,
 * `createSrcProbeSystem`) already reads these key names, so the collapse swaps
 * WHICH object they read rather than rewriting what they do with it.
 *
 * Frozen, because the entire premise is that nothing downstream gets to have an
 * opinion — a consumer that wants a different value has to come here and say so
 * where everyone can see it.
 */
export function resolveGiConfig(props, runtime = globalThis, { qualityCeiling = null } = {}) {
  const deviceCeiling = giDeviceTierCeiling(runtime);
  // The BUILD's quality preset (`engine.config.quality`, set by the player
  // from the export's `player.quality`) is a ceiling on the GI tiers exactly
  // as `applyQualityCeiling` makes it one on the renderer: a preset can only
  // make a build cheaper than authored, and "ultra" is "as authored". The
  // editor passes nothing here.
  const buildCeiling = TIERS.has(qualityCeiling) && qualityCeiling !== "ultra" ? qualityCeiling : null;
  const ceiling = minTier(deviceCeiling, buildCeiling);
  // Runtime pins on the three rails, for an A/B without a scene edit
  // (`?flags={"__giReflectionsLevel":0}` on a phone, `profile.giFlag` in the
  // editor). A pin is read exactly like the authored value; unset = authored.
  const pinLevel = (name, authored) => {
    const v = Number(runtime?.[name]);
    return Number.isFinite(v) && runtime?.[name] !== null ? giTermLevel(v, 1) : authored;
  };
  const bounceLevel = pinLevel("__giBounceLevel", giTermLevel(props?.bounce, 1));
  const aoLevel = pinLevel("__giAoLevel", giTermLevel(props?.ao, 1));
  const reflectionsLevel = pinLevel("__giReflectionsLevel", giTermLevel(props?.reflections, 1));
  const authoredBounce = giTermTier(bounceLevel) ?? "low";
  const authoredAo = giTermTier(aoLevel) ?? "low";
  const authoredReflections = giTermTier(reflectionsLevel) ?? "low";
  const bounceQuality = clampTier(authoredBounce, ceiling);
  const aoQuality = clampTier(authoredAo, ceiling);
  const reflectionsQuality = clampTier(authoredReflections, ceiling);
  const screenQuality = maxTier(
    bounceLevel > 0 ? bounceQuality : null,
    aoLevel > 0 ? aoQuality : null,
    reflectionsLevel > 0 ? reflectionsQuality : null,
  );
  const settled = {
    quality: bounceQuality,
    ...CONSTANT,
    ...BY_TIER[bounceQuality],
    resolveScale: BY_TIER[screenQuality].resolveScale,
    // The pixel ceiling follows the SCREEN tier (the one that sizes the
    // resolve), and a portable device gets the mobile ceiling under it.
    resolveMaxPixels: deviceCeiling
      ? Math.min(BY_TIER[screenQuality].resolveMaxPixels, GI_MOBILE_RESOLVE_MAX_PIXELS)
      : BY_TIER[screenQuality].resolveMaxPixels,
    exactReflections: reflectionsLevel > 0 && BY_TIER[reflectionsQuality].exactReflections,
    // ── THE WORLD CHAIN ON A PHONE IS A BURST, NOT A RATE (2026-09-11) ──
    // The transport's ~70 kernels land in ONE frame. On the user's iPhone the
    // Sponza build read 55 fps until the chain's pipelines finished compiling
    // and 30 from then on: every chain frame overran 16.7 ms and the browser
    // halved requestAnimationFrame. A phone-shaped ledger on the desktop
    // prices one low-tier chain at ~1.35 ms of RTX 4070 — about a frame's
    // worth on a phone GPU. So on the device tier the chain is (a) capped at
    // 15 Hz whatever the light-motion drive asks (a sun moves slowly; 15 Hz
    // is the rate the drive settles to at rest anyway) and (b) split at the
    // deposit's trace into two frames (§11.45, opt-in elsewhere because it
    // trades chains-per-second). `__giWorldSplit` / `__giWorldUpdateHz`
    // still override either way.
    worldUpdateHz: deviceCeiling ? GI_MOBILE_WORLD_UPDATE_HZ : null,
    worldSplit: !!deviceCeiling,
    // (c) THE RAYS THEMSELVES (2026-09-11, the phone's own ledger via
    // `?hud=1`): on the user's iPhone one low-tier chain dispatch read ~19 ms
    // of GPU — a third of a 45 ms frame at 15 Hz — and three quarters of a
    // chain is the trace + shade, which are per-ray. The rate cap and the
    // split only move that burst around; this shrinks it. Applied as the
    // §11.9 motion scale is (uniform writes on the ceiling and the per-probe
    // cap, no rebuild), so the steady state is the same field converged from
    // fewer rays per tick. `__giMobileRayScale` pins (1 = off).
    worldRayScale: deviceCeiling ? GI_MOBILE_WORLD_RAY_SCALE : 1,
    bounceLevel,
    aoLevel,
    reflectionsLevel,
    bounceQuality,
    aoQuality,
    reflectionsQuality,
    bounce: bounceLevel > 0,
    ao: aoLevel > 0,
    reflections: reflectionsLevel > 0,
  };
  if (bounceQuality !== authoredBounce || aoQuality !== authoredAo || reflectionsQuality !== authoredReflections) {
    settled.qualityClampedFrom = maxTier(authoredBounce, authoredAo, authoredReflections);
    // Once per session, not per rebuild: a scene looking different on a phone
    // than on the desktop it was authored on has to be explainable from the
    // console, or it reads as GI being broken on that device.
    if (!warnedClamp) {
      warnedClamp = true;
      console.info(
        deviceCeiling && ceiling === deviceCeiling
          ? `[gi] one or more GI term qualities were clamped to ${ceiling} for this device ` +
            `(mobile/Apple WebKit tier ceiling — __giDeviceTier = null removes it)`
          : `[gi] one or more GI term qualities were clamped to ${ceiling} by the build's quality preset ` +
            `(Build settings → Quality; "ultra" ships the scene as authored)`,
      );
    }
  }
  // Zero gates the corresponding term. Nonzero positions select real sampling
  // tiers; they are never interpreted as brightness/strength multipliers.
  if (!settled.reflections) {
    // No reflections means ALL of them — the ultra tier's exact-BVH mirrors
    // are a reflection before they are a tier feature.
    settled.exactReflections = false;
  }
  // ── THE MEASUREMENT HATCH, AND WHY IT IS NOT A KNOB SURFACE ──────────────
  //
  // `globalThis.__giConfigOverride = { emissiveShadows: true }` forces any of
  // the values above. Probes need it: the emitter-shadow probe measures a
  // feature no preset turns on, and without a way to force it the probe reads
  // back a render target that was never built.
  //
  // This is the same category as the fifteen `__gi*` flags this module already
  // carries (`__giRayHitMode`, `__giNoBvhReflections`, `__giSrcProbes`, …) and
  // deliberately NOT the category the collapse removed: it is not authored, not
  // serialized, not in the Inspector, and not reachable from a scene. A stored
  // property is a value someone set months ago and forgot; a global set two
  // lines above the measurement that needs it is a different thing entirely.
  //
  // ONE hatch rather than one global per field, so the list cannot quietly grow
  // back into a parameter surface — anything a probe forces is visible at the
  // probe's own call site as a named object.
  const override = runtime?.__giConfigOverride;
  if (override && typeof override === "object") Object.assign(settled, override);
  return Object.freeze(settled);
}

/**
 * SKY RADIANCE FROM THE SCENE — what a GI ray brings back when it escapes
 * without hitting anything.
 *
 * Two sources, in priority order, both written by Scene Settings (and the
 * legacy HDRI Environment component):
 *
 * 1. `scene.environment` — three.js's image-based light, scaled by
 *    `environmentIntensity`. The texture's CHROMA is still not read (an
 *    environment map's average colour needs a 1×1 downsample of the cube map),
 *    so an HDRI contributes NEUTRAL sky at the right brightness. Per-direction
 *    colour belongs to the directional-sky bundle (`_giSkyEnvIntensityU`).
 *
 * 2. NO ENVIRONMENT TEXTURE — the scene's flat BACKGROUND COLOUR is the sky.
 *    A colour needs no downsampling, so its chroma IS read here. This is the
 *    user's "no hdri sky → use the background colour as sky" rule (2026-08-30):
 *    every scene already shows the colour behind its geometry, and GI lighting
 *    the escapes with what the camera can plainly see is the honest default.
 *    The colour is multiplied by `environmentIntensity` too — the same one
 *    intensity knob both shapes share (sceneSettings writes it even on the
 *    colour path, where three itself ignores it because there is no IBL).
 *
 * The one gate: `environment.lighting` must be ON (Scene Settings' "Use for
 * lighting"). It is threaded in by GISystem from `engine.settings` because a
 * scene with the toggle off must read exactly 0 — the "sky = 0 asserts exactly
 * 0 lit pixels" gates (gi-gpu-smoke) exist because light from nothing is the
 * failure signature this module has shipped three times, and every GI fixture
 * sets `lighting: false` to keep them honest. A caller that passes no settings
 * (a raw three scene) gets the default-on, matching SCENE_SETTINGS_DEFAULTS.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.Color} out  written in place — this runs per frame
 * @param {{lighting?: boolean}|null} [envSettings]  scene settings `.environment`
 */
export function sceneSkyRadiance(scene, out, envSettings = null) {
  const environment = scene?.environment;
  const intensity = Math.max(0, scene.environmentIntensity ?? 1);
  if (environment) return out.setRGB(intensity, intensity, intensity);
  const lighting = envSettings ? envSettings.lighting !== false : true;
  const background = scene?.background;
  if (lighting && background?.isColor === true) {
    return out.setRGB(background.r * intensity, background.g * intensity, background.b * intensity);
  }
  return out.setRGB(0, 0, 0);
}

/** World direction -> environment lookup uses the inverse of the sky's yaw.
 * Three's background/IBL and the path tracer invert their rotation matrices;
 * all GI sky, reflection-miss and probe-capture samplers share this angle. */
export function giEnvironmentLookupYaw(rotationY = 0) {
  return -(Number(rotationY) || 0);
}

/**
 * The debug overlay, as a developer switch rather than an authored property.
 *
 * "off" | "sdf" | "occupancy" | "src-probes" | "indirect" | "ao" |
 * "reflections" | "path-tracer". Set `globalThis.__giDebugView` from the console or a
 * harness. Polled rather than pushed — every reader is already in a per-frame
 * path, and a string compare per frame is cheaper than the change notification
 * would be.
 *
 * The "indirect" / "ao" / "reflections" / "path-tracer" modes are also reachable from the GI
 * component's `debugView` prop, which is what an inspector user actually wants
 * (a checkbox beats typing a global). The component prop is a SECOND-PRIORITY
 * source — `globalThis.__giDebugView` still wins, because a harness that
 * forces a mode has no component to read from and a console override has to
 * beat the inspector or nothing can ever step in front of it.
 */
export function giDebugView(component = null) {
  // The global is a CONSOLE SWITCH, not a persistent setting. Treating
  // `"off"` as an override (rather than as "no override") makes a stale
  // `__giDebugView = "off"` from a previous test arm beat the inspector's
  // prop, which is the worst outcome — the visible inspector control does
  // nothing. The convention: the global only wins when it asks for SOMETHING
  // non-default. A harness that needs to suppress the inspector path should
  // `delete globalThis.__giDebugView`, not set it to "off".
  const override = globalThis.__giDebugView;
  if (typeof override === "string" && override !== "off") return override;
  const propValue = component?.props?.debugView;
  if (typeof propValue === "string") return propValue;
  return "off";
}
