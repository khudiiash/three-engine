import { useEffect, useState } from "react";
import { Box, Blocks, Building2, Cylinder, DoorOpen, Eraser, MousePointer2, Pencil, Plus, RectangleVertical, Redo2, RotateCcw, SlidersHorizontal, Square, TriangleRight, Undo2, X } from "../icons/index.jsx";
import { engine } from "../engineInstance.js";
import { useSceneStore } from "../store/sceneStore.js";
import { commandBus } from "../commands/CommandBus.js";
import { EntityField } from "../fields/EntityField.jsx";
import { AssetField } from "../fields/AssetField.jsx";
import { createArchitectureAssembly } from "../architectureBuild.js";
import { closeArchitectureWorkspace, openArchitectureWorkspace, useArchitectureWorkspace } from "../architectureWorkspaceStore.js";
import { ARCHITECTURE_PRESETS, normalizeArchitectureSettings } from "../../modules/architecture/blueprints.js";
import { ArchitectureField, ArchitectureNumber, ArchitectureSettings } from "./ArchitectureBuilder.jsx";
import { ArchitectureSelectionControls } from "./ArchitectureSelectionControls.jsx";
import { ArchitectureSculptControls, ArchitectureSculptSettings, SCULPT_TOOLS } from "./ArchitectureSculptControls.jsx";
import { armArchitectureSculpt, disarmArchitectureSculpt, getArchitectureSculptState, subscribeArchitectureSculpt, setArchitectureSculptSetting } from "../architectureSculptTool.js";
import {
  armArchitectureTool, disarmArchitectureTool, getArchitectureToolState, setArchitectureDrawSetting,
  setArchitectureDrawShape, setArchitectureDrawParent, subscribeArchitectureTool,
  armArchitecturePlacement, disarmArchitecturePlacement, getArchitecturePlacementState,
  setArchitecturePlacementSetting, subscribeArchitecturePlacement,
} from "../architectureTool.js";
import "../architecture.css";

const DRAW = [
  ["wall", "Wall", RectangleVertical, "Drag between wall endpoints"],
  ["floor", "Slab", Square, "Drag a rectangular slab"],
  ["column", "Column", Cylinder, "Click or drag a column radius"],
  ["stair", "Stair", Blocks, "Drag the stair direction and run"],
  ["ramp", "Ramp", TriangleRight, "Drag the ramp direction and run"],
  ["box", "Block", Box, "Drag a block footprint"],
  ["door", "Door", DoorOpen, "Click a wall to cut a doorway"],
  ["window", "Window", Square, "Click a wall to cut a window"],
  ["arch", "Arch", DoorOpen, "Click a wall to cut an archway"],
  ["erase", "Erase", Eraser, "Click an architectural piece to remove it"],
];
const COLORS = [["#d5d1c7", "Limestone"], ["#bd8d76", "Terracotta"], ["#dcc79c", "Sandstone"], ["#829b8c", "Sage"], ["#829aa9", "Slate blue"], ["#766c69", "Charcoal"]];
const PRESETS = ARCHITECTURE_PRESETS.filter((preset) => preset.kind !== "assembly");
const stopPointer = (event) => event.stopPropagation();
const message = (error) => error?.message || String(error);

function useToolState(get, subscribe) {
  const [state, setState] = useState(get);
  useEffect(() => subscribe(() => setState(get())), [get, subscribe]);
  return state;
}

function ContextNumber({ label, value, onChange, min = 0, max = 10000, step = .1, ariaLabel }) {
  return <label className="architecture-context-field"><span>{label}</span>
    <ArchitectureNumber label={ariaLabel || label} value={value} min={min} max={max} step={step} onChange={onChange} />
  </label>;
}

