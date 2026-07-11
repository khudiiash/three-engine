import { Component } from "./Component.js";
import { LISTENER_COMPONENT_DEFAULTS } from "../audio/defaults.js";

/**
 * Listener component.
 *
 * One listener is active at a time across the scene. The first to attach
 * pushes itself onto the AudioSystem; subsequent components warn and self-
 * disable so the user can take over manually with a checkbox. Detaching the
 * winner returns the listener to the active camera (the AudioSystem
 * fallback) so audio never goes silent during a swap.
 *
 * `autoFromCamera` is on by default — the listener tracks the entity whose
 * CameraComponent drives the engine camera. Off means "stay where I am";
 * the user can still drag the entity around in play mode.
 */
export class ListenerComponent extends Component {
  static type = "listener";
  static label = "Listener";
  static defaults = LISTENER_COMPONENT_DEFAULTS;
  static schema = [
    { key: "autoFromCamera", label: "Auto from Camera", type: "boolean" },
  ];

  onAttach() {
    this.audioSystem = this.entity?.engine?.audio;
    this._isWinner = false;
    if (!this.audioSystem) return;
    // First-come-first-served. If someone already owns the listener,
    // we defer to them and self-disable (so the user can intentionally
    // take over by clicking our enabled toggle).
    const existing = this.audioSystem.listenerEntity;
    if (!existing) {
      this.#claim();
    } else if (existing === this.entity) {
      this._isWinner = true;
    } else {
      console.warn(
        `Listener on "${this.entity.name ?? this.entity.id}" is yielding — ` +
          `"${existing.name ?? existing.id}" already holds the listener. ` +
          `Disable that component to take over.`,
      );
      this.setEnabled(false);
    }
  }

  onDetach() {
    if (this._isWinner) {
      this.audioSystem?.setListenerEntity(null);
    }
  }

  onEnable() {
    // Re-enabled: try to claim if no one else has it.
    if (this.audioSystem && !this.audioSystem.listenerEntity) this.#claim();
  }

  onDisable() {
    if (this._isWinner) {
      this.audioSystem?.setListenerEntity(null);
      this._isWinner = false;
    }
  }

  onPropChanged(key) {
    if (key === "autoFromCamera") {
      // No runtime impact today (the audio system always reads the entity
      // pose directly). Kept as a no-op so toggling the checkbox does
      // nothing unexpected.
    }
  }

  #claim() {
    if (!this.audioSystem) return;
    this.audioSystem.setListenerEntity(this.entity);
    this._isWinner = true;
  }
}
