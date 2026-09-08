import * as THREE from 'three/webgpu';
import { instancedArray, uniform } from 'three/tsl';
import { collectCollisionMesh } from '../modules/physics-rapier/collisionGeometry.js';
import { freeze } from './freezeLedger.js';

export const CLOTH_MESH_COLLIDER_MAX_TRIANGLES = 8192;
/** How far past a cloth's own culling sphere a collider still counts. */
const REACH_MARGIN = 0.25;
const reachBox = new THREE.Box3();

/** Does this object's world box come within any cloth's reach? */
function withinReach(root, reach) {
  // ⚠ NOT `precise`: that walks every VERTEX, which is the cost this test
  // exists to avoid. The default uses each child's geometry bounding box —
  // looser, and looser is the safe direction for a cull.
  reachBox.setFromObject(root);
  if (reachBox.isEmpty()) return true;      // nothing measurable — keep it
  for (const { centre, radius } of reach) {
    if (reachBox.distanceToPoint(centre) <= radius) return true;
  }
  return false;
}

export const CLOTH_MESH_COLLIDER_NODE_FLOATS = 20;
const ids = new WeakMap();
let nextId = 1;
const objectId = value => {
  if (!value) return 0;
  if (!ids.has(value)) ids.set(value, nextId++);
  return ids.get(value);
};
function enabled(entity, playing) {
  for (let current = entity; current; current = current.parent) {
    if (current[playing ? 'enabledInGame' : 'enabledInEditor'] === false) return false;
  }
  return true;
}

/** Certify each connected shell independently. UV/normal seams are welded in
 * position space, but open, non-manifold or inconsistently wound shells never
 * acquire a solid-inside meaning. The sign converts authored face normals to
 * outward normals; disconnected shells may have opposite authored winding. */
export function certifyClosedCollisionShells(mesh) {
  const count = Math.floor((mesh?.indices?.length ?? 0)/3);
  const signs = new Int8Array(count);
  signs.shellIds = new Int32Array(count).fill(-1);
  signs.shellCount = 0;
  if (!count) return signs;
  const bounds = new THREE.Box3().setFromArray(mesh.vertices);
  const extent = bounds.getSize(new THREE.Vector3()).length();
  const epsilon = Math.max(extent*1e-7, 1e-8);
  const buckets = new Map(), points = [], welded = [];
  for (let i=0;i<mesh.vertices.length;i+=3) {
    const point = Array.from(mesh.vertices.slice(i,i+3));
    const cell = point.map(v=>Math.floor(v/epsilon));
    let found = -1;
    for(let x=-1;x<=1 && found<0;x++) for(let y=-1;y<=1 && found<0;y++) for(let z=-1;z<=1 && found<0;z++) {
      for(const candidate of buckets.get(`${cell[0]+x},${cell[1]+y},${cell[2]+z}`) ?? []) {
        if (point.every((v,axis)=>Math.abs(v-points[candidate][axis])<=epsilon)) { found=candidate; break; }
      }
    }
    if(found<0) {
      found=points.length; points.push(point);
      const key=cell.join(','); if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(found);
    }
    welded.push(found);
  }
  const parents=Array.from({length:count},(_,i)=>i), valid=new Uint8Array(count).fill(1), edges=new Map();
  const find=i=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
  for(let face=0;face<count;face++) {
    const vertices=[0,1,2].map(j=>welded[mesh.indices[face*3+j]]);
    if(new Set(vertices).size!==3 || vertices.some(i=>i===undefined)){valid[face]=0;continue;}
    for(let j=0;j<3;j++) {
      const a=vertices[j],b=vertices[(j+1)%3],key=`${Math.min(a,b)},${Math.max(a,b)}`;
      if(!edges.has(key))edges.set(key,[]);
      const entries=edges.get(key);
      if(entries.length)parents[find(face)]=find(entries[0].face);
      entries.push({face,direction:a<b?1:-1});
    }
  }
  for(const entries of edges.values()) if(entries.length!==2 || entries[0].direction===entries[1].direction) {
    for(const {face} of entries)valid[face]=0;
  }
  const shells=new Map();
  for(let face=0;face<count;face++) {
    const root=find(face);if(!shells.has(root))shells.set(root,[]);shells.get(root).push(face);
  }
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),origin=new THREE.Vector3();
  for(const faces of shells.values()) {
    if(faces.some(face=>!valid[face]))continue;
    origin.fromArray(mesh.vertices,mesh.indices[faces[0]*3]*3);
    let volume=0;
    for(const face of faces) {
      a.fromArray(mesh.vertices,mesh.indices[face*3]*3).sub(origin);
      b.fromArray(mesh.vertices,mesh.indices[face*3+1]*3).sub(origin);
      c.fromArray(mesh.vertices,mesh.indices[face*3+2]*3).sub(origin);
      volume+=a.dot(b.cross(c));
    }
    if(Math.abs(volume)<=epsilon**3)continue;
    const shellId = signs.shellCount++;
    for(const face of faces) { signs[face]=Math.sign(volume); signs.shellIds[face]=shellId; }
  }
  return signs;
}

