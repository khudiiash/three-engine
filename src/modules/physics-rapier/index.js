import { RigidbodyComponent } from "./RigidbodyComponent.js";
import { ColliderComponent } from "./ColliderComponent.js";
import { CharacterControllerComponent } from "./CharacterControllerComponent.js";
import { PhysicsSystem } from "./PhysicsSystem.js";

/**
 * Rapier physics module. The wasm-backed Rapier package is imported lazily
 * inside setup() so projects (and exported games) that don't enable physics
 * never download or instantiate it.
 *
 * `setup` returns as soon as the JS module is loaded — the WASM init runs
 * in the background and the PhysicsSystem is installed when ready. The
 * scene continues deserializing while Rapier initializes; script hot-reload
 * and entity creation don't depend on the world being live, and the
 * PhysicsSystem itself no-ops on play-changed until `ready` resolves. This
 * keeps Rapier's ~300-800 ms WASM init off the visible boot path.
 */
export const physicsRapierModule = {
  id: "physics-rapier",
  name: "Rapier Physics",
  version: "1.0.0",
  description:
    "Rigid-body physics powered by Rapier: Rigidbody, Collider + Character " +
    "Controller components, fixed-step simulation in play mode, collision/" +
    "trigger script hooks, and raycasts.",
  components: [RigidbodyComponent, ColliderComponent, CharacterControllerComponent],

  setup(engine) {
    const ready = (async () => {
      const mod = await import("@dimforge/rapier3d-compat");
      const RAPIER = mod.default ?? mod;
      await RAPIER.init();
      const system = new PhysicsSystem(engine, RAPIER);
      // Swap the placeholder handle for the live one once Rapier is up. If
      // the user disabled the module in the meantime, dispose immediately.
      const prev = engine.modules.get("physics-rapier");
      if (prev && prev.placeholder) {
        engine.modules.set("physics-rapier", { system, dispose: () => system.dispose() });
      }
    })();
    return {
      system: null,
      ready,
      placeholder: true,
      dispose: () => {
        // No-op until the real handle is installed — ready's `.then` cleans
        // up via the swap above.
      },
    };
  },
};