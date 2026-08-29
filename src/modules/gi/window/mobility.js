// GI2 — GI MOBILITY IS THE CLASSIFICATION (§19 6.22).
//
// The Mesh component's `giMobility` ("auto" | "static" | "dynamic") is the ONE
// rule every GI2 consumer reads, through this resolver, so the soup, the static
// voxels, the static shadow BVH, the merge proxies, the per-frame transform
// audit and the dynamic layer can never disagree about a mesh:
//
//   static    in the soup / static voxels / static BVH / merge. NEVER audited
//             for transforms, never released as a mover, never re-voxelized.
//             Moving a static mesh is a scene-authoring error: GI keeps its
//             build pose and says so ONCE per mesh (`warnStaticMoved`).
//   dynamic   never in the soup / static BVH; always in the dynamic layer,
//             its live matrix read every frame (a 16-float compare when still).
//   auto      static until its transform changes after the build, then
//             PROMOTED — released from the static side and seated as a mover —
//             and demoted back to static once it has settled (6.21's rebuild).
//
// `stateOf` answers "static" | "dynamic" | "auto" | "promoted"; `isDynamicNow`
// is the bit the static BVH's mover leaf and the dynamic-layer test read.
import { giMobilityOf } from "../dynamicObjects.js";

// A promoted mesh returns to static through 6.21's settle (GISystem
// `#refreshGi2Movers`: `GI2_MOVER_SETTLE_FRAMES` still frames → one rebuild),
// which calls `demote` here — the resolver owns the classification, the
// mover loop owns the clock.

export function createGi2Mobility() {
  /** "auto" meshes that moved after the build — dynamic until they settle. */
  const promoted = new Set();
  // A rebuild may re-collect NEW mesh objects for the same entity (merge
  // proxies, re-created meshes); the promotion survives by entity id too.
  const promotedIds = new Set();
  const warned = new WeakSet();
  /** Counts fixed at the last build; `promoted` is live. */
  const built = { static: 0, dynamic: 0, auto: 0 };

  const stateOf = (mesh) => {
    const m = giMobilityOf(mesh);
    if (m === "static") return "static";
    if (m === "dynamic" || mesh?.isSkinnedMesh === true) return "dynamic";
    return promoted.has(mesh) || (mesh?.userData?.entityId && promotedIds.has(mesh.userData.entityId)) ? "promoted" : "auto";
  };
  const promote = (mesh) => { promoted.add(mesh); if (mesh?.userData?.entityId) promotedIds.add(mesh.userData.entityId); };
  const demote = (mesh) => { promoted.delete(mesh); if (mesh?.userData?.entityId) promotedIds.delete(mesh.userData.entityId); };

  return {
    promoted,
    promote,
    demote,
    stateOf,
    isDynamicNow: (mesh) => { const s = stateOf(mesh); return s === "dynamic" || s === "promoted"; },
    isStaticNow: (mesh) => { const s = stateOf(mesh); return s === "static" || s === "auto"; },
    /** Called with the build's mesh list; also drops promoted meshes that left the scene. */
    tally(meshes) {
      built.static = built.dynamic = built.auto = 0;
      for (const mesh of meshes) {
        const s = stateOf(mesh);
        if (s === "static") built.static++;
        else if (s === "dynamic") built.dynamic++;
        else built.auto++;
      }
      for (const mesh of promoted) if (!mesh?.parent) demote(mesh);
    },
    counts: () => ({ static: built.static, dynamic: built.dynamic, auto: built.auto - promotedIds.size, promoted: promotedIds.size }),
    /** ONE warn per mesh — the authoring error, not a per-frame log. */
    warnStaticMoved(mesh) {
      if (warned.has(mesh)) return false;
      warned.add(mesh);
      const name = mesh.name || mesh.userData?.entityId || "(unnamed)";
      console.warn(`[gi2] mesh "${name}" is GI static and moved; GI keeps its build pose — set Mobility to auto/dynamic on its Mesh component`);
      return true;
    },
  };
}
