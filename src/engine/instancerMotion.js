import * as THREE from "three/webgpu";

/**
 * ── INSTANCE MOTION (InstancerComponent's "Motion" toggle) ─────────────────
 *
 * The instancer's layout pass (#fillMatrices) is static: it writes every
 * instance's matrix once, and nothing moves until something rebuilds. Motion
 * is the per-frame layer on top of that layout. It snapshots the laid-out
 * matrices as a BASE and then rewrites the InstancedMesh's instance buffer
 * every frame from `base + f(time)`, so the same component can hand out a
 * flowing river of crates, a flock, or a field of spinning coins without
 * giving up the array/path/scatter paradigms that place them.
 *
 * Three models, chosen by `props.motionMode`:
 *
 *   "scroll"   — every instance drifts along `motionDirection` at
 *                `motionSpeed` units/s. The wrap volume is the LAYOUT'S OWN
 *                BOUNDING BOX — the volume the array/path/scatter already
 *                fills — and each axis wraps independently: an instance
 *                leaving the layout on one side re-enters on the other. This
 *                is the waterfall / conveyor / starfield model — an endless
 *                stream out of a finite number of instances. An axis the
 *                layout has no extent along (a disc's normal, a line's
 *                cross-section) cannot wrap; instances drift freely along it.
 *
 *   "boids"    — the Reynolds flock model over the instance positions:
 *                cohesion toward the local centre, alignment with the local
 *                average heading, separation from crowding, all steerable by
 *                weight. Neighbours are found through a uniform hash grid
 *                rebuilt each frame (O(N), not O(N²) — an instancer's count
 *                reaches six figures and a naive pass would freeze the
 *                editor). Instances are softly pulled back inside the
 *                layout's bounding box rather than wrapped — a flock that
 *                teleports at a boundary reads as a glitch, one that turns
 *                back reads as a wall. An axis the layout is flat along is
 *                given the neighbour radius as thickness, because a
 *                zero-volume cage would pin the flock onto the layout's
 *                plane.
 *
 *   "rotation" — each instance spins in place around `motionAxis` at
 *                `motionSpeed` degrees/s, with a per-instance speed
 *                multiplier drawn from `motionSpinJitter` so a field of
 *                coins does not rotate in lockstep. Positions and scales are
 *                untouched — this only animates orientation.
 *
 * Determinism: every per-instance random value (boid initial heading, spin
 * multiplier) is drawn from a seeded Mulberry32 stream, the same generator the
 * layout uses, so a reload reproduces the same motion from the same seed.
 *
 * Continuity: the elapsed-time clock is OWNED BY THE CALLER and passed in,
 * because motion state is rebuilt whenever the layout re-fills (a spline knot
 * drag) and a rebuilt state must not snap a flowing stream back to its start.
 *
 * All scratch vectors are module-level: this runs once per frame per
 * instancer, on the main thread, between the transform walk and the render.
 */

