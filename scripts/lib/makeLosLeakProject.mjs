// THE LOS-LEAK RIG (2026-08-22, §15 unit U3) — the gate scene for LOS gather
// validity (`__giGatherLosWeight`).
//
// One 8×3×4 enclosed box, SEALED into two rooms by a 0.1 m partition at x=0.
// Room A (x<0) holds a strong RED ceiling panel; room B (x>0) a dim WHITE
// one. Nothing in A can reach B legitimately — the partition is solid and the
// shell is closed — so ANY red component on the partition's B face is a leak.
//
// The leak under test is the GATHER's: a pixel on the partition's B face
// interpolates corner probes within ~one probe spacing (~0.35 m), and the
// 0.1 m partition is thinner than that — some corners sit INSIDE room A,
// carrying A's red radiance, and a validity-blind gather mixes them in. The
// LOS march suppresses exactly those corners (the segment from the lifted B
// point to an A-side probe passes through the partition's occupied voxels).
//
// The discriminator is CHROMATIC, not just luminance: the leak crop's REDNESS
// (r / (r+g+b), linear) must drop when LOS arms, while a control crop lit
// only by B's own panel must hold. A hue ratio survives boot-to-boot exposure
// drift that a global mean does not (the harness-traps rule).
//
// ⚠ Thin-slab SHARED RECORDS are the caveat the plan names: if a probe's own
// tile already mixes the partition's two faces, LOS at the gather cannot
// un-mix it. The gate therefore asserts a REDUCTION, not a collapse — the
// residual after LOS is the shared-record half, measured, not guessed.
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
const id = () => `los${(n++).toString().padStart(3, "0")}`;
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

/**
 * In room B, high and tilted down so BOTH the partition face and a floor
 * patch sit inside the frame (first run's lesson: the horizontal pose put the
 * floor control ~47° below the view axis — out of frame, crop read 0.0000
 * and the ALIVE gate tripped on the instrument, not the field).
 */
export const POSE = { position: [3.4, 2.0, 0], target: [0, 0.7, 0] };

/**
 * The POPULATION pose, inside room A. Probe insertion is visibility-driven —
 * a camera that never looks into A never creates the A-side probes whose
 * retained red tiles ARE the leak (run 2 measured exactly that: redness ≡ 1/3
 * on every crop, nothing to suppress). The harness parks here first; under
 * world keys + locality retention (the U1 default) the A probes then SURVIVE
 * the move to B, which is precisely the post-U1 shape of the user's
 * "emissive light goes through walls" report.
 */
export const A_POSE = { position: [-2.2, 1.6, 0.8], target: [-0.4, 1.2, -0.3] };

/**
 * World points the harness projects through the live camera (the harness
 * asserts each lands IN FRAME — a subject nobody can see must fail loudly):
 *  · `leak` / `leakLow` — two spots on the partition's B face (x = +0.05).
 *    Their light is B's dim white plus whatever leaks; redness is the leak.
 *  · `control` — a B floor point in view, lit by B's own panel; must hold
 *    across arms (LOS may not eat legitimate open-view light).
 */
export const subjectsFor = (partition = 0.1) => ({
  leak: [partition / 2 + 0.01, 1.3, 0],
  leakLow: [partition / 2 + 0.01, 0.6, -0.7],
  control: [1.7, 0.02, -0.3],
});
export const SUBJECTS = subjectsFor(0.1);

export async function makeLosLeakProject(root, opts = {}) {
  const {
    quality = "high",
    redStrength = 24,
    dimStrength = 2.5,
    // 0.1 = the thin-slab case (faces SHARE corner probes at s≈0.35 — the
    // leak is the shared payload and the LOS weight cannot touch it, run 5's
    // finding). 0.5 = thicker than a cell: the faces get DISTINCT probe
    // cells and the LOS march is what separates them.
    partition = 0.1,
    // NONE, not agx: the gate's discriminator is CHROMATIC, and a filmic
    // curve desaturates dim colours — the first run read redness ≡ 1/3
    // (perfect grey) on a face lit by a red panel. Linear readback or the
    // statistic measures the tone mapper.
    toneMapping = "none",
  } = opts;
  n = 0;
  await mkdir(path.join(root, "scenes"), { recursive: true });
  await mkdir(path.join(root, "materials"), { recursive: true });

  const mats = {
    Wall: bsdf("#cccccc"),
    RedPanel: emissive("#ff3418", redStrength),
    DimPanel: emissive("#ffffff", dimStrength),
  };
  for (const [name, data] of Object.entries(mats)) {
    await writeFile(path.join(root, "materials", `${name}.mat`), JSON.stringify(data, null, 2));
  }
  const M = (name) => `${root.replaceAll("\\", "/")}/materials/${name}.mat`;

  const gi = { giMobility: "static", giTrace: "auto", giDynamic: "auto" };
  const rig = [
    mesh("Floor", "box", M("Wall"), [0, -0.05, 0], [8, 0.1, 4]),
    mesh("Ceiling", "box", M("Wall"), [0, 3.05, 0], [8, 0.1, 4]),
    mesh("WallBack", "box", M("Wall"), [0, 1.5, -2.05], [8, 3, 0.1]),
    mesh("WallFront", "box", M("Wall"), [0, 1.5, 2.05], [8, 3, 0.1]),
    mesh("WallLeft", "box", M("Wall"), [-4.05, 1.5, 0], [0.1, 3, 4]),
    mesh("WallRight", "box", M("Wall"), [4.05, 1.5, 0], [0.1, 3, 4]),
    // The partition — inner faces at exactly x = ±partition/2 (subjectsFor
    // assumes it).
    mesh("Partition", "box", M("Wall"), [0, 1.5, 0], [partition, 3, 4], gi),
    // Room A's red panel, far from the partition so its DIRECT term cannot
    // graze B through any numeric slit — the leak under test is the field's.
    mesh("RedPanel", "box", M("RedPanel"), [-2.4, 2.94, 0], [1.6, 0.05, 1.6], gi),
    // Room B's dim panel, behind/above the camera, out of the leak sight line.
    mesh("DimPanel", "box", M("DimPanel"), [2.8, 2.94, 0.9], [0.8, 0.05, 0.8], gi),
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
        id: "losRoot", name: "LosLeakRig",
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        viewOnly: false, enabledInEditor: true, enabledInGame: true,
        components: [{ type: "global-illumination", props: { enabled: true, quality } }],
        children: rig,
      },
    ],
  };

  await writeFile(path.join(root, "scenes", "Main.scene"), JSON.stringify(scene, null, 1));
  await writeFile(path.join(root, "project.json"), JSON.stringify({
    name: "GI-LosLeak", version: 1,
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
