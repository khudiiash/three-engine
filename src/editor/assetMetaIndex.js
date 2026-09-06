// @ts-check
/**
 * Lazy on-disk metadata for the Assets panel's structured search, in one place.
 *
 * `texture?width>1920` and `material?roughness=0` ask questions the directory
 * listing cannot answer: a texture's pixel size is recorded in NO metadata
 * (see imageDimensions.js) and a material's roughness only in its `.mat` JSON.
 * Answering means opening files, so it happens here — lazily, once per search
 * session, in small batches that yield to the event loop, cached against each
 * file's `size:modified` stamp so the second identical search costs a Map read
 * and nothing else.
 *
 * The flow: the panel notices via `queryNeeds` that a query touches width/
 * height or material scalars, and calls `ensureAssetMeta` with the subtree
 * pool and a ticket. This module reads only the files that could answer,
 * writes each batch into the cache, and bumps a zustand version counter — the
 * panel subscribes to that counter, so results refill as batches land instead
 * of waiting for the whole subtree.
 *
 * Nothing here throws for a file that will not read: a broken image or a
 * `.mat` with junk in it is a negative cache entry retried after a minute,
 * because a search filter has no business crashing on one bad file.
 *
 * Node-testable by design: no top-level Tauri or React import, the Tauri
 * layer is reached through a dynamic import guarded once on
 * `globalThis.__TAURI_INTERNALS__`, and both file reads are injectable (`deps`)
 * — which is how tests/asset-meta-index.test.mjs runs the whole thing with
 * fake files and no filesystem.
 */

import { create } from "zustand";
import { vmSingleton } from "./singleton.js";
import { parseImageSize } from "./imageDimensions.js";
import { ATLAS_EXTENSIONS, MATERIAL_EXTENSIONS, TEXTURE_EXTENSIONS } from "./assetLoader.js";

/** Bytes probed per image. 4096, not 64: a JPEG's SOF marker sits AFTER its
 *  EXIF block, and camera EXIF routinely runs to kilobytes. */
const HEAD_BYTES = 4096;

/** Files read per event-loop turn — thousands of heads must not block a frame. */
const BATCH = 8;

/** How long a failed read stays negative before we look again. */
const RETRY_MS = 60_000;

/** Headers the pixel-size parser understands; `.atlas` carries `size` in JSON
 *  instead, and `.hdr`/`.exr` are not parsed by anyone, so probing them would
 *  be an IPC round trip buying a guaranteed null. */
const HEAD_EXTS = new Set(TEXTURE_EXTENSIONS);
/** The two JSON probes are kept APART, not merged into one "text" set: a
 *  `.mat` carries no width and an `.atlas` no roughness, so a merged set makes
 *  `texture?width>1920` open every material in the project for an answer it
 *  cannot contain. */
const ATLAS_EXTS = new Set(ATLAS_EXTENSIONS);
const MATERIAL_EXTS = new Set(MATERIAL_EXTENSIONS);

/**
 * @typedef {{
 *   width?: number,
 *   height?: number,
 *   material?: { roughness?: number, metalness?: number, color?: string, graph?: boolean, map?: string },
 *   atlasSize?: [number, number],
 *   state: "ok" | "error" | "pending",
 * }} AssetMeta
 *
 * @typedef {{
 *   readHead: (path: string, maxBytes: number) => Promise<Uint8Array | ArrayBuffer>,
 *   readText: (path: string) => Promise<string>,
 * }} MetaDeps
 */

/** Reactive version counter — the panel's re-render trigger between batches. */
export const useAssetMetaStore = vmSingleton("assetMetaStore", () =>
  create((set) => ({
    version: 0,
    bump: () => set((s) => ({ version: s.version + 1 })),
  })),
);

/**
 * @typedef {{ key: string, state: "ok" | "error" | "pending", value: AssetMeta | null, retryAt?: number }} CacheEntry
 * @type {Map<string, CacheEntry>}
 */
const cache = new Map();

/** Highest ticket any ensureAssetMeta call has come in with. */
let latestTicket = 0;

/**
 * Synchronous read for the filter. Null means "unknown" — not probed yet,
 * failed, or the editor running without Tauri — and every meta-dependent
 * predicate treats null as "does not match" rather than crashing on it.
 * @param {string} path
 * @returns {AssetMeta | null}
 */
export function getAssetMeta(path) {
  const hit = cache.get(String(path ?? ""));
  return hit && hit.state === "ok" ? hit.value : null;
}

/**
 * Cache state of one path, for diagnostics and the node tests — the real
 * consumers only ever want the value.
 * @param {string} path
 * @returns {{ state: string, retryAt?: number, key: string } | null}
 */
export function inspectAssetMeta(path) {
  const hit = cache.get(String(path ?? ""));
  return hit ? { state: hit.state, retryAt: hit.retryAt, key: hit.key } : null;
}

/**
 * The `size:modified` stamp a cached entry is valid for. Re-probing when it
 * changes is what makes an edited texture's new size show up without any
 * explicit invalidation anywhere else in the editor.
 * @param {{ size?: number, modified?: number }} entry
 */
const cacheKey = (entry) => `${entry.size}:${entry.modified}`;

/**
 * Which kind of probe (if any) this entry needs, given what the query asks
 * about. This is the whole reason the warm-up is cheap: `material?roughness=0`
 * over a project of 5000 files opens the handful of `.mat`s and touches
 * nothing else.
 * @param {{ ext?: string, name?: string }} entry
 * @param {{ dims: boolean, material: boolean }} needs
 * @returns {"head" | "text" | null}
 */
