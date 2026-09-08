import {
  Aperture,
  Box,
  Braces,
  File,
  FileCode2,
  Film,
  Globe,
  Image,
  Layers,
  Music,
  Package,
  Palette,
  Shapes,
  Type,
  Workflow,
} from "./icons/index.jsx";

/**
 * The glyph for an asset that has no rendered preview, by extension — shared
 * by the Assets grid, the asset browser and the asset cards so a prefab is
 * the same package everywhere.
 */
export const ICON_BY_EXT = {
  glb: Box,
  gltf: Box,
  fbx: Box,
  scene: Layers,
  json: Braces,
  js: FileCode2,
  ts: FileCode2,
  mat: Palette,
  cubemap: Globe,
  png: Image,
  jpg: Image,
  jpeg: Image,
  webp: Image,
  hdr: Image,
  exr: Image,
  prefab: Package,
  entity: Package, // legacy prefab snapshots
  anim: Workflow,
  geom: Shapes,
  timeline: Film,
  post: Aperture,
  vfx: Workflow,
  ttf: Type,
  otf: Type,
  woff: Type,
  woff2: Type,
  wav: Music,
  mp3: Music,
  ogg: Music,
  flac: Music,
};

export function iconForExt(ext) {
  return ICON_BY_EXT[String(ext ?? "").toLowerCase()] ?? File;
}

export function iconForPath(path) {
  const name = String(path ?? "").split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return iconForExt(dot >= 0 ? name.slice(dot + 1) : "");
}
