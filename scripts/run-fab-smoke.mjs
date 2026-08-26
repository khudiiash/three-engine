/**
 * Fab, against the live API.
 *
 *   node scripts/run-fab-smoke.mjs
 *
 * `run-library-test.mjs` gates the SHAPE of this integration offline — that the
 * panel is registered, that the licence guard exists, that the resource keys
 * match what `packGlb` looks up. It cannot gate the part that actually broke
 * things for every other browser in this project: an API whose real responses
 * do not match what its docs, its site bundle, or a community client claim.
 *
 * So this one talks to fab.com. It is NOT in the default test run — it needs
 * network and it downloads a few megabytes — but it is the thing to run when
 * the Fab panel misbehaves, because it separates "our code is wrong" from
 * "Fab changed" in about fifteen seconds.
 *
 * ## Why curl and not fetch
 *
 * Fab is behind Cloudflare, and the challenge is fingerprint-based, not
 * User-Agent based: Node's own `fetch` (undici) is served a 403 bot-challenge
 * page for the exact request that `curl` gets a 200 for. The editor does not
 * go through either — it goes through Rust's `ureq`, which is not challenged.
 * curl with `ureq`'s User-Agent is the closest thing to the real client that
 * can be driven from a script, so that is what this uses. A 403 here is
 * therefore worth believing; a 403 from `fetch` would not have been.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extractArchive, pickImportFormat } from "../src/editor/fab.js";

const API = "https://www.fab.com/i";
/** Exactly what `fetch_fab_text` sends. */
const UA = "three-engine/0.1";

