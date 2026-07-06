import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { resolveAssetUrl } from "./assetResolver.js";

/**
 * TSL-first shader graph. Every node maps ~1:1 to a `three/tsl` export; the
 * Output node exposes one input port per material `*Node` slot. The registry
 * drives the compiler, the editor UI, and the JS code generator.
 *
 * Graph JSON (persisted in .mat `shaderGraph`):
 *   { nodes: [{id, type, props, position}], edges: [{source, sourceHandle, target, targetHandle}] }
 *
 * compileShaderGraph(graph, {taps}) →
 *   { mutations: { <materialProp>: tslNode }, uniforms: { "<nodeId>.<key>": uniformNode }, taps: { <nodeId>: tslNode } }
 *
 * Unwired inputs with an editable default become `uniform()` nodes registered
 * in `uniforms`, so the editor can live-patch values without recompiling.
 */

const textureCache = new Map(); // path -> Promise<THREE.Texture>
const textureLoader = new THREE.TextureLoader();
function loadTexture(path) {
  let cached = textureCache.get(path);
  if (!cached) {
    cached = resolveAssetUrl(path).then((url) => textureLoader.loadAsync(url)).then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      return tex;
    });
    textureCache.set(path, cached);
  }
  return cached;
}

/** Input port spec. `def` null = wire-only; number/hex/array = inline-editable
 *  default (compiled to a uniform when unwired); `src` = fallback TSL builtin
 *  (e.g. "uv", "time") used when unwired and no value set. */
const i = (key, type, def = null, src = null, extra = null) => ({ key, type, default: def, src, ...extra });

/** Material slots exposed by the Output node. `key` is the port/edge handle,
 *  `slot` the material property the compiled node is assigned to. */
export const OUTPUT_SLOTS = [
  { key: "color", slot: "colorNode", type: "color" },
  { key: "roughness", slot: "roughnessNode", type: "float" },
  { key: "metalness", slot: "metalnessNode", type: "float" },
  { key: "normal", slot: "normalNode", type: "vec3" },
  { key: "emissive", slot: "emissiveNode", type: "color" },
  { key: "opacity", slot: "opacityNode", type: "float" },
  { key: "ao", slot: "aoNode", type: "float" },
  { key: "ior", slot: "iorNode", type: "float" },
  { key: "specularIntensity", slot: "specularIntensityNode", type: "float" },
  { key: "specularColor", slot: "specularColorNode", type: "color" },
  { key: "anisotropy", slot: "anisotropyNode", type: "float" },
  { key: "sheen", slot: "sheenNode", type: "color" },
  { key: "sheenRoughness", slot: "sheenRoughnessNode", type: "float" },
  { key: "clearcoat", slot: "clearcoatNode", type: "float" },
  { key: "clearcoatRoughness", slot: "clearcoatRoughnessNode", type: "float" },
  { key: "transmission", slot: "transmissionNode", type: "float" },
  { key: "thickness", slot: "thicknessNode", type: "float" },
  { key: "position", slot: "positionNode", type: "vec3" },
];

// --- Registry builder helpers -------------------------------------------
const src = (label, fn, out = "any") => ({ label, cat: "attribute", fn, inputs: [], out });
const fn1 = (label, fn, cat = "math", t = "any") => ({ label, cat, fn, inputs: [i("x", t)], out: t });
const fn2 = (label, fn, a = 0, b = 0, cat = "math") => ({ label, cat, fn, inputs: [i("a", "any", a), i("b", "any", b)], out: "any" });

