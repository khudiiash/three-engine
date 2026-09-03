// @ts-check
/**
 * General skeletal animation retargeting — play any character's animation
 * clip on any other character's skeleton, the way UE's IK Retargeter or
 * Blender's retargeting do. Editor-side authoring tool: the output is an
 * ordinary AnimationClip, indistinguishable from one imported with the model.
 *
 * Grown out of the kimodo pipeline (kimodoRetarget.js): that transfer is this
 * math with the SOMA skeleton hardcoded as the source. Here the source is
 * ANY rigged GLB plus one of its clips:
 *
 * - **Sampling.** The clip plays on the source skeleton through a throwaway
 *   mixer (LoopOnce + clamped, so the tail frame can't wrap), and per-frame
 *   world rotations and positions are captured — every interpolation mode,
 *   prerotation and translation track the source had is inherited.
 * - **Mapping.** Bones pair by normalized name (`mixamorig:LeftUpLeg`,
 *   `thigh_l` and `LeftUpLeg` all find each other; Mixamo's `LeftShin`
 *   matches `LeftCalf`); twist/roll/end helper bones are excluded from
 *   auto-mapping because their directions alias the bones they follow.
 *   Whatever auto-matching misses stays caller-editable: `map` is data, and
 *   the Retarget dialog shows the table.
 * - **Transfer.** Per mapped bone, `targetGlobal(t) = sourceGlobal(s) *
 *   align`, where `align` is the shortest-arc rotation taking the target
 *   bone's bind axis (toward its first mapped child) onto the source bone's —
 *   each expressed in its own bone's bind frame, which is what makes this
 *   exact for rigs whose bind orientations differ. Local track quats remove
 *   the nearest mapped ancestor's animated rotation; a mapped bone with no
 *   mapped ancestor hangs off its physical parent's BIND rotation, which is
 *   what makes this exact for armature-wrapped rigs (the Y Bot's identity
 *   hips-parent is the special case, asserted away in kimodoRetarget).
 * - **Root translation.** The source hips' world path re-anchors onto the
 *   target hips' bind position and scales by the rigs' hip-height ratio,
 *   absorbing both unit differences (Mixamo centimetres vs metres) and
 *   proportion differences (an adult's walk on a child rig). In place by
 *   default: net horizontal travel is mean-anchored out so a controller-
 *   driven character doesn't glide; `inPlace: false` keeps real displacement.
 * - **Report.** The retargeted pose is driven onto the target skeleton and
 *   every mapped parent→child segment direction is compared against the
 *   sampled source, per frame — the same exactness proof the kimodo tests
 *   use, surfaced to the UI so a bad manual mapping is visible as degrees,
 *   not as a mysteriously broken character.
 *
 * Pure three.js — poses in, clip out — so tests/animation-retarget.test.mjs
 * runs the same code the editor's Retarget dialog does.
 */
import * as THREE from "three/webgpu";

const EXCLUDED = /twist|roll|_end|end$|ik_|pole/i;

/** Loose canonical form: lowercase, punctuation collapsed, rig prefixes off. */
function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/^mixamorig/, "")
    .replace(/^armature/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Second pass: UE/Blender-style `thigh_l` / `upperarm_r` suffixes rewritten
 * to Mixamo-style left/right prefixes so both conventions collide. */
function normalizeLoose(name) {
  const base = normalizeName(name);
  const m = base.match(/^(.*?)(?:^|_)?([lr])$/);
  if (!m) return base;
  const side = m[2] === "l" ? "left" : "right";
  return `${side}${m[1] || base}`;
}

// Normalized-name aliases across rig conventions (Mixamo ↔ UE mannequin ↔
// generic).
const SYNONYMS = [
  ["hips", "pelvis"],
  ["leftupleg", "leftthigh"],
  ["rightupleg", "rightthigh"],
  ["leftleg", "leftcalf"], // Mixamo quirk: "LeftLeg" IS the shin
  ["rightleg", "rightcalf"],
  ["leftshin", "leftcalf"],
  ["rightshin", "rightcalf"],
  ["leftfoot", "leftankle"],
  ["rightfoot", "rightankle"],
  ["leftforearm", "leftlowerarm"],
  ["rightforearm", "rightlowerarm"],
  ["leftarm", "leftupperarm"],
  ["rightarm", "rightupperarm"],
  ["leftshoulder", "leftclavicle"],
  ["rightshoulder", "rightclavicle"],
  ["lefttoebase", "leftball"],
  ["righttoebase", "rightball"],
  ["neck", "neck01"],
  ["chest", "spine03"],
  ["spine", "spine01"],
  ["spine1", "spine02"],
  ["spine2", "spine03"],
];

const sameBone = (a, b) =>
  a === b || SYNONYMS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));

