import puppeteer from 'puppeteer-core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', userDataDir: await mkdtemp(join(tmpdir(), 'gi-priority-packets-')),
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox'],
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(m.text()));
  page.on('pageerror', (e) => console.error(e.stack || e.message));
  const base = (process.argv[2] || 'http://127.0.0.1:5287').replace(/\/$/, '');
  await page.goto(`${base}/scripts/gi-src-priority-packets.html`);
  await page.waitForFunction(() => globalThis.__GI_PRIORITY_PACKETS_RESULT__ !== undefined, { timeout: 60000 });
  const result = await page.evaluate(() => globalThis.__GI_PRIORITY_PACKETS_RESULT__);
  console.log(JSON.stringify(result));
  process.exitCode = result.pass ? 0 : 1;
} finally { await browser.close(); }
