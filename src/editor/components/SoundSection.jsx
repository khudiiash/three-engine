import { useEffect, useState } from "react";
import { Plus, Trash2, Play, Square, ChevronDown, ChevronRight } from "lucide-react";
import { engine } from "../engineInstance.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { AssetField } from "../fields/AssetField.jsx";
import {
  FALLOFF_OPTIONS,
  LOOP_OPTIONS,
  PLAYBACK_OPTIONS,
  makeDefaultEntry,
} from "../../engine/audio/defaults.js";

/**
 * Per-entry editor for a SoundComponent. We can't use the schema for
 * entries (schemas are flat key→type), so each entry gets a collapsible
 * panel rendered explicitly here. Mutations push through
 * SetComponentPropCommand on the parent `entries` array so undo/redo
 * treats every edit as one prop step.
 */
export function SoundSection({ entityId, props }) {
  const entries = props.entries ?? [];
  const component = engine.getEntity(entityId)?.getComponent?.("sound");
  const [expanded, setExpanded] = useState({});

  const addEntry = () => {
    const entry = makeDefaultEntry();
    const next = [...entries, entry];
    commandBus.execute(new SetComponentPropCommand(entityId, "sound", "entries", next));
    setExpanded((m) => ({ ...m, [entry.id]: true }));
  };

  const removeEntry = (entryId) => {
    const next = entries.filter((e) => e.id !== entryId);
    commandBus.execute(new SetComponentPropCommand(entityId, "sound", "entries", next));
  };

  const updateEntry = (entryId, patch) => {
    const next = entries.map((e) =>
      e.id === entryId ? { ...e, ...patch } : e,
    );
    commandBus.execute(new SetComponentPropCommand(entityId, "sound", "entries", next));
  };

  return (
    <>
      {entries.length === 0 && (
        <div className="inspector-hint" style={{ margin: "4px 2px 8px" }}>
          No entries yet. Add one to assign an audio asset and per-clip params.
        </div>
      )}
      {entries.map((entry) => (
        <EntryPanel
          key={entry.id}
          entry={entry}
          component={component}
          expanded={!!expanded[entry.id]}
          onToggle={() => setExpanded((m) => ({ ...m, [entry.id]: !m[entry.id] }))}
          onUpdate={(patch) => updateEntry(entry.id, patch)}
          onRemove={() => removeEntry(entry.id)}
        />
      ))}
      <button className="toolbar-btn wide" onClick={addEntry}>
        <Plus size={14} /> Add entry
      </button>
    </>
  );
}

