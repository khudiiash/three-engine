import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as THREE from "three/webgpu";
import { BVH_STRATEGY, buildStaticSceneBvhWords } from "../src/modules/gi/dynamicObjects.js";
import {
  STATIC_BVH_HEADER_BYTES,
  createStaticBvhArtifactHeader,
  decodeStaticBvhSceneManifest,
  decodeStaticBvhArtifact,
  encodeStaticBvhArtifact,
  readStaticBvhArtifact,
  staticBvhArtifactRelativePath,
  staticBvhSceneManifestRelativePath,
  staticBvhInputSignature,
  withoutStaticBvhUv,
  writeStaticBvhArtifactAtomic,
} from "../src/modules/gi/staticBvhDiskCache.js";

function item(overrides = {}) {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    index: new Uint16Array([0, 1, 2]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    matrix: new THREE.Matrix4(),
    slot: 7,
    ...overrides,
  };
}

function packedWithUv() {
  return buildStaticSceneBvhWords([item()], BVH_STRATEGY.SAH, { uvs: true });
}

test("persistent signature is content-based and input-complete", async () => {
  const original = item();
  const clone = item({
    positions: original.positions.slice(),
    index: original.index.slice(),
    uvs: original.uvs.slice(),
    matrix: original.matrix.clone(),
  });
  const base = await staticBvhInputSignature([original], { uvs: true, strategy: "sah" });
  assert.equal(await staticBvhInputSignature([clone], { uvs: true, strategy: "sah" }), base);

  const changedPosition = item({ positions: original.positions.slice() });
  changedPosition.positions[0] = 0.125;
  assert.notEqual(await staticBvhInputSignature([changedPosition], { uvs: true }), base);

  const changedIndex = item({ index: new Uint16Array([0, 2, 1]) });
  assert.notEqual(await staticBvhInputSignature([changedIndex], { uvs: true }), base);

  const changedMatrix = item({ matrix: new THREE.Matrix4().makeTranslation(1, 0, 0) });
  assert.notEqual(await staticBvhInputSignature([changedMatrix], { uvs: true }), base);
  assert.notEqual(await staticBvhInputSignature([item({ slot: 8 })], { uvs: true }), base);
  assert.notEqual(await staticBvhInputSignature([original], { uvs: true, strategy: "center" }), base);
  assert.notEqual(await staticBvhInputSignature([original], { uvs: true, packerId: "future-packer" }), base);

  const second = item({ slot: 8, matrix: new THREE.Matrix4().makeTranslation(2, 0, 0) });
  assert.notEqual(
    await staticBvhInputSignature([original, second], { uvs: true }),
    await staticBvhInputSignature([second, original], { uvs: true }),
    "item order affects soup order and therefore the packed artifact",
  );
});

test("placement signature treats slots and transforms as refittable state", async () => {
  const original = item();
  const options = { uvs: true, slots: false, transforms: false };
  const signature = await staticBvhInputSignature([original], options);
  assert.equal(
    await staticBvhInputSignature([
      item({ slot: 81, matrix: new THREE.Matrix4().makeTranslation(50, -3, 9) }),
    ], options),
    signature,
  );
  const changed = item({ positions: original.positions.slice() });
  changed.positions[0] += 0.5;
  assert.notEqual(await staticBvhInputSignature([changed], options), signature);
});

test("UV content affects only the UV artifact signature", async () => {
  const original = item();
  const changed = item({ uvs: original.uvs.slice() });
  changed.uvs[0] = 0.375;
  assert.notEqual(
    await staticBvhInputSignature([original], { uvs: true }),
    await staticBvhInputSignature([changed], { uvs: true }),
  );
  assert.equal(
    await staticBvhInputSignature([original], { uvs: false }),
    await staticBvhInputSignature([changed], { uvs: false }),
  );
});

