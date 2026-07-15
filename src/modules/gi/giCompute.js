import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  Break,
  uniform,
  storage,
  texture,
  texture3D,
  textureStore,
  instanceIndex,
  float,
  int,
  uint,
  vec2,
  vec3,
  vec4,
  ivec2,
  ivec3,
  abs,
  dot,
  max,
  min,
  clamp,
  floor,
  fract,
  normalize,
  sign,
  mix,
  pow,
  log2,
  step,
  cross,
  reflect,
  positionWorld,
  normalWorld,
  cameraPosition,
  materialRoughness,
  vertexStage,
  sin,
} from "three/tsl";

/**
 * GPU side of the GI module.
 *
 * World representation (rebuilt only when the scene changes, CPU-side):
 * packed albedo/normal voxel buffers. Every frame, on the GPU:
 *
 *   inject     — per voxel: direct sunlight (voxel-marched shadow ray) plus
 *                last frame's probe irradiance (multi-bounce feedback),
 *                times albedo → radiance buffer (alpha = occupancy).
 *   mip chain  — the radiance buffer is downsampled into a pyramid
 *                (alpha-weighted 2×2×2 averages, storage buffers), then
 *                copied into one 3D atlas texture with the levels laid out
 *                side by side along X. Buffers do the read/write legwork so
 *                no pass ever samples and stores the same subresource.
 *   trace/     — a round-robin window of probes ray-marches the voxel grid
 *   integrate    and integrates octahedral irradiance. Probes only feed the
 *                multi-bounce loop and are cheap; pixels never sample them
 *                directly anymore.
 *
 * Material side (per pixel, via the GI light node): VXGI-style cone tracing
 * through the radiance atlas — 6 diffuse cones give colored bounce AND
 * occlusion (a blocked cone loses its sky term, which is what darkens
 * corners), plus one optional specular cone whose aperture follows material
 * roughness for reflections. Diffuse adds to `context.irradiance`, specular
 * to `context.radiance` — the exact slots ambient lights and environment
 * maps use, so every lit material participates with no per-material wiring.
 */

export const RAYS_PER_PROBE = 64;
export const OCTA_RES = 8; // 8×8 irradiance texels per probe
export const MIP_GAP = 2; // empty texels between atlas levels (stops filter bleed)

/** Spherical Fibonacci direction set, precomputed on CPU (vec4-padded). */
export function fibonacciDirections(n) {
  const out = new Float32Array(n * 4);
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = phi * i;
    out[i * 4] = Math.cos(a) * r;
    out[i * 4 + 1] = y;
    out[i * 4 + 2] = Math.sin(a) * r;
  }
  return out;
}

/** CPU octahedral decode for one texel center of an OCTA_RES×OCTA_RES tile. */
export function octaTexelDirection(tx, ty) {
  let u = ((tx + 0.5) / OCTA_RES) * 2 - 1;
  let v = ((ty + 0.5) / OCTA_RES) * 2 - 1;
  let x = u;
  let y = v;
  let z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    const ox = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const oy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = ox;
    y = oy;
  }
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/** All 64 octa texel directions as a vec4-padded Float32Array. */
export function octaTexelDirections() {
  const out = new Float32Array(OCTA_RES * OCTA_RES * 4);
  for (let ty = 0; ty < OCTA_RES; ty++) {
    for (let tx = 0; tx < OCTA_RES; tx++) {
      const [x, y, z] = octaTexelDirection(tx, ty);
      const i = (ty * OCTA_RES + tx) * 4;
      out[i] = x;
      out[i + 1] = y;
      out[i + 2] = z;
    }
  }
  return out;
}

/**
 * Mip pyramid layout for a voxel grid: level dims, flat offsets into the
 * mip storage buffer (levels ≥ 1), and X offsets inside the 3D atlas
 * texture. Coarsest level stops around 4 voxels on the longest axis.
 */
export function computeMipLevels(dims) {
  const levels = [];
  let d = { ...dims };
  let bufOffset = 0;
  let atlasX = 0;
  for (let i = 0; i < 8; i++) {
    levels.push({ dims: d, bufOffset: i === 0 ? -1 : bufOffset, atlasX });
    if (i > 0) bufOffset += d.x * d.y * d.z;
    atlasX += d.x + MIP_GAP;
    if (Math.max(d.x, d.y, d.z) <= 4) break;
    d = { x: Math.max(1, d.x >> 1), y: Math.max(1, d.y >> 1), z: Math.max(1, d.z >> 1) };
  }
  return {
    levels,
    mipTexelCount: bufOffset,
    atlasDims: { x: atlasX - MIP_GAP, y: dims.y, z: dims.z },
  };
}

// 6-cone diffuse set (tangent space, +Z = normal): one along the normal,
// five ringed at ~45°. Weights ≈ cosine lobe share, pre-normalized.
const DIFFUSE_CONES = (() => {
  const cones = [{ dir: [0, 0, 1], w: 0.25 }];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    cones.push({ dir: [Math.cos(a) * 0.7071, Math.sin(a) * 0.7071, 0.7071], w: 0.15 });
  }
  return cones;
})();
export const DIFFUSE_CONE_APERTURE = 0.577; // tan(30°) — the 6-cone standard

