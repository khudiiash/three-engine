import assert from "node:assert/strict";

import { EventEmitter } from "../src/engine/EventEmitter.js";
import { PostprocessComponent } from "../src/modules/postprocessing/PostprocessComponent.js";

const engine = new EventEmitter();
engine.renderer = null;
engine.registerRenderOverride = () => {};
engine.unregisterRenderOverride = () => {};

const entity = { engine, getComponent: () => null };
const component = new PostprocessComponent(entity);
component.onAttach();

let pipelineDisposals = 0;
let passDisposals = 0;
component.pipeline = { dispose: () => pipelineDisposals++ };
component.scenePass = { dispose: () => passDisposals++ };
component.outputNode = {};
component.signature = "compiled-for-old-renderer";

engine.emit("renderer-rebuilt");

assert.equal(pipelineDisposals, 1, "renderer rebuild disposes the old RenderPipeline");
assert.equal(passDisposals, 1, "renderer rebuild disposes old pass render targets");
assert.equal(component.pipeline, null, "a disposed renderer's pipeline cannot remain active");
assert.equal(component.scenePass, null, "a disposed renderer's scene pass cannot remain active");
assert.equal(component.signature, null, "the graph recompiles for the replacement renderer");

component.onDetach();
engine.emit("renderer-rebuilt");
assert.equal(pipelineDisposals, 1, "detaching removes the renderer-rebuild listener");

// Editor preview compiles against the active editor camera, while Play mode
// switches back to the camera that owns the component.
const previewEngine = new EventEmitter();
previewEngine.renderer = null;
previewEngine.playing = false;
previewEngine.registerRenderOverride = () => {};
previewEngine.unregisterRenderOverride = () => {};
const gameCamera = { name: "game" };
const editorCamera = { name: "editor" };
previewEngine.camera = editorCamera;
const previewEntity = {
  engine: previewEngine,
  getComponent: (type) => (type === "camera" ? { camera: gameCamera } : null),
};
const preview = new PostprocessComponent(previewEntity, { showInEditor: true });
preview.onAttach();
assert.equal(preview.renderCamera, editorCamera, "editor preview compiles for the active editor camera");
preview.pipeline = { dispose() {} };
assert.equal(preview.ownsCamera(previewEngine), true, "preview overrides the editor camera");

previewEngine.playing = true;
previewEngine.camera = gameCamera;
previewEngine.emit("play-changed", true);
assert.equal(preview.renderCamera, gameCamera, "Play switches the pass back to its owning camera");
preview.pipeline = { dispose() {} };
assert.equal(preview.ownsCamera(previewEngine), true, "owning camera is overridden in Play");

previewEngine.playing = false;
previewEngine.camera = editorCamera;
previewEngine.emit("play-changed", false);
assert.equal(preview.renderCamera, editorCamera, "Stop restores editor-camera preview");
preview.onDetach();

console.log("Postprocess renderer-rebuild and editor-preview checks passed.");
