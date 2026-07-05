import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Warm the dep cache before the WebView asks for the first import. Cuts
    // several seconds off `tauri dev` cold start because Vite would
    // otherwise transform three/webgpu + dockview on demand.
    warmup: {
      clientFiles: ["./index.html", "./src/main.jsx"],
    },
  },

  // Pre-bundle deps that are large, slow to transform, or imported from
  // many different lazy chunks. Without this Vite re-esbuilds them per
  // import path on first load, which stretches `tauri dev`'s first WebView
  // paint to multi-seconds.
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "dockview-react",
      "@xyflow/react",
      "three",
      "three/webgpu",
      "three/addons/controls/OrbitControls.js",
      "three/addons/controls/TransformControls.js",
      "lucide-react",
      "zustand",
      "immer",
      "esbuild-wasm",
      "nanoid",
    ],
  },
}));
