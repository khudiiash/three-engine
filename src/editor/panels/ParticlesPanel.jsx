import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Check, RotateCcw, Sparkles } from "lucide-react";
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
import { commandBus } from "../commands/CommandBus.js";
import { AddComponentCommand, SetComponentPropCommand } from "../commands/componentCommands.js";
import {
  P_NODE_TYPES,
  nodeDefaults,
  compileParticleGraph,
  DEFAULT_PARTICLE_GRAPH,
} from "../../engine/particleGraph.js";
import { PARTICLE_PRESETS } from "../particlePresets.js";
import { AssetField } from "../fields/AssetField.jsx";

const CATEGORY_LABELS = {
  emitter: "Emitters",
  attribute: "Attributes",
  value: "Values",
  math: "Math",
  noise: "Noise",
  force: "Forces",
};

const PALETTE = Object.entries(CATEGORY_LABELS).map(([category, group]) => ({
  group,
  types: Object.entries(P_NODE_TYPES)
    .filter(([, meta]) => meta.category === category)
    .map(([type]) => type),
}));

function graphToFlow(graph) {
  const nodes = graph.nodes.map((n) => ({
    id: n.id,
    type: "particleNode",
    position: n.position ?? { x: 0, y: 0 },
    data: { nodeType: n.type, props: n.props ?? {} },
  }));
  const edges = (graph.edges ?? []).map((e, i) => ({
    id: e.id ?? `e${i}-${e.source}-${e.sourceHandle}-${e.target}-${e.targetHandle}`,
    source: e.source,
    sourceHandle: e.sourceHandle ?? "out",
    target: e.target,
    targetHandle: e.targetHandle,
  }));
  return { nodes, edges };
}

function flowToGraph(nodes, edges) {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.data.nodeType, props: n.data.props, position: n.position })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "out",
      target: e.target,
      targetHandle: e.targetHandle,
    })),
  };
}

