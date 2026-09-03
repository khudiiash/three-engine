import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import {
  CUBEMAP_DEFAULTS,
  CUBEMAP_FACES,
  cubemapFacePaths,
  guessCubemapFaces,
  isCubemapComplete,
  normalizeCubemapDef,
} from "../src/engine/cubemapAsset.js";
import {
  SCENE_SETTINGS_DEFAULTS,
  applySettingsToScene,
  mergeSettings,
} from "../src/engine/sceneSettings.js";
import { sceneSkyRadiance } from "../src/modules/gi/giConfig.js";
import {
  ENVIRONMENT_EXTS,
  EQUIRECT_EXTS,
  getLoadedEnvironment,
  isCubemapPath,
  isEquirectPath,
  loadEnvironmentAsset,
} from "../src/engine/environmentAsset.js";

const FULL = {
  px: "sky/px.png",
  nx: "sky/nx.png",
  py: "sky/py.png",
  ny: "sky/ny.png",
  pz: "sky/pz.png",
  nz: "sky/nz.png",
};

test("face order matches three's CubeTextureLoader (+X −X +Y −Y +Z −Z)", () => {
  assert.deepEqual(
    CUBEMAP_FACES.map((f) => f.key),
    ["px", "nx", "py", "ny", "pz", "nz"],
  );
  assert.deepEqual(cubemapFacePaths({ faces: FULL }), [
    "sky/px.png",
    "sky/nx.png",
    "sky/py.png",
    "sky/ny.png",
    "sky/pz.png",
    "sky/nz.png",
  ]);
});

test("normalizes partial and malformed defs to all six slots", () => {
  const def = normalizeCubemapDef({ faces: { px: "a.png", bogus: "b.png", ny: 7 } });
  assert.deepEqual(Object.keys(def.faces).sort(), ["nx", "ny", "nz", "px", "py", "pz"]);
  assert.equal(def.faces.px, "a.png");
  assert.equal(def.faces.ny, ""); // non-string dropped
  assert.equal(def.faces.bogus, undefined);
  assert.deepEqual(normalizeCubemapDef(null).faces, CUBEMAP_DEFAULTS.faces);
});

test("completeness requires every face", () => {
  assert.equal(isCubemapComplete({ faces: FULL }), true);
  assert.equal(isCubemapComplete({ faces: { ...FULL, nz: "" } }), false);
  assert.equal(isCubemapComplete(CUBEMAP_DEFAULTS), false);
});

test("guesses faces from the usual filename conventions", () => {
  assert.deepEqual(
    guessCubemapFaces(["a/px.png", "a/nx.png", "a/py.png", "a/ny.png", "a/pz.png", "a/nz.png"]),
    {
      px: "a/px.png",
      nx: "a/nx.png",
      py: "a/py.png",
      ny: "a/ny.png",
      pz: "a/pz.png",
      nz: "a/nz.png",
    },
  );
  const worded = guessCubemapFaces([
    "sky_right.jpg",
    "sky_left.jpg",
    "sky_top.jpg",
    "sky_bottom.jpg",
    "sky_front.jpg",
    "sky_back.jpg",
  ]);
  assert.equal(worded.px, "sky_right.jpg");
  assert.equal(worded.ny, "sky_bottom.jpg");
  assert.equal(worded.nz, "sky_back.jpg");
  const posneg = guessCubemapFaces(["cube_posz.png", "cube_negz.png"]);
  assert.equal(posneg.pz, "cube_posz.png");
  assert.equal(posneg.nz, "cube_negz.png");
  // Unrecognizable names leave the slots for the user to fill in.
  assert.deepEqual(guessCubemapFaces(["one.png", "two.png"]), CUBEMAP_DEFAULTS.faces);
});

// ---------------------------------------------------------------------------
// Scene settings integration
// ---------------------------------------------------------------------------

function makeScene() {
  const scene = new THREE.Scene();
  return scene;
}
const ambient = () => new THREE.AmbientLight();

