import { useCallback, useEffect, useRef } from "react";
import { useConsoleStore } from "../store/consoleStore.js";

/**
 * Custom Dockview tab renderer for the Console panel. Mirrors the default
 * tab's DOM (icon slot / title text / close button, with the same handlers
 * the default tab installs) so it slots in cleanly next to the other panels,
 * and adds a small red dot when error-level entries have arrived since the
 * user last opened the panel. The dot disappears as soon as the tab becomes
 * active — i.e. the user is now looking at the console.
 */
export function ConsoleTab({ api, containerApi, params, tabLocation }) {
  const unread = useConsoleStore((s) => s.unreadErrors);
  const markConsoleRead = useConsoleStore((s) => s.markConsoleRead);

  // Mirror the default tab's middle-click-to-close and active-tracking
  // behaviour so our swap-in doesn't change anything else about how the tab
  // behaves.
  const isMiddleMouseButton = useRef(false);

  const onClose = useCallback((event) => {
    event.preventDefault();
    api.close();
  }, [api]);

  const onBtnPointerDown = useCallback((event) => {
    event.preventDefault();
  }, []);

  const onPointerDown = useCallback((event) => {
    isMiddleMouseButton.current = event.button === 1;
  }, []);

  const onPointerUp = useCallback((event) => {
    if (isMiddleMouseButton.current && event.button === 1) {
      isMiddleMouseButton.current = false;
      onClose(event);
    }
  }, [onClose]);

  const onPointerLeave = useCallback(() => {
    isMiddleMouseButton.current = false;
  }, []);

  useEffect(() => {
    const disposable = api.onDidActiveChange((event) => {
      if (event.isActive) markConsoleRead();
    });
    return () => disposable.dispose();
  }, [api, markConsoleRead]);

  return (
    <div
      className="dv-default-tab console-tab"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      <span className="dv-default-tab-content">
        {unread > 0 && (
          <span
            className="console-error-dot"
            title={`${unread} unread error${unread === 1 ? "" : "s"}`}
            aria-label={`${unread} unread error${unread === 1 ? "" : "s"}`}
          />
        )}
        <span className="console-tab-title">Console</span>
      </span>
      <div className="dv-default-tab-action" onPointerDown={onBtnPointerDown} onClick={onClose}>
        <svg width="11" height="11" viewBox="0 0 28 28" aria-hidden="true" className="dv-svg">
          <path
            d="M19 6.41L17.59 5 14 8.59 10.41 5 9 6.41 12.59 10 9 13.59 10.41 15 14 11.41 17.59 15 19 13.59 15.41 10z"
            fill="currentColor"
          />
        </svg>
      </div>
    </div>
  );
}