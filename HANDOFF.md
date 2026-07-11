# Handoff — Game Engine (Phases 1–6 complete)

## Context
Implementing the plan at `~/.cursor/plans/game_engine_groundwork_plan_8f148e4f.plan.md`
(do NOT edit its prose; todo statuses live in its frontmatter). Tauri 2 + React (plain
JS) + three.js r185 WebGPU/TSL game engine editor, PlayCanvas/Unity-style.

## Status (as of 2026-07-03)
Phases 1–5 complete. Editor layout, entity/component editing, undo/redo, scene save/load,
assets panel + drag-drop import (.glb/textures/scripts), script components with hot
reload, Play/Stop mode, shader graph editor, and the GPU particle system editor.
`npm run tauri dev` to run; `npm run build` passes clean.

⚠️ The shader graph editor AND the particle system are verified by build + headless node
construction only — **neither has been clicked through in a live `tauri dev` session yet**
(no display in the dev sandbox). Do that before building more on top of them.

## Architecture map
- `src/engine/` — React-free, Tauri-free runtime (exported games ship this):
  - `Engine.js` — WebGPURenderer wrapper, `THREE.Timer` loop, entity map + roots,
    `hierarchy-changed`/`play-changed` events, `onUpdate(fn)` per-frame callbacks.
  - `Entity.js` — wraps `Object3D` (`userData.entityId` links three → entity for picking).
  - `components/` — Mesh (+ `shaderGraph` prop), Light, Camera, Model (.glb), Script
    (hot reload, runs only while `engine.playing`), **Particles** (see below); `registry.js`.
  - `shaderGraph.js` — `NODE_TYPES` + async `compileShaderGraph()` → TSL node for
    `material.colorNode`.
  - `assetResolver.js` — swappable hooks (`setAssetResolver`/`setScriptLoader`) bridging
    to the editor's Tauri-backed loaders without importing Tauri.
  - `serialize.js` — scene JSON v1; also powers delete-undo/duplicate.
- `src/editor/` — React editor: command bus (`commands/`, all mutations go through it),
  zustand mirrors (`store/`), dockview shell (`EditorShell.jsx`, optional panels via
  `openPanel(id)` + `OPTIONAL_PANELS`), panels (Viewport, Hierarchy, Inspector, Assets,
  Console, ShaderGraph, Particles), `playMode.js` (snapshot on Play, restore on Stop),
  `sceneIO.js`, `assetLoader.js` (Rust fs commands → blob URLs / script modules).
- `src-tauri/` — `save_scene`, `load_scene`, `read_binary_file`, `read_text_file`,
  `stat_file`, `list_dir`, `frontend_log` (WebView console is invisible — this prints
  `[frontend] …` to the dev terminal).

## Particle system (Phase 5, just built — untested live)
- `src/engine/components/ParticleComponent.js` — GPU sim in TSL compute:
  `instancedArray` storage buffers (position vec3 / velocity vec3 / age float), an init
  pass (staggered ages) + per-frame update pass (age, respawn via `hash` salted with
  `time`, gravity integration) dispatched with `renderer.compute()` from an
  `engine.onUpdate` callback (lazy first-tick init guards the renderer race). Rendered
  as an instanced `THREE.Sprite` (`sprite.count = N`, `frustumCulled = false`) with
  `SpriteNodeMaterial`: `positionNode = positions.toAttribute()`, per-particle size via
  hash, color = mix(startColor, endColor, age/lifetime), soft-circle alpha fade.
  Simulates in the editor too (live preview), not just play mode.
- Props: count/shape(point|sphere|box)/additive rebuild the system; the rest
  (lifetime, speed, spread, gravity, emitterSize, size, opacity, start/endColor) are
  uniforms updated in place. `applyUniform(key, value)` = preview without touching
  props; `restart()` re-runs the init pass.
