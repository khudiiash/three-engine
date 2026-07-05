import { create } from "zustand";
import { engine } from "../engineInstance.js";
import { useSceneStore } from "../store/sceneStore.js";
import { useSelectionStore } from "../store/selectionStore.js";

const MAX_HISTORY = 100;

/**
 * Every editor mutation goes through here so undo/redo history is reliable.
 * A command is { label, do(), undo() }; do() is called on execute and redo.
 */
class CommandBus {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
  }

  execute(command) {
    command.do();
    this.undoStack.push(command);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.#afterMutation();
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.#afterMutation();
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return;
    command.do();
    this.undoStack.push(command);
    this.#afterMutation();
  }

  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.#syncHistoryState();
  }

  #afterMutation() {
    useSceneStore.getState().refresh();
    useSceneStore.getState().markDirty();
    useSelectionStore.getState().prune(new Set(engine.entities.keys()));
    this.#syncHistoryState();
  }

  #syncHistoryState() {
    useHistoryStore.setState({
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
    });
  }
}

/** UI-facing mirror of history state (menu enablement). */
export const useHistoryStore = create(() => ({
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
}));

export const commandBus = new CommandBus();
