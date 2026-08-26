// THE REFLECTION-PROBE RIG (2026-08-21, §14 unit R-B) — the gate scene for
// box-projected reflection probes.
//
// One room whose two side walls DISAGREE IN HUE — red at -X, green at +X —
// a ceiling panel as the only light, and a metal sphere in the middle. The
// discriminator is geometric: the sphere's camera-left limb reflects the red
// wall and its camera-right limb the green wall ONLY if the reflection term
// is world-anchored. The glossy field alone cannot produce that split (the
// field is nearly monochromatic — gi-probe-placement-and-colour-bleed), and
// at `medium` quality the exact BVH path is off entirely, so the hue split
// is the probe's signature and nobody else's.
//
// The probe arm and the no-probe arm are SEPARATE PROJECTS (probe existence
// is structural — it changes what materials compile), so the A/B is
// cross-boot, which is fine for a hue-geometry claim.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const bsdf = (color, roughness = 1, metalness = 0) => ({
  color: "#ffffff", roughness, metalness, map: "",
  shaderGraph: {
    nodes: [
      { id: "bsdf", type: "principledBsdf", props: { color, metalness, roughness, ior: 1.5 }, position: { x: 200, y: 120 } },
      { id: "output", type: "output", props: {}, position: { x: 560, y: 150 } },
    ],
    edges: [{ id: "e1", source: "bsdf", sourceHandle: "out", target: "output", targetHandle: "surface" }],
  },
  pipeline: null,
});

const emissive = (color, strength) => ({
  color: "#ffffff", roughness: 0.7, metalness: 0, map: "",
  shaderGraph: {
    nodes: [
      { id: "em", type: "emission", props: { color, strength }, position: { x: 228, y: 176 } },
      { id: "output", type: "output", props: {}, position: { x: 560, y: 150 } },
    ],
    edges: [{ id: "e1", source: "em", sourceHandle: "out", target: "output", targetHandle: "surface" }],
  },
  pipeline: null,
});

let n = 0;
const id = () => `rpb${(n++).toString().padStart(3, "0")}`;
const mesh = (name, geometry, material, position, scale, extra = {}) => ({
  id: id(), name, position, rotation: [0, 0, 0], scale,
  viewOnly: false, enabledInEditor: true, enabledInGame: true,
  components: [{
    type: "mesh",
    props: {
      enabled: true, geometry, geometryAsset: "", material,
      material2: "", material3: "", material4: "", material5: "", material6: "", material7: "", material8: "",
      castShadow: false, receiveShadow: true,
      ...extra,
    },
  }],
  children: [],
});

/** Sphere centred in frame, both limbs and both walls visible behind it. */
export const POSE = { position: [0, 1.5, 2.4], target: [0, 1.0, 0] };

/**
 * World points the harness projects through the live camera:
 *  · `sphereL` / `sphereR` — the metal sphere's front-left / front-right
 *    surface (their reflection vectors aim at the red / green wall);
 *  · `sphereC` — the centre (a luminance/stability control).
 */
export const SUBJECTS = {
  sphereL: [-0.32, 1.0, 0.32],
  sphereR: [0.32, 1.0, 0.32],
  sphereC: [0, 1.0, 0.45],
};

export async function makeReflProbeProject(root, opts = {}) {
  const {
    quality = "medium",
    probe = true,
    // Where the probe entity sits. The DEFAULT is the room centre (box faces
    // coincide with the walls — the case plain box projection already gets
    // right). The gate's `offset` arm displaces it so every box face
    // DISAGREES with the real walls: with depth-aware parallax (§15 U4a) the
    // reflection must not move, because the lookup reprojects by stored hit
    // distance, not by the box.
    probePos = [0, 1.5, 0],
    panelStrength = 10,
    sphereRoughness = 0.2,
    toneMapping = "agx",
  } = opts;
  n = 0;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });

  const mats = {
    Wall: bsdf("#cccccc"),
    // Saturated but not neon — the capture's luminance cap must not be the
    // thing shaping the measurement.
    WallRed: bsdf("#d84a30"),
    WallGreen: bsdf("#30d84a"),
    Metal: bsdf("#ffffff", sphereRoughness, 1),
    Panel: emissive("#ffffff", panelStrength),
  };
  for (const [name, data] of Object.entries(mats)) {
    await writeFile(path.join(root, "materials", `${name}.mat`), JSON.stringify(data, null, 2));
  }
  const M = (name) => `${root.replaceAll("\\", "/")}/materials/${name}.mat`;

  const rig = [
    mesh("Floor", "box", M("Wall"), [0, -0.05, 0], [6, 0.1, 6]),
    mesh("Ceiling", "box", M("Wall"), [0, 3.05, 0], [6, 0.1, 6]),
    mesh("WallBack", "box", M("Wall"), [0, 1.5, -3.05], [6, 3, 0.1]),
    mesh("WallFront", "box", M("Wall"), [0, 1.5, 3.05], [6, 3, 0.1]),
    // The hue discriminators.
    mesh("WallLeftRed", "box", M("WallRed"), [-3.05, 1.5, 0], [0.1, 3, 6]),
    mesh("WallRightGreen", "box", M("WallGreen"), [3.05, 1.5, 0], [0.1, 3, 6]),
    mesh("Panel", "box", M("Panel"), [0, 2.94, 0], [2, 0.05, 2], {
      giMobility: "static", giTrace: "auto", giDynamic: "auto",
    }),
    mesh("MetalSphere", "sphere", M("Metal"), [0, 1.0, 0], [0.9, 0.9, 0.9], {
      giMobility: "static", giTrace: "auto", giDynamic: "auto",
    }),
  ];
  if (probe) {
    rig.push({
      id: id(), name: "RoomProbe",
      position: probePos, rotation: [0, 0, 0], scale: [1, 1, 1],
      viewOnly: false, enabledInEditor: true, enabledInGame: true,
      components: [{ type: "reflection-probe", props: { enabled: true, size: [6, 3, 6] } }],
      children: [],
    });
  }

  const scene = {
    version: 1,
    name: "Main",
    settings: {
      background: "#000000",
      ambientColor: "#ffffff",
      ambientIntensity: 0,
      environment: { cubemap: "", background: false, lighting: false, intensity: 0, rotation: 0, blur: 0 },
      fog: { type: "none", color: "#f2f2f2", near: 10, far: 40, density: 0.02 },
      toneMapping,
      exposure: 1,
      shadows: true,
      renderer: { antialias: true, samples: 4, transparent: false },
      shadow: { type: "PCFSoftShadowMap", autoUpdate: true, needsUpdate: false },
      performance: {
        maxDevicePixelRatio: 1, renderScale: 1, dynamicResolution: false,
        targetFps: 120, volumeStepScale: 1,
        autoBatching: false, occlusionCulling: false,
      },
    },
    entities: [
      {
        id: "rpbRoot", name: "ReflProbeRig",
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{ type: "global-illumination", props: { enabled: true, quality } }],
        children: rig,
      },
    ],
  };

  await writeFile(path.join(root, "scenes", "Main.scene"), JSON.stringify(scene, null, 1));
  await writeFile(path.join(root, "project.json"), JSON.stringify({
    name: "GI-ReflProbe", version: 1,
    lastScene: "scenes/Main.scene", mainScene: "scenes/Main.scene",
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
