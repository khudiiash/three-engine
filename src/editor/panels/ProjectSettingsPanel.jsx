import { useEffect, useMemo, useState } from "react";
import { Save, X, RotateCcw, Crosshair, ChevronRight, FolderOpen } from "../icons/index.jsx";
import { AssetField } from "../fields/AssetField.jsx";
import { Row, Toggle, Note, Section } from "./settingsUi.jsx";
import { useProjectStore, basename } from "../store/projectStore.js";
import { getProjectSettings, saveProjectSettings } from "../projectSettings.js";
import { applyAccent, DEFAULT_ACCENT } from "../accent.js";
import { NumberField } from "../fields/NumberField.jsx";
import { currentScenePath } from "../sceneIO.js";
import { KEY_BINDING_ACTIONS, describeBinding, keyTokenFromEvent } from "../keybindings.js";
import { KEY_CATALOG, chordsOf, formatChord } from "../keyCatalog.js";
import { AMBIENT_GLOW_DEFAULTS, setAmbientGlowLook } from "../ambientGlowLook.js";
import { setLayerVisible, subscribeLayers } from "../panels/ViewportPanel.jsx";
import {
  isViewportFreezeEnabled,
  onViewportFreezeChanged,
  setViewportFreezeEnabled,
} from "../viewportFreeze.js";

const MAIN_SCENE_KEY = "mainScene";

/** Project-relative path used as the boot scene. Stored on projectMeta
 *  alongside lastScene (same shape), not in `settings`. */
function projectRelative(root, absPath) {
  const norm = (p) => p.replaceAll("\\", "/");
  const r = norm(root);
  const p = norm(absPath);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : absPath;
}

/** Normalize a user-typed main-scene path into the form we store and boot from:
 *  forward slashes, no leading "./" or "/", no trailing slash, lowercase
 *  extension preserved (the editor treats both .scene and .json as scenes). */
function normalizeMainPath(raw) {
  if (!raw) return "";
  let p = String(raw).replaceAll("\\", "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  while (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);
  return p;
}

/** Async stat — does the file exist at this path? Catches both stale saved
 *  values and user typos before the editor silently fails on boot. */
async function pathExists(absPath) {
  if (!absPath) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("stat_file", { path: absPath });
    return true;
  } catch {
    return false;
  }
}

function Num({ value, onChange, min, max, step = 0.1 }) {
  // A bounded number is the shared slider field (drag by position, click to type).
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) return <NumberField value={value} min={min} max={max} step={step} onCommit={onChange} />;
  return (
    <input
      className="number-field"
      type="number"
      step={step}
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
    />
  );
}

/**
 * Capture-on-focus binding input. Click into the field, press the desired
 * chord (modifiers included), and we store it through `onChange`. The
 * visible text only updates on a valid chord so users immediately see
 * whether the editor accepted their input. Empty input is allowed and
 * means "unbound" — clicking the reset icon restores the default.
 */
function KeybindingInput({ value, defaultChord, onChange }) {
  const [draft, setDraft] = useState(value ?? defaultChord);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e) => {
      // Esc cancels capture without changing anything.
      if (e.key === "Escape") {
        e.preventDefault();
        setCapturing(false);
        setDraft(value ?? "");
        return;
      }
      // Backspace/Delete clears the binding outright (no key required).
      if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        onChange("");
        setCapturing(false);
        return;
      }
      // Ignore lone modifier presses — wait for the actual key.
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      e.preventDefault();
      const tokens = [];
      if (e.ctrlKey) tokens.push("Ctrl");
      if (e.shiftKey) tokens.push("Shift");
      if (e.altKey) tokens.push("Alt");
      if (e.metaKey) tokens.push("Meta");
      // keyTokenFromEvent, not e.key: macOS folds Option into the key
      // (Option+S reports "ß"), and a chord stored as "Alt+ß" would neither
      // display nor match. The physical key keeps the chord portable.
      const token = keyTokenFromEvent(e);
      tokens.push(token.length === 1 ? token.toUpperCase() : token);
      const chord = tokens.join("+");
      setDraft(chord);
      onChange(chord);
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capturing, value, onChange]);

  return (
    <div className="keybinding-cell">
      <input
        className={`text-field keybinding-input ${capturing ? "capturing" : ""}`}
        value={capturing ? "Press a key…" : draft || "Unbound"}
        placeholder={defaultChord}
        readOnly
        onFocus={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
      />
      <button
        type="button"
        className="toolbar-btn icon-only"
        title={`Reset to default (${describeBinding(defaultChord)})`}
        onClick={() => {
          onChange(defaultChord);
          setDraft(defaultChord);
        }}
      >
        <RotateCcw size={12} />
      </button>
    </div>
  );
}

