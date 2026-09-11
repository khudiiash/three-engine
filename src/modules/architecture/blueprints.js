/**
 * Architecture recipes emit ordinary editable pieces, never private scene meshes.
 * X/Z positions are in metres, Y is up, yaw is in radians. Floor and platform
 * pieces hang below their origin; every other primitive stands on it.
 * `floors` is the serialized assembly grouping, also used by non-building recipes.
 */

const DEFAULTS = {
  preset: 'house', kind: 'building', name: '', width: 12, depth: 10,
  storeys: 2, storeyHeight: 3.2, wallThickness: 0.24, slabThickness: 0.2,
  foundationDepth: 0.6, roof: 'gable', roofHeight: 2, roofOverhang: 0.35,
  windows: true, windowWidth: 1.4, windowHeight: 1.3, windowSill: 0.9,
  windowSpacing: 3.2, doorWidth: 1.2, doorHeight: 2.2,
  stairs: true, stairWidth: 1.2, footprint: 'rectangle', customFootprint: [],
  wingWidth: 5, courtyardRatio: 0.4, sides: 12, interior: 'open', roomSize: 6,
  seed: 1, rows: 3, columns: 3, streetWidth: 8, setback: 3, variation: 0.45,
  maxPieces: 8000, pieces: [], terrainFit: 'none', terrainId: '',
  avoidWater: false, waterClearance: 0, clearFoliage: false,
  foliagePadding: 1, collision: true, materials: {},
};

export const ARCHITECTURE_PRESETS = [
  { id: 'house', label: 'House', description: 'Two connected levels, windows and a pitched roof.', kind: 'building', settings: { width: 12, depth: 10, storeys: 2, roof: 'gable' } },
  { id: 'apartment', label: 'Apartment', description: 'Connected storeys and rooms with connecting doorways.', kind: 'building', settings: { width: 22, depth: 16, storeys: 5, roof: 'flat', interior: 'rooms', roomSize: 7 } },
  { id: 'tower', label: 'Tower', description: 'A tall building with a continuous stair core.', kind: 'building', settings: { width: 18, depth: 18, storeys: 12, roof: 'flat' } },
  { id: 'warehouse', label: 'Warehouse', description: 'A wide, open hall with a high roof and loading entrance.', kind: 'building', settings: { width: 32, depth: 22, storeys: 1, storeyHeight: 6, roofHeight: 4, doorWidth: 4, doorHeight: 4.5, windowSill: 3, windows: true } },
  { id: 'courtyard', label: 'Courtyard', description: 'A building around an open central court.', kind: 'building', settings: { width: 30, depth: 30, storeys: 3, footprint: 'courtyard', courtyardRatio: 0.42, roof: 'flat' } },
  { id: 'custom', label: 'Custom footprint', description: 'An editable building from a simple polygon in metres.', kind: 'building', settings: { footprint: 'custom', roof: 'flat', customFootprint: [[-10, -6], [5, -8], [10, -1], [7, 7], [-5, 8], [-10, 2]] } },
  { id: 'pavilion', label: 'Pavilion', description: 'An open column-supported canopy; rectangular or polygonal.', kind: 'pavilion', settings: { width: 14, depth: 10, storeys: 1, storeyHeight: 4, windows: false, stairs: false } },
  { id: 'bridge', label: 'Bridge', description: 'An elevated deck with piers, rails and access ramps.', kind: 'bridge', settings: { width: 8, depth: 40, storeys: 1, storeyHeight: 5, roof: 'none', windows: false, stairs: false } },
  { id: 'fortress', label: 'Fortress', description: 'Walkable perimeter galleries, a gate and corner turrets.', kind: 'fortress', settings: { width: 36, depth: 36, storeys: 2, storeyHeight: 4, footprint: 'courtyard', courtyardRatio: 0.6, roof: 'flat', windows: false, doorWidth: 3, doorHeight: 3.2 } },
  { id: 'city', label: 'City block', description: 'Seeded buildings in serviced lots with streets and pavements.', kind: 'city', settings: { width: 18, depth: 16, storeys: 4, roof: 'flat', rows: 3, columns: 3, variation: 0.5 } },
  { id: 'assembly', label: 'Freeform assembly', description: 'Arbitrary pieces at any height, without a building or storey layout.', kind: 'assembly', settings: { storeys: 1, roof: 'none', stairs: false, pieces: [] } },
];

