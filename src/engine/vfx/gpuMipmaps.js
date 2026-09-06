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

const blitters = new WeakMap();

/** One blitter per renderer (per GPU device). */
export function mipmapBlitter(renderer) {
  const backend = renderer?.backend;
  const device = backend?.device;
  if (!device || !backend.get) return null;
  let blitter = blitters.get(device);
  if (blitter) return blitter;
  const module = device.createShaderModule({ code: SHADER, label: "water mip blit" });
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
      const { passes } = cacheFor(gpuTexture);
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
