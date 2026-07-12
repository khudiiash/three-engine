import { useEffect, useState } from "react";
import { Plus, Trash2, Box, Video, Lightbulb, Sparkles, FileCode2, Package, Circle, ChevronRight, Monitor, Type, Image as ImageIcon, MousePointerClick, Rows3, ScrollText, Square, Eye, EyeOff, Play, Pause, Mountain } from "lucide-react";
import { useSceneStore } from "../store/sceneStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useModulesStore } from "../modules.js";
import { commandBus } from "../commands/CommandBus.js";
import {
  BatchCommand,
  CreateEntityCommand,
  RenameEntityCommand,
  ReparentEntityCommand,
  SetEntityEnabledInEditorCommand,
  SetEntityEnabledInGameCommand,
  isDescendantOf,
  topMostIds,
} from "../commands/entityCommands.js";
import { AddComponentCommand, SetComponentPropCommand } from "../commands/componentCommands.js";
import {
  copyEntities,
  cutEntities,
  pasteEntities,
  clipboardHasEntities,
  duplicateSelection,
  deleteSelection,
} from "../clipboard.js";
import { useAssetDrop } from "../assetDrag.js";
import {
  instantiatePrefab,
  openPrefabMode,
  exitPrefabMode,
  createPrefabFromEntity,
  createVariantFromInstance,
  applyPrefab,
  revertPrefab,
  unpackPrefab,
} from "../prefab.js";
import { usePrefabStore } from "../store/prefabStore.js";
import { prefabRegistry, diffInstance, getPrefabRoot } from "../../engine/index.js";
import { extOf, PREFAB_EXTENSIONS, MODEL_EXTENSIONS } from "../assetLoader.js";
import { basename } from "../store/projectStore.js";
import { isFollowPickArmed, disarmFollowPick, isSurfacePickArmed, disarmSurfacePick } from "./InspectorPanel.jsx";
import { isListenerPickArmed, disarmListenerPick } from "../components/ListenerSection.jsx";
import { disarmTerrainScatterSourcePick, getTerrainScatterSourcePick } from "../terrainBrush.js";
import { engine } from "../engineInstance.js";
import { newScene } from "../sceneIO.js";

const DROPPABLE_ASSET_EXTENSIONS = [...PREFAB_EXTENSIONS, ...MODEL_EXTENSIONS];

/** Assets-panel drop onto the tree: spawn under `parentId` (null = root). */
function dropAssetOnEntity(path, parentId) {
  const ext = extOf(path);
  if (PREFAB_EXTENSIONS.includes(ext)) {
    instantiatePrefab(path, null, parentId).catch((err) => console.error(String(err)));
  } else if (MODEL_EXTENSIONS.includes(ext)) {
    // Raw .glb (legacy leftover or hand-copied file): run it through the
    // import pipeline — mesh entities + geometry/material assets — then drop
    // the resulting prefab where the user aimed.
    (async () => {
      const { unpackGlb } = await import("../glbImport.js");
      const folder = await unpackGlb(path);
      const stem = basename(path).replace(/\.[^.]+$/, "");
      await instantiatePrefab(`${folder}/${stem}.prefab`, null, parentId);
    })().catch((err) => console.error(String(err)));
  }
}

// Common base entities that live directly in the world. Always shown.
const COMMON_PRESETS = [
  { label: "Empty", spec: { name: "Entity", components: [] } },
  // Mesh defaults to a box; the inspector's Geometry dropdown still exposes
  // sphere/plane/cylinder/cone/torus so users can pick the shape there.
  { label: "Mesh", spec: { name: "Mesh", components: [{ type: "mesh", props: { geometry: "box" } }] } },
  // Light defaults to directional; the inspector's kind dropdown exposes
  // point/spot/ambient so users can pick the type there.
  { label: "Light", spec: { name: "Light", components: [{ type: "light", props: { kind: "directional" } }] } },
  { label: "Camera", spec: { name: "Camera", components: [{ type: "camera" }] } },
];

// Terrain lives in the optional `terrain` module — only offered in the Add
// menu when that module is enabled (mirrors how UI presets are gated).
const TERRAIN_PRESET = {
  label: "Terrain",
  spec: { name: "Terrain", components: [{ type: "terrain", props: {} }] },
};

