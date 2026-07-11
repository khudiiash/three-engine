/**
 * Module-level "armed brush" state for the Terrain sculpt/paint tools —
 * mirrors the armFollowPick/armSurfacePick pattern in InspectorPanel.jsx.
 * The Inspector's Terrain section arms/disarms and edits settings; the
 * viewport's pointer handlers read the armed mode + settings while a
 * terrain entity is selected.
 */
let mode = null; // "sculpt" | "paint" | null
const settings = {
  tool: "raise", // sculpt: "raise" | "lower" | "smooth" | "flatten"
  radius: 4,
  strength: 0.5,
  hardness: 0.5,
  activeLayer: 0, // paint: which of the up-to-4 layers to paint
};

const listeners = new Set();
function notify() {
  for (const cb of listeners) cb();
}

export function subscribeTerrainBrush(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getTerrainBrushMode() {
  return mode;
}

export function armTerrainBrush(nextMode) {
  mode = nextMode;
  notify();
}

export function disarmTerrainBrush() {
  mode = null;
  notify();
}

export function getTerrainBrushSettings() {
  return settings;
}

export function setTerrainBrushSetting(key, value) {
  settings[key] = value;
  notify();
}
