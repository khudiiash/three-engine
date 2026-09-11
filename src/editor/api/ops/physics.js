/**
 * Destruction, chains and ragdolls, as ops.
 *
 * These three components share a problem that made ops worth writing rather
 * than leaving them to `component.setProp`: WHAT THEY DO IS INVISIBLE UNTIL
 * SOMETHING HAPPENS. A destructible's piece count, a chain's joints and a
 * ragdoll's bone selection are all derived at runtime from geometry, hierarchy
 * or a skeleton — none of them is in `props`, so an agent reading the
 * component back learns nothing about whether it will work. `physics.status`
 * answers that (how many pieces are baked, which bones got bodies, whether the
 * chain found its links), and the two verbs make the thing happen so it can be
 * looked at.
 *
 * Everything else — every authored setting — is an ordinary component prop and
 * goes through `component.setProp`, which is why there is no `physics.set`.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { useModulesStore } from "../../modules.js";

function requirePhysicsModule() {
  if (!useModulesStore.getState().enabled.includes("physics-rapier")) {
    throw new Error('The "physics-rapier" module is not enabled for this project. Enable it with module.setEnabled.');
  }
}

function requireComponent(entityId, type) {
  requirePhysicsModule();
  const entity = engine.getEntity(entityId);
  if (!entity) throw new Error(`No entity "${entityId}".`);
  const component = entity.getComponent(type);
  if (!component) throw new Error(`Entity "${entity.name}" has no ${type} component. Add it with component.add first.`);
  return { entity, component };
}

const round = (n) => (typeof n === "number" ? +n.toFixed(3) : n);

defineOp({
  name: "physics.status",
  readOnly: true,
  description:
    "What a Destructible, Chain or Ragdoll has actually built — the half of these components that is derived at runtime and therefore invisible in their props. Reports, per entity: a destructible's broken state, live debris and whether its fracture is baked; a chain's links, the joint holding them and where they came from (children or instancer instances); a ragdoll's simulated bones and their masses. Pass an entityId for one, or nothing for every one in the scene. Read it after play.set({playing:true}) — a chain and a ragdoll only exist while the world does.",
  params: {
    entityId: { type: "string", description: "One entity. Omit for every destructible/chain/ragdoll in the scene." },
  },
  run: ({ entityId }) => {
    requirePhysicsModule();
    const entities = entityId
      ? [engine.getEntity(entityId)].filter(Boolean)
      : [...engine.entities.values()];
    const report = [];
    for (const entity of entities) {
      const destructible = entity.getComponent("destructible");
      const chain = entity.getComponent("chain");
      const ragdoll = entity.getComponent("ragdoll");
      if (!destructible && !chain && !ragdoll) continue;
      const row = { entityId: entity.id, name: entity.name };
      if (destructible) {
        row.destructible = {
          enabled: destructible.enabled,
          broken: destructible.broken,
          debris: destructible.debris?.length ?? 0,
          trigger: destructible.props.trigger,
          pieces: destructible.props.pieces,
          // The one number that says whether the first break will hitch.
          baked: destructible.isBaked(),
          watchingForce: engine.physics?.contactForceEntities?.get(entity) ?? null,
        };
      }
      if (chain) {
        row.chain = {
          enabled: chain.enabled,
          source: chain.props.source,
          joint: chain.props.jointKind,
          links: chain.links?.length ?? 0,
          // A chain with fewer than two links did not find what it was told to
          // link — the single most likely thing to be wrong with one.
          built: (chain.links?.length ?? 0) >= 2,
        };
      }
      if (ragdoll) {
        row.ragdoll = {
          enabled: ragdoll.enabled,
          active: ragdoll.props.active,
          simulating: ragdoll.simulating,
          bones: ragdoll.getBones(),
          masses: ragdoll.parts?.map((part) => round(part.body.mass())) ?? [],
        };
      }
      report.push(row);
    }
    return { playing: engine.playing, entities: report };
  },
});

defineOp({
  name: "physics.destructible.break",
  description:
    "Break a destructible now, as an impact at `point` would. Returns the pieces that were spawned. Works while playing (the pieces are simulated) and while stopped (they are created but nothing moves). `reset: true` puts the object back together instead — the debris is destroyed and the original returns, which is what the component does on Stop anyway.",
  params: {
    entityId: { type: "string", required: true },
    point: { type: "array", description: "World-space [x, y, z] the break radiates from. Defaults to the object's centre." },
    scatter: { type: "number", description: "Outward speed of the pieces in m/s. Defaults to the component's own." },
    reset: { type: "boolean", default: false, description: "Put it back together instead of breaking it." },
  },
  run: ({ entityId, point, scatter, reset }) => {
    const { component } = requireComponent(entityId, "destructible");
    if (reset) return { entityId, broken: false, reset: component.reset() };
    const broke = component.break({
      ...(Array.isArray(point) && point.length === 3 ? { point } : {}),
      ...(Number.isFinite(scatter) ? { scatter } : {}),
    });
    return {
      entityId,
      broke,
      broken: component.broken,
      pieces: component.debris.map((piece) => ({ entityId: piece.id, name: piece.name })),
    };
  },
});

defineOp({
  name: "physics.destructible.prefracture",
  description:
    "Cut a destructible's pieces now and cache them, so the first break costs nothing. Fracturing is CSG and is measured in milliseconds per piece; the component does this in idle time on its own, and this op is how an agent makes sure it has finished before timing or screenshotting a break. Returns the piece count.",
  params: { entityId: { type: "string", required: true } },
  run: async ({ entityId }) => {
    const { component } = requireComponent(entityId, "destructible");
    const pieces = await component.prefracture();
    return { entityId, pieces, baked: component.isBaked() };
  },
});

defineOp({
  name: "physics.ragdoll.set",
  description:
    "Make a character go limp, or get up. Activating builds one capsule body per bone from the skeleton's own shape, suspends the Animator and Character Controller (without touching their authored settings) and hands the skeleton to the simulation; deactivating gives it back in whatever pose it landed. `impulse` is a world-space kick applied on activation — the hit that killed them. Requires play mode: there is no physics world in the editor.",
  params: {
    entityId: { type: "string", required: true },
    active: { type: "boolean", default: true },
    impulse: { type: "array", description: "World-space [x, y, z] N·s applied on activation." },
    bone: { type: "string", description: "Which bone takes the impulse (physics.status lists them). Defaults to the root." },
  },
  run: ({ entityId, active, impulse, bone }) => {
    const { component } = requireComponent(entityId, "ragdoll");
    if (active === false) {
      component.deactivate();
      return { entityId, simulating: false };
    }
    component.activate({
      ...(Array.isArray(impulse) && impulse.length === 3 ? { impulse } : {}),
      ...(bone ? { bone } : {}),
    });
    if (!component.simulating && !engine.playing) {
      throw new Error("A ragdoll only exists while playing. Call play.set({ playing: true }) first.");
    }
    return { entityId, simulating: component.simulating, bones: component.getBones() };
  },
});

defineOp({
  name: "physics.chain.rebuild",
  description:
    "Rebuild a chain's bodies and joints from its current links and settings. The component does this on its own when a property changes; this is for the cases it cannot see — a child added or removed while playing, or an Instancer that has just re-laid its instances. Returns how many links it found.",
  params: { entityId: { type: "string", required: true } },
  run: ({ entityId }) => {
    const { component } = requireComponent(entityId, "chain");
    const rebuilt = component.rebuild();
    if (!rebuilt) throw new Error("A chain is only built while playing. Call play.set({ playing: true }) first.");
    return { entityId, links: component.links.length, source: component.props.source };
  },
});
