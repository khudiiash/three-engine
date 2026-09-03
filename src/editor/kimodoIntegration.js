// @ts-check

const START_STATE = "__start__";

/** Turn a free-form prompt into a short, readable clip/state name. */
export function suggestGeneratedClipName(prompt) {
  const words = String(prompt ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  return name || "Generated";
}

/** Never append a same-named clip: Three's binder resolves the first match. */
export function uniqueGeneratedClipName(requested, existingNames) {
  const base = String(requested || "Generated").trim() || "Generated";
  const used = new Set((existingNames ?? []).map((name) => String(name).toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix < 10000; suffix++) {
    const candidate = `${base} ${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * Add a generated clip as a selected state. An empty layer also gets its
 * entry wire, so the controller is immediately useful without another edit.
 */
export function addGeneratedAnimatorState({ nodes, edges, clipName, makeId }) {
  const id = makeId("state");
  const stateNodes = nodes.filter((node) => node.type === "animState");
  const position = { x: 220 + (stateNodes.length % 3) * 60, y: 120 + (stateNodes.length % 4) * 70 };
  const node = {
    id,
    type: "animState",
    position,
    selected: true,
    data: { state: { id, name: clipName, kind: "clip", clip: clipName, speed: 1, loop: true } },
  };
  const nextNodes = [...nodes.map((current) => ({ ...current, selected: false })), node];
  const nextEdges = edges.map((edge) => ({ ...edge, selected: false }));
  if (!stateNodes.length && !nextEdges.some((edge) => edge.source === START_STATE)) {
    nextEdges.push({
      id: makeId("st"),
      source: START_STATE,
      target: id,
      data: { conditions: [], kind: "start" },
    });
  }
  return { nodes: nextNodes, edges: nextEdges, stateId: id, stateName: clipName };
}
