import * as THREE from "three/webgpu";

// Fixed per-species textures, shared by every seed, LOD and atlas capture.
// R = albedo multiplier, GB = tangent normal XY, A = actual leaf coverage.
// Leaves and bark are separate textures so mip filtering never blends them.
const cached = new Map();
const SIZE = 256;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// Paired needles emerge together from irregular fascicles around a short
// shoot. These are radial tufts, not opposing rows of broadleaf-like leaflets.
// Young dense pine habit / paired needles are guided by Oregon State's
// Pinus nigra reference; the generated preset is not an exact species model.
const pineNeedles = [];
const pineClusters = [{ x: .38, y: .19, scale: .90 }, { x: .61, y: .46, scale: 1 }, { x: .47, y: .74, scale: .84 }];
for (let i = 0; i < 128; i++) {
  const jitter = n => { const value = Math.sin(n * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };
  // Three unequal, offset bud clusters leave short visible shoot sections.
  // Spreading every origin along one axis instead made their overlapping
  // bases look like a single opaque broadleaf blade in close-up views.
  const cluster = pineClusters[i % pineClusters.length];
  const y = cluster.y + (jitter(i + 37) - .5) * .055, x = cluster.x + (jitter(i + 57) - .5) * .045;
  for (let pair = 0; pair < 2; pair++) {
    const angle = i * 2.399963 + jitter(i + 1) * .45 + pair * (.07 + jitter(i + 2) * .09);
    let dx = Math.sin(angle) * .82, dy = .36 + Math.cos(angle) * .76;
    const length = (.20 + jitter(i * 3 + pair + 8) * .18) * cluster.scale, scale = length / Math.hypot(dx, dy);
    dx *= scale; dy *= scale;
    // Keep the alpha border empty; no cut-off needle becomes a square card.
    dx = Math.max(.025 - x, Math.min(.975 - x, dx));
    dy = Math.max(.025 - y, Math.min(.975 - y, dy));
    const actualLength = Math.hypot(dx, dy);
    pineNeedles.push({ x, y, dx, dy, inverseSquare: 1 / (actualLength * actualLength), inverseLength: 1 / actualLength, bend: (jitter(i + pair + 90) - .5) * .025, tint: jitter(i + 180) });
  }
}

function pineSpray(u, v) {
  let alpha = (1 - smooth(.002, .004, Math.abs(u - .5))) * smooth(.025, .06, v) * (1 - smooth(.78, .83, v));
  for (const cluster of pineClusters) {
    const dx = cluster.x - .5, dy = .12, px = u - .5, py = v - cluster.y + dy;
    const t = (px * dx + py * dy) / (dx * dx + dy * dy);
    if (t > 0 && t < 1) alpha = Math.max(alpha, 1 - smooth(.0018, .0035, Math.abs(px * dy - py * dx) / Math.hypot(dx, dy)));
  }
  let albedo = .67, relief = .025 * alpha;
  for (const needle of pineNeedles) {
    const px = u - needle.x, py = v - needle.y;
    const t = (px * needle.dx + py * needle.dy) * needle.inverseSquare;
    if (t <= 0 || t >= 1) continue;
    const across = (px * needle.dy - py * needle.dx) * needle.inverseLength - needle.bend * 4 * t * (1 - t);
    const width = .0036 * (1 - t * .8), edge = Math.abs(across) / width;
    const coverage = (1 - smooth(width - .0009, width + .0009, Math.abs(across))) * (1 - smooth(.94, 1, t));
    if (coverage <= alpha) continue;
    alpha = coverage;
    albedo = .73 + needle.tint * .14 + t * .10 - Math.min(1, edge) * .09;
    relief = .10 * Math.max(0, 1 - edge * edge);
  }
  return [albedo, relief, alpha];
}

function leafSpray(u, v, species) {
  if (species === "pine") return pineSpray(u, v);
  let alpha = 1 - smooth(.006, .010, Math.abs(u - .5));
  alpha *= smooth(.025, .05, v) * (1 - smooth(.91, .95, v));
  let relief = .04 * alpha, albedo = .7;
  const pine = species === "pine";
  const count = pine ? 18 : 3;
  for (let spray = 0; spray < 3; spray++) {
  const stemX = .27 + spray * .23 + (spray - 1) * v * .055;
  const stem = (1 - smooth(.0025, .0045, Math.abs(u - stemX))) * smooth(.04, .07, v) * (1 - smooth(.9, .96, v));
  alpha = Math.max(alpha, stem);
  for (let row = 0; row < count; row++) {
    for (const side of [-1, 1]) {
      const startY = pine ? .06 + row * .045 : .13 + row * .265 + (spray % 2) * .023;
      const dx = side * (pine ? .15 - row * .0015 : .21 - row * .014);
      const dy = pine ? .075 : .155;
      const px = u - stemX, py = v - startY - (side > 0 ? .018 : 0);
      const length = Math.hypot(dx, dy);
      const t = (px * dx + py * dy) / (length * length);
      if (t <= 0 || t >= 1) continue;
      const across = (px * dy - py * dx) / length;
      const blade = Math.pow(Math.sin(Math.PI * t), pine ? .45 : .7);
      const lobes = species === "oak" ? 1 + .17 * Math.sin(t * Math.PI * 10) : 1 + .04 * Math.sin(t * Math.PI * 32);
      const width = (pine ? .0068 : .052) * blade * (pine ? 1 : lobes);
      const coverage = 1 - smooth(width - .0015, width + .0015, Math.abs(across));
      if (coverage <= alpha) continue;
      alpha = coverage;
      const centerVein = Math.exp(-Math.abs(across) * (pine ? 240 : 480));
      const sideVein = pine ? 0 : Math.pow(Math.max(0, Math.cos((t + Math.abs(across) * 1.8) * Math.PI * 24)), 14) * .055;
      const edge = clamp01(Math.abs(across) / Math.max(.001, width));
      albedo = .78 + .1 * t + centerVein * .07 + sideVein - .065 * edge + .018 * Math.sin(u * 177 + v * 97);
      relief = .2 * (1 - edge * edge) + centerVein * .025 + sideVein * .14;
    }
  }
  }
  return [albedo, relief, alpha];
}

function bark(u, v, species) {
  const wave = Math.sin(u * Math.PI * 24 + Math.sin(v * Math.PI * 2) * .6);
  const fine = Math.sin(u * Math.PI * 90 + Math.sin(v * Math.PI * 6) * 1.5);
  if (species === "birch") {
    const marks = Math.pow(Math.max(0, Math.sin(v * Math.PI * 28 + Math.sin(u * Math.PI * 2) * 1.7)), 18)
      * Math.pow(Math.max(0, Math.sin(u * Math.PI * 10 + Math.sin(v * Math.PI * 4))), 2);
    return [.9 - marks * .63 + fine * .015, fine * .012 - marks * .025, 1];
  }
  const groove = Math.pow(.5 + wave * .5, 5);
  return [.66 + wave * .1 + fine * .045 - groove * .16, wave * .055 + fine * .017 - groove * .045, 1];
}

function coverage(data, threshold = 128) {
  let hits = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= threshold) hits++;
  return hits / (data.length / 4);
}

