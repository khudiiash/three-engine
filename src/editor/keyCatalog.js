import { KEY_BINDING_ACTIONS } from "./keyChords.js";

/**
 * Every keyboard shortcut in the editor, as data.
 *
 * The Keybindings page used to list FIVE rows — the four visibility toggles
 * and the screenshot chord — because those are the five that happen to be
 * rebindable. Everything else the editor answers to (Ctrl+S, F, G/R/S, the
 * whole Blender-shaped grammar of the geometry editor, the paint tools, the
 * level and terrain brushes) lived only in the code that reads the key, so the
 * one place a person looks to find out what a key does could not tell them.
 *
 * This is the reference. Rebindable rows carry an `action` and get an editor;
 * the rest are FIXED and read-only — shown so the page answers "what does this
 * key do" and "is this chord already taken", which is most of why anyone opens
 * it. Chords are written in the editor's own grammar ("Ctrl+Shift+S"), and
 * `formatChord` adapts them to the platform at display time: every handler in
 * the codebase tests `e.ctrlKey || e.metaKey`, so a chord written Ctrl is
 * genuinely ⌘ on macOS rather than being approximated as one.
 *
 * ⚠ THIS IS A MANIFEST, NOT A REGISTRY. The handlers still own the behaviour;
 * these rows describe them. Each group names the file it was read from, so a
 * changed keymap has one place to update — and `tests/key-catalog.test.mjs`
 * fails if a rebindable action is missing, duplicated, or spells a chord the
 * parser cannot read.
 */

const isMac = () =>
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");

const MAC_SYMBOLS = { ctrl: "⌘", meta: "⌘", cmd: "⌘", alt: "⌥", shift: "⇧" };
const MAC_KEYS = { delete: "⌦", backspace: "⌫", enter: "↵", escape: "esc", " ": "Space" };

/**
 * One chord, spelled for the machine the user is on.
 *
 * Windows/Linux get it back as written. macOS gets symbols and no separators,
 * the way every Mac app writes a menu accelerator — including Ctrl → ⌘, which
 * is not a translation but the truth: `ctrlKey || metaKey` is what the editor
 * actually tests.
 */
export function formatChord(chord) {
  const text = String(chord ?? "").trim();
  if (!text) return "Unbound";
  // Split on the separator, never on a "+" that IS the key — and do not run
  // this through `normalizeChord`: that lowercases and re-capitalises, which
  // turns "ArrowUp" into "Arrowup" and "Numpad1" into "Numpad1" only by luck.
  // Stored bindings arrive already normalised; catalog rows are written the
  // way they should read.
  const parts = text.split("+").map((p) => p.trim());
  const keys = parts.filter((p, i) => p || i === parts.length - 1).map((p) => p || "+");
  if (!isMac()) return keys.join("+");
  return keys.map((p) => MAC_SYMBOLS[p.toLowerCase()] ?? MAC_KEYS[p.toLowerCase()] ?? p).join("");
}

/** Chords in a row, for the tiny "is this taken?" scan. */
export const chordsOf = (item) => (Array.isArray(item.keys) ? item.keys : [item.keys]);

/**
 * The catalog. `keys` is the chord (or chords) as the handler reads it;
 * `action` names a rebindable entry in KEY_BINDING_ACTIONS and makes the row
 * editable; `note` is the row's tooltip, for the conditions a chord only
 * fires under.
 */
