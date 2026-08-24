// ═══════════════════════════════════════ GI: SKINNED MESHES AS BONE CAPSULES
//
// WHY THIS FILE EXISTS (measured 2026-08-19, the user's GAME/Level scene).
//
// A rigged character cast NO GI shadow at all. Not a soft one, not a lagging
// one — a matched control (a plain 0.4x1.8x0.4 box at the mirrored position,
// same distance from the same emissive cube) threw a crisp black shadow while
// the character threw nothing, and scaling the character 4x so a six-metre body
// straddled the lamp left the floor perfectly, evenly lit.
//
// The cause is that NOTHING in the GI module owns a POSED skinned surface:
//   · `classifyDynamicShape` returns null on `isSkinnedMesh`, so a character is
//     never adopted as an exact dynamic object and nothing updates it per frame;
//   · `buildBvhScene` excludes skinned meshes from the reflection BVH by name;
//   · the only thing GI ingested was `serializeMeshForBake` — raw
//     `geometry.attributes.position`, i.e. the BIND POSE — multiplied by
//     `mesh.matrixWorld`, which is not even how a skinned vertex is placed
//     (three's AttachedBindMode recomputes `bindMatrixInverse` from
//     `matrixWorld` every frame, so the mesh's own world matrix CANCELS and only
//     `boneMatrix · bindMatrix · position` survives — the bones own the pose).
//   · and `#refreshOccupancyTransforms` masked those bind-pose triangles out of
//     the static shadow BVH the moment the character's root moved, while
//     re-arming the 180-frame rebuild debounce — so a WALKING character could
//     never have cast a shadow even if the bind pose had been the right shape.
//
// ── THE MODEL: ONE CAPSULE PER BONE, PARENTED TO THAT BONE ──────────────────
//
// Each capsule is fitted to the BOUNDING BOX, in the bone's own local space, of
// the vertices that bone actually skins. Everything falls out of that:
//   · it is LOCAL. A bone measures its own flesh and nothing else, so no
//     capsule can be inflated by a body part that belongs to another bone.
//   · it is LIVE. The capsule rides `bone.matrixWorld` like a child object
//     would, so it follows the animation exactly, at zero per-frame cost.
//   · UNITS ARE FREE. A rig whose joints carry a conversion (every Mixamo/FBX
//     export: a 0.01 root over centimetre vertices) needs no special case — the
//     box is in bone space, the bone's world matrix carries the conversion, and
//     a character the game rescales at runtime follows for the same reason.
//   · NO HIERARCHY IS ASSUMED. glTF duplicates a joint chain per skin (the
//     user's Y Bot ships TWO skins over one rig, the second one's joints being
//     flat leaves), and none of that matters when every capsule is fitted from
//     weights alone.
//
// ⚠ AN EARLIER VERSION FITTED CAPSULES TO BONE-TO-BONE SEGMENTS AND RANKED THEM
// BY SKIN-WEIGHT MASS. It is worth knowing why that failed, because the failure
// looked like success: mass × length is genuinely "how much body is here", and
// a character keeps most of its vertices in the TORSO — so on the Y Bot all
// five capsules landed on hips→spine1, spine1→both shoulders, spine1→spine2 and
// spine→spine1. No legs, no arms, no head. The limbs then had to be covered
// from the chest, which produced **0.89 m** radii on a 1.6 m character and a
// metre-wide crescent for a shadow. Per-bone boxes cannot do that: a bone's box
// is its own flesh, and the budget only decides how many bones get one.

import * as THREE from "three";

/**
 * Box quantile per axis. NOT the max: one stray vertex — a cuff, a hair card, a
 * weight-painting mistake — stretches a limb's box until the character is a
 * blob, and the shadow of a blob is worse than a slightly thin arm.
 */
const EXTENT_QUANTILE = 0.99;
/** Below this many dominant vertices a bone has no meaningful shape. */
const MIN_VERTICES = 4;

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * The object that identifies one RIG — the grouping key for skinned meshes.
 *
 * NOT `mesh.skeleton`: glTF gives each skin its own `Skeleton` even when they
 * describe the same character, and the user's Y Bot ships two (body and joints)
 * whose joint chains are duplicated node-for-node. Keying on the skeleton
 * object split one character into two rigs, each fitted separately, each
 * charged its own slice of the mover budget.
 *
 * The highest BONE above the skeleton's root is stable across those duplicates
 * — the second skin's leaf joints hang off the first skin's bones, so both
 * walks arrive at the same top bone.
 */