export const NODE_TYPES = {
  // --- values (uniform-backed; old graph type names kept for back-compat) ---
  float: {
    label: "Float", cat: "value", params: [{ key: "value", type: "number", default: 1 }], out: "float",
    build: ({ props, uni, id }) => uni(`${id}.value`, TSL.uniform(props.value ?? 1)),
    gen: ({ props, use }) => `${use("uniform")}(${num(props.value ?? 1)})`,
  },
  color: {
    label: "Color", cat: "value", params: [{ key: "value", type: "color", default: "#ffffff" }], out: "color",
    build: ({ props, uni, id }) => uni(`${id}.value`, TSL.uniform(new THREE.Color(props.value ?? "#ffffff"))),
    gen: ({ props, use }) => `${use("uniform")}(${use("color", true)}('${props.value ?? "#ffffff"}'))`,
  },

  // --- attributes / coordinates ---
  uv: src("UV", "uv", "vec2"),
  vertexColor: src("Vertex Color", "vertexColor", "color"),
  positionLocal: src("Position (Local)", "positionLocal", "vec3"),
  positionWorld: src("Position (World)", "positionWorld", "vec3"),
  positionView: src("Position (View)", "positionView", "vec3"),
  viewDirection: src("View Direction", "positionViewDirection", "vec3"),
  normalLocal: src("Normal (Local)", "normalLocal", "vec3"),
  normalView: src("Normal (View)", "normalView", "vec3"),
  normalWorld: src("Normal (World)", "normalWorld", "vec3"),
  tangentWorld: src("Tangent (World)", "tangentWorld", "vec3"),
  bitangentWorld: src("Bitangent (World)", "bitangentWorld", "vec3"),
  cameraPosition: src("Camera Position", "cameraPosition", "vec3"),
  screenUV: src("Screen UV", "screenUV", "vec2"),
  viewportUV: src("Viewport UV", "viewportUV", "vec2"),
  matcapUV: src("Matcap UV", "matcapUV", "vec2"),
  frontFacing: src("Front Facing", "frontFacing", "float"),
  // Per-instance ID on an InstancedMesh (0..count-1) — NodeMaterial applies
  // the per-instance matrix to positionLocal automatically, so this is the
  // hook for per-instance *variation* (color, scale offsets, …) via e.g.
  // hash(instanceIndex). There's no native "instance count" TSL builtin
  // (it isn't a GPU attribute); drive that from a Float/Uniform node instead.
  instanceIndex: src("Instance Index", "instanceIndex", "float"),

  // --- time / oscillators ---
  time: { ...src("Time", "time", "float"), cat: "osc" },
  deltaTime: { ...src("Delta Time", "deltaTime", "float"), cat: "osc" },
  oscSine: { label: "Osc Sine", cat: "osc", fn: "oscSine", inputs: [i("t", "float", null, "time")], out: "float" },
  oscSquare: { label: "Osc Square", cat: "osc", fn: "oscSquare", inputs: [i("t", "float", null, "time")], out: "float" },
  oscTriangle: { label: "Osc Triangle", cat: "osc", fn: "oscTriangle", inputs: [i("t", "float", null, "time")], out: "float" },
  oscSawtooth: { label: "Osc Sawtooth", cat: "osc", fn: "oscSawtooth", inputs: [i("t", "float", null, "time")], out: "float" },

  // --- math: one input ---
  abs: fn1("Abs", "abs"), floor: fn1("Floor", "floor"), ceil: fn1("Ceil", "ceil"),
  round: fn1("Round", "round"), trunc: fn1("Trunc", "trunc"), fract: fn1("Fract", "fract"),
  sign: fn1("Sign", "sign"), sqrt: fn1("Sqrt", "sqrt"), inverseSqrt: fn1("Inverse Sqrt", "inverseSqrt"),
  cbrt: fn1("Cbrt", "cbrt"), exp: fn1("Exp", "exp"), exp2: fn1("Exp2", "exp2"),
  log: fn1("Log", "log"), log2: fn1("Log2", "log2"),
  sin: fn1("Sin", "sin"), cos: fn1("Cos", "cos"), tan: fn1("Tan", "tan"),
  asin: fn1("Asin", "asin"), acos: fn1("Acos", "acos"), atan: fn1("Atan", "atan"),
  degrees: fn1("Degrees", "degrees"), radians: fn1("Radians", "radians"),
  oneMinus: fn1("One Minus", "oneMinus"), negate: fn1("Negate", "negate"),
  reciprocal: fn1("Reciprocal", "reciprocal"), saturate: fn1("Saturate", "saturate"),
  pow2: fn1("Power 2", "pow2"), pow3: fn1("Power 3", "pow3"), pow4: fn1("Power 4", "pow4"),

  // --- math: multi input (old type names add/subtract/… kept) ---
  add: fn2("Add", "add"), subtract: fn2("Subtract", "sub"), multiply: fn2("Multiply", "mul", 1, 1),
  divide: fn2("Divide", "div", 1, 1), mod: fn2("Mod", "mod", 0, 1), pow: fn2("Power", "pow", 0, 2),
  min: fn2("Min", "min"), max: fn2("Max", "max"),
  atan2: { label: "Atan2", cat: "math", fn: "atan", inputs: [i("y", "float", 0), i("x", "float", 1)], out: "float" },
  lerp: { label: "Mix", cat: "math", fn: "mix", inputs: [i("a", "any"), i("b", "any"), i("t", "float", 0.5)], out: "any" },
  clamp: { label: "Clamp", cat: "math", fn: "clamp", inputs: [i("x", "any"), i("min", "float", 0), i("max", "float", 1)], out: "any" },
  step: { label: "Step", cat: "math", fn: "step", inputs: [i("edge", "float", 0.5), i("x", "any")], out: "any" },
  smoothstep: { label: "Smoothstep", cat: "math", fn: "smoothstep", inputs: [i("low", "float", 0), i("high", "float", 1), i("x", "any")], out: "any" },
  remap: { label: "Remap", cat: "math", fn: "remap", inputs: [i("x", "any"), i("inLow", "float", 0), i("inHigh", "float", 1), i("outLow", "float", 0), i("outHigh", "float", 1)], out: "any" },
  remapClamp: { label: "Remap (Clamp)", cat: "math", fn: "remapClamp", inputs: [i("x", "any"), i("inLow", "float", 0), i("inHigh", "float", 1), i("outLow", "float", 0), i("outHigh", "float", 1)], out: "any" },
  greaterThan: fn2("Greater Than", "greaterThan"), lessThan: fn2("Less Than", "lessThan"),
  select: { label: "Select", cat: "math", fn: "select", inputs: [i("cond", "any"), i("a", "any", 1), i("b", "any", 0)], out: "any" },

  // --- vector ---
  vec2: { label: "Vec2", cat: "vector", fn: "vec2", inputs: [i("x", "float", 0), i("y", "float", 0)], out: "vec2" },
  vec3: { label: "Vec3", cat: "vector", fn: "vec3", inputs: [i("x", "float", 0), i("y", "float", 0), i("z", "float", 0)], out: "vec3" },
  vec4: { label: "Vec4", cat: "vector", fn: "vec4", inputs: [i("x", "float", 0), i("y", "float", 0), i("z", "float", 0), i("w", "float", 1)], out: "vec4" },
  split: {
    label: "Split", cat: "vector", inputs: [i("v", "any")], outputs: ["x", "y", "z", "w"], out: "float",
    build: ({ ins, out }) => (ins.v ? ins.v[out] : null),
    gen: ({ args, out }) => `${args.v}.${out}`,
  },
  dot: fn2("Dot", "dot", null, null, "vector"),
  cross: fn2("Cross", "cross", null, null, "vector"),
  distance: fn2("Distance", "distance", null, null, "vector"),
  normalize: fn1("Normalize", "normalize", "vector", "vec3"),
  length: fn1("Length", "length", "vector"),
  reflect: { label: "Reflect", cat: "vector", fn: "reflect", inputs: [i("I", "vec3"), i("N", "vec3", null, "normalView")], out: "vec3" },
  refract: { label: "Refract", cat: "vector", fn: "refract", inputs: [i("I", "vec3"), i("N", "vec3", null, "normalView"), i("eta", "float", 0.66)], out: "vec3" },
  rotate: { label: "Rotate", cat: "vector", fn: "rotate", inputs: [i("v", "any"), i("angle", "float", 0)], out: "any" },
  rotateUV: { label: "Rotate UV", cat: "vector", fn: "rotateUV", inputs: [i("uv", "vec2", null, "uv"), i("angle", "float", 0), i("center", "vec2", [0.5, 0.5])], out: "vec2" },
  spherizeUV: { label: "Spherize UV", cat: "vector", fn: "spherizeUV", inputs: [i("uv", "vec2", null, "uv"), i("strength", "float", 1), i("center", "vec2", [0.5, 0.5])], out: "vec2" },

  // --- noise ---
  noise: { label: "Noise", cat: "noise", fn: "mx_noise_float", inputs: [i("pos", "any", null, "uv")], out: "float" },
  noiseVec3: { label: "Noise Vec3", cat: "noise", fn: "mx_noise_vec3", inputs: [i("pos", "any", null, "uv")], out: "vec3" },
  fractalNoise: { label: "Fractal Noise", cat: "noise", fn: "mx_fractal_noise_float", inputs: [i("pos", "any", null, "uv"), i("octaves", "float", 3), i("lacunarity", "float", 2), i("diminish", "float", 0.5)], out: "float" },
  fractalNoiseVec3: { label: "Fractal Noise Vec3", cat: "noise", fn: "mx_fractal_noise_vec3", inputs: [i("pos", "any", null, "uv"), i("octaves", "float", 3), i("lacunarity", "float", 2), i("diminish", "float", 0.5)], out: "vec3" },
  worley: { label: "Worley Noise", cat: "noise", fn: "mx_worley_noise_float", inputs: [i("pos", "any", null, "uv"), i("jitter", "float", 1)], out: "float" },
  worleyVec3: { label: "Worley Noise Vec3", cat: "noise", fn: "mx_worley_noise_vec3", inputs: [i("pos", "any", null, "uv"), i("jitter", "float", 1)], out: "vec3" },
  cellNoise: { label: "Cell Noise", cat: "noise", fn: "mx_cell_noise_float", inputs: [i("pos", "any", null, "uv")], out: "float" },
  triNoise3D: { label: "Tri Noise 3D", cat: "noise", fn: "triNoise3D", inputs: [i("pos", "vec3", null, "positionLocal"), i("speed", "float", 0.2), i("time", "float", null, "time")], out: "float" },
  hash: { label: "Hash", cat: "noise", fn: "hash", inputs: [i("seed", "float", 0)], out: "float" },
  rand: { label: "Random", cat: "noise", fn: "rand", inputs: [i("uv", "vec2", null, "uv")], out: "float" },

  // --- texture ---
  texture: {
    label: "Texture", cat: "texture", params: [{ key: "path", type: "asset" }],
    inputs: [i("uv", "vec2", null, "uv")], outputs: ["out", "r", "g", "b", "a"], out: "color",
    build: ({ ins, out, textures, id }) => {
      const tex = textures.get(id);
      if (!tex) return null;
      const t = TSL.texture(tex, ins.uv ?? undefined);
      return out === "out" ? t : t[out];
    },
    gen: ({ args, out, props, use, name }) =>
      `${use("texture")}(/* load "${props.path ?? ""}" */ ${name}_map${args.uv ? `, ${args.uv}` : ""})${out !== "out" ? `.${out}` : ""}`,
  },
  checker: { label: "Checker", cat: "texture", fn: "checker", inputs: [i("uv", "vec2", null, "uv")], out: "float" },
  normalMap: { label: "Normal Map", cat: "texture", fn: "normalMap", inputs: [i("color", "color"), i("scale", "float", 1)], out: "vec3" },

  // --- color ---
  hue: { label: "Hue", cat: "color", fn: "hue", inputs: [i("color", "color"), i("adjust", "float", 0)], out: "color" },
  saturation: { label: "Saturation", cat: "color", fn: "saturation", inputs: [i("color", "color"), i("amount", "float", 1)], out: "color" },
  vibrance: { label: "Vibrance", cat: "color", fn: "vibrance", inputs: [i("color", "color"), i("amount", "float", 1)], out: "color" },
  luminance: fn1("Luminance", "luminance", "color", "color"),
  grayscale: fn1("Grayscale", "grayscale", "color", "color"),
  posterize: { label: "Posterize", cat: "color", fn: "posterize", inputs: [i("color", "color"), i("steps", "float", 4)], out: "color" },
  blendOverlay: fn2("Blend Overlay", "blendOverlay", null, null, "color"),
  blendScreen: fn2("Blend Screen", "blendScreen", null, null, "color"),
  blendDodge: fn2("Blend Dodge", "blendDodge", null, null, "color"),
  blendBurn: fn2("Blend Burn", "blendBurn", null, null, "color"),
  hsvToRgb: fn1("HSV to RGB", "mx_hsvtorgb", "color", "color"),
  rgbToHsv: fn1("RGB to HSV", "mx_rgbtohsv", "color", "color"),

  // --- utility ---
  fresnel: {
    label: "Fresnel", cat: "utility", inputs: [i("power", "float", 3)], out: "float",
    build: ({ ins }) => TSL.pow(TSL.oneMinus(TSL.saturate(TSL.dot(TSL.normalView, TSL.positionViewDirection))), ins.power),
    gen: ({ args, use }) =>
      `${use("pow")}(${use("oneMinus")}(${use("saturate")}(${use("dot")}(${use("normalView", true)}, ${use("positionViewDirection", true)}))), ${args.power})`,
  },
  parabola: { label: "Parabola", cat: "utility", fn: "parabola", inputs: [i("x", "float"), i("k", "float", 1)], out: "float" },
  gain: { label: "Gain", cat: "utility", fn: "gain", inputs: [i("x", "float"), i("k", "float", 1)], out: "float" },
  pcurve: { label: "P-Curve", cat: "utility", fn: "pcurve", inputs: [i("x", "float"), i("a", "float", 0.5), i("b", "float", 0.5)], out: "float" },

  // --- advanced ---
  // Escape hatch: write a raw TSL JS expression using up to 4 wired inputs
  // (a/b/c/d) plus any `three/tsl` export in scope (mix, sin, uv, time, …).
  customFn: {
    label: "Custom Fn", cat: "advanced",
    inputs: [i("a", "any"), i("b", "any"), i("c", "any"), i("d", "any")],
    params: [{ key: "code", type: "code", default: "a" }],
    out: "any",
    build: ({ ins, props }) => runCustomCode(props.code, ins),
    gen: ({ args, props, use }) => {
      // Best-effort: pull any three/tsl export the snippet references into
      // the generated file's import list (may over/under-match; the user
      // owns cleanup of generated code).
      for (const word of (props.code ?? "").match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (!["a", "b", "c", "d"].includes(word) && typeof TSL[word] !== "undefined") use(word);
      }
      return `(() => { const a = ${args.a}, b = ${args.b}, c = ${args.c}, d = ${args.d}; return (${props.code || "null"}); })()`;
    },
  },

  // --- output ---
  output: {
    label: "Material Output", cat: "output",
    inputs: OUTPUT_SLOTS.map((s) => i(s.key, s.type)),
    outputs: [],
  },
};

