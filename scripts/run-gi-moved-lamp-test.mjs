// GI §19 Stage 1.2 — THE MOVED-LAMP PIXEL TEST.
//
// WHAT IT GUARDS. GI is a light node compiled into every lit material, and it
// feeds that node a set of `uniform()`s (emitter slot centre/radius/colour/
// shape, the resolve view-projection, texel sizes, probe boxes, light slots).
// Those uniforms live in a UNIFORM GROUP. `UniformNode.groupNode` defaults to
// `objectGroup`, and a non-shared group is CLONED PER RENDER OBJECT
// (NodeBuilderState.createBindings) — a clone only re-uploads inside three's
// `NodeMaterialObserver.needsRefresh` branch, which for a plain PBR material
// is true exactly ONCE PER RENDER (the `renderId` bump). So the first drawn
// object of a material sees fresh GI uniforms and every other object of that
// material is frozen at its first-initialization values.
//
// Until §19 Stage 1.2, GI hid that by stamping `material.giMonitorNode` on
// every material, which makes `containsNode` report `hasNode = true` and
// forces a full per-object refresh EVERY FRAME (measured 237 us/draw at 453
// draws on Bistro). Stage 1.2 deletes that marker and instead moves the GI
// uniforms into the SHARED `renderGroup`, which is uploaded once per render
// and version-checked — one refresh per render is then enough for all draws.
//
// The thing the marker protected had NO test (audits J.6 R5). This is it.
//
// WHAT IT MEASURES. A bright emissive lamp above a GLOSSY METAL floor. On the
// deferred path the emitter's diffuse direct light arrives through a TEXTURE
// (the resolve's irradiance target) and would follow the lamp even with every
// uniform frozen — so a diffuse floor proves nothing. The one term that reads
// the emitter SLOT UNIFORMS per pixel is giLight's emitter SPECULAR GLOW
// (`giLight.js` "Emitter SPECULAR"): the lamp's mirror image on the floor.
// The floor is metalness 1 (no diffuse term at all) and exact BVH reflections
// are off by default (`exactReflections !== true`), so the bright disc on the
// floor is the glow and ONLY the glow — a pure function of the slot uniforms.
//
// We sample a full-res crop at the SPECULAR HIGHLIGHT of the lamp's OLD
// position and at the highlight of its NEW position, ~3 m away, both BEFORE
// the move and again after the lamp has been held still for >= 2.5 s. PASS =
// each spot's OWN reading moved the way the glow moved: the new spot GAINED
// at least `MIN_RISE`. (The two spots' separation is printed beside it but is
// NOT a gate — the control arm clears it; see the block above `const pass`.)
//
// ⛔ WHY NOT THE ABSOLUTE MARGIN ANY MORE (the GI2 PEDESTAL). Until §19 the
// gate was `after.new - after.old > 14` — one crop's absolute luminance
// against the other's. Under GI2 a GLOSSY PEDESTAL sits under the highlight
// and adds a large, near-equal constant to BOTH crops, which swamps a
// difference-of-levels gate while leaving the mechanism untouched: measured
// on GI2 the new spot rose +49.5 and the old spot fell -13.9 across the same
// move that the absolute gate could no longer see. A per-spot DELTA cancels
// the pedestal exactly, because the pedestal is in the before reading and the
// after reading of the SAME crop and a constant added to both vanishes from
// their difference. Nothing about the scene, the move or the crops changed —
// only which arithmetic the assertion runs on them.
//
// MEASURED, HEAD a48af3a (before Stage 1.2, SRC path): old-spot 30.01 → 1.35
// and new-spot 0.77 → 30.44 — Δnew +29.67, Δold -28.66, separation 58.33.
// MEASURED on GI2: Δnew +49.5, Δold -13.9, separation 63.4.
// MEASURED on the REVERT ARM (uniforms back in `objectGroup`, see below):
// old-spot 30.64 → 30.62 and new-spot 1.06 → 1.59 — Δnew +0.53, Δold -0.02,
// separation 0.55. RE-MEASURED on GI2's revert arm: old-spot 182.73 -> 150.13
// and new-spot 199.42 -> 197.07 — Δnew **-2.35**, Δold -32.6, separation 30.25.
// Note what GI2 changed: the old spot still goes dark (its TRANSPORT sees the
// lamp leave) but the new spot does not light up, so Δnew is the half of the
// story that stayed sensitive and separation is the half that stopped being.
//
// WHY THE DECOY MESHES. One floor mesh would be the only render object of its
// material and would therefore win the once-per-render refresh every frame —
// the exact case a per-object clone still gets right, so the test could never
// go red. Bistro's 453 draws are not that case. Eight tiny decoys share the
// floor's geometry AND material and carry a negative `renderOrder`, so they
// are drawn first and consume the refresh; the floor is then a "draw 2..N"
// object, like almost every draw in a real scene.
//
// HOW TO RE-PROVE THE GROUP MOVE. There is no hatch — make GISystem's
// `giUniform` return `uniform(...args)` without `.setGroup(renderGroup)` (and
// giLight's `intensityUniform` likewise) and re-run: measured old-spot 30.64 →
// 30.62 and new-spot 1.06 → 1.59 — Δnew +0.53 against a gate of 12 and a
// RED. The glow simply stays where the material was compiled, so the new
// crop's own reading never rises, which is the one thing a per-spot delta is
// guaranteed to see.
//
// Env: HEADED=1, TAG=<suffix>, MIN_RISE=<lum> (default 12).
// `MIN_SEPARATION` and `MIN_MARGIN` are RETIRED — see the
// pedestal note above; it named a quantity this test no longer measures.
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:5233/";
const TAG = process.env.TAG ?? "on";
// ── THE TWO GATES, AND WHY THEY ARE DELTAS ──────────────────────────────────
// The absolute margin (`after.new - after.old > 14`) was retired in §19: GI2
// puts a GLOSSY PEDESTAL under the highlight that adds a large constant to
// BOTH crops, so a difference-of-levels gate measures the pedestal as much as
// the glow. These two measure each crop against ITSELF across the move, which
// the pedestal cannot reach — it is present in both readings of a crop.
//   MIN_RISE        the new spot must GAIN this much (measured +29.7 on SRC,
//                   +49.5 on GI2, +0.53 with the uniforms frozen)
//   MIN_SEPARATION  RETIRED AS A GATE (kept as an env knob only so an old
//                   command line does not error). Δnew - Δold measured 30.25
//                   on the FROZEN arm and 30.91 on the working one — it does
//                   not discriminate, because GI2's transport darkens the old
//                   spot whether or not the material uniforms move.
const MIN_RISE = Number(process.env.MIN_RISE ?? 12);
const MIN_SEPARATION = Number(process.env.MIN_SEPARATION ?? 24);
const LAMP_OLD_X = -1.5;
const LAMP_NEW_X = 1.5;
const LAMP_Y = 4.0;
const CROP_R = 34; // px radius of the sampled square

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 840, deviceScaleFactor: 1 });
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\]|GI-ML/.test(text) || message.type() === "error") console.log(`${message.type()}: ${text}`);
});
page.on("pageerror", (error) => console.log(`pageerror: ${error.stack ?? error.message}`));

