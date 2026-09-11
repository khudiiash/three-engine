/**
 * The export walk, run against a REAL project through the editor's own code.
 *
 * The headless test proves the naming rules in isolation; this proves the
 * exporter uses them — over a project deliberately shaped like the one that
 * broke it. Downloaded PBR sets all name their maps the same thing, so
 * `textures/wood/color.png` and `textures/stone/color.png` are the normal case,
 * not a contrived one. Before this, both were copied to `assets/color.png`: the
 * build shipped, and one of the two materials silently wore the other's
 * texture. Nothing short of driving the real walk catches that, because the
 * bug is in the *mapping*, not in any single function.
 *
 * The Tauri shim serves the project read-only and stands in for the write
 * commands, so the manifest the exporter would have written is captured
 * instead of hitting the disk.
 *
 *   npx vite --port 5201
 *   node scripts/run-build-export-smoke.mjs [url]
 *
 * HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const ROOT = path.join(os.tmpdir(), "build-export-smoke").replaceAll("\\", "/");
const OUT = path.join(os.tmpdir(), "build-export-smoke-out").replaceAll("\\", "/");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// --- A project whose asset names collide ------------------------------------
// 1x1 PNG. The exporter never decodes these; it only has to route them.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const write = (rel, contents) => {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return `${ROOT}/${rel.replaceAll("\\", "/")}`;
};

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const woodTex = write("textures/wood/color.png", PNG);
const stoneTex = write("textures/stone/color.png", PNG);
// Two materials that share a basename too — documents go through a different
// code path (they are re-emitted, not copied) and collided just as silently.
const woodMat = write("materials/wood/Surface.mat", JSON.stringify({ name: "Wood", map: woodTex, color: "#ffffff" }));
const stoneMat = write("materials/stone/Surface.mat", JSON.stringify({ name: "Stone", map: stoneTex, color: "#888888" }));
write("art/logo.png", PNG);
// The script names the next level by path — what makes Level2 reachable when
// the scene list is left on its default.
write(
  "scripts/Player.ts",
  "export default class Player { onUpdate() {} next() { return this.entity.engine.loadScene(\"scenes/Level2.scene\"); } }\n",
);
const playerScript = `${ROOT}/scripts/Player.ts`;

// A material flagged Exclude, referenced by the start scene: neither it nor the
// texture only it references may ship — exclusion is decided before the
// document is read, not after its children were already claimed.
const wipTex = write("textures/wip/color.png", PNG);
const wipMat = write("materials/wip/Wip.mat", JSON.stringify({ name: "Wip", map: wipTex }));
write("materials/wip/Wip.mat.meta", JSON.stringify({ build: { exclude: true } }));

// Prefabs: one the start scene instances, one nothing reaches, one pinned with
// Preload. Each carries its own material and texture, so what ships tells
// which prefabs were embedded.
const prefabFixture = (guid, name, folder) => {
  const tex = write(`textures/${folder}/color.png`, PNG);
  const mat = write(`materials/${folder}/${name}.mat`, JSON.stringify({ name, map: tex }));
  const path = write(
    `prefabs/${name}.prefab`,
    JSON.stringify({
      prefab: 1,
      guid,
      name,
      root: {
        fid: `f_${guid}`,
        name,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        components: [{ type: "mesh", props: { geometry: "box", material: mat } }],
        children: [],
      },
    }),
  );
  return { guid, name, tex, mat, path };
};
const usedPrefab = prefabFixture("p_used", "Prop", "prop");
const unusedPrefab = prefabFixture("p_unused", "Crate", "crate");
const pinnedPrefab = prefabFixture("p_pinned", "Pinned", "pinned");
write("prefabs/Pinned.prefab.meta", JSON.stringify({ build: { preload: true } }));

const entity = (id, name, components = []) => ({
  id,
  name,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  components,
  children: [],
});
write(
  "scenes/Main.scene",
  JSON.stringify({
    version: 1,
    name: "Main",
    entities: [
      entity("wood", "Wood Box", [{ type: "mesh", props: { geometry: "box", material: woodMat } }]),
      entity("stone", "Stone Box", [{ type: "mesh", props: { geometry: "box", material: stoneMat } }]),
      entity("player", "Player", [{ type: "script", props: { scripts: [{ path: playerScript }] } }]),
      entity("cam", "Camera", [{ type: "camera", props: {} }]),
      entity("wip", "WIP Box", [{ type: "mesh", props: { geometry: "box", material: wipMat } }]),
      {
        id: "prop1",
        name: "Prop",
        prefab: { guid: usedPrefab.guid, path: usedPrefab.path },
        position: [2, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        overrides: [],
      },
    ],
  }),
);
write("scenes/Level2.scene", JSON.stringify({ version: 1, name: "Level2", entities: [entity("c2", "Camera 2", [{ type: "camera", props: {} }])] }));
// A third scene that must NOT ship — the scene list is an allow-list.
write("scenes/Scratch.scene", JSON.stringify({ version: 1, name: "Scratch", entities: [] }));

write(
  "project.json",
  JSON.stringify(
    {
      name: "Collide",
      mainScene: "",
      settings: {
        game: { title: "Collide", saveVersion: 1 },
        build: {
          startScene: "scenes/Main.scene",
          scenes: ["scenes/Main.scene", "scenes/Level2.scene"],
          quality: "medium",
          target: "web",
          icon: "art/logo.png",
          loading: { background: "#123456", accent: "#abcdef", showTitle: true, showLogo: true },
        },
      },
    },
    null,
    2,
  ),
);

// --- Drive the editor -------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => {
  if (process.env.STACKS) console.error(`---- PAGE ERROR ----\n${e.stack ?? e.message}`);
  pageErrors.push(e.message);
});

/** Whatever the exporter asked the Rust side to write. */
let manifest = null;
const binaryWrites = [];
const zipCalls = [];

