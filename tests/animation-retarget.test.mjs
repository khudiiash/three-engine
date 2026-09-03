import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three/webgpu";

/**
 * General animation retargeting (`src/editor/animationRetarget.js`): a clip
 * authored on one character's skeleton, played on another's.
 *
 * Run with `node --test tests/animation-retarget.test.mjs`.
 *
 * The rigs here are deliberately INCOMPATIBLE in every dimension a real
 * retarget has to survive: different naming conventions (Mixamo-style
 * `LeftUpLeg` vs UE-mannequin-style `thigh_l`), different proportions
 * (target bones are shorter), different units (source hips at 1.0, target at
 * 0.55), and the target wrapped in a ROTATED armature node so the hips
 * translation lands in a non-world-aligned local frame. The transfer's
 * direction-exactness contract is asserted through the module's own report
 * (the same degrees table the editor dialog surfaces) and, independently,
 * through a mixer-driven replay of the retargeted clip.
 *
 * What is NOT covered here: GLB import/export (covered by
 * tests/kimodo-retarget.test.mjs, which shares the write path) and the
 * editor dialog's React wiring.
 */

// --- Synthetic rigs ----------------------------------------------------------

const BONE_SPECS = {
  // name, parent, offset — a T-pose humanoid in metres (source side).
  source: [
    ["Hips", null, [0, 1.0, 0]],
    ["Spine", "Hips", [0, 0.2, 0]],
    ["Chest", "Spine", [0, 0.22, 0]],
    ["Neck", "Chest", [0, 0.24, 0]],
    ["Head", "Neck", [0, 0.1, 0]],
    ["LeftShoulder", "Chest", [0.06, 0.18, 0]],
    ["LeftArm", "LeftShoulder", [0.14, 0, 0]],
    ["LeftForeArm", "LeftArm", [0.29, 0, 0]],
    ["LeftHand", "LeftForeArm", [0.26, 0, 0]],
    ["RightShoulder", "Chest", [-0.06, 0.18, 0]],
    ["RightArm", "RightShoulder", [-0.14, 0, 0]],
    ["RightForeArm", "RightArm", [-0.29, 0, 0]],
    ["RightHand", "RightForeArm", [-0.26, 0, 0]],
    ["LeftUpLeg", "Hips", [0.1, -0.06, 0]],
    ["LeftLeg", "LeftUpLeg", [0, -0.44, 0]],
    ["LeftFoot", "LeftLeg", [0, -0.42, 0]],
    ["RightUpLeg", "Hips", [-0.1, -0.06, 0]],
    ["RightLeg", "RightUpLeg", [0, -0.44, 0]],
    ["RightFoot", "RightLeg", [0, -0.42, 0]],
  ],
  // UE-mannequin-flavored names, shorter bones (a smaller character), plus a
  // helper twist bone that auto-mapping must NOT pair with anything.
  target: [
    ["pelvis", null, [0, 0.55, 0]],
    ["spine_01", "pelvis", [0, 0.14, 0]],
    ["spine_02", "spine_01", [0, 0.15, 0]],
    ["spine_03", "spine_02", [0, 0.16, 0]],
    ["neck_01", "spine_03", [0, 0.16, 0]],
    ["head", "neck_01", [0, 0.08, 0]],
    ["clavicle_l", "spine_03", [0.05, 0.12, 0]],
    ["upperarm_l", "clavicle_l", [0.12, 0, 0]],
    ["lowerarm_l", "upperarm_l", [0.24, 0, 0]],
    ["hand_l", "lowerarm_l", [0.2, 0, 0]],
    ["upperarm_l_twist", "upperarm_l", [0.12, 0, 0]],
    ["clavicle_r", "spine_03", [-0.05, 0.12, 0]],
    ["upperarm_r", "clavicle_r", [-0.12, 0, 0]],
    ["lowerarm_r", "upperarm_r", [-0.24, 0, 0]],
    ["hand_r", "lowerarm_r", [-0.2, 0, 0]],
    ["thigh_l", "pelvis", [0.07, -0.04, 0]],
    ["calf_l", "thigh_l", [0, -0.34, 0]],
    ["foot_l", "calf_l", [0, -0.32, 0]],
    ["thigh_r", "pelvis", [-0.07, -0.04, 0]],
    ["calf_r", "thigh_r", [0, -0.34, 0]],
    ["foot_r", "calf_r", [0, -0.32, 0]],
  ],
};

