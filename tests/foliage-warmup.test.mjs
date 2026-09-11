import test from 'node:test';
import assert from 'node:assert/strict';
import {compileFoliageMesh, updateFoliageWarmup, deferFoliageDisposal, holdFoliageResources} from '../src/modules/foliage/foliageWarmup.js';

function fixture() {
  const scene={overrideMaterial:{old:true},background:{sky:true},backgroundNode:{skyNode:true}};
  const mesh={visible:false,frustumCulled:true};
  const camera={};
  const renderer={target:null,mrt:null,shadowMap:{enabled:true},
    getRenderTarget(){return this.target;},setRenderTarget(t){this.target=t;},getMRT(){return this.mrt;},setMRT(t){this.mrt=t;}};
  return {scene,mesh,camera,renderer};
}

test('hidden foliage warmup restores live visibility before its unresolved main compilation',async()=>{
  const {scene,mesh,camera,renderer}=fixture();
  const before={...scene},target=renderer.target,mrt=renderer.mrt;
  let release;
  renderer.compileAsync=(object,view,world)=>{
    assert.equal(object,mesh);assert.equal(view,camera);assert.equal(world,scene);
    assert.equal(mesh.visible,true);assert.equal(mesh.frustumCulled,false);
    assert.equal(renderer.target,null);assert.equal(renderer.mrt,null);
    assert.equal(scene.overrideMaterial,null);assert.equal(renderer.shadowMap.enabled,true);
    assert.equal(scene.background,null);
    return new Promise(resolve=>{release=resolve;});
  };
  const pending=compileFoliageMesh(renderer,scene,camera,mesh);
  assert.deepEqual(scene,before);assert.equal(renderer.target,target);assert.equal(renderer.mrt,mrt);
  assert.equal(mesh.visible,false);assert.equal(mesh.frustumCulled,true);assert.equal(renderer.shadowMap.enabled,true);
  release();await pending;
});

test('GI and post-processing MRT graphs stay with their pass owner during asynchronous warmup',async()=>{
  const {scene,mesh,camera,renderer}=fixture();const captures=[];
  Object.assign(renderer,{_initialized:true,compileAsync:async()=>{
    // Reproduce Three reading live MRT after its synchronous render-list capture.
    await Promise.resolve(); captures.push({target:renderer.target,mrt:renderer.mrt,material:scene.overrideMaterial});
  }});
  const gbuffer={rt:{uuid:'gbuffer'},mrtNode:{uuid:'gi-mrt'},material:{uuid:'gi-material'}};
  const engine={renderer,scene,camera,modules:new Map([['gi',{system:{state:{screen:{gbuffer}}}}]]),loopActive:true};
  const component={entity:{engine},root:{},_alive:true,_generation:1,_atlasEntry:{atlas:{}},material:{version:0},renderMeshes:[mesh]};
  updateFoliageWarmup(component);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(captures.length,1,'only the main variant, never the GI override');
  assert.equal(captures[0].target,null);assert.equal(captures[0].mrt,null);
  engine.scenePass={renderTarget:{uuid:'post'},getMRT:()=>({uuid:'post-mrt'})};
  updateFoliageWarmup(component);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(captures.length,1,'a post-process MRT must not be temporarily installed');
  assert.equal(component._foliageWarmup.pending,0);
  renderer.mrt=gbuffer.mrtNode;
  compileFoliageMesh(renderer,scene,camera,mesh);
  assert.equal(captures.length,1,'the direct helper also refuses a live MRT');
});

test('failed compilation restores the camera-visible material and framebuffer',()=>{
  const {scene,mesh,camera,renderer}=fixture();
  const before={...scene},target=renderer.target;
  renderer.compileAsync=()=>{throw new Error('original compile failure');};
  assert.throws(()=>compileFoliageMesh(renderer,scene,camera,mesh),/original compile failure/);
  assert.deepEqual(scene,before);assert.equal(renderer.target,target);assert.equal(mesh.visible,false);
});

test('a detached foliage component never compiles queued obsolete geometry',async()=>{
  const {scene,mesh,camera,renderer}=fixture();let calls=0;
  Object.assign(renderer,{_initialized:true,compileAsync:async()=>{calls++;}});
  const engine={renderer,scene,camera,modules:new Map(),loopActive:true};
  const component={entity:{engine},root:{},_alive:true,_generation:1,_atlasEntry:{atlas:{}},material:{version:0},chunks:[{meshes:[mesh]}]};
  updateFoliageWarmup(component);component._alive=false;
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls,0);
});

test('rebuild disposal waits for an in-flight GPU compilation even when that compile fails',async()=>{
  const component={};let reject, disposed=0;
  const building=holdFoliageResources(component,()=>new Promise((resolve,no)=>{reject=no;}));
  deferFoliageDisposal(component,()=>{disposed++;});
  deferFoliageDisposal(component,()=>{disposed++;});
  assert.equal(disposed,0,'async node build still owns the old geometry and material');
  reject(new Error('driver failure'));
  await assert.rejects(building,/driver failure/);
  assert.equal(disposed,2,'all old resources release in finally');
  deferFoliageDisposal(component,()=>{disposed++;});
  assert.equal(disposed,3,'ordinary detach keeps synchronous disposal');
});
