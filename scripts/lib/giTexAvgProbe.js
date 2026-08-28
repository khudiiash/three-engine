// IN-PAGE HALF OF `run-gi-texavg-probe.mjs` — §19 stage 4.3.
//
// It lives in a real module for the reason `gi2StageProbe.js` gives: a bare
// `import("three/webgpu")` inside a `page.evaluate` is never transformed by
// Vite, so the specifier does not resolve; a file under `/scripts/lib/` is
// served by the same dev server as `/src`, gets the same transform, and shares
// the ONE three instance the live renderer is built from (the
// vite-module-duplication trap).
//
// ⭐ THE WHOLE PROBE IS ONE QUESTION: DOES THE BLIT ANSWER ABOUT THE TEXTURE
// IT WAS HANDED? `computeCompressedTextureAverage` renders a fresh
// `NodeMaterial` (`colorNode = texture(tex)`) on a `QuadMesh` into a 32² target
// and reads it back. Every call builds a NEW material with the SAME STRUCTURE
// and a different texture — which is precisely the shape that a cache keyed on
// structure rather than on identity gets wrong. So: hand it colours whose
// answer is known (solid red / green / blue / grey DataTextures), in an order
// that separates "first call wins" from "last call wins", and then hand it the
// real KTX2 maps whose averages must at least be DISTINCT from one another.
//
// ⚠ SYNTHETIC TEXTURES ARE LINEAR ON PURPOSE. The helper's contract is a
// LINEAR mean; a DataTexture tagged `SRGBColorSpace` would be decoded on
// sample and the expected value would stop being the byte value, folding a
// colour-space question into a binding question.
import * as THREE from "three/webgpu";
import { computeCompressedTextureAverage, readTexturePixelsGPU } from "/src/modules/gi/giScreen.js";

const solid = (r, g, b, name) => {
  const d = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(d, 4, 4);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.name = name;
  t.needsUpdate = true;
  return t;
};

/** Every distinct texture the scene's materials actually own, with its slot. */
export function sceneTextures(scene) {
  const out = new Map();
  scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const k of ["map", "emissiveMap", "roughnessMap", "metalnessMap", "normalMap"]) {
        const t = m?.[k];
        if (!t?.isTexture) continue;
        if (!out.has(t.uuid)) {
          out.set(t.uuid, {
            tex: t, slot: k, mat: m.name || m.type,
            name: t.name || t.userData?.src || "(unnamed)",
            compressed: t.isCompressedTexture === true,
            w: t.image?.width ?? 0, h: t.image?.height ?? 0,
          });
        }
      }
    }
  });
  return [...out.values()];
}

/**
 * Run the whole census. `order` interleaves the synthetics so the answer says
 * WHICH call's texture wins when they collide, not merely that they do.
 */
export async function runTexAvgProbe({ renderer, scene, ktxCount = 3, size = 16 }) {
  const syn = [
    { key: "red", tex: solid(255, 0, 0, "probeRed"), want: [1, 0, 0] },
    { key: "blue", tex: solid(0, 0, 255, "probeBlue"), want: [0, 0, 1] },
    { key: "green", tex: solid(0, 255, 0, "probeGreen"), want: [0, 1, 0] },
    { key: "grey", tex: solid(128, 128, 128, "probeGrey"), want: [128 / 255, 128 / 255, 128 / 255] },
    // red AGAIN, last: if the FIRST call's texture is what the binding keeps,
    // this repeat is the only synthetic that comes back right.
    { key: "red2", tex: solid(255, 0, 0, "probeRed2"), want: [1, 0, 0] },
  ];
  const rows = [];
  for (const s of syn) {
    const avg = await computeCompressedTextureAverage(renderer, s.tex);
    rows.push({ kind: "synthetic", key: s.key, want: s.want, avg: avg ? [avg.r, avg.g, avg.b] : null });
  }
  // The same five through the OTHER consumer of the same blit.
  const pixRows = [];
  for (const s of syn) {
    const px = await readTexturePixelsGPU(renderer, s.tex, size);
    let r = 0, g = 0, b = 0, n = 0;
    if (px) for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
    pixRows.push({ key: s.key, mean: n ? [r / n / 255, g / n / 255, b / n / 255] : null });
  }
  for (const s of syn) s.tex.dispose();

  // The real maps. Compressed first (the class the helper exists for), then
  // any texture at all if the scene turns out to hold none.
  const all = sceneTextures(scene);
  const pick = (all.filter((t) => t.compressed).length >= 2
    ? all.filter((t) => t.compressed) : all).slice(0, ktxCount);
  const real = [];
  for (const t of pick) {
    const avg = await computeCompressedTextureAverage(renderer, t.tex);
    real.push({
      name: t.name, slot: t.slot, mat: t.mat, compressed: t.compressed,
      size: `${t.w}×${t.h}`, uuid: t.tex.uuid.slice(0, 8),
      avg: avg ? [avg.r, avg.g, avg.b] : null,
    });
  }
  return {
    rows, pixRows, real,
    counts: { textures: all.length, compressed: all.filter((t) => t.compressed).length },
  };
}

