import { useEffect, useRef, useState } from "react";
import { Play, Pause, Square, Plus, Trash2, Copy, Diamond, Sparkles } from "../icons/index.jsx";
import { engine } from "../engineInstance.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useSceneStore } from "../store/sceneStore.js";
import { commandBus } from "../commands/CommandBus.js";
import { AddComponentCommand, SetComponentPropCommand } from "../commands/componentCommands.js";
import { setModuleEnabled } from "../modules.js";
import { AssetField } from "../fields/AssetField.jsx";
import { createEffectElement, createEffectPreset, EFFECT_KINDS, EFFECT_CHANNELS, normalizeEffectTimeline, evaluateEffectElement } from "../../engine/vfx/effectTimeline.js";
import "./VfxTimeline.css";

import { Select } from "../fields/Select.jsx";
/** Commit numeric typing once so an intermediate decimal point never becomes zero. */
function TimelineInput({ type, value, onChange, min, max, ...props }) {
  const [draft, setDraft] = useState(null);
  if (type !== "number") return <input {...props} type={type} value={value} onChange={onChange} min={min} max={max} />;
  const finish = () => {
    if (draft == null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (draft.trim() && Number.isFinite(parsed)) {
      const next = Math.min(max == null ? Infinity : Number(max), Math.max(min == null ? -Infinity : Number(min), parsed));
      if (next !== value) onChange?.({ target: { value: String(next) } });
    }
  };
  return <input {...props} type="text" data-number-input inputMode="decimal" value={draft ?? value} onChange={(event) => setDraft(event.target.value)} onBlur={finish} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") setDraft(null);
  }} />;
}

