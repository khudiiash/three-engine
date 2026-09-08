import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { onThumbInvalidated, requestThumb, thumbKind } from "../assetThumbs.js";
import { samePath } from "../assetReveal.js";

/**
 * The preview of an asset, wherever one is shown: the Assets grid, a picker's
 * rows, a picker's current value, the inspector's hero, the hover peek.
 * One hook, one source (`assetThumbs.js`), so a material looks the same
 * everywhere and updates everywhere when it changes.
 */
export function useAssetThumb(path) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (!path || !thumbKind(path)) return undefined;
    const load = () => {
      requestThumb(path)
        .then((next) => {
          if (live) setUrl(next);
        })
        .catch(() => {});
    };
    load();
    const off = onThumbInvalidated((kind, changed) => {
      if (!live || kind !== thumbKind(path)) return;
      if (changed === null || samePath(changed, path)) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [path]);
  return url;
}

const fileName = (p) => String(p ?? "").split(/[\\/]/).pop() ?? "";

/** A square thumbnail; a quiet placeholder while it renders, nothing for an
 *  asset that has no preview. */
export function AssetThumb({ path, size = 40, className = "", title = undefined, fill = false }) {
  const url = useAssetThumb(path);
  if (!path || !thumbKind(path)) return null;
  const style = fill ? { width: "100%", height: "100%" } : { width: size, height: size };
  if (!url) return <span className={`asset-thumb-fallback ${className}`.trim()} style={style} aria-hidden="true" />;
  return <img className={className} src={url} alt="" title={title} draggable={false} style={style} />;
}

/**
 * The hover peek: a large preview floating beside whatever the pointer is on
 * (a picker row, a field's current value). Positioned from the anchor's rect,
 * flips to the left when it would leave the window, never takes the pointer.
 */
export function AssetPeek({ path, rect }) {
  const url = useAssetThumb(path);
  if (!url || !rect) return null;
  const wide = thumbKind(path) === "equirect";
  const width = wide ? 320 : 252;
  const height = wide ? 200 : 292;
  let left = rect.right + 10;
  if (left + width > window.innerWidth - 8) left = Math.max(8, rect.left - width - 10);
  let top = rect.top + rect.height / 2 - height / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  return createPortal(
    <div className={`asset-peek${wide ? " wide" : ""}`} style={{ left, top, width }} aria-hidden="true">
      <img src={url} alt="" draggable={false} />
      <div className="asset-peek-name">{fileName(path)}</div>
    </div>,
    document.body,
  );
}

/** The inspector's hero for a material: the sphere, full width. */
export function MaterialPreview({ path }) {
  const url = useAssetThumb(path);
  return (
    <div className="asset-preview material-preview">
      {url ? <img src={url} alt="" draggable={false} /> : <div className="asset-preview-pending" />}
    </div>
  );
}

/** The inspector's (and Scene Settings') hero for a panorama: the 2:1 strip. */
export function EquirectPreview({ path }) {
  const url = useAssetThumb(path);
  return (
    <div className="asset-preview equirect-preview">
      {url ? <img src={url} alt="" draggable={false} /> : <div className="asset-preview-pending" />}
    </div>
  );
}
