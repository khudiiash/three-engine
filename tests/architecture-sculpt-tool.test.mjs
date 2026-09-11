import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { EventEmitter } from "../src/engine/EventEmitter.js";
import { Component } from "../src/engine/components/Component.js";
import { registerComponent } from "../src/engine/components/registry.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";
import { ArchitectureComponent } from "../src/modules/architecture/ArchitectureComponent.js";
import { vmSingleton } from "../src/editor/singleton.js";
import { commandBus } from "../src/editor/commands/CommandBus.js";
import { useSelectionStore } from "../src/editor/store/selectionStore.js";
import { createArchitectureModel } from "../src/editor/architectureModelBuild.js";
import { setupArchitectureSculptTool, armArchitectureSculpt, disarmArchitectureSculpt, setArchitectureSculptSetting, getArchitectureSculptState, dispatchArchitectureSculptKey } from "../src/editor/architectureSculptTool.js";
import { armTerrainBrush, disarmTerrainBrush } from "../src/editor/terrainBrush.js";

const near = (actual, expected, epsilon = 1e-4) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const form = (overrides = {}) => ({ id: "house", shape: "box", position: [0, 0, 0], size: [6, 3, 6], rotationY: 0, color: "#d5d1c7", roof: "hip", roofHeight: 1.2, windows: false, ...overrides });
function fixture() {
  registerComponent(MeshComponent); registerComponent(ArchitectureComponent);
  registerComponent(class extends Component { static type = "collider"; static defaults = {}; });
  const engine = new EventEmitter();
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], viewOnlyComponents: new Set(), playing: false, sceneName: "Sculpt gestures", physics: { markDirty() {} } });
  engine.getEntity = id => engine.entities.get(id);
  engine.batchHierarchy = fn => fn();
  engine.createEntity = ({ id, name, parent = null } = {}) => { const entity = new Entity(engine, { id, name }); engine.entities.set(entity.id, entity); entity.setParent(parent); return entity; };
  engine.destroyEntity = entity => {
    for (const child of [...entity.children]) engine.destroyEntity(child);
    entity.dispose(); const siblings = entity.parent?.children ?? engine.rootEntities;
    const index = siblings.indexOf(entity); if (index >= 0) siblings.splice(index, 1);
    entity.object3D.removeFromParent(); engine.entities.delete(entity.id);
  };
  vmSingleton("engineInstance", () => ({ instance: null, loader: null })).instance = engine;
  useSelectionStore.getState().clear(); commandBus.clearHistory();
  const previousWindow = globalThis.window; globalThis.window = new EventTarget();
  const previousFrame = globalThis.requestAnimationFrame, previousCancelFrame = globalThis.cancelAnimationFrame;
  const frames = new Map(); let frameId = 0, frameTime = 0;
  globalThis.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  // Production pointermoves coalesce until the browser's next frame. Ordinary
  // samples below represent successive rendered frames; burst tests opt out.
  const frame = () => {
    frameTime += 16;
    for (const [id, callback] of [...frames]) { if (!frames.delete(id)) continue; callback(frameTime); }
    engine.emit("preRender");
  };
  const canvas = new EventTarget(); canvas.style = {}; canvas.title = "Scene viewport";
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 600 });
  const camera = new THREE.OrthographicCamera(-12, 12, 12, -12, .1, 200);
  const view = (position = [0, 30, 0], target = [0, 0, 0], up = [0, 0, -1]) => { camera.position.fromArray(position); camera.up.fromArray(up); camera.lookAt(...target); camera.updateMatrixWorld(); camera.updateProjectionMatrix(); };
  view();
  const viewport = { camera, orbit: { enabled: true, mouseButtons: { MIDDLE: THREE.MOUSE.DOLLY } } };
  const teardown = setupArchitectureSculptTool(canvas, viewport);
  const project = position => { const p = new THREE.Vector3(...position).project(camera); return [(p.x + 1) * 300, (1 - p.y) * 300]; };
  const send = (type, position, extra = {}, render = true) => {
    const [clientX, clientY] = project(position);
    const event = new Event(type, { cancelable: true }); Object.assign(event, { clientX, clientY, button: 0, altKey: false, ctrlKey: false, ...extra }); canvas.dispatchEvent(event); if (render) frame(); return event;
  };
  const click = (position, extra = {}) => { send("pointermove", position, extra); send("pointerdown", position, extra); send("pointerup", position, extra); assert.equal(getArchitectureSculptState().error, ""); };
  const stroke = points => { send("pointermove", points[0]); send("pointerdown", points[0]); for (const point of points.slice(1)) send("pointermove", point); send("pointerup", points.at(-1)); assert.equal(getArchitectureSculptState().error, ""); };
  const model = id => engine.getEntity(id ?? getArchitectureSculptState().entityId)?.getComponent("architecture")?.props.model;
  const seed = (forms = [form()], openings = []) => { const result = createArchitectureModel({ model: { forms, paths: [], openings } }); commandBus.clearHistory(); return result.entityId; };
  const close = () => { disarmArchitectureSculpt(); teardown(); disarmTerrainBrush(); for (const entity of [...engine.rootEntities]) engine.destroyEntity(entity); commandBus.clearHistory(); globalThis.window = previousWindow; globalThis.requestAnimationFrame = previousFrame; globalThis.cancelAnimationFrame = previousCancelFrame; assert.equal(frames.size, 0, "teardown cancels queued frame work"); };
  return { engine, canvas, camera, viewport, project, view, send, frame, click, stroke, model, seed, close };
}

