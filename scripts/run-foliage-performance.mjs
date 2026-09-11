import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const base=process.argv[2]??'http://127.0.0.1:5335';
const arms=(process.env.FOLIAGE_ARMS??'legacy,current').split(',');
const sourceFiles=['src/modules/foliage/FoliageComponent.js','src/modules/foliage/foliageLod.js','src/modules/foliage/foliageGeometry.js','src/modules/foliage/treeGrowth.js','src/modules/foliage/foliageWind.js','src/modules/foliage/foliageMaterial.js','src/modules/foliage/foliageSurfaceTexture.js','src/modules/foliage/foliageWarmup.js','src/engine/lod/impostorBake.js','src/engine/lod/impostorMaterial.js','src/engine/vfx/clothWind.js','scripts/foliage-performance-fixture.json'];
const addSources=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=`${directory}/${entry.name}`;if(entry.isDirectory())addSources(file);else if(entry.name.endsWith('.js'))sourceFiles.push(file);}};
addSources('src/modules/gi');
sourceFiles.push('src/engine/Engine.js','src/engine/StatsSystem.js','src/engine/frameGovernor.js','src/engine/asyncRenderPipelines.js','src/engine/freezeLedger.js','src/engine/components/LightComponent.js','src/engine/pcssShadowFilter.js','src/engine/editorLayers.js');
sourceFiles.sort();
const sourceHash=()=>createHash('sha256').update(sourceFiles.map(file=>`${file}\n${fs.readFileSync(file,'utf8')}`).join('\n')).digest('hex');
const snapshotHash=sourceHash();
const fileHash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const snapshotFiles=Object.fromEntries(sourceFiles.map(file=>[file,fileHash(file)]));
fs.mkdirSync('artifacts/foliage',{recursive:true});
// Isolate the runtime change with IDENTICAL current plant shapes and shaders.
// This arm recreates the former 24 m cells, sphere-distance LOD and authored-only
// thresholds; it does not claim to be the original tree/material implementation.
let legacy=fs.readFileSync('src/modules/foliage/FoliageComponent.js','utf8')
 .replaceAll('"../../engine/','"/src/engine/')
 .replaceAll('"./foliage','"/src/modules/foliage/foliage')
 .replace('const cellSize = foliageCellSize(this.props);','const cellSize = this.props.chunkSize;')
 .replace('const distance = chunk.detailBounds.distanceToPoint(cameraPosition);','const distance = Math.max(0, cameraPosition.distanceTo(chunk.sphere.center) - chunk.sphere.radius);')
 .replace('foliageDetailDistances(this.props, projectionScale, chunk.plantSize, this._lodProps);','Object.assign(this._lodProps, this.props);')
 .replace('  _buildRenderBatches() {', '  _buildRenderBatches() { return;')
 .replace('  _commitBatches() {', '  _commitBatches() { this._batchDirty=false; for(const chunk of this.chunks) for(let i=0;i<chunk.meshes.length;i++){const mesh=chunk.meshes[i];mesh.visible=i===chunk.level;this.root.add(mesh);} return;')
 .replace('this.renderMeshes.reduce((sum, mesh) => sum + (mesh?.visible ? 1 : 0), 0)', 'this.chunks.filter(chunk => chunk.level < 3).length');
fs.writeFileSync('artifacts/foliage/FoliageComponent-legacy.js',legacy);
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:fs.mkdtempSync(path.join(os.tmpdir(),'engine-foliage-performance-')),headless:'new',args:['--enable-unsafe-webgpu','--enable-features=WebGPU','--no-sandbox','--disable-frame-rate-limit','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
try{
 for(const arm of arms){
  const page=await browser.newPage(),errors=[];
  await page.setViewport({width:1300,height:724,deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(e.stack??e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(/FOLIAGE|validation|exceeds the maximum/i.test(m.text()))console.log(m.text());});
  await page.goto(`${base}/scripts/foliage-performance.html?arm=${arm}${process.env.FOLIAGE_GI==='1'?'&gi=1':''}${process.env.FOLIAGE_CONTRIBUTION==='1'?'&contribution=1':''}${process.env.FOLIAGE_SHADOW_COMPARE==='1'?'&shadowCompare=1':''}${process.env.FOLIAGE_UPLOAD_DIAG==='1'?'&uploads=1':''}`,{waitUntil:'load',timeout:60000});
  await page.waitForFunction(()=>globalThis.__FOLIAGE_PERFORMANCE_RESULT__||globalThis.__FOLIAGE_PERFORMANCE_ERROR__,{timeout:180000});
  const report=await page.evaluate(()=>globalThis.__FOLIAGE_PERFORMANCE_RESULT__??{error:globalThis.__FOLIAGE_PERFORMANCE_ERROR__});
  report.consoleErrors=errors;
  report.sourceHash=snapshotHash;
  report.sourceFiles=sourceFiles;
  report.sourceChangedFiles=sourceFiles.filter(file=>fileHash(file)!==snapshotFiles[file]);
  const tag=arm+(process.env.FOLIAGE_GI==='1'?'-gi':'')+(process.env.FOLIAGE_CONTRIBUTION==='1'?'-contribution':'')+(process.env.FOLIAGE_SHADOW_COMPARE==='1'?'-shadow-comparison':'')+(process.env.FOLIAGE_UPLOAD_DIAG==='1'?'-uploads':'');
  fs.writeFileSync(`artifacts/foliage/performance-isolated-${tag}.json`,JSON.stringify(report,null,2));
  if(report.sourceChangedFiles.length)throw new Error(`Source changed while measuring; invalid timing saved for diagnosis only: ${report.sourceChangedFiles.join(', ')}`);
  await page.screenshot({path:`artifacts/foliage/performance-${tag}.png`});
  if(report.error||errors.length)throw new Error(JSON.stringify(report,null,2));
  console.log(JSON.stringify({arm,results:report.results.map(r=>({label:r.label,fps:r.presentedFps,p95:r.frameP95Ms,cpuMs:r.cpu.totalMs,gpu:r.gpu,drawCalls:r.drawCalls,triangles:r.triangles,layers:r.layers}))}));
  await page.close();
 }
}finally{await browser.close();}