// ══════════════════════════ STEP 2 — WHERE DOES THE GREEN ENTER? ════════════
//
// The colour-probe method, one stage at a time, from the CPU end this time:
//
//   material → `resolveMaterialSurface` → the palette class table → the seats
//
// The FIRST of those that is green is the source. `resolveMaterialSurface` is
// imported rather than re-implemented — a probe that re-derives the thing it is
// auditing can only ever agree with itself.
//
// ⭐ ATTRIBUTION WITHOUT INTERNALS. `textureValueOf` (the node walk that picks
// which texture a material's colour/emissive comes from) is private, so the
// probe does not ask it anything. It computes the GPU average of EVERY map the
// material owns and reports which one the resolved colour actually matches —
// so "the walker picked the roughness map" is a measurement, not a reading.
import { resolveMaterialSurface } from "/src/modules/gi/voxelizeOnce.js";

const chroma = (r, g, b) => {
  const mx = Math.max(r, g, b);
  return mx <= 1e-6 ? 0 : { greenDom: g > 1.8 * Math.max(r, b) && g > 1e-4, mx };
};

export async function runPaletteCensus({ renderer, scene, giSys, gi2, maxMats = 24 }) {
  // ── the class table, as the shaders read it ──────────────────────────────
  const gather = gi2?.gather;
  const pal = (gather?.palette ?? []).map((v) => [v.x, v.y, v.z, v.w]);
  const palEm = (gather?.paletteEmissive ?? []).map((v) => [v.x, v.y, v.z]);
  const classes = pal.map((a, i) => ({
    i, albedo: a.slice(0, 3), mean: a[3], em: palEm[i] ?? [0, 0, 0],
  })).filter((c) => c.albedo.some((v) => v > 1e-5) || c.em.some((v) => v > 1e-5));

  // ── every unique material, resolved through the SAME function GI uses ────
  const mats = new Map();
  scene.traverse((o) => {
    const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of list) {
      if (!m || mats.has(m.uuid)) continue;
      mats.set(m.uuid, { mat: m, mesh: o.name });
    }
  });
  const rows = [];
  for (const { mat, mesh } of mats.values()) {
    let raw = null;
    try { raw = resolveMaterialSurface(mat, mesh); } catch { /* keep going */ }
    if (!raw) continue;
    const c = [raw.color.r, raw.color.g, raw.color.b];
    const e = [raw.emissive.r ?? 0, raw.emissive.g ?? 0, raw.emissive.b ?? 0];
    rows.push({
      name: mat.name || mat.type, mesh, uuid: mat.uuid.slice(0, 8),
      color: c, emissive: e, intensity: raw.emissiveIntensity ?? 1,
      base: [mat.color?.r ?? 1, mat.color?.g ?? 1, mat.color?.b ?? 1],
      maps: {
        map: mat.map?.uuid?.slice(0, 8) ?? null,
        emissiveMap: mat.emissiveMap?.uuid?.slice(0, 8) ?? null,
        roughnessMap: mat.roughnessMap?.uuid?.slice(0, 8) ?? null,
        metalnessMap: mat.metalnessMap?.uuid?.slice(0, 8) ?? null,
        normalMap: mat.normalMap?.uuid?.slice(0, 8) ?? null,
      },
      hasColorNode: !!mat.colorNode, hasEmissiveNode: !!mat.emissiveNode,
      greenColor: chroma(...c).greenDom === true,
      greenEmissive: chroma(...e).greenDom === true,
    });
  }

  // ── attribution: for the green ones, WHICH of their maps averages to that ─
  const suspects = rows.filter((r) => r.greenColor || r.greenEmissive).slice(0, maxMats);
  for (const s of suspects) {
    const mat = [...mats.values()].find((m) => m.mat.uuid.startsWith(s.uuid))?.mat;
    if (!mat) continue;
    s.mapAverages = {};
    for (const k of ["map", "emissiveMap", "roughnessMap", "metalnessMap", "normalMap"]) {
      const t = mat[k];
      if (!t?.isTexture) continue;
      const avg = await computeCompressedTextureAverage(renderer, t);
      s.mapAverages[k] = avg ? [avg.r, avg.g, avg.b] : null;
    }
  }

  // ── the seats ────────────────────────────────────────────────────────────
  const seats = (giSys?.state?.emitterSlots ?? []).map((sl, i) => ({
    i,
    color: [sl.color.value.r, sl.color.value.g, sl.color.value.b],
    reff: sl.reff.value, radius: sl.radius.value,
  }));
  const infos = (giSys?._emitterInfos ?? []).map((inf, i) => {
    const m = inf?.mesh;
    const mat = Array.isArray(m?.material) ? m.material[0] : m?.material;
    return {
      i, mesh: m?.name ?? (inf?.provider ? "(provider)" : "—"),
      mat: mat?.name || mat?.type || "—",
      matEmissive: mat?.emissive ? [mat.emissive.r, mat.emissive.g, mat.emissive.b] : null,
      matIntensity: mat?.emissiveIntensity ?? null,
      emissiveMap: mat?.emissiveMap?.uuid?.slice(0, 8) ?? null,
      hasEmissiveNode: !!mat?.emissiveNode,
    };
  });
  return { classes, rows, suspects, seats, infos, matCount: mats.size };
}