function EntryPanel({ entry, component, expanded, onToggle, onUpdate, onRemove }) {
  const [previewing, setPreviewing] = useState(false);
  const [handle, setHandle] = useState(null);
  const stopPreview = () => {
    handle?.stop?.();
    setPreviewing(false);
  };
  useEffect(() => {
    return () => {
      handle?.stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playPreview = () => {
    if (!component) return;
    const h = component.previewEntry(entry.id);
    if (!h) return;
    setHandle(h);
    setPreviewing(true);
    // Auto-stop after the entry's duration, capped to a sensible preview
    // window so a 5-minute music loop doesn't pin a slot indefinitely.
    const previewLength = Math.min(
      Math.max(0.5, (entry.duration ?? 6) + (entry.fadeOut ?? 0)),
      30,
    );
    setTimeout(() => {
      h.stop();
      setHandle(null);
      setPreviewing(false);
    }, previewLength * 1000);
  };

  return (
    <div className="sound-entry-panel">
      <div className="sound-entry-header">
        <button className="icon-btn" onClick={onToggle} title={expanded ? "Collapse" : "Expand"}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="sound-entry-title">
          {entry.name || entry.audioAsset.split(/[\\/]/).pop() || "Untitled"}
        </span>
        {previewing && <span className="badge preview">previewing</span>}
        <button
          className="icon-btn"
          title={previewing ? "Stop preview" : "Play preview"}
          onClick={previewing ? stopPreview : playPreview}
        >
          {previewing ? <Square size={12} /> : <Play size={12} />}
        </button>
        <button
          className="icon-btn"
          title="Remove entry"
          onClick={() => {
            stopPreview();
            onRemove();
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {expanded && (
        <div className="sound-entry-body">
          <PropRow label="Name (label)">
            <TextInput value={entry.name} onCommit={(v) => onUpdate({ name: v })} />
          </PropRow>
          <PropRow label="Audio">
            <AssetField
              descriptor={{ exts: ["audio", "ogg", "wav", "mp3"] }}
              value={entry.audioAsset}
              onCommit={(v) => onUpdate({ audioAsset: v })}
            />
          </PropRow>
          <PropRow label="Playback">
            <SelectInput
              value={entry.playback}
              options={PLAYBACK_OPTIONS}
              onCommit={(v) => onUpdate({ playback: v, spatial: v === "3D" })}
            />
          </PropRow>
          <PropRow label="Loop">
            <SelectInput value={entry.loop} options={LOOP_OPTIONS} onCommit={(v) => onUpdate({ loop: v })} />
          </PropRow>
          <PropRow label="Volume">
            <NumberInput value={entry.volume} min={0} max={1} step={0.05} onCommit={(v) => onUpdate({ volume: v })} />
          </PropRow>
          <PropRow label="Volume ±">
            <NumberInput value={entry.volumeVariance} min={0} max={1} step={0.05} onCommit={(v) => onUpdate({ volumeVariance: v })} />
          </PropRow>
          <PropRow label="Pitch">
            <NumberInput value={entry.pitch} min={0.1} max={4} step={0.05} onCommit={(v) => onUpdate({ pitch: v })} />
          </PropRow>
          <PropRow label="Pitch ±">
            <NumberInput value={entry.pitchVariance} min={0} max={1} step={0.05} onCommit={(v) => onUpdate({ pitchVariance: v })} />
          </PropRow>
          <PropRow label="Start delay (s)">
            <NumberInput value={entry.startDelay ?? 0} min={0} step={0.1} onCommit={(v) => onUpdate({ startDelay: v })} />
          </PropRow>
          <PropRow label="Duration (s)">
            <NumberInput
              value={entry.duration}
              min={0}
              step={0.5}
              allowNull
              placeholder="full"
              onCommit={(v) => onUpdate({ duration: v })}
            />
          </PropRow>
          <PropRow label="Fade in (s)">
            <NumberInput value={entry.fadeIn ?? 0} min={0} step={0.05} onCommit={(v) => onUpdate({ fadeIn: v })} />
          </PropRow>
          <PropRow label="Fade out (s)">
            <NumberInput value={entry.fadeOut ?? 0} min={0} step={0.05} onCommit={(v) => onUpdate({ fadeOut: v })} />
          </PropRow>
          {entry.playback !== "2D" && (
            <>
              <PropRow label="Falloff">
                <SelectInput value={entry.falloff} options={FALLOFF_OPTIONS} onCommit={(v) => onUpdate({ falloff: v })} />
              </PropRow>
              <PropRow label="Ref distance">
                <NumberInput value={entry.refDistance ?? 1} min={0} step={0.1} onCommit={(v) => onUpdate({ refDistance: v })} />
              </PropRow>
              <PropRow label="Max distance">
                <NumberInput value={entry.maxDistance ?? 100} min={0.1} step={1} onCommit={(v) => onUpdate({ maxDistance: v })} />
              </PropRow>
              <PropRow label="Rolloff">
                <NumberInput value={entry.rolloffFactor ?? 1} min={0} step={0.1} onCommit={(v) => onUpdate({ rolloffFactor: v })} />
              </PropRow>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PropRow({ label, children }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <div className="sound-entry-control">{children}</div>
    </div>
  );
}

function NumberInput({ value, min, max, step, onCommit, allowNull, placeholder }) {
  // Local text so empty (null) values don't get coerced to 0.
  const [text, setText] = useState(value === undefined || value === null ? "" : String(value));
  useEffect(() => {
    setText(value === undefined || value === null ? "" : String(value));
  }, [value]);
  const commit = () => {
    if (text === "" && allowNull) return onCommit(null);
    const n = parseFloat(text);
    if (!Number.isNaN(n)) {
      let v = n;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      onCommit(v);
    } else {
      setText(value === undefined || value === null ? "" : String(value));
    }
  };
  return (
    <input
      className="number-field"
      type="number"
      step={step}
      min={min}
      max={max}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Escape") {
          setText(value === undefined || value === null ? "" : String(value));
          e.target.blur();
        }
      }}
    />
  );
}

function SelectInput({ value, options, onCommit }) {
  return (
    <select className="select-field" value={value} onChange={(e) => onCommit(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

function TextInput({ value, onCommit }) {
  return (
    <input
      className="text-field"
      type="text"
      defaultValue={value ?? ""}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
    />
  );
}
