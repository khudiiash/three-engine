// Read-only reproduction of the Level GI report, using its original camera.
// Fresh Vite required: npx vite --port 5283 --strictPort
// EXTRA='{"__giIrrPassthrough":true}' ARM=passthrough allows independent boots.
// KEEP=1 leaves the frozen browser available through browser.json for diagnostics.
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5283/";
const project = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const scene = `${project}/scenes/Level.scene`;
const arm = process.env.ARM ?? "baseline";
const out = resolve(process.env.OUT ?? `.gi-shots/level-fidelity/${arm}`);
const extra = JSON.parse(process.env.EXTRA ?? "{}");
const pose = [4.181946996472286, 1.3137984705991546, -7.259309395367158, 1.726069306710172, 0.8981785729946429, 7.007398311508943];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });
const sceneHash = createHash("sha256").update(readFileSync(scene)).digest("hex");
const browser = process.env.ENDPOINT ? await puppeteer.connect({ browserWSEndpoint: process.env.ENDPOINT, protocolTimeout: 300000, defaultViewport: null }) : await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Users/Khudiiash/.cache/puppeteer/chrome/win64-147.0.7727.57/chrome-win64/chrome.exe",
  userDataDir: mkdtempSync(join(tmpdir(), "gi-level-fidelity-")),
  headless: "new",
  protocolTimeout: 300000,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = process.env.DUMP_ONLY === "1" ? (await browser.pages()).find((p) => p.url().startsWith(url)) : await browser.newPage();
const log = [], errors = [];
page.on("console", (m) => {
  const line = `[${m.type()}] ${m.text()}`;
  log.push(line);
  if (/\[gi\] (built|field ready|compile wave)|validation|exceeds.*limit|Fidelity/.test(line)) console.log(line.slice(0, 350));
  if (/validation|exceeds.*limit|GPUValidationError/i.test(line)) errors.push(line);
});
page.on("pageerror", (e) => { errors.push(String(e)); console.log(String(e).slice(0, 250)); });
if (process.env.DUMP_ONLY !== "1") {
await page.setViewport({ width: 1800, height: 1150, deviceScaleFactor: 1 });
if (process.env.LOOP_ALBEDO) {
  const ceiling = Number(process.env.LOOP_ALBEDO);
  if (!(ceiling > 0 && ceiling < 1)) throw new Error("LOOP_ALBEDO must be between zero and one");
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    if (!request.url().includes("/src/modules/gi/srcConfig.js")) return request.continue();
    try {
      const response = await fetch(request.url()), text = await response.text();
      const modified = text.replace(/export const MAX_LOOP_ALBEDO = 0\.9;/, `export const MAX_LOOP_ALBEDO = ${ceiling};`);
      if (modified === text) throw new Error("MAX_LOOP_ALBEDO interception did not match the source");
      console.log(`Fidelity intercepted MAX_LOOP_ALBEDO=${ceiling}`);
      await request.respond({ status: 200, contentType: "text/javascript", body: modified });
    } catch (error) { console.error(error); await request.abort(); }
  });
}
await installTauriShim(page, {});
await page.evaluateOnNewDocument((root, flags) => {
  localStorage.clear();
  localStorage.setItem("engine.projectRoot.v1", root);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([root]));
  globalThis.__editorKeepRendering = true;
  Object.assign(globalThis, flags);
}, project, extra);
}
writeFileSync(join(out, "browser.json"), JSON.stringify({ endpoint: browser.wsEndpoint(), pid: browser.process()?.pid, url, out }, null, 2));

