/**
 * Shared offscreen WebGPU renderer for asset thumbnails and previews.
 *
 * One renderer for the whole editor, renders serialized through a queue,
 * captured via a RenderTarget readback (WebGPU swapchain pixels are not
 * reliably readable from the canvas — see `api/ops/viewport.js`), cached as
 * PNG data URLs until the asset — or something it depends on — changes.
 *
 * Three kinds, one pipeline:
 *   - `.geom`        a lit 3/4 view of the mesh (the Assets grid, the inspector)
 *   - `.mat`         the material on a lit sphere, built from the live shared
 *                    material's STANDARD slots (colour, roughness, metalness,
 *                    the maps) — the stock-PBR path (`applyStockPbr`) fills
 *                    those for every imported material, and a graph-only
 *                    material falls back to `getMaterialColorPreview`. The
 *                    live instance itself is never rendered here: it carries
 *                    the GI system's nodes and compiles against the scene.
 *   - `.hdr` / `.exr` the panorama, tone-mapped, as a 2:1 strip
 *   - images         the file itself (a blob URL) — no render needed
 *
 * `requestThumb(path)` picks the kind from the extension; the typed requests
 * exist for callers that know. Every consumer that wants to stay fresh
 * subscribes with `onThumbInvalidated` and re-requests.
 */
import * as THREE from "three/webgpu";
import { loadGeometryAsset } from "../engine/geometryAsset.js";
import { renderTargetToDataUrl } from "../engine/renderTargetImage.js";
import { onAssetInvalidated, extOf, toBlobUrl } from "./assetLoader.js";
import { samePath } from "./assetReveal.js";

/** Bumped when framing / lighting / sizes change so stale thumbs are dropped. */
const CACHE_VERSION = 3;

export const THUMB_SIZE = { geom: 160, material: 256, equirect: [512, 256] };

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

/** key → data URL string, or an in-flight Promise resolving to one. */
const cache = new Map();
const listeners = new Set();
/** material path → unsubscribe, so a live edit in the Shader Graph re-renders its sphere. */
const materialSubs = new Map();

let state = null;
let queue = Promise.resolve();
let subscribed = false;

/** Which preview a path gets, or null when it has none. */
export function thumbKind(path) {
  const ext = extOf(path);
  if (ext === "geom") return "geom";
  if (ext === "mat") return "material";
  if (ext === "hdr" || ext === "exr") return "equirect";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "scene") return "scene";
  return null;
}

function cacheKey(kind, path) {
  return `${CACHE_VERSION}:${kind}:${path}`;
}

/** Called with (kind, path) for one asset, or (kind, null) for every asset of that kind. */
export function onThumbInvalidated(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(kind, path) {
  for (const listener of listeners) {
    try {
      listener(kind, path);
    } catch (err) {
      console.warn(`Thumb listener failed: ${err?.message ?? err}`);
    }
  }
}

function ensureInvalidationHook() {
  if (subscribed) return;
  subscribed = true;
  onAssetInvalidated((path) => {
    const kind = thumbKind(path);
    if (kind === "image") {
      // A texture an unknown number of materials sample — every sphere may be stale.
      invalidateKind("material");
      notify("image", path);
      return;
    }
    if (kind) invalidateThumb(kind, path);
  });
}

async function ensure() {
  if (state) return state;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = THUMB_SIZE.material;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(THUMB_SIZE.material, THUMB_SIZE.material, false);
  renderer.setClearColor(0x000000, 0);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2e36, 0.95));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xa8b8ff, 0.7);
  fill.position.set(-3, 1, -2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.45);
  rim.position.set(-1, 2, 3);
  scene.add(rim);

  const geomMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0xb8bec8,
    roughness: 0.45,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });
  geomMaterial.fog = false; // a thumbnail is never under water — it must not compile the medium

  // Wider FOV reads better at thumbnail size than a telephoto fit.
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);

  // The panorama strip: an unlit quad in its own scene, seen head-on.
  const flatScene = new THREE.Scene();
  const ortho = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.1, 10);
  ortho.position.set(0, 0, 1);
  ortho.lookAt(0, 0, 0);

  state = {
    renderer,
    scene,
    camera,
    geomMaterial,
    sphere: new THREE.SphereGeometry(1, 64, 40),
    plane: new THREE.PlaneGeometry(2, 1),
    flatScene,
    ortho,
    targets: new Map(),
    _center: new THREE.Vector3(),
    _size: new THREE.Vector3(),
  };
  return state;
}

function targetFor(s, width, height) {
  const key = `${width}x${height}`;
  let target = s.targets.get(key);
  if (!target) {
    target = new THREE.RenderTarget(width, height, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
    });
    s.targets.set(key, target);
  }
  return target;
}

