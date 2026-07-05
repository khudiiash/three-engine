import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { engine } from "../engineInstance.js";
import { ANY_STATE } from "../../engine/animGraph.js";

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
    })),
    anyPosition: anyNode?.position,
  };
}

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

function StateNode({ data, selected }) {
  return (
    <div className={`shader-node cat-anim ${selected ? "selected" : ""}`}>
      <div className="shader-node-header">
        <Handle type="target" position={Position.Left} id="in" className="shader-handle" />
        <span className="shader-node-dot" />
        <span className="shader-node-label">{data.state.name}</span>
        {data.entry && <span className="animator-entry-badge">entry</span>}
        <Handle type="source" position={Position.Right} id="out" className="shader-handle" />
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
      <div className="shader-node-header">
        <span className="shader-node-dot" />
        <span className="shader-node-label">Any State</span>
        <Handle type="source" position={Position.Right} id="out" className="shader-handle" />
      </div>
    </div>
  );
}

const nodeTypes = { animState: StateNode, anyState: AnyStateNode };

// ---------------------------------------------------------------------------
// sidebar editors
// ---------------------------------------------------------------------------

function ParametersSection({ parameters, onChange }) {
  const add = (type) => {
    let i = 1;
    while (parameters.some((p) => p.name === `param${i}`)) i++;
    onChange([...parameters, { name: `param${i}`, type, default: type === "number" ? 0 : false }]);
  };

  const patch = (index, p) => onChange(parameters.map((x, i) => (i === index ? { ...x, ...p } : x)));
  const remove = (index) => onChange(parameters.filter((_, i) => i !== index));

  return (
    <div className="inspector-section">
      <div className="section-header">
        Parameters
        <div className="dropdown-wrap">
          <ParamAddButton onPick={add} />
        </div>
      </div>
      {parameters.length === 0 && <div className="asset-hint">No parameters</div>}
      {parameters.map((p, i) => (
        <div className="field-row animator-param-row" key={i}>
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
          {p.type === "number" ? (
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

/**
 * Live parameter playground: edits flow straight into the bound entity's
 * animator runtime, so the user can verify their transition conditions by
 * typing values and watching the active state change. The section re-reads
 * param values on every animation frame so consumed triggers and script
 * writes are reflected immediately.
 */
function ParamValuesSection({ parameters, component, options, onPickComponent }) {
  // rAF tick to refresh displayed values. Triggers get consumed by the
  // runtime after a transition fires; we need to see that "true → false"
  // transition without manual refresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!component?.runtime) return;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      setTick((t) => (t + 1) & 0xffff);
      requestAnimationFrame(loop);
    };
    const id = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(id);
    };
  }, [component]);

  if (!component) {
    return (
      <div className="inspector-section">
        <div className="section-header">Live Values</div>
        <div className="asset-hint">No entity in the scene uses this controller — add an Animation component first.</div>
      </div>
    );
  }
  if (!component.runtime) {
    return (
      <div className="inspector-section">
        <div className="section-header">Live Values</div>
        <div className="asset-hint">Waiting for the bound model to finish loading…</div>
      </div>
    );
  }

  const currentState = component.currentState ?? "—";

  return (
    <div className="inspector-section">
      <div className="section-header">
        Live Values
        {options.length > 1 && (
          <select
            className="select-field animator-target-select"
            value={component.entity.id}
            onChange={(e) => onPickComponent(e.target.value)}
            title="Pick which bound entity these values drive"
          >
            {options.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="animator-current-state">
        State: <span className="animator-current-state-name">{currentState}</span>
      </div>
      {parameters.length === 0 && <div className="asset-hint">No parameters to drive</div>}
      {parameters.map((p) => {
        const value = component.getParam(p.name);
        if (p.type === "number") {
          return (
            <div className="field-row animator-param-row" key={p.name}>
              <span className="animator-param-label">{p.name}</span>
              <input
                className="number-field"
                type="number"
                step={0.1}
                value={typeof value === "number" ? value : 0}
                onChange={(e) => component.setNumber(p.name, parseFloat(e.target.value) || 0)}
              />
            </div>
          );
        }
        if (p.type === "boolean") {
          return (
            <div className="field-row animator-param-row" key={p.name}>
              <span className="animator-param-label">{p.name}</span>
              <input
                type="checkbox"
                checked={!!value}
                onChange={(e) => component.setBool(p.name, e.target.checked)}
              />
            </div>
          );
        }
        // trigger
        return (
          <div className="field-row animator-param-row" key={p.name}>
            <span className="animator-param-label">{p.name}</span>
            <button
              className={`toolbar-btn tiny${value ? " active" : ""}`}
              onClick={() => component.setTrigger(p.name)}
              title="Fire trigger (auto-cleared after a transition consumes it)"
            >
              {value ? "set" : "fire"}
            </button>
          </div>
        );
      })}
    </div>
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

  const drivenComponent = useMemo(() => {
    if (!boundComponents.length) return null;
    const picked = boundComponents.find((c) => c.entity.id === pickedEntityId);
    return picked ?? boundComponents[0];
  }, [boundComponents, pickedEntityId]);
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

  const onConnect = useCallback(
    (connection) => {
      if (connection.source === connection.target) return;
      setDirty(true);
      setEdges((eds) =>
        addEdge(
          { ...connection, id: uid("t"), data: { conditions: [], duration: 0.25, exitTime: null } },
          eds.filter((e) => !(e.source === connection.source && e.target === connection.target)),
        ),
      );
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
          />
          <ParamValuesSection
            parameters={parameters}
            component={drivenComponent}
            options={drivenOptions}
            onPickComponent={setPickedEntityId}
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
        <div className="shader-graph-canvas">
          <ReactFlow
            nodes={decoratedNodes}
            edges={decoratedEdges}
            nodeTypes={nodeTypes}
            onNodesChange={guardedNodesChange}
            onEdgesChange={(changes) => {
              if (changes.some((c) => c.type === "remove")) setDirty(true);
              onEdgesChange(changes);
            }}
            onConnect={onConnect}
            onPaneContextMenu={(e) => {
              e.preventDefault();
              setCanvasMenu({ x: e.clientX, y: e.clientY });
            }}
            deleteKeyCode={["Delete", "Backspace"]}
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
