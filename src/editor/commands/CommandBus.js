import { create } from "zustand";
import { engine } from "../engineInstance.js";
import { useSceneStore } from "../store/sceneStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { usePrefabStore } from "../store/prefabStore.js";
import { vmSingleton } from "../singleton.js";

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
    this.#afterMutation(command);
  }

  /**
   * Like execute(), but a burst of calls sharing the same `coalesceKey`
   * arriving within `windowMs` of each other collapses into the ONE undo
   * entry already on top of the stack (extended in place to the new end
   * state) instead of minting a new entry per call. `top.coalesceAt` slides
   * forward on every merge, so a continuous multi-second burst (e.g. a
   * script or MCP client calling entity.setTransform once per frame) stays
   * one entry for its whole duration, not one per 300ms slice.
   *
   * For API/MCP-driven per-frame mutations only — the viewport gizmo's own
   * live-drag path is untouched: it calls updateTransform() directly during
   * the drag and only reaches the bus once, via execute(), on pointer-up.
   */
  executeCoalesced(command, coalesceKey, windowMs = 300) {
    const now = performance.now();
    const top = this.undoStack.at(-1);
    if (coalesceKey != null && top?.coalesceKey === coalesceKey && now - (top.coalesceAt ?? -Infinity) <= windowMs) {
      command.do();
      top.after = command.after;
      top.coalesceAt = now;
      this.redoStack.length = 0;
      this.#afterMutation(top);
      return;
    }
    command.coalesceKey = coalesceKey ?? null;
    command.coalesceAt = now;
    this.execute(command);
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.#afterMutation(command);
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return;
    command.do();
    this.undoStack.push(command);
    this.#afterMutation(command);
  }

  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.#syncHistoryState();
  }

  /**
   * Marks a point on the undo stack, to later collapse everything pushed
   * since it into one labelled entry with {@link collapseFrom}. Call this
   * before starting a multi-step operation whose individual steps each push
   * their own command (they still should — a partial failure must still be
   * a real, undoable prefix of what happened).
   */
  markGroup() {
    return this.undoStack.length;
  }

  /**
   * Replaces every entry pushed since `mark` with one entry that does/undoes
   * them as a group, newest-first on undo. Two callers: the `batch` op
   * (`ops/batch.js`, many ops in one MCP round trip) and an AI workflow run
   * (`store/aiStore.js`, many tool calls across a multi-turn agent session) —
   * both want "many mutations, one Ctrl+Z, one label in the Edit menu"
   * instead of making the user press undo once per step or guess when to
   * stop. No-ops (keeps the single inner entry's own label, which is more
   * specific than a group label would be) when zero or one entries were
   * pushed — a run that made one change, or none, has nothing to collapse.
   * Returns how many entries were collapsed.
   */
  collapseFrom(mark, label) {
    const taken = this.undoStack.splice(mark, this.undoStack.length - mark);
    if (taken.length <= 1) {
      this.undoStack.push(...taken);
      return taken.length;
    }
    this.undoStack.push({
      label,
      do: () => {
        for (const command of taken) command.do();
      },
      undo: () => {
        for (let i = taken.length - 1; i >= 0; i--) taken[i].undo();
      },
    });
    // The stack was rewritten directly, so the UI's mirror is stale — it
    // would still offer "Undo <last inner step>", telling the user the wrong
    // thing about what Ctrl+Z does.
    this.#syncHistoryState();
    return taken.length;
  }

  /**
   * `command` (or, for a coalesced merge, the top-of-stack entry it merged
   * into) may declare `transformOnly` + `entityIds`: a command that only
   * moved/rotated/scaled entities, never touching the hierarchy, tags or
   * components. For those we skip the whole-scene mirror rebuild — which
   * replaces the store's entity map and invalidates every React subscriber —
   * in favor of the lazy per-id updateTransform() the viewport gizmo already
   * uses for live drags. Structural commands (create/delete/reparent/rename/
   * component edits) still take the full refresh(), same as before.
   */
  #afterMutation(command) {
    if (command?.transformOnly && command.entityIds?.length) {
      useSceneStore.getState().updateTransform(command.entityIds);
    } else {
      useSceneStore.getState().refresh();
    }
    useSceneStore.getState().markDirty();
    // In Prefab Mode the edit belongs to the staged prefab, not the scene.
    // (No-op when no prefab is staged.)
    usePrefabStore.getState().markStageDirty();
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
export const useHistoryStore = vmSingleton("historyStore", () =>
  create(() => ({
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
  })),
);

/**
 * VM-wide, not merely module-wide. A second CommandBus (from an HMR
 * re-evaluation, or Vite's `?t=` URL duplicate) splits the editor in half: the
 * newer bus mutates the engine and refreshes a store the mounted UI is not
 * watching, so edits land on disk but never on screen. See `singleton.js`.
 */
export const commandBus = vmSingleton("commandBus", () => new CommandBus());
