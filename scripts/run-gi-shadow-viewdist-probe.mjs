// EMITTER-SHADOW VIEW-DISTANCE PROBE (2026-08-19).
//
// THE QUESTION: "shadows appear fine when looking very close, but get muddy as
// we look from farther away". A shadow is a property of the SCENE. If the
// camera changes it, that is a bug, and this rig is the one measurement that
// says so with numbers instead of screenshots.
//
// THE CONTROL — a dolly zoom onto the FLOOR PLANE. The camera looks straight
// down at the floor and the fov is compensated so `tan(fov/2)·d` is constant.
// Every point OF THE FLOOR then projects to the SAME pixel at every camera
// distance: the shadow's footprint is registered across arms to the texel, and
// the only quantity that changed is `viewDist`. (Geometry above the floor does
// change size — that is why the measurement band excludes the occluder and the
// lamp and keeps to open floor.)
//
// WHAT IT READS: the emitter shadow chain at two taps —
//   · `emitterShadowMid`   post-filter, PRE-wide. Binary mask + bilateral; no
//                          viewDist term anywhere in it, so it is the CONTROL:
//                          it must not move across distances.
//   · `emitterShadow`      the final texture every material samples, after the
//                          two wide (penumbra reconstruction) passes.
// A MID that holds still while the FINAL washes out convicts the wide passes.
//
// The profile is sampled in WORLD SPACE (project a line of floor points through
// the live camera, read the texel each lands on), so the printed curves from
// different distances are directly comparable rows of the same measurement.
//
//   node scripts/run-gi-shadow-viewdist-probe.mjs [url]
// Env:
//   DISTS=4,8,16,32   camera heights above the floor (metres)
//   LOCK=1|0          1 = dolly zoom (footprint held, only viewDist changes —
//                     the CONTROL). 0 = a real dolly-out at fixed fov, which is
//                     what a user does: viewDist AND the shadow's texel
//                     footprint both shrink. Run both; the pair separates
//                     "the maths depends on the camera" from "the buffer runs
//                     out of texels", which look identical on screen.
//   ARM=default|nowide|nosearch   nowide → __giEmitterWidePass=false
//   QUALITY=high      GI preset
//   PNG=1             dump the final shadow texture per distance
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5335/";
const dists = (process.env.DISTS ?? "4,8,16,32").split(",").map(Number).filter((n) => n > 0);
const lock = process.env.LOCK !== "0";
const arm = process.env.ARM ?? "default";
const quality = process.env.QUALITY ?? "high";
const wantPng = process.env.PNG === "1";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
let sawField = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] field ready:/.test(t)) sawField = true;
  if (/\[gi\] (built|emitters|field ready|emitter shadows)|PROBE/.test(t)) console.log(`  ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`));
await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await new Promise((r) => setTimeout(r, 5000));

