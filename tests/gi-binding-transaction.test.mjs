import assert from "node:assert/strict";
import test from "node:test";
import { createGiBindingMutationJournal } from "../src/modules/gi/giBindingTransaction.js";

function sampled(texture, node) {
  return {
    _texture: texture,
    get texture() { return this._texture; },
    set texture(value) {
      this._texture = value;
      this.version = -1;
      this.generation = null;
    },
    textureNode: node,
    version: texture.version,
    generation: 3,
    samplerKey: "old-sampler",
  };
}

test("later foreign-invalid group rolls every earlier GI JS mutation back", () => {
  const oldA = { version: 1 };
  const oldB = { version: 2 };
  const nextA = { version: 11 };
  const nextB = { version: 12 };
  const nodeA = { value: oldA };
  const nodeB = { value: oldB };
  const bindingA = sampled(oldA, nodeA);
  const bindingB = sampled(oldB, nodeB);
  const groupA = {};
  const groupB = {};
  const groups = new Map([
    [groupA, new Map([[bindingA, oldA]])],
    [groupB, new Map([[bindingB, oldB]])],
  ]);
  const nextMembers = new Set();
  let persistentNode = oldA;
  const journal = createGiBindingMutationJournal(groups);
  journal.setExtraRollback(() => { persistentNode = oldA; });

  // Group A prepared successfully; group B is then found to contain a null
  // foreign sampled slot. This is the exact ordering that used to leak new JS
  // state while withholding every native backend update.
  persistentNode = nextA;
  nodeA.value = nextA;
  bindingA.texture = nextA;
  bindingA.version = 11;
  bindingA.generation = 13;
  bindingA.samplerKey = "new-a";
  journal.noteMembership(nextMembers, groupA);
  nextMembers.add(groupA);
  nodeB.value = nextB;
  bindingB.texture = nextB;
  bindingB.version = 12;
  bindingB.generation = 14;
  bindingB.samplerKey = "new-b";
  const foreignTexture = null;
  assert.equal(foreignTexture, null);

  journal.rollback();

  assert.equal(persistentNode, oldA);
  assert.equal(nodeA.value, oldA);
  assert.equal(nodeB.value, oldB);
  assert.deepEqual(
    [bindingA.texture, bindingA.version, bindingA.generation, bindingA.samplerKey],
    [oldA, 1, 3, "old-sampler"],
  );
  assert.deepEqual(
    [bindingB.texture, bindingB.version, bindingB.generation, bindingB.samplerKey],
    [oldB, 2, 3, "old-sampler"],
  );
  assert.equal(nextMembers.has(groupA), false);
});
