import {
  Fn, If, Loop, ceil, clamp, exp2, float, floatBitsToUint, floor, instancedArray, int, ivec3,
  localId, log2, max, min, storage, uint, uvec3, vec3, wgslFn, workgroupArray, workgroupBarrier,
} from 'three/tsl';

// A bounded transport proxy, sampled from the rendered GPU positions. It fits
// the existing dynamic BVH pool: no additional binding in any GI ray shader.
//
// ── THE PROXY IS A 9×9 TABLE OF VERTEX INDICES, NOT A SQUARE LATTICE ────────
//
// It began as one: a plane cloth is an n×n sheet, so corner (x, y) of the 8×8
// quad proxy was the vertex at `(x·(n−1)+4)/8` — arithmetic, no table. That
// shut GI out of every MESH cloth, whose vertices are the author's own and sit
// on no lattice at all (`clothArena.createClothMember` simply left
// `userData.giGpuGrid` unset, and a modelled curtain then cast no traced
// shadow and bled no colour — 2026-09-11).
//
// The indices now arrive as DATA. The plane path computes the same arithmetic
// on the CPU, so its proxy is vertex-for-vertex what it always was; a mesh
// cloth samples its rest pose into the same 81 slots (`clothGiProxy.js`). One
// WGSL kernel, one pipeline, shared by every cloth in the scene — which is the
// whole reason the table is a buffer rather than a constant baked per cloth
// into its own shader source (a pipeline per curtain is the sync-compile stall
// that cost 21.5 s of boot once already).

export const GPU_GRID_BVH_NODE_WORDS = 28;
export const GPU_GRID_BVH_TRIANGLES = 128;
export const GPU_GRID_BVH_WORDS = GPU_GRID_BVH_NODE_WORDS + GPU_GRID_BVH_TRIANGLES * 9;
/** 8×8 quads → a 9×9 corner table. Mirrored by `vfx/clothGiProxy.js`. */
export const GPU_GRID_BVH_SPAN = 8;
export const GPU_GRID_BVH_CORNERS = (GPU_GRID_BVH_SPAN + 1) ** 2;

const refit = wgslFn(/* wgsl */ `
fn giRefitGrid(
  positions: ptr<storage, array<vec3f>, read_write>,
  corners: ptr<storage, array<u32>, read_write>,
  bits: ptr<storage, array<u32>, read_write>,
  start: u32, arity: u32
) -> u32 {
  var lows: array<vec3f, 8>;
  var highs: array<vec3f, 8>;
  for (var child = 0u; child < 8u; child++) {
    lows[child] = vec3f(1e30); highs[child] = vec3f(-1e30);
  }
  let perChild = 128u / arity;
  for (var tri = 0u; tri < 128u; tri++) {
    let cell = tri / 2u;
    let x = cell % 8u; let y = cell / 8u;
    var coords: array<vec2u, 3>;
    if (tri % 2u == 0u) {
      coords[0] = vec2u(x, y); coords[1] = vec2u(x, y + 1u); coords[2] = vec2u(x + 1u, y);
    } else {
      coords[0] = vec2u(x + 1u, y); coords[1] = vec2u(x, y + 1u); coords[2] = vec2u(x + 1u, y + 1u);
    }
    let child = tri / perChild;
    for (var vertex = 0u; vertex < 3u; vertex++) {
      let p = positions[corners[coords[vertex].y * 9u + coords[vertex].x]];
      lows[child] = min(lows[child], p); highs[child] = max(highs[child], p);
      let out = start + 28u + tri * 9u + vertex * 3u;
      bits[out] = bitcast<u32>(p.x); bits[out + 1u] = bitcast<u32>(p.y); bits[out + 2u] = bitcast<u32>(p.z);
    }
  }
  if (arity == 4u) {
    for (var child = 0u; child < 4u; child++) {
      bits[start + child] = 0x80000000u | (perChild << 24u) | (child * perChild);
      let out = start + 4u + child * 6u;
      let low = lows[child] - vec3f(0.00001); let high = highs[child] + vec3f(0.00001);
      for (var axis = 0u; axis < 3u; axis++) {
        bits[out + axis] = bitcast<u32>(low[axis]); bits[out + 3u + axis] = bitcast<u32>(high[axis]);
      }
    }
  } else {
    var origin = vec3f(1e30); var maximum = vec3f(-1e30);
    for (var child = 0u; child < 8u; child++) {
      lows[child] -= vec3f(0.00001); highs[child] += vec3f(0.00001);
      origin = min(origin, lows[child]); maximum = max(maximum, highs[child]);
    }
    let exponent = max(vec3f(-100.0), ceil(log2(max(maximum - origin, vec3f(1e-12)) / 255.0)));
    let step = exp2(exponent); let e = vec3u(vec3i(exponent) + vec3i(128));
    bits[start] = bitcast<u32>(origin.x); bits[start + 1u] = bitcast<u32>(origin.y); bits[start + 2u] = bitcast<u32>(origin.z);
    bits[start + 3u] = (e.x & 255u) | ((e.y & 255u) << 8u) | ((e.z & 255u) << 16u);
    for (var child = 0u; child < 8u; child++) {
      bits[start + 4u + child] = 0x80000000u | (perChild << 24u) | (child * perChild);
      let lo = vec3u(clamp(floor((lows[child] - origin) / step), vec3f(0.0), vec3f(255.0)));
      let hi = vec3u(clamp(ceil((highs[child] - origin) / step), vec3f(0.0), vec3f(255.0)));
      bits[start + 12u + child * 2u] = lo.x | (lo.y << 8u) | (lo.z << 16u) | (hi.x << 24u);
      bits[start + 13u + child * 2u] = hi.y | (hi.z << 8u);
    }
  }
  return bits[start];
}
`);

