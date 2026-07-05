import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Check, Zap } from "lucide-react";
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
import { NODE_TYPES, inputSpec } from "../../engine/shaderGraph.js";
import { MATERIAL_DEFAULTS, getMaterialDef, updateMaterialAsset } from "../../engine/materialAsset.js";
import { AssetField } from "../fields/AssetField.jsx";
import { TEXTURE_EXTENSIONS } from "../assetLoader.js";

/** Fresh materials open with a Principled BSDF pre-wired to the Output. */
const DEFAULT_GRAPH = {
  nodes: [
    { id: "principled", type: "principledBsdf", props: { ...NODE_TYPES.principledBsdf.defaults }, position: { x: 200, y: 120 } },
    { id: "output", type: "output", props: {}, position: { x: 600, y: 200 } },
  ],
  edges: [{ source: "principled", sourceHandle: "surface", target: "output", targetHandle: "surface" }],
};

/** Per-type category for the editor's color coding. Mirrors NODE_TYPES entries. */
const NODE_CATEGORY = {
  color: "value",
  float: "value",
  uv: "coords",
  time: "coords",
  texture: "texture",
  add: "math",
  subtract: "math",
  multiply: "math",
  divide: "math",
  lerp: "math",
  principledBsdf: "bsdf",
  glassBsdf: "bsdf",
  diffuseBsdf: "bsdf",
  emission: "bsdf",
  output: "output",
};

/** Connections that v1 rejects. Anything else is allowed (with a console hint). */
function isIllegalConnection(srcType, srcHandle, tgtType, tgtHandle) {
  // Two shader (BSDF) nodes cannot chain into each other's input handles —
  // the lighting model expects a color/float there. Mixing shaders in v1 is
  // out of scope; Mix Shader / Add Shader will come later.
  if (NODE_TYPES[srcType]?.isShader && NODE_TYPES[tgtType]?.isShader) return true;
  // A shader node's `surface` output can only feed the Output's `surface` input.
  if (NODE_TYPES[srcType]?.isShader && srcHandle === "surface") return !(tgtType === "output" && tgtHandle === "surface");
  return false;
}

const PALETTE = [
  { group: "Shaders", types: ["principledBsdf", "glassBsdf", "diffuseBsdf", "emission"] },
  { group: "Values", types: ["color", "float"] },
  { group: "Coordinates", types: ["uv", "time"] },
  { group: "Texture", types: ["texture"] },
  { group: "Math", types: ["add", "subtract", "multiply", "divide", "lerp"] },
];

function graphToFlow(graph) {
  const nodes = graph.nodes.map((n) => ({
    id: n.id,
    type: "shaderNode",
    position: n.position ?? { x: 0, y: 0 },
    data: { nodeType: n.type, props: n.props ?? {} },
  }));
  const edges = (graph.edges ?? []).map((e, i) => ({
    id: e.id ?? `e${i}-${e.source}-${e.target}-${e.targetHandle}`,
    source: e.source,
    sourceHandle: e.sourceHandle ?? "out",
    target: e.target,
    targetHandle: e.targetHandle,
  }));
  return { nodes, edges };
}

function flowToGraph(nodes, edges) {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.nodeType,
      props: n.data.props,
      position: n.position,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "out",
      target: e.target,
      targetHandle: e.targetHandle,
    })),
  };
}

/** Per-prop editor for non-port props. Shader node props are scalar/color
 *  defaults used when the corresponding input port isn't wired.
 */
