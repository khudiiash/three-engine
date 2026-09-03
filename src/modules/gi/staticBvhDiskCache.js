// Persistent artifact codec for the static-scene BVH8.
//
// The payload is exactly buildStaticSceneBvhWords(...).words. Keeping it raw
// matters on large scenes: Bistro's payload is about 158 MiB, and JSON/base64
// would add both a giant transient allocation and decode time. The fixed,
// word-aligned header lets a loader return a Uint32Array view into the file's
// ArrayBuffer without copying the payload.

import {
  STATIC_BVH_FORMAT_PLACEMENT,
  STATIC_BVH_FORMAT_WORLD,
  STATIC_BVH_PLACEMENT_BUILDER_ABI,
  STATIC_BVH_PLACEMENT_PACKER_ID,
  STATIC_BVH_WORLD_BUILDER_ABI,
  STATIC_BVH_WORLD_PACKER_ID,
} from "./staticBvhFormats.js";

export const STATIC_BVH_ARTIFACT_VERSION = 1;
export const STATIC_PLACEMENT_BVH_ARTIFACT_VERSION = 2;
export const STATIC_BVH_BUILDER_ABI = STATIC_BVH_WORLD_BUILDER_ABI;
export const STATIC_BVH_HEADER_BYTES = 128;
export const STATIC_BVH_INPUT_SCHEMA = "gi-static-bvh-input-v1";

// Bump this whenever the packer's output contract changes, or whenever a
// three-mesh-bvh update should deliberately invalidate previously built trees.
// The package lock currently pins 0.9.13.
export const STATIC_BVH_PACKER_ID = STATIC_BVH_WORLD_PACKER_ID;
export const STATIC_PLACEMENT_BVH_PACKER_ID = STATIC_BVH_PLACEMENT_PACKER_ID;

const MAGIC = Uint8Array.of(0x47, 0x49, 0x42, 0x56, 0x48, 0x38, 0x00, 0x00); // "GIBVH8"
const ENDIAN_TAG = 0x01020304;
const FLAG_UV = 1;
const NODE_WORDS = 28;
const TRI_WORDS = 10;
const UV_WORDS = 3;
const LEAF_TRIANGLES = 8;
const KEY_OFFSET = 80;
const KEY_BYTES = 32;
const FORMAT_OFFSET = 76;
const FORMAT_IDS = Object.freeze({
  [STATIC_BVH_FORMAT_WORLD]: 0,
  [STATIC_BVH_FORMAT_PLACEMENT]: 1,
});
const FORMAT_NAMES = Object.freeze([STATIC_BVH_FORMAT_WORLD, STATIC_BVH_FORMAT_PLACEMENT]);

const STRATEGY_IDS = Object.freeze({ sah: 0, average: 1, center: 2 });
const STRATEGY_NAMES = Object.freeze(["sah", "average", "center"]);

function strategyName(value) {
  const name = String(value ?? "sah").toLowerCase();
  return Object.hasOwn(STRATEGY_IDS, name) ? name : "sah";
}

function cryptoApi() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Static BVH signatures require Web Crypto SHA-256");
  return subtle;
}

function toHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(value, expectedBytes = null) {
  const text = String(value ?? "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(text) || (text.length & 1) !== 0) {
    throw new Error("Static BVH signature must be hexadecimal");
  }
  const bytes = new Uint8Array(text.length / 2);
  if (expectedBytes != null && bytes.length !== expectedBytes) {
    throw new Error(`Static BVH signature must be ${expectedBytes * 2} hex characters`);
  }
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function sha256(bytes) {
  return new Uint8Array(await cryptoApi().digest("SHA-256", bytes));
}

function typedArrayDescriptor(value) {
  if (!ArrayBuffer.isView(value) || value instanceof DataView) {
    throw new TypeError("Static BVH inputs must be typed arrays");
  }
  return {
    type: value.constructor?.name ?? "TypedArray",
    length: value.length,
    bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  };
}

// Float64 bit strings preserve every Matrix4 value the world-space soup sees.
// Hashing Math.fround(matrix) would permit a false hit where lower matrix bits
// change a transformed vertex's final Float32 rounding.
function matrixBits(matrix) {
  const values = matrix?.elements ?? matrix;
  if (!values || values.length !== 16) throw new TypeError("Static BVH placement matrix must contain 16 values");
  const bytes = new Uint8Array(16 * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 16; i++) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) throw new TypeError("Static BVH placement matrix must be finite");
    view.setFloat64(i * 8, value, true);
  }
  return toHex(bytes);
}