- `src/editor/panels/ParticlesPanel.jsx` — optional panel (Window → Particles, or
  "Open Particle Editor" button in the Inspector's Particles section). Sliders preview
  live via `applyUniform`, commit ONE `SetComponentPropCommand` per gesture on release
  (same pattern as gizmo drags). Inspector schema fields also work as a fallback.

## Gotchas already hit (don't rediscover)
- Tauri's `dragDropEnabled` (default true, needed by the Assets panel's OS
  file-import listener) intercepts the webview's native drag-and-drop
  wholesale — HTML5 `dragstart`/`dragover`/`drop` never fire on `draggable`
  elements either, even for in-app reordering. HierarchyPanel's entity drag
  (`src/editor/panels/HierarchyPanel.jsx`) is therefore a manual
  pointerdown/pointermove/pointerup drag (DOM `elementFromPoint` hit-testing),
  not HTML5 DnD. Don't reach for `draggable`/`onDragOver` in this webview;
  build any future in-app drag the same pointer-based way.
- tauri-cli 2.11 window option is `additionalBrowserArgs` (not `additionalBrowserArguments`).
- dockview 7.x React wrapper is the separate `dockview-react` package; theme via
  `themeAbyss` object prop.
- `THREE.Clock` deprecated in r185 → `THREE.Timer` (`update()` then `getDelta()`).
- No React StrictMode in `main.jsx` — double-mount tears down the WebGPU renderer.
- three imports: everything from `three/webgpu`, TSL from `three/tsl`, addons from
  `three/addons/...`; TransformControls needs `scene.add(gizmo.getHelper())`.
- `@xyflow/react` (not deprecated `reactflow`) needs its `dist/style.css` imported.
- TSL `hash(seed)` takes a float seed (converts toUint internally) — salt with
  `instanceIndex` + `time` for per-respawn randomness.
- `.gltf` with sibling `.bin` files won't load over blob URLs (no base path) — `.glb` only.

## Game export (Phase 6, part 1 — done, untested live)
- `npm run build:player` → `dist-player/` template (`player.html` + `src/player/main.js`:
  React/Tauri-free boot — fetch scene.json, deserialize, find scene camera, setPlaying,
  relative-URL asset resolver + fetch/blob script loader with stable version).
- File → Export Game… (`src/editor/exportGame.js`): picks a folder, copies dist-player,
  writes scene.json with asset paths rewritten to `assets/<basename>`, copies assets
  (mesh map, shader-graph textures, model/script paths) via Rust `export_game` (lib.rs).
