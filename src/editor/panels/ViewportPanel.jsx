import { useEffect, useRef, useState } from "react";
import { Play, Square, Move, Rotate3d, Scale3d, Layers as LayersIcon } from "lucide-react";
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { ensureEngine, engine } from "../engineInstance.js";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";
import { StatsOverlay } from "../overlays/StatsOverlay.jsx";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetTransformCommand } from "../commands/transformCommands.js";
import { BatchCommand } from "../commands/entityCommands.js";
import { getUiSystem } from "../../engine/ui/UiSystem.js";
import { AddComponentCommand, SetComponentPropCommand } from "../commands/componentCommands.js";
import { extOf, MODEL_EXTENSIONS, TEXTURE_EXTENSIONS, SCRIPT_EXTENSIONS, MATERIAL_EXTENSIONS, PREFAB_EXTENSIONS } from "../assetLoader.js";
import { basename } from "../store/projectStore.js";
import { usePlayStore } from "../store/playStore.js";
import { toggle as togglePlay } from "../playMode.js";
import { useAssetDrop } from "../assetDrag.js";
import { instantiatePrefab } from "../prefab.js";
import { getProjectSettings, onProjectSettingsApplied, applyProjectSettings } from "../projectSettings.js";
import {
  finishTerrainBrushAdjustment,
  dispatchTerrainKeyAction,
  getTerrainBrushAdjustment,
  getTerrainBrushMode,
  getTerrainBrushSettings,
  setTerrainBrushSetting,
  subscribeTerrainBrush,
} from "../terrainBrush.js";
import { SetTerrainHeightsCommand, SetTerrainScatterCommand, SetTerrainSplatmapCommand } from "../commands/terrainCommands.js";
import { GeometryEditorPanel } from "./GeometryEditorPanel.jsx";
import { useGeometryEditStore } from "../store/geometryEditStore.js";

/** Sets `layers.set(EDITOR_LAYER)` on every Object3D in the subtree —
 *  layers in three.js are not inherited, so this has to walk explicitly. */
function putOnEditorLayer(obj) {
  obj.layers.set(EDITOR_LAYER);
  obj.traverse((child) => {
    if (child !== obj) child.layers.set(EDITOR_LAYER);
  });
}

// Layers-dropdown toggles. Kept in declaration order so the dropdown
// reads top-to-bottom in the order users expect (gizmos = selection aids,
// colliders = physics aids, grid = spatial reference). Add new toggles
// here and to `viewport.layers` defaults above together.
const LAYER_TOGGLES = [
  { key: "gizmos", label: "Gizmos" },
  { key: "colliders", label: "Colliders" },
  { key: "grid", label: "Grid" },
  { key: "stats", label: "Stats" },
];

// The renderer canvas and editor controls outlive the React panel so the
// viewport can be closed/reopened without re-initializing WebGPU.
const viewport = {
  canvas: null,
  camera: null,
  orbit: null,
  gizmo: null,
  selectionBox: null,
  cameraHelper: null,
  lightHelper: null,
  cameraPreview: null,
  helpers: null,
  grid: null,
  backend: null,
  initPromise: null,
  hovered: false,
  gameCameraId: null,
  terrainBrushing: false,
  terrainBrushIndicator: null,
  // Toggles from the Layers dropdown. Mirrored in React state; mutations
  // here apply live so a hot-reload of the panel keeps the current layer
  // set. Default to "all on" so the viewport starts in its full visual state.
  layers: { gizmos: true, colliders: true, grid: true, stats: true },
  layersListeners: new Set(),
};

// Notify any viewport subscriber (the toolbar dropdown) about layer changes.
// Hot-reload safe — added on demand, cleared on dispose.
function notifyLayersChanged() {
  for (const fn of viewport.layersListeners) fn({ ...viewport.layers });
}

async function ensureViewport() {
  if (viewport.initPromise) return viewport.initPromise;
  viewport.initPromise = (async () => {
    // Wait for the lazy engine to actually exist before touching its state.
    // ViewportPanel mounts immediately after the user picks a project, often
    // before EditorChrome's ensureEngine() callback has resolved.
    const engine = await ensureEngine();

    const canvas = document.createElement("canvas");
    canvas.className = "viewport-canvas";
    viewport.canvas = canvas;

    try {
      viewport.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
      viewport.camera.position.set(7, 5, 9);
      // Editor camera must see the editor-only layer (camera model, gizmo,
      // grid, selection box, frustum helper). Without this, those objects
      // wouldn't render even though they live in the scene tree.
      viewport.camera.layers.enable(EDITOR_LAYER);

      viewport.backend = await engine.init(canvas);
      engine.camera = viewport.camera;
      console.log(`Renderer backend: ${viewport.backend}`);
      logToHost(`Renderer backend: ${viewport.backend}`);

      const helpers = new THREE.Group();
      helpers.userData.editorOnly = true;
      engine.scene.add(helpers);
      viewport.helpers = helpers;
      rebuildGrid(getProjectSettings().editor);
      // After grid is attached, push the whole subtree onto the editor
      // layer. Doing this here (rather than before adding the grid) means
      // the grid also gets put on layer 31, since layers aren't inherited
      // from the parent in three.js.
      putOnEditorLayer(helpers);
      // Grid size/visibility follow project settings live.
      onProjectSettingsApplied((settings) => rebuildGrid(settings.editor));

      viewport.orbit = new OrbitControls(viewport.camera, canvas);
      viewport.orbit.enableDamping = true;
      viewport.orbit.dampingFactor = 0.12;

      setupGizmo(canvas);
      setupPicking(canvas);
      setupTerrainBrush(canvas);
      setupKeyboard(canvas);
      // While a sculpt/paint brush is armed, hide the transform gizmo so its
      // arrow handles can't intercept brush strokes on the terrain mesh.
      subscribeTerrainBrush(() => {
        const armed = !!getTerrainBrushMode();
        viewport.gizmo.enabled = !armed;
        viewport.gizmo.getHelper().visible = !armed;
      });
      setupPlayCamera();
      setupCameraPreview();

      // Layer-toggle sub-systems. Gizmo + grid live in `viewport.*` and
      // are picked up by `applyLayerVisibility`; colliders come from
      // individual components attached at any time, so we sync them
      // whenever the scene tree changes.
      applyLayerVisibility();
      const unsubHierarchy = engine.on("hierarchy-changed", () => {
        // Cheap-ish — walks every entity looking for a collider.
        // Sets visibility to the user's current preference; new colliders
        // added since the last tick get their `visible` corrected here.
        setCollidersVisible(viewport.layers.colliders);

        // Some operations rebuild an entity's Object3D while keeping its id —
        // prefab respawns (apply / revert / a prefab asset changing) destroy
        // the subtree and re-expand it. `attachSelection` only re-runs on a
        // *selection* change, so the gizmo would still be holding the destroyed
        // object ("TransformControls: The attached 3D object must be a part of
        // the scene graph"). Re-attach when the object under the selection has
        // been swapped out.
        const selectedId = useSelectionStore.getState().ids[0] ?? null;
        const selected = selectedId ? engine.getEntity(selectedId) : null;
        if (selected && viewport.gizmo.object && viewport.gizmo.object !== selected.object3D) {
          attachSelection(selectedId);
        }
      });

      engine.onUpdate(() => {
        viewport.orbit.update();
        viewport.selectionBox?.update();
        viewport.cameraHelper?.update();
        // The light helper samples the live THREE.Light on every update(), so
        // calling it each frame keeps the cone / arrow aligned with the
        // entity's current transform and the spot angle in sync with the
        // component props. Per-frame is overkill for static lights, but
        // cost is negligible (a handful of vector writes).
        viewport.lightHelper?.update();
        // Re-resolve "follow target" before the main render so the
        // PIP preview and the orbit view both see the post-follow
        // camera pose. In play mode the engine.camera is the scene
        // camera itself; in editor mode it's the orbit camera (which
        // isn't affected). Cheap enough to run unconditionally.
        applyCameraFollow();
        // Refresh the camera matrix and the gizmo helper's matrix world here
        // so pointer events received between this tick and the render still see
        // fresh transform data. Without this, a pointermove fired right after
        // a `dragging-changed` toggle could raycast against a camera matrix
        // from two frames ago, missing the picker meshes entirely.
        viewport.camera.updateMatrixWorld();
        viewport.gizmo?.getHelper()?.updateMatrixWorld();
      });

      engine.start();
      // Renderer-side project settings (pixel ratio cap) can only apply now.
      applyProjectSettings().catch(() => {});
      return viewport.backend;
    } catch (err) {
      console.error("Viewport init failed:", err);
      logToHost(`Viewport init failed: ${err?.message ?? err}`);
      throw err;
    }
  })();
  return viewport.initPromise;
}

async function logToHost(message) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("frontend_log", { message });
  } catch {
    // Not running inside Tauri (plain browser dev) — terminal log unavailable.
  }
}

function setupGizmo(canvas) {
  const gizmo = new TransformControls(viewport.camera, canvas);
  viewport.gizmo = gizmo;
  // TransformControls owns its own internal raycaster (getRaycaster())
  // which defaults to testing only layer 0. The helper, including the
  // picker meshes that drive axis detection, is moved onto EDITOR_LAYER
  // below so play-mode cameras (and the PIP camera) don't render it.
  // Without enabling every layer here, that picker is invisible to the
  // gizmo's own raycaster — pointerHover finds nothing, `axis` stays
  // null, pointerDown bails out, and the visible arrows never react.
  gizmo.getRaycaster().layers.enableAll();
  const helper = gizmo.getHelper();
  // The helper's `updateMatrixWorld` cancels out the parent's transform so
  // the gizmo stays world-aligned, which depends on its parent (engine.scene)
  // having a current matrixWorld. Scene defaults to identity so this is fine,
  // but we still call it once so the first `pointermove` doesn't have to wait
  // a frame before the picker positions are at the entity location.
  helper.matrixAutoUpdate = true;
  helper.updateMatrixWorld(true);
  engine.scene.add(helper);
  helper.userData.editorOnly = true;
  putOnEditorLayer(helper);
  // Force the camera matrix to be fresh so the gizmo's internal raycaster
  // uses the latest view the very first time pointerHover runs. Cheap, but
  // prevents any "stale matrixWorld between init and the first pointer event"
  // class of bug from blocking axis detection.
  viewport.camera.updateMatrixWorld(true);

  let beforeTransform = null;
  gizmo.addEventListener("dragging-changed", (e) => {
    viewport.orbit.enabled = !e.value;
    const entityId = gizmo.object?.userData.entityId;
    if (!entityId) return;
    if (e.value) {
      beforeTransform = engine.getEntity(entityId).getTransform();
    } else if (beforeTransform) {
      const after = engine.getEntity(entityId).getTransform();
      commandBus.execute(new SetTransformCommand(entityId, after, beforeTransform));
      beforeTransform = null;
    }
  });
  gizmo.addEventListener("objectChange", () => {
    const entityId = gizmo.object?.userData.entityId;
    if (entityId) useSceneStore.getState().updateTransform(entityId);
  });

  // Hold Ctrl to snap: 0.5 units / 15° / 0.1 scale.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Control") setSnap(true);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Control") setSnap(false);
  });

  useSelectionStore.subscribe((state) => attachSelection(state.ids[0] ?? null));
  engine.on("play-changed", () => attachSelection(useSelectionStore.getState().ids[0] ?? null));
  // Rebuild the light helper when the selected light's `kind` changes —
  // the component replaces its underlying THREE.Light instance on kind
  // change (onPropChanged detaches+reattaches), so any helper bound to
  // the previous light would render against stale geometry. Other prop
  // changes (color, angle, distance, intensity) mutate the existing
  // light in place and are picked up by the per-frame helper.update().
  engine.on("component-changed", ({ entityId, componentType, key }) => {
    if (componentType !== "light" || key !== "kind") return;
    const selectedId = useSelectionStore.getState().ids[0];
    if (entityId !== selectedId) return;
    const entity = engine.getEntity(entityId);
    const lightComponent = entity?.getComponent?.("light");
    if (lightComponent) attachLightHelper(lightComponent);
    else detachLightHelper();
  });
}