const result = await page.evaluate(async ({ dists, arm, quality, wantPng, lock }) => {
  globalThis.__editorKeepRendering = true;
  globalThis.__giConfigOverride = { emissiveShadows: true };
  globalThis.__giSrcProbes = false;
  // ARM is a comma-separated set so the levers compose — the question is never
  // "which one" but "how much does each buy on top of the others".
  const flags = new Set(String(arm).split(",").map((s) => s.trim()).filter(Boolean));
  if (flags.has("nowide")) globalThis.__giEmitterWidePass = false;
  // `sharp` collapses the pre-wide bilateral to its narrowest despeckle (σ0.55);
  // it is the A/B for "is the 5×5 filter what eats a small shadow".
  if (flags.has("sharp")) globalThis.__giEmitterFilterSoftness = 0;
  // `res` runs the shadow + emitter buffers at full resolve resolution — the
  // blunt lever, and the one that says whether resolution alone can carry it.
  if (flags.has("res")) { globalThis.__giShadowScale = 1; globalThis.__giEmitterShadowScale = 1; }

  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  for (const entity of [...engine.entities.values()]) engine.destroyEntity(entity);
  for (const child of [...engine.scene.children]) if (child.isMesh) engine.scene.remove(child);
  const anon = (g) => { const n = g.toNonIndexed(); n.parameters = undefined; n.type = "BufferGeometry"; return n; };

  const grey = new THREE.MeshStandardNodeMaterial({ color: 0x999999, roughness: 0.9 });
  const floor = new THREE.Mesh(anon(new THREE.BoxGeometry(40, 0.3, 40)), grey);
  floor.position.y = -0.15;
  // THE OCCLUDER is torso-sized on purpose: the reported failure is a thin,
  // close occluder next to a big lamp, which is the case the analytic-penumbra
  // reconstruction has the least margin on. A crate would hide the effect.
  const post = new THREE.Mesh(anon(new THREE.BoxGeometry(0.35, 1.7, 0.35)), grey);
  post.position.set(2.0, 0.85, 0);
  const glowMat = new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 0.9 });
  glowMat.emissive = new THREE.Color(1, 1, 1);
  glowMat.emissiveIntensity = 8;
  const lamp = new THREE.Mesh(anon(new THREE.BoxGeometry(1, 1, 1)), glowMat);
  lamp.position.set(0, 0.5, 0);
  engine.scene.add(floor, post, lamp);
  for (const m of [floor, post, lamp]) m.updateMatrixWorld(true);

  const gi = engine.createEntity({ name: "GI ViewDist Probe" });
  gi.addComponent("global-illumination", { quality });
  const system = engine.modules.get("gi").system;

  const cam = engine.camera;
  // Looking straight down needs an up vector that is not the view axis.
  cam.up.set(0, 0, -1);
  // K = half-height of the visible FLOOR, in metres, held constant. This is
  // what makes the floor's projection identical at every distance.
  const K = 3;
  const AIM = new THREE.Vector3(3.5, 0, 0);
  // LOCK=0 pins the fov at the NEAREST distance's value, so pulling back
  // shrinks the footprint exactly as it does for a user flying the camera out.
  const fov0 = 2 * Math.atan(K / dists[0]) * 180 / Math.PI;
  const placeCamera = (d) => {
    cam.position.set(AIM.x, d, AIM.z);
    cam.lookAt(AIM);
    cam.fov = lock ? 2 * Math.atan(K / d) * 180 / Math.PI : fov0;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  };
  placeCamera(dists[0]);

  const deadline = performance.now() + 90_000;
  let screen = null;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    screen = system.state?.screen ?? null;
    if (screen && (system.state?.volume?.occupancyField?.stats?.dispatches ?? 0) > 3) break;
  }
  if (!screen) return { fail: "GI never built a screen bundle" };
  {
    const end = performance.now() + 60_000;
    let quiet = 0;
    while (performance.now() < end && quiet < 5) {
      await new Promise((r) => setTimeout(r, 200));
      const d = system.state?.volume?.occupancyField?.debugIncremental;
      quiet = globalThis.__giPendingComputePipelines?.size === 0 && d && !d.dirty && !d.staticDirty ? quiet + 1 : 0;
    }
  }
  await new Promise((r) => setTimeout(r, 2000));

  const W = screen.emitterShadowWidth ?? screen.shadowWidth ?? screen.width;
  const H = screen.emitterShadowHeight ?? screen.shadowHeight ?? screen.height;
  const stride = Math.ceil((W * 4) / 256) * 256;
  const grab = async (target) => {
    const data = await engine.renderer.backend.copyTextureToBuffer(target, 0, 0, W, H);
    const img = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * stride;
      for (let x = 0; x < W; x++) img[y * W + x] = data[row + x * 4] / 255;
    }
    return img;
  };

  // World point → texel of the shadow buffer, through the LIVE camera. The
  // readback rows are top-down (row 0 = the buffer's y=0), which is where the
  // NDC y flip belongs; getting it backwards mirrors every profile, so the
  // sanity block below checks a point whose answer is known.
  const v = new THREE.Vector3();
  const toTexel = (x, y, z) => {
    v.set(x, y, z).project(cam);
    const tx = Math.round((v.x * 0.5 + 0.5) * (W - 1));
    const ty = Math.round((1 - (v.y * 0.5 + 0.5)) * (H - 1));
    return (tx >= 0 && tx < W && ty >= 0 && ty < H) ? { tx, ty } : null;
  };

  const sampleArm = async (d) => {
    placeCamera(d);
    // The wide passes read the camera through a uniform refreshed per frame,
    // and the gbuffer has to be re-rendered from the new view — several frames,
    // not one. 1.2 s is ~70 frames of headroom at this rig's rate.
    await new Promise((r) => setTimeout(r, 1200));
    const fin = await grab(screen.targets.emitterShadow);
    const mid = screen.targets.emitterShadowMid ? await grab(screen.targets.emitterShadowMid) : null;
    // ── the measurement band: OPEN FLOOR downstream of the occluder ──
    // x ∈ [2.4, 5.5] is past the post (at x=2.0) and short of the frame edge;
    // z ∈ [-1.2, 1.2] straddles the shadow's centreline.
    const stats = (img) => {
      if (!img) return null;
      const vals = [];
      for (let wx = 2.4; wx <= 5.5; wx += 0.05) {
        for (let wz = -1.2; wz <= 1.2; wz += 0.05) {
          const t = toTexel(wx, 0, wz);
          if (t) vals.push(img[t.ty * W + t.tx]);
        }
      }
      vals.sort((a, b) => a - b);
      const q = (f) => vals.length ? vals[Math.min(vals.length - 1, Math.round(f * (vals.length - 1)))] : NaN;
      return {
        n: vals.length,
        p05: q(0.05), p25: q(0.25), median: q(0.5),
        mean: vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length),
        occ50: vals.filter((x) => x < 0.5).length / Math.max(1, vals.length),
        occ80: vals.filter((x) => x < 0.8).length / Math.max(1, vals.length),
      };
    };
    // WORLD-SPACE PROFILE along the shadow's centreline. Same world points at
    // every distance, so these rows are literally the same measurement.
    const profile = (img) => {
      if (!img) return null;
      const out = [];
      for (let wx = 2.2; wx <= 6.0; wx += 0.2) {
        const t = toTexel(wx, 0, 0);
        out.push(t ? Number(img[t.ty * W + t.tx].toFixed(3)) : null);
      }
      return out;
    };
    // FRAMING SELF-CHECK: under LOCK=1 these texels are the same at every
    // distance (a drift invalidates every comparison below it); under LOCK=0
    // `footTx` IS the independent variable — how many shadow-buffer texels the
    // measured world band actually occupies.
    const anchor = toTexel(4.0, 0, 0);
    const a0 = toTexel(2.4, 0, 0), a1 = toTexel(5.5, 0, 0);
    const footTx = a0 && a1 ? Math.hypot(a1.tx - a0.tx, a1.ty - a0.ty) : NaN;
    return {
      d,
      fov: Number(cam.fov.toFixed(2)),
      anchor: anchor ? `${anchor.tx},${anchor.ty}` : "off",
      footTx: Number(footTx.toFixed(1)),
      final: stats(fin), mid: stats(mid),
      profileFinal: profile(fin), profileMid: profile(mid),
      // 4× NEAREST, never smooth: the whole question ("is that a penumbra or
      // eight copies of the shadow") is per-texel, and a resampled artifact is
      // a different artifact. FINAL on the left, MID on the right, so the wide
      // passes' contribution is a side-by-side and not a memory of the last png.
      png: wantPng ? (() => {
        const Z = 4, cw = W * Z * 2 + 8, ch = H * Z;
        const cv = document.createElement("canvas");
        cv.width = cw; cv.height = ch;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#c00"; ctx.fillRect(0, 0, cw, ch);
        const im = ctx.createImageData(W * Z, H * Z);
        const paint = (img, ox) => {
          for (let y = 0; y < H * Z; y++) for (let x = 0; x < W * Z; x++) {
            const v = Math.round((img[Math.floor(y / Z) * W + Math.floor(x / Z)]) * 255);
            const o = (y * W * Z + x) * 4;
            im.data[o] = v; im.data[o + 1] = v; im.data[o + 2] = v; im.data[o + 3] = 255;
          }
          ctx.putImageData(im, ox, 0);
        };
        paint(fin, 0);
        if (mid) paint(mid, W * Z + 8);
        return cv.toDataURL("image/png");
      })() : null,
    };
  };

  const arms = [];
  for (const d of dists) arms.push(await sampleArm(d));
  return {
    W, H, arms,
    resolve: `${screen.width}x${screen.height}`,
    emitters: system.state?.emitterSlots?.length ?? 0,
    wideOn: !!screen.emitterShadowWidePass,
  };
}, { dists, arm, quality, wantPng, lock });

