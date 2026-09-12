import { useEffect, useRef, useState } from "react";
import { Bot, Box, ChevronDown, CloudCheck, CloudUpload, GitBranch, Hammer, Pause, Play, RotateCcw, Search, Settings, Square, StepForward } from "./icons/index.jsx";
import { listProjectAssets } from "./assetLoader.js";
import { PopoverMenu } from "./fields/PopoverMenu.jsx";
import { PANEL_ICONS } from "./panelCatalog.js";
import { usePlayStore } from "./store/playStore.js";
import { toggle as togglePlay, togglePaused, stepFrame } from "./playMode.js";
import { BrowserPreviewLauncher } from "./components/BrowserPreviewLauncher.jsx";
import { WindowControls } from "./WindowControls.jsx";
import { commandBus, useHistoryStore } from "./commands/CommandBus.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { useSceneStore } from "./store/sceneStore.js";
import {
  copyEntities,
  cutEntities,
  pasteEntities,
  clipboardHasEntities,
  duplicateSelection,
  deleteSelection,
} from "./clipboard.js";
import { groupSelection } from "./group.js";
import { newScene, openScene, openScenePath, saveScene } from "./sceneIO.js";
import { useProjectStore } from "./store/projectStore.js";
import { openPanel, resetLayout } from "./EditorShell.jsx";
import { describeBinding, getBinding, visibilityActions } from "./keybindings.js";
import { ProcessingIndicator } from "./components/ProcessingIndicator.jsx";
import {
  setCursor3DPosition,
  toggleCursor3DVisible,
} from "./threeDCursor.js";
import {
  snapCursorToSelection,
  snapCursorToWorldOrigin,
  snapCursorToGridFloor,
  snapSelectionToCursor,
  snapSelectionToOrigin,
} from "./threeDCursorOps.js";
import { subscribeMenuItems } from "../engine/editorBridge.js";
import { useMcpStore } from "./api/mcpBridge.js";
import { startGitWatch, summarize, useGitStore } from "./git/gitStore.js";

/**
 * Merges script-contributed entries (`@menuItem` / `Editor.menu.add`) into the
 * static menu definition.
 *
 * Entries whose top-level name matches an existing menu are appended to it
 * behind a separator, so a script extending "Edit" lands where the user would
 * look. Everything else creates its own top-level menu — which is how "Tools"
 * (the default) appears only once a project actually has tool scripts, rather
 * than sitting there empty in every project.
 */
function withScriptMenus(menus, scriptItems) {
  if (!scriptItems.length) return menus;
  const merged = { ...menus };
  for (const entry of scriptItems) {
    const item = { label: entry.label, action: entry.run };
    if (merged[entry.menu]) merged[entry.menu] = [...merged[entry.menu], item];
    else merged[entry.menu] = [item];
  }
  // The separator has to go in after the fact: the loop above appends one item
  // at a time and would otherwise emit a separator per entry.
  for (const name of Object.keys(merged)) {
    const added = scriptItems.filter((entry) => entry.menu === name).length;
    if (!added || !menus[name]) continue;
    const at = merged[name].length - added;
    merged[name] = [...merged[name].slice(0, at), { separator: true }, ...merged[name].slice(at)];
  }
  return merged;
}

/**
 * Bridge state in the menu bar — always present, which is the point.
 *
 * The first version hid itself while MCP was off, which made the feature
 * findable only by someone who already knew it existed and where its settings
 * lived (three levels into Project Settings). "Hard to find" was the reported
 * problem, and a permanent one-word chip is the cheapest honest fix: it is the
 * entry point when off, and a live indicator when on — including a call counter,
 * because when something outside the window is editing your scene you should be
 * able to see it happening.
 */