function buildRig(spec, parentTransform) {
  const byName = new Map();
  const root = new THREE.Object3D();
  if (parentTransform) {
    // Armature wrapper: rotated + scaled, like a real GLB import where the
    // rig node is NOT world-aligned.
    root.rotation.y = parentTransform.rotY;
    root.scale.setScalar(parentTransform.scale);
  }
  root.updateMatrixWorld(true);
  for (const [name, parent, offset] of spec) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(...offset);
    (parent ? byName.get(parent) : root).add(bone);
    byName.set(name, bone);
  }
  root.updateMatrixWorld(true);
  return { root, bones: [...byName.values()] };
}

/** A 2-second walk-ish clip on the source rig: thigh/counter-arm swings in
 * pitch, hips bobbing and TRAVELLING forward (0.8 m/s), hips swaying. */
function sourceWalkClip() {
  const fps = 30;
  const frames = 48;
  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) times[f] = f / fps;
  const q = new THREE.Quaternion();
  const pitch = (rad) => q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), rad).clone();
  const quatTrack = (bone, fn) => {
    const values = new Float32Array(frames * 4);
    for (let f = 0; f < frames; f++) {
      const qq = fn(f / fps);
      values[f * 4] = qq.x; values[f * 4 + 1] = qq.y; values[f * 4 + 2] = qq.z; values[f * 4 + 3] = qq.w;
    }
    return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values);
  };
  const pos = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    pos[f * 3] = 0.8 * t;
    pos[f * 3 + 1] = 1.0 + 0.02 * Math.sin(4 * Math.PI * t * 1.4);
    pos[f * 3 + 2] = 0.05 * Math.sin(2 * Math.PI * t * 1.4);
  }
  void q;
  return new THREE.AnimationClip("Walk", (frames - 1) / fps, [
    new THREE.VectorKeyframeTrack("Hips.position", times, pos),
    quatTrack("Hips", (t) => pitch(0.05 * Math.sin(2 * Math.PI * t * 1.4))),
    quatTrack("Spine", (t) => pitch(0.03 * Math.sin(2 * Math.PI * t * 1.4))),
    quatTrack("LeftUpLeg", (t) => pitch(0.45 * Math.sin(2 * Math.PI * t * 1.4))),
    quatTrack("RightUpLeg", (t) => pitch(-0.45 * Math.sin(2 * Math.PI * t * 1.4))),
    quatTrack("LeftArm", (t) => pitch(-0.3 * Math.sin(2 * Math.PI * t * 1.4))),
    quatTrack("RightArm", (t) => pitch(0.3 * Math.sin(2 * Math.PI * t * 1.4))),
    quatTrack("LeftForeArm", () => pitch(-0.25)),
    quatTrack("RightForeArm", () => pitch(-0.25)),
  ]);
}

const { retargetAnimation, autoMapBones, collectRigBones, findHipsBone } =
  await import("../src/editor/animationRetarget.js");

const source = buildRig(BONE_SPECS.source, null);
const target = buildRig(BONE_SPECS.target, { rotY: Math.PI / 2, scale: 1.0 });

// Exported for standalone debugging (node scripts importing a test module is
// unusual, but rebuilding these rigs in a scratch file drifts instantly).
export { buildRig, sourceWalkClip, BONE_SPECS, source, target };

test("auto-mapping pairs the conventions and skips helper bones", () => {
  const { map, unmatchedTarget } = autoMapBones(source.bones, target.bones);
  const pairs = Object.fromEntries(map.map((m) => [m.source, m.target]));
  assert.equal(pairs.Hips, "pelvis");
  assert.equal(pairs.LeftUpLeg, "thigh_l");
  assert.equal(pairs.LeftLeg, "calf_l");
  assert.equal(pairs.LeftForeArm, "lowerarm_l");
  assert.equal(pairs.Chest, "spine_03");
  assert.ok(!Object.values(pairs).includes("upperarm_l_twist"), "twist helper must not steal a mapping");
  // Helper bones are excluded from the candidate pool entirely — neither
  // mapped nor reported as unmatched.
  assert.ok(!unmatchedTarget.includes("upperarm_l_twist"));
});

