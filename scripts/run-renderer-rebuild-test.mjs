/**
 * Gate for the COALESCED renderer-rebuild decision (Engine.applySettings →
 * #applyRendererOptionsIfChanged).
 *
 *   node scripts/run-renderer-rebuild-test.mjs
 *
 * The defect this pins (user, 2026-08-25, "gi keeps crushing, even on other
 * scene"): stop-play restores state as `applySettings(DEFAULTS)` then
 * `applySettings(snapshot)` in one tick, and the old immediate before/after
 * comparison saw a renderer-option change in EACH call — so every play-stop of
 * a scene whose renderer block differs from the defaults (the Level:
 * `antialias: false` vs the default `true`) tore the renderer down TWICE.
 * Each teardown destroys the GPU DEVICE: `[gpu] DEVICE LOST (destroyed)` in
 * the console, every pipeline gone, GI re-minting from nothing, and the
 * recovery races surfacing as async-pipeline failures and null-`layers`
 * unhandled rejections. A round trip that ends where it began must cost
 * NOTHING.
 */
import assert from "node:assert/strict";

const stubElement = () => ({
  style: {},
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  classList: { add() {}, remove() {} },
  parentElement: null,
});
globalThis.document ??= {
  body: stubElement(),
  createElement: stubElement,
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const { Engine, registerBuiltInComponents } = await import("../src/engine/index.js");
const { rendererConstructorOptions } = await import("../src/engine/sceneSettings.js");

registerBuiltInComponents();

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

/**
 * An engine wearing a fake renderer that counts teardown. The fake carries
 * exactly what `applySettingsToScene` and the teardown path touch; a real
 * WebGPURenderer cannot exist under Node and is not what is under test.
 */
function makeEngine(rendererSettings) {
  const engine = new Engine();
  engine.settings.renderer = { ...engine.settings.renderer, ...rendererSettings };
  const fake = {
    domElement: stubElement(),
    shadowMap: {},
    toneMapping: 0,
    toneMappingExposure: 1,
    info: { render: { calls: 0 } },
    setAnimationLoop() {},
    dispose() {
      engine.__disposeCount = (engine.__disposeCount ?? 0) + 1;
    },
    backend: { device: null },
  };
  engine.renderer = fake;
  engine.rendererReady = true;
  engine.__disposeCount = 0;
  engine._rendererBuiltWith = rendererConstructorOptions(engine.settings);
  return engine;
}

/** Let the end-of-tick option check (a macrotask) actually run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

await check("⛔⛔ a play-stop ROUND TRIP through the defaults destroys NO device", async () => {
  // The Level's authored state, differing from the defaults on both keys.
  const engine = makeEngine({ antialias: false, samples: 2 });
  // Stop-play, exactly as Engine's own serialization note describes it:
  // DEFAULTS first, the scene's snapshot second, one tick apart.
  await engine.applySettings({ renderer: { antialias: true, samples: 4 } });
  await engine.applySettings({ renderer: { antialias: false, samples: 2 } });
  await settle();
  assert.equal(
    engine.__disposeCount, 0,
    `the round trip ended where it began and still destroyed the device ${engine.__disposeCount} time(s)`
      + " — that is the play-stop crash",
  );
});

await check("⭐ a REAL antialias change still rebuilds — once, with the final values", async () => {
  const engine = makeEngine({ antialias: false, samples: 2 });
  await engine.applySettings({ renderer: { antialias: true, samples: 4 } });
  await settle();
  assert.equal(
    engine.__disposeCount, 1,
    `a real construction-option change must tear down exactly once, saw ${engine.__disposeCount}`,
  );
});

await check("⭐ a samples change under antialias:false is NOT a rebuild — the option is inert", async () => {
  // rendererConstructorOptions collapses samples to 0 whenever antialias is
  // off, so 2 vs 4 produce byte-identical construction options. The raw-key
  // comparison used to pay a device for a value the constructor never reads.
  const engine = makeEngine({ antialias: false, samples: 2 });
  await engine.applySettings({ renderer: { antialias: false, samples: 4 } });
  await settle();
  assert.equal(
    engine.__disposeCount, 0,
    "samples is ignored while antialias is off — rebuilding for it destroys a device for nothing",
  );
});

await check("three flips in one tick coalesce to the FINAL state's single answer", async () => {
  const engine = makeEngine({ antialias: false, samples: 2 });
  await engine.applySettings({ renderer: { antialias: true } });
  await engine.applySettings({ renderer: { antialias: false } });
  await engine.applySettings({ renderer: { antialias: true } });
  await settle();
  assert.equal(
    engine.__disposeCount, 1,
    `the net change is one antialias flip — expected one teardown, saw ${engine.__disposeCount}`,
  );
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
