/**
 * ══ THE CLOTH ARENA — a CPU model of the step kernel ═════════════════════════
 *
 * `clothArena.js`'s `step` kernel, transliterated, over the SAME packed arrays
 * (`clothArenaPack.js`). It exists so the solver can be tested under node —
 * stability, step invariance, contact, the fabric-length cap — before it goes
 * anywhere near a scene, and so a claim about the solver's behaviour can be
 * checked against a solver rather than an argument. ⛔ Keep the two in step:
 * a change to one that is not made to the other makes every test here a
 * statement about a kernel that no longer exists.
 */
import { ARENA_MAX_ANCHORS, CLOTH_STEP, PARAM_ROWS, ROW, STATIC_STRIDE, TRI_FLOATS } from "./clothArenaPack.js";

const PARTICLE_COLLIDER_STRIDE = 16;

/** Every array the step reads and writes, sized to `capacity` particles. */
export function createArenaState({ capacity, stride, collisionFloats = 4096, maxCloths = 8 }) {
  return {
    capacity, stride, count: 0,
    read: new Float32Array(capacity * 4), write: new Float32Array(capacity * 4), prev: new Float32Array(capacity * 4),
    statics: new Float32Array(capacity * STATIC_STRIDE * 4).fill(0),
    springs: new Float32Array(capacity * stride * 4).fill(-1),
    params: new Float32Array(maxCloths * PARAM_ROWS * 4),
    anchors: new Float32Array(ARENA_MAX_ANCHORS * 4).fill(-1), anchorCount: 0,
    primitives: new Float32Array(64 * PARTICLE_COLLIDER_STRIDE), primitiveCount: 0,
    collision: new Float32Array(collisionFloats),
    simTime: 0, stepSq: CLOTH_STEP * CLOTH_STEP,
  };
}

/** Seed a member's particles at rest in every buffer (what the reset flag does on the GPU). */
export function seedRest(state, base, count) {
  for (let v = base; v < base + count; v++) {
    const s = v * STATIC_STRIDE * 4;
    for (const buffer of [state.read, state.write, state.prev]) {
      buffer[v * 4] = state.statics[s]; buffer[v * 4 + 1] = state.statics[s + 1]; buffer[v * 4 + 2] = state.statics[s + 2]; buffer[v * 4 + 3] = 0;
    }
  }
}

