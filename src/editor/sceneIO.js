import { vmSingleton } from "./singleton.js";
import * as THREE from "three/webgpu";
import { ensureEngine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { useProjectStore, lastProjectPath } from "./store/projectStore.js";
import { freeze } from "../engine/freezeLedger.js";

/**
 * The scene file on screen. VM-wide rather than a module-level `let`: "which
 * file does Ctrl+S write?" must have exactly one answer, and a second copy of
 * this module starts at null — so a save driven through it would silently
 * become a Save-As of a scene the other copy opened.
 */
const open = vmSingleton("openScene", () => ({ /** @type {string | null} */ path: null }));

const SCENE_FILTERS = [{ name: "Scene", extensions: ["scene", "json"] }];
// Only consulted in the projectless ("Skip the project") path. With a real
// project open, the scene to restore is always resolved from that project's
// own project.json — never from a localStorage entry left over from a
// previous project. See restoreLastScene().
const LAST_SCENE_KEY = "engine.lastScene.v1";

export const hasScenePath = () => !!open.path;
export const currentScenePath = () => open.path;

/**
 * Flag consulted by EditorChrome on its mount effect. A single engine
 * instance lives across the editor's whole session (so it survives project
 * switches), so we have to remember whether the *current* project has been
 * booted yet. Project switching flips this back to `false` to force a fresh
 * boot of the new project.
 */
export let sceneBooted = false;
export function markSceneBooted() {
  sceneBooted = true;
}
export function resetSceneBooted() {
  sceneBooted = false;
}

/**
 * Wipes engine + scene-side bookkeeping. Called when switching projects so
 * a new project always starts clean — never inherits entities/components
 * left over from the previous one. The actual restore of project.json's
 * scene is left to EditorChrome's normal boot flow.
 */
export async function resetEditorScene() {
  await leavePrefabMode();
  const engine = await ensureEngine();
  engine.clear();
  open.path = null;
  resetSceneBooted();
  afterSceneSwap(engine);
}

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
 * to *that project's* project.json (the durable, per-project record); the
 * legacy localStorage entry is only set in the project-less ("Skip the
 * project") path. Mixing them would let a previous project's localStorage
 * entry bleed into the next project opened.
 */
function rememberScene(path) {
  open.path = path;
  useSceneStore.getState().setScenePath(path);
  const root = projectRoot();
  if (root) {
    const rel = toProjectRelative(root, path);
    useProjectStore
      .getState()
      .updateMeta({ lastScene: rel ?? path })
      .catch((err) => console.warn(`Couldn't record lastScene in project.json: ${err}`));
  } else {
    localStorage.setItem(LAST_SCENE_KEY, path);
  }
}

/**
 * Resolves the boot-time scene path from projectMeta: **lastScene wins**, with
 * mainScene as the fallback. Returns an absolute path, or null.
 *
 * This was the other way round, on the reasoning that the user's chosen entry
 * point should beat the last-edited scene. That is right for a BUILD and wrong
 * for an editor: `mainScene` is the scene a shipped game boots into, set once
 * and then left alone, so preferring it meant closing the editor on the level
 * you were building and reopening on the menu — every single time, with the
 * work you were mid-way through one Open Scene away and no indication that the
 * editor had decided to go somewhere else. `lastScene` is written on every
 * open/save (see `rememberScene`), so this is simply "reopen what I had open".
 *
 * `mainScene` still wins the only argument it should: it is what the build
 * exports and what `resolveBuildScenes` starts from. Nothing there reads this.
 */
function bootCandidates() {
  const root = projectRoot();
  if (!root) return [];
  const meta = useProjectStore.getState().projectMeta ?? {};
  const absolute = (p) => (isAbsolute(p) ? p : `${root}/${p}`);
  // Deduped because the two very often name the same scene, and trying it
  // twice would log the same "not found" warning twice.
  return [...new Set([meta.lastScene, meta.mainScene].filter(Boolean).map(absolute))];
}

/**
 * The `renderer` block of the scene the editor is ABOUT to boot into, read
 * before the renderer exists so it can be built with those options the first
 * time. Returns null when there is nothing to pre-apply.
 *
 * WHY THIS IS READ TWICE (here, and again by the real scene load a moment
 * later): antialias / samples / transparent are frozen at `WebGPURenderer`
 * construction time, so a scene whose block differs from
 * `SCENE_SETTINGS_DEFAULTS` used to be honoured by DESTROYING the boot
 * renderer and building a second one — `renderer.dispose()` → `[gpu] DEVICE
 * LOST (destroyed)` in the console on EVERY launch of any such project, plus a
 * second adapter+device request and every pipeline minted against the dead
 * device thrown away. `Engine.init` runs from ViewportPanel's mount, well
 * before `restoreLastScene`, so the only way to build it right once is to look
 * the value up early. One extra file read at boot buys that.
 *
 * Deliberately store-independent: the project root comes from localStorage via
 * `lastProjectPath()` when the store has not been populated yet, because the
 * viewport can mount before `openProject` has resolved and a store miss would
 * silently put the destroy back.
 */
/**
 * ── ONE PARSE, NOT TWO (zero-freeze plan unit 4.1) ────────────────────────
 * `peekBootRendererSettings` parses the scene file before the renderer is
 * constructed; `restoreLastScene` then parsed the SAME file again a moment
 * later. On a large scene that is two multi-hundred-millisecond synchronous
 * `JSON.parse` blocks in one boot, for one object. The peek now keeps what it
 * parsed and the restore takes it — one entry, consumed once, dropped after,
 * so a scene re-opened later (or edited on disk in between) still re-reads.
 */
const parsedScenes = new Map();

/** Hands the boot parse to `restoreLastScene`, at most once. */
function takeParsedScene(path) {
  const json = parsedScenes.get(path);
  parsedScenes.delete(path);
  return json ?? null;
}

export async function peekBootRendererSettings() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const readJson = async (path) => JSON.parse(await invoke("load_scene", { path }));
    const root = projectRoot() ?? lastProjectPath();
    /** @type {string[]} */
    const candidates = [];
    if (root) {
      // The store's meta when it is already loaded, else project.json itself.
      let meta = useProjectStore.getState().projectMeta ?? {};
      if (!meta.lastScene && !meta.mainScene) {
        meta = await readJson(`${root}/project.json`).catch(() => ({}));
      }
      for (const rel of [meta.lastScene, meta.mainScene]) {
        if (rel) candidates.push(isAbsolute(rel) ? rel : `${root}/${rel}`);
      }
    } else {
      const legacy = localStorage.getItem(LAST_SCENE_KEY);
      if (legacy) candidates.push(legacy);
    }
    for (const path of [...new Set(candidates)]) {
      const token = freeze.begin("boot:peekRendererSettings");
      const scene = await readJson(path).catch(() => null);
      freeze.end(token);
      // Keep it for `restoreLastScene`, whichever candidate wins there.
      if (scene) {
        parsedScenes.clear();
        parsedScenes.set(path, scene);
      }
      const renderer = scene?.settings?.renderer;
      if (renderer && typeof renderer === "object") return renderer;
    }
  } catch {
    // No Tauri, no project, or an unreadable scene. The renderer is then built
    // from the defaults exactly as before — one rebuild, not a broken boot.
  }
  return null;
}

