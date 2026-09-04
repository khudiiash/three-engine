// THE LIVE FLICKER WATCH — the eye's statistic, in the user's own session.
//
// ══ WHY THIS IS IN THE ENGINE AND NOT A HARNESS SCRIPT ══════════════════════
//
// `scripts/run-gi-flicker-frame.mjs` has counted per-pixel luminance
// reversals since 2026-08-03 and it solved the object-motion flicker that
// year. It cannot solve THIS one, because the report is about a session it
// cannot enter: 2026-09-04 ran eight arms across three puppeteer runs — a
// parked camera with the sun sweeping at the project's own peak 7°/s, the
// composited frame AND the raw GI irradiance buffer, pools/quality/resolution
// all matched to the user's live boot line — and every arm came back clean
// (indirect view: 96 % of frame-to-frame change keeps its sign, and the
// reversing part is 0.19 % of the image mean). §11.16 hit the same wall in
// the same place with a walk. Three sessions of "the harness does not contain
// the complaint" is not bad luck, it is a message: the thing that flickers is
// in the parts a scripted page does not reproduce — play mode, a character
// controller swinging the camera, a person's own navigation.
//
// So the instrument moves to where the complaint is. Arm it, let the person
// drive, read the number.
//
// ══ WHAT IT MEASURES, AND WHY THESE STATISTICS ═════════════════════════════
//
// Per pixel of the GI irradiance target, every rendered frame:
//
//   REVERSALS   how often the SIGN of the frame-to-frame luminance delta
//               flips. This is the discriminator the whole project's gate
//               rests on ("deltas keep one sign while converging; alternating
//               signs are noise" — feedback-gi-no-noise). A sun setting, a
//               camera revealing a wall, light arriving in a room: all
//               monotone. Only an estimator reverses.
//   STEP        the largest |Δlum| a pixel ever took in one frame, and its
//               mean over the frames it moved. Popping is a STEP, not an
//               oscillation, so reversals alone under-report it — a pixel
//               that jumps once per second and holds reverses twice and looks
//               calm by rate. Both, or neither.
//   CHURN       the share of pixels that reversed three or more times. One
//               reversal is a settling estimate; three is a pixel that cannot
//               make up its mind, and a field of those is what the eye calls
//               boiling.
//
// and beside them, ON THE SAME TIMELINE, the machinery's own dials — α, the
// stride root, the screen history weight, camera-motion EMA, the light-motion
// term. Every previous round of this investigation had the picture and the
// dials in separate runs and had to argue across the gap.
//
// ⚠⚠ ABSOLUTE NUMBERS DO NOT SURVIVE A PROCESS BOUNDARY. The harness header
// records the SAME configuration reading 1.404 and 5.194 reversals/px in two
// runs — a 3.7× spread, larger than any effect anyone has tried to measure.
// Compare two windows in ONE session, never a number here against a number in
// a note. `reversalsPerFrame` is the rate to quote; a raw count depends on how
// long you watched.
//
// ⚠ AND THE INSTRUMENT CAN GO BLIND. A GI rebuild replaces `_giTargets`, and
// an accumulator holding the old texture then watches a surface nothing
// writes — reporting a flawless absence of flicker. The watch pins the
// texture it bound and reports `targetSwapped` rather than a clean number.
import {
  Fn, If, Loop, float, instanceIndex, instancedArray, ivec2, select, texture, uint, uniform, vec2, vec3, vec4,
} from "three/tsl";

/** Pixels reversing this many times or more count as CHURN. */
const CHURN_REVERSALS = 3;
/** Tile grid the per-pixel result is reduced onto, so churn has a PLACE. */
const TILES_X = 16;
const TILES_Y = 9;

/**
 * Build the per-frame accumulator over one irradiance texture.
 *
 * The kernel is `run-gi-flicker-frame.mjs`'s, unchanged in substance —
 * including its relative threshold. `max(0.002, prev·0.01)` means "a 1 %
 * change, floored so a near-black pixel's quantisation is not a signal":
 * without the floor the darkest pixels, where relative variance is always
 * largest, would dominate every number this returns.
 */