/** First entity (depth-first) carrying a camera component, or null. */
function findSceneCamera() {
  for (const root of engine.rootEntities) {
    let found = null;
    root.traverse((e) => {
      if (!found && e.getComponent("camera")) found = e;
    });
    if (found) return found;
  }
  return null;
}

/** Switches rendering between the editor's orbit camera and the scene's own
 * camera entity for Play mode, and hides editor-only helpers/gizmos so the
 * viewport shows what the game actually looks like. */
function setupPlayCamera() {
  engine.on("play-changed", (playing) => {
    if (viewport.helpers) viewport.helpers.visible = !playing;
    if (viewport.cameraPreview) viewport.cameraPreview.setVisible(!playing);
    // Gizmo + selectionBox visibility is owned by `applyLayerVisibility`
    // — it AND-combines the user's Gizmo toggle with the editor-vs-play
    // rule so flipping the dropdown takes effect both in and out of play.
    applyLayerVisibility();

    if (playing) {
      const camEntity = findSceneCamera();
      if (camEntity) {
        viewport.gameCameraId = camEntity.id;
        engine.camera = camEntity.getComponent("camera").camera;
        // Game camera must not render editor-only objects (camera models,
        // gizmos, grid, frustum helpers). Disable just the editor layer
        // so any game-side layers the user enabled still work.
        engine.camera.layers.disable(EDITOR_LAYER);
      } else {
        viewport.gameCameraId = null;
        console.warn("No Camera entity in the scene — showing the editor camera during Play.");
        // No scene camera — keep using the editor camera so play is
        // still observable; do NOT disable its EDITOR_LAYER or the
        // camera model would vanish for this branch.
      }
      viewport.orbit.enabled = false;
    } else {
      viewport.gameCameraId = null;
      engine.camera = viewport.camera;
      // Editor camera sees every layer — make sure EDITOR_LAYER is on so
      // helpers / the camera model reappear when returning from Play.
      viewport.camera.layers.enable(EDITOR_LAYER);
      viewport.orbit.enabled = true;
    }
    resizeActiveCamera();
  });
}

function resizeActiveCamera() {
  if (!viewport.canvas || !engine.camera?.isPerspectiveCamera) return;
  const { width, height } = viewport.canvas;
  if (!width || !height) return;
  engine.camera.aspect = width / height;
  engine.camera.updateProjectionMatrix();
}

/**
 * Per-frame editor-time camera-follow tick.
 *
 * Drives `followInViewport` for every camera component: when the engine
 * is not playing, cameras with this flag look at their target. The
 * sibling flag `followInGame` is handled by CameraComponent itself, so
 * the shipped player honors it without dragging the editor into the
 * runtime. (Camera components only subscribe to onUpdate when attached,
 * so the editor can pass through without redoing work.)
 *
 * Iterates every entity with a camera component so multiple cameras
 * with follow enabled all update in one pass. The cost is tiny (one
 * vector read + one matrix write per active camera).
 */
function applyCameraFollow() {
  // Skip the editor's pass when the game is running — the component-level
  // onUpdate is in charge of followInGame then.
  if (engine.playing) return;
  for (const entity of engine.entities.values()) {
    const cam = entity.getComponent?.("camera");
    if (!cam) continue;
    cam.applyLookAt(!!cam.props.followInViewport, engine);
  }
}

/**
 * Picture-in-picture render of whatever the selected camera entity is
 * currently seeing. We don't use a separate render target — instead we
 * draw the camera's view into a small region of the editor's own WebGPU
 * canvas (via setViewport + setScissor), then overlay a DOM border/label
 * over that exact spot. Drawing into the same canvas keeps everything on
 * the same renderer instance, sidesteps async pixel-readback quirks, and
 * means the preview always renders in lock-step with the main view.
 *
 * The CSS class `.camera-preview-frame` (see theme.css) is a DOM element
 * positioned exactly over the canvas sub-region to provide the rounded
 * border + box-shadow; the actual pixels live on the canvas.
 *
 * Editor-only objects (camera model, gizmo, grid, frustum helper) live on
 * `EDITOR_LAYER` and are temporarily hidden from the preview camera via
 * `hideEditorOnly` AND by disabling that layer on the camera, so they
 * never leak into the PIP view.
 */
const PREVIEW_FRACTION = 0.28; // ~28% of viewport height
const PREVIEW_ASPECT = 16 / 9;
const PREVIEW_MARGIN = 18; // px from the corner

class CameraPreview {
  constructor(renderer) {
    this.renderer = renderer;
    this.camera = null;
    this.component = null; // CameraComponent reference — drives showPreview flag
    this.visible = false;
    this.disposed = false;
  }

  setCamera(threeCamera, component = null) {
    this.camera = threeCamera ?? null;
    this.component = component;
    this.updateVisible();
  }

  setVisible(visible) {
    this.visible = !!visible;
    this.updateVisible();
  }

  updateVisible() {
    const componentWantsPreview = this.component ? this.component.props.showPreview !== false : true;
    const show = !!this.camera && this.visible && !engine.playing && componentWantsPreview;
    if (this.frame) this.frame.style.display = show ? "block" : "none";
  }

  dispose() {
    this.disposed = true;
    if (this.frame) this.frame.remove();
  }

  renderFrame() {
    if (this.disposed || !this.camera || !this.renderer) return;
    if (engine.playing) return;
    const componentWantsPreview = this.component ? this.component.props.showPreview !== false : true;
    if (!componentWantsPreview) {
      this.updateVisible();
      return;
    }
    const canvas = viewport.canvas;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;

    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (!cssW || !cssH) return;

    const previewH = Math.round(cssH * PREVIEW_FRACTION);
    const previewW = Math.round(previewH * PREVIEW_ASPECT);
    const x = Math.max(0, Math.round(cssW - previewW - PREVIEW_MARGIN));
    const y = Math.max(0, Math.round(cssH - previewH - PREVIEW_MARGIN));
    const w = previewW;
    const h = previewH;

    const cam = this.camera;
    const aspect = w / h;
    if (Math.abs(cam.aspect - aspect) > 0.001) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }

    // Sync the DOM frame so its border aligns with the canvas sub-region.
    // CSS uses a top-left origin while three.js uses a bottom-left origin,
    // so flip y when positioning the frame.
    if (this.frame) {
      this.frame.style.width = `${w}px`;
      this.frame.style.height = `${h}px`;
      this.frame.style.left = `${x}px`;
      this.frame.style.top = `${Math.max(0, cssH - y - h)}px`;
    }

    // Save renderer state we touch; restore in finally so the next frame's
    // main render starts from the default state again.
    const prevViewport = new THREE.Vector4();
    this.renderer.getViewport(prevViewport);
    const prevScissor = new THREE.Vector4();
    this.renderer.getScissor(prevScissor);
    const prevScissorTest = this.renderer.getScissorTest();
    // The WebGPU backend's render pass starts with `loadOp: Clear` when
    // autoClearColor is on, which would wipe the main scene we just
    // rendered. Flip autoClearColor off (but leave autoClearDepth on so
    // the PIP still has a fresh depth buffer for its own draws).
    const prevAutoClear = this.renderer.autoClear;
    const prevAutoClearColor = this.renderer.autoClearColor;
    const prevAutoClearDepth = this.renderer.autoClearDepth;

    const hidden = hideEditorOnly(engine.scene);
    const prevEnabled = cam.layers.test(EDITOR_LAYER);
    cam.layers.disable(EDITOR_LAYER);
    try {
      this.renderer.setViewport(x, y, w, h);
      this.renderer.setScissor(x, y, w, h);
      this.renderer.setScissorTest(true);
      this.renderer.autoClear = false;
      this.renderer.autoClearColor = engine.renderer.autoClearColor;
      this.renderer.autoClearDepth = true;
      this.renderer.render(engine.scene, cam);
    } finally {
      this.renderer.autoClear = prevAutoClear;
      this.renderer.autoClearColor = prevAutoClearColor;
      this.renderer.autoClearDepth = prevAutoClearDepth;
      if (prevEnabled) cam.layers.enable(EDITOR_LAYER);
      restoreHidden(hidden);
      this.renderer.setScissorTest(prevScissorTest);
      this.renderer.setScissor(prevScissor);
      this.renderer.setViewport(prevViewport);
    }
  }
}

/** Lazily creates the DOM frame (border + label) that sits over the
 *  canvas sub-region. Returned element is appended to the viewport-panel
 *  container so it follows canvas resize. */
function ensurePreviewFrame() {
  const existing = document.querySelector(".camera-preview-frame");
  if (existing) return existing;
  const host = document.querySelector(".viewport-panel");
  if (!host) return null;
  const frame = document.createElement("div");
  frame.className = "camera-preview-frame";
  frame.style.display = "none";
  frame.style.pointerEvents = "none";
  host.appendChild(frame);
  return frame;
}

/**
 * Collects every top-most editor-only subtree under `root` and hides them,
 * returning a flat list of `{ obj, prev }` so callers can restore visibility
 * via `restoreHidden`. A node is "top-most editor-only" if its own
 * userData.editorOnly is set AND no ancestor in the path has it set, so we
 * hide the root of each helper region (e.g. viewport.helpers) rather than
 * walking every leaf inside it.
 */
function hideEditorOnly(root) {
  const hidden = [];
  root.traverse((obj) => {
    if (!obj.userData?.editorOnly) return;
    // Skip if an ancestor already hid everything above us.
    for (let p = obj.parent; p && p !== root; p = p.parent) {
      if (p.userData?.editorOnly) return;
    }
    hidden.push({ obj, prev: obj.visible });
    obj.visible = false;
  });
  return hidden;
}

function restoreHidden(hidden) {
  for (const { obj, prev } of hidden) obj.visible = prev;
}

function setupCameraPreview() {
  if (!engine.renderer || !viewport.canvas) return;
  if (viewport.cameraPreview) return;
  viewport.cameraPreview = new CameraPreview(engine.renderer);

  engine.onPostRender(() => {
    viewport.cameraPreview?.renderFrame();
  });
}

/** (Re)creates the ground grid from editor settings. */
function rebuildGrid(editorSettings) {
  const helpers = viewport.helpers;
  if (!helpers) return;
  if (viewport.grid) {
    helpers.remove(viewport.grid);
    viewport.grid.geometry.dispose();
    viewport.grid.material.dispose();
    viewport.grid = null;
  }
  if (editorSettings.showGrid === false) return;
  viewport.grid = new THREE.GridHelper(
    editorSettings.gridSize ?? 40,
    editorSettings.gridDivisions ?? 40,
    0x4a5060,
    0x2c3038,
  );
  helpers.add(viewport.grid);
  // New meshes inherit the layer-toggle visibility — the dropdown can hide
  // a freshly-rebuilt grid without another rebuild pass.
  viewport.grid.visible = viewport.layers.grid;
}

/**
 * Walks every entity in the scene and applies `visible` to its
 * `ColliderComponent.gizmo` (the green wireframe outline on
 * EDITOR_LAYER). The component owns the gizmo Object3D — we don't
 * tear it down, only flip `visible` so toggling is instant and
 * reversible.
 */
function setCollidersVisible(visible) {
  for (const entity of engine.entities.values()) {
    const collider = entity.getComponent?.("collider");
    if (!collider?.gizmo) continue;
    collider.gizmo.visible = visible;
  }
}

/**
 * Apply all three Layers-toggle states at once. Used both at init
 * (to honor any default toggles) and after the dropdown flips one.
 * Gizmo + selectionBox live as singletons on `viewport.*`, so they're
 * controlled directly; colliders are per-component so we walk.
 */
function applyLayerVisibility() {
  const { gizmos, colliders, grid } = viewport.layers;
  const gizmoHelper = viewport.gizmo?.getHelper();
  if (gizmoHelper) gizmoHelper.visible = gizmos && !engine.playing;
  if (viewport.selectionBox) viewport.selectionBox.visible = gizmos && !engine.playing;
  if (viewport.grid) viewport.grid.visible = grid;
  setCollidersVisible(colliders);
}

