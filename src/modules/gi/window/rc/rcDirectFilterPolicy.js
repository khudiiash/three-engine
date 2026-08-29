// CPU mirror of rcDirect's bounded visibility reconstruction. Keep this file
// free of three/TSL imports so the pass topology and per-channel support can be
// gated without creating a GPU pipeline.

export const RC_DIRECT_FILTER_RADIUS = 6;
export const RC_DIRECT_FILTER_TAPS = Object.freeze(
  Array.from({ length: RC_DIRECT_FILTER_RADIUS * 2 + 1 }, (_, index) => index - RC_DIRECT_FILTER_RADIUS),
);
export const RC_DIRECT_FILTER_WEIGHTS = Object.freeze(
  RC_DIRECT_FILTER_TAPS.map((tap) => Math.exp(-(tap * tap) / (2 * 2.4 * 2.4))),
);
export const RC_DIRECT_PASS_NAMES = Object.freeze(["raw", "filterH", "filterV"]);

const finitePositive = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? value : fallback
);

export function rcDirectFilterRadii(penumbraMetres, footprintMetres) {
  const fp = finitePositive(footprintMetres, 1e-5);
  return [...penumbraMetres].map((width) => Math.min(
    RC_DIRECT_FILTER_RADIUS,
    Math.max(1, finitePositive(width, 0) / fp),
  ));
}

export function rcDirectFilterSupport(penumbraMetres, footprintMetres) {
  const radii = rcDirectFilterRadii(penumbraMetres, footprintMetres);
  return RC_DIRECT_FILTER_TAPS.map((tap, index) => ({
    tap,
    weights: radii.map((radius) => (
      Math.abs(tap) - 0.5 <= radius ? RC_DIRECT_FILTER_WEIGHTS[index] : 0
    )),
  }));
}
