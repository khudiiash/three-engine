// @ts-check
/**
 * Retarget a kimodo.cpp text-to-motion result onto a rigged GLB model and
 * append a new clip to the model GLB without rewriting its scene. Shared by the offline CLI
 * (`scripts/kimodo-retarget.mjs`) and the editor's "Generate Animation…"
 * action, which is why this file is environment-free: no node imports, no
 * Tauri — callers hand over an ArrayBuffer and get an ArrayBuffer back.
 *
 * ## The transfer, briefly
 *
 * kimodo's SOMA skeleton (see `kimodoSomaSkeleton.js`) is itself
 * Mixamo-derived — bone names like "Hips"/"LeftArm"/"LeftShin" with the same
 * T-pose bind convention as the default Y Bot character (+Y up, +Z forward,
 * +X left, metres) — so this is a name map plus a rotation transfer, not a
 * cross-convention rebuild. Per frame, each mapped bone's animated world
 * rotation is `sourceWorld * align`, where `align` is a per-bone constant
 * taking the target bone's own bind axis onto the SOMA joint's (shortest
 * arc): without it the Y Bot's shoulder pre-rotations leave every arm bone
 * holding a constant ~50° twist. The local track quaternion follows by
 * removing the nearest mapped ANCESTOR's animated world rotation — the
 * ancestor that matters is the one in the TARGET hierarchy (Head hangs off
 * Neck in the Y Bot, off the unmapped Neck2 on the SOMA side), and unmapped
 * in-between bones stay at bind and cancel out.
 *
 * `check` verifies the transfer by comparing world-space bone directions
 * against a forward-kinematics replay of the SOMA skeleton: an exact
 * transfer reads 0.0° everywhere except the multi-child bones (Hips, Chest),
 * where one alignment can only serve one child direction and the residue is
 * the rigs' real proportion/twist difference. `tests/kimodo-retarget.test.mjs`
 * holds the synthetic-motion version of that assertion.
 *
 * kimodo emits root translations in metres and per-joint local rotations as
 * XYZW f32s — the same order three's quaternion tracks use. Hips
 * translation is written LOCAL and in centimetres: that is the convention of
 * Mixamo-rigged GLBs (identity-rotated hips parent, 0.01 world scale), and
 * it is asserted, not assumed.
 */
import * as THREE from "three/webgpu";
import { SOMA_NAMES, SOMA_PARENTS, SOMA_OFFSETS } from "./kimodoSomaSkeleton.js";
import { uniqueGeneratedClipName } from "./kimodoIntegration.js";

const MIXAMO_PREFIX = "mixamorig";

export const SOMA = {
  names: SOMA_NAMES,
  parents: SOMA_PARENTS,
  offsets: SOMA_OFFSETS.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
};

// SOMA joint -> target bone. The Mixamo heritage shows in the two classic
// off-by-ones: SOMA's leg chain starts at "LeftLeg" where Mixamo says
// "LeftUpLeg" ("LeftShin" being Mixamo's "LeftLeg"), and SOMA's spine starts
// at "Spine1" where Mixamo starts at "Spine". SOMA's Neck2 folds into the
// head (its rotation rides Head's world transfer), and jaw/eyes/fingertip
// ends have no Mixamo counterpart.
export const JOINT_TO_BONE = {
  Hips: "Hips",
  Spine1: "Spine",
  Spine2: "Spine1",
  Chest: "Spine2",
  Neck1: "Neck",
  Head: "Head",
  LeftShoulder: "LeftShoulder",
  LeftArm: "LeftArm",
  LeftForeArm: "LeftForeArm",
  LeftHand: "LeftHand",
  RightShoulder: "RightShoulder",
  RightArm: "RightArm",
  RightForeArm: "RightForeArm",
  RightHand: "RightHand",
  LeftLeg: "LeftUpLeg",
  LeftShin: "LeftLeg",
  LeftFoot: "LeftFoot",
  LeftToeBase: "LeftToeBase",
  RightLeg: "RightUpLeg",
  RightShin: "RightLeg",
  RightFoot: "RightFoot",
  RightToeBase: "RightToeBase",
};

