/**
 * Headless checks over the build system's decision-making.
 *
 * Everything here is a pure module — the destination-name allocator, the scene
 * plan, the quality ceiling, the index.html rewrite and the desktop scaffold —
 * deliberately kept free of Tauri and the DOM so the parts of a build that
 * silently produce a *wrong* game (rather than a failed one) are testable in
 * Node. The smoke (`npm run smoke:build`) covers the parts that need a browser.
 *
 * Usage: npm run test:build
 */
import { createAssetNames, splitExtension } from "../src/editor/build/assetNames.js";
import { rewriteComponentAssets } from "../src/editor/build/assetRefs.js";
import {
  BUILD_DEFAULTS,
  resolveBuildScenes,
  findSceneReferences,
  resolvePagesProject,
  sanitizePagesProject,
  normalizeRelPath,
  toProjectRelative,
} from "../src/editor/build/buildSettings.js";
import {
  themePlayerHtml,
  readableForeground,
  safeColor,
  hexToRgb,
  injectLivePreviewClient,
  PREVIEW_REVISION_PATH,
} from "../src/editor/build/playerHtml.js";
import {
  cargoName,
  bundleIdentifier,
  desktopScaffoldFiles,
  desktopTauriConfig,
} from "../src/editor/build/desktopScaffold.js";
import { QUALITY_PRESETS, applyQualityCeiling } from "../src/engine/sceneSettings.js";
import { sanitizeFileName } from "../src/editor/exportGame.js";
import { selectRuntimeFiles, scriptImportSpecifiers } from "../src/editor/build/runtimeFiles.js";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

// --- Destination names -------------------------------------------------------
console.log("\nAsset destination names");
{
  const names = createAssetNames();
  const a = names.claim("C:/proj/textures/wood/color.png");
  const b = names.claim("C:/proj/textures/stone/color.png");
  check("two sources with one basename get different destinations", a !== b, `${a} vs ${b}`);
  eq("the first keeps the natural name", a, "assets/color.png");
  eq("the second is suffixed", b, "assets/color-1.png");

  const again = names.claim("C:/proj/textures/wood/color.png");
  eq("asking twice for one source gives one answer", again, a);
  eq(
    "separators and case don't create a second copy",
    names.claim("c:\\proj\\textures\\wood\\color.png"),
    a,
  );

  eq("a sidecar follows the renamed asset", names.claimSidecar("C:/proj/textures/stone/color.png", ".meta"), "assets/color-1.png.meta");
  check(
    "the copy list carries the original source path",
    names.copyEntries().some(([src]) => src === "C:/proj/textures/stone/color.png"),
  );

  // Generated documents (a rewritten .mat, a transpiled script) share the
  // namespace — otherwise a .mat could be written over a copied file.
  const script = names.claimGenerated("C:/proj/scripts/Player.ts", { rename: (n) => n.replace(/\.ts$/i, ".js") });
  eq("a transpiled script lands as .js", script, "assets/Player.js");
  const clash = names.claimGenerated("C:/proj/other/Player.ts", { rename: (n) => n.replace(/\.ts$/i, ".js") });
  check("two scripts with one name don't collide", clash !== script, `${script} vs ${clash}`);
  check("generated docs are not in the copy list", !names.copyEntries().some(([, rel]) => rel === script));

  eq("release frees the name for reuse", (() => {
    const n = createAssetNames();
    n.claim("/a/x.png");
    n.release("/a/x.png");
    return n.claim("/b/x.png");
  })(), "assets/x.png");

  // The icon belongs beside index.html, not among the game's textures.
  eq("an explicit destination is honoured", names.claimAt("C:/proj/art/logo.png", "icon.png"), "icon.png");
  check(
    "and it still gets copied",
    names.copyEntries().some(([src, rel]) => src === "C:/proj/art/logo.png" && rel === "icon.png"),
  );
  eq(
    "an explicit destination that is taken is uniquified too",
    (() => {
      const n = createAssetNames();
      n.claimAt("/a/one.png", "icon.png");
      return n.claimAt("/b/two.png", "icon.png");
    })(),
    "icon-1.png",
  );

  eq("non-string values pass through", names.claim(null), null);
  eq("extensionless files still work", createAssetNames().claim("/a/LICENSE"), "assets/LICENSE");
  eq("a dotfile keeps its dot", splitExtension(".gitignore"), [".gitignore", ""]);
}