/** Frames `camera` on the geometry so the whole mesh fits with margin. */
function frameCamera(camera, geometry, scratch) {
  // Always recomputed: a .geom can carry the bounds of the mesh it was cut
  // from, and framing on those put the piece in a corner of its picture.
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const center = geometry.boundingBox.getCenter(scratch._center);
  const size = geometry.boundingBox.getSize(scratch._size);
  // Prefer the larger of sphere radius and half-diagonal — three's sphere can
  // undershoot on some authored meshes, which produced extreme close-ups.
  const radius = Math.max(geometry.boundingSphere.radius, size.length() * 0.5, 1e-4);
  const halfFov = (camera.fov * Math.PI) / 360;
  const dist = (radius / Math.sin(halfFov)) * 1.35;
  const elev = 0.48;
  const azim = 0.7;
  const cosE = Math.cos(elev);
  camera.near = Math.max(dist / 100, 0.001);
  camera.far = dist + radius * 8;
  camera.position.set(
    center.x + Math.sin(azim) * dist * cosE,
    center.y + dist * Math.sin(elev),
    center.z + Math.cos(azim) * dist * cosE,
  );
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

/**
 * Renders `scene` through `camera` into a target of the given size and returns
 * a PNG data URL. Row padding and row ORDER are the readback helper's business.
 */
async function capture(s, { scene = s.scene, camera = s.camera, width, height, toneMapping = THREE.NoToneMapping, exposure = 1 }) {
  const { renderer } = s;
  const target = targetFor(s, width, height);
  const prevTarget = renderer.getRenderTarget();
  const prevTone = renderer.toneMapping;
  const prevExposure = renderer.toneMappingExposure;
  try {
    renderer.toneMapping = toneMapping;
    renderer.toneMappingExposure = exposure;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevTarget);
    return await renderTargetToDataUrl(renderer, target, width, height);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.toneMapping = prevTone;
    renderer.toneMappingExposure = prevExposure;
  }
}

async function renderGeometry(path) {
  const geometry = await loadGeometryAsset(path);
  const s = await ensure();
  let mesh = null;
  try {
    mesh = new THREE.Mesh(geometry, s.geomMaterial);
    s.scene.add(mesh);
    s.camera.fov = 40;
    frameCamera(s.camera, geometry, s);
    return await capture(s, { width: THUMB_SIZE.geom, height: THUMB_SIZE.geom });
  } finally {
    if (mesh) s.scene.remove(mesh);
    geometry.dispose();
  }
}

const NUMERIC_SLOTS = [
  "roughness", "metalness", "opacity", "transparent", "emissiveIntensity", "ior",
  "clearcoat", "clearcoatRoughness", "sheen", "sheenRoughness", "transmission", "thickness",
  "iridescence", "specularIntensity",
];
const MAP_SLOTS = [
  "map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap",
  "clearcoatMap", "clearcoatNormalMap", "sheenColorMap", "transmissionMap",
];

async function renderMaterial(path) {
  const { loadMaterialAsset, getMaterialInstance, getMaterialColorPreview, subscribeMaterial } =
    await import("../engine/materialAsset.js");
  await loadMaterialAsset(path);
  if (!materialSubs.has(path)) {
    materialSubs.set(path, subscribeMaterial(path, () => invalidateThumb("material", path)));
  }
  const live = getMaterialInstance(path);
  const s = await ensure();
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.fog = false;
  material.side = THREE.FrontSide;
  if (live) {
    if (live.color?.isColor) material.color.copy(live.color);
    if (live.emissive?.isColor) material.emissive.copy(live.emissive);
    if (live.normalScale?.isVector2) material.normalScale.copy(live.normalScale);
    for (const slot of NUMERIC_SLOTS) {
      const v = live[slot];
      if (typeof v === "number" || typeof v === "boolean") material[slot] = v;
    }
    // The textures are SHARED with the scene's material: the second renderer
    // uploads its own copy on first use and never touches the scene's.
    for (const slot of MAP_SLOTS) if (live[slot]?.isTexture) material[slot] = live[slot];
  }
  // A graph that is not stock PBR leaves the standard slots blank; the colour
  // walk is the one thing it can still tell us.
  if (!material.map) {
    const preview = getMaterialColorPreview?.(path);
    if (preview) {
      try {
        material.color.set(preview);
      } catch {
        // an unparsable preview string — keep the base colour
      }
    }
  }
  const mesh = new THREE.Mesh(s.sphere, material);
  s.scene.add(mesh);
  try {
    // A unit sphere, seen slightly from above so the key light reads.
    s.camera.fov = 30;
    // 1.3: the sphere takes about three quarters of the frame, so it never
    // touches the edge of a card or a tile.
    const dist = (1 / Math.sin((s.camera.fov * Math.PI) / 360)) * 1.3;
    s.camera.near = 0.1;
    s.camera.far = 20;
    s.camera.position.set(0.28 * dist, 0.22 * dist, 0.93 * dist);
    s.camera.lookAt(0, 0, 0);
    s.camera.updateProjectionMatrix();
    return await capture(s, { width: THUMB_SIZE.material, height: THUMB_SIZE.material });
  } finally {
    s.scene.remove(mesh);
    material.dispose();
  }
}