// Hands have no mapped child, but their TARGET bind frame still has to be
// expressed in SOMA's frame. Use the middle finger as the palm's forward axis;
// the alignment below retains the complete target bind quaternion (including
// palm roll) while correcting that axis onto SOMA.
const ALIGN_ENDPOINTS = {
  LeftHand: { sourceChild: "LeftHandMiddleEnd", targetChild: "LeftHandMiddle1" },
  RightHand: { sourceChild: "RightHandMiddleEnd", targetChild: "RightHandMiddle1" },
};

/**
 * Build the retargeted clip for one motion. Pure pose math — no model, no
 * export. Exposed separately because the editor previews the clip on a live
 * model without round-tripping a GLB.
 *
 * @param {{roots: Float32Array, rots: Float32Array}} motion Decoded kimodo
 *   streams: `roots` is frames*3 root positions (metres, world axes),
 *   `rots` is frames*jointCount*4 XYZW local rotations.
 * @param {object} opts
 * @param {THREE.Object3D[]} opts.bones Target rig bones, in the loaded
 *   model's transform space (world bind state read from matrixWorld).
 * @param {string} opts.clipName
 * @param {boolean} [opts.travel] Keep horizontal displacement (default:
 *   mean-anchored in place).
 * @param {number} [opts.fps]
 * @param {boolean} [opts.check] Collect per-bone direction-error stats.
 * @returns {{clip: THREE.AnimationClip, check?: Array, hipsPositions: Float32Array, localTracks: Map}}
 */