const KINDS = ['building', 'city', 'bridge', 'pavilion', 'fortress', 'assembly'];
const SHAPES = ['floor', 'wall', 'stair', 'ramp', 'box', 'column', 'platform'];
const EPS = 1e-7;
const number = (value, fallback, min, max) => {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
};
const integer = (value, fallback, min, max) => Math.round(number(value, fallback, min, max));
const choice = (value, values, fallback) => values.includes(value) ? value : fallback;
const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const cleanName = (value, fallback = '') => typeof value === 'string' ? value.slice(0, 120) : fallback;
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const area = (points) => points.reduce((sum, p, i) => {
  const q = points[(i + 1) % points.length];
  return sum + p[0] * q[1] - q[0] * p[1];
}, 0) / 2;
const onSegment = (a, b, p) => Math.abs(cross(a, b, p)) < EPS && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
function intersects(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return (abC * abD < -EPS && cdA * cdB < -EPS) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/** Reject invalid outlines rather than quietly creating solid triangles across a bow tie. */
function polygon(input, label = 'Custom footprint') {
  if (!Array.isArray(input) || input.length < 3 || input.length > 65) throw new Error(`${label} requires 3 to 64 vertices.`);
  let points = input.map((p) => {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) throw new Error(`${label} vertices must be finite [x, z] coordinates.`);
    if (Math.abs(Number(p[0])) > 10000 || Math.abs(Number(p[1])) > 10000) throw new Error(`${label} coordinates must be within 10,000 metres.`);
    return [Number(p[0]), Number(p[1])];
  });
  if (Math.hypot(points[0][0] - points.at(-1)[0], points[0][1] - points.at(-1)[1]) < EPS) points.pop();
  if (points.length < 3 || points.length > 64) throw new Error(`${label} requires 3 to 64 vertices.`);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01) throw new Error(`${label} has a repeated vertex or an edge shorter than 1 cm.`);
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (intersects(a, b, points[j], points[(j + 1) % points.length])) throw new Error(`${label} must be a simple polygon without crossing edges.`);
    }
  }
  // Collinear reversals are adjacent edges, so the non-adjacent test above cannot catch them.
  for (let i = 0; i < points.length; i++) {
    const a = points[(i + points.length - 1) % points.length], b = points[i], c = points[(i + 1) % points.length];
    if (Math.abs(cross(a, b, c)) < EPS && ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) < 0) throw new Error(`${label} has overlapping edges.`);
  }
  if (Math.abs(area(points)) < 0.01) throw new Error(`${label} must enclose at least 0.01 square metres.`);
  if (area(points) < 0) points = points.reverse();
  return points;
}

function bounds(points) {
  return { minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])), minZ: Math.min(...points.map(p => p[1])), maxZ: Math.max(...points.map(p => p[1])) };
}

