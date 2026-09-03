import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  FileBox,
  PanelsTopLeft,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useProjectStore } from "./store/projectStore.js";
import { useSceneStore } from "./store/sceneStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { listProjectEntries, withoutSidecars } from "./assetLoader.js";
import { openPanel } from "./EditorShell.jsx";
import { useAssetRevealStore } from "./assetReveal.js";
import { keyScopeOwns } from "./keyScope.js";
import { makeItem, score, TYPE_WEIGHT } from "./quickSearchRank.js";

const PANELS = [
  ["viewport", "Viewport"], ["game", "Game"], ["hierarchy", "Hierarchy"],
  ["inspector", "Inspector"], ["assets", "Assets"], ["console", "Console"],
  ["shaderGraph", "Shader Graph"], ["particles", "Particles"], ["animator", "Animator"],
  ["timeline", "Timeline"], ["sceneSettings", "Scene Settings"],
  ["projectSettings", "Project Settings"], ["build", "Build"], ["modules", "Modules"],
  ["input", "Input"], ["events", "Events"], ["eventGraph", "Event Graph"], ["geometryEditor", "Geometry Editor"], ["postprocess", "Post Process"],
  ["polyhaven", "Poly Haven"], ["ambientcg", "AmbientCG"], ["sketchfab", "Sketchfab"],
  ["polypizza", "Poly Pizza"], ["kaykit", "KayKit"], ["fab", "Fab"],
  ["itchio", "itch.io"], ["audioLibrary", "Audio Library"], ["audioEditor", "Audio Editor"],
  ["terminal", "Terminal"], ["mcp", "Assistant (MCP)"],
  // The panel id doubles as a search keyword (see `panelItems`), so "git"
  // finds this even though the panel is called Source Control.
  ["git", "Source Control"],
];

const SETTINGS = [
  ["sceneSettings", "Scene Settings", ["Environment", "Background", "Ambient", "Intensity", "Cube Map", "Show as Sky", "Use for Lighting", "Fog", "Type", "Color", "Near", "Far", "Density", "Tone mapping", "Exposure", "Shadows", "Performance", "Max device pixel ratio", "Render scale", "Dynamic res", "Target FPS", "Volume quality", "Occlusion culling", "Renderer", "Antialias", "MSAA samples", "Transparent", "Shadow", "Map type"]],
  ["projectSettings", "Project Settings", ["Editor", "Autosave", "Snap move", "Snap rotate", "Snap scale", "Show grid", "Grid size", "Divisions", "Keybindings", "Scripts", "Hot reload", "Poll", "Performance", "Pixel ratio cap", "Game", "Title", "Main scene", "Saves", "Save id", "Save version", "Physics Layers"]],
];

function ResultIcon({ type }) {
  const Icon = type === "entity" ? Box : type === "asset" ? FileBox : type === "panel" ? PanelsTopLeft : Settings2;
  return <Icon size={15} strokeWidth={1.8} aria-hidden="true" />;
}

