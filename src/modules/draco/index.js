/**
 * Draco compression module.
 *
 * Enabling this module turns on automatic Draco mesh compression of models as
 * they're imported into the assets registry (the editor-side work lives in
 * src/editor/dracoCompress.js, gated on this module being enabled). There is
 * no runtime component or system: decoding is always wired into the shared
 * GLTF loader (src/engine/gltfLoader.js), so compressed models load
 * transparently whether or not the module is enabled. The module exists so the
 * behavior is a discoverable, per-project toggle in the Modules panel and so
 * exported scenes record that a project used it.
 *
 * Like every module it must stay React/Tauri-free — it ships with exported
 * games.
 */
export const dracoModule = {
  id: "draco",
  name: "Draco Compression",
  category: "Optimization",
  tags: ["compression", "mesh", "gltf", "wasm", "import-time"],
  description:
    "Automatically compresses imported models with Draco mesh compression; decoded transparently at load time.",
  version: "1.0.0",
  components: [],
  async setup() {
    // Decoding is global (see gltfLoader.js); nothing to spin up per engine.
    return {};
  },
};
