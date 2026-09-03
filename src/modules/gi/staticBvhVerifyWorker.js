import { decodeStaticBvhArtifact } from "./staticBvhDiskCache.js";

// CRC over a Bistro-sized artifact is intentionally off the render/UI thread.
// The ArrayBuffer moves into and back out of this worker; neither transfer
// copies the ~158 MiB payload, and the returned Uint32Array remains the upload
// staging view consumed by GISystem.
self.onmessage = ({ data }) => {
  const artifact = decodeStaticBvhArtifact(data.buffer, {
    expectedSignature: data.expectedSignature,
    builderAbi: data.builderAbi,
    expectedFormat: data.expectedFormat,
    verifyChecksum: true,
  });
  if (!artifact) {
    self.postMessage({ artifact: null });
    return;
  }
  self.postMessage({ artifact }, [artifact.packed.words.buffer]);
};
