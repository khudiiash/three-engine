import { toBlobUrl } from "./assetLoader.js";
import { useProjectStore, basename } from "./store/projectStore.js";
import { useAssetProcessingStore } from "./store/assetProcessingStore.js";
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
 * Skinned or animated models also extract editable .geom assets, including
 * skin weights and morph targets. They retain the GLB only because skeletons
 * and animation clips still live in that container.
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
  const attributeAsset = (attribute) => {
    // glTF optimizers commonly interleave tangent/color/skin attributes.
    // InterleavedBufferAttribute exposes its storage through `.data.array`,
    // not `.array`; serializing the latter aborted the entire import after
    // materials/textures had already been written.
    const source = attribute.array ?? attribute.data?.array;
    if (!source) throw new Error("Unsupported vertex attribute storage");
    const stride = attribute.isInterleavedBufferAttribute ? attribute.data.stride : attribute.itemSize;
    const offset = attribute.isInterleavedBufferAttribute ? attribute.offset : 0;
    const array = new Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) {
      for (let component = 0; component < attribute.itemSize; component++) {
        array[i * attribute.itemSize + component] = round6(source[i * stride + offset + component]);
      }
    }
    return {
      itemSize: attribute.itemSize,
      normalized: !!attribute.normalized,
      arrayType: source.constructor.name,
      array,
    };
  };
  const attributes = {};
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") {
      attributes[name] = attributeAsset(attribute);
    }
  }
  const morphAttributes = {};
  for (const [name, targets] of Object.entries(geometry.morphAttributes)) {
    morphAttributes[name] = targets.map(attributeAsset);
  }
  return {
    version: GEOMETRY_ASSET_VERSION,
    positions: read(position, 3),
    indices: geometry.index
      ? Array.from(geometry.index.array)
      : Array.from({ length: position.count }, (_, i) => i),
    uvs: uv ? read(uv, 2) : [],
    normals: normal ? read(normal, 3) : [],
    attributes,
    morphAttributes,
    morphTargetsRelative: !!geometry.morphTargetsRelative,
    groups: geometry.groups.map(({ start, count, materialIndex }) => ({ start, count, materialIndex })),
  };
}

/** Unpacks a .glb in place; returns the created folder path (or null). */
export async function unpackGlb(glbPath, { assetStem = null, cleanupPaths = [] } = {}) {
  return useAssetProcessingStore.getState().track(
    (p) => `Unpacking ${basename(p)}…`,
    (p) => unpackGlbImpl(p, { assetStem, cleanupPaths }),
    glbPath,
  );
}

