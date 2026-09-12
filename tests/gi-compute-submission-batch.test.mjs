import assert from "node:assert/strict";
import test from "node:test";
import { withGiComputeSubmissionBatch } from "../src/engine/giComputeSubmissionBatch.js";

function fixture() {
  const events = [];
  const submitted = [];
  const names = [];
  const fence = Promise.resolve("finished");
  const queue = {
    submit(commands) {
      const copy = Array.from(commands);
      events.push(["submit", copy]);
      submitted.push(copy);
      names.push({ name: globalThis.__giCurrentComputeName, names: globalThis.__giCurrentComputeNames });
      for (const command of copy) if (typeof command === "function") command();
    },
    writeBuffer(buffer, offset, value) { events.push(["writeBuffer", offset, value]); buffer.value = value; },
    writeTexture(...args) { events.push(["writeTexture", ...args]); },
    copyExternalImageToTexture(...args) { events.push(["copyExternalImageToTexture", ...args]); },
    onSubmittedWorkDone() { events.push(["fence"]); return fence; },
  };
  const backend = {
    isWebGPUBackend: true,
    device: { queue },
    destroyAttribute(value) { events.push(["destroyAttribute", value]); },
    destroyUniformBuffer(value) { events.push(["destroyUniformBuffer", value]); },
    destroyTexture(value) { events.push(["destroyTexture", value]); },
  };
  return { renderer: { backend }, queue, backend, events, submitted, names, fence };
}

