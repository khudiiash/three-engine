import { useEffect, useRef, useState } from "react";
import { Boxes, Copy, Plus, RefreshCw, Trash2 } from "../icons/index.jsx";
import { engine } from "../engineInstance.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { normalizeArchitectureSettings } from "../../modules/architecture/blueprints.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { addArchitectureColliders, applyArchitectureMaterials, createArchitecture, duplicateArchitectureAssembly, rebuildArchitecture } from "../architectureBuild.js";
import { openArchitectureWorkspace } from "../architectureWorkspaceStore.js";
import { EntityField } from "../fields/EntityField.jsx";
import { ArchitectureField, ArchitectureMaterials, ArchitectureNumber, ArchitecturePlan, ArchitectureSettings, useArchitecturePlan } from "./ArchitectureBuilder.jsx";

/** Authoring changes stay staged until a single undoable regeneration. */
export function ArchitectureSection({ entityId, props }) {
  return props?.model ? <ArchitectureModelSection entityId={entityId} props={props} /> : <ArchitectureAssemblySection entityId={entityId} props={props} />;
}

function ArchitectureTerrainControls({ entityId, props }) {
  const commit = (key, value) => commandBus.execute(new SetComponentPropCommand(entityId, "architecture", key, value, "Set architecture terrain following"));
  return <>
    <label className="architecture-toggle"><input aria-label="Follow sculpted terrain" type="checkbox" checked={props.followTerrain !== false} onChange={(event) => commit("followTerrain", event.target.checked)} /> Follow sculpted terrain</label>
    {props.followTerrain !== false && <ArchitectureField label="Terrain surface"><EntityField value={props.terrainId || ""} descriptor={{ emptyLabel: "Automatic beneath each building", filter: (entity) => !!entity.components?.terrain }} onCommit={(id) => commit("terrainId", id || "")} /></ArchitectureField>}
    <p className="architecture-hint">Keeps each connected building level as the ground rises or falls, preserving its height above the ground.</p>
  </>;
}

function ArchitectureModelSection({ entityId, props }) {
  const [error, setError] = useState("");
  const model = props.model;
  const duplicate = () => {
    try {
      const result = duplicateArchitectureAssembly(entityId);
      useSelectionStore.getState().select(result.entityId);
      openArchitectureWorkspace({ mode: "sculpt", parentId: result.entityId });
    } catch (cause) { setError(cause.message || String(cause)); }
  };
  return <div className="architecture-section" data-architecture-model-section={entityId}>
    <ArchitectureTerrainControls entityId={entityId} props={props} />
    <p className="architecture-hint">Connected building forms. Reshape a form in the viewport; adjoining walls, roofs and openings adapt with it.</p>
    <div className="architecture-model-stats"><span><strong>{model.forms?.length ?? 0}</strong>forms</span><span><strong>{model.paths?.length ?? 0}</strong>paths</span><span><strong>{model.openings?.length ?? 0}</strong>openings</span></div>
    <button className="architecture-primary" onClick={() => openArchitectureWorkspace({ mode: "sculpt", parentId: entityId })}>Build and reshape in viewport</button>
    <div className="architecture-section-actions"><button className="toolbar-btn" onClick={duplicate}><Copy size={12} /> Duplicate composition</button></div>
    <label className="architecture-toggle"><input type="checkbox" checked={!!props.settings?.clearFoliage} onChange={(event) => commandBus.execute(new SetComponentPropCommand(entityId, "architecture", "settings", { ...props.settings, clearFoliage: event.target.checked }, "Set building foliage clearance"))} /> Clear foliage beneath buildings</label>
    <p className="architecture-hint">Grow: click a wall to extend, a roof to stack. Reshape: drag the building's handles. Right-click removes a form.</p>
    {error && <p className="architecture-error" role="alert">{error}</p>}
  </div>;
}

