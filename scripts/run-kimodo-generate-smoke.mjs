// End-to-end smoke for the editor's "Generate Animation…" pipeline — WITHOUT
// the kimodo toolchain. Everything downstream of the Rust command is real
// here: `generateAnimationOnModel` runs in the actual editor page over the
// shimmed Tauri, decode → retarget → model rewrite → project refresh, with a
// pre-generated motion's raw f32 streams (artifacts/kimodo/walk-raw) standing
// in for the CLI's output behind a shimmed `generate_motion` command.
//
// Native discovery/FFI lives in Rust; `cargo check` covers that boundary while
// this smoke gates everything observable from the editor onward.
//
//   npx vite --port 5219
//   node scripts/run-kimodo-generate-smoke.mjs [url]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5219/";
const engineRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";

// A disposable project holding a copy of the character model + the raw
// motion streams, so every file command the pipeline issues hits real files.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-kimodo-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "Kimodo", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "scenes"), { recursive: true });
fs.writeFileSync(path.join(root, "scenes", "Empty.scene"), JSON.stringify({ version: 1, name: "Empty", entities: [] }, null, 2));
fs.mkdirSync(path.join(root, "models"), { recursive: true });
fs.mkdirSync(path.join(root, "materials"), { recursive: true });
fs.copyFileSync(
  path.join(engineRoot, "src/modules/character-controller/assets/CharacterModel.glb"),
  path.join(root, "models/CharacterModel.glb"),
);
const rawDir = path.join(root, ".kimodo");
fs.mkdirSync(rawDir, { recursive: true });
for (const f of ["root_positions.f32", "local_rotations_xyzw.f32"]) {
  fs.copyFileSync(path.join(engineRoot, "artifacts/kimodo/walk-raw", f), path.join(rawDir, f));
}
const modelAbs = `${root.replaceAll("\\", "/")}/models/CharacterModel.glb`;
const materialAbs = `${root.replaceAll("\\", "/")}/materials/Joints.mat`;
fs.writeFileSync(materialAbs, JSON.stringify({ color: "#123456", roughness: 1, metalness: 0 }, null, 2));
const browserProfile = fs.mkdtempSync(path.join(os.tmpdir(), "engine-kimodo-browser-"));
let generationArgs = null;

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: browserProfile,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {
  writableRoot: root,
  verbose: !!process.env.VERBOSE,
  extraCommands: {
    probe_kimodo_tool: async () => "C:/auto-discovered/kimodo.cpp",
    // The real command spawns kmd-generate; the shim hands back a finished
    // generation's outputs (paths must live under `root` so the shimmed
    // read_binary_file can serve them).
    generate_motion: async (args) => {
      if (!args?.prompt) throw new Error("prompt missing");
      generationArgs = args;
      return {
        rootsPath: `${rawDir.replaceAll("\\", "/")}/root_positions.f32`,
        rotsPath: `${rawDir.replaceAll("\\", "/")}/local_rotations_xyzw.f32`,
        outputDir: rawDir.replaceAll("\\", "/"),
        frames: 90,
      };
    },
  },
});
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await wait(4000);

await page.evaluate(async (projectRoot) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
  globalThis.__importLive = importLive;
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore.getState().openProject(projectRoot).then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));
for (let i = 0; i < 60 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);

// Match imported production assets: the retargeter must decode the model with
// the engine's shared Draco-aware loader before appending the new clip.
const dracoInfo = await page.evaluate(async (modelAbsPath) => {
  const { compressGlbInPlace } = await globalThis.__importLive("/src/editor/dracoCompress.js");
  return compressGlbInPlace(modelAbsPath);
}, modelAbs);

