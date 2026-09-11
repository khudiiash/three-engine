/** Reactive architectural masses. Coordinates are local to the model root. */
const numeric = (value, fallback, min, max) => {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
};
const vector = (value, defaults, min, max) => defaults.map((fallback, i) => numeric(value?.[i], fallback, min, max));
const color = value => typeof value === "string" && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ? value : "#ddc7a5";
const pick = (value, choices, fallback) => choices.includes(value) ? value : fallback;
const list = (value, max, label) => {
  if (!Array.isArray(value)) return [];
  if (value.length > max) throw new Error(`Architecture supports up to ${max} ${label}.`);
  return value;
};
const identifier = (value, prefix, i) => typeof value === "string" && value.trim() ? value.slice(0, 100) : `${prefix}-${i + 1}`;

export function normalizeArchitectureModel(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const forms = list(source.forms, 256, "forms").map((form, i) => ({
    id: identifier(form?.id, "form", i), shape: pick(form?.shape, ["box", "round"], "box"),
    position: vector(form?.position, [0, 0, 0], -100000, 100000),
    size: vector(form?.size, [3, 3, 3], .3, 500),
    rotationY: numeric(form?.rotationY, 0, -Math.PI * 20000, Math.PI * 20000),
    color: color(form?.color), roof: pick(form?.roof, ["hip", "flat", "none"], "hip"),
    roofHeight: numeric(form?.roofHeight, 1.2, .1, 50), windows: form?.windows !== false,
  }));
  const ids = new Set(forms.map(form => form.id));
  if (ids.size !== forms.length) throw new Error("Architecture form IDs must be unique.");
  let pointCount = 0;
  const paths = list(source.paths, 64, "paths").map((path, i) => {
    const points = list(path?.points, 64, "points per path").map(point => vector(point, [0, 0], -100000, 100000));
    pointCount += points.length;
    return { id: identifier(path?.id, "path", i), points, width: numeric(path?.width, 2, .3, 30), elevation: numeric(path?.elevation, 0, -100000, 100000) };
  }).filter(path => path.points.length >= 2);
  if (pointCount > 2048) throw new Error("Architecture paths support up to 2,048 points in total.");
  const openings = list(source.openings, 512, "openings").map((opening, i) => {
    const n = vector(opening?.normal, [0, 0, -1], -1, 1), length = Math.hypot(n[0], n[2]);
    return { id: identifier(opening?.id, "opening", i), formId: opening?.formId,
      position: vector(opening?.position, [0, 1.5, 0], -100000, 100000), normal: length > 1e-6 ? [n[0] / length, 0, n[2] / length] : [0, 0, -1],
      width: numeric(opening?.width, 1, .15, 100), height: numeric(opening?.height, 1.2, .15, 100),
      kind: pick(opening?.kind, ["window", "door", "arch"], "window"),
    };
  }).filter(opening => ids.has(opening.formId));
  if (new Set(paths.map(path => path.id)).size !== paths.length) throw new Error("Architecture path IDs must be unique.");
  if (new Set(openings.map(opening => opening.id)).size !== openings.length) throw new Error("Architecture opening IDs must be unique.");
  return { version: 1, cellSize: numeric(source.cellSize, 3, .25, 50), forms, paths, openings };
}

/** Counter-clockwise XZ ring, matching the faceted circular shell exactly. */
export function getArchitectureFormFootprint(form) {
  const [width, , depth] = form.size, [x, , z] = form.position;
  const c = Math.cos(form.rotationY || 0), s = Math.sin(form.rotationY || 0);
  const points = form.shape === "round"
    ? Array.from({ length: 24 }, (_, i) => [Math.cos(i * Math.PI / 12) * width / 2, Math.sin(i * Math.PI / 12) * depth / 2])
    : [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]];
  return points.map(([px, pz]) => [x + px * c + pz * s, z - px * s + pz * c]);
}

export function architectureFormBounds(form, includeRoof = true) {
  const ring = getArchitectureFormFootprint(form);
  return { min: [Math.min(...ring.map(p => p[0])), form.position[1], Math.min(...ring.map(p => p[1]))],
    max: [Math.max(...ring.map(p => p[0])), form.position[1] + form.size[1] + (includeRoof && form.roof === "hip" ? form.roofHeight : 0), Math.max(...ring.map(p => p[1]))] };
}
