import * as THREE from "three/webgpu";
import { Fn, float, instanceIndex, ivec2, mix, select, texture, textureStore, uniform, vec2, vec3, vec4 } from "three/tsl";

// A small directional world-space cache for transparent receivers. SRC hash
// reads use atomics (compute only); particle fragments sample textures only.
// Six signed-axis irradiances share a 2D atlas of 8^3 world samples.
export function createVfxIrradianceField(resolution = 8) {
  const n = resolution;
  const target = new THREE.StorageTexture(n * n, n * 6);
  target.type = THREE.HalfFloatType;
  target.minFilter = target.magFilter = THREE.LinearFilter;
  target.name = "VFX world irradiance";
  const node = texture(target), min = uniform(new THREE.Vector3()), span = uniform(new THREE.Vector3(1, 1, 1)), ready = uniform(0);
  const box = new THREE.Box3(), bounds = new THREE.Box3(), center = new THREE.Vector3();
  const sample = (P, N) => {
    const relative = P.sub(min).div(span);
    const inside = relative.greaterThanEqual(0).all().and(relative.lessThanEqual(1).all());
    const p = relative.clamp(0, 1).mul(n - 1);
    const z = p.z.floor(), z1 = z.add(1).min(n - 1);
    const axis = (lobe) => {
      const uv = (slice) => vec2(slice.mul(n).add(p.x).add(.5).div(n * n), lobe.mul(n).add(p.y).add(.5).div(n * 6));
      return mix(node.sample(uv(z)).level(0).rgb, node.sample(uv(z1)).level(0).rgb, p.z.sub(z));
    };
    const weights = N.abs().div(N.abs().dot(vec3(1)).max(.0001));
    return axis(select(N.x.greaterThanEqual(0), float(0), float(1))).mul(weights.x)
      .add(axis(select(N.y.greaterThanEqual(0), float(2), float(3))).mul(weights.y))
      .add(axis(select(N.z.greaterThanEqual(0), float(4), float(5))).mul(weights.z)).mul(ready).mul(select(inside, float(1), float(0)));
  };
  return {
    target, node, min, span, ready, sample,
    build(gatherAt) {
      return Fn(() => {
        const i = instanceIndex.toInt();
        const x = i.mod(n), y = i.div(n).mod(n), z = i.div(n * n).mod(n), lobe = i.div(n * n * n);
        const N = select(lobe.equal(0), vec3(1, 0, 0), select(lobe.equal(1), vec3(-1, 0, 0), select(lobe.equal(2), vec3(0, 1, 0), select(lobe.equal(3), vec3(0, -1, 0), select(lobe.equal(4), vec3(0, 0, 1), vec3(0, 0, -1))))));
        const P = min.add(vec3(x, y, z).div(n - 1).mul(span));
        textureStore(target, ivec2(z.mul(n).add(x), lobe.mul(n).add(y)), vec4(gatherAt(P, N).irradiance, 1));
      })().compute(n * n * n * 6);
    },
    updateBounds(scene, renderer) {
      bounds.makeEmpty();
      scene.traverseVisible((object) => {
        const mats = Array.isArray(object.material) ? object.material : [object.material];
        if (!mats.some((material) => material?.userData?.giParticle || material?.userData?.giWater)) return;
        if (object.userData.giParticlePositions) {
          const state = object.userData;
          // Read the actual cloud, at most twice a second and once in flight.
          // The margin covers motion between snapshots; fragments outside it
          // return no cached GI instead of borrowing a distant edge sample.
          if (!state.giBoundsPending && performance.now() >= (state.giBoundsNext ?? 0)) {
            state.giBoundsPending = true; state.giBoundsNext = performance.now() + 500;
            renderer.getArrayBufferAsync(state.giParticlePositions.value).then((buffer) => {
              if (!object.parent) return;
              const positions = new Float32Array(buffer), stride = positions.length / state.giParticleCapacity;
              const measured = new THREE.Box3(), p = new THREE.Vector3();
              for (let i = 0; i < positions.length; i += stride) {
                p.set(positions[i], positions[i + 1], positions[i + 2]);
                if (Number.isFinite(p.x + p.y + p.z)) measured.expandByPoint(p);
              }
              if (!measured.isEmpty()) state.giVfxBounds = measured.expandByScalar(1);
            }).catch(() => {}).finally(() => { state.giBoundsPending = false; });
          }
          if (state.giVfxBounds) box.copy(state.giVfxBounds).applyMatrix4(object.matrixWorld);
          else { object.getWorldPosition(center); box.min.copy(center).addScalar(-2); box.max.copy(center).addScalar(2); }
        } else if (object.userData.giVfxBounds) {
          box.copy(object.userData.giVfxBounds).applyMatrix4(object.matrixWorld).expandByScalar(.5);
        } else {
          if (!object.geometry?.boundingBox) object.geometry?.computeBoundingBox();
          if (!object.geometry?.boundingBox) return;
          box.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld).expandByScalar(.5);
        }
        bounds.union(box);
      });
      if (bounds.isEmpty()) return false;
      min.value.copy(bounds.min); bounds.getSize(span.value);
      return true;
    },
    dispose() { target.dispose(); },
  };
}
