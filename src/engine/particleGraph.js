import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import {
  Fn,
  PI2,
  clamp,
  cross,
  float,
  hash,
  instancedArray,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_noise_vec3,
  mx_worley_noise_float,
  normalize,
  smoothstep,
  time,
  vec3,
} from "three/tsl";
import { resolveAssetUrl } from "./assetResolver.js";

/**
 * Node-based GPU particle system: a graph of small logic nodes (emitters,
 * particle attributes, math, noise fields, forces) compiled to TSL and
 * evaluated in three contexts:
 *
 *   spawn  — init pass + respawn branch (per-respawn randomness available)
 *   update — per-frame compute pass (storage-buffer element access)
 *   render — sprite material (per-instance attribute access)
 *
 * The same wire can feed any context; attribute nodes (age, position, …)
 * resolve to whatever that context provides. The System node anchors the
 * graph: its inputs are the six evaluation roots.
 */

const MESH_SAMPLE_COUNT = 2048;

// ---------------------------------------------------------------------------
// Node registry (metadata drives both the editor UI and the compiler)
// ---------------------------------------------------------------------------

const num = (key, label, def, extra = {}) => ({ key, label, type: "number", default: def, ...extra });
const v3 = (key, label, def) => ({ key, label, type: "vec3", default: def });
const col = (key, label, def) => ({ key, label, type: "color", default: def });

