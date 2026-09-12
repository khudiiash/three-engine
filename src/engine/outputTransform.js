// outputTransform — tone mapping + colour space applied INSIDE every material
// instead of in three's extra full-screen pass.
//
// three's WebGPU renderer, whenever `renderer.toneMapping` is not "none" or
// `outputColorSpace` is not the working space, renders the whole scene into
// an offscreen half-float frame buffer and then draws ONE full-screen quad
// (`outputColorTransform`) that tone-maps and encodes it onto the canvas
// (`Renderer.needsFrameBufferTarget` / `_getFrameBufferTarget`). On a desktop
// that quad is free. On the user's iPhone the per-pass ledger (`?hud=1`,
// 2026-09-11) read the scene pass at 6.4 ms AND that canvas quad at 6.0 ms —
// a tile GPU pays a second full-resolution render pass (tile load/store of
// a 780×1398 RGBA16F target, then the quad) for a transform every material
// could have done in its own fragment shader, as three's WebGL renderer
// always did.
//
// So, when installed:
//   · `renderer.toneMapping` = none and `outputColorSpace` = working, which
//     makes `needsFrameBufferTarget` false — the scene draws straight onto
//     the canvas;
//   · `renderer.contextNode` carries a `getOutput` hook (NodeMaterial calls
//     `builder.context.getOutput(color, builder)` at the end of every fragment
//     flow) that wraps the colour in `renderOutput(tone mapping, colour space)`
//     — ONLY when the material is being built for the output target
//     (`renderer.isOutputTarget`), so the GI g-buffer prepass, reflection
//     captures, the postprocess PassNode and every other offscreen render keep
//     linear, un-tone-mapped output exactly as before;
//   · while a render override (the postprocess component) owns the frame, the
//     real values are handed back to the renderer around its render — three's
//     RenderPipeline reads them for its own output pass and swaps them to
//     none/working itself around the quad it draws.
//
// Costs to know: transparent surfaces now blend in tone-mapped space (what
// WebGL three has always done); changing the tone mapping at runtime re-mints
// every lit material once (the context node is half of three's node cache
// key — that is exactly why the constants are captured in a fresh context
// node per change rather than read from a live uniform). Exposure stays a
// live uniform (`toneMappingExposure`), no re-mint.
//
// `__engineDirectOutput = false` (set before boot) keeps three's frame buffer
// path; the pure `outputPolicy` is what `tests/output-transform.test.mjs` pins.
import * as THREE from "three/webgpu";
import { context, renderOutput } from "three/tsl";

/**
 * What the renderer is told versus what the materials apply.
 * @param {{ direct: boolean, toneMapping: number, outputColorSpace: string }} wanted
 */
export function outputPolicy({ direct, toneMapping, outputColorSpace }) {
  if (!direct) {
    return { renderer: { toneMapping, outputColorSpace }, inline: null };
  }
  return {
    renderer: { toneMapping: THREE.NoToneMapping, outputColorSpace: THREE.LinearSRGBColorSpace },
    inline: { toneMapping, outputColorSpace },
  };
}

/**
 * Installs the inline output transform on a renderer. Idempotent; returns the
 * holder that `applyOutputTransform` updates and `withRealOutput` reads.
 */
export function installDirectOutput(renderer, { toneMapping = THREE.NeutralToneMapping, outputColorSpace = THREE.SRGBColorSpace } = {}) {
  if (renderer.__directOutput) return renderer.__directOutput;
  const holder = { toneMapping, outputColorSpace, contextNode: null };
  const getOutput = (color, builder) => {
    const r = builder?.renderer ?? renderer;
    if (r.isOutputTarget !== true) return color;
    return renderOutput(color, holder.toneMapping, holder.outputColorSpace);
  };
  const rearm = () => {
    // three's renderer owns ONE context node (`Renderer.contextNode`, whose
    // `value` it also uses for the high-precision model-view matrices), and
    // NodeBuilder merges `contextNode.getFlowContextData()` — that `value` —
    // into every material build. So the hook is ADDED to that object, never
    // a replacement node; a tone-mapping change bumps the node's version,
    // which is in the material cache key, so every lit material re-mints
    // against the new constants exactly once.
    const node = renderer.contextNode ?? (renderer.contextNode = context());
    if (!node.value || typeof node.value !== "object") node.value = {};
    node.value.getOutput = getOutput;
    if (holder.contextNode === node) node.version = (node.version ?? 0) + 1;
    holder.contextNode = node;
    const policy = outputPolicy({ direct: true, toneMapping: holder.toneMapping, outputColorSpace: holder.outputColorSpace });
    renderer.toneMapping = policy.renderer.toneMapping;
    renderer.outputColorSpace = policy.renderer.outputColorSpace;
    console.info(`[engine] inline output transform: tone mapping ${holder.toneMapping}, ${holder.outputColorSpace} — the scene draws straight onto the canvas (\`__engineDirectOutput = false\` restores three's frame buffer + quad)`);
  };
  holder.set = (next = {}) => {
    const tm = next.toneMapping ?? holder.toneMapping;
    const cs = next.outputColorSpace ?? holder.outputColorSpace;
    if (tm === holder.toneMapping && cs === holder.outputColorSpace && holder.contextNode) return;
    holder.toneMapping = tm;
    holder.outputColorSpace = cs;
    rearm();
  };
  renderer.__directOutput = holder;
  rearm();
  return holder;
}

/**
 * The one way scene settings set tone mapping on a renderer: through the
 * holder when the inline path is installed, straight onto the renderer
 * otherwise.
 */
export function applyOutputTransform(renderer, { toneMapping, exposure }) {
  if (!renderer) return;
  if (exposure != null) renderer.toneMappingExposure = exposure;
  const holder = renderer.__directOutput;
  if (holder) holder.set({ toneMapping });
  else renderer.toneMapping = toneMapping;
}

/**
 * Runs `fn` with the renderer carrying the REAL tone mapping and colour space
 * — for a render override whose pipeline reads them for its own output pass.
 * No-op when the inline path is not installed.
 */
export function withRealOutput(renderer, fn) {
  const holder = renderer?.__directOutput;
  if (!holder) return fn();
  const tm = renderer.toneMapping;
  const cs = renderer.outputColorSpace;
  renderer.toneMapping = holder.toneMapping;
  renderer.outputColorSpace = holder.outputColorSpace;
  try {
    return fn();
  } finally {
    renderer.toneMapping = tm;
    renderer.outputColorSpace = cs;
  }
}