export function buildRetargetedClip(motion, { bones, clipName, travel = false, fps = 30, check = false }) {
  const byName = new Map(bones.map((b) => [b.name, b]));
  const bone = (name) => {
    const b = byName.get(MIXAMO_PREFIX + name);
    if (!b) throw new Error(`model has no bone ${MIXAMO_PREFIX + name}`);
    return b;
  };
  const { roots, rots } = motion;
  const frames = roots.length / 3;
  if (!Number.isInteger(frames) || frames < 2) throw new Error(`motion: ${roots.length} floats is not >=2 frames of vec3`);
  if (rots.length !== frames * SOMA.names.length * 4) {
    throw new Error(`motion rotations: ${rots.length} floats, expected ${frames * SOMA.names.length * 4}`);
  }

  // --- Bind state: world rotations AND positions of every mapped bone ------
  const bindWorld = new Map();
  const bindPos = new Map();
  for (const [joint, boneName] of Object.entries(JOINT_TO_BONE)) {
    const q = new THREE.Quaternion();
    const t = new THREE.Vector3();
    bone(boneName).matrixWorld.decompose(t, q, new THREE.Vector3());
    bindWorld.set(joint, q.clone());
    bindPos.set(joint, t.clone());
  }
  const hipsBind = bone("Hips").position.clone();
  // Hips translation is authored local — assert the frame it lives in is
  // world-aligned rather than assume it.
  {
    const q = new THREE.Quaternion();
    bone("Hips").parent.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    const angle = q.angleTo(new THREE.Quaternion());
    if (angle > 1e-4) throw new Error(`Hips parent rotated by ${((angle * 180) / Math.PI).toFixed(2)}° — hips math assumes identity`);
  }

  // --- Source FK: world quats per frame (rest rotations are identity, so
  // the world rotation is just the chain product of the animated locals) ----
  const sourceGlobal = [];
  for (let f = 0; f < frames; f++) {
    const globals = new Array(SOMA.names.length);
    for (let j = 0; j < SOMA.names.length; j++) {
      const base = (f * SOMA.names.length + j) * 4;
      const local = new THREE.Quaternion(rots[base], rots[base + 1], rots[base + 2], rots[base + 3]).normalize();
      const parent = SOMA.parents[j];
      globals[j] = parent < 0 ? local : globals[parent].clone().multiply(local);
    }
    sourceGlobal.push(globals);
  }

  // --- Per-bone alignment: retain the complete target bind-world frame, then
  // apply the shortest world-space correction taking its bone direction onto
  // SOMA's rest direction. The full bind quaternion carries the roll that a
  // single direction cannot define; terminal joints keep that bind frame. ---
  const align = new Map(); // joint -> Quaternion
  {
    const childOf = new Map(); // source joint -> first mapped child joint
    for (let j = 0; j < SOMA.names.length; j++) {
      const parent = SOMA.parents[j];
      if (parent >= 0 && JOINT_TO_BONE[SOMA.names[parent]] && JOINT_TO_BONE[SOMA.names[j]] && !childOf.has(SOMA.names[parent])) {
        childOf.set(SOMA.names[parent], SOMA.names[j]);
      }
    }
    for (const joint of Object.keys(JOINT_TO_BONE)) {
      const endpoint = ALIGN_ENDPOINTS[joint];
      const child = endpoint?.sourceChild ?? childOf.get(joint);
      if (!child) { align.set(joint, bindWorld.get(joint).clone()); continue; }
      const uSource = SOMA.offsets[SOMA.names.indexOf(child)].clone().normalize();
      const targetChildName = endpoint?.targetChild ?? JOINT_TO_BONE[child];
      const targetChild = bone(targetChildName);
      const targetChildPos = new THREE.Vector3();
      targetChild.matrixWorld.decompose(targetChildPos, new THREE.Quaternion(), new THREE.Vector3());
      const targetBindDirection = targetChildPos.sub(bindPos.get(joint)).normalize();
      const correction = new THREE.Quaternion().setFromUnitVectors(targetBindDirection, uSource);
      // `correction * bindWorld` maps the target's complete bind frame into
      // SOMA space. Mapping only one local axis loses the unconstrained roll,
      // which is why palms and feet could pass direction checks yet deform.
      align.set(joint, correction.multiply(bindWorld.get(joint)));
    }
  }

  // targetGlobal[joint][frame] = sourceWorld * align
  const targetGlobal = new Map();
  for (const joint of Object.keys(JOINT_TO_BONE)) {
    const a = align.get(joint);
    targetGlobal.set(joint, sourceGlobal.map((globals) => globals[SOMA.names.indexOf(joint)].clone().multiply(a)));
  }

  // --- Local tracks: remove the nearest mapped ancestor's animated world
  // rotation (see the class doc for why it's the target hierarchy's
  // ancestor, not the source parent). ---------------------------------------
  const boneToJoint = new Map(Object.entries(JOINT_TO_BONE).map(([joint, boneName]) => [MIXAMO_PREFIX + boneName, joint]));
  const localTracks = new Map(); // trackName -> Quaternion[]
  for (const [joint, boneName] of Object.entries(JOINT_TO_BONE)) {
    let ancestorJoint = null;
    for (let p = bone(boneName).parent; p; p = p.parent) {
      if (boneToJoint.has(p.name)) { ancestorJoint = boneToJoint.get(p.name); break; }
    }
    const locals = targetGlobal.get(joint).map((world, f) => {
      const parentWorld = ancestorJoint
        ? targetGlobal.get(ancestorJoint)[f]
        : new THREE.Quaternion(); // no mapped ancestor: the root frame (world-aligned, asserted above)
      return parentWorld.clone().invert().multiply(world);
    });
    localTracks.set(MIXAMO_PREFIX + boneName, locals);
  }

  // Hips translation: kimodo emits metres on world axes; the track is local
  // centimetres on an identity-rotated parent. Anchor at the bind height
  // minus the motion's mean so a crouchy clip doesn't permanently sink the
  // character. In-place means exactly that for X/Z: the hips stay at bind
  // position; `travel` anchors frame zero and preserves displacement.
  const mean = [0, 0, 0];
  for (let f = 0; f < frames; f++)
    for (let k = 0; k < 3; k++) mean[k] += roots[f * 3 + k] / frames;
  const hipsPositions = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    hipsPositions[f * 3 + 0] = hipsBind.x + (travel ? roots[f * 3 + 0] - roots[0] : 0) * 100;
    hipsPositions[f * 3 + 1] = hipsBind.y + (roots[f * 3 + 1] - mean[1]) * 100;
    hipsPositions[f * 3 + 2] = hipsBind.z + (travel ? roots[f * 3 + 2] - roots[2] : 0) * 100;
  }

  // Quat tracks need shortest-arc continuity — a denoiser sign flip between
  // adjacent keys would slerp the long way round.
  const shortestArc = (quats) => {
    for (let i = 1; i < quats.length; i++)
      if (quats[i].dot(quats[i - 1]) < 0) quats[i].set(-quats[i].x, -quats[i].y, -quats[i].z, -quats[i].w);
    return quats;
  };

  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) times[f] = f / fps;
  const tracks = [
    new THREE.VectorKeyframeTrack(`${MIXAMO_PREFIX}Hips.position`, times, hipsPositions),
  ];
  for (const [trackName, locals] of localTracks) {
    const values = new Float32Array(frames * 4);
    shortestArc(locals).forEach((q, f) => {
      values[f * 4 + 0] = q.x; values[f * 4 + 1] = q.y; values[f * 4 + 2] = q.z; values[f * 4 + 3] = q.w;
    });
    tracks.push(new THREE.QuaternionKeyframeTrack(`${trackName}.quaternion`, times, values));
  }

  const clip = new THREE.AnimationClip(clipName, frames / fps, tracks);

  let checkRows;
  if (check) {
    checkRows = runCheck({ bones: byName, localTracks, hipsPositions, sourceGlobal, roots, frames });
  }

  return { clip, check: checkRows, hipsPositions, localTracks };
}

