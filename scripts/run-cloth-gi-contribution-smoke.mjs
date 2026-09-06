import puppeteer from 'puppeteer-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
const profile = await mkdtemp(join(tmpdir(), 'cloth-gi-contribution-smoke-'));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: profile, args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox'] });
  const page = await browser.newPage(); await page.setViewport({width:980,height:740}); const errors = [];
  page.on('console', message => { if (message.type() === 'error') { if (errors.length < 5) console.log(message.text()); errors.push(message.text()); } else if (errors.length < 5 || message.text().startsWith('USER-CONCAVE') || message.text().startsWith('VFX-CONCAVE')) console.log(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:5307/scripts/cloth-gi-contribution-smoke.html');
  await page.waitForFunction(() => globalThis.__GI_SMOKE_RESULT__, { timeout: 100000 });
  const result = await page.evaluate(() => globalThis.__GI_SMOKE_RESULT__);
  if(await page.$('#comparison'))await (await page.$('#comparison')).screenshot({path:'artifacts/cloth-gi-indirect-comparison-8x.png'});


  if (!result.pass || errors.length) throw new Error(JSON.stringify({ result, errors:errors.slice(0,5),errorCount:errors.length }));
} finally {
  await browser?.close();
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('cloth-gi-contribution-smoke-')) throw new Error('Unexpected browser profile directory');
  await rm(profile, { recursive: true, force: true });
}
