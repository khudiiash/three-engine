import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  uniform,
  float,
  min,
  dot,
  clamp,
  normalize,
  mix,
  positionWorld,
  normalWorld,
} from "three/tsl";

/**
 * Material-space cone-traced sun shadows.
 *
 * Visibility comes from ONE opacity cone per fragment through the alpha-
 * mipped voxel radiance atlas — the same representation the diffuse GI
 * gathers from, which is the part of this stack that renders stably under
 * camera motion. This replaced the unsigned-SDF sphere trace, whose field is
 * degenerate near hollow voxel shells: every surface sits at distance ≈ 0,
 * so interiors fell into giant false umbra blocks, corner gaps leaked, and
 * cascade ownership changes reshaped shadows whenever the camera moved.
 *
 * The cone inherits the GI sampler's properties wholesale: the mip chain's
 * aMax term preserves thin occluders (no tunneling), trilinear + quadrilinear
 * filtering removes voxel scallops, the proven 1.75-voxel origin lift needs
 * no per-surface bias tuning, and penumbrae widen with distance through the
 * aperture — deterministic, world-space, no temporal machinery.
 *
 * Two cones blend scales: the outermost cascade provides global occlusion
 * over the full range (coarse, blobby far shadows), and the finest cascade
 * containing the receiver sharpens the near field. Only up to three radiance
 * atlases bind per material, less texture pressure than the four SDF fields.
 */

export function createSunShadowNode({ volumes, readyUniform }) {
  const uniforms = {
    sunDirToLight: uniform(new THREE.Vector3(0, 1, 0)),
    // Cone aperture ≈ tan(half sun angle). Physical sun ≈ 0.005 reads
    // razor-sharp against voxels; games look better wider.
    softness: uniform(0.05),
    // Unused by the cone trace (each cascade's cone is bounded by its own
    // grid); kept so existing callers writing a range keep working.
    maxDistance: uniform(256),
  };

  const outer = volumes[volumes.length - 1];
  // Near-field candidates: the two finest cascades (excluding the outer one
  // when it IS one of them). Receivers beyond cascade 1's range get the
  // outer cone only — distant surfaces take blobbier shadows, not none.
  const fine = volumes.slice(0, 2).filter((vol) => vol !== outer);
  const volumesUsed = [...fine, outer];

  const insideTest = (vol, P) => {
    const { dims } = vol.grid;
    const u = vol.nodes.uniforms;
    const g = P.sub(u.gridMin).div(u.voxelSize);
    // Two-voxel margin: the cone needs room around the receiver before the
    // fade region, or edge receivers sharpen/blur as the clipmap scrolls.
    return g.x
      .greaterThan(2)
      .and(g.y.greaterThan(2))
      .and(g.z.greaterThan(2))
      .and(g.x.lessThan(dims.x - 2))
      .and(g.y.lessThan(dims.y - 2))
      .and(g.z.lessThan(dims.z - 2));
  };

  const node = Fn(() => {
    const P = positionWorld;
    const N = normalize(normalWorld);
    const L = normalize(uniforms.sunDirToLight);
    const visibility = float(1).toVar();

    // Back-facing receivers are zeroed by the lambert term anyway.
    If(dot(N, L).greaterThan(0), () => {
      // Global occlusion over the full range from the outermost cascade.
      visibility.assign(outer.nodes.coneShadowFn(P, N, L, uniforms.softness));
      // Sharpen with the finest cascade containing the receiver.
      const refined = float(0).toVar();
      for (const vol of fine) {
        If(refined.lessThan(0.5).and(insideTest(vol, P)), () => {
          refined.assign(1);
          visibility.assign(
            min(visibility, vol.nodes.coneShadowFn(P, N, L, uniforms.softness)),
          );
        });
      }
    });

    const s = clamp(visibility, 0, 1);
    // Smoothstep the penumbra ramp — the raw opacity estimate has a hard
    // knee at full light.
    const smooth = s.mul(s).mul(float(3).sub(s.mul(2)));
    return mix(float(1), smooth, readyUniform);
  })();

  return { node, uniforms, volumesUsed };
}
