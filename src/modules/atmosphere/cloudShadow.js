import * as THREE from "three/webgpu";
import { Fn, dot, float, max, positionWorld, shadow, texture, uniform, vec2 } from "three/tsl";
import { CLOUD_OCTAVE_WEIGHTS, cloudHardness, cloudThreshold } from "./skyNode.js";
import { getCloudNoiseTexture } from "./cloudNoise.js";

/**
 * ⭐⭐ THE CLOUD'S SHADOW ON THE GROUND.
 *
 * The single strongest thing a sky does to a landscape, and the reason Ghost
 * of Tsushima's fields read as weather rather than as lighting: the shadows of
 * the clouds MOVE ACROSS THE WORLD. A hill is in shade, then the edge passes
 * and it is not, and nothing about the scene changed except the sky.
 *
 * ## Where it hooks: `light.shadow.shadowNode`, not the materials
 *
 * three multiplies a light's colour by its shadow node (`AnalyticLightNode`:
 * `colorNode.mul(shadowNode)`), and `light.shadow.shadowNode` is the documented
 * override for it. So the cloud attenuation is folded into the SUN'S OWN shadow
 * term — one node on one light, reaching every surface that light touches.
 *
 * ⛔ THE ALTERNATIVE WAS MUCH WORSE. Attenuating the sun inside every material's
 * lighting model would mean patching every material a second time (each patch
 * is a pipeline recompile), would apply to every light rather than the sun, and
 * would have to be undone the same way. This is one assignment.
 *
 * ⚠ AND IT MUST WRAP, NOT REPLACE. Setting a custom `shadowNode` makes three
 * skip building the real shadow map's node entirely — the scene would lose all
 * its cast shadows. `shadow(light, light.shadow)` constructs exactly the node
 * three would have built, so the product is "in the geometry's shadow AND under
 * a cloud". A light that casts no shadow gets the cloud term alone.
 */

/** Metres to the base of the deck — the same altitude `skyNode` draws it at. */
export const CLOUD_BASE = 1400;

export function createCloudShadowUniforms() {
  return {
    /** 0 disables the whole term (the node stays compiled and multiplies out). */
    strength: uniform(0),
    coverage: uniform(0),
    density: uniform(0.5),
    /** Tiles per metre and the wind's drift — shared with the sky's own. */
    scale: uniform(1 / 5200),
    offset: uniform(new THREE.Vector2()),
    /** Unit vector TOWARDS the sun. */
    sunDirection: uniform(new THREE.Vector3(0, 1, 0)),
  };
}

/**
 * 1 in full sun, → 0 under a cloud. Two texture taps, evaluated only where the
 * sun's light is being computed.
 */
export const cloudShadowNode = /*@__PURE__*/ Fn(([u]) => {
  // A/B hatch: a flat 0.25 proves whether this node reaches the shader at all,
  // independently of whether the cloud maths is right.
  if (globalThis.__atmosphereFlatShadow) return float(0.25);
  // A/B hatch: stripes in world X. If the ground comes out striped,
  // `positionWorld` is live inside a light's shadow node; if it comes out flat,
  // it is not, and the sample point is the same for every fragment.
  if (globalThis.__atmosphereStripeShadow) return positionWorld.x.mul(0.12).fract().step(0.5).mul(0.8).add(0.2);
  // Walk from this surface towards the sun until the ray leaves the deck. A
  // low sun therefore throws its cloud shadows far across the world, which is
  // exactly what a late afternoon looks like.
  const height = max(u.sunDirection.y, 0.08);
  const distance = max(float(CLOUD_BASE).sub(positionWorld.y), 0).div(height);
  const point = positionWorld.xz.add(u.sunDirection.xz.mul(distance));
  // ⛔ `.level(0)`, AND IT IS THE WHOLE FEATURE. The sky's own `cloudFbm` uses
  // an implicit-derivative sample, which is what gives the cloud layer its free
  // mip antialiasing at the horizon — but a light's shadow branch is not a
  // plain fragment context, and the sample came back as ZERO there. Zero minus
  // the threshold clamps to zero, so the shadow was silently absent while every
  // uniform, the node itself and `positionWorld` were all provably live. An
  // explicit level is the fix, and the mips are no loss: a cloud shadow is
  // kilometres across.
  const uvNode = point.mul(u.scale).add(u.offset);
  const noise = texture(getCloudNoiseTexture());
  const shape = dot(noise.sample(uvNode).level(0), CLOUD_OCTAVE_WEIGHTS).mul(0.62)
    .add(dot(noise.sample(uvNode.mul(0.31).add(vec2(3.7, 1.9))).level(0), CLOUD_OCTAVE_WEIGHTS).mul(0.38));
  const density = shape.sub(cloudThreshold(u.coverage)).mul(cloudHardness(u.density)).clamp(0, 1);
  return float(1).sub(density.mul(u.strength)).clamp(0, 1);
});

