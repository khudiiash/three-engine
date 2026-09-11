import * as THREE from "three/webgpu";
import { normalizeArchitectureModel, getArchitectureFormFootprint } from "./formModel.js";

// Faces are clipped directly against neighboring convex masses. Keeping this
// boundary representation avoids rebuilding a CSG tree as a town grows, and
// removes the shared wall before a hollow skin is generated from the exterior.
const EPS = 1e-6, MAX_VERTICES = 600000, MAX_FRAGMENTS = 2048;
const CACHE_LIMIT = 350000, cache = new Map(); let cachedVertices = 0;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b, scale = 1) => a.map((v, i) => v + b[i] * scale);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const length = Math.hypot(...a); return length > EPS ? a.map(v => v / length) : [0, 1, 0]; };
const boxOf = points => ({ min: [0, 1, 2].map(i => Math.min(...points.map(p => p[i]))), max: [0, 1, 2].map(i => Math.max(...points.map(p => p[i]))) });
const overlaps = (a, b, tolerance = EPS) => a.min.every((v, i) => v <= b.max[i] + tolerance && a.max[i] >= b.min[i] - tolerance);
const plane = (normal, point) => ({ normal, constant: dot(normal, point) });
const thickness = form => Math.min(.2, form.size[0] * .15, form.size[1] * .15, form.size[2] * .15);
const area = points => {
  if (points.length < 3) return 0;
  const origin = points[0]; let sum = [0, 0, 0];
  for (let i = 1; i < points.length - 1; i++) sum = add(sum, cross(sub(points[i], origin), sub(points[i + 1], origin)));
  return Math.hypot(...sum) / 2;
};
function clean(points) {
  const result = [];
  for (const p of points) if (!result.length || Math.hypot(...sub(p, result.at(-1))) > EPS) result.push(p);
  if (result.length > 1 && Math.hypot(...sub(result[0], result.at(-1))) < EPS) result.pop();
  return result.length >= 3 && area(result) > EPS * EPS ? result : [];
}

function clip(points, boundary, inside, bias = 0) {
  if (!points.length) return [];
  if (points.every(point => Math.abs(dot(boundary.normal, point) - boundary.constant + bias) <= EPS * .01)) return inside ? points : [];
  const output = [], sign = inside ? 1 : -1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const da = dot(boundary.normal, a) - boundary.constant + bias, db = dot(boundary.normal, b) - boundary.constant + bias;
    const aIn = da * sign <= EPS * .01, bIn = db * sign <= EPS * .01;
    if (aIn) output.push(a);
    if (aIn !== bIn && Math.abs(da - db) > EPS * .001) output.push(add(a, sub(b, a), da / (da - db)));
  }
  return clean(output);
}

/** Exact polygon minus convex solid, represented by convex remaining polygons. */
function subtractPolygon(points, solid, normal, bias = 0) {
  let intersection = points;
  for (const boundary of solid.planes) {
    intersection = clip(intersection, boundary, true, bias * dot(normal, boundary.normal));
    if (!intersection.length) return [points];
  }
  if (area(intersection) >= area(points) * (1 - 1e-10)) return [];
  let remainder = points;
  const outside = [];
  for (const boundary of solid.planes) {
    const offset = bias * dot(normal, boundary.normal);
    const next = clip(remainder, boundary, true, offset);
    const fragment = clip(remainder, boundary, false, offset);
    if (fragment.length) outside.push(fragment);
    remainder = next;
    if (!remainder.length) return outside;
  }
  return outside;
}

function subtractAll(polygons, solid, normal, bias = 0) {
  const result = [];
  for (const polygon of polygons) {
    if (!overlaps(boxOf(polygon), solid.bounds, Math.abs(bias) + EPS)) { result.push(polygon); continue; }
    result.push(...subtractPolygon(polygon, solid, normal, bias));
    if (result.length > MAX_FRAGMENTS) throw new Error("This junction is too complex. Simplify overlapping forms or paths.");
  }
  return result;
}

