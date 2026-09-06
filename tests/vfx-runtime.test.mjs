import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { getEntityBoundingSphere } from "../src/engine/viewFrustum.js";
import { activeParticleGraph, compileParticleGraph, particleGraphSignature } from "../src/engine/particleGraph.js";
import { ClothComponent } from "../src/engine/components/ClothComponent.js";
import { WaterComponent } from "../src/engine/components/WaterComponent.js";
import { createGridSimulation } from "../src/engine/vfx/gridSimulation.js";
import { createSimulationGraph, evaluateSimulationGraph } from "../src/engine/vfx/simulationGraph.js";

const wire = (source, target, targetHandle) => ({ source, sourceHandle: "out", target, targetHandle });

function clothHost(cloth, engine = { entities: new Map(), onUpdate: () => () => {} }) {
  const material = new THREE.MeshPhysicalNodeMaterial({ color: "#123456", roughness: .13, sheen: .7, side: THREE.FrontSide });
  material.userData.authored = true;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6, 2), material);
  const component = { mesh, props: { geometry: "plane" }, enabled: true };
  cloth.entity = { id: "plane-cloth", object3D: new THREE.Group(), engine, getComponent: (type) => type === "mesh" ? component : null };
  cloth.entity.object3D.add(mesh); return component;
}

test("cloth borrows the plane material unchanged and restores its authored mesh on disable/detach", () => {
  const cloth = new ClothComponent({ resolution: 4, color: "#ff0000", roughness: 1 });
  const source = clothHost(cloth), plane = source.mesh, material = plane.material;
  let materialDisposals = 0; material.addEventListener("dispose", () => materialDisposals++);
  const before = { color: material.color.getHexString(), roughness: material.roughness, sheen: material.sheen, side: material.side, userData: structuredClone(material.userData) };
  plane.userData.noMerge = false;
  cloth.onAttach();
  try {
    assert.equal(cloth.simulation.mesh.material, material);
    assert.equal(cloth.resolvedProps.width, 6); assert.equal(cloth.resolvedProps.height, 2);
    assert.equal(cloth.simulation.mesh.matrix.elements[13], -1);
    assert.equal(plane.visible, false); assert.equal(plane.userData.clothHidden, true);
    cloth.setEnabled(false); assert.equal(plane.visible, true); assert.equal(plane.userData.noMerge, false);
    cloth.setEnabled(true); assert.equal(plane.visible, false);
    cloth.setProp("pinning", "leftCorners"); assert.equal(cloth.simulation.uniforms.pin.value, 3);
    assert.deepEqual({ color: material.color.getHexString(), roughness: material.roughness, sheen: material.sheen, side: material.side, userData: structuredClone(material.userData) }, before);
    for (const key of ["color", "roughness", "texture", "sheen", "weave", "width", "height", "fitToPlane"]) assert.equal(ClothComponent.schema.some((field) => field.key === key), false, key + " belongs to Mesh, not Cloth");
  } finally { cloth.onDetach(); }
  assert.equal(plane.visible, true); assert.equal(plane.userData.noMerge, false); assert.equal(Object.hasOwn(plane.userData, "clothHidden"), false);
  assert.equal(materialDisposals, 0); plane.geometry.dispose(); material.dispose();
});