/**
 * Direction-error check: drives `bones` with the retargeted locals and
 * compares each mapped parent->child segment against a forward-kinematics
 * replay of the SOMA skeleton. Zero degrees means the target bone's world
 * direction equals the source joint's.
 */
function runCheck({ bones, localTracks, hipsPositions, sourceGlobal, roots, frames }) {
  const bindLocals = new Map();
  for (const [name, b] of bones) bindLocals.set(name, { pos: b.position.clone(), quat: b.quaternion.clone() });

  const sourcePos = [];
  for (let f = 0; f < frames; f++) {
    const p = new Array(SOMA.names.length);
    for (let j = 0; j < SOMA.names.length; j++) {
      const parent = SOMA.parents[j];
      if (parent < 0) {
        p[j] = new THREE.Vector3(roots[f * 3], roots[f * 3 + 1], roots[f * 3 + 2]);
      } else {
        // offsets are PARENT-LOCAL: rotate by the parent's world quat, not
        // the joint's — the joint's own articulation must not bend its bone.
        p[j] = SOMA.offsets[j].clone().applyQuaternion(sourceGlobal[f][parent]).add(p[parent]);
      }
    }
    sourcePos.push(p);
  }

  const pairs = [];
  for (let j = 0; j < SOMA.names.length; j++) {
    const cj = SOMA.names[j];
    if (!JOINT_TO_BONE[cj]) continue;
    // Compare against the nearest MAPPED source ancestor — the same rule the
    // transfer itself uses (Head's parent Neck2 is unmapped, so the
    // neck-to-head segment is measured against Neck1's joint, not skipped).
    let pj = null;
    for (let par = SOMA.parents[j]; par >= 0; par = SOMA.parents[par]) {
      if (JOINT_TO_BONE[SOMA.names[par]]) { pj = SOMA.names[par]; break; }
    }
    if (!pj) continue;
    pairs.push({ pj, cj, bone: MIXAMO_PREFIX + JOINT_TO_BONE[cj] });
  }

  const errSum = new Map(), errMax = new Map();
  const boneWorld = new THREE.Vector3(), parentWorldPos = new THREE.Vector3();
  for (let f = 0; f < frames; f++) {
    for (const [trackName, locals] of localTracks) bones.get(trackName).quaternion.copy(locals[f]);
    const hips = bones.get(`${MIXAMO_PREFIX}Hips`);
    hips.position.set(hipsPositions[f * 3], hipsPositions[f * 3 + 1], hipsPositions[f * 3 + 2]);
    // Every mapped bone descends from Hips, so this one update covers the
    // measured set.
    hips.updateMatrixWorld(true);

    for (const { pj, cj, bone: boneName } of pairs) {
      const b = bones.get(boneName);
      const pb = bones.get(MIXAMO_PREFIX + JOINT_TO_BONE[pj]);
      if (!b || !pb) continue;
      boneWorld.setFromMatrixPosition(b.matrixWorld);
      parentWorldPos.setFromMatrixPosition(pb.matrixWorld);
      // Both sides compare the same parent->child segment direction.
      const srcDir = sourcePos[f][SOMA.names.indexOf(cj)].clone().sub(sourcePos[f][SOMA.names.indexOf(pj)]).normalize();
      const tgtDir = boneWorld.sub(parentWorldPos).normalize();
      const a = srcDir.angleTo(tgtDir);
      errSum.set(boneName, (errSum.get(boneName) ?? 0) + a);
      errMax.set(boneName, Math.max(errMax.get(boneName) ?? 0, a));
    }
  }
  for (const [name, { pos, quat }] of bindLocals) {
    const b = bones.get(name);
    b.position.copy(pos);
    b.quaternion.copy(quat);
  }
  return [...errSum.keys()].sort().map((name) => ({
    bone: name.slice(MIXAMO_PREFIX.length),
    meanDeg: (errSum.get(name) / frames) * 180 / Math.PI,
    maxDeg: errMax.get(name) * 180 / Math.PI,
  }));
}