function prism(ring, bottom, top, owner, kind = "wall") {
  const faces = [], planes = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], normal = unit([b[1] - a[1], 0, a[0] - b[0]]);
    const points = [[a[0], bottom, a[1]], [b[0], bottom, b[1]], [b[0], top, b[1]], [a[0], top, a[1]]];
    faces.push({ points, normal, kind }); planes.push(plane(normal, points[0]));
  }
  faces.push({ points: ring.map(([x, z]) => [x, bottom, z]), normal: [0, -1, 0], kind: "floor" });
  faces.push({ points: ring.map(([x, z]) => [x, top, z]), normal: [0, 1, 0], kind: "top" });
  planes.push(plane([0, -1, 0], [0, bottom, 0]), plane([0, 1, 0], [0, top, 0]));
  return { owner, kind, faces, planes, bounds: boxOf(faces.flatMap(face => face.points)) };
}

function roofSolid(form, owner) {
  if (form.roof !== "hip") return null;
  const ring = getArchitectureFormFootprint(form), y = form.position[1] + form.size[1], h = form.roofHeight;
  const transform = ([x, z]) => [form.position[0] + x * Math.cos(form.rotationY) + z * Math.sin(form.rotationY), y + h, form.position[2] - x * Math.sin(form.rotationY) + z * Math.cos(form.rotationY)];
  const lower = ring.map(([x, z]) => [x, y, z]); let polygons;
  if (form.shape === "round") {
    const apex = [form.position[0], y + h, form.position[2]];
    polygons = lower.map((a, i) => [a, lower[(i + 1) % lower.length], apex]);
  } else {
    const width = form.size[0], depth = form.size[2];
    if (width >= depth) {
      const left = transform([-(width - depth) / 2, 0]), right = transform([(width - depth) / 2, 0]);
      polygons = [[lower[0], lower[1], right, left], [lower[1], lower[2], right], [lower[2], lower[3], left, right], [lower[3], lower[0], left]];
    } else {
      const front = transform([0, -(depth - width) / 2]), back = transform([0, (depth - width) / 2]);
      polygons = [[lower[0], lower[1], front], [lower[1], lower[2], back, front], [lower[2], lower[3], back], [lower[3], lower[0], front, back]];
    }
  }
  const faces = polygons.map(clean).filter(p => p.length).map(points => {
    let normal = unit(cross(sub(points[1], points[0]), sub(points[2], points[0])));
    if (normal[1] < 0) normal = normal.map(v => -v);
    return { points, normal, kind: "roof" };
  });
  return { owner, kind: "roof", faces, planes: [...faces.map(face => plane(face.normal, face.points[0])), plane([0, -1, 0], [0, y, 0])], bounds: boxOf(faces.flatMap(face => face.points)) };
}

function openingSolid(opening, form) {
  const center = opening.position, normal = opening.normal, tangent = [normal[2], 0, -normal[0]];
  const width = opening.width, height = opening.height, radius = Math.min(width / 2, height * .55);
  const ring = opening.kind === "arch"
    ? [[-width / 2, -height / 2], [width / 2, -height / 2], ...Array.from({ length: 13 }, (_, i) => [Math.cos(i * Math.PI / 12) * width / 2, height / 2 - radius + Math.sin(i * Math.PI / 12) * radius])]
    : [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]];
  const depth = thickness(form) * 3 + .15 + (form.shape === "round" ? Math.min(Math.max(...form.size), width * width / Math.max(.6, Math.min(form.size[0], form.size[2]) * 2)) : 0);
  const planes = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], outward = unit(add(tangent.map(v => v * (b[1] - a[1])), [0, a[0] - b[0], 0]));
    return plane(outward, add(add(center, tangent, a[0]), [0, a[1], 0]));
  });
  planes.push(plane(normal, add(center, normal, depth)), plane(normal.map(v => -v), add(center, normal, -depth)));
  const points = ring.flatMap(([x, y]) => [-depth, depth].map(d => add(add(add(center, tangent, x), [0, y, 0]), normal, d)));
  return { planes, bounds: boxOf(points), id: opening.id };
}

