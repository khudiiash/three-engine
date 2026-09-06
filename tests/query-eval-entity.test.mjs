import test from "node:test";
import assert from "node:assert/strict";

import { parseQuery } from "../src/editor/queryLang.js";
import {
  textTier,
  entityTermMatcher,
  entityMatcher,
  resolveEntityPath,
  FILTER_ONLY_TIER,
} from "../src/editor/queryEvalEntity.js";
import { matchTier } from "../src/editor/hierarchySearch.js";

/**
 * Entity-side evaluation over synthetic mirrors — the same plain-data shape
 * sceneStore's mirror produces. `collider.shape=convex` must read a lamp's
 * collider; a missing component must skip the entity, never throw.
 */

const lamp = {
  name: "Lamp Post 2",
  tags: ["street", "lighting"],
  componentTypes: ["transform", "mesh", "light", "collider"],
  components: {
    transform: { enabled: true },
    mesh: { enabled: true, castShadow: true },
    light: { enabled: true, intensity: 3.5, kind: "point", castShadow: false },
    collider: { enabled: true, shape: "convex", friction: 0.5 },
  },
  enabled: true,
  enabledInGame: true,
  childIds: ["a", "b"],
};

const disabledLamp = {
  ...lamp,
  name: "Floor Lamp",
  enabled: false,
  enabledInGame: true,
};

const noCollider = {
  name: "Lamp Shade",
  tags: [],
  componentTypes: ["transform", "light"],
  components: { transform: { enabled: true }, light: { enabled: true, intensity: 1 } },
  enabled: true,
  enabledInGame: false,
};

const tier = (raw, candidate) => entityMatcher(parseQuery(raw))(candidate);

test("the structured ladder agrees with legacy matchTier on plain text", () => {
  for (const q of ["lamp", "Lamp", "tag:street", "collider", "mesh", "nothing here"]) {
    const legacy = matchTier(lamp, q.toLowerCase());
    const mine = tier(q, lamp);
    assert.equal(mine, legacy === Infinity ? Infinity : legacy, q);
  }
});

test("Lamp?enabled=true&collider.shape=convex — the user's own example", () => {
  assert.equal(tier("Lamp?enabled=true&collider.shape=convex", lamp), 0, "'Lamp Post 2' starts with Lamp");
  assert.equal(tier("Lamp?enabled=true&collider.shape=convex", disabledLamp), Infinity, "disabled fails enabled=true");
  assert.equal(tier("Lamp?enabled=true&collider.shape=convex", noCollider), Infinity, "no collider is not a match");
});

test("Lamp... is prefix, ...Box is suffix", () => {
  assert.equal(tier("Lamp...", lamp), 0);
  assert.equal(tier("Lamp...", noCollider), 0, "Lamp Shade starts with Lamp");
  assert.equal(tier("Lamp...", disabledLamp), Infinity, "'Floor Lamp' does not START with Lamp");
  assert.equal(tier("...2", lamp), 0, "'Lamp Post 2' ends with 2");
  assert.equal(tier("...post", lamp), Infinity, "…but it ends with '2', not 'post'");
  assert.equal(tier("...lamp", disabledLamp), 0, "suffix hits 'Floor Lamp'");
  assert.equal(tier("...2", noCollider), Infinity);
});

test("missing components and nested paths resolve without throwing", () => {
  assert.deepEqual(resolveEntityPath(lamp, ["collider", "shape"]), { found: true, value: "convex" });
  assert.deepEqual(resolveEntityPath(noCollider, ["collider", "shape"]), { found: false });
  assert.deepEqual(resolveEntityPath(lamp, ["light", "intensity"]), { found: true, value: 3.5 });
  assert.deepEqual(resolveEntityPath(lamp, ["light", "castShadow"]), { found: true, value: false });
});

test("ordering and boolean filters over component props", () => {
  assert.equal(tier("?light.intensity>3", lamp), FILTER_ONLY_TIER);
  assert.equal(tier("?light.intensity>4", lamp), Infinity);
  assert.equal(tier("?light.intensity<=3.5", lamp), FILTER_ONLY_TIER);
  assert.equal(tier("?light.kind=point", lamp), FILTER_ONLY_TIER);
  assert.equal(tier("?light.kind!=point", lamp), Infinity);
  assert.equal(tier("?light.castShadow=false", lamp), FILTER_ONLY_TIER);
  assert.equal(tier("?mesh.castShadow=true", lamp), FILTER_ONLY_TIER);
  assert.equal(tier("?light.kinda=point", lamp), Infinity, "unknown prop matches nothing");
});

test("bare component path compared to a boolean means existence", () => {
  assert.equal(tier("?collider=true", lamp), FILTER_ONLY_TIER);
  assert.equal(tier("?collider=true", noCollider), Infinity);
  assert.equal(tier("?collider=false", noCollider), FILTER_ONLY_TIER);
  assert.equal(tier("?sound=true", lamp), Infinity);
});

test("entity-level enabled vs enabledInGame", () => {
  assert.equal(tier("?enabled=true", disabledLamp), Infinity);
  assert.equal(tier("?enabled=false", disabledLamp), FILTER_ONLY_TIER);
  assert.equal(tier("?enabled=true", lamp), FILTER_ONLY_TIER);
  assert.equal(tier("?enabledInGame=false", noCollider), FILTER_ONLY_TIER);
  assert.equal(tier("?enabledInGame=true", noCollider), Infinity);
});

test("component-enabled is reachable as comp.enabled", () => {
  const offLight = {
    ...noCollider,
    components: { light: { enabled: false, intensity: 1 } },
  };
  assert.equal(tier("?light.enabled=false", offLight), FILTER_ONLY_TIER);
  // entity enabled stays true — the flags are independent
  assert.equal(tier("?enabled=true", offLight), FILTER_ONLY_TIER);
});

test("tag filters and tag: names in structured queries", () => {
  assert.equal(tier("?tag=street", lamp), FILTER_ONLY_TIER);
  assert.equal(tier("?tag=street", noCollider), Infinity);
  assert.equal(tier("tag:street?enabled=true", lamp), 0);
  assert.equal(tier("tag:street?enabled=true", disabledLamp), Infinity);
});

test("kind words behave as ordinary words on the entity side", () => {
  const sceneEntity = { ...noCollider, name: "Scene Root", tags: [], componentTypes: [], components: {} };
  assert.equal(tier("scene", sceneEntity), 0, "matches the NAME, not an asset kind");
  assert.equal(tier("texture", sceneEntity), Infinity);
});

test("multi-term queries AND and rank at the worst term", () => {
  const q = parseQuery("lamp?enabled=true collider?shape=convex");
  assert.equal(entityMatcher(q)(lamp), 2, "both match; the component-type term (tier 2) dominates");
  assert.equal(entityMatcher(q)(noCollider), Infinity, "missing collider fails the AND");
});

test("childCount is queryable", () => {
  assert.equal(tier("?childcount>1", lamp), FILTER_ONLY_TIER);
  assert.equal(tier("?childcount>5", lamp), Infinity);
  assert.equal(tier("?childcount=0", noCollider), FILTER_ONLY_TIER);
});

test("textTier is exported and equals the legacy ladder on this shape", () => {
  assert.equal(textTier(lamp, "lamp"), 0);
  assert.equal(textTier(lamp, "post"), 1);
  assert.equal(textTier(lamp, "light"), 2, "component type starts-with");
  assert.equal(textTier(lamp, "oll"), 3, "component type contains (collider)");
  assert.equal(textTier(lamp, "street"), 4, "tag contains");
  assert.equal(textTier(lamp, "zzz"), Infinity);
});