test("cloth waits for a real plane and follows live material and geometry replacement", () => {
  const cloth = new ClothComponent({ resolution: 4 });
  cloth.entity = { id: "empty", object3D: new THREE.Group(), engine: { onUpdate: () => () => {} } };
  cloth.onAttach();
  assert.equal(cloth.simulation, null); assert.match(cloth.surfaceError, /requires a Plane/); assert.equal(cloth.entity.object3D.children.length, 0);
  const source = clothHost(cloth); cloth.syncPlane();
  const first = cloth.simulation;
  const nextMaterial = new THREE.MeshBasicNodeMaterial({ color: "#ff4400" });
  const oldMaterial = source.mesh.material; source.mesh.material = nextMaterial; cloth.syncPlane();
  assert.equal(cloth.simulation, first); assert.equal(cloth.simulation.mesh.material, nextMaterial);
  const oldGeometry = source.mesh.geometry; source.mesh.geometry = new THREE.PlaneGeometry(2, 5);
  cloth.syncPlane(); assert.notEqual(cloth.simulation, first); assert.equal(cloth.resolvedProps.width, 2); assert.equal(cloth.resolvedProps.height, 5);
  source.props.geometry = "box"; cloth.syncPlane(); assert.equal(cloth.simulation, null); assert.equal(source.mesh.visible, true);
  cloth.onDetach(); oldGeometry.dispose(); source.mesh.geometry.dispose(); oldMaterial.dispose(); nextMaterial.dispose();
});

test("legacy graph values survive while water appearance is edited through its mesh material", () => {
  for (const [kind, Component, props] of [["cloth", ClothComponent, { pinning: "left", fabric: "silk", gust: 5, shear: .3, bend: .8 }], ["water", WaterComponent, { style: "stylized", waveHeight: .4, waveLength: 7, waveDirection: 45, absorption: .8, foam: .6, deepColor: "#005577" }]]) {
    const resolved = evaluateSimulationGraph(kind, createSimulationGraph(kind, props));
    for (const [key, value] of Object.entries(props)) {
      assert.equal(resolved[key], value);
      const materialOwned = kind === "water" && ["style", "absorption", "foam", "deepColor"].includes(key);
      assert.equal(Component.schema.some((field) => field.key === key), !materialOwned, key + " has one authoring owner");
    }
  }
  const invalid = createSimulationGraph("cloth", { pinning: "mystery" });
  assert.throws(() => evaluateSimulationGraph("cloth", invalid), /invalid Pinned/);
});

test("water optical controls update physical material without replacing GPU storage", () => {
  const sim = createGridSimulation("water", { resolution: 4, waveHeight: 2, amplitude: 3 });
  try {
    const positions = sim.positions;
    const material = sim.mesh.material;
    assert.equal(material.isMeshPhysicalNodeMaterial, true);
    sim.update({ waveHeight: 2, absorption: .7, waterDepth: 9, foam: .8, style: "stylized" });
    assert.equal(sim.positions, positions);
    assert.equal(material.userData.surfaceUniforms.waterDepth.value, 9);
    assert.equal(material.userData.surfaceUniforms.stylized.value, 1);
    assert.equal(material.transmission, .75);
    assert.equal(material.attenuationDistance, 1 / .7);
    assert.ok(sim.mesh.geometry.boundingBox.max.y >= 2.7);
  } finally { sim.dispose(); }
});

test("cloth shares the scene collider field and releases its user when contact is disabled", () => {
  const engine = { entities: new Map(), onUpdate: () => () => {} };
  const a = new ClothComponent({ resolution: 4 }), b = new ClothComponent({ resolution: 4 });
  for (const component of [a, b]) { clothHost(component, engine); component.onAttach(); }
  try {
    assert.equal(a.colliderField, b.colliderField);
    assert.equal(engine.particleColliders.activeUsers, 2);
    a.setProp("sceneCollision", false);
    assert.equal(a.colliderField, null);
    assert.equal(engine.particleColliders.activeUsers, 1);
    a.setProp("sceneCollision", true);
    assert.equal(engine.particleColliders.activeUsers, 2);
  } finally { a.onDetach(); b.onDetach(); }
  assert.equal(engine.particleColliders.activeUsers, 0);
});

