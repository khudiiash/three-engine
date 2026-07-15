import { setBasisCompressionEnabled } from "../../engine/textureAsset.js";

/**
 * Basis Universal texture compression module.
 *
 * Enabling it makes the editor create Basis KTX2 derivatives for imported
 * textures. Disabling the module makes runtime texture loads fall back to the
 * editable source images while preserving per-texture overrides for later.
 */
export const basisModule = {
  id: "basis",
  name: "Basis Compression",
  category: "Optimization",
  tags: ["compression", "texture", "ktx2", "import-time"],
  description:
    "Automatically compresses imported textures with Basis Universal and transcodes them to a GPU-native format at load time.",
  version: "1.0.0",
  components: [],
  async setup() {
    setBasisCompressionEnabled(true);
    return {
      dispose() {
        setBasisCompressionEnabled(false);
      },
    };
  },
};
