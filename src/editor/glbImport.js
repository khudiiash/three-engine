import { toBlobUrl } from "./assetLoader.js";
import { useProjectStore, basename } from "./store/projectStore.js";
import { MATERIAL_DEFAULTS } from "../engine/materialAsset.js";
import { createGltfLoader } from "../engine/gltfLoader.js";

/**
 * GLB unpack pipeline: turns an imported .glb into a self-contained asset
 * folder —
 *
 *   Model/
 *     Model.glb            (moved source)
 *     Model.entity         (ready-to-drop prefab: model + animation)
 *     Model.anim           (controller with one state per clip, if animated)
 *     Materials/<name>.mat (one per GLTF material, wired as overrides)
 *     Textures/<name>.png  (extracted embedded images)
 *
 * The prefab's model component carries `materials` overrides mapping GLTF
 * material names to the generated .mat assets, so editing a .mat restyles
 * the model like any other asset.
 */

// Draco-enabled so re-unpacking an already-compressed .glb still decodes.
const loader = createGltfLoader();

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const stemOf = (name) => name.replace(/\.[^.]+$/, "");
const safeName = (name) => name.replace(/[^\w\- ]+/g, "_").trim() || "Unnamed";

/** First "name", "name 1", … not present in the directory listing. */
async function uniqueChildName(dir, name) {
  let entries = [];
  try {
    entries = await invoke("list_dir", { path: dir });
  } catch {
    return name;
  }
  const names = new Set(entries.map((e) => e.name));
  if (!names.has(name)) return name;
  for (let i = 1; ; i++) {
    if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
  }
}

/** Encodes a loaded texture's image to PNG bytes (null if not encodable). */
async function textureToPng(texture) {
  const image = texture?.image;
  if (!image || texture.isCompressedTexture) return null;
  const width = image.width;
  const height = image.height;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

const colorHex = (color) => `#${color?.getHexString?.() ?? "ffffff"}`;

/** Unpacks a .glb in place; returns the created folder path (or null). */
export async function unpackGlb(glbPath) {
  const gltf = await loader.loadAsync(await toBlobUrl(glbPath));

  const dir = glbPath.replace(/[\\/][^\\/]+$/, "");
  const fileName = basename(glbPath);
  const stem = stemOf(fileName);
  const folder = `${dir}/${await uniqueChildName(dir, stem)}`;
  await invoke("create_dir", { path: folder });

  const movedGlb = `${folder}/${fileName}`;
  await invoke("rename_path", { from: glbPath, to: movedGlb });

  // --- collect materials + extract their textures ---------------------------
  const materials = new Map(); // material -> name
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (mat && !materials.has(mat)) {
        const base = safeName(mat.name || `Material ${materials.size + 1}`);
        let name = base;
        for (let i = 1; [...materials.values()].includes(name); i++) name = `${base} ${i}`;
        materials.set(mat, name);
      }
    }
  });

  const textureFiles = new Map(); // texture uuid -> project path
  const writeTexture = async (texture, fallbackName) => {
    if (textureFiles.has(texture.uuid)) return textureFiles.get(texture.uuid);
    const bytes = await textureToPng(texture);
    if (!bytes) return "";
    const name = safeName(texture.name || texture.image?.name || fallbackName);
    const path = `${folder}/Textures/${name}.png`;
    await invoke("write_binary_file", { path, contents: Array.from(bytes) });
    // glTF UVs have a top-left origin; loaders must not flip these images.
    await invoke("save_scene", {
      path: `${path}.meta`,
      contents: JSON.stringify({ flipY: false }, null, 2),
    });
    textureFiles.set(texture.uuid, path);
    return path;
  };

  const materialOverrides = {}; // GLTF material name -> .mat path
  for (const [mat, name] of materials) {
    const mapPath = mat.map ? await writeTexture(mat.map, `${name} diffuse`) : "";
    // Extract secondary maps too so they're available even though .mat
    // doesn't reference them yet.
    for (const [slot, tex] of [
      ["normal", mat.normalMap],
      ["roughness", mat.roughnessMap],
      ["metalness", mat.metalnessMap],
      ["emissive", mat.emissiveMap],
    ]) {
      if (tex && tex !== mat.map) await writeTexture(tex, `${name} ${slot}`);
    }
    const def = {
      ...MATERIAL_DEFAULTS,
      color: colorHex(mat.color),
      roughness: typeof mat.roughness === "number" ? mat.roughness : MATERIAL_DEFAULTS.roughness,
      metalness: typeof mat.metalness === "number" ? mat.metalness : MATERIAL_DEFAULTS.metalness,
      map: mapPath,
    };
    const matPath = `${folder}/Materials/${name}.mat`;
    await invoke("save_scene", { path: matPath, contents: JSON.stringify(def, null, 2) });
    if (mat.name) materialOverrides[mat.name] = matPath;
  }

  // --- animation controller: one state per clip ------------------------------
  const clips = gltf.animations ?? [];
  let animPath = "";
  if (clips.length) {
    const states = clips.map((clip, i) => ({
      id: `state-${i}`,
      name: clip.name || `Clip ${i + 1}`,
      clip: clip.name,
      speed: 1,
      loop: true,
      x: 240 + (i % 3) * 220,
      y: 80 + Math.floor(i / 3) * 120,
    }));
    animPath = `${folder}/${stem}.anim`;
    await invoke("save_scene", {
      path: animPath,
      contents: JSON.stringify(
        { version: 1, parameters: [], states, entry: states[0].id, transitions: [] },
        null,
        2,
      ),
    });
  }

  // --- prefab ----------------------------------------------------------------
  // A real prefab asset: instances of it stay linked, so re-importing the model
  // (or editing the prefab) updates every place it was dropped into a scene.
  const { makeDef, newFid } = await import("../engine/index.js");
  const prefabDef = makeDef(
    {
      fid: newFid(),
      name: stem,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      components: [
        { type: "model", props: { path: movedGlb, materials: materialOverrides } },
        ...(animPath ? [{ type: "animation", props: { controller: animPath, playInEditor: true } }] : []),
      ],
      children: [],
    },
    { name: stem },
  );
  const prefabPath = `${folder}/${stem}.prefab`;
  await invoke("save_scene", { path: prefabPath, contents: JSON.stringify(prefabDef, null, 2) });
  const { loadPrefabFile } = await import("./prefab.js");
  await loadPrefabFile(prefabPath); // register it so it can be dropped immediately

  // Auto-compress the moved .glb in place when the Draco module is enabled; it
  // still loads through the prefab's `model` path (compression is transparent).
  let dracoNote = "";
  try {
    const { isDracoEnabled, compressGlbInPlace, formatBytes } = await import("./dracoCompress.js");
    if (isDracoEnabled()) {
      const info = await compressGlbInPlace(movedGlb);
      if (info && info.compressed < info.original) {
        const pct = Math.round((1 - info.compressed / info.original) * 100);
        dracoNote = `, Draco −${pct}% (${formatBytes(info.original)} → ${formatBytes(info.compressed)})`;
      }
    }
  } catch (err) {
    console.warn(`Draco compression skipped for ${fileName}: ${err.message ?? err}`);
  }

  await useProjectStore.getState().refresh();
  console.log(
    `Unpacked ${fileName}: ${materials.size} material${materials.size === 1 ? "" : "s"}, ` +
      `${textureFiles.size} texture${textureFiles.size === 1 ? "" : "s"}, ${clips.length} clip${clips.length === 1 ? "" : "s"}${dracoNote}`,
  );
  return folder;
}
