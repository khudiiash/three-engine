# Editor UI plan — the shell, its tabs and panels (2026-09-07)

The brief, in the user's words: *"design better editor UI, its tabs, panels,
etc. It must be modern, without text everywhere, easy to use, with good and
pleasing UX."*

This document is the ledger for that work: what the shell looks like today,
the design system the redesign commits to, the layout, and the stages that
ship it. The clickable mockup is `docs/mockups/editor-ui-mockup.html` (also
published as an Artifact); it shows the same scene state as the capture the
plan was drawn against (Sponza, `Player` selected) so the two can be compared
side by side.

---

## 0. What the shell looks like today (capture 2026-09-07, 2906×1730)

Read against the brief, the faults are these — every one of them is *text
doing the job of form*:

1. **Two title rows.** The OS title bar ("Three Engine") plus a 38 px menu bar
   with five words on the left and three status chips floating on the right.
   ~90 px of the top of the window carries eight words.
2. **Tab strips are walls of text.** The Assets group shows *Assets, Terminal,
   Shader Graph, Animator, Particles, Sketchfab, Poly Haven, Post Process* plus
   an overflow "∨ 2"; the Inspector group shows three more plus an overflow.
   Every tab carries a permanent close ×, including Viewport, Hierarchy and
   Inspector, which are never closed on purpose.
3. **Uppercase tracked eyebrows** everywhere the editor names a group:
   `SPONZA`, `TRANSFORM`, `CHARACTER CONTROLLER`, `GAME`, `PERFORMANCE`,
   `RENDERER`. The rest of the editor is carefully sentence-case; the
   eyebrows read as a second, louder voice.
4. **Every dock group is an outlined, rounded card on black.** Border + radius
   + gap on all eight groups makes the viewport — the one surface that is a
   *picture* — look like one more card among the instruments.
5. **Per-row toggles on every hierarchy row** (eye + play), always visible,
   on rows that are almost always on. Two glyphs per row that carry no
   information 95 % of the time.
6. **The inspector is a form.** 76 px grey label + a full-width filled input,
   repeated ~25 times for one component. Section headers carry three action
   buttons at full opacity. Nothing is *shown*; everything is *listed*.
7. **The Assets panel has two stacked toolbars** (icons row, then a
   full-width search row with a filter dropdown) above a folder tree and a
   grid — three chrome rows before the first asset.
8. **The Window menu is the only way to discover panels**: 38 text items.
9. **The accent (iOS blue `#0a84ff`) is also the Z-axis colour and the
   prefab-link colour** in the hierarchy (`sponza2`, `Mesh_0` are blue). A
   selected row, a Z field and a prefab child all say "blue" and mean three
   different things.

What is already right and is kept: filled, borderless inputs with a focus
ring; the coloured component glyphs (`componentIcons.js` — rendering blue,
lighting amber, physics green, logic purple, audio pink, UI teal, AI orange);
the glass stats overlay in the viewport; the folding section headers keyed by
component type; the quick search.

---

## 1. Design system

### Palette — today's neutrals, one new accent

**Decided with the user 2026-09-07:** the first proposal's graphite + teal +
amber scheme was rejected; the neutrals stay exactly as they are today and
the accent changes. Dark only.