/**
 * The corner table a SQUARE lattice implies — the arithmetic the kernel used
 * to do inline, moved to the CPU so that the plane and mesh cloth paths hand
 * the shader the same shape. Integer division, matching the WGSL it replaces
 * (`(coord·(resolution−1) + 4) / 8`) exactly, so a plane cloth's proxy is
 * unchanged vertex for vertex.
 */
export function gridBvhCorners(resolution) {
  const side = GPU_GRID_BVH_SPAN + 1;
  const corners = new Uint32Array(GPU_GRID_BVH_CORNERS);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const sx = Math.floor((x * (resolution - 1) + 4) / GPU_GRID_BVH_SPAN);
      const sy = Math.floor((y * (resolution - 1) + 4) / GPU_GRID_BVH_SPAN);
      corners[y * side + x] = sy * resolution + sx;
    }
  }
  return corners;
}

// ── §11.58 THE REFIT IS A WORKGROUP, NOT A THREAD (2026-09-11) ─────────────
//
// `giRefitGrid` above runs the whole refit in ONE invocation: 384 dependent
// position loads, 1152 word stores and the box maths, serially. Dispatched
// once per cloth every frame that is ~0.13 ms of GPU each — the build's
// per-pass ledger read the ten Sponza curtains at 1.4 ms a frame, the second
// largest GI item after the resolve, and they vanished entirely with cloth
// proxies off (58 → 69 fps). A stride arm had hidden it behind a world-rate
// change; the ledger did not.
//
// Same words, same conservatism, 128 threads: thread t owns triangle t
// (three loads, nine stores, one min/max), the workgroup reduces the child
// boxes, thread 0 writes the node. `__giGridRefitSerial = true` builds the
// one-thread kernel for an A/B; `smoke:gi-grid-bvh` checks both word for word.
const GRID_REFIT_THREADS = GPU_GRID_BVH_TRIANGLES;

