// Headless check of the prefab system: create, instantiate, override, apply,
// revert, unpack, propagation, nesting and variants.
// (node scripts/test-prefabs.mjs)

// The engine's InputManager attaches to the DOM on construction — stub the
// couple of globals it touches so the Engine can boot headless.
globalThis.document = { body: null, addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, addEventListener() {}, removeEventListener() {} }) };
globalThis.window = { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };

const {
  Engine,
  registerBuiltInComponents,
  serializeScene,
  deserializeScene,
  instantiateEntity,
  prefabRegistry,
  createDefFromEntity,
  bindEntityToPrefab,
  createVariantDefFromInstance,
  defWithInstanceApplied,
  reloadPrefab,
  respawnInstance,
  instantiatePrefabNode,
  diffInstance,
  unpackInstance,
} = await import("../src/engine/index.js");

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
};

registerBuiltInComponents();

const engine = new Engine();
const spawn = (name, parent = null) => engine.createEntity({ name, parent });

// ---------------------------------------------------------------------------
// 1. Author a prefab from a live entity tree.
//    Enemy ── Body (mesh) ── Gun (mesh)
// ---------------------------------------------------------------------------
const enemy = spawn("Enemy");
enemy.position.set(1, 0, 0);
const body = spawn("Body", enemy);
body.addComponent("mesh", { geometry: "box" });
const gun = spawn("Gun", body);
gun.addComponent("mesh", { geometry: "sphere" });
gun.position.set(0, 1, 0);

const enemyDef = createDefFromEntity(enemy, { name: "Enemy" });
prefabRegistry.register(enemyDef, "prefabs/Enemy.prefab");
engine.destroyEntity(enemy);

assert(enemyDef.root.children[0].children[0].name === "Gun", "def captures the whole tree");
assert(!!enemyDef.root.children[0].fid, "nodes get stable fids");

// ---------------------------------------------------------------------------
// 2. Instantiate — a real linked instance, not a copy.
// ---------------------------------------------------------------------------
const a = engine.instantiate("prefabs/Enemy.prefab", { position: [5, 0, 5] });
assert(a && a.prefab?.guid === enemyDef.guid, "instantiate() links the instance to the prefab");
assert(a.children[0].children[0].name === "Gun", "instance expands the full tree");
assert(a.position.x === 5, "placement applied");
assert(diffInstance(a).length === 0, "a fresh instance has no overrides");

const b = engine.instantiate(enemyDef.guid, { position: [0, 0, 9] });
assert(b.id !== a.id && b.children[0].id !== a.children[0].id, "two instances are independent entities");

// ---------------------------------------------------------------------------
// 3. Overrides are derived by diffing — no edit interception anywhere.
// ---------------------------------------------------------------------------
a.children[0].getComponent("mesh").setProp("geometry", "cylinder");
a.children[0].children[0].name = "Cannon";
const overrides = diffInstance(a);
assert(overrides.some((o) => o.k === "prop" && o.key === "geometry" && o.v === "cylinder"), "prop edit becomes an override");
assert(overrides.some((o) => o.k === "name" && o.v === "Cannon"), "rename becomes an override");
assert(diffInstance(b).length === 0, "the other instance stays pristine");
assert(!overrides.some((o) => o.k === "transform" && o.t.length === 0), "the instance root's own placement is NOT an override");

// Structural edits too.
const extra = spawn("Muzzle Flash", a.children[0]);
extra.addComponent("light", { kind: "point" });
engine.destroyEntity(b.children[0].children[0]); // delete Gun out of instance b
assert(diffInstance(a).some((o) => o.k === "addEntity"), "an entity added inside an instance is an addEntity override");
assert(diffInstance(b).some((o) => o.k === "removeEntity"), "an entity deleted from an instance is a removeEntity override");

// ---------------------------------------------------------------------------
// 4. Scene round-trip: instances serialize as link + overrides, not a tree.
// ---------------------------------------------------------------------------
const sceneJson = serializeScene(engine, { embedPrefabs: true });
const aNode = sceneJson.entities.find((e) => e.id === a.id);
assert(aNode.prefab?.guid === enemyDef.guid, "instance serializes as a prefab link");
assert(!aNode.children && !aNode.components, "instance stores no tree — only the link, placement and overrides");
assert(aNode.overrides.length === diffInstance(a).length, "overrides ride along in the scene file");