if (result.fail) {
  console.log(`FAIL: ${result.fail}`);
  await browser.close();
  process.exit(1);
}
if (!sawField) console.log("⚠ no `field ready` line — the readback may have measured an unbuilt field");

console.log(`\nemitter shadow buffer ${result.W}×${result.H} (resolve ${result.resolve})  wide chain: ${result.wideOn ? "ON" : "off"}  arm=${arm}  LOCK=${lock ? 1 : 0}`);
console.log(`\n  the band is open floor, x∈[2.4,5.5] z∈[±1.2], downstream of a 0.35×1.7×0.35 post 2 m from a 1 m lamp.`);
console.log(lock
  ? `  dolly-zoom LOCKED: the floor's projection is identical at every distance, so footTx is constant and only viewDist varies.\n`
  : `  fixed fov (a real dolly-out): footTx is the band's width in shadow texels and IS the variable under test.\n`);
const row = (label, s) => s
  ? `  ${label.padEnd(18)} p05 ${s.p05.toFixed(3)}  p25 ${s.p25.toFixed(3)}  med ${s.median.toFixed(3)}  mean ${s.mean.toFixed(3)}  occ<.5 ${(s.occ50 * 100).toFixed(1)}%  occ<.8 ${(s.occ80 * 100).toFixed(1)}%`
  : `  ${label.padEnd(18)} —`;
