/**
 * Dedicated Three.js layer for objects that must only appear in the editor
 * view (camera model, gizmo, grid, selection box, frustum helper).
 *
 * The editor orbit camera leaves all layers enabled, so it sees this layer.
 * Play-mode cameras and the camera-preview camera must `layers.disable()` it
 * so the editor-only content doesn't leak into the game or the PIP render.
 *
 * Picking still works on layer-31 objects because the picking raycaster
 * tests all layers by default (see ViewportPanel.jsx `setupPicking`).
 */
export const EDITOR_LAYER = 31;