export function QuickSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [projectAssets, setProjectAssets] = useState([]);
  const inputRef = useRef(null);
  const rootPath = useProjectStore((s) => s.rootPath);
  const changeCounter = useProjectStore((s) => s.changeCounter);
  const entities = useSceneStore((s) => s.entities);

  useEffect(() => {
    const onKey = (event) => {
      // Capture phase, so this has to check ownership itself: a code editor
      // claims Ctrl+F for its own find widget, and stealing it here meant the
      // widget could never be opened. Every other context lets it through.
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f" &&
        !keyScopeOwns(event)
      ) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
        setQuery("");
        setActive(0);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open || !rootPath) return;
    let live = true;
    listProjectEntries(rootPath)
      .then((entries) => live && setProjectAssets(withoutSidecars(entries).filter((entry) => !entry.is_dir)))
      .catch(() => live && setProjectAssets([]));
    return () => { live = false; };
  }, [open, rootPath, changeCounter]);

  // Every `key` below has to be UNIQUE, and that is not a detail. The list used
  // to be keyed on `type:title:subtitle`, so a scene with two entities both
  // named "Light Stand" gave them the same key — and React's own warning says
  // the result is children "duplicated and/or omitted". That is exactly what it
  // did: rows from the PREVIOUS query survived reconciliation and sat above the
  // real match, while the footer count (read from the array, not the DOM)
  // correctly said "1 result".
  const allItems = useMemo(() => {
    const entityItems = Object.values(entities).map((entity) => makeItem({
      key: `entity:${entity.id}`,
      type: "entity",
      title: entity.name || entity.id,
      subtitle: "Entity · Hierarchy",
      // Tags are searchable; the id only as a WHOLE — see quickSearchRank.js.
      terms: entity.tags ?? [],
      exact: entity.id,
      activate: () => { useSelectionStore.getState().select(entity.id); openPanel("inspector"); },
    }));
    const assetItems = projectAssets.map((entry) => makeItem({
      key: `asset:${entry.path}`,
      type: "asset",
      title: entry.name,
      subtitle: `Asset · ${entry.path}`,
      terms: [entry.path],
      activate: async () => {
        const project = useProjectStore.getState();
        openPanel("assets");
        const dir = entry.path.replace(/[\\/][^\\/]+$/, "");
        if (dir && dir !== project.currentPath) await project.navigate(dir);
        // Select AFTER navigating. Browsing to a folder clears the asset
        // selection (the old paths aren't on screen any more), so selecting
        // first left the tile revealed but unselected — and "press Enter to
        // open it" needs a visibly selected subject.
        useSelectionStore.getState().selectAsset(entry.path);
        useAssetRevealStore.getState().reveal(entry.path, { focus: true });
      },
    }));
    const panelItems = PANELS.map(([id, title]) => makeItem({
      key: `panel:${id}`,
      type: "panel",
      title,
      subtitle: "Panel",
      // The panel id doubles as a keyword, so "git" finds "Source Control".
      terms: [id],
      activate: () => openPanel(id),
    }));
    const settingItems = SETTINGS.flatMap(([id, title, properties]) => properties.map((property) => makeItem({
      key: `setting:${id}:${property}`,
      type: "setting",
      title: property,
      subtitle: `Settings · ${title}`,
      terms: [title],
      activate: () => {
        openPanel(id);
        window.setTimeout(() => {
          const labels = [...document.querySelectorAll(".field-label, .section-header")];
          labels.find((label) => label.textContent.trim().toLocaleLowerCase().includes(property.toLocaleLowerCase()))?.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 80);
      },
    })));
    return [...entityItems, ...assetItems, ...panelItems, ...settingItems];
  }, [entities, projectAssets]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return allItems.slice().sort((a, b) => TYPE_WEIGHT[a.type] - TYPE_WEIGHT[b.type] || a.title.localeCompare(b.title)).slice(0, 60);
    return allItems.map((item) => ({ item, rank: score(item, q) })).filter((x) => x.rank >= 0)
      .sort((a, b) => b.rank - a.rank || a.item.title.localeCompare(b.item.title)).slice(0, 60).map((x) => x.item);
  }, [allItems, query]);

  useEffect(() => setActive((value) => Math.min(value, Math.max(0, results.length - 1))), [results.length]);

  const choose = async (item) => {
    setOpen(false);
    await item.activate();
  };

  if (!open) return null;
  return (
    <div className="quick-search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="quick-search" role="dialog" aria-label="Quick search">
        <div className="quick-search-input-wrap">
          <Search size={17} />
          <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((v) => Math.min(v + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((v) => Math.max(v - 1, 0)); }
              else if (e.key === "Enter" && results[active]) { e.preventDefault(); choose(results[active]); }
              else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
            }}
            placeholder="Search assets, entities, panels, and settings…" autoComplete="off" />
          <button type="button" className="quick-search-close" onClick={() => setOpen(false)} aria-label="Close search"><X size={15} /></button>
        </div>
        <div className="quick-search-results">
          {results.length ? results.map((item, index) => (
            <button type="button" key={item.key} className={`quick-search-result ${index === active ? "active" : ""}`}
              onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
              <span className={`quick-search-kind ${item.type}`}><ResultIcon type={item.type} /></span>
              <span className="quick-search-copy"><span className="quick-search-title">{item.title}</span><span className="quick-search-subtitle">{item.subtitle}</span></span>
              <span className="quick-search-enter"><CornerDownLeft size={13} /></span>
            </button>
          )) : <div className="quick-search-empty">No matching editor items</div>}
        </div>
        <div className="quick-search-footer">
          <span className="quick-search-result-count">{results.length ? `${results.length} result${results.length === 1 ? "" : "s"}` : "No results"}</span>
          <span className="quick-search-hint"><kbd><ChevronUp size={11} /><ChevronDown size={11} /></kbd> Navigate</span>
          {/* Assets are the one type Enter doesn't finish: it lands you on the
              tile in the Assets panel, and a second Enter there opens it. Say
              so, rather than promising "Open" and revealing. */}
          <span className="quick-search-hint">
            <kbd><CornerDownLeft size={11} /></kbd>{" "}
            {results[active]?.type === "asset" ? "Reveal (⏎ again opens)" : "Open"}
          </span>
          <span className="quick-search-hint"><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
