// Optional diagnostic instrumentation, never loaded by the engine itself.
export function trackFoliageUploads(renderer, layers) {
  const queue = renderer.backend.device.queue, write = queue.writeBuffer;
  const owners = new WeakMap();
  const register = () => {
    for (const component of layers) for (const [lod, mesh] of component.renderMeshes.entries()) {
      if (!mesh) continue;
      if (mesh.instanceMatrix) owners.set(mesh.instanceMatrix.array, `foliage:${component.props.species}:LOD${lod}:matrix`);
      for (const [key, attribute] of Object.entries(mesh.geometry.attributes))
        owners.set((attribute.data ?? attribute).array, `foliage:${component.props.species}:LOD${lod}:${key}`);
    }
  };
  let buckets = new Map();
  queue.writeBuffer = function(buffer, offset, data, dataOffset, size) {
    const unit = data.BYTES_PER_ELEMENT ?? 1;
    const bytes = size == null ? data.byteLength - (dataOffset ?? 0) * unit : size * unit;
    const owner = owners.get(data) ?? `other:${buffer.label || 'unlabelled'}:${buffer.usage}:${data.byteLength}`;
    let bucket = buckets.get(owner);
    if (!bucket) buckets.set(owner, bucket = {owner, calls:0, bytes:0, milliseconds:0, maxMs:0, maxBytes:0});
    const start = performance.now();
    try { return write.apply(this, arguments); }
    finally {
      const ms = performance.now() - start;
      bucket.calls++; bucket.bytes += bytes; bucket.milliseconds += ms;
      bucket.maxMs = Math.max(bucket.maxMs, ms); bucket.maxBytes = Math.max(bucket.maxBytes, bytes);
    }
  };
  return {
    reset() { register(); buckets = new Map(); },
    read() { return [...buckets.values()].sort((a,b)=>b.bytes-a.bytes); },
    dispose() { queue.writeBuffer = write; },
  };
}