const engine2 = new Engine();
deserializeScene(engine2, JSON.parse(JSON.stringify(sceneJson)));
const a2 = engine2.getEntity(a.id);
assert(a2?.children[0].getComponent("mesh").props.geometry === "cylinder", "override survives the scene round-trip");
assert(a2.children[0].children.some((c) => c.name === "Cannon"), "renamed child restored");
assert(a2.children[0].children.some((c) => c.name === "Muzzle Flash"), "added child restored");
const b2 = engine2.getEntity(b.id);
assert(b2.children[0].children.length === 0, "deleted child stays deleted");
assert(b2.children[0].getComponent("mesh").props.geometry === "box", "the pristine instance still tracks the prefab");

// ---------------------------------------------------------------------------
// 5. Editing the prefab propagates to every instance, keeping their overrides.
// ---------------------------------------------------------------------------
const aBodyId = a.children[0].id; // captured before the respawn swaps the entities out
const editedDef = structuredClone(enemyDef);
editedDef.root.children[0].components[0].props.geometry = "torus"; // Body: box -> torus
editedDef.root.children.push({ fid: "shield", name: "Shield", position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1], components: [], children: [] });
reloadPrefab(engine, editedDef, "prefabs/Enemy.prefab");

const aLive = engine.getEntity(a.id);
const bLive = engine.getEntity(b.id);
assert(bLive.children.some((c) => c.name === "Shield"), "prefab's new child appears in the pristine instance");
assert(aLive.children.some((c) => c.name === "Shield"), "…and in the overridden one");
assert(bLive.children[0].getComponent("mesh").props.geometry === "torus", "prefab's changed prop reaches the pristine instance");
assert(aLive.children[0].getComponent("mesh").props.geometry === "cylinder", "…but does NOT clobber that instance's override");
assert(aLive.children[0].children.some((c) => c.name === "Muzzle Flash"), "structural override survives the prefab edit");
assert(aLive.id === a.id && aLive.children[0].id === aBodyId, "entity ids are preserved across re-expansion");

// ---------------------------------------------------------------------------
// 6. Apply: push an instance's overrides back into the asset.
// ---------------------------------------------------------------------------
const applied = defWithInstanceApplied(aLive);
reloadPrefab(engine, applied, "prefabs/Enemy.prefab");
const aAfter = engine.getEntity(a.id);
const bAfter = engine.getEntity(b.id);
assert(diffInstance(aAfter).length === 0, "after Apply the source instance has no overrides left");
assert(bAfter.children[0].getComponent("mesh").props.geometry === "cylinder", "applied prop reached the other instance");
assert(bAfter.children[0].children.some((c) => c.name === "Muzzle Flash"), "applied added-entity reached the other instance");

// ---------------------------------------------------------------------------
// 7. Revert: drop an instance's overrides.
// ---------------------------------------------------------------------------
aAfter.children[0].getComponent("mesh").setProp("geometry", "plane");
assert(diffInstance(aAfter).length > 0, "instance is dirty again");
const reverted = respawnInstance(engine, aAfter, []);
assert(diffInstance(reverted).length === 0, "revert clears the overrides");
assert(reverted.children[0].getComponent("mesh").props.geometry === "cylinder", "revert restores the prefab's value");

// ---------------------------------------------------------------------------
// 8. Nested prefabs: a prefab containing an instance of another prefab.
// ---------------------------------------------------------------------------
const turretRoot = spawn("Turret");
turretRoot.addComponent("mesh", { geometry: "box" });
const turretDef = createDefFromEntity(turretRoot, { name: "Turret" });
prefabRegistry.register(turretDef, "prefabs/Turret.prefab");
engine.destroyEntity(turretRoot);

// Build a Tank that *contains* a Turret instance, then prefab the Tank.
const tank = spawn("Tank");
tank.addComponent("mesh", { geometry: "box" });
const turretInInstance = instantiatePrefabNode(engine, { prefab: { guid: turretDef.guid } }, tank);
turretInInstance.position.set(0, 1, 0);
const tankDef = createDefFromEntity(tank, { name: "Tank" });
prefabRegistry.register(tankDef, "prefabs/Tank.prefab");
engine.destroyEntity(tank);

assert(tankDef.root.children[0].prefab?.guid === turretDef.guid, "the nested prefab stays a REFERENCE inside Tank, not an inlined copy");

