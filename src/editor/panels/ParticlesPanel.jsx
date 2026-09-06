import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, RotateCcw, Sparkles, Zap, Save, FilePlus2 } from "lucide-react";
import { ReactFlowProvider } from "@xyflow/react";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { engine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { AddComponentCommand, SetComponentPropCommand } from "../commands/componentCommands.js";
import {
  P_NODE_TYPES,
  particleInputDescriptor,
  nodeDefaults,
  compileParticleGraph,
  DEFAULT_PARTICLE_GRAPH,
  legacyPropsToGraph,
} from "../../engine/particleGraph.js";
import { PARTICLE_PRESETS } from "../particlePresets.js";
import { GraphEditor } from "../nodegraph/GraphEditor.jsx";
import { stripHelpers } from "../nodegraph/graphUtils.js";

import { getComponentClass } from "../../engine/components/registry.js";
import { setModuleEnabled, useModulesStore } from "../modules.js";

import { AssetField } from "../fields/AssetField.jsx";
import { useProjectStore, basename } from "../store/projectStore.js";
import { createVfxDocument, readVfxDocument, writeVfxDocument } from "../vfxAssets.js";
import { subscribeVfxAsset } from "../../engine/vfx/vfxAsset.js";
import "./VfxGraph.css";

const CATEGORY_LABELS = {
  emitter: "Emitters",
  attribute: "Attributes",
  value: "Values",
  math: "Math",
  noise: "Noise",
  force: "Forces",
  system: "System",
  simulation: "Simulation",
};

/**
 * Adapter from the particle node registry (`P_NODE_TYPES`) to the shape the
 * shared graph toolkit renders. The registry keeps its own vocabulary
 * (`category`, `{key,label,type}` ports, params-only editing) — this is the
 * translation layer, so the compiler never has to care how the editor draws.
 */
function makeRegistry(kind) {
const types = P_NODE_TYPES;
return {
  describe(type) {
    const meta = types[type];
    if (!meta) return null;
    return {
      label: meta.label,
      // The System node is the graph's terminus; it borrows the "output"
      // category colour so it reads like one at a glance.
      cat: meta.category === "system" ? "output" : meta.category,
      inputs: (meta.inputs ?? []).map((input) => particleInputDescriptor(type, input)),
      outputs: (meta.outputs ?? []).map((o) => ({ key: o.key, label: o.label, type: o.type ?? "any" })),
      params: [{ key: "__enabled", label: "Enabled", type: "boolean", default: true }, ...(meta.params ?? [])],
      // Particle values are per-particle GPU state; there is nothing a
      // fullscreen-quad thumbnail could meaningfully show.
      noPreview: true,
    };
  },
  items: Object.entries(types).filter(([type]) => kind === "particles" || type !== "output").map(([type, meta]) => ({
    type,
    label: meta.label,
    cat: meta.category,
    catLabel: CATEGORY_LABELS[meta.category] ?? meta.category,
    inputTypes: (meta.inputs ?? []).map((i) => i.type ?? "any"),
    outputTypes: (meta.outputs ?? []).map((o) => o.type ?? "any"),
  })),
  defaults: nodeDefaults,
  protectedTypes: kind === "particles" ? [] : ["output"],
  /**
   * A graph needs at least one System node to compile. Multiple System nodes
   * (multi-emitter graphs) can be freely added and removed otherwise, so this
   * only ever vetoes the removal that would take the count to zero.
   */
  guardRemove(nodes, removeIds) {
    let systems = nodes.reduce((n, node) => n + (node.data.nodeType === "system" ? 1 : 0), 0);
    const blocked = [];
    for (const id of removeIds) {
      if (nodes.find((n) => n.id === id)?.data.nodeType !== "system") continue;
      if (systems <= 1) blocked.push(id);
      else systems--;
    }
    return blocked;
  },
};
}

function ParticleGraphEditor({ entityId, kind, committedGraph, document, docPath, onOpenDoc }) {
  const initialGraph = useRef(committedGraph).current;
  const registry = useMemo(() => makeRegistry(kind), [kind]);
  const committedRef = useRef(committedGraph);
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const editorRef = useRef(null);
  const graphRef = useRef(initialGraph);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [presetOpen, setPresetOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [fileName, setFileName] = useState("NewEffect.vfx");
  const [saving, setSaving] = useState(false);
  const folder = useProjectStore((state) => state.currentPath);
  const validate = useCallback(async (graph) => {
    if (kind === "particles") await compileParticleGraph(stripHelpers(graph));

  }, [kind]);
  const saveAs = async () => {
    setSaving(true); setError("");
    try {
      const graph = graphRef.current;
      const savingRevision = revisionRef.current;
      await validate(graph);
      if (!mountedRef.current || savingRevision !== revisionRef.current) return;
      const path = await createVfxDocument(fileName, { ...document, version: 1, kind, graph });
      if (!mountedRef.current) return;
      if (savingRevision !== revisionRef.current) { setError(`Saved ${basename(path)}. Your newer edits remain here; save again to include them.`); return; }
      setSaveAsOpen(false);
      onOpenDoc(path);
    } catch (failure) { if (mountedRef.current) setError(failure.message); }
    finally { if (mountedRef.current) setSaving(false); }
  };
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem(`engine.autosave.${kind}`) === "1";
    } catch {
      return false;
    }
  });

  const toggleAutosave = () => {
    setAutosave((cur) => {
      const next = !cur;
      try {
        localStorage.setItem(`engine.autosave.${kind}`, next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    if (committedRef.current === committedGraph) return;
    committedRef.current = committedGraph;
    if (JSON.stringify(committedGraph) === JSON.stringify(graphRef.current)) return;
    if (docPath && dirtyRef.current) {
      setError("This asset changed elsewhere. Your draft is preserved; Save replaces the file with your draft.");
      return;
    }
    graphRef.current = committedGraph;
    revisionRef.current++;
    editorRef.current?.load(committedGraph);
    setDirty(false);
    setError("");
  }, [committedGraph, docPath]);

  const onChange = useCallback((graph, meta) => {
    revisionRef.current++;
    setRevision(revisionRef.current);
    setError("");
    graphRef.current = { ...graphRef.current, ...graph };
    // A load (initial or preset) is not a user edit; marking it dirty would
    // arm autosave the instant the panel opens.
    if (meta?.reason !== "load") setDirty(true);
  }, []);

  const apply = useCallback(async () => {
    const fullGraph = graphRef.current;
    const applyingRevision = revisionRef.current;
    const graph = stripHelpers(fullGraph);
    try {
      const component = engine.getEntity(entityId)?.getComponent(kind);
      if (!docPath && !component) throw new Error(`${kind} component no longer exists.`);
      await validate(graph);
      if (!mountedRef.current || applyingRevision !== revisionRef.current) return;
      if (docPath) await writeVfxDocument(docPath, { ...document, version: 1, kind, graph: fullGraph });
      else commandBus.execute(new SetComponentPropCommand(entityId, kind, "graph", fullGraph));
      if (!mountedRef.current || applyingRevision !== revisionRef.current) return;
      committedRef.current = fullGraph;
      setDirty(false);
      setError("");
    } catch (failure) {
      if (mountedRef.current) setError(failure.message ?? String(failure));
    }
  }, [entityId, kind, docPath, document, validate]);

  // Autosave: when enabled, commit every change. Debounced so transient
  // mutations (dragging a node fires a change per intermediate position)
  // collapse into a single write at the end of the gesture.
  useEffect(() => {
    if (!autosave || !dirty) return;
    const id = setTimeout(apply, 150);
    return () => clearTimeout(id);
  }, [autosave, dirty, revision, apply]);

  const restart = () => engine.getEntity(entityId)?.getComponent(kind)?.restart?.();

  const toolbar = (
    <>
      {kind === "particles" && <div className="dropdown-wrap">
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
                    // `record` makes the preset load one undoable step, so a
                    // mis-click doesn't destroy the graph the user was building.
                    editorRef.current?.load(PARTICLE_PRESETS[name], { record: true });
                    setDirty(true);
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>}
      <button className="toolbar-btn icon-only" disabled={!entityId} title="Restart simulation" onClick={restart}>
        <RotateCcw size={14} />
      </button>
      <button
        className={`toolbar-btn icon-only${autosave ? " active" : ""}`}
        title={autosave ? "Autosave on — changes apply instantly" : "Autosave off — click Apply to commit"}
        onClick={toggleAutosave}
      >
        <Zap size={14} />
      </button>
      <button className="toolbar-btn" disabled={!dirty || autosave} onClick={apply}>
        <Check size={13} />
        {docPath ? "Save" : "Apply"}{dirty ? " •" : ""}
      </button>
      <div className="dropdown-wrap">
        <button className="toolbar-btn" disabled={!folder} onClick={() => setSaveAsOpen((value) => !value)}><FilePlus2 size={13} />Save As</button>
        {saveAsOpen && <><div className="dropdown-overlay" onClick={() => setSaveAsOpen(false)} /><div className="dropdown-menu save-as-menu">
          <div className="node-palette-group">Save particle graph as</div>
          <input autoFocus aria-label="VFX asset filename" className="text-field" value={fileName} onChange={(event) => setFileName(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") saveAs(); if (event.key === "Escape") setSaveAsOpen(false); }} />
          <div title={folder}>in {basename(folder ?? "")}</div>
          <button className="toolbar-btn" disabled={saving || !fileName.trim()} onClick={saveAs}><Save size={13} />{saving ? "Saving..." : "Create"}</button>
        </div></>}
      </div>
    </>
  );

  return (
    <div className="vfx-graph-workspace" data-vfx-kind={kind} data-vfx-document={docPath ?? ""}>
    {error && <div className="vfx-error" role="alert">{error}</div>}
    <GraphEditor
      ref={editorRef}
      kind={kind}
      registry={registry}
      initialGraph={initialGraph}
      onChange={onChange}
      toolbar={toolbar}
      hint={kind === "particles" ? "Wire emitters and forces into the Particle System node · right-click to add nodes · double-click a wire to delete it · Ctrl+Z undoes" : "Connect Grid to Solver, then Solver and Material to Surface Output · right-click to add values and math · Apply commits changes"}
    />
    </div>
  );
}

export function ParticlesPanel() {
  const selectedId = useSelectionStore((state) => state.ids[0] ?? null);
  const selectedAsset = useSelectionStore((state) => state.assetPath);
  const entity = useSceneStore((state) => selectedId ? state.entities[selectedId] : null);
  const enabledModules = useModulesStore((state) => state.enabled);
  const kind = "particles";
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [loaded, setLoaded] = useState(null);
  const props = entity?.components?.[kind];
  const browsedPath = selectedAsset && /\.vfx$/i.test(selectedAsset) ? selectedAsset : "";
  const docPath = browsedPath || props?.asset || "";
  const document = loaded?.path === docPath ? loaded.document : null;
  const activeKind = browsedPath ? document?.kind ?? kind : kind;
  useEffect(() => {
    setError("");
    if (!docPath) { setLoaded(null); return; }
    let live = true, published = false;
    const accept = (doc) => {
      if (!live) return;
      if (doc.kind !== kind) { setLoaded(null); setError(`This is a ${doc.kind} asset; choose a ${kind} asset.`); return; }
      setLoaded({ path: docPath, document: doc }); setError("");
    };
    const unsubscribe = subscribeVfxAsset(docPath, (doc) => { published = true; accept(doc); });
    readVfxDocument(docPath).then((doc) => { if (!published) accept(doc); }).catch((failure) => { if (live && !published) { setLoaded(null); setError(failure.message); } });
    return () => { live = false; unsubscribe(); };
  }, [docPath, browsedPath, kind]);
  const graph = useMemo(() => {
    if (docPath) return document?.graph ?? null;
    if (!props) return null;
    if (props.graph) return props.graph;
    return props.startColor !== undefined ? legacyPropsToGraph(props) : DEFAULT_PARTICLE_GRAPH;
  }, [kind, props, docPath, document]);
  useEffect(() => { setError(""); }, [selectedId]);
  const openDoc = async (path) => {
    try {
      if (path) {
        const doc = await readVfxDocument(path);
        if (doc.kind !== kind) throw new Error(`Choose a ${kind} asset; this file contains ${doc.kind}.`);
      }
      if (entity && props) commandBus.execute(new SetComponentPropCommand(entity.id, kind, "asset", path));
      else useSelectionStore.getState().selectAsset(path);
      setError("");
    } catch (failure) { setError(failure.message); }
  };
  const add = async () => {
    const entityId = entity.id;
    setAdding(true); setError("");
    try {
      if (!enabledModules.includes("particles")) await setModuleEnabled("particles", true);
      if (!getComponentClass(kind)) throw new Error(`${kind} simulation is not available.`);
      if (engine.getEntity(entityId) && !engine.getEntity(entityId).getComponent(kind)) commandBus.execute(new AddComponentCommand(entityId, kind));
    } catch (failure) { setError(failure.message); } finally { setAdding(false); }
  };
  return <div className="vfx-panel">
    <div className="vfx-asset-slot" data-vfx-asset-slot><span>Graph</span><AssetField descriptor={{ exts: ["vfx"], emptyLabel: "Embedded" }} value={docPath} onCommit={openDoc} /></div>
    {error && <div className="vfx-error" role="alert">{error}</div>}
    {graph ? <ReactFlowProvider key={docPath || `${entity.id}:${kind}`}><ParticleGraphEditor entityId={entity?.id} kind={activeKind} committedGraph={graph} document={document} docPath={docPath} onOpenDoc={openDoc} /></ReactFlowProvider>
      : docPath ? <div className="vfx-empty">{error ? "Unable to open particle graph." : "Loading particle graph..."}</div>
      : !entity ? <div className="vfx-empty"><Sparkles size={24} /><strong>Particles</strong><p>Select an entity with particles or open a particle graph asset.</p></div>
      : <div className="vfx-empty"><Sparkles size={24} /><strong>Build a particle effect</strong><p>Create on "{entity.name}", then edit its graph.</p><button className="toolbar-btn" disabled={adding} onClick={add}><Plus size={13} />{adding ? "Adding..." : "Add Particles"}</button></div>}
  </div>;
}
