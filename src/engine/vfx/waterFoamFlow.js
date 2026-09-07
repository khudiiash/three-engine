import * as THREE from "three/webgpu";
import { Fn, If, float, int, ivec2, vec2, vec4, uniform, instanceIndex, texture, textureLoad, textureStore, select } from "three/tsl";
import { releaseComputeNodes } from "../../modules/gi/releaseCompute.js";

/**
 * ══ THE FOAM'S FLUID (2026-09-07) ═══════════════════════════════════════════
 *
 * "We need more fluid motion to it, like in those 2d fluid simulations
 * online, so they flow like fluid among waves" (user, pointing at a Stam
 * stable-fluids demo). A foam particle rides the sea's own surface velocity
 * — orbital, back and forth — which piles foam on crests but never swirls
 * it. Real foam sits in the turbulence a breaking crest leaves behind:
 * eddies that stretch a patch into filaments and roll a sheet into holes.
 *
 * So the sea keeps a stable-fluids field on a camera-following window
 * (`FLOW_WINDOW_METRES` at `size`², half-metre cells): NOT the surface
 * velocity itself — projecting that divergence-free would delete the
 * convergence at crests that the sea really has — but a PERTURBATION `w`
 * on top of it. `w` is advected by the full flow (sea + w), kicked by a
 * divergence-free curl noise where crests fold, relaxed to the ripple
 * field's flow inside its window (a hull's push, a splash's ring), rolled
 * up by vorticity confinement, damped over a few seconds, and projected to
 * be divergence-free (Jacobi pressure, a dozen sweeps). A foam particle
 * inside the window moves at sea + w + current. Seventeen dispatches of
 * 256² a frame — small.
 */
export const FLOW_WINDOW_METRES = 128;

function storageMap(size, name) {
  const t = new THREE.StorageTexture(size, size);
  t.type = THREE.HalfFloatType; t.format = THREE.RGBAFormat;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false; t.name = name;
  return t;
}

/**
 * `spectrum` for the sea's samplers (`seaFold(world, lods)` → vec3 λmin + the
 * crest direction, `seaVelocity(world)` → vec2 m/s of the sea's time), the
 * fold threshold uniform, the sea's time scale uniform, and an optional
 * `ripple` ({ flow(local) → vec4, scale, center, half } in the water's local
 * units) the field relaxes to inside the ripple window.
 */
