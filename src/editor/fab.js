/**
 * Fab (fab.com) read API client and free-asset importer.
 *
 * Fab is Epic's marketplace — the merger of the Unreal Engine Marketplace, the
 * Sketchfab store and Quixel Megascans. Most of it is paid, but the slice this
 * browser exists for is the CC-BY catalogue: assets the publisher released
 * under Creative Commons Attribution, free to anyone, and a large fraction of
 * them shipping glTF/GLB alongside the Unreal build.
 *
 * ## Four facts that are not guessable
 *
 * 1. **The whole read path is anonymous.** Search, listing detail, the
 *    asset-format list AND the signed download URL are all served without a
 *    credential (verified live). That makes this the only browser here with no
 *    API key at all — no `getSavedToken`, no Modules-panel credential row.
 *    Fab's own *library* endpoints (`/i/users/me/…`, `add-to-library`) do need
 *    an Epic session, but nothing in this file touches them: a CC-BY asset is
 *    downloadable without ever being "acquired".
 *
 * 2. **`licenses=cc-by` is the only honest free filter.** `is_free=1` looks
 *    like the right one and is a trap: it matches on the *starting* price, so
 *    every Quixel Megascan comes back "free" because its UEFN-reference-only
 *    tier is $0 while the tier that actually lets you use the mesh is $2.99.
 *    Filtering on the licence instead selects assets whose ONLY licence is
 *    CC-BY — free for any use, credit required. See {@link FREE_LICENSE}.
 *
 * 3. **`sort_by`'s VALUE is ignored.** Measured 2026-08-22: `-createdAt`,
 *    `-popularity`, `-listingRating` and the literal string `bogus` all return
 *    byte-identical result orders, which differ from omitting the parameter
 *    entirely. So the parameter is a boolean in disguise, and a sort dropdown
 *    built on it would silently lie to the user. There isn't one.
 *
 * 4. **A "model" is usually a PACK.** Fab's glb/gltf archives routinely hold
 *    dozens of separate meshes (a tile set, a prop kit), not one. The import
 *    therefore unpacks every mesh in the archive into one folder of prefabs
 *    rather than pretending the listing is a single object.
 *
 * Downloads land in the project's `Fab/` folder with an ATTRIBUTION.md beside
 * them. That is not decoration: CC-BY *requires* the credit line, and this is
 * the only catalogue here where every single asset carries that obligation.
 */
import JSZip from "jszip";
import { packGlb } from "./polyhaven.js";
import { writeBinaryFile } from "./assetLoader.js";

const API = "https://www.fab.com/i";

/**
 * The licence slug that means "free for anyone, credit required".
 *
 * Fab's licence facet takes slugs, and it is genuinely a filter rather than an
 * ignored parameter — an unknown value returns ZERO results rather than an
 * unfiltered page, which is the good failure mode (`licenses=cc-by-4.0` and
 * `licenses=cc0` are both empty; only `cc-by` matches). Listings it selects
 * come back with `isFree: true` and `licenses[].isCc0: true`.
 */
export const FREE_LICENSE = "cc-by";

/**
 * Listing types worth offering, in the order the panel shows them.
 *
 * Fab's taxonomy has a dozen more (audio, game templates, tools & plugins,
 * VFX…) that this engine cannot import from a Fab archive, so the dropdown is
 * a curated subset rather than a mirror of `/i/taxonomy/listing-types`. The
 * codes are theirs and are what the `listing_types` parameter takes.
 */
export const LISTING_TYPES = [
  { id: "3d-model", label: "3D models" },
  { id: "environment", label: "Environments" },
  { id: "material", label: "Materials" },
  { id: "decal", label: "Decals" },
  { id: "smart-asset", label: "Smart assets" },
];

/**
 * Formats this engine can actually consume, best first.
 *
 * Order is load-bearing twice over: it is the dropdown's order AND the
 * preference order {@link pickImportFormat} walks when choosing what to
 * download. GLB before GLTF because a GLB archive needs no resource rewriting;
 * FBX last because it goes through a heavier import path.
 */
export const IMPORT_FORMATS = [
  { id: "glb", label: "GLB" },
  { id: "gltf", label: "glTF" },
  { id: "fbx", label: "FBX" },
];

const IMPORT_FORMAT_IDS = IMPORT_FORMATS.map((format) => format.id);

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

