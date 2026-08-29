// GI2 inside/outside GPU attribution.
//
// The work grids do not resize when the camera crosses a room boundary, but
// their expensive branches do: an outside view contains many invalid gbuffer
// pixels while an enclosed view can make nearly every thread shade/trace.
// This probe measures each pose from a fresh scene boot and names rcDirect's
// otherwise positional nine-pass emitter-shadow chain before calling
// profile.giPasses. The profiler re-dispatches stateful RC kernels, so sharing
// one GI state would make the second pose inherit synthetic work from the first.
//
//   node scripts/run-gi2-inside-cost.mjs http://localhost:5219/
//   SCENE=Cornel SAMPLES=12 node scripts/run-gi2-inside-cost.mjs ...
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5219/";
const project = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const scene = process.env.SCENE ?? "Cornel";
const scenePath = scene.includes("/") || scene.includes("\\")
  ? scene.replaceAll("\\", "/")
  : `${project}/scenes/${scene}.scene`;
const samples = Math.max(4, Number(process.env.SAMPLES ?? 12));
const renderSamples = Math.max(4, Number(process.env.RENDER_SAMPLES ?? Math.min(samples, 8)));
const settleMs = Math.max(250, Number(process.env.SETTLE_MS ?? 1500));
const probeRayCap = Number(process.env.PROBE_RAY_CAP);
const onlyInside = process.env.ONLY_INSIDE === "1";
const capSweep = String(process.env.CAP_SWEEP ?? "")
  .split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0);
