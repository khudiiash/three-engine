// Example: third-person-style character controller using the engine's
// Unity-style Input System. Attach this script to an entity with a
// MeshComponent (capsule) and a CameraComponent to see it move + rotate
// in response to the Player action map's "Move" / "Look" / "Jump" actions.
//
// Conventions:
//   this.entity     — the live Entity (Object3D, components, …)
//   this.engine     — the runtime Engine (scene, renderer, modules, input)
//   this.THREE      — the bundled three.js namespace
//   this.input      — the InputManager, see engine.input below.

import { attribute } from "engine";

export default class PlayerController {
  // Inspector-editable attributes. The editor reads these via @attribute.
  @attribute({ type: "number", default: 6, min: 0.1, max: 30, step: 0.1, label: "Move Speed" })
  moveSpeed = 6;

  @attribute({ type: "number", default: 90, min: 10, max: 360, step: 1, label: "Look Sensitivity (deg/s)" })
  lookSensitivity = 90;

  @attribute({ type: "number", default: 6, min: 1, max: 30, step: 0.1, label: "Jump Velocity" })
  jumpVelocity = 6;

  @attribute({ type: "number", default: 9.81, min: 0, max: 30, step: 0.1, label: "Gravity" })
  gravity = 9.81;

  @attribute({ type: "boolean", default: true, label: "Invert Y" })
  invertY = false;

  // -- Lifecycle (called by ScriptComponent while the engine is playing) --

  onStart() {
    // Tunable movement state lives on the entity (read each frame).
    this.velocity = [0, 0, 0];
    this.onGround = true;
    this.pitch = 0; // local camera pitch (deg)
    this.yaw = 0; // body yaw (deg)
  }

  onUpdate(dt) {
    const input = this.input;
    if (!input) return;

    // ---- Read Move (vec2) and Look (vec2) ----
    const move = input.readValue("Move"); // {x, y}, x = strafe, y = forward
    const look = input.readValue("Look"); // {x, y} — mouse delta scaled, or right stick
    const jumpPressed = input.wasPressedThisFrame("Jump");
    const sprintHeld = input.isPressed("Sprint");

    // ---- Look: rotate the body yaw and pitch the camera entity ----
    const sens = this.lookSensitivity * dt;
    this.yaw -= (look.x ?? 0) * sens;
    const invert = this.invertY ? 1 : -1;
    this.pitch -= (look.y ?? 0) * sens * invert;
    this.pitch = Math.max(-89, Math.min(89, this.pitch));

    this.entity.object3D.rotation.set(0, (this.yaw * Math.PI) / 180, 0);

    // If a camera is on this entity (or a child), pitch just it — leave the
    // body rotating on yaw only. Look for a camera component to find it.
    const cam = this.entity.getComponent("camera");
    if (cam?.camera) {
      cam.camera.rotation.set((this.pitch * Math.PI) / 180, 0, 0);
    } else {
      // No camera on this entity — pitch the whole entity.
      this.entity.object3D.rotation.x = (this.pitch * Math.PI) / 180;
    }

    // ---- Move: forward/right from yaw, scale by sprint ----
    const speed = this.moveSpeed * (sprintHeld ? 1.7 : 1);
    const rad = (this.yaw * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const fx = -sin * (move.y ?? 0) + cos * (move.x ?? 0);
    const fz = -cos * (move.y ?? 0) - sin * (move.x ?? 0);

    this.velocity[0] = fx * speed;
    this.velocity[2] = fz * speed;

    // ---- Jump (single-frame edge) ----
    if (jumpPressed && this.onGround) {
      this.velocity[1] = this.jumpVelocity;
      this.onGround = false;
    }

    // ---- Gravity ----
    this.velocity[1] -= this.gravity * dt;

    // ---- Apply position (no physics integration — swap for your physics
    // module if enabled). Ground clamp: assume y=0 is the floor. ----
    this.entity.object3D.position.x += this.velocity[0] * dt;
    this.entity.object3D.position.y += this.velocity[1] * dt;
    this.entity.object3D.position.z += this.velocity[2] * dt;
    if (this.entity.object3D.position.y <= 0) {
      this.entity.object3D.position.y = 0;
      this.velocity[1] = 0;
      this.onGround = true;
    }
  }

  onDestroy() {
    // Nothing to tear down — InputManager subscriptions live on the manager,
    // not on this instance. If you `input.onAction(...)` here, store the
    // unsubscribe and call it here.
  }
}