test("volume preview builds live roof geometry, Escape cancels and first drag is one exact undo", () => {
  const f = fixture();
  try {
    armArchitectureSculpt({ tool: "build", entityId: null, height: 4, roofHeight: 2, color: "#bd8d76" });
    f.send("pointermove", [-4, 0, -4]);
    assert.ok(f.engine.scene.children.some(object => object.userData.architectureSculptPreview && object.geometry.attributes.position.count > 0));
    f.send("pointerdown", [-4, 0, -4]); f.send("pointermove", [4, 0, 4]);
    const preview = f.model(); assert.equal(preview.forms.length, 1); near(preview.forms[0].size[0], 8); near(preview.forms[0].size[2], 8);
    assert.equal(preview.forms[0].color, "#bd8d76"); assert.equal(commandBus.undoStack.length, 0);
    assert.equal(f.viewport.orbit.enabled, false);
    assert.equal(dispatchArchitectureSculptKey({ key: "Escape" }), true);
    assert.equal(f.engine.entities.size, 0); assert.equal(commandBus.undoStack.length, 0); assert.equal(f.viewport.orbit.enabled, true);
    assert.equal(getArchitectureSculptState().active, true, "cancel a drag without leaving the tool");
    f.stroke([[-4, 0, -4], [4, 0, 4]]);
    const id = getArchitectureSculptState().entityId, model = structuredClone(f.model());
    const architecture = f.engine.getEntity(id).getComponent("architecture");
    assert.ok(architecture.surfaces.some(surface => surface.kind === "roof")); assert.equal(commandBus.undoStack.length, 1);
    assert.ok(!f.engine.getEntity(id).getComponent("level")); commandBus.undo(); assert.equal(f.engine.entities.size, 0);
    assert.equal(getArchitectureSculptState().entityId, null, "undo clears the deleted target before another tool can arm it");
    commandBus.redo(); assert.deepEqual(f.model(id), model);
  } finally { f.close(); }
});

test("round drags create curved volume and native freehand wall strokes persist as one roofless model", () => {
  const f = fixture();
  try {
    armArchitectureSculpt({ tool: "round", entityId: null, height: 6 }); f.stroke([[-5, 0, -5], [-2, 0, -5]]);
    const tower = f.model().forms[0]; assert.equal(tower.shape, "round"); near(tower.size[0], 6); near(tower.size[2], 6);
    setArchitectureSculptSetting("entityId", null); setArchitectureSculptSetting("tool", "wall");
    f.stroke([[2, 0, -5], [5, 0, -3], [6, 0, 0], [5, 0, 3]]);
    const walls = structuredClone(f.model()); assert.equal(walls.forms.length, 3); assert.ok(walls.forms.every(part => part.roof === "none" && part.windows === false));
    assert.ok(new Set(walls.forms.map(part => part.rotationY.toFixed(2))).size > 1, "curved stroke follows its segment directions");
    assert.equal(commandBus.undoStack.length, 2); const wallId = getArchitectureSculptState().entityId; commandBus.undo(); assert.equal(f.engine.getEntity(wallId), undefined);
    commandBus.redo(); assert.deepEqual(f.model(wallId), walls);
  } finally { f.close(); }
});

