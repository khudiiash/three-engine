import { useState } from "react";
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
import { newScene, openScene, saveScene } from "./sceneIO.js";
import { useProjectStore } from "./store/projectStore.js";
import { openPanel, resetLayout } from "./EditorShell.jsx";

export function MenuBar() {
  const [openMenu, setOpenMenu] = useState(null);
  const history = useHistoryStore();
  const selection = useSelectionStore((s) => s.ids);
  const sceneName = useSceneStore((s) => s.sceneName);
  const dirty = useSceneStore((s) => s.dirty);

  const menus = {
    File: [
      { label: "New Scene", action: () => newScene() },
      { label: "Open Scene…", shortcut: "Ctrl+O", action: () => openScene() },
      { separator: true },
      { label: "Save Scene", shortcut: "Ctrl+S", action: () => saveScene() },
      { label: "Save Scene As…", action: () => saveScene({ saveAs: true }) },
      { separator: true },
      { label: "Open Project Folder…", action: () => useProjectStore.getState().openFolder() },
      { separator: true },
      { label: "Export Game…", action: () => import("./exportGame.js").then((m) => m.exportGame()) },
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
        label: "Delete",
        shortcut: "Del",
        disabled: !selection.length,
        action: () => deleteSelection(),
      },
    ],
    Window: [
      { label: "Viewport", action: () => openPanel("viewport") },
      { label: "Hierarchy", action: () => openPanel("hierarchy") },
      { label: "Inspector", action: () => openPanel("inspector") },
      { label: "Assets", action: () => openPanel("assets") },
      { label: "Console", action: () => openPanel("console") },
      { separator: true },
      { label: "Shader Graph", action: () => openPanel("shaderGraph") },
      { label: "Particles", action: () => openPanel("particles") },
      { label: "Material", action: () => openPanel("material") },
      { label: "Animator", action: () => openPanel("animator") },
      { separator: true },
      { label: "Scene Settings", action: () => openPanel("sceneSettings") },
      { label: "Project Settings", action: () => openPanel("projectSettings") },
      { label: "Modules", action: () => openPanel("modules") },
      { label: "Input", action: () => openPanel("input") },
      { separator: true },
      { label: "Reset Layout", action: () => resetLayout() },
    ],
  };

  const runItem = (item) => {
    setOpenMenu(null);
    item.action();
  };

  return (
    <div className="menu-bar">
      {Object.entries(menus).map(([name, items]) => (
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
                    key={item.label}
                    className="dropdown-item"
                    disabled={item.disabled}
                    onClick={() => runItem(item)}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
      {openMenu && <div className="dropdown-overlay" onClick={() => setOpenMenu(null)} />}
      <div className="menu-title">
        {sceneName}
        {dirty ? " •" : ""} — Three Engine
      </div>
    </div>
  );
}
