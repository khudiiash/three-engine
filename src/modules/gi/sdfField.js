import {
  Fn,
  If,
  storage,
  textureStore,
  instanceIndex,
  float,
  int,
  uint,
  vec3,
  vec4,
  ivec3,
  dot,
  min,
  clamp,
  sqrt,
} from "three/tsl";

/**
 * Unsigned distance field derived from the LIVE GPU voxel grid.
 *
 * The previous chamfer relaxation advanced the field by only a couple of
 * voxels per frame. Moving an object therefore left its old shadow behind
 * while the new distance field slowly grew outward. This implementation uses
 * a complete 3D jump-flood rebuild: occupied voxels seed their own grid
 * coordinate, then log2(resolution) passes propagate the nearest seed from
 * large jumps down to one voxel. The whole field is complete before it is
 * published, so dynamic casters update atomically.
 *
 * Seed buffers store xyz = nearest occupied voxel coordinate, w = validity.
 * Published distances are measured in voxels and clamped to SDF_MAX. The
 * field is unsigned because GI/shadow rays always start outside geometry.
 */

export const SDF_MAX = 16;
// Kept for compatibility with code importing the old amortized-field API.
export const SDF_ITERATIONS_PER_FRAME = 0;
export const SDF_CONVERGE_FRAMES = 1;

function jumpSequence(dims) {
  const largest = Math.max(dims.x, dims.y, dims.z);
  let jump = 1;
  while (jump < largest) jump *= 2;
  jump = Math.max(1, jump / 2);
  const result = [];
  for (; jump >= 1; jump /= 2) result.push(jump);
  // A second unit pass repairs the small diagonal holes that plain JFA can
  // leave, while still completing in one frame.
  result.push(1);
  return result;
}

/**
 * Builds one complete JFA SDF pipeline:
 *   seedNode       live occupancy -> nearest-seed A
 *   jumpNodes[]    ping-pong nearest-seed propagation
 *   publishNode    final nearest seed -> filterable 3D distance texture
 */
export function createSDFNodes({ dims, buffers, sdfTexture }) {
  const voxelCount = dims.x * dims.y * dims.z;
  const voxAlbedo = storage(buffers.voxAlbedo, "uint", voxelCount);
  const seedA = storage(buffers.sdfSeedA, "vec4", voxelCount);
  const seedB = storage(buffers.sdfSeedB, "vec4", voxelCount);

  const decompose = (vi) => {
    const z = vi.div(uint(dims.x * dims.y));
    const rem = vi.sub(z.mul(uint(dims.x * dims.y)));
    const y = rem.div(uint(dims.x));
    const x = rem.sub(y.mul(uint(dims.x)));
    return { x, y, z };
  };

  const seedNode = Fn(() => {
    const vi = instanceIndex;
    If(vi.lessThan(uint(voxelCount)), () => {
      const { x, y, z } = decompose(vi);
      const occupied = voxAlbedo
        .element(vi)
        .shiftRight(uint(24))
        .greaterThan(uint(0));
      seedA
        .element(vi)
        .assign(
          occupied.select(
            vec4(x.toFloat(), y.toFloat(), z.toFloat(), 1),
            vec4(0),
          ),
        );
    });
  })().compute(voxelCount);

  const makeJumpNode = (src, dst, jump) =>
    Fn(() => {
      const vi = instanceIndex;
      If(vi.lessThan(uint(voxelCount)), () => {
        const { x, y, z } = decompose(vi);
        const coord = vec3(x.toFloat(), y.toFloat(), z.toFloat());
        const bestSeed = src.element(vi).toVar();
        const bestDistanceSq = float(1e20).toVar();
        If(bestSeed.w.greaterThan(0.5), () => {
          const delta = bestSeed.xyz.sub(coord);
          bestDistanceSq.assign(dot(delta, delta));
        });

        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              const nx = clamp(
                x.toInt().add(int(dx * jump)),
                int(0),
                int(dims.x - 1),
              );
              const ny = clamp(
                y.toInt().add(int(dy * jump)),
                int(0),
                int(dims.y - 1),
              );
              const nz = clamp(
                z.toInt().add(int(dz * jump)),
                int(0),
                int(dims.z - 1),
              );
              const ni = nx
                .add(ny.mul(int(dims.x)))
                .add(nz.mul(int(dims.x * dims.y)))
                .toUint();
              const candidate = src.element(ni).toVar();
              const delta = candidate.xyz.sub(coord);
              const distanceSq = dot(delta, delta);
              If(
                candidate.w
                  .greaterThan(0.5)
                  .and(distanceSq.lessThan(bestDistanceSq)),
                () => {
                  bestSeed.assign(candidate);
                  bestDistanceSq.assign(distanceSq);
                },
              );
            }
          }
        }
        dst.element(vi).assign(bestSeed);
      });
    })().compute(voxelCount);

  const jumpNodes = [];
  let src = seedA;
  let dst = seedB;
  for (const jump of jumpSequence(dims)) {
    jumpNodes.push(makeJumpNode(src, dst, jump));
    [src, dst] = [dst, src];
  }
  const finalSeeds = src;

  const publishNode = Fn(() => {
    const vi = instanceIndex;
    If(vi.lessThan(uint(voxelCount)), () => {
      const { x, y, z } = decompose(vi);
      const coord = vec3(x.toFloat(), y.toFloat(), z.toFloat());
      const seed = finalSeeds.element(vi).toVar();
      const distance = float(SDF_MAX).toVar();
      If(seed.w.greaterThan(0.5), () => {
        const delta = seed.xyz.sub(coord);
        distance.assign(min(sqrt(dot(delta, delta)), float(SDF_MAX)));
      });
      textureStore(
        sdfTexture,
        ivec3(x.toInt(), y.toInt(), z.toInt()),
        vec4(distance),
      ).toWriteOnly();
    });
  })().compute(voxelCount);

  return {
    seedNode,
    jumpNodes,
    publishNode,
    // Compatibility aliases for the old experimental callers.
    resetNode: seedNode,
    iterateABNode: jumpNodes[0],
    iterateBANode: jumpNodes[1] ?? jumpNodes[0],
  };
}
