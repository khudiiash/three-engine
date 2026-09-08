import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "./icons/index.jsx";

/**
 * Minimise / maximise / close for a window that draws its own title bar.
 *
 * The menu bar is the title bar on Windows (`decorations: false` in
 * `src-tauri/tauri.windows.conf.json`; the bar itself is the drag region, see
 * MenuBar.jsx), so the three OS buttons have to come from us. Rendered only
 * when the window really is undecorated: in a plain browser, or on a platform
 * that keeps its native chrome, `isDecorated()` says so and this renders
 * nothing — the same JSX serves both.
 */
export function WindowControls() {
  const [win, setWin] = useState(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const current = getCurrentWindow();
        if (await current.isDecorated()) return;
        if (disposed) return;
        setWin(current);
        setMaximized(await current.isMaximized());
        unlisten = await current.onResized(async () => {
          try {
            setMaximized(await current.isMaximized());
          } catch {
            // The window is going away; nothing to update.
          }
        });
      } catch {
        // Not running under Tauri (a browser harness) — no controls to draw.
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!win) return null;
  return (
    <div className="window-controls" role="group" aria-label="Window">
      <button type="button" title="Minimise" onClick={() => win.minimize()}>
        {/* Window chrome is drawn thin by every OS: a FILLED minimise and
            maximise read as solid blocks, not as window controls. */}
        <Minus size={12} weight="bold" aria-hidden="true" />
      </button>
      <button type="button" title={maximized ? "Restore" : "Maximise"} onClick={() => win.toggleMaximize()}>
        {maximized ? <Copy size={11} weight="bold" aria-hidden="true" /> : <Square size={11} weight="bold" aria-hidden="true" />}
      </button>
      <button type="button" className="close" title="Close" onClick={() => win.close()}>
        <X size={13} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}
