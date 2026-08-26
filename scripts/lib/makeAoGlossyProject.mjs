// THE AO + GLOSSY RIG (2026-08-21) — the gate scene for the two indirect
// completions: GTAO on the indirect term (createGiGtaoPass) and the
// half-res glossy radiance chain (createSrcGlossyGather, §12.71b v2).
//
// One room, three subjects, one pose:
//
//   · a CEILING PANEL is the only light — a large emissive area, so the room
//     is lit by delivered indirect light and nothing else (no sun, no
//     environment, ambient 0 — the shadowed-bulb rule: a lit pixel is a
//     delivered pixel);
//   · a BOX on the floor — the AO subject. The statistic is the floor next
//     to its base against open floor, same material, same orientation: AO is
//     the only mechanism that darkens one and not the other, and
//     `__giAoOverride = { strength: 0 }` is a live uniform, so the A/B runs
//     inside ONE page (the only comparison the flicker instruments trust);
//   · a METAL SPHERE (metalness 1, roughness 0.3) — the glossy subject. With
//     the glossy chain off it renders as the §12.71b "pitch black metal in a
//     lit corridor" (IBL suppressed, specular slot compiled out); with it on,
//     the sphere shows the field. The discriminator is a cross-boot arm
//     because the hatch is build-time.
//
// Positions are EXPORTED (SUBJECTS) so the harness projects the true world
// points through the live camera instead of hard-coding crop rectangles —
// the flat-walls probe's own rule.
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

// `strength`, NOT `emissionStrength` — tslGraph's emission node names its
// float input `strength` (the storm rig lost a run to the wrong key).
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
const id = () => `aog${(n++).toString().padStart(3, "0")}`;
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

/** The measured pose: both subjects and their floor context in frame. */
export const POSE = { position: [0, 1.7, 2.7], target: [0, 0.6, -1.2] };

/**
 * The world points the harness measures, projected through the live camera:
 *  · `contact`  — floor at the box's front base (the AO ring);
 *  · `open`     — open floor, same material and orientation, away from
 *                 every object (the AO control);
 *  · `sphere`   — the metal sphere's camera-facing surface (glossy subject).
 */
export const SUBJECTS = {
  contact: [-0.9, 0.02, -0.55],
  open: [0.05, 0.02, 0.6],
  // The sphere's CENTRE — its projection lands inside the silhouette at any
  // pose, where a hand-derived surface point would drift off the limb.
  sphere: [0.9, 0.5, -1.0],
};

export async function makeAoGlossyProject(root, opts = {}) {
  const {
    quality = "high",
    panelStrength = 10,
    sphereRoughness = 0.3,
    toneMapping = "agx",
  } = opts;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });

  const mats = {
    // 0.6 linear-ish grey — bright enough that a bounce is measurable
    // (gi-flat-look-is-albedo: #707070 caps every bounce at +19%).
    Wall: bsdf("#cccccc"),
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
    mesh("WallLeft", "box", M("Wall"), [-3.05, 1.5, 0], [0.1, 3, 6]),
    mesh("WallRight", "box", M("Wall"), [3.05, 1.5, 0], [0.1, 3, 6]),
    // The only light: a 2x2 m ceiling panel over the subjects.
    mesh("Panel", "box", M("Panel"), [0, 2.94, -1.0], [2, 0.05, 2], {
      giMobility: "static", giTrace: "auto", giDynamic: "auto",
    }),
    // AO subject: a box whose base meets the floor in frame.
    mesh("ContactBox", "box", M("Wall"), [-0.9, 0.4, -1.0], [0.8, 0.8, 0.8], {
      giMobility: "static", giTrace: "auto", giDynamic: "auto",
    }),
    // Glossy subject: the §12.71b probe-sphere protocol's metal ball.
    mesh("MetalSphere", "sphere", M("Metal"), [0.9, 0.5, -1.0], [0.9, 0.9, 0.9], {
      giMobility: "static", giTrace: "auto", giDynamic: "auto",
    }),
  ];

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
        id: "aogRoot", name: "AoGlossyRig",
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{ type: "global-illumination", props: { enabled: true, quality } }],
        children: rig,
      },
    ],
  };

  await writeFile(path.join(root, "scenes", "Main.scene"), JSON.stringify(scene, null, 1));
  await writeFile(path.join(root, "project.json"), JSON.stringify({
    name: "GI-AoGlossy", version: 1,
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
