// GI TEXTURE MIX-UP DETECTOR — §19 stage 4.0c.
//
// THE BUG THIS EXISTS TO SEE
//
// The user's Bistro shows ONE foreign albedo (an ivy leaf sheet) on EVERY
// material — pavement, walls, awnings, the scooter — each in its OWN UV space
// and perspective-correct. No console error, 67 fps. "Textures get mixed up."
//
// That picture is a bind group whose `map` slot names a texture the material
// does not own. Nothing in the renderer complains about that: it is a perfectly
// valid bind group, just the wrong one. So the receipt cannot be an error
// counter — it has to be a CPU-side comparison of what each render object's
// bind groups actually name against what its material owns.
//
//   foreignTextureBindings — a sampled-texture binding whose texture belongs to
//                            a DIFFERENT material in this scene. Target 0.
//
// Ownership is read off the scene itself (every material's texture-valued
// properties), so "foreign" means *another material in this very scene owns
// it*, not "I did not recognise it". GI's own targets, shadow maps, the
// environment and three's default textures are all excused explicitly.
//
// Run:
//   node node_modules/vite/bin/vite.js --port 5202 --strictPort   (if not up)
//   node scripts/run-gi-texmix-probe.mjs http://127.0.0.1:5202/
//
// Env:
//   PROJECT=<path>   default C:/Users/Khudiiash/Documents/GAME
//   SCENE=<path>     default <project>/scenes/Bistro.scene
//   HOPS=5           resize hops to drive after the boot reading
//   HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = (process.env.SCENE ?? `${PROJECT}/scenes/Bistro.scene`).replaceAll("\\", "/");
const HOPS = Number(process.env.HOPS ?? 5);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--js-flags=--expose-gc",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let readySeen = false;
let builtCount = 0;
let texAvgResolved = false;
const uncaptured = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] field ready/.test(t)) readySeen = true;
  if (/\[gi\] built/.test(t)) builtCount++;
  if (/compressed-texture averages resolved/.test(t)) texAvgResolved = true;
  if (/UNCAPTURED DEVICE ERROR|Destroyed texture|Destroyed buffer/.test(t)) uncaptured.push(t.slice(0, 200));
  if (/\[gi\] (built|field ready|resolve target)|resolve-resize|averages resolved|re-tint/.test(t)) {
    console.log(`  ${t.slice(0, 200)}`);
  }
});
page.on("pageerror", (e) => {
  const msg = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 260)}`);
});

const ARM = process.env.TEXMIX_ARM ?? "";
await page.evaluateOnNewDocument((PROJECT, arm) => {
  globalThis.__editorKeepRendering = true;
  if (arm) for (const flag of arm.split(",")) if (flag) globalThis[flag] = true;
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
}, PROJECT, ARM);
if (ARM) console.log(`  ⚠ ARM: ${ARM}`);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });

const call = async (op, args = {}) => {
  try {
    return await page.evaluate(async ({ op, args }) => {
      try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    }, { op, args });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
};

{
  const before = builtCount;
  const r = await call("scene.open", { path: SCENE });
  if (!r.ok) { console.log(`FATAL: scene.open: ${r.error}`); await browser.close(); process.exit(1); }
  const t0 = Date.now();
  while (builtCount <= before && Date.now() - t0 < 420000) await wait(1000);
  console.log(`  scene open, gi built: ${builtCount > before}`);
}
{
  const t0 = Date.now();
  while (!readySeen && Date.now() - t0 < 300000) await wait(2000);
  console.log(`  field ready seen: ${readySeen}`);
}

// The render objects are not enumerable from outside — `RenderObjects` is a
// ChainMap over WeakMaps. So collect them at the one funnel every draw goes
// through, `RenderObjects.get`, and keep the engine's loop pinned while it
// fills (headless is never focused; editorFramePacing parks the loop).
const arm = () => page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__editorKeepRendering = true;
  globalThis.__texMixKeepAlive ??= setInterval(() => {
    engine.setFrameRateLimit?.(0);
    if (!engine.loopActive) engine.start?.();
  }, 250);
  const objects = engine?.renderer?._objects;
  if (objects && !objects.__texMixPatched) {
    objects.__texMixPatched = true;
    const set = globalThis.__texMixSeen = new Set();
    const orig = objects.get.bind(objects);
    objects.get = function (...args) {
      const ro = orig(...args);
      if (set.size < 8000) set.add(ro);
      return ro;
    };
  }
  return !!objects;
});

const MEASURE = async (label) => {
  for (let attempt = 0; ; attempt++) {
    try { await arm(); return await measureOnce(label); }
    catch (err) {
      if (attempt >= 3) throw err;
      console.log(`  (retry ${attempt + 1}: ${String(err?.message ?? err).slice(0, 90)})`);
      await wait(4000);
    }
  }
};

const measureOnce = (label) => page.evaluate(async (label) => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const renderer = engine.renderer;
  const scene = engine.scene;
  const system = engine?.modules?.get?.("gi")?.system;

  // ── ownership map: texture -> the materials in THIS scene that name it ────
  const owners = new Map();      // THREE.Texture -> Set<material>
  const matName = new Map();     // material -> readable name
  const allMaterials = new Set();
  const noteMat = (m, objName) => {
    if (!m || allMaterials.has(m)) return;
    allMaterials.add(m);
    matName.set(m, m.name || `${m.type}#${String(m.uuid).slice(0, 6)} on ${objName}`);
    for (const key of Object.keys(m)) {
      const v = m[key];
      if (v && v.isTexture) {
        if (!owners.has(v)) owners.set(v, new Set());
        owners.get(v).add(m);
      }
    }
  };
  scene.traverse?.((o) => {
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) for (const mm of m) noteMat(mm, o.name);
    else noteMat(m, o.name);
  });

  // ── the excused set: nothing here is "another material's texture" ─────────
  const excused = new Set();
  const excuse = (t) => { if (t && t.isTexture) excused.add(t); };
  excuse(scene.environment); excuse(scene.background);
  excuse(system?._giIrradianceNode?.value); excuse(system?._giRadianceNode?.value);
  scene.traverse?.((o) => {
    if (o.isLight && o.shadow?.map?.texture) excuse(o.shadow.map.texture);
    if (o.isLight && o.shadow?.map?.textures) for (const t of o.shadow.map.textures) excuse(t);
  });
  for (const csm of [engine?.csm, engine?.renderer?.shadowMap]) {
    for (const l of csm?.lights ?? []) excuse(l?.shadow?.map?.texture);
  }

  const isGiTexture = (t) => typeof t?.name === "string" && /^gi/i.test(t.name);
  const store = renderer._textures;

  const seen = [...(globalThis.__texMixSeen ?? [])];
  let sampledBindings = 0;
  let objectsWalked = 0;
  const foreign = [];
  const nodeValueDrift = [];   // binding.texture !== binding.textureNode.value
  const sharedNodes = new Map(); // textureNode -> Set<material>

  for (const ro of seen) {
    const material = ro?.material;
    if (!material || material.isShadowPassMaterial === true) continue;
    let bindings = null;
    try { bindings = ro.getBindings?.(); } catch { continue; }
    if (!bindings) continue;
    objectsWalked++;
    const own = new Set();
    for (const key of Object.keys(material)) {
      const v = material[key];
      if (v && v.isTexture) own.add(v);
    }
    for (const bindGroup of bindings) {
      for (const binding of bindGroup.bindings ?? []) {
        if (binding?.isSampledTexture !== true) continue;
        const tex = binding.texture;
        sampledBindings++;
        const node = binding.textureNode;
        if (node) {
          if (!sharedNodes.has(node)) sharedNodes.set(node, new Set());
          sharedNodes.get(node).add(material);
          if (node.value && node.value !== tex) {
            nodeValueDrift.push({
              material: matName.get(material) ?? "?",
              binding: binding.name,
              bound: tex?.name ?? "(unnamed)",
              node: node.value?.name ?? "(unnamed)",
            });
          }
        }
        if (!tex || own.has(tex) || excused.has(tex) || isGiTexture(tex)) continue;
        if (store.has?.(tex) && store.get(tex)?.isDefaultTexture) continue;
        const ownerSet = owners.get(tex);
        if (!ownerSet) continue;          // not another scene material's texture
        if (ownerSet.has(material)) continue;
        foreign.push({
          material: matName.get(material) ?? "?",
          binding: binding.name,
          foreignTexture: tex.name || `#${tex.id}`,
          foreignSize: tex.image ? `${tex.image.width}x${tex.image.height}` : "?",
          ownedBy: [...ownerSet].slice(0, 3).map((m) => matName.get(m) ?? "?"),
        });
      }
    }
  }

  // How many distinct materials share ONE texture node? >1 means three's
  // node-builder cache handed the same TextureNode to several materials, and
  // the only thing keeping them apart is the per-object node refresh.
  let maxShare = 0; let sharedNodeCount = 0;
  for (const set of sharedNodes.values()) {
    if (set.size > 1) { sharedNodeCount++; maxShare = Math.max(maxShare, set.size); }
  }

  // Canvas readback: the picture itself. A leaf-red pavement is the symptom the
  // user reported, and it is the one reading that needs no model of the cause.
  let pixels = null;
  try {
    const cv = renderer.domElement;
    const c2 = document.createElement("canvas");
    c2.width = cv.width; c2.height = cv.height;
    const ctx = c2.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(cv, 0, 0);
    const grab = (fx, fy) => {
      const d = ctx.getImageData(Math.round(cv.width * fx), Math.round(cv.height * fy), 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    pixels = { lowerLeft: grab(0.25, 0.88), lowerMid: grab(0.5, 0.9), lowerRight: grab(0.75, 0.86) };
  } catch (err) { pixels = { error: String(err?.message ?? err).slice(0, 80) }; }

  return {
    label,
    objectsWalked, sampledBindings,
    foreignTextureBindings: foreign.length,
    foreignSample: foreign.slice(0, 10),
    foreignMaterials: new Set(foreign.map((f) => f.material)).size,
    nodeValueDrift: nodeValueDrift.length,
    nodeValueDriftSample: nodeValueDrift.slice(0, 6),
    sharedNodeCount, maxShare,
    materialsInScene: allMaterials.size,
    texturesInScene: owners.size,
    giRebinds: system?._giRebindings ?? 0,
    // §19 4.0c: bindings the repair walked past because they did not name a
    // dying GI texture. ⭐ "the repair ran" and "the repair stayed in its lane"
    // must be two numbers — a zero here next to a zero foreign count would
    // mean the surgical path never even looked.
    giLeftAlone: system?._giRebindLeftAlone ?? 0,
    giFrame: system?._frame ?? -1,
    fps: Math.round(engine?.stats?.sample?.().fps ?? -1),
    resolve: `${system?.state?.screen?.width ?? -1}x${system?.state?.screen?.height ?? -1}`,
    pixels,
  };
}, label);

