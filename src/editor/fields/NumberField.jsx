import { useRef, useState } from "react";
import { commandBus } from "../commands/CommandBus.js";

/**
 * The inspector's number input. Two interaction modes on one control:
 *
 *   - Click and type, like any text field.
 *   - Press and drag horizontally to scrub the value (Blender / Unity style).
 *     Shift = fine (x0.1), Alt = coarse (x10).
 *
 * Scrubbing is what makes an inspector feel like a tool rather than a form:
 * nudging a position by "a bit" shouldn't mean select-all + retype. The two
 * modes coexist because focus decides which one is active — an unfocused field
 * scrubs on drag, a focused one behaves like a normal text box so caret
 * placement and text selection still work.
 *
 * Pointer capture (not pointer lock) drives the delta. Pointer lock keeps
 * working past the screen edge but hides the cursor and needs a permissions
 * dance that browsers can refuse; for fields this small, capture is the
 * predictable choice.
 */

const clamp = (v, min, max) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/** Trims float noise accumulated over many drag deltas (0.30000000000000004). */
function tidy(value, step) {
  const decimals = step >= 1 ? 0 : Math.min(5, Math.ceil(-Math.log10(step)) + 1);
  return parseFloat(value.toFixed(decimals));
}

export function formatNumber(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return "0";
  return String(Math.round(v * 1000) / 1000);
}

/** Movement in px before a press counts as a scrub instead of a click. */
const DRAG_SLOP = 3;

/**
 * ── A BOUNDED NUMBER IS A SLIDER (2026-09-08) ─────────────────────────────
 * A field that knows both its minimum and its maximum draws its value as a
 * fill from the left (see `.number-field.slider`), and a drag sets the value
 * by POSITION — where the pointer is along the field is where the value lands,
 * the way a slider works — instead of by delta. Shift keeps the delta mode at
 * a tenth of the range per field-width, for the last decimal. Click still
 * types. The value is quantised to the field's step when the step is a whole
 * number (a count stays a count), and otherwise to a fine grid so the slider
 * feels continuous while the figure stays readable.
 */
const isBounded = (min, max) => Number.isFinite(min) && Number.isFinite(max) && max > min;

function quantize(value, step, min, max) {
  if (step >= 1) return Math.round(value / step) * step;
  return tidy(value, Math.min(step, (max - min) / 500));
}

/**
 * ── A SCRUB IS A PREVIEW; THE COMMIT HAPPENS ON RELEASE ────────────────────
 * (2026-09-07, ZERO_FREEZE_PLAN §1.3)
 *
 * THE FAILURE: this field called `onCommit` on EVERY `pointermove`. Each call
 * built a full undoable command, pushed it, and ran the whole edit fan-out —
 * the scene mirror, merging, shadowMerge, batching, GI's rebake check — in its
 * own macrotask, so none of it coalesced. A one-second scrub of a light's
 * intensity left ~100 entries in the undo stack (Ctrl+Z became useless) and
 * spent the frame budget on listeners instead of on drawing the change.
 *
 * Now: the drag opens a command-bus transaction, writes AT MOST ONCE PER
 * ANIMATION FRAME while it runs (a 1000 Hz mouse delivers several moves per
 * frame; the extra ones cannot be seen and are dropped), and closes the
 * transaction on release — ONE undo entry, whose undo restores the value the
 * drag started from. The viewport still updates live because the previewed
 * commands really do run; only the history push and the scene-wide refresh
 * wait for the release.
 *
 * `globalThis.__editorDragPreview = false` restores commit-per-pointermove
 * for a one-boot A/B.
 */
const previewEnabled = () => globalThis.__editorDragPreview !== false;

function openPreview(d) {
  if (d.preview || !previewEnabled()) return;
  d.preview = true;
  commandBus.beginPreview();
}

function closePreview(d) {
  if (!d.preview) return;
  d.preview = false;
  commandBus.endPreview();
}

