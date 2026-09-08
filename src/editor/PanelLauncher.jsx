import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Search } from "./icons/index.jsx";
import { PANEL_FAMILIES, PANEL_ICONS, PANEL_SPECS } from "./panelCatalog.js";
import { useConsoleStore } from "./store/consoleStore.js";

/**
 * The `+` at the end of every tab strip, and the launcher it opens.
 *
 * This is how a panel is found and opened: an icon grid of every panel in
 * five families, opened INTO THE GROUP whose `+` was pressed — next to where
 * it will appear, the way Blender's editor-type menu works. It replaces the
 * 38-item Window menu as the primary path (the menu stays for the keyboard
 * and for scripts that add entries to it).
 *
 * Rendered by Dockview as a group header action (`rightHeaderActionsComponent`),
 * so it receives the group and the container API and needs nothing from the
 * shell module — which also keeps it out of any import cycle with it.
 */
export function PanelLauncherButton({ group, containerApi }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  return (
    <>
      <ConsoleSignals group={group} containerApi={containerApi} />
      <button
        ref={buttonRef}
        type="button"
        className={`panel-launcher-button${open ? " open" : ""}`}
        title="Open a panel here"
        aria-label="Open a panel here"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      {open && (
        <PanelLauncher
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            openPanelInGroup(containerApi, group, id);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

/**
 * Two dots — red for errors, yellow for warnings — in the tab strip that hosts
 * the Console, just left of its `+`. They are the only sign the editor gives
 * that something went wrong while the Console panel is closed or buried behind
 * another tab; clicking one opens the Console (spawning it in this group if it
 * is not open at all). A dot appears when the console holds that level and
 * goes out when the user clears it — the count is in the tooltip, so nothing
 * in the strip changes width as messages arrive.
 */
function ConsoleSignals({ group, containerApi }) {
  const errors = useConsoleStore((s) => s.errorCount);
  const warnings = useConsoleStore((s) => s.warnCount);
  const host = useSignalHostGroup(group, containerApi);
  if (!host || (errors === 0 && warnings === 0)) return null;
  const parts = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  const label = `${parts.join(", ")} — open the Console`;
  return (
    <button
      type="button"
      className="dock-signals"
      title={label}
      aria-label={label}
      onClick={() => openPanelInGroup(containerApi, group, "console")}
    >
      {errors > 0 && <i className="dock-signal error" aria-hidden="true" />}
      {warnings > 0 && <i className="dock-signal warn" aria-hidden="true" />}
    </button>
  );
}

/**
 * Whether `group` is the one that shows the console's dots: the group holding
 * the Console, else the one holding the Assets panel (the bottom dock in the
 * default layout), else the lowest, right-most group. Exactly one group ever
 * answers true, and it is re-picked whenever the layout moves.
 */
function useSignalHostGroup(group, containerApi) {
  const [host, setHost] = useState(false);
  useEffect(() => {
    const pick = () => {
      let target = containerApi.getPanel("console")?.group ?? containerApi.getPanel("assets")?.group ?? null;
      if (!target) {
        for (const candidate of containerApi.groups ?? []) {
          if (!target) {
            target = candidate;
            continue;
          }
          const a = candidate.element.getBoundingClientRect();
          const b = target.element.getBoundingClientRect();
          if (a.bottom > b.bottom + 1 || (Math.abs(a.bottom - b.bottom) <= 1 && a.right > b.right)) target = candidate;
        }
      }
      setHost(target === group);
    };
    pick();
    const disposable = containerApi.onDidLayoutChange?.(pick);
    return () => disposable?.dispose?.();
  }, [group, containerApi]);
  return host;
}

/**
 * Opens `id` in `group`: moves it there if it is open elsewhere, adds it there
 * if it is not. Dockview positions a new panel by `referenceGroup`, and moving
 * an existing one is `moveTo({ group })`; both leave it active.
 */
export function openPanelInGroup(containerApi, group, id) {
  const spec = PANEL_SPECS[id];
  if (!spec) return;
  const existing = containerApi.getPanel(id);
  if (existing) {
    try {
      if (existing.group !== group) existing.api.moveTo({ group });
    } catch (err) {
      console.warn(`Panel launcher: could not move ${id} (${err?.message ?? err})`);
    }
    existing.api.setActive();
    return;
  }
  const { position: _ignored, ...rest } = spec;
  const options = { id, component: id, ...rest, position: { referenceGroup: group } };
  delete options.icon;
  if (id === "console") options.tabComponent = "console";
  try {
    containerApi.addPanel(options);
  } catch (err) {
    console.warn(`Panel launcher: could not open ${id} here (${err?.message ?? err}); opening at its default place.`);
    delete options.position;
    containerApi.addPanel(options);
  }
}

const LAUNCHER_WIDTH = 560;

function PanelLauncher({ anchorRef, onClose, onPick }) {
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const inputRef = useRef(null);
  const boxRef = useRef(null);

  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    let left = r.right - LAUNCHER_WIDTH;
    if (left < 8) left = 8;
    if (left + LAUNCHER_WIDTH > window.innerWidth - 8) left = window.innerWidth - LAUNCHER_WIDTH - 8;
    let top = r.bottom + 6;
    const height = boxRef.current?.offsetHeight ?? 420;
    if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - 6);
    setPos({ left, top });
    inputRef.current?.focus();
  }, [anchorRef]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [anchorRef, onClose]);

  const q = query.trim().toLowerCase();
  const matches = (id) => !q || PANEL_SPECS[id].title.toLowerCase().includes(q) || id.toLowerCase().includes(q);
  const families = PANEL_FAMILIES.map((f) => ({ ...f, ids: f.ids.filter(matches) })).filter((f) => f.ids.length);
  const first = families[0]?.ids[0];

  return createPortal(
    <div
      ref={boxRef}
      className="panel-launcher"
      role="dialog"
      aria-label="Open a panel here"
      style={{ left: pos.left, top: pos.top, width: LAUNCHER_WIDTH }}
    >
      <label className="panel-launcher-search">
        <Search size={12} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          placeholder="Find a panel"
          aria-label="Find a panel"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && first) onPick(first);
          }}
        />
      </label>
      {families.map((family) => (
        <div className="panel-launcher-family" key={family.title}>
          <div className="panel-launcher-family-title">{family.title}</div>
          <div className="panel-launcher-grid">
            {family.ids.map((id) => {
              const Icon = PANEL_ICONS[id];
              return (
                <button key={id} type="button" className="panel-launcher-item" onClick={() => onPick(id)}>
                  {Icon ? <Icon size={18} aria-hidden="true" /> : null}
                  <span>{PANEL_SPECS[id].title}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
