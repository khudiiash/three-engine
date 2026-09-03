import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WEBGPU_INSPECTOR_ENV,
  WEBGPU_INSPECTOR_TAG,
  inspectorPaths,
  isInspectorExtension,
  tauriCliInvocation,
} from "../scripts/run-tauri-webgpu-inspector.mjs";

test("the inspector launcher uses a pinned release and a private opt-in environment key", () => {
  assert.match(WEBGPU_INSPECTOR_TAG, /^v\d+\.\d+\.\d+$/);
  assert.equal(WEBGPU_INSPECTOR_ENV, "THREE_ENGINE_WEBGPU_INSPECTOR_EXTENSIONS");
});

test("the WebView loader receives a parent containing unpacked extension folders", () => {
  const paths = inspectorPaths("C:\\engine");
  assert.equal(paths.extension, join(paths.container, "webgpu-inspector"));
});

test("Windows launches the Tauri JavaScript entry without a cmd shell shim", () => {
  const invocation = tauriCliInvocation("C:\\engine", ["--verbose"]);
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[0], join(
    "C:\\engine", "node_modules", "@tauri-apps", "cli", "tauri.js",
  ));
  assert.deepEqual(invocation.args.slice(1), [
    "dev",
    "--config", "src-tauri/tauri.inspector.conf.json",
    "--verbose",
  ]);
});

test("extension validation requires the DevTools panel manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "three-webgpu-inspector-"));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      name: "WebGPU Inspector",
      manifest_version: 3,
      devtools_page: "webgpu_inspector_devtools.html",
    }));
    assert.equal(isInspectorExtension(root), true);
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      name: "WebGPU Inspector",
      manifest_version: 3,
    }));
    assert.equal(isInspectorExtension(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