export function createGiFlickerAccumulator({ irradiance, width, height }) {
  const pixels = width * height;
  // x prevLum · y last significant delta · z reversals · w frames it moved
  const stateBuf = instancedArray(new Float32Array(pixels * 4), "vec4");
  // x max |Δlum| · y Σ|Δlum| over the frames it moved
  const ampBuf = instancedArray(new Float32Array(pixels * 2), "vec2");
  const irrNode = texture(irradiance);
  const widthU = uniform(width, "uint");
  // 0 = seed prevLum only (warmup), 1 = count. A window that starts counting
  // on frame 0 counts one enormous reversal per pixel: the seed itself.
  const armed = uniform(0);
  const kernel = Fn(() => {
    const px = instanceIndex.mod(widthU);
    const py = instanceIndex.div(widthU);
    const texel = irrNode.load(ivec2(px.toInt(), py.toInt()));
    const lum = texel.xyz.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
    const prev = stateBuf.element(instanceIndex).toVar();
    const delta = lum.sub(prev.x).toVar();
    const threshold = float(0.002).max(prev.x.mul(0.01)).toVar();
    const moved = delta.abs().greaterThan(threshold).toVar();
    // Separate float vars — TSL cannot assign INTO a vec4 var's components
    // (the same constraint giScreen's shadowVars note documents).
    const outDelta = float(prev.y).toVar();
    const outRev = float(prev.z).toVar();
    const outChanged = float(prev.w).toVar();
    If(moved.and(armed.greaterThan(0.5)), () => {
      const flipped = delta.mul(prev.y).lessThan(0);
      outRev.assign(prev.z.add(select(flipped, float(1), float(0))));
      outDelta.assign(delta);
      outChanged.assign(prev.w.add(1));
      // ⚠ A PIXEL'S FIRST MOVE IS NOT A STEP. Until it has moved once,
      // `prevLum` may be the buffer's zero rather than a luminance this pixel
      // ever had — which happens whenever the warmup ran while this kernel's
      // pipeline was still compiling, and an async compute that has not landed
      // is a SILENT no-op (§11.7). Counting that first delta would put the
      // whole image's brightness into `stepMax` and report a catastrophe on a
      // still scene. Reversals are already immune (there is no previous sign
      // to flip against); the amplitude needs saying.
      If(prev.w.greaterThan(0.5), () => {
        const amp = ampBuf.element(instanceIndex).toVar();
        ampBuf.element(instanceIndex).assign(
          vec2(amp.x.max(delta.abs()), amp.y.add(delta.abs())),
        );
      });
    });
    stateBuf.element(instanceIndex).assign(vec4(lum, outDelta, outRev, outChanged));
  })().compute(pixels);
  return { kernel, stateBuf, ampBuf, armed, width, height, texture: irradiance };
}

/**
 * Read the accumulator back and reduce it to the numbers a person can act on.
 *
 * ONE readback, at the end — a per-frame readback would stall the very frames
 * the watch exists to time, and a stalled frame lets the field advance further
 * between two samples, manufacturing exactly the pop the statistic detects
 * (`probe:gi-walk` learned this the expensive way; see its TELEM note).
 */