test("GPU surface bounds are discovered and refresh after grid geometry replacement", () => {
  for (const kind of ["cloth", "water"]) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    const component = { simulation: { mesh } };
    const entity = { object3D: new THREE.Group(), children: [], getComponent: (type) => type === kind ? component : null };
    entity.object3D.add(mesh);
    entity.object3D.position.set(5, 0, 0);
    entity.object3D.updateMatrixWorld(true);
    const bounds = new THREE.Sphere();
    assert.equal(getEntityBoundingSphere(entity, bounds), true);
    assert.equal(bounds.radius, 4);
    assert.equal(bounds.center.x, 5);
    mesh.geometry = new THREE.PlaneGeometry(10, 10);
    mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20);
    assert.equal(getEntityBoundingSphere(entity, bounds), true);
    assert.equal(bounds.radius, 20, "resizing a stationary solver invalidates cached bounds");
    const parent = { object3D: new THREE.Group(), children: [entity], getComponent: () => null };
    parent.object3D.add(entity.object3D);
    assert.equal(getEntityBoundingSphere(parent, bounds), true);
    assert.equal(bounds.radius, 20, "parent viewOnly also discovers child simulation meshes");
  }
});

test("disabled forces keep the saved graph and restore their exact connections", () => {
  const graph = {
    nodes: [{ id: "gravity", type: "gravity", enabled: false }, { id: "wind", type: "wind" }, { id: "sum", type: "add" }, { id: "system", type: "system" }],
    edges: [wire("gravity", "sum", "a"), wire("wind", "sum", "b"), wire("sum", "system", "force")],
  };
  const saved = structuredClone(graph);
  assert.deepEqual(activeParticleGraph(graph).edges, graph.edges.slice(1));
  assert.deepEqual(graph, saved);
  graph.nodes[0].enabled = true;
  assert.deepEqual(activeParticleGraph(graph).edges, graph.edges);
});

test("disabled chained operators bypass their primary input, while converters use defaults", () => {
  const graph = {
    nodes: [{ id: "velocity", type: "vec3" }, { id: "normal", type: "normalizeV", enabled: false }, { id: "multiply", type: "multiply", enabled: false }, { id: "length", type: "lengthV", enabled: false }, { id: "system", type: "system" }],
    edges: [wire("velocity", "normal", "v"), wire("normal", "multiply", "a"), wire("multiply", "system", "velocity"), wire("velocity", "length", "v"), wire("length", "system", "size")],
  };
  assert.deepEqual(activeParticleGraph(graph).edges, [wire("velocity", "system", "velocity")]);
});

test("disabled appearance roots compile with the system fallback, including opacity", async () => {
  const graph = {
    nodes: [{ id: "size", type: "float", enabled: false, props: { value: 0 } }, { id: "alpha", type: "float", enabled: false }, { id: "system", type: "system" }],
    edges: [wire("size", "system", "size"), wire("alpha", "system", "opacity")],
  };
  const { systems } = await compileParticleGraph(graph);
  assert.equal(systems[0].size({ cache: new Map() }).node.value, 0.1);
  assert.equal(systems[0].opacity, null);
  graph.nodes[2].enabled = false;
  assert.deepEqual((await compileParticleGraph(graph)).systems, []);
});

test("enable toggles rebuild, but slider edits update existing uniforms", async () => {
  const graph = { nodes: [{ id: "size", type: "float", props: { value: 0.2 } }, { id: "system", type: "system" }], edges: [wire("size", "system", "size")] };
  const initial = particleGraphSignature(graph);
  const compiled = await compileParticleGraph(graph);
  const size = compiled.systems[0].size({ cache: new Map() });
  graph.nodes[0].props.value = 0.7;
  assert.equal(particleGraphSignature(graph), initial);
  compiled.updateParams(graph);
  assert.equal(size.value, 0.7);
  delete graph.nodes[0].props.value;
  compiled.updateParams(graph);
  assert.equal(size.value, 1);
  graph.nodes[0].enabled = false;
  assert.notEqual(particleGraphSignature(graph), initial);
  graph.nodes[0].enabled = true;
  assert.equal(particleGraphSignature(graph), initial);
});
