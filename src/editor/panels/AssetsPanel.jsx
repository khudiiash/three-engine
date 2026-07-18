import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Box,
  Braces,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid2x2,
  Grid3x3,
  Image,
  Layers,
  LayoutGrid,
  List,
  Package,
  Palette,
  PanelLeft,
  Shapes,
  Trash2,
  Workflow,
} from "lucide-react";
import { useProjectStore, basename } from "../store/projectStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useAssetProcessingStore } from "../store/assetProcessingStore.js";
import {
  extOf,
  toBlobUrl,
  readAssetMeta,
  MODEL_EXTENSIONS,
  MODEL_IMPORT_EXTENSIONS,
  TEXTURE_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  MATERIAL_EXTENSIONS,
  PREFAB_EXTENSIONS,
  ANIMATOR_EXTENSIONS,
  GEOMETRY_EXTENSIONS,
} from "../assetLoader.js";
import { MATERIAL_DEFAULTS } from "../../engine/materialAsset.js";
import { openScenePath } from "../sceneIO.js";
import { openPrefabMode } from "../prefab.js";
import { armAssetDrag, useAssetDrop, consumeAssetDragClick } from "../assetDrag.js";
import { stemToClassName } from "../scriptClassSync.js";
import { scaffoldProjectTypes } from "../projectTypes.js";
import { FolderTree } from "../components/FolderTree.jsx";
import { clickSelect, pathsInBox } from "../assetSelection.js";
import {
  invoke,
  uniqueName,
  createAssetFile,
  createFolder,
  deleteEntries,
  renameEntry,
  moveDraggedIntoFolder,
  formatBytes,
  formatDate,
} from "../assetOps.js";

const ICON_BY_EXT = {
  glb: Box,
  gltf: Box,
  fbx: Box,
  scene: Layers,
  json: Braces,
  js: FileCode2,
  ts: FileCode2,
  mat: Palette,
  png: Image,
  jpg: Image,
  jpeg: Image,
  webp: Image,
  prefab: Package,
  entity: Package, // legacy prefab snapshots
  anim: Workflow,
  geom: Shapes,
};

const TYPE_LABEL = {
  glb: "Model",
  gltf: "Model",
  fbx: "FBX source",
  scene: "Scene",
  json: "JSON",
  js: "Script",
  ts: "Script",
  mat: "Material",
  png: "Texture",
  jpg: "Texture",
  jpeg: "Texture",
  webp: "Texture",
  entity: "Prefab",
  anim: "Animator",
  geom: "Geometry",
};

/**
 * Grid density / detail presets, mirroring Explorer's view menu. `thumb` is the
 * preview size in px; the details view lays entries out as rows with metadata
 * columns instead of tiles.
 */
const VIEW_MODES = [
  { id: "details", title: "Details", Icon: List, thumb: 18 },
  { id: "small", title: "Small icons", Icon: Grid3x3, thumb: 24 },
  { id: "medium", title: "Medium icons", Icon: Grid2x2, thumb: 40 },
  { id: "large", title: "Large icons", Icon: LayoutGrid, thumb: 72 },
];

const VIEW_KEY = "engine.assets.viewMode.v1";
const TREE_KEY = "engine.assets.showTree.v1";

/** Template with a placeholder for the class name; filled in by createScript(). */
const SCRIPT_TEMPLATE = (className) => `import { Script, attribute } from "engine";

// this.entity, this.engine, this.THREE and this.input are injected before
// any hook runs. Extending Script gives them full TypeScript autocomplete.
export default class ${className} extends Script {
  @attribute({ type: "number", default: 1, min: 0, max: 10, step: 0.1 })
  speed = 1;

  onStart() {}

  onUpdate(dt) {}

  onDestroy() {}

  // Optional: called instead of onStart when the file is hot-reloaded while
  // playing. Copy state from the previous instance to continue seamlessly.
  // onHotReload(oldInstance) { Object.assign(this, oldInstance); }
}
`;

const createScript = () => {
  const { entries } = useProjectStore.getState();
  // Reserve a unique filename first so we can derive a matching class name
  // (the filename's stem drives the class name on disk + in autocomplete).
  const baseStem = "NewScript";
  const baseName = `${baseStem}.ts`;
  const finalName = uniqueName(baseName, entries);
  const stem = finalName.replace(/\.(ts|js)$/i, "");
  const className = stemToClassName(stem);
  return createAssetFile(baseName, SCRIPT_TEMPLATE(className));
};
const createMaterial = () =>
  createAssetFile("NewMaterial.mat", JSON.stringify(MATERIAL_DEFAULTS, null, 2));

