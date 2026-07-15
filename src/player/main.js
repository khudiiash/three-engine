import * as THREE from "three/webgpu";
import {
  Engine,
  deserializeScene,
  setAssetResolver,
  setScriptLoader,
  setAssetMetaLoader,
  applyEngineModules,
  registerBuiltInComponents,
} from "../engine/index.js";
import { linkEngineImports } from "../engine/scriptRuntime.js";
import "../modules/index.js"; // registers the built-in module catalog

// Bundler tree-shaking would otherwise drop these side-effect registrations
// — call explicitly so every built-in component is present before any scene
// tries to deserialize (the editor does the same in `engineInstance.js`).
registerBuiltInComponents();

// Expose the three namespace under a stable global so the script-runtime
// data URLs (which can't `import` anything themselves) can pull three
// classes from it. Must be set before any user script runs.
globalThis.__ENGINE_THREE__ = THREE;

// Exported scenes reference assets by relative URL ("assets/foo.glb").
setAssetResolver(async (path) => path);

// Sidecar .meta files ship next to their assets; missing ones are fine.
setAssetMetaLoader(async (path) => {
  const res = await fetch(path);
  return res.ok ? res.json() : null;
});

// Scripts ship as plain files; import once via blob URL (version never
// changes, so ScriptComponent's hot-reload poll is a cheap cache hit).
const scriptCache = new Map();
/** Reject HTML/markup payloads early so the user sees a clear error
 *  ("this isn't a script") rather than the cryptic "Unexpected identifier
 *  'html'" thrown when the browser tries to parse `<html>` as JS. */
function looksLikeHtml(source) {
  if (typeof source !== "string") return false;
  const head = source.trimStart().slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml");
}
setScriptLoader(async (path) => {
  let entry = scriptCache.get(path);
  if (!entry) {
    const raw = await (await fetch(path)).text();
    if (looksLikeHtml(raw)) {
      throw new Error(`Script "${path}" looks like HTML/markup, not JavaScript or TypeScript`);
    }
    let code;
    try {
      code = await linkEngineImports(raw);
    } catch (err) {
      throw new Error(`Failed to import script "${path}": ${err.message ?? err}`);
    }
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    try {
      const mod = await import(/* @vite-ignore */ url);
      entry = { version: 1, default: mod.default ?? null };
    } finally {
      URL.revokeObjectURL(url);
    }
    scriptCache.set(path, entry);
  }
  return entry;
});

function findSceneCamera(entities) {
  for (const entity of entities) {
    const cam = entity.getComponent("camera")?.camera;
    if (cam) return cam;
    const child = findSceneCamera(entity.children);
    if (child) return child;
  }
  return null;
}

async function boot() {
  const engine = new Engine();
  await engine.init(document.getElementById("game"));
  // Start the render loop early so the canvas paints the background colour
  // immediately, instead of staying black until the scene is deserialized.
  // The loop is harmless on an empty scene — it just renders nothing.
  engine.start();

  const scene = await (await fetch("scene.json")).json();
  // Modules first: their components must exist before entities instantiate.
  // Rapier's setup now returns a placeholder and finishes its WASM init in
  // the background, so this await no longer blocks on the heavy work.
  await applyEngineModules(engine, scene.modules ?? []);
  // Input config next — the manager is attached during init(), so swapping
  // the snapshot detaches/re-attaches to keep listeners consistent.
  if (scene.input) engine.applyInput(scene.input);
  await deserializeScene(engine, scene);

  // Project settings embedded at export time.
  if (scene.player?.title) document.title = scene.player.title;
  if (scene.player?.pixelRatioCap) {
    engine.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, scene.player.pixelRatioCap));
  }

  engine.camera =
    findSceneCamera(engine.rootEntities) ??
    new THREE.PerspectiveCamera(60, 1, 0.1, 1000);

  const resize = () => engine.setSize(window.innerWidth, window.innerHeight);
  window.addEventListener("resize", resize);
  resize();

  engine.setPlaying(true);
}

boot().catch((err) => {
  document.body.textContent = `Failed to start: ${err.message}`;
  console.error(err);
});