/**
 * Every JSON request goes through the Rust proxy — not for a credential (there
 * isn't one) but because fab.com sends no `Access-Control-Allow-Origin`, so a
 * webview `fetch` is blocked despite the data being public.
 *
 * A non-JSON body is reported as such. Fab is behind Cloudflare, and the one
 * way this can fail that is NOT an API error is a bot-challenge HTML page
 * arriving with a 200 — which as a bare `JSON.parse` failure would read as
 * "Fab changed its response shape".
 */
async function apiJson(path) {
  const text = await invoke("fetch_fab_text", { url: `${API}${path}` });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "Fab returned a page instead of data — its bot protection is challenging this client.",
    );
  }
}

/** Largest thumbnail at or below `target`, falling back to the largest there is. */
const pickImage = (images = [], target = 512) => {
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.filter((image) => (image.width ?? 0) <= target).at(-1) ?? sorted.at(-1))?.url ?? null;
};

/**
 * The interactive preview Fab renders on its own listing pages.
 *
 * `medias[]` carries a `type: "model"` entry whose `mediaUrl` is an embeddable
 * viewer page (`www.fab.com/dope/<uid>`). It is used as an iframe rather than
 * loaded natively because the geometry behind it is NOT glTF: the viewer
 * fetches `model_file.binz`, an Epic-proprietary container (magic `UG\x85\x8b`)
 * that only its own WASM decoder reads. Downloading the real archive just to
 * spin a thumbnail would cost megabytes per click.
 *
 * Verified embeddable: the page answers with an EMPTY `x-frame-options` header
 * and only a report-only CSP, so no frame-ancestors rule blocks it.
 */
const previewEmbed = (medias = []) =>
  medias.find((media) => media.type === "model" && media.mediaUrl)?.mediaUrl ?? null;

/**
 * One listing, in the shape the panel and the MCP ops both read.
 *
 * Search results and the detail endpoint answer slightly different documents —
 * `thumbnails` on one, `medias` on the other, `licenses[].priceTier` a string
 * in the list and an object in the detail — so both are read here and the
 * detail merely enriches what search already returned.
 */
const normalise = (item) => {
  const licenses = item.licenses ?? [];
  const thumbnails = item.thumbnails ?? [];
  const medias = item.medias ?? [];
  return {
    id: item.uid,
    name: item.title || "Untitled listing",
    description: item.description ?? "",
    author: item.user?.sellerName ?? "Unknown creator",
    authorUrl: item.user?.sellerName
      ? `https://www.fab.com/sellers/${encodeURIComponent(item.user.sellerName)}`
      : null,
    sourceUrl: `https://www.fab.com/listings/${item.uid}`,
    listingType: item.listingType ?? null,
    category: item.category?.name ?? null,
    // `isFree` is the listing's own flag and is NOT the same question as
    // "costs nothing to use" — see FREE_LICENSE. Both are carried so the panel
    // can show the licence rather than infer it from a price.
    free: !!item.isFree,
    price: item.startingPrice?.price ?? null,
    license: licenses.map((license) => license.name).join(" / ") || "License not specified",
    // The one that decides whether a download button is honest to show.
    ccBy: licenses.some((license) => license.isCc0 || /cc.?by/i.test(license.name ?? "")),
    thumbnailUrl: pickImage(thumbnails[0]?.images ?? medias.find((m) => m.type === "image")?.images),
    previewUrl: previewEmbed(medias),
    formats: (item.assetFormats ?? [])
      .map((format) => format.assetFormatType?.code)
      .filter(Boolean),
    rating: item.ratings?.averageRating ?? item.averageRating ?? 0,
    reviews: item.reviewCount ?? 0,
    tags: (item.tags ?? []).map((tag) => tag.name).filter(Boolean),
    publishedAt: item.publishedAt ?? null,
  };
};

/**
 * Search the catalogue.
 *
 * Paging is CURSOR-based, not page-numbered: the response carries a `next`
 * absolute URL, and there is no total. So the panel can say "load more" but
 * never "24 of 812" — unlike Poly Pizza, the end is discovered by walking into
 * it. `nextUrl` is passed back verbatim rather than rebuilt, because the cursor
 * encodes the sort position of the last row and cannot be reconstructed from
 * the filters.
 */
