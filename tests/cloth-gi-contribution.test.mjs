import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { instancedArray, uniform } from 'three/tsl';
import { createDynamicObjectSet } from '../src/modules/gi/dynamicObjects.js';

test('GPU cloth contribution waits for refit, reads graph color and reuses pooled geometry', () => {
  const bits=instancedArray(new Uint32Array(16384),'uint');
  const dyn=createDynamicObjectSet({bits,baseWord:0,capacityWords:16384,maxObjects:4});
  const material=new THREE.MeshStandardNodeMaterial({color:0xffffff});
  material.colorNode=uniform(new THREE.Color(0xff0000));
  const geometry=new THREE.PlaneGeometry(2,2,8,8); geometry.computeBoundingSphere();
  const mesh=new THREE.Mesh(geometry,material); mesh.updateMatrixWorld(true);
  const shape={type:'mesh',center:new THREE.Vector3(),halfExtents:new THREE.Vector3(3,3,3),gpuGrid:{positionAttribute:new THREE.StorageBufferAttribute(81,3),resolution:9}};
  assert.equal(dyn.adopt('cloth',mesh,null,shape),true);
  let entry; dyn.forEachEntry(e=>entry=e);
  assert.deepEqual(entry.surface.albedo,[1,0,0]);
  dyn.sync(); assert.equal(entry.published,false);
  const gpu=entry.geoBlock.gpu.computes;
  assert.ok(gpu.every(compute=>dyn.pendingDispatch().includes(compute)));
  dyn.confirmDispatch(new Set(gpu)); dyn.sync(); assert.equal(entry.published,false);
  dyn.confirmDispatch(new Set()); dyn.sync(); assert.equal(entry.published,true);
  const used=dyn.stats.poolWordsUsed;
  dyn.release('cloth'); assert.ok(gpu.every(compute=>!dyn.pendingDispatch().includes(compute)));
  assert.equal(dyn.adopt('cloth',mesh,null,shape),true);
  assert.equal(dyn.stats.poolWordsUsed,used);
  material.colorNode=uniform(new THREE.Color(0x00ff00));material.needsUpdate=true;
  dyn.sync();dyn.forEachEntry(e=>entry=e);assert.deepEqual(entry.surface.albedo,[0,1,0]);
});
