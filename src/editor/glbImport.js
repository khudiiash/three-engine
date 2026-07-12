import { toBlobUrl } from "./assetLoader.js";
import { useProjectStore, basename } from "./store/projectStore.js";
import { MATERIAL_DEFAULTS } from "../engine/materialAsset.js";
import { GEOMETRY_ASSET_VERSION } from "../engine/geometryAsset.js";
import { createGltfLoader } from "../engine/gltfLoader.js";
import { buildPbrGraph } from "./pbrMaterialGraph.js";
import { buildMeshEntities, buildBoneEntities } from "./rigPrefab.js";

/**
 * GLB unpack pipeline: turns an imported .glb into a self-contained asset
 * folder of plain engine assets. Static models (the common case) become
 * ordinary mesh entities — no model component, no runtime GLB parsing:
 *
 *   Model/
 *     Model.prefab         (mesh-entity tree: geometry + material assets)
 *     Geometry/<name>.geom (one per mesh, authored normals preserved)
 *     Materials/<name>.mat (full PBR: diffuse/normal/rough/metal/AO wired
 *                           into a Principled BSDF shader graph)
 *     Textures/<name>.png  (extracted images, color-space tagged via .meta)
 *
 * The source .glb is deleted after a successful static unpack — everything
 * it carried now lives in editable assets.
 *
 * Skinned or animated models can't be flattened into static .geom assets
 * (skeletons + clips live in the GLB), so they keep the legacy layout: a
 * prefab with a model component pointing at the moved .glb, plus an .anim
 * controller and per-material .mat overrides.
 */

// Draco-enabled so re-unpacking an already-compressed .glb still decodes.
const loader = createGltfLoader();

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const stemOf = (name) => name.replace(/\.[^.]+$/, "");
const safeName = (name) => name.replace(/[^\w\- ]+/g, "_").trim() || "Unnamed";
const round6 = (v) => Math.round(v * 1e6) / 1e6;

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

/** Serializes a BufferGeometry to the .geom JSON shape (authored normals kept). */
function geometryAssetFromMesh(geometry) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const read = (attr, components) => {
    const out = new Array(attr.count * components);
    for (let i = 0; i < attr.count; i++) {
      out[i * components] = round6(attr.getX(i));
      if (components > 1) out[i * components + 1] = round6(attr.getY(i));
      if (components > 2) out[i * components + 2] = round6(attr.getZ(i));
    }
    return out;
  };
  return {
    version: GEOMETRY_ASSET_VERSION,
    positions: read(position, 3),
    indices: geometry.index
      ? Array.from(geometry.index.array)
      : Array.from({ length: position.count }, (_, i) => i),
    uvs: uv ? read(uv, 2) : [],
    normals: normal ? read(normal, 3) : [],
  };
}

