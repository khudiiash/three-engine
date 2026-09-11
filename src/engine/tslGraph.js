import { vmState } from "./vmState.js";
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { loadTextureAsset } from "./textureAsset.js";
import { freeze } from "./freezeLedger.js";

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

const textureCache = vmState("tslGraphTextures", () => new Map()); // path -> Promise<THREE.Texture>
const textureKey = (path) => String(path ?? "").replaceAll("\\", "/");

function loadTexture(path) {
  const key = textureKey(path);
  let cached = textureCache.get(key);
  if (!cached) {
    cached = loadTextureAsset(path, { colorSpace: THREE.SRGBColorSpace });
    textureCache.set(key, cached);
    // A rejected load must be retryable after the asset is repaired or its
    // compression setting changes. Pending loads are bounded by
    // textureAsset's Basis timeout.
    cached.catch(() => {
      if (textureCache.get(key) === cached) textureCache.delete(key);
    });
  }
  return cached;
}

/** Drops cached shader textures so material refreshes cannot reuse a stale or
 * previously stalled Promise. With no path, clears every graph texture. */
export function invalidateShaderTextureCache(path = null) {
  if (path == null) textureCache.clear();
  else textureCache.delete(textureKey(path));
}

/** Input port spec. `def` null = wire-only; number/hex/array = inline-editable
 *  default (compiled to a uniform when unwired); `src` = fallback TSL builtin
 *  (e.g. "uv", "time") used when unwired and no value set. */
const i = (key, type, def = null, src = null, extra = null) => ({ key, type, default: def, src, ...extra });

/**
 * ── The Material Output IS the three.js material ────────────────────────────
 *
 * One socket per `*Node` slot the selected material class actually reads, so a
 * graph reads the way TSL reads when written by hand:
 *
 *     material.colorNode      ←  Output ▸ Color
 *     material.roughnessNode  ←  Output ▸ Roughness
 *     material.clearcoatNode  ←  Output ▸ Clearcoat
 *
 * There is no BSDF middleman and no `surface` bundle. The old Blender-shaped
 * graphs (`Principled BSDF → Output.surface`) are rewritten into direct wires
 * by `migrateGraph` on load, so every .mat already on disk renders identically.
 */

/** Material classes the Output can instantiate, keyed by the `material` param.
 *  `ctor` is the `three/webgpu` export name, used by the code generator; the
 *  real constructors live in `MATERIAL_CTORS` in materialAsset.js. */
export const MATERIAL_CLASSES = {
  physical: { label: "Physical", ctor: "MeshPhysicalNodeMaterial" },
  standard: { label: "Standard", ctor: "MeshStandardNodeMaterial" },
  basic: { label: "Basic", ctor: "MeshBasicNodeMaterial" },
  lambert: { label: "Lambert", ctor: "MeshLambertNodeMaterial" },
  phong: { label: "Phong", ctor: "MeshPhongNodeMaterial" },
  toon: { label: "Toon", ctor: "MeshToonNodeMaterial" },
  matcap: { label: "Matcap", ctor: "MeshMatcapNodeMaterial" },
  normal: { label: "Normal", ctor: "MeshNormalNodeMaterial" },
  sprite: { label: "Sprite", ctor: "SpriteNodeMaterial" },
  points: { label: "Points", ctor: "PointsNodeMaterial" },
  volume: { label: "Volume", ctor: "VolumeNodeMaterial" },
};

export const DEFAULT_MATERIAL_CLASS = "physical";

/** The material class a graph asks for, from either graph shape.
 *
 *  Pre-`material` graphs selected the class by WIRING — anything in the Output
 *  Volume socket meant a VolumeNodeMaterial — so that is read here as well.
 *  Answering identically before and after `migrateGraph` is what lets the
 *  asset layer decide the class without first having to migrate. */
export function materialClassOf(graph) {
  const output = graph?.nodes?.find((n) => n.type === "output");
  if (!output) return DEFAULT_MATERIAL_CLASS;
  const key = output.props?.material;
  if (key && MATERIAL_CLASSES[key]) return key;
  const volumeWired = (graph.edges ?? []).some(
    (e) => e.target === output.id && e.targetHandle === "volume",
  );
  return volumeWired ? "volume" : DEFAULT_MATERIAL_CLASS;
}

// Which classes read which slot. Taken from three's own class hierarchy:
// NodeMaterial declares the base slots, MeshStandardNodeMaterial adds
// emissive/roughness/metalness, MeshPhysicalNodeMaterial adds the rest.
const MESH = ["physical", "standard", "basic", "lambert", "phong", "toon", "matcap", "normal"];
const EVERY = [...MESH, "sprite", "points"];
const STD = ["physical", "standard"];
const PHYS = ["physical"];

/** One Material Output socket.
 *
 *  ⚠ A `null` default means WIRE-ONLY, and that is load-bearing, not tidiness:
 *  three's `useClearcoat` / `useTransmission` / `useIridescence` / `useSheen` /
 *  `useAnisotropy` getters switch their expensive lighting path ON the instant
 *  the node is non-null — *even when it evaluates to 0* — so a channel nobody
 *  wired must stay null or every material in the scene pays for it. Only the
 *  channels a plain PBR surface already pays for carry an inline default. */
const s = (key, slot, type, sect, def = null, on = EVERY) => ({ key, slot, type, sect, default: def, on });

