/**
 * Keep emitter-shadow tracing bounded by work, not by viewport dimensions.
 * The quality/rig scale chooses the desired shape first; the pixel ceiling
 * only engages on large views where that otherwise becomes an unbounded
 * full-screen BVH pass.
 */
export function giEmitterShadowSize(
  shadowWidth,
  shadowHeight,
  scale,
  maxPixels = 160_000,
) {
  const width = Math.max(1, Number(shadowWidth) || 1);
  const height = Math.max(1, Number(shadowHeight) || 1);
  const axisScale = Math.max(0.01, Number(scale) || 1);
  let outWidth = Math.max(64, Math.round(width * axisScale));
  let outHeight = Math.max(64, Math.round(height * axisScale));
  const ceiling = Number(maxPixels);
  if (!(ceiling >= 64 * 64) || outWidth * outHeight <= ceiling) {
    return { width: outWidth, height: outHeight };
  }

  const shrink = Math.sqrt(ceiling / (outWidth * outHeight));
  outWidth = Math.max(64, Math.floor(outWidth * shrink));
  outHeight = Math.max(64, Math.floor(outHeight * shrink));
  // Rounding and the 64-pixel axis floor can leave a narrow target barely
  // above the ceiling. Trim only the longer axis so the aspect stays useful.
  if (outWidth * outHeight > ceiling) {
    if (outWidth >= outHeight) outWidth = Math.max(64, Math.floor(ceiling / outHeight));
    else outHeight = Math.max(64, Math.floor(ceiling / outWidth));
  }
  return { width: outWidth, height: outHeight };
}
