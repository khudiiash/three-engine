import * as THREE from "three/webgpu";
import { getTreeMotion, growTreeSkeleton } from "./treeGrowth.js";

export const FOLIAGE_SPECIES = Object.freeze({
  oak: { label: "Oak", height: 8, width: 6, leafColor: "#52732b", barkColor: "#65513a", flowerColor: "#efd275" },
  pine: { label: "Pine", height: 10, width: 4, leafColor: "#315c39", barkColor: "#6b4936", flowerColor: "#efd275" },
  birch: { label: "Birch", height: 9, width: 4, leafColor: "#73943c", barkColor: "#d9d5ba", flowerColor: "#efd275" },
  grass: { label: "Meadow grass", height: 0.65, width: 0.65, leafColor: "#64863a", barkColor: "#526331", flowerColor: "#efd275" },
  wildflowers: { label: "Wildflowers", height: 0.8, width: 0.6, leafColor: "#507539", barkColor: "#567239", flowerColor: "#eac5e6" },
});

/** Identical seeds produce identical geometry and placements without global RNG state. */
export function foliageRandom(seed = 1) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const finite = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const clamp = THREE.MathUtils.clamp;
const point = (x, y, z) => new THREE.Vector3(x, y, z);

/** One merged, vertex-colored mesh per prototype/LOD; no textures or material groups. */
class Builder {
  positions = []; colors = []; uv = []; wind = []; indices = [];
  constructor(height, grassMetadata = false) {
    this.height = height;
    if (grassMetadata) { this.bladeData = []; this.curveData = []; }
  }
  vertex(p, color, u = 0, v = 0, stiffness = 1) {
    const index = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    this.colors.push(color.r, color.g, color.b);
    this.uv.push(u, v);
    this.wind.push(clamp(p.y / this.height, 0, 1) * stiffness);
    if (this.bladeData) {
      this.bladeData.push(this.windRoot?.x ?? 0, this.windRoot?.z ?? 0, this.bladeLength ?? 1, this.attachmentT ?? p.foliageT ?? clamp((p.y - (this.windRoot?.y ?? 0)) / (this.bladeHeight ?? 1), 0, 1));
      const dx = this.bladeDirection?.x ?? 1, dz = this.bladeDirection?.z ?? 0;
      const offset = this.curveAngle === -1 ? 0 : -(p.x - (this.windRoot?.x ?? 0)) * dz + (p.z - (this.windRoot?.z ?? 0)) * dx;
      this.curveData.push(dx, dz, this.curveAngle ?? -1, offset);
    }
    return index;
  }
  tri(a, b, c, color, stiffness = 1) {
    this.indices.push(this.vertex(a, color, 0, 0, stiffness), this.vertex(b, color, 1, 0, stiffness), this.vertex(c, color, 0.5, 1, stiffness));
  }
  tube(start, end, radius0, radius1, color, sides, stiffness = 0.15, segments = 1) {
    const axis = end.clone().sub(start).normalize();
    const tangent = point(Math.abs(axis.y) > 0.9 ? 1 : 0, Math.abs(axis.y) > 0.9 ? 0 : 1, 0).cross(axis).normalize();
    const bitangent = axis.clone().cross(tangent);
    const rings = [];
    for (let ring = 0; ring <= segments; ring++) {
      const t = ring / segments, center = start.clone().lerp(end, t);
      const radius = radius0 + (radius1 - radius0) * t;
      const ids = [];
      for (let i = 0; i <= sides; i++) {
        const angle = i / sides * Math.PI * 2;
        const p = center.clone().addScaledVector(tangent, Math.cos(angle) * radius).addScaledVector(bitangent, Math.sin(angle) * radius);
        p.foliageT = t;
        ids.push(this.vertex(p, color, i / sides, t, stiffness));
      }
      rings.push(ids);
    }
    for (let j = 0; j < segments; j++) for (let i = 0; i < sides; i++) this.indices.push(rings[j][i], rings[j][i + 1], rings[j + 1][i], rings[j][i + 1], rings[j + 1][i + 1], rings[j + 1][i]);
  }
  leaf(center, length, width, yaw, lift, color, detail = 1) {
    const axis = point(Math.sin(yaw) * Math.cos(lift), Math.sin(lift), Math.cos(yaw) * Math.cos(lift));
    const side = point(Math.cos(yaw), 0, -Math.sin(yaw));
    const a = center.clone().addScaledVector(axis, -length * 0.5);
    const tip = center.clone().addScaledVector(axis, length * 0.5);
    const left = center.clone().addScaledVector(side, width * 0.5);
    const right = center.clone().addScaledVector(side, -width * 0.5);
    if (detail) {
      const ridge = center.clone().add(point(0, width * 0.1, 0));
      this.tri(a, left, ridge, color); this.tri(left, tip, ridge, color);
      this.tri(tip, right, ridge, color); this.tri(right, a, ridge, color);
    } else { this.tri(a, left, tip, color); this.tri(a, tip, right, color); }
  }
  // A small rounded seedhead for flowers; tree canopies never use solid fillers.
  crown(center, radius, color, detail, flatten = 0.8) {
    const longitude = detail ? 7 : 5;
    const latitude = detail ? 4 : 2;
    const rings = [];
    for (let y = 0; y <= latitude; y++) {
      const phi = y / latitude * Math.PI;
      const row = [];
      for (let x = 0; x <= longitude; x++) {
        const theta = x / longitude * Math.PI * 2;
        const p = point(Math.sin(phi) * Math.cos(theta) * radius, Math.cos(phi) * radius * flatten, Math.sin(phi) * Math.sin(theta) * radius).add(center);
        const tint = color.clone().multiplyScalar(0.83 + 0.17 * (1 - y / latitude));
        row.push(this.vertex(p, tint, x / longitude, y / latitude));
      }
      rings.push(row);
    }
    for (let y = 0; y < latitude; y++) for (let x = 0; x < longitude; x++) {
      if (y > 0) this.indices.push(rings[y][x], rings[y][x + 1], rings[y + 1][x]);
      if (y < latitude - 1) this.indices.push(rings[y][x + 1], rings[y + 1][x + 1], rings[y + 1][x]);
    }
  }
  finish() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    geometry.setAttribute("foliageWind", new THREE.Float32BufferAttribute(this.wind, 1));
    if (this.bladeData) {
      const values = new Float32Array(this.bladeData.length * 2);
      for (let i = 0; i < this.bladeData.length / 4; i++) {
        values.set(this.bladeData.slice(i * 4, i * 4 + 4), i * 8);
        values.set(this.curveData.slice(i * 4, i * 4 + 4), i * 8 + 4);
      }
      const data = new THREE.InterleavedBuffer(values, 8);
      geometry.setAttribute("foliageBlade", new THREE.InterleavedBufferAttribute(data, 4, 0));
      geometry.setAttribute("foliageCurve", new THREE.InterleavedBufferAttribute(data, 4, 4));
    }
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

class TreeBuilder extends Builder {
  part = 0; motionData = [];
  vertex(p, color, u = 0, v = 0, stiffness = 1) {
    const id = super.vertex(p, color, u, v, stiffness);
    const branch = this.branchMotion, root = this.leafRoot ?? p, axis = this.leafAxis ?? point(0, 1, 0);
    this.motionData.push(
      branch.pivot.x, branch.pivot.y, branch.pivot.z, branch.flex,
      branch.axis.x, branch.axis.y, branch.axis.z, this.wind[id],
      root.x, root.y, root.z, this.leafPhase ?? 0,
      axis.x, axis.y, axis.z, this.part,
    );
    return id;
  }
  finish() {
    const geometry = super.finish();
    // Four existing geometry streams + this one shared stream + both Three's
    // and the wind shader's instance matrices: 7 buffers / 16 attributes.
    // Do not retain separate wind/part attributes: large instanced draws would
    // exceed portable WebGPU's sixteen-attribute limit when both are read.
    geometry.deleteAttribute("foliageWind");
    const data = new THREE.InterleavedBuffer(new Float32Array(this.motionData), 16);
    for (const [name, offset] of [["treeBranch", 0], ["treeBranchAxis", 4], ["treeLeaf", 8], ["treeLeafAxis", 12]]) {
      geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(data, 4, offset));
    }
    return geometry;
  }
}

