// shadowUpdateStride — how often a PORTABLE device re-renders its shadow maps.
//
// The user's iPhone read the sun's 2048² VSM chain (the depth render plus two
// RG16F blur passes) at 10.4 ms of a 45 ms frame (`?hud=1`, 2026-09-11) — a
// quarter of the frame, every frame, for a sun that turns 2° a second and a
// character whose shadow can lag one frame without anyone seeing it. three
// renders a map only when `shadow.needsUpdate || shadow.autoUpdate`
// (ShadowNode.js `updateShadow`), and the VSM blur rides that same gate, so
// the stride costs no memory and no shader: the shadow-freeze walker owns
// `autoUpdate` for the lights it cannot freeze (a scene with a deforming
// caster) and raises `needsUpdate` every Nth frame instead.
//
// Desktops stay at every frame. `__engineShadowUpdateStride` pins (1 = every
// frame everywhere; 3 on a desktop rehearses a slower phone).
//
// In its own module: sceneSettings.js imports the freeze walker, the walker
// imports this, this imports the portable check from sceneSettings — a cycle
// that ESM resolves because every binding here is read at call time, never
// at module evaluation.
import { isPortableDevice } from "./sceneSettings.js";

export const MOBILE_SHADOW_UPDATE_STRIDE = 2;

/** The stride for this device (1 = every frame). */
export function shadowUpdateStride(nav = globalThis.navigator, runtime = globalThis) {
  const pin = Number(runtime?.__engineShadowUpdateStride);
  if (Number.isFinite(pin) && pin >= 1) return Math.round(pin);
  return isPortableDevice(nav) ? MOBILE_SHADOW_UPDATE_STRIDE : 1;
}

/** Whether frame `frame` renders the maps under `stride`. */
export function shadowUpdateDue(frame, stride) {
  const s = Math.max(1, Math.round(Number(stride) || 1));
  return s === 1 || (Math.max(0, Math.round(Number(frame) || 0)) % s) === 0;
}