// Lite set for outer cascades: 4 wide cones. Outer cascades only carry
// low-frequency distant light, so fewer/wider cones look identical while
// roughly halving both the WGSL each material compiles and the per-pixel
// cost in cascade blend zones.
const LITE_CONES = (() => {
  const cones = [{ dir: [0, 0, 1], w: 0.31 }];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    cones.push({ dir: [Math.cos(a) * 0.766, Math.sin(a) * 0.766, 0.643], w: 0.23 });
  }
  return cones;
})();
export const LITE_CONE_APERTURE = 1.0; // tan(45°)

/**
 * Builds every GPU node for one GI volume configuration.
 *
 * cfg: {
 *   dims, counts, probesPerFrame, tilesPerRow, atlasW, atlasH,   — shapes
 *   mip: computeMipLevels(dims) result,
 *   coneSteps, reflections,                                       — quality
 *   buffers: { voxAlbedo, voxNormal, radiance, mips, mipInfo,
 *              rays, irradiance, rayDirs, texelDirs },
 *   atlas          — StorageTexture (probe octa atlas, rgba16f)
 *   radianceAtlas  — Storage3DTexture (mip pyramid, rgba16f)
 * }
 */
export function createGINodes(cfg) {
  const { dims, counts, probesPerFrame, tilesPerRow, atlasW, atlasH, mip } = cfg;
  const baseConeSteps = Math.max(4, Math.min(32, cfg.coneSteps ?? 10));
  // Outer (lite) cascades carry only low-frequency distant light through 4×
  // larger voxels, so they converge in far fewer marches. Halving their step
  // count is invisible but meaningfully cheaper — it thins the per-fragment
  // cost most in the cascade blend zones, where both stacks are traced.
  const coneSteps = cfg.lite ? Math.max(4, Math.round(baseConeSteps / 2)) : baseConeSteps;
  const voxelCount = dims.x * dims.y * dims.z;
  const probeCount = counts.x * counts.y * counts.z;
  const levelCount = mip.levels.length;

  const u = {
    gridMin: uniform(new THREE.Vector3(0, 0, 0)),
    voxelSize: uniform(1),
    spacing: uniform(new THREE.Vector3(1, 1, 1)), // probe spacing per axis
    sunDir: uniform(new THREE.Vector3(0, -1, 0)), // direction light TRAVELS
    sunColor: uniform(new THREE.Color(0, 0, 0)), // premultiplied by intensity
    skyColor: uniform(new THREE.Color(0.5, 0.7, 1)), // premultiplied
    baseProbe: uniform(0, "uint"), // round-robin window start
    hysteresis: uniform(0.9),
    bounce: uniform(1),
    intensity: uniform(1),
    normalBias: uniform(0.4),
    reflectionIntensity: uniform(1),
    aoStrength: uniform(1),
    probeShift: uniform(new THREE.Vector3(0, 0, 0)), // recenter shift, probe indices
    reseedSky: uniform(0), // 1 = teleport (seed exposed probes from sky), 0 = edge-extend
  };

  const voxAlbedo = storage(cfg.buffers.voxAlbedo, "uint", voxelCount);
  const voxNormal = storage(cfg.buffers.voxNormal, "uint", voxelCount);
  const voxEmissive = storage(cfg.buffers.voxEmissive, "uint", voxelCount);
  const voxDirect = storage(cfg.buffers.voxDirect, "uint", voxelCount);
  const radiance = storage(cfg.buffers.radiance, "vec4", voxelCount);
  const mips = storage(cfg.buffers.mips, "vec4", Math.max(1, mip.mipTexelCount));
  const rays = storage(cfg.buffers.rays, "vec4", probesPerFrame * RAYS_PER_PROBE);
  const irradiance = storage(cfg.buffers.irradiance, "vec4", probeCount * OCTA_RES * OCTA_RES);
  const rayDirs = storage(cfg.buffers.rayDirs, "vec4", RAYS_PER_PROBE);
  const texelDirs = storage(cfg.buffers.texelDirs, "vec4", OCTA_RES * OCTA_RES);
  const probeScratch = storage(cfg.buffers.probeScratch, "vec4", probeCount * OCTA_RES * OCTA_RES);
  const atlasTex = texture(cfg.atlas);
  const radianceTex = texture3D(cfg.radianceAtlas);

  // ---- shared TSL helpers -------------------------------------------------

  const unpack888 = (packed) =>
    vec3(
      packed.bitAnd(uint(255)).toFloat(),
      packed.shiftRight(uint(8)).bitAnd(uint(255)).toFloat(),
      packed.shiftRight(uint(16)).bitAnd(uint(255)).toFloat(),
    ).div(255);

  // sign that never returns 0 (octahedral seams need ±1)
  const signNotZero = (x) => sign(sign(x).add(0.5));

  // direction → octahedral uv in [0,1]²
  const octaEncode = Fn(([dir]) => {
    const d = dir.div(abs(dir.x).add(abs(dir.y)).add(abs(dir.z)));
    const result = vec2(d.x, d.y).toVar();
    If(d.z.lessThan(0), () => {
      result.assign(
        vec2(
          float(1).sub(abs(d.y)).mul(signNotZero(d.x)),
          float(1).sub(abs(d.x)).mul(signNotZero(d.y)),
        ),
      );
    });
    return result.mul(0.5).add(0.5);
  });

  // world position → voxel-grid coords (float); callers bounds-check
  const toVoxelSpace = (p) => p.sub(u.gridMin).div(u.voxelSize);

  const inBounds = (g) =>
    g.x
      .greaterThanEqual(0)
      .and(g.y.greaterThanEqual(0))
      .and(g.z.greaterThanEqual(0))
      .and(g.x.lessThan(dims.x))
      .and(g.y.lessThan(dims.y))
      .and(g.z.lessThan(dims.z));

  const voxelLinear = (g) => {
    const c = floor(g);
    return c.x.add(c.y.mul(dims.x)).add(c.z.mul(dims.x * dims.y)).toUint();
  };

  const MARCH_STEPS = Math.min(160, Math.ceil(Math.max(dims.x, dims.y, dims.z) * 1.5));

  // March from `origin` along `dir`; returns vec4(radiance, hitFlag).
  const marchRadiance = Fn(([origin, dir]) => {
    const result = vec4(u.skyColor, 0).toVar();
    const pos = origin.toVar();
    const stepVec = dir.mul(u.voxelSize.mul(0.75)).toVar();
    Loop(MARCH_STEPS, () => {
      pos.addAssign(stepVec);
      const g = toVoxelSpace(pos).toVar();
      If(inBounds(g).not(), () => {
        Break();
      });
      const vi = voxelLinear(g);
      If(voxAlbedo.element(vi).shiftRight(uint(24)).greaterThan(uint(0)), () => {
        result.assign(vec4(radiance.element(vi).xyz, 1));
        Break();
      });
    });
    return result;
  });

  // Occlusion-only march toward the sun. 1 = lit, 0 = shadowed.
  const SHADOW_STEPS = Math.min(96, Math.ceil(Math.max(dims.x, dims.y, dims.z) * 1.2));
  const marchShadow = Fn(([origin, dirToLight]) => {
    const lit = float(1).toVar();
    const pos = origin.toVar();
    const stepVec = dirToLight.mul(u.voxelSize.mul(1.0)).toVar();
    Loop(SHADOW_STEPS, () => {
      pos.addAssign(stepVec);
      const g = toVoxelSpace(pos).toVar();
      If(inBounds(g).not(), () => {
        Break();
      });
      If(voxAlbedo.element(voxelLinear(g)).shiftRight(uint(24)).greaterThan(uint(0)), () => {
        lit.assign(0);
        Break();
      });
    });
    return lit;
  });

  // probe linear index → world position
  const probePosition = (pi) => {
    const cxy = uint(counts.x * counts.y);
    const z = pi.div(cxy);
    const rem = pi.sub(z.mul(cxy));
    const y = rem.div(uint(counts.x));
    const x = rem.sub(y.mul(uint(counts.x)));
    return u.gridMin.add(vec3(x.toFloat(), y.toFloat(), z.toFloat()).mul(u.spacing));
  };

  // probe linear index (float) + octa uv → probe-atlas uv in [0,1]²
  const atlasUV = (probeIdxF, octaUv) => {
    const tileY = floor(probeIdxF.div(tilesPerRow));
    const tileX = probeIdxF.sub(tileY.mul(tilesPerRow));
    const texel = vec2(tileX, tileY)
      .mul(OCTA_RES)
      .add(0.5)
      .add(octaUv.mul(OCTA_RES - 1));
    return texel.div(vec2(atlasW, atlasH));
  };

  // ---- pass 1a: direct sunlight (heavy, cached) -----------------------------
  // The per-voxel shadow march is by far the most expensive per-frame work,
  // and its inputs only change when the sun moves or voxels change. It runs
  // on demand into a packed cache; the every-frame inject pass below is a
  // cheap combine. Packed RGB8 at 1/8 scale (same scheme as emissive).

  const packRGB8x8 = (v) => {
    const c = clamp(v.mul(1 / 8), 0, 1).mul(255).add(0.5);
    return c.x
      .toUint()
      .bitOr(c.y.toUint().shiftLeft(uint(8)))
      .bitOr(c.z.toUint().shiftLeft(uint(16)));
  };

  const injectDirectNode = Fn(() => {
    const vi = instanceIndex;
    If(vi.lessThan(uint(voxelCount)), () => {
      const packed = voxAlbedo.element(vi);
      If(packed.shiftRight(uint(24)).equal(uint(0)), () => {
        voxDirect.element(vi).assign(uint(0));
      }).Else(() => {
        const N = normalize(unpack888(voxNormal.element(vi)).mul(2).sub(1));
        const zc = vi.div(uint(dims.x * dims.y));
        const rem = vi.sub(zc.mul(uint(dims.x * dims.y)));
        const yc = rem.div(uint(dims.x));
        const xc = rem.sub(yc.mul(uint(dims.x)));
        const center = u.gridMin.add(
          vec3(xc.toFloat(), yc.toFloat(), zc.toFloat()).add(0.5).mul(u.voxelSize),
        );

        const toLight = u.sunDir.negate();
        const nDotL = max(dot(N, toLight), 0).toVar();
        const direct = vec3(0).toVar();
        If(nDotL.greaterThan(0), () => {
          // 2-voxel lift: shadow acne on the voxel grid shows up as speckled
          // radiance, which the mip chain smears into dirty-looking bleed.
          // Per-voxel lateral dither on the shadow ray breaks the razor-hard
          // voxel shadow edge — the mip chain then averages the dithered
          // boundary into a soft penumbra instead of a dirty straight band.
          const h1 = fract(sin(vi.toFloat().mul(12.9898)).mul(43758.5453));
          const h2 = fract(sin(vi.toFloat().mul(78.233)).mul(12345.6789));
          const sT = normalize(cross(toLight, vec3(0.577, 0.5774, 0.5773)));
          const sB = cross(toLight, sT);
          const dither = sT.mul(h1.sub(0.5)).add(sB.mul(h2.sub(0.5))).mul(u.voxelSize.mul(1.5));
          const origin = center.add(N.mul(u.voxelSize.mul(2.0))).add(dither);
          // Lambertian: outgoing radiance = albedo·E/π. Without the 1/π the
          // bounce is ~3× hot and sunlit floors bloom white onto neighbours.
          direct.assign(
            u.sunColor.mul(nDotL).mul(marchShadow(origin, toLight)).mul(1 / Math.PI),
          );
        });
        voxDirect.element(vi).assign(packRGB8x8(direct));
      });
    });
  })().compute(voxelCount);

  // ---- pass 1b: radiance combine (cheap, every update frame) ----------------

  const injectNode = Fn(() => {
    const vi = instanceIndex;
    If(vi.lessThan(uint(voxelCount)), () => {
      const packed = voxAlbedo.element(vi);
      If(packed.shiftRight(uint(24)).equal(uint(0)), () => {
        radiance.element(vi).assign(vec4(0));
      }).Else(() => {
        const albedo = unpack888(packed);
        const N = normalize(unpack888(voxNormal.element(vi)).mul(2).sub(1));
        const zc = vi.div(uint(dims.x * dims.y));
        const rem = vi.sub(zc.mul(uint(dims.x * dims.y)));
        const yc = rem.div(uint(dims.x));
        const xc = rem.sub(yc.mul(uint(dims.x)));
        const center = u.gridMin.add(
          vec3(xc.toFloat(), yc.toFloat(), zc.toFloat()).add(0.5).mul(u.voxelSize),
        );

        const direct = unpack888(voxDirect.element(vi)).mul(8);

        // Multi-bounce feedback: last frame's irradiance at the nearest
        // probe, in the voxel's normal direction.
        const pg = clamp(
          center.sub(u.gridMin).div(u.spacing).add(0.5),
          vec3(0),
          vec3(counts.x - 1, counts.y - 1, counts.z - 1),
        );
        const pc = floor(pg);
        const probeIdx = pc.x
          .add(pc.y.mul(counts.x))
          .add(pc.z.mul(counts.x * counts.y))
          .toUint();
        const octa = floor(octaEncode(N).mul(OCTA_RES - 0.001));
        const texelIdx = octa.y.mul(OCTA_RES).add(octa.x).toUint();
        // Fixed 0.95 gain — NEVER a user knob. This term feeds back into
        // itself (probes light voxels light probes…); any gain ≥ 1/albedo
        // diverges and the scene integrates to white over a few seconds.
        // The user-facing `bounce` boost is applied outside the loop, at
        // the cone gather, where it scales linearly instead of compounding.
        const bounceIrr = irradiance
          .element(probeIdx.mul(uint(OCTA_RES * OCTA_RES)).add(texelIdx))
          .xyz.mul(0.95);

        // Emissive surfaces are light sources: added on top of reflected
        // light (not scaled by albedo — it's emitted, not bounced). The
        // probe feedback then propagates it, so emissives get multi-bounce
        // and show up in reflections with no extra passes.
        const emissive = unpack888(voxEmissive.element(vi)).mul(8); // EMISSIVE_SCALE
        radiance.element(vi).assign(vec4(albedo.mul(direct.add(bounceIrr)).add(emissive), 1));
      });
    });
  })().compute(voxelCount);

  // ---- mip pyramid: downsample passes (buffers) + atlas copy passes -------

  const readLevel = (level, linearIdx) =>
    level === 0 ? radiance.element(linearIdx) : mips.element(uint(mip.levels[level].bufOffset).add(linearIdx));

  const mipPasses = [];
  for (let li = 1; li < levelCount; li++) {
    const dst = mip.levels[li].dims;
    const src = mip.levels[li - 1].dims;
    const dstCount = dst.x * dst.y * dst.z;
    mipPasses.push(
      Fn(() => {
        const ti = instanceIndex;
        If(ti.lessThan(uint(dstCount)), () => {
          const z = ti.div(uint(dst.x * dst.y));
          const rem = ti.sub(z.mul(uint(dst.x * dst.y)));
          const y = rem.div(uint(dst.x));
          const x = rem.sub(y.mul(uint(dst.x)));

          const rgbSum = vec3(0).toVar();
          const aSum = float(0).toVar();
          for (let dz = 0; dz <= 1; dz++) {
            for (let dy = 0; dy <= 1; dy++) {
              for (let dx = 0; dx <= 1; dx++) {
                const sx = min(x.mul(uint(2)).add(uint(dx)), uint(src.x - 1));
                const sy = min(y.mul(uint(2)).add(uint(dy)), uint(src.y - 1));
                const sz = min(z.mul(uint(2)).add(uint(dz)), uint(src.z - 1));
                const si = sx.add(sy.mul(uint(src.x))).add(sz.mul(uint(src.x * src.y)));
                const s = readLevel(li - 1, si);
                rgbSum.addAssign(s.xyz.mul(s.w));
                aSum.addAssign(s.w);
              }
            }
          }
          const rgb = rgbSum.div(max(aSum, 1e-4));
          mips
            .element(uint(mip.levels[li].bufOffset).add(ti))
            .assign(vec4(rgb, aSum.div(8)));
        });
      })().compute(dstCount),
    );
  }

  // One dispatch publishes the whole pyramid to the 3D atlas: each thread
  // resolves its level from baked offsets. One pipeline instead of one per
  // level — fewer compile stalls at launch, fewer dispatches per frame.
  const levelStarts = [];
  let copyTotal = 0;
  for (let li = 0; li < levelCount; li++) {
    levelStarts.push(copyTotal);
    const d = mip.levels[li].dims;
    copyTotal += d.x * d.y * d.z;
  }
  const copyNode = Fn(() => {
    const ti = instanceIndex;
    for (let li = 0; li < levelCount; li++) {
      const d = mip.levels[li].dims;
      const start = levelStarts[li];
      const count = d.x * d.y * d.z;
      const offX = mip.levels[li].atlasX;
      If(ti.greaterThanEqual(uint(start)).and(ti.lessThan(uint(start + count))), () => {
        const local = ti.sub(uint(start));
        const z = local.div(uint(d.x * d.y));
        const rem = local.sub(z.mul(uint(d.x * d.y)));
        const y = rem.div(uint(d.x));
        const x = rem.sub(y.mul(uint(d.x)));
        const val = readLevel(li, local);
        textureStore(
          cfg.radianceAtlas,
          ivec3(x.toInt().add(int(offX)), y.toInt(), z.toInt()),
          val,
        ).toWriteOnly();
      });
    }
  })().compute(copyTotal);

  // ---- probe passes (multi-bounce feedback loop) ---------------------------

  const traceCount = probesPerFrame * RAYS_PER_PROBE;
  const traceNode = Fn(() => {
    const slot = instanceIndex;
    If(slot.lessThan(uint(traceCount)), () => {
      const probeSlot = slot.div(uint(RAYS_PER_PROBE));
      const rayIdx = slot.sub(probeSlot.mul(uint(RAYS_PER_PROBE)));
      const probeIdx = u.baseProbe.add(probeSlot).mod(uint(probeCount));
      const dir = rayDirs.element(rayIdx).xyz;
      const origin = probePosition(probeIdx).add(dir.mul(u.voxelSize.mul(0.5)));
      rays.element(slot).assign(marchRadiance(origin, dir));
    });
  })().compute(traceCount);

  const TEXELS = OCTA_RES * OCTA_RES;
  const integrateCount = probesPerFrame * TEXELS;
  const integrateNode = Fn(() => {
    const slot = instanceIndex;
    If(slot.lessThan(uint(integrateCount)), () => {
      const probeSlot = slot.div(uint(TEXELS));
      const texelIdx = slot.sub(probeSlot.mul(uint(TEXELS)));
      const probeIdx = u.baseProbe.add(probeSlot).mod(uint(probeCount));
      const texelDir = texelDirs.element(texelIdx).xyz;

      const sum = vec3(0).toVar();
      const wsum = float(0).toVar();
      Loop(RAYS_PER_PROBE, ({ i }) => {
        const rd = rayDirs.element(i).xyz;
        const w = max(dot(texelDir, rd), 0);
        sum.addAssign(rays.element(probeSlot.mul(uint(RAYS_PER_PROBE)).add(i.toUint())).xyz.mul(w));
        wsum.addAssign(w);
      });
      const fresh = sum.div(max(wsum, 1e-4));

      const dst = probeIdx.mul(uint(TEXELS)).add(texelIdx);
      const blended = mix(fresh, irradiance.element(dst).xyz, u.hysteresis);
      irradiance.element(dst).assign(vec4(blended, 1));

      const tileY = probeIdx.div(uint(tilesPerRow));
      const tileX = probeIdx.sub(tileY.mul(uint(tilesPerRow)));
      const ty = texelIdx.div(uint(OCTA_RES));
      const tx = texelIdx.sub(ty.mul(uint(OCTA_RES)));
      const coord = ivec2(
        tileX.mul(uint(OCTA_RES)).add(tx).toInt(),
        tileY.mul(uint(OCTA_RES)).add(ty).toInt(),
      );
      textureStore(cfg.atlas, coord, vec4(blended, 1)).toWriteOnly();
    });
  })().compute(integrateCount);

  // ---- probe clipmap scrolling ---------------------------------------------
  // On recenter, surviving probes keep their converged irradiance by moving
  // within the grid (gather via a scratch copy — a parallel in-place shift
  // would race). Freshly exposed probes seed from a dim sky guess and
  // converge over the next round-robin sweeps. The apply pass also rewrites
  // the octa atlas so materials never sample stale tiles.
  const probeTotal = probeCount * TEXELS;

  const probeShiftSaveNode = Fn(() => {
    const i = instanceIndex;
    If(i.lessThan(uint(probeTotal)), () => {
      probeScratch.element(i).assign(irradiance.element(i));
    });
  })().compute(probeTotal);

  const probeShiftApplyNode = Fn(() => {
    const slot = instanceIndex;
    If(slot.lessThan(uint(probeTotal)), () => {
      const probeIdx = slot.div(uint(TEXELS));
      const texelIdx = slot.sub(probeIdx.mul(uint(TEXELS)));
      const cxy = uint(counts.x * counts.y);
      const z = probeIdx.div(cxy);
      const rem = probeIdx.sub(z.mul(cxy));
      const y = rem.div(uint(counts.x));
      const x = rem.sub(y.mul(uint(counts.x)));
      const src = vec3(x.toFloat(), y.toFloat(), z.toFloat()).add(u.probeShift);

      // Edge-extend: a probe scrolled in from outside the old grid copies the
      // nearest surviving probe's already-converged irradiance instead of a
      // dark sky guess that then slowly refills. That refill-from-black is the
      // "pieces randomly flickering here and there" during camera motion — the
      // clamped copy makes the newly exposed band start close to correct and
      // only refine, so a recenter is visually seamless. On a genuine teleport
      // (nothing survives) `reseedSky` switches back to the sky seed.
      const clampedSrc = clamp(
        src,
        vec3(0),
        vec3(counts.x - 1, counts.y - 1, counts.z - 1),
      );
      const srcIdx = clampedSrc.x
        .add(clampedSrc.y.mul(counts.x))
        .add(clampedSrc.z.mul(counts.x * counts.y))
        .toUint();
      const edgeVal = probeScratch.element(srcIdx.mul(uint(TEXELS)).add(texelIdx));
      const v = mix(edgeVal, vec4(u.skyColor.mul(0.5), 1), u.reseedSky).toVar();
      irradiance.element(slot).assign(v);

      const tileY = probeIdx.div(uint(tilesPerRow));
      const tileX = probeIdx.sub(tileY.mul(uint(tilesPerRow)));
      const ty = texelIdx.div(uint(OCTA_RES));
      const tx = texelIdx.sub(ty.mul(uint(OCTA_RES)));
      textureStore(
        cfg.atlas,
        ivec2(
          tileX.mul(uint(OCTA_RES)).add(tx).toInt(),
          tileY.mul(uint(OCTA_RES)).add(ty).toInt(),
        ),
        v,
      ).toWriteOnly();
    });
  })().compute(probeTotal);

  // ---- material-side cone tracing -------------------------------------------

  const atlasDimsVec = vec3(mip.atlasDims.x, mip.atlasDims.y, mip.atlasDims.z);

  // Trilinear fetch of grid-space coords `g` at integer pyramid `level`.
  // Level layout is baked as constants and selected with an unrolled branch
  // chain — no storage-buffer reads in the fragment stage, and every sample
  // uses explicit LOD 0 (implicit derivatives inside loops are illegal WGSL).
  const sampleLevel = (g, levelI) => {
    const result = vec4(0).toVar();
    for (let li = 0; li < levelCount; li++) {
      const L = mip.levels[li];
      const cond =
        li === levelCount - 1 ? levelI.greaterThanEqual(li) : levelI.equal(li);
      If(cond, () => {
        const scale = vec3(L.dims.x / dims.x, L.dims.y / dims.y, L.dims.z / dims.z);
        const local = clamp(
          g.mul(scale),
          vec3(0.5),
          vec3(L.dims.x - 0.5, L.dims.y - 0.5, L.dims.z - 0.5),
        );
        const texel = local.add(vec3(L.atlasX, 0, 0));
        result.assign(radianceTex.sample(texel.div(atlasDimsVec)).level(0));
      });
    }
    return result;
  };

  // Fractional-level fetch (quadrilinear across two pyramid levels).
  const sampleCone = Fn(([g, levelF]) => {
    const l0 = clamp(floor(levelF), 0, levelCount - 1);
    const l1 = min(l0.add(1), float(levelCount - 1));
    const f = fract(levelF);
    return mix(sampleLevel(g, l0.toInt()), sampleLevel(g, l1.toInt()), f);
  });

  // One cone: front-to-back march with diameter-matched pyramid level.
  // Returns vec4(accumulated radiance, occlusion). Sky is NOT added here —
  // callers decide what a miss is worth. `minLevel` clamps how sharp the
  // fetches get: diffuse cones start at level 1 — sampling raw level-0
  // voxels makes flat surfaces read their own slab through trilinear
  // filtering, which shows up as splotchy "dirt".
  // Per-pixel march-start jitter that breaks the concentric banding rings
  // cone-step quantization produces. Hashed from the cone's world-space
  // origin rather than the screen coordinate: this Fn runs in the deferred
  // COMPUTE pass (materials sample its output texture), and the fragment
  // builtin `screenCoordinate`/`fragCoord` doesn't exist in a compute shader.
  // The multiplier sets the noise frequency; kept modest so neighbouring
  // pixels aren't fully decorrelated (a high multiplier reads as harsh TV
  // static rather than faint dither, especially at grazing angles).
  const ign = (p) => {
    const c = p.mul(24.0);
    return fract(
      fract(c.x.mul(0.06711056).add(c.z.mul(0.00583715)).add(c.y.mul(0.02043631))).mul(52.9829189),
    );
  };

  // Built per step-budget: diffuse uses the full budget, specular a smaller
  // one (a single reflection cone converges fast and its aperture blurs the
  // tail anyway, so the extra marches are wasted work).
  const makeTraceCone = (steps) => Fn(([origin, dir, aperture, minLevel]) => {
    const acc = vec3(0).toVar();
    const alpha = float(0).toVar();
    const t = float(0).toVar();
    // Small jitter amplitude: enough to soften banding, low enough that the
    // per-pixel variance (grain) stays faint. [0.5, 0.7] voxels.
    t.assign(u.voxelSize.mul(ign(origin).mul(0.2).add(0.5)));
    Loop(steps, () => {
      const diameter = max(u.voxelSize, aperture.mul(2).mul(t));
      const pos = origin.add(dir.mul(t));
      const g = toVoxelSpace(pos).toVar();
      If(inBounds(g).not().or(alpha.greaterThan(0.95)), () => {
        Break();
      });
      const level = clamp(log2(diameter.div(u.voxelSize)), minLevel, levelCount - 1);
      const s = sampleCone(g, level);
      // Opacity correction: rescale coverage to the fraction of the SAMPLED
      // level's voxel this step spans (≈0.5 at every level). Dividing by the
      // level-0 voxel size instead blows the exponent up to 2^level/2 at
      // coarse mips — a few percent of blurred coverage then reads as ~50%
      // opacity, and open-air cones "occlude" on nothing (the everything-
      // is-dark bug).
      const stepLen = diameter.mul(0.5);
      const a = float(1).sub(pow(float(1).sub(clamp(s.w, 0, 1)), stepLen.div(diameter)));
      acc.addAssign(s.xyz.mul(a).mul(float(1).sub(alpha)));
      alpha.addAssign(a.mul(float(1).sub(alpha)));
      t.addAssign(stepLen);
    });
    return vec4(acc, alpha);
  });

  const traceCone = makeTraceCone(coneSteps);
  // Specular reflections: ~60% of the diffuse step budget (min 6).
  const traceConeSpec = makeTraceCone(Math.max(6, Math.round(coneSteps * 0.6)));

  // 6-cone diffuse gather → vec4(bounce+sky radiance, ambient occlusion).
  // The AO term is the cones' average visibility; the light node multiplies
  // it into `context.ambientOcclusion`, which the physical lighting model
  // applies to ALL indirect light (ambient, HDRI IBL, and this GI) after
  // accumulation — that's what actually darkens corners in a lit scene.
  const coneSet = cfg.lite ? LITE_CONES : DIFFUSE_CONES;
  const coneAperture = cfg.lite ? LITE_CONE_APERTURE : DIFFUSE_CONE_APERTURE;

  const coneDiffuse = Fn(([P, N]) => {
    // Lift fully clear of the surface's own voxel slab (trilinear reach is
    // ±1 texel): closer origins make surfaces self-shade into gray smudges.
    // Contact-scale occlusion is voxel-size-bound either way — raise the
    // voxel resolution (or let SSGI/SSAO cover sub-voxel contact) rather
    // than lowering this.
    const origin = P.add(N.mul(max(u.normalBias, u.voxelSize.mul(1.75))));
    // Orthonormal basis around N.
    const ref = mix(vec3(0, 0, 1), vec3(1, 0, 0), step(0.9, abs(N.z)));
    const T = normalize(cross(ref, N));
    const B = cross(N, T);
    const total = vec3(0).toVar();
    const visibility = float(0).toVar();
    for (const cone of coneSet) {
      const dir = normalize(
        T.mul(cone.dir[0]).add(B.mul(cone.dir[1])).add(N.mul(cone.dir[2])),
      );
      const r = traceCone(origin, dir, float(coneAperture), float(1));
      // `bounce` scales only the surface-bounced light (not the sky term) —
      // a stable, linear artistic boost applied outside the feedback loop.
      total.addAssign(r.xyz.mul(u.bounce).add(u.skyColor.mul(float(1).sub(r.w))).mul(cone.w));
      visibility.addAssign(float(1).sub(r.w).mul(cone.w));
    }
    const ao = mix(float(1), visibility, u.aoStrength);
    return vec4(total.mul(u.intensity), ao);
  });

  // Single specular cone along the reflection vector; aperture follows
  // roughness so rough materials get blurry (coarse-mip) reflections.
  const coneSpecular = Fn(([P, N]) => {
    const V = normalize(P.sub(cameraPosition));
    const R = normalize(reflect(V, N));
    // Aperture floor keeps smooth surfaces from fetching voxel-sharp level-0
    // texels — mirror-blocky reflections read as streaky banding.
    const aperture = clamp(materialRoughness.mul(materialRoughness), 0.07, 0.9);
    const origin = P.add(N.mul(max(u.normalBias, u.voxelSize.mul(1.75))));
    const r = traceConeSpec(origin, R, aperture, float(0.5));
    // Scene reflections only — sky/env reflections stay the environment
    // map's job (adding sky here would double-count against an HDRI).
    return r.xyz.mul(u.reflectionIntensity).mul(u.intensity);
  });

  // 0→1 over the outer ~12% of the volume: used to fade GI to sky at the
  // world's edge (kills the visible "voxels end here" line) and, with
  // cascades, to blend an inner volume over its coarser parent.
  const edgeFade = Fn(([P]) => {
    const size = vec3(dims.x, dims.y, dims.z).mul(u.voxelSize);
    const g01 = P.sub(u.gridMin).div(size);
    const m = min(g01, vec3(1).sub(g01));
    return clamp(min(m.x, min(m.y, m.z)).mul(8), 0, 1);
  });

  return {
    uniforms: u,
    injectDirectNode,
    injectNode,
    mipPasses,
    copyNode,
    traceNode,
    integrateNode,
    probeShiftSaveNode,
    probeShiftApplyNode,
    probeCount,
    levelCount,
    /** Diffuse GI node (vec4: rgb, w=AO) — unfaded; callers blend by fade. */
    createDiffuseSampler: () => coneDiffuse(positionWorld, normalWorld),
    /** Raw Fns for the deferred screen-space pass (explicit P/N args). */
    coneDiffuseFn: coneDiffuse,
    edgeFadeFn: edgeFade,
    /** Specular GI node — unfaded (null when disabled or a lite cascade:
     * distant reflections are invisible; skipping them halves outer-cascade
     * shader code, which every material has to compile). */
    createSpecularSampler: cfg.reflections && !cfg.lite
      ? () => coneSpecular(positionWorld, normalWorld)
      : null,
    /** 0→1 blend weight of this volume at the shaded point. */
    createFadeNode: () => edgeFade(positionWorld),
    /** Unlit color node for the "probes" debug spheres (octa atlas). */
    createDebugColorNode: () => {
      const probeIdxF = vertexStage(instanceIndex.toFloat());
      const octaUv = octaEncode(normalize(normalWorld));
      return atlasTex.sample(atlasUV(floor(probeIdxF.add(0.5)), octaUv)).xyz;
    },
    /**
     * Unlit color node for the "gi" debug spheres: the exact cone-traced
     * diffuse materials receive, evaluated on the sphere surface. Spheres
     * showing bleed/occlusion = full 3D atlas path works; flat sky-colored
     * spheres = the radiance atlas is dead (mip/copy passes or sampling).
     */
    createGIDebugColorNode: () => coneDiffuse(positionWorld, normalWorld).xyz,
  };
}