/** Small code-native silhouettes make the stamp shelf readable at a glance. */
function StampIcon({ id }) {
  const house = (x, y, w = 20, h = 18) => <g transform={`translate(${x} ${y})`}>
    <path d={`M0 0 L${w / 2} -7 L${w} 0 V${h} H0Z`} fill="var(--arch-stone)" />
    <path d={`M-2 0 L${w / 2} -9 L${w + 2} 0`} fill="var(--arch-roof)" stroke="var(--arch-roof)" strokeWidth="2" strokeLinejoin="round" />
    <path d={`M${w / 2 - 2} ${h} v-7 h4 v7 M3 5 h4 v4 H3Z M${w - 7} 5 h4 v4 h-4Z`} fill="var(--arch-window)" />
  </g>;
  return <svg viewBox="0 0 64 42" aria-hidden="true" className="architecture-stamp-icon">
    <ellipse cx="32" cy="37" rx="24" ry="3" fill="currentColor" opacity=".1" />
    {id === "bridge" ? <><path d="M7 27 H57 V32 H7Z M12 31 H17 V39 H12Z M47 31 H52 V39 H47Z" fill="var(--arch-stone)" /><path d="M7 24 H57 M10 22 V27 M20 22 V27 M30 22 V27 M40 22 V27 M50 22 V27" stroke="var(--arch-roof)" strokeWidth="2" /></>
      : id === "tower" || id === "apartment" ? <>{house(20, id === "tower" ? 9 : 16, 24, id === "tower" ? 28 : 21)}<path d="M24 22 h4 v4 h-4Z M36 22 h4 v4 h-4Z M24 13 h4 v4 h-4Z M36 13 h4 v4 h-4Z" fill="var(--arch-window)" /></>
      : id === "courtyard" || id === "fortress" ? <><path d="M12 20 H52 V36 H12Z" fill="var(--arch-stone)" /><path d="M28 37 V29 Q32 23 36 29 V37" fill="var(--arch-window)" />{house(8, 15, 14, 22)}{house(42, 15, 14, 22)}</>
      : id === "city" ? <>{house(9, 14, 16, 16)}{house(36, 10, 17, 18)}{house(25, 24, 17, 14)}</>
      : id === "pavilion" ? <><path d="M12 20 L32 7 L52 20Z" fill="var(--arch-roof)" /><path d="M15 20 H19 V37 H15Z M45 20 H49 V37 H45Z M12 37 H52" fill="var(--arch-stone)" stroke="var(--arch-stone)" /></>
      : id === "warehouse" ? house(8, 18, 48, 19) : id === "custom" ? <path d="M14 13 H37 V25 H51 V37 H14Z" fill="var(--arch-stone)" stroke="var(--arch-roof)" strokeWidth="2" /> : house(17, 17, 30, 20)}
  </svg>;
}

