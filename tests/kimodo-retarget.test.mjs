import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * kimodo.cpp motion -> Y Bot clip, the retarget itself
 * (`scripts/kimodo-retarget.mjs`).
 *
 * Run with `node --test tests/kimodo-retarget.test.mjs`.
 *
 * What is NOT covered here: the kimodo model itself. Real generation needs
 * the 13 GB text bundle, a local build of kimodo.cpp, and ~1 minute of CPU
 * denoising per clip — none of which belongs in a unit test, and none of
 * which changes what this code is responsible for. The model hands over raw
 * f32 streams (root positions + XYZW local rotations on the SOMA skeleton)
 * and everything downstream of that handover is exercised here against a
 * SYNTHETIC motion: sine-driven walk-ish articulation with known amplitude,
 * written through the same f32 handover format `kmd-generate` produces.
 *
 * What can be silently wrong and is asserted instead: the quaternion ORDER
 * handover (XYZW both sides), the name map's two off-by-ones (SOMA
 * "LeftLeg"→"LeftUpLeg", "LeftShin"→"LeftLeg"), the per-bone bind alignment
 * (a missing alignment leaves constant tens-of-degrees twists that numeric
 * "did it run" checks never see), the in-place/travel hips anchoring, the
 * exported GLB round trip (every track must resolve to a scene node BY NAME
 * — a renamed bone would make the mixer silently skip it), and the check's
 * own forward kinematics agreeing with an independent mixer-driven replay.
 */

// GLTFLoader needs the usual browser globals headlessly; the model carries no
// textures, so nothing reaches for a real canvas. (GLTFExporter's FileReader
// shim lives inside the retarget module itself.)
globalThis.self = globalThis;
globalThis.document ??= { createElement: () => ({ style: {} }), createElementNS: () => ({ style: {} }) };
globalThis.window ??= { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };

const { retargetKimodoMotion, SOMA, JOINT_TO_BONE } =
  await import("../scripts/kimodo-retarget.mjs");
const { SOMA_OFFSETS } = await import("../src/editor/kimodoSomaSkeleton.js");

const FRAMES = 60;
const FPS = 30;

/**
 * A synthetic walk on the SOMA skeleton: thighs swing ±25° in pitch (X),
 * knees flex on top of them, arms counter-swing ±20°, the spine sways, the
 * root bobs 2 cm and (for travel) strides forward 2 cm/frame-metre-scaled.
 * Locals are XYZW, matching kimodo's handover.
 */
function syntheticMotion({ travel }) {
  const roots = new Float32Array(FRAMES * 3);
  const rots = new Float32Array(FRAMES * SOMA.names.length * 4);
  const q = new THREE.Quaternion(), xyzw = new Float32Array(4);
  const put = (f, joint, quat) => {
    xyzw[0] = quat.x; xyzw[1] = quat.y; xyzw[2] = quat.z; xyzw[3] = quat.w;
    rots.set(xyzw, (f * SOMA.names.length + SOMA.names.indexOf(joint)) * 4);
  };
  const pitch = (rad) => q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), rad).clone();
  for (let f = 0; f < FRAMES; f++) {
    const t = f / FPS;
    const cycle = 2 * Math.PI * t * 1.4; // ~0.71 s strides
    roots[f * 3 + 0] = travel ? t * 0.8 : 0; // 0.8 m/s forward when travelling
    roots[f * 3 + 1] = 0.99 + 0.02 * Math.sin(2 * cycle);
    roots[f * 3 + 2] = 0;
    put(f, "Hips", pitch(0.05 * Math.sin(cycle)));
    put(f, "LeftLeg", pitch(0.44 * Math.sin(cycle)));
    put(f, "RightLeg", pitch(-0.44 * Math.sin(cycle)));
    put(f, "LeftShin", pitch(Math.max(0, -0.6 * Math.sin(cycle)))); // knee flexes on the back swing
    put(f, "RightShin", pitch(Math.max(0, 0.6 * Math.sin(cycle))));
    put(f, "Spine1", pitch(0.03 * Math.sin(cycle)));
    put(f, "LeftArm", pitch(-0.35 * Math.sin(cycle)));
    put(f, "RightArm", pitch(0.35 * Math.sin(cycle)));
    put(f, "LeftForeArm", pitch(-0.3));
    put(f, "RightForeArm", pitch(-0.3));
    put(f, "Head", pitch(-0.04 * Math.sin(cycle)));
  }
  return { roots, rots };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kimodo-retarget-"));
const MODEL = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../src/modules/character-controller/assets/CharacterModel.glb");

const loadGlb = async (file) => {
  const buf = fs.readFileSync(file);
  return new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
};

const glbJson = (file) => {
  const bytes = fs.readFileSync(file);
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").trim());
};