const tank1 = engine.instantiate(tankDef.guid);
assert(tank1.children[0].name === "Turret", "nested prefab expands inside its host");
assert(tank1.children[0].position.y === 1, "the nested instance's hoisted placement is kept");

// Editing the *inner* prefab must reach through the outer one.
const turretV2 = structuredClone(turretDef);
turretV2.root.components[0].props.geometry = "cone";
reloadPrefab(engine, turretV2, "prefabs/Turret.prefab");
const tank1After = engine.getEntity(tank1.id);
assert(
  tank1After.children[0].getComponent("mesh").props.geometry === "cone",
  "editing the nested prefab propagates through the outer prefab into its instances",
);

// An override reaching *into* the nested prefab, from the outer instance.
tank1After.children[0].getComponent("mesh").setProp("geometry", "capsule");
const nestedOv = diffInstance(tank1After);
assert(nestedOv.length === 1 && nestedOv[0].t.length === 1, "an override inside a nested prefab addresses it by fid path");

// Applying it must land on the *Tank* def as an override of its Turret node —
// it must NOT rewrite the shared Turret prefab.
const tankApplied = defWithInstanceApplied(tank1After);
assert(
  tankApplied.root.children[0].overrides.some((o) => o.k === "prop" && o.v === "capsule"),
  "Apply records the change on Tank's nested-Turret node…",
);
assert(prefabRegistry.getDef(turretDef.guid).root.components[0].props.geometry === "cone", "…and leaves the shared Turret prefab untouched");

// ---------------------------------------------------------------------------
// 9. Variants: a prefab that inherits from another, with its own overrides.
// ---------------------------------------------------------------------------
const eliteSource = engine.instantiate(enemyDef.guid);
eliteSource.children[0].getComponent("mesh").setProp("geometry", "icosahedron");
eliteSource.name = "Elite Enemy";
const eliteDef = createVariantDefFromInstance(eliteSource, { name: "Elite Enemy" });
prefabRegistry.register(eliteDef, "prefabs/Elite.prefab");
engine.destroyEntity(eliteSource);

assert(eliteDef.variantOf?.guid === enemyDef.guid, "the variant records its base");
assert(!eliteDef.root, "a variant stores no tree of its own — only overrides on the base");

const elite = engine.instantiate(eliteDef.guid);
assert(elite.children[0].getComponent("mesh").props.geometry === "icosahedron", "variant applies its own override");
assert(elite.children[0].children.some((c) => c.name === "Cannon"), "variant inherits the base's tree");

// A change to the BASE must flow into the variant's instances.
const enemyV3 = structuredClone(prefabRegistry.getDef(enemyDef.guid));
enemyV3.root.children[0].children[0].components[0].props.geometry = "ring"; // Cannon
reloadPrefab(engine, enemyV3, "prefabs/Enemy.prefab");
const eliteAfter = engine.getEntity(elite.id);
const cannon = eliteAfter.children[0].children.find((c) => c.name === "Cannon");
assert(cannon.getComponent("mesh").props.geometry === "ring", "base prefab edits flow through the variant into its instances");
assert(eliteAfter.children[0].getComponent("mesh").props.geometry === "icosahedron", "…without losing the variant's own override");

// ---------------------------------------------------------------------------
// 10. Unpack severs the link, keeping the entities.
// ---------------------------------------------------------------------------
const loose = engine.instantiate(enemyDef.guid);
const looseChildId = loose.children[0].id;
unpackInstance(loose);
assert(!loose.prefab, "unpacked root is no longer an instance");
assert(engine.getEntity(looseChildId), "unpacked entities survive");
assert(serializeScene(engine).entities.find((e) => e.id === loose.id).children.length > 0, "an unpacked instance serializes as a plain tree again");

// ---------------------------------------------------------------------------
// 11. Create Prefab converts the source entity *in place* into an instance,
//     without changing any entity id (ids are referenced by scripts, camera
//     follow targets, the undo stack…).
// ---------------------------------------------------------------------------
const crate = spawn("Crate");
crate.addComponent("mesh", { geometry: "box" });
const lid = spawn("Lid", crate);
const crateId = crate.id;
const lidId = lid.id;

