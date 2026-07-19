import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultMaterialFork,
  materialStemForEntity,
  uniqueMaterialName,
} from "../src/editor/defaultMaterialFork.js";

test("uses the entity name for a material in the project materials folder", async () => {
  const writes = [];
  const graph = { nodes: [{ id: "output", type: "output" }], edges: [] };
  const path = await createDefaultMaterialFork({
    rootPath: "C:/Game",
    entityName: "Mesh",
    graph,
    listDirectory: async () => [],
    saveFile: async (filePath, contents) => writes.push([filePath, JSON.parse(contents)]),
  });

  assert.equal(path, "C:/Game/materials/Mesh.mat");
  assert.equal(writes[0][0], path);
  assert.deepEqual(writes[0][1].shaderGraph, graph);
});

test("sanitizes entity names and avoids existing material filenames case-insensitively", () => {
  assert.equal(materialStemForEntity("Hero/Body."), "Hero_Body");
  assert.equal(uniqueMaterialName("Mesh", [{ name: "mesh.mat" }, { name: "Mesh 1.mat" }]), "Mesh 2.mat");
});
