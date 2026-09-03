// Convert a Kimodo (kimodo.cpp) text-to-motion output into a clip on the
// engine's Mixamo-rigged character model — the offline CLI shape of
// `src/editor/kimodoRetarget.js`, which holds the actual transfer (and its
// rationale; read that header first). This wrapper is only file plumbing:
// read the raw streams + model GLB from disk, run the core, write the result.
//
// kimodo.cpp (github.com/localai-org/kimodo.cpp — NVIDIA's Kimodo ported to
// GGML) generates skeletal animation from a text prompt; its `kmd-generate`
// CLI writes the raw f32 streams this consumes:
//
//   kmd-generate models/kimodo-soma-rp-v1.1-f32.gguf \
//     generated/llm2vec-text-bundle prompt.txt 90 25 42 output_motion
//   node scripts/kimodo-retarget.mjs --motion <kimodo.cpp>/output_motion --name Walking
//
// The generated clip is appended to the model's existing clips and the FULL
// model GLB is written out (the same shape `merge-ybot-clips.mjs` produces),
// so the result drops into a project as the character model and the new clip
// shows up in the Animator next to Idle/Running.
//
// In place by default (the vendored clips don't travel; the character
// controller drives movement itself) — `--travel` keeps displacement.
//
// Generated clips inherit the SOMA checkpoint's license terms (the published
// SOMA weights are redistributable; see kimodo.cpp's README — the SMPL-X
// checkpoint is NOT, and this pipeline never touches it).
//
// Run from anywhere — paths are resolved relative to this script, not the
// working directory:
//   node scripts/kimodo-retarget.mjs --motion DIR [--model GLB] [--out GLB]
//        [--name Clip] [--travel] [--fps 30] [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retargetKimodoToModel, JOINT_TO_BONE } from "../src/editor/kimodoRetarget.js";
import { SOMA_NAMES, SOMA_PARENTS } from "../src/editor/kimodoSomaSkeleton.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = path.join(scriptDir, "../src/modules/character-controller/assets/CharacterModel.glb");

// Re-exported for the test suite (and anyone scripting this pipeline).
export { JOINT_TO_BONE };
export const SOMA = { names: SOMA_NAMES, parents: SOMA_PARENTS };

/**
 * Same contract the pre-refactor script exported: motion as a kimodo output
 * DIRECTORY (of f32 streams) or decoded buffers; writes the merged model GLB
 * to `outPath`.
 */
export async function retargetKimodoMotion({
  motion,
  modelPath = DEFAULT_MODEL,
  outPath,
  clipName = "KimodoMotion",
  travel = false,
  fps = 30,
  check = false,
}) {
  let roots, rots;
  if (typeof motion === "string") {
    const posBuf = fs.readFileSync(path.join(motion, "root_positions.f32"));
    const rotBuf = fs.readFileSync(path.join(motion, "local_rotations_xyzw.f32"));
    roots = new Float32Array(posBuf.buffer, posBuf.byteOffset, posBuf.length / 4);
    rots = new Float32Array(rotBuf.buffer, rotBuf.byteOffset, rotBuf.length / 4);
  } else {
    ({ roots, rots } = motion);
  }

  const glbBuf = fs.readFileSync(modelPath);
  const result = await retargetKimodoToModel({
    motion: { roots, rots },
    model: glbBuf.buffer.slice(glbBuf.byteOffset, glbBuf.byteOffset + glbBuf.byteLength),
    clipName,
    travel,
    fps,
    check,
  });

  if (!outPath) {
    outPath = path.join(scriptDir, "../artifacts/kimodo", `${clipName.replace(/[^\w-]+/g, "_")}.glb`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(result.glb));
  return { outPath, clip: result.clip, ...(check ? { check: result.check } : {}) };
}

// --- CLI ---------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
  };
  const motionDir = flag("motion");
  if (!motionDir) {
    console.error("usage: kimodo-retarget.mjs --motion DIR [--model GLB] [--out GLB] [--name Clip] [--travel] [--fps 30] [--check]");
    process.exit(2);
  }
  const result = await retargetKimodoMotion({
    motion: motionDir,
    modelPath: flag("model", DEFAULT_MODEL),
    outPath: flag("out"),
    clipName: flag("name", "KimodoMotion"),
    travel: args.includes("--travel"),
    fps: Number(flag("fps", 30)),
    check: args.includes("--check"),
  });
  if (result.check) {
    console.log(`direction error vs SOMA (deg, mean/max over ${result.clip.frames} frames):`);
    for (const row of result.check) {
      console.log(`  ${row.bone}: ${row.meanDeg.toFixed(1)} / ${row.maxDeg.toFixed(1)}${row.meanDeg > 20 ? "  <-- multi-child bone residue (see src/editor/kimodoRetarget.js header)" : ""}`);
    }
  }
  console.log(`wrote ${result.outPath}`);
  console.log(`clip "${result.clip.name}": ${result.clip.duration.toFixed(2)}s, ${result.clip.frames} frames, ${result.clip.tracks} tracks`);
}
