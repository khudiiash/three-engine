import { ensureEngine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { useProjectStore } from "./store/projectStore.js";

let currentPath = null;

const SCENE_FILTERS = [{ name: "Scene", extensions: ["scene", "json"] }];
const LAST_SCENE_KEY = "engine.lastScene.v1"; // legacy fallback when no project is open

export const hasScenePath = () => !!currentPath;

const projectRoot = () => useProjectStore.getState().rootPath;
const isAbsolute = (p) => /^([a-zA-Z]:[\\/]|\/)/.test(p);

/** Path relative to the project root (forward slashes), or null if outside it. */
function toProjectRelative(root, path) {
  const norm = (p) => p.replaceAll("\\", "/");
  const r = norm(root);
  const p = norm(path);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : null;
}

/**
 * Records where the current scene lives. With a project open this is written
 * to project.json (the durable record); localStorage is only a fallback for
 * project-less sessions.
 */
function rememberScene(path) {
  currentPath = path;
  localStorage.setItem(LAST_SCENE_KEY, path);
  const root = projectRoot();
  if (root) {
    const rel = toProjectRelative(root, path);
    useProjectStore
      .getState()
      .updateMeta({ lastScene: rel ?? path })
      .catch((err) => console.warn(`Couldn't record lastScene in project.json: ${err}`));
  }
}

/** Reloads the scene from the previous session; false if none/unreadable. */
export async function restoreLastScene() {
  const engine = await ensureEngine();
  const root = projectRoot();
  let path = null;
  if (root) {
    const last = useProjectStore.getState().projectMeta?.lastScene;
    if (last) path = isAbsolute(last) ? last : `${root}/${last}`;
  }
  if (!path) path = localStorage.getItem(LAST_SCENE_KEY);
  if (!path) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { deserializeScene } = await import("../engine/index.js");
    const contents = await invoke("load_scene", { path });
    deserializeScene(engine, JSON.parse(contents));
    engine.sceneName = sceneNameFromPath(path);
    currentPath = path;
    afterSceneSwap();
    console.log(`Restored last scene: ${path}`);
    return true;
  } catch (err) {
    console.warn(`Couldn't restore last scene (${path}): ${err}`);
    return false;
  }
}

function afterSceneSwap() {
  commandBus.clearHistory();
  useSelectionStore.getState().clear();
  useSceneStore.getState().refresh();
  useSceneStore.getState().markDirty(false);
}

export async function newScene() {
  const engine = await ensureEngine();
  engine.clear();
  currentPath = null;
  engine.sceneName = projectRoot() ? "Main" : "Untitled";

  // Unity-style default content (not undoable — it's the baseline).
  const light = engine.createEntity({ name: "Directional Light" });
  light.addComponent("light", { kind: "directional", intensity: 2 });
  light.object3D.position.set(4, 6, 3);
  light.object3D.lookAt(0, 0, 0);

  const camera = engine.createEntity({ name: "Main Camera" });
  camera.addComponent("camera");
  camera.object3D.position.set(0, 2, 6);
  camera.object3D.lookAt(0, 0.5, 0);

  const box = engine.createEntity({ name: "Box" });
  box.addComponent("mesh", { geometry: "box" });
  box.object3D.position.set(0, 0.5, 0);

  afterSceneSwap();

  // With a project open the scene gets a real file immediately — edits are
  // never held only in memory / localStorage.
  if (projectRoot()) {
    saveScene().catch((err) => console.warn(`Couldn't save new scene: ${err}`));
  }
}

/** First free scenes/<name>.scene inside the project (never clobbers a stranger). */
async function uniqueScenePath(root, name) {
  const { invoke } = await import("@tauri-apps/api/core");
  for (let i = 0; ; i++) {
    const candidate = `${root}/scenes/${name}${i === 0 ? "" : ` ${i}`}.scene`;
    try {
      await invoke("stat_file", { path: candidate });
    } catch {
      return candidate; // stat failed → file doesn't exist → free
    }
  }
}

export async function saveScene({ saveAs = false } = {}) {
  const engine = await ensureEngine();
  let path = !saveAs && currentPath;
  if (!path) {
    const root = projectRoot();
    if (!saveAs && root) {
      // Inside a project, unsaved scenes get a path automatically — no dialog.
      path = await uniqueScenePath(root, engine.sceneName);
    } else {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const defaultDir = root ? `${root}/scenes/` : "";
      path = await save({ filters: SCENE_FILTERS, defaultPath: `${defaultDir}${engine.sceneName}.scene` });
      if (!path) return false;
    }
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const { serializeScene } = await import("../engine/index.js");
  engine.sceneName = sceneNameFromPath(path);
  const contents = JSON.stringify(serializeScene(engine), null, 2);
  await invoke("save_scene", { path, contents });
  rememberScene(path);
  useSceneStore.getState().refresh();
  useSceneStore.getState().markDirty(false);
  console.log(`Scene saved: ${path}`);
  return true;
}

export async function openScene() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const root = projectRoot();
  const path = await open({
    multiple: false,
    filters: SCENE_FILTERS,
    defaultPath: root ?? undefined,
  });
  if (!path) return false;
  return openScenePath(path);
}

/** Loads a scene from a known path (double-click in Assets, project restore). */
export async function openScenePath(path) {
  const engine = await ensureEngine();
  const { invoke } = await import("@tauri-apps/api/core");
  const { deserializeScene } = await import("../engine/index.js");
  const contents = await invoke("load_scene", { path });
  deserializeScene(engine, JSON.parse(contents));
  engine.sceneName = sceneNameFromPath(path);
  rememberScene(path);
  afterSceneSwap();
  console.log(`Scene loaded: ${path}`);
  return true;
}

function sceneNameFromPath(path) {
  const base = path.split(/[\\/]/).pop() ?? "Untitled";
  return base.replace(/\.(scene|json)$/i, "");
}