test("Grow extends a facade, stacks on roofs, and RMB removes the hit form without a menu", () => {
  const f = fixture();
  try {
    const id = f.seed(); f.view([20, 10, 15], [0, 2, 0], [0, 1, 0]);
    armArchitectureSculpt({ tool: "grow", entityId: id, cellSize: 3 }); f.click([3, 1.5, 0]);
    assert.equal(f.model().forms.length, 2); const extension = f.model().forms[1]; near(extension.position[0], 4.5); near(extension.position[1], 0);
    f.view(); f.click([0, 4.2, 0]); assert.equal(f.model().forms.length, 3); const stacked = f.model().forms[2]; near(stacked.position[1], 3);
    const before = structuredClone(f.model()); f.click([0, 7.2, 0], { button: 2 }); assert.equal(f.model().forms.length, 2);
    const menu = new Event("contextmenu", { cancelable: true }); f.canvas.dispatchEvent(menu); assert.equal(menu.defaultPrevented, true);
    commandBus.undo(); assert.deepEqual(f.model(id), before);
  } finally { f.close(); }
});

test("facade clicks create cursor-height windows and doors, paint the hit form and draw crossing paths", () => {
  const f = fixture();
  try {
    const id = f.seed([form({ size: [8, 5, 8] })]); f.view([0, 3, 25], [0, 3, 0], [0, 1, 0]);
    armArchitectureSculpt({ tool: "window", entityId: id }); f.click([2, 3.2, 4]);
    assert.equal(f.model().openings.length, 1); near(f.model().openings[0].position[1], 3.2); assert.equal(f.model().openings[0].kind, "window");
    setArchitectureSculptSetting("tool", "door"); f.click([-2, 2, 4]); assert.equal(f.model().openings.length, 2); const door = f.model().openings[1]; near(door.position[1], door.height / 2);
    setArchitectureSculptSetting("tool", "paint"); setArchitectureSculptSetting("color", "#829b8c"); f.click([0, 4.5, 4]); assert.equal(f.model().forms[0].color, "#829b8c");
    commandBus.undo(); assert.equal(f.model(id).forms[0].color, "#d5d1c7");
    f.view(); setArchitectureSculptSetting("tool", "path"); setArchitectureSculptSetting("width", 2);
    f.stroke([[0, 0, -10], [0, 0, -5], [0, 0, 0], [0, 0, 5], [0, 0, 10]]);
    assert.equal(f.model().paths.length, 1); assert.ok(f.model().paths[0].points.length >= 4);
    commandBus.undo(); assert.equal(f.model(id).paths.length, 0);
  } finally { f.close(); }
});