/**
 * SHA-256 signature of every input that can alter buildStaticSceneBvhWords.
 *
 * Array contents, rather than runtime ids/object identity, are hashed so the
 * same authored scene resolves to the same key after a process restart. Unique
 * arrays are digested sequentially to keep peak hashing memory bounded; shared
 * geometry is memoized within this call so 200 instances hash it once.
 */
export async function staticBvhInputSignature(
  items,
  {
    uvs = false,
    strategy = "sah",
    packerId = STATIC_BVH_PACKER_ID,
    slots = true,
    transforms = true,
  } = {},
) {
  if (!Array.isArray(items)) throw new TypeError("Static BVH items must be an array");
  const digestMemo = new Map();
  const describe = async (array) => {
    if (array == null) return null;
    let result = digestMemo.get(array);
    if (result) return result;
    const descriptor = typedArrayDescriptor(array);
    result = {
      type: descriptor.type,
      length: descriptor.length,
      sha256: toHex(await sha256(descriptor.bytes)),
    };
    digestMemo.set(array, result);
    return result;
  };

  const manifest = {
    schema: STATIC_BVH_INPUT_SCHEMA,
    packer: String(packerId),
    strategy: strategyName(strategy),
    uvs: uvs === true,
    items: [],
  };
  for (const item of items) {
    manifest.items.push({
      positions: await describe(item?.positions),
      index: await describe(item?.index),
      // UV data is deliberately irrelevant to the no-UV packed form.
      uv: uvs === true ? await describe(item?.uvs) : null,
      // Placement-v1 stores these in its small mutable TLAS prefix. They are
      // runtime state, not BLAS identity: a warm artifact patches/refits them
      // in memory instead of minting another 100MB content-addressed file.
      slot: slots === true ? Number(item?.slot) >>> 0 : null,
      matrixF64LE: transforms === true ? matrixBits(item?.matrix) : null,
    });
  }
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  return toHex(await sha256(bytes));
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function payloadBytesOf(words) {
  if (!(words instanceof Uint32Array)) throw new TypeError("Static BVH words must be a Uint32Array");
  return new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
}

function packedFormat(packed, requested = null) {
  const format = requested ?? packed?.format ?? STATIC_BVH_FORMAT_WORLD;
  if (format !== STATIC_BVH_FORMAT_WORLD && format !== STATIC_BVH_FORMAT_PLACEMENT) {
    throw new Error(`Unsupported static BVH format "${format}"`);
  }
  return format;
}

function validatePlacementPackedShape(packed, words) {
  const layout = packed?.layout;
  if (!layout || words.length < 16 || words[0] !== 0x32564253 || words[1] !== 1) {
    throw new Error("Static placement BVH payload header is invalid");
  }
  const values = {
    tlasNodeWordOffset: Number(layout.tlasNodeWordOffset),
    tlasNodeWordCount: Number(layout.tlasNodeWordCount),
    placementWordOffset: Number(layout.placementWordOffset),
    placementWordCount: Number(layout.placementWordCount),
    blasNodeWordOffset: Number(layout.blasNodeWordOffset),
    blasNodeWordCount: Number(layout.blasNodeWordCount),
    triangleWordOffset: Number(layout.triangleWordOffset),
    triangleWordCount: Number(layout.triangleWordCount),
    uvWordOffset: Number(layout.uvWordOffset),
    uvWordCount: Number(layout.uvWordCount),
    totalWords: Number(layout.totalWords),
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`Static placement BVH ${name} is out of range`);
    }
  }
  const placementCount = Number(packed.placementCount ?? words[15]);
  const blasCount = Number(packed.blasCount ?? words[14]);
  const triangleCount = Number(packed.triangleCount);
  const hasUv = values.uvWordCount > 0;
  if (
    packed.arity !== 8 || !Number.isSafeInteger(placementCount) || placementCount < 1 ||
    !Number.isSafeInteger(blasCount) || blasCount < 1 ||
    !Number.isSafeInteger(triangleCount) || triangleCount < 1 ||
    values.tlasNodeWordOffset !== 16 ||
    values.tlasNodeWordCount !== (placementCount * 2 - 1) * 8 ||
    values.placementWordOffset !== values.tlasNodeWordOffset + values.tlasNodeWordCount ||
    values.placementWordCount !== placementCount * 24 ||
    values.blasNodeWordOffset !== values.placementWordOffset + values.placementWordCount ||
    values.blasNodeWordCount % NODE_WORDS !== 0 ||
    values.triangleWordOffset !== values.blasNodeWordOffset + values.blasNodeWordCount ||
    values.triangleWordCount !== triangleCount * 9 ||
    (hasUv
      ? values.uvWordOffset !== values.triangleWordOffset + values.triangleWordCount ||
        values.uvWordCount !== triangleCount * UV_WORDS ||
        values.totalWords !== values.uvWordOffset + values.uvWordCount
      : values.uvWordOffset !== 0 || values.totalWords !== values.triangleWordOffset + values.triangleWordCount) ||
    values.totalWords !== words.length ||
    words[2] !== (hasUv ? 1 : 0) || words[3] !== words.length ||
    words[4] !== values.tlasNodeWordOffset || words[5] !== values.tlasNodeWordCount ||
    words[6] !== values.placementWordOffset || words[7] !== values.placementWordCount ||
    words[8] !== values.blasNodeWordOffset || words[9] !== values.blasNodeWordCount ||
    words[10] !== values.triangleWordOffset || words[11] !== values.triangleWordCount ||
    words[12] !== values.uvWordOffset || words[13] !== values.uvWordCount ||
    words[14] !== blasCount || words[15] !== placementCount
  ) {
    throw new Error("Static placement BVH payload layout is inconsistent");
  }
  return {
    format: STATIC_BVH_FORMAT_PLACEMENT,
    words,
    hasUv,
    layout: values,
    placementCount,
    blasCount,
    triCount: triangleCount,
    uvRel: values.uvWordOffset,
    uvWordCount: values.uvWordCount,
  };
}