/** Nonmodal controls live inside the viewport. Empty space passes through to the canvas. */
export function ArchitectureWorkspace() {
  const ui = useArchitectureWorkspace();
  const parentNode = useSceneStore((state) => ui.parentId ? state.entities[ui.parentId] : null);
  const draw = useToolState(getArchitectureToolState, subscribeArchitectureTool);
  const sculpt = useToolState(getArchitectureSculptState, subscribeArchitectureSculpt);
  const placement = useToolState(getArchitecturePlacementState, subscribeArchitecturePlacement);
  const [drawer, setDrawer] = useState(false);
  const [settings, setSettings] = useState(() => normalizeArchitectureSettings({ preset: "house" }));
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [material, setMaterial] = useState("");
  const [color, setColor] = useState(COLORS[0][0]);
  const [stampElevation, setStampElevation] = useState(0);
  const [stampGrid, setStampGrid] = useState(1);
  const [stampRotation, setStampRotation] = useState(0);
  const activeShape = draw.shape === "opening" ? draw.settings.opening : draw.shape;
  const currentPreset = PRESETS.find((preset) => preset.id === settings.preset) || PRESETS[0];
  const safe = (fn) => { try { setError(""); return fn(); } catch (cause) { setError(message(cause)); } };
  const stop = () => { disarmArchitectureTool(); disarmArchitecturePlacement(); disarmArchitectureSculpt(); };
  const validParent = () => engine.getEntity(ui.parentId) ? ui.parentId : null;
  const close = () => { stop(); setDrawer(false); closeArchitectureWorkspace(); };
  const armDraw = (id = "wall") => {
    const shape = ["door", "window", "arch"].includes(id) ? "opening" : id;
    if (getArchitectureToolState().active) {
      setArchitectureDrawShape(shape);
      if (shape === "opening") setArchitectureDrawSetting("opening", id);
    } else {
      armArchitectureTool({ shape, parentId: validParent(), elevation: draw.elevation,
        grid: draw.settings.grid, height: draw.settings.wallHeight, thickness: draw.settings.wallThickness,
        slabThickness: draw.settings.slabThickness, stairWidth: draw.settings.stairWidth, rise: draw.settings.storeyHeight,
        collision: draw.settings.collision, columnSides: draw.settings.columnSides, opening: shape === "opening" ? id : "door", material, color });
    }
  };
  const drawSetting = (key, value) => safe(() => { if (!getArchitectureToolState().active) armDraw(); setArchitectureDrawSetting(key, value); });
  const sculptTool = (tool = "build") => safe(() => {
    const current = getArchitectureSculptState();
    if (current.active) setArchitectureSculptSetting("tool", tool);
    else armArchitectureSculpt({ ...current.settings, tool, entityId: current.entityId });
  });
  const chooseMode = (mode) => {
    stop(); setError(""); setDrawer(false);
    useArchitectureWorkspace.setState({ mode });
    if (mode === "draw") safe(() => armDraw());
    if (mode === "sculpt") sculptTool();
  };
  useEffect(() => {
    if (!ui.open) return;
    setError("");
    if (ui.mode === "sculpt") safe(() => {
      const current = getArchitectureSculptState();
      // Already armed ⇒ nothing to do. Re-arming here on every ui.open /
      // ui.request flip cancelled any gesture in flight (arm() cancels the
      // preview transaction, which UNDOES the form being dragged) and used to
      // stomp the user's chosen gesture tool back to "build".
      if (current.active) return;
      const target = validParent();
      const modelRoot = target && engine.getEntity(target)?.getComponent("architecture")?.props.model ? target : current.entityId;
      armArchitectureSculpt({ ...current.settings, tool: current.tool ?? "build", entityId: modelRoot, parentId: modelRoot === target ? null : target });
    });
    else if (ui.mode === "draw") safe(() => {
      if (getArchitectureToolState().active) setArchitectureDrawParent(validParent());
      else armDraw();
    });
    else if (ui.mode === "stamp") disarmArchitectureTool();
  }, [ui.open, ui.request]);
  useEffect(() => {
    if (ui.parentId && !engine.getEntity(ui.parentId)) useArchitectureWorkspace.setState({ parentId: null });
  }, [ui.parentId, parentNode]);
  useEffect(() => {
    if (draw.active && !ui.open) openArchitectureWorkspace({ mode: "draw", parentId: draw.parentId });
  }, [draw.active]);
  useEffect(() => {
    if (placement.active && !ui.open) openArchitectureWorkspace({ mode: "stamp", parentId: placement.parentId });
  }, [placement.active]);
  useEffect(() => {
    if (sculpt.active) useArchitectureWorkspace.setState({ open: true, mode: "sculpt" });
  }, [sculpt.active]);
  useEffect(() => {
    if (draw.active && draw.parentId && getArchitectureToolState().parentId === draw.parentId) {
      useArchitectureWorkspace.setState({ parentId: draw.parentId });
    }
  }, [draw.parentId, draw.active]);
  useEffect(() => {
    if (placement.active) setStampRotation(placement.rotationY);
  }, [placement.rotationY, placement.active]);
  useEffect(() => () => { disarmArchitectureTool(); disarmArchitecturePlacement(); disarmArchitectureSculpt(); closeArchitectureWorkspace(); }, []);
  const stamp = (preset) => safe(() => {
    const next = normalizeArchitectureSettings({ ...preset.settings, preset: preset.id,
      terrainFit: settings.terrainFit, terrainId: settings.terrainId, avoidWater: settings.avoidWater,
      waterClearance: settings.waterClearance, clearFoliage: settings.clearFoliage,
      foliagePadding: settings.foliagePadding, collision: settings.collision, materials: settings.materials });
    setSettings(next); setFieldError("");
    armArchitecturePlacement({ settings: next, parentId: validParent(), grid: stampGrid, elevation: stampElevation, rotationY: stampRotation });
  });
  const changeRecipe = (next) => {
    setSettings(next);
    if (placement.active) {
      try { setArchitecturePlacementSetting("settings", next); setError(""); }
      catch (cause) { disarmArchitecturePlacement(); setError(message(cause)); }
    }
  };
  const placementSetting = (key, value) => {
    if (key === "elevation") setStampElevation(value);
    if (key === "grid") setStampGrid(value);
    if (key === "rotationY") setStampRotation(value);
    if (placement.active) safe(() => setArchitecturePlacementSetting(key, value));
  };
  const newAssembly = async () => {
    try {
      const created = await createArchitectureAssembly({ position: [0, draw.elevation, 0] });
      useArchitectureWorkspace.setState({ parentId: created.entityId });
      if (draw.active) setArchitectureDrawParent(created.entityId);
    } catch (cause) { setError(message(cause)); }
  };
  if (!ui.open) return null;
  const shapeLabel = DRAW.find(([id]) => id === activeShape)?.[1] || "Select";
  const parentId = draw.active ? draw.parentId : ui.parentId;
  const targetName = engine.getEntity(parentId)?.name || "New assembly";
  const visibleError = error || sculpt.error || draw.error || placement.error;
  return <div className="architecture-workspace" data-architecture-workspace>
    {drawer && <aside className="architecture-flyout" data-architecture-flyout aria-label="Architecture settings" onPointerDown={stopPointer} onWheel={stopPointer}>
      <header><strong>{ui.mode === "sculpt" ? "Building" : ui.mode === "stamp" ? currentPreset.label : "Drawing"} settings</strong><button className="architecture-mini-button" aria-label="Close architecture settings" onClick={() => setDrawer(false)}><X size={13} /></button></header>
      <div className="architecture-flyout-body">
        {ui.mode === "sculpt" ? <ArchitectureSculptSettings state={sculpt} onError={setError} /> : ui.mode === "stamp" ? <>
          <ArchitectureField label="Parent"><EntityField value={validParent() || ""} descriptor={{ emptyLabel: "Scene root" }} onCommit={(id) => { useArchitectureWorkspace.setState({ parentId: id || null }); if (placement.active) setArchitecturePlacementSetting("parentId", id || null); }} /></ArchitectureField>
          <ArchitectureSettings settings={settings} onChange={changeRecipe} onError={(value) => { setFieldError(value); if (value) disarmArchitecturePlacement(); }} />
          {fieldError && <p className="architecture-error" role="alert">{fieldError}</p>}
          {!placement.active && <button className="architecture-primary" disabled={!!fieldError} onClick={() => safe(() => armArchitecturePlacement({ settings, parentId: validParent(), elevation: stampElevation, grid: stampGrid, rotationY: stampRotation }))}>Place in scene</button>}
        </> : <>
          <p className="architecture-hint">Draw at any elevation. Use Edit to reshape a selected piece.</p>
          <ArchitectureField label="Assembly"><EntityField value={parentId || ""} descriptor={{ emptyLabel: "New assembly on first stroke" }} onCommit={(id) => { useArchitectureWorkspace.setState({ parentId: id || null }); if (draw.active) setArchitectureDrawParent(id); }} /></ArchitectureField>
          <button className="toolbar-btn wide" onClick={newAssembly}><Plus size={12} /> New assembly</button>
          <div className="architecture-field-grid" style={{ marginTop: 14 }}>
            <ArchitectureField label="Angle snap (°)"><ArchitectureNumber label="Architecture angle snap" value={draw.settings.angleSnap} min={0} max={180} step={1} onChange={(value) => drawSetting("angleSnap", value)} /></ArchitectureField>
            <ArchitectureField label="Column sides"><ArchitectureNumber label="Architecture column sides" value={draw.settings.columnSides} min={3} max={48} step={1} onChange={(value) => drawSetting("columnSides", value)} /></ArchitectureField>
          </div>
          <label className="architecture-toggle"><input type="checkbox" checked={draw.settings.collision} onChange={(event) => drawSetting("collision", event.target.checked)} /> Physics colliders</label>
          <label className="architecture-toggle"><input type="checkbox" checked={draw.settings.openTreads} onChange={(event) => drawSetting("openTreads", event.target.checked)} /> Open stair treads</label>
          <ArchitectureField label="Surface material"><AssetField descriptor={{ exts: ["mat"], compact: true, emptyLabel: "Tinted surface" }} value={material} onCommit={(path) => { setMaterial(path); if (draw.active) setArchitectureDrawSetting("material", path); }} /></ArchitectureField>
        </>}
      </div>
    </aside>}
    <section className="architecture-shelf" data-architecture-shelf aria-label="Architecture tools" onPointerDown={stopPointer} onWheel={stopPointer} onKeyDown={(event) => {
      if (event.key === "Escape") { stop(); setDrawer(false); event.stopPropagation(); event.currentTarget.querySelector('button[role="tab"][aria-selected="true"]')?.focus(); }
      if (event.target.matches("input, textarea")) event.stopPropagation();
    }}>
      <header className="architecture-shelf-header">
        <span className="architecture-shelf-brand"><Building2 size={13} />Architecture</span>
        <div className="architecture-mode-switch" role="tablist" aria-label="Architecture mode">
          {[["sculpt", "Build", Building2], ["draw", "Parts", Pencil], ["stamp", "Presets", Blocks], ["edit", "Inspect", MousePointer2]].map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={ui.mode === id} onClick={() => chooseMode(id)}><Icon size={12} />{label}</button>)}
        </div>
        <div className="architecture-shelf-actions">
          <button className="architecture-mini-button" title="Undo (Ctrl Z)" aria-label="Architecture undo" onClick={() => commandBus.undo()}><Undo2 size={14} /></button>
          <button className="architecture-mini-button" title="Redo (Ctrl Shift Z)" aria-label="Architecture redo" onClick={() => commandBus.redo()}><Redo2 size={14} /></button>
          {ui.mode !== "edit" && <button className={`architecture-mini-button ${drawer ? "active" : ""}`} title="Tool settings" aria-label="Architecture settings" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}><SlidersHorizontal size={14} /></button>}
          <button className="architecture-mini-button" aria-label="Close Architecture" title="Close Architecture" onClick={close}><X size={14} /></button>
        </div>
      </header>
      {ui.mode === "sculpt" ? <ArchitectureSculptControls state={sculpt} onTool={sculptTool} onError={setError} /> : ui.mode === "edit" ? <ArchitectureSelectionControls /> : <>
        <div className={`architecture-tool-strip ${ui.mode === "stamp" ? "architecture-stamps" : ""}`}>
          {ui.mode === "draw" ? DRAW.map(([id, label, Icon, hint]) => <button key={id} className={`architecture-tool-tile ${activeShape === id ? "active" : ""}`} aria-label={`Draw ${id === "floor" ? "slab" : id}`} aria-pressed={activeShape === id} title={hint} onClick={() => safe(() => armDraw(id))}><Icon size={23} /><span>{label}</span></button>)
            : PRESETS.map((preset) => <button key={preset.id} className={`architecture-tool-tile architecture-stamp-tile ${placement.active && settings.preset === preset.id ? "active" : ""}`} aria-label={`Place ${preset.label}`} aria-pressed={placement.active && settings.preset === preset.id} title={preset.description} onClick={() => stamp(preset)}><StampIcon id={preset.id} /><span>{preset.label === "City block" ? "City" : preset.label === "Custom footprint" ? "Custom" : preset.label}</span></button>)}
        </div>
        <div className="architecture-context-bar">
          {ui.mode === "draw" ? <>
            {["wall", "box", "column"].includes(draw.shape) && <ContextNumber label="Height" ariaLabel="Architecture draw height" value={draw.settings.wallHeight} min={.01} onChange={(value) => drawSetting("wallHeight", value)} />}
            {["wall", "floor", "platform"].includes(draw.shape) && <ContextNumber label="Thickness" ariaLabel="Architecture draw thickness" value={draw.shape === "wall" ? draw.settings.wallThickness : draw.settings.slabThickness} min={.01} max={100} onChange={(value) => drawSetting(draw.shape === "wall" ? "wallThickness" : "slabThickness", value)} />}
            {["stair", "ramp"].includes(draw.shape) && <><ContextNumber label="Rise" ariaLabel="Architecture draw rise" value={draw.settings.storeyHeight} min={.01} onChange={(value) => drawSetting("rise", value)} /><ContextNumber label="Width" ariaLabel="Architecture draw width" value={draw.settings.stairWidth} min={.01} onChange={(value) => drawSetting("stairWidth", value)} /></>}
            <ContextNumber label="Elevation" ariaLabel="Architecture draw elevation" value={draw.elevation} min={-100000} max={100000} onChange={(value) => drawSetting("elevation", value)} />
            <ContextNumber label="Grid" ariaLabel="Architecture draw grid" value={draw.settings.grid} max={100} step={.25} onChange={(value) => drawSetting("grid", value)} />
            <div className="architecture-swatches" aria-label="Surface tint">{COLORS.map(([hex, label]) => <button key={hex} style={{ "--swatch": hex }} aria-label={`${label} tint`} aria-pressed={(draw.color || color) === hex} title={label} onClick={() => { setColor(hex); drawSetting("color", hex); }} />)}</div>
          </> : <>
            <span className="architecture-context-label">{placement.active ? currentPreset.label : "Choose a stamp"}</span>
            <button className="architecture-rotate-button" aria-label="Rotate stamp 90 degrees" title="Rotate (R)" onClick={() => placementSetting("rotationY", (placement.active ? placement.rotationY : stampRotation) + Math.PI / 2)}><RotateCcw size={13} />{Math.round((placement.active ? placement.rotationY : stampRotation) * 180 / Math.PI) % 360}°</button>
            <ContextNumber label="Elevation" ariaLabel="Architecture stamp elevation" value={placement.active ? placement.elevation : stampElevation} min={-100000} max={100000} onChange={(value) => placementSetting("elevation", value)} />
            <ContextNumber label="Grid" ariaLabel="Architecture stamp grid" value={placement.active ? placement.grid : stampGrid} max={100} step={.25} onChange={(value) => placementSetting("grid", value)} />
          </>}
        </div>
      </>}
      <footer className="architecture-shelf-footer">
        <span>{ui.mode === "sculpt" ? SCULPT_TOOLS.find(([id]) => id === sculpt.tool)?.[3] : ui.mode === "draw" ? `${draw.active ? shapeLabel : "Choose a tool"} · ${targetName}` : ui.mode === "stamp" ? placement.active ? "Click to place · repeat to build" : "Choose a building, then place it in the scene" : "Select a piece · G move · R rotate · S scale"}</span>
        <span>{ui.mode === "sculpt" ? "Right-click removes · Alt or middle-drag orbits" : `${ui.mode === "stamp" ? "R rotate · " : ""}Ctrl unsnaps · Alt orbits · Esc releases`}</span>
      </footer>
      {visibleError && <div className="architecture-shelf-error" role="alert">{visibleError}</div>}
      {!visibleError && placement.active && !!placement.warnings?.length && <div className="architecture-shelf-error architecture-shelf-warning" role="status">{placement.warnings.join(" ")}</div>}
    </section>
  </div>;
}
