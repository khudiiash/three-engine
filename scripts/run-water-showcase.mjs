import puppeteer from 'puppeteer-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
const profile = await mkdtemp(join(tmpdir(), 'water-showcase-'));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: profile, args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox'] });
  const page = await browser.newPage(); await page.setViewport({width:980,height:740}); const errors = [];
  page.on('console', message => { if (message.type() === 'error') { if (errors.length < 5) console.log(message.text()); errors.push(message.text()); } else if (errors.length < 5 || message.text().startsWith('USER-CONCAVE') || message.text().startsWith('VFX-CONCAVE')) console.log(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:5307/scripts/water-showcase.html');
  await page.waitForFunction(() => globalThis.__WATER_SHOWCASE_RESULT__, { timeout: 100000 });
  const result = await page.evaluate(() => globalThis.__WATER_SHOWCASE_RESULT__);
  const view = await page.$('#view');
  for (const [index, name] of [[0,'water-showcase.png'],[1,'water-showcase-waterline.png'],[2,'water-showcase-underwater.png']]) {
    await page.evaluate((i)=>globalThis.__waterShowcasePose(i), index);
    await view.screenshot({ path: `artifacts/${name}` });
    console.log('captured', name);
  }


  if (!result.pass || errors.length) throw new Error(JSON.stringify({ result, errors:errors.slice(0,5),errorCount:errors.length }));
} finally {
  await browser?.close();
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('water-showcase-')) throw new Error('Unexpected browser profile directory');
  await rm(profile, { recursive: true, force: true });
}