export const P_NODE_TYPES = {
  // --- Emitters: where particles are born. Outputs: pos + dir. -------------
  emitPoint: {
    label: "Point",
    category: "emitter",
    inputs: [],
    outputs: [{ key: "pos", label: "pos" }, { key: "dir", label: "dir" }],
    params: [v3("offset", "Offset", [0, 0, 0])],
  },
  emitSphere: {
    label: "Sphere",
    category: "emitter",
    inputs: [],
    outputs: [{ key: "pos", label: "pos" }, { key: "dir", label: "dir" }],
    params: [num("radius", "Radius", 0.5, { min: 0, step: 0.05 }), { key: "shell", label: "Shell only", type: "boolean", default: false }],
  },
  emitBox: {
    label: "Box",
    category: "emitter",
    inputs: [],
    outputs: [{ key: "pos", label: "pos" }, { key: "dir", label: "dir" }],
    params: [v3("size", "Size", [1, 1, 1])],
  },
  emitCone: {
    label: "Cone",
    category: "emitter",
    inputs: [],
    outputs: [{ key: "pos", label: "pos" }, { key: "dir", label: "dir" }],
    params: [num("radius", "Radius", 0.25, { min: 0, step: 0.05 }), num("angle", "Angle °", 25, { min: 0, max: 89 })],
  },
  emitCircle: {
    label: "Ring",
    category: "emitter",
    inputs: [],
    outputs: [{ key: "pos", label: "pos" }, { key: "dir", label: "dir" }],
    params: [num("radius", "Radius", 1, { min: 0, step: 0.05 })],
  },
  emitMesh: {
    label: "Mesh Surface",
    category: "emitter",
    inputs: [],
    outputs: [{ key: "pos", label: "pos" }, { key: "dir", label: "normal" }],
    params: [
      { key: "path", label: "Model", type: "asset", exts: ["glb"], default: "" },
      num("scale", "Scale", 1, { min: 0.01, step: 0.1 }),
    ],
  },

  // --- Particle attributes (context-dependent reads) -----------------------
  pAge: { label: "Age", category: "attribute", inputs: [], outputs: [{ key: "out", label: "s" }], params: [] },
  pLife: { label: "Life 0–1", category: "attribute", inputs: [], outputs: [{ key: "out", label: "t" }], params: [] },
  pPosition: { label: "Position", category: "attribute", inputs: [], outputs: [{ key: "out", label: "xyz" }], params: [] },
  pVelocity: { label: "Velocity", category: "attribute", inputs: [], outputs: [{ key: "out", label: "xyz" }], params: [] },
  pRandom: {
    label: "Random",
    category: "attribute",
    inputs: [],
    outputs: [{ key: "out", label: "f" }],
    params: [num("seed", "Seed", 1), num("min", "Min", 0), num("max", "Max", 1)],
  },
  simTime: { label: "Time", category: "attribute", inputs: [], outputs: [{ key: "out", label: "s" }], params: [] },

  // --- Values ---------------------------------------------------------------
  float: { label: "Float", category: "value", inputs: [], outputs: [{ key: "out", label: "f" }], params: [num("value", "Value", 1)] },
  vec3: { label: "Vec3", category: "value", inputs: [], outputs: [{ key: "out", label: "xyz" }], params: [v3("value", "Value", [0, 1, 0])] },
  color: { label: "Color", category: "value", inputs: [], outputs: [{ key: "out", label: "rgb" }], params: [col("value", "Color", "#ffffff")] },
  gradient: {
    label: "Gradient",
    category: "value",
    inputs: [{ key: "t", label: "t (life)" }],
    outputs: [{ key: "out", label: "rgb" }],
    params: [col("from", "From", "#ffd27f"), col("to", "To", "#ff3300")],
  },

  // --- Math -------------------------------------------------------------------
  add: { label: "Add", category: "math", inputs: [{ key: "a", label: "a" }, { key: "b", label: "b" }], outputs: [{ key: "out", label: "=" }], params: [] },
  multiply: { label: "Multiply", category: "math", inputs: [{ key: "a", label: "a" }, { key: "b", label: "b" }], outputs: [{ key: "out", label: "=" }], params: [] },
  mix: {
    label: "Mix",
    category: "math",
    inputs: [{ key: "a", label: "a" }, { key: "b", label: "b" }, { key: "t", label: "t" }],
    outputs: [{ key: "out", label: "=" }],
    params: [],
  },
  remap: {
    label: "Remap",
    category: "math",
    inputs: [{ key: "v", label: "v" }],
    outputs: [{ key: "out", label: "=" }],
    params: [num("inMin", "In min", 0), num("inMax", "In max", 1), num("outMin", "Out min", 0), num("outMax", "Out max", 1)],
  },
  sine: {
    label: "Sine",
    category: "math",
    inputs: [{ key: "t", label: "t" }],
    outputs: [{ key: "out", label: "=" }],
    params: [num("frequency", "Frequency", 1), num("amplitude", "Amplitude", 1), num("phase", "Phase", 0)],
  },
  normalizeV: { label: "Normalize", category: "math", inputs: [{ key: "v", label: "v" }], outputs: [{ key: "out", label: "n̂" }], params: [] },
  lengthV: { label: "Length", category: "math", inputs: [{ key: "v", label: "v" }], outputs: [{ key: "out", label: "f" }], params: [] },
  combine: {
    label: "Combine XYZ",
    category: "math",
    inputs: [{ key: "x", label: "x" }, { key: "y", label: "y" }, { key: "z", label: "z" }],
    outputs: [{ key: "out", label: "xyz" }],
    params: [],
  },
  split: {
    label: "Split XYZ",
    category: "math",
    inputs: [{ key: "v", label: "v" }],
    outputs: [{ key: "x", label: "x" }, { key: "y", label: "y" }, { key: "z", label: "z" }],
    params: [],
  },

  // --- Noise fields (input p defaults to particle position) -------------------
  noise: {
    label: "Noise",
    category: "noise",
    inputs: [{ key: "p", label: "p" }],
    outputs: [{ key: "out", label: "f" }],
    params: [num("frequency", "Frequency", 1), num("speed", "Scroll", 0.3), num("amplitude", "Amplitude", 1)],
  },
  noiseField: {
    label: "Noise Field",
    category: "noise",
    inputs: [{ key: "p", label: "p" }],
    outputs: [{ key: "out", label: "xyz" }],
    params: [num("frequency", "Frequency", 1), num("speed", "Scroll", 0.3), num("amplitude", "Amplitude", 1)],
  },
  curl: {
    label: "Curl Noise",
    category: "noise",
    inputs: [{ key: "p", label: "p" }],
    outputs: [{ key: "out", label: "xyz" }],
    params: [num("frequency", "Frequency", 0.6), num("speed", "Scroll", 0.25), num("amplitude", "Amplitude", 1)],
  },
  worley: {
    label: "Worley",
    category: "noise",
    inputs: [{ key: "p", label: "p" }],
    outputs: [{ key: "out", label: "f" }],
    params: [num("frequency", "Frequency", 1), num("speed", "Scroll", 0.2), num("amplitude", "Amplitude", 1)],
  },
  fractal: {
    label: "Fractal Noise",
    category: "noise",
    inputs: [{ key: "p", label: "p" }],
    outputs: [{ key: "out", label: "f" }],
    params: [num("frequency", "Frequency", 1), num("octaves", "Octaves", 3, { min: 1, max: 6, step: 1 }), num("speed", "Scroll", 0.2), num("amplitude", "Amplitude", 1)],
  },

  // --- Forces: vec3 accelerations wired (usually via Add) into System.force ---
  gravity: { label: "Gravity", category: "force", inputs: [], outputs: [{ key: "out", label: "F" }], params: [v3("vector", "m/s²", [0, -9.8, 0])] },
  drag: { label: "Drag", category: "force", inputs: [], outputs: [{ key: "out", label: "F" }], params: [num("amount", "Amount", 1, { min: 0 })] },
  turbulence: {
    label: "Turbulence",
    category: "force",
    inputs: [],
    outputs: [{ key: "out", label: "F" }],
    params: [num("frequency", "Frequency", 0.6), num("strength", "Strength", 2), num("speed", "Scroll", 0.3)],
  },
  vortex: {
    label: "Vortex",
    category: "force",
    inputs: [],
    outputs: [{ key: "out", label: "F" }],
    params: [v3("center", "Center", [0, 0, 0]), v3("axis", "Axis", [0, 1, 0]), num("strength", "Swirl", 5), num("pull", "Pull in", 0.5)],
  },
  attract: {
    label: "Attractor",
    category: "force",
    inputs: [],
    outputs: [{ key: "out", label: "F" }],
    params: [v3("point", "Point", [0, 2, 0]), num("strength", "Strength", 5), num("falloff", "Falloff", 1, { min: 0 })],
  },
  buoyancy: {
    label: "Buoyancy",
    category: "force",
    inputs: [],
    outputs: [{ key: "out", label: "F" }],
    params: [num("strength", "Heat", 3), num("flicker", "Flicker", 0.5)],
  },
  wind: {
    label: "Wind",
    category: "force",
    inputs: [],
    outputs: [{ key: "out", label: "F" }],
    params: [v3("direction", "Direction", [1, 0, 0]), num("strength", "Strength", 1), num("gustiness", "Gustiness", 0.5), num("gustFrequency", "Gust freq", 0.5)],
  },

  // --- System: the anchor. Inputs are the six evaluation roots. ---------------
  system: {
    label: "Particle System",
    category: "system",
    inputs: [
      { key: "position", label: "spawn position" },
      { key: "velocity", label: "spawn velocity" },
      { key: "force", label: "force" },
      { key: "size", label: "size" },
      { key: "color", label: "color" },
      { key: "opacity", label: "opacity" },
    ],
    outputs: [],
    params: [
      num("capacity", "Capacity", 2000, { min: 1, max: 100000, step: 100 }),
      num("lifetime", "Lifetime s", 2, { min: 0.05, step: 0.1 }),
      num("lifetimeJitter", "Life jitter", 0.3, { min: 0, max: 1, step: 0.05 }),
      num("sizeJitter", "Size jitter", 0.3, { min: 0, max: 1, step: 0.05 }),
      { key: "additive", label: "Additive", type: "boolean", default: true },
      { key: "texture", label: "Sprite", type: "asset", exts: ["png", "jpg", "jpeg", "webp"], default: "" },
      { key: "floor", label: "Floor", type: "select", options: ["none", "bounce", "kill"], default: "none" },
      num("floorY", "Floor Y", 0, { step: 0.1 }),
      num("bounce", "Bounce", 0.4, { min: 0, max: 1, step: 0.05 }),
    ],
  },
};

