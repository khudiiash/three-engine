// gi19 worktree: same config as the repo, but a PRIVATE dependency cache so
// this server never shares node_modules/.vite/deps with the main tree's
// servers (three vite processes clobbering one cache duplicated React/three
// module instances and invalidated the whole 08-26 gate battery).
import base from "./vite.config.js";
import path from "node:path";
export default async (env) => {
  const cfg = typeof base === "function" ? await base(env) : base;
  return { ...cfg, cacheDir: path.resolve(".vite-move") };
};