const ANIMATOR_TEMPLATE = {
  version: 1,
  parameters: [],
  states: [{ id: "state-idle", name: "Idle", clip: "", speed: 1, loop: true, x: 260, y: 140 }],
  entry: "state-idle",
  transitions: [],
};
const createAnimator = () =>
  createAssetFile("NewAnimator.anim", JSON.stringify(ANIMATOR_TEMPLATE, null, 2));

/** Opens the file in the OS-default editor for its type. */
async function openInIDE(path) {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  } catch (err) {
    console.error(`Failed to open "${path}": ${err}`);
  }
}

/** Texture image thumbnail (blob URL over Tauri fs). */
function TextureThumb({ path, size }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    toBlobUrl(path).then((u) => live && setUrl(u)).catch(() => {});
    return () => (live = false);
  }, [path]);
  if (!url)
    return (
      <div className="asset-icon" style={{ width: size, height: size }}>
        <Image size={size * 0.65} strokeWidth={1.5} />
      </div>
    );
  return (
    <img
      className="asset-thumb"
      style={{ width: size, height: size }}
      src={url}
      alt=""
      draggable={false}
    />
  );
}

// Plain white on a swatch is the classic "I haven't set a color yet" signal —
// a freshly-created .mat file is white by default and looks identical to a mesh
// that has no material assigned at all. Flag it so the user can tell the
// difference at a glance.
const isUnsetColor = (color) => !color || color.toLowerCase() === "#ffffff" || color.toLowerCase() === "white";

/** Material preview: color swatch, with its texture blended in when set.
 *  Reads the live shared material first (via getMaterialColorPreview) so the
 *  swatch reflects what the mesh actually renders — including edits made in
 *  the Shader Graph panel that haven't been autosaved yet, and pre-existing
 *  .mat files whose top-level `color` field is stale. Falls back to the
 *  top-level `def.color` only when no live material is loaded. */
function MaterialThumb({ path, size }) {
  const [def, setDef] = useState(null);
  const [mapUrl, setMapUrl] = useState(null);
  const [liveColor, setLiveColor] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const d = { ...MATERIAL_DEFAULTS, ...JSON.parse(await invoke("read_text_file", { path })) };
        if (!live) return;
        setDef(d);
        if (d.map) setMapUrl(await toBlobUrl(d.map).catch(() => null));
      } catch {
        if (live) setDef((prev) => prev ?? { ...MATERIAL_DEFAULTS, color: "#888" });
      }
    })();
    // Subscribe to live material updates so the swatch refreshes as soon as
    // the shared material instance finishes its async compile / ShaderGraph
    // edit. Resolves to `null` until the compile lands.
    let unsub = () => {};
    import("../../engine/materialAsset.js").then(({ getMaterialColorPreview, loadMaterialAsset, subscribeMaterial }) => {
      if (!live) return;
      // Make sure the cache has an entry — the swatch may mount before any
      // mesh has loaded this .mat, and the live-color walk needs an entry.
      loadMaterialAsset(path).then(() => {
        if (!live) return;
        const refresh = () => {
          if (live) setLiveColor(getMaterialColorPreview(path));
        };
        refresh();
        unsub = subscribeMaterial(path, refresh);
      });
    });
    return () => {
      live = false;
      unsub();
    };
  }, [path]);
  // Live color wins over the stale top-level field — that's the whole point.
  const color = liveColor ?? def?.color;
  const unset = isUnsetColor(color);
  return (
    <div
      className={`asset-thumb mat-thumb${unset ? " mat-thumb--unset" : ""}`}
      style={{ width: size, height: size, background: color ?? "#888" }}
      title={unset ? "Default color — open in the Shader Graph panel to set a real color" : undefined}
    >
      {mapUrl && <img className="mat-thumb-map" src={mapUrl} alt="" draggable={false} />}
    </div>
  );
}