export const CATEGORY_LABELS = {
  value: "Values", attribute: "Attributes", osc: "Time & Oscillators", math: "Math",
  vector: "Vector", noise: "Noise", texture: "Texture", color: "Color", utility: "Utility",
  advanced: "Advanced", output: "Output",
};

export function nodeDefaults(type) {
  const def = NODE_TYPES[type];
  const props = {};
  for (const p of def?.params ?? []) props[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
  return props;
}

function num(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e5) / 1e5);
}

/** Builtin TSL source by export name — callable exports are invoked, node
 *  objects (time, positionWorld, …) returned as-is. */
function builtin(name) {
  const v = TSL[name];
  return typeof v === "function" ? v() : v;
}

/** Uniform node for an unwired-but-valued input. Arrays → Vector2/3/4,
 *  hex strings → Color, numbers → float. */
function makeUniform(value) {
  if (typeof value === "number") return TSL.uniform(value);
  if (typeof value === "string") return TSL.uniform(new THREE.Color(value));
  if (Array.isArray(value)) {
    const V = [null, null, THREE.Vector2, THREE.Vector3, THREE.Vector4][value.length];
    if (V) return TSL.uniform(new V(...value));
  }
  return null;
}

/** Evaluates a Custom Fn node's code string with `a/b/c/d` bound to its wired
 *  inputs and every `three/tsl` export available by bare name (`with(TSL)`).
 *  `new Function` bodies run as non-strict sloppy-mode code even from an ES
 *  module, so `with` is legal here. Same trust model as ScriptComponent's
 *  dynamic script loading — this is local editor/game code, not untrusted
 *  network input. */
