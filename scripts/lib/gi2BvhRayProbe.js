// §19 6.12 — ONE KERNEL, ONE QUESTION: does `shadowBvh.anyHit` see a triangle on
// the GPU for the rays the CPU mirror says it must? Served by vite so the TSL
// instance is the live one (vite-module-duplication trap).
import { Fn, float, instanceIndex, instancedArray, uint, vec3, vec4 } from "three/tsl";
export { uniform, float } from "three/tsl";

const MAX = 1024;
export function createGi2BvhRayProbe({ renderer, bvh, extra = null }) {
  const rayIn = instancedArray(new Float32Array(MAX * 8), "vec4");
  const out = instancedArray(new Float32Array(MAX * 4), "vec4");
  const pass = Fn(() => {
    const i = instanceIndex.toVar();
    const a = rayIn.element(i.mul(uint(2))).toVar();
    const b = rayIn.element(i.mul(uint(2)).add(uint(1))).toVar();
    const h = bvh.anyHit(vec3(a.xyz), vec3(b.xyz), float(b.w)).toVar();
    out.element(i).assign(vec4(h, bvh.readyU, extra ? float(extra) : a.w, b.w));
  })().compute(MAX);
  pass.__giPassName = "probe.gi2bvhray";
  return {
    async run(rays) {
      const arr = rayIn.value.array;
      const n = Math.min(MAX, rays.length);
      for (let k = 0; k < n; k++) {
        const r = rays[k];
        arr[k * 8] = r.ro[0]; arr[k * 8 + 1] = r.ro[1]; arr[k * 8 + 2] = r.ro[2]; arr[k * 8 + 3] = k;
        arr[k * 8 + 4] = r.rd[0]; arr[k * 8 + 5] = r.rd[1]; arr[k * 8 + 6] = r.rd[2]; arr[k * 8 + 7] = r.maxT;
      }
      rayIn.value.needsUpdate = true;
      // ⚠ a FRESH kernel's first dispatches are dropped while the engine
      // compiles its pipeline off-frame; dispatch, wait, dispatch again.
      renderer.compute(pass);
      await new Promise((r) => setTimeout(r, 1800));
      renderer.compute(pass);
      return new Float32Array(await renderer.getArrayBufferAsync(out.value)).slice(0, n * 4);
    },
  };
}