function validatePackedShape(packed, requestedFormat = null) {
  const words = packed?.words;
  payloadBytesOf(words);
  const format = packedFormat(packed, requestedFormat);
  if (format === STATIC_BVH_FORMAT_PLACEMENT) return validatePlacementPackedShape(packed, words);
  const nodeWords = Number(packed.nodeWords);
  const triWords = Number(packed.triWords);
  const triCount = Number(packed.triCount);
  const uvRel = Number(packed.uvRel ?? 0);
  const uvWordCount = Number(packed.uvWordCount ?? 0);
  for (const [name, value] of Object.entries({ nodeWords, triWords, triCount, uvRel, uvWordCount })) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`Static BVH ${name} is out of range`);
    }
  }
  if (packed.arity !== 8) throw new Error("Persistent static BVH artifacts require arity 8");
  if (nodeWords % NODE_WORDS !== 0) throw new Error("Static BVH node region is not node-aligned");
  if (triWords !== triCount * TRI_WORDS) throw new Error("Static BVH triangle metadata is inconsistent");
  const hasUv = uvWordCount > 0;
  if (hasUv) {
    if (uvRel !== nodeWords + triWords || uvWordCount !== triCount * UV_WORDS) {
      throw new Error("Static BVH UV metadata is inconsistent");
    }
  } else if (uvRel !== 0) {
    throw new Error("Static BVH without UV words must have uvRel 0");
  }
  if (nodeWords + triWords + uvWordCount !== words.length) {
    throw new Error("Static BVH payload length is inconsistent");
  }
  return {
    format: STATIC_BVH_FORMAT_WORLD,
    words, nodeWords, triWords, triCount, uvRel, uvWordCount, hasUv,
  };
}

/** Fixed 128-byte metadata block. Production writers can write this followed
 * by packed.words without allocating a second Bistro-sized JS buffer. */