export function nodeDefaults(type) {
  const meta = P_NODE_TYPES[type];
  return Object.fromEntries(
    (meta?.params ?? []).map((p) => [p.key, Array.isArray(p.default) ? [...p.default] : p.default]),
  );
}

// ---------------------------------------------------------------------------
// TSL helpers
// ---------------------------------------------------------------------------

const unitSphere = (r1, r2) => {
  const z = r1.mul(2).sub(1);
  const phi = r2.mul(PI2);
  const xy = z.mul(z).oneMinus().max(0).sqrt();
  return vec3(phi.cos().mul(xy), z, phi.sin().mul(xy));
};

/** Divergence-free curl of a vec3 noise field (finite differences). */
const curlNoise = /*@__PURE__*/ Fn(([p]) => {
  const e = float(0.1);
  const dx = vec3(e, 0, 0);
  const dy = vec3(0, e, 0);
  const dz = vec3(0, 0, e);

  const x0 = mx_noise_vec3(p.sub(dx)).toVar();
  const x1 = mx_noise_vec3(p.add(dx)).toVar();
  const y0 = mx_noise_vec3(p.sub(dy)).toVar();
  const y1 = mx_noise_vec3(p.add(dy)).toVar();
  const z0 = mx_noise_vec3(p.sub(dz)).toVar();
  const z1 = mx_noise_vec3(p.add(dz)).toVar();

  const divisor = e.mul(2);
  return vec3(
    y1.z.sub(y0.z).sub(z1.y.sub(z0.y)),
    z1.x.sub(z0.x).sub(x1.z.sub(x0.z)),
    x1.y.sub(x0.y).sub(y1.x.sub(y0.x)),
  ).div(divisor);
});

