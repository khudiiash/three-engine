// @ts-check
/**
 * Pixel dimensions from an image file's FIRST BYTES — no decode, no upload.
 *
 * Nothing in the project metadata records a texture's size: the `.meta`
 * sidecar holds sampling settings only, and until now the only way to learn
 * "how wide is this PNG" was to decode the whole image (openTextureDocument,
 * or an `<img onLoad>` in the asset inspector). `texture?width>1920` over a
 * project of 2000 textures cannot afford that, but every mainstream format
 * declares its dimensions in a fixed header, so a few dozen bytes per file
 * are enough. Probe with the Tauri `read_binary_file_head` command — 4096
 * bytes, not 64, because a JPEG's SOF marker sits AFTER its EXIF block and
 * camera EXIF routinely runs to kilobytes.
 *
 * Pure bytes in, dimensions or null out — truncated files, wrong magic and
 * unsupported formats all return null rather than throwing, because a search
 * filter has no business crashing on one broken file. Node-testable by
 * design; see tests/image-dimensions.test.mjs.
 */

/**
 * @param {Uint8Array | ArrayBuffer} input  a file head (any length ≥ the header)
 * @returns {{ width: number, height: number, format: "png"|"jpeg"|"webp"|"gif"|"bmp" } | null}
 */
export function parseImageSize(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  // Enough bytes to hold any of the magics below; anything shorter cannot be
  // one of them.
  if (bytes.length < 12) return null;

  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return parsePng(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return parseJpeg(bytes);
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return parseWebp(bytes);
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    // GIF87a/GIF89a: little-endian u16 logical screen size at offset 6.
    if (bytes.length < 10) return null;
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8), format: "gif" };
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return parseBmp(bytes);
  }
  return null;
}

/** IHDR is the first chunk: signature(8) + length(4) + "IHDR" + width BE u32 + height BE u32. */
function parsePng(bytes) {
  if (bytes.length < 24) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) return null;
  return { width, height, format: "png" };
}

/**
 * Walk the segment chain: each marker is FF id, big-endian length; dimensions
 * live in the first SOF (C0–CF except DHT C4, JPG C8, DAC CC). Truncated
 * heads return null — the caller probes 4096 bytes precisely so real JPEGs
 * reach their SOF within the head.
 */
function parseJpeg(bytes) {
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null; // desynced — give up rather than guess
    let marker = bytes[at + 1];
    while (marker === 0xff && at + 2 < bytes.length) marker = bytes[++at + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; } // standalone
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      const height = (bytes[at + 5] << 8) | bytes[at + 6];
      const width = (bytes[at + 7] << 8) | bytes[at + 8];
      if (!width || !height) return null;
      return { width, height, format: "jpeg" };
    }
    at += 2 + length;
  }
  return null;
}

/** RIFF....WEBP → VP8X (extended), "VP8 " (lossy), or VP8L (lossless). */
function parseWebp(bytes) {
  const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (tag === "VP8X") {
    // Chunk payload starts at 20: flags(4) + reserved(3), then the 24-bit
    // canvas-1 — 3 LE bytes width at 27, 3 LE bytes height at 30.
    if (bytes.length < 33) return null;
    const width = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    const height = 1 + (bytes[30] | (bytes[31] << 8) | (bytes[32] << 16));
    return { width, height, format: "webp" };
  }
  if (tag === "VP8 ") {
    // Frame tag(3) + start code 9D 01 2A + width LE u16 & 0x3fff, same height.
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = ((bytes[26] | (bytes[27] << 8)) & 0x3fff) + 1;
    const height = ((bytes[28] | (bytes[29] << 8)) & 0x3fff) + 1;
    return { width, height, format: "webp" };
  }
  if (tag === "VP8L") {
    // Signature 0x2F, then 14 bits width-1 and 14 bits height-1 packed LE.
    // A minimal VP8L head is 25 bytes — the general RIFF guard above would
    // wrongly reject a legitimate 512×512 lossless file.
    if (bytes.length < 25) return null;
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height, format: "webp" };
  }
  return null;
}

/** DIB header: width i32 LE at 18; height i32 LE at 22 (top-down is negative). */
function parseBmp(bytes) {
  if (bytes.length < 26) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(14, true);
  // BITMAPCOREHEADER (12) stores u16s at 18/20 instead.
  if (headerSize === 12) {
    const width = view.getUint16(18, true);
    const height = view.getUint16(20, true);
    if (!width || !height) return null;
    return { width, height, format: "bmp" };
  }
  const width = view.getInt32(18, true);
  const height = Math.abs(view.getInt32(22, true));
  if (!width || !height) return null;
  return { width, height, format: "bmp" };
}
