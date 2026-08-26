import { useEffect, useRef, useState } from "react";
import { Boxes, Download, ExternalLink, Loader2, Search } from "lucide-react";
import { useModulesStore, setModuleEnabled } from "../modules.js";
import { useProjectStore } from "../store/projectStore.js";
import {
  IMPORT_FORMATS,
  LISTING_TYPES,
  PREVIEW_AUTO_LIMIT,
  downloadListing,
  fetchListing,
  fetchPreviewArchive,
  openListingPage,
  previewPlan,
  extractArchive,
  searchListings,
} from "../fab.js";
import { AssetPreview } from "../components/AssetPreview.jsx";
import { loadArchivePreview } from "../previewSources.js";

const formatMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/**
 * Fab's browse/import grid — the same shape as the Poly Pizza and Sketchfab
 * panels, with three differences that come from the marketplace rather than
 * taste:
 *
 *   - **No API key anywhere.** Fab's read API and its download URLs for free
 *     assets are anonymous, so there is no connect prompt, no Modules-panel
 *     credential row and no authbar. It is the only browser here like that.
 *
 *   - **"Free (CC-BY) only" is a filter, and it defaults on.** Most of Fab is
 *     paid. The toggle is offered rather than hardcoded because searching the
 *     whole catalogue is genuinely useful — you may want to *find* the paid
 *     asset and open it on Fab — but the download button is only ever enabled
 *     on assets whose licence makes them free, and the client refuses anything
 *     else even if a caller gets past the UI.
 *
 *   - **Paging is a cursor, so there is no total.** Unlike Poly Pizza, the API
 *     returns a `next` URL and no match count, so the button says "Load more"
 *     and the end is discovered by reaching it. There is deliberately no sort
 *     dropdown either: measured, `sort_by`'s value is ignored by the endpoint
 *     (see fab.js), and a control that does nothing is worse than no control.
 */
