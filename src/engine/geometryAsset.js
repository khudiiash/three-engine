import * as THREE from "three/webgpu";
import { loadAssetMeta, resolveAssetUrl } from "./assetResolver.js";

export const GEOMETRY_ASSET_VERSION = 1;

function finiteArray(value, stride, label) {
  if (!Array.isArray(value) || value.length % stride !== 0 || value.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid geometry ${label}`);
  }
  return value;
}

const ARRAY_TYPES = {
  Float32Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
};

function attributeFromAsset(definition, label) {
  const itemSize = definition?.itemSize;
  if (!Number.isInteger(itemSize) || itemSize < 1 || itemSize > 4) {
    throw new Error(`Invalid geometry ${label} item size`);
  }
  const values = finiteArray(definition.array, itemSize, label);
  const ArrayType = ARRAY_TYPES[definition.arrayType] ?? Float32Array;
  return new THREE.BufferAttribute(new ArrayType(values), itemSize, !!definition.normalized);
}

export function geometryFromAsset(definition) {
  if (!definition || definition.version !== GEOMETRY_ASSET_VERSION) {
    throw new Error(`Unsupported geometry asset version ${definition?.version}`);
  }
  const positions = finiteArray(definition.positions, 3, "positions");
  const indices = finiteArray(definition.indices, 3, "indices");
  if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= positions.length / 3)) {
    throw new Error("Geometry indices are out of range");
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  if (definition.edges?.length) {
    const edges = finiteArray(definition.edges, 2, "edges");
    if (edges.some((i) => !Number.isInteger(i) || i < 0 || i >= positions.length / 3)) {
      throw new Error("Geometry edge indices are out of range");
    }
    geometry.userData.editableEdges = Array.from({ length: edges.length / 2 }, (_, index) => edges.slice(index * 2, index * 2 + 2));
  }
  if (Array.isArray(definition.hiddenEdges)) {
    const hiddenEdges = finiteArray(definition.hiddenEdges, 2, "hidden edges");
    if (hiddenEdges.some((i) => !Number.isInteger(i) || i < 0 || i >= positions.length / 3)) {
      throw new Error("Geometry hidden-edge indices are out of range");
    }
    geometry.userData.editableHiddenEdges = Array.from(
      { length: hiddenEdges.length / 2 },
      (_, index) => hiddenEdges.slice(index * 2, index * 2 + 2),
    );
  }
  if (definition.uvs?.length === (positions.length / 3) * 2) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(finiteArray(definition.uvs, 2, "uvs"), 2));
  }
  // Authored normals (GLB imports) beat recomputed ones — recomputing loses
  // smoothing groups / hard edges. Older assets without them still recompute.
  if (definition.normals?.length === positions.length) {
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(finiteArray(definition.normals, 3, "normals"), 3),
    );
  } else geometry.computeVertexNormals();
  for (const [name, attribute] of Object.entries(definition.attributes ?? {})) {
    geometry.setAttribute(name, attributeFromAsset(attribute, `attribute ${name}`));
  }
  for (const [name, targets] of Object.entries(definition.morphAttributes ?? {})) {
    if (!Array.isArray(targets)) throw new Error(`Invalid geometry morph attribute ${name}`);
    geometry.morphAttributes[name] = targets.map((target, index) =>
      attributeFromAsset(target, `morph attribute ${name}[${index}]`),
    );
  }
  geometry.morphTargetsRelative = !!definition.morphTargetsRelative;
  if (Array.isArray(definition.groups)) {
    for (const group of definition.groups) {
      if ([group?.start, group?.count, group?.materialIndex].every(Number.isInteger)) {
        geometry.addGroup(group.start, group.count, group.materialIndex);
      }
    }
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export async function loadGeometryAsset(path) {
  // Reject non-`.geom` paths up-front so a stale scene reference (e.g. a
  // component that still points at a `.glb` from before that asset was
  // unpacked into editable `.geom` files) doesn't hit the network and
  // surface as a confusing "Unexpected token 'g', ...is not valid JSON"
  // parse error. Callers translate this into a clean warning.
  const ext = String(path ?? "").split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  if (ext !== "geom") {
    throw new Error(`Geometry asset must be a .geom file (got .${ext || "<none>"}): "${path}"`);
  }
  const [url, meta] = await Promise.all([
    resolveAssetUrl(path),
    loadAssetMeta(`${path}.meta`),
  ]);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Geometry request failed (${response.status})`);
  const geometry = geometryFromAsset(await response.json());
  geometry.userData.assetPath = path;
  // GI validates the content hash before using this. Keeping the runtime
  // loader subsystem-agnostic lets exported games consume the same sidecar
  // without making the engine core depend on the optional GI module.
  if (meta?.giRayProxy) geometry.userData.giRayProxy = meta.giRayProxy;
  return geometry;
}
