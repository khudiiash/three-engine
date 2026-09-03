// Gates the GI debug view `"path-tracer"`: the library loads, BVH builds, and
// a sample dispatches without the view failing closed. Picture quality is not
// gated — only "it actually runs".
//
//   npx vite --port 5251 --strictPort --host 127.0.0.1
//   node scripts/run-gi-pathtracer-probe.mjs http://127.0.0.1:5251/
import puppeteer from "puppeteer-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:5251/";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: mkdtempSync(join(tmpdir(), "gi-pathtracer-")),
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPU",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
const failures = [];
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\].*path-tracer|Illegal invocation|GI-PT/.test(text)) console.log(`  ${text}`);
  if (/\[gi\] debug view "path-tracer" failed/.test(text)) failures.push(text);
});

try {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 4000));

  await page.evaluate(async () => {
    const { THREE } = await import("/src/engine/index.js");
    await import("/src/modules/index.js");
    const { enableEngineModule } = await import("/src/engine/modules.js");
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    await enableEngineModule(engine, "gi");
    globalThis.__engine = engine;
    globalThis.__editorApi.viewport.freezeWhenUnfocused(false);

    const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, metalness: 0 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 8), mat);
    floor.position.set(0, -0.1, 0);
    engine.scene.add(floor);
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshStandardMaterial({
      color: 0x4488cc, roughness: 0.4, metalness: 0.1,
    }));
    box.position.set(0, 0.7, 0);
    engine.scene.add(box);

    const sun = new THREE.DirectionalLight(0xfff2dd, 3);
    sun.position.set(4, 8, 3);
    engine.scene.add(sun);

    // Editor junk that used to crash setCommonAttributes: empty LineSegments
    // (blockout overlay), empty Mesh, and a hidden editor-only group.
    const overlay = new THREE.Group();
    overlay.visible = false;
    overlay.userData.editorOnly = true;
    overlay.add(new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial()));
    overlay.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff })));
    engine.scene.add(overlay);

    // Shader-graph albedo lives on colorNode; .color stays white and .map is
    // null — the path tracer used to shade those meshes as flat white.
    const { uniform } = await import("/node_modules/three/build/three.tsl.js");
    const nodeMat = new THREE.MeshStandardNodeMaterial();
    nodeMat.color.set(0xffffff);
    nodeMat.map = null;
    nodeMat.colorNode = uniform(new THREE.Color(0xcc3344));
    const nodeBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), nodeMat);
    nodeBox.position.set(2, 0.5, 0);
    engine.scene.add(nodeBox);

    // Uber merge proxy: the stand-in has no .map. The hidden member has the
    // real material and must be the one that gets traced.
    const memberMat = new THREE.MeshStandardMaterial({ color: 0x2266aa, roughness: 0.7 });
    const member = new THREE.Mesh(new THREE.BoxGeometry(1, 1.6, 1), memberMat);
    member.position.set(-2, 0.8, 0);
    member.visible = false;
    engine.scene.add(member);
    const proxy = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1.6, 1),
      new THREE.MeshStandardNodeMaterial({ color: 0xffffff }),
    );
    proxy.position.copy(member.position);
    proxy.userData.mergeProxy = true;
    proxy.userData.batchProxy = true;
    member.userData.mergedInto = proxy;
    engine.scene.add(proxy);

    const giEntity = engine.createEntity({ name: "GI" });
    const gi = giEntity.addComponent("global-illumination", { autoFit: true, quality: "low" });
    gi.setProp("debugView", "path-tracer");
    globalThis.__gi = gi;
    console.log("GI-PT scene ready");
  });

  await page.evaluate(() => globalThis.__editorApi.viewport.setCamera([4, 2.4, 5], [0, 0.6, 0]));
  await new Promise((resolve) => setTimeout(resolve, 8000));

  const status = await page.evaluate(() => {
    const system = globalThis.__engine.modules.get("gi")?.system;
    const pt = system?.pathTracer;
    return {
      wanted: pt?.wanted ?? false,
      active: pt?.active ?? false,
      failed: pt?._failed === true,
      error: pt?._lastError ?? null,
      hasTracer: !!pt?._tracer,
      debugView: globalThis.__gi?.props?.debugView ?? null,
    };
  });
  console.log(`GI-PT status ${JSON.stringify(status)}`);

  if (status.failed || status.error) {
    failures.push(`failed closed: ${status.error ?? "unknown"}`);
  }
  if (!status.wanted) failures.push("path tracer was not wanted after setProp");
  if (!status.active || !status.hasTracer) failures.push("path tracer did not become active");
} catch (error) {
  failures.push(error?.message ?? String(error));
}

await browser.close();
if (failures.length) {
  console.log(`gi-pathtracer: FAIL\n  ${failures.slice(0, 6).join("\n  ")}`);
  process.exit(1);
}
console.log("gi-pathtracer: PASS");
process.exit(0);