export async function searchListings({
  query = "",
  listingType = "3d-model",
  format = "",
  freeOnly = true,
  nextUrl = null,
} = {}) {
  let path;
  if (nextUrl) {
    // The cursor URL is absolute and already carries every filter; strip the
    // origin so it goes through the same proxy path as everything else.
    path = nextUrl.replace(/^https:\/\/www\.fab\.com\/i/, "");
  } else {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (listingType) params.set("listing_types", listingType);
    // "Any format" means any format THIS ENGINE CAN IMPORT, not any format Fab
    // has. Omitting the parameter is the literal reading and it is a bad
    // default: measured, only 9 of 24 free 3D listings ship anything but an
    // Unreal `.uasset` build, so an unfiltered grid is mostly dead ends that
    // look identical to the usable ones until you click them.
    //
    // Repeated values OR together (verified: all three together return 24/24
    // importable), so the filter is a set rather than a single choice.
    for (const code of format ? [format] : IMPORT_FORMAT_IDS) {
      params.append("asset_formats", code);
    }
    // The licence filter, NOT `is_free`. `is_free=1` matches a $0 *starting*
    // tier, which is how every $2.99 Quixel Megascan comes back "free".
    if (freeOnly) params.set("licenses", FREE_LICENSE);
    // Prices are shown in the caller's local currency otherwise, which makes
    // "is this actually free" harder to read, not easier.
    params.set("currency", "USD");
    path = `/listings/search?${params}`;
  }
  const data = await apiJson(path);
  return {
    listings: (data.results ?? []).map(normalise),
    // Absolute URL, handed straight back to the next call.
    next: data.next ?? null,
  };
}

/**
 * One listing by id, with the fields search does not return.
 *
 * The detail document is where `description` and `medias` live — and `medias`
 * is where the interactive preview is, so a record that never passes through
 * here has a thumbnail and nothing else.
 */
export async function fetchListing(id) {
  const data = await apiJson(`/listings/${encodeURIComponent(id)}`);
  return normalise({ ...data, uid: data.uid ?? id });
}

/**
 * Every downloadable format on a listing, with its file ids.
 *
 * A file id cannot be derived from the listing id — it is a separate uuid per
 * uploaded archive — so this call is mandatory before any download, even when
 * the search result already told us the format exists.
 */
export async function fetchAssetFormats(id) {
  const data = await apiJson(`/listings/${encodeURIComponent(id)}/asset-formats`);
  return (Array.isArray(data) ? data : (data.results ?? [])).map((entry) => ({
    code: entry.assetFormatType?.code ?? null,
    label: entry.assetFormatType?.name ?? entry.assetFormatType?.code ?? "Unknown",
    extensions: entry.assetFormatType?.extensions ?? [],
    files: (entry.files ?? []).map((file) => ({
      uid: file.uid,
      name: file.name ?? "",
      size: file.fileSize ?? file.size ?? 0,
    })),
  })).filter((entry) => entry.code && entry.files.length > 0);
}

/**
 * The best format to import, given what the listing actually ships.
 *
 * Preference order is {@link IMPORT_FORMATS} — GLB, then glTF, then FBX. A
 * listing whose only format is `unreal-engine` or `uefn` has nothing this
 * engine can read, and saying so beats downloading a `.uasset` archive to find
 * out.
 */
export function pickImportFormat(formats, preferred = "") {
  if (preferred) {
    const exact = formats.find((format) => format.code === preferred);
    if (exact) return exact;
  }
  for (const code of IMPORT_FORMAT_IDS) {
    const match = formats.find((format) => format.code === code);
    if (match) return match;
  }
  return null;
}

/**
 * Turns a listing + file into a signed CDN URL.
 *
 * The URL is short-lived — the response carries an `expires` about five
 * minutes out — so it is fetched immediately before the download rather than
 * cached with the listing.
 */
export async function fetchDownloadUrl(id, formatCode, fileUid) {
  const data = await apiJson(
    `/listings/${encodeURIComponent(id)}/asset-formats/${encodeURIComponent(formatCode)}` +
      `/files/${encodeURIComponent(fileUid)}/download-info`,
  );
  const url = data.downloadInfo?.[0]?.downloadUrl;
  if (!url) throw new Error("Fab did not return a download URL for that file");
  return url;
}

