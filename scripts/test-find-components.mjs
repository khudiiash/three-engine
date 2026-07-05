// Verify Entity.findComponents picks up components in self + descendants,
// returns an array (not a single component), and walks the tree depth-first
// without infinite recursion on self-referential parent/child relationships.

globalThis.document = { body: null, addEventListener() {}, removeEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { Entity } = await import("../src/engine/Entity.js");

// Fake engine — Entity.setParent needs `engine.rootEntities` and `engine.scene`.
// We never call update/render so a plain stub is enough.
const fakeEngine = {
  rootEntities: [],
  scene: { add() {}, remove() {} },
};

// Build a tree:
//   root
//   ├── cam1 (camera)
//   ├── group1
//   │   ├── cam2 (camera)
//   │   └── mesh1 (model)
//   └── mesh2 (model)
const root = new Entity(fakeEngine, { name: "root" });
const cam1 = new Entity(fakeEngine, { name: "cam1" });
const group1 = new Entity(fakeEngine, { name: "group1" });
const cam2 = new Entity(fakeEngine, { name: "cam2" });
const mesh1 = new Entity(fakeEngine, { name: "mesh1" });
const mesh2 = new Entity(fakeEngine, { name: "mesh2" });

// Fake components — Entity.findComponents just looks at the `type` key in
// the components Map, so any { type, entity } object works for the test.
const fakeComponent = (type, entity) => ({ type, entity });

cam1.components.set("camera", fakeComponent("camera", cam1));
cam2.components.set("camera", fakeComponent("camera", cam2));
mesh1.components.set("model", fakeComponent("model", mesh1));
mesh2.components.set("model", fakeComponent("model", mesh2));

cam1.setParent(root);
group1.setParent(root);
cam2.setParent(group1);
mesh1.setParent(group1);
mesh2.setParent(root);

let pass = true;

// 1. Searching "camera" from root finds cam1 + cam2 (both).
const cams = root.findComponents("camera");
console.log(`Find 'camera' from root: ${cams.length} hits (expected 2)`);
if (cams.length !== 2) pass = false;

// 2. Searching "model" from root finds mesh1 + mesh2.
const models = root.findComponents("model");
console.log(`Find 'model' from root: ${models.length} hits (expected 2)`);
if (models.length !== 2) pass = false;

// 3. Searching from a subtree only finds descendants below it.
const camsBelowGroup = group1.findComponents("camera");
console.log(`Find 'camera' below group1: ${camsBelowGroup.length} hits (expected 1, only cam2)`);
if (camsBelowGroup.length !== 1) pass = false;

// 4. Searching for a type that doesn't exist returns an empty array (not undefined).
const nothing = root.findComponents("nonexistent");
console.log(`Find 'nonexistent': ${nothing.length} hits (expected 0), typeof ${typeof nothing}`);
if (nothing.length !== 0 || !Array.isArray(nothing)) pass = false;

// 5. The entity ITSELF counts (matches `getComponent(type)` for the same entity).
const cam2Self = cam2.findComponents("camera");
console.log(`Find 'camera' from cam2: ${cam2Self.length} hits (expected 1, itself)`);
if (cam2Self.length !== 1) pass = false;

// 6. Depth-first order: cam1 comes before cam2 (cam1 is direct child of root).
console.log(`Camera order: ${cams.map((c) => c.entity?.name ?? "?").join(", ")}`);
if (cams[0]?.entity?.name !== "cam1" || cams[1]?.entity?.name !== "cam2") pass = false;

console.log("");
console.log(pass ? "ALL PASS" : "FAIL");
process.exit(pass ? 0 : 1);