/**
 * ⭐ STEP 2b — THE NODE GRAPH ITSELF, for every material whose RESOLVED
 * emissive is green-dominant while its own `material.emissive` is not.
 *
 * `resolveMaterialSurface` reads `emissiveNode`, and `constantColorOf` folds it
 * with a hand-written walk (`.value`, `op === "*"/"+"`, `.node` wrappers). A
 * walk that mis-reads one node class returns a colour the material never
 * authored, and NOTHING downstream can tell — the number is a plausible
 * radiance. So the graph is printed as a tree: class, `op`, and what `.value`
 * actually is at every node the walk would visit.
 */
export function dumpEmissiveGraphs(scene, giSys, limit = 6) {
  const seatMeshes = new Set((giSys?._promotedEmitterMeshes ?? []).filter(Boolean));
  const walk = (n, d = 0) => {
    if (!n || d > 6) return null;
    const v = n.value;
    let val = null;
    if (v !== undefined && v !== null) {
      if (typeof v === "number") val = { kind: "number", v };
      else if (v.isTexture) val = { kind: "texture", uuid: v.uuid.slice(0, 8), compressed: !!v.isCompressedTexture };
      else if (typeof v === "object") {
        val = {
          kind: v.constructor?.name ?? "object",
          keys: Object.keys(v).slice(0, 6),
          rgb: (typeof v.r === "number") ? [v.r, v.g, v.b] : null,
          xyz: (typeof v.x === "number") ? [v.x, v.y, v.z, v.w] : null,
        };
      }
    }
    return {
      cls: n.constructor?.name ?? "?", op: n.op ?? null, nodeType: n.nodeType ?? null,
      isSplit: !!n.isSplitNode, components: n.components ?? null,
      val,
      a: walk(n.aNode, d + 1), b: walk(n.bNode, d + 1), inner: walk(n.node, d + 1),
    };
  };
  const seen = new Set();
  const out = [];
  scene.traverse((o) => {
    const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of list) {
      if (!m?.emissiveNode || seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      let raw = null;
      try { raw = resolveMaterialSurface(m, o.name); } catch { /* keep going */ }
      const e = raw ? [raw.emissive.r ?? 0, raw.emissive.g ?? 0, raw.emissive.b ?? 0] : [0, 0, 0];
      const mx = Math.max(...e);
      out.push({
        mesh: o.name, mat: m.name || m.type, uuid: m.uuid.slice(0, 8),
        seated: seatMeshes.has(o),
        resolved: e, intensity: raw?.emissiveIntensity ?? 1,
        matEmissive: m.emissive ? [m.emissive.r, m.emissive.g, m.emissive.b] : null,
        matIntensity: m.emissiveIntensity ?? 1,
        pureHue: mx > 1e-4 && e.filter((v) => v > 1e-6).length === 1,
        graph: walk(m.emissiveNode),
      });
    }
  });
  // Pure-hue first (the flood's signature), then seated, then the rest.
  out.sort((a, b) => (b.pureHue - a.pureHue) || (b.seated - a.seated));
  return { total: out.length, rows: out.slice(0, limit) };
}
