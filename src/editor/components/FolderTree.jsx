import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useProjectStore, basename } from "../store/projectStore.js";
import { useAssetDrop } from "../assetDrag.js";
import { invoke, moveDraggedIntoFolder } from "../assetOps.js";

/**
 * Folder hierarchy sidebar for the Assets panel. Children are listed lazily
 * per-folder (a project can hold thousands of files, so there's no upfront
 * recursive walk) and cached until the project store reports a change.
 *
 * Rows are asset drop targets: dropping onto a folder moves the dragged
 * selection into it, same as dropping onto a folder tile in the grid.
 */

const EXPANDED_KEY = "engine.assets.expandedFolders.v1";

function loadExpanded() {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY)) ?? []);
  } catch {
    return new Set();
  }
}

/** Every ancestor of `path` up to and including `root`. */
function ancestorsOf(path, root) {
  if (!path || !root || !path.startsWith(root)) return [];
  const out = [root];
  const rest = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  let acc = root;
  for (const part of rest) {
    acc = `${acc}/${part}`;
    out.push(acc);
  }
  return out;
}

function FolderRow({ path, name, depth, childrenOf, expanded, onToggle, hasLoaded }) {
  const currentPath = useProjectStore((s) => s.currentPath);
  const isOpen = expanded.has(path);
  const children = childrenOf.get(path);
  const active = currentPath === path;
  // Until a folder has been listed we don't know whether it has subfolders, so
  // show the chevron optimistically and let the first expand settle it.
  const expandable = !hasLoaded(path) || (children?.length ?? 0) > 0;

  const dropRef = useAssetDrop({
    accepts: (dragged) => dragged !== path,
    hoverClass: "drop-target",
    onDrop: (dragged) => moveDraggedIntoFolder(dragged, path),
  });

  return (
    <>
      <div
        ref={dropRef}
        className={`folder-row ${active ? "active" : ""}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => useProjectStore.getState().navigate(path)}
        title={path}
      >
        <button
          className="folder-twisty"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(path);
          }}
          tabIndex={-1}
        >
          {expandable ? (
            isOpen ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : null}
        </button>
        {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
        <span className="folder-label">{name}</span>
      </div>
      {isOpen &&
        children?.map((child) => (
          <FolderRow
            key={child.path}
            path={child.path}
            name={child.name}
            depth={depth + 1}
            childrenOf={childrenOf}
            expanded={expanded}
            onToggle={onToggle}
            hasLoaded={hasLoaded}
          />
        ))}
    </>
  );
}

export function FolderTree() {
  const rootPath = useProjectStore((s) => s.rootPath);
  const currentPath = useProjectStore((s) => s.currentPath);
  const entries = useProjectStore((s) => s.entries);
  const [expanded, setExpanded] = useState(loadExpanded);
  const [childrenOf, setChildrenOf] = useState(() => new Map()); // path -> [{name, path}]
  const loadedRef = useRef(new Set());

  const hasLoaded = useCallback((path) => loadedRef.current.has(path), []);

  const listFolder = useCallback(async (path) => {
    try {
      const dirEntries = await invoke("list_dir", { path });
      const dirs = dirEntries
        .filter((e) => e.is_dir)
        .map((e) => ({ name: e.name, path: e.path }));
      loadedRef.current.add(path);
      setChildrenOf((prev) => new Map(prev).set(path, dirs));
    } catch {
      loadedRef.current.add(path);
      setChildrenOf((prev) => new Map(prev).set(path, []));
    }
  }, []);

  // A refresh (create / delete / move / rename) replaces `entries`, which is
  // our cue that the tree's cached listings may be stale. Re-list everything
  // currently visible rather than trying to guess what changed.
  useEffect(() => {
    if (!rootPath) return;
    loadedRef.current = new Set();
    const visible = [rootPath, ...[...expanded].filter((p) => p.startsWith(rootPath))];
    for (const path of new Set(visible)) listFolder(path);
    // `entries` is the change signal; `expanded` changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, entries, listFolder]);

  // List a folder the first time it's expanded.
  useEffect(() => {
    for (const path of expanded) {
      if (!loadedRef.current.has(path)) listFolder(path);
    }
  }, [expanded, listFolder]);

  // Reveal the browsed folder: expand its ancestors so it's visible in the tree.
  useEffect(() => {
    if (!currentPath || !rootPath) return;
    // Parents of the browsed folder, and the root itself (always open).
    const chain = [rootPath, ...ancestorsOf(currentPath, rootPath).slice(0, -1)];
    setExpanded((prev) => {
      if (chain.every((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      for (const p of chain) next.add(p);
      return next;
    });
  }, [currentPath, rootPath]);

  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  }, [expanded]);

  const onToggle = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (!rootPath) return null;

  return (
    <div className="folder-tree">
      <FolderRow
        path={rootPath}
        name={basename(rootPath)}
        depth={0}
        childrenOf={childrenOf}
        expanded={expanded}
        onToggle={onToggle}
        hasLoaded={hasLoaded}
      />
    </div>
  );
}