/**
 * Auto-download ceiling for a native preview, in bytes.
 *
 * Fab archives run from 400KB to hundreds of megabytes, and the size is known
 * BEFORE the download (`asset-formats` reports `fileSize`), so the panel can
 * decide rather than discover. Under this, the preview loads on selection like
 * every other browser's; over it, the pane offers a button that names the cost.
 * 25MB is about two seconds on a normal connection and is comfortably above the
 * typical prop pack.
 */
export const PREVIEW_AUTO_LIMIT = 25 * 1024 * 1024;

/**
 * What it would take to preview this listing natively, or null if nothing here
 * can be read.
 *
 * Separate from `downloadListing` because the panel needs the SIZE before it
 * commits to the bytes — and because a preview must never write to the project.
 */
export async function previewPlan(listing) {
  if (!listing?.ccBy) return null;
  const formats = await fetchAssetFormats(listing.id);
  const chosen = pickImportFormat(formats);
  const file = chosen?.files?.[0];
  if (!file) return null;
  return {
    id: listing.id,
    code: chosen.code,
    label: chosen.label,
    fileUid: file.uid,
    fileName: file.name ?? "model",
    size: file.size ?? 0,
    // A stable identity for the preview component's cache key. Two listings
    // must never share one, or selecting the second shows the first.
    key: `fab:${listing.id}:${chosen.code}:${file.uid}`,
  };
}

/** Archive bytes for a preview. No writes, no project involvement. */
export async function fetchPreviewArchive(plan) {
  const url = await fetchDownloadUrl(plan.id, plan.code, plan.fileUid);
  return proxyBytes(url);
}

async function proxyBytes(url) {
  const value = await invoke("fetch_bytes", { url });
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error("Fab download returned an unexpected response");
}

