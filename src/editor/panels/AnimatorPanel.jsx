import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Save, Play, Trash2, Zap } from "lucide-react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  BaseEdge,
  getStraightPath,
  EdgeLabelRenderer,
  useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { engine } from "../engineInstance.js";
import { ANY_STATE } from "../../engine/animGraph.js";
import { setGraphHovered } from "../nodegraph/graphContext.js";

/**
 * Node-graph editor for .anim animation-controller assets (Unity-style):
 * state nodes wired by transition edges, a parameters sidebar, per-transition
 * conditions/blend settings. Save writes the file and live-applies the graph
 * to every Animation component referencing it.
 */

const PARAM_TYPES = ["number", "boolean", "trigger"];
const NUMBER_OPS = [">", "<", ">=", "<=", "==", "!="];

const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// graph <-> react-flow mapping
// ---------------------------------------------------------------------------

function conditionSummary(data, paramTypes) {
  const conditions = data.conditions ?? [];
  if (!conditions.length) return "exit";
  return conditions
    .map((c) =>
      paramTypes[c.param] === "trigger" ? c.param : `${c.param} ${c.op ?? "=="} ${c.value}`,
    )
    .join(" · ");
}

function graphToFlow(graph) {
  const nodes = [
    {
      id: ANY_STATE,
      type: "anyState",
      position: graph.anyPosition ?? { x: 40, y: 40 },
      data: {},
      deletable: false,
    },
    ...(graph.states ?? []).map((s) => ({
      id: s.id,
      type: "animState",
      position: { x: s.x ?? 0, y: s.y ?? 0 },
      data: { state: { ...s }, entry: graph.entry === s.id },
    })),
  ];
  const edges = (graph.transitions ?? []).map((t) => ({
    id: t.id ?? uid("t"),
    source: t.from,
    target: t.to,
    data: {
      conditions: t.conditions ?? [],
      duration: t.duration ?? 0.25,
      exitTime: t.exitTime ?? null,
      sourcePoint: t.sourcePoint,
      targetPoint: t.targetPoint,
    },
  }));
  return { nodes, edges };
}

function flowToGraph(nodes, edges, parameters, entry) {
  const anyNode = nodes.find((n) => n.id === ANY_STATE);
  const states = nodes
    .filter((n) => n.type === "animState")
    .map((n) => ({ ...n.data.state, x: n.position.x, y: n.position.y }));
  return {
    version: 1,
    parameters,
    states,
    entry: states.some((s) => s.id === entry) ? entry : (states[0]?.id ?? null),
    transitions: edges.map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      conditions: e.data?.conditions ?? [],
      duration: e.data?.duration ?? 0.25,
      exitTime: e.data?.exitTime ?? null,
      sourcePoint: e.data?.sourcePoint,
      targetPoint: e.data?.targetPoint,
    })),
    anyPosition: anyNode?.position,
  };
}

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

/**
 * Animator graph nodes use PlayCanvas-style edge handles: instead of small
 * dots on the left/right, a single invisible handle covers each of the four
 * edges of the node. Each handle acts as both source AND target, so dragging
 * from anywhere on a node's border to anywhere on another node's border
 * creates a transition. Connections always originate at the closest point on
 * the source edge to the cursor (React Flow snaps the start point to the
 * handle's edge), which is exactly the PlayCanvas behaviour.
 *
 * `isConnectableStart` and `isConnectableEnd` are both true so the same
 * element can initiate and accept connections.
 */
const EDGE_HANDLE_BASE_STYLE = {
  background: "transparent",
  border: "none",
  borderRadius: 0,
  minWidth: 0,
  minHeight: 0,
  transform: "none",
  pointerEvents: "all", // override RF's default `none` so the perimeter is grabbable
};
const EDGE_HANDLE_CLASS = "shader-handle shader-handle-edge connectionindicator";