| token | hex | role |
| --- | --- | --- |
| `--bg-0` | `#0d0e11` | ground: the top bar, the 1 px seams between groups, the surround of the picture |
| `--bg-1` | `#151619` | panel surfaces |
| `--bg-2` | `#1c1d22` | raised: toolbars, the active tab, popovers |
| `--bg-3` | `#25262c` | hover fills, pressed |
| `--text` | `#ececee` | primary text and active glyphs |
| `--text-dim` | `#8a8d95` | secondary text, inactive glyphs |
| `--text-faint` | `#5d6067` | units, paths, timestamps (new) |
| `--accent` | `#8f82ff` | **the accent** — selection, focus ring, the active tool, the primary button. A violet: it is the one hue the editor does not already use for something else. |
| `--live` | `#e2a33c` | the transport while the game runs; also warnings (today's `--warn`) |
| `--danger` | `#ff5d55` | destructive, errors |
| `--ok` | `#4fd475` | success |

Rule: **blue is an axis** (Z `#4da3ff`, X red, Y green) and the prefab-link
colour retires (a prefab child shows a package glyph instead); **violet is a
selection**; **amber is live**. Today's iOS blue collided with the Z axis and
prefab names; violet collides with nothing.

Fills stay alpha-white (`--fill-1: rgba(255,255,255,.055)`, `--fill-2: .09`).
Borders are gone as a separating device; the 1 px `--bg-0` seam is the only
line between groups.

### Type — the system font, as today

**Decided with the user 2026-09-07:** no bundled face. The stack stays
`-apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui`; the console,
the terminal and code keep Cascadia Mono / Consolas. Numbers everywhere get
`font-variant-numeric: tabular-nums` (Segoe UI Variable supports it), which is
what makes a column of values line up without a mono face.

| size | weight | use |
| --- | --- | --- |
| 10.5–11 px | 600 | counts, badges, chips |
| 12 px | 400 / 500 | body: rows, fields, labels, menu items |
| 12 px | 600 | section titles, the active tab label |
| 13 px | 500 | the entity / asset name field |
| 15 px | 600 | dialog titles |

No `text-transform: uppercase` anywhere. No letter-spacing on labels.

### Words — the rule

**User, 2026-09-07:** *"all explainers must be hidden, I don't like that text
hints everywhere, they are annoying, use as few text as possible, icons
wherever possible."*

- **No explainer paragraphs, anywhere.** Not under a field, not at the top of
  a panel, not in an empty state, not in a footer. What a control does is its
  tooltip (`title`), shown only on hover.
- **A verb is a glyph.** Toolbar and header actions are icon buttons with a
  tooltip. A word stays only on a primary action whose glyph would be
  ambiguous alone ("Add component", "Add script", "Open texture").
- **An empty state is one glyph and, at most, one action.** Never a sentence
  telling the user what to select first.
- **Menus keep their labels** (a menu is a list of words by nature) but every
  item also carries its glyph, and group titles are sentence case.
- **A count is a chip, not a sentence.** "4 bindings" → `4`; "329 overrides"
  → `329` on the prefab row.

### Shape

| token | value |
| --- | --- |
| `--r-1` | 4 px — fields, small buttons, tabs |
| `--r-2` | 8 px — popovers, menus, glass clusters |
| control height | 24 px (fields, tab strip buttons), 28 px (top-bar controls) |
| row height | 24 px hierarchy / tree rows |
| motion | 120 ms `cubic-bezier(.2,0,0,1)`; hover reveals only; nothing moves on load |

---

## 2. Layout — one bar, one picture, quiet instruments

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◉ File Edit Window …        ▶  ⏸  ⏭       Sponza •      ⎇ main 4185  ◉ 10 ─ ▢ ✕│  36 px
├──────────────┬───────────────────────────────────────────────┬───────────────┤
│ ⋮≡ Hierarchy │                                               │ ⚙ Inspector ▤ ▤ +│
│ + 🗑  search  │   ⌖ ↔ ⟳ ⤢ | ⌗ snap | ◫ layers     fps 79 ▾  │ [Player      ] 👁▶│
│ ▸ Sponza     │                                               │ ▸ ⟂ Transform  │
│  ☼ Dir Light │              (the picture, edge to edge)      │  Position x y z│
│  ▸🚶 Player  │                                               │ ▸ 🚶 Character │
│  ▾ ○ sponza2 │                                               │   Controller   │
│    ▸ Mesh_0  │  ✦ x0 y0 z0                          [gizmo] │  Layer  Player │
├──────────────┴───────────────────────────────────────────────┤  Radius   0.3  │
│ ▣ Assets  ⌘ ◈ ⌬ ⚡ ▤ ◎ …  +                                 │  …             │
│ ◧ Game › Character        🔍 search   ▾ all  ☰ ▦ ▩   ⤓      │                │
│ tree │ tiles …                                                │                │
└──────────────────────────────────────────────────────────────┴───────────────┘
```

- **One 36 px top bar.** Menus left (text — a menu is text by nature), the
  **transport centred** (Play / Pause / Step — the one control that gets
  colour: `--signal` at rest, `--ember` while running, and a 1 px ember line
  under the whole bar so "the game is running" is visible from any panel),
  the scene name with its dirty dot beside it, status as icon chips on the
  right (branch, assistant sessions, preview), then the window controls.
  With Tauri `decorations: false` the bar *is* the title bar (stage 2b).
- **The transport leaves the viewport.** `EditorChrome.jsx` already treats
  Play as an application verb ("running the game means the same thing whether
  you are in the viewport or mid-word in the code editor"); the toolbar
  placement contradicted the keyboard. Build / preview go to the top bar with
  it.
- **Groups are flat slabs** of `--g1` separated by 1 px of `--g0`. No border,
  no radius, no shadow. The viewport group has no chrome at all below its tab
  strip: the picture runs edge to edge.
- **Tabs are icon-first.** Every panel gets a glyph (`PANEL_SPECS[id].icon`).
  The active tab shows glyph + label on a `--g2` fill; inactive tabs are the
  glyph alone in `--ink-2`, and the label slides out on hover. Close × exists
  only on hover. A group's strip ends with **+**, which opens the **panel
  launcher**: an icon grid of every panel in five families (Scene ·
  Authoring · Libraries · Project · Tools), "open here". This is the primary
  discovery path; the Window menu stays for the keyboard.
- **Instruments float over the picture** as glass clusters (the editor's own
  existing language: the stats overlay already works this way). Top-left the
  tool cluster (select / move / rotate / scale, a snap toggle, layers);
  top-right the stats; bottom-left the 3D-cursor readout in mono; bottom-right
  the axis gizmo. All of them are glyphs; the only text on the picture is a
  number.
- **Hierarchy rows show their toggles on hover**, and permanently only when
  something is *off* (a hidden entity keeps a dim eye-off glyph). The scene
  row is a sentence-case row with a scene glyph and the selection tally.
- **The inspector opens with the entity, not a form**: the name as a
  13 px field, the editor / game enable as two icon toggles beside it, tags
  below. Component sections: fold chevron, the coloured glyph, the title in
  sentence case; the view-only / enable / remove cluster appears on hover.
  Labels are 88 px `--ink-2`; numbers are mono; vector rows keep the coloured
  x / y / z prefixes.
- **Assets has one chrome row**: tree toggle, the path as chips, search,
  the type filter as a glyph menu, the three view toggles, import. The tree
  and the grid start on the second row.
- **The console tab wears its error count** as a badge instead of a pulsing
  dot; the panel's only toolbar button (Clear) becomes a glyph.

---

## 3. Principles

1. **Only the viewport is a picture.** Every other surface is flat and
   borderless; tone separates, lines do not.
2. **A word appears once.** The active tab *is* the panel's title; no header
   repeats it. A section title names the component; the fields do not repeat
   the section.
3. **Glyph carries identity, colour carries family, text carries value.**
   The `componentIcons.js` families are the colour system of the whole
   editor, not just the Add Component menu.
4. **Blue is an axis. Teal is a selection. Amber is live.**
5. **Controls appear where the hand is.** Row actions, tab close, section
   actions: on hover, never at rest.
6. **No motion the user did not cause.** Hover reveals and the launcher's
   open are the only transitions; nothing animates on load.

### The generic-default check

Asked "redesign a dark game editor, modern, less text", the default answer is:
a VS Code activity rail, Inter, an iOS-blue accent, rounded cards with
borders, uppercase eyebrows, and a floating everything. This plan deliberately
does not spend on those: no rail (the per-group **+** launcher is where a
panel is opened, next to where it will appear — Blender's editor-type menu,
not VS Code's rail); Plex, not Inter; the accent comes from the logo and the
brand's second colour is reserved for one state; groups are separated by
tone; eyebrows are removed rather than restyled. The floating glass HUD *is* a
current default, but it is also the editor's own existing language, and the
brief's "modern" points at it — kept, and confined to the picture.

---

## 4. Stages

Each stage is shippable alone and leaves every existing test green. Look
changes are receipted by the user (no screenshots — the standing rule).

| stage | what | files | receipt |
| --- | --- | --- | --- |
| **0 · tokens + type** | New `:root` tokens (`--g0…3`, `--signal`, `--ember`, radii); Plex woff2 bundled + `@font-face`; mono for readouts. Every `text-transform: uppercase` in the shell removed (`scene-label`, `section-header`, stats headers, asset breadcrumb, settings headers). Old token names aliased (`--bg-0` → `--g0` …) so the 14.6 k-line sheet keeps working while it is swept. | `theme.css`, `src/editor/fonts/` | `grep -c "text-transform: uppercase" theme.css` drops to 0 in shell sections; `test:editor-prefs`, `smoke:inspector-collapse` green (the smoke reads the section header's computed font/background — update its expectations with the new tokens). |
| **1 · dock** | Flat groups + seams; icon-first tabs via a default `tabComponent` reading `PANEL_SPECS[id].icon`; hover-reveal close; the **+** launcher as a group header action (`rightHeaderActionsComponent`); Console badge replaces the dot. | `EditorShell.jsx`, `theme.css` (Dockview section), `ConsoleTab.jsx` | layout JSON v2 still restores; `openPanel` behaviour unchanged. |
| **2 · one bar** | Transport + build + preview move from `ViewportPanel`'s toolbar to `MenuBar`; status chips become glyph chips with tooltips; the ember "live" line. **2b (optional):** `decorations: false` in both Tauri configs, `data-tauri-drag-region` on the bar, window controls via `@tauri-apps/api/window`. | `MenuBar.jsx`, `ViewportPanel.jsx`, `theme.css`, `src-tauri/*.conf.json` | Ctrl+P / Ctrl+Shift+P / Ctrl+. unchanged; 2b: drag, double-click maximise, snap all work on Windows and macOS. |
| **3 · viewport HUD** | Tool cluster as one glass strip; snap and layers join it; stats overlay restyled (mono, no eyebrow); cursor readout mono. | `ViewportPanel.jsx`, `theme.css` (Viewport section) | the level-blockout palette still fits in one row under the strip (its comment explains why). |
| **4 · hierarchy** | 24 px rows; toggles on hover / off-state only; scene row sentence case. ⚠ `HierarchyPanel.jsx:304` derives virtualisation pitch from the 26 px row + 1 px margin — change both together. | `HierarchyPanel.jsx`, `theme.css` (Hierarchy section) | drag/drop, rename, search highlight, box-select all green. |
| **5 · inspector** | Entity header; section headers (glyph + sentence case, actions on hover); 88 px labels; mono numbers. | `InspectorPanel.jsx` (`SectionFoldHeader`, entity header), `theme.css` (Inspector + fields) | `smoke:inspector-collapse` (fold keyed by type, no flash, 31 px folded height) green. |
| **6 · assets** | One chrome row; path chips; glyph filter menu. | `AssetsPanel.jsx`, `theme.css` (Assets sections) | search / filter / view modes / reveal unchanged. |
| **7 · the sweep** | The other 40 panels: text-only toolbar buttons → glyph + tooltip; remaining eyebrows; card borders. One panel per commit. | per panel | per-panel smoke where one exists. |

Not in scope: a light theme; new panels; changing what any control does.

### Shipped 2026-09-08

Implemented against the second proposal, in this order, all live in the
editor (a reload is needed after each JSX batch — the Tauri webview does not
apply React hot updates, only CSS ones):

- **Stage 0** — tokens in `theme.css` (`--accent` violet, `--on-accent`,
  `--text-faint`, `--live`); every `text-transform: uppercase` (38) and every
  caps-tracking `letter-spacing` (25) deleted; `src/editor/theme-v2.css`
  loaded after `theme.css` carries every new rule, organised by stage;
  **the accent is a project setting**: `editor.accent` in
  `projectSettings.js`, applied by `src/editor/accent.js` (four root custom
  properties, contrast-safe `--on-accent`), picked in Project Settings →
  Editor → Accent (live preview, Save keeps it).
- **Stage 1** — `src/editor/panelCatalog.js` (glyph + title + position per
  panel, five families), `PanelTab.jsx` as Dockview's `defaultTabComponent`
  (glyph always, label on active/hover, close on hover), `PanelLauncher.jsx`
  as `rightHeaderActionsComponent` (the `+` and its icon grid, "open here"
  via `referenceGroup` / `moveTo`), Console badge instead of the dot; flat
  groups with `--dv-separator-border` seams.
- **Stage 2** — `MenuBar.jsx` `Transport` (Play / Pause / Step · Build ·
  Preview · scene chip) centred; `components/BrowserPreviewLauncher.jsx`
  extracted from the viewport; `.menu-bar.live` amber line; the MCP chip is
  a bot glyph + count; the "Scene — Three Engine" title text is gone.
  Stage 2b (custom title bar) NOT done.
- **Stage 3** — the viewport toolbar keeps only the blockout tool and one
  glass `.viewport-hud-cluster` (move / rotate / scale / layers); the
  "Playing" badge is gone (the bar says it).
- **Stage 4** — hierarchy toggles on hover / selection / off-state (CSS);
  the scene row sentence case. Row height untouched (26 px, see the trap).
- **Stage 5** — `EntityToggle` (four glyph flags) in both the single and the
  multi-selection header; the uniform-scale lock before the fields
  (`.field-mod`) in both `ScaleRow` and `MultiTransformSection`; the prefab
  section is one accent row (glyph · name · variant chip · override count ·
  open / reveal / apply / revert / variant / unpack glyphs); section actions
  and script-slot actions on hover; "Add component" / "Add script" sentence
  case; the New-script button is a glyph.
- **Stage 6** — the Assets filter bar merged into the toolbar row.
- **Stage 7** — `settingsUi.Note` renders nothing unless `danger` (then a
  glyph with the text as tooltip); the quick search footer hints removed;
  the 32 other panels swept for explainers / text verbs / counts by four
  delegated passes (see git diff); then by hand: the MCP callouts are
  glyphs with tooltips and its verbs are glyphs, the Modules panel stacks
  list over detail in its 320 px column (the detail used to wrap one word
  per line) and drops the description, the asset inspector's action list is
  one glyph row and its `.asset-hint` explainers are hidden unless they
  report an error or a warning.
- **Stage 2b** — done after all: `src-tauri/tauri.windows.conf.json` sets
  `decorations: false` on Windows only (the platform file must repeat the
  whole window object — JSON Merge Patch replaces arrays); the capability
  file gains the six `core:window:*` permissions the bar needs; the menu bar
  is the drag region (`data-tauri-drag-region`, double-click maximises), it
  starts with the app mark (`public/app-icon.png`) and ends with
  `WindowControls.jsx` (renders only when `isDecorated()` is false, so the
  browser harness and macOS keep their chrome). Changing the Tauri config
  restarts the dev app.
- **Previews (user, 09-08: "there should be normal, large previews so we
  could actually see those")** — `src/editor/assetThumbs.js` is the one
  offscreen WebGPU renderer for every preview: `.geom` (the old
  geometryThumb, now a shim), `.mat` on a lit sphere built from the live
  material's standard slots (colour, roughness, metalness and the maps the
  stock-PBR path fills; graph-only materials fall back to the colour walk —
  the live instance is never rendered there, it carries the GI nodes),
  `.hdr`/`.exr` as a tone-mapped 2:1 strip, images as themselves.
  `components/AssetThumb.jsx` (`useAssetThumb`, `AssetThumb`, `AssetPeek`,
  `MaterialPreview`, `EquirectPreview`) is what every surface uses: the
  Assets grid material tiles are the rendered sphere; `AssetField` rows show
  40 px thumbs and a 252 px hover peek beside the row or the current value,
  and its `thumbSize="large"` mode (the Mesh material slots) shows a 44 px
  value thumb; the asset inspector opens a `.mat` with the sphere and an HDRI
  with the strip; Scene Settings shows the sky strip under the Sky field.
  Caches invalidate on asset writes, on `subscribeMaterial` edits, and every
  material when any texture changes.
- **Component sections** — module-contributed fields (`Rapier physics`,
  `Global illumination` under Mesh) now render LAST, after the component's
  own fields, its material slots, its editors and Apply transform (user:
  "module related settings should be at the bottom").
- **Hierarchy** — rows are 24 px (`ROW_PITCH` 26 with the margins).
- **Window menu** — items carry the panel glyphs from the catalog.
- **Robustness** — `PanelErrorBoundary` in `EditorShell.jsx` wraps every dock
  panel and the menu bar: a panel that throws while rendering shows its error
  where the panel was (message in the panel, stack in the tooltip, a retry
  glyph) instead of React unmounting the whole root into a black window —
  which is exactly what happened once during the sweep, with nothing to read.

---

## 4b. The look is generic, and why (user, 2026-09-08)

The user found Renzora (a Bevy editor, alpha 7) and it looks like ours: dark
near-black panels, one accent, Lucide line icons, a dock grid with icon
tabs. It is not a coincidence. That combination is the modal "modern tool
UI" — it is what Godot looks like, what Renzora looks like, and what a model
produces by default when asked for a modern editor. Two of the choices here
went there deliberately (the dock, the glass HUD, because they are the
editor's own language) and two of ours together kept it there (today's
neutrals, the system font). Changing the accent a third time would not move
it; the SURFACE WORLD and the MATERIALS have to change.

Two directions are in the mockup beside the current one (the pill above the
screens pill switches them; every screen re-renders in each):

- **Bone** — a light workshop. No game editor is light. Warm bone panels
  (`#EEEBE5`), ink type, an ink-blue accent, a dark charcoal *spine* of a
  bar holding the page, and the picture sitting in a thin dark frame like a
  print in a mat. Everything built so far keeps its structure; it is a
  token flip plus a contrast pass over the hard-coded white fills in
  `theme.css` (about 200 `rgba(255,255,255,…)` values).
- **Darkroom** — black, square, readouts. Not grey: `#000`. No radius
  anywhere, controls outlined rather than filled, the active tab and the
  selected row *inverted* (ink on white), every number a mono readout, one
  hazard colour (`#FF5A1F`) spent only on live and selection. The identity
  of a hardware instrument, not of a website. Also mostly tokens (`--r-1`,
  `--r-2` to 0, the inversions, the outlined inputs) plus the mono readouts.

Either can ship in a day on top of theme-v2. A change of icon family
(Lucide is the other half of the resemblance; a rounder or a heavier set,
or duotone) is a separate decision for whichever direction wins.

## 4c. The user's own system: "Aurora" (shipped 2026-09-08)

The user prototyped the editor they want (five generated mock screens of an
"Aurora Engine") and rejected both directions above in favour of it. Read off
the images and sampled from their pixels:

| token | value | where it shows |
| --- | --- | --- |
| ground | `#0a0e10` | the bar, the gutters |
| panel | `#0f1618` | every group |
| raised | `#151b1e` | tab strips, toolbars, buttons |
| inset | `#0b1113` | every field |
| border | `rgba(140,190,175,.14)` | every group, field and button, 1 px |
| text / dim | `#e6eeeb` / `#8b9a97` | values / labels |
| accent | `#4fd68f` (green) | the active tab's text and 2 px underline, the selected row's tint and outline, checkboxes, sliders, Play |
| live / warn | `#e8a33b` | the game running, warnings |
| info / danger | `#4c8dff` / `#ff5c5c` | status words |

Structure the prototype adds to what was already built: panel names are
TEXT tabs again (the glyph is hidden; label + underline), groups are
bordered cards with a 6 px gap (Dockview `gap`), fields are inset and
bordered, every checkbox is a green square with a dark check, the bar carries
a spaced wordmark, the centre holds a green **Play** pill *with its word*
beside the scene switcher (lists the project's `.scene` files), the right
holds a save-state line ("All changes saved" / "Unsaved changes"), a global
search field that opens the quick search, the git and assistant chips, a
settings gear and the window controls. The entity header shows a component
line under the name. Hierarchy row toggles are visible (dim) as in the
prototype.

All of it is `src/editor/theme-v3.css` (theme-v2 is gone) plus the bar
changes in `MenuBar.jsx`; the accent default is green in `accent.js` and the
picker still changes it per project.

### Since then (09-08, later)

- **Bounded numbers are sliders.** `fields/NumberField.jsx` renders
  `.number-field.slider` whenever both `min` and `max` are finite: the value
  is a fill from the left with an accent hairline at its edge and the figure
  at the right; a drag sets the value by pointer position (Shift = fine, by
  delta), a click types. Integer steps snap; other steps quantise to a
  range/500 grid so the drag feels continuous. The Scene and Project
  settings, Sound and Terrain numeric inputs delegate to it when bounded.
- **Tabs:** inactive tabs are glyphs again, the active tab is glyph + name
  with the green underline (the user preferred the earlier glyph tabs to a
  word per panel).
- **The bar collapses** its save-state sentence below 1640 px and the search
  field's placeholder below 1440 px so the centre cluster never overlaps.
- **Alignment pass.** The entity header's flag buttons align to the name
  field (not to the name + kind block); a row modifier such as the uniform
  scale lock lives inside the label column, so every vector row's fields
  share one left edge; the hierarchy speaks in the prototype's voice —
  monochrome dim glyphs, white names, the accent only on the selected row's
  glyph, chevron and outline.
- **Assets grid:** the large view is the default (a new preference key, so
  every user lands on it once); a tile is a bordered square holding the
  preview or the type glyph with the name under it, and the selected tile
  gets the green outline — the prototype's content browser.
- ⚠ **Why nothing hot-reloads:** a `.no-hmr` sentinel in the repo root puts
  Vite in quiet mode (no HMR push at all, by design for parallel sessions).
  Every change to the editor needs a save and a reload; remove the sentinel
  and restart Vite to get hot reload back.
- **The `+` hung from the strip's top** (user: "the plus icon is misaligned
  everywhere"). dockview-react mounts a header action inside a
  `.dv-react-part` div with inline `height: 100%` and block display, so
  the 24 px button sat at the top of the 33 px strip. The wrapper is now a
  centring flex box; the overflow chip (⌄ N) takes the same 24 px footprint,
  and its dropdown is a menu — glyph + name per row, the active row in soft
  accent — instead of dockview's bare list of folded glyph tabs.
- **Tabs never change width on hover.** The hover reveal used to slide the
  name open in place; Dockview folds tabs into its chip whenever the strip
  overflows, so a hover in a narrow group reshuffled the strip under the
  pointer, and the mid-transition width was what it measured ("Scene Setti"
  clipped at the chip). Now an inactive tab's name floats under it
  (`.tab-tip`, a portal from `PanelTab.jsx`), the active tab's name ends
  in an ellipsis at 120 px, and the close × keeps its 16 px on the active
  tab and fades in on hover. ⚠ Dockview styles `.dv-default-tab-action` at
  three classes deep (padding 4 px, display flex): a bare-class
  `display: none` lost to it and every inactive tab carried an invisible
  close button (user: "spacing is wrong") — the fix is a four-class selector.
- **The Assets list sorts by its columns** (user, 09-08): a header cell click
  sorts by Name / Type / Size / Modified, again to flip; folders first, name
  breaks ties, numeric + case-insensitive names, dates start newest-first;
  kept in `engine.assets.sort.v1` and shared with the tile views.
  `assetSort.js` is pure, `tests/asset-sort.test.mjs` covers it.
- **Folders show their size** (user, 09-08): the sum of everything under
  them, from one native `list_dir_recursive` walk of the open folder
  (`folderSizes.js`, cached per folder, invalidated by the store's change
  counter), taken only while the list view is up or the order is by size;
  size sorting uses the same totals. `tests/folder-sizes.test.mjs`.
- **A settings panel in a narrow column** (user: "our project looks awful",
  Project Settings at 260 px). Dockview does not hide the tabs its overflow
  chip lists — it clips them and expects the strip to scroll — and its own
  scroll-on-activate runs before the tab's name has laid out, so the active
  tab showed as "Pr" beside the chip. `PanelTab.jsx` now scrolls its tab
  into view after layout (and on strip resize). ⚠ It keys on
  `api.isVisible` / `onDidVisibilityChange` — the panel its group shows,
  which is what the underline tracks; `api.isActive` is the shown panel of
  the FOCUSED group and was false for every other group's tab. The label
  column of a settings row is now a share of the row (`clamp(72px, 36%,
  140px)`), and below 300 px (a container query on `.settings-body`) a row
  stacks its label above a full-width field, a lone checkbox staying beside
  its label. A disabled toolbar button is flat (border, faint text) rather
  than a dimmed filled box; the collision matrix is 12 px squares at 18 px.
- **The old blue accent is gone from the legacy sheet**: 26 rules still
  carried `rgba(10,132,255,…)` / `#0a84ff` (selection borders, reveal glows,
  the hub's gradient and primary action, input rebind, atlas nine-slice,
  badges) — now the accent tokens by alpha (≤.25 soft, <.8 ring, else solid)
  with `--on-accent` text on solid fills. Canvas drawing (curve editor,
  atlas editor) and the Monaco theme read the live accent through
  `currentAccent()` / `accentAlpha()` in `accent.js`. The quick-search
  "entity" chip keeps its own blue: a category colour, not the accent.
- **The legacy sheet speaks the token vocabulary now**: 17 rules that put
  white text on the accent fill use `--on-accent` (dark on the green); the
  old blue-grey neutrals (`#9aa3b2`, `#7c828e`, `#0d0e11`, `#151619`…) are
  `--text-dim` / `--text-faint` / `--bg-0` / `--bg-1` / `--bg-2`; every
  7–10 px radius is `--r-card` (pills at 999 px stay). 92 rewrites, no
  selector touched; `smoke:inspector-collapse` 19/19 and
  `test:editor-prefs` 36/36 after the reload.

### 09-08, afternoon (user: previews everywhere, no text boxes for references)

- **An asset field is a CARD** for anything chosen by its look (geometry,
  material, texture, panorama, scene, model, prefab): the preview is most
  of it (4:3, 2:1 for a panorama, a 6 % margin so a sphere never touches the
  edge), the name and the caret under it. Its picker is the **asset
  browser** (`fields/AssetBrowser.jsx`): a grid of preview tiles of every
  project asset of the wanted types, search on top, "none" first — the
  dropdown list is gone. Non-visual kinds keep a row (glyph, name, caret);
  `descriptor.compact` forces a row. `assetIcons.js` holds the one glyph
  map the grid, the browser and the cards share.
- **Scenes have pictures.** `sceneThumbs.js` captures the viewport at save
  (320×200, throttled 20 s per scene) into `Library/thumbs/scenes/`, and
  `thumbKind("x.scene") === "scene"` reads it back wherever an AssetThumb
  is shown — the Assets grid, a scene card, the Main scene setting (now a
  scene card, never a text box).
- **Entity references** (`fields/EntityField.jsx`): glyph, name, caret; a
  Hierarchy row DROPS on it (`entityDrag.js`, the Hierarchy's pointer drag
  reports its end outside the tree), and a click opens a searchable browser
  of the entities the descriptor admits. The native <select> is gone.
- **Thumbnail framing**: `.geom` bounds are always recomputed (a piece cut
  from a model carried the model's bounds and sat in a corner); the material
  sphere takes three quarters of its frame.
- ⚠ **The folder-size walk was the "one second to open a folder"**: a sync
  Tauri command runs on the MAIN thread, so the recursive listing of the
  root (a `.git` of thousands of objects) queued the clicked folder's
  `list_dir` behind it. Now `dir_sizes` (one number per folder, async pool)
  and `list_dir` / `list_dir_recursive` are `#[tauri::command(async)]`.
- **Numbers read from the left** everywhere, slider or not (user: never to the right).
- **The sky showed twice** in Scene Settings once its field became a card;
  the hero preview under it is gone.

### 09-08, afternoon — ONE enabled flag (user)

- The Hierarchy row has ONE eye: `entity.enabled` (both modes; off, its
  components and its subtree's are detached). The inspector's entity header
  has Power (enabled) and Eye (`visibleInEditor`, the editing aid: hidden
  in the viewport while authoring, still enabled, shown in play). Scenes
  serialise `enabled` + `visibleInEditor`; older `enabledInGame` /
  `enabledInEditor` load as those, and the old names stay as accessors and
  deprecated setters (`setEnabledInGame` → `setEnabled`, `setEnabledInEditor`
  → `setVisibleInEditor`). Queries: `?enabled`, `?visibleInEditor`
  (`?enabledInGame` still reads enabled).
- **Components**: the eye is `enabled` (both modes). A component with no
  onDisable/onEnable of its own now STOPS BY DETACHING (`stopsByDetaching`):
  disabled = torn down, enabled = built again from its props; before, such a
  component kept rendering and ticking with its eye off. The Scripts
  component gates every slot on its own `enabled` (nothing ticks). New per-
  component **`editorEnabled`** (pencil-ruler in the section header, orange
  when paused): off, the component does nothing while the editor is stopped
  and resumes on play; `Engine.setPlaying` re-reads every component.
- Saves record every disabled entity (a detached script cannot opt in), so
  "a disabled entity comes back disabled" holds under the one-flag model.
- Tests: `test:entity-activity` 8/8 (three new), `test:query-lang` 73,
  `test:saves`, `test:scenes`, `test:events`, `test:edit-fanout`,
  `test:editor-prefs` 36 — all green.

### 09-08, later — the hierarchy reference, the performance monitor, the graph

- **Hierarchy, to the second reference**: one full-width search with the
  add glyph at its end (no trash button — Delete and the row menu);
  vertical guide lines, one per ancestor at that ancestor's chevron
  (`.hierarchy-row::before` from a `--depth` the row sets); dim names and
  faint eyes; the selected row's name, glyph and eye in the accent. Prefab
  rows read in a cool blue (`#a4bbdc`); the package glyph is gone and the
  only mark is a small blue dot on a root with overrides (red = asset
  missing) that still opens the prefab.
- **The performance monitor** replaces the FPS box: `perfMonitor.js` (a
  10 Hz sampler over `engine.stats`, a minute of history per series, one
  zustand store), `PerfChart.jsx` (canvas, budget-multiple grid rows),
  `PerformanceMonitor.jsx` in three sizes — the fps pill, medium (fps,
  frame time, a small three-line chart), full (CPU / GPU / Memory tabs, a
  5/15/60 s window, pause, legend, chart, the frame tiles with the budget
  bar, memory and renderer counts). The viewport HUD keeps its size in
  localStorage; the same component is the new **Performance** panel (Tools).
  CPU (Game) is work minus the render encode, CPU (Render) the encode, GPU
  the timestamp query (labelled "submit" when the adapter has none).
- **Shader graph, to the reference**: a node is a dark card with a header
  band in its category's colour (teal textures, green values and maths,
  violet vectors, red surface/output); the category dot is gone; ports are
  filled dots on the card's edge; wires are 2 px in the colour of the socket
  they leave (`colourEdges` in `GraphEditor.jsx`); the grid is the
  prototype's dots.
- **MCP panel**: the provider is one row — the select, then its disclosure
  and permission flags and the test button — instead of three glyphs stacked
  down the panel.
- **Viewport**: the level tool button and the "WebGPU" badge are gone from
  the toolbar (the Level panel and the console carry them).
- **Texture nodes carry their picture**: with the shader preview (the eye) off, a
  node with an asset param shows that asset thumbnail beside its port stack
  (`AssetPicture` in `GraphNode.jsx`), so the graph reads like the reference
  the moment it opens; its asset field is a compact row inside the node. Wire
  colouring is memoized per graph change. The fps pill is the gizmo cluster
  height and its text is one 34 px line, so it sits centred and on the line.
- **The profiler's Breakdown tab** (user: "which systems, components,
  scripts contribute and how much"). Engine side: `Engine._registrant` is
  the component being attached (`Entity.#attachComponent`) or the module
  being set up (`modules.js`); `onUpdate` / `onLateUpdate` /
  `onPreRender` / `onPostRender` stamp it on the callback as `__owner`.
  A phase capture armed with `{ attribute: true }` times every callback in
  the four loops (`StatsSystem.attribute`) and every script hook call
  (`ScriptComponent.#safeCall` → `attributeScript`); `readPhaseCapture`
  returns `owners` — component (label · entity), module, script (with
  per-hook ms), or "engine · stage" for an unowned callback — as means per
  frame. Disarmed, the loops are the bare loops. `profile.cpuFrame` gained
  `attribute` (default true) so an agent gets the same answer. Editor side:
  `watchBreakdown` re-arms 30-frame captures while the tab shows (a rolling
  half-second mean); `measureMemoryBreakdown` walks each entity's own
  objects for geometry bytes per entity and bytes per texture (once each)
  every 2 s while the Memory tab shows. First live capture on Sponza: GI
  module 3.2 ms, three Cloth components 0.1–0.3 ms each by entity, Animation
  0.09 ms; a frozen (unfocused) viewport yields 0 frames — the op says so.
  `tests/stats-attribution.test.mjs`.
### 09-08, evening — FLAT: one space (user)

"Too many borders and lines which i feel bloat the look… remove all the
borders where possible and eliminate the spacing between docks so it feels
more like one space."

- **The dock is one surface.** `gap: 6` → `gap: 1` on the Dockview theme,
  `.dock-container` padding to 0, `.dv-groupview` border and radius to 0.
  The 1 px gap shows the ground (`--bg-0`) through as a single dark crease
  between panels — which is also the sash you drag — in place of two
  borders, a 6 px gutter and eight rounded corners per pair. The tab strip
  takes the panel's own background (was `--bg-2`) and loses its bottom
  rule; the active tab's accent underline is the only mark it needs.
- **THE RULE the sheet now follows**: a boundary is drawn by FILL, not by a
  line. The palette already carries the depths — a field is the dark inset
  (deepened to `#070d0f`), a button is the raised `--bg-2`, a panel is
  `--bg-1`, a rail is `--bg-0` — so every hairline that only repeated what
  the fill already said is gone: panel toolbars, the assets toolbar and
  filter bar, the entity header, the prefab section, list/tab rails, and
  the sidebars (the assets and animator rails are recessed to `--bg-0`
  instead of fenced with a border-right).
- **A control's border appears on hover or focus** — the one moment its
  exact edge matters — and is set TRANSPARENT rather than removed, so
  nothing shifts by a pixel when it comes back.
- **What still draws a line, on purpose**: the dock seam, the active tab's
  underline, a floating surface's edge (menus, popovers, the viewport
  overlays — they sit on something else and must end somewhere), every
  checkbox (an outline-less empty box is not a control), a shader node's
  category band, and two structural dividers at a new `--hairline`
  (rgba .07): between components in the inspector, and under a list's
  column headers.
- ⚠ Two cards were drawn ONLY by their border (`.mcp-client`,
  `.asset-preview`) and needed a fill once it went. An audit script over
  both sheets — "which flattened selector declares no background?" — is
  how they were found rather than by eye.
- Verified live: `test:editor-prefs` 39, `smoke:inspector-collapse` 19/19
  (it reads computed styles, so it is the guard on this kind of change),
  0 console errors.
### 09-08, evening — off lucide, onto filled icons (user)

"I'd like to use a different icon lib, not lucide, because it is everywhere
already… I want filled icons, not hollow."

- **Phosphor at `fill` weight**, chosen because it is the only broad set
  where all 1,512 icons have a true filled form — the editor needed 222
  distinct ones, so a set with fills for only part of its catalogue would
  have left holes. `@phosphor-icons/react`, MIT; `lucide-react` removed.
- **`src/editor/icons/index.jsx` is now the whole set**, in one file. The
  editor used to import from lucide in 82 files, so its icon set was 82
  decisions; each file now imports from the barrel and the set is a single
  edit. That is what made this swap one file plus a mechanical path rewrite
  rather than a sweep — and it is why the next one will be cheaper still.
- **The names did not change.** The barrel exports the editor's own words
  for things (`Search`, `Save`, `Zap`), so every call site reads as it
  did; only the drawing behind it moved. A name here is the editor's term
  for a concept, not a claim about which library draws it — `Search` is
  Phosphor's MagnifyingGlass, `Save` its FloppyDisk.
- **Two lucide props are swallowed** rather than forwarded: `strokeWidth`
  and `absoluteStrokeWidth` mean nothing to a filled icon, and React would
  otherwise pass the second to the DOM and warn.
- **Six icons keep `bold` instead of `fill`**: a spinner, the dashed
  outlines and the ring-with-a-dot carry their meaning in a GAP, and filled
  they close into a disc or a solid block. Window controls pass
  `weight="bold"` at the call site for the same reason — every OS draws
  window chrome thin, and filled they read as three solid buttons.
- **Verification was a script, not the eye**: every mapped Phosphor name
  checked against the package's own export list (2 of 222 were wrong and
  were caught before the first render), then every one of the 755 icon
  imports across the editor checked to resolve against the barrel, with
  its relative path recomputed and compared. `test:editor-prefs` 39,
  `test:entity-activity` + `test:stats-attribution` 11, no console
  warnings.

### 09-08, evening — a single-tone palette, and what carries structure then

The user flattened every surface token to `#111` (bg-0 through bg-3, inset,
both fills, both borders) and reported that settings panels "look a bit
weird… can we fix it without adding borders?".

- With one tone and no lines, a field cannot be a box, so three other things
  do that work: ONE VALUE COLUMN (dim labels left, bright values all
  starting at the same x — a column reads as a column because it lines up);
  PAIRS GROUPED BY SPACING (the old ≤300 px stacked layout put the same gap
  above a value as below it, so no value clearly belonged to a label — the
  stack now only happens under 200 px and tightens when it does); and
  PRESENCE ON DEMAND (hover lifts a 7% white wash, focus 11%).
- **Every editable field carries the same 4% white wash**, bounded or not.
  Before that a slider had a track and a plain number had nothing, so
  "Near 10" and "Far 80" side by side looked like two different kinds of
  thing. White at low alpha rather than a token, so it survives whatever
  the surface tokens are set to.
- ⚠ **An unchecked checkbox was invisible** — border and fill both `#111` —
  so a row like "Use for lighting" looked like a label with no control. It
  has a fill of its own now. The general lesson, twice over in one day: a
  control drawn ONLY by its border disappears the moment borders go.
- ⚠ **The accent cannot be set in CSS.** `accent.js` writes `--accent` and
  its three derived properties as INLINE custom properties on the root
  element from the project setting `editor.accent`, and an inline property
  beats any `:root` rule — so editing the token in the sheet looks like it
  reverts. The accent is a project setting by design; set it in Project
  Settings → Editor (or `project.setSettings`). Set to `#ffffff` here.
- **Carets are arrows, not wedges** (user): the four Chevron exports and
  TriangleRight are `bold` rather than `fill`. Phosphor draws a Caret as a
  chevron in every stroke weight and as a solid triangle only when filled,
  so bold restores the thin arrow the disclosure controls had — in the
  hierarchy, the inspector sections, the folder tree, every dropdown and
  the sort headers at once, because they all come from the barrel.
- **The preview was not overflowing — its box had gone invisible.** The
  frame was `background: var(--bg-0)` plus a 1 px border; with every
  surface token at #111 and the border transparent, the frame became the
  same colour as the panel behind it, so the sphere had nothing to be
  centred IN and read as a picture floating past its edge. The box is a
  4% white WASH now, the same one the fields use. The picture is centred
  the bulletproof way: never sized to 100% of anything, capped with
  `max-width` / `max-height` at its own aspect, and centred by a flex
  box. `width: 100%` + `object-fit` only holds while nothing else touches
  the height — a `max-height` or an `aspect-ratio` on the same element
  quietly changes what the fit is fitting into, which is what these had.
- **Scale's fields match Position's and Rotation's** (user): the
  uniform-scale lock was a flex item between the label and the vector, so
  it took 14 px out of that one row and pushed its three fields right. It
  is absolutely positioned in the label's own column now, out of the flow.
### 09-08, night — ambient glow (user: YouTube's trick, without the cost)

The viewport's light spills under the panels around it, the way YouTube's
video tints the page. `ambientGlow.js` takes the sample, 
`components/AmbientGlow.jsx` paints it, and the Visibility menu owns the
toggle (`ambient`, on in edit mode, off in play like every other aid).

THE COST IS THE DESIGN, so each decision is one that removes work:

- **A 32 px sample, two and a half times a second.** The picture the glow
  needs has 576 pixels in it.
- **A second render, not a read of the one on screen.** A WebGPU swapchain
  texture is not readable after presenting, and the copy that IS possible
  (`readLiveCanvasImage`) takes the whole canvas — about 17 MB a frame at
  this window size, which is exactly the cost this feature must not have.
- ⚠ **Shadow maps are switched off for the sample.** `renderer.render`
  re-renders every shadow map it thinks is dirty; that is the one thing
  here that could cost real milliseconds, and a 32 px thumbnail has no use
  for a shadow atlas. The editor's own layers go too: a green grid would
  tint the whole editor green.
- **Blur before scale, not after.** The canvas is left SMALL in layout
  (220 px) and blurred there, and only the RESULT is scaled up over the
  viewport — a filter applies to an element's own box and the transform
  happens afterwards. Blurring at the final size is the same effect at a
  hundred times the cost.
- **Nothing happens when nothing changed**: skipped while the window is
  hidden, while the frame loop is frozen (an unfocused viewport draws
  nothing, so the last sample still stands), and when two samples differ
  by less than 3/255 — a still scene must not wake the compositor forever.

For the light to REACH the panels they have to let it through, so the dock
container is clear and a group is 78% opaque. The glow that lands behind
the viewport is hidden by its own canvas, so only the spill past the edges
reads — which is why the spread is 2.1× the viewport rather than a little
margin.

⚠ **What hid it at first**: Dockview paints that background variable on
BOTH the group AND the whole `.dv-dockview` container, so making the groups
translucent changed nothing — an opaque sheet the size of the dock still sat
over the light. A flat magenta test fill settled it in one reload: nothing
appeared anywhere, and a layer that shows NO colour is covered rather than
subtle. The sampler also reports its first failure now, because a silent
catch on a timer makes a broken feature look exactly like a faint one.

Measured live on Sponza with it running: 118–120 fps, CPU 2.88 ms, GPU 2.05 ms.
⚠ **Four opaque layers, found one at a time.** The glow was invisible, then
visible only in the 1 px seams. In order: my own `contain: paint` on a
zero-size anchor clipped the canvas away entirely; Dockview paints its
background variable on the whole `.dv-dockview` container as well as each
group; every panel (`.hierarchy-panel`, `.inspector-panel`, …) fills with
`--bg-1` itself; and the content wrapper between them can too. Each fix
only revealed the next one, and 78% → 72% → 62% translucency was chasing
the wrong variable — the user cut it short with "just make the dockviews
not #111 but fully transparent". The dock now paints NOTHING: the window's
own `--bg-0` is what you see where the light is dim. Panel CONTENT still
paints above the glow, and anything that floats keeps its own surface.

**How it was diagnosed, rather than guessed**: a flat magenta fill (does
the layer show AT ALL?), then screen-pixel means from a probe script
instead of judging compressed screenshots by eye. The means are what
proved each "fix" had changed nothing: 13.40 grey → 17.83 grey → 23.56
grey, all neutral, until the dock went clear and it read 77/71/62 — warm,
which is the sunlit floor.

**It samples when the picture can have changed, not on a clock.** A timer
at 2.5 Hz looked like lag: the light arrived in steps behind the camera.
It now samples every frame the readback can keep up with WHILE THE CAMERA
MOVES, on a half-second heartbeat otherwise (for cloth, animation, a light
turning), and not at all while hidden or frozen. Each sample is eased 50%
into the one on screen, so the colour is still travelling between samples
and the motion reads as continuous.

Measured with `profile.orbit`, which moves the camera every frame — the
worst case for this feature: **119.2 fps over 715 frames**, CPU 2.24 ms,
GPU 1.57 ms. A still camera over a still scene costs one sample every half
second.

**The halo is a RECTANGLE and 50 px wide.** Two faults arrived together
once the light was finally visible. It was cut off in a straight line
across the bottom of the screen: a `radial-gradient` mask is sized to the
farthest CORNER unless told otherwise, so its transparent stop landed
outside the element and the mask still had alpha where the box ended. And
it glowed from the middle of each edge but died at the corners, because a
radial mask is an ELLIPSE inscribed in the box — which is not how a screen
spills onto the wall behind it.

Both are gone with one change of shape: a linear fade per axis, one on the
box and one on the canvas inside it (two elements rather than
`mask-composite`, which needs a newer engine than anything else in this
sheet). A linear fade that reaches `transparent` at 100% cannot leave alpha
at the edge, and per-axis fades keep the halo rectangular. The fade band is
exactly the spread, expressed per axis as a share of a box that is
stretched by a different factor in each.

**Three settings, in Project Settings → Viewport.** On/off is
`editor.layers.ambient` — the SAME value the viewport's Visibility menu
writes, so the two surfaces cannot disagree. Spread (px past the viewport's
edges) and Intensity (0..1) are new, and they apply AS THEY CHANGE the way
the accent colour does, through `ambientGlowLook.js`: a light you cannot
watch move is a light you cannot tune. Save is what keeps them.
Measured after: just below the viewport 38.98/38.68/36.92, 120 px below
17/17/17, screen bottom 17/17/17 — contained, with no edge to see.

⚠ **The gizmos flickered, and it was the `finally`.** The sampler borrows
the live viewport's camera, turns off its editor layer so the grid does not
tint the whole editor green, and put the restore in the `finally` of an
`async` function — which runs after the first `await`. The readback's await
lasts at least a frame, so the viewport drew ITS frames with the editor
layer still off, and once the glow began sampling every frame during an
orbit that was every frame of the orbit. The masked render is its own
synchronous function now (`renderSample`), and everything borrowed is given
back before it returns. General rule: state shared with a live render loop
must be restored in the same synchronous turn it was taken, never in an
async `finally`.

### 09-09 — three controls that did not close their own loop

⚠ **The ambient glow could not be switched off.** Written as a draft edit
like the two rows below it, the toggle did nothing at all until Save — and a
switch that does nothing when you click it is a broken switch, whatever it
does afterwards. Worse, the panel's Save wrote its whole draft back, and
that draft held a snapshot of `editor.layers` taken when the panel MOUNTED:
saving anything at all silently undid every Visibility-menu change made
since, switching the glow back on behind the user. The switch is live now
(it calls `setLayerVisible`, exactly what the Visibility menu calls, and
persists the same way), and Save merges the LIVE layers over the draft
rather than the stale ones. Proven by measurement before the fix: with the
layer on, the strip below the viewport reads 32.82/31.67/27.50 — warm; with
it off, 17.93 flat neutral. The path was always fine; the control was not.

⚠ **"I still can't see where the rest of the frame is coming from."** The
breakdown lists only ever added up to the WORK — 10 ms of engine inside a
30 ms frame, with nothing on screen to say what the other 20 were. Two
things were missing. First a group, **Where the frame went**: game, render
and the wait, adding up to the frame. Second, and the real gap, a
MEASUREMENT that could name the wait. `StatsSystem.recordFrameCallback` now
counts frame callbacks at the top of the tick, BEFORE the limiter's gate, so
`callbackFps` says how often the host offered us a frame and `fps` says how
often we drew one. The two answers are then distinguishable and the panel
says which: fewer draws than offers is the editor pacing itself on purpose
(and it names the cap), offers already equal to draws means nothing in the
app is pacing anything and no engine change will move it.

⚠ **A gesture with no inverse.** The profiler HUD becomes the Performance
panel by being dragged onto a tab strip, and the only way home was a toast
that said "Layers ▸ Stats" and then vanished. The inverse now lives on the
panel itself, pinned above the scrolling readings: it puts the HUD back over
the viewport and closes the panel, so the profiler is in exactly one place
either way.

**And then the answer, which was not a performance problem at all.** 70% of
the frame idle, and the caption above confidently blamed the display — 33
callbacks offered, 33 drawn, nothing in the app pacing. It was wrong, and
the way it was wrong is worth keeping: `callbackFps` counts callbacks that
reach the TICK, and a viewport the editor has FROZEN receives none at all,
so a stopped loop and a browser that has stopped asking are the same reading
from inside the engine. The instrument could not see its subject.

A bare `requestAnimationFrame` that increments a counter can, because
nothing in the app can stop it — `watchHostFrameRate()` in perfMonitor.js,
running only while a profiler is on screen. With it, the three cases
separate cleanly and the caption names the real one.

The measurement, on Sponza at identical work:

| viewport freeze | fps | frame | idle |
| --- | --- | --- | --- |
| on, another panel focused | 34 | 30.4 ms | 20.2 ms (70%) |
| off | 65 | 8.5 ms | 1.65 ms (19%) |

Under an orbit — which is a change, so the freeze lifts — 105.7 fps over 634
frames. The idle was power saved, not time lost. `profile.frameStats` now
reports `viewportFreezeWhenUnfocused` beside `idleMs` so the next reader
does not have to rediscover this, and its description says plainly that a
low `callbackFps` means "we were not running", never "the browser was not
asking".

⚠ **AND THE PROFILER WAS CAUSING THE IDLE IT REPORTED.** Naming the freeze
was not the end of it: docked beside the viewport, the Performance panel
OWNS THE FOCUS, so the unfocused-viewport policy paused the very viewport
the panel was reading. Every number it showed was a true measurement of a
paused viewport and said nothing at all about the scene — and no amount of
explaining that in a caption makes the reading useful. An instrument must
not change what it measures.

`holdViewportAwake()` in viewportFreeze.js is the fix, and the Animator
already had the same exemption for the same reason: a state auditioned from
the Animator panel must not be put to sleep by the panel you clicked it in.
The profiler takes a hold while it is showing frame numbers worth trusting,
and drops it at the smallest size — the frame-rate pill is a glance, not a
measurement, and holding for it would cancel the idle saving for as long as
the overlay is switched on. A hold never overrides a viewport HIDDEN behind
another dock tab; nothing is watching then either. Pinned by
`shouldSuspendViewport`'s fourth case in `test:editor-frame-pacing`.

**What was left once the panel stopped causing it.** With the hold in place
`profile.frameAudit` (the MessageChannel heartbeat, which measures busy time
from OUTSIDE the engine and needs no cooperation from it) reads: 122 host
frames in 3 s, 122 engine ticks — the editor now draws EVERY frame it is
offered, which is the proof the hold works. Engine 6.39 ms a frame, other
main-thread work 0.51 ms, thread genuinely parked 71.9%.

So the residual is the offer rate itself: **40.7 frames a second, from the
browser**. Confirmed from outside the app that the editor window was not the
foreground window at the time (`GetForegroundWindow` named another). Windows
refuses to let a background process steal focus, so the last step of that
A/B belongs to whoever is sitting there. Chromium throttles frame callbacks
for a window that is not in front, and the frame audit's own verdict says
the same thing first: "hostFps is low: the browser is not offering frames
(unfocused window, or a frame limiter). Fix that before reading anything
else here."

⚠ The lesson twice over in one afternoon: the FIRST question about a high
idle is not "which engine stage" but "was anyone asking for frames, and was
the thing doing the asking the thing I am staring at".

⚠⚠ **"You write into Idle something you just don't measure."** Correct, and
it was the same fault as the caption that blamed the display: a number
arrived at by SUBTRACTION was given a name that claims it was observed.
`frameMs - workMs` cannot tell waiting from working, so the editor's own
React renders, the browser's style, layout and paint, GC pauses and the
WebGPU submit after the tick all landed in a box labelled "Idle / Wait".

`engine/frameAudit.js` already measured the difference properly and only
`profile.frameAudit` was using it. The panel uses it now. The Breakdown tab's
frame accounting shows three MEASUREMENTS — engine tick, other main-thread
work, thread parked — taken with a MessageChannel heartbeat that can only
run when the thread is free, in 600 ms windows every 4 s, and only while
that tab is open, because a heartbeat keeps the thread hot and must never be
left running. Its rows total to what they actually sum to (one offered
frame's period), rather than to a frame interval with a silent remainder.

The CPU tab's tile keeps the residual, since that is all it has, but it is
called **Unaccounted** now and its tooltip says what is in it. A profiler
may show a residual; it may not call one an observation.

### The frame, itemised, with nothing left over

"We need to measure everything, and now exactly what each frame time
consists of." The audit already named the frame callbacks; two things were
still anonymous and one was double-counted waiting to happen.

**Timers were invisible.** Everything that is not a frame callback arrives as
a task, and in this editor that is overwhelmingly a timer — the perf
sampler, the project watcher's poll, every debounce in the UI. Unwrapped,
they were indistinguishable from browser work, and a 16 ms block with no
name against it is exactly the sort of thing that gets waved at.
`setTimeout` and `setInterval` are wrapped for the window now, and the
instrument uses the UNWRAPPED timer for its own wait so it does not bill
itself.

**Nesting would have billed the same millisecond three times.** The engine's
tick runs inside three's frame callback, which runs inside the browser's
frame task. Adding those durations produces a "frame" twice as long as the
frame. `exclusiveSpanTotals` charges each instant to the DEEPEST span
covering it, so every millisecond has exactly one owner and the totals add
up to the wall clock — which is the only way an accounting can be checked
rather than believed. Six cases in `tests/frame-audit-spans.test.mjs`: three
levels deep, adjacent-not-nested, gaps, repeats, zero-length.

**The residual is now a row with a name, and its own residual is reported.**
Busy time that no instrumented callback covers is the browser's own style,
layout, paint and GC — a real answer, not a leftover. What the whole sum
still misses is `unbilledMs`, shown in the panel whenever it is not
negligible. An accounting that cannot be checked is an assertion.

### ⛔⛔ THE CLOTH WAS FREE ON EVERY INSTRUMENT AND COST TWO THIRDS OF THE FRAME

The user: "that unaccounted time almost completely comes from the cloth
component (i disabled it, and fps is 120 now, and unaccounted is 4ms)."

Every number the editor had said cloth was free. `profile.cpuFrame` charged
each cloth component **0.003 to 0.008 ms**, total CPU 4.37 ms, total GPU
3.48 ms, verdict "bound: cpu" — against a 30 ms frame. The frame audit said
the main thread was genuinely parked 79% of the time, which was TRUE and
useless: the thread was parked waiting for a GPU queue nobody was counting.

**What cloth actually does** (traced, not guessed): it is fully synchronous,
registered through the ordinary component update path, correctly owned, and
does no per-frame readback. Its update builds a substep queue and hands it
to `renderer.compute(queue)` — two to six substeps of about fifty kernels,
and its own source notes **306 compute dispatches per frame** measured at
`gpuComputeMs 30.69` against `gpuRenderMs 2.23`. The main thread's share of
that is the 0.008 ms it took to hand it over.

**So a millisecond count is the wrong half of what a component costs**, and
for anything that hands work to the GPU it is the misleading half. Dispatches
are now charged to whoever issued them: the engine names the callback on the
stack while it runs, `renderer.compute`/`computeAsync` are wrapped to tally
against it, and every component and module row in the profiler carries
"N GPU dispatches/frame" beside its milliseconds. Work dispatched with no
callback on the stack is counted as `dispatchesUnowned` rather than folded
into somebody — an unowned cost that is visible is worth more than a tidy
one that is wrong.

⚠ The general lesson, which cost most of a day across three separate
instruments: **an instrument that only watches the main thread reports that
the main thread is fine.** Idle was a subtraction; then it was a measurement
of a paused viewport; then it was a true measurement of a thread waiting on
work no instrument here could see. Each fix was right and none of them was
the answer until the question became "what is this frame WAITING for".

**Dispatch counts were still not an answer, and the caption was wrong twice.**
Counting dispatches per owner put cloth at the top of a list; it did not put
a number of milliseconds against it, and the frame accounting still ended in
a large row nobody owned. Worse, the paragraph under it confidently blamed
the display's refresh rate for a wait cloth was causing. It is deleted — the
conclusion was wrong and a wall of prose is the wrong shape for a readout.

**`profile.frameCensus` is the instrument that was missing.** Every other
profiler here reads a clock inside the page, and issuing three hundred
dispatches costs almost nothing on any of them: main thread +1.65 ms, GPU
pass time +2.49 ms, frame +26.1 ms. The cost is in the issuing, which
happens where no clock in this page can see it. What CAN be seen is the
frame with the thing and the frame without it. `Engine.muteOwners` skips an
owner's per-frame callbacks — the scene is untouched, nothing is undoable,
and the set is cleared in a `finally` — and the census walks every component
type, module and system in turn.

First run, and it reproduces by measurement what the user found by hand:

| owner | fps without | frame without | cost |
| --- | --- | --- | --- |
| Cloth (10) | 120 | 8.33 ms | **21.08 ms** |
| gi (module) | 34 | 29.41 ms | 0 |
| Scripts, Camera, Animation, Light | 34 | 29.41 ms | 0 |

Baseline 29.41 ms and restored 29.41 ms agree exactly, which is the check
that says the scene did not drift underneath the census.

⛔ **RETRACTION: cloth's GPU work was never invisible to the timestamps.**
I wrote above that the cost "happens where no clock in this page can see
it". That is wrong, and it was wrong on the strength of a single reading —
`gpuComputeMs 2.79` against a 34 ms frame. Measured again with the same
scene actually simulating: **gpuComputeMs 30.29 of a 33.5 ms frame**, GPU
render 0.51, CPU 5.03. The frame is GPU-bound on cloth compute and the
profiler's own GPU tile says so.

Two things made that reading look like blindness, and both are real:

- **Cloth is view-gated.** A culled cloth costs nothing, correctly. Half the
  early readings were taken with the curtains off-camera, so the GPU number
  was small because the work was not happening — not because it was unseen.
- **The GPU number lags, worst when it matters most.**
  `#resolveGpuTimestamps` skips while a readback is in flight, and a 30 ms
  GPU frame means the readback frequently cannot keep up, so the displayed
  figure can be several frames stale during exactly the wave that caused it.

The census is still worth having — it prices things the GPU tile cannot
separate, and it answers "which of these" rather than "how much in total".
But the first question for a big unaccounted number is now the one that was
on screen the whole time: **what does the GPU tile say?** The tile answers it
itself now, reading "waiting on the GPU (30.8 ms)" whenever GPU time is most
of the frame, without anybody having to run anything.

⚠ The method failure is the one this project already has a rule for: I
believed a single reading that agreed with the story I was building, and did
not re-measure it when the scene state changed underneath.

## 5. Decisions so far, and what is still open

Decided 2026-09-07 (user): keep the system font; no explainer text anywhere;
icons wherever possible; the first proposal's shell (one bar, icon tabs,
launcher, flat groups, floating HUD) is liked and stays.

Decided 2026-09-08 (user): the look is the user's own "Aurora" system (§4c),
green accent by default and a per-project accent in Project Settings; bounded
numbers are sliders; inactive tabs are glyphs, the active tab carries its name.

Shipped since: 2b (custom title bar, Windows only — `WindowControls.jsx`,
`tauri.windows.conf.json`); the transport lives in the top bar only, the
viewport HUD keeps the gizmo modes and layers.

Still open:

- **A light theme.** The tokens are in place (`theme-v3.css` §0); nothing
  reads a light set yet.
- **Hierarchy row height** stays 26 px (`HierarchyPanel.jsx`); a 22 px
  density option would be one preference.
- **The geometry editor's text menus** (Blender-style menu bar) keep their
  words on purpose; revisit if they read as noise beside the glyph toolbars.

---

## 6. The consistency audit (every window, captured 2026-09-07)

Every panel was opened and captured (`scratchpad/shots/*.jpg` for the
session; the findings are what matters). The same five faults repeat across
all 40 panels, so the fix is five rules, not forty redesigns:

| fault | where it shows | the rule that removes it |
| --- | --- | --- |
| **Uppercase eyebrows** | every settings section (`GAME`, `ENVIRONMENT`, `TARGET`, `PROVIDER`…), the inspector (`TRANSFORM`, `MESH`, nested `RAPIER PHYSICS`), Assets (`GAME`), Modules categories, the context menu (`APPLY TRANSFORM`), the stats overlay | one section header everywhere: chevron · family glyph · sentence-case title · count chip · hover actions |
| **Explainer paragraphs** | Build (under Target, Ship, Quality, Icon), Modules (top), MCP (a warning callout and a line under it), Project Settings (Screenshot), the material inspector footer, Events ("Project events" essay + code sample), Post Process, Timeline ("Assets → right-click → New Timeline"), Game, AmbientCG / KayKit (module-off states), Texture Editor ("Or double-click any image…") | none survive; the tooltip is the only help |
| **Text buttons for verbs** | Build / Build & Run / Publish; Open / Select / Apply All / Revert All / Create Variant / Unpack (prefab); Test connection / Open terminal / Retry / Rescan (MCP); + Map / Defaults / Save (Input); + Event / Revert / Save / Catalog / Monitor (Events); Free Aspect (Game); Search (libraries); Clear (Console); Import ×N (Fonts); Enable … module | glyph buttons with tooltips; the rare verbs go under a `…` menu; the one primary verb of a panel keeps its word |
| **Two or three chrome rows before content** | Assets (icons row + search row), Input (title row + list header), Events (title row + toolbar), Texture Editor (toolbar + options + selection row), Fonts (search row + preview row) | one panel bar; a second row only for a tool's own options (brush size etc.) |
| **Flat lists where a chip or glyph would do** | "4 bindings", "329 overrides", "18 styles · variable", "VEC2 / BUTTON" badges, "RUNNING", "Loading catalog…", the `.mat` / `.geom` / `.scene` type words | counts and types are chips (`--fill-2`, 10.5 px, 600); status is a dot |

Panel by panel, what changes beyond those five rules:

- **Inspector.** The entity header is the name field plus four glyph toggles
  (editor / game / persistent / view-only). **Modifiers precede values**: the
  uniform-scale lock moves from the far right of the Scale row to the slot
  between the label and the fields — the user's own words: *"it is
  inconvenient that it is on the right, because we always go left to right,
  and never end up using it."* The same rule places any row-level modifier
  (a lock, a link, an "auto" switch) before its fields. Component headers
  carry the editor action as a glyph (pencil = edit geometry; waypoints =
  shader graph) instead of an "Edit Geometry" text row. Module fields nested
  under a component (`Rapier physics`, `Global illumination`) become indented
  sub-groups with their family glyph, not uppercase strips. The prefab
  header becomes one accent row: package glyph · name · `329` chip · open /
  select / apply / revert glyphs · `…` for variant + unpack (six text buttons
  in two rows today). Scripts: one slot per file with hover actions and its
  attributes indented under it; "+ Add script" keeps its word, "New" becomes
  a file-plus glyph.
- **Asset inspector (material, file).** Name field with a type chip and the
  asset's own verbs as glyphs (shader graph, reveal); the path as a single
  faint line; sections as in the entity inspector; no footer sentence. The
  file inspector's "Actions" list (Show in Explorer / Copy path / Duplicate /
  Open in IDE / Delete, each with a sub-line) becomes the same glyph row.
- **Scene / Project settings, Build, Modules, MCP.** One composition: panel
  bar (search + save glyph, or the panel's verbs as glyphs), then sections.
  Build's three verbs are glyphs in the bar, the first one primary; the scene
  list keeps its switches. Modules: the detail pane that was squeezed into a
  90 px column (wrapping "Virtual Geometry" one word per line) becomes an
  inline expansion under the selected row. MCP: a status row (dot ·
  Connected · counts), a provider select, and four glyph verbs; the warning
  callout collapses into an amber glyph with a tooltip.
- **Input, Events.** Panel bar with glyph verbs; the left list rows carry a
  switch, a name and a count chip; action rows carry a type chip and a
  bindings chip; the device strip at the bottom becomes glyph tabs.
- **Editors (Texture, Geometry, Audio, Shader graph, Particles, VFX,
  Animator, Timeline, Post process, Event graph).** One document bar: file
  verbs · undo/redo · the tool's own glyph groups · spacer · a status chip
  (canvas size, vertex count). The Texture Editor's text menus (Image / Layer
  / Adjust / Filter / Channels) and its `All / None / Invert` become glyphs;
  its tool rail stays. The Geometry Editor's `Edit / Sculpt / Paint`
  segmented control stays (three short modes) and its `Select / Add /
  Transform` text menus become glyph menus. Empty states: one glyph, one
  action.
- **Libraries (Poly Haven, AmbientCG, Sketchfab, Poly Pizza, KayKit, Fab,
  itch.io, Audio library, Fonts).** One composition: a bar with a segmented
  glyph source/category control, a search, a filter select and a sort glyph;
  a tile grid with a licence chip in the thumbnail corner and one name line.
  The module-off state is the glyph and one "Enable" button. Fonts: the
  specimen rows keep the specimen (that *is* the content) but the meta line
  becomes chips and the Import buttons become a hover glyph.
- **Console, Terminal.** Console: severity filter chips with counts, a
  filter field, a clear glyph; each line is time · severity glyph · message,
  with the colour on the glyph and the message, not on a stripe. Terminal:
  the session picker stays segmented (three short names), `RUNNING` becomes a
  dot on the active session.
- **Menus.** One item part everywhere: glyph · label · shortcut, accent fill
  on hover; group titles sentence case with a glyph; the quick search loses
  its "Navigate / Open / Close" footer.
- **Game.** The `Free Aspect` text button becomes an aspect glyph menu; the
  empty stage is the play glyph alone.

---

## 7. The component vocabulary

Everything above is built from these parts and nothing else. A panel that
needs a part not on this list is a design question, not a CSS one.

| part | spec |
| --- | --- |
| **Tab strip** | 30 px; tab = glyph (+ label when active or hovered) on `--bg-2` when active; close on hover; `+` launcher at the end |
| **Panel bar** | 28 px, `gap 4`, `padding 3 6 5`; glyph buttons 24 px; the search field flexes; `.psep` 1 px separators between groups |
| **Glyph button** | 24 px, radius 5; ghost (transparent) by default, filled (`--fill-1`) for the panel's main verbs, `--accent` for the one primary; `on` state = accent glyph on `--accent-soft` |
| **Word button** | 24 px, glyph + word, `--fill-1`; only for a primary verb that a glyph cannot carry alone |
| **Segmented** | 2 px inset on `--fill-1`; 20 px items; active = `--bg-3` |
| **Search field** | 24 px, `--fill-1`, magnifier glyph, placeholder is the noun ("Search assets") |
| **Section** | header 30 px: chevron · glyph · title (600) · count chip · hover actions; body indented 0; folded hides the body; nested `sub` groups are indented 8 px behind a 2 px `--fill-2` rule |
| **Field row** | `min-height 24`, label 88 px `--text-dim`, then the modifier slot (22 px glyph, optional), then the value; a unit sits inside the field in `--text-faint` |
| **Vector row** | three fields with a coloured X / Y / Z prefix |
| **Switch** | 28 × 16, `--accent` when on |
| **List row** | 24–26 px, radius 5, hover `--fill-1`, selected `--accent-soft`; leading glyph in its family colour; trailing hover actions |
| **Tile** | asset tile 98 px (glyph + name), library tile 128 px (thumbnail + licence chip + name) |
| **Chip** | 16 px, `--fill-2`, 10.5 px 600; accent variant for the selection tally / override count |
| **Badge** | 15 px, `--danger`, white 10 px 600, on the console tab only |
| **Glass HUD** | `rgba(13,14,17,.76)` + blur 14, 1 px `rgba(255,255,255,.08)` border, radius 8; viewport only |
| **Menu** | 232 px, blur, radius 8; item = glyph · label · shortcut, 26 px, accent on hover; separator 1 px; group title 11 px 600 `--text-dim` |
| **Popover / launcher** | `--bg-2`, radius 8, 1 px hairline, 16/40 shadow |
| **Empty state** | one 28 px glyph in `--text-faint`, then at most one button row |
| **Log line** | time `--text-faint` · severity glyph · message; mono 11.5 px |

Colour families for glyphs (unchanged from `componentIcons.js`): rendering
blue, lighting amber, physics green, logic/scripts violet-purple, audio pink,
UI teal, AI / navigation orange, effects light blue.
