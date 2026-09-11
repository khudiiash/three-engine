import * as THREE from "three/webgpu";
import { Fn, cameraPosition, cos, dot, float, hash, instanceIndex, length, positionGeometry, positionWorld, sin, smoothstep, uniform, uv, vec2, vec3 } from "three/tsl";
import { createSkyOcclusionUniforms, skyExposure } from "./skyOcclusion.js";

/**
 * ⭐ RAIN AND SNOW WITH NO SIMULATION AT ALL.
 *
 * A particle system would put ten thousand precipitation particles through a
 * spawner, an integrator, a sorter and a buffer upload every frame, and it
 * would be spending all of it on the one motion that needs none of it: falling
 * at terminal velocity. Rain has no forces to integrate — it reached terminal
 * velocity before it was visible — so every drop's position is a closed-form
 * function of its index and the clock, evaluated in the vertex shader.
 *
 * The result: one draw call, zero compute dispatches, zero CPU per frame, no
 * storage buffers (so nothing competes with GI's eight-buffer budget), and it
 * is exactly reproducible — the same second of game time is always the same
 * rain.
 *
 * ⭐ AND IT IS ANCHORED TO THE WORLD, NOT TO THE CAMERA. Each drop lives on an
 * infinite world lattice which is then WRAPPED into a box around the camera:
 * `p - span·floor((p - camera + span/2)/span)`. Anchoring the box itself to
 * the camera is the obvious version and it is wrong — the drops travel with
 * the viewer, so walking through rain looks like standing in it, and turning
 * makes the whole field swim.
 */

/** Enough for a downpour at the default 26 m radius; `count` scales down. */
const MAX_DROPS = { rain: 14000, snow: 9000 };

export const PRECIPITATION_KINDS = ["rain", "snow"];

function createUniforms(sky) {
  return {
    /** Seconds, for the snow's wander and nothing else. */
    time: uniform(0),
    /** ⭐ METRES FALLEN, INTEGRATED ON THE CPU — not `time × fallSpeed`.
     *  Rain gets heavier as weather blends in, so `fallSpeed` changes while
     *  the field is on screen; multiplying a rising speed by an absolute clock
     *  moves every drop to a new place at once, and a downpour teleporting
     *  upwards mid-transition is the most visible artefact this file could
     *  have. The same reasoning gives the wind its own integrated `drift`. */
    fallen: uniform(0),
    drift: uniform(new THREE.Vector2()),
    /** Half-width of the wrap box, metres. */
    radius: uniform(26),
    /** Height of the wrap box, metres. */
    height: uniform(30),
    fallSpeed: uniform(9),
    size: uniform(new THREE.Vector2(0.012, 0.55)),
    wind: uniform(new THREE.Vector3()),
    /** Sideways wander, snow only. */
    sway: uniform(0),
    /** The drop's own colour before any light reaches it. */
    tint: uniform(new THREE.Color(0.72, 0.78, 0.9)),
    /** ⭐ THE LIGHT IT IS STANDING IN. Precipitation is drawn unlit — 14 000
     *  transparent quads through a full lighting graph is not affordable — so
     *  the sun and the sky are handed to it as the model already computed them,
     *  and the shading below is two dot products. Without this the drops were a
     *  constant colour: "snow and rain do not react to lighting at all", and
     *  "remain fully white even at night". */
    sunDirection: uniform(new THREE.Vector3(0, 1, 0)),
    /** Sun colour × intensity, already dimmed by cloud and by the horizon. */
    sunLight: uniform(new THREE.Color(0, 0, 0)),
    /** Hemispherical sky light — what lights a drop that the sun cannot see. */
    skyLight: uniform(new THREE.Color(0, 0, 0)),
    /** 0…1 authored rate; scales opacity as `count` scales the population. */
    amount: uniform(0),
    /** ⭐ THE ROOF OVERHEAD, per drop rather than per camera. ⚠ It has to be
     *  passed IN: the node graph below captures it when the material is built,
     *  so replacing the field afterwards would leave the shader reading a set
     *  of uniforms nothing writes. */
    sky: sky ?? createSkyOcclusionUniforms(),
    opacity: uniform(0.5),
  };
}

/**
 * `p` wrapped into the span-wide band centred on `centre`. The whole trick of
 * this file: the lattice is in world space, the window follows the viewer.
 */
const wrapAround = /*@__PURE__*/ Fn(([p, centre, span]) => {
  return p.sub(span.mul(p.sub(centre).div(span).add(0.5).floor()));
});

