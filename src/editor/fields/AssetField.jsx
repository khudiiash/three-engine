import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useProjectStore } from "../store/projectStore.js";
import { listProjectAssets, toBlobUrl, extOf, TEXTURE_EXTENSIONS } from "../assetLoader.js";
import { useAssetDrop } from "../assetDrag.js";

const fileName = (p) => p?.split(/[\\/]/).pop() ?? "";

function relativeToRoot(path) {
  const root = useProjectStore.getState().rootPath;
  if (!root) return path;
  const norm = (p) => p.replaceAll("\\", "/");
  const r = norm(root);
  const p = norm(path);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : path;
}

/** Small inline preview for texture options/values in asset pickers. */
function OptionThumb({ path }) {
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

/**
 * Asset reference input: drop target + picker listing project files of the
 * right type (descriptor.exts). Value is the asset's absolute path; commit ""
 * to clear.
 */
export function AssetField({ descriptor, value, onCommit }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState(null);

  const exts = descriptor.exts ?? [];
  const showThumb = value && TEXTURE_EXTENSIONS.includes(extOf(value));

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
