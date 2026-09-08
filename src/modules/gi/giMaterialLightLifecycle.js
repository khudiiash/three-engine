// The GI light is part of every lit material's node-graph cache key. A compute
// rebuild may reuse it only while every value that GICascadeLightNode.setup()
// reads at graph-build time is either the same node/slot object or the same
// structural flag. This module keeps that contract pure and directly testable.

const REF_FIELDS = [
  "intensityUniform",
  "normalOffset",
  "emitterSlots",
  "giIrradianceNode",
  "giEmitterShadowNode",
  "giRadianceNode",
  "giPositionNode",
  "giScreenTexel",
  "giAoNode",
  "giAoActiveU",
  "giViewProj",
  "giNestedView",
  "giEmitterShadowTexel",
  "bvhReflectTexture",
  "bvhReflectColorTexture",
];

const FLAG_FIELDS = [
  "emitterTileKeyed",
  "approximateReflections",
  "bvhReflectShaded",
  "hitLighting",
];

const GI_STATE_FIELDS = [
  "gatherFn",
  "radianceFn",
  "radianceSharpFn",
  "radianceRoughFn",
  "mirrorTraceFn",
  "mirrorSampleFn",
  "hitSurfaceFn",
  "mirrorShadowFn",
  "lightSlots",
  "shadowTraceFn",
  "shadowMargin",
  "shadowRange",
  "mirrorRange",
  "giEnvMiss",
  "giProbes",
  ...REF_FIELDS,
  ...FLAG_FIELDS,
];

function nestedRefs(light) {
  return {
    envNode: light?.giEnvMiss?.node ?? null,
    envIntensity: light?.giEnvMiss?.intensity ?? null,
    envRotation: light?.giEnvMiss?.rotY ?? null,
    probeNode: light?.giProbes?.node ?? null,
    probeSlots: light?.giProbes?.slots ?? null,
  };
}

/** Captures the material-facing identity/shape before a GI generation dies. */
export function captureGiMaterialLightShape(light) {
  if (!light) return null;
  const refs = Object.fromEntries(REF_FIELDS.map((key) => [key, light[key] ?? null]));
  const flags = Object.fromEntries(FLAG_FIELDS.map((key) => [key, light[key] ?? null]));
  return { refs, flags, nested: nestedRefs(light) };
}

/**
 * WHY a light cannot be reused — the field that moved, or null when it can.
 *
 * ⭐ THIS ANSWER IS WORTH MORE THAN THE BOOLEAN (2026-09-07). A `false` here
 * costs the whole material set: the light is replaced with a fresh id, the
 * node-builder cache is purged, and three re-runs `nodeBuilder.build()` for
 * every material on its next draw — which the freeze ledger prices at
 * **150-210 ms EACH** (`material:nodeBuild MeshPhysicalNodeMaterial 209 ms`,
 * user's Pool scene). On a 90-material scene that is the difference between a
 * GI property edit costing a second and costing twenty. The boolean says a
 * re-warm happened; only the field name says whether it had to.
 */
export function giMaterialLightShapeDiff(snapshot, light) {
  if (!snapshot) return "no previous light";
  if (!light) return "no new light";
  for (const key of REF_FIELDS) {
    if (snapshot.refs[key] !== (light[key] ?? null)) return `ref:${key}`;
  }
  for (const key of FLAG_FIELDS) {
    if (snapshot.flags[key] !== (light[key] ?? null)) return `flag:${key}`;
  }
  const next = nestedRefs(light);
  for (const key of Object.keys(snapshot.nested)) {
    if (snapshot.nested[key] !== next[key]) return `nested:${key}`;
  }
  return null;
}

/** True only when an existing material graph can keep using this light. */
export function giMaterialLightShapeMatches(snapshot, light) {
  return giMaterialLightShapeDiff(snapshot, light) === null;
}

/**
 * Transfers GI graph/runtime inputs to a fresh light when a capability shape
 * changed. Object3D/Light identity fields are deliberately not copied: the new
 * id is what makes Three invalidate the old lights hash on the slow path.
 */
export function copyGiLightState(target, source) {
  for (const key of GI_STATE_FIELDS) target[key] = source[key];
  return target;
}

