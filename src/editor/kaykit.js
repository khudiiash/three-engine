/**
 * KayKit client + import pipeline (editor-only; the runtime never talks to the
 * network).
 *
 * KayKit is Kay Lousberg's low-poly game-asset line — ten packs, CC0 — and the
 * one library here whose canonical distribution is a GitHub account rather
 * than an API. The same account that sells EXTRA tiers on itch.io
 * (kaylousberg.itch.io) pushes every free pack to
 * `github.com/KayKit-Game-Assets` as per-file assets, and itch is also already
 * covered by the itch.io panel, so THIS module exists for what itch cannot
 * do: anonymous, per-FILE imports. One character GLB — with every animation
 * clip embedded — or one prop, downloaded and unpacked on its own, no
 * account, no claim, no pack-sized zip.
 *
 * ## The facts that shape this file
 *
 * 1. **GLB only.** Every pack ships `.fbx` AND glTF — but the props' glTF is
 *    a loose `.gltf` + `.bin` + texture trio, which would need reassembly,
 *    while the same trees also carry self-contained `.glb` files whose
 *    textures are embedded bufferViews (verified against Barbarian.glb: one
 *    image, bufferView, plus a skin and 76 named animation clips). FBX is
 *    deliberately ignored, same as Poly Pizza does with its FBX twin.
 *
 * 2. **`.gltf.glb` is one file, not a weird nesting.** Some packs (Dungeon
 *    Remastered) name their GLBs `banner_blue.gltf.glb` — exported via a
 *    gltf intermediate, then binarised. The display name strips BOTH
 *    suffixes, or the grid fills up with "banner_blue.gltf"s.
 *
 * 3. **Plain `fetch`, no Rust proxy.** `api.github.com` and
 *    `raw.githubusercontent.com` both serve `Access-Control-Allow-Origin: *`,
 *    which puts KayKit in the Poly Haven camp (direct webview fetch) rather
 *    than the Sketchfab one (key attached server-side) — there is no
 *    credential at all here, so there is nothing to keep out of the page.
 *
 * 4. **Anonymous GitHub is 60 requests/hour per IP.** The pack LIST is
 *    therefore static (a new pack is a one-line addition below), and each
 *    pack's file tree is fetched once per session through the `git/trees`
 *    API and cached — ten packs is the whole budget cost of a full cross-pack
 *    search, and one pack the cost of browsing it.
 *
 * 5. **`id` is `<repo>:<path>`.** The trees API has no get-one-file endpoint,
 *    so the id that reaches `library.import` has to carry everything needed
 *    to re-find the file: which pack repo, and where inside it. Self-describing
 *    and stateless — nothing is captured at search time.
 *
 * Downloads land in the project's `KayKit/<Pack>/` folder as ordinary
 * unpacked assets, with an ATTRIBUTION.md beside them. KayKit is CC0, so the
 * file records provenance rather than discharging a licence duty — credit is
 * optional, and the file says so.
 */

import { writeBinaryFile } from "./assetLoader.js";

const GITHUB_USER = "KayKit-Game-Assets";
const BRANCH = "main"; // verified: every repo's default branch

/** One pack = one repo. `kind` splits the two animated-character packs from the
 * prop/environment packs so the panel can default to the characters — the
 * reason this module exists. Descriptions paraphrase the repos' own. */
