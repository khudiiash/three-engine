import test from 'node:test';import assert from 'node:assert/strict';
import {waterWaveHeight,waterWaveNormal,WATER_WAVE_DEFAULTS} from '../src/engine/vfx/waterWaves.js';
test('layered waves deterministic, bounded, flat when disabled and animate without repeating one period',()=>{
 const p={...WATER_WAVE_DEFAULTS,waveHeight:.8,choppiness:1,rippleStrength:2};
 let movement=0;
 for(let i=0;i<100;i++){
  const x=i*.17,z=Math.sin(i)*3,h=waterWaveHeight(x,z,2,p);assert.equal(h,waterWaveHeight(x,z,2,p));assert.ok(Math.abs(h)<.8*1.5);
  movement+=Math.abs(h-waterWaveHeight(x,z,2+Math.PI,p));
  assert.ok(waterWaveHeight(x,z,2,{...p,waveHeight:0})===0);
  const normal=waterWaveNormal(x,z,2,p);assert.ok(Math.abs(Math.hypot(...normal)-1)<1e-10);assert.ok(normal[1]>0);
 }
 assert.ok(movement>5,'multiple bands do not repeat after primary period');
});
test('wave direction rotates spatial field and ripple strength changes fine structure',()=>{
 const p={waveDirection:0};let rippleDifference=0;
 for(let i=0;i<50;i++){
  const x=i*.1,z=i*.13;
  assert.ok(Math.abs(waterWaveHeight(x,z,1,p)-waterWaveHeight(-z,x,1,{waveDirection:90}))<1e-10);
  rippleDifference+=Math.abs(waterWaveHeight(x,z,1,{rippleStrength:0})-waterWaveHeight(x,z,1,{rippleStrength:2}));
 }
 assert.ok(rippleDifference>.1);
});