test("adjacent submissions retain command order and copy Three's reusable submit list", () => {
  const f = fixture();
  const list = ["first"];
  const result = withGiComputeSubmissionBatch(f.renderer, () => {
    f.queue.submit(list);
    list[0] = "second";
    f.queue.submit(list);
    list[0] = null;
    assert.equal(f.submitted.length, 0);
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(f.submitted, [["first", "second"]]);
  assert.equal(f.backend.__giComputeSubmitStats.requestedSubmits, 2);
  assert.equal(f.backend.__giComputeSubmitStats.actualSubmits, 1);
  assert.equal(f.backend.__giComputeSubmitStats.savedSubmits, 1);
  assert.equal(f.backend.__giComputeSubmitStats.commandBuffers, 2);
  assert.equal(f.backend.__giComputeSubmitStats.maxBatch, 2);
  f.queue.submit(["outside"]);
  assert.deepEqual(f.submitted[1], ["outside"], "scope ends before ordinary rendering");
});

test("a shared uniform buffer overwrite stays AFTER the dispatch that reads its old value", () => {
  const f = fixture();
  const buffer = { value: 7 };
  const read = [];
  withGiComputeSubmissionBatch(f.renderer, () => {
    f.queue.submit([() => read.push(buffer.value)]);
    f.queue.writeBuffer(buffer, 0, 13);
    f.queue.submit([() => read.push(buffer.value)]);
  });
  assert.deepEqual(read, [7, 13]);
  assert.deepEqual(f.events.map(event => event[0]), ["submit", "writeBuffer", "submit"]);
  assert.equal(f.backend.__giComputeSubmitStats.flushes.writeBuffer, 1);
  assert.equal(f.backend.__giComputeSubmitStats.writes, 1);
  assert.equal(f.backend.__giComputeSubmitStats.commandBuffers, 2);
});

test("texture uploads, external copies and completion fences flush pending work first", () => {
  const f = fixture();
  withGiComputeSubmissionBatch(f.renderer, () => {
    f.queue.submit(["before texture"]);
    f.queue.writeTexture("image", "bytes", "layout", "size");
    f.queue.submit(["before external"]);
    f.queue.copyExternalImageToTexture("source", "target", "size");
    f.queue.submit(["before fence"]);
    assert.equal(f.queue.onSubmittedWorkDone(), f.fence);
  });
  assert.deepEqual(f.events.map(event => event[0]), [
    "submit", "writeTexture", "submit", "copyExternalImageToTexture", "submit", "fence",
  ]);
  assert.equal(f.backend.__giComputeSubmitStats.writes, 2);
  assert.equal(f.backend.__giComputeSubmitStats.fences, 1);
});

test("resource disposal never destroys a buffer or texture before its queued dispatch", () => {
  const f = fixture();
  withGiComputeSubmissionBatch(f.renderer, () => {
    for (const name of ["destroyAttribute", "destroyUniformBuffer", "destroyTexture"]) {
      f.queue.submit([name]);
      f.backend[name]("resource");
    }
  });
  assert.deepEqual(f.events.map(event => event[0]), [
    "submit", "destroyAttribute", "submit", "destroyUniformBuffer", "submit", "destroyTexture",
  ]);
});

test("readback copies submit before Three starts mapAsync", () => {
  const f = fixture();
  for (const key of ["getArrayBufferAsync", "copyTextureToBuffer"]) {
    f.backend[key] = () => {
      f.queue.submit([`copy:${key}`]);
      f.events.push(["mapAsync", key]);
      return f.fence;
    };
  }
  withGiComputeSubmissionBatch(f.renderer, () => {
    f.queue.submit(["compute"]);
    assert.equal(f.backend.getArrayBufferAsync(), f.fence);
    f.queue.submit(["more compute"]);
    assert.equal(f.backend.copyTextureToBuffer(), f.fence);
  });
  assert.deepEqual(f.events.map(event => event[0]), [
    "submit", "submit", "mapAsync", "submit", "submit", "mapAsync",
  ]);
  assert.deepEqual(f.submitted, [["compute"], ["copy:getArrayBufferAsync"], ["more compute"], ["copy:copyTextureToBuffer"]]);
});

test("nested scopes share the outer batch and preserve operation order", () => {
  const f = fixture();
  withGiComputeSubmissionBatch(f.renderer, () => {
    f.queue.submit(["a"]);
    withGiComputeSubmissionBatch(f.renderer, () => f.queue.submit(["b"]));
    assert.equal(f.submitted.length, 0);
    f.queue.submit(["c"]);
  });
  assert.deepEqual(f.submitted, [["a", "b", "c"]]);
});

test("a kernel error flushes prior commands and leaves the next scope usable", () => {
  const f = fixture();
  const boom = new Error("kernel failed");
  assert.throws(() => withGiComputeSubmissionBatch(f.renderer, () => {
    f.queue.submit(["before error"]);
    throw boom;
  }), error => error === boom);
  assert.deepEqual(f.submitted, [["before error"]]);
  withGiComputeSubmissionBatch(f.renderer, () => f.queue.submit(["after error"]));
  assert.deepEqual(f.submitted[1], ["after error"]);
});

test("a nested error flushes before its caller handles the failure", () => {
  const f = fixture();
  const boom = new Error("nested failure");
  withGiComputeSubmissionBatch(f.renderer, () => {
    f.queue.submit(["outer"]);
    assert.throws(() => withGiComputeSubmissionBatch(f.renderer, () => {
      f.queue.submit(["inner"]);
      throw boom;
    }), error => error === boom);
    assert.deepEqual(f.submitted, [["outer", "inner"]]);
    f.queue.submit(["recovery"]);
  });
  assert.deepEqual(f.submitted[1], ["recovery"]);
});

test("a cleanup submit failure cannot replace the original kernel failure", () => {
  const f = fixture();
  const submitError = new Error("submit failed");
  f.queue.submit = () => { throw submitError; };
  const kernelError = new Error("kernel failed");
  assert.throws(() => withGiComputeSubmissionBatch(f.renderer, () => {
    f.queue.submit(["queued"]);
    throw kernelError;
  }), error => error === kernelError);
  assert.equal(f.backend.__giComputeSubmitStats.flushErrors, 1);
  assert.equal(f.backend.__giComputeSubmitStats.lastFlushError, "submit failed");
  assert.throws(() => withGiComputeSubmissionBatch(f.renderer, () => {
    f.queue.submit(["queued"]);
  }), error => error === submitError, "a lone submit failure still propagates");
});

test("the live hatch disables batching while preserving baseline counters", () => {
  const f = fixture();
  const old = globalThis.__giComputeSubmitBatch;
  try {
    globalThis.__giComputeSubmitBatch = false;
    withGiComputeSubmissionBatch(f.renderer, () => {
      f.queue.submit(["a"]);
      f.queue.submit(["b"]);
      assert.equal(f.submitted.length, 2);
    });
    assert.equal(f.backend.__giComputeSubmitStats.enabled, false);
    assert.equal(f.backend.__giComputeSubmitStats.requestedSubmits, 2);
    assert.equal(f.backend.__giComputeSubmitStats.actualSubmits, 2);
    globalThis.__giComputeSubmitBatch = true;
    withGiComputeSubmissionBatch(f.renderer, () => {
      f.queue.submit(["c"]);
      f.queue.submit(["d"]);
    });
    assert.deepEqual(f.submitted[2], ["c", "d"]);
  } finally {
    if (old === undefined) delete globalThis.__giComputeSubmitBatch;
    else globalThis.__giComputeSubmitBatch = old;
  }
});

test("queue observers receive grouped names and the current pass name is restored", () => {
  const f = fixture();
  const old = globalThis.__giCurrentComputeName;
  const oldNames = globalThis.__giCurrentComputeNames;
  try {
    withGiComputeSubmissionBatch(f.renderer, () => {
      globalThis.__giCurrentComputeName = "populate";
      f.queue.submit(["a"]);
      globalThis.__giCurrentComputeName = "gather";
      f.queue.submit(["b"]);
    });
    assert.deepEqual(f.names, [{ name: "gi:compute batch", names: ["populate", "gather"] }]);
    assert.equal(globalThis.__giCurrentComputeName, "gather");
    assert.equal(globalThis.__giCurrentComputeNames, oldNames);
  } finally {
    if (old === undefined) delete globalThis.__giCurrentComputeName;
    else globalThis.__giCurrentComputeName = old;
    if (oldNames === undefined) delete globalThis.__giCurrentComputeNames;
    else globalThis.__giCurrentComputeNames = oldNames;
  }
});

test("unsupported renderers take the original callback path", () => {
  for (const renderer of [{}, { backend: { device: { queue: {} } } }, null]) {
    assert.equal(withGiComputeSubmissionBatch(renderer, () => "unchanged"), "unchanged");
  }
});
