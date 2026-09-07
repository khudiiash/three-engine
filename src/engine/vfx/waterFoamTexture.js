import * as THREE from "three/webgpu";

/**
 * ══ THE FOAM'S TEXTURE (2026-09-07) ═════════════════════════════════════════
 *
 * Sea of Thieves (Ang et al., SIGGRAPH 2018 Talks): the foam MASK — the
 * Jacobian's whitecaps plus foam around intersecting objects, blurred with
 * feedback so it disperses — "is blended with artist-authored textures to
 * give a more stylized appearance to the foam". The mask is only WHERE; the
 * texture is what foam looks like. Ours is baked here, once, tileable:
 *
 *   R — the LACE: the thin bright walls between bubbles, a cellular network
 *       at two scales (F2 − F1 of a jittered periodic lattice, warped by a
 *       low fractal so no cell reads as a Voronoi tile);
 *   G — the BUBBLES: small bright domes with darker centres, the fine grain
 *       inside a sheet;
 *   B — the PATCHES: a slow fractal that thins a sheet here and thickens it
 *       there, so a mask's edge is ragged rather than a Gaussian's contour.
 *
 * The look (waterFoam.js) samples it in the WATER'S OWN FRAME — the surface
 * point's rest position plus the sea's scroll — so the lace rides the
 * current and the orbital motion with the foam it dresses, and DISSOLVES it
 * by the mask: a faint mask keeps only the brightest walls (thin lace), a
 * strong one nearly everything (a sheet with bubble holes).
 */
let cached = null;
export const FOAM_TEXTURE_SIZE = 512;

function mulberry(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
/** Periodic value noise on an n×n lattice, bilinear, in [0, 1]. */
function valueNoise(n, rand) {
  const grid = new Float32Array(n * n); for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const s = (x, y) => grid[((y % n) + n) % n * n + ((x % n) + n) % n];
  return (u, v) => {   // u, v in [0, 1)
    const x = u * n, y = v * n, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = s(x0, y0), b = s(x0 + 1, y0), c = s(x0, y0 + 1), d = s(x0 + 1, y0 + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  };
}
/** F1 and F2 of a jittered periodic point lattice with n cells per side. */
function worley(n, rand) {
  const px = new Float32Array(n * n), py = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) { px[i] = rand(); py[i] = rand(); }
  return (u, v) => {   // returns [F1, F2] in cell units
    const cx = Math.floor(u * n), cy = Math.floor(v * n);
    let f1 = 9, f2 = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j, k = (((gy % n) + n) % n) * n + (((gx % n) + n) % n);
      const dx = (gx + px[k]) / n - u, dy = (gy + py[k]) / n - v;
      const d = Math.sqrt(dx * dx + dy * dy) * n;
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return [f1, f2];
  };
}
export function foamDetailTexture() {
  if (cached) return cached;
  const N = FOAM_TEXTURE_SIZE;
  const rand = mulberry(0x5EAF0A);
  const warpA = valueNoise(6, rand), warpB = valueNoise(6, rand), patchA = valueNoise(4, rand), patchB = valueNoise(9, rand), patchC = valueNoise(19, rand);
  const laceCoarse = worley(9, rand), laceFine = worley(27, rand), bubbles = worley(48, rand);
  const data = new Uint8Array(N * N * 4);
  const wrap = (x) => x - Math.floor(x);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + .5) / N, v = (y + .5) / N;
    // A warp of a few percent of the tile breaks the lattice's regularity.
    const wu = wrap(u + (warpA(u, v) - .5) * .06), wv = wrap(v + (warpB(u, v) - .5) * .06);
    const [c1, c2] = laceCoarse(wu, wv), [f1, f2] = laceFine(wu, wv), [b1] = bubbles(wu, wv);
    // The walls: bright where the two nearest points are equally near.
    const wallCoarse = Math.exp(-(((c2 - c1) / .22) ** 2)), wallFine = Math.exp(-(((f2 - f1) / .3) ** 2));
    // Inside a coarse cell the film is thinner than at its walls.
    const film = .35 + .25 * Math.min(1, c1 / .55);
    const lace = Math.min(1, Math.max(wallCoarse, wallFine * .8) * .85 + film * .45 * (.6 + .4 * wallFine));
    // The bubbles: a dome, bright at the rim and darker at the centre.
    const dome = Math.max(0, 1 - b1 / .62);
    const bubble = Math.min(1, dome * (.55 + .45 * Math.exp(-(((b1 - .45) / .18) ** 2))) + .25);
    const patch = Math.min(1, Math.max(0, .5 + (patchA(u, v) - .5) * .9 + (patchB(u, v) - .5) * .5 + (patchC(u, v) - .5) * .25));
    const i = (y * N + x) * 4;
    data[i] = Math.round(lace * 255); data[i + 1] = Math.round(bubble * 255); data[i + 2] = Math.round(patch * 255); data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 4;
  texture.name = "water foam detail";
  texture.needsUpdate = true;
  cached = texture;
  return texture;
}
