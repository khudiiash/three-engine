import * as THREE from "three/webgpu";

/**
 * Texture import settings, stored next to the image as `<file>.meta` JSON.
 * Missing file / missing keys fall back to these defaults.
 */
export const TEXTURE_META_DEFAULTS = {
  filter: "linear", // "linear" | "nearest"
  wrapS: "repeat", // "repeat" | "clamp" | "mirror"
  wrapT: "repeat",
  repeat: [1, 1],
  flipY: true, // false for glTF-extracted images (top-left UV origin)
};

const WRAP = {
  repeat: THREE.RepeatWrapping,
  clamp: THREE.ClampToEdgeWrapping,
  mirror: THREE.MirroredRepeatWrapping,
};

export function applyTextureMeta(texture, meta) {
  const m = { ...TEXTURE_META_DEFAULTS, ...(meta ?? {}) };
  texture.magFilter = m.filter === "nearest" ? THREE.NearestFilter : THREE.LinearFilter;
  texture.minFilter =
    m.filter === "nearest" ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
  texture.wrapS = WRAP[m.wrapS] ?? THREE.RepeatWrapping;
  texture.wrapT = WRAP[m.wrapT] ?? THREE.RepeatWrapping;
  texture.repeat.set(m.repeat?.[0] ?? 1, m.repeat?.[1] ?? 1);
  texture.flipY = m.flipY !== false;
  texture.needsUpdate = true;
  return texture;
}