for (const a of result.arms) {
  console.log(`d=${String(a.d).padStart(3)}m  fov ${String(a.fov).padStart(6)}°  anchor texel ${a.anchor}  band footprint ${a.footTx} texels`);
  console.log(row("FINAL (sampled)", a.final));
  console.log(row("MID (pre-wide)", a.mid));
}
console.log(`\nprofile along z=0, world x 2.2 → 6.0 step 0.2 (0 = fully shadowed, 1 = lit)`);
for (const a of result.arms) console.log(`  d=${String(a.d).padStart(3)} FINAL ${JSON.stringify(a.profileFinal)}`);
for (const a of result.arms) if (a.profileMid) console.log(`  d=${String(a.d).padStart(3)} MID   ${JSON.stringify(a.profileMid)}`);

// THE VERDICT the rig exists to deliver.
const fin = result.arms.map((a) => a.final).filter(Boolean);
if (fin.length >= 2) {
  const spread = (k) => Math.max(...fin.map((s) => s[k])) - Math.min(...fin.map((s) => s[k]));
  const mid = result.arms.map((a) => a.mid).filter(Boolean);
  const midSpread = mid.length >= 2 ? Math.max(...mid.map((s) => s.p05)) - Math.min(...mid.map((s) => s.p05)) : NaN;
  console.log(`\nVERDICT  p05 spread across camera distances: FINAL ${spread("p05").toFixed(3)}   MID ${Number.isNaN(midSpread) ? "—" : midSpread.toFixed(3)}`);
  console.log(`         mean spread: FINAL ${spread("mean").toFixed(3)}   (a scene-owned shadow would spread ~0)`);
}
if (wantPng) {
  for (const a of result.arms) {
    if (!a.png) continue;
    writeFileSync(`scripts/gi-viewdist-${arm}-l${lock ? 1 : 0}-d${a.d}.png`,
      Buffer.from(a.png.split(",")[1], "base64"));
  }
  console.log(`\nwrote 4× nearest dumps (FINAL | MID) to scripts/gi-viewdist-${arm}-l${lock ? 1 : 0}-d*.png`);
}
await browser.close();
