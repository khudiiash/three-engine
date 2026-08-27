// ⭐⭐ §19 STAGE 4.0 — DOES GI2 NEED LIGHT-TREE NEE AT HITS? (audits §N.3 R1)
//
//   node scripts/run-gi2-lighttree-decide.mjs http://127.0.0.1:5202/
//
// `gi2System.js` destructures `lightTree` and never reads it. The census left
// the decision to a measurement: GI2 has FOUR NEE emitter slots and Bistro has
// ~95 emitter candidates, so ~91 of them can only reach the world through the
// PALETTE'S EMISSIVE AT HITS — `shadeHit` returns `albedo/π · E + pal.w`, where
// `pal.w` is the material class's emissive. Either that stochastic path carries
// them, and the light-tree plumbing is dead weight, or it does not, and hits
// need a tree-sampled NEE ray of their own.
//
// ⭐ THE A/B IS THE PALETTE, NOT THE MESH. The first attempt hid the emitter and
// rebuilt: 45 s apart, across a full re-mint, the 9 m CONTROL crop moved 0.052
// while the receiver moved 0.0097 — the frame-to-frame noise was five times the
// signal, which measures the rebuild and not the emitter. Zeroing every
// palette entry's `w` is the same question asked in ONE SECOND, with the same
// camera, the same exposure, the same soup and the same probes: it switches off
// exactly the term under test and nothing else.
//
// ⚠ AND THE PALETTE DOES NOT KNOW ABOUT SLOTS. `pal.w` is per material CLASS;
// a hit on a seated emitter and a hit on the 91st one read the same field by
// the same code. So a measurable drop here IS the answer for the out-of-slot
// population — there is no mechanism by which it could carry one and not the
// other. The seated four are separately checked to be in a different class or
// not, and reported either way.
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 8000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  protocolTimeout: 900000,
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
page.on("pageerror", (e) => {
  const msg = e.stack ?? e.message ?? String(e);
  if (!/save_scene|esbuild|transpile/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 180)}`);
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__engine = mod.engine;
});
const call = (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });

const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`scene.open failed: ${opened.error}`); await browser.close(); process.exit(1); }
await wait(35000);

// ── the subject: the brightest emitter the four NEE slots did NOT take ──────
const pick = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const sys = engine.modules?.get("gi")?.system;
  const gather = sys?.state?.screen?.gi2?.gather ?? null;
  const cands = (sys?._emitterCands ?? []).filter((c) => c?.mesh);
  const seated = new Set((sys?._promotedEmitterMeshes ?? []).filter(Boolean));
  const outs = cands.filter((c) => !seated.has(c.mesh))
    .map((c) => ({ c, lum: (c.r + c.g + c.b) / 3 }))
    .sort((a, b) => b.lum - a.lum);
  if (!outs.length || !gather) return { cands: cands.length, seated: seated.size, outOfSlot: outs.length, name: null };
  const mesh = outs[0].c.mesh;
  mesh.updateWorldMatrix(true, false);
  mesh.geometry?.computeBoundingBox?.();
  const bb = mesh.geometry?.boundingBox;
  const c = bb ? [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2] : [0, 0, 0];
  const e = mesh.matrixWorld.elements;
  const w = [
    e[0] * c[0] + e[4] * c[1] + e[8] * c[2] + e[12],
    e[1] * c[0] + e[5] * c[1] + e[9] * c[2] + e[13],
    e[2] * c[0] + e[6] * c[1] + e[10] * c[2] + e[14],
  ];
  globalThis.__pal = gather.palette;
  return {
    cands: cands.length,
    seated: seated.size,
    outOfSlot: outs.length,
    name: mesh.name || "(unnamed)",
    lum: outs[0].lum,
    world: w,
    // The palette as it stands: which classes carry emission at all.
    palette: gather.palette.map((v, i) => ({ i, a: [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)], e: +v.w.toFixed(4) })),
    // Receiver 1.2 m below the emitter; control the same distance below a
    // point 6 m along +x, i.e. the same kind of surface, no emitter above it.
    receiver: [w[0], w[1] - 1.2, w[2]],
    eye: [w[0] + 2.6, w[1] - 0.15, w[2] + 2.6],
    look: [w[0], w[1] - 1.2, w[2]],
  };
});
if (!pick.name) {
  console.log(`no out-of-slot emitter to test (${pick.cands} candidates, ${pick.seated} seated)`);
  await browser.close();
  process.exit(1);
}
console.log(`${pick.cands} emitter candidates, ${pick.seated} seated in the four NEE slots, ${pick.outOfSlot} out of slot.`);
console.log(`subject: "${pick.name}" radiance ${pick.lum.toFixed(2)} at ${pick.world.map((v) => v.toFixed(1))}`);
const emissiveClasses = pick.palette.filter((p) => p.e > 0);
console.log(`palette: ${pick.palette.length} classes, ${emissiveClasses.length} with emission ` +
  `[${emissiveClasses.map((p) => `#${p.i}=${p.e}`).join(" ")}]`);

await call("viewport.setCamera", { position: pick.eye, target: pick.look });
await wait(SETTLE);

const sample = async (points) => {
  const meta = await page.evaluate(({ points }) => {
    const cam = globalThis.__engine.camera;
    cam.updateMatrixWorld(true);
    let best = null; let area = 0;
    for (const c of document.querySelectorAll("canvas")) {
      const b = c.getBoundingClientRect();
      if (b.width < 300 || b.height < 200) continue;
      if (b.width * b.height > area) { area = b.width * b.height; best = b; }
    }
    const project = ([x, y, z]) => {
      const e = cam.matrixWorldInverse.elements;
      const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const q = cam.projectionMatrix.elements;
      const cx = q[0] * vx + q[4] * vy + q[8] * vz + q[12];
      const cy = q[1] * vx + q[5] * vy + q[9] * vz + q[13];
      const cw = q[3] * vx + q[7] * vy + q[11] * vz + q[15];
      return [
        Math.round(best.left + ((cx / cw) * 0.5 + 0.5) * best.width),
        Math.round(best.top + (0.5 - (cy / cw) * 0.5) * best.height),
      ];
    };
    return { px: points.map(project), rect: [best.left, best.top, best.width, best.height] };
  }, { points });
  const shot = await page.screenshot({ type: "png" });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const toLin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const patch = ([cx, cy], n = 6) => {
    const vals = [];
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
      const x = Math.min(info.width - 1, Math.max(0, cx + dx));
      const y = Math.min(info.height - 1, Math.max(0, cy + dy));
      const i = (y * info.width + x) * info.channels;
      vals.push(0.2126 * toLin(data[i]) + 0.7152 * toLin(data[i + 1]) + 0.0722 * toLin(data[i + 2]));
    }
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  };
  return { lum: meta.px.map(patch), px: meta.px, rect: meta.rect, shot };
};

const on = await sample([pick.receiver]);
console.log(`viewport canvas ${on.rect.map((v) => Math.round(v)).join(",")}, receiver pixel ${on.px[0]}`);
await sharp(on.shot).toFile("scripts/gi-diag-gi2-tree-on.png");

// ── switch OFF the palette's emission, nothing else ─────────────────────────
const zeroed = await page.evaluate(() => {
  const pal = globalThis.__pal;
  globalThis.__palSaved = pal.map((v) => v.w);
  let n = 0;
  for (const v of pal) { if (v.w > 0) n++; v.w = 0; }
  return n;
});
await wait(SETTLE);
const off = await sample([pick.receiver]);
await sharp(off.shot).toFile("scripts/gi-diag-gi2-tree-off.png");
await page.evaluate(() => {
  const pal = globalThis.__pal;
  globalThis.__palSaved.forEach((w, i) => { pal[i].w = w; });
});
await wait(SETTLE);
const back = await sample([pick.receiver]);

const drop = on.lum[0] - off.lum[0];
const restored = back.lum[0];
console.log(`\nreceiver 1.2 m below "${pick.name}":`);
console.log(`  palette emission ON  ${on.lum[0].toFixed(5)}`);
console.log(`  palette emission OFF ${off.lum[0].toFixed(5)}  (${zeroed} classes zeroed)`);
console.log(`  restored             ${restored.toFixed(5)}`);
console.log(`  carried by emissive-at-hits: ${drop.toFixed(5)} = ${((drop / Math.max(on.lum[0], 1e-6)) * 100).toFixed(1)}% of the lit value`);
console.log(`  reversibility (|restored − ON| / ON): ${(Math.abs(restored - on.lum[0]) / Math.max(on.lum[0], 1e-6) * 100).toFixed(1)}%`);

const checks = [
  ["the receiver is lit at all", on.lum[0] > 0.01],
  ["the palette carries emission", zeroed > 0],
  ["emissive-at-hits delivers measurable light", drop > 0.1 * on.lum[0]],
  // ⭐ THE REVERSIBILITY CHECK IS THE INSTRUMENT'S OWN GATE: if the value does
  // not come back when the palette does, the two arms differed by something
  // other than the palette and the drop measures that instead.
  ["the A/B is reversible", Math.abs(restored - on.lum[0]) < 0.25 * Math.max(on.lum[0], 1e-6)],
];
let failed = 0;
for (const [n, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}: ${n}`); if (!ok) failed++; }
console.log(failed === 0
  ? "\nVERDICT: the cache carries out-of-slot emitters through the palette — light-tree NEE at hits is NOT required."
  : "\nVERDICT: inconclusive or negative — read the numbers above before deciding.");
await browser.close();
process.exit(failed === 0 ? 0 : 1);
