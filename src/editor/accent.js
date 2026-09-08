/**
 * The editor's accent colour, applied at runtime.
 *
 * `theme.css` ships one accent as the default; a project can pick its own in
 * Project Settings → Editor. Everything that uses the accent reads a CSS
 * custom property (`--accent`, plus the derived `--accent-soft` /
 * `--accent-ring` / `--on-accent`), so changing it is four properties on the
 * root element — no stylesheet is rebuilt and no component re-renders.
 *
 * The derived values exist because a soft selection fill and a focus ring
 * are the SAME hue at a lower alpha, and text on top of a filled accent
 * button has to flip between near-black and white depending on how light
 * the chosen colour is. Deriving them here keeps a picked colour coherent
 * everywhere; hand-editing four values per pick would not.
 */

export const DEFAULT_ACCENT = "#4fd68f";

/** `#rgb` / `#rrggbb` → { r, g, b } in 0–255, or null for anything else. */
export function parseHexColor(hex) {
  if (typeof hex !== "string") return null;
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Relative luminance (sRGB → linear), 0 = black, 1 = white. */
function luminance({ r, g, b }) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The four root properties a given accent resolves to. */
export function accentProperties(hex) {
  const c = parseHexColor(hex) ?? parseHexColor(DEFAULT_ACCENT);
  const rgb = `${c.r}, ${c.g}, ${c.b}`;
  const hex6 = `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return {
    "--accent": hex6,
    "--accent-soft": `rgba(${rgb}, 0.16)`,
    "--accent-ring": `rgba(${rgb}, 0.45)`,
    // Dark text on a light accent, white on a dark one. 0.4 is where the
    // contrast of black and white text on the fill crosses over.
    "--on-accent": luminance(c) > 0.4 ? "#0d0e11" : "#ffffff",
  };
}

/** Sets the accent on the document. Safe to call before any project is open. */
export function applyAccent(hex) {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(accentProperties(hex))) style.setProperty(name, value);
}

/**
 * The accent in effect right now, as `#rrggbb` — for canvas drawing and
 * other places that cannot read a CSS custom property themselves. Reads the
 * root property so a project's own accent applies there too.
 */
export function currentAccent() {
  if (typeof document === "undefined") return DEFAULT_ACCENT;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return parseHexColor(value) ? value : DEFAULT_ACCENT;
}

/** The current accent at `alpha`, as an `rgba()` string for canvas fills. */
export function accentAlpha(alpha) {
  const c = parseHexColor(currentAccent()) ?? parseHexColor(DEFAULT_ACCENT);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}