function inside(point, points) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if (onSegment(a, b, point)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function validateHoles(points, holes, label) {
  for (let index = 0; index < holes.length; index++) {
    const hole = holes[index];
    if (!hole.every(p => inside(p, points))) throw new Error(`${label}: openings must lie completely inside the slab.`);
    for (let i = 0; i < hole.length; i++) for (let j = 0; j < points.length; j++) {
      if (intersects(hole[i], hole[(i + 1) % hole.length], points[j], points[(j + 1) % points.length])) throw new Error(`${label}: an opening touches or crosses the slab boundary.`);
    }
    for (let prior = 0; prior < index; prior++) {
      const other = holes[prior];
      if (hole.some(p => inside(p, other)) || other.some(p => inside(p, hole))) throw new Error(`${label}: slab openings must not overlap.`);
      for (let i = 0; i < hole.length; i++) for (let j = 0; j < other.length; j++) {
        if (intersects(hole[i], hole[(i + 1) % hole.length], other[j], other[(j + 1) % other.length])) throw new Error(`${label}: slab openings must not overlap.`);
      }
    }
  }
}

function normalizePiece(input, index) {
  const p = input && typeof input === 'object' ? input : {};
  const shape = choice(p.shape, SHAPES, 'box');
  const props = p.props && typeof p.props === 'object' ? p.props : {};
  const out = {
    name: cleanName(p.name, `Piece ${index + 1}`), shape,
    size: [0, 1, 2].map(i => number(p.size?.[i] ?? props.size?.[i], 1, 0.001, 10000)),
    position: [0, 1, 2].map(i => number(p.position?.[i], 0, -100000, 100000)),
    rotationY: number(p.rotationY, 0, -Math.PI * 20000, Math.PI * 20000),
    role: cleanName(p.role).trim().slice(0, 64) || (shape === 'floor' || shape === 'platform' ? 'floor' : shape === 'wall' ? 'wall' : 'structure'),
    props: {},
  };
  if (Array.isArray(p.rotation)) out.rotation = [0, 1, 2].map(i => number(p.rotation[i], 0, -Math.PI * 20000, Math.PI * 20000));
  if (shape === 'stair') { out.props.steps = integer(props.steps, Math.ceil(out.size[1] / 0.18), 1, 64); out.props.open = bool(props.open, false); }
  if (shape === 'column') out.props.sides = integer(props.sides, 12, 3, 48);
  if (typeof props.color === 'string') out.props.color = props.color.slice(0, 40);
  if (typeof props.material === 'string') out.props.material = props.material.slice(0, 1024);
  if (shape === 'wall' && Array.isArray(props.openings)) out.props.openings = props.openings.slice(0, 64).map(o => ({
    offset: number(o?.offset, 0, -out.size[0] / 2, out.size[0] / 2),
    width: number(o?.width, 1.2, 0.01, out.size[0]),
    height: number(o?.height, 2.2, 0.01, out.size[1]),
    sill: number(o?.sill, 0, 0, out.size[1]),
  }));
  if ((shape === 'floor' || shape === 'platform') && props.footprint) {
    out.props.footprint = polygon(props.footprint, `${out.name} footprint`);
    if (Array.isArray(props.holes)) {
      if (props.holes.length > 32) throw new Error(`${out.name} supports up to 32 slab openings.`);
      out.props.holes = props.holes.map((h, i) => polygon(h, `${out.name} hole ${i + 1}`));
      validateHoles(out.props.footprint, out.props.holes, out.name);
    }
  }
  return out;
}

/** All limits are applied before any recipe loop, including inputs from saved files or scripts. */
export function normalizeArchitectureSettings(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const preset = ARCHITECTURE_PRESETS.find(p => p.id === input.preset) ?? ARCHITECTURE_PRESETS[0];
  const s = { ...DEFAULTS, ...preset.settings, kind: preset.kind, ...input, preset: preset.id };
  const result = {
    preset: preset.id, kind: choice(s.kind, KINDS, preset.kind), name: cleanName(s.name),
    width: number(s.width, 12, 6, 500), depth: number(s.depth, 10, 6, 500),
    storeys: integer(s.storeys, 2, 1, 32), storeyHeight: number(s.storeyHeight, 3.2, 2.4, 12),
    wallThickness: number(s.wallThickness, 0.24, 0.08, 1), slabThickness: number(s.slabThickness, 0.2, 0.08, 1),
    foundationDepth: number(s.foundationDepth, 0.6, 0, 20), roof: choice(s.roof, ['flat', 'gable', 'none'], 'flat'),
    roofHeight: number(s.roofHeight, 2, 0.1, 30), roofOverhang: number(s.roofOverhang, 0.35, 0, 3),
    windows: bool(s.windows, true), windowWidth: number(s.windowWidth, 1.4, 0.3, 8),
    windowHeight: number(s.windowHeight, 1.3, 0.3, 6), windowSill: number(s.windowSill, 0.9, 0.1, 10),
    windowSpacing: number(s.windowSpacing, 3.2, 1, 20), doorWidth: number(s.doorWidth, 1.2, 0.8, 10),
    doorHeight: number(s.doorHeight, 2.2, 1.8, 10), stairs: bool(s.stairs, true), stairWidth: number(s.stairWidth, 1.2, 0.9, 4),
    footprint: choice(s.footprint, ['rectangle', 'l-shape', 'courtyard', 'custom', 'circle'], 'rectangle'),
    customFootprint: [], wingWidth: number(s.wingWidth, 5, 3, 100), courtyardRatio: number(s.courtyardRatio, 0.4, 0.15, 0.75),
    sides: integer(s.sides, 12, 6, 48), interior: choice(s.interior, ['open', 'rooms'], 'open'), roomSize: number(s.roomSize, 6, 3, 50),
    seed: integer(s.seed, 1, 0, 4294967295), rows: integer(s.rows, 3, 1, 12), columns: integer(s.columns, 3, 1, 12),
    streetWidth: number(s.streetWidth, 8, 2, 60), setback: number(s.setback, 3, 1, 50), variation: number(s.variation, 0.45, 0, 1),
    maxPieces: integer(s.maxPieces, 8000, 32, 20000), pieces: [],
    terrainFit: choice(s.terrainFit, ['none', 'highest'], 'none'), terrainId: cleanName(s.terrainId),
    avoidWater: bool(s.avoidWater, false), waterClearance: number(s.waterClearance, 0, 0, 100),
    clearFoliage: bool(s.clearFoliage, false), foliagePadding: number(s.foliagePadding, 1, 0, 100),
    collision: bool(s.collision, true), materials: {},
  };
  result.windowHeight = Math.min(result.windowHeight, result.storeyHeight - 0.4);
  result.windowSill = Math.min(result.windowSill, result.storeyHeight - result.windowHeight - 0.2);
  result.doorHeight = Math.min(result.doorHeight, result.storeyHeight - 0.15);
  result.wingWidth = Math.min(result.wingWidth, result.width * 0.8, result.depth * 0.8);
  if (result.footprint === 'custom') {
    result.customFootprint = polygon(s.customFootprint);
    const b = bounds(result.customFootprint);
    result.width = b.maxX - b.minX; result.depth = b.maxZ - b.minZ;
  } else if (Array.isArray(s.customFootprint) && s.customFootprint.length) {
    result.customFootprint = polygon(s.customFootprint);
  }
  if (s.materials && typeof s.materials === 'object') for (const role of Object.keys(s.materials).slice(0, 64)) {
    if (role.length <= 64 && !['__proto__', 'prototype', 'constructor'].includes(role) && typeof s.materials[role] === 'string') result.materials[role] = s.materials[role].slice(0, 1024);
  }
  if (Array.isArray(s.pieces)) result.pieces = s.pieces.slice(0, result.maxPieces).map(normalizePiece);
  return result;
}

const rect = (minX, minZ, maxX, maxZ) => [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
function outline(s) {
  const x = s.width / 2, z = s.depth / 2;
  if (s.footprint === 'custom') return { points: s.customFootprint.map(p => [...p]), holes: [] };
  if (s.footprint === 'circle') return { points: Array.from({ length: s.sides }, (_, i) => { const a = i * Math.PI * 2 / s.sides; return [Math.cos(a) * x, Math.sin(a) * z]; }), holes: [] };
  if (s.footprint === 'l-shape') return { points: [[-x, -z], [x, -z], [x, -z + s.wingWidth], [-x + s.wingWidth, -z + s.wingWidth], [-x + s.wingWidth, z], [-x, z]], holes: [] };
  return { points: rect(-x, -z, x, z), holes: s.footprint === 'courtyard' ? [rect(-x * s.courtyardRatio, -z * s.courtyardRatio, x * s.courtyardRatio, z * s.courtyardRatio)] : [] };
}

function piece(name, shape, size, position, role, props = {}, rotationY = 0) {
  return { name, shape, size, position, rotationY, props, role };
}

function floorPiece(name, points, holes, thickness, y, role = 'floor') {
  const b = bounds(points);
  return piece(name, 'floor', [b.maxX - b.minX, thickness, b.maxZ - b.minZ], [0, y, 0], role,
    { footprint: points.map(p => [...p]), ...(holes.length ? { holes: holes.map(h => h.map(p => [...p])) } : {}) });
}

/** Rectangle subtraction produces real slab holes using standard editable boxes. */
function splitRectangle(source, hole) {
  const x0 = Math.max(source.minX, hole.minX), x1 = Math.min(source.maxX, hole.maxX);
  const z0 = Math.max(source.minZ, hole.minZ), z1 = Math.min(source.maxZ, hole.maxZ);
  if (x1 <= x0 + EPS || z1 <= z0 + EPS) return [source];
  return [
    { minX: source.minX, maxX: x0, minZ: source.minZ, maxZ: source.maxZ },
    { minX: x1, maxX: source.maxX, minZ: source.minZ, maxZ: source.maxZ },
    { minX: x0, maxX: x1, minZ: source.minZ, maxZ: z0 },
    { minX: x0, maxX: x1, minZ: z1, maxZ: source.maxZ },
  ].filter(r => r.maxX - r.minX > EPS && r.maxZ - r.minZ > EPS);
}

function slabs(s, plan, shaft, name, thickness, y, role = 'floor') {
  const rectangular = ['rectangle', 'l-shape', 'courtyard'].includes(s.footprint);
  if (!rectangular) return [floorPiece(name, plan.points, [...plan.holes, ...(shaft ? [shaft.points] : [])], thickness, y, role)];
  const b = bounds(plan.points);
  let rectangles = [b];
  if (s.footprint === 'l-shape') rectangles = splitRectangle(b, { minX: b.minX + s.wingWidth, minZ: b.minZ + s.wingWidth, maxX: b.maxX, maxZ: b.maxZ });
  for (const hole of [...plan.holes, ...(shaft ? [shaft.points] : [])]) rectangles = rectangles.flatMap(r => splitRectangle(r, bounds(hole)));
  return rectangles.map((r, i) => piece(`${name}${rectangles.length > 1 ? ` ${i + 1}` : ''}`, 'floor', [r.maxX - r.minX, thickness, r.maxZ - r.minZ], [(r.minX + r.maxX) / 2, y, (r.minZ + r.maxZ) / 2], role));
}

function rectangleFits(points, plan) {
  if (!points.every(p => inside(p, plan.points))) return false;
  for (const boundary of [plan.points, ...plan.holes]) {
    for (let i = 0; i < points.length; i++) for (let j = 0; j < boundary.length; j++) {
      if (intersects(points[i], points[(i + 1) % points.length], boundary[j], boundary[(j + 1) % boundary.length])) return false;
    }
  }
  for (const hole of plan.holes) if (points.some(p => inside(p, hole)) || hole.some(p => inside(p, points))) return false;
  return true;
}

function stairCore(s, plan) {
  const b = bounds(plan.points), margin = s.wallThickness / 2 + 0.2;
  const stairWidth = s.stairWidth, width = stairWidth * 2 + 0.1;
  const landing = Math.max(stairWidth, 1.1), targetRun = Math.max(2, s.storeyHeight * 0.78);
  for (const scale of [1, 0.8, 0.6]) {
    const run = Math.max(1.5, targetRun * scale), depth = run + landing;
    for (const rotated of [false, true]) {
      const hw = (rotated ? depth : width) / 2, hd = (rotated ? width : depth) / 2;
      const loX = b.minX + hw + margin, hiX = b.maxX - hw - margin;
      const loZ = b.minZ + hd + margin, hiZ = b.maxZ - hd - margin;
      if (hiX < loX || hiZ < loZ) continue;
      for (let ix = 0; ix <= 10; ix++) for (let iz = 0; iz <= 10; iz++) {
        const x = loX + (hiX - loX) * ix / 10, z = hiZ - (hiZ - loZ) * iz / 10;
        if (!rectangleFits(rect(x - hw - margin / 2, z - hd - margin / 2, x + hw + margin / 2, z + hd + margin / 2), plan)) continue;
        return { x, z, width, depth, run, landing, stairWidth, rotationY: rotated ? Math.PI / 2 : 0, points: rect(x - hw, z - hd, x + hw, z + hd), compressed: scale < 1 };
      }
    }
  }
  return null;
}

function stairs(s, core) {
  const yaw = core.rotationY, cos = Math.cos(yaw), sin = Math.sin(yaw);
  const transform = (x, y, z) => [core.x + x * cos + z * sin, y, core.z - x * sin + z * cos];
  const lane = (core.stairWidth + 0.1) / 2;
  // Stacked solid wedges have an underside at the next assembly elevation and
  // would crush headroom above the upper treads of the flight below. Tread
  // geometry follows the rise, preserving the same clearance along every level.
  const props = { steps: Math.min(64, Math.ceil(s.storeyHeight / 2 / 0.18)), open: true };
  return [
    piece('Stair flight up', 'stair', [core.stairWidth, s.storeyHeight / 2, core.run], transform(-lane, 0, -core.landing / 2), 'structure', props, yaw),
    piece('Stair return flight', 'stair', [core.stairWidth, s.storeyHeight / 2, core.run], transform(lane, s.storeyHeight / 2, -core.landing / 2), 'structure', { ...props }, yaw + Math.PI),
    piece('Stair half landing', 'platform', [core.width, s.slabThickness, core.landing], transform(0, s.storeyHeight / 2, core.run / 2), 'structure', {}, yaw),
  ];
}

function openings(s, length, entrance) {
  const list = [], margin = Math.max(s.wallThickness, 0.18);
  const usable = length - margin * 2;
  if (entrance && usable > 0.4) list.push({ offset: 0, width: Math.min(s.doorWidth, usable), height: s.doorHeight, sill: 0 });
  if (!s.windows || usable < s.windowWidth) return list;
  const count = Math.min(64, Math.max(1, Math.floor(usable / Math.max(s.windowSpacing, s.windowWidth + margin))));
  const spacing = usable / count;
  for (let i = 0; i < count; i++) {
    const offset = -usable / 2 + spacing * (i + 0.5);
    if (list.some(o => Math.abs(o.offset - offset) < (o.width + s.windowWidth) / 2 + margin)) continue;
    list.push({ offset, width: Math.min(s.windowWidth, spacing - margin), height: s.windowHeight, sill: s.windowSill });
  }
  return list;
}

function wallEdges(s, boundary, storey, label, courtyard = false) {
  const edges = boundary.map((a, i) => { const b = boundary[(i + 1) % boundary.length]; return { a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]), x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, i }; });
  const jambs = Math.max(s.wallThickness, 0.18) * 2;
  const eligible = edges.filter(e => e.length >= s.doorWidth + jambs);
  const entrance = [...(eligible.length ? eligible : edges)].sort((a, b) => a.z - b.z || b.length - a.length)[0]?.i;
  const portal = new Set([entrance]);
  if (!eligible.length) {
    // A circular facade can have panels narrower than a door. Open adjoining
    // panels across the entrance instead of silently sealing a small circle.
    let length = edges[entrance].length;
    for (let distance = 1; length < s.doorWidth + jambs && portal.size < edges.length; distance++) {
      for (const sign of [-1, 1]) {
        const index = (entrance + distance * sign + edges.length) % edges.length;
        if (!portal.has(index)) { portal.add(index); length += edges[index].length; }
        if (length >= s.doorWidth + jambs) break;
      }
    }
  }
  return edges.map(edge => {
    const door = storey === 0 && portal.has(edge.i), length = edge.length + s.wallThickness * 0.45;
    const holes = door && !eligible.length ? [{ offset: 0, width: length, height: s.doorHeight, sill: 0 }] : openings(s, edge.length, door);
    return piece(`${label} ${edge.i + 1}${door ? courtyard ? ' court entrance' : ' entrance' : ''}`, 'wall', [length, s.storeyHeight, s.wallThickness], [edge.x, 0, edge.z], 'wall',
      { openings: holes }, -Math.atan2(edge.b[1] - edge.a[1], edge.b[0] - edge.a[0]));
  });
}