// UI Screen — top-level UI container. Always shown so the user can add one
// from anywhere in the scene.
const UI_SCREEN_PRESET = {
  label: "UI Screen",
  spec: { name: "UI Screen", components: [{ type: "uiscreen" }] },
};

// UI elements (Panel / Image / Text / Button / Layout / Scroll View) only
// make sense inside a UI Screen. The hierarchy menu reveals them only when
// the active parent (currently selected entity, or the implicit scene root
// for the no-selection case) is a UI Screen, so users can't spawn an orphan
// Button at the scene root by accident.
const UI_ELEMENT_PRESETS = [
  {
    label: "UI Panel",
    spec: {
      name: "Panel",
      components: [
        { type: "uielement", props: { size: [360, 240] } },
        { type: "uiimage", props: { color: "#1c1d22", opacity: 0.92, cornerRadius: 14 } },
      ],
    },
  },
  {
    label: "UI Image",
    spec: {
      name: "Image",
      components: [{ type: "uielement", props: { size: [128, 128] } }, { type: "uiimage" }],
    },
  },
  {
    label: "UI Text",
    spec: {
      name: "Text",
      components: [
        { type: "uielement", props: { size: [220, 40] } },
        { type: "uitext", props: { text: "New Text" } },
      ],
    },
  },
  {
    label: "UI Button",
    spec: {
      name: "Button",
      components: [
        { type: "uielement", props: { size: [180, 44] } },
        { type: "uiimage", props: { color: "#0a84ff", cornerRadius: 10 } },
        { type: "uibutton" },
      ],
      children: [
        {
          name: "Label",
          components: [
            {
              type: "uielement",
              props: { anchorMin: [0, 0], anchorMax: [1, 1], size: [0, 0], raycastTarget: false },
            },
            { type: "uitext", props: { text: "Button", fontWeight: "600" } },
          ],
        },
      ],
    },
  },
  {
    label: "UI Layout (Column)",
    spec: {
      name: "Layout",
      components: [
        { type: "uielement", props: { size: [300, 400] } },
        { type: "uilayout" },
      ],
    },
  },
  {
    label: "UI Scroll View",
    spec: {
      name: "Scroll View",
      components: [
        { type: "uielement", props: { size: [320, 420] } },
        { type: "uiimage", props: { color: "#151619", opacity: 0.9, cornerRadius: 12 } },
        { type: "uiscroll" },
      ],
      children: [
        {
          name: "Content",
          components: [
            {
              type: "uielement",
              props: { anchorMin: [0, 0], anchorMax: [1, 0], pivot: [0.5, 0], size: [0, 420] },
            },
            { type: "uilayout", props: { fitContent: true } },
          ],
        },
      ],
    },
  },
];

/** True iff `parentId` refers to a UI Screen entity (or is null — the scene
 *  root, which is *not* a UI Screen). Used to gate UI element presets so
 *  they only appear when the user is adding inside a UI Screen. */
function isParentUiScreen(parentId) {
  if (!parentId) return false;
  const entity = useSceneStore.getState().entities[parentId];
  return !!entity?.components?.uiscreen;
}

// Tauri's `dragDropEnabled` (default true, needed by the Assets panel for OS
// file imports) intercepts the webview's native drag-and-drop wholesale —
// dragstart/dragover/drop never fire for HTML5 `draggable` elements either.
// So reordering here is implemented as a manual pointer-driven drag instead
// of relying on the HTML5 DnD API.
const DRAG_THRESHOLD_PX = 4;
let dragSession = null; // { ids, sourceId, startX, startY, moved }
let suppressNextClick = false;

// Hovering a drag over a collapsed row with children auto-expands it after
// a short delay, mirroring the OS file-explorer "hover to open" convention.
const HOVER_EXPAND_MS = 600;
let hoverExpandId = null;
let hoverExpandTimer = null;

function clearHoverExpand() {
  hoverExpandId = null;
  clearTimeout(hoverExpandTimer);
  hoverExpandTimer = null;
}

/** Finds the row (or the tree's empty area) under a point, DOM-based. */
function hitTestRow(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const row = el.closest("[data-entity-id]");
  if (row) {
    const rect = row.getBoundingClientRect();
    const y = (clientY - rect.top) / rect.height;
    const pos = y < 0.25 ? "before" : y > 0.75 ? "after" : "on";
    return { id: row.dataset.entityId, pos };
  }
  return el.closest(".hierarchy-tree") ? { id: null, pos: "root" } : null;
}