function buildParallelRefit({ bits, absStart, positions, cornerBuffer, arity }) {
  const perChild = GPU_GRID_BVH_TRIANGLES / arity;
  const start = uint(absStart);
  const triLo = workgroupArray('vec3', GRID_REFIT_THREADS);
  const triHi = workgroupArray('vec3', GRID_REFIT_THREADS);
  const childLo = workgroupArray('vec3', arity);
  const childHi = workgroupArray('vec3', arity);
  return Fn(() => {
    const t = localId.x.toVar();
    const cell = t.div(2).toVar();
    const x = cell.mod(8).toVar();
    const y = cell.div(8).toVar();
    const odd = t.mod(2).equal(uint(1));
    // Same two triangles per quad as the serial kernel, same vertex order.
    const ax = x.add(odd.select(uint(1), uint(0))).toVar();
    const ay = y;
    const bx = x;
    const by = y.add(1).toVar();
    const cx = x.add(1).toVar();
    const cy = y.add(odd.select(uint(1), uint(0))).toVar();
    const fetch = (ix, iy) => positions.element(cornerBuffer.element(iy.mul(9).add(ix))).toVar();
    const v0 = fetch(ax, ay), v1 = fetch(bx, by), v2 = fetch(cx, cy);
    const out = start.add(uint(GPU_GRID_BVH_NODE_WORDS)).add(t.mul(9)).toVar();
    const put = (k, v) => {
      bits.element(out.add(uint(k * 3))).assign(floatBitsToUint(v.x));
      bits.element(out.add(uint(k * 3 + 1))).assign(floatBitsToUint(v.y));
      bits.element(out.add(uint(k * 3 + 2))).assign(floatBitsToUint(v.z));
    };
    put(0, v0); put(1, v1); put(2, v2);
    triLo.element(t).assign(min(v0, min(v1, v2)));
    triHi.element(t).assign(max(v0, max(v1, v2)));
    workgroupBarrier();
    If(t.lessThan(uint(arity)), () => {
      const lo = vec3(1e30).toVar();
      const hi = vec3(-1e30).toVar();
      const first = t.mul(uint(perChild)).toVar();
      Loop({ start: uint(0), end: uint(perChild), type: 'uint', condition: '<' }, ({ i }) => {
        lo.assign(min(lo, triLo.element(first.add(i))));
        hi.assign(max(hi, triHi.element(first.add(i))));
      });
      childLo.element(t).assign(lo.sub(vec3(0.00001)));
      childHi.element(t).assign(hi.add(vec3(0.00001)));
    });
    workgroupBarrier();
    If(t.equal(uint(0)), () => {
      const ref = (c) => uint(0x80000000).bitOr(uint((perChild << 24) + c * perChild));
      if (arity === 4) {
        for (let c = 0; c < 4; c++) {
          bits.element(start.add(uint(c))).assign(ref(c));
          const o = start.add(uint(4 + c * 6));
          const lo = childLo.element(uint(c)), hi = childHi.element(uint(c));
          bits.element(o).assign(floatBitsToUint(lo.x));
          bits.element(o.add(uint(1))).assign(floatBitsToUint(lo.y));
          bits.element(o.add(uint(2))).assign(floatBitsToUint(lo.z));
          bits.element(o.add(uint(3))).assign(floatBitsToUint(hi.x));
          bits.element(o.add(uint(4))).assign(floatBitsToUint(hi.y));
          bits.element(o.add(uint(5))).assign(floatBitsToUint(hi.z));
        }
      } else {
        const origin = vec3(1e30).toVar();
        const maximum = vec3(-1e30).toVar();
        for (let c = 0; c < 8; c++) {
          origin.assign(min(origin, childLo.element(uint(c))));
          maximum.assign(max(maximum, childHi.element(uint(c))));
        }
        const exponent = max(vec3(-100), ceil(log2(max(maximum.sub(origin), vec3(1e-12)).div(255)))).toVar();
        const step = exp2(exponent).toVar();
        const e = uvec3(ivec3(exponent).add(ivec3(128))).toVar();
        bits.element(start).assign(floatBitsToUint(origin.x));
        bits.element(start.add(uint(1))).assign(floatBitsToUint(origin.y));
        bits.element(start.add(uint(2))).assign(floatBitsToUint(origin.z));
        bits.element(start.add(uint(3))).assign(
          e.x.bitAnd(uint(255)).bitOr(e.y.bitAnd(uint(255)).shiftLeft(uint(8))).bitOr(e.z.bitAnd(uint(255)).shiftLeft(uint(16))),
        );
        for (let c = 0; c < 8; c++) {
          bits.element(start.add(uint(4 + c))).assign(ref(c));
          const lo = uvec3(clamp(floor(childLo.element(uint(c)).sub(origin).div(step)), vec3(0), vec3(255))).toVar();
          const hi = uvec3(clamp(ceil(childHi.element(uint(c)).sub(origin).div(step)), vec3(0), vec3(255))).toVar();
          bits.element(start.add(uint(12 + c * 2))).assign(
            lo.x.bitOr(lo.y.shiftLeft(uint(8))).bitOr(lo.z.shiftLeft(uint(16))).bitOr(hi.x.shiftLeft(uint(24))),
          );
          bits.element(start.add(uint(13 + c * 2))).assign(hi.y.bitOr(hi.z.shiftLeft(uint(8))));
        }
      }
    });
  })().compute(GRID_REFIT_THREADS, [GRID_REFIT_THREADS, 1, 1]);
}

/**
 * @param {object} options
 * @param {*} options.positionAttribute    the solver's live GPU positions
 * @param {?number} [options.resolution]   square-lattice side (plane cloth)
 * @param {?Uint32Array} [options.corners] explicit 9×9 corner table (mesh cloth);
 *                                         takes precedence over `resolution`
 */
export function createGpuGridBvh({ bits, absStart, positionAttribute, resolution, corners = null, arity = 8 }) {
  if (![4, 8].includes(arity)) throw new Error('GPU grid BVH requires arity 4 or 8');
  const count = positionAttribute?.count ?? 0;
  const table = corners ?? (Number.isInteger(resolution) && resolution >= 2 && count === resolution * resolution
    ? gridBvhCorners(resolution)
    : null);
  if (!table) throw new Error('GPU grid BVH requires square grid positions or an explicit corner table');
  if (table.length !== GPU_GRID_BVH_CORNERS) {
    throw new Error(`GPU grid BVH corner table must hold ${GPU_GRID_BVH_CORNERS} indices, got ${table.length}`);
  }
  // An out-of-range index reads past the positions buffer, which on WebGPU is
  // clamped rather than faulted — a silent proxy pinned to the last vertex.
  // Caught here instead, where it names the caller that built the table.
  for (let i = 0; i < table.length; i++) {
    if (!(table[i] < count)) throw new Error(`GPU grid BVH corner ${i} is vertex ${table[i]} of ${count}`);
  }
  const positions = storage(positionAttribute, 'vec3', count);
  const cornerBuffer = instancedArray(table instanceof Uint32Array ? table : Uint32Array.from(table), 'uint');
  const compute = globalThis.__giGridRefitSerial === true
    ? Fn(() => {
        bits.element(uint(absStart)).assign(refit({ positions, corners: cornerBuffer, bits, start: uint(absStart), arity: uint(arity) }));
      })().compute(1)
    : buildParallelRefit({ bits, absStart, positions, cornerBuffer, arity });
  return { compute, computes: [compute], nodeWords: GPU_GRID_BVH_NODE_WORDS,
    wordCount: GPU_GRID_BVH_WORDS, triangleCount: GPU_GRID_BVH_TRIANGLES, corners: table };
}
