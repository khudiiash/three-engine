// THE HIT-SHADE RIG (2026-08-22, §14 unit R-A) — the gate scene for exact-
// reflection hit shading in its own pass (createGiBvhHitShade).
//
// One room at ULTRA (exactReflections on), a ceiling panel as the only
// light, a MIRROR WALL at -Z, and a wide occluder box standing on the floor.
// The box puts a floor region into deep emitter shadow. The discriminator is
// THE SHADOW INSIDE THE MIRROR: with traced hit shadows (the R-A default)
// the mirror's image of the shadowed floor is darker than its image of the
// lit floor; with `__giHitEmitterShadows = false` (the pre-R-A dense
// behaviour) every hit takes full unshadowed emitter light and the two
// mirror crops read nearly equal — the "washed out solid colors" bug, made
// into a statistic.
//
// The two arms are CROSS-BOOT (the hatch is read at kernel build time).
//
// CROP GEOMETRY: the harness projects WORLD points through the live camera.
// For a point Q seen IN the mirror (plane z = -3, inner face), projecting
// its mirror image Q' = (qx, qy, -6 - qz) lands on exactly the screen pixel
// where the mirror shows Q — no plane intersection needed. All positions
// below were checked against the occluder so both mirror sight lines clear
// the box while the shadow sample stays fully occluded from the 2×2 panel.
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
const id = () => `hsr${(n++).toString().padStart(3, "0")}`;
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

/** Offset to -X so sight lines to the mirror's +X region clear the box. */
export const POSE = { position: [-1.6, 1.5, 2.4], target: [0.3, 0.8, -3] };

/**
 * World points the harness projects through the live camera:
 *  · `mirrorShadow` — mirror image of the floor point (1.7, 0.02, 0), which
 *    the box occludes from the ENTIRE ceiling panel (all panel corners
 *    checked against the box's [0.4,1.6]×[1.2] profile);
 *  · `mirrorLit`    — mirror image of the fully lit floor point (-1.8, 0.02, 0.5);
 *  · `directLit`    — that lit floor point itself (a non-mirror control).
 */
export const SUBJECTS = {
  mirrorShadow: [1.7, 0.02, -6.0],
  mirrorLit: [-1.8, 0.02, -6.5],
  directLit: [-1.8, 0.02, 0.5],
};

export async function makeHitShadeProject(root, opts = {}) {
  const {
    quality = "ultra",
    panelStrength = 10,
    mirrorRoughness = 0.03,
    toneMapping = "agx",
  } = opts;
  n = 0;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });

  const mats = {
    Wall: bsdf("#cccccc"),
    Mirror: bsdf("#ffffff", mirrorRoughness, 1),
    Panel: emissive("#ffffff", panelStrength),
  };
  for (const [name, data] of Object.entries(mats)) {
    await writeFile(path.join(root, "materials", `${name}.mat`), JSON.stringify(data, null, 2));
  }
  const M = (name) => `${root.replaceAll("\\", "/")}/materials/${name}.mat`;

  const rig = [
    mesh("Floor", "box", M("Wall"), [0, -0.05, 0], [6, 0.1, 6]),
    mesh("Ceiling", "box", M("Wall"), [0, 3.05, 0], [6, 0.1, 6]),
    // The mirror wall — inner face at exactly z = -3.0 (SUBJECTS assume it).
    mesh("MirrorWall", "box", M("Mirror"), [0, 1.5, -3.05], [6, 3, 0.1]),
    mesh("WallFront", "box", M("Wall"), [0, 1.5, 3.05], [6, 3, 0.1]),
    mesh("WallLeft", "box", M("Wall"), [-3.05, 1.5, 0], [0.1, 3, 6]),
    mesh("WallRight", "box", M("Wall"), [3.05, 1.5, 0], [0.1, 3, 6]),
    mesh("Panel", "box", M("Panel"), [0, 2.94, 0], [2, 0.05, 2], {
      giMobility: "static", giTrace: "auto", giDynamic: "auto",
    }),
    // The occluder: wide in x so the floor at (1.7, 0, 0) sees NO part of
    // the panel — a deep shadow, not a penumbra fringe.
    mesh("Occluder", "box", M("Wall"), [1.0, 0.6, 0], [1.2, 1.2, 0.8], {
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
        id: "hsrRoot", name: "HitShadeRig",
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{ type: "global-illumination", props: { enabled: true, quality } }],
        children: rig,
      },
    ],
  };

  await writeFile(path.join(root, "scenes", "Main.scene"), JSON.stringify(scene, null, 1));
  await writeFile(path.join(root, "project.json"), JSON.stringify({
    name: "GI-HitShade", version: 1,
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