async function unpackGlbImpl(glbPath, { assetStem = null, cleanupPaths = [] } = {}) {
  const gltf = await loader.loadAsync(await toBlobUrl(glbPath));

  const dir = glbPath.replace(/[\\/][^\\/]+$/, "");
  const fileName = basename(glbPath);
  const stem = assetStem ?? stemOf(fileName);
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
    const sharedOrm = mat.roughnessMap && mat.roughnessMap === mat.metalnessMap
      ? mat.roughnessMap
      : null;
    if (sharedOrm) maps.arm = await writeTexture(sharedOrm, `${name} orm`);
    else {
      if (mat.roughnessMap) maps.roughness = await writeTexture(mat.roughnessMap, `${name} roughness`);
      if (mat.metalnessMap) maps.metalness = await writeTexture(mat.metalnessMap, `${name} metalness`);
    }
    if (mat.aoMap && mat.aoMap !== sharedOrm) maps.ao = await writeTexture(mat.aoMap, `${name} ao`);
    if (mat.emissiveMap) maps.emissive = await writeTexture(mat.emissiveMap, `${name} emissive`, { srgb: true });
    if (mat.alphaMap) maps.opacity = await writeTexture(mat.alphaMap, `${name} opacity`);
    if (mat.clearcoatMap) maps.clearcoat = await writeTexture(mat.clearcoatMap, `${name} clearcoat`);
    if (mat.clearcoatRoughnessMap) maps.clearcoatRoughness = await writeTexture(mat.clearcoatRoughnessMap, `${name} clearcoat roughness`);
    if (mat.transmissionMap) maps.transmission = await writeTexture(mat.transmissionMap, `${name} transmission`);
    if (mat.thicknessMap) maps.thickness = await writeTexture(mat.thicknessMap, `${name} thickness`);
    if (mat.sheenColorMap) maps.sheen = await writeTexture(mat.sheenColorMap, `${name} sheen`, { srgb: true });
    if (mat.sheenRoughnessMap) maps.sheenRoughness = await writeTexture(mat.sheenRoughnessMap, `${name} sheen roughness`);
    if (mat.specularIntensityMap) maps.specularIntensity = await writeTexture(mat.specularIntensityMap, `${name} specular intensity`);
    if (mat.specularColorMap) maps.specularColor = await writeTexture(mat.specularColorMap, `${name} specular color`, { srgb: true });
    if (mat.anisotropyMap) maps.anisotropy = await writeTexture(mat.anisotropyMap, `${name} anisotropy`);

    const hasGraphMaps = Object.values(maps).some(Boolean);
    const factors = {
      color: colorHex(mat.color),
      roughness: typeof mat.roughness === "number" ? mat.roughness : MATERIAL_DEFAULTS.roughness,
      metalness: typeof mat.metalness === "number" ? mat.metalness : MATERIAL_DEFAULTS.metalness,
      ior: typeof mat.ior === "number" ? mat.ior : 1.5,
      specularIntensity: typeof mat.specularIntensity === "number" ? mat.specularIntensity : 0.5,
      specularColor: colorHex(mat.specularColor),
      emissive: colorHex(mat.emissive),
      emissiveStrength: typeof mat.emissiveIntensity === "number" ? mat.emissiveIntensity : 1,
      opacity: typeof mat.opacity === "number" ? mat.opacity : 1,
      ao: typeof mat.aoMapIntensity === "number" ? mat.aoMapIntensity : 1,
      normalScale: typeof mat.normalScale?.x === "number" ? mat.normalScale.x : 1,
      anisotropy: typeof mat.anisotropy === "number" ? mat.anisotropy : null,
      clearcoat: typeof mat.clearcoat === "number" ? mat.clearcoat : null,
      clearcoatRoughness: typeof mat.clearcoatRoughness === "number" ? mat.clearcoatRoughness : null,
      sheen: mat.sheenColor ? colorHex(mat.sheenColor) : null,
      sheenRoughness: typeof mat.sheenRoughness === "number" ? mat.sheenRoughness : null,
      transmission: typeof mat.transmission === "number" ? mat.transmission : null,
      thickness: typeof mat.thickness === "number" ? mat.thickness : null,
      useDiffuseAlpha: !!mat.map && (mat.transparent || mat.alphaTest > 0 || mat.opacity < 1),
    };
    const def = {
      ...MATERIAL_DEFAULTS,
      color: factors.color,
      roughness: factors.roughness,
      metalness: factors.metalness,
      map: maps.diffuse ?? "",
      // Diffuse-only materials stay plain scalar .mat files; the graph only
      // appears when there's something for it to wire.
      shaderGraph: hasGraphMaps
        ? buildPbrGraph(maps, { armHasAo: !!sharedOrm && mat.aoMap === sharedOrm, factors })
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

  // Geometry is extracted for both static and skeletal meshes. Skeletal
  // models retain the GLB only as the owner of their skeleton and clips.
  const geomNames = new Set();
  const geometryFor = async (mesh) => {
    const base = safeName(mesh.name || "Mesh");
    let name = base;
    for (let i = 1; geomNames.has(name); i++) name = `${base} ${i}`;
    geomNames.add(name);
    const path = `${folder}/Geometry/${name}.geom`;
    let definition;
    try {
      definition = geometryAssetFromMesh(mesh.geometry);
    } catch (error) {
      throw new Error(`Could not extract geometry "${mesh.name || "Mesh"}": ${error.message ?? error}`);
    }
    await invoke("save_scene", { path, contents: JSON.stringify(definition) });
    geometryCount++;
    return path;
  };

  if (!skinned && !animated) {
    // --- static path: geometry assets + a mesh-entity tree ------------------
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
    const movedGlb = `${folder}/${stem}.glb`;
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

    const geometryPaths = new Map();
    const rigMeshes = [];
    gltf.scene.traverse((object) => object.isMesh && rigMeshes.push(object));
    for (const mesh of rigMeshes) geometryPaths.set(mesh, await geometryFor(mesh));

    const meshNodes = buildMeshEntities(
      gltf.scene,
      newFid,
      (mesh) => {
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        return materialPaths.get(mat) ?? "";
      },
      (mesh) => geometryPaths.get(mesh) ?? "",
    );
    const rootMesh = meshNodes.shift() ?? null;

    prefabRoot = {
      fid: newFid(),
      name: stem,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      components: [
        { type: "model", props: { path: movedGlb } },
        // The first render surface lives on the prefab root as the user-facing
        // Mesh component. Multi-mesh rigs keep their remaining surfaces as
        // child Mesh handles because an entity can own one component per type.
        ...(rootMesh?.components ?? []),
        ...(animPath ? [{ type: "animation", props: { controller: animPath, playInEditor: true } }] : []),
      ],
      children: [
        // Additional render surfaces remain independently selectable/editable.
        ...meshNodes,
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

  // Converted source formats (FBX today) are retained until conversion,
  // unpack, prefab write, and registration all succeed. A failure leaves the
  // source untouched so the user can inspect or retry it.
  for (const path of cleanupPaths) {
    await invoke("delete_path", { path }).catch(() => {});
    await invoke("delete_path", { path: `${path}.meta` }).catch(() => {});
  }

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
