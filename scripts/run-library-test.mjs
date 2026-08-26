/**
 * The asset-library browsers, as source-level contracts.
 *
 *   node scripts/run-library-test.mjs
 *
 * These panels talk to five live third-party APIs, so there is no honest way to
 * assert their *behaviour* offline — and hitting the real services from a test
 * would need five API keys and would fail on a train. What CAN be gated is
 * everything that has actually broken here before: a panel wired into two of
 * its three registration points, a provider added to the UI but not to the MCP
 * ops, a duplicated constant drifting from its source, and a credential
 * attached with the wrong header.
 *
 * ## The registration trap this exists for
 *
 * Adding an editor panel takes THREE separate edits — the lazy import plus the
 * component map plus the dock layout in `EditorShell.jsx` — and two more to be
 * reachable (`MenuBar.jsx`, `QuickSearch.jsx`). Miss the dock entry and the
 * panel opens to nothing; miss the menu entry and it exists but cannot be
 * found. Both failures look like "the feature wasn't built".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

let failures = 0;
let checks = 0;
const check = (name, fn) => {
  checks++;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message.split("\n")[0]}`);
  }
};

const shell = read("src/editor/EditorShell.jsx");
const menuBar = read("src/editor/MenuBar.jsx");
const quickSearch = read("src/editor/QuickSearch.jsx");
const modulesIndex = read("src/modules/index.js");
const modulesPanel = read("src/editor/panels/ModulesPanel.jsx");
const libraryOps = read("src/editor/api/ops/library.js");
const polypizza = read("src/editor/polypizza.js");
const ambientcg = read("src/editor/ambientcg.js");
const polyhaven = read("src/editor/polyhaven.js");
const fab = read("src/editor/fab.js");
const previewSources = read("src/editor/previewSources.js");
const rust = read("src-tauri/src/lib.rs");

/** Every browser panel, and the module that gates it. */
const BROWSERS = [
  { panel: "polyhaven", component: "PolyHavenPanel", module: "polyhaven", menu: "Poly Haven" },
  { panel: "ambientcg", component: "AmbientCGPanel", module: "ambientcg", menu: "AmbientCG" },
  { panel: "sketchfab", component: "SketchfabPanel", module: "sketchfab", menu: "Sketchfab" },
  { panel: "polypizza", component: "PolyPizzaPanel", module: "polypizza", menu: "Poly Pizza" },
  { panel: "fab", component: "FabPanel", module: "fab", menu: "Fab" },
  { panel: "itchio", component: "ItchioPanel", module: "itchio", menu: "itch.io" },
  { panel: "audioLibrary", component: "AudioLibraryPanel", module: "audio-library", menu: "Audio Library" },
];

// ---------------------------------------------------------------------------
console.log("\nlibrary — every browser panel is reachable");
// ---------------------------------------------------------------------------

for (const browser of BROWSERS) {
  check(`${browser.panel} is wired into all five registration points`, () => {
    assert.ok(
      new RegExp(`const ${browser.component} = lazy\\(`).test(shell),
      "no lazy import in EditorShell",
    );
    assert.ok(
      new RegExp(`\\b${browser.panel}: withPanelSuspense\\(`).test(shell),
      "not in EditorShell's component map",
    );
    // The dock entry is the one whose absence produces an empty panel rather
    // than an error — nothing throws, the tab just has no content.
    assert.ok(
      new RegExp(`\\b${browser.panel}: \\{ title:`).test(shell),
      "no dock layout entry in EditorShell (panel would open empty)",
    );
    assert.ok(
      new RegExp(`openPanel\\("${browser.panel}"\\)`).test(menuBar),
      "not in the Window menu",
    );
    assert.ok(
      new RegExp(`\\["${browser.panel}", `).test(quickSearch),
      "not in QuickSearch",
    );
  });
}