let failures = 0;
let checks = 0;
const check = async (name, fn) => {
  checks++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${String(error.message).split("\n")[0]}`);
  }
};

/**
 * A cookie jar, because the shipped client has one.
 *
 * `fetch_fab_text` holds a process-wide `ureq::Agent`, which carries
 * Cloudflare's `__cf_bm` cookie between requests — that is precisely what stops
 * a burst being challenged. A smoke that fired cookie-less one-shot requests
 * would be a strictly worse client than the thing it is testing, and would flake
 * on its own rate limit while reporting it as a Fab outage.
 */
const JAR = path.join(os.tmpdir(), "fab-smoke-cookies.txt");

const isChallenge = (text) => text.includes("cf_challenge") || text.includes("challenge-platform");

const curl = (url, binary = false) =>
  execFileSync("curl", ["-sL", "-b", JAR, "-c", JAR, "-H", `User-Agent: ${UA}`, url], {
    maxBuffer: 256 * 1024 * 1024,
    encoding: binary ? "buffer" : "utf8",
  });

/** Same three-attempt policy as `fetch_fab_text`, for the same reason. */
const json = (relative) => {
  const url = relative.startsWith("http") ? relative : `${API}${relative}`;
  let text = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) execFileSync("curl", ["-s", "-o", "-", "--max-time", "1", "https://www.fab.com/robots.txt"], { encoding: "utf8" });
    text = curl(url);
    if (!isChallenge(text)) break;
  }
  assert.ok(
    text.trim().startsWith("{") || text.trim().startsWith("["),
    isChallenge(text)
      ? "Cloudflare challenged every attempt — this IP is rate-limited right now, not broken"
      : `not JSON: ${text.slice(0, 120)}`,
  );
  return JSON.parse(text);
};

console.log("\nfab — the public read API answers an anonymous caller");

const free = json(`/listings/search?listing_types=3d-model&licenses=cc-by&asset_formats=glb&currency=USD`);

await check("search returns results with no credential at all", () => {
  assert.ok(Array.isArray(free.results), "no results array");
  assert.ok(free.results.length > 0, "empty result set");
});

await check("licenses=cc-by really selects free assets", () => {
  // This is the check the whole module rests on. `is_free=1` would pass a
  // weaker version of it — see below — so this asserts the strong property:
  // every returned listing is free AND its licence says so.
  const paid = free.results.filter((r) => !r.isFree || (r.startingPrice?.price ?? 0) > 0);
  assert.equal(paid.length, 0, `${paid.length} non-free listings, e.g. "${paid[0]?.title}"`);
  const notCc = free.results.filter((r) => !(r.licenses ?? []).some((l) => l.isCc0 || /cc.?by/i.test(l.name)));
  assert.equal(notCc.length, 0, `${notCc.length} listings without a CC licence`);
});

await check("is_free=1 is the trap it is documented to be", () => {
  // Pinning the reason `FREE_LICENSE` exists. `is_free` matches on the STARTING
  // price, so a listing whose $0 tier is UEFN-reference-only comes back "free"
  // while the tier that lets you use the mesh costs money. If Fab ever fixes
  // this, this check fails and the simpler filter becomes available.
  const loose = json(`/listings/search?listing_types=3d-model&is_free=1&currency=USD`);
  const misleading = loose.results.filter(
    (r) => (r.licenses ?? []).some((l) => (l.priceTier ?? "").match(/_USD_(\d+)_/)?.[1] > 0),
  );
  assert.ok(
    misleading.length > 0,
    "is_free no longer admits part-paid listings — FREE_LICENSE's rationale may be stale",
  );
});

await check("sort_by's VALUE is ignored; only its presence counts", () => {
  // The reason the panel offers no sort control. If this ever starts failing,
  // Fab has implemented sorting and a dropdown becomes worth adding.
  const base = `/listings/search?listing_types=3d-model&licenses=cc-by`;
  const ids = (data) => data.results.map((r) => r.uid).join(",");
  const newest = ids(json(`${base}&sort_by=-createdAt`));
  const oldest = ids(json(`${base}&sort_by=createdAt`));
  const nonsense = ids(json(`${base}&sort_by=bogus`));
  assert.equal(newest, oldest, "sort direction is now honoured — offer a sort control");
  assert.equal(newest, nonsense, "an invalid sort value is now rejected — validate before sending");
});

console.log("\nfab — a listing carries what the detail pane needs");

const listing = free.results[0];
const detail = json(`/listings/${listing.uid}`);

await check("the detail document carries a description and its media list", () => {
  assert.ok(typeof detail.description === "string", "no description");
  assert.ok(Array.isArray(detail.medias), "no medias array — the preview would have nothing to show");
});

await check("some free listing publishes an embeddable 3D preview", () => {
  // Not every listing has one, so this samples rather than demanding it of the
  // first: the property being gated is that the `type: "model"` media exists at
  // all and still points at the embeddable viewer path.
  const found = free.results.slice(0, 6).map((r) => json(`/listings/${r.uid}`))
    .flatMap((d) => d.medias ?? [])
    .find((m) => m.type === "model" && m.mediaUrl);
  assert.ok(found, "no listing in the first six had a model preview");
  assert.match(found.mediaUrl, /^https:\/\/www\.fab\.com\/dope\//, `preview moved: ${found.mediaUrl}`);
});

await check("the preview viewer page is still embeddable", () => {
  // An X-Frame-Options of DENY/SAMEORIGIN here would silently blank the preview
  // pane — an iframe that refuses to load reports nothing to its parent.
  const embed = (detail.medias ?? []).find((m) => m.type === "model")?.mediaUrl
    ?? "https://www.fab.com/dope/a5f0aff6-cb4a-4c36-81db-af7150f99b1b";
  const headers = execFileSync("curl", ["-sI", "-H", `User-Agent: ${UA}`, embed], { encoding: "utf8" });
  const xfo = headers.match(/^x-frame-options:(.*)$/im)?.[1]?.trim() ?? "";
  assert.equal(xfo, "", `x-frame-options is now "${xfo}" — the embed would be blocked`);
});

console.log("\nfab — the download path, end to end");

const formats = json(`/listings/${listing.uid}/asset-formats`).map((entry) => ({
  code: entry.assetFormatType?.code,
  label: entry.assetFormatType?.name,
  files: entry.files ?? [],
}));

await check("asset-formats lists importable formats with file ids", () => {
  assert.ok(formats.length > 0, "no formats");
  const importable = pickImportFormat(formats);
  assert.ok(importable, `nothing importable in: ${formats.map((f) => f.code).join(", ")}`);
  assert.ok(importable.files[0]?.uid, "the chosen format lists no file uid");
});

const chosen = pickImportFormat(formats);
const info = json(
  `/listings/${listing.uid}/asset-formats/${chosen.code}/files/${chosen.files[0].uid}/download-info`,
);

await check("download-info hands an anonymous caller a signed URL", () => {
  const url = info.downloadInfo?.[0]?.downloadUrl;
  assert.ok(url, `no downloadUrl in ${JSON.stringify(info).slice(0, 200)}`);
  assert.match(url, /^https:\/\//, "not an absolute URL");
  // Short-lived, which is why fab.js fetches it immediately before the download
  // rather than caching it with the listing.
  assert.ok(info.downloadInfo[0].expires, "no expiry — the caching assumption may be wrong");
});

await check("the archive extracts to at least one real GLB", async () => {
  // The riskiest new code: Fab archives are usually PACKS, and the glTF branch
  // has to resolve resources that sit outside the mesh's own folder.
  const bytes = curl(info.downloadInfo[0].downloadUrl, true);
  const { format, models } = await extractArchive(new Uint8Array(bytes));
  assert.ok(models.length > 0, "no models extracted");
  if (format === "fbx") {
    // FBX cannot be validated by magic here — it is not a container we parse
    // in node — so the gate is that the extractor recognised the format at all.
    console.log(`       (${models.length} FBX mesh(es) from "${listing.title}")`);
    return;
  }
  for (const model of models.slice(0, 5)) {
    const magic = new DataView(model.bytes.buffer, model.bytes.byteOffset).getUint32(0, true);
    assert.equal(magic, 0x46546c67, `"${model.name}" is not a GLB (magic ${magic.toString(16)})`);
  }
  console.log(`       (${models.length} mesh${models.length === 1 ? "" : "es"} from "${listing.title}")`);
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
