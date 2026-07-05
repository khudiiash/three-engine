import { create } from "zustand";

/** Mirrors engine.playing for React; playMode.js is the source of truth. */
export const usePlayStore = create(() => ({ playing: false }));
