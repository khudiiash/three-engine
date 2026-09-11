import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { EventEmitter } from "../src/engine/EventEmitter.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";
import { registerComponent } from "../src/engine/components/registry.js";
import { ArchitecturePieceComponent } from "../src/modules/architecture/ArchitecturePieceComponent.js";
import { vmSingleton } from "../src/editor/singleton.js";
import { commandBus } from "../src/editor/commands/CommandBus.js";

// Compile the production JSX without loading the browser-only modal builder.
// Command, entity and geometry imports remain the actual production modules.
const sourceUrl = new URL("../src/editor/components/ArchitectureSelectionControls.jsx", import.meta.url);
const compiled = await build({
  stdin: { contents: await readFile(sourceUrl, "utf8"), loader: "jsx", resolveDir: fileURLToPath(new URL(".", sourceUrl)) },
  bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
  plugins: [{ name: "browser-view-boundary", setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, args => {
      if (args.path === "./ArchitectureBuilder.jsx") return { path: "numbers", namespace: "view" };
      if (args.path === "../EditorShell.jsx") return { path: "shell", namespace: "view" };
      return { path: args.path.startsWith(".") ? new URL(args.path, sourceUrl).href : import.meta.resolve(args.path), external: true };
    });
    plugin.onLoad({ filter: /.*/, namespace: "view" }, args => ({ contents: args.path === "numbers" ? "export const ArchitectureNumber = () => null;" : "export const openPanel = () => {};", loader: "js" }));
  } }],
});
const { setArchitectureSelectionDimension, rotateArchitectureSelection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

registerComponent(MeshComponent);
function fixture(props) {
  const engine = new EventEmitter(); let dirties = 0;
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], viewOnlyComponents: new Set(), playing: false, sceneName: "Selection controls", physics: { markDirty() { dirties++; } } });
  engine.getEntity = id => engine.entities.get(id);
  const entity = new Entity(engine, { id: "selected", name: "Selected piece" });
  engine.entities.set(entity.id, entity); entity.setParent(null);
  entity.setTransform({ position: [7, 11, -4], rotation: [.2, .4, -.3], scale: [2, 1.5, .75] });
  vmSingleton("engineInstance", () => ({ instance: null, loader: null })).instance = engine;
  const piece = entity.addComponent(new ArchitecturePieceComponent(props));
  commandBus.clearHistory();
  return { engine, entity, piece, dirties: () => dirties };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);

test("context size edits rebuild real geometry and colliders, undo exactly, and retain object scale", async () => {
  const { entity, piece, dirties } = fixture({ shape: "wall", size: [4, 3, .2] });
  await Promise.resolve(); await Promise.resolve();
  const before = entity.getTransform(), oldGeometry = piece.geometry, initialDirties = dirties();
  setArchitectureSelectionDimension(entity.id, 0, 9);
  assert.deepEqual(piece.props.size, [9, 3, .2]);
  near(piece.geometry.boundingBox.max.x - piece.geometry.boundingBox.min.x, 9);
  assert.notEqual(piece.geometry, oldGeometry); assert.ok(dirties() > initialDirties);
  assert.deepEqual(entity.getTransform(), before); assert.equal(commandBus.undoStack.length, 1);
  commandBus.undo();
  assert.deepEqual(piece.props.size, [4, 3, .2]); near(piece.geometry.boundingBox.max.x - piece.geometry.boundingBox.min.x, 4);
  assert.deepEqual(entity.getTransform(), before);
  commandBus.redo(); near(piece.geometry.boundingBox.max.x - piece.geometry.boundingBox.min.x, 9);
  const history = commandBus.undoStack.length;
  setArchitectureSelectionDimension(entity.id, 0, 9);
  setArchitectureSelectionDimension(entity.id, 0, Infinity);
  assert.equal(commandBus.undoStack.length, history, "unchanged and invalid input should not add history");
  entity.dispose();
});

test("polygon dimensions resize the outline and openings together in one undo step", async () => {
  const footprint = [[-5, -4], [5, -4], [5, 4], [-5, 4]], holes = [[[-1, -1], [1, -1], [1, 1], [-1, 1]]];
  const { entity, piece } = fixture({ shape: "floor", size: [10, .3, 8], footprint, holes });
  await Promise.resolve(); await Promise.resolve();
  const transform = entity.getTransform();
  setArchitectureSelectionDimension(entity.id, 0, 20);
  assert.deepEqual(piece.props.footprint, [[-10, -4], [10, -4], [10, 4], [-10, 4]]);
  assert.deepEqual(piece.props.holes, [[[-2, -1], [2, -1], [2, 1], [-2, 1]]]);
  near(piece.geometry.boundingBox.max.x - piece.geometry.boundingBox.min.x, 20);
  assert.deepEqual(entity.getTransform(), transform); assert.equal(commandBus.undoStack.length, 1);
  const rendered = new THREE.Mesh(piece.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  rendered.updateMatrixWorld();
  assert.equal(new THREE.Raycaster(new THREE.Vector3(1.5, 5, 0), new THREE.Vector3(0, -1, 0)).intersectObject(rendered).length, 0, "resized opening must be a real hole");
  rendered.material.dispose();
  commandBus.undo();
  assert.deepEqual(piece.props.footprint, footprint); assert.deepEqual(piece.props.holes, holes); assert.deepEqual(piece.props.size, [10, .3, 8]);
  commandBus.redo();
  near(piece.geometry.boundingBox.max.x - piece.geometry.boundingBox.min.x, 20);
  entity.dispose();
});

test("90 degree rotation preserves existing pitch, roll, position and scale through undo and redo", () => {
  const { entity } = fixture({ shape: "box", size: [2, 3, 4] });
  const before = entity.getTransform();
  rotateArchitectureSelection(entity.id);
  const after = entity.getTransform();
  near(after.rotation[0], before.rotation[0]); near(after.rotation[1], before.rotation[1] + Math.PI / 2); near(after.rotation[2], before.rotation[2]);
  assert.deepEqual(after.scale, before.scale); assert.deepEqual(after.position, before.position);
  commandBus.undo(); assert.deepEqual(entity.getTransform(), before);
  commandBus.redo(); assert.deepEqual(entity.getTransform(), after);
  entity.dispose();
});

test("column diameter fields follow the column geometry instead of changing an ignored short axis", () => {
  const { entity, piece } = fixture({ shape: "column", size: [2, 4, 2], sides: 8 });
  const originalWidth = piece.geometry.boundingBox.max.x - piece.geometry.boundingBox.min.x;
  setArchitectureSelectionDimension(entity.id, 0, 1);
  assert.deepEqual(piece.props.size, [1, 4, 1]);
  near(piece.geometry.boundingBox.max.x - piece.geometry.boundingBox.min.x, originalWidth / 2);
  commandBus.undo(); assert.deepEqual(piece.props.size, [2, 4, 2]);
  entity.dispose();
});