function Thumb({ entry, size }) {
  if (entry.is_dir)
    return (
      <div className="asset-icon dir-icon" style={{ width: size, height: size }}>
        <Folder size={size * 0.72} strokeWidth={1.5} />
      </div>
    );
  if (TEXTURE_EXTENSIONS.includes(entry.ext)) return <TextureThumb path={entry.path} size={size} />;
  if (entry.ext === "mat") return <MaterialThumb path={entry.path} size={size} />;
  const Icon = ICON_BY_EXT[entry.ext] ?? File;
  return (
    <div className="asset-icon" style={{ width: size, height: size }}>
      <Icon size={size * 0.65} strokeWidth={1.5} />
    </div>
  );
}

/** Corner badge on a model tile showing how much Draco compression saved. */
function DracoBadge({ path }) {
  const [pct, setPct] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const meta = await readAssetMeta(`${path}.meta`);
      const d = meta?.draco;
      if (!alive || !d?.original || !d?.compressed) return;
      const saved = 1 - d.compressed / d.original;
      setPct(saved > 0.005 ? Math.round(saved * 100) : 0);
    })();
    return () => {
      alive = false;
    };
  }, [path]);
  if (pct == null) return null;
  return (
    <div className="asset-badge draco-badge" title={`Draco compressed · ${pct}% smaller`}>
      −{pct}%
    </div>
  );
}

const DRAGGABLE_EXTENSIONS = [
  ...MODEL_EXTENSIONS,
  ...TEXTURE_EXTENSIONS,
  ...SCRIPT_EXTENSIONS,
  ...MATERIAL_EXTENSIONS,
  ...PREFAB_EXTENSIONS,
  ...ANIMATOR_EXTENSIONS,
  ...GEOMETRY_EXTENSIONS,
];

function openEntry(entry) {
  if (entry.is_dir) {
    useProjectStore.getState().navigate(entry.path);
  } else if (SCRIPT_EXTENSIONS.includes(entry.ext)) {
    openInIDE(entry.path);
  } else if (entry.ext === "scene") {
    openScenePath(entry.path).catch((err) => console.error(String(err)));
  } else if (PREFAB_EXTENSIONS.includes(entry.ext)) {
    // Double-click opens the prefab in isolation, like Unity's Prefab Mode.
    openPrefabMode(entry.path).catch((err) => console.error(String(err)));
  } else if (ANIMATOR_EXTENSIONS.includes(entry.ext)) {
    useSelectionStore.getState().selectAsset(entry.path);
    import("../EditorShell.jsx").then((m) => m.openPanel("animator"));
  } else if (MATERIAL_EXTENSIONS.includes(entry.ext)) {
    // A material *is* its shader graph — that's the only editor for it.
    useSelectionStore.getState().selectAsset(entry.path);
    import("../EditorShell.jsx").then((m) => m.openPanel("shaderGraph"));
  } else if (GEOMETRY_EXTENSIONS.includes(entry.ext)) {
    openGeometryAsset(entry.path);
  }
}

/**
 * The Geometry Editor edits a live mesh on an entity, not a file — so opening a
 * .geom means finding an entity that uses it and editing that. Selecting the
 * asset itself would leave the editor with nothing to act on.
 */
function openGeometryAsset(path) {
  const key = (p) => String(p ?? "").replaceAll("\\", "/");
  const entities = useSceneStore.getState().entities;
  const match = Object.values(entities).find(
    (entity) => key(entity?.components?.mesh?.geometryAsset) === key(path),
  );
  if (!match) {
    console.warn(
      `No entity in the scene uses "${basename(path)}" — ` +
        `drag it onto an entity's Mesh (or into the scene) to edit it.`,
    );
    return;
  }
  useSelectionStore.getState().select(match.id);
  import("../EditorShell.jsx").then((m) => m.openPanel("geometryEditor"));
}

