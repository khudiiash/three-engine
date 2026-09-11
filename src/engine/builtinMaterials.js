/**
 * Engine supplied materials are immutable; author edits fork a project asset.
 *
 * ⛔ **THE WATER SURFACE'S BASE COLOUR IS A TRANSMISSION FILTER, AND IT HAS TO
 * BE NEUTRAL NOW.** Per KHR_materials_transmission — which three implements —
 * the transmitted radiance is MULTIPLIED by the material's base colour. So the
 * old `#438d9c` was a fixed 0.055x filter on red applied to everything seen
 * through the surface, with no idea how much water the ray actually crossed: a
 * white sphere half a metre under went dark teal, and "saturation 0 = crystal
 * clear water, everything visible regardless of depth" was unreachable no
 * matter what the medium did. Measured side by side — the same frame with a
 * white lid shows white spheres and a bright tiled floor.
 *
 * The water's colour is the VOLUME's, and it lives on the Water component
 * (`color`, `deepColor`, `saturation`) where `waterMedium.js` integrates it
 * over the path the ray took. The surface keeps only what a surface owns: its
 * foam, its roughness, its Fresnel.
 *
 * ⚠ **LIGHTER, NOT WHITE — AND THE WALK BACK IS THE POINT.** Taken all the way
 * (white shallow AND deep, the appearance node's absorption at zero) the
 * surface loses its depth gradient and reads as frosted glass; a step later,
 * still too pale, and the water "lost color ... color is gone for sure" (user,
 * 2026-09-05). Clear water genuinely IS colourless, so the medium can only
 * supply a tint once `saturation` is turned up — which leaves an author who
 * picks a Color seeing nothing at all, and that is a bad control.
 *
 * So the surface keeps a real water tint, just a much lighter one than the old
 * `#438d9c`/`#075779` pair: these impose a transmission filter around 0.2-0.65
 * per channel rather than 0.055 on red. The medium's depth-correct tint then
 * ADDS to something that already looks like water instead of being the only
 * thing standing between a pool and a pane of glass.
 *
 * ⛔⛔ **`thickness` IS ZERO, AND THAT IS THE ANSWER TO THE GHOST REFLECTIONS.**
 *
 * In three it is the distance the refracted ray travels before its exit point
 * is projected back to SCREEN SPACE and used to sample the transmission target.
 * That target holds the whole opaque scene, so a large enough offset reaches
 * pixels of objects that are ABOVE the water — and paints them into it. The
 * result looks like a reflection and behaves like nothing: right way up rather
 * than mirrored, sliding with the screen rather than the world.
 *
 * That is what survived deleting the planar reflector, what survived switching
 * GI reflections off, and what the user reported for days as "those are not
 * even mirror reflections, and they rotate completely incorrectly" and "it
 * looks like water's own reflections". Proven by forcing `transmission` to 0
 * for one frame: every ghost in the scene — the cube's, the ducks', the
 * jetty's — disappeared at once (2026-09-06).
 *
 * At zero the water is still fully transmissive: you see through it exactly as
 * before, and the medium still tints by real path length. What is lost is the
 * BENDING of that view, which is the price of not inventing objects. A
 * refraction that cannot sample above the waterline needs the volume's own
 * geometry rather than a screen-space guess, and is not built.
 */
export const WATER_MATERIAL_PATH = "builtin:Water.mat";
export function isBuiltinMaterial(path) { return path === WATER_MATERIAL_PATH; }
export function builtinMaterialDefinition(path) {
  if (!isBuiltinMaterial(path)) return null;
  return {
    name: "Water", color: "#8fd8de", roughness: .12, metalness: 0,
    pipeline: { cullMode: "none", transparent: true, depthWrite: false, blendMode: "normal" },
    shaderGraph: { nodes: [
      { id: "appearance", type: "waterColor", position: { x: -340, y: 100 }, props: { shallow: "#8fd8de", deep: "#2f7d92", opticalDepth: 1.2, absorption: .35, foamHeight: .07, foamAmount: .35 } },
      { id: "output", type: "output", position: { x: 80, y: 100 }, props: { material: "physical", color: "#8fd8de", roughness: .12, metalness: 0, ior: 1.333, specularIntensity: 1, transmission: .9, thickness: 0, opacity: 1 } },
    ], edges: [{ source: "appearance", sourceHandle: "out", target: "output", targetHandle: "color" }] },
  };
}
