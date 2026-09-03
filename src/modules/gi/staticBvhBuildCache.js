// Opportunistic session cache for the expensive static-scene BVH pack.
//
// The packed words are enormous on real scenes (Bistro is ~158 MB), so this
// cache MUST NOT become their owner. The active upload/staging graph already
// owns the immutable array while it is useful; WeakRef lets a rebuild in the
// same editing burst reuse it without preventing GC once the renderer drops
// that graph. One entry also prevents keys for old scene revisions piling up.

function normalizedStrategyName(strategy) {
  const name = String(strategy ?? "sah").toLowerCase();
  return name === "average" || name === "center" ? name : "sah";
}

/** Revision token for every geometry input the static pack can consume. */
export function staticBvhGeometryRevision(geometry) {
  const position = geometry?.attributes?.position;
  const index = geometry?.index;
  const uv = geometry?.attributes?.uv;
  const attr = (a) => a
    ? `${a.version ?? 0}/${a.count ?? 0}/${a.itemSize ?? 0}/${a.normalized === true ? 1 : 0}`
    : "-";
  return `${geometry?.id ?? 0}:p${attr(position)}:i${attr(index)}:u${attr(uv)}`;
}

export class StaticBvhBuildCache {
  constructor() {
    this._entry = null;
    this._objectIds = new WeakMap();
    this._nextObjectId = 1;
  }

  _objectId(value) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return 0;
    let id = this._objectIds.get(value);
    if (id == null) {
      id = this._nextObjectId++;
      this._objectIds.set(value, id);
    }
    return id;
  }

  /**
   * Exact input signature, intentionally independent of GI quality. Array
   * identity catches serializer replacement, the revision catches in-place
   * BufferAttribute edits, and matrix values catch placement/instance motion.
   */
  keyFor(items, { uvs = false, strategy = "sah", format = "world-v1" } = {}) {
    const placement = format === "placement-v1";
    const parts = [
      `static-bvh-v1`,
      `f:${String(format)}`,
      `s:${normalizedStrategyName(strategy)}`,
      `uv:${uvs ? 1 : 0}`,
      `n:${items.length}`,
    ];
    for (const item of items) {
      const matrix = item.matrix?.elements ?? item.matrix ?? [];
      parts.push(
        `g:${item.geometryRevision ?? item.geometryKey ?? "-"}`,
        `p:${this._objectId(item.positions)}/${item.positions?.length ?? 0}`,
        `i:${this._objectId(item.index)}/${item.index?.length ?? 0}`,
        uvs ? `u:${this._objectId(item.uvs)}/${item.uvs?.length ?? 0}` : "u:-",
        placement ? "slot:*" : `slot:${item.slot >>> 0}`,
        placement ? "m:*" : `m:${Array.from(matrix, (value) => Number(value).toString(16)).join(",")}`,
      );
    }
    return parts.join("|");
  }

  get(key) {
    if (this._entry?.key !== key) return null;
    // The upload graph owns `words` (not the small packed wrapper), so weakly
    // reference that array and reconstruct the metadata shell on a hit.
    const words = this._entry.ref.deref();
    if (!words) {
      this._entry = null;
      return null;
    }
    return { ...this._entry.meta, words };
  }

  set(key, packed) {
    if (!packed?.words) {
      this._entry = null;
      return packed;
    }
    const { words, ...rawMeta } = packed;
    // Placement metadata contains TLAS/BLAS subarray views and source items.
    // Storing either beside a WeakRef would make the cache a strong owner of
    // the giant payload through `view.buffer`, defeating this class's reason
    // to exist. Disk/session hits rehydrate the small TLAS maps from items.
    const meta = packed.format === "placement-v1"
      ? {
          format: packed.format,
          builderAbi: packed.builderAbi,
          layout: { ...packed.layout },
          placementCount: packed.placementCount,
          blasCount: packed.blasCount,
          triangleCount: packed.triangleCount,
          arity: packed.arity,
          uvs: packed.uvs,
        }
      : rawMeta;
    this._entry = { key, ref: new WeakRef(words), meta };
    return packed;
  }

  clear() {
    this._entry = null;
  }
}

export { normalizedStrategyName as staticBvhStrategyName };
