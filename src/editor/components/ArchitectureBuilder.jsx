import { useEffect, useMemo, useState } from "react";
import { Building2 } from "../icons/index.jsx";
import { Select } from "../fields/Select.jsx";
import { EntityField } from "../fields/EntityField.jsx";
import { AssetField } from "../fields/AssetField.jsx";
import { engine } from "../engineInstance.js";
import { generateArchitecture, normalizeArchitectureSettings } from "../../modules/architecture/blueprints.js";
import { closeArchitectureWorkspace, openArchitectureWorkspace, useArchitectureWorkspace } from "../architectureWorkspaceStore.js";
import { disarmArchitectureTool, disarmArchitecturePlacement } from "../architectureTool.js";
import { disarmArchitectureSculpt } from "../architectureSculptTool.js";
import "../architecture.css";

const ROLES = ["default", "wall", "floor", "roof", "foundation", "structure", "road"];
const FOOTPRINTS = [["rectangle", "Rectangle"], ["l-shape", "L shape"], ["courtyard", "Courtyard"], ["circle", "Circular"], ["custom", "Custom polygon"]];
const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);
const errorMessage = (error) => error?.message || String(error);

export function ArchitectureField({ label, children, hint }) {
  return <div className="architecture-field" title={hint}><span>{label}</span>{children}</div>;
}

/** Keep a partially typed number local. Only complete values reach the plan. */
export function ArchitectureNumber({ value, onChange, label, min, max, step = 0.1 }) {
  const [text, setText] = useState(String(value ?? 0));
  useEffect(() => setText(String(value ?? 0)), [value]);
  const commit = () => {
    const number = Number(text);
    if (!text.trim() || !Number.isFinite(number)) { setText(String(value ?? 0)); return; }
    const next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, number));
    onChange(step === 1 ? Math.round(next) : next);
    setText(String(step === 1 ? Math.round(next) : next));
  };
  return <input className="architecture-input" type="number" inputMode="decimal" aria-label={label}
    value={text} min={min} max={max} step={step} onChange={(event) => setText(event.target.value)} onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === "Escape") { event.stopPropagation(); setText(String(value ?? 0)); }
    }} />;
}