export const OUTPUT_SLOT_SPECS = [
  // --- Surface ---
  s("color", "colorNode", "color", "Surface", "#ffffff"),
  s("opacity", "opacityNode", "float", "Surface", 1),
  s("emissive", "emissiveNode", "color", "Surface", "#000000", MESH),
  s("alphaTest", "alphaTestNode", "float", "Surface"),

  // --- PBR ---
  s("roughness", "roughnessNode", "float", "PBR", 0.5, STD),
  s("metalness", "metalnessNode", "float", "PBR", 0, STD),
  s("ao", "aoNode", "float", "PBR", 1, MESH),
  s("ior", "iorNode", "float", "PBR", 1.5, PHYS),
  s("specularIntensity", "specularIntensityNode", "float", "PBR", 0.5, PHYS),
  s("specularColor", "specularColorNode", "color", "PBR", "#ffffff", PHYS),
  s("anisotropy", "anisotropyNode", "vec2", "PBR", null, PHYS),

  // --- Phong ---
  s("shininess", "shininessNode", "float", "Phong", 30, ["phong"]),
  s("specular", "specularNode", "color", "Phong", "#111111", ["phong"]),

  // --- Clearcoat ---
  s("clearcoat", "clearcoatNode", "float", "Clearcoat", null, PHYS),
  s("clearcoatRoughness", "clearcoatRoughnessNode", "float", "Clearcoat", null, PHYS),
  s("clearcoatNormal", "clearcoatNormalNode", "vec3", "Clearcoat", null, PHYS),

  // --- Sheen ---
  s("sheen", "sheenNode", "color", "Sheen", null, PHYS),
  s("sheenRoughness", "sheenRoughnessNode", "float", "Sheen", null, PHYS),

  // --- Iridescence ---
  s("iridescence", "iridescenceNode", "float", "Iridescence", null, PHYS),
  s("iridescenceIOR", "iridescenceIORNode", "float", "Iridescence", null, PHYS),
  s("iridescenceThickness", "iridescenceThicknessNode", "float", "Iridescence", null, PHYS),

  // --- Transmission ---
  s("transmission", "transmissionNode", "float", "Transmission", null, PHYS),
  s("thickness", "thicknessNode", "float", "Transmission", null, PHYS),
  s("attenuationDistance", "attenuationDistanceNode", "float", "Transmission", null, PHYS),
  s("attenuationColor", "attenuationColorNode", "color", "Transmission", null, PHYS),
  s("dispersion", "dispersionNode", "float", "Transmission", null, PHYS),

  // --- Geometry ---
  // `position` is three's `positionNode` — the vertex position itself, which
  // is what displacement is in TSL (offset `positionLocal` and wire it here).
  s("normal", "normalNode", "vec3", "Geometry", null, MESH),
  s("position", "positionNode", "vec3", "Geometry"),

  // --- Sprite / Points ---
  s("rotation", "rotationNode", "float", "Sprite", null, ["sprite"]),
  s("scale", "scaleNode", "vec2", "Sprite", null, ["sprite"]),
  s("size", "sizeNode", "float", "Points", null, ["points"]),

  // --- Advanced ---
  // `mask` discards the fragment, `backdrop*` composites behind the lit
  // colour, `env` replaces the environment lookup. All wire-only: each one
  // changes how the whole surface resolves, never a channel of it.
  s("env", "envNode", "color", "Advanced", null, MESH),
  s("backdrop", "backdropNode", "color", "Advanced", null, MESH),
  s("backdropAlpha", "backdropAlphaNode", "float", "Advanced", null, MESH),
  s("mask", "maskNode", "float", "Advanced"),

  // --- Volume ---
  // Not a `*Node` slot: the Volume nodes compile to a raymarch bundle the
  // material-asset layer feeds to VolumeNodeMaterial's lighting model.
  { key: "volume", slot: null, type: "volume", sect: "Volume", default: null, on: ["volume"] },
];

/** The sockets one material class exposes, in table order. */
export function outputSlotsFor(materialClass = DEFAULT_MATERIAL_CLASS) {
  const cls = MATERIAL_CLASSES[materialClass] ? materialClass : DEFAULT_MATERIAL_CLASS;
  return OUTPUT_SLOT_SPECS.filter((spec) => spec.on.includes(cls));
}

/** Every material `*Node` slot a compiled graph may populate. Callers reset
 *  these to null before applying a fresh compile so a slot the user just
 *  unwired never leaks across the edit. */
export const MATERIAL_NODE_SLOTS = OUTPUT_SLOT_SPECS.map((spec) => spec.slot).filter(Boolean);

const VOLUME_STEPS_DEFAULT = 32;

/** The current raymarch sample position in the mesh's local box space, shared
 *  so that nodes wired into a volume (Noise, math on Position, …) vary THROUGH
 *  the volume rather than across its surface. `volumeBundle` assigns it every
 *  march step (inside the lighting model's Loop, before density/emission are
 *  read); `Position (Local)` / `Position (World)` resolve to it when compiling
 *  a volume graph. Module-level + assigned-in-loop mirrors how three's own
 *  VolumetricLightingModel drives `scatteringDensity`. */
const volumeRayLocal = TSL.property("vec3");

/** World-space form of the current volume sample (local ray pos → world). */
const volumeRayWorld = () => TSL.modelWorldMatrix.mul(TSL.vec4(volumeRayLocal, 1)).xyz;

/** Volume nodes compile to a `__volume` bundle consumed by the material-asset
 *  layer, which drives a `THREE.VolumeNodeMaterial` + its built-in
 *  `VolumetricLightingModel`. That model raymarches the bounds, iterates every
 *  scene light (with shadow maps → light shafts), applies Beer's-law
 *  transmittance, and — given `material.depthNode` (a scene depth prepass) —
 *  clips scattering behind opaque geometry for correct depth occlusion.
 *
 *  The model hands the callbacks a *world-space* sample `positionRay`, so we
 *  transform back into the mesh's local unit box for the density field and mask
 *  everything outside `[-0.5, 0.5]³` to 0 — that's what keeps the effect bounded
 *  to the box instead of filling all of world space.
 *
 *   - `scattering(worldPos) -> vec3`  density × albedo tint (modulates the light
 *     the model accumulates at this sample; also drives the transmittance).
 *   - `emissive(worldPos)  -> vec3`   self-emitted light (fire/blackbody), added
 *     independently of scene lights, or `null`.
 *   - `steps`                          raymarch step count for this material. */