function EdgeHandles() {
  return (
    <>
      {/* Target handles are rendered first so the source handles are on top
       * in document order — that way pointerdown on the perimeter always
       * hits the source handle and starts a connection. The target handle
       * is still in the DOM and is found by `elementFromPoint` when the user
       * drops the line on this side of another node. */}
      <Handle type="target" position={Position.Left} id="l" className={EDGE_HANDLE_CLASS}
        style={{ ...EDGE_HANDLE_BASE_STYLE, width: 12, height: "100%", top: 0, left: -6 }}
        isConnectableStart={false} isConnectableEnd />
      <Handle type="source" position={Position.Left} id="l" className={EDGE_HANDLE_CLASS}
        style={{ ...EDGE_HANDLE_BASE_STYLE, width: 12, height: "100%", top: 0, left: -6 }}
        isConnectableStart isConnectableEnd />

      <Handle type="target" position={Position.Right} id="r" className={EDGE_HANDLE_CLASS}
        style={{ ...EDGE_HANDLE_BASE_STYLE, width: 12, height: "100%", top: 0, right: -6 }}
        isConnectableStart={false} isConnectableEnd />
      <Handle type="source" position={Position.Right} id="r" className={EDGE_HANDLE_CLASS}
        style={{ ...EDGE_HANDLE_BASE_STYLE, width: 12, height: "100%", top: 0, right: -6 }}
        isConnectableStart isConnectableEnd />

      <Handle type="target" position={Position.Top} id="t" className={EDGE_HANDLE_CLASS}
        style={{ ...EDGE_HANDLE_BASE_STYLE, width: "100%", height: 12, top: -6 }}
        isConnectableStart={false} isConnectableEnd />
      <Handle type="source" position={Position.Top} id="t" className={EDGE_HANDLE_CLASS}
        style={{ ...EDGE_HANDLE_BASE_STYLE, width: "100%", height: 12, top: -6 }}
        isConnectableStart isConnectableEnd />

      <Handle type="target" position={Position.Bottom} id="b" className={EDGE_HANDLE_CLASS}
        style={{ ...EDGE_HANDLE_BASE_STYLE, width: "100%", height: 12, bottom: -6 }}
        isConnectableStart={false} isConnectableEnd />
      <Handle type="source" position={Position.Bottom} id="b" className={EDGE_HANDLE_CLASS}
        style={{ ...EDGE_HANDLE_BASE_STYLE, width: "100%", height: 12, bottom: -6 }}
        isConnectableStart isConnectableEnd />
    </>
  );
}

function StateNode({ data, selected }) {
  return (
    <div className={`shader-node cat-anim ${selected ? "selected" : ""}`}>
      <EdgeHandles />
      <div className="shader-node-header">
        <span className="shader-node-dot" />
        <span className="shader-node-label">{data.state.name}</span>
        {data.entry && <span className="animator-entry-badge">entry</span>}
      </div>
      <div className="shader-node-body">
        <div className="shader-node-row">
          <span className="shader-port-label">{data.state.clip || "no clip"}</span>
        </div>
      </div>
    </div>
  );
}

function AnyStateNode({ selected }) {
  return (
    <div className={`shader-node cat-any ${selected ? "selected" : ""}`}>
      <EdgeHandles />
      <div className="shader-node-header">
        <span className="shader-node-dot" />
        <span className="shader-node-label">Any State</span>
      </div>
    </div>
  );
}

const nodeTypes = { animState: StateNode, anyState: AnyStateNode };

/** Clamp a flow-space point so it sits on the perimeter of a node's bounding
 *  box (with a small `pad` so the arrowhead lands a few pixels outside the
 *  node border, never buried underneath it). Returns the input point
 *  unchanged when no box is supplied. */
function clampToBoxPerimeter(point, box, pad = 4) {
  if (!box) return point;
  const { x, y } = point;
  const minX = box.x - pad;
  const maxX = box.x + box.width + pad;
  const minY = box.y - pad;
  const maxY = box.y + box.height + pad;
  const cx = Math.min(Math.max(x, minX), maxX);
  const cy = Math.min(Math.max(y, minY), maxY);
  return { x: cx, y: cy };
}

// ---------------------------------------------------------------------------
// custom straight edge (PlayCanvas-style: a plain line + arrowhead, no curves)
// ---------------------------------------------------------------------------