function Choice({ label, value, options, onChange }) {
  return <ArchitectureField label={label}><Select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
    {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
  </Select></ArchitectureField>;
}

function Toggle({ label, value, onChange, hint }) {
  return <label className="architecture-toggle" title={hint}><input type="checkbox" checked={!!value} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

export function ArchitectureMaterials({ value = {}, onChange }) {
  return <div className="architecture-materials">{ROLES.map((role) => <ArchitectureField key={role} label={capitalize(role)}>
    <AssetField descriptor={{ exts: ["mat"], compact: true, emptyLabel: "Default material" }} value={value[role] ?? ""}
      onCommit={(path) => onChange({ ...value, [role]: path })} />
  </ArchitectureField>)}</div>;
}

function PolygonField({ value, onChange, onError }) {
  const serialized = JSON.stringify(value ?? []);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState("");
  useEffect(() => { setText(serialized); setError(""); onError?.(""); }, [serialized]);
  useEffect(() => () => onError?.(""), []);
  const commit = () => {
    try {
      const points = JSON.parse(text);
      if (!Array.isArray(points) || points.length < 3 || points.length > 64 || !points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
        throw new Error("Use 3–64 points as [[x,z], [x,z], …] in metres.");
      }
      setError(""); onError?.(""); onChange(points);
    } catch (cause) { const message = cause instanceof SyntaxError ? "Enter valid points, for example [[-6,-5],[6,-5],[6,5],[-6,5]]." : errorMessage(cause); setError(message); onError?.(message); }
  };
  return <div className="architecture-polygon">
    <label>Outline points · X, Z (m)<textarea aria-label="Outline points" className="architecture-input" rows={3} value={text}
      onChange={(event) => { setText(event.target.value); onError?.("Finish editing the outline points before creating."); }} onBlur={commit} /></label>
    {error && <div className="architecture-error" role="alert">{error}</div>}
  </div>;
}

/** Shared staged settings: inspector edits do not rebuild the scene per keystroke. */
export function ArchitectureSettings({ settings, onChange, onError }) {
  const patch = (key, value) => {
    const next = { ...settings, [key]: value };
    if (key === "footprint" && value === "custom" && !next.customFootprint?.length) {
      const x = next.width / 2, z = next.depth / 2;
      next.customFootprint = [[-x, -z], [x, -z], [x, z], [-x, z]];
    }
    onChange(normalizeArchitectureSettings(next));
  };
  const number = (key, label, min, max, step = 0.1) => <ArchitectureField key={key} label={label}>
    <ArchitectureNumber label={label} value={settings[key]} min={min} max={max} step={step} onChange={(value) => patch(key, value)} />
  </ArchitectureField>;
  const building = ["building", "city", "fortress"].includes(settings.kind);
  return <div className="architecture-settings">
    <div className="architecture-field-grid">
      {settings.footprint !== "custom" && number("width", "Width (m)", 6, 500)}
      {settings.footprint !== "custom" && number("depth", settings.kind === "bridge" ? "Span (m)" : "Depth (m)", 6, 500)}
      {building && number("storeys", "Storeys", 1, 32, 1)}
      {number("storeyHeight", building ? "Storey height (m)" : "Height (m)", 2.4, 12)}
    </div>
    {settings.kind === "city" && <details open><summary>City layout</summary><div className="architecture-field-grid">
      {number("rows", "Rows", 1, 12, 1)}{number("columns", "Columns", 1, 12, 1)}
      {number("streetWidth", "Street width (m)", 2, 60)}{number("setback", "Setback (m)", 1, 50)}
      {number("variation", "Variation", 0, 1, 0.05)}{number("seed", "Seed", 0, 4294967295, 1)}
    </div></details>}
    <details open><summary>Form and structure</summary>
      {["building", "pavilion"].includes(settings.kind) && <Choice label="Footprint" value={settings.footprint} options={FOOTPRINTS} onChange={(value) => patch("footprint", value)} />}
      {settings.footprint === "custom" && <PolygonField value={settings.customFootprint} onChange={(value) => patch("customFootprint", value)} onError={onError} />}
      <div className="architecture-field-grid">
        {settings.footprint === "l-shape" && number("wingWidth", "Wing width (m)", 3, 100)}
        {settings.footprint === "courtyard" && number("courtyardRatio", "Courtyard ratio", 0.15, 0.75, 0.05)}
        {settings.footprint === "circle" && number("sides", "Sides", 6, 48, 1)}
        {number("wallThickness", "Wall thickness (m)", 0.08, 1, 0.05)}
        {number("slabThickness", "Slab thickness (m)", 0.08, 1, 0.05)}
        {settings.kind !== "bridge" && number("foundationDepth", "Foundation (m)", 0, 20)}
      </div>
      {!["bridge", "fortress"].includes(settings.kind) && <>
        <Choice label="Roof" value={settings.roof} options={[["flat", "Flat"], ["gable", "Gable"], ["none", "Open top"]]} onChange={(value) => patch("roof", value)} />
        {settings.roof === "gable" && settings.footprint === "rectangle" && <div className="architecture-field-grid">{number("roofHeight", "Roof height (m)", 0.1, 30)}{number("roofOverhang", "Overhang (m)", 0, 3)}</div>}
      </>}
    </details>
    {building && <details><summary>Openings and circulation</summary>
      <Choice label="Interior" value={settings.interior ?? "open"} options={[["open", "Open plan"], ["rooms", "Rooms with doorways"]]} onChange={(value) => patch("interior", value)} />
      {settings.interior === "rooms" && number("roomSize", "Room spacing (m)", 3, 50)}
      <Toggle label="Windows" value={settings.windows} onChange={(value) => patch("windows", value)} />
      {settings.windows && <div className="architecture-field-grid">
        {number("windowWidth", "Window width (m)", 0.3, 8)}{number("windowHeight", "Window height (m)", 0.3, 6)}
        {number("windowSill", "Sill (m)", 0.1, 10)}{number("windowSpacing", "Spacing (m)", 1, 20)}
      </div>}
      <div className="architecture-field-grid">{number("doorWidth", "Door width (m)", 0.8, 10)}{number("doorHeight", "Door height (m)", 1.8, 10)}</div>
      <Toggle label="Connect storeys with stairs" value={settings.stairs} onChange={(value) => patch("stairs", value)} />
      {settings.stairs && number("stairWidth", "Stair width (m)", 0.9, 4)}
    </details>}
    <details><summary>Terrain and environment</summary>
      <Choice label="Terrain fit" value={settings.terrainFit ?? "none"} options={[["none", "Keep placement height"], ["highest", "Seat on highest terrain point"]]} onChange={(value) => patch("terrainFit", value)} />
      {settings.terrainFit === "highest" && <ArchitectureField label="Terrain">
        <EntityField value={settings.terrainId ?? ""} onCommit={(value) => patch("terrainId", value)} descriptor={{ emptyLabel: "Auto-detect terrain", filter: (entity) => !!engine.getEntity(entity.id)?.getComponent("terrain") }} />
      </ArchitectureField>}
      <Toggle label="Keep above water" value={settings.avoidWater} onChange={(value) => patch("avoidWater", value)} />
      {settings.avoidWater && number("waterClearance", "Water clearance (m)", 0, 100)}
      <Toggle label="Clear foliage beneath structures" value={settings.clearFoliage} onChange={(value) => patch("clearFoliage", value)} />
      {settings.clearFoliage && number("foliagePadding", "Foliage margin (m)", 0, 100)}
      <Toggle label="Generate physics colliders" value={settings.collision} onChange={(value) => patch("collision", value)} />
      <p className="architecture-hint">Terrain and water are sampled when built. Meshes receive lighting and participate in the scene's GI.</p>
    </details>
    <details><summary>Materials</summary><ArchitectureMaterials value={settings.materials} onChange={(value) => patch("materials", value)} /></details>
    <details><summary>Generation limits</summary>{number("maxPieces", "Piece budget", 32, 20000, 1)}
      <p className="architecture-hint">Large plans may reduce storeys or building count to stay within this budget. Review the preview before creating.</p>
    </details>
  </div>;
}

export function useArchitecturePlan(settings) {
  const [preview, setPreview] = useState({ plan: null, error: "", pending: true });
  useEffect(() => {
    setPreview((previous) => ({ ...previous, pending: true }));
    const timer = setTimeout(() => {
      try { setPreview({ plan: generateArchitecture(settings), error: "", pending: false }); }
      catch (cause) { setPreview({ plan: null, error: errorMessage(cause), pending: false }); }
    }, 140);
    return () => clearTimeout(timer);
  }, [settings]);
  return preview;
}

export function ArchitecturePlan({ preview }) {
  const map = useMemo(() => {
    const buildings = preview.plan?.buildings ?? [];
    const outlines = buildings.filter((building) => building.footprint?.length).map((building) => {
      const c = Math.cos(building.rotationY ?? 0), s = Math.sin(building.rotationY ?? 0);
      const transform = ([x, z]) => [x * c + z * s + (building.position?.[0] ?? 0), -x * s + z * c + (building.position?.[2] ?? 0)];
      return { name: building.name, points: building.footprint.map(transform), holes: (building.footprintHoles ?? []).map((hole) => hole.map(transform)) };
    });
    const points = outlines.flatMap((outline) => outline.points);
    const minX = points.length ? Math.min(...points.map(([x]) => x)) : -10;
    const maxX = points.length ? Math.max(...points.map(([x]) => x)) : 10;
    const minZ = points.length ? Math.min(...points.map(([, z]) => z)) : -10;
    const maxZ = points.length ? Math.max(...points.map(([, z]) => z)) : 10;
    const width = Math.max(1, maxX - minX), depth = Math.max(1, maxZ - minZ);
    const pad = Math.max(width, depth) * 0.12;
    return { outlines, width, depth, viewBox: `${minX - pad} ${minZ - pad} ${width + pad * 2} ${depth + pad * 2}`,
      pieceCount: buildings.reduce((sum, building) => sum + (building.floors ?? []).reduce((count, group) => count + group.pieces.length, 0), 0) };
  }, [preview.plan]);
  const path = (points) => points.map(([x, z], index) => `${index ? "L" : "M"}${x},${z}`).join(" ") + " Z";
  return <div className={`architecture-plan ${preview.pending ? "pending" : ""}`} aria-busy={preview.pending}>
    <div className="architecture-plan-heading"><span>PLAN VIEW</span><span>X / Z · metres</span></div>
    <svg viewBox={map.viewBox} role="img" aria-label={`Architecture plan with ${map.outlines.length} structures`}>
      {map.outlines.map((outline, index) => <path key={index} d={[path(outline.points), ...outline.holes.map(path)].join(" ")} fillRule="evenodd" vectorEffect="non-scaling-stroke"><title>{outline.name}</title></path>)}
    </svg>
    <div className="architecture-plan-stats">
      <span><strong>{preview.plan?.buildings?.length ?? 0}</strong> structures</span>
      <span><strong>{map.pieceCount.toLocaleString()}</strong> pieces</span>
      <span><strong>{map.width.toFixed(1)} × {map.depth.toFixed(1)}</strong> m</span>
    </div>
    {preview.error && <p className="architecture-error" role="alert">{preview.error}</p>}
    {!!preview.plan?.warnings?.length && <div className="architecture-notices" role="status">{preview.plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
  </div>;
}

/** Opens the viewport shelf; the scene stays interactive. */
export function ArchitectureToolButton() {
  const open = useArchitectureWorkspace((state) => state.open);
  return <button className={`toolbar-btn architecture-tool-button ${open ? "active" : ""}`} title="Architecture tools" aria-label="Open Architecture" aria-pressed={open} onClick={() => {
    if (open) { disarmArchitectureTool(); disarmArchitecturePlacement(); disarmArchitectureSculpt(); closeArchitectureWorkspace(); }
    else openArchitectureWorkspace();
  }}><Building2 size={13} /><span>Architecture</span></button>;
}