function McpIndicator() {
  const status = useMcpStore((s) => s.status);
  const toolCount = useMcpStore((s) => s.toolCount);
  const callCount = useMcpStore((s) => s.callCount);
  const port = useMcpStore((s) => s.port);
  const tone = status === "connected" ? "connected" : status === "disabled" ? "off" : "waiting";
  return (
    <button
      className={`mcp-chip ${tone}`}
      title={
        status === "connected"
          ? `Assistant connected on port ${port} — ${toolCount} tools, ${callCount} call${callCount === 1 ? "" : "s"} served. Click for details.`
          : status === "disabled"
            ? "Assistant access is off. Click to open the MCP panel and turn it on."
            : `Waiting for an assistant on port ${port}. Click for details.`
      }
      onClick={() => openPanel("mcp")}
    >
      <span className="mcp-dot" />
      <Bot size={12} className="mcp-chip-icon" aria-hidden="true" />
      {status === "connected" && callCount > 0 ? <span className="mcp-chip-count">{callCount}</span> : null}
    </button>
  );
}

/**
 * Branch and change count, always visible.
 *
 * The same argument as the MCP chip next to it: a panel nobody opens is a
 * feature nobody has. But this one also answers a question that costs real work
 * to get wrong — "which branch am I editing?" — and the honest place for that
 * answer is next to the scene name, not three clicks away. It stays quiet
 * (dimmed, one word) until there is something to say.
 */
function GitIndicator() {
  const state = useGitStore();
  // Starts the poll and the file-change subscription once, for the life of the
  // editor: the chip is the one thing that needs repository state even when the
  // Source Control panel has never been opened.
  useEffect(() => startGitWatch(), []);
  const summary = summarize(state);
  return (
    <button className={`git-chip ${summary.tone}`} title={summary.title} onClick={() => openPanel("git")}>
      {/* The branch glyph carries the state colour, so the chip reads as
          version control at a glance instead of relying on the word "git". */}
      <GitBranch size={11} className="git-chip-icon" />
      {summary.label}
      {summary.changed ? <span className="git-chip-count">{summary.changed}</span> : null}
      {summary.behind ? <span className="git-chip-arrow">↓{summary.behind}</span> : null}
      {summary.ahead ? <span className="git-chip-arrow">↑{summary.ahead}</span> : null}
    </button>
  );
}

/**
 * A menu item's label with its glyph when it has one. The Window menu shows the
 * same glyphs the tab strip and the launcher use, so a panel is the same
 * picture in all three places.
 */
function MenuItemLabel({ item }) {
  const Icon = item.icon ?? (item.panel ? PANEL_ICONS[item.panel] : null);
  return (
    <span className="menu-item-label">
      {Icon ? <Icon size={13} className="menu-item-icon" aria-hidden="true" /> : null}
      {item.label}
    </span>
  );
}

/**
 * Play / Pause / Step, Build and Preview, and the scene's name — centred in
 * the bar, together, because they are application verbs: running the game
 * means the same thing whether you are in the viewport or mid-word in the
 * code editor (EditorChrome.jsx makes the same argument for the keyboard).
 * The viewport toolbar used to hold Play, which contradicted that.
 *
 * While the game runs the Play button turns amber and the bar grows a 1 px
 * amber line (`.menu-bar.live`), so "live" is visible from every panel.
 */
/**
 * The scene, and every other scene in the project one click away. Lists the
 * project's .scene files when opened; picking one opens it (the current scene
 * autosaves on its interval, and Ctrl+S is one key away).
 */
