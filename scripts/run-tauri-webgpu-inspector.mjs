import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep this pinned. WebView2 persists unpacked extensions by source path, so an
// implicit moving `main` checkout can make it remove the extension between runs.
export const WEBGPU_INSPECTOR_TAG = "v1.5.1";
export const WEBGPU_INSPECTOR_REPOSITORY =
  "https://github.com/brendan-duncan/webgpu_inspector.git";
export const WEBGPU_INSPECTOR_ENV =
  "THREE_ENGINE_WEBGPU_INSPECTOR_EXTENSIONS";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function inspectorPaths(root = repoRoot) {
  const cache = join(root, "artifacts", "webgpu-inspector", WEBGPU_INSPECTOR_TAG);
  return {
    source: join(cache, "source"),
    container: join(cache, "installed"),
    extension: join(cache, "installed", "webgpu-inspector"),
  };
}

export function isInspectorExtension(path) {
  try {
    const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
    return manifest.manifest_version === 3
      && manifest.name === "WebGPU Inspector"
      && typeof manifest.devtools_page === "string";
  } catch {
    return false;
  }
}

export function provisionInspector(root = repoRoot) {
  const paths = inspectorPaths(root);
  if (isInspectorExtension(paths.extension)) return paths.container;

  mkdirSync(dirname(paths.source), { recursive: true });
  if (!existsSync(join(paths.source, ".git"))) {
    const clone = spawnSync("git", [
      "clone",
      "--depth=1",
      "--branch", WEBGPU_INSPECTOR_TAG,
      "--single-branch",
      WEBGPU_INSPECTOR_REPOSITORY,
      paths.source,
    ], { cwd: root, stdio: "inherit" });
    if (clone.error) throw clone.error;
    if (clone.status !== 0) {
      throw new Error(`git clone failed with exit code ${clone.status}`);
    }
  }

  const chromeExtension = join(paths.source, "extensions", "chrome");
  if (!isInspectorExtension(chromeExtension)) {
    throw new Error(`WebGPU Inspector checkout has no built Chrome extension at ${chromeExtension}`);
  }
  mkdirSync(paths.container, { recursive: true });
  cpSync(chromeExtension, paths.extension, { recursive: true, force: true });
  if (!isInspectorExtension(paths.extension)) {
    throw new Error(`WebGPU Inspector installation is incomplete at ${paths.extension}`);
  }
  return paths.container;
}

export function tauriCliInvocation(root = repoRoot, forwarded = []) {
  const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  return {
    command: process.execPath,
    args: [
      cli,
      "dev",
      "--config", "src-tauri/tauri.inspector.conf.json",
      ...forwarded,
    ],
  };
}

export function runTauriInspector(args = process.argv.slice(2), root = repoRoot) {
  if (process.platform !== "win32") {
    throw new Error("Tauri browser extensions are currently supported only by WebView2 on Windows.");
  }
  const prepareOnly = args.includes("--prepare-only");
  const forwarded = args.filter((arg) => arg !== "--prepare-only");
  const extensionContainer = provisionInspector(root);
  console.log(`WebGPU Inspector ${WEBGPU_INSPECTOR_TAG} ready at ${extensionContainer}`);
  if (prepareOnly) return 0;

  // Launch the JS entry explicitly. Node's spawnSync cannot execute a `.cmd`
  // shim directly on Windows without `shell: true`, and a shell would make
  // forwarded diagnostic arguments needlessly hard to quote safely.
  const invocation = tauriCliInvocation(root, forwarded);
  const child = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      [WEBGPU_INSPECTOR_ENV]: extensionContainer,
    },
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runTauriInspector();
  } catch (error) {
    console.error(`WebGPU Inspector startup failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
