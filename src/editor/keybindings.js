import { getProjectSettings, saveProjectSettings } from "./projectSettings.js";
import { KEY_BINDING_ACTIONS } from "./keyChords.js";
import { engine } from "./engineInstance.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { commandBus } from "./commands/CommandBus.js";
import {
  BatchCommand,
  SetEntityEnabledInEditorCommand,
  SetEntityEnabledInGameCommand,
  topMostIds,
} from "./commands/entityCommands.js";

/**
 * The rebindable editor actions and the dispatchers that run them.
 *
 * `getBindings` layers the project's overrides over the shipped defaults in
 * `KEY_BINDING_ACTIONS`; the dispatchers below turn a KeyboardEvent into
 * commands on the bus. The chord grammar and the action table itself live in
 * `keyChords.js` — pure, engine-free, and therefore readable by the settings
 * catalog and by tests.
 *
 * Non-rebindable shortcuts (Ctrl+S, Ctrl+O, Ctrl+P and the rest) intentionally
 * stay with the code that answers them; `keyCatalog.js` is where they are all
 * written down for the user.
 *
 * All four visibility actions are GROUPWISE toggles: pressing H (or Shift+H, E,
 * Shift+E) once hides the relevant set; pressing it again brings the same set
 * back. The "desired next state" for a group is collapsed to a single boolean —
 * "currently all visible ⇒ hide, otherwise ⇒ show" — mirroring Unreal/Unity
 * behaviour, so the chord doubles as the show-restore action.
 */

// The chord grammar and the action table live in `keyChords.js` — pure, and
// importable without the engine. Re-exported here so every call site that
// already reads them from this module keeps working.
//
// ⛔ IMPORT **AND** RE-EXPORT, NOT `export … from`. A bare `export { x } from
// "./m.js"` forwards the name to consumers and binds NOTHING in this module's
// own scope — so every use of it HERE is a ReferenceError. This file uses all
// six (KEY_BINDING_ACTIONS ×6, chordMatches ×5, normalizeChord ×2, …), and the
// editor threw `Uncaught ReferenceError: chordMatches is not defined` out of
// `dispatchVisibilityKeyAction` on EVERY keydown — i.e. the whole shortcut
// system was dead while looking perfectly well-formed. Nothing static catches
// it: the syntax is valid, the names resolve for importers, and the module
// loads clean. Only pressing a key finds it.
// `KEY_BINDING_ACTIONS` is already imported at the top of the file; the other
// five were bound NOWHERE, which is what threw.
import {
  parseChord,
  normalizeChord,
  keyTokenFromEvent,
  chordMatches,
  describeBinding,
} from "./keyChords.js";

export {
  KEY_BINDING_ACTIONS,
  parseChord,
  normalizeChord,
  keyTokenFromEvent,
  chordMatches,
  describeBinding,
};

let cached = null;

/** Returns the current bindings (defaults + project overrides). Memoised. */
export function getBindings() {
  if (cached) return cached;
  const overrides = getProjectSettings().editor?.keybindings ?? {};
  cached = {};
  for (const [action, def] of Object.entries(KEY_BINDING_ACTIONS)) {
    cached[action] = overrides[action] ?? def.default;
  }
  return cached;
}

/** Drops the cache. Call after `saveProjectSettings` to refresh reads. */
export function invalidateKeyBindings() {
  cached = null;
}

/** Reads a single binding. Returns the empty string when no chord is set. */
export function getBinding(actionId) {
  return getBindings()[actionId] ?? KEY_BINDING_ACTIONS[actionId]?.default ?? "";
}

/**
 * Persists a single binding change. We always re-serialise the entire
 * `keybindings` block (the only way to round-trip through project.json
 * cleanly with the existing `saveProjectSettings` API).
 */
export async function setBinding(actionId, chord) {
  if (!KEY_BINDING_ACTIONS[actionId]) {
    throw new Error(`Unknown keybinding action: ${actionId}`);
  }
  const next = normalizeChord(chord);
  const current = getProjectSettings();
  const updated = {
    ...current,
    editor: {
      ...current.editor,
      keybindings: { ...(current.editor?.keybindings ?? {}), [actionId]: next },
    },
  };
  await saveProjectSettings(updated);
  invalidateKeyBindings();
}