async function renderEquirect(path) {
  const { loadEnvironmentAsset } = await import("../engine/environmentAsset.js");
  const texture = await loadEnvironmentAsset(path);
  if (!texture) throw new Error("the panorama did not decode");
  const s = await ensure();
  // The scene's copy is an equirect ENVIRONMENT map; a flat strip wants plain
  // UV sampling, so a clone (sharing the decoded pixels) carries that mapping.
  const flat = texture.clone();
  flat.mapping = THREE.UVMapping;
  flat.needsUpdate = true;
  const material = new THREE.MeshBasicNodeMaterial({ map: flat });
  material.fog = false;
  material.toneMapped = true;
  const quad = new THREE.Mesh(s.plane, material);
  s.flatScene.add(quad);
  try {
    const [width, height] = THUMB_SIZE.equirect;
    return await capture(s, {
      scene: s.flatScene,
      camera: s.ortho,
      width,
      height,
      toneMapping: THREE.ACESFilmicToneMapping,
      // A little under the scene's exposure: a strip is read for its layout
      // (where the sun is, where the horizon is), and the sun blows out at 1.
      exposure: 0.7,
    });
  } finally {
    s.flatScene.remove(quad);
    material.dispose();
    flat.dispose();
  }
}

/** Serialises a render through the shared queue and caches its result. */
function request(kind, path, render) {
  ensureInvalidationHook();
  const key = cacheKey(kind, path);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);

  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  cache.set(key, promise);

  queue = queue
    .then(async () => {
      // Dropped from the cache (overwrite / invalidate) while waiting — skip.
      if (cache.get(key) !== promise) {
        settle(null);
        return;
      }
      try {
        const url = await render(path);
        if (cache.get(key) === promise) cache.set(key, url);
        settle(url);
      } catch (err) {
        if (cache.get(key) === promise) cache.delete(key);
        console.warn(`${kind} thumb failed for ${path}: ${err?.message ?? err}`);
        settle(null);
      }
    })
    .catch(() => {});

  return promise;
}

/** A PNG data URL of the mesh, or null if load/render fails. */
export function requestGeometryThumb(path) {
  return request("geom", path, renderGeometry);
}

/** A PNG data URL of the material on a lit sphere, or null. */
export function requestMaterialThumb(path) {
  return request("material", path, renderMaterial);
}

/** A PNG data URL of the tone-mapped panorama (2:1), or null. */
export function requestEquirectThumb(path) {
  return request("equirect", path, renderEquirect);
}

/** Whatever preview the path has: a rendered thumb, the image itself, or null. */
export function requestThumb(path) {
  switch (thumbKind(path)) {
    case "geom":
      return requestGeometryThumb(path);
    case "material":
      return requestMaterialThumb(path);
    case "equirect":
      return requestEquirectThumb(path);
    case "scene":
      // The picture saved with the scene (sceneThumbs.js); loaded lazily so
      // the capture side, which imports this module, is not a static cycle.
      return request("scene", path, async (p) => (await import("./sceneThumbs.js")).readSceneThumb(p));
    case "image":
      return toBlobUrl(path).catch(() => null);
    default:
      return Promise.resolve(null);
  }
}

/** Drops one cached thumb so the next request re-renders. */
export function invalidateThumb(kind, path) {
  const prefix = `${CACHE_VERSION}:${kind}:`;
  for (const key of [...cache.keys()]) {
    if (!key.startsWith(prefix)) continue;
    // Paths may differ only by separator/case across listings vs writers.
    if (samePath(key.slice(prefix.length), path)) cache.delete(key);
  }
  notify(kind, path);
}

/** Drops every cached thumb of a kind (a texture changed: every material may show it). */
export function invalidateKind(kind) {
  const prefix = `${CACHE_VERSION}:${kind}:`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
  notify(kind, null);
}

/** Kept for the callers that predate the other kinds. */
export function invalidateGeometryThumb(path) {
  invalidateThumb("geom", path);
}