// Hydrate `viewport.layers` from project settings (settings.editor.layers)
// on every apply. Used at boot and when the user changes settings in the
// project settings panel. We only call `applyLayerVisibility` +
// `notifyLayersChanged` if the value actually differs, so a no-op apply
// (which happens after every `setLayerVisible` write) doesn't trigger
// React re-renders.
onProjectSettingsApplied((settings) => {
  const incoming = settings?.editor?.layers;
  if (!incoming) return;
  let next = viewport.layers;
  for (const { key } of LAYER_TOGGLES) {
    if (key in incoming && incoming[key] !== next[key]) {
      next = { ...next, [key]: !!incoming[key] };
    }
  }
  if (next === viewport.layers) return;
  viewport.layers = next;
  if (viewport.initPromise) {
    applyLayerVisibility();
    notifyLayersChanged();
  }
});

// Persist `viewport.layers` into project.json so the user's preferred
// view survives reloads / sessions. The project settings panel already
// uses `updateMeta` for similar "fire and forget" saves; we do the same
// here, fanning the write into the existing `settings.editor.layers`
// slot without going through `applyProjectSettings` (which would re-run
// every settings listener for what's really just a viewport state change).
function persistLayersNow() {
  // Lazy import — projectStore touches the Tauri bridge which only exists
  // in the built editor, and avoiding it during module init keeps tests
  // and pure-JS tooling happy.
  import("../store/projectStore.js")
    .then(({ useProjectStore }) => {
      const current = getProjectSettings();
      return useProjectStore.getState().updateMeta({
        settings: { ...current, editor: { ...current.editor, layers: { ...viewport.layers } } },
      });
    })
    .catch((err) => console.warn(`Couldn't persist layers to project.json: ${err}`));
}

/**
 * Single entry point the React toolbar uses to flip a layer toggle.
 * Mutates `viewport.layers`, makes the visible change take effect,
 * notifies subscribers, and persists the new state to project.json.
 */
export function setLayerVisible(key, visible) {
  if (!(key in viewport.layers)) return;
  if (viewport.layers[key] === visible) return;
  viewport.layers = { ...viewport.layers, [key]: visible };
  applyLayerVisibility();
  notifyLayersChanged();
  persistLayersNow();
}

/** Subscribe to layer-toggle changes. Returns an unsubscribe. */
export function subscribeLayers(fn) {
  viewport.layersListeners.add(fn);
  return () => viewport.layersListeners.delete(fn);
}

function setSnap(enabled) {
  const g = viewport.gizmo;
  const s = getProjectSettings().editor;
  g.setTranslationSnap(enabled ? s.snapTranslate : null);
  g.setRotationSnap(enabled ? THREE.MathUtils.degToRad(s.snapRotateDeg) : null);
  g.setScaleSnap(enabled ? s.snapScale : null);
}

/** True for entities whose transform is UI-layout-driven — the 3D gizmo,
 *  selection box and focus fly-to make no sense for them. */
function isUiEntity(entity) {
  return !!(entity?.getComponent?.("uielement") || entity?.getComponent?.("uiscreen"));
}

function attachSelection(entityId) {
  const entity = entityId ? engine.getEntity(entityId) : null;
    if (viewport.selectionBox) {
      engine.scene.remove(viewport.selectionBox);
      viewport.selectionBox.dispose();
      viewport.selectionBox = null;
    }
    detachCameraHelper();
    detachLightHelper();
  // UI entities get a 2D rect outline (drawn by the UiSystem overlay pass)
  // instead of the 3D gizmo + bounding box.
  const uiSystem = getUiSystem(engine, { create: false });
  uiSystem?.setHighlight(entity && !engine.playing && isUiEntity(entity) ? entity.id : null);
  if (!entity || engine.playing || isUiEntity(entity)) {
    viewport.gizmo.detach();
    viewport.cameraPreview?.setCamera(null);
    return;
  }
  // Make sure the entity's matrixWorld is current before we attach. Without
  // this, the very first frame after selection would show the gizmo arrows
  // at the entity's OLD world position (wherever it was on the previous
  // render), and any pointermove fired before the next render would raycast
  // against that stale position — making the gizmo look broken for one
  // frame after every selection change.
  entity.object3D.updateMatrixWorld(true);
  viewport.gizmo.attach(entity.object3D);
  // Pull the gizmo helper's matrix world up to date immediately so its
  // picker meshes are at the entity's position right away, instead of
  // one frame later.
  viewport.gizmo.getHelper().updateMatrixWorld(true);
  const cameraComponent = entity.getComponent?.("camera");
  const lightComponent = entity.getComponent?.("light");
  // Cameras skip the bounding-box outline: the entity itself is a single
  // Object3D whose only children are the PerspectiveCamera and the
  // editor-only model mesh, so a Box3 over the subtree just brackets the
  // lens/body silhouette and clutters the view. The frustum helper
  // (attached below) already shows the camera's position + facing, which
  // is the visual cue users actually want for a camera entity.
  if (!cameraComponent?.camera && !lightComponent?.light) {
    const bounds = new THREE.Box3().setFromObject(entity.object3D);
    if (!bounds.isEmpty()) {
      viewport.selectionBox = new THREE.BoxHelper(entity.object3D, 0x4da3ff);
      viewport.selectionBox.userData.editorOnly = true;
      // Tag with the entity id so clicking the selection box (which is
      // editor-only and short-circuits findEntityId by default) still
      // resolves to the selected entity.
      viewport.selectionBox.userData.entityId = entity.id;
      putOnEditorLayer(viewport.selectionBox);
      engine.scene.add(viewport.selectionBox);
    }
  }
  if (cameraComponent?.camera) {
    attachCameraHelper(cameraComponent.camera);
    // Honor the camera component's own preview toggle: even with the
    // camera selected, the user can suppress the PIP via the inspector
    // checkbox. setCamera below still hands the camera to the preview
    // (so re-enabling is a single click), but updateVisible() reads
    // the component's showPreview flag.
    viewport.cameraPreview?.setCamera(cameraComponent.camera, cameraComponent);
  } else {
    viewport.cameraPreview?.setCamera(null);
  }
  if (lightComponent?.light) {
    attachLightHelper(lightComponent);
  }
  // Newly-attached gizmo + selectionBox must honor the Gizmos toggle
  // (and stop hiding in Play). Re-applying the layer state overrides
  // any default `visible: true` from above with the user's choice.
  applyLayerVisibility();
}

/** Adds a CameraHelper (frustum lines) for the given three.js camera. */
function attachCameraHelper(camera) {
  detachCameraHelper();
  const helper = new THREE.CameraHelper(camera);
  helper.userData.editorOnly = true;
  putOnEditorLayer(helper);
  // Recolor the frustum to match the selection blue so it doesn't fight
  // with the editor's neutral helpers (grid, BoxHelper).
  helper.setColors(0x4da3ff, 0x4da3ff, 0x4da3ff, 0x4da3ff, 0x4da3ff);
  helper.update();
  engine.scene.add(helper);
  viewport.cameraHelper = helper;
}

function detachCameraHelper() {
  if (!viewport.cameraHelper) return;
  engine.scene.remove(viewport.cameraHelper);
  viewport.cameraHelper.dispose();
  viewport.cameraHelper = null;
}

/**
 * Builds the editor-only visualization for the currently selected light
 * entity. The shape depends on the light's kind, matching what three.js's
 * built-in helpers were designed for:
 *
 *   - directional -> DirectionalLightHelper (arrow + planes)
 *   - spot        -> SpotLightHelper        (cone)
 *   - point       -> PointLightHelper       (small wireframe sphere)
 *   - ambient     -> no helper (no spatial meaning)
 *
 * The helper is parented to `engine.scene` (not the entity) because the
 * underlying three.js helpers reach up to the *light's* matrixWorld when
 * `update()` runs; an extra indirection through the entity would just
 * duplicate the same transform without buying anything. Tagging
 * `userData.entityId` lets `findEntityId` resolve a click on the helper
 * back to the owning entity so users can re-select it.
 */
function attachLightHelper(lightComponent) {
  detachLightHelper();
  const light = lightComponent.light;
  if (!light) return;
  const kind = lightComponent.props.kind;
  let helper = null;
  if (kind === "directional" && light.isDirectionalLight) {
    helper = new THREE.DirectionalLightHelper(light, 5);
  } else if (kind === "spot" && light.isSpotLight) {
    helper = new THREE.SpotLightHelper(light, 5);
  } else if (kind === "point" && light.isPointLight) {
    helper = new THREE.PointLightHelper(light, 0.3);
  }
  if (!helper) return;
  helper.userData.editorOnly = true;
  helper.userData.entityId = lightComponent.entity.id;
  helper.update();
  putOnEditorLayer(helper);
  engine.scene.add(helper);
  viewport.lightHelper = helper;
}

function detachLightHelper() {
  if (!viewport.lightHelper) return;
  engine.scene.remove(viewport.lightHelper);
  viewport.lightHelper.dispose?.();
  viewport.lightHelper = null;
}

function setupPicking(canvas) {
  const raycaster = new THREE.Raycaster();
  // Pick against every layer so the camera model (EDITOR_LAYER), gizmo
  // helpers, etc. are still selectable — they only differ from the rest
  // of the scene by which camera renders them, not by whether clicks land
  // on them.
  raycaster.layers.enableAll();
  const pointer = new THREE.Vector2();
  let downPos = null;

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 0 && !getTerrainBrushMode()) downPos = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (e.button !== 0 || !downPos || viewport.terrainBrushing) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved > 4 || viewport.gizmo.dragging || engine.playing) return;

    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, viewport.camera);
    const hits = raycaster.intersectObjects(engine.scene.children, true);
    for (const hit of hits) {
      const entityId = findEntityId(hit.object);
      if (entityId) {
        useSelectionStore.getState().select(entityId);
        return;
      }
    }
    useSelectionStore.getState().clear();
  });
}

const BRUSH_INDICATOR_SEGMENTS = 64;
const BRUSH_PREVIEW_RINGS = 6;
const SCULPT_TOOL_COLORS = {
  raise: 0x4caf50,
  lower: 0xff5252,
  smooth: 0x29b6f6,
  flatten: 0xab47bc,
  sharpen: 0xffa726,
  erode: 0x8d6e63,
  noise: 0x26c6da,
};
const PAINT_COLOR = 0xffca28;
const ERASE_COLOR = 0xff5252;
const SCATTER_COLOR = 0x80ff72;

/**
 * Lazily builds the terrain brush cursor: a translucent filled disc plus a
 * bright rim ring, both projected onto the live terrain surface so they read
 * on slopes. Editor-only layer, never raycast-picked, drawn on top
 * (depthTest off + high renderOrder) so it's always visible.
 */
function ensureBrushIndicator() {
  if (viewport.terrainBrushIndicator) return viewport.terrainBrushIndicator;
  const N = BRUSH_INDICATOR_SEGMENTS;

  // Concentric rings let the fill show the predicted post-stroke surface.
  const fillGeo = new THREE.BufferGeometry();
  fillGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((1 + BRUSH_PREVIEW_RINGS * N) * 3), 3));
  const fillIndex = [];
  for (let i = 0; i < N; i++) fillIndex.push(0, 1 + i, 1 + ((i + 1) % N));
  for (let ring = 1; ring < BRUSH_PREVIEW_RINGS; ring++) {
    const inner = 1 + (ring - 1) * N;
    const outer = 1 + ring * N;
    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N;
      fillIndex.push(inner + i, outer + i, outer + next, inner + i, outer + next, inner + next);
    }
  }
  fillGeo.setIndex(fillIndex);
  const fill = new THREE.Mesh(
    fillGeo,
    new THREE.MeshBasicMaterial({
      color: PAINT_COLOR, transparent: true, opacity: 0.15,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }),
  );

  // Rim: an explicitly closed line. WebGPURenderer does not support
  // THREE.LineLoop, so vertex N duplicates vertex 0.
  const rimGeo = new THREE.BufferGeometry();
  rimGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
  const rim = new THREE.Line(
    rimGeo,
    new THREE.LineBasicMaterial({ color: PAINT_COLOR, transparent: true, opacity: 0.95, depthTest: false }),
  );

  // Core: a second line loop at the falloff's half-strength radius, so the
  // gap between the two rings reads the brush hardness (soft = wide gap,
  // hard = tight inner ring hugging the rim) — the Unity/Unreal brush cursor.
  const coreGeo = new THREE.BufferGeometry();
  coreGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
  const core = new THREE.Line(
    coreGeo,
    new THREE.LineBasicMaterial({ color: PAINT_COLOR, transparent: true, opacity: 0.6, depthTest: false }),
  );

  // Predicted contour rings and current→predicted displacement ticks make
  // small sculpt deltas legible even when the translucent surface nearly
  // overlaps the terrain.
  const outcomeGeo = new THREE.BufferGeometry();
  outcomeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(BRUSH_PREVIEW_RINGS * N * 2 * 3), 3));
  const outcome = new THREE.LineSegments(
    outcomeGeo,
    new THREE.LineBasicMaterial({ color: PAINT_COLOR, transparent: true, opacity: 0.65, depthTest: false }),
  );
  const deltaSampleCount = 1 + BRUSH_PREVIEW_RINGS * 8;
  const deltaGeo = new THREE.BufferGeometry();
  deltaGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(deltaSampleCount * 2 * 3), 3));
  const delta = new THREE.LineSegments(
    deltaGeo,
    new THREE.LineBasicMaterial({ color: PAINT_COLOR, transparent: true, opacity: 0.95, depthTest: false }),
  );

  const group = new THREE.Group();
  const scatter = new THREE.Group();
  group.add(fill, outcome, delta, rim, core, scatter);
  group.visible = false;
  group.renderOrder = 999;
  group.userData.editorOnly = true;
  for (const o of [group, fill, outcome, delta, rim, core, scatter]) {
    o.layers.set(EDITOR_LAYER);
    o.raycast = () => {};
  }
  engine.scene.add(group);
  viewport.terrainBrushIndicator = {
    group, fill, outcome, delta, rim, core, scatter,
    fillGeo, outcomeGeo, deltaGeo, rimGeo, coreGeo, scatterKey: "",
  };
  return viewport.terrainBrushIndicator;
}

