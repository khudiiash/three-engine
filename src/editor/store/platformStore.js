// @ts-check
/**
 * The editor's PLATFORM PREVIEW TARGET — which of a component's per-platform
 * configs the viewport shows and the inspector edits (see
 * engine/componentVariants.js for the model).
 *
 *   desktop    the base values, nothing applied
 *   mobile     the shared phone set alone (no orientation layer on top)
 *   portrait   mobile + portrait
 *   landscape  mobile + landscape
 *
 * ONE target for the whole editor, deliberately. The toggles sit on every
 * component section, but they all move this one value: previewing a portrait
 * HUD means every element shows its portrait values at once, and an edit made
 * while looking at the portrait layout lands in the portrait set — the same
 * rule a responsive web editor uses when a breakpoint is selected. A
 * per-component preview would show one element phone-sized between desktop
 * neighbours, which is a picture of nothing.
 *
 * Applied to the engine as a platform OVERRIDE (`engine.setPlatformOverride`),
 * so the editor never takes its orientation from the canvas shape — a
 * narrow-docked viewport is not a phone held upright. Play mode keeps the
 * override: pressing Play with Portrait selected play-tests the portrait
 * layout. NOT persisted: an editor that reopened into a phone preview would
 * read as "my HUD is broken" (the persisted-dev-flag trap, 2026-09-11).
 */
import { create } from "zustand";
import { vmSingleton } from "../singleton.js";
import { isPlatformTarget, targetToPlatform } from "../../engine/componentVariants.js";
import { engine, isEngineReady } from "../engineInstance.js";

/** @typedef {import("../../engine/componentVariants.js").PlatformTarget} PlatformTarget */

export const usePlatformStore = vmSingleton("platformStore", () =>
  create((set, get) => ({
    /** @type {PlatformTarget} */
    target: "desktop",
    /** @param {PlatformTarget | string} target */
    setTarget(target) {
      if (!isPlatformTarget(target) || target === get().target) return;
      set({ target: /** @type {PlatformTarget} */ (target) });
      if (isEngineReady()) engine.setPlatformOverride(targetToPlatform(target));
    },
  })),
);

/** The current target, for code outside React (commands, ops). */
export function getPlatformTarget() {
  return usePlatformStore.getState().target;
}

/** @param {PlatformTarget | string} target */
export function setPlatformTarget(target) {
  usePlatformStore.getState().setTarget(target);
}

export const PLATFORM_TARGET_LABELS = Object.freeze({
  desktop: "Desktop",
  mobile: "Mobile",
  portrait: "Portrait",
  landscape: "Landscape",
});