/** One fixed step over every particle: read → write, then swap. */
export function stepClothArena(state) {
  const { read, write, prev, statics, springs, stride, params, anchors, anchorCount, primitives, primitiveCount, collision, simTime, stepSq } = state;
  const rowOf = (id, row) => (id * PARAM_ROWS + row) * 4;
  for (let i = 0; i < state.count; i++) {
    const s = i * STATIC_STRIDE * 4;
    const id = statics[s + 8];
    if (id < 0) continue;
    const st = rowOf(id, ROW.STATE);
    const reset = params[st] > .5, enabled = params[st + 1] > .5, relax = params[st + 2];
    const rest = [statics[s], statics[s + 1], statics[s + 2]], pinned = statics[s + 3] > .5;
    const p = [read[i * 4], read[i * 4 + 1], read[i * 4 + 2]];
    const q = [prev[i * 4], prev[i * 4 + 1], prev[i * 4 + 2]];
    let out, outPrev;
    if (reset || pinned) { out = rest; outPrev = rest; }
    else if (!enabled) { out = p; outPrev = p; }
    else {
      const W = rowOf(id, ROW.WORLD), I = rowOf(id, ROW.INVERSE), F = rowOf(id, ROW.FORCES), Wi = rowOf(id, ROW.WIND), C = rowOf(id, ROW.CONTACT), K = rowOf(id, ROW.SKIP);
      const col = (o, c) => [params[o + c * 4], params[o + c * 4 + 1], params[o + c * 4 + 2]];
      const w0 = col(W, 0), w1 = col(W, 1), w2 = col(W, 2), w3 = col(W, 3);
      const i0 = col(I, 0), i1 = col(I, 1), i2 = col(I, 2), i3 = col(I, 3);
      const toWorld = (v) => [w0[0] * v[0] + w1[0] * v[1] + w2[0] * v[2] + w3[0], w0[1] * v[0] + w1[1] * v[1] + w2[1] * v[2] + w3[1], w0[2] * v[0] + w1[2] * v[1] + w2[2] * v[2] + w3[2]];
      const toLocal = (v) => [i0[0] * v[0] + i1[0] * v[1] + i2[0] * v[2] + i3[0], i0[1] * v[0] + i1[1] * v[1] + i2[1] * v[2] + i3[1], i0[2] * v[0] + i1[2] * v[1] + i2[2] * v[2] + i3[2]];
      const dirToLocal = (v) => [i0[0] * v[0] + i1[0] * v[1] + i2[0] * v[2], i0[1] * v[0] + i1[1] * v[1] + i2[1] * v[2], i0[2] * v[0] + i1[2] * v[1] + i2[2] * v[2]];
      const g = params[F], damp = params[F + 1], stiffness = params[F + 2], bend = params[F + 3];
      const wind = [params[Wi], params[Wi + 1], params[Wi + 2]], gust = params[Wi + 3];
      const gustFreq = params[C], shear = params[C + 1], radiusAuthored = params[C + 2], friction = params[C + 3];
      const skipPrimitive = params[K], skipMesh = params[K + 1], sceneCollision = params[K + 2] > .5, lraRelax = params[K + 3];
      // ── Verlet ────────────────────────────────────────────────────────────
      const speed = Math.hypot(wind[0], wind[1], wind[2]);
      const wp = toWorld(p);
      const gustAmp = Math.sin(simTime * gustFreq * Math.PI * 2 + wp[0] * .8 + wp[1] * .6) * (gust + speed * .35)
        + Math.sin(simTime * .731 + wp[1] * 1.4) * speed * .15;
      const heading = wind.map((v) => v / Math.max(speed, 1e-4));
      const accelW = [wind[0] + heading[0] * gustAmp, -g + wind[1] + heading[1] * gustAmp, wind[2] + heading[2] * gustAmp];
      const accel = dirToLocal(accelW);
      const next = [0, 1, 2].map((k) => p[k] + (p[k] - q[k]) * damp + accel[k] * stepSq);
      // ── one Jacobi pass over the springs, from the READ buffer ────────────
      const corr = [0, 0, 0];
      let total = 0;
      for (let j = 0; j < stride; j++) {
        const o = (i * stride + j) * 4;
        const other = springs[o];
        if (other < 0) break;
        const d = [read[other * 4] - p[0], read[other * 4 + 1] - p[1], read[other * 4 + 2] - p[2]];
        const len = Math.max(Math.hypot(d[0], d[1], d[2]), 1e-5);
        const family = springs[o + 2];
        const w = family < .5 ? 1 : family < 1.5 ? bend : shear;
        const k = (len - springs[o + 1]) / len * w * .5;
        corr[0] += d[0] * k; corr[1] += d[1] * k; corr[2] += d[2] * k;
        total += w;
      }
      const scale = stiffness * relax / Math.max(total, 1e-4);
      next[0] += corr[0] * scale; next[1] += corr[1] * scale; next[2] += corr[2] * scale;
      // ── the fabric-length cap ─────────────────────────────────────────────
      const fabric = statics[s + 7];
      if (fabric > 0 && lraRelax > 0) {
        const pin = [statics[s + 4], statics[s + 5], statics[s + 6]];
        const away = [next[0] - pin[0], next[1] - pin[1], next[2] - pin[2]];
        const far = Math.hypot(away[0], away[1], away[2]);
        if (far > fabric) {
          const k = fabric / Math.max(far, 1e-6);
          for (let a = 0; a < 3; a++) next[a] += (pin[a] + away[a] * k - next[a]) * lraRelax;
        }
      }
      // ── contact, in world space ───────────────────────────────────────────
      const radiusCap = statics[s + 9];
      const radius = radiusCap > 0 ? Math.min(radiusAuthored, radiusCap) : radiusAuthored;
      const pwv = toWorld(p), nw = toWorld(next);
      const vel = [nw[0] - pwv[0], nw[1] - pwv[1], nw[2] - pwv[2]];
      let touched = false;
      const resolve = (normal, push) => {
        nw[0] += normal[0] * push; nw[1] += normal[1] * push; nw[2] += normal[2] * push;
        const nv = vel[0] * normal[0] + vel[1] * normal[1] + vel[2] * normal[2];
        if (nv < 0) { vel[0] -= normal[0] * nv; vel[1] -= normal[1] * nv; vel[2] -= normal[2] * nv; }
        touched = true;
      };
      if (sceneCollision) {
        for (let k = 0; k < primitiveCount; k++) {
          if (k === skipPrimitive) continue;
          primitiveContact(primitives, k, nw, radius, resolve);
        }
        const G = rowOf(id, ROW.GRID_ORIGIN), D = rowOf(id, ROW.GRID_DIMS);
        const cell = params[G + 3];
        if (cell > 0) {
          const cx = Math.floor((nw[0] - params[G]) / cell), cy = Math.floor((nw[1] - params[G + 1]) / cell), cz = Math.floor((nw[2] - params[G + 2]) / cell);
          const dx = params[D], dy = params[D + 1], dz = params[D + 2];
          if (cx >= 0 && cy >= 0 && cz >= 0 && cx < dx && cy < dy && cz < dz) {
            const cbase = params[D + 3] + cx + cy * dx + cz * dx * dy;
            const start = collision[cbase], end = collision[cbase + 1];
            for (let k = start; k < end; k++) {
              const t = collision[k] * TRI_FLOATS;
              if (collision[t + 3] === skipMesh) continue;
              triangleContact(collision, t, pwv, nw, radius, resolve);
            }
          }
        }
      }
      if (touched) { vel[0] *= 1 - friction; vel[1] *= 1 - friction; vel[2] *= 1 - friction; }
      out = toLocal(nw);
      outPrev = toLocal([nw[0] - vel[0], nw[1] - vel[1], nw[2] - vel[2]]);
    }
    for (let a = 0; a < anchorCount; a++) {
      if (Math.round(anchors[a * 4 + 3]) !== i) continue;
      out = [anchors[a * 4], anchors[a * 4 + 1], anchors[a * 4 + 2]];
      outPrev = out;
    }
    write[i * 4] = out[0]; write[i * 4 + 1] = out[1]; write[i * 4 + 2] = out[2]; write[i * 4 + 3] = 0;
    prev[i * 4] = outPrev[0]; prev[i * 4 + 1] = outPrev[1]; prev[i * 4 + 2] = outPrev[2]; prev[i * 4 + 3] = 0;
  }
  const swap = state.read; state.read = state.write; state.write = swap;
  state.simTime += CLOTH_STEP;
}