export function rigRootOf(mesh) {
  let node = mesh?.skeleton?.bones?.[0] ?? null;
  if (!node) return mesh?.parent ?? mesh ?? null;
  while (node.parent?.isBone) node = node.parent;
  return node;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Per-vertex skin-texture sampler for one mesh, or null when the texture
 * cannot be read on the CPU (no map, no UVs, compressed/KTX2, tainted).
 *
 * Why this exists (2026-08-22, "skeleton proxies" report): a character's
 * material base colour is usually WHITE — the colour lives in the TEXTURE —
 * so the proxies' mean-albedo lookup painted every reflected character as a
 * grey mannequin. Sampling the texture at each bone's own vertices gives the
 * proxy boxes the body's real per-part colours (yellow torso, grey shorts).
 *
 * Returns `(vertexIndex, acc)` accumulating LINEAR rgb (×material tint) and
 * a count into `acc[0..3]`. Point-sampled at the vertex UV — a mean over a
 * limb doesn't need filtering.
 */
function texelSamplerOf(mesh) {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const image = material?.map?.image;
  const uvAttr = mesh.geometry?.attributes?.uv;
  if (!image || !uvAttr) return null;
  const w = image.width ?? 0;
  const h = image.height ?? 0;
  if (!w || !h) return null;
  let data;
  try {
    const canvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : (typeof document !== "undefined" ? document.createElement("canvas") : null);
    if (!canvas) return null;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // compressed or CORS-tainted image — keep the material colour
  }
  const tint = material.color ?? { r: 1, g: 1, b: 1 };
  const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return (v, acc) => {
    let u = uvAttr.getX(v) % 1;
    let vv = uvAttr.getY(v) % 1;
    if (u < 0) u += 1;
    if (vv < 0) vv += 1;
    const x = Math.min(w - 1, Math.floor(u * w));
    // three's UV v runs bottom-up; getImageData rows run top-down.
    const y = Math.min(h - 1, Math.floor((1 - vv) * h));
    const o = (y * w + x) * 4;
    acc[0] += srgbToLinear(data[o] / 255) * tint.r;
    acc[1] += srgbToLinear(data[o + 1] / 255) * tint.g;
    acc[2] += srgbToLinear(data[o + 2] / 255) * tint.b;
    acc[3] += 1;
  };
}

/**
 * Fits one capsule per bone for ONE RIG, in each bone's LOCAL space.
 *
 * `meshes` is every SkinnedMesh on the representative skeleton — a character is
 * routinely several (the user's Y Bot is a body mesh plus a separate joints
 * mesh), and their vertices are unioned so a bone's box covers all of its flesh.
 *
 * Returns `[{ bone, center: [x,y,z], axis, radius, aspect, vertices }]`, where
 * everything is in the bone's local space and `aspect` is `halfSegment/radius`
 * — see `skinnedCapsuleMatrix` for how that becomes a world transform. Null
 * when there is no usable skeleton or no bone carries enough flesh.
 *
 * Cached on the first mesh's geometry, keyed by budget and by the whole group's
 * geometry ids: a fit is a function of the bind pose and the weights, so every
 * instance of a character shares one.
 */
export function fitSkinnedCapsules(meshes, budget = 6) {
  const group = (Array.isArray(meshes) ? meshes : [meshes]).filter(
    (m) => m?.isSkinnedMesh && m.geometry?.attributes?.position &&
      m.geometry.attributes.skinIndex && m.geometry.attributes.skinWeight,
  );
  if (!group.length) return null;
  const skeleton = group[0].skeleton;
  const bones = skeleton?.bones;
  if (!bones?.length || !skeleton.boneInverses?.length) return null;

  const cacheKey = `__giSkinnedCapsules:${budget}:${group.map((m) => m.geometry.id).join(",")}`;
  const cached = group[0].geometry.userData?.[cacheKey];
  if (cached !== undefined) return cached;

  const result = fitImpl(group, bones, skeleton, budget);
  (group[0].geometry.userData ??= {})[cacheKey] = result;
  return result;
}

function fitImpl(group, bones, skeleton, budget) {
  // ── every vertex, in the local space of the bone that dominates it ────────
  //
  // Bone-local is `boneInverse · bindMatrix · position` — the same product
  // three's own `applyBoneTransform` builds — so a point collected here lands
  // exactly where the skinned surface is once `bone.matrixWorld` is applied.
  // The bind pose is where a bone's flesh is measurable at all; every other
  // pose has it bent across a joint.
  const perBone = new Map(); // bone index -> { x: [], y: [], z: [] }
  // bone index -> [rSum, gSum, bSum, count] of skin-texture samples at the
  // bone's own vertices (see texelSamplerOf) — becomes the proxy's albedo.
  const colorAcc = new Map();
  const colorAt = (bone) => {
    let acc = colorAcc.get(bone);
    if (!acc) colorAcc.set(bone, (acc = [0, 0, 0, 0]));
    return acc;
  };
  // Per-bone UV subsample (first 128 owned verts of the biggest mesh), kept
  // on the fit result: when the CPU sampler above cannot decode the texture
  // (KTX2 — routine in projects with texture compression on), a GPU reader
  // resolves the colours LATER from these exact UVs without re-walking the
  // geometry (GISystem's #resolveSkinnedProxyColors).
  const uvSource = group.reduce((a, b) =>
    ((b.geometry?.attributes?.position?.count ?? 0) > (a.geometry?.attributes?.position?.count ?? 0) ? b : a));
  const uvAttrS = uvSource.geometry?.attributes?.uv ?? null;
  const uvSamples = new Map();
  const uvAt = (bone) => {
    let list = uvSamples.get(bone);
    if (!list) uvSamples.set(bone, (list = []));
    return list;
  };
  const local = new THREE.Vector3();
  const toBone = new THREE.Matrix4();
  // §14: bones of a FOREIGN skin (a glTF duplicate chain) map onto the
  // representative skeleton BY NAME — its flesh used to be excluded from the
  // fit entirely, so whatever body part lived on the second skin shaped no
  // capsule at all (the under-fit torso class). The duplicate's local frames
  // match the original's (node-for-node duplication), so its vertices land
  // in the right bone space through its OWN boneInverses.
  const repIndexByName = new Map();
  for (let i = 0; i < bones.length; i++) {
    if (bones[i]?.name && !repIndexByName.has(bones[i].name)) repIndexByName.set(bones[i].name, i);
  }
  // §14: vertex ACCOUNTING for the ledger — "the shadow has holes" is very
  // often flesh that never reached the fit, and only a count says so.
  let vertsSeen = 0;
  let vertsAssigned = 0;
  let vertsOutOfRange = 0;
  let vertsUnmapped = 0;
  for (const mesh of group) {
    const bindMatrix = mesh.bindMatrix ?? new THREE.Matrix4();
    const position = mesh.geometry.attributes.position;
    const skinIndex = mesh.geometry.attributes.skinIndex;
    const skinWeight = mesh.geometry.attributes.skinWeight;
    const sampleTexel = texelSamplerOf(mesh);
    const mSkel = mesh.skeleton;
    const foreign = mSkel !== skeleton;
    if (foreign && (!mSkel?.bones?.length || !mSkel.boneInverses?.length)) continue;
    const mapToRep = foreign
      ? mSkel.bones.map((b) => (b?.name != null ? repIndexByName.get(b.name) ?? -1 : -1))
      : null;
    for (let v = 0; v < position.count; v++) {
      // A vertex shapes at most ONE bone — whichever skins it MOST. Letting it
      // shape every bone that touches it is what re-imports the inflation the
      // per-bone model exists to avoid: a shoulder vertex would stretch the arm
      // box across the chest.
      //
      // ⚠ ARGMAX, NOT A MAJORITY THRESHOLD. Requiring 0.5 silently discards
      // every vertex the rig splits evenly — the ring exactly halfway along a
      // limb, and on a four-influence rig a great deal more than that — and a
      // discarded vertex is a hole in the proxy. Whoever skins it most is
      // always a defensible owner, even at 0.3.
      let bi = -1;
      let bw = 0;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(v, k);
        if (w > bw) { bw = w; bi = skinIndex.getComponent(v, k); }
      }
      vertsSeen++;
      if (foreign) {
        if (bi < 0 || bi >= mSkel.bones.length) { vertsOutOfRange++; continue; }
        const ri = mapToRep[bi];
        if (ri == null || ri < 0) { vertsUnmapped++; continue; }
        toBone.multiplyMatrices(mSkel.boneInverses[bi], bindMatrix);
        local.fromBufferAttribute(position, v).applyMatrix4(toBone);
        let acc = perBone.get(ri);
        if (!acc) perBone.set(ri, (acc = []));
        acc.push(local.x, local.y, local.z);
        if (sampleTexel) sampleTexel(v, colorAt(ri));
        if (mesh === uvSource && uvAttrS) {
          const list = uvAt(ri);
          if (list.length < 256) list.push(uvAttrS.getX(v), uvAttrS.getY(v));
        }
        vertsAssigned++;
        continue;
      }
      if (bi < 0 || bi >= bones.length) { vertsOutOfRange++; continue; }
      let acc = perBone.get(bi);
      if (!acc) perBone.set(bi, (acc = []));
      toBone.multiplyMatrices(skeleton.boneInverses[bi], bindMatrix);
      local.fromBufferAttribute(position, v).applyMatrix4(toBone);
      acc.push(local.x, local.y, local.z);
      if (sampleTexel) sampleTexel(v, colorAt(bi));
      if (mesh === uvSource && uvAttrS) {
        const list = uvAt(bi);
        if (list.length < 256) list.push(uvAttrS.getX(v), uvAttrS.getY(v));
      }
      vertsAssigned++;
    }
  }
  if (!perBone.size) return null;

  // ── one candidate capsule per bone ───────────────────────────────────────
  const candidates = [];
  const axisVals = [[], [], []];
  for (const [bone, pts] of perBone) {
    const n = pts.length / 3;
    if (n < MIN_VERTICES) continue;
    // §14: the quantile trims exist for DENSE organic meshes, where a stray
    // hair-card or weight-painting mistake is one vertex in thousands. On a
    // LOW-POLY character every vertex is structure — a voxel character's
    // whole torso is a couple dozen corners, and trimming "outliers" there
    // trims the torso itself (the user's shadow holes, second report). Below
    // 400 owned vertices the fit is EXACT COVER: min/max box, max radial.
    const q = n >= 400 ? EXTENT_QUANTILE : 1;
    const ext = [];
    const mid = [];
    for (let k = 0; k < 3; k++) {
      const vals = axisVals[k];
      vals.length = 0;
      for (let i = 0; i < n; i++) vals.push(pts[i * 3 + k]);
      // Symmetric quantile: trim the same tail from both ends so the centre
      // stays put and only outliers are dropped.
      vals.sort((p, q2) => p - q2);
      const hi = quantile(vals, q);
      const lo = quantile(vals, 1 - q);
      ext.push(Math.max(hi - lo, 0));
      mid.push((hi + lo) * 0.5);
    }
    // The box picks the AXIS and the CENTRE. It must not pick the radius:
    //
    // ⚠ A CAPSULE CANNOT CONTAIN ITS OWN BOUNDING BOX. Taking the radius from
    // the largest cross-section extent inscribes the capsule in the box, so the
    // box's corners stick out — invisible on a round limb, ruinous on a torso,
    // whose box is nearly cubic. Measured on the synthetic rig: correct radii
    // everywhere and 63% of vertices still outside, concentrated in the chest.
    // Taking the diagonal instead would fix the torso and make every limb √2
    // too fat, which is the blob this file keeps having to avoid.
    //
    // So the radius comes from the FLESH: the quantile of each point's actual
    // distance from the capsule's axis line. Exact for a round limb, honest for
    // a torso, and the segment length then follows from what the caps of that
    // radius already reach.
    let axis = 0;
    if (ext[1] > ext[axis]) axis = 1;
    if (ext[2] > ext[axis]) axis = 2;
    const other = [0, 1, 2].filter((i) => i !== axis);
    const radial = [];
    const axial = [];
    for (let i = 0; i < n; i++) {
      const d0 = pts[i * 3 + other[0]] - mid[other[0]];
      const d1 = pts[i * 3 + other[1]] - mid[other[1]];
      radial.push(Math.hypot(d0, d1));
      axial.push(Math.abs(pts[i * 3 + axis] - mid[axis]));
    }
    const radius = quantile([...radial].sort((p, q2) => p - q2), q);
    if (!(radius > 1e-9)) continue;
    // Segment length: the smallest half-segment that puts each point inside.
    // A point at axial `a` and radial `ρ` is covered once
    // `halfSeg ≥ a − sqrt(r² − ρ²)`, i.e. once the CAP of radius r reaches it —
    // which is why a limb whose flesh is all within one radius of the joint
    // gets a half-segment of zero and becomes a sphere, correctly.
    const need = [];
    for (let i = 0; i < n; i++) {
      const inside = Math.sqrt(Math.max(0, radius * radius - radial[i] * radial[i]));
      need.push(Math.max(0, axial[i] - inside));
    }
    // §14 Q2d: the AXIAL quantile is 1.0, not EXTENT_QUANTILE. The 0.99 cut
    // pools both ends of the bone, so it dropped exactly the TIPS — every
    // capsule came out slightly short at both ends and adjacent capsules no
    // longer met even in the bind pose. Outlier protection matters RADIALLY
    // (a stray hair-card vertex fattens the whole limb); axially the worst
    // case is a slightly long capsule, which is invisible, while a short one
    // is a hole in the shadow.
    const halfSeg = quantile(need.sort((p, q) => p - q), 1);
    // ── §14 round 6: GROW THE BOX TO ITS JOINTS ──────────────────────────
    // The exact vertex-span box reproduces the voxel model's REAL air gaps
    // at every joint (round 3's finding), so adjacent flesh boxes cast a
    // fragmented "ladder" silhouette — the user's "not scaled properly,
    // leaving holes". The capsule never showed it because its END CAPS
    // overshoot the last vertex by a full radius at each end; the box has
    // no overshoot. Growing each box to contain its OWN joint (the bone
    // origin) and every DIRECT CHILD joint makes neighbouring boxes MEET at
    // the shared joint by construction — a continuous silhouette, the way
    // the body is continuous. The box gets its OWN centre (`boxCenter`):
    // the capsule hatch must keep the pure flesh mid, and this growth
    // shifts the box on nearly every bone. Bounded: a child joint farther
    // than 3× the box's largest half-extent is a mount/helper bone, not
    // anatomy. Joint positions come through the SAME bind-pose transforms
    // the vertices did (`boneInverses`), so box and flesh share a space.
    const boxLo = [mid[0] - ext[0] / 2, mid[1] - ext[1] / 2, mid[2] - ext[2] / 2];
    const boxHi = [mid[0] + ext[0] / 2, mid[1] + ext[1] / 2, mid[2] + ext[2] / 2];
    {
      const joints = [[0, 0, 0]];
      const bObj = bones[bone];
      const jm = new THREE.Matrix4();
      const jp = new THREE.Vector3();
      for (const child of bObj?.children ?? []) {
        if (!child.isBone) continue;
        const ci = bones.indexOf(child);
        if (ci < 0 || !skeleton.boneInverses[ci]) continue;
        jp.setFromMatrixPosition(jm.copy(skeleton.boneInverses[ci]).invert());
        jp.applyMatrix4(skeleton.boneInverses[bone]);
        joints.push([jp.x, jp.y, jp.z]);
      }
      const reach = Math.max(ext[0], ext[1], ext[2], 1e-6) * 1.5;
      for (const j of joints) {
        if (Math.hypot(j[0] - mid[0], j[1] - mid[1], j[2] - mid[2]) > reach * 2) continue;
        for (let k = 0; k < 3; k++) {
          boxLo[k] = Math.min(boxLo[k], j[k]);
          boxHi[k] = Math.max(boxHi[k], j[k]);
        }
      }
    }
    candidates.push({
      bone,
      center: [mid[0], mid[1], mid[2]],
      boxCenter: [
        (boxLo[0] + boxHi[0]) / 2,
        (boxLo[1] + boxHi[1]) / 2,
        (boxLo[2] + boxHi[2]) / 2,
      ],
      axis,
      radius,
      aspect: halfSeg / radius,
      // §14 round 4: the per-axis flesh HALF-EXTENTS — the OBB the default
      // proxy shape now traces (see skinnedBoxShape). A capsule inscribes a
      // boxy character's flesh: the skin sits OUTSIDE the shell, so the
      // self-exclusion cannot claim it (the dark blotch on the character's
      // own back) and round shells leave lit slits between arm and torso
      // that the real boxes don't have (the "holes"). Round 6: the extents
      // are the JOINT-GROWN bounds (see above), centred on `boxCenter` —
      // the exclusion went SIGNED (on-or-inside) in step, so flesh sitting
      // INSIDE the grown box still cannot be self-shadowed by it.
      he: [
        (boxHi[0] - boxLo[0]) / 2,
        (boxHi[1] - boxLo[1]) / 2,
        (boxHi[2] - boxLo[2]) / 2,
      ],
      vertices: n,
      // Capsule volume, in bone-local units — the budget's ranking. Volume is
      // the right currency because what a shadow loses when a capsule is
      // dropped is exactly the space it occupied.
      volume: radius * radius * (halfSeg + radius * (2 / 3)),
    });
  }
  if (!candidates.length) return null;
  // Per-bone albedo from the texture samples above — the mean of the bone's
  // OWN texels (linear, tinted). ALWAYS an array: bridges and the adopt path
  // share the INSTANCE, so a later GPU colour resolve (KTX2 textures the CPU
  // sampler could not read) mutates it in place for every consumer at once.
  // `colored` says whether the values are real yet; `uvs` is what the GPU
  // path samples with.
  for (const c of candidates) {
    const acc = colorAcc.get(c.bone);
    c.color = acc && acc[3] > 0 ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]] : [1, 1, 1];
    c.colored = !!(acc && acc[3] > 0);
    const list = uvSamples.get(c.bone);
    c.uvs = list && list.length >= 2 ? Float32Array.from(list) : null;
  }

  // ── the budget: the biggest capsules, then absorb what was dropped ────────
  //
  // ⚠ THE ABSORB PASS IS NOT OPTIONAL, AND IT MUST BE BOUNDED. A humanoid has
  // far more bones than any sane mover budget, so fingers, toes and often the
  // hands and feet lose — and a dropped bone's flesh does not stop existing, it
  // just stops casting. Each dropped bone is folded into the nearest KEPT bone
  // (by bind-pose position), which is how a forearm capsule ends up covering
  // the hand at the end of it.
  //
  // But an UNBOUNDED absorb is the torso bug wearing a different hat: with a
  // small budget the nearest kept bone to a dropped shoulder is the chest, and
  // growing the chest capsule until it reaches an arm produces exactly the
  // metre-wide ball this file exists to avoid (measured on the synthetic rig:
  // a 0.16 m torso grown to 0.377 m, with a quarter of the body still outside
  // it). A capsule may swallow a neighbour it very nearly contains already; it
  // may not stretch across a joint. Anything the guard refuses is simply left
  // uncast — a fingertip with no shadow is invisible, an inflated torso is not.
  candidates.sort((p, q) => q.volume - p.volume);
  const want = Math.max(1, Math.min(budget, candidates.length));
  const kept = candidates.slice(0, want);
  const dropped = candidates.slice(want);
  // §14: the FIT LEDGER — one line per rig, printed once (the fit is
  // cached). "The shadow has holes" debugging starts here: a body part with
  // no capsule is either a bone in `dropped` whose absorb was REFUSED, a
  // bone under MIN_VERTICES (never a candidate at all), or flesh whose
  // argmax bone nobody expected. `__giSkinnedProxyLog = false` silences it.
  const absorbLog = [];
  if (globalThis.__giSkinnedProxyLog !== false) {
    const capOf = (c) => `${bones[c.bone]?.name ?? c.bone}(${c.vertices}v r${c.radius.toFixed(2)} h${(c.aspect * c.radius).toFixed(2)})`;
    const lost = vertsSeen - vertsAssigned;
    console.log(
      `[gi] skinned fit ledger — ${candidates.length} fleshed bones, budget ${budget}, ` +
      `${group.length} mesh(es), verts ${vertsAssigned}/${vertsSeen} assigned` +
      (lost > 0 ? ` (${vertsOutOfRange} bad index, ${vertsUnmapped} unmappable foreign bones — THAT FLESH CASTS NOTHING)` : "") +
      `: kept ${kept.map(capOf).join(" ")}` +
      (dropped.length ? ` | dropped ${dropped.map(capOf).join(" ")}` : ""),
    );
  }
  if (dropped.length) {
    // Bind-pose world positions, the only space in which "nearest bone" is a
    // question with a stable answer.
    const bindPos = new Map();
    const inv = new THREE.Matrix4();
    const posOf = (i) => {
      let p = bindPos.get(i);
      if (!p) {
        inv.copy(skeleton.boneInverses[i]).invert();
        bindPos.set(i, (p = new THREE.Vector3().setFromMatrixPosition(inv)));
      }
      return p;
    };
    const dropToWorld = new THREE.Matrix4();
    const m = new THREE.Matrix4();
    for (const d of dropped) {
      const dp = posOf(d.bone);
      let host = -1;
      let hostD = Infinity;
      for (let i = 0; i < kept.length; i++) {
        const dist = dp.distanceToSquared(posOf(kept[i].bone));
        if (dist < hostD) { hostD = dist; host = i; }
      }
      if (host < 0) continue;
      // Express the dropped capsule's own extent in the HOST bone's space and
      // grow the host's box to contain it. `boneInverses` is world→bone, so its
      // inverse is bone→world and the pair composes into dropped→host.
      const k = kept[host];
      dropToWorld.copy(skeleton.boneInverses[d.bone]).invert();
      m.multiplyMatrices(skeleton.boneInverses[k.bone], dropToWorld);
      const dirLocal = _v.set(d.axis === 0 ? 1 : 0, d.axis === 1 ? 1 : 0, d.axis === 2 ? 1 : 0);
      const halfSeg = d.aspect * d.radius;
      _a.set(d.center[0], d.center[1], d.center[2]).addScaledVector(dirLocal, halfSeg).applyMatrix4(m);
      _b.set(d.center[0], d.center[1], d.center[2]).addScaledVector(dirLocal, -halfSeg).applyMatrix4(m);
      // Scale of the mapping, so the dropped radius arrives in host units.
      const me = m.elements;
      const dropR = d.radius * Math.hypot(me[0], me[1], me[2]);
      // §14 round 4: the BOX is the shape that ships, so the box's verdict
      // decides absorb-vs-promote; the capsule params grow alongside for the
      // `__giSkinnedProxyShape = "capsule"` hatch.
      const took = growBox(k, _a, _b, dropR);
      if (took) growCapsule(k, _a, _b, dropR);
      // §14: a refused absorb used to leave the flesh UNCAST — and on the
      // user's real rig (14 fleshed bones, budget 12) that was BOTH SHINS:
      // the two lowest-volume bones lost the budget race and the growth
      // guard correctly refused stretching a thigh across the knee, so the
      // character's lower legs cast nothing at all. The guard was right;
      // the fallback was wrong. A refusal now PROMOTES the bone to its own
      // capsule (bounded at 2× the budget — the mover-cap widening already
      // counts every segment, so the cost is one more OBB test per ray, not
      // a broken header).
      if (!took && kept.length < budget * 2) {
        kept.push(d);
        absorbLog.push(`${bones[d.bone]?.name ?? d.bone} PROMOTED (absorb into ${bones[k.bone]?.name ?? k.bone} refused)`);
      } else {
        absorbLog.push(`${bones[d.bone]?.name ?? d.bone}→${bones[k.bone]?.name ?? k.bone}${took ? "" : " REFUSED (left uncast — promotion cap hit)"}`);
      }
    }
  }
  if (absorbLog.length && globalThis.__giSkinnedProxyLog !== false) {
    console.log(`[gi] skinned fit absorbs — ${absorbLog.join(", ")}`);
  }
  // ── §14 Q2c: JOINT BRIDGES ────────────────────────────────────────────────
  //
  // Each capsule is rigid to ONE bone, so when a joint bends the two capsules
  // rotate apart and a wedge notch opens on the outside of the bend — the
  // reported "holes in the character's shadow". A SPHERE pinned at the child
  // bone's ORIGIN closes the wedge in every pose with no interpolated matrix:
  // the origin IS the joint, invariant under the child's own rotation and
  // carried by the parent's motion. Radius = the larger of the two capsules'
  // (in the child's units — bone-local scales differ per bone, the same
  // conversion the absorb pass pays above), so the sphere swallows both
  // capsule ends' cross-sections. Over-coverage at a joint is invisible;
  // a hole is not. Self-shadow is safe: the exclusion in dynamicObjects is
  // signed per-shape, so skin inside the bridge sphere is not shadowed by it.
  const keptSet = new Set(kept.map((k) => k.bone));
  const byBone = new Map(kept.map((k) => [k.bone, k]));
  const boneIndex = new Map(bones.map((b, i) => [b, i]));
  const bridges = [];
  const rel = new THREE.Matrix4();
  const parentToWorld = new THREE.Matrix4();
  for (const k of kept) {
    let node = bones[k.bone]?.parent;
    while (node?.isBone) {
      const pi = boneIndex.get(node);
      if (pi !== undefined && keptSet.has(pi)) {
        const parent = byBone.get(pi);
        parentToWorld.copy(skeleton.boneInverses[pi]).invert();
        rel.multiplyMatrices(skeleton.boneInverses[k.bone], parentToWorld);
        const re = rel.elements;
        const parentR = parent.radius * Math.hypot(re[0], re[1], re[2]);
        bridges.push({
          bone: k.bone,
          center: [0, 0, 0],
          axis: 1,
          radius: Math.max(k.radius, parentR),
          aspect: 0,
          vertices: 0,
          bridge: true,
          // The joint sphere wears the child bone's flesh colour — the SAME
          // array instance, so a late GPU resolve recolours it too.
          color: k.color,
          uvs: null,
        });
        break;
      }
      node = node.parent;
    }
  }
  return kept.map((k) => ({
    bone: k.bone,
    center: k.center,
    boxCenter: k.boxCenter,
    axis: k.axis,
    radius: k.radius,
    aspect: k.aspect,
    he: k.he,
    vertices: k.vertices,
    color: k.color,
    colored: k.colored === true,
    uvs: k.uvs ?? null,
  })).concat(bridges);
}

