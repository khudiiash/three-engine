import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Backend from "../node_modules/three/src/renderers/common/Backend.js";
import WebGPUTimestampQueryPool from "../node_modules/three/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js";
import { GPU_TIMESTAMP_RETAINED_BATCHES, installGpuTimestampRetention } from "../src/engine/gpuTimestampRetention.js";

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 512 };
globalThis.GPUMapMode ??= { READ: 1 };

// Drive the installed Three resolver, including submit/copy/map, failure
// handling, frames publication and Backend's returned aggregate. Only the
// physical GPU is fake; duplicating the resolver would miss upstream drift.
function fakeDevice() {
  let waitForMap = null;
  let nextMapError = null;
  const stats = { maps: 0, submits: 0 };
  return {
    stats,
    holdNextMap() {
      let release;
      waitForMap = new Promise((resolve) => { release = resolve; });
      return release;
    },
    failNextMap(error) { nextMapError = error; },
    createQuerySet({ count }) {
      return { times: new BigUint64Array(count), destroy() {} };
    },
    createBuffer({ size }) {
      return {
        bytes: new Uint8Array(size), mapState: "unmapped",
        async mapAsync() {
          stats.maps++;
          this.mapState = "pending";
          const wait = waitForMap;
          waitForMap = null;
          if (wait) await wait;
          if (nextMapError) {
            const error = nextMapError;
            nextMapError = null;
            this.mapState = "unmapped";
            throw error;
          }
          this.mapState = "mapped";
        },
        getMappedRange(offset, size) { return this.bytes.buffer.slice(offset, offset + size); },
        unmap() { this.mapState = "unmapped"; },
        destroy() { this.mapState = "unmapped"; },
      };
    },
    createCommandEncoder() {
      const operations = [];
      return {
        resolveQuerySet(set, first, count, target, offset) {
          operations.push(() => target.bytes.set(new Uint8Array(set.times.buffer, first * 8, count * 8), offset));
        },
        copyBufferToBuffer(source, from, target, to, size) {
          operations.push(() => target.bytes.set(source.bytes.subarray(from, from + size), to));
        },
        finish() { return operations; },
      };
    },
    queue: {
      submit(commands) {
        stats.submits++;
        for (const command of commands) for (const operation of command) operation();
      },
    },
  };
}

function fixture({ maxQueries = 2048, install = true } = {}) {
  const device = fakeDevice();
  const backend = new Backend({ trackTimestamp: true });
  backend.isWebGPUBackend = true;
  const renderer = {
    backend, info: { render: {}, compute: {} },
    resolveTimestampsAsync(type) { return backend.resolveTimestampsAsync(type); },
  };
  backend.renderer = renderer;
  const pool = new WebGPUTimestampQueryPool(device, "compute", maxQueries);
  backend.timestampQueryPool.compute = pool;
  if (install) installGpuTimestampRetention(renderer);
  return { device, backend, renderer, pool, limit: maxQueries / 2 * GPU_TIMESTAMP_RETAINED_BATCHES };
}

function allocate(pool, uid, ms = 1) {
  const offset = pool.allocateQueriesForContext(uid);
  assert.notEqual(offset, null, "fixture must not overflow the physical query pool");
  pool.querySet.times[offset] = 100_000_000n;
  pool.querySet.times[offset + 1] = 100_000_000n + BigInt(Math.round(ms * 1e6));
}

test("real resolver remains bounded through 16,000 frame-qualified results; current totals and Map survive", async () => {
  const { renderer, backend, pool, limit } = fixture();
  assert.equal(limit, 8192);
  const timestamps = pool.timestamps;
  for (let frame = 1; frame <= 500; frame++) {
    const keys = Array.from({ length: 32 }, (_, pass) => `c:${pass}:node${pass}:f${frame}`);
    for (let pass = 0; pass < keys.length; pass++) allocate(pool, keys[pass], pass + 1);
    const total = await renderer.resolveTimestampsAsync("compute");
    assert.equal(total, 528);
    assert.equal(renderer.info.compute.timestamp, 528);
    assert.strictEqual(pool.timestamps, timestamps);
    assert.ok(timestamps.size <= limit);
    assert.deepEqual(backend.getTimestampFrames("compute"), [frame]);
    for (let pass = 0; pass < keys.length; pass++) {
      assert.equal(backend.hasTimestampQuery(keys[pass]), true);
      assert.equal(backend.getTimestamp(keys[pass]), pass + 1);
    }
  }
  assert.equal(timestamps.size, limit);
  assert.equal(timestamps.has("c:0:node0:f1"), false);
});