function branchTube(builder, skeleton, branch, lod, bark) {
  const nodes = skeleton.nodes, source = branch.ids;
  const ids = lod === 0 || source.length <= 3 ? source : source.filter((_, i) => i === 0 || i === source.length - 1 || i % [1, 3, 5][lod] === 0);
  const sides = lod === 0 ? (branch.radius > skeleton.height * 0.012 ? 7 : branch.radius > skeleton.height * 0.004 ? 5 : 3) : (branch.order === 0 ? 6 : 3);
  const rings = [];
  let previousSide = null, arc = 0;
  for (let j = 0; j < ids.length; j++) {
    const node = nodes[ids[j]], center = node.renderPosition;
    builder.branchMotion = skeleton.motion.nodes[node.id];
    const before = nodes[ids[Math.max(0, j - 1)]].renderPosition, after = nodes[ids[Math.min(ids.length - 1, j + 1)]].renderPosition;
    const tangent = after.clone().sub(before).normalize();
    let side = previousSide ? previousSide.clone().addScaledVector(tangent, -previousSide.dot(tangent)).normalize() : point(Math.abs(tangent.y) > 0.9 ? 1 : 0, Math.abs(tangent.y) > 0.9 ? 0 : 1, 0).cross(tangent).normalize();
    if (side.lengthSq() < 0.5) side = point(0, 0, 1).cross(tangent).normalize();
    const cross = tangent.clone().cross(side); previousSide = side;
    if (j) arc += center.distanceTo(before);
    let radius = node.radius;
    if (branch.order && j === 0) radius = Math.min(radius, nodes[ids[1]].radius * 1.25);
    // The terminal pipe represents multiple unmodelled shoots. Its last ring
    // tapers into an actual thin twig rather than ending in a thick cut cylinder.
    if (j === ids.length - 1 && !node.children.length) radius = Math.min(radius, skeleton.species === "birch" ? 0.002 : 0.0035);
    const row = [];
    for (let k = 0; k <= sides; k++) {
      const theta = k / sides * Math.PI * 2;
      const p = center.clone().addScaledVector(side, Math.cos(theta) * radius).addScaledVector(cross, Math.sin(theta) * radius);
      row.push(builder.vertex(p, bark, k / sides, arc, branch.order === 0 ? 0.09 : Math.min(0.65, 0.16 + branch.order * 0.11)));
    }
    rings.push(row);
  }
  for (let j = 0; j + 1 < rings.length; j++) for (let k = 0; k < sides; k++) builder.indices.push(rings[j][k], rings[j][k + 1], rings[j + 1][k], rings[j][k + 1], rings[j + 1][k + 1], rings[j + 1][k]);
}