test("visible form handles resize the model live and cancel or undo the complete drag", () => {
  const f = fixture();
  try {
    const id = f.seed(); f.view([15, 10, 20], [0, 2, 0], [0, 1, 0]); armArchitectureSculpt({ tool: "reshape", entityId: id }); f.click([0, 1.5, 3]);
    const findHandle = name => { let found; f.engine.scene.traverse(object => { if (object.userData.architectureSculptHandle && object.userData.handle === name) found = object; }); assert.ok(found, `${name} handle is visible`); return found.getWorldPosition(new THREE.Vector3()); };
    const before = structuredClone(f.model()), start = findHandle("height");
    f.send("pointerdown", start.toArray()); f.send("pointermove", start.clone().add(new THREE.Vector3(0, 2, 0)).toArray());
    assert.ok(f.model().forms[0].size[1] > 4.5); assert.equal(commandBus.undoStack.length, 0);
    dispatchArchitectureSculptKey({ key: "Escape" }); assert.deepEqual(f.model(id), before);
    const roofStart = findHandle("roofHeight"), roofEnd = roofStart.clone().add(new THREE.Vector3(0, 1, 0));
    f.stroke([roofStart.toArray(), roofEnd.toArray()]); assert.ok(f.model().forms[0].roofHeight > 2); assert.equal(commandBus.undoStack.length, 1);
    commandBus.undo(); assert.deepEqual(f.model(id), before);
    const sideStart = findHandle("width+"), sideEnd = sideStart.clone().add(new THREE.Vector3(2, 0, 0));
    f.stroke([sideStart.toArray(), sideEnd.toArray()]); near(f.model().forms[0].size[0], 8, .1); near(f.model().forms[0].position[0], 1, .1);
    commandBus.undo(); assert.deepEqual(f.model(id), before);
  } finally { f.close(); }
});

test("Alt and middle gestures stay camera-owned, other tools disarm sculpt, and overlays never create entities", () => {
  const f = fixture();
  try {
    armArchitectureSculpt({ tool: "build", entityId: null });
    assert.equal(f.viewport.orbit.mouseButtons.MIDDLE, THREE.MOUSE.ROTATE);
    f.send("pointerdown", [0, 0, 0], { altKey: true }); f.send("pointermove", [3, 0, 3], { altKey: true }); f.send("pointerup", [3, 0, 3], { altKey: true });
    f.send("pointerdown", [0, 0, 0], { button: 1 }); f.send("pointerup", [0, 0, 0], { button: 1 }); assert.equal(f.engine.entities.size, 0);
    const overlay = new EventTarget(), event = new Event("pointerdown", { cancelable: true }); Object.assign(event, { clientX: 300, clientY: 300, button: 0 }); overlay.dispatchEvent(event); assert.equal(f.engine.entities.size, 0);
    armTerrainBrush("sculpt"); assert.equal(getArchitectureSculptState().active, false); assert.equal(f.viewport.orbit.mouseButtons.MIDDLE, THREE.MOUSE.DOLLY);
    assert.equal(commandBus.previewing, false);
  } finally { f.close(); }
});

test("moving and turning form handles carry manual facade openings and Ctrl+Z cancels an active stroke", () => {
  const f = fixture();
  try {
    const id = f.seed([form()], [{ id: "window", formId: "house", kind: "window", position: [1, 1.8, 3], normal: [0, 0, 1], width: 1, height: 1 }]);
    f.view([15, 10, 20], [0, 2, 0], [0, 1, 0]); armArchitectureSculpt({ tool: "reshape", entityId: id }); f.click([-2, 1.5, 3]); f.view();
    const handle = name => { f.send("pointermove", [10, 0, 10]); let result; f.engine.scene.traverse(object => { if (object.userData.architectureSculptHandle && object.userData.handle === name) result = object; }); assert.ok(result); return result.getWorldPosition(new THREE.Vector3()); };
    const before = structuredClone(f.model()), move = handle("move");
    f.stroke([move.toArray(), move.clone().add(new THREE.Vector3(2, 0, 1)).toArray()]);
    near(f.model().forms[0].position[0], 2); near(f.model().openings[0].position[0], 3); near(f.model().openings[0].position[2], 4);
    commandBus.undo(); assert.deepEqual(f.model(id), before);
    const yaw = handle("yaw"), rotated = yaw.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    f.stroke([yaw.toArray(), rotated.toArray()]);
    const movedOpening = f.model().openings[0]; near(movedOpening.position[0], 3); near(movedOpening.position[2], -1); near(movedOpening.normal[0], 1); near(movedOpening.normal[2], 0);
    commandBus.undo(); assert.deepEqual(f.model(id), before);
    setArchitectureSculptSetting("tool", "build"); f.send("pointerdown", [8, 0, 8]); f.send("pointermove", [10, 0, 10]);
    assert.equal(f.model().forms.length, 2); assert.equal(dispatchArchitectureSculptKey({ key: "z", ctrlKey: true }), true);
    assert.deepEqual(f.model(id), before); assert.equal(commandBus.previewing, false); assert.equal(commandBus.undoStack.length, 0);
  } finally { f.close(); }
});