function SceneSwitcher({ sceneName, dirty }) {
  const rootPath = useProjectStore((s) => s.rootPath);
  const [open, setOpen] = useState(false);
  const [scenes, setScenes] = useState(null);
  const anchorRef = useRef(null);
  useEffect(() => {
    if (!open || !rootPath) return undefined;
    let live = true;
    setScenes(null);
    listProjectAssets(rootPath, ["scene"], 6)
      .then((found) => live && setScenes(found))
      .catch(() => live && setScenes([]));
    return () => {
      live = false;
    };
  }, [open, rootPath]);
  const fileName = (path) => String(path ?? "").split(/[\\/]/).pop().replace(/\.scene$/i, "");
  return (
    <div className="dropdown-wrap">
      <button
        ref={anchorRef}
        type="button"
        className="scene-chip"
        title={dirty ? `${sceneName} — unsaved changes. Click to switch scene.` : `${sceneName || "No scene"}. Click to switch scene.`}
        onClick={() => setOpen((v) => !v)}
      >
        <Box size={13} />
        {sceneName || "No scene"}
        <span className={`scene-dot${dirty ? " dirty" : ""}`} aria-hidden="true" />
        <ChevronDown size={12} className="scene-caret" />
      </button>
      {open && (
        <PopoverMenu anchorRef={anchorRef} className="scene-menu" minWidth={240} onClose={() => setOpen(false)}>
          {scenes === null && <div className="dropdown-item">Loading…</div>}
          {scenes?.map((path) => (
            <button
              key={path}
              className={`dropdown-item${fileName(path) === sceneName ? " checked" : ""}`}
              title={path}
              onClick={() => {
                setOpen(false);
                if (fileName(path) !== sceneName) openScenePath(path);
              }}
            >
              <span className="menu-item-label">
                <Box size={13} className="menu-item-icon" aria-hidden="true" />
                {fileName(path)}
              </span>
            </button>
          ))}
          {scenes?.length === 0 && <div className="dropdown-item">No scenes in this project</div>}
          <div className="menu-separator" />
          <button className="dropdown-item" onClick={() => { setOpen(false); newScene(); }}>
            <span className="menu-item-label">New scene</span>
          </button>
          <button className="dropdown-item" onClick={() => { setOpen(false); openScene(); }}>
            <span className="menu-item-label">Open scene…</span>
          </button>
        </PopoverMenu>
      )}
    </div>
  );
}

function Transport({ sceneName, dirty }) {
  const playing = usePlayStore((s) => s.playing);
  const paused = usePlayStore((s) => s.paused);
  return (
    <div className="transport" role="group" aria-label="Play, build and preview">
      <button
        className={`transport-btn play${playing ? " live" : ""}`}
        title={playing ? "Stop (Ctrl+P)" : "Play (Ctrl+P)"}
        onClick={() => togglePlay()}
      >
        {playing ? <Square size={13} /> : <Play size={13} />}
      </button>
      <button
        className={`transport-btn${paused ? " active" : ""}`}
        disabled={!playing}
        title={paused ? "Resume (Ctrl+Shift+P)" : "Pause (Ctrl+Shift+P)"}
        onClick={() => togglePaused()}
      >
        <Pause size={13} />
      </button>
      <button className="transport-btn" disabled={!playing} title="Step one frame (Ctrl+.)" onClick={() => stepFrame()}>
        <StepForward size={13} />
      </button>
      <span className="transport-sep" />
      <button
        className="transport-btn"
        title="Build game (Ctrl+B)"
        onClick={() => import("./exportGame.js").then((m) => m.exportGameWithToasts())}
      >
        <Hammer size={13} />
      </button>
      <BrowserPreviewLauncher />
      <span className="transport-sep" />
      <SceneSwitcher sceneName={sceneName} dirty={dirty} />
    </div>
  );
}