/**
 * Re-projects the cursor onto the current terrain surface at `local`
 * (entity-local XZ), sampling live heights so it hugs mid-stroke deformation.
 *
 * Two cues read the brush parameters the way Unity/Unreal's do:
 *   - fill opacity scales with `strength` (0.06 → 0.4) so a stronger brush
 *     visibly "fills in" more solidly;
 *   - the inner core ring sits at the falloff's half-strength radius, derived
 *     from `hardness` (exp = lerp(0.4, 4, hardness), matching applyHeightBrush):
 *     r½ = radius · (1 − 0.5^(1/exp)). A soft brush pushes the ring inward
 *     (wide gradient band); a hard brush pulls it out toward the rim.
 */
function updateBrushIndicator(component, local, radius, color, strength = 0.5, hardness = 0.5, preview = null) {
  const ind = ensureBrushIndicator();
  const N = BRUSH_INDICATOR_SEGMENTS;
  ind.fill.material.color.setHex(color);
  ind.outcome.material.color.setHex(color);
  ind.delta.material.color.setHex(color);
  ind.rim.material.color.setHex(color);
  ind.core.material.color.setHex(color);
  ind.fill.material.opacity = THREE.MathUtils.lerp(0.06, 0.4, THREE.MathUtils.clamp(strength, 0, 1));
  ind.fill.visible = false;

  const exp = THREE.MathUtils.lerp(0.4, 4, THREE.MathUtils.clamp(hardness, 0, 1));
  const coreRadius = radius * (1 - Math.pow(0.5, 1 / exp));

  const fillPos = ind.fillGeo.attributes.position;
  const rimPos = ind.rimGeo.attributes.position;
  const corePos = ind.coreGeo.attributes.position;
  const outcomePos = ind.outcomeGeo.attributes.position;
  const deltaPos = ind.deltaGeo.attributes.position;
  const v = new THREE.Vector3();
  const previewHeight = (x, z) => preview?.mode === "sculpt"
    ? component.previewHeightAtLocal(x, z, local, preview)
    : component.heightAtLocal(x, z);

  // Fill center.
  v.set(local.x, previewHeight(local.x, local.z) + 0.04, local.z);
  component.mesh.localToWorld(v);
  fillPos.setXYZ(0, v.x, v.y, v.z);

  for (let ring = 0; ring < BRUSH_PREVIEW_RINGS; ring++) {
    const ringRadius = radius * ((ring + 1) / BRUSH_PREVIEW_RINGS);
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2;
      const lx = local.x + Math.cos(angle) * ringRadius;
      const lz = local.z + Math.sin(angle) * ringRadius;
      v.set(lx, previewHeight(lx, lz) + 0.04, lz);
      component.mesh.localToWorld(v);
      fillPos.setXYZ(1 + ring * N + i, v.x, v.y, v.z);
      if (ring === BRUSH_PREVIEW_RINGS - 1) rimPos.setXYZ(i, v.x, v.y, v.z);
    }
  }

  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);

    // Core ring — same angle, half-strength radius, hugging the surface.
    const cx = local.x + ca * coreRadius;
    const cz = local.z + sa * coreRadius;
    v.set(cx, previewHeight(cx, cz) + 0.045, cz);
    component.mesh.localToWorld(v);
    corePos.setXYZ(i, v.x, v.y, v.z);
  }
  // Close both polylines explicitly for WebGPU.
  rimPos.setXYZ(N, rimPos.getX(0), rimPos.getY(0), rimPos.getZ(0));
  corePos.setXYZ(N, corePos.getX(0), corePos.getY(0), corePos.getZ(0));

  const sculpting = preview?.mode === "sculpt";
  ind.outcome.visible = sculpting;
  ind.delta.visible = sculpting;
  if (sculpting) {
    let outcomeVertex = 0;
    for (let ring = 0; ring < BRUSH_PREVIEW_RINGS; ring++) {
      for (let i = 0; i < N; i++) {
        const a = 1 + ring * N + i;
        const b = 1 + ring * N + ((i + 1) % N);
        outcomePos.setXYZ(outcomeVertex++, fillPos.getX(a), fillPos.getY(a) + 0.012, fillPos.getZ(a));
        outcomePos.setXYZ(outcomeVertex++, fillPos.getX(b), fillPos.getY(b) + 0.012, fillPos.getZ(b));
      }
    }
    let deltaVertex = 0;
    const writeDelta = (lx, lz, predictedIndex) => {
      v.set(lx, component.heightAtLocal(lx, lz) + 0.025, lz);
      component.mesh.localToWorld(v);
      deltaPos.setXYZ(deltaVertex++, v.x, v.y, v.z);
      deltaPos.setXYZ(
        deltaVertex++,
        fillPos.getX(predictedIndex),
        fillPos.getY(predictedIndex) + 0.025,
        fillPos.getZ(predictedIndex),
      );
    };
    writeDelta(local.x, local.z, 0);
    for (let ring = 0; ring < BRUSH_PREVIEW_RINGS; ring++) {
      const ringRadius = radius * ((ring + 1) / BRUSH_PREVIEW_RINGS);
      for (let sample = 0; sample < 8; sample++) {
        const i = sample * (N / 8);
        const angle = (i / N) * Math.PI * 2;
        writeDelta(
          local.x + Math.cos(angle) * ringRadius,
          local.z + Math.sin(angle) * ringRadius,
          1 + ring * N + i,
        );
      }
    }
    outcomePos.needsUpdate = true;
    deltaPos.needsUpdate = true;
    ind.outcomeGeo.computeBoundingSphere();
    ind.deltaGeo.computeBoundingSphere();
  }
  fillPos.needsUpdate = true;
  rimPos.needsUpdate = true;
  corePos.needsUpdate = true;
  ind.fillGeo.computeBoundingSphere();
  ind.rimGeo.computeBoundingSphere();
  ind.coreGeo.computeBoundingSphere();
  ind.group.visible = true;
}