export function createStaticBvhArtifactHeader(
  packed,
  { signature, strategy = "sah", builderAbi = null, checksum = true, format = null } = {},
) {
  const shape = validatePackedShape(packed, format);
  const placement = shape.format === STATIC_BVH_FORMAT_PLACEMENT;
  const resolvedBuilderAbi = builderAbi ?? (placement
    ? STATIC_BVH_PLACEMENT_BUILDER_ABI
    : STATIC_BVH_BUILDER_ABI);
  const key = fromHex(signature, KEY_BYTES);
  const out = new Uint8Array(STATIC_BVH_HEADER_BYTES);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, placement ? STATIC_PLACEMENT_BVH_ARTIFACT_VERSION : STATIC_BVH_ARTIFACT_VERSION, true);
  view.setUint32(12, STATIC_BVH_HEADER_BYTES, true);
  view.setUint32(16, ENDIAN_TAG, true);
  view.setUint32(20, shape.hasUv ? FLAG_UV : 0, true);
  view.setUint32(24, Number(resolvedBuilderAbi) >>> 0, true);
  view.setUint32(28, STRATEGY_IDS[strategyName(strategy)], true);
  view.setUint32(32, 8, true);
  view.setUint32(36, LEAF_TRIANGLES, true);
  view.setUint32(40, NODE_WORDS, true);
  view.setUint32(44, placement ? 9 : TRI_WORDS, true);
  view.setUint32(48, placement ? shape.layout.tlasNodeWordCount : shape.nodeWords, true);
  view.setUint32(52, placement ? shape.layout.placementWordCount : shape.triWords, true);
  view.setUint32(56, shape.triCount, true);
  view.setUint32(60, shape.uvRel, true);
  view.setUint32(64, shape.uvWordCount, true);
  view.setUint32(68, shape.words.length, true);
  // Zero is the native writer's "fill this from the raw request body"
  // sentinel. Production persistence uses it so JavaScript does not walk a
  // Bistro-sized payload synchronously before the background IPC write even
  // begins. Standalone encoding remains checksummed by default.
  view.setUint32(72, checksum === false ? 0 : crc32(payloadBytesOf(shape.words)), true);
  view.setUint32(FORMAT_OFFSET, FORMAT_IDS[shape.format], true);
  out.set(key, KEY_OFFSET);
  return out;
}

/** Convenience encoder for tests/small scenes. Large-scene persistence should
 * pass createStaticBvhArtifactHeader() and the raw words to an atomic vectored
 * writer, avoiding this full-payload copy. */
