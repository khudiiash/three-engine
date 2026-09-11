import * as THREE from "three/webgpu";
import { Fn, attribute, diffuseColor, normalMap, normalView, texture, uniform, uv, vec3 } from "three/tsl";
import { getFoliageSurfaceTextures } from "./foliageSurfaceTexture.js";
import { foliageAnimatedPosition } from "./foliageWind.js";
import { SCENE_WIND_DEFAULTS, windVector } from "../../engine/vfx/clothWind.js";
export { setupFoliageImpostorMaterial } from "./foliageWind.js";

// Uniforms, never storage buffers: GI keeps its portable eight-buffer budget.
export const FOLIAGE_INTERACTION_LIMIT = 8;

export function createFoliageUniforms() {
  return {
    time: uniform(0), strength: uniform(0), speed: uniform(1), direction: uniform(new THREE.Vector3(1, 0, 0)),
    /** ⭐ HOW FAR the wind may bend a thing, 1 at the default 2 m/s scene wind.
     *  Scales every saturating cap in `foliageWind.js` — see `softLimit`. */
    reach: uniform(1),
    interaction: uniform(0), radius: uniform(1),
    gustStrength: uniform(.6), gustScale: uniform(12), turbulence: uniform(.25),
    colliders: Array.from({ length: FOLIAGE_INTERACTION_LIMIT }, () => ({
      center: uniform(new THREE.Vector4(0, 0, 0, 0)),
      x: uniform(new THREE.Vector4(1, 0, 0, 0)),
      y: uniform(new THREE.Vector4(0, 1, 0, 0)),
      z: uniform(new THREE.Vector4(0, 0, 1, 0)),
    })),
  };
}

/** The same unanimated surface is used by the neutral impostor atlas bake. */
export function createFoliageSurfaceMaterial(props = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: .88, metalness: 0, side: THREE.DoubleSide });
  const surfaces = getFoliageSurfaceTextures(props.species);
  if (surfaces) {
    const part = Fn(builder => builder.geometry.hasAttribute("treeLeafAxis") ? attribute("treeLeafAxis", "vec4").w : attribute("foliagePart", "float"))();
    const leaf = part.greaterThan(.5);
    const leafSample = texture(surfaces.leaves, uv());
    const barkSample = texture(surfaces.bark, uv());
    const sample = leaf.select(leafSample, barkSample);
    material.colorNode = vec3(sample.r);
    material.opacityNode = leaf.select(leafSample.a, 1);
    material.alphaTest = .5;
    // Three's depth/shadow override reads maskShadowNode but does not forward
    // opacityNode. This is the identical silhouette, including the same mips.
    material.maskShadowNode = material.opacityNode.greaterThan(.5);
    material.normalNode = normalMap(vec3(sample.g, sample.b, 1));
    material.roughnessNode = leaf.select(.76, .96);
    // A thin leaf transmits a small part of back-side DIRECT illumination.
    // lightColor already includes shadow visibility; this never self-emits,
    // alters GI, or adds a screen-space transmission pass. Ambient-only
    // impostor captures therefore keep a neutral albedo.
    material.setupLightingModel = function () {
      const model = THREE.MeshStandardNodeMaterial.prototype.setupLightingModel.call(this);
      const direct = model.direct;
      model.direct = function (light, builder) {
        direct.call(this, light, builder);
        const back = normalView.dot(light.lightDirection).negate().clamp(0, 1).mul(leaf.select(.14 / Math.PI, 0));
        light.reflectedLight.directDiffuse.addAssign(light.lightColor.mul(diffuseColor.rgb).mul(back));
      };
      return model;
    };
  }
  material.name = "Foliage · surface";
  return material;
}

export function createFoliageMaterial(uniforms, props = {}) {
  const material = createFoliageSurfaceMaterial(props);
  material.name = "Foliage · living surface";
  material.positionNode = foliageAnimatedPosition(uniforms, props);
  return material;
}

const passMaterials = new WeakMap();