test("environment settings survive a partial merge", () => {
  const merged = mergeSettings(SCENE_SETTINGS_DEFAULTS, {
    environment: { cubemap: "Sky.cubemap", intensity: 2 },
  });
  assert.equal(merged.environment.cubemap, "Sky.cubemap");
  assert.equal(merged.environment.intensity, 2);
  // Untouched keys keep their defaults rather than vanishing.
  assert.equal(merged.environment.background, true);
  assert.equal(merged.environment.lighting, true);
  assert.equal(merged.environment.blur, 0);
  // A scene saved before cube maps existed still merges cleanly.
  const legacy = mergeSettings({ ...SCENE_SETTINGS_DEFAULTS, environment: undefined }, {});
  assert.deepEqual(legacy.environment, SCENE_SETTINGS_DEFAULTS.environment);
});

test("no cube map means the flat background color", () => {
  const scene = makeScene();
  applySettingsToScene({ ...SCENE_SETTINGS_DEFAULTS, background: "#112233" }, scene, ambient(), null);
  assert.equal(scene.background.getHexString(), "112233");
  assert.equal(scene.environment, null);
  // The colour is GI's sky too now, so the apply leaves the intensity scalar
  // its fallback reads — the same knob the HDRI path uses.
  assert.equal(scene.environmentIntensity, SCENE_SETTINGS_DEFAULTS.environment.intensity);
});

// ---------------------------------------------------------------------------
// GI's sky: the environment texture, else the background colour
//
// `sceneSkyRadiance` is what a GI ray brings back when it escapes the scene.
// Since 2026-08-30 the flat background colour is a sky, not just a backdrop —
// and the "Use for lighting" toggle is what keeps a scene at exactly zero when
// its author wants lamps only, which is how every GI fixture stays honest with
// the "sky = 0 asserts no light from nothing" gates.
// ---------------------------------------------------------------------------

test("GI sky: an environment texture gives neutral radiance at the scene intensity", () => {
  const scene = makeScene();
  scene.environment = new THREE.Texture();
  scene.environmentIntensity = 2;
  const out = sceneSkyRadiance(scene, new THREE.Color());
  assert.deepEqual([out.r, out.g, out.b], [2, 2, 2]);
});

test("GI sky: with no environment, the background colour lights with its chroma", () => {
  const scene = makeScene();
  scene.background = new THREE.Color("#ff0000"); // linear 1, 0, 0
  scene.environmentIntensity = 0.5;
  const out = sceneSkyRadiance(scene, new THREE.Color());
  assert.deepEqual([out.r, out.g, out.b], [0.5, 0, 0]);
});

test("GI sky: the colour fallback is gated on environment.lighting", () => {
  const scene = makeScene();
  scene.background = new THREE.Color("#ff0000");
  scene.environmentIntensity = 1;
  const off = sceneSkyRadiance(scene, new THREE.Color(), { lighting: false });
  assert.deepEqual([off.r, off.g, off.b], [0, 0, 0]);
  const on = sceneSkyRadiance(scene, new THREE.Color(), { lighting: true });
  assert.deepEqual([on.r, on.g, on.b], [1, 0, 0]);
});

test("GI sky: a texture background is not the colour sky", () => {
  // An HDRI shown as sky with lighting deliberately off stays visible in the
  // mirror term (visibility is not lighting), but the flat sky must not fire
  // from it — the fallback is for the flat COLOUR only.
  const scene = makeScene();
  scene.background = new THREE.Texture();
  const out = sceneSkyRadiance(scene, new THREE.Color(), { lighting: true });
  assert.deepEqual([out.r, out.g, out.b], [0, 0, 0]);
});

