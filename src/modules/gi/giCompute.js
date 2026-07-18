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
} from "three/tsl";

/**
 * GPU side of the GI module.
 *
 * World representation (rebuilt only when the scene changes, CPU-side):
 * packed albedo/normal voxel buffers. Every frame, on the GPU:
 *
 *   inject     — per voxel: direct emission (voxel-marched visibility) plus
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
export const RAY_TLAS_TRACE_STEPS = 2048;
export const RAY_BLAS_TRACE_STEPS = 2048;
// Interleaving granularity of the per-voxel direct shadow sweep. The DDA
// marches (sun + up to 8 local/emissive sources × 5 area samples) are the
// heaviest GPU work in the system; 8 chunks still produced visible frame
// spikes whenever lighting or geometry invalidated the cache. 16 halves the
// per-frame cost — the temporal staging publish hides the extra latency.
export const DIRECT_LIGHT_CHUNKS = 16;
const RAY_INSTANCE_STRIDE = 5;
const RAY_LEAF_SIZE = 4;

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
// Anisotropic mip direction bins, in pair order (+X,-X,+Y,-Y,+Z,-Z). Each
// bin holds radiance LEAVING surfaces toward that axis, so a one-voxel
// wall's sun-lit exterior face lives only in its outward bin and is
// invisible from inside at every mip level — without any binary sealed/
// exterior classification (which made lighting snap as openings crossed
// voxel size instead of dimming gradually).
export const ANISO_BINS = 6;

export function computeMipLevels(dims) {
  const levels = [];
  let d = { ...dims };
  let bufOffset = 0;
  let atlasX = 0;
  for (let i = 0; i < 8; i++) {
    const count = d.x * d.y * d.z;
    // Levels ≥ 1 store six directional radiance chains consecutively in the
    // buffer, and six atlas slots along X (each slot d.x wide + gap).
    // Level 0 stays a single isotropic slot (per-cell normal gating happens
    // at sample time where the exact cell is known).
    const bins = i === 0 ? 1 : ANISO_BINS;
    levels.push({
      dims: d,
      count,
      bins,
      binAtlasStride: d.x + MIP_GAP,
      bufOffset: i === 0 ? -1 : bufOffset,
      atlasX,
    });
    if (i > 0) bufOffset += count * ANISO_BINS;
    atlasX += (d.x + MIP_GAP) * bins;
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
// five ringed at 60°. The former 45° ring frequently stepped over vertical
// walls when shading floors, so incident-light colour bleeding from a wall
// never entered any receiver cone even though its voxel radiance was valid.
// 60° retains cosine weighting while covering the near-horizontal transport
// that dominates wall-to-floor and wall-to-ceiling bounce.
const DIFFUSE_CONES = (() => {
  const cones = [{ dir: [0, 0, 1], w: 0.25 }];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    cones.push({
      dir: [Math.cos(a) * 0.866, Math.sin(a) * 0.866, 0.5],
      w: 0.15,
    });
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
// Bounded per clipmap after influence/strength selection. Eight sources keep
// the compute loop predictable while allowing multiple directionals,
// punctual lights, and nearby off-volume emissive proxies to coexist.
export const MAX_LOCAL_LIGHTS = 8;

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
    updateGridMin: uniform(new THREE.Vector3(0, 0, 0)),
    cascadeCenter: uniform(new THREE.Vector3(0, 0, 0)),
    cascadeHalfExtent: uniform(1),
    cascadeBlend: uniform(1),
    voxelSize: uniform(1),
    spacing: uniform(new THREE.Vector3(1, 1, 1)), // probe spacing per axis
    sunDir: uniform(new THREE.Vector3(0, -1, 0)), // direction light TRAVELS
    sunColor: uniform(new THREE.Color(0, 0, 0)), // premultiplied by intensity
    localLightCount: uniform(0, "uint"),
    skyColor: uniform(new THREE.Color(0.5, 0.7, 1)), // premultiplied
    baseProbe: uniform(0, "uint"), // round-robin window start
    hysteresis: uniform(0.9),
    probeMaxDistance: uniform(1),
    directChunk: uniform(0, "uint"),
    directBlend: uniform(1),
    emissiveBlend: uniform(1),
    radianceBlend: uniform(1),
    feedbackWeight: uniform(1),
    // CPU enclosure bits describe the settled static grid. While a mover is
    // represented by the live dynamic layer they are temporarily bypassed
    // and exact voxel DDA visibility decides whether the opening is clear.
    connectivityGate: uniform(1),
    bounce: uniform(1),
    intensity: uniform(1),
    normalBias: uniform(0.4),
    reflectionIntensity: uniform(1),
    aoStrength: uniform(1),
    aoRadius: uniform(2.5), // finite contact/cavity range, measured in voxels
    probeShift: uniform(new THREE.Vector3(0, 0, 0)), // recenter shift, probe indices
    reseedSky: uniform(0), // 1 = teleport (seed exposed probes from sky), 0 = edge-extend
    rayTracingEnabled: uniform(0, "uint"),
    rayVisibilityEnabled: uniform(0, "uint"),
    rayTlasNodeCount: uniform(0, "uint"),
    rayTlasNodesOffset: uniform(0, "uint"),
    rayTlasInstancesOffset: uniform(0, "uint"),
    rayInstancesOffset: uniform(0, "uint"),
  };

  const voxAlbedo = storage(cfg.buffers.voxAlbedo, "uint", voxelCount);
  const voxNormal = storage(cfg.buffers.voxNormal, "uint", voxelCount);
  const voxEmissive = storage(cfg.buffers.voxEmissive, "uint", voxelCount);
  const voxDirect = storage(cfg.buffers.voxDirect, "uint", voxelCount);
  const voxDirectStaging = storage(
    cfg.buffers.voxDirectStaging,
    "uint",
    voxelCount,
  );
  const voxEmissiveDirect = storage(
    cfg.buffers.voxEmissiveDirect,
    "uint",
    voxelCount,
  );
  const voxEmissiveDirectStaging = storage(
    cfg.buffers.voxEmissiveDirectStaging,
    "uint",
    voxelCount,
  );
  const radiance = storage(cfg.buffers.radiance, "vec4", voxelCount);
  const mips = storage(cfg.buffers.mips, "vec4", Math.max(1, mip.mipTexelCount));
  const probeData = storage(
    cfg.buffers.probeData,
    "vec4",
    cfg.probeLayout.total,
  );
  const lightData = storage(
    cfg.buffers.lightData,
    "vec4",
    MAX_LOCAL_LIGHTS * 5,
  );
  const probeAt = (section, index) =>
    probeData.element(uint(cfg.probeLayout[section]).add(uint(index)));
  const lightAt = (lightIndex, field) =>
    lightData.element(uint(lightIndex * 5 + field));
  const atlasTex = texture(cfg.atlas);
  const radianceTex = texture3D(cfg.radianceAtlas);
  const radianceAtlasDims = vec3(
    mip.atlasDims.x,
    mip.atlasDims.y,
    mip.atlasDims.z,
  );

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
  // Compute updates can be built against a staged clipmap origin while the
  // last complete atlas remains visible at gridMin.
  const toUpdateVoxelSpace = (p) =>
    p.sub(u.updateGridMin).div(u.voxelSize);

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

  // Empty cells carry the CPU flood's boundary-connectivity bit. It is used
  // only to reject impossible SKY transport in a sealed component; once an
  // opening exists, directional DDA/probe visibility still determines how
  // much light enters, so a wider opening remains progressively brighter.
  const exteriorEmptyAt = Fn(([P]) => {
    // Reconstruct connectivity continuously around the empty-space sample.
    // A nearest-cell bit made the gate jump at voxel boundaries and produced
    // rectangular corner patches. The bit exists only on empty cells, so this
    // still needs no albedo binding (three cascades stay under eight buffers).
    const g = toVoxelSpace(P).sub(0.5).toVar();
    const base = floor(g).toVar();
    const f = fract(g).toVar();
    const connectivity = float(0).toVar();
    const weightSum = float(0).toVar();
    for (let dz = 0; dz <= 1; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const c = base.add(vec3(dx, dy, dz)).toVar();
          const wx = dx === 0 ? float(1).sub(f.x) : f.x;
          const wy = dy === 0 ? float(1).sub(f.y) : f.y;
          const wz = dz === 0 ? float(1).sub(f.z) : f.z;
          const weight = wx.mul(wy).mul(wz);
          If(inBounds(c), () => {
            const exterior = voxNormal
              .element(voxelLinear(c))
              .shiftRight(uint(31))
              .bitAnd(uint(1))
              .toFloat();
            connectivity.addAssign(exterior.mul(weight));
            weightSum.addAssign(weight);
          });
        }
      }
    }
    return mix(
      float(1),
      connectivity.div(max(weightSum, 1e-4)),
      u.connectivityGate,
    );
  });

  // Radiance sidedness gate on the level-0 cell: injection lights a
  // single-sided cell only in its stored normal's hemisphere, so a gather
  // ray arriving from behind (dot(rayDir, N) > 0) is reading the OTHER face
  // of a one-voxel wall. Skipped for two-sided cells (both orientations
  // legitimately lit) and for junction cells flagged AMBIGUOUS_NORMAL
  // (their averaged normal is meaningless — a normal test there paints
  // black seams along edges; those cells also receive no direct injection,
  // so passing them leaks nothing). Gated hits stay occluders (opacity is
  // untouched) but contribute no radiance.
  const radianceSideGate = Fn(([g, rayDir]) => {
    const result = float(1).toVar();
    const word = voxNormal.element(voxelLinear(g)).toVar();
    If(word.bitAnd(uint(0x00ffffff)).greaterThan(uint(0)), () => {
      const twoSided = word.shiftRight(uint(24)).bitAnd(uint(1));
      If(twoSided.equal(uint(0)), () => {
        const N = normalize(unpack888(word).mul(2).sub(1));
        // Small positive threshold keeps grazing/silhouette hits lit;
        // rejection only needs to catch clearly back-facing reads.
        // Ambiguous junction cells are now gated too: skipping them left the
        // one ungated path by which exterior-lit corner radiance leaked into
        // sealed interiors, collapsing the open/sealed response to ~1.7×.
        If(dot(rayDir, N).greaterThan(0.1), () => {
          result.assign(0);
        });
      });
    });
    return result;
  });

  // DDA advances exactly one axis per iteration, so a diagonal crossing of
  // the grid needs up to 3× its dimension in steps. An undersized budget
  // exhausted mid-grid and silently returned the sky initialization.
  const MARCH_STEPS = Math.min(512, Math.ceil(Math.max(dims.x, dims.y, dims.z) * 3));

  // March from `origin` along `dir`; returns vec4(radiance, hit distance).
  // Misses carry probeMaxDistance so the same samples can build directional
  // first/second distance moments for DDGI-style visibility.
  //
  // Conservative 3D DDA — every crossed cell is tested, so thin diagonal
  // walls cannot be tunneled through. A miss therefore means the ray
  // PHYSICALLY escaped the grid, and sky needs no enclosure classification:
  // a closed room occludes every ray, and a shrinking opening admits
  // proportionally fewer sky rays, which is exactly the gradual open/close
  // lighting response (binary sealed/exterior flags snapped instead).
  const marchRadiance = Fn(([origin, dir]) => {
    // Default is BLACK at max distance: sky is credited only when the ray
    // demonstrably leaves the grid. A ray that exhausts its step budget
    // inside the volume proves nothing and must not inject sky (that was
    // the old sealed-room glow).
    const result = vec4(vec3(0), u.probeMaxDistance).toVar();
    const gridPos = toVoxelSpace(origin).toVar();
    const cell = floor(gridPos).toVar();
    // The DDA below advances to the NEXT cell before testing, so the
    // origin's own cell was never checked: a probe ray whose half-voxel
    // lifted origin lands inside a one-voxel wall tunneled straight through
    // it and credited sky to a sealed interior. An occupied origin now
    // terminates immediately — black at zero distance — which also zeroes
    // that direction's visibility moments so Chebyshev feedback rejects
    // transport through the stuck probe.
    const blockedAtOrigin = inBounds(cell)
      .and(
        voxAlbedo
          .element(voxelLinear(cell))
          .shiftRight(uint(24))
          .greaterThan(uint(0)),
      )
      .toVar();
    If(blockedAtOrigin, () => {
      result.assign(vec4(vec3(0), 0));
    });
    const stepDir = sign(dir).toVar();
    const invAbsDir = float(1)
      .div(max(abs(dir), vec3(1e-6)))
      .toVar();
    const positive = step(vec3(0), dir).toVar();
    const cellFraction = fract(gridPos).toVar();
    const tMax = mix(
      cellFraction,
      vec3(1).sub(cellFraction),
      positive,
    )
      .mul(invAbsDir)
      .toVar();
    const tDelta = invAbsDir.toVar();
    const travelled = float(0).toVar();
    Loop(MARCH_STEPS, () => {
      If(blockedAtOrigin, () => {
        Break();
      });
      // Same nested If/Else + whole-vector assigns as marchShadow: TSL's
      // ElseIf and component-wise addAssign on vec3 vars are not reliable
      // in this compute context.
      If(
        tMax.x.lessThanEqual(tMax.y).and(tMax.x.lessThanEqual(tMax.z)),
        () => {
          travelled.assign(tMax.x);
          cell.assign(cell.add(vec3(stepDir.x, 0, 0)));
          tMax.assign(tMax.add(vec3(tDelta.x, 0, 0)));
        },
      ).Else(() => {
        If(tMax.y.lessThanEqual(tMax.z), () => {
          travelled.assign(tMax.y);
          cell.assign(cell.add(vec3(0, stepDir.y, 0)));
          tMax.assign(tMax.add(vec3(0, tDelta.y, 0)));
        }).Else(() => {
          travelled.assign(tMax.z);
          cell.assign(cell.add(vec3(0, 0, stepDir.z)));
          tMax.assign(tMax.add(vec3(0, 0, tDelta.z)));
        });
      });
      If(inBounds(cell).not(), () => {
        // Physical escape — this ray really sees the sky.
        result.assign(vec4(u.skyColor, u.probeMaxDistance));
        Break();
      });
      const vi = voxelLinear(cell);
      If(voxAlbedo.element(vi).shiftRight(uint(24)).greaterThan(uint(0)), () => {
        // Back-face hits keep their hit distance (they still occlude, and
        // the visibility moments must see them) but return black radiance.
        result.assign(
          vec4(
            radiance
              .element(vi)
              .xyz.mul(radianceSideGate(cell, dir)),
            travelled.mul(u.voxelSize),
          ),
        );
        Break();
      });
    });
    return result;
  });

  // ---- optional Stage-2 triangle probe tracer -----------------------------
  // One packed storage buffer contains TLAS nodes, instance references, BLAS
  // nodes, proxy triangles, and inverse instance transforms. Direct shadows
  // never use this path; it is strictly the low-frequency probe transport
  // replacement selected by `rayTracingEnabled`.
  let traceTriangleDistance = null;
  let traceTriangleRadiance = null;
  if (cfg.rayTracing && cfg.buffers.rayData) {
    const rayData = storage(
      cfg.buffers.rayData,
      "vec4",
      cfg.rayDataCapacity,
    );
    const rayAt = (index) => rayData.element(uint(index));
    const safeInverseDirection = (dir) =>
      vec3(
        float(1).div(
          signNotZero(dir.x).mul(max(abs(dir.x), 1e-8)),
        ),
        float(1).div(
          signNotZero(dir.y).mul(max(abs(dir.y), 1e-8)),
        ),
        float(1).div(
          signNotZero(dir.z).mul(max(abs(dir.z), 1e-8)),
        ),
      );
    const rayHitsBox = (boundsMin, boundsMax, origin, invDir, maxDistance) => {
      const t0 = boundsMin.sub(origin).mul(invDir);
      const t1 = boundsMax.sub(origin).mul(invDir);
      const near = max(
        0,
        max(
          min(t0.x, t1.x),
          max(min(t0.y, t1.y), min(t0.z, t1.z)),
        ),
      );
      const far = min(
        maxDistance,
        min(
          max(t0.x, t1.x),
          min(max(t0.y, t1.y), max(t0.z, t1.z)),
        ),
      );
      return near.lessThanEqual(far);
    };

    const traceBLAS = Fn(([worldOrigin, worldDir, instanceIndex, maxDistance]) => {
      const instanceBase = u.rayInstancesOffset.add(
        instanceIndex.mul(uint(RAY_INSTANCE_STRIDE)),
      );
      const c0 = rayAt(instanceBase).toVar();
      const c1 = rayAt(instanceBase.add(uint(1))).toVar();
      const c2 = rayAt(instanceBase.add(uint(2))).toVar();
      const c3 = rayAt(instanceBase.add(uint(3))).toVar();
      const meta = rayAt(instanceBase.add(uint(4))).toVar();
      const best = maxDistance.toVar();

      If(meta.w.greaterThan(0), () => {
        // Three's Matrix4 storage is column-major. Transforming the direction
        // without normalization preserves the original world-ray parameter t
        // under non-uniform instance scale.
        const origin = c0.xyz
          .mul(worldOrigin.x)
          .add(c1.xyz.mul(worldOrigin.y))
          .add(c2.xyz.mul(worldOrigin.z))
          .add(c3.xyz)
          .toVar();
        const dir = c0.xyz
          .mul(worldDir.x)
          .add(c1.xyz.mul(worldDir.y))
          .add(c2.xyz.mul(worldDir.z))
          .toVar();
        const invDir = safeInverseDirection(dir);
        const nodeOffset = meta.x.toUint();
        const triangleOffset = meta.y.toUint();
        const nodeCount = meta.z.toInt();
        const pointer = int(0).toVar();

        Loop(RAY_BLAS_TRACE_STEPS, () => {
          If(
            pointer
              .lessThan(0)
              .or(pointer.greaterThanEqual(nodeCount)),
            () => {
              Break();
            },
          );
          const nodeBase = nodeOffset.add(pointer.toUint().mul(uint(2)));
          const record0 = rayAt(nodeBase).toVar();
          const record1 = rayAt(nodeBase.add(uint(1))).toVar();
          If(
            rayHitsBox(record0.xyz, record1.xyz, origin, invDir, best).not(),
            () => {
              pointer.assign(record1.w.toInt());
            },
          ).Else(() => {
            const leafCode = record0.w.toInt();
            If(leafCode.lessThan(0), () => {
              const decoded = leafCode.negate().sub(int(1));
              const start = decoded.div(int(RAY_LEAF_SIZE));
              const count = decoded
                .sub(start.mul(int(RAY_LEAF_SIZE)))
                .add(int(1));
              Loop(RAY_LEAF_SIZE, ({ i }) => {
                If(i.lessThan(count), () => {
                  const triangle = start.add(i).toUint();
                  const triangleBase = triangleOffset.add(
                    triangle.mul(uint(3)),
                  );
                  const a = rayAt(triangleBase).xyz.toVar();
                  const b = rayAt(triangleBase.add(uint(1))).xyz.toVar();
                  const c = rayAt(triangleBase.add(uint(2))).xyz.toVar();
                  const edge1 = b.sub(a).toVar();
                  const edge2 = c.sub(a).toVar();
                  const p = cross(dir, edge2).toVar();
                  const determinant = dot(edge1, p).toVar();
                  If(abs(determinant).greaterThan(1e-10), () => {
                    const inverseDeterminant = float(1).div(determinant);
                    const tvec = origin.sub(a).toVar();
                    const baryU = dot(tvec, p).mul(inverseDeterminant).toVar();
                    If(
                      baryU
                        .greaterThanEqual(0)
                        .and(baryU.lessThanEqual(1)),
                      () => {
                        const q = cross(tvec, edge1).toVar();
                        const baryV = dot(dir, q)
                          .mul(inverseDeterminant)
                          .toVar();
                        If(
                          baryV
                            .greaterThanEqual(0)
                            .and(baryU.add(baryV).lessThanEqual(1)),
                          () => {
                            const distance = dot(edge2, q)
                              .mul(inverseDeterminant)
                              .toVar();
                            If(
                              distance
                                .greaterThan(u.voxelSize.mul(0.15))
                                .and(distance.lessThan(best)),
                              () => {
                                best.assign(distance);
                              },
                            );
                          },
                        );
                      },
                    );
                  });
                });
              });
              pointer.assign(record1.w.toInt());
            }).Else(() => {
              // Preorder threading: a hit internal node descends to ptr + 1;
              // a miss already jumped to its stored miss link above.
              pointer.addAssign(int(1));
            });
          });
        });
      });
      return best;
    });

    traceTriangleDistance = Fn(([origin, dir, maxDistance]) => {
      const best = maxDistance.toVar();
      const invDir = safeInverseDirection(dir);
      const pointer = int(0).toVar();
      Loop(RAY_TLAS_TRACE_STEPS, () => {
        If(
          pointer
            .lessThan(0)
            .or(pointer.greaterThanEqual(u.rayTlasNodeCount.toInt())),
          () => {
            Break();
          },
        );
        const nodeBase = u.rayTlasNodesOffset.add(
          pointer.toUint().mul(uint(2)),
        );
        const record0 = rayAt(nodeBase).toVar();
        const record1 = rayAt(nodeBase.add(uint(1))).toVar();
        If(
          rayHitsBox(record0.xyz, record1.xyz, origin, invDir, best).not(),
          () => {
            pointer.assign(record1.w.toInt());
          },
        ).Else(() => {
          const leafCode = record0.w.toInt();
          If(leafCode.lessThan(0), () => {
            const decoded = leafCode.negate().sub(int(1));
            const start = decoded.div(int(RAY_LEAF_SIZE));
            const count = decoded
              .sub(start.mul(int(RAY_LEAF_SIZE)))
              .add(int(1));
            Loop(RAY_LEAF_SIZE, ({ i }) => {
              If(i.lessThan(count), () => {
                const reference = rayAt(
                  u.rayTlasInstancesOffset.add(start.add(i).toUint()),
                ).x.toUint();
                const candidate = traceBLAS(origin, dir, reference, best);
                If(candidate.lessThan(best), () => {
                  best.assign(candidate);
                });
              });
            });
            pointer.assign(record1.w.toInt());
          }).Else(() => {
            pointer.addAssign(int(1));
          });
        });
      });
      return best;
    });

    const sampleTriangleHit = Fn(([hitPosition, dir]) => {
      const bestSample = vec4(0).toVar();
      // Voxelization and the geometric proxy are intentionally independent.
      // Search a narrow segment around the exact triangle hit so a boundary
      // landing in the neighbouring voxel still finds the cached radiance.
      for (const offset of [-0.75, -0.25, 0.25, 0.75]) {
        const g = toVoxelSpace(
          hitPosition.add(dir.mul(u.voxelSize.mul(offset))),
        ).toVar();
        If(inBounds(g), () => {
          const sample = radianceTex
            .sample(g.div(radianceAtlasDims))
            .level(0)
            .toVar();
          // Same sidedness rule as the voxel march: a proxy-ray hit on the
          // far face of a one-voxel wall must not shade from the near face's
          // lit radiance. Opacity (w) is kept so the hit still occludes.
          sample.xyz.mulAssign(radianceSideGate(g, dir));
          If(sample.w.greaterThan(bestSample.w), () => {
            bestSample.assign(sample);
          });
        });
      }
      return bestSample;
    });

    traceTriangleRadiance = Fn(([origin, dir]) => {
      const maxDistance = u.probeMaxDistance;
      // Proxy triangles are watertight per mesh, so a miss is a physical
      // escape — sky needs no enclosure classification here either.
      const result = vec4(u.skyColor, maxDistance).toVar();
      const distance = traceTriangleDistance(origin, dir, maxDistance).toVar();
      If(distance.lessThan(maxDistance), () => {
        const hitPosition = origin.add(dir.mul(distance));
        const g = toVoxelSpace(hitPosition).toVar();
        // Hits outside this clipmap cannot be shaded from its radiance cache.
        // Since the origin is inside the clipmap, an outside first hit also
        // proves there was no nearer in-volume surface along the ray.
        If(inBounds(g), () => {
          const sample = sampleTriangleHit(hitPosition, dir);
          result.assign(vec4(sample.xyz, distance));
        });
      });
      return result;
    });
  }

  /**
   * Conservative voxel visibility for incident-light injection. Fixed-size
   * samples could jump over a one-voxel wall, giving exposed and shadowed
   * surfaces the same outgoing radiance. 3D DDA visits every crossed cell.
   */
  const SHADOW_STEPS = 128;
  const marchShadow = Fn(
    ([origin, dirToLight, maxDistance, emissiveEndpointTrim]) => {
    const visibility = float(1).toVar();
    const gridPos = toUpdateVoxelSpace(origin).toVar();
    const cell = floor(gridPos).toVar();
    const stepDir = sign(dirToLight).toVar();
    const invAbsDir = float(1)
      .div(max(abs(dirToLight), vec3(1e-6)))
      .toVar();
    const positive = step(vec3(0), dirToLight).toVar();
    const cellFraction = fract(gridPos).toVar();
    const distanceToBoundary = mix(
      cellFraction,
      vec3(1).sub(cellFraction),
      positive,
    ).toVar();
    const tMax = distanceToBoundary.mul(invAbsDir).toVar();
    const tDelta = invAbsDir.toVar();
    const travelled = float(0).toVar();
    const maxGridDistance = maxDistance.div(u.voxelSize).toVar();

    Loop(SHADOW_STEPS, () => {
      If(
        tMax.x.lessThanEqual(tMax.y).and(tMax.x.lessThanEqual(tMax.z)),
        () => {
          travelled.assign(tMax.x);
          cell.assign(cell.add(vec3(stepDir.x, 0, 0)));
          tMax.assign(tMax.add(vec3(tDelta.x, 0, 0)));
        },
      ).Else(() => {
        If(tMax.y.lessThanEqual(tMax.z), () => {
          travelled.assign(tMax.y);
          cell.assign(cell.add(vec3(0, stepDir.y, 0)));
          tMax.assign(tMax.add(vec3(0, tDelta.y, 0)));
        }).Else(() => {
          travelled.assign(tMax.z);
          cell.assign(cell.add(vec3(0, 0, stepDir.z)));
          tMax.assign(tMax.add(vec3(0, 0, tDelta.z)));
        });
      });

      If(travelled.greaterThanEqual(maxGridDistance), () => {
        Break();
      });
      If(inBounds(cell).not(), () => {
        Break();
      });
      const vi = voxelLinear(cell);
      If(
        voxAlbedo
          .element(vi)
          .shiftRight(uint(24))
          .greaterThan(uint(0)),
        () => {
          // Area-light rays must enter the source's own voxel to test every
          // intervening cell. Ignore only emissive occupancy immediately at
          // that endpoint; a non-emissive ceiling/wall close to the panel
          // remains a blocker. The former blanket 1.5-voxel endpoint trim
          // skipped exactly those near-source walls.
          const isEmissiveEndpoint = emissiveEndpointTrim
            .greaterThan(0)
            .and(
              travelled.greaterThanEqual(
                maxGridDistance.sub(
                  max(float(1.25), emissiveEndpointTrim),
                ),
              ),
            )
            .and(
              voxEmissive
                .element(vi)
                .bitAnd(uint(0xffffff))
                .greaterThan(uint(0)),
            );
          If(isEmissiveEndpoint.not(), () => {
            visibility.assign(0);
            Break();
          });
        },
      );
    });
    return visibility;
  },
  );

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

  /**
   * World-space accumulated diffuse field. A 3×3×3 quadratic B-spline filter
   * blends directional irradiance from 27 probes. The wider C1-continuous
   * kernel hides individual probe cells without screen-space history.
   *
   * Visibility must eventually come from probe depth moments (DDGI-style).
   * Binary occupancy tests performed here created camera-dependent rectangles
   * whenever a segment crossed one voxel, so final-gather visibility is kept
   * entirely in the already shadowed probe radiance for now.
   */
  const sampleProbeField = Fn(([P, N]) => {
    const maxProbe = vec3(counts.x - 1, counts.y - 1, counts.z - 1);
    const pg = clamp(P.sub(u.gridMin).div(u.spacing), vec3(0), maxProbe);
    const base = floor(pg);
    const f = fract(pg);
    const octaUv = octaEncode(normalize(N));
    const accum = vec3(0).toVar();
    const weightSum = float(0).toVar();

    const splineWeight = (axisF, tap) => {
      if (tap === 0) return float(0.5).mul(float(1).sub(axisF).mul(float(1).sub(axisF)));
      if (tap === 1) return float(0.75).sub(axisF.sub(0.5).mul(axisF.sub(0.5)));
      return float(0.5).mul(axisF.mul(axisF));
    };

    for (let dz = 0; dz < 3; dz++) {
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const pc = clamp(
            base.add(vec3(dx - 1, dy - 1, dz - 1)),
            vec3(0),
            maxProbe,
          );
          const probeIdx = pc.x
            .add(pc.y.mul(counts.x))
            .add(pc.z.mul(counts.x * counts.y));
          const sample = atlasTex
            .sample(atlasUV(probeIdx, octaUv))
            .level(0);
          // Unknown probe history is not evidence of visible sky. Starting
          // from black avoids a false bright state that later fades away.
          const irradianceSample = mix(
            vec3(0),
            sample.xyz,
            sample.w,
          );
          const weight = splineWeight(f.x, dx)
            .mul(splineWeight(f.y, dy))
            .mul(splineWeight(f.z, dz));
          accum.addAssign(irradianceSample.mul(weight));
          weightSum.addAssign(weight);
        }
      }
    }

    return vec4(
      accum.div(max(weightSum, 1e-4)).mul(u.intensity),
      1,
    );
  });

  /**
   * Far-field environment radiance for the diffuse cone gather: trilinear
   * blend of the eight surrounding probes' irradiance in one direction.
   *
   * The former residual term added raw `skyColor × transmittance²`. Wide
   * cones sample coarse mips where a one-voxel wall/ceiling's opacity is
   * heavily diluted, so 30–60% of the sky leaked into sealed interiors —
   * rooms sat permanently sky-lit and moving a wall changed almost nothing.
   * Probe rays are exact per-cell DDA marches, so the probe field knows
   * whether this region of space actually sees the sky in a direction:
   * sealed probes are dark, probes near an opening carry directional sky.
   * Near-field occlusion stays with the crisp cone alpha; the far field
   * inherits the leak-free DDA answer, and lighting now responds to walls
   * opening/closing through the normal probe convergence path.
   */
  const probeSkyRadiance = Fn(([P, dir]) => {
    const maxProbe = vec3(counts.x - 1, counts.y - 1, counts.z - 1);
    const pg = clamp(P.sub(u.gridMin).div(u.spacing), vec3(0), maxProbe);
    const base = clamp(
      floor(pg),
      vec3(0),
      vec3(counts.x - 2, counts.y - 2, counts.z - 2),
    );
    const f = clamp(pg.sub(base), vec3(0), vec3(1));
    const octaUv = octaEncode(dir);
    const accum = vec3(0).toVar();
    for (let dz = 0; dz <= 1; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const pc = base.add(vec3(dx, dy, dz));
          const probeIdx = pc.x
            .add(pc.y.mul(counts.x))
            .add(pc.z.mul(counts.x * counts.y));
          const sample = atlasTex
            .sample(atlasUV(probeIdx, octaUv))
            .level(0);
          // Unconverged history contributes no invented environment light.
          const irradianceSample = sample.xyz.mul(sample.w);
          const wx = dx === 0 ? float(1).sub(f.x) : f.x;
          const wy = dy === 0 ? float(1).sub(f.y) : f.y;
          const wz = dz === 0 ? float(1).sub(f.z) : f.z;
          accum.addAssign(irradianceSample.mul(wx.mul(wy).mul(wz)));
        }
      }
    }
    // Probe interpolation can straddle a one-voxel wall and pull exterior
    // samples into an enclosed receiver. The receiver-side connectivity gate
    // removes that impossible sky path. Opening the room flips this gate on;
    // the directional samples above still scale with the opening's solid
    // angle, rather than turning all sky on at once.
    return accum.mul(exteriorEmptyAt(P));
  });

  // ---- pass 1a: direct emission (heavy, cached) -----------------------------
  // The per-voxel shadow march is by far the most expensive per-frame work,
  // and its inputs only change when the sun moves or voxels change. It runs
  // on demand into a packed cache; the every-frame inject pass below is a
  // cheap combine. RGBE8 keeps low-energy punctual bounce and HDR near-field
  // light in the same 32 bits; the former fixed 0..8 RGB8 encoding quantized
  // ordinary reflected point/spot energy to zero.

  const packRGBE8 = (v) => {
    const packed = uint(0).toVar();
    const peak = max(v.x, max(v.y, v.z)).toVar();
    If(peak.greaterThan(1e-8), () => {
      // Shared signed base-2 exponent in the high byte. Byte zero is reserved
      // for exact black, leaving a practical exponent range of -127..127.
      const exponent = clamp(
        floor(log2(peak)).add(1),
        -127,
        127,
      ).toVar();
      const scale = float(255).div(pow(float(2), exponent));
      const c = clamp(v.mul(scale), 0, 255).add(0.5);
      const exponentByte = exponent.add(128).toUint();
      packed.assign(
        c.x
          .toUint()
          .bitOr(c.y.toUint().shiftLeft(uint(8)))
          .bitOr(c.z.toUint().shiftLeft(uint(16)))
          .bitOr(exponentByte.shiftLeft(uint(24))),
      );
    });
    return packed;
  };

  const unpackRGBE8 = (packed) => {
    const result = vec3(0).toVar();
    const exponentByte = packed.shiftRight(uint(24)).bitAnd(uint(255));
    If(exponentByte.greaterThan(uint(0)), () => {
      const exponent = exponentByte.toFloat().sub(128);
      result.assign(
        unpack888(packed).mul(pow(float(2), exponent)),
      );
    });
    return result;
  };

  const injectDirectNode = Fn(() => {
    // Interleaved chunks spread the expensive per-voxel shadow marches over
    // several frames without producing a visible contiguous update slab.
    const vi = instanceIndex
      .mul(uint(DIRECT_LIGHT_CHUNKS))
      .add(u.directChunk);
    If(vi.lessThan(uint(voxelCount)), () => {
      const packed = voxAlbedo.element(vi);
      If(packed.shiftRight(uint(24)).equal(uint(0)), () => {
        voxDirectStaging.element(vi).assign(uint(0));
        voxEmissiveDirectStaging.element(vi).assign(uint(0));
      }).Else(() => {
        const normalWord = voxNormal.element(vi).toVar();
        const N = normalize(unpack888(normalWord).mul(2).sub(1));
        const twoSided = normalWord
          .shiftRight(uint(24))
          .bitAnd(uint(1))
          .greaterThan(uint(0));
        const zc = vi.div(uint(dims.x * dims.y));
        const rem = vi.sub(zc.mul(uint(dims.x * dims.y)));
        const yc = rem.div(uint(dims.x));
        const xc = rem.sub(yc.mul(uint(dims.x)));
        const center = u.updateGridMin.add(
          vec3(xc.toFloat(), yc.toFloat(), zc.toFloat()).add(0.5).mul(u.voxelSize),
        );

        const toLight = u.sunDir.negate();
        const sunDot = dot(N, toLight).toVar();
        const sunFacingNormal = N.toVar();
        const nDotL = max(sunDot, 0).toVar();
        If(twoSided.and(sunDot.lessThan(0)), () => {
          sunFacingNormal.assign(N.negate());
          nDotL.assign(sunDot.negate());
        });
        const direct = vec3(0).toVar();
        const emissiveDirect = vec3(0).toVar();
        If(nDotL.greaterThan(0), () => {
          const origin = center.add(
            sunFacingNormal.mul(u.voxelSize.mul(1.75)),
          );
          const visibility = marchShadow(
            origin,
            toLight,
            u.voxelSize.mul(SHADOW_STEPS),
            float(0),
          );
          // Lambertian: outgoing radiance = albedo·E/π. Without the 1/π the
          // bounce is ~3× hot and sunlit floors bloom white onto neighbours.
          direct.assign(
            u.sunColor.mul(nDotL).mul(visibility).mul(1 / Math.PI),
          );
        });

        // Camera-independent source injection. Directional/point/spot lights
        // and off-volume emissive proxies share this bounded buffer, so
        // walking past a source does not erase its bounce from the room.
        for (let lightIndex = 0; lightIndex < MAX_LOCAL_LIGHTS; lightIndex++) {
          If(uint(lightIndex).lessThan(u.localLightCount), () => {
            const posRange = lightAt(lightIndex, 0);
            const colorType = lightAt(lightIndex, 1);
            const dirOuter = lightAt(lightIndex, 2);
            const params = lightAt(lightIndex, 3);
            const extra = lightAt(lightIndex, 4);
            const isDirectional = colorType.w
              .greaterThan(1.5)
              .and(colorType.w.lessThan(2.5));
            const isEmissive = colorType.w.greaterThan(2.5);
            const lightVector = posRange.xyz.sub(center).toVar();
            const distanceSq = max(dot(lightVector, lightVector), 1e-6);
            const distance = pow(distanceSq, 0.5).toVar();
            const toLocalLight = lightVector.div(distance).toVar();
            If(isDirectional, () => {
              // Directional entries store the direction light travels.
              toLocalLight.assign(dirOuter.xyz.negate());
            });
            const localDot = dot(N, toLocalLight).toVar();
            const localFacingNormal = N.toVar();
            const localNDotL = max(localDot, 0).toVar();
            If(twoSided.and(localDot.lessThan(0)), () => {
              localFacingNormal.assign(N.negate());
              localNDotL.assign(localDot.negate());
            });

            If(
              localNDotL
                .greaterThan(0)
                .and(isDirectional.or(distance.lessThan(posRange.w))),
              () => {
                const attenuation = float(1).toVar();
                If(isDirectional.not(), () => {
                  const rangeRatio = distance.div(max(posRange.w, 1e-3));
                  const rangeFade = clamp(
                    float(1).sub(pow(rangeRatio, 4)),
                    0,
                    1,
                  );
                  // Match Three's PointLightNode/SpotLightNode attenuation.
                  // Clamping distance itself to one metre discarded up to
                  // 100x of the raster light's near-field incident energy.
                  const decayExponent = max(params.y, 0).toVar();
                  If(isEmissive, () => {
                    // Type-3 parameters carry the second area basis.
                    decayExponent.assign(2);
                  });
                  const distanceFalloff = float(1).div(
                    max(
                      pow(max(distance, 1e-4), decayExponent),
                      0.01,
                    ),
                  );
                  attenuation.assign(
                    rangeFade
                      .mul(rangeFade)
                      .mul(distanceFalloff),
                  );
                });
                const spotFactor = float(1).toVar();
                If(
                  colorType.w
                    .greaterThan(0.5)
                    .and(colorType.w.lessThan(1.5)),
                  () => {
                  const fromLight = toLocalLight.negate();
                  const spotT = clamp(
                    dot(dirOuter.xyz, fromLight)
                      .sub(dirOuter.w)
                      .div(max(params.x.sub(dirOuter.w), 1e-4)),
                    0,
                    1,
                  );
                  // Hermite smoothstep, matching Three's visible spotlight.
                  spotFactor.assign(
                    spotT
                      .mul(spotT)
                      .mul(float(3).sub(spotT.mul(2))),
                  );
                  },
                );
                const visibility = float(1).toVar();
                If(isEmissive, () => {
                  // Keep a centre ray as well as four stable off-centre rays.
                  // A pure 2x2 Gauss pattern can completely miss a blocker
                  // directly between the receiver and panel centre (the
                  // common ceiling-light / object / floor arrangement).
                  // The centre-weighted pattern preserves that occlusion while
                  // the surrounding rays retain a soft partial-area shadow.
                  visibility.assign(0);
                  const sourceVisibilityGate = float(1).toVar();
                  const emitterNormal = normalize(
                    cross(dirOuter.xyz, params.xyz),
                  ).toVar();
                  for (const sampleOffset of [
                    [0, 0, 0.32],
                    [-0.57735, -0.57735, 0.17],
                    [0.57735, -0.57735, 0.17],
                    [-0.57735, 0.57735, 0.17],
                    [0.57735, 0.57735, 0.17],
                  ]) {
                    const planeSampleVector = lightVector
                      .add(
                        dirOuter.xyz.mul(
                          dirOuter.w.mul(sampleOffset[0]),
                        ),
                      )
                      .add(
                        params.xyz.mul(
                          params.w.mul(sampleOffset[1]),
                        ),
                      )
                      .toVar();
                    // The proxy centre lies inside the emitter's bounding
                    // box. Move the sample to the face toward this receiver;
                    // exact visibility can then stop just before that face
                    // without hitting the emitter itself, while a ceiling in
                    // front of it remains inside the segment.
                    const planeDirection = normalize(
                      planeSampleVector,
                    );
                    const faceSign = signNotZero(
                      dot(emitterNormal, planeDirection),
                    );
                    const sampleVector = planeSampleVector
                      .sub(
                        emitterNormal.mul(
                          faceSign.mul(extra.w),
                        ),
                      )
                      .toVar();
                    const sampleDistance = pow(
                      max(dot(sampleVector, sampleVector), 1e-6),
                      0.5,
                    ).toVar();
                    const sampleDirection = sampleVector
                      .div(sampleDistance)
                      .toVar();
                    const sampleDot = dot(N, sampleDirection).toVar();
                    const sampleFacingNormal = N.toVar();
                    const sampleNDotL = max(sampleDot, 0).toVar();
                    If(twoSided.and(sampleDot.lessThan(0)), () => {
                      sampleFacingNormal.assign(N.negate());
                      sampleNDotL.assign(sampleDot.negate());
                    });
                    If(sampleNDotL.greaterThan(0), () => {
                      const sampleOrigin = center.add(
                        sampleFacingNormal.mul(
                          max(
                            u.normalBias,
                            u.voxelSize.mul(0.6),
                          ),
                        ),
                      );
                      // The normal lift changes the segment endpoint. Rebuild
                      // the shadow direction from the lifted receiver instead
                      // of reusing centre-to-light direction and overshooting
                      // the area sample.
                      const shadowVector = sampleVector
                        .sub(sampleOrigin.sub(center))
                        .toVar();
                      const shadowDistance = pow(
                        max(dot(shadowVector, shadowVector), 1e-6),
                        0.5,
                      ).toVar();
                      const shadowDirection = shadowVector
                        .div(shadowDistance)
                        .toVar();
                      // Visibility is the conservative DDA alone (plus the
                      // exact centre ray below). The former sealed/exterior
                      // component compare was removed with the binary
                      // classification: it made emissive light snap on/off
                      // as an opening crossed voxel size instead of fading.
                      const sampleVisibility = marchShadow(
                        sampleOrigin,
                        shadowDirection,
                        shadowDistance,
                        float(1.25),
                      ).toVar();
                      if (
                        traceTriangleDistance &&
                        sampleOffset[0] === 0 &&
                        sampleOffset[1] === 0
                      ) {
                        // One exact centre ray resolves the case the voxel
                        // field fundamentally cannot represent: an emissive
                        // panel and a non-emissive ceiling occupying the same
                        // coarse endpoint voxel. A blocker immediately before
                        // the source gates the whole rectangular emitter;
                        // mid-path blockers (sphere/crate) affect only this
                        // centre sample so the area shadow remains partial.
                        If(
                          u.rayVisibilityEnabled
                            .greaterThan(uint(0))
                            .and(sampleVisibility.greaterThan(0.5)),
                          () => {
                            const exactMaxDistance = max(
                              shadowDistance.sub(
                                u.voxelSize.mul(0.02),
                              ),
                              0,
                            ).toVar();
                            const exactHit = traceTriangleDistance(
                              sampleOrigin,
                              shadowDirection,
                              exactMaxDistance,
                            ).toVar();
                            If(
                              exactHit.lessThan(exactMaxDistance),
                              () => {
                                sampleVisibility.assign(0);
                                If(
                                  exactMaxDistance
                                    .sub(exactHit)
                                    .lessThan(
                                      u.voxelSize.mul(2.5),
                                    ),
                                  () => {
                                    sourceVisibilityGate.assign(0);
                                  },
                                );
                              },
                            );
                          },
                        );
                      }
                      const emitterCosine = abs(
                        dot(
                          emitterNormal,
                          sampleDirection.negate(),
                        ),
                      );
                      // Outside the loop the centre nDotL is applied. The
                      // ratio converts it into the sample's own receiver
                      // cosine before averaging.
                      visibility.addAssign(
                        sampleVisibility
                          .mul(emitterCosine)
                          .mul(
                            sampleNDotL.div(
                              max(localNDotL, 1e-4),
                            ),
                          )
                          .mul(sampleOffset[2]),
                      );
                    });
                  }
                  visibility.mulAssign(sourceVisibilityGate);
                }).Else(() => {
                  const origin = center.add(
                    localFacingNormal.mul(u.voxelSize.mul(1.75)),
                  );
                  const shadowDistance = max(
                    distance.sub(
                      max(params.z, u.voxelSize.mul(0.25)),
                    ),
                    0,
                  ).toVar();
                  If(isDirectional, () => {
                    shadowDistance.assign(
                      u.voxelSize.mul(SHADOW_STEPS),
                    );
                  });
                  visibility.assign(
                    marchShadow(
                      origin,
                      toLocalLight,
                      shadowDistance,
                      float(0),
                    ),
                  );
                });
                const localContribution = colorType.xyz
                    .mul(localNDotL)
                    .mul(attenuation)
                    .mul(spotFactor)
                    .mul(visibility)
                    .mul(1 / Math.PI)
                    .toVar();
                direct.addAssign(localContribution);
                If(colorType.w.greaterThan(2.5), () => {
                  emissiveDirect.addAssign(localContribution);
                });
              },
            );
          });
        }
        // Junction cells (AMBIGUOUS_NORMAL) have meaningless normals: the
        // 1.75-voxel shadow-ray lift exits through a one-voxel wall and
        // caches bright exterior light inside sealed corners, seen as
        // blocky corner glow. Corners are AO territory — inject nothing.
        const reliableNormal = float(1).sub(
          normalWord.shiftRight(uint(27)).bitAnd(uint(1)).toFloat(),
        );
        direct.mulAssign(reliableNormal);
        emissiveDirect.mulAssign(reliableNormal);
        const previous = unpackRGBE8(voxDirectStaging.element(vi));
        const previousEmissive = unpackRGBE8(
          voxEmissiveDirectStaging.element(vi),
        );
        voxDirectStaging
          .element(vi)
          .assign(packRGBE8(mix(previous, direct, u.directBlend)));
        voxEmissiveDirectStaging
          .element(vi)
          .assign(
            packRGBE8(
              mix(previousEmissive, emissiveDirect, u.directBlend),
            ),
          );
      });
    });
  })().compute(Math.ceil(voxelCount / DIRECT_LIGHT_CHUNKS));

  // The interleaved staging cache is invisible until a complete eight-chunk
  // sweep publishes it atomically. Radiance can keep converging every service
  // frame from the last complete target without ever exposing stripe phases.
  const publishDirectNode = Fn(() => {
    const vi = instanceIndex;
    If(vi.lessThan(uint(voxelCount)), () => {
      voxDirect.element(vi).assign(voxDirectStaging.element(vi));
    });
  })().compute(voxelCount);

  // Emissive direct is sampled by visible receivers, so an atomic target
  // copy would expose a whole lighting sweep at once. Blend the complete
  // staging target through a separate world-space cache over service frames.
  const blendEmissiveDirectNode = Fn(() => {
    const vi = instanceIndex;
    If(vi.lessThan(uint(voxelCount)), () => {
      const previous = unpackRGBE8(
        voxEmissiveDirect.element(vi),
      );
      const target = unpackRGBE8(
        voxEmissiveDirectStaging.element(vi),
      );
      voxEmissiveDirect
        .element(vi)
        .assign(
          packRGBE8(
            mix(previous, target, u.emissiveBlend),
          ),
        );
    });
  })().compute(voxelCount);

  // ---- pass 1b: radiance combine (cheap, every update frame) ----------------

  const injectNode = Fn(() => {
    const vi = instanceIndex;
    If(vi.lessThan(uint(voxelCount)), () => {
      const packed = voxAlbedo.element(vi);
      If(packed.shiftRight(uint(24)).equal(uint(0)), () => {
        // Geometry removal fades both cached radiance and opacity. Clearing
        // alpha immediately made voxel AO snap even though RGB lighting was
        // otherwise temporally accumulated.
        const previous = radiance.element(vi);
        radiance
          .element(vi)
          .assign(
            vec4(
              mix(previous.xyz, vec3(0), u.radianceBlend),
              mix(previous.w, float(0), u.radianceBlend),
            ),
          );
      }).Else(() => {
        const albedo = unpack888(packed);
        const normalWord = voxNormal.element(vi).toVar();
        const N = normalize(unpack888(normalWord).mul(2).sub(1));
        const zc = vi.div(uint(dims.x * dims.y));
        const rem = vi.sub(zc.mul(uint(dims.x * dims.y)));
        const yc = rem.div(uint(dims.x));
        const xc = rem.sub(yc.mul(uint(dims.x)));
        const center = u.updateGridMin.add(
          vec3(xc.toFloat(), yc.toFloat(), zc.toFloat()).add(0.5).mul(u.voxelSize),
        );

        const direct = unpackRGBE8(voxDirect.element(vi));

        // Multi-bounce feedback: last frame's irradiance at the nearest
        // probe, in the voxel's normal direction. Probe selection uses the
        // surface-lifted point, NOT the cell centre: a wall cell's nearest
        // probe can sit on the far side of the wall, and that exterior
        // probe's bright sky/emissive irradiance then bleeds through the
        // Chebyshev tolerance as a soft glow on sealed interior faces.
        const feedbackOrigin = center.add(N.mul(u.voxelSize.mul(1.5)));
        const pg = clamp(
          feedbackOrigin.sub(u.gridMin).div(u.spacing).add(0.5),
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
        // Fixed conservative gain — NEVER a user knob. This term feeds back into
        // itself (probes light voxels light probes…); any gain ≥ 1/albedo
        // diverges and the scene integrates to white over a few seconds.
        // The user-facing `bounce` boost is applied outside the loop, at
        // the cone gather, where it scales linearly instead of compounding.
        const bounceIrr = probeAt(
          "irradiance",
          probeIdx.mul(uint(OCTA_RES * OCTA_RES)).add(texelIdx),
        )
          .xyz.mul(0.6)
          .toVar();

        // Directional first/second distance moments come from the same rays
        // that produced probe irradiance. A Chebyshev upper bound attenuates
        // feedback when the selected probe sees a blocker before this voxel,
        // replacing the old two-sample binary occupancy heuristic.
        const probePos = u.gridMin.add(pc.mul(u.spacing));
        const toReceiver = feedbackOrigin.sub(probePos).toVar();
        const receiverDistance = pow(
          max(dot(toReceiver, toReceiver), 1e-8),
          0.5,
        ).toVar();
        const receiverDir = toReceiver.div(max(receiverDistance, 1e-4));
        const visibilityOcta = floor(
          octaEncode(receiverDir).mul(OCTA_RES - 0.001),
        );
        const visibilityTexel = visibilityOcta.y
          .mul(OCTA_RES)
          .add(visibilityOcta.x)
          .toUint();
        const moments = probeAt(
          "visibility",
          probeIdx.mul(uint(OCTA_RES * OCTA_RES)).add(visibilityTexel),
        ).toVar();
        const rayVisibility = float(1).toVar();
        If(moments.z.greaterThan(0.5), () => {
          const bias = u.voxelSize.mul(1.25);
          If(receiverDistance.greaterThan(moments.x.add(bias)), () => {
            const delta = receiverDistance.sub(moments.x.add(bias));
            const variance = max(
              moments.y.sub(moments.x.mul(moments.x)),
              u.voxelSize.mul(u.voxelSize).mul(0.05),
            );
            const probability = variance.div(
              variance.add(delta.mul(delta)),
            );
            // Standard light-bleed reduction keeps broad high-variance
            // distributions from carrying saturated bounce through walls.
            rayVisibility.assign(
              clamp(probability.sub(0.2).div(0.8), 0, 1),
            );
          });
        });
        bounceIrr.mulAssign(rayVisibility.mul(u.feedbackWeight));
        // Junction cells: the octa lookup direction and lifted origin are
        // both derived from a meaningless normal — no feedback either.
        bounceIrr.mulAssign(
          float(1).sub(
            normalWord.shiftRight(uint(27)).bitAnd(uint(1)).toFloat(),
          ),
        );

        // Emissive surfaces are light sources: added on top of reflected
        // light (not scaled by albedo — it's emitted, not bounced). The
        // probe feedback then propagates it, so emissives get multi-bounce
        // and show up in reflections with no extra passes.
        const emissive = unpack888(voxEmissive.element(vi)).mul(8); // EMISSIVE_SCALE
        const targetRadiance = albedo
          .mul(direct.add(bounceIrr))
          .add(emissive);
        const previousRadiance = radiance.element(vi);
        radiance
          .element(vi)
          .assign(
            vec4(
              mix(
                previousRadiance.xyz,
                targetRadiance,
                u.radianceBlend,
              ),
              mix(previousRadiance.w, float(1), u.radianceBlend),
            ),
          );
      });
    });
  })().compute(voxelCount);

  // ---- mip pyramid: downsample passes (buffers) + atlas copy passes -------

  // Level 0 is the isotropic radiance buffer; levels ≥ 1 hold six
  // directional bins consecutively (bufOffset + bin*count).
  const readBin = (level, bin, linearIdx) =>
    level === 0
      ? radiance.element(linearIdx)
      : mips
          .element(
            uint(
              mip.levels[level].bufOffset + bin * mip.levels[level].count,
            ).add(linearIdx),
          );

  // Bin axes in pair order (+X,-X,+Y,-Y,+Z,-Z): axis component per bin.
  const BIN_AXIS = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

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

          // Full anisotropic build: per bin BOTH radiance and opacity are
          // direction-weighted, and per-bin rgb is normalized by the bin's
          // OWN weighted alpha. The rgb value is therefore full-strength
          // mean surface radiance (never cosine-diluted); the direction
          // weighting lives entirely in the opacity, and the sampler's
          // opacity-weighted renormalization recovers full-strength bounce
          // from any front direction. (The earlier shared-opacity variant
          // read oblique transport at cos² strength — wall-lit-by-floor
          // bounce arrived at a quarter energy.)
          const rgbBins = BIN_AXIS.map(() => vec3(0).toVar());
          const wBins = BIN_AXIS.map(() => float(0).toVar());
          const wMaxBins = BIN_AXIS.map(() => float(0).toVar());
          for (let dz = 0; dz <= 1; dz++) {
            for (let dy = 0; dy <= 1; dy++) {
              for (let dx = 0; dx <= 1; dx++) {
                const sx = min(x.mul(uint(2)).add(uint(dx)), uint(src.x - 1));
                const sy = min(y.mul(uint(2)).add(uint(dy)), uint(src.y - 1));
                const sz = min(z.mul(uint(2)).add(uint(dz)), uint(src.z - 1));
                const si = sx.add(sy.mul(uint(src.x))).add(sz.mul(uint(src.x * src.y)));
                if (li === 1) {
                  // Bin level-0 cell energy by its stored normal: a flat
                  // wall's energy lands only in its outward bin(s), so the
                  // far side reads zero. Two-sided cells emit both ways
                  // (|N·axis|); cells with no reliable orientation
                  // (ambiguous junctions, dynamic splats, fade ghosts) emit
                  // isotropically so they never vanish from the pyramid.
                  const s = readBin(0, 0, si);
                  const premul = s.xyz.mul(s.w);
                  const word = voxNormal.element(si).toVar();
                  const hasNormal = word
                    .bitAnd(uint(0x00ffffff))
                    .greaterThan(uint(0));
                  const twoSided = word
                    .shiftRight(uint(24))
                    .bitAnd(uint(1))
                    .toFloat();
                  const ambiguous = word
                    .shiftRight(uint(27))
                    .bitAnd(uint(1))
                    .toFloat();
                  const isotropic = min(
                    float(1).sub(hasNormal.toFloat()).add(ambiguous),
                    1,
                  );
                  const N = normalize(
                    unpack888(word).mul(2).sub(1).add(vec3(0, 1e-5, 0)),
                  );
                  for (let bin = 0; bin < ANISO_BINS; bin++) {
                    const axis = BIN_AXIS[bin];
                    const nd = N.x
                      .mul(axis[0])
                      .add(N.y.mul(axis[1]))
                      .add(N.z.mul(axis[2]));
                    const directional = mix(
                      max(nd, 0),
                      abs(nd),
                      twoSided,
                    );
                    const w = mix(directional, float(1), isotropic);
                    const wa = s.w.mul(w);
                    rgbBins[bin].addAssign(premul.mul(w));
                    wBins[bin].addAssign(wa);
                    wMaxBins[bin].assign(max(wMaxBins[bin], wa));
                  }
                } else {
                  for (let bin = 0; bin < ANISO_BINS; bin++) {
                    const s = readBin(li - 1, bin, si);
                    rgbBins[bin].addAssign(s.xyz.mul(s.w));
                    wBins[bin].addAssign(s.w);
                    wMaxBins[bin].assign(max(wMaxBins[bin], s.w));
                  }
                }
              }
            }
          }
          // Preserve blockers more strongly than a plain box average. The
          // 0.8 decay keeps thin occluders present in wide cones without
          // turning every coarse mip cell into a fully solid gray brick.
          const base = uint(mip.levels[li].bufOffset);
          for (let bin = 0; bin < ANISO_BINS; bin++) {
            const opacity = max(
              wBins[bin].div(8),
              wMaxBins[bin].mul(0.8),
            );
            mips
              .element(base.add(uint(bin * mip.levels[li].count)).add(ti))
              .assign(
                vec4(rgbBins[bin].div(max(wBins[bin], 1e-4)), opacity),
              );
          }
        });
      })().compute(dstCount),
    );
  }

  // One dispatch publishes the whole pyramid to the 3D atlas: each thread
  // resolves its level from baked offsets. One pipeline instead of one per
  // level — fewer compile stalls at launch, fewer dispatches per frame.
  const copySlots = [];
  let copyTotal = 0;
  for (let li = 0; li < levelCount; li++) {
    for (let bin = 0; bin < mip.levels[li].bins; bin++) {
      copySlots.push({ li, bin, start: copyTotal });
      copyTotal += mip.levels[li].count;
    }
  }
  const copyNode = Fn(() => {
    const ti = instanceIndex;
    for (const slot of copySlots) {
      const level = mip.levels[slot.li];
      const d = level.dims;
      const offX = level.atlasX + slot.bin * level.binAtlasStride;
      If(
        ti
          .greaterThanEqual(uint(slot.start))
          .and(ti.lessThan(uint(slot.start + level.count))),
        () => {
          const local = ti.sub(uint(slot.start));
          const z = local.div(uint(d.x * d.y));
          const rem = local.sub(z.mul(uint(d.x * d.y)));
          const y = rem.div(uint(d.x));
          const x = rem.sub(y.mul(uint(d.x)));
          const val = readBin(slot.li, slot.bin, local);
          textureStore(
            cfg.radianceAtlas,
            ivec3(x.toInt().add(int(offX)), y.toInt(), z.toInt()),
            val,
          ).toWriteOnly();
        },
      );
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
      const dir = probeAt("rayDirs", rayIdx).xyz;
      const origin = probePosition(probeIdx).add(dir.mul(u.voxelSize.mul(0.5)));
      if (traceTriangleRadiance) {
        If(u.rayTracingEnabled.greaterThan(uint(0)), () => {
          probeAt("rays", slot).assign(traceTriangleRadiance(origin, dir));
        }).Else(() => {
          probeAt("rays", slot).assign(marchRadiance(origin, dir));
        });
      } else {
        probeAt("rays", slot).assign(marchRadiance(origin, dir));
      }
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
      const texelDir = probeAt("texelDirs", texelIdx).xyz;

      const sum = vec3(0).toVar();
      const wsum = float(0).toVar();
      const distanceSum = float(0).toVar();
      const distanceSqSum = float(0).toVar();
      const visibilityWeightSum = float(0).toVar();
      Loop(RAYS_PER_PROBE, ({ i }) => {
        const rd = probeAt("rayDirs", i).xyz;
        const w = max(dot(texelDir, rd), 0);
        const raySample = probeAt(
          "rays",
          probeSlot.mul(uint(RAYS_PER_PROBE)).add(i.toUint()),
        ).toVar();
        sum.addAssign(raySample.xyz.mul(w));
        wsum.addAssign(w);
        // Visibility needs a tighter directional lobe than irradiance;
        // otherwise a nearby blocker is blurred across half a sphere.
        const visibilityWeight = pow(w, 8);
        const rayDistance = clamp(
          raySample.w,
          0,
          u.probeMaxDistance,
        );
        distanceSum.addAssign(rayDistance.mul(visibilityWeight));
        distanceSqSum.addAssign(
          rayDistance.mul(rayDistance).mul(visibilityWeight),
        );
        visibilityWeightSum.addAssign(visibilityWeight);
      });
      const fresh = sum.div(max(wsum, 1e-4));
      const freshMean = distanceSum.div(
        max(visibilityWeightSum, 1e-4),
      );
      const freshMeanSq = distanceSqSum.div(
        max(visibilityWeightSum, 1e-4),
      );

      const dst = probeIdx.mul(uint(TEXELS)).add(texelIdx);
      const oldMoments = probeAt("visibility", dst).toVar();
      // A zero-filled probe has no valid history. Mixing its first result
      // against black at high hysteresis made untouched objects remain black
      // until movement happened to schedule dozens of extra probe sweeps.
      const irradianceHysteresis = u.hysteresis.mul(
        oldMoments.z,
      );
      const blended = mix(
        fresh,
        probeAt("irradiance", dst).xyz,
        irradianceHysteresis,
      );
      probeAt("irradiance", dst).assign(vec4(blended, 1));
      // Distance history reacts faster than radiance history so moving
      // blockers stop leaking light promptly. Invalid probes use fresh data
      // immediately instead of blending against zero-filled storage.
      const visibilityHysteresis = min(u.hysteresis, 0.65).mul(
        oldMoments.z,
      );
      const blendedMean = mix(
        freshMean,
        oldMoments.x,
        visibilityHysteresis,
      );
      const blendedMeanSq = mix(
        freshMeanSq,
        oldMoments.y,
        visibilityHysteresis,
      );
      probeAt("visibility", dst).assign(
        vec4(blendedMean, blendedMeanSq, 1, 0),
      );

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
  // On recenter, surviving probes keep their converged irradiance and
  // visibility moments by moving within the grid (gather via scratch copies
  // because a parallel in-place shift would race). Freshly exposed probes
  // edge-extend or seed from sky/unoccluded distance after a teleport.
  // The apply pass also rewrites the octa atlas so materials never sample
  // stale tiles.
  const probeTotal = probeCount * TEXELS;

  const probeShiftSaveNode = Fn(() => {
    const i = instanceIndex;
    If(i.lessThan(uint(probeTotal)), () => {
      probeAt("irradianceScratch", i).assign(
        probeAt("irradiance", i),
      );
      probeAt("visibilityScratch", i).assign(
        probeAt("visibility", i),
      );
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
      const irradianceEdge = probeAt(
        "irradianceScratch",
        srcIdx.mul(uint(TEXELS)).add(texelIdx),
      );
      const visibilityEdge = probeAt(
        "visibilityScratch",
        srcIdx.mul(uint(TEXELS)).add(texelIdx),
      );
      const v = mix(
        irradianceEdge,
        vec4(u.skyColor.mul(0.5), 1),
        u.reseedSky,
      ).toVar();
      const visibilitySeed = vec4(
        u.probeMaxDistance,
        u.probeMaxDistance.mul(u.probeMaxDistance),
        1,
        0,
      );
      probeAt("irradiance", slot).assign(v);
      probeAt("visibility", slot).assign(
        mix(visibilityEdge, visibilitySeed, u.reseedSky),
      );

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

  const atlasDimsVec = radianceAtlasDims;

  // Trilinear fetch of grid-space coords `g` at integer pyramid `level`.
  // Level layout is baked as constants and selected with an unrolled branch
  // chain — no storage-buffer reads in the fragment stage, and every sample
  // uses explicit LOD 0 (implicit derivatives inside loops are illegal WGSL).
  // Anisotropic fetch: radiance arriving at the receiver left the surface
  // toward -dir, so per axis we pick the bin whose axis opposes the ray
  // direction and blend the three axis bins with squared-direction weights
  // (the standard VXGI anisotropic sample). Level 0 stays a single
  // isotropic slot — its per-cell sidedness gate runs in the trace loop.
  const sampleLevel = (g, levelI, dir) => {
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
        if (li === 0) {
          const texel = local.add(vec3(L.atlasX, 0, 0));
          result.assign(radianceTex.sample(texel.div(atlasDimsVec)).level(0));
        } else {
          // Bin pair order (+X,-X,...): dir.axis ≥ 0 selects the negative
          // bin of the pair (surfaces facing against the ray).
          const stride = L.binAtlasStride;
          const base = float(L.atlasX);
          const fetchBin = (binIndexNode) => {
            const texel = local.add(
              vec3(base.add(binIndexNode.mul(stride)), 0, 0),
            );
            return radianceTex.sample(texel.div(atlasDimsVec)).level(0);
          };
          const sx = fetchBin(step(0, dir.x));
          const sy = fetchBin(step(0, dir.y).add(2));
          const sz = fetchBin(step(0, dir.z).add(4));
          const wx = dir.x.mul(dir.x);
          const wy = dir.y.mul(dir.y);
          const wz = dir.z.mul(dir.z);
          // Opacity-weighted renormalization: each bin's rgb is a
          // full-strength mean, so averaging by (weight × bin opacity)
          // returns full-strength radiance from any front direction —
          // an empty axis bin dilutes nothing. Alpha stays the plain
          // direction-weighted opacity (a floor barely occludes rays
          // grazing along it, which also removes the old gray veil).
          const ax = sx.w.mul(wx);
          const ay = sy.w.mul(wy);
          const az = sz.w.mul(wz);
          const alpha = ax.add(ay).add(az);
          const rgb = sx.xyz
            .mul(ax)
            .add(sy.xyz.mul(ay))
            .add(sz.xyz.mul(az))
            .div(max(alpha, 1e-5));
          result.assign(vec4(rgb, alpha));
        }
      });
    }
    return result;
  };

  // Fractional-level fetch (quadrilinear across two pyramid levels).
  const sampleCone = Fn(([g, levelF, dir]) => {
    const l0 = clamp(floor(levelF), 0, levelCount - 1);
    const l1 = min(l0.add(1), float(levelCount - 1));
    const f = fract(levelF);
    return mix(
      sampleLevel(g, l0.toInt(), dir),
      sampleLevel(g, l1.toInt(), dir),
      f,
    );
  });

  // Built per step-budget: diffuse uses the full budget, specular a smaller
  // one (a single reflection cone converges fast and its aperture blurs the
  // tail anyway, so the extra marches are wasted work).
  //
  // Diffuse traces return rgb = bounced light + surviving sky, w = LOCAL
  // visibility. Occlusion is distance-weighted over aoRadius voxels, so a
  // far wall blocks sky/radiance correctly without pretending to be contact
  // AO. Specular traces keep w = total opacity and do not add sky.
  const makeTraceCone = (steps, diffuse = false) =>
    Fn(([origin, dir, aperture, minLevel]) => {
    const acc = vec3(0).toVar();
    const alpha = float(0).toVar();
    const localOcclusion = float(0).toVar();
    // Fixed phase keeps the gather continuous as a receiver moves. Cell-hash
    // jitter produced visible rectangular regions at voxel boundaries.
    const t = u.voxelSize.mul(0.65).toVar();
    Loop(steps, () => {
      const diameter = max(u.voxelSize, aperture.mul(2).mul(t));
      const pos = origin.add(dir.mul(t));
      const g = toVoxelSpace(pos).toVar();
      If(inBounds(g).not(), () => {
        Break();
      });
      If(alpha.greaterThan(0.95), () => {
        Break();
      });
      const level = clamp(log2(diameter.div(u.voxelSize)), minLevel, levelCount - 1);
      const s = sampleCone(g, level, dir);
      // Sidedness gate at fine levels only: near hits are what leak a wall's
      // lit exterior face into an interior receiver. By level ~1.75 the
      // filtered footprint spans many cells and one normal no longer
      // describes it, so the gate fades out (alpha has typically saturated
      // well before then). Opacity/AO accumulation is never gated — a
      // back-facing wall still occludes.
      const sideGate = float(1).toVar();
      const gateBlend = clamp(float(1.75).sub(level), 0, 1);
      If(gateBlend.greaterThan(0), () => {
        sideGate.assign(
          mix(float(1), radianceSideGate(g, dir), gateBlend),
        );
      });
      // Opacity correction: rescale coverage to the fraction of the SAMPLED
      // level's voxel this step spans (≈0.5 at every level). Dividing by the
      // level-0 voxel size instead blows the exponent up to 2^level/2 at
      // coarse mips — a few percent of blurred coverage then reads as ~50%
      // opacity, and open-air cones "occlude" on nothing (the everything-
      // is-dark bug).
      const stepLen = diameter.mul(0.5);
      const a = float(1).sub(pow(float(1).sub(clamp(s.w, 0, 1)), stepLen.div(diameter)));
      const transmittance = float(1).sub(alpha);
      const contribution = a.mul(transmittance);
      // Cone weights form a cosine-weighted average of outgoing surface
      // radiance. The lighting model consumes irradiance, whose hemispherical
      // integral carries a PI factor. Omitting it divided every reflected
      // bounce by PI a second time, making incident-light colour bleeding
      // effectively invisible beside the sky/environment contribution.
      acc.addAssign(
        s.xyz
          .mul(contribution)
          .mul(sideGate)
          .mul(diffuse ? u.bounce.mul(Math.PI) : 1),
      );
      if (diffuse) {
        const falloff = clamp(
          float(1).sub(t.div(u.voxelSize.mul(max(u.aoRadius, 1)))),
          0,
          1,
        );
        // Squared distance falloff keeps AO at contacts/cavities instead of
        // laying a broad gray veil over whole walls.
        localOcclusion.addAssign(contribution.mul(falloff.mul(falloff)));
      }
      alpha.addAssign(contribution);
      t.addAssign(stepLen);
    });
    if (diffuse) {
      // Residual environment by transmittance: cones that saturate on walls
      // contribute ~zero, and a shrinking wall opening dims the room
      // continuously. The energy itself comes from the probe field, not raw
      // sky — coarse-mip opacity dilution let ~half the sky through sealed
      // one-voxel walls, which is why moving a wall previously changed
      // nothing (see probeSkyRadiance).
      const skyReach = float(1).sub(clamp(alpha, 0, 1));
      const skyTransmittance = pow(skyReach, 2);
      acc.addAssign(
        probeSkyRadiance(origin, dir).mul(skyTransmittance),
      );
      // AO channel occludes the environment/sky IBL (the lighting model
      // multiplies context.ambientOcclusion into ALL indirect). Two terms:
      //   contact  — the original distance-falloff cavity AO (subtle, keeps
      //              white surfaces white in open/normal scenes).
      //   enclosure — a SMOOTHSTEP on skyReach that stays ≈1 for any surface
      //              with meaningful sky visibility and only ramps to 0 when
      //              a receiver is strongly sealed. A plain min(skyReach,…)
      //              darkened every indoor surface (white→grey) because cone
      //              AO drops well below 1 the moment cones hit nearby walls;
      //              the smoothstep confines darkening to genuinely enclosed
      //              space so sealed rooms go dark without greying normal
      //              interiors.
      // Contact AO is deliberately subtle and strength-controlled. Applying
      // the raw cone opacity painted broad voxel-sized dirt bands along every
      // otherwise open floor/wall junction.
      // Enclosure is a separate, authoritative visibility term. Reach full
      // visibility quickly in normal/open corners; reserve darkening for
      // directions with essentially no route to the environment.
      const e = clamp(skyReach.sub(0.01).div(0.11), 0, 1);
      const enclosure = e.mul(e).mul(float(3).sub(e.mul(2)));
      // Coarse voxel contact AO was visibly blurry even after attenuation.
      // Keep only leak-preventing enclosure visibility here; fine contact AO
      // belongs to a depth-aware screen-space pass.
      return vec4(acc, enclosure);
    }
    return vec4(acc, alpha);
  });

  // The default eight inner-cascade steps stop around 28 voxels from the
  // receiver, just short of a 64-voxel clipmap boundary when starting near
  // its centre. Ten steps are enough to prove an open-sky escape; lite
  // 32-voxel cascades need eight.
  const diffuseConeSteps = cfg.lite
    ? Math.max(8, coneSteps)
    : Math.max(10, coneSteps);
  const traceCone = makeTraceCone(diffuseConeSteps, true);
  // Specular reflections: ~60% of the diffuse step budget (min 6).
  const traceConeSpec = makeTraceCone(Math.max(6, Math.round(coneSteps * 0.6)));

  // Sun visibility: ONE opacity cone along the light direction through the
  // same alpha-mipped radiance atlas the GI gathers from. This is the
  // representation that already renders stably under camera motion — unlike
  // the unsigned shell SDF it has no degenerate near-surface field, the mip
  // chain's aMax term preserves thin occluders (no tunneling), and penumbra
  // widens with distance via the cone aperture. Slightly larger step budget
  // than specular: shadow rays must reach across the whole grid.
  const traceConeShadow = makeTraceCone(Math.max(12, Math.round(baseConeSteps * 1.5)));
  const coneShadow = Fn(([P, N, L, aperture]) => {
    // Same proven origin lift as the diffuse gather — clear of the
    // receiver's own voxel slab, no per-surface bias tuning.
    const origin = P.add(N.mul(max(u.normalBias, u.voxelSize.mul(1.75))));
    // minLevel 0.5 like specular: level-0 fetches are voxel-sharp and read
    // as acne/banding on the shadow edge.
    const r = traceConeShadow(origin, L, aperture, float(cfg.lite ? 1 : 0.5));
    return float(1).sub(clamp(r.w, 0, 1));
  });

  // 6-cone diffuse gather → vec4(bounce+sky radiance, ambient occlusion).
  // The AO term is the cones' average visibility; the light node multiplies
  // it into `context.ambientOcclusion`, which the physical lighting model
  // applies to ALL indirect light (ambient, HDRI IBL, and this GI) after
  // accumulation — that's what actually darkens corners in a lit scene.
  /**
   * Direct irradiance from emissive-mesh proxies at the visible receiver.
   * Visibility is evaluated during the world-space direct-cache sweep, so
   * this lookup is cheap, temporally accumulated, and shadowed.
   */
  const sampleEmissiveCacheTrilinear = Fn(
    ([worldPosition, surfaceNormal]) => {
    // Voxel values live at cell centres. Reconstruct continuously in world
    // space instead of exposing one nearest cell as a large screen-space
    // square on floors and walls.
    const g = toVoxelSpace(worldPosition).sub(0.5).toVar();
    const base = floor(g).toVar();
    const f = fract(g).toVar();
    const result = vec3(0).toVar();
    const weightSum = float(0).toVar();

    for (let dz = 0; dz <= 1; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const c = base.add(vec3(dx, dy, dz)).toVar();
          const wx = dx === 0 ? float(1).sub(f.x) : f.x;
          const wy = dy === 0 ? float(1).sub(f.y) : f.y;
          const wz = dz === 0 ? float(1).sub(f.z) : f.z;
          const spatialWeight = wx.mul(wy).mul(wz);
          If(inBounds(c), () => {
            const vi = voxelLinear(c);
            const normalWord = voxNormal.element(vi).toVar();
            // Empty voxels have no packed normal. Occupied-but-shadowed
            // receivers remain valid even when their emissive RGBE value is
            // exact black, so normal storage supplies the validity mask.
            If(
              normalWord
                .bitAnd(uint(0x00ffffff))
                .greaterThan(uint(0)),
              () => {
              const cachedNormal = normalize(
                unpack888(normalWord).mul(2).sub(1),
              );
              // Signed agreement for single-sided cells: abs() here let the
              // interior face of a one-voxel ceiling read the cache value
              // its exterior face received from an emissive panel above —
              // light through a sealed ceiling. Two-sided cells keep abs():
              // their injection flips the normal per light, so either
              // orientation is a legitimate lit face.
              const facing = dot(cachedNormal, surfaceNormal);
              const twoSided = normalWord
                .shiftRight(uint(24))
                .bitAnd(uint(1))
                .toFloat();
              // Junction cells (AMBIGUOUS_NORMAL) have meaningless cached
              // normals, so the normal test is skipped for them; they also
              // receive no emissive injection, so passing them leaks
              // nothing.
              const ambiguous = normalWord
                .shiftRight(uint(27))
                .bitAnd(uint(1))
                .toFloat();
              const normalWeight = mix(
                pow(mix(clamp(facing, 0, 1), abs(facing), twoSided), 8),
                float(1),
                ambiguous,
              );
              const weight = spatialWeight.mul(normalWeight);
              result.addAssign(
                unpackRGBE8(
                  voxEmissiveDirect.element(vi),
                ).mul(weight),
              );
              weightSum.addAssign(weight);
              },
            );
          });
        }
      }
    }

    return vec4(
      result.div(max(weightSum, 1e-4)),
      clamp(weightSum, 0, 1),
    );
  },
  );

  const sampleEmissiveReceiver = Fn(([P, N]) => {
    const result = vec3(0).toVar();
    const bestSupport = float(0).toVar();
    const selectedOffset = float(0).toVar();

    // Surface positions can land numerically on either side of their voxel.
    // Search a narrow normal segment and keep the sample with the strongest
    // normal-aligned occupied support, preferring the exact receiver on ties.
    // Choosing the brightest sample erased valid black shadow-cache values by
    // borrowing light from an adjacent voxel on the same surface.
    for (const offset of [0, -0.45, 0.45]) {
      const sample = sampleEmissiveCacheTrilinear(
        P.add(N.mul(u.voxelSize.mul(offset))),
        N,
      ).toVar();
      const support = sample.w.mul(offset === 0 ? 1.001 : 1).toVar();
      If(support.greaterThan(bestSupport), () => {
        bestSupport.assign(support);
        result.assign(sample.xyz);
        selectedOffset.assign(offset);
      });
    }

    // The receiver cache is a sparse voxel shell. Trilinear reconstruction
    // alone is continuous, but its slope still changes at every cell and
    // shows up as large rectangular irradiance patches on flat walls. Apply
    // a compact world-space cross in the receiver tangent plane. All taps
    // retain the normal-aware validity test above, so this smooths lighting
    // across one cell without borrowing through an edge or opposite wall.
    const ref = mix(vec3(0, 0, 1), vec3(1, 0, 0), step(0.9, abs(N.z)));
    const tangent = normalize(cross(ref, N));
    const bitangent = cross(N, tangent);
    const selectedPosition = P.add(
      N.mul(u.voxelSize.mul(selectedOffset)),
    );
    const filtered = result.mul(bestSupport.mul(4)).toVar();
    const filterWeight = bestSupport.mul(4).toVar();
    for (const offset of [
      [-0.85, 0],
      [0.85, 0],
      [0, -0.85],
      [0, 0.85],
    ]) {
      const tap = sampleEmissiveCacheTrilinear(
        selectedPosition
          .add(tangent.mul(u.voxelSize.mul(offset[0])))
          .add(bitangent.mul(u.voxelSize.mul(offset[1]))),
        N,
      ).toVar();
      filtered.addAssign(tap.xyz.mul(tap.w));
      filterWeight.addAssign(tap.w);
    }
    If(filterWeight.greaterThan(1e-4), () => {
      result.assign(filtered.div(filterWeight));
    });

    // Cache storage is Lambertian E/PI; the material context consumes E.
    // Preserve support so non-voxelized receivers (notably animated skinned
    // meshes) can fall back to the world-space probe field below.
    return vec4(
      result.mul(Math.PI).mul(u.bounce),
      clamp(bestSupport, 0, 1),
    );
  });

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
      const r = traceCone(
        origin,
        dir,
        float(coneAperture),
        // Level zero exposes individual radiance voxels on broad receivers.
        // A half-level minimum preserves near-field shape while blending in
        // the first filtered mip, greatly reducing cell-sized RGB dirt.
        float(cfg.lite ? 1 : 0.5),
      );
      total.addAssign(r.xyz.mul(cone.w));
      visibility.addAssign(r.w.mul(cone.w));
    }
    // Cone visibility is conservative and voxel-scale. Feeding it into the
    // material at full strength exposed that coarse lattice as broad gray AO
    // blocks, and also meant the user-facing AO Strength was never applied.
    // Blend from unoccluded visibility so strength=1 retains the sealed-room
    // mask while the default does not masquerade as contact-detail AO.
    const ao = mix(float(1), visibility, u.aoStrength);
    // The deferred compute shader contains all cascades in one bind group.
    // Per-surface emissive caches cost two storage buffers per volume, and
    // dynamic proxy evaluation costs three more. Bind those detailed paths
    // only for the inner cascade; lite outer cascades contribute their
    // low-frequency probe field without duplicating receiver buffers. This
    // keeps the complete three-cascade compute layout at the portable limit
    // of eight storage buffers.
    const emissiveReceiver = cfg.lite
      ? vec4(0, 0, 0, 0).toVar()
      : sampleEmissiveReceiver(P, N).toVar();
    const gathered = total
      .mul(u.intensity)
      .add(emissiveReceiver.xyz.mul(u.intensity));
    return vec4(
      gathered,
      ao,
    );
  });

  // Stable low-frequency probe field remains available for debug/fallback.
  // Visible emissive direct lighting now comes from the world-aligned receiver
  // cache above rather than an expensive per-screen-pixel shadow trace.
  const probeDiffuse = Fn(([P, N]) => {
    const smooth = sampleProbeField(P, N);
    return vec4(smooth.xyz, 1);
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

  // Camera-distance cascade weight. Basing this on gridMin made the entire
  // blend boundary jump whenever a clipmap atomically recentered. The camera
  // moves continuously, so this weight also moves continuously; the narrower
  // safe radius remains inside a clipmap even at the recenter deadband limit.
  const edgeFade = Fn(([P]) => {
    const d = abs(P.sub(u.cascadeCenter));
    const normalizedDistance = max(d.x, max(d.y, d.z)).div(
      max(u.cascadeHalfExtent, 1e-4),
    );
    const weight = clamp(
      float(0.62)
        .sub(normalizedDistance)
        .div(0.2),
      0,
      1,
    );
    // Hermite easing removes a visible derivative change at either end of
    // the cross-cascade region.
    return weight
      .mul(weight)
      .mul(float(3).sub(weight.mul(2)))
      .mul(u.cascadeBlend);
  });

  return {
    uniforms: u,
    injectDirectNode,
    publishDirectNode,
    blendEmissiveDirectNode,
    injectNode,
    mipPasses,
    copyNode,
    traceNode,
    integrateNode,
    probeShiftSaveNode,
    probeShiftApplyNode,
    probeCount,
    levelCount,
    directChunks: DIRECT_LIGHT_CHUNKS,
    /** Diffuse GI node (vec4: rgb, w=AO) — unfaded; callers blend by fade. */
    createDiffuseSampler: () => coneDiffuse(positionWorld, normalWorld),
    /** Raw Fns for the deferred screen-space pass (explicit P/N args). */
    probeDiffuseFn: probeDiffuse,
    coneDiffuseFn: coneDiffuse,
    /** Sun visibility 0..1 via one opacity cone: (P, N, dirToLight, aperture). */
    coneShadowFn: coneShadow,
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
      // AO (enclosure visibility) occludes the environment/sky IBL. The
      // gentle smoothstep curve keeps it ≈1 in open/normal scenes, so the
      // GI's own colour bleed in gi.xyz is not meaningfully dimmed there;
      // it only drops toward 0 in genuinely sealed space. (A prior attempt
      // pre-divided gi.xyz by ao to protect the bleed, but that flashed
      // bright then settled as the AO converged — the "accumulate then
      // fade" — so it was removed in favour of the plain, stable multiply.)
      if (builder.context.ambientOcclusion) {
        builder.context.ambientOcclusion.mulAssign(clamp(gi.w, 0, 1));
      }
    }
    if (factories.specular && builder.context.radiance) {
      builder.context.radiance.addAssign(factories.specular());
    }
  }
}
