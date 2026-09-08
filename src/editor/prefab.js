import { vmSingleton } from "./singleton.js";
// @ts-check
import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useProjectStore } from "./store/projectStore.js";
import { usePrefabStore } from "./store/prefabStore.js";
import { listProjectAssets, extOf } from "./assetLoader.js";
import {
  prefabRegistry,
  parsePrefabFile,
  serializeScene,
  deserializeScene,
  instantiatePrefabNode,
  createVariantDefFromInstance,
  defFromStageRoot,
  reloadPrefab,
  PREFAB_EXT,
  LEGACY_PREFAB_EXT,
} from "../engine/index.js";
import {
  InstantiatePrefabCommand,
  CreatePrefabCommand,
  ApplyPrefabCommand,
  RevertPrefabCommand,
  UnpackPrefabCommand,
  flushPrefabWrites,
} from "./commands/prefabCommands.js";
import { freeze } from "../engine/freezeLedger.js";

/**
 * Editor-side prefab services: the project's prefab catalog, reading/writing
 * `.prefab` assets, and Prefab Mode (editing a prefab in isolation).
 *
 * The engine owns the *semantics* (resolve / expand / diff / apply — see
 * engine/prefab/); this module owns the *filesystem and editor state* around
 * them. Legacy `.entity` snapshots are still readable: they're upgraded to a
 * def on load, so old assets (and the ones glbImport used to write) keep
 * working as prefabs.
 */

const invoke = async (cmd, args) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
};

const basename = (p) => p.split(/[\\/]/).pop() ?? p;
const stemOf = (p) => basename(p).replace(/\.[^.]+$/, "");

