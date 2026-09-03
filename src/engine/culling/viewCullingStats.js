import * as THREE from "three/webgpu";

// Stats are sampled by the editor at 10 Hz, not from the render hot path. A
// private frustum and matrix keep the sample allocation-free while matching
// the exact coordinate-system/reversed-depth inputs three's renderer uses.
const _frustum = new THREE.Frustum();
const _viewProjection = new THREE.Matrix4();

/**
 * Count the logical objects removed from the main view by either of the two
 * view cullers.
 *
 * A unit is one independently cullable engine object: a mesh/model entity, or
 * a batching/merging proxy. Hidden proxy members are deliberately omitted,
 * because counting a member whose proxy still draws was the old overlay's
 * misleading failure mode. A model with several child meshes is one unit for
 * the same reason the occlusion system tests it as one owner.
 *
 * `culled` is an identity union, not `frustum.culled + occlusion.culled`.
 * `overlap` remains visible to diagnostics so a stale occlusion answer on an
 * object that has since left the frustum cannot inflate the displayed number.
 */
export function collectViewCullingStats(engine) {
  const camera = engine?.camera;
  const occlusion = engine?.occlusion;
  const hiddenProxies = occlusion?._hiddenProxies;
  const candidates = [];

  for (const entity of engine?.entities?.values?.() ?? []) {
    if (!isAuthoredAndLodVisible(entity, engine?.playing === true)) continue;
    const root = renderRootOf(entity);
    if (!root) continue;
    // These originals do not submit a draw; their proxy is counted below.
    if (root.userData?.batchedInto || root.userData?.mergedInto) continue;
    candidates.push({
      root,
      occlusionHidden: entity._occluded === true,
      allowHiddenRoot: false,
    });
  }

  const proxyRoots = new Set();
  for (const batch of engine?.batching?.batches ?? []) {
    if (batch?.mesh) proxyRoots.add(batch.mesh);
  }
  for (const group of engine?.merging?.groups ?? []) {
    if (group?.mesh) proxyRoots.add(group.mesh);
  }
  for (const root of proxyRoots) {
    const occlusionHidden = hiddenProxies?.has?.(root) === true;
    candidates.push({ root, occlusionHidden, allowHiddenRoot: occlusionHidden });
  }

  let frustumReady = false;
  if (camera) {
    camera.updateMatrixWorld?.();
    _viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(
      _viewProjection,
      camera.coordinateSystem ?? THREE.WebGLCoordinateSystem,
      camera.reversedDepth === true,
    );
    frustumReady = true;
  }

  let tested = 0;
  let frustumTested = 0;
  let frustumCulled = 0;
  let occlusionCulled = 0;
  let overlap = 0;

  for (const candidate of candidates) {
    const drawState = inspectDrawables(
      candidate.root,
      camera,
      frustumReady ? _frustum : null,
      candidate.allowHiddenRoot,
    );
    if (drawState.drawables === 0) continue;
    tested++;

    const byFrustum = frustumReady && drawState.survivesFrustum === 0;
    const byOcclusion = candidate.occlusionHidden;
    if (frustumReady) frustumTested++;
    if (byFrustum) frustumCulled++;
    if (byOcclusion) occlusionCulled++;
    if (byFrustum && byOcclusion) overlap++;
  }

  return {
    tested,
    culled: frustumCulled + occlusionCulled - overlap,
    overlap,
    frustum: {
      tested: frustumTested,
      culled: frustumCulled,
    },
    occlusion: {
      // Preserve the system's own tested count: unlike the frustum it
      // deliberately excludes occluders and other poor query candidates.
      tested: occlusion?.testedLastFrame ?? 0,
      culled: occlusionCulled,
      reportedCulled: occlusion?.culledLastFrame ?? 0,
    },
  };
}

function renderRootOf(entity) {
  return (
    entity.components?.get?.("mesh")?.mesh ??
    entity.components?.get?.("model")?.root ??
    entity.components?.get?.("skinnedmesh")?.mesh ??
    entity.components?.get?.("instancer")?.instancedMesh ??
    null
  );
}

function isAuthoredAndLodVisible(entity, playing) {
  const enabledKey = playing ? "enabledInGame" : "enabledInEditor";
  let current = entity;
  while (current) {
    if (current[enabledKey] === false || current._lodHidden === true) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Mirrors the renderer's draw-list gate for the object types that can submit
 * geometry. `survivesFrustum === 0` means the logical owner produces no main
 * view draw because every one of its render objects was outside.
 */
function inspectDrawables(root, camera, frustum, allowHiddenRoot) {
  let drawables = 0;
  let survivesFrustum = 0;

  const visit = (object, isRoot) => {
    if (object.visible === false && !(isRoot && allowHiddenRoot)) return;
    if (isRenderable(object) && drawableMaterialVisible(object.material)) {
      if (
        !object.userData?.engineOwned &&
        !object.userData?.batchedInto &&
        !object.userData?.mergedInto &&
        (!camera || object.layers.test(camera.layers))
      ) {
        drawables++;
        if (
          !frustum ||
          object.frustumCulled === false ||
          (object.isSprite ? frustum.intersectsSprite(object) : frustum.intersectsObject(object))
        ) {
          survivesFrustum++;
        }
      }
    }
    for (const child of object.children ?? []) visit(child, false);
  };

  visit(root, true);
  return { drawables, survivesFrustum };
}

function isRenderable(object) {
  return !!(object?.isMesh || object?.isLine || object?.isPoints || object?.isSprite);
}

function drawableMaterialVisible(material) {
  if (Array.isArray(material)) return material.some((entry) => entry?.visible !== false);
  return !!material && material.visible !== false;
}