// The pipeline entry, exactly as the Animator's Generate handler calls it.
const result = await page.evaluate(async ({ modelAbsPath, materialPath }) => {
  const { generateAnimationOnModel } = await globalThis.__importLive("/src/editor/kimodoGenerate.js");
  const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const liveEntity = engine.createEntity({ id: "smoke-entity", name: "Generated Character" });
  const liveModel = liveEntity.addComponent("model", { path: modelAbsPath });
  const liveSkin = liveEntity.addComponent("skinnedmesh", { path: "0/2", material: materialPath });
  const liveAnimation = liveEntity.addComponent("animation", { controller: "", playInEditor: false });
  await liveModel.whenReady();
  for (let i = 0; i < 100 && liveSkin.mesh?.material?.color?.getHexString?.() !== "123456"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Real imported prefabs commonly persist an absolute Windows path with a
  // backslash drive prefix and forward-slash tail. That exact spelling used
  // to miss the live model comparison and made the clip appear only on restart.
  const mixedModelPath = modelAbsPath.replace("/models/", "\\models/");
  const entity = { id: liveEntity.id, components: { model: { path: mixedModelPath } } };
  try {
    const value = await generateAnimationOnModel({
      entity,
      prompt: "a person walks forward at a steady pace",
      frames: 90,
      steps: 25,
      seed: 42,
      travel: false,
      clipName: "SmokeWalk",
    });
    for (let i = 0; i < 100 && liveSkin.mesh?.material?.color?.getHexString?.() !== "123456"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Same ordering as AnimatorPanel.runGenerate: only after the model reload
    // promise resolves do we apply the graph containing the new state and
    // audition it. This is the visible contract, beyond merely finding a clip
    // name in the reloaded GLB.
    liveAnimation.applyGraph({
      version: 2,
      parameters: [],
      layers: [{
        id: "layer-base", name: "Base Layer", weight: 1, blend: "override", mask: null,
        states: [{ id: "generated", name: "SmokeWalk", kind: "clip", clip: "SmokeWalk", speed: 1, loop: true }],
        startTransitions: [{ to: "generated", conditions: [] }], transitions: [],
      }],
    });
    liveAnimation.previewState("SmokeWalk", 0, 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const previewLayer = liveAnimation.runtime?.layers?.[0];
    const previewState = previewLayer?.currentId ? previewLayer.states.get(previewLayer.currentId) : null;
    return {
      ok: true,
      value,
      liveClips: liveModel.clips.map((clip) => clip.name),
      skinName: liveSkin.mesh?.name ?? null,
      materialColor: liveSkin.mesh?.material?.color?.getHexString?.() ?? null,
      previewState: liveAnimation.currentState,
      previewTime: previewState?.entries?.[0]?.action?.time ?? 0,
    };
  } catch (e) {
    return { ok: false, error: String(e?.stack ?? e) };
  }
}, { modelAbsPath: modelAbs, materialPath: materialAbs });

const fail = (msg) => { console.error(` FAIL  ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`  ok   ${msg}`);

if (!result.ok) fail(`pipeline threw: ${result.error}`);
if (!(dracoInfo?.compressed < dracoInfo?.original)) fail(`fixture was not Draco-compressed (${JSON.stringify(dracoInfo)})`);
else ok(`Draco-compressed source model decodes during retarget (${dracoInfo.original} -> ${dracoInfo.compressed} bytes)`);
if (generationArgs?.projectRoot !== root.replaceAll("\\", "/")) fail("generation did not pass the open project to native discovery");
else ok("native generation receives the project root for automatic discovery");
if (generationArgs && ["exePath", "motionGguf", "textBundle", "libDirs"].some((key) => key in generationArgs)) {
  fail("front end still passed a user-selected Kimodo path");
} else ok("generation needs no Kimodo path from the front end");
if (result.ok && (!result.value.liveModels || !result.liveClips.includes("SmokeWalk"))) {
  fail(`live model did not reload the generated clip (${result.liveClips?.join(", ")})`);
} else if (result.ok) ok("generated clip is live on the model before the call resolves");
if (result.ok && (result.previewState !== "SmokeWalk" || !(result.previewTime > 0))) {
  fail(`generated state did not play immediately (${result.previewState}, t=${result.previewTime})`);
} else if (result.ok) ok(`generated state previews immediately at t=${result.previewTime.toFixed(2)}s`);
if (result.ok && (result.skinName !== "Alpha_Joints" || result.materialColor !== "123456")) {
  fail(`prefab mesh/material binding was lost (${result.skinName}, ${result.materialColor})`);
} else if (result.ok) ok("prefab mesh path and external material survive the reload");

// The written model must carry the four vendored clips PLUS the generated
// one, and every track of the new clip must resolve by name.
if (result.ok) {
  const check = await page.evaluate(async (modelAbsPath) => {
    const { readAssetBinary } = await globalThis.__importLive("/src/editor/assetLoader.js");
    const buf = await readAssetBinary(modelAbsPath);
    const { getGltfLoader } = await globalThis.__importLive("/src/engine/gltfLoader.js");
    const gltf = await getGltfLoader().parseAsync(buf, "");
    const nodes = new Set();
    gltf.scene.traverse((o) => nodes.add(o.name));
    const clip = gltf.animations.find((c) => c.name === "SmokeWalk");
    return {
      clipNames: gltf.animations.map((c) => c.name),
      hasClip: !!clip,
      unbound: clip ? clip.tracks.filter((t) => !nodes.has(t.name.replace(/\.(position|quaternion)$/, ""))).length : -1,
      duration: clip?.duration ?? 0,
    };
  }, modelAbs);
  if (check.clipNames.length !== 5) fail(`expected 5 clips on the rewritten model, got ${check.clipNames.join(", ")}`);
  else ok(`model rewritten with clips: ${check.clipNames.join(", ")}`);
  if (!check.hasClip) fail("generated clip missing from the written GLB");
  if (check.unbound !== 0) fail(`${check.unbound} generated tracks bind to no scene node`);
  else ok("every generated track binds to a scene node");
  // 90 frames at 30fps: the LAST key sits at 89/30, and the GLB round trip
  // recomputes duration from that key — a frame short of the nominal 3s.
  if (Math.abs(check.duration - 89 / 30) > 0.01) fail(`clip duration ${check.duration}, expected ${89 / 30}`);
  else ok(`clip duration ${check.duration.toFixed(2)}s`);

  // Backup of the ORIGINAL model beside the generation outputs.
  const backups = fs.readdirSync(rawDir).filter((f) => f.startsWith("model-backup-"));
  if (backups.length !== 1) fail(`expected 1 model backup in the output dir, found ${backups.length}`);
  else ok(`original model backed up as ${backups[0]}`);
}

if (errors.length) fail(`page errors: ${errors[0]}`);
await browser.close();
fs.rmSync(browserProfile, { recursive: true, force: true });
if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? "SMOKE FAILED" : "kimodo generate smoke passed");