/** Icon (and accent color) for what the entity primarily is, by component priority. */
function EntityIcon({ components }) {
  const { Icon, color } = components.uiscreen
    ? { Icon: Monitor, color: "icon-camera" }
    : components.uibutton
    ? { Icon: MousePointerClick, color: "icon-particles" }
    : components.uitext
    ? { Icon: Type, color: "icon-script" }
    : components.uiscroll
    ? { Icon: ScrollText, color: "icon-model" }
    : components.uilayout
    ? { Icon: Rows3, color: "icon-model" }
    : components.uiimage
    ? { Icon: ImageIcon, color: "icon-mesh" }
    : components.uielement
    ? { Icon: Square, color: "icon-default" }
    : components.camera
    ? { Icon: Video, color: "icon-camera" }
    : components.light
      ? { Icon: Lightbulb, color: "icon-light" }
      : components.particles
        ? { Icon: Sparkles, color: "icon-particles" }
        : components.terrain
          ? { Icon: Mountain, color: "icon-model" }
          : components.mesh
          ? { Icon: Box, color: "icon-mesh" }
          : components.model
            ? { Icon: Package, color: "icon-model" }
            : components.script
              ? { Icon: FileCode2, color: "icon-script" }
              : { Icon: Circle, color: "icon-default" };
  return <Icon className={`entity-icon ${color}`} size={13} strokeWidth={1.75} />;
}

/** Depth-first visible order of entity ids (for shift-range selection). */
function flattenTree(rootIds, entities) {
  const out = [];
  const walk = (id) => {
    const e = entities[id];
    if (!e) return;
    out.push(id);
    e.childIds.forEach(walk);
  };
  rootIds.forEach(walk);
  return out;
}

function handleRowClick(e, id, rootIds, entities) {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  // If the inspector armed a "pick follow target" gesture, this click
  // resolves it: assign `id` as the follow target of whichever camera
  // entity is currently selected (single, mandatory) and disarm.
  if (isFollowPickArmed()) {
    disarmFollowPick();
    const cameraId = useSelectionStore.getState().ids[0];
    if (!cameraId) return;
    const camera = engine.getEntity(cameraId);
    if (!camera || !camera.getComponent("camera")) return;
    // Use a direct SetComponentPropCommand so the change is undoable and
    // matches every other prop change in the inspector.
    commandBus.execute(new SetComponentPropCommand(cameraId, "camera", "followTarget", id));
    return;
  }
  // If the inspector armed a "pick surface entity" gesture, this click
  // resolves it: assign `id` as the scatterSurfaceEntity on whichever
  // Instancer component is on the currently selected entity.
  if (isSurfacePickArmed()) {
    disarmSurfacePick();
    const instancerEntityId = useSelectionStore.getState().ids[0];
    if (!instancerEntityId) return;
    const instancerEntity = engine.getEntity(instancerEntityId);
    if (!instancerEntity || !instancerEntity.getComponent("instancer")) return;
    commandBus.execute(
      new SetComponentPropCommand(instancerEntityId, "instancer", "scatterSurfaceEntity", id),
    );
    return;
  }
  const terrainScatterPick = getTerrainScatterSourcePick();
  if (terrainScatterPick) {
    disarmTerrainScatterSourcePick();
    const source = engine.getEntity(id);
    const terrain = engine.getEntity(terrainScatterPick.terrainEntityId)?.getComponent("terrain");
    if (!source || !terrain || (!source.getComponent("mesh") && !source.getComponent("model"))) return;
    const layers = terrain.props.scatterLayers ?? [];
    if (!layers[terrainScatterPick.layerIndex]) return;
    commandBus.execute(new SetComponentPropCommand(
      terrainScatterPick.terrainEntityId,
      "terrain",
      "scatterLayers",
      layers.map((layer, index) => index === terrainScatterPick.layerIndex
        ? { ...layer, sourceType: "entity", sourceEntity: id }
        : layer),
    ));
    return;
  }
  // Listener target pick: move the listener to the picked entity. Yield the
  // current holder (if any) and add a ListenerComponent to the picked entity,
  // making it the new audio listener.
  if (isListenerPickArmed()) {
    disarmListenerPick();
    const sourceId = useSelectionStore.getState().ids[0];
    if (!sourceId || sourceId === id) return;
    const current = engine.audio?.listenerEntity;
    if (current && current.id !== id) {
      current.getComponent?.("listener")?.setEnabled?.(false);
    }
    const target = engine.getEntity(id);
    if (!target) return;
    if (!target.getComponent("listener")) {
      commandBus.execute(new AddComponentCommand(id, "listener"));
    } else {
      target.getComponent("listener").setEnabled(true);
    }
    return;
  }
  const sel = useSelectionStore.getState();
  if (e.ctrlKey || e.metaKey) {
    sel.toggle(id);
  } else if (e.shiftKey && sel.anchorId) {
    const order = flattenTree(rootIds, entities);
    const a = order.indexOf(sel.anchorId);
    const b = order.indexOf(id);
    if (a === -1 || b === -1) return sel.select(id);
    sel.select(order.slice(Math.min(a, b), Math.max(a, b) + 1), sel.anchorId);
  } else {
    sel.select(id);
  }
}