/**
 * Engine-owned scene light that carries the GI volume's lighting into every
 * lit material. Not an entity — the GISystem adds/removes it on the scene
 * directly (like the engine's ambient light), so it never serializes.
 */
export class GIProbeVolumeLight extends THREE.Light {
  constructor() {
    super(0xffffff, 1);
    this.isGIProbeVolumeLight = true;
    this.type = "GIProbeVolumeLight";
    this.userData.engineOwned = true;
    /** Set by GISystem: { diffuse: () => Node, specular: (() => Node)|null } */
    this.giFactories = null;
  }
}

/**
 * Node counterpart, registered per renderer via
 * `renderer.library.addLight(GIProbeVolumeLightNode, GIProbeVolumeLight)`.
 * Diffuse goes to `context.irradiance` (the ambient-light slot), specular
 * to `context.radiance` (the environment-map slot) — the physical lighting
 * model folds both into every standard material automatically.
 */
export class GIProbeVolumeLightNode extends THREE.AnalyticLightNode {
  static get type() {
    return "GIProbeVolumeLightNode";
  }

  constructor(light = null) {
    super(light);
  }

  setup(builder) {
    const factories = this.light?.giFactories;
    if (!factories) return;
    if (factories.diffuse) {
      const gi = factories.diffuse().toVar(); // vec4: rgb = radiance, w = AO
      builder.context.irradiance.addAssign(gi.xyz);
      // VXAO: context.ambientOcclusion is applied by the lighting model to
      // every indirect term AFTER all lights accumulate, so this darkens
      // ambient + environment IBL too, regardless of light-node order.
      if (builder.context.ambientOcclusion) {
        builder.context.ambientOcclusion.mulAssign(gi.w);
      }
    }
    if (factories.specular && builder.context.radiance) {
      builder.context.radiance.addAssign(factories.specular());
    }
  }
}
