import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { compilePostGraph, loadTRAA } from "/src/modules/postprocessing/postGraph.js";

const finish = (message) => {
  console.log(message);
  document.documentElement.dataset.done = "true";
};

try {
  // TRAANode explicitly requires MSAA to be disabled.
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(320, 180);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x20252c);
  const camera = new THREE.PerspectiveCamera(50, 320 / 180, 0.1, 30);
  camera.position.set(0, 1.5, 5);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 2));

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ color: 0x4f8cff }),
  );
  scene.add(cube);

  const scenePass = TSL.pass(scene, camera, { samples: 1 });
  scenePass.setMRT(
    TSL.mrt({
      output: TSL.output,
      normal: TSL.packNormalToRGB(TSL.normalView),
      velocity: TSL.velocity,
    }),
  );

  const traa = await loadTRAA();
  const graph = {
    nodes: [
      { id: "input", type: "input", props: {} },
      { id: "traa", type: "traa", props: {} },
      { id: "output", type: "output", props: {} },
    ],
    edges: [
      { source: "input", sourceHandle: "color", target: "traa", targetHandle: "color" },
      { source: "input", sourceHandle: "depth", target: "traa", targetHandle: "depth" },
      { source: "input", sourceHandle: "velocity", target: "traa", targetHandle: "velocity" },
      { source: "traa", sourceHandle: "out", target: "output", targetHandle: "color" },
    ],
  };
  const compiled = compilePostGraph(graph, {
    camera,
    beautyNode: scenePass.getTextureNode(),
    depthNode: scenePass.getTextureNode("depth"),
    normalNode: scenePass.getTextureNode("normal"),
    velocityNode: scenePass.getTextureNode("velocity"),
    traa,
  });
  const pipeline = new THREE.RenderPipeline(renderer, compiled.output);

  let frames = 0;
  renderer.setAnimationLoop(() => {
    cube.rotation.y += 0.02;
    pipeline.render();
    frames++;
    if (frames === 30) {
      renderer.setAnimationLoop(null);
      finish("TRAA-SMOKE PASS");
    }
  });
} catch (error) {
  console.error(error);
  finish(`TRAA-SMOKE FAIL ${error?.message ?? error}`);
}