test("rotated nonuniform parents preserve facade normals, opening tangents and the local drawing plane", () => {
  const f = fixture();
  try {
    const yaw = Math.PI / 5, id = f.seed([form({ size: [8, 6, 7], rotationY: yaw })]);
    const root = f.engine.getEntity(id), parent = f.engine.createEntity({ name: "Scaled rotated parent" });
    parent.setTransform({ position: [6, 4, -3], rotation: [.35, .6, -.2], scale: [2.3, .7, 1.4] });
    root.setParent(parent); root.setTransform({ position: [-1, 2, 1], rotation: [.25, -.4, .3], scale: [.8, 1.1, 1.3] });
    root.object3D.updateWorldMatrix(true, false);
    const matrix = root.object3D.matrixWorld.clone(), linear = new THREE.Matrix3().setFromMatrix4(matrix), normals = new THREE.Matrix3().getNormalMatrix(matrix);
    const world = point => new THREE.Vector3(...point).applyMatrix4(matrix);
    const localNormal = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const surfaceNormal = localNormal.clone().applyNormalMatrix(normals);
    const tangent = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).applyMatrix3(linear).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyMatrix3(linear).normalize();
    const surfaceLocal = new THREE.Vector3(1, 3.2, 3.5).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw), target = world(surfaceLocal.toArray());
    f.view(target.clone().addScaledVector(surfaceNormal, 30).toArray(), target.toArray(), up.toArray());
    armArchitectureSculpt({ tool: "window", entityId: id }); f.click(target.toArray());
    assert.equal(f.model().openings.length, 1);
    const opening = f.model().openings[0], storedNormal = new THREE.Vector3(...opening.normal);
    near(storedNormal.dot(localNormal), 1); near(opening.position[1], 3.2);
    const storedWorldNormal = storedNormal.applyNormalMatrix(normals);
    near(storedWorldNormal.dot(tangent), 0); near(storedWorldNormal.dot(up), 0);
    const mesh = root.getComponent("architecture").mesh;
    const apertureRay = new THREE.Raycaster(target.clone().addScaledVector(surfaceNormal, 2), surfaceNormal.clone().negate());
    root.object3D.updateWorldMatrix(true, true);
    assert.ok(!apertureRay.intersectObject(mesh).some(hit => hit.distance < 2.2), "the selected facade really has an aperture along its transformed normal");
    commandBus.undo();

    const start = world([8, 0, 8]), end = world([12, 0, 11]), mid = start.clone().add(end).multiplyScalar(.5);
    const planeNormal = new THREE.Vector3(0, 1, 0).applyNormalMatrix(normals);
    const planeUp = new THREE.Vector3(0, 0, -1).applyMatrix3(linear).normalize();
    f.view(mid.clone().addScaledVector(planeNormal, 40).toArray(), mid.toArray(), planeUp.toArray());
    setArchitectureSculptSetting("tool", "build"); f.stroke([start.toArray(), end.toArray()]);
    const added = f.model().forms[1]; near(added.position[0], 10); near(added.position[1], 0); near(added.position[2], 9.5); near(added.size[0], 4); near(added.size[2], 3);
    commandBus.undo(); assert.equal(f.model(id).forms.length, 1);
  } finally { f.close(); }
});