test("retargeted clip lands on the model with the mapped track set", async () => {
  const out = path.join(tmp, "inplace.glb");
  const { clip } = await retargetKimodoMotion({
    motion: syntheticMotion({ travel: false }),
    modelPath: MODEL,
    outPath: out,
    clipName: "SynthWalk",
    fps: FPS,
  });
  assert.equal(clip.name, "SynthWalk");
  assert.equal(clip.duration, FRAMES / FPS);
  // one quaternion track per mapped joint + the hips position track
  assert.equal(clip.tracks, Object.keys(JOINT_TO_BONE).length + 1);

  const gltf = await loadGlb(out);
  assert.equal(gltf.animations.length, 5, "four vendored clips plus the new one");
  const names = new Set(gltf.animations.map((c) => c.name));
  assert.ok(names.has("SynthWalk"), "new clip survives the GLB round trip");

  // Every track of the new clip must bind to a scene node BY NAME — the
  // mixer's binding rule, and the place a silent skip would hide.
  const nodes = new Set();
  gltf.scene.traverse((o) => nodes.add(o.name));
  const walk = gltf.animations.find((c) => c.name === "SynthWalk");
  for (const track of walk.tracks) {
    const nodeName = track.name.replace(/\.(position|quaternion)$/, "");
    assert.ok(nodes.has(nodeName), `track ${track.name} resolves to a scene node`);
    for (const v of track.values) assert.ok(Number.isFinite(v), `${track.name} values are finite`);
  }
});

test("appending a clip preserves the model hierarchy and materials exactly", async () => {
  const out = path.join(tmp, "preserve.glb");
  await retargetKimodoMotion({
    motion: syntheticMotion({ travel: false }),
    modelPath: MODEL,
    outPath: out,
    clipName: "Preserve",
    fps: FPS,
  });
  const before = glbJson(MODEL);
  const after = glbJson(out);
  assert.deepEqual(after.nodes, before.nodes, "prefab child-index paths cannot move");
  assert.deepEqual(after.meshes, before.meshes, "mesh primitives/extensions stay untouched");
  assert.deepEqual(after.materials, before.materials, "material definitions stay untouched");
  assert.deepEqual(after.images, before.images, "image resources stay untouched");
  assert.deepEqual(after.textures, before.textures, "texture resources stay untouched");
  assert.deepEqual(after.extensionsUsed, before.extensionsUsed, "compression/extensions stay untouched");
});