export function MenuBar() {
  const [openMenu, setOpenMenu] = useState(null);
  const [scriptItems, setScriptItems] = useState([]);
  // Fires immediately with the current list, then on every register/unregister
  // (including the ones a hot-reloading script triggers).
  useEffect(() => subscribeMenuItems(setScriptItems), []);
  // Narrow selectors — subscribing to the whole store re-rendered the menu
  // bar on every command-history mutation.
  const undoLabel = useHistoryStore((s) => s.undoLabel);
  const redoLabel = useHistoryStore((s) => s.redoLabel);
  const canUndo = useHistoryStore((s) => s.canUndo);
  const canRedo = useHistoryStore((s) => s.canRedo);
  const history = { undoLabel, redoLabel, canUndo, canRedo };
  const selection = useSelectionStore((s) => s.ids);
  const sceneName = useSceneStore((s) => s.sceneName);
  const dirty = useSceneStore((s) => s.dirty);
  const playing = usePlayStore((s) => s.playing);

  const sceneRoot = useProjectStore((s) => s.rootPath);
  const menus = {
    File: [
      { label: "New Scene", action: () => newScene() },
      { label: "Open Scene…", shortcut: "Ctrl+O", action: () => openScene() },
      { separator: true },
      { label: "Save Scene", shortcut: "Ctrl+S", action: () => saveScene() },
      { label: "Save Scene As…", action: () => saveScene({ saveAs: true }) },
      { separator: true },
      {
        label: "New Project…",
        action: () => useProjectStore.getState().createProject(),
      },
      {
        label: "Open Project Folder…",
        action: () => useProjectStore.getState().openFolder(),
      },
      {
        label: "Close Project",
        shortcut: "Ctrl+Shift+W",
        disabled: !sceneRoot,
        action: () => useProjectStore.getState().closeProject(),
      },
      { separator: true },
      // The panel is where a build is *configured*; this is the one-click path
      // for someone who has already configured it (or is happy with defaults).
      { label: "Build Settings…", panel: "build", action: () => openPanel("build") },
      { label: "Build Game…", shortcut: "Ctrl+B", action: () => import("./exportGame.js").then((m) => m.exportGameWithToasts()) },
      { separator: true },
      // ⚠ THE CHORD IS NOT ALWAYS REACHABLE, AND THIS IS THE WAY IN WHEN IT IS
      // NOT (2026-09-11). The default is Shift+Alt+S, and on Windows **Alt+Shift
      // is the OS input-language switch** whenever more than one keyboard layout
      // is installed — the shell eats the chord and the app is never told, which
      // reads exactly like a broken shortcut ("shift + alt + S still not doing
      // viewport screenshot"). Nothing in the page can intercept that, so the
      // action needs a path that does not go through the keyboard at all. The
      // chord is rebindable in Project Settings → Keybindings for anyone who
      // wants one that does not collide.
      {
        label: "Screenshot Viewport",
        shortcut: describeBinding(getBinding("editor.screenshot")),
        action: () =>
          import("./viewportScreenshot.js")
            .then((m) => m.saveViewportScreenshot())
            .catch((err) => console.error(`Screenshot failed: ${err}`)),
      },
    ],
    Edit: [
      {
        label: history.undoLabel ? `Undo ${history.undoLabel}` : "Undo",
        shortcut: "Ctrl+Z",
        disabled: !history.canUndo,
        action: () => commandBus.undo(),
      },
      {
        label: history.redoLabel ? `Redo ${history.redoLabel}` : "Redo",
        shortcut: "Ctrl+Shift+Z",
        disabled: !history.canRedo,
        action: () => commandBus.redo(),
      },
      { separator: true },
      {
        label: "Copy",
        shortcut: "Ctrl+C",
        disabled: !selection.length,
        action: () => copyEntities(selection),
      },
      {
        label: "Cut",
        shortcut: "Ctrl+X",
        disabled: !selection.length,
        action: () => cutEntities(selection),
      },
      {
        label: "Paste",
        shortcut: "Ctrl+V",
        disabled: !clipboardHasEntities(),
        action: () => {
          const first = selection[0];
          const parentId = first ? (useSceneStore.getState().entities[first]?.parentId ?? null) : null;
          pasteEntities(parentId);
        },
      },
      { separator: true },
      {
        label: "Duplicate",
        shortcut: "Ctrl+D",
        disabled: !selection.length,
        action: () => duplicateSelection(),
      },
      {
        label: "Group Selection",
        shortcut: "Ctrl+G",
        disabled: selection.length < 2,
        action: () => groupSelection(),
      },
      {
        label: "Delete",
        shortcut: "Del",
        disabled: !selection.length,
        action: () => deleteSelection(),
      },
    ],
    Window: [
      { label: "Viewport", panel: "viewport", action: () => openPanel("viewport") },
      { label: "Game", panel: "game", action: () => openPanel("game") },
      { label: "Hierarchy", panel: "hierarchy", action: () => openPanel("hierarchy") },
      { label: "Inspector", panel: "inspector", action: () => openPanel("inspector") },
      { label: "Assets", panel: "assets", action: () => openPanel("assets") },
      { label: "Console", panel: "console", action: () => openPanel("console") },
      { separator: true },
      { label: "Shader Graph", panel: "shaderGraph", action: () => openPanel("shaderGraph") },
      { label: "Particles", panel: "particles", action: () => openPanel("particles") },
      { label: "VFX", panel: "vfx", action: () => openPanel("vfx") },
      { label: "Animator", panel: "animator", action: () => openPanel("animator") },
      { label: "Timeline", panel: "timeline", action: () => openPanel("timeline") },
      { label: "Post Process", panel: "postprocess", action: () => openPanel("postprocess") },
      { separator: true },
      { label: "Scene Settings", panel: "sceneSettings", action: () => openPanel("sceneSettings") },
      { label: "Project Settings", panel: "projectSettings", action: () => openPanel("projectSettings") },
      { label: "Build Settings", panel: "build", action: () => openPanel("build") },
      { label: "Modules", panel: "modules", action: () => openPanel("modules") },
      { label: "Input", panel: "input", action: () => openPanel("input") },
      { label: "Events", panel: "events", action: () => openPanel("events") },
      { label: "Event Graph", panel: "eventGraph", action: () => openPanel("eventGraph") },
      { label: "Texture Editor", panel: "textureEditor", action: () => openPanel("textureEditor") },
      { label: "Code", panel: "code", action: () => openPanel("code") },
      { label: "Fonts", panel: "fontLibrary", action: () => openPanel("fontLibrary") },
      { label: "Poly Haven", panel: "polyhaven", action: () => openPanel("polyhaven") },
      { label: "AmbientCG", panel: "ambientcg", action: () => openPanel("ambientcg") },
      { label: "Sketchfab", panel: "sketchfab", action: () => openPanel("sketchfab") },
      { label: "Poly Pizza", panel: "polypizza", action: () => openPanel("polypizza") },
      { label: "KayKit", panel: "kaykit", action: () => openPanel("kaykit") },
      { label: "Fab", panel: "fab", action: () => openPanel("fab") },
      { label: "itch.io", panel: "itchio", action: () => openPanel("itchio") },
      { label: "Audio Library", panel: "audioLibrary", action: () => openPanel("audioLibrary") },
      { label: "Audio Editor", panel: "audioEditor", action: () => openPanel("audioEditor") },
      { label: "Source Control", panel: "git", action: () => openPanel("git") },
      { label: "Terminal", panel: "terminal", action: () => openPanel("terminal") },
      { label: "Assistant (MCP)", panel: "mcp", action: () => openPanel("mcp") },
      { label: "AI", panel: "ai", action: () => openPanel("ai") },
      { separator: true },
      { label: "Reset Layout", icon: RotateCcw, action: () => resetLayout() },
    ],
    Visibility: [
      {
        label: "Toggle selected (editor)",
        shortcut: describeBinding(getBinding("editor.toggleSelected")),
        disabled: !selection.length,
        action: () => visibilityActions.toggleSelectedEditor(),
      },
      {
        label: "Toggle all unselected (editor)",
        shortcut: describeBinding(getBinding("editor.toggleUnselected")),
        action: () => visibilityActions.toggleUnselectedEditor(),
      },
      { separator: true },
      {
        label: "Toggle selected (game)",
        shortcut: describeBinding(getBinding("game.toggleSelected")),
        disabled: !selection.length,
        action: () => visibilityActions.toggleSelectedGame(),
      },
      {
        label: "Toggle all unselected (game)",
        shortcut: describeBinding(getBinding("game.toggleUnselected")),
        action: () => visibilityActions.toggleUnselectedGame(),
      },
    ],
    Cursor: [
      {
        label: "Snap Selection to 3D Cursor",
        shortcut: "Shift+S",
        disabled: !selection.length,
        action: () => snapSelectionToCursor(),
      },
      {
        label: "Snap Selection to World Origin",
        disabled: !selection.length,
        action: () => snapSelectionToOrigin(),
      },
      { separator: true },
      {
        label: "3D Cursor to Selection",
        shortcut: "Shift+S",
        disabled: !selection.length,
        action: () => snapCursorToSelection(),
      },
      { label: "3D Cursor to World Origin", action: () => snapCursorToWorldOrigin() },
      { label: "3D Cursor to Grid Floor", action: () => snapCursorToGridFloor() },
      {
        label: "Reset 3D Cursor",
        action: () => setCursor3DPosition(0, 0, 0),
      },
      { separator: true },
      {
        label: "Toggle 3D Cursor",
        action: () => toggleCursor3DVisible(),
      },
    ],
  };

  const runItem = (item) => {
    setOpenMenu(null);
    item.action();
  };

  return (
    // The bar is the window's title bar on Windows (no native decorations):
    // its empty surface drags the window and double-click maximises it.
    <div className={`menu-bar${playing ? " live" : ""}`} data-tauri-drag-region>
      <img className="app-mark" src="/app-icon.png" alt="" draggable={false} data-tauri-drag-region />
      <span className="wordmark" data-tauri-drag-region>THREE ENGINE</span>
      {Object.entries(withScriptMenus(menus, scriptItems)).map(([name, items]) => (
        <div key={name} className="menu-wrap">
          <button
            className={`menu-btn ${openMenu === name ? "open" : ""}`}
            onClick={() => setOpenMenu(openMenu === name ? null : name)}
            onMouseEnter={() => openMenu && setOpenMenu(name)}
          >
            {name}
          </button>
          {openMenu === name && (
            <div className="dropdown-menu menu-dropdown">
              {items.map((item, i) =>
                item.separator ? (
                  <div key={i} className="menu-separator" />
                ) : (
                  <button
                    // Index-suffixed because script-contributed entries can
                    // legitimately repeat a label (two entities running the
                    // same tool script), and a duplicate key drops one of them.
                    key={`${item.label}-${i}`}
                    className="dropdown-item"
                    disabled={item.disabled}
                    onClick={() => runItem(item)}
                  >
                    <MenuItemLabel item={item} />
                    {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
      {openMenu && <div className="dropdown-overlay" onClick={() => setOpenMenu(null)} />}
      <Transport sceneName={sceneName} dirty={dirty} />
      <div className="menu-spacer" />
      <span className={`save-state${dirty ? " dirty" : ""}`} title={dirty ? "The scene has changes not yet on disk (Ctrl+S, or autosave)" : "Everything is saved"}>
        {dirty ? <CloudUpload size={13} /> : <CloudCheck size={13} />}
        <span className="save-state-text">{dirty ? "Unsaved changes" : "All changes saved"}</span>
      </span>
      <button
        type="button"
        className="global-search"
        title="Search entities, assets, panels and settings (Ctrl+F)"
        onClick={() => window.dispatchEvent(new CustomEvent("editor-quick-search"))}
      >
        <Search size={12} />
        <span className="global-search-text">Search assets, entities, settings</span>
        <kbd>Ctrl F</kbd>
      </button>
      <GitIndicator />
      <McpIndicator />
      <ProcessingIndicator />
      <button type="button" className="bar-gear" title="Project settings" onClick={() => openPanel("projectSettings")}>
        <Settings size={14} />
      </button>
      <WindowControls />
    </div>
  );
}
