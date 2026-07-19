import * as THREE from "three/webgpu";
import { Engine, registerBuiltInComponents } from "/src/engine/index.js";

const result = document.getElementById("result");
const finish = (ok, message) => {
  result.textContent = `${ok ? "PASS" : "FAIL"}\n${message}`;
  console.log(`CSM-SMOKE ${ok ? "PASS" : "FAIL"} ${message}`);
  document.documentElement.dataset.done = "true";
};

try {
  registerBuiltInComponents();
  const engine = new Engine();
  await engine.init(document.getElementById("canvas"));
  engine.setSize(640, 360);
  engine.renderer.shadowMap.enabled = true;
  engine.renderer.shadowMap.type = THREE.PCFShadowMap;

  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 80);
  camera.position.set(10, 9, 14);
  camera.lookAt(0, 1, 0);
  engine.camera = camera;
  engine.scene.add(camera);
  engine.scene.background = new THREE.Color(0x9aa3ad);
  engine.scene.add(new THREE.AmbientLight(0xffffff, 0.15));

  const material = new THREE.MeshStandardNodeMaterial({
    color: 0xd8d8d8,
    roughness: 0.9,
    metalness: 0,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), material);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  engine.scene.add(floor);

  const caster = new THREE.Mesh(new THREE.BoxGeometry(3, 5, 3), material);
  caster.position.set(0, 2.5, 0);
  caster.castShadow = true;
  caster.receiveShadow = true;
  engine.scene.add(caster);

  const sunEntity = engine.createEntity({ name: "CSM Sun" });
  sunEntity.object3D.rotation.set(-0.85, -0.65, 0);
  const light = sunEntity.addComponent("light", {
    kind: "directional",
    intensity: 3,
    castShadow: true,
    shadowMapType: "PCFShadowMap",
    shadowMapWidth: 1024,
    shadowMapHeight: 1024,
    shadowCamFar: 100,
    csm: true,
    csmCascades: 4,
    csmMaxFar: 1000,
    csmLightMargin: 200,
    csmFade: true,
  });

  const renderTarget = new THREE.RenderTarget(640, 360);
  const render = async () => {
    for (const callback of engine.preRenderCallbacks) callback();
    engine.renderer.setRenderTarget(renderTarget);
    engine.renderer.render(engine.scene, camera);
    engine.renderer.setRenderTarget(null);
    return engine.renderer.readRenderTargetPixelsAsync(renderTarget, 0, 0, 640, 360);
  };

  // First render composes and initializes the CSM graph; the second updates
  // its now-created cascade frustums before producing the reference image.
  await render();
  const shadowed = await render();
  const expectedFar = 1400;
  const cascadeFars = light.csm?.lights.map((cascade) => cascade.shadow.camera.far) ?? [];
  if (cascadeFars.length !== 4 || cascadeFars.some((far) => far !== expectedFar)) {
    throw new Error(`cascade far planes ${JSON.stringify(cascadeFars)}, expected four at ${expectedFar}`);
  }
  const cascadeRadii = light.csm.lights.map((cascade) => cascade.shadow.radius);
  const cascadeBiases = light.csm.lights.map((cascade) => cascade.shadow.bias);
  const cascadeNormalBiases = light.csm.lights.map((cascade) => cascade.shadow.normalBias);
  if (!(cascadeRadii[0] < cascadeRadii[1] && cascadeRadii[1] < cascadeRadii[3])) {
    throw new Error(`cascade radii are not near-to-far ${JSON.stringify(cascadeRadii)}`);
  }
  if (Math.abs(cascadeBiases[0]) >= Math.abs(cascadeBiases[3])) {
    throw new Error(`near cascade bias was not reduced ${JSON.stringify(cascadeBiases)}`);
  }
  if (cascadeNormalBiases[0] >= cascadeNormalBiases[3]) {
    throw new Error(`near normal bias was not reduced ${JSON.stringify(cascadeNormalBiases)}`);
  }
  const firstSplit = light.csm.breaks[0];
  if (!(firstSplit < 0.05)) {
    throw new Error(`first practical split wastes near detail: ${firstSplit}`);
  }

  caster.castShadow = false;
  for (const cascade of light.csm.lights) cascade.shadow.needsUpdate = true;
  const unshadowed = await render();
  let changedPixels = 0;
  let totalDelta = 0;
  for (let i = 0; i < shadowed.length; i += 4) {
    const delta =
      Math.abs(shadowed[i] - unshadowed[i]) +
      Math.abs(shadowed[i + 1] - unshadowed[i + 1]) +
      Math.abs(shadowed[i + 2] - unshadowed[i + 2]);
    if (delta > 12) changedPixels++;
    totalDelta += delta;
  }
  if (changedPixels < 100 || totalDelta < 10000) {
    throw new Error(`no visible cascade shadow (changed=${changedPixels}, delta=${totalDelta})`);
  }

  // Exercise the editor's live graph swap as well. A cached
  // AnalyticLightNode must not keep sampling the disposed pre-toggle CSM.
  caster.castShadow = true;
  light.setProp("csm", false);
  await render();
  light.setProp("csm", true);
  await render();
  const rebuiltShadowed = await render();
  const rebuiltFars = light.csm?.lights.map((cascade) => cascade.shadow.camera.far) ?? [];
  if (rebuiltFars.length !== 4 || rebuiltFars.some((far) => far !== expectedFar)) {
    throw new Error(`rebuilt cascade far planes ${JSON.stringify(rebuiltFars)}`);
  }
  let rebuiltDelta = 0;
  for (let i = 0; i < rebuiltShadowed.length; i += 4) {
    rebuiltDelta +=
      Math.abs(rebuiltShadowed[i] - unshadowed[i]) +
      Math.abs(rebuiltShadowed[i + 1] - unshadowed[i + 1]) +
      Math.abs(rebuiltShadowed[i + 2] - unshadowed[i + 2]);
  }
  if (rebuiltDelta < 10000) throw new Error(`CSM toggle lost its shadow (delta=${rebuiltDelta})`);

  renderTarget.dispose();
  light.onDetach();
  engine.renderer.dispose();
  finish(
    true,
    `4 cascades, far=${expectedFar}, radii=${cascadeRadii.map((v) => v.toFixed(2))}, firstSplit=${firstSplit.toFixed(3)}, changed=${changedPixels}, delta=${totalDelta}, toggleDelta=${rebuiltDelta}`,
  );
} catch (error) {
  finish(false, error?.stack || error);
}
