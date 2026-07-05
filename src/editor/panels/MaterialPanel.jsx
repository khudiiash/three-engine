import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { useSceneStore } from "../store/sceneStore.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { MATERIAL_DEFAULTS, getMaterialDef, updateMaterialAsset } from "../../engine/materialAsset.js";
import { AssetField } from "../fields/AssetField.jsx";
import { TEXTURE_EXTENSIONS } from "../assetLoader.js";

/**
 * Edits the .mat asset assigned to the selected mesh. Changes apply to the
 * shared material instantly (every mesh using it updates); Save writes the
 * file. File edits are not undoable — they're asset edits, not scene edits.
 */
export function MaterialPanel() {
  const selectedId = useSelectionStore((s) => s.ids[0] ?? null);
  const matPath = useSceneStore((s) =>
    selectedId ? s.entities[selectedId]?.components?.mesh?.material : null,
  );
  if (!matPath) {
    return (
      <div className="particles-panel empty">
        Select an entity whose Mesh has a Material asset assigned (drag a .mat onto it).
      </div>
    );
  }
  return <MaterialEditor matPath={matPath} />;
}

/** Reusable .mat editor — also embedded in the Inspector's asset view. */
export function MaterialEditor({ matPath }) {
  const [def, setDef] = useState(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let live = true;
    setDef(null);
    setDirty(false);
    if (!matPath) return;
    (async () => {
      // Prefer the live cached def; fall back to reading the file.
      let d = getMaterialDef(matPath);
      if (!d) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          d = { ...MATERIAL_DEFAULTS, ...JSON.parse(await invoke("read_text_file", { path: matPath })) };
        } catch {
          d = { ...MATERIAL_DEFAULTS };
        }
      }
      if (live) setDef({ ...d });
    })();
    return () => (live = false);
  }, [matPath]);

  if (!def) return <div className="particles-panel empty">Loading…</div>;

  const patch = (p) => {
    const next = { ...def, ...p };
    setDef(next);
    setDirty(true);
    updateMaterialAsset(matPath, next); // live update of the shared material
  };

  const save = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { shaderGraph, ...rest } = def;
    await invoke("save_scene", {
      path: matPath,
      contents: JSON.stringify({ ...rest, shaderGraph: shaderGraph ?? null }, null, 2),
    });
    setDirty(false);
    console.log(`Material saved: ${matPath}`);
  };

  return (
    <div className="particles-panel">
      <div className="panel-toolbar">
        <span className="asset-path" title={matPath}>{matPath.split(/[\\/]/).pop()}</span>
        <button className="toolbar-btn" disabled={!dirty} onClick={save}>
          <Save size={13} />
          Save{dirty ? " •" : ""}
        </button>
      </div>
      <div className="particles-scroll">
        <div className="inspector-section">
          <div className="field-row">
            <span className="field-label">Color</span>
            <input
              className="color-field"
              type="color"
              value={def.color}
              onChange={(e) => patch({ color: e.target.value })}
            />
          </div>
          {[["roughness", "Roughness"], ["metalness", "Metalness"]].map(([key, label]) => (
            <div className="field-row" key={key}>
              <span className="field-label">{label}</span>
              <input
                className="slider-field"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={def[key]}
                onChange={(e) => patch({ [key]: parseFloat(e.target.value) })}
              />
              <input
                className="number-field slider-readout"
                type="number"
                step={0.01}
                value={def[key]}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!Number.isNaN(v)) patch({ [key]: v });
                }}
              />
            </div>
          ))}
          <div className="field-row">
            <span className="field-label">Texture</span>
            <AssetField
              descriptor={{ exts: TEXTURE_EXTENSIONS }}
              value={def.map}
              onCommit={(path) => patch({ map: path })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
