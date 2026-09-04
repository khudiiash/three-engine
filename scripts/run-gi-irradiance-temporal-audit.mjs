import puppeteer from 'puppeteer-core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userDataDir = await mkdtemp(join(tmpdir(), 'gi-irr-audit-'));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', userDataDir,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(m.text()));
  page.on('pageerror', (e) => console.error(e.stack || e.message));
  const target = process.argv[2] || 'http://127.0.0.1:5287';
  await page.goto(target.endsWith('.html') ? target : `${target.replace(/\/$/, '')}/scripts/gi-irradiance-temporal-audit.html`);
  await page.waitForFunction(() => globalThis.__GI_IRR_AUDIT_RESULT__ !== undefined, { timeout: 60000 });
  const result = await page.evaluate(() => globalThis.__GI_IRR_AUDIT_RESULT__);
  const shaders = await page.evaluate(() => globalThis.__GI_IRR_AUDIT_SHADERS__);
  if (process.argv[3] && shaders) {
    for (const [name, wgsl] of Object.entries(shaders)) await writeFile(join(process.argv[3], `${name}.wgsl`), wgsl);
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.pass ? 0 : 1;
} finally {
  await browser.close();
}
