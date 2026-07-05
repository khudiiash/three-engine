import { useState } from "react";
import { Plus, X, Trash2, RotateCcw, Gamepad2, Keyboard, Mouse, Smartphone, Crosshair, Save } from "lucide-react";
import { useInputStore } from "../store/inputStore.js";
import { useProjectStore } from "../store/projectStore.js";
import { describePath, rebindNextInput, suggestedPaths } from "../input/bindingLabels.js";

/**
 * Unity-style Input editor. The left rail lists action maps; the main pane
 * lists actions in the selected map. Each action expands into its bindings
 * with a Rebind button that listens for the next input event of any kind.
 *
 * Edits are local to the snapshot until "Save" is pressed (mirrors how
 * Scene Settings work) — this avoids fighting the manager mid-edit.
 */
export function InputPanel() {
  const snap = useInputStore((s) => s.snapshot);
  const dirty = useInputStore((s) => s.dirty);
  const selectedMap = useInputStore((s) => s.selectedMap);
  const selectedAction = useInputStore((s) => s.selectedAction);
  const selectMap = useInputStore((s) => s.selectMap);
  const selectAction = useInputStore((s) => s.selectAction);
  const patch = useInputStore((s) => s.patch);
  const commit = useInputStore((s) => s.commit);

  const hasProject = useProjectStore((s) => !!s.rootPath);

  if (!snap) return <div className="inspector-panel empty">Loading input…</div>;

  const maps = snap.maps ?? [];
  const activeMap = maps.find((m) => m.name === selectedMap) ?? maps[0];

  const addMap = () => {
    const name = window.prompt("New action map name:", "Gameplay");
    if (!name) return;
    patch((s) => {
      if (s.maps.some((m) => m.name === name)) return s;
      s.maps.push({ name, schemes: ["KeyboardMouse", "Gamepad", "Touch"], actions: [] });
      return s;
    });
    selectMap(name);
  };

  const removeMap = (name) => {
    patch((s) => {
      s.maps = s.maps.filter((m) => m.name !== name);
      s.stack = s.stack.filter((n) => n !== name);
      return s;
    });
  };

  const toggleMap = (name, on) => {
    patch((s) => {
      const set = new Set(s.stack);
      if (on) set.add(name); else set.delete(name);
      s.stack = [...set];
      return s;
    });
  };

  const resetDefaults = () => {
    if (!window.confirm("Reset all input bindings to defaults? This wipes your project.json's input block.")) return;
    patch((s) => {
      s.maps = null;
      s.stack = null;
      return s;
    });
  };

  return (
    <div className="input-panel">
      <div className="panel-toolbar">
        <span className="asset-path" title="Input">Action Maps</span>
        <button className="toolbar-btn" onClick={addMap} title="Add a new action map">
          <Plus size={13} /> Map
        </button>
        <button className="toolbar-btn" onClick={resetDefaults} title="Reset to defaults (Player + UI)">
          <RotateCcw size={13} /> Defaults
        </button>
        <button
          className="toolbar-btn"
          disabled={!dirty || !hasProject}
          onClick={commit}
          title={hasProject ? "Save to project.json" : "Open a project to save"}
        >
          <Save size={13} /> Save{dirty ? " •" : ""}
        </button>
      </div>

      <div className="input-layout">
        <aside className="input-maps">
          {maps.length === 0 && <div className="inspector-panel empty">No maps yet — click “+ Map”.</div>}
          {maps.map((m) => {
            const enabled = (snap.stack ?? []).includes(m.name);
            const active = activeMap?.name === m.name;
            return (
              <div key={m.name} className={`input-map-row ${active ? "active" : ""}`}>
                <input
                  type="checkbox"
                  checked={enabled}
                  title={enabled ? "Disable this map" : "Enable this map"}
                  onChange={(e) => toggleMap(m.name, e.target.checked)}
                />
                <button className="input-map-name" onClick={() => selectMap(m.name)} title={`${m.actions.length} actions`}>
                  {m.name}
                  <span className="input-map-count">{m.actions.length}</span>
                </button>
                <button className="icon-btn" title="Remove map" onClick={() => removeMap(m.name)}>
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </aside>

        <main className="input-main">
          {activeMap ? (
            <MapEditor map={activeMap} selectedAction={selectedAction} onSelectAction={(a) => selectAction(activeMap.name, a)} onPatch={patch} />
          ) : (
            <div className="inspector-panel empty">Pick a map on the left.</div>
          )}
        </main>
      </div>

      <DeviceLegend />
    </div>
  );
}

function MapEditor({ map, selectedAction, onSelectAction, onPatch }) {
  const addAction = () => {
    const name = window.prompt("Action name:", "Jump");
    if (!name) return;
    onPatch((s) => {
      const m = s.maps.find((mm) => mm.name === map.name);
      if (!m) return s;
      if (m.actions.some((a) => a.name === name)) return s;
      m.actions.push({ name, type: "button", composite: "any", bindings: [] });
      return s;
    });
    onSelectAction(name);
  };

  const removeAction = (actionName) => {
    onPatch((s) => {
      const m = s.maps.find((mm) => mm.name === map.name);
      if (!m) return s;
      m.actions = m.actions.filter((a) => a.name !== actionName);
      return s;
    });
  };

  const setActionType = (actionName, type) => {
    onPatch((s) => {
      const m = s.maps.find((mm) => mm.name === map.name);
      if (!m) return s;
      const a = m.actions.find((aa) => aa.name === actionName);
      if (a) a.type = type;
      return s;
    });
  };

  const setActionSpace = (actionName, space) => {
    onPatch((s) => {
      const m = s.maps.find((mm) => mm.name === map.name);
      if (!m) return s;
      const a = m.actions.find((aa) => aa.name === actionName);
      if (!a) return s;
      if (space === "world") {
        // Default — drop the key entirely so existing project.json snapshots
        // aren't polluted with redundant `space: "world"`.
        delete a.space;
      } else {
        a.space = space;
      }
      return s;
    });
  };

  const addBinding = (actionName, path) => {
    onPatch((s) => {
      const m = s.maps.find((mm) => mm.name === map.name);
      if (!m) return s;
      const a = m.actions.find((aa) => aa.name === actionName);
      if (!a) return s;
      a.bindings.push({ kind: "binding", id: "b_" + Math.random().toString(36).slice(2, 10), path, negate: false, scale: 1 });
      return s;
    });
  };

  const removeBinding = (actionName, bindingId) => {
    onPatch((s) => {
      const m = s.maps.find((mm) => mm.name === map.name);
      if (!m) return s;
      const a = m.actions.find((aa) => aa.name === actionName);
      if (!a) return s;
      a.bindings = a.bindings.filter((b) => b.id !== bindingId);
      return s;
    });
  };

  const updateBinding = (actionName, bindingId, patchObj) => {
    onPatch((s) => {
      const m = s.maps.find((mm) => mm.name === map.name);
      if (!m) return s;
      const a = m.actions.find((aa) => aa.name === actionName);
      if (!a) return s;
      const b = a.bindings.find((bb) => bb.id === bindingId);
      if (b) Object.assign(b, patchObj);
      return s;
    });
  };

  return (
    <div className="input-map-editor">
      <div className="input-map-header">
        <div className="input-map-title">{map.name}</div>
        <button className="toolbar-btn" onClick={addAction}>
          <Plus size={13} /> Action
        </button>
      </div>

      {(map.actions ?? []).length === 0 && (
        <div className="inspector-panel empty">No actions — click “+ Action”.</div>
      )}

      {(map.actions ?? []).map((action) => {
        const expanded = selectedAction === action.name;
        return (
          <div key={action.name} className={`input-action ${expanded ? "expanded" : ""}`}>
            <div
              className="input-action-header"
              role="button"
              tabIndex={0}
              onClick={() => onSelectAction(expanded ? null : action.name)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectAction(expanded ? null : action.name);
                }
              }}
            >
              <span className="input-action-name">{action.name}</span>
              <span className="input-action-type">{action.type}</span>
              <span className="input-action-bindings">{action.bindings.length} binding{action.bindings.length === 1 ? "" : "s"}</span>
              <button
                className="icon-btn"
                title="Remove action"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAction(action.name);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {expanded && (
              <div className="input-action-body">
                <div className="field-row">
                  <span className="field-label">Type</span>
                  <select className="select-field" value={action.type} onChange={(e) => setActionType(action.name, e.target.value)}>
                    <option value="button">Button</option>
                    <option value="value">Value (axis)</option>
                    <option value="vec2">Vec2 (stick)</option>
                  </select>
                </div>
                {action.type === "vec2" && (
                  <div className="field-row">
                    <span className="field-label" title="Rotate the action's vec2 by the active camera before storing it. World keeps the input-space (x=strafe, y=forward) interpretation; Camera gives you world-space (x=worldX, y=worldZ) ready to add to entity.position.">Space</span>
                    <select
                      className="select-field"
                      value={action.space ?? "world"}
                      onChange={(e) => setActionSpace(action.name, e.target.value)}
                    >
                      <option value="world">World (input axes)</option>
                      <option value="camera">Camera (world XZ)</option>
                    </select>
                  </div>
                )}
                <BindingList
                  action={action}
                  onAdd={(path) => addBinding(action.name, path)}
                  onRemove={(id) => removeBinding(action.name, id)}
                  onUpdate={(id, p) => updateBinding(action.name, id, p)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BindingList({ action, onAdd, onRemove, onUpdate }) {
  return (
    <div className="input-bindings">
      <div className="input-bindings-header">
        <span className="field-label">Bindings</span>
      </div>
      {action.bindings.length === 0 && (
        <div className="input-bindings-empty">No bindings — add one below.</div>
      )}
      {action.bindings.map((b) =>
        b?.kind === "composite" ? (
          <CompositeRow key={b.id} composite={b} onRemove={() => onRemove(b.id)} />
        ) : (
          <BindingRow key={b.id} binding={b ?? {}} onRemove={() => onRemove(b.id)} onUpdate={(p) => onUpdate(b.id, p)} />
        ),
      )}
      <BindingAdder onAdd={onAdd} />
    </div>
  );
}

function CompositeRow({ composite, onRemove }) {
  const typeLabel = composite?.type === "2d" ? "2D Axis Composite" : composite?.type === "1d" ? "1D Axis Composite" : "Composite";
  const parts = composite?.parts ?? {};
  const slotLabels = {
    2: ["up", "down", "left", "right"],
    1: ["negative", "positive"],
  };
  const slots = composite?.type === "2d" ? slotLabels[2] : slotLabels[1];
  return (
    <div className="input-binding-row composite">
      <div className="input-binding-rebind composite-header">
        <span className="composite-badge">{typeLabel}</span>
        <span className="composite-slots">
          {(Array.isArray(slots) ? slots : Object.keys(parts)).map((slot) => (
            <span key={slot} className="composite-slot">
              <span className="composite-slot-name">{slot}</span>
              <span className="composite-slot-value">{describePath(parts[slot]?.path)}</span>
            </span>
          ))}
        </span>
      </div>
      <span className="composite-spacer" />
      <span className="composite-spacer" />
      <span className="composite-spacer" />
      <button className="icon-btn" title="Remove binding" onClick={onRemove}>
        <X size={12} />
      </button>
    </div>
  );
}

function BindingRow({ binding, onRemove, onUpdate }) {
  const [rebinding, setRebinding] = useState(false);
  const startRebind = async () => {
    setRebinding(true);
    const result = await rebindNextInput();
    setRebinding(false);
    if (result?.path) onUpdate({ path: result.path });
  };
  return (
    <div className="input-binding-row">
      <button
        className={`input-binding-rebind ${rebinding ? "rebinding" : ""}`}
        onClick={startRebind}
        title="Click, then press a key / move a stick / press a button"
      >
        {rebinding ? "Press any key…" : describePath(binding.path)}
      </button>
      <input
        className="text-field small"
        type="text"
        value={binding.path ?? ""}
        onChange={(e) => onUpdate({ path: e.target.value })}
        title="Raw path (device/control)"
      />
      <label className="field-row inline" title="Invert this binding">
        <input type="checkbox" checked={!!binding.negate} onChange={(e) => onUpdate({ negate: e.target.checked })} />
        <span>Invert</span>
      </label>
      <input
        className="number-field small"
        type="number"
        step={0.1}
        value={binding.scale ?? 1}
        onChange={(e) => onUpdate({ scale: parseFloat(e.target.value) || 1 })}
        title="Multiplier on the raw value"
      />
      <button className="icon-btn" title="Remove binding" onClick={onRemove}>
        <X size={12} />
      </button>
    </div>
  );
}

function BindingAdder({ onAdd }) {
  const families = [
    { id: "keyboard", label: "Keyboard", Icon: Keyboard },
    { id: "mouse", label: "Mouse", Icon: Mouse },
    { id: "gamepad", label: "Gamepad", Icon: Gamepad2 },
    { id: "touch", label: "Touch", Icon: Smartphone },
    { id: "virtualjoystick", label: "V-Joy", Icon: Crosshair },
  ];
  const [open, setOpen] = useState(null);
  const [custom, setCustom] = useState("");
  return (
    <div className="input-binding-adder">
      {families.map((f) => (
        <div key={f.id} className="input-adder-family">
          <button className="toolbar-btn tiny" onClick={() => setOpen(open === f.id ? null : f.id)}>
            <f.Icon size={12} /> {f.label}
          </button>
          {open === f.id && (
            <div className="input-adder-menu">
              {suggestedPaths(f.id).map((p) => (
                <button key={p} className="dropdown-item" onClick={() => { onAdd(p); setOpen(null); }}>
                  {describePath(p)}
                  <span className="input-adder-path">{p}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="input-adder-custom">
        <input
          className="text-field small"
          type="text"
          placeholder="custom path…"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom) { onAdd(custom); setCustom(""); }
          }}
        />
        <button
          className="toolbar-btn tiny"
          disabled={!custom}
          onClick={() => { if (custom) { onAdd(custom); setCustom(""); } }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function DeviceLegend() {
  return (
    <div className="input-legend">
      <span><Keyboard size={11} /> Keyboard</span>
      <span><Mouse size={11} /> Mouse</span>
      <span><Gamepad2 size={11} /> Gamepad</span>
      <span><Smartphone size={11} /> Touch</span>
      <span><Crosshair size={11} /> Virtual Joystick</span>
    </div>
  );
}