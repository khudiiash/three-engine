import { useEffect, useRef, useState } from "react";
import { useConsoleStore } from "../store/consoleStore.js";

// Rows vary in real height (a stack trace wraps across several lines via
// `white-space: pre-wrap`), so this is only an estimate for spacer sizing.
// It never accumulates error the way a cumulative virtual-offset would:
// start/end are recomputed from the DOM's actual scrollTop/clientHeight on
// every scroll and every entries change, so a run of tall rows just shifts
// the estimate for that one recompute, not forever.
const ROW_HEIGHT = 22;
const OVERSCAN = 15;

export function ConsolePanel() {
  const entries = useConsoleStore((s) => s.entries);
  const clear = useConsoleStore((s) => s.clear);
  const listRef = useRef(null);
  const [range, setRange] = useState({ start: 0, end: entries.length });

  const recompute = () => {
    const el = listRef.current;
    if (!el) return;
    const start = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleRows = Math.ceil(el.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
    setRange((prev) => {
      const end = Math.min(entries.length, start + visibleRows);
      if (prev.start === start && prev.end === end) return prev;
      return { start, end };
    });
  };

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length]);

  // Only the rows actually in view (plus overscan) ever get mounted, so
  // rendering doesn't re-touch the hundreds of off-screen entries a burst of
  // boot-time logging can leave sitting in the buffer — and `entry.message`
  // (which formats lazily) never runs for a row nobody scrolled to.
  const visible = entries.slice(range.start, range.end);
  const topSpacer = range.start * ROW_HEIGHT;
  const bottomSpacer = Math.max(0, entries.length - range.end) * ROW_HEIGHT;

  return (
    <div className="console-panel">
      <div className="panel-toolbar">
        <button className="toolbar-btn" onClick={clear}>Clear</button>
      </div>
      <div className="console-list" ref={listRef} onScroll={recompute}>
        {topSpacer > 0 && <div style={{ height: topSpacer }} />}
        {visible.map((entry) => (
          <div key={entry.id} className={`console-entry ${entry.level}`}>
            <span className="console-time">
              {entry.time.toLocaleTimeString(undefined, { hour12: false })}
            </span>
            <span className="console-message">{entry.message}</span>
          </div>
        ))}
        {bottomSpacer > 0 && <div style={{ height: bottomSpacer }} />}
      </div>
    </div>
  );
}