const crateDef = createDefFromEntity(crate, { name: "Crate" });
const bound = bindEntityToPrefab(engine, crate, crateDef, "prefabs/Crate.prefab");
assert(bound.id === crateId, "Create Prefab keeps the source entity's id");
assert(bound.children[0].id === lidId, "…and its children's ids");
assert(bound.prefab?.guid === crateDef.guid, "the source entity is now an instance of the prefab it created");
assert(diffInstance(bound).length === 0, "…with no overrides (it *is* the prefab)");

// Redo of Create Prefab: undo replaces the entities with fresh, untagged ones,
// so binding must re-derive the fids — otherwise redo would mint new ids and
// break every inbound reference to those entities.
const undoSnapshot = serializeScene(engine).entities.find((e) => e.id === crateId);
engine.destroyEntity(engine.getEntity(crateId)); // "undo"
instantiateEntity(engine, { ...undoSnapshot, prefab: undefined, name: "Crate", components: [{ type: "mesh", props: { geometry: "box" } }], children: [{ id: lidId, name: "Lid", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], components: [], children: [] }] }, null);
const redone = bindEntityToPrefab(engine, engine.getEntity(crateId), crateDef, "prefabs/Crate.prefab"); // "redo"
assert(redone.id === crateId && redone.children[0].id === lidId, "redo of Create Prefab preserves entity ids");
assert(diffInstance(redone).length === 0, "…and produces a clean instance, not a pile of overrides");

// ---------------------------------------------------------------------------
// 12. Undo of Apply must restore BOTH the asset and every instance's overrides.
//     Re-deriving overrides on undo would read post-Apply state and silently
//     bake the applied change in — this is the case that check guards.
// ---------------------------------------------------------------------------
const u1 = engine.instantiate(crateDef.guid);
const u2 = engine.instantiate(crateDef.guid);
u1.getComponent("mesh").setProp("geometry", "sphere"); // an override on u1 only

const prevDef = structuredClone(prefabRegistry.getDef(crateDef.guid));
const prevOverrides = new Map(
  [u1, u2].map((e) => [e.id, diffInstance(e)]),
);
assert(prevOverrides.get(u1.id).length === 1 && prevOverrides.get(u2.id).length === 0, "pre-Apply: u1 dirty, u2 clean");

// Apply u1 -> the prefab now says "sphere", and u2 follows.
reloadPrefab(engine, defWithInstanceApplied(engine.getEntity(u1.id)), "prefabs/Crate.prefab");
assert(engine.getEntity(u2.id).getComponent("mesh").props.geometry === "sphere", "Apply reached u2");
assert(diffInstance(engine.getEntity(u1.id)).length === 0, "Apply cleared u1's overrides");

// Undo: restore the def AND force each instance's previous override list.
reloadPrefab(engine, prevDef, "prefabs/Crate.prefab", { overridesById: prevOverrides });
assert(prefabRegistry.getDef(crateDef.guid).root.components[0].props.geometry === "box", "undo restored the prefab asset");
assert(engine.getEntity(u1.id).getComponent("mesh").props.geometry === "sphere", "undo restored u1's own override");
assert(diffInstance(engine.getEntity(u1.id)).length === 1, "…as an override, not as prefab data");
assert(engine.getEntity(u2.id).getComponent("mesh").props.geometry === "box", "undo restored u2 to the prefab's value");
assert(diffInstance(engine.getEntity(u2.id)).length === 0, "…and u2 is clean again");

// ---------------------------------------------------------------------------
// 13. A missing prefab must not silently destroy the instance's data.
// ---------------------------------------------------------------------------
const orphanScene = {
  version: 1,
  name: "Orphan",
  entities: [
    {
      id: "orphan1",
      prefab: { guid: "p_does_not_exist", path: "prefabs/Gone.prefab" },
      position: [1, 2, 3],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      overrides: [{ t: [], k: "name", v: "Precious" }],
    },
  ],
};
const engine3 = new Engine();
deserializeScene(engine3, orphanScene);
const orphan = engine3.getEntity("orphan1");
assert(!!orphan && orphan.prefabMissing, "a missing prefab becomes a placeholder, not a crash");
const orphanOut = serializeScene(engine3).entities[0];
assert(orphanOut.overrides.length === 1 && orphanOut.prefab.guid === "p_does_not_exist", "the orphan's link and overrides survive a save");
assert(orphanOut.position[1] === 2, "…as does its placement");

console.log("");
console.log("ALL PASS");
