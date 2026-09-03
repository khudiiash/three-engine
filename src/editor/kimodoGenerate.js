// @ts-check
/**
 * The editor-side half of "Generate Animation…": turn a text prompt into a
 * clip ON the selected entity's model.
 *
 * Pipeline: Tauri discovers and runs the local Kimodo runtime with the prompt,
 * reads back its raw
 * f32 streams, and THIS module retargets them onto the entity's model via
 * `kimodoRetarget.js` (the exact code the offline CLI and its test suite
 * exercise), then writes the model GLB back in place — with a timestamped
 * backup of the original beside the generation outputs, because overwriting
 * a model asset is not on the undo stack.
 *
 * Everything filesystem-facing goes through the same commands the rest of
 * the editor uses (read_binary_file / write_binary_file), so the shimmed
 * Tauri in smoke harnesses can back them without knowing about kimodo.
 */
import { invoke } from "./assetOps.js";
import { invalidateBlobUrl, readAssetBinary, writeBinaryFile } from "./assetLoader.js";
import { useProjectStore } from "./store/projectStore.js";
import { getKimodoPrefs } from "./kimodoPrefs.js";
import { retargetKimodoToModel } from "./kimodoRetarget.js";
import { engine } from "./engineInstance.js";
import { suggestGeneratedClipName } from "./kimodoIntegration.js";

/** Decode kimodo's little-endian f32 streams (Float32Array is LE on all
 * browsers that run this editor; be explicit rather than lucky). */
export function decodeF32(buffer) {
  return new Float32Array(buffer.slice(0));
}

/**
 * Generate a motion from `prompt` and retarget it onto the entity's model.
 *
 * @param {object} opts
 * @param {object} opts.entity Scene-store entity (needs a `model` component).
 * @param {string} opts.prompt
 * @param {number} [opts.frames] Frame count at 30 fps (default 90 ≈ 3 s).
 * @param {number} [opts.steps]
 * @param {number} [opts.seed]
 * @param {boolean} [opts.travel]
 * @param {string} [opts.clipName]
 * @returns {Promise<{clipName: string, frames: number, modelPath: string, liveModels: number}>}
 */
export async function generateAnimationOnModel({ entity, prompt, frames = 90, steps = 25, seed = 1, travel = false, clipName }) {
  const { rootPath } = useProjectStore.getState();
  if (!rootPath) throw new Error("Open a project first — generation writes into the project's model asset.");
  const modelComp = entity?.components?.model;
  if (!modelComp?.path) throw new Error("The selected entity has no model to animate.");
  const modelPath = modelComp.path;
  // Scene files store project-relative asset paths; the file commands take
  // either, but the project-root join is what an asset path means.
  const modelAbs = absoluteAssetPath(modelPath, rootPath);

  const { motionModel } = getKimodoPrefs();

  const info = await invoke("generate_motion", {
    projectRoot: rootPath,
    motionModel,
    prompt,
    frames: Math.round(frames),
    steps: Math.round(steps),
    seed: Math.round(seed),
  });

  const [rootsBuf, rotsBuf, modelBuf] = await Promise.all([
    readAssetBinary(info.rootsPath),
    readAssetBinary(info.rotsPath),
    readAssetBinary(modelAbs),
  ]);
  if (!rootsBuf || !rotsBuf) throw new Error("Generation outputs vanished before they could be read.");
  if (!modelBuf) throw new Error(`Model asset not readable: ${modelPath}`);

  const motion = {
    roots: decodeF32(rootsBuf),
    rots: decodeF32(rotsBuf),
  };
  const name = clipName || suggestGeneratedClipName(prompt);
  const result = await retargetKimodoToModel({
    motion,
    model: modelBuf,
    clipName: name,
    travel,
    fps: 30,
  });

  // Overwriting a model asset is not on the undo stack — keep the original.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = info.outputDir
    ? `${info.outputDir}/model-backup-${stamp}${modelAbs.slice(modelAbs.lastIndexOf("."))}`
    : `${modelAbs}.backup-${stamp}`;
  await invoke("write_binary_file", { path: backupPath, contents: Array.from(new Uint8Array(modelBuf)) });

  await writeBinaryFile(modelAbs, new Uint8Array(result.glb));
  useProjectStore.getState().refresh();

  // The model component caches its loaded scene; re-set the path prop (even
  // at the same value) to force the reload, then the Animator picks the new
  // clip up off the model-loaded event. Best-effort: the engine may not be
  // up (its deferred proxy throws until ensureEngine) and the assets-panel
  // refresh above already covers discovery.
  const reloaded = [];
  try {
    for (const liveEntity of engine.entities?.values?.() ?? []) {
      const live = /** @type {any} */ (liveEntity.getComponent("model"));
      if (!live || absoluteAssetPath(live.props.path, rootPath).toLowerCase() !== modelAbs.toLowerCase()) continue;
      // The URL cache is keyed by the authored path spelling. The write above
      // invalidated the canonical absolute spelling; a prefab may hold the
      // same path with mixed slashes, so drop that alias before reloading too.
      invalidateBlobUrl(live.props.path);
      live.setProp("path", live.props.path);
      reloaded.push(
        live.whenReady().then(() => {
          if (!live.clips.some((clip) => clip.name === result.clip.name)) {
            throw new Error(`The model reloaded without generated clip "${result.clip.name}".`);
          }
        }),
      );
    }
    if (!reloaded.length) {
      throw new Error(`no live model uses ${modelPath}`);
    }
    await Promise.all(reloaded);
  } catch (error) {
    throw new Error(`Animation was written, but the live model could not reload: ${error?.message ?? error}`);
  }

  return { clipName: result.clip.name, frames: result.clip.frames, modelPath, liveModels: reloaded.length };
}

function absoluteAssetPath(path, rootPath) {
  const value = String(path ?? "").replaceAll("\\", "/");
  const absolute = /^[A-Za-z]:\//.test(value) || value.startsWith("/");
  return (absolute ? value : `${rootPath}/${value}`).replace(/\/{2,}/g, "/");
}