/** Preserve alpha-test coverage while minifying; averaging alone erases needles. */
function makeMipmaps(base, preserveCoverage) {
  const mipmaps = [base];
  const target = coverage(base.data);
  let source = base;
  while (source.width > 1) {
    const width = source.width / 2, data = new Uint8Array(width * width * 4);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
      const a = ((y * 2) * source.width + x * 2) * 4 + c;
      data[(y * width + x) * 4 + c] = Math.round((source.data[a] + source.data[a + 4] + source.data[a + source.width * 4] + source.data[a + source.width * 4 + 4]) / 4);
    }
    if (preserveCoverage) {
      // Find a threshold with the closest representable pixel coverage, then
      // scale around it. A 1x1 mip cannot encode partial cutout occupancy.
      const alphas = [];
      for (let i = 3; i < data.length; i += 4) alphas.push(data[i]);
      alphas.sort((a, b) => b - a);
      const wanted = Math.max(1, Math.round(target * alphas.length));
      const threshold = Math.max(1, ((alphas[wanted - 1] ?? 255) + (alphas[wanted] ?? 0)) * .5);
      const scale = 128 / threshold;
      for (let i = 3; i < data.length; i += 4) data[i] = Math.min(255, Math.round(data[i] * scale));
    }
    source = { data, width, height: width };
    mipmaps.push(source);
  }
  return mipmaps;
}

function makeTexture(species, isBark) {
  const data = new Uint8Array(SIZE * SIZE * 4), relief = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const index = y * SIZE + x;
    const sample = isBark ? bark((x + .5) / SIZE, (y + .5) / SIZE, species) : leafSpray((x + .5) / SIZE, (y + .5) / SIZE, species);
    data[index * 4] = Math.round(clamp01(sample[0]) * 255);
    data[index * 4 + 3] = Math.round(clamp01(sample[2]) * 255);
    relief[index] = sample[1];
  }
  const at = (x, y) => relief[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const index = (y * SIZE + x) * 4;
    // Small perturbations keep broadleaf cards softly folded instead of
    // turning the alpha boundary into a raised, bevelled plastic badge.
    const inside = isBark || data[index + 3] >= 240;
    const dx = inside ? (at(x - 1, y) - at(x + 1, y)) * 2.8 : 0;
    const dy = inside ? (at(x, y - 1) - at(x, y + 1)) * 2.8 : 0;
    data[index + 1] = Math.round(clamp01(.5 + dx) * 255);
    data[index + 2] = Math.round(clamp01(.5 + dy) * 255);
  }
  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  texture.name = `Foliage ${species} ${isBark ? "bark" : "leaf spray"}`;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = isBark ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.mipmaps = makeMipmaps({ data, width: SIZE, height: SIZE }, !isBark);
  texture.needsUpdate = true;
  return texture;
}

export function getFoliageSurfaceTextures(species) {
  if (!["oak", "birch", "pine"].includes(species)) return null;
  let entry = cached.get(species);
  if (!entry) {
    entry = { leaves: makeTexture(species, false), bark: makeTexture(species, true) };
    cached.set(species, entry);
  }
  return entry;
}