/** Reloads the scene the editor should boot into. Validates the path exists
 *  before loading — a stale/missing mainScene silently failed before and then
 *  triggered an unwanted `newScene()` that polluted the project with auto-saved
 *  "Main 1"/"Main 2" files. Returns true on success, false (with a logged
 *  warning) when nothing could be restored. The caller decides what to do
 *  with that — see EditorChrome.
 *
 *  Scene resolution rules:
 *  - With a project open, the only valid source is *that project's* own
 *    project.json (mainScene / lastScene). A localStorage entry left over
 *    from a previous project is ignored — otherwise a freshly-created
 *    project would silently reopen the previous game's saved scene.
 *  - Without a project (the "Skip the project" path), legacy localStorage
 *    is the only available record.
 *  Callers are expected to clear the engine first (see resetEditorScene)
 *  when switching projects, so a project with no saved scene ends up
 *  truly empty rather than carrying the previous project's state. */
export async function restoreLastScene() {
  const engine = await ensureEngine();
  const root = projectRoot();
  const candidates = bootCandidates();
  if (!candidates.length && !root) {
    const legacy = localStorage.getItem(LAST_SCENE_KEY);
    if (legacy) candidates.push(legacy);
  }
  if (!candidates.length) return false;

  const { invoke } = await import("@tauri-apps/api/core");
  for (const path of candidates) {
    try {
      await invoke("stat_file", { path });
    } catch {
      // Renaming or deleting the scene you last had open must not strand the
      // editor on an empty stage — fall through to `mainScene`.
      console.warn(`Saved scene not found on disk: ${path}`);
      continue;
    }
    try {
      const [{ deserializeScene, collectSceneAssets, expandMaterialAssets }, { preloadAssetBinaries }] = await Promise.all([
        import("../engine/index.js"),
        import("./assetLoader.js"),
      ]);
      freeze.bootStage("scene: read file");
      const contents = await invoke("load_scene", { path });
      freeze.bootStage("scene: parse JSON", `${(contents.length / 1024).toFixed(0)} kB`);
      // ⚠ The SECOND parse of this file in one boot — `peekBootRendererSettings`
      // already parsed it to read `settings.renderer` before the renderer was
      // constructed. Unit 4.1 of the zero-freeze plan removes the first one;
      // until then the boot table shows both.
      const json = takeParsedScene(path) ?? JSON.parse(contents);
      freeze.bootStage("scene: preload assets");
      const assets = collectSceneAssets(json);
      await preloadAssetBinaries(assets);
      await preloadAssetBinaries(await expandMaterialAssets(assets));
      freeze.bootStage("scene: deserialize");
      await deserializeScene(engine, json);
      freeze.bootStage(null);
      engine.sceneName = sceneNameFromPath(path);
      if (path === candidates[0]) open.path = path;
      // Fell back past a `lastScene` that no longer exists — repair it, or
      // every future launch re-reports the same missing file.
      else rememberScene(path);
      afterSceneSwap(engine);
      console.log(`Restored scene: ${path}`);
      return true;
    } catch (err) {
      console.warn(`Couldn't restore scene (${path}): ${err}`);
    }
  }
  const scope = root ? `project ${root}` : "saved scene";
  console.warn(`No scene could be restored (${scope}). Use File → New Scene or Open Scene…`);
  return false;
}

