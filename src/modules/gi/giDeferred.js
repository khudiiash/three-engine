import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  uniform,
  texture,
  textureStore,
  instanceIndex,
  uint,
  vec2,
  vec4,
  ivec2,
  mix,
  normalize,
  normalWorld,
  getViewPosition,
} from "three/tsl";

/**
 * Deferred screen-space GI: instead of every material cone-tracing per
 * fragment (paid again for every overdrawn fragment, and compiled into
 * every shader — the fps AND startup-time sink), the scene renders a
 * half-res world-normal + depth prepass, ONE compute pass cone-traces the
 * cascade-selected diffuse GI per screen pixel, and materials just sample
 * the result texture bilinearly (vec4: rgb irradiance, w = AO).
 *
 * Trade-offs: GI resolution is half the render size (diffuse GI is low
 * frequency — the bilinear upsample is invisible in practice), and the GI
 * follows the ACTIVE camera (a PIP preview samples the main camera's GI).
 */
export function createDeferredGI({ width, height, volumes }) {
  const w = Math.max(2, Math.floor(width / 2));
  const h = Math.max(2, Math.floor(height / 2));

  const depthTexture = new THREE.DepthTexture(w, h);
  const gbuffer = new THREE.RenderTarget(w, h, { depthTexture });
  gbuffer.texture.name = "giNormals";

  // Prepass override material: world normals packed 0..1. Rendering to a
  // target skips tone mapping, so the values arrive unmangled.
  const normalMaterial = new THREE.MeshBasicNodeMaterial();
  normalMaterial.colorNode = normalWorld.mul(0.5).add(0.5);
  normalMaterial.fog = false;

  const giTexture = new THREE.StorageTexture(w, h);
  giTexture.type = THREE.HalfFloatType;
  giTexture.minFilter = THREE.LinearFilter;
  giTexture.magFilter = THREE.LinearFilter;
  giTexture.generateMipmaps = false;

  const uProjInv = uniform(new THREE.Matrix4());
  const uCamWorld = uniform(new THREE.Matrix4());

  const depthTex = texture(depthTexture);
  const normalTex = texture(gbuffer.texture);

  const outerU = volumes[volumes.length - 1].nodes.uniforms;

  const passNode = Fn(() => {
    const idx = instanceIndex;
    If(idx.lessThan(uint(w * h)), () => {
      const px = idx.mod(uint(w));
      const py = idx.div(uint(w));
      const uv = vec2(px.toFloat().add(0.5).div(w), py.toFloat().add(0.5).div(h));
      const coord = ivec2(px.toInt(), py.toInt());

      const depth = depthTex.sample(uv).level(0).x.toVar();
      If(depth.greaterThanEqual(0.99999), () => {
        // Sky pixel: no surface to light, no occlusion.
        textureStore(giTexture, coord, vec4(0, 0, 0, 1)).toWriteOnly();
      }).Else(() => {
        const viewPos = getViewPosition(uv, depth, uProjInv);
        const P = uCamWorld.mul(vec4(viewPos, 1)).xyz.toVar();
        const N = normalize(normalTex.sample(uv).level(0).xyz.mul(2).sub(1)).toVar();

        // Same branched cascade select as the (former) material path:
        // outer stacks only evaluate where the inner cascade doesn't cover.
        const result = vec4(outerU.skyColor.mul(outerU.intensity), 1).toVar();
        const emit = (i) => {
          if (i >= volumes.length) return;
          const nodes = volumes[i].nodes;
          const fade = nodes.edgeFadeFn(P).toVar();
          If(fade.lessThan(0.999), () => emit(i + 1));
          If(fade.greaterThan(0.001), () => {
            result.assign(mix(result, nodes.coneDiffuseFn(P, N), fade));
          });
        };
        emit(0);
        textureStore(giTexture, coord, result).toWriteOnly();
      });
    });
  })().compute(w * h);

  return {
    width: w,
    height: h,
    giTexture,
    gbuffer,
    normalMaterial,
    passNode,
    /** Call before the prepass render each frame. */
    update(camera) {
      uProjInv.value.copy(camera.projectionMatrixInverse);
      uCamWorld.value.copy(camera.matrixWorld);
    },
    dispose() {
      gbuffer.dispose();
      giTexture.dispose();
      normalMaterial.dispose();
    },
  };
}