/**
 * Applies a drop. `pos` is "on" (make child of target), or "before"/"after"
 * (insert as sibling of target). Reparents all dragged top-most entities in
 * one undo step.
 */
function performDrop(draggedIds, targetId, pos) {
  const { entities, rootIds } = useSceneStore.getState();
  const ids = topMostIds(draggedIds).filter((id) => entities[id]);
  const parentId = pos === "on" ? targetId : (entities[targetId]?.parentId ?? null);

  const valid = ids.filter(
    (id) => id !== targetId && !(parentId && isDescendantOf(parentId, id)) && id !== parentId,
  );
  if (!valid.length) return;

  const cmds = [];
  if (pos === "on") {
    for (const id of valid) {
      if (entities[id]?.parentId !== parentId) cmds.push(new ReparentEntityCommand(id, parentId));
      else cmds.push(new ReparentEntityCommand(id, parentId, null)); // move to end
    }
  } else {
    // Sibling list without the dragged entities → stable insertion index.
    const siblings = (parentId ? entities[parentId].childIds : rootIds).filter((id) => !valid.includes(id));
    let index = siblings.indexOf(targetId);
    if (index === -1) index = siblings.length;
    if (pos === "after") index += 1;
    valid.forEach((id, i) => cmds.push(new ReparentEntityCommand(id, parentId, index + i)));
  }
  commandBus.execute(new BatchCommand(cmds, cmds.length === 1 ? cmds[0].label : `Move ${cmds.length} entities`));
}

/** Drop onto the empty tree area: move dragged top-most entities to scene root. */
function performDropToRoot(draggedIds) {
  const { entities } = useSceneStore.getState();
  const ids = topMostIds(draggedIds).filter((id) => entities[id]?.parentId);
  if (!ids.length) return;
  const cmds = ids.map((id) => new ReparentEntityCommand(id, null));
  commandBus.execute(new BatchCommand(cmds, cmds.length === 1 ? cmds[0].label : `Move ${cmds.length} entities`));
}

/**
 * Per-row visibility icons. Two compact buttons toggle the entity's
 * editor-mode and game-mode enabled flags respectively — the first uses
 * an Eye/EyeOff pair (editor visibility is the most-edited), the second
 * uses Play/Pause so the two states are visually distinct in a narrow
 * row. Each click is a single, undoable command. The icons read live
 * values via `engine.getEntity(...)?.[flag]` rather than the React
 * mirror so toggles made from the inspector reflect immediately. They
 * live inside the row but stop propagation so they don't change
 * selection.
 */
function VisibilityIcons({ id }) {
  const live = engine.getEntity(id);
  if (!live) return null;
  const editorOn = live.enabledInEditor !== false;
  const gameOn = live.enabledInGame !== false;
  return (
    <span
      className="hierarchy-vis-icons"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={`hierarchy-vis-icon ${editorOn ? "on" : "off"}`}
        title={editorOn ? "Visible in editor — click to hide" : "Hidden in editor — click to show"}
        onClick={() =>
          commandBus.execute(new SetEntityEnabledInEditorCommand(id, !editorOn))
        }
      >
        {editorOn ? <Eye size={12} /> : <EyeOff size={12} />}
      </button>
      <button
        type="button"
        className={`hierarchy-vis-icon ${gameOn ? "on" : "off"}`}
        title={gameOn ? "Enabled in game — click to disable" : "Disabled in game — click to enable"}
        onClick={() =>
          commandBus.execute(new SetEntityEnabledInGameCommand(id, !gameOn))
        }
      >
        {gameOn ? <Play size={10} /> : <Pause size={10} />}
      </button>
    </span>
  );
}

