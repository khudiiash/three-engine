import { useEffect, useRef, useState } from "react";
import { ExternalLink, Workflow, Package } from "lucide-react";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useProjectStore } from "../store/projectStore.js";
import { toBlobUrl, extOf, TEXTURE_EXTENSIONS } from "../assetLoader.js";
import { TEXTURE_META_DEFAULTS } from "../../engine/textureMeta.js";
import { refreshMaterialsUsingTexture } from "../../engine/materialAsset.js";
import { MaterialEditor } from "./MaterialPanel.jsx";
import { openPanel } from "../EditorShell.jsx";

const fileName = (p) => p?.split(/[\\/]/).pop() ?? "";
const stemOf = (name) => name.replace(/\.[^.]+$/, "");

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
  mat: "Material",
  anim: "Animator",
  entity: "Prefab",
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
    setInfo(null);
    setError(null);

    (async () => {
      try {
        const gltf = await new GLTFLoader().loadAsync(await toBlobUrl(path));
        let meshes = 0;
        let tris = 0;
        gltf.scene.traverse((o) => {
          if (o.isMesh) {
            meshes++;
            tris += (o.geometry.index?.count ?? o.geometry.attributes.position?.count ?? 0) / 3;
          }
        });
        if (disposed) return;
        setInfo({ meshes, tris: Math.round(tris), clips: (gltf.animations ?? []).map((c) => c.name) });

        const canvas = canvasRef.current;
        if (!canvas) return;
        renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio ?? 1);
        await renderer.init();
        if (disposed) return;
        const width = canvas.clientWidth || 280;
        const height = canvas.clientHeight || 190;
        renderer.setSize(width, height, false);

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

function PrefabSummary({ path }) {
  return (
    <JsonSummary
      path={path}
      render={(prefab) => (
        <div className="inspector-section">
          <div className="section-header">Prefab</div>
          <div className="asset-info-row">
            <Package size={13} /> {prefab.name} · {(prefab.components ?? []).map((c) => c.type).join(", ") || "empty"}
          </div>
          <div className="asset-hint">Drag into the viewport to add it to the scene.</div>
        </div>
      )}
    />
  );
}

// ---------------------------------------------------------------------------

/** Shown when an Assets-panel file is selected instead of an entity. */
export function AssetInspector({ path }) {
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
      {ext === "glb" && <ModelPreview path={path} />}
      {ext === "mat" && <MaterialEditor matPath={path} />}
      {ext === "anim" && <AnimatorSummary path={path} />}
      {ext === "entity" && <PrefabSummary path={path} />}
    </div>
  );
}