test("completed UIDs retain completion order, including out-of-order frames and repeated UIDs", async () => {
  const { renderer, pool, limit } = fixture({ maxQueries: 16 });
  for (let frame = 1; frame <= 10; frame++) {
    for (let pass = 0; pass < 8; pass++) allocate(pool, `c:${pass}:node:f${frame}`);
    await renderer.resolveTimestampsAsync("compute");
  }
  const repeated = pool.timestamps.keys().next().value;
  const current = [repeated, "c:99:node:f200", "c:100:node:f1"];
  for (let index = 0; index < current.length; index++) allocate(pool, current[index], index + 7);
  assert.equal(await renderer.resolveTimestampsAsync("compute"), 9, "aggregate remains the last frame's duration");
  assert.equal(pool.timestamps.size, limit);
  current.forEach((uid, index) => assert.equal(pool.timestamps.get(uid), index + 7));
  assert.deepEqual([...pool.timestamps.keys()].slice(-3), current);
});

test("pending/coalesced resolves do not prune; newly queued queries survive the previous read", async () => {
  const { renderer, pool, device } = fixture({ maxQueries: 16 });
  allocate(pool, "c:0:node:f1", 3);
  await renderer.resolveTimestampsAsync("compute");
  const previousFrames = pool.frames;
  const releaseMap = device.holdNextMap();
  allocate(pool, "c:0:node:f2", 4);
  const pending = renderer.resolveTimestampsAsync("compute");
  assert.equal(pool.resultBuffer.mapState, "pending");
  allocate(pool, "c:0:node:f3", 5);
  const joined = renderer.resolveTimestampsAsync("compute");
  assert.strictEqual(pool.frames, previousFrames);
  assert.deepEqual([...pool.timestamps], [["c:0:node:f1", 3]]);
  assert.equal(pool.queryOffsets.has("c:0:node:f3"), true);
  releaseMap();
  assert.deepEqual(await Promise.all([pending, joined]), [4, 4]);
  assert.equal(pool.timestamps.get("c:0:node:f2"), 4);
  assert.equal(pool.queryOffsets.has("c:0:node:f3"), true);
  assert.equal(await renderer.resolveTimestampsAsync("compute"), 5);
  assert.equal(pool.timestamps.get("c:0:node:f3"), 5);
  assert.equal(device.stats.maps, 3, "coalesced caller must not create another mapping");
});

test("failed mapping preserves all last successful readings and identity; equal-valued success still prunes", async (t) => {
  t.mock.method(console, "error", () => {});
  const { renderer, pool, device, limit } = fixture({ maxQueries: 16 });
  allocate(pool, "c:0:node:f1", 2);
  await renderer.resolveTimestampsAsync("compute");
  // Also exercise installing against a previously leaking live pool: old
  // timestamps are trimmed only when a new batch has actually succeeded.
  for (let i = 0; i < limit * 2; i++) pool.timestamps.set(`c:${i}:legacy:f0`, 1);
  const timestamps = pool.timestamps;
  const before = [...timestamps];
  const previousFrames = pool.frames;
  device.failNextMap(new Error("device read failed"));
  allocate(pool, "c:0:node:f2", 99);
  assert.equal(await renderer.resolveTimestampsAsync("compute"), 2);
  assert.strictEqual(pool.frames, previousFrames);
  assert.strictEqual(pool.timestamps, timestamps);
  assert.deepEqual([...timestamps], before);
  allocate(pool, "c:0:node:f3", 2);
  assert.equal(await renderer.resolveTimestampsAsync("compute"), 2);
  assert.notStrictEqual(pool.frames, previousFrames);
  assert.equal(timestamps.size, limit);
  assert.equal(timestamps.get("c:0:node:f3"), 2);
});

