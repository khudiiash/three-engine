import { useEffect, useRef, useState } from "react";
import { ExternalLink, Workflow, Package } from "lucide-react";
import * as THREE from "three/webgpu";
import { createGltfLoader } from "../../engine/gltfLoader.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useProjectStore } from "../store/projectStore.js";
import { toBlobUrl, extOf, readAssetMeta, TEXTURE_EXTENSIONS } from "../assetLoader.js";
import { TEXTURE_META_DEFAULTS } from "../../engine/textureMeta.js";
import {
  MATERIAL_PIPELINE_DEFAULTS,
  MATERIAL_VOLUME_PIPELINE_DEFAULTS,
  loadMaterialAsset,
  refreshMaterialsUsingTexture,
  updateMaterialPipeline,
} from "../../engine/materialAsset.js";
import { openPanel } from "../EditorShell.jsx";
import { syncScriptClassNameAfterRename } from "../scriptClassSync.js";
import { openPrefabMode } from "../prefab.js";
import { useModulesStore } from "../modules.js";
import { prefabRegistry, resolvePrefab, isPrefabDef } from "../../engine/index.js";

const fileName = (p) => p?.split(/[\\/]/).pop() ?? "";
const stemOf = (name) => name.replace(/\.[^.]+$/, "");

/** Human-readable byte size, e.g. "2.4 MB". */
function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const TYPE_LABELS = {
  png: "Texture",
  jpg: "Texture",
  jpeg: "Texture",
  webp: "Texture",
  glb: "Model",
  geom: "Geometry",
  mat: "Material",
  anim: "Animator",
  prefab: "Prefab",
  entity: "Prefab (legacy)",
  js: "Script",
  ts: "Script",
  scene: "Scene",
  json: "JSON",
};

