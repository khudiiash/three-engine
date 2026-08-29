/**
 * Journal JS-side sampled-binding mutations until a whole GI presentation can
 * be committed. Backend texture uploads are harmless; live nodes/bindings and
 * texture bind-group membership are not, because ordinary rendering observes
 * them between retries.
 */
export function createGiBindingMutationJournal(groups) {
  const bindings = new Map();
  const nodes = new Map();
  const memberships = [];
  let extraRollback = null;

  for (const [, slots] of groups ?? []) {
    for (const [binding] of slots ?? []) {
      if (!bindings.has(binding)) {
        bindings.set(binding, {
          texture: binding.texture,
          version: binding.version,
          generation: binding.generation,
          samplerKey: binding.samplerKey,
        });
      }
      const node = binding.textureNode;
      if (node && !nodes.has(node)) nodes.set(node, node.value);
    }
  }

  return {
    setExtraRollback(fn) { extraRollback = typeof fn === "function" ? fn : null; },
    noteMembership(set, value) {
      if (!set?.has?.(value)) memberships.push([set, value]);
    },
    rollback() {
      try { extraRollback?.(); } catch {}
      for (const [node, value] of nodes) node.value = value;
      for (const [binding, state] of bindings) {
        binding.texture = state.texture;
        binding.version = state.version;
        binding.generation = state.generation;
        binding.samplerKey = state.samplerKey;
      }
      for (let i = memberships.length - 1; i >= 0; i--) {
        memberships[i][0]?.delete?.(memberships[i][1]);
      }
      memberships.length = 0;
    },
  };
}