function autoOpenings(form) {
  if (!form.windows || form.size[1] < 2.3) return [];
  const ring = getArchitectureFormFootprint(form), rows = Math.min(4, Math.max(1, Math.floor(form.size[1] / 3))), result = [];
  const addWindow = (x, z, normal, row, width = .95) => result.push({ id: `auto-${result.length}`, formId: form.id, position: [x, form.position[1] + (row + .55) * form.size[1] / rows, z], normal, width, height: Math.min(1.15, form.size[1] / rows * .38), kind: "window" });
  if (form.shape === "round") {
    const count = Math.min(16, Math.max(4, Math.floor(Math.PI * (form.size[0] + form.size[2]) / 2 / 2.8)));
    for (let i = 0; i < count; i++) {
      const angle = i * Math.PI * 2 / count, local = [Math.cos(angle) * form.size[0] / 2, Math.sin(angle) * form.size[2] / 2];
      const c = Math.cos(form.rotationY), s = Math.sin(form.rotationY);
      const n = unit([Math.cos(angle) / form.size[0], 0, Math.sin(angle) / form.size[2]]);
      for (let row = 0; row < rows; row++) addWindow(form.position[0] + local[0] * c + local[1] * s, form.position[2] - local[0] * s + local[1] * c, [n[0] * c + n[2] * s, 0, -n[0] * s + n[2] * c], row, Math.min(.95, Math.min(form.size[0], form.size[2]) * .3));
    }
  } else for (let edge = 0; edge < ring.length; edge++) {
    const a = ring[edge], b = ring[(edge + 1) % ring.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1.8) continue;
    const count = Math.min(4, Math.max(1, Math.floor(length / 2.8))), n = unit([b[1] - a[1], 0, a[0] - b[0]]);
    for (let col = 0; col < count; col++) for (let row = 0; row < rows; row++) addWindow(a[0] + (b[0] - a[0]) * (col + .5) / count, a[1] + (b[1] - a[1]) * (col + .5) / count, n, row);
  }
  return result;
}

function pathSegments(paths) {
  const result = [];
  for (const path of paths) for (let i = 0; i < path.points.length - 1; i++) {
    const a = path.points[i], b = path.points[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
    if (length < .01) continue;
    const nx = -dz / length * path.width / 2, nz = dx / length * path.width / 2;
    const ex = dx / length * .02, ez = dz / length * .02;
    const ring = [[a[0] - ex - nx, a[1] - ez - nz], [b[0] + ex - nx, b[1] + ez - nz], [b[0] + ex + nx, b[1] + ez + nz], [a[0] - ex + nx, a[1] - ez + nz]];
    result.push({ ...prism(ring, path.elevation - .02, path.elevation + 2.4, -1), pathId: path.id, ring, elevation: path.elevation, width: path.width });
  }
  return result;
}

function faceName(kind, normal) {
  if (kind === "roof") return "roof";
  if (normal[1] > .5) return "top";
  if (normal[1] < -.5) return "bottom";
  return Math.abs(normal[0]) > Math.abs(normal[2]) ? normal[0] > 0 ? "east" : "west" : normal[2] > 0 ? "south" : "north";
}

function collector() {
  return { position: [], normal: [], uv: [], index: [], groups: [], surfaces: [], descriptors: [], materialMap: new Map() };
}
function materialIndex(output, color, role) {
  const key = `${role}:${color}`;
  if (!output.materialMap.has(key)) { output.materialMap.set(key, output.descriptors.length); output.descriptors.push({ color, role }); }
  return output.materialMap.get(key);
}

function emitFace(output, polygon, normal, metadata, color, role) {
  let points = clean(polygon);
  if (!points.length) return;
  if (dot(cross(sub(points[1], points[0]), sub(points[2], points[0])), normal) < 0) points = [...points].reverse();
  const base = output.position.length / 3, start = output.index.length;
  if (base + points.length > MAX_VERTICES) throw new Error("Architecture geometry exceeded 600,000 vertices. Simplify the model.");
  const tangent = Math.abs(normal[1]) > .9 ? [1, 0, 0] : unit([normal[2], 0, -normal[0]]), vertical = unit(cross(normal, tangent));
  for (const p of points) { output.position.push(...p); output.normal.push(...normal); output.uv.push(dot(p, tangent), dot(p, vertical)); }
  for (let i = 1; i < points.length - 1; i++) output.index.push(base, base + i, base + i + 1);
  const count = output.index.length - start, index = materialIndex(output, color, role);
  output.groups.push({ start, count, materialIndex: index });
  output.surfaces.push({ start, count, ...metadata, normal: [...normal], face: faceName(metadata.kind, normal) });
}

function emitSkin(output, polygon, normal, depth, metadata, color, role) {
  let points = clean(polygon);
  if (!points.length) return;
  if (dot(cross(sub(points[1], points[0]), sub(points[2], points[0])), normal) < 0) points = [...points].reverse();
  const inner = points.map(point => add(point, normal, -depth));
  emitFace(output, points, normal, metadata, color, role);
  emitFace(output, inner, normal.map(v => -v), { ...metadata, interior: true }, color, role);
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length, outward = unit(cross(sub(points[j], points[i]), normal));
    emitFace(output, [points[i], points[j], inner[j], inner[i]], outward, { ...metadata, interior: true }, color, role);
  }
}

