// editor-console worktree: private dependency cache + dedicated port.
import base from "./vite.config.js";
import path from "node:path";
export default async (env) => {
  const cfg = typeof base === "function" ? await base(env) : base;
  return { ...cfg, cacheDir: path.resolve(".vite-console"), server: { ...(cfg.server || {}), port: 5211, strictPort: true } };
};
