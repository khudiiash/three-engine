// @ts-check
/**
 * ── PER-PLATFORM COMPONENT CONFIGS (2026-09-11) ──────────────────────────────
 *
 * A component's `props` are its DESKTOP values — the base. Optionally it also
 * carries `props.variants`, up to three partial override sets:
 *
 *     variants: {
 *       mobile:    { size: [80, 80] },            // any phone/tablet
 *       portrait:  { anchorMin: [0.5, 1], ... },  // a phone held upright
 *       landscape: { ... },                        // a phone held sideways
 *     }
 *
 * At runtime the engine resolves a PLATFORM CONTEXT — `{ platform, orientation }`
 * — into a list of LAYERS, and the effective value of a prop is the base
 * overlaid by every layer that names it, later layers winning:
 *
 *     desktop            → []                       base only
 *     mobile, landscape  → ["mobile", "landscape"]
 *     mobile, portrait   → ["mobile", "portrait"]
 *     mobile, (unknown)  → ["mobile"]               the editor's bare "Mobile" preview
 *
 * So `mobile` is the shared phone config and `portrait` / `landscape` are the
 * orientation tweaks on top of it; a component may carry any subset. Keys a
 * layer does not name inherit from below. This is CSS's cascade, and it is
 * what lets a HUD author share 90 % of the phone layout between orientations.
 *
 * The values are applied INTO `props` (Component.applyPlatformLayers), because
 * every system reads `component.props.x` directly — UiSystem reads `el.props.
 * size`, a light reads `props.intensity`; there are 54 component types and
 * none of them should know variants exist. The base of each overridden key is
 * kept aside (`Component._variantBase`) so `toJSON` still writes the desktop
 * values and a context change (the phone rotates) can put them back.
 *
 * This module is the PURE half: no engine, no three, so the editor, the
 * player and the tests share one definition of the vocabulary.
 */

/** The three override sets a component may carry, in cascade order. */
export const VARIANT_KEYS = Object.freeze(/** @type {const} */ (["mobile", "portrait", "landscape"]));

/** The prop the override sets live under. Never mirrored as an accessor. */
export const VARIANTS_PROP = "variants";

/**
 * What the editor can preview: the base, the bare phone config (no orientation
 * layer, so the shared values can be seen and edited without a portrait or
 * landscape tweak sitting on top), and the two orientations.
 */
export const PLATFORM_TARGETS = Object.freeze(
  /** @type {const} */ (["desktop", "mobile", "portrait", "landscape"]),
);

/**
 * Keys that can never be overridden per platform: the variants themselves,
 * and the editor-only meta toggles ("pause while editing", frustum gating,
 * "run in editor"), which describe how the AUTHOR works, not the game.
 * `enabled` is deliberately NOT here — a virtual joystick that exists only
 * on a phone is the first thing anyone reaches for.
 */
export const VARIANT_EXCLUDED_KEYS = new Set([VARIANTS_PROP, "editorEnabled", "viewOnly", "runInEditor"]);

/**
 * @typedef {{ platform: "desktop" | "mobile", orientation: "portrait" | "landscape" | null }} PlatformContext
 * @typedef {"desktop" | "mobile" | "portrait" | "landscape"} PlatformTarget
 * @typedef {"mobile" | "portrait" | "landscape"} VariantKey
 */

/** @param {unknown} key */
export function isVariantKey(key) {
  return typeof key === "string" && /** @type {readonly string[]} */ (VARIANT_KEYS).includes(key);
}

/** @param {unknown} target */
export function isPlatformTarget(target) {
  return typeof target === "string" && /** @type {readonly string[]} */ (PLATFORM_TARGETS).includes(target);
}

/**
 * The override layers a platform context applies, bottom to top.
 * @param {Partial<PlatformContext> | null | undefined} context
 * @returns {VariantKey[]}
 */
export function platformLayers(context) {
  if (!context || context.platform !== "mobile") return [];
  const orientation = context.orientation;
  if (orientation === "portrait" || orientation === "landscape") return ["mobile", orientation];
  return ["mobile"];
}

/**
 * The platform context an editor preview target stands for. "mobile" is the
 * phone with no orientation layer — the shared config on its own.
 * @param {PlatformTarget | string | null | undefined} target
 * @returns {PlatformContext}
 */
export function targetToPlatform(target) {
  switch (target) {
    case "mobile": return { platform: "mobile", orientation: null };
    case "portrait": return { platform: "mobile", orientation: "portrait" };
    case "landscape": return { platform: "mobile", orientation: "landscape" };
    default: return { platform: "desktop", orientation: null };
  }
}

/**
 * The editor target that shows a platform context. Inverse of
 * `targetToPlatform`; a desktop context is "desktop" whatever its orientation.
 * @param {Partial<PlatformContext> | null | undefined} context
 * @returns {PlatformTarget}
 */
export function platformToTarget(context) {
  const layers = platformLayers(context);
  return layers.length ? layers[layers.length - 1] : "desktop";
}

/**
 * Drops anything that is not a real override set: unknown layer names,
 * non-object values, excluded keys, and empty layers. Returns `null` when
 * nothing survives, so a component with no overrides carries no key at all.
 * @param {unknown} variants
 * @returns {Record<string, Record<string, unknown>> | null}
 */
export function normalizeVariants(variants) {
  if (!variants || typeof variants !== "object" || Array.isArray(variants)) return null;
  /** @type {Record<string, Record<string, unknown>>} */
  const out = {};
  for (const layer of VARIANT_KEYS) {
    const delta = /** @type {Record<string, unknown>} */ (variants)[layer];
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
    /** @type {Record<string, unknown>} */
    const clean = {};
    for (const [key, value] of Object.entries(delta)) {
      if (VARIANT_EXCLUDED_KEYS.has(key) || value === undefined) continue;
      clean[key] = value;
    }
    out[layer] = clean;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The merged override map for a layer list: every key any active layer names,
 * the topmost layer's value winning.
 * @param {Record<string, Record<string, unknown>> | null | undefined} variants
 * @param {readonly string[]} layers
 * @returns {Record<string, unknown>}
 */
export function resolveVariantOverrides(variants, layers) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!variants) return out;
  for (const layer of layers) {
    const delta = variants[layer];
    if (!delta || typeof delta !== "object") continue;
    for (const [key, value] of Object.entries(delta)) {
      if (VARIANT_EXCLUDED_KEYS.has(key) || value === undefined) continue;
      out[key] = value;
    }
  }
  return out;
}

/**
 * Which set an edit lands in while previewing `layers`: the TOPMOST active
 * layer the component actually has, or `null` for the base. Previewing
 * portrait on a component that carries only a `mobile` set edits that set —
 * it is the one being looked at — and on a component with no sets at all
 * edits the desktop values, so a light does not grow a portrait config
 * because someone had the phone preview on.
 * @param {Record<string, Record<string, unknown>> | null | undefined} variants
 * @param {readonly string[]} layers
 * @returns {VariantKey | null}
 */
export function editLayerFor(variants, layers) {
  if (!variants) return null;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (variants[layer] && typeof variants[layer] === "object") return /** @type {VariantKey} */ (layer);
  }
  return null;
}

/**
 * Cheap structural compare for prop values — primitives, arrays of numbers,
 * small JSON blobs. Used to skip a re-apply (and the `onPropChanged` rebuild
 * it would trigger) when the value already stands.
 * @param {unknown} a
 * @param {unknown} b
 */
export function samePropValue(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!samePropValue(a[i], b[i])) return false;
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
