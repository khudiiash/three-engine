import test from "node:test";
import assert from "node:assert/strict";

import { parseQuery } from "../src/editor/queryLang.js";
import {
  assetMatcher,
  assetKindOf,
  queryNeeds,
  resolveAssetPath,
} from "../src/editor/queryEvalAsset.js";

/**
 * Asset-side evaluation with INJECTED meta — the node tests must not depend
 * on Tauri or on real files. The editor passes getAssetMeta; here it is a Map.
 */

const tex = { name: "cliff_diffuse.png", path: "assets/tex/cliff_diffuse.png", ext: "png", is_dir: false, size: 2048000, modified: 100 };
const bigTex = { name: "poster.png", path: "assets/tex/poster.png", ext: "png", is_dir: false, size: 999, modified: 100 };
const mat = { name: "rough_steel.mat", path: "assets/mat/rough_steel.mat", ext: "mat", is_dir: false, size: 400, modified: 100 };
const graphMat = { name: "fancy.mat", path: "assets/mat/fancy.mat", ext: "mat", is_dir: false, size: 400, modified: 100 };
const sound = { name: "explosion.audio", path: "assets/sfx/explosion.audio", ext: "audio", is_dir: false, size: 10, modified: 100 };
const folder = { name: "textures", path: "assets/tex", ext: "", is_dir: true };

const meta = {
  "assets/tex/cliff_diffuse.png": { width: 1024, height: 1024 },
  "assets/tex/poster.png": { width: 4096, height: 2048 },
  "assets/mat/rough_steel.mat": { material: { roughness: 0, metalness: 0.8, color: "#8a8a8a", graph: false, map: "assets/tex/cliff_diffuse.png" } },
  "assets/mat/fancy.mat": { material: { graph: true } },
};
const getMeta = (path) => meta[path] ?? null;
const run = (raw, entries, options) => {
  const m = assetMatcher(parseQuery(raw), { getMeta, ...options });
  return entries.filter((entry) => m(entry));
};

test("assetKindOf classifies by extension, folders by is_dir", () => {
  assert.equal(assetKindOf(tex), "texture");
  assert.equal(assetKindOf(mat), "material");
  assert.equal(assetKindOf(sound), "audio");
  assert.equal(assetKindOf(folder), "folder");
  assert.equal(assetKindOf({ name: "odd.xyz", ext: "xyz" }), null);
});

test("texture?width>1920 — kind replaces name matching entirely", () => {
  const hits = run("texture?width>1920", [tex, bigTex, mat, sound]);
  assert.deepEqual(hits.map((h) => h.name), ["poster.png"], "only the 4096px one");
  // A texture NAMED "texture" still needs the width; a wide material is not a texture.
  assert.deepEqual(run("texture", [tex, bigTex, mat]), [tex, bigTex], "bare kind = every texture");
});

test("material?roughness=0 — the user's second example", () => {
  const hits = run("material?roughness=0", [tex, mat, graphMat, sound]);
  assert.deepEqual(hits.map((h) => h.name), ["rough_steel.mat"]);
  // Graph materials expose no comparable scalars — surfaced via graph=true.
  assert.deepEqual(run("material?graph=true", [mat, graphMat]).map((h) => h.name), ["fancy.mat"]);
  assert.deepEqual(run("material?graph=false", [mat, graphMat]).map((h) => h.name), ["rough_steel.mat"]);
});

test("meta absent ⇒ meta-dependent filters match nothing (never throw)", () => {
  const noMeta = () => null;
  const m = assetMatcher(parseQuery("texture?width>1920"), { getMeta: noMeta });
  assert.equal(m(tex), false);
  const plain = assetMatcher(parseQuery("cliff"), { getMeta: noMeta });
  assert.equal(plain(tex), true, "plain name search still works without meta");
});

test("name modes: substring, prefix, suffix, quoted spaces", () => {
  assert.deepEqual(run("cliff", [tex, bigTex]).map((h) => h.name), ["cliff_diffuse.png"]);
  assert.deepEqual(run("cliff...", [tex, bigTex]).map((h) => h.name), ["cliff_diffuse.png"]);
  assert.deepEqual(run("...png", [tex, bigTex]).map((h) => h.name), ["cliff_diffuse.png", "poster.png"]);
  assert.deepEqual(run('"cliff_d"', [tex]).map((h) => h.name), ["cliff_diffuse.png"]);
  assert.deepEqual(run("...diffuse", [{ ...tex, name: "diffuse_map.png" }]), [], "…diffuse means ENDING with diffuse");
});

test("multi-term AND, kind + name terms combine", () => {
  const hits = run("texture?width>1920 png", [tex, bigTex]);
  assert.deepEqual(hits.map((h) => h.name), ["poster.png"], "kind+filter AND plain name 'png'");
  assert.deepEqual(run("texture?width>1920 cliff", [tex, bigTex]), []);
});

test("top-level fields: size, ext, dir, kind, modified", () => {
  assert.deepEqual(run("?size>1000000", [tex, bigTex, mat]).map((h) => h.name), ["cliff_diffuse.png"]);
  assert.deepEqual(run("?ext=png", [tex, bigTex, mat]).length, 2);
  assert.deepEqual(run("?dir=true", [folder, tex]).map((h) => h.name), ["textures"]);
  assert.deepEqual(run("?kind=audio", [sound, tex]).map((h) => h.name), ["explosion.audio"]);
  assert.deepEqual(run("?modified>=100", [tex]).length, 1);
});

test("tag filters come from the injected getTags", () => {
  const tags = (entry) => (entry.name === "cliff_diffuse.png" ? ["Cliff", "Rock"] : []);
  assert.deepEqual(run("?tag=cliff", [tex, bigTex], { getTags: tags }).map((h) => h.name), ["cliff_diffuse.png"]);
  assert.deepEqual(run("cliff?tag!=rock", [tex], { getTags: tags }), [], "it IS tagged rock, so != fails");
  assert.deepEqual(run("?tag!=rock", [bigTex], { getTags: tags }).length, 1, "untagged passes !=; it has no rock tag");
});

test("queryNeeds reports only what the query actually touches", () => {
  assert.deepEqual(queryNeeds(parseQuery("rock")), { dims: false, material: false });
  assert.deepEqual(queryNeeds(parseQuery("texture?width>1920")), { dims: true, material: false });
  assert.deepEqual(queryNeeds(parseQuery("material?roughness<0.1")), { dims: false, material: true });
  assert.deepEqual(queryNeeds(parseQuery("?height=512&metalness=1")), { dims: true, material: true });
});

test("resolveAssetPath shape", () => {
  assert.deepEqual(resolveAssetPath(tex, meta[tex.path], ["width"]), { found: true, value: 1024 });
  assert.deepEqual(resolveAssetPath(tex, meta[tex.path], ["roughness"]), { found: false });
  assert.deepEqual(resolveAssetPath(mat, meta[mat.path], ["roughness"]), { found: true, value: 0 });
  assert.deepEqual(resolveAssetPath(tex, null, ["size"]), { found: true, value: 2048000 }, "entry fields need no meta");
  assert.deepEqual(resolveAssetPath(tex, null, ["width"]), { found: false });
});
