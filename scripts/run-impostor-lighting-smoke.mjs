import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const base=process.argv[2]??'http://127.0.0.1:5335';
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:fs.mkdtempSync(path.join(os.tmpdir(),'engine-impostor-lighting-')),headless:'new',args:['--enable-unsafe-webgpu','--enable-features=WebGPU','--no-sandbox']});
const errors=[];
try{
  const page=await browser.newPage();
  const negative=process.argv.find(value=>['--old-bake','--old-normals','--no-padding'].includes(value));
  if(negative){
    await page.setRequestInterception(true);
    page.on('request',async request=>{
      if(!request.url().includes('/src/engine/lod/impostorBake.js'))return request.continue();
      let source=await(await fetch(request.url())).text();
      if(negative==='--old-bake')source=source.replace('Math.PI * settings.ambient','settings.ambient');
      if(negative==='--old-normals')source=source.replace('import { float, normalWorld','import { faceDirection, float, normalWorld').replace('normalWorld.mul(0.5)','normalWorld.mul(faceDirection).mul(0.5)');
      if(negative==='--no-padding')source=source.replace('padAtlasEdges(albedoData, size, tile);','').replace('padAtlasEdges(normalData, size, tile);','');
      await request.respond({status:200,contentType:'application/javascript',body:source});
    });
  }
  page.on('pageerror',error=>errors.push(error.stack??error.message));
  page.on('console',message=>{console.log(message.text());if(message.type()==='error')errors.push(message.text());});
  await page.goto(`${base}/scripts/impostor-lighting-smoke.html`,{waitUntil:'load',timeout:60000});
  await page.waitForFunction(()=>globalThis.__IMPOSTOR_LIGHTING_RESULT__,{timeout:90000});
  const result=await page.evaluate(()=>globalThis.__IMPOSTOR_LIGHTING_RESULT__);
  fs.mkdirSync('artifacts/foliage',{recursive:true});fs.writeFileSync(`artifacts/foliage/impostor-lighting${negative??''}.json`,JSON.stringify({...result,errors},null,2));
  if(!result.pass||errors.length)throw new Error(JSON.stringify(result));
  console.log('IMPOSTOR-LIGHTING PASS');
}finally{await browser.close();}
