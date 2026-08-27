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
// The engine's own palette receipts, in ORDER — "0 with emission" at pick time
// has two very different causes (the BUILD produced none, or a later re-tint
// erased them) and only the sequence tells them apart.
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] soup|palette re-tint|emitter delivery|\[gi\] built /.test(t)) console.log(`  · ${t.slice(0, 260)}`);
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
  // The receiver pick raycasts (see `pick`), and a bare `three` specifier is
  // never rewritten inside an evaluated function — take THREE off the engine's
  // own module so this shares its class identities.
  globalThis.__THREE = (await import("/src/engine/index.js")).THREE;
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
  // ⭐ §19 STAGE 4.0b (audits §O.6.2) — NARROWED TO **ADMITTED** OUT-OF-SLOT
  // CANDIDATES. Since 4.0b the palette encodes the emitter gate's own decision,
  // so an emitter CULLED below the Φ = π·A·L gate carries ZERO BY DESIGN —
  // picking one as the subject would measure the cull working correctly and
  // report it as "emissive-at-hits delivers nothing". The admitted set is the
  // resolver's own answer (`#recordEmitterAdmission`), never re-derived here.
  const admitted = sys?._emitterAdmittedMeshes ?? null;
  const outs = cands.filter((c) => !seated.has(c.mesh) && (!admitted || admitted.has(c.mesh)))
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
  // ⭐ §19 STAGE 4.0b — THE EMISSIVE IS AN RGB TABLE NOW (`palEmU`), and it is
  // what `shadeHit` reads. `gather.palette[i].w` is kept in step as the class
  // MEAN, for printing; zeroing it alone would no longer switch anything off,
  // which is exactly the kind of A/B that measures nothing and passes.
  globalThis.__palEm = gather.paletteEmissive ?? null;
  // ── WHICH CLASS IS THE SUBJECT'S, AND WHAT TIER IS EVERY EMISSIVE CLASS ──
  //
  // The whole §O fix is per-TIER: seated → 0 (slot NEE delivers it), admitted
  // → its resolved L_e, culled → 0. A census that only counts "N classes emit"
  // cannot see a tier mistake, so each emissive class is labelled with the
  // tiers of the placements that landed in it.
  const gi2 = sys?.state?.screen?.gi2;
  const assign = gi2?.paletteAssign;
  const byKey = sys?._gi2PaletteMeshByKey;
  const subjectClasses = [];
  const classTiers = new Map();
  if (assign && byKey) {
    for (let i = 0; i < assign.keys.length; i++) {
      const rec = byKey.get(assign.keys[i]);
      const m = rec?.mesh;
      if (!m) continue;
      const cls = assign.classOf[i];
      if (m === mesh && !subjectClasses.includes(cls)) subjectClasses.push(cls);
      const tier = seated.has(m) ? "seated" : (admitted && !admitted.has(m) && sys._emitterCandidateMeshes?.has(m)) ? "culled" : "other";
      const t = classTiers.get(cls) ?? { seated: 0, culled: 0, other: 0 };
      t[tier]++;
      classTiers.set(cls, t);
    }
  }
  return {
    cands: cands.length,
    seated: seated.size,
    outOfSlot: outs.length,
    name: mesh.name || "(unnamed)",
    lum: outs[0].lum,
    world: w,
    subjectClasses,
    emitterBand: assign?.emitterClasses ?? [],
    // The palette as it stands: which classes carry emission at all, in RGB,
    // with the tier mix of the placements that landed in each.
    palette: gather.palette.map((v, i) => {
      const em = gather.paletteEmissive?.[i];
      const t = classTiers.get(i);
      return {
        i,
        a: [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)],
        e: +v.w.toFixed(4),
        rgb: em ? [+em.x.toFixed(3), +em.y.toFixed(3), +em.z.toFixed(3)] : null,
        tiers: t ? `${t.seated}s/${t.other}a/${t.culled}c` : "",
      };
    }),
    // ⭐ THE RECEIVER IS A POINT ON A REAL SURFACE, FOUND BY RAYCAST — NOT
    // "1.2 m below the lamp".
    //
    // The fixed drop was written for a rig whose floor was 1.2 m under the
    // emitter. On Bistro the subject is a lamp 4.1 m up over a street, so the
    // point landed in OPEN AIR and the crop measured the sky: `palette emission
    // ON 0.00436`, i.e. black, and both halves of the gate failed on a build
    // whose palette was demonstrably carrying eight emissive classes.
    // [[probe-blind-statistics]] — the instrument could not see its subject.
    // A downward raycast puts it on whatever is actually under the lamp, at any
    // scale, and reports the drop it found so a reader can see it happened.
    ...(() => {
      const T = globalThis.__THREE;
      const down = new T.Vector3(0, -1, 0);
      const origin = new T.Vector3(w[0], w[1] - 0.05, w[2]);
      const rc = new T.Raycaster(origin, down, 0.05, 60);
      // The whole scene, minus GI's own debug helpers and anything invisible.
      rc.layers.enableAll();
      // ⚠ `engine.scene` is not enough on a MERGED scene — `staticMerging`
      // hides the authored meshes (`visible = false`) and draws proxies, so the
      // raycast walks a tree of invisible originals and returns nothing.
      // Collect the DRAWABLE meshes and cast against those.
      const targets = [];
      engine.scene.traverse((o) => { if (o.isMesh && o.visible !== false && !o.userData?.__giDebug) targets.push(o); });
      const hits = rc.intersectObjects(targets, false);
      const p = hits[0]?.point;
      const rec = p ? [p.x, p.y + 0.03, p.z] : [w[0], w[1] - 1.2, w[2]];
      return {
        receiver: rec,
        receiverDrop: p ? +(w[1] - p.y).toFixed(2) : null,
        // Close enough that the lamp's own footprint fills the crop, high
        // enough to look down at it.
        eye: [rec[0] + 1.6, rec[1] + 1.1, rec[2] + 1.6],
        look: rec,
      };
    })(),
  };
});
if (!pick.name) {
  console.log(`no out-of-slot emitter to test (${pick.cands} candidates, ${pick.seated} seated)`);
  await browser.close();
  process.exit(1);
}
console.log(`${pick.cands} emitter candidates, ${pick.seated} seated in the four NEE slots, ` +
  `${pick.outOfSlot} out of slot AND admitted by the power gate.`);