const GLB_MAGIC = 0x46546c67;
const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;

/** Read only the authored node hierarchy needed for retargeting. Geometry is
 * deliberately never decoded: the clip append works for Draco/meshopt assets
 * in both the browser and the Node CLI and cannot mutate render resources. */
function rigFromGlb(model) {
  const source = new Uint8Array(model);
  const header = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (source.byteLength < 20 || header.getUint32(0, true) !== GLB_MAGIC || header.getUint32(4, true) !== 2) {
    throw new Error("model is not a GLB 2.0 asset");
  }
  const jsonLength = header.getUint32(12, true);
  const jsonType = header.getUint32(16, true);
  if (jsonType !== GLB_JSON || 20 + jsonLength > source.byteLength) throw new Error("model GLB has no valid JSON chunk");
  const json = JSON.parse(new TextDecoder().decode(source.slice(20, 20 + jsonLength)).replace(/[\u0000 ]+$/g, ""));
  const definitions = json.nodes ?? [];
  const objects = definitions.map((definition, index) => {
    const object = new THREE.Object3D();
    object.name = definition.name ?? "";
    object.userData.gltfNodeIndex = index;
    if (definition.matrix) {
      new THREE.Matrix4().fromArray(definition.matrix).decompose(object.position, object.quaternion, object.scale);
    } else {
      if (definition.translation) object.position.fromArray(definition.translation);
      if (definition.rotation) object.quaternion.fromArray(definition.rotation);
      if (definition.scale) object.scale.fromArray(definition.scale);
    }
    return object;
  });
  definitions.forEach((definition, index) => {
    for (const child of definition.children ?? []) objects[index].add(objects[child]);
  });
  const scene = new THREE.Group();
  for (const node of json.scenes?.[json.scene ?? 0]?.nodes ?? []) scene.add(objects[node]);
  scene.updateMatrixWorld(true);
  // Primary Mixamo bones all have at least their duplicated skin carrier as a
  // child. The duplicate carrier is a leaf with the same source name, so this
  // structural test selects the authored bone without relying on loader-added
  // `_1` suffixes.
  const bones = objects.filter((object, index) =>
    object.name.startsWith(MIXAMO_PREFIX) && (definitions[index].children?.length ?? 0) > 0,
  );
  return { scene, bones, animationNames: (json.animations ?? []).map((animation) => animation.name ?? "") };
}

