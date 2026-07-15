import { LoadingManager } from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

import {
  extOf,
  invalidateBlobUrl,
  TEXTURE_EXTENSIONS,
  toBlobUrl,
} from "./assetLoader.js";
import { basename } from "./store/projectStore.js";
import { useAssetProcessingStore } from "./store/assetProcessingStore.js";

const stemOf = (name) => name.replace(/\.[^.]+$/, "");
const dirOf = (path) => path.replace(/[\\/][^\\/]+$/, "");
const MAX_ASCII_FBX_BYTES = 256 * 1024 * 1024;
const nameOfUrl = (url) => {
  const clean = String(url).split(/[?#]/, 1)[0];
  const name = clean.split(/[\\/]/).pop() ?? clean;
  try {
    return decodeURIComponent(name).toLowerCase();
  } catch {
    return name.toLowerCase();
  }
};

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function asArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value).buffer;
  throw new Error("The native file reader returned an unsupported byte format");
}

async function inspectFbx(path) {
  const [size, headValue] = await Promise.all([
    invoke("file_size", { path }),
    invoke("read_binary_file_head", { path, maxBytes: 4096 }),
  ]);
  const head = asArrayBuffer(headValue);
  const text = new TextDecoder().decode(head);
  const binary = text.startsWith("Kaydara FBX Binary  \0");
  const version = binary
    ? new DataView(head).getUint32(23, true)
    : Number(text.match(/FBXVersion:\s*(\d+)/)?.[1] ?? 0);

  if (!binary && !version) {
    throw new Error("Not a recognized binary or ASCII FBX file (no FBX header/version found)");
  }
  if (version < 7000) throw new Error(`FBX ${version} is too old; version 7000 or newer is required`);
  if (!binary && size > MAX_ASCII_FBX_BYTES) {
    const mb = Math.round(size / 1048576).toLocaleString();
    throw new Error(
      `${mb} MB ASCII FBX is too large for the webview parser. ` +
        "Export it as binary FBX, or import the GLTF/GLB version of this asset instead.",
    );
  }
  return { size, version, binary };
}

/**
 * FBX is an interchange source, not an engine runtime format. Parse it once,
 * export an internal GLB, then feed that GLB into the normal unpack pipeline
 * so materials, editable geometry, rigs, clips, and prefabs behave exactly as
 * they do for a native GLB import.
 */
export async function unpackFbx(fbxPath) {
  return useAssetProcessingStore.getState().track(
    (p) => `Converting ${basename(p)}…`,
    (p) => unpackFbxImpl(p),
    fbxPath,
  );
}

async function unpackFbxImpl(fbxPath) {
  const started = performance.now();
  const fileName = basename(fbxPath);
  const stem = stemOf(fileName);
  const dir = dirOf(fbxPath);
  const textureUrls = new Map();
  const info = await inspectFbx(fbxPath);

  // A blob URL has no filesystem base directory. Preload sibling textures and
  // redirect the filenames FBXLoader requests to their own blob URLs. This
  // covers the common FBX + loose PNG/JPG export layout; embedded textures
  // already arrive as data URLs and pass through unchanged.
  try {
    const entries = await invoke("list_dir", { path: dir });
    await Promise.all(
      entries
        .filter((entry) => !entry.is_dir && TEXTURE_EXTENSIONS.includes(entry.ext))
        .map(async (entry) => textureUrls.set(entry.name.toLowerCase(), await toBlobUrl(entry.path))),
    );
  } catch (err) {
    console.warn(`[fbx] Could not index sibling textures for ${fileName}: ${err.message ?? err}`);
  }

  const manager = new LoadingManager();
  manager.setURLModifier((url) => textureUrls.get(nameOfUrl(url)) ?? url);
  let resourcesStarted = false;
  const resourcesLoaded = new Promise((resolve) => {
    manager.onStart = () => {
      resourcesStarted = true;
    };
    manager.onLoad = resolve;
  });
  manager.onError = (url) => console.warn(`[fbx] Missing external resource: ${url}`);

  console.info(`[fbx] Parsing ${fileName}…`);
  // Parse the raw IPC ArrayBuffer directly. Loading through a blob URL makes
  // another full-size copy, which is especially painful for large FBX files.
  const bytes = asArrayBuffer(await invoke("read_binary_file", { path: fbxPath }));
  const root = new FBXLoader(manager).parse(bytes, "");
  if (resourcesStarted) await resourcesLoaded;
  const animations = root.animations ?? [];
  let meshes = 0;
  let triangles = 0;
  root.traverse((object) => {
    if (!object.isMesh) return;
    meshes++;
    const geometry = object.geometry;
    triangles += Math.floor((geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0) / 3);
  });
  console.info(
    `[fbx] Parsed ${fileName}: ${meshes} mesh${meshes === 1 ? "" : "es"}, ` +
      `${triangles.toLocaleString()} triangles, ${animations.length} clip${animations.length === 1 ? "" : "s"}. ` +
      `Converting to GLB…`,
  );

  const glb = await new GLTFExporter().parseAsync(root, {
    binary: true,
    animations,
    onlyVisible: false,
    truncateDrawRange: false,
  });
  if (!(glb instanceof ArrayBuffer)) throw new Error("FBX conversion did not produce a binary GLB");

  // A hidden, collision-resistant intermediate keeps the raw FBX intact until
  // the complete unpack succeeds. Animated/skinned imports move this GLB into
  // their final asset folder; static imports delete it after extracting .geom.
  const tempGlb = `${dir}/.${stem}-${Date.now().toString(36)}-fbx-import.glb`;
  try {
    console.info(`[fbx] Writing ${(glb.byteLength / 1048576).toFixed(1)} MB intermediate GLB…`);
    await invoke("write_binary_file", {
      path: tempGlb,
      contents: Array.from(new Uint8Array(glb)),
    });
    const { unpackGlb } = await import("./glbImport.js");
    const folder = await unpackGlb(tempGlb, { assetStem: stem, cleanupPaths: [fbxPath] });
    invalidateBlobUrl(fbxPath);
    invalidateBlobUrl(tempGlb);
    console.info(`[fbx] Finished ${fileName} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return folder;
  } catch (err) {
    invalidateBlobUrl(tempGlb);
    await invoke("delete_path", { path: tempGlb }).catch(() => {});
    throw err;
  }
}
