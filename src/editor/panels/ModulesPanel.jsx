import { useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { useModulesStore, listModuleDefinitions, setModuleEnabled } from "../modules.js";
import { usePlayStore } from "../store/playStore.js";
import { useProjectStore } from "../store/projectStore.js";

/**
 * Unity-style package manager (v1): lists the built-in module catalog with
 * per-project enable switches. Enabling registers the module's components
 * and boots its runtime immediately; the choice persists in project.json
 * and rides into exported games.
 */
export function ModulesPanel() {
  const enabled = useModulesStore((s) => s.enabled);
  const playing = usePlayStore((s) => s.playing);
  const hasProject = useProjectStore((s) => !!s.rootPath);
  const [defs, setDefs] = useState([]);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    listModuleDefinitions().then(setDefs);
  }, []);

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

  return (
    <div className="modules-panel">
      <div className="modules-intro">
        Engine modules extend the runtime with new components and systems.
        Enabled modules are saved with the project and ship with exported games.
        {!hasProject && <em> No project open — choices won't persist.</em>}
      </div>
      {defs.map((def) => {
        const on = enabled.includes(def.id);
        return (
          <div className="module-card" key={def.id}>
            <div className="module-icon">
              <Boxes size={18} />
            </div>
            <div className="module-info">
              <div className="module-name">
                {def.name}
                <span className="module-version">v{def.version}</span>
                {on && <span className="module-badge">Enabled</span>}
              </div>
              <div className="module-desc">{def.description}</div>
              {def.components?.length > 0 && (
                <div className="module-components">
                  Components: {def.components.map((c) => c.label).join(", ")}
                </div>
              )}
            </div>
            <input
              type="checkbox"
              checked={on}
              disabled={busy === def.id || playing}
              title={playing ? "Stop play mode to change modules" : on ? "Disable module" : "Enable module"}
              onChange={(e) => toggle(def.id, e.target.checked)}
            />
          </div>
        );
      })}
      {defs.length === 0 && <div className="modules-intro">No modules registered.</div>}
    </div>
  );
}
