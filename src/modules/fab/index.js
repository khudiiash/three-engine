/**
 * Fab integration. Browse/import UI is editor-only (Window ▸ Fab) and gates
 * itself on this module being enabled; downloads land in the project's Fab/
 * folder as ordinary GLB-unpacked assets, so nothing here ships with an
 * exported game — the module exists so the panel has something to be enabled
 * by, and so the project records that its assets came from here.
 *
 * Alone among the asset browsers this one needs no API key: Fab's read API and
 * its download URLs for free assets are served anonymously.
 */
export const fabModule = {
  id: "fab",
  name: "Fab",
  category: "Assets",
  tags: ["editor-import", "assets", "models", "gltf", "glb", "fbx", "cc-by", "epic"],
  description:
    "Browse Fab — Epic's marketplace, the merged home of the Unreal Marketplace, the Sketchfab store and Quixel Megascans — and import its free Creative Commons Attribution assets. Most ship glTF/GLB alongside the Unreal build, and a single listing is often a whole pack. No API key needed; CC-BY requires crediting the creator, which the import writes into ATTRIBUTION.md.",
  version: "1.0.0",
  components: [],
  async setup() {
    return {};
  },
};
