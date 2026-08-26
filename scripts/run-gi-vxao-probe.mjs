// VXAO RUNTIME GATE
//
// Checks the core claims the implementation has to make on a real WebGPU device:
//   1. a voxelized occluder wholly outside the camera frustum darkens a nearby
//      visible floor point (the capability screen-space AO cannot provide);
//   2. that term reaches the image at all;
//   3. the existing screen-space contact AO still contributes with VXAO live;
//   4. `profile.giPasses` names and prices the VXAO pass;
//   5. the fully composed graph compiles at the portable eight-storage-buffer
//      limit with no WebGPU validation errors.
//
// ── WHY (1) READS THE TEXTURE AND NOT THE SCREEN ────────────────────────────
// It used to compare the SCREEN LUMINANCE of `hiddenFloor` against `openFloor`.
// Two things were wrong with that, both measured rather than argued:
//
//   · AUTHORITY. The resolve multiplies AO into the GATHER term only — emitter
//     and analytic direct carry their own traced shadows. This room is lit by
//     an emissive ceiling panel, so the gather is a few percent of what these
//     floor pixels are, and check (3) shows it: screen-space AO at FULL
//     strength moves the contact pixel by 2.7%. Asking that instrument for a
//     0.025 contrast delta is asking for most of the authority it has.
//   · PREMISE. The old arm also forced `radius: 1`, i.e. a 4 m reach, and at
//     4 m in a 9x3x9 m room `openFloor` is genuinely the MORE enclosed of the
//     two — it stands 2.1 m from a 9 m wall while `hiddenFloor` has open space
//     behind its little slab. That is not an estimator artifact: brute-force
//     ray-cast AO over the same voxels says the same thing (see
//     scripts/lib/vxaoOffline.mjs, which scores the march against it). The
//     control was only a control at the reach the module actually ships.
//
// So (1) now reads the VXAO texture the pass itself wrote, at the gbuffer
// pixels nearest each subject, and leaves `radius` at its shipped value; (2)
// keeps an explicit screen-space assertion so "the estimator is right but
// nothing consumes it" still fails.
//
// Start a fresh Vite server, then:
//   node scripts/run-gi-vxao-probe.mjs http://127.0.0.1:5201/
// Env: QUALITY=high SETTLE=20000 VXAO_BUDGET_MS=2.5 PNG=1 HEADED=1
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeVxaoProject, VXAO_POSE, VXAO_SUBJECTS } from "./lib/makeVxaoProject.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5201/";
const QUALITY = process.env.QUALITY ?? "high";
const SETTLE = Number(process.env.SETTLE ?? 20_000);
const BUDGET_MS = Number(process.env.VXAO_BUDGET_MS ?? 2.5);
const VIEW = (process.env.VIEW ?? "1200x800").split("x").map(Number);
const OUT = ".gi-shots/vxao";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = path.resolve("scripts/.gi-vxao").replaceAll("\\", "/");
mkdirSync(OUT, { recursive: true });
await makeVxaoProject(root, { quality: QUALITY });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  // A scratch profile avoids the shared-default-profile lock documented in
  // AGENTS.md and keeps the two arms independent.
  userDataDir: path.resolve("scripts/.chrome-vxao-probe"),
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(vxaoEnabled) {
  const label = vxaoEnabled ? "on" : "off";
  const page = await browser.newPage();
  await page.setViewport({ width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  const validationErrors = [];
  let built = false;
  page.on("console", (message) => {
    const line = message.text();
    if (/\[gi\] built/.test(line)) built = true;
    if (/WebGPU validation|exceeds the maximum per-stage limit|invalid ComputePipeline|pipeline.*invalid/i.test(line)) {
      validationErrors.push(line);
    }
  });
  page.on("pageerror", (error) => validationErrors.push(error.stack ?? error.message));
  await page.evaluateOnNewDocument((project, enabled) => {
    localStorage.clear();
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    globalThis.__engineLimitsCap = { maxStorageBuffersPerShaderStage: 8 };
    // Explicit on as well as off keeps the experiment independent of the
    // shipping default while the feature is being benchmarked.
    globalThis.__giVxao = enabled;
  }, root, vxaoEnabled);

  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30_000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, root);
  for (let i = 0; i < 180 && !built; i++) await wait(1000);
  if (!built) throw new Error(`${label}: GI never built`);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60_000 });
  await page.evaluate((pose) => globalThis.__editorApi.call("viewport.setCamera", pose), VXAO_POSE);
  // `[gi] built` means the bundle exists, not that the occupancy density has
  // reached the screen. VXAO over an empty boot field correctly returns 1 and
  // would turn the visual arm into a timing-dependent false failure.
  await page.waitForFunction(async () => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    return engine.modules.get("gi")?.system?._fieldReadyOnce === true;
  }, { timeout: 90_000 });
  await wait(SETTLE);

  const result = await page.evaluate(async ({ subjects, enabled }) => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const { THREE } = await import("/src/engine/index.js");
    const engine = await ensureEngine();
    const sys = engine.modules.get("gi")?.system;
    const screen = sys?.state?.screen;
    const renderer = engine.renderer;
    const camera = engine.camera;
    const deviceErrors = [];
    renderer.backend.device.addEventListener?.("uncapturederror", (event) => {
      deviceErrors.push(event.error?.message ?? String(event.error));
    });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const srgbToLinear = (c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

    const sample = async () => {
      const canvas = renderer.domElement;
      const off = new OffscreenCanvas(canvas.width, canvas.height);
      const ctx = off.getContext("2d");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      ctx.drawImage(canvas, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const crop = (world) => {
        const p = new THREE.Vector3(...world).project(camera);
        const cx = Math.round((p.x * 0.5 + 0.5) * canvas.width);
        const cy = Math.round((0.5 - p.y * 0.5) * canvas.height);
        const radius = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) * 0.012));
        let sum = 0, count = 0;
        for (let y = cy - radius; y <= cy + radius; y++) {
          for (let x = cx - radius; x <= cx + radius; x++) {
            if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
            const i = (y * canvas.width + x) * 4;
            sum += 0.2126 * srgbToLinear(pixels[i] / 255)
              + 0.7152 * srgbToLinear(pixels[i + 1] / 255)
              + 0.0722 * srgbToLinear(pixels[i + 2] / 255);
            count++;
          }
        }
        return { luminance: count ? sum / count : 0, ndc: [p.x, p.y, p.z] };
      };
      return Object.fromEntries(Object.entries(subjects).map(([name, world]) => [name, crop(world)]));
    };

    // The VXAO texture itself, paired with the gbuffer world position each
    // texel was computed from — no projection maths, and no dependence on which
    // way either texture's rows run.
    const readVxaoAt = async () => {
      const pass = screen?.vxaoPass;
      if (!pass || !screen?.gbuffer?.position) return null;
      const unpad = (raw, w, h, comps, Ctor) => {
        const rowBytes = w * comps * Ctor.BYTES_PER_ELEMENT;
        const padded = Math.ceil(rowBytes / 256) * 256;
        const src = new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length);
        const out = new Uint8Array(rowBytes * h);
        for (let y = 0; y < h; y++) {
          const from = y * padded;
          const avail = Math.max(0, Math.min(rowBytes, src.length - from));
          if (avail > 0) out.set(src.subarray(from, from + avail), y * rowBytes);
        }
        return new Ctor(out.buffer);
      };
      const vw = pass.width, vh = pass.height;
      const vx = unpad(await renderer.backend.copyTextureToBuffer(pass.target, 0, 0, vw, vh, 0), vw, vh, 4, Uint8Array);
      const posTex = screen.gbuffer.position;
      const gw = posTex.image?.width ?? screen.width;
      const gh = posTex.image?.height ?? screen.height;
      if (!gw || !gh) return null;
      const pos = unpad(await renderer.backend.copyTextureToBuffer(posTex, 0, 0, gw, gh, 0), gw, gh, 4, Float32Array);
      const sx = gw / vw, sy = gh / vh;
      const at = (p) => {
        let best = null, bestD = Infinity;
        for (let py = 0; py < vh; py++) for (let px = 0; px < vw; px++) {
          const gx = Math.min(gw - 1, Math.floor((px + 0.5) * sx));
          const gy = Math.min(gh - 1, Math.floor((py + 0.5) * sy));
          const gi = (gy * gw + gx) * 4;
          if (pos[gi + 3] < 0.5) continue;
          const d = (pos[gi] - p[0]) ** 2 + (pos[gi + 1] - p[1]) ** 2 + (pos[gi + 2] - p[2]) ** 2;
          if (d < bestD) { bestD = d; best = { value: vx[(py * vw + px) * 4] / 255, dist: Math.sqrt(d) }; }
        }
        return best;
      };
      return Object.fromEntries(Object.entries(subjects).map(([k, p]) => [k, at(p)]));
    };

    const base = await sample();
    let vxaoFull = null, vxaoZero = null, aoFull = null, aoZero = null, vxaoTex = null;
    if (enabled) {
      // Isolate the voxel estimator first. This same-page A/B avoids scene
      // startup/temporal differences being mistaken for world-space AO.
      // `radius` is deliberately NOT overridden — see the header.
      globalThis.__giAoOverride = { strength: 0, radius: 1 };
      globalThis.__giVxaoOverride = { strength: 1 };
      await sleep(1200);
      vxaoFull = await sample();
      vxaoTex = await readVxaoAt();
      globalThis.__giVxaoOverride = { strength: 0 };
      await sleep(1200);
      vxaoZero = await sample();

      // Keep VXAO off through this A/B. A differential at the visible box
      // contact therefore belongs to the existing screen-space estimator.
      globalThis.__giAoOverride = { strength: 1, radius: 0.5 };
      await sleep(1200);
      aoFull = await sample();
      globalThis.__giAoOverride = { strength: 0, radius: 0.5 };
      await sleep(1200);
      aoZero = await sample();
      delete globalThis.__giAoOverride;
      await sleep(250);
    }

    const occ = engine.scene.getObjectByName("OffscreenOccluder");
    const box = new THREE.Box3().setFromObject(occ);
    const projected = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) projected.push(new THREE.Vector3(x, y, z).project(camera).toArray());
    }
    const frustum = {
      maxX: Math.max(...projected.map((p) => p[0])),
      minX: Math.min(...projected.map((p) => p[0])),
      anyInside: projected.some(([x, y, z]) => Math.abs(x) <= 1 && Math.abs(y) <= 1 && z >= -1 && z <= 1),
    };

    let profile = null;
    try {
      const p = await globalThis.__editorApi.call("profile.giPasses", { samples: 12 });
      const group = p?.srcProbes?.groupMs?.vxao;
      profile = {
        ms: typeof group === "number" ? group : group?.ms ?? p?.screenPassesMs?.vxao ?? null,
        groupError: p?.srcProbes?.groupMs?.ERROR ?? null,
      };
    } catch (error) {
      profile = { ms: null, error: error?.message ?? String(error) };
    }

    const pass = screen?.vxaoPass;
    const passGroups = screen?.srcProbes?.passGroups ?? [];
    return {
      base, vxaoFull, vxaoZero, aoFull, aoZero, vxaoTex, frustum, profile, deviceErrors,
      vxaoRadius: screen?.vxao?.radius?.value ?? null,
      portableStorageLimit: renderer.backend.device.limits.maxStorageBuffersPerShaderStage,
      contract: {
        passPresent: !!pass,
        targetName: pass?.target?.name ?? null,
        computeName: pass?.compute?.__giPassName ?? null,
        nodePresent: !!screen?.vxao?.node,
        passGroupPresent: passGroups.some((g) => g.label === "vxao"),
      },
    };
  }, { subjects: VXAO_SUBJECTS, enabled: vxaoEnabled });

  if (process.env.PNG === "1") {
    writeFileSync(`${OUT}/vxao-${label}.png`, await page.screenshot());
  }
  await page.close();
  return { ...result, validationErrors: [...validationErrors, ...result.deviceErrors] };
}