function RenameInput({ entry, setRenamingPath }) {
  const commit = (value) => {
    setRenamingPath(null);
    renameEntry(entry, value);
  };
  return (
    <input
      className="rename-input asset-rename"
      autoFocus
      defaultValue={entry.name}
      onFocus={(e) => e.target.select()}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.target.value);
        if (e.key === "Escape") setRenamingPath(null);
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

function AssetItem({ entry, view, visible, renaming, setRenamingPath, onContextMenu }) {
  const draggable = entry.is_dir || DRAGGABLE_EXTENSIONS.includes(entry.ext);
  const selected = useSelectionStore((s) => s.assetPaths.includes(entry.path));
  const details = view.id === "details";

  // Folders accept asset drops (move into folder).
  const dropRef = useAssetDrop({
    accepts: (path) => path !== entry.path,
    hoverClass: "drop-target",
    onDrop: (path) => moveDraggedIntoFolder(path, entry.path),
  });

  const handlers = {
    "data-asset-path": entry.path,
    ref: entry.is_dir ? dropRef : undefined,
    onPointerDown: (e) => {
      // Selecting on pointerdown (not click) so a drag that starts on an
      // unselected tile carries that tile, and a drag on a multi-selection
      // keeps it intact.
      if (renaming || e.target.closest("input") || e.button !== 0) return;
      const sel = useSelectionStore.getState();
      const inSelection = sel.assetPaths.includes(entry.path);
      if (!inSelection || e.shiftKey || e.ctrlKey || e.metaKey) clickSelect(e, entry, visible);
      if (draggable) armAssetDrag(e, entry.path, { isDir: entry.is_dir });
    },
    onClick: (e) => {
      if (consumeAssetDragClick()) return;
      // A plain click on an already-multi-selected tile collapses the
      // selection to it (Explorer behaviour) — pointerdown left it alone so
      // the drag could carry the whole set.
      const sel = useSelectionStore.getState();
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && sel.assetPaths.length > 1) {
        sel.selectAsset(entry.path);
      }
    },
    onDoubleClick: () => openEntry(entry),
    onContextMenu: (e) => onContextMenu(e, entry),
    title: entry.name,
  };

  if (details) {
    return (
      <div className={`asset-row ${selected ? "selected" : ""}`} {...handlers}>
        <div className="asset-row-name">
          <Thumb entry={entry} size={view.thumb} />
          {renaming ? (
            <RenameInput entry={entry} setRenamingPath={setRenamingPath} />
          ) : (
            <span className="asset-row-label">{entry.name}</span>
          )}
        </div>
        <div className="asset-col">{entry.is_dir ? "Folder" : (TYPE_LABEL[entry.ext] ?? entry.ext.toUpperCase())}</div>
        <div className="asset-col">{entry.is_dir ? "—" : formatBytes(entry.size)}</div>
        <div className="asset-col">{formatDate(entry.modified)}</div>
      </div>
    );
  }

  return (
    <div
      className={`asset-tile ${entry.is_dir ? "dir" : ""} ${selected ? "selected" : ""}`}
      {...handlers}
    >
      <Thumb entry={entry} size={view.thumb} />
      {entry.ext === "glb" && <DracoBadge path={entry.path} />}
      {renaming ? (
        <RenameInput entry={entry} setRenamingPath={setRenamingPath} />
      ) : (
        <div className="asset-name">{entry.name}</div>
      )}
    </div>
  );
}

