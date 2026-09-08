import { create } from "zustand";
import { vmSingleton } from "../singleton.js";

/**
 * Edit Mode's shared state, and there are two facts in it, not one.
 *
 * `entityId` means THE VIEWPORT IS COVERED: `ViewportPanel` renders the
 * geometry editor as an opaque overlay (`inset: 0`) over the main canvas, so
 * while it is set nothing the engine draws can be seen.
 *
 * `sessions` counts OPEN GEOMETRY EDITORS however they were opened — and the
 * distinction matters because there are three entry paths and only two of them
 * set `entityId`. Tab in the viewport and the Inspector's Edit button do; the
 * DOCKED `geometryEditor` panel (from the Assets panel, or the Inspector's
 * "open as panel") does not, because that one lives in its own dock tab beside
 * a viewport that may still be visible.
 *
 * ⚠ THAT GAP IS WHY "the geometry editor still lags" SURVIVED THE FIRST FIX
 * (2026-09-07): the frame pacer suspended the engine on `entityId`, so a user
 * who opened the editor as a panel got no suspension at all. A consumer that
 * wants "is anyone editing geometry" must read `sessions`; one that wants "is
 * the viewport hidden" must read `entityId`.
 */
export const useGeometryEditStore = vmSingleton("geometryEditStore", () => create((set) => ({
  entityId: null,
  sessions: 0,
  enter(entityId) { set({ entityId }); },
  exit() { set({ entityId: null }); },
  /** Called by the panel itself on mount/unmount, whichever path opened it. */
  openSession() { set((state) => ({ sessions: state.sessions + 1 })); },
  closeSession() { set((state) => ({ sessions: Math.max(0, state.sessions - 1) })); },
})));
