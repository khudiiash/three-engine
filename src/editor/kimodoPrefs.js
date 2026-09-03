// @ts-check
/**
 * Machine-local generation preferences. The native layer discovers Kimodo;
 * the editor only remembers which of its two SOMA checkpoints to use.
 */
const STORAGE_KEY = "engine.kimodo.v1";

const DEFAULTS = Object.freeze({
  motionModel: "rp", // "rp" | "seed" — the two redistributable SOMA checkpoints
});

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      motionModel: raw.motionModel === "seed" ? "seed" : DEFAULTS.motionModel,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getKimodoPrefs() {
  return load();
}

export function setKimodoPrefs(patch) {
  const next = { ...load(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private-mode / quota — prefs degrade to session defaults, not errors.
  }
  return next;
}