// --- Scene plan --------------------------------------------------------------
console.log("\nScene selection");
{
  const available = ["scenes/Menu.scene", "scenes/Level1.scene", "scenes/Level2.scene"];

  let plan = resolveBuildScenes({ available, build: BUILD_DEFAULTS, mainScene: "scenes/Menu.scene" });
  eq("no explicit start scene falls back to the project's main scene", plan.startScene, "scenes/Menu.scene");
  eq("by default only the start scene is planned — the rest is discovered during the build", plan.scenes, ["scenes/Menu.scene"]);
  eq("and the plan says so", plan.mode, "reachable");

  plan = resolveBuildScenes({ available, build: { ...BUILD_DEFAULTS, scenes: "all" }, mainScene: "scenes/Menu.scene" });
  eq('"all" ships every scene', plan.scenes.length, 3);
  eq("the start scene is listed first", plan.scenes[0], "scenes/Menu.scene");
  eq("in all mode", plan.mode, "all");

  const refs = findSceneReferences(
    'engine.loadScene("scenes/Level2.scene"); a("C:/proj/scenes/Menu.scene"); b(\'scenes/Missing.scene\'); c("notes.scene.txt")',
    { available, root: "C:/proj" },
  );
  eq("scene paths named in text resolve to the project's spelling", refs, ["scenes/Level2.scene", "scenes/Menu.scene"]);
  eq(
    "JSON with escaped Windows backslashes and odd case works too",
    findSceneReferences(JSON.stringify({ path: "SCENES\\level1.scene", again: "scenes/Level1.scene" }), { available }),
    ["scenes/Level1.scene"],
  );
  eq("nothing named, nothing found", findSceneReferences("export default class X {}", { available }), []);

  plan = resolveBuildScenes({
    available,
    build: { ...BUILD_DEFAULTS, startScene: "scenes/Level2.scene" },
    mainScene: "scenes/Menu.scene",
  });
  eq("an explicit start scene wins over the main scene", plan.startScene, "scenes/Level2.scene");

  plan = resolveBuildScenes({
    available,
    build: BUILD_DEFAULTS,
    mainScene: "",
    openScene: "scenes/Level1.scene",
  });
  eq("with neither set, the open scene boots", plan.startScene, "scenes/Level1.scene");

  plan = resolveBuildScenes({
    available,
    build: { ...BUILD_DEFAULTS, startScene: "scenes/Deleted.scene" },
    mainScene: "scenes/Menu.scene",
  });
  eq("a start scene that no longer exists falls back", plan.startScene, "scenes/Menu.scene");
  check("and says so", plan.warnings.some((w) => w.includes("Deleted.scene")), plan.warnings.join(" | "));

  // The one that produces a black screen with no error in a shipped build.
  plan = resolveBuildScenes({
    available,
    build: { ...BUILD_DEFAULTS, startScene: "scenes/Level2.scene", scenes: ["scenes/Menu.scene"] },
  });
  check("a start scene left out of the list is added back", plan.scenes.includes("scenes/Level2.scene"), plan.scenes.join(","));
  eq("an explicit list is list mode", plan.mode, "list");
  check("and warns", plan.warnings.some((w) => w.includes("not in the build list")), plan.warnings.join(" | "));

  plan = resolveBuildScenes({
    available,
    build: { ...BUILD_DEFAULTS, scenes: ["scenes/Menu.scene", "scenes/Gone.scene"] },
    mainScene: "scenes/Menu.scene",
  });
  eq("a listed scene that vanished is dropped", plan.scenes, ["scenes/Menu.scene"]);
  check("and warns", plan.warnings.some((w) => w.includes("Gone.scene")));

  eq(
    "case and separators match the project's own spelling",
    resolveBuildScenes({
      available,
      build: { ...BUILD_DEFAULTS, startScene: "SCENES\\level1.scene" },
    }).startScene,
    "scenes/Level1.scene",
  );

  eq("an empty project resolves to nothing rather than throwing", resolveBuildScenes({ available: [] }).startScene, "");
}

console.log("\nPath helpers");
{
  eq("normalize strips ./ and leading /", normalizeRelPath("./scenes/A.scene"), "scenes/A.scene");
  eq("normalize converts separators", normalizeRelPath("scenes\\sub\\A.scene"), "scenes/sub/A.scene");
  eq(
    "project-relative strips the root",
    toProjectRelative("C:/proj", "C:\\proj\\scenes\\A.scene"),
    "scenes/A.scene",
  );
  eq(
    "a path outside the project is left alone",
    toProjectRelative("C:/proj", "D:/elsewhere/A.scene"),
    "D:/elsewhere/A.scene",
  );
  eq("zip names drop filesystem-hostile characters", sanitizeFileName('My: Game?/v1 *'), "My Game v1");
  eq("a name of nothing but illegal characters still yields one", sanitizeFileName("///"), "game");
}

