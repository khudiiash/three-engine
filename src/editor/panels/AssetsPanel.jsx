import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Box,
  Braces,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  Image,
  Layers,
  Package,
  Palette,
  Workflow,
} from "lucide-react";
import { useProjectStore, basename } from "../store/projectStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import {
  extOf,
  toBlobUrl,
  readAssetMeta,
  MODEL_EXTENSIONS,
  TEXTURE_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  MATERIAL_EXTENSIONS,
  PREFAB_EXTENSIONS,
  ANIMATOR_EXTENSIONS,
} from "../assetLoader.js";
import { MATERIAL_DEFAULTS } from "../../engine/materialAsset.js";
import { openScenePath } from "../sceneIO.js";
import { armAssetDrag, useAssetDrop, consumeAssetDragClick } from "../assetDrag.js";
import { stemToClassName, syncScriptClassNameAfterRename } from "../scriptClassSync.js";
import { scaffoldProjectTypes } from "../projectTypes.js";

const ICON_BY_EXT = {
  glb: Box,
  gltf: Box,
  scene: Layers,
  json: Braces,
  js: FileCode2,
  ts: FileCode2,
  mat: Palette,
  png: Image,
  jpg: Image,
  jpeg: Image,
  webp: Image,
  entity: Package,
  anim: Workflow,
};

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** First "name", "name 1", "name 2"… not already taken in the folder. */
function uniqueName(baseName, entries) {
  const names = new Set(entries.map((e) => e.name));
  if (!names.has(baseName)) return baseName;
  const dot = baseName.lastIndexOf(".");
  const stem = dot === -1 ? baseName : baseName.slice(0, dot);
  const ext = dot === -1 ? "" : baseName.slice(dot);
  for (let i = 1; ; i++) {
    const name = `${stem} ${i}${ext}`;
    if (!names.has(name)) return name;
  }
}

async function createAssetFile(baseName, contents) {
  const { currentPath, entries, refresh } = useProjectStore.getState();
  if (!currentPath) return;
  const name = uniqueName(baseName, entries);
  await invoke("save_scene", { path: `${currentPath}/${name}`, contents });
  await refresh();
  console.log(`Created ${name}`);
}

async function createFolder() {
  const { currentPath, entries, refresh } = useProjectStore.getState();
  if (!currentPath) return;
  const name = uniqueName("New Folder", entries);
  await invoke("create_dir", { path: `${currentPath}/${name}` });
  await refresh();
}

async function deleteEntry(entry) {
  const { confirm } = await import("@tauri-apps/plugin-dialog");
  const ok = await confirm(
    `Delete "${entry.name}"${entry.is_dir ? " and everything inside it" : ""}? This can't be undone.`,
    { title: "Delete asset", kind: "warning" },
  );
  if (!ok) return;
  try {
    await invoke("delete_path", { path: entry.path });
    await invoke("delete_path", { path: `${entry.path}.meta` }).catch(() => {});
    if (useSelectionStore.getState().assetPath === entry.path) useSelectionStore.getState().clear();
    await useProjectStore.getState().refresh();
    console.log(`Deleted ${entry.name}`);
  } catch (err) {
    console.error(`Delete failed: ${err}`);
  }
}

async function renameEntry(entry, newName) {
  const name = newName.trim();
  if (!name || name === entry.name) return;
  const dir = entry.path.slice(0, entry.path.length - entry.name.length);
  const newPath = `${dir}${name}`;
  try {
    await invoke("rename_path", { from: entry.path, to: newPath });
    // Keep texture import settings attached across the rename.
    await invoke("rename_path", { from: `${entry.path}.meta`, to: `${newPath}.meta` }).catch(() => {});

    // Scripts: rewrite the default-exported class name to match the new
    // filename stem, and inject `extends Script` if the script predates the
    // engine base class.
    const newStem = name.replace(/\.(ts|js)$/i, "");
    await syncScriptClassNameAfterRename(newPath, newStem);

    await useProjectStore.getState().refresh();
  } catch (err) {
    console.error(`Rename failed: ${err}`);
  }
}