test("a component-owned environment texture is never clobbered by a settings apply", () => {
  // The HDRI EnvironmentComponent installs its own texture; touching an
  // unrelated scene setting must not wipe the sky out from under it.
  const scene = makeScene();
  const hdri = new THREE.Texture();
  scene.background = hdri;
  scene.environment = hdri;
  applySettingsToScene({ ...SCENE_SETTINGS_DEFAULTS, exposure: 2 }, scene, ambient(), null);
  assert.equal(scene.background, hdri);
  assert.equal(scene.environment, hdri);
});

test("a scene-owned environment texture is cleared when the cube map is removed", () => {
  const scene = makeScene();
  const ours = new THREE.Texture();
  ours.userData.sceneEnvironment = true;
  scene.background = ours;
  scene.environment = ours;
  applySettingsToScene({ ...SCENE_SETTINGS_DEFAULTS, background: "#000000" }, scene, ambient(), null);
  assert.equal(scene.environment, null);
  assert.equal(scene.background.isColor, true);
});

// ---------------------------------------------------------------------------
// The sky slot takes BOTH shapes
//
// `settings.environment.cubemap` accepts a `.cubemap` OR an equirectangular
// `.hdr`/`.exr`. Before it did, importing an HDRI spawned an entity to hold it
// instead, and Scene Settings — the panel with the intensity, rotation and blur
// knobs — read "None" while the viewport plainly showed an HDRI. There was no
// way to control the sky from the place that owns the sky.
// ---------------------------------------------------------------------------

test("the sky slot recognises both shapes, and nothing else", () => {
  assert.deepEqual(EQUIRECT_EXTS, ["hdr", "exr"]);
  assert.deepEqual(ENVIRONMENT_EXTS, ["cubemap", "hdr", "exr"]);

  assert.equal(isCubemapPath("Sky.cubemap"), true);
  assert.equal(isEquirectPath("Sky.cubemap"), false);
  // Windows separators and mixed case are what real project paths look like.
  assert.equal(isEquirectPath("C:\\Users\\me\\GAME\\PolyHaven\\Belfast Farmhouse_2k.HDR"), true);
  assert.equal(isEquirectPath("PolyHaven/studio.exr"), true);
  assert.equal(isCubemapPath("PolyHaven/studio.exr"), false);
  // A texture is not a sky: an equirect .png would decode but carry no HDR
  // range, and silently accepting one hides the mistake.
  assert.equal(isEquirectPath("sky.png"), false);
  assert.equal(isEquirectPath(""), false);
  assert.equal(isEquirectPath("noextension"), false);
});

test("loading never rejects — an unusable path resolves null", async () => {
  // Every caller is a settings apply, which must not be able to throw: a bad
  // path is an authoring state (a moved file, a half-typed name), and the
  // scene's job is to fall back to its flat background, not to break.
  assert.equal(await loadEnvironmentAsset(""), null);
  assert.equal(await loadEnvironmentAsset(null), null);
  assert.equal(await loadEnvironmentAsset("sky.png"), null); // not a sky format
  assert.equal(getLoadedEnvironment("never/loaded.hdr"), null);
  assert.equal(getLoadedEnvironment(""), null);
});

test("an HDRI in the sky slot merges and applies like a cube map", () => {
  const hdri = "PolyHaven/Belfast Farmhouse_2k.hdr";
  const merged = mergeSettings(SCENE_SETTINGS_DEFAULTS, {
    environment: { cubemap: hdri, intensity: 1.5, rotation: 90, blur: 0.25 },
  });
  assert.equal(merged.environment.cubemap, hdri);
  assert.equal(merged.environment.intensity, 1.5);
  assert.equal(merged.environment.rotation, 90);
  assert.equal(merged.environment.blur, 0.25);
  assert.equal(merged.environment.background, true);

  // Applying it before the decode lands leaves the flat background rather than
  // throwing — the texture arrives on a later tick and replaces it.
  const scene = makeScene();
  applySettingsToScene({ ...merged, background: "#334455" }, scene, ambient(), null);
  assert.equal(scene.background.getHexString(), "334455");
  assert.equal(scene.environment, null);
});