test("the elevation handle lifts the form and its apertures, generates supports and undoes as one drag", () => {
  const f = fixture();
  try {
    const id = f.seed([form()], [{ id: "window", formId: "house", kind: "window", position: [1, 1.8, 3], normal: [0, 0, 1], width: 1, height: 1 }]);
    f.view([15, 10, 20], [0, 2, 0], [0, 1, 0]); armArchitectureSculpt({ tool: "reshape", entityId: id }); f.click([-2, 1.5, 3]);
    const before = structuredClone(f.model());
    const handle = () => { let found; f.engine.scene.traverse(object => { if (object.userData.architectureSculptHandle && object.userData.handle === "elevation") found = object; }); assert.ok(found); assert.equal(found.userData.label, "Lift base"); return found.getWorldPosition(new THREE.Vector3()); };
    const start = handle(), end = start.clone().add(new THREE.Vector3(0, 2.75, 0));
    f.send("pointermove", start.toArray()); assert.equal(f.canvas.title, "Lift base");
    f.stroke([start.toArray(), end.toArray()]);
    near(f.model().forms[0].position[1], 2.75); near(f.model().openings[0].position[1], 4.55); near(f.model().forms[0].size[1], 3);
    assert.ok(f.engine.getEntity(id).getComponent("architecture").surfaces.some(surface => surface.kind === "support"));
    assert.equal(commandBus.undoStack.length, 1); commandBus.undo(); assert.deepEqual(f.model(id), before);
    const ground = handle(), below = ground.clone().add(new THREE.Vector3(0, -.75, 0)); f.stroke([ground.toArray(), below.toArray()]);
    near(f.model().forms[0].position[1], -.75); commandBus.undo(); assert.deepEqual(f.model(id), before);
    disarmArchitectureSculpt(); assert.equal(f.canvas.title, "Scene viewport");
  } finally { f.close(); }
});

test("right-click and Erase remove an exposed path, reseal its facade passages and undo without changing forms", () => {
  const f = fixture();
  try {
    const id = f.seed([form({ size: [8, 4, 8] })]); armArchitectureSculpt({ tool: "path", entityId: id, width: 2 });
    f.stroke([[0, 0, -8], [0, 0, -4], [0, 0, 0], [0, 0, 4], [0, 0, 8]]);
    const before = structuredClone(f.model()), root = f.engine.getEntity(id);
    const throughFacade = () => {
      root.object3D.updateWorldMatrix(true, true);
      return new THREE.Raycaster(new THREE.Vector3(0, 1, 10), new THREE.Vector3(0, 0, -1)).intersectObject(root.getComponent("architecture").mesh);
    };
    assert.equal(before.paths.length, 1); assert.equal(throughFacade().length, 0, "path opens a real passage through both walls");
    f.send("pointermove", [0, .015, 6]);
    assert.equal(getArchitectureSculptState().hover?.pathId, before.paths[0].id);
    assert.ok(f.engine.scene.children.some(object => object.userData.architectureSculptHighlight && object.userData.pathId === before.paths[0].id));
    f.click([0, .015, 6], { button: 2 });
    assert.equal(f.model().paths.length, 0); assert.deepEqual(f.model().forms, before.forms); assert.ok(throughFacade().length > 0, "removing the path reseals the facade");
    assert.equal(commandBus.undoStack.length, 2); commandBus.undo(); assert.deepEqual(f.model(id), before); assert.equal(throughFacade().length, 0);
    setArchitectureSculptSetting("tool", "erase"); f.click([0, .015, 6]); assert.equal(f.model().paths.length, 0); assert.deepEqual(f.model().forms, before.forms);
    commandBus.undo(); assert.deepEqual(f.model(id), before);
  } finally { f.close(); }
});

test("pointer bursts coalesce to a live frame and pointerup commits the final sample without waiting", () => {
  const f = fixture();
  try {
    armArchitectureSculpt({ tool: "build", entityId: null, width: 3 }); f.send("pointerdown", [-4, 0, -4]);
    const initial = structuredClone(f.model());
    f.send("pointermove", [0, 0, 0], {}, false); f.send("pointermove", [4, 0, 4], {}, false);
    assert.deepEqual(f.model(), initial, "pointer handlers queue work until rendering");
    f.frame(); near(f.model().forms[0].size[0], 8); near(f.model().forms[0].size[2], 8); assert.equal(commandBus.undoStack.length, 0);
    f.send("pointermove", [5, 0, 6], {}, false); f.send("pointerup", [5, 0, 6], {}, false);
    near(f.model().forms[0].size[0], 9); near(f.model().forms[0].size[2], 10); assert.equal(commandBus.undoStack.length, 1);
    commandBus.undo(); assert.equal(f.engine.entities.size, 0);
  } finally { f.close(); }
});
