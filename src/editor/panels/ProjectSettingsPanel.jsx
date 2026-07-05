import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { useProjectStore, basename } from "../store/projectStore.js";
import { getProjectSettings, saveProjectSettings } from "../projectSettings.js";

function Row({ label, children }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

function Num({ value, onChange, min, max, step = 0.1 }) {
  return (
    <input
      className="number-field"
      type="number"
      step={step}
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
    />
  );
}

/**
 * Project-wide settings (project.json `settings`): editor behavior, script
 * hot reload, performance, export metadata. Not undoable — these are
 * preferences, not scene edits. Save writes the file and applies live.
 */
export function ProjectSettingsPanel() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const projectName = useProjectStore((s) => s.projectMeta?.name);
  const [settings, setSettings] = useState(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (rootPath) setSettings(getProjectSettings());
  }, [rootPath]);

  if (!rootPath) {
    return <div className="inspector-panel empty">Open a project to edit its settings.</div>;
  }
  if (!settings) return <div className="inspector-panel empty">Loading…</div>;

  const patch = (section, p) => {
    setSettings({ ...settings, [section]: { ...settings[section], ...p } });
    setDirty(true);
  };

  const save = async () => {
    try {
      await saveProjectSettings(settings);
      setDirty(false);
      console.log("Project settings saved");
    } catch (err) {
      console.error(`Failed to save project settings: ${err}`);
    }
  };

  const { editor, scripts, rendering, game } = settings;

  return (
    <div className="inspector-panel scene-settings-panel">
      <div className="panel-toolbar">
        <span className="asset-path" title={rootPath}>
          {projectName ?? basename(rootPath)}
        </span>
        <button className="toolbar-btn" disabled={!dirty} onClick={save}>
          <Save size={13} />
          Save{dirty ? " •" : ""}
        </button>
      </div>

      <div className="inspector-section">
        <div className="section-header">Editor</div>
        <Row label="Autosave (s)">
          <Num value={editor.autosaveSeconds} min={0} step={5} onChange={(v) => patch("editor", { autosaveSeconds: v })} />
        </Row>
        <Row label="Snap move">
          <Num value={editor.snapTranslate} min={0.01} step={0.1} onChange={(v) => patch("editor", { snapTranslate: v })} />
        </Row>
        <Row label="Snap rotate°">
          <Num value={editor.snapRotateDeg} min={1} max={90} step={1} onChange={(v) => patch("editor", { snapRotateDeg: v })} />
        </Row>
        <Row label="Snap scale">
          <Num value={editor.snapScale} min={0.01} step={0.05} onChange={(v) => patch("editor", { snapScale: v })} />
        </Row>
        <Row label="Show grid">
          <input type="checkbox" checked={editor.showGrid !== false} onChange={(e) => patch("editor", { showGrid: e.target.checked })} />
        </Row>
        <Row label="Grid size">
          <Num value={editor.gridSize} min={2} step={2} onChange={(v) => patch("editor", { gridSize: v })} />
        </Row>
        <Row label="Divisions">
          <Num value={editor.gridDivisions} min={1} step={1} onChange={(v) => patch("editor", { gridDivisions: v })} />
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Scripts</div>
        <Row label="Hot reload">
          <input type="checkbox" checked={scripts.hotReload !== false} onChange={(e) => patch("scripts", { hotReload: e.target.checked })} />
        </Row>
        <Row label="Poll (ms)">
          <Num value={scripts.reloadIntervalMs} min={100} step={50} onChange={(v) => patch("scripts", { reloadIntervalMs: v })} />
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Performance</div>
        <Row label="Pixel ratio cap">
          <Num value={rendering.pixelRatioCap} min={0.5} max={4} step={0.25} onChange={(v) => patch("rendering", { pixelRatioCap: v })} />
        </Row>
      </div>

      <div className="inspector-section">
        <div className="section-header">Game</div>
        <Row label="Title">
          <input
            className="text-field"
            type="text"
            value={game.title}
            placeholder={projectName ?? basename(rootPath)}
            onChange={(e) => patch("game", { title: e.target.value })}
          />
        </Row>
      </div>

      <div className="asset-hint" style={{ padding: "4px 10px" }}>
        Stored in project.json. Scene look (background, fog, tone mapping…) lives in Scene Settings.
      </div>
    </div>
  );
}