const INSTALLED = Symbol("atmosphere.cloudShadow");

/**
 * Folds the cloud term into a light's shadow node.
 *
 * ⚠ ONCE PER LIGHT, AND EARLY. `AnalyticLightNode` caches the composed shadow
 * colour the first time it sets a light up, so changing `shadow.shadowNode`
 * after that light has been compiled does nothing until something else forces
 * a rebuild. Installing at attach — before the first frame that light is
 * drawn — is what makes it take.
 */
export function installCloudShadow(light, uniforms) {
  if (!light?.shadow || light[INSTALLED]) return false;
  // ⛔ NOT A GI-TRACED LIGHT. The GI module OWNS `shadow.shadowNode` on the
  // lights it claims (`#acquireLightShadowNode`) and re-assigns it whenever it
  // re-syncs, so a wrapper here would be dropped without a sound — and fighting
  // it would mean a `light.dispose()` every frame. The caller falls back to the
  // CPU-sampled global dimming for those, which needs no seam at all.
  if (light.userData?.giShadowMode === "gi") return false;
  const previous = light.shadow.shadowNode;
  if (previous !== undefined && previous !== null) return false;
  const cloud = cloudShadowNode(uniforms);
  // A light that casts real shadows needs three's own node rebuilt explicitly,
  // or setting this at all would silently delete every cast shadow in the scene.
  const real = light.castShadow ? shadow(light, light.shadow) : null;
  const composed = real ? real.mul(cloud) : cloud;
  if (globalThis.__atmosphereLogShadow) {
    console.log(`[atmosphere] real=${real?.constructor?.name} composed=${composed?.constructor?.name} cloud=${cloud?.constructor?.name}`);
  }
  light.shadow.shadowNode = composed;
  // ⚠ THE EVENT, NOT `light.dispose()`. `AnalyticLightNode` caches the composed
  // shadow branch against the light's uuid and rebuilds it ONLY when the light
  // dispatches 'dispose' — so without this the assignment above does nothing to
  // a light that has already been drawn once.
  //
  // ⛔ BUT `DirectionalLight.dispose()` ALSO CALLS `shadow.dispose()`, which
  // destroys the shadow MAP — and the postprocessing module's god rays capture
  // `light.shadow.map.depthTexture` when their graph is built (see
  // `findGodraysLight`). Destroying it under them is a pass reading a dead
  // texture: "[Buffer …] used in submit while destroyed", and the sun's shafts
  // vanishing the moment a post-process is on the camera. Only
  // `AnalyticLightNode` listens for this event, so dispatching it directly does
  // exactly the one thing needed and nothing else.
  if (light.castShadow) light.shadow.autoUpdate = true;
  light.dispatchEvent({ type: "dispose" });
  light[INSTALLED] = { previous };
  if (globalThis.__atmosphereLogShadow) {
    console.log(`[atmosphere] installed castShadow=${light.castShadow} node=${light.shadow.shadowNode?.constructor?.name} hasMul=${typeof cloud.mul} shadowFn=${typeof shadow}`);
  }
  return true;
}

/** Puts the light's shadow node back exactly as it was found. */
export function removeCloudShadow(light) {
  const state = light?.[INSTALLED];
  if (!state) return false;
  // `undefined`, not null: three tests `shadowNode !== undefined` to decide
  // whether a custom node overrides the shadow map, so null would leave the
  // light with a shadow branch of literal null.
  light.shadow.shadowNode = state.previous;
  delete light[INSTALLED];
  // The event only — see `installCloudShadow` for why never `dispose()`.
  if (light.castShadow) light.shadow.autoUpdate = true;
  light.dispatchEvent({ type: "dispose" });
  return true;
}
