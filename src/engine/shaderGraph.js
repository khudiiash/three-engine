/**
 * The FIRST shader-graph runtime, kept only for what it can still tell us about
 * .mat files written under it. Nothing here compiles or renders any more:
 * `tslGraph.js` is the runtime, and its Material Output carries one socket per
 * three.js material `*Node` slot.
 *
 * Two things about those old files still have to be repaired on load, and this
 * module is where the knowledge of the old shape lives:
 *
 *   - the prop names ran on this runtime's vocabulary (`baseColor`, `specular`,
 *     `alpha`, …) rather than three's (`color`, `specularIntensity`, `opacity`);
 *   - a graph was a single COLOUR sink — value nodes wired into an Output whose
 *     only socket was `color` — with no shader node at all.
 *
 * `migrateLegacyGraph` translates both into the Principled BSDF shape, which
 * `tslGraph.migrateGraph` then rewrites into direct Output wires. Two hops on
 * purpose: each one is the inverse of a rewrite that actually happened, so
 * neither has to know about the other's era.
 */

/**
 * Translate the prop names this runtime used on `principledBsdf` nodes
 * (`baseColor`, `specular`, `specularTint`, `emission`, `alpha`,
 * `transmissionRoughness`) to the ones the live runtime reads (`color`,
 * `specularIntensity`, `specularColor`, `emissive`, `opacity`, `thickness`).
 *
 * Without this translation a .mat authored under the legacy runtime silently
 * renders with the runtime's input defaults (white diffuse, etc.) — every
 * input resolves to its spec default because none of the new keys are
 * populated.
 *
 * Idempotent and cheap: a node is only rewritten when it actually carries
 * legacy keys, so already-modern graphs are returned unchanged.
 */
function normalizeLegacyPropKeys(graph) {
  if (!graph?.nodes?.length) return graph;
  const RENAMES = {
    baseColor: "color",
    specular: "specularIntensity",
    specularTint: "specularColor",
    anisotropicRotation: null, // dropped — no longer an exposed input
    sheenTint: "sheen",
    emission: "emissive",
    alpha: "opacity",
    transmissionRoughness: "thickness",
  };
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    if (!n?.props) return n;
    let nodeChanged = false;
    const props = { ...n.props };
    for (const [from, to] of Object.entries(RENAMES)) {
      if (from in props) {
        if (to && props[to] == null) props[to] = props[from];
        delete props[from];
        nodeChanged = true;
      }
    }
    // `sheen` was the scalar amount here and is the scalar amount now — no
    // rename, deliberately.
    if (nodeChanged) {
      changed = true;
      return { ...n, props };
    }
    return n;
  });
  if (!changed) return graph;
  return { ...graph, nodes };
}

/**
 * Convert an older single-Output (colour-sink) graph into the Principled BSDF
 * shape: a BSDF pre-seeded from the .mat's own scalars, wired to the Output.
 *
 * Detected when a `type === "output"` node has a `color` target handle and
 * NOTHING else — the old API's only socket. The modern slot-based Output also
 * has a `color` socket, so `output.color` alone is ambiguous; any other wired
 * handle proves the graph is already current and migrating it would drop those
 * edges. Idempotent — already-migrated graphs pass straight through.
 */
export function migrateLegacyGraph(graph, def) {
  if (!graph?.nodes?.length) return graph;
  const normalized = normalizeLegacyPropKeys(graph);
  const outputIds = new Set(normalized.nodes.filter((n) => n.type === "output").map((n) => n.id));
  const outputEdges = (normalized.edges ?? []).filter((e) => outputIds.has(e.target));
  const hasLegacy = outputEdges.length > 0 && outputEdges.every((e) => e.targetHandle === "color");
  if (!hasLegacy) return normalized;

  // Seed props under the keys the live runtime reads, or the user's stored
  // colour would be dropped and the graph would compile to default white.
  const seedProps = {
    color: def?.color ?? "#ffffff",
    ior: 1.5,
    specularIntensity: 0.5,
    specularColor: "#ffffff",
    emissive: "#000000",
    emissiveStrength: 1,
    opacity: 1,
  };
  if (def?.roughness != null) seedProps.roughness = def.roughness;
  if (def?.metalness != null) seedProps.metalness = def.metalness;

  const oldOutput = normalized.nodes.find((n) => n.type === "output");
  const oldEdges = normalized.edges ?? [];

  // The legacy Output only had a `color` input, so every edge into it carries a
  // colour expression and they all funnel into Principled.color. Anything odd
  // (an edge with a strange handle) is dropped rather than mis-wired.
  const newEdges = [];
  for (const e of oldEdges) {
    if (e.target === oldOutput.id && e.targetHandle === "color") {
      newEdges.push({ ...e, target: "principled", targetHandle: "color" });
    } else if (e.target !== oldOutput.id) {
      newEdges.push(e);
    }
  }
  newEdges.push({ source: "principled", sourceHandle: "out", target: "output", targetHandle: "surface" });

  const newNodes = [
    ...normalized.nodes.filter((n) => n.id !== oldOutput.id),
    { id: "principled", type: "principledBsdf", props: seedProps, position: { x: 280, y: 200 } },
    { id: "output", type: "output", props: {}, position: { x: 600, y: 200 } },
  ];

  return { nodes: newNodes, edges: newEdges };
}
