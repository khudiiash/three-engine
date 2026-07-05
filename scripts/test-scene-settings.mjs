// Headless check of scene-settings apply + serialize roundtrip
// (node scripts/test-scene-settings.mjs).
import * as THREE from "three/webgpu";
import { Engine, serializeScene, deserializeScene, SCENE_SETTINGS_DEFAULTS } from "../src/engine/index.js";

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
};

const engine = new Engine();

assert(engine.settings.background === SCENE_SETTINGS_DEFAULTS.background, "defaults applied at construction");
assert(engine.scene.fog === null, "no fog by default");
assert(engine.ambientLight.intensity === SCENE_SETTINGS_DEFAULTS.ambientIntensity, "ambient light present");

engine.applySettings({
  background: "#101020",
  ambientIntensity: 0.8,
  fog: { type: "linear", color: "#334455", near: 5, far: 50 },
  toneMapping: "aces",
  exposure: 1.4,
  shadows: false,
});
assert(engine.scene.background.getHexString() === "101020", "background applied");
assert(engine.scene.fog instanceof THREE.Fog && engine.scene.fog.near === 5, "linear fog applied");
assert(engine.settings.fog.density === SCENE_SETTINGS_DEFAULTS.fog.density, "fog patch merges, keeps other keys");
assert(engine.ambientLight.intensity === 0.8, "ambient intensity applied");

engine.applySettings({ fog: { type: "exp2", density: 0.05 } });
assert(engine.scene.fog instanceof THREE.FogExp2 && engine.scene.fog.density === 0.05, "exp2 fog applied");

const json = serializeScene(engine);
assert(json.settings.toneMapping === "aces" && json.settings.exposure === 1.4, "settings serialized");

const engine2 = new Engine();
deserializeScene(engine2, JSON.parse(JSON.stringify(json)));
assert(engine2.settings.background === "#101020", "settings roundtrip through deserialize");
assert(engine2.scene.fog instanceof THREE.FogExp2, "fog restored on load");

engine2.clear();
assert(engine2.settings.background === SCENE_SETTINGS_DEFAULTS.background, "clear() resets to defaults");
assert(engine2.scene.fog === null, "clear() removes fog");

// Old scene without settings loads with defaults.
const engine3 = new Engine();
deserializeScene(engine3, { version: 1, name: "Legacy", entities: [] });
assert(engine3.settings.toneMapping === SCENE_SETTINGS_DEFAULTS.toneMapping, "legacy scenes get defaults");

console.log("All scene-settings checks passed.");
