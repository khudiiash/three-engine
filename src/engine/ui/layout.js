/**
 * Pure 2D layout math for the UI system. No three.js, no DOM — everything in
 * here is unit-testable headless (scripts/test-ui-layout.mjs).
 *
 * Coordinate space: "UI pixels", origin top-left, y-down. A rect is
 * `{ x, y, w, h }` in absolute screen coordinates.
 *
 * Element spec (props of a "uielement" component):
 *   anchorMin [x,y], anchorMax [x,y] — 0..1 fractions of the parent rect.
 *   pivot [x,y]                      — 0..1 point of the element's own rect.
 *   pos [x,y], size [w,h]            — meaning depends on the anchors, per axis:
 *     point-anchored (min == max): pos = pivot offset from the anchor point,
 *                                  size = the element's size.
 *     stretched (min != max):      pos = inset from the min-anchor edge,
 *                                  size = inset from the max-anchor edge
 *                                  (Unity's Left/Right ↔ PosX/Width remap).
 */

const EPS = 1e-6;

export const ELEMENT_DEFAULTS = {
  anchorMin: [0.5, 0.5],
  anchorMax: [0.5, 0.5],
  pivot: [0.5, 0.5],
  pos: [0, 0],
  size: [100, 100],
  opacity: 1,
  visible: true,
  raycastTarget: true,
};

/** Spec used for entities under a screen that have no uielement component:
 *  stretch to fill the parent rect entirely. */
export const STRETCH_FILL_SPEC = {
  anchorMin: [0, 0],
  anchorMax: [1, 1],
  pivot: [0.5, 0.5],
  pos: [0, 0],
  size: [0, 0],
};

export function isStretched(spec, axis) {
  return Math.abs(spec.anchorMax[axis] - spec.anchorMin[axis]) > EPS;
}

/** Absolute rect of an element from its spec + the parent's absolute rect. */
export function computeElementRect(parentRect, spec) {
  const out = { x: 0, y: 0, w: 0, h: 0 };
  for (const axis of [0, 1]) {
    const pOrigin = axis === 0 ? parentRect.x : parentRect.y;
    const pSize = axis === 0 ? parentRect.w : parentRect.h;
    const a0 = pOrigin + pSize * spec.anchorMin[axis];
    const a1 = pOrigin + pSize * spec.anchorMax[axis];
    let origin, size;
    if (isStretched(spec, axis)) {
      origin = a0 + spec.pos[axis];
      size = Math.max(0, a1 - spec.size[axis] - origin);
    } else {
      size = Math.max(0, spec.size[axis]);
      origin = a0 + spec.pos[axis] - spec.pivot[axis] * size;
    }
    if (axis === 0) {
      out.x = origin;
      out.w = size;
    } else {
      out.y = origin;
      out.h = size;
    }
  }
  return out;
}

/** The element's pivot point in absolute coordinates (rotation/scale center). */
export function pivotPoint(rect, spec) {
  return {
    x: rect.x + spec.pivot[0] * rect.w,
    y: rect.y + spec.pivot[1] * rect.h,
  };
}

/** Intersection of two rects (either may be null = unbounded). */
export function intersectRects(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, btm - y) };
}