/** Mirrors the registry into the store so React can react to it. */
function publishCatalog() {
  const prefabs = prefabRegistry
    .all()
    .map((def) => ({ guid: def.guid, name: def.name ?? "Prefab", path: prefabRegistry.pathOf(def.guid) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  usePrefabStore.getState().setPrefabs(prefabs);
}

/** Reads one prefab asset into the registry. Returns the def (or null). */
export async function loadPrefabFile(path) {
  const entry = await readPrefabFile(path);
  return entry ? registerPrefabText(entry.path, entry.text) : null;
}

/** The IPC half of `loadPrefabFile`, so many can be in flight at once. */
async function readPrefabFile(path) {
  try {
    return { path, text: await invoke("read_text_file", { path }) };
  } catch (err) {
    console.warn(`Couldn't load prefab ${basename(path)}: ${err}`);
    return null;
  }
}

/** The parse+register half. Synchronous, so the order it runs in is the order
 *  the registry sees — see `loadProjectPrefabs`. */
function registerPrefabText(path, text) {
  try {
    const def = parsePrefabFile(text, { name: stemOf(path) });
    prefabRegistry.register(def, path);
    return def;
  } catch (err) {
    console.warn(`Couldn't load prefab ${basename(path)}: ${err}`);
    return null;
  }
}

/**
 * Scans the project for prefab assets and fills the registry. Must complete
 * *before* a scene loads — instances can't expand without their defs — so the
 * editor boot sequence awaits it (see EditorChrome).
 */
export async function loadProjectPrefabs() {
  const root = useProjectStore.getState().rootPath;
  prefabRegistry.clear();
  if (!root) {
    publishCatalog();
    return;
  }
  // ⚠ THE STAGE IS 3.1 s AND THE WHOLE BOOT WAITS ON IT (measured on the
  // user's project, 2026-09-07) — but "prefabs: load" is three different
  // things, and the parallel-read fix below only addressed one of them. Each
  // sub-step marks itself, so the boot table says which one to attack rather
  // than leaving the next session to re-derive it: a recursive asset LISTING
  // over a 3 700-asset tree is a different problem from reading 21 files.
  const tList = performance.now();
  const paths = await freeze.runAsync("prefabs:list", () => listProjectAssets(root, [PREFAB_EXT, LEGACY_PREFAB_EXT], 8));
  freeze.bootMark("prefabs: list files", performance.now() - tList, `${paths.length} found`);
  // ── PREFABS LOAD IN PARALLEL (zero-freeze plan, found by unit 0.2) ───────
  // This was `for (const path of paths) await loadPrefabFile(path)` — one
  // native IPC round trip at a time, serialized. The boot table measured it at
  // **2 217 ms on the user's project for 21 prefabs** (~105 ms each, nearly
  // all of it latency, not work), and the whole editor boot waits on this
  // stage because a scene's prefab INSTANCES cannot expand without their defs.
  // The reads are independent, so they go out together; registration order is
  // restored afterwards so the catalog is deterministic (the registry is a
  // map, but two prefabs claiming one guid must resolve the same way twice).
  //
  // Bounded rather than unbounded: a project with a thousand prefabs should
  // not open a thousand simultaneous native handles.
  const PREFAB_READ_CONCURRENCY = 16;
  const loaded = new Array(paths.length).fill(null);
  const tRead = performance.now();
  await freeze.runAsync("prefabs:read", async () => {
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < paths.length; i = next++) {
        loaded[i] = await readPrefabFile(paths[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PREFAB_READ_CONCURRENCY, paths.length) }, worker),
    );
  });
  freeze.bootMark("prefabs: read files", performance.now() - tRead, `${paths.length} at ${PREFAB_READ_CONCURRENCY} concurrent`);
  const tRegister = performance.now();
  freeze.run("prefabs:register", () => {
    for (const entry of loaded) {
      if (entry) registerPrefabText(entry.path, entry.text);
    }
  });
  freeze.bootMark("prefabs: register", performance.now() - tRegister);
  publishCatalog();
  console.log(`Loaded ${prefabRegistry.all().length} prefab(s)`);
}

/** Writes a def to disk and re-expands every live instance that depends on it. */
export async function savePrefabDef(def, path) {
  await invoke("save_scene", { path, contents: JSON.stringify(def, null, 2) });
  reloadPrefab(engine, def, path);
  publishCatalog();
  useSceneStore.getState().refresh();
  await useProjectStore.getState().refresh?.();
  return def;
}

/** First free `<folder>/<name>.prefab`. */
async function uniquePrefabPath(folder, name) {
  for (let i = 0; ; i++) {
    const candidate = `${folder}/${name}${i === 0 ? "" : ` ${i}`}.${PREFAB_EXT}`;
    try {
      await invoke("stat_file", { path: candidate });
    } catch {
      return candidate; // stat threw → nothing there → free
    }
  }
}

/** Where a new prefab lands: the Assets panel's current folder, else <root>/prefabs. */
export async function defaultPrefabFolder() {
  const { rootPath, currentPath } = useProjectStore.getState();
  const folder = currentPath || (rootPath ? `${rootPath}/prefabs` : null);
  if (!folder) throw new Error("Open a project before creating prefabs");
  await invoke("create_dir", { path: folder }).catch(() => {});
  return folder;
}

export async function prefabPathFor(name, folder = null) {
  return uniquePrefabPath(folder ?? (await defaultPrefabFolder()), name);
}

/** Spawns a prefab asset into the scene (undoable). Used by the asset drops. */
export async function instantiatePrefab(path, position = null, parentId = null) {
  let guid = prefabRegistry.guidForPath(path);
  if (!guid) guid = (await loadPrefabFile(path))?.guid;
  if (!guid) {
    console.error(`Couldn't instantiate ${basename(path)} — not a readable prefab`);
    return null;
  }
  const cmd = new InstantiatePrefabCommand({ guid, path }, { position, parentId });
  commandBus.execute(cmd);
  if (cmd.entityId) useSelectionStore.getState().select(cmd.entityId);
  return cmd.entityId;
}

// ---- Actions (menus, inspector buttons) -----------------------------------

/** Packs an entity tree into a new `.prefab` asset and links the entity to it. */
export async function createPrefabFromEntity(entityId, folder = null) {
  const entity = engine.getEntity(entityId);
  if (!entity) return null;
  try {
    const path = await prefabPathFor(entity.name, folder);
    commandBus.execute(new CreatePrefabCommand(entityId, path, { name: entity.name }));
    publishCatalog();
    // The command queues the file write (commands can't be async) — wait for it
    // to land, or the Assets panel would refresh before the file exists and the
    // new prefab wouldn't show up.
    await flushPrefabWrites();
    await useProjectStore.getState().refresh?.();
    // Log the full path: with no folder open in the Assets panel the prefab
    // lands in <project>/prefabs/, which may not be the folder you're looking at.
    console.log(`Created prefab: ${path}`);
    return path;
  } catch (err) {
    console.error(`Couldn't create prefab: ${err.message ?? err}`);
    return null;
  }
}

/** Saves an instance's overrides into a *new* prefab that inherits from the
 *  original — Unity's "Create Prefab Variant". */
export async function createVariantFromInstance(entityId, folder = null) {
  const entity = engine.getEntity(entityId);
  if (!entity?.prefab) return null;
  try {
    const def = createVariantDefFromInstance(entity, { name: `${entity.name} Variant` });
    const path = await prefabPathFor(def.name, folder);
    await invoke("save_scene", { path, contents: JSON.stringify(def, null, 2) });
    prefabRegistry.register(def, path);
    // Re-point the live instance at the variant: the object you were editing is
    // now an instance of the thing you just made (its overrides are the
    // variant's, so it has none of its own left).
    commandBus.execute(new InstantiatePrefabCommand({ guid: def.guid, path }, {
      position: entity.getTransform().position,
      parentId: entity.parent?.id ?? null,
      name: entity.name,
    }));
    engine.destroyEntity(entity);
    engine.emit("hierarchy-changed");
    publishCatalog();
    await useProjectStore.getState().refresh?.();
    console.log(`Created variant: ${basename(path)}`);
    return path;
  } catch (err) {
    console.error(`Couldn't create variant: ${err.message ?? err}`);
    return null;
  }
}

export function applyPrefab(entityId, only = null) {
  const entity = engine.getEntity(entityId);
  if (!entity?.prefab) return;
  commandBus.execute(new ApplyPrefabCommand(entityId, only));
}

export function revertPrefab(entityId, only = null) {
  const entity = engine.getEntity(entityId);
  if (!entity?.prefab) return;
  commandBus.execute(new RevertPrefabCommand(entityId, only));
}

export function unpackPrefab(entityId, { deep = false } = {}) {
  const entity = engine.getEntity(entityId);
  if (!entity?.prefab) return;
  commandBus.execute(new UnpackPrefabCommand(entityId, { deep }));
}

/** The asset path behind an instance (for "Open Prefab" / "Select Asset"). */
export function prefabAssetPathOf(entityId) {
  const entity = engine.getEntity(entityId);
  const guid = entity?.prefab ? prefabRegistry.resolveLink(entity.prefab) : null;
  return guid ? prefabRegistry.pathOf(guid) : null;
}

// ---- Prefab Mode ----------------------------------------------------------

/**
 * The scene we suspended to open a prefab. Held in memory (not on disk) so
 * entering Prefab Mode never touches the user's scene file — and so unsaved
 * scene edits survive a trip into a prefab and back.
 */
const parked = vmSingleton("prefabSuspendedScene", () => ({ /** @type {any} */ scene: null }));

export function isPrefabModeActive() {
  return !!usePrefabStore.getState().stage;
}

/**
 * Opens a prefab in isolation: the scene is set aside and the prefab becomes
 * the only thing in the viewport, as a live instance of itself. Every editor
 * tool works on it unchanged — it's just entities.
 */
export async function openPrefabMode(path) {
  if (isPrefabModeActive()) await exitPrefabMode({ save: false });

  let guid = prefabRegistry.guidForPath(path);
  if (!guid) guid = (await loadPrefabFile(path))?.guid;
  const def = guid ? prefabRegistry.getDef(guid) : null;
  if (!def) {
    console.error(`Couldn't open ${basename(path)} — not a readable prefab`);
    return false;
  }

  parked.scene = { json: serializeScene(engine), name: engine.sceneName };

  engine.clear();
  engine.sceneName = def.name ?? stemOf(path);
  const root = instantiatePrefabNode(engine, { prefab: { guid, path } }, null);

  usePrefabStore.getState().enterStage({ guid, path, name: def.name ?? stemOf(path), rootId: root.id });
  commandBus.clearHistory();
  useSceneStore.getState().refresh();
  useSceneStore.getState().markDirty(false);
  useSelectionStore.getState().select(root.id);
  console.log(`Editing prefab: ${def.name}`);
  return true;
}

/** Writes the staged prefab back to its asset. */
export async function savePrefabStage() {
  const stage = usePrefabStore.getState().stage;
  if (!stage) return false;
  const def = prefabRegistry.getDef(stage.guid);
  const root = engine.getEntity(stage.rootId);
  if (!def || !root) return false;

  const next = defFromStageRoot(root, def);
  await invoke("save_scene", { path: stage.path, contents: JSON.stringify(next, null, 2) });
  // No live instances exist while staged (the scene is suspended), so this is
  // just a registry swap — the instances pick the change up when the scene
  // comes back in `exitPrefabMode`.
  prefabRegistry.register(next, stage.path);
  publishCatalog();
  usePrefabStore.getState().markStageDirty(false);
  useSceneStore.getState().markDirty(false);
  await useProjectStore.getState().refresh?.();
  console.log(`Saved prefab: ${next.name}`);
  return true;
}

/**
 * Leaves Prefab Mode and restores the suspended scene. Restoring re-expands
 * every instance from the (now updated) registry, so edits made in Prefab Mode
 * land in the scene automatically — instances keep their own overrides because
 * those were captured into the suspended scene JSON on the way in.
 */
export async function exitPrefabMode({ save = true } = {}) {
  const stage = usePrefabStore.getState().stage;
  if (!stage) return;
  if (save && usePrefabStore.getState().stageDirty) await savePrefabStage();

  const backup = parked.scene;
  parked.scene = null;
  usePrefabStore.getState().exitStage();

  engine.clear();
  if (backup) {
    await deserializeScene(engine, backup.json);
    engine.sceneName = backup.name;
  }
  commandBus.clearHistory();
  useSelectionStore.getState().clear();
  useSceneStore.getState().refresh();
  useSceneStore.getState().markDirty(false);
}

/** True when `path` is a prefab asset (new or legacy extension). */
export function isPrefabPath(path) {
  const ext = extOf(path);
  return ext === PREFAB_EXT || ext === LEGACY_PREFAB_EXT;
}

export { publishCatalog };
