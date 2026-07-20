// GI → material injection (Phase 6).
//
// The engine has no prior custom-light convention, so this creates one the
// same way three wires its own lights: a Light subclass paired with an
// AnalyticLightNode via `renderer.library.addLight(nodeClass, lightClass)`.
// The node's setup does `context.irradiance.addAssign(...)` — exactly what
// three's AmbientLightNode does — so every lit material in the scene
// receives the cascade irradiance with zero per-material changes, and
// three's lights-hash mechanism recompiles materials automatically when the
// light instance is added/replaced.
//
// The irradiance expression is createIrradianceGather()'s canonical sampler
// (shared with the debug gizmos) evaluated at the fragment: sample point is
// normal-offset off the surface (same leak control as the Phase 4 harness),
// direction is the shading normal (normal maps included).
import * as THREE from "three/webgpu";
import {
  If,
  cameraPosition,
  float,
  materialRoughness,
  mix,
  normalWorld,
  positionWorld,
  reflect,
  smoothstep,
  step,
  cross,
  uniform,
  vec3,
} from "three/tsl";

// Fixed emitter slot count: slots are compiled into the material shader, so
// a constant count means emitter add/remove within the budget needs no
// material recompile (unused slots have radius 0 → zero contribution).
export const MAX_EMITTERS = 2;
// World-units cap on shadow reach — beyond this the emitter contribution
// is left to the (unshadowed) cascade transport.
const SHADOW_RANGE = 12;

export class GICascadeLight extends THREE.Light {
  constructor() {
    super(0xffffff, 1);
    this.isGICascadeLight = true;
    this.type = "GICascadeLight";
    // Set by GISystem after construction: (P, N) => vec3 irradiance.
    this.gatherFn = null;
    // Optional: (P, R) => vec3 radiance along R — feeds indirect specular.
    // `radianceFn` = mid-angular cascade (soft gloss), `radianceSharpFn` =
    // finest-angular cascade (low-roughness reflections).
    this.radianceFn = null;
    this.radianceSharpFn = null;
    // Optional emissive-area-shadow inputs (see GISystem #updateEmitters):
    // emitterSlots = MAX_EMITTERS × {center, radius, color} uniforms;
    // shadowTraceFn = voxel DDA (origin, dir, maxT) => { rad, t }.
    this.emitterSlots = null;
    this.shadowTraceFn = null;
    this.shadowMargin = 0.3;
    // Live-tunable without recompiles.
    this.intensityUniform = uniform(1);
    this.normalOffset = 0.35;
  }
}

export class GICascadeLightNode extends THREE.AnalyticLightNode {
  static get type() {
    return "GICascadeLightNode";
  }

  constructor(light = null) {
    super(light);
  }