test("transfer is direction-exact across naming, proportions and a rotated armature", () => {
  const { clip, report } = retargetAnimation({
    source: { bones: source.bones, root: source.root, clip: sourceWalkClip() },
    target: { bones: target.bones, root: target.root },
    clipName: "WalkRetargeted",
  });
  // Mapped segment directions must equal the sampled source's — through the
  // whole swing cycle, on a rig with different bone lengths and a 90°
  // armature rotation.
  const byBone = Object.fromEntries(report.perBone.map((r) => [r.bone, r]));
  // Leaf bones (hand_l, foot_r, …) have no mapped child, so no segment — the
  // report covers exactly the bones that have one.
  for (const bone of ["upperarm_l", "lowerarm_l", "upperarm_r", "lowerarm_r",
    "thigh_l", "calf_l", "thigh_r", "calf_r",
    "spine_01", "spine_03", "neck_01"]) {
    assert.ok(byBone[bone], `${bone} appears in the report`);
    assert.ok(byBone[bone].meanDeg < 0.5, `${bone} transfers exactly, got ${byBone[bone].meanDeg}deg`);
    assert.ok(byBone[bone].maxDeg < 0.5, `${bone} stays exact through articulation, got ${byBone[bone].maxDeg}deg`);
  }
  // Height ratio absorbs the rig proportions (0.55/1.0 with the shorter
  // bones) — the hips track is authored in target-local units.
  assert.ok(report.heightScale > 0.4 && report.heightScale < 0.7, `height scale sane, got ${report.heightScale}`);
  // All quaternion tracks bind to target bones BY NAME.
  const names = new Set(target.bones.map((b) => `${b.name}.quaternion`));
  for (const track of clip.tracks) {
    if (track.name.endsWith(".quaternion")) assert.ok(names.has(track.name), `${track.name} binds`);
  }
});

test("in-place anchors travel; the mixer replay shows the stride", async () => {
  const { clip } = retargetAnimation({
    source: { bones: source.bones, root: source.root, clip: sourceWalkClip() },
    target: { bones: target.bones, root: target.root },
    clipName: "IP",
  });
  const hipsTrack = clip.tracks.find((t) => t.name === "pelvis.position");
  const xs = [];
  for (let i = 0; i < hipsTrack.values.length; i += 3) xs.push(hipsTrack.values[i]);
  // Trend-removed: the 1.25 m march is gone; what remains is the source's
  // sway seen through the 90°-rotated armature (~5 cm), not the march.
  const inPlaceSpan = Math.max(...xs) - Math.min(...xs);
  assert.ok(inPlaceSpan < 0.15, `in-place strips the march, residual ${inPlaceSpan.toFixed(3)} (sway only is expected)`);

  // Travel mode keeps the march, scaled by the height ratio.
  const travel = retargetAnimation({
    source: { bones: source.bones, root: source.root, clip: sourceWalkClip() },
    target: { bones: target.bones, root: target.root },
    inPlace: false,
    clipName: "TR",
  });
  const tr = travel.clip.tracks.find((t) => t.name === "pelvis.position");
  const trX = [];
  for (let i = 0; i < tr.values.length; i += 3) trX.push(tr.values[i]);
  const travelSpan = Math.max(...trX) - Math.min(...trX);
  const expected = 0.8 * (47 / 30) * travel.report.heightScale;
  assert.ok(Math.abs(travelSpan - expected) < expected * 0.15, `travel keeps the march: ${travelSpan.toFixed(3)} vs ~${expected.toFixed(3)}`);

  // Independent mixer replay: the thighs really swing on the target rig.
  const mixer = new THREE.AnimationMixer(target.root);
  mixer.clipAction(clip).play();
  const thighDir = (t) => {
    mixer.setTime(t);
    target.root.updateMatrixWorld(true);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    target.root.traverse((o) => {
      if (o.name === "thigh_l") a.setFromMatrixPosition(o.matrixWorld);
      if (o.name === "calf_l") b.setFromMatrixPosition(o.matrixWorld);
    });
    return b.sub(a).normalize();
  };
  const mid = thighDir(clip.duration / 2);
  const quarter = thighDir(clip.duration / 4);
  assert.ok(mid.angleTo(quarter) > THREE.MathUtils.degToRad(10),
    `thigh swings through the cycle, got ${(mid.angleTo(quarter) * 180 / Math.PI).toFixed(1)}deg`);
});

test("unmappable rigs fail loudly, not silently", () => {
  const unrelated = buildRig([["root_bone", null, [0, 1, 0]], ["flap_a", "root_bone", [0, 0.3, 0]]], null);
  assert.throws(
    () => retargetAnimation({
      source: { bones: source.bones, root: source.root, clip: sourceWalkClip() },
      target: { bones: unrelated.bones, root: unrelated.root },
      clipName: "BAD",
    }),
    /no bones could be mapped/,
  );
});
