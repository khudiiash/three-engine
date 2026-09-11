import type { Entity } from "engine";

declare module "engine" {
  interface EngineEventMap {
    /** A sensor collider started/stopped overlapping another collider. */
    trigger: [event: { a: Entity; b: Entity; started: boolean }];
    /** A solid collider started/stopped touching another collider. */
    collision: [event: { a: Entity; b: Entity; started: boolean }];
    /**
     * How hard two colliders hit, in newtons, for the entities that asked to
     * be told (`Destructible` with `trigger: "impact"`, or
     * `engine.physics.watchContactForce(entity, threshold)`). Not reported for
     * anything else — arming it scene-wide would price every resting contact.
     */
    "contact-force": [event: { a: Entity; b: Entity; magnitude: number; point: [number, number, number] }];
    /** A Destructible broke, with the number of pieces it became. */
    "destructible-broken": [event: { entity: Entity; pieces: number; point: [number, number, number] }];
  }
}