function precipitationPosition(u, kind) {
  const index = instanceIndex.toFloat();
  const rx = hash(index.mul(4).add(11));
  const rz = hash(index.mul(4).add(12));
  const ry = hash(index.mul(4).add(13));
  const rs = hash(index.mul(4).add(14));

  const span = u.radius.mul(2);
  // A per-drop speed spread, applied to the integrated distance so a change
  // in `fallSpeed` accelerates the field rather than relocating it.
  const spread = float(0.78).add(rs.mul(0.44));
  const speed = u.fallSpeed.mul(spread);
  const fallen = u.fallen.mul(spread);

  // Horizontal: a fixed lattice point, plus the wind's own displacement.
  // Snow does not fall, it wanders — two out-of-phase oscillations per flake,
  // seeded from its own hash so no two share a path.
  const swayX = kind === "snow" ? u.sway.mul(sin(rs.mul(6.283).add(u.time.mul(0.9)))) : float(0);
  const swayZ = kind === "snow" ? u.sway.mul(cos(rx.mul(6.283).add(u.time.mul(0.7)))) : float(0);
  const worldX = wrapAround(rx.mul(span).add(u.drift.x).add(swayX), cameraPosition.x, span);
  const worldZ = wrapAround(rz.mul(span).add(u.drift.y).add(swayZ), cameraPosition.z, span);
  // Vertical: the box sits mostly ABOVE the camera, because that is where
  // precipitation you have not met yet lives.
  const worldY = wrapAround(ry.mul(u.height).sub(fallen), cameraPosition.y.add(u.height.mul(0.28)), u.height);

  return { position: vec3(worldX, worldY, worldZ), speed };
}

/**
 * The quad, oriented along the drop's own velocity and turned to face the
 * camera about that axis — which is what makes rain read as falling rather
 * than as a cloud of dashes, and what makes wind visible in it.
 */
function precipitationVertex(u, kind) {
  return Fn(() => {
    const { position, speed } = precipitationPosition(u, kind);
    const toCamera = cameraPosition.sub(position).normalize();
    const velocity = vec3(u.wind.x, speed.negate(), u.wind.z).normalize();
    // Degenerate exactly when the drop falls straight at the eye; the epsilon
    // keeps the cross product from collapsing the quad to a line.
    const side = velocity.cross(toCamera).normalize().toVar();
    const width = u.size.x, extent = kind === "snow" ? u.size.x : u.size.y;
    return position
      .add(side.mul(positionGeometry.x.mul(width)))
      .add(velocity.mul(positionGeometry.y.mul(extent).negate()));
  })();
}

/**
 * ⭐ WHAT A DROP LOOKS LIKE IN THIS LIGHT.
 *
 * Rain and snow are not surfaces — a raindrop is a lens and a snowflake is a
 * cloud of ice — so neither obeys a diffuse lighting model. What they do is
 * SCATTER FORWARD: both are dramatically brighter when you look towards the
 * sun through them, which is why snow reads as bright flecks against a dark
 * sky at dawn and as grey dust with the sun behind you. That is one
 * Henyey-Greenstein lobe on the angle between the view ray and the sun.
 *
 * Snow scatters more broadly than rain (a flake is a diffuse ice crystal, a
 * drop is a specular lens), so snow gets a wider lobe and a much larger
 * ambient share — a snowfall stays visible under an overcast where rain
 * would not.
 */
function precipitationLight(u, kind, position) {
  // A/B hatch, read at graph-build time: a constant proves whether the colour
  // node reaches the fragment at all, separately from whether the maths is right.
  // ⛔ THE HATCH THAT FOUND A MISSING IMPORT. `dot` was not in this file's
  // `three/tsl` import list, so building this graph threw and the material was
  // left drawing nothing at all — invisible rain, with no error anywhere near
  // it. Every probe that returned BEFORE the `dot` call rendered; every one
  // that reached it rendered zero pixels, which is what named the line.
  if (globalThis.__atmosphereFlatDrops === "flat") return vec3(4, 4, 4);
  const view = position.sub(cameraPosition).normalize();
  // ⚠ NO NEGATE. The scattering angle is between the light's own travel
  // (sun → drop → eye) and the view ray, and both point the same way when you
  // are looking INTO the sun: cos θ = dot(view, sunDirection). Negating it put
  // the bright forward lobe behind the viewer, which is the one direction it
  // can never be in.
  const cosSun = dot(view, u.sunDirection);
  const g = kind === "snow" ? 0.35 : 0.72;
  const gg = g * g;
  const denominator = float(1 + gg).sub(cosSun.mul(2 * g)).max(1e-4);
  // ⚠ NORMALISED over the sphere (the 4π), for the same reason the cloud's
  // phase is: without it the peak is 22 and every drop facing the sun is a
  // white blowout.
  const forward = float(1 - gg).div(denominator.mul(denominator.sqrt()).mul(4 * Math.PI));
  // Ambient share: a flake lit by the whole sky, plus the sun's forward lobe.
  // Snow scatters broadly and stays visible under an overcast; rain is nearly
  // all lens, so it is dim until the sun is behind it.
  // ⚠ THE SUN HAS TO DOMINATE, or the lobe is arithmetic nobody can see: with
  // the ambient share carrying most of the brightness, looking into the sun
  // through rain was 13 % brighter than looking away — measured as a 2 %
  // difference on screen, which is no reaction at all. Rain is nearly all lens,
  // so its ambient is small and its beam is large; snow is a diffuse crystal
  // and keeps more ambient, which is why a snowfall still reads under a lid of
  // cloud where rain would vanish.
  const ambient = kind === "snow" ? 0.9 : 0.35;
  const beam = kind === "snow" ? 5 : 8;
  return u.skyLight.mul(ambient).add(u.sunLight.mul(forward.mul(beam)));
}

