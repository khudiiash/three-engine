import { Fn, storage, uint, wgslFn } from 'three/tsl';

// A bounded transport proxy, sampled from the rendered GPU positions. It fits
// the existing dynamic BVH pool: no additional binding in any GI ray shader.
export const GPU_GRID_BVH_NODE_WORDS = 28;
export const GPU_GRID_BVH_TRIANGLES = 128;
export const GPU_GRID_BVH_WORDS = GPU_GRID_BVH_NODE_WORDS + GPU_GRID_BVH_TRIANGLES * 9;

const refit = wgslFn(/* wgsl */ `
fn giRefitGrid(
  positions: ptr<storage, array<vec3f>, read_write>,
  bits: ptr<storage, array<u32>, read_write>,
  start: u32, resolution: u32, arity: u32
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
      let sample = (coords[vertex] * (resolution - 1u) + vec2u(4u)) / vec2u(8u);
      let p = positions[sample.y * resolution + sample.x];
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

export function createGpuGridBvh({ bits, absStart, positionAttribute, resolution, arity = 8 }) {
  if (![4, 8].includes(arity)) throw new Error('GPU grid BVH requires arity 4 or 8');
  if (!Number.isInteger(resolution) || resolution < 2 || positionAttribute?.count !== resolution * resolution) {
    throw new Error('GPU grid BVH requires square grid positions');
  }
  const positions = storage(positionAttribute, 'vec3', resolution * resolution);
  const compute = Fn(() => {
    bits.element(uint(absStart)).assign(refit({ positions, bits, start: uint(absStart), resolution: uint(resolution), arity: uint(arity) }));
  })().compute(1);
  return { compute, computes: [compute], nodeWords: GPU_GRID_BVH_NODE_WORDS,
    wordCount: GPU_GRID_BVH_WORDS, triangleCount: GPU_GRID_BVH_TRIANGLES };
}
