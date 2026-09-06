import puppeteer from 'puppeteer-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
const profile = await mkdtemp(join(tmpdir(), 'vfx-simulation-smoke-'));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: profile, args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox'] });
  const page = await browser.newPage(); const errors = [];
  page.on('console', message => { console.log(message.text()); if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.argv[2] ?? 'http://localhost:5283/scripts/vfx-simulation-smoke.html');
  await page.waitForFunction(() => globalThis.__VFX_SIMULATION_RESULT__, { timeout: 70000 });
  const result = await page.evaluate(() => globalThis.__VFX_SIMULATION_RESULT__);
  if (!result.pass || errors.length) throw new Error(JSON.stringify({ result, errors }));
} finally {
  await browser?.close();
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('vfx-simulation-smoke-')) throw new Error('Unexpected browser profile directory');
  await rm(profile, { recursive: true, force: true });
}