export const PACKS = [
  {
    id: "KayKit-Character-Pack-Adventures-1.0",
    title: "Adventurers",
    kind: "Characters",
    description: "4 rigged, animated characters (Barbarian, Knight, Mage, Rogue + hooded Rogue) with 75 animations and 25+ weapon/prop accessories.",
  },
  {
    id: "KayKit-Character-Pack-Skeletons-1.0",
    title: "Skeletons",
    kind: "Characters",
    description: "4 rigged, animated skeleton characters (Warrior, Mage, Rogue, Minion) sharing the Adventurers animation set.",
  },
  {
    id: "KayKit-Dungeon-Remastered-1.0",
    title: "Dungeon Remastered",
    kind: "Environment",
    description: "200+ stylised dungeon assets: walls, floors, props, doors, torches.",
  },
  {
    id: "KayKit-City-Builder-Bits-1.0",
    title: "City Builder Bits",
    kind: "Environment",
    description: "Roads, buildings and street furniture for city planning and simulation games.",
  },
  {
    id: "KayKit-Space-Base-Bits-1.0",
    title: "Space Base Bits",
    kind: "Environment",
    description: "Modular space-station floors, walls, pods and props.",
  },
  {
    id: "KayKit-Medieval-Hexagon-Pack-1.0",
    title: "Medieval Hexagon",
    kind: "Environment",
    description: "200+ hexagonal tiles, buildings and props for hex-based strategy maps.",
  },
  {
    id: "KayKit-Halloween-Bits-1.0",
    title: "Halloween Bits",
    kind: "Environment",
    description: "Spooky cemetery pieces: gravestones, fences, pumpkins, dead trees.",
  },
  {
    id: "KayKit-Furniture-Bits-1.0",
    title: "Furniture Bits",
    kind: "Environment",
    description: "Indoor furniture for interiors and life-simulation games.",
  },
  {
    id: "KayKit-Restaurant-Bits-1.0",
    title: "Restaurant Bits",
    kind: "Environment",
    description: "Kitchen equipment, counters and food props.",
  },
  {
    id: "KayKit-Prototype-Bits-1.0",
    title: "Prototype Bits",
    kind: "Environment",
    description: "Greyscale blockout shapes for grey-boxing levels.",
  },
];

export const packByRepo = (repoId) => PACKS.find((pack) => pack.id === repoId) ?? null;

const repoUrl = (repoId, path = "") =>
  `https://github.com/${GITHUB_USER}/${repoId}${path ? `/blob/${BRANCH}/${path}` : ""}`;

/** The pack's cover art, straight from GitHub's own social-preview renderer.
 * Per-FILE thumbnails do not exist anywhere in the repos — the grid tiles stay
 * placeholders and the detail pane's live 3D preview is the answer. */
export const packImageUrl = (repoId) =>
  `https://opengraph.githubassets.com/1/${GITHUB_USER}/${repoId}`;

/** `addons/<pack>/Characters/gltf/Barbarian.glb` → "Barbarian";
 * `Assets/gltf/banner_blue.gltf.glb` → "banner_blue" (see fact 2). */
const displayNameOf = (path) =>
  path.split("/").pop().replace(/\.gltf\.glb$/i, "").replace(/\.glb$/i, "");

const safeName = (name) => String(name).replace(/[^\w\- ]+/g, "_").trim() || "Unnamed";

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const treeCache = new Map(); // repo -> Promise<items>

/**
 * Every importable `.glb` in one pack, cached for the session.
 *
 * Characters are told apart from props by PATH — both character repos keep
 * their rigged+animated GLBs under a `Characters/` folder and their weapon
 * accessories under `Assets/` — which is also the `animated` signal: a
 * character GLB carries its animation clips inside it, a prop does not. No
 * per-file API call is spent proving what the folder layout already states.
 */
export function fetchPackItems(repoId) {
  if (!packByRepo(repoId)) throw new Error(`Unknown KayKit pack "${repoId}"`);
  let p = treeCache.get(repoId);
  if (!p) {
    p = fetch(
      `https://api.github.com/repos/${GITHUB_USER}/${repoId}/git/trees/${BRANCH}?recursive=1`,
      { headers: { Accept: "application/vnd.github+json" } },
    ).then(async (res) => {
      if (res.status === 403 || res.status === 429) {
        throw new Error(
          "GitHub's anonymous API limit (60 requests/hour) is used up — the file lists will " +
            "come back within the hour, or browse the pack at " + repoUrl(repoId),
        );
      }
      if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status} for ${repoId}`);
      const data = await res.json();
      if (data.truncated) {
        // Would mean a pack grew past the API's cap; surfacing it beats a
        // silently halved catalogue.
        throw new Error(`GitHub returned a truncated file list for ${repoId}`);
      }
      return (data.tree ?? [])
        .filter((entry) => entry.type === "blob" && /\.glb$/i.test(entry.path))
        .map((entry) => ({
          id: `${repoId}:${entry.path}`,
          repo: repoId,
          path: entry.path,
          name: displayNameOf(entry.path),
          kind: /\/Characters\//i.test(entry.path) ? "character" : "prop",
          animated: /\/Characters\//i.test(entry.path),
          downloadUrl: `https://raw.githubusercontent.com/${GITHUB_USER}/${repoId}/${BRANCH}/${entry.path}`,
          sourceUrl: repoUrl(repoId, entry.path),
          pack: packByRepo(repoId),
        }));
    });
    treeCache.set(repoId, p);
    p.catch(() => treeCache.delete(repoId)); // retry next open on failure
  }
  return p;
}

