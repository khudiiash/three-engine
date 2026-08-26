// Runtime VXAO gate scene. The left slab is deliberately outside the measured
// camera frustum while remaining within the VXAO radius of `hiddenFloor`.
// The small centre box is visible and exists only to prove the existing
// screen-space contact AO still contributes when VXAO is enabled.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const material = (color, emission = 0) => ({
  color: "#ffffff", roughness: 1, metalness: 0, map: "",
  shaderGraph: emission > 0 ? {
    nodes: [
      { id: "em", type: "emission", props: { color, strength: emission }, position: { x: 220, y: 150 } },
      { id: "out", type: "output", props: {}, position: { x: 540, y: 150 } },
    ],
    edges: [{ id: "e", source: "em", sourceHandle: "out", target: "out", targetHandle: "surface" }],
  } : {
    nodes: [
      { id: "bsdf", type: "principledBsdf", props: { color, roughness: 1, metalness: 0 }, position: { x: 220, y: 150 } },
      { id: "out", type: "output", props: {}, position: { x: 540, y: 150 } },
    ],
    edges: [{ id: "e", source: "bsdf", sourceHandle: "out", target: "out", targetHandle: "surface" }],
  },
  pipeline: null,
});

let seq = 0;
const mesh = (name, geometry, materialPath, position, scale) => ({
  id: `vxao${String(seq++).padStart(3, "0")}`,
  name,
  position,
  rotation: [0, 0, 0],
  scale,
  viewOnly: false,
  enabledInEditor: true,
  enabledInGame: true,
  components: [{
    type: "mesh",
    props: {
      enabled: true,
      geometry,
      geometryAsset: "",
      material: materialPath,
      material2: "", material3: "", material4: "", material5: "",
      material6: "", material7: "", material8: "",
      castShadow: false,
      receiveShadow: true,
      giMobility: "static",
      giTrace: "auto",
      giDynamic: "auto",
    },
  }],
  children: [],
});

export const VXAO_POSE = { position: [0, 1.65, 4.2], target: [0, 0.12, -0.25] };

// Crop centres are projected through the live camera by the runner.
export const VXAO_SUBJECTS = {
  // Near the off-screen slab, but itself visible at the left edge.
  hiddenFloor: [-3.8, 0.015, 0.85],
  // Symmetric floor control, with no local occluder.
  openFloor: [2.4, 0.015, 0.85],
  // Floor just in front of the visible contact box.
  contact: [0.65, 0.015, -0.72],
  contactControl: [-0.45, 0.015, -0.25],
};

export async function makeVxaoProject(root, { quality = "high" } = {}) {
  seq = 0;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });
  await writeFile(path.join(root, "materials", "Diffuse.mat"), JSON.stringify(material("#bdbdbd"), null, 2));
  await writeFile(path.join(root, "materials", "Panel.mat"), JSON.stringify(material("#ffffff", 10), null, 2));
  const asset = (name) => `${root.replaceAll("\\", "/")}/materials/${name}.mat`;

  const children = [
    mesh("Floor", "box", asset("Diffuse"), [0, -0.05, 0], [9, 0.1, 9]),
    mesh("Ceiling", "box", asset("Diffuse"), [0, 3.05, 0], [9, 0.1, 9]),
    mesh("BackWall", "box", asset("Diffuse"), [0, 1.5, -4.55], [9, 3, 0.1]),
    mesh("FrontWall", "box", asset("Diffuse"), [0, 1.5, 4.55], [9, 3, 0.1]),
    mesh("RightWall", "box", asset("Diffuse"), [4.55, 1.5, 0], [0.1, 3, 9]),
    mesh("CeilingPanel", "box", asset("Panel"), [0, 2.94, -0.25], [3.2, 0.05, 3.2]),
    // Entirely left of the camera frustum at VXAO_POSE. Its nearest face is
    // about one metre from hiddenFloor, inside a useful voxel-AO radius.
    mesh("OffscreenOccluder", "box", asset("Diffuse"), [-4.8, 1.0, 0.85], [0.3, 2, 0.8]),
    mesh("ContactBox", "box", asset("Diffuse"), [0.65, 0.35, -1.1], [0.7, 0.7, 0.7]),
  ];

  const scene = {
    version: 1,
    name: "Main",
    settings: {
      background: "#000000",
      ambientColor: "#ffffff",
      ambientIntensity: 0,
      environment: { cubemap: "", background: false, lighting: false, intensity: 0, rotation: 0, blur: 0 },
      fog: { type: "none", color: "#000000", near: 10, far: 40, density: 0.02 },
      toneMapping: "agx",
      exposure: 1,
      shadows: false,
      renderer: { antialias: true, samples: 4, transparent: false },
      shadow: { type: "PCFSoftShadowMap", autoUpdate: true, needsUpdate: false },
      performance: {
        maxDevicePixelRatio: 1, renderScale: 1, dynamicResolution: false,
        targetFps: 120, volumeStepScale: 1,
        autoBatching: false, occlusionCulling: false,
      },
    },
    entities: [{
      id: "vxaoRoot",
      name: "VXAO Runtime Rig",
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      viewOnly: false, enabledInEditor: true, enabledInGame: true,
      components: [{ type: "global-illumination", props: { enabled: true, quality, aoRadius: 1 } }],
      children,
    }],
  };

  await writeFile(path.join(root, "scenes", "Main.scene"), JSON.stringify(scene, null, 1));
  await writeFile(path.join(root, "project.json"), JSON.stringify({
    name: "GI-VXAO-Probe",
    version: 1,
    lastScene: "scenes/Main.scene",
    mainScene: "scenes/Main.scene",
    modules: ["gi"],
    settings: {
      editor: {
        autosaveSeconds: 0,
        snapTranslate: 0.5, snapRotateDeg: 15, snapScale: 0.1,
        gridSize: 40, gridDivisions: 40, showGrid: false,
        layers: { gizmos: false, cursor3D: false, colliders: false, grid: false, stats: false, debugDraw: false, uiOverlay: false, virtualGeometry: false },
        keybindings: {},
      },
      scripts: { hotReload: false, reloadIntervalMs: 750 },
      rendering: { pixelRatioCap: 1 },
      build: { startScene: "", scenes: ["scenes/Main.scene"], target: "web", quality: "high" },
    },
  }, null, 2));
  return root;
}
