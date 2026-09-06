import puppeteer from 'puppeteer-core';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs `water-look-smoke.html` and writes every frame it captured to disk.
 *
 * A statistic can only answer the question it was built to ask. "The water
 * looks wrong" is not that kind of question, so this runner exists to put the
 * actual pixels somewhere they can be opened.
 *
 *   node scripts/run-water-look.mjs [outDir] [url]
 */
const outDir = process.argv[2] ?? 'artifacts/water-look';
const url = process.argv[3] ?? 'http://127.0.0.1:5307/scripts/water-look-smoke.html';
const profile = await mkdtemp(join(tmpdir(), 'engine-water-look-'));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', userDataDir: profile, protocolTimeout: 600000,
    args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox', '--disable-background-timer-throttling'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (message) => { const t = message.text(); console.log(t); if (/validation|invalid ComputePipeline|exceeds the maximum/i.test(t) && !/clean|no validation/.test(t)) errors.push(t); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__VFX_SMOKE_RESULT__, { timeout: 420000 });
  const result = await page.evaluate(() => globalThis.__VFX_SMOKE_RESULT__);
  await mkdir(outDir, { recursive: true });
  for (const { label, url: data } of result.images ?? []) {
    await writeFile(join(outDir, `${label}.png`), Buffer.from(data.split(',')[1], 'base64'));
    console.log('wrote', join(outDir, `${label}.png`));
  }
  if (!result.pass || errors.length) throw new Error(JSON.stringify({ error: result.error, errors }));
} finally {
  await browser?.close();
  await rm(profile, { recursive: true, force: true });
}
