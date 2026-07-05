/**
 * Canvas-2D text rasterizer for UiTextComponent. Renders text into an
 * offscreen canvas at physical resolution (rect size × k) so glyphs stay
 * crisp at any DPR / UI scale, with wrapping and h/v alignment.
 */

const MAX_TEXTURE_DIM = 2048;

/** Splits `text` into lines that fit `maxWidth` (canvas px). Honors \n. */
function wrapLines(ctx, text, maxWidth, wrap) {
  const paragraphs = String(text).split("\n");
  if (!wrap) return paragraphs;
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = line + " " + words[i];
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = words[i];
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Draws styled text into `canvas`, resizing it to `w×h` UI px at scale `k`.
 * Returns false when the target size is degenerate (nothing drawn).
 *
 * style: { text, fontSize, fontFamily, fontWeight, color, align, valign,
 *          wrap, lineHeight }
 */
export function drawTextToCanvas(canvas, w, h, k, style) {
  const pw = Math.min(MAX_TEXTURE_DIM, Math.max(1, Math.round(w * k)));
  const ph = Math.min(MAX_TEXTURE_DIM, Math.max(1, Math.round(h * k)));
  if (w <= 0 || h <= 0) return false;
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, pw, ph);

  const fontPx = Math.max(1, style.fontSize * k);
  ctx.font = `${style.fontWeight ?? 400} ${fontPx}px ${style.fontFamily || "system-ui, sans-serif"}`;
  ctx.fillStyle = style.color || "#ffffff";
  ctx.textBaseline = "middle";

  const lines = wrapLines(ctx, style.text ?? "", pw, style.wrap !== false);
  const lineH = fontPx * (style.lineHeight ?? 1.25);
  const blockH = lines.length * lineH;

  let y;
  if (style.valign === "top") y = lineH / 2;
  else if (style.valign === "bottom") y = ph - blockH + lineH / 2;
  else y = (ph - blockH) / 2 + lineH / 2;

  const align = style.align ?? "center";
  ctx.textAlign = align === "left" ? "left" : align === "right" ? "right" : "center";
  const x = align === "left" ? 0 : align === "right" ? pw : pw / 2;

  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += lineH;
  }
  return true;
}

/** Measures the natural size (UI px) of text — used for future auto-sizing. */
export function measureText(style, maxWidth = Infinity) {
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return { w: 0, h: 0 };
  const ctx = canvas.getContext("2d");
  ctx.font = `${style.fontWeight ?? 400} ${style.fontSize}px ${style.fontFamily || "system-ui, sans-serif"}`;
  const lines = wrapLines(ctx, style.text ?? "", maxWidth, style.wrap !== false);
  let w = 0;
  for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  return { w, h: lines.length * style.fontSize * (style.lineHeight ?? 1.25) };
}
