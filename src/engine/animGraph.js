import * as THREE from "three/webgpu";

/**
 * Animation controller assets (.anim): a Unity/PlayCanvas-style state machine
 * serialized as JSON —
 *
 *   {
 *     version: 1,
 *     parameters: [{ name, type: "number"|"boolean"|"trigger", default? }],
 *     states: [{ id, name, clip, speed?, loop?, x?, y? }],
 *     startTransitions: [{
 *       to: "<stateId>",                       // entry target
 *       conditions: [{ param, op, value }]     // optional — evaluated once at boot
 *     }],
 *     transitions: [{
 *       id, from: "<stateId>"|"__any__", to: "<stateId>",
 *       duration?: seconds (crossfade), exitTime?: 0..1 normalized | null,
 *       conditions: [{ param, op: ">"|"<"|">="|"<="|"=="|"!=", value }]
 *     }]
 *   }
 *
 * The `__start__` pseudo-state is the entrance to the graph. Drag a wire
 * from the Start node to a state to declare it the default entry — the first
 * Start→X transition's target is the state the animation begins in. If the
 * transition has conditions, the runtime evaluates them once at boot (using
 * the parameter defaults) and the first one whose conditions pass wins.
 * Without Start transitions, the runtime falls back to the first state in
 * the list.
 *
 * `AnimatorRuntime` evaluates the graph every frame against a
 * THREE.AnimationMixer, crossfading between clip actions when a transition's
 * conditions pass. Trigger parameters are consumed by the transition that
 * fires on them. A transition with no conditions waits for `exitTime`
 * (defaulting to the end of the clip) — that's how simple clip chains work.
 */

export const ANY_STATE = "__any__";
export const START_STATE = "__start__";

// Minimum time a freshly-entered state is protected from being reversed out of
// (seconds). Even zero-duration transitions get this much dwell so a graph with
// overlapping/contradictory conditions can't flip back every frame — which,
// because each entry resets the clip to time 0, freezes the model on its first
// frame instead of playing.
const MIN_TRANSITION_LOCK = 0.05;

export function createDefaultAnimator() {
  return {
    version: 1,
    parameters: [],
    states: [],
    startTransitions: [],
    transitions: [],
  };
}

function compare(op, a, b) {
  switch (op) {
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case "!=": return a !== b;
    case "==":
    default:
      return a === b;
  }
}

export class AnimatorRuntime {
  /**
   * @param graph  parsed .anim JSON
   * @param mixer  THREE.AnimationMixer bound to the model root
   * @param clips  THREE.AnimationClip[] available on the model
   */
  constructor(graph, mixer, clips) {
    this.graph = graph;
    this.mixer = mixer;
    this.params = {};
    this.currentId = null;
    this.timeInState = 0;
    // The state we most recently left, plus a countdown that guards against
    // immediately transitioning back into it (anti-thrash — see update()).
    this._leftId = null;
    this.transitionLock = 0;

    for (const p of graph.parameters ?? []) {
      this.params[p.name] = p.default ?? (p.type === "number" ? 0 : false);
    }

    this.paramTypes = Object.fromEntries((graph.parameters ?? []).map((p) => [p.name, p.type]));
    this.states = new Map((graph.states ?? []).map((s) => [s.id, s]));
    this.actions = new Map(); // stateId -> AnimationAction|null
    for (const state of this.states.values()) {
      const clip = clips.find((c) => c.name === state.clip) ?? null;
      if (!clip) {
        if (state.clip) console.warn(`Animator state "${state.name}": clip "${state.clip}" not found`);
        this.actions.set(state.id, null);
        continue;
      }
      const action = mixer.clipAction(clip);
      action.loop = state.loop === false ? THREE.LoopOnce : THREE.LoopRepeat;
      action.clampWhenFinished = true;
      action.timeScale = state.speed ?? 1;
      this.actions.set(state.id, action);
    }

    const entry = this.#resolveEntry();
    if (entry) this.#enter(entry, 0);
  }

  /**
   * The state the runtime begins in. Evaluated once at construction:
   *   - any Start→X transition whose conditions pass (against parameter
   *     defaults) wins, with the first matching one used;
   *   - otherwise the first state in `states[]`;
   *   - otherwise null.
   * For the common "one Start transition, no conditions" case this is just
   * "the first state you wired the Start node to".
   */
  #resolveEntry() {
    const starts = this.graph.startTransitions ?? [];
    for (const t of starts) {
      if (!this.states.has(t.to)) continue;
      // Start transitions are evaluated against parameter defaults with no
      // exit-time gate (there's no current state to time against).
      if (this.#conditionsPass(t, { ignoreExitTime: true })) return t.to;
    }
    return this.graph.states?.[0]?.id ?? null;
  }