/**
 * Public action runners — exposed so the menu bar can trigger the same
 * behaviour the keyboard would produce, without having to fake a
 * KeyboardEvent. Each returns true when at least one command was queued.
 *
 * All four are GROUPWISE toggles. The group decision comes from the
 * current visibility of the targeted set ("all visible ⇒ hide, any
 * hidden ⇒ show all"). This makes each chord double as a show-restore
 * shortcut and matches Unreal/Unity expectations.
 */
export const visibilityActions = {
  toggleSelectedEditor() {
    return applyGroupToggle("editor", useSelectionStore.getState().ids);
  },
  toggleUnselectedEditor() {
    return applyGroupToggle("editor", unselectedIds());
  },
  toggleSelectedGame() {
    return applyGroupToggle("game", useSelectionStore.getState().ids);
  },
  toggleUnselectedGame() {
    return applyGroupToggle("game", unselectedIds());
  },
};

/**
 * Single entry point for the visibility hotkeys. Returns true if the
 * event matched a binding and was consumed (so the caller should bail).
 * The matcher order matters only for shadow prevention; the four
 * bindings don't overlap on their defaults.
 */
export function dispatchVisibilityKeyAction(event) {
  const b = getBindings();
  if (chordMatches(event, b["editor.toggleSelected"])) {
    return visibilityActions.toggleSelectedEditor();
  }
  if (chordMatches(event, b["editor.toggleUnselected"])) {
    return visibilityActions.toggleUnselectedEditor();
  }
  if (chordMatches(event, b["game.toggleSelected"])) {
    return visibilityActions.toggleSelectedGame();
  }
  if (chordMatches(event, b["game.toggleUnselected"])) {
    return visibilityActions.toggleUnselectedGame();
  }
  return false;
}

/**
 * All entity ids that are NOT in the current selection, with descendants
 * of other unselected entities trimmed (so a subtree toggle doesn't
 * double-hit). An empty selection ⇒ "everything is unselected".
 */
function unselectedIds() {
  const selected = new Set(useSelectionStore.getState().ids);
  const all = [];
  for (const root of engine.rootEntities) root.traverse((e) => all.push(e.id));
  return topMostIds(all.filter((id) => !selected.has(id)));
}

/**
 * Groupwise visibility toggle. Returns true when at least one command
 * ran. Decision rule:
 *   - Empty group  → no-op (false), nothing to show/hide.
 *   - Group flag at "visible=true" on every member  → hide all.
 *   - Anything else (any member hidden, or mixed)    → show all.
 * Mixed states converge to "all shown" on the next toggle so the chord
 * always has an obvious next action. We skip entities already in the
 * desired state so the undo/redo stack stays minimal.
 */
function applyGroupToggle(mode, ids) {
  if (!ids?.length) return false;
  const Ctor = mode === "game"
    ? SetEntityEnabledInGameCommand
    : SetEntityEnabledInEditorCommand;
  const target = isGroupVisible(mode, ids) ? false : true;
  const cmds = [];
  for (const id of ids) {
    const e = engine.getEntity(id);
    if (!e) continue;
    const flag = mode === "game" ? e.enabledInGame : e.enabledInEditor;
    if (flag === target) continue;
    cmds.push(new Ctor(id, target));
  }
  if (!cmds.length) return false;
  const label = cmds.length === 1
    ? cmds[0].label
    : (target ? "Show" : "Hide") + ` (${cmds.length})`;
  commandBus.execute(new BatchCommand(cmds, label));
  return true;
}

/**
 * True when every entity in `ids` is currently visible in the given
 * mode (or has its flag absent). Empty list is treated as "all visible"
 * so an empty target group short-circuits at the dispatcher (no toggle
 * fires) rather than here.
 */
function isGroupVisible(mode, ids) {
  for (const id of ids) {
    const e = engine.getEntity(id);
    if (!e) continue;
    const flag = mode === "game" ? e.enabledInGame : e.enabledInEditor;
    if (flag === false) return false;
  }
  return true;
}