/** Unpacks a .glb in place; returns the created folder path (or null). */
export async function unpackGlb(glbPath) {
  const gltf = await loader.loadAsync(await toBlobUrl(glbPath));

  const dir = glbPath.replace(/[\\/][^\\/]+$/, "");
  const fileName = basename(glbPath);
  const stem = stemOf(fileName);
  const folder = `${dir}/${await uniqueChildName(dir, stem)}`;
  await invoke("create_dir", { path: folder });

  // Skeletons and clips only exist inside the GLB, so those models keep the
  // legacy model-component path; everything else flattens to mesh entities.
  let skinned = false;
  gltf.scene.traverse((obj) => {
    if (obj.isSkinnedMesh) skinned = true;
  });
  const animated = (gltf.animations ?? []).length > 0;

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
  const writeTexture = async (texture, fallbackName, { srgb = false } = {}) => {
    if (textureFiles.has(texture.uuid)) return textureFiles.get(texture.uuid);
    const bytes = await textureToPng(texture);
    if (!bytes) return "";
    const name = safeName(texture.name || texture.image?.name || fallbackName);
    const path = `${folder}/Textures/${name}.png`;
    await invoke("write_binary_file", { path, contents: Array.from(bytes) });
    // glTF UVs have a top-left origin; loaders must not flip these images.
    // Data maps (normal/rough/metal/AO) must not be sRGB-decoded either.
    await invoke("save_scene", {
      path: `${path}.meta`,
      contents: JSON.stringify({ flipY: false, colorSpace: srgb ? "srgb" : "linear" }, null, 2),
    });
    const { autoCompressTexture } = await import("./basisCompress.js");
    await autoCompressTexture(path).catch((err) =>
      console.warn(`Basis compression skipped for ${name}: ${err.message ?? err}`),
    );
    textureFiles.set(texture.uuid, path);
    return path;
  };

  // One .mat per GLTF material, with every extractable PBR map wired into a
  // Principled BSDF graph. glTF packs roughness(G)/metalness(B) into one ORM
  // image — same layout as an `arm` map; its R channel is occlusion only when
  // the material's own aoMap points at the same image.
  const materialPaths = new Map(); // material -> .mat path
  for (const [mat, name] of materials) {
    const maps = {};
    if (mat.map) maps.diffuse = await writeTexture(mat.map, `${name} diffuse`, { srgb: true });
    if (mat.normalMap) maps.normal = await writeTexture(mat.normalMap, `${name} normal`);
    const orm = mat.roughnessMap ?? mat.metalnessMap;
    if (orm) maps.arm = await writeTexture(orm, `${name} orm`);
    if (mat.aoMap && mat.aoMap !== orm) maps.ao = await writeTexture(mat.aoMap, `${name} ao`);
    if (mat.emissiveMap) await writeTexture(mat.emissiveMap, `${name} emissive`, { srgb: true });

    const hasGraphMaps = maps.normal || maps.arm || maps.ao;
    const def = {
      ...MATERIAL_DEFAULTS,
      color: colorHex(mat.color),
      roughness: typeof mat.roughness === "number" ? mat.roughness : MATERIAL_DEFAULTS.roughness,
      metalness: typeof mat.metalness === "number" ? mat.metalness : MATERIAL_DEFAULTS.metalness,
      map: maps.diffuse ?? "",
      // Diffuse-only materials stay plain scalar .mat files; the graph only
      // appears when there's something for it to wire.
      shaderGraph: hasGraphMaps
        ? buildPbrGraph(maps, { armHasAo: !!orm && mat.aoMap === orm })
        : null,
    };
    const matPath = `${folder}/Materials/${name}.mat`;
    await invoke("save_scene", { path: matPath, contents: JSON.stringify(def, null, 2) });
    materialPaths.set(mat, matPath);
  }

  const { makeDef, newFid } = await import("../engine/index.js");
  let prefabRoot;
  let dracoNote = "";
  let geometryCount = 0;

  if (!skinned && !animated) {
    // --- static path: geometry assets + a mesh-entity tree ------------------
    const geomNames = new Set();
    const geometryFor = async (mesh) => {
      const base = safeName(mesh.name || "Mesh");
      let name = base;
      for (let i = 1; geomNames.has(name); i++) name = `${base} ${i}`;
      geomNames.add(name);
      const path = `${folder}/Geometry/${name}.geom`;
      await invoke("save_scene", {
        path,
        contents: JSON.stringify(geometryAssetFromMesh(mesh.geometry)),
      });
      geometryCount++;
      return path;
    };

    // Async pass first (file writes), then a sync tree build from the results.
    const meshAssets = new Map(); // mesh -> { geometryAsset, material }
    const meshes = [];
    gltf.scene.traverse((obj) => obj.isMesh && meshes.push(obj));
    for (const mesh of meshes) {
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (Array.isArray(mesh.material) && mesh.material.length > 1) {
        console.warn(`"${mesh.name}": multi-material mesh — using "${mat?.name}" for all faces`);
      }
      meshAssets.set(mesh, {
        geometryAsset: await geometryFor(mesh),
        material: materialPaths.get(mat) ?? "",
      });
    }

    const nodeFor = (obj) => {
      const children = obj.children.map(nodeFor).filter(Boolean);
      const assets = meshAssets.get(obj);
      if (!assets && children.length === 0) return null; // cameras, lights, empties
      return {
        fid: newFid(),
        name: obj.name || (assets ? "Mesh" : "Node"),
        position: obj.position.toArray().map(round6),
        rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z].map(round6),
        scale: obj.scale.toArray().map(round6),
        components: assets
          ? [{ type: "mesh", props: { geometry: "box", ...assets, castShadow: true, receiveShadow: true } }]
          : [],
        children,
      };
    };
    prefabRoot = {
      fid: newFid(),
      name: stem,
      position: gltf.scene.position.toArray().map(round6),
      rotation: [gltf.scene.rotation.x, gltf.scene.rotation.y, gltf.scene.rotation.z].map(round6),
      scale: gltf.scene.scale.toArray().map(round6),
      components: [],
      children: gltf.scene.children.map(nodeFor).filter(Boolean),
    };

    // Everything now lives in .geom/.mat/.png — the container is dead weight.
    await invoke("delete_path", { path: glbPath }).catch(() => {});
    await invoke("delete_path", { path: `${glbPath}.meta` }).catch(() => {});
  } else {
    // --- legacy path: skinned/animated models stay GLB-backed ---------------
    const movedGlb = `${folder}/${fileName}`;
    await invoke("rename_path", { from: glbPath, to: movedGlb });

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

    prefabRoot = {
      fid: newFid(),
      name: stem,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      components: [
        { type: "model", props: { path: movedGlb } },
        ...(animPath ? [{ type: "animation", props: { controller: animPath, playInEditor: true } }] : []),
      ],
      children: [
        // One entity per mesh (Unity-style): the skinnedmesh component
        // references the rig's mesh so it gets an inspector section
        // (material/shadows), an eye toggle, and click-to-select.
        ...buildMeshEntities(gltf.scene, newFid, (mesh) => {
          const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          return materialPaths.get(mat) ?? "";
        }),
        // Each joint is a normal prefab entity, so children can be dropped on
        // the rig (for example, put a sword beneath Hand.R). ModelComponent
        // syncs these attachment points from the animated GLB bones at runtime.
        ...buildBoneEntities(gltf.scene, newFid),
      ],
    };

    // Auto-compress the moved .glb in place when the Draco module is enabled;
    // it still loads through the prefab's `model` path transparently.
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
  }

  // --- prefab ----------------------------------------------------------------
  // A real prefab asset: instances of it stay linked, so re-importing the model
  // (or editing the prefab) updates every place it was dropped into a scene.
  const prefabDef = makeDef(prefabRoot, { name: stem });
  const prefabPath = `${folder}/${stem}.prefab`;
  await invoke("save_scene", { path: prefabPath, contents: JSON.stringify(prefabDef, null, 2) });
  const { loadPrefabFile } = await import("./prefab.js");
  await loadPrefabFile(prefabPath); // register it so it can be dropped immediately

  await useProjectStore.getState().refresh();
  const clips = gltf.animations ?? [];
  console.log(
    `Unpacked ${fileName}: ${materials.size} material${materials.size === 1 ? "" : "s"}, ` +
      `${textureFiles.size} texture${textureFiles.size === 1 ? "" : "s"}` +
      (geometryCount ? `, ${geometryCount} geometr${geometryCount === 1 ? "y" : "ies"}` : "") +
      (clips.length ? `, ${clips.length} clip${clips.length === 1 ? "" : "s"}` : "") +
      dracoNote,
  );
  return folder;
}