export function FabPanel() {
  const moduleOn = useModulesStore((state) => state.enabled.includes("fab"));
  const hasProject = useProjectStore((state) => !!state.rootPath);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({
    query: "",
    listingType: "3d-model",
    format: "",
    freeOnly: true,
  });
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const gridRef = useRef(null);

  useEffect(() => {
    if (!moduleOn) return undefined;
    let alive = true;
    setItems(null);
    setNext(null);
    setError(null);
    setSelectedId(null);
    gridRef.current?.scrollTo?.(0, 0);
    searchListings(filters).then(
      (result) => {
        if (!alive) return;
        setItems(result.listings);
        setNext(result.next);
      },
      (err) => alive && setError(err.message ?? String(err)),
    );
    return () => {
      alive = false;
    };
  }, [moduleOn, filters]);

  const selected = (items ?? []).find((item) => item.id === selectedId) ?? null;

  const submit = (event) => {
    event.preventDefault();
    setFilters((current) => ({ ...current, query: query.trim() }));
  };

  const setFilter = (patch) => setFilters((current) => ({ ...current, ...patch }));

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      // The cursor already carries every filter, so it is passed alone rather
      // than merged with the current ones — rebuilding the query around it
      // would page a different search than the one on screen.
      const result = await searchListings({ nextUrl: next });
      setItems((current) => [...(current ?? []), ...result.listings]);
      setNext(result.next);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoadingMore(false);
    }
  };

  if (!moduleOn) {
    return (
      <div className="ph-panel">
        <div className="ph-gate">
          <Boxes size={28} />
          <h3>Fab</h3>
          <p>
            Browse Fab — Epic's marketplace, where the Unreal Marketplace, the Sketchfab store and
            Quixel Megascans all ended up — and import its free Creative Commons assets. Most ship
            glTF alongside the Unreal build, and one listing is often a whole pack. No account
            needed.
          </p>
          <button className="toolbar-btn wide" onClick={() => setModuleEnabled("fab", true)}>
            Enable Fab module
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ph-panel sf-panel">
      <form className="ph-toolbar" onSubmit={submit}>
        <div className="ph-search">
          <Search size={13} />
          <input
            type="text"
            placeholder="Search Fab"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button className="toolbar-btn" type="submit">Search</button>
        <select
          className="ph-category"
          value={filters.listingType}
          onChange={(event) => setFilter({ listingType: event.target.value })}
        >
          {LISTING_TYPES.map((value) => (
            <option key={value.id} value={value.id}>{value.label}</option>
          ))}
        </select>
        <select
          className="ph-category"
          value={filters.format}
          onChange={(event) => setFilter({ format: event.target.value })}
          title="Which mesh format the listing must ship. Fab's Unreal-only listings cannot be imported here, so they are never shown."
        >
          <option value="">Any importable format</option>
          {IMPORT_FORMATS.map((value) => (
            <option key={value.id} value={value.id}>{value.label}</option>
          ))}
        </select>
        <label className="pp-animated" title="Creative Commons Attribution — free for any use, credit required">
          <input
            type="checkbox"
            checked={filters.freeOnly}
            onChange={(event) => setFilter({ freeOnly: event.target.checked })}
          />
          Free only
        </label>
      </form>

      <div className="ph-body">
        <div className="ph-grid-scroll" ref={gridRef}>
          {error && !items ? (
            <div className="ph-status">Couldn't reach Fab: {error}</div>
          ) : items === null ? (
            <div className="ph-status"><Loader2 size={14} className="ph-spin" /> Loading catalog…</div>
          ) : items.length === 0 ? (
            <div className="ph-status">No listings match those filters.</div>
          ) : (
            <>
              <div className="ph-grid">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className={`ph-tile${item.id === selectedId ? " active" : ""}`}
                    onClick={() => setSelectedId(item.id)}
                    title={`${item.name} by ${item.author}`}
                  >
                    {item.thumbnailUrl
                      ? <img src={item.thumbnailUrl} loading="lazy" alt={item.name} draggable={false} />
                      : <div className="sf-thumb-empty">3D</div>}
                    {/* The price is the thing a Fab grid has to say out loud —
                        it is the only browser here where most tiles are not
                        free, and a thumbnail hides that completely. */}
                    <span className={`sf-badge${item.ccBy ? " fab-badge-free" : ""}`}>
                      {item.ccBy ? "CC-BY" : item.price ? `$${item.price}` : "Paid"}
                    </span>
                    <span className="ph-tile-name">{item.name}</span>
                  </div>
                ))}
              </div>
              {next && (
                <button className="toolbar-btn wide ph-more" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore
                    ? <><Loader2 size={13} className="ph-spin" /> Loading…</>
                    : `Load more (${items.length} so far)`}
                </button>
              )}
              {error && <div className="ph-error sf-load-error">{error}</div>}
            </>
          )}
        </div>
        {selected && (
          <ListingDetail
            key={selected.id}
            listing={selected}
            hasProject={hasProject}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

function ListingDetail({ listing, hasProject, onClose }) {
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  // Search results carry no description and no medias — so no interactive
  // preview — and the detail endpoint carries both. Fetched on selection
  // rather than for every tile in the grid, which would be 24 requests a page.
  const [detail, setDetail] = useState(null);
  // The native fallback, for the ~9 listings in 10 that publish no viewer of
  // their own. Null while unknown, false when there is nothing previewable.
  const [plan, setPlan] = useState(null);
  const [optedIn, setOptedIn] = useState(false);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setPlan(null);
    setOptedIn(false);
    fetchListing(listing.id).then(
      (value) => alive && setDetail(value),
      // A failed enrichment is not worth an error box: the search result on
      // its own still renders a usable pane, just without the live preview.
      () => {},
    );
    // Always asked, even when Fab publishes its own viewer: the plan is what
    // says whether this listing ships anything importable at all, and that
    // gates the download button as well as the fallback preview.
    previewPlan(listing).then(
      (value) => alive && setPlan(value ?? false),
      () => alive && setPlan(false),
    );
    return () => {
      alive = false;
    };
  }, [listing.id, listing.previewUrl]);

  const model = detail ?? listing;
  // Fab publishes its own 3D viewer for only about one free listing in ten, so
  // the rest are previewed by actually reading the archive. That costs real
  // bytes, and the size is known before committing to them — so small ones load
  // on selection like every other browser here, and large ones wait for a click
  // that says how much it will cost.
  const embed = model.previewUrl;
  const native = !embed && plan ? plan : null;
  const autoLoads = native && native.size > 0 && native.size <= PREVIEW_AUTO_LIMIT;
  const showNative = native && (autoLoads || optedIn);

  const runDownload = async () => {
    setError(null);
    setDone(null);
    setProgress({ label: "Starting…" });
    try {
      const result = await downloadListing(model, setProgress);
      setDone(
        result.imported > 1
          ? `Imported ${result.imported} models with attribution ✓`
          : "Model imported with attribution ✓",
      );
      console.log(`Fab: imported "${model.name}" by ${model.author}`);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="ph-detail">
      <button className="ph-detail-close" onClick={onClose} title="Close">×</button>
      {/* Fab's own viewer rather than ours: the geometry behind it is an
          Epic-proprietary `.binz` container, and the real archive is megabytes
          we should not spend on a hover. Falls back to the still while the
          detail request is in flight, and for listings with no 3D media. */}
      <AssetPreview
        src={showNative ? native.key : null}
        load={showNative
          ? () => fetchPreviewArchive(native)
              .then((bytes) => extractArchive(bytes, native.fileName))
              .then(loadArchivePreview)
          : null}
        embedUrl={embed}
        thumbnailUrl={model.thumbnailUrl}
        alt={model.name}
      />
      {/* Fab's Unreal-only listings are a real category, and the honest place
          to say so is next to the button that would otherwise fail. */}
      {plan === false && (
        <div className="ph-status">
          This listing ships only Unreal Engine files — nothing this engine can import. Use the
          format filter to see only listings with glTF, GLB or FBX.
        </div>
      )}
      {native && !showNative && (
        <button className="toolbar-btn wide" onClick={() => setOptedIn(true)}>
          Load 3D preview ({native.label}, {formatMb(native.size)})
        </button>
      )}
      <h3 className="ph-detail-name">{model.name}</h3>
      <div className="ph-detail-meta">
        <span>by {model.author}</span>
        <span>{model.license}</span>
        {model.category && <span>{model.category}</span>}
        {model.reviews > 0 && <span>{model.rating.toFixed(1)} ★ · {model.reviews.toLocaleString()} reviews</span>}
        {model.formats.length > 0 && <span>Formats: {model.formats.join(", ")}</span>}
      </div>
      {model.tags.length > 0 && (
        <div className="ph-detail-cats">
          {model.tags.slice(0, 6).map((value) => <span className="ph-chip" key={value}>{value}</span>)}
        </div>
      )}
      {model.description && <p className="sf-description">{model.description.replace(/<[^>]*>/g, " ")}</p>}
      {!hasProject && <div className="ph-status">Open a project to download.</div>}
      {progress ? (
        <div className="ph-progress">
          <div className="ph-progress-bar"><div className="ph-progress-fill sf-progress" /></div>
          <span>{progress.label}</span>
        </div>
      ) : (
        <div className="ph-detail-actions">
          <button
            className="toolbar-btn wide"
            disabled={!hasProject || !model.ccBy || plan === false}
            title={
              !model.ccBy
                ? "Only free CC-BY listings can be imported here"
                : plan === false
                  ? "This listing ships no format this engine can read"
                  : ""
            }
            onClick={runDownload}
          >
            <Download size={13} /> Download &amp; import
          </button>
          <button className="toolbar-btn wide" onClick={() => openListingPage(model).catch((err) => setError(String(err)))}>
            <ExternalLink size={13} /> Open on Fab
          </button>
        </div>
      )}
      {/* Every asset this panel can import is CC-BY, and CC-BY's credit line is
          a condition of use rather than a courtesy — so it is said next to the
          button, not filed in a list nobody opens at ship time. */}
      <div className="sf-license-note">
        {model.ccBy
          ? `Credit required: "${model.name}" by ${model.author}. Saved to ATTRIBUTION.md on import.`
          : "This listing is paid — open it on Fab to buy it. Free CC-BY listings import directly."}
      </div>
      {done && <div className="ph-done">{done}</div>}
      {error && <div className="ph-error">{error}</div>}
    </div>
  );
}
