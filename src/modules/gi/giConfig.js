// GLOBAL ILLUMINATION — THE WHOLE CONFIGURATION, IN ONE TABLE.
//
// The GI component declares THREE authored properties: `quality`, plus the
// `ao`/`reflections` feature toggles (2026-08-21 — see resolveGiConfig).
// Every other number the module runs on is here, and this file is the only
// place any of them is written down.
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
// bug generator with a label on it. A quality preset is a different kind of
// thing: it trades COST against ACCURACY, and every level of it is supposed to
// be correct. So `quality` survives and nothing else does.
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
 * ⭐ §19 4.3f — THE DEBUG VIEW MODES, AND WHICH PATH EACH ONE HAS A SOURCE ON.
 *
 * Every mode is listed here ONCE, with the description the inspector and the
 * console both print, and with the paths it can actually draw on. A mode that
 * has no source on the live path is not hidden from the list — it is offered,
 * and selecting it prints the reason it cannot draw. The alternative (a shorter
 * list) makes "the mode I remember is gone" indistinguishable from "the build
 * is broken", and this module has shipped both.
 *
 * `paths`: "both" | "src" | "gi2". Nothing here is a knob — the whole set is a
 * developer instrument, and `debugView` was already the one advanced property.
 */
export const GI_DEBUG_VIEW_MODES = [
  { id: "off", paths: "both", doc: "no overlay — the lit frame" },
  {
    id: "indirect",
    paths: "both",
    doc: "the diffuse term the materials build, at white albedo (E/π) — GI2's gather output, or the SRC resolve's",
  },
  {
    id: "ao",
    paths: "both",
    doc: "the obscurance factor the resolve applies (1 = open, 0 = closed), sRGB-decoded so the grey IS the number",
  },
  {
    id: "reflections",
    paths: "both",
    doc: "the glossy radiance the frame adds, Fresnel-weighted against the g-buffer (a dielectric shows ~4% head-on)",
  },
  {
    id: "reflections-exact",
    paths: "src",
    doc: "the traced BVH mirror layer, undimmed — ultra's sharp arm; there is no mirror tier on GI2 yet",
  },
  {
    id: "occupancy",
    paths: "both",
    doc: "the voxel world the rays see — GI2 traces the window per pixel and shows palette albedo, face-shaded; SRC marches the occupancy pyramid",
  },
  {
    id: "sdf",
    paths: "both",
    doc: "GI2: hit distance as brightness, the window LEVEL that answered as hue; SRC: the distance oracle, sphere-traced",
  },
  {
    id: "src-probes",
    paths: "both",
    doc: "the probe population: GI2 draws the WORLD lattice cell frame on the geometry (or the screen-probe tile grid when `__gi2WorldProbes` is off); SRC draws the probe gizmo cloud",
  },
];

/** Mode id → its one-line description. */
export const GI_DEBUG_VIEW_DOC = Object.fromEntries(GI_DEBUG_VIEW_MODES.map((m) => [m.id, m.doc]));

/**
 * The debug view modes exposed on the GI component, in inspector order.
 *
 * ⚠ THE WHOLE SET IS ON THE PROP NOW (§19 4.3f). "occupancy", "sdf" and
 * "src-probes" used to be console-only (`globalThis.__giDebugView`) because
 * they touched DIFFERENT data — the SDF distance field, the voxel occupancy
 * pyramid, the SRC probe gizmos — and had never had a component prop. Under
 * GI2 all three are rebuilt off the WINDOW (`window/windowDebugView.js`), the
 * inspector is where a person actually looks for them, and `giDebugView` merges
 * the two sources anyway. The global still wins; see `giDebugView`.
 */
export const GI_DEBUG_VIEWS = GI_DEBUG_VIEW_MODES.map((m) => m.id);
const DEBUG_VIEWS = new Set(GI_DEBUG_VIEWS);

/**
 * The modes that can DRAW on the path this build runs, in inspector order.
 *
 * Used for the component's `options` (the Inspector accepts a function, so the
 * dropdown is resolved when the panel opens rather than when the class loads)
 * and for the console receipt. A mode outside this list is still selectable
 * through the global — it just says why it cannot draw.
 */