test("terminal hand axes are aligned to the SOMA palm frame", async () => {
  const roots = new Float32Array(FRAMES * 3);
  const rots = new Float32Array(FRAMES * SOMA.names.length * 4);
  const handRotation = (f, side) => {
    const t = f / (FRAMES - 1);
    const sign = side === "Left" ? 1 : -1;
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(0.42 * t, sign * -0.31 * t, 0.27 * t));
  };
  const toeRotation = (f, side) => {
    const t = f / (FRAMES - 1);
    const sign = side === "Left" ? 1 : -1;
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(sign * 0.18 * t, 0.33 * t, sign * -0.24 * t));
  };
  for (let f = 0; f < FRAMES; f++) {
    roots[f * 3 + 1] = 1;
    for (let j = 0; j < SOMA.names.length; j++) rots[(f * SOMA.names.length + j) * 4 + 3] = 1;
    for (const side of ["Left", "Right"]) {
      for (const [joint, q] of [[`${side}Hand`, handRotation(f, side)], [`${side}ToeBase`, toeRotation(f, side)]]) {
        rots.set(q.toArray(), (f * SOMA.names.length + SOMA.names.indexOf(joint)) * 4);
      }
    }
  }
  const out = path.join(tmp, "hands.glb");
  await retargetKimodoMotion({
    motion: { roots, rots },
    modelPath: MODEL,
    outPath: out,
    clipName: "Hands",
    fps: FPS,
  });
  const bind = await loadGlb(MODEL);
  bind.scene.updateMatrixWorld(true);
  const bindDirection = (from, to) =>
    bind.scene.getObjectByName(to).getWorldPosition(new THREE.Vector3())
      .sub(bind.scene.getObjectByName(from).getWorldPosition(new THREE.Vector3())).normalize();
  const gltf = await loadGlb(out);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations.find((clip) => clip.name === "Hands")).play();
  mixer.setTime(0);
  gltf.scene.updateMatrixWorld(true);
  const position = (name) => gltf.scene.getObjectByName(name).getWorldPosition(new THREE.Vector3());
  for (const side of ["Left", "Right"]) {
    const actual = position(`mixamorig${side}HandMiddle1`).sub(position(`mixamorig${side}Hand`)).normalize();
    const sourceIndex = SOMA.names.indexOf(`${side}HandMiddleEnd`);
    const expected = new THREE.Vector3(...SOMA_OFFSETS[sourceIndex]).normalize();
    assert.ok(actual.angleTo(expected) < THREE.MathUtils.degToRad(0.5),
      `${side} palm follows SOMA's hand axis, got ${THREE.MathUtils.radToDeg(actual.angleTo(expected)).toFixed(2)}deg`);

    // Matching only the middle-finger axis leaves a free roll angle and can
    // pass the assertion above with a visibly corkscrewed palm. The retarget
    // must preserve the bind hand's secondary/thumb direction under the same
    // shortest correction applied to its middle-finger direction.
    const bindMiddle = bindDirection(`mixamorig${side}Hand`, `mixamorig${side}HandMiddle1`);
    const bindThumb = bindDirection(`mixamorig${side}Hand`, `mixamorig${side}HandThumb1`);
    const correction = new THREE.Quaternion().setFromUnitVectors(bindMiddle, expected);
    const expectedThumb = bindThumb.applyQuaternion(correction);
    const actualThumb = position(`mixamorig${side}HandThumb1`).sub(position(`mixamorig${side}Hand`)).normalize();
    assert.ok(actualThumb.angleTo(expectedThumb) < THREE.MathUtils.degToRad(0.5),
      `${side} palm keeps its bind roll, got ${THREE.MathUtils.radToDeg(actualThumb.angleTo(expectedThumb)).toFixed(2)}deg`);
  }

  // SOMA ends at ToeBase, so there is no source child axis from which to
  // reconstruct its orientation. It must retain the target's complete bind
  // frame; identity alignment bends the visible toe end sharply.
  for (const side of ["Left", "Right"]) {
    const bindToe = bind.scene.getObjectByName(`mixamorig${side}ToeBase`).getWorldQuaternion(new THREE.Quaternion());
    const actualToe = gltf.scene.getObjectByName(`mixamorig${side}ToeBase`).getWorldQuaternion(new THREE.Quaternion());
    assert.ok(actualToe.angleTo(bindToe) < THREE.MathUtils.degToRad(0.5),
      `${side} toe keeps its bind frame, got ${THREE.MathUtils.radToDeg(actualToe.angleTo(bindToe)).toFixed(2)}deg`);
  }

  // Non-commuting animated rotations catch quaternion multiplication-order
  // mistakes that an identity-only bind check cannot see.
  const sampleFrame = 37;
  mixer.setTime(sampleFrame / FPS);
  gltf.scene.updateMatrixWorld(true);
  for (const side of ["Left", "Right"]) {
    const sourceMiddle = new THREE.Vector3(...SOMA_OFFSETS[SOMA.names.indexOf(`${side}HandMiddleEnd`)]).normalize();
    const bindMiddle = bindDirection(`mixamorig${side}Hand`, `mixamorig${side}HandMiddle1`);
    const bindThumb = bindDirection(`mixamorig${side}Hand`, `mixamorig${side}HandThumb1`);
    const correction = new THREE.Quaternion().setFromUnitVectors(bindMiddle, sourceMiddle);
    const expectedThumb = bindThumb.applyQuaternion(correction).applyQuaternion(handRotation(sampleFrame, side));
    const actualThumb = position(`mixamorig${side}HandThumb1`).sub(position(`mixamorig${side}Hand`)).normalize();
    assert.ok(actualThumb.angleTo(expectedThumb) < THREE.MathUtils.degToRad(0.5),
      `${side} animated palm frame stays ordered, got ${THREE.MathUtils.radToDeg(actualThumb.angleTo(expectedThumb)).toFixed(2)}deg`);

    const bindToe = bind.scene.getObjectByName(`mixamorig${side}ToeBase`).getWorldQuaternion(new THREE.Quaternion());
    const expectedToe = toeRotation(sampleFrame, side).multiply(bindToe);
    const actualToe = gltf.scene.getObjectByName(`mixamorig${side}ToeBase`).getWorldQuaternion(new THREE.Quaternion());
    assert.ok(actualToe.angleTo(expectedToe) < THREE.MathUtils.degToRad(0.5),
      `${side} animated toe frame stays ordered, got ${THREE.MathUtils.radToDeg(actualToe.angleTo(expectedToe)).toFixed(2)}deg`);
  }
});