check("every browser module is registered in the module catalog", () => {
  for (const browser of BROWSERS) {
    const source = read(`src/modules/${browser.module}/index.js`);
    assert.ok(new RegExp(`id: "${browser.module}"`).test(source), `${browser.module} has no id`);
    const name = source.match(/const (\w+Module) =/)?.[1];
    assert.ok(name, `${browser.module} exports no *Module const`);
    assert.ok(
      modulesIndex.includes(`registerModuleDefinition(${name})`),
      `${name} is never registered in src/modules/index.js`,
    );
  }
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — the Assets category");
// ---------------------------------------------------------------------------

check("every asset browser sits under the Assets category", () => {
  for (const browser of BROWSERS) {
    const source = read(`src/modules/${browser.module}/index.js`);
    assert.ok(
      /category: "Assets"/.test(source),
      `${browser.module} is not categorised as Assets`,
    );
  }
});

check("the Modules panel knows the Assets category, and orders it", () => {
  const order = modulesPanel.match(/const CATEGORY_ORDER = \[([^\]]*)\]/);
  assert.ok(order, "CATEGORY_ORDER not found");
  const names = [...order[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.includes("Assets"), `Assets missing from CATEGORY_ORDER: ${names.join(", ")}`);
  // Anything absent from the list is silently swept into "Other" at the very
  // bottom — the failure mode the ordered list exists to prevent.
  assert.ok(names.at(-1) === "Other", "Other must stay last as the catch-all");
});

check("no asset browser is left behind in the Editor category", () => {
  // Texture and Audio EDITORS legitimately stay under Editor; the browsers
  // must not, or the split buys nothing.
  const stragglers = BROWSERS.filter((b) =>
    /category: "Editor"/.test(read(`src/modules/${b.module}/index.js`)),
  );
  assert.equal(stragglers.length, 0, `still under Editor: ${stragglers.map((b) => b.module).join(", ")}`);
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — MCP coverage tracks the panels");
// ---------------------------------------------------------------------------

check("every keyed browser is a library.* provider", () => {
  // itch.io and the audio library are the two exceptions with their own op
  // families; everything else must be reachable through library.search.
  for (const id of ["polyhaven", "ambientcg", "sketchfab", "polypizza", "fab", "itchio"]) {
    assert.ok(
      new RegExp(`^\\s*${id}: \\{ module:`, "m").test(libraryOps),
      `${id} is not in library.js PROVIDERS — the panel would have no MCP equivalent`,
    );
  }
});

check("polypizza has both a search and an import branch", () => {
  assert.ok(
    libraryOps.includes('if (provider === "polypizza") {'),
    "no polypizza branch",
  );
  // Two branches, one per op. A provider listed in PROVIDERS but handled in
  // only one of them fails at call time with a confusing fallthrough into
  // whichever provider the function ends on.
  const branches = libraryOps.match(/if \(provider === "polypizza"\) \{/g) ?? [];
  assert.equal(branches.length, 2, `expected search + import branches, found ${branches.length}`);
});

check("library.status reports the polypizza key", () => {
  assert.ok(/polypizza: !!polypizza\?\.getSavedToken/.test(libraryOps), "key not probed in status");
  assert.ok(/needsKey: true/.test(libraryOps.match(/polypizza: \{[^}]*\}/)[0]), "polypizza must be needsKey");
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — Poly Pizza specifics");
// ---------------------------------------------------------------------------

const categoryEntries = [...polypizza.matchAll(/\{ id: "([a-z-]+)", code: (\d+), label: "/g)]
  .map((m) => ({ id: m[1], code: Number(m[2]) }));
const categoryIds = categoryEntries.map((c) => c.id);

check("the client declares all twelve Poly Pizza categories", () => {
  assert.equal(categoryIds.length, 12, `found ${categoryIds.length}: ${categoryIds.join(", ")}`);
  assert.ok(categoryIds.includes("people-characters"), "people-characters missing");
  assert.ok(categoryIds.includes("animals"), "animals missing");
});

check("category codes are positions in Poly Pizza's own array", () => {
  // The filter value is an INDEX, so the ORDER is theirs and load-bearing —
  // read out of their site bundle. Reordering this list to something more
  // sensible for our dropdown would silently repoint every category.
  assert.deepEqual(
    categoryEntries.map((c) => c.code),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "codes must be 0..11 in declaration order",
  );
  assert.equal(categoryEntries.find((c) => c.id === "weapons")?.code, 2);
  assert.equal(categoryEntries.find((c) => c.id === "people-characters")?.code, 9);
});

check("licence codes are numeric, and 'any' is expressed by omission", () => {
  // `License=CC0` is a ZodError ("expected number, received nan") and
  // `License=-1` is rejected too ("License must be 0 or 1"), so "any" has to be
  // the absence of the parameter — which is why `needsFilter` still exists.
  const block = polypizza.match(/export const LICENSES = \[[\s\S]*?\];/)[0];
  assert.ok(/\{ id: "CC0", code: 1,/.test(block), "CC0 must be code 1");
  assert.ok(/\{ id: "CC-BY", code: 0,/.test(block), "CC-BY must be code 0");
  assert.ok(/\{ id: "", code: -1,/.test(block), "'any' needs a sentinel that is never sent");
  assert.ok(
    /licenseCode !== undefined && licenseCode >= 0/.test(polypizza),
    "the -1 sentinel must be filtered out before the request, not sent",
  );
});

check("filter values are sent as numbers, never as names", () => {
  assert.ok(/params\.set\("Category", String\(categoryCode\)\)/.test(polypizza), "category sent by name");
  assert.ok(/params\.set\("License", String\(licenseCode\)\)/.test(polypizza), "licence sent by name");
  // ALL THREE are numeric, including the one that reads as a boolean: sending
  // "true" coerces to NaN and fails with the same ZodError as "CC0" did.
  assert.ok(/params\.set\("Animated", "1"\)/.test(polypizza), "Animated=true must be sent as 1");
  assert.ok(/params\.set\("Animated", "0"\)/.test(polypizza), "Animated=false must be sent as 0");
  assert.ok(
    !/params\.set\("Animated", "(true|false)"\)/.test(polypizza),
    "a boolean string for Animated is NaN to this API",
  );
  // The two that really are lowercase. Casing here is per-parameter.
  assert.ok(/params\.set\("limit",/.test(polypizza) && /params\.set\("page",/.test(polypizza),
    "limit/page must stay lowercase");
});

check("the ops' duplicated category list matches the client's", () => {
  const block = libraryOps.match(/const POLYPIZZA_CATEGORIES = \[([\s\S]*?)\];/);
  assert.ok(block, "POLYPIZZA_CATEGORIES not found in library.js");
  const opIds = [...block[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...opIds].sort(),
    [...categoryIds].sort(),
    "library.js's copy has drifted from polypizza.js",
  );
});

check("the key-validation probe carries a filter", () => {
  // `/search` with no License/Animated/Category answers
  // 400 {"error":"No query parameters, must have License, Animated, or Category"}.
  // Validating with a bare `/search?limit=1` therefore rejected EVERY key,
  // valid or not, and the 400 read to the user as "your key is bad".
  const fn = polypizza.match(/export async function validateAndSaveToken[\s\S]*?\n\}/)[0];
  const probe = fn.match(/apiJson\("([^"]+)"/)?.[1];
  assert.ok(probe, "no validation request found");
  // Case-insensitive: the filter parameter names are PascalCase (`License`),
  // which is what the API's own 400 text calls them.
  assert.ok(
    /license=|category=|animated=/i.test(probe),
    `validation probe "${probe}" has no filter — the API will 400 it`,
  );
});

check("a filterless browse is refused locally, with the reason", () => {
  // Not left to the API: the failure is a fixed property of the endpoint, and
  // surfacing it as "Poly Pizza API 400: {…}" in the grid teaches nobody what
  // to do about it.
  assert.ok(/export const needsFilter =/.test(polypizza), "no needsFilter predicate");
  assert.ok(/export const FILTER_PROMPT =/.test(polypizza), "no explanatory message");
  assert.ok(
    /if \(!keyword && needsFilter\(\{[^}]*\}\)\) \{\s*throw new Error\(FILTER_PROMPT\);/.test(polypizza),
    "searchModels does not guard the filterless case",
  );
});

check("needsFilter is true only when nothing at all is set", () => {
  // Reimplemented from the source rather than imported: polypizza.js pulls in
  // assetLoader.js, which needs a browser. The predicate is four clauses; the
  // thing worth gating is that each one alone satisfies the API.
  const fn = polypizza.match(/export const needsFilter = [\s\S]*?;\n/)[0];
  for (const clause of ["query", "category", "license", "animated"]) {
    assert.ok(fn.includes(clause), `needsFilter ignores ${clause}`);
  }
  // `animated == null` (loose) so both null and undefined count as unset —
  // `!animated` would wrongly treat an explicit `false` as no filter.
  assert.ok(/animated == null/.test(fn), "animated must be checked for null, not falsiness");
});

check("the panel prompts instead of requesting when nothing is filtered", () => {
  const panel = read("src/editor/panels/PolyPizzaPanel.jsx");
  assert.ok(/const unfiltered = needsFilter\(filters\)/.test(panel), "panel does not detect it");
  assert.ok(/if \(!moduleOn \|\| !token \|\| unfiltered\)/.test(panel), "panel still fires the request");
  assert.ok(/\{unfiltered \? \(/.test(panel), "panel does not render the prompt");
  // The effect must re-run when the flag flips, or picking a category leaves
  // the prompt on screen forever.
  assert.ok(/\[moduleOn, token, filters, unfiltered\]/.test(panel), "unfiltered missing from deps");
});

check("the response mapping reads Poly Pizza's PascalCase field names", () => {
  // The API answers `ID`/`Title`/`Thumbnail`/`Download`/`Creator.Username`.
  // Reading camelCase produced a grid of "Untitled model" tiles over "3D"
  // placeholders — every field undefined, no error anywhere, because the
  // fallbacks made total failure look like a catalogue of unnamed models.
  const fn = polypizza.match(/const normalise = \(item\) => \{[\s\S]*?\n\};/)?.[0];
  assert.ok(fn, "normalise not found");
  for (const key of [
    "item.Title", "item.PublicID", "item.ResourceID", "item.Tris",
    "item.Animated", "item.Description", "item.Tags",
  ]) {
    assert.ok(fn.includes(key), `normalise never reads ${key}`);
  }
  assert.ok(/creator\.Username/.test(fn), "creator name is Creator.Username, not creator.name");
  // British spelling in the response, American in the request parameter.
  assert.ok(/item\.Licence/.test(fn), "the response field is `Licence`, not `License`");
  // `DPURL` is the creator's avatar image, not their profile page — linking to
  // it opens a jpg.
  assert.ok(!/creator\.DPURL/.test(fn), "DPURL is a display picture, not a profile URL");
});

check("thumbnail and download are derivable from ResourceID", () => {
  // Verified against the live CDN: `<ResourceID>.glb` and `<ResourceID>.jpg`.
  // The API's field names are not consistent across its endpoints, so the
  // derivation is what stops a missing `Thumbnail` becoming a grid of
  // placeholders again.
  const fn = polypizza.match(/const normalise = \(item\) => \{[\s\S]*?\n\};/)[0];
  assert.ok(/\$\{CDN\}\/\$\{resource\}\.jpg/.test(fn), "no thumbnail fallback");
  assert.ok(/\$\{CDN\}\/\$\{resource\}\.glb/.test(fn), "no model fallback");
  assert.ok(/const CDN = "https:\/\/static\.poly\.pizza"/.test(polypizza), "CDN host not pinned");
});

check("the two ids are kept apart", () => {
  // PublicID addresses the page and /model/{id}; ResourceID names the files.
  // Neither derives from the other, so conflating them breaks either linking
  // or downloading — silently, since both are opaque strings.
  const fn = polypizza.match(/const normalise = \(item\) => \{[\s\S]*?\n\};/)[0];
  assert.ok(/const id = first\(item\.PublicID/.test(fn), "id must come from PublicID");
  assert.ok(/const resource = first\(item\.ResourceID/.test(fn), "resource must come from ResourceID");
  assert.ok(/resourceId: resource/.test(fn), "resourceId is not carried on the record");
  assert.ok(/poly\.pizza\/m\/\$\{id\}/.test(fn), "the page link must use the public slug");
});

check("the mapping still accepts camelCase, since the wrapper is mixed", () => {
  // `results` came back lowercase while its contents are PascalCase, so there
  // is no single convention to commit to and both have to be read.
  const fn = polypizza.match(/const normalise = \(item\) => \{[\s\S]*?\n\};/)[0];
  for (const key of ["item.title", "item.thumbnail", "item.download", "item.id"]) {
    assert.ok(fn.includes(key), `normalise dropped the camelCase fallback for ${key}`);
  }
  assert.ok(/const first = \(\.\.\.values\)/.test(polypizza), "no `first` helper");
  // `??`-chaining would pick the wrong branch on a legitimately falsy value;
  // `first` must test for undefined/null explicitly.
  assert.ok(
    /value !== undefined && value !== null/.test(polypizza),
    "`first` must skip only undefined/null, or an Animated:false is treated as missing",
  );
});

check("the search envelope and a single-model fetch are both unwrapped", () => {
  assert.ok(/first\(data\?\.results, data\?\.Results\)/.test(polypizza), "envelope key not tolerant");
  const fn = polypizza.match(/export async function fetchModel[\s\S]*?\n\}/)[0];
  assert.ok(
    /Array\.isArray\(envelope\)/.test(fn),
    "fetchModel must handle a single-result envelope, or every field comes back undefined",
  );
});

check("an empty query uses the browse endpoint, not an empty keyword path", () => {
  // `/search/` with no keyword is a 404, so "no query" has to be a DIFFERENT
  // endpoint rather than an empty path segment. This is the bug that makes an
  // unsearched panel show nothing at all.
  assert.ok(
    /keyword\s*\n?\s*\?\s*`\/search\/\$\{encodeURIComponent\(keyword\)\}/.test(polypizza),
    "keyword path not built conditionally",
  );
  assert.ok(/:\s*`\/search\?\$\{params\}`/.test(polypizza), "no bare /search fallback for empty queries");
});

check("an unticked Animated box does not filter to static-only", () => {
  // The API's `animated` is tri-state (true / false / absent) but the toolbar
  // control is a checkbox, whose "off" means "don't care" — not "only static".
  // Storing the checkbox's own `false` sent `animated=false` and hid every
  // animated model from the default view, which is exactly backwards.
  const panel = read("src/editor/panels/PolyPizzaPanel.jsx");
  assert.ok(
    /animated: null \}\)/.test(panel),
    "the initial filter state must be null (no filter), not false",
  );
  assert.ok(
    /event\.target\.checked \? true : null/.test(panel),
    "unchecking must clear the filter rather than invert it",
  );
  // And the client must still be able to express all three, or the ops lose a
  // filter the API offers.
  assert.ok(/animated === true/.test(polypizza) && /animated === false/.test(polypizza),
    "the client should keep the tri-state the API accepts");
});

check("the key is sent as x-auth-token, not an Authorization scheme", () => {
  // Bearer/Token both 401 exactly like no key at all, so getting this wrong
  // reads as a bad credential rather than a bad request.
  const command = rust.match(/async fn fetch_polypizza_text[\s\S]*?\n\}/);
  assert.ok(command, "fetch_polypizza_text not found in lib.rs");
  assert.ok(command[0].includes('.set("x-auth-token", value)'), "wrong header name");
  assert.ok(!/Authorization/.test(command[0]), "must not use an Authorization scheme");
});

check("the proxy refuses hosts other than api.poly.pizza", () => {
  const command = rust.match(/async fn fetch_polypizza_text[\s\S]*?\n\}/)[0];
  assert.ok(
    command.includes('host_str() != Some("api.poly.pizza")'),
    "no host allowlist — the key could be sent to an arbitrary URL",
  );
  assert.ok(command.includes('scheme() != "https"'), "no https requirement");
});

check("fetch_polypizza_text is registered on the invoke handler", () => {
  // A command that exists but is not in the handler list fails at runtime with
  // "command not found", which reads like a missing feature, not a typo.
  assert.ok(/\n\s+fetch_polypizza_text,/.test(rust), "not in the invoke_handler list");
});

check("the download path does not require the key", () => {
  // Model binaries are on a public CDN; sending the credential there would be
  // both unnecessary and a leak to a host the allowlist does not cover.
  const download = polypizza.match(/async function proxyBytes[\s\S]*?\n\}/)[0];
  assert.ok(download.includes('invoke("fetch_bytes"'), "should reuse the generic byte fetch");
  assert.ok(!/token/i.test(download), "no credential belongs on the CDN fetch");
});

check("a credential entry exists so the key can actually be entered", () => {
  const providers = modulesPanel.match(/const CREDENTIAL_PROVIDERS = \{[\s\S]*?\n\};/)[0];
  assert.ok(/polypizza: \[/.test(providers), "no CREDENTIAL_PROVIDERS entry");
  assert.ok(providers.includes('import("../polypizza.js")'), "entry does not load the client");
  for (const fn of ["getSavedToken", "clearSavedToken", "validateAndSaveToken", "openApiKeyPage"]) {
    assert.ok(
      new RegExp(`export (async )?function ${fn}|export const ${fn}`).test(polypizza),
      `polypizza.js does not export ${fn}, which the credential UI calls`,
    );
  }
});

check("attribution is written for every import", () => {
  // Most of this catalogue is CC-BY. An import that drops the credit line is a
  // licence violation shipped into someone's game.
  assert.ok(/ATTRIBUTION\.md/.test(polypizza), "no ATTRIBUTION.md written");
  assert.ok(/attribution \? `Required credit:/.test(polypizza), "API credit string not preserved verbatim");
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — Fab specifics");
// ---------------------------------------------------------------------------

check("free means the LICENCE, never the starting price", () => {
  // `is_free=1` is the obvious-looking filter and it is a trap: it matches on
  // the STARTING price, so every $2.99 Quixel Megascan comes back "free"
  // because its UEFN-reference-only tier is $0. Filtering on `licenses=cc-by`
  // selects assets whose only licence is Creative Commons Attribution.
  assert.ok(/const FREE_LICENSE = "cc-by"/.test(fab), "no licence constant");
  assert.ok(/params\.set\("licenses", FREE_LICENSE\)/.test(fab), "the free filter is not the licence one");
  assert.ok(
    !/params\.set\("is_free"/.test(fab),
    "is_free matches a $0 starting tier, not a free asset — see the Megascans case",
  );
});

check("the import refuses anything that is not CC-BY", () => {
  // Fab's download-info endpoint answers anonymously for FREE assets. The
  // honest reading of that is "free assets are free", not "the paywall is
  // optional", and this guard is what writes that down.
  const fn = fab.match(/export async function downloadListing[\s\S]*?\n\}/)[0];
  assert.ok(/if \(!listing\?\.ccBy\)/.test(fn), "no licence guard before download");
  assert.ok(
    fn.indexOf("ccBy") < fn.indexOf("fetchDownloadUrl"),
    "the guard must run BEFORE any download URL is requested",
  );
  // And the UI must not offer it either, or the guard is discovered as an error.
  const panel = read("src/editor/panels/FabPanel.jsx");
  assert.ok(/disabled=\{!hasProject \|\| !model\.ccBy \|\|/.test(panel), "the button is enabled on paid listings");
});

check("there is no sort control, because sort_by does nothing", () => {
  // Measured 2026-08-22: `-createdAt`, `-popularity`, `-listingRating` and the
  // literal string `bogus` all return byte-identical orderings, which differ
  // from omitting the parameter. The value is ignored; only its presence
  // counts. A dropdown built on it would silently lie.
  // Comments stripped first: the panel explains WHY there is no sort, and the
  // explanation naturally names the parameter it is refusing to use.
  const code = read("src/editor/panels/FabPanel.jsx").replace(/\{?\/\*[\s\S]*?\*\/\}?|\/\/.*/g, "");
  assert.ok(!/sort/i.test(code), "the panel offers a sort it cannot honour");
  assert.ok(/sort_by/.test(fab), "the finding should be written down where the params are");
});

check("paging is the cursor URL, passed back verbatim", () => {
  // The cursor encodes the sort position of the last row and cannot be rebuilt
  // from the filters, so a "load more" that re-derives the query pages a
  // different search than the one on screen.
  assert.ok(/nextUrl/.test(fab), "no cursor parameter");
  assert.ok(/data\.next \?\? null/.test(fab), "the next URL is not carried out");
  const panel = read("src/editor/panels/FabPanel.jsx");
  assert.ok(/searchListings\(\{ nextUrl: next \}\)/.test(panel), "load-more must pass the cursor alone");
});

const extractor = fab.slice(
  fab.indexOf("export async function extractArchive"),
  fab.indexOf("export async function downloadListing"),
);
const fabDownload = fab.slice(fab.indexOf("export async function downloadListing"));

check("an archive is treated as a pack, not as one model", () => {
  // Fab's ZIPs routinely hold dozens of separate meshes — a tile set, a prop
  // kit. Importing only the first would silently drop most of what the listing
  // is, and previewing only the first shows you a floor tile.
  assert.ok(/export async function extractArchive/.test(fab), "no archive extractor");
  assert.ok(/glbEntries\.map/.test(extractor), "GLB entries are not all extracted");
  assert.ok(/for \(const entry of gltfEntries\)/.test(extractor), "glTF entries are not all packed");
  assert.ok(/fbxEntries\.map/.test(extractor), "FBX entries are not all extracted");
});

check("FBX is a first-class format, not a listed-but-unhandled one", () => {
  // A large share of Fab's free catalogue ships FBX and NOTHING else — the
  // first five CC-BY 3D listings all did. An extractor that only knew glTF made
  // every one of those unimportable while IMPORT_FORMATS still advertised FBX,
  // so the listing looked supported and failed at download time.
  assert.ok(/\{ id: "fbx"/.test(fab), "fbx is not offered");
  assert.ok(/format: "fbx"/.test(extractor), "the extractor cannot report an FBX archive");
  // FBX resolves textures by bare filename against its own directory, so the
  // loose images have to travel with the meshes or every model imports grey.
  assert.ok(/TEXTURE_RE/.test(extractor), "loose textures are not collected");
  assert.ok(/unpackFbx/.test(fabDownload), "the import never converts an FBX");
  assert.ok(
    fabDownload.indexOf("for (const [name, bytes] of textures)") <
      fabDownload.indexOf("const folder = archiveFormat ==="),
    "textures must be written BEFORE the meshes are unpacked",
  );
});

check("a download that is NOT a zip is still read", () => {
  // Fab zips an upload only when it holds more than one file: a listing whose
  // FBX upload was a single `ghoul_ue5.fbx` serves those bytes verbatim from
  // the same download-info URL that hands another listing a `.zip`. Without a
  // sniff that arrives as JSZip's "Can't find end of central directory : is
  // this a zip file ?", which names neither the listing nor the real problem.
  assert.ok(/function sniffBareModel/.test(fab), "no bare-file sniff");
  assert.ok(/sniffBareModel\(payload, name\)/.test(extractor), "the extractor never sniffs");
  const sniff = fab.match(/function sniffBareModel[\s\S]*?\n\}/)[0];
  assert.ok(/PK\\x03\\x04/.test(sniff), "a real zip is not recognised and would be misread as a mesh");
  assert.ok(/glTF/.test(sniff), "a bare GLB is not recognised");
  // Binary FBX has a magic string; ASCII FBX has none at all, so it is
  // recognised by the version line every writer emits.
  assert.ok(/Kaydara FBX Binary/.test(sniff), "a bare binary FBX is not recognised");
  assert.ok(/FBXVersion/.test(sniff), "a bare ASCII FBX is not recognised");
});

check("'any format' means any format WE can import", () => {
  // Omitting the parameter is the literal reading of the dropdown and a bad
  // default: measured, only 9 of 24 free 3D listings ship anything but an
  // Unreal `.uasset` build, so an unfiltered grid is mostly dead ends that look
  // identical to the usable ones until you click them.
  assert.ok(
    /for \(const code of format \? \[format\] : IMPORT_FORMAT_IDS\)/.test(fab),
    "an empty format filter does not fall back to the importable set",
  );
  // Repeated values OR together — a single `set` would send only the last one.
  assert.ok(/params\.append\("asset_formats", code\)/.test(fab), "formats must be appended, not set");
  const panel = read("src/editor/panels/FabPanel.jsx");
  assert.ok(/Any importable format/.test(panel), "the dropdown promises more than it delivers");
});

check("a listing with nothing importable says so instead of failing later", () => {
  const panel = read("src/editor/panels/FabPanel.jsx");
  assert.ok(/plan === false/.test(panel), "the panel cannot tell an unimportable listing apart");
  assert.ok(/only Unreal Engine files/.test(panel), "no explanation next to the button");
});

check("packed glTF resources are keyed the way packGlb looks them up", () => {
  // packGlb resolves by the DECODED uri. Storing the raw one misses on every
  // path containing a space, which asset packs are full of.
  assert.ok(/resources\.set\(decoded, bytes\)/.test(extractor), "resources keyed by the raw uri");
});

check("Fab falls back to reading the real archive when it has no viewer", () => {
  // Measured 2026-08-22: only about ONE FREE LISTING IN TEN publishes Fab's own
  // 3D viewer, so an embed-only preview would leave 90% of the catalogue as a
  // still image — which is the thing this whole change set out to fix.
  assert.ok(/export async function previewPlan/.test(fab), "no native preview plan");
  assert.ok(/export const PREVIEW_AUTO_LIMIT/.test(fab), "no size ceiling on the auto-download");
  const panel = read("src/editor/panels/FabPanel.jsx");
  assert.ok(/const native = !embed && plan/.test(panel), "the embed does not take precedence");
  // Archives run to hundreds of megabytes and the size is known before
  // committing to the bytes, so a large one must ASK rather than just download.
  assert.ok(/Load 3D preview/.test(panel), "a large archive offers no opt-in");
  assert.ok(/native\.size <= PREVIEW_AUTO_LIMIT/.test(panel), "the ceiling is not applied");
});

check("a pack preview shows the pack, and cleans up after the FBX parser", () => {
  // Every mesh laid out as a contact sheet, each scaled to its cell: at true
  // relative scale a pack containing a building and a doorknob shows a building
  // and no doorknob.
  assert.ok(/export async function loadArchivePreview/.test(previewSources), "no pack preview");
  const fn = previewSources.slice(previewSources.indexOf("export async function loadArchivePreview"));
  assert.ok(/PACK_LIMIT/.test(fn), "an unbounded pack would parse hundreds of meshes");
  // The FBX parser holds blob URLs for the whole pack (its textures are shared
  // and resolved asynchronously), so they outlive each parse and have to be
  // released by the caller rather than per-mesh.
  assert.ok(/parse\.dispose\?\.\(\)/.test(fn), "the parser's blob URLs are never released");
});

check("an FBX preview waits for its textures before the blob URLs are revoked", () => {
  // `FBXLoader.parse` returns SYNCHRONOUSLY while its textures keep loading
  // through the manager. Returning without waiting revokes the blob URLs out
  // from under them — which does not throw, it renders the model as a black
  // silhouette, because the materials hold textures that never arrived.
  const fn = previewSources.slice(previewSources.indexOf("async function fbxParser"));
  assert.ok(/manager\.onLoad = resolve/.test(fn), "nothing waits for the texture queue");
  // Guarded on onStart: a mesh with embedded or no textures never starts the
  // manager, and `onLoad` would then never fire — an unguarded await hangs.
  assert.ok(/if \(started\) await settled/.test(fn), "the wait is not guarded on the queue starting");
});

check("Fab needs no credential, anywhere", () => {
  // Every other browser here has one. Fab's read path and its free-asset
  // download URLs are anonymous, so a credential row would be a lie.
  for (const fn of ["getSavedToken", "validateAndSaveToken"]) {
    assert.ok(!new RegExp(`export (async )?function ${fn}|export const ${fn}`).test(fab), `fab.js exports ${fn}`);
  }
  const providers = modulesPanel.match(/const CREDENTIAL_PROVIDERS = \{[\s\S]*?\n\};/)[0];
  assert.ok(!/\bfab: \[/.test(providers), "fab must not have a credential row");
  assert.ok(
    /fab: \{ module: "fab", label: "Fab", types: \["model"\], needsKey: false \}/.test(libraryOps),
    "library.status must report fab as keyless",
  );
});

check("the Fab proxy keeps one client across requests, and retries a challenge", () => {
  // Fab is behind Cloudflare's managed challenge, and the measured way past it
  // is to look like ONE CLIENT rather than a new stranger per request: a shared
  // Agent (which carries the `__cf_bm` cookie and reuses the connection) went
  // 8/8 where one-shot requests went 6/8, and adding a retry took a 40-request
  // burst to 40/40. See src-tauri/tests/fab_cloudflare.rs.
  const command = rust.match(/async fn fetch_fab_text[\s\S]*?\n\}/)[0];
  assert.ok(/static FAB_AGENT/.test(rust), "no shared Agent — every call would be a new client");
  assert.ok(/fab_agent\(\)/.test(command), "the command does not use the shared Agent");
  assert.ok(/is_cf_challenge\(&body\)/.test(command), "a challenge is not detected");
  assert.ok(/continue;/.test(command), "a challenge is not retried");
});

check("a Cloudflare challenge never reaches the panel as HTML", () => {
  // The first version returned the body verbatim, which put ~30KB of Cloudflare
  // interstitial — CSS, base64 logo and all — into the panel's error box.
  const command = rust.match(/async fn fetch_fab_text[\s\S]*?\n\}/)[0];
  assert.ok(/bot protection is throttling/.test(command), "no human-readable message for a challenge");
  assert.ok(/chars\(\)\.take\(/.test(command), "a non-challenge error body is not truncated");
});

check("the Fab proxy sends an honest User-Agent, not a browser one", () => {
  // Counter-intuitive: Cloudflare fingerprints the TLS handshake, so claiming
  // to be Chrome from a rustls client is what its bot detection looks for.
  // Measured live from one IP: `three-engine/0.1` 200, Chrome 124 UA 403.
  // `fetch_itchio_html` DOES impersonate a browser — that is right for itch.io
  // and wrong here, so the difference has to stay deliberate.
  const command = rust.match(/async fn fetch_fab_text[\s\S]*?\n\}/)[0];
  assert.ok(/"User-Agent", "three-engine\/0\.1"/.test(command), "UA is not the honest one");
  assert.ok(!/Mozilla/.test(command), "a browser UA gets this client challenged, not served");
});

check("the proxy refuses hosts other than www.fab.com", () => {
  const command = rust.match(/async fn fetch_fab_text[\s\S]*?\n\}/);
  assert.ok(command, "fetch_fab_text not found in lib.rs");
  assert.ok(
    command[0].includes('host_str() != Some("www.fab.com")'),
    "no host allowlist — the proxy could fetch an arbitrary URL",
  );
  assert.ok(command[0].includes('scheme() != "https"'), "no https requirement");
  // There is no token to attach, and adding one later would need the allowlist
  // rethought — assert the absence so that stays a deliberate change.
  assert.ok(!/token/i.test(command[0]), "fetch_fab_text should carry no credential");
});

check("fetch_fab_text is registered on the invoke handler", () => {
  assert.ok(/\n\s+fetch_fab_text,/.test(rust), "not in the invoke_handler list");
});

check("a Cloudflare challenge is reported as one, not as a parse error", () => {
  // Fab sits behind Cloudflare, which answers a bot-challenge HTML page with a
  // 200 to some clients. A bare JSON.parse failure there reads as "Fab changed
  // its response shape", which sends you looking in entirely the wrong place.
  const fn = fab.match(/async function apiJson[\s\S]*?\n\}/)[0];
  assert.ok(/bot protection/.test(fn), "a non-JSON body is not explained");
});

check("attribution is written, and says the credit is mandatory", () => {
  // Unlike Poly Haven (CC0), EVERY importable asset here is CC-BY: the credit
  // line is the condition of use, not a courtesy.
  assert.ok(/ATTRIBUTION\.md/.test(fab), "no ATTRIBUTION.md written");
  assert.ok(/MUST credit/.test(fab), "the obligation is not stated");
});

check("fab has both a search and an import branch", () => {
  const branches = libraryOps.match(/if \(provider === "fab"\) \{/g) ?? [];
  assert.equal(branches.length, 2, `expected search + import branches, found ${branches.length}`);
});

check("the ops surface whether a found listing can actually be imported", () => {
  // Searching the paid catalogue is legitimate — you may want to link a human
  // at it — but an agent must be able to tell before it tries.
  assert.ok(/importable: listing\.ccBy/.test(libraryOps), "no importable flag on fab results");
  assert.ok(/freeOnly: \{/.test(libraryOps), "no freeOnly parameter");
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — Sketchfab's normalised shape");
// ---------------------------------------------------------------------------

check("the ops read the NORMALISED record, not Sketchfab's raw JSON", () => {
  // `searchModels` returns records its own `normalise` already flattened —
  // `id`/`author`/`license`, not `uid`/`user`/`license.label`. Reading the raw
  // shape handed back `id: undefined` for every result, and the import's
  // `m.uid === id` never matched, so it silently took models[0] — the first
  // result of a search for the id string, which is a different model.
  const search = libraryOps.slice(
    libraryOps.indexOf('if (provider === "sketchfab")'),
    libraryOps.indexOf('if (provider === "fab")'),
  );
  assert.ok(/id: model\.id/.test(search), "search maps `uid`, which normalise renamed");
  assert.ok(!/model\.user\?\./.test(search), "search reads `user`, which normalise flattened to `author`");
  const importBranch = libraryOps.slice(libraryOps.lastIndexOf('if (provider === "sketchfab")'));
  assert.ok(/m\.id === id/.test(importBranch), "import matches on `uid`, which never hits");
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — an agent can import AND use what it finds");
// ---------------------------------------------------------------------------

check("import returns the one file worth acting on, not just a pile", () => {
  // A GLB unpacks to a folder of .geom/.mat/textures plus a .prefab; a PBR set
  // is 4-7 images plus a .mat. Returning `paths` alone leaves the caller to
  // guess, and `paths[0]` is as likely to be a normal map as anything useful.
  assert.ok(/async function primaryAsset\(paths\)/.test(libraryOps), "no primary-asset resolution");
  assert.ok(/extensionOf\(path\) === "prefab"/.test(libraryOps), "prefab is not preferred");
  assert.ok(/extensionOf\(path\) === "mat"/.test(libraryOps), "material is not recognised");
  assert.ok(/\["hdr", "exr"\]\.includes/.test(libraryOps), "hdri is not recognised");
});

check("the prefab is FOUND, not constructed from the folder name", () => {
  // A name collision suffixes the FOLDER (`Big Tree 2/`) while the prefab keeps
  // the original stem (`Big Tree.prefab`), so `${folder}/${basename}.prefab`
  // silently misses on every re-import of the same model.
  assert.ok(/listProjectEntries\(folder, 2\)/.test(libraryOps), "folder is not listed");
  assert.ok(
    !/\$\{folder\}\/Model\.prefab|\$\{folder\}\/\$\{stem\}\.prefab/.test(libraryOps),
    "the prefab path must not be constructed by string-building",
  );
});

check("every provider branch goes through the shared finisher", () => {
  // A branch that returns its own ad-hoc object is a provider whose caller
  // silently loses `primary`, `next` and `instantiate`.
  const run = libraryOps.slice(libraryOps.indexOf('name: "library.import"'));
  const rawReturns = run.match(/return \{ paths: asPaths\(/g) ?? [];
  assert.equal(rawReturns.length, 0, `${rawReturns.length} provider branches bypass finish()`);
  const finishes = run.match(/return finish\(/g) ?? [];
  assert.ok(finishes.length >= 8, `expected every model/texture/hdri branch to finish(), found ${finishes.length}`);
});

check("each asset kind names the op that consumes it", () => {
  // The point of `next`: an agent that just imported an HDRI should not have to
  // know that the file alone lights nothing.
  assert.ok(/prefab\.instantiate/.test(libraryOps), "prefab has no follow-up op");
  assert.ok(/component\.setProp/.test(libraryOps), "material has no follow-up op");
  assert.ok(/scene\.setEnvironment/.test(libraryOps), "hdri has no follow-up op");
});

check("instantiate places the model and reports the entity", () => {
  assert.ok(/instantiate: \{/.test(libraryOps), "no instantiate parameter");
  assert.ok(/out\.entityId = entity\.id/.test(libraryOps), "the created entity is not reported");
  assert.ok(/instantiatePrefab\(primary, position, null\)/.test(libraryOps), "position is not honoured");
});

check("an instantiate that cannot apply says so rather than silently passing", () => {
  // Asking to spawn a texture is a caller mistake worth surfacing; returning a
  // success-looking result teaches the agent that it worked.
  assert.ok(/out\.instantiateSkipped/.test(libraryOps), "a skipped instantiate is silent");
});

check("every asset SOURCE tells an agent how to use what it imported", () => {
  // The rule this file enforces for models applies to the other two importers
  // too. The audio one is the sharpest case: a Sound component holds a LIST of
  // entries and the file lives on `entries[].audioAsset`, which no caller is
  // going to guess from a returned `path`.
  const audioOps = read("src/editor/api/ops/audio.js");
  assert.ok(/next:/.test(audioOps), "audio.library.import does not name a follow-up");
  assert.ok(/entries: \[\{ audioAsset:/.test(audioOps), "the sound entry shape is not spelled out");
  const fontOps = read("src/editor/api/ops/fonts.js");
  assert.ok(/next: "Use the family name/.test(fontOps), "font.import does not name a follow-up");
});

check("every asset browser module is reachable through an op family", () => {
  // The standing rule: a feature is not done until an agent can drive it.
  // library.* covers five providers; audio-library has its own family.
  const covered = { polyhaven: "library", ambientcg: "library", sketchfab: "library",
    polypizza: "library", fab: "library", itchio: "library", "audio-library": "audio.library" };
  for (const browser of BROWSERS) {
    assert.ok(covered[browser.module], `${browser.module} has no op family`);
  }
  const audioOps = read("src/editor/api/ops/audio.js");
  for (const op of ["audio.library.search", "audio.library.import", "audio.library.status"]) {
    assert.ok(audioOps.includes(op), `${op} is missing`);
  }
  for (const op of ["library.search", "library.import", "library.status"]) {
    assert.ok(libraryOps.includes(op), `${op} is missing`);
  }
});

check("itch.io is exempt, deliberately and in writing", () => {
  // Packs are archives of loose files, not one importable asset. The exemption
  // has to be stated or it reads as an oversight.
  const tail = libraryOps.slice(libraryOps.indexOf("itch.io packs are archives"));
  assert.ok(tail.startsWith("itch.io packs are archives"), "no rationale for itch.io having no primary");
});

// ---------------------------------------------------------------------------
console.log("\nlibrary — the interactive model preview");
// ---------------------------------------------------------------------------

const preview = read("src/editor/components/ModelPreview.jsx");

check("the preview renders the model, not the thumbnail", () => {
  const panel = read("src/editor/panels/PolyPizzaPanel.jsx");
  assert.ok(/<AssetPreview src=\{model\.downloadUrl\}/.test(panel), "detail pane shows no live model");
  // The thumbnail stays as the fallback for a record with no downloadable GLB,
  // now expressed by handing both to the dispatcher rather than by branching
  // in the panel.
  assert.ok(/thumbnailUrl=\{model\.thumbnailUrl\}/.test(panel), "no still fallback");
});

check("it is capped and skipped when invisible, like every other preview", () => {
  // An uncapped second swapchain presenting at 120Hz serialises against the
  // viewport's present and reads as viewport frame drops — see previewLoop.js.
  assert.ok(
    /renderer\.setAnimationLoop\(throttlePreviewFrame\(canvas,/.test(preview),
    "the preview loop is not throttled",
  );
});

check("everything the GLB allocated is freed when the model changes", () => {
  // A browser panel loads a new model on every click. three frees none of this
  // for you, so "does not dispose" becomes hundreds of megabytes in a session.
  assert.ok(/function disposeScene\(root\)/.test(preview), "no scene disposal");
  for (const call of ["geometry?.dispose", "material.dispose", "texture.dispose"]) {
    assert.ok(preview.includes(call), `disposeScene never calls ${call}`);
  }
  assert.ok(/renderer\?\.dispose\(\)/.test(preview), "renderer is never disposed");
  // Textures are shared between materials, so they are collected before being
  // disposed rather than disposed per-material.
  assert.ok(/const textures = new Set\(\)/.test(preview), "textures must be deduped before disposal");
});

check("an in-flight load that resolves after unmount disposes itself", () => {
  // The load is async and the user can click away mid-download. Without this
  // the GLB is parsed onto the GPU and then orphaned with nothing holding it.
  assert.ok(
    /if \(disposed\) \{\s*disposeScene\(gltf\.scene\);/.test(preview),
    "a late load leaks its whole scene",
  );
});

check("switching clips does not re-download the model", () => {
  // Routing the clip through the loading effect would re-fetch the GLB on
  // every change of the dropdown — the effect's dep list is what prevents it.
  assert.ok(/const playRef = useRef\(null\)/.test(preview), "no mixer escape hatch");
  assert.ok(/\}, \[clipIndex\]\);/.test(preview), "clip changes are not their own effect");
  assert.ok(/\}, \[src\]\);/.test(preview), "the load effect must depend on src alone");
});

check("the camera is framed from the model's own size", () => {
  // A fixed near/far pair z-fights on a 200-metre model and clips a
  // 2-centimetre one, and this catalogue contains both.
  assert.ok(/camera\.near = radius \/ 100/.test(preview), "near plane is not derived from bounds");
  assert.ok(/camera\.far = radius \* 40/.test(preview), "far plane is not derived from bounds");
});

check("dragging takes over from the idle spin, and pitch cannot gimbal-lock", () => {
  assert.ok(/if \(!view\.touched\) view\.yaw \+= dt \* IDLE_SPIN/.test(preview), "no idle turntable");
  assert.ok(/viewRef\.current\.touched = true/.test(preview), "dragging never stops the spin");
  assert.ok(/MAX_PITCH = Math\.PI \/ 2 - 0\.05/.test(preview), "pitch reaches the pole and gimbal-locks");
  assert.ok(/Math\.max\(-MAX_PITCH, Math\.min\(MAX_PITCH/.test(preview), "pitch is not clamped");
});

check("camera state lives in a ref, not in React state", () => {
  // A drag produces a pointermove per frame; re-rendering React at that rate
  // to move a camera costs more than the frame it drives.
  assert.ok(/const viewRef = useRef\(\{ yaw:/.test(preview), "view state is not a ref");
  assert.ok(!/setYaw|setPitch|setZoom/.test(preview), "camera state must not go through useState");
});

check("the clip selector only appears when there is a choice", () => {
  assert.ok(/clips\.length > 1 && \(/.test(preview), "a one-clip model should not get a dropdown");
  assert.ok(/clips\.length === 1 &&/.test(preview), "a single clip should still be named");
});


// ---------------------------------------------------------------------------
console.log("\nlibrary — every browser previews what it is about to import");
// ---------------------------------------------------------------------------

const assetPreview = read("src/editor/components/AssetPreview.jsx");

check("the preview dispatcher prefers our renderer, then an embed, then a still", () => {
  // Order is load-bearing and runs DOWNWARD only: a provider that hands us a
  // loadable model gets the native path even if it also publishes an embed,
  // because ours honours the editor theme and does not put a third-party page
  // inside the editor.
  // Sliced to end-of-file rather than matched: the destructured parameter
  // list closes with its own `\n})`, so a lazy match stops at the signature.
  const fn = assetPreview.slice(assetPreview.indexOf("export function AssetPreview("));
  const native = fn.indexOf("if (src && failed !== src)");
  const embed = fn.indexOf("if (embedUrl)");
  const still = fn.indexOf("if (thumbnailUrl)");
  assert.ok(native >= 0 && embed > native && still > embed, "the fallback chain is out of order");
});

check("every model browser shows something interactive, not a still", () => {
  // The rule: a thumbnail cannot answer "what am I about to import". Each
  // browser reaches it differently — see AssetPreview for which and why — but
  // none of them may stop at the <img>.
  for (const [panel, prop] of [
    ["PolyPizzaPanel", "src="],
    ["PolyHavenPanel", "src="],
    ["AmbientCGPanel", "src="],
    ["SketchfabPanel", "embedUrl="],
    ["FabPanel", "embedUrl="],
  ]) {
    const source = read(`src/editor/panels/${panel}.jsx`);
    assert.ok(/<AssetPreview/.test(source), `${panel} does not use the shared preview`);
    assert.ok(source.includes(prop), `${panel} passes no ${prop.replace("=", "")}`);
  }
});

check("the two embed browsers are the two that cannot load geometry cheaply", () => {
  // Not a style choice: Sketchfab needs a token AND a multi-megabyte zip
  // before anything renders, and Fab's preview geometry is an Epic-proprietary
  // `.binz` its own WASM decoder reads. The rationale has to survive, or the
  // next person "fixes" it into a native loader that cannot work.
  assert.ok(/binz/.test(assetPreview) || /binz/.test(fab), "Fab's format constraint is not recorded");
  assert.ok(/embedUrl/.test(read("src/editor/sketchfab.js")), "sketchfab.js carries no embed URL");
});

check("the embed frame is sandboxed to what a WebGL viewer needs", () => {
  // `allow-same-origin` keeps the frame on ITS origin, which is what stops it
  // reaching into the editor — it does not grant it ours. Forms, popups,
  // downloads and top-level navigation stay withheld.
  const sandbox = assetPreview.match(/sandbox="([^"]*)"/)?.[1];
  assert.ok(sandbox, "the iframe is not sandboxed at all");
  assert.deepEqual(sandbox.split(" ").sort(), ["allow-same-origin", "allow-scripts"], `sandbox is "${sandbox}"`);
});

check("a cross-origin embed cannot hang on its spinner forever", () => {
  // `onError` does not fire for an HTTP error inside a cross-origin frame and
  // its content is unreadable, so `onLoad` alone can never clear.
  assert.ok(/setTimeout\(\(\) => setLoaded\(true\)/.test(assetPreview), "no timeout escape for the load state");
});

check("Poly Haven's preview remaps its resources, because the CDN moves them", () => {
  // Its .gltf refers to `textures/Foo_diff_1k.jpg` and `Foo.bin`, which the CDN
  // serves from `Models/jpg/1k/…` and — even for a 1k mesh — `Models/gltf/4k/…`.
  // A loader pointed at the .gltf URL 404s on every single resource.
  assert.ok(/export function modelPreviewPlan/.test(polyhaven), "no preview plan export");
  assert.ok(/entry\.include/.test(polyhaven.match(/export function modelPreviewPlan[\s\S]*?\n\}/)[0]),
    "the plan drops the include table, which is the whole point");
  assert.ok(/setURLModifier/.test(previewSources), "nothing remaps the resource URLs");
  assert.ok(/createGltfLoader\(manager\)/.test(previewSources), "the manager never reaches the loader");
  assert.ok(/createGltfLoader\(manager = undefined\)/.test(read("src/engine/gltfLoader.js")),
    "createGltfLoader does not accept a manager");
});

check("Poly Haven previews the SMALLEST glTF, not the download resolution", () => {
  // This replaces a thumbnail. Pulling 4k textures to fill a 260px pane costs
  // more than the import it is meant to help you decide on.
  const panel = read("src/editor/panels/PolyHavenPanel.jsx");
  assert.ok(/modelPreviewPlan\(files, resolutions\[0\]/.test(panel), "preview follows the download resolution");
});

check("ambientCG builds its OBJ preview in memory and leaks no blob URLs", () => {
  // The one catalogue here that is not glTF at all: OBJ + MTL + loose maps in
  // a ZIP, with no preview mesh and no per-file URLs, so a preview costs a real
  // download and must take the smallest variant.
  assert.ok(/export const PREVIEW_MODEL_RES = \["LQ-1K-JPG"/.test(ambientcg), "no smallest-variant preference");
  assert.ok(/export function modelPreviewUrl/.test(ambientcg), "no preview archive resolver");
  assert.ok(/export async function loadObjArchivePreview/.test(previewSources), "no OBJ preview loader");
  const fn = previewSources.match(/export async function loadObjArchivePreview[\s\S]*?\n\}\n/)[0];
  assert.ok(/revokeObjectURL/.test(fn), "blob URLs are never revoked");
  assert.ok(/finally \{/.test(fn), "a failed texture load would leak every URL created before it");
  // MTLLoader resolves textures through the manager asynchronously, which would
  // race those revocations; the filenames already say what each map is.
  assert.ok(!/MTLLoader/.test(fn), "MTLLoader races the revocations — load maps by name instead");
});

check("an unreadable model falls back to the still, not to an error string", () => {
  // Some sources genuinely cannot be loaded: three's FBXLoader rejects FBX
  // variants whose LayerElementNormal ships no Normals array, and Fab's free
  // catalogue contains them. A thumbnail still answers "what is this", which an
  // exception parked where the asset should be does not.
  assert.ok(/onError/.test(preview), "ModelPreview reports a failed load to nobody");
  assert.ok(/onErrorRef/.test(preview), "the callback must be held in a ref, like `load`");
  assert.ok(/const \[failed, setFailed\] = useState\(null\)/.test(assetPreview), "no failure state");
  assert.ok(/failed !== src/.test(assetPreview), "a failed source is retried forever");
  // Reset on a new source, or one bad model poisons the pane for every
  // selection after it.
  assert.ok(/useEffect\(\(\) => setFailed\(null\), \[src, embedUrl\]\)/.test(assetPreview),
    "the failure state is never cleared");
});

check("a custom loader does not re-download on every render", () => {
  // `load` is an inline arrow in every caller, so a new identity arrives each
  // render. Depending on it would re-fetch the model whenever the panel
  // re-rendered — and for ambientCG that is a multi-megabyte ZIP.
  assert.ok(/const loadRef = useRef\(load\)/.test(preview), "load is not held in a ref");
  assert.ok(/\}, \[src\]\);/.test(preview), "the load effect must still depend on src alone");
});

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
