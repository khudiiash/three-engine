import * as THREE from "three/webgpu";

// Space competition and pipe radii follow the primary 2007 formulation:
// https://algorithmicbotany.org/papers/colonization.egwnp2007.pdf
// Species scaffolds, bounded hash searches and bud vigor are this engine's
// approximations. This does NOT implement 2024 Invigoration's volumetric strands.
const cache = new Map();
export const TREE_GROWTH_LIMITS = Object.freeze({ nodes: 640, attractionPoints: 1600, iterations: 30, cachedSkeletons: 24 });
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = Math.imul(state ^ state >>> 15, state | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}

function scaffold(species, height, width, random) {
  const nodes = [];
  const add = (parent, p, order, scaffold = false) => {
    const node = { id: nodes.length, parent, position: p, order, scaffold, children: [], radius: 0, tips: 0 };
    nodes.push(node); if (parent >= 0) nodes[parent].children.push(node.id); return node.id;
  };
  const root = add(-1, V(), 0, true);
  const curve = (parent, end, control1, control2, count, order) => {
    const start = nodes[parent].position;
    const path = new THREE.CubicBezierCurve3(start, control1, control2, end);
    const ids = [parent];
    for (let i = 1; i <= count; i++) { parent = add(parent, path.getPoint(i / count), order, true); ids.push(parent); }
    return ids;
  };
  if (species === "oak") {
    const lean = V((random() - 0.5) * width * 0.09, height * 0.36, (random() - 0.5) * width * 0.09);
    const trunk = curve(root, lean, V(0, height * 0.13, 0), lean.clone().multiplyScalar(0.68), 9, 0);
    const spin = random() * TAU;
    for (let i = 0; i < 4; i++) {
      const angle = spin + i * 2.399963 + (random() - 0.5) * 0.35;
      const parent = trunk[6 + i % 3];
      const start = nodes[parent].position;
      const end = V(Math.cos(angle) * width * (0.34 + random() * 0.10), height * (0.65 + random() * 0.22), Math.sin(angle) * width * (0.34 + random() * 0.10));
      const leader = curve(parent, end, start.clone().add(V(Math.cos(angle) * width * 0.18, height * 0.13, Math.sin(angle) * width * 0.18)), end.clone().add(V(-Math.cos(angle) * width * 0.10, -height * 0.06, -Math.sin(angle) * width * 0.10)), 8, 1);
      for (let j = 0; j < 3; j++) {
        const fork = leader[3 + j], base = nodes[fork].position, yaw = angle + (j - 1) * 0.82;
        const target = V(Math.cos(yaw) * width * (0.43 + random() * 0.10), height * (0.58 + random() * 0.28), Math.sin(yaw) * width * (0.43 + random() * 0.10));
        curve(fork, target, base.clone().lerp(target, 0.30).add(V(0, height * 0.07, 0)), base.clone().lerp(target, 0.73).add(V(0, height * 0.035, 0)), 5, 2);
      }
    }
  } else {
    const birch = species === "birch";
    const trunk = [root];
    const leanX = (random() - 0.5) * width * (birch ? 0.11 : 0.025), leanZ = (random() - 0.5) * width * 0.06;
    const trunkSegments = birch ? 22 : 30;
    for (let i = 1; i <= trunkSegments; i++) {
      const t = (i + (!birch && i < trunkSegments ? (random() - .5) * .8 : 0)) / trunkSegments;
      trunk.push(add(trunk.at(-1), V(leanX * t + Math.sin(t * 7) * width * 0.008 * t, height * t, leanZ * t + Math.sin(t * 9) * width * 0.006 * t), 0, true));
    }
    const branches = birch ? 13 : 14;
    const spin = random() * TAU;
    for (let tier = 0; tier < branches; tier++) {
      const index = Math.round((birch ? 7 : 5) + tier / (branches - 1) * (birch ? 13 : 24) + (birch ? 0 : (random() - .5) * .9));
      const parent = trunk[index], start = nodes[parent].position, f = start.y / height;
      const count = birch ? 1 : 4 + tier % 2;
      for (let i = 0; i < count; i++) {
        const angle = spin + tier * 2.399963 + i / count * TAU + (random() - 0.5) * 0.3;
        const reach = width * (birch ? 0.44 * Math.sin((f - 0.22) / 0.85 * Math.PI) : 0.50 * Math.pow(1 - f, 0.65)) * (0.8 + random() * 0.3);
        const end = start.clone().add(V(Math.cos(angle) * reach, height * (birch ? -0.015 : .008 + random() * .06) * (1 - f), Math.sin(angle) * reach));
        const control1 = start.clone().add(V(Math.cos(angle) * reach * 0.20, height * (birch ? 0.095 : .026 * Math.pow(1 - f, .55)), Math.sin(angle) * reach * 0.20));
        const control2 = end.clone().add(V(-Math.cos(angle) * reach * 0.15, height * (birch ? 0.07 : -.009 * Math.pow(1 - f, .55)), -Math.sin(angle) * reach * 0.15));
        curve(parent, end, control1, control2, 6, 1);
      }
    }
  }
  return { nodes, add };
}