/** One param row; every editor is `nodrag` so tweaking doesn't move the node. */
function ParamField({ param, value, onChange }) {
  const v = value ?? param.default;
  switch (param.type) {
    case "number":
      return (
        <input
          className="number-field nodrag"
          type="number"
          step={param.step ?? 0.1}
          min={param.min}
          max={param.max}
          value={v}
          onChange={(e) => {
            const parsed = parseFloat(e.target.value);
            if (!Number.isNaN(parsed)) onChange(parsed);
          }}
        />
      );
    case "vec3":
      return (
        <div className="vec3-mini nodrag">
          {[0, 1, 2].map((i) => (
            <input
              key={i}
              className="number-field"
              type="number"
              step={0.1}
              value={v?.[i] ?? 0}
              onChange={(e) => {
                const parsed = parseFloat(e.target.value);
                if (Number.isNaN(parsed)) return;
                const next = [...(v ?? [0, 0, 0])];
                next[i] = parsed;
                onChange(next);
              }}
            />
          ))}
        </div>
      );
    case "color":
      return (
        <input className="color-field nodrag" type="color" value={v} onChange={(e) => onChange(e.target.value)} />
      );
    case "boolean":
      return <input className="nodrag" type="checkbox" checked={!!v} onChange={(e) => onChange(e.target.checked)} />;
    case "select":
      return (
        <select className="select-field nodrag" value={v} onChange={(e) => onChange(e.target.value)}>
          {param.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case "asset":
      return (
        <div className="nodrag nopan particle-asset">
          <AssetField descriptor={{ exts: param.exts }} value={v} onCommit={onChange} />
        </div>
      );
    default:
      return null;
  }
}

function ParticleNode({ id, data, selected }) {
  const meta = P_NODE_TYPES[data.nodeType];
  if (!meta) return null;
  const category = meta.category === "system" ? "output" : meta.category;

  return (
    <div className={`shader-node particle-node cat-${category} ${selected ? "selected" : ""}`}>
      <div className="shader-node-header">
        <span className="shader-node-dot" />
        <span className="shader-node-label">{meta.label}</span>
      </div>
      <div className="shader-node-body">
        {meta.inputs.map((input) => (
          <div className="shader-node-row" key={input.key}>
            <Handle type="target" position={Position.Left} id={input.key} className="shader-handle" />
            <span className="shader-port-label">{input.label}</span>
          </div>
        ))}
        {meta.params.map((param) => (
          <div className="shader-node-row field" key={param.key}>
            <span className="shader-port-label param-label">{param.label}</span>
            <ParamField
              param={param}
              value={data.props[param.key]}
              onChange={(value) => data.onPropsChange(id, { [param.key]: value })}
            />
          </div>
        ))}
        {meta.outputs.map((output) => (
          <div className="shader-node-row out-row" key={output.key}>
            <span className="shader-port-label">{output.label}</span>
            <Handle type="source" position={Position.Right} id={output.key} className="shader-handle" />
          </div>
        ))}
      </div>
    </div>
  );
}

const nodeTypes = { particleNode: ParticleNode };

function NodePalette({ style, onPick, onClose }) {
  return (
    <>
      <div className="dropdown-overlay" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className={`dropdown-menu node-palette ${style ? "context-menu" : ""}`} style={style}>
        {PALETTE.map(({ group, types }) => (
          <div key={group}>
            <div className="node-palette-group">{group}</div>
            {types.map((type) => (
              <button key={type} className="dropdown-item node-palette-item" onClick={() => onPick(type)}>
                <span className={`shader-node-dot cat-${P_NODE_TYPES[type].category}`} />
                {P_NODE_TYPES[type].label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function ParticleGraphEditor({ entityId, initialGraph }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [dirty, setDirty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [canvasMenu, setCanvasMenu] = useState(null);
  const { screenToFlowPosition } = useReactFlow();

  const loadGraph = useCallback(
    (graph) => {
      const flow = graphToFlow(graph);
      setNodes(flow.nodes);
      setEdges(flow.edges);
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    loadGraph(initialGraph);
    setDirty(false);
  }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePropsChange = useCallback(
    (nodeId, patch) => {
      setDirty(true);
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, props: { ...n.data.props, ...patch } } } : n)),
      );
    },
    [setNodes],
  );

  const nodesWithHandlers = useMemo(
    () => nodes.map((n) => ({ ...n, data: { ...n.data, onPropsChange: handlePropsChange } })),
    [nodes, handlePropsChange],
  );

  const onConnect = useCallback(
    (connection) => {
      setDirty(true);
      // Only one wire per input handle.
      setEdges((eds) =>
        addEdge(
          connection,
          eds.filter((e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle)),
        ),
      );
    },
    [setEdges],
  );

  const guardedNodesChange = useCallback(
    (changes) => {
      const guarded = changes.filter(
        (c) => !(c.type === "remove" && nodes.find((n) => n.id === c.id)?.data.nodeType === "system"),
      );
      if (guarded.some((c) => c.type !== "select" && c.type !== "dimensions")) setDirty(true);
      onNodesChange(guarded);
    },
    [nodes, onNodesChange],
  );

  const addNode = (type, screenPos) => {
    setMenuOpen(false);
    setCanvasMenu(null);
    setDirty(true);
    const position = screenPos
      ? screenToFlowPosition(screenPos)
      : { x: 60 + Math.random() * 160, y: 60 + Math.random() * 160 };
    const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    setNodes((nds) => [
      ...nds,
      { id, type: "particleNode", position, data: { nodeType: type, props: nodeDefaults(type) } },
    ]);
  };

  const apply = async () => {
    const graph = flowToGraph(nodes, edges);
    try {
      await compileParticleGraph(graph); // validate before committing
    } catch (err) {
      console.error(`Particle graph error: ${err.message ?? err}`);
      return;
    }
    commandBus.execute(new SetComponentPropCommand(entityId, "particles", "graph", graph));
    setDirty(false);
  };

  const restart = () => {
    engine.getEntity(entityId)?.getComponent("particles")?.restart();
  };

  return (
    <div className="shader-graph-panel">
      <div className="panel-toolbar">
        <div className="dropdown-wrap">
          <button className="toolbar-btn" onClick={() => setMenuOpen((v) => !v)}>
            <Plus size={14} />
            Node
          </button>
          {menuOpen && <NodePalette onPick={(type) => addNode(type)} onClose={() => setMenuOpen(false)} />}
        </div>
        <div className="dropdown-wrap">
          <button className="toolbar-btn" onClick={() => setPresetOpen((v) => !v)}>
            <Sparkles size={13} />
            Presets
          </button>
          {presetOpen && (
            <>
              <div className="dropdown-overlay" onClick={() => setPresetOpen(false)} />
              <div className="dropdown-menu">
                {Object.keys(PARTICLE_PRESETS).map((name) => (
                  <button
                    key={name}
                    className="dropdown-item"
                    onClick={() => {
                      setPresetOpen(false);
                      loadGraph(PARTICLE_PRESETS[name]);
                      setDirty(true);
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button className="toolbar-btn icon-only" title="Restart simulation" onClick={restart}>
          <RotateCcw size={14} />
        </button>
        <button className="toolbar-btn" disabled={!dirty} onClick={apply}>
          <Check size={13} />
          Apply{dirty ? " •" : ""}
        </button>
      </div>
      <div className="shader-graph-canvas">
        <ReactFlow
          nodes={nodesWithHandlers}
          edges={edges}
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
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.15}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {canvasMenu && (
          <NodePalette
            style={{ left: canvasMenu.x, top: canvasMenu.y }}
            onPick={(type) => addNode(type, canvasMenu)}
            onClose={() => setCanvasMenu(null)}
          />
        )}
      </div>
      <div className="shader-graph-hint">
        Wire emitters/forces into the Particle System node · right-click canvas to add nodes · Apply rebuilds the
        effect · Restart re-seeds
      </div>
    </div>
  );
}

export function ParticlesPanel() {
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const entity = useSceneStore((s) => (selectedId ? s.entities[selectedId] : null));
  const graph = entity?.components?.particles?.graph;
  const hasParticles = !!entity?.components?.particles;

  if (!entity) {
    return <div className="shader-graph-panel empty">Select an entity to edit its particle system.</div>;
  }

  if (!hasParticles) {
    return (
      <div className="shader-graph-panel empty">
        <div>
          <div style={{ marginBottom: 10 }}>“{entity.name}” has no Particles component.</div>
          <button
            className="toolbar-btn"
            onClick={() => commandBus.execute(new AddComponentCommand(entity.id, "particles"))}
          >
            Add Particles Component
          </button>
        </div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <ParticleGraphEditor
        key={entity.id}
        entityId={entity.id}
        initialGraph={graph ?? DEFAULT_PARTICLE_GRAPH}
      />
    </ReactFlowProvider>
  );
}