function ArchitectureAssemblySection({ entityId, props }) {
  const source = props?.settings ?? {};
  const signature = JSON.stringify(source);
  const [settings, setSettings] = useState(() => normalizeArchitectureSettings(source));
  const [fieldError, setFieldError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const previousSource = useRef({ entityId, source });
  useEffect(() => {
    const previous = previousSource.current;
    const sameRecipe = previous.entityId === entityId && JSON.stringify({ ...previous.source, materials: undefined }) === JSON.stringify({ ...source, materials: undefined });
    const normalized = normalizeArchitectureSettings(source);
    setSettings((current) => sameRecipe ? { ...current, materials: normalized.materials } : normalized);
    previousSource.current = { entityId, source };
    setFieldError(""); setError(""); setMessage("");
  }, [entityId, signature]);
  const generated = !!props?.generatedRootId && source.kind !== "assembly";
  const preview = useArchitecturePlan(settings);
  const changed = JSON.stringify(normalizeArchitectureSettings(source)) !== JSON.stringify(normalizeArchitectureSettings(settings));
  const run = async (action) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await action();
      setMessage(result?.warnings?.length ? result.warnings.join(" ") : "Architecture updated. Undo is available.");
      if (result?.entityId) useSelectionStore.getState().select(result.entityId);
    } catch (cause) { setError(cause?.message || String(cause)); }
    finally { setBusy(false); }
  };
  const variant = () => {
    const entity = engine.getEntity(entityId);
    if (!entity) throw new Error("This architecture no longer exists.");
    entity.object3D.updateWorldMatrix(true, false);
    const position = entity.object3D.getWorldPosition(entity.object3D.position.clone());
    const quaternion = entity.object3D.getWorldQuaternion(entity.object3D.quaternion.clone());
    const yaw = entity.object3D.rotation.clone().setFromQuaternion(quaternion, "YXZ").y;
    const offset = Math.max(6, settings.width ?? 12) * (settings.kind === "city" ? settings.columns ?? 1 : 1) + (settings.kind === "city" ? (settings.streetWidth ?? 8) * (settings.columns ?? 1) : 4);
    position.x += offset;
    return createArchitecture({ ...settings, seed: ((settings.seed ?? 1) + 1) >>> 0 }, { position: position.toArray(), rotationY: yaw, name: `${entity.name} variant` });
  };
  return <div className="architecture-section" data-architecture-section={entityId}>
    <ArchitectureTerrainControls entityId={entityId} props={props} />
    {generated ? <>
      <ArchitecturePlan preview={preview} />
      <ArchitectureSettings settings={settings} onChange={setSettings} onError={setFieldError} />
      <p className="architecture-hint">{changed ? "You have staged changes. " : ""}Regenerate replaces this recipe's generated contents, including edits to those pieces. Other children stay in place. Use Create variant to keep the original.</p>
      {fieldError && <p className="architecture-error" role="alert">{fieldError}</p>}
      <div className="architecture-section-actions">
        <button className="architecture-primary" disabled={busy || preview.pending || !!preview.error || !!fieldError} onClick={() => run(() => rebuildArchitecture(entityId, settings))}><RefreshCw size={12} /> Regenerate</button>
        <button className="toolbar-btn" disabled={busy || preview.pending || !!preview.error || !!fieldError} title="Create a separate variation beside this architecture" onClick={() => run(variant)}><Copy size={12} /> Create variant</button>
      </div>
      <div className="architecture-section-actions">
        <button className="toolbar-btn" disabled={busy} onClick={() => run(() => applyArchitectureMaterials(entityId, settings.materials ?? {}))}>Apply materials</button>
        {changed && <button className="toolbar-btn" disabled={busy} onClick={() => { setSettings(normalizeArchitectureSettings(source)); setFieldError(""); }}>Reset staged edits</button>}
      </div>
    </> : <>
      <p className="architecture-hint">An assembly holds any arrangement of architectural pieces. Place, rotate, resize and nest them freely.</p>
      <ArchitectureMaterials value={settings.materials} onChange={(materials) => setSettings({ ...settings, materials })} />
      <div className="architecture-section-actions">
        <button className="toolbar-btn" disabled={busy} onClick={() => run(() => applyArchitectureMaterials(entityId, settings.materials ?? {}))}>Apply materials</button>
        <button className="toolbar-btn" disabled={busy} onClick={() => run(() => duplicateArchitectureAssembly(entityId))}><Copy size={12} /> Duplicate assembly</button>
      </div>
      <details className="architecture-opening"><summary>Foliage integration</summary>
        <label className="architecture-toggle"><input type="checkbox" checked={!!settings.clearFoliage} onChange={(event) => setSettings({ ...settings, clearFoliage: event.target.checked })} /><span>Clear foliage beneath this assembly</span></label>
        <ArchitectureField label="Foliage margin (m)"><ArchitectureNumber label="Foliage margin" value={settings.foliagePadding} min={0} max={100} onChange={(value) => setSettings({ ...settings, foliagePadding: value })} /></ArchitectureField>
        <button className="toolbar-btn wide" disabled={busy} onClick={() => run(() => {
          commandBus.execute(new SetComponentPropCommand(entityId, "architecture", "settings", { ...source, clearFoliage: !!settings.clearFoliage, foliagePadding: settings.foliagePadding }, "Set assembly foliage clearance"));
        })}>Apply foliage clearance</button>
        <p className="architecture-hint">Uses the actual piece footprints and follows transforms. Turn it off to restore the original foliage scatter.</p>
      </details>
    </>}
    <div className="architecture-section-actions">
      <button className="toolbar-btn" disabled={busy} onClick={() => openArchitectureWorkspace({ mode: "draw", parentId: entityId })}><Plus size={12} /> Add pieces</button>
      <button className="toolbar-btn" disabled={busy} onClick={() => openArchitectureWorkspace({ mode: "stamp", parentId: entityId })}><Boxes size={12} /> Add structure</button>
    </div>
    <button className="toolbar-btn wide" disabled={busy} onClick={() => run(() => addArchitectureColliders(entityId))}>Add missing physics colliders</button>
    {error && <p className="architecture-error" role="alert">{error}</p>}
    {message && <p className="architecture-hint" role="status">{message}</p>}
  </div>;
}

