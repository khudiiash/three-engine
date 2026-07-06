import * as THREE from "three/webgpu";
import { vec3, vec4 } from "three/tsl";

/**
 * Shared offscreen WebGPU renderer for per-node preview thumbnails: a
 * fullscreen quad whose colorNode is the tapped node output (coerced to
 * vec3), rendered at 64×64 and drawImage'd into each node's 2D canvas.
 * Renders are serialized through a queue; one renderer for the whole app.
 */
const SIZE = 64;
let state = null; // { renderer, scene, camera, material }
let queue = Promise.resolve();

async function ensure() {
  if (state) return state;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  renderer.setSize(SIZE, SIZE, false);
  await renderer.init();
  const material = new THREE.MeshBasicNodeMaterial();
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  state = { renderer, scene, camera, material };
  return state;
}

/** Renders `tslNode`'s value over UV space into `target` (a 2D canvas). */
export function renderNodeThumb(tslNode, target) {
  queue = queue.then(async () => {
    if (!tslNode || !target?.isConnected) return;
    try {
      const s = await ensure();
      s.material.colorNode = vec4(vec3(tslNode), 1);
      s.material.needsUpdate = true;
      await s.renderer.renderAsync(s.scene, s.camera);
      const ctx = target.getContext("2d");
      ctx.clearRect(0, 0, target.width, target.height);
      ctx.drawImage(s.renderer.domElement, 0, 0, target.width, target.height);
    } catch (err) {
      console.warn(`Node thumb render failed: ${err.message}`);
    }
  });
  return queue;
}
