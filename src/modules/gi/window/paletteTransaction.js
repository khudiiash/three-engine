/**
 * Orders a palette/class-table swap against an asynchronous soup replacement.
 * The callbacks make this CPU-only and keep the policy independently testable.
 */
export function createPaletteTransaction({ publish, setHold }) {
  let serial = 0;
  let pending = null;

  const stage = (payload, { defer = false, hold = defer } = {}) => {
    const token = ++serial;
    if (!defer) {
      // A newer immediate publication supersedes any older worker result.
      if (pending?.held) setHold(false, "superseded");
      pending = null;
      publish(payload);
      return token;
    }
    pending = { token, payload, phase: "building", held: !!hold };
    // Hold before any asynchronous boundary. The old soup and old table remain
    // a matched pair until the replacement has completely refilled the field.
    if (pending.held) setHold(true, "building");
    return token;
  };

  const beginRefill = (token) => {
    if (pending?.token !== token) return false;
    pending.phase = "refilling";
    if (pending.held) setHold(true, "refilling");
    return true;
  };

  const release = () => {
    if (pending?.phase !== "refilling") return false;
    const payload = pending.payload;
    const held = pending.held;
    pending = null;
    // Publication precedes release: the first unheld trace can only observe
    // the new soup/class bytes together with their own table and assignment.
    publish(payload);
    if (held) setHold(false, "complete");
    return true;
  };

  const cancel = (token) => {
    if (pending?.token !== token) return false;
    const held = pending.held;
    pending = null;
    if (held) setHold(false, "cancelled");
    return true;
  };

  return {
    stage,
    beginRefill,
    release,
    cancel,
    get pending() { return !!pending; },
    get phase() { return pending?.phase ?? "idle"; },
    get token() { return pending?.token ?? 0; },
  };
}