/** Renames the asset (and its .meta sidecar), keeping it selected. */
async function renameAsset(path, newStem) {
  const name = newStem.trim();
  const ext = extOf(path);
  const oldName = fileName(path);
  if (!name || name === stemOf(oldName)) return;
  const dir = path.slice(0, path.length - oldName.length);
  const newPath = `${dir}${name}${ext ? `.${ext}` : ""}`;
  try {
    await invoke("rename_path", { from: path, to: newPath });
    // Keep texture import settings attached across the rename.
    await invoke("rename_path", { from: `${path}.meta`, to: `${newPath}.meta` }).catch(() => {});
    await invoke("rename_path", { from: `${path}.basis`, to: `${newPath}.basis` }).catch(() => {});
    // Scripts: keep the default-exported class name in sync with the new
    // filename stem, and inject `extends Script` if missing.
    await syncScriptClassNameAfterRename(newPath, name);
    await useProjectStore.getState().refresh();
    useSelectionStore.getState().selectAsset(newPath);
    console.log(`Renamed to ${fileName(newPath)}`);
  } catch (err) {
    console.error(`Rename failed: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Texture preview + import settings (.meta sidecar)
// ---------------------------------------------------------------------------

function TexturePreview({ path }) {
  const [url, setUrl] = useState(null);
  const [dims, setDims] = useState(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setDims(null);
    toBlobUrl(path).then((u) => live && setUrl(u)).catch(() => {});
    return () => (live = false);
  }, [path]);
  return (
    <div className="asset-preview texture-preview">
      {url && (
        <img
          src={url}
          alt=""
          draggable={false}
          onLoad={(e) => setDims({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
        />
      )}
      {dims && (
        <div className="asset-preview-caption">
          {dims.w} × {dims.h}
        </div>
      )}
    </div>
  );
}

function TextureSettings({ path }) {
  const [meta, setMeta] = useState(null);
  const [basisBusy, setBasisBusy] = useState(false);
  const basisModuleEnabled = useModulesStore((s) => s.enabled.includes("basis"));

  useEffect(() => {
    let live = true;
    setMeta(null);
    (async () => {
      let m = null;
      try {
        m = JSON.parse(await invoke("read_text_file", { path: `${path}.meta` }));
      } catch {}
      if (live) setMeta({ ...TEXTURE_META_DEFAULTS, ...(m ?? {}) });
    })();
    return () => (live = false);
  }, [path]);

  if (!meta) return null;

  const patch = async (p) => {
    const next = { ...meta, ...p };
    setMeta(next);
    try {
      await invoke("save_scene", { path: `${path}.meta`, contents: JSON.stringify(next, null, 2) });
      refreshMaterialsUsingTexture(path); // live-update materials using it
    } catch (err) {
      console.error(`Failed to save settings: ${err}`);
    }
  };

  const wrapSelect = (key) => (
    <select className="select-field" value={meta[key]} onChange={(e) => patch({ [key]: e.target.value })}>
      <option value="repeat">Repeat</option>
      <option value="clamp">Clamp</option>
      <option value="mirror">Mirror</option>
    </select>
  );

  const toggleBasis = async (enabled) => {
    setBasisBusy(true);
    try {
      const { setTextureBasisEnabled } = await import("../basisCompress.js");
      const info = await setTextureBasisEnabled(path, enabled);
      setMeta((current) => ({
        ...current,
        basis: enabled ? { enabled: true, ...info } : { enabled: false },
      }));
      refreshMaterialsUsingTexture(path);
      await useProjectStore.getState().refresh();
    } catch (err) {
      console.error(`Basis compression failed: ${err.message ?? err}`);
    } finally {
      setBasisBusy(false);
    }
  };

  return (
    <div className="inspector-section">
      <div className="section-header">Import Settings</div>
      <div className="field-row">
        <span className="field-label">Filtering</span>
        <select className="select-field" value={meta.filter} onChange={(e) => patch({ filter: e.target.value })}>
          <option value="linear">Linear</option>
          <option value="nearest">Nearest (pixel art)</option>
        </select>
      </div>
      <div className="field-row">
        <span className="field-label">Wrap U</span>
        {wrapSelect("wrapS")}
      </div>
      <div className="field-row">
        <span className="field-label">Wrap V</span>
        {wrapSelect("wrapT")}
      </div>
      <div className="field-row">
        <span className="field-label">Tiling</span>
        <div className="vector-fields">
          {[0, 1].map((i) => (
            <input
              key={i}
              className="number-field"
              type="number"
              step={0.5}
              value={meta.repeat?.[i] ?? 1}
              onChange={(e) => {
                const repeat = [...(meta.repeat ?? [1, 1])];
                repeat[i] = parseFloat(e.target.value) || 1;
                patch({ repeat });
              }}
            />
          ))}
        </div>
      </div>
      <div className="field-row">
        <span className="field-label">Flip Y</span>
        <input type="checkbox" checked={meta.flipY !== false} onChange={(e) => patch({ flipY: e.target.checked })} />
      </div>
      <div className="field-row">
        <span className="field-label">Basis</span>
        <input
          type="checkbox"
          checked={meta.basis?.enabled === true}
          disabled={basisBusy || !basisModuleEnabled}
          title={
            basisModuleEnabled
              ? "Override Basis compression for this texture"
              : "Enable the Basis Compression module first"
          }
          onChange={(e) => toggleBasis(e.target.checked)}
        />
      </div>
      {meta.basis?.enabled && meta.basis.original > 0 && (
        <div className="asset-info-row">
          {meta.basis.compressed < meta.basis.original
            ? `Basis −${Math.round((1 - meta.basis.compressed / meta.basis.original) * 100)}% · ${formatBytes(meta.basis.original)} → ${formatBytes(meta.basis.compressed)}`
            : `Basis ${formatBytes(meta.basis.compressed)}`}
        </div>
      )}
    </div>
  );
}

function MultiTextureSettings({ paths }) {
  const [metas, setMetas] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.all(paths.map(async (path) => ({
      path,
      meta: { ...TEXTURE_META_DEFAULTS, ...((await readAssetMeta(`${path}.meta`)) ?? {}) },
    }))).then((value) => live && setMetas(value));
    return () => { live = false; };
  }, [paths.join("|")]);
  if (!metas?.length) return null;

  const allSame = (read) => metas.every((entry) => Object.is(read(entry.meta), read(metas[0].meta)));
  const patch = async (createPatch) => {
    const next = metas.map(({ path, meta }) => ({ path, meta: { ...meta, ...createPatch(meta) } }));
    setMetas(next);
    await Promise.all(next.map(async ({ path, meta }) => {
      await invoke("save_scene", { path: `${path}.meta`, contents: JSON.stringify(meta, null, 2) });
      refreshMaterialsUsingTexture(path);
    })).catch((error) => console.error(`Failed to save texture settings: ${error}`));
  };
  const select = (key, options) => {
    const same = allSame((meta) => meta[key]);
    return (
      <select className="select-field" value={same ? metas[0].meta[key] : ""} onChange={(event) => patch(() => ({ [key]: event.target.value }))}>
        {!same && <option value="">— Mixed —</option>}
        {options.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
    );
  };
  const mixedCheckbox = (key, read = (meta) => meta[key]) => {
    const same = allSame(read);
    const ref = (element) => { if (element) element.indeterminate = !same; };
    return (
      <input
        ref={ref}
        type="checkbox"
        checked={same && !!read(metas[0].meta)}
        onChange={(event) => patch(() => ({ [key]: event.target.checked }))}
      />
    );
  };

  return (
    <div className="inspector-section">
      <div className="section-header">Shared Import Settings</div>
      <div className="field-row">
        <span className="field-label">Filtering</span>
        {select("filter", [["linear", "Linear"], ["nearest", "Nearest (pixel art)"]])}
      </div>
      <div className="field-row">
        <span className="field-label">Wrap U</span>
        {select("wrapS", [["repeat", "Repeat"], ["clamp", "Clamp"], ["mirror", "Mirror"]])}
      </div>
      <div className="field-row">
        <span className="field-label">Wrap V</span>
        {select("wrapT", [["repeat", "Repeat"], ["clamp", "Clamp"], ["mirror", "Mirror"]])}
      </div>
      <div className="field-row">
        <span className="field-label">Tiling</span>
        <div className="vector-fields">
          {[0, 1].map((axis) => {
            const same = allSame((meta) => meta.repeat?.[axis] ?? 1);
            return (
              <input
                key={axis}
                className="number-field"
                type="number"
                step={0.5}
                value={same ? (metas[0].meta.repeat?.[axis] ?? 1) : ""}
                placeholder={same ? undefined : "—"}
                onChange={(event) => {
                  const value = Number.parseFloat(event.target.value);
                  if (!Number.isFinite(value)) return;
                  patch((meta) => {
                    const repeat = [...(meta.repeat ?? [1, 1])];
                    repeat[axis] = value;
                    return { repeat };
                  });
                }}
              />
            );
          })}
        </div>
      </div>
      <div className="field-row">
        <span className="field-label">Flip Y</span>
        {mixedCheckbox("flipY", (meta) => meta.flipY !== false)}
      </div>
      <div className="asset-hint">Changes apply to all {paths.length} selected textures.</div>
    </div>
  );
}

function MultiAssetInspector({ paths }) {
  const extensions = paths.map(extOf);
  const allTextures = extensions.every((ext) => TEXTURE_EXTENSIONS.includes(ext));
  const allVirtualGeometry = extensions.every((ext) => ext === "geom" || ext === "glb");
  const sameType = extensions.every((ext) => ext === extensions[0]);
  return (
    <div className="inspector-panel">
      <div className="inspector-section multi-selection-summary">
        <div className="section-header">{paths.length} Assets Selected</div>
        <div className="field-row">
          <span className="field-label">Type</span>
          <span className="asset-type-badge">{allTextures ? "Textures" : sameType ? (TYPE_LABELS[extensions[0]] ?? extensions[0].toUpperCase()) : "Mixed"}</span>
        </div>
      </div>
      {allTextures ? <MultiTextureSettings paths={paths} /> : allVirtualGeometry ? (
        <MultiVirtualGeometrySettings paths={paths} />
      ) : (
        <div className="asset-hint">Batch editing is available when the selected assets share editable import settings.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model (.glb) 3D preview: its own small WebGPU renderer + slow turntable.
// ---------------------------------------------------------------------------

function ModelPreview({ path }) {
  const canvasRef = useRef(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let disposed = false;
    let renderer = null;
    let resizeObserver = null;
    setInfo(null);
    setError(null);

    (async () => {
      try {
        const gltf = await createGltfLoader().loadAsync(await toBlobUrl(path));
        let meshes = 0;
        let tris = 0;
        gltf.scene.traverse((o) => {
          if (o.isMesh) {
            meshes++;
            tris += (o.geometry.index?.count ?? o.geometry.attributes.position?.count ?? 0) / 3;
          }
        });
        const draco = (await readAssetMeta(`${path}.meta`))?.draco ?? null;
        if (disposed) return;
        setInfo({ meshes, tris: Math.round(tris), clips: (gltf.animations ?? []).map((c) => c.name), draco });

        const canvas = canvasRef.current;
        if (!canvas) return;
        renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio ?? 1);
        await renderer.init();
        if (disposed) return;
        const width = canvas.clientWidth || 280;
        const height = canvas.clientHeight || 190;
        renderer.setSize(width, height, false);
        resizeObserver = new ResizeObserver(() => {
          const nextWidth = canvas.clientWidth;
          const nextHeight = canvas.clientHeight;
          if (nextWidth > 0 && nextHeight > 0) renderer?.setSize(nextWidth, nextHeight, false);
        });
        resizeObserver.observe(canvas);

        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.4));
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(3, 5, 4);
        scene.add(key);
        scene.add(gltf.scene);

        const bounds = new THREE.Box3().setFromObject(gltf.scene);
        const center = bounds.getCenter(new THREE.Vector3());
        const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.001);
        const camera = new THREE.PerspectiveCamera(40, width / height, radius / 50, radius * 20);

        let mixer = null;
        if (gltf.animations?.length) {
          mixer = new THREE.AnimationMixer(gltf.scene);
          mixer.clipAction(gltf.animations[0]).play();
        }

        const timer = new THREE.Timer();
        let angle = 0.7;
        renderer.setAnimationLoop(() => {
          if (!canvas.isConnected || canvas.clientWidth < 1 || canvas.clientHeight < 1) return;
          timer.update();
          const dt = timer.getDelta();
          angle += dt * 0.5;
          mixer?.update(dt);
          camera.position.set(
            center.x + Math.sin(angle) * radius * 2.4,
            center.y + radius * 1.1,
            center.z + Math.cos(angle) * radius * 2.4,
          );
          camera.lookAt(center);
          renderer.render(scene, camera);
        });
      } catch (err) {
        if (!disposed) setError(String(err.message ?? err));
      }
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      renderer?.setAnimationLoop(null);
      renderer?.dispose();
    };
  }, [path]);

  return (
    <>
      <div className="asset-preview model-preview">
        {error ? <div className="asset-hint">Preview unavailable: {error}</div> : <canvas ref={canvasRef} />}
      </div>
      {info && (
        <div className="inspector-section">
          <div className="section-header">Contents</div>
          <div className="asset-info-row">
            {info.meshes} mesh{info.meshes === 1 ? "" : "es"} · {info.tris.toLocaleString()} tris
          </div>
          {info.draco?.original > 0 && (
            <div className="asset-info-row draco-info">
              {info.draco.compressed < info.draco.original ? (
                <>
                  Draco −{Math.round((1 - info.draco.compressed / info.draco.original) * 100)}% ·{" "}
                  {formatBytes(info.draco.original)} → {formatBytes(info.draco.compressed)}
                </>
              ) : (
                <>Draco: already minimal ({formatBytes(info.draco.original)})</>
              )}
            </div>
          )}
          {info.clips.length > 0 && (
            <>
              <div className="asset-info-label">Animation clips</div>
              {info.clips.map((c) => (
                <div className="asset-info-row clip" key={c}>
                  {c}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Virtual geometry import settings (.meta sidecar) — Unreal-style: the asset
// opts in, and every Model or static Mesh using it renders through cluster LOD
// pipeline. Only shown while the virtual-geometry module is enabled.
// ---------------------------------------------------------------------------

function VirtualGeometrySettings({ path }) {
  const modulesEnabled = useModulesStore((s) => s.enabled);
  const [vg, setVg] = useState(null);

  useEffect(() => {
    let live = true;
    setVg(null);
    (async () => {
      const meta = await readAssetMeta(`${path}.meta`);
      const { VIRTUAL_GEOMETRY_META_DEFAULTS } = await import("../../modules/virtual-geometry/index.js");
      const stored = meta?.virtualGeometry ?? {};
      const merged = {
        ...VIRTUAL_GEOMETRY_META_DEFAULTS,
        enabled: stored.enabled === true,
        pixelError: stored.pixelError ?? VIRTUAL_GEOMETRY_META_DEFAULTS.pixelError,
      };
      if (live) setVg(merged);
    })();
    return () => (live = false);
  }, [path]);

  if (!modulesEnabled.includes("virtual-geometry") || !vg) return null;

  const patch = async (p) => {
    const next = { ...vg, ...p };
    setVg(next);
    try {
      // Merge into the full meta — other sections (draco, …) must survive.
      const meta = (await readAssetMeta(`${path}.meta`)) ?? {};
      meta.virtualGeometry = next;
      await invoke("save_scene", { path: `${path}.meta`, contents: JSON.stringify(meta, null, 2) });
      const { refreshVirtualGeometryAsset } = await import("../../modules/virtual-geometry/index.js");
      refreshVirtualGeometryAsset(path); // live-update every open engine
    } catch (err) {
      console.error(`Failed to save virtual geometry settings: ${err}`);
    }
  };

  return (
    <div className="inspector-section">
      <div className="section-header">Virtual Geometry</div>
      <div className="field-row">
        <span className="field-label">Enabled</span>
        <input type="checkbox" checked={vg.enabled === true} onChange={(e) => patch({ enabled: e.target.checked })} />
      </div>
      {vg.enabled && (
        <>
          <div className="field-row">
            <span className="field-label">Pixel Error</span>
            <input
              className="number-field"
              type="number"
              min={0.25}
              max={32}
              step={0.25}
              value={vg.pixelError}
              onChange={(e) => patch({ pixelError: Math.max(0.05, parseFloat(e.target.value) || 1) })}
            />
          </div>
          <div className="asset-hint">
            Renders static meshes through Nanite-style cluster LOD wherever this asset is used. Pixel Error is the
            screen-space error budget — higher is faster, lower is sharper. Use the viewport's Virtual Geometry
            layer to color every triangle in the live LOD cut.
          </div>
        </>
      )}
    </div>
  );
}

function MultiVirtualGeometrySettings({ paths }) {
  const modulesEnabled = useModulesStore((state) => state.enabled);
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const { VIRTUAL_GEOMETRY_META_DEFAULTS } = await import("../../modules/virtual-geometry/index.js");
      const loaded = await Promise.all(paths.map(async (path) => {
        const meta = (await readAssetMeta(`${path}.meta`)) ?? {};
        const stored = meta.virtualGeometry ?? {};
        const vg = {
          ...VIRTUAL_GEOMETRY_META_DEFAULTS,
          enabled: stored.enabled === true,
          pixelError: stored.pixelError ?? VIRTUAL_GEOMETRY_META_DEFAULTS.pixelError,
        };
        return { path, meta, vg };
      }));
      if (live) setEntries(loaded);
    })().catch((error) => console.error(`Failed to load virtual geometry settings: ${error}`));
    return () => { live = false; };
  }, [paths.join("|")]);

  if (!modulesEnabled.includes("virtual-geometry") || !entries?.length) return null;

  const same = (key) => entries.every((entry) => Object.is(entry.vg[key], entries[0].vg[key]));
  const patch = async (partial) => {
    const next = entries.map((entry) => ({ ...entry, vg: { ...entry.vg, ...partial } }));
    setEntries(next);
    try {
      const { refreshVirtualGeometryAsset } = await import("../../modules/virtual-geometry/index.js");
      await Promise.all(next.map(async ({ path, meta, vg }) => {
        const nextMeta = { ...meta, virtualGeometry: vg };
        await invoke("save_scene", { path: `${path}.meta`, contents: JSON.stringify(nextMeta, null, 2) });
        refreshVirtualGeometryAsset(path);
      }));
    } catch (error) {
      console.error(`Failed to save virtual geometry settings: ${error}`);
    }
  };

  const enabledSame = same("enabled");
  const anyEnabled = entries.some((entry) => entry.vg.enabled === true);
  const pixelSame = same("pixelError");
  return (
    <div className="inspector-section">
      <div className="section-header">Virtual Geometry</div>
      <div className="field-row">
        <span className="field-label">Enabled</span>
        <input
          ref={(element) => { if (element) element.indeterminate = !enabledSame; }}
          type="checkbox"
          checked={enabledSame && entries[0].vg.enabled === true}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />
      </div>
      {(anyEnabled || !enabledSame) && (
        <>
          <div className="field-row">
            <span className="field-label">Pixel Error</span>
            <input
              className="number-field"
              type="number"
              min={0.25}
              max={32}
              step={0.25}
              key={pixelSame ? entries[0].vg.pixelError : "mixed"}
              defaultValue={pixelSame ? entries[0].vg.pixelError : ""}
              placeholder={pixelSame ? undefined : "—"}
              onBlur={(event) => {
                const value = Number.parseFloat(event.target.value);
                if (Number.isFinite(value) && (!pixelSame || value !== entries[0].vg.pixelError)) {
                  patch({ pixelError: Math.max(0.05, value) });
                }
              }}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            />
          </div>
        </>
      )}
      <div className="asset-hint">Changes apply to all {paths.length} selected geometry assets.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animator / prefab summaries
// ---------------------------------------------------------------------------

function JsonSummary({ path, render }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null);
    invoke("read_text_file", { path })
      .then((text) => live && setData(JSON.parse(text)))
      .catch(() => {});
    return () => (live = false);
  }, [path]);
  return data ? render(data) : null;
}

function MaterialSummary({ path }) {
  const [def, setDef] = useState(null);
  const defRef = useRef(null);
  const saveQueue = useRef(Promise.resolve());

  useEffect(() => {
    let live = true;
    defRef.current = null;
    setDef(null);
    Promise.all([
      invoke("read_text_file", { path }).then((text) => JSON.parse(text)),
      loadMaterialAsset(path),
    ]).then(([loaded]) => {
      if (!live) return;
      defRef.current = loaded;
      setDef(loaded);
    }).catch((error) => console.error(`Failed to inspect material: ${error}`));
    return () => { live = false; };
  }, [path]);

  if (!def) return null;
  const output = def.shaderGraph?.nodes?.find((node) => node.type === "output");
  const isVolume = !!output && (def.shaderGraph?.edges ?? []).some(
    (edge) => edge.target === output.id && edge.targetHandle === "volume",
  );
  const defaults = isVolume ? MATERIAL_VOLUME_PIPELINE_DEFAULTS : MATERIAL_PIPELINE_DEFAULTS;
  const pipeline = { ...defaults, ...(def.pipeline ?? {}) };

  const patchPipeline = (patch) => {
    const current = defRef.current;
    if (!current) return;
    const nextPipeline = { ...defaults, ...(current.pipeline ?? {}), ...patch };
    const next = { ...current, pipeline: nextPipeline };
    defRef.current = next;
    setDef(next);
    updateMaterialPipeline(path, nextPipeline);
    saveQueue.current = saveQueue.current.catch(() => {}).then(() =>
      invoke("save_scene", { path, contents: JSON.stringify(next, null, 2) }),
    ).catch((error) => console.error(`Failed to save material pipeline: ${error}`));
  };

  const toggle = (key, label, title) => (
    <div className="field-row" title={title}>
      <span className="field-label">{label}</span>
      <input type="checkbox" checked={!!pipeline[key]} onChange={(event) => patchPipeline({ [key]: event.target.checked })} />
    </div>
  );

  const number = (key, label, { min, max, step = 0.1 } = {}) => (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <input
        key={`${key}-${pipeline[key]}`}
        className="number-field"
        type="number"
        defaultValue={pipeline[key]}
        min={min}
        max={max}
        step={step}
        onBlur={(event) => {
          let value = Number(event.target.value);
          if (!Number.isFinite(value)) return;
          if (min != null) value = Math.max(min, value);
          if (max != null) value = Math.min(max, value);
          patchPipeline({ [key]: value });
        }}
        onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      />
    </div>
  );

  return (
    <>
      <div className="inspector-section">
          <div className="section-header">Material</div>
          <div className="asset-info-row">
            {def.shaderGraph?.nodes?.length
              ? `${def.shaderGraph.nodes.length} nodes · ${(def.shaderGraph.edges ?? []).length} connections`
              : "No shader graph — open the editor to build one"}
          </div>
          <button
            className="toolbar-btn wide"
            onClick={() => {
              useSelectionStore.getState().selectAsset(path);
              openPanel("shaderGraph");
            }}
          >
            <Workflow size={13} />
            Open Shader Graph
          </button>
      </div>
      <div className="inspector-section">
        <div className="section-header">Pipeline</div>
        <div className="field-row">
          <span className="field-label">Cull Mode</span>
          <select className="select-field" value={pipeline.cullMode} onChange={(event) => patchPipeline({ cullMode: event.target.value })}>
            <option value="back">Back Faces</option>
            <option value="front">Front Faces</option>
            <option value="none">None (Double-Sided)</option>
          </select>
        </div>
        {toggle("depthTest", "Depth Test")}
        {toggle("depthWrite", "Depth Write")}
        <div className="field-row">
          <span className="field-label">Depth Function</span>
          <select className="select-field" value={pipeline.depthFunc} disabled={!pipeline.depthTest} onChange={(event) => patchPipeline({ depthFunc: event.target.value })}>
            <option value="less-equal">Less or Equal</option>
            <option value="less">Less</option>
            <option value="equal">Equal</option>
            <option value="greater-equal">Greater or Equal</option>
            <option value="greater">Greater</option>
            <option value="not-equal">Not Equal</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </div>
        {toggle("colorWrite", "Color Write")}
        {toggle("transparent", "Transparent")}
        <div className="field-row">
          <span className="field-label">Blend Mode</span>
          <select className="select-field" value={pipeline.blendMode} onChange={(event) => patchPipeline({ blendMode: event.target.value })}>
            <option value="normal">Normal</option>
            <option value="additive">Additive</option>
            <option value="subtractive">Subtractive</option>
            <option value="multiply">Multiply</option>
            <option value="none">Disabled</option>
          </select>
        </div>
        {number("alphaTest", "Alpha Clip", { min: 0, max: 1, step: 0.01 })}
        {toggle("alphaHash", "Alpha Hash", "Stochastic alpha testing for dithered cutouts")}
        {toggle("premultipliedAlpha", "Premultiplied Alpha")}
        {toggle("polygonOffset", "Polygon Offset")}
        {pipeline.polygonOffset && number("polygonOffsetFactor", "Offset Factor", { step: 1 })}
        {pipeline.polygonOffset && number("polygonOffsetUnits", "Offset Units", { step: 1 })}
        {toggle("wireframe", "Wireframe")}
        {toggle("toneMapped", "Tone Mapped")}
        {toggle("fog", "Affected by Fog")}
        <div className="asset-hint">Pipeline changes update every mesh using this material.</div>
      </div>
    </>
  );
}

function AnimatorSummary({ path }) {
  return (
    <JsonSummary
      path={path}
      render={(graph) => (
        <div className="inspector-section">
          <div className="section-header">Controller</div>
          <div className="asset-info-row">
            {(graph.states ?? []).length} states · {(graph.transitions ?? []).length} transitions ·{" "}
            {(graph.parameters ?? []).length} parameters
          </div>
          <button
            className="toolbar-btn wide"
            onClick={() => {
              useSelectionStore.getState().selectAsset(path);
              openPanel("animator");
            }}
          >
            <Workflow size={13} />
            Edit Animator
          </button>
        </div>
      )}
    />
  );
}

/** Entities in a resolved prefab tree, counted for the summary line. */
function countNodes(node) {
  if (!node) return 0;
  return 1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
}

function PrefabSummary({ path }) {
  return (
    <JsonSummary
      path={path}
      render={(file) => {
        // `.prefab` files are defs; legacy `.entity` files are bare snapshots.
        const def = isPrefabDef(file) ? file : null;
        const guid = def?.guid ?? prefabRegistry.guidForPath(path);
        const resolved = guid ? resolvePrefab(guid) : null;
        const base = def?.variantOf ? prefabRegistry.getDef(prefabRegistry.resolveLink(def.variantOf)) : null;
        const name = def?.name ?? file.name ?? "Prefab";
        const entities = resolved ? countNodes(resolved) : countNodes(file);
        const components = resolved
          ? (resolved.components ?? []).map((c) => c.type)
          : (file.components ?? []).map((c) => c.type);

        return (
          <div className="inspector-section">
            <div className="section-header">Prefab</div>
            <div className="asset-info-row">
              <Package size={13} /> {name} · {entities} {entities === 1 ? "entity" : "entities"}
              {components.length ? ` · ${components.join(", ")}` : ""}
            </div>
            {base && <div className="asset-info-row">Variant of {base.name}</div>}
            {!def && (
              <div className="asset-hint">
                Legacy snapshot — it still works, but it isn't linked. Instances of it won't track edits to this file.
              </div>
            )}
            <button className="toolbar-btn wide" onClick={() => openPrefabMode(path)}>
              <Package size={13} />
              Open Prefab
            </button>
            <div className="asset-hint">Drag into the viewport or hierarchy to add a linked instance.</div>
          </div>
        );
      }}
    />
  );
}

// ---------------------------------------------------------------------------

/** Shown when an Assets-panel file is selected instead of an entity. */
export function AssetInspector({ path }) {
  const assetPaths = useSelectionStore((state) => state.assetPaths);
  if (assetPaths.length > 1) return <MultiAssetInspector paths={assetPaths} />;
  const ext = extOf(path);
  const isTexture = TEXTURE_EXTENSIONS.includes(ext);

  return (
    <div className="inspector-panel">
      <div className="inspector-section">
        <div className="field-row">
          <span className="field-label">Name</span>
          <input
            className="text-field"
            type="text"
            key={path}
            defaultValue={stemOf(fileName(path))}
            onBlur={(e) => renameAsset(path, e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
          />
        </div>
        <div className="field-row">
          <span className="field-label">Type</span>
          <span className="asset-type-badge">{TYPE_LABELS[ext] ?? ext.toUpperCase()}</span>
        </div>
        <div className="asset-inspector-path" title={path}>
          {path}
        </div>
        {["js", "ts"].includes(ext) && (
          <button
            className="toolbar-btn wide"
            onClick={async () => {
              const { openPath } = await import("@tauri-apps/plugin-opener");
              openPath(path).catch((err) => console.error(String(err)));
            }}
          >
            <ExternalLink size={13} />
            Open in IDE
          </button>
        )}
      </div>
      {isTexture && (
        <>
          <TexturePreview path={path} />
          <TextureSettings path={path} />
        </>
      )}
      {ext === "glb" && (
        <>
          <ModelPreview path={path} />
          <VirtualGeometrySettings path={path} />
        </>
      )}
      {ext === "geom" && <VirtualGeometrySettings path={path} />}
      {ext === "mat" && <MaterialSummary path={path} />}
      {ext === "anim" && <AnimatorSummary path={path} />}
      {(ext === "prefab" || ext === "entity") && <PrefabSummary path={path} />}
    </div>
  );
}