/** How far a capsule may be grown to absorb a dropped bone's flesh. */
const ABSORB_MAX_GROWTH = 1.25;

/**
 * Grows a fitted flesh BOX (in its own bone's local space) so it contains a
 * sphere of `radius` at each of `p0`/`p1`. Asymmetric — the box's centre may
 * shift — because a hand hangs off one END of a forearm, and growing
 * symmetrically would push the box's other end past the elbow for nothing.
 * Refuses (returns false, changes nothing) when any axis would grow by more
 * than a quarter of the box's largest half-extent — the same "may swallow a
 * neighbour it nearly contains, may not stretch across a joint" contract as
 * `growCapsule`.
 */
function growBox(cap, p0, p1, radius) {
  if (!cap.he) return false;
  // Round 6: the box lives on its OWN centre (`boxCenter`) — the joint
  // growth shifts it away from the capsule's flesh mid, and mutating the
  // shared `center` here would drag the capsule hatch's placement with it.
  const c = (cap.boxCenter ??= cap.center.slice());
  const lo = [0, 1, 2].map((k) => c[k] - cap.he[k]);
  const hi = [0, 1, 2].map((k) => c[k] + cap.he[k]);
  const maxHe = Math.max(cap.he[0], cap.he[1], cap.he[2], 1e-6);
  const nlo = lo.slice();
  const nhi = hi.slice();
  for (const p of [[p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z]]) {
    for (let k = 0; k < 3; k++) {
      nlo[k] = Math.min(nlo[k], p[k] - radius);
      nhi[k] = Math.max(nhi[k], p[k] + radius);
    }
  }
  for (let k = 0; k < 3; k++) {
    if (((nhi[k] - nlo[k]) - (hi[k] - lo[k])) / 2 > 0.25 * maxHe) return false;
  }
  for (let k = 0; k < 3; k++) {
    c[k] = (nlo[k] + nhi[k]) / 2;
    cap.he[k] = (nhi[k] - nlo[k]) / 2;
  }
  return true;
}

