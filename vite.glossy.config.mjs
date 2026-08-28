// rc5-glossy worktree: same config as the repo, but a PRIVATE dependency cache
// and its own port so this server never shares node_modules/.vite/deps with
// the main tree's or the gi19 tree's servers.
import base from "./vite.config.js";
import path from "node:path";
export default async (env) => {
  const cfg = typeof base === "function" ? await base(env) : base;
  return {
    ...cfg,
    cacheDir: path.resolve(".vite-glossy"),
    server: { ...(cfg.server || {}), port: 5207, strictPort: true },
  };
};
