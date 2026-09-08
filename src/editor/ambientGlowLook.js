import { vmSingleton } from "./singleton.js";

/**
 * How far the ambient glow reaches and how strongly it shows.
 *
 * The two numbers live here rather than in the component so the Project
 * Settings panel can turn them WHILE THE USER DRAGS, the way the accent
 * colour already does — a light you cannot see change is a light you cannot
 * tune. `applyProjectSettings` pushes the saved values through the same
 * door, so boot, Save and a reverted edit all arrive the same way.
 *
 * Whether the glow exists at all is `editor.layers.ambient`, shared with the
 * viewport's Visibility menu: one value with two surfaces rather than two
 * switches that can disagree.
 */
export const AMBIENT_GLOW_DEFAULTS = {
  /** CSS pixels the light reaches past the viewport's edges. */
  spread: 50,
  /** 0..1. The layer's opacity — how visible the light is. */
  intensity: 0.55,
};

const state = vmSingleton("ambientGlowLook", () => ({
  look: { ...AMBIENT_GLOW_DEFAULTS },
  listeners: new Set(),
}));

const clamp = (value, low, high, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
};

export function getAmbientGlowLook() {
  return state.look;
}

/** Applies new numbers and tells the layer. Ignores a no-op. */
export function setAmbientGlowLook(next = {}) {
  const look = {
    spread: clamp(next.spread ?? state.look.spread, 0, 400, AMBIENT_GLOW_DEFAULTS.spread),
    intensity: clamp(next.intensity ?? state.look.intensity, 0, 1, AMBIENT_GLOW_DEFAULTS.intensity),
  };
  if (look.spread === state.look.spread && look.intensity === state.look.intensity) return;
  state.look = look;
  for (const fn of state.listeners) fn(look);
}

export function onAmbientGlowLook(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}