function leafSprayCard(builder, base, direction, side, length, width, color, lod) {
  builder.leafRoot = base; builder.leafAxis = direction;
  const normal = side.clone().cross(direction).normalize();
  const rows = lod === 0 && builder.part !== 2 ? 2 : 1, rings = [];
  for (let j = 0; j <= rows; j++) {
    const t = j / rows, p = base.clone().addScaledVector(direction, length * t).addScaledVector(normal, Math.sin(t * Math.PI) * length * 0.09);
    rings.push([builder.vertex(p.clone().addScaledVector(side, -width * 0.5), color, 0, t), builder.vertex(p.clone().addScaledVector(side, width * 0.5), color, 1, t)]);
  }
  for (let j = 0; j < rows; j++) builder.indices.push(rings[j][0], rings[j][1], rings[j + 1][0], rings[j][1], rings[j + 1][1], rings[j + 1][0]);
}

function createTreeGeometry(options, lod, leaf, bark) {
  const skeleton = growTreeSkeleton(options), builder = new TreeBuilder(options.height);
  const motion = getTreeMotion(skeleton);
  const isPine = options.species === "pine", isBirch = options.species === "birch";
  for (const branch of skeleton.branches) {
    if (lod > 0 && branch.order > 1) continue;
    branchTube(builder, skeleton, branch, lod, bark);
  }
  const barkTriangles = builder.indices.length / 3;
  builder.part = isPine ? 2 : 1;
  // Cards contain multiple physical leaf silhouettes, never one giant diamond.
  // Keep these dimensions aligned with foliageMaterial's baked leaf mask.
  const cardLength = isPine ? 0.34 : isBirch ? 0.38 : 0.50;
  const cardWidth = isPine ? 0.32 : isBirch ? 0.27 : 0.34;
  const targetCards = isPine ? 2500 : 1350;
  // Longest leaf/needle in the normalized surface-texture template; card size
  // does not equal leaf size. Variation scales the full spray by 0.82..1.14.
  const leafSize = isPine ? 0.13 : Math.hypot(cardWidth * .21, cardLength * .155);
  const pineCards = Math.min([2500, 520, 230][lod], Math.max(0, Math.floor(([11000, 2000, 1550][lod] - barkTriangles) / 2)));
  let cardCount = 0, ordinal = 0;
  // Evergreen needles occupy the sides of boughs continuously; a leaf-only
  // terminal-node rule made the pine look dead between occasional tiny tufts.
  const sites = isPine ? [...new Set([...skeleton.nodes.filter(node => node.parent > 0 && node.order > 0 && node.position.y > options.height * 0.16 && motion.nodes[node.id].flex > .08).map(node => node.id), ...skeleton.tips])] : skeleton.tips;
  for (let index = 0; index < sites.length; index++) {
    const tip = sites[index], cards = Math.floor(targetCards / sites.length) + (index < targetCards % sites.length ? 1 : 0);
    const random = foliageRandom(options.seed + tip * 7919 + 3181);
    const shoot = [tip];
    while (shoot.length < 5 && skeleton.nodes[shoot.at(-1)].parent > 0) shoot.push(skeleton.nodes[shoot.at(-1)].parent);
    for (let i = 0; i < cards; i++) {
      const back = Math.min(shoot.length - 2, Math.floor(i / 6)), node = skeleton.nodes[shoot[back]], parent = skeleton.nodes[shoot[back + 1]];
      const tangent = node.renderPosition.clone().sub(parent.renderPosition).normalize();
      const side0 = point(Math.abs(tangent.y) > 0.9 ? 1 : 0, Math.abs(tangent.y) > 0.9 ? 0 : 1, 0).cross(tangent).normalize();
      const cross = tangent.clone().cross(side0), angle = i * 2.399963 + random() * 0.3;
      const radial = side0.clone().multiplyScalar(Math.cos(angle)).addScaledVector(cross, Math.sin(angle));
      const base = parent.renderPosition.clone().lerp(node.renderPosition, 0.16 + (i % 6) / 6 * 0.84);
      const direction = tangent.clone().multiplyScalar(isPine ? 0.94 : 0.48).addScaledVector(radial, isPine ? 0.35 : 0.88).normalize();
      if (isBirch) direction.y -= 0.23;
      direction.normalize();
      const side = direction.clone().cross(radial.clone().cross(tangent)).normalize();
      const variation = 0.82 + random() * 0.32;
      const tint = leaf.clone().multiplyScalar(0.78 + random() * 0.36);
      if (isPine) {
        const previous = Math.floor(ordinal * pineCards / targetCards); ordinal++;
        if (Math.floor(ordinal * pineCards / targetCards) === previous) continue;
      } else if (i % [1, 3, 8][lod]) continue;
      const lodScale = (isPine ? [1, 1.65, 2.15] : [1, 1.35, 1.85])[lod];
      const parentMotion = motion.nodes[parent.id], nodeMotion = motion.nodes[node.id];
      const along = 0.16 + (i % 6) / 6 * 0.84;
      const parentFlex = parentMotion.limb === nodeMotion.limb ? parentMotion.flex : 0;
      builder.branchMotion = { ...nodeMotion, flex: parentFlex + (nodeMotion.flex - parentFlex) * along };
      // Independent of the shape RNG and LOD filtering: retained cards keep
      // their attachment and flutter phase during a geometric LOD change.
      builder.leafPhase = foliageRandom(options.seed + tip * 104729 + i * 15485863)() * Math.PI * 2;
      leafSprayCard(builder, base, direction, side, cardLength * variation * lodScale, cardWidth * variation * lodScale, tint, lod);
      cardCount++;
    }
  }
  const geometry = builder.finish();
  geometry.name = `Foliage ${options.species} LOD${lod}`;
  geometry.userData.foliage = { species: options.species, seed: options.seed, lod, height: options.height, width: options.width,
    tree: { ...skeleton.stats, algorithm: skeleton.algorithm, leafLengthMeters: leafSize, maximumLeafLengthMeters: leafSize * 1.14, leafCardLengthMeters: cardLength, leafCardWidthMeters: cardWidth, leavesPerCard: isPine ? 256 : 18, cardCount, barkTriangles, skeletonSeed: skeleton.seed, motionLimbs: motion.limbs.length } };
  return geometry;
}

