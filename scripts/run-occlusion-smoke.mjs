/**
 * GPU occlusion culling in a real browser, against a real WebGPU frame
 * (roadmap item 14).
 *
 * The headless test proves the maths against a fabricated depth buffer. This
 * proves the buffer is real:
 *
 *   - that the occluder pass actually renders, and writes view-space METRES —
 *     the pyramid is read back and compared against the distance to the wall,
 *   - that the readback survives WebGPU's row padding, which if it did not
 *     would produce a sheared depth buffer and cull things in the wrong places,
 *   - and the only number that matters at the end: that DRAW CALLS go down. A
 *     culling system that hides objects without removing draws has cost a depth
 *     pass and bought nothing.
 *
 *   npx vite --port 5201
 *   node scripts/run-occlusion-smoke.mjs [url]
 *
 * HEADED=1 to watch it run.
 */
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5201/";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

const run = async (body, arg) =>
  page.evaluate(
    // eslint-disable-next-line no-new-func
    (source, value) => new Function(`return (${source})`)()(value),
    body.toString(),
    arg ?? null,
  );

/** Waits `n` animation frames inside the page. */
const frames = (n) =>
  run((count) =>
    new Promise((resolve) => {
      let i = 0;
      const step = () => (++i < count ? requestAnimationFrame(step) : resolve(true));
      requestAnimationFrame(step);
    }), n);

