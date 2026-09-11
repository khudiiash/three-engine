/**
 * Seamless 3D fractal tri-noise — the density field the volumetric fog
 * raymarches (three's `webgpu_postprocessing_fog` example, ported verbatim
 * so the look matches the reference).
 *
 * ⚠ THIS IS EXPENSIVE AND MUST NOT RUN ON THE MAIN THREAD. Measured on the
 * user's machine (node, same JIT):
 *
 *     48³ → 183 ms     64³ → 445 ms     96³ → 2125 ms
 *
 * A 2-second synchronous stall is exactly the class of freeze the zero-freeze
 * work spent a day removing, so `volumetricFog.js` runs this in a worker and
 * leaves the texture flat (= no fog) until the bytes arrive. Kept in its own
 * three-free module so the worker, the fallback path and `node --test` can all
 * import it without a renderer.
 *
 * @param {number} size Edge length of the cube; the result is `size³` bytes.
 * @returns {Uint8Array} Single-channel (R8) density, row-major x→y→z.
 */
export function generateCloudNoise(size = 64) {
  const data = new Uint8Array(size * size * size);
  let idx = 0;

  const tri = (x) => Math.abs((((x % 1.0) + 1.0) % 1.0) - 0.5);

  const tri3 = (x, y, z) => [tri(z + tri(y)), tri(z + tri(x)), tri(y + tri(x))];

  // Four octaves of domain-warped triangle noise. Each octave displaces the
  // sample point by the previous one's gradient, which is what gives the
  // wispy, turbulent structure instead of a lumpy value-noise blob.
  const triNoise = (x, y, z) => {
    let px = x, py = y, pz = z;
    let bpx = x, bpy = y, bpz = z;
    let zFactor = 1.4;
    let rz = 0.0;

    for (let i = 0; i < 4; i++) {
      const [dgx, dgy, dgz] = tri3(bpx * 2.0, bpy * 2.0, bpz * 2.0);
      px += dgx;
      py += dgy;
      pz += dgz;

      bpx = bpx * 1.8 + 0.14;
      bpy = bpy * 1.8 + 0.14;
      bpz = bpz * 1.8 + 0.14;

      zFactor *= 1.5;
      px *= 1.2;
      py *= 1.2;
      pz *= 1.2;

      rz += tri(pz + tri(px + tri(py))) / zFactor;
    }

    return rz;
  };

  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const w = z / size;

        // Two fractal octaves: the base cloud shape plus high-frequency detail
        // offset by an irrational-ish shift so the two never phase-lock.
        const n1 = triNoise(u * 4.0, v * 4.0, w * 4.0);
        const n2 = triNoise(u * 8.0 + 1.7, v * 8.0 + 0.9, w * 8.0 + 2.5) * 0.45;

        data[idx++] = Math.floor(Math.min(Math.max((n1 + n2) * 1.15 * 255, 0), 255));
      }
    }
  }

  return data;
}