test("artifact round trip preserves packed metadata and uses a zero-copy payload view", async () => {
  const sourceItem = item();
  const signature = await staticBvhInputSignature([sourceItem], { uvs: true });
  const packed = buildStaticSceneBvhWords([sourceItem], BVH_STRATEGY.SAH, { uvs: true });
  const artifact = encodeStaticBvhArtifact(packed, { signature, strategy: "sah" });
  const decoded = decodeStaticBvhArtifact(artifact.buffer, { expectedSignature: signature });
  assert.ok(decoded);
  assert.equal(decoded.strategy, "sah");
  assert.deepEqual(
    { ...decoded.packed, words: [...decoded.packed.words] },
    { ...packed, words: [...packed.words] },
  );
  assert.equal(decoded.packed.words.buffer, artifact.buffer);
  assert.equal(decoded.packed.words.byteOffset, STATIC_BVH_HEADER_BYTES);
  assert.equal(artifact.byteLength, STATIC_BVH_HEADER_BYTES + packed.words.byteLength);
});

test("decoder treats stale, truncated, malformed, and corrupt artifacts as misses", async () => {
  const sourceItem = item();
  const signature = await staticBvhInputSignature([sourceItem], { uvs: true });
  const packed = buildStaticSceneBvhWords([sourceItem], BVH_STRATEGY.SAH, { uvs: true });
  const encoded = encodeStaticBvhArtifact(packed, { signature });

  assert.equal(decodeStaticBvhArtifact(encoded.subarray(0, encoded.length - 4)), null);

  const stale = "00".repeat(32);
  assert.equal(decodeStaticBvhArtifact(encoded, { expectedSignature: stale }), null);

  const malformed = encoded.slice();
  new DataView(malformed.buffer).setUint32(40, 27, true);
  assert.equal(decodeStaticBvhArtifact(malformed), null);

  const corrupt = encoded.slice();
  corrupt[STATIC_BVH_HEADER_BYTES + 3] ^= 0x80;
  assert.equal(decodeStaticBvhArtifact(corrupt), null);
  assert.ok(
    decodeStaticBvhArtifact(corrupt, { verifyChecksum: false }),
    "checksum verification can be delegated to a native cache reader",
  );
});

test("header can be emitted separately for a vectored atomic writer", async () => {
  const sourceItem = item();
  const signature = await staticBvhInputSignature([sourceItem], { uvs: true });
  const packed = buildStaticSceneBvhWords([sourceItem], BVH_STRATEGY.SAH, { uvs: true });
  const header = createStaticBvhArtifactHeader(packed, { signature });
  assert.equal(header.byteLength, 128);
  assert.equal(
    staticBvhArtifactRelativePath(signature),
    `gi-static-bvh/v1/${signature.slice(0, 2)}/${signature}.gbvh`,
  );
  assert.match(staticBvhSceneManifestRelativePath("C:\\Project\\scenes\\Bistro.scene"), /^gi-static-bvh\/v1\/scenes\/[0-9a-f]{16}\.json$/);
  assert.equal(
    staticBvhSceneManifestRelativePath("C:\\PROJECT\\scenes\\Bistro.scene"),
    staticBvhSceneManifestRelativePath("c:/project/scenes/bistro.scene"),
    "scene pointers are stable across Windows case and slash variants",
  );
  const nativeHeader = createStaticBvhArtifactHeader(packed, { signature, checksum: false });
  assert.equal(
    new DataView(nativeHeader.buffer, nativeHeader.byteOffset, nativeHeader.byteLength).getUint32(72, true),
    0,
    "zero CRC asks the native raw writer to checksum without a JS payload scan",
  );
});

test("scene manifest decoder accepts only the exact content-addressed artifact", async () => {
  const signature = "ab".repeat(32);
  const format = "world-v1";
  const artifact = staticBvhArtifactRelativePath(signature, { format });
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  const valid = {
    version: 1,
    signature,
    format,
    builderAbi: 1,
    artifact,
    bytes: 4096,
    updatedAt: 123,
  };
  assert.deepEqual(
    decodeStaticBvhSceneManifest(encode(valid), { expectedFormat: format, builderAbi: 1 }),
    valid,
  );
  assert.equal(
    decodeStaticBvhSceneManifest(encode({ ...valid, artifact: "../../outside.gbvh" })),
    null,
  );
  assert.equal(
    decodeStaticBvhSceneManifest(encode({ ...valid, signature: "00".repeat(32) })),
    null,
  );
  assert.equal(
    decodeStaticBvhSceneManifest(encode({ ...valid, builderAbi: 2 }), { builderAbi: 1 }),
    null,
  );
});

