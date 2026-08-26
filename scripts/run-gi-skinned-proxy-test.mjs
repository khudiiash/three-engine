// SKINNED PROXY FIT — the bone-capsule stand-in GI traces for rigged
// characters (src/modules/gi/skinnedProxy.js).
//
// WHY IT EXISTS. Measured 2026-08-19: a rigged character cast NO GI shadow at
// all. A matched control — a plain box at the mirrored position, same distance
// from the same emissive cube — threw a crisp shadow; the character threw
// nothing, and scaling it 4x so a six-metre body straddled the lamp left the
// floor perfectly, evenly lit. GI had no posed representation of a SkinnedMesh:
// it ingested BIND-POSE triangles times `matrixWorld`, which is not how a
// skinned vertex is placed at all, and masked even those out of the shadow BVH
// the moment the character's root moved.
//
// No GPU here — the fit is pure CPU geometry, and this pins the parts that a
// screenshot cannot: whether the capsules COVER the body, whether they land at
// the right world size for a rig that carries a unit conversion, and whether
// the two rig shapes that broke the first implementation still work.
//
// ARMS:
//   coverage  — every vertex of a synthetic creature must fall inside the
//               capsule nearest it (bar the quantile tail the fit deliberately
//               discards), and the fitted radii must match the authored limb
//               radii. A fit that "succeeds" but leaves the arms outside is a
//               blob, and a blob's shadow is worse than no shadow.
//   flat      — THE BUG THAT SHIPPED FIRST. glTF duplicates a joint chain per
//               skin: the user's Y Bot has TWO skins over one rig, and the
//               second skin's 52 joints are FLAT LEAF nodes with no
//               parent/child link among themselves. The first implementation
//               fitted capsules to parent→child bone SEGMENTS, found none
//               there, and silently gave the BODY mesh no proxy while the
//               joints mesh got one — so the character's shadow came out the
//               width of its joint bands. Per-bone boxes need no hierarchy at
//               all, and this arm is what keeps it that way.
//   units     — the Mixamo case: a 0.01 root scale over centimetre vertices.
//               The live capsule must land at the METRE radius, which is the
//               whole reason the shape is a unit capsule and the matrix carries
//               a uniform scale derived from the live segment length.
//   scale     — the same rig scaled at runtime: capsules must follow, because
//               a game that resizes a character must not lose its shadow.
//   collapse  — two joints on top of each other must REFUSE to produce a
//               matrix, so `adopt` declines instead of seating a unit capsule
//               at the world origin (which would shadow whatever stands there).
//   rigroot   — the duplicate-skin joints must resolve to the SAME rig root as
//               the originals, or one character is fitted twice and charged
//               twice against the mover budget.
//
// Run: node scripts/run-gi-skinned-proxy-test.mjs   (VERBOSE=1 for tables)
import * as THREE from "three/webgpu";
import { fitSkinnedCapsules, rigRootOf, skinnedCapsuleMatrix } from "../src/modules/gi/skinnedProxy.js";

const VERBOSE = process.env.VERBOSE === "1";
let failures = 0;
let checks = 0;
const fail = (msg) => { failures++; console.error(`  FAIL ${msg}`); };
const note = (msg) => VERBOSE && console.log(`       ${msg}`);
const ok = (cond, msg) => { checks++; if (!cond) fail(msg); };
const near = (got, want, tol, msg) => {
  checks++;
  if (!(Math.abs(got - want) <= tol)) fail(`${msg}: got ${got.toFixed(4)}, want ${want.toFixed(4)} ±${tol}`);
};

