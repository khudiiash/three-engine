import { useEffect, useRef, useState } from "react";
import { X, Plus, Crosshair, Eye, EyeOff, ScanEye, Package, ChevronRight, Sparkles } from "lucide-react";
import { useSceneStore } from "../store/sceneStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { getComponentClass, getComponentTypes } from "../../engine/index.js";
import { commandBus } from "../commands/CommandBus.js";
import { RenameEntityCommand, BatchCommand, SetEntityViewOnlyCommand, SetEntityEnabledInEditorCommand, SetEntityEnabledInGameCommand } from "../commands/entityCommands.js";
import { ANCHOR_PRESETS, applyAnchorPreset } from "../../engine/ui/layout.js";
import { SetTransformCommand } from "../commands/transformCommands.js";
import {
  AddComponentCommand,
  RemoveComponentCommand,
  SetComponentPropCommand,
} from "../commands/componentCommands.js";
import { openPanel } from "../EditorShell.jsx";
import { engine } from "../engineInstance.js";
import { AssetField } from "../fields/AssetField.jsx";
import { PREFAB_EXTENSIONS } from "../assetLoader.js";
import { AssetInspector } from "./AssetInspector.jsx";
import { useAssetDrop } from "../assetDrag.js";
import { getEditorCameraView } from "./ViewportPanel.jsx";
import { useModulesStore } from "../modules.js";
import { usePrefabStore } from "../store/prefabStore.js";
import { prefabRegistry, diffInstance, getPrefabRoot } from "../../engine/index.js";
import { applyPrefab, revertPrefab, unpackPrefab, openPrefabMode, createVariantFromInstance } from "../prefab.js";
import { SoundSection } from "../components/SoundSection.jsx";
import { ListenerSection } from "../components/ListenerSection.jsx";
import { TerrainSection } from "../components/TerrainSection.jsx";
import { useGeometryEditStore } from "../store/geometryEditStore.js";
import { assignTerrainAssets, createTerrainAssets } from "../terrainAssetSetup.js";

/**
 * Returns the live engine entity referenced by `targetId` (the value stored
 * on the camera's `followTarget` prop), or null when nothing is set / the
 * referenced entity no longer exists.
 */
function resolveFollowEntity(targetId) {
  if (!targetId) return null;
  return engine.getEntity(targetId) ?? null;
}

/**
 * Drives the "Pick" interaction for the camera's follow target. We can't
 * reuse the standard pointer-pick path because that lives on the viewport
 * canvas — and the user is interacting with the inspector. Instead, when
 * picking is active, the next click on the hierarchy panel selects the
 * clicked entity and we then set that as the follow target. We arm
 * picking via a single module-level flag so the hierarchy panel can poll
 * it from its existing click handler.
 */
let followPickArmed = false;
export function isFollowPickArmed() {
  return followPickArmed;
}
export function armFollowPick() {
  followPickArmed = true;
}
export function disarmFollowPick() {
  followPickArmed = false;
}

/**
 * Independent pick-flag for the InstancerComponent "Surface Entity" picker.
 * Separate from the camera-follow flag so the two pickers don't fight each
 * other. The hierarchy panel polls all pick-armed flags and treats the first
 * one set as the active consumer.
 */
let surfacePickArmed = false;
export function isSurfacePickArmed() {
  return surfacePickArmed;
}
export function armSurfacePick() {
  surfacePickArmed = true;
}
export function disarmSurfacePick() {
  surfacePickArmed = false;
}
/** Read whether any picker is currently armed (used by HierarchyPanel). */
export function isAnyPickArmed() {
  return followPickArmed || surfacePickArmed;
}

/**
 * UI components (`uielement`, `uiimage`, `uitext`, `uibutton`, `uilayout`,
 * `uiscroll`, `uimask`) only make sense as descendants of a UI Screen. Walks
 * the parent chain of `entityId` (inclusive) and returns true if any entity
 * along the way carries a `uiscreen` component. Used to gate the Add
 * Component dropdown so non-UI entities don't see UI-only options.
 *
 * Reads the live engine (not the scene mirror) because the helper can be
 * called for ids not yet mirrored in React state, and the engine is the
 * source of truth anyway.
 */
export function isInsideUiScreen(entityId) {
  if (!entityId) return false;
  let entity = engine.getEntity(entityId);
  while (entity) {
    if (entity.getComponent?.("uiscreen")) return true;
    entity = entity.parent;
  }
  return false;
}

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

/** Number input that keeps local text while typing; commits on Enter/blur. */
function NumberField({ value, onCommit, min, max, step = 0.1 }) {
  const [text, setText] = useState(formatNumber(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatNumber(value));
  }, [value, focused]);

  const commit = () => {
    const parsed = parseFloat(text);
    if (!Number.isNaN(parsed) && parsed !== value) {
      let v = parsed;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      onCommit(v);
    } else {
      setText(formatNumber(value));
    }
  };

  return (
    <input
      className="number-field"
      type="number"
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Escape") {
          setText(formatNumber(value));
          e.target.blur();
        }
      }}
    />
  );
}

