import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4,Vector3,Vector4,Object3D } from 'three/webgpu';
import {resolveClothAnchors,MAX_CLOTH_ANCHORS} from '../src/engine/vfx/clothAnchors.js';
import {ClothComponent} from '../src/engine/components/ClothComponent.js';
const rows=()=>Array.from({length:MAX_CLOTH_ANCHORS},()=>new Vector4());
test('moving target anchors transform local offsets through parent rotation/scale and cloth inverse',()=>{
 const parent=new Object3D(),target=new Object3D(),cloth=new Object3D();parent.add(target);
 parent.position.set(5,2,-3);parent.rotation.y=.7;parent.scale.set(2,3,1);
 target.position.set(1,2,3);target.rotation.z=.5;target.scale.set(1,2,1);
 cloth.position.set(-2,3,1);cloth.rotation.x=.2;cloth.scale.set(3,1,2);cloth.updateWorldMatrix(true,false);
 const engine={entities:new Map([['target',{object3D:target}]])},inverse=cloth.matrixWorld.clone().invert(),output=rows();
 const anchors=[{entityId:'target',uv:[1,.5],offset:[.4,1,-.3]}];
 assert.equal(resolveClothAnchors(anchors,engine,inverse,9,output),1);assert.equal(output[0].w,44);
 let expected=new Vector3(.4,1,-.3).applyMatrix4(target.matrixWorld).applyMatrix4(inverse);
 assert.ok(new Vector3(...output[0].toArray()).distanceTo(expected)<1e-9);
 parent.position.x+=7;resolveClothAnchors(anchors,engine,inverse,9,output);
 expected=new Vector3(.4,1,-.3).applyMatrix4(target.matrixWorld).applyMatrix4(inverse);
 assert.ok(new Vector3(...output[0].toArray()).distanceTo(expected)<1e-9);
});
test('missing targets and disabled anchors release; same grid point resolves last enabled anchor',()=>{
 const object3D=new Object3D(),engine={entities:new Map([['target',{object3D}]])},output=rows();
 const anchors=[{entityId:'missing'},{entityId:'target',enabled:false},{entityId:'target',uv:[0,0],offset:[1,0,0]},{entityId:'target',uv:[0,0],offset:[3,0,0]}];
 assert.equal(resolveClothAnchors(anchors,engine,new Matrix4(),8,output),1);assert.equal(output[0].x,3);assert.equal(output[1].w,-1);
 engine.entities.clear();assert.equal(resolveClothAnchors(anchors,engine,new Matrix4(),8,output),0);assert.equal(output[0].w,-1);
});
test('cloth anchor references serialize as instance props and retain preset pins',()=>{
 const anchors=[{entityId:'moving',uv:[.5,0],offset:[0,1,0],enabled:true}];
 const cloth=new ClothComponent({anchors,pinning:'leftCorners'});
 const json=JSON.parse(JSON.stringify(cloth.toJSON()));
 assert.deepEqual(json.props.anchors,anchors);assert.equal(json.props.pinning,'leftCorners');
 assert.equal(ClothComponent.schema.find(f=>f.key==='anchors').type,'clothAnchors');
 cloth._vfxAssetGraph=null;cloth.resolveGraph();assert.deepEqual(cloth.resolvedProps.anchors,anchors);
});