const constV3 = (arr) => vec3(arr?.[0] ?? 0, arr?.[1] ?? 0, arr?.[2] ?? 0);
const constColor = (hex) => {
  const c = new THREE.Color(hex ?? "#ffffff");
  return vec3(c.r, c.g, c.b);
};

// ---------------------------------------------------------------------------
// Async asset preparation (mesh samples, sprite texture)
// ---------------------------------------------------------------------------

const gltfLoader = new GLTFLoader();
const meshSampleCache = new Map(); // path -> Promise<{positions: Float32Array, normals: Float32Array}>

function sampleMeshSurface(path) {
  let cached = meshSampleCache.get(path);
  if (!cached) {
    cached = (async () => {
      const url = await resolveAssetUrl(path);
      const gltf = await gltfLoader.loadAsync(url);
      let mesh = null;
      gltf.scene.traverse((o) => {
        if (!mesh && o.isMesh) mesh = o;
      });
      if (!mesh) throw new Error(`No mesh found in "${path}"`);
      mesh.updateWorldMatrix(true, false);
      const sampler = new MeshSurfaceSampler(mesh).build();
      const positions = new Float32Array(MESH_SAMPLE_COUNT * 3);
      const normals = new Float32Array(MESH_SAMPLE_COUNT * 3);
      const p = new THREE.Vector3();
      const n = new THREE.Vector3();
      for (let i = 0; i < MESH_SAMPLE_COUNT; i++) {
        sampler.sample(p, n);
        p.applyMatrix4(mesh.matrixWorld);
        positions.set([p.x, p.y, p.z], i * 3);
        normals.set([n.x, n.y, n.z], i * 3);
      }
      return { positions, normals };
    })();
    meshSampleCache.set(path, cached);
  }
  return cached;
}

const textureLoader = new THREE.TextureLoader();
const spriteTextureCache = new Map(); // path -> Promise<THREE.Texture>

