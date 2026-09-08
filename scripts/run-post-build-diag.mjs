/**
 * Deep-reads a RUNNING player build's post state (globalThis.__engine) and
 * screenshots the canvas, before and after nudging a post param — the user's
 * "changing a param makes post appear" is the discriminator.
 *
 *   node scripts/run-post-build-diag.mjs http://localhost:50845/ [outPrefix]
 */
import puppeteer from "puppeteer-core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] ?? "http://localhost:50845/";
const prefix = process.argv[3] ?? "build";
const T0 = Date.now();
const stamp = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: mkdtempSync(join(tmpdir(), "post-build-diag-")),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
const lines = [];
page.on("console", (m) => {
  const text = m.text();
  if (!text.trim()) return;
  lines.push(`[${stamp()}] ${text.slice(0, 300)}`);
});
page.on("pageerror", (err) => lines.push(`[${stamp()}] PAGEERROR ${String(err?.stack ?? err).slice(0, 500)}`));

console.log(`[${stamp()}] goto ${url}`);
await page.goto(url, { waitUntil: "load", timeout: 60_000 });
await new Promise((r) => setTimeout(r, 30_000));

const read = () => page.evaluate(() => {
  const engine = globalThis.__engine;
  if (!engine?.entities) return { engine: "not found" };
  const out = { playing: engine.playing, cameraIsSet: !!engine.camera };
  let comp = null;
  for (const ent of engine.entities.values()) {
    const c = ent.getComponent?.("postprocess");
    if (c) { comp = c; out.entityName = ent.name; break; }
  }
  if (!comp) return { ...out, hasPost: false };
  out.hasPost = true;
  out.isMissingClass = !!comp.missingType;
  out.hasPipeline = !!comp.pipeline;
  out.signature = comp.signature ?? null;
  out.godraysShadowLight = !!comp._godraysShadowLight;
  out.renderOverride = engine.renderOverrides?.has?.(comp) ?? "no-set";
  out.ownsCamera = (() => { try { return comp.ownsCamera(engine); } catch (err) { return `THREW: ${err?.message ?? err}`; } })();
  // The lights godrays depends on.
  out.lights = [];
  for (const ent of engine.entities.values()) {
    const l = ent.getComponent?.("light")?.light;
    if (!l) continue;
    out.lights.push({
      entity: ent.name,
      kind: l.isDirectionalLight ? "directional" : l.isPointLight ? "point" : "other",
      castShadow: !!l.castShadow,
      hasShadowMap: !!l.shadow?.map?.depthTexture,
      giShadowMode: l.userData?.giShadowMode ?? null,
      visible: l.visible !== false,
    });
  }
  return out;
});

const shot = async (name) => {
  const canvas = await page.$("canvas");
  if (!canvas) return console.log("no canvas");
  const b64 = await canvas.screenshot({ encoding: "base64" });
  const file = join(tmpdir(), `${prefix}-${name}.png`);
  writeFileSync(file, Buffer.from(b64, "base64"));
  console.log(`[${stamp()}] screenshot → ${file}`);
};

console.log(JSON.stringify(await read(), null, 2));
await shot("before");

// Nudge a post param the way the inspector does — the user's fix-it move.
const nudged = await page.evaluate(() => {
  const engine = globalThis.__engine;
  for (const ent of engine.entities.values()) {
    const c = ent.getComponent?.("postprocess");
    if (!c) continue;
    const graph = c.activeGraph();
    const node = (graph?.nodes ?? []).find((n) => n.type !== "input" && n.type !== "output");
    if (node?.props) {
      const key = Object.keys(node.props)[0];
      if (key !== undefined) node.props[key] = node.props[key];
      c.applyGraph(graph);
      return `applyGraph nudged ${node.type}.${key ?? "none"}`;
    }
  }
  return "nothing nudged";
});
console.log(`[${stamp()}] ${nudged}`);
await new Promise((r) => setTimeout(r, 8_000));
console.log(JSON.stringify(await read(), null, 2));
await shot("after");

console.log("── console ──");
for (const line of lines) console.log(`  ${line}`);
await browser.close();