function meadow(builder, options, lod, random, leaf, flower) {
  const { height: h, width: w, species } = options;
  const flowering = species === "wildflowers";
  const bladeCount = flowering ? 14 : 30;
  const stride = [1, 2, 5][lod];
  for (let i = 0; i < bladeCount; i++) {
    const angle = random() * Math.PI * 2, radius = Math.sqrt(random()) * w * 0.34;
    const y = h * (0.48 + random() * 0.52), bend = w * (0.12 + random() * 0.25);
    const thickness = w * (0.025 + random() * 0.025);
    const tint = leaf.clone().multiplyScalar(0.68 + random() * 0.5);
    if (i % stride) continue;
    const root = point(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    builder.windRoot = root; builder.bladeHeight = y;
    builder.bladeLength = 0.5 * Math.sqrt(y * y + 4 * bend * bend) + y * y / (4 * bend) * Math.asinh(2 * bend / y);
    const side = point(-Math.sin(angle), 0, Math.cos(angle));
    const direction = point(Math.cos(angle), 0, Math.sin(angle));
    builder.bladeDirection = direction;
    // Circular arcs preserve the existing root/tip and width while exposing
    // actual rest length. Flowers retain their accepted geometry and select
    // the root-rotation fallback via a negative angle.
    builder.curveAngle = flowering ? -2 : 2 * Math.atan2(bend, y);
    if (!flowering) builder.bladeLength = Math.hypot(y, bend) * builder.curveAngle / (2 * Math.sin(builder.curveAngle / 2));
    const segments = [4, 2, 1][lod];
    let previousLeft, previousRight;
    for (let j = 0; j <= segments; j++) {
      const t = j / segments;
      const center = root.clone().addScaledVector(direction, bend * t * t); center.y = y * t;
      if (!flowering && j > 0 && j < segments) {
        const oldCenter = center.clone(), radius = builder.bladeLength / builder.curveAngle;
        center.copy(root).addScaledVector(direction, radius * (1 - Math.cos(builder.curveAngle * t)));
        center.y = radius * Math.sin(builder.curveAngle * t);
        builder.maxRestFitDisplacement = Math.max(builder.maxRestFitDisplacement ?? 0, center.distanceTo(oldCenter));
      }
      const width = thickness * (1 - t) * (lod === 2 ? 1.7 : 1);
      const left = center.clone().addScaledVector(side, -width), right = center.clone().addScaledVector(side, width);
      if (!flowering) { left.foliageT = t; right.foliageT = t; }
      if (j > 0) { builder.tri(previousLeft, left, previousRight, tint); if (j < segments) builder.tri(previousRight, left, right, tint); }
      previousLeft = left; previousRight = right;
    }
  }
  if (!flowering) return;
  for (let i = 0; i < 7; i++) {
    const angle = i * 2.399963, radius = w * (0.12 + random() * 0.21);
    const root = point(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    const top = root.clone().add(point(Math.sin(angle) * w * 0.07, h * (0.65 + random() * 0.35), Math.cos(angle) * w * 0.07));
    builder.windRoot = root; builder.bladeHeight = top.y; builder.bladeLength = top.distanceTo(root);
    builder.bladeDirection = top.clone().sub(root).normalize(); builder.curveAngle = -1;
    builder.attachmentT = undefined;
    const tint = flower.clone().lerp(new THREE.Color("#fff5d1"), random() * 0.35);
    if (lod === 2 && i % 2) continue;
    builder.tube(root, top, w * 0.006, w * 0.003, leaf, lod === 0 ? 5 : 3, 0.8, [4, 2, 1][lod]);
    if (lod < 2) for (let k = 0; k < 3; k++) {
      builder.attachmentT = 0.25 + k * 0.2;
      builder.leaf(root.clone().lerp(top, builder.attachmentT), w * 0.22, w * 0.06, angle + k * 2.4, 0.4, leaf, lod === 0 ? 1 : 0);
    }
    builder.attachmentT = 1;
    const petals = lod === 2 ? 4 : 7;
    for (let j = 0; j < petals; j++) {
      const a = j / petals * Math.PI * 2;
      const center = top.clone().add(point(Math.sin(a) * w * 0.045, 0, Math.cos(a) * w * 0.045));
      builder.leaf(center, w * 0.10, w * 0.065, a, 0.15, tint, lod === 0 ? 1 : 0);
    }
    builder.crown(top.clone().add(point(0, w * 0.009, 0)), w * 0.022, new THREE.Color("#e7b439"), 0, 0.5);
  }
}

/** Dimensions are metres. LODs share the seed/branch layout and reduce geometry only. */
export function createFoliagePrototype(props = {}, lod = 0) {
  const species = Object.hasOwn(FOLIAGE_SPECIES, props.species) ? props.species : "oak";
  const defaults = FOLIAGE_SPECIES[species];
  const options = {
    ...props, species, seed: finite(props.seed, 1),
    height: clamp(finite(props.height, defaults.height), 0.02, 100),
    width: clamp(finite(props.width, defaults.width), 0.02, 100),
  };
  lod = clamp(Math.floor(finite(lod, 0)), 0, 2);
  const leaf = new THREE.Color(props.leafColor || defaults.leafColor);
  const bark = new THREE.Color(props.barkColor || defaults.barkColor);
  const flower = new THREE.Color(props.flowerColor || defaults.flowerColor);
  const builder = new Builder(options.height, species === "grass" || species === "wildflowers");
  const random = foliageRandom(options.seed);
  if (species === "grass" || species === "wildflowers") meadow(builder, options, lod, random, leaf, flower);
  else return createTreeGeometry(options, lod, leaf, bark);
  const geometry = builder.finish();
  geometry.name = `Foliage ${species} LOD${lod}`;
  geometry.userData.foliage = { species, seed: options.seed, lod, height: options.height, width: options.width, maxRestFitDisplacementMeters: builder.maxRestFitDisplacement ?? 0 };
  return geometry;
}