const safeName = (name) => name.replace(/[^\w\- ]+/g, "_").trim() || "Unnamed";
const normalPath = (path) => path.replace(/\\/g, "/").replace(/^\.\//, "");

export function buildAttribution(listing) {
  return [
    `# ${listing.name}`,
    "",
    `Creator: ${listing.author}`,
    listing.authorUrl ? `Creator profile: ${listing.authorUrl}` : null,
    `Source: ${listing.sourceUrl}`,
    `License: ${listing.license}`,
    "",
    // CC-BY is not "nice to credit" — the credit line is the condition of use,
    // and this whole catalogue is under it.
    "Downloaded from Fab under Creative Commons Attribution. You MUST credit the",
    "creator above in anything you ship that uses this asset. Preserve this file",
    "with the asset and with derived works.",
  ].filter((line) => line !== null).join("\n");
}

/**
 * Recognises a payload that is one model file rather than an archive.
 *
 * Returns the same `{ format, models, textures }` shape as a real archive so
 * the caller never has to care which it got, or null when the bytes do look
 * like a container.
 *
 * A bare file brings no sibling textures with it — whatever it references is
 * either embedded or simply absent, and there is nothing this side can do
 * about the latter.
 */
function sniffBareModel(bytes, name) {
  const stem = name.replace(/\.[^.]+$/, "") || "model";
  const magic4 = String.fromCharCode(...bytes.slice(0, 4));
  // "PK\x03\x04" — a real zip. Let the archive path have it.
  if (magic4 === "PK\x03\x04") return null;
  if (magic4 === "glTF") return { format: "glb", models: [{ name: stem, bytes }], textures: new Map() };
  const head = String.fromCharCode(...bytes.slice(0, 64));
  // Binary FBX opens with this exact string; ASCII FBX has no magic at all, so
  // it is recognised by the version line every writer emits.
  if (head.startsWith("Kaydara FBX Binary") || /FBXVersion/.test(head)) {
    return { format: "fbx", models: [{ name: stem, bytes }], textures: new Map() };
  }
  return null;
}

/** Image extensions an FBX might reference as a sibling file. */
const TEXTURE_RE = /\.(png|jpe?g|tga|bmp|webp|tiff?)$/i;

/**
 * Pulls everything importable out of a Fab archive.
 *
 * Fab ships one ZIP per format, and — unlike Poly Pizza's single GLB or
 * Sketchfab's single scene — that ZIP is usually a PACK: `glb/` holding forty
 * separate props, or a `gltf/` tree with one `.gltf` plus a shared `textures/`
 * folder. All three importable formats are handled, and which one you get is
 * reported rather than inferred, because the three need different import
 * pipelines downstream:
 *
 *   - **GLB** entries are already self-contained; returned verbatim.
 *   - **glTF** entries are packed into a GLB each, with sibling buffers and
 *     textures resolved RELATIVE TO THAT `.gltf` — the same container-only,
 *     lossless pack Poly Haven and Sketchfab use. Resources are gathered from
 *     the whole archive rather than the `.gltf`'s own directory, because a
 *     pack's `textures/` folder usually sits one level ABOVE the meshes.
 *   - **FBX** entries are returned verbatim ALONGSIDE the archive's loose
 *     images. FBX cannot be converted here — it needs a parser, and this file
 *     stays node-loadable so it can be tested without one — so the bytes and
 *     the textures travel together and the caller (import or preview) decides.
 *     This matters more than it looks: a large share of Fab's free catalogue
 *     ships FBX and nothing else, and an extractor that only knew glTF quietly
 *     made every one of those listings unimportable.
 *
 * Returns `{ format, models: [{ name, bytes }], textures: Map }`, one model per
 * mesh, so the caller can produce a folder of prefabs rather than one
 * misleading "model".
 */
export async function extractArchive(payload, name = "model") {
  // ⚠ NOT ALWAYS A ZIP. Fab zips an upload only when it contains more than one
  // file: a listing whose FBX upload was a single `ghoul_ue5.fbx` serves that
  // file's bytes verbatim from the same download-info URL that hands another
  // listing a `highpoly_tree_model.zip`. Sniffing the magic rather than
  // trusting the endpoint is what stops that arriving as JSZip's genuinely
  // baffling "Can't find end of central directory : is this a zip file ?".
  const bare = sniffBareModel(payload, name);
  if (bare) return bare;

  const zip = await JSZip.loadAsync(payload);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);

  const glbEntries = entries.filter((entry) => /\.glb$/i.test(entry.name));
  if (glbEntries.length > 0) {
    return {
      format: "glb",
      textures: new Map(),
      models: await Promise.all(
        glbEntries.map(async (entry) => ({
          name: normalPath(entry.name).split("/").pop().replace(/\.glb$/i, ""),
          bytes: await entry.async("uint8array"),
        })),
      ),
    };
  }

  const gltfEntries = entries.filter((entry) => /\.gltf$/i.test(entry.name));
  if (gltfEntries.length > 0) {
    // Read every non-glTF file once, keyed by full archive path. A pack's
    // meshes share one texture folder, so slicing the archive per-mesh would
    // re-read the same megabytes for each of forty props.
    const archive = new Map();
    for (const entry of entries) {
      if (/\.gltf$/i.test(entry.name)) continue;
      archive.set(normalPath(entry.name), await entry.async("uint8array"));
    }

    const models = [];
    for (const entry of gltfEntries) {
      const gltfPath = normalPath(entry.name);
      const base = gltfPath.includes("/") ? gltfPath.slice(0, gltfPath.lastIndexOf("/") + 1) : "";
      const json = JSON.parse(await entry.async("string"));
      // glTF URIs are relative to the .gltf, and may climb out of its folder
      // with `../`. Resolve each against the archive rather than assuming the
      // resource sits beside the mesh.
      const resources = new Map();
      const wanted = [
        ...(json.buffers ?? []).map((buffer) => buffer.uri),
        ...(json.images ?? []).map((image) => image.uri),
      ].filter((uri) => uri && !uri.startsWith("data:"));
      for (const uri of wanted) {
        // `packGlb` looks resources up by the DECODED uri, so that is the key
        // used here — storing the raw one misses on every path with a space in
        // it, which asset packs are full of.
        const decoded = decodeURIComponent(uri);
        const resolved = normalPath(new URL(decoded, `file:///${base}`).pathname.slice(1));
        const bytes = archive.get(resolved) ?? archive.get(decoded) ?? archive.get(`${base}${decoded}`);
        if (bytes) resources.set(decoded, bytes);
      }
      models.push({
        name: gltfPath.split("/").pop().replace(/\.gltf$/i, ""),
        bytes: packGlb(json, resources),
      });
    }
    return { format: "gltf", models, textures: new Map() };
  }

  const fbxEntries = entries.filter((entry) => /\.fbx$/i.test(entry.name));
  if (fbxEntries.length > 0) {
    // Keyed by lowercased BASENAME, which is how FBX references its textures
    // and how `fbxImport.js` indexes siblings — an FBX asks for "wood.png",
    // not for the path it happened to be zipped under.
    const textures = new Map();
    for (const entry of entries) {
      if (!TEXTURE_RE.test(entry.name)) continue;
      textures.set(normalPath(entry.name).split("/").pop().toLowerCase(), await entry.async("uint8array"));
    }
    return {
      format: "fbx",
      textures,
      models: await Promise.all(
        fbxEntries.map(async (entry) => ({
          name: normalPath(entry.name).split("/").pop().replace(/\.fbx$/i, ""),
          bytes: await entry.async("uint8array"),
        })),
      ),
    };
  }

  throw new Error("That Fab archive contained no glTF, GLB or FBX meshes");
}

