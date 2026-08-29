/**
 * The subset of SceneContentKey that the expensive GI mesh/material walk reads.
 * Transform-only changes are handled by the per-frame mover/slot path.
 */
export function giFingerprintContentAxes(content) {
  return content
    ? `${content.hierarchy}:${content.visibility}:${content.materials}`
    : null;
}

/** True when no structural/material scan is required this tick. */
export function giFingerprintContentFresh(lastAxes, content, auditDue = false) {
  const axes = giFingerprintContentAxes(content);
  return !!content && lastAxes === axes && !auditDue;
}
