// ⭐⭐ §19 STAGE 4.0 — TWO MEASUREMENTS THE CUTOVER CENSUS ASKED FOR.
//
//   node scripts/run-gi2-mover-probe.mjs http://127.0.0.1:5202/
//   SCENES=Level,Bistro FRAMES=90
//
// ── 1. THE DYNAMIC LAYER (Level) ────────────────────────────────────────────
//
// `profile.gi2.dynamic.voxelsSet > 0` is NOT the receipt on its own, and that
// is the whole point of this probe. At 4.3a the Level reported 374 dynamic
// voxels every frame while the character's footprint was FROZEN at its
// bind-pose world box: `#gi2Movers` seated a skinned mesh as one box with
// `identity: true`, and the tick's pose loop skipped exactly those. A counter
// that stays positive on a frozen box is an instrument that cannot see its
// subject ([[probe-blind-statistics]]).
//
// So this reads the MOVER CENTROID as well — the mean translation of every
// seated mover's live matrix — and asks whether it MOVES while the rig
// animates. A frozen layer holds the centroid to the millimetre; a live one
// tracks the skeleton.
//
// ── 2. DOES THE CACHE CARRY AN OUT-OF-SLOT EMITTER? (Bistro) ────────────────
//
// GI2 has exactly four NEE emitter slots and Bistro has ~116 emissive meshes,
// so the other ~112 can only reach the world through the PALETTE'S EMISSIVE AT
// HITS: `shadeHit` returns `albedo/π · E + pal.w`, and `pal.w` is the material
// class's emissive. The question `gi2System`'s unread `lightTree` argument
// raises is whether that stochastic path actually delivers, or whether hits
// need their own tree-sampled NEE ray. The measurement is a live A/B on ONE
// out-of-slot emitter: sample the irradiance at a receiver right below it,
// zero its emissive, let the field re-converge, sample again. A carried light
// shows up as a DROP; a light the transport never had shows up as nothing.
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENES = (process.env.SCENES ?? "Level,Bistro").split(",").map((s) => s.trim()).filter(Boolean);
const FRAMES = Number(process.env.FRAMES ?? 90);
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
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] (skinned movers|dynamic layer|soup|window|first light)|\[gi\] built/.test(t)) console.log(`    ${t.slice(0, 300)}`);
});
page.on("pageerror", (e) => {
  const msg = e.stack ?? e.message ?? String(e);
  if (!/save_scene|esbuild|transpile/.test(msg)) console.log(`    pageerror: ${msg.slice(0, 200)}`);
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
// ⚠ `__editorApi` is the OP surface and deliberately exposes no engine. The
// live engine binding is the module the editor itself boots from — reached
// once, here, and parked on a global so every later evaluate is synchronous.
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__engine = mod.engine;
});

const call = (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });

let failed = 0;
const gate = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

// ── viewport luminance sampling, projected from world points ────────────────
const shootAndSample = async (points) => {
  const meta = await page.evaluate(({ points }) => {
    const engine = globalThis.__engine;
    const cam = engine.camera;
    cam.updateMatrixWorld(true);
    // The viewport is not simply the biggest canvas — the editor keeps
    // offscreen ones around (thumbnails, the GI slot-albedo atlas). Pick by
    // ON-SCREEN box, which is what "the frame the user sees" means.
    let best = null;
    let area = 0;
    for (const c of document.querySelectorAll("canvas")) {
      const b = c.getBoundingClientRect();
      if (b.width < 300 || b.height < 200) continue;
      if (b.left < -b.width || b.top < -b.height) continue;
      if (b.width * b.height > area) { area = b.width * b.height; best = b; }
    }
    if (!best) return { px: points.map(() => [0, 0, 0]), rect: [0, 0, 0, 0] };
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
        cw > 0 ? 1 : 0,
      ];
    };
    return { px: points.map(project), rect: [best.left, best.top, best.width, best.height] };
  }, { points });
  const shot = await page.screenshot({ type: "png" });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const toLin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const patch = ([cx, cy], n = 5) => {
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
  return { lum: meta.px.map((p) => patch(p)), px: meta.px, rect: meta.rect, shot };
};

