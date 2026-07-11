import { useEffect, useState } from "react";
import { Plus, Trash2, Check } from "lucide-react";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { AssetField } from "../fields/AssetField.jsx";
import { TEXTURE_EXTENSIONS } from "../assetLoader.js";
import { SCULPT_TOOLS, MAX_TERRAIN_LAYERS, makeTerrainLayer } from "../../modules/terrain/TerrainComponent.js";
import {
  armTerrainBrush,
  disarmTerrainBrush,
  getTerrainBrushMode,
  getTerrainBrushSettings,
  setTerrainBrushSetting,
  subscribeTerrainBrush,
} from "../terrainBrush.js";

const TOOL_HINTS = {
  raise: "Push the surface up",
  lower: "Push the surface down",
  smooth: "Average out bumps and noise",
  flatten: "Level toward the height where the stroke started",
  sharpen: "Amplify detail — accent ridges and creases",
  erode: "Carve downhill — weathered valleys and channels",
  noise: "Add coherent random bumps for natural variation",
};

function NumberInput({ value, min, max, step = 0.1, onCommit }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = parseFloat(text);
    if (!Number.isNaN(n)) {
      let v = n;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      onCommit(v);
    } else {
      setText(String(value));
    }
  };
  return (
    <input
      className="number-field"
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Escape") {
          setText(String(value));
          e.target.blur();
        }
      }}
    />
  );
}