export function rectContains(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/**
 * Screen scale factor from the scale mode + reference resolution.
 * The screen's logical size becomes (canvasW / s, canvasH / s), so a larger
 * factor means bigger UI. Modes:
 *   none   — 1 UI px = 1 canvas px.
 *   width  — reference width always fits exactly (vertical space varies).
 *   height — reference height always fits exactly.
 *   fit    — whole reference resolution is visible (letterbox-ish; min).
 *   fill   — reference resolution covers the screen (crop-ish; max).
 */
export function computeScreenScale(mode, refW, refH, canvasW, canvasH) {
  if (!canvasW || !canvasH) return 1;
  const sw = canvasW / Math.max(1, refW);
  const sh = canvasH / Math.max(1, refH);
  switch (mode) {
    case "width":
      return sw;
    case "height":
      return sh;
    case "fit":
      return Math.min(sw, sh);
    case "fill":
      return Math.max(sw, sh);
    case "none":
    default:
      return 1;
  }
}

export const LAYOUT_DEFAULTS = {
  direction: "column", // column | row
  gap: 8,
  padding: 8,
  alignItems: "stretch", // start | center | end | stretch
  justify: "start", // start | center | end | space-between
  fitContent: false,
};

/**
 * Positions children inside a layout container. `childSizes` is an array of
 * [w, h] preferred sizes (from each child's uielement `size`). Returns
 * `{ rects: [{x,y,w,h}...], contentMain }` — rects are absolute (derived from
 * `containerRect`), contentMain is the total main-axis extent incl. padding
 * (used by fitContent and scroll views).
 */
export function layoutChildren(containerRect, props, childSizes) {
  const p = { ...LAYOUT_DEFAULTS, ...props };
  const row = p.direction === "row";
  const main = row ? 0 : 1; // axis index into size arrays
  const innerMain = (row ? containerRect.w : containerRect.h) - p.padding * 2;
  const innerCross = (row ? containerRect.h : containerRect.w) - p.padding * 2;

  const n = childSizes.length;
  const totalMain = childSizes.reduce((acc, s) => acc + s[main], 0) + p.gap * Math.max(0, n - 1);

  let cursor = p.padding;
  let gap = p.gap;
  if (p.justify === "center") cursor += Math.max(0, (innerMain - totalMain) / 2);
  else if (p.justify === "end") cursor += Math.max(0, innerMain - totalMain);
  else if (p.justify === "space-between" && n > 1) {
    gap = p.gap + Math.max(0, (innerMain - totalMain) / (n - 1));
  }

  const rects = [];
  for (const size of childSizes) {
    const mainSize = size[main];
    const crossPref = size[1 - main];
    const crossSize = p.alignItems === "stretch" ? Math.max(0, innerCross) : crossPref;
    let crossPos = p.padding;
    if (p.alignItems === "center") crossPos += Math.max(0, (innerCross - crossSize) / 2);
    else if (p.alignItems === "end") crossPos += Math.max(0, innerCross - crossSize);

    rects.push(
      row
        ? { x: containerRect.x + cursor, y: containerRect.y + crossPos, w: mainSize, h: crossSize }
        : { x: containerRect.x + crossPos, y: containerRect.y + cursor, w: crossSize, h: mainSize },
    );
    cursor += mainSize + gap;
  }
  return { rects, contentMain: totalMain + p.padding * 2 };
}

/** Clamps a scroll offset to the scrollable range. */
export function clampScroll(offset, contentSize, viewportSize) {
  return Math.max(0, Math.min(offset, Math.max(0, contentSize - viewportSize)));
}

/**
 * Anchor presets for the editor's 3×3 picker (+ stretch variants). Applying
 * a preset sets anchors + pivot and resets pos; size is kept for point
 * presets and zeroed (full stretch) for stretched axes.
 */
export const ANCHOR_PRESETS = {
  "top-left": { anchorMin: [0, 0], anchorMax: [0, 0], pivot: [0, 0] },
  top: { anchorMin: [0.5, 0], anchorMax: [0.5, 0], pivot: [0.5, 0] },
  "top-right": { anchorMin: [1, 0], anchorMax: [1, 0], pivot: [1, 0] },
  left: { anchorMin: [0, 0.5], anchorMax: [0, 0.5], pivot: [0, 0.5] },
  center: { anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5], pivot: [0.5, 0.5] },
  right: { anchorMin: [1, 0.5], anchorMax: [1, 0.5], pivot: [1, 0.5] },
  "bottom-left": { anchorMin: [0, 1], anchorMax: [0, 1], pivot: [0, 1] },
  bottom: { anchorMin: [0.5, 1], anchorMax: [0.5, 1], pivot: [0.5, 1] },
  "bottom-right": { anchorMin: [1, 1], anchorMax: [1, 1], pivot: [1, 1] },
  "stretch-x": { anchorMin: [0, 0.5], anchorMax: [1, 0.5], pivot: [0.5, 0.5] },
  "stretch-y": { anchorMin: [0.5, 0], anchorMax: [0.5, 1], pivot: [0.5, 0.5] },
  stretch: { anchorMin: [0, 0], anchorMax: [1, 1], pivot: [0.5, 0.5] },
};

/** New pos/size values when switching to a preset, preserving point sizes. */
export function applyAnchorPreset(presetName, currentSize) {
  const preset = ANCHOR_PRESETS[presetName];
  if (!preset) return null;
  const stretchX = preset.anchorMax[0] - preset.anchorMin[0] > EPS;
  const stretchY = preset.anchorMax[1] - preset.anchorMin[1] > EPS;
  return {
    anchorMin: [...preset.anchorMin],
    anchorMax: [...preset.anchorMax],
    pivot: [...preset.pivot],
    pos: [0, 0],
    size: [stretchX ? 0 : (currentSize?.[0] ?? 100), stretchY ? 0 : (currentSize?.[1] ?? 100)],
  };
}