await installTauriShim(page, {
  writableRoot: OUT,
  verbose: !!process.env.VERBOSE,
  extraCommands: {
    export_game: (args) => {
      manifest = args;
      return null;
    },
    read_player_template: ({ rel }) => fs.readFileSync(path.join("dist-player", rel), "utf8"),
    list_player_template: () => {
      const walk = (dir, prefix) =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
            : [[`${prefix}${entry.name}`, fs.statSync(path.join(dir, entry.name)).size]],
        );
      return walk("dist-player", "");
    },
    write_binary_file: ({ path: p, contents }) => {
      binaryWrites.push([p, contents?.length ?? 0]);
      return null;
    },
    zip_dir: (args) => {
      zipCalls.push(args);
      return 0;
    },
  },
});

// Import the module instance the APP is using, not a fresh copy: Vite rewrites
// imports of files edited since the server started to `…?t=<mtime>`, so a bare
// import from the harness would load a SECOND editor with its own stores.
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

try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await new Promise((r) => setTimeout(r, 4000));

  // Opening a project ends in a store `refresh()` that routinely outlives the
  // `page.evaluate` that started it — puppeteer then rejects with "Promise was
  // collected". Park the result on the page and poll for it instead.
  await page.evaluate((root) => {
    globalThis.__opened = false;
    globalThis
      .__importLive("/src/editor/store/projectStore.js")
      .then((m) => m.useProjectStore.getState().openProject(root))
      .finally(() => {
        globalThis.__opened = true;
      });
  }, ROOT);
  await page.waitForFunction(() => globalThis.__opened === true, { timeout: 60000, polling: 200 });
  await new Promise((r) => setTimeout(r, 3000));

  // Kick the export off and park the result, rather than holding a CDP promise
  // across a long chain of store refreshes (which puppeteer garbage-collects).
  await page.evaluate((outDir) => {
    globalThis.__build = { done: false };
    globalThis
      .__importLive("/src/editor/exportGame.js")
      .then((m) => m.exportGame({ outDir }))
      .then((report) => Object.assign(globalThis.__build, { report, done: true }))
      .catch((error) => Object.assign(globalThis.__build, { error: String(error?.stack ?? error), done: true }));
  }, OUT);
  await page.waitForFunction(() => globalThis.__build?.done, { timeout: 120000, polling: 250 });
  const { report, error } = await page.evaluate(() => ({
    report: globalThis.__build.report,
    error: globalThis.__build.error ?? null,
  }));
  if (error) throw new Error(error);

  check("the export reports success", report?.ok === true, report?.error ?? "");
  check("it received a manifest to write", !!manifest, "");
  if (!manifest) throw new Error("export_game was never called");

  const assets = manifest.assets ?? [];
  const files = manifest.files ?? [];
  const dests = [...assets.map(([, rel]) => rel), ...files.map(([rel]) => rel)];
  const dupes = dests.filter((rel, i) => dests.indexOf(rel) !== i);
  check("no two shipped files claim the same destination", dupes.length === 0, [...new Set(dupes)].join(", "));

  const destOf = (source) => assets.find(([src]) => src.toLowerCase() === source.toLowerCase())?.[1] ?? null;
  const woodDest = destOf(woodTex);
  const stoneDest = destOf(stoneTex);
  check("both same-named textures ship", !!woodDest && !!stoneDest, `${woodDest} / ${stoneDest}`);
  check("under different names", woodDest !== stoneDest, `${woodDest} vs ${stoneDest}`);

  // The point of the whole exercise: each material must still name ITS OWN
  // texture after the rename. Uniqueness alone would be satisfied by a build
  // where both materials point at the same file.
  const fileBody = (predicate) => files.find(([rel]) => predicate(rel))?.[1];
  const matBodies = files.filter(([rel]) => rel.endsWith(".mat")).map(([rel, body]) => [rel, JSON.parse(body)]);
  const shipsMaterial = (name) => matBodies.some(([, def]) => def.name === name);
  check("both materials ship", shipsMaterial("Wood") && shipsMaterial("Stone"), matBodies.map(([rel]) => rel).join(", "));
  const wood = matBodies.find(([, def]) => def.name === "Wood")?.[1];
  const stone = matBodies.find(([, def]) => def.name === "Stone")?.[1];
  check("the wood material still points at the wood texture", wood?.map === woodDest, `${wood?.map} (want ${woodDest})`);
  check("the stone material still points at the stone texture", stone?.map === stoneDest, `${stone?.map} (want ${stoneDest})`);
  check(
    "the two materials do not share a texture",
    wood?.map !== stone?.map,
    `${wood?.map} vs ${stone?.map}`,
  );

  // The scene has to agree with the manifest, or the build ships correct files
  // nobody can find.
  const scene = JSON.parse(manifest.sceneJson);
  const matRefs = scene.entities
    .filter((e) => e.id === "wood" || e.id === "stone")
    .flatMap((e) => e.components ?? [])
    .filter((c) => c.type === "mesh")
    .map((c) => c.props.material);
  check("the scene names two distinct materials", new Set(matRefs).size === 2, matRefs.join(", "));
  check(
    "every material the scene names was shipped",
    matRefs.every((ref) => files.some(([rel]) => rel === ref)),
    matRefs.join(", "),
  );

  // --- Only what the build can reach ships -----------------------------------
  // An Exclude flag keeps the material AND the texture only it references out;
  // the scene still names it (a 404 at runtime, which the report warns about).
  check("an excluded material does not ship", !shipsMaterial("Wip"), "");
  check("…nor the texture only it referenced", destOf(wipTex) === null, String(destOf(wipTex)));
  check("the exclusion is reported", (report.excluded ?? []).length === 1, JSON.stringify(report.excluded));
  check(
    "and warned about",
    (report.warnings ?? []).some((w) => /Excluded from the build/.test(w)),
    (report.warnings ?? []).join(" | "),
  );
  // Prefabs: the instanced one and the pinned one are embedded with their
  // assets; the one nothing reaches is left out along with its material and texture.
  const prefabGuids = (scene.prefabs ?? []).map((d) => d.guid).sort();
  check(
    "the instanced and the pinned prefab ship, the unreachable one does not",
    JSON.stringify(prefabGuids) === JSON.stringify(["p_pinned", "p_used"]),
    prefabGuids.join(", "),
  );
  check(
    "a shipped prefab carries a project-relative path, not the authoring path",
    (scene.prefabs ?? []).every((d) => d.path && !/^([A-Za-z]:|\/)/.test(d.path)),
    (scene.prefabs ?? []).map((d) => d.path).join(", "),
  );
  check("the instanced prefab's material and texture ship", shipsMaterial("Prop") && destOf(usedPrefab.tex) !== null, "");
  check("the pinned prefab's material and texture ship", shipsMaterial("Pinned") && destOf(pinnedPrefab.tex) !== null, "");
  check("the unreachable prefab's material does not ship", !shipsMaterial("Crate"), "");
  check("…nor its texture", destOf(unusedPrefab.tex) === null, String(destOf(unusedPrefab.tex)));
  check("the instance link has no authoring path", !scene.entities.find((e) => e.id === "prop1")?.prefab?.path, "");
  check("the report counts prefabs", report.prefabCount === 2 && report.prefabsSkipped === 1, `${report.prefabCount}/${report.prefabsSkipped}`);

  // --- The runtime is trimmed to what the game can reach ------------------------
  const templateFiles = manifest.templateFiles;
  check("the exporter hands over a runtime allow-list", Array.isArray(templateFiles), String(templateFiles));
  check("and asks for leftovers to be pruned", manifest.prune === true, String(manifest.prune));
  const enabledModules = scene.modules ?? [];
  check("the entry chunk is in it", (templateFiles ?? []).some((f) => /^_engine\/player-.*\.js$/.test(f)), "");
  check(
    "Rapier ships exactly when physics is enabled",
    (templateFiles ?? []).some((f) => /rapier/i.test(f)) === enabledModules.includes("physics-rapier"),
    `modules: ${enabledModules.join(", ") || "none"}`,
  );
  check(
    "the GI system ships exactly when GI is enabled",
    (templateFiles ?? []).some((f) => /GISystem/.test(f)) === enabledModules.includes("gi"),
    "",
  );
  check(
    "the manifest and the editor's public leftovers are not in the build",
    !(templateFiles ?? []).some((f) => /^\.vite\/|^tauri\.svg$|^app-icon\.png$/.test(f)),
    (templateFiles ?? []).filter((f) => /^\.vite\/|^tauri\.svg$|^app-icon\.png$/.test(f)).join(", "),
  );
  check("the report says the runtime was trimmed", report.runtime?.trimmed === true && report.runtime.skipped > 0, JSON.stringify(report.runtime));

  // Scripts: transpiled, renamed, and referenced by the new name.
  const scriptRef = scene.entities.flatMap((e) => e.components ?? []).find((c) => c.type === "script")?.props.scripts[0].path;
  check("the script reference points at a .js", /\.js$/.test(scriptRef ?? ""), String(scriptRef));
  check("and that file ships", files.some(([rel]) => rel === scriptRef), String(scriptRef));
  check("transpiled, not copied verbatim", !(fileBody((rel) => rel === scriptRef) ?? "").includes(": void"), "");

  // Build settings actually took.
  check("the configured start scene booted", scene.name === "Main", String(scene.name));
  check("scene.json records which path it is a copy of", scene.player?.startScene === "scenes/Main.scene", String(scene.player?.startScene));
  check("the quality preset shipped", scene.player?.quality === "medium", String(scene.player?.quality));
  check("the game title shipped", scene.player?.title === "Collide", String(scene.player?.title));

  const shippedScenes = files.filter(([rel]) => rel.endsWith(".scene")).map(([rel]) => rel);
  check("only the listed scenes ship", shippedScenes.length === 2, shippedScenes.join(", "));
  check("the scene left off the list is absent", !shippedScenes.some((s) => /Scratch/.test(s)), shippedScenes.join(", "));

  // index.html is rewritten, not just copied.
  const indexHtml = fileBody((rel) => rel === "index.html");
  check("index.html is rewritten for this game", !!indexHtml, "");
  check("with the configured loading colours", (indexHtml ?? "").includes("--loading-bg:#123456"), "");
  check("and the game's title", (indexHtml ?? "").includes("<title>Collide</title>"), "");

  // The icon goes beside index.html, not into assets/ — a favicon among the
  // game's textures reads like one of them.
  check(
    "the icon ships at the build root",
    assets.some(([src, rel]) => /logo\.png$/i.test(src) && rel === "icon.png"),
    assets.filter(([src]) => /logo/i.test(src)).map(([, rel]) => rel).join(", ") || "not shipped",
  );
  check("index.html links it as the favicon", (indexHtml ?? "").includes('<link rel="icon" href="icon.png"'), "");
  check("and shows it on the loading screen", (indexHtml ?? "").includes('class="loading-logo" src="icon.png"'), "");

  // --- The other two targets -------------------------------------------------
  // Same game, different delivery. Both take branches the web target never
  // touches, and a throw in either is invisible until someone picks it.
  const runExportWith = async (buildPatch, outDir) => {
    manifest = null;
    zipCalls.length = 0;
    await page.evaluate(
      async ({ buildPatch: p, outDir: dir }) => {
        globalThis.__build = { done: false };
        const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
        const meta = useProjectStore.getState().projectMeta;
        useProjectStore.setState({
          projectMeta: { ...meta, settings: { ...meta.settings, build: { ...meta.settings.build, ...p } } },
        });
        globalThis
          .__importLive("/src/editor/exportGame.js")
          .then((m) => m.exportGame({ outDir: dir }))
          .then((r) => Object.assign(globalThis.__build, { report: r, done: true }))
          .catch((e) => Object.assign(globalThis.__build, { error: String(e?.stack ?? e), done: true }));
      },
      { buildPatch, outDir },
    );
    await page.waitForFunction(() => globalThis.__build?.done, { timeout: 120000, polling: 250 });
    return page.evaluate(() => ({ report: globalThis.__build.report, error: globalThis.__build.error ?? null }));
  };
  const runTargetExport = (target, outDir) => runExportWith({ target }, outDir);

  // --- Scene reachability (the default scene selection) ----------------------
  // The project's build list is explicit above. On the default, only the start
  // scene and what it names ship: Level2 through the script's loadScene
  // literal, never Scratch. "all" is the opt-in for everything.
  const reach = await runExportWith({ target: "web", scenes: null }, `${OUT}/reach`);
  check("the default scene selection builds", reach.report?.ok === true, reach.error ?? reach.report?.error ?? "");
  const reachScenes = (manifest?.files ?? []).filter(([rel]) => rel.endsWith(".scene")).map(([rel]) => rel).sort();
  check(
    "it ships the start scene and the level the script names, nothing else",
    JSON.stringify(reachScenes) === JSON.stringify(["scenes/Level2.scene", "scenes/Main.scene"]),
    reachScenes.join(", "),
  );
  check("the report lists them", JSON.stringify([...(reach.report?.scenes ?? [])].sort()) === JSON.stringify(reachScenes), String(reach.report?.scenes));
  check("in reachable mode", reach.report?.sceneMode === "reachable", String(reach.report?.sceneMode));
  const everything = await runExportWith({ target: "web", scenes: "all" }, `${OUT}/all`);
  const allScenes = (manifest?.files ?? []).filter(([rel]) => rel.endsWith(".scene")).map(([rel]) => rel);
  check('"all" ships every scene, Scratch included', everything.report?.ok === true && allScenes.length === 3, allScenes.join(", "));

  const zipRun = await runTargetExport("zip", `${OUT}/zip`);
  check("the zip target builds", zipRun.report?.ok === true, zipRun.error ?? zipRun.report?.error ?? "");
  check("it zipped the build folder", zipCalls.length === 1, JSON.stringify(zipCalls));
  check(
    "the archive is named after the game",
    /Collide\.zip$/.test(zipCalls[0]?.dest ?? ""),
    zipCalls[0]?.dest ?? "",
  );
  // The archive must be a SIBLING of what it archives. Written inside, it
  // would be walked into itself — a zip containing a growing copy of itself.
  check(
    "the build goes in its own folder",
    zipCalls[0]?.dir === `${OUT}/zip/Collide`,
    `${zipCalls[0]?.dir} (want ${OUT}/zip/Collide)`,
  );
  check(
    "and the archive sits beside it, not inside it",
    zipCalls[0]?.dest === `${OUT}/zip/Collide.zip`,
    String(zipCalls[0]?.dest),
  );
  check(
    "the manifest was written into that folder",
    manifest?.outDir === `${OUT}/zip/Collide`,
    String(manifest?.outDir),
  );

  const desktopOut = `${OUT}/desktop`;
  const desktopRun = await runTargetExport("desktop", desktopOut);
  check("the desktop target builds", desktopRun.report?.ok === true, desktopRun.error ?? desktopRun.report?.error ?? "");
  check(
    "the game itself goes under web/",
    manifest?.outDir === `${desktopOut}/web`,
    String(manifest?.outDir),
  );
  const scaffolded = (rel) => fs.existsSync(path.join(desktopOut, rel));
  check(
    "the Tauri project is written beside it",
    ["package.json", "README.md", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/src/main.rs"].every(scaffolded),
    fs.existsSync(desktopOut) ? fs.readdirSync(desktopOut).join(", ") : "nothing written",
  );
  if (scaffolded("src-tauri/tauri.conf.json")) {
    const conf = JSON.parse(fs.readFileSync(path.join(desktopOut, "src-tauri/tauri.conf.json"), "utf8"));
    check("its shell points at the web build", conf.build.frontendDist === "../web", String(conf.build.frontendDist));
    check("and carries the game's name", conf.productName === "Collide", String(conf.productName));
  }
  check(
    "the icon is written for the native bundle",
    binaryWrites.some(([p]) => p.endsWith("src-tauri/icons/icon.png")),
    binaryWrites.map(([p]) => p).join(", ") || "none",
  );

  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (err) {
  check("harness completed", false, err.message);
} finally {
  await browser.close();
  if (!process.env.KEEP) {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.rmSync(OUT, { recursive: true, force: true });
  }
}

console.log(`\nBUILD-EXPORT-SMOKE ${fail ? "FAIL" : "PASS"} — ${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
