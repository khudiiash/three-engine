// @ts-check
import { vmRecord } from "./vmState.js";

/**
 * ONE ENGINE-OWNED CONTENT KEY, instead of one full-scene walk per consumer.
 *
 * ## Why this exists
 *
 * Three separate systems answer the same question every frame — "has anything
 * in this scene changed since I last looked?" — and all three answer it the
 * same expensive way: a full `scene.traverse` with sixteen `Math.round` /
 * `Math.imul` per mesh.
 *
 * | walker | file | what it is really asking |
 * |---|---|---|
 * | `fingerprintCasters` | `shadowFreeze.js` | may I hold this shadow map? |
 * | `#gbufferFingerprint` | `gi/GISystem.js` | may I hold this g-buffer? |
 * | `#checkFingerprint` → `#collectMeshes` | `gi/GISystem.js` | did the GI mesh set change? |
 *
 * On Bistro that is 3 637 objects walked two to three times per frame to
 * re-derive a fact the engine already knew: nothing had happened. The engine
 * OWNS every mutation — entities are created through `createEntity`, components
 * announce themselves with `hierarchy-changed`, visibility is written in
 * exactly one loop in `#tick`, merging and the shadow merge already run their
 * own amortised motion watchers. A monotonically bumped integer is the same
 * answer for a compare instead of a walk.
 *
 * ## ⚠⚠ THIS IS A SUFFICIENT *CHANGE* SIGNAL, NEVER A PROOF OF *NO* CHANGE
 *
 * `entity.position` returns the live `Vector3`, so `entity.position.x += 1`
 * from a script writes straight through to `Object3D` with no setter, no event
 * and no bump. Physics write-back, an animation mixer and a tween do the same.
 * There is no chokepoint for those and adding one (a proxied Vector3 on the
 * hot path) would cost more than the walks do.
 *
 * So every consumer of this key MUST keep a cheap periodic AUDIT — re-run the
 * real walk every N frames, compare, and shout when the two disagree. That
 * bounds a missing producer to N frames of staleness instead of forever, and
 * the shout NAMES the hole rather than leaving it to be discovered as "the
 * shadow is wrong after I move something in a script". `auditDisagreed()`
 * exists for exactly that receipt; the consumers call it.
 *
 * ## Categories
 *
 * `version` moves for any change. The sub-versions are snapshots OF `version`
 * at the last change of that kind, so "have transforms moved since I last
 * looked" is `key.transforms !== mySavedValue` — the same compare, no second
 * counter to keep in step. A consumer that only cares about one axis (the GI
 * slot-transform loops) can skip work a material edit caused, and one that
 * cares about everything reads `version` alone.
 */
export class SceneContentKey {
  constructor() {
    /** Any change at all. Monotonic; never reset (a reset is a collision). */
    this.version = 1;
    /** `version` as of the last change of each kind. */
    this.hierarchy = 1;
    this.transforms = 1;
    this.visibility = 1;
    this.materials = 1;
    /** Receipts — how many bumps of each kind, and what said so last. */
    this.counts = { hierarchy: 0, transforms: 0, visibility: 0, materials: 0 };
    this.lastReason = "init";
    /** Audits that caught a change this key did not see. See the banner. */
    this.missed = 0;
    this.lastMissed = null;
    /** Sites already warned about, so a hole is a bug report and not a log storm. */
    this._warned = new Set();
  }

  /**
   * Record a real change. `category` must be one of the four above; `reason` is
   * a short constant string for the receipt (never build it per call on a hot
   * path — pass a literal).
   */
  bump(category, reason) {
    this.version++;
    if (category === "transforms") this.transforms = this.version;
    else if (category === "visibility") this.visibility = this.version;
    else if (category === "materials") this.materials = this.version;
    else {
      // A hierarchy edit can add, remove, re-parent, re-pose, hide and
      // re-material in one go, so it moves every axis. Anything unrecognised
      // lands here too — an unknown change is a total change, never a no-op.
      category = "hierarchy";
      this.hierarchy = this.version;
      this.transforms = this.version;
      this.visibility = this.version;
      this.materials = this.version;
    }
    this.counts[category]++;
    if (reason !== undefined) this.lastReason = reason;
    return this.version;
  }

  /**
   * A consumer's periodic audit found a change no producer announced.
   *
   * Bumps the key (so the consumer's own cache heals on the spot) and warns
   * ONCE per distinct site — a hole in the producer set is a code bug to fix,
   * not a per-frame log. The count keeps climbing so `profile.frameStats` can
   * show that it is still happening after the first line scrolled away.
   */
  auditDisagreed(site) {
    this.missed++;
    this.lastMissed = site;
    this.bump("hierarchy", `audit:${site}`);
    if (!this._warned.has(site)) {
      this._warned.add(site);
      console.warn(
        `[engine] scene content key: "${site}" found a change nothing announced — its periodic audit ` +
          "healed it, but a producer is missing (see contentKey.js). Anything that writes a transform, " +
          "visibility or material outside Entity's setters / hierarchy-changed must call " +
          "engine.content.bump().",
      );
    }
  }

  /** Compact receipt for `profile.frameStats`. */
  stats() {
    return {
      version: this.version,
      hierarchy: this.hierarchy,
      transforms: this.transforms,
      visibility: this.visibility,
      materials: this.materials,
      counts: { ...this.counts },
      lastReason: this.lastReason,
      auditsMissed: this.missed,
      lastMissed: this.lastMissed,
    };
  }
}

/**
 * The live key, reachable from module-level code that has no engine handle.
 *
 * `materialAsset.js` is the case this exists for: an in-place material edit
 * mutates a shared instance with no component, no entity and no event —
 * "In-place edits mutate the shared instance and need no notification" is the
 * file's own comment, and it is true for the RENDERER and false for anything
 * that caches a fingerprint of what the renderer will draw.
 *
 * Through `vmRecord` so a duplicated module graph (see vmState.js — Vite serves
 * the same file under several specifiers) still bumps the key the live engine
 * is reading. A registry that the editor updated through one copy while the
 * viewport read the other is the exact failure that file documents.
 */
const active = vmRecord("sceneContentKey", { key: null });

/** Engine constructor calls this; last engine created wins. */
export function setActiveContentKey(key) {
  active.key = key;
}

/** Bump from module-level code with no engine handle. No-op before an engine exists. */
export function bumpSceneContent(category, reason) {
  active.key?.bump(category, reason);
}