/** Search across every pack. Trees are cached, so repeated searches are free;
 * a cold one costs one request per pack (fact 4). */
export async function searchPackItems(query = "") {
  const settled = await Promise.all(
    PACKS.map((pack) => fetchPackItems(pack.id).catch(() => [])),
  );
  const needle = query.trim().toLowerCase();
  return settled
    .flat()
    .filter((item) =>
      !needle ||
      item.name.toLowerCase().includes(needle) ||
      item.pack.title.toLowerCase().includes(needle) ||
      item.pack.kind.toLowerCase().includes(needle),
    );
}

/** Re-finds one item from a `<repo>:<path>` id (fact 5). */
export async function resolveItem(id) {
  const sep = id.indexOf(":");
  if (sep <= 0) throw new Error(`"${id}" is not a KayKit id — expected "<repo>:<path>"`);
  const repo = id.slice(0, sep);
  const path = id.slice(sep + 1);
  const items = await fetchPackItems(repo);
  const item = items.find((candidate) => candidate.path === path);
  if (!item) throw new Error(`No GLB at "${path}" in ${repo} — the pack may have been updated; search again.`);
  return item;
}

// ---------------------------------------------------------------------------
// Download plumbing
// ---------------------------------------------------------------------------

/**
 * Streams a raw.githubusercontent.com URL to bytes, reporting cumulative
 * progress. `total` comes from Content-Length and may stay 0 (chunked
 * transfer) — the callers show the label alone rather than a fake total.
 */
async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(buf.byteLength, total);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
    onProgress?.(length, total);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function projectStore() {
  return (await import("./store/projectStore.js")).useProjectStore.getState();
}

async function invoke(cmd, args) {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

export function buildAttribution(item) {
  return [
    `# ${item.name}`,
    "",
    `Pack: ${item.pack.title} (KayKit ${item.pack.kind})`,
    "Creator: Kay Lousberg (www.kaylousberg.com)",
    `Source: ${item.sourceUrl}`,
    "License: CC0 1.0 Universal",
    "https://creativecommons.org/publicdomain/zero/1.0/",
    "",
    "Downloaded from the official KayKit GitHub distribution. CC0 — no",
    "attribution required, though credit is appreciated by the creator.",
  ].join("\n");
}

/**
 * Downloads one GLB and imports it as ordinary project assets: written to
 * `KayKit/<Pack>/<Name>.glb`, then run through the standard unpack pipeline
 * so materials, rig, animation clips and prefab behave exactly as for a
 * native GLB import. Returns the unpacked folder.
 */
export async function downloadModel(item, onProgress) {
  const root = (await projectStore()).rootPath;
  if (!root) throw new Error("Open a project first");

  onProgress?.({ label: "Downloading model…", loaded: 0, total: 0 });
  const bytes = await fetchBytes(item.downloadUrl, (loaded, total) =>
    onProgress?.({ label: "Downloading model…", loaded, total }),
  );
  onProgress?.({ label: "Importing model…", loaded: bytes.byteLength, total: bytes.byteLength });

  const importDir = `${root}/KayKit/${safeName(item.pack.title)}`;
  await invoke("create_dir", { path: importDir }).catch(() => {});
  const glbPath = `${importDir}/${safeName(item.name)}.glb`;
  await writeBinaryFile(glbPath, bytes);

  const { unpackGlb } = await import("./glbImport.js");
  const folder = (await unpackGlb(glbPath)) ?? importDir;
  await invoke("save_scene", { path: `${folder}/ATTRIBUTION.md`, contents: buildAttribution(item) });
  await (await projectStore()).refresh();
  return folder;
}

export async function openModelPage(item) {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(item.sourceUrl ?? repoUrl(item.repo ?? item.id));
}
