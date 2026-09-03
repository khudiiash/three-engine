import test from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= globalThis;

const files = new Map([
  ["bulk-fixture-a.geom", new Uint8Array([1, 2, 3, 4, 5])],
  ["ignored-texture.png", new Uint8Array([137, 80, 78, 71])],
  ["ignored-texture.png.basis", new Uint8Array([115, 66, 19])],
  ["bulk-fixture-b.mat", new TextEncoder().encode('{"color":"#123456"}')],
]);
const calls = [];

function makePackage(paths) {
  const headerLength = 8 + paths.length * 8;
  const total = paths.reduce((sum, path) => {
    const bytes = files.get(path);
    return sum + (bytes ? (bytes.byteLength + 3) & ~3 : 0);
  }, headerLength);
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode("BPK1"), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, paths.length, true);
  let payload = headerLength;
  paths.forEach((path, index) => {
    const bytes = files.get(path);
    if (!bytes) return;
    view.setUint32(8 + index * 8, 1, true);
    view.setUint32(12 + index * 8, bytes.byteLength, true);
    out.set(bytes, payload);
    payload += (bytes.byteLength + 3) & ~3;
  });
  return out.buffer;
}

globalThis.__TAURI_INTERNALS__ = {
  async invoke(command, args = {}) {
    calls.push({ command, args });
    if (command === "read_binary_files") return makePackage(args.paths);
    if (command === "read_binary_file") {
      const bytes = files.get(args.path);
      return bytes?.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) ?? null;
    }
    throw new Error(`unexpected command ${command}`);
  },
};

const { preloadAssetBinaries, readAssetBinary, invalidateBlobUrl } = await import(
  `../src/editor/assetLoader.js?asset-preload-test=${Date.now()}`
);

test("bulk asset preload includes texture payloads and returns zero-copy views", async () => {
  const loaded = await preloadAssetBinaries([
    "bulk-fixture-a.geom",
    "ignored-texture.png",
    "bulk-fixture-b.mat",
    "bulk-fixture-a.geom",
  ]);
  assert.equal(loaded, 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "read_binary_files");
  assert.deepEqual(calls[0].args.paths, [
    "bulk-fixture-a.geom",
    "ignored-texture.png",
    "ignored-texture.png.basis",
    "bulk-fixture-b.mat",
  ]);

  const geometry = await readAssetBinary("bulk-fixture-a.geom");
  const material = await readAssetBinary("bulk-fixture-b.mat");
  assert.ok(geometry instanceof Uint8Array);
  assert.ok(material instanceof Uint8Array);
  assert.deepEqual([...geometry], [1, 2, 3, 4, 5]);
  assert.equal(new TextDecoder().decode(material), '{"color":"#123456"}');
  assert.equal(geometry.buffer, material.buffer, "both cached assets retain one package buffer");
  assert.equal(calls.length, 1, "cache hits must not cross IPC again");
});

test("asset invalidation removes only the overwritten packed entry", async () => {
  invalidateBlobUrl("bulk-fixture-a.geom");
  const geometry = await readAssetBinary("bulk-fixture-a.geom");
  assert.ok(geometry instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(geometry)], [1, 2, 3, 4, 5]);
  assert.equal(calls.at(-1).command, "read_binary_file");

  const material = await readAssetBinary("bulk-fixture-b.mat");
  assert.ok(material instanceof Uint8Array);
  assert.equal(calls.filter(({ command }) => command === "read_binary_file").length, 1);
});
