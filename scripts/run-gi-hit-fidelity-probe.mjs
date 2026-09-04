import puppeteer from 'puppeteer-core';

const endpoint = process.argv[2];
if (!endpoint) throw new Error('usage: node scripts/run-gi-hit-fidelity-probe.mjs <browser-ws-endpoint>');
const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
try {
  const pages = await browser.pages();
  const page = pages.find((p) => /localhost|127\.0\.0\.1/.test(p.url())) || pages[0];
  console.log(JSON.stringify(await page.evaluate(async () => {
    const e = globalThis.__fidelityEngine;
    const gi = e.modules.get('gi').system, v = gi.state.volume;
    const P = await import('/src/modules/gi/srcProbes.js');
    const M = await import('/src/modules/gi/srcMath.js');
    const src = gi.state.screen.srcProbes;
    const [tableData, weightsData, blocksData] = await Promise.all([
      e.renderer.getArrayBufferAsync(src.store.probeTable.value),
      e.renderer.getArrayBufferAsync(src.merge.cornerWeight.value),
      e.renderer.getArrayBufferAsync(src.merge.cornerBlock.value),
    ]);
    const table = new Uint32Array(tableData), weights = new Float32Array(weightsData), blocks = new Uint32Array(blocksData);
    const anchor = src.anchor, near = [];
    for (let cascade = 0; cascade < 3; cascade++) {
      const info = src.store.cascades[cascade];
      for (let i = 0; i < info.probeCapacity; i++) {
        const word = (info.probeBase + i) * P.PROBE_WORDS;
        if (!(table[word + P.PROBE_FLAGS] & P.FLAG_ALIVE)) continue;
        const key = M.unpackProbeKey(table[word + P.PROBE_KEY]);
        const spacing = src.spacing0 * 2 ** (cascade + key.lod);
        const origin = M.latticeOriginFor(...anchor, spacing);
        const pos = M.cellPosition(key.cx, key.cy, key.cz, ...origin, spacing);
        if (!(Math.abs(pos[0] - 2.2) < 1 && pos[1] > 0.4 && pos[1] < 3.3 && Math.abs(pos[2] + 0.5) < 0.45)) continue;
        const block = table[word + P.PROBE_BLOCK];
        const record = src.merge.cornerCascades[cascade].base + block * 8;
        near.push({ cascade, index: info.probeBase + i, key, pos, block,
          weights: [...weights.slice(record, record + 8)], parents: [...blocks.slice(record, record + 8)] });
      }
    }
    return {
      camera: e.camera.position.toArray(), spacing: gi.state.screen.srcProbes.spacing0,
      lodScale: globalThis.__giLod0ReachScale, mode: v.rayHitMode,
      volumeKeys: Object.keys(v), worldKeys: Object.keys(v.world || {}),
      occKeys: Object.keys(v.occupancyField || {}), dynKeys: Object.keys(gi._dynSet || {}),
      anchor, near,
    };
  })));
} finally { await browser.disconnect(); }