function updateScatterSilhouette(component, local, settings, erase, seed) {
  const ind = ensureBrushIndicator();
  const layerIndex = Math.min(settings.activeScatterLayer, Math.max(0, (component.props.scatterLayers?.length ?? 1) - 1));
  const sources = component.getScatterPreviewSources(layerIndex);
  const sourceKey = `${layerIndex}:${sources.map((source) => source.geometry.uuid).join(",")}`;
  if (ind.scatterKey !== sourceKey) {
    for (const child of ind.scatter.children) {
      child.material?.dispose?.();
      if (child.userData.ownedPreviewGeometry) child.geometry?.dispose?.();
    }
    ind.scatter.clear();
    const previewSources = sources.length ? sources : [{
      geometry: new THREE.ConeGeometry(0.32, 1, 7).translate(0, 0.5, 0),
      sourceMatrix: new THREE.Matrix4(),
      fallback: true,
    }];
    for (const source of previewSources) {
      const material = new THREE.MeshBasicMaterial({
        color: erase ? ERASE_COLOR : 0x80ff72,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.InstancedMesh(source.geometry, material, 64);
      mesh.count = 0;
      mesh.raycast = () => {};
      mesh.layers.set(EDITOR_LAYER);
      mesh.renderOrder = 1000;
      mesh.userData.previewSource = source;
      mesh.userData.ownedPreviewGeometry = !!source.fallback;
      ind.scatter.add(mesh);
    }
    ind.scatterKey = sourceKey;
  }
  const all = erase
    ? component.getScatterInstances(layerIndex).filter((item) => {
        const p = item.position;
        const effectiveRadius = settings.radius * THREE.MathUtils.lerp(0.25, 1, settings.strength);
        return p && Math.hypot(p[0] - local.x, p[2] - local.z) <= effectiveRadius;
      }).slice(0, 64)
    : component.getScatterPreviewPlacements(local, {
        layerIndex,
        radius: settings.radius,
        strength: settings.strength,
        spacing: settings.scatterSpacing,
        jitter: settings.scatterJitter,
        seed,
      });
  // Placement (rotation/scale/offset) is resolved by the component from the
  // layer's settings — the preview must not compose its own, or it would stop
  // matching what the brush actually paints the moment those settings change.
  const placement = new THREE.Matrix4();
  const localMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();
  component.entity.object3D.updateMatrixWorld(true);
  for (const mesh of ind.scatter.children) {
    mesh.material.color.setHex(erase ? ERASE_COLOR : 0x80ff72);
    mesh.count = Math.min(64, all.length);
    const source = mesh.userData.previewSource;
    for (let i = 0; i < mesh.count; i++) {
      component.scatterPlacementMatrix(layerIndex, all[i], placement, 0.03);
      localMatrix.multiplyMatrices(placement, source.sourceMatrix);
      worldMatrix.multiplyMatrices(component.entity.object3D.matrixWorld, localMatrix);
      mesh.setMatrixAt(i, worldMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
  ind.scatter.visible = true;
}

function hideScatterSilhouette() {
  if (viewport.terrainBrushIndicator?.scatter) viewport.terrainBrushIndicator.scatter.visible = false;
}

function hideBrushIndicator() {
  if (viewport.terrainBrushIndicator) viewport.terrainBrushIndicator.group.visible = false;
}

function ensureBrushAdjustOverlay(canvas) {
  let overlay = viewport.terrainBrushAdjustOverlay;
  const host = canvas.parentElement;
  if (!host) return null;
  if (overlay?.isConnected && overlay.parentElement === host) return overlay;
  overlay = document.createElement("div");
  overlay.className = "terrain-brush-adjust-overlay";
  overlay.innerHTML = '<div class="terrain-brush-adjust-ring"></div><div class="terrain-brush-adjust-dot"></div><div class="terrain-brush-adjust-label"></div>';
  host.appendChild(overlay);
  viewport.terrainBrushAdjustOverlay = overlay;
  return overlay;
}

function showBrushAdjustOverlay(canvas, gesture, radiusPx, value) {
  const overlay = ensureBrushAdjustOverlay(canvas);
  if (!overlay) return;
  const hostRect = overlay.parentElement.getBoundingClientRect();
  const x = gesture.centerX - hostRect.left;
  const y = gesture.centerY - hostRect.top;
  const ring = overlay.querySelector(".terrain-brush-adjust-ring");
  const dot = overlay.querySelector(".terrain-brush-adjust-dot");
  const label = overlay.querySelector(".terrain-brush-adjust-label");
  const diameter = Math.max(2, radiusPx * 2);
  ring.style.cssText = `left:${x - radiusPx}px;top:${y - radiusPx}px;width:${diameter}px;height:${diameter}px`;
  dot.style.cssText = `left:${x + gesture.virtualX - gesture.centerX}px;top:${y + gesture.virtualY - gesture.centerY}px`;
  label.style.cssText = `left:${x}px;top:${y - radiusPx - 30}px`;
  label.textContent = `${gesture.key === "scatterSpacing" ? "Spacing" : "Size"}: ${value.toFixed(2)}`;
  overlay.classList.add("visible");
  document.body.classList.add("terrain-brush-radial");
}

function hideBrushAdjustOverlay() {
  viewport.terrainBrushAdjustOverlay?.classList.remove("visible");
  document.body.classList.remove("terrain-brush-radial");
}

/** The terrain component on the currently-selected entity, or null. */
function selectedTerrain() {
  const entityId = useSelectionStore.getState().ids[0];
  const component = entityId && engine.getEntity(entityId)?.getComponent?.("terrain");
  return component?.mesh ? { entityId, component } : null;
}

/**
 * Sculpt/paint brush strokes for the Terrain component. Armed via the
 * Inspector's Terrain section (terrainBrush.js); while armed and a terrain
 * entity is selected, drags raycast against just that entity's mesh and
 * mutate its live geometry/splatmap buffers directly (immediate feedback, no
 * command-bus traffic per pointermove). One undo command is dispatched per
 * stroke, on pointerup — see SetTerrainHeightsCommand/SetTerrainSplatmapCommand.
 *
 * The cursor disc+ring is refreshed every frame from the update loop (not just
 * on pointermove) so it keeps hugging the surface while the camera moves, and
 * tracks the pointer whenever a brush is armed — before any stroke begins.
 */
function setupTerrainBrush(canvas) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovering = false;
  let haveNdc = false;
  let stroke = null; // { component, entityId, before, mode, flattenHeight, seed }
  let strokeSeed = 0;
  let lastClient = null;
  let lastBrushTarget = null;
  let adjustGesture = null;

  const setNdc = (e) => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    haveNdc = true;
    hovering = true; // a move/press over the canvas means we're on it
  };

  /** Raycast the current NDC against `component.mesh`; returns local-space hit or null. */
  const localHit = (component) => {
    raycaster.setFromCamera(ndc, viewport.camera);
    const hits = raycaster.intersectObject(component.mesh, false);
    if (!hits.length) return null;
    return component.mesh.worldToLocal(hits[0].point.clone());
  };

  const makeAdjustGesture = (adjustment) => {
    const target = lastBrushTarget;
    const rect = canvas.getBoundingClientRect();
    let centerX = lastClient?.x ?? rect.left + rect.width / 2;
    let centerY = lastClient?.y ?? rect.top + rect.height / 2;
    let radiusPx = 60;
    if (target) {
      viewport.camera.updateMatrixWorld();
      const worldValue = adjustment.key === "scatterSpacing"
        ? getTerrainBrushSettings().scatterSpacing
        : getTerrainBrushSettings().radius;
      const center = new THREE.Vector3(
        target.local.x,
        target.component.heightAtLocal(target.local.x, target.local.z),
        target.local.z,
      );
      const edge = new THREE.Vector3(
        target.local.x + worldValue,
        target.component.heightAtLocal(target.local.x + worldValue, target.local.z),
        target.local.z,
      );
      target.component.mesh.localToWorld(center);
      target.component.mesh.localToWorld(edge);
      center.project(viewport.camera);
      edge.project(viewport.camera);
      centerX = rect.left + (center.x * 0.5 + 0.5) * rect.width;
      centerY = rect.top + (-center.y * 0.5 + 0.5) * rect.height;
      const edgeX = rect.left + (edge.x * 0.5 + 0.5) * rect.width;
      const edgeY = rect.top + (-edge.y * 0.5 + 0.5) * rect.height;
      radiusPx = Math.max(8, Math.hypot(edgeX - centerX, edgeY - centerY));
    }
    return {
      key: adjustment.key,
      value: adjustment.startValue,
      startValue: adjustment.startValue,
      centerX,
      centerY,
      startRadiusPx: radiusPx,
      virtualX: centerX + radiusPx,
      virtualY: centerY,
      lastActualX: lastClient?.x ?? centerX,
      lastActualY: lastClient?.y ?? centerY,
    };
  };

  const applyBrush = (component, local) => {
    const settings = getTerrainBrushSettings();
    if (stroke.mode === "sculpt") {
      component.applyHeightBrush(local, {
        tool: settings.tool,
        radius: settings.radius,
        strength: settings.strength * 0.15,
        hardness: settings.hardness,
        flattenHeight: stroke.flattenHeight,
        seed: stroke.seed,
      });
    } else if (stroke.mode === "paint" || stroke.mode === "erase") {
      component.applySplatBrush(local, {
        layerIndex: Math.min(settings.activeLayer, (component.props.layers?.length ?? 1) - 1),
        radius: settings.radius,
        strength: settings.strength,
        hardness: settings.hardness,
        erase: stroke.mode === "erase",
      });
    } else if (stroke.mode === "scatter") {
      component.applyScatterBrush(local, {
        layerIndex: Math.min(settings.activeScatterLayer, Math.max(0, (component.props.scatterLayers?.length ?? 1) - 1)),
        radius: settings.radius,
        strength: settings.strength,
        spacing: settings.scatterSpacing,
        jitter: settings.scatterJitter,
        erase: stroke.erase,
        seed: stroke.seed + stroke.dab++,
      });
    }
  };

  canvas.addEventListener("pointerenter", () => (hovering = true));
  canvas.addEventListener("pointerleave", () => {
    hovering = false;
    if (!stroke) hideBrushIndicator();
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (getTerrainBrushAdjustment()) {
      if (e.button === 0 || e.button === 2) {
        finishTerrainBrushAdjustment(e.button === 2);
        adjustGesture = null;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (e.button !== 0 || !getTerrainBrushMode() || engine.playing) return;
    const sel = selectedTerrain();
    if (!sel) return;
    setNdc(e);
    const local = localHit(sel.component);
    if (!local) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const mode = getTerrainBrushMode();
    viewport.terrainBrushing = true;
    viewport.orbit.enabled = false;
    stroke = {
      mode,
      component: sel.component,
      entityId: sel.entityId,
      before: mode === "sculpt"
        ? sel.component.props.heights
        : mode === "scatter"
          ? JSON.stringify(sel.component.scatterLayersData ?? sel.component.props.scatterLayers ?? [])
          : sel.component.props.splatmap,
      // Flatten levels toward the surface height where the stroke began.
      flattenHeight: sel.component.heightAtLocal(local.x, local.z),
      seed: strokeSeed++,
      dab: 0,
      erase: mode === "scatter" && e.ctrlKey,
    };
    applyBrush(sel.component, local);
  }, true);

  canvas.addEventListener("pointermove", (e) => {
    lastClient = { x: e.clientX, y: e.clientY };
    const adjustment = getTerrainBrushAdjustment();
    if (adjustment) {
      if (!adjustGesture || adjustGesture.key !== adjustment.key) {
        adjustGesture = makeAdjustGesture(adjustment);
      }
      const radial = adjustment.key === "radius" || adjustment.key === "scatterSpacing";
      const dx = e.clientX - adjustGesture.lastActualX;
      const dy = e.clientY - adjustGesture.lastActualY;
      adjustGesture.lastActualX = e.clientX;
      adjustGesture.lastActualY = e.clientY;
      let value;
      if (radial) {
        adjustGesture.virtualX += dx;
        adjustGesture.virtualY += dy;
        const screenRadius = Math.max(2, Math.hypot(
          adjustGesture.virtualX - adjustGesture.centerX,
          adjustGesture.virtualY - adjustGesture.centerY,
        ));
        value = Math.max(0.1, adjustGesture.startValue * (screenRadius / adjustGesture.startRadiusPx));
        showBrushAdjustOverlay(canvas, adjustGesture, screenRadius, value);
      } else {
        value = THREE.MathUtils.clamp(adjustGesture.value + dx / 300, adjustment.key === "strength" ? 0.01 : 0, 1);
        adjustGesture.value = value;
      }
      setTerrainBrushSetting(adjustment.key, +value.toFixed(3));
      setNdc(e);
      return;
    }
    adjustGesture = null;
    if (!getTerrainBrushMode()) return;
    setNdc(e);
    if (!stroke) return;
    const local = localHit(stroke.component);
    if (local) applyBrush(stroke.component, local);
  });

  window.addEventListener("pointerup", () => {
    if (!stroke) return;
    const { component, entityId, mode, before } = stroke;
    stroke = null;
    viewport.terrainBrushing = false;
    viewport.orbit.enabled = true;
    if (mode === "sculpt") {
      component.commitHeights();
      commandBus.execute(new SetTerrainHeightsCommand(entityId, before, component.props.heights));
    } else if (mode === "paint" || mode === "erase") {
      component.commitSplatmap();
      commandBus.execute(new SetTerrainSplatmapCommand(entityId, before, component.props.splatmap));
    } else if (mode === "scatter") {
      const after = component.commitScatterLayers();
      commandBus.execute(new SetTerrainScatterCommand(entityId, before, after));
    }
  });

  canvas.addEventListener("contextmenu", (e) => {
    if (getTerrainBrushAdjustment()) e.preventDefault();
  });
  window.addEventListener("blur", () => {
    if (getTerrainBrushAdjustment()) finishTerrainBrushAdjustment(true);
  });

  // Disarming clears the cursor immediately.
  subscribeTerrainBrush(() => {
    if (!getTerrainBrushMode()) hideBrushIndicator();
    const adjustment = getTerrainBrushAdjustment();
    if (adjustment) {
      if (!adjustGesture || adjustGesture.key !== adjustment.key) {
        adjustGesture = makeAdjustGesture(adjustment);
        if (adjustment.key === "radius" || adjustment.key === "scatterSpacing") {
          showBrushAdjustOverlay(canvas, adjustGesture, adjustGesture.startRadiusPx, adjustment.startValue);
        }
      }
    } else {
      adjustGesture = null;
      hideBrushAdjustOverlay();
    }
  });

  // Per-frame cursor: keep the disc+ring glued to the surface under the
  // pointer whenever a brush is armed, independent of pointermove cadence.
  engine.onUpdate(() => {
    const mode = getTerrainBrushMode();
    if (!mode || engine.playing || (!hovering && !stroke) || !haveNdc) {
      hideBrushIndicator();
      return;
    }
    const target = stroke
      ? { component: stroke.component }
      : selectedTerrain();
    if (!target) {
      hideBrushIndicator();
      return;
    }
    viewport.camera.updateMatrixWorld();
    const local = localHit(target.component);
    if (!local) {
      if (!stroke) hideBrushIndicator();
      return;
    }
    lastBrushTarget = { component: target.component, local: local.clone() };
    const adjustment = getTerrainBrushAdjustment();
    if (adjustment?.key === "radius" || adjustment?.key === "scatterSpacing") {
      hideBrushIndicator();
      return;
    }
    const settings = getTerrainBrushSettings();
    const paintLayer = target.component.props.layers?.[Math.min(settings.activeLayer, Math.max(0, (target.component.props.layers?.length ?? 1) - 1))];
    const paintPreviewColor = paintLayer?.tint ? new THREE.Color(paintLayer.tint).getHex() : PAINT_COLOR;
    const color = mode === "sculpt"
      ? (SCULPT_TOOL_COLORS[settings.tool] ?? PAINT_COLOR)
      : mode === "erase" ? ERASE_COLOR : mode === "scatter" ? SCATTER_COLOR : paintPreviewColor;
    const sculptPreview = mode === "sculpt" ? {
      mode,
      tool: settings.tool,
      radius: settings.radius,
      strength: settings.strength * 0.15,
      hardness: settings.hardness,
      flattenHeight: stroke?.flattenHeight ?? target.component.heightAtLocal(local.x, local.z),
      seed: stroke?.seed ?? strokeSeed,
    } : null;
    updateBrushIndicator(target.component, local, settings.radius, color, settings.strength, settings.hardness, sculptPreview);
    if (mode === "scatter") {
      updateScatterSilhouette(target.component, local, settings, stroke?.erase ?? false, stroke?.seed ?? strokeSeed);
    } else {
      hideScatterSilhouette();
    }
  });
}

/** Raycasts from a viewport-relative pointer event into the scene. */
function raycastFromEvent(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, viewport.camera);
  return raycaster;
}

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

async function applyTextureToMaterial(matPath, texPath) {
  const { getMaterialDef, updateMaterialAsset, MATERIAL_DEFAULTS } = await import("../../engine/materialAsset.js");
  const def = { ...MATERIAL_DEFAULTS, ...(getMaterialDef(matPath) ?? {}), map: texPath };
  updateMaterialAsset(matPath, def);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_scene", { path: matPath, contents: JSON.stringify(def, null, 2) });
  console.log(`Set texture on ${matPath.split(/[\\/]/).pop()}`);
}

/** Applies a pointer-drag asset drop at a viewport point ({clientX, clientY}). */
function handleAssetDrop(path, point) {
  if (!path || !viewport.canvas) return;
  const ext = extOf(path);
  const raycaster = raycastFromEvent(point, viewport.canvas);

  if (TEXTURE_EXTENSIONS.includes(ext) || MATERIAL_EXTENSIONS.includes(ext)) {
    const hits = raycaster.intersectObjects(engine.scene.children, true);
    for (const hit of hits) {
      const entityId = findEntityId(hit.object);
      const entity = entityId && engine.getEntity(entityId);
      const mesh = entity?.getComponent("mesh");
      if (!mesh) continue;
      if (MATERIAL_EXTENSIONS.includes(ext)) {
        commandBus.execute(new SetComponentPropCommand(entityId, "mesh", "material", path));
      } else if (mesh.props.material) {
        applyTextureToMaterial(mesh.props.material, path); // edits the .mat asset
      } else {
        console.warn("Assign a material asset to this mesh before dropping textures on it.");
      }
      return;
    }
    return;
  }

  if (SCRIPT_EXTENSIONS.includes(ext)) {
    const hits = raycaster.intersectObjects(engine.scene.children, true);
    for (const hit of hits) {
      const entityId = findEntityId(hit.object);
      const entity = entityId && engine.getEntity(entityId);
      if (!entity) continue;
      if (entity.getComponent("script")) {
        commandBus.execute(new SetComponentPropCommand(entityId, "script", "path", path));
      } else {
        commandBus.execute(new AddComponentCommand(entityId, "script", { path }));
      }
      useSelectionStore.getState().select(entityId);
      return;
    }
    return;
  }

  if (MODEL_EXTENSIONS.includes(ext) || PREFAB_EXTENSIONS.includes(ext)) {
    const at = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(GROUND_PLANE, at)) at.set(0, 0, 0);
    if (PREFAB_EXTENSIONS.includes(ext)) {
      instantiatePrefab(path, at.toArray()).catch((err) => console.error(String(err)));
      return;
    }
    // Raw .glb: run the import pipeline (mesh entities + geometry/material
    // assets), then place the resulting prefab at the drop point.
    (async () => {
      const { unpackGlb } = await import("../glbImport.js");
      const folder = await unpackGlb(path);
      const stem = basename(path).replace(/\.[^.]+$/, "");
      await instantiatePrefab(`${folder}/${stem}.prefab`, at.toArray());
    })().catch((err) => console.error(String(err)));
  }
}

/**
 * Walks up the parent chain to find the entity a picked object belongs to.
 * Entity-aware helpers (e.g. the selection BoxHelper) carry an `entityId`
 * directly and resolve even though they're flagged editor-only. Pure
 * editor-only helpers (grid, gizmo, generic decoration) don't carry one
 * and short-circuit to null so they don't block selection.
 */
function findEntityId(object) {
  let node = object;
  while (node) {
    if (node.userData.entityId) return node.userData.entityId;
    if (node.userData.editorOnly) return null;
    node = node.parent;
  }
  return null;
}

function setupKeyboard(canvas) {
  canvas.addEventListener("pointerenter", () => (viewport.hovered = true));
  canvas.addEventListener("pointerleave", () => (viewport.hovered = false));

  window.addEventListener("keydown", (e) => {
    if (!viewport.hovered || engine.playing) return;
    if (e.target.closest?.(".geometry-editor")) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (!e.repeat && dispatchTerrainKeyAction(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (getTerrainBrushAdjustment() && e.key.toLowerCase() === "f") {
      e.preventDefault();
      return;
    }
    if (handleMacroKey(e)) return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case "f":
        focusSelection();
        break;
    }
  });

  // Cancel an in-progress macro if the window loses focus (e.g. user
  // Alt-Tabs or clicks into an input). We deliberately do *not* cancel on
  // pointerleave so the user can lean out of the viewport to glance at the
  // hierarchy without losing what they typed.
  window.addEventListener("blur", () => cancelMacro());
}

const modeListeners = new Set();

function setGizmoMode(mode) {
  viewport.gizmo?.setMode(mode);
  for (const fn of modeListeners) fn(mode);
}

// ---------------------------------------------------------------------------
// Blender-style transform macros (G/R/S).
//
// Grammar:
//   G | R | S                       → start macro (translate / rotate / scale).
//                                     The macro opens in *interactive* mode:
//                                     mouse delta drives the transform. The
//                                     cursor delta is projected through the
//                                     camera's right/up basis so each active
//                                     world axis picks up the motion that
//                                     lies along its screen direction. With
//                                     no axis lock, this is a free 3-axis
//                                     tumble / move / scale around the view.
//   X | Y | Z                        → toggle that axis in `macro.axes`. Each
//                                     press also re-captures `origin` so the
//                                     "prev rotation is cancelled" — successive
//                                     axis presses are cumulative (R Y Z = YZ).
//                                     Toggling the only remaining axis resets
//                                     to all-three.
//   <digits> [.<digits>] [-]         → enter numeric mode. Mouse is ignored
//                                     while a value is buffered; the value is
//                                     applied to each active axis (units for
//                                     G, degrees for R, multiplier for S).
//                                     Backspace clears the buffer first, then
//                                     removes the last locked axis.
//   Enter | Space | left-click       → commit. Left-click mimics Blender's
//                                     "click anywhere to confirm" gesture.
//   right-click                      → cancel. (Blender's RMB convention.)
//   Escape                           → cancel (restores origin).
//
// A macro acts on every selected entity — the gizmo also drives the whole
// selection, so the macro grammar matches what the rest of the editor does.
// ---------------------------------------------------------------------------

const AXIS_KEYS = { x: "x", y: "y", z: "z" };

// Unit increment rate per pixel of cursor motion. Translate, rotate, and
// scale all share the same base rate so the macros feel consistent —
// one pixel of cursor motion means the same "size of nudge" no matter
// which mode you're in.
//
//   translate: 1 px → 0.01 world-units per active axis (matching the
//              1:1 world-cursor feel Blender uses at a typical zoom)
//   rotate:    1 px → 0.01 rad per active axis (~0.57°/px, ~57°/100px)
//   scale:     1 px → +1% of current scale per active axis (additive,
//              so 100 px doubles the scale)
//
// The world delta is the camera-projected (dx, dy), so each active axis
// only picks up motion that lies along its screen direction — e.g.
// pressing Z while the camera looks down the Z axis makes the entity
// spin around Z no matter where you drag, because all motion projects
// onto the world-Z basis.
const UNIT_PER_PIXEL = 0.01;

// Translate-only distance-aware scale. `worldPerPixel` is derived from the
// camera's distance to the orbit target so that 1 pixel of cursor motion
// corresponds to the same number of world units regardless of zoom — i.e.
// ~PIXEL_REFERENCE pixels of drag equals the camera distance worth of
// world translation, matching Blender's translate feel. Rotate and scale
// use the fixed `UNIT_PER_PIXEL` rate above (they operate in screen-space
// units, not world units, so distance scaling doesn't apply).
const PIXEL_REFERENCE = 800;

/** Per-entity snapshot of the transform the macro is currently offset from.
 *  Re-captured whenever the user changes the axis set so the "cancelled prev
 *  rotation" effect matches Blender's lock-on-press behavior. */
function captureMacroOrigin() {
  const ids = useSelectionStore.getState().ids;
  return ids
    .map((id) => engine.getEntity(id))
    .filter(Boolean)
    .map((entity) => ({ entity, transform: entity.getTransform() }));
}

/**
 * Active macro state.
 *   kind       "translate" | "rotate" | "scale"
 *   axes       Set of locked-in axes. Empty = all three (Blender-style
 *              "no axis lock = free on every axis"); otherwise the listed
 *              axes are the only ones affected.
 *   buffer     Numeric input buffer (raw text). Non-empty = "numeric mode"
 *              where mouse is disabled.
 *   value      Parsed `buffer` (`null` while interactive or buffer empty).
 *   origin     Per-entity baseline. Re-captured on axis toggle.
 *   pointer    { startX, startY, lastX, lastY, lastAppliedX, lastAppliedY }
 *              used to convert pointer delta → transform delta.
 */
let macro = null;
let installedMacroPointer = false;

const macroListeners = new Set();
function notifyMacro() {
  // Toggle the window-level pointer hooks along with the macro's lifecycle.
  // capture: true ensures we see pointer events even when a deeper element
  // (OrbitControls, draggable panels) would otherwise swallow them.
  if (macro && !installedMacroPointer) {
    installMacroPointer();
    installedMacroPointer = true;
  } else if (!macro && installedMacroPointer) {
    uninstallMacroPointer();
    installedMacroPointer = false;
  }
  for (const fn of macroListeners) fn(macro ? describeMacro() : null);
}

function describeMacro() {
  if (!macro) return null;
  const { kind, axes, buffer, value } = macro;
  const allAxes = ["x", "y", "z"];
  const activeAxes = axes.size === 0 ? allAxes : [...axes];
  // Blank when fully open so the HUD doesn't echo "XYZ" on every keystroke;
  // show explicit lock only when the user has narrowed it down.
  const axisStr =
    activeAxes.length === 3 ? "" : activeAxes.length === 0 ? "—" : activeAxes.join("");
  const label = kind === "translate" ? "Move" : kind === "rotate" ? "Rotate" : "Scale";
  const unit = kind === "rotate" ? "°" : kind === "scale" ? "×" : "";
  const numStr = buffer === "" ? "" : `${buffer}${unit}`;
  return {
    label,
    axisStr,
    numStr,
    value,
    interactive: buffer === "",
    activeAxes,
    allAxes,
  };
}

function startMacro(kind) {
  if (engine.playing) return;
  const origin = captureMacroOrigin();
  if (!origin.length) return;
  macro = {
    kind,
    axes: new Set(), // empty = all three (Blender's "no axis lock")
    buffer: "",
    value: null,
    origin,
    pointer: null, // populated lazily on first pointermove
  };
  notifyMacro();
}

/** Cancel and restore every entity to its pre-macro transform. */
function cancelMacro() {
  if (!macro) return;
  for (const { entity, transform } of macro.origin) entity.setTransform(transform);
  macro = null;
  notifyMacro();
}

/** Commit: build one SetTransformCommand per selected entity.
 *
 *  In *interactive* mode the live three.js object already reflects every
 *  drag the user made — we read the current transform back out of the
 *  entity and use that as `after`, with the captured `origin` as `before`.
 *  Recomputing from the origin (the old behavior) would re-apply the
 *  default numeric value (1u / 15° / 1.1×) on top of the origin and
 *  silently snap the entity to a different transform than the one the
 *  user actually saw while dragging.
 *
 *  In *numeric* mode the transform was driven by `computeAfter` on every
 *  preview, so the live entity matches the most recent preview and we
 *  can read it back the same way. */
function commitMacro() {
  if (!macro) return;
  const cmds = [];
  for (const { entity, transform } of macro.origin) {
    const after = entity.getTransform();
    cmds.push(new SetTransformCommand(entity.id, after, transform));
  }
  if (cmds.length === 1) commandBus.execute(cmds[0]);
  else if (cmds.length > 1) {
    commandBus.execute(new BatchCommand(cmds, cmds[0].label));
  }
  macro = null;
  notifyMacro();
}

/**
 * Compute the post-macro transform given a baseline transform + axis set.
 * - translate: add `value` (default 1 unit) to each active axis.
 * - rotate:    add `value` degrees (default 15°) to each active axis.
 * - scale:     multiply each active axis by `value` (default 1.1).
 * Empty `axes` set means "every axis" — Blender's unlocked default.
 */
function computeAfter(transform, kind, axes, value) {
  const v = value ?? (kind === "scale" ? 1.1 : kind === "rotate" ? 15 : 1);
  const active = (a) => axes.size === 0 || axes.has(a);
  const [px, py, pz] = transform.position;
  const [rx, ry, rz] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  if (kind === "translate") {
    return {
      position: [active("x") ? px + v : px, active("y") ? py + v : py, active("z") ? pz + v : pz],
      rotation: transform.rotation,
      scale: transform.scale,
    };
  }
  if (kind === "rotate") {
    const rad = THREE.MathUtils.degToRad(v);
    return {
      position: transform.position,
      rotation: [
        active("x") ? rx + rad : rx,
        active("y") ? ry + rad : ry,
        active("z") ? rz + rad : rz,
      ],
      scale: transform.scale,
    };
  }
  return {
    position: transform.position,
    rotation: transform.rotation,
    scale: [active("x") ? sx * v : sx, active("y") ? sy * v : sy, active("z") ? sz * v : sz],
  };
}

/**
 * Apply the current macro state. Two modes:
 *  - Interactive (buffer empty): write the cursor delta on top of each
 *    entity's `origin` baseline, mutating `object3D` directly so the matrix
 *    update is fast and avoids the cost of re-snapping rotations back into
 *    Euler arrays.
 *  - Numeric (buffer filled): compute the new transform from each entity's
 *    `origin` plus the typed value × active axes. Mouse is ignored here.
 */
function previewMacro() {
  if (!macro) return;
  const { buffer, pointer } = macro;
  if (buffer === "") {
    if (pointer) applyPointerDelta(pointer);
  } else {
    const { origin, kind, axes, value } = macro;
    for (const { entity, transform } of origin) {
      const next = computeAfter(transform, kind, axes, value);
      entity.setTransform(next);
      useSceneStore.getState().updateTransform(entity.id);
    }
  }
}

// --- Interactive pointer mode -----------------------------------------------

// Reused per-frame to avoid garbage during drag.
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camToTarget = new THREE.Vector3();
let _worldPerPixel = 0.01;

/** Camera-aligned basis + a screen→world scale, refreshed once per pointer
 *  event. The 2D drag delta `(dx, dy)` is interpreted as a 3D vector in
 *  world space:
 *    worldDelta = (dx, dy) * worldPerPixel, then projected onto each axis
 *       via dot(worldDelta, axisUnit)
 *  The `worldPerPixel` factor scales the cursor motion so that ~PIXEL_REFERENCE
 *  pixels of dominant drag equals `camToTarget` world units — the Blender
 *  convention that "moving the cursor by N pixels moves the object by the
 *  same world distance at the object's depth". Translate uses this scale
 *  so it stays distance-aware; rotate and scale apply a fixed
 *  `UNIT_PER_PIXEL` rate after the projection (see `applyPointerDelta`).
 *  Returns false if the viewport hasn't initialized yet. */
function captureCameraBasis() {
  const cam = viewport.camera;
  const orbit = viewport.orbit;
  if (!cam || !orbit) return false;
  _camRight.setFromMatrixColumn(cam.matrixWorld, 0);
  _camUp.setFromMatrixColumn(cam.matrixWorld, 1);
  _camToTarget.copy(orbit.target).sub(cam.position);
  const dist = _camToTarget.length();
  _worldPerPixel = dist > 0.0001 ? dist / PIXEL_REFERENCE : 0.01;
  return true;
}

/** Convert accumulated cursor delta into per-axis offsets.
 *
 *  All three modes use the same `UNIT_PER_PIXEL` rate (0.01) so the
 *  macros feel consistent: one pixel of cursor motion means roughly the
 *  same "size of nudge" no matter which mode you're in.
 *
 *  The cursor delta is first projected through the camera's right/up
 *  basis to a 3D world-aligned vector (using `worldPerPixel` for translate
 *  so it stays distance-aware, plain pixels for rotate/scale). Each world
 *  axis then receives the projection of that vector onto its own unit
 *  direction, scaled by `UNIT_PER_PIXEL` (or `worldPerPixel` for translate).
 *  This means locking only Z, for example, makes the entity only react to
 *  cursor motion that lies along the world-Z direction in screen space.
 *
 *  - translate: 1 px → 0.01 world-units per active axis (distance-aware).
 *  - rotate:    1 px → 0.01 rad per active axis (~0.57°/px, ~57°/100px).
 *  - scale:     with no axes pressed, Blender scales uniformly — every
 *               axis multiplies by `1 + pxDelta * UNIT_PER_PIXEL` where
 *               `pxDelta` is the cursor's screen-projection magnitude.
 *               With axes pressed, each active axis scales independently
 *               by `1 + perAxisProj * UNIT_PER_PIXEL`. Additive (1+px*rate)
 *               rather than exponential so the rate matches translate/rotate. */
function applyPointerDelta(pointer) {
  if (!pointer || !macro) return;
  if (!captureCameraBasis()) return;
  const { dx, dy } = pointer;
  const { kind } = macro;
  const { axes, origin } = macro;

  // Camera-projected cursor delta. Translate multiplies by `worldPerPixel`
  // to stay distance-aware; rotate/scale use the raw pixel delta because
  // they operate in screen-space units (radians, ratio) rather than
  // world units, so a fixed per-pixel rate gives a consistent feel at any
  // zoom.
  const tdx = (dx * _camRight.x - dy * _camUp.x) * _worldPerPixel;
  const tdy = (dx * _camRight.y - dy * _camUp.y) * _worldPerPixel;
  const tdz = (dx * _camRight.z - dy * _camUp.z) * _worldPerPixel;
  const pdx = dx * _camRight.x - dy * _camUp.x;
  const pdy = dx * _camRight.y - dy * _camUp.y;
  const pdz = dx * _camRight.z - dy * _camUp.z;

  if (kind === "translate") {
    applyTranslation(origin, axes, tdx, tdy, tdz);
  } else if (kind === "rotate") {
    applyRotation(
      origin,
      axes,
      pdx * UNIT_PER_PIXEL,
      pdy * UNIT_PER_PIXEL,
      pdz * UNIT_PER_PIXEL,
    );
  } else {
    // Scale. With no axes pressed, Blender uses uniform scale — every
    // axis multiplies by the same additive factor driven by the cursor's
    // screen-projection magnitude. With axes pressed, each active axis
    // scales independently by its own per-axis projection.
    if (axes.size === 0) {
      const mag = Math.hypot(pdx, pdy, pdz);
      const f = 1 + mag * UNIT_PER_PIXEL;
      applyScale(origin, axes, f, f, f);
    } else {
      applyScale(
        origin,
        axes,
        1 + pdx * UNIT_PER_PIXEL,
        1 + pdy * UNIT_PER_PIXEL,
        1 + pdz * UNIT_PER_PIXEL,
      );
    }
  }
}

function applyTranslation(origin, axes, dx, dy, dz) {
  const active = (a) => axes.size === 0 || axes.has(a);
  for (const { entity, transform } of origin) {
    const [px, py, pz] = transform.position;
    entity.object3D.position.set(
      active("x") ? px + dx : px,
      active("y") ? py + dy : py,
      active("z") ? pz + dz : pz,
    );
    useSceneStore.getState().updateTransform(entity.id);
  }
}

function applyRotation(origin, axes, ax, ay, az) {
  // ax/ay/az are signed rotation offsets (radians) around world X/Y/Z.
  // Sign convention: positive rotation around an axis follows the right-hand
  // rule (Three.js Euler order). The screen-projected rate naturally gives
  // reasonable signs for the typical orbit camera.
  const active = (a) => axes.size === 0 || axes.has(a);
  for (const { entity, transform } of origin) {
    const [rx, ry, rz] = transform.rotation;
    entity.object3D.rotation.set(
      active("x") ? rx + ax : rx,
      active("y") ? ry + ay : ry,
      active("z") ? rz + az : rz,
    );
    useSceneStore.getState().updateTransform(entity.id);
  }
}

function applyScale(origin, axes, fx, fy, fz) {
  const active = (a) => axes.size === 0 || axes.has(a);
  for (const { entity, transform } of origin) {
    const [sx, sy, sz] = transform.scale;
    entity.object3D.scale.set(
      active("x") ? sx * fx : sx,
      active("y") ? sy * fy : sy,
      active("z") ? sz * fz : sz,
    );
    useSceneStore.getState().updateTransform(entity.id);
  }
}

/** Pointermove handler — only active while the macro is in interactive mode. */
function onMacroPointerMove(e) {
  if (!macro || macro.buffer !== "") return;
  const p = macro.pointer;
  if (!p) {
    macro.pointer = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY };
    return;
  }
  p.lastX = e.clientX;
  p.lastY = e.clientY;
  p.dx = e.clientX - p.startX;
  p.dy = e.clientY - p.startY;
  previewMacro();
}

/** Blender-style "click anywhere to confirm" while the macro is interactive.
 *  Two exceptions: clicks on text inputs/editors fall through (so the user
 *  can reach them without first escaping the macro), and right-click cancels
 *  (Blender's RMB = cancel convention). */
function onMacroPointerDown(e) {
  if (!macro) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.button === 2) {
    e.preventDefault();
    e.stopPropagation();
    cancelMacro();
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  commitMacro();
}

// --- Keyboard entry ---------------------------------------------------------

function handleMacroKey(e) {
  if (macro) return handleMacroInput(e);

  // Don't start a macro if the user is holding a modifier.
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.repeat) return false;
  const k = e.key.toLowerCase();
  let kind = null;
  if (k === "g") kind = "translate";
  else if (k === "r") kind = "rotate";
  else if (k === "s") kind = "scale";
  if (!kind) return false;
  // startMacro is a no-op if nothing is selected / game is playing — in that
  // case fall through so the keystroke doesn't get preventDefault'd.
  if (useSelectionStore.getState().ids.length === 0) return false;
  e.preventDefault();
  startMacro(kind);
  return true;
}

function handleMacroInput(e) {
  const k = e.key;

  // Commit / cancel take priority over everything else.
  if (k === "Escape") {
    e.preventDefault();
    cancelMacro();
    return true;
  }
  if (k === "Enter" || k === " " || k === "Spacebar") {
    e.preventDefault();
    commitMacro();
    return true;
  }

  // Axis toggle. Adding axes is cumulative: R Y Z = YZ. Toggling the last
  // remaining axis empties the set — which the rest of the macro treats as
  // "every axis" (Blender's no-lock default), so the user can always back
  // out to fully open by pressing the active axis letter one more time.
  // Each toggle also re-captures `origin` so the cursor delta starts at 0
  // from the now-current transform — that's the "cancel prev rotation"
  // behavior the user described.
  if (k === "x" || k === "y" || k === "z") {
    e.preventDefault();
    const axis = AXIS_KEYS[k];
    if (macro.axes.has(axis)) macro.axes.delete(axis);
    else macro.axes.add(axis);
    // Re-baseline origin to the entity's *current* transform so the visible
    // pose becomes the new zero-point for subsequent moves/drags.
    macro.origin = captureMacroOrigin();
    macro.pointer = null;
    previewMacro();
    notifyMacro();
    return true;
  }

  // Backspace: clear the numeric buffer first; once empty, remove the most
  // recent axis lock so the user can claw back the macro step by step.
  if (k === "Backspace") {
    e.preventDefault();
    if (macro.buffer.length > 0) {
      macro.buffer = macro.buffer.slice(0, -1);
      macro.value = parseMacroNumber(macro.buffer);
      previewMacro();
      notifyMacro();
      return true;
    }
    if (macro.axes.size > 0) {
      // Pop the most recently added axis. `Set` preserves insertion order.
      const last = [...macro.axes].at(-1);
      macro.axes.delete(last);
      macro.origin = captureMacroOrigin();
      macro.pointer = null;
      previewMacro();
      notifyMacro();
      return true;
    }
    return true;
  }

  // Numeric / sign input. Once a digit/sign lands, the macro enters numeric
  // mode (mouse disabled, value drives each active axis on commit).
  if (/^[0-9.\-]$/.test(k)) {
    e.preventDefault();
    if (k === "-" && (macro.buffer.includes("-") || macro.buffer.length > 0)) return true;
    if (k === "." && macro.buffer.includes(".")) return true;
    macro.buffer += k;
    macro.value = parseMacroNumber(macro.buffer);
    // First digit transitions interactive→numeric. Re-baseline origin so the
    // typed value adds on top of whatever the cursor had already moved the
    // entity to, not on top of the pre-macro transform.
    macro.origin = captureMacroOrigin();
    macro.pointer = null;
    previewMacro();
    notifyMacro();
    return true;
  }

  // Unhandled keys fall through (Tab, function keys, arrows, etc.).
  return false;
}

function parseMacroNumber(buf) {
  if (buf === "" || buf === "-" || buf === ".") return null;
  const n = Number(buf);
  return Number.isFinite(n) ? n : null;
}

/** Install / remove the window-level pointer listeners that the macro needs
 *  for interactive drag. Only attached while a macro is active. Capture
 *  phase on both because some controls (OrbitControls, draggable panels)
 *  may stop propagation lower in the tree, and we still want the macro to
 *  see every cursor move + click. */
function installMacroPointer() {
  window.addEventListener("pointermove", onMacroPointerMove, true);
  window.addEventListener("pointerdown", onMacroPointerDown, true);
}
function uninstallMacroPointer() {
  window.removeEventListener("pointermove", onMacroPointerMove, true);
  window.removeEventListener("pointerdown", onMacroPointerDown, true);
}

function focusSelection() {
  const id = useSelectionStore.getState().ids[0];
  const entity = id ? engine.getEntity(id) : null;
  if (!entity) return;
  const bounds = new THREE.Box3().setFromObject(entity.object3D);
  const center = new THREE.Vector3();
  if (bounds.isEmpty()) {
    entity.object3D.getWorldPosition(center);
  } else {
    bounds.getCenter(center);
  }
  const size = bounds.isEmpty() ? 2 : bounds.getSize(new THREE.Vector3()).length() || 2;
  const offset = viewport.camera.position.clone().sub(viewport.orbit.target).normalize().multiplyScalar(size * 2);
  viewport.orbit.target.copy(center);
  viewport.camera.position.copy(center).add(offset);
}

/**
 * Snapshot of the editor orbit camera's pose — used by the inspector's
 * "Adjust to View" button to copy the current view onto a selected camera
 * entity. Returns null if the viewport hasn't been initialized yet.
 */
export function getEditorCameraView() {
  if (!viewport.camera) return null;
  return {
    position: viewport.camera.position.toArray(),
    rotation: [viewport.camera.rotation.x, viewport.camera.rotation.y, viewport.camera.rotation.z],
  };
}

export function ViewportPanel() {
  const containerRef = useRef(null);
  const [backend, setBackend] = useState(viewport.backend);
  const [mode, setMode] = useState("translate");
  const [macroState, setMacroState] = useState(null);
  const [terrainBrushState, setTerrainBrushState] = useState(() => ({
    mode: getTerrainBrushMode(),
    settings: { ...getTerrainBrushSettings() },
    adjustment: getTerrainBrushAdjustment(),
  }));
  const [previewEntityName, setPreviewEntityName] = useState(null);
  const playing = usePlayStore((s) => s.playing);
  const geometryEntityId = useGeometryEditStore((s) => s.entityId);
  const geometryInitialView = (() => {
    if (!geometryEntityId || !viewport.camera || !viewport.orbit) return null;
    const entity = engine.getEntity(geometryEntityId);
    if (!entity) return null;
    entity.object3D.updateWorldMatrix(true, false);
    const inverse = entity.object3D.matrixWorld.clone().invert();
    return {
      position: viewport.camera.position.clone().applyMatrix4(inverse).toArray(),
      target: viewport.orbit.target.clone().applyMatrix4(inverse).toArray(),
    };
  })();
  // Mirrors viewport.layers — kept here because React owns the toggle UI.
  // The Panel re-reads this any time something else (e.g. another viewport
  // instance in a future split-pane setup) mutates layer state via the
  // subscribeLayers pub-sub.
  const [layers, setLayers] = useState(viewport.layers);
  const [layersOpen, setLayersOpen] = useState(false);

  const dropRef = useAssetDrop({
    accepts: [...MODEL_EXTENSIONS, ...TEXTURE_EXTENSIONS, ...SCRIPT_EXTENSIONS, ...MATERIAL_EXTENSIONS, ...PREFAB_EXTENSIONS],
    onDrop: (path, point) => {
      if (!usePlayStore.getState().playing) handleAssetDrop(path, point);
    },
  });

  useEffect(() => {
    // Toggle a body class while the macro is interactive so theme.css can
    // give the viewport a grab cursor without leaking the cursor onto other
    // panels (the macro is modal anyway).
    document.body.classList.toggle("macro-active", !!macroState?.interactive);
    return () => {
      document.body.classList.remove("macro-active");
    };
  }, [macroState]);

  // Sync local state when something else flips a layer toggle (today:
  // nothing else does, but the pub-sub path lets future tooling drive
  // it without coupling to React).
  useEffect(() => subscribeLayers(setLayers), []);
  useEffect(() => subscribeTerrainBrush(() => setTerrainBrushState({
    mode: getTerrainBrushMode(),
    settings: { ...getTerrainBrushSettings() },
    adjustment: getTerrainBrushAdjustment(),
  })), []);

  useEffect(() => {
    const container = containerRef.current;
    let disposed = false;

    ensureViewport().then((name) => {
      if (disposed) return;
      setBackend(name);
      const { width, height } = container.getBoundingClientRect();
      engine.setSize(width, height);
    });

    const observer = new ResizeObserver(([entry]) => {
      engine.setSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);

    const onMode = (m) => setMode(m);
    modeListeners.add(onMode);

    const onMacro = (s) => setMacroState(s);
    macroListeners.add(onMacro);

    // React-side mirror of which camera entity is being previewed, so we can
    // show a small label over the WebGL preview quad. The label tracks the
    // camera component's own "show preview" flag — the label is the visible
    // counterpart of the PIP, so they appear/disappear together.
    const refreshPreviewLabel = () => {
      if (engine.playing) {
        setPreviewEntityName(null);
        return;
      }
      const id = useSelectionStore.getState().ids[0];
      const ent = id ? engine.getEntity(id) : null;
      const cam = ent?.getComponent?.("camera");
      if (!cam) {
        setPreviewEntityName(null);
        return;
      }
      setPreviewEntityName(cam.props.showPreview === false ? null : ent.name);
      // Keep the WebGL preview's visibility in sync with the prop toggle
      // — setCamera already passed the component in, but a prop change
      // after attach needs a nudge so the frame goes hidden immediately.
      viewport.cameraPreview?.updateVisible();
    };
    refreshPreviewLabel();
    const unsubSel = useSelectionStore.subscribe(refreshPreviewLabel);
    const unsubPlay = engine.on("play-changed", refreshPreviewLabel);
    // Re-evaluate preview visibility/label when any camera component prop
    // changes (the user toggled "Show preview" / follow checkboxes in the
    // inspector). The mirror in sceneStore doesn't refresh on prop
    // changes, so the only way to update the React-side label and the
    // hidden DOM frame is to listen for the engine's component-changed
    // signal emitted from Component.setProp.
    const unsubProp = engine.on("component-changed", (info) => {
      if (info.componentType !== "camera") return;
      refreshPreviewLabel();
    });

    // Canvas is created async on first mount; append when ready.
    const appendCanvas = () => {
      if (!disposed && viewport.canvas && viewport.canvas.parentElement !== container) {
        container.appendChild(viewport.canvas);
      }
    };
    if (viewport.canvas) appendCanvas();
    else ensureViewport().then(appendCanvas);

    return () => {
      disposed = true;
      observer.disconnect();
      modeListeners.delete(onMode);
      macroListeners.delete(onMacro);
      unsubSel();
      unsubPlay();
      unsubProp();
      viewport.canvas?.remove();
    };
  }, []);

  return (
    <div
      className="viewport-panel"
      ref={(el) => {
        containerRef.current = el;
        dropRef(el);
      }}
    >
      <div className="viewport-toolbar">
        <button
          className={`toolbar-btn play-btn ${playing ? "active" : ""}`}
          title={playing ? "Stop (Ctrl+P)" : "Play (Ctrl+P)"}
          onClick={() => togglePlay()}
        >
          {playing ? <Square size={13} /> : <Play size={13} />}
        </button>
        {[
          ["translate", "Move (G)", Move],
          ["rotate", "Rotate (R)", Rotate3d],
          ["scale", "Scale (S)", Scale3d],
        ].map(([m, label, Icon]) => (
          <button
            key={m}
            className={`toolbar-btn icon-only ${mode === m ? "active" : ""}`}
            title={label}
            disabled={playing}
            onClick={() => setGizmoMode(m)}
          >
            <Icon size={14} />
          </button>
        ))}
        <div className="layers-dropdown dropdown-wrap">
          <button
            className={`toolbar-btn icon-only ${layersOpen ? "active" : ""}`}
            title="Layers"
            onClick={() => setLayersOpen((v) => !v)}
          >
            <LayersIcon size={14} />
          </button>
          {layersOpen && (
            <>
              <div
                className="dropdown-overlay"
                onClick={() => setLayersOpen(false)}
              />
              <div className="dropdown-menu layers-menu">
                {LAYER_TOGGLES.map(({ key, label }) => (
                  <button
                    key={key}
                    className="dropdown-item layers-item"
                    onClick={() => setLayerVisible(key, !layers[key])}
                  >
                    <span className="layers-item-label">
                      <span className={`layers-dot ${layers[key] ? "on" : "off"}`} />
                      {label}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {playing && <span className="backend-badge playing">Playing</span>}
        {backend && <span className={`backend-badge ${backend === "WebGPU" ? "webgpu" : "webgl"}`}>{backend}</span>}
      </div>
      {macroState && (
        <div className="macro-hud">
          <span className="macro-hud-kind">{macroState.label}</span>
          {/* Active-axes chip. "—" when the macro is open on all three axes
              (Blender's no-lock state); otherwise the locked letter(s). */}
          <span className="macro-hud-axis">
            {macroState.axisStr || "—"}
          </span>
          {macroState.numStr && <span className="macro-hud-num">{macroState.numStr}</span>}
          <span className="macro-hud-hint">
            {macroState.interactive
              ? "drag to apply · click or ↵ commit · Esc cancel · ⌫ edit axes"
              : "↵ commit · Esc cancel · ⌫ edit value"}
          </span>
        </div>
      )}
      {terrainBrushState.mode && !playing && (
        <div className={`terrain-brush-hud ${terrainBrushState.adjustment ? "adjusting" : ""}`}>
          <span className="terrain-brush-hud-mode">{terrainBrushState.mode}</span>
          {terrainBrushState.mode === "sculpt" && <span>{terrainBrushState.settings.tool}</span>}
          <span>R {terrainBrushState.settings.radius.toFixed(2)}</span>
          <span>S {terrainBrushState.settings.strength.toFixed(2)}</span>
          {terrainBrushState.mode === "scatter" && <span>Spacing {terrainBrushState.settings.scatterSpacing.toFixed(2)}</span>}
          <span>H {terrainBrushState.settings.hardness.toFixed(2)}</span>
          <span className="terrain-brush-hud-hint">
            {terrainBrushState.adjustment
              ? `${terrainBrushState.adjustment.key}: move cursor · click/↵ confirm · RMB/Esc cancel`
              : terrainBrushState.mode === "scatter"
                ? "F size · Shift+F spacing · Ctrl+drag erase · B exit"
                : "F size · Shift+F strength · Ctrl+F hardness · B exit"}
          </span>
        </div>
      )}
      {previewEntityName && !playing && (
        <div className="camera-preview-label" title="Live render from the selected camera">
          <span className="dot" />
          {previewEntityName}
        </div>
      )}
      {geometryEntityId && !playing && (
        <div className="scene-geometry-editor-overlay">
          <GeometryEditorPanel
            embedded
            entityIdOverride={geometryEntityId}
            initialView={geometryInitialView}
            onClose={() => useGeometryEditStore.getState().exit()}
          />
        </div>
      )}
      <StatsOverlay />
    </div>
  );
}