function exposed(face, solid, neighbors) {
  let polygons = [face.points];
  for (const neighbor of neighbors) {
    if (neighbor === solid || !overlaps(boxOf(face.points), neighbor.bounds)) continue;
    // Outward sampling removes opposite shared faces. Coplanar faces pointing
    // the same way belong to the earlier form, so overlapping boxes never flicker.
    const coincident = neighbor.planes.some(boundary => dot(boundary.normal, face.normal) > 1 - 1e-8 && Math.abs(dot(boundary.normal, face.points[0]) - boundary.constant) < EPS * 8);
    const bias = solid.kind === "support" || (face.kind === "roof" && neighbor.kind !== "roof") || (coincident && neighbor.owner < solid.owner) ? 0 : EPS * 4;
    polygons = subtractAll(polygons, neighbor, face.normal, bias);
    if (!polygons.length) break;
  }
  return polygons;
}

function colorFor(form, role) {
  if (role === "roof") return `#${new THREE.Color(form.color).multiplyScalar(.44).getHexString()}`;
  if (role === "floor" || role === "support") return `#${new THREE.Color(form.color).multiplyScalar(.8).getHexString()}`;
  return form.color;
}

/** Cross section of a convex post, used to close the new faces made by cuts. */
function section(solid, boundary) {
  const vertices = solid.faces.flatMap(face => face.points), distances = vertices.map(point => dot(boundary.normal, point) - boundary.constant);
  if (Math.min(...distances) >= -EPS || Math.max(...distances) <= EPS) return [];
  const points = [];
  const keep = point => { if (!points.some(other => Math.hypot(...sub(point, other)) < EPS)) points.push(point); };
  for (const face of solid.faces) for (let i = 0; i < face.points.length; i++) {
    const a = face.points[i], b = face.points[(i + 1) % face.points.length];
    const da = dot(boundary.normal, a) - boundary.constant, db = dot(boundary.normal, b) - boundary.constant;
    if (Math.abs(da) < EPS) keep(a);
    if (da * db < 0) keep(add(a, sub(b, a), da / (da - db)));
  }
  if (points.length < 3) return [];
  const center = points.reduce((sum, point) => add(sum, point, 1 / points.length), [0, 0, 0]);
  const u = unit(cross(Math.abs(boundary.normal[1]) < .9 ? [0, 1, 0] : [1, 0, 0], boundary.normal)), v = cross(boundary.normal, u);
  return clean(points.sort((a, b) => Math.atan2(dot(sub(a, center), v), dot(sub(a, center), u)) - Math.atan2(dot(sub(b, center), v), dot(sub(b, center), u))));
}

