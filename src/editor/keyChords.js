/**
 * Chords, as data and as pure functions.
 *
 * Split out of `keybindings.js` so anything can read the keymap without
 * dragging the engine in behind it. That file also owns the DISPATCHERS —
 * which need the live engine, the selection store and the command bus — and a
 * single import of `KEY_BINDING_ACTIONS` used to pull all three, which is why
 * the settings catalog could not be tested outside a browser at all.
 *
 * Chord grammar: "Ctrl+S", "Shift+H", "E", "Ctrl+Alt+K", "Cmd+Z" (Cmd is an
 * alias for Meta). Nothing here touches the DOM beyond reading a
 * KeyboardEvent's own fields.
 */

/**
 * User-rebindable editor actions. Each entry's `default` is the chord
 * shipped out-of-the-box; the project-settings store may override it
 * per-project. The dispatcher below knows which ones flip visibility —
 * `editor.screenshot` is read with `getBinding` by EditorChrome instead,
 * which dynamic-imports its runner so the capture machinery stays out of
 * the boot chunk. Non-rebindable shortcuts (Ctrl+S, Ctrl+O, Ctrl+P,
 * etc.) intentionally stay in EditorChrome.
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
  "editor.screenshot": {
    label: "Screenshot viewport",
    default: "Shift+Alt+S",
  },
};

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
 * The key token a KeyboardEvent should be matched or captured as. A plain
 * alphanumeric `key` passes through; anything else falls back to the
 * PHYSICAL key from `event.code` when that is a letter or digit.
 *
 * The fallback is what makes Alt-chords work at all on macOS: Option+Shift+S
 * reports `key` "Í" (a layout-dependent composed character) but `code`
 * "KeyS", so reading the code is what keeps the chord both captured and
 * matched as "Shift+Alt+S" — and what lets a binding recorded on one layout
 * fire on another. Everything else (named keys, punctuation) keeps `key`.
 */
export function keyTokenFromEvent(event) {
  const key = (event.key || "").toLowerCase();
  if (key.length === 1 && /[a-z0-9]/.test(key)) return key;
  const code = event.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  return key;
}

/**
 * True when `event` matches the supplied chord exactly — modifiers
 * compared as booleans (no folding), key compared case-insensitively
 * through `keyTokenFromEvent` (so macOS Option chords match), auto-repeat
 * rejected.
 */
export function chordMatches(event, chord) {
  const parsed = parseChord(chord);
  if (!parsed || event.repeat) return false;
  const key = keyTokenFromEvent(event);
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