test("atomic storage adapter keeps the giant payload as a view and reads it back", async () => {
  const sourceItem = item();
  const signature = await staticBvhInputSignature([sourceItem], { uvs: true });
  const packed = buildStaticSceneBvhWords([sourceItem], BVH_STRATEGY.SAH, { uvs: true });
  let stored = null;
  const result = await writeStaticBvhArtifactAtomic({
    path: "Library/test.gbvh",
    packed,
    signature,
    writeAtomic: async (path, header, payload) => {
      assert.equal(path, "Library/test.gbvh");
      assert.equal(payload.buffer, packed.words.buffer, "adapter must not copy the payload");
      stored = new Uint8Array(header.byteLength + payload.byteLength);
      stored.set(header);
      stored.set(payload, header.byteLength);
    },
  });
  assert.equal(result.bytes, stored.byteLength);
  const loaded = await readStaticBvhArtifact({
    path: result.path,
    expectedSignature: signature,
    read: async () => stored.buffer,
  });
  assert.deepEqual([...loaded.packed.words], [...packed.words]);
  assert.equal(await readStaticBvhArtifact({ path: "missing", expectedSignature: signature, read: async () => null }), null);
});

test("UV artifact degrades to the exact no-UV builder prefix without rebuilding", () => {
  const source = item();
  const withUv = buildStaticSceneBvhWords([source], BVH_STRATEGY.SAH, { uvs: true });
  const direct = buildStaticSceneBvhWords([source], BVH_STRATEGY.SAH, { uvs: false });
  const derived = withoutStaticBvhUv(withUv);
  assert.equal(derived.uvRel, 0);
  assert.equal(derived.uvWordCount, 0);
  assert.deepEqual([...derived.words], [...direct.words]);
  assert.equal(derived.words.buffer, withUv.words.buffer, "degrade is a zero-copy prefix view");
});

test("codec rejects inconsistent packed metadata before writing", async () => {
  const signature = await staticBvhInputSignature([item()], { uvs: true });
  const packed = packedWithUv();
  assert.throws(
    () => createStaticBvhArtifactHeader({ ...packed, triCount: packed.triCount + 1 }, { signature }),
    /triangle metadata/,
  );
});

test("GISystem gates rebuilds on async artifact preflight and persists through the atomic adapter", async () => {
  const source = await readFile(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
  assert.match(source, /if \(!this\.#staticBvhArtifactReady\(\)\)/);
  assert.match(source, /readStaticBvhArtifact\(\{/);
  assert.match(source, /verifyChecksum: "worker"/);
  assert.match(source, /withStaticBvhTimeout/);
  assert.match(source, /writeStaticBvhArtifactAtomic\(\{/);
  assert.match(source, /saveAssetBinaryAtomic\(path, header, payload\)/);
  assert.match(source, /if \(this\._staticBvhWritePromise\) return/);
  assert.match(source, /staticBvhSceneManifestRelativePath/);
  assert.match(source, /decodeStaticBvhSceneManifest/);
  assert.match(source, /__giStaticBvhStrictValidation/);
  assert.match(source, /#validateStaticBvhManifest/);
  assert.match(source, /withoutStaticBvhUv\(staticBvhPacked\)/);
});

test("game export ships only scene-selected static BVH artifacts", async () => {
  const source = await readFile(new URL("../src/editor/exportGame.js", import.meta.url), "utf8");
  assert.match(source, /staticBvhSceneManifestRelativePath/);
  assert.match(source, /staticBvhArtifactRelativePath/);
  assert.match(source, /derivedByDestination/);
  assert.doesNotMatch(source, /listProjectAssets\(joinPath\(root, "Library\/gi-static-bvh"\)/);
});

test("large artifact verification has a module-worker path", async () => {
  const source = await readFile(new URL("../src/modules/gi/staticBvhDiskCache.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/modules/gi/staticBvhVerifyWorker.js", import.meta.url), "utf8");
  assert.match(source, /verifyChecksum === "worker"/);
  assert.match(source, /postMessage\(\{ buffer, expectedSignature, builderAbi, expectedFormat \}, \[buffer\]\)/);
  assert.match(worker, /decodeStaticBvhArtifact/);
  assert.match(worker, /\[artifact\.packed\.words\.buffer\]/);
});
