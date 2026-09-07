/**
 * ══ MIPS WITHOUT ALLOCATIONS (2026-09-07) ═══════════════════════════════════
 *
 * three's mipmap pass creates a texture VIEW and a BIND GROUP for every layer
 * of every level on every call (WebGPUTexturePassUtils.generateMipmaps). The
 * sea's two 3-layer arrays and the whitecap memory are regenerated every
 * frame — ~60 bind groups a frame on top of the caustic map's own — and
 * WebGPU has no way to free a bind group but to let it be collected; Dawn's
 * D3D12 backend backs them with descriptor heaps, and a few minutes in the
 * heaps were gone: `ID3D12Device::CreateDescriptorHeap failed with
 * E_OUTOFMEMORY`, device lost, the renderer rebuilt (user, 2026-09-07).
 *
 * This blitter builds its views, bind groups and pipeline ONCE per GPU
 * texture and only encodes render passes per frame: a fullscreen triangle
 * sampling level n − 1 into level n, layer by layer. The cache is keyed by
 * the GPU texture object, so a renderer rebuild or a resize (a new GPUTexture)
 * rebuilds it on first use.
 */
const SHADER = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VOut;
  o.pos = vec4f(p[i], 0, 1);
  o.uv = vec2f(p[i].x * .5 + .5, 1 - (p[i].y * .5 + .5));
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f { return textureSample(src, samp, in.uv); }
`;

/**
 * ⚠ RENDER PASSES ARE THE COST ON A PHONE. The sea's two 3-layer arrays
 * were 42 render passes a frame (a pass per layer per level), and a
 * tile-based GPU pays a tile load/store for every one of them. A storage
 * texture (the sea's arrays are) can be written by a compute shader:
 * ONE dispatch per level averages 2 × 2 texels into every layer at once —
 * 14 dispatches instead of 42 passes. A render target (the foam map) keeps
 * the blit: it has no storage binding.
 */
const COMPUTE_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1) fn cs(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let layer = i32(id.z);
  let p = vec2i(id.xy) * 2;
  let s = textureLoad(src, p, layer, 0) + textureLoad(src, p + vec2i(1, 0), layer, 0)
        + textureLoad(src, p + vec2i(0, 1), layer, 0) + textureLoad(src, p + vec2i(1, 1), layer, 0);
  textureStore(dst, vec2i(id.xy), layer, s * .25);
}
`;
const blitters = new WeakMap();

/** One blitter per renderer (per GPU device). */
export function mipmapBlitter(renderer) {
  const backend = renderer?.backend;
  const device = backend?.device;
  if (!device || !backend.get) return null;
  let blitter = blitters.get(device);
  if (blitter) return blitter;
  const module = device.createShaderModule({ code: SHADER, label: "water mip blit" });
  const computeModule = device.createShaderModule({ code: COMPUTE_SHADER, label: "water mip compute" });
  let computePipeline = null;
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
  const pipelines = new Map();   // format → pipeline
  const caches = new WeakMap();  // GPUTexture → { passes }
  const pipelineFor = (format) => {
    let pipeline = pipelines.get(format);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: `water mip blit ${format}`, layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      pipelines.set(format, pipeline);
    }
    return pipeline;
  };
  const cacheFor = (gpuTexture) => {
    let cache = caches.get(gpuTexture);
    if (cache) return cache;
    // A storage array of rgba16float: the compute path.
    if ((gpuTexture.usage & GPUTextureUsage.STORAGE_BINDING) && gpuTexture.format === "rgba16float" && gpuTexture.depthOrArrayLayers > 1) {
      computePipeline ??= device.createComputePipeline({ label: "water mip compute", layout: "auto", compute: { module: computeModule, entryPoint: "cs" } });
      const layout = computePipeline.getBindGroupLayout(0);
      const dispatches = [];
      for (let level = 1; level < gpuTexture.mipLevelCount; level++) {
        const view = (mip) => gpuTexture.createView({ dimension: "2d-array", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: gpuTexture.depthOrArrayLayers });
        const bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: view(level - 1) }, { binding: 1, resource: view(level) }] });
        const w = Math.max(1, gpuTexture.width >> level), h = Math.max(1, gpuTexture.height >> level);
        dispatches.push({ bindGroup, groups: [Math.ceil(w / 8), Math.ceil(h / 8), gpuTexture.depthOrArrayLayers] });
      }
      cache = { dispatches };
      caches.set(gpuTexture, cache);
      return cache;
    }
    const pipeline = pipelineFor(gpuTexture.format);
    const layout = pipeline.getBindGroupLayout(0);
    const passes = [];
    for (let layer = 0; layer < gpuTexture.depthOrArrayLayers; layer++) {
      for (let level = 1; level < gpuTexture.mipLevelCount; level++) {
        const view = (mip) => gpuTexture.createView({ dimension: "2d", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
        const bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: view(level - 1) }] });
        passes.push({ pipeline, bindGroup, target: view(level) });
      }
    }
    cache = { passes };
    caches.set(gpuTexture, cache);
    return cache;
  };
  blitter = {
    /** Regenerate every mip of `texture` (a three texture the backend has created) from its level 0. */
    generate(texture) {
      const gpuTexture = backend.get(texture)?.texture;
      if (!gpuTexture || gpuTexture.mipLevelCount <= 1) return false;
      const cache = cacheFor(gpuTexture);
      if (cache.dispatches) {
        const encoder = device.createCommandEncoder({ label: "water mips (compute)" });
        const pass = encoder.beginComputePass();
        pass.setPipeline(computePipeline);
        for (const { bindGroup, groups } of cache.dispatches) { pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(...groups); }
        pass.end();
        device.queue.submit([encoder.finish()]);
        return true;
      }
      const { passes } = cache;
      if (!passes.length) return false;
      const encoder = device.createCommandEncoder({ label: "water mips" });
      for (const { pipeline, bindGroup, target } of passes) {
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
      return true;
    },
  };
  blitters.set(device, blitter);
  return blitter;
}
