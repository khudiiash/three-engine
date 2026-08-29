export const EMITTER_POSE_STRIDE = 20;

/**
 * Refresh one light-tree emitter's cheap live signature.
 *
 * Matrix changes include non-uniform scale, so emitter area/power is refreshed
 * by the light-tree path without making scale a structural mesh fingerprint.
 * The caller owns the expensive refit/repack only when this returns true.
 */
export function refreshEmitterPoseSignature(
  row,
  matrixElements,
  rgb,
  instanceTag,
  { matrixEpsilon = 1e-5, colorEpsilon = 1e-6 } = {},
) {
  let changed = false;
  for (let k = 0; k < 16; k++) {
    const value = matrixElements[k];
    if (Math.abs(row[k] - value) > matrixEpsilon) changed = true;
    row[k] = value;
  }
  for (let k = 0; k < 3; k++) {
    const value = rgb[k];
    if (Math.abs(row[16 + k] - value) > colorEpsilon) changed = true;
    row[16 + k] = value;
  }
  if (row[19] !== instanceTag) changed = true;
  row[19] = instanceTag;
  return changed;
}