  setup(builder) {
    const light = this.light;
    if (!light?.gatherFn) return;
    // Face-forward toward the camera: a double-sided plane seen from its
    // back face would otherwise gather the wrong hemisphere and render
    // dark from inside a room whose wall normal points outward.
    const facing = step(0, normalWorld.dot(cameraPosition.sub(positionWorld))).mul(2).sub(1);
    const N = normalWorld.mul(facing);
    const samplePoint = positionWorld.add(N.mul(light.normalOffset));
    const irradiance = vec3(light.gatherFn(samplePoint, N)).mul(light.intensityUniform);
    builder.context.irradiance.addAssign(irradiance);

    // Glossy GI reflections: cascade radiance along the reflection vector →
    // context.radiance, which PhysicalLightingModel consumes as indirect
    // specular with full Fresnel/roughness weighting. Coexists with SSR
    // (SSR wins where it hits; this fills everything else).
    if (light.radianceFn && builder.context.radiance) {
      const incident = positionWorld.sub(cameraPosition).normalize();
      const reflected = reflect(incident, N);
      const roughness = materialRoughness.clamp(0, 1);
      const softLookup = vec3(light.radianceFn(samplePoint, reflected));
      // Low roughness → the finest-angular cascade (sharpest reflection the
      // field can express); mid roughness → the mid cascade; high roughness
      // → cosine-average radiance (no directional structure at all).
      let directional = softLookup;
      if (light.radianceSharpFn) {
        const sharpLookup = vec3(light.radianceSharpFn(samplePoint, reflected));
        directional = mix(sharpLookup, softLookup, smoothstep(0.02, 0.3, roughness));
      }
      // TRUE mirror reflections for low-roughness materials: one DDA ray
      // through the voxel radiance grid (cascade bins bottom out ~5° — a
      // real mirror needs a real ray, same as the reference demo's analytic
      // trace). Miss → keep the cascade lookup.
      if (light.mirrorTraceFn) {
        const mirror = light.mirrorTraceFn(samplePoint, reflected, 24);
        const useMirror = smoothstep(0.3, 0.08, roughness).mul(step(0, mirror.t));
        directional = mix(directional, mirror.rad, useMirror);
      }
      const diffuseLimit = irradiance.div(Math.PI);
      const specRadiance = mix(
        directional.mul(light.intensityUniform),
        diffuseLimit,
        smoothstep(0.35, 0.85, roughness),
      );
      builder.context.radiance.addAssign(specRadiance);
    }

    // Emissive-area soft shadows ("ray-traced" look): the gather already
    // carries each emitter's direct light, blurred and UNSHADOWED. Compute
    // the same quantity analytically (solid angle × cos), subtract it, and
    // re-add it shadowed by DDA rays through the voxel grid:
    //   irradiance += E_direct · (shadow − 1)
    // Unoccluded pixels get a net zero (no bias); occluded pixels lose
    // exactly the emitter-direct term — a correctly-shaped area shadow with
    // penumbra from 3 rays toward different points on the emitter.
    if (light.emitterSlots?.length && light.shadowTraceFn) {
      for (const slot of light.emitterSlots) {
        const center = vec3(slot.center);
        const toEmitter = center.sub(positionWorld).toVar();
        const dist = toEmitter.length().max(1e-3).toVar();
        const dirToEmitter = toEmitter.div(dist).toVar();
        const cosTheta = dirToEmitter.dot(N).max(0).toVar();
        const solidAngle = float(Math.PI)
          .mul(slot.radius)
          .mul(slot.radius)
          .div(dist.mul(dist))
          .min(Math.PI);
        // Cap by the actually-gathered irradiance: the subtract-and-reshadow
        // correction must never remove more emitter light than the gather
        // delivered (analytic estimate ≫ gathered at grazing angles/corners
        // → negative irradiance → olive-black blotches).
        const emitterDirect = vec3(slot.color)
          .mul(solidAngle)
          .mul(cosTheta)
          .min(irradiance.mul(0.85))
          .toVar();

        const shadow = float(1).toVar();
        If(
          slot.radius.greaterThan(0.001).and(cosTheta.greaterThan(0)).and(dist.lessThan(SHADOW_RANGE)),
          () => {
            // SDF sphere-traced penumbra: ONE ray, smooth by construction
            // (multi-tap binary-occupancy rays could only trade staircase
            // for banding for grain). k = distance / emitter radius encodes
            // the light's angular size: bigger/closer emitter → softer.
            const k = dist.div(slot.radius.max(0.05)).clamp(3, 24);
            const origin = positionWorld.add(N.mul(light.normalOffset));
            const maxT = dist.sub(slot.radius).sub(light.shadowMargin).max(0);
            If(maxT.greaterThan(light.shadowMargin), () => {
              shadow.assign(light.shadowTraceFn(origin, dirToEmitter, maxT, k, cosTheta));
            });
          },
        );
        builder.context.irradiance.addAssign(emitterDirect.mul(shadow.sub(1)).mul(light.intensityUniform));
      }
    }
  }
}

const registeredRenderers = new WeakSet();

/** Registers the light-node pairing once per renderer (survives renderer swaps). */
export function registerGILight(renderer) {
  if (!renderer?.library || registeredRenderers.has(renderer)) return;
  renderer.library.addLight(GICascadeLightNode, GICascadeLight);
  registeredRenderers.add(renderer);
}
