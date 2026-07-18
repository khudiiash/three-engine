import { useEffect, useState } from "react";
import * as THREE from "three/webgpu";

const AXIS_COLORS = { x: "#f06a73", y: "#67c77a", z: "#5d9df5" };

/**
 * A compact viewport orientation indicator — RGB axes that rotate as the
 * camera orbits, with clickable endpoints that snap the orbit target to a
 * cardinal view.
 *
 * Pure-Render: the gizmo subscribes to the OrbitControls instance passed in
 * via `controls` and reads its `camera`/`target` on every change. This keeps
 * it decoupled from any global viewport singleton — it works inside the
 * standalone Geometry Editor panel just as well as on the main Viewport.
 *
 *   - `camera`     : THREE.PerspectiveCamera being orbited
 *   - `controls`   : the matching OrbitControls instance
 *   - `onSnap(axis, sign)` : optional callback when the user clicks an
 *                            endpoint; if omitted the gizmo is read-only.
 *   - `activeView` : the currently snapped view, e.g. "+X" or "-Z"
 *   - `disabled`   : greys out the gizmo and ignores clicks
 */
export function AxisViewGizmo({ camera, controls, onSnap, activeView = null, disabled = false }) {
  const [directions, setDirections] = useState({
    x: { x: 1, y: 0, depth: 0 },
    y: { x: 0, y: -1, depth: 0 },
    z: { x: -0.7, y: 0.7, depth: 0 },
  });

  useEffect(() => {
    if (!camera || !controls) return undefined;
    let disposed = false;
    const update = () => {
      if (disposed) return;
      const inverse = camera.quaternion.clone().invert();
      const next = {};
      for (const axis of ["x", "y", "z"]) {
        const world = new THREE.Vector3(
          axis === "x" ? 1 : 0,
          axis === "y" ? 1 : 0,
          axis === "z" ? 1 : 0,
        );
        world.applyQuaternion(inverse);
        const length = Math.hypot(world.x, world.y);
        next[axis] = length < 0.001
          ? { x: 0, y: 0, depth: world.z }
          : { x: world.x / length, y: -world.y / length, depth: world.z };
      }
      setDirections(next);
    };
    controls.addEventListener("change", update);
    update();
    return () => {
      disposed = true;
      controls.removeEventListener("change", update);
    };
  }, [camera, controls]);

  const radius = 27;
  const endpoints = [];
  for (const axis of ["x", "y", "z"]) {
    for (const sign of [-1, 1]) {
      const direction = directions[axis];
      endpoints.push({
        axis,
        sign,
        left: 38 + direction.x * radius * sign,
        top: 38 + direction.y * radius * sign,
        depth: direction.depth * sign,
      });
    }
  }

  return (
    <div className={`axis-view-gizmo ${disabled ? "disabled" : ""}`} aria-label="Viewport orientation">
      <svg className="axis-view-lines" viewBox="0 0 76 76" aria-hidden="true">
        {Object.entries(directions).map(([axis, direction]) => (
          <line
            key={axis}
            x1={38 - direction.x * radius}
            y1={38 - direction.y * radius}
            x2={38 + direction.x * radius}
            y2={38 + direction.y * radius}
            stroke={AXIS_COLORS[axis]}
          />
        ))}
      </svg>
      {endpoints
        .sort((a, b) => a.depth - b.depth)
        .map(({ axis, sign, left, top, depth }) => {
          const view = `${sign > 0 ? "+" : "-"}${axis.toUpperCase()}`;
          return (
            <button
              key={view}
              type="button"
              className={`axis-view-end ${sign > 0 ? "positive" : "negative"} ${activeView === view ? "active" : ""}`}
              style={{ left, top, zIndex: 3 + Math.round((depth + 1) * 2), "--axis-color": AXIS_COLORS[axis] }}
              title={`${view} view`}
              aria-label={`${view} view`}
              disabled={disabled || !onSnap}
              onClick={onSnap ? () => onSnap(axis, sign) : undefined}
            >
              {sign > 0 ? axis.toUpperCase() : ""}
            </button>
          );
        })}
    </div>
  );
}