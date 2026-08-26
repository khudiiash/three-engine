/**
 * Turning a provider's download into something {@link ModelPreview} can render.
 *
 * `ModelPreview` renders `{ scene, animations }` — the two fields of a GLTF it
 * actually reads — and takes a `load` callback for sources that are not a
 * plain glTF URL. This module holds those callbacks. They live here rather
 * than in each provider's client because the clients deliberately avoid
 * static three imports (polyhaven.js is smoke-tested under node, which has no
 * WebGL), and because two providers needed the same remapping trick.
 *
 * Nothing here writes to the project. A preview is a read.
 */
import * as THREE from "three/webgpu";
import { createGltfLoader } from "../engine/gltfLoader.js";

/**
 * Loads a glTF whose sibling resources do NOT sit where its URIs say they do.
 *
 * Poly Haven is the case this exists for. Its `.gltf` refers to
 * `textures/Foo_diff_1k.jpg` and `Foo.bin`, but on the CDN those live under
 * completely different paths — `Models/jpg/1k/Foo/…` for the texture and,
 * bizarrely, `Models/gltf/4k/Foo/…` for the buffer even when you asked for the
 * 1k mesh. Pointing a loader at the `.gltf` URL therefore 404s on every
 * resource. The API's `include` map is exactly the relative-path → real-URL
 * table needed to fix that, so it is installed as a `LoadingManager` URL
 * modifier and the loader never learns the difference.
 *
 * @param {string} url absolute URL of the `.gltf`
 * @param {Record<string, string>} resources relative path → absolute URL
 */
export async function loadRemappedGltf(url, resources = {}) {
  const manager = new THREE.LoadingManager();
  // Keys are relative ("textures/x.jpg"); requests arrive absolute, resolved
  // against the .gltf. Match on the tail so both spellings hit.
  const entries = Object.entries(resources);
  manager.setURLModifier((requested) => {
    if (requested === url || requested.startsWith("data:") || requested.startsWith("blob:")) {
      return requested;
    }
    const decoded = decodeURIComponent(requested);
    // Full relative paths FIRST, across every entry, before falling back to
    // basenames. Checking both per-entry lets a basename match on the wrong
    // entry beat an exact match on the right one purely by iteration order —
    // which two textures sharing a filename in different folders would hit.
    const exact = entries.find(([relative]) => decoded.endsWith(relative));
    if (exact) return exact[1];
    const byName = entries.find(([relative]) => decoded.endsWith(`/${relative.split("/").pop()}`));
    return byName ? byName[1] : requested;
  });
  return createGltfLoader(manager).loadAsync(url);
}

/** ambientCG map name → the MeshStandardMaterial slot it belongs in. */
const OBJ_MAP_SLOTS = [
  [/_color\./i, "map"],
  [/_normalgl\./i, "normalMap"],
  [/_roughness\./i, "roughnessMap"],
  [/_ambientocclusion\./i, "aoMap"],
  [/_metalness\./i, "metalnessMap"],
];

/**
 * Builds a previewable scene from an ambientCG 3D-model ZIP.
 *
 * ambientCG is the one browser here whose models are not glTF at all: every
 * 3D asset ships as OBJ + MTL + loose maps inside a ZIP, with no URL a loader
 * could be aimed at and no lighter-weight preview file. So the preview
 * downloads the archive — always at the SMALLEST quality/resolution on offer,
 * which is what `res` should be — and assembles the mesh in memory.
 *
 * The MTL is deliberately NOT used. `MTLLoader` resolves texture references
 * through the loading manager asynchronously, which would mean either racing
 * the blob-URL revocations or leaking them; and ambientCG's filenames already
 * say what each map is, unambiguously and for every asset in the catalogue.
 * Loading them by name lets every URL be awaited and revoked here, so nothing
 * outlives the preview.
 *
 * @param {Uint8Array} zipBytes the downloaded archive
 */
export async function loadObjArchivePreview(zipBytes) {
  const [{ default: JSZip }, { OBJLoader }] = await Promise.all([
    import("jszip"),
    import("three/addons/loaders/OBJLoader.js"),
  ]);
  const zip = await JSZip.loadAsync(zipBytes);
  const files = Object.values(zip.files).filter((entry) => !entry.dir);

  const objEntry = files.find((entry) => /\.obj$/i.test(entry.name));
  if (!objEntry) throw new Error("That archive contained no .obj mesh");
  const scene = new OBJLoader().parse(await objEntry.async("string"));

  // Blob URLs are the only way to hand bytes to TextureLoader, and every one
  // is revoked before this function returns — a browser panel that loads a new
  // asset per click is exactly the shape that turns a leaked object URL into a
  // held-forever decoded bitmap.
  const urls = [];
  const textureLoader = new THREE.TextureLoader();
  const maps = {};
  try {
    for (const [pattern, slot] of OBJ_MAP_SLOTS) {
      const entry = files.find((file) => pattern.test(file.name));
      if (!entry) continue;
      const url = URL.createObjectURL(new Blob([await entry.async("uint8array")]));
      urls.push(url);
      const texture = await textureLoader.loadAsync(url);
      // Colour is authored in sRGB; every other map is data and must stay
      // linear or the normals and roughness come out wrong.
      texture.colorSpace = slot === "map" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      // flipY stays at TextureLoader's default `true`, which is the OBJ/MTL
      // convention — it is glTF that wants it false. The runtime
      // ObjModelComponent leaves it alone for the same reason; forcing it here
      // would render every preview upside-down against the imported asset.
      texture.anisotropy = 4;
      maps[slot] = texture;
    }
  } finally {
    for (const url of urls) URL.revokeObjectURL(url);
  }

  const material = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...maps });
  scene.traverse((object) => {
    if (!object.isMesh) return;
    // OBJ carries no second UV set, and `aoMap` samples uv2. Alias it so the
    // occlusion map lands somewhere real instead of being silently ignored.
    if (maps.aoMap && object.geometry.attributes.uv && !object.geometry.attributes.uv1) {
      object.geometry.setAttribute("uv1", object.geometry.attributes.uv);
    }
    object.material = material;
  });
  return { scene, animations: [] };
}