- Debts: player template resolved relative to dev cwd (packaged app needs a resource
  path), basename collisions unhandled, output needs a static server (no file://).

## Project hub (Phase 6, part 2 — done, untested live)
In-app startup screen, not a separate Tauri window: `src/editor/ProjectHub.jsx`, gated
in `main.jsx` (`App` shows hub until `projectStore.rootPath` set or Skip). New/Open/
recent-list (localStorage `engine.recentProjects.v1`, max 8); New Project writes a
`project.json` marker via `save_scene`. projectStore gained `openProject/createProject/
skipHub/recent`.

## Scripting v2 (post-plan, done — untested live)
- TS scripts with `@attribute({type, default, min…})` field decorators → Inspector
  fields (values in `props.attributes`, defs read off the loaded class). Pipeline:
  `assetLoader.transpileScript` (esbuild-wasm, lazy init, `experimentalDecorators`) +
  `src/engine/scriptRuntime.js` `linkEngineImports` (rewrites `from "engine"` to a
  runtime blob URL exporting `attribute`). Verified headless (decorator lowering +
  registration + instance defaults).
- Assets panel: "+ Script" writes NewScript.ts template; double-click .ts/.js opens in
  OS editor (`plugin-opener` `openPath`, capability `opener:allow-open-path` added).
- Hot reload (existing mtime poll) now re-applies attributes; optional
  `onHotReload(ctx, oldInstance)` replaces destroy/start to carry state across saves
  while playing. `script-loaded` engine event refreshes the Inspector.
- Export transpiles .ts → `assets/*.js` (`files` param on Rust `export_game`); player
  links `"engine"` imports itself.

## Script UX fixes + Material assets (latest session)
- **Opener fix**: `opener:allow-open-path` needs a scoped entry (`"allow": [{"path": "**"}]`)
  in capabilities — bare identifier denies everything. Requires tauri dev restart.
- Inspector text PropFields are now drop targets for Assets-panel drags (script path,
  mesh material/map, model path).
- **Material assets**: `.mat` = JSON (color/roughness/metalness/map/shaderGraph).
  `src/engine/materialAsset.js` caches ONE shared `MeshStandardNodeMaterial` per path —
  all meshes referencing it update together; components never dispose shared materials.
  `MeshComponent.props.material` (path) overrides the embedded material; empty = revert.
  "+ Material" in Assets panel, drag .mat onto mesh in viewport or Inspector field,
  MaterialPanel (Window → Material / "Edit Material" button) edits the selected mesh's
  .mat live (shared instance) + Save writes the file (asset edits are not undoable).
  Export ships .mat via `files` with claimed inner texture paths.

## Asset-centric refactor (latest)
- Mesh = `geometry` + `material` (.mat path) ONLY — color/roughness/map/shaderGraph
  removed from mesh props; all surface props live in the .mat. No material assigned =
  shared default white (`getDefaultMaterial()` in materialAsset.js). Old scenes' extra
  mesh props are ignored harmlessly.
- Schema type `"asset"` (`{type:"asset", exts:[...]}` on mesh.material, model.path,
  script.path) → Inspector `AssetField`: drop target (ext-checked) + click-to-browse
  dropdown listing project files via `listProjectAssets` (recursive list_dir, depth 4).
- Clicking an Assets-panel file selects it (`selectionStore.assetPath`, mutually
  exclusive with entity selection) → Inspector shows `AssetInspector`: .mat embeds
  `MaterialEditor` (extracted from MaterialPanel), scripts get "Open in IDE".
- ShaderGraphPanel now edits the material asset's graph (selected .mat, or selected
  mesh's material) — Apply writes the .mat file + live-updates the shared material.
- Viewport texture-drop onto a mesh edits its .mat's map (writes file); warns if the
  mesh has no material.

## Editor UX overhaul (2026-07-04 session — build-verified, not clicked through)
- **Panels reopenable**: `PANEL_SPECS` in EditorShell covers ALL panels; `openPanel(id)`
  falls back gracefully when the preferred anchor panel is closed. Window menu lists
  every panel + "Reset Layout" (wipes `engine.layout.v1`, rebuilds default).
- **Scene persistence fixed**: scenes now live in project files, not localStorage.
  `project.json` holds `lastScene` (project-relative; written via
  `projectStore.updateMeta`). With a project open: newScene auto-saves immediately to
  `scenes/<name>.scene` (uniquified via stat_file probe), Ctrl+S never needs a dialog,
  autosave runs every 10s on dirty. localStorage `engine.lastScene.v1` only remains as
  the no-project fallback. `openScenePath(path)` exported; double-click .scene in
  Assets opens it.
- **Hierarchy**: multi-select (ctrl toggle / shift range via flattened DFS order,
  `anchorId` in selectionStore), right-click context menu (copy/cut/paste/paste-as-
  child/duplicate/rename/delete), drag-drop with three zones per row (top 25% =
  before, bottom = after, middle = make child) + multi-entity drag. `draggedIds`
  module var because dataTransfer is unreadable during dragover. New commands:
  `BatchCommand`, `PasteCommand`, `ReparentEntityCommand(id, parentId, newIndex)`
  (index computed against sibling list WITHOUT the moved entity), `topMostIds()`
  filters descendants out of batch ops. Entity clipboard = `src/editor/clipboard.js`
  (serialized snapshots, ids stripped; also home of duplicateSelection/
  deleteSelection). MenuBar + EditorShell shortcuts route through it (Ctrl+C/X/V/D).
- **Assets panel**: texture tiles show image thumbnails (blob URLs), .mat tiles show a
  round color swatch with the map multiplied in; "+ Folder", right-click menu
  (rename/delete/new folder/script/material/refresh), inline rename, drag tile onto a
  folder tile (or the ↑ Up button) to move. Delete confirms via plugin-dialog
  `confirm` (covered by `dialog:default`). New Rust commands: `create_dir`,
  `rename_path` (refuses to clobber), `delete_path`.
- **AssetField extracted** to `src/editor/fields/AssetField.jsx` — used by Inspector
  schema fields AND the MaterialEditor Texture row (was a text input). Dropdown
  options show texture thumbnails + project-relative paths.

- **OS file import into Assets**: external drags never worked — Tauri intercepts
  native file drags, so HTML5 drop events don't fire for them. AssetsPanel now
  subscribes to `getCurrentWebview().onDragDropEvent()`, hit-tests the (physical →
  /devicePixelRatio) position against the panel rect, highlights while hovering, and
  copies dropped files/folders into the open folder via new Rust `import_files`
  (uniquifies names, recursive for dirs).
- **Shader graph redesign**: nodes are category-colored cards (`.cat-value` amber /
  `.cat-coords` violet / `.cat-texture` teal / `.cat-math` blue / `.cat-output` green,
  via a `--cat` CSS var) with header strip + dot, ports centered on their rows (the old
  absolute `top` offsets rendered labels outside the node box — fixed by making each
  row `position: relative` and letting the xyflow Handle center in it). Texture node
  uses AssetField (wrapped `nodrag nopan`). Node palette is grouped
  (Values/Coordinates/Texture/Math) and also opens on canvas right-click, spawning at
  the cursor via `screenToFlowPosition` (panel now wrapped in `ReactFlowProvider`).
  Delete/Backspace removes selected nodes/edges but the output node is guarded;
  EditorShell global shortcuts bail when `e.target` is inside `.react-flow` so Delete
  in the graph can't nuke scene entities. Styled edges/controls/background to theme.

## Node-based particle system (2026-07-04, second pass — headless-verified)
- `src/engine/particleGraph.js` — registry (`P_NODE_TYPES`, 38 types) + async
  `compileParticleGraph(graph)`. Categories: emitters (point/sphere/box/cone/ring/
  **mesh surface** via MeshSurfaceSampler → 2048 pos+normal samples in storage
  buffers), attributes (age/life01/position/velocity/random/time), values
  (float/vec3/color/gradient), math (add/multiply/mix/remap/sine/normalize/length/
  combine/split), noise (simplex float+vec3, **curl** = finite-difference curl of
  mx_noise_vec3 → divergence-free flow, worley, fractal), forces (gravity/drag/
  turbulence/vortex/attractor/buoyancy/wind → vec3 accelerations, chained with Add
  into System.force). System node: capacity/lifetime(+jitter)/sizeJitter/additive/
  sprite texture asset/floor (none|bounce|kill).
- **Context trick**: the same graph compiles in three contexts — spawn (init +
  respawn branch, per-respawn salted rand), update (storage element access), render
  (`.toAttribute()` + instanceIndex) — so one wire works everywhere. ctx = {key,
  cache, index, position, velocity, age, life01, rand(k)}. Respawn salt MUST be
  time-derived (`time.mul(1e3)`) or randoms repeat per cycle.
- `ParticleComponent` rebuilt: props = `{graph}` only; legacy props auto-convert
  (`legacyPropsToGraph`); compile is async with generation guard; floor bounce
  reflects position + damps velocity in the update pass; sprite texture multiplies
  color and uses texel alpha as mask (soft-circle fallback).
- `ParticlesPanel` = node editor (same look/CSS as shader graph; generic param rows:
  number/vec3/color/boolean/select/asset). Presets in `src/editor/particlePresets.js`:
  Fire, Smoke, Fountain (floor bounce), Snow (kill floor), Magic Vortex. Apply
  validates compile then commits ONE SetComponentPropCommand('graph'); Restart
  re-seeds. System node is delete-guarded.
- Verified headless: all presets + a synthetic all-node graph build init/update
  compute + render nodes without a renderer. NOT clicked through live. True fluid
  (SPH neighbor search) is out of scope — vortex/attract/drag/curl approximate it.

## UI reskin (2026-07-04, third pass)
theme.css fully rewritten as a design system (all selectors preserved): iOS × Figma
dark. Tokens at :root — 4 surface elevations (#0d0e11→#25262c), hairline borders
(rgba-white .065/.13), single accent #0a84ff (+ --accent-soft/-ring), radii 7/10/12,
--ease cubic-bezier(.2,0,0,1), 120ms micro-transitions. Key moves: filled borderless
inputs w/ focus ring; ALL checkboxes render as iOS switches (global
input[type=checkbox] appearance:none); custom slider (3px track/white thumb); select
with embedded SVG caret; menus/hub/viewport-pills use backdrop-filter blur;
dockview reskinned via --dv-* var overrides under .dock-container + rounded
.dv-groupview cards with 6px outer gutter; hierarchy selection = accent-soft tint
(not solid); node cards translucent w/ color-mix dot glow; hub = radial accent glow
+ glass card. prefers-reduced-motion kills animations. Uses :has() and color-mix
(WebView2 OK). NOT visually inspected live — needs a click-through for spacing
regressions (esp. dockview tab paddings and node param rows).

Remaining polish/debt: live click-through of shader graph + particles + export + hub
+ everything above, viewport helper icons for lights/cameras/particles, dirty-scene
prompt, packaged-app resource path for the player template, moving/renaming assets
does NOT rewrite references in scenes/.mat files, particle storage buffers aren't
explicitly disposed on detach.

## Lazy-engine boot refactor (2026-07-05, MiniMax launch optimization + fix)
- Engine singleton is lazy: `engineInstance.js` → `ensureEngine()` (async) + a
  Proxy shim `engine` for legacy consumers (throws before first resolve).
  main.jsx lazy-loads EditorShell; EditorShell lazy-loads all panels +
  EditorChrome; vite.config.js adds optimizeDeps.include + server.warmup.
  Play UI state lives in `store/playStore.js` (`usePlayStore`).
- **Fixed regression**: the Proxy shim had only a `get` trap, so
  `engine.camera = ...` (ViewportPanel play-camera swap) wrote to the dummy
  Proxy target and Play never switched to the scene camera. A `set` trap now
  forwards writes to the real instance. Verified live in Chrome + user's
  tauri dev. New code should prefer `const engine = await ensureEngine()`
  over the shim.

## Assets v2: pointer drag, GLB unpack, animator, asset inspector (2026-07-05 — build + headless verified, NOT clicked through)

### Pointer-based asset drag (fixes "can't drop .glb into scene")
Asset tiles used HTML5 `draggable` which Tauri swallows (see gotcha above) — drops
never fired. Replaced wholesale by `src/editor/assetDrag.js`: `armAssetDrag(e, path)`
on tile pointerdown, `useAssetDrop({accepts, onDrop, hoverClass?})` ref-hook registers
drop targets in a module Map, hit-testing walks `elementFromPoint` ancestors on
move/up; ghost div + `.asset-drop-hover` highlight; `consumeAssetDragClick()` guards
tile onClick. Converted: AssetsPanel tiles (drag source; dir tiles + Up button =
move targets), ViewportPanel (`handleAssetDrop(path, point)` now takes a point),
AssetField, Inspector text PropFields. NO HTML5 DnD remains for assets.

### GLB unpack pipeline (`src/editor/glbImport.js`)
OS-importing a .glb auto-unpacks (also "Unpack Model" context item): creates
`<stem>/` with the moved .glb, `Textures/*.png` (embedded images via canvas encode,
each with a `.png.meta` `{flipY:false}` — glTF UVs are top-left origin),
`Materials/*.mat` per GLTF material (color/rough/metal/map), `<stem>.anim`
(one state per clip) when animated, and `<stem>.entity` prefab wiring it all.
New Rust cmd `write_binary_file`. ModelComponent gained `materials` prop
(GLTF material name -> .mat path override, applied via shared loadMaterialAsset;
`sharedMaterials` set guards disposal) + keeps `gltf.animations` as `this.clips`
+ emits `model-loaded`. `.entity` prefabs (`src/editor/prefab.js`) = stripped
serializeEntity JSON; dropping one on the viewport instantiates via PasteCommand.

### Animation controller (.anim) — Unity-style state machine
- `src/engine/animGraph.js`: format {parameters(number/boolean/trigger), states
  (id/name/clip/speed/loop/x/y), startTransitions([{to, conditions}]),
  transitions(from|`__any__`, to, conditions [{param,op,value}], duration=crossfade,
  exitTime 0..1|null)}. The graph entrance is the `__start__` pseudo-state — the
  first Start→X transition whose conditions pass (evaluated once at boot against
  parameter defaults) determines the entry state; with no Start transitions the
  runtime falls back to the first state. `AnimatorRuntime` drives a
  THREE.AnimationMixer: crossFadeTo on transition, triggers consumed on fire,
  condition-less transitions default to exitTime=1 (clip end). Headless test:
  `node scripts/test-animator.mjs`.
- `AnimationComponent` ("animation"): props {controller: .anim path, playInEditor}.
  Pulls clips from sibling ModelComponent (rebuilds on `model-loaded`), loads
  controller via resolveAssetUrl+fetch. Script API: setNumber/setBool/setTrigger/
  getParam/play(name, fade)/currentState. `applyGraph(graph)` = editor live preview.
  Teardown re-poses skeletons (skeleton.pose()).
- `AnimatorPanel` (`src/editor/panels/AnimatorPanel.jsx`, panel id "animator",
  Window menu + double-click .anim + Inspector "Edit Animator"): xyflow canvas
  (state nodes + fixed Start + Any State pseudo-nodes; edges=transitions labeled
  by conditions; Start transitions labeled "entry"), left sidebar = Parameters
  list + selected State editor (name/clip dropdown from bound model's clips/
  speed/loop/Preview) + selected Transition editor (conditions, plus blend/exit
  time for state-to-state edges). Drag a wire from Start to a state to make it
  the entry; the Start node is anchored (not draggable, not deletable) so it
  stays on the canvas as a permanent handle. Save writes .anim + applyGraph on
  every Animation component using it. "+ Animator"/"New Animator" in Assets panel.

### Asset inspector rework (`src/editor/panels/AssetInspector.jsx`)
Extracted from InspectorPanel. Header: rename field (rename_path, carries `.meta`
sidecar), type badge, path. Per type: textures = image preview on checkerboard +
dimensions + Import Settings (filter linear/nearest, wrap U/V, tiling, flipY —
saved to `<file>.meta`, live-applied via `refreshMaterialsUsingTexture`);
.glb = 3D turntable preview (OWN second WebGPURenderer on a small canvas, plays
first clip, auto-framed) + mesh/tri counts + clip list; .mat = MaterialEditor;
.anim = summary + Edit button; .entity = component summary. `.meta` files hidden
from the Assets grid; delete/rename carry sidecars.

### Texture .meta plumbing
`assetResolver.js` gained `setAssetMetaLoader/loadAssetMeta` (editor: read_text_file,
player: fetch, default null). `src/engine/textureMeta.js`: TEXTURE_META_DEFAULTS +
`applyTextureMeta(texture, meta)` (filter/wrap/repeat/flipY). materialAsset applies
it when loading `def.map`. exportGame ships `.meta` sidecars for claimed textures,
claims `.anim` controllers, and rewrites model `materials` override paths.

Debts added: second WebGPURenderer per model preview is untested on weak GPUs;
unpack moves the source .glb (references in existing scenes would break — only
auto-runs on fresh imports); .mat still only carries color/rough/metal/map (normal/
emissive maps extracted but unused); no per-transition multi-edge between the same
state pair. Hierarchy accepts .entity/.glb drops (rows = add as child, empty
space = scene root) via the same useAssetDrop registry.

## Modules system + Rapier physics (2026-07-05 — build + headless verified, NOT clicked through)

Unity-style engine modules: optional feature packs enabled per project, shipped with
exported games.

### Module system
- `src/engine/modules.js`: `registerModuleDefinition({id, name, description, version,
  components, async setup(engine) -> {dispose?}})`, `enable/disableEngineModule(engine,
  id)`, `applyEngineModules(engine, ids)`. `engine.modules` = Map(id -> setup handle);
  "modules-changed" event. Heavy deps (wasm) go in setup() as dynamic imports so
  disabled modules cost nothing (vite code-splits: rapier is its own 830KB-gzip chunk).
- `src/modules/index.js` = built-in catalog (importing it registers definitions). Same
  rule as src/engine: **no React, no Tauri** — modules ship with exported games.
- Component registry is now tolerant: unknown types become `MissingComponent`
  (registry.js) which keeps type+props and serializes back unchanged, so disabling a
  module never corrupts scenes. Inspector shows "Missing — enable its module" section.
- Editor: `src/editor/modules.js` (`useModulesStore`, `syncProjectModules()` at boot in
  EditorChrome **before restoreLastScene** — components must register before the scene
  deserializes; `setModuleEnabled` persists to project.json `modules: [ids]` + applies
  live). ModulesPanel (Window → Modules, panel id "modules"): catalog cards with
  enable switches, disabled while playing.
- Export: scene.json gains `modules: [ids]`; player main.js imports the catalog and
  `applyEngineModules(engine, scene.modules)` before deserializeScene.
- Inspector gained a `vec3` schema field type (three number inputs).

### physics-rapier module (`src/modules/physics-rapier/`)
- `@dimforge/rapier3d-compat` (wasm inlined, works headless in node), imported
  dynamically in setup(); `RAPIER.init()` prints a harmless deprecation warning.
- `PhysicsSystem` (exposed as `engine.physics`): world builds from the entity tree on
  play start ("play-changed" true), freed on stop (editor snapshot restores the scene
  anyway). Fixed-step 1/60 accumulator (max 4 substeps) driven from engine.onUpdate.
  Dynamic bodies write world pos/quat back to entities (parent-local converted);
  kinematic bodies follow their entity via setNextKinematicTranslation/Rotation.
  Collision events -> script hooks `onCollisionEnter/Exit(otherEntity)` and
  `onTriggerEnter/Exit` (sensor) + engine "collision"/"trigger" events.
  `engine.physics.raycast(origin, dir, maxDist) -> {entity, point, normal, distance}`,
  `setGravity([x,y,z])`.
- `RigidbodyComponent` ("rigidbody"): bodyType dynamic/kinematic/fixed, mass (set via
  ColliderDesc.setMass for correct inertia), damping, gravityScale, ccd, per-axis
  rotation locks. Script API: applyImpulse/applyForce/applyTorqueImpulse/
  set+getLinearVelocity/set+getAngularVelocity/teleport — all on `this.body`, which
  PhysicsSystem assigns on play and nulls on stop (methods no-op in editor).
- `ColliderComponent` ("collider"): box/sphere/capsule/mesh(trimesh from rendered
  geometry, static use), size/radius/height/offset, friction, restitution, isSensor.
  World scale baked into shape dims at build (Rapier can't scale shapes). A collider
  without a rigidbody = static; with a rigidbody on an ANCESTOR = compound child
  collider attached to that body. Green wireframe gizmo on EDITOR_LAYER
  (raycast-noop so picking ignores it).
- Headless test: `node scripts/test-physics.mjs` (fall/rest, collision + trigger
  events, raycast, impulse, compound bodies, disable/unregister, missing-component
  round-trip). All passing; **needs a live click-through** (enable module in Window →
  Modules, add Rigidbody+Collider to a box, Play).

## WebGPU UI system (2026-07-05 — build + headless tests + partial live click-through)

Screen-space 2D UI rendered entirely in WebGPU (no HTML overlay). UI elements are
regular entities with UI components, so hierarchy/undo/serialization/prefabs work
unchanged.

### Architecture (`src/engine/ui/`)
- `layout.js` — pure math, zero deps: Unity-style rects (anchorMin/Max, pivot,
  pos, size; on a stretched axis pos/size become left/right insets), flexbox-ish
  `layoutChildren` (row/column, gap, padding, align, justify, space-between),
  `computeScreenScale` (fit/fill/width/height/none vs reference resolution),
  `ANCHOR_PRESETS` + `applyAnchorPreset`. Tested by `scripts/test-ui-layout.mjs`.
- `uiMaterial.js` — TSL `MeshBasicNodeMaterial`s (transparent, depthTest off,
  painter's order via renderOrder): SDF rounded-rect + border ring + fill-amount
  cutoff (progress bars) + optional texture; **clipping = screen-space clip-rect
  uniform (physical px, via `screenCoordinate`)** — masks/scroll need no stencil.
  Texture or fillMode changes rebuild the material; all else is uniform writes.
- `uiText.js` — canvas-2D rasterizer at physical resolution (rect × scale × DPR),
  wrapping + h/v align; UiText redraws only when style or physical size changes.
- `UiSystem.js` — per-engine runtime (`getUiSystem(engine)`; stored as
  `engine.uiSystem` **property, not WeakMap — the editor's lazy-engine Proxy shim
  is a different object identity than the real engine**; that bug was found live:
  viewport picking/highlight silently got null). Owns: `UI_LAYER = 30` (scene
  cameras never enable it; UI meshes set it + `raycast = noop`), a per-frame
  layout pass (writes `object3D.position` = pivot point, UI y-down → three -y;
  screen root pinned to identity), a post-render ortho pass (0..w / 0..-h,
  autoClear juggling like CameraPreview, per-screen camera + sibling screens
  hidden), pointer/wheel input on the renderer canvas (playing only: button
  hover/press/click with 5px slop, drag-scroll + wheel-scroll), `hitTest()` for
  the editor, and `setHighlight(entityId)` (blue rect outline, editor-only).
  Scroll content extent is measured AFTER each child's recursion so a child
  uilayout `fitContent` growth (shared rect object mutation) is seen.

### Components (core — registered in `src/engine/index.js`)
`uiscreen` (referenceWidth/Height + scaleMode + sortOrder — resize-responsive by
construction), `uielement` (the RectTransform; layout pass writes `.rect`,
`.clipRect`, `.worldAlpha`, `.layoutControlled` on it), `uiimage` (color/texture/
cornerRadius/border/fillMode/fillAmount, runtime `setTint()` for buttons),
`uitext` (text/font/size/weight/align/wrap/lineHeight), `uibutton` (tint states;
click → script `onClick()` hook on the same entity + engine `"ui-click"` event;
hover ↔ script `onPointerEnter/Exit`), `uilayout` (direction/gap/padding/
alignItems/justify/fitContent), `uiscroll` (vertical/horizontal/dragScroll/
wheelSpeed; `scrollTo(x,y)` script API), `uimask` (rect clip, nesting = rect
intersection). Entities without `uielement` under a screen stretch-fill parent.

### Editor integration
- Hierarchy “+” menu: UI section (Screen / Panel / Image / Text / Button / Layout
  / Scroll View). Button + Scroll View presets create nested children —
  `CreateEntityCommand` now supports `spec.children` (serialized snapshot reused
  on redo so ids survive). UI-aware entity icons.
- Inspector: custom UI Element section — 3×3 anchor-preset grid + stretch
  buttons (`.anchor-preset-*` in theme.css), field labels adapt (X/Y + W/H vs
  Left/Top + Right/Bottom insets), pivot/opacity/visible/raycastTarget; preset
  applies as one BatchCommand.
- Viewport: click picks UI first (`uiSystem.hitTest`, topmost incl. clip check;
  falls through to 3D raycast on empty UI space); dragging an already-selected
  element moves it (props rewound pre-command so oldValue is right; stretched
  axes shift both insets); gizmo/selection-box/F-focus all skip UI entities;
  selection shows the 2D outline instead.

### Verification status
`npm run build` + `build:player` clean; `scripts/test-ui-layout.mjs` (27 checks)
and `scripts/test-ui-system.mjs` (24 checks — full component stack layout with a
stubbed renderer incl. mask clipping, scroll clamp+measure, button tints,
serialization round-trip) pass. Live-verified in Chrome (vite dev, WebGPU):
create screen/panel/button, rendering (rounded corners, crisp text), inspector
custom section, viewport UI picking + selection outline. **Not yet clicked
through: play-mode button clicks/hover, scroll views, window-resize reflow,
drag-move commit, textures on UiImage.**

### Known debts / future work
- 9-slice sprites (schema slot omitted; SDF corner radius covers panels).
- Text auto-size (measureText exists in uiText.js, unused).
- No multi-edge editing gizmo (resize handles) — inspector or drag-move only.
- Editor pick selects the deepest element (e.g. a button's Label); no
  alt-click-to-cycle yet.
- Transform position on UI entities is layout-owned (edits get stomped);
  rotation/scale still apply around the pivot.

## Key constraints (unchanged)
- `src/engine` must never import React or Tauri.
- three.js scene is the source of truth; zustand only mirrors metadata.
- Every editor mutation goes through the command bus.
- `three/webgpu` + `three/tsl` only; never legacy ShaderMaterial.
