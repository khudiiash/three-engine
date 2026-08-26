// @ts-check

/**
 * Who does a click in the viewport actually MEAN?
 *
 * Two questions, and they are not the same one:
 *
 *   1. which entity owns the Object3D under the pointer  (`findEntityId`)
 *   2. which entity did the user intend to grab          (`resolveSelectionTarget`)
 *
 * (2) exists because an imported model is a prefab: `glbImport` writes a
 * `.prefab` whose root carries the whole mesh tree, so dropping a tree into a
 * scene gives you `Tree` with `Trunk_mesh` / `Leaves_mesh` beneath it. Answering
 * (1) alone means clicking a tree selects a leaf — you move the leaves and the
 * trunk stays behind. Every editor with prefabs resolves the click to the
 * instance ROOT and offers a way to reach inside; this is that rule.
 *
 * The escape hatch is `drill` (Alt+click / double-click), plus one piece of
 * memory: once something INSIDE an instance is selected, further clicks in that
 * same instance stay at the level the user already chose, so you can work
 * part-by-part inside one model without holding Alt for every click.
 */

/**
 * Walks up the parent chain to find the entity a picked object belongs to.
 * Entity-aware helpers (e.g. the selection BoxHelper, a light gizmo) carry an
 * `entityId` directly and resolve even though they're flagged editor-only.
 * Pure editor-only helpers (grid, gizmo, generic decoration) don't carry one
 * and short-circuit to null so they don't block selection.
 *
 * @param {any} object
 * @returns {string|null}
 */
export function findEntityId(object) {
  let node = object;
  while (node) {
    if (node.userData.entityId) return node.userData.entityId;
    if (node.userData.editorOnly) return null;
    node = node.parent;
  }
  return null;
}

/**
 * The OUTERMOST prefab instance root at or above `entity`, or null when the
 * entity isn't inside a prefab at all.
 *
 * `getPrefabRoot` (engine/prefab/expand.js) stops at the nearest one, which is
 * the right answer for override bookkeeping and the wrong one here: a nested
 * instance root also carries `prefab`, so stopping early would select the lamp
 * inside the house rather than the house. Selection wants the outermost thing
 * that behaves as a unit.
 *
 * @param {any} entity
 */
export function outermostPrefabRoot(entity) {
  let root = null;
  for (let e = entity; e; e = e.parent) if (e.prefab) root = e;
  return root;
}

/**
 * Maps the entity under the pointer to the entity the click should select.
 *
 * @param {any} entity                   entity that owns the picked object
 * @param {object} [options]
 * @param {boolean} [options.drill]      Alt+click / double-click: take it literally
 * @param {Iterable<any>} [options.selected] the live selection, for the stay-drilled rule
 * @returns {any}                        an entity (never an id), or null
 */
export function resolveSelectionTarget(entity, { drill = false, selected } = {}) {
  if (!entity) return null;
  if (drill) return entity;

  const root = outermostPrefabRoot(entity);
  if (!root || root === entity) return entity;

  // Already drilled into THIS instance? Stay at the level the user chose.
  // Scoped to the same root on purpose: having a child of *some other* prefab
  // selected must not turn the next click on an untouched model into a
  // leaf-select, which is what a global "are we drilled in" flag would do.
  for (const other of selected ?? []) {
    if (other && other !== root && outermostPrefabRoot(other) === root) return entity;
  }
  return root;
}
