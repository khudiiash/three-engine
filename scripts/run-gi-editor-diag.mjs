import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:5199/";
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPU",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const messages = [];
page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", (error) => messages.push(`pageerror: ${error.stack ?? error.message}`));
await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  const target = [...document.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("Skip the project"));
  target?.click();
});
await new Promise((resolve) => setTimeout(resolve, 5000));
await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__rcPrograms = [];
  const backend = engine.renderer.backend;
  const createProgram = backend.createProgram.bind(backend);
  backend.createProgram = (program) => {
    if (program.code?.includes("rcTraceSDFInterval") || program.code?.includes("rcMergeIntervals")) {
      globalThis.__rcPrograms.push({ name: program.name, stage: program.stage, code: program.code });
    }
    return createProgram(program);
  };
  await enableEngineModule(engine, "gi");
  engine.camera.position.set(0, 3, 9);
  engine.camera.lookAt(0, 2.5, 0);
  engine.camera.updateMatrixWorld(true);
  const material = (color) => new THREE.MeshStandardNodeMaterial({
    color,
    roughness: 0.9,
    metalness: 0,
  });
  const addBox = (size, position, color = 0xb8c3cf) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
    mesh.position.set(...position);
    engine.scene.add(mesh);
    return mesh;
  };
  addBox([10, 0.2, 10], [0, -0.1, 0]);
  addBox([10, 0.2, 10], [0, 6.1, 0]);
  addBox([10, 6, 0.2], [0, 3, -5]);
  addBox([0.2, 6, 10], [-5, 3, 0], 0x9f2418);
  addBox([0.2, 6, 10], [5, 3, 0], 0x3a9f24);
  addBox([2.3, 3.5, 2.3], [-1.8, 1.75, -1.4]);
  addBox([2.3, 2.1, 2.3], [1.6, 1.05, 0.8]);
  const panelMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 8,
    roughness: 1,
  });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 2.2), panelMaterial);
  panel.position.set(0, 5.92, 0);
  engine.scene.add(panel);
  const lamp = engine.createEntity({ name: "Editor GI diagnostic lamp" });
  lamp.addComponent("light", {
    kind: "point",
    color: "#ffb070",
    intensity: 0,
    distance: 14,
    castShadow: false,
  });
  lamp.object3D.position.set(0, 4.8, 1);
  const gi = engine.createEntity({ name: "Editor GI diagnostic" });
  gi.addComponent("global-illumination", {
    quality: "custom",
    voxelRes: 48,
    cascadeCount: 3,
    c0Spacing: 0.75,
    c0Directions: 24,
    intervalScale: 0.75,
    debugView: "gi-only",
  });
});
await new Promise((resolve) => setTimeout(resolve, 30000));
const motionMaxFrameMs = await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  return new Promise((resolve) => {
    let previous = performance.now();
    let maximum = 0;
    let frames = 0;
    engine.camera.position.x += 3;
    engine.camera.lookAt(0, 2.5, 0);
    engine.camera.updateMatrixWorld(true);
    const tick = (now) => {
      maximum = Math.max(maximum, now - previous);
      previous = now;
      if (++frames < 180) requestAnimationFrame(tick);
      else resolve(maximum);
    };
    requestAnimationFrame(tick);
  });
});
const state = await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const giHandle = engine.modules?.get?.("gi");
  const system = giHandle?.system ?? null;
  const copy2D = (target, width, height) => engine.renderer.backend.copyTextureToBuffer(
    target,
    0,
    0,
    width,
    height,
    0,
  );
  const halfToFloat = (value) => {
    const sign = (value & 0x8000) ? -1 : 1;
    const exponent = (value >> 10) & 0x1f;
    const fraction = value & 0x03ff;
    if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
    if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
  };
  const scalar = (data, index) => data instanceof Uint16Array
    ? halfToFloat(data[index])
    : data[index];
  const rowStridePixels = (data, width) => {
    const bytesPerPixel = data instanceof Uint16Array ? 8 : 16;
    return Math.ceil((width * bytesPerPixel) / 256) * (256 / bytesPerPixel);
  };
  const pixelOffset = (data, width, x, y) =>
    (y * rowStridePixels(data, width) + x) * 4;
  const summarize = (data, width, height) => {
    let nonzero = 0;
    let rgb = 0;
    let alpha = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = pixelOffset(data, width, x, y);
        if (data[index] || data[index + 1] || data[index + 2] || data[index + 3]) nonzero++;
        if (data[index] || data[index + 1] || data[index + 2]) rgb++;
        if (data[index + 3]) alpha++;
      }
    }
    return { type: data.constructor.name, length: data.length, nonzero, rgb, alpha };
  };
  const percentile = (values, fraction) => {
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
  };
  const luminance = (data, width, x, y) => {
    const offset = pixelOffset(data, width, x, y);
    return scalar(data, offset) * 0.2126 +
      scalar(data, offset + 1) * 0.7152 +
      scalar(data, offset + 2) * 0.0722;
  };
  const floorStageStats = (
    data,
    stageWidth,
    stageHeight,
    geometryWidth,
    geometryHeight,
    normals,
  ) => {
    const isFloor = (x, y) => {
      const receiverX = Math.min(geometryWidth - 1, x * 2 + 1);
      const receiverY = Math.min(geometryHeight - 1, y * 2 + 1);
      const ny = scalar(normals, pixelOffset(normals, geometryWidth, receiverX, receiverY) + 1) * 2 - 1;
      return ny > 0.95;
    };
    const values = [];
    const deltas = [];
    for (let y = 0; y < stageHeight; y++) {
      for (let x = 0; x < stageWidth; x++) {
        if (!isFloor(x, y)) continue;
        const value = luminance(data, stageWidth, x, y);
        if (!Number.isFinite(value)) continue;
        values.push(value);
        if (x + 1 < stageWidth && isFloor(x + 1, y)) {
          deltas.push(Math.abs(value - luminance(data, stageWidth, x + 1, y)));
        }
        if (y + 1 < stageHeight && isFloor(x, y + 1)) {
          deltas.push(Math.abs(value - luminance(data, stageWidth, x, y + 1)));
        }
      }
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const meanDelta = deltas.reduce((sum, value) => sum + value, 0) /
      Math.max(1, deltas.length);
    return {
      floorTexels: values.length,
      mean: Number(mean.toFixed(6)),
      p95: Number(percentile(values, 0.95).toFixed(6)),
      neighborMeanDelta: Number(meanDelta.toFixed(6)),
      neighborP95Delta: Number(percentile(deltas, 0.95).toFixed(6)),
      normalizedNeighborDelta: Number((meanDelta / Math.max(mean, 1e-6)).toFixed(4)),
    };
  };
  const screenFloorStats = (data, width, height, positions, normals) => {
    const isFloor = (x, y) => {
      const offset = pixelOffset(positions, width, x, y);
      const valid = scalar(positions, offset + 3) > 0.5;
      const ny = scalar(normals, offset + 1) * 2 - 1;
      return valid && ny > 0.95;
    };
    const values = [];
    const deltas = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!isFloor(x, y)) continue;
        const value = luminance(data, width, x, y);
        if (!Number.isFinite(value)) continue;
        values.push(value);
        if (x + 1 < width && isFloor(x + 1, y)) {
          deltas.push(Math.abs(value - luminance(data, width, x + 1, y)));
        }
        if (y + 1 < height && isFloor(x, y + 1)) {
          deltas.push(Math.abs(value - luminance(data, width, x, y + 1)));
        }
      }
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const meanDelta = deltas.reduce((sum, value) => sum + value, 0) /
      Math.max(1, deltas.length);
    return {
      floorTexels: values.length,
      mean: Number(mean.toFixed(6)),
      p95: Number(percentile(values, 0.95).toFixed(6)),
      neighborMeanDelta: Number(meanDelta.toFixed(6)),
      neighborP95Delta: Number(percentile(deltas, 0.95).toFixed(6)),
      normalizedNeighborDelta: Number((meanDelta / Math.max(mean, 1e-6)).toFixed(4)),
    };
  };
  const gatherFloorStats = ({
    irradiance,
    probeWidth,
    probeHeight,
    sideWidth,
    sideHeight,
    worldPositions,
    normals,
    width,
    height,
  }) => {
    const values = [];
    const deltas = [];
    const sampled = new Float64Array(width * height);
    const valid = new Uint8Array(width * height);
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const screenOffset = pixelOffset(worldPositions, width, x, y);
        const packedNormalOffset = pixelOffset(normals, width, x, y);
        if (scalar(worldPositions, screenOffset + 3) <= 0.5) continue;
        const N = [
          scalar(normals, packedNormalOffset) * 2 - 1,
          scalar(normals, packedNormalOffset + 1) * 2 - 1,
          scalar(normals, packedNormalOffset + 2) * 2 - 1,
        ];
        const nLength = Math.hypot(...N) || 1;
        N[0] /= nLength;
        N[1] /= nLength;
        N[2] /= nLength;
        if (N[1] <= 0.95) continue;
        const P = [
          scalar(worldPositions, screenOffset),
          scalar(worldPositions, screenOffset + 1),
          scalar(worldPositions, screenOffset + 2),
        ];
        const probePositionX = (((x + 0.5) / width) * sideWidth - 1.5) / 2;
        const probePositionY = (((y + 0.5) / height) * sideHeight - 1.5) / 2;
        const baseX = Math.floor(probePositionX);
        const baseY = Math.floor(probePositionY);
        const fractionX = probePositionX - baseX;
        const fractionY = probePositionY - baseY;
        let sum = 0;
        for (let oy = 0; oy <= 1; oy++) {
          for (let ox = 0; ox <= 1; ox++) {
            const probeX = Math.max(0, Math.min(probeWidth - 1, baseX + ox));
            const probeY = Math.max(0, Math.min(probeHeight - 1, baseY + oy));
            const bilinear = (ox ? fractionX : 1 - fractionX) *
              (oy ? fractionY : 1 - fractionY);
            sum += luminance(irradiance, probeWidth, probeX, probeY) * bilinear;
          }
        }
        const value = sum;
        const index = y * width + x;
        sampled[index] = value;
        valid[index] = 1;
        values.push(value);
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (!valid[index]) continue;
        if (x + 1 < width && valid[index + 1]) {
          deltas.push(Math.abs(sampled[index] - sampled[index + 1]));
        }
        if (y + 1 < height && valid[index + width]) {
          deltas.push(Math.abs(sampled[index] - sampled[index + width]));
        }
      }
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const meanDelta = deltas.reduce((sum, value) => sum + value, 0) /
      Math.max(1, deltas.length);
    return {
      floorTexels: values.length,
      mean: Number(mean.toFixed(6)),
      p95: Number(percentile(values, 0.95).toFixed(6)),
      neighborMeanDelta: Number(meanDelta.toFixed(6)),
      neighborP95Delta: Number(percentile(deltas, 0.95).toFixed(6)),
      normalizedNeighborDelta: Number((meanDelta / Math.max(mean, 1e-6)).toFixed(4)),
    };
  };
  let readback = null;
  if (system?._deferred && system?._radianceCascades) {
    const deferred = system._deferred;
    const rc = system._radianceCascades;
    const probeWidth = rc.sideWidth / 2;
    const probeHeight = rc.sideHeight / 2;
    const [
      normals,
      worldPositions,
      interval0,
      merged0,
      irradianceRaw,
      irradianceA,
      irradianceB,
      raw,
      resolved,
    ] = await Promise.all([
      copy2D(deferred.gbuffer.texture, deferred.width, deferred.height),
      copy2D(deferred.resources.worldPositionTexture, deferred.width, deferred.height),
      copy2D(rc.cascades[0].intervalTexture, rc.atlasWidth, rc.atlasHeight),
      copy2D(rc.cascades[0].mergedTexture, rc.atlasWidth, rc.atlasHeight),
      copy2D(rc.irradianceTexture, probeWidth, probeHeight),
      copy2D(rc.filteredIrradianceA, probeWidth, probeHeight),
      copy2D(rc.filteredIrradianceB, probeWidth, probeHeight),
      copy2D(deferred.rawTexture, deferred.width, deferred.height),
      copy2D(deferred.giTexture, deferred.width, deferred.height),
    ]);
    readback = {
      normals: summarize(normals, deferred.width, deferred.height),
      worldPositions: summarize(worldPositions, deferred.width, deferred.height),
      interval0: summarize(interval0, rc.atlasWidth, rc.atlasHeight),
      merged0: summarize(merged0, rc.atlasWidth, rc.atlasHeight),
      irradianceRaw: summarize(irradianceRaw, probeWidth, probeHeight),
      irradianceA: summarize(irradianceA, probeWidth, probeHeight),
      irradianceB: summarize(irradianceB, probeWidth, probeHeight),
      raw: summarize(raw, deferred.width, deferred.height),
      resolved: summarize(resolved, deferred.width, deferred.height),
      floorStages: {
        irradianceRaw: floorStageStats(
          irradianceRaw,
          probeWidth,
          probeHeight,
          rc.sideWidth,
          rc.sideHeight,
          normals,
        ),
        irradianceA: floorStageStats(
          irradianceA,
          probeWidth,
          probeHeight,
          rc.sideWidth,
          rc.sideHeight,
          normals,
        ),
        irradianceB: floorStageStats(
          irradianceB,
          probeWidth,
          probeHeight,
          rc.sideWidth,
          rc.sideHeight,
          normals,
        ),
        rawGather: screenFloorStats(
          raw,
          deferred.width,
          deferred.height,
          worldPositions,
          normals,
        ),
        resolved: screenFloorStats(
          resolved,
          deferred.width,
          deferred.height,
          worldPositions,
          normals,
        ),
        reconstructedBilinear: gatherFloorStats({
          irradiance: irradianceB,
          probeWidth,
          probeHeight,
          sideWidth: rc.sideWidth,
          sideHeight: rc.sideHeight,
          worldPositions,
          normals,
          width: deferred.width,
          height: deferred.height,
        }),
      },
    };
  }
  return {
    rendererReady: engine.rendererReady,
    backend: engine.renderer?.backend?.isWebGPUBackend ? "WebGPU" : "other",
    loopActive: engine.loopActive,
    camera: engine.camera?.type ?? null,
    modules: [...(engine.modules?.keys?.() ?? [])],
    preRenderCallbacks: engine.preRenderCallbacks?.size ?? null,
    rcPrograms: (globalThis.__rcPrograms ?? []).map((program) => ({
      name: program.name,
      stage: program.stage,
      traceOccurrences: (program.code.match(/rcTraceSDFInterval/g) ?? []).length,
      mergeOccurrences: (program.code.match(/rcMergeIntervals/g) ?? []).length,
      mainTail: program.code.slice(program.code.lastIndexOf("fn main")),
    })),
    gi: system ? {
      component: !!system.component,
      volumes: system.volumes?.length ?? 0,
      deferred: system._deferred
        ? `${system._deferred.width}x${system._deferred.height}`
        : null,
      deferredReady: system._deferredReady?.value ?? null,
      rcCount: system._radianceCascades?.cascades?.length ?? 0,
      rcRevision: system._rcRevision,
      rcComputedRevision: system._rcComputedRevision,
      warmup: system.volumes?.map?.((volume) => volume.warmupQueue.length) ?? [],
      radiance: system.volumes?.map?.((volume) => volume.hasRadiance) ?? [],
      readback,
    } : null,
  };
});
state.motionMaxFrameMs = motionMaxFrameMs;
await page.screenshot({ path: "scripts/gi-editor-diag.png" });
console.log(JSON.stringify(state, null, 2));
for (const message of messages) console.log(message);
await browser.close();