/** A box or sphere row of the primitive field, exactly as the old kernel read it. */
export function primitiveContact(data, k, point, radius, resolve) {
  const b = k * PARTICLE_COLLIDER_STRIDE;
  const centre = [data[b + 1], data[b + 2], data[b + 3]];
  if (data[b] < .5) {
    const right = [data[b + 4], data[b + 5], data[b + 6]], up = [data[b + 8], data[b + 9], data[b + 10]], fwd = [data[b + 12], data[b + 13], data[b + 14]];
    const ext = [data[b + 7], data[b + 11], data[b + 15]];
    const rel = [point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]];
    const local = [dot(rel, right), dot(rel, up), dot(rel, fwd)];
    const clamped = local.map((v, a) => Math.max(-ext[a], Math.min(ext[a], v)));
    const closest = [0, 1, 2].map((a) => centre[a] + right[a] * clamped[0] + up[a] * clamped[1] + fwd[a] * clamped[2]);
    const delta = [point[0] - closest[0], point[1] - closest[1], point[2] - closest[2]];
    const distance = Math.hypot(delta[0], delta[1], delta[2]);
    if (distance > 1e-5) {
      if (distance < radius) resolve(delta.map((v) => v / distance), radius - distance);
    } else {
      const pen = [ext[0] - Math.abs(local[0]), ext[1] - Math.abs(local[1]), ext[2] - Math.abs(local[2])];
      const axis = pen[0] <= pen[1] && pen[0] <= pen[2] ? 0 : pen[1] <= pen[2] ? 1 : 2;
      const dir = axis === 0 ? right : axis === 1 ? up : fwd;
      const sign = local[axis] >= 0 ? 1 : -1;
      resolve(dir.map((v) => v * sign), pen[axis] + radius);
    }
  } else {
    const delta = [point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]];
    const distance = Math.hypot(delta[0], delta[1], delta[2]), r = data[b + 7] + radius;
    if (distance < r) {
      const normal = distance > 1e-5 ? delta.map((v) => v / distance) : [0, 1, 0];
      resolve(normal, r - distance);
    }
  }
}

