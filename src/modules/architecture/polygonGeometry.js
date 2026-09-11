import * as THREE from "three/webgpu";

/** A real closed slab, including concave outlines and through holes. XZ units
 * remain metres; the surface sits at y=0 and thickness extends downward. */
export function buildPolygonSlab(props) {
  const points = props.footprint;
  if (!Array.isArray(points) || points.length < 3 || points.length > 256) throw new Error("A slab footprint needs 3–256 points.");
  const ring = (values) => {
    if (!Array.isArray(values) || values.length < 3 || values.length > 256 || values.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n)))) throw new Error("Invalid slab polygon.");
    return values.map(([x, z]) => new THREE.Vector2(x, -z));
  };
  const shape = new THREE.Shape(ring(points));
  if ((props.holes?.length ?? 0) > 64) throw new Error("A slab supports up to 64 openings.");
  for (const hole of props.holes ?? []) shape.holes.push(new THREE.Path(ring(hole)));
  const thickness = Number(props.size?.[1] ?? .2);
  if (!Number.isFinite(thickness) || thickness <= 0) throw new Error("Slab thickness must be positive and finite.");
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, steps: 1, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2).translate(0, -thickness, 0);
  // ExtrudeGeometry is non-indexed. The GI and collision collectors require
  // indexed geometry, even when each face intentionally keeps its own normal.
  geometry.setIndex(Array.from({ length: geometry.getAttribute("position").count }, (_, i) => i));
  geometry.clearGroups();
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return { geometry, boxes: [] };
}