export async function readGiFlickerAccumulator(renderer, acc, frames) {
  // A storage buffer nothing has dispatched against has no GPU allocation.
  // That is what an accumulator whose compute pipeline never landed looks
  // like — the compile queue busy (a harness Chrome on the same driver, the
  // tail of a boot's material wave) or a shader error that made it a silent
  // no-op. Report it rather than throwing on `.size` of undefined.
  const allocated = !!renderer?.backend?.get?.(acc.stateBuf.value)?.buffer;
  if (!allocated) {
    return { pipelinePending: true, pixels: acc.width * acc.height, resolution: `${acc.width}x${acc.height}`,
      meanLum: 0, meanReversals: 0, reversalsPerFrame: 0, churnShare: 0, movedShare: 0,
      stepP95: 0, stepMax: 0, stepP95OfMean: 0, stepMaxOfMean: 0, tileReversalsPerFrame: [] };
  }
  const state = new Float32Array(await renderer.getArrayBufferAsync(acc.stateBuf.value));
  const amp = new Float32Array(await renderer.getArrayBufferAsync(acc.ampBuf.value));
  const { width, height } = acc;
  const pixels = width * height;
  const tileRev = new Float64Array(TILES_X * TILES_Y);
  const tileStep = new Float64Array(TILES_X * TILES_Y);
  const tilePix = new Float64Array(TILES_X * TILES_Y);
  let revTotal = 0;
  let churn = 0;
  let movedPixels = 0;
  let lumTotal = 0;
  let stepMax = 0;
  // p95 over the pixels that actually moved: a histogram, because sorting a
  // million floats to answer one percentile is a second of main thread.
  const HIST = 512;
  const hist = new Float64Array(HIST);
  const HIST_MAX = 1.0;
  for (let i = 0; i < pixels; i++) {
    const lum = state[i * 4];
    const rev = state[i * 4 + 2];
    const changed = state[i * 4 + 3];
    const mx = amp[i * 2];
    lumTotal += lum;
    revTotal += rev;
    if (rev >= CHURN_REVERSALS) churn++;
    const tx = Math.min(TILES_X - 1, Math.floor(((i % width) / width) * TILES_X));
    const ty = Math.min(TILES_Y - 1, Math.floor((Math.floor(i / width) / height) * TILES_Y));
    const t = ty * TILES_X + tx;
    tileRev[t] += rev;
    tilePix[t]++;
    if (changed > 0) {
      movedPixels++;
      if (mx > stepMax) stepMax = mx;
      if (mx > tileStep[t]) tileStep[t] = mx;
      hist[Math.min(HIST - 1, Math.floor((mx / HIST_MAX) * HIST))]++;
    }
  }
  let stepP95 = 0;
  if (movedPixels > 0) {
    let seen = 0;
    const want = movedPixels * 0.95;
    for (let b = 0; b < HIST; b++) {
      seen += hist[b];
      if (seen >= want) { stepP95 = ((b + 0.5) / HIST) * HIST_MAX; break; }
    }
  }
  const meanLum = lumTotal / pixels;
  const scale = Math.max(1e-4, meanLum);
  // The tile map, as a compact grid of reversals-per-frame — where the churn
  // IS, which every "it flickers over there" report needs and no scalar has.
  const grid = [];
  for (let ty = 0; ty < TILES_Y; ty++) {
    const row = [];
    for (let tx = 0; tx < TILES_X; tx++) {
      const t = ty * TILES_X + tx;
      row.push(+(tileRev[t] / Math.max(1, tilePix[t]) / Math.max(1, frames)).toFixed(4));
    }
    grid.push(row);
  }
  return {
    pixels,
    resolution: `${width}x${height}`,
    meanLum: +meanLum.toFixed(4),
    meanReversals: +(revTotal / pixels).toFixed(3),
    reversalsPerFrame: +(revTotal / pixels / Math.max(1, frames)).toFixed(4),
    churnShare: +(churn / pixels).toFixed(4),
    movedShare: +(movedPixels / pixels).toFixed(4),
    stepP95: +stepP95.toFixed(4),
    stepMax: +stepMax.toFixed(4),
    // ⭐ THE GATE'S OWN UNITS. "No pixel changes more than a few % per frame"
    // is a RELATIVE statement, and an absolute luminance step cannot be held
    // against it without the image's own mean beside it.
    stepP95OfMean: +(stepP95 / scale).toFixed(3),
    stepMaxOfMean: +(stepMax / scale).toFixed(3),
    tileReversalsPerFrame: grid,
  };
}

/** Free the two per-pixel buffers a finished window is holding. */
export function disposeGiFlickerAccumulator(acc) {
  try { acc?.stateBuf?.value?.dispose?.(); } catch { /* already gone */ }
  try { acc?.ampBuf?.value?.dispose?.(); } catch { /* already gone */ }
}