// ══════════════════════════════════════════════════ a synthetic creature rig
//
// A torso with a head, two arms and two legs — enough structure that a 6-capsule
// budget has to CHOOSE, which is the interesting case. Every limb is authored
// with a known radius so the fit can be graded against the truth rather than
// against itself. `unitScale` puts the whole thing in "centimetres under a 0.01
// root", which is the shape every FBX-derived rig arrives in.
//
// ⚠ THE TORSO IS DELIBERATELY DENSE (`rings`). A real character carries most of
// its vertices — and therefore most of its skin-weight mass — in the torso, and
// the first version of the fitter ranked candidate segments by exactly that. On
// the user's Y Bot it spent all five capsules on hips→spine1, spine1→both
// shoulders, spine1→spine2 and spine→spine1: no legs, no arms, no head, and
// 0.89 m radii because the limbs then had to be covered from the chest. An
// evenly-tessellated fixture does NOT reproduce that — every segment weighs the
// same, so mass ranking looks fine and the arm passes for the wrong reason.
const LIMBS = [
  // name,       from,             to,                radius  rings
  ["spine",  [0, 1.00, 0],     [0, 1.45, 0],      0.16,   20],
  ["head",   [0, 1.45, 0],     [0, 1.72, 0],      0.11,   10],
  ["armL",   [0.18, 1.42, 0],  [0.62, 1.42, 0],   0.06,    8],
  ["armR",   [-0.18, 1.42, 0], [-0.62, 1.42, 0],  0.06,    8],
  ["legL",   [0.11, 0.95, 0],  [0.11, 0.05, 0],   0.09,   10],
  ["legR",   [-0.11, 0.95, 0], [-0.11, 0.05, 0],  0.09,   10],
];