/**
 * Suggest a bone map between two rigs. Deterministic, 1:1, conservative:
 * only real deform joints pair up (twist/roll/end helpers are excluded —
 * their directions alias the bones they follow and they'd steal mappings).
 */
export function autoMapBones(sourceBones, targetBones) {
  const candidates = (bones) =>
    bones
      .filter((b) => !EXCLUDED.test(b.name))
      .map((b) => ({ name: b.name, norm: normalizeName(b.name), loose: normalizeLoose(b.name) }));
  const src = candidates(sourceBones);
  const tgt = candidates(targetBones);
  const map = [];
  const usedTarget = new Set();
  for (const s of src) {
    // Literal normalized match first, then synonym, then the loose UE-style
    // form — so "leftleg" prefers a literal "LeftLeg" over a synonym target.
    const hit =
      tgt.find((t) => !usedTarget.has(t.name) && sameBone(s.norm, t.norm)) ??
      tgt.find((t) => !usedTarget.has(t.name) && sameBone(s.loose, t.loose)) ??
      tgt.find((t) => !usedTarget.has(t.name) && (sameBone(s.norm, t.loose) || sameBone(s.loose, t.norm)));
    if (hit) {
      usedTarget.add(hit.name);
      map.push({ source: s.name, target: hit.name });
    }
  }
  return {
    map,
    unmatchedSource: src.filter((s) => !map.some((m) => m.source === s.name)).map((s) => s.name),
    unmatchedTarget: tgt.filter((t) => !usedTarget.has(t.name)).map((t) => t.name),
  };
}

/** Heuristic root-joint finder: the bone every limb eventually hangs from. */
export function findHipsBone(bones) {
  const loose = (name) => normalizeLoose(name);
  return (
    bones.find((b) => /^(hips|pelvis)$/.test(loose(b.name))) ??
    bones.find((b) => /hips|pelvis/.test(loose(b.name))) ??
    null
  );
}

/** A rig's deform bones out of a parsed GLB scene: the skinned mesh's
 * skeleton when present, every Bone otherwise. */
export function collectRigBones(scene) {
  const set = new Map();
  scene.traverse((o) => {
    if (o.isSkinnedMesh) for (const b of o.skeleton.bones) set.set(b.uuid, b);
  });
  if (set.size === 0) scene.traverse((o) => o.isBone && set.set(o.uuid, o));
  return [...set.values()];
}

/**
 * Retarget `source.clip` (authored on `source.bones`) onto `target.bones`.
 *
 * @param {object} opts
 * @param {{bones: THREE.Object3D[], root: THREE.Object3D, clip: THREE.AnimationClip}} opts.source
 *   Bind-pose skeleton the clip was authored on, the scene root its world
 *   matrices hang from, and the clip.
 * @param {{bones: THREE.Object3D[], root: THREE.Object3D}} opts.target
 *   Bind-pose skeleton to write onto.
 * @param {Array<{source: string, target: string}>} [opts.map] Bone map;
 *   auto-mapped when omitted.
 * @param {boolean} [opts.inPlace] Mean-anchor horizontal travel (default on).
 * @param {number} [opts.fps]
 * @param {string} [opts.clipName]
 * @returns {{clip: THREE.AnimationClip, report: {
 *   perBone: Array<{bone: string, meanDeg: number, maxDeg: number}>,
 *   mapped: number, unmatchedSource: number, unmatchedTarget: number,
 *   heightScale: number}}}
 *   Both skeletons come back in their bind poses.
 */
