/**
 * Prefab-tree builders for rigged (skinned/animated) GLB imports. Pure —
 * they take a loaded GLTF scene and a fid factory and return prefab child
 * nodes, so the pipeline is testable outside the editor (no Tauri, no DOM).
 */

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * One prefab entity per mesh in a rigged GLB, carrying a `skinnedmesh`
 * component that addresses the mesh by the same child-index paths bones use.
 * The entities sit at identity transform — the mesh itself stays inside (and
 * is posed by) the model's GLB scene; the entity is its editing handle.
 */
export function buildMeshEntities(scene, newFid, materialFor, geometryFor = () => "") {
  const nodes = [];
  const visit = (object, path) => {
    if (object.isMesh) {
      nodes.push({
        fid: newFid(),
        name: object.name || "Mesh",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        components: [
          {
            type: "skinnedmesh",
            props: {
              geometry: geometryFor(object),
              path,
              material: materialFor(object),
              castShadow: true,
              receiveShadow: true,
            },
          },
        ],
        children: [],
      });
    }
    object.children.forEach((child, index) => visit(child, `${path}/${index}`));
  };
  scene.children.forEach((child, index) => visit(child, String(index)));
  return nodes;
}

/**
 * Builds the editable skeleton portion of a prefab. A child-index path is
 * stable for the same GLB and doesn't depend on names being unique; the
 * runtime ModelComponent uses it to locate the matching THREE.Bone.
 */
export function buildBoneEntities(scene, newFid) {
  scene.updateMatrixWorld(true);
  const bones = [];
  const visit = (object, path, nearestBone) => {
    const entry = object.isBone ? { object, path, parent: nearestBone, children: [] } : null;
    if (entry) {
      bones.push(entry);
      if (nearestBone) nearestBone.children.push(entry);
    }
    object.children.forEach((child, index) => visit(child, `${path}/${index}`, entry ?? nearestBone));
  };
  scene.children.forEach((child, index) => visit(child, String(index), null));

  const makeNode = (bone, parentObject = null) => {
    const local = bone.object.matrixWorld.clone();
    if (parentObject) local.premultiply(parentObject.matrixWorld.clone().invert());
    const position = bone.object.position.clone();
    const quaternion = bone.object.quaternion.clone();
    const scale = bone.object.scale.clone();
    local.decompose(position, quaternion, scale);
    const rotation = bone.object.rotation.clone().setFromQuaternion(quaternion, bone.object.rotation.order);
    return {
      fid: newFid(),
      name: bone.object.name || "Bone",
      position: position.toArray().map(round6),
      rotation: [rotation.x, rotation.y, rotation.z].map(round6),
      scale: scale.toArray().map(round6),
      components: [{ type: "bone", props: { path: bone.path } }],
      children: bone.children.map((child) => makeNode(child, bone.object)),
    };
  };

  // Root joints are local to the prefab root. In particular, keep any
  // transform carried by glTF's scene root rather than accidentally dividing
  // it away here.
  return bones.filter((bone) => !bone.parent).map((bone) => makeNode(bone));
}
