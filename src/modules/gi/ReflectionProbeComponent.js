import { Component } from "../../engine/components/Component.js";
import { MAX_REFLECTION_PROBES } from "./reflectionProbes.js";

/**
 * A box-projected reflection probe (GI plan §14 unit R-B).
 *
 * Place one per room (or per distinct reflective space): the GI system traces
 * a small radiance map at this entity's position — GI-lit walls, emitters'
 * light, the HDRI through openings — and every reflective material inside the
 * box reflects it, parallax-corrected against the box so walls land where
 * they are. World-space by construction: it shows rooms behind the camera and
 * everything off-screen, which is exactly what screen-space reflections
 * cannot.
 *
 * COST: two texture fetches per reflective pixel at runtime, plus one
 * amortized 128² traced re-capture (a fraction of a millisecond, round-robin
 * across probes, at most one per frame). Works at EVERY quality tier — this
 * is the cheap reflections path; ultra's exact per-pixel mirrors still win on
 * mirror-bucket pixels where they resolve a hit.
 *
 * THE BOX: centred on the entity, `size` metres a side (× the entity's world
 * scale). Match it to the room — box projection is nearly exact when the box
 * IS the room. The capture point is the entity's position; put it where eyes
 * are, roughly mid-room, not inside furniture.
 *
 * LIMITS (v1, deliberate): the capture traces the STATIC scene (the same BVH
 * exact reflections use), so characters and movers appear in mirrors only via
 * the ultra exact path — not in probes. Boxes are world-axis-aligned; a
 * rotated room works but its parallax correction degrades toward plain
 * cubemap lookup.
 */
export class ReflectionProbeComponent extends Component {
  static type = "reflection-probe";
  static label = "Reflection Probe";
  static tags = ["rendering", "lighting", "gi"];

  static defaults = {
    // A room-ish default; authors stretch it to the space with the gizmo box
    // visible. No intensity/blend dials — the capture IS the lighting, and a
    // probe that can be mis-tuned is a bug generator (the GI component's
    // 27-property lesson).
    size: [8, 4, 8],
  };

  static schema = [
    { key: "size", label: "Box Size", type: "vec3", step: 0.1 },
  ];

  get #system() {
    return this.entity?.engine?.modules?.get("gi")?.system ?? null;
  }

  onAttach() {
    this.#system?.attachReflectionProbe?.(this);
  }

  onDetach() {
    this.#system?.detachReflectionProbe?.(this);
  }

  onEnable() {
    this.#system?.attachReflectionProbe?.(this);
  }

  onDisable() {
    this.#system?.detachReflectionProbe?.(this);
  }

  onPropChanged() {
    this.#system?.onReflectionProbeChanged?.(this);
  }

  /** The box (feathered at its faces) and the capture point at its centre. */
  onDrawGizmosSelected(gizmos) {
    const object = this.entity?.object3D;
    if (!object) return;
    object.updateWorldMatrix(true, false);
    const size = this.props.size ?? [8, 4, 8];
    gizmos.transform(object.matrixWorld);
    gizmos.color("#57d4a0");
    gizmos.box([0, 0, 0], [size[0] ?? 8, size[1] ?? 4, size[2] ?? 8]);
    gizmos.transform(null);
  }
}

export { MAX_REFLECTION_PROBES };
