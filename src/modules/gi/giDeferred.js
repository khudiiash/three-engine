import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  uniform,
  texture,
  textureStore,
  instanceIndex,
  float,
  uint,
  vec2,
  vec3,
  vec4,
  ivec2,
  floor,
  fract,
  clamp,
  dot,
  max,
  pow,
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
export function createDeferredGI({
  width,
  height,
  volumes,
  uniforms = null,
  resources = null,
  resScale = 0.5,
}) {
  // resScale controls the GI compute resolution vs. the screen: 0.5 = half-res
  // (fast, blockier under the bilinear upsample), 1.0 = full-res (smooth, the
  // Quality lever for "lighting is blocky"). `width`/`height` are the full
  // drawing-buffer size; the GI buffers are scaled down from there.
  const w = Math.max(2, Math.floor(width * resScale));
  const h = Math.max(2, Math.floor(height * resScale));

  let depthTexture = resources?.depthTexture ?? null;
  let gbuffer = resources?.gbuffer ?? null;
  let normalMaterial = resources?.normalMaterial ?? null;
  let giTexture = resources?.giTexture ?? null;
  let rawTexture = resources?.rawTexture ?? null;
  if (!gbuffer) {
    depthTexture = new THREE.DepthTexture(w, h);
    gbuffer = new THREE.RenderTarget(w, h, { depthTexture });
    gbuffer.texture.name = "giNormals";
    gbuffer.texture.type = THREE.HalfFloatType;
    gbuffer.texture.minFilter = THREE.NearestFilter;
    gbuffer.texture.magFilter = THREE.NearestFilter;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;

    // Prepass override material: world normals packed 0..1. Rendering to a
    // target skips tone mapping, so the values arrive unmangled.
    normalMaterial = new THREE.MeshBasicNodeMaterial();
    // MeshBasicNodeMaterial defaults lights=true in three r185 even though it
    // is visually unlit. Disable the lighting graph explicitly: otherwise the
    // scene's GI light samples giNormals while this same texture is the active
    // render attachment, which WebGPU correctly rejects as a read/write hazard.
    normalMaterial.lights = false;
    // A single override material must cover every visible receiver,
    // including DoubleSide/BackSide authored meshes. FrontSide here left
    // those pixels absent from the GI depth/normal buffer until a camera move
    // happened to expose a front-facing triangle.
    normalMaterial.side = THREE.DoubleSide;
    normalMaterial.depthTest = true;
    normalMaterial.depthWrite = true;
    normalMaterial.colorNode = normalWorld.mul(0.5).add(0.5);
    normalMaterial.fog = false;
  }

  const makeStorageTexture = (name, filter = THREE.NearestFilter) => {
    const result = new THREE.StorageTexture(w, h);
    result.name = name;
    result.type = THREE.HalfFloatType;
    result.minFilter = filter;
    result.magFilter = filter;
    result.generateMipmaps = false;
    return result;
  };
  if (!giTexture) {
    // Stable, material-facing result. Raw cone tracing and the deterministic
    // spatial resolve use separate textures so WebGPU never sees a sampled
    // and written resource in the same synchronization scope.
    giTexture = new THREE.StorageTexture(w, h);
    giTexture.name = "giResolved";
    giTexture.type = THREE.HalfFloatType;
    giTexture.minFilter = THREE.LinearFilter;
    giTexture.magFilter = THREE.LinearFilter;
    giTexture.generateMipmaps = false;
  }
  rawTexture ??= makeStorageTexture("giRaw");

  const sharedUniforms = uniforms ?? {
    projectionInverse: uniform(new THREE.Matrix4()),
    cameraWorld: uniform(new THREE.Matrix4()),
    resolution: uniform(new THREE.Vector2(w, h)),
  };
  const uProjInv = sharedUniforms.projectionInverse;
  const uCamWorld = sharedUniforms.cameraWorld;
  sharedUniforms.resolution.value.set(w, h);

  const depthTex = texture(depthTexture);
  const normalTex = texture(gbuffer.texture);
  const rawTex = texture(rawTexture);

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
        // Sky pixel: no surface to light, no occlusion. Store the flat sky
        // ambient rather than black — a small/distant object covering less
        // than one half-res texel reconstructs entirely from these pixels
        // (all four geometry taps get rejected), and a black value rendered
        // it with zero GI: the reported solid-dark objects that only fixed
        // themselves once they grew on screen.
        textureStore(
          rawTexture,
          coord,
          vec4(outerU.skyColor.mul(outerU.intensity), 1),
        ).toWriteOnly();
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
        textureStore(rawTexture, coord, result).toWriteOnly();
      });
    });
  })().compute(w * h);

  // Deterministic current-frame resolve. Screen-space temporal reprojection
  // was removed: under forward/backward camera motion its half-resolution
  // history produced rejection bands and diagonal trails. Temporal behaviour
  // now lives entirely in the world-space radiance/probe caches.
  const resolveNode = Fn(() => {
    const idx = instanceIndex;
    If(idx.lessThan(uint(w * h)), () => {
      const px = idx.mod(uint(w));
      const py = idx.div(uint(w));
      const uv = vec2(px.toFloat().add(0.5).div(w), py.toFloat().add(0.5).div(h));
      const coord = ivec2(px.toInt(), py.toInt());
      const current = rawTex.sample(uv).level(0).toVar();
      const result = current.toVar();
      const depth = depthTex.sample(uv).level(0).x.toVar();

      // Deterministic current-frame cleanup for cone-step moiré. Eight
      // half-resolution neighbours are accepted only when their world normal
      // and view-space depth agree with the receiver, so large coplanar
      // surfaces smooth out while silhouettes and separate geometry remain
      // sharp. The full 3x3 footprint also removes diagonal cache boundaries
      // that a four-neighbour cross leaves untouched.
      If(depth.lessThan(0.99999), () => {
        const centerViewPos = getViewPosition(uv, depth, uProjInv);
        const centerNormal = normalize(
          normalTex.sample(uv).level(0).xyz.mul(2).sub(1),
        );
        const depthTolerance = max(
          centerViewPos.z.abs().mul(0.02),
          0.05,
        );
        const spatialSum = current.mul(2).toVar();
        const spatialWeightSum = float(2).toVar();
        const halfTexel = vec2(0.5 / w, 0.5 / h);

        // 5x5 bilateral footprint (radius 2): the trilinear voxel blocks are
        // wider than a 3x3 half-res kernel can smooth, so this reaches farther
        // while the normal/depth gates keep silhouettes and corners crisp. Each
        // tap also gets a Gaussian spatial falloff so nearer neighbours dominate
        // (avoids a boxy over-blur).
        const RADIUS = 2;
        const SIGMA2 = 2 * 1.4 * 1.4;
        for (let oy = -RADIUS; oy <= RADIUS; oy++) {
          for (let ox = -RADIUS; ox <= RADIUS; ox++) {
            if (ox === 0 && oy === 0) continue;
            const spatialW = Math.exp(-(ox * ox + oy * oy) / SIGMA2);
            const sampleUv = clamp(
              uv.add(vec2(ox / w, oy / h)),
              halfTexel,
              vec2(1).sub(halfTexel),
            );
            const sampleDepth = depthTex.sample(sampleUv).level(0).x.toVar();
            If(sampleDepth.lessThan(0.99999), () => {
              const sampleNormal = normalize(
                normalTex.sample(sampleUv).level(0).xyz.mul(2).sub(1),
              );
              const sampleViewPos = getViewPosition(sampleUv, sampleDepth, uProjInv);
              const normalWeight = pow(max(dot(centerNormal, sampleNormal), 0), 24);
              const depthWeight = float(1).div(
                float(1).add(
                  sampleViewPos.z.sub(centerViewPos.z).abs().div(depthTolerance),
                ),
              );
              const weight = normalWeight.mul(depthWeight).mul(spatialW);
              spatialSum.addAssign(rawTex.sample(sampleUv).level(0).mul(weight));
              spatialWeightSum.addAssign(weight);
            });
          }
        }

        const spatial = spatialSum.div(
          max(spatialWeightSum, 1e-4),
        );
        result.xyz.assign(spatial.xyz);
        // The voxel field has no reliable sub-voxel AO detail. The bilateral
        // normal/depth gates preserve actual corners while this stronger
        // spatial blend suppresses the visible voxel/cache lattice.
        result.w.assign(mix(current.w, spatial.w, 0.75));
      });

      textureStore(giTexture, coord, result).toWriteOnly();
    });
  })().compute(w * h);

  // Camera cuts must never expose the previous camera's screen-space mask.
  // World-space radiance remains valid, but these two receiver textures are
  // view-dependent and are explicitly invalidated on editor/play switches.
  const clearNode = Fn(() => {
    const idx = instanceIndex;
    If(idx.lessThan(uint(w * h)), () => {
      const px = idx.mod(uint(w));
      const py = idx.div(uint(w));
      const coord = ivec2(px.toInt(), py.toInt());
      textureStore(rawTexture, coord, vec4(0, 0, 0, 1)).toWriteOnly();
      textureStore(giTexture, coord, vec4(0, 0, 0, 1)).toWriteOnly();
    });
  })().compute(w * h);

  return {
    width: w,
    height: h,
    fullWidth: width,
    fullHeight: height,
    resScale,
    giTexture,
    rawTexture,
    gbuffer,
    normalMaterial,
    passNode,
    resolveNode,
    clearNode,
    resources: {
      depthTexture,
      gbuffer,
      normalMaterial,
      giTexture,
      rawTexture,
    },
    /** Call before the prepass render each frame. */
    update(camera) {
      uProjInv.value.copy(camera.projectionMatrixInverse);
      uCamWorld.value.copy(camera.matrixWorld);
      sharedUniforms.resolution.value.set(w, h);
    },
    uniforms: sharedUniforms,
    dispose() {
      gbuffer.dispose();
      giTexture.dispose();
      rawTexture.dispose();
      normalMaterial.dispose();
    },
  };
}

