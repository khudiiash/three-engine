/**
 * KayKit integration. Browse/import UI is editor-only (Window ▸ KayKit) and
 * gates itself on this module being enabled; downloads land in the project's
 * KayKit/ folder as ordinary GLB-unpacked assets, so nothing here ships with
 * an exported game — the module exists so the panel has something to be
 * enabled by, and so the project records that its assets came from here.
 *
 * Source is the official KayKit-Game-Assets GitHub account, not itch.io (also
 * official, and already covered by the itch.io panel) — GitHub serves per-file
 * GLBs anonymously, which is what makes per-character and per-prop imports
 * possible without an account or a pack-sized zip.
 */
export const kaykitModule = {
  id: "kaykit",
  name: "KayKit",
  category: "Assets",
  tags: ["editor-import", "assets", "models", "gltf", "cc0", "characters", "animated"],
  description:
    "Browse KayKit's free CC0 low-poly packs — animated characters (Adventurers, Skeletons) plus dungeon, city and space prop sets — and import per file, no account needed. Characters ship with their animation clips embedded.",
  version: "1.0.0",
  components: [],
  async setup() {
    return {};
  },
};