// ⚠ WITHOUT THIS THE ENGINE LOOP IS ASLEEP AND EVERY NUMBER BELOW IS A LIE.
// editorFramePacing suspends the engine (`host.stop()`) whenever the viewport
// is idle+unfocused, which a headless page always is: measured `loopActive
// false`, `engine.time._frame` frozen at 419 and two byte-identical
// screenshots 4 s apart across a 3 m lamp move. `__editorKeepRendering` is
// that module's own documented harness hatch.
await page.evaluateOnNewDocument(() => {
  globalThis.__editorKeepRendering = true;
  // AND CUT THE HMR SOCKET. This test holds ~40 s of live state on the page;
  // one source save anywhere in the repo (a second agent, an editor autosave)
  // is a Vite full-reload that drops it, and the failure reads as "the
  // uniforms never arrived". The repo's `.no-hmr` sentinel is read at SERVER
  // START, so a running shared dev server cannot be quieted from here — stub
  // the client's socket instead.
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = function (url, protocols) {
    const viteHmr =
      protocols === "vite-hmr" ||
      (Array.isArray(protocols) && protocols.includes("vite-hmr")) ||
      (typeof url === "string" && /vite-hmr|__vite|token=/.test(url));
    if (!viteHmr) return new NativeWebSocket(url, protocols);
    return {
      readyState: 3,
      url: String(url),
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
  };
});
await page.goto(url, { waitUntil: "load", timeout: 30000 });
for (let i = 0; i < 40; i++) {
  const ready = await page.evaluate(() => {
    if (globalThis.__viewport?.orbit) return true;
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
    return !!globalThis.__viewport?.orbit;
  });
  if (ready) break;
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 3000));

