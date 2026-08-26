import { Component } from "../../engine/components/Component.js";
import { GI_DEBUG_VIEWS, GI_QUALITY_LEVELS } from "./giConfig.js";

/**
 * Global Illumination via Split Radiance Cascades.
 *
 * THREE PROPERTIES: `quality`, and the `ao`/`reflections` feature toggles
 * (2026-08-21). The toggles are quality's kin, not the 27's return — see the
 * note on `defaults`.
 *
 * ══ WHY, BECAUSE THIS COMPONENT USED TO HAVE 27 ════════════════════════════
 *
 * Volume size, voxel size, probe spacing, cascade count, c0 direction
 * resolution, intensity, sky colour and intensity, bounce energy, bleed
 * saturation, two smoothing rates, reflections, exact reflections, four
 * ray-hit switches, three AO fields, three resolve budgets, boot ambient, a
 * debug view. Every one was added for a real reason in its own session, and
 * together they made "the lighting looks wrong" a search problem: WHICH of the
 * 27 is responsible? A stored value from a year-old edit is indistinguishable
 * from a bug in the transport, and the module has genuinely shipped both.
 *
 * GI is not a look to be dialled in. It is either CORRECT or it is BROKEN, and
 * a property that can make it wrong is a bug generator with a label on it. A
 * quality preset is a different kind of thing — it trades COST against
 * ACCURACY, and every level of it is meant to be right. So the preset stays and
 * the rest is derived, in one table, in `giConfig.js`.
 *
 * ══ THE TWO THINGS THAT MOVED INSTEAD OF DYING ═════════════════════════════
 *
 * · SKY LIGHT is a light source, not a dial. It comes from the scene's own
 *   environment now (`scene.environment` + `environmentIntensity`), which is
 *   where three.js, Scene Settings and the HDRI Environment component already
 *   keep image-based lighting. No environment means no sky, exactly as
 *   `skyIntensity: 0` did.
 * · THE DEBUG VIEW never touched the lit image — it draws an overlay. It is a
 *   developer instrument; the SDF / occupancy / SRC-probes overlays live at
 *   `globalThis.__giDebugView`, and the GI-term overlays (indirect / AO /
 *   reflections) are also reachable through `props.debugView` so an inspector
 *   user can flip them without typing a global. `debugView` is `advanced` and
 *   NOT part of the structural signature — flipping it is a live swap of the
 *   overlay's source texture, never a module rebuild.
 *
 * Saved scenes with the old properties load unchanged; undeclared keys are
 * ignored and drop on the next save. A scene that stored `intensity: 2` renders
 * at 1 afterwards, which is the point rather than a casualty.
 *
 * The entity's position no longer matters: the volume always auto-fits the
 * scene's GI-relevant content. One component is active at a time (last attached
 * wins — same convention as Environment). Scene changes re-voxelize the
 * occupancy pyramid automatically, and lighting re-evaluates every frame, so it
 * reacts within a frame of the geometry updating.
 */
export class GlobalIlluminationComponent extends Component {
  static type = "global-illumination";
  static label = "Global Illumination";
  static tags = ["rendering", "lighting", "gi", "radiance-cascades"];

  static defaults = {
    // "medium" rather than "high": the default should be the setting that runs
    // everywhere, and the tier ladder is only meaningful if the middle of it is
    // where people start.
    quality: "medium",
    // The two feature toggles (2026-08-21). They survive the one-knob
    // doctrine because they are the same KIND of property quality is: each
    // removes a whole term at a whole cost — Ambient Occlusion is the
    // contact-darkening pass on the indirect term, Reflections is the glossy
    // radiance chain plus ultra's exact mirrors — and neither can mis-TUNE
    // anything, which is the failure the 27-property collapse was aimed at.
    ao: true,
    reflections: true,
    // Debug view: an overlay-source switch, NOT a lighting parameter. Default
    // "off" so an authoring scene never ships with a debug view on; the field
    // is also `advanced` (collapsed by default) because it is a developer
    // instrument. See giConfig's `GI_DEBUG_VIEWS` for what each mode draws.
    debugView: "off",
  };

  static schema = [
    // NOTHING IS `advanced` HERE ANY MORE EXCEPT `debugView`, and there is
    // nothing for `flipsToCustom` to flip to — "custom" was the Inspector's
    // way of saying "an advanced field was hand-edited so the preset name no
    // longer implies its values", and the only advanced field (debugView) is
    // not a value the quality tier controls, so it cannot make a preset lie.
    { key: "quality", label: "Quality", type: "select", options: [...GI_QUALITY_LEVELS] },
    { key: "ao", label: "Ambient Occlusion", type: "boolean" },
    { key: "reflections", label: "Reflections", type: "boolean" },
    {
      key: "debugView",
      label: "Debug View",
      type: "select",
      options: [...GI_DEBUG_VIEWS],
      advanced: true,
    },
  ];

  get #system() {
    return this.entity?.engine?.modules?.get("gi")?.system ?? null;
  }

  /**
   * NAME THE PROPERTIES THAT NO LONGER DO ANYTHING, once per session.
   *
   * A retired property is silently ignored, which is the exact failure this
   * whole collapse is aimed at: a value sitting in a scene file (or, more
   * often, in a measurement harness) that looks like it is configuring
   * something and is not. `run-gi-emitter-shadow-probe` passed
   * `emissiveShadows: true` and would have gone on measuring a feature that was
   * no longer being built — it failed loudly only because the readback hit an
   * undefined texture, which is luck rather than design.
   *
   * So: say so. A saved scene gets one line telling the author their stored
   * values are inert and will drop on the next save; a harness gets the same
   * line pointing at `__giConfigOverride`, which is how a probe forces a value
   * a preset does not choose.
   */
  #warnRetiredProps() {
    const declared = new Set(GlobalIlluminationComponent.schema.map((f) => f.key));
    const retired = Object.keys(this.props ?? {})
      .filter((k) => k !== "enabled" && !declared.has(k));
    if (!retired.length) return;
    const seen = (globalThis.__giRetiredPropWarned ??= new Set());
    const signature = retired.join(",");
    if (seen.has(signature)) return;
    seen.add(signature);
    console.warn(
      `[gi] ignoring ${retired.length} retired propert${retired.length === 1 ? "y" : "ies"}: ` +
      `${retired.join(", ")}. Global Illumination has FOUR properties — quality, ao, ` +
      "reflections, debugView — and everything else is derived (src/modules/gi/giConfig.js). Sky " +
      "light comes from the scene's environment; the SDF/occupancy/SRC-probes debug view is " +
      "globalThis.__giDebugView; a probe that must force a value uses " +
      "globalThis.__giConfigOverride. Stored values drop on the next save.",
    );
  }

  onAttach() {
    this.#warnRetiredProps();
    this.#system?.attach(this);
  }

  onDetach() {
    this.#system?.detach(this);
  }

  onEnable() {
    this.#system?.attach(this);
  }

  onDisable() {
    // Keep attachment but drop runtime output; system checks `enabled` per
    // tick, and a disabled component's light should not linger.
    this.#system?.detach(this);
  }

  onPropChanged(key) {
    this.#system?.onComponentProp(this, key);
  }
}