export { CHURN_REVERSALS, TILES_X, TILES_Y };

// ═══════════════════════════════════════════ THE LIGHT-RESPONSE RECORDER
//
// ⭐⭐⭐ WHY A SECOND INSTRUMENT, AND WHY IT IS NOT OPTIONAL (§11.23).
//
// Everything above measures STABILITY, and a field that has stopped tracking
// its light is perfectly stable. On 2026-09-04 this module shipped a change on
// three true receipts — 96.5 % delivery at a PINNED sun, churn 99.6 % → 13.8 %,
// 121 fps — and the user's next look was "when light moves, lighting does not
// update". Not one of those receipts could tell converged from frozen. This
// recorder is the receipt that can: it steps the sun and watches how long the
// GI takes to follow. **No stability number from this module may be believed
// without a light-response number beside it.**
//
// Per rendered frame it reduces the irradiance target to a 16×9 grid of tile
// mean luminances and appends the row to a history buffer — a few hundred
// texel loads per tile per frame, one readback at the end, no per-frame stall
// (the same discipline as the accumulator above). The CPU then scores, per
// frame after the step, the distance from the SETTLED picture, and reports
// t50 / t90 and whether the approach was monotone.
//
// ⚠ TWO WAYS TO BE BLIND, BOTH REPORTED. If the step did not change the
// settled picture (`changeOfBaseline` ≈ 0) the light did not move or the GI
// does not carry it — either way "t90 = 0" means nothing. And if the GI tick
// was held for the window (`fps` far below the viewport's) the field could not
// have advanced, and a picture that cannot advance cannot lag.
export function createGiTileMeanRecorder({ irradiance, width, height, maxFrames }) {
  const tiles = TILES_X * TILES_Y;
  const hist = instancedArray(new Float32Array(maxFrames * tiles), "float");
  const irrNode = texture(irradiance);
  const frameU = uniform(0, "uint");
  // Every 4th pixel each way: ~1/16 of the tile, a few hundred samples — the
  // MEAN of a tile does not need every texel and the whole grid must stay
  // cheaper than the frame it is timing.
  const STRIDE = 4;
  const tileW = Math.max(1, Math.floor(width / TILES_X));
  const tileH = Math.max(1, Math.floor(height / TILES_Y));
  const nx = Math.max(1, Math.floor(tileW / STRIDE));
  const ny = Math.max(1, Math.floor(tileH / STRIDE));
  const kernel = Fn(() => {
    const t = instanceIndex.toVar();
    const tx = t.mod(uint(TILES_X)).toVar();
    const ty = t.div(uint(TILES_X)).toVar();
    const x0 = tx.mul(uint(tileW)).toVar();
    const y0 = ty.mul(uint(tileH)).toVar();
    const sum = float(0).toVar();
    Loop({ start: 0, end: ny, type: "uint", name: "j" }, ({ j }) => {
      Loop({ start: 0, end: nx, type: "uint", name: "i" }, ({ i }) => {
        const px = x0.add(i.mul(uint(STRIDE))).toInt();
        const py = y0.add(j.mul(uint(STRIDE))).toInt();
        const texel = irrNode.load(ivec2(px, py));
        sum.addAssign(texel.xyz.dot(vec3(0.2126, 0.7152, 0.0722)));
      });
    });
    hist.element(frameU.mul(uint(tiles)).add(t)).assign(sum.div(float(nx * ny)));
  })().compute(tiles);
  return { kernel, hist, frameU, tiles, maxFrames, texture: irradiance };
}

/**
 * Score a recorded window. `stepAt` is the frame index the step was applied
 * on; everything before it is baseline, everything after is the approach.
 */