for (const name of SCENES) {
  console.log(`\n══ ${name} ═══════════════════════════════════════════════`);
  const opened = await call("scene.open", { path: `${PROJECT}/scenes/${name}.scene` });
  if (!opened.ok) { console.log(`  scene.open failed: ${opened.error}`); failed++; continue; }
  await wait(30000);

  if (name === "Level") {
    // ── 1. THE DYNAMIC LAYER ────────────────────────────────────────────────
    const rig = await page.evaluate(() => {
      const engine = globalThis.__engine;
      const sys = engine.modules?.get("gi")?.system;
      const movers = sys?._gi2Movers ?? [];
      // Start every animation the scene owns, so the skeleton is genuinely
      // driven rather than nudged by the harness — the receipt is about the
      // rig's OWN motion reaching the window.
      let played = 0;
      for (const e of engine.entities.values()) {
        const anim = e.getComponent?.("animation");
        if (!anim) continue;
        try {
          const clips = anim.clips ?? anim.actions ?? null;
          if (typeof anim.play === "function") { anim.play(anim.props?.clip ?? (clips && Object.keys(clips)[0]) ?? undefined); played++; }
        } catch { /* a clip name we cannot guess */ }
      }
      const skinned = [];
      engine.scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o.name || "(unnamed)"); });
      return {
        movers: movers.length,
        boneMovers: movers.filter((m) => typeof m.matrixOf === "function").length,
        frozenIdentity: movers.filter((m) => m.identity).length,
        skinned: skinned.slice(0, 6),
        played,
      };
    });
    console.log(`  movers ${rig.movers} (${rig.boneMovers} on live bone matrices, ${rig.frozenIdentity} frozen-identity), ` +
      `skinned meshes [${rig.skinned.join(", ")}], animations started ${rig.played}`);

    // Sample the layer + the mover centroid over FRAMES ticks.
    const series = await page.evaluate(async (frames) => {
      const engine = globalThis.__engine;
      const sys = engine.modules?.get("gi")?.system;
      const out = [];
      const centroid = () => {
        const ms = sys._gi2Movers ?? [];
        if (!ms.length) return [0, 0, 0];
        let x = 0, y = 0, z = 0;
        for (const m of ms) { const e = m.matrix.elements; x += e[12]; y += e[13]; z += e[14]; }
        return [x / ms.length, y / ms.length, z / ms.length];
      };
      for (let i = 0; i < frames; i++) {
        await new Promise((r) => requestAnimationFrame(() => r()));
        const d = sys?._gi2Stats?.dynamic ?? null;
        out.push({ voxels: d?.voxelsSet ?? -1, tris: d?.trianglesPacked ?? -1, outside: d?.outside ?? -1, c: centroid() });
      }
      return out;
    }, FRAMES);
    const voxels = series.map((s) => s.voxels).filter((v) => v >= 0);
    const minVox = Math.min(...voxels);
    const cs = series.map((s) => s.c);
    let travel = 0;
    for (let i = 1; i < cs.length; i++) {
      travel = Math.max(travel, Math.hypot(cs[i][0] - cs[0][0], cs[i][1] - cs[0][1], cs[i][2] - cs[0][2]));
    }
    console.log(`  dynamic layer over ${series.length} frames: voxels min ${minVox} max ${Math.max(...voxels)}, ` +
      `mover tris ${series.at(-1).tris}, outside ${series.at(-1).outside}`);
    console.log(`  mover centroid travel: ${travel.toFixed(4)} m (0 = the layer is frozen at its build pose)`);
    gate("the dynamic layer is populated every frame", voxels.length > 0 && minVox > 0, `min ${minVox}`);
    gate("bone movers ride live matrices", rig.boneMovers > 0 && rig.frozenIdentity === 0, `${rig.boneMovers} bone boxes`);

    // ── THE CONTACT SHADOW, ISOLATED BY AN ON/OFF A/B ───
    //
    // ⭐ A CROP UNDER A CHARACTER IN A REAL LEVEL CANNOT BE READ SPATIALLY.
    // The first attempt compared "under the rig" against "beside the rig" and
    // read 1.000 vs 0.004 — the "under" crop had landed on the CHARACTER, which
    // occludes its own contact point from every camera that can also see lit
    // floor, and the "beside" crop on unlit interior. Two different surfaces
    // under two different lights is not a measurement of anything.
    //
    // The same crop with the dynamic layer ON and OFF is. `gi2.setMovers([])`
    // empties the layer without touching geometry, lighting, exposure or the
    // camera, so the delta at one fixed pixel IS the layer's occlusion — and
    // the restore is one flag, because `#refreshGi2Movers` re-derives whenever
    // `_gi2MoversDirty` is set.
    const aim = await page.evaluate(() => {
      const engine = globalThis.__engine;
      const sys = engine.modules?.get("gi")?.system;
      const ms = (sys._gi2Movers ?? []).filter((m) => typeof m.matrixOf === "function");
      if (!ms.length) return null;
      let x = 0, z = 0, lo = Infinity, hi = -Infinity;
      for (const m of ms) {
        const e = m.matrix.elements;
        x += e[12]; z += e[14];
        lo = Math.min(lo, e[13]); hi = Math.max(hi, e[13]);
      }
      x /= ms.length; z /= ms.length;
      // The floor just in FRONT of the feet, toward the camera: inside the
      // contact-shadow radius, outside the body's silhouette.
      const floorY = lo - 0.05;
      const probe = [x + 0.75, floorY, z + 0.75];
      engine.scene.traverse((o) => { if (o.isGridHelper || o.type === "AxesHelper") o.visible = false; });
      return {
        probe,
        feet: [x, floorY, z],
        span: +(hi - lo).toFixed(2),
        // THE VIEWPORT OWNS THE CAMERA, AND ORBIT CONTROLS REWRITE IT EVERY
        // FRAME. Writing `engine.camera.position` from here is reverted before
        // the next screenshot, and the projected crops then land on editor
        // chrome — measured as two crops reading a flat 1.00000 and 0.00440,
        // a white panel and a dark one. `viewport.setCamera` is the op that
        // moves it AND calls `orbit.update()`.
        eye: [x + 2.6, floorY + 1.5, z + 2.6],
        look: [x + 0.4, floorY + 0.1, z + 0.4],
      };
    });
    if (aim) await call("viewport.setCamera", { position: aim.eye, target: aim.look });
    if (!aim) {
      gate("a crop under the character", false, "no bone movers to aim at");
    } else {
      console.log(`  crop point ${aim.probe.map((v) => v.toFixed(2))}, rig height span ${aim.span} m`);
      await wait(3000);
      await wait(9000);
      const on = await shootAndSample([aim.probe]);
      console.log(`  viewport canvas ${on.rect.map((v) => Math.round(v)).join(",")}, crop pixel ${on.px[0].slice(0, 2)}`);
      await sharp(on.shot).toFile("scripts/gi-diag-gi2-mover-on.png");
      // Empty the dynamic layer, and nothing else.
      await page.evaluate(() => {
        const sys = globalThis.__engine.modules.get("gi").system;
        sys._gi2Movers = [];
        sys.state.screen.gi2.setMovers([]);
      });
      await wait(9000);
      const off = await shootAndSample([aim.probe]);
      await sharp(off.shot).toFile("scripts/gi-diag-gi2-mover-off.png");
      // Restore: one flag, and the tick re-derives from the entity side.
      await page.evaluate(() => { globalThis.__engine.modules.get("gi").system._gi2MoversDirty = true; });
      const darkening = (off.lum[0] - on.lum[0]) / Math.max(off.lum[0], 1e-6);
      console.log(`  crop @${on.px[0].slice(0, 2)}: dynamic layer ON ${on.lum[0].toFixed(5)}  OFF ${off.lum[0].toFixed(5)}  ` +
        `darkening ${(darkening * 100).toFixed(1)}%`);
      gate("the crop is lit with the layer off", off.lum[0] > 0.003, off.lum[0].toFixed(5));
      gate("the dynamic layer darkens the floor under the rig", darkening > 0.02, `${(darkening * 100).toFixed(1)}%`);
    }
  }

  if (name === "Bistro") {
    // ── 2. THE OUT-OF-SLOT EMITTER A/B ──────────────────────────────────────
    const pick = await page.evaluate(() => {
      const engine = globalThis.__engine;
      const sys = engine.modules?.get("gi")?.system;
      // ⚠ NOT A SCENE WALK FOR `material.emissive`. Bistro's emitters are node
      // materials whose emission lives in a graph, and a naive walk found ZERO
      // of the 116 the module itself knows about. `_emitterCands` IS the
      // module's own resolved candidate list and `_promotedEmitterMeshes` the
      // four it seated — read the instrument that already exists.
      const cands = (sys?._emitterCands ?? []).filter((c) => c?.mesh);
      const seated = new Set((sys?._promotedEmitterMeshes ?? []).filter(Boolean));
      const outs = cands.filter((c) => !seated.has(c.mesh))
        .map((c) => ({ c, lum: (c.r + c.g + c.b) / 3 }))
        .sort((a, b) => b.lum - a.lum);
      if (!outs.length) return { cands: cands.length, seated: seated.size, outOfSlot: 0, name: null };
      const chosen = outs[0].c;
      chosen.mesh.updateWorldMatrix(true, false);
      chosen.mesh.geometry?.computeBoundingBox?.();
      const bb = chosen.mesh.geometry?.boundingBox;
      const cx = bb ? (bb.min.x + bb.max.x) / 2 : 0;
      const cy = bb ? (bb.min.y + bb.max.y) / 2 : 0;
      const cz = bb ? (bb.min.z + bb.max.z) / 2 : 0;
      const e = chosen.mesh.matrixWorld.elements;
      const wx = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
      const wy = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
      const wz = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
      globalThis.__gi2TreeProbe = { mesh: chosen.mesh };
      engine.scene.traverse((o) => { if (o.isGridHelper || o.type === "AxesHelper") o.visible = false; });
      return {
        cands: cands.length,
        seated: seated.size,
        outOfSlot: outs.length,
        name: chosen.mesh.name || "(unnamed)",
        lum: outs[0].lum,
        world: [wx, wy, wz],
        receiver: [wx, wy - 1.2, wz],
        control: [wx + 8, wy - 1.2, wz + 8],
        // See the Level block: the viewport owns the camera.
        eye: [wx + 2.4, wy - 0.2, wz + 2.4],
        look: [wx, wy - 1.2, wz],
      };
    });
    if (pick.name) await call("viewport.setCamera", { position: pick.eye, target: pick.look });
    console.log(`  ${pick.cands} emitter candidates, ${pick.seated} seated in NEE slots, ${pick.outOfSlot} out of slot; ` +
      `chosen "${pick.name}" (radiance ${pick.lum?.toFixed?.(2)}) at ${pick.world?.map?.((v) => v.toFixed(1))}`);
    if (!pick.name) {
      gate("an out-of-slot emitter exists to test", false, "none found");
    } else {
      await wait(9000);
      const on = await shootAndSample([pick.receiver, pick.control]);
      console.log(`  viewport canvas ${on.rect.map((v) => Math.round(v)).join(",")}, crop pixels ${JSON.stringify(on.px.map((q) => q.slice(0, 2)))}`);
      const gOn = await call("profile.gi2");
      await page.evaluate(() => {
        const engine = globalThis.__engine;
        // HIDE IT rather than editing a node graph's emission: the emitter
        // leaves the collect walk, so it leaves the soup, the palette and the
        // candidate list in one rebuild. Its own geometry leaves too — for a
        // light strip that is centimetres of occluder, and the control crop
        // 8 m away is what says whether the whole frame moved instead.
        globalThis.__gi2TreeProbe.mesh.visible = false;
        engine.modules?.get("gi")?.system?.requestRebuild?.("lighttree-probe");
      });
      await wait(45000);
      const off = await shootAndSample([pick.receiver, pick.control]);
      const drop = on.lum[0] - off.lum[0];
      const ctrlDrop = on.lum[1] - off.lum[1];
      console.log(`  receiver under the out-of-slot emitter: ON ${on.lum[0].toFixed(5)}  OFF ${off.lum[0].toFixed(5)}  ` +
        `carried ${drop.toFixed(5)} (${((drop / Math.max(on.lum[0], 1e-6)) * 100).toFixed(1)}% of the lit value)`);
      console.log(`  control 9 m away:                        ON ${on.lum[1].toFixed(5)}  OFF ${off.lum[1].toFixed(5)}  delta ${ctrlDrop.toFixed(5)}`);
      console.log(`  gi2 gather at ON: windowHits ${gOn.value?.windowHits ?? "?"}, freshShades ${gOn.value?.freshShades ?? "?"}, probesValid ${gOn.value?.probesValid ?? "?"}`);
      gate("the receiver was lit before the A/B", on.lum[0] > 0.005, on.lum[0].toFixed(5));
      gate("the cache carries an out-of-slot emitter", drop > Math.max(0.15 * on.lum[0], Math.abs(ctrlDrop) * 2));
      await sharp(on.shot).toFile("scripts/gi-diag-gi2-tree-on.png");
      await sharp(off.shot).toFile("scripts/gi-diag-gi2-tree-off.png");
    }
  }
}

console.log(failed === 0 ? "\nGI2-MOVER/TREE ALL PASS" : `\nGI2-MOVER/TREE ${failed} FAILED`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
