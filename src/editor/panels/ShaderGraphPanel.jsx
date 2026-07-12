import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Eye, Code, Box } from "lucide-react";
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
import * as THREE from "three/webgpu";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import {
  NODE_TYPES,
  CATEGORY_LABELS,
  nodeDefaults,
  compileShaderGraph,
  migrateGraph,
  generateTslCode,
  setUniformValue,
} from "../../engine/tslGraph.js";
import { migrateLegacyGraph } from "../../engine/shaderGraph.js";
import { MATERIAL_DEFAULTS, getMaterialDef, loadMaterialAsset, updateMaterialAsset, syncMaterialRenderState, applyGraphMutations } from "../../engine/materialAsset.js";
import { renderNodeThumb } from "../nodegraph/nodePreview.js";
import { setGraphHovered } from "../nodegraph/graphContext.js";
import { AssetField } from "../fields/AssetField.jsx";
import { TEXTURE_EXTENSIONS } from "../assetLoader.js";

/** Fresh materials: a Principled BSDF wired into the Output's Surface socket
 *  (Blender-style — the BSDF carries Color/Roughness/… and drives the surface). */
const DEFAULT_GRAPH = {
  nodes: [
    { id: "bsdf", type: "principledBsdf", props: {}, position: { x: 200, y: 120 } },
    { id: "output", type: "output", props: {}, position: { x: 560, y: 150 } },
  ],
  edges: [{ source: "bsdf", sourceHandle: "out", target: "output", targetHandle: "surface" }],
};

const catOf = (type) => NODE_TYPES[type]?.cat ?? "math";