/**
 * Builds the tiny material-side reconstruction used by the GI light.
 * Four neighbouring half-resolution samples are weighted by bilinear
 * coverage, world-normal agreement, and reconstructed world-position
 * agreement. This keeps cube silhouettes and wall corners sharp without
 * returning to per-material cone tracing.
 */
export function createDeferredGISampler({
  giTextureNode,
  depthTextureNode,
  normalTextureNode,
  uniforms,
}) {
  const { projectionInverse, cameraWorld, resolution } = uniforms;

  return Fn(([P, N, uv]) => {
    const pixel = uv.mul(resolution).sub(0.5);
    const base = floor(pixel);
    const f = fract(pixel);
    const accum = vec4(0).toVar();
    const weightSum = float(0).toVar();

    for (let oy = 0; oy <= 1; oy++) {
      for (let ox = 0; ox <= 1; ox++) {
        const coord = base.add(vec2(ox, oy));
        const halfTexel = vec2(0.5).div(resolution);
        const sampleUv = clamp(
          coord.add(0.5).div(resolution),
          halfTexel,
          vec2(1).sub(halfTexel),
        );
        const depth = depthTextureNode.sample(sampleUv).level(0).x.toVar();
        If(depth.lessThan(0.99999), () => {
          const viewPos = getViewPosition(sampleUv, depth, projectionInverse);
          const sampleP = cameraWorld.mul(vec4(viewPos, 1)).xyz;
          const sampleN = normalize(
            normalTextureNode.sample(sampleUv).level(0).xyz.mul(2).sub(1),
          );
          const wx = ox === 0 ? float(1).sub(f.x) : f.x;
          const wy = oy === 0 ? float(1).sub(f.y) : f.y;
          const spatialWeight = max(wx.mul(wy), 0.001);
          const normalWeight = pow(max(dot(N, sampleN), 0), 16).add(0.01);
          const delta = sampleP.sub(P);
          const distanceSq = dot(delta, delta);
          const positionWeight = float(1).div(float(1).add(distanceSq.mul(8)));
          const weight = spatialWeight.mul(normalWeight).mul(positionWeight);
          accum.addAssign(giTextureNode.sample(sampleUv).level(0).mul(weight));
          weightSum.addAssign(weight);
        });
      }
    }

    const result = giTextureNode.sample(uv).level(0).toVar();
    If(weightSum.greaterThan(1e-5), () => {
      result.assign(accum.div(weightSum));
    });
    return result;
  });
}
