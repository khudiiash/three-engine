/**
 * ⭐⭐⭐ WHAT EACH THING COSTS, MEASURED BY TAKING IT AWAY.
 *
 * Every other profiler in this editor reads a clock inside the page, and
 * there is a whole class of work none of them can price. A cloth component
 * hands the GPU three hundred compute dispatches a frame: measured, that is
 * 1.65 ms of main thread and 2.49 ms of GPU pass time, and the frame is
 * 26 ms longer for it. The cost is in ISSUING the work, which happens in the
 * browser's own GPU process, and no clock reachable from JavaScript is
 * pointed at it. So the frame accounting kept ending in a large row that
 * belonged to nobody, and every explanation offered for that row — vsync,
 * the compositor, an occluded window — was wrong.
 *
 * What CAN be measured is the frame with the thing and the frame without it.
 * That is the comparison a person makes by unticking a component and
 * watching the counter, and this makes it an instrument: skip one owner's
 * per-frame callbacks for a window, read the frame rate, put them back.
 *
 * ⚠ It is an ACTION, not a readout — about a second per row, and the
 * viewport visibly changes while it runs. Nothing about the scene is
 * modified, nothing reaches the undo stack, and the muted set is cleared in
 * a `finally` so a failure cannot leave a component switched off.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The settled frame rate, from presented frames rather than a smoothed EMA. */
async function measureFrame(engine, windowMs) {
  await sleep(windowMs);
  const r = engine.stats.sample();
  return { fps: +r.fps.toFixed(1), frameMs: r.fps > 0 ? +(1000 / r.fps).toFixed(2) : null };
}

/** Groups the engine's per-frame callback owners into the rows to measure. */
export function censusGroups(engine, by = "type") {
  const groups = new Map();
  for (const owner of engine.frameOwners?.() ?? []) {
    let key;
    let label;
    let kind;
    if (owner.entity && owner.type) {
      kind = "component";
      key = by === "instance" ? `c:${owner.type}:${owner.entity.id}` : `t:${owner.type}`;
      label =
        by === "instance"
          ? `${owner.constructor?.label ?? owner.type} · ${owner.entity.name ?? owner.entity.id}`
          : (owner.constructor?.label ?? owner.type);
    } else if (owner.kind === "module") {
      kind = "module";
      key = `m:${owner.id}`;
      label = `${owner.id} (module)`;
    } else {
      // Engine-internal callbacks are not optional; muting one measures
      // nothing anybody could act on.
      continue;
    }
    const group = groups.get(key) ?? { key, label, kind, owners: [] };
    group.owners.push(owner);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Prices every owner by its absence.
 *
 * @param {object} engine
 * @param {{windowMs?: number, by?: string, onProgress?: (done: number, total: number, label: string) => void}} options
 */
export async function runFrameCensus(engine, { windowMs = 1200, by = "type", onProgress } = {}) {
  if (!engine?.stats) throw new Error("No engine.");
  const wait = Math.max(300, Math.min(4000, Math.round(windowMs)));
  const groups = censusGroups(engine, by);
  const baseline = await measureFrame(engine, wait);
  const rows = [];
  try {
    let done = 0;
    for (const group of groups) {
      onProgress?.(done, groups.length, group.label);
      engine.muteOwners(group.owners);
      const without = await measureFrame(engine, wait);
      engine.unmuteOwners();
      rows.push({
        key: group.key,
        label: group.label,
        kind: group.kind,
        instances: group.owners.length,
        withoutFps: without.fps,
        withoutFrameMs: without.frameMs,
        costMs:
          baseline.frameMs !== null && without.frameMs !== null
            ? +(baseline.frameMs - without.frameMs).toFixed(2)
            : null,
      });
      done++;
      // Let the frame settle, or one row's tail lands in the next row's window.
      await sleep(300);
    }
  } finally {
    engine.unmuteOwners();
  }
  rows.sort((a, b) => (b.costMs ?? -Infinity) - (a.costMs ?? -Infinity));
  const restored = await measureFrame(engine, wait);
  onProgress?.(groups.length, groups.length, "");
  return { windowMs: wait, by, baseline, restored, rows, at: Date.now() };
}