/** Wall apertures are authored independently of recipes or storeys. */
export function ArchitecturePieceSection({ entityId, props }) {
  if (props.shape !== "wall") return null;
  const openings = props.openings ?? [];
  const commit = (next, label) => commandBus.execute(new SetComponentPropCommand(entityId, "architecturepiece", "openings", next, label));
  const update = (index, key, value) => commit(openings.map((opening, i) => i === index ? { ...opening, [key]: value } : opening), "Edit architecture opening");
  const add = (window) => {
    const height = Math.min(window ? 1.2 : 2.1, props.size[1]);
    commit([...openings, { offset: 0, width: Math.min(window ? 1.4 : 1.1, props.size[0]), height, sill: window ? Math.min(1, Math.max(0, props.size[1] - height)) : 0 }], window ? "Add window" : "Add doorway");
  };
  return <div className="architecture-section">
    <div className="architecture-section-actions"><button className="toolbar-btn" onClick={() => add(false)}><Plus size={12} /> Doorway</button><button className="toolbar-btn" onClick={() => add(true)}><Plus size={12} /> Window</button></div>
    {!openings.length && <p className="architecture-hint">Openings cut through the wall and its collider. Offset is measured from the wall centre.</p>}
    {openings.map((opening, index) => <details className="architecture-opening" key={index} open>
      <summary>Opening {index + 1}</summary><div className="architecture-field-grid">
        {[["offset", "Offset (m)", undefined], ["width", "Width (m)", 0.01], ["height", "Height (m)", 0.01], ["sill", "Sill (m)", 0]].map(([key, label, min]) => <ArchitectureField key={key} label={label}>
          <ArchitectureNumber label={`Opening ${index + 1} ${label}`} value={opening[key]} min={min} onChange={(value) => update(index, key, value)} />
        </ArchitectureField>)}
      </div><button className="toolbar-btn" onClick={() => commit(openings.filter((_, i) => i !== index), "Remove architecture opening")}><Trash2 size={12} /> Remove opening</button>
    </details>)}
  </div>;
}
