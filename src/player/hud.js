// The player's on-device readout — `?hud=1` on a build's URL.
//
// A phone cannot be reached by `scripts/run-player-fps.mjs`, and "20 fps on
// my iPhone" carries no breakdown: nothing said whether the frame was CPU or
// GPU, raster or GI, or which pass. This overlay prints the same numbers the
// harness reads — the stats readout, the GI world cadence and resolve size,
// and the per-pass GPU ledger where the adapter has timestamp queries — once
// a second, in a corner. Tap it to copy the whole block to the clipboard so
// it can be pasted into a report.
//
// Reading it:
//  · `cb` is the host's callback rate. fps 30 with cb 60 is a frame paced
//    from inside the app; fps 30 with cb 30 is the display or the browser
//    (iOS Safari halves requestAnimationFrame when frames overrun).
//  · `cpu` is the engine's own main-thread work; a frame far above it is
//    waiting on the GPU (or the compositor).
//  · `gpu` is the on-GPU frame from timestamp queries — 0 where the adapter
//    has none (Safari), and then the ledger rows are absent too.
//  · `world` is the GI transport's cadence; every world dispatch is ~70
//    kernels landing in ONE frame, which is why a phone can read 55 fps
//    while the chain's pipelines compile and settle lower once it runs.
import { createPassLedger } from "../engine/passLedger.js";

const ROWS = 10;