/**
 * Grows a fitted capsule (in its own bone's local space) so that it contains a
 * sphere of `radius` at each of `p0`/`p1`. Keeps the capsule's AXIS: turning it
 * to fit an absorbed hand would swing the forearm's shadow off the forearm.
 *
 * Returns false and changes nothing when the growth would exceed
 * `ABSORB_MAX_GROWTH` — see the absorb pass for why an unbounded grow is the
 * torso bug in disguise.
 */
function growCapsule(cap, p0, p1, radius) {
  const axis = cap.axis;
  const other = [0, 1, 2].filter((i) => i !== axis);
  const cAxis = cap.center[axis];
  let halfSeg = cap.aspect * cap.radius;
  let r = cap.radius;
  const ends = [[p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z]];
  // Radius FIRST for both ends, then the axial reach — the axial requirement is
  // `|Δ| + radius − r`, so computing it against a radius that is about to grow
  // over-extends the segment (and an over-long capsule on a forearm reaches out
  // past the fingertips).
  for (const comp of ends) {
    const dr = Math.hypot(comp[other[0]] - cap.center[other[0]], comp[other[1]] - cap.center[other[1]]) + radius;
    if (dr > r) r = dr;
  }
  for (const comp of ends) {
    const da = Math.abs(comp[axis] - cAxis) + radius - r;
    if (da > halfSeg) halfSeg = da;
  }
  const wasHalfSeg = cap.aspect * cap.radius;
  if (r > cap.radius * ABSORB_MAX_GROWTH ||
      halfSeg > (wasHalfSeg + cap.radius) * ABSORB_MAX_GROWTH) {
    return false;
  }
  cap.radius = r;
  cap.aspect = halfSeg / r;
  cap.volume = r * r * (halfSeg + r * (2 / 3));
  return true;
}

