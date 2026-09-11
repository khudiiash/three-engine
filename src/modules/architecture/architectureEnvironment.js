import * as THREE from "three/webgpu";

function inside(x, z, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
function edgeDistance(x, z, polygon) {
  let min = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = THREE.MathUtils.clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    min = Math.min(min, Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz));
  }
  return min;
}
function visible(entity, playing) {
  for (let node = entity; node; node = node.parent) {
    if (node.enabled === false || node[playing ? "enabledInGame" : "enabledInEditor"] === false) return false;
  }
  return true;
}

/** Cached spatial mask of authored Architecture footprints. It is consumed by
 * foliage as a reversible filter of the original seeded scatter. No terrain
 * heights, vegetation source data or user assets are rewritten. */
export class ArchitectureEnvironment {
  constructor(engine) {
    this.engine = engine;
    this.dirty = true;
    this.revision = 0;
    this.signature = "";
    this.cells = new Map();
    this.large = [];
    this.cache = new WeakMap();
    this.volumes = [];
    this.point = new THREE.Vector3();
    const dirty = () => { this.dirty = true; };
    this.unsub = ["hierarchy-changed", "transform-changed", "component-added", "component-removed", "play-changed"].map(event => engine.on?.(event, dirty));
    this.unsub.push(engine.on?.("component-changed", event => {
      if (["architecture", "architecturepiece", "blockout"].includes(event?.componentType)) dirty();
    }));
  }
  snapshot() {
    // Runtime scripts may move Object3Ds directly without an editor event.
    // Poll at a bounded cadence, shared by all foliage layers.
    const now = performance.now();
    if (!this.dirty && now - (this.checkedAt ?? -Infinity) < 200) return this;
    this.checkedAt = now;
    this.dirty = false;
    const volumes = [];
    const box = new THREE.Box3(), worldBox = new THREE.Box3();
    const walk = entity => {
      const architecture = entity.getComponent?.("architecture");
      if (architecture?.enabled !== false && architecture?.props.settings?.clearFoliage && visible(entity, this.engine.playing)) {
        const padding = Math.max(0, Math.min(100, Number(architecture.props.settings.foliagePadding) || 0));
        for (const piece of architecture.footprintPieces?.() ?? architecture.pieces()) {
          if (piece.enabled === false || !visible(piece.entity, this.engine.playing)) continue;
          const object = piece.entity.object3D;
          object.updateWorldMatrix(true, false);
          const previous = this.cache.get(piece);
          if (previous && previous.padding === padding && previous.geometry === piece.geometry && previous.size === piece.props.size && previous.footprint === piece.props.footprint && previous.holes === piece.props.holes && previous.matrix.every((n, i) => n === object.matrixWorld.elements[i])) {
            volumes.push(previous.volume);
            continue;
          }
          const bounds = piece.bounds();
          box.set(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1]));
          worldBox.copy(box).applyMatrix4(object.matrixWorld).expandByScalar(padding);
          const matrix = object.matrixWorld;
          if (Math.abs(matrix.determinant()) < 1e-12) continue;
          const scale = new THREE.Vector3().setFromMatrixScale(matrix);
          const polygon = piece.props.footprint?.length ? piece.props.footprint : [[bounds[0][0], bounds[0][2]], [bounds[1][0], bounds[0][2]], [bounds[1][0], bounds[1][2]], [bounds[0][0], bounds[1][2]]];
          const volume = { inverse: matrix.clone().invert(), polygon, holes: piece.props.holes ?? [], padding: padding / Math.max(.001, Math.min(Math.abs(scale.x), Math.abs(scale.z))), y: worldBox.getCenter(this.point).y, minX: worldBox.min.x, maxX: worldBox.max.x, minZ: worldBox.min.z, maxZ: worldBox.max.z };
          // Tilted structures need the projection of the actual solid, not
          // an inverse transform of a horizontal cross-section.
          const e = matrix.elements;
          if (Math.abs(e[1]) + Math.abs(e[9]) + Math.abs(e[4]) + Math.abs(e[6]) > 1e-7 && piece.geometry) {
            volume.triangles = []; volume.worldPadding = padding;
            const attr = piece.geometry.attributes.position, index = piece.geometry.index;
            for (let i = 0; i < (index?.count ?? attr.count); i += 3) {
              const triangle = [];
              for (let j = 0; j < 3; j++) {
                this.point.fromBufferAttribute(attr, index ? index.getX(i + j) : i + j).applyMatrix4(matrix);
                triangle.push([this.point.x, this.point.z]);
              }
              const [a, b, c] = triangle;
              if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 1e-10) volume.triangles.push(triangle);
            }
          }
          volumes.push(volume);
          this.cache.set(piece, { volume, matrix: [...matrix.elements], padding, geometry: piece.geometry, size: piece.props.size, footprint: piece.props.footprint, holes: piece.props.holes });
        }
      }
      for (const child of entity.children ?? []) walk(child);
    };
    for (const root of this.engine.rootEntities ?? []) walk(root);
    if (volumes.length === this.volumes.length && volumes.every((volume, i) => volume === this.volumes[i])) return this;
    this.volumes = volumes;
    this.revision++;
    this.cells.clear(); this.large = [];
    for (const volume of volumes) {
      const x0 = Math.floor(volume.minX / 32), x1 = Math.floor(volume.maxX / 32), z0 = Math.floor(volume.minZ / 32), z1 = Math.floor(volume.maxZ / 32);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096) { this.large.push(volume); continue; }
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const key = `${x},${z}`;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(volume);
      }
    }
    return this;
  }
  excludes(position) {
    const [x, , z] = position;
    const candidates = this.cells.get(`${Math.floor(x / 32)},${Math.floor(z / 32)}`) ?? [];
    const contains = volume => {
      if (x < volume.minX || x > volume.maxX || z < volume.minZ || z > volume.maxZ) return false;
      if (volume.triangles) return volume.triangles.some(triangle => inside(x, z, triangle) || edgeDistance(x, z, triangle) <= volume.worldPadding);
      this.point.set(x, volume.y, z).applyMatrix4(volume.inverse);
      const { polygon, holes, padding } = volume;
      const px = this.point.x, pz = this.point.z;
      if (!inside(px, pz, polygon) && edgeDistance(px, pz, polygon) > padding) return false;
      return !holes.some(hole => inside(px, pz, hole) && edgeDistance(px, pz, hole) > padding);
    };
    return candidates.some(contains) || this.large.some(contains);
  }
  dispose() {
    for (const unsub of this.unsub) unsub?.();
    this.cells.clear(); this.large = []; this.volumes = []; this.cache = new WeakMap();
  }
}