  get currentState() {
    return this.currentId ? (this.states.get(this.currentId) ?? null) : null;
  }

  setParam(name, value) {
    if (!(name in this.params)) return console.warn(`Animator: unknown parameter "${name}"`);
    this.params[name] = value;
  }

  /** Triggers stay set until a transition consumes them. */
  setTrigger(name) {
    this.setParam(name, true);
  }

  getParam(name) {
    return this.params[name];
  }

  /** Force-play a state by name (editor preview / scripted override). */
  play(stateName, fade = 0.2) {
    const state = [...this.states.values()].find((s) => s.name === stateName || s.id === stateName);
    if (state) this.#enter(state.id, fade);
    else console.warn(`Animator: no state "${stateName}"`);
  }

  #enter(stateId, fade) {
    const prev = this.currentId ? this.actions.get(this.currentId) : null;
    const next = this.actions.get(stateId);
    if (next) {
      next.reset().play();
      if (prev && prev !== next && fade > 0) {
        prev.crossFadeTo(next, fade, false);
      } else if (prev && prev !== next) {
        prev.stop();
      }
    } else if (prev) {
      prev.fadeOut(fade);
    }
    this._leftId = this.currentId;
    this.currentId = stateId;
    this.timeInState = 0;
    this.transitionLock = Math.max(fade, MIN_TRANSITION_LOCK);
  }

  /** Normalized 0..1 progress through the current state's clip (looped). */
  #normalizedTime() {
    const action = this.currentId ? this.actions.get(this.currentId) : null;
    const duration = action?.getClip().duration;
    if (!action || !duration) return 1;
    const t = action.time / duration;
    return action.loop === THREE.LoopRepeat ? t % 1 : Math.min(t, 1);
  }

  #conditionsPass(transition, { ignoreExitTime = false } = {}) {
    const conditions = transition.conditions ?? [];
    for (const c of conditions) {
      const value = this.params[c.param];
      if (this.paramTypes[c.param] === "trigger") {
        if (!value) return false;
      } else if (!compare(c.op ?? "==", value, c.value)) {
        return false;
      }
    }
    if (ignoreExitTime) return true;
    // Condition-less transitions (and ones with an explicit exitTime) wait
    // for the clip to reach the exit point before firing.
    const exitTime = transition.exitTime ?? (conditions.length === 0 ? 1 : null);
    if (exitTime != null && this.#normalizedTime() < Math.min(exitTime, 1) - 1e-4) return false;
    return true;
  }

  #consumeTriggers(transition) {
    for (const c of transition.conditions ?? []) {
      if (this.paramTypes[c.param] === "trigger") this.params[c.param] = false;
    }
  }

  update(dt) {
    this.mixer.update(dt);
    this.timeInState += dt;
    if (this.transitionLock > 0) this.transitionLock -= dt;
    if (!this.currentId) return;

    for (const t of this.graph.transitions ?? []) {
      // A transition to the current state (self-loop, or an Any→current) would
      // just reset the clip to frame 0 every frame — never auto-take it.
      if (t.to === this.currentId) continue;
      const fromCurrent = t.from === this.currentId;
      const fromAny = t.from === ANY_STATE;
      if (!fromCurrent && !fromAny) continue;
      if (!this.states.has(t.to)) continue;
      // Anti-thrash: while the crossfade into the current state is still
      // settling, don't reverse straight back into the state we just left.
      // Without this, overlapping conditions (e.g. Walk→Run at speed>2 and
      // Run→Walk at speed<3, both true at speed 2.5) flip every frame and the
      // repeated reset() freezes the model on frame 0. Other transitions
      // (triggers, moving on to a third state) are unaffected.
      if (this.transitionLock > 0 && t.to === this._leftId) continue;
      if (!this.#conditionsPass(t)) continue;
      this.#consumeTriggers(t);
      this.#enter(t.to, t.duration ?? 0.25);
      break;
    }
  }

  dispose() {
    this.mixer.stopAllAction();
  }
}