function supportCutCaps(output, post, cutters, form) {
  for (let index = 0; index < cutters.length; index++) {
    const cutter = cutters[index];
    for (const boundary of cutter.planes) {
      let polygon = section(post, boundary);
      for (const constraint of cutter.planes) {
        polygon = clip(polygon, constraint, true);
        if (!polygon.length) break;
      }
      if (!polygon.length) continue;
      const normal = boundary.normal.map(n => -n);
      let polygons = [polygon];
      for (let other = 0; other < cutters.length; other++) {
        if (other === index) continue;
        const coincident = cutters[other].planes.some(p => dot(p.normal, boundary.normal) > 1 - 1e-8 && Math.abs(p.constant - boundary.constant) < EPS);
        if (coincident && other > index) continue;
        polygons = subtractAll(polygons, cutters[other], normal);
      }
      for (const cap of polygons) emitFace(output, cap, normal, { formId: form.id, kind: "support", cap: true }, colorFor(form, "support"), "support");
    }
  }
}

function compileForm(form, index, bodies, roofs, passages, manual) {
  const body = bodies[index], roof = roofs[index];
  const relevantBounds = { min: [body.bounds.min[0], Math.min(0, body.bounds.min[1]), body.bounds.min[2]], max: roof ? roof.bounds.max.map((n, i) => Math.max(n, body.bounds.max[i])) : body.bounds.max };
  const neighbors = [...bodies, ...roofs.filter(Boolean)].filter(other => other.owner !== index && overlaps(relevantBounds, other.bounds, .01));
  const paths = passages.filter(path => overlaps(relevantBounds, path.bounds));
  const authored = manual.filter(opening => opening.formId === form.id);
  const automatic = autoOpenings(form).filter(opening => !authored.some(other => Math.hypot(...sub(opening.position, other.position)) < (opening.width + other.width + opening.height + other.height) * .35));
  const cutters = [...authored, ...automatic].map(opening => openingSolid(opening, form));
  const key = JSON.stringify([form, neighbors.map(n => [n.owner, n.kind, n.planes]), paths.map(p => [p.pathId, p.planes]), authored]);
  if (cache.has(key)) { const entry = cache.get(key); cache.delete(key); cache.set(key, entry); return { output: entry, cached: true }; }
  const output = collector(), t = thickness(form);
  for (const face of body.faces) {
    if (face.kind === "top" && form.roof !== "flat") continue;
    let polygons = exposed(face, body, neighbors);
    if (face.kind === "wall") for (const cutter of [...cutters, ...paths]) polygons = subtractAll(polygons, cutter, face.normal);
    // The underside becomes a floor hanging below the authored base elevation.
    const kind = face.kind === "top" ? "roof" : face.kind;
    for (const polygon of polygons) emitSkin(output, kind === "floor" ? polygon.map(p => add(p, face.normal, t)) : polygon, face.normal, t, { formId: form.id, kind }, colorFor(form, kind), kind);
  }
  if (roof) for (const face of roof.faces) for (const polygon of exposed(face, roof, neighbors)) emitSkin(output, polygon, face.normal, Math.min(.12, t), { formId: form.id, kind: "roof" }, colorFor(form, "roof"), "roof");
  if (form.position[1] > .3) {
    const ring = getArchitectureFormFootprint(form), postWidth = Math.min(.35, form.size[0] / 5, form.size[2] / 5), center = form.position;
    const anchors = form.shape === "round" ? [ring[3], ring[9], ring[15], ring[21]] : ring;
    for (const anchor of anchors) {
      const point = [center[0] + (anchor[0] - center[0]) * .8, center[2] + (anchor[1] - center[2]) * .8], h = postWidth / 2;
      const post = prism([[point[0] - h, point[1] - h], [point[0] + h, point[1] - h], [point[0] + h, point[1] + h], [point[0] - h, point[1] + h]], 0, form.position[1] - t, index, "support");
      const blockers = [...bodies, ...roofs.filter(Boolean)].filter(other => other.owner !== index && overlaps(post.bounds, other.bounds));
      const postPaths = passages.filter(path => overlaps(post.bounds, path.bounds));
      for (const face of post.faces) {
        let polygons = exposed(face, post, blockers);
        for (const path of postPaths) polygons = subtractAll(polygons, path, face.normal);
        for (const polygon of polygons) emitFace(output, polygon, face.normal, { formId: form.id, kind: "support" }, colorFor(form, "support"), "support");
      }
      supportCutCaps(output, post, [...blockers, ...postPaths], form);
    }
  }
  const vertexCount = output.position.length / 3;
  if (vertexCount <= CACHE_LIMIT) {
    cache.set(key, output); cachedVertices += vertexCount;
    while (cache.size > 384 || cachedVertices > CACHE_LIMIT) { const oldest = cache.keys().next().value; cachedVertices -= cache.get(oldest).position.length / 3; cache.delete(oldest); }
  }
  return { output, cached: false };
}

