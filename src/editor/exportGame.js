import { ensureEngine } from "./engineInstance.js";

const basename = (p) => p.split(/[\\/]/).pop();

/**
 * Exports the current scene as a standalone playable build: copies the
 * prebuilt player template (dist-player/, from `npm run build:player`),
 * writes scene.json, and copies every referenced asset into assets/,
 * rewriting scene paths to be relative. Serve the output folder with any
 * static server (module scripts don't run over file://).
 */
export async function exportGame() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const outDir = await open({ directory: true, title: "Export Game To…" });
  if (!outDir) return;

  const engine = await ensureEngine();
  const { serializeScene } = await import("../engine/index.js");
  const scene = serializeScene(engine);

  // Runtime-relevant project settings ride along in the scene JSON.
  const { getProjectSettings } = await import("./projectSettings.js");
  const { useProjectStore } = await import("./store/projectStore.js");
  const projectSettings = getProjectSettings();
  const meta = useProjectStore.getState();
  scene.player = {
    title: projectSettings.game.title || meta.projectMeta?.name || basename(meta.rootPath ?? "Game"),
    pixelRatioCap: projectSettings.rendering.pixelRatioCap,
  };
  // Enabled engine modules ride along so the player can boot them before
  // deserializing (their components must be registered to instantiate).
  const { useModulesStore } = await import("./modules.js");
  scene.modules = [...useModulesStore.getState().enabled];
  // Input config rides along — the player applies it on boot.
  scene.input = engine.input.toJSON();
  const assets = new Map(); // absolute source -> relative dest
  const scriptPaths = new Set(); // scripts ship transpiled, not copied
  const materialPaths = new Set(); // .mat files ship with rewritten texture paths
  const audioSidecarPaths = new Set(); // .audio JSON files copied verbatim with path rewrites
  const claim = (p) => {
    if (!p || typeof p !== "string") return p;
    const rel = `assets/${basename(p)}`;
    assets.set(p, rel);
    return rel;
  };

  const visit = (entity) => {
    for (const c of entity.components ?? []) {
      if (c.type === "mesh") {
        if (c.props.material) {
          materialPaths.add(c.props.material);
          c.props.material = `assets/${basename(c.props.material)}`;
        }
      } else if (c.type === "model") {
        c.props.path = claim(c.props.path) || c.props.path;
        for (const [name, matPath] of Object.entries(c.props.materials ?? {})) {
          materialPaths.add(matPath);
          c.props.materials[name] = `assets/${basename(matPath)}`;
        }
      } else if (c.type === "animation" && c.props.controller) {
        c.props.controller = claim(c.props.controller);
      } else if (c.type === "script" && c.props.path) {
        scriptPaths.add(c.props.path);
        c.props.path = `assets/${basename(c.props.path).replace(/\.ts$/i, ".js")}`;
      } else if (c.type === "sound") {
        // Each entry's audioAsset is the sidecar path. Ship the sidecar JSON
        // (with its inner `path` rewritten to the assets folder) and the raw
        // audio file it points to. Both end up in `assets/` and the
        // runtime's asset resolver loads them by relative URL.
        for (const entry of c.props.entries ?? []) {
          if (!entry.audioAsset) continue;
          audioSidecarPaths.add(entry.audioAsset);
          entry.audioAsset = `assets/${basename(entry.audioAsset)}`;
        }
      }
    }
    (entity.children ?? []).forEach(visit);
  };
  scene.entities.forEach(visit);

  const { invoke } = await import("@tauri-apps/api/core");
  try {
    // Transpile TS scripts to plain JS files shipped alongside the scene.
    const { transpileScript } = await import("./assetLoader.js");
    const files = [];
    for (const src of scriptPaths) {
      const raw = await invoke("read_text_file", { path: src });
      files.push([`assets/${basename(src).replace(/\.ts$/i, ".js")}`, await transpileScript(raw)]);
    }
    for (const src of materialPaths) {
      const def = JSON.parse(await invoke("read_text_file", { path: src }));
      if (def.map) def.map = claim(def.map);
      for (const n of def.shaderGraph?.nodes ?? []) {
        if (n.type === "texture" && n.props?.path) n.props.path = claim(n.props.path);
      }
      files.push([`assets/${basename(src)}`, JSON.stringify(def)]);
    }
    for (const src of audioSidecarPaths) {
      // Sidecar may reference a sibling raw audio file (def.path) — copy
      // that and rewrite the path. When the sidecar JSON is missing or has
      // no `path`, the runtime falls back to using the sidecar's own path
      // minus its `.audio` extension as the raw file (handled by
      // loadAudioAsset), so we also copy the raw-equivalent just in case.
      let def = null;
      try {
        def = JSON.parse(await invoke("read_text_file", { path: src }));
      } catch {
        def = null;
      }
      const rawPath = def?.path ?? src.replace(/\.audio$/i, "");
      if (def && def.path) def.path = claim(def.path);
      const sidecarBody = def ? JSON.stringify(def) : `{"path":"${basename(rawPath)}"}`;
      files.push([`assets/${basename(src)}`, sidecarBody]);
      // Best-effort: raw audio lives next to the sidecar typically. Copy
      // it when present; missing files are silently skipped (the runtime
      // will log on first play attempt).
      try {
        await invoke("stat_file", { path: rawPath });
        assets.set(rawPath, `assets/${basename(rawPath)}`);
      } catch {
        // Raw file missing — likely the sidecar pointed elsewhere.
      }
    }
    // Texture import settings ship as sidecar .meta files when present.
    for (const [src, rel] of [...assets.entries()]) {
      if (!/\.(png|jpe?g|webp)$/i.test(src)) continue;
      try {
        await invoke("stat_file", { path: `${src}.meta` });
        assets.set(`${src}.meta`, `${rel}.meta`);
      } catch {
        // No sidecar — defaults apply.
      }
    }
    await invoke("export_game", {
      outDir,
      sceneJson: JSON.stringify(scene, null, 2),
      assets: [...assets.entries()],
      files,
    });
    console.log(`Game exported to ${outDir} (${assets.size + files.length} asset(s))`);
  } catch (err) {
    console.error(`Export failed: ${err}`);
  }
}