function volumeBundle({ density, albedo, emission, steps }) {
  const local = (worldPos) => TSL.modelWorldMatrixInverse.mul(TSL.vec4(worldPos, 1)).xyz;
  // 1 inside the unit box, 0 outside (per-axis half-extent test, multiplied).
  const boxMask = (l) => {
    const a = l.abs();
    return TSL.step(a.x, 0.5).mul(TSL.step(a.y, 0.5)).mul(TSL.step(a.z, 0.5));
  };
  return {
    __volume: {
      steps: Math.max(1, Math.round(steps ?? VOLUME_STEPS_DEFAULT)),
      scattering: (worldPos) => {
        // Publish this sample so wired Position/Noise nodes evaluate here. The
        // model calls us inside its march Loop, so the assign is emitted in
        // order, before the density expression below reads it.
        const l = local(worldPos);
        volumeRayLocal.assign(l);
        const d = density(l).mul(boxMask(l));
        return albedo ? albedo.mul(d) : d;
      },
      emissive: emission
        ? (worldPos) => {
            const l = local(worldPos);
            volumeRayLocal.assign(l);
            return emission.mul(density(l)).mul(boxMask(l));
          }
        : null,
    },
  };
}

/** A soft 0..1 cloud field in the mesh's local box, so a plain volume reads as
 *  fuzzy rather than a solid cube. `positionLocal` is local ([-0.5,0.5]). */
function cloudDensity(positionLocal) {
  return TSL.mx_fractal_noise_float(positionLocal.mul(3), 3, 2, 0.5).mul(0.5).add(0.5);
}

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
    // `exts` is not optional on an asset param: AssetField coerces a missing
    // list to `[]`, which matches nothing — the browse popover comes back
    // empty and drag-and-drop rejects every file.
    label: "Texture", cat: "texture",
    params: [{ key: "path", label: "Texture", type: "asset", exts: ["png", "jpg", "jpeg", "webp"], default: "" }],
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
  waterColor: {
    label: "Water Color", cat: "color", out: "color",
    inputs: [i("shallow", "color", "#64cbd0"), i("deep", "color", "#075779"), i("opticalDepth", "float", 1.2), i("absorption", "float", .45), i("foamHeight", "float", .07), i("foamAmount", "float", .35)],
    build: ({ ins }) => {
      const noise = TSL.mx_noise_float(TSL.positionLocal.mul(24)).mul(.5).add(.5).clamp(0, 1);
      const angle = TSL.normalView.dot(TSL.positionViewDirection).abs().max(.35);
      const depth = TSL.float(1).sub(ins.opticalDepth.max(0).mul(ins.absorption.max(0)).div(angle).negate().exp()).add(noise.sub(.5).mul(.12)).clamp(0, 1);
      const foam = TSL.smoothstep(ins.foamHeight, ins.foamHeight.add(.08), TSL.positionLocal.y).mul(ins.foamAmount.clamp(0, 1)).mul(TSL.smoothstep(.1, .7, noise));
      return TSL.mix(TSL.mix(ins.shallow, ins.deep, depth), TSL.vec3(.82, .96, .93), foam);
    },
    gen: ({ args, use }) => {
      const noise = `${use("mx_noise_float")}(${use("positionLocal", true)}.mul(24)).mul(.5).add(.5).clamp(0,1)`;
      const angle = `${use("normalView", true)}.dot(${use("positionViewDirection", true)}).abs().max(.35)`;
      const depth = `${use("float")}(1).sub(${use("float")}(${args.opticalDepth}).max(0).mul(${use("float")}(${args.absorption}).max(0)).div(${angle}).negate().exp()).add((${noise}).sub(.5).mul(.12)).clamp(0,1)`;
      const foam = `${use("smoothstep")}(${args.foamHeight},${use("float")}(${args.foamHeight}).add(.08),${use("positionLocal", true)}.y).mul(${use("float")}(${args.foamAmount}).clamp(0,1)).mul(${use("smoothstep")}(.1,.7,${noise}))`;
      return `${use("mix")}(${use("mix")}(${args.shallow},${args.deep},${depth}),${use("vec3")}(.82,.96,.93),${foam})`;
    },
  },
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

  // --- volume ---
  // Volume nodes wire into Material Output's Volume socket, compiling to
  // `scatteringNode` + `scatteringEmissiveNode` callbacks for
  // `VolumeNodeMaterial`. The material's built-in `VolumetricLightingModel`
  // marches the bounds, iterates every scene light (including shadow maps), and
  // composites the result with proper transmittance. `MeshComponent` snaps the
  // geometry to `BoxGeometry(1,1,1)` for correct march bounds.
  volumeScatter: {
    label: "Volume Scatter",
    cat: "volume",
    inputs: [
      i("color", "color", "#ffffff"),
      i("density", "float", 1),
      i("anisotropy", "float", 0),
    ],
    params: [{ key: "steps", type: "number", default: 32, min: 1, step: 1 }],
    out: "volume",
    build: ({ ins, props }) => {
      const colorNode = ins.color ?? TSL.uniform(new THREE.Color("#ffffff"));
      const densityNode = ins.density ?? TSL.float(1);
      return volumeBundle({
        density: (p) => densityNode.mul(cloudDensity(p)),
        albedo: colorNode,
        emission: null,
        steps: props.steps,
      });
    },
  },
  volumeAbsorption: {
    label: "Volume Absorption",
    cat: "volume",
    inputs: [
      i("color", "color", "#000000"),
      i("density", "float", 1),
    ],
    params: [{ key: "steps", type: "number", default: 32, min: 1, step: 1 }],
    out: "volume",
    build: ({ ins, props }) => {
      const densityNode = ins.density ?? TSL.float(1);
      return volumeBundle({
        density: (p) => densityNode.mul(cloudDensity(p)),
        albedo: null,
        emission: null,
        steps: props.steps,
      });
    },
  },
  principledVolume: {
    label: "Principled Volume",
    cat: "volume",
    inputs: [
      i("color", "color", "#ffffff"),
      i("colorAttribute", "any"),
      i("density", "float", 1),
      i("anisotropy", "float", 0),
      i("emissionColor", "color", "#000000"),
      i("emissionStrength", "float", 0),
      i("blackbodyIntensity", "float", 0),
      i("blackbodyTint", "color", "#ffffff"),
      i("temperature", "any"),
    ],
    params: [{ key: "steps", type: "number", default: 48, min: 1, step: 1 }],
    out: "volume",
    build: ({ ins, props }) => {
      const scatterColor = ins.color ?? TSL.uniform(new THREE.Color("#ffffff"));
      const colorAttr = ins.colorAttribute;
      const densityNode = ins.density ?? TSL.float(1);
      const emissionC = ins.emissionColor ?? TSL.uniform(new THREE.Color("#000000"));
      const emissionS = ins.emissionStrength ?? TSL.float(0);
      const bbIntensity = ins.blackbodyIntensity ?? TSL.float(0);
      const bbTint = ins.blackbodyTint ?? TSL.uniform(new THREE.Color("#ffffff"));
      const emit = emissionC.mul(emissionS).add(bbTint.mul(bbIntensity));

      return volumeBundle({
        density: (p) => densityNode.mul(colorAttr ? TSL.float(colorAttr) : cloudDensity(p)),
        albedo: scatterColor,
        emission: emit,
        steps: props.steps,
      });
    },
  },

  // --- output ---
  // The material itself. `material` picks the three.js node-material class and
  // the socket list follows from it (`outputSlotsFor`) — a Physical output
  // shows clearcoat/sheen/iridescence/transmission, a Points output shows
  // Size, a Volume output shows only the Volume bundle pin.
  //
  // The registry keeps the FULL socket union in `inputs` so a wire is never
  // dropped by a class the user is only passing through; the panel and the
  // compiler both narrow it with `outputSlotsFor(materialClassOf(graph))`.
  output: {
    label: "Material Output", cat: "output",
    params: [{
      key: "material",
      label: "Material",
      type: "select",
      default: DEFAULT_MATERIAL_CLASS,
      options: Object.entries(MATERIAL_CLASSES).map(([value, c]) => ({ value, label: c.label })),
    }],
    inputs: OUTPUT_SLOT_SPECS.map((spec) => i(spec.key, spec.type, spec.default, null, { sect: spec.sect })),
    outputs: [],
  },
};

