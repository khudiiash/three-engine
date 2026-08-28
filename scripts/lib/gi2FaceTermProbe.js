// IN-PAGE HALF OF `run-gi2-faceterm-probe.mjs` (§19 Stage 4.5).
//
// ⭐⭐ §AC PROVED THE VARIANCE IS IN THE RADIANCE CACHE AND COULD NOT SAY WHICH
// TERM CARRIES IT. `shadeHit` adds four things — one sun shadow ray, a four-ray
// sky quadrature, the second bounce those same four rays read back out of the
// cache, and the emitter NEE — and a σ/mean of 110 % across one brick's faces
// is a statement about their SUM. Naming the term is the whole of the diagnosis:
// a sky quantization is fixed by directions, a binary sun is fixed by a cone, a
// cold second bounce is fixed by what a miss pays, and an NEE spread is fixed
// nowhere near here.
//
// So this kernel evaluates `gather.internals.shadeTerms` — the SHIPPING
// estimator, split into its accumulators at the source and summed by `shadeHit`
// itself — at a caller-supplied list of voxel faces, and writes every term out
// separately along with the census the terms were built from (was the sun
// visible; how many of the sky rays missed; how many hit a face the cache had
// already written).
//
// ⚠ IT IS NOT A TRANSCRIPTION OF `shadeHit`. A second copy of the Duff frame,
// the Hammersley azimuth and the `hem` subtraction in a harness file is a third
// place for them to drift, and a receipt that measures a drifted copy is worse
// than no receipt at all. `gatherProbes` exports the pieces; this file only
// arranges them.
//
// ⚠ AND THE PASS IS BUILT BY THE RECEIPT, NEVER BY A BOOT (§19 Stage 4.3a). It
// is cached on the live `gi2` object on first call and never enters
// `computeNodes` or a prewarm walk.
import { Fn, float, instanceIndex, instancedArray, uint, vec3, vec4 } from "three/tsl";

const MAX_FACES = 4096;
/** vec4s in per face: (p, level) (n, voxelIdx) (face, 0, 0, 0). */
const IN_VEC = 3;
/** vec4s out per face — see `read()` below. */
const OUT_VEC = 6;

/**
 * @param {object} gi2      the live `createGi2System` object
 * @param {object} renderer the engine's WebGPURenderer
 * @returns {(faces: Array<{p:number[], n:number[], level:number,
 *   voxelIdx:number, face:number}>) => Promise<Array>}
 */
