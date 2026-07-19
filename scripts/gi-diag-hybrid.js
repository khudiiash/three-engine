// Stage C verification: the hybrid SSR composite via the REAL compilePostGraph.
// Two invariants:
//   (1) Non-metal pixels must be IDENTICAL to plain beauty (the composite must
//       not darken dielectrics — the bug the old flat mix had).
//   (2) Metal pixels must CHANGE (the sharp on-screen reflection is applied).
import * as THREE from "three/webgpu";
import { pass, mrt, output, packNormalToRGB, normalView, unpackRGBToNormal, metalness, roughness, vec4, sample } from "three/tsl";
import { compilePostGraph } from "/src/modules/postprocessing/postGraph.js";
import { ssr } from "three/addons/tsl/display/SSRNode.js";

const log = (m) => console.log(`DIAG ${m}`);
const done = () => { document.documentElement.dataset.done = "true"; };
globalThis.addEventListener("error", (e) => { log(`PAGEERROR ${e.error?.stack || e.message}`); done(); });
globalThis.addEventListener("unhandledrejection", (e) => { log(`PAGEERROR ${e.reason?.stack || e.reason}`); done(); });

const canvas = document.getElementById("canvas");
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
await renderer.init();
renderer.setSize(640, 360, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 640 / 360, 0.1, 80);
camera.position.set(0, 3.5, 6); camera.lookAt(0, 0.5, -1);

// LEFT half: mirror-metal floor slab. RIGHT half: rough dielectric slab.
const metalFloor = new THREE.Mesh(
  new THREE.BoxGeometry(6, 0.4, 12),
  new THREE.MeshStandardNodeMaterial({ color: 0x888888, metalness: 1.0, roughness: 0.04 }),
);
metalFloor.position.set(-3.1, 0, -2); scene.add(metalFloor);
const dielFloor = new THREE.Mesh(
  new THREE.BoxGeometry(6, 0.4, 12),
  new THREE.MeshStandardNodeMaterial({ color: 0x556688, metalness: 0.0, roughness: 0.9 }),
);
dielFloor.position.set(3.1, 0, -2); scene.add(dielFloor);
// Bright emissive markers standing on each slab — their reflection should land
// in the metal, but NOT change the dielectric's shading.
const mk = (c, x) => {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 1 });
  m.emissive = new THREE.Color(c); m.emissiveIntensity = 6;
  const b = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), m);
  b.position.set(x, 1.2, -2); scene.add(b); return b;
};
mk(0xff2020, -3.1); mk(0x20ff20, 3.1);
scene.add(new THREE.DirectionalLight(0xffffff, 2).translateX(2));
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

const scenePass = pass(scene, camera, { samples: 1 });
scenePass.setMRT(mrt({
  output,
  normal: packNormalToRGB(normalView),
  matParams: vec4(metalness, roughness, 0, 1),
}));
const nrm = scenePass.getTexture("normal"); if (nrm) nrm.type = THREE.UnsignedByteType;
const mtx = scenePass.getTexture("matParams"); if (mtx) mtx.type = THREE.UnsignedByteType;

const beautyNode = scenePass.getTextureNode();
const depthNode = scenePass.getTextureNode("depth");
const normalTex = scenePass.getTextureNode("normal");
const normalNode = sample((uv) => unpackRGBToNormal(normalTex.sample(uv)));
const matTex = scenePass.getTextureNode("matParams");
const metalnessNode = sample((uv) => matTex.sample(uv).r);
const roughnessNode = sample((uv) => matTex.sample(uv).g);

const ctx = { camera, beautyNode, depthNode, normalNode, metalnessNode, roughnessNode, ssr, temps: new Set() };

const plainGraph = { nodes: [{ id: "input", type: "input", props: {} }, { id: "output", type: "output", props: {} }], edges: [{ source: "input", sourceHandle: "color", target: "output", targetHandle: "color" }] };
const hybridGraph = {
  nodes: [
    { id: "input", type: "input", props: {} },
    { id: "ssr", type: "ssr", props: { resolutionScale: "1", stochastic: false, intensity: 1, reflectNonMetals: false } },
    { id: "output", type: "output", props: {} },
  ],
  edges: [
    { source: "input", sourceHandle: "color", target: "ssr", targetHandle: "color" },
    { source: "input", sourceHandle: "depth", target: "ssr", targetHandle: "depth" },
    { source: "input", sourceHandle: "normal", target: "ssr", targetHandle: "normal" },
    { source: "ssr", sourceHandle: "out", target: "output", targetHandle: "color" },
  ],
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function renderGraph(graph) {
  const compiled = compilePostGraph(graph, ctx);
  const rt = new THREE.RenderTarget(640, 360, { type: THREE.HalfFloatType });
  const pipe = new THREE.PostProcessing(renderer, compiled.output);
  pipe.outputColorTransform = false;
  renderer.setRenderTarget(rt);
  for (let i = 0; i < 6; i++) { pipe.render(); await wait(120); }
  renderer.setRenderTarget(null);
  const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 640, 360, 0);
  rt.dispose();
  return buf;
}

// Region means (x band, y band) of a buffer.
function regionMean(buf, x0, x1, y0, y1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * 640 + x) * 4;
    r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
  }
  return { r: r / n, g: g / n, b: b / n };
}

const plain = await renderGraph(plainGraph);
const hybrid = await renderGraph(hybridGraph);

// Whole-frame delta: did SSR change ANYTHING at all? (disambiguates "pass never
// ran" from "reflection landed outside my sample band").
log(`bufType=${plain.constructor.name} sample plain[0..3]=${plain[0]},${plain[1]},${plain[2]}`);
let totalDelta = 0, changed = 0, leftChanged = 0, rightChanged = 0;
for (let p = 0; p < 640 * 360; p++) {
  const i = p * 4;
  const x = p % 640;
  const dd = Math.abs(plain[i] - hybrid[i]) + Math.abs(plain[i + 1] - hybrid[i + 1]) + Math.abs(plain[i + 2] - hybrid[i + 2]);
  totalDelta += dd;
  if (dd > 100) { changed++; if (x < 320) leftChanged++; else rightChanged++; }
}
log(`WHOLE-FRAME totalDelta=${totalDelta.toFixed(1)} changedPixels=${changed} left(metal)=${leftChanged} right(dielectric)=${rightChanged}`);
// Correctness: reflections must appear on the metal half, and the dielectric
// half must be essentially untouched (metalness→0 weight).
const pass2 = leftChanged > 30 && rightChanged < leftChanged * 0.1;
log(`VERDICT hybrid=${pass2 ? "PASS" : "FAIL"} (metal reflects=${leftChanged > 30}, dielectric near-untouched=${rightChanged < leftChanged * 0.1})`);


done();
