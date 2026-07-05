import { create } from "zustand";

let nextId = 1;
const MAX_ENTRIES = 500;

export const useConsoleStore = create((set) => ({
  entries: [],

  push(level, message) {
    set((state) => {
      const entries = [...state.entries, { id: nextId++, level, message, time: new Date() }];
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      return { entries };
    });
  },

  clear() {
    set({ entries: [] });
  },
}));

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

/** Tee console.log/warn/error and window errors into the Console panel. */
export function installConsoleCapture() {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const message = format(args);
      try {
        original(message);
      } catch {
        console.error("Error formatting console message:", args);
      }
      useConsoleStore.getState().push(level === "info" ? "log" : level, message);
    };
  }
  window.addEventListener("error", (e) => {
    useConsoleStore.getState().push("error", e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    useConsoleStore.getState().push("error", `Unhandled rejection: ${e.reason?.message ?? e.reason}`);
  });
}
