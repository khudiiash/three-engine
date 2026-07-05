import * as THREE from "three/webgpu";
import { Engine, deserializeScene, setAssetResolver, setScriptLoader, setAssetMetaLoader, applyEngineModules } from "../engine/index.js";
import { linkEngineImports } from "../engine/scriptRuntime.js";
import "../modules/index.js"; // registers the built-in module catalog

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
setScriptLoader(async (path) => {
  let entry = scriptCache.get(path);
  if (!entry) {
    const code = linkEngineImports(await (await fetch(path)).text());
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
  const scene = await (await fetch("scene.json")).json();
  // Modules first: their components must exist before entities instantiate.
  await applyEngineModules(engine, scene.modules ?? []);
  deserializeScene(engine, scene);

  // Project settings embedded at export time.
  if (scene.player?.title) document.title = scene.player.title;
  if (scene.player?.pixelRatioCap) {
    engine.renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, scene.player.pixelRatioCap));
  }

  engine.camera =
    findSceneCamera(engine.rootEntities) ??
    new THREE.PerspectiveCamera(60, 1, 0.1, 1000);

  const resize = () => engine.setSize(window.innerWidth, window.innerHeight);
  window.addEventListener("resize", resize);
  resize();

  engine.setPlaying(true);
  engine.start();
}

boot().catch((err) => {
  document.body.textContent = `Failed to start: ${err.message}`;
  console.error(err);
});
