// Stage A smoke test: the new matParams MRT (metalness R / roughness G). Builds
// the EXACT same pass MRT that PostprocessComponent now sets and renders it via
// a RenderPipeline, then reads back per-material values. Validates (1) the MRT
// WGSL compiles across mixed materials and (2) metalness/roughness are written
// correctly per material.
import * as THREE from "three/webgpu";
import { pass, mrt, output, packNormalToRGB, normalView, metalness, roughness, vec4 } from "three/tsl";

const log = (m) => console.log(`DIAG ${m}`);
const done = () => { document.documentElement.dataset.done = "true"; };
globalThis.addEventListener("error", (e) => { log(`PAGEERROR ${e.error?.stack || e.message}`); done(); });
globalThis.addEventListener("unhandledrejection", (e) => { log(`PAGEERROR ${e.reason?.stack || e.reason}`); done(); });

const canvas = document.getElementById("canvas");
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
await renderer.init();
renderer.setSize(640, 360, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 640 / 360, 0.1, 80);
camera.position.set(0, 2, 7); camera.lookAt(0, 1, 0);

const metalSphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.2, 32, 32),
  new THREE.MeshStandardNodeMaterial({ color: 0xaaaaaa, metalness: 1.0, roughness: 0.08 }),
);
metalSphere.position.set(-1.8, 1.2, 0); scene.add(metalSphere);
const roughBox = new THREE.Mesh(
  new THREE.BoxGeometry(2, 2, 2),
  new THREE.MeshStandardNodeMaterial({ color: 0xcc6644, metalness: 0.0, roughness: 0.95 }),
);
roughBox.position.set(1.8, 1, 0); scene.add(roughBox);
const floor = new THREE.Mesh(
  new THREE.BoxGeometry(20, 0.5, 20),
  new THREE.MeshStandardNodeMaterial({ color: 0x555555, metalness: 0.2, roughness: 0.6 }),
);
floor.position.set(0, -0.25, 0); scene.add(floor);
// A non-standard material (basic) to prove metalness/roughness accessors don't
// crash on materials that lack those properties.
const basic = new THREE.Mesh(
  new THREE.BoxGeometry(0.8, 0.8, 0.8),
  new THREE.MeshBasicNodeMaterial({ color: 0x22ff22 }),
);
basic.position.set(0, 3, 0); scene.add(basic);
scene.add(new THREE.DirectionalLight(0xffffff, 2.5).translateX(3));
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

// EXACTLY the PostprocessComponent MRT.
const scenePass = pass(scene, camera, { samples: 1 });
scenePass.setMRT(mrt({
  output,
  normal: packNormalToRGB(normalView),
  matParams: vec4(metalness, roughness, 0, 1),
}));
const nrm = scenePass.getTexture("normal"); if (nrm) nrm.type = THREE.UnsignedByteType;
const matTex = scenePass.getTexture("matParams"); if (matTex) matTex.type = THREE.UnsignedByteType;

const pipeline = new THREE.RenderPipeline(renderer, scenePass.getTextureNode());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 5; i++) { pipeline.render(); await wait(120); }
log("rendered 5 frames without WGSL error");

const rt = scenePass.renderTarget;
const w = rt.width, h = rt.height;
const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h, 2);
const scale = buf instanceof Uint8Array ? 255 : 1;
let maxR = 0, maxG = 0, metalPx = 0, roughPx = 0, nonEmpty = 0;
for (let i = 0; i < buf.length; i += 4) {
  const r = buf[i], g = buf[i + 1];
  if (r > maxR) maxR = r;
  if (g > maxG) maxG = g;
  if (r > 0.78 * scale) metalPx++;
  if (g > 0.78 * scale && r < 0.25 * scale) roughPx++;
  if (r > 2 || g > 2) nonEmpty++;
}
log(`matParams ${w}x${h} maxMetal=${(maxR / scale).toFixed(2)} maxRough=${(maxG / scale).toFixed(2)} metalPx=${metalPx} roughPx=${roughPx} nonEmpty=${nonEmpty}`);
const gpass = maxR / scale > 0.85 && maxG / scale > 0.85 && metalPx > 50 && roughPx > 50;
log(`VERDICT gbuffer=${gpass ? "PASS" : "FAIL"}`);
done();
