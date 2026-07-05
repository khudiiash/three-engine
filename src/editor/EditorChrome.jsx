import { useEffect } from "react";
import { MenuBar } from "./MenuBar.jsx";
import {
  copyEntities,
  cutEntities,
  pasteEntities,
  duplicateSelection,
  deleteSelection,
} from "./clipboard.js";
import { openScene, saveScene, restoreLastScene, hasScenePath } from "./sceneIO.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { useProjectStore } from "./store/projectStore.js";
import { engine, ensureEngine } from "./engineInstance.js";
import { toggle as togglePlay } from "./playMode.js";
import { commandBus } from "./commands/CommandBus.js";
import { getProjectSettings, applyProjectSettings } from "./projectSettings.js";

/**
 * Editor "chrome": the menu bar, scene restore on first mount, keyboard
 * shortcuts, and autosave timer. Kept in its own module so that its chain
 * of eager imports (`MenuBar → clipboard → entityCommands → engine/index.js`)
 * doesn't enter the boot module graph — it's lazy-loaded once the project
 * hub has been dismissed.
 */
export function EditorChrome() {
  useEffect(() => {
    let autosave = null;
    ensureEngine().then(async () => {
      // Only restore / build a default scene once per editor lifetime.
      if (!sceneBooted) {
        sceneBooted = true;
        // Enabled modules must register their components BEFORE the scene
        // deserializes, or module components load as inert "missing" data.
        const { syncProjectModules } = await import("./modules.js");
        await syncProjectModules().catch((err) => console.error(`Modules: ${err.message ?? err}`));
        // Apply saved input config (if any) before scene load so scripts
        // can read bindings during their first onUpdate.
        const { useProjectStore } = await import("./store/projectStore.js");
        const input = useProjectStore.getState().projectMeta?.input;
        if (input) engine.applyInput(input);
        const restored = await restoreLastScene();
        // If nothing can be restored, leave the engine empty — the user picks
        // the opening scene via File → New Scene or Open Scene…. Auto-creating
        // a scene here silently spawned stray "Main 1.scene"/"Main 2.scene"
        // files whenever the saved main/last scene was missing or moved.
        void restored;
        console.log("Editor ready");
      }
      // Project settings (script hot reload, pixel ratio cap, grid/snap…)
      // apply once the engine exists.
      applyProjectSettings().catch((err) => console.warn(`Project settings: ${err}`));

      // Autosave: dirty scenes write themselves on the configured interval
      // (when not playing and when there's a destination on disk). A 1s tick
      // checks elapsed time so interval changes apply without a restart.
      let lastSave = performance.now();
      autosave = setInterval(() => {
        const seconds = getProjectSettings().editor.autosaveSeconds;
        if (!seconds) return; // 0 = disabled
        if (performance.now() - lastSave < seconds * 1000) return;
        lastSave = performance.now();
        const canPersist = hasScenePath() || useProjectStore.getState().rootPath;
        if (canPersist && useSceneStore.getState().dirty && !engine.playing) saveScene();
      }, 1000);
    });

    const onKeyDown = (e) => {
      const inField = e.target.closest?.("input, textarea, select, [contenteditable]");
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveScene({ saveAs: e.shiftKey });
        return;
      }
      if (ctrl && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openScene();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "p") {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (inField) return;
      // The shader graph has its own delete/selection handling.
      if (e.target.closest?.(".react-flow")) return;

      const selection = useSelectionStore.getState().ids;
      if (ctrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? commandBus.redo() : commandBus.undo();
      } else if (ctrl && e.key.toLowerCase() === "y") {
        e.preventDefault();
        commandBus.redo();
      } else if (ctrl && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
      } else if (ctrl && e.key.toLowerCase() === "c") {
        if (selection.length) copyEntities(selection);
      } else if (ctrl && e.key.toLowerCase() === "x") {
        if (selection.length) cutEntities(selection);
      } else if (ctrl && e.key.toLowerCase() === "v") {
        // Paste as sibling of the first selected entity, or at scene root.
        const first = selection[0];
        const parentId = first ? (useSceneStore.getState().entities[first]?.parentId ?? null) : null;
        pasteEntities(parentId);
      } else if (e.key === "Delete") {
        deleteSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (autosave) clearInterval(autosave);
    };
  }, []);

  return <MenuBar />;
}

let sceneBooted = false;