export const CATEGORY_LABELS = {
  value: "Values", attribute: "Attributes", osc: "Time & Oscillators", math: "Math",
  vector: "Vector", noise: "Noise", texture: "Texture", color: "Color", utility: "Utility",
  volume: "Volume", advanced: "Advanced", output: "Output",
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
 *  objects (time, positionWorld, …) returned as-is. In a volume graph the
 *  position sources resolve to the raymarch sample (see `volumeRayLocal`) so
 *  Position-driven nodes (Noise, …) vary through the volume, not its surface. */
function builtin(name, volumeMode = false) {
  if (volumeMode) {
    if (name === "positionLocal") return volumeRayLocal;
    if (name === "positionWorld") return volumeRayWorld();
  }
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

/** Shared graph-texture loader, exported so the stock-PBR path in
 *  materialAsset loads the SAME cached instance (same SRGB default, same .meta
 *  override, same Basis handling) a graph compile would — pixel parity between
 *  the two paths is what makes the stock expression an invisible swap. */
export const loadShaderTexture = loadTexture;

/**
 * Recognizes the canonical imported-PBR graph — the shape every GLB import
 * produces — and returns its stock-material expression, or null.
 *
 * WHY (§13.15): compileShaderGraph mints fresh uniform/texture nodes per
 * material, and three r185 keys programs on node IDENTITY
 * (`Node.customCacheKey() → this.id`), so 26 structurally identical imported
 * materials compile 26 programs: the whole material wave is N× main-thread
 * codegen for ONE program's worth of structure (WGSL proven identical modulo
 * node-id naming and emission order). Materials expressed through PLAIN
 * properties instead share three's stock program cache key (type + property
 * walk — no node ids), so every material this matcher accepts costs zero
 * extra codegens after the first of its feature set.
 *
 * Deliberately conservative: exactly one Principled BSDF into Output.surface,
 * textures only as `texture.out → color` and `texture.out → normalMap → normal`
 * with default UVs, everything else constant. Any other wire, swizzle, prop on
 * a wire-only channel, non-opaque opacity, constant AO ≠ 1, or non-black
 * emissive keeps the graph on the compile path unchanged. (Texture-fed
 * emissive must NEVER be stock-expressed: GI's resolveMaterialSurface guards
 * area-light wash via `emissiveNode`'s texture, and `material.emissiveMap`
 * would bypass that guard.)
 */
export function matchStockPbr(graph) {
  // A/B hatch (R12): boot with __noStockPbr = true to force every graph onto
  // the compile path — one flag isolates this optimization in any comparison.
  if (globalThis.__noStockPbr) return null;
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  if (!nodes.length) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // `color` + `multiply` are here for THE BASE-COLOUR FACTOR — see the branch
  // in the edge loop below for why admitting them matters far more than it
  // looks, and why it is exact rather than an approximation.
  const counts = { texture: 0, normalMap: 0, output: 0, color: 0, multiply: 0 };
  for (const n of nodes) {
    if (!(n.type in counts)) return null;
    counts[n.type]++;
  }
  if (counts.output !== 1 || counts.normalMap > 1) return null;
  if (counts.multiply > 1 || counts.color > 1) return null;
  // Only a Physical output is a stock PBR material. Every other class has its
  // own property set and would need its own expression.
  if (materialClassOf(graph) !== DEFAULT_MATERIAL_CLASS) return null;
  const output = nodes.find((n) => n.type === "output");
  const nm = nodes.find((n) => n.type === "normalMap") ?? null;
  const mul = nodes.find((n) => n.type === "multiply") ?? null;
  const colorConst = nodes.find((n) => n.type === "color") ?? null;
  // Neither is expressible alone: a constant colour reaches `material.color`
  // ONLY as the multiply's other operand, and the multiply is expressible ONLY
  // as `map x color`. One without the other is a graph this cannot spell.
  if ((mul === null) !== (colorConst === null)) return null;

  // Classify every edge; anything unrecognized disqualifies the graph.
  let colorTex = null;
  let normalFeed = null; // texture node feeding the normalMap node
  let normalWired = false;
  let roughnessTex = null; // texture node whose .g feeds roughness
  let metalnessTex = null; // texture node whose .b feeds metalness
  let alphaTex = null; // texture node whose .a feeds opacity
  let mulTex = null; // colour texture feeding the multiply
  let mulColorWired = false; // the constant colour feeding the multiply
  let mulToColor = false; // multiply -> output.color
  const texUses = new Map(); // texture node -> use count
  for (const e of edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) return null;
    // The canonical glTF ORM/ARM packing — one texture whose green channel is
    // roughness and whose blue channel is metalness. This is not an
    // approximation of the graph, it is the SAME arithmetic: three composes
    // `roughness * roughnessMap.g` and `metalness * metalnessMap.b`
    // (three.webgpu.js:17362,17371), which is exactly what `.g → roughness`
    // and `.b → metalness` emit here, with the factors pinned to 1 below.
    //
    // ⚠ ONLY these two channel pairings. `.r → roughness` would be a different
    // texel and there is no stock property that samples it, so anything else
    // must keep falling through to the compile path. Occlusion is deliberately
    // absent too: three's `aoMap` reads a different UV set, so expressing a
    // wired `ao` through it would move the lookup, not just re-spell it.
    if (
      src.type === "texture" &&
      dst === output &&
      ((e.sourceHandle === "g" && e.targetHandle === "roughness") ||
        (e.sourceHandle === "b" && e.targetHandle === "metalness"))
    ) {
      if (e.targetHandle === "roughness") {
        if (roughnessTex) return null;
        roughnessTex = src;
      } else {
        if (metalnessTex) return null;
        metalnessTex = src;
      }
      texUses.set(src, (texUses.get(src) ?? 0) + 1);
      continue;
    }
    // Alpha-masked foliage: the colour texture's OWN alpha into opacity. three
    // composes `materialColor` as `color * texture(map)` — a vec4 — and assigns
    // it straight to `diffuseColor`, so `map.a` is already the opacity on the
    // stock path. This wire is spelling out what stock does for free.
    //
    // ⚠ ONLY from the colour texture (checked after the loop). Another
    // texture's alpha has no stock slot — three's `alphaMap` reads `.g`, not
    // `.a` — so routing one through `map` would sample a different channel of
    // a different image.
    if (src.type === "texture" && e.sourceHandle === "a" && dst === output && e.targetHandle === "opacity") {
      if (alphaTex) return null;
      alphaTex = src;
      texUses.set(src, (texUses.get(src) ?? 0) + 1);
      continue;
    }
    if (src.type === "texture" && e.sourceHandle === "out" && dst === output && e.targetHandle === "color") {
      if (colorTex || mulToColor) return null;
      colorTex = src;
      texUses.set(src, (texUses.get(src) ?? 0) + 1);
      continue;
    }
    if (src.type === "texture" && e.sourceHandle === "out" && dst === nm && e.targetHandle === "color") {
      if (normalFeed) return null;
      normalFeed = src;
      texUses.set(src, (texUses.get(src) ?? 0) + 1);
      continue;
    }
    if (src === nm && dst === output && e.targetHandle === "normal") {
      if (normalWired) return null;
      normalWired = true;
      continue;
    }
    // ── ⭐⭐ THE BASE-COLOUR FACTOR: `texture x constant -> color` (2026-08-30) ──
    //
    // Exact, not an approximation, and by the same argument the ORM branch
    // above makes: three composes `diffuseColor = material.color * texture(map)`
    // (a vec4 multiply), which is precisely what `tex.out -> multiply` and
    // `color.out -> multiply -> output.color` emit here. The stock path just
    // spells it with `material.color` instead of a uniform node.
    //
    // ⭐⭐ WHY THIS TINY GAP MATTERED SO MUCH. Every glTF import writes this
    // shape — the importer multiplies the baseColorTexture by the material's
    // baseColorFactor — so a two-node factor chain kept EVERY imported PBR
    // material off the stock path. On the user's Sponza that is all 25 of them,
    // and the consequences were nowhere near the compile wave this function was
    // written to collapse:
    //
    //   `applyStockPbr` is what sets `material.roughnessMap` / `.metalnessMap`.
    //   The graph path never sets them (it drives `roughnessNode` /
    //   `metalnessNode` instead), leaving the STOCK SLOTS NULL and the stock
    //   SCALARS at whatever the .mat stored — `roughness: 1, metalness: 1` on
    //   every glTF import, because those are the factors the maps modulate.
    //
    // Anything reading a material through three's standard properties
    // therefore saw a fully-rough, fully-metallic surface. `three-gpu-pathtracer`
    // does exactly that (`getTexture(m, 'metalnessMap')`, falling back to
    // `material.metalness`), so the path-tracer reference view was rendering a
    // DIFFERENT MATERIAL SET than the raster frame it was being compared
    // against — silently, and for every comparison made against it
    // (docs/GI_SCALE_PLAN.md §2.7g).
    //
    // ⚠ Kept as narrow as the ORM branch: ONE multiply, ONE constant colour,
    // the multiply's two operands being exactly that texture and that constant,
    // and its output going only to `output.color`. Anything else falls through to
    // the compile path, where it still renders correctly — just not stock.
    if (mul && dst === mul && (e.targetHandle === "a" || e.targetHandle === "b")) {
      if (src.type === "texture" && e.sourceHandle === "out") {
        if (mulTex) return null;
        mulTex = src;
        texUses.set(src, (texUses.get(src) ?? 0) + 1);
        continue;
      }
      if (src === colorConst && e.sourceHandle === "out") {
        if (mulColorWired) return null;
        mulColorWired = true;
        continue;
      }
      return null;
    }
    if (mul && src === mul && dst === output && e.targetHandle === "color") {
      // A direct `texture -> color` wire and this chain are two spellings of
      // the same slot; both would mean two sources for one input.
      if (mulToColor || colorTex) return null;
      mulToColor = true;
      continue;
    }
    return null;
  }
  // Half a chain is not expressible: the multiply must have BOTH operands and
  // must be what feeds the colour, or the constant has nowhere to go.
  if (mul && !(mulTex && mulColorWired && mulToColor)) return null;
  // A normalMap node must be a complete texture → normal chain, every texture
  // must be consumed by at least one recognized role, and none may have a
  // wired UV (an edge INTO a texture was already rejected above — every
  // allowed edge targets nm or the output).
  //
  // "At least one" rather than "exactly one": an ORM map legitimately feeds
  // both roughness and metalness, and every edge reaching this point has
  // already been classified, so a second use can only be a second role.
  if (nm && (!normalFeed || !normalWired)) return null;
  // See the opacity branch: only the COLOUR texture's alpha is expressible,
  // because the stock path gets it through `map` and nothing else. With the
  // factor chain the colour texture is the multiply's operand — same texture,
  // one node further from the output, and it still lands in `map` below.
  const baseTex = colorTex ?? mulTex;
  if (alphaTex && alphaTex !== baseTex) return null;
  for (const n of nodes) {
    if (n.type !== "texture") continue;
    if ((texUses.get(n) ?? 0) < 1) return null;
    if (!n.props?.path) return null;
  }

  // Constants: props ?? registry default, straight from the same specs the
  // compiler reads, so the two paths can never drift on a default.
  const specs = outputSlotsFor(DEFAULT_MATERIAL_CLASS);
  const valueOf = (key) => {
    const spec = specs.find((s) => s.key === key);
    return output.props?.[key] ?? spec?.default ?? null;
  };
  // Wire-only channels (default null): a stored prop value would compile to a
  // live uniform on the graph path, which stock props cannot express. The
  // direct-slot Output widened this set a long way past the handful the BSDF
  // carried — clearcoat, sheen, iridescence, transmission, dispersion,
  // backdrop, mask and the rest of the Physical table all land here.
  for (const spec of specs) {
    if (spec.default !== null) continue;
    if (spec.key === "normal") continue; // handled structurally above
    if (output.props?.[spec.key] != null) return null;
  }
  const opacity = valueOf("opacity");
  const ao = valueOf("ao");
  if (opacity !== 1 || ao !== 1) return null;
  // Emission is a single slot now: the old strength multiply survives
  // migration as an explicit Multiply node, which this matcher already refuses
  // to classify on any channel but colour. Anything but black stays on the
  // compile path, because the GI module guards area-light wash through
  // `emissiveNode` and `material.emissiveMap` would bypass that guard.
  const emissive = new THREE.Color(valueOf("emissive") ?? "#000000");
  if (emissive.r > 0 || emissive.g > 0 || emissive.b > 0) return null;

  return {
    // A DIRECT wired color input is the texture ALONE on the graph path (no
    // factor multiply), so the stock expression must pin the factor to white.
    // Through the factor chain the graph computes `texture x constant`, and
    // `material.color` IS that constant — the one case where the factor is not
    // pinned, and the reason the chain is expressible at all.
    color: mulToColor ? (colorConst.props?.value ?? "#ffffff") : (colorTex ? "#ffffff" : valueOf("color")),
    // Same rule as colour, for the same reason: a wired channel REPLACES the
    // scalar on the graph path, while three MULTIPLIES the map by it. Pinning
    // to 1 is what makes the two paths the same number rather than nearly.
    roughness: roughnessTex ? 1 : valueOf("roughness"),
    metalness: metalnessTex ? 1 : valueOf("metalness"),
    ior: valueOf("ior"),
    specularIntensity: valueOf("specularIntensity"),
    specularColor: valueOf("specularColor"),
    map: baseTex?.props?.path ?? null,
    normalMap: normalFeed?.props?.path ?? null,
    roughnessMap: roughnessTex?.props?.path ?? null,
    metalnessMap: metalnessTex?.props?.path ?? null,
    normalScale: nm ? (nm.props?.scale ?? 1) : 1,
  };
}

/**
 * `uvNode` replaces the graph's default `uv()` source wherever a node falls
 * back to it (texture nodes, most notably). Terrain needs this: it blends
 * several layer .mats into one material and each layer samples at its own
 * tiling, which is impossible if every graph hard-codes the mesh's raw UV.
 */
export async function compileShaderGraph(graph, { taps, uvNode = null } = {}) {
  // Spanned for the freeze ledger: this is the per-material TSL node build,
  // and a material that misses `matchStockPbr` gets one of these ALL TO
  // ITSELF (fresh uniform/texture nodes per material ⇒ its own program ⇒ its
  // own driver compile). When a boot blocks in "(unattributed)" during scene
  // load, this is the first suspect.
  const __graphSpan = freeze.begin(`material:compileGraph ${graph?.name ?? ""}`.trim());
  try {
    return await compileShaderGraphInner(graph, { taps, uvNode });
  } finally {
    freeze.end(__graphSpan);
  }
}

async function compileShaderGraphInner(graph, { taps, uvNode = null } = {}) {
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

  // Known up-front so position sources can resolve to the raymarch sample while
  // building the volume subtree (see `builtin`).
  const materialClass = materialClassOf(graph);
  const isVolume = materialClass === "volume";

  const source = (name) => (name === "uv" && uvNode ? uvNode : builtin(name, isVolume));

  function inputNode(node, spec) {
    const edge = edges.find((e) => e.target === node.id && e.targetHandle === spec.key);
    if (edge) return build(edge.source, edge.sourceHandle);
    const value = node.props?.[spec.key] ?? spec.default;
    if (value != null) {
      const u = makeUniform(value);
      if (u) return uni(`${node.id}.${spec.key}`, u);
    }
    return spec.src ? source(spec.src) : null;
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
        result = def.build({ def, ins, out, props: node.props ?? {}, id, uni, textures });
      } else if (def.fn && !def.inputs?.length) {
        // Attribute-source node (uv, time, positionWorld, …) — may be a
        // callable TSL builder or a plain pre-built Node object.
        result = source(def.fn);
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
    // Only the sockets this material class actually reads: wires left over
    // from another class stay in the saved graph (so switching back restores
    // them) but must not reach a material that would ignore — or worse,
    // misread — the slot.
    for (const spec of outputSlotsFor(materialClass)) {
      // Same resolution as any other node input: the wire if there is one,
      // else the inline value as a live uniform the editor can patch without
      // a rebuild, else nothing at all (wire-only channels stay null).
      const node = inputNode(outputNode, spec);
      if (node == null) continue;
      if (spec.key === "volume") {
        // Volume bundle → consumed by the material-asset layer to drive a
        // VolumeNodeMaterial (scatteringNode / scatteringEmissiveNode / steps).
        if (node.__volume) mutations.__volume = node.__volume;
      } else {
        mutations[spec.slot] = node;
      }
    }
  }

  const tapNodes = {};
  if (taps) for (const id of taps) tapNodes[id] = build(id, null);

  return { mutations, uniforms, taps: tapNodes, materialClass, isVolume: materialClass === "volume" };
}

// --- Migration ------------------------------------------------------------

/** The Blender-style shader nodes the graph used to require between the value
 *  nodes and the Output. They are no longer authorable — the Output carries
 *  every channel directly — but every .mat on disk still names them, so their
 *  shape has to survive here to be rewritten on load.
 *
 *  `slots` maps a BSDF input key to the Output socket key it becomes. Both
 *  were already named after the material slot, so the map is nearly identity;
 *  it exists so a rename on either side stays a one-line change. */
const LEGACY_SHADERS = {
  principledBsdf: {
    slots: {
      color: "color", roughness: "roughness", metalness: "metalness", ior: "ior",
      specularIntensity: "specularIntensity", specularColor: "specularColor",
      opacity: "opacity", ao: "ao", normal: "normal", anisotropy: "anisotropy",
      clearcoat: "clearcoat", clearcoatRoughness: "clearcoatRoughness",
      sheen: "sheen", sheenRoughness: "sheenRoughness",
      transmission: "transmission", thickness: "thickness",
    },
    emissive: { color: "emissive", strength: "emissiveStrength", colorDefault: "#000000" },
  },
  emission: {
    // An Emission shader was a black, fully-rough, non-metal base whose only
    // light is its own — spelled out here as the constants it always meant.
    slots: {},
    base: { color: "#000000", roughness: 1, metalness: 0 },
    emissive: { color: "color", strength: "strength", colorDefault: "#ffffff" },
  },
};

/**
 * Rewrite a legacy `<shader> -> Output.surface` graph into direct Output wires.
 *
 * Every BSDF input becomes the Output socket of the same name: a wired input
 * moves its edge, an inline value moves to `output.props`. The one input with
 * no slot of its own is `emissiveStrength` — three applies `emissiveIntensity`
 * to `material.emissive` but NOT to `emissiveNode` (NodeMaterial assigns the
 * node straight through), so a strength other than 1 has to stay in the graph
 * as an explicit Multiply or the emission would silently change brightness.
 */
function migrateSurfaceShaders(graph) {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const output = nodes.find((n) => n.type === "output");
  if (!output) return graph;
  // Only a shader wired into the (now retired) `surface` socket is legacy.
  const surfaceEdge = edges.find((e) => e.target === output.id && e.targetHandle === "surface");
  const shader = surfaceEdge && nodes.find((n) => n.id === surfaceEdge.source);
  const legacy = shader && LEGACY_SHADERS[shader.type];
  if (!legacy) return graph;

  const outNodes = nodes.filter((n) => n !== shader);
  const outEdges = [];
  const props = { ...output.props, ...(legacy.base ?? {}) };
  const usedIds = new Set(nodes.map((n) => n.id));
  const freshId = (base) => {
    let id = base;
    while (usedIds.has(id)) id = id + "_";
    usedIds.add(id);
    return id;
  };

  // Inline values first: a wired input overrides nothing here, and an unwired
  // one keeps the number the user set on the BSDF.
  for (const [inKey, slotKey] of Object.entries(legacy.slots)) {
    const v = shader.props?.[inKey];
    if (v != null) props[slotKey] = v;
  }

  for (const e of edges) {
    if (e === surfaceEdge) continue;
    if (e.target !== shader.id) {
      outEdges.push(e);
      continue;
    }
    const slotKey = legacy.slots[e.targetHandle];
    // An edge into a channel with no slot of its own (the emissive pair, handled
    // below) is left out here rather than mis-wired.
    if (slotKey) outEdges.push({ ...e, target: output.id, targetHandle: slotKey });
  }

  // --- emissive x strength ---
  const { color: cKey, strength: sKey, colorDefault } = legacy.emissive;
  const colorEdge = edges.find((e) => e.target === shader.id && e.targetHandle === cKey);
  const strengthEdge = edges.find((e) => e.target === shader.id && e.targetHandle === sKey);
  const colorValue = shader.props?.[cKey] ?? colorDefault;
  const strengthValue = shader.props?.[sKey] ?? 1;

  // With both halves constant the multiply can be done here, exactly, as long
  // as the product still fits in a colour — which covers every dimming, and
  // covers a BLACK emissive at any strength at all. That case is not obscure:
  // glTF writes `emissiveStrength` on materials that emit nothing, and a graph
  // carrying a Multiply node is one three's stock-PBR matcher cannot express,
  // so folding here is what keeps those materials on the shared-program path.
  const folded = !colorEdge && !strengthEdge ? scaleHex(colorValue, strengthValue) : null;

  if (folded != null) {
    props.emissive = folded;
  } else if (!strengthEdge && strengthValue === 1) {
    // Strength is exactly 1: the emissive colour passes through untouched.
    if (colorEdge) outEdges.push({ ...colorEdge, target: output.id, targetHandle: "emissive" });
    else props.emissive = colorValue;
  } else {
    const x = shader.position?.x ?? 0;
    const y = shader.position?.y ?? 0;
    const mulId = freshId(shader.id + "_emissiveStrength");
    outNodes.push({ id: mulId, type: "multiply", props: {}, position: { x: x + 120, y: y + 40 } });
    if (colorEdge) {
      outEdges.push({ ...colorEdge, target: mulId, targetHandle: "a" });
    } else {
      const colorId = freshId(shader.id + "_emissive");
      outNodes.push({ id: colorId, type: "color", props: { value: colorValue }, position: { x: x - 60, y } });
      outEdges.push({ source: colorId, sourceHandle: "out", target: mulId, targetHandle: "a" });
    }
    if (strengthEdge) {
      outEdges.push({ ...strengthEdge, target: mulId, targetHandle: "b" });
    } else {
      const floatId = freshId(shader.id + "_emissiveStrengthValue");
      outNodes.push({ id: floatId, type: "float", props: { value: strengthValue }, position: { x: x - 60, y: y + 90 } });
      outEdges.push({ source: floatId, sourceHandle: "out", target: mulId, targetHandle: "b" });
    }
    outEdges.push({ source: mulId, sourceHandle: "out", target: output.id, targetHandle: "emissive" });
    // The Output's own inline emissive must not linger: the wire wins in the
    // compiler, but a stale prop would resurface the moment someone unplugs
    // the multiply.
    delete props.emissive;
  }

  return {
    ...graph,
    nodes: outNodes.map((n) => (n === output ? { ...output, props } : n)),
    edges: outEdges,
  };
}

/** `hex * scale` as a hex string, or null when the product would clip. Linear
 *  in the stored (sRGB-hex) numbers on purpose: that is the same arithmetic
 *  `emissiveNode = color.mul(strength)` performed on the uniform, so the folded
 *  constant renders identically rather than merely closely. */
function scaleHex(hex, scale) {
  if (typeof hex !== "string" || typeof scale !== "number" || !Number.isFinite(scale) || scale < 0) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const out = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => (c / 255) * scale);
  if (out.some((c) => c > 1)) return null;
  return `#${out.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** A Volume node wired into the Output used to BE the material-class switch;
 *  the class is now an explicit `material` param. Carry the old wiring over. */
function migrateVolumeClass(graph) {
  const output = graph.nodes?.find((n) => n.type === "output");
  if (!output || output.props?.material) return graph;
  const wired = (graph.edges ?? []).some((e) => e.target === output.id && e.targetHandle === "volume");
  if (!wired) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n === output ? { ...n, props: { ...n.props, material: "volume" } } : n)),
  };
}

// A Texture wired STRAIGHT into a `normal` input is the other thing that needs
// rewriting. A normal map stores a tangent-space vector packed into 0..1
// texels — feeding those raw RGB values in as a normal vector produces normals
// that all point roughly +Z-ish in the wrong space, so lighting collapses and
// the surface goes dark. It has to pass through a Normal Map node, which
// unpacks (texel*2-1) and applies the TBN transform.
//
// Older importers emitted the direct wire; the generator now inserts the node
// itself (see pbrMaterialGraph.js), but .mat files already on disk still carry
// the broken edge and would never be regenerated. Repair them on load.
function migrateNormalMaps(graph) {
  if (!graph?.nodes?.length) return graph;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges ?? [];
  const direct = edges.filter(
    (e) => e.targetHandle === "normal" && byId.get(e.source)?.type === "texture",
  );
  if (!direct.length) return graph;

  const nodes = [...graph.nodes];
  const next = edges.filter((e) => !direct.includes(e));
  for (const edge of direct) {
    const tex = byId.get(edge.source);
    let id = `normalMap_${edge.source}`;
    while (byId.has(id)) id = `${id}_`;
    nodes.push({
      id,
      type: "normalMap",
      props: { scale: 1 },
      position: { x: (tex.position?.x ?? 0) + 260, y: tex.position?.y ?? 0 },
    });
    // Always take the texture's full color, never a single channel — a normal
    // map needs all three components.
    next.push({ source: edge.source, sourceHandle: "out", target: id, targetHandle: "color" });
    next.push({ source: id, sourceHandle: "out", target: edge.target, targetHandle: "normal" });
  }
  return { ...graph, nodes, edges: next };
}

/** Bring any graph the project has ever written up to the current shape.
 *  Idempotent, and ordered: the normal-map repair rewires by target HANDLE, so
 *  it must run while the handles are still whatever the file stored; the class
 *  param has to be set before the shader rewrite folds the surface edge away. */
export function migrateGraph(graph) {
  if (!graph?.nodes?.length) return graph;
  return migrateSurfaceShaders(migrateVolumeClass(migrateNormalMaps(graph)));
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

  // Expression for one input of `node` — a wired upstream, else its inline
  // value, else null (wire-only input left unconnected).
  const inputExpr = (node, key) => {
    const def = NODE_TYPES[node.type];
    const spec = def.inputs?.find((s) => s.key === key);
    if (!spec) return null;
    const edge = edges.find((e) => e.target === node.id && e.targetHandle === key);
    if (edge) return emit(edge.source, edge.sourceHandle);
    const value = node.props?.[key] ?? spec.default;
    if (value == null) return null;
    return typeof value === "string"
      ? `${use("color")}('${value}')`
      : Array.isArray(value)
        ? `${use(`vec${value.length}`)}(${value.map(num).join(", ")})`
        : num(value);
  };

  const assignments = [];
  const output = graph.nodes.find((n) => n.type === "output");
  const materialClass = materialClassOf(graph);
  if (output) {
    for (const spec of outputSlotsFor(materialClass)) {
      // A Volume output is a raymarch bundle, not an assignable slot — three
      // wants two callbacks on VolumeNodeMaterial, which no expression here
      // can spell. Say so rather than emit something that will not run.
      if (spec.key === "volume") {
        const wired = edges.find((e) => e.target === output.id && e.targetHandle === "volume");
        if (wired) assignments.push("// Volume: see VolumeNodeMaterial.scatteringNode / scatteringEmissiveNode");
        continue;
      }
      const expr = inputExpr(output, spec.key);
      if (expr != null) assignments.push(`material.${spec.slot} = ${expr};`);
    }
  }
  if (!assignments.length) return "// nothing wired to the Material Output";

  const ctor = MATERIAL_CLASSES[materialClass].ctor;
  return [
    `import { ${[...imports].sort().join(", ")} } from 'three/tsl';`,
    "",
    `// const material = new THREE.${ctor}();`,
    ...lines,
    "",
    ...assignments,
  ].join("\n");
}