try {
  let sceneInfo = null;
  if (process.env.DUMP_ONLY !== "1") {
  await page.goto(url, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 90000 });
  await page.click(".hub-recent-open-btn");
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
  console.log("Fidelity editor API ready");
  await page.evaluate(async (scenePath) => {
    const deadline = performance.now() + 180000;
    for (;;) {
      try { await globalThis.__editorApi.call("scene.open", { path: scenePath }); break; }
      catch (e) { if (performance.now() > deadline) throw e; await new Promise((r) => setTimeout(r, 500)); }
    }
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    globalThis.__fidelityEngine = await ensureEngine();
  }, scene);
  await page.waitForFunction(() => !!globalThis.__fidelityEngine?.modules.get("gi")?.system?.state?.screen?.srcProbes, { timeout: 180000 });
  console.log("Fidelity GI ready");
  sceneInfo = await page.evaluate(async (cameraPose) => {
    const engine = globalThis.__fidelityEngine;
    const lights = [];
    for (const entity of engine.entities.values()) {
      const light = entity.getComponent("light");
      if (light?.props.kind !== "directional") continue;
      const script = entity.getComponent("script");
      if (script) script.setProp("enabled", false);
      lights.push({ id: entity.id, rotation: entity.object3D?.rotation?.toArray(), props: light.props });
    }
    for (let i = 0; i < 3; i++) {
      await globalThis.__editorApi.call("viewport.setCamera", { position: cameraPose.slice(0, 3), target: cameraPose.slice(3) });
      engine.camera.fov = 60;
      engine.camera.updateProjectionMatrix();
      await new Promise((r) => setTimeout(r, 500));
    }
    return { lights, camera: engine.camera.position.toArray(), fov: engine.camera.fov };
  }, pose);
  console.log(`Fidelity settling (${process.env.SETTLE ?? 20000} ms)`);
  await wait(Number(process.env.SETTLE ?? 20000));
  await page.evaluate(() => globalThis.__fidelityEngine.stop());
  }
  if (process.env.ENV_ROT != null) {
    console.log(await page.evaluate(async (angle) => {
      const engine = globalThis.__fidelityEngine, renderer = engine.renderer;
      const system = engine.modules.get("gi").system, screen = system.state.screen, src = screen.srcProbes;
      const before = system._giEnvMissRotU.value;
      system._giEnvMissRotU.value = angle;
      const prior = renderer.backend.__giSyncCompute;
      renderer.backend.__giSyncCompute = true;
      try {
        for (const pass of src.passes) if (/^src:(merge|tiles|gather)/.test(pass.__giPassName ?? "")) await renderer.computeAsync(pass);
        await renderer.computeAsync(screen.resolve.compute);
        for (let i = 0; i < 80; i++) {
          await renderer.computeAsync(screen.irrTemporalPass.compute);
          await renderer.computeAsync(screen.irrHistoryPass.compute);
        }
        renderer.render(engine.scene, engine.camera);
      } finally { renderer.backend.__giSyncCompute = prior; }
      return { envRotationBefore: before, envRotationAfter: angle };
    }, Number(process.env.ENV_ROT)));
  }
  if (process.env.REBUILD_GATHER) {
    const rebuilt = await page.evaluate(async (mode) => {
      const engine = globalThis.__fidelityEngine, renderer = engine.renderer;
      const screen = engine.modules.get("gi").system.state.screen, src = screen.srcProbes;
      const { createSrcScreenGather } = await import(`/src/modules/gi/srcScreenGather.js?fidelity-fixed=${Date.now()}`);
      const { Fn, instanceIndex, ivec2, texture, uint, float, vec2, vec3, step, textureStore } = await import("/node_modules/three/build/three.tsl.js");
      const position = texture(screen.gbuffer.position), normal = texture(screen.gbuffer.normal);
      const width = src.gather.width, height = src.gather.height;
      const camera = vec3(...engine.camera.position.toArray());
      let coarse = null;
      if (mode !== "fine") {
        const { createSrcBlockLookupDirect } = await import("/src/modules/gi/srcProbes.js");
        const { octahedralUV } = await import("/src/modules/gi/srcOctahedral.js");
        const coarseTexture = renderer._bindings.getForCompute(src.gather.compute)
          .flatMap((group) => group.bindings).find((binding) => binding.texture?.name === "giSrcIrradianceTiles" && binding.texture !== src.tiles.atlas)?.texture;
        if (!coarseTexture) throw new Error("Original gather has no coarse atlas binding");
        const coarseNode = texture(coarseTexture), { interior, border, tileSize } = src.tiles;
        const perRow = coarseTexture.image.width / tileSize;
        coarse = { cascade: 1, lookup: createSrcBlockLookupDirect(src.store, 1), tiles: {
          sampleTileRGBA: (block, n) => {
            const b = uint(block).toVar(), uv = octahedralUV(vec3(n).normalize(), interior);
            return coarseNode.sample(vec2(
              float(b.mod(uint(perRow))).mul(tileSize).add(uv.u).add(border).div(coarseTexture.image.width),
              float(b.div(uint(perRow))).mul(tileSize).add(uv.v).add(border).div(coarseTexture.image.height),
            )).level(0);
          },
        } };
      }
      const priorNormalWeight = globalThis.__giGatherNormalWeight;
      if (mode === "no-plane") globalThis.__giGatherNormalWeight = false;
      const fine = createSrcScreenGather(src.store, src.tiles, {
        lookup: src.hashBlockFrame.lookup,
        spacing0: src.spacing0,
        camera,
        anchor: vec3(...src.anchor),
        coarse,
        width, height,
        readPixel: (i) => {
          const t = ivec2(i.mod(uint(width)).toInt(), i.div(uint(width)).toInt());
          const p = position.load(t).toVar(), n = normal.load(t).xyz.toVar();
          const facing = step(0, n.dot(camera.sub(p.xyz))).mul(2).sub(1);
          return { position: p.xyz, normal: n.mul(facing), valid: p.w.greaterThan(0.5).and(n.dot(n).greaterThan(0.25)) };
        },
      });
      globalThis.__giGatherNormalWeight = priorNormalWeight;
      for (const key of ["smoothWeights", "normalBias", "losStrength", "planeDepth"]) if (fine[key] && src.gather[key]) fine[key].value = src.gather[key].value;
      const fineTexture = texture(fine.target);
      const copy = Fn(() => {
        const c = ivec2(instanceIndex.mod(uint(width)).toInt(), instanceIndex.div(uint(width)).toInt());
        textureStore(src.gather.target, c, fineTexture.load(c));
      })().compute(width * height);
      const prior = renderer.backend.__giSyncCompute;
      renderer.backend.__giSyncCompute = true;
      try {
        await renderer.computeAsync(fine.reset);
        await renderer.computeAsync(fine.compute);
        await renderer.computeAsync(copy);
        await renderer.computeAsync(screen.resolve.compute);
        for (let i = 0; i < 80; i++) {
          await renderer.computeAsync(screen.irrTemporalPass.compute);
          await renderer.computeAsync(screen.irrHistoryPass.compute);
        }
        renderer.render(engine.scene, engine.camera);
      } finally { renderer.backend.__giSyncCompute = prior; }
      globalThis.__fidelityFineGather = fine;
      return { width, height, anchor: src.anchor, stats: await fine.readStats(renderer) };
    }, process.env.REBUILD_GATHER);
    console.log(`Fidelity paired fine-only gather ${JSON.stringify(rebuilt)}`);
  }
  const capture = async (captureOut) => {
  const out = captureOut;
  mkdirSync(out, { recursive: true });
  const rect = await page.evaluate(() => {
    const r = globalThis.__fidelityEngine.renderer.domElement.getBoundingClientRect();
    return { left: Math.round(r.x), top: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  if (process.env.DUMP_ONLY !== "1" || process.env.REBUILD_GATHER || process.env.ENV_ROT != null) {
    const shot = await page.screenshot(), size = await sharp(shot).metadata();
    if (rect.left + rect.width <= size.width && rect.top + rect.height <= size.height) await sharp(shot).extract(rect).toFile(join(out, "beauty.png"));
    else writeFileSync(join(out, "beauty-page.png"), shot);
  }
  const report = await page.evaluate(async (native) => {
    const engine = globalThis.__fidelityEngine, renderer = engine.renderer;
    const sys = engine.modules.get("gi").system;
    const targets = sys._giTargets, src = sys.state.screen.srcProbes;
    const TSL = await import("/node_modules/three/build/three.tsl.js");
    const { Fn, instanceIndex, instancedArray, ivec2, texture, uint } = TSL;
    const width = native ? src.gather.width : 640;
    const height = native ? src.gather.height : Math.round(width * renderer.domElement.height / renderer.domElement.width);
    const sources = { gathered: src.gather.target, raw: targets.irradianceRaw, filtered: targets.irradiance, position: sys.state.screen.gbuffer.position, normal: sys.state.screen.gbuffer.normal };
    const buffers = {}, nodes = {};
    for (const [name, tex] of Object.entries(sources)) if (tex) { buffers[name] = instancedArray(new Float32Array(width * height * 4), "vec4"); nodes[name] = texture(tex); }
    const copy = Fn(() => {
      const x = instanceIndex.mod(uint(width)).toFloat().add(0.5).div(width);
      const y = instanceIndex.div(uint(width)).toFloat().add(0.5).div(height);
      for (const [name, tex] of Object.entries(sources)) {
        if (!tex) continue;
        buffers[name].element(instanceIndex).assign(nodes[name].load(ivec2(x.mul(tex.image.width).toInt(), y.mul(tex.image.height).toInt())));
      }
    })().compute(width * height);
    // GI's async-pipeline wrapper skips a first dispatch while compilation is
    // pending. A frozen scene has no later frame to retry this diagnostic pass.
    const previousSync = renderer.backend.__giSyncCompute;
    renderer.backend.__giSyncCompute = true;
    try { await renderer.computeAsync(copy); }
    finally { renderer.backend.__giSyncCompute = previousSync; }
    const fields = {};
    for (const [name, buffer] of Object.entries(buffers)) fields[name] = new Float32Array(await renderer.getArrayBufferAsync(buffer.value));
    const luma = (field, i) => field[i] * 0.2126 + field[i + 1] * 0.7152 + field[i + 2] * 0.0722;
    const summarize = (field) => {
      const values = [], alpha = [], zones = {};
      for (let i = 0; i < field.length; i += 4) if (fields.position[i + 3] > 0.5) { values.push(luma(field, i)); alpha.push(field[i + 3]); }
      values.sort((a, b) => a - b);
      const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
      // Fixed normalized crops on the screenshot: upper-left wall, upper-right ceiling,
      // left room back wall, central column, and right doorway surround.
      for (const [name, box] of Object.entries({ leftWall: [0.02, 0.20, 0.33, 0.34], ceiling: [0.61, 0.03, 0.94, 0.32], backWall: [0.18, 0.51, 0.32, 0.68], column: [0.39, 0.34, 0.46, 0.85], doorway: [0.76, 0.44, 0.83, 0.71], grayWall: [.504, .335, .565, .583] })) {
        const v = [];
        for (let y = Math.floor(box[1] * height); y < box[3] * height; y++) for (let x = Math.floor(box[0] * width); x < box[2] * width; x++) {
          const i = (y * width + x) * 4;
          if (fields.position[i + 3] > 0.5) v.push(luma(field, i));
        }
        zones[name] = { mean: mean(v), samples: v.length };
      }
      return { count: values.length, mean: mean(values), p10: values[Math.floor(values.length * 0.1)], median: values[Math.floor(values.length * 0.5)], p90: values[Math.floor(values.length * 0.9)], meanAlpha: mean(alpha), zones };
    };
    const images = {}, stats = {};
    const linearToSRGB = (v) => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    for (const name of ["gathered", "raw", "filtered", "normal", "position"]) {
      if (!fields[name]) continue;
      const field = fields[name], canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d"), img = context.createImageData(width, height);
      for (let i = 0; i < field.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const value = name === "normal" ? field[i + c] * 0.5 + 0.5 : name === "position" ? (field[i + c] + 20) / 40 : linearToSRGB(field[i + c]);
          img.data[i + c] = Math.round(255 * Math.min(1, Math.max(0, value)));
        }
        img.data[i + 3] = 255;
      }
      context.putImageData(img, 0, 0);
      images[name] = canvas.toDataURL("image/png").split(",")[1];
      stats[name] = summarize(field);
    }
    const ratios = [];
    for (let i = 0; i < fields.raw.length; i += 4) {
      const raw = luma(fields.raw, i);
      if (fields.position[i + 3] > 0.5 && raw > 0.005) ratios.push(luma(fields.filtered, i) / raw);
    }
    ratios.sort((a, b) => a - b);
    const wallRows = [];
    for (let y = Math.floor(height * .335); y < height * .583; y++) {
      const xs = [], values = [];
      for (let x = Math.ceil(width * .504); x < width * .565; x++) {
        const i = (y * width + x) * 4;
        if (fields.position[i + 3] > .5) { xs.push(x); values.push(luma(fields.gathered, i)); }
      }
      const i = (y * width + Math.round(width * .54)) * 4;
      wallRows.push({ y, mean: values.reduce((a, b) => a + b, 0) / values.length, xs, values,
        centerLuma: luma(fields.gathered, i), centerPosition: Array.from(fields.position.slice(i, i + 4)),
        centerNormal: Array.from(fields.normal.slice(i, i + 4)) });
    }
    return { images, stats, wallRows, ratioFilteredToRaw: { count: ratios.length, median: ratios[Math.floor(ratios.length * 0.5)], p10: ratios[Math.floor(ratios.length * 0.1)], p90: ratios[Math.floor(ratios.length * 0.9)] }, src: await src.readStats(renderer), targetSize: sys._giTargetSize, width, height, screenKeys: Object.keys(sys.state.screen) };
  }, process.env.NATIVE === "1");
  if (process.env.HISTOGRAM === "1") {
    report.cornerHistogram = await page.evaluate(async () => {
      const engine = globalThis.__fidelityEngine, renderer = engine.renderer;
      const screen = engine.modules.get("gi").system.state.screen, src = screen.srcProbes;
      const { Fn, instanceIndex, instancedArray, texture, uint, ivec2, vec3, vec4, step, select } = await import("/node_modules/three/build/three.tsl.js");
      const width = 640, height = Math.round(width * src.gather.height / src.gather.width);
      const result = instancedArray(new Float32Array(width * height * 4), "vec4");
      const pos = texture(screen.gbuffer.position), nrm = texture(screen.gbuffer.normal), camera = vec3(...engine.camera.position.toArray());
      const compute = Fn(() => {
        const x = instanceIndex.mod(uint(width)).toFloat().add(.5).div(width), y = instanceIndex.div(uint(width)).toFloat().add(.5).div(height);
        const coord = ivec2(x.mul(src.gather.width).toInt(), y.mul(src.gather.height).toInt());
        const p = pos.load(coord).xyz.toVar(), normal = nrm.load(coord).xyz.toVar();
        const facing = step(0, normal.dot(camera.sub(p))).mul(2).sub(1);
        const g = src.gather.gatherAt(p, normal.mul(facing));
        result.element(instanceIndex).assign(vec4(g.corners.toFloat(), g.covered.toFloat(), g.coverage, select(g.known, 1, 0)));
      })().compute(width * height);
      const prior = renderer.backend.__giSyncCompute;
      renderer.backend.__giSyncCompute = true;
      try { await renderer.computeAsync(compute); }
      finally { renderer.backend.__giSyncCompute = prior; }
      const raw = new Float32Array(await renderer.getArrayBufferAsync(result.value));
      const all = {}, wall = {}, rows = [], coverage = [];
      for (let y = 0; y < height; y++) {
        let rowSum = 0, count = 0;
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4, value = raw[i + 1];
          all[value] = (all[value] ?? 0) + 1;
          if (x > width * .504 && x < width * .565 && y > height * .335 && y < height * .583) {
            wall[value] = (wall[value] ?? 0) + 1; rowSum += value; count++; coverage.push(raw[i + 2]);
          }
        }
        if (count) rows.push([y / height, rowSum / count]);
      }
      return { width, height, all, wall, wallRowCovered: rows, wallMeanConfidence: coverage.reduce((a, b) => a + b, 0) / coverage.length };
    });
  }
  for (const [name, data] of Object.entries(report.images)) writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
  delete report.images;
  const runtime = await page.evaluate(() => {
    const engine = globalThis.__fidelityEngine, camera = engine.camera, src = engine.modules.get("gi").system.state.screen.srcProbes;
    return { camera: camera.position.toArray(), rotation: camera.rotation.toArray(), fov: camera.fov, aspect: camera.aspect,
      canvas: [engine.renderer.domElement.width, engine.renderer.domElement.height], frame: engine.renderer.info.frame,
      reanchorCount: src.reanchorCount, anchor: src.anchor };
  });
  const final = { arm, extra, sceneHash, sceneInfo, runtime, errors, ...report };
  if (process.env.BAND_REFERENCE) {
    const reference = JSON.parse(readFileSync(resolve(process.env.BAND_REFERENCE), "utf8"));
    assert.equal(report.width, reference.width, "Band comparison requires identical readback width");
    assert.equal(report.height, reference.height, "Band comparison requires identical readback height");
    assert.deepEqual(report.stats.position, reference.stats.position, "Band comparison requires the same frozen G-buffer positions");
    assert.deepEqual(report.stats.normal, reference.stats.normal, "Band comparison requires the same frozen G-buffer normals");
    // Exclude the crop's upper edge: an adjoining surface can enter the ROI
    // there. The reported flat-wall artifact has interior boundaries at
    // normalized y≈.377 and y≈.552 (rows138 and202 at853×366).
    const strongest = (rows) => rows.slice(1).map((row, i) => ({ y: row.y,
      delta: Math.abs(row.mean - rows[i].mean) }))
      .filter((row) => row.y > report.height * .345)
      .reduce((a, b) => a.delta > b.delta ? a : b);
    const before = strongest(reference.wallRows), after = strongest(report.wallRows);
    const meanRatio = report.stats.gathered.zones.grayWall.mean / reference.stats.gathered.zones.grayWall.mean;
    final.bandRegression = { before, after, meanRatio, jumpReduction: 1 - after.delta / before.delta };
    assert(before.delta > .01, "Reference must contain the known gray-wall band artifact");
    assert(after.delta < before.delta * .1, "Gray-wall band jumps must fall by at least90%");
    assert(meanRatio > 1.1, "The fixed gather must restore at least10% gray-wall irradiance");
    console.log(`Fidelity band regression PASS ${JSON.stringify(final.bandRegression)}`);
  }
  writeFileSync(join(out, "report.json"), JSON.stringify(final, null, 2));
  console.log(JSON.stringify({ out, errors, stats: report.stats, ratio: report.ratioFilteredToRaw }));
  return { rect, report };
  };
  const { rect } = await capture(process.env.SWEEP === "1" ? join(out, "before") : out);
  if (process.env.SWEEP === "1") {
    const dwell = Number(process.env.SWEEP_DWELL ?? 3000);
    const settle = Number(process.env.SWEEP_SETTLE ?? 25000);
    const controlDuration = dwell * 6 + settle;
    const resumeWaitCapture = async (phase, duration) => {
      console.log(`Fidelity sweep phase ${phase}: ${duration} ms`);
      await page.evaluate(() => globalThis.__fidelityEngine.start());
      await wait(duration);
      await page.evaluate(() => globalThis.__fidelityEngine.stop());
      await capture(join(out, phase));
    };
    await resumeWaitCapture("static-before", controlDuration);
    const directions = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, .01], [0, -1, .01]];
    await page.evaluate(() => globalThis.__fidelityEngine.start());
    for (const direction of directions) {
      console.log(`Fidelity sweep direction ${direction}`);
      await page.evaluate(async ({ pose, direction }) => {
        await globalThis.__editorApi.call("viewport.setCamera", { position: pose.slice(0, 3), target: pose.slice(0, 3).map((v, i) => v + 10 * direction[i]) });
      }, { pose, direction });
      await wait(dwell);
    }
    await page.evaluate(async (pose) => {
      await globalThis.__editorApi.call("viewport.setCamera", { position: pose.slice(0, 3), target: pose.slice(3) });
      const camera = globalThis.__fidelityEngine.camera;
      camera.fov = 60;
      camera.updateProjectionMatrix();
    }, pose);
    await wait(Math.min(2000, settle));
    await page.evaluate(() => globalThis.__fidelityEngine.stop());
    await capture(join(out, "after-sweep-early"));
    await resumeWaitCapture("after-sweep", Math.max(0, settle - 2000));
    await resumeWaitCapture("static-after", controlDuration);
  }
  if (process.env.PT === "1") {
    await page.evaluate((bounces) => {
      const engine = globalThis.__fidelityEngine;
      const tracer = engine.modules.get("gi").system.pathTracer._tracer;
      if (bounces && tracer) {
        globalThis.__fidelityPriorBounces = tracer.bounces;
        const prior = engine.renderer.backend.__giSyncCompute;
        engine.renderer.backend.__giSyncCompute = true;
        try { tracer.bounces = bounces; tracer.reset(); }
        finally { engine.renderer.backend.__giSyncCompute = prior; }
      }
      const component = [...engine.entities.values()].map((e) => e.getComponent("global-illumination")).find((c) => c && c.props.enabled !== false);
      if (!component) throw new Error("No enabled GI component for path-tracer view");
      globalThis.__fidelityPTComponent = component;
      globalThis.__fidelityPriorDebug = component.props.debugView;
      component.setProp("debugView", "path-tracer");
      engine.start();
    }, Number(process.env.PT_BOUNCES ?? 0));
    let status = null;
    const deadline = Date.now() + 120000, samples = Number(process.env.PT_SAMPLES ?? 32);
    while (Date.now() < deadline) {
      await wait(2000);
      status = await page.evaluate(async () => {
        const engine = globalThis.__fidelityEngine, view = engine.modules.get("gi").system.pathTracer;
        const prior = engine.renderer.backend.__giSyncCompute;
        engine.renderer.backend.__giSyncCompute = true;
        let counts;
        try { counts = await view._tracer?.getSampleCountsAsync?.(); }
        finally { engine.renderer.backend.__giSyncCompute = prior; }
        return { wanted: view.wanted, active: view.active, failed: view._failed, error: view._lastError, samples: counts?.min ?? view._tracer?.samples ?? 0, counts };
      });
      console.log(`Fidelity PT ${JSON.stringify(status)}`);
      if (status.failed) throw new Error(`Path tracer failed: ${status.error}`);
      if (status.samples >= samples) break;
    }
    await page.evaluate(() => globalThis.__fidelityEngine.stop());
    await sharp(await page.screenshot()).extract(rect).toFile(join(out, "path-tracer.png"));
    writeFileSync(join(out, "path-tracer.json"), JSON.stringify(status, null, 2));
    await page.evaluate(() => globalThis.__fidelityPTComponent.setProp("debugView", globalThis.__fidelityPriorDebug));
  }
} finally {
  writeFileSync(join(out, "console.log"), log.join("\n"));
  if (process.env.KEEP === "1") { browser.disconnect(); browser.process()?.unref(); }
  else await browser.close();
}
process.exit(errors.length ? 1 : 0);