/**
 * One packed triangle against a particle's step: a plane crossing inside the
 * triangle pushes the particle back to the side it came from (no tunnelling
 * whatever the speed); otherwise a particle within `radius` of the triangle is
 * pushed away from its nearest point — to whichever side it is on now.
 */
export function triangleContact(buffer, t, from, point, radius, resolve) {
  const a = [buffer[t], buffer[t + 1], buffer[t + 2]], b = [buffer[t + 4], buffer[t + 5], buffer[t + 6]], c = [buffer[t + 8], buffer[t + 9], buffer[t + 10]];
  const ab = sub(b, a), ac = sub(c, a);
  const raw = cross(ab, ac);
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  if (!(length > 1e-12)) return;
  const n = raw.map((v) => v / length);
  const d0 = dot(sub(from, a), n), d1 = dot(sub(point, a), n);
  if (d0 * d1 < 0) {
    const tt = d0 / (d0 - d1);
    const hit = [from[0] + (point[0] - from[0]) * tt, from[1] + (point[1] - from[1]) * tt, from[2] + (point[2] - from[2]) * tt];
    if (insideTriangle(hit, a, ab, ac)) {
      const side = d0 >= 0 ? 1 : -1;
      resolve(n.map((v) => v * side), radius - d1 * side);
      return;
    }
  }
  const q = closestPointOnTriangle(point, a, b, c, n, ab, ac, d1);
  const delta = sub(point, q);
  const distance = Math.hypot(delta[0], delta[1], delta[2]);
  if (distance < radius) {
    const normal = distance > 1e-6 ? delta.map((v) => v / distance) : n.map((v) => v * (d1 >= 0 ? 1 : -1));
    resolve(normal, radius - distance);
  }
}

function insideTriangle(p, a, ab, ac) {
  const ap = sub(p, a), aa = dot(ab, ab), bb = dot(ac, ac), mixed = dot(ab, ac);
  const inverse = 1 / Math.max(aa * bb - mixed * mixed, 1e-12);
  const u = (bb * dot(ap, ab) - mixed * dot(ap, ac)) * inverse;
  const v = (aa * dot(ap, ac) - mixed * dot(ap, ab)) * inverse;
  return u >= -1e-5 && v >= -1e-5 && u + v <= 1.00001;
}

function closestPointOnTriangle(p, a, b, c, n, ab, ac, d) {
  const projected = [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
  if (insideTriangle(projected, a, ab, ac)) return projected;
  let best = a, bestDistance = Infinity;
  for (const [start, finish] of [[a, b], [b, c], [c, a]]) {
    const edge = sub(finish, start);
    const t = Math.max(0, Math.min(1, dot(sub(p, start), edge) / Math.max(dot(edge, edge), 1e-9)));
    const q = [start[0] + edge[0] * t, start[1] + edge[1] * t, start[2] + edge[2] * t];
    const dist = dot(sub(p, q), sub(p, q));
    if (dist < bestDistance) { bestDistance = dist; best = q; }
  }
  return best;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
