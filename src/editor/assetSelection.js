import { useSelectionStore } from "./store/selectionStore.js";

/**
 * Selection rules for the Assets panel grid, kept apart from the React
 * component so they can be exercised without a DOM (scripts/test-assets-selection.mjs).
 */

/**
 * Explorer-style click selection: a plain click replaces the selection,
 * Ctrl/Cmd toggles a single entry, and Shift extends a contiguous range from
 * the anchor over `visible` (the entries in the order they're displayed).
 */
export function clickSelect(event, entry, visible) {
  const sel = useSelectionStore.getState();
  if (event.shiftKey && sel.assetAnchor) {
    const paths = visible.map((v) => v.path);
    const from = paths.indexOf(sel.assetAnchor);
    const to = paths.indexOf(entry.path);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      // Shift-clicking never moves the range origin, so successive shift-clicks
      // grow and shrink the same range instead of chaining off each other.
      sel.selectAssets(paths.slice(lo, hi + 1), { primary: entry.path, anchor: sel.assetAnchor });
      return;
    }
  }
  if (event.ctrlKey || event.metaKey) {
    sel.toggleAsset(entry.path);
    return;
  }
  sel.selectAsset(entry.path);
}

export const rectsOverlap = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Paths whose on-screen rect intersects the marquee. `rects` is [path, DOMRect]. */
export function pathsInBox(marquee, rects) {
  return rects.filter(([, rect]) => rectsOverlap(marquee, rect)).map(([path]) => path);
}
