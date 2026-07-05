import { RigidbodyComponent } from "./RigidbodyComponent.js";
import { ColliderComponent } from "./ColliderComponent.js";
import { PhysicsSystem } from "./PhysicsSystem.js";

/**
 * Rapier physics module. The wasm-backed Rapier package is imported lazily
 * inside setup() so projects (and exported games) that don't enable physics
 * never download or instantiate it.
 */
export const physicsRapierModule = {
  id: "physics-rapier",
  name: "Rapier Physics",
  version: "1.0.0",
  description:
    "Rigid-body physics powered by Rapier: Rigidbody + Collider components, " +
    "fixed-step simulation in play mode, collision/trigger script hooks, and raycasts.",
  components: [RigidbodyComponent, ColliderComponent],

  async setup(engine) {
    const mod = await import("@dimforge/rapier3d-compat");
    const RAPIER = mod.default ?? mod;
    await RAPIER.init();
    const system = new PhysicsSystem(engine, RAPIER);
    return {
      system,
      dispose: () => system.dispose(),
    };
  },
};