function foliagePassMaterial(source, base) {
  let cache = passMaterials.get(source);
  if (!cache) {
    cache = new Map(); passMaterials.set(source, cache);
    const dispose = () => {
      for (const [original, entry] of cache) {
        original.removeEventListener("dispose", entry.dispose);
        entry.material.dispose();
      }
      cache.clear(); passMaterials.delete(source);
      source.removeEventListener("dispose", dispose);
    };
    source.addEventListener("dispose", dispose);
  }
  let entry = cache.get(base);
  if (!entry) {
    const material = base.clone();
    material.name = `${base.name} · Foliage`;
    const dispose = () => {
      material.dispose(); cache.delete(base);
      base.removeEventListener("dispose", dispose);
    };
    base.addEventListener("dispose", dispose);
    entry = { material, dispose }; cache.set(base, entry);
  }
  const material = entry.material;
  // Stable per (source, pass), independent of the draw order and Three's
  // shared override material version. Only an actual graph edit invalidates it.
  if (material.opacityNode !== source.opacityNode || material.normalNode !== source.normalNode || material.positionNode !== source.positionNode || material.side !== source.side || material.alphaTest !== source.alphaTest) {
    material.opacityNode = source.opacityNode;
    material.normalNode = source.normalNode;
    material.positionNode = source.positionNode;
    material.side = source.side;
    material.alphaTest = source.alphaTest;
    material.setupNormal = source.normalNode ? THREE.NodeMaterial.prototype.setupNormal : base.setupNormal;
    material.needsUpdate = true;
  }
  return material;
}

/** Three forwards positionNode into scene overrides, but not opacityNode,
 * normalNode or DoubleSide. Preserve the foliage surface in GI's position /
 * normal prepass: a billboard's transparent pixels must not become a wall.
 * A cached override per source material preserves stable shader identities. */
export function installFoliagePassHooks(mesh) {
  let saved = null;
  mesh.onBeforeRender = (_renderer, scene) => {
    const override = scene.overrideMaterial;
    if (!override?.isNodeMaterial || !override.name.startsWith("GI gbuffer")) return;
    saved = { scene, override };
    scene.overrideMaterial = foliagePassMaterial(mesh.material, override);
  };
  mesh.onAfterRender = () => {
    if (!saved) return;
    saved.scene.overrideMaterial = saved.override;
    saved = null;
  };
}

export function updateFoliageUniforms(uniforms, props, time, sceneWind = null) {
  const source = { ...SCENE_WIND_DEFAULTS, ...(sceneWind ?? {}) };
  const vector = windVector(source.vector);
  const force = Math.hypot(...vector);
  const gust = Math.max(0, Math.min(100, Number(source.gust) || 0));
  const total = force + gust;
  uniforms.time.value = time;
  uniforms.direction.value.set(...(force > 1e-6 ? vector : SCENE_WIND_DEFAULTS.vector)).normalize();
  // Scene wind is acceleration. The default 2 m/s² maps to unit response;
  // authored foliage knobs describe flexibility, never separate weather.
  uniforms.strength.value = props.wind ? Math.max(0, Number(props.windStrength) || 0) * total * .5 : 0;
  // ⭐⭐ THE WIND'S REACH, IN THE UNIT THE WEATHER SPEAKS: metres per second.
  //
  // `strength` is how HARD the wind pushes and it already scaled with the
  // scene wind — but every bend it drives saturates against a fixed cap, so
  // past a light breeze the extra force only made the same small motion arrive
  // sooner. A storm has to bend a tree FURTHER, not just faster. 1 at the
  // 2 m/s default (so every scene that never touches the weather looks exactly
  // as it did), 2.4 in the 7.5 m/s of a windy clear day, 4 in a gale.
  uniforms.reach.value = Math.min(4, .5 + total * .25);
  uniforms.speed.value = Math.max(0, Math.min(10, Number(source.gustFrequency) || 0));
  uniforms.gustStrength.value = Math.max(0, Number(props.windGustStrength ?? .6) || 0) * gust / Math.max(total, 1e-6);
  uniforms.gustScale.value = Math.max(.5, Number(props.windScale ?? 12) || 12);
  uniforms.turbulence.value = Math.max(0, Number(props.windTurbulence ?? .25) || 0);
  uniforms.interaction.value = props.interaction ? Math.max(0, Number(props.interactionStrength) || 0) : 0;
  uniforms.radius.value = Math.max(.01, Number(props.interactionRadius) || 1);
}
