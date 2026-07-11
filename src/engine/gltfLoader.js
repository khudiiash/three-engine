import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

/**
 * Shared GLTF loader with Draco decoding wired in.
 *
 * The Draco module (src/modules/draco) compresses imported models with
 * KHR_draco_mesh_compression; decoding is the reverse side of that and is
 * ALWAYS available here — a compressed .glb must still load even if a project
 * later disables the module. Plain (uncompressed) .glb files are unaffected:
 * DRACOLoader only kicks in for meshes carrying the extension, and its wasm
 * decoder is fetched lazily on the first compressed mesh, so projects that
 * never use Draco pay nothing.
 *
 * The decoder binaries live in `public/draco/` (copied from three's glTF Draco
 * libs) and ship with both the editor and exported games. The path is left
 * RELATIVE ("draco/") on purpose: DRACOLoader resolves it against the current
 * document URL, which matches how the exported player loads everything else by
 * relative URL — so a game hosted under a subpath (or opened from file://)
 * still finds its decoder. The editor SPA lives at the root, so it resolves to
 * "/draco/" there.
 */
let dracoLoader = null;

function getDracoLoader() {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader().setDecoderPath("draco/");
  }
  return dracoLoader;
}

/** A fresh GLTFLoader with Draco decoding attached. */
export function createGltfLoader() {
  return new GLTFLoader().setDRACOLoader(getDracoLoader());
}

let shared = null;

/** A process-wide shared Draco-enabled GLTFLoader (fine to reuse — GLTFLoader
 *  is stateless across concurrent loadAsync calls). */
export function getGltfLoader() {
  return (shared ??= createGltfLoader());
}

/**
 * Rebase an AnimationClip so its earliest keyframe sits at t=0.
 *
 * Some exporters (Blender NLA strips, FBX "takes", ripped game assets) bake
 * every animation into ONE shared master timeline and slice it into named
 * clips WITHOUT rebasing each slice to zero. glTF then carries, say, a "Run"
 * clip whose keyframes live at t∈[19.77, 20.83]. three.js reads its duration
 * as 20.83s and — because there are no keyframes before 19.77s — holds the
 * first keyframe for the first ~19.8 seconds. Played from time 0 the model
 * looks frozen on one pose, twitches for a second, then loops back to frozen.
 *
 * Shifting every track by the clip's global minimum time fixes this: the
 * earliest keyframe lands at 0, inter-track offsets are preserved, and
 * `resetDuration()` recomputes the real length. Idempotent — a clip already
 * based at zero is left untouched, so re-loading a model can't double-shift.
 */
export function rebaseClipToZero(clip) {
  let min = Infinity;
  for (const track of clip.tracks) {
    if (track.times.length) min = Math.min(min, track.times[0]);
  }
  if (!Number.isFinite(min) || min <= 1e-4) return clip; // already 0-based / empty
  for (const track of clip.tracks) {
    const { times } = track;
    for (let i = 0; i < times.length; i++) times[i] -= min;
  }
  clip.resetDuration();
  return clip;
}