/**
 * Downloads a free Fab listing and imports every mesh it contains.
 *
 * Refuses anything that is not CC-BY. That guard is the point of this whole
 * module: Fab's download-info endpoint is anonymous, and the honest reading of
 * that is "free assets are free", not "the paywall is optional". Paid listings
 * are browsable here and are never fetched.
 *
 * Returns the import folder.
 */
export async function downloadListing(listing, onProgress, { format = "" } = {}) {
  if (!listing?.ccBy) {
    throw new Error(
      `"${listing?.name ?? "That listing"}" is not a free CC-BY asset — open it on Fab to buy it.`,
    );
  }
  const { useProjectStore } = await import("./store/projectStore.js");
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project first");

  onProgress?.({ label: "Finding files…", loaded: 0, total: 0 });
  const formats = await fetchAssetFormats(listing.id);
  const chosen = pickImportFormat(formats, format);
  if (!chosen) {
    throw new Error(
      `"${listing.name}" ships only ${formats.map((f) => f.label).join(", ") || "unsupported formats"} — nothing this engine can import.`,
    );
  }
  const file = chosen.files[0];

  onProgress?.({ label: "Authorizing download…", loaded: 0, total: file.size ?? 0 });
  const url = await fetchDownloadUrl(listing.id, chosen.code, file.uid);

  onProgress?.({ label: `Downloading ${chosen.label}…`, loaded: 0, total: file.size ?? 0 });
  const zipBytes = await proxyBytes(url);

  onProgress?.({ label: "Extracting archive…", loaded: zipBytes.byteLength, total: zipBytes.byteLength });
  // Named `archiveFormat`, not `format`: the parameter of that name is the
  // caller's *preference*, and the archive's actual format is what everything
  // below branches on.
  const { format: archiveFormat, models, textures } = await extractArchive(zipBytes, file.name);

  const importDir = `${root}/Fab/${safeName(listing.name)}`;
  await invoke("create_dir", { path: importDir }).catch(() => {});

  // FBX resolves its textures by filename against the folder the file sits in
  // (see fbxImport.js), so the loose images have to land BEFORE the meshes are
  // unpacked — an FBX unpacked next to no textures produces a grey model with
  // no error anywhere.
  for (const [name, bytes] of textures) {
    await writeBinaryFile(`${importDir}/${name}`, bytes);
  }

  // One unpack per mesh. `unpackGlb` decides on its own whether each flattens
  // to mesh entities or keeps the model component (a skinned mesh cannot be
  // flattened without losing its skeleton), so a pack of static props and a
  // pack of rigged characters both land correctly. `unpackFbx` converts to an
  // internal GLB first and then joins the same pipeline.
  const { unpackGlb } = await import("./glbImport.js");
  const { unpackFbx } = archiveFormat === "fbx" ? await import("./fbxImport.js") : {};
  const folders = [];
  for (const [index, model] of models.entries()) {
    onProgress?.({
      label: `Importing ${index + 1} of ${models.length}…`,
      loaded: index,
      total: models.length,
    });
    const meshPath = `${importDir}/${safeName(model.name)}.${archiveFormat === "fbx" ? "fbx" : "glb"}`;
    await writeBinaryFile(meshPath, model.bytes);
    const folder = archiveFormat === "fbx" ? await unpackFbx(meshPath) : await unpackGlb(meshPath);
    folders.push(folder ?? importDir);
  }

  await invoke("save_scene", {
    path: `${importDir}/ATTRIBUTION.md`,
    contents: buildAttribution(listing),
  });
  await useProjectStore.getState().refresh();
  return { folder: importDir, folders, imported: models.length, format: chosen.code };
}

export async function openListingPage(listing) {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(listing.sourceUrl);
}