export function encodeStaticBvhArtifact(packed, options) {
  const header = createStaticBvhArtifactHeader(packed, options);
  const out = new Uint8Array(header.length + packed.words.byteLength);
  out.set(header, 0);
  out.set(payloadBytesOf(packed.words), header.length);
  return out;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Parses and validates an artifact. The returned words are a zero-copy view
 * into `buffer`; keep that buffer alive until the existing GPU upload staging
 * has dispatched. Corrupt/stale files return null and are ordinary misses. */
export function decodeStaticBvhArtifact(
  buffer,
  {
    expectedSignature = null,
    builderAbi = STATIC_BVH_BUILDER_ABI,
    expectedFormat = null,
    verifyChecksum = true,
  } = {},
) {
  try {
    const bytes = buffer instanceof Uint8Array
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    if (bytes.byteLength < STATIC_BVH_HEADER_BYTES || !sameBytes(bytes.subarray(0, MAGIC.length), MAGIC)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const formatId = view.getUint32(FORMAT_OFFSET, true);
    const format = FORMAT_NAMES[formatId];
    if (!format || (expectedFormat != null && format !== expectedFormat)) return null;
    const placement = format === STATIC_BVH_FORMAT_PLACEMENT;
    const artifactVersion = placement ? STATIC_PLACEMENT_BVH_ARTIFACT_VERSION : STATIC_BVH_ARTIFACT_VERSION;
    if (view.getUint32(8, true) !== artifactVersion) return null;
    if (view.getUint32(12, true) !== STATIC_BVH_HEADER_BYTES) return null;
    if (view.getUint32(16, true) !== ENDIAN_TAG) return null;
    const flags = view.getUint32(20, true);
    if ((flags & ~FLAG_UV) !== 0) return null;
    if (view.getUint32(24, true) !== (Number(builderAbi) >>> 0)) return null;
    const strategyId = view.getUint32(28, true);
    if (strategyId >= STRATEGY_NAMES.length) return null;
    if (view.getUint32(32, true) !== 8 || view.getUint32(36, true) !== LEAF_TRIANGLES) return null;
    if (view.getUint32(40, true) !== NODE_WORDS || view.getUint32(44, true) !== (placement ? 9 : TRI_WORDS)) return null;

    const primaryWords = view.getUint32(48, true);
    const secondaryWords = view.getUint32(52, true);
    const triCount = view.getUint32(56, true);
    const uvRel = view.getUint32(60, true);
    const uvWordCount = view.getUint32(64, true);
    const payloadWords = view.getUint32(68, true);
    const expectedBytes = STATIC_BVH_HEADER_BYTES + payloadWords * 4;
    if (expectedBytes !== bytes.byteLength) return null;
    const hasUv = (flags & FLAG_UV) !== 0;
    if (hasUv !== (uvWordCount > 0)) return null;

    const key = bytes.subarray(KEY_OFFSET, KEY_OFFSET + KEY_BYTES);
    if (expectedSignature != null && !sameBytes(key, fromHex(expectedSignature, KEY_BYTES))) return null;
    const payload = bytes.subarray(STATIC_BVH_HEADER_BYTES);
    if (verifyChecksum && crc32(payload) !== view.getUint32(72, true)) return null;
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset + STATIC_BVH_HEADER_BYTES, payloadWords);
    let packed;
    if (placement) {
      const layout = {
        headerWordOffset: 0,
        headerWordCount: 16,
        tlasNodeWordOffset: words[4],
        tlasNodeWordCount: words[5],
        placementWordOffset: words[6],
        placementWordCount: words[7],
        blasNodeWordOffset: words[8],
        blasNodeWordCount: words[9],
        triangleWordOffset: words[10],
        triangleWordCount: words[11],
        uvWordOffset: words[12],
        uvWordCount: words[13],
        totalWords: words[3],
      };
      packed = {
        format,
        builderAbi: view.getUint32(24, true),
        words,
        layout,
        placementCount: words[15],
        blasCount: words[14],
        triangleCount: triCount,
        arity: 8,
        uvs: hasUv,
      };
      const shape = validatePackedShape(packed, format);
      if (
        primaryWords !== shape.layout.tlasNodeWordCount ||
        secondaryWords !== shape.layout.placementWordCount ||
        uvRel !== shape.layout.uvWordOffset || uvWordCount !== shape.layout.uvWordCount
      ) return null;
    } else {
      const nodeWords = primaryWords;
      const triWords = secondaryWords;
      if (nodeWords % NODE_WORDS !== 0 || triWords !== triCount * TRI_WORDS) return null;
      if (hasUv) {
        if (uvRel !== nodeWords + triWords || uvWordCount !== triCount * UV_WORDS) return null;
      } else if (uvRel !== 0 || uvWordCount !== 0) return null;
      if (nodeWords + triWords + uvWordCount !== payloadWords) return null;
      packed = { words, nodeWords, triWords, triCount, arity: 8, uvRel, uvWordCount };
    }
    return {
      packed,
      format,
      signature: toHex(key),
      strategy: STRATEGY_NAMES[strategyId],
      builderAbi: view.getUint32(24, true),
    };
  } catch {
    return null;
  }
}

/** UVs are a parallel tail and never affect BVH topology or triangle order.
 * This derives the current no-UV degrade rung without rebuilding the tree. */
export function withoutStaticBvhUv(packed) {
  const shape = validatePackedShape(packed);
  if (!shape.hasUv) return packed;
  if (shape.format === STATIC_BVH_FORMAT_PLACEMENT) {
    throw new Error("Static placement BVH UV removal requires a no-UV repack");
  }
  return {
    words: shape.words.subarray(0, shape.uvRel),
    nodeWords: shape.nodeWords,
    triWords: shape.triWords,
    triCount: shape.triCount,
    arity: 8,
    uvRel: 0,
    uvWordCount: 0,
  };
}

/** Project-local content-addressed location; `Library` itself comes from the
 * engine's getDerivedDataPath provider. */
export function staticBvhArtifactRelativePath(signature, { format = STATIC_BVH_FORMAT_WORLD } = {}) {
  const key = String(signature ?? "").toLowerCase();
  fromHex(key, KEY_BYTES);
  const version = format === STATIC_BVH_FORMAT_PLACEMENT
    ? STATIC_PLACEMENT_BVH_ARTIFACT_VERSION
    : STATIC_BVH_ARTIFACT_VERSION;
  return `gi-static-bvh/v${version}/${key.slice(0, 2)}/${key}.gbvh`;
}

// A tiny per-scene pointer tells the exporter which content-addressed artifact
// is live. Runtime lookup remains content-addressed (so the start scene and its
// authored path share one giant file), while builds no longer copy every stale
// 158 MiB artifact left by previous edits.
function scenePathHash(scenePath) {
  const bytes = new TextEncoder().encode(
    String(scenePath ?? "untitled").replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase(),
  );
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b ^ byte, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

export function staticBvhSceneManifestRelativePath(scenePath, { format = STATIC_BVH_FORMAT_WORLD } = {}) {
  const version = format === STATIC_BVH_FORMAT_PLACEMENT
    ? STATIC_PLACEMENT_BVH_ARTIFACT_VERSION
    : STATIC_BVH_ARTIFACT_VERSION;
  return `gi-static-bvh/v${version}/scenes/${scenePathHash(scenePath)}.json`;
}

/**
 * Parses the tiny per-scene pointer used by the manifest-first startup path.
 *
 * The manifest is only a cache hint: the referenced artifact still has to pass
 * its fixed-header, ABI, signature and CRC checks. Keeping this decoder strict
 * also prevents a hand-edited pointer from escaping the derived-data root.
 */
export function decodeStaticBvhSceneManifest(
  buffer,
  { expectedFormat = null, builderAbi = null } = {},
) {
  try {
    const bytes = buffer instanceof Uint8Array
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    // A scene pointer is a few hundred bytes. Refuse an accidental artifact or
    // arbitrary project file before TextDecoder/JSON touches it.
    if (bytes.byteLength < 2 || bytes.byteLength > 16 * 1024) return null;
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || value.version !== 1) return null;
    const format = value.format;
    if (!Object.hasOwn(FORMAT_IDS, format)) return null;
    if (expectedFormat != null && format !== expectedFormat) return null;
    const abi = Number(value.builderAbi);
    if (!Number.isSafeInteger(abi) || abi < 0 || abi > 0xffffffff) return null;
    if (builderAbi != null && abi !== (Number(builderAbi) >>> 0)) return null;
    const signature = String(value.signature ?? "").toLowerCase();
    fromHex(signature, KEY_BYTES);
    const artifact = String(value.artifact ?? "").replace(/\\/g, "/");
    if (artifact !== staticBvhArtifactRelativePath(signature, { format })) return null;
    const size = Number(value.bytes);
    if (!Number.isSafeInteger(size) || size < STATIC_BVH_HEADER_BYTES) return null;
    return {
      version: 1,
      signature,
      format,
      builderAbi: abi,
      artifact,
      bytes: size,
      updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Storage-adapter boundary for the editor's native atomic writer.
 *
 * `writeAtomic` receives two views so the native side can writev(header,
 * payload) to a unique sibling temp, fsync, then rename. It MUST NOT serialize
 * either view as JSON and must not expose the destination before the rename.
 * Keeping the policy injected leaves this engine module usable by the player,
 * where Library is read-only and no Tauri APIs exist.
 */
export async function writeStaticBvhArtifactAtomic({
  path,
  packed,
  signature,
  strategy = "sah",
  builderAbi = null,
  format = null,
  checksum = true,
  writeAtomic,
}) {
  if (typeof writeAtomic !== "function") throw new TypeError("Static BVH cache requires an atomic writer");
  const header = createStaticBvhArtifactHeader(packed, { signature, strategy, builderAbi, checksum, format });
  const payload = payloadBytesOf(packed.words);
  await writeAtomic(path, header, payload);
  return { path, bytes: header.byteLength + payload.byteLength };
}

/** Read adapter shared by Tauri (raw IPC ArrayBuffer) and the exported player
 * (`fetch(...).arrayBuffer()`). I/O errors and invalid files are normal misses. */
export async function readStaticBvhArtifact({
  path,
  expectedSignature,
  builderAbi = STATIC_BVH_BUILDER_ABI,
  expectedFormat = null,
  read,
  verifyChecksum = true,
}) {
  if (typeof read !== "function") throw new TypeError("Static BVH cache requires a binary reader");
  try {
    const buffer = await read(path);
    if (buffer == null) return null;
    if (verifyChecksum === "worker" && typeof Worker === "function" && buffer instanceof ArrayBuffer) {
      return await new Promise((resolve) => {
        const worker = new Worker(new URL("./staticBvhVerifyWorker.js", import.meta.url), { type: "module" });
        const finish = (value) => {
          worker.terminate();
          resolve(value);
        };
        worker.onmessage = (event) => finish(event.data?.artifact ?? null);
        worker.onerror = () => finish(null);
        worker.postMessage({ buffer, expectedSignature, builderAbi, expectedFormat }, [buffer]);
      });
    }
    return decodeStaticBvhArtifact(buffer, { expectedSignature, builderAbi, expectedFormat, verifyChecksum });
  } catch {
    return null;
  }
}