/** Append one Three clip to a GLB while leaving every existing node, mesh,
 * material, extension and binary byte untouched. A GLTFExporter round trip is
 * destructive here: it inserts its loader-created Scene group as a real node,
 * shifting all imported prefab child-index paths and disconnecting the
 * SkinnedMesh material handles. */
function appendClipToGlb(model, rig, clip) {
  const source = new Uint8Array(model);
  const header = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (source.byteLength < 20 || header.getUint32(0, true) !== GLB_MAGIC || header.getUint32(4, true) !== 2) {
    throw new Error("model is not a GLB 2.0 asset");
  }

  const chunks = [];
  for (let offset = 12; offset + 8 <= source.byteLength;) {
    const length = header.getUint32(offset, true);
    const type = header.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (end > source.byteLength) throw new Error("model has a truncated GLB chunk");
    chunks.push({ type, bytes: source.slice(offset + 8, end) });
    offset = end;
  }
  const jsonChunk = chunks.find((chunk) => chunk.type === GLB_JSON);
  const binChunk = chunks.find((chunk) => chunk.type === GLB_BIN);
  if (!jsonChunk || !binChunk) throw new Error("model GLB needs JSON and BIN chunks");

  const jsonText = new TextDecoder().decode(jsonChunk.bytes).replace(/[\u0000 ]+$/g, "");
  const json = JSON.parse(jsonText);
  if (!json.buffers?.[0]) throw new Error("model GLB has no primary buffer");
  json.bufferViews ??= [];
  json.accessors ??= [];
  json.animations ??= [];

  const logicalOldLength = json.buffers[0].byteLength;
  if (!Number.isInteger(logicalOldLength) || logicalOldLength < 0 || logicalOldLength > binChunk.bytes.length) {
    throw new Error("model GLB primary buffer length is invalid");
  }
  const binaryParts = [binChunk.bytes.slice(0, logicalOldLength)];
  let cursor = logicalOldLength;
  const align = () => {
    const padding = (4 - (cursor & 3)) & 3;
    if (padding) {
      binaryParts.push(new Uint8Array(padding));
      cursor += padding;
    }
  };
  const appendFloats = (values, type, min, max) => {
    align();
    const floats = values instanceof Float32Array ? values : Float32Array.from(values);
    const bytes = new Uint8Array(floats.length * 4);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < floats.length; i++) view.setFloat32(i * 4, floats[i], true);
    const bufferView = json.bufferViews.push({ buffer: 0, byteOffset: cursor, byteLength: bytes.byteLength }) - 1;
    binaryParts.push(bytes);
    cursor += bytes.byteLength;
    const width = type === "SCALAR" ? 1 : type === "VEC3" ? 3 : 4;
    const accessor = { bufferView, componentType: 5126, count: floats.length / width, type };
    if (min) accessor.min = min;
    if (max) accessor.max = max;
    return json.accessors.push(accessor) - 1;
  };

  const firstTrack = clip.tracks[0];
  if (!firstTrack?.times?.length) throw new Error("generated clip has no keyframes");
  const times = firstTrack.times;
  const input = appendFloats(times, "SCALAR", [times[0]], [times[times.length - 1]]);
  const samplers = [];
  const channels = [];
  for (const track of clip.tracks) {
    const match = /\.(position|quaternion)$/.exec(track.name);
    if (!match) throw new Error(`unsupported generated track ${track.name}`);
    const nodeName = track.name.slice(0, -match[0].length);
    const object = rig.scene.getObjectByName(nodeName);
    const node = object?.userData?.gltfNodeIndex;
    if (!Number.isInteger(node)) throw new Error(`generated track target is not an original GLB node: ${nodeName}`);
    const path = match[1] === "position" ? "translation" : "rotation";
    const output = appendFloats(track.values, path === "translation" ? "VEC3" : "VEC4");
    const sampler = samplers.push({ input, output, interpolation: "LINEAR" }) - 1;
    channels.push({ sampler, target: { node, path } });
  }
  json.animations.push({ name: clip.name, samplers, channels });
  json.buffers[0].byteLength = cursor;

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const paddedJson = new Uint8Array((jsonBytes.length + 3) & ~3);
  paddedJson.fill(0x20);
  paddedJson.set(jsonBytes);
  const mergedBin = new Uint8Array((cursor + 3) & ~3);
  let binaryOffset = 0;
  for (const part of binaryParts) {
    mergedBin.set(part, binaryOffset);
    binaryOffset += part.byteLength;
  }
  const extras = chunks.filter((chunk) => chunk.type !== GLB_JSON && chunk.type !== GLB_BIN);
  const totalLength = 12 + 8 + paddedJson.byteLength + 8 + mergedBin.byteLength
    + extras.reduce((sum, chunk) => sum + 8 + chunk.bytes.byteLength, 0);
  const output = new Uint8Array(totalLength);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(0, GLB_MAGIC, true);
  outputView.setUint32(4, 2, true);
  outputView.setUint32(8, totalLength, true);
  let outputOffset = 12;
  const writeChunk = (type, bytes) => {
    outputView.setUint32(outputOffset, bytes.byteLength, true);
    outputView.setUint32(outputOffset + 4, type, true);
    output.set(bytes, outputOffset + 8);
    outputOffset += 8 + bytes.byteLength;
  };
  writeChunk(GLB_JSON, paddedJson);
  writeChunk(GLB_BIN, mergedBin);
  for (const chunk of extras) writeChunk(chunk.type, chunk.bytes);
  return output.buffer;
}