function StraightEdge({
  id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  selected, markerEnd, label, data,
}) {
  // RF doesn't pass the source/target node directly — we look them up in
  // the store by id so we can clamp the target endpoint to the target
  // node's bounding box and keep the arrowhead visible above the node.
  const nodes = useStore((s) => s.nodeLookup);
  const sourceNode = nodes?.get?.(source);
  const targetNode = nodes?.get?.(target);

  // New connections carry the exact flow-space points the user grabbed and
  // released on. Falling back to the standard handle-derived coords keeps
  // existing edges (saved before this change) rendering correctly.
  const sp = data?.sourcePoint;
  const tp = data?.targetPoint;
  const sx = sp?.x ?? sourceX;
  const sy = sp?.y ?? sourceY;
  let tx = tp?.x ?? targetX;
  let ty = tp?.y ?? targetY;
  // Clamp the target endpoint to the target node's bounding box so the
  // arrowhead sits just outside the node's perimeter, not buried underneath
  // it. The source point is left as-is so the line "leaves" the source from
  // the exact spot the user grabbed.
  if (targetNode && tp) {
    const pos = targetNode.internals?.positionAbsolute ?? targetNode.position;
    const m = targetNode.measured;
    if (pos && m?.width != null && m?.height != null) {
      const c = clampToBoxPerimeter(tp, { x: pos.x, y: pos.y, width: m.width, height: m.height }, 6);
      tx = c.x;
      ty = c.y;
    }
  }
  const [edgePath] = getStraightPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty });
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ strokeWidth: selected ? 2 : 1.5 }} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`nodrag nopan animator-edge-label${selected ? " selected" : ""}`}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${(sx + tx) / 2}px, ${(sy + ty) / 2}px)`,
              pointerEvents: "all",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { default: StraightEdge };

/** Module-scoped ref shared between <ReactFlow>'s onConnect handlers and
 *  the custom <StraightConnectionLine>. Holds the exact flow-space points
 *  the user grabbed and is currently hovering. The connection line reads
 *  these so the live wire starts at the cursor's initial press position
 *  (not the edge midpoint). */
const dragPointRef = { startPoint: null, endPoint: null };

/** Live wire while dragging. We prefer the exact start/end points captured
 *  during the drag (dragPointRef) over the edge-midpoint `from/to` that
 *  RF passes in props. This makes the wire match what gets saved to the
 *  edge, and it spreads multiple transitions between the same nodes. */
function StraightConnectionLine({ fromX, fromY, toX, toY }) {
  const sx = dragPointRef.startPoint?.x ?? fromX;
  const sy = dragPointRef.startPoint?.y ?? fromY;
  const tx = dragPointRef.endPoint?.x ?? toX;
  const ty = dragPointRef.endPoint?.y ?? toY;
  return (
    <path
      d={`M ${sx},${sy} L ${tx},${ty}`}
      fill="none"
      stroke="#4d9dff"
      strokeWidth={2}
    />
  );
}

// ---------------------------------------------------------------------------
// sidebar editors
// ---------------------------------------------------------------------------

/**
 * Animator parameters list. In edit mode the right-hand column edits each
 * parameter's *default* value (the value the runtime initialises it to). In
 * play mode the right-hand column drives the *current runtime* value on a
 * bound Animation component, so you can poke parameters and watch the state
 * machine react. Both modes let you rename / remove / add parameters.
 */
function ParametersSection({
  parameters,
  onChange,
  playMode,
  drivenComponent,
  drivenOptions,
  onPickDriven,
}) {
  const add = (type) => {
    let i = 1;
    while (parameters.some((p) => p.name === `param${i}`)) i++;
    onChange([...parameters, { name: `param${i}`, type, default: type === "number" ? 0 : false }]);
  };

  const patch = (index, p) => onChange(parameters.map((x, i) => (i === index ? { ...x, ...p } : x)));
  const remove = (index) => onChange(parameters.filter((_, i) => i !== index));

  const currentState = playMode && drivenComponent ? drivenComponent.currentState : null;

  return (
    <div className="inspector-section">
      <div className="section-header">
        {playMode ? "Parameters (Live)" : "Parameters"}
        <div className="dropdown-wrap">
          <ParamAddButton onPick={add} />
        </div>
      </div>
      {playMode && drivenOptions.length > 1 && (
        <div className="field-row">
          <span className="field-label">Drives</span>
          <select
            className="select-field animator-target-select"
            value={drivenComponent?.entity.id ?? ""}
            onChange={(e) => onPickDriven(e.target.value)}
            title="Pick which bound entity these live values drive"
          >
            {drivenOptions.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      {playMode && (
        <div className="animator-current-state">
          State: <span className="animator-current-state-name">{currentState ?? "—"}</span>
        </div>
      )}
      {!playMode && parameters.length === 0 && <div className="asset-hint">No parameters</div>}
      {playMode && !drivenComponent?.runtime && (
        <div className="asset-hint">
          No bound entity with a live runtime — add an Animation component using this controller to drive values.
        </div>
      )}
      {parameters.map((p, i) => (
        <div className="field-row animator-param-row" key={p.name + ":" + i}>
          <input
            className="text-field"
            defaultValue={p.name}
            key={p.name}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== p.name) patch(i, { name });
            }}
          />
          <span className="animator-param-type">{p.type}</span>
          {playMode ? (
            drivenComponent?.runtime ? (
              <LiveParamControl param={p} component={drivenComponent} />
            ) : (
              <span className="animator-param-default" />
            )
          ) : p.type === "number" ? (
            <input
              className="number-field animator-param-default"
              type="number"
              step={0.1}
              value={p.default ?? 0}
              onChange={(e) => patch(i, { default: parseFloat(e.target.value) || 0 })}
            />
          ) : p.type === "boolean" ? (
            <input type="checkbox" checked={!!p.default} onChange={(e) => patch(i, { default: e.target.checked })} />
          ) : (
            <span className="animator-param-default" />
          )}
          <button className="icon-btn" title="Remove parameter" onClick={() => remove(i)}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Per-parameter runtime control. Re-renders on the parent's rAF tick so
 *  trigger consumption and external script writes show up immediately. */
function LiveParamControl({ param, component }) {
  const value = component.getParam(param.name);
  if (param.type === "number") {
    return (
      <input
        className="number-field animator-param-default"
        type="number"
        step={0.1}
        value={typeof value === "number" ? value : 0}
        onChange={(e) => component.setNumber(param.name, parseFloat(e.target.value) || 0)}
      />
    );
  }
  if (param.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => component.setBool(param.name, e.target.checked)}
      />
    );
  }
  // trigger
  return (
    <button
      className={`toolbar-btn tiny${value ? " active" : ""}`}
      onClick={() => component.setTrigger(param.name)}
      title="Fire trigger (auto-cleared after a transition consumes it)"
    >
      {value ? "set" : "fire"}
    </button>
  );
}

function ParamAddButton({ onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn" title="Add parameter" onClick={() => setOpen((v) => !v)}>
        <Plus size={12} />
      </button>
      {open && (
        <>
          <div className="dropdown-overlay" onClick={() => setOpen(false)} />
          <div className="dropdown-menu">
            {PARAM_TYPES.map((t) => (
              <button
                key={t}
                className="dropdown-item"
                onClick={() => {
                  setOpen(false);
                  onPick(t);
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function StateSection({ node, clipNames, isEntry, onPatch, onSetEntry, onPreview }) {
  const state = node.data.state;
  return (
    <div className="inspector-section">
      <div className="section-header">State</div>
      <div className="field-row">
        <span className="field-label">Name</span>
        <input
          className="text-field"
          key={node.id + state.name}
          defaultValue={state.name}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== state.name) onPatch({ name });
          }}
        />
      </div>
      <div className="field-row">
        <span className="field-label">Clip</span>
        {clipNames.length ? (
          <select className="select-field" value={state.clip ?? ""} onChange={(e) => onPatch({ clip: e.target.value })}>
            <option value="">None</option>
            {clipNames.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="text-field"
            key={node.id + (state.clip ?? "")}
            defaultValue={state.clip ?? ""}
            placeholder="clip name"
            onBlur={(e) => onPatch({ clip: e.target.value.trim() })}
          />
        )}
      </div>
      <div className="field-row">
        <span className="field-label">Speed</span>
        <input
          className="number-field"
          type="number"
          step={0.1}
          value={state.speed ?? 1}
          onChange={(e) => onPatch({ speed: parseFloat(e.target.value) || 1 })}
        />
      </div>
      <div className="field-row">
        <span className="field-label">Loop</span>
        <input type="checkbox" checked={state.loop !== false} onChange={(e) => onPatch({ loop: e.target.checked })} />
      </div>
      {!isEntry && (
        <button className="toolbar-btn wide" onClick={onSetEntry}>
          Set as Entry
        </button>
      )}
      <button className="toolbar-btn wide" onClick={onPreview}>
        <Play size={12} />
        Preview
      </button>
    </div>
  );
}

function TransitionSection({ edge, parameters, stateNames, onPatch }) {
  const data = edge.data ?? {};
  const conditions = data.conditions ?? [];

  const patchCondition = (index, patch) =>
    onPatch({ conditions: conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  const conditionRow = (c, i) => {
    const type = parameters.find((p) => p.name === c.param)?.type ?? "number";
    return (
      <div className="field-row animator-cond-row" key={i}>
        <select
          className="select-field"
          value={c.param}
          onChange={(e) => {
            const param = e.target.value;
            const t = parameters.find((p) => p.name === param)?.type;
            patchCondition(i, {
              param,
              op: t === "number" ? ">" : "==",
              value: t === "number" ? 0 : true,
            });
          }}
        >
          {parameters.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        {type === "number" && (
          <>
            <select
              className="select-field animator-op"
              value={c.op ?? ">"}
              onChange={(e) => patchCondition(i, { op: e.target.value })}
            >
              {NUMBER_OPS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <input
              className="number-field"
              type="number"
              step={0.1}
              value={c.value ?? 0}
              onChange={(e) => patchCondition(i, { value: parseFloat(e.target.value) || 0 })}
            />
          </>
        )}
        {type === "boolean" && (
          <select
            className="select-field"
            value={String(c.value ?? true)}
            onChange={(e) => patchCondition(i, { op: "==", value: e.target.value === "true" })}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        )}
        <button
          className="icon-btn"
          title="Remove condition"
          onClick={() => onPatch({ conditions: conditions.filter((_, x) => x !== i) })}
        >
          <Trash2 size={12} />
        </button>
      </div>
    );
  };

  return (
    <div className="inspector-section">
      <div className="section-header">
        Transition
        <button
          className="icon-btn"
          title="Add condition"
          disabled={!parameters.length}
          onClick={() => {
            const p = parameters[0];
            onPatch({
              conditions: [
                ...conditions,
                { param: p.name, op: p.type === "number" ? ">" : "==", value: p.type === "number" ? 0 : true },
              ],
            });
          }}
        >
          <Plus size={12} />
        </button>
      </div>
      <div className="animator-transition-label">
        {stateNames[edge.source] ?? "Any State"} → {stateNames[edge.target] ?? "?"}
      </div>
      {conditions.length === 0 && <div className="asset-hint">No conditions — fires at exit time</div>}
      {conditions.map(conditionRow)}
      <div className="field-row">
        <span className="field-label">Blend (s)</span>
        <input
          className="number-field"
          type="number"
          step={0.05}
          min={0}
          value={data.duration ?? 0.25}
          onChange={(e) => onPatch({ duration: Math.max(0, parseFloat(e.target.value) || 0) })}
        />
      </div>
      <div className="field-row">
        <span className="field-label">Exit time</span>
        <input
          className="number-field"
          type="number"
          step={0.05}
          min={0}
          max={1}
          placeholder="—"
          value={data.exitTime ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Math.min(1, Math.max(0, parseFloat(e.target.value) || 0));
            onPatch({ exitTime: v });
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// editor
// ---------------------------------------------------------------------------

/** Animation components in the scene bound to this controller file. */
function componentsUsing(animPath) {
  const out = [];
  try {
    for (const entity of engine.entities.values()) {
      const comp = entity.getComponent("animation");
      if (comp?.props.controller === animPath) out.push(comp);
    }
  } catch {
    // Engine not booted yet.
  }
  return out;
}

/** Clip names available for this controller (from a bound model, else any model). */
function collectClipNames(animPath) {
  const names = new Set();
  const bound = componentsUsing(animPath);
  try {
    if (bound.length) {
      for (const comp of bound) for (const n of comp.getClipNames()) names.add(n);
    } else {
      for (const entity of engine.entities.values()) {
        for (const clip of entity.getComponent("model")?.clips ?? []) names.add(clip.name);
      }
    }
  } catch {
    // Engine not booted yet.
  }
  return [...names];
}

function AnimatorEditor({ animPath }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [parameters, setParameters] = useState([]);
  const [entry, setEntry] = useState(null);
  const [dirty, setDirty] = useState(false);
  const { screenToFlowPosition } = useReactFlow();
  const [canvasMenu, setCanvasMenu] = useState(null);
  const [pickedEntityId, setPickedEntityId] = useState(null);
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem("engine.autosave.animator") === "1";
    } catch {
      return false;
    }
  });
  const toggleAutosave = () => {
    setAutosave((cur) => {
      const next = !cur;
      try {
        localStorage.setItem("engine.autosave.animator", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  useEffect(() => {
    let live = true;
    (async () => {
      let graph = null;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        graph = JSON.parse(await invoke("read_text_file", { path: animPath }));
      } catch (err) {
        console.error(`Failed to read animator: ${err}`);
        return;
      }
      if (!live) return;
      const flow = graphToFlow(graph);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setParameters(graph.parameters ?? []);
      setEntry(graph.entry ?? null);
      setDirty(false);
    })();
    return () => (live = false);
  }, [animPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const paramTypes = useMemo(() => Object.fromEntries(parameters.map((p) => [p.name, p.type])), [parameters]);
  const stateNames = useMemo(
    () => Object.fromEntries(nodes.filter((n) => n.type === "animState").map((n) => [n.id, n.data.state.name])),
    [nodes],
  );
  const clipNames = useMemo(() => collectClipNames(animPath), [animPath, nodes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedNode = nodes.find((n) => n.selected && n.type === "animState");
  const selectedEdge = !selectedNode && edges.find((e) => e.selected);

  // Re-scan the scene every frame so the param-values playground tracks adds
  // and removes of Animation components referencing this controller.
  const [boundComponents, setBoundComponents] = useState([]);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (!alive) return;
      setBoundComponents(componentsUsing(animPath));
      requestAnimationFrame(refresh);
    };
    const id = requestAnimationFrame(refresh);
    return () => {
      alive = false;
      cancelAnimationFrame(id);
    };
  }, [animPath]);

  // Track play mode (engine.setPlaying flips this). The play-mode UI shows
  // each parameter's *runtime* value on a bound Animation component, so we
  // need to react to play-changed events and re-render on every frame while
  // playing (consumed triggers / script writes should be visible immediately).
  const [playMode, setPlayMode] = useState(() => engine.playing);
  useEffect(() => {
    const onChange = (v) => setPlayMode(v);
    engine.on("play-changed", onChange);
    setPlayMode(engine.playing);
    return () => engine.off("play-changed", onChange);
  }, []);
  const [, setLiveTick] = useState(0);
  useEffect(() => {
    if (!playMode) return;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      setLiveTick((t) => (t + 1) & 0xffff);
      requestAnimationFrame(loop);
    };
    const id = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(id);
    };
  }, [playMode]);

  const drivenComponent = useMemo(() => {
    if (!boundComponents.length) return null;
    const picked = boundComponents.find((c) => c.entity.id === pickedEntityId);
    return picked ?? boundComponents[0];
  }, [boundComponents, pickedEntityId]);

  // Guard against a stale graph-hovered flag if the panel unmounts while
  // the pointer is still over it (dockview close, tab switch, …).
  useEffect(() => () => setGraphHovered(false), []);

  // Reset the picker if the previously-chosen entity disappears.
  useEffect(() => {
    if (pickedEntityId && boundComponents.length && !boundComponents.some((c) => c.entity.id === pickedEntityId)) {
      setPickedEntityId(null);
    }
  }, [boundComponents, pickedEntityId]);
  const drivenOptions = useMemo(
    () => boundComponents.map((c) => ({ id: c.entity.id, name: c.entity.name ?? c.entity.id })),
    [boundComponents],
  );

  // Entry badge + condition labels are derived — refresh node/edge data.
  const decoratedNodes = useMemo(
    () => nodes.map((n) => (n.type === "animState" ? { ...n, data: { ...n.data, entry: n.id === entry } } : n)),
    [nodes, entry],
  );
  const decoratedEdges = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        type: "default",
        animated: e.source === ANY_STATE,
        label: conditionSummary(e.data ?? {}, paramTypes),
        markerEnd: { type: "arrowclosed" },
      })),
    [edges, paramTypes],
  );

  const addState = (screenPos) => {
    setCanvasMenu(null);
    setDirty(true);
    let i = 1;
    while (nodes.some((n) => n.data?.state?.name === `State ${i}`)) i++;
    const id = uid("state");
    const position = screenPos ? screenToFlowPosition(screenPos) : { x: 220, y: 120 + Math.random() * 120 };
    setNodes((nds) => [
      ...nds,
      {
        id,
        type: "animState",
        position,
        data: { state: { id, name: `State ${i}`, clip: clipNames[0] ?? "", speed: 1, loop: true } },
      },
    ]);
    setEntry((cur) => cur ?? id);
  };

  const patchState = (nodeId, patch) => {
    setDirty(true);
    setNodes((nds) =>
      nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, state: { ...n.data.state, ...patch } } } : n)),
    );
  };

  const patchEdge = (edgeId, patch) => {
    setDirty(true);
    setEdges((eds) => eds.map((e) => (e.id === edgeId ? { ...e, data: { ...e.data, ...patch } } : e)));
  };

  /** Live cursor position in flow coordinates during a connection drag.
   *  Captured at the start (initial press) and updated on every pointer move
   *  so `onConnect` knows the exact points on the source/target edges the
   *  user grabbed and released on — the saved edge is then drawn between
   *  those two points, not between the edge midpoints. Multiple transitions
   *  between the same pair of nodes no longer overlap. Mirrors the
   *  module-scoped `dragPointRef` that the <StraightConnectionLine> reads
   *  for the live wire. */
  const dragRef = useRef({ startPoint: null, endPoint: null });

  // Window-level pointer tracking while a connection is in progress. React
  // Flow's `onConnect` doesn't include the cursor position, so we listen
  // for pointer events on the canvas to keep the drag ref current.
  useEffect(() => {
    const onMove = (e) => {
      if (!dragPointRef.startPoint) return;
      const pt = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      dragPointRef.endPoint = pt;
      dragRef.current.endPoint = pt;
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [screenToFlowPosition]);

  const onConnect = useCallback(
    (connection) => {
      if (connection.source === connection.target) {
        dragRef.current = { startPoint: null, endPoint: null };
        dragPointRef.startPoint = null;
        dragPointRef.endPoint = null;
        return;
      }
      setDirty(true);
      const data = { conditions: [], duration: 0.25, exitTime: null };
      // Store the actual flow-space start/end points so the saved edge
      // doesn't snap to edge midpoints.
      if (dragRef.current.startPoint) data.sourcePoint = dragRef.current.startPoint;
      if (dragRef.current.endPoint) data.targetPoint = dragRef.current.endPoint;
      setEdges((eds) =>
        addEdge(
          { ...connection, id: uid("t"), data },
          eds.filter((e) => !(e.source === connection.source && e.target === connection.target)),
        ),
      );
      dragRef.current = { startPoint: null, endPoint: null };
      dragPointRef.startPoint = null;
      dragPointRef.endPoint = null;
    },
    [setEdges],
  );

  const guardedNodesChange = useCallback(
    (changes) => {
      const guarded = changes.filter((c) => !(c.type === "remove" && c.id === ANY_STATE));
      if (guarded.some((c) => c.type !== "select" && c.type !== "dimensions")) setDirty(true);
      onNodesChange(guarded);
    },
    [onNodesChange],
  );

  const buildGraph = () => flowToGraph(nodes, edges, parameters, entry);

  const save = async () => {
    const graph = buildGraph();
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_scene", { path: animPath, contents: JSON.stringify(graph, null, 2) });
    for (const comp of componentsUsing(animPath)) comp.applyGraph(structuredClone(graph));
    setDirty(false);
    console.log(`Animator saved: ${animPath}`);
  };

  // Autosave: when enabled, commit every change. Debounced so transient
  // mutations (e.g. dragging a node, which fires onNodesChange on every
  // intermediate position) collapse into a single write at the end of the
  // gesture. Selection-only updates and the initial load keep `dirty` false
  // and never reach the timer.
  useEffect(() => {
    if (!autosave) return;
    if (!dirty) return;
    const id = setTimeout(save, 150);
    return () => clearTimeout(id);
  }, [autosave, nodes, edges, parameters, entry, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = (stateName) => {
    const bound = componentsUsing(animPath);
    if (!bound.length) {
      console.warn("No entity in the scene uses this controller — add an Animation component first.");
      return;
    }
    // Preview runs the current (possibly unsaved) graph.
    const graph = buildGraph();
    for (const comp of bound) {
      comp.applyGraph(structuredClone(graph));
      comp.play(stateName, 0.15);
    }
  };

  return (
    <div className="shader-graph-panel animator-panel">
      <div className="panel-toolbar">
        <button className="toolbar-btn" onClick={() => addState()}>
          <Plus size={14} />
          State
        </button>
        <span className="asset-path" title={animPath}>
          {animPath.split(/[\\/]/).pop()}
        </span>
        <button
          className={`toolbar-btn icon-only${autosave ? " active" : ""}`}
          title={autosave ? "Autosave on — changes save instantly" : "Autosave off — click Save to commit"}
          onClick={toggleAutosave}
        >
          <Zap size={14} />
        </button>
        <button className="toolbar-btn" disabled={!dirty || autosave} onClick={save}>
          <Save size={13} />
          Save{dirty ? " •" : ""}
        </button>
      </div>
      <div className="animator-body">
        <div className="animator-sidebar">
          <ParametersSection
            parameters={parameters}
            onChange={(next) => {
              setParameters(next);
              setDirty(true);
            }}
            playMode={playMode}
            drivenComponent={drivenComponent}
            drivenOptions={drivenOptions}
            onPickDriven={setPickedEntityId}
          />
          {selectedNode && (
            <StateSection
              node={selectedNode}
              clipNames={clipNames}
              isEntry={selectedNode.id === entry}
              onPatch={(patch) => patchState(selectedNode.id, patch)}
              onSetEntry={() => {
                setEntry(selectedNode.id);
                setDirty(true);
              }}
              onPreview={() => preview(selectedNode.data.state.name)}
            />
          )}
          {selectedEdge && (
            <TransitionSection
              edge={selectedEdge}
              parameters={parameters}
              stateNames={stateNames}
              onPatch={(patch) => patchEdge(selectedEdge.id, patch)}
            />
          )}
        </div>
        <div
          className="shader-graph-canvas"
          onMouseEnter={() => setGraphHovered(true)}
          onMouseLeave={() => setGraphHovered(false)}
        >
          <ReactFlow
            nodes={decoratedNodes}
            edges={decoratedEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            connectionLineComponent={StraightConnectionLine}
            connectionRadius={36}
            onNodesChange={guardedNodesChange}
            onEdgesChange={(changes) => {
              if (changes.some((c) => c.type === "remove")) setDirty(true);
              onEdgesChange(changes);
            }}
            onConnect={onConnect}
            onConnectStart={(_event, _params) => {
              const ev = _event;
              if (ev && ev.clientX != null) {
                const pt = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
                dragRef.current.startPoint = pt;
                dragRef.current.endPoint = pt;
                dragPointRef.startPoint = pt;
                dragPointRef.endPoint = pt;
              } else {
                dragRef.current = { startPoint: null, endPoint: null };
                dragPointRef.startPoint = null;
                dragPointRef.endPoint = null;
              }
            }}
            onConnectEnd={() => {
              // Clean up the drag ref on the next tick so `onConnect` (which
              // fires synchronously here) still sees the final `endPoint`.
              setTimeout(() => {
                if (!dragRef.current.startPoint) {
                  dragRef.current = { startPoint: null, endPoint: null };
                  dragPointRef.startPoint = null;
                  dragPointRef.endPoint = null;
                }
              }, 0);
            }}
            onEdgeDoubleClick={(_event, edge) => {
              // Double-click a transition to remove it.
              setEdges((eds) => eds.filter((e) => e.id !== edge.id));
              setDirty(true);
            }}
            onPaneContextMenu={(e) => {
              e.preventDefault();
              setCanvasMenu({ x: e.clientX, y: e.clientY });
            }}
            deleteKeyCode={["Delete", "Backspace"]}
            connectionMode="loose"
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {canvasMenu && (
            <>
              <div className="dropdown-overlay" onClick={() => setCanvasMenu(null)} />
              <div className="dropdown-menu context-menu" style={{ left: canvasMenu.x, top: canvasMenu.y }}>
                <button className="dropdown-item" onClick={() => addState(canvasMenu)}>
                  New State
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="shader-graph-hint">
        Drag between states to add a transition · select an edge to edit conditions · Save applies to the scene
      </div>
    </div>
  );
}

export function AnimatorPanel() {
  const assetPath = useSelectionStore((s) => s.assetPath);
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const entity = useSceneStore((s) => (selectedId ? s.entities[selectedId] : null));
  const animPath = assetPath?.toLowerCase().endsWith(".anim")
    ? assetPath
    : entity?.components?.animation?.controller || null;

  if (!animPath) {
    return (
      <div className="shader-graph-panel empty">
        Select a .anim asset (or an entity whose Animation component has a controller) to edit it.
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <AnimatorEditor key={animPath} animPath={animPath} />
    </ReactFlowProvider>
  );
}