function PropRow({ label, children }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * Terrain component's inspector section: arm/disarm the sculpt & paint
 * brushes (viewport pointer handlers in ViewportPanel.jsx read the armed
 * state from terrainBrush.js), brush parameter controls, and the texture
 * layer list (up to 4, blended via the splatmap — see TerrainComponent.js).
 * Exactly one layer is "active" at a time; painting writes that layer's
 * splat channel.
 */
export function TerrainSection({ entityId, props }) {
  const [, force] = useState(0);
  useEffect(() => subscribeTerrainBrush(() => force((v) => v + 1)), []);

  const mode = getTerrainBrushMode();
  const settings = getTerrainBrushSettings();
  const layers = props.layers ?? [];
  const activeLayer = Math.min(settings.activeLayer, Math.max(0, layers.length - 1));

  const commit = (key, value) =>
    commandBus.execute(new SetComponentPropCommand(entityId, "terrain", key, value));

  const toggleMode = (next) => {
    if (mode === next) disarmTerrainBrush();
    else armTerrainBrush(next);
  };

  const addLayer = () => {
    if (layers.length >= MAX_TERRAIN_LAYERS) return;
    commit("layers", [...layers, makeTerrainLayer()]);
    setTerrainBrushSetting("activeLayer", layers.length); // select the new one
  };
  const removeLayer = (i) => {
    commit("layers", layers.filter((_, idx) => idx !== i));
    setTerrainBrushSetting("activeLayer", Math.max(0, Math.min(activeLayer, layers.length - 2)));
  };
  const updateLayer = (i, patch) => {
    commit("layers", layers.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };

  return (
    <>
      <div className="inspector-subheader">Brush</div>
      <div className="camera-follow-row">
        <button
          className={`toolbar-btn ${mode === "sculpt" ? "active" : ""}`}
          onClick={() => toggleMode("sculpt")}
          title="Sculpt terrain height with the mouse in the viewport"
        >
          {mode === "sculpt" ? "Sculpting…" : "Sculpt"}
        </button>
        <button
          className={`toolbar-btn ${mode === "paint" ? "active" : ""}`}
          onClick={() => toggleMode("paint")}
          title="Paint the active texture layer with the mouse in the viewport"
        >
          {mode === "paint" ? "Painting…" : "Paint"}
        </button>
      </div>
      {mode && (
        <div className="inspector-hint" style={{ margin: "2px 2px 6px" }}>
          {mode === "sculpt"
            ? "Drag over the terrain to sculpt. Right-drag still orbits."
            : `Drag over the terrain to paint Layer ${activeLayer + 1}.`}
        </div>
      )}

      {mode === "sculpt" && (
        <PropRow label="Tool">
          <select
            className="select-field"
            value={settings.tool}
            title={TOOL_HINTS[settings.tool]}
            onChange={(e) => setTerrainBrushSetting("tool", e.target.value)}
          >
            {SCULPT_TOOLS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </PropRow>
      )}

      {mode && (
        <>
          <PropRow label="Radius">
            <NumberInput value={settings.radius} min={0.1} step={0.5} onCommit={(v) => setTerrainBrushSetting("radius", v)} />
          </PropRow>
          <PropRow label="Strength">
            <NumberInput value={settings.strength} min={0.01} max={1} step={0.05} onCommit={(v) => setTerrainBrushSetting("strength", v)} />
          </PropRow>
          <PropRow label="Hardness">
            <NumberInput value={settings.hardness} min={0} max={1} step={0.05} onCommit={(v) => setTerrainBrushSetting("hardness", v)} />
          </PropRow>
        </>
      )}

      <div className="inspector-subheader">
        Texture Layers
        {mode === "paint" && <span style={{ opacity: 0.6, fontWeight: 400 }}> — click to select active</span>}
      </div>
      {layers.length === 0 && (
        <div className="inspector-hint" style={{ margin: "4px 2px 8px" }}>
          No layers yet. Add one and assign a texture, then paint it in.
        </div>
      )}
      {layers.map((layer, i) => (
        <div
          key={i}
          className={`terrain-layer ${activeLayer === i ? "active" : ""}`}
          onClick={() => setTerrainBrushSetting("activeLayer", i)}
          title="Click to make this the active paint layer"
        >
          <div className="terrain-layer-header">
            <span className={`terrain-layer-badge ${activeLayer === i ? "active" : ""}`}>
              {activeLayer === i ? <Check size={11} /> : i + 1}
            </span>
            <span className="terrain-layer-title">Layer {i + 1}</span>
            <button
              className="icon-btn"
              title="Remove layer"
              onClick={(e) => {
                e.stopPropagation();
                removeLayer(i);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <PropRow label="Albedo">
              <AssetField
                descriptor={{ exts: TEXTURE_EXTENSIONS }}
                value={layer.albedo ?? layer.texture ?? ""}
                onCommit={(v) => updateLayer(i, { albedo: v })}
              />
            </PropRow>
            <PropRow label="Normal">
              <AssetField
                descriptor={{ exts: TEXTURE_EXTENSIONS }}
                value={layer.normalMap ?? ""}
                onCommit={(v) => updateLayer(i, { normalMap: v })}
              />
            </PropRow>
            <PropRow label="Roughness Map">
              <AssetField
                descriptor={{ exts: TEXTURE_EXTENSIONS }}
                value={layer.roughnessMap ?? ""}
                onCommit={(v) => updateLayer(i, { roughnessMap: v })}
              />
            </PropRow>
            <PropRow label="Tint">
              <input
                className="color-field"
                type="color"
                value={layer.tint ?? "#8a8f7a"}
                onChange={(e) => updateLayer(i, { tint: e.target.value })}
              />
            </PropRow>
            <PropRow label="Tiling">
              <NumberInput value={layer.tiling ?? 20} min={0.1} step={1} onCommit={(v) => updateLayer(i, { tiling: v })} />
            </PropRow>
            <PropRow label="Roughness">
              <NumberInput value={layer.roughness ?? 0.95} min={0} max={1} step={0.05} onCommit={(v) => updateLayer(i, { roughness: v })} />
            </PropRow>
            <PropRow label="Metalness">
              <NumberInput value={layer.metalness ?? 0} min={0} max={1} step={0.05} onCommit={(v) => updateLayer(i, { metalness: v })} />
            </PropRow>
          </div>
        </div>
      ))}
      <button className="toolbar-btn wide" onClick={addLayer} disabled={layers.length >= MAX_TERRAIN_LAYERS}>
        <Plus size={14} /> Add layer
      </button>
    </>
  );
}