/** Shared with the component's layout RNG — same generator, same discipline. */
function makeRng(seed) {
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vec3From(v, dx, dy, dz) {
  if (Array.isArray(v) && v.length === 3) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  return [dx, dy, dz];
}

/** One wrap axis: fold `v` into [min, max]. An axis with no extent (a flat
 *  layout along this axis — a disc has no thickness) cannot wrap and is left
 *  alone. */
export function wrapRange(v, min, max) {
  const span = max - min;
  if (!(span > 1e-6)) return v;
  let x = (v - min) % span;
  if (x < 0) x += span;
  return x + min;
}

/**
 * The uniform grid's cell key. Coordinates are quantized by the neighbour
 * radius and offset into positives; Number keys stay exact to 2^53, which the
 * 1e5-per-axis packing keeps head-room under for |coord/cell| < 50 000 — a
 * 25 km world at a 0.5 m neighbour radius. Beyond that, keys silently alias:
 * an accepted limit for a flock volume authored around an entity.
 */
function cellKey(cx, cy, cz) {
  return ((cx + 50000) * 100000 + (cy + 50000)) * 100000 + (cz + 50000);
}

export class InstanceMotion {
  /**
   * @param {THREE.InstancedMesh} mesh The instanced mesh to drive. Its current
   *   instance buffer is snapshotted as the motion base.
   * @param {object} props Live component props — read EVERY frame, so slider
   *   drags take effect without a rebuild (only the `motion` toggle and
   *   `motionMode` change rebuild, because they change the state machines).
   * @param {number} seed The component's layout seed; per-mode streams are
   *   offset from it so boids and spin don't replay the same numbers.
   * @param {{t: number}} clock Shared elapsed-seconds holder owned by the
   *   component, so state resets (layout re-fills) don't restart time.
   */
  constructor(mesh, props, seed = 0, clock = { t: 0 }) {
    this.mesh = mesh;
    this.props = props;
    this.clock = clock;

    const n = mesh.count;
    const arr = mesh.instanceMatrix.array;
    const basePos = new Float32Array(n * 3);
    const baseQuat = new Float32Array(n * 4);
    const baseScale = new Float32Array(n * 3);
    const spinRand = new Float32Array(n);
    const rng = makeRng((seed | 0) + 977);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    let maxExtent = 0;
    const bmin = [Infinity, Infinity, Infinity];
    const bmax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      m.fromArray(arr, i * 16);
      m.decompose(p, q, s);
      basePos[i * 3] = p.x; basePos[i * 3 + 1] = p.y; basePos[i * 3 + 2] = p.z;
      baseQuat[i * 4] = q.x; baseQuat[i * 4 + 1] = q.y; baseQuat[i * 4 + 2] = q.z; baseQuat[i * 4 + 3] = q.w;
      baseScale[i * 3] = s.x; baseScale[i * 3 + 1] = s.y; baseScale[i * 3 + 2] = s.z;
      spinRand[i] = rng();
      maxExtent = Math.max(maxExtent, Math.hypot(p.x, p.y, p.z));
      for (let a = 0; a < 3; a++) {
        const v = a === 0 ? p.x : a === 1 ? p.y : p.z;
        if (v < bmin[a]) bmin[a] = v;
        if (v > bmax[a]) bmax[a] = v;
      }
    }
    this.basePos = basePos;
    this.baseQuat = baseQuat;
    this.baseScale = baseScale;
    this.spinRand = spinRand;
    this.baseExtent = maxExtent;
    // The layout's own bounding box — what scroll wraps over and what boids
    // treat as their cage, replacing the old manual volume parameter. Flat
    // axes (span ~0) stay degenerate here; each consumer decides what that
    // means (scroll: no wrap on that axis; boids: neighbour-radius thickness).
    if (n > 0) {
      this.baseMin = bmin;
      this.baseMax = bmax;
    } else {
      this.baseMin = [0, 0, 0];
      this.baseMax = [0, 0, 0];
    }
    // The geometry's own radius, so the roaming bounding sphere covers a
    // spinning instance's corners too.
    mesh.geometry?.computeBoundingSphere?.();
    this.geometryRadius = mesh.geometry?.boundingSphere?.radius ?? 0;

    // Boids live state: positions start on the layout, velocities from a
    // seeded stream. Reset when the layout re-fills (a fresh flock from the
    // new layout) — time keeps running via `clock`.
    if ((props.motionMode ?? "scroll") === "boids" && n > 0) {
      this.simPos = Float32Array.from(basePos);
      this.simVel = new Float32Array(n * 3);
      const vrng = makeRng((seed | 0) + 4221);
      for (let i = 0; i < n; i++) {
        // Uniform direction on the sphere (Marsaglia); the first integration
        // step clamps speed into range anyway.
        const u1 = vrng(), u2 = vrng(), u3 = vrng();
        const s1 = Math.sqrt(1 - u1);
        const s2 = Math.sqrt(u1);
        const a = 2 * Math.PI * u2;
        this.simVel[i * 3] = s1 * Math.cos(a);
        this.simVel[i * 3 + 1] = s2 * Math.sin(2 * Math.PI * u3);
        this.simVel[i * 3 + 2] = s1 * Math.sin(a);
      }
    } else {
      this.simPos = null;
      this.simVel = null;
    }
  }

  /** Advances one frame. `dt` is clamped — a paused/hitched frame must not teleport the flock. */
  update(dt) {
    const mesh = this.mesh;
    if (!mesh || mesh.count === 0) return;
    // Clamp ONCE and feed the clamped step to everything: an integration that
    // saw the raw dt while the clock saw the clamped one would fling the
    // flock on exactly the hitch this clamp exists for.
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.clock.t += step;
    const mode = this.props.motionMode ?? "scroll";
    if (mode === "boids") this.#stepBoids(step);
    else if (mode === "rotation") this.#stepRotation();
    else this.#stepScroll();
    mesh.instanceMatrix.needsUpdate = true;
    this.#refreshBoundingSphere();
  }

  /**
   * Sphere covering everything the model can reach, for honest culling.
   * Scroll and rotation never leave the layout's hull; boids may grow a flat
   * axis by up to the neighbour radius (half on each side of the layout's
   * plane), which the sphere absorbs by that much.
   */
  #refreshBoundingSphere() {
    let radius = this.baseExtent + this.geometryRadius;
    if ((this.props.motionMode ?? "scroll") === "boids") {
      radius += Math.max(0, this.props.motionNeighborRadius ?? 2);
    }
    if (!this._sphere) this._sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), radius);
    else this._sphere.radius = radius;
    this.mesh.boundingSphere = this._sphere;
  }

  // ---------------------------------------------------------------------------
  // scroll
  // ---------------------------------------------------------------------------

  #stepScroll() {
    const p = this.props;
    const d = vec3From(p.motionDirection, 0, 0, 1);
    const dir = _dir.set(d[0], d[1], d[2]);
    if (dir.lengthSq() < 1e-12) return;
    dir.normalize();
    const travel = dir.multiplyScalar(Math.max(0, p.motionSpeed ?? 1) * this.clock.t);
    // The wrap volume IS the layout: each axis folds over the bounding box
    // the instances already occupy. A flat axis cannot wrap.
    const n = this.mesh.count;
    const arr = this.mesh.instanceMatrix.array;
    for (let i = 0; i < n; i++) {
      _p.set(
        wrapRange(this.basePos[i * 3] + travel.x, this.baseMin[0], this.baseMax[0]),
        wrapRange(this.basePos[i * 3 + 1] + travel.y, this.baseMin[1], this.baseMax[1]),
        wrapRange(this.basePos[i * 3 + 2] + travel.z, this.baseMin[2], this.baseMax[2]),
      );
      _q.fromArray(this.baseQuat, i * 4);
      _s.fromArray(this.baseScale, i * 3);
      _m.compose(_p, _q, _s).toArray(arr, i * 16);
    }
  }

  // ---------------------------------------------------------------------------
  // rotation
  // ---------------------------------------------------------------------------

  #stepRotation() {
    const p = this.props;
    const a = vec3From(p.motionAxis, 0, 1, 0);
    _axis.set(a[0], a[1], a[2]);
    if (_axis.lengthSq() < 1e-12) return;
    _axis.normalize();
    const omega = THREE.MathUtils.degToRad(Math.max(0, p.motionSpeed ?? 30));
    const jitter = Math.min(1, Math.max(0, p.motionSpinJitter ?? 0));
    const n = this.mesh.count;
    const arr = this.mesh.instanceMatrix.array;
    for (let i = 0; i < n; i++) {
      // Per-instance speed multiplier from the seeded rand: jitter 0 keeps the
      // whole field in lockstep, 1 spreads speeds over ±100%.
      const mult = 1 + (this.spinRand[i] * 2 - 1) * jitter;
      _spin.setFromAxisAngle(_axis, omega * mult * this.clock.t);
      _q.fromArray(this.baseQuat, i * 4).multiply(_spin);
      _p.fromArray(this.basePos, i * 3);
      _s.fromArray(this.baseScale, i * 3);
      _m.compose(_p, _q, _s).toArray(arr, i * 16);
    }
  }

  // ---------------------------------------------------------------------------
  // boids
  // ---------------------------------------------------------------------------

  #stepBoids(dt) {
    const p = this.props;
    const pos = this.simPos;
    const vel = this.simVel;
    if (!pos || !vel) return;
    const n = this.mesh.count;

    const maxSpeed = Math.max(0.01, p.motionSpeed ?? 2);
    const minSpeed = maxSpeed * 0.35;
    const nbr = Math.max(1e-4, p.motionNeighborRadius ?? 2);
    const nbr2 = nbr * nbr;
    const sepR = Math.max(1e-4, p.motionSeparationRadius ?? 0.5);
    const sepR2 = sepR * sepR;
    const wCoh = Math.max(0, p.motionCohesion ?? 1);
    const wAli = Math.max(0, p.motionAlignment ?? 1);
    const wSep = Math.max(0, p.motionSeparation ?? 1.5);

    // The cage is the layout's own bounding box, with any axis the layout is
    // flat along thickened to the neighbour radius (half each side of the
    // plane) — a zero-volume cage would pin the flock onto the layout's
    // plane and the flock would never leave it. Derived each frame from the
    // live neighbour radius, so the slider reshapes the cage live.
    const thick = nbr / 2;
    const lo = [0, 0, 0];
    const hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const c = (this.baseMin[a] + this.baseMax[a]) / 2;
      const half = Math.max((this.baseMax[a] - this.baseMin[a]) / 2, thick);
      lo[a] = c - half;
      hi[a] = c + half;
    }

    // Uniform grid over the CURRENT positions — rebuilt per frame, one bucket
    // entry per boid. The 27-cell neighbourhood of a boid then bounds the
    // pair test: O(N) total for a fixed density, instead of the O(N²) that
    // makes a 10k flock freeze the editor.
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const key = cellKey(Math.floor(pos[i * 3] / nbr), Math.floor(pos[i * 3 + 1] / nbr), Math.floor(pos[i * 3 + 2] / nbr));
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }

    for (let i = 0; i < n; i++) {
      const ix = pos[i * 3], iy = pos[i * 3 + 1], iz = pos[i * 3 + 2];
      _center.set(0, 0, 0);
      _avgV.set(0, 0, 0);
      _away.set(0, 0, 0);
      let nbrCount = 0;
      let sepCount = 0;

      const cx = Math.floor(ix / nbr), cy = Math.floor(iy / nbr), cz = Math.floor(iz / nbr);
      for (let gx = -1; gx <= 1; gx++) {
        for (let gy = -1; gy <= 1; gy++) {
          for (let gz = -1; gz <= 1; gz++) {
            const bucket = grid.get(cellKey(cx + gx, cy + gy, cz + gz));
            if (!bucket) continue;
            for (let k = 0; k < bucket.length; k++) {
              const j = bucket[k];
              if (j === i) continue;
              const dx = pos[j * 3] - ix;
              const dy = pos[j * 3 + 1] - iy;
              const dz = pos[j * 3 + 2] - iz;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > nbr2) continue;
              nbrCount++;
              _center.x += pos[j * 3]; _center.y += pos[j * 3 + 1]; _center.z += pos[j * 3 + 2];
              _avgV.x += vel[j * 3]; _avgV.y += vel[j * 3 + 1]; _avgV.z += vel[j * 3 + 2];
              if (d2 < sepR2 && d2 > 1e-12) {
                // Inverse-square: the closer the crowd, the harder the push.
                const inv = 1 / d2;
                _away.x -= dx * inv; _away.y -= dy * inv; _away.z -= dz * inv;
                sepCount++;
              }
            }
          }
        }
      }

      _steer.set(0, 0, 0);
      if (nbrCount > 0) {
        if (wCoh > 0) {
          _center.multiplyScalar(1 / nbrCount);
          _v.set(_center.x - ix, _center.y - iy, _center.z - iz);
          if (_v.lengthSq() > 1e-12) _steer.addScaledVector(_v.normalize(), wCoh);
        }
        if (wAli > 0) {
          _avgV.multiplyScalar(1 / nbrCount);
          if (_avgV.lengthSq() > 1e-12) _steer.addScaledVector(_avgV.normalize(), wAli);
        }
      }
      if (wSep > 0 && sepCount > 0 && _away.lengthSq() > 1e-12) {
        _steer.addScaledVector(_away.normalize(), wSep);
      }
      // Soft volume: an accelerating pull-back proportional to the overshoot,
      // so the flock turns at the boundary instead of wrapping through it.
      for (let a = 0; a < 3; a++) {
        const pa = a === 0 ? ix : a === 1 ? iy : iz;
        if (pa > hi[a]) _steer.setComponent(a, _steer.getComponent(a) - (pa - hi[a]) * 2);
        else if (pa < lo[a]) _steer.setComponent(a, _steer.getComponent(a) - (pa - lo[a]) * 2);
      }

      // Integrate, then clamp speed into [minSpeed, maxSpeed] — the floor
      // keeps a boid that has satisfied every rule from freezing in place.
      _v.set(vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2]).addScaledVector(_steer, dt);
      const sp = _v.length();
      if (sp > maxSpeed) _v.multiplyScalar(maxSpeed / sp);
      else if (sp < minSpeed && sp > 1e-9) _v.multiplyScalar(minSpeed / sp);
      else if (sp <= 1e-9) _v.set(minSpeed, 0, 0);
      vel[i * 3] = _v.x; vel[i * 3 + 1] = _v.y; vel[i * 3 + 2] = _v.z;

      pos[i * 3] = Math.min(Math.max(ix + _v.x * dt, lo[0]), hi[0]);
      pos[i * 3 + 1] = Math.min(Math.max(iy + _v.y * dt, lo[1]), hi[1]);
      pos[i * 3 + 2] = Math.min(Math.max(iz + _v.z * dt, lo[2]), hi[2]);
    }

    // Write matrices: position = live sim, orientation = face the velocity
    // (three's lookAt convention: the −Z column is BACKWARD, matching the
    // layout's `pathForward: "-Z"`), scale = base.
    const arr = this.mesh.instanceMatrix.array;
    for (let i = 0; i < n; i++) {
      _fwd.set(vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2]);
      if (_fwd.lengthSq() > 1e-10) {
        _fwd.normalize();
        _back.copy(_fwd).negate();
        _right.copy(_up.set(0, 1, 0)).cross(_back);
        if (_right.lengthSq() > 1e-8) {
          _right.normalize();
          _up.copy(_back).cross(_right).normalize();
          _q.setFromRotationMatrix(_m.makeBasis(_right, _up, _back));
        } else {
          _q.fromArray(this.baseQuat, i * 4);
        }
      } else {
        _q.fromArray(this.baseQuat, i * 4);
      }
      _p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      _s.fromArray(this.baseScale, i * 3);
      _m2.compose(_p, _q, _s).toArray(arr, i * 16);
    }
  }
}

// Module scratch — one motion instance updates per frame per instancer, and
// these never live across a call.
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _spin = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _steer = new THREE.Vector3();
const _center = new THREE.Vector3();
const _avgV = new THREE.Vector3();
const _away = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _back = new THREE.Vector3();
