import { Vector3 } from 'three/webgpu';
export const MAX_CLOTH_ANCHORS = 32;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
/** UV is normalized across the source grid: (0,0) top-left, (1,1) bottom-right.
 * Target offsets are in the target entity's local space. Missing targets release
 * their point; later anchors win when several UVs resolve to the same vertex.
 */
export function resolveClothAnchors(anchors, engine, inverse, resolution, rows) {
  const resolved = new Map(), point = new Vector3();
  for (const anchor of Array.isArray(anchors) ? anchors.slice(0,MAX_CLOTH_ANCHORS) : []) {
    if (anchor?.enabled === false) continue;
    const target = engine?.entities?.get(anchor?.entityId);
    if (!target?.object3D) continue;
    target.object3D.updateWorldMatrix(true,false,true);
    point.set(...[0,1,2].map(i=>finite(anchor.offset?.[i]))).applyMatrix4(target.object3D.matrixWorld).applyMatrix4(inverse);
    if (!point.toArray().every(Number.isFinite)) continue;
    const [x,y] = [0,1].map(i=>Math.round(Math.max(0,Math.min(1,finite(anchor.uv?.[i])))*(resolution-1)));
    resolved.set(y*resolution+x,point.clone());
  }
  let count=0;
  for (const [index,position] of resolved) rows[count++].set(position.x,position.y,position.z,index);
  for (let i=count;i<rows.length;i++) rows[i].set(0,0,0,-1);
  return count;
}