let on;
let off;
try {
  on = await runArm(true);
  off = await runArm(false);
} finally {
  await browser.close();
}

const hiddenContrastOn = on.vxaoFull.hiddenFloor.luminance / Math.max(1e-6, on.vxaoFull.openFloor.luminance);
const hiddenContrastOff = on.vxaoZero.hiddenFloor.luminance / Math.max(1e-6, on.vxaoZero.openFloor.luminance);
const worldEffect = hiddenContrastOff - hiddenContrastOn;
// The estimator's own output at the two floor points. `openFloor` is the
// control: same distance to the ceiling, no local occluder within the reach.
const texHidden = on.vxaoTex?.hiddenFloor?.value ?? null;
const texOpen = on.vxaoTex?.openFloor?.value ?? null;
const texContact = on.vxaoTex?.contact?.value ?? null;
const worldDarkening = texHidden !== null && texOpen !== null ? texOpen - texHidden : null;
// Does the term reach the image? Measured where VXAO is strongest, so the
// question is about plumbing, not about a few percent of gather authority.
const vxaoImageLift = on.vxaoZero.contact.luminance / Math.max(1e-6, on.vxaoFull.contact.luminance);
const contactLift = on.aoZero.contact.luminance / Math.max(1e-6, on.aoFull.contact.luminance);
const controlLift = on.aoZero.contactControl.luminance / Math.max(1e-6, on.aoFull.contactControl.luminance);
// The intermittent dead boot renders a black canvas with the camera pose never
// applied, and every luminance statistic below then reads 0 — which used to
// surface as a confusing AO failure. Name it instead: this check is listed
// first so a failing run says what actually happened.
const litSubjects = Math.max(...Object.values(on.base).map((s) => s.luminance));
const checks = {
  "the rig rendered (not the intermittent dead boot)": litSubjects > 0.01,
  "off-screen occluder is outside the camera frustum": !on.frustum.anyInside && on.frustum.maxX < -1,
  // Brute-force ray-cast AO over the same voxels puts the true gap between
  // these two points at 0.092 (scripts/vxao-bench.mjs). A 60-degree cone over a
  // coarse density pyramid recovers about a third of that for an occluder this
  // narrow — 0.035 — so the bar is what proves the capability with margin, not
  // the truth. A change that moves this UP toward 0.092 is an improvement.
  "VXAO darkens beside an off-screen occluder": Number.isFinite(worldDarkening) && worldDarkening >= 0.02,
  "VXAO reaches the image": vxaoImageLift >= 1.01,
  "screen-space contact AO still contributes": contactLift >= 1.015 && (contactLift - 1) >= 2 * Math.max(0, controlLift - 1),
  "VXAO runtime contract is published": on.contract.passPresent && on.contract.targetName === "giVxao"
    && on.contract.computeName === "vxao" && on.contract.nodePresent && on.contract.passGroupPresent,
  "structural hatch removes VXAO": !off.contract.passPresent && !off.contract.nodePresent,
  "VXAO has a profiler label": Number.isFinite(on.profile.ms) && !on.profile.groupError,
  [`VXAO costs <= ${BUDGET_MS.toFixed(2)} ms at ${VIEW.join("x")}`]: Number.isFinite(on.profile.ms) && on.profile.ms <= BUDGET_MS,
  "portable storage-buffer limit is exercised": on.portableStorageLimit === 8 && off.portableStorageLimit === 8,
  "no WebGPU validation errors": on.validationErrors.length === 0 && off.validationErrors.length === 0,
};

