// Runtime regression probe for the editor's emissive-scale drag path.
//
// Boots a real project scene, finds the first admitted analytic emitter, then
// drives the same entity.setTransform operation the gizmo uses for 90 frames.
// It reports rAF gaps and API-call cost plus the GI receipts that distinguish a
// live uniform/dynamic-layer update from a structural GI rebuild.
//
//   PROJECT=C:/path/to/project SCENE=Cornel \
//     node scripts/run-gi2-emitter-scale-motion.mjs http://127.0.0.1:5237/
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { installWebGpuErrorLog } from "./lib/webgpuErrorLog.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5237/";
const project = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const scene = process.env.SCENE ?? "Cornel";
const scenePath = scene.includes("/") || scene.includes("\\")
  ? scene.replaceAll("\\", "/")
  : `${project}/scenes/${scene}.scene`;
const frames = Math.max(30, Number(process.env.FRAMES) || 90);
const profile = mkdtempSync(join(tmpdir(), "gi-emitter-scale-"));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  userDataDir: profile,
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  await installWebGpuErrorLog(page);
  await page.evaluateOnNewDocument((root) => {
    globalThis.__gi2Rc5 = true;
    globalThis.__giConfigOverride = { emissiveShadows: true };
    globalThis.__editorKeepRendering = true;
    globalThis.__giLogEmitterLedger = false;
    globalThis.__giLogTrackArm = false;
    localStorage.setItem("engine.projectRoot.v1", root);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([root]));
  }, project);
  const events = [];
  const gpuErrors = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (/GPUValidationError|uncaptured.*GPU|Destroyed texture|Binding entry/i.test(text)) gpuErrors.push(text);
    if (/rebuild|soup|mobility: promoted/i.test(text)) events.push(text);
  });
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 60_000 });
  await page.evaluate((root) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === root) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, project);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180_000 });
  const opened = await page.evaluate(async (path) => {
    try { return await globalThis.__editorApi.call("scene.open", { path }); }
    catch (error) { return { error: String(error?.message ?? error) }; }
  }, scenePath);
  if (opened?.error) throw new Error(opened.error);
  await page.evaluate(async () => {
    const { engine } = await import("/src/editor/engineInstance.js");
    globalThis.__scaleProbeEngine = engine;
  });
  await page.waitForFunction(() => {
    const sys = globalThis.__scaleProbeEngine?.modules?.get?.("gi")?.system;
    return (sys?.state?.entries?.length ?? 0) > 0 && !!sys?.state?.screen?.gi2;
  }, { timeout: 180_000 });
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const result = await page.evaluate(async (frameCount) => {
    const engine = globalThis.__scaleProbeEngine;
    const sys = engine.modules.get("gi").system;
    const entry = (sys.state?.entries ?? []).find((e) => (e.peak ?? 0) >= 0.5 && e.mesh);
    if (!entry) return { error: "no analytic emitter entry" };
    let entityId = null;
    for (let o = entry.mesh; o && !entityId; o = o.parent) entityId = o.userData?.entityId ?? null;
    if (!entityId) return { error: `emitter ${entry.mesh.name} has no entity id` };
    const entity = await globalThis.__editorApi.call("entity.get", { id: entityId });
    const base = entity?.transform?.scale ?? [1, 1, 1];
    const gaps = [];
    const calls = [];
    const admissionAges = [];
    const starts = { rebuilds: sys._rebuildCount ?? 0, soupBuilds: sys.state.screen.gi2.snapshot?.().soupBuilds ?? 0 };
    let previous = performance.now();
    for (let i = 0; i < frameCount; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      gaps.push(now - previous);
      previous = now;
      const factor = 0.8 + 0.7 * (0.5 + 0.5 * Math.sin((i / Math.max(1, frameCount - 1)) * Math.PI * 4));
      const t0 = performance.now();
      await globalThis.__editorApi.call("entity.setTransform", {
        id: entityId,
        scale: base.map((v) => v * factor),
      });
      calls.push(performance.now() - t0);
      admissionAges.push(sys._emitterAdmissionAt ? performance.now() - sys._emitterAdmissionAt : -1);
    }
    const direct = sys.state.screen.gi2?.rc?.resolve?.direct;
    const directNames = direct?.passNames ?? ["raw", "filterH", "filterV"];
    direct?.passes?.forEach((pass, index) => {
      pass.__giPassName = `gi2.rc.direct.${directNames[index] ?? index}`;
    });
    const gpu = await globalThis.__editorApi.call("profile.giPasses", { samples: 4 })
      .catch((error) => ({ error: String(error?.message ?? error) }));
    const scaleCosts = Object.fromEntries(Object.entries(gpu?.gi2Ms ?? {})
      .filter(([name]) => /dynamic|rcDirect|direct/i.test(name)));
    await globalThis.__editorApi.call("entity.setTransform", { id: entityId, scale: base });
    const ends = { rebuilds: sys._rebuildCount ?? 0, soupBuilds: sys.state.screen.gi2.snapshot?.().soupBuilds ?? 0 };
    const summarize = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
      return { median: q(0.5), p95: q(0.95), max: q(1), over33: values.filter((v) => v > 33.4).length };
    };
    return {
      emitter: entry.mesh.name,
      frame: summarize(gaps),
      call: summarize(calls),
      maxAdmissionAge: Math.max(...admissionAges),
      starts,
      ends,
      lightTreeRefreshMs: sys._lightTreeRefreshCost ?? null,
      movers: sys._gi2Movers?.length ?? 0,
      scaleCosts,
      gpuProfile: {
        error: gpu?.error ?? null,
        totalMs: gpu?.gi2TotalMs ?? null,
        keys: Object.keys(gpu?.gi2Ms ?? {}).length,
        top: Object.entries(gpu?.gi2Ms ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 12),
      },
    };
  }, frames);
  console.log(JSON.stringify({ ...result, events: events.slice(0, 20), gpuErrors: gpuErrors.slice(0, 20), pageErrors: pageErrors.slice(0, 20) }, null, 2));
  const pass = !result.error && result.frame?.max < 33.4 && result.call?.max < 16.7
    && result.starts?.rebuilds === result.ends?.rebuilds
    && result.starts?.soupBuilds === result.ends?.soupBuilds
    && gpuErrors.length === 0;
  console.log(pass ? "GI-EMITTER-SCALE PASS" : "GI-EMITTER-SCALE FAIL");
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
