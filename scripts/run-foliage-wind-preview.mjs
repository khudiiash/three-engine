import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const base=process.argv[2]??'http://127.0.0.1:5335';
const output='artifacts/foliage/wind';fs.mkdirSync(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:fs.mkdtempSync(path.join(os.tmpdir(),'engine-wind-preview-')),headless:'new',args:['--enable-unsafe-webgpu','--enable-features=WebGPU','--no-sandbox','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
const errors=[];
try{
  const page=await browser.newPage();await page.setViewport({width:1300,height:724,deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.stack??error.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`${base}/scripts/foliage-wind-preview.html`,{waitUntil:'load',timeout:60000});
  await page.waitForFunction(()=>globalThis.__FOLIAGE_WIND_PREVIEW_READY__||globalThis.__FOLIAGE_WIND_PREVIEW_ERROR__,{timeout:120000});
  const failure=await page.evaluate(()=>globalThis.__FOLIAGE_WIND_PREVIEW_ERROR__);if(failure)throw new Error(failure);
  for(const species of ['grass','wildflowers','oak']){
    await page.evaluate(s=>__FOLIAGE_WIND_PREVIEW__.show(s,'gusty'),species);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const visible=await page.evaluate(()=>[...__FOLIAGE_WIND_PREVIEW__.layers].filter(([,c])=>c.root.visible&&c.entity.object3D.visible).map(([name])=>name));
    if(visible.length!==1||visible[0]!==species)throw new Error(`Preview did not isolate ${species}: ${visible}`);
    await page.screenshot({path:`${output}/${species}.png`});
    const bytes=await page.evaluate(async()=>{
      const stream=document.querySelector('canvas').captureStream(30),chunks=[];
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:7000000});
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();
      await new Promise(resolve=>setTimeout(resolve,4000));__FOLIAGE_WIND_PREVIEW__.setWeather('strong');
      await new Promise(resolve=>setTimeout(resolve,4000));recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
      return [...new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer())];
    });
    fs.writeFileSync(`${output}/${species}.webm`,new Uint8Array(bytes));
  }
  fs.writeFileSync(`${output}/result.json`,JSON.stringify({pass:errors.length===0,errors},null,2));
  if(errors.length)throw new Error(JSON.stringify(errors));console.log('FOLIAGE WIND PREVIEW PASS');
}finally{await browser.close();}
