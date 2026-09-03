import assert from "node:assert/strict";
import test from "node:test";

import {
  installGiComputePipelineCache,
  markGiComputePipeline,
  releaseGiComputePipelineNode,
} from "../src/modules/gi/giComputePipelineCache.js";

function fakeRenderer() {
  const data = new WeakMap();
  return {
    _pipelines: {
      data,
      __deletes: 0,
      _getComputeCacheKey(node, stage) {
        return `${node.id},${stage.id}`;
      },
      delete() {
        this.__deletes++;
      },
    },
  };
}

test("GI compute generations reuse a pipeline for identical WGSL stage content", () => {
  const renderer = fakeRenderer();
  assert.equal(installGiComputePipelineCache(renderer), true);
  const stage = { id: 42 };
  const oldNode = markGiComputePipeline({ id: 1 });
  const newNode = markGiComputePipeline({ id: 2 });

  assert.equal(
    renderer._pipelines._getComputeCacheKey(oldNode, stage),
    renderer._pipelines._getComputeCacheKey(newNode, stage),
  );
  assert.equal(renderer._pipelines._getComputeCacheKey(oldNode, stage), "gi-wgsl:42");
});

test("non-GI compute nodes retain Three's identity cache key", () => {
  const renderer = fakeRenderer();
  installGiComputePipelineCache(renderer);
  const stage = { id: 42 };
  assert.equal(renderer._pipelines._getComputeCacheKey({ id: 1 }, stage), "1,42");
  assert.equal(renderer._pipelines._getComputeCacheKey({ id: 2 }, stage), "2,42");
});

test("release drops only the old node association and preserves compiled content", () => {
  const renderer = fakeRenderer();
  installGiComputePipelineCache(renderer);
  const node = markGiComputePipeline({ id: 1 });
  renderer._pipelines.data.set(node, { pipeline: { cacheKey: "gi-wgsl:42" } });

  assert.equal(releaseGiComputePipelineNode(renderer, node), true);
  assert.equal(renderer._pipelines.data.has(node), false);
  assert.equal(renderer._pipelines.__deletes, 0, "must not decrement and evict shared compiled content");
});

test("release falls back when the renderer was not patched", () => {
  const renderer = fakeRenderer();
  assert.equal(releaseGiComputePipelineNode(renderer, markGiComputePipeline({ id: 1 })), false);
});
