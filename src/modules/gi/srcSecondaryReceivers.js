// A bounded continuation domain for the primary radiance cache.
// Screen pixels alone never populate surfaces behind the camera. Keep a
// strided snapshot of this frame's static hits as virtual pixels NEXT frame;
// population, ray allocation and deposit all consume the same snapshot.
// Sampled textures add no storage-buffer binding to the already-full deposit.
import * as THREE from "three/webgpu";
import {
  Fn, If, atomicLoad, bool, instanceIndex, ivec2, texture,
  textureStore, uint, uintBitsToFloat, vec3, vec4,
} from "three/tsl";
import { SEC_EMITTER, SEC_HIT_WORDS, SEC_N, SEC_P, SEC_RHO } from "./srcDeposit.js";

export const SECONDARY_RECEIVER_CAPACITY = 8192;

export function createSrcSecondaryReceivers({ capacity = SECONDARY_RECEIVER_CAPACITY } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > SECONDARY_RECEIVER_CAPACITY) {
    throw new Error(`SRC secondary receiver capacity must be 1..${SECONDARY_RECEIVER_CAPACITY}`);
  }
  const width = Math.min(256, capacity), rows = Math.ceil(capacity / width);
  const atlas = new THREE.StorageTexture(width, rows * 2);
  atlas.type = THREE.FloatType;
  atlas.format = THREE.RGBAFormat;
  atlas.minFilter = THREE.NearestFilter;
  atlas.magFilter = THREE.NearestFilter;
  atlas.generateMipmaps = false;
  atlas.name = "giSrcSecondaryReceivers";
  const sampled = texture(atlas);
  const texel = (index, normal = false) => ivec2(
    uint(index).mod(uint(width)).toInt(),
    uint(index).div(uint(width)).mul(uint(2)).add(uint(normal ? 1 : 0)).toInt(),
  );

  const readPixel = (index) => {
    const p = sampled.load(texel(index)).toVar();
    const n = sampled.load(texel(index, true)).xyz.toVar();
    return { position: p.xyz, normal: n, valid: p.w.greaterThan(0.5).and(n.dot(n).greaterThan(0.25)) };
  };

  // The screen branch is explicit: evaluating a screen texel for a virtual
  // index would wrap out-of-range rows and silently reintroduce screen bias.
  const composeReadPixel = (readScreenPixel, screenPixelCount) => (index) => {
    const position = vec3(0).toVar(), normal = vec3(0).toVar(), valid = bool(false).toVar();
    const assign = (pixel) => {
      position.assign(pixel.position); normal.assign(pixel.normal); valid.assign(pixel.valid);
    };
    If(uint(index).lessThan(uint(screenPixelCount)), () => {
      assign(readScreenPixel(index));
    }).Else(() => {
      const receiver = uint(index).sub(uint(screenPixelCount)).toVar();
      If(receiver.lessThan(uint(capacity)), () => { assign(readPixel(receiver)); });
    });
    return { position, normal, valid };
  };

  const createSnapshot = (bins, frameStamp) => {
    const { scratch, hitListBase, hitCapacity } = bins;
    if (!(hitCapacity > 0)) throw new Error("SRC receiver snapshot requires a secondary hit list");
    const pass = Fn(() => {
      const i = instanceIndex.toVar();
      const count = atomicLoad(scratch.element(uint(hitListBase))).min(uint(hitCapacity)).toVar();
      const stride = count.add(uint(capacity - 1)).div(uint(capacity)).max(uint(1)).toVar();
      const hit = i.mul(stride).add(uint(frameStamp).mod(stride)).toVar();
      const p = vec4(0).toVar(), n = vec4(0).toVar();
      If(hit.lessThan(count), () => {
        const base = uint(hitListBase + 1).add(hit.mul(uint(SEC_HIT_WORDS))).toVar();
        const word = (offset) => uintBitsToFloat(atomicLoad(scratch.element(base.add(uint(offset)))));
        const position = vec3(word(SEC_P), word(SEC_P + 1), word(SEC_P + 2)).toVar();
        const normal = vec3(word(SEC_N), word(SEC_N + 1), word(SEC_N + 2)).toVar();
        const rho = vec3(word(SEC_RHO), word(SEC_RHO + 1), word(SEC_RHO + 2)).toVar();
        // NaNs fail these comparisons too. Black receivers need no feedback;
        // moving proxy hits (-2) cannot safely be replayed a frame later.
        // The recorded normal is already ray-facing: never face it to camera.
        const finite = position.abs().lessThan(vec3(1e6)).all();
        const n2 = normal.dot(normal).toVar();
        const valid = finite.and(n2.greaterThan(0.25)).and(n2.lessThan(4))
          .and(rho.x.max(rho.y).max(rho.z).greaterThan(1e-5))
          .and(word(SEC_EMITTER).greaterThan(-1.5));
        If(valid, () => {
          p.assign(vec4(position, 1));
          n.assign(vec4(normal.normalize(), 0));
        });
      });
      // Always overwrite both texels, including an empty/shorter hit list.
      // Trace self-hit exclusion remains the existing BVH/occupancy trace's
      // own near bound; replaying an exact hit does not bypass that bound.
      textureStore(atlas, texel(i), p);
      textureStore(atlas, texel(i, true), n);
    })().compute(capacity);
    pass.__giPassName = "src:secondary receiver snapshot";
    return pass;
  };
  return { atlas, capacity, readPixel, composeReadPixel, createSnapshot, dispose() { atlas.dispose(); } };
}