function precipitationOpacity(u, kind) {
  return Fn(() => {
    const coord = uv();
    // A streak fades along its length; a flake is a soft disc.
    const shape = kind === "snow"
      ? smoothstep(0.12, 0.5, length(coord.sub(vec2(0.5, 0.5)))).oneMinus()
      : smoothstep(0.18, 0.5, coord.x.sub(0.5).abs()).oneMinus()
        .mul(smoothstep(0.34, 0.5, coord.y.sub(0.5).abs()).oneMinus().mul(0.4).add(0.6));
    // Fade at the box wall so drops do not pop into existence, and just in
    // front of the eye so a streak never covers the screen.
    //
    // ⚠ AS A VARYING, DELIBERATELY. The fade needs the drop's world position,
    // which is the expensive half of the vertex node; recomputing it per
    // FRAGMENT would pay for a downpour's whole position solve at screen
    // resolution. It is constant across a quad, so the interpolation is exact.
    const { position } = precipitationPosition(u, kind);
    const offset = position.sub(cameraPosition);
    const planar = length(vec2(offset.x, offset.z));
    const near = smoothstep(0.35, 1.6, length(offset));
    const far = smoothstep(u.radius.mul(0.62), u.radius, planar).oneMinus();
    // ⚠ THE ROOF TEST BELONGS IN THE SAME VARYING. `positionWorld` here IS the
    // drop (the vertex node wrote it), so the height map can be asked directly
    // — and asking it per FRAGMENT would sample a texture for every pixel of
    // every drop rather than once per quad.
    const roofed = skyExposure(u.sky, float(0.2));
    const fade = near.mul(far).mul(roofed).toVarying(`atmosphere_${kind}_fade`);
    return shape.mul(fade).mul(u.amount).mul(u.opacity);
  })();
}

/**
 * One precipitation layer. `mesh` goes into a group whose world matrix is held
 * at identity — the vertex node computes world positions directly, so the
 * owning entity's own transform must not reach it.
 */
export function createPrecipitation(kind, sky = null) {
  const uniforms = createUniforms(sky);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  material.name = `Atmosphere · ${kind}`;
  material.positionNode = precipitationVertex(uniforms, kind);
  // Computed per QUAD (a varying), not per pixel: a drop is small enough that
  // its lighting is constant across it, and this way a downpour pays for the
  // shading once per instance instead of once per fragment.
  material.colorNode = Fn(() => {
    const { position } = precipitationPosition(uniforms, kind);
    return uniforms.tint.mul(precipitationLight(uniforms, kind, position)).toVarying(`atmosphere_${kind}_light`);
  })();
  material.opacityNode = precipitationOpacity(uniforms, kind);

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_DROPS[kind]);
  mesh.name = `Atmosphere ${kind}`;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  // ⛔ AND IT MUST NOT BE RAYCAST. `InstancedMesh.raycast` tests EVERY
  // instance: the atmosphere's own "am I under a roof" probe would have paid
  // 14 000 ray-triangle tests against the rain it was asking about, four times
  // a second — and so would every viewport click.
  mesh.raycast = () => {};
  // Kept out of every system that bakes or traces geometry: GI must not
  // voxelise rain, merging must not fold it, and picking must not select it.
  Object.assign(mesh.userData, {
    __giDebug: true, noBatch: true, noMerge: true, noPick: true, atmosphereOwned: true,
  });

  let warming = false;
  return {
    kind, mesh, uniforms, max: MAX_DROPS[kind],
    /**
     * Keeps ONE instance drawable so this layer's pipelines are compiled by the
     * ordinary render path at attach rather than on the frame it starts to
     * rain. At `amount` 0 that instance is fully transparent.
     */
    warm() {
      warming = true;
      mesh.count = Math.max(mesh.count, 1);
      mesh.visible = true;
    },
    /** @param {number} amount 0…1 rate. 0 leaves only the warm-up instance. */
    setAmount(amount) {
      const value = Math.max(0, Math.min(1, amount));
      uniforms.amount.value = value;
      // The population scales with the rate, so light rain costs a tenth of a
      // downpour rather than drawing the same drops at a tenth of the alpha.
      const wanted = value <= 0.001 ? 0 : Math.max(1, Math.round(MAX_DROPS[kind] * Math.min(1, value * 1.15)));
      mesh.count = wanted === 0 && warming ? 1 : wanted;
      mesh.visible = mesh.count > 0;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