function runCustomCode(code, ins) {
  if (!code) return null;
  const { a = null, b = null, c = null, d = null } = ins;
  const fn = new Function("TSL", "a", "b", "c", "d", `with (TSL) { return (${code}); }`);
  return fn(TSL, a, b, c, d);
}

export function setUniformValue(uniformNode, value) {
  const cur = uniformNode.value;
  if (typeof cur === "number") uniformNode.value = value;
  else if (cur?.isColor) cur.set(value);
  else if (cur?.set && Array.isArray(value)) cur.set(...value);
}

export async function compileShaderGraph(graph, { taps } = {}) {
  if (!graph?.nodes?.length) return null;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges ?? [];

  // Async prep: load all referenced textures before the (sync) build pass.
  const textures = new Map();
  await Promise.all(
    graph.nodes
      .filter((n) => n.type === "texture" && n.props?.path)
      .map((n) =>
        loadTexture(n.props.path)
          .then((tex) => textures.set(n.id, tex))
          .catch((err) => console.error(`Shader texture "${n.props.path}": ${err.message}`)),
      ),
  );

  const uniforms = {};
  const uni = (key, node) => ((uniforms[key] = node), node);
  const cache = new Map();

  function inputNode(node, spec) {
    const edge = edges.find((e) => e.target === node.id && e.targetHandle === spec.key);
    if (edge) return build(edge.source, edge.sourceHandle);
    const value = node.props?.[spec.key] ?? spec.default;
    if (value != null) {
      const u = makeUniform(value);
      if (u) return uni(`${node.id}.${spec.key}`, u);
    }
    return spec.src ? builtin(spec.src) : null;
  }

  function build(id, outKey) {
    const node = nodeById.get(id);
    const def = node && NODE_TYPES[node.type];
    if (!def) return null;
    const out = def.outputs?.length ? (def.outputs.includes(outKey) ? outKey : def.outputs[0]) : "out";
    const memoKey = `${id}|${out}`;
    if (cache.has(memoKey)) return cache.get(memoKey);
    let result = null;
    try {
      const ins = {};
      for (const spec of def.inputs ?? []) ins[spec.key] = inputNode(node, spec);
      if (def.build) {
        result = def.build({ ins, out, props: node.props ?? {}, id, uni, textures });
      } else if (def.fn && !def.inputs?.length) {
        // Attribute-source node (uv, time, positionWorld, …) — may be a
        // callable TSL builder or a plain pre-built Node object.
        result = builtin(def.fn);
      } else if (def.fn) {
        const args = def.inputs.map((s) => ins[s.key]);
        while (args.length && args[args.length - 1] == null) args.pop();
        if (!args.includes(null)) result = TSL[def.fn](...args);
      }
    } catch (err) {
      console.error(`Shader node ${node.type} (${id}): ${err.message}`);
    }
    cache.set(memoKey, result);
    return result;
  }

  const mutations = {};
  const outputNode = graph.nodes.find((n) => n.type === "output");
  if (outputNode) {
    for (const slot of OUTPUT_SLOTS) {
      const edge = edges.find((e) => e.target === outputNode.id && e.targetHandle === slot.key);
      if (!edge) continue;
      const node = build(edge.source, edge.sourceHandle);
      if (node != null) mutations[slot.slot] = node;
    }
  }

  const tapNodes = {};
  if (taps) for (const id of taps) tapNodes[id] = build(id, null);

  return { mutations, uniforms, taps: tapNodes };
}

