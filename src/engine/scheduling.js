/**
 * YIELDING WITHOUT PAYING A FRAME FOR IT.
 *
 * ⚠⚠ THE TRAP THIS MODULE EXISTS TO AVOID, learned twice and expensively
 * (docs/GI_SRC_REBUILD_PLAN.md §13.12, and again in the GI prewarm loop): a
 * `setTimeout(0)` at boot does not cost "a tick", it costs A WHOLE RENDERED
 * FRAME — 200 to 1200 ms while a compile wave is running. A loop that yielded
 * once per item spent **24,468 ms yielding over 10 ms of real work**. So:
 *
 *   1. Never yield per item. Yield on a WALL-CLOCK BUDGET, so the number of
 *      yields is bounded by (total work / budget) instead of by item count.
 *   2. Prefer `scheduler.yield()`, which resumes at the front of the task
 *      queue instead of behind a render. Chromium 129+ has it; the fallback
 *      is a message-channel task, which still beats `setTimeout` (no 4 ms
 *      clamp, no timer-queue starvation behind rAF).
 *   3. A loop short enough to finish inside one budget never yields at all,
 *      so small scenes pay literally nothing.
 *
 * The budget is deliberately ~8 ms: long enough that a 2 s load yields ~250
 * times rather than 3 000, short enough that the UI's own frame still lands
 * inside 16 ms.
 */

/** One frame's worth of work before handing the thread back. */
export const DEFAULT_SLICE_MS = 8;

const hasSchedulerYield = typeof globalThis.scheduler?.yield === "function";

/** A message-channel macrotask: no clamp, and it outranks a timer. */
function channelYield() {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

/**
 * Hand the main thread back once, as cheaply as this host allows.
 * Awaiting this is the ONLY sanctioned way to break up a long synchronous
 * stage; see the header for why `setTimeout` is not.
 */
export function yieldToHost() {
  return hasSchedulerYield ? globalThis.scheduler.yield() : channelYield();
}

/**
 * Run `fn(item)` over `items`, yielding whenever the current slice has run
 * longer than `sliceMs`. Returns the number of yields taken, which is the
 * number to put in a receipt: zero means the loop was never long enough to
 * block, and that is a pass, not a missing measurement.
 *
 *     await sliceLoop(json.entities, (data) => instantiateEntity(engine, data));
 *
 * ⚠ The caller owns re-entrancy. Anything that must not observe a half-built
 * state has to be held across the whole call (scene load holds
 * `batchHierarchy` and `scene.visible`), because between two slices the host
 * runs a full frame with whatever exists so far.
 */
export async function sliceLoop(items, fn, { sliceMs = DEFAULT_SLICE_MS, onYield = null } = {}) {
  let start = performance.now();
  let yields = 0;
  let index = 0;
  for (const item of items) {
    fn(item, index++);
    if (performance.now() - start < sliceMs) continue;
    await yieldToHost();
    yields++;
    onYield?.(index);
    start = performance.now();
  }
  return yields;
}

/**
 * A budgeted queue that drains in the host's idle time and never in a frame.
 *
 * Built for the material-build scheduler (zero-freeze plan unit 2.2): work
 * that MUST happen but must never happen inside a frame the user is
 * interacting with. `requestIdleCallback` alone is not enough — it can starve
 * for seconds under load, and some of this work has a deadline — so the drain
 * takes whichever comes first: an idle callback, or a timer at `maxDelayMs`.
 */
export class BudgetedQueue {
  /**
   * @param {object} options
   * @param {number} options.sliceMs   Work per drain before yielding.
   * @param {number} options.maxDelayMs Longest wait before draining anyway.
   * @param {string} options.name      For the freeze ledger's attribution.
   */
  constructor({ sliceMs = DEFAULT_SLICE_MS, maxDelayMs = 250, name = "queue" } = {}) {
    this.sliceMs = sliceMs;
    this.maxDelayMs = maxDelayMs;
    this.name = name;
    this._items = [];
    this._scheduled = false;
    this._draining = false;
    this._idleHandle = null;
    this._timerHandle = null;
    /** Set true to drain everything on the next turn (a boot wave, a test). */
    this.urgent = false;
    this.drained = 0;
  }

  get size() {
    return this._items.length;
  }

  /** Queue one unit of work. Deduplicated by `key` when one is given. */
  push(job, key = null) {
    if (key != null) {
      const existing = this._items.findIndex((item) => item.key === key);
      if (existing >= 0) {
        this._items[existing].job = job;
        this.#schedule();
        return;
      }
    }
    this._items.push({ job, key });
    this.#schedule();
  }

  #schedule() {
    if (this._scheduled || this._draining || !this._items.length) return;
    this._scheduled = true;
    const run = () => {
      this._scheduled = false;
      if (this._idleHandle != null && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(this._idleHandle);
      }
      clearTimeout(this._timerHandle);
      this._idleHandle = null;
      this._timerHandle = null;
      void this.drain();
    };
    if (typeof requestIdleCallback === "function") {
      this._idleHandle = requestIdleCallback(run, { timeout: this.maxDelayMs });
    }
    this._timerHandle = setTimeout(run, this.maxDelayMs);
  }

  /** Runs jobs until the slice is spent, then reschedules. */
  async drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._items.length) {
        const start = performance.now();
        while (this._items.length && (this.urgent || performance.now() - start < this.sliceMs)) {
          const item = this._items.shift();
          try {
            const result = item.job();
            if (result && typeof result.then === "function") await result;
          } catch (err) {
            console.warn(`[${this.name}] job failed: ${err?.message ?? err}`);
          }
          this.drained++;
        }
        if (!this._items.length) break;
        await yieldToHost();
      }
    } finally {
      this._draining = false;
      this.#schedule();
    }
  }

  /** Empties the queue synchronously — for teardown, not for the hot path. */
  clear() {
    this._items.length = 0;
  }
}
