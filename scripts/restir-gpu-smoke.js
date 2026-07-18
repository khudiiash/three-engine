import * as THREE from "three/webgpu";
import { createRestirNodes } from "/src/modules/restir-gi/restirCompute.js";
import { buildSceneBVHAsync } from "/src/modules/restir-gi/bvh.js";

// GPU smoke + temporal stability test. Mirrors RestirGISystem's parity
// ping-pong and runs many frames over a stationary (sky-only) signal, then
// reads the temporal reservoir back. The unbiased contribution weight W must
// converge near 1/pdf = 2π; unbounded growth here is exactly the bug that
// made scenes fill with white over a few seconds.
const FRAMES = 60;
// Temporal W must sit at the 2π fixed point. Spatial W is asserted on its
// MEAN: per-pixel outliers are expected (the receiver cosine in the target
// cancels against the same cosine at resolve, so they stay bounded), but the
// old M-clamp bug dragged the mean to ~44 by frame 60.
const W_LIMIT = 20;

const result = document.querySelector("#result");
const keepAlive = setInterval(() => {}, 100);
try {
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  renderer.setSize(32, 24);
  document.body.append(renderer.domElement);
  await renderer.init();
  const width = 16, height = 12, count = width * height;
  const dims = { x: 8, y: 8, z: 8 };
  const set = () => new THREE.StorageBufferAttribute(new Float32Array(count * 16), 4);
  // Real (empty-scene) BVH: a single never-hit leaf, so every ray misses to
  // sky — a stationary signal, which is exactly what the W assertions need.
  const built = await buildSceneBVHAsync(new THREE.Scene());
  const bvh = {
    nodes: new THREE.StorageBufferAttribute(new Float32Array(8 * 8), 4),
    triPositions: new THREE.StorageBufferAttribute(new Float32Array(8 * 12), 4),
    triData: new THREE.StorageBufferAttribute(new Uint32Array(8 * 4), 1),
    nodeCapacity: 8,
    triCapacity: 8,
  };
  bvh.nodes.array.set(built.nodes);
  const cache = { radiance: new THREE.StorageBufferAttribute(new Float32Array(512 * 4), 4) };
  const gbuffer = () => {
    const depth = new THREE.DepthTexture(width, height);
    const target = new THREE.RenderTarget(width, height, { depthTexture: depth });
    return { target, depth, normal: target.texture };
  };
  const gbuffers = [gbuffer(), gbuffer()];
  const raw = new THREE.StorageTexture(width, height);
  const scratch = new THREE.StorageTexture(width, height);
  const outputs = [new THREE.StorageTexture(width, height), new THREE.StorageTexture(width, height)];
  for (const t of [raw, scratch, ...outputs]) t.type = THREE.HalfFloatType;
  const reservoirs = {
    initial: set(),
    temporal: [set(), set()],
    spatialA: set(),
    spatialB: set(),
  };
  const nodeCfg = (parity) => ({
    width, height, dims, traceSteps: 16, spatialPasses: 2, spatialSamples: 3, spatialRadius: 4,
    bvh,
    cache,
    reservoirs: {
      initial: reservoirs.initial,
      previous: reservoirs.temporal[1 - parity],
      temporal: reservoirs.temporal[parity],
      spatialA: reservoirs.spatialA,
      spatialB: reservoirs.spatialB,
    },
    gbuffer: { depth: gbuffers[parity].depth, normal: gbuffers[parity].normal },
    previousGbuffer: { depth: gbuffers[1 - parity].depth, normal: gbuffers[1 - parity].normal },
    rawTexture: raw,
    scratchTexture: scratch,
    historyTexture: outputs[1 - parity],
    outputTexture: outputs[parity],
  });
  const variants = [createRestirNodes(nodeCfg(0)), createRestirNodes(nodeCfg(1))];

  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
  camera.updateMatrixWorld(true);
  const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  const reservoirStats = (data) => {
    let n = 0, meanM = 0, meanW = 0, maxW = 0, meanLum = 0;
    for (let i = 0; i < count; i++) {
      const M = data[i * 16 + 3];
      if (M <= 0) continue;
      const W = data[i * 16 + 11];
      const lum = 0.2126 * data[i * 16 + 8] + 0.7152 * data[i * 16 + 9] + 0.0722 * data[i * 16 + 10];
      n++; meanM += M; meanW += W; meanLum += lum; maxW = Math.max(maxW, W);
    }
    if (n === 0) return { n, meanM: 0, meanW: 0, maxW: 0, meanLum: 0 };
    return { n, meanM: meanM / n, meanW: meanW / n, maxW, meanLum: meanLum / n };
  };

  let parity = 0;
  for (let frame = 0; frame < FRAMES; frame++) {
    const nodes = variants[parity];
    nodes.uniforms.projInv.value.copy(camera.projectionMatrixInverse);
    nodes.uniforms.cameraWorld.value.copy(camera.matrixWorld);
    camera.getWorldPosition(nodes.uniforms.cameraPosition.value);
    nodes.uniforms.prevViewProj.value.copy(viewProj);
    nodes.uniforms.historyValid.value = frame > 0 ? 1 : 0;
    nodes.uniforms.frame.value = frame;
    for (const pass of [nodes.candidateNode, nodes.temporalNode, nodes.spatialNodeA, nodes.spatialNodeB, nodes.resolveNode, nodes.atrousNode, nodes.denoiseNode]) {
      await renderer.computeAsync(pass);
    }
    if (frame === 1 || frame === FRAMES - 1) {
      const t = reservoirStats(new Float32Array(await renderer.getArrayBufferAsync(reservoirs.temporal[parity])));
      const s = reservoirStats(new Float32Array(await renderer.getArrayBufferAsync(reservoirs.spatialB)));
      console.log(`RESTIR_STATS frame=${frame} temporal{n=${t.n} M=${t.meanM.toFixed(2)} W=${t.meanW.toFixed(2)} maxW=${t.maxW.toFixed(2)} lum=${t.meanLum.toFixed(3)}} spatial{W=${s.meanW.toFixed(2)} maxW=${s.maxW.toFixed(2)}}`);
      if (frame === FRAMES - 1 && (t.n === 0 || !(t.maxW < W_LIMIT) || !(s.meanW < W_LIMIT))) {
        throw new Error(`reservoir weight diverged: temporal maxW=${t.maxW.toFixed(2)}, spatial meanW=${s.meanW.toFixed(2)} after ${FRAMES} frames (limit ${W_LIMIT})`);
      }
    }
    parity = 1 - parity;
  }
  result.textContent = "RESTIR_GPU_SMOKE_OK";
  console.log("RESTIR_GPU_SMOKE_OK");
  clearInterval(keepAlive);
  renderer.dispose();
} catch (error) {
  result.textContent = `RESTIR_GPU_SMOKE_ERROR: ${error?.stack ?? error}`;
  console.error("RESTIR_GPU_SMOKE_ERROR", error);
  clearInterval(keepAlive);
}