export function retargetAnimation({
  source,
  target,
  map,
  inPlace = true,
  fps = 30,
  clipName = "Retargeted",
}) {
  const srcByName = new Map(source.bones.map((b) => [b.name, b]));
  const tgtByName = new Map(target.bones.map((b) => [b.name, b]));

  const jointMap = map ?? autoMapBones(source.bones, target.bones).map;
  if (jointMap.length === 0) throw new Error("retarget: no bones could be mapped between the rigs");
  const pairs = jointMap
    .map(({ source: s, target: t }) => ({ s: srcByName.get(s), t: tgtByName.get(t) }))
    .filter((p) => p.s && p.t);
  const mappedTargetNames = new Set(pairs.map((p) => p.t.name));

  // --- Bind pose: world state of every participating bone, captured BEFORE
  // the mixer touches anything; source bone LOCALS too, so the skeleton can
  // be restored after sampling. -------------------------------------------
  const bindWorld = new Map(); // Object3D -> {pos, quat}
  const captureWorld = (o) => {
    const q = new THREE.Quaternion(), t = new THREE.Vector3();
    o.matrixWorld.decompose(t, q, new THREE.Vector3());
    bindWorld.set(o, { pos: t.clone(), quat: q.clone() });
  };
  for (const b of source.bones) captureWorld(b);
  for (const b of target.bones) captureWorld(b);
  const bindLocals = new Map(); // source bone -> {pos, quat} local
  for (const b of source.bones) bindLocals.set(b, { pos: b.position.clone(), quat: b.quaternion.clone() });
  // Lazily extended for non-bone nodes (armature wrappers, scene roots):
  // their world state is static through sampling — only mapped source BONES
  // get animated, and those are pre-captured above.
  const worldOf = (o) => {
    if (!bindWorld.has(o)) captureWorld(o);
    return bindWorld.get(o);
  };

  // First mapped DESCENDANT per mapped bone, per hierarchy — the bone axis
  // alignment and the direction check are both parent→child segment
  // constructions, so they need a child on the same side of the map.
  const firstMappedDescendant = (bone, isMapped) => {
    const queue = [...bone.children];
    while (queue.length) {
      const b = queue.shift();
      if (isMapped(b)) return b;
      queue.push(...b.children);
    }
    return null;
  };
  const mappedSourceNames = new Set(pairs.map((p) => p.s.name));
  const firstMappedSourceChild = new Map();
  const firstMappedTargetChild = new Map();
  for (const p of pairs) {
    firstMappedSourceChild.set(
      p.s,
      firstMappedDescendant(p.s, (b) => mappedSourceNames.has(b.name)),
    );
    firstMappedTargetChild.set(
      p.t,
      firstMappedDescendant(p.t, (b) => mappedTargetNames.has(b.name)),
    );
  }

  // --- Per-bone alignment: shortest arc from the target bone's axis (in its
  // OWN bind frame, toward its first mapped child) onto the source bone's
  // axis (same construction, source side). With it the target bone's world
  // direction equals the source's in every frame — the retarget contract
  // (the target's bind pose is not preserved; that's what retargeting
  // means). Leaves without a mapped child keep identity; their parents carry
  // them. ------------------------------------------------------------------
  const axisInFrame = (bone, child) => {
    const self = worldOf(bone);
    const d = worldOf(child).pos.clone().sub(self.pos).normalize();
    return d.applyQuaternion(self.quat.clone().invert());
  };
  const align = new Map(); // target bone -> Quaternion
  for (const p of pairs) {
    const sChild = firstMappedSourceChild.get(p.s);
    const tChild = firstMappedTargetChild.get(p.t);
    if (!sChild || !tChild) {
      align.set(p.t, new THREE.Quaternion());
      continue;
    }
    const uSource = axisInFrame(p.s, sChild);
    const uTarget = axisInFrame(p.t, tChild);
    align.set(p.t, new THREE.Quaternion().setFromUnitVectors(uTarget, uSource));
  }

  // --- Sample the clip: play it on the source skeleton (LoopOnce + clamp so
  // the tail frame can't wrap) and capture mapped bones' world rotations AND
  // positions per frame. ----------------------------------------------------
  const hipsSource = findHipsBone(pairs.map((p) => p.s)) ?? pairs[0].s;
  const hipsTarget = pairs.find((p) => p.s === hipsSource)?.t ?? pairs[0].t;

  const frames = Math.max(2, Math.round(source.clip.duration * fps) + 1);
  const mixer = new THREE.AnimationMixer(source.root);
  const action = mixer.clipAction(source.clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();

  const sampledQuat = new Map(); // source bone -> Quaternion[] per frame
  const sampledPos = new Map(); // source bone -> Vector3[] per frame
  for (const p of pairs) {
    sampledQuat.set(p.s, []);
    sampledPos.set(p.s, []);
  }
  const scratchQ = new THREE.Quaternion();
  const scratchT = new THREE.Vector3();
  const scratchS = new THREE.Vector3();
  for (let f = 0; f < frames; f++) {
    mixer.setTime(f / fps);
    source.root.updateMatrixWorld(true);
    for (const p of pairs) {
      p.s.matrixWorld.decompose(scratchT, scratchQ, scratchS);
      sampledQuat.get(p.s).push(scratchQ.clone());
      sampledPos.get(p.s).push(scratchT.clone());
    }
  }
  // The sampling wrote source bone locals — put the bind pose back.
  for (const [b, local] of bindLocals) {
    b.position.copy(local.pos);
    b.quaternion.copy(local.quat);
  }
  source.root.updateMatrixWorld(true);

  // --- Height ratio: the one scale that makes unit systems and proportions
  // commensurable (Mixamo cm vs metres, adult vs child rig). Measured root
  // bone to rig root — the rigs' hip heights, not the hips' offset from the
  // world origin, which is placement, not size. --------------------------
  const hipsBindLocal = hipsTarget.position.clone();
  const sourceRootWorld = worldOf(source.root);
  const sourceHipHeight = worldOf(hipsSource).pos.distanceTo(sourceRootWorld.pos);
  const hipsScale = hipsBindLocal.length() / Math.max(1e-6, sourceHipHeight);
  // World deltas must land in the hips' LOCAL frame: undo the parent's bind
  // orientation (identity on most rigs, a real rotation on armature-wrapped
  // ones).
  const hipsParentInvQuat = hipsTarget.parent
    ? worldOf(hipsTarget.parent).quat.clone().invert()
    : new THREE.Quaternion();
  if (process.env.KIMODO_DBG) {
    console.log("DBG hipsBindLocal", hipsBindLocal.toArray().map((v) => v.toFixed(3)).join(","));
    console.log("DBG hips world", worldOf(hipsTarget).pos.toArray().map((v) => v.toFixed(3)).join(","));
    console.log("DBG parent quat", worldOf(hipsTarget.parent)?.quat.toArray().map((v) => v.toFixed(3)).join(","));
    console.log("DBG parent is root?", hipsTarget.parent === target.root, "parent type", hipsTarget.parent?.type);
    console.log("DBG scale", hipsScale, "first sampled", sampledPos.get(hipsSource)[0].toArray().map((v) => v.toFixed(3)).join(","));
  }

  const mean = [0, 0, 0];
  for (const p of sampledPos.get(hipsSource))
    for (let k = 0; k < 3; k++) mean[k] += p.getComponent(k) / frames;

  // In-place horizontal conversion: remove the linear TREND (least-squares
  // line over time), not just the mean. A travelling walk mean-anchored
  // still sways ±half its march; trend removal keeps the oscillation
  // (sway/bounce) and drops the march. Y stays mean-anchored either way so
  // a crouchy clip doesn't permanently sink the character.
  const trendSlope = (axis) => {
    if (inPlace) {
      let num = 0, den = 0;
      const fMean = (frames - 1) / 2;
      for (let f = 0; f < frames; f++) {
        const v = sampledPos.get(hipsSource)[f].getComponent(axis);
        num += (f - fMean) * (v - mean[axis]);
        den += (f - fMean) * (f - fMean);
      }
      return den > 1e-9 ? num / den : 0;
    }
    return 0; // travel keeps the real displacement
  };
  const slopeX = trendSlope(0);
  const slopeZ = trendSlope(2);
  const anchorX = sampledPos.get(hipsSource)[0].x;
  const anchorZ = sampledPos.get(hipsSource)[0].z;
  const anchorY = mean[1];

  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) times[f] = f / fps;

  // --- Target globals, then locals -----------------------------------------
  const targetGlobal = new Map(); // target bone -> Quaternion[]
  for (const p of pairs) {
    const a = align.get(p.t);
    targetGlobal.set(p.t, sampledQuat.get(p.s).map((q) => q.clone().multiply(a)));
  }

  const localTracks = new Map(); // trackName -> Quaternion[]
  for (const p of pairs) {
    // Nearest mapped ANCESTOR's animated rotation, else the physical
    // parent's bind rotation (armature-wrapped rigs).
    let ancestorTarget = null;
    for (let anc = p.t.parent; anc; anc = anc.parent) {
      if (mappedTargetNames.has(anc.name)) {
        ancestorTarget = anc;
        break;
      }
    }
    const parentBindQuat = p.t.parent ? worldOf(p.t.parent).quat.clone() : new THREE.Quaternion();
    const locals = targetGlobal.get(p.t).map((world, f) => {
      const parentWorld = ancestorTarget ? targetGlobal.get(ancestorTarget)[f] : parentBindQuat;
      return parentWorld.clone().invert().multiply(world);
    });
    localTracks.set(`${p.t.name}.quaternion`, locals);
  }

  // Hips translation: world deltas → hips-parent frame → height-scaled →
  // local. Y is mean-anchored either way so a crouchy clip doesn't
  // permanently sink the character.
  const hipsPositions = new Float32Array(frames * 3);
  const hipsSourcePath = sampledPos.get(hipsSource);
  for (let f = 0; f < frames; f++) {
    const delta = new THREE.Vector3(
      hipsSourcePath[f].x - slopeX * f - anchorX,
      hipsSourcePath[f].y - anchorY,
      hipsSourcePath[f].z - slopeZ * f - anchorZ,
    )
      .applyQuaternion(hipsParentInvQuat)
      .multiplyScalar(hipsScale);
    hipsPositions[f * 3 + 0] = hipsBindLocal.x + delta.x;
    hipsPositions[f * 3 + 1] = hipsBindLocal.y + delta.y;
    hipsPositions[f * 3 + 2] = hipsBindLocal.z + delta.z;
  }

  // Quat tracks need shortest-arc continuity — a sign flip between adjacent
  // keys slerps the long way round.
  const shortestArc = (quats) => {
    for (let i = 1; i < quats.length; i++)
      if (quats[i].dot(quats[i - 1]) < 0) quats[i].set(-quats[i].x, -quats[i].y, -quats[i].z, -quats[i].w);
    return quats;
  };

  const tracks = [
    new THREE.VectorKeyframeTrack(`${hipsTarget.name}.position`, times, hipsPositions),
  ];
  for (const [trackName, locals] of localTracks) {
    const values = new Float32Array(frames * 4);
    shortestArc(locals).forEach((q, f) => {
      values[f * 4 + 0] = q.x; values[f * 4 + 1] = q.y; values[f * 4 + 2] = q.z; values[f * 4 + 3] = q.w;
    });
    tracks.push(new THREE.QuaternionKeyframeTrack(trackName, times, values));
  }
  const clip = new THREE.AnimationClip(clipName, (frames - 1) / fps, tracks);

  // --- Report: drive the target skeleton with the retargeted pose and
  // compare every mapped parent→child segment direction against the sampled
  // source, per frame. An exact transfer reads 0.0° except where a manual
  // mapping forced a mismatched pairing. ------------------------------------
  const perBone = [];
  {
    const bindTargetLocals = new Map();
    for (const p of pairs) {
      bindTargetLocals.set(p.t.name, { pos: p.t.position.clone(), quat: p.t.quaternion.clone() });
    }
    const childOf = new Map(); // target bone -> its mapped child bone
    for (const p of pairs) {
      const child = firstMappedTargetChild.get(p.t);
      if (child) childOf.set(p.t, child);
    }
    const errSum = new Map(), errMax = new Map();
    const dir = new THREE.Vector3();
    for (let f = 0; f < frames; f++) {
      for (const [trackName, locals] of localTracks) {
        const bone = target.bones.find((b) => `${b.name}.quaternion` === trackName);
        bone.quaternion.copy(locals[f]);
      }
      const hipsTrack = `${hipsTarget.name}.position`;
      const hips = target.bones.find((b) => `${b.name}.position` === hipsTrack);
      hips.position.set(hipsPositions[f * 3], hipsPositions[f * 3 + 1], hipsPositions[f * 3 + 2]);
      target.root.updateMatrixWorld(true);

      for (const p of pairs) {
        const child = childOf.get(p.t);
        const sChild = firstMappedSourceChild.get(p.s);
        if (!child || !sChild) continue;
        // Both sides: the same parent→child segment direction at frame f.
        const srcVec = sampledPos.get(sChild)[f].clone().sub(sampledPos.get(p.s)[f]).normalize();
        const tPos = new THREE.Vector3().setFromMatrixPosition(p.t.matrixWorld);
        const cPos = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld);
        const tgtVec = dir.copy(cPos).sub(tPos).normalize();
        const angle = srcVec.angleTo(tgtVec);
        errSum.set(p.t, (errSum.get(p.t) ?? 0) + angle);
        errMax.set(p.t, Math.max(errMax.get(p.t) ?? 0, angle));
      }
    }
    for (const [name, local] of bindTargetLocals) {
      const bone = target.bones.find((b) => b.name === name);
      bone.position.copy(local.pos);
      bone.quaternion.copy(local.quat);
    }
    target.root.updateMatrixWorld(true);

    for (const p of pairs) {
      const sum = errSum.get(p.t);
      if (sum === undefined) continue;
      perBone.push({
        bone: p.t.name,
        meanDeg: (sum / frames) * 180 / Math.PI,
        maxDeg: (errMax.get(p.t) ?? 0) * 180 / Math.PI,
      });
    }
  }

  return {
    clip,
    report: {
      perBone,
      mapped: pairs.length,
      unmatchedSource: source.bones.length - pairs.length,
      unmatchedTarget: target.bones.length - pairs.length,
      heightScale: hipsScale,
    },
  };
}
