// @ts-check
/**
 * The shared "recent searches" list behind every editor search box — Ctrl+F's
 * Quick Search, the Hierarchy filter and the Assets filter all record into this
 * one list, because a query the user just typed into one of them is very likely
 * the query they want in another.
 *
 * Shape and persistence mirror `nodegraph/palette.jsx`'s per-kind recents: a
 * capped, newest-first array of strings in localStorage, every access behind
 * try/catch (private mode, a full quota and a missing `localStorage` — node
 * tests import this module — must all degrade to "no recents", never a throw).
 *
 * Deduping is CASE-INSENSITIVE, because `Lamp` and `lamp` are the same search
 * to the person typing; the most recent CASING is the one kept, since that is
 * the one they just typed. Structured queries (`texture?width>1920`) are stored
 * whole — the query IS the command, and re-running it means retyping nothing.
 *
 * Node-importable on purpose: the only imports are zustand and the singleton
 * helper. There is no DOM, no three.js and no Tauri in here, so the node test
 * drives the real store rather than a mock of it.
 */
import { create } from "zustand";
import { vmSingleton } from "./singleton.js";

export const SEARCH_RECENTS_KEY = "engine.search.recents.v1";

export const MAX_SEARCH_RECENTS = 8;

/** Newest-first string list, tolerating anything localStorage hands back. */
function loadRecents() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEARCH_RECENTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => typeof entry === "string" && entry.trim()).slice(0, MAX_SEARCH_RECENTS);
  } catch {
    // Corrupt JSON, a private-mode window, or no localStorage at all (the node
    // tests): an empty list is the correct answer to all three.
    return [];
  }
}

function persist(recents) {
  try {
    localStorage.setItem(SEARCH_RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // Non-fatal: the list just won't survive a restart.
  }
}

/**
 * VM-wide so an HMR reload doesn't fork the list — see singleton.js. Two panels
 * holding two copies of the same list would record each other's queries out of
 * existence, which is precisely the failure this file exists to prevent.
 */
export const useSearchRecents = vmSingleton("searchRecents", () =>
  create((set, get) => ({
    recents: loadRecents(),

    /** Record one query. Empty/whitespace is ignored; a case-insensitive dupe
     *  moves to the front under its newest casing. Returns the new list. */
    noteSearch(raw) {
      const query = String(raw ?? "").trim();
      if (!query) return get().recents;
      const key = query.toLowerCase();
      const rest = get().recents.filter((existing) => existing.toLowerCase() !== key);
      const next = [query, ...rest].slice(0, MAX_SEARCH_RECENTS);
      set({ recents: next });
      persist(next);
      return next;
    },

    /** Forget one query, matching case-insensitively. Returns the new list. */
    removeSearch(raw) {
      const key = String(raw ?? "").trim().toLowerCase();
      const next = get().recents.filter((existing) => existing.toLowerCase() !== key);
      set({ recents: next });
      persist(next);
      return next;
    },

    /** Forget everything. */
    clearSearchRecents() {
      set({ recents: [] });
      persist([]);
    },
  })),
);

/**
 * Module-level conveniences over the store, for callers that are not React
 * components (the panels' onChange handlers record without subscribing, and an
 * MCP op may one day do the same). Same instances as the store's own actions.
 */
export function noteSearch(raw) {
  return useSearchRecents.getState().noteSearch(raw);
}

export function removeSearch(raw) {
  return useSearchRecents.getState().removeSearch(raw);
}

export function clearSearchRecents() {
  useSearchRecents.getState().clearSearchRecents();
}
