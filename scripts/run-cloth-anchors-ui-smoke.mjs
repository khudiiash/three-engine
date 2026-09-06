import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';
import {installTauriShim} from './lib/tauriShim.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'engine-anchor-ui-'));
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:'new',userDataDir:path.join(root,'profile'),args:['--enable-unsafe-webgpu','--enable-features=WebGPU','--no-sandbox']});
const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const check=(ok,label)=>{assert.ok(ok,label);console.log('ok',label);};
try{
 await page.setViewport({width:1500,height:1100});await installTauriShim(page,{writableRoot:root});
 await page.evaluateOnNewDocument(()=>{document.addEventListener('DOMContentLoaded',()=>{const icon=document.createElement('link');icon.rel='icon';icon.href='data:,';document.head.append(icon);});globalThis.__importLive=p=>{const prefix=location.origin+p;const resources=performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n===prefix||n.startsWith(prefix+'?'));return import(resources.find(n=>n.includes('?'))??resources[0]??p);};});
 await page.goto(process.argv[2]??'http://localhost:5321/',{waitUntil:'load',timeout:60000});await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Skip the project'))?.click());await page.waitForFunction(()=>!!globalThis.__viewport?.orbit,{timeout:60000});
 await page.evaluate(async()=>{const {engine}=await __importLive('/src/editor/engineInstance.js'),{setModuleEnabled}=await __importLive('/src/editor/modules.js'),{callOp}=await __importLive('/src/editor/api/registry.js'),{useSelectionStore}=await __importLive('/src/editor/store/selectionStore.js'),{openPanel}=await __importLive('/src/editor/EditorShell.jsx');await setModuleEnabled('cloth',true);globalThis.__engine=engine;const a=await callOp('entity.create',{name:'Anchor target'});globalThis.__target=a.id??a.entityId;const c=await callOp('entity.create',{name:'Anchored cloth'});globalThis.__clothId=c.id??c.entityId;await callOp('component.add',{id:__clothId,type:'mesh',props:{geometry:'plane'}});await callOp('component.add',{id:__clothId,type:'cloth',props:{resolution:8,sceneCollision:false}});useSelectionStore.getState().select(__clothId);openPanel('inspector');});
 await page.waitForSelector('.cloth-anchors-field button',{timeout:10000}).catch(async error=>{console.log(errors,await page.evaluate(()=>({id:__clothId,entity:__engine.entities.get(__clothId)?.name,body:document.body.innerText.slice(-6000)})));throw error;});await page.click('.cloth-anchors-field > button');await page.waitForSelector('[data-cloth-anchor="0"]');
 check(await page.evaluate(()=>__engine.entities.get(__clothId).getComponent('cloth').props.anchors.length===1),'Add anchor commits component');
 const target=await page.evaluate(()=>__target);await page.select('[data-cloth-anchor="0"] select',target);
 check(await page.evaluate(()=>__engine.entities.get(__clothId).getComponent('cloth').props.anchors[0].entityId===__target),'entity input commits target reference');
 const inputs=await page.$$('[data-cloth-anchor="0"] input:not([type="checkbox"])');assert.equal(inputs.length,5);
 await inputs[0].click();await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.type('.75');await page.keyboard.press('Enter');
 check(await page.evaluate(()=>__engine.entities.get(__clothId).getComponent('cloth').props.anchors[0].uv[0]===.75),'UV input commits grid point');
 await inputs[2].click();await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.type('2');await page.keyboard.press('Enter');
 check(await page.evaluate(()=>__engine.entities.get(__clothId).getComponent('cloth').props.anchors[0].offset[0]===2),'offset input commits target local offset');
 await page.click('[data-cloth-anchor="0"] button[title="Remove anchor"]');
 check(await page.evaluate(()=>__engine.entities.get(__clothId).getComponent('cloth').props.anchors.length===0),'remove anchor commits');
 await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');
 await page.waitForSelector('[data-cloth-anchor="0"]');check(await page.evaluate(()=>__engine.entities.get(__clothId).getComponent('cloth').props.anchors[0].offset[0]===2),'real CtrlZ restores reference and settings');
 await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('KeyZ');await page.keyboard.up('Shift');await page.keyboard.up('Control');
 await page.waitForFunction(()=>!document.querySelector('[data-cloth-anchor="0"]'));check(true,'real redo removes again');
 check(!errors.length,JSON.stringify(errors));console.log('CLOTH-ANCHOR-UI PASS');
}finally{await browser.close();}