/** Moves a file/folder into a target directory (drag-drop between tiles). */
async function moveIntoFolder(sourcePath, destDir) {
  if (!sourcePath || sourcePath === destDir) return;
  const name = sourcePath.split(/[\\/]/).pop();
  const dest = `${destDir}/${name}`;
  if (dest === sourcePath) return;
  // Refuse moving a folder into itself/descendant.
  const norm = (p) => p.replaceAll("\\", "/").toLowerCase();
  if (norm(destDir).startsWith(`${norm(sourcePath)}/`)) return;
  try {
    await invoke("rename_path", { from: sourcePath, to: dest });
    await useProjectStore.getState().refresh();
    console.log(`Moved ${name}`);
  } catch (err) {
    console.error(`Move failed: ${err}`);
  }
}

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
function TextureThumb({ path }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    toBlobUrl(path).then((u) => live && setUrl(u)).catch(() => {});
    return () => (live = false);
  }, [path]);
  if (!url)
    return (
      <div className="asset-icon">
        <Image size={26} strokeWidth={1.5} />
      </div>
    );
  return <img className="asset-thumb" src={url} alt="" draggable={false} />;
}

/** Material preview: color swatch, with its texture blended in when set. */
function MaterialThumb({ path }) {
  const [def, setDef] = useState(null);
  const [mapUrl, setMapUrl] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const d = { ...MATERIAL_DEFAULTS, ...JSON.parse(await invoke("read_text_file", { path })) };
        if (!live) return;
        setDef(d);
        if (d.map) setMapUrl(await toBlobUrl(d.map).catch(() => null));
      } catch {
        if (live) setDef({ ...MATERIAL_DEFAULTS });
      }
    })();
    return () => (live = false);
  }, [path]);
  return (
    <div className="asset-thumb mat-thumb" style={{ background: def?.color ?? "#888" }}>
      {mapUrl && <img className="mat-thumb-map" src={mapUrl} alt="" draggable={false} />}
    </div>
  );
}

