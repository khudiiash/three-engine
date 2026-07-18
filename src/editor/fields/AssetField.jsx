import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useProjectStore } from "../store/projectStore.js";
import { listProjectAssets, toBlobUrl, extOf, TEXTURE_EXTENSIONS, MATERIAL_EXTENSIONS } from "../assetLoader.js";
import { MATERIAL_DEFAULTS } from "../../engine/materialAsset.js";
import { useAssetDrop } from "../assetDrag.js";

const fileName = (p) => p?.split(/[\\/]/).pop() ?? "";

// Plain white on a swatch is the classic "I haven't set a color yet" signal —
// a freshly-created .mat file is white by default and looks identical to a mesh
// that has no material assigned at all. Flag it so the user can tell the
// difference at a glance.
const isUnsetColor = (color) => !color || color.toLowerCase() === "#ffffff" || color.toLowerCase() === "white";

function relativeToRoot(path) {
  const root = useProjectStore.getState().rootPath;
  if (!root) return path;
  const norm = (p) => p.replaceAll("\\", "/");
  const r = norm(root);
  const p = norm(path);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : path;
}

/** Inline swatch/texture preview for .mat values and options. Reads the live
 *  shared material first so the swatch reflects the actual rendered color,
 *  not a stale top-level `def.color` from disk. */
function MaterialOptionThumb({ path }) {
  const [def, setDef] = useState(null);
  const [mapUrl, setMapUrl] = useState(null);
  const [liveColor, setLiveColor] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const value = { ...MATERIAL_DEFAULTS, ...JSON.parse(await invoke("read_text_file", { path })) };
        if (!live) return;
        setDef(value);
        setMapUrl(value.map ? await toBlobUrl(value.map).catch(() => null) : null);
      } catch {
        if (live) setDef((prev) => prev ?? { ...MATERIAL_DEFAULTS, color: "#888" });
      }
    })();
    let unsub = () => {};
    import("../../engine/materialAsset.js").then(({ getMaterialColorPreview, loadMaterialAsset, subscribeMaterial }) => {
      if (!live) return;
      // Make sure the cache has an entry — the swatch may mount before any
      // mesh has loaded this .mat, and the live-color walk needs an entry.
      loadMaterialAsset(path).then(() => {
        if (!live) return;
        const refresh = () => {
          if (live) setLiveColor(getMaterialColorPreview(path));
        };
        refresh();
        unsub = subscribeMaterial(path, refresh);
      });
    });
    return () => {
      live = false;
      unsub();
    };
  }, [path]);
  const color = liveColor ?? def?.color;
  const unset = isUnsetColor(color);
  return (
    <div
      className={`asset-option-thumb mat-thumb${unset ? " mat-thumb--unset" : ""}`}
      style={{ background: color ?? "#888" }}
      title={unset ? "Default color — open in the Shader Graph panel to set a real color" : undefined}
    >
      {mapUrl && <img className="mat-thumb-map" src={mapUrl} alt="" draggable={false} />}
    </div>
  );
}
/** Small inline preview for texture options/values in asset pickers. */
function TextureOptionThumb({ path }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    if (TEXTURE_EXTENSIONS.includes(extOf(path))) {
      toBlobUrl(path).then((u) => live && setUrl(u)).catch(() => {});
    } else {
      setUrl(null);
    }
    return () => (live = false);
  }, [path]);
  if (!url) return null;
  return <img className="asset-option-thumb" src={url} alt="" draggable={false} />;
}

function OptionThumb({ path }) {
  return MATERIAL_EXTENSIONS.includes(extOf(path))
    ? <MaterialOptionThumb path={path} />
    : <TextureOptionThumb path={path} />;
}
/**
 * Asset reference input: drop target + picker listing project files of the
 * right type (descriptor.exts). Value is the asset's absolute path; commit ""
 * to clear.
 */
export function AssetField({ descriptor, value, onCommit }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(null);

  const exts = descriptor.exts ?? [];
  const showThumb = value && [...TEXTURE_EXTENSIONS, ...MATERIAL_EXTENSIONS].includes(extOf(value));

  const dropRef = useAssetDrop({ accepts: exts, onDrop: onCommit });

  const browse = async () => {
    setOpen(true);
    setOptions(null);
    const root = useProjectStore.getState().rootPath;
    setOptions(await listProjectAssets(root, exts));
  };

  return (
    <div className="dropdown-wrap asset-field-wrap">
      <div
        className={`asset-field ${value ? "" : "empty"}`}
        title={value || "Drop an asset here or browse"}
        ref={dropRef}
        onClick={browse}
      >
        {showThumb && <OptionThumb path={value} />}
        <span className="asset-field-name">{value ? fileName(value) : "None"}</span>
        <span className="asset-field-caret">
          <ChevronDown size={12} />
        </span>
      </div>
      {open && (
        <>
          <div className="dropdown-overlay" onClick={() => setOpen(false)} />
          <div className="dropdown-menu asset-options">
            <button
              className="dropdown-item"
              onClick={() => {
                setOpen(false);
                onCommit("");
              }}
            >
              None
            </button>
            {options === null && <div className="dropdown-item">Loading…</div>}
            {options?.map((path) => (
              <button
                key={path}
                className="dropdown-item asset-option"
                title={path}
                onClick={() => {
                  setOpen(false);
                  onCommit(path);
                }}
              >
                <OptionThumb path={path} />
                <span className="asset-option-name">{fileName(path)}</span>
                <span className="asset-option-path">{relativeToRoot(path)}</span>
              </button>
            ))}
            {options?.length === 0 && <div className="dropdown-item">No assets found</div>}
          </div>
        </>
      )}
    </div>
  );
}