function append(output, source) {
  const vertexOffset = output.position.length / 3, indexOffset = output.index.length;
  if (vertexOffset + source.position.length / 3 > MAX_VERTICES) throw new Error("Architecture geometry exceeded 600,000 vertices. Simplify the model.");
  for (const n of source.position) output.position.push(n);
  for (const n of source.normal) output.normal.push(n);
  for (const n of source.uv) output.uv.push(n);
  for (const n of source.index) output.index.push(n + vertexOffset);
  const materials = source.descriptors.map(descriptor => materialIndex(output, descriptor.color, descriptor.role));
  for (const group of source.groups) output.groups.push({ start: group.start + indexOffset, count: group.count, materialIndex: materials[group.materialIndex] });
  for (const surface of source.surfaces) output.surfaces.push({ ...surface, start: surface.start + indexOffset });
}

export function buildArchitectureFormGeometry(input) {
  const model = normalizeArchitectureModel(input), output = collector();
  const bodies = model.forms.map((form, i) => prism(getArchitectureFormFootprint(form), form.position[1], form.position[1] + form.size[1], i));
  const roofs = model.forms.map(roofSolid), passages = pathSegments(model.paths); let reusedForms = 0;
  for (let i = 0; i < model.forms.length; i++) {
    const compiled = compileForm(model.forms[i], i, bodies, roofs, passages, model.openings);
    append(output, compiled.output); if (compiled.cached) reusedForms++;
  }
  for (let index = 0; index < passages.length; index++) {
    const path = passages[index], top = { points: path.ring.map(([x, z]) => [x, path.elevation + .015, z]), normal: [0, 1, 0] };
    let polygons = [top.points];
    for (let prior = 0; prior < index; prior++) if (Math.abs(passages[prior].elevation - path.elevation) < .001 && overlaps(path.bounds, passages[prior].bounds)) polygons = subtractAll(polygons, passages[prior], top.normal);
    for (const polygon of polygons) emitSkin(output, polygon, top.normal, .08, { formId: null, pathId: path.pathId, kind: "path" }, "#b7a48b", "path");
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(output.position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(output.normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(output.uv, 2));
  // Batch the entire town by material. Picking ranges are reordered together
  // with their triangles, so faceIndex attribution survives this draw-call cut.
  const ordered = output.groups.map((group, i) => ({ group, surface: output.surfaces[i] })).sort((a, b) => a.group.materialIndex - b.group.materialIndex);
  const indices = [], surfaces = [];
  for (const { group, surface } of ordered) {
    const start = indices.length;
    for (let i = group.start; i < group.start + group.count; i++) indices.push(output.index[i]);
    surfaces.push({ ...surface, start, normal: [...surface.normal] });
    const last = geometry.groups.at(-1);
    if (last && last.materialIndex === group.materialIndex) last.count += group.count;
    else geometry.addGroup(start, group.count, group.materialIndex);
  }
  geometry.setIndex(indices);
  if (output.position.length) { geometry.computeBoundingBox(); geometry.computeBoundingSphere(); }
  else { geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()); geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0); }
  geometry.userData.architectureSurfaceRanges = surfaces;
  return { geometry, materials: output.descriptors, surfaces,
    stats: { forms: model.forms.length, paths: model.paths.length, vertices: output.position.length / 3, triangles: output.index.length / 3, reusedForms } };
}