await page.evaluate(
  async ({ LAMP_OLD_X, LAMP_Y }) => {
    const { THREE } = await import("/src/engine/index.js");
    await import("/src/modules/index.js");
    const { enableEngineModule } = await import("/src/engine/modules.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    await enableEngineModule(engine, "gi");
    globalThis.__engine = engine;
    globalThis.__THREE = THREE;

    // THE MEASURED SURFACE. metalness 1 ⇒ no diffuse lobe, so the resolve's
    // irradiance texture (which DOES follow the lamp regardless of uniforms)
    // contributes nothing here. roughness 0.2 keeps the glow at full weight:
    // giLight collapses it toward the diffuse limit over smoothstep(0.22,0.6).
    const floorGeo = new THREE.BoxGeometry(16, 0.2, 16);
    const floorMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.2, metalness: 1.0 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.set(0, -0.1, 0);
    floor.renderOrder = 5;
    engine.scene.add(floor);

    // Decoys: same geometry, same material, drawn FIRST. See header.
    for (let i = 0; i < 8; i++) {
      const decoy = new THREE.Mesh(floorGeo, floorMat);
      decoy.scale.setScalar(0.02);
      decoy.position.set(-5.6 + i * 1.6, 0.2, 7.2);
      decoy.renderOrder = -10 + i;
      engine.scene.add(decoy);
    }

    // Diffuse backdrop so the cascade field has something in it (a scene of
    // one metal plane makes every GI health check argue with itself). Far
    // from the sampled crops.
    const wallMat = new THREE.MeshStandardNodeMaterial({ color: 0x9aa0a8, roughness: 0.95, metalness: 0 });
    const wall = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      m.position.set(x, y, z);
      engine.scene.add(m);
    };
    wall(16.4, 6, 0.3, 0, 3, -8.1);
    wall(0.3, 6, 16.4, -8.1, 3, 0);
    wall(0.3, 6, 16.4, 8.1, 3, 0);

    const lampMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x000000, roughness: 1 });
    lampMaterial.emissive = new THREE.Color(0xffffff);
    lampMaterial.emissiveIntensity = 14;
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 1.2), lampMaterial);
    lamp.position.set(LAMP_OLD_X, LAMP_Y, 0);
    lamp.name = "lamp";
    engine.scene.add(lamp);
    globalThis.__lamp = lamp;

    const giEntity = engine.createEntity({ name: "GI" });
    globalThis.__giConfigOverride = { emissiveShadows: true, reflections: true };
    giEntity.addComponent("global-illumination", { quality: "high" });
    console.log("GI-ML scene ready");
  },
  { LAMP_OLD_X, LAMP_Y },
);

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(6000);
for (let i = 0; i < 90; i++) {
  await settle(1000);
  if (!(await page.evaluate(() => globalThis.__engine?.renderSuspended === true))) break;
}
await settle(4000);
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => !!globalThis.__engine?.camera)) break;
  await settle(500);
}

// An HMR reload (another agent saving a source file, no `.no-hmr` sentinel in
// a worktree) drops every global this test planted. Report it as environment
// rather than as a stack trace from `undefined.camera`.
if (!(await page.evaluate(() => !!globalThis.__engine && !!globalThis.__lamp))) {
  console.log("ENVIRONMENT: the page reloaded (HMR?) — __engine/__lamp are gone. Retry.");
  await browser.close();
  process.exit(2);
}

await page.evaluate(() => {
  const engine = globalThis.__engine;
  const viewport = globalThis.__viewport;
  // Camera pushed to +z so the nearest floor pixels (and the decoys) are far
  // from the sampled highlights.
  engine.camera.position.set(0, 12, 9);
  if (viewport?.orbit) {
    viewport.orbit.target.set(0, 0, 0);
    viewport.orbit.update();
  }
  engine.camera.lookAt(0, 0, 0);
  engine.camera.updateMatrixWorld(true);
  engine.camera.layers.disable(31);
  engine.scene.traverse((o) => {
    if (o.isGridHelper || o.type === "GridHelper") o.visible = false;
  });
});
await settle(3500);