export async function readGiTileMeanRecorder(renderer, rec, frames, stepAt) {
  // The same guard srcDeposit's readStats needs: a storage buffer nothing has
  // dispatched against has no GPU allocation, and `getArrayBufferAsync` then
  // reads `.size` of undefined. A kernel whose pipeline never landed (async
  // compile still pending, or a WGSL error that made it a silent no-op) leaves
  // the buffer exactly there. Report it as what it is, not as a crash.
  const allocated = !!renderer?.backend?.get?.(rec.hist.value)?.buffer;
  if (!allocated) {
    return { pipelinePending: true, framesRecorded: 0, stepAt, changeOfBaseline: 0, err0: 0, errFinal: 0,
      t50Frames: -1, t90Frames: -1, monotoneShare: 0, curve: [] };
  }
  const data = new Float32Array(await renderer.getArrayBufferAsync(rec.hist.value));
  const tiles = rec.tiles;
  const n = Math.min(frames, rec.maxFrames);
  const row = (f) => data.subarray(f * tiles, (f + 1) * tiles);
  const meanRows = (a, b) => {
    const out = new Float64Array(tiles);
    let k = 0;
    for (let f = a; f < b; f++) { const r = row(f); for (let t = 0; t < tiles; t++) out[t] += r[t]; k++; }
    if (k) for (let t = 0; t < tiles; t++) out[t] /= k;
    return out;
  };
  const baseline = meanRows(0, Math.max(1, stepAt));
  const tail = Math.max(1, Math.floor((n - stepAt) * 0.1));
  const settled = meanRows(n - tail, n);
  let settledSum = 0;
  let baselineSum = 0;
  let changeSum = 0;
  for (let t = 0; t < tiles; t++) {
    settledSum += settled[t];
    baselineSum += baseline[t];
    changeSum += Math.abs(settled[t] - baseline[t]);
  }
  // Normalise by the BRIGHTER of the two pictures: a step that turns the sun
  // off the nave floor leaves a settled sum near zero, and dividing by that
  // reported a 486 % change for a picture that simply got dark. t50/t90 are
  // ratios of err to err0 and never depended on this; `changeOfBaseline` and
  // `err0` did.
  const scale = Math.max(1e-4, settledSum, baselineSum);
  // Distance from the settled picture, per frame after the step, as a
  // fraction of the settled picture's total luminance.
  const err = new Float64Array(Math.max(0, n - stepAt));
  for (let f = stepAt; f < n; f++) {
    const r = row(f);
    let e = 0;
    for (let t = 0; t < tiles; t++) e += Math.abs(r[t] - settled[t]);
    err[f - stepAt] = e / scale;
  }
  // err0: the largest distance in the first handful of frames after the step —
  // the world chain runs at 15–30 Hz, so the step's full effect on the picture
  // can land a few frames late.
  let err0 = 0;
  for (let f = 0; f < Math.min(8, err.length); f++) if (err[f] > err0) err0 = err[f];
  const firstBelowAndStays = (frac) => {
    const th = err0 * frac;
    for (let f = 0; f < err.length; f++) {
      if (err[f] > th) continue;
      let ok = true;
      for (let g = f; g < err.length; g++) if (err[g] > th) { ok = false; break; }
      if (ok) return f;
    }
    return -1;
  };
  const t50 = firstBelowAndStays(0.5);
  const t90 = firstBelowAndStays(0.1);
  let monotone = 0;
  for (let f = 1; f < err.length; f++) if (err[f] <= err[f - 1] + 1e-4) monotone++;
  const curve = [];
  const step = Math.max(1, Math.floor(err.length / 24));
  for (let f = 0; f < err.length; f += step) curve.push(+err[f].toFixed(4));
  return {
    framesRecorded: n,
    stepAt,
    changeOfBaseline: +(changeSum / scale).toFixed(4),
    err0: +err0.toFixed(4),
    errFinal: +(err.length ? err[err.length - 1] : 0).toFixed(4),
    t50Frames: t50,
    t90Frames: t90,
    monotoneShare: +(err.length > 1 ? monotone / (err.length - 1) : 1).toFixed(3),
    curve,
  };
}

export function disposeGiTileMeanRecorder(rec) {
  try { rec?.hist?.value?.dispose?.(); } catch { /* already gone */ }
}
