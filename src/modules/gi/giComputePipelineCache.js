// @ts-check

/**
 * Three.js normally keys a compute pipeline by `computeNode.id + program.id`.
 * GI rebuilds create fresh ComputeNodes even when their generated WGSL is
 * byte-for-byte identical, so that identity key turns every settings change
 * into another driver compile.
 *
 * For GI nodes only, use the ProgrammableStage id. Three already interns that
 * stage by the full WGSL source, and WebGPU bind-group layouts are interned by
 * their structural entries, so this is a content cache without retaining an
 * old node, bind group, or storage buffer.
 */
export function installGiComputePipelineCache(renderer) {
  const pipelines = renderer?._pipelines;
  if (!pipelines || typeof pipelines._getComputeCacheKey !== "function") return false;
  if (pipelines.__giContentPipelineCache === true) return true;

  const original = pipelines._getComputeCacheKey;
  pipelines._getComputeCacheKey = function (computeNode, stageCompute) {
    if (computeNode?.__giContentPipelineCache === true && stageCompute?.id != null) {
      return `gi-wgsl:${stageCompute.id}`;
    }
    return original.call(this, computeNode, stageCompute);
  };
  pipelines.__giContentPipelineCache = true;
  return true;
}

/** Marks a node before its first trip through Three's pipeline cache. */
export function markGiComputePipeline(node) {
  if (!node || typeof node !== "object") return node;
  node.__giContentPipelineCache = true;
  return node;
}

/**
 * Drops a discarded node's per-node Pipelines DataMap entry while deliberately
 * retaining the small compiled pipeline/program objects in the content cache.
 * Bindings and NodeManager state are released separately by releaseCompute.js;
 * those are the objects that retain the large GI storage buffers.
 */
export function releaseGiComputePipelineNode(renderer, node) {
  const pipelines = renderer?._pipelines;
  if (
    !pipelines ||
    pipelines.__giContentPipelineCache !== true ||
    node?.__giContentPipelineCache !== true
  ) return false;

  // Pipelines extends DataMap; bypassing its public delete is intentional.
  // Public delete decrements the shared pipeline/program to zero and evicts
  // exactly the content we want the next generation to reuse.
  pipelines.data?.delete?.(node);
  return true;
}