console.log(
  `\nVXAO texture (radius ${on.vxaoRadius}, strength 1): hiddenFloor ${texHidden?.toFixed(4)}, ` +
  `openFloor ${texOpen?.toFixed(4)}, contact ${texContact?.toFixed(4)} — occluder darkening ${worldDarkening?.toFixed(4)}`,
);
console.log(`VXAO image lift at contact: x${vxaoImageLift.toFixed(4)}`);
console.log(`(informational) screen contrast: on ${hiddenContrastOn.toFixed(4)}, off ${hiddenContrastOff.toFixed(4)}, delta ${worldEffect.toFixed(4)}`);
console.log(`occluder frustum: x ${on.frustum.minX.toFixed(3)}..${on.frustum.maxX.toFixed(3)}, any corner inside ${on.frustum.anyInside}`);
console.log(`contact AO lift: contact x${contactLift.toFixed(4)}, control x${controlLift.toFixed(4)}`);
console.log(`VXAO GPU cost: ${on.profile.ms ?? "unavailable"} ms (${VIEW.join("x")}, quality ${QUALITY})`);
console.log(`runtime contract: ${JSON.stringify(on.contract)}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
if (on.validationErrors.length || off.validationErrors.length) {
  console.log("validation errors:", [...on.validationErrors, ...off.validationErrors].join(" | "));
}
const passed = Object.values(checks).every(Boolean);
console.log(passed ? "VXAO-PROBE PASS" : "VXAO-PROBE FAIL");
process.exit(passed ? 0 : 1);