/**
 * Prefab state for one row: is it an instance root (blue name + badge), a node
 * *inside* an instance (blue name only), or an ordinary entity? Subscribing to
 * the registry version is what makes the badge light up the moment a prefab is
 * created, applied or reverted.
 */
function usePrefabRowInfo(id) {
  usePrefabStore((s) => s.version);
  const live = engine.getEntity(id);
  const root = live ? getPrefabRoot(live) : null;
  if (!root) return {};
  const isRoot = root === live;
  const guid = prefabRegistry.resolveLink(root.prefab);
  const def = guid ? prefabRegistry.getDef(guid) : null;
  return {
    kind: isRoot ? "root" : "child",
    name: def?.name ?? "Prefab",
    path: guid ? prefabRegistry.pathOf(guid) : null,
    missing: !guid,
    // Only the root carries overrides, so only the root can look "modified".
    dirty: isRoot && !!guid && diffInstance(root).length > 0,
  };
}

function EntityRow({
  id,
  depth,
  renamingId,
  setRenamingId,
  dropHint,
  setDropHint,
  onContextMenu,
  rootIds,
  collapsedIds,
  setCollapsedIds,
  draggingIds,
  onRowPointerDown,
}) {
  const entity = useSceneStore((s) => s.entities[id]);
  const selected = useSelectionStore((s) => s.ids.includes(id));
  const prefab = usePrefabRowInfo(id);
  // Assets-panel drags (.prefab/.entity/.glb) land on rows as "add as child".
  const assetDropRef = useAssetDrop({
    accepts: DROPPABLE_ASSET_EXTENSIONS,
    onDrop: (path) => dropAssetOnEntity(path, id),
  });
  if (!entity) return null;

  const isDragging = draggingIds.includes(id);

  const hasChildren = entity.childIds.length > 0;
  const collapsed = hasChildren && collapsedIds.has(id);

  const commitRename = (value) => {
    setRenamingId(null);
    const name = value.trim();
    if (name && name !== entity.name) {
      commandBus.execute(new RenameEntityCommand(id, name));
    }
  };

  const toggleCollapsed = (e) => {
    e.stopPropagation();
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hintPos = dropHint?.id === id ? dropHint.pos : null;

  return (
    <>
      <div
        className={`hierarchy-row ${selected ? "selected" : ""} ${isDragging ? "row-dragging" : ""} ${
          hintPos === "on" ? "drop-target" : ""
        } ${hintPos === "before" ? "drop-before" : ""} ${hintPos === "after" ? "drop-after" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-entity-id={id}
        ref={assetDropRef}
        onClick={(e) => handleRowClick(e, id, rootIds, useSceneStore.getState().entities)}
        onDoubleClick={() => setRenamingId(id)}
        onContextMenu={(e) => onContextMenu(e, id)}
        onPointerDown={(e) => onRowPointerDown(e, id)}
      >
        {hasChildren ? (
          <button className={`row-disclosure ${collapsed ? "collapsed" : ""}`} onClick={toggleCollapsed}>
            <ChevronRight size={12} strokeWidth={2} />
          </button>
        ) : (
          <span className="row-disclosure-spacer" />
        )}
        {renamingId === id ? (
          <input
            className="rename-input"
            autoFocus
            defaultValue={entity.name}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(e.target.value);
              if (e.key === "Escape") setRenamingId(null);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <EntityIcon components={entity.components} />
            <span className={`entity-name ${prefab.kind ? `prefab-${prefab.kind}` : ""}`}>{entity.name}</span>
            {prefab.kind === "root" && (
              <span
                className={`prefab-badge ${prefab.dirty ? "dirty" : ""} ${prefab.missing ? "missing" : ""}`}
                title={
                  prefab.missing
                    ? "Prefab asset is missing"
                    : `Prefab instance: ${prefab.name}${prefab.dirty ? " (modified)" : ""} — double-click to open`
                }
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (prefab.path) openPrefabMode(prefab.path);
                }}
              >
                <Package size={11} />
                {prefab.dirty && <span className="prefab-dot" />}
              </span>
            )}
          </>
        )}
        <VisibilityIcons id={id} />
      </div>
      {!collapsed &&
        entity.childIds.map((childId) => (
          <EntityRow
            key={childId}
            id={childId}
            depth={depth + 1}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            dropHint={dropHint}
            setDropHint={setDropHint}
            onContextMenu={onContextMenu}
            rootIds={rootIds}
            collapsedIds={collapsedIds}
            setCollapsedIds={setCollapsedIds}
            draggingIds={draggingIds}
            onRowPointerDown={onRowPointerDown}
          />
        ))}
    </>
  );
}

/**
 * The prefab half of the row context menu. What's on offer depends on whether
 * the row is a prefab instance (apply / revert / unpack / open) or a plain
 * entity (create a prefab out of it).
 */
function prefabMenuItems(single) {
  if (!single) return [];
  const live = engine.getEntity(single);
  if (!live) return [];
  const root = getPrefabRoot(live);

  if (!root) {
    return [{ separator: true }, { label: "Create Prefab…", action: () => createPrefabFromEntity(single) }];
  }

  // Apply/Revert always act on the instance root, even when the click was on a
  // child inside it — that's the object that owns the overrides.
  const rootId = root.id;
  const dirty = diffInstance(root).length > 0;
  const assetPath = root.prefab ? prefabRegistry.pathOf(prefabRegistry.resolveLink(root.prefab)) : null;

  return [
    { separator: true },
    { label: "Open Prefab", disabled: !assetPath, action: () => openPrefabMode(assetPath) },
    { label: "Select Prefab Asset", disabled: !assetPath, action: () => useSelectionStore.getState().selectAsset(assetPath) },
    { label: "Apply All", disabled: !dirty, action: () => applyPrefab(rootId) },
    { label: "Revert All", disabled: !dirty, action: () => revertPrefab(rootId) },
    { label: "Create Prefab Variant…", action: () => createVariantFromInstance(rootId) },
    { label: "Unpack Prefab", action: () => unpackPrefab(rootId, { deep: false }) },
    { label: "Unpack Completely", action: () => unpackPrefab(rootId, { deep: true }) },
  ];
}

function ContextMenu({ menu, close, setRenamingId }) {
  const selection = useSelectionStore.getState().ids;
  const single = selection.length === 1 ? selection[0] : null;
  const canPaste = clipboardHasEntities();

  const items = [
    { label: "Copy", shortcut: "Ctrl+C", action: () => copyEntities(selection) },
    { label: "Cut", shortcut: "Ctrl+X", action: () => cutEntities(selection) },
    {
      label: "Paste",
      shortcut: "Ctrl+V",
      disabled: !canPaste,
      action: () => pasteEntities(single ? useSceneStore.getState().entities[single]?.parentId : null),
    },
    { label: "Paste as Child", disabled: !canPaste || !single, action: () => pasteEntities(single) },
    { separator: true },
    { label: "Duplicate", shortcut: "Ctrl+D", action: duplicateSelection },
    { label: "Rename", disabled: !single, action: () => setRenamingId(single) },
    ...prefabMenuItems(single),
    { separator: true },
    { label: "Delete", shortcut: "Del", action: deleteSelection },
  ];

  return (
    <>
      <div className="dropdown-overlay" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
      <div className="dropdown-menu context-menu" style={{ left: menu.x, top: menu.y }}>
        {items.map((item, i) =>
          item.separator ? (
            <div key={i} className="menu-separator" />
          ) : (
            <button
              key={item.label}
              className="dropdown-item"
              disabled={item.disabled}
              onClick={() => {
                close();
                item.action();
              }}
            >
              <span>{item.label}</span>
              {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
            </button>
          ),
        )}
      </div>
    </>
  );
}

export function HierarchyPanel() {
  const rootIds = useSceneStore((s) => s.rootIds);
  const sceneName = useSceneStore((s) => s.sceneName);
  const dirty = useSceneStore((s) => s.dirty);
  const selection = useSelectionStore((s) => s.ids);
  const terrainEnabled = useModulesStore((s) => s.enabled.includes("terrain"));
  const stage = usePrefabStore((s) => s.stage);
  const stageDirty = usePrefabStore((s) => s.stageDirty);
  const [renamingId, setRenamingId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropHint, setDropHint] = useState(null);
  const [contextMenu, setContextMenu] = useState(null); // {x, y}
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const [draggingIds, setDraggingIds] = useState([]);
  const [ghostPos, setGhostPos] = useState(null); // {x, y}

  // Assets dropped on empty tree space spawn at the scene root.
  const treeAssetDropRef = useAssetDrop({
    accepts: DROPPABLE_ASSET_EXTENSIONS,
    onDrop: (path) => dropAssetOnEntity(path, null),
  });

  // Manual pointer-driven drag (see the DRAG_THRESHOLD_PX comment above):
  // pointerdown on a row arms a session; once the pointer moves past the
  // threshold it becomes an active drag, hit-tested purely via the DOM
  // (elementFromPoint) since HTML5 DnD events don't reach us in Tauri.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
    if (isFollowPickArmed()) disarmFollowPick();
    else if (isSurfacePickArmed()) disarmSurfacePick();
    else if (isListenerPickArmed()) disarmListenerPick();
    else if (getTerrainScatterSourcePick()) disarmTerrainScatterSourcePick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragSession) return;
      if (!dragSession.moved) {
        const dx = e.clientX - dragSession.startX;
        const dy = e.clientY - dragSession.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        dragSession.moved = true;
        const sel = useSelectionStore.getState().ids;
        dragSession.ids = sel.includes(dragSession.sourceId) ? [...sel] : [dragSession.sourceId];
        setDraggingIds(dragSession.ids);
      }
      setGhostPos({ x: e.clientX, y: e.clientY });

      const hit = hitTestRow(e.clientX, e.clientY);
      if (!hit || hit.id === null || dragSession.ids.includes(hit.id)) {
        setDropHint(null);
        clearHoverExpand();
        return;
      }
      setDropHint((cur) => (cur?.id === hit.id && cur.pos === hit.pos ? cur : { id: hit.id, pos: hit.pos }));

      const entities = useSceneStore.getState().entities;
      const hasChildren = (entities[hit.id]?.childIds.length ?? 0) > 0;
      if (hit.pos === "on" && hasChildren) {
        if (hoverExpandId !== hit.id) {
          clearHoverExpand();
          hoverExpandId = hit.id;
          hoverExpandTimer = setTimeout(() => {
            setCollapsedIds((prev) => {
              if (!prev.has(hit.id)) return prev;
              const next = new Set(prev);
              next.delete(hit.id);
              return next;
            });
            clearHoverExpand();
          }, HOVER_EXPAND_MS);
        }
      } else if (hoverExpandId) {
        clearHoverExpand();
      }
    };

    const onUp = (e) => {
      if (!dragSession) return;
      if (dragSession.moved) {
        suppressNextClick = true;
        setTimeout(() => (suppressNextClick = false), 300);
        const hit = hitTestRow(e.clientX, e.clientY);
        if (hit && !dragSession.ids.includes(hit.id)) {
          if (hit.id === null) performDropToRoot(dragSession.ids);
          else performDrop(dragSession.ids, hit.id, hit.pos);
        }
      }
      dragSession = null;
      clearHoverExpand();
      setDraggingIds([]);
      setDropHint(null);
      setGhostPos(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragSession = null;
      clearHoverExpand();
    };
  }, []);

  const onRowPointerDown = (e, id) => {
    if (e.button !== 0 || renamingId === id) return;
    if (e.target.closest("button, input")) return;
    dragSession = { ids: null, sourceId: id, startX: e.clientX, startY: e.clientY, moved: false };
  };

  const createEntity = (spec) => {
    setMenuOpen(false);
    const selected = useSelectionStore.getState().ids;
    const parentId = selected.length === 1 ? selected[0] : null;
    const cmd = new CreateEntityCommand(parentId ? { ...spec, parentId } : spec);
    commandBus.execute(cmd);
    useSelectionStore.getState().select(cmd.entityId);
    if (parentId) {
      setCollapsedIds((prev) => {
        if (!prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
    }
  };

  /** Creates and opens a fresh scene. Reuses sceneIO.newScene so the new
   *  scene follows the same path it does from File → New Scene (baseline
   *  content + autosave when a project is open). Errors are logged there. */
  const createScene = () => {
    setMenuOpen(false);
    newScene().catch((err) => console.warn(`Couldn't create new scene: ${err}`));
  };

  const onRowContextMenu = (e, id) => {
    e.preventDefault();
    e.stopPropagation();
    if (!useSelectionStore.getState().ids.includes(id)) {
      useSelectionStore.getState().select(id);
    }
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div className="hierarchy-panel">
      {stage && (
        <div className="prefab-stage-bar" title="You are editing a prefab in isolation — the scene is set aside">
          <button
            className="prefab-stage-back"
            onClick={() => exitPrefabMode({ save: true }).catch((err) => console.error(String(err)))}
          >
            <ChevronRight size={12} className="prefab-stage-chevron" />
            Scenes
          </button>
          <span className="prefab-stage-name">
            <Package size={12} />
            {stage.name}
            {stageDirty && <span className="prefab-dot" />}
          </span>
        </div>
      )}
      <div className="panel-toolbar">
        <div className="dropdown-wrap">
          <button className="toolbar-btn" onClick={() => setMenuOpen((v) => !v)}> <Plus size={14} /> </button>
          {menuOpen && (
            <>
              <div className="dropdown-overlay" onClick={() => setMenuOpen(false)} />
              <div className="dropdown-menu">
                <div className="dropdown-section-label">Scene</div>
                <button key="New Scene" className="dropdown-item" onClick={createScene}>
                  New Scene
                </button>
                <div className="dropdown-section-label">Entity</div>
                {COMMON_PRESETS.map((p) => (
                  <button key={p.label} className="dropdown-item" onClick={() => createEntity(p.spec)}>
                    {p.label}
                  </button>
                ))}
                {terrainEnabled && (
                  <button
                    key={TERRAIN_PRESET.label}
                    className="dropdown-item"
                    onClick={() => createEntity(TERRAIN_PRESET.spec)}
                  >
                    {TERRAIN_PRESET.label}
                  </button>
                )}
                <div className="dropdown-section-label">UI</div>
                <button
                  key={UI_SCREEN_PRESET.label}
                  className="dropdown-item"
                  onClick={() => createEntity(UI_SCREEN_PRESET.spec)}
                >
                  {UI_SCREEN_PRESET.label}
                </button>
                {isParentUiScreen(useSelectionStore.getState().ids[0] ?? null) &&
                  UI_ELEMENT_PRESETS.map((p) => (
                    <button key={p.label} className="dropdown-item" onClick={() => createEntity(p.spec)}>
                      {p.label}
                    </button>
                  ))}
              </div>
            </>
          )}
        </div>
        <button
          className="toolbar-btn icon-only"
          title="Delete selection (Del)"
          disabled={!selection.length}
          onClick={deleteSelection}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="scene-label">
        {sceneName}
        {dirty ? " •" : ""}
      </div>
      <div
        className={`hierarchy-tree ${isFollowPickArmed() || getTerrainScatterSourcePick() ? "follow-pick-armed" : ""}`}
        ref={treeAssetDropRef}
        onClick={(e) => {
          if (isFollowPickArmed()) {
            // A click on a row already handled the pick via handleRowClick;
            // only react here for clicks on the empty tree area to disarm.
            if (e.target === e.currentTarget) disarmFollowPick();
            return;
          }
          if (getTerrainScatterSourcePick()) {
            if (e.target === e.currentTarget) disarmTerrainScatterSourcePick();
            return;
          }
          if (e.target === e.currentTarget) useSelectionStore.getState().clear();
        }}
      >
        {rootIds.map((id) => (
          <EntityRow
            key={id}
            id={id}
            depth={0}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            dropHint={dropHint}
            setDropHint={setDropHint}
            onContextMenu={onRowContextMenu}
            rootIds={rootIds}
            collapsedIds={collapsedIds}
            setCollapsedIds={setCollapsedIds}
            draggingIds={draggingIds}
            onRowPointerDown={onRowPointerDown}
          />
        ))}
      </div>
      {contextMenu && (
        <ContextMenu menu={contextMenu} close={() => setContextMenu(null)} setRenamingId={setRenamingId} />
      )}
      {ghostPos && draggingIds.length > 0 && (
        <div className="hierarchy-drag-ghost" style={{ left: ghostPos.x, top: ghostPos.y }}>
          {draggingIds.length === 1
            ? (useSceneStore.getState().entities[draggingIds[0]]?.name ?? "Entity")
            : `${draggingIds.length} entities`}
        </div>
      )}
    </div>
  );
}