/**
 * Full pipeline: motion streams + model GLB bytes -> model GLB bytes with the
 * retargeted clip appended to the model's existing clips.
 *
 * @param {object} opts
 * @param {{roots: Float32Array, rots: Float32Array}} opts.motion
 * @param {ArrayBuffer} opts.model Model GLB bytes (Mixamo-named rig).
 * @param {string} [opts.clipName]
 * @param {boolean} [opts.travel]
 * @param {number} [opts.fps]
 * @param {boolean} [opts.check]
 * @returns {Promise<{glb: ArrayBuffer, clip: {name, duration, frames, tracks}, check?: Array}>}
 */
export async function retargetKimodoToModel({ motion, model, clipName = "KimodoMotion", travel = false, fps = 30, check = false }) {
  const rig = rigFromGlb(model);
  const finalClipName = uniqueGeneratedClipName(clipName, rig.animationNames);

  // The FBX heritage left a duplicate rig: every primary bone also has a `_1`
  // clone hanging off it at identity. Clips target the primaries; the clones
  // ride along and carry the skin. Match the primaries by exact name.
  const boneList = rig.bones;

  const { clip, check: rows } = buildRetargetedClip(motion, {
    bones: boneList,
    clipName: finalClipName,
    travel,
    fps,
    check,
  });

  // Append only animation accessors/channels. Re-exporting the loaded scene
  // changes its hierarchy and resource encodings, invalidating prefab paths,
  // material handles and Draco compression.
  const exported = appendClipToGlb(model, rig, clip);
  return {
    glb: exported,
    clip: { name: finalClipName, duration: motion.roots.length / 3 / fps, frames: motion.roots.length / 3, tracks: clip.tracks.length },
    ...(check ? { check: rows } : {}),
  };
}