function partitions(s, plan, core) {
  if (s.interior !== 'rooms' || s.footprint !== 'rectangle') return [];
  const b = bounds(plan.points), out = [], shaft = core ? bounds(core.points) : null;
  // Every room wall has a doorway, and core crossings are omitted. Partitions
  // do not form unenterable sealed cells or cut through either stair flight.
  for (const alongX of [true, false]) {
    const min = alongX ? b.minZ : b.minX, max = alongX ? b.maxZ : b.maxX;
    const lengthMin = (alongX ? b.minX : b.minZ) + s.wallThickness / 2;
    const lengthMax = (alongX ? b.maxX : b.maxZ) - s.wallThickness / 2;
    const count = Math.min(12, Math.floor((max - min) / s.roomSize));
    for (let i = 1; i < count; i++) {
      const coordinate = min + (max - min) * i / count;
      let segments = [[lengthMin, lengthMax]];
      const gapMin = alongX ? shaft?.minX : shaft?.minZ, gapMax = alongX ? shaft?.maxX : shaft?.maxZ;
      const crosses = shaft && coordinate > (alongX ? shaft.minZ : shaft.minX) - s.wallThickness && coordinate < (alongX ? shaft.maxZ : shaft.maxX) + s.wallThickness;
      if (crosses) segments = [[lengthMin, gapMin - 0.1], [gapMax + 0.1, lengthMax]];
      for (const [start, end] of segments) {
        const length = end - start;
        if (length < s.doorWidth + 0.4) continue;
        const mid = (start + end) / 2;
        const stepCount = Math.max(1, Math.ceil(length / s.roomSize));
        const doors = Array.from({ length: stepCount }, (_, j) => ({ offset: -length / 2 + length * (j + 0.5) / stepCount, width: Math.min(s.doorWidth, length / stepCount - 0.2), height: s.doorHeight, sill: 0 }));
        out.push(piece(`Partition ${out.length + 1}`, 'wall', [length, s.storeyHeight, s.wallThickness], alongX ? [mid, 0, coordinate] : [coordinate, 0, mid], 'wall', { openings: doors }, alongX ? 0 : Math.PI / 2));
      }
    }
  }
  return out;
}

