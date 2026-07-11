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

/**
 * Finds the id of a currently visible panel to use as a positioning
 * anchor when the spec's preferred anchor is closed. Dockview exposes
 * `api.panels` (all panels, including hidden ones) and `panel.api.isVisible`
 * per-panel — we want the first VISIBLE one so the `addPanel` call below
 * doesn't silently fail (issue: when the anchor panel has been closed by
 * the user, addPanel against it as a reference can no-op without
 * logging). Active panel first, then iterate visible panels.
 */
function pickVisibleAnchorId() {
  const active = dockApi.activePanel;
  if (active?.api?.isVisible) return active.id;
  for (const panel of dockApi.panels) {
    if (panel.api?.isVisible) return panel.id;
  }
  return null;
}

/** Opens any panel (focuses it if already present), even after it was closed. */
export function openPanel(id) {
  if (!dockApi) {
    console.warn(`openPanel(${id}) called before Dockview was ready`);
    return;
  }
  const existing = dockApi.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const spec = PANEL_SPECS[id];
  if (!spec) {
    console.warn(`openPanel(${id}) called with no matching PANEL_SPECS entry`);
    return;
  }
  const { position, ...rest } = spec;
  const options = { id, component: id, ...rest };
  // Position selection. We pick the first matching rule so the "right
  // thing" is always predictable:
  //   (a) No position in the spec → leave options.position unset;
  //       Dockview docks to the container edge (safest default).
  //   (b) Spec position has no reference panel (e.g. { direction: "right" })
  //       → use it as-is.
  //   (c) Spec position's anchor is visible → use it.
  //   (d) Spec position's anchor is hidden/missing → fall back to any
  //       currently visible panel as a "within" anchor so the panel still
  //       appears instead of silently failing. (This is the bugfix: the
  //       old logic picked `dockApi.panels[0]`, which is the first panel
  //       in serialization order and is often the very same hidden
  //       anchor the spec wanted — addPanel then no-ops without logging.)
  //   (e) No visible panels at all → leave options.position unset so
  //       Dockview docks to the container edge instead of failing.
  if (!position) {
    // (a)
  } else if (!position.referencePanel) {
    options.position = position; // (b)
  } else if (dockApi.getPanel(position.referencePanel)?.api?.isVisible) {
    options.position = position; // (c)
  } else if (dockApi.panels.some((p) => p.api?.isVisible)) {
    // (d) — log so future layout-fallback surprises are debuggable.
    console.warn(
      `openPanel(${id}): preferred anchor "${position.referencePanel}" is not visible; docking to a visible panel.`,
    );
    options.position = {
      referencePanel: pickVisibleAnchorId(),
      direction: "within",
    };
  }
  // (e) — no `options.position` set: addPanel docks to container edge.
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
