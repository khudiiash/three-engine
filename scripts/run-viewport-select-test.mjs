// Viewport selection: what does a click mean, and what does a marquee catch?
//
// Two features, one gate, because they share a rule. Clicking a leaf mesh of an
// imported model used to select the leaf — you moved the leaves and the trunk
// stayed behind — and there was no way to select several things in the viewport
// at all. Both now route through `resolveSelectionTarget` (pickTarget.js) so a
// drag and a click agree about what "that object" means.
//
// The box-select geometry is a FRUSTUM test, not two screen rects, and that is
// the half worth pinning: the obvious 2D implementation is right until a corner
// crosses the near plane, at which point it projects to a mirrored point and a
// wall you are standing beside reports a rectangle on the wrong side of the
// viewport. The behind-the-camera and inside-the-box cases below are exactly
// the ones that implementation gets wrong, and they look fine in a screenshot.
//
// Run: node scripts/run-viewport-select-test.mjs

import * as THREE from "three/webgpu";
import {
  collectSelectionCandidates,
  frustumFromNdcRect,
  idsInFrustum,
  ndcRectFromPixels,
} from "../src/editor/boxSelect.js";
import { findEntityId, outermostPrefabRoot, resolveSelectionTarget } from "../src/editor/pickTarget.js";
import { UI_LAYER } from "../src/engine/editorLayers.js";

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const SIZE = { width: 800, height: 600 };

/** A unit box tagged as `id`'s renderable, at `position`. */
function box(id, position, scale = 1) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(scale, scale, scale));
  mesh.name = id;
  mesh.userData.entityId = id;
  mesh.position.set(...position);
  return mesh;
}

/** Screen pixel position of a world point, so the fixtures can say "a box
 *  around the middle two" without hard-coding coordinates that break the
 *  moment the camera moves. */
function toPixels(world, camera) {
  const ndc = world.clone().project(camera);
  return {
    x: ((ndc.x + 1) / 2) * SIZE.width,
    y: ((1 - ndc.y) / 2) * SIZE.height,
  };
}

function select(scene, camera, rect, entities = []) {
  const frustum = frustumFromNdcRect(ndcRectFromPixels(rect, SIZE), camera);
  const ids = [...idsInFrustum(collectSelectionCandidates(scene, entities), frustum)];
  return ids.sort();
}

// ---------------------------------------------------------------------------
console.log("\nbox select — geometry");

{
  const scene = new THREE.Scene();
  const xs = [-4, -2, 0, 2, 4];
  for (const x of xs) scene.add(box(`box${x}`, [x, 0, 0]));

  const camera = new THREE.PerspectiveCamera(50, SIZE.width / SIZE.height, 0.1, 1000);
  camera.position.set(0, 0, 12);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const at = (x) => toPixels(new THREE.Vector3(x, 0, 0), camera);
  // A band that comfortably brackets the two middle boxes and stops short of
  // their neighbours: midway between -2 and -4 on the left, -2 and 2... on the
  // right side that is midway between 0 and 2 plus half a box, so use -3 and 1.
  const rect = {
    left: at(-3).x,
    right: at(1).x,
    top: at(0).y - 60,
    bottom: at(0).y + 60,
  };
  check("a band selects only the boxes it covers", same(select(scene, camera, rect), ["box-2", "box0"]),
    select(scene, camera, rect).join(",") || "nothing");

  const all = {
    left: 0, top: 0, right: SIZE.width, bottom: SIZE.height,
  };
  check("a full-viewport marquee selects the whole row",
    same(select(scene, camera, all), ["box-2", "box-4", "box0", "box2", "box4"]),
    select(scene, camera, all).join(","));

  // Touch, not containment: a box the marquee only grazes still counts, or
  // anything larger than the rectangle would be unselectable.
  const graze = { left: at(2).x - 2, right: at(2).x + 2, top: at(2).y - 2, bottom: at(2).y + 2 };
  check("a marquee inside one box selects it (touch, not containment)",
    same(select(scene, camera, graze), ["box2"]), select(scene, camera, graze).join(","));

  // THE near-plane case. This box is directly behind the camera; a screen-rect
  // implementation projects its corners to mirrored points and reports it in
  // front, so a full-viewport marquee would catch it.
  scene.add(box("behind", [0, 0, 40]));
  check("geometry behind the camera is never selected",
    !select(scene, camera, all).includes("behind"), select(scene, camera, all).join(","));
}

{
  // Orthographic axis view: the frustum's side planes are parallel here, which
  // flips the winding of half the faces relative to the perspective case. If
  // the plane normals were hard-coded rather than aimed at the centroid, this
  // selects the complement of the marquee — everything EXCEPT what you dragged
  // over — and passes every perspective test on the way.
  const scene = new THREE.Scene();
  for (const x of [-4, 0, 4]) scene.add(box(`box${x}`, [x, 0, 0]));
  const camera = new THREE.OrthographicCamera(-10, 10, 7.5, -7.5, 0.1, 1000);
  camera.position.set(0, 0, 12);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const at = (x) => toPixels(new THREE.Vector3(x, 0, 0), camera);
  const rect = { left: at(-2).x, right: at(2).x, top: at(0).y - 40, bottom: at(0).y + 40 };
  check("orthographic view selects the same middle box",
    same(select(scene, camera, rect), ["box0"]), select(scene, camera, rect).join(",") || "nothing");
}