/** A chord, drawn as keycaps. `Ctrl+Shift+S` becomes three keys, not a string. */
function Chord({ chord }) {
  const text = formatChord(chord);
  if (text === "Unbound") return <span className="keycap-unbound">Unbound</span>;
  // On macOS `formatChord` already returns one glyph run (⇧⌥S) — the way a Mac
  // menu writes it — so there is nothing left to split.
  const parts = text.includes("+") ? text.split("+") : [text];
  return (
    <span className="keycaps">
      {parts.map((part, i) => (
        <kbd key={i}>{part}</kbd>
      ))}
    </span>
  );
}

/**
 * One shortcut. Rebindable rows get the capture field; the rest are read-only
 * keycaps.
 *
 * Showing the fixed ones is the point of the page. Five editable rows told you
 * nothing about the seventy chords the editor actually answers to, so "what
 * does Shift+D do" and "is Ctrl+J free" had no answer anywhere in the product.
 */
function KeyRow({ item, keybindings, onChange }) {
  const def = item.action ? KEY_BINDING_ACTIONS[item.action] : null;
  const label = item.label ?? def?.label ?? item.action;
  return (
    <div className="settings-row keybinding-row" title={item.note ?? item.action ?? undefined}>
      <span className="settings-label">
        {label}
        {item.note && <i className="keybinding-note" aria-hidden="true" />}
      </span>
      <div className="settings-control">
        {def ? (
          <KeybindingInput
            value={keybindings[item.action] ?? ""}
            defaultChord={def.default}
            onChange={(chord) => onChange({ ...keybindings, [item.action]: chord })}
          />
        ) : (
          <span className="keybinding-fixed">
            {chordsOf(item).map((chord, i) => (
              <Chord key={i} chord={chord} />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One collapsed subgroup. Closed by default and remembered per group, because
 * the whole catalog open at once is a wall — you come here for one context
 * (the geometry editor, the level tool) and want that one open.
 */
function KeyGroup({ group, keybindings, onChange, query }) {
  const storageKey = `settingsSection.keys.${group.id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const rebindable = group.items.filter((i) => i.action).length;

  const items = useMemo(() => {
    if (!query) return group.items;
    const q = query.toLowerCase();
    return group.items.filter((item) => {
      const label = (item.label ?? KEY_BINDING_ACTIONS[item.action]?.label ?? "").toLowerCase();
      const chords = item.action
        ? [KEY_BINDING_ACTIONS[item.action]?.default ?? ""]
        : chordsOf(item);
      return label.includes(q) || chords.some((c) => String(c).toLowerCase().includes(q));
    });
  }, [group.items, query]);

  // A search that matched here opens the group: hiding the hit behind a
  // closed header is the one thing a filter must never do.
  const expanded = open || (query && items.length > 0);
  if (query && items.length === 0) return null;

  return (
    <div className={`key-group${expanded ? " open" : ""}`}>
      <button
        className="key-group-head"
        title={group.hint ?? undefined}
        onClick={() => {
          setOpen((was) => {
            try {
              localStorage.setItem(storageKey, was ? "0" : "1");
            } catch {
              // Private mode — it still opens, it just won't be remembered.
            }
            return !was;
          });
        }}
      >
        <ChevronRight size={11} className="key-group-caret" />
        <span className="key-group-title">{group.label}</span>
        <span className="key-group-count">
          {items.length}
          {rebindable > 0 && <i title={`${rebindable} rebindable`} />}
        </span>
      </button>
      {expanded && (
        <div className="key-group-body">
          {items.map((item, i) => (
            <KeyRow key={item.action ?? `${item.label}-${i}`} item={item} keybindings={keybindings} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

function KeybindingsTable({ keybindings, onChange }) {
  const [query, setQuery] = useState("");
  return (
    <div className="keybindings-table">
      <input
        className="text-field key-filter"
        type="text"
        value={query}
        placeholder="Filter by action or key…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") setQuery("");
        }}
      />
      {KEY_CATALOG.map((group) => (
        <KeyGroup key={group.id} group={group} keybindings={keybindings} onChange={onChange} query={query.trim()} />
      ))}
    </div>
  );
}

/**
 * Layer names + the collision matrix, Unity-style. The matrix is symmetric, so
 * only the lower triangle is editable — showing both halves invites the user to
 * set two contradictory values for one pair.
 *
 * `matrix[i]` is a bitmask of the layers layer `i` collides with; `null` (the
 * default) means everything collides, which is what projects had before layers
 * existed. The first edit materialises a real matrix.
 */
function CollisionMatrix({ layers, matrix, onChange }) {
  const names = layers ?? [];
  const rows = matrix ?? names.map(() => 0xffff);
  const collides = (i, j) => !!(rows[i] & (1 << j));

  const toggle = (i, j) => {
    const next = names.map((_, k) => rows[k] ?? 0xffff);
    const on = !collides(i, j);
    if (on) {
      next[i] |= 1 << j;
      next[j] |= 1 << i;
    } else {
      next[i] &= ~(1 << j);
      next[j] &= ~(1 << i);
    }
    onChange({ matrix: next });
  };

  const rename = (index, value) => {
    const next = [...names];
    next[index] = value;
    onChange({ layers: next });
  };

  return (
    <>
      <div className="settings-layer-names">
        {names.map((name, index) => (
          <label key={index}>
            <span>{index}</span>
            <input
              className="text-field"
              value={name}
              onChange={(e) => rename(index, e.target.value)}
              // Layer 0 is the fallback for any collider whose layer went
              // missing, so it always has to exist under some name.
              placeholder={index === 0 ? "Default" : `Layer ${index}`}
            />
          </label>
        ))}
      </div>
      <div
        className="collision-matrix"
        title="A collider sits on one layer; the matrix decides which layers touch. Raycasts and overlaps take their own layer list and ignore it."
      >
        {names.map((rowName, i) => (
          <div className="collision-matrix-row" key={i}>
            <span className="collision-matrix-label" title={rowName}>
              {rowName}
            </span>
            {/* Lower triangle including the diagonal: pair {i, j} appears
                exactly once, and the diagonal is a layer against itself
                (debris that should not collide with other debris). */}
            {names.slice(0, i + 1).map((colName, j) => (
              <label
                key={j}
                className="collision-matrix-cell"
                title={`${rowName} ↔ ${colName}`}
              >
                <input type="checkbox" checked={collides(i, j)} onChange={() => toggle(i, j)} />
              </label>
            ))}
          </div>
        ))}
        <div className="collision-matrix-row collision-matrix-footer">
          <span className="collision-matrix-label" />
          {names.map((name, i) => (
            <span className="collision-matrix-vlabel" key={i} title={name}>
              {name}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * Project-wide settings (project.json `settings`): editor behavior, hot reload,
 * performance, export metadata, physics layers. Not undoable — these are
 * preferences, not scene edits. Save writes the file and applies live.
 */
export function ProjectSettingsPanel() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const projectName = useProjectStore((s) => s.projectMeta?.name);
  const mainScene = useProjectStore((s) => s.projectMeta?.mainScene ?? "");
  const [settings, setSettings] = useState(null);
  const [dirty, setDirty] = useState(false);
  // Not part of `settings`: this one is a per-machine preference in
  // localStorage (how heavy YOUR scene runs on YOUR hardware), so it applies
  // the moment it is clicked and is untouched by Save. See viewportFreeze.js.
  const [freezeUnfocused, setFreezeUnfocused] = useState(isViewportFreezeEnabled);
  useEffect(() => onViewportFreezeChanged(setFreezeUnfocused), []);
  // Also not part of `settings`: the viewport OWNS its layer toggles and
  // persists them itself the moment they change. Reading the live value here
  // instead of the draft is what keeps this switch and the viewport's
  // Visibility menu from ever disagreeing.
  const [glowOn, setGlowOn] = useState(true);
  useEffect(() => subscribeLayers((layers) => setGlowOn(layers.ambient !== false)), []);
  const [mainDraft, setMainDraft] = useState(mainScene);
  const [mainDirty, setMainDirty] = useState(false);
  // null = unknown/checking, true = exists, false = missing
  const [mainValid, setMainValid] = useState(null);

  useEffect(() => {
    if (rootPath) setSettings(getProjectSettings());
  }, [rootPath]);

  useEffect(() => {
    setMainDraft(mainScene);
    setMainDirty(false);
  }, [mainScene, rootPath]);

  // Live-validate the typed (or saved) path so the user sees "missing" before
  // they hit Save — and so they understand why the editor refuses to open it.
  useEffect(() => {
    if (!rootPath) return;
    const value = normalizeMainPath(mainDirty ? mainDraft : mainScene);
    if (!value) {
      setMainValid(null); // empty = cleared, not an error
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const ok = await pathExists(`${rootPath}/${value}`);
      if (!cancelled) setMainValid(ok);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mainDraft, mainScene, mainDirty, rootPath]);

  if (!rootPath) {
    return <div className="inspector-panel empty">Open a project to edit its settings.</div>;
  }
  if (!settings) return <div className="inspector-panel empty">Loading…</div>;

  const patch = (section, p) => {
    setSettings({ ...settings, [section]: { ...settings[section], ...p } });
    setDirty(true);
  };

  const save = async () => {
    try {
      // ⚠ THE LAYERS ARE NOT OURS TO WRITE. This draft was snapshotted when
      // the panel mounted, and the viewport persists its own toggles the
      // moment they change — so writing the draft back would silently undo
      // every Visibility-menu change made since the panel opened, switching
      // things (the ambient glow among them) back on behind the user. The
      // live values go in instead.
      const live = getProjectSettings();
      await saveProjectSettings({
        ...settings,
        editor: {
          ...settings.editor,
          layers: live.editor.layers,
          playLayers: live.editor.playLayers,
        },
      });
      setDirty(false);
      console.log("Project settings saved");
    } catch (err) {
      console.error(`Failed to save project settings: ${err}`);
    }
  };

  const setMain = async (value) => {
    try {
      await useProjectStore.getState().updateMeta({ [MAIN_SCENE_KEY]: value });
      setMainDraft(value);
      setMainDirty(false);
    } catch (err) {
      console.error(`Failed to set main scene: ${err}`);
    }
  };

  const useCurrentAsMain = () => {
    const abs = currentScenePath();
    if (abs) setMain(projectRelative(rootPath, abs));
  };

  const { editor, scripts, game, physics, screenshot } = settings;
  const mainValue = normalizeMainPath(mainDirty ? mainDraft : mainScene);
  const mainMissing = !!mainValue && mainValid === false;

  return (
    <div className="inspector-panel settings-panel project-settings-panel">
      <div className="panel-toolbar">
        <span className="asset-path" title={rootPath}>
          {projectName ?? basename(rootPath)}
        </span>
        <button
          className={`toolbar-btn${dirty ? " primary" : ""}`}
          disabled={!dirty}
          title={dirty ? "Write project.json and apply" : "No unsaved changes"}
          onClick={save}
        >
          <Save size={13} />
          Save
        </button>
      </div>

      <Section id="project.game" title="Game">
        <Row label="Title" hint="Page title of the exported build. Empty = project name.">
          <input
            className="text-field"
            type="text"
            value={game.title}
            placeholder={projectName ?? basename(rootPath)}
            onChange={(e) => patch("game", { title: e.target.value })}
          />
        </Row>
        <Row
          label="Main scene"
          hint="Opens on editor boot and boots the build. Empty = last-edited scene."
        >
          <AssetField
            descriptor={{ exts: ["scene"], emptyLabel: "Last edited scene" }}
            value={mainValue && rootPath ? `${rootPath}/${mainValue}` : ""}
            onCommit={(abs) => setMain(abs ? normalizeMainPath(projectRelative(rootPath, abs)) : "")}
          />
          <button
            className="toolbar-btn icon-only"
            title="Use the scene that's open now"
            disabled={!currentScenePath()}
            onClick={useCurrentAsMain}
          >
            <Crosshair size={13} />
          </button>
        </Row>
        {mainMissing ? (
          <Note danger>Not found: {mainValue}</Note>
        ) : null}
        <Row
          label="Save id"
          hint="Namespaces save slots so two games on one origin can't read each other's. Empty = the title, which means renaming the game orphans existing saves."
        >
          <input
            className="text-field"
            type="text"
            value={game.saveId ?? ""}
            placeholder={game.title || projectName || basename(rootPath)}
            onChange={(e) => patch("game", { saveId: e.target.value })}
          />
        </Row>
        <Row
          label="Save version"
          hint="Bump when what your scripts write in onSave changes, and register engine.saves.registerMigration(n, fn). A save with no path to this version is refused, not loaded wrong."
        >
          <Num
            value={game.saveVersion ?? 1}
            min={1}
            step={1}
            onChange={(v) => patch("game", { saveVersion: Math.max(1, Math.round(v)) })}
          />
        </Row>
      </Section>

      <Section id="project.hotreload" title="Hot reload">
        <Row
          label="Watch project files"
          hint="Re-read files changed outside the editor — an agent's file tools, your IDE, a paint program, a git checkout. Off means those changes appear only after a manual refresh or a restart."
        >
          <Toggle
            checked={editor.watchProject !== false}
            onChange={(v) => patch("editor", { watchProject: v })}
          />
        </Row>
        <Row
          label="Reload scripts"
          hint="Re-run changed .ts/.js scripts in place, keeping the scene as it is."
        >
          <Toggle
            checked={scripts.hotReload !== false}
            onChange={(v) => patch("scripts", { hotReload: v })}
          />
        </Row>
        <Row
          label="Poll interval"
          sub
          disabled={scripts.hotReload === false}
          hint="How often script files are checked for changes."
        >
          <Num
            value={scripts.reloadIntervalMs}
            min={100}
            step={50}
            onChange={(v) => patch("scripts", { reloadIntervalMs: v })}
          />
          <span className="settings-unit">ms</span>
        </Row>
      </Section>

      <Section id="project.editor" title="Editor">
        <Row label="Accent" hint="The editor's highlight colour: selection, focus, the active tool. Applies immediately; Save keeps it.">
          <input
            type="color"
            className="color-field"
            value={editor.accent || DEFAULT_ACCENT}
            onChange={(e) => {
              applyAccent(e.target.value);
              patch("editor", { accent: e.target.value });
            }}
          />
          <button
            className="toolbar-btn icon-only"
            title="Default accent"
            disabled={(editor.accent || DEFAULT_ACCENT).toLowerCase() === DEFAULT_ACCENT}
            onClick={() => {
              applyAccent(DEFAULT_ACCENT);
              patch("editor", { accent: DEFAULT_ACCENT });
            }}
          >
            <RotateCcw size={12} />
          </button>
        </Row>
        <Row label="Autosave" hint="Seconds between automatic scene saves. 0 = off.">
          <Num
            value={editor.autosaveSeconds}
            min={0}
            step={5}
            onChange={(v) => patch("editor", { autosaveSeconds: v })}
          />
          <span className="settings-unit">s</span>
        </Row>
        <Row label="Show grid">
          <Toggle
            checked={editor.showGrid !== false}
            onChange={(v) => patch("editor", { showGrid: v })}
          />
        </Row>
        <Row label="Grid size" sub disabled={editor.showGrid === false}>
          <Num
            value={editor.gridSize}
            min={2}
            step={2}
            onChange={(v) => patch("editor", { gridSize: v })}
          />
        </Row>
        <Row label="Grid divisions" sub disabled={editor.showGrid === false}>
          <Num
            value={editor.gridDivisions}
            min={1}
            step={1}
            onChange={(v) => patch("editor", { gridDivisions: v })}
          />
        </Row>
        <Row label="Snap move" hint="Grid step held down while dragging the move gizmo.">
          <Num
            value={editor.snapTranslate}
            min={0.01}
            step={0.1}
            onChange={(v) => patch("editor", { snapTranslate: v })}
          />
        </Row>
        <Row label="Snap rotate">
          <Num
            value={editor.snapRotateDeg}
            min={1}
            max={90}
            step={1}
            onChange={(v) => patch("editor", { snapRotateDeg: v })}
          />
          <span className="settings-unit">°</span>
        </Row>
        <Row label="Snap scale">
          <Num
            value={editor.snapScale}
            min={0.01}
            step={0.05}
            onChange={(v) => patch("editor", { snapScale: v })}
          />
        </Row>
      </Section>

      <Section id="project.viewport" title="Viewport">
        {/* "Pixel ratio cap" used to live here and did nothing: the renderer
            took min(this, the scene's maxDevicePixelRatio), so it only acted
            when it was the stricter of the two. It is now set in ONE place —
            Scene Settings → Performance → Max Device Pixel Ratio — which is
            also the one the quality presets clamp and the build ships. */}
        <Row
          label="Freeze unfocused"
          hint="Stop drawing the viewport while another panel has focus — or while the whole editor window is behind another app, so testing a build in a browser gets the GPU to itself. It wakes whenever something it draws changes. Applies immediately and is stored per machine, not in the project."
        >
          <Toggle checked={freezeUnfocused} onChange={setViewportFreezeEnabled} />
        </Row>
{/* ⚠ THIS SWITCH IS LIVE, and it has to be. Written as a draft edit like
            the rows below it, flipping it did nothing at all until Save — and
            a switch that does nothing when you click it is a broken switch,
            whatever it does later. It is `editor.layers.ambient`, the SAME
            value the viewport's Visibility menu writes, so it applies and
            persists exactly the way that menu does and the two can never
            disagree. Its two numbers still ride on Save; they apply as they
            change, which is feedback enough to tune by. */}
        <Row
          label="Ambient glow"
          hint="Spill the viewport's own light under the panels around it. Applies immediately and saves itself, like the viewport's Visibility menu — it is one setting, shown in two places."
        >
          <Toggle checked={glowOn} onChange={(v) => setLayerVisible("ambient", v)} />
        </Row>
        <Row label="Spread" sub disabled={!glowOn} hint="How far the light reaches past the viewport's edges, in pixels.">
          <Num
            value={editor.ambientGlowSpread ?? AMBIENT_GLOW_DEFAULTS.spread}
            min={0}
            max={400}
            step={5}
            onChange={(v) => {
              setAmbientGlowLook({ spread: v });
              patch("editor", { ambientGlowSpread: v });
            }}
          />
          <span className="settings-unit">px</span>
        </Row>
        <Row label="Intensity" sub disabled={!glowOn} hint="How visible the light is, from 0 to 1.">
          <Num
            value={editor.ambientGlowIntensity ?? AMBIENT_GLOW_DEFAULTS.intensity}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => {
              setAmbientGlowLook({ intensity: v });
              patch("editor", { ambientGlowIntensity: v });
            }}
          />
        </Row>
      </Section>

      <Section id="project.screenshot" title="Screenshot">
        <Row
          label="Destination folder"
          wide
          hint="Absolute folder the PNG is written to. Empty = the OS Downloads folder; in a plain browser the file goes through the browser's own download flow instead."
        >
          <input
            className="text-field"
            type="text"
            value={screenshot.folder}
            placeholder="Downloads"
            onChange={(e) => patch("screenshot", { folder: e.target.value })}
          />
          <button
            className="toolbar-btn icon-only"
            title="Browse…"
            onClick={async () => {
              try {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const dir = await open({ directory: true, title: "Screenshot folder" });
                if (dir) patch("screenshot", { folder: dir });
              } catch (err) {
                console.warn(`Folder picker unavailable: ${err?.message ?? err}`);
              }
            }}
          >
            <FolderOpen size={13} />
          </button>
          <button
            className="toolbar-btn icon-only"
            title="Reset to Downloads"
            disabled={!screenshot.folder}
            onClick={() => patch("screenshot", { folder: "" })}
          >
            <X size={13} />
          </button>
        </Row>
        <Row
          label="File name prefix"
          hint={
            "Files are named <prefix>-<date>_<time>.png. Captured with the “Screenshot viewport” " +
            "binding under Keybindings — Shift+Alt+S by default (Option on macOS) — the frame " +
            "exactly as shown, path copied to the clipboard."
          }
        >
          <input
            className="text-field"
            type="text"
            value={screenshot.prefix}
            placeholder="screenshot"
            onChange={(e) => patch("screenshot", { prefix: e.target.value })}
          />
        </Row>
      </Section>

      <Section id="project.keybindings" title="Keybindings" defaultOpen={false}>
        <KeybindingsTable
          keybindings={editor.keybindings ?? {}}
          onChange={(keybindings) => patch("editor", { keybindings })}
        />
      </Section>

      <Section id="project.physics" title="Physics" defaultOpen={false}>
        <Row
          label="Auto colliders start enabled"
          hint="With physics on, every mesh and model gets a generated Collider. Off (default): it is attached disabled — no cooking, no native shape — until you enable it on the entities that need it. On: every generated collider is live at load, which cooks every mesh in the scene."
        >
          <Toggle
            checked={physics.autoCollidersEnabled === true}
            onChange={(v) => patch("physics", { autoCollidersEnabled: v })}
          />
        </Row>
        <CollisionMatrix
          layers={physics.layers}
          matrix={physics.matrix}
          onChange={(next) => patch("physics", next)}
        />
      </Section>
    </div>
  );
}
