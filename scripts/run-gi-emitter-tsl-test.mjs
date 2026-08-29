// EMITTER FORM FACTOR: THE TSL AGAINST ITS OWN SCALAR TWIN, ON THE GPU.
//
// ══ WHY THIS DID NOT EXIST AND SHOULD HAVE ═════════════════════════════════
//
// `test:gi-emitter-shapes` is a Monte-Carlo arbiter for `emitterShapes.js` —
// the SCALAR twins. Nothing anywhere gated `giLight.js`'s TSL, which is the
// code that actually lights the scene; the twins are called a "mirror" and
// were never diffed against the thing they mirror.
//
// That gap has a receipt now. The 2026-08-20 horizon-clip fix landed in both
// files, the scalar gate went green, and the GPU rendered the user's room
// BLACK — because `boxLightFactor`'s TSL returned zero everywhere. A CPU-only
// gate on a pair of implementations tests one of them and reports on both.
//
// So: one compute kernel evaluates `boxLightFactor` over a table of receivers
// and boxes, reads the results back, and diffs them against `refBoxFactor` at
// the same inputs. Axis-aligned boxes only — rotation, the shaped kinds and
// absolute correctness are the scalar gate's job, and duplicating them here
// would buy a second copy of a test instead of the one that was missing.
//
// The table deliberately includes the OVERLAP cases (receiver between the
// box's opposing face planes), because that is the configuration the two
// implementations are most likely to disagree about and the one the user
// reported: "the emitters do not light surfaces if their meshes overlap".
//
//   node scripts/run-gi-emitter-tsl-test.mjs [url]
// Env:  HEADED=1   TOL=0.02
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5335/";
const TOL = Number(process.env.TOL ?? 0.02);

// (P, N, boxCenter, boxHalf) — the sweep is the user's pillar-through-a-lamp
// plus a flat floor control and a deep-overlap case.
const CASES = [];
for (const dx of [0, 0.2, 0.4, 0.6, 0.85, 1.0, 1.4]) {
  for (const y of [0.75, 0.55, 0.0, -0.9]) {
    CASES.push({ P: [0.25, y, 0], N: [1, 0, 0], c: [dx, 0, 0], h: [0.6, 0.5, 0.6] });
  }
}
// A floor receiver under a long thin strip — their `Glow_*` geometry, and the
// case where the strip is EMBEDDED in the slab it sits on.
for (const dy of [-0.05, 0, 0.05, 0.2, 0.6]) {
  CASES.push({ P: [0, 0, 0], N: [0, 1, 0], c: [0, dy, 0], h: [4.0, 0.09, 0.125] });
  CASES.push({ P: [0, 0, 0.3], N: [0, 0, 1], c: [0, dy, 0], h: [4.0, 0.09, 0.125] });
}
// Grazing / behind-the-receiver controls.
CASES.push({ P: [0, 0, 0], N: [0, 1, 0], c: [0, -2, 0], h: [1, 1, 1] });
CASES.push({ P: [0, 0, 0], N: [0, 1, 0], c: [0, 2, 0], h: [1, 1, 1] });
CASES.push({ P: [0, 0, 0], N: [0, 1, 0], c: [3, 0, 0], h: [1, 1, 1] });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
  ],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log(`pageerror: ${String(e.message ?? e).slice(0, 400)}`));
page.on("console", (m) => {
  if (m.type() === "error") console.log(`  [console error] ${m.text().slice(0, 300)}`);
});
// No project — this needs module resolution and a WebGPU device, nothing else.
await page.evaluateOnNewDocument(() => { globalThis.__editorNoAutoOpen = true; });
await page.goto(url, { waitUntil: "load", timeout: 90000 });

const result = await page.evaluate(async (cases) => {
  // The in-page half is a real module (see its header): a bare `three/tsl`
  // specifier inside an evaluated function is never transformed by Vite.
  const { runEmitterTslCases } = await import("/scripts/lib/giEmitterTslProbe.js");
  return await runEmitterTslCases(cases);
}, CASES);

let failures = 0;
let worst = 0;
let worstRow = null;
for (const r of result) {
  const scale = Math.max(Math.abs(r.cpu), Math.abs(r.gpu), 1e-3);
  const rel = Math.abs(r.gpu - r.cpu) / scale;
  if (rel > worst) { worst = rel; worstRow = r; }
  if (rel > TOL) {
    failures++;
    console.error(
      `  FAIL P(${r.P}) N(${r.N}) box c(${r.c}) h(${r.h}) — ` +
      `TSL ${r.gpu.toExponential(3)} vs scalar ${r.cpu.toExponential(3)} (${(rel * 100).toFixed(1)}%)`,
    );
  }
  const minH = Math.min(...r.h);
  const maxH = Math.max(...r.h);
  if (minH <= maxH * 0.2) {
    const rcScale = Math.max(Math.abs(r.cpu), Math.abs(r.rcGpu), 1e-3);
    const rcRel = Math.abs(r.rcGpu - r.cpu) / rcScale;
    if (rcRel > TOL) {
      failures++;
      console.error(
        `  FAIL rcDirect thin box P(${r.P}) h(${r.h}) — ` +
        `TSL ${r.rcGpu.toExponential(3)} vs exact ${r.cpu.toExponential(3)} (${(rcRel * 100).toFixed(1)}%)`,
      );
    }
  }
}
console.log(
  `worst |TSL − scalar| = ${(worst * 100).toFixed(2)}% ` +
  (worstRow ? `at P(${worstRow.P}) box c(${worstRow.c})` : ""),
);
console.log(failures ? `\n${failures} FAILURE(S) across ${result.length} cases` : `\nALL GREEN — ${result.length} cases`);
await browser.close();
process.exit(failures ? 1 : 0);