export const KEY_CATALOG = [
  {
    id: "app",
    label: "Application",
    hint: "Fire from anywhere, including the code editor and text fields.",
    source: "EditorChrome.jsx",
    items: [
      { keys: "Ctrl+O", label: "Open scene…" },
      { keys: "Ctrl+S", label: "Save scene" },
      { keys: "Ctrl+Shift+S", label: "Save scene as…" },
      { keys: "Ctrl+F", label: "Quick search", note: "Entities, assets, panels and settings. The code editor keeps it for Find." },
      { keys: "Ctrl+P", label: "Play / Stop" },
      { keys: "Ctrl+Shift+P", label: "Pause / Resume game time" },
      { keys: "Ctrl+.", label: "Step one frame", note: "While playing." },
      { keys: "Ctrl+B", label: "Build game" },
      { keys: "Ctrl+Shift+W", label: "Close project" },
    ],
  },
  {
    id: "scene",
    label: "Scene editing",
    hint: "The scene verbs. Any panel that owns the keyboard gets them instead.",
    source: "EditorChrome.jsx",
    items: [
      { keys: "Ctrl+Z", label: "Undo" },
      { keys: ["Ctrl+Shift+Z", "Ctrl+Y"], label: "Redo" },
      { keys: "Ctrl+C", label: "Copy entities" },
      { keys: "Ctrl+X", label: "Cut entities" },
      { keys: "Ctrl+V", label: "Paste entities", note: "As a sibling of the first selected entity, or at the scene root." },
      { keys: "Ctrl+D", label: "Duplicate" },
      { keys: "Shift+D", label: "Duplicate and move", note: "Duplicates, then starts the move macro on the copy." },
      { keys: "Ctrl+G", label: "Group selection", note: "Two or more entities." },
      { keys: "Delete", label: "Delete selection" },
    ],
  },
  {
    id: "viewport",
    label: "Viewport",
    hint: "Act on what the pointer is over. The four visibility toggles and the screenshot chord are rebindable.",
    source: "ViewportPanel.jsx · keybindings.js",
    items: [
      { keys: "F", label: "Focus selection", note: "Also works with the pointer over the Hierarchy." },
      { keys: "Tab", label: "Enter geometry edit mode", note: "With a mesh entity selected." },
      { keys: "G", label: "Move (macro)" },
      { keys: "R", label: "Rotate (macro)" },
      { keys: "S", label: "Scale (macro)" },
      { keys: "Shift+S", label: "3D cursor snap menu" },
      { keys: "Shift+C", label: "3D cursor to world origin" },
      { action: "editor.toggleSelected", label: "Hide / show selected (editor)" },
      { action: "editor.toggleUnselected", label: "Hide / show unselected (editor)" },
      { action: "game.toggleSelected", label: "Hide / show selected (game)" },
      { action: "game.toggleUnselected", label: "Hide / show unselected (game)" },
      { action: "editor.screenshot", label: "Screenshot viewport" },
      { keys: ["Delete", "X"], label: "Delete spline knot", note: "While a spline is armed for editing." },
    ],
  },
  {
    id: "macro",
    label: "Transform macro",
    hint: "While a G / R / S macro is running in the viewport.",
    source: "ViewportPanel.jsx",
    items: [
      { keys: ["X", "Y", "Z"], label: "Lock to an axis", note: "Cumulative: R Y Z constrains to the YZ plane. Press the last axis again to unlock." },
      { keys: ["0–9", "."], label: "Type an exact value" },
      { keys: "-", label: "Flip the sign of the typed value" },
      { keys: "Backspace", label: "Erase a digit, then drop the last axis" },
      { keys: ["Enter", "Space"], label: "Commit" },
      { keys: "Escape", label: "Cancel" },
    ],
  },
  {
    id: "hierarchy",
    label: "Hierarchy",
    hint: "While the pointer or focus is in the Hierarchy panel. Everything else falls through to the scene verbs above.",
    source: "HierarchyPanel.jsx · keyScope.js",
    items: [
      { keys: ["Ctrl+A", "Shift+A"], label: "Select all" },
      { keys: ["Ctrl+Shift+A", "Alt+A"], label: "Deselect all" },
      { keys: "Ctrl+I", label: "Invert selection" },
      { keys: ["ArrowUp", "ArrowDown"], label: "Move the row cursor" },
      { keys: ["Shift+ArrowUp", "Shift+ArrowDown"], label: "Extend the selection" },
      { keys: ["Home", "End"], label: "First / last row" },
      { keys: ["Shift+Home", "Shift+End"], label: "Extend to first / last row" },
      { keys: "Escape", label: "Disarm a pick", note: "Follow target, surface, listener, scatter source." },
    ],
  },
  {
    id: "assets",
    label: "Assets",
    source: "AssetsPanel.jsx",
    items: [
      { keys: "Enter", label: "Open the selected asset" },
      { keys: "F2", label: "Rename" },
      { keys: "Delete", label: "Delete selected assets" },
      { keys: "Ctrl+A", label: "Select all" },
      { keys: "Ctrl+G", label: "Group into a new folder" },
      { keys: "Escape", label: "Clear the selection or the filter" },
    ],
  },
  {
    id: "geometry-modes",
    label: "Geometry edit — modes & selection",
    hint: "Blender's grammar. Live while the geometry editor owns the keyboard.",
    source: "GeometryEditorPanel.jsx",
    items: [
      { keys: ["1", "2", "3"], label: "Vertex / edge / face mode" },
      { keys: "Tab", label: "Leave edit mode" },
      { keys: "A", label: "Select all" },
      { keys: "Alt+A", label: "Select none" },
      { keys: "B", label: "Box select" },
      { keys: "C", label: "Circle select" },
      { keys: "L", label: "Select linked under the cursor" },
      { keys: "Ctrl+L", label: "Select linked (all)" },
      { keys: "Ctrl+I", label: "Invert selection" },
      { keys: ["Ctrl+=", "Ctrl+-"], label: "Grow / shrink selection", note: "The numpad + and − keys work too." },
      { keys: "Shift+G", label: "Select similar…" },
      { keys: ["Ctrl+Z", "Ctrl+Shift+Z"], label: "Undo / redo" },
    ],
  },
  {
    id: "geometry-transform",
    label: "Geometry edit — transform & tools",
    source: "GeometryEditorPanel.jsx",
    items: [
      { keys: "G", label: "Move / edge slide" },
      { keys: "R", label: "Rotate" },
      { keys: "S", label: "Scale" },
      { keys: "Alt+S", label: "Shrink / fatten" },
      { keys: "E", label: "Extrude region" },
      { keys: "Alt+E", label: "Extrude menu", note: "E region · I individual · N along normals · V vertices" },
      { keys: "I", label: "Inset faces", note: "Shift+I insets individually." },
      { keys: "K", label: "Knife", note: "Enter confirms, Escape cancels." },
      { keys: "Ctrl+B", label: "Bevel" },
      { keys: "Ctrl+R", label: "Loop cut" },
      { keys: "Ctrl+Shift+R", label: "Offset edge loop" },
      { keys: "V", label: "Rip" },
      { keys: "Y", label: "Split" },
      { keys: "P", label: "Separate" },
      { keys: "F", label: "Make edge / face" },
      { keys: "Alt+F", label: "Fill holes" },
      { keys: "J", label: "Connect vertex path" },
      { keys: "Alt+J", label: "Tris to quads" },
      { keys: "Ctrl+T", label: "Triangulate" },
      { keys: "Shift+D", label: "Duplicate" },
      { keys: "Shift+N", label: "Recalculate normals" },
      { keys: "Alt+N", label: "Flip normals" },
      { keys: "Shift+A", label: "Add menu, at the pointer" },
      { keys: "O", label: "Proportional editing", note: "Alt+O toggles connected-only falloff." },
      { keys: "Shift+Tab", label: "Snapping" },
    ],
  },
  {
    id: "geometry-chords",
    label: "Geometry edit — two-key menus",
    hint: "Press the chord, then one more key. The status line names the choices.",
    source: "GeometryEditorPanel.jsx",
    items: [
      { keys: "Ctrl+E", label: "Edge menu", note: "B bevel · R loop cut · S mark seam · Shift+S clear seam · H mark sharp · Shift+H clear sharp · G slide · J bridge · F grid fill" },
      { keys: "Ctrl+V", label: "Vertex menu", note: "M merge · S smooth · R rip · F rip fill · Y split · C connect" },
      { keys: "Ctrl+F", label: "Face menu", note: "I inset · E extrude · P poke · T triangulate · J tris to quads · S shade smooth · Shift+S shade flat" },
      { keys: "M", label: "Merge menu", note: "C center · U cursor · L collapse · F first · A last · D by distance" },
      { keys: ["X", "Delete"], label: "Delete menu", note: "V vertices · E edges · F faces · O only faces · D dissolve verts · G dissolve edges · S dissolve faces · L limited dissolve" },
      { keys: "Shift+S", label: "Snap menu", note: "C cursor to selection · S selection to cursor · O cursor to origin" },
    ],
  },
  {
    id: "geometry-view",
    label: "Geometry edit — view",
    source: "GeometryEditorPanel.jsx",
    items: [
      { keys: "Z", label: "Cycle shading", note: "Shift+Z cycles backwards." },
      { keys: "Alt+Z", label: "X-ray" },
      { keys: ".", label: "Focus the selection" },
      { keys: "Home", label: "Frame the whole mesh" },
      { keys: ["Numpad1", "Numpad3", "Numpad7"], label: "Front / right / top view", note: "Numpad9 / 4 / 6 give the opposite side." },
    ],
  },
  {
    id: "sculpt",
    label: "Sculpt & vertex paint",
    hint: "Inside the geometry editor, while a sculpt or paint brush is active.",
    source: "GeometryEditorPanel.jsx",
    items: [
      { keys: ["[", "]"], label: "Brush radius" },
      { keys: ["{", "}"], label: "Brush strength" },
      { keys: "D", label: "Dynamic topology" },
      { keys: ".", label: "Frame the mesh" },
      { keys: "Ctrl+Z", label: "Undo the last stroke" },
      { keys: ["X", "C", "I", "S"], label: "Draw / clay / inflate / smooth" },
      { keys: ["F", "R", "P", "G", "N"], label: "Flatten / scrape / pinch / grab / nudge" },
    ],
  },
  {
    id: "texture",
    label: "Texture editor",
    source: "TextureEditorPanel.jsx",
    items: [
      { keys: ["B", "E", "G"], label: "Brush / eraser / paint bucket" },
      { keys: ["N", "U", "R", "O"], label: "Gradient / line / rectangle / ellipse" },
      { keys: ["M", "L", "W"], label: "Rectangle select / lasso / magic wand" },
      { keys: ["I", "T", "V"], label: "Eyedropper / text / move layer" },
      { keys: "X", label: "Swap foreground and background colour" },
      { keys: ["[", "]"], label: "Brush size" },
      { keys: "Space", label: "Pan the canvas", note: "Hold." },
      { keys: ["Ctrl+Z", "Ctrl+Shift+Z"], label: "Undo / redo" },
      { keys: "Ctrl+S", label: "Save the texture" },
      { keys: "Ctrl+A", label: "Select all" },
      { keys: "Ctrl+D", label: "Deselect" },
      { keys: "Ctrl+I", label: "Invert the selection" },
      { keys: ["Ctrl+C", "Ctrl+X", "Ctrl+V"], label: "Copy / cut / paste as layer" },
      { keys: "Ctrl+J", label: "Layer via copy", note: "Shift+Ctrl+J cuts instead." },
      { keys: ["Delete", "Backspace"], label: "Erase the selection" },
    ],
  },
  {
    id: "audio",
    label: "Audio editor",
    source: "AudioEditorPanel.jsx",
    items: [
      { keys: "Space", label: "Play / stop" },
      { keys: ["Ctrl+Z", "Ctrl+Shift+Z"], label: "Undo / redo" },
      { keys: "Ctrl+S", label: "Save" },
      { keys: ["Ctrl+C", "Ctrl+X", "Ctrl+V"], label: "Copy / cut / paste" },
      { keys: "Ctrl+A", label: "Select the whole track" },
      { keys: ["Delete", "Backspace"], label: "Delete the selection" },
    ],
  },
  {
    id: "timeline",
    label: "Animation timeline",
    source: "TimelinePanel.jsx",
    items: [
      { keys: "Space", label: "Play / pause the clip" },
      { keys: ["ArrowLeft", "ArrowRight"], label: "Step the playhead" },
      { keys: ["Home", "End"], label: "Jump to the start / end" },
      { keys: ["Delete", "Backspace"], label: "Delete selected keys" },
      { keys: ["Ctrl+Z", "Ctrl+Y"], label: "Undo / redo" },
      { keys: "Ctrl+S", label: "Save the clip" },
    ],
  },
  {
    id: "graph",
    label: "Node graphs",
    hint: "Shader Graph, Event Graph and the particle graph share one keymap.",
    source: "nodegraph/GraphEditor.jsx",
    items: [
      { keys: "F", label: "Frame the graph" },
      { keys: ["Ctrl+Z", "Ctrl+Shift+Z", "Ctrl+Y"], label: "Undo / redo" },
      { keys: ["Ctrl+C", "Ctrl+X", "Ctrl+V"], label: "Copy / cut / paste nodes" },
      { keys: "Ctrl+D", label: "Duplicate nodes" },
    ],
  },
  {
    id: "level",
    label: "Level tool",
    hint: "Only while a level tool is armed — it owns the number keys while it is.",
    source: "levelTool.js",
    items: [
      { keys: "1–8", label: "Select · floor · wall · stair · ramp · box · column · opening" },
      { keys: ["X", "Delete"], label: "Erase tool" },
      { keys: ["U", "J"], label: "Raise / lower the elevation" },
      { keys: ["[", "]"], label: "Shrink / grow the grid" },
      { keys: "O", label: "Cycle door / window / arch" },
      { keys: "Shift+D", label: "Flip a stair or ramp's climb direction" },
      { keys: "Escape", label: "Disarm" },
    ],
  },
  {
    id: "terrain",
    label: "Terrain brush",
    hint: "Only while a terrain entity is selected.",
    source: "terrainBrush.js",
    items: [
      { keys: ["S", "P", "E"], label: "Sculpt / paint / erase" },
      { keys: "C", label: "Scatter", note: "Only with scatter layers on the terrain." },
      { keys: ["B", "Escape"], label: "Disarm the brush" },
      { keys: ["[", "]"], label: "Brush radius" },
      { keys: ["{", "}"], label: "Brush strength" },
      { keys: "F", label: "Drag-adjust the radius", note: "Shift+F adjusts strength, Ctrl+F hardness. Enter commits, Escape cancels." },
    ],
  },
  {
    id: "code",
    label: "Code editor",
    hint: "The two chords the code editor claims from the editor. Everything else inside it is Monaco's standard keymap — F12 go to definition, Ctrl+Space completions, Alt+Up/Down move line.",
    source: "components/CodeEditor.jsx · keyScope.js",
    items: [
      { keys: "Ctrl+S", label: "Save the file" },
      { keys: "Ctrl+F", label: "Find in file" },
    ],
  },
];

/** Every row, flattened — for lookups and for the duplicate-chord check. */
export function allKeyRows() {
  return KEY_CATALOG.flatMap((group) =>
    group.items.map((item) => ({
      ...item,
      group: group.id,
      groupLabel: group.label,
      keys: item.action ? [KEY_BINDING_ACTIONS[item.action]?.default ?? ""] : chordsOf(item),
      label: item.label ?? KEY_BINDING_ACTIONS[item.action]?.label ?? item.action,
    })),
  );
}
