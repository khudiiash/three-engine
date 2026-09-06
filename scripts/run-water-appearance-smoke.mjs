import puppeteer from 'puppeteer-core';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
const profile=await mkdtemp(join(tmpdir(),'water-appearance-'));
let browser;
try {
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:'new',userDataDir:profile,args:['--enable-unsafe-webgpu','--enable-features=WebGPU','--no-sandbox']});
 const page=await browser.newPage(),errors=[];await page.setViewport({width:960,height:720});
 page.on('console',m=>{console.log(m.text());if(m.type()==='error')errors.push(m.text());});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.argv[2]??'http://127.0.0.1:5307/scripts/water-appearance-smoke.html');
 await page.waitForFunction(()=>globalThis.__GI_SMOKE_RESULT__,{timeout:100000});
 const result=await page.evaluate(()=>__GI_SMOKE_RESULT__);
 await mkdir('artifacts',{recursive:true});await (await page.$('canvas')).screenshot({path:'artifacts/water-appearance.png'});
 if(!result.pass||errors.length)throw new Error(JSON.stringify({result,errors}));
}finally{
 await browser?.close();
 if(dirname(resolve(profile))!==resolve(tmpdir())||!basename(profile).startsWith('water-appearance-'))throw new Error('Unexpected profile cleanup path');
 await rm(profile,{recursive:true,force:true});
}