test("in-place hips stay anchored; travel keeps the stride", async () => {
  const inPlace = await retargetKimodoMotion({
    motion: syntheticMotion({ travel: true }),
    modelPath: MODEL, outPath: path.join(tmp, "hips-inplace.glb"), clipName: "IP", fps: FPS,
  });
  const travelRun = await retargetKimodoMotion({
    motion: syntheticMotion({ travel: true }),
    modelPath: MODEL, outPath: path.join(tmp, "hips-travel.glb"), clipName: "TR", fps: FPS, travel: true,
  });

  const hipsRange = async (file, clipName) => {
    const gltf = await loadGlb(file);
    const track = gltf.animations.find((c) => c.name === clipName).tracks.find((t) => t.name === "mixamorigHips.position");
    const xs = [], ys = [];
    for (let i = 0; i < track.values.length; i += 3) { xs.push(track.values[i]); ys.push(track.values[i + 1]); }
    return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) };
  };

  // In place: bob only (±2 cm on a ~99.8 cm bind), no net stride. Y stays
  // mean-anchored, so the bob straddles the bind height.
  const ip = await hipsRange(inPlace.outPath, "IP");
  assert.ok(Math.abs(ip.yMax - ip.yMin - 4) < 1, `in-place bob is the synthetic 4 cm peak-to-peak, got ${ip.yMax - ip.yMin}`);
  assert.ok(ip.xMax - ip.xMin < 1, "in-place has no horizontal travel");

  // Travel: the synthetic 0.8 m/s over 2 s minus the frame-0 anchor.
  const tr = await hipsRange(travelRun.outPath, "TR");
  const expectedTravel = 0.8 * ((FRAMES - 1) / FPS) * 100;
  assert.ok(Math.abs(tr.xMax - tr.xMin - expectedTravel) < 5, `travel keeps the ${expectedTravel.toFixed(0)} cm stride in local cm, got ${tr.xMax - tr.xMin}`);
});

test("check reports an exact transfer except at the multi-child bones", async () => {
  const { check } = await retargetKimodoMotion({
    motion: syntheticMotion({ travel: false }),
    modelPath: MODEL, outPath: path.join(tmp, "check.glb"), clipName: "CK", fps: FPS, check: true,
  });
  const byBone = Object.fromEntries(check.map((r) => [r.bone, r]));
  // Every aligned segment must be direction-exact against the independent
  // FK replay — including through the swinging knees and elbows.
  for (const bone of ["LeftArm", "LeftForeArm", "LeftHand", "LeftLeg", "LeftFoot", "LeftToeBase",
    "RightArm", "RightForeArm", "RightHand", "RightLeg", "RightFoot", "RightToeBase",
    "Spine", "Spine1", "Spine2", "Neck", "Head"]) {
    assert.ok(byBone[bone].meanDeg < 0.5, `${bone} transfers exactly, got ${byBone[bone].meanDeg}deg`);
    assert.ok(byBone[bone].maxDeg < 0.5, `${bone} stays exact through articulation, got ${byBone[bone].maxDeg}deg`);
  }
  // Hips/Chest have several mapped children; one alignment can only serve
  // one, so a CONSTANT residue is expected — but it must be static. A dynamic
  // residue would mean the transfer itself is wrong.
  for (const bone of ["LeftShoulder", "RightShoulder", "LeftUpLeg", "RightUpLeg"]) {
    assert.ok(byBone[bone].meanDeg > 0.01, `${bone} has the expected bind residue`);
    assert.ok(byBone[bone].maxDeg - byBone[bone].meanDeg < 1, `${bone} residue is static, got mean ${byBone[bone].meanDeg} max ${byBone[bone].maxDeg}`);
  }
});

test("a mixer replay of the exported clip matches the intended pose", async () => {
  // Independent of the retarget's own driving: sample the exported clip
  // through three's AnimationMixer (the engine's playback path) and confirm
  // the legs actually swing — the retarget of a motion whose thighs move
  // ±25° must produce thigh world directions that move, not a frozen rig.
  const out = path.join(tmp, "mixer.glb");
  await retargetKimodoMotion({
    motion: syntheticMotion({ travel: false }),
    modelPath: MODEL, outPath: out, clipName: "MX", fps: FPS,
  });
  const gltf = await loadGlb(out);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const action = mixer.clipAction(gltf.animations.find((c) => c.name === "MX"));
  action.play();

  const thighWorld = (t) => {
    mixer.setTime(t);
    gltf.scene.updateMatrixWorld(true);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    gltf.scene.traverse((o) => {
      if (o.name === "mixamorigLeftUpLeg") a.setFromMatrixPosition(o.matrixWorld);
      if (o.name === "mixamorigLeftLeg") b.setFromMatrixPosition(o.matrixWorld);
    });
    return b.sub(a).normalize();
  };
  const mid = thighWorld(FRAMES / FPS / 2);
  const quarter = thighWorld(FRAMES / FPS / 4);
  assert.ok(mid.angleTo(quarter) > THREE.MathUtils.degToRad(10),
    `thigh direction moves through the swing cycle, got ${(mid.angleTo(quarter) * 180 / Math.PI).toFixed(1)}deg`);
});

test("malformed motion streams are rejected", async () => {
  await assert.rejects(
    retargetKimodoMotion({
      motion: { roots: new Float32Array(9), rots: new Float32Array(10) }, // 3 frames, wrong rot count
      modelPath: MODEL, outPath: path.join(tmp, "bad.glb"), clipName: "BAD", fps: FPS,
    }),
    /expected/,
  );
});
