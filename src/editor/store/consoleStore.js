import { create } from "zustand";
import { vmSingleton } from "../singleton.js";

// VM-wide alongside the store itself: a second copy of this module with its own
// counter would hand React duplicate keys for entries in one shared list.
const ids = vmSingleton("consoleStoreIds", () => ({ next: 1 }));
const MAX_ENTRIES = 500;

// Entries queued by push() (the console tee's hot path) but not yet committed
// to the store, plus whether a flush is already scheduled. Both are VM-wide
// for the same reason `ids` is: a duplicated module copy must share one queue
// and one flush loop, not fork them.
const pending = vmSingleton("consoleStorePending", () => []);
const flushState = vmSingleton("consoleStoreFlushState", () => ({ scheduled: false }));

const scheduleTick =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 50);

function scheduleFlush() {
  if (flushState.scheduled) return;
  flushState.scheduled = true;
  scheduleTick(flushPending);
}

// Drains everything push() queued since the last flush into ONE store commit.
// GI logs hundreds of lines within a single boot-time tick; without this, each
// line was its own synchronous `set()` (a React re-render) on top of its own
// eager format() call. Coalescing to at most one commit per animation frame
// turns a burst of N lines into O(1) re-renders instead of O(N).
function flushPending() {
  flushState.scheduled = false;
  if (pending.length === 0) return;
  const batch = pending.splice(0, pending.length);
  const state = useConsoleStore.getState();
  let entries = state.entries.concat(batch);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
  let unreadErrors = state.unreadErrors;
  for (const entry of batch) if (entry.level === "error") unreadErrors++;
  useConsoleStore.setState({ entries, unreadErrors });
}

// `args` is kept as the raw, unformatted console arguments. Formatting
// (JSON.stringify etc.) is real work, and doing it here — on every log line,
// whether or not anyone ever looks at it — was the other half of the boot
// stall. `message` defers it to whichever consumer looks at the entry first
// (the panel rendering a visible row, or the `console.read` op), and caches
// the result so scrolling past it twice doesn't format it twice.
function makeEntry(level, args, time) {
  let cached;
  return {
    id: ids.next++,
    level,
    time,
    get message() {
      if (cached === undefined) cached = format(args);
      return cached;
    },
  };
}

export const useConsoleStore = vmSingleton("consoleStore", () => create(() => ({
  entries: [],
  // Number of error-level entries the user hasn't seen yet. Incremented when a
  // new error lands, reset to zero when the Console panel becomes active (i.e.
  // the user opens it) or when they hit Clear. The tab renderer reads this to
  // draw the red-dot indicator.
  unreadErrors: 0,

  // Called by the console tee. Must stay O(1) — no formatting, no store
  // commit — see scheduleFlush/flushPending above for why.
  push(level, args) {
    pending.push(makeEntry(level, args, new Date()));
    scheduleFlush();
  },

  clear() {
    pending.length = 0;
    flushState.scheduled = false;
    useConsoleStore.setState({ entries: [], unreadErrors: 0 });
  },

  /** Called by the editor shell when the Console tab becomes the active tab. */
  markConsoleRead() {
    useConsoleStore.setState({ unreadErrors: 0 });
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
      try {
        // The ORIGINAL arguments, not a flattened string: devtools then
        // reports each line's real call site and keeps objects inspectable.
        // Logging a formatted copy instead made every line in the browser
        // console read as `consoleStore.js:<line>`, which hid the origin of
        // exactly the messages someone opens devtools to trace.
        original(...args);
      } catch {
        // format() is the expensive path (JSON.stringify attempts); it's
        // only worth paying for on this rare fallback, when the real
        // console itself couldn't take the raw args.
        try {
          original(format(args));
        } catch {
          // args are pathological even as a string — nothing left to try.
        }
      }
      useConsoleStore.getState().push(level === "info" ? "log" : level, args);
    };
  }
  window.addEventListener("error", (e) => {
    useConsoleStore.getState().push("error", [`${e.message}${errorDetail(e.error, e)}`]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const head = reason?.message ?? reason;
    useConsoleStore.getState().push("error", [`Unhandled rejection: ${head}${errorDetail(reason, null)}`]);
  });
}
