import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const base = process.argv[2] ?? 'http://127.0.0.1:5335';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'foliage-surface-gpu-')), headless: 'new', args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const errors = [];
try {
  const page = await browser.newPage();
  if (process.argv.includes('--old-matrix') || process.argv.includes('--old-impostor-projection') || process.argv.includes('--rigid-grass')) {
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const oldMatrix = process.argv.includes('--old-matrix') && request.url().includes('/src/modules/foliage/foliageWind.js');
      const oldProjection = process.argv.includes('--old-impostor-projection') && request.url().includes('/src/engine/lod/impostorMaterial.js');
      const rigidGrass = process.argv.includes('--rigid-grass') && request.url().includes('/src/modules/foliage/foliageWind.js');
      if (!oldMatrix && !oldProjection && !rigidGrass) return request.continue();
      const response = await fetch(request.url());
      let source = await response.text();
      if (oldMatrix) source = source
        .replace('THREE.TSL.OnBeforeObjectUpdate(createFoliageMatrixSync(source, builder.bufferAttributes));', 'THREE.TSL.OnObjectUpdate(() => { if (interleaved.version !== source.version) interleaved.version = source.version; });')
        .replace('const bufferFn = source.usage === THREE.DynamicDrawUsage ? instancedDynamicBufferAttribute : instancedBufferAttribute;', 'const bufferFn = instancedBufferAttribute;');
      if (oldProjection) source = source.replace('const toWorld = atlasPosition.sub(center).toVar();', 'const toWorld = positionWorld.sub(center).toVar();');
      if (rigidGrass) source = source.replace('result.assign(animateArcMeadow(uniforms, matrix, blade, curve, p, field));', 'result.assign(bendFoliageBlade(uniforms, p, root, up, blade.w));');
      await request.respond({ status: response.status, contentType: 'text/javascript', body: source });
    });
  }
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  page.on('console', message => { const line = message.text(); console.log(line); if (message.type() === 'error') errors.push(line); });
  await page.goto(`${base.replace(/\/$/, '')}/scripts/foliage-surface-smoke.html${process.argv.includes('--async-compute') ? '?asyncCompute=1' : ''}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__FOLIAGE_SURFACE_RESULT__ !== undefined, { timeout: 150000 });
  const result = await page.evaluate(() => globalThis.__FOLIAGE_SURFACE_RESULT__);
  const strip = await page.evaluate(() => globalThis.__FOLIAGE_WIND_FILMSTRIP__);
  const farStrip = await page.evaluate(() => globalThis.__FOLIAGE_FAR_WIND_FILMSTRIP__);
  fs.mkdirSync('artifacts/foliage', { recursive: true });
  const suffix = process.argv.includes('--old-matrix') ? '-old-matrix' : process.argv.includes('--old-impostor-projection') ? '-old-impostor-projection' : process.argv.includes('--rigid-grass') ? '-rigid-grass' : '';
  fs.writeFileSync(`artifacts/foliage/surface-gpu-result${suffix}.json`, JSON.stringify({ ...result, errors }, null, 2));
  if (strip) fs.writeFileSync('artifacts/foliage/wind-filmstrip.png', Buffer.from(strip.split(',')[1], 'base64'));
  if (farStrip) fs.writeFileSync('artifacts/foliage/far-wind-filmstrip.png', Buffer.from(farStrip.split(',')[1], 'base64'));
  if (!result?.pass || errors.length) throw new Error(JSON.stringify({ result, errors }, null, 2));
} finally { await browser.close(); }
