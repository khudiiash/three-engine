import { useEffect, useRef } from "react";
import { useConsoleStore } from "../store/consoleStore.js";

export function ConsolePanel() {
  const entries = useConsoleStore((s) => s.entries);
  const clear = useConsoleStore((s) => s.clear);
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <div className="console-panel">
      <div className="panel-toolbar">
        <button className="toolbar-btn" onClick={clear}>Clear</button>
      </div>
      <div className="console-list" ref={listRef}>
        {entries.map((entry) => (
          <div key={entry.id} className={`console-entry ${entry.level}`}>
            <span className="console-time">
              {entry.time.toLocaleTimeString(undefined, { hour12: false })}
            </span>
            <span className="console-message">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
