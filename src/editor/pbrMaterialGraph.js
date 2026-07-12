/**
 * Builds the shader graph for a "ready to use" PBR .mat: texture nodes →
 * Principled BSDF → Material Output, exactly as a user would wire it by hand
 * in the Shader Graph panel (so it stays fully editable). Shared by the
 * Poly Haven importer and the GLB unpack pipeline.
 *
 * `maps` holds asset paths per slot: diffuse, normal (GL convention),
 * roughness, ao, metalness, and `arm` — a packed R=AO / G=rough / B=metal
 * image (Poly Haven's arm; glTF's metallicRoughness ORM has the same layout).
 * Packed channels only fill slots without a dedicated map. Pass
 * `armHasAo: false` when the packed image's red channel isn't trustworthy
 * occlusion (glTF metallicRoughness textures leave R undefined unless the
 * material's own aoMap points at the same image).
 */
export function buildPbrGraph(maps, { armHasAo = true } = {}) {
  const nodes = [{ id: "out", type: "output", props: {}, position: { x: 980, y: 200 } }];
  const edges = [];
  const bsdf = { id: "bsdf", type: "principledBsdf", props: {}, position: { x: 620, y: 80 } };
  nodes.push(bsdf);
  edges.push({ source: "bsdf", sourceHandle: "out", target: "out", targetHandle: "surface" });

  let row = 0;
  const texNode = (slot, path) => {
    const id = `tex_${slot}`;
    nodes.push({ id, type: "texture", props: { path }, position: { x: 120, y: row++ * 240 } });
    return id;
  };
  const wire = (source, sourceHandle, targetHandle) =>
    edges.push({ source, sourceHandle, target: "bsdf", targetHandle });

  if (maps.diffuse) wire(texNode("diffuse", maps.diffuse), "out", "color");
  if (maps.roughness) wire(texNode("roughness", maps.roughness), "r", "roughness");
  if (maps.ao) wire(texNode("ao", maps.ao), "r", "ao");
  if (maps.metalness) wire(texNode("metalness", maps.metalness), "r", "metalness");
  if (maps.arm) {
    const id = texNode("arm", maps.arm);
    if (!maps.ao && armHasAo) wire(id, "r", "ao");
    if (!maps.roughness) wire(id, "g", "roughness");
    if (!maps.metalness) wire(id, "b", "metalness");
  }
  if (maps.normal) {
    const tex = texNode("normal", maps.normal);
    nodes.push({ id: "nmap", type: "normalMap", props: {}, position: { x: 400, y: 420 } });
    edges.push({ source: tex, sourceHandle: "out", target: "nmap", targetHandle: "color" });
    edges.push({ source: "nmap", sourceHandle: "out", target: "bsdf", targetHandle: "normal" });
  }
  return { nodes, edges };
}
