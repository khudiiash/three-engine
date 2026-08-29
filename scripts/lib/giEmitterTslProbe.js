// IN-PAGE HALF OF `run-gi-emitter-tsl-test.mjs`.
//
// It lives in a real module rather than inside a `page.evaluate` string for one
// reason: a raw dynamic `import("three/tsl")` in an evaluated function is not
// transformed by Vite, so the bare specifier never resolves. A file Vite serves
// gets its imports rewritten like any other source file, which is the only way
// a harness can reach TSL and the GI module in the same page.
import * as THREE from "three/webgpu";
import { Fn, float, instanceIndex, instancedArray, uint, vec3 } from "three/tsl";
import { boxLightFactor } from "../../src/modules/gi/giLight.js";
import { refBoxFactor } from "../../src/modules/gi/emitterShapes.js";
import { rcEmitterDirectFactor } from "../../src/modules/gi/window/rc/rcDirect.js";

/**
 * Evaluate `boxLightFactor` on the GPU over `cases` and return each result
 * beside `refBoxFactor`'s answer at the same inputs.
 *
 * @param {Array<{P:number[],N:number[],c:number[],h:number[]}>} cases
 */
export async function runEmitterTslCases(cases) {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();

  const n = cases.length;
  // 4 vec4 per case: P.xyz | N.xyz | center.xyz | half.xyz (w unused).
  const src = new Float32Array(n * 16);
  cases.forEach((k, i) => {
    const o = i * 16;
    src.set(k.P, o); src.set(k.N, o + 4); src.set(k.c, o + 8); src.set(k.h, o + 12);
  });
  const input = instancedArray(src, "vec4");
  const output = instancedArray(new Float32Array(n), "float");
  const rcOutput = instancedArray(new Float32Array(n), "float");

  const kernel = Fn(() => {
    const i = instanceIndex.mul(uint(4));
    const P = input.element(i).xyz.toVar();
    const N = input.element(i.add(uint(1))).xyz.toVar();
    const c = input.element(i.add(uint(2))).xyz.toVar();
    const h = input.element(i.add(uint(3))).xyz.toVar();
    output.element(instanceIndex).assign(
      boxLightFactor(P, N, c, h, vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)),
    );
    const meanArea = h.x.mul(h.y).add(h.y.mul(h.z)).add(h.z.mul(h.x)).mul(2);
    rcOutput.element(instanceIndex).assign(rcEmitterDirectFactor({
      center: c,
      reff: meanArea.div(Math.PI).sqrt(),
      radius: h.length(),
      kind: float(1),
      half: h,
      bx: vec3(1, 0, 0), by: vec3(0, 1, 0), bz: vec3(0, 0, 1),
    }, P, N));
  })().compute(n);

  await renderer.computeAsync(kernel);
  const got = new Float32Array(await renderer.getArrayBufferAsync(output.value));
  const rcGot = new Float32Array(await renderer.getArrayBufferAsync(rcOutput.value));

  const rows = cases.map((k, i) => ({
    P: k.P, N: k.N, c: k.c, h: k.h,
    gpu: got[i], rcGpu: rcGot[i],
    cpu: refBoxFactor(k.P, k.N, k.c, k.h, [1, 0, 0], [0, 1, 0], [0, 0, 1]),
  }));
  renderer.dispose?.();
  return rows;
}