export function createFoamFlow({ size = 256, seaFold, seaVelocity, threshold, timeScale, ripple = null }) {
  const metres = FLOW_WINDOW_METRES, texel = metres / size, half = metres / 2;
  const field = storageMap(size, "foam flow"), shifted = storageMap(size, "foam flow shifted"), work = storageMap(size, "foam flow work");
  const curl = storageMap(size, "foam flow curl"), divergence = storageMap(size, "foam flow divergence");
  const pressure = [storageMap(size, "foam flow pressure A"), storageMap(size, "foam flow pressure B")];
  const u = {
    center: uniform(new THREE.Vector2(0, 0)), shift: uniform(new THREE.Vector2(0, 0)),
    dt: uniform(0), time: uniform(0),
    // Confinement (× the cell), the fold kick (m/s² at a full fold), damping (1/s).
    epsilon: uniform(.5), kick: uniform(2.5), damp: uniform(.35),
  };
  const fieldNode = texture(field);
  const i = instanceIndex.toInt().mod(size), j = instanceIndex.toInt().div(size);
  const at = (ix, iy) => ivec2(ix.clamp(0, size - 1), iy.clamp(0, size - 1));
  const worldOf = (ix, iy) => vec2(ix.toFloat().add(.5).div(size).sub(.5).mul(metres).add(u.center.x), iy.toFloat().add(.5).div(size).sub(.5).mul(metres).add(u.center.y));
  const uvOf = (world) => world.sub(u.center).div(metres).add(.5);
  // Three octaves of a divergence-free curl noise: the kick a folding crest
  // gives the field (ψ of sines; the kick is (∂ψ/∂z, −∂ψ/∂x)).
  const curlNoise = (p, t) => {
    let kx = float(0), kz = float(0);
    const octaves = [[8, .93, .37, .11], [3.5, -.42, .91, .23], [1.6, .71, -.7, .31]];
    for (const [lambda, dx, dz, w] of octaves) {
      const k = 2 * Math.PI / lambda;
      const phase = p.x.mul(dx * k).add(p.y.mul(dz * k)).add(t.mul(w * 2 * Math.PI)).add(lambda * 1.7);
      const c = phase.cos();
      kx = kx.add(c.mul(dx));   // ∂ψ/∂x with A = 1/k
      kz = kz.add(c.mul(dz));   // ∂ψ/∂z
    }
    return vec2(kz, kx.negate());
  };
  // 1. The window moved: the field at the old texel (zero where it was outside).
  const shiftKernel = Fn(() => {
    const sx = i.add(u.shift.x.toInt()), sy = j.add(u.shift.y.toInt());
    const inside = sx.greaterThanEqual(0).and(sx.lessThan(size)).and(sy.greaterThanEqual(0)).and(sy.lessThan(size));
    textureStore(shifted, ivec2(i, j), select(inside, textureLoad(field, at(sx, sy)), vec4(0)));
  })().compute(size * size);
  // 2. Vorticity, for the confinement.
  const curlKernel = Fn(() => {
    const l = textureLoad(shifted, at(i.sub(1), j)).x, r = textureLoad(shifted, at(i.add(1), j)).x;
    const d = textureLoad(shifted, at(i, j.sub(1))).y, up = textureLoad(shifted, at(i, j.add(1))).y;
    // ω = ∂w_z/∂x − ∂w_x/∂z (the field's y channel is the world z velocity).
    const dwzdx = textureLoad(shifted, at(i.add(1), j)).y.sub(textureLoad(shifted, at(i.sub(1), j)).y).div(2 * texel);
    const dwxdz = textureLoad(shifted, at(i, j.add(1))).x.sub(textureLoad(shifted, at(i, j.sub(1))).x).div(2 * texel);
    void l; void r; void d; void up;
    textureStore(curl, ivec2(i, j), vec4(dwzdx.sub(dwxdz), 0, 0, 0));
  })().compute(size * size);
  // 3. Advection by the full flow, the forces, the confinement, the damping.
  const advectKernel = Fn(() => {
    const world = worldOf(i, j);
    const here = textureLoad(shifted, ivec2(i, j)).xy;
    const sea = seaVelocity(world).mul(timeScale);
    const source = world.sub(sea.add(here).mul(u.dt));
    const suv = uvOf(source);
    const inside = suv.x.greaterThan(0).and(suv.x.lessThan(1)).and(suv.y.greaterThan(0)).and(suv.y.lessThan(1));
    const w = select(inside, texture(shifted).sample(suv).level(0).xy, vec2(0)).toVar();
    // The fold kick: a curl noise where the crest folds.
    const fold = seaFold(world, null).x;
    const folding = threshold.add(.1).sub(fold).div(.2).clamp(0, 1);
    w.addAssign(curlNoise(world, u.time).mul(u.kick.mul(folding).mul(u.dt)));
    // The ripple field's flow, inside its window: a hull's push, a splash's ring.
    if (ripple) {
      const local = vec2(world.x.div(ripple.scale.x), world.y.div(ripple.scale.z));
      const rin = local.x.sub(ripple.center.x).abs().lessThan(ripple.half.x).and(local.y.sub(ripple.center.y).abs().lessThan(ripple.half.y));
      const f = ripple.flow(vec4(local.x, 0, local.y, 0).xyz).xy;
      const fm = vec2(f.x.mul(ripple.scale.x), f.y.mul(ripple.scale.z));
      w.assign(select(rin, w.add(fm.sub(w).mul(u.dt.mul(4).min(1))), w));
    }
    // Vorticity confinement: push the flow around the eddies it already has.
    const cl = textureLoad(curl, at(i.sub(1), j)).x.abs(), cr = textureLoad(curl, at(i.add(1), j)).x.abs();
    const cd = textureLoad(curl, at(i, j.sub(1))).x.abs(), cu = textureLoad(curl, at(i, j.add(1))).x.abs();
    const c0 = textureLoad(curl, ivec2(i, j)).x;
    const eta = vec2(cr.sub(cl), cu.sub(cd)).div(2 * texel);
    const n = eta.div(eta.length().add(1e-5));
    w.addAssign(vec2(n.y.mul(c0), n.x.negate().mul(c0)).mul(u.epsilon.mul(texel).mul(u.dt)));
    // Damping.
    w.mulAssign(u.dt.mul(u.damp).oneMinus().max(0));
    textureStore(work, ivec2(i, j), vec4(w, 0, 0));
  })().compute(size * size);
  // 4. Divergence.
  const divergenceKernel = Fn(() => {
    const l = textureLoad(work, at(i.sub(1), j)).x, r = textureLoad(work, at(i.add(1), j)).x;
    const d = textureLoad(work, at(i, j.sub(1))).y, up = textureLoad(work, at(i, j.add(1))).y;
    textureStore(divergence, ivec2(i, j), vec4(r.sub(l).add(up.sub(d)).div(2 * texel), 0, 0, 0));
  })().compute(size * size);
  // 5. Pressure: Jacobi sweeps, ping-pong, warm-started from last frame.
  const jacobi = (src, dst) => Fn(() => {
    const l = textureLoad(src, at(i.sub(1), j)).x, r = textureLoad(src, at(i.add(1), j)).x;
    const d = textureLoad(src, at(i, j.sub(1))).x, up = textureLoad(src, at(i, j.add(1))).x;
    const div = textureLoad(divergence, ivec2(i, j)).x;
    textureStore(dst, ivec2(i, j), vec4(l.add(r).add(d).add(up).sub(div.mul(texel * texel)).mul(.25), 0, 0, 0));
  })().compute(size * size);
  const JACOBI = 12;
  const jacobiKernels = [jacobi(pressure[0], pressure[1]), jacobi(pressure[1], pressure[0])];
  // 6. Project: the field less the pressure gradient (pressure ends in A).
  const projectKernel = Fn(() => {
    const p = pressure[0];
    const l = textureLoad(p, at(i.sub(1), j)).x, r = textureLoad(p, at(i.add(1), j)).x;
    const d = textureLoad(p, at(i, j.sub(1))).x, up = textureLoad(p, at(i, j.add(1))).x;
    const w = textureLoad(work, ivec2(i, j)).xy.sub(vec2(r.sub(l), up.sub(d)).div(2 * texel));
    textureStore(field, ivec2(i, j), vec4(w, 0, 0));
  })().compute(size * size);
  const kernels = [shiftKernel, curlKernel, advectKernel, divergenceKernel, ...Array.from({ length: JACOBI }, (_, k) => jacobiKernels[k % 2]), projectKernel];
  kernels.forEach((k, n) => { k.__giPassName = `sea.flow${n}`; });
  const clearField = Fn(() => { textureStore(field, ivec2(i, j), vec4(0)); textureStore(pressure[0], ivec2(i, j), vec4(0)); })().compute(size * size);
  clearField.__giPassName = "sea.flowClear";
  let ready = false;
  return {
    size, metres, texel, uniforms: u, field,
    /** The frame's dispatches; `eye` is the window's centre (sea metres). */
    passes(dt, time, eye) {
      const queue = [];
      if (!ready) { queue.push(clearField); ready = true; }
      if (eye) {
        const cx = Math.round(eye[0] / texel) * texel, cz = Math.round(eye[1] / texel) * texel;
        u.shift.value.set(Math.round((cx - u.center.value.x) / texel), Math.round((cz - u.center.value.y) / texel));
        u.center.value.set(cx, cz);
      } else u.shift.value.set(0, 0);
      u.dt.value = Math.min(.1, Math.max(0, dt)); u.time.value = time;
      queue.push(...kernels);
      return queue;
    },
    /** The perturbation at a world point (m/s, real time), fading to zero over the window's outer tenth. */
    at(world) {
      const uv = uvOf(world);
      const margin = uv.x.min(uv.x.oneMinus()).min(uv.y).min(uv.y.oneMinus());
      return fieldNode.sample(uv.clamp(.001, .999)).level(0).xy.mul(margin.smoothstep(0, .1));
    },
    restart() { ready = false; },
    /** The field's RMS and peak speed, for a receipt. */
    async readback(renderer) {
      if (!renderer?.backend?.copyTextureToBuffer) return null;
      const halves = await renderer.backend.copyTextureToBuffer(field, 0, 0, size, size);
      const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff; if (e === 0) return s * m * 2 ** -24; if (e === 31) return m ? NaN : s * Infinity; return s * (1 + m / 1024) * 2 ** (e - 15); };
      let q = 0, peak = 0, n = 0;
      for (let k = 0; k < size * size; k++) { const x = h2f(halves[k * 4]), z = h2f(halves[k * 4 + 1]); if (!Number.isFinite(x) || !Number.isFinite(z)) continue; const v = Math.hypot(x, z); q += v * v; peak = Math.max(peak, v); n++; }
      return { rms: Math.sqrt(q / Math.max(1, n)), peak, cells: n };
    },
    dispose(renderer) {
      releaseComputeNodes(renderer, [...kernels, clearField]);
      for (const t of [field, shifted, work, curl, divergence, ...pressure]) t.dispose();
    },
  };
}