console.log(`subject: "${pick.name}" radiance ${pick.lum.toFixed(2)} at ${pick.world.map((v) => v.toFixed(1))}` +
  ` — palette class(es) [${pick.subjectClasses.join(",")}]`);
const emissiveClasses = pick.palette.filter((p) => p.e > 0);
console.log(`palette: ${pick.palette.length} classes, ${emissiveClasses.length} with emission ` +
  `(reserved emitter band [${pick.emitterBand.join(",")}])`);
// ⭐ THE TIER COLUMN IS THE §O GATE. `Ns/Na/Nc` = seated / admitted / culled
// placements in that class. A class with only `c` MUST read 0; a class with `s`
// carries the double-count risk and is reported next to its value rather than
// argued about.
for (const p of emissiveClasses) {
  console.log(`    #${String(p.i).padStart(2)}  e ${String(p.e).padStart(8)}  rgb ${p.rgb ? p.rgb.join(",") : "n/a"}  ` +
    `albedo ${p.a.join(",")}  tiers ${p.tiers}`);
}
{
  const culledOnly = pick.palette.filter((p) => /^0s\/0a\/\d+c$/.test(p.tiers));
  const seatedAny = pick.palette.filter((p) => /^[1-9]/.test(p.tiers));
  console.log(`  §O negative half: ${culledOnly.length} class(es) hold ONLY culled placements — ` +
    `${culledOnly.filter((p) => p.e === 0).length} of them carry e = 0` +
    (culledOnly.some((p) => p.e > 0) ? `  ⛔ NON-ZERO: ${culledOnly.filter((p) => p.e > 0).map((p) => `#${p.i}=${p.e}`).join(" ")}` : ""));
  console.log(`  §O double-count guard: ${seatedAny.length} class(es) contain a SEATED mesh — ` +
    `${seatedAny.map((p) => `#${p.i}=${p.e}(${p.tiers})`).join(" ") || "none"}`);
}

// ⭐⭐ THE SUN AND THE SKY GO OUT — IN **EVERY** ARM, WHICH IS WHY IT IS NOT A
// CONFOUND (§19 Stage 4.0b).
//
// The question is "how much of this surface's light comes from that lamp's
// palette class". On Bistro the answer under a lit sky is "a fraction of a
// percent of a sunlit street", and the A/B measured exactly that: ON 0.24228,
// OFF 0.24228 — a real term, invisible under a signal three orders larger.
// [[probe-blind-statistics]] again: the estimator was fine, the CONTRAST was
// not. Switching the sun and the environment off makes the emitters the only
// light in the scene, and it is done ONCE, before the first sample, so all
// three arms (ON / OFF / restored) share it. `giSunOff` is the same control
// `run-gi-shadowed-bulb` builds into its rig; here it is applied to a scene
// that already exists.
const darkened = await page.evaluate(() => {
  const eng = globalThis.__engine;
  const saved = [];
  eng.scene.traverse((o) => {
    if (o.isLight && o.intensity > 0) { saved.push([o, o.intensity]); o.intensity = 0; }
  });
  const envI = eng.scene.environmentIntensity;
  eng.scene.environmentIntensity = 0;
  eng.scene.background = null;
  globalThis.__darkSaved = { saved, envI };
  return saved.length;
});
console.log(`sun/sky out for every arm: ${darkened} light(s) zeroed, environmentIntensity 0 — ` +
  "the emitters are the only light left, which is the only contrast this A/B can be read at");

// ⭐⭐ AND THE RECEIVER IS FOUND IN **THE WINDOW**, not in the scene graph.
//
// The CPU raycast above misses on Bistro (`staticMerging` hides the authored
// meshes and the proxies do not answer an `intersectObjects` walk), and a
// receiver in open air is a crop of the sky — the reading that made both halves
// of this gate fail on a build whose palette was demonstrably carrying eight
// emissive classes. So the surface is found with the SAME `traceWindow` the
// gather itself uses: park near the lamp so the window covers it, fire one ray
// down (then sideways, for a wall-mounted lamp), and put the receiver on
// whatever the voxel world says is there. It cannot land on nothing, and it
// cannot land on something the GI does not have.
await call("viewport.setCamera", { position: pick.eye, target: pick.look });
await wait(5000);
{
  const found = await page.evaluate(async ({ world }) => {
    const eng = globalThis.__engine;
    const gi2 = eng?.modules?.get?.("gi")?.system?.state?.screen?.gi2;
    if (!gi2?.trace || !eng.renderer) return null;
    const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
    const shoot = createGi2RayShooter(gi2, eng.renderer);
    const dirs = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    const out = await shoot(dirs.map((d) => ({ o: world, d, tMax: 12 })));
    for (let i = 0; i < dirs.length; i++) {
      const r = out[i];
      if (!r?.hit || !(r.t > 0.15)) continue;
      const d = dirs[i];
      // Back off a few centimetres along the ray so the crop sees the LIT face
      // rather than the inside of the voxel the ray stopped in.
      const t = r.t - 0.08;
      return { p: [world[0] + d[0] * t, world[1] + d[1] * t, world[2] + d[2] * t], dir: d, t: +r.t.toFixed(2) };
    }
    return null;
  }, { world: pick.world });
  if (found) {
    pick.receiver = found.p;
    pick.receiverDrop = found.t;
    pick.look = found.p;
    pick.eye = [found.p[0] + 1.4, found.p[1] + 1.0, found.p[2] + 1.4];
    console.log(`receiver found in the window: ${found.t} m along [${found.dir}] from the lamp → ` +
      `${found.p.map((v) => v.toFixed(2)).join(", ")}`);
  } else {
    console.log("⚠ the window trace found no surface within 12 m of the lamp — falling back to 1.2 m below it");
  }
}
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

// ── switch OFF the SUBJECT'S OWN CLASS, nothing else ────────────────────────
//
// ⭐ §19 STAGE 4.0b (audits §O.6.2). Zeroing EVERY class's emission answered a
// coarser question — "does emissive-at-hits carry anything at all" — and with
// 63 classes and a reserved emitter band it would now switch off every lamp in
// the scene at once. Zeroing the subject's own class is the same A/B aimed at
// the one emitter under test: same camera, same exposure, same soup, same
// probes, one uniform write.
//
// ⚠ AND IT IS THE RGB TABLE THAT MATTERS. `pal.w` is the printed mean since
// 4.0b; `shadeHit` reads `palEmU.xyz`. Both are zeroed so the printed census
// and the shaded frame agree, but the RGB write is the one doing the work.
const zeroed = await page.evaluate((classes) => {
  const pal = globalThis.__pal;
  const em = globalThis.__palEm;
  globalThis.__palSaved = pal.map((v) => v.w);
  globalThis.__palEmSaved = em ? em.map((v) => [v.x, v.y, v.z]) : null;
  const want = classes.length ? classes : pal.map((_, i) => i);
  let n = 0;
  for (const i of want) {
    if (!pal[i]) continue;
    if (pal[i].w > 0 || (em && (em[i].x + em[i].y + em[i].z) > 0)) n++;
    pal[i].w = 0;
    if (em) em[i].set(0, 0, 0, 0);
  }
  return n;
}, pick.subjectClasses);
await wait(SETTLE);
const off = await sample([pick.receiver]);
await sharp(off.shot).toFile("scripts/gi-diag-gi2-tree-off.png");
await page.evaluate(() => {
  const pal = globalThis.__pal;
  const em = globalThis.__palEm;
  globalThis.__palSaved.forEach((w, i) => { pal[i].w = w; });
  if (em && globalThis.__palEmSaved) {
    globalThis.__palEmSaved.forEach((c, i) => { em[i].set(c[0], c[1], c[2], 0); });
  }
});
await wait(SETTLE);
const back = await sample([pick.receiver]);

const drop = on.lum[0] - off.lum[0];
const restored = back.lum[0];
console.log(`\nreceiver ${pick.receiverDrop == null ? "1.2 m (NO SURFACE FOUND — the raycast missed)" : `${pick.receiverDrop} m`} below "${pick.name}":`);
console.log(`  palette emission ON  ${on.lum[0].toFixed(5)}`);
console.log(`  palette emission OFF ${off.lum[0].toFixed(5)}  (${zeroed} class(es) zeroed: ` +
  `[${pick.subjectClasses.join(",") || "ALL"}])`);
console.log(`  restored             ${restored.toFixed(5)}`);
console.log(`  carried by emissive-at-hits: ${drop.toFixed(5)} = ${((drop / Math.max(on.lum[0], 1e-6)) * 100).toFixed(1)}% of the lit value`);
console.log(`  reversibility (|restored − ON| / ON): ${(Math.abs(restored - on.lum[0]) / Math.max(on.lum[0], 1e-6) * 100).toFixed(1)}%`);

// ⚠ THE "LIT AT ALL" FLOOR IS A FUNCTION OF WHAT IS LIGHTING THE SCENE. 0.01
// was calibrated against a SUNLIT frame; with the sun and the environment
// switched off (which is what makes the emitter term readable at all — see the
// darkening block) the whole frame is two orders darker, and the old constant
// would fail every run that measures the subject correctly. The floor that
// still means something is "above the black the OFF arm settles at", i.e. a
// hundredth of the sunlit one.
const LIT_FLOOR = darkened > 0 ? 1e-4 : 0.01;
const checks = [
  [`the receiver is lit at all (floor ${LIT_FLOOR})`, on.lum[0] > LIT_FLOOR],
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