test("no-op, mapped, disabled and disposed reads retain their last successful values", async () => {
  const { renderer, pool } = fixture({ maxQueries: 16 });
  allocate(pool, "c:0:node:f1", 2);
  await renderer.resolveTimestampsAsync("compute");
  const frames = pool.frames;
  const before = [...pool.timestamps];
  assert.equal(await renderer.resolveTimestampsAsync("compute"), 2);
  allocate(pool, "c:0:node:f2", 7);
  pool.resultBuffer.mapState = "mapped";
  assert.equal(await renderer.resolveTimestampsAsync("compute"), 2);
  assert.equal(pool.queryOffsets.size, 1);
  pool.resultBuffer.mapState = "unmapped";
  pool.trackTimestamp = false;
  assert.equal(await renderer.resolveTimestampsAsync("compute"), 2);
  pool.trackTimestamp = true;
  await pool.dispose();
  assert.equal(await renderer.resolveTimestampsAsync("compute"), 2);
  assert.strictEqual(pool.frames, frames);
  assert.deepEqual([...pool.timestamps], before);
});

test("direct profiler resolves and later-created pools are covered, and installation is idempotent", async () => {
  const { renderer, backend, device, pool } = fixture({ maxQueries: 16 });
  const wrapped = backend.resolveTimestampsAsync;
  installGpuTimestampRetention(renderer);
  assert.strictEqual(backend.resolveTimestampsAsync, wrapped);
  // A stopped-loop profiler can run many resolves within one logical frame.
  for (let pass = 0; pass < 200; pass++) {
    const uid = `c:${pass}:profile:f1`;
    allocate(pool, uid, 0.25);
    assert.equal(await renderer.resolveTimestampsAsync("compute"), 0.25);
    assert.equal(pool.timestamps.get(uid), 0.25);
  }
  assert.ok(pool.timestamps.size <= 64);
  const renderPool = new WebGPUTimestampQueryPool(device, "render", 16);
  backend.timestampQueryPool.render = renderPool;
  for (let frame = 0; frame < 100; frame++) {
    allocate(renderPool, `r:0:main:f${frame}`, 0.5);
    await renderer.resolveTimestampsAsync("render");
  }
  assert.equal(renderPool.timestamps.size, 64);
  assert.equal(pool.timestamps.get("c:199:profile:f1"), 0.25, "render retention must not evict compute results");
});

test("Inspector-style sequential compute/render awaits can read both completed frames", async () => {
  const { renderer, backend, device, pool } = fixture({ maxQueries: 16 });
  const renderPool = new WebGPUTimestampQueryPool(device, "render", 16);
  backend.timestampQueryPool.render = renderPool;
  for (let frame = 0; frame < 100; frame++) {
    allocate(pool, `c:0:compute:f${frame}`, 0.25);
    allocate(renderPool, `r:0:main:f${frame}`, 0.5);
    await renderer.resolveTimestampsAsync("compute");
    await renderer.resolveTimestampsAsync("render");
    assert.deepEqual(backend.getTimestampFrames("compute"), [frame]);
    assert.deepEqual(backend.getTimestampFrames("render"), [frame]);
    assert.equal(backend.getTimestamp(`c:0:compute:f${frame}`), 0.25);
    assert.equal(backend.getTimestamp(`r:0:main:f${frame}`), 0.5);
    if (frame > 0) assert.equal(backend.getTimestamp(`c:0:compute:f${frame - 1}`), 0.25);
  }
});

test("WebGL/unknown backends stay untouched; Engine installs before resolving either pool", () => {
  const backend = { resolveTimestampsAsync() {} };
  const original = backend.resolveTimestampsAsync;
  installGpuTimestampRetention({ backend });
  assert.strictEqual(backend.resolveTimestampsAsync, original);
  const source = fs.readFileSync(new URL("../src/engine/Engine.js", import.meta.url), "utf8");
  const start = source.indexOf("#resolveGpuTimestamps() {");
  const install = source.indexOf("installGpuTimestampRetention(renderer)", start);
  const resolve = source.indexOf('renderer.resolveTimestampsAsync("render")', start);
  assert.ok(start > 0 && install > start && resolve > install);
});