function graphToFlow(graph) {
  return {
    nodes: graph.nodes
      .filter((n) => NODE_TYPES[n.type])
      .map((n) => ({
        id: n.id,
        type: "tslNode",
        position: n.position ?? { x: 0, y: 0 },
        data: { nodeType: n.type, props: n.props ?? {} },
      })),
    edges: (graph.edges ?? []).map((e, i) => ({
      id: e.id ?? `e${i}-${e.source}-${e.target}-${e.targetHandle}`,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "out",
      target: e.target,
      targetHandle: e.targetHandle,
    })),
  };
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

/** Inline editor for an unwired input default / a node param. */
function ValueEditor({ value, kind, onChange }) {
  if (kind === "color") {
    return (
      <input
        className="color-field shader-input-editor nodrag nopan"
        type="color"
        value={value ?? "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className="number-field shader-input-editor nodrag nopan"
      type="number"
      step={0.05}
      value={value ?? 0}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
    />
  );
}

function TslNode({ id, data, selected }) {
  const def = NODE_TYPES[data.nodeType] ?? { label: data.nodeType, inputs: [] };
  const isOutput = data.nodeType === "output";
  const outputs = def.outputs ?? (isOutput ? [] : ["out"]);
  const wiredSet = data.connectedHandles;
  const thumb = !!data.props.__thumb;

  return (
    <div className={`shader-node cat-${def.cat} ${selected ? "selected" : ""}`}>
      <div className="shader-node-header">
        <span className="shader-node-dot" />
        <span className="shader-node-label">{def.label}</span>
        {!isOutput && (
          <button
            className={`node-thumb-toggle nodrag${thumb ? " active" : ""}`}
            title="Toggle preview"
            onClick={() => data.onPropsChange(id, { __thumb: !thumb }, true)}
          >
            <Eye size={11} />
          </button>
        )}
        {outputs.length === 1 && <Handle type="source" position={Position.Right} id={outputs[0]} className={`shader-handle pt-${def.out ?? "any"}`} />}
      </div>
      {thumb && (
        <div className="node-thumb nodrag">
          <canvas width={96} height={96} ref={(el) => data.registerThumb(id, el)} />
        </div>
      )}
      <div className="shader-node-body">
        {outputs.length > 1 &&
          outputs.map((o) => (
            <div className="shader-node-row out-row" key={`out-${o}`}>
              <span className="shader-port-label out">{o}</span>
              <Handle type="source" position={Position.Right} id={o} className={`shader-handle pt-${def.out ?? "any"}`} />
            </div>
          ))}
        {(def.inputs ?? []).map((spec) => {
          const wired = wiredSet?.has(spec.key) ?? false;
          const editable = spec.default != null && !Array.isArray(spec.default);
          return (
            <div className="shader-node-row" key={spec.key} data-wired={wired || undefined}>
              <Handle type="target" position={Position.Left} id={spec.key} className={`shader-handle pt-${spec.type}`} />
              <span className="shader-port-label">{spec.key}</span>
              {editable && !wired && (
                <ValueEditor
                  kind={typeof spec.default === "string" ? "color" : "number"}
                  value={data.props[spec.key] ?? spec.default}
                  onChange={(v) => data.onPropsChange(id, { [spec.key]: v })}
                />
              )}
            </div>
          );
        })}
        {(def.params ?? []).map((p) => (
          <div className={`shader-node-row field nodrag${p.type === "code" ? " code-field" : ""}`} key={p.key}>
            {p.type === "asset" ? (
              <div className="nodrag nopan" style={{ flex: 1 }}>
                <AssetField
                  descriptor={{ exts: TEXTURE_EXTENSIONS }}
                  value={data.props[p.key] ?? ""}
                  onCommit={(path) => data.onPropsChange(id, { [p.key]: path }, true)}
                />
              </div>
            ) : p.type === "code" ? (
              <textarea
                className="code-field-input nodrag nopan"
                spellCheck={false}
                rows={4}
                placeholder="a.mul(b)"
                value={data.props[p.key] ?? p.default ?? ""}
                onChange={(e) => data.onPropsChange(id, { [p.key]: e.target.value })}
                onBlur={(e) => data.onPropsChange(id, { [p.key]: e.target.value }, true)}
              />
            ) : (
              <ValueEditor
                kind={p.type === "color" ? "color" : "number"}
                value={data.props[p.key] ?? p.default}
                onChange={(v) => data.onPropsChange(id, { [p.key]: v })}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const nodeTypes = { tslNode: TslNode };

/** Fuzzy-searchable node palette (toolbar button + canvas right-click). */
function NodeSearchPalette({ style, onPick, onClose }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = Object.entries(NODE_TYPES).filter(([t]) => t !== "output");
    const hits = q
      ? all.filter(([t, d]) => d.label.toLowerCase().includes(q) || t.toLowerCase().includes(q) || d.cat.includes(q))
      : all;
    // group by category, preserving registry order
    const groups = [];
    for (const [type, d] of hits) {
      let g = groups.find((x) => x.cat === d.cat);
      if (!g) groups.push((g = { cat: d.cat, items: [] }));
      g.items.push(type);
    }
    return groups;
  }, [query]);
  const flat = entries.flatMap((g) => g.items);

  return (
    <>
      <div className="dropdown-overlay" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className={`dropdown-menu node-palette ${style ? "context-menu" : ""}`} style={style}>
        <input
          className="node-palette-search"
          autoFocus
          placeholder="Search nodes…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && flat[active]) onPick(flat[active]);
            else if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, flat.length - 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Escape") onClose();
          }}
        />
        <div className="node-palette-list">
          {entries.map(({ cat, items }) => (
            <div key={cat}>
              <div className="node-palette-group">{CATEGORY_LABELS[cat] ?? cat}</div>
              {items.map((type) => (
                <button
                  key={type}
                  className={`dropdown-item node-palette-item${flat[active] === type ? " active" : ""}`}
                  onMouseEnter={() => setActive(flat.indexOf(type))}
                  onClick={() => onPick(type)}
                >
                  <span className={`shader-node-dot cat-${cat}`} />
                  {NODE_TYPES[type].label}
                </button>
              ))}
            </div>
          ))}
          {!flat.length && <div className="node-palette-group">No matches</div>}
        </div>
      </div>
    </>
  );
}

const PREVIEW_GEOMS = {
  sphere: () => new THREE.SphereGeometry(0.85, 48, 24),
  box: () => new THREE.BoxGeometry(1.15, 1.15, 1.15),
  torus: () => new THREE.TorusKnotGeometry(0.6, 0.22, 128, 24),
  // Rotated flat so the turntable spin (around Y) never presents the
  // geometry's backface to the camera — a plane spinning in its own plane
  // would go edge-on/invisible for half of every rotation otherwise.
  plane: () => new THREE.PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2),
};

/** Corner live preview: its own WebGPURenderer + turntable, rendering the
 *  SHARED .mat material (so it always matches the scene). Pattern copied
 *  from AssetInspector's ModelPreview. */
function MaterialPreview({ material }) {
  const canvasRef = useRef(null);
  const [prim, setPrim] = useState("sphere");
  const meshRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !material) return;
    let disposed = false;
    let renderer;
    let resizeObserver;
    (async () => {
      renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      const resize = () => {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (width < 1 || height < 1) return false;
        renderer.setSize(width, height, false);
        return true;
      };
      // Never initialize a WebGPU swapchain from a hidden dock tab's 0x0 box.
      if (!resize()) renderer.setSize(canvas.width || 220, canvas.height || 170, false);
      await renderer.init();
      if (disposed) return void renderer.dispose();
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas);
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.5));
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(2, 3, 2);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x88aaff, 0.8);
      rim.position.set(-2, -1, -2);
      scene.add(rim);
      const camera = new THREE.PerspectiveCamera(40, canvas.clientWidth / canvas.clientHeight, 0.1, 20);
      camera.position.set(0, 0.4, 3);
      camera.lookAt(0, 0, 0);
      const mesh = new THREE.Mesh(PREVIEW_GEOMS.sphere(), material);
      meshRef.current = mesh;
      scene.add(mesh);
      const timer = new THREE.Timer();
      renderer.setAnimationLoop(() => {
        if (disposed || !canvas.isConnected || canvas.clientWidth < 1 || canvas.clientHeight < 1) return;
        timer.update();
        mesh.rotation.y += timer.getDelta() * 0.5;
        renderer.render(scene, camera);
      });
    })();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (renderer) {
        renderer.setAnimationLoop(null);
        renderer.dispose();
      }
    };
  }, [material]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.geometry.dispose();
    mesh.geometry = PREVIEW_GEOMS[prim]();
  }, [prim]);

  // A volume raymarches inside a unit box — preview it on the box so the
  // bounds match what the scene mesh uses.
  useEffect(() => {
    if (material?.userData?.isVolumeMaterial) setPrim("box");
  }, [material]);

  return (
    <div className="shader-preview">
      <canvas ref={canvasRef} width={220} height={170} />
      <div className="shader-preview-prims">
        {Object.keys(PREVIEW_GEOMS).map((p) => (
          <button key={p} className={`shader-preview-prim${prim === p ? " active" : ""}`} title={p} onClick={() => setPrim(p)}>
            <Box size={11} />
          </button>
        ))}
      </div>
    </div>
  );
}