/**
 * @param {{ value: number, onCommit: (value: number) => void, min?: number,
 *           max?: number, step?: number, mixed?: boolean, className?: string,
 *           title?: string }} props
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 0.1,
  mixed = false,
  className = "",
  title,
}) {
  // `draft` is non-null only while the field is actively edited; otherwise the
  // displayed text derives DIRECTLY from `value`. Syncing via useEffect+state
  // on every `value` change is a "Cascading Update" — a full Inspector
  // re-render on every frame of a gizmo drag. Deriving avoids the extra render.
  const [draft, setDraft] = useState(null);
  const [scrubbing, setScrubbing] = useState(false);
  const inputRef = useRef(null);
  const drag = useRef(null);
  const text = draft !== null ? draft : mixed ? "" : formatNumber(value);
  const bounded = isBounded(min, max);
  const fillPct = bounded ? Math.max(0, Math.min(100, ((Number(value) || 0) - min) / (max - min) * 100)) : 0;

  const commitText = () => {
    const parsed = parseFloat(text);
    if (!Number.isNaN(parsed) && (mixed || parsed !== value)) {
      onCommit(clamp(parsed, min, max));
    }
    // Invalid/unchanged: text reverts to `value` automatically when draft clears.
  };

  const onPointerDown = (e) => {
    // A focused field is in "typing mode" — leave the caret alone. Middle/right
    // buttons and modifier-clicks stay native too.
    if (e.button !== 0 || document.activeElement === e.currentTarget) return;
    drag.current = {
      pointerId: e.pointerId,
      value: Number(value) || 0,
      moved: 0,
      active: false,
      // The rAF handle of a queued preview write, and the modifier scale that
      // write should tidy against. 0 = nothing queued.
      frame: 0,
      scale: 1,
      preview: false,
      // For the slider: the field's box, so a pointer position maps to a value.
      rect: bounded ? e.currentTarget.getBoundingClientRect() : null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    d.moved += Math.abs(e.movementX);
    if (!d.active) {
      if (d.moved < DRAG_SLOP) return;
      d.active = true;
      setScrubbing(true);
      openPreview(d);
      // The browser focused us on mousedown and may have started a text
      // selection. Drop both so the drag reads as a scrub, not a highlight.
      e.currentTarget.blur();
      window.getSelection?.()?.removeAllRanges?.();
    }
    const scale = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
    if (bounded && d.rect?.width > 0) {
      // Slider: absolute by position; Shift = fine, by delta.
      if (e.shiftKey) d.value += (e.movementX / d.rect.width) * (max - min) * 0.1;
      else d.value = min + ((e.clientX - d.rect.left) / d.rect.width) * (max - min);
    } else {
      d.value += e.movementX * step * scale;
    }
    d.scale = scale;
    const settle = (v, s) => (bounded ? quantize(clamp(v, min, max), step, min, max) : tidy(clamp(v, min, max), s));
    if (!previewEnabled()) {
      onCommit(settle(d.value, step * scale));
      return;
    }
    // ONE WRITE PER FRAME. The accumulator above already holds every delta, so
    // a dropped intermediate write loses nothing but the work of applying a
    // value that would have been overwritten before it was ever drawn.
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      if (drag.current !== d) return; // the drag ended before the frame ran
      onCommit(settle(d.value, step * d.scale));
    });
  };

  const endDrag = (e) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setScrubbing(false);
    if (d.frame) cancelAnimationFrame(d.frame);
    d.frame = 0;
    e.currentTarget.releasePointerCapture?.(d.pointerId);
    // A press that never crossed the slop threshold is a plain click; the
    // browser already gave the input focus, so typing just works.
    if (d.active) onCommit(bounded ? quantize(clamp(d.value, min, max), step, min, max) : tidy(clamp(d.value, min, max), step));
    // ⚠ AFTER the final write, never before: the transaction has to contain
    // the value the user released on, or the one undo entry redoes to the
    // second-to-last frame of the drag.
    closePreview(d);
  };

  return (
    <input
      ref={inputRef}
      className={`number-field${bounded ? " slider" : ""}${scrubbing ? " scrubbing" : ""}${className ? ` ${className}` : ""}`}
      style={bounded ? { "--fill-pct": `${fillPct}%` } : undefined}
      type="text"
      inputMode="decimal"
      title={title}
      value={text}
      placeholder={mixed ? "—" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={() => {
        // The last exit. `endDrag` normally got there first (it releases the
        // capture itself), but a capture torn away by the browser must not
        // strand an open transaction — the next command anywhere in the editor
        // would be swallowed into this drag's single undo entry.
        const d = drag.current;
        if (d) {
          if (d.frame) cancelAnimationFrame(d.frame);
          d.frame = 0;
          closePreview(d);
        }
        drag.current = null;
        setScrubbing(false);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft(mixed ? "" : formatNumber(value))}
      onBlur={() => {
        // A scrub blurs the field itself — don't let that path re-commit the
        // pre-drag text over the value the drag just wrote.
        if (draft !== null && !drag.current?.active) commitText();
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const s = step * (e.shiftKey ? 0.1 : e.altKey ? 10 : 1);
          const base = draft !== null ? parseFloat(draft) : value;
          if (Number.isNaN(base)) return;
          const next = tidy(clamp(base + (e.key === "ArrowUp" ? s : -s), min, max), s);
          setDraft(formatNumber(next));
          onCommit(next);
        }
      }}
    />
  );
}
