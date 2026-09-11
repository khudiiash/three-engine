import { useEffect, useState } from "react";
import { engine } from "../engineInstance.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { SetTransformCommand } from "../commands/transformCommands.js";
import { BatchCommand } from "../commands/entityCommands.js";
import { duplicateArchitectureAssembly } from "../architectureBuild.js";
import { ArchitectureNumber } from "./ArchitectureBuilder.jsx";

function dimensions(props) {
  const size = [...(props.size ?? [1, 1, 1])];
  if (["floor", "platform"].includes(props.shape) && props.footprint?.length >= 3) {
    for (const [axis, pointAxis] of [[0, 0], [2, 1]]) {
      const values = props.footprint.map(point => point[pointAxis]);
      size[axis] = Math.max(...values) - Math.min(...values);
    }
  }
  if (props.shape === "column") size[0] = size[2] = Math.max(size[0], size[2]);
  return size;
}

/** Edit authored geometry in one history entry, leaving the transform scale intact. */
export function setArchitectureSelectionDimension(entityId, axis, value) {
  const component = engine.getEntity(entityId)?.getComponent("architecturepiece");
  if (!component || ![0, 1, 2].includes(axis) || !Number.isFinite(value)) return;
  const previous = dimensions(component.props), next = [...previous];
  next[axis] = Math.min(10000, Math.max(.001, value));
  if (previous[axis] === next[axis]) return;
  if (component.props.shape === "column" && axis !== 1) next[0] = next[2] = next[axis];
  const label = `Resize ${engine.getEntity(entityId).name}`;
  const commands = [new SetComponentPropCommand(entityId, "architecturepiece", "size", next, label)];
  if (["floor", "platform"].includes(component.props.shape) && component.props.footprint?.length >= 3 && axis !== 1) {
    const pointAxis = axis === 0 ? 0 : 1, ratio = next[axis] / previous[axis];
    if (!Number.isFinite(ratio) || previous[axis] <= 0) return;
    const resize = ring => ring.map(point => point.map((coordinate, index) => index === pointAxis ? coordinate * ratio : coordinate));
    commands.push(new SetComponentPropCommand(entityId, "architecturepiece", "footprint", resize(component.props.footprint)));
    if (component.props.holes?.length) commands.push(new SetComponentPropCommand(entityId, "architecturepiece", "holes", component.props.holes.map(resize)));
  }
  commandBus.execute(commands.length === 1 ? commands[0] : new BatchCommand(commands, label));
}

export function rotateArchitectureSelection(entityId) {
  const entity = engine.getEntity(entityId);
  if (!entity) return;
  const rotation = [...entity.getTransform().rotation];
  rotation[1] += Math.PI / 2;
  const command = new SetTransformCommand(entityId, { rotation });
  command.label = `Rotate ${entity.name} 90°`;
  commandBus.execute(command);
}

/** Compact viewport context; selection and undo refresh only the selected row. */
export function ArchitectureSelectionControls() {
  const ids = useSelectionStore(state => state.ids);
  const entityId = ids[0] ?? null;
  const selected = useSceneStore(state => entityId ? state.entities[entityId] : null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(""), [entityId]);
  const props = selected?.components?.architecturepiece;
  const assembly = selected?.components?.architecture || selected?.tags?.includes("architecture:assembly");
  if (!selected || (!props && !assembly)) return <div className="architecture-selection-controls architecture-context-empty">
    <span>Select a piece or assembly in the viewport to edit it.</span>
    <span className="architecture-context-hint">G move · R rotate · S scale</span>
  </div>;
  const run = async action => {
    setError(""); setBusy(true);
    try { await action(); } catch (cause) { setError(cause?.message || String(cause)); }
    finally { setBusy(false); }
  };
  const duplicate = () => {
    const result = duplicateArchitectureAssembly(entityId);
    if (result?.entityId) useSelectionStore.getState().select(result.entityId);
  };
  const size = props ? dimensions(props) : null;
  const shape = props?.shape === "floor" ? "Slab" : props?.shape ? props.shape.charAt(0).toUpperCase() + props.shape.slice(1) : "Assembly";
  return <div className="architecture-selection-controls" data-architecture-selection={entityId}>
    <div className="architecture-context-title">
      <strong title={selected.name}>{selected.name}</strong>
      <span>{shape}{ids.length > 1 ? ` · first of ${ids.length} selected` : ""}</span>
    </div>
    <div className="architecture-context-row">
      {props && ["Width", ["floor", "platform"].includes(props.shape) ? "Thickness" : "Height", "Depth"].map((label, axis) =>
        <label key={`${entityId}:${axis}`} className="architecture-context-field" title={`${label} in local metres`}>
          <span>{label}</span>
          <ArchitectureNumber label={`Selected ${label.toLowerCase()}`} value={size[axis]} min={.001} max={10000} step={.1}
            onChange={value => run(() => setArchitectureSelectionDimension(entityId, axis, value))} />
        </label>)}
      <button className="toolbar-btn" disabled={busy} title="Rotate 90° about the local Y axis" onClick={() => run(() => rotateArchitectureSelection(entityId))}>Rotate 90°</button>
      <button className="toolbar-btn" disabled={busy} title="Duplicate in place; press G to move the copy" onClick={() => run(duplicate)}>{props ? "Duplicate" : "Duplicate assembly"}</button>
      <button className="toolbar-btn" disabled={busy} title="Open materials, openings and all properties" onClick={() => run(async () => { const { openPanel } = await import("../EditorShell.jsx"); openPanel("inspector"); })}>Inspector</button>
    </div>
    {error ? <span className="architecture-error architecture-context-hint" role="alert">{error}</span>
      : <span className="architecture-context-hint">{props ? "Local dimensions · " : "Materials and assembly settings in Inspector · "}G move · R rotate · S scale</span>}
  </div>;
}