export function VfxTimelinePanel() {
  const id = useSelectionStore((s) => s.ids[0]);
  useSceneStore((s) => s.entities);
  const component = engine.getEntity(id)?.getComponent("vfx");
  const [selected, select] = useState("");
  const [clock, setClock] = useState(0);
  const [channel, setChannel] = useState("scale");
  const [error, setError] = useState("");
  const dragRef = useRef(null);
  const [dragPreview, setDragPreview] = useState(null);
  const savedDocument = component?.document ?? createEffectPreset();
  const document = dragPreview ? { ...savedDocument, elements: savedDocument.elements.map((e) => e.id === dragPreview.id ? { ...e, ...dragPreview.values } : e) } : savedDocument;
  const element = document.elements.find((e) => e.id === selected);
  useEffect(() => { select(""); setError(""); dragRef.current = null; setDragPreview(null); }, [id]);
  useEffect(() => { const timer = setInterval(() => setClock(component?.time ?? 0), 60); return () => clearInterval(timer); }, [component]);
  const commit = (next) => {
    try { commandBus.execute(new SetComponentPropCommand(id, "vfx", "timeline", normalizeEffectTimeline(next), "Edit VFX timeline")); setError(""); }
    catch (e) { setError(e.message); }
  };
  const patch = (changes) => commit({ ...document, elements: document.elements.map((e) => e.id === selected ? { ...e, ...changes } : e) });
  const beginClipDrag = (event, entry, resize = false) => {
    if (event.button !== 0) return;
    event.stopPropagation(); event.preventDefault();
    event.currentTarget.closest(".effect-panel")?.focus({ preventScroll: true });
    select(entry.id);
    const width = event.currentTarget.closest(".effect-lane").getBoundingClientRect().width;
    dragRef.current = { id: entry.id, x: event.clientX, width, resize, source: savedDocument, start: entry.start, duration: entry.duration, values: null };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveClip = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = (event.clientX - drag.x) / Math.max(1, drag.width) * drag.source.duration;
    const round = (value) => Math.round(value * 100) / 100;
    drag.values = drag.resize
      ? { duration: Math.max(.01, round(Math.min(drag.source.duration - drag.start, drag.duration + delta))) }
      : { start: Math.max(0, round(Math.min(Math.max(0, drag.source.duration - drag.duration), drag.start + delta))) };
    setDragPreview({ id: drag.id, values: drag.values });
  };
  const endClip = (event, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null; setDragPreview(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && drag.values && Object.entries(drag.values).some(([key, value]) => value !== drag[key])) commit({ ...drag.source, elements: drag.source.elements.map((e) => e.id === drag.id ? { ...e, ...drag.values } : e) });
  };
  const add = (kind) => { const e = createEffectElement(kind); commit({ ...document, elements: [...document.elements, e] }); select(e.id); };
  const seek = (time) => { component.seek(time); setClock(component.time); };
  const addComponent = async () => {
    try { await setModuleEnabled("vfx", true); commandBus.execute(new AddComponentCommand(id, "vfx")); } catch (e) { setError(e.message); }
  };
  if (!component) return <div className="effect-empty" title={id ? "Compose sprites, rings, meshes, ribbons, lights and particles on a timeline" : "Select an entity or create VFX in the hierarchy"}><Sparkles className="empty-glyph" size={28} />{id ? <button onClick={addComponent} title="Add VFX component"><Plus size={13} /> Add VFX</button> : null}{error && <p role="alert">{error}</p>}</div>;
  const keyframes = element?.keys?.[channel] ?? [];
  const keyTime = Math.max(0, clock - (element?.start ?? 0));
  const insertKey = () => {
    const value = evaluateEffectElement(element, clock)[channel];
    patch({ keys: { ...element.keys, [channel]: [...keyframes.filter((k) => Math.abs(k.time - keyTime) > .001), { time: Math.round(keyTime * 1000) / 1000, value, interpolation: "linear" }] } });
  };
  return <div className="effect-panel" data-vfx-timeline tabIndex={-1}>
    <div className="effect-toolbar">
      <button title="Play VFX" onClick={() => { component.play(); setClock(0); }}><Play size={14} /></button>
      <button title="Pause or resume VFX" onClick={() => component.state === "paused" ? component.resume() : component.pause()}><Pause size={14} /></button>
      <button title="Stop VFX" onClick={() => { component.stop(); setClock(0); }}><Square size={14} /></button>
      <span>{clock.toFixed(2)} s</span>
      <label>Duration <TimelineInput aria-label="Effect duration" type="number" min=".01" step=".1" value={document.duration} onChange={(e) => commit({ ...document, duration: Number(e.target.value) })} /></label>
      <label><TimelineInput type="checkbox" checked={document.loop} onChange={(e) => commit({ ...document, loop: e.target.checked })} />Loop</label>
      <Select aria-label="Add effect element" value="" onChange={(e) => add(e.target.value)}><option value="">+ Element</option>{EFFECT_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</Select>
      <Select aria-label="Effect preset" value="" onChange={(e) => { commit(createEffectPreset(e.target.value)); select(""); }}><option value="">Presets</option><option>Impact</option><option>Aura</option></Select>
    </div>
    {error && <div role="alert">{error}</div>}
    <div className="effect-body">
      <div className="effect-tracks">
        <div className="effect-ruler"><span>Elements</span><TimelineInput aria-label="VFX playhead" type="range" min="0" max={document.duration} step=".01" value={clock} onChange={(e) => seek(Number(e.target.value))} /></div>
        {document.elements.map((e) => <div key={e.id} className={`effect-track ${selected === e.id ? "selected" : ""}`} onClick={() => select(e.id)}>
          <div className="effect-track-name"><TimelineInput aria-label={`Enable ${e.name}`} type="checkbox" checked={e.enabled} onChange={(event) => commit({ ...document, elements: document.elements.map((a) => a.id === e.id ? { ...a, enabled: event.target.checked } : a) })} /><span>{e.name}</span><small>{e.kind}</small></div>
          <div className="effect-lane" onDoubleClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); seek((event.clientX-rect.left)/rect.width*document.duration); }}>
            <div className={`effect-clip effect-${e.kind}`} data-element-id={e.id} title="Drag to move; drag the right edge to resize" onPointerDown={(event) => beginClipDrag(event, e)} onPointerMove={moveClip} onPointerUp={endClip} onPointerCancel={(event) => endClip(event, true)} style={{left:`${e.start/document.duration*100}%`,width:`${Math.min(e.duration,Math.max(0,document.duration-e.start))/document.duration*100}%`}}>{e.duration.toFixed(2)}s<span className="effect-clip-resize" aria-label={`Resize ${e.name}`} onPointerDown={(event) => beginClipDrag(event, e, true)} onPointerMove={moveClip} onPointerUp={endClip} onPointerCancel={(event) => endClip(event, true)} /></div>
            <i className="effect-playhead" style={{left:`${clock/document.duration*100}%`}} />
          </div>
        </div>)}
        {!document.elements.length && <div className="effect-empty" title="Add an element to start composing"><Plus className="empty-glyph" size={28} /></div>}
      </div>
      {element && <div className="effect-properties">
        <div className="effect-toolbar"><strong>{element.kind}</strong><button title="Duplicate element" onClick={() => { const copy = {...structuredClone(element), id:createEffectElement(element.kind).id, name:`${element.name} copy`}; commit({...document,elements:[...document.elements,copy]});select(copy.id); }}><Copy size={13}/></button><button title="Remove element" onClick={() => {commit({...document,elements:document.elements.filter((e)=>e.id!==selected)});select("");}}><Trash2 size={13}/></button></div>
        <label>Name<TimelineInput value={element.name} onChange={(e) => patch({name:e.target.value})}/></label>
        <label>Parent<Select value={element.parent} onChange={(e)=>patch({parent:e.target.value})}><option value="">Effect root</option>{document.elements.filter((e)=>e.id!==element.id).map((e)=><option key={e.id} value={e.id}>{e.name}</option>)}</Select></label>
        {["start","duration",...EFFECT_CHANNELS].map((key)=><label key={key}>{key}<TimelineInput aria-label={`Element ${key}`} type="number" step=".05" value={element[key]} onChange={(e)=>patch({[key]:Number(e.target.value)})}/></label>)}
        <label>Color<TimelineInput type="color" value={element.color} onChange={(e)=>patch({color:e.target.value})}/></label>
        <label>Blend<Select value={element.blend} onChange={(e)=>patch({blend:e.target.value})}><option value="additive">Additive</option><option value="normal">Alpha</option></Select></label>
        {["lit","castShadow","receiveShadow"].map((key)=><label key={key}>{key}<TimelineInput type="checkbox" checked={element[key]} onChange={(e)=>patch({[key]:e.target.checked})}/></label>)}
        {element.kind === "sprite" && <><label>Billboard<TimelineInput type="checkbox" checked={element.billboard !== false} onChange={(event) => patch({ billboard: event.target.checked })} /></label>{["columns", "rows", "fps"].map((key) => <label key={key}>{key}<TimelineInput aria-label={`Sprite ${key}`} type="number" min="1" step="1" value={element[key] ?? 1} onChange={(event) => patch({ [key]: Number(event.target.value) })} /></label>)}</>}
        {element.kind === "mesh" && <label>Geometry<Select value={element.geometry} onChange={(e)=>patch({geometry:e.target.value})}>{["sphere","box","cone"].map((g)=><option key={g}>{g}</option>)}</Select></label>}
        {["ring","ribbon"].includes(element.kind) && <label>Width<TimelineInput type="number" min=".01" step=".01" value={element.width} onChange={(e)=>patch({width:Number(e.target.value)})}/></label>}
        {element.kind === "ring" && <label>Arc<TimelineInput type="number" min="1" max="360" value={element.arc} onChange={(e)=>patch({arc:Number(e.target.value)})}/></label>}
        {!["group","light","particles"].includes(element.kind) && <label>Texture<AssetField descriptor={{exts:["png","jpg","webp"]}} value={element.texture} onCommit={(texture)=>patch({texture})}/></label>}
        {element.kind === "particles" && <label title="Uses the Particles graph, lighting and collision settings. Scrubbing resets GPU particles; play previews their simulation.">Particle graph<AssetField descriptor={{exts:["vfx"]}} value={element.asset ?? ""} onCommit={(asset)=>patch({asset})}/></label>}
        <div className="effect-toolbar"><Select aria-label="Animated channel" value={channel} onChange={(e)=>setChannel(e.target.value)}>{EFFECT_CHANNELS.map((c)=><option key={c}>{c}</option>)}</Select><button title="Add key at playhead — keys use seconds since this element starts" onClick={insertKey}><Diamond size={13}/><Plus size={12}/></button></div>
        {keyframes.map((key,i)=><div className="effect-key" key={i}>
          <TimelineInput aria-label={`Key ${i} time`} type="number" step=".05" value={key.time} onChange={(e)=>patch({keys:{...element.keys,[channel]:keyframes.map((k,j)=>j===i?{...k,time:Number(e.target.value)}:k)}})}/>
          <TimelineInput aria-label={`Key ${i} value`} type="number" step=".05" value={key.value} onChange={(e)=>patch({keys:{...element.keys,[channel]:keyframes.map((k,j)=>j===i?{...k,value:Number(e.target.value)}:k)}})}/>
          <Select aria-label={`Key ${i} interpolation`} value={key.interpolation} onChange={(e)=>patch({keys:{...element.keys,[channel]:keyframes.map((k,j)=>j===i?{...k,interpolation:e.target.value}:k)}})}>{["linear","smooth","step"].map((mode)=><option key={mode}>{mode}</option>)}</Select>
          <button title="Remove key" onClick={()=>patch({keys:{...element.keys,[channel]:keyframes.filter((_,j)=>j!==i)}})}><Trash2 size={12}/></button>
        </div>)}
      </div>}
    </div>
  </div>;
}
