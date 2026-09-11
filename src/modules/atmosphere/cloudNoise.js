import * as THREE from "three/webgpu";

/**
 * ⭐ FOUR OCTAVES IN ONE FETCH.
 *
 * Cloud shapes want fbm, and fbm normally means one texture fetch (or one
 * procedural hash) per octave — on a full-screen background that is the whole
 * cost of the sky. So the octaves are baked into the CHANNELS of a single
 * tileable texture: R is a lattice of 8, G of 16, B of 32, A of 64, all over
 * the same [0,1) tile. One `texture()` call then returns four frequencies at
 * once and the fbm is a dot product.
 *
 * The tile repeats, obviously. Two taps at incommensurate scales (see
 * `cloudFbm` in `skyNode.js`) is what hides the repetition — cheaper than
 * four more octaves and it breaks the grid in a way more octaves never do.
 *
 * Generated once per process and shared by every scene: 64 KB, no asset, no
 * loader, deterministic.
 */

const LATTICES = [8, 16, 32, 64];
const SIZE = 128;

/** Deterministic 2D value hash on the wrapped lattice. */
function latticeValue(x, y, lattice, salt) {
  const ix = ((x % lattice) + lattice) % lattice;
  const iy = ((y % lattice) + lattice) % lattice;
  let h = Math.imul(ix + 374761393, 668265263) ^ Math.imul(iy + 2246822519, 374761393) ^ Math.imul(salt + 1, 3266489917);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

function valueNoise(u, v, lattice, salt) {
  const x = u * lattice, y = v * lattice;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const v00 = latticeValue(x0, y0, lattice, salt);
  const v10 = latticeValue(x0 + 1, y0, lattice, salt);
  const v01 = latticeValue(x0, y0 + 1, lattice, salt);
  const v11 = latticeValue(x0 + 1, y0 + 1, lattice, salt);
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}

let shared = null;

/** The shared tileable octave texture. Built on first use. */
export function getCloudNoiseTexture() {
  if (shared) return shared;
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const index = (y * SIZE + x) * 4;
      const u = (x + 0.5) / SIZE, v = (y + 0.5) / SIZE;
      for (let channel = 0; channel < 4; channel++) {
        data[index + channel] = Math.round(255 * valueNoise(u, v, LATTICES[channel], channel));
      }
    }
  }
  shared = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  shared.name = "Atmosphere · cloud octaves";
  shared.wrapS = shared.wrapT = THREE.RepeatWrapping;
  shared.minFilter = THREE.LinearMipmapLinearFilter;
  shared.magFilter = THREE.LinearFilter;
  shared.generateMipmaps = true;
  shared.needsUpdate = true;
  return shared;
}

// ── the same field, on the CPU ──────────────────────────────────────────────
//
// ⭐ WHY THIS EXISTS: the sun has to DIM WHEN A CLOUD CROSSES IT. That is one
// of the strongest signals a sky gives — the light drops, the shadows go soft,
// and a minute later it all comes back — and it is invisible if the cloud
// layer lives only in the background shader. The shading code cannot ask the
// GPU what it drew, so the same field is evaluated here, at one point per
// frame: where the sun's ray leaves the cloud deck above the camera.
//
// It mirrors `cloudFbm` in `skyNode.js` exactly — same two taps, same weights,
// same scales — because a shadow that disagrees with the cloud you can see is
// worse than no shadow at all.

const OCTAVE_WEIGHTS = [0.5, 0.25, 0.15, 0.1];

/** Bilinear, wrapping, four octaves weighted — one `cloudTap`. */
function tap(u, v) {
  const texture = getCloudNoiseTexture();
  const data = texture.image.data;
  const x = u * SIZE - 0.5, y = v * SIZE - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const wrap = (n) => ((n % SIZE) + SIZE) % SIZE;
  const x1 = wrap(x0 + 1), y1 = wrap(y0 + 1), xa = wrap(x0), ya = wrap(y0);
  let total = 0;
  for (let channel = 0; channel < 4; channel++) {
    const v00 = data[(ya * SIZE + xa) * 4 + channel];
    const v10 = data[(ya * SIZE + x1) * 4 + channel];
    const v01 = data[(y1 * SIZE + xa) * 4 + channel];
    const v11 = data[(y1 * SIZE + x1) * 4 + channel];
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    total += ((a + (b - a) * fy) / 255) * OCTAVE_WEIGHTS[channel];
  }
  return total;
}

/** `cloudFbm`, on the CPU. */
export function cloudFieldAt(u, v) {
  return tap(u, v) * 0.62 + tap(u * 0.31 + 3.7, v * 0.31 + 1.9) * 0.38;
}

/**
 * How much cloud stands between a point and the sun, 0…1 — the shader's own
 * threshold, applied to the shared field.
 */
export function cloudOpacityAt(u, v, coverage, density) {
  if (!(coverage > 0.06)) return 0;
  // The same quantile cubic the shader uses — see `CLOUD_QUANTILE` in
  // `skyNode.js`. A shadow that disagrees with the cloud you can see is worse
  // than no shadow, so the two thresholds are one formula.
  const c = Math.min(1, coverage);
  const smooth = Math.max(0, Math.min(1, (c - 0.88) / 0.12));
  const threshold = 0.6774 - 0.8659 * c + 1.4382 * c * c - 1.0065 * c * c * c
    - 0.35 * smooth * smooth * (3 - 2 * smooth);
  const hardness = 5.5 + (11 - 5.5) * Math.min(1, density);
  // The mid-slab profile, which is where most of the mass is.
  const shape = cloudFieldAt(u, v);
  const raw = (shape - threshold) * hardness;
  const present = Math.max(0, Math.min(1, (coverage - 0.06) / 0.12));
  return Math.max(0, Math.min(1, raw)) * present;
}
