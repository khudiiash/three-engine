// @ts-check
/**
 * How the Inspector's number fields turn a float into text and back.
 *
 * Extracted from `NumberField.jsx` so it can be tested headlessly: this is the
 * code that decides how much of a value the user is allowed to SEE, and a
 * rounding bug here does not look like a rounding bug — it looks like a
 * property that refuses to hold the value you typed.
 */

/** Trims float noise accumulated over many drag deltas (0.30000000000000004). */
export function tidy(value, step) {
  const decimals = step >= 1 ? 0 : Math.min(5, Math.ceil(-Math.log10(step)) + 1);
  return parseFloat(value.toFixed(decimals));
}

/**
 * How many decimals a field with this step has to be able to SHOW.
 *
 * ⛔ THIS WAS A FIXED 3 AND IT SILENTLY DESTROYED SMALL VALUES (2026-09-11).
 * A light's `shadowBias` defaults to **-0.0005**, and three's useful range for
 * it is 1e-4…1e-3. At three decimals `Math.round(-0.0005 * 1000) / 1000` is
 * `-0`, so the field displayed the default bias as **"0"** and 0.001 was the
 * smallest magnitude it could express. Worse, the field seeds its edit draft
 * from this text on focus and commits the draft on blur — so merely CLICKING
 * INTO the Bias field and clicking away wrote 0 over the authored value.
 * "whatever I set there, even just 0.001 … shadow immediately get broken"
 * (user) is this: the control could neither show nor round-trip the number the
 * shadow actually needed.
 *
 * The step already declares the precision the author works at, so derive from
 * it — and never go COARSER than the old fixed 3, so every existing field
 * (position at step 0.1, and most others) reads exactly as it did before.
 */
export function decimalsFor(step) {
  if (!(step > 0)) return 3;
  return Math.min(6, Math.max(3, Math.ceil(-Math.log10(step)) + 1));
}

/**
 * The text shown for `value` in a field whose spinner step is `step`.
 * `parseFloat` trims the trailing zeros `toFixed` adds, so 0.5 stays "0.5"
 * rather than becoming "0.500".
 */
export function formatNumber(v, step) {
  if (typeof v !== "number" || Number.isNaN(v)) return "0";
  return String(parseFloat(v.toFixed(decimalsFor(step))));
}