function probeKind(entry, needs) {
  const ext = String(entry.ext ?? entry.name?.split(".").pop() ?? "").toLowerCase();
  if (needs.dims && HEAD_EXTS.has(ext)) return "head";
  if (needs.dims && ATLAS_EXTS.has(ext)) return "text";
  if (needs.material && MATERIAL_EXTS.has(ext)) return "text";
  return null;
}

/**
 * Probe every uncached file the query needs, in batches, bumping the version
 * after each so the panel refills progressively.
 *
 * @param {Array<{ path: string, ext?: string, name?: string, size?: number, modified?: number, is_dir?: boolean }>} entries
 *        the pool being searched — used both to pick probes and to prune the
 *        cache of paths that have left it
 * @param {{ dims: boolean, material: boolean }} needs  from queryNeeds
 * @param {number} ticket  caller's monotonic id; a newer one silences this run
 * @param {MetaDeps} [deps]  injectable IO; default is Tauri
 * @returns {Promise<void>}
 */
export async function ensureAssetMeta(entries, needs, ticket, deps) {
  const io = resolveDeps(deps);
  if (!io) return;
  if (!entries?.length) return;
  if (ticket > latestTicket) latestTicket = ticket;

  const now = Date.now();
  const keep = new Set();
  /** @type {Array<{ path: string, kind: "head" | "text", key: string }>} */
  const wanted = [];
  for (const entry of entries) {
    if (!entry?.path || entry.is_dir) continue;
    keep.add(entry.path);
    const kind = probeKind(entry, needs);
    if (!kind) continue;
    const key = cacheKey(entry);
    const hit = cache.get(entry.path);
    // Fresh enough: probed, already in flight, or failed recently.
    if (hit && hit.key === key) {
      if (hit.state !== "error" || (hit.retryAt ?? 0) > now) continue;
    }
    cache.set(entry.path, { key, state: "pending", value: null });
    wanted.push({ path: entry.path, kind, key });
  }
  // Paths that left the pool are dead weight — a folder the user navigated
  // away from should not keep its probes cached forever.
  for (const path of cache.keys()) {
    if (!keep.has(path)) cache.delete(path);
  }

  for (let at = 0; at < wanted.length; at += BATCH) {
    // A newer search superseded this one: stop before spending another batch.
    if (ticket !== latestTicket) return;
    await Promise.all(wanted.slice(at, at + BATCH).map((item) => probe(item, io)));
    useAssetMetaStore.getState().bump();
    // Hand the frame back between batches — the point of batching.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * One file. Never throws: any failure is a negative cache entry with a retry
 * date, so a single unreadable file neither crashes the search nor gets
 * re-read on every keystroke.
 * @param {{ path: string, kind: "head" | "text", key: string }} item
 * @param {MetaDeps} io
 */
async function probe(item, io) {
  let value = null;
  try {
    value = item.kind === "head" ? await probeImage(item.path, io) : await probeJson(item.path, io);
  } catch {
    value = null;
  }
  cache.set(
    item.path,
    value === null
      ? { key: item.key, state: "error", value: null, retryAt: Date.now() + RETRY_MS }
      : { key: item.key, state: "ok", value },
  );
}

/** First bytes in, pixel size out. Null when the head is not a known image. */
async function probeImage(path, io) {
  const size = parseImageSize(await io.readHead(path, HEAD_BYTES));
  return size ? { width: size.width, height: size.height } : null;
}

/**
 * `.mat` and `.atlas` are JSON. A material surfaces only the scalars a query
 * can compare — graph materials expose none, which `graph=true` exists to
 * catch (see queryEvalAsset.resolveAssetPath).
 */
async function probeJson(path, io) {
  const json = JSON.parse(await io.readText(path)) ?? {};
  if (path.toLowerCase().endsWith(".mat")) {
    return {
      material: {
        roughness: finiteOrUndefined(json.roughness),
        metalness: finiteOrUndefined(json.metalness),
        color: typeof json.color === "string" ? json.color : undefined,
        graph: !!json.shaderGraph,
        map: typeof json.map === "string" ? json.map : "",
      },
    };
  }
  const size = Array.isArray(json.size) ? json.size : [];
  const width = Math.max(0, Math.round(Number(size[0]) || 0));
  const height = Math.max(0, Math.round(Number(size[1]) || 0));
  // An atlas without a size answers nothing; treat it as unread.
  return width && height ? { atlasSize: [width, height], width, height } : null;
}

/** @param {unknown} value */
function finiteOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** @type {MetaDeps | null} */
let tauriDeps = null;
/** Set the first time we look for Tauri and do not find it — plain-browser dev
 *  (`vite` with no shell) then short-circuits instead of probing per search. */
let noTauri = false;

/**
 * The injected deps win; otherwise Tauri, resolved lazily ONCE so a browser
 * session never retries what it cannot have.
 * @param {MetaDeps} [deps]
 * @returns {MetaDeps | null}
 */
function resolveDeps(deps) {
  if (deps) return deps;
  if (noTauri) return null;
  if (tauriDeps) return tauriDeps;
  if (!globalThis.__TAURI_INTERNALS__) {
    noTauri = true;
    return null;
  }
  // Same wrapper style as assetLoader's readAssetMeta: dynamic import so the
  // module itself stays loadable outside the shell.
  tauriDeps = {
    readHead: async (path, maxBytes) => {
      const { invoke } = await import("@tauri-apps/api/core");
      // read_binary_file_head is a raw IPC response → resolves to bytes.
      return invoke("read_binary_file_head", { path, maxBytes });
    },
    readText: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke("read_text_file", { path });
    },
  };
  return tauriDeps;
}