/** A preorder, stackless BVH over actual triangle surfaces. One storage buffer:
 * min.xyz/escape, max.xyz/isLeaf, a.xyz/outwardSign, b.xyz/shellId, c.xyz/ownerIndex.
 * Branch b.w/c.w store the min/max closed shell IDs in the subtree.
 * Branch hit -> next node; branch miss or completed leaf -> escape. Root's
 * escape equals node count. Leaves preserve holes; no convex/bounds substitute.
 */
export function packClothCollisionBVH(triangles, output) {
  let count = 0;
  function build(items) {
    const index = count++;
    const base = index * CLOTH_MESH_COLLIDER_NODE_FLOATS;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const triangle of items) for (let vertex = 0; vertex < 3; vertex++) for (let axis = 0; axis < 3; axis++) {
      const value = triangle.vertices[vertex*3+axis];
      min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
    }
    output.set([...min, 0, ...max, items.length === 1 ? 1 : 0], base);
    if (items.length === 1) {
      const triangle = items[0];
      output.set([...triangle.vertices.slice(0,3), triangle.outward ?? 0, ...triangle.vertices.slice(3,6), triangle.shellId ?? -1,
        ...triangle.vertices.slice(6,9), triangle.owner], base+8);
    } else {
      output[base+11] = items.some(triangle=>triangle.outward) ? 1 : 0;
      const shellIds = items.filter(triangle=>triangle.outward).map(triangle=>triangle.shellId);
      output[base+15] = shellIds.length ? Math.min(...shellIds) : -1;
      output[base+19] = shellIds.length ? Math.max(...shellIds) : -1;
      const extents = max.map((v, i) => v-min[i]);
      const axis = extents.indexOf(Math.max(...extents));
      const centroid = triangle => triangle.vertices[axis]+triangle.vertices[axis+3]+triangle.vertices[axis+6];
      items.sort((a,b)=>centroid(a)-centroid(b));
      const middle = Math.floor(items.length/2);
      build(items.slice(0,middle)); build(items.slice(middle));
    }
    output[base+3] = count;
  }
  if (triangles.length) build(triangles);
  return count;
}

/** Shared per-engine, cached triangle field. Cooked Concave geometry wins when
 * ready, otherwise rendered source triangles are used in their local frame.
 * A budget overflow omits an entire collider and exposes error, never a partial
 * surface whose newly invented holes would let cloth fall through.
 */