function roof(s, plan, elevation, core = null) {
  if (s.roof === 'none') return [];
  const pieces = slabs(s, plan, core, 'Roof slab', s.slabThickness, 0, 'roof');
  if (s.roof === 'gable' && s.footprint === 'rectangle') {
    const w = s.width + s.roofOverhang * 2, halfDepth = s.depth / 2 + s.roofOverhang;
    pieces.push(piece('Roof south pitch', 'ramp', [w, s.roofHeight, halfDepth], [0, 0, -halfDepth / 2], 'roof'));
    pieces.push(piece('Roof north pitch', 'ramp', [w, s.roofHeight, halfDepth], [0, 0, halfDepth / 2], 'roof', {}, Math.PI));
  } else {
    for (const boundary of [plan.points, ...plan.holes]) for (let i = 0; i < boundary.length; i++) {
      const a = boundary[i], b = boundary[(i + 1) % boundary.length];
      pieces.push(piece(`Roof parapet ${pieces.length}`, 'wall', [Math.hypot(b[0] - a[0], b[1] - a[1]), 0.65, s.wallThickness], [(a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2], 'roof', {}, -Math.atan2(b[1] - a[1], b[0] - a[0])));
    }
  }
  return [{ name: 'Roof', elevation, pieces }];
}

function building(s, name, position, warnings) {
  const plan = outline(s), floors = [];
  const flatRoof = s.roof === 'flat' || (s.roof === 'gable' && s.footprint !== 'rectangle');
  const core = s.stairs && (s.storeys > 1 || flatRoof) ? stairCore(s, plan) : null;
  let storeys = s.storeys;
  if (s.stairs && storeys > 1 && !core) {
    warnings.push(`${name}: no stair core fits this footprint; generated one accessible level. Enlarge the footprint or disable automatic stairs for an open assembly.`);
    storeys = 1;
  }
  if (core?.compressed) warnings.push(`${name}: stair treads were shortened to fit the footprint.`);
  if (s.roof === 'gable' && s.footprint !== 'rectangle') warnings.push(`${name}: polygon footprints use a flat roof.`);
  for (let i = 0; i < storeys; i++) {
    const pieces = slabs(s, plan, i > 0 ? core : null, 'Floor slab', s.slabThickness, 0);
    if (i === 0 && s.foundationDepth > s.slabThickness) pieces.push(...slabs(s, plan, null, 'Foundation', s.foundationDepth - s.slabThickness, -s.slabThickness, 'foundation'));
    pieces.push(...wallEdges(s, plan.points, i, 'Exterior wall'));
    for (const hole of plan.holes) pieces.push(...wallEdges(s, hole, i, 'Courtyard wall', true));
    pieces.push(...partitions(s, plan, core));
    if ((i < storeys - 1 || flatRoof) && core) pieces.push(...stairs(s, core));
    floors.push({ name: `Level ${i + 1}`, elevation: i * s.storeyHeight, pieces });
  }
  floors.push(...roof(s, plan, storeys * s.storeyHeight, flatRoof ? core : null));
  return { name, position, rotationY: 0, footprint: plan.points, footprintHoles: plan.holes, floors };
}

function pavilion(s, name) {
  const plan = outline(s), pieces = slabs(s, plan, null, 'Pavilion deck', s.slabThickness, 0);
  if (s.foundationDepth > s.slabThickness) pieces.push(...slabs(s, plan, null, 'Pavilion foundation', s.foundationDepth - s.slabThickness, -s.slabThickness, 'foundation'));
  const post = Math.max(0.25, s.wallThickness * 1.5);
  for (let i = 0; i < plan.points.length; i++) {
    const a = plan.points[i], b = plan.points[(i + 1) % plan.points.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const count = Math.min(32, Math.max(1, Math.ceil(length / 6)));
    for (let j = 0; j < count; j++) pieces.push(piece(`Canopy column ${pieces.length}`, 'column', [post, s.storeyHeight, post], [a[0] + (b[0] - a[0]) * j / count, 0, a[1] + (b[1] - a[1]) * j / count], 'structure', { sides: s.footprint === 'circle' ? 12 : 4 }));
  }
  return { name, position: [0, 0, 0], rotationY: 0, footprint: plan.points, footprintHoles: plan.holes, floors: [{ name: 'Canopy structure', elevation: 0, pieces }, ...roof(s, plan, s.storeyHeight)] };
}

function bridge(s, name) {
  const height = s.storeyHeight, rail = Math.max(0.15, s.wallThickness), deck = Math.max(s.slabThickness, 0.25);
  const halfLength = s.depth / 2, rampLength = Math.max(6, height * 4), pieces = [];
  pieces.push(piece('Bridge deck', 'platform', [s.width, deck, s.depth], [0, height, 0], 'floor'));
  for (const side of [-1, 1]) pieces.push(piece(side < 0 ? 'West parapet' : 'East parapet', 'wall', [s.depth, 1.1, rail], [side * (s.width - rail) / 2, height, 0], 'structure', {}, Math.PI / 2));
  const spans = Math.min(32, Math.max(1, Math.ceil(s.depth / 12)));
  for (let i = 0; i <= spans; i++) {
    const z = -halfLength + i * s.depth / spans;
    pieces.push(piece(`Bridge pier ${i + 1}`, 'box', [Math.max(0.8, s.width * 0.55), Math.max(0.1, height - deck), 0.8], [0, 0, z], 'foundation'));
  }
  pieces.push(piece('South approach', 'ramp', [s.width, height, rampLength], [0, 0, -halfLength - rampLength / 2], 'structure'));
  pieces.push(piece('North approach', 'ramp', [s.width, height, rampLength], [0, 0, halfLength + rampLength / 2], 'structure', {}, Math.PI));
  return { name, position: [0, 0, 0], rotationY: 0, footprint: rect(-s.width / 2, -halfLength - rampLength, s.width / 2, halfLength + rampLength), footprintHoles: [], floors: [{ name: 'Bridge assembly', elevation: 0, pieces }] };
}

function fortress(s, name, warnings) {
  const base = building({ ...s, footprint: 'courtyard', roof: 'flat' }, name, [0, 0, 0], warnings);
  const top = base.floors.at(-1);
  const turret = Math.max(2, Math.min(s.width, s.depth) * 0.12), h = Math.min(2.5, s.storeyHeight * 0.55);
  for (const x of [-s.width / 2, s.width / 2]) for (const z of [-s.depth / 2, s.depth / 2]) {
    // Turrets are open, walkable parapet rings above the corner galleries.
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      top.pieces.push(piece(`Turret parapet ${top.pieces.length}`, 'wall', [turret, h, s.wallThickness], [x + Math.cos(a) * turret / 2, 0, z + Math.sin(a) * turret / 2], 'structure', {}, Math.PI / 2 - a));
    }
    top.pieces.push(piece(`Turret platform ${top.pieces.length}`, 'platform', [turret + s.wallThickness, s.slabThickness, turret + s.wallThickness], [x, 0, z], 'roof'));
  }
  return base;
}

function random(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = Math.imul(state ^ state >>> 15, 1 | state); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const countPieces = b => b.floors.reduce((sum, f) => sum + f.pieces.length, 0);

function city(s, warnings) {
  const rng = random(s.seed), cellW = s.width + s.setback * 2 + s.streetWidth, cellD = s.depth + s.setback * 2 + s.streetWidth;
  const halfW = s.columns * cellW / 2, halfD = s.rows * cellD / 2, roads = [];
  // Crossing roads are segmented at the junctions, preventing coplanar duplicate
  // road faces (and z fighting) at every intersection.
  for (let row = 0; row <= s.rows; row++) roads.push(piece(`Street east-west ${row + 1}`, 'floor', [s.columns * cellW + s.streetWidth, 0.2, s.streetWidth], [0, 0, -halfD + row * cellD], 'road'));
  for (let col = 0; col <= s.columns; col++) for (let row = 0; row < s.rows; row++) roads.push(piece(`Street north-south ${col + 1}/${row + 1}`, 'floor', [s.streetWidth, 0.2, cellD - s.streetWidth], [-halfW + col * cellW, 0, -halfD + (row + 0.5) * cellD], 'road'));
  const streets = { name: 'Streets', position: [0, 0, 0], rotationY: 0, footprint: rect(-halfW - s.streetWidth / 2, -halfD - s.streetWidth / 2, halfW + s.streetWidth / 2, halfD + s.streetWidth / 2), footprintHoles: [], floors: [{ name: 'Street network', elevation: 0, pieces: roads }] };
  if (roads.length > s.maxPieces - 10) { warnings.push('The street network exceeds the piece budget; reduce the city rows or columns, or increase the budget.'); return []; }
  const buildings = [streets]; let used = roads.length;
  for (let row = 0; row < s.rows; row++) for (let col = 0; col < s.columns; col++) {
    const width = Math.max(6, s.width * (1 - rng() * s.variation * 0.35));
    const depth = Math.max(6, s.depth * (1 - rng() * s.variation * 0.35));
    const storeys = Math.max(1, Math.round(s.storeys * (1 - rng() * s.variation * 0.7)));
    const roofType = rng() < s.variation * 0.5 && storeys <= 3 ? 'gable' : s.roof;
    const x = -halfW + (col + 0.5) * cellW, z = -halfD + (row + 0.5) * cellD;
    const local = { ...s, kind: 'building', footprint: 'rectangle', width, depth, storeys, roof: roofType, roofOverhang: Math.min(s.roofOverhang, s.setback - 0.2) };
    const candidate = building(local, `Building ${row + 1}-${col + 1}`, [x, 0.15, z], warnings);
    const pavement = splitRectangle({ minX: -(s.width / 2 + s.setback), maxX: s.width / 2 + s.setback, minZ: -(s.depth / 2 + s.setback), maxZ: s.depth / 2 + s.setback }, { minX: -width / 2, maxX: width / 2, minZ: -depth / 2, maxZ: depth / 2 });
    candidate.floors[0].pieces.unshift(...pavement.map((r, i) => piece(`Pavement ${i + 1}`, 'platform', [r.maxX - r.minX, 0.15, r.maxZ - r.minZ], [(r.minX + r.maxX) / 2, 0, (r.minZ + r.maxZ) / 2], 'road')));
    const count = countPieces(candidate);
    if (used + count > s.maxPieces) { warnings.push(`Piece budget reached after ${buildings.length - 1} of ${s.rows * s.columns} buildings. Increase the budget or reduce the city size.`); return buildings; }
    buildings.push(candidate); used += count;
  }
  return buildings;
}

export function generateArchitecture(input = {}) {
  const settings = normalizeArchitectureSettings(input), warnings = [], s = settings;
  const preset = ARCHITECTURE_PRESETS.find(p => p.id === s.preset);
  const name = s.name || preset?.label || 'Architecture';
  let buildings;
  if (s.kind === 'assembly') {
    const extent = s.pieces.flatMap(p => {
      const [rx, ry, rz] = p.rotation ?? [0, p.rotationY, 0];
      const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx), cz = Math.cos(rz), sz = Math.sin(rz);
      const low = p.shape === 'floor' || p.shape === 'platform' ? -p.size[1] : 0;
      const high = low + p.size[1];
      const diameter = p.shape === 'column' ? Math.max(p.size[0], p.size[2]) : null;
      return (p.props.footprint ?? rect(-(diameter ?? p.size[0]) / 2, -(diameter ?? p.size[2]) / 2, (diameter ?? p.size[0]) / 2, (diameter ?? p.size[2]) / 2))
        .flatMap(([x, z]) => [low, high].map(y => {
          // Match Three's default XYZ Euler order: Rz, then Ry, then Rx.
          const x1 = cz * x - sz * y, y1 = sz * x + cz * y;
          const x2 = cy * x1 + sy * z, z2 = -sy * x1 + cy * z;
          return [p.position[0] + x2, p.position[2] + sx * y1 + cx * z2];
        }));
    });
    const b = extent.length ? bounds(extent) : { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
    buildings = [{ name, position: [0, 0, 0], rotationY: 0, footprint: rect(b.minX, b.minZ, b.maxX, b.maxZ), footprintHoles: [], floors: [{ name: 'Assembly', elevation: 0, pieces: s.pieces }] }];
    if (Array.isArray(input.pieces) && input.pieces.length > s.maxPieces) warnings.push(`Assembly limited to ${s.maxPieces} pieces.`);
  } else if (s.kind === 'city') buildings = city(s, warnings);
  else {
    const build = local => local.kind === 'bridge' ? bridge(local, name) : local.kind === 'pavilion' ? pavilion(local, name) : local.kind === 'fortress' ? fortress(local, name, warnings) : building(local, name, [0, 0, 0], warnings);
    let candidate = build(s), storeys = s.storeys;
    while (countPieces(candidate) > s.maxPieces && storeys > 1 && ['building', 'fortress'].includes(s.kind)) candidate = build({ ...s, storeys: --storeys });
    if (storeys < s.storeys) warnings.push(`Piece budget reduced this building to ${storeys} levels. Increase the budget to generate all ${s.storeys}.`);
    if (countPieces(candidate) > s.maxPieces) { warnings.push('This structure exceeds the piece budget. Increase the budget or simplify its footprint.'); buildings = []; }
    else buildings = [candidate];
  }
  return { kind: s.kind, settings, buildings, warnings: [...new Set(warnings)] };
}