/**
 * Writes the live world matrix for one fitted capsule into `out`.
 *
 * Local space is a UNIT capsule: radius 1, segment ±`aspect` along +Y (see
 * `dynShapeHitFn`'s capsule branch). The matrix is exactly what a capsule
 * CHILDED TO THE BONE would have — `bone.matrixWorld` times the fitted
 * translate/rotate/uniform-scale — so the proxy follows the animation, the
 * rig's unit conversion and any runtime rescale without knowing about any
 * of them.
 *
 * Returns false when the bone is missing or the fit is degenerate; the caller
 * keeps the previous matrix, which is strictly better than publishing a
 * zero-scale occluder that blinks out of existence.
 */
export function skinnedCapsuleMatrix(mesh, capsule, out) {
  const bone = mesh?.skeleton?.bones?.[capsule?.bone];
  if (!bone || !(capsule.radius > 0)) return false;
  // Local +Y must land on the fitted box's long axis. The two remaining basis
  // vectors only have to keep the frame right-handed — a capsule is
  // rotationally symmetric about its segment.
  const axis = capsule.axis;
  if (axis === 0) { _a.set(0, 0, 1); _b.set(1, 0, 0); _c.set(0, 1, 0); }        // Z, X, Y
  else if (axis === 2) { _a.set(0, 1, 0); _b.set(0, 0, 1); _c.set(1, 0, 0); }   // Y, Z, X
  else { _a.set(1, 0, 0); _b.set(0, 1, 0); _c.set(0, 0, 1); }                   // X, Y, Z
  const s = capsule.radius;
  const e = out.elements;
  e[0] = _a.x * s; e[1] = _a.y * s; e[2] = _a.z * s; e[3] = 0;
  e[4] = _b.x * s; e[5] = _b.y * s; e[6] = _b.z * s; e[7] = 0;
  e[8] = _c.x * s; e[9] = _c.y * s; e[10] = _c.z * s; e[11] = 0;
  e[12] = capsule.center[0];
  e[13] = capsule.center[1];
  e[14] = capsule.center[2];
  e[15] = 1;
  out.premultiply(bone.matrixWorld);
  return true;
}

