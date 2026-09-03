export const GI_RESIZE_SETTLE_MS = 250;

const GI_LIVE_COMPONENT_PROPS = new Set([
  "enabled",
  "debugView",
]);

const GI_SCREEN_COMPONENT_PROPS = new Set([
  "ao",
]);

/**
 * Component-property invalidation boundary. The three visible rails are real
 * quality selectors, so they change allocation, resolution and shader budgets.
 * Only enabled/debugView are live value switches.
 */
export function giPropInvalidation(key) {
  if (GI_LIVE_COMPONENT_PROPS.has(key)) return "live";
  if (GI_SCREEN_COMPONENT_PROPS.has(key)) return "screen";
  return "world";
}

/**
 * Keep the current GI targets live until the requested size has stopped
 * changing for one settle window. `state` is part of the key so a pending
 * resize can never be committed into a replacement GI generation.
 */
export function settleGiResize(pending, candidate, nowMs, settleMs = GI_RESIZE_SETTLE_MS) {
  const same = pending?.state === candidate.state
    && pending.width === candidate.width
    && pending.height === candidate.height
    && pending.shadowW === candidate.shadowW
    && pending.shadowH === candidate.shadowH;
  if (!same) {
    return {
      pending: { ...candidate, since: nowMs },
      ready: false,
    };
  }
  if (nowMs - pending.since < settleMs) return { pending, ready: false };
  return { pending: null, ready: true };
}

/** A background compile wave is active even when viewport rendering is live. */
export function canStartGiRebuild(compileWaveActive, renderSuspended) {
  return !compileWaveActive && !renderSuspended;
}

/** Only the wave whose token is still current may undo process-wide hooks. */
export function ownsGiCompileWave(currentToken, token) {
  return currentToken === token;
}

/**
 * Broad glossy radiance is valid without the optional exact-BVH tail. Exact
 * targets carry alpha=0 until ready and blend themselves in independently.
 */
export function giBroadReflectionReadinessNodes(screen) {
  return screen?.reflectionComputes ?? [];
}