// --- Migration ------------------------------------------------------------
// v0 graphs (single Output with a `color` handle) work natively: the new
// Output has a `color` port and the old value/math node type names are kept.
// v1 graphs (Blender-style BSDF nodes wired into output.surface) migrate here.

const BSDF_TYPES = new Set(["principledBsdf", "glassBsdf", "diffuseBsdf", "emission"]);
// principled input handle -> output slot key
const PRINCIPLED_MAP = {
  baseColor: "color", roughness: "roughness", metalness: "metalness", ior: "ior",
  specular: "specularIntensity", anisotropic: "anisotropy", sheen: "sheen",
  sheenRoughness: "sheenRoughness", clearcoat: "clearcoat", clearcoatRoughness: "clearcoatRoughness",
  transmission: "transmission", transmissionRoughness: "thickness", alpha: "opacity",
};

export function migrateGraph(graph) {
  if (!graph?.nodes?.some((n) => BSDF_TYPES.has(n.type))) return graph;

  const output = graph.nodes.find((n) => n.type === "output") ?? { id: "output", type: "output", props: {}, position: { x: 600, y: 200 } };
  const edges = graph.edges ?? [];
  const bsdfs = graph.nodes.filter((n) => BSDF_TYPES.has(n.type));
  // The BSDF actually wired to the output wins; else the first one.
  const active =
    bsdfs.find((b) => edges.some((e) => e.source === b.id && e.target === output.id)) ?? bsdfs[0];

  const nodes = graph.nodes.filter((n) => !BSDF_TYPES.has(n.type) && n.type !== "output");
  const newEdges = edges.filter(
    (e) => !BSDF_TYPES.has(nodeType(graph, e.source)) && !BSDF_TYPES.has(nodeType(graph, e.target)) && e.target !== output.id,
  );
  nodes.push({ ...output });

  const base = active.position ?? { x: 300, y: 200 };
  let seedY = base.y;
  const wire = (sourceId, sourceHandle, slotKey) =>
    newEdges.push({ source: sourceId, sourceHandle, target: output.id, targetHandle: slotKey });
  const seed = (type, value, slotKey) => {
    const id = `mig-${slotKey}`;
    nodes.push({ id, type, props: { value }, position: { x: base.x, y: (seedY += 70) } });
    wire(id, "out", slotKey);
  };

  const p = active.props ?? {};
  if (active.type === "emission") {
    // emissive = color × strength
    const colId = "mig-emissive-c";
    nodes.push({ id: colId, type: "color", props: { value: p.color ?? "#ffffff" }, position: { x: base.x - 200, y: base.y } });
    if ((p.emissionStrength ?? 1) !== 1) {
      const fId = "mig-emissive-s";
      const mId = "mig-emissive-m";
      nodes.push({ id: fId, type: "float", props: { value: p.emissionStrength }, position: { x: base.x - 200, y: base.y + 70 } });
      nodes.push({ id: mId, type: "multiply", props: {}, position: { x: base.x, y: base.y } });
      newEdges.push({ source: colId, sourceHandle: "out", target: mId, targetHandle: "a" });
      newEdges.push({ source: fId, sourceHandle: "out", target: mId, targetHandle: "b" });
      wire(mId, "out", "emissive");
    } else wire(colId, "out", "emissive");
    // keep any wire that fed emission.color
    for (const e of edges) {
      if (e.target === active.id && e.targetHandle === "color") wire(e.source, e.sourceHandle, "emissive");
    }
  } else {
    const map =
      active.type === "principledBsdf"
        ? PRINCIPLED_MAP
        : { color: "color", roughness: "roughness", ior: "ior" }; // glass/diffuse share these
    // Wired BSDF inputs → output slots.
    const wired = new Set();
    for (const e of edges) {
      if (e.target !== active.id) continue;
      const slotKey = map[e.targetHandle];
      if (!slotKey) continue;
      wire(e.source, e.sourceHandle, slotKey);
      wired.add(slotKey);
    }
    // Scalar/color props → seeded value nodes (only where meaningful).
    const seedProp = (propKey, slotKey, neutral) => {
      const v = p[propKey];
      if (wired.has(slotKey) || v == null || v === neutral) return;
      seed(typeof v === "string" ? "color" : "float", v, slotKey);
    };
    seedProp("baseColor", "color", null);
    seedProp("color", "color", null);
    seedProp("roughness", "roughness", null);
    seedProp("metalness", "metalness", 0);
    seedProp("ior", "ior", 1.5);
    seedProp("specular", "specularIntensity", 0.5);
    seedProp("clearcoat", "clearcoat", 0);
    seedProp("clearcoatRoughness", "clearcoatRoughness", 0.03);
    seedProp("transmission", "transmission", 0);
    seedProp("sheen", "sheen", 0);
    seedProp("alpha", "opacity", 1);
    if (active.type === "glassBsdf") seed("float", 1, "transmission");
    if (active.type === "diffuseBsdf") p.metalness = 0;
    // Principled emission prop
    if (p.emission && p.emission !== "#000000" && !wired.has("emissive")) seed("color", p.emission, "emissive");
  }

  return { nodes, edges: newEdges };
}