function buildCreature({ unitScale = 1, flatJoints = false } = {}) {
  const root = new THREE.Object3D();
  // The unit conversion lives on the root, exactly as a glTF armature carries
  // it. Everything below is authored PRE-scale — joint offsets, vertices and
  // radii all multiplied by `pre` — so that the WORLD geometry is identical to
  // the unscaled rig's and the two are directly comparable. Getting this wrong
  // builds a one-centimetre creature and blames the fitter for it.
  const pre = 1 / unitScale;
  root.scale.setScalar(unitScale);

  // One bone per distinct joint position, parented into a chain from the hips.
  const joints = [];
  const jointIndexOf = new Map();
  const keyOf = (p) => p.map((c) => c.toFixed(4)).join(",");
  const jointFor = (p) => {
    const k = keyOf(p);
    if (jointIndexOf.has(k)) return jointIndexOf.get(k);
    const i = joints.length;
    jointIndexOf.set(k, i);
    joints.push({ pos: p, bone: new THREE.Bone(), parent: -1 });
    return i;
  };
  const segments = LIMBS.map(([name, from, to, radius, rings]) => ({
    name,
    radius: radius * pre,
    rings,
    a: jointFor(from.map((c) => c * pre)),
    b: jointFor(to.map((c) => c * pre)),
  }));
  // Parent every joint under the first one it is linked to (a real skeleton is
  // a tree; the exact tree does not matter to the fit, only that world matrices
  // compose).
  for (const s of segments) if (joints[s.b].parent < 0 && s.b !== 0) joints[s.b].parent = s.a;
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i];
    // Positions are LOCAL, so subtract the parent's world-space authored point.
    const parent = j.parent >= 0 ? joints[j.parent] : null;
    j.bone.position.set(
      j.pos[0] - (parent?.pos[0] ?? 0),
      j.pos[1] - (parent?.pos[1] ?? 0),
      j.pos[2] - (parent?.pos[2] ?? 0),
    );
    (parent ? parent.bone : root).add(j.bone);
  }

  // FLAT-JOINT VARIANT: a second, duplicate joint set hanging off the originals
  // as LEAVES — glTF's per-skin joint duplication. These bones have no
  // parent/child link *among themselves*, which is what killed the first
  // candidate rule.
  const skinBones = joints.map((j) => j.bone);
  let boneList = skinBones;
  if (flatJoints) {
    boneList = joints.map((j) => {
      const dup = new THREE.Bone();
      dup.position.set(0, 0, 0); // co-located with its original, as in the real GLB
      j.bone.add(dup);
      return dup;
    });
  }

  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneList);

  // ── the skin: rings of vertices around each authored segment ─────────────
  const positions = [];
  const skinIndices = [];
  const skinWeights = [];
  const AROUND = 10;
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const u = new THREE.Vector3();
  const w = new THREE.Vector3();
  for (const s of segments) {
    A.fromArray(joints[s.a].pos);
    B.fromArray(joints[s.b].pos);
    dir.subVectors(B, A).normalize();
    u.set(1, 0, 0);
    if (Math.abs(dir.x) > 0.9) u.set(0, 0, 1);
    w.crossVectors(u, dir).normalize();
    u.crossVectors(dir, w).normalize();
    const RINGS = s.rings;
    for (let r = 0; r < RINGS; r++) {
      const t = r / (RINGS - 1);
      for (let k = 0; k < AROUND; k++) {
        const ang = (k / AROUND) * Math.PI * 2;
        const cx = A.x + (B.x - A.x) * t + (u.x * Math.cos(ang) + w.x * Math.sin(ang)) * s.radius;
        const cy = A.y + (B.y - A.y) * t + (u.y * Math.cos(ang) + w.y * Math.sin(ang)) * s.radius;
        const cz = A.z + (B.z - A.z) * t + (u.z * Math.cos(ang) + w.z * Math.sin(ang)) * s.radius;
        positions.push(cx, cy, cz);
        // Linear blend between the segment's two ends — the co-weighting the
        // candidate builder reads.
        skinIndices.push(s.a, s.b, 0, 0);
        skinWeights.push(1 - t, t, 0, 0);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(skeleton);
  root.updateMatrixWorld(true);
  return { root, mesh, skeleton, segments, joints, bones: boneList, originals: skinBones };
}

/** Shortest distance from world point `p` to a live capsule's SURFACE (signed). */
function surfaceDistance(mesh, segment, p) {
  const M = new THREE.Matrix4();
  if (!skinnedCapsuleMatrix(mesh, segment, M)) return Infinity;
  const inv = new THREE.Matrix4().copy(M).invert();
  const local = p.clone().applyMatrix4(inv);
  // Local space is a unit capsule: radius 1, segment ±aspect along Y.
  const y = Math.min(segment.aspect, Math.max(-segment.aspect, local.y));
  const d = Math.hypot(local.x, local.y - y, local.z) - 1;
  // Local units are radii; scale back to world by the matrix's uniform scale.
  const s = new THREE.Vector3(M.elements[0], M.elements[1], M.elements[2]).length();
  return d * s;
}

// ═════════════════════════════════════════════════════════════════ coverage
console.log("=== coverage arm: the capsules must contain the whole creature ===");
{
  const { mesh, segments } = buildCreature();
  const fitted = fitSkinnedCapsules([mesh], 12);
  ok(!!fitted?.length, "fit returned no capsules for a plain parented rig");
  if (fitted?.length) {
    // §14 Q2c: the budget bounds the FITTED capsules; joint-bridge spheres
    // (`bridge: true`, aspect 0, at each kept parent-child joint) ride on top
    // and are bounded by the kept count by construction.
    const fittedCaps = fitted.filter((f) => !f.bridge);
    const bridges = fitted.filter((f) => f.bridge);
    ok(fittedCaps.length <= 12, `fit returned ${fittedCaps.length} capsules for a budget of 12`);
    ok(bridges.length < fittedCaps.length,
      `${bridges.length} bridges for ${fittedCaps.length} capsules — a bridge needs a kept parent AND child`);
    ok(bridges.every((b) => b.aspect === 0 && b.radius > 0),
      "a joint bridge must be a sphere (aspect 0) with a real radius");
    const position = mesh.geometry.attributes.position;
    const p = new THREE.Vector3();
    let outside = 0;
    let worst = 0;
    for (let v = 0; v < position.count; v++) {
      p.fromBufferAttribute(position, v).applyMatrix4(mesh.matrixWorld);
      let best = Infinity;
      for (const seg of fitted) best = Math.min(best, surfaceDistance(mesh, seg, p));
      if (best > 1e-4) { outside++; worst = Math.max(worst, best); }
    }
    const frac = outside / position.count;
    note(`${outside}/${position.count} vertices outside (worst ${worst.toFixed(4)}m)`);
    // The radius quantile is 0.98 PER CAPSULE, so a few percent outside is the
    // designed trade; a fit that has lost a limb reads far higher than this.
    ok(frac < 0.06, `${(frac * 100).toFixed(1)}% of vertices outside every capsule (want < 6%)`);
    // ...and the ones outside must be barely outside. A lost limb shows up here
    // as a worst-case of a whole limb radius, not a millimetre of quantile tail.
    ok(worst < 0.05, `worst vertex is ${worst.toFixed(3)}m outside every capsule (want < 0.05m)`);
    // No capsule may be much fatter than the fattest limb. THE FAILURE THIS
    // CATCHES IS THE ONE THAT SHIPPED: capsules fitted to bone-to-bone segments
    // and ranked by skin-weight mass put all five on the Y Bot's torso and then
    // covered the limbs from the chest, producing 0.89 m radii on a 1.6 m
    // character — a metre-wide crescent for a shadow.
    const fattest = Math.max(...segments.map((s) => s.radius));
    const radii = fitted.map((f) => f.radius).sort((a, b) => a - b);
    note(`authored fattest ${fattest.toFixed(3)}`);
    note(`fitted   ${radii.map((r) => r.toFixed(3)).join(", ")}`);
    ok(radii[0] > 0.02, `thinnest capsule ${radii[0].toFixed(3)} is degenerate`);
    ok(
      radii[radii.length - 1] < fattest * 1.6,
      `fattest capsule ${radii[radii.length - 1].toFixed(3)} against an authored ${fattest.toFixed(3)} — it has blobbed`,
    );
    // §14 round 6: every flesh BOX must contain its own joint (the bone
    // origin, bone-local (0,0,0)). The exact vertex-span box reproduced the
    // model's real air gaps at joints — a fragmented "ladder" silhouette;
    // joint growth is the contract that neighbouring boxes MEET.
    for (const seg of fittedCaps) {
      if (!seg.he) continue;
      const c = seg.boxCenter ?? seg.center;
      const inside = [0, 1, 2].every((k) => Math.abs(0 - c[k]) <= seg.he[k] + 1e-6);
      ok(inside, `flesh box for bone ${seg.bone} does not contain its own joint (centre ${c.map((v) => v.toFixed(2))}, he ${seg.he.map((v) => v.toFixed(2))})`);
    }
  }
  console.log(`  ${fitted?.length ?? 0} capsules fitted`);
}

// ══════════════════════════════════════════════════════════════════════ flat
console.log("=== flat arm: glTF's duplicated per-skin joints have NO links ===");
{
  const { mesh, bones, originals } = buildCreature({ flatJoints: true });
  // Precondition: the arm is worthless unless the duplicates really are flat.
  const anyLink = bones.some((b) => b.children.some((c) => bones.includes(c)));
  ok(!anyLink, "the flat-joint fixture is not actually flat — the arm proves nothing");
  ok(bones !== originals, "flat fixture reused the original bones");
  const fitted = fitSkinnedCapsules([mesh], 12);
  ok(!!fitted?.length, "fit found NO capsules on a flat-joint skin — the per-bone path needs no hierarchy and must not require one");
  if (fitted?.length) {
    note(`flat-joint fit produced ${fitted.length} capsules`);
    ok(fitted.length >= 4, `only ${fitted.length} capsules from a 6-limb creature`);
  }
  console.log(`  ${fitted?.length ?? 0} capsules fitted with no bone hierarchy at all`);
}

// ═════════════════════════════════════════════════════════════════════ units
console.log("=== units arm: 0.01 root over centimetre vertices (the Mixamo rig) ===");
{
  // Same creature, authored 100x larger under a 0.01 root: identical world
  // geometry, entirely different numbers inside the fit.
  const metres = buildCreature();
  const cm = buildCreature({ unitScale: 0.01 });
  const fitM = fitSkinnedCapsules([metres.mesh], 12);
  const fitC = fitSkinnedCapsules([cm.mesh], 12);
  ok(!!fitC?.length, "unit-converted rig produced no capsules");
  if (fitM?.length && fitC?.length) {
    // The LIVE world radius is what the GPU sees, and it must match the metre
    // rig's — that is the entire point of scaling by the live segment length.
    const worldRadius = (mesh, seg) => {
      const M = new THREE.Matrix4();
      if (!skinnedCapsuleMatrix(mesh, seg, M)) return NaN;
      return new THREE.Vector3(M.elements[0], M.elements[1], M.elements[2]).length();
    };
    const rM = fitM.map((s) => worldRadius(metres.mesh, s)).sort((a, b) => a - b);
    const rC = fitC.map((s) => worldRadius(cm.mesh, s)).sort((a, b) => a - b);
    note(`metres ${rM.map((r) => r.toFixed(4)).join(", ")}`);
    note(`cm+0.01 ${rC.map((r) => r.toFixed(4)).join(", ")}`);
    ok(rM.length === rC.length, `capsule counts differ (${rM.length} vs ${rC.length})`);
    for (let i = 0; i < Math.min(rM.length, rC.length); i++) {
      near(rC[i], rM[i], 0.005, `world radius #${i} under unit conversion`);
    }
  }
  console.log("  unit-converted rig matches the metre rig in WORLD space");
}

// ═════════════════════════════════════════════════════════════════════ scale
console.log("=== scale arm: a character resized at runtime keeps its shadow ===");
{
  const { root, mesh } = buildCreature();
  const fitted = fitSkinnedCapsules([mesh], 12);
  const M = new THREE.Matrix4();
  const scaleOf = () => {
    skinnedCapsuleMatrix(mesh, fitted[0], M);
    return new THREE.Vector3(M.elements[0], M.elements[1], M.elements[2]).length();
  };
  const before = scaleOf();
  root.scale.setScalar(3);
  root.updateMatrixWorld(true);
  const after = scaleOf();
  near(after / before, 3, 0.02, "capsule radius did not follow a 3x runtime scale");
  console.log(`  radius ${before.toFixed(4)} → ${after.toFixed(4)} under a 3x scale`);
}

// ══════════════════════════════════════════════════════════════════ refuse
console.log("=== refuse arm: a capsule with no bone must REFUSE a matrix ===");
{
  const { mesh } = buildCreature();
  const fitted = fitSkinnedCapsules([mesh], 12);
  const M = new THREE.Matrix4();
  ok(skinnedCapsuleMatrix(mesh, fitted[0], M) === true, "a healthy capsule refused to produce a matrix");
  // A bone index that no longer resolves (a rig swapped under a cached fit) and
  // a degenerate radius must both refuse, so `adopt` declines instead of seating
  // a unit capsule at the world origin — which would shadow whatever stands
  // there, and `worldMatrixOf` has no previous matrix to fall back on yet.
  ok(
    skinnedCapsuleMatrix(mesh, { ...fitted[0], bone: 9999 }, M) === false,
    "a capsule pointing at a missing bone produced a matrix",
  );
  ok(
    skinnedCapsuleMatrix(mesh, { ...fitted[0], radius: 0 }, M) === false,
    "a zero-radius capsule produced a matrix",
  );
  console.log("  missing bone and zero radius both refused, as adopt requires");
}

// ═══════════════════════════════════════════════════════════════════ rigroot
console.log("=== rigroot arm: duplicated skins must resolve to ONE rig ===");
{
  const plain = buildCreature();
  const dup = buildCreature({ flatJoints: true });
  ok(rigRootOf(plain.mesh) === rigRootOf(plain.mesh), "rigRootOf is not stable");
  // Inside ONE creature carrying both skins, the duplicates hang off the
  // originals, so both walks must land on the same top bone.
  const topOriginal = rigRootOf(plain.mesh);
  ok(topOriginal?.isBone === true, "rig root is not a bone");
  const topDup = rigRootOf(dup.mesh);
  ok(topDup?.isBone === true, "duplicate-skin rig root is not a bone");
  // The duplicate's bone[0] sits under the original's bone[0]; walking up past
  // every bone must reach the original chain's top, not the duplicate itself.
  ok(topDup !== dup.skeleton.bones[0], "walk stopped at the duplicate leaf instead of climbing to the shared root");
  ok(dup.originals.includes(topDup), "duplicate-skin rig root is not one of the original bones");
  console.log("  duplicated joints climb to the shared rig root");
}

console.log("");
if (failures > 0) {
  console.error(`${failures} FAILURE(S) across ${checks} checks`);
  process.exit(1);
}
console.log(`ALL GREEN — ${checks} checks`);