// --- Quality ceiling ---------------------------------------------------------
console.log("\nQuality presets");
{
  const authored = { performance: { maxDevicePixelRatio: 2, renderScale: 1, volumeStepScale: 1, dynamicResolution: false }, shadows: true };

  const low = applyQualityCeiling(authored, "low");
  check("low lowers the pixel ratio", low.performance.maxDevicePixelRatio === 1, String(low.performance.maxDevicePixelRatio));
  check("low lowers render scale", low.performance.renderScale === QUALITY_PRESETS.low.renderScale);
  check("low turns dynamic resolution on", low.performance.dynamicResolution === true);
  check("low turns shadows off", low.shadows === false);

  // The rule the whole design rests on: a preset may only make things cheaper.
  const cheap = { performance: { maxDevicePixelRatio: 1, renderScale: 0.5, volumeStepScale: 0.3, dynamicResolution: true }, shadows: true };
  const high = applyQualityCeiling(cheap, "high");
  eq(
    "a hand-tuned cheap scene is not raised by a higher preset",
    ["maxDevicePixelRatio", "renderScale", "volumeStepScale"].map((k) => high.performance[k]),
    [1, 0.5, 0.3],
  );
  check("nor is its dynamic resolution turned off", high.performance.dynamicResolution === true);

  const ultra = applyQualityCeiling(authored, "ultra");
  eq("ultra ships the scene exactly as authored", ultra, authored);
  eq("an unknown preset is a no-op, not an error", applyQualityCeiling(authored, "cinematic"), authored);
  eq("no preset is a no-op", applyQualityCeiling(authored, null), authored);

  const noPerf = applyQualityCeiling({}, "low");
  check("a scene with no performance block still gets the ceiling", noPerf.performance.maxDevicePixelRatio === 1);
}

// --- Player HTML -------------------------------------------------------------
console.log("\nLoading screen");
{
  const template = `<!doctype html>
<html><head><title>Three Engine — Game</title></head>
<body><div id="loading">
<!--build:loading-->
<div class="loading-bar"><div class="loading-bar-fill"></div></div>
<div class="loading-label">Loading</div>
<!--/build:loading-->
</div></body></html>`;

  const out = themePlayerHtml(template, {
    title: "Night & Day",
    icon: "icon.png",
    loading: { background: "#101820", accent: "#ffcc00", showTitle: true, showLogo: true },
  });
  check("the tab title is baked in", out.includes("<title>Night &amp; Day</title>"), "");
  check("the title is escaped", !out.includes("<title>Night & Day"), "");
  check("colours reach the CSS variables", out.includes("--loading-bg:#101820") && out.includes("--loading-accent:#ffcc00"));
  check("a favicon is linked", out.includes('<link rel="icon" href="icon.png"'));
  check("the logo shows on the loading screen", out.includes('class="loading-logo" src="icon.png"'));
  check("so does the game title", out.includes('class="loading-title">Night &amp; Day<'));
  check("the progress bar survives the rewrite", out.includes("loading-bar-fill"));
  check("the markers are still there for a re-theme", out.includes("<!--build:loading-->"));

  const off = themePlayerHtml(template, {
    title: "Night",
    icon: "icon.png",
    loading: { background: "#101820", accent: "#ffcc00", showTitle: false, showLogo: false },
  });
  check("logo can be turned off", !off.includes("loading-logo"));
  check("title can be turned off", !off.includes("loading-title"));

  // A colour string lands inside a <style> block, so it is an injection site.
  const injected = themePlayerHtml(template, {
    loading: { background: "red;}body{display:none}#x{a:b", accent: "#0a84ff" },
  });
  check("a non-hex colour is refused, not interpolated", !injected.includes("display:none"), "");
  check("and falls back to the default", injected.includes("--loading-bg:#0d0e11"));
  eq("safeColor accepts the picker's formats", [safeColor("#fff", "x"), safeColor("#a1b2c3", "x"), safeColor("rgb(1,2,3)", "x")], ["#fff", "#a1b2c3", "x"]);

  // A white loading screen must not have invisible white text on it.
  eq("dark backgrounds get light text", readableForeground("#0d0e11"), "255, 255, 255");
  eq("light backgrounds get dark text", readableForeground("#ffffff"), "16, 18, 21");
  eq("short hex expands", hexToRgb("#fff"), [255, 255, 255]);

  const noMarkers = themePlayerHtml("<html><head><title>x</title></head><body></body></html>", {
    title: "Game",
    loading: { background: "#123456" },
  });
  check("a template without markers still gets its colours", noMarkers.includes("--loading-bg:#123456"));
  check("and does not throw", noMarkers.includes("<title>Game</title>"));
}