/** The dynamic-object shape record for one fitted capsule. */
export function skinnedCapsuleShape(capsule) {
  return {
    type: "capsule",
    center: new THREE.Vector3(0, 0, 0),
    // Local bounds of the unit capsule: radius 1 in x/z, aspect + 1 in y.
    halfExtents: new THREE.Vector3(1, capsule.aspect + 1, 1),
    params: [1, capsule.aspect, 0],
  };
}

/**
 * §14 round 4 — the dynamic-object shape record for one fitted flesh BOX,
 * the DEFAULT proxy shape. Same convention as a classify-adopted OBB: the
 * fitted centre rides `shape.center` (the sync composes `M × translate
 * (center)`), the half-extents are the flesh's own per-axis quantile box in
 * BONE-LOCAL units, and the matrix is the bare live bone matrix — units,
 * runtime rescale and the pose all arrive through it, exactly like the
 * capsule's. Why a box: a capsule INSCRIBES a boxy character's flesh, so the
 * skin sits outside the shell (self-shadow the exclusion cannot claim) and
 * round shells leave lit slits between body parts (the shadow "holes"). The
 * box is the flesh's own bounding shape — skin on its surface, neighbours
 * meeting the way the body does. `__giSkinnedProxyShape = "capsule"`
 * restores the old shape.
 */
export function skinnedBoxShape(capsule) {
  // Round 6: the box's own centre — the joint-grown bounds shift it off the
  // capsule's flesh mid (see the fit), and the capsule hatch keeps `center`.
  const c = capsule.boxCenter ?? capsule.center;
  return {
    type: "obb",
    center: new THREE.Vector3(c[0], c[1], c[2]),
    halfExtents: new THREE.Vector3(
      Math.max(capsule.he[0], 1e-6),
      Math.max(capsule.he[1], 1e-6),
      Math.max(capsule.he[2], 1e-6),
    ),
  };
}

/**
 * Live world matrix for a flesh-box proxy: the bone's matrix, verbatim (the
 * fitted centre lives in `shape.center`, composed by the dyn-set's sync).
 */
export function skinnedBoneMatrix(mesh, capsule, out) {
  const bone = mesh?.skeleton?.bones?.[capsule?.bone];
  if (!bone || !capsule?.he) return false;
  out.copy(bone.matrixWorld);
  return true;
}