// Liveness gate — see the __editorKeepRendering note above. A frozen loop
// reads as "the uniforms never arrived" and would fail every arm identically.
const frameA = await page.evaluate(() => globalThis.__engine?.time?._frame ?? -1);
await settle(1200);
const frameB = await page.evaluate(() => globalThis.__engine?.time?._frame ?? -1);
console.log(`engine frames in 1.2s: ${frameB - frameA} (${frameA} → ${frameB})`);
if (frameB - frameA < 5) {
  console.log("ENVIRONMENT: the engine loop is not ticking — nothing below is measurable.");
  await browser.close();
  process.exit(2);
}

const canvasBox = await page.evaluate(() => {
  const c = [...document.querySelectorAll("canvas")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  return { x: c.r.x, y: c.r.y, width: c.r.width, height: c.r.height };
});

// The specular highlight of a lamp at L seen from camera C on the plane y=0
// is where the ray C→mirror(L) crosses the plane — exact, not a guess, so the
// crop lands on the glow instead of its penumbra.
const highlights = await page.evaluate(
  ({ LAMP_OLD_X, LAMP_NEW_X, LAMP_Y }) => {
    const engine = globalThis.__engine;
    const THREE = globalThis.__THREE;
    engine.camera.updateMatrixWorld(true);
    const cam = engine.camera.position;
    const spot = (lx) => {
      const t = cam.y / (cam.y + LAMP_Y);
      return [cam.x + t * (lx - cam.x), 0.02, cam.z + t * (0 - cam.z)];
    };
    const project = ([x, y, z]) => {
      const v = new THREE.Vector3(x, y, z).project(engine.camera);
      return [(v.x + 1) / 2, (1 - v.y) / 2];
    };
    const old = spot(LAMP_OLD_X);
    const now = spot(LAMP_NEW_X);
    return {
      camera: [cam.x, cam.y, cam.z],
      oldWorld: old,
      newWorld: now,
      old: project(old),
      new: project(now),
      lampOldScreen: project([LAMP_OLD_X, LAMP_Y, 0]),
      lampNewScreen: project([LAMP_NEW_X, LAMP_Y, 0]),
    };
  },
  { LAMP_OLD_X, LAMP_NEW_X, LAMP_Y },
);

const cropMean = async (tag) => {
  const png = await page.screenshot({ clip: canvasBox });
  await sharp(png).toFile(`scripts/gi-diag-moved-lamp-${TAG}-${tag}.png`);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const meanAt = ([fx, fy]) => {
    const cx = Math.round(fx * info.width);
    const cy = Math.round(fy * info.height);
    let sum = 0;
    let n = 0;
    for (let y = cy - CROP_R; y <= cy + CROP_R; y++) {
      if (y < 0 || y >= info.height) continue;
      for (let x = cx - CROP_R; x <= cx + CROP_R; x++) {
        if (x < 0 || x >= info.width) continue;
        const i = (y * info.width + x) * info.channels;
        sum += lum(data[i], data[i + 1], data[i + 2]);
        n++;
      }
    }
    return n ? sum / n : 0;
  };
  return { old: meanAt(highlights.old), new: meanAt(highlights.new) };
};

const before = await cropMean("before");

// Move it as a MOVER (smooth, ~1.2 s) rather than a teleport: a teleport can
// trip a GI rebuild, and a rebuild re-initializes the very uniform clones this
// test is about — which would hide the bug it exists to catch.
const moveReport = await page.evaluate(
  ({ LAMP_OLD_X, LAMP_NEW_X }) =>
    new Promise((resolve) => {
      const engine = globalThis.__engine;
      const frames0 = engine.time?._frame ?? -1;
      const lamp = globalThis.__lamp;
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / 1200);
        lamp.position.x = LAMP_OLD_X + (LAMP_NEW_X - LAMP_OLD_X) * t;
        lamp.updateMatrixWorld(true);
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          const slot = engine.modules?.get?.("gi")?.system?.state?.light?.emitterSlots?.[0];
          resolve({
            lampX: lamp.position.x,
            lampWorldX: lamp.matrixWorld.elements[12],
            matrixAutoUpdate: lamp.matrixAutoUpdate,
            slotCenter: slot ? [slot.center.value.x, slot.center.value.y, slot.center.value.z] : null,
            slotRadius: slot ? slot.radius.value : null,
            framesRendered: (engine.time?._frame ?? -1) - frames0,
            loopActive: engine.loopActive === true,
          });
        }
      };
      requestAnimationFrame(step);
    }),
  { LAMP_OLD_X, LAMP_NEW_X },
);
await settle(3000); // hold still >= 2.5 s
const restReport = await page.evaluate(() => {
  const engine = globalThis.__engine;
  const slot = engine.modules?.get?.("gi")?.system?.state?.light?.emitterSlots?.[0];
  return {
    lampWorldX: globalThis.__lamp.matrixWorld.elements[12],
    slotCenter: slot ? [slot.center.value.x, slot.center.value.y, slot.center.value.z] : null,
    slotMoved: slot ? slot.moved.value : null,
  };
});
console.log(`move report: ${JSON.stringify(moveReport)}`);
console.log(`rest report: ${JSON.stringify(restReport)}`);

