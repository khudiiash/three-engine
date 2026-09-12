// Keep Three's per-node compute passes, timestamps and update lifecycle, but
// submit adjacent command buffers together. A CPU queue write is a boundary:
// moving it before an earlier dispatch would make that dispatch read the NEW
// uniform/storage data. No commands cross a write or a completion fence.
const installed = new WeakMap();
const queueBoundaries = [
  "writeBuffer", "writeTexture", "copyExternalImageToTexture", "onSubmittedWorkDone",
];
const resourceBoundaries = ["destroyAttribute", "destroyUniformBuffer", "destroyTexture"];
const readbackBoundaries = ["getArrayBufferAsync", "copyTextureToBuffer"];

function install(renderer) {
  const backend = renderer?.backend;
  const queue = backend?.device?.queue;
  if (!backend?.isWebGPUBackend || typeof queue?.submit !== "function") return null;
  let state = installed.get(queue);
  if (state) {
    backend.__giComputeSubmitStats = state.stats;
    return state;
  }

  const stats = {
    scopes: 0, requestedSubmits: 0, actualSubmits: 0, savedSubmits: 0,
    commandBuffers: 0, maxBatch: 0, writes: 0, fences: 0,
    enabled: true, flushes: {}, flushErrors: 0,
  };
  const rawSubmit = queue.submit;
  state = { depth: 0, bypass: 0, enabled: true, commands: [], names: [], calls: 0, stats, flush: null };
  const flush = (reason) => {
    if (!state.calls) return;
    const commands = state.commands;
    const names = state.names;
    const calls = state.calls;
    // Detach BEFORE invoking an outer wrapper: it can call a fence itself.
    state.commands = [];
    state.names = [];
    state.calls = 0;
    stats.actualSubmits++;
    stats.savedSubmits += calls - 1;
    stats.maxBatch = Math.max(stats.maxBatch, calls);
    stats.flushes[reason] = (stats.flushes[reason] ?? 0) + 1;
    // Pipeline attribution remains per node in giCompute. Queue observers get
    // the actual group rather than attributing earlier commands to the last
    // kernel that happened to trigger this flush.
    const previousName = globalThis.__giCurrentComputeName;
    const previousNames = globalThis.__giCurrentComputeNames;
    globalThis.__giCurrentComputeName = calls === 1 ? names[0] : "gi:compute batch";
    globalThis.__giCurrentComputeNames = names;
    try {
      return rawSubmit.call(queue, commands);
    } finally {
      globalThis.__giCurrentComputeName = previousName;
      globalThis.__giCurrentComputeNames = previousNames;
    }
  };
  state.flush = flush;

  const replacements = [];
  const replace = (target, key, wrapper) => {
    const original = target[key];
    target[key] = wrapper;
    if (target[key] !== wrapper) throw new Error(`Cannot intercept GPU ${key}`);
    replacements.push({ target, key, original });
  };
  try {
    replace(queue, "submit", function (commands) {
      if (!state.depth || state.bypass) return rawSubmit.call(this, commands);
      stats.requestedSubmits++;
      if (!state.enabled) {
        stats.actualSubmits++;
        if (Array.isArray(commands)) stats.commandBuffers += commands.length;
        stats.maxBatch = Math.max(stats.maxBatch, 1);
        return rawSubmit.call(this, commands);
      }
      // Three reuses ONE module-level submit array and clears its entry on
      // return. Copy the entries now, never retain the caller's array.
      const before = state.commands.length;
      try {
        for (const command of commands) state.commands.push(command);
      } catch (error) {
        state.commands.length = before;
        throw error;
      }
      stats.commandBuffers += state.commands.length - before;
      state.names.push(globalThis.__giCurrentComputeName ?? "gi:unnamed");
      state.calls++;
    });
    for (const key of queueBoundaries) {
      const original = queue[key];
      if (typeof original !== "function") continue;
      replace(queue, key, function (...args) {
        if (state.depth) {
          if (key === "onSubmittedWorkDone") stats.fences++;
          else stats.writes++;
          flush(key);
        }
        return original.apply(this, args);
      });
    }
    // A compute-node update can release an old binding. Work that already
    // used it must reach the queue before Three destroys that GPU resource.
    for (const key of resourceBoundaries) {
      const original = backend[key];
      if (typeof original !== "function") continue;
      replace(backend, key, function (...args) {
        if (state.depth) flush(key);
        return original.apply(this, args);
      });
    }
    // Three starts mapAsync immediately after submitting its readback copy.
    // Flush prior work AND let that copy submit immediately, or mapAsync can
    // map a buffer before the still-deferred GPU copy has ever reached it.
    for (const key of readbackBoundaries) {
      const original = backend[key];
      if (typeof original !== "function") continue;
      replace(backend, key, function (...args) {
        if (!state.depth) return original.apply(this, args);
        flush(key);
        state.bypass++;
        try {
          return original.apply(this, args);
        } finally {
          state.bypass--;
        }
      });
    }
  } catch {
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { target, key, original } = replacements[i];
      target[key] = original;
    }
    return null;
  }
  installed.set(queue, state);
  backend.__giComputeSubmitStats = stats;
  return state;
}

/**
 * Synchronous scope around an existing giCompute array loop. Does not merge
 * compute passes or change dispatch/update order. Nested scopes share the
 * outer batch. `__giComputeSubmitBatch = false` keeps immediate submissions
 * while collecting the same counters for an A/B; no shader rebuild is needed.
 */
export function withGiComputeSubmissionBatch(renderer, callback) {
  const state = install(renderer);
  if (!state) return callback();
  if (state.depth === 0) {
    state.enabled = globalThis.__giComputeSubmitBatch !== false;
    state.stats.enabled = state.enabled;
  }
  state.stats.scopes++;
  state.depth++;
  let failed = false;
  try {
    return callback();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    state.depth--;
    if (state.depth === 0 || failed) {
      try {
        state.flush(failed ? "error" : "scopeEnd");
      } catch (error) {
        state.stats.flushErrors++;
        // Preserve a kernel's original failure; a cleanup error must never
        // replace it (the giCompute finally regression's exact contract).
        if (!failed) throw error;
        state.stats.lastFlushError = String(error?.message ?? error);
      }
    }
  }
}
