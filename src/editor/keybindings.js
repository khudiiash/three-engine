import { getProjectSettings, saveProjectSettings } from "./projectSettings.js";
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
 * User-rebindable editor actions. Each entry's `default` is the chord
 * shipped out-of-the-box; the project-settings store may override it
 * per-project. The dispatcher below knows which ones flip visibility —
 * non-rebindable shortcuts (Ctrl+S, Ctrl+O, Ctrl+P, etc.) intentionally
 * stay in EditorChrome.
 *
 * Chord grammar: "Ctrl+S", "Shift+H", "E", "Ctrl+Alt+K", "Cmd+Z" (Cmd
 * is an alias for Meta). Parsing/validation lives in `parseChord` and
 * `normalizeChord`; matching in `chordMatches`.
 *
 * All four visibility actions are GROUPWISE toggles: pressing H (or
 * Shift+H, E, Shift+E) once hides the relevant set; pressing it again
 * brings the same set back. The "desired next state" for a group is
 * collapsed to a single boolean — "currently all visible ⇒ hide,
 * otherwise ⇒ show" — mirroring Unreal/Unity behaviour. This makes the
 * chord double as the show-restore action and avoids a second binding.
 */
export const KEY_BINDING_ACTIONS = {
  "editor.toggleSelected": {
    label: "Toggle selected (editor)",
    default: "H",
  },
  "editor.toggleUnselected": {
    label: "Toggle all unselected (editor)",
    default: "Shift+H",
  },
  "game.toggleSelected": {
    label: "Toggle selected (game)",
    default: "E",
  },
  "game.toggleUnselected": {
    label: "Toggle all unselected (game)",
    default: "Shift+E",
  },
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
 * Parses a user-supplied chord (e.g. "Ctrl+Shift+H") into a struct:
 *   { key, ctrl, shift, alt, meta }
 * `key` is lowercased. Modifier names ("Ctrl"/"Shift"/"Alt"/"Meta" and
 * their "Cmd"/"Control"/"Command" aliases) are recognised anywhere in
 * the chord; the final non-modifier token is treated as the key.
 */
export function parseChord(combo) {
  if (!combo) return null;
  const parts = String(combo)
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out = { key: "", ctrl: false, shift: false, alt: false, meta: false };
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === "ctrl" || lower === "control") out.ctrl = true;
    else if (lower === "shift") out.shift = true;
    else if (lower === "alt") out.alt = true;
    else if (lower === "meta" || lower === "cmd" || lower === "command") out.meta = true;
    else out.key = lower;
  }
  return out.key ? out : null;
}

/**
 * Canonicalises a chord for storage: trims whitespace, normalises
 * modifier spellings ("Ctrl" / "Shift" / "Alt" / "Meta"), titlecases the
 * key letter. Empty in / empty out.
 */
export function normalizeChord(combo) {
  const parsed = parseChord(combo);
  if (!parsed) return "";
  const tokens = [];
  if (parsed.ctrl) tokens.push("Ctrl");
  if (parsed.shift) tokens.push("Shift");
  if (parsed.alt) tokens.push("Alt");
  if (parsed.meta) tokens.push("Meta");
  tokens.push(parsed.key.charAt(0).toUpperCase() + parsed.key.slice(1));
  return tokens.join("+");
}

/**
 * True when `event` matches the supplied chord exactly — modifiers
 * compared as booleans (no folding), key compared case-insensitively,
 * auto-repeat rejected.
 */
export function chordMatches(event, chord) {
  const parsed = parseChord(chord);
  if (!parsed || event.repeat) return false;
  const key = (event.key || "").toLowerCase();
  return (
    parsed.ctrl === !!event.ctrlKey &&
    parsed.meta === !!event.metaKey &&
    parsed.shift === !!event.shiftKey &&
    parsed.alt === !!event.altKey &&
    key === parsed.key
  );
}

/**
 * Human-friendly rendering for menus and settings UI. An empty chord
 * becomes "Unbound" so the action still surfaces in the list — the user
 * can rebind it from the project-settings panel.
 */
export function describeBinding(chord) {
  return normalizeChord(chord) || "Unbound";
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
