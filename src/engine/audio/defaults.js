/**
 * Shared constants for the audio subsystem. Inspector pickers and runtime
 * validation read from here so the UI options stay in sync with the
 * engine-side coercion (e.g. falloff string → distanceModel string).
 */

export const FALLOFF_OPTIONS = ["linear", "inverse", "exponential"];
export const FALLOFF_DISTANCE_MODELS = {
  linear: "linear",
  inverse: "inverse",
  exponential: "exponential",
};

export const LOOP_OPTIONS = ["no", "yes", "random", "pingPong"];
// "random" and "pingPong" use the same looping source with different start
// offsets; implemented in SoundComponent rather than in the PannerNode.
export const LOOP_SOURCE_FLAGS = {
  no: false,
  yes: true,
  random: "random",
  pingPong: "pingPong",
};

export const PLAYBACK_OPTIONS = ["2D", "3D"];

// Spatial presets map a friendly name to a sensible set of panner params.
// Anything not in the preset list falls back to "default" values.
export const SPATIAL_PRESETS = {
  default: { panningModel: "HRTF", distanceModel: "inverse", refDistance: 1, maxDistance: 100, rolloffFactor: 1 },
  ambient: { panningModel: "equalpower", distanceModel: "linear", refDistance: 0, maxDistance: 1, rolloffFactor: 0 },
  music: { panningModel: "HRTF", distanceModel: "linear", refDistance: 0.5, maxDistance: 50, rolloffFactor: 0.5 },
  voice: { panningModel: "HRTF", distanceModel: "inverse", refDistance: 1, maxDistance: 30, rolloffFactor: 1.4 },
  effect: { panningModel: "HRTF", distanceModel: "exponential", refDistance: 1, maxDistance: 80, rolloffFactor: 1.8 },
};

export const DEFAULT_SPATIAL_PRESET = "default";
export const DEFAULT_FALLOFF = "inverse";
export const DEFAULT_REF_DISTANCE = 1;
export const DEFAULT_MAX_DISTANCE = 100;
export const DEFAULT_ROLLOFF_FACTOR = 1;

// Active time-range. The component interprets start/end as seconds since
// the entity entered the scene; a missing end means "play through to the
// end of the source" (or loop forever). Storing `null` rather than `0` lets
// the entry default to "full duration" with no user input.
export const DEFAULT_DURATION = null;
export const DEFAULT_START_DELAY = 0;

// Fade defaults: 0 = no fade. Inspector exposes seconds.
export const DEFAULT_FADE_IN = 0;
export const DEFAULT_FADE_OUT = 0;

// Variances: 0 = none. Inspector exposes a normalized fraction (0..1) which
// gets scaled into a per-instance random ± bound when the sound plays.
export const DEFAULT_VOLUME_VARIANCE = 0;
export const DEFAULT_PITCH_VARIANCE = 0;

// Top-level defaults for the SoundComponent itself.
export const SOUND_COMPONENT_DEFAULTS = {
  entries: [],
  occlusionEnabled: true,
  occlusionAttenuation: 0.85,
  spatialPreset: DEFAULT_SPATIAL_PRESET,
};

// Per-entry defaults. Matches the shape referenced by SoundComponent.
export function makeDefaultEntry() {
  return {
    id: createEntryId(),
    audioAsset: "",
    name: "",
    playback: "3D",
    loop: "no",
    volume: 1,
    volumeVariance: DEFAULT_VOLUME_VARIANCE,
    pitch: 1,
    pitchVariance: DEFAULT_PITCH_VARIANCE,
    startDelay: DEFAULT_START_DELAY,
    duration: DEFAULT_DURATION,
    fadeIn: DEFAULT_FADE_IN,
    fadeOut: DEFAULT_FADE_OUT,
    falloff: DEFAULT_FALLOFF,
    refDistance: DEFAULT_REF_DISTANCE,
    maxDistance: DEFAULT_MAX_DISTANCE,
    rolloffFactor: DEFAULT_ROLLOFF_FACTOR,
    spatial: true,
  };
}

let _entryCounter = 0;
function createEntryId() {
  _entryCounter += 1;
  return `entry_${Date.now().toString(36)}_${_entryCounter.toString(36)}`;
}

export const LISTENER_COMPONENT_DEFAULTS = {
  autoFromCamera: true,
};
