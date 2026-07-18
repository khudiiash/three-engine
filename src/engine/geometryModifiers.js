import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from "three-bvh-csg";
import { LoopSubdivision } from "three-subdivide";

const BOOLEAN_OPERATIONS = {
  union: ADDITION,
  subtract: SUBTRACTION,
  intersect: INTERSECTION,
};

function triangleCount(geometry) {
  return geometry.index ? geometry.index.count / 3 : geometry.getAttribute("position")?.count / 3 || 0;
}

function ensureBrushAttributes(geometry) {
  const result = geometry.clone();
  if (!result.getAttribute("normal")) result.computeVertexNormals();
  if (!result.getAttribute("uv")) {
    const count = result.getAttribute("position")?.count ?? 0;
    result.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  return result;
}

export function applyBooleanModifier(source, target, operation, targetToSource = new THREE.Matrix4()) {
  const operationCode = BOOLEAN_OPERATIONS[operation];
  if (!operationCode || !source?.getAttribute?.("position") || !target?.getAttribute?.("position")) return source.clone();
  const sourceGeometry = ensureBrushAttributes(source);
  const targetGeometry = ensureBrushAttributes(target);
  targetGeometry.applyMatrix4(targetToSource);
  sourceGeometry.clearGroups();
  targetGeometry.clearGroups();
  const sourceBrush = new Brush(sourceGeometry);
  const targetBrush = new Brush(targetGeometry);
  sourceBrush.updateMatrixWorld(true);
  targetBrush.updateMatrixWorld(true);
  const evaluator = new Evaluator();
  evaluator.attributes = ["position", "normal", "uv"];
  evaluator.useGroups = false;
  const result = evaluator.evaluate(sourceBrush, targetBrush, operationCode).geometry;
  sourceGeometry.dispose();
  targetGeometry.dispose();
  result.computeVertexNormals();
  result.computeBoundingBox();
  result.computeBoundingSphere();
  if (triangleCount(result)) result.addGroup(0, triangleCount(result) * 3, 0);
  return result;
}

export function applyArrayModifier(source, count = 1, offset = [1, 0, 0]) {
  const copies = THREE.MathUtils.clamp(Math.round(Number(count)) || 1, 1, 256);
  if (copies === 1) return source.clone();
  const step = new THREE.Vector3().fromArray(Array.isArray(offset) ? offset : [1, 0, 0]);
  const geometries = [];
  for (let index = 0; index < copies; index++) {
    const geometry = source.clone();
    geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(step.x * index, step.y * index, step.z * index));
    geometries.push(geometry);
  }
  const result = mergeGeometries(geometries, true);
  geometries.forEach((geometry) => geometry.dispose());
  if (!result) throw new Error("Array modifier could not merge incompatible geometry attributes");
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

export function applySubdivisionSurfaceModifier(source, levels = 0) {
  const iterations = THREE.MathUtils.clamp(Math.round(Number(levels)) || 0, 0, 4);
  if (!iterations) return source.clone();
  const result = LoopSubdivision.modify(source, iterations, {
    split: true,
    uvSmooth: true,
    preserveEdges: false,
    flatOnly: false,
    maxTriangles: 500_000,
  });
  result.computeVertexNormals();
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

/** Applies the fixed Blender-style stack: Boolean -> Array -> Subdivision. */
export function evaluateGeometryModifiers(source, props, context = {}) {
  let geometry = source.clone();
  if (props.booleanOperation && props.booleanOperation !== "none" && context.booleanGeometry) {
    const next = applyBooleanModifier(
      geometry,
      context.booleanGeometry,
      props.booleanOperation,
      context.booleanMatrix,
    );
    geometry.dispose();
    geometry = next;
  }
  if ((props.arrayCount ?? 1) > 1) {
    const next = applyArrayModifier(geometry, props.arrayCount, props.arrayOffset);
    geometry.dispose();
    geometry = next;
  }
  if ((props.subdivisionLevels ?? 0) > 0) {
    const next = applySubdivisionSurfaceModifier(geometry, props.subdivisionLevels);
    geometry.dispose();
    geometry = next;
  }
  return geometry;
}

