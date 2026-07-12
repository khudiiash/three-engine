// Renders the actual imported Poly Haven lantern through the REAL engine
// asset pipeline (material asset → shader graph → basis textures → .geom)
// with a WebGPU renderer, and reports what ends up on screen.
import * as THREE from "three/webgpu";
import { setAssetResolver, setAssetMetaLoader } from "/src/engine/assetResolver.js";
import {
  loadTextureAsset,
  configureTextureAssetLoader,
  setBasisCompressionEnabled,
} from "/src/engine/textureAsset.js";
import { loadMaterialAsset, getMaterialInstance } from "/src/engine/materialAsset.js";
import { loadGeometryAsset } from "/src/engine/geometryAsset.js";

document.getElementById("log").textContent = "script loaded\n";
const log = (...args) => {
  document.getElementById("log").textContent += args.join(" ") + "\n";
  console.log(...args);
};
for (const level of ["error", "warn"]) {
  const orig = console[level];
  console[level] = (...args) => {
    document.getElementById("log").textContent += `[${level}] ` + args.join(" ") + "\n";
    orig(...args);
  };
}
window.addEventListener("error", (e) => log("[uncaught]", e.message));
window.addEventListener("unhandledrejection", (e) => log("[rejection]", e.reason?.message ?? e.reason));

// Map the .mat's absolute Windows paths onto the copied test assets by tail.
const BASE = "/.render-test/lantern";
setAssetResolver(async (path) => {
  const norm = String(path).replaceAll("\\", "/");
  const idx = norm.indexOf("PolyHaven/Lantern 01/");
  if (idx !== -1) return BASE + "/" + norm.slice(idx + "PolyHaven/Lantern 01/".length);
  return norm;
});
setAssetMetaLoader(async (metaPath) => {
  try {
    const norm = String(metaPath).replaceAll("\\", "/");
    const idx = norm.indexOf("PolyHaven/Lantern 01/");
    if (idx === -1) return null;
    const res = await fetch(BASE + "/" + norm.slice(idx + "PolyHaven/Lantern 01/".length));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
});

async function main() {
  log("navigator.gpu:", !!navigator.gpu);
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter();
    log("adapter:", adapter ? adapter.info?.vendor ?? "yes" : "NONE");
  }
  const forceWebGL = new URLSearchParams(location.search).has("webgl");
  log("forceWebGL:", forceWebGL);
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL });
  renderer.setSize(512, 512);
  document.body.appendChild(renderer.domElement);
  log("init…");
  await renderer.init();
  log("webgpu ok:", renderer.backend.isWebGPUBackend === true);

  setBasisCompressionEnabled(true);
  configureTextureAssetLoader(renderer);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#202329");
  scene.add(new THREE.AmbientLight("#ffffff", 1.2));
  const sun = new THREE.DirectionalLight("#ffffff", 2.5);
  sun.position.set(2, 3, 4);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);

  const matPath = "C:\\Users\\Khudiiash\\Documents\\GAME/PolyHaven/Lantern 01/Materials/Lantern_01_brass.mat";
  const geoPath = "C:\\Users\\Khudiiash\\Documents\\GAME/PolyHaven/Lantern 01/Geometry/Lantern_01.geom";

  const material = await loadMaterialAsset(matPath);
  log("material loaded:", material.constructor.name);
  const geometry = await loadGeometryAsset(geoPath);
  log("geometry loaded, verts:", geometry.getAttribute("position").count);

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  geometry.computeBoundingSphere();
  const s = geometry.boundingSphere;
  camera.position.set(s.center.x + s.radius * 1.6, s.center.y + s.radius * 0.8, s.center.z + s.radius * 1.6);
  camera.lookAt(s.center);

  // Give the async graph compile (inside loadMaterialAsset) time to land,
  // then render several frames so async pipeline compilation settles.
  await new Promise((r) => setTimeout(r, 1500));
  const inst = getMaterialInstance(matPath);
  log("colorNode set:", !!inst.colorNode, "| roughnessNode:", !!inst.roughnessNode, "| normalNode:", !!inst.normalNode, "| map:", !!inst.map);
  for (let i = 0; i < 30; i++) {
    await renderer.renderAsync(scene, camera);
    await new Promise((r) => setTimeout(r, 30));
  }

  // Read back the framebuffer center to classify the result.
  const gl = renderer.domElement;
  const probe = document.createElement("canvas");
  probe.width = gl.width;
  probe.height = gl.height;
  const ctx = probe.getContext("2d");
  ctx.drawImage(gl, 0, 0);
  const px = ctx.getImageData(probe.width / 2, probe.height / 2, 1, 1).data;
  log("center pixel:", px[0], px[1], px[2]);
  log("DONE");
  document.title = "DONE";
}

// Top-level await keeps the window 'load' event pending until the render is
// done, so headless Chrome's --screenshot captures the finished frame.
await main().catch((err) => log("[fatal]", err.message, err.stack));
