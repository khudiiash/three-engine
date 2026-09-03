// GATE: the §13 detail box must contain the VIEWER, not just the orbit pivot.
//
//   npm run test:gi-detail-follow
//
// Two arms, and the negative control is the point. The box follows
// `engine.cameraFocus` in edit mode, so a camera orbiting a distant pivot ends
// up at or outside the box edge — and the §13 F3 feather then serves the
// viewer's own pixels from the far-field constant (35% chroma, no occlusion),
// which is the "washed out with bright leaks" report of 2026-08-30.
//
//   clamp ON  (shipping)  — the camera must end up >= one feather inside
//   clamp OFF (__giDetailViewerClamp = false) — must FAIL that, or the gate is
//                                               asserting nothing
import puppeteer from "puppeteer-core";

const BASE = process.env.RIG_URL ?? "http://localhost:5231/scripts/gi-detail-follow.html";

async function arm(clamp) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: process.env.HEADED ? false : "new",
    userDataDir: "C:/Users/Khudiiash/AppData/Local/Temp/claude/gi-sky-chrome-profile",
    args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  page.on("pageerror", (e) => console.log(`  PAGEERROR ${e.message}`));
  await page.goto(`${BASE}?clamp=${clamp ? 1 : 0}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  let out = null;
  try {
    await page.waitForFunction("globalThis.__RIG_DONE__ === true",
      { timeout: Number(process.env.WAIT_MS ?? 300000) });
    out = await page.evaluate("globalThis.__RIG_RESULT__");
  } catch { console.log(`  TIMEOUT (clamp=${clamp})`); }
  await browser.close();
  return out;
}

const on = await arm(true);
const off = await arm(false);

for (const [name, r] of [["clamp ON", on], ["clamp OFF (control)", off]]) {
  if (!r) { console.log(`${name}: no result`); continue; }
  if (r.error) { console.log(`${name}: ERROR ${r.error}`); continue; }
  console.log(`${name}: armed ${r.armed} extent ${r.extent} spacing ${r.probeSpacing} ` +
    `feather ${r.feather}\n  bounds ${JSON.stringify(r.bounds)}\n  camera ${JSON.stringify(r.camera)} ` +
    `anchor ${JSON.stringify(r.anchor)}\n  camInside ${r.camInside} (needs >= ${r.feather})  pass ${r.pass}`);
}

const fail = [];
if (!on) fail.push("clamp-ON arm produced no result");
else if (!on.armed) fail.push("the detail box never armed — the scene is not over DETAIL_TRIGGER any more");
else if (!on.pass) fail.push(`camera is only ${on.camInside}m inside the box, needs ${on.feather}m`);
// A negative control that passes means the gate is measuring nothing. It is a
// FAILURE of the gate, reported as such rather than quietly tolerated.
if (off && off.armed && off.pass) {
  fail.push("the negative control PASSED — with __giDetailViewerClamp=false the camera " +
    "should sit inside the feather, so this gate no longer proves the clamp does anything");
}

if (fail.length) {
  console.log("\nFAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("\nPASS — the viewer stays a full feather inside the detail box, and the control confirms the clamp is why.");