// ---------------------------------------------------------------------------
console.log("\nbox select — what counts as a candidate");

{
  const camera = new THREE.PerspectiveCamera(50, SIZE.width / SIZE.height, 0.1, 1000);
  camera.position.set(0, 0, 12);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const all = { left: 0, top: 0, right: SIZE.width, bottom: SIZE.height };

  const scene = new THREE.Scene();
  scene.add(box("plain", [0, 0, 0]));

  const hidden = box("hidden", [0, 0, 0]);
  hidden.visible = false;
  scene.add(hidden);

  // Merging hides its members and draws them through a proxy that opts out of
  // raycasting; the member is on screen and must stay selectable. Same contract
  // picking relies on — see engine/batching.js and pickVisibility.js.
  const merged = box("merged", [0, 0, 0]);
  merged.visible = false;
  merged.userData.mergedInto = {};
  scene.add(merged);

  // ...and the proxy itself belongs to nobody: its box spans every member.
  const proxy = box("proxy", [0, 0, 0], 40);
  proxy.userData.mergeProxy = true;
  delete proxy.userData.entityId;
  scene.add(proxy);

  const helper = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  helper.userData.editorOnly = true;
  scene.add(helper);

  const ui = box("ui", [0, 0, 0]);
  ui.layers.enable(UI_LAYER);
  scene.add(ui);

  const ids = select(scene, camera, all);
  check("a visible mesh is selectable", ids.includes("plain"));
  check("an author-hidden mesh is not", !ids.includes("hidden"), ids.join(","));
  check("a merge-hidden member still is", ids.includes("merged"), ids.join(","));
  check("the merge proxy itself is not", !ids.includes("proxy"), ids.join(","));
  check("editor-only helpers are not", findEntityId(helper) === null);
  check("UI meshes are not", !ids.includes("ui"), ids.join(","));

  // Lights and cameras have no geometry: they come in as a point at their world
  // origin, or a marquee could never pick up a lamp.
  const lightEntity = {
    id: "sun",
    object3D: new THREE.Object3D(),
    getComponent: (type) => (type === "light" ? { light: new THREE.DirectionalLight() } : null),
  };
  lightEntity.object3D.position.set(0, 0, 0);
  lightEntity.object3D.updateMatrixWorld(true);
  check("a light is selectable by its position",
    select(scene, camera, all, [lightEntity]).includes("sun"));

  const offscreen = {
    id: "far-lamp",
    object3D: new THREE.Object3D(),
    getComponent: (type) => (type === "light" ? { light: new THREE.PointLight() } : null),
  };
  offscreen.object3D.position.set(500, 0, 0);
  offscreen.object3D.updateMatrixWorld(true);
  check("...but only when it is inside the marquee",
    !select(scene, camera, all, [offscreen]).includes("far-lamp"));
}

// ---------------------------------------------------------------------------
console.log("\nclick target — a click means the whole model");

{
  // Tree.prefab { Trunk, Foliage { Leaf } }, plus a loose Crate with a Lid that
  // is NOT a prefab, plus House.prefab containing a nested Lamp.prefab.
  const entity = (id, parent, prefab) => {
    const e = { id, name: id, parent: parent ?? null, prefab: prefab ?? null };
    return e;
  };
  const tree = entity("tree", null, { guid: "g1" });
  const trunk = entity("trunk", tree);
  const foliage = entity("foliage", tree);
  const leaf = entity("leaf", foliage);

  const crate = entity("crate");
  const lid = entity("lid", crate);

  const house = entity("house", null, { guid: "g2" });
  const lamp = entity("lamp", house, { guid: "g3" });
  const bulb = entity("bulb", lamp);

  const target = (e, opts) => resolveSelectionTarget(e, opts)?.id;

  check("clicking a leaf selects the prefab root", target(leaf) === "tree", target(leaf));
  check("clicking the root selects the root", target(tree) === "tree", target(tree));
  check("a loose parent/child is not a barrier", target(lid) === "lid", target(lid));
  check("a nested prefab resolves to the OUTERMOST root", target(bulb) === "house", target(bulb));
  check("outermostPrefabRoot agrees", outermostPrefabRoot(bulb)?.id === "house");
  check("an entity outside any prefab has no root", outermostPrefabRoot(crate) === null);

  check("Alt/double-click drills to the exact entity",
    target(leaf, { drill: true }) === "leaf", target(leaf, { drill: true }));

  // Stay-drilled: with something inside the tree already selected, further
  // clicks in the tree stay at that level instead of snapping back to the root.
  check("with a sibling inside the instance selected, clicks stay drilled",
    target(leaf, { selected: [trunk] }) === "leaf", target(leaf, { selected: [trunk] }));
  check("the instance ROOT being selected does not count as drilled in",
    target(leaf, { selected: [tree] }) === "tree", target(leaf, { selected: [tree] }));
  // Scoped to the instance that was clicked: being drilled into the house must
  // not turn the next click on an untouched tree into a leaf-select.
  check("drilling into one prefab does not drill every other one",
    target(leaf, { selected: [bulb] }) === "tree", target(leaf, { selected: [bulb] }));

  check("nothing under the pointer resolves to nothing", resolveSelectionTarget(null) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