// --- Live-preview reload client ----------------------------------------------
// The client is injected into the exporter-generated index.html precisely so
// it works with a STALE player template — if these drift, "the hosted preview
// is outdated" comes back as a silent failure.
console.log("\nLive-preview reload client");
{
  const themed = themePlayerHtml(
    "<html><head><title>x</title></head><body><div id=\"game\"></div></body></html>",
    { title: "Game" },
  );
  const out = injectLivePreviewClient(themed);
  check("the client is injected before </body>", /live-preview-client[\s\S]*<\/body>/.test(out));
  check("the game markup survives", out.includes('<div id="game">'));
  check(
    "it polls the marker the exporter writes last",
    out.includes(`fetch("${PREVIEW_REVISION_PATH}"`),
  );
  eq("the marker path matches the exporter contract", PREVIEW_REVISION_PATH, "__preview_revision.json");
  check(
    "no revision is baked in — an unchanged index.html must stay byte-identical across rebuilds",
    injectLivePreviewClient(themed) === out,
  );
  check("polls bypass every cache", out.includes('cache: "no-store"'));
  check("hidden tabs don't poll", out.includes("document.hidden"));
  check("it prefers the runtime's in-place hook", out.includes("window.__playerLiveUpdate"));
  check(
    "a skipped build cannot trust the delta — previous must match the running revision",
    out.includes("data.previous === seen"),
  );
  check(
    "…but missed deltas are recovered from the manifest history",
    out.includes("data.history.findIndex"),
  );
  check("a changed revision still reloads when hot-apply declines", out.includes("location.reload()"));

  const headless = injectLivePreviewClient("<html><head></head></html>");
  check("a template without </body> still gets the client", headless.includes("live-preview-client"));

  // The injection is exporter-conditional (livePreview only), but double-check
  // the theming path alone never smuggles it into a release build.
  check("theming alone does not inject the client", !themed.includes("live-preview-client"));
}