function afterSceneSwap(engine = null) {
  commandBus.clearHistory();
  useSelectionStore.getState().clear();
  // deserialize/clear/create already emits one coalesced hierarchy event,
  // which rebuilds the O(N) entity mirror. Only the filename-derived chrome
  // changes here; refreshing again doubled Bistro's hierarchy publication.
  useSceneStore.getState().setSceneMeta(engine?.sceneName ?? "Untitled", open.path);
  useSceneStore.getState().markDirty(false);
  // Keep the runtime scene manager's idea of "the scene you are in" aligned
  // with the editor's, so `engine.scenes.active` is meaningful while stopped
  // and Play starts from the right record.
  engine?.scenes?.reset({ path: open.path, name: engine.sceneName });
}

/** Prefab Mode holds the scene suspended in memory. Any operation that swaps
 *  the scene out has to leave the stage first (saving the prefab), or the
 *  suspended scene would be silently dropped on the floor. */
async function leavePrefabMode() {
  const { isPrefabModeActive, exitPrefabMode } = await import("./prefab.js");
  if (isPrefabModeActive()) await exitPrefabMode({ save: true });
}

export async function newScene() {
  await leavePrefabMode();
  const engine = await ensureEngine();
  engine.clear();
  open.path = null;
  useSceneStore.getState().setScenePath(null);
  engine.sceneName = projectRoot() ? "Main" : "Untitled";

  // Unity-style default content (not undoable — it's the baseline).
  const light = engine.createEntity({ name: "Directional Light" });
  light.addComponent("light", { kind: "directional", intensity: 2 });
  // Directional lights are pinned to the world origin; only their rotation
  // defines the emitted direction. Tilt the default sun downward at ~55°
  // pitch so the new scene has a clear key light from above-and-to-the-side.
  light.object3D.rotation.set(
    THREE.MathUtils.degToRad(-55),
    THREE.MathUtils.degToRad(35),
    0,
  );

  const camera = engine.createEntity({ name: "Main Camera" });
  camera.addComponent("camera");
  camera.object3D.position.set(0, 2, 6);

  const box = engine.createEntity({ name: "Box" });
  box.addComponent("mesh", { geometry: "box" });
  box.object3D.position.set(0, 0.5, 0);

  afterSceneSwap(engine);

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

  // In Prefab Mode the viewport holds a prefab, not the scene — the scene is
  // suspended in memory. Saving must write the *prefab*; writing the scene file
  // here would overwrite the user's scene with the staged prefab's contents.
  // Routing it centrally covers Ctrl+S, the File menu and autosave at once.
  const { isPrefabModeActive, savePrefabStage } = await import("./prefab.js");
  if (isPrefabModeActive()) return savePrefabStage();

  let path = !saveAs && open.path;
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
  // ── THE AUTOSAVE HITCH (2026-09-07, found by profile.freezes) ────────────
  // The freeze ledger showed a ~57 ms main-thread block landing every ~10 s
  // for the whole session — a rhythm, not an event, which is the worst kind of
  // stutter because it never stops. It is this line: a full engine walk plus a
  // pretty-printed `JSON.stringify` of a 326 kB document, on the autosave
  // interval, while the user is working.
  //
  // Spanned in two halves because they have different fixes: the WALK is
  // engine-shaped work, the STRINGIFY is bytes. Whichever dominates is the one
  // to attack next.
  const json = freeze.run("scene:serialize", () => serializeScene(engine));
  const contents = freeze.run("scene:stringify", () => JSON.stringify(json, null, 2));
  await invoke("save_scene", { path, contents });
  // The scene's picture, for every place assets show one (sceneThumbs.js).
  // Throttled there; never lets a save fail.
  import("./sceneThumbs.js").then((m) => m.captureSceneThumb(path)).catch(() => {});
  rememberScene(path);
  // ⛔ NO `sceneStore.refresh()` HERE. Saving changes no entity — it reads the
  // scene, it does not edit it — but the refresh rebuilds the mirror of every
  // entity with fresh object identities, so every Hierarchy row re-rendered
  // once per autosave. `markDirty(false)` is the only thing a save actually
  // has to publish, and it is the thing the chrome reads.
  // `__editorSaveRefreshesMirror = true` restores the old behaviour.
  if (globalThis.__editorSaveRefreshesMirror === true) useSceneStore.getState().refresh();
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
  await leavePrefabMode();
  const engine = await ensureEngine();
  const { invoke } = await import("@tauri-apps/api/core");
  const [{ deserializeScene, collectSceneAssets, expandMaterialAssets }, { preloadAssetBinaries }] = await Promise.all([
    import("../engine/index.js"),
    import("./assetLoader.js"),
  ]);
  const contents = await invoke("load_scene", { path });
  const json = JSON.parse(contents);
  const assets = collectSceneAssets(json);
  await preloadAssetBinaries(assets);
  await preloadAssetBinaries(await expandMaterialAssets(assets));
  await deserializeScene(engine, json);
  engine.sceneName = sceneNameFromPath(path);
  rememberScene(path);
  afterSceneSwap(engine);
  console.log(`Scene loaded: ${path}`);
  return true;
}

function sceneNameFromPath(path) {
  const base = path.split(/[\\/]/).pop() ?? "Untitled";
  return base.replace(/\.(scene|json)$/i, "");
}
