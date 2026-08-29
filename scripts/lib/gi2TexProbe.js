// §19 6.12 — read ANY 2D texture at a pixel list (integer coords), for receipts.
import { Fn, instanceIndex, instancedArray, int, ivec2, texture, uint, vec4 } from "three/tsl";
const MAX = 1024;
export function createGi2TexProbe({ renderer, tex }) {
  const ptIn = instancedArray(new Float32Array(MAX * 4), "vec4");
  const out = instancedArray(new Float32Array(MAX * 4), "vec4");
  const node = texture(tex);
  const pass = Fn(() => {
    const i = instanceIndex.toVar();
    const p = ptIn.element(i).toVar();
    out.element(i).assign(node.load(ivec2(p.x.toInt(), p.y.toInt())));
  })().compute(MAX);
  pass.__giPassName = "probe.gi2tex";
  let warmed = false;
  return {
    async read(pixels) {
      const arr = ptIn.value.array; const n = Math.min(MAX, pixels.length);
      for (let k = 0; k < n; k++) { arr[k * 4] = pixels[k][0]; arr[k * 4 + 1] = pixels[k][1]; }
      ptIn.value.needsUpdate = true;
      renderer.compute(pass);
      if (!warmed) { await new Promise((r) => setTimeout(r, 1800)); renderer.compute(pass); warmed = true; }
      return new Float32Array(await renderer.getArrayBufferAsync(out.value)).slice(0, n * 4);
    },
  };
}