function formatNumber(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return "0";
  return String(Math.round(v * 1000) / 1000);
}

function Vector3Row({ label, values, onCommit }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <div className="vector-fields">
        {["x", "y", "z"].map((axis, i) => (
          <NumberField
            key={axis}
            value={values[i]}
            onCommit={(v) => {
              const next = [...values];
              next[i] = v;
              onCommit(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function TransformSection({ entity }) {
  const { position, rotation, scale } = entity.transform;
  const rotationDeg = rotation.map((r) => r * RAD2DEG);

  const commit = (patch) => {
    commandBus.execute(new SetTransformCommand(entity.id, { ...entity.transform, ...patch }));
  };

  return (
    <div className="inspector-section">
      <div className="section-header">Transform</div>
      <Vector3Row label="Position" values={position} onCommit={(v) => commit({ position: v })} />
      <Vector3Row
        label="Rotation"
        values={rotationDeg}
        onCommit={(v) => commit({ rotation: v.map((d) => d * DEG2RAD) })}
      />
      <Vector3Row label="Scale" values={scale} onCommit={(v) => commit({ scale: v })} />
    </div>
  );
}

const fileName = (p) => p?.split(/[\\/]/).pop() ?? "";

/** Text field that doubles as a drop target for Assets-panel paths. */
function TextPropField({ value, onCommit, readOnly = false }) {
  const dropRef = useAssetDrop({
    accepts: (path, isDir) => !readOnly && !isDir,
    onDrop: onCommit,
  });
  return (
    <input
      className="text-field"
      type="text"
      key={value}
      defaultValue={value}
      ref={dropRef}
      readOnly={readOnly}
      onBlur={(e) => !readOnly && onCommit(e.target.value)}
    />
  );
}

function Vec3PropField({ value, onCommit }) {
  const values = Array.isArray(value) ? value : [0, 0, 0];
  return (
    <div className="vector-fields">
      {[0, 1, 2].map((i) => (
        <NumberField
          key={i}
          value={values[i] ?? 0}
          onCommit={(v) => {
            const next = [...values];
            next[i] = v;
            onCommit(next);
          }}
        />
      ))}
    </div>
  );
}

function PropField({ descriptor, value, onCommit }) {
  switch (descriptor.type) {
    case "asset":
      return <AssetField descriptor={descriptor} value={value} onCommit={onCommit} />;
    // A prefab reference: an asset picker pinned to prefab files. The value is
    // the asset path, which is exactly what `engine.instantiate()` takes.
    case "prefab":
      return (
        <AssetField
          descriptor={{ ...descriptor, exts: PREFAB_EXTENSIONS }}
          value={value}
          onCommit={onCommit}
        />
      );
    case "vec3":
      return <Vec3PropField value={value} onCommit={onCommit} />;
    case "number":
      return (
        <NumberField
          value={value}
          min={descriptor.min}
          max={descriptor.max}
          step={descriptor.step}
          onCommit={onCommit}
        />
      );
    case "color":
      return (
        <input
          className="color-field"
          type="color"
          value={value}
          onChange={(e) => onCommit(e.target.value)}
        />
      );
    case "select":
      return (
        <select className="select-field" value={value} onChange={(e) => onCommit(e.target.value)}>
          {descriptor.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case "boolean":
      return (
        <input type="checkbox" checked={!!value} onChange={(e) => onCommit(e.target.checked)} />
      );
    default:
      return <TextPropField value={value} onCommit={onCommit} readOnly={descriptor.readOnly} />;
  }
}

/** Fields for @attribute-decorated script properties (schema lives on the loaded module). */
function ScriptAttributeFields({ entityId, props }) {
  const [, bump] = useState(0);
  useEffect(() => engine.on("script-loaded", () => bump((v) => v + 1)), []);

  const component = engine.getEntity(entityId)?.getComponent("script");
  const defs = component?.getAttributeDefs() ?? {};

  return Object.entries(defs).map(([key, def]) => (
    <div className="field-row" key={key}>
      <span className="field-label">{key}</span>
      <PropField
        descriptor={{ key, label: key, type: def.type ?? "number", ...def }}
        value={props.attributes?.[key] ?? def.default}
        onCommit={(v) =>
          commandBus.execute(
            new SetComponentPropCommand(entityId, "script", "attributes", {
              ...props.attributes,
              [key]: v,
            }),
          )
        }
      />
    </div>
  ));
}

/**
 * Camera-only follow section. Renders three controls on the camera's
 * component panel:
 *   - Follow target: a text field showing the live entity name (or id when
 *     the entity has been deleted), with Pick / Clear buttons. Picking arms
 *     the hierarchy panel to consume the next row click as the target.
 *   - Viewport / Game checkboxes: enable follow while editing / playing.
 *   - Show preview checkbox: editor-only PIP toggle.
 */
function CameraFollowSection({ entityId, props }) {
  const [, force] = useState(0);
  // Mirror the live engine prop values into local state so toggles reflect
  // the current camera (the scene mirror doesn't refresh on prop changes).
  useEffect(() => {
    const onChange = (info) => {
      if (info.entityId === entityId && info.componentType === "camera") force((v) => v + 1);
    };
    return engine.on("component-changed", onChange);
  }, [entityId]);

  const target = resolveFollowEntity(props.followTarget);
  const targetLabel = target ? target.name : props.followTarget || "";
  const targetMissing = !!props.followTarget && !target;

  const commitProp = (key, value) =>
    commandBus.execute(new SetComponentPropCommand(entityId, "camera", key, value));

  return (
    <>
      <div className="inspector-subheader">Follow target</div>
      <div className="camera-follow-row">
        <input
          className={`text-field ${targetMissing ? "missing-ref" : ""}`}
          type="text"
          value={targetLabel}
          placeholder="(none)"
          readOnly
          title={targetMissing ? "Referenced entity no longer exists" : "Entity to look at"}
        />
        <button
          className="toolbar-btn"
          title="Pick an entity from the hierarchy as the follow target"
          onClick={() => {
            if (isFollowPickArmed()) disarmFollowPick();
            else armFollowPick();
            force((v) => v + 1);
          }}
        >
          {isFollowPickArmed() ? "Cancel" : "Pick"}
        </button>
        <button
          className="toolbar-btn"
          title="Clear the follow target"
          disabled={!props.followTarget}
          onClick={() => commitProp("followTarget", null)}
        >
          Clear
        </button>
      </div>
      <div className="camera-follow-toggles">
        <label className="field-row inline">
          <input
            type="checkbox"
            checked={!!props.followInViewport}
            onChange={(e) => commitProp("followInViewport", e.target.checked)}
          />
          <span>Viewport</span>
        </label>
        <label className="field-row inline">
          <input
            type="checkbox"
            checked={!!props.followInGame}
            onChange={(e) => commitProp("followInGame", e.target.checked)}
          />
          <span>Game</span>
        </label>
      </div>
      <label className="field-row inline preview-toggle">
        <input
          type="checkbox"
          checked={props.showPreview !== false}
          onChange={(e) => commitProp("showPreview", e.target.checked)}
        />
        {props.showPreview !== false ? <Eye size={12} /> : <EyeOff size={12} />}
        <span>Show preview</span>
      </label>
    </>
  );
}

/**
 * Instancer-only section: appears when scatterShape === "onMesh". Renders a
 * Pick / Clear pair for the surface entity, plus helper text describing the
 * current projected-mode center. Mirrors the camera-follow picker UX so users
 * have one mental model for "pick from hierarchy".
 */
function InstancerSurfaceSection({ entityId, props }) {
  const [, force] = useState(0);
  // Mirror the live prop so the picker row reflects the picked entity name
  // (and any entity-deletion events).
  useEffect(() => {
    const onChange = (info) => {
      if (info.entityId === entityId && info.componentType === "instancer") force((v) => v + 1);
    };
    const onHierarchy = () => force((v) => v + 1);
    return () => {}; // noop cleanup; force is idempotent
  }, [entityId]);

  const targetId = props.scatterSurfaceEntity;
  const target = targetId ? engine.getEntity(targetId) : null;
  const targetLabel = target ? target.name : targetId || "";
  const targetMissing = !!targetId && !target;
  const surfaceMode = props.scatterSurfaceMode ?? "whole";

  const commitProp = (key, value) =>
    commandBus.execute(new SetComponentPropCommand(entityId, "instancer", key, value));

  return (
    <>
      <div className="inspector-subheader">Surface</div>
      <div className="camera-follow-row">
        <input
          className={`text-field ${targetMissing ? "missing-ref" : ""}`}
          type="text"
          value={targetLabel}
          placeholder="(self)"
          readOnly
          title={
            targetMissing
              ? "Referenced entity no longer exists — falling back to this entity's mesh"
              : target
                ? "Mesh/Model whose surface is scattered on"
                : "Empty = use this entity's own Mesh/Model component"
          }
        />
        <button
          className="toolbar-btn"
          title="Pick an entity from the hierarchy to scatter on its surface"
          onClick={() => {
            if (isSurfacePickArmed()) disarmSurfacePick();
            else armSurfacePick();
            force((v) => v + 1);
          }}
        >
          {isSurfacePickArmed() ? "Cancel" : "Pick"}
        </button>
        <button
          className="toolbar-btn"
          title="Clear — scatter on this entity's own mesh"
          disabled={!targetId}
          onClick={() => commitProp("scatterSurfaceEntity", "")}
        >
          Clear
        </button>
      </div>
      {surfaceMode === "projected" && (
        <div className="field-row" style={{ opacity: 0.75 }}>
          <span className="field-label" />
          <span className="inspector-hint">
            Points inside the projected shape are cast onto the surface along the chosen axis.
          </span>
        </div>
      )}
    </>
  );
}

/** Two-number field (anchors, pivot, pos, size). */
function Vec2PropField({ value, onCommit, labels = ["X", "Y"], step = 1 }) {
  const values = Array.isArray(value) ? value : [0, 0];
  return (
    <div className="vector-fields">
      {[0, 1].map((i) => (
        <NumberField
          key={`${i}-${labels[i]}`}
          value={values[i] ?? 0}
          step={step}
          onCommit={(v) => {
            const next = [...values];
            next[i] = v;
            onCommit(next);
          }}
        />
      ))}
    </div>
  );
}

const EPSILON = 1e-6;
const POINT_PRESETS = [
  ["top-left", "top", "top-right"],
  ["left", "center", "right"],
  ["bottom-left", "bottom", "bottom-right"],
];

/** Name of the matching preset for the current anchors/pivot, or null. */
function matchAnchorPreset(props) {
  for (const [name, preset] of Object.entries(ANCHOR_PRESETS)) {
    const same = (a, b) => Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON;
    if (
      same(preset.anchorMin, props.anchorMin ?? [0.5, 0.5]) &&
      same(preset.anchorMax, props.anchorMax ?? [0.5, 0.5])
    ) {
      return name;
    }
  }
  return null;
}

/**
 * Custom inspector for the UI Element rect: a 3×3 anchor-preset grid plus
 * stretch buttons, then pos/size fields whose labels adapt to the anchoring
 * (Unity-style: point-anchored = X/Y + W/H, stretched = insets from edges).
 */
function UiElementSection({ entityId, props }) {
  const commit = (key, value) =>
    commandBus.execute(new SetComponentPropCommand(entityId, "uielement", key, value));

  const applyPreset = (name) => {
    const next = applyAnchorPreset(name, props.size);
    if (!next) return;
    const cmds = Object.entries(next).map(
      ([key, value]) => new SetComponentPropCommand(entityId, "uielement", key, value),
    );
    commandBus.execute(new BatchCommand(cmds, `Anchor: ${name}`));
  };

  const active = matchAnchorPreset(props);
  const stretchX = (props.anchorMax?.[0] ?? 0.5) - (props.anchorMin?.[0] ?? 0.5) > EPSILON;
  const stretchY = (props.anchorMax?.[1] ?? 0.5) - (props.anchorMin?.[1] ?? 0.5) > EPSILON;

  const posLabels = [stretchX ? "Left" : "X", stretchY ? "Top" : "Y"];
  const sizeLabels = [stretchX ? "Right" : "W", stretchY ? "Bottom" : "H"];

  const el = engine.getEntity(entityId)?.getComponent("uielement");
  const layoutControlled = !!el?.layoutControlled;

  return (
    <>
      <div className="field-row">
        <span className="field-label">Anchor</span>
        <div className="anchor-preset-wrap">
          <div className="anchor-preset-grid">
            {POINT_PRESETS.flat().map((name) => (
              <button
                key={name}
                className={`anchor-preset-cell ${active === name ? "active" : ""}`}
                title={name}
                onClick={() => applyPreset(name)}
              >
                <span className="anchor-dot" />
              </button>
            ))}
          </div>
          <div className="anchor-preset-stretch">
            {["stretch-x", "stretch-y", "stretch"].map((name) => (
              <button
                key={name}
                className={`toolbar-btn tiny ${active === name ? "active" : ""}`}
                title={name}
                onClick={() => applyPreset(name)}
              >
                {name === "stretch-x" ? "↔" : name === "stretch-y" ? "↕" : "⛶"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {layoutControlled && (
        <div className="field-row">
          <span className="field-label" style={{ opacity: 0.6 }}>
            Positioned by parent UI Layout
          </span>
        </div>
      )}
      <div className="field-row">
        <span className="field-label">{posLabels.join(" / ")}</span>
        <Vec2PropField value={props.pos} labels={posLabels} onCommit={(v) => commit("pos", v)} />
      </div>
      <div className="field-row">
        <span className="field-label">{sizeLabels.join(" / ")}</span>
        <Vec2PropField value={props.size} labels={sizeLabels} onCommit={(v) => commit("size", v)} />
      </div>
      <div className="field-row">
        <span className="field-label">Pivot</span>
        <Vec2PropField value={props.pivot} step={0.1} onCommit={(v) => commit("pivot", v)} />
      </div>
      <div className="field-row">
        <span className="field-label">Opacity</span>
        <NumberField value={props.opacity ?? 1} min={0} max={1} step={0.05} onCommit={(v) => commit("opacity", v)} />
      </div>
      <div className="field-row">
        <span className="field-label">Visible</span>
        <input type="checkbox" checked={props.visible !== false} onChange={(e) => commit("visible", e.target.checked)} />
      </div>
      <div className="field-row">
        <span className="field-label">Raycast Target</span>
        <input
          type="checkbox"
          checked={props.raycastTarget !== false}
          onChange={(e) => commit("raycastTarget", e.target.checked)}
        />
      </div>
    </>
  );
}

function ComponentSection({ entityId, type, props }) {
  const cls = getComponentClass(type);
  // Mirror the live `enabled` flag into local state so the eye icon
  // reflects the engine's current decision (the scene mirror doesn't
  // refresh on every component prop change without a re-render trigger).
  // We deliberately read from the engine here — same pattern as the
  // camera-follow section above — so external mutations (undo/redo,
  // scene load) all show up in the UI.
  const [, force] = useState(0);
  useEffect(() => {
    const onChange = (info) => {
      if (info.entityId === entityId && info.componentType === type) force((v) => v + 1);
    };
    return engine.on("component-changed", onChange);
  }, [entityId, type]);
  const component = engine.getEntity(entityId)?.getComponent(type);
  const enabled = component ? component.enabled !== false : props.enabled !== false;
  // viewOnly: per-component OR entity-wide. Reading both keeps the toggle
  // showing the user's effective intent — if the entity toggle is on, this
  // component is gated even when its own prop is off (and vice versa).
  const entityViewOnly = !!engine.getEntity(entityId)?.viewOnly;
  const viewOnly = component ? component.viewOnly : (!!props.viewOnly || entityViewOnly);
  const toggleEnabled = () => {
    if (!component) return;
    commandBus.execute(new SetComponentPropCommand(entityId, type, "enabled", !enabled));
  };
  const toggleViewOnly = () => {
    if (!component) return;
    commandBus.execute(new SetComponentPropCommand(entityId, type, "viewOnly", !viewOnly));
  };

  // Unknown type: its module is disabled. The data survives — say so.
  if (!cls) {
    return (
      <div className="inspector-section">
        <div className="section-header">
          {type}
          <button
            className="icon-btn"
            title="Remove component"
            onClick={() => commandBus.execute(new RemoveComponentCommand(entityId, type))}
          >
            <X size={12} />
          </button>
        </div>
        <div className="field-row">
          <span className="field-label" style={{ opacity: 0.6 }}>
            Missing — enable its module in Window → Modules
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`inspector-section ${enabled ? "" : "disabled"}`}>
      <div className="section-header">
        {cls.label}
        <button
          className={`icon-btn ${viewOnly ? "active-toggle" : ""}`}
          title={
            viewOnly
              ? entityViewOnly && !props.viewOnly
                ? "View-Only (inherited from entity)"
                : "Disable view-only gating"
              : "Pause while off-camera"
          }
          onClick={toggleViewOnly}
        >
          <ScanEye size={12} />
        </button>
        <button
          className="icon-btn"
          title={enabled ? "Disable component" : "Enable component"}
          onClick={toggleEnabled}
        >
          {enabled ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        <button
          className="icon-btn"
          title="Remove component"
          onClick={() => commandBus.execute(new RemoveComponentCommand(entityId, type))}
        >
          <X size={12} />
        </button>
      </div>
      {cls.schema.map((descriptor) => {
        if (descriptor.showIf && !descriptor.showIf(props)) return null;
        return (
          <div className="field-row" key={descriptor.key}>
            <span className="field-label">{descriptor.label}</span>
            <PropField
              descriptor={descriptor}
              value={props[descriptor.key]}
              onCommit={(v) => {
                if (type === "mesh" && descriptor.key === "geometry" && props.geometryAsset) {
                  commandBus.execute(new BatchCommand([
                    new SetComponentPropCommand(entityId, type, "geometryAsset", ""),
                    new SetComponentPropCommand(entityId, type, descriptor.key, v),
                  ], "Use primitive geometry"));
                  return;
                }
                commandBus.execute(new SetComponentPropCommand(entityId, type, descriptor.key, v));
              }}
            />
          </div>
        );
      })}
      {type === "uielement" && <UiElementSection entityId={entityId} props={props} />}
      {type === "script" && <ScriptAttributeFields entityId={entityId} props={props} />}
      {type === "mesh" && (
        <>
          <button
            className="toolbar-btn wide"
            onClick={() => {
              useGeometryEditStore.getState().enter(entityId);
              openPanel("viewport");
            }}
          >
            Edit Geometry in Scene
          </button>
          <button className="toolbar-btn wide" onClick={() => openPanel("geometryEditor")}>
            Open Separate Geometry Editor
          </button>
          {props.material && (
            <button className="toolbar-btn wide" onClick={() => openPanel("material")}>
              Edit Material
            </button>
          )}
          <button className="toolbar-btn wide" onClick={() => openPanel("shaderGraph")}>
            Edit Shader Graph
          </button>
        </>
      )}
      {type === "camera" && (
        <CameraFollowSection entityId={entityId} props={props} />
      )}
      {type === "instancer" && props.scatterShape === "onMesh" && (
        <InstancerSurfaceSection entityId={entityId} props={props} />
      )}
      {type === "camera" && (
        <button
          className="toolbar-btn wide"
          title="Copy the editor viewport's pose onto this camera"
          onClick={() => {
            const view = getEditorCameraView();
            if (!view) return;
            const entity = engine.getEntity(entityId);
            const before = entity?.getTransform();
            if (!before) return;
            commandBus.execute(
              new SetTransformCommand(entityId, {
                position: view.position,
                rotation: view.rotation,
                scale: before.scale,
              }, before),
            );
          }}
        >
          <Crosshair size={12} />
          Adjust to View
        </button>
      )}
      {type === "camera" && engine.getEntity(entityId)?.getComponent?.("postprocess") && (
        <button
          className="toolbar-btn wide"
          title="Open the post-process graph editor for this camera"
          onClick={() => openPanel("postprocess")}
        >
          <Sparkles size={12} />
          Open Post Process Editor
        </button>
      )}
      {type === "particles" && (
        <button className="toolbar-btn wide" onClick={() => openPanel("particles")}>
          Open Particle Editor
        </button>
      )}
      {type === "animation" && props.controller && (
        <button className="toolbar-btn wide" onClick={() => openPanel("animator")}>
          Edit Animator
        </button>
      )}
      {type === "sound" && <SoundSection entityId={entityId} props={props} />}
      {type === "listener" && <ListenerSection entityId={entityId} />}
      {type === "terrain" && <TerrainSection entityId={entityId} props={props} />}
      {type === "collider" && props.shape === "heightfield" && !engine.getEntity(entityId)?.getComponent("terrain") && (
        <div className="field-row">
          <span className="field-label" style={{ opacity: 0.6 }}>
            Requires a Terrain component on this entity
          </span>
        </div>
      )}
    </div>
  );
}

/** One line in the Overrides dropdown, with its own Apply / Revert. */
function OverrideRow({ rootId, override, label }) {
  return (
    <div className="prefab-override-row">
      <span className="prefab-override-label" title={label}>
        {label}
      </span>
      <button className="prefab-mini-btn" title="Apply just this to the prefab" onClick={() => applyPrefab(rootId, [override])}>
        Apply
      </button>
      <button className="prefab-mini-btn" title="Discard just this change" onClick={() => revertPrefab(rootId, [override])}>
        Revert
      </button>
    </div>
  );
}

/** Human-readable description of an override, for the dropdown. */
function describeOverride(root, override) {
  const target = override.t?.length
    ? (findEntityByFidPath(root, override.t)?.name ?? override.t.join(" › "))
    : root.name;
  switch (override.k) {
    case "prop":
      return `${target} › ${getComponentClass(override.c)?.label ?? override.c} › ${override.key}`;
    case "transform":
      return `${target} › ${override.key}`;
    case "name":
      return `${target} › name`;
    case "flag":
      return `${target} › ${override.key}`;
    case "addComponent":
      return `${target} › added ${getComponentClass(override.c)?.label ?? override.c}`;
    case "removeComponent":
      return `${target} › removed ${getComponentClass(override.c)?.label ?? override.c}`;
    case "addEntity":
      return `${target} › added "${override.v?.name ?? "entity"}"`;
    case "removeEntity":
      return `removed "${target}"`;
    default:
      return target;
  }
}

/** Live entity at an fid path inside an instance. */
function findEntityByFidPath(root, path) {
  let entity = root;
  for (const fid of path) {
    entity = entity?.children.find((c) => c.fid === fid);
    if (!entity) return null;
  }
  return entity;
}

/**
 * The prefab bar at the top of the inspector for anything inside an instance:
 * where the prefab lives, what's been changed on this instance, and the
 * Apply / Revert / Open / Unpack actions.
 */
function PrefabSection({ entityId }) {
  const [overridesOpen, setOverridesOpen] = useState(false);
  usePrefabStore((s) => s.version);
  useSceneStore((s) => s.entities); // re-derive after any scene mutation

  const live = engine.getEntity(entityId);
  const root = live ? getPrefabRoot(live) : null;
  if (!root) return null;

  const guid = prefabRegistry.resolveLink(root.prefab);
  const def = guid ? prefabRegistry.getDef(guid) : null;
  const path = guid ? prefabRegistry.pathOf(guid) : null;
  const overrides = guid ? diffInstance(root) : [];
  const baseName = def?.variantOf ? prefabRegistry.getDef(prefabRegistry.resolveLink(def.variantOf))?.name : null;

  if (!guid) {
    return (
      <div className="prefab-section missing">
        <div className="prefab-section-head">
          <Package size={13} />
          <span className="prefab-section-name">Missing Prefab</span>
        </div>
        <div className="prefab-section-note">
          The asset this instance came from can't be found. Its overrides are preserved — restore the file, or unpack to
          keep these entities as plain objects.
        </div>
        <div className="prefab-actions">
          <button className="toolbar-btn" onClick={() => unpackPrefab(root.id, { deep: true })}>
            Unpack Completely
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="prefab-section">
      <div className="prefab-section-head">
        <Package size={13} />
        <span className="prefab-section-name" title={path ?? ""}>
          {def?.name ?? "Prefab"}
        </span>
        {baseName && <span className="prefab-variant-tag" title={`Variant of ${baseName}`}>variant of {baseName}</span>}
        {root !== live && <span className="prefab-section-note inline">(part of this prefab)</span>}
      </div>

      <div className="prefab-actions">
        <button className="toolbar-btn" disabled={!path} onClick={() => openPrefabMode(path)} title="Edit the prefab asset in isolation">
          Open
        </button>
        <button className="toolbar-btn" disabled={!path} onClick={() => useSelectionStore.getState().selectAsset(path)} title="Reveal the asset in the Assets panel">
          Select
        </button>
        <button
          className="toolbar-btn"
          disabled={!overrides.length}
          onClick={() => applyPrefab(root.id)}
          title="Push every change on this instance into the prefab (all other instances update)"
        >
          Apply All
        </button>
        <button
          className="toolbar-btn"
          disabled={!overrides.length}
          onClick={() => revertPrefab(root.id)}
          title="Discard every change on this instance"
        >
          Revert All
        </button>
      </div>

      <div className="prefab-actions">
        <button className="toolbar-btn" onClick={() => createVariantFromInstance(root.id)} title="Make a new prefab that inherits from this one, with these changes baked in">
          Create Variant
        </button>
        <button className="toolbar-btn" onClick={() => unpackPrefab(root.id)} title="Break the link, keep the entities (nested prefabs stay linked)">
          Unpack
        </button>
      </div>

      {overrides.length > 0 && (
        <>
          <button className="prefab-overrides-toggle" onClick={() => setOverridesOpen((v) => !v)}>
            <ChevronRight size={11} className={overridesOpen ? "open" : ""} />
            {overrides.length} override{overrides.length === 1 ? "" : "s"}
          </button>
          {overridesOpen && (
            <div className="prefab-overrides">
              {overrides.map((override, i) => (
                <OverrideRow key={i} rootId={root.id} override={override} label={describeOverride(root, override)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function InspectorPanel() {
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const assetPath = useSelectionStore((s) => s.assetPath);
  const entity = useSceneStore((s) => (selectedId ? s.entities[selectedId] : null));
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuUp, setAddMenuUp] = useState(false);
  const addButtonRef = useRef(null);
  const addMenuRef = useRef(null);
  // Toggling a module (un)registers component types — re-render for the list.
  useModulesStore((s) => s.enabled);

  // Esc closes the open Add Component menu without dismissing focus from
  // the trigger button. Keeps the menu from "sticking open" if the user
  // opens it and then backs out.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") setAddMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addMenuOpen]);

  /**
   * When opening the Add Component menu, pick the direction at runtime: open
   * upward only if there's not enough room below the trigger AND there's more
   * room above than below. The menu caps itself at 60vh via CSS, so the
   * correct check is which side has more room at the moment of opening —
   * that way it never spills off-screen in either direction.
   */
  const openAddMenu = () => {
    const btn = addButtonRef.current;
    if (btn) {
      const rect = btn.getBoundingClientRect();
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;
      setAddMenuUp(spaceBelow < spaceAbove);
    }
    setAddMenuOpen(true);
  };

  if (!entity && assetPath) return <AssetInspector path={assetPath} />;
  if (!entity) {
    return <div className="inspector-panel empty">No entity selected</div>;
  }

  const availableTypes = getComponentTypes()
    .filter((t) => !(t in entity.components))
    // `internal` components are invisible everywhere; `importOnly` ones show
    // their inspector section but can't be added by hand (e.g. Skinned Mesh —
    // meaningless without an imported rig above it).
    .filter((t) => {
      const cls = getComponentClass(t);
      return !cls?.internal && !cls?.importOnly;
    })
    // UI components only exist inside a UI Screen subtree. Without an
    // ancestor `uiscreen`, the dropdown hides everything except `uiscreen`
    // itself (which is what *creates* the UI subtree). UI Screen itself is
    // always available so the user can start a UI hierarchy from anywhere.
    .filter((t) => {
      if (!t.startsWith("ui")) return true;
      if (t === "uiscreen") return true;
      return isInsideUiScreen(entity.id);
    });

  /**
   * Components that depend on other components being present. The entry is
   * kept visible in the dropdown but disabled, with a tooltip explaining the
   * missing prerequisite so the user knows what to add. Each value is a list
   * of component types — any one of them satisfies the requirement.
   *   { "instancer": ["mesh", "model"] }  — Instancer requires a Mesh or
   *   Model component on the same entity to read the source geometry from.
   */
  const componentRequires = { instancer: ["mesh", "model"], postprocess: ["camera"] };

  const commitName = (value) => {
    const name = value.trim();
    if (name && name !== entity.name) {
      commandBus.execute(new RenameEntityCommand(entity.id, name));
    }
  };

  // Per-mode visibility state lives on the live engine entity; the React
  // mirror doesn't include it (mirroring everything every tick would be
  // wasteful — and these flags only change when the user toggles them).
  // Reading through the engine instance guarantees we always show the
  // current value, even after undo/redo or scene reload.
  const liveEntity = engine.getEntity(entity.id);
  const editorEnabled = liveEntity?.enabledInEditor !== false;
  const gameEnabled = liveEntity?.enabledInGame !== false;

  return (
    <div className="inspector-panel">
      <PrefabSection entityId={entity.id} />
      <div className="inspector-section">
        <div className="field-row">
          <span className="field-label">Name</span>
          <input
            className="text-field"
            type="text"
            key={entity.id + entity.name}
            defaultValue={entity.name}
            onBlur={(e) => commitName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
          />
        </div>
        <div className="field-row">
          <span className="field-label">View Only</span>
          <label className="field-row inline" title="Pause this entity's components while it is outside the camera frustum">
            <input
              type="checkbox"
              checked={!!engine.getEntity(entity.id)?.viewOnly}
              onChange={(e) =>
                commandBus.execute(new SetEntityViewOnlyCommand(entity.id, e.target.checked))
              }
            />
          </label>
        </div>
        <div className="field-row visibility-row">
          <span className="field-label">Enabled</span>
          <div className="visibility-toggles" role="group" aria-label="Visibility per mode">
            <label
              className="visibility-toggle"
              title={editorEnabled ? "Visible in editor — click to hide in editor" : "Hidden in editor — click to show in editor"}
            >
              <input
                type="checkbox"
                checked={editorEnabled}
                onChange={(e) =>
                  commandBus.execute(
                    new SetEntityEnabledInEditorCommand(entity.id, e.target.checked),
                  )
                }
              />
              <span className="visibility-toggle-label">Editor</span>
            </label>
            <label
              className="visibility-toggle"
              title={gameEnabled ? "Enabled in game (play) — click to disable in game" : "Disabled in game — click to enable in game"}
            >
              <input
                type="checkbox"
                checked={gameEnabled}
                onChange={(e) =>
                  commandBus.execute(
                    new SetEntityEnabledInGameCommand(entity.id, e.target.checked),
                  )
                }
              />
              <span className="visibility-toggle-label">Game</span>
            </label>
          </div>
        </div>
      </div>

      <TransformSection entity={entity} />

      {Object.entries(entity.components)
        .filter(([type]) => !getComponentClass(type)?.internal)
        .map(([type, props]) => (
          <ComponentSection key={type} entityId={entity.id} type={type} props={props} />
        ))}

      <div className="add-component-wrap">
        <div className="dropdown-wrap">
          <button
            ref={addButtonRef}
            className="toolbar-btn wide"
            disabled={!availableTypes.length}
            onClick={() => (addMenuOpen ? setAddMenuOpen(false) : openAddMenu())}
          >
            <Plus size={14} />
            Add Component
          </button>
          {addMenuOpen && (
            <>
              <div className="dropdown-overlay" onClick={() => setAddMenuOpen(false)} />
              <div ref={addMenuRef} className={`dropdown-menu${addMenuUp ? " up" : ""}`}>
                {availableTypes.map((type) => {
                  const requiredTypes = componentRequires[type];
                  const missingRequirement = requiredTypes && !requiredTypes.some((t) => t in entity.components);
                  const Cls = getComponentClass(type);
                  const label = Cls?.label ?? type;
                  const requiredLabel = requiredTypes
                    ?.map((t) => getComponentClass(t)?.label ?? t)
                    .join(" or ");
                  return (
                    <button
                      key={type}
                      className="dropdown-item"
                      disabled={missingRequirement}
                      title={
                        missingRequirement
                          ? `${label} requires a ${requiredLabel} component on this entity`
                          : undefined
                      }
                      onClick={async () => {
                        if (missingRequirement) return;
                        setAddMenuOpen(false);
                        if (type === "terrain") {
                          const mesh = entity.getComponent("mesh");
                          const needsAssets = !mesh?.props.geometryAsset || !mesh?.props.material;
                          let assets = null;
                          if (needsAssets) {
                            try {
                              assets = await createTerrainAssets();
                            } catch (err) {
                              console.error(`Could not create terrain assets: ${err}`);
                            }
                          }
                          commandBus.execute(new AddComponentCommand(entity.id, type));
                          assignTerrainAssets(entity, assets);
                        } else {
                          commandBus.execute(new AddComponentCommand(entity.id, type));
                        }
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