// --- Desktop scaffold --------------------------------------------------------
console.log("\nDesktop scaffold");
{
  eq("cargo names are slugified", cargoName("Night & Day!"), "night-day");
  eq("a title starting with a digit gets a prefix", cargoName("2048"), "game-2048");
  eq("a title of pure punctuation still yields a name", cargoName("!!!"), "game");
  eq("identifiers are reverse-DNS with no underscores", bundleIdentifier("Night & Day"), "com.night-day.game");

  const files = Object.fromEntries(desktopScaffoldFiles({ title: "Night & Day" }));
  for (const rel of ["package.json", "README.md", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/build.rs", "src-tauri/src/main.rs"]) {
    check(`scaffold emits ${rel}`, typeof files[rel] === "string" && files[rel].length > 0);
  }
  const conf = JSON.parse(files["src-tauri/tauri.conf.json"]);
  eq("the shell points at the exported web build", conf.build.frontendDist, "../web");
  check(
    "WebGPU is enabled in the webview (a black window otherwise)",
    conf.app.windows[0].additionalBrowserArgs.includes("--enable-unsafe-webgpu"),
  );
  check(
    "the webview is pinned to the discrete GPU (Dawn picks LOW-POWER by default — 10x on dual-GPU laptops)",
    conf.app.windows[0].additionalBrowserArgs.includes("--force-high-performance-gpu"),
  );
  eq("the product name is the game's", conf.productName, "Night & Day");
  check("the identifier is not Tauri's rejected placeholder", conf.identifier !== "com.tauri.dev", conf.identifier);
  check("Cargo.toml parses as a package with tauri", files["src-tauri/Cargo.toml"].includes('name = "night-day"') && files["src-tauri/Cargo.toml"].includes("tauri = "));
  check("main.rs runs a Tauri builder", files["src-tauri/src/main.rs"].includes("tauri::Builder::default()"));
  check("target/ and node_modules/ are ignored", files[".gitignore"].includes("src-tauri/target/"));

  const noIcon = JSON.parse(desktopTauriConfig({ title: "X", identifier: "com.x.game", hasIcon: false }));
  check("no icon means no icon list to fail on", noIcon.bundle.icon === undefined);
}

// --- Cloudflare Pages project names -----------------------------------------
console.log("\nPages project names");
{
  eq("a display name becomes a valid subdomain", sanitizePagesProject("My Game!"), "my-game");
  eq("runs of junk collapse to one hyphen", sanitizePagesProject("Night  &  Day"), "night-day");
  eq("leading/trailing hyphens are trimmed", sanitizePagesProject("--edgy--"), "edgy");
  eq("pure punctuation yields nothing", sanitizePagesProject("!!!"), "");
  check(
    "long names are cut to the 58-char limit without a trailing hyphen",
    (() => {
      const cut = sanitizePagesProject(`${"a".repeat(57)}-b`);
      return cut.length <= 58 && !cut.endsWith("-");
    })(),
  );
  eq(
    "an explicit setting wins over the project name",
    resolvePagesProject({ build: { pagesProject: "Demo Build" }, projectName: "Other" }),
    "demo-build",
  );
  eq(
    "no setting falls back to the project name",
    resolvePagesProject({ build: { pagesProject: "" }, projectName: "Space Runner" }),
    "space-runner",
  );
  eq("nothing at all still yields a deployable name", resolvePagesProject({}), "my-game");
}

// --- Component asset rewriting ----------------------------------------------
// The exporter's walker is schema-driven, same as the runtime's preloader —
// these checks pin the contract that made the old hand-maintained type ladder
// ship Sprite/Decal/Instancer references as absolute authoring paths.
console.log("\nComponent asset rewriting");
{
  const SCHEMAS = {
    sprite: [
      { key: "atlas", type: "asset" },
      { key: "texture", type: "asset" },
      { key: "region", type: "string" },
    ],
    mesh: [
      { key: "geometryAsset", type: "asset" },
      { key: "material", type: "asset" },
      { key: "material2", type: "asset" },
      { key: "material3", type: "asset" },
    ],
    instancer: [{ key: "material", type: "asset" }],
    timeline: [{ key: "asset", type: "asset" }],
    model: [{ key: "path", type: "asset" }],
    script: [],
    sound: [],
  };
  const run = (component, { rewritePrefab } = {}) => {
    const added = [];
    const names = createAssetNames();
    rewriteComponentAssets(component, {
      getSchema: (type) => SCHEMAS[type],
      claim: (p) => names.claim(p),
      claimDoc: (p, rename) => names.claimGenerated(p, rename ? { rename } : undefined),
      add: (kind, p) => added.push([kind, p]),
      ...(rewritePrefab ? { rewritePrefab } : {}),
    });
    return { added, component };
  };

  // The exact bug that shipped: a sprite's plain-image texture stayed an
  // absolute Windows path and the served build could not fetch it.
  const sprite = { type: "sprite", props: { texture: "C:\\Users\\me\\GAME\\Fonts\\Roboto\\Text.png", atlas: "", region: "hero" } };
  run(sprite);
  eq("a sprite's plain texture is claimed into the build", sprite.props.texture, "assets/Text.png");
  eq("an empty atlas slot is left alone", sprite.props.atlas, "");
  eq("non-asset schema fields are untouched", sprite.props.region, "hero");

  const mesh = {
    type: "mesh",
    props: { geometryAsset: "C:/proj/geo/rock.geom", material: "C:/proj/mats/a.mat", material2: "C:/proj/mats/b.mat", material3: "" },
  };
  const meshRun = run(mesh);
  eq("multi-material slots all ship", mesh.props.material2, "assets/b.mat");
  eq(
    "every .mat is registered for re-emission",
    meshRun.added.filter(([kind]) => kind === "material").length,
    2,
  );
  eq("geometry is a plain copy, not a document", meshRun.added.some(([, p]) => p.endsWith(".geom")), false);

  const instancer = { type: "instancer", props: { material: "C:/proj/mats/leaves.mat" } };
  const instancerRun = run(instancer);
  eq("an instancer's material override ships", instancer.props.material, "assets/leaves.mat");
  eq("…and is re-emitted like any .mat", instancerRun.added, [["material", "C:/proj/mats/leaves.mat"]]);

  const timeline = { type: "timeline", props: { asset: "C:/proj/cut/intro.timeline" } };
  eq("a timeline routes to the document bucket", run(timeline).added, [["timeline", "C:/proj/cut/intro.timeline"]]);

  const model = {
    type: "model",
    props: { path: "C:/proj/models/tree.glb", materials: { Bark: "C:/proj/mats/bark.mat", Leaf: "" } },
  };
  const modelRun = run(model);
  eq("a model's override map is rewritten", model.props.materials.Bark, "assets/bark.mat");
  eq("empty override slots survive untouched", model.props.materials.Leaf, "");
  check("the override map's .mat is registered", modelRun.added.some(([kind, p]) => kind === "material" && p.endsWith("bark.mat")));

  const script = {
    type: "script",
    props: { scripts: [{ path: "C:/proj/scripts/Player.ts" }, { path: "C:/proj/scripts/Enemy.js" }, { path: "" }] },
  };
  const scriptRun = run(script);
  eq("a .ts slot ships as .js", script.props.scripts[0].path, "assets/Player.js");
  eq("a .js slot keeps its extension", script.props.scripts[1].path, "assets/Enemy.js");
  eq("both slots are registered for transpilation", scriptRun.added.length, 2);

  // Legacy single-script shape: the rewritten path must land back in props —
  // the old exporter rewrote a temp slot object and shipped the scene still
  // pointing at the authoring path.
  const legacy = { type: "script", props: { path: "C:/proj/scripts/Old.ts" } };
  run(legacy);
  eq("a legacy script component's path is rewritten in place", legacy.props.path, "assets/Old.js");

  const sound = { type: "sound", props: { entries: [{ audioAsset: "C:/proj/audio/step.audio" }, { audioAsset: "" }] } };
  const soundRun = run(sound);
  eq("a sound entry's sidecar ships", sound.props.entries[0].audioAsset, "assets/step.audio");
  eq("the sidecar is registered as an audio document", soundRun.added, [["audio", "C:/proj/audio/step.audio"]]);

  const unknown = { type: "somefuturething", props: { texture: "C:/proj/tex/a.png" } };
  run(unknown);
  eq("a component without a schema is left untouched", unknown.props.texture, "C:/proj/tex/a.png");

  // A script's @attribute({ type: "asset" }) values live in an untyped bag one
  // level below anything the schema walk or the prefab sweep reached, so they
  // shipped as absolute local paths and the browser refused to load them.
  const attrs = {
    type: "script",
    props: {
      scripts: [
        {
          path: "C:/proj/scripts/Launcher.ts",
          attributes: {
            ballMaterial: "C:/proj/materials/CannonBall.mat",
            impact: "C:/proj/fx/hit.png",
            speed: 12,
            label: "Fire!",
            spawn: "C:/proj/prefabs/Ball.prefab",
            waves: [{ decal: "C:/proj/fx/scorch.png" }],
          },
        },
      ],
    },
  };
  const attrRun = run(attrs, { rewritePrefab: (v) => (v.endsWith(".prefab") ? "guid-123" : v) });
  const slot = attrs.props.scripts[0].attributes;
  eq("a script's asset attribute is claimed into the build", slot.ballMaterial, "assets/CannonBall.mat");
  eq("…and is re-emitted like any other .mat", attrRun.added.some(([k, p]) => k === "material" && p.endsWith("CannonBall.mat")), true);
  eq("a texture attribute is a plain copy", slot.impact, "assets/hit.png");
  eq("non-path attributes are untouched", [slot.speed, slot.label], [12, "Fire!"]);
  eq("a prefab attribute becomes its guid", slot.spawn, "guid-123");
  eq("attributes nested in lists are walked too", slot.waves[0].decal, "assets/scorch.png");

  // Same bag on the legacy single-script shape.
  const legacyAttrs = {
    type: "script",
    props: { path: "C:/proj/scripts/Old.ts", attributes: { mat: "C:/proj/materials/Old.mat" } },
  };
  run(legacyAttrs);
  eq("legacy script attributes are rewritten too", legacyAttrs.props.attributes.mat, "assets/Old.mat");
}

// --- Absolute paths baked into script SOURCE ---------------------------------
{
  console.log("\nScript source asset paths");
  const { rewriteSourceAssetPaths, findLeakedAbsolutePaths } = await import(
    "../src/editor/exportGame.js"
  );
  const claimed = [];
  const rewriteAssetValue = (value) => {
    claimed.push(value);
    return `assets/${value.split(/[\\/]/).pop()}`;
  };
  const opts = { root: "C:/proj", rewriteAssetValue };

  // The reported failure: the attribute keeps its DECLARED DEFAULT, so the path
  // exists only here and the asset is never copied into the build at all.
  const src = `class L { ballMaterial = "C:/proj/materials/CannonBall.mat"; }`;
  eq(
    "an absolute .mat default is rewritten",
    rewriteSourceAssetPaths(src, opts),
    `class L { ballMaterial = "assets/CannonBall.mat"; }`,
  );
  eq("…and the asset is claimed so it actually ships", claimed, ["C:/proj/materials/CannonBall.mat"]);

  eq(
    "an escaped Windows path is matched whole",
    rewriteSourceAssetPaths(`const p = "C:\\\\proj\\\\tex\\\\a.png";`, opts),
    `const p = "assets/a.png";`,
  );
  eq(
    "single quotes and backticks work the same",
    rewriteSourceAssetPaths("const p = 'C:/proj/tex/b.png';", opts),
    "const p = 'assets/b.png';",
  );
  eq(
    "a path outside the project is left alone",
    rewriteSourceAssetPaths(`const p = "C:/elsewhere/c.png";`, opts),
    `const p = "C:/elsewhere/c.png";`,
  );
  eq(
    "a non-asset extension is left alone",
    rewriteSourceAssetPaths(`const p = "C:/proj/notes/readme.txt";`, opts),
    `const p = "C:/proj/notes/readme.txt";`,
  );
  eq(
    "relative paths are never guessed at",
    rewriteSourceAssetPaths(`const p = "materials/Thing.mat";`, opts),
    `const p = "materials/Thing.mat";`,
  );

  // The safety net: whatever the walks miss must at least be reported.
  const leaks = findLeakedAbsolutePaths(
    [
      ["scene.json", `{"material":"C:/proj/materials/Leaked.mat"}`],
      ["assets/Fine.js", `const p = "assets/ok.png";`],
      ["assets/icon.png", new Uint8Array([1, 2, 3])],
    ],
    "C:/proj",
  );
  eq("a leaked absolute path is reported", leaks, [
    { file: "scene.json", path: "C:/proj/materials/Leaked.mat" },
  ]);
  eq("a clean build reports nothing", findLeakedAbsolutePaths([["a.js", "'assets/x.png'"]], "C:/proj"), []);
}

// --- Runtime trimming ----------------------------------------------------------
// The player template is code-split; a game ships only the chunks it can
// reach. Every rule errs towards shipping, so the checks below pin BOTH
// directions: what a bare game must not carry, and what an enabled feature must.
console.log("\nRuntime files");
{
  const manifest = {
    "player.html": {
      file: "_engine/player-A.js",
      isEntry: true,
      assets: ["_engine/draco_decoder-B.wasm"],
      dynamicImports: [
        "node_modules/@dimforge/rapier3d-compat/rapier.mjs",
        "src/modules/gi/GISystem.js",
        "node_modules/three/examples/jsm/loaders/EXRLoader.js",
        "node_modules/three/examples/jsm/loaders/KTX2Loader.js",
        "src/engine/scriptRuntime/tslRuntime.js",
        "src/engine/scriptRuntime/runtime.js",
        "src/player/liveUpdate.js",
        "node_modules/three/examples/jsm/tsl/display/BloomNode.js",
        "src/vendor/mystery.js",
      ],
    },
    "node_modules/@dimforge/rapier3d-compat/rapier.mjs": { file: "_engine/rapier-C.js", isDynamicEntry: true },
    "src/modules/gi/GISystem.js": {
      file: "_engine/GISystem-D.js",
      isDynamicEntry: true,
      imports: ["player.html"],
      dynamicImports: ["node_modules/meshoptimizer/index.js"],
    },
    "node_modules/meshoptimizer/index.js": { file: "_engine/index-E.js" },
    "node_modules/three/examples/jsm/loaders/EXRLoader.js": { file: "_engine/EXRLoader-F.js" },
    "node_modules/three/examples/jsm/loaders/KTX2Loader.js": {
      file: "_engine/KTX2Loader-G.js",
      assets: ["_engine/basis_transcoder-H.wasm"],
    },
    "src/engine/scriptRuntime/tslRuntime.js": { file: "_engine/tslRuntime-I.js" },
    "src/engine/scriptRuntime/runtime.js": { file: "_engine/runtime-J.js" },
    "src/player/liveUpdate.js": { file: "_engine/liveUpdate-K.js" },
    "node_modules/three/examples/jsm/tsl/display/BloomNode.js": { file: "_engine/BloomNode-L.js" },
    "src/vendor/mystery.js": { file: "_engine/mystery-M.js" },
  };
  const templateFiles = [
    ["index.html", 10], [".vite/manifest.json", 10], ["app-icon.png", 10], ["tauri.svg", 10],
    ["_engine/player-A.js", 1000], ["_engine/rapier-C.js", 2000], ["_engine/GISystem-D.js", 700],
    ["_engine/index-E.js", 80], ["_engine/EXRLoader-F.js", 30], ["_engine/KTX2Loader-G.js", 60],
    ["_engine/basis_transcoder-H.wasm", 500], ["_engine/draco_decoder-B.wasm", 280],
    ["_engine/tslRuntime-I.js", 20], ["_engine/runtime-J.js", 20], ["_engine/liveUpdate-K.js", 20],
    ["_engine/BloomNode-L.js", 15], ["_engine/mystery-M.js", 5],
    ["_engine/bvhBlasWorker-N.js", 130], ["_engine/cloudNoiseWorker-O.js", 10], ["_engine/unknownWorker-P.js", 7],
    ["basis/basis_transcoder.wasm", 500], ["draco/draco_decoder.wasm", 280],
  ];
  const has = (r, rel) => r.files.includes(rel);

  const bare = selectRuntimeFiles({ manifest, templateFiles, modules: [] });
  check("the entry chunk always ships", has(bare, "_engine/player-A.js"));
  check("the engine script proxy always ships", has(bare, "_engine/runtime-J.js"));
  check("no physics module → no Rapier", !has(bare, "_engine/rapier-C.js"));
  check("no GI module → no GI system", !has(bare, "_engine/GISystem-D.js"));
  check("…nor what only it reaches", !has(bare, "_engine/index-E.js"));
  check("…nor its worker", !has(bare, "_engine/bvhBlasWorker-N.js"));
  check("no post-processing → no addon, no cloud worker", !has(bare, "_engine/BloomNode-L.js") && !has(bare, "_engine/cloudNoiseWorker-O.js"));
  check("no .exr shipped → no EXR loader", !has(bare, "_engine/EXRLoader-F.js"));
  check(
    "no basis → no KTX2 loader, transcoder or public copy",
    !has(bare, "_engine/KTX2Loader-G.js") && !has(bare, "_engine/basis_transcoder-H.wasm") && !has(bare, "basis/basis_transcoder.wasm"),
  );
  check("no draco → no decoder", !has(bare, "_engine/draco_decoder-B.wasm") && !has(bare, "draco/draco_decoder.wasm"));
  check("no script imports three/tsl → no TSL proxy", !has(bare, "_engine/tslRuntime-I.js"));
  check("not a live preview → no live-update client", !has(bare, "_engine/liveUpdate-K.js"));
  check(
    "the manifest, index.html and the editor's public leftovers never ship",
    ![".vite/manifest.json", "index.html", "app-icon.png", "tauri.svg"].some((rel) => has(bare, rel)),
  );
  check("an unrecognised lazy chunk ships (err towards working)", has(bare, "_engine/mystery-M.js"));
  check("an unrecognised worker ships too", has(bare, "_engine/unknownWorker-P.js"));
  eq(
    "skipped bytes are summed",
    bare.skippedBytes,
    templateFiles.filter(([rel]) => !bare.files.includes(rel)).reduce((n, [, s]) => n + s, 0),
  );
  check("trimming is reported", bare.trimmed === true);

  const full = selectRuntimeFiles({
    manifest,
    templateFiles,
    modules: ["physics-rapier", "gi", "postprocessing", "basis", "draco"],
    assetExtensions: ["exr"],
    scriptImports: ["three/tsl"],
    livePreview: true,
  });
  check("physics on → Rapier ships", has(full, "_engine/rapier-C.js"));
  check(
    "GI on → the GI system, meshoptimizer and the BVH worker ship",
    has(full, "_engine/GISystem-D.js") && has(full, "_engine/index-E.js") && has(full, "_engine/bvhBlasWorker-N.js"),
  );
  check("post-processing on → the addon and the cloud worker ship", has(full, "_engine/BloomNode-L.js") && has(full, "_engine/cloudNoiseWorker-O.js"));
  check("an .exr shipped → the EXR loader ships", has(full, "_engine/EXRLoader-F.js"));
  check(
    "basis on → KTX2 loader, transcoder and public copy",
    has(full, "_engine/KTX2Loader-G.js") && has(full, "_engine/basis_transcoder-H.wasm") && has(full, "basis/basis_transcoder.wasm"),
  );
  check("draco on → the decoder ships", has(full, "_engine/draco_decoder-B.wasm") && has(full, "draco/draco_decoder.wasm"));
  check("a script importing three/tsl → the TSL proxy ships", has(full, "_engine/tslRuntime-I.js"));
  check("a live preview → the live-update client ships", has(full, "_engine/liveUpdate-K.js"));
  check("the leftovers still never ship", !has(full, "tauri.svg") && !has(full, ".vite/manifest.json"));

  const viaModel = selectRuntimeFiles({ manifest, templateFiles, modules: [], dracoModels: true });
  check(
    "a Draco-compressed model needs the decoder even with the module off",
    has(viaModel, "_engine/draco_decoder-B.wasm") && has(viaModel, "draco/draco_decoder.wasm"),
  );
  const viaCompress = selectRuntimeFiles({ manifest, templateFiles, modules: [], compressTextures: true });
  check("build-time texture compression needs the transcoder", has(viaCompress, "basis/basis_transcoder.wasm"));
  const viaBasisFile = selectRuntimeFiles({ manifest, templateFiles, modules: [], assetExtensions: ["basis"] });
  check("a shipped .basis needs the KTX2 loader", has(viaBasisFile, "_engine/KTX2Loader-G.js"));
  const viaHdr = selectRuntimeFiles({
    manifest: {
      ...manifest,
      "player.html": { ...manifest["player.html"], dynamicImports: ["node_modules/three/examples/jsm/loaders/RGBELoader.js"] },
      "node_modules/three/examples/jsm/loaders/RGBELoader.js": { file: "_engine/RGBELoader-R.js", imports: ["node_modules/three/examples/jsm/loaders/HDRLoader.js"] },
      "node_modules/three/examples/jsm/loaders/HDRLoader.js": { file: "_engine/HDRLoader-S.js" },
    },
    templateFiles: [["_engine/RGBELoader-R.js", 1], ["_engine/HDRLoader-S.js", 1]],
    modules: [],
    assetExtensions: ["hdr"],
  });
  check("an .hdr sky → both HDR loaders (static import followed)", has(viaHdr, "_engine/RGBELoader-R.js") && has(viaHdr, "_engine/HDRLoader-S.js"));

  const moduleChunk = selectRuntimeFiles({
    manifest: {
      ...manifest,
      "player.html": { ...manifest["player.html"], dynamicImports: ["src/modules/architecture/Big.js"] },
      "src/modules/architecture/Big.js": { file: "_engine/Big-Q.js" },
    },
    templateFiles: [["_engine/Big-Q.js", 1], ["_engine/player-A.js", 1]],
    modules: ["architecture"],
  });
  check("a module's own chunk ships when the module is enabled", has(moduleChunk, "_engine/Big-Q.js"));

  const noManifest = selectRuntimeFiles({ manifest: null, templateFiles, modules: [] });
  check(
    "without a manifest everything but the never-ship files is copied",
    noManifest.trimmed === false && has(noManifest, "_engine/rapier-C.js") && !has(noManifest, ".vite/manifest.json"),
  );

  const specs = scriptImportSpecifiers([
    "import { Component } from \"engine\";\nimport * as THREE from 'three';\nconst tsl = await import(\"three/tsl\");",
    null,
    "export default class X {}",
  ]);
  eq("bare specifiers are found by shape", [...specs].sort(), ["engine", "three", "three/tsl"]);
}

console.log(`\nBUILD-TEST ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
