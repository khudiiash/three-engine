import { useEffect, useRef, useState } from "react";
import { ModelPreview } from "./ModelPreview.jsx";

/**
 * The "what am I about to import" pane, for every asset browser.
 *
 * A thumbnail cannot answer that question. It cannot tell you the back of the
 * model is unfinished, that the silhouette only works from one angle, or —
 * for a rigged character — whether the walk cycle is usable. So every browser's
 * detail pane shows something you can turn, and this component picks HOW
 * depending on what the provider actually gives us:
 *
 *   1. **A model file we can load** (`src`, optionally with a custom `load`) →
 *      the engine's own {@link ModelPreview}: our renderer, our lighting, our
 *      clip selector. Poly Pizza (a plain CDN `.glb`), Poly Haven (a `.gltf`
 *      whose siblings resolve off the same CORS-open CDN) and ambientCG (OBJ
 *      built in memory from its ZIP) all take this path.
 *
 *   2. **The provider's own embedded viewer** (`embedUrl`) → an iframe.
 *      Sketchfab and Fab both fall here, for the same reason: neither will
 *      hand over geometry without an authenticated, multi-megabyte archive
 *      download, and downloading one per click to spin a thumbnail is not a
 *      preview, it is an import. Both publish an embeddable viewer page that
 *      is free, anonymous and instant — Sketchfab's `embedUrl` comes straight
 *      back on the search result, and Fab's is the `type: "model"` media.
 *
 *   3. **Neither** → the still, which is what we had everywhere before.
 *
 * The fallback chain runs downward, never upward: a provider that offers a
 * loadable model gets the native path even if it also has an embed, because
 * ours honours the editor's theme, costs no network round-trip after the
 * fetch, and does not put a third-party page inside the editor.
 */

/**
 * A provider's own viewer, in an iframe.
 *
 * ## Why an iframe is acceptable here
 *
 * These are read-only viewer pages on hosts the panel already talks to, and
 * the alternative is no interactive preview at all for two of the six
 * browsers. It is still sandboxed to the minimum that a WebGL viewer needs:
 * scripts to run, and same-origin so the viewer can reach its own API and
 * asset CDN. `allow-same-origin` is safe in this direction — it means the
 * frame keeps ITS origin (sketchfab.com, fab.com), which is what stops it
 * reaching into the editor; it does not grant it ours. Forms, popups,
 * downloads and top-level navigation are all withheld.
 *
 * ## Load state
 *
 * A cross-origin iframe cannot tell us it failed — `onError` does not fire for
 * an HTTP error inside the frame, and its content is unreadable. So the
 * spinner clears on `onLoad` and, failing that, on a timeout: an embed that
 * never loads leaves the frame showing whatever the provider rendered rather
 * than a spinner that spins forever.
 */
function EmbedPreview({ url, title }) {
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    setLoaded(false);
    // Long enough that a slow viewer is not accused of failing, short enough
    // that a dead one stops pretending to be busy.
    timerRef.current = setTimeout(() => setLoaded(true), 12000);
    return () => clearTimeout(timerRef.current);
  }, [url]);

  return (
    <div className="model-preview-3d">
      <div className="model-preview-stage">
        <iframe
          key={url}
          className="model-preview-embed"
          src={url}
          title={title}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          sandbox="allow-scripts allow-same-origin"
          allow="autoplay; fullscreen; xr-spatial-tracking"
          referrerPolicy="strict-origin-when-cross-origin"
        />
        {!loaded && <div className="model-preview-loading">Loading preview…</div>}
      </div>
      <div className="model-preview-clipname">Interactive preview — drag to turn</div>
    </div>
  );
}

export function AssetPreview({
  src = null,
  load = null,
  embedUrl = null,
  thumbnailUrl = null,
  alt = "",
  className = "",
}) {
  // A source that turns out to be unreadable falls DOWN the chain rather than
  // parking an error string where the asset should be. Some formats genuinely
  // cannot be loaded — three's FBXLoader rejects FBX variants that ship no
  // normals array, and Fab's free catalogue contains them — and a thumbnail
  // still answers "what is this", which an exception does not.
  const [failed, setFailed] = useState(null);
  useEffect(() => setFailed(null), [src, embedUrl]);

  if (src && failed !== src) {
    return <ModelPreview src={src} load={load} onError={() => setFailed(src)} className={className} />;
  }
  if (embedUrl) return <EmbedPreview url={embedUrl} title={alt || "3D preview"} />;
  // Deliberately NOT wrapped in the stage box: `ph-detail-preview` paints its
  // own background and rounds its own corners, and layering the two
  // double-draws the frame.
  if (thumbnailUrl) {
    return (
      <>
        <img className="ph-detail-preview" src={thumbnailUrl} alt={alt} draggable={false} />
        {failed && <div className="model-preview-clipname">3D preview unavailable for this file</div>}
      </>
    );
  }
  return null;
}
