import { useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { useModulesStore, listModuleDefinitions, setModuleEnabled } from "../modules.js";
import { usePlayStore } from "../store/playStore.js";
import { useProjectStore } from "../store/projectStore.js";

const SELECTED_KEY = "engine.modules.selected";

/**
 * Unity-style package manager. The left rail lists every registered module
 * with a name and a switch (mirrors a step on/off — nothing more). Clicking
 * a row populates the right pane with the module's full details
 * (description, components, runtime notes, version, enable/disable hint).
 *
 * Select the first module on mount, then keep the previous selection across
 * panel open/close via localStorage so reopening lands where the user left
 * off (same pattern as Unity's Package Manager after you revisit it).
 */
export function ModulesPanel() {
  const enabled = useModulesStore((s) => s.enabled);
  const playing = usePlayStore((s) => s.playing);
  const hasProject = useProjectStore((s) => !!s.rootPath);
  const [defs, setDefs] = useState([]);
  const [busy, setBusy] = useState(null);
  const [selectedId, setSelectedId] = useState(() => {
    try {
      return localStorage.getItem(SELECTED_KEY) ?? null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    listModuleDefinitions().then((d) => {
      setDefs(d);
      // Restore from localStorage; fall back to the first module so the
      // right pane is never blank on first open. Stale ids (the module
      // was unregistered) drop to the head of the list automatically.
      if (d.length === 0) {
        setSelectedId(null);
        return;
      }
      const exists = d.some((x) => x.id === selectedId);
      if (!exists) setSelectedId(d[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    try {
      localStorage.setItem(SELECTED_KEY, selectedId);
    } catch {}
  }, [selectedId]);

  const toggle = async (id, on) => {
    setBusy(id);
    try {
      await setModuleEnabled(id, on);
    } catch (err) {
      console.error(`Module "${id}": ${err.message ?? err}`);
    } finally {
      setBusy(null);
    }
  };

  const selected = defs.find((d) => d.id === selectedId) ?? null;
  const disabledReason = playing ? "Stop play mode to change modules" : null;
  const intro = (
    <div className="modules-intro">
      Engine modules extend the runtime with new components and systems.
      Enabled modules are saved with the project and ship with exported games.
      {!hasProject && <em> No project open — choices won't persist.</em>}
    </div>
  );

  return (
    <div className="modules-panel">
      {intro}
      {defs.length === 0 ? (
        <div className="modules-intro">No modules registered.</div>
      ) : (
        <div className="modules-body">
          {/* Left rail: pick a module to inspect on the right. */}
          <div className="modules-list" role="listbox" aria-label="Engine modules">
            {defs.map((def) => {
              const on = enabled.includes(def.id);
              const isActive = def.id === selectedId;
              return (
                <div
                  key={def.id}
                  role="option"
                  aria-selected={isActive}
                  className={`modules-list-row${isActive ? " active" : ""}`}
                  onClick={() => setSelectedId(def.id)}
                  title={def.description}
                >
                  <span className="modules-list-name">
                    <Boxes size={13} />
                    <span className="modules-list-name-text">{def.name}</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy === def.id || playing}
                    title={
                      playing
                        ? "Stop play mode to change modules"
                        : on
                        ? "Disable module"
                        : "Enable module"
                    }
                    // Stop the row's onClick (which selects) when the user
                    // clicks the switch directly — both intents are valid
                    // but shouldn't fire together (clicks on the rail row
                    // shouldn't toggle; clicks on the switch shouldn't
                    // re-select).
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => toggle(def.id, e.target.checked)}
                  />
                </div>
              );
            })}
          </div>

          {/* Right pane: detailed view of the selected module. */}
          <div className="modules-detail">
            {selected ? (
              <ModuleDetail
                key={selected.id}
                def={selected}
                on={enabled.includes(selected.id)}
                busy={busy === selected.id}
                disabledReason={disabledReason}
                onToggle={(on) => toggle(selected.id, on)}
              />
            ) : (
              <div className="modules-detail-empty">Select a module to see its details.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModuleDetail({ def, on, busy, disabledReason, onToggle }) {
  const components = def.components ?? [];
  return (
    <div className="modules-detail-body">
      <header className="modules-detail-header">
        <div className="modules-detail-title">
          <h3>{def.name}</h3>
          <div className="modules-detail-meta">
            <span className="modules-detail-version">v{def.version}</span>
            {on && <span className="module-badge">Enabled</span>}
          </div>
        </div>
        <input
          type="checkbox"
          checked={on}
          disabled={busy || !!disabledReason}
          title={
            disabledReason ??
            (on ? "Disable module" : "Enable module")
          }
          onChange={(e) => onToggle(e.target.checked)}
          aria-label={`Toggle ${def.name}`}
        />
      </header>

      <p className="modules-detail-desc">{def.description}</p>

      {components.length > 0 && (
        <section className="modules-detail-section">
          <div className="modules-detail-section-label">Adds components</div>
          <ul className="modules-component-list">
            {components.map((c) => (
              <li key={c.type ?? c.label} className="modules-component-chip">
                {c.label}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="modules-detail-section">
        <div className="modules-detail-section-label">Runtime</div>
        <dl className="modules-detail-grid">
          <dt>Module ID</dt>
          <dd>
            <code>{def.id}</code>
          </dd>
          <dt>Version</dt>
          <dd>v{def.version}</dd>
          <dt>State</dt>
          <dd>
            <span className={`modules-state-dot ${on ? "on" : "off"}`} />
            {on ? "Enabled for this project" : "Disabled"}
          </dd>
        </dl>
      </section>

      <p className="modules-detail-note">
        Enabled choices persist in <code>project.json</code> and ride into exported games.
      </p>
    </div>
  );
}
