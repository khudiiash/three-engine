/**
 * GTAO and its bilateral filters have no temporal input. Their persistent
 * textures can be reused only after the whole chain actually ran, with the
 * same g-buffer and every uniform unchanged. This does not apply to the
 * occupancy-cone or ray-traced AO arms.
 */
export class GiGtaoHold {
  constructor() {
    this._completed = null;
  }

  canReuse(inputs, { gbufferHeld, chainReady }) {
    if (gbufferHeld !== true || chainReady !== true) return false;
    const current = gtaoInputs(inputs);
    const completed = this._completed;
    return current !== null && completed !== null &&
      current.length === completed.length &&
      current.every((value, i) => value === completed[i]);
  }

  /** A ready pipeline alone is insufficient: every node must have dispatched
   * successfully for THIS input. Failed or partial chains invalidate the old
   * receipt because their prefix may already have overwritten a target. */
  record(inputs, dispatchedWholeChain) {
    this._completed = dispatchedWholeChain === true ? gtaoInputs(inputs) : null;
  }
}

function gtaoInputs({
  enabled,
  pass,
  nodes,
  gbuffer,
  gbufferGeneration,
  cameraPosition,
  cameraRight,
  cameraUp,
  projectionScale,
  strength,
  radius,
}) {
  if (enabled !== true || pass?.reusableGtao !== true || !nodes?.size ||
      !pass.target || !pass.rawTarget || !gbuffer?.position || !gbuffer?.normal) return null;
  const scalars = [
    gbufferGeneration,
    cameraPosition?.x, cameraPosition?.y, cameraPosition?.z,
    cameraRight?.x, cameraRight?.y, cameraRight?.z,
    cameraUp?.x, cameraUp?.y, cameraUp?.z,
    projectionScale, strength, radius,
    gbuffer.rt?.width, gbuffer.rt?.height,
    pass.width, pass.height,
  ];
  if (!scalars.every(Number.isFinite)) return null;
  return [
    pass, ...nodes,
    gbuffer, gbuffer.rt, gbuffer.position, gbuffer.normal,
    gbuffer.position.version, gbuffer.normal.version,
    pass.target, pass.target.version, pass.rawTarget, pass.rawTarget.version,
    ...scalars,
  ];
}