function ColorField({ value, onChange }) {
  return (
    <div className="shader-node-row field nodrag">
      <input
        className="color-field"
        type="color"
        value={value ?? "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="shader-field-value">{value ?? "#ffffff"}</span>
    </div>
  );
}

function FloatField({ value, min, max, step, onChange }) {
  return (
    <div className="shader-node-row field nodrag">
      <input
        className="slider-field"
        type="range"
        min={min ?? 0}
        max={max ?? 1}
        step={step ?? 0.01}
        value={value ?? 0}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <input
        className="number-field slider-readout"
        type="number"
        min={min}
        max={max}
        step={step ?? 0.01}
        value={value ?? 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
}

/** Inline editors on value/texture nodes. `nodrag` keeps typing from moving the node. */
function NodeField({ nodeType, props, onChange }) {
  if (nodeType === "color") return <ColorField value={props.value} onChange={(v) => onChange({ value: v })} />;
  if (nodeType === "float") {
    return (
      <div className="shader-node-row field nodrag">
        <input
          className="number-field"
          type="number"
          step={0.1}
          value={props.value ?? 0}
          onChange={(e) => onChange({ value: parseFloat(e.target.value) || 0 })}
        />
      </div>
    );
  }
  if (nodeType === "texture") {
    return (
      <div className="shader-node-row field nodrag nopan">
        <AssetField
          descriptor={{ exts: TEXTURE_EXTENSIONS }}
          value={props.path ?? ""}
          onCommit={(path) => onChange({ path })}
        />
      </div>
    );
  }
  return null;
}

/** Inline editor for a single shader-node input row. `wired` means an edge
 *  is feeding this handle — in that case the editor is disabled and the value
 *  comes from the upstream node.
 */
function InputEditor({ spec, value, wired, onChange }) {
  if (!spec.kind) return null;
  if (spec.kind === "color") {
    return (
      <input
        className="color-field shader-input-editor nodrag nopan"
        type="color"
        disabled={wired}
        value={value ?? spec.default}
        onChange={(e) => onChange(e.target.value)}
        title={wired ? "Driven by connected node" : spec.name}
      />
    );
  }
  // float
  return (
    <div className="shader-input-editor slider-wrap nodrag nopan">
      <input
        className="slider-field"
        type="range"
        disabled={wired}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value ?? spec.default}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        title={wired ? "Driven by connected node" : `${spec.name} (${spec.min}..${spec.max})`}
      />
      <input
        className="number-field slider-readout"
        type="number"
        disabled={wired}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value ?? spec.default}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
}

function ShaderNode({ id, data, selected }) {
  const meta = NODE_TYPES[data.nodeType] ?? { label: data.nodeType, inputs: [] };
  const category = NODE_CATEGORY[data.nodeType] ?? "math";
  const isShader = !!meta.isShader;
  const isOutput = data.nodeType === "output";
  // Shader nodes expose a single `surface` source handle; output has no output handle.
  const sourceHandle = isShader ? "surface" : "out";
  const wiredSet = data.connectedHandles;
  const showStandaloneEditor = !isShader && !isOutput && ["color", "float", "texture"].includes(data.nodeType);
  const hasBody = meta.inputs.length > 0 || showStandaloneEditor;

  return (
    <div className={`shader-node cat-${category} ${selected ? "selected" : ""}`}>
      <div className="shader-node-header">
        <span className="shader-node-dot" />
        <span className="shader-node-label">{meta.label}</span>
        {!isOutput && (
          <Handle type="source" position={Position.Right} id={sourceHandle} className="shader-handle" />
        )}
      </div>
      {hasBody && (
        <div className="shader-node-body">
          {meta.inputs.map((input) => {
            const spec = inputSpec(data.nodeType, input);
            const wired = wiredSet?.has(spec.name) ?? false;
            return (
              <div className="shader-node-row" key={spec.name} data-wired={wired || undefined}>
                <Handle type="target" position={Position.Left} id={spec.name} className="shader-handle" />
                <span className="shader-port-label">{spec.name}</span>
                <InputEditor
                  spec={spec}
                  value={data.props[spec.name]}
                  wired={wired}
                  onChange={(v) => data.onPropsChange(id, { [spec.name]: v })}
                />
              </div>
            );
          })}
          {showStandaloneEditor && (
            <NodeField
              nodeType={data.nodeType}
              props={data.props}
              onChange={(patch) => data.onPropsChange(id, patch)}
            />
          )}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { shaderNode: ShaderNode };

/** Grouped node palette, shared by the toolbar button and canvas right-click. */
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
                <span className={`shader-node-dot cat-${NODE_CATEGORY[type]}`} />
                {NODE_TYPES[type].label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function ShaderGraphEditor({ matPath }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [dirty, setDirty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [canvasMenu, setCanvasMenu] = useState(null); // {x, y} — right-click position
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem("engine.autosave.shader") === "1";
    } catch {
      return false;
    }
  });
  const toggleAutosave = () => {
    setAutosave((cur) => {
      const next = !cur;
      try {
        localStorage.setItem("engine.autosave.shader", next ? "1" : "0");
      } catch {}
      return next;
    });
  };
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    let live = true;
    (async () => {
      let graph = DEFAULT_GRAPH;
      if (matPath) {
        let def = getMaterialDef(matPath);
        if (!def) {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            def = JSON.parse(await invoke("read_text_file", { path: matPath }));
          } catch {}
        }
        graph = def?.shaderGraph ?? DEFAULT_GRAPH;
      }
      if (!live) return;
      const flow = graphToFlow(graph);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setDirty(false);
    })();
    return () => (live = false);
  }, [matPath]); // eslint-disable-line react-hooks/exhaustive-deps

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
    () =>
      nodes.map((n) => {
        // Set of target handles on this node that already have an incoming edge.
        // Drives the disabled state of the per-row inline editor.
        const connectedHandles = new Set(edges.filter((e) => e.target === n.id).map((e) => e.targetHandle));
        return { ...n, data: { ...n.data, onPropsChange: handlePropsChange, connectedHandles } };
      }),
    [nodes, edges, handlePropsChange],
  );

  const onConnect = useCallback(
    (connection) => {
      // Look up the source/target node types and reject clearly-bad wires.
      const src = nodes.find((n) => n.id === connection.source);
      const tgt = nodes.find((n) => n.id === connection.target);
      const srcHandle = connection.sourceHandle ?? "out";
      const tgtHandle = connection.targetHandle;
      if (!src || !tgt) return;
      if (isIllegalConnection(src.data.nodeType, srcHandle, tgt.data.nodeType, tgtHandle)) {
        console.warn(
          `Shader graph: illegal connection (${src.data.nodeType}.${srcHandle} → ${tgt.data.nodeType}.${tgtHandle})`,
        );
        return;
      }
      setDirty(true);
      // Only one wire per input handle.
      setEdges((eds) =>
        addEdge(
          connection,
          eds.filter((e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle)),
        ),
      );
    },
    [setEdges, nodes],
  );

  /** The output node is the graph's anchor — never let Delete remove it. */
  const guardedNodesChange = useCallback(
    (changes) => {
      const guarded = changes.filter(
        (c) => !(c.type === "remove" && nodes.find((n) => n.id === c.id)?.data.nodeType === "output"),
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
      : { x: 80 + Math.random() * 200, y: 80 + Math.random() * 200 };
    const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    setNodes((nds) => [
      ...nds,
      { id, type: "shaderNode", position, data: { nodeType: type, props: { ...NODE_TYPES[type].defaults } } },
    ]);
  };

  const apply = async () => {
    if (!matPath) return;
    const graph = flowToGraph(nodes, edges);
    const def = { ...MATERIAL_DEFAULTS, ...(getMaterialDef(matPath) ?? {}), shaderGraph: graph };
    updateMaterialAsset(matPath, def); // live on the shared material
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_scene", { path: matPath, contents: JSON.stringify(def, null, 2) });
    setDirty(false);
    console.log(`Shader graph applied: ${matPath}`);
  };

  // Autosave: when enabled, commit every change. Debounced so transient
  // mutations (e.g. dragging a node, which fires onNodesChange on every
  // intermediate position) collapse into a single write at the end of the
  // gesture. Selection-only updates and the initial load keep `dirty` false
  // and never reach the timer.
  useEffect(() => {
    if (!autosave) return;
    if (!dirty) return;
    const id = setTimeout(apply, 150);
    return () => clearTimeout(id);
  }, [autosave, nodes, edges, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <span className="asset-path" title={matPath}>
          {matPath.split(/[\\/]/).pop()}
        </span>
        <button
          className={`toolbar-btn icon-only${autosave ? " active" : ""}`}
          title={autosave ? "Autosave on — changes apply instantly" : "Autosave off — click Apply to commit"}
          onClick={toggleAutosave}
        >
          <Zap size={14} />
        </button>
        <button className="toolbar-btn" disabled={!dirty || autosave} onClick={apply}>
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
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
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
        Right-click canvas to add a node · drag between ports to wire · Delete removes selection · Apply saves to the
        material
      </div>
    </div>
  );
}

export function ShaderGraphPanel() {
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const assetPath = useSelectionStore((s) => s.assetPath);
  const entity = useSceneStore((s) => (selectedId ? s.entities[selectedId] : null));
  // Graphs live on the material asset: selected .mat directly, or the selected mesh's.
  const matPath =
    assetPath?.toLowerCase().endsWith(".mat") ? assetPath : entity?.components?.mesh?.material || null;

  if (!matPath) {
    return (
      <div className="shader-graph-panel empty">
        Select a .mat asset (or an entity whose Mesh has one assigned) to edit its shader graph.
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <ShaderGraphEditor matPath={matPath} />
    </ReactFlowProvider>
  );
}