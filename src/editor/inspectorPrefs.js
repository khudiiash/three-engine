// @ts-check
/**
 * Which inspector sections the user has folded away — an EDITOR preference,
 * not a scene value, for the same reason as `aiPrefs.js`: which component types
 * you keep collapsed while working is a fact about how you work, not about one
 * scene.
 *
 * Keyed by COMPONENT TYPE, never by entity id. That is the Unity behaviour and
 * it is the only useful one: a per-entity fold state would mean re-collapsing
 * "Light" on the next object you select, which is the papercut the feature
 * exists to remove. It falls straight out of keying the store by type.
 *
 * Stored shape:
 *   { version: 1, collapsed: { [componentType]: true } }
 *
 * Only `true` is ever written. An absent key means expanded, so a component
 * type that does not exist yet needs no migration and "expand all" is simply
 * an empty object.
 *
 * The module GROUPS inside a component section (see ModuleFieldsGroup in
 * InspectorPanel.jsx) fold the same way, keyed by MODULE id — "Physics" is
 * one fold whether it appears on a mesh or a virtual camera. They persist
 * under their OWN key so the payload above stays exactly what version 1
 * wrote; the two maps never mix in storage.
 *
 * Persistence is best-effort, matching `hierarchyPrefs.js`: localStorage may be
 * unavailable (private mode, quota exceeded), so every access is wrapped and
 * silently no-ops — the fold still happens, it just will not survive a reload.
 */
import { useCallback } from "react";
import { create } from "zustand";
import { vmSingleton } from "./singleton.js";

export const INSPECTOR_COLLAPSED_KEY = "engine.inspector.collapsed.v1";
export const INSPECTOR_MODULE_GROUPS_KEY = "engine.inspector.moduleGroups.v1";

/** Only an exact `true` survives the round trip — a hand-edited `false` or a
 *  stray string must not read back as a fold this module wrote. */
function readFolds(raw) {
  const folds = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      if (value === true) folds[key] = true;
    }
  }
  return folds;
}

/**
 * Read at module init, and the store's factory runs inside `vmSingleton` — so
 * a type saved collapsed is collapsed on the FIRST paint of the inspector,
 * before any effect has run. That is what keeps a reload from flashing every
 * section open and snapping them shut (the fold smoke proves it with a
 * MutationObserver, the same way run-hierarchy-fold-smoke.mjs does).
 */
function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(INSPECTOR_COLLAPSED_KEY) ?? "null");
    const collapsed = readFolds(parsed?.collapsed);
    let moduleGroups = {};
    try {
      moduleGroups = readFolds(JSON.parse(localStorage.getItem(INSPECTOR_MODULE_GROUPS_KEY) ?? "null")?.moduleGroups);
    } catch {
      // A broken module-group payload costs only those folds.
    }
    return { version: 1, collapsed, moduleGroups };
  } catch {
    // Unparseable JSON or no storage at all: everything expanded, and the next
    // toggle overwrites the bad payload instead of preserving it.
    return { version: 1, collapsed: {}, moduleGroups: {} };
  }
}

function persist(collapsed) {
  try {
    localStorage.setItem(INSPECTOR_COLLAPSED_KEY, JSON.stringify({ version: 1, collapsed }));
  } catch {
    // Non-fatal: the fold applies to this session only.
  }
}

function persistModuleGroups(moduleGroups) {
  try {
    localStorage.setItem(INSPECTOR_MODULE_GROUPS_KEY, JSON.stringify({ version: 1, moduleGroups }));
  } catch {
    // Non-fatal: the fold applies to this session only.
  }
}

/** Live fold state. VM-wide so an HMR reload or a `?t=` module twin does not
 *  fork it into two truths about which sections are open — see singleton.js. */
export const useInspectorCollapse = vmSingleton("inspectorCollapseStore", () => create(() => load()));

function commit(collapsed) {
  useInspectorCollapse.setState({ collapsed });
  persist(collapsed);
}

/** Flips one type. The section header's chevron and its title are two click
 *  targets for this one function. */
export function toggleTypeCollapsed(type) {
  const { collapsed } = useInspectorCollapse.getState();
  const next = { ...collapsed };
  if (next[type]) delete next[type];
  else next[type] = true;
  commit(next);
}

/**
 * Folds or unfolds every type in `types` at once — the section context menu's
 * "Collapse/Expand All Sections". An empty list is a no-op that still persists
 * the (unchanged) object, which is what "expand all" with nothing collapsed
 * already was.
 */
export function setTypesCollapsed(types, collapsed) {
  const next = { ...useInspectorCollapse.getState().collapsed };
  for (const type of types) {
    if (collapsed) next[type] = true;
    else delete next[type];
  }
  commit(next);
}

/** `[isCollapsed, toggle]` for one section. The selector returns a boolean, so
 *  a section only re-renders when ITS type changes — not when a neighbour is
 *  folded. */
export function useComponentCollapsed(type) {
  const collapsed = useInspectorCollapse((s) => !!s.collapsed[type]);
  const toggleCollapsed = useCallback(() => toggleTypeCollapsed(type), [type]);
  return [collapsed, toggleCollapsed];
}

/** Flips one module group's fold ("Physics", "Global Illumination" …). Keyed
 *  by MODULE id, shared by every component that groups it and every entity —
 *  the same "one fold, everywhere" rule as the component types above. */
export function toggleModuleGroupCollapsed(moduleId) {
  const { moduleGroups } = useInspectorCollapse.getState();
  const next = { ...moduleGroups };
  if (next[moduleId]) delete next[moduleId];
  else next[moduleId] = true;
  useInspectorCollapse.setState({ moduleGroups: next });
  persistModuleGroups(next);
}

/** `[isCollapsed, toggle]` for one module group inside a component section. */
export function useModuleGroupCollapsed(moduleId) {
  const collapsed = useInspectorCollapse((s) => !!s.moduleGroups?.[moduleId]);
  const toggleCollapsed = useCallback(() => toggleModuleGroupCollapsed(moduleId), [moduleId]);
  return [collapsed, toggleCollapsed];
}