export class ClothMeshColliderField {
  constructor(engine, { maxTriangles = CLOTH_MESH_COLLIDER_MAX_TRIANGLES } = {}) {
    this.engine = engine;
    this.maxTriangles = Math.max(1, Math.min(CLOTH_MESH_COLLIDER_MAX_TRIANGLES, Math.floor(maxTriangles)));
    this.data = new Float32Array((this.maxTriangles*2-1)*CLOTH_MESH_COLLIDER_NODE_FLOATS);
    this.buffer = instancedArray(this.data, 'vec4');
    this.countUniform = uniform(0, 'int');
    this.closedShellCountUniform = uniform(0, 'int');
    this.entityIndices = new Map();
    this.activeUsers = 0;
    this.error = null;
    this.triangleCount = 0;
    this.diagnostics = [];
    this.revision = 0;
    this._signature = null;
    this._sources = new Map();
    // The frame this field last scanned the scene on. See `refresh`.
    this._scannedFrame = -1;
    this._users = new Set();
    this._reach = [];
  }
  addUser(user = null) { this.activeUsers++; if (user) this._users.add(user); }
  removeUser(user = null) {
    if (user) this._users.delete(user);
    this.activeUsers = Math.max(0, this.activeUsers-1);
    if (!this.activeUsers) {
      this._sources.clear(); this._signature=null; this.entityIndices.clear();
      this.countUniform.value=0; this.triangleCount=0; this.diagnostics=[]; this.error=null;
      this.closedShellCountUniform.value=0;
    }
  }
  dispose() {
    this._sources.clear(); this.entityIndices.clear();
    if (this.engine.clothMeshColliders === this) delete this.engine.clothMeshColliders;
  }
  /**
   * ⚠ THIS RUNS EVERY FRAME, and it has two very different costs.
   *
   * The cheap half is the SIGNATURE: a walk of every entity, a world-matrix
   * update per collider and a `JSON.stringify` of the result, done each frame
   * to notice that nothing moved. The expensive half is everything after it —
   * re-collecting every collider's triangles and rebuilding the BVH — and that
   * runs whenever the signature differs, which is EVERY FRAME A COLLIDER IS
   * MOVING.
   *
   * Both halves are marked separately because "freezes every time my character
   * contacts with it" (user, 2026-09-08) is a report this ledger has to be able
   * to answer, and an unmarked block lands in `(unattributed)` where it says
   * nothing. `colliders:signature` being large means the per-frame check itself
   * is the cost; `colliders:rebuild` being large means a moving collider is
   * rebuilding the whole triangle set every frame, which is a different fix.
   */
  refresh() {
    if (this.activeUsers <= 0) return;
    // ⛔⛔ **ONCE A FRAME, NOT ONCE PER CLOTH.** This field is SHARED — one
    // `engine.clothMeshColliders` serves every cloth in the scene — but it was
    // refreshed from each cloth's own tick, so the scan below ran once per
    // cloth per frame and produced the identical answer every time. The cost
    // was therefore CLOTHS x COLLIDERS: on the user's Sponza, eleven cloths
    // meant eleven full scene walks, eleven sets of recursive world-matrix
    // updates and eleven `JSON.stringify`s of every collider's matrix, every
    // frame.
    //
    // That is exactly the reported shape: "adding more colliders to the scene
    // automatically make cloth a lot more expensive, even if the colliders do
    // not interact with the cloth" (user, 2026-09-08) — the collider count is
    // one factor of a product, and the cloth count is the other.
    //
    // `renderer.info.frame` increments once per rendered frame, so the first
    // cloth to ask does the work and the other ten read what it published.
    const frame = this.engine?.renderer?.info?.frame;
    if (frame !== undefined && frame === this._scannedFrame) return;
    this._scannedFrame = frame ?? -1;
    const span = freeze.begin("colliders:signature");
    // ⭐⭐⭐ **A COLLIDER NOTHING CAN TOUCH MUST COST NOTHING.** Every
    // mesh/concave collider in the scene was collected, transformed and packed
    // into one BVH regardless of where it was, so a collider on the far side of
    // the level was paid for by every cloth: "adding more colliders to the
    // scene automatically make cloth a lot more expensive, even if the
    // colliders do not interact with the cloth" (user, 2026-09-08).
    //
    // Each cloth already maintains a bounding sphere that covers its ballistic
    // excursion (`updateBounds`), so the union of those spheres is the only
    // region any cloth can reach. A collider whose world box misses all of them
    // is skipped before its triangles are ever touched.
    //
    // ⚠ The sphere is the CULLING sphere, deliberately generous — it already
    // includes how far the cloth could be thrown — and `REACH_MARGIN` adds the
    // contact thickness on top. This is a conservative test: it can only ever
    // keep a collider that turns out to be unnecessary, never drop one that was
    // needed.
    this._reach.length = 0;
    for (const user of this._users) {
      const mesh = user?.simulation?.mesh;
      const sphere = mesh?.geometry?.boundingSphere;
      if (!mesh || !sphere || !(sphere.radius > 0)) { this._reach.length = 0; break; }
      const centre = sphere.center.clone().applyMatrix4(mesh.matrixWorld);
      const scale = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
      this._reach.push({ centre, radius: sphere.radius * Math.max(scale.x, scale.y, scale.z) + REACH_MARGIN });
    }
    const reach = this._reach;
    const candidates = [], signature = [];
    for (const entity of this.engine.entities.values()) {
      const collider = entity.getComponent?.('collider');
      if (!collider || collider.enabled === false || collider.props.isSensor || !enabled(entity, this.engine.playing)) continue;
      const p = collider.props;
      if (p.shape !== 'concave' && p.shape !== 'mesh') continue;
      const root = entity.object3D;
      root.updateWorldMatrix(true, true, true);
      // Out of every cloth's reach: not scanned, not collected, not packed.
      // `reach` empty means "could not measure", which keeps everything.
      if (reach.length && !withinReach(root, reach)) {
        this._sources.delete(entity);
        continue;
      }
      const cooked = this.engine.physics?.getCookedColliderGeometry?.(entity);
      const source = p.shape === 'concave' ? cooked?.concave ?? cooked : cooked;
      const sourceSignature = [p.shape, !!p.autoGenerated, objectId(source), objectId(source?.vertices), objectId(source?.indices)];
      if (!source) root.traverse(child => {
        if (!child.isMesh || child.userData.vfxSimulation || child.userData.engineOwned) return;
        sourceSignature.push(child.uuid, objectId(child.geometry), objectId(child.geometry?.attributes?.position),
          child.geometry?.attributes?.position?.version, child.geometry?.index?.version, ...child.matrixWorld.elements);
      });
      const sourceKey = JSON.stringify(sourceSignature);
      let cached = this._sources.get(entity);
      if (!cached || cached.key !== sourceKey) {
        cached = { key: sourceKey, mesh: source ?? collectCollisionMesh(root, {
          ownerEntityId: p.autoGenerated ? entity.id : null, bakeRootScale: false, includeSkinned: false,
        }) };
        cached.closedSigns = certifyClosedCollisionShells(cached.mesh);
        this._sources.set(entity, cached);
      }
      candidates.push({ entity, props: p, mesh: cached.mesh, closedSigns: cached.closedSigns, cooked: !!source });
      signature.push(entity.id, sourceKey, ...root.matrixWorld.elements, ...(p.offset ?? [0,0,0]), ...(p.rotation ?? [0,0,0]));
    }
    const key = JSON.stringify(signature);
    freeze.end(span);
    if (key === this._signature) return;
    this._signature = key;
    const rebuild = freeze.begin("colliders:rebuild");
    try {
    const alive = new Set(candidates.map(({entity})=>entity));
    for (const entity of this._sources.keys()) if (!alive.has(entity)) this._sources.delete(entity);
    this.entityIndices.clear();
    this.diagnostics = [];
    const triangles = [], errors = [];
    let closedShellCount = 0;
    const position = new THREE.Vector3(), scale = new THREE.Vector3(), quaternion = new THREE.Quaternion();
    const localRotation = new THREE.Quaternion(), offset = new THREE.Vector3(), vertex = new THREE.Vector3();
    const edgeA = new THREE.Vector3(), edgeB = new THREE.Vector3();
    for (const {entity,props,mesh,closedSigns,cooked} of candidates) {
      const diagnostic = { entityId: entity.id, name: entity.name, shape: props.shape, source: cooked ? 'cooked' : 'authored', triangles: 0, closed: false, closedTriangles: 0, status: 'included' };
      this.diagnostics.push(diagnostic);
      if (!mesh?.vertices || !mesh?.indices) { diagnostic.status = 'missing-geometry'; continue; }
      const triangleCount = Math.floor(mesh.indices.length/3);
      if (triangles.length + triangleCount > this.maxTriangles) {
        diagnostic.status = 'over-budget';
        diagnostic.triangles = triangleCount;
        errors.push(`${entity.name ?? entity.id}: ${triangleCount} triangles exceed remaining cloth collision budget (${this.maxTriangles-triangles.length}/${this.maxTriangles})`);
        continue;
      }
      entity.object3D.matrixWorld.decompose(position, quaternion, scale);
      localRotation.setFromEuler(new THREE.Euler(...[0,1,2].map(i=>(props.rotation?.[i]??0)*THREE.MathUtils.DEG2RAD)));
      offset.fromArray(props.offset ?? [0,0,0]).multiply(scale).applyQuaternion(quaternion).add(position);
      const owner = this.entityIndices.size;
      this.entityIndices.set(entity.id, owner);
      const shellBase = closedShellCount;
      closedShellCount += closedSigns.shellCount;
      const before = triangles.length;
      for (let i=0; i<mesh.indices.length-2; i+=3) {
        const vertices = [];
        for (let j=0;j<3;j++) {
          vertex.fromArray(mesh.vertices,mesh.indices[i+j]*3).multiply(scale).applyQuaternion(localRotation).applyQuaternion(quaternion).add(offset);
          vertices.push(...vertex.toArray());
        }
        if (!vertices.every(Number.isFinite)) continue;
        edgeA.fromArray(vertices,3).sub(vertex.fromArray(vertices));
        edgeB.fromArray(vertices,6).sub(vertex);
        if (edgeA.cross(edgeB).lengthSq() < 1e-16) continue;
        const outward = closedSigns[i/3] * Math.sign(scale.x*scale.y*scale.z);
        if(outward)diagnostic.closedTriangles++;
        triangles.push({ vertices, owner, outward, shellId: outward ? shellBase+closedSigns.shellIds[i/3] : -1 });
      }
      diagnostic.triangles = triangles.length - before;
      diagnostic.closed = diagnostic.triangles > 0 && diagnostic.closedTriangles === diagnostic.triangles;
      if (!diagnostic.triangles) diagnostic.status = 'empty-geometry';
    }
    this.error = errors.length ? errors.join('; ') : null;
    this.triangleCount = triangles.length;
    this.closedShellCountUniform.value = closedShellCount;
    this.countUniform.value = packClothCollisionBVH(triangles, this.data);
    this.buffer.value.needsUpdate = true;
    this.revision++;
    } finally { freeze.end(rebuild); }
  }
}