const show = (s) => {
  console.log(
    `TEXMIX ${String(s.label).padEnd(14)} objects ${String(s.objectsWalked).padStart(4)}` +
    ` sampledBindings ${String(s.sampledBindings).padStart(5)}` +
    ` ⛔ foreignTextureBindings ${String(s.foreignTextureBindings).padStart(5)}` +
    ` (across ${s.foreignMaterials} materials)` +
    ` nodeDrift ${String(s.nodeValueDrift).padStart(4)}` +
    ` sharedNodes ${s.sharedNodeCount} (max ${s.maxShare} materials/node)` +
    ` giRebinds ${s.giRebinds} leftAlone ${s.giLeftAlone} f${s.giFrame} ${s.fps}fps ${s.resolve}`,
  );
  for (const f of s.foreignSample) {
    console.log(`    · ${f.material} :: slot "${f.binding}" is bound to "${f.foreignTexture}" ` +
      `(${f.foreignSize}) owned by ${JSON.stringify(f.ownedBy)}`);
  }
  for (const d of s.nodeValueDriftSample) {
    console.log(`    ~ ${d.material} :: "${d.binding}" bound "${d.bound}" but node.value is "${d.node}"`);
  }
  console.log(`    px ${JSON.stringify(s.pixels)}`);
};

