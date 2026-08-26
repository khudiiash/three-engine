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
 * The debug view modes exposed on the GI component, in inspector order.
 *
 * - "off" (default): no overlay.
 * - "indirect": the diffuse-irradiance term only — what the SRC gather
 *   computed, before AO darkens it. What "indirect light" actually IS in this
 *   build, with no contact shading mixed in.
 * - "ao": the obscurance factor (1 = no occlusion, 0 = fully occluded) as a
 *   greyscale. Wide+contact+VXAO combined into one screen-space factor by the
 *   AO pass. Lets you see what is darkening your corners.
 * - "reflections": the glossy radiance term only — what mirrors see, before
 *   it gets multiplied by a material's specular response.
 *
 * The legacy `sdf` / `occupancy` / `src-probes` modes stay on the global
 * (`globalThis.__giDebugView`) — those touch DIFFERENT data (the SDF distance
 * field, the voxel occupancy pyramid, the SRC probe gizmos) and have never
 * had a component prop.
 */
export const GI_DEBUG_VIEWS = [
  "off",
  "indirect",
  // "ao" is the factor the RESOLVE APPLIES. Since 2026-08-26 there is exactly
  // ONE estimator behind it (per-pixel ray-traced, #armRtaoPass) — the
  // screen-spiral and voxel-cone pair it replaced needed a mode each, because
  // the resolve composed them with `min` and that made an isolated read of
  // either impossible. One estimator, one view. The single-source modes come
  // back automatically if `__giAoLegacy = true` ever re-arms the pair: this
  // view then shows their `min`, which is still what the frame applies.
  "ao",
  // "reflections" is the glossy field WEIGHTED BY FRESNEL, which is what
  // turns it from "a blurry copy of the scene" (the raw buffer holds a
  // radiance at every pixel, including the ~96% of a dielectric surface that
  // never shows it) into the layer the frame actually adds.
  // "reflections-exact" is the traced BVH layer — the sharp arm ultra runs,
  // which no view could show before.
  "reflections",
  "reflections-exact",
];
const DEBUG_VIEWS = new Set(GI_DEBUG_VIEWS);
/**
 * The subset drawn by the fullscreen TERM overlay (`#buildDebugView`), as
 * opposed to the volume/gizmo views ("sdf", "occupancy", "src-probes")
 * that are console-only. Kept beside the list so adding a mode to one and
 * not the other is impossible.
 */
export const GI_TERM_DEBUG_VIEWS = new Set(GI_DEBUG_VIEWS.filter((v) => v !== "off"));

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
  // allowance (§13.7d). `createGiAoPass` is a screen-space pass over the GI
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
  // createGiAoPass, which is what actually lets a crevice read DARK.
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
 * "off" | "sdf" | "occupancy" | "src-probes" | "indirect" | "ao" |
 * "reflections". Set `globalThis.__giDebugView` from the console or a
 * harness. Polled rather than pushed — every reader is already in a per-frame
 * path, and a string compare per frame is cheaper than the change notification
 * would be.
 *
 * The "indirect" / "ao" / "reflections" modes are also reachable from the GI
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
