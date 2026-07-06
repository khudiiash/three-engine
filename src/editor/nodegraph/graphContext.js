/** Tracks whether the pointer is over a node-graph canvas (shader graph,
 *  particle graph, …). Global keyboard shortcuts (entity delete/copy/paste)
 *  check this so the graph's own Delete-key handling doesn't also delete
 *  the selected scene entity — a plain DOM-ancestry check is fragile because
 *  clicking an SVG edge/node doesn't reliably move `document.activeElement`.
 */
let hovered = false;
export function setGraphHovered(v) {
  hovered = v;
}
export function isGraphHovered() {
  return hovered;
}