export function createPlayerHud(engine, { rows = ROWS } = {}) {
  const el = document.createElement("pre");
  el.id = "player-hud";
  Object.assign(el.style, {
    position: "fixed",
    top: "env(safe-area-inset-top, 0px)",
    left: "0",
    margin: "0",
    padding: "6px 8px",
    font: "11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    color: "#d8e0d8",
    background: "rgba(0, 0, 0, 0.62)",
    zIndex: "2147483000",
    pointerEvents: "auto",
    whiteSpace: "pre",
    maxWidth: "96vw",
    overflow: "hidden",
    borderBottomRightRadius: "6px",
  });
  document.body.appendChild(el);
  const ledger = createPassLedger(engine, { windowMs: 2000 });
  let copiedAt = 0;
  // Every 2 s: a 64×64 readback of the irradiance target (what the diffuse
  // term reads) and the glossy target (what the reflection term reads), so a
  // phone can say what its GI holds — the desktop's `profile.giGlossyStats`.
  const stats = { text: "", busy: false };
  const sampleTargets = async () => {
    if (stats.busy) return;
    const gi = engine.modules?.get?.("gi")?.system;
    const sc = gi?.state?.screen;
    const irr = sc?.targets?.irradiance;
    const glo = sc?.srcProbes?.glossy?.target;
    if (!irr || !engine.renderer) return;
    stats.busy = true;
    try {
      const { readTexturePixelsGPU } = await import("../modules/gi/giScreen.js");
      const summarize = async (tex) => {
        const px = await readTexturePixelsGPU(engine.renderer, tex, 64);
        if (!px?.length) return null;
        const lum = [];
        for (let i = 0; i < px.length; i += 4) if (px[i + 3] !== 0) lum.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
        if (!lum.length) return null;
        lum.sort((a, b) => a - b);
        const q = (f) => lum[Math.min(lum.length - 1, Math.floor(f * lum.length))];
        return `mean ${(lum.reduce((t, v) => t + v, 0) / lum.length).toFixed(1)} p50 ${q(0.5).toFixed(0)} p95 ${q(0.95).toFixed(0)} max ${lum[lum.length - 1].toFixed(0)}`;
      };
      const a = await summarize(irr);
      const b = glo ? await summarize(glo) : null;
      // The reflection-probe atlas — what a metal's reflection term reads
      // inside a probe box. A traced capture whose sun shadows fail holds a
      // sunlit-through-walls world, which reads as glowing trims on the
      // phone while the diffuse targets above look normal.
      const atlas = gi?._reflProbeGpu?.atlas ?? null;
      const c = atlas ? await summarize(atlas) : null;
      const nProbes = (gi?._reflProbes?.size ?? 0) + (gi?._autoReflProbes?.length ?? 0);
      const recs = [...(gi?._reflProbes?.values?.() ?? []), ...(gi?._autoReflProbes ?? [])].slice(0, 3)
        .map((rec) => `r${rec.rounds ?? 0}${rec.dirty ? "d" : ""}@${rec.capturedAt >= 0 ? `f-${Math.max(0, (gi?._frame ?? 0) - rec.capturedAt)}` : "never"}`).join(" ");
      stats.text = `irradiance(8-bit) ${a ?? "-"}  |  glossy ${b ?? "-"}\nprobes ${nProbes} (${sc?.reflProbes ? "armed" : "unarmed"}${globalThis.__giReflectionProbes === false ? ", pinned off" : ""}${globalThis.__giProbeShadows === false ? ", no shadows" : ""}) ${recs}  atlas(8-bit) ${c ?? "-"}`;
    } catch (e) {
      stats.text = `readback failed: ${e?.message ?? e}`;
    } finally {
      stats.busy = false;
    }
  };
  const statsTimer = setInterval(sampleTargets, 2000);
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
  const render = () => {
    const r = engine.stats.readout;
    const gi = engine.modules?.get?.("gi")?.system ?? null;
    const sc = gi?.state?.screen ?? null;
    const canvas = engine.renderer?.domElement;
    const perf = engine.settings?.performance ?? {};
    const lines = [];
    lines.push(`fps ${fmt(r.fps, 0)}  cb ${fmt(r.callbackFps, 0)}  frame ${fmt(r.frameMs)} ms  cpu ${fmt(r.workMs)}  gpu ${fmt(r.gpuMs)}` +
      (r.gpuRenderMs > 0 || r.gpuComputeMs > 0 ? ` (r ${fmt(r.gpuRenderMs)} c ${fmt(r.gpuComputeMs)})` : ""));
    lines.push(`canvas ${canvas?.width ?? "?"}x${canvas?.height ?? "?"} @${fmt(devicePixelRatio, 2)}  scale ${fmt(r.renderScale, 2)}` +
      `  drs ${perf.dynamicResolution ? `on/${perf.targetFps ?? 60}` : "off"}  quality ${engine.config?.quality ?? "as authored"}  draws ${r.drawCalls}`);
    // Which backend three fell to, and the adapter: iOS Chrome and Safari
    // share WebKit but not necessarily WebGPU — a WebGL fallback runs the
    // raster frame with no GI compute at all, and reads as "twice the fps".
    const be = engine.renderer?.backend;
    const info = be?.adapter?.info;
    const ua = navigator.userAgent;
    const browser = /CriOS\/(\d+)/.exec(ua) ? `chrome-ios ${/CriOS\/(\d+)/.exec(ua)[1]}` : /FxiOS/.test(ua) ? "firefox-ios" : /Safari\//.test(ua) && /iPhone|iPad/.test(ua) ? "safari-ios" : /Chrome\/(\d+)/.exec(ua) ? `chrome ${/Chrome\/(\d+)/.exec(ua)[1]}` : "other";
    lines.push(`backend ${be?.isWebGPUBackend ? "webgpu" : be?.isWebGLBackend ? "WEBGL (no compute, no GI)" : "?"}  adapter ${info ? `${info.vendor || "?"}/${info.architecture || "?"}` : "-"}  ` +
      `f16 ${be?.device?.features?.has?.("shader-f16") ? "y" : "n"}  ts ${be?.device?.features?.has?.("timestamp-query") ? "y" : "n"}  ${browser}  rAF ${fmt(engine.stats?.readout?.callbackFps ?? r.cb ?? NaN, 0)}`);
    if (gi) {
      const cfg = gi.config ?? {};
      lines.push(`gi ${cfg.quality ?? "?"}${cfg.qualityClampedFrom ? ` (from ${cfg.qualityClampedFrom})` : ""}  resolve ${sc?.width ?? "?"}x${sc?.height ?? "?"}` +
        `  emitter ${sc?.emitterShadowWidth ?? "-"}x${sc?.emitterShadowHeight ?? "-"}  world ${fmt(gi._srcWorldHzLive, 1)} Hz${gi._srcWorldRested ? " rested" : ""}` +
        `${gi._srcWorldSplitOn ? " split" : ""}  chains ${gi._srcWorldChains ?? 0}  movers ${gi._dynSet?.count?.() ?? "-"}`);
    }
    const cam = engine.camera;
    if (cam) {
      const wp = cam.getWorldPosition(new (cam.position.constructor)());
      const wd = cam.getWorldDirection(new (cam.position.constructor)());
      lines.push(`camera ${wp.x.toFixed(2)} ${wp.y.toFixed(2)} ${wp.z.toFixed(2)}  dir ${wd.x.toFixed(2)} ${wd.y.toFixed(2)} ${wd.z.toFixed(2)}  fov ${cam.fov ?? "-"}`);
    }
    // Shadow casters and their update flags: the stride (every Nth frame on a
    // portable device) shows as autoUpdate off, needsUpdate flipping.
    if (engine.scene) {
      const casters = [];
      engine.scene.traverse((o) => { if (o.castShadow === true && o.shadow?.camera) casters.push(o); });
      const f = engine.shadowFreeze;
      lines.push(`shadows ${casters.length} casters  stride ${f?.updateStride ?? "-"} due ${f?.updateStrideDue ?? "-"}  managed ${f?.managedLights ?? "-"}  ` +
        casters.slice(0, 4).map((o) => `${o.isLight ? "L" : "c"}${o.shadow.shadowNode ? "N" : ""}:${o.shadow.autoUpdate ? "a" : "-"}${o.shadow.needsUpdate ? "n" : "-"}`).join(" "));
      // The environment seam: GI blacks out three's per-material IBL via
      // `scene.environmentNode` once the field is live — if that node is
      // missing while an environment map is set, every metal reflects the
      // HDRI (and its sun) unoccluded, which reads as glowing trims.
      const sc2 = engine.scene, sys = gi;
      lines.push(`env map ${sc2.environment ? (sc2.environment.mapping ?? "set") : "none"}  node ${sc2.environmentNode ? (sys?._envIblBlack && sc2.environmentNode === sys._envIblBlack ? "black" : "other") : "NONE"}  ` +
        `int ${sc2.environmentIntensity ?? "-"}  latched ${sys?._envIblLatched ?? "-"}  ready ${sys?._fieldReadyOnce ?? "-"}  keep ${globalThis.__giKeepIBL ?? "-"}  bg ${sc2.background ? "set" : "none"}`);
    }
    if (stats.text) lines.push(stats.text);
    // The materials with a metalness map — a phone ships compressed textures,
    // so the fringe's metalness / roughness / colour are what its transcode
    // says they are; the desktop's is the reference.
    if (!(stats.materials?.length) && engine.scene) {
      const seen = new Map();
      engine.scene.traverse((o) => {
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          if (!m || seen.has(m) || !(m.metalnessMap || /curtain|fabric|cloth|gold|trim/i.test(m.name ?? ""))) continue;
          const tex = (t) => (t ? `${t.colorSpace || "-"}/${t.format}/${t.type}${t.isCompressedTexture ? "c" : ""}` : "-");
          seen.set(m, `${(m.name || "?").slice(0, 18)} m${(m.metalness ?? 1).toFixed(2)} r${(m.roughness ?? 1).toFixed(2)} col ${m.color ? m.color.getHexString() : "-"} map ${tex(m.map)} mr ${tex(m.metalnessMap)} rough ${tex(m.roughnessMap)} emis ${m.emissiveIntensity ?? 0}`);
        }
      });
      stats.materials = [...seen.values()].slice(0, 4);
    }
    if (stats.materials?.length) {
      lines.push(`materials (${stats.materials.length} with metalness map): tone ${engine.renderer?.toneMapping} ${engine.renderer?.outputColorSpace}`);
      for (const m of stats.materials) lines.push(`  ${m.slice(0, 110)}`);
    }
    const log = (globalThis.__playerLog ?? []).filter((l) => /gi|kernel|pipeline|validation|shader|storage|binding|WGSL|Failed/i.test(l));
    if (log.length) {
      lines.push(`log: ${(globalThis.__playerLog ?? []).length} entries, ${log.length} GI/GPU`);
      for (const l of log.slice(-4)) lines.push(`  ${l.slice(0, 96)}`);
    }
    if (ledger.available) {
      const { totalMsPerFrame, rows: all } = ledger.rows();
      lines.push(`gpu ledger ${fmt(totalMsPerFrame, 2)} ms/frame (2 s window)`);
      for (const row of all.slice(0, rows)) {
        lines.push(`  ${fmt(row.msPerFrame, 3).padStart(6)} ×${fmt(row.callsPerFrame, 2).padStart(5)}  ${row.label.slice(0, 44)}`);
      }
    } else {
      lines.push("gpu ledger: no timestamp queries on this adapter");
    }
    lines.push(performance.now() - copiedAt < 1500 ? "copied" : "tap to copy");
    el.textContent = lines.join("\n");
  };
  const timer = setInterval(render, 1000);
  render();
  el.addEventListener("click", async () => {
    try {
      await navigator.clipboard?.writeText(el.textContent);
      copiedAt = performance.now();
      render();
    } catch {
      /* clipboard needs a secure context + gesture; the text stays on screen */
    }
  });
  return {
    el,
    dispose() {
      clearInterval(timer);
      clearInterval(statsTimer);
      ledger.dispose();
      el.remove();
    },
  };
}