function attractors(species, height, width, random, nodes) {
  const points = [];
  const count = TREE_GROWTH_LIMITS.attractionPoints;
  if (species === "pine") {
    const boughs = nodes.filter(node => node.order === 1 && node.position.distanceTo(nodes[node.parent].position) > 0.001);
    for (let i = 0; i < count; i++) {
      const node = boughs[Math.floor(random() * boughs.length)], t = node.position.y / height;
      const r = width * (0.06 + 0.07 * (1 - t));
      points.push(node.position.clone().add(V((random() - 0.5) * r * 2, (random() - 0.30) * height * 0.07, (random() - 0.5) * r * 2)));
    }
    return points;
  }
  while (points.length < count) {
    const y = species === "oak" ? 0.43 + random() * 0.57 : 0.37 + random() * 0.63;
    const vertical = species === "oak" ? (y - 0.70) / 0.32 : (y - 0.66) / 0.36;
    const profile = Math.sqrt(Math.max(0.02, 1 - vertical * vertical));
    const angle = random() * TAU;
    const lobes = 0.87 + 0.10 * Math.sin(angle * 3 + 1.3) + 0.06 * Math.cos(angle * 5 + y * 4);
    const radius = width * 0.53 * profile * Math.sqrt(random()) * lobes;
    points.push(V(Math.cos(angle) * radius + width * 0.035 * (y - 0.4), height * y, Math.sin(angle) * radius));
  }
  return points;
}