await wait(10000);
console.log("\n--- boot ---");
const boot = await MEASURE("boot");
show(boot);
if (boot.objectsWalked < 5) {
  console.log("\nTEXMIX ENVIRONMENT FAILURE: no render objects were collected — nothing was measured.");
  await browser.close();
  process.exit(2);
}

// The texture-average drain (Bistro's KTX2 maps) is what runs
// computeCompressedTextureAverage + #retintGi2Palette. Give it time, then read.
console.log("\n--- after the texture-average drain ---");
const t0 = Date.now();
while (!texAvgResolved && Date.now() - t0 < 90000) await wait(2000);
await wait(6000);
const afterDrain = await MEASURE("after-drain");
show(afterDrain);

console.log(`\n--- ${HOPS} resize hops ---`);
const fullPx = Math.max(1, (boot.resolve.split("x")[0] | 0) * (boot.resolve.split("x")[1] | 0));
for (let i = 1; i <= HOPS; i++) {
  await page.evaluate((v) => { globalThis.__giResolveMaxPixels = v; }, Math.round(fullPx * (i % 2 ? 0.25 : 1)));
  await wait(7000);
}
await page.evaluate(() => { globalThis.__giResolveMaxPixels = 0; });
await wait(8000);
const afterHops = await MEASURE("after-hops");
show(afterHops);

const fails = [];
for (const s of [boot, afterDrain, afterHops]) {
  if (s.foreignTextureBindings > 0) {
    fails.push(`${s.label}: ${s.foreignTextureBindings} foreign texture bindings across ${s.foreignMaterials} materials (must be 0)`);
  }
}
if (uncaptured.length) fails.push(`${uncaptured.length} uncaptured device errors`);
console.log(`\nTEXMIX ${fails.length ? `${fails.length} FAILURES\n  - ${fails.join("\n  - ")}` : "ALL PASS"}`);
await browser.close();
process.exit(fails.length ? 1 : 0);
