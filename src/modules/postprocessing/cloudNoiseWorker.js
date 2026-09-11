/**
 * Worker wrapper around `generateCloudNoise`. See that module for why the
 * generation may not happen on the main thread (up to 2.1 s for a 96³ field).
 *
 * Protocol: postMessage({ size }) → postMessage({ size, data }) with the
 * buffer TRANSFERRED (no copy of the ~885 KB payload).
 */
import { generateCloudNoise } from "./cloudNoise.js";

self.onmessage = (event) => {
  const size = event.data?.size ?? 64;
  try {
    const data = generateCloudNoise(size);
    self.postMessage({ size, data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ size, error: String(err?.message ?? err) });
  }
};