/** Cached, deterministic, bounded species scaffold + space-colonized twigs. */
export function growTreeSkeleton({ species = "oak", height = 8, width = 6, seed = 1 } = {}) {
  const key = `${species}:${height}:${width}:${seed >>> 0}`;
  const cached = cache.get(key); if (cached) return cached;
  const random = seeded(seed), { nodes, add } = scaffold(species, height, width, random);
  const points = attractors(species, height, width, random, nodes);
  const active = new Uint8Array(points.length); active.fill(1);
  const influence = Math.max(width * 0.24, height * 0.12), cellSize = influence;
  const step = Math.max(0.065, Math.min(0.27, Math.max(height, width) * (species === "pine" ? 0.021 : 0.027)));
  const killSq = (step * (species === "pine" ? 1.3 : 1.65)) ** 2, influenceSq = influence ** 2;
  let iterations = 0, distanceTests = 0, consumedAttractors = 0;
  for (; iterations < TREE_GROWTH_LIMITS.iterations && nodes.length < TREE_GROWTH_LIMITS.nodes; iterations++) {
    const cells = new Map();
    for (const node of nodes) {
      const p = node.position, cell = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)},${Math.floor(p.z / cellSize)}`;
      let bucket = cells.get(cell); if (!bucket) cells.set(cell, bucket = []); bucket.push(node.id);
    }
    const directions = new Float64Array(nodes.length * 3), counts = new Uint16Array(nodes.length);
    for (let i = 0; i < points.length; i++) {
      if (!active[i]) continue;
      const p = points[i], gx = Math.floor(p.x / cellSize), gy = Math.floor(p.y / cellSize), gz = Math.floor(p.z / cellSize);
      let nearest = -1, nearestSq = influenceSq;
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        for (const id of cells.get(`${gx + x},${gy + y},${gz + z}`) ?? []) {
          distanceTests++; const d = p.distanceToSquared(nodes[id].position);
          if (d < nearestSq) { nearest = id; nearestSq = d; }
        }
      }
      if (nearest < 0) continue;
      if (nearestSq < killSq) { active[i] = 0; consumedAttractors++; continue; }
      const n = nodes[nearest], inv = 1 / Math.sqrt(nearestSq), offset = nearest * 3;
      directions[offset] += (p.x - n.position.x) * inv; directions[offset + 1] += (p.y - n.position.y) * inv; directions[offset + 2] += (p.z - n.position.z) * inv; counts[nearest]++;
    }
    const oldCount = nodes.length;
    for (let i = 0; i < oldCount && nodes.length < TREE_GROWTH_LIMITS.nodes; i++) {
      if (!counts[i]) continue;
      const node = nodes[i], direction = V(directions[i * 3], directions[i * 3 + 1], directions[i * 3 + 2]).normalize();
      const previous = node.parent >= 0 ? node.position.clone().sub(nodes[node.parent].position).normalize() : V(0, 1, 0);
      // Continuation favors inherited direction; lateral buds compete for the
      // remaining space. Birch's fine branches droop, oak grows outward/upward.
      direction.addScaledVector(previous, species === "pine" ? 0.70 : 0.48);
      direction.y += species === "birch" && node.order > 0 ? -0.20 : species === "oak" ? 0.14 : 0.09;
      direction.normalize();
      if (node.children.some(id => nodes[id].position.clone().sub(node.position).normalize().dot(direction) > 0.94)) continue;
      const p = node.position.clone().addScaledVector(direction, step * (0.76 + 0.24 * Math.min(1, counts[i] / 9)));
      if (p.y < height * 0.30 || p.y > height * 1.02) continue;
      add(i, p, node.order + (node.children.length ? 1 : 0));
    }
    if (nodes.length === oldCount) break;
  }
  const exponent = 2.4;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    node.tips = node.children.length ? node.children.reduce((sum, id) => sum + nodes[id].tips, 0) : 1;
    node.pipe = node.children.length ? node.children.reduce((sum, id) => sum + nodes[id].pipe, 0) + 0.015 : 1;
  }
  const rootRadius = height * (species === "oak" ? 0.024 : species === "birch" ? 0.0115 : 0.018);
  for (const node of nodes) {
    const share = node.pipe / nodes[0].pipe;
    // Each terminal represents a spray of many omitted fine twigs. The pipe
    // backbone supplies relative vigor; a monotone secondary taper bridges
    // its coarse structural pipes to millimetre-scale leaf-bearing shoots.
    node.radius = rootRadius * Math.pow(share, 1 / exponent) * (0.20 + 0.80 * Math.pow(share, 0.60));
    node.renderPosition = node.position.clone();
    if (!node.scaffold && node.children.length === 1 && node.parent >= 0) {
      node.renderPosition.lerp(nodes[node.parent].position.clone().add(nodes[node.children[0]].position).multiplyScalar(0.5), 0.38);
    }
  }
  const branches = [];
  function chain(start, child, order) {
    const ids = [start]; let current = child;
    while (current != null) {
      ids.push(current);
      const node = nodes[current];
      const children = [...node.children].sort((a, b) => {
        // A strong colonized side twig must not steal the smooth conifer
        // leader/bough continuation and produce a zig-zag principal pipe.
        if (species === "pine") {
          const priority = id => Number(nodes[id].scaffold && nodes[id].order === node.order);
          const continuation = priority(b) - priority(a);
          if (continuation) return continuation;
        }
        return nodes[b].pipe - nodes[a].pipe || a - b;
      });
      for (let i = 1; i < children.length; i++) chain(current, children[i], order + 1);
      current = children[0];
    }
    branches.push({ ids, order, radius: nodes[child].radius });
  }
  chain(0, nodes[0].children[0], 0);
  // Recursion emits children first; largest paths first keep coarse LOD stable.
  branches.sort((a, b) => b.radius - a.radius || a.ids[1] - b.ids[1]);
  const tips = nodes.filter(node => !node.children.length && node.position.y > height * 0.35).map(node => node.id);
  const result = { species, height, width, seed: seed >>> 0, nodes, branches, tips, stats: { nodes: nodes.length, branches: branches.length, tips: tips.length, iterations, attractionPoints: points.length, consumedAttractors, distanceTests }, algorithm: "species scaffold + bounded space colonization; pipe exponent 2.4" };
  cache.set(key, result); if (cache.size > TREE_GROWTH_LIMITS.cachedSkeletons) cache.delete(cache.keys().next().value);
  return result;
}

export function clearTreeGrowthCache() { cache.clear(); }

/** Shallow trunk/limb/leaf animation hierarchy, shared by every geometric LOD.
 * Inspired by GPU Gems 3 chapter 6's joint/axis/stiffness model:
 * https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees
 * This is a bounded visual approximation, not a per-frame physical solver. */
export function getTreeMotion(skeleton) {
  if (skeleton.motion) return skeleton.motion;
  const { nodes, height, species } = skeleton;
  const primary = new Int32Array(nodes.length); primary.fill(-1);
  const distance = new Float64Array(nodes.length), limbs = new Map();
  for (const node of nodes.slice(1)) {
    const parent = nodes[node.parent];
    primary[node.id] = primary[parent.id] >= 0 ? primary[parent.id] : node.order > 0 ? node.id : -1;
    const id = primary[node.id];
    if (id < 0) continue;
    let limb = limbs.get(id);
    if (!limb) {
      limb = { id, pivot: parent.renderPosition.clone(), axis: V(0, 1, 0), length: 0, reach: 0, radius: node.radius };
      limbs.set(id, limb);
    }
    distance[node.id] = (primary[parent.id] === id ? distance[parent.id] : 0) + node.renderPosition.distanceTo(parent.renderPosition);
    limb.length = Math.max(limb.length, distance[node.id]);
    const offset = node.renderPosition.clone().sub(limb.pivot), reach = offset.lengthSq();
    if (reach > limb.reach) { limb.reach = reach; limb.axis.copy(offset).normalize(); }
  }
  for (const limb of limbs.values()) {
    const speciesResponse = species === "birch" ? 1 : species === "pine" ? .8 : .62;
    limb.flexibility = THREE.MathUtils.clamp(height * .008 / (limb.radius + height * .003) * Math.pow(limb.length / (height * .2), .6), .18, 1) * speciesResponse;
  }
  const trunk = { id: -1, pivot: V(), axis: V(0, 1, 0), flexibility: 0 };
  const motion = nodes.map(node => {
    const limb = limbs.get(primary[node.id]) ?? trunk;
    const t = limb.id < 0 ? 0 : Math.min(1, distance[node.id] / limb.length);
    return { limb: limb.id, pivot: limb.pivot, axis: limb.axis, flex: t * t * (3 - 2 * t) * limb.flexibility };
  });
  return skeleton.motion = { nodes: motion, limbs: [...limbs.values()] };
}
