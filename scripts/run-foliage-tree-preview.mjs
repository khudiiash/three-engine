import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5335';
const out = 'artifacts/foliage/trees';
fs.mkdirSync(out,{recursive:true});
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir:fs.mkdtempSync(path.join(os.tmpdir(),'engine-tree-preview-')),headless:'new',
  args:['--enable-unsafe-webgpu','--enable-features=WebGPU','--no-sandbox','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],
});
const errors=[];
try {
  const page=await browser.newPage();
  await page.setViewport({width:1300,height:724,deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(e.stack??e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`${base}/scripts/foliage-tree-preview.html`,{waitUntil:'load',timeout:60000});
  await page.waitForFunction(()=>globalThis.__TREE_PREVIEW_READY__||globalThis.__TREE_PREVIEW_ERROR__,{timeout:120000});
  const failure=await page.evaluate(()=>globalThis.__TREE_PREVIEW_ERROR__);
  if(failure)throw new Error(failure);
  const results=[];
  for(const species of ['oak','birch','pine']) {
    for(const [view,lod,turn] of [['full',0,0],['leaves',0,0],['bark',0,0],['full',1,1.2],['full',2,0]]) {
      results.push(await page.evaluate((s,v,l,t)=>globalThis.__TREE_PREVIEW__.show(s,v,l,t),species,view,lod,turn));
      await page.screenshot({path:`${out}/${species}-${view}-${lod}.png`});
    }
  }
  fs.writeFileSync(`${out}/result.json`,JSON.stringify({results,errors},null,2));
  if(errors.length)throw new Error(JSON.stringify(errors));
  console.log('FOLIAGE TREE PREVIEW PASS',JSON.stringify(results.map(({species,view,lod,geometry})=>({species,view,lod,triangles:geometry?.map(g=>g.triangles)}))));
} finally {await browser.close();}
