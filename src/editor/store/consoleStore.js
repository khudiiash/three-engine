import { create } from "zustand";
import { vmSingleton } from "../singleton.js";

// VM-wide alongside the store itself: a second copy of this module with its own
// counter would hand React duplicate keys for entries in one shared list.
const ids = vmSingleton("consoleStoreIds", () => ({ next: 1 }));
const MAX_ENTRIES = 500;
/** How far back an identical message folds into its earlier entry. */
const REPEAT_WINDOW = 48;

export const useConsoleStore = vmSingleton("consoleStore", () => create((set) => ({
  entries: [],
  // Number of error-level entries the user hasn't seen yet. Incremented when a
  // new error lands, reset to zero when the Console panel becomes active (i.e.
  // the user opens it) or when they hit Clear. The tab renderer reads this to
  // draw the red-dot indicator.
  unreadErrors: 0,

  push(level, message) {
    set((state) => {
      // A REPEAT COLLAPSES INTO ITS FIRST OCCURRENCE (2026-09-05). A WebGPU
      // fault logs "invalid due to a PREVIOUS error" for every dispatch that
      // touches the broken binding — ~700 lines a second across a few
      // alternating texts — and the one line that named the previous error
      // was pushed out of this 500-entry ring within a second of appearing.
      // Bumping a count on the recent identical entry keeps the ring for the
      // messages that differ, which is what a reader is looking for.
      const recent = state.entries;
      for (let i = recent.length - 1, stop = Math.max(0, recent.length - REPEAT_WINDOW); i >= stop; i--) {
        const prior = recent[i];
        if (prior.level !== level || prior.message !== message) continue;
        const entries = recent.slice();
        entries[i] = { ...prior, count: (prior.count ?? 1) + 1, time: new Date() };
        return {
          entries,
          unreadErrors: level === "error" ? state.unreadErrors + 1 : state.unreadErrors,
        };
      }
      const entries = [...state.entries, { id: ids.next++, level, message, time: new Date() }];
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      return {
        entries,
        unreadErrors: level === "error" ? state.unreadErrors + 1 : state.unreadErrors,
      };
    });
  },

  clear() {
    set({ entries: [], unreadErrors: 0 });
  },

  /** Called by the editor shell when the Console tab becomes the active tab. */
  markConsoleRead() {
    set({ unreadErrors: 0 });
  },
})));

function format(args) {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      // String(a) and JSON.stringify(a) both throw on pathological inputs:
      // circular refs, objects with a throwing toString, BigInt values, etc.
      // Try in increasing-cost order and fall back to a literal that never
      // throws, so a single bad log call can't kill the console capture.
      try {
        return JSON.stringify(a);
      } catch {
        try {
          return String(a);
        } catch {
          return Object.prototype.toString.call(a);
        }
      }
    })
    .join(" ");
}

/**
 * Where an uncaught error actually came from, as a few source frames.
 *
 * An `ErrorEvent` carries the throwing FRAME, and dropping it is what makes a
 * message like "Cannot read properties of undefined (reading 'M_ID')"
 * unactionable: the property name is data (an asset or material name reaching a
 * computed lookup), so it appears nowhere in the source and the message alone
 * cannot be traced to a call site. `filename:line` is kept as a fallback for
 * cross-origin errors, whose stack is stripped to "Script error".
 */
function errorDetail(error, event) {
  const stack = typeof error?.stack === "string" ? error.stack : "";
  // Chrome repeats the message as the stack's first line; V8-style frames
  // start at the second. Firefox omits it, so only drop a real duplicate.
  const frames = stack
    .split("\n")
    .filter((line) => /\s+at\s|@/.test(line))
    .slice(0, 6)
    .join("\n");
  if (frames) return `\n${frames}`;
  const where = event?.filename
    ? `\n    at ${event.filename}:${event.lineno ?? "?"}:${event.colno ?? "?"}`
    : "";
  return where;
}

/** Tee console.log/warn/error and window errors into the Console panel. */
export function installConsoleCapture() {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const message = format(args);
      try {
        // The ORIGINAL arguments, not the flattened string: devtools then
        // reports each line's real call site and keeps objects inspectable.
        // Logging the formatted copy instead made every line in the browser
        // console read as `consoleStore.js:<line>`, which hid the origin of
        // exactly the messages someone opens devtools to trace.
        original(...args);
      } catch {
        original(message);
      }
      useConsoleStore.getState().push(level === "info" ? "log" : level, message);
    };
  }
  window.addEventListener("error", (e) => {
    useConsoleStore.getState().push("error", `${e.message}${errorDetail(e.error, e)}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const head = reason?.message ?? reason;
    useConsoleStore.getState().push("error", `Unhandled rejection: ${head}${errorDetail(reason, null)}`);
  });
}