function nodeType(graph, id) {
  return graph.nodes.find((n) => n.id === id)?.type ?? "";
}

// --- Code generation --------------------------------------------------------

/** Emits readable three/tsl JavaScript for the graph. */
export function generateTslCode(graph) {
  if (!graph?.nodes?.length) return "// empty graph";
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges ?? [];
  const imports = new Set();
  const lines = [];
  const names = new Map(); // `${id}|${out}` -> var name
  const counts = {};

  const use = (name, threeImport = false) => {
    imports.add(threeImport && name === "color" ? "color" : name);
    return name;
  };

  function emit(id, outKey) {
    const node = nodeById.get(id);
    const def = node && NODE_TYPES[node.type];
    if (!def) return "null";
    const out = def.outputs?.length ? (def.outputs.includes(outKey) ? outKey : def.outputs[0]) : "out";
    const memoKey = `${id}|${out}`;
    if (names.has(memoKey)) return names.get(memoKey);

    const args = {};
    for (const spec of def.inputs ?? []) {
      const edge = edges.find((e) => e.target === id && e.targetHandle === spec.key);
      if (edge) args[spec.key] = emit(edge.source, edge.sourceHandle);
      else {
        const value = node.props?.[spec.key] ?? spec.default;
        if (value != null) {
          args[spec.key] =
            typeof value === "string"
              ? `${use("color")}('${value}')`
              : Array.isArray(value)
                ? `${use(`vec${value.length}`)}(${value.map(num).join(", ")})`
                : num(value);
        } else if (spec.src) {
          const v = TSL[spec.src];
          args[spec.key] = typeof v === "function" ? `${use(spec.src)}()` : use(spec.src);
        } else args[spec.key] = null;
      }
    }

    const name = `${node.type}${(counts[node.type] = (counts[node.type] ?? 0) + 1)}`;
    let expr;
    if (def.gen) {
      expr = def.gen({ args, out, props: node.props ?? {}, use, name });
      if (node.type === "texture") lines.push(`const ${name}_map = new THREE.Texture(); // TODO load "${node.props?.path ?? ""}"`);
    } else if (def.fn && !def.inputs?.length) {
      // Attribute-source node — only append call parens if it's actually callable.
      expr = typeof TSL[def.fn] === "function" ? `${use(def.fn)}()` : use(def.fn);
    } else if (def.fn) {
      const list = def.inputs.map((s) => args[s.key]);
      while (list.length && list[list.length - 1] == null) list.pop();
      expr = `${use(def.fn)}(${list.join(", ")})`;
    } else expr = "null";
    lines.push(`const ${name} = ${expr};`);
    names.set(memoKey, name);
    return name;
  }

  const assignments = [];
  const output = graph.nodes.find((n) => n.type === "output");
  if (output) {
    for (const slot of OUTPUT_SLOTS) {
      const edge = edges.find((e) => e.target === output.id && e.targetHandle === slot.key);
      if (edge) assignments.push(`material.${slot.slot} = ${emit(edge.source, edge.sourceHandle)};`);
    }
  }
  if (!assignments.length) return "// nothing wired to the Material Output";

  return [
    `import { ${[...imports].sort().join(", ")} } from 'three/tsl';`,
    "",
    "// const material = new THREE.MeshPhysicalNodeMaterial();",
    ...lines,
    "",
    ...assignments,
  ].join("\n");
}
