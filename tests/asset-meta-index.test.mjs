import test from "node:test";
import assert from "node:assert/strict";

/**
 * The lazy on-disk metadata behind `texture?width>1920` and
 * `material?roughness=0` (src/editor/assetMetaIndex.js).
 *
 * Both file reads are injectable, so the whole thing runs here against fake
 * files: no Tauri, no filesystem, and — crucially — a COUNTED read, because
 * the claims worth pinning are all about how little it reads. The batching
 * yields to the event loop, so every assertion is made after awaiting the call.
 *
 * The store this module bumps is a real zustand store; the version counter is
 * what the Assets panel subscribes to, so a batch that lands without bumping it
 * is a search that silently never refills.
 */

const assetMetaIndex = await import("../src/editor/assetMetaIndex.js");
const { ensureAssetMeta, getAssetMeta, inspectAssetMeta, useAssetMetaStore } = assetMetaIndex;

const NEEDS_DIMS = { dims: true, material: false };
const NEEDS_MATERIAL = { dims: false, material: true };
const NEEDS_BOTH = { dims: true, material: true };
const NEEDS_NOTHING = { dims: false, material: false };

/** A PNG head: signature, IHDR, then width/height as big-endian u32. */
function pngHead(width, height) {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

let ticket = 0;
const nextTicket = () => ++ticket;

/**
 * Fake IO over a `{ path: bytes | string }` map, counting every read. A path
 * that is not in the map rejects, which is how an unreadable file is spelled.
 */
function makeIo(files) {
  const reads = [];
  const get = (path) => {
    const value = files[path];
    if (value === undefined) throw new Error(`no such file: ${path}`);
    return value;
  };
  return {
    reads,
    readHead: async (path) => { reads.push(path); return get(path); },
    readText: async (path) => { reads.push(path); return get(path); },
  };
}

const entry = (path, over = {}) => ({
  path,
  name: path.split("/").pop(),
  ext: path.split(".").pop(),
  size: 100,
  modified: 1,
  ...over,
});

// The cache is pruned to whatever pool it was last given, so handing it a pool
// that shares no paths with the test about to run is how it is emptied.
const RESET = [entry("reset/nothing.txt")];
test.beforeEach(() => ensureAssetMeta(RESET, NEEDS_BOTH, nextTicket(), makeIo({})));

test("only the files a query can actually ask about are read", async () => {
  const io = makeIo({
    "a/wall.png": pngHead(2048, 1024),
    "a/wall.mat": JSON.stringify({ roughness: 0.25 }),
  });
  const pool = [
    entry("a/wall.png"),
    entry("a/wall.mat"),
    entry("a/notes.txt"),
    entry("a/rig.glb"),
    entry("a/sky.hdr"),
    entry("a/models", { is_dir: true, ext: "" }),
  ];

  await ensureAssetMeta(pool, NEEDS_DIMS, nextTicket(), io);
  assert.deepEqual(io.reads, ["a/wall.png"], "a width query opens images and nothing else");

  io.reads.length = 0;
  await ensureAssetMeta(pool, NEEDS_MATERIAL, nextTicket(), io);
  assert.deepEqual(io.reads, ["a/wall.mat"], "a material query opens .mat and nothing else");

  io.reads.length = 0;
  await ensureAssetMeta(pool, NEEDS_NOTHING, nextTicket(), io);
  assert.deepEqual(io.reads, [], "a query with no meta-dependent filter reads nothing at all");
});

test("a probed image answers with its pixel size", async () => {
  const io = makeIo({ "a/wall.png": pngHead(2048, 1024) });
  await ensureAssetMeta([entry("a/wall.png")], NEEDS_DIMS, nextTicket(), io);
  assert.deepEqual(getAssetMeta("a/wall.png"), { width: 2048, height: 1024 });
});

test("a probed material surfaces the scalars a query can compare", async () => {
  const io = makeIo({
    "a/brick.mat": JSON.stringify({ roughness: 0.4, metalness: 1, color: "#ff0000", map: "t/brick.png" }),
    "a/fancy.mat": JSON.stringify({ shaderGraph: { nodes: [] } }),
  });
  await ensureAssetMeta([entry("a/brick.mat"), entry("a/fancy.mat")], NEEDS_MATERIAL, nextTicket(), io);
  assert.deepEqual(getAssetMeta("a/brick.mat"), {
    material: { roughness: 0.4, metalness: 1, color: "#ff0000", graph: false, map: "t/brick.png" },
  });
  const graph = getAssetMeta("a/fancy.mat");
  assert.equal(graph.material.graph, true, "a graph material has no scalars, and `graph` is how a query sees that");
  assert.equal(graph.material.roughness, undefined);
});

test("an atlas answers with the size in its JSON, and one without a size answers nothing", async () => {
  const io = makeIo({
    "a/ui.atlas": JSON.stringify({ size: [4096, 2048] }),
    "a/empty.atlas": JSON.stringify({ frames: [] }),
  });
  await ensureAssetMeta([entry("a/ui.atlas"), entry("a/empty.atlas")], NEEDS_DIMS, nextTicket(), io);
  assert.deepEqual(getAssetMeta("a/ui.atlas"), { atlasSize: [4096, 2048], width: 4096, height: 2048 });
  assert.equal(getAssetMeta("a/empty.atlas"), null, "an atlas with no size is unread, not zero-sized");
});

test("a file that will not read is a negative entry, not a throw, and is not retried", async () => {
  const io = makeIo({
    "a/ok.png": pngHead(64, 64),
    "a/broken.png": new Uint8Array(4),
    "a/junk.mat": "{{{",
  });
  const pool = [entry("a/ok.png"), entry("a/broken.png"), entry("a/junk.mat")];

  await assert.doesNotReject(() => ensureAssetMeta(pool, NEEDS_BOTH, nextTicket(), io));
  assert.deepEqual(getAssetMeta("a/ok.png"), { width: 64, height: 64 });
  assert.equal(getAssetMeta("a/broken.png"), null, "unknown magic is null, and a filter reads null as 'does not match'");
  assert.equal(getAssetMeta("a/junk.mat"), null);
  assert.equal(inspectAssetMeta("a/broken.png").state, "error");
  assert.ok(inspectAssetMeta("a/broken.png").retryAt > Date.now(), "a bad file gets a cooldown, not a re-read per keystroke");

  // The whole point of the negative entry: the next identical search is free.
  io.reads.length = 0;
  await ensureAssetMeta(pool, NEEDS_BOTH, nextTicket(), io);
  assert.deepEqual(io.reads, [], "nothing is re-read while the cooldown holds");
});

test("the second identical search reads nothing, and an edited file is re-read", async () => {
  const io = makeIo({ "a/wall.png": pngHead(512, 512) });
  await ensureAssetMeta([entry("a/wall.png")], NEEDS_DIMS, nextTicket(), io);
  assert.deepEqual(io.reads, ["a/wall.png"]);

  io.reads.length = 0;
  await ensureAssetMeta([entry("a/wall.png")], NEEDS_DIMS, nextTicket(), io);
  assert.deepEqual(io.reads, [], "the cache is keyed on size:modified, so an unchanged file costs a Map read");

  // A texture resized in the editor changes its stamp; the new size has to show
  // up without any explicit invalidation anywhere else.
  const io2 = makeIo({ "a/wall.png": pngHead(1024, 1024) });
  await ensureAssetMeta([entry("a/wall.png", { modified: 2 })], NEEDS_DIMS, nextTicket(), io2);
  assert.deepEqual(io2.reads, ["a/wall.png"]);
  assert.deepEqual(getAssetMeta("a/wall.png"), { width: 1024, height: 1024 });
});

test("the version counter bumps as batches land — it is what refills the grid", async () => {
  // More than one batch (BATCH is 8), so the counter has to move more than once:
  // a single bump at the end would make a long search look like it found nothing
  // until it finished.
  const files = {};
  const pool = [];
  for (let i = 0; i < 20; i++) {
    files[`a/t${i}.png`] = pngHead(16 + i, 16);
    pool.push(entry(`a/t${i}.png`));
  }
  const before = useAssetMetaStore.getState().version;
  await ensureAssetMeta(pool, NEEDS_DIMS, nextTicket(), makeIo(files));
  const after = useAssetMetaStore.getState().version;
  assert.ok(after - before >= 3, `20 files over batches of 8 must bump at least 3 times, saw ${after - before}`);
  assert.deepEqual(getAssetMeta("a/t19.png"), { width: 35, height: 16 });
});

test("a newer ticket stops the older run mid-flight", async () => {
  const files = {};
  const pool = [];
  for (let i = 0; i < 40; i++) {
    files[`b/t${i}.png`] = pngHead(32, 32);
    pool.push(entry(`b/t${i}.png`));
  }
  const stale = nextTicket();
  const fresh = nextTicket();
  // The newer ticket is registered first, so the older run must abandon its
  // remaining batches rather than spend 40 reads on a query the user has left.
  await ensureAssetMeta([entry("b/t0.png")], NEEDS_DIMS, fresh, makeIo({ "b/t0.png": pngHead(32, 32) }));
  const io = makeIo(files);
  await ensureAssetMeta(pool, NEEDS_DIMS, stale, io);
  assert.ok(io.reads.length < 40, `a superseded run must not read the whole pool, read ${io.reads.length}`);
});

test("paths that leave the pool leave the cache", async () => {
  const io = makeIo({ "c/a.png": pngHead(8, 8), "c/b.png": pngHead(16, 16) });
  await ensureAssetMeta([entry("c/a.png"), entry("c/b.png")], NEEDS_DIMS, nextTicket(), io);
  assert.ok(getAssetMeta("c/a.png"));

  // Navigating to a folder that holds only b.png must not keep a.png forever.
  await ensureAssetMeta([entry("c/b.png")], NEEDS_DIMS, nextTicket(), io);
  assert.equal(inspectAssetMeta("c/a.png"), null, "a folder the user left should not keep its probes cached");
  assert.deepEqual(getAssetMeta("c/b.png"), { width: 16, height: 16 });
});

test("without injected deps and without Tauri, it is a no-op rather than a crash", async () => {
  assert.equal(globalThis.__TAURI_INTERNALS__, undefined, "this test only means anything outside the shell");
  await assert.doesNotReject(() => ensureAssetMeta([entry("d/wall.png")], NEEDS_DIMS, nextTicket()));
  assert.equal(getAssetMeta("d/wall.png"), null, "a browser session answers meta filters with nothing, not an error");
});

test("an empty pool and a missing pool are both no-ops", async () => {
  await assert.doesNotReject(() => ensureAssetMeta([], NEEDS_DIMS, nextTicket(), makeIo({})));
  await assert.doesNotReject(() => ensureAssetMeta(null, NEEDS_DIMS, nextTicket(), makeIo({})));
  assert.equal(getAssetMeta("nothing/at/all.png"), null);
  assert.equal(getAssetMeta(undefined), null);
});