function ShaderGraphEditor({ matPath }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [canvasMenu, setCanvasMenu] = useState(null);
  const [saved, setSaved] = useState(true);
  const [material, setMaterial] = useState(null);
  const { screenToFlowPosition } = useReactFlow();

  // Guard against a stale hover flag if the panel closes/unmounts while the
  // pointer is still over it (dockview close, tab switch, …).
  useEffect(() => () => setGraphHovered(false), []);

  const compileRef = useRef({ uniforms: {}, generation: 0 });
  const thumbCanvases = useRef(new Map());
  const [structural, setStructural] = useState(0);
  const loadedRef = useRef(false);

  // Load graph + shared material.
  useEffect(() => {
    let live = true;
    loadedRef.current = false;
    (async () => {
      const mat = await loadMaterialAsset(matPath);
      let def = getMaterialDef(matPath);
      if (!def) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          def = JSON.parse(await invoke("read_text_file", { path: matPath }));
        } catch {}
      }
      if (!live) return;
      const graph = def?.shaderGraph
        ? migrateGraph(migrateLegacyGraph(def.shaderGraph, def))
        : DEFAULT_GRAPH;
      const flow = graphToFlow(graph);
      setMaterial(mat);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setSaved(true);
      loadedRef.current = true;
      setStructural((s) => s + 1);
    })();
    return () => (live = false);
  }, [matPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const registerThumb = useCallback((id, el) => {
    if (el) thumbCanvases.current.set(id, el);
    else thumbCanvases.current.delete(id);
  }, []);

  /** Value edits patch the live uniform when possible (no shader rebuild);
   *  structural edits (wires, params like texture path, thumb toggles that
   *  need a tap) schedule a recompile. */
  const handlePropsChange = useCallback(
    (nodeId, patch, forceStructural = false) => {
      setSaved(false);
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, props: { ...n.data.props, ...patch } } } : n)),
      );
      let structuralHit = forceStructural;
      for (const [key, value] of Object.entries(patch)) {
        if (key === "__thumb") continue;
        const u = compileRef.current.uniforms[`${nodeId}.${key}`];
        if (u) setUniformValue(u, value);
        else structuralHit = true;
      }
      if (structuralHit || patch.__thumb) setStructural((s) => s + 1);
    },
    [setNodes],
  );

  const nodesWithHandlers = useMemo(
    () =>
      nodes.map((n) => {
        const connectedHandles = new Set(edges.filter((e) => e.target === n.id).map((e) => e.targetHandle));
        return { ...n, data: { ...n.data, onPropsChange: handlePropsChange, connectedHandles, registerThumb } };
      }),
    [nodes, edges, handlePropsChange, registerThumb],
  );

  // Recompile (debounced): apply to the shared material, refresh uniforms,
  // render thumbnails for tapped nodes.
  useEffect(() => {
    if (!loadedRef.current || !material) return;
    const timer = setTimeout(async () => {
      const graph = flowToGraph(nodes, edges);
      const taps = nodes.filter((n) => n.data.props.__thumb).map((n) => n.id);
      const generation = ++compileRef.current.generation;
      try {
        const result = await compileShaderGraph(graph, { taps });
        if (generation !== compileRef.current.generation) return;
        // Wiring (or unwiring) the Output's Volume socket changes the material
        // class (MeshPhysicalNodeMaterial ↔ the unlit volume MeshBasicNodeMaterial).
        // A class swap can't be done in place — route it through the asset layer
        // so the cached shared instance is replaced and recompiled, then adopt
        // the new instance for the preview.
        const wantVolume = !!result?.isVolume;
        if (wantVolume !== (material.userData?.isVolumeMaterial === true)) {
          const def = { ...MATERIAL_DEFAULTS, ...(getMaterialDef(matPath) ?? {}), shaderGraph: graph };
          updateMaterialAsset(matPath, def);
          const swapped = await loadMaterialAsset(matPath);
          if (generation !== compileRef.current.generation) return;
          compileRef.current.uniforms = {};
          setMaterial(swapped); // re-runs this effect against the new class
          return;
        }
        // Volume materials wire scatteringNode/emissive/steps, surface ones map
        // onto *Node slots — the asset layer owns that logic so both paths agree.
        applyGraphMutations(material, result, wantVolume);
        // In-place edit (no class change): refresh renderable state so scene
        // meshes hide when nothing is wired to Surface/Volume, show otherwise.
        syncMaterialRenderState(matPath, graph);
        compileRef.current.uniforms = result?.uniforms ?? {};
        for (const id of taps) {
          const canvas = thumbCanvases.current.get(id);
          // Shader nodes (BSDF/Emission) yield a surface bundle, not a TSL
          // value — skip their thumbnail (nothing single to preview).
          const tap = result?.taps?.[id];
          if (canvas && tap && !tap.__surface) renderNodeThumb(tap, canvas);
        }
      } catch (err) {
        console.error(`Shader graph compile: ${err.message}`);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [structural, material]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave the .mat (debounced) — keeps the materialAsset cache def in sync
  // without a second compile.
  useEffect(() => {
    if (saved || !loadedRef.current) return;
    const timer = setTimeout(async () => {
      const graph = flowToGraph(nodes, edges);
      const def = { ...MATERIAL_DEFAULTS, ...(getMaterialDef(matPath) ?? {}), shaderGraph: graph };
      const cached = getMaterialDef(matPath);
      if (cached) cached.shaderGraph = graph;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_scene", { path: matPath, contents: JSON.stringify(def, null, 2) });
        setSaved(true);
      } catch (err) {
        console.error(`Shader graph save: ${err.message}`);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [saved, nodes, edges, matPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const onConnect = useCallback(
    (connection) => {
      setSaved(false);
      setEdges((eds) =>
        addEdge(
          connection,
          eds.filter((e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle)),
        ),
      );
      setStructural((s) => s + 1);
    },
    [setEdges],
  );

  // Drag an existing edge's end away from a socket to reconnect it, or drop
  // it on empty canvas to disconnect. `reconnectSuccessful` distinguishes a
  // completed reconnect (handled in onReconnect) from a drop-to-delete.
  const reconnectSuccessful = useRef(true);
  const onReconnectStart = useCallback(() => {
    reconnectSuccessful.current = false;
  }, []);
  const onReconnect = useCallback(
    (oldEdge, connection) => {
      reconnectSuccessful.current = true;
      setSaved(false);
      setEdges((eds) =>
        addEdge(
          connection,
          eds
            .filter((e) => e.id !== oldEdge.id)
            .filter((e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle)),
        ),
      );
      setStructural((s) => s + 1);
    },
    [setEdges],
  );
  const onReconnectEnd = useCallback((_event, edge) => {
    if (!reconnectSuccessful.current) {
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
      setSaved(false);
      setStructural((s) => s + 1);
    }
    reconnectSuccessful.current = true;
  }, []);
  const onEdgeDoubleClick = useCallback((_event, edge) => {
    setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    setSaved(false);
    setStructural((s) => s + 1);
  }, []);

  const guardedNodesChange = useCallback(
    (changes) => {
      const guarded = changes.filter(
        (c) => !(c.type === "remove" && nodes.find((n) => n.id === c.id)?.data.nodeType === "output"),
      );
      if (guarded.some((c) => c.type === "remove")) setStructural((s) => s + 1);
      if (guarded.some((c) => c.type !== "select" && c.type !== "dimensions")) setSaved(false);
      onNodesChange(guarded);
    },
    [nodes, onNodesChange],
  );

  const addNode = (type, screenPos) => {
    setMenuOpen(false);
    setCanvasMenu(null);
    setSaved(false);
    const position = screenPos
      ? screenToFlowPosition(screenPos)
      : { x: 120 + Math.random() * 200, y: 100 + Math.random() * 200 };
    const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    setNodes((nds) => [...nds, { id, type: "tslNode", position, data: { nodeType: type, props: nodeDefaults(type) } }]);
    setStructural((s) => s + 1);
  };

  const copyCode = async () => {
    const code = generateTslCode(flowToGraph(nodes, edges));
    try {
      await navigator.clipboard.writeText(code);
      console.log("TSL code copied to clipboard");
    } catch {
      console.log(code);
    }
  };

  return (
    <div className="shader-graph-panel">
      <div className="panel-toolbar">
        <div className="dropdown-wrap">
          <button className="toolbar-btn" onClick={() => setMenuOpen((v) => !v)}>
            <Plus size={14} />
            Node
          </button>
          {menuOpen && <NodeSearchPalette onPick={(type) => addNode(type)} onClose={() => setMenuOpen(false)} />}
        </div>
        <span className="asset-path" title={matPath}>
          {matPath.split(/[\\/]/).pop()}
        </span>
        <span className={`shader-save-state${saved ? " saved" : ""}`}>{saved ? "Saved" : "Saving…"}</span>
        <button className="toolbar-btn" title="Copy graph as three/tsl JavaScript" onClick={copyCode}>
          <Code size={13} />
          Code
        </button>
      </div>
      <div
        className="shader-graph-canvas"
        onMouseEnter={() => setGraphHovered(true)}
        onMouseLeave={() => setGraphHovered(false)}
      >
        <ReactFlow
          nodes={nodesWithHandlers}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={guardedNodesChange}
          onEdgesChange={(changes) => {
            if (changes.some((c) => c.type === "remove")) {
              setSaved(false);
              setStructural((s) => s + 1);
            }
            onEdgesChange(changes);
          }}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onReconnectStart={onReconnectStart}
          onReconnectEnd={onReconnectEnd}
          onEdgeDoubleClick={onEdgeDoubleClick}
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
        {material && <MaterialPreview material={material} />}
        {canvasMenu && (
          <NodeSearchPalette
            style={{ left: canvasMenu.x, top: canvasMenu.y }}
            onPick={(type) => addNode(type, canvasMenu)}
            onClose={() => setCanvasMenu(null)}
          />
        )}
      </div>
      <div className="shader-graph-hint">
        Right-click to add a node · drag ports to wire · eye icon previews a node · changes autosave
      </div>
    </div>
  );
}

export function ShaderGraphPanel() {
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const assetPath = useSelectionStore((s) => s.assetPath);
  const entity = useSceneStore((s) => (selectedId ? s.entities[selectedId] : null));
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
      <ShaderGraphEditor key={matPath} matPath={matPath} />
    </ReactFlowProvider>
  );
}