function loadSpriteTexture(path) {
  let cached = spriteTextureCache.get(path);
  if (!cached) {
    cached = resolveAssetUrl(path)
      .then((url) => textureLoader.loadAsync(url))
      .then((tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      });
    spriteTextureCache.set(path, cached);
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compiles a particle graph. Async part (mesh sampling, textures) happens
 * here; the returned builders are synchronous and safe inside Fn() bodies.
 *
 * Returns {
 *   system: merged System-node params,
 *   spriteTexture: THREE.Texture | null,
 *   spawnPosition(ctx), spawnVelocity(ctx), force(ctx) | null,
 *   size(ctx), color(ctx), opacity(ctx) | null,
 * }
 * where ctx = { key, cache: Map, index, position, velocity, age, life01, rand(k) }.
 */
export async function compileParticleGraph(graph) {
  const nodes = graph?.nodes ?? [];
  const sysNode = nodes.find((n) => n.type === "system");
  if (!sysNode) throw new Error("Particle graph needs a Particle System node");

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges ?? [];
  const system = { ...nodeDefaults("system"), ...sysNode.props };

  // Async prep: mesh surface samples become storage buffers; sprite texture loads.
  const meshBuffers = new Map(); // nodeId -> {pos, nrm}
  for (const n of nodes) {
    if (n.type === "emitMesh" && n.props?.path) {
      const { positions, normals } = await sampleMeshSurface(n.props.path);
      meshBuffers.set(n.id, {
        pos: instancedArray(positions, "vec3"),
        nrm: instancedArray(normals, "vec3"),
      });
    }
  }
  const spriteTexture = system.texture ? await loadSpriteTexture(system.texture).catch((err) => {
    console.warn(`Particle sprite texture failed (${system.texture}): ${err.message ?? err}`);
    return null;
  }) : null;

  const inputEdge = (nodeId, key) =>
    edges.find((e) => e.target === nodeId && e.targetHandle === key);

  function input(nodeId, key, ctx, fallback) {
    const edge = inputEdge(nodeId, key);
    return edge ? build(edge.source, edge.sourceHandle ?? "out", ctx) : fallback;
  }

  function build(id, out, ctx) {
    const cacheKey = `${id}|${out}`;
    if (ctx.cache.has(cacheKey)) return ctx.cache.get(cacheKey);
    const node = nodeById.get(id);
    if (!node) return float(0);
    const P = { ...nodeDefaults(node.type), ...node.props };
    const value = buildNode(node, P, out, ctx);
    ctx.cache.set(cacheKey, value);
    return value;
  }

  function buildNode(node, P, out, ctx) {
    const scroll = (speed) => time.mul(speed);
    const noiseAt = (key, freqKey = "frequency", speedKey = "speed") =>
      input(node.id, key, ctx, ctx.position).mul(P[freqKey]).add(scroll(P[speedKey]));

    switch (node.type) {
      // Emitters -----------------------------------------------------------
      case "emitPoint": {
        if (out === "dir") return unitSphere(ctx.rand(1), ctx.rand(2));
        return constV3(P.offset);
      }
      case "emitSphere": {
        const dir = unitSphere(ctx.rand(1), ctx.rand(2));
        if (out === "dir") return dir;
        const r = P.shell ? float(1) : ctx.rand(3).pow(1 / 3);
        return dir.mul(r).mul(P.radius);
      }
      case "emitBox": {
        if (out === "dir") return vec3(0, 1, 0);
        return vec3(ctx.rand(1), ctx.rand(2), ctx.rand(3)).sub(0.5).mul(constV3(P.size));
      }
      case "emitCone": {
        const phi = ctx.rand(1).mul(PI2);
        const rr = ctx.rand(2).sqrt();
        if (out === "dir") {
          const tanA = Math.tan((Math.max(0.01, P.angle) * Math.PI) / 180);
          return normalize(vec3(phi.cos().mul(rr).mul(tanA), 1, phi.sin().mul(rr).mul(tanA)));
        }
        return vec3(phi.cos().mul(rr).mul(P.radius), 0, phi.sin().mul(rr).mul(P.radius));
      }
      case "emitCircle": {
        const phi = ctx.rand(1).mul(PI2);
        const radial = vec3(phi.cos(), 0, phi.sin());
        if (out === "dir") return radial;
        return radial.mul(P.radius);
      }
      case "emitMesh": {
        const buffers = meshBuffers.get(node.id);
        if (!buffers) return out === "dir" ? vec3(0, 1, 0) : vec3(0);
        const idx = ctx.rand(4).mul(MESH_SAMPLE_COUNT - 1).floor().toUint();
        if (out === "dir") return buffers.nrm.element(idx);
        return buffers.pos.element(idx).mul(P.scale);
      }

      // Attributes -----------------------------------------------------------
      case "pAge":
        return ctx.age;
      case "pLife":
        return ctx.life01;
      case "pPosition":
        return ctx.position;
      case "pVelocity":
        return ctx.velocity;
      case "pRandom":
        return hash(ctx.index.add(P.seed * 127.1)).mul(P.max - P.min).add(P.min);
      case "simTime":
        return time;

      // Values ----------------------------------------------------------------
      case "float":
        return float(P.value);
      case "vec3":
        return constV3(P.value);
      case "color":
        return constColor(P.value);
      case "gradient": {
        const t = input(node.id, "t", ctx, ctx.life01);
        return mix(constColor(P.from), constColor(P.to), clamp(t, 0, 1));
      }

      // Math --------------------------------------------------------------------
      case "add":
        return input(node.id, "a", ctx, float(0)).add(input(node.id, "b", ctx, float(0)));
      case "multiply":
        return input(node.id, "a", ctx, float(1)).mul(input(node.id, "b", ctx, float(1)));
      case "mix":
        return mix(
          input(node.id, "a", ctx, float(0)),
          input(node.id, "b", ctx, float(1)),
          clamp(input(node.id, "t", ctx, ctx.life01), 0, 1),
        );
      case "remap": {
        const v = input(node.id, "v", ctx, ctx.life01);
        const span = P.inMax - P.inMin || 1;
        return clamp(v.sub(P.inMin).div(span), 0, 1)
          .mul(P.outMax - P.outMin)
          .add(P.outMin);
      }
      case "sine": {
        const t = input(node.id, "t", ctx, time);
        return t.mul(P.frequency * Math.PI * 2).add(P.phase).sin().mul(P.amplitude);
      }
      case "normalizeV":
        return input(node.id, "v", ctx, vec3(0, 1, 0)).add(vec3(1e-6)).normalize();
      case "lengthV":
        return input(node.id, "v", ctx, vec3(0)).length();
      case "combine":
        return vec3(
          input(node.id, "x", ctx, float(0)),
          input(node.id, "y", ctx, float(0)),
          input(node.id, "z", ctx, float(0)),
        );
      case "split": {
        const v = input(node.id, "v", ctx, ctx.position);
        return out === "x" ? v.x : out === "y" ? v.y : v.z;
      }

      // Noise -----------------------------------------------------------------
      case "noise":
        return mx_noise_float(noiseAt("p")).mul(P.amplitude);
      case "noiseField":
        return mx_noise_vec3(noiseAt("p")).mul(P.amplitude);
      case "curl":
        return curlNoise(noiseAt("p")).mul(P.amplitude);
      case "worley":
        return mx_worley_noise_float(noiseAt("p")).mul(P.amplitude);
      case "fractal":
        return mx_fractal_noise_float(noiseAt("p"), Math.round(P.octaves), 2, 0.5, P.amplitude);

      // Forces -----------------------------------------------------------------
      case "gravity":
        return constV3(P.vector);
      case "drag":
        return ctx.velocity.mul(-P.amount);
      case "turbulence":
        return curlNoise(ctx.position.mul(P.frequency).add(scroll(P.speed))).mul(P.strength);
      case "vortex": {
        const axis = new THREE.Vector3(...(P.axis ?? [0, 1, 0])).normalize();
        const axisN = vec3(axis.x, axis.y, axis.z);
        const rel = ctx.position.sub(constV3(P.center));
        const radial = rel.sub(axisN.mul(rel.dot(axisN)));
        const tangent = cross(axisN, radial.add(vec3(1e-5))).normalize();
        return tangent.mul(P.strength).sub(radial.mul(P.pull));
      }
      case "attract": {
        const d = constV3(P.point).sub(ctx.position);
        const dist = d.length().add(0.01);
        return d.div(dist).mul(P.strength).div(dist.mul(P.falloff).add(1));
      }
      case "buoyancy": {
        const flicker = mx_noise_float(ctx.position.mul(2).add(scroll(2)))
          .mul(P.flicker)
          .add(1);
        return vec3(0, 1, 0).mul(P.strength).mul(ctx.life01.oneMinus()).mul(flicker);
      }
      case "wind": {
        const dir = new THREE.Vector3(...(P.direction ?? [1, 0, 0])).normalize();
        const gust = mx_noise_float(vec3(scroll(P.gustFrequency), 0, 0).add(ctx.position.mul(0.1)))
          .mul(P.gustiness)
          .add(1);
        return vec3(dir.x, dir.y, dir.z).mul(P.strength).mul(gust);
      }

      default:
        console.warn(`Unknown particle node type "${node.type}"`);
        return float(0);
    }
  }

  const root = (key, fallback) => (ctx) => input(sysNode.id, key, ctx, fallback?.(ctx));
  const wired = (key) => !!inputEdge(sysNode.id, key);

  return {
    system,
    spriteTexture,
    spawnPosition: root("position", () => vec3(0)),
    spawnVelocity: root("velocity", (ctx) => unitSphere(ctx.rand(1), ctx.rand(2)).mul(1.5)),
    force: wired("force") ? root("force") : null,
    size: root("size", () => float(0.1)),
    color: root("color", () => vec3(1, 0.8, 0.4)),
    opacity: wired("opacity") ? root("opacity") : null,
    // Soft-circle fade fallback is applied by the component when opacity is unwired.
  };
}

/** Approximates a legacy (pre-graph) particle component as a graph. */
export function legacyPropsToGraph(props) {
  const shape = props.shape === "sphere" ? "emitSphere" : props.shape === "box" ? "emitBox" : "emitPoint";
  const emitProps =
    shape === "emitSphere"
      ? { radius: props.emitterSize ?? 0.5 }
      : shape === "emitBox"
        ? { size: [props.emitterSize * 2 || 1, props.emitterSize * 2 || 1, props.emitterSize * 2 || 1] }
        : {};
  return {
    nodes: [
      { id: "emit", type: shape, props: emitProps, position: { x: 0, y: 0 } },
      { id: "speed", type: "float", props: { value: props.speed ?? 2 }, position: { x: 0, y: 160 } },
      { id: "vel", type: "multiply", props: {}, position: { x: 200, y: 90 } },
      { id: "grav", type: "gravity", props: { vector: [0, props.gravity ?? 0, 0] }, position: { x: 200, y: 240 } },
      { id: "ramp", type: "gradient", props: { from: props.startColor ?? "#ffcc66", to: props.endColor ?? "#ff3300" }, position: { x: 200, y: 380 } },
      { id: "size", type: "float", props: { value: props.size ?? 0.1 }, position: { x: 200, y: 520 } },
      { id: "sys", type: "system", props: {
        capacity: props.count ?? 500,
        lifetime: props.lifetime ?? 2,
        additive: props.additive ?? true,
      }, position: { x: 460, y: 120 } },
    ],
    edges: [
      { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
      { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
      { source: "speed", sourceHandle: "out", target: "vel", targetHandle: "b" },
      { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
      { source: "grav", sourceHandle: "out", target: "sys", targetHandle: "force" },
      { source: "ramp", sourceHandle: "out", target: "sys", targetHandle: "color" },
      { source: "size", sourceHandle: "out", target: "sys", targetHandle: "size" },
    ],
  };
}

/** Starter graph for a fresh Particles component. */
export const DEFAULT_PARTICLE_GRAPH = {
  nodes: [
    { id: "emit", type: "emitSphere", props: { radius: 0.25 }, position: { x: -40, y: 40 } },
    { id: "speed", type: "float", props: { value: 2 }, position: { x: -40, y: 240 } },
    { id: "vel", type: "multiply", props: {}, position: { x: 200, y: 140 } },
    { id: "grav", type: "gravity", props: { vector: [0, -3, 0] }, position: { x: 200, y: 300 } },
    { id: "ramp", type: "gradient", props: { from: "#ffd27f", to: "#ff3300" }, position: { x: 200, y: 460 } },
    { id: "sys", type: "system", props: { capacity: 2000, lifetime: 2 }, position: { x: 500, y: 120 } },
  ],
  edges: [
    { source: "emit", sourceHandle: "pos", target: "sys", targetHandle: "position" },
    { source: "emit", sourceHandle: "dir", target: "vel", targetHandle: "a" },
    { source: "speed", sourceHandle: "out", target: "vel", targetHandle: "b" },
    { source: "vel", sourceHandle: "out", target: "sys", targetHandle: "velocity" },
    { source: "grav", sourceHandle: "out", target: "sys", targetHandle: "force" },
    { source: "ramp", sourceHandle: "out", target: "sys", targetHandle: "color" },
  ],
};
