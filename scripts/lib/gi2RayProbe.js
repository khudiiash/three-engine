// IN-PAGE HALF OF `run-gi2-boot-probe.mjs`'s PAST-THE-CAP RAY ARM (§19 Stage 4.0b).
//
// It lives in a real module rather than inside a `page.evaluate` string for the
// same reason `giEmitterTslProbe.js` does: a bare `import("three/tsl")` inside
// an evaluated function is never transformed by Vite, so the specifier does not
// resolve — and importing three's build file by URL would mint a SECOND TSL
// module instance, whose nodes cannot be composed with the ones
// `windowTrace.js` already built (the vite-module-duplication trap). A file
// Vite serves gets its imports rewritten like any other source file, so this
// shares the engine's own TSL instance and can call the LIVE window's
// `traceWindow` directly.
//
// ⭐ WHY A RAY AND NOT A COUNTER. "1532 placements went into the soup" is a
// statement about a JS array. "a ray fired at the lantern at index 1204 comes
// back with a hit inside its bounding sphere" is a statement about the WINDOW,
// which is the thing every gather ray actually intersects — and it is the only
// receipt that can tell "the placement was enumerated" apart from "the
// placement is in the world".
import { Fn, instanceIndex, instancedArray, uint } from "three/tsl";
import { unpackTrace } from "/src/modules/gi/window/windowTrace.js";

const MAX_RAYS = 64;

/**
 * Build (once) a ray kernel against the LIVE GI2 window and return a shooter.
 *
 * ⚠ The kernel is created on FIRST CALL and cached on the gi2 object: it is a
 * receipt-only pass (§19 Stage 4.3a's rule — a kernel only a receipt dispatches
 * must only be BUILT by a receipt), so it must never enter `computeNodes` or a
 * prewarm walk.
 *
 * @param {object} gi2      the live `createGi2System` object
 * @param {object} renderer the engine's WebGPURenderer
 * @returns {(rays: Array<{o:number[], d:number[], tMax:number}>) => Promise<Array>}
 */
export function createGi2RayShooter(gi2, renderer) {
  let rig = gi2.__probeRayRig;
  if (!rig) {
    const rayIn = instancedArray(new Float32Array(MAX_RAYS * 8), "vec4");
    const rayOut = instancedArray(new Float32Array(MAX_RAYS * 4), "vec4");
    const pass = Fn(() => {
      const i = instanceIndex.toVar();
      const b = i.mul(uint(2)).toVar();
      const a0 = rayIn.element(b).toVar();
      const a1 = rayIn.element(b.add(uint(1))).toVar();
      // No normal: these rays are born in mid-air 2 m off the subject and have
      // no surface to be biased off. `traceWindow`'s zero-normal branch is
      // exactly that case.
      const r = gi2.trace.traceWindow(a0.xyz, a1.xyz, a0.w);
      rayOut.element(i).assign(r.raw);
    })().compute(MAX_RAYS);
    pass.__giPassName = "probe.gi2ray";
    rig = gi2.__probeRayRig = { rayIn, rayOut, pass };
  }
  const { rayIn, rayOut, pass } = rig;
  return async (rays) => {
    const arr = rayIn.value.array;
    arr.fill(0);
    for (let i = 0; i < Math.min(MAX_RAYS, rays.length); i++) {
      const r = rays[i];
      const b = i * 8;
      arr[b] = r.o[0]; arr[b + 1] = r.o[1]; arr[b + 2] = r.o[2]; arr[b + 3] = r.tMax ?? 40;
      arr[b + 4] = r.d[0]; arr[b + 5] = r.d[1]; arr[b + 6] = r.d[2]; arr[b + 7] = 0;
    }
    rayIn.value.needsUpdate = true;
    await renderer.computeAsync(pass);
    const raw = new Float32Array(await renderer.getArrayBufferAsync(rayOut.value));
    return rays.slice(0, MAX_RAYS).map((_, i) =>
      unpackTrace(raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2], raw[i * 4 + 3]));
  };
}