function Thumb({ entry }) {
  if (entry.is_dir)
    return (
      <div className="asset-icon dir-icon">
        <Folder size={28} strokeWidth={1.5} />
      </div>
    );
  if (TEXTURE_EXTENSIONS.includes(entry.ext)) return <TextureThumb path={entry.path} />;
  if (entry.ext === "mat") return <MaterialThumb path={entry.path} />;
  const Icon = ICON_BY_EXT[entry.ext] ?? File;
  return (
    <div className="asset-icon">
      <Icon size={26} strokeWidth={1.5} />
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
];

function AssetTile({ entry, renaming, setRenamingPath, onContextMenu }) {
  const draggable = entry.is_dir || DRAGGABLE_EXTENSIONS.includes(entry.ext);
  const selected = useSelectionStore((s) => s.assetPath === entry.path);

  // Folders accept asset drops (move into folder).
  const dropRef = useAssetDrop({
    accepts: (path) => path !== entry.path,
    hoverClass: "drop-target",
    onDrop: (path) => moveIntoFolder(path, entry.path),
  });

  const commitRename = (value) => {
    setRenamingPath(null);
    renameEntry(entry, value);
  };

  return (
    <div
      className={`asset-tile ${entry.is_dir ? "dir" : ""} ${selected ? "selected" : ""}`}
      ref={entry.is_dir ? dropRef : undefined}
      onPointerDown={(e) => {
        if (draggable && !renaming && !e.target.closest("input")) {
          armAssetDrag(e, entry.path, { isDir: entry.is_dir });
        }
      }}
      onClick={() => {
        if (consumeAssetDragClick()) return;
        if (!entry.is_dir) useSelectionStore.getState().selectAsset(entry.path);
      }}
      onDoubleClick={() => {
        if (entry.is_dir) useProjectStore.getState().navigate(entry.path);
        else if (SCRIPT_EXTENSIONS.includes(entry.ext)) openInIDE(entry.path);
        else if (entry.ext === "scene") openScenePath(entry.path).catch((err) => console.error(String(err)));
        else if (ANIMATOR_EXTENSIONS.includes(entry.ext)) {
          useSelectionStore.getState().selectAsset(entry.path);
          import("../EditorShell.jsx").then((m) => m.openPanel("animator"));
        }
      }}
      onContextMenu={(e) => onContextMenu(e, entry)}
      title={entry.name}
    >
      <Thumb entry={entry} />
      {MODEL_EXTENSIONS.includes(entry.ext) && <DracoBadge path={entry.path} />}
      {renaming ? (
        <input
          className="rename-input asset-rename"
          autoFocus
          defaultValue={entry.name}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => commitRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename(e.target.value);
            if (e.key === "Escape") setRenamingPath(null);
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="asset-name">{entry.name}</div>
      )}
    </div>
  );
}

function AssetContextMenu({ menu, close, setRenamingPath }) {
  const entry = menu.entry;
  const items = entry
    ? [
        { label: "Rename", action: () => setRenamingPath(entry.path) },
        { label: "Delete", action: () => deleteEntry(entry) },
        ...(MODEL_EXTENSIONS.includes(entry.ext)
          ? [
              { label: "Unpack Model", action: () => unpackModel(entry.path) },
              { label: "Compress (Draco)", action: () => compressModel(entry.path) },
            ]
          : []),
        ...(!entry.is_dir ? [{ label: "Open in Default App", action: () => openInIDE(entry.path) }] : []),
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
  try {
    const imported = await invoke("import_files", { paths, destDir: currentPath });
    await refresh();
    console.log(`Imported ${imported.length} ${imported.length === 1 ? "asset" : "assets"}`);
    // Imported models unpack into an asset folder (textures/materials/prefab).
    for (const path of imported) {
      if (MODEL_EXTENSIONS.includes(extOf(path))) await unpackModel(path);
    }
  } catch (err) {
    console.error(`Import failed: ${err}`);
  }
}

async function unpackModel(path) {
  try {
    const { unpackGlb } = await import("../glbImport.js");
    await unpackGlb(path);
  } catch (err) {
    console.error(`Unpack failed for ${basename(path)}: ${err.message ?? err}`);
  }
}

/** Manually Draco-compresses a .glb in place (context menu). */
async function compressModel(path) {
  try {
    const { compressGlbInPlace, formatBytes } = await import("../dracoCompress.js");
    const info = await compressGlbInPlace(path);
    if (info == null) {
      console.log(`${basename(path)} is already Draco-compressed`);
    } else if (info.compressed < info.original) {
      const pct = Math.round((1 - info.compressed / info.original) * 100);
      console.log(`Draco: ${basename(path)} −${pct}% (${formatBytes(info.original)} → ${formatBytes(info.compressed)})`);
    } else {
      console.log(`Draco: ${basename(path)} already minimal — left uncompressed`);
    }
    await useProjectStore.getState().refresh();
  } catch (err) {
    console.error(`Compression failed for ${basename(path)}: ${err.message ?? err}`);
  }
}

export function AssetsPanel() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const currentPath = useProjectStore((s) => s.currentPath);
  const entries = useProjectStore((s) => s.entries);
  const loading = useProjectStore((s) => s.loading);
  const error = useProjectStore((s) => s.error);
  const [renamingPath, setRenamingPath] = useState(null);
  const [contextMenu, setContextMenu] = useState(null); // {x, y, entry|null}
  const [fileDropActive, setFileDropActive] = useState(false);
  const panelRef = useRef(null);

  // Drop an asset on the "Up" button: move it into the parent folder.
  const upDropRef = useAssetDrop({
    accepts: () => currentPath !== rootPath,
    onDrop: (path) => {
      const parent = currentPath.replace(/[\\/][^\\/]+$/, "");
      moveIntoFolder(path, parent || rootPath);
    },
  });

  useEffect(() => {
    if (!rootPath) useProjectStore.getState().restoreLastFolder();
  }, [rootPath]);

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
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  return (
    <div className={`assets-panel ${fileDropActive ? "file-drop" : ""}`} ref={panelRef}>
      <div className="panel-toolbar">
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
        <button className="toolbar-btn" title="New folder" onClick={createFolder}>
          <FolderPlus size={14} />
        </button>
        <button className="toolbar-btn" title="New script" onClick={createScript}>
          <FileCode2 size={14} />
        </button>
        <button className="toolbar-btn" title="New material" onClick={createMaterial}>
          <Palette size={14} />
        </button>
        <button
          className="toolbar-btn icon-only"
          title="Open project folder…"
          onClick={() => useProjectStore.getState().openFolder()}
        >
          <FolderOpen size={14} />
        </button>
      </div>
      {error && <div className="asset-error">{error}</div>}
      <div
        className="asset-grid"
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
      >
        {loading && <div className="asset-hint">Loading…</div>}
        {!loading && entries.length === 0 && <div className="asset-hint">Empty folder</div>}
        {/* .meta sidecars are edited via their asset's inspector, not shown as tiles */}
        {entries.filter((e) => !e.name.endsWith(".meta")).map((entry) => (
          <AssetTile
            key={entry.path}
            entry={entry}
            renaming={renamingPath === entry.path}
            setRenamingPath={setRenamingPath}
            onContextMenu={onTileContextMenu}
          />
        ))}
      </div>
      {contextMenu && (
        <AssetContextMenu menu={contextMenu} close={() => setContextMenu(null)} setRenamingPath={setRenamingPath} />
      )}
    </div>
  );
}
