import { defineConfig } from "vite";
import { renameSync } from "node:fs";

// Builds the standalone game player (no React, no Tauri) into dist-player/,
// used as the template by the editor's File → Export Game.
export default defineConfig({
  build: {
    outDir: "dist-player",
    rollupOptions: { input: "player.html" },
    chunkSizeWarningLimit: 2500,
  },
  plugins: [
    {
      name: "rename-entry-to-index",
      closeBundle: () => renameSync("dist-player/player.html", "dist-player/index.html"),
    },
  ],
});
