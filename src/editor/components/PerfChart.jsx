import { useEffect, useRef } from "react";
import { readSeries, usePerfStore } from "../perfMonitor.js";

/**
 * The monitor's line chart: one canvas, a few series over the chosen window,
 * a faint grid with the frame budget's multiples as its rows. Drawn from the
 * sampler's ring on every store tick — nothing is kept in React state.
 *
 * `series`: [{ key, color }] over `perfMonitor.SERIES`; `unit` picks the
 * y-axis labels ("ms" rows at 16.7 / 33.3 ms, "MB" and "fps" scale to the
 * data). `floor` is the least the axis spans, so an idle scene still shows
 * the budget lines.
 */
export function PerfChart({ series, unit = "ms", floor = 33.3, height = 120, className = "" }) {
  const canvasRef = useRef(null);
  const tick = usePerfStore((s) => s.tick);
  const windowSec = usePerfStore((s) => s.windowSec);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 300;
    const cssH = canvas.clientHeight || height;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const styles = getComputedStyle(canvas);
    const gridColor = styles.getPropertyValue("--border").trim() || "rgba(140,190,175,0.14)";
    const labelColor = styles.getPropertyValue("--text-faint").trim() || "#5e6c69";

    const data = series.map((s) => ({ ...s, values: readSeries(s.key, windowSec) }));
    let max = floor;
    for (const s of data) for (let i = 0; i < s.values.length; i++) if (s.values[i] > max) max = s.values[i];
    max *= 1.08;

    const padL = 34;
    const padR = 6;
    const padT = 6;
    const padB = 6;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;
    const y = (v) => padT + plotH - (Math.min(v, max) / max) * plotH;

    // Grid rows: the budget's multiples for ms, thirds of the range otherwise.
    const rows = unit === "ms" ? [0, 16.7, 33.3, 50, 66.7, 83.3, 100].filter((v) => v <= max) : [0, max / 3, (2 * max) / 3, max / 1.08];
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (const v of rows) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(cssW - padR, yy);
      ctx.stroke();
      ctx.fillStyle = labelColor;
      const label = unit === "ms" ? v.toFixed(1) : unit === "MB" ? Math.round(v / 1048576).toString() : Math.round(v).toString();
      ctx.fillText(label, padL - 5, yy);
    }

    const total = Math.round(windowSec * 10);
    for (const s of data) {
      const n = s.values.length;
      if (n < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = "round";
      ctx.beginPath();
      // The newest sample sits at the right edge; a short history starts
      // part-way in rather than being stretched across the whole width.
      for (let i = 0; i < n; i++) {
        const x = padL + ((total - n + i) / (total - 1)) * plotW;
        const yy = y(s.values[i]);
        if (i === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
  }, [tick, windowSec, series, unit, floor, height]);

  return <canvas ref={canvasRef} className={`perf-chart ${className}`.trim()} style={{ height }} aria-hidden="true" />;
}