const parsePose = (text, fallback) => {
  if (!text) return fallback;
  const [p, t] = text.split("|").map((v) => v.split(",").map(Number));
  return p?.length === 3 && t?.length === 3 && [...p, ...t].every(Number.isFinite)
    ? { position: p, target: t }
    : fallback;
};
const outside = parsePose(process.env.OUTSIDE, {
  position: [0.38, 2.6, 4.1], target: [0.38, 2.3, -1],
});
const inside = parsePose(process.env.INSIDE, {
  position: [0.38, 2.3, 1.6], target: [0.38, 2.1, -1],
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profileDir = await mkdtemp(path.join(tmpdir(), "gi2-inside-cost-"));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: profileDir,
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox",
    "--disable-dev-shm-usage", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

const measure = async (label, pose) => {
  const page = await browser.newPage();
  let firstLight = false;
  try {
    await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
    await installTauriShim(page, {});
    page.on("console", (message) => {
      const messageText = message.text();
      if (/\[gi2\] first light/.test(messageText)) firstLight = true;
      if (/WebGPU|GPUValidation|storage buffers|uncaptured/i.test(messageText)) {
        console.log(`  ${messageText.slice(0, 300)}`);
      }
    });
    await page.evaluateOnNewDocument(({ root, probeRayCap }) => {
      globalThis.__gi2Rc5 = true;
      globalThis.__editorKeepRendering = true;
      if (Number.isFinite(probeRayCap)) globalThis.__gi2ProbeRayCap = probeRayCap;
      localStorage.setItem("engine.projectRoot.v1", root);
      localStorage.setItem("engine.recentProjects.v1", JSON.stringify([root]));
    }, { root: project, probeRayCap });
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
    await page.evaluate((root) => {
      const rows = [...document.querySelectorAll(".hub-recent")];
      const row = rows.find((entry) => (entry.title ?? "").replaceAll("\\", "/") === root) ?? rows[0];
      row?.querySelector(".hub-recent-open-btn")?.click();
    }, project);
    await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
    const opened = await page.evaluate(async (file) => {
      try { return { ok: true, value: await globalThis.__editorApi.call("scene.open", { path: file }) }; }
      catch (error) { return { ok: false, error: error?.message ?? String(error) }; }
    }, scenePath);
    if (!opened.ok) throw new Error(`scene.open failed: ${opened.error}`);
    const deadline = Date.now() + 120000;
    while (!firstLight && Date.now() < deadline) await wait(250);
    if (!firstLight) throw new Error("GI2 first light did not arrive within 120 seconds");

    await page.evaluate(async ({ position, target }) => {
      const engine = (await import("/src/editor/engineInstance.js")).engine;
      const viewport = (await import("/src/editor/viewportHandle.js")).getViewportHandle();
      globalThis.__insideCostEngine = engine;
      globalThis.__insideCostViewport = viewport;
      viewport.camera.position.fromArray(position);
      if (viewport.orbit) {
        viewport.orbit.target.fromArray(target);
        viewport.orbit.update();
      } else viewport.camera.lookAt(...target);
      viewport.camera.updateMatrixWorld(true);
    }, pose);
    await wait(settleMs);
    return await page.evaluate(async ({ label, samples, renderSamples, capSweep }) => {
      const engine = globalThis.__insideCostEngine;
      const system = engine.modules?.get("gi")?.system;
      const gi2 = system?._gi2 ?? system?.state?.screen?.gi2;
      if (capSweep.length) {
        const rows = [];
        for (const cap of capSweep) {
          globalThis.__gi2ProbeRayCap = cap;
          await new Promise((resolve) => setTimeout(resolve, 500));
          const frame = await globalThis.__editorApi.call("profile.frameStats", { settleMs: 1100 });
          rows.push({ cap, frame, publishedCap: gi2?.describe?.().rc?.probeRayCap ?? null });
        }
        return {
          label,
          camera: globalThis.__insideCostViewport.camera.position.toArray(),
          capSweep: rows,
          resolve: [gi2?.gbuffer?.position?.image?.width, gi2?.gbuffer?.position?.image?.height],
        };
      }
      const direct = gi2?.rc?.resolve?.direct;
      const directNames = direct?.passNames ?? ["raw", "dilateH", "dilateV", "dilateHCoarse", "dilateVCoarse",
        "filterH", "filterV", "filterHCoarse", "filterVCoarse"];
      direct?.passes?.forEach((pass, index) => {
        pass.__giPassName = `gi2.rc.direct.${directNames[index] ?? index}`;
      });
      // Read the live frame first: giPasses deliberately redispatches stateful
      // kernels and therefore cannot be allowed to influence this aggregate.
      const frame = await globalThis.__editorApi.call("profile.frameStats", { settleMs: 1100 });
      const report = await globalThis.__editorApi.call("profile.giPasses", { samples });
      const raster = await globalThis.__editorApi.call("profile.renderPasses", {
        samples: renderSamples,
      });
      const gbuffer = gi2?.gbuffer;
      return {
        label,
        camera: globalThis.__insideCostViewport.camera.position.toArray(),
        frame,
        resolve: report.pixels?.resolve,
        gi2TotalMs: report.gi2TotalMs,
        gi2Ms: report.gi2Ms,
        raster,
        directPasses: direct?.passes?.length ?? 0,
        rc: gi2?.describe?.().rc ?? null,
        gbuffer: gbuffer ? [gbuffer.position?.image?.width, gbuffer.position?.image?.height] : null,
      };
    }, { label, samples, renderSamples, capSweep });
  } finally {
    await page.close();
  }
};

try {
  const out = onlyInside ? null : await measure("outside", outside);
  const inn = await measure("inside", inside);
  const sumWhere = (record, predicate) => Object.entries(record.gi2Ms ?? {})
    .filter(([name, ms]) => predicate(name) && typeof ms === "number")
    .reduce((sum, [, ms]) => sum + ms, 0);
  const groups = (record) => ({
    direct: +sumWhere(record, (name) => name.startsWith("gi2.rc.direct.")).toFixed(3),
    ao: +sumWhere(record, (name) => /ao/i.test(name)).toFixed(3),
    probePlacement: +sumWhere(record, (name) => /probePlace|place/i.test(name)).toFixed(3),
    population: +sumWhere(record, (name) => /\.populate#/.test(name)).toFixed(3),
    rays: +sumWhere(record, (name) => /\.rays#/.test(name)).toFixed(3),
    deposit: +sumWhere(record, (name) => /\.deposit#/.test(name)).toFixed(3),
    hit: +sumWhere(record, (name) => /\.hit#/.test(name)).toFixed(3),
    merge: +sumWhere(record, (name) => /\.merge#/.test(name)).toFixed(3),
    resolve: +sumWhere(record, (name) => /\.resolve#/.test(name)).toFixed(3),
  });
  const top = (record) => Object.entries(record.gi2Ms ?? {})
    .filter(([, ms]) => typeof ms === "number")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([pass, ms]) => ({ pass, ms }));
  const result = {
    scene: scenePath, samples, renderSamples,
    probeRayCap: Number.isFinite(probeRayCap) ? probeRayCap : "tier",
    outside: out ? { ...out, groups: groups(out), top: top(out) } : null,
    inside: { ...inn, groups: groups(inn), top: top(inn) },
  };
  if (out) result.delta = {
    totalMs: +(inn.gi2TotalMs - out.gi2TotalMs).toFixed(3),
    directMs: +(result.inside.groups.direct - result.outside.groups.direct).toFixed(3),
    aoMs: +(result.inside.groups.ao - result.outside.groups.ao).toFixed(3),
    probePlacementMs: +(result.inside.groups.probePlacement - result.outside.groups.probePlacement).toFixed(3),
    populationMs: +(result.inside.groups.population - result.outside.groups.population).toFixed(3),
    raysMs: +(result.inside.groups.rays - result.outside.groups.rays).toFixed(3),
    depositMs: +(result.inside.groups.deposit - result.outside.groups.deposit).toFixed(3),
    hitMs: +(result.inside.groups.hit - result.outside.groups.hit).toFixed(3),
    mergeMs: +(result.inside.groups.merge - result.outside.groups.merge).toFixed(3),
    resolveMs: +(result.inside.groups.resolve - result.outside.groups.resolve).toFixed(3),
    liveGpuMs: +((inn.frame?.gpuMs ?? 0) - (out.frame?.gpuMs ?? 0)).toFixed(3),
    liveCpuMs: +((inn.frame?.cpuMs ?? 0) - (out.frame?.cpuMs ?? 0)).toFixed(3),
    liveFps: (inn.frame?.fps ?? 0) - (out.frame?.fps ?? 0),
    sceneDrawMs: +((inn.raster?.sceneDrawMs ?? 0) - (out.raster?.sceneDrawMs ?? 0)).toFixed(3),
    rasterFrameMs: +((inn.raster?.frameTotalMs ?? 0) - (out.raster?.frameTotalMs ?? 0)).toFixed(3),
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await rm(profileDir, { recursive: true, force: true });
}
