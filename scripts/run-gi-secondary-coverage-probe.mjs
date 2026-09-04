// Read-only diagnostic of the actual hit list and populated probe lattice.
// Connect to a stopped run-gi-level-fidelity browser; never advances a frame.
import puppeteer from "puppeteer-core";

const endpoint = process.argv[2];
if (!endpoint) throw new Error("Pass the frozen fidelity browser's WebSocket endpoint");
const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
try {
  const pages = await browser.pages();
  let page;
  for (const candidate of pages) {
    if (await candidate.evaluate(() => !!globalThis.__fidelityEngine)) { page = candidate; break; }
  }
  if (!page) throw new Error("No fidelity page found");
  const report = await page.evaluate(async () => {
    const engine = globalThis.__fidelityEngine;
    const src = engine.modules.get("gi").system.state.screen.srcProbes;
    const renderer = engine.renderer;
    const [P, D, C, M, THREE] = await Promise.all([
      import("/src/modules/gi/srcProbes.js"),
      import("/src/modules/gi/srcDeposit.js"),
      import("/src/modules/gi/srcConfig.js"),
      import("/src/modules/gi/srcMath.js"),
      import("/node_modules/three/build/three.module.js"),
    ]);
    const table = new Uint32Array(await renderer.getArrayBufferAsync(src.store.probeTable.value));
    const scratch = new Uint32Array(await renderer.getArrayBufferAsync(src.binStore.scratch.value));
    const floats = new Float32Array(scratch.buffer);
    const maps = src.store.cascades.map((cascade) => {
      const map = new Map();
      for (let i = 0; i < cascade.probeCapacity; i++) {
        const w = (cascade.probeBase + i) * P.PROBE_WORDS;
        if ((table[w + P.PROBE_FLAGS] & P.FLAG_ALIVE) && table[w + P.PROBE_BLOCK] !== P.SLOT_EMPTY) {
          map.set(table[w + P.PROBE_KEY], table[w + P.PROBE_BLOCK]);
        }
      }
      return map;
    });
    const camera = engine.camera.position.toArray(), anchor = src.anchor;
    const worldKeys = M.worldKeysEnabled();
    const bias = M.gatherNormalBias();
    const histogram = Array.from({ length: 17 }, () => 0);
    const groups = {};
    const projection = new THREE.Matrix4().multiplyMatrices(engine.camera.projectionMatrix, engine.camera.matrixWorldInverse);
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    let zeroRho = 0, count = scratch[src.binStore.hitListBase], withFine = 0, coarseOnly = 0;
    const scalar = (value) => typeof value === "number" ? value : value.value;
    const spacing0 = scalar(src.spacing0);
    for (let i = 0; i < count; i++) {
      const w = src.binStore.hitListBase + 1 + i * D.SEC_HIT_WORDS;
      const pos = Array.from(floats.subarray(w + D.SEC_P, w + D.SEC_P + 3));
      const normal = Array.from(floats.subarray(w + D.SEC_N, w + D.SEC_N + 3));
      const rho = Array.from(floats.subarray(w + D.SEC_RHO, w + D.SEC_RHO + 3));
      const point = pos.map((v, axis) => v + bias * normal[axis]);
      const lod = C.lodAtDistance(C.chebyshev(...point, ...camera), spacing0);
      const blend = C.lodBlend(lod), base = Math.floor(lod);
      const shells = [[base, 1 - blend]];
      if (blend > 0 && base + 1 < C.MAX_LODS) shells.push([base + 1, blend]);
      const findCorners = (cascade) => {
        let n = 0;
        for (const [l, sw] of shells) {
          if (!(sw > 0)) continue;
          const spacing = C.probeSpacing(cascade, l, spacing0);
          const origin = M.latticeOriginFor(...anchor, spacing);
          const shift = worldKeys ? M.latticeOriginCellFor(...anchor, spacing) : [0, 0, 0];
          for (const corner of M.trilinearCorners(...point, ...origin, spacing)) {
            if (corner.weight <= 0) continue;
            const key = M.packProbeKey(l, 0, corner.cx + shift[0], corner.cy + shift[1], corner.cz + shift[2]);
            if (maps[cascade].has(key)) n++;
          }
        }
        return n;
      };
      const fine = findCorners(0), coarse = findCorners(1);
      histogram[fine]++;
      if (fine) withFine++;
      if (!fine && coarse) coarseOnly++;
      const black = Math.max(...rho) < 1e-5;
      if (black) zeroRho++;
      const ndc = new THREE.Vector3(...pos).applyMatrix4(projection);
      // Frustum membership alone does not mean the point is unoccluded.
      const inFrustum = Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z >= 0 && ndc.z <= 1;
      const axis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
      const key = `${axis}:${Math.sign(normal[axis])} plane=${(Math.round(pos[axis] * 20) / 20).toFixed(2)}`;
      const row = groups[key] ??= { hits: 0, emptyFine: 0, coarseOnly: 0, zeroRho: 0, inFrustum: 0, meanRho: 0, examples: [] };
      row.hits++;
      row.emptyFine += fine ? 0 : 1;
      row.coarseOnly += !fine && coarse ? 1 : 0;
      row.zeroRho += black ? 1 : 0;
      row.inFrustum += inFrustum ? 1 : 0;
      row.meanRho += rho[0] * 0.2126 + rho[1] * 0.7152 + rho[2] * 0.0722;
      if (!fine && row.examples.length < 2) row.examples.push({ pos, normal, rho });
      for (let axis = 0; axis < 3; axis++) {
        bounds.min[axis] = Math.min(bounds.min[axis], pos[axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], pos[axis]);
      }
    }
    for (const row of Object.values(groups)) row.meanRho /= row.hits;
    const materials = [];
    engine.scene.traverse((object) => {
      if (!object.isMesh) return;
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (!(material?.metalness > 0.5)) continue;
        materials.push({ object: object.name, material: material.name, metalness: material.metalness, roughness: material.roughness, color: material.color?.toArray(), bounds: new THREE.Box3().setFromObject(object).min.toArray().concat(new THREE.Box3().setFromObject(object).max.toArray()) });
      }
    });
    return {
      count, spacing0, anchor, camera, worldKeys, bias, bounds,
      populated: maps.map((map) => map.size), fineHitFraction: withFine / count,
      coarseOnlyFraction: coarseOnly / count, zeroRhoFraction: zeroRho / count, histogram,
      groups: Object.entries(groups).sort((a, b) => b[1].hits - a[1].hits).slice(0, 28), materials,
    };
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.disconnect();
}
