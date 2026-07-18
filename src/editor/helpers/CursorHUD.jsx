import { useEffect, useState } from "react";
import { subscribeCursor3D } from "../threeDCursor.js";

/**
 * Tiny pinned readout of the 3D cursor's world-space coordinates. Lives
 * in the bottom-left of the viewport next to the terrain-brush HUD so
 * the user always sees the cursor's value while working.
 */
const AXES = ["x", "y", "z"];

function format(value) {
  if (Math.abs(value) < 0.001) value = 0;
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  return value.toFixed(3);
}

export function CursorHUD() {
  const [cursor, setCursor] = useState({ position: [0, 0, 0], visible: true });
  useEffect(() => subscribeCursor3D(setCursor), []);

  return (
    <div className="cursor-hud" hidden={!cursor.visible}>
      <span className="cursor-hud-icon">⌖</span>
      <span className="cursor-hud-pos">
        {AXES.map((axis, index) => (
          <span key={axis} className={`cursor-hud-axis cursor-hud-${axis}`}>
            <span className="cursor-hud-key">{axis.toUpperCase()}</span>
            {format(cursor.position[index])}
          </span>
        ))}
      </span>
      <span className="cursor-hud-hint">3D Cursor</span>
    </div>
  );
}
