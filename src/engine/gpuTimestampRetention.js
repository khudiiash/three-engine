// Three stores frame-qualified timestamp UIDs forever. Consumers read the
// completed resolve, then keep their own summaries/history. Retain eight full
// query-pool capacities: 8,192 entries per installed WebGPU pool, not a session
// of strings. Never change totals, frames, pending queries, or Map identity.
export const GPU_TIMESTAMP_RETAINED_BATCHES = 8;

const backends = new WeakSet();
const pools = new WeakSet();

function installPool(pool) {
  if (!pool || pools.has(pool) || typeof pool.resolveQueriesAsync !== "function" ||
      !(pool.timestamps instanceof Map) || !(pool.queryOffsets instanceof Map) ||
      !Number.isFinite(pool.maxQueries) || pool.maxQueries < 2) return;
  const original = pool.resolveQueriesAsync;
  pool.resolveQueriesAsync = function (...args) {
    const timestamps = this.timestamps;
    const previousFrames = this.frames;
    // Concurrent resolves join the existing read. Its owning call performs
    // retention; a failed/no-op read must preserve the last valid results.
    const keys = this.trackTimestamp && !this.isDisposed && !this.pendingResolve &&
      this.currentQueryIndex > 0 && this.resultBuffer?.mapState === "unmapped"
      ? [...this.queryOffsets.keys()] : null;
    const result = original.apply(this, args);
    if (!keys) return result;
    return result.then((duration) => {
      // Installed Three assigns a NEW frames array only after a successful
      // map/read/unmap. A failed read returns lastValue with the old array.
      if (this.isDisposed || this.frames === previousFrames || this.timestamps !== timestamps) return duration;
      // Refresh repeated UIDs too. Numeric frame order is not completion
      // order (isolated profilers can resolve repeatedly in one frame).
      for (const key of keys) {
        if (!timestamps.has(key)) continue;
        const value = timestamps.get(key);
        timestamps.delete(key);
        timestamps.set(key, value);
      }
      const limit = Math.max(keys.length, Math.floor(this.maxQueries / 2) * GPU_TIMESTAMP_RETAINED_BATCHES);
      const oldest = timestamps.keys();
      while (timestamps.size > limit) timestamps.delete(oldest.next().value);
      return duration;
    });
  };
  pools.add(pool);
}

/** Called from Engine's timestamp resolution path. Pools are lazy, so wrap
 * the backend entry point once and discover them at each actual resolve. This
 * also covers direct renderer resolves while the engine's loop is stopped. */
export function installGpuTimestampRetention(renderer) {
  const backend = renderer?.backend;
  if (!backend?.isWebGPUBackend || backends.has(backend) ||
      typeof backend.resolveTimestampsAsync !== "function") return;
  const original = backend.resolveTimestampsAsync;
  backend.resolveTimestampsAsync = function (type = "render", ...args) {
    installPool(this.timestampQueryPool?.[type]);
    return original.call(this, type, ...args);
  };
  backends.add(backend);
}