function AssetContextMenu({ menu, close, setRenamingPath, selectedEntries }) {
  const entry = menu.entry;
  // Right-clicking inside a multi-selection acts on the whole set.
  const multi = entry && selectedEntries.length > 1 && selectedEntries.some((s) => s.path === entry.path);
  const targets = multi ? selectedEntries : entry ? [entry] : [];

  const items = entry
    ? [
        ...(multi
          ? []
          : [{ label: "Rename", action: () => setRenamingPath(entry.path) }]),
        { label: multi ? `Delete ${targets.length} items` : "Delete", action: () => deleteEntries(targets) },
        ...(!multi && MODEL_IMPORT_EXTENSIONS.includes(entry.ext)
          ? [
              { label: "Unpack Model", action: () => unpackModel(entry.path) },
              ...(entry.ext === "glb"
                ? [{ label: "Compress (Draco)", action: () => compressModel(entry.path) }]
                : []),
            ]
          : []),
        ...(!multi && !entry.is_dir
          ? [{ label: "Open in Default App", action: () => openInIDE(entry.path) }]
          : []),
      ]
    : [
        { label: "New Folder", action: createFolder },
        { label: "New Script", action: createScript },
        { label: "New Material", action: createMaterial },
        { label: "New Animator", action: createAnimator },
        { label: "Refresh", action: () => useProjectStore.getState().refresh() },
      ];

  return (
    <>
      <div className="dropdown-overlay" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
      <div className="dropdown-menu context-menu" style={{ left: menu.x, top: menu.y }}>
        {items.map((item) => (
          <button
            key={item.label}
            className="dropdown-item"
            onClick={() => {
              close();
              item.action();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

/** Copies OS-dropped files into the folder currently open in the panel. */
async function importDroppedPaths(paths) {
  const { currentPath, refresh } = useProjectStore.getState();
  if (!currentPath || !paths?.length) return;
  const track = useAssetProcessingStore.getState().track;
  await track(
    (n) => `Importing ${n} ${n === 1 ? "asset" : "assets"}…`,
    async () => {
      try {
        const imported = await invoke("import_files", { paths, destDir: currentPath });
        await refresh();
        console.log(`Imported ${imported.length} ${imported.length === 1 ? "asset" : "assets"}`);
        // Imported models unpack into an asset folder (textures/materials/prefab).
        for (const path of imported) {
          if (MODEL_IMPORT_EXTENSIONS.includes(extOf(path))) await unpackModel(path);
          if (TEXTURE_EXTENSIONS.includes(extOf(path))) {
            const { autoCompressTexture } = await import("../basisCompress.js");
            await autoCompressTexture(path).catch((err) =>
              console.warn(`Basis compression skipped for ${basename(path)}: ${err.message ?? err}`),
            );
          }
        }
      } catch (err) {
        console.error(`Import failed: ${err}`);
      }
    },
    paths.length,
  );
}

async function unpackModel(path) {
  try {
    if (extOf(path) === "fbx") {
      const { unpackFbx } = await import("../fbxImport.js");
      await unpackFbx(path);
    } else {
      const { unpackGlb } = await import("../glbImport.js");
      await unpackGlb(path);
    }
  } catch (err) {
    console.error(`Unpack failed for ${basename(path)}: ${err.message ?? err}`);
  }
}

/** Manually Draco-compresses a .glb in place (context menu). */
async function compressModel(path) {
  try {
    const { compressGlbInPlace, formatBytes: fmt } = await import("../dracoCompress.js");
    const info = await compressGlbInPlace(path);
    if (info == null) {
      console.log(`${basename(path)} is already Draco-compressed`);
    } else if (info.compressed < info.original) {
      const pct = Math.round((1 - info.compressed / info.original) * 100);
      console.log(`Draco: ${basename(path)} −${pct}% (${fmt(info.original)} → ${fmt(info.compressed)})`);
    } else {
      console.log(`Draco: ${basename(path)} already minimal — left uncompressed`);
    }
    await useProjectStore.getState().refresh();
  } catch (err) {
    console.error(`Compression failed for ${basename(path)}: ${err.message ?? err}`);
  }
}

/**
 * Rubber-band selection over the asset grid. Returns the marquee rectangle to
 * draw (in grid-content coordinates) plus the pointerdown handler that starts
 * a drag. Tiles are hit-tested through their `data-asset-path` attribute, so
 * this works identically for the tile grid and the details rows.
 */
function useBoxSelect(gridRef) {
  const [box, setBox] = useState(null); // {left, top, width, height} in content coords

  const onPointerDown = (e) => {
    const grid = gridRef.current;
    if (!grid || e.button !== 0) return;
    // Only empty space starts a marquee — tiles handle their own pointerdown.
    if (e.target.closest("[data-asset-path]")) return;

    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? useSelectionStore.getState().assetPaths : [];
    if (!additive) useSelectionStore.getState().clear();

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const onMove = (ev) => {
      const rect = grid.getBoundingClientRect();
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        dragging = true;
      }
      const view = {
        left: Math.min(startX, ev.clientX),
        right: Math.max(startX, ev.clientX),
        top: Math.min(startY, ev.clientY),
        bottom: Math.max(startY, ev.clientY),
      };
      const hits = pathsInBox(
        view,
        [...grid.querySelectorAll("[data-asset-path]")].map((el) => [
          el.dataset.assetPath,
          el.getBoundingClientRect(),
        ]),
      );
      useSelectionStore.getState().selectAssets([...base, ...hits], { anchor: hits[0] ?? base[0] });

      setBox({
        left: view.left - rect.left + grid.scrollLeft,
        top: view.top - rect.top + grid.scrollTop,
        width: view.right - view.left,
        height: view.bottom - view.top,
      });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setBox(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return { box, onPointerDown };
}

export function AssetsPanel() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const currentPath = useProjectStore((s) => s.currentPath);
  const entries = useProjectStore((s) => s.entries);
  const loading = useProjectStore((s) => s.loading);
  const error = useProjectStore((s) => s.error);
  const assetPaths = useSelectionStore((s) => s.assetPaths);
  const [renamingPath, setRenamingPath] = useState(null);
  const [contextMenu, setContextMenu] = useState(null); // {x, y, entry|null}
  const [fileDropActive, setFileDropActive] = useState(false);
  const [viewId, setViewId] = useState(() => localStorage.getItem(VIEW_KEY) ?? "medium");
  const [showTree, setShowTree] = useState(() => localStorage.getItem(TREE_KEY) !== "0");
  const panelRef = useRef(null);
  const gridRef = useRef(null);

  const view = VIEW_MODES.find((v) => v.id === viewId) ?? VIEW_MODES[2];
  // Generated sidecars are managed through their source asset, not shown as tiles.
  const visible = useMemo(
    () => entries.filter((e) => !e.name.endsWith(".meta") && !e.name.endsWith(".basis")),
    [entries],
  );
  const selectedEntries = useMemo(
    () => visible.filter((e) => assetPaths.includes(e.path)),
    [visible, assetPaths],
  );

  const { box, onPointerDown: onGridPointerDown } = useBoxSelect(gridRef);

  const setView = (id) => {
    setViewId(id);
    localStorage.setItem(VIEW_KEY, id);
  };
  const toggleTree = () => {
    setShowTree((prev) => {
      localStorage.setItem(TREE_KEY, prev ? "0" : "1");
      return !prev;
    });
  };

  // Drop an asset on the "Up" button: move it into the parent folder.
  const upDropRef = useAssetDrop({
    accepts: () => currentPath !== rootPath,
    onDrop: (path) => {
      const parent = currentPath.replace(/[\\/][^\\/]+$/, "");
      moveDraggedIntoFolder(path, parent || rootPath);
    },
  });

  useEffect(() => {
    if (!rootPath) useProjectStore.getState().restoreLastFolder();
  }, [rootPath]);

  // Leaving a folder drops its selection — the paths aren't on screen any more.
  useEffect(() => {
    useSelectionStore.getState().clear();
    setRenamingPath(null);
  }, [currentPath]);

  // Ensure the engine's .d.ts files are present in the project root so the
  // user's IDE provides `this.entity` / `this.engine` autocomplete when they
  // open a script. Idempotent — only writes files that are missing or stale.
  // Runs on every Assets-panel mount so newly-opened projects (and ones
  // opened before the bootstrap was added) get up to date types.
  useEffect(() => {
    if (!rootPath) return;
    scaffoldProjectTypes(rootPath).catch((err) => {
      console.warn(`Could not scaffold engine types into ${rootPath}: ${err}`);
    });
  }, [rootPath]);

  // OS-file drag-drop import. Tauri intercepts native file drags (HTML5 drop
  // events never fire for them), so listen to the webview's drag-drop event
  // and hit-test its position against this panel.
  useEffect(() => {
    let unlisten = null;
    let disposed = false;

    const overPanel = (position) => {
      const el = panelRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const x = position.x / scale;
      const y = position.y / scale;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          const { type } = event.payload;
          if (type === "over") {
            setFileDropActive(overPanel(event.payload.position));
          } else if (type === "drop") {
            setFileDropActive(false);
            if (overPanel(event.payload.position)) importDroppedPaths(event.payload.paths);
          } else {
            setFileDropActive(false);
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch (err) {
        console.warn(`File-drop listener unavailable: ${err}`);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!rootPath) {
    return (
      <div className="assets-panel empty">
        <div>
          No project folder open.
          <br />
          <button className="toolbar-btn" onClick={() => useProjectStore.getState().openFolder()}>
            Open Folder…
          </button>
        </div>
      </div>
    );
  }

  const onTileContextMenu = (e, entry) => {
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking outside the selection reselects the clicked entry, so the
    // menu always acts on what's highlighted.
    if (entry && !useSelectionStore.getState().assetPaths.includes(entry.path)) {
      useSelectionStore.getState().selectAsset(entry.path);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // Grid keyboard shortcuts. The grid is focusable, so these only fire while
  // the Assets panel has focus and never steal Delete from the viewport.
  const onGridKeyDown = (e) => {
    if (e.target.closest("input")) return;
    const sel = useSelectionStore.getState();
    if (e.key === "Delete" && sel.assetPaths.length) {
      e.preventDefault();
      e.stopPropagation();
      deleteEntries(visible.filter((v) => sel.assetPaths.includes(v.path)));
    } else if (e.key === "F2" && sel.assetPath) {
      e.preventDefault();
      setRenamingPath(sel.assetPath);
    } else if (e.key === "Escape") {
      sel.clear();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      sel.selectAssets(visible.map((v) => v.path));
    }
  };

  return (
    <div className={`assets-panel ${fileDropActive ? "file-drop" : ""}`} ref={panelRef}>
      <div className="panel-toolbar">
        <button
          className={`toolbar-btn icon-only ${showTree ? "active" : ""}`}
          title="Toggle folder tree"
          onClick={toggleTree}
        >
          <PanelLeft size={14} />
        </button>
        <button
          className="toolbar-btn icon-only"
          title="Up one folder"
          disabled={currentPath === rootPath}
          onClick={() => useProjectStore.getState().goUp()}
          ref={upDropRef}
        >
          <ArrowUp size={14} />
        </button>
        <span className="asset-path" title={currentPath}>
          {currentPath === rootPath ? basename(rootPath) : currentPath?.slice(rootPath.length + 1)}
        </span>
        {selectedEntries.length > 0 && (
          <button
            className="toolbar-btn icon-only danger"
            title={
              selectedEntries.length === 1
                ? `Delete ${selectedEntries[0].name}`
                : `Delete ${selectedEntries.length} items`
            }
            onClick={() => deleteEntries(selectedEntries)}
          >
            <Trash2 size={14} />
          </button>
        )}
        <button className="toolbar-btn icon-only" title="New folder" onClick={createFolder}>
          <FolderPlus size={14} />
        </button>
        <button className="toolbar-btn icon-only" title="New script" onClick={createScript}>
          <FileCode2 size={14} />
        </button>
        <button className="toolbar-btn icon-only" title="New material" onClick={createMaterial}>
          <Palette size={14} />
        </button>
        <div className="view-mode-group">
          {VIEW_MODES.map(({ id, title, Icon }) => (
            <button
              key={id}
              className={`toolbar-btn icon-only ${viewId === id ? "active" : ""}`}
              title={title}
              onClick={() => setView(id)}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
        <button
          className="toolbar-btn icon-only"
          title="Open project folder…"
          onClick={() => useProjectStore.getState().openFolder()}
        >
          <FolderOpen size={14} />
        </button>
      </div>
      {error && <div className="asset-error">{error}</div>}
      <div className="assets-body">
        {showTree && (
          <div className="assets-sidebar">
            <FolderTree />
          </div>
        )}
        <div
          className={`asset-grid view-${view.id}`}
          ref={gridRef}
          tabIndex={0}
          onKeyDown={onGridKeyDown}
          onPointerDown={onGridPointerDown}
          onContextMenu={(e) => {
            e.preventDefault();
            useSelectionStore.getState().clear();
            setContextMenu({ x: e.clientX, y: e.clientY, entry: null });
          }}
        >
          {loading && <div className="asset-hint">Loading…</div>}
          {!loading && visible.length === 0 && <div className="asset-hint">Empty folder</div>}
          {view.id === "details" && visible.length > 0 && (
            <div className="asset-row header">
              <div className="asset-row-name">Name</div>
              <div className="asset-col">Type</div>
              <div className="asset-col">Size</div>
              <div className="asset-col">Modified</div>
            </div>
          )}
          {visible.map((entry) => (
            <AssetItem
              key={entry.path}
              entry={entry}
              view={view}
              visible={visible}
              renaming={renamingPath === entry.path}
              setRenamingPath={setRenamingPath}
              onContextMenu={onTileContextMenu}
            />
          ))}
          {box && (
            <div
              className="asset-marquee"
              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            />
          )}
        </div>
      </div>
      {contextMenu && (
        <AssetContextMenu
          menu={contextMenu}
          close={() => setContextMenu(null)}
          setRenamingPath={setRenamingPath}
          selectedEntries={selectedEntries}
        />
      )}
    </div>
  );
}
