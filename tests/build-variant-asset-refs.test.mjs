import test from "node:test";
import assert from "node:assert/strict";
import { rewriteComponentAssets } from "../src/editor/build/assetRefs.js";
import { createAssetNames } from "../src/editor/build/assetNames.js";

// A per-platform override set (`props.variants.mobile`) is the same prop
// shape as the base props. The build must rewrite its asset references with
// the same rules, or a phone's variant keeps the authoring path — which is
// how the Sponza Player's mobile variant of its script list shipped
// `C:\Users\…\CharacterCamera.ts`, 404'd, instantiated nothing, and the
// character stopped orbiting on mobile (2026-09-12).
test("a script component's mobile variant ships its slot list rewritten like the base list", () => {
  const names = createAssetNames();
  const shipped = [];
  const camera = "C:/project/scripts/CharacterCamera.ts";
  const controller = "C:/project/scripts/CharacterController.ts";
  const component = {
    type: "script",
    props: {
      enabled: true,
      scripts: [
        { path: controller, enabled: true, attributes: {} },
        { path: camera, enabled: true, attributes: { distance: 1 } },
      ],
      variants: {
        mobile: {
          scripts: [
            { path: controller, enabled: true, attributes: {} },
            { path: camera, enabled: true, attributes: { distance: 1, shoulder: [0.4, 1.4, 0], cameraRadius: 0.25 } },
          ],
        },
      },
    },
  };
  rewriteComponentAssets(component, {
    getSchema: () => [],
    claim: (p) => names.claim(p),
    claimDoc: (p) => names.claimGenerated(p),
    add: (kind, path) => shipped.push([kind, path]),
  });
  const base = component.props.scripts.map((s) => s.path);
  const mobile = component.props.variants.mobile.scripts.map((s) => s.path);
  assert.deepEqual(mobile, base, "the variant's slots point where the base slots point");
  for (const p of mobile) assert.ok(!p.includes("C:/project"), `authoring path leaked: ${p}`);
  // The attributes the user set on the variant survive untouched.
  assert.deepEqual(component.props.variants.mobile.scripts[1].attributes, { distance: 1, shoulder: [0.4, 1.4, 0], cameraRadius: 0.25 });
  // Both slot lists ask for the same two files; the exporter dedupes by path.
  assert.deepEqual(new Set(shipped.map(([, p]) => p)), new Set([controller, camera]));
});

test("a schema asset field overridden in a variant is claimed into the build too", () => {
  const names = createAssetNames();
  const shipped = [];
  const component = {
    type: "sprite",
    props: {
      texture: "C:/project/art/desktop.png",
      variants: { mobile: { texture: "C:/project/art/phone.png" }, landscape: {} },
    },
  };
  rewriteComponentAssets(component, {
    getSchema: () => [{ key: "texture", type: "asset" }],
    claim: (p) => { shipped.push(p); return names.claim(p); },
    claimDoc: (p) => names.claimGenerated(p),
    add: () => {},
  });
  assert.equal(component.props.texture, "assets/desktop.png");
  assert.equal(component.props.variants.mobile.texture, "assets/phone.png");
  assert.deepEqual(component.props.variants.landscape, {});
  assert.deepEqual(shipped, ["C:/project/art/desktop.png", "C:/project/art/phone.png"]);
});