/** Meshes laid out per row in a pack contact sheet, and the most it will show. */
const PACK_COLUMNS = 5;
const PACK_LIMIT = 25;

/**
 * Builds a previewable scene from the GLBs inside a Fab archive.
 *
 * Fab's free catalogue is mostly PACKS — a listing is forty props, not one
 * model — and only about one listing in ten publishes Fab's own 3D viewer, so
 * for the rest this is the only way to answer "what am I about to import".
 * Showing the first mesh would answer it wrongly: the first mesh of a tile set
 * is a floor tile.
 *
 * So a pack is laid out as a contact sheet, and each mesh is scaled to fit its
 * cell rather than kept at true relative scale. That is a deliberate lie about
 * proportion, in exchange for the truth that matters here — WHAT IS IN THE BOX.
 * At true scale a pack containing a building and a doorknob shows a building
 * and no doorknob. A single-mesh archive skips all of this and is shown as it
 * is, at its own scale.
 *
 * @param {{format: string, models: {name: string, bytes: Uint8Array}[], textures: Map}} archive
 *        from `fab.extractArchive`
 */
export async function loadArchivePreview({ format, models, textures }) {
  if (!models?.length) throw new Error("That archive contained no meshes");
  const shown = models.slice(0, PACK_LIMIT);
  const parse = format === "fbx" ? await fbxParser(textures) : await glbParser();
  const loaded = [];
  for (const model of shown) {
    // A single corrupt mesh in a forty-mesh pack should cost that mesh, not the
    // whole preview.
    try {
      loaded.push(await parse(model.bytes));
    } catch {
      // Skipped on purpose.
    }
  }
  parse.dispose?.();
  if (!loaded.length) throw new Error("None of the meshes in that archive could be read");

  if (loaded.length === 1) {
    return { scene: loaded[0].scene, animations: loaded[0].animations ?? [] };
  }

  const root = new THREE.Group();
  const columns = Math.min(PACK_COLUMNS, Math.ceil(Math.sqrt(loaded.length)));
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  loaded.forEach((entry, index) => {
    box.setFromObject(entry.scene);
    box.getSize(size);
    box.getCenter(center);
    const extent = Math.max(size.x, size.y, size.z, 1e-6);
    // Each cell is one unit across, so the grid spacing below is in cells and
    // the whole sheet frames the same way no matter what the pack contains.
    const scale = 1 / extent;
    const cell = new THREE.Group();
    entry.scene.scale.setScalar(scale);
    // Centre horizontally, sit on the cell floor: a contact sheet of props all
    // standing on the same ground line reads far better than one where every
    // item is centred in mid-air.
    entry.scene.position.set(-center.x * scale, -(center.y - size.y / 2) * scale, -center.z * scale);
    cell.add(entry.scene);
    cell.position.set(
      ((index % columns) - (columns - 1) / 2) * 1.35,
      0,
      (Math.floor(index / columns) - (Math.ceil(loaded.length / columns) - 1) / 2) * 1.35,
    );
    root.add(cell);
  });
  return { scene: root, animations: [] };
}

/** Parses in-memory GLB bytes into `{ scene, animations }`. */
async function glbParser() {
  const loader = createGltfLoader();
  return async (bytes) =>
    loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
}

/**
 * Parses in-memory FBX bytes, resolving textures out of the archive.
 *
 * FBX asks for its textures by bare filename against the directory the file
 * came from — and here there is no directory, only a ZIP that has already been
 * read into memory. So the archive's images become blob URLs and a
 * `LoadingManager` URL modifier maps each requested filename to one, exactly
 * the trick `fbxImport.js` uses for the on-disk case.
 *
 * The URLs are revoked when the returned parser is disposed rather than after
 * each parse, because a pack shares one texture set across forty meshes and
 * `FBXLoader` resolves them asynchronously. That means they outlive the call —
 * so the caller gets a `dispose` and `loadArchivePreview` always runs it.
 */
async function fbxParser(textures = new Map()) {
  const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
  const urls = new Map();
  for (const [name, bytes] of textures) {
    urls.set(name, URL.createObjectURL(new Blob([bytes])));
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((requested) => {
    const name = decodeURIComponent(requested).split(/[\\/]/).pop().toLowerCase();
    return urls.get(name) ?? requested;
  });
  const loader = new FBXLoader(manager);
  const parse = async (bytes) => {
    // `FBXLoader.parse` returns SYNCHRONOUSLY but its textures keep loading
    // through the manager afterwards. Returning here without waiting means the
    // blob URLs are revoked out from under them — which does not error, it just
    // renders the model as a black silhouette, because the materials end up
    // holding textures that never arrived.
    let started = false;
    const settled = new Promise((resolve) => {
      manager.onStart = () => {
        started = true;
      };
      manager.onLoad = resolve;
    });
    const root = loader.parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "",
    );
    // Only wait if something was actually queued: a mesh with embedded or no
    // textures never starts the manager, and `onLoad` would then never fire.
    if (started) await settled;
    return { scene: root, animations: root.animations ?? [] };
  };
  parse.dispose = () => {
    for (const url of urls.values()) URL.revokeObjectURL(url);
  };
  return parse;
}
