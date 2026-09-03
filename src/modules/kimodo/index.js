/**
 * Motion Generation module — text-to-animation through kimodo.cpp
 * (github.com/localai-org/kimodo.cpp, NVIDIA's Kimodo ported to GGML).
 *
 * Pure editor tooling: the Animator panel's "Generate Animation…" action
 * discovers the local runtime and runs it in-process (with CLI fallback),
 * (src-tauri `generate_motion`) and retargets the result onto the selected
 * entity's model via src/editor/kimodoRetarget.js. There is no runtime
 * component or system on purpose — generated clips are ordinary
 * AnimationClips on the model asset by the time a game runs, so exported
 * scenes never touch this module (the same shape as draco's editor-side
 * compression, and zero-component modules like audio-library are normal
 * here).
 *
 * The native editor discovers a complete kimodo.cpp installation beside the
 * editor/project (or in the managed app-data location); no checkout path is
 * part of the UI or project. This catalog entry remains for projects that
 * already record the editor-only integration as a module dependency.
 *
 * Licensing: the SOMA RP/SEED v1.1 checkpoints are commercially usable under
 * NVIDIA's Open Model License, which claims no ownership of generated output.
 * The SMPL-X checkpoint is research-only and this pipeline never selects it;
 * model/text weights stay editor-local and are not included in game exports.
 */
export const kimodoModule = {
  id: "kimodo",
  name: "Motion Generation",
  version: "1.0.0",
  category: "AI",
  tags: ["animation", "motion", "text-to-motion", "ai", "generator", "kimodo", "editor-only"],
  description:
    "Generate skeletal animation clips from a text prompt, retargeted onto a " +
    "character's own skeleton — walks, waves, attacks — without leaving the " +
    "Animator. The local runtime is discovered automatically; clips land on " +
    "the model asset as ordinary animation and open as a ready-to-preview state.",
  components: [],
  async setup() {
    // Editor-only tooling: nothing to spin up on the engine. The Animator
    // gates its Generate action on this module being enabled.
    return {};
  },
};