export function giDebugViewsFor(gi2 = GI2_PATH) {
  return GI_DEBUG_VIEW_MODES
    .filter((m) => m.paths === "both" || m.paths === (gi2 ? "gi2" : "src"))
    .map((m) => m.id);
}

/** The VOLUME views — one quad under GI2, two boxes plus a gizmo cloud under SRC. */
export const GI_VOLUME_DEBUG_VIEWS = new Set(["occupancy", "sdf", "src-probes"]);

/**
 * The subset drawn by the fullscreen TERM overlay (`#buildDebugView`), as
 * opposed to the volume views above. Kept beside the list so adding a mode to
 * one and not the other is impossible.
 */
export const GI_TERM_DEBUG_VIEWS = new Set(
  GI_DEBUG_VIEWS.filter((v) => v !== "off" && !GI_VOLUME_DEBUG_VIEWS.has(v)),
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

/**
 * ══ §19 STAGE 0.4 — THE TIER GPU BYTE BUDGET (INTERIM) ═════════════════════
 *
 * What GI is allowed to allocate on the GPU, per tier, BEFORE it allocates it:
 * the occupancy `bits` buffer + the SRC bin store + the screen targets.
 *
 * ⚠ INTERIM, AND DELIBERATELY GENEROUS. GI2's own table (plan §4.6) is 48 MB
 * at phone-low and 192 MB at ultra — an order of magnitude under these. These
 * numbers are sized for the CURRENT architecture, whose `bits` buffer alone
 * measures 321-491 MB on a real ultra scene, and their only job is to make the
 * degrade ladder run BEFORE the allocation instead of after the device is
 * lost. Tightening them toward §4.6 is GI2's work, not a tuning knob.
 *
 * ⚠ NOT A PROPERTY. Nothing reads this from a scene, a component or a global —
 * it is keyed on the tier the device already resolved to, which is the whole
 * argument of [[gi-one-property]]: a budget the author can raise is a budget
 * that gets raised until the device dies.
 *
 * The low rung is what a `device.lost` tier drop lands on, and 192 MB is
 * chosen against Safari's 256 MB `maxBufferSize` floor and the 350-450 MB page
 * memory of an iPhone 14 or older — GI must fit inside a page that also holds
 * the scene's textures and geometry.
 */
export const GI_TIER_GPU_BUDGET_BYTES = Object.freeze({
  low: 192 * 1024 * 1024,
  medium: 384 * 1024 * 1024,
  high: 768 * 1024 * 1024,
  ultra: 1536 * 1024 * 1024,
});

/**
 * ══ §19 STAGE 0.4 — `unrestricted_pointer_parameters` ══════════════════════
 *
 * WGSL's baseline forbids a user function from taking a pointer INTO a storage
 * (or uniform/workgroup) address space as a parameter; the
 * `unrestricted_pointer_parameters` language feature lifts that. This module
 * writes raw WGSL (`wgslFn`) in nine places that do exactly that, and they are
 * not decoration — they are the hash table every probe is inserted through and
 * every exact-geometry traversal:
 *
 *   srcProbes.js:274, 320       srcHashInsert / srcHashFind (`array<atomic<u32>>`)
 *   dynamicObjects.js:608, 716, 838, 976   the mover BVH4 traversals
 *   bvh/bvhScene.js:215-218     the static scene BVH8 traversal
 *
 * The failure is silent in the direction that matters: a pipeline that fails
 * WGSL validation dispatches nothing and, under WebKit, logs nothing (319770).
 * So the feature is READ, once, rather than discovered from a black frame.
 *
 * ⛔ THE PROBE HASH IS NOT OPTIONAL. Turning off the exact dynamic objects and
 * the static BVH8 removes five of the seven sites; `srcHashInsert` is the SRC
 * population itself and has no fallback arm today. Reporting that honestly is
 * the point of this check — a device without the feature is a device GI cannot
 * run on until those two kernels are ported to TSL, and the transport latch
 * (§H.1) is what keeps the picture alive meanwhile.
 *
 * Memoized: `navigator.gpu.wgslLanguageFeatures` cannot change mid-session, and
 * the error must be said once, not per rebuild.
 */
let ptrParamsChecked = false;
let ptrParamsSupported = true;
export function wgslPointerParametersSupported(runtime = globalThis) {
  if (ptrParamsChecked) return ptrParamsSupported;
  ptrParamsChecked = true;
  const features = runtime?.navigator?.gpu?.wgslLanguageFeatures;
  // ⚠ ABSENT ≠ UNSUPPORTED. `wgslLanguageFeatures` itself is newer than the
  // feature it reports, and a WebGPU implementation that does not expose the
  // set at all tells us nothing — treating that as "unsupported" would turn
  // off exact geometry on every browser that predates the API. Only a set that
  // EXISTS and does not contain the key is evidence.
  if (!features || typeof features.has !== "function") return true;
  ptrParamsSupported = features.has("unrestricted_pointer_parameters");
  if (!ptrParamsSupported) {
    console.error(
      "[gi] ⛔ WGSL `unrestricted_pointer_parameters` is NOT supported here. Every raw-WGSL kernel "
      + "that takes a storage pointer parameter fails validation, dispatches nothing, and (under "
      + "WebKit) reports nothing: srcProbes.js srcHashInsert/srcHashFind, dynamicObjects.js's four "
      + "mover-BVH traversals, bvh/bvhScene.js's static BVH8 traversal. Exact dynamic objects and "
      + "the static BVH8 are being forced OFF for this session; the SRC probe hash has no fallback "
      + "arm, so GI transport will not run at all — the environment IBL is left on and the scene is "
      + "lit by direct light only (see profile.frameStats.giTransport).",
    );
  }
  return ptrParamsSupported;
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
  // low/medium → hybrid-plane, high/ultra → hybrid-exact-complex. The named
  // modes are still implemented and still reachable from a harness; they are
  // simply not an authored choice, because "which intersection test does my
  // lighting use" is not a question a scene should have an opinion about.
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

  // Indirect-only ambient occlusion. ON since 2026-08-21, when the mechanism
  // changed: the old occupancy-oracle ladder inlined ~200 fetches into the
  // resolve kernel (§13.7f priced a build that never finished compiling with
  // it on) and could not darken inside its own 2-voxel self-surface
  // allowance (§13.7d). `createGiGtaoPass` is a screen-space pass over the GI
  // gbuffer instead — a tiny kernel, one texture sample in the resolve, and
  // contact-scale darkening from exact world positions. It still only ever
  // modulates the INDIRECT term (direct light keeps its traced shadows), so
  // the §14 "priced-but-parked contrast lever" finally engages.
  // `__giConfigOverride = { ao: false }` is the measurement hatch, and the
  // component declares an `ao` toggle (same argument as `reflections`).
  ao: true,
  // 0.8/0.8 since the first live look (2026-08-21, "AO is quite weak"):
  // 0.6/0.6 was tuned against the rig; on real scenes the emitter-direct
  // share leaves the indirect term — the only thing AO modulates — carrying
  // less of the image, so the ceiling has to work harder to read at all.
  //
  // Radius 0.8 → 0.5 (2026-08-24, "can't see any NOTABLE effect"): 0.8 m is
  // ABOVE typical probe spacing, so the wide ring reproduced the lattice-
  // scale shading the field already carries — a broad wash, no contact
  // definition. 0.5 pulls the wide ring under lattice scale (contact ring
  // 0.125 m) and pairs with the ring-union + ×3 renormalization fix in
  // createGiGtaoPass, which is what actually lets a crevice read DARK.
  // Both are live uniforms — `__giAoOverride = {strength, radius}` to tune.
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
  low: { resolveScale: 0.5, exactReflections: false },
  medium: { resolveScale: 0.5, exactReflections: false },
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
  high: { resolveScale: 0.5, exactReflections: true },
  // Per-triangle BVH reflections at FULL resolve resolution. As a tier
  // property it is reachable by choosing the tier, not by a stale checkbox
  // (the failure mode the old opt-in had).
  ultra: { resolveScale: 1, exactReflections: true },
};

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
export function resolveGiConfig(props, runtime = globalThis) {
  const authored = giQualityTier(props?.quality);
  // Clamped BEFORE anything reads the tier, so every tier-keyed ladder
  // downstream sees the tier this device can actually run — see
  // giDeviceTierCeiling. A desktop resolves to `authored` unchanged.
  const ceiling = giDeviceTierCeiling(runtime);
  const quality = clampTier(authored, ceiling);
  const settled = { quality, ...CONSTANT, ...BY_TIER[quality] };
  if (quality !== authored) {
    settled.qualityClampedFrom = authored;
    // Once per session, not per rebuild: a scene looking different on a phone
    // than on the desktop it was authored on has to be explainable from the
    // console, or it reads as GI being broken on that device.
    if (!warnedClamp) {
      warnedClamp = true;
      console.info(
        `[gi] quality clamped ${authored} → ${quality} for this device ` +
        `(mobile/Apple WebKit tier ceiling — __giDeviceTier = null removes it)`,
      );
    }
  }
  // ── THE TWO AUTHORED FEATURE TOGGLES (2026-08-21, user request) ──────────
  //
  // `ao` and `reflections` join `quality` as component properties, and the
  // one-knob doctrine survives the addition because they are the same KIND
  // of thing quality is: each removes a whole term at a whole cost, and
  // neither can mis-tune anything — the failure the 27-property collapse
  // exists to prevent. Only an explicit `false` acts; any other stored value
  // (old scenes, typos) keeps the default ON.
  if (props?.ao === false) settled.ao = false;
  if (props?.reflections === false) {
    settled.reflections = false;
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
 * SKY RADIANCE FROM THE SCENE'S OWN ENVIRONMENT — what a GI ray brings back
 * when it escapes without hitting anything.
 *
 * `scene.environment` is three.js's image-based light and `environmentIntensity`
 * scales it; the Scene Settings panel writes both, and so does the HDRI
 * Environment component. Reading them is what lets GI drop its own sky
 * properties without dropping the sky.
 *
 * NO ENVIRONMENT MEANS NO SKY, exactly. That is not a fallback chosen for
 * tidiness — it is what keeps this change behaviour-identical: `skyIntensity`
 * defaulted to 0, so every existing scene had no sky term, and every existing
 * scene still has none until someone gives it an environment.
 *
 * `scene.background` is deliberately NOT consulted. A background is a backdrop
 * and three itself distinguishes the two — treating the editor's default dark
 * grey as a light source would put a dim ambient into every scene ever made and
 * would break the "sky = 0 asserts exactly 0 lit pixels" gate, which exists
 * because light from nothing is the failure signature this module has shipped
 * three times.
 *
 * OPEN, AND STATED RATHER THAN HIDDEN: the sky's CHROMA is not read. An
 * environment map's average colour needs a 1×1 downsample of the cube map (a
 * GPU readback, or an average computed when the image decodes), so a sunset
 * HDRI currently contributes NEUTRAL sky at the right brightness. Colour
 * belongs with Phase 5's hit shading, which is where the environment has to be
 * sampled per-direction anyway.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.Color} out  written in place — this runs per frame
 */
export function sceneSkyRadiance(scene, out) {
  const environment = scene?.environment;
  if (!environment) return out.setRGB(0, 0, 0);
  const intensity = Math.max(0, scene.environmentIntensity ?? 1);
  return out.setRGB(intensity, intensity, intensity);
}

/**
 * The debug overlay, as a developer switch rather than an authored property.
 *
 * Any id in `GI_DEBUG_VIEW_MODES` — "off", "indirect", "ao", "reflections",
 * "reflections-exact", "occupancy", "sdf", "src-probes". Set
 * `globalThis.__giDebugView` from the console or a harness. Polled rather than
 * pushed — every reader is already in a per-frame path, and a string compare
 * per frame is cheaper than the change notification would be.
 *
 * EVERY mode is also reachable from the GI component's `debugView` prop, which
 * is what an inspector user actually wants (a dropdown beats typing a global).
 * The component prop is a SECOND-PRIORITY source — `globalThis.__giDebugView`
 * still wins, because a harness that forces a mode has no component to read
 * from and a console override has to beat the inspector or nothing can ever
 * step in front of it.
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

// ══ §19 STAGE 3.4 — THE GI2 BUILD CONSTANT (audits §M) ═══════════════════════
//
// GI2 (the window + soup + voxelizer + dynamic layer + screen-probe gather +
// radiance cache) is the lit path. The SRC chain and the dense occupancy field
// are still IN the tree and still compile; this constant is what decides which
// of the two `GISystem#rebuild` actually builds.
//
// ⚠ IT IS A MODULE-PRIVATE BUILD CONSTANT, NOT A PROPERTY AND NOT A `__gi*`
// FLAG, and the distinction is the whole point:
//
//   · a component PROPERTY would be a knob — a scene could be saved on the old
//     path and would then never migrate, which is exactly the "27 properties"
//     failure `resolveGiConfig` exists to prevent;
//   · a `__gi*` GLOBAL would be flippable at runtime, and the two paths do not
//     share a build — flipping it mid-session would leave half a system;
//   · a CONSTANT is edited in one place, in one commit, by someone who then
//     runs both batteries. Stage 4 deletes the `false` branch and this line
//     with it.
//
// Until then `GI2_PATH = false` restores the SRC path byte-for-byte, which is
// what `test:gi-occupancy` and `test:gi-src-gather` keep gating.
export const GI2_PATH = true;

/**
 * ⭐⭐⭐ §19 STAGE 5 — RADIANCE CASCADES RESTORED ON THE WINDOW, AND THIS IS
 * THE ONE SWITCH THAT BUILDS THEM.
 *
 * `false` (shipped) is byte-for-byte the path Stage 4 ends at: not a node of
 * `window/rc/` is constructed, no SRC module is imported by the GI2 chain, and
 * `smoke:gi-gpu` / the Cornell battery see exactly the kernels they saw before
 * this stage. `true` builds the PORTED cascades beside the world probes — both
 * light, and 5.4 is where the old one is deleted rather than switched off.
 *
 * A CONSTANT, for the same three reasons `GI2_PATH` is one: a property would be
 * a knob a scene could be saved with, a `__gi*` global would be flippable
 * mid-session between two builds that do not share a chain, and a constant is
 * edited in one commit by someone who then runs both batteries.
 *
 * ⚠ `globalThis.__gi2Rc5` OVERRIDES IT AT BUILD TIME ONLY — read once, where
 * the system is constructed, so a harness page can arm the stage without a
 * commit and nothing can flip it under a live chain.
 */
// 08-28 21:00 — DEFAULT ON (user: iterate in the editor; Cornell phase). The
// old world-probe path still builds beside it until 5.4 removes it, so the
// chain costs more than it will; `globalThis.__gi2Rc5 = false` pre-boot
// restores the shipped 4.x path for an A/B.
export const RC5_PATH = true;

/** The build-time value, harness override included. Read ONCE per build. */
/**
 * ⭐⭐⭐ §19 STAGE 5.3 — WHICH REPRESENTATION A SEATED EMITTER GETS UNDER THE
 * CASCADES. MEASURED BOTH WAYS; THE SEAT KEEPS IT, AND NEITHER ARM IS THE
 * ANSWER.
 *
 * The ONE-REPRESENTATION rule (§12.26.7's 2.60× double count) says an admitted
 * emitter is either a palette EMISSION the transport samples geometrically, or
 * an NEE SEAT sampled analytically at each shading point — never both.
 * `#gi2SlotEmissive` picks the seat and zeroes the emission.
 *
 * ⚠ AND THE CASCADES INHERIT A HOLE FROM THAT CHOICE. A seated lamp is
 * INVISIBLE TO THE TRANSPORT: a ray that hits it reads a cache word with no
 * emission in it. The face cache still carries `Enee`, so the lamp's SECOND
 * bounce is fine — but its FIRST bounce reaches a pixel only if somebody
 * evaluates NEE at the pixel, and 5.1/5.2 evaluated it nowhere. Both shipped
 * paths do (`gi2System.emitterDirectPass` at each screen probe,
 * `worldProbes.neePass` at each lattice probe); the cascades had no equivalent.
 *
 * ══ THE TWO ARMS, ON THE USER'S Cornel.scene, EVERYTHING ELSE HELD ══════════
 *
 *   arm                              gain   median |log|   blotch σ (Green·-Z)
 *   neither (5.1/5.2 shape)          0.303      1.195           45 %
 *   seat NEE, at the PIXEL           0.365      1.011           95 %
 *   palette EMISSION, geometric      1.955      0.818          144 %
 *
 * Neither wins, and the two failures are opposite and both instructive:
 *
 *   · AT THE PIXEL, a binary shadow ray against a voxelized lamp is a HARD
 *     ALIASED EDGE with no interpolation behind it. `emitterDirectPass` gets
 *     away with the same expression because it runs at a PROBE and the pixel
 *     reads eight of them; per pixel it doubles the blotch and takes the
 *     second-difference check from 0 failing surfaces to 6.
 *   · GEOMETRICALLY, the lamp is 4.5 m² of thin panel voxelized into 0.5 m
 *     cells, so the solid angle a ray set measures is several times the real
 *     one: energy 1.96× and Box·-X at 4.08×. That over-weighting IS why the
 *     seat exists.
 *
 * ══ ⭐⭐⭐ §19 STAGE 5.3b — THE THIRD ARM IS THE ANSWER, AND IT IS THE SECOND
 *    ONE WITH ITS ENERGY FIXED ═════════════════════════════════════════════
 *
 * Read the 1.955 again: it is not a random over-delivery, it is a RATIO OF
 * AREAS. The panel is 4.5 m² and its voxel shell presents about twice that to
 * the room, so the transport hands the room about twice the power the gate
 * admitted. Nothing about the geometric arm's PLACE was wrong — the paper lights
 * emitters exactly this way, by rays hitting them — only its SCALE.
 *
 * `gatherProbes`' `emitterVoxelScale` fixes the scale where the error is made,
 * per voxel: `L_vox = L_e · coverage / n_exposed`, so each voxel radiates
 * exactly the power of the surface §AG's coverage says is inside it. That makes
 * the geometric arm energy-exact by construction rather than by a tuned
 * constant, and it fixes the near-field outlier (Box·-X 4.08×) as well as the
 * global gain, because a slab's SIDE faces are then radiating a slab's share
 * instead of a panel's.
 *
 * So the cascades now light emitters the way the paper does — the seat's four
 * analytic shadow rays are not evaluated anywhere on this path, and there is no
 * double count to guard. The ADMISSION GATE IS UNTOUCHED and is still the only
 * gate: a culled emitter's `palEm` is `[0,0,0]`, and no fraction of zero is
 * light.
 *
 * `__gi2Rc5SeatNee = 1` restores 5.3's shipped arm (the seat, gain 0.303);
 * `__gi2Rc5EmitRaw = 1` keeps the emission but drops the conservation (5.3's
 * 1.955 row); `__gi2Rc5PixelNee = 1` adds the pixel-analytic seat term
 * (`rcMerge`'s `directAt`, the 0.365 row). All three are the A/B rows above.
 */
export function rc5SeatNeeEnabled(runtime = globalThis) {
  // ⭐⭐⭐ §19 5.3d — THE DEFAULT IS THE SEAT AGAIN, AND IT IS THE REFERENCE'S
  // OWN SPLIT RATHER THAN A PREFERENCE. See `rc5PixelNeeEnabled` below and
  // `rcDirect.js`'s header: the gate's truth is
  // `E = NEE_direct + cosine bounce with emission REMOVED at every hit`, so an
  // admitted+SEATED lamp must reach a pixel analytically and must NOT be in the
  // transport. 5.3b/5.3c put it in the transport instead and got the energy
  // right (gain 0.879) with the SILHOUETTE wrong — the tall box's lit side at
  // 1.85× and the ceiling at 0.35× are a voxel slab's angular spread, not a
  // panel's, and no per-voxel scale can fix a shape.
  //
  // ⚠ THE TWO SWITCHES MOVE TOGETHER OR THE LAMP IS COUNTED TWICE / NOT AT ALL.
  // `rc5PixelNeeEnabled` is defined as this one, so there is exactly one
  // decision and it cannot be half-applied.
  //
  // `__gi2Rc5Emission = 1` (5.3's opt-in spelling) and `__gi2Rc5SeatNee = 0`
  // both restore 5.3b/5.3c's transport arm, with the analytic term off.
  if ((runtime?.__gi2Rc5Emission ?? 0) !== 0) return false;
  return (runtime?.__gi2Rc5SeatNee ?? 1) !== 0;
}

/** Under the cascades, does a PROMOTED emitter keep its palette emission? */
export function rc5EmitterEmissionEnabled(runtime = globalThis) {
  return rc5PathEnabled(runtime) && !rc5SeatNeeEnabled(runtime);
}

/**
 * ⭐⭐⭐ §19 5.3d — THE PIXEL-ANALYTIC SEAT TERM, AND IT IS NOW THE SAME
 * DECISION AS THE SEAT ITSELF.
 *
 * A seated emitter has `palEm = [0,0,0]` (`#gi2SlotEmissive`), so the transport
 * carries no first bounce for it; the analytic term at the pixel is its ONLY
 * carrier. Deriving this from `rc5SeatNeeEnabled` rather than from a second
 * global is what makes "counted once" a property of the code instead of a rule
 * two hatches have to be set consistently to obey — the failure 5.3 measured in
 * both directions (0.303 with neither, 1.955 with both).
 *
 * ⚠ 5.3 SHIPPED THIS OFF FOR A REASON THAT NO LONGER HOLDS: it was a BINARY
 * shadow ray per pixel with nothing behind it (blotch σ 45 → 95 %). `rcDirect`
 * traces the same ray and then runs it through the cross-bilateral the engine's
 * own emitter chain always had. The filter is the change; the term is 5.3's.
 */
export function rc5PixelNeeEnabled(runtime = globalThis) {
  return rc5PathEnabled(runtime) && rc5SeatNeeEnabled(runtime);
}

export function rc5PathEnabled(runtime = globalThis) {
  const hatch = runtime?.__gi2Rc5;
  return hatch === undefined ? RC5_PATH : hatch === true;
}

/**
 * §19 STAGE 5.5b — EXACT TRIANGLE SHADOW RAYS FOR THE DIRECT TERM.
 *
 * ON by default, and the reason is a CORRECTNESS one rather than a quality
 * one: a direct shadow ray STARTS ON A SURFACE, and a ray traced against a
 * voxelization of that surface begins inside its own occluder. The user's
 * report — the Cornell tall box, an emitter mesh, rendered entirely black —
 * is that failure at its cleanest, and no `v0` slab size fixes it (see
 * `window/shadowBvh.js`'s header for why the failure is representational,
 * not a tuning miss).
 *
 * `__gi2Rc5BvhShadow = 0` restores the voxel arm (`traceWindow`), which is
 * also what serves automatically on any build where the BVH did not land — a
 * tier that gates it off, a scene past the triangle cap, a worker failure, or
 * simply the frames before the build finishes. So this flag turns off a
 * REPLACEMENT, never a requirement.
 */
export function rc5BvhShadowEnabled(runtime = globalThis) {
  if (!rc5PathEnabled(runtime)) return false;
  // 08-29 00:30: DEFAULT OFF until the arm swap stops rebuilding the gather —
  // the rebuild re-creates the gather textures and the materials stay bound
  // to the destroyed ones (the frame goes black after the BVH lands while the
  // irradiance readback is lit). `__gi2Rc5BvhShadow = 1` arms it.
  // 08-29 01:10: DEFAULT ON again — the swap no longer rebuilds anything
  // (persistent slot + uniform-gated arm, 636bba3); the black frame is
  // unreachable. `__gi2Rc5BvhShadow = 0` restores the voxel arm.
  // 08-29 01:50: DEFAULT OFF again — on Bistro (2.8 M tris) the arm reads
  // 3 fps in the user's editor; re-enable per tier/triangle count once its
  // per-frame cost and the 2 M-triangle cap are measured. `= 1` arms it.
  return (runtime?.__gi2Rc5BvhShadow ?? 0) !== 0;
}

/**
 * GI quality tier → GI2 window tier. A 1:1 map, published rather than inlined
 * so `windowStore`/`gatherProbes`/`radianceCache`'s four tier tables and this
 * module's four quality levels can never drift apart silently: every GI2 tier
 * table is keyed `phone | medium | high | ultra`, and GI's authored ladder is
 * `low | medium | high | ultra`. Only the bottom rung is renamed — "low" on a
 * desktop and "phone" are the same envelope (3 levels, 0.5 m cells, 8 rays).
 */
export const GI2_TIER_BY_QUALITY = Object.freeze({
  low: "phone",
  medium: "medium",
  high: "high",
  ultra: "ultra",
});

/** The GI2 window tier for a component's props (via the settled quality). */
export function gi2TierOf(props, runtime = globalThis) {
  return GI2_TIER_BY_QUALITY[resolveGiConfig(props, runtime).quality] ?? "high";
}
