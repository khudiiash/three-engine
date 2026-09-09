/**
 * ⭐⭐⭐ ONE WIND IN THE SCENE, NOT ONE PER CURTAIN.
 *
 * Wind, gust strength and gust frequency were per-cloth properties, so ten
 * curtains hanging in one arcade each ran their own weather: "wind gust is its
 * own for each cloth, meaning there must be a single wind source in the scene,
 * though the curtains behave like each as its own wind, causing a visual
 * mismatch" (user, 2026-09-09). Sponza's two split curtains had gust 10.23 at
 * 0.517 Hz and gust 3.54 at 0.386 Hz — neighbours in the same colonnade,
 * breathing at different rates.
 *
 * ⚠ AND THE FIX IS NOT TO SYNCHRONISE THEM. The gust is already a TRAVELLING
 * WAVE — `sin(t·f + 0.8x + 0.6y)` — so cloths sharing one field are offset by
 * their own position, which is what a gust crossing a courtyard actually looks
 * like. Giving them one field makes them coherent; it does not make them move
 * in lockstep. That only works if the phase is sampled in WORLD space, which is
 * why the solver transforms the particle before sampling it.
 *
 * A cloth may still opt out (`windSource: "custom"`) for a curtain over an air
 * vent or a flag on a tower — the exception stays authorable, it just stops
 * being the default.
 */

/** The solver's own defaults, so "scene" never means "no wind at all". */
export const SCENE_WIND_DEFAULTS = { vector: [0, 0, 2], gust: 0, gustFrequency: 1 };

const finite = (value, fallback, min, max) =>
  Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;

/**
 * A wind vector from whatever a scene or a cloth carries.
 *
 * ⚠ A SCALAR STILL LOADS AS [0, 0, w]. Wind used to be a single number added to
 * +Z; every scene saved before it became a vector still says so, and reading
 * that as a magnitude on X would turn those curtains sideways.
 */
export function windVector(value, fallback = SCENE_WIND_DEFAULTS.vector) {
  if (Array.isArray(value)) return [0, 1, 2].map((i) => finite(value[i], 0, -1000, 1000));
  if (Number.isFinite(Number(value))) return [0, 0, finite(value, 0, -1000, 1000)];
  return [...fallback];
}

/**
 * What this cloth's solver should actually blow with.
 *
 * @param {object} props        the cloth's own properties
 * @param {object|null} scene   `engine.settings.wind`
 */
export function resolveClothWind(props = {}, scene = null) {
  const custom = props.windSource === "custom";
  const source = custom ? props : { ...SCENE_WIND_DEFAULTS, ...(scene ?? {}) };
  return {
    vector: windVector(custom ? props.wind : source.vector, SCENE_WIND_DEFAULTS.vector),
    gust: finite(source.gust, custom ? 0 : SCENE_WIND_DEFAULTS.gust, 0, 100),
    gustFrequency: finite(source.gustFrequency, custom ? 1 : SCENE_WIND_DEFAULTS.gustFrequency, 0, 10),
    inherited: !custom,
  };
}
