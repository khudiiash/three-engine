import * as THREE from "three/webgpu";
import { resolveAssetUrl } from "./assetResolver.js";

export const GEOMETRY_ASSET_VERSION = 1;

function finiteArray(value, stride, label) {
  if (!Array.isArray(value) || value.length % stride !== 0 || value.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid geometry ${label}`);
  }
  return value;
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
  if (definition.uvs?.length === (positions.length / 3) * 2) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(finiteArray(definition.uvs, 2, "uvs"), 2));
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export async function loadGeometryAsset(path) {
  const url = await resolveAssetUrl(path);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Geometry request failed (${response.status})`);
  return geometryFromAsset(await response.json());
}
