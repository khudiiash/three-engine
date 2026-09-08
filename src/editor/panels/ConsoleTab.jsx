import { useEffect } from "react";
import { useConsoleStore } from "../store/consoleStore.js";
import { PanelTab } from "../PanelTab.jsx";

/**
 * The Console's tab: the standard PanelTab plus a count of error-level entries
 * that arrived since the user last looked. The count clears as soon as the tab
 * becomes active — the user is now looking at the console. A number in a red
 * chip replaced the earlier pulsing dot: it says how much, and it does not move.
 */
export function ConsoleTab({ api, tabLocation }) {
  const unread = useConsoleStore((s) => s.unreadErrors);
  const markConsoleRead = useConsoleStore((s) => s.markConsoleRead);

  useEffect(() => {
    const disposable = api.onDidActiveChange((event) => {
      if (event.isActive) markConsoleRead();
    });
    return () => disposable.dispose();
  }, [api, markConsoleRead]);

  const badge =
    unread > 0 ? (
      <span
        className="panel-tab-badge"
        title={`${unread} unread error${unread === 1 ? "" : "s"}`}
        aria-label={`${unread} unread error${unread === 1 ? "" : "s"}`}
      >
        {unread > 99 ? "99+" : unread}
      </span>
    ) : null;

  return <PanelTab api={api} tabLocation={tabLocation} badge={badge} />;
}
