import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5335';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'engine-foliage-gpu-')),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const errors = [];
try {
  const page = await browser.newPage();
  if (process.env.FOLIAGE_NO_WARMUP === '1') {
    await page.setRequestInterception(true);
    page.on('request', async request => {
      if (!request.url().includes('/src/modules/foliage/foliageWarmup.js')) return request.continue();
      const response = await fetch(request.url());
      const source = (await response.text()).replace('export function updateFoliageWarmup(component) {', 'export function updateFoliageWarmup(component) { return;');
      await request.respond({status: 200, contentType: 'application/javascript', body: source});
    });
  }
  await page.setViewport({ width: 960, height: 640, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  page.on('console', message => {
    const line = message.text();
    if (/FOLIAGE|validation|exceeds the maximum|invalid.*pipeline/i.test(line)) console.log(line);
    if (message.type() === 'error') errors.push(line);
  });
  await page.goto(`${base.replace(/\/$/, '')}/scripts/foliage-smoke.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__FOLIAGE_SMOKE_RESULT__ !== undefined, { timeout: 180000 });
  const result = await page.evaluate(() => globalThis.__FOLIAGE_SMOKE_RESULT__);
  fs.mkdirSync('artifacts/foliage', { recursive: true });
  await page.screenshot({ path: 'artifacts/foliage/foliage-smoke.png' });
  fs.writeFileSync('artifacts/foliage/gpu-result.json', JSON.stringify({ ...result, errors }, null, 2));
  if (!result?.pass || errors.length) throw new Error(JSON.stringify({ result, errors }, null, 2));
  console.log('FOLIAGE-SMOKE PASS', JSON.stringify(result));
} finally {
  await browser.close();
}
