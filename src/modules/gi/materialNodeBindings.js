/** Shared, bounded inspection of the simple TSL node shapes emitted by the
 * engine material graph. These helpers deliberately do not try to evaluate
 * arbitrary shader code; they recover the classic material inputs needed by
 * CPU-side GI metadata and third-party renderers. */
export function constantColorOf(node, depth = 0) {
  if (!node || depth > 8) return null;
  const value = node.value;
  if (value && typeof value === "object" && typeof value.r === "number") return value;
  if (typeof value === "number") return { r: value, g: value, b: value };
  if ((node.op === "*" || node.op === "+") && node.aNode && node.bNode) {
    const a = constantColorOf(node.aNode, depth + 1);
    const b = constantColorOf(node.bNode, depth + 1);
    if (a && b) {
      return node.op === "*"
        ? { r: a.r * b.r, g: a.g * b.g, b: a.b * b.b }
        : { r: a.r + b.r, g: a.g + b.g, b: a.b + b.b };
    }
  }
  if (node.node) return constantColorOf(node.node, depth + 1);
  return null;
}

export function textureValueOf(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (node.value?.isTexture) return node.value;
  for (const child of [node.aNode, node.bNode, node.node]) {
    const found = child ? textureValueOf(child, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

export function tintBesideTexture(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (node.op === "*" && node.aNode && node.bNode) {
    const aTex = !!textureValueOf(node.aNode);
    const bTex = !!textureValueOf(node.bNode);
    if (aTex !== bTex) return constantColorOf(aTex ? node.bNode : node.aNode);
  }
  if (node.node) return tintBesideTexture(node.node, depth + 1);
  return null;
}

export function constantFloatOf(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (typeof node.value === "number") return node.value;
  if (node.node) return constantFloatOf(node.node, depth + 1);
  return null;
}

/** Resolve the albedo that the engine's actual material shader reads. Node
 * materials commonly leave `.map = null` and `.color = white`; consumers that
 * inspect only the classic fields therefore produced white reflection holes. */
export function resolveMaterialAlbedo(material) {
  const colorNode = material?.colorNode;
  const map = material?.map ?? textureValueOf(colorNode);
  const tint = constantColorOf(colorNode)
    ?? tintBesideTexture(colorNode)
    ?? material?.color
    ?? { r: 1, g: 1, b: 1 };
  return { map, tint };
}
