import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "./icons/index.jsx";
import { PANEL_ICONS } from "./panelCatalog.js";

/**
 * The tab every dock panel gets (Dockview's `defaultTabComponent`).
 *
 * Icon-first: the panel's glyph is always shown; its name is inline only on
 * the active tab of a group. Hovering an inactive tab floats its name in a
 * small chip under the tab (a portal, `.tab-tip`) rather than sliding the
 * label open in place: a tab that grows on hover changes the strip's width,
 * and Dockview folds tabs into its overflow chip whenever the strip
 * overflows — so a hover in a narrow group used to reshuffle the strip
 * under the pointer. Nothing here changes width except activation, which is
 * one discrete change Dockview measures once.
 *
 * Close keeps its 16 px on the active tab and shows on hover — a permanent ×
 * on every tab, including Viewport / Hierarchy / Inspector which nobody
 * closes on purpose, was the single most repeated glyph on screen.
 *
 * Mirrors the default tab's DOM (`.dv-default-tab` / `-content` / `-action`)
 * and its pointer behaviour (middle-click closes) so Dockview's own drag,
 * activation and overflow logic keep working unchanged. `badge` is an
 * optional extra node after the label — the Console's unread-error count.
 */
export function PanelTab({ api, tabLocation, badge = null }) {
  const [title, setTitle] = useState(api.title ?? api.id);
  useEffect(() => {
    const disposable = api.onDidTitleChange?.((event) => setTitle(event.title));
    return () => disposable?.dispose();
  }, [api]);
  // "Active" here is the tab Dockview underlines: the panel its GROUP shows,
  // which the api calls visible. `api.isActive` is narrower — the shown panel
  // of the focused group — and went false for every other group's tab.
  const [active, setActive] = useState(!!api.isVisible);
  useEffect(() => {
    setActive(!!api.isVisible);
    const disposable = api.onDidVisibilityChange?.((event) => setActive(!!event.isVisible));
    return () => disposable?.dispose();
  }, [api]);

  // The active tab is always in view. Dockview does not hide the tabs its
  // overflow chip lists — it clips them and expects the strip to scroll —
  // and its own scroll-on-activate runs before the name has laid out, so a
  // narrow group showed the active tab cut to "Pr" beside the chip. This
  // scrolls after layout, and again whenever the strip is resized.
  const rootRef = useRef(null);
  useEffect(() => {
    if (!active) return undefined;
    const tab = rootRef.current?.closest(".dv-tab");
    const strip = tab?.parentElement;
    if (!tab || !strip) return undefined;
    const reveal = () => {
      const t = tab.getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      // Wider than the strip (a narrow column): show the name's start.
      if (t.width > s.width || t.left < s.left) strip.scrollLeft -= s.left - t.left;
      else if (t.right > s.right) strip.scrollLeft += t.right - s.right;
    };
    const frame = requestAnimationFrame(reveal);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(reveal) : null;
    observer?.observe(strip);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [active]);

  // The floating name for an inactive header tab. The overflow list already
  // shows every name inline, so it never floats one.
  const [tip, setTip] = useState(null);
  const inHeader = tabLocation !== "headerOverflow";
  const showTip = useCallback(() => {
    const r = rootRef.current?.getBoundingClientRect();
    if (r) setTip({ left: r.left + r.width / 2, top: r.bottom + 4 });
  }, []);
  const tipVisible = tip && inHeader && !active;

  const Icon = PANEL_ICONS[api.id] ?? PANEL_ICONS[api.component] ?? null;

  const isMiddleMouseButton = useRef(false);
  const onClose = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      api.close();
    },
    [api],
  );
  const onBtnPointerDown = useCallback((event) => event.preventDefault(), []);
  const onPointerDown = useCallback((event) => {
    isMiddleMouseButton.current = event.button === 1;
    setTip(null);
  }, []);
  const onPointerUp = useCallback(
    (event) => {
      if (isMiddleMouseButton.current && event.button === 1) {
        isMiddleMouseButton.current = false;
        onClose(event);
      }
    },
    [onClose],
  );
  const onPointerLeave = useCallback(() => {
    isMiddleMouseButton.current = false;
    setTip(null);
  }, []);

  return (
    <div
      ref={rootRef}
      className="dv-default-tab panel-tab"
      title={inHeader ? undefined : title}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerEnter={showTip}
      onPointerLeave={onPointerLeave}
    >
      <span className="dv-default-tab-content panel-tab-content">
        {Icon ? <Icon size={14} className="panel-tab-icon" aria-hidden="true" /> : null}
        <span className="panel-tab-label">{title}</span>
        {badge}
      </span>
      <div
        className="dv-default-tab-action panel-tab-close"
        role="button"
        aria-label={`Close ${title}`}
        onPointerDown={onBtnPointerDown}
        onClick={onClose}
      >
        <X size={11} aria-hidden="true" />
      </div>
      {tipVisible
        ? createPortal(
            <div className="tab-tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
              {title}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
