// CPU-only fingerprint for the facts baked into triangleSoup.worker output.
// Albedo/emissive values are deliberately absent: they re-tint palette uniforms
// without changing any triangle's class byte.

export const gi2MaterialParticipates = (material) => !!material
  && !material.transparent
  && !material.isVolumeNodeMaterial
  && !material.userData?.isVolumeMaterial;

const triCountOf = (geometry) => {
  const indexCount = geometry?.index?.count ?? geometry?.index?.length;
  const positionCount = geometry?.attributes?.position?.count
    ?? (geometry?.positions?.length != null ? geometry.positions.length / 3 : 0);
  return Math.max(0, Math.floor((indexCount ?? positionCount ?? 0) / 3));
};

/** Same normalization/order triangleSoup.worker applies before its hot loop. */
export function normalizedSoupGroups(geometry) {
  const triCount = triCountOf(geometry);
  return (geometry?.groups ?? []).map((group) => {
    const start = Math.max(0, Math.floor(Number(group?.start) || 0));
    const count = Math.max(0, Math.floor(Number(group?.count) || 0));
    return {
      start: Math.min(triCount, Math.floor(start / 3)),
      end: Math.min(triCount, Math.ceil((start + count) / 3)),
      materialIndex: Math.max(0, Math.floor(Number(group?.materialIndex) || 0)),
    };
  }).filter((group) => group.end > group.start)
    .sort((a, b) => (a.start - b.start)
      || (a.end - b.end)
      || (a.materialIndex - b.materialIndex));
}

const geometryOf = (item) => item?.mesh?.geometry ?? item?.geometry ?? item;
const materialActiveOf = (item) => {
  const explicit = item?.materialActive ?? item?.active;
  if (explicit != null) return Array.from(explicit, Boolean);
  const mesh = item?.mesh ?? item;
  const materials = Array.isArray(mesh?.material) && mesh.material.length
    ? mesh.material
    : [mesh?.material];
  return materials.map(gi2MaterialParticipates);
};

const identityOf = (item, geometry, index) => {
  const explicit = item?.geometryKey;
  if (explicit != null) return String(explicit);
  if (geometry?.uuid != null) return String(geometry.uuid);
  if (geometry?.id != null) return String(geometry.id);
  return `at${index}`;
};

/**
 * Canonical topology string for raw meshes or enriched soup placements.
 *
 * Geometry groups are deduplicated by geometry identity. Active material slots
 * remain per item/placement because two meshes may share geometry while one
 * makes a referenced slot transparent. Length prefixes keep concatenation
 * unambiguous and avoid relying on a collision-prone 32-bit hash.
 */
export function gi2SoupTopologyKey(items) {
  const list = Array.from(items ?? []);
  const geometries = new Map();
  const active = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const geometry = geometryOf(item);
    const identity = identityOf(item, geometry, i);
    if (!geometries.has(identity)) {
      const groups = normalizedSoupGroups(geometry);
      geometries.set(identity,
        `${identity.length}:${identity}/${triCountOf(geometry)}/${groups.length}/`
        + groups.map((g) => `${g.start},${g.end},${g.materialIndex}`).join(";"));
    }
    const slots = materialActiveOf(item);
    active.push(`${slots.length}:${slots.map((on) => on ? "1" : "0").join("")}`);
  }
  return `g${geometries.size}[${[...geometries.values()].sort().join("|")}]`
    + `a${active.length}[${active.join("|")}]`;
}

/** The content scanner's action, extracted so retint-vs-rebuild is testable. */
export function gi2SoupUpdateKind(previousTopology, nextTopology, contentChanged) {
  if (previousTopology != null && nextTopology !== previousTopology) return "rebuild";
  return contentChanged ? "retint" : "none";
}