export function createGi2FaceTermProbe(gi2, renderer) {
  let rig = gi2.__probeFaceTermRig;
  if (!rig) {
    const gather = gi2.gather;
    const inner = gather?.internals;
    if (!inner?.shadeTerms) throw new Error("gather.internals.shadeTerms missing — old build?");
    const faceIn = instancedArray(new Float32Array(MAX_FACES * IN_VEC * 4), "vec4");
    const faceOut = instancedArray(new Float32Array(MAX_FACES * OUT_VEC * 4), "vec4");
    const pass = Fn(() => {
      const i = instanceIndex.toVar();
      const b = i.mul(uint(IN_VEC)).toVar();
      const a0 = faceIn.element(b).toVar();
      const a1 = faceIn.element(b.add(uint(1))).toVar();
      const a2 = faceIn.element(b.add(uint(2))).toVar();
      const p = a0.xyz.toVar();
      const levelF = a0.w.toVar();
      const n = a1.xyz.toVar();
      const voxF = a1.w.toVar();
      const faceF = a2.x.toVar();
      // `seedU` non-null is what compiles the sky block in (see `shadeTerms`);
      // the value is unused since §19 3.10 froze the direction set.
      const t = inner.shadeTerms(p, n, levelF, voxF, uint(1));
      const stored = gi2.cache.cacheRead(levelF, voxF, faceF).toVar();
      const o = i.mul(uint(OUT_VEC)).toVar();
      faceOut.element(o).assign(vec4(t.Esun, t.census.x));
      faceOut.element(o.add(uint(1))).assign(vec4(t.Emiss, t.census.y));
      faceOut.element(o.add(uint(2))).assign(vec4(t.Ebnc, t.census.z));
      faceOut.element(o.add(uint(3))).assign(
        vec4(t.Enee, t.palEm.x.add(t.palEm.y).add(t.palEm.z)));
      faceOut.element(o.add(uint(4))).assign(stored);
      // `.w` is the thread index: a readback of zeros then says whether the kernel
      // ran at all, which no other channel can (every term may legally be 0).
      faceOut.element(o.add(uint(5))).assign(vec4(t.pal.xyz, i.toFloat().add(1)));
    })().compute(MAX_FACES);
    pass.__giPassName = "probe.gi2faceTerm";
    // ⭐ THE WITNESS PASS. Identical plumbing — same `instancedArray`, same
    // dispatch width, same readback — and a body that touches nothing but its
    // own output. If both come back zero the rig is broken; if only the real
    // one does, the body is. One battery instead of an argument.
    const witOut = instancedArray(new Float32Array(MAX_FACES * 4), "vec4");
    const witness = Fn(() => {
      const i = instanceIndex.toVar();
      witOut.element(i).assign(vec4(i.toFloat().add(1), 2, 3, 4));
    })().compute(MAX_FACES);
    witness.__giPassName = "probe.gi2faceTermWitness";
    rig = gi2.__probeFaceTermRig = { faceIn, faceOut, pass, witOut, witness };
  }
  const { faceIn, faceOut, pass, witOut, witness } = rig;
  return async (faces) => {
    const arr = faceIn.value.array;
    arr.fill(0);
    const n = Math.min(MAX_FACES, faces.length);
    for (let i = 0; i < MAX_FACES; i++) {
      const b = i * IN_VEC * 4;
      if (i < n) {
        const f = faces[i];
        arr[b] = f.p[0]; arr[b + 1] = f.p[1]; arr[b + 2] = f.p[2]; arr[b + 3] = f.level;
        arr[b + 4] = f.n[0]; arr[b + 5] = f.n[1]; arr[b + 6] = f.n[2]; arr[b + 7] = f.voxelIdx;
        arr[b + 8] = f.face;
      } else {
        // ⚠ AN UNUSED SLOT STILL RUNS. A zero normal would divide by zero in the
        // tangent frame and put NaN in the readback, so a padding slot is a
        // legal face parked far outside any window: every ray misses at once.
        arr[b] = 0; arr[b + 1] = 1e6; arr[b + 2] = 0; arr[b + 3] = 0;
        arr[b + 5] = 1; arr[b + 7] = 0;
      }
    }
    faceIn.value.needsUpdate = true;
    // ⚠⚠ FIRED TWICE, AND THE FIRST CUT OF THIS PROBE LOST A WHOLE BATTERY TO IT.
    // A fresh compute node's first `computeAsync` COMPILES the pipeline and does
    // not run it (`run-gi2-farfield-probe.mjs` and `run-gi2-doors-probe.mjs` both
    // carry the same note). One dispatch returned a buffer of zeros — no error,
    // no warning — which reads exactly like a wall with no light on it: "0.0 %
    // of the faces written, 100 % of the sky rays hit a COLD face". The thread
    // index in `.w` of the last vec4 is what told them apart. Warming on every
    // call rather than once: two dispatches of 4096 threads is nothing next to
    // the readback, and a rig cached across calls must not depend on which call
    // is the first.
    const device = renderer.backend?.device ?? null;
    const diag = { gpuError: null, witness: 0, attempts: 0, threw: null };
    device?.pushErrorScope("validation");
    await renderer.computeAsync(witness);
    await renderer.computeAsync(witness);
    if (device) {
      const e = await device.popErrorScope();
      if (e) diag.gpuError = String(e.message ?? e).slice(0, 400);
    }
    const wraw = new Float32Array(await renderer.getArrayBufferAsync(witOut.value));
    for (let i = 0; i < MAX_FACES; i++) if (wraw[i * 4] > 0) diag.witness++;

    // ⭐⭐ AND THE HEAVY PASS IS DISPATCHED UNTIL IT LANDS, NOT TWICE.
    //
    // The witness kernel above — same `instancedArray`, same 4096-wide dispatch,
    // same readback, a body of one assignment — writes all 4096 slots on its
    // second dispatch. This one wrote NOTHING after two, with no validation
    // error and no rejected promise. The difference between them is the BODY:
    // `shadeTerms` inlines a sun ray, four sky rays, four NEE traces and the
    // whole DDA, and `probeTrace`'s own history records 2.5 s of pipeline
    // compile for exactly that text. `computeAsync` resolves before such a
    // pipeline exists and the dispatch is dropped on the floor; "fire it twice"
    // is a rule sized for a 64-ray kernel.
    //
    // So the loop is written against the OBSERVABLE — the thread index each
    // thread stamps into its last output word — rather than against a belief
    // about how many dispatches are enough. It stops the moment the buffer says
    // the kernel ran, and `attempts` is on the receipt so a silent regression
    // to "never" cannot read as a pass.
    let raw = new Float32Array(0);
    for (let k = 0; k < 10; k++) {
      diag.attempts = k + 1;
      try {
        await renderer.computeAsync(pass);
      } catch (err) {
        diag.threw = String(err?.message ?? err).slice(0, 400);
        break;
      }
      await new Promise((r) => setTimeout(r, k === 0 ? 2000 : 800));
      raw = new Float32Array(await renderer.getArrayBufferAsync(faceOut.value));
      if (raw[5 * 4 + 3] > 0) break;
    }
    const out = [];
    const at = (i, v) => {
      const o = (i * OUT_VEC + v) * 4;
      return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
    };
    for (let i = 0; i < n; i++) {
      const sun = at(i, 0); const miss = at(i, 1); const bnc = at(i, 2);
      const nee = at(i, 3); const stored = at(i, 4); const pal = at(i, 5);
      out.push({
        ...faces[i],
        Esun: sun.slice(0, 3), sunVis: sun[3],
        Emiss: miss.slice(0, 3), skyMiss: miss[3],
        Ebnc: bnc.slice(0, 3), skyWarm: bnc[3],
        Enee: nee.slice(0, 3), palEm: nee[3],
        stored: stored.slice(0, 3), storedValid: stored[3],
        albedo: pal.slice(0, 3), ran: pal[3],
      });
    }
    out.diag = diag;
    return out;
  };
}

export const GI2_FACE_TERM_MAX = MAX_FACES;