try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await page.waitForFunction(() => !!globalThis.__viewport?.orbit, { timeout: 60000 });
  await wait(4000);

  // --- Scene -----------------------------------------------------------------
  const built = await page.evaluate(async () => {
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__engine = engine;
    const THREE = globalThis.__ENGINE_THREE__;

    // Isolate the occlusion contract. Background regrouping emits structural
    // invalidations by design and would turn a camera-settle test into a race
    // against the batching system rather than a visibility test.
    engine.applySettings({
      ...engine.settings,
      performance: {
        ...engine.settings.performance,
        autoBatching: false,
        staticMerging: false,
        occlusionCulling: false,
      },
    });

    // A wall across the view at 20 m, and forty props hidden behind it at 60 m.
    // Each prop gets its own geometry so static batching cannot merge them —
    // otherwise the draw-call comparison at the end would be measuring batching
    // rather than culling.
    const wall = engine.createEntity({ name: "Wall" });
    wall.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
    wall.object3D.position.set(0, 0, -20);
    wall.object3D.scale.set(60, 60, 1);

    const hidden = [];
    for (let i = 0; i < 40; i++) {
      const prop = engine.createEntity({ name: `Hidden${i}` });
      const mesh = prop.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
      mesh.mesh.geometry = new THREE.BoxGeometry(1 + i * 0.001, 1, 1);
      prop.object3D.position.set(-10 + (i % 10) * 2, -4 + Math.floor(i / 10) * 2, -60);
      hidden.push(prop.id);
    }
    // One prop in front of the wall and one well off to the side: the controls,
    // and the two objects whose disappearance would be a real bug.
    const inFront = engine.createEntity({ name: "InFront" });
    inFront.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
    inFront.object3D.position.set(0, 0, -10);
    const edge = engine.createEntity({ name: "VisibleEdgeControl" });
    edge.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
    edge.object3D.position.set(8, 5, -10);
    edge.object3D.scale.set(1.5, 1.5, 1.5);
    const aside = engine.createEntity({ name: "Aside" });
    aside.addComponent("mesh", { geometry: "box", castShadow: false, receiveShadow: false });
    aside.object3D.position.set(120, 0, -60);

    globalThis.__ids = { wall: wall.id, hidden, inFront: inFront.id, edge: edge.id, aside: aside.id };

    const viewport = globalThis.__viewport;
    viewport.orbit.enableDamping = false;
    viewport.camera.position.set(0, 0, 10);
    viewport.orbit.target.set(0, 0, -20);
    viewport.orbit.update();
    engine.scene.updateMatrixWorld(true);
    return { entities: engine.entities.size, enabled: engine.occlusion.enabled };
  });
  check("the occlusion scene was built", built.entities >= 44, `${built.entities} entities`);
  check("occlusion culling is off by default", built.enabled === false);

  await frames(60);
  const before = await run(() => {
    const e = globalThis.__engine;
    return {
      drawCalls: e.stats.readout.drawCalls,
      visible: globalThis.__ids.hidden.filter((id) => e.getEntity(id).object3D.visible).length,
    };
  });
  check(
    "with it off, all forty hidden props are drawn",
    before.visible === 40,
    `${before.visible} visible, ${before.drawCalls} draw calls`,
  );

  // --- Turn it on through the SETTINGS path (what the editor toggle does) -----
  const enabled = await run(() => {
    const e = globalThis.__engine;
    const control = e.getEntity(globalThis.__ids.inFront).getComponent("mesh").mesh;
    const onBeforeRender = control.onBeforeRender;
    globalThis.__actualDrawableQueryDraws = 0;
    control.onBeforeRender = function (...args) {
      if (this.occlusionTest === true) globalThis.__actualDrawableQueryDraws++;
      return onBeforeRender.apply(this, args);
    };
    e.applySettings({
      ...e.settings,
      performance: { ...e.settings.performance, occlusionCulling: true },
    });
    return { enabled: e.occlusion.enabled };
  });
  check("the scene setting arms the system", enabled.enabled === true);

  // Native query results are asynchronous, and the system deliberately waits
  // for fresh result waves before it hides anything. Sample the short-lived
  // query flags while waiting: the query must wrap the REAL drawable's draw.
  // A detached bounds draw runs afterwards and can mistake the drawable's own
  // depth for an occluder.
  const queryPath = await run(() => {
    const e = globalThis.__engine;
    let detachedBoundsFrames = 0;
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        let detached = false;
        e.scene.traverse((object) => {
          if (object.name === "Occlusion bounds" && object.occlusionTest === true) detached = true;
        });
        if (detached) detachedBoundsFrames++;
        if (++i < 120) return requestAnimationFrame(step);
        resolve({ actualDrawableDraws: globalThis.__actualDrawableQueryDraws, detachedBoundsFrames });
      };
      requestAnimationFrame(step);
    });
  });
  check(
    "native queries wrap the actual drawable",
    queryPath.actualDrawableDraws > 0,
    JSON.stringify(queryPath),
  );
  check(
    "native queries do not use a detached self-occluding bounds draw",
    queryPath.detachedBoundsFrames === 0,
    JSON.stringify(queryPath),
  );

  const native = await run(() => {
    const e = globalThis.__engine;
    return {
      webgpu: e.renderer.backend?.isWebGPUBackend === true,
      pyramidReady: e.occlusion.pyramid.ready,
      occluders: e.occlusion.stats.occluders,
      tested: e.occlusion.stats.tested,
      culled: e.occlusion.stats.culled,
      nativeActive: e.occlusion.stats.nativeActive,
      nativeQueries: e.occlusion.stats.nativeQueries,
      nativeResultWaves: e.occlusion.stats.nativeResultWaves,
      nativeReady: e.occlusion.stats.nativeReady,
    };
  });
  check("the test is running on WebGPU", native.webgpu === true);
  check(
    "native queries avoided the legacy depth/readback pyramid",
    native.pyramidReady === false,
    `pyramid ready: ${native.pyramidReady}`,
  );
  check("native query results were consumed", native.tested >= 40, JSON.stringify(native));

  const after = await run(() => {
    const e = globalThis.__engine;
    return {
      drawCalls: e.stats.readout.drawCalls,
      hidden: globalThis.__ids.hidden.filter((id) => e.getEntity(id)._occluded === true).length,
      inFront: e.getEntity(globalThis.__ids.inFront)._occluded === true,
      edge: e.getEntity(globalThis.__ids.edge)._occluded === true,
      aside: e.getEntity(globalThis.__ids.aside)._occluded === true,
      wall: e.getEntity(globalThis.__ids.wall)._occluded === true,
      culled: e.occlusion.stats.culled,
    };
  });
  check(
    "every prop behind the wall is culled",
    after.hidden === 40,
    `${after.hidden}/40 culled, stats say ${after.culled}`,
  );
  check("the prop in FRONT of the wall is not", after.inFront === false);
  check("the edge control in front of the wall is not", after.edge === false);
  check("the prop beside the wall is not", after.aside === false);
  check("and the wall itself is not culled against its own depth", after.wall === false);
  check(
    "draw calls actually went down — the whole point",
    after.drawCalls < before.drawCalls - 30,
    `${before.drawCalls} → ${after.drawCalls}`,
  );

  // --- Camera-motion stability ---------------------------------------------
  // Keep the wall covering the hidden grid while translating AND rotating the
  // camera. Fail-open restoration of a hidden prop is harmless here because it
  // still fails the wall's ordinary depth test. The visual correctness bug is
  // the opposite direction: consuming a late query from an older pose can make
  // the wall or a visible control disappear. That may last only one presented
  // frame, so inspect every frame rather than relying on a final snapshot.
  const motion = await run(() => {
    const e = globalThis.__engine;
    const viewport = globalThis.__viewport;
    const samples = [];
    let frame = 0;
    let missingControlFrames = 0;
    let worstHidden = 40;

    return new Promise((resolve) => {
      const move = () => {
        const phase = frame * 0.19;
        // These motions never expose an edge of the 60x60 wall. Varying the
        // target independently makes this a rotation test as well as a camera
        // translation test.
        viewport.camera.position.set(Math.sin(phase) * 1.5, Math.cos(phase * 0.73) * 0.75, 10);
        viewport.orbit.target.set(Math.cos(phase * 0.61) * 2.5, Math.sin(phase * 0.47), -20);
        viewport.orbit.update();

        requestAnimationFrame(() => {
          const hiddenNow = globalThis.__ids.hidden.filter((id) => e.getEntity(id)._occluded === true).length;
          const controlState = [globalThis.__ids.wall, globalThis.__ids.inFront, globalThis.__ids.edge]
            .map((id) => e.getEntity(id))
            .map((entity) => ({ occluded: entity._occluded === true, visible: entity.object3D.visible === true }));
          const missing = controlState.some((state) => state.occluded || !state.visible);
          if (missing) missingControlFrames++;
          worstHidden = Math.min(worstHidden, hiddenNow);
          if (samples.length < 8 && missing) {
            samples.push({ frame, hiddenNow, controlState });
          }
          frame++;
          if (frame < 180) move();
          else resolve({ missingControlFrames, worstHidden, samples });
        });
      };
      move();
    });
  });
  check(
    "camera motion never culls or hides visible controls",
    motion.missingControlFrames === 0,
    JSON.stringify(motion),
  );

  // Exercise many query arm/resolve cycles. A detached bounds mesh rendered
  // after the real mesh can fail every one of its samples against the real
  // mesh's own depth, so the bug presents as a visible object disappearing a
  // few frames after the camera stops rather than while it is moving.
  const settles = await run(() => {
    const e = globalThis.__engine;
    const viewport = globalThis.__viewport;
    const failures = [];
    let pose = 0;
    let frameAtPose = 0;
    let generationAtMove = 0;
    let missingFrames = 0;
    let recullFailures = 0;

    return new Promise((resolve) => {
      const setPose = () => {
        generationAtMove = e.occlusion.stats.nativeGeneration;
        const phase = pose * 0.83;
        viewport.camera.position.set(Math.sin(phase) * 1.25, Math.cos(phase * 0.57) * 0.5, 10);
        viewport.orbit.target.set(Math.cos(phase * 0.71) * 2, Math.sin(phase * 0.43) * 0.75, -20);
        viewport.orbit.update();
        frameAtPose = 0;
      };
      const sample = () => {
        const hiddenNow = globalThis.__ids.hidden.filter((id) => e.getEntity(id)._occluded === true).length;
        const visibleControls = [globalThis.__ids.wall, globalThis.__ids.inFront, globalThis.__ids.edge]
          .map((id) => e.getEntity(id))
          .filter((entity) => entity._occluded !== true && entity.object3D.visible === true)
          .length;
        if (visibleControls !== 3) {
          missingFrames++;
          if (failures.length < 10) failures.push({ pose, frameAtPose, hiddenNow, visibleControls });
        }
        frameAtPose++;
        const stats = e.occlusion.stats;
        const freshSettledResult =
          stats.nativeGeneration > generationAtMove &&
          stats.nativeActive === false &&
          stats.tested >= 40;
        if (!freshSettledResult && frameAtPose < 360) return requestAnimationFrame(sample);
        if (!freshSettledResult || hiddenNow < 40) {
          recullFailures++;
          if (failures.length < 10) {
            failures.push({ pose, frameAtPose, hiddenNow, generationAtMove, stats, recull: false });
          }
        }
        pose++;
        if (pose < 3) {
          setPose();
          requestAnimationFrame(sample);
        } else {
          resolve({ poses: pose, missingFrames, recullFailures, failures });
        }
      };
      setPose();
      requestAnimationFrame(sample);
    });
  });
  check(
    "repeated settle cycles never self-occlude visible drawables",
    settles.missingFrames === 0,
    JSON.stringify(settles),
  );
  check(
    "each settled camera pose restores full occlusion",
    settles.recullFailures === 0,
    JSON.stringify(settles),
  );

  // --- Moving the camera so the wall no longer covers them -------------------
  const moved = await run(() => {
    const e = globalThis.__engine;
    const viewport = globalThis.__viewport;
    // Around the side of the wall: the props are now in clear view, and the
    // stale buffer must not keep them hidden for more than the frame or two it
    // takes a new capture to land.
    // Look at the props from behind them: the wall is now farther away, so it
    // cannot occlude them, and their grid still faces the camera (viewing the
    // grid edge-on would correctly let the front row occlude the rows behind).
    viewport.camera.position.set(0, 0, -100);
    viewport.orbit.target.set(0, 0, -60);
    viewport.orbit.update();
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (++i < 120) return requestAnimationFrame(step);
        resolve({
          hidden: globalThis.__ids.hidden.filter((id) => e.getEntity(id)._occluded === true).length,
          drawCalls: e.stats.readout.drawCalls,
          stats: e.occlusion.stats,
          cameraX: e.camera.position.x,
          viewportX: viewport.camera.position.x,
        });
      };
      requestAnimationFrame(step);
    });
  });
  check(
    "stepping around the wall brings them all back",
    moved.hidden === 0,
    JSON.stringify(moved),
  );

  // --- Turning it off --------------------------------------------------------
  const off = await run(() => {
    const e = globalThis.__engine;
    const viewport = globalThis.__viewport;
    viewport.camera.position.set(0, 0, 10);
    viewport.orbit.target.set(0, 0, -20);
    viewport.orbit.update();
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (i === 120) {
          const stillHidden = globalThis.__ids.hidden.filter((id) => e.getEntity(id)._occluded === true).length;
          e.applySettings({
            ...e.settings,
            performance: { ...e.settings.performance, occlusionCulling: false },
          });
          globalThis.__stillHidden = stillHidden;
        }
        if (++i < 128) return requestAnimationFrame(step);
        resolve({
          culledWhileOn: globalThis.__stillHidden,
          occluded: globalThis.__ids.hidden.filter((id) => e.getEntity(id)._occluded === true).length,
          visible: globalThis.__ids.hidden.filter((id) => e.getEntity(id).object3D.visible).length,
          enabled: e.occlusion.enabled,
          drawCalls: e.stats.readout.drawCalls,
          layerTags: globalThis.__ids.hidden.filter((id) => {
            const mesh = e.getEntity(id).getComponent("mesh").mesh;
            return mesh.layers.isEnabled(29);
          }).length,
        });
      };
      requestAnimationFrame(step);
    });
  });
  check("the props were culled again when the camera came back", off.culledWhileOn === 40, `${off.culledWhileOn}/40`);
  check(
    "switching it off puts every one of them back on screen",
    off.occluded === 0 && off.visible === 40,
    JSON.stringify(off),
  );
  check(
    "…and clears the occluder layer tags it wrote, so batching is not left split",
    off.layerTags === 0,
    `${off.layerTags} still tagged`,
  );

  // The filter is narrow ON PURPOSE. An earlier version dropped anything
  // matching /WebGPU/, which swallowed "Render pipeline creation failed …" —
  // the message that was the entire reason the depth pass wrote nothing. A
  // validation error from the backend is exactly the class of failure a smoke
  // exists to catch, so only the known-benign startup noise is ignored.
  const real = errors.filter((e) => {
    if (/GPUValidationError|pipeline creation failed|Uncaptured/i.test(e)) return true;
    if (/GPUAdapter|Deprecation|favicon|WebGPU is experimental/i.test(e)) return false;
    return !/Failed to load resource/i.test(e);
  });
  if (real.length) {
    console.log("\nConsole errors:");
    for (const e of real.slice(0, 8)) console.log(`  ${e}`);
  }
  check("no console errors", real.length === 0, `${real.length}`);
} catch (error) {
  check("the smoke ran to completion", false, error.message);
} finally {
  await browser.close();
}

console.log(`\nOCCLUSION-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