const after = await cropMean("after");

const r2 = (n) => Math.round(n * 100) / 100;
console.log(`\n=== moved lamp (${TAG}) ===`);
console.log(`camera ${highlights.camera.map(r2).join(", ")}`);
console.log(`old highlight world ${highlights.oldWorld.map(r2).join(", ")}  screen ${highlights.old.map(r2).join(", ")}`);
console.log(`new highlight world ${highlights.newWorld.map(r2).join(", ")}  screen ${highlights.new.map(r2).join(", ")}`);
console.log(`lamp screen: old ${highlights.lampOldScreen.map(r2).join(", ")}  new ${highlights.lampNewScreen.map(r2).join(", ")}`);
console.log(`before move: old-spot ${r2(before.old)}  new-spot ${r2(before.new)}  (old-new ${r2(before.old - before.new)})`);
console.log(`after  move: old-spot ${r2(after.old)}  new-spot ${r2(after.new)}  (new-old ${r2(after.new - after.old)})`);
console.log(`swing: old-spot ${r2(before.old - after.old)} darker, new-spot ${r2(after.new - before.new)} brighter`);

// THE GATE. Per-spot deltas, not levels — see the constants at the top. Both
// raw crop readings are still printed above, so a failure is attributable to
// a spot rather than only to the derived number.
const dNew = after.new - before.new; // the glow ARRIVING (positive when it works)
const dOld = after.old - before.old; // the glow LEAVING (negative when it works)
const separation = dNew - dOld;
const margin = after.new - after.old; // the retired absolute gate, kept as a receipt
console.log(
  `deltas: Δnew ${r2(dNew)} (need >${MIN_RISE})  Δold ${r2(dOld)}  ` +
  `separation Δnew-Δold ${r2(separation)} [receipt, NOT a gate — see below]  ` +
  `[absolute after-move margin ${r2(margin)}, no longer gated — GI2 pedestal]`,
);
// ⛔⛔ SEPARATION IS A RECEIPT, NOT A GATE, AND THE REVERT ARM IS WHY.
//
// It was written as a second gate (`separation > 24`) and the control arm was
// run to check it. The control arm PASSED it: with the uniforms frozen,
// Δnew -2.35 / Δold -32.6 / separation **30.25** — comfortably over a gate of
// 24, on the arm where the mechanism is switched off. GI2's TRANSPORT still
// darkens the old spot when the lamp leaves (the window is voxelized from the
// live scene and does not care what the material's uniforms say), so the
// separation is carried almost entirely by Δold and says nothing about
// whether the glow ARRIVED. On the healthy arm it read 30.91 against that
// same 24 — thinner than the broken arm's. A gate that a broken arm clears
// more comfortably than a working one is measuring the wrong thing twice.
//
// ⭐ Δnew IS the mechanism: on GI2 it is +27.9 working and −2.35 frozen, and
// `MIN_RISE = 12` sits between them with 2.3x head-room below and the whole
// sign of the number above. One gate, and it is the one the control arm can
// actually fail.
const pass = dNew > MIN_RISE;
console.log(
  pass
    ? `PASS: the glow MOVED — the new spot gained ${r2(dNew)} lum (>${MIN_RISE}) while the old spot ` +
      `changed ${r2(dOld)} (separation ${r2(separation)}, reported only)`
    : `FAIL: the glow did not move — new spot gained ${r2(dNew)} lum (need >${MIN_RISE}), old spot ` +
      `changed ${r2(dOld)} — the emitter slot uniforms are not reaching the material`,
);
console.log(`SHOT scripts/gi-diag-moved-lamp-${TAG}-after.png`);
await browser.close();
process.exit(pass ? 0 : 1);
