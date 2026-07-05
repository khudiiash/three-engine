import { Suspense, lazy } from "react";
import { DockviewReact, themeAbyss } from "dockview-react";

const LAYOUT_KEY = "engine.layout.v1";

// Heavy panels: lazy so their deps (three/webgpu, @xyflow/react,
// particleGraph) don't enter the boot path. The viewport alone pulls in
// the entire three.js WebGPU runtime; shader + particles pull in @xyflow.
const ViewportPanel = lazy(() => import("./panels/ViewportPanel.jsx").then((m) => ({ default: m.ViewportPanel })));
const HierarchyPanel = lazy(() => import("./panels/HierarchyPanel.jsx").then((m) => ({ default: m.HierarchyPanel })));
const InspectorPanel = lazy(() => import("./panels/InspectorPanel.jsx").then((m) => ({ default: m.InspectorPanel })));
const AssetsPanel = lazy(() => import("./panels/AssetsPanel.jsx").then((m) => ({ default: m.AssetsPanel })));
const ConsolePanel = lazy(() => import("./panels/ConsolePanel.jsx").then((m) => ({ default: m.ConsolePanel })));
const ShaderGraphPanel = lazy(() => import("./panels/ShaderGraphPanel.jsx").then((m) => ({ default: m.ShaderGraphPanel })));
const ParticlesPanel = lazy(() => import("./panels/ParticlesPanel.jsx").then((m) => ({ default: m.ParticlesPanel })));
const MaterialPanel = lazy(() => import("./panels/MaterialPanel.jsx").then((m) => ({ default: m.MaterialPanel })));
const AnimatorPanel = lazy(() => import("./panels/AnimatorPanel.jsx").then((m) => ({ default: m.AnimatorPanel })));
const SceneSettingsPanel = lazy(() => import("./panels/SceneSettingsPanel.jsx").then((m) => ({ default: m.SceneSettingsPanel })));
const ProjectSettingsPanel = lazy(() => import("./panels/ProjectSettingsPanel.jsx").then((m) => ({ default: m.ProjectSettingsPanel })));
const ModulesPanel = lazy(() => import("./panels/ModulesPanel.jsx").then((m) => ({ default: m.ModulesPanel })));
const InputPanel = lazy(() => import("./panels/InputPanel.jsx").then((m) => ({ default: m.InputPanel })));

const panelComponents = {
  viewport: ViewportPanel,
  hierarchy: HierarchyPanel,
  inspector: InspectorPanel,
  assets: AssetsPanel,
  console: ConsolePanel,
  shaderGraph: ShaderGraphPanel,
  particles: ParticlesPanel,
  material: MaterialPanel,
  animator: AnimatorPanel,
  sceneSettings: SceneSettingsPanel,
  projectSettings: ProjectSettingsPanel,
  modules: ModulesPanel,
  input: InputPanel,
};

// The chrome (menu bar + scene/keyboard bootstrap) is lazy-loaded behind a
// Suspense boundary so the entire chain of MenuBar → clipboard → entityCommands
// → engine/index.js doesn't enter the boot module graph until after the
// project hub is dismissed. Viewport/Shaders panels do the same.
const EditorChrome = lazy(() => import("./EditorChrome.jsx").then((m) => ({ default: m.EditorChrome })));

function PanelFallback() {
  return <div style={{ padding: 12, color: "#9aa3b2", fontSize: 12 }}>Loading…</div>;
}

/** Where each panel prefers to (re)open. referencePanel falls back if closed too. */
export const PANEL_SPECS = {
  viewport: { title: "Viewport" },
  hierarchy: { title: "Hierarchy", position: { referencePanel: "viewport", direction: "left" }, initialWidth: 260 },
  inspector: { title: "Inspector", position: { referencePanel: "viewport", direction: "right" }, initialWidth: 320 },
  assets: { title: "Assets", position: { referencePanel: "viewport", direction: "below" }, initialHeight: 200 },
  console: { title: "Console", position: { referencePanel: "assets", direction: "within" } },
  shaderGraph: { title: "Shader Graph", position: { referencePanel: "assets", direction: "within" } },
  particles: { title: "Particles", position: { referencePanel: "inspector", direction: "within" } },
  material: { title: "Material", position: { referencePanel: "inspector", direction: "within" } },
  animator: { title: "Animator", position: { referencePanel: "assets", direction: "within" } },
  sceneSettings: { title: "Scene Settings", position: { referencePanel: "inspector", direction: "within" } },
  projectSettings: { title: "Project Settings", position: { referencePanel: "inspector", direction: "within" } },
  modules: { title: "Modules", position: { referencePanel: "inspector", direction: "within" } },
  input: { title: "Input", position: { referencePanel: "viewport", direction: "below" }, initialHeight: 280 },
};

let dockApi = null;

/** Opens any panel (focuses it if already present), even after it was closed. */
export function openPanel(id) {
  if (!dockApi) return;
  const existing = dockApi.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const spec = PANEL_SPECS[id];
  if (!spec) return;
  const { position, ...rest } = spec;
  const options = { id, component: id, ...rest };
  // Only use the preferred position if its anchor panel is actually open;
  // otherwise dockview throws. Fall back to docking next to whatever exists.
  if (position?.referencePanel && dockApi.getPanel(position.referencePanel)) {
    options.position = position;
  } else if (position && !position.referencePanel) {
    options.position = position;
  } else if (dockApi.panels.length > 0) {
    options.position = { referencePanel: dockApi.panels[0].id, direction: "within" };
  }
  const panel = dockApi.addPanel(options);
  panel.api.setActive();
}

/** Wipes the saved layout and rebuilds the default one. */
export function resetLayout() {
  if (!dockApi) return;
  localStorage.removeItem(LAYOUT_KEY);
  dockApi.clear();
  buildDefaultLayout(dockApi);
}

function buildDefaultLayout(api) {
  api.addPanel({ id: "viewport", component: "viewport", title: "Viewport" });
  api.addPanel({
    id: "hierarchy",
    component: "hierarchy",
    title: "Hierarchy",
    position: { referencePanel: "viewport", direction: "left" },
    initialWidth: 260,
  });
  api.addPanel({
    id: "inspector",
    component: "inspector",
    title: "Inspector",
    position: { referencePanel: "viewport", direction: "right" },
    initialWidth: 320,
  });
  const assets = api.addPanel({
    id: "assets",
    component: "assets",
    title: "Assets",
    position: { referencePanel: "viewport", direction: "below" },
    initialHeight: 200,
  });
  api.addPanel({
    id: "console",
    component: "console",
    title: "Console",
    position: { referencePanel: "assets", direction: "within" },
  });
  assets.api.setActive();
}

function onDockReady(event) {
  const { api } = event;
  dockApi = api;
  let restored = false;
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved) {
      api.fromJSON(JSON.parse(saved));
      restored = true;
    }
  } catch (err) {
    console.warn(`Failed to restore layout, using default: ${err.message}`);
  }
  if (!restored || api.panels.length === 0) {
    if (restored) api.clear();
    buildDefaultLayout(api);
  }

  let saveTimer = null;
  api.onDidLayoutChange(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
    }, 500);
  });
}

export function EditorShell() {
  return (
    <div className="editor-root">
      <Suspense fallback={<PanelFallback />}>
        <EditorChrome />
      </Suspense>
      <div className="dock-container">
        <Suspense fallback={<PanelFallback />}>
          <DockviewReact components={panelComponents} onReady={onDockReady} theme={themeAbyss} />
        </Suspense>
      </div>
    </div>
  );
}
