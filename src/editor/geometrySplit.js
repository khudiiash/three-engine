// @ts-nocheck
/**
 * "Split into Separate Meshes", for the three places a person can ask for it:
 * a `.geom` in the Assets panel, a mesh entity's context menu in the Hierarchy,
 * and the Mesh component's own menu in the Inspector.
 *
 * All three route through here so the QUESTION is asked the same way each time.
 * That matters more than the plumbing:
 *
 * ⚠⚠ **THE CONFIRMATION IS NOT POLITENESS, IT IS THE FEATURE.** How many pieces
 * a mesh contains is invisible until it is measured — Sponza's curtains are
 * three, its `Mesh_0_6` is 28, and its vines are **671**. And because this is an
 * ASSET-level split, every entity using that asset splits too, so the real
 * number is pieces x users. Nobody should discover 671 by watching their
 * hierarchy fill up. The dry run is run first, always, and its counts are what
 * the dialog shows.
 */
import { confirmDestructive } from "./components/ConfirmDialog.jsx";
import { callOp } from "./api/registry.js";

/**
 * Runs the dry run, asks, then applies. Safe to call from a menu handler.
 *
 * Pass `path` (an asset) or `entityId` (a mesh entity) — they reach the same
 * operation, because splitting one entity's mesh means splitting the asset it
 * shares with every other entity using it.
 */
export async function splitGeometryIslandsWithPrompt({ path, entityId } = {}) {
  let plan;
  try {
    plan = await callOp("geometry.splitIslands", { path, entityId, apply: false });
  } catch (error) {
    console.warn(`Split into Separate Meshes: ${error?.message ?? error}`);
    return null;
  }

  // A single-surface mesh is the common case and is not an error — say so and
  // stop, rather than opening a dialog that offers to do nothing.
  if ((plan.pieces ?? 0) <= 1) {
    console.log(`"${nameOf(plan)}" is a single connected surface — nothing to split.`);
    return plan;
  }

  const users = plan.entitiesUsing ?? [];
  const total = plan.wouldCreate ?? plan.pieces;
  const lines = [
    `${plan.pieces} disconnected pieces.`,
    users.length
      ? `${users.length} entit${users.length === 1 ? "y" : "ies"} use this mesh, so ${total} entities would be created and the ${users.length === 1 ? "original" : "originals"} removed.`
      : "No entity in this scene uses it, so only the asset is split.",
  ];
  // Saying this up front is cheaper than a support question later.
  if (plan.droppedEditTopology) {
    lines.push("Edit-mode topology (polygons, per-corner UVs, edge flags) is not carried over.");
  }
  lines.push("Undo restores the entities; the new .geom files stay on disk.");

  const ok = await confirmDestructive({
    title: "Split into Separate Meshes",
    message: lines.join(" "),
    items: users.slice(0, 12).map((entity) => entity.name),
    confirmLabel: `Split into ${plan.pieces}`,
  });
  if (!ok) return null;

  try {
    const result = await callOp("geometry.splitIslands", { path, entityId, apply: true });
    console.log(
      `Split "${nameOf(result)}" into ${result.pieces} pieces`
      + (result.entitiesSplit ? ` across ${result.entitiesSplit} entit${result.entitiesSplit === 1 ? "y" : "ies"}` : "")
      + ".",
    );
    return result;
  } catch (error) {
    console.warn(`Split into Separate Meshes: ${error?.message ?? error}`);
    return null;
  }
}

/** Whether this entity has a mesh with a `.geom` behind it — the menu's gate. */
export function canSplitEntity(entity) {
  const asset = entity?.getComponent?.("mesh")?.props?.geometryAsset;
  return typeof asset === "string" && /\.geom$/i.test(asset);
}

const nameOf = (result) => String(result?.path ?? "").split(/[\\/]/).pop() || "this mesh";
