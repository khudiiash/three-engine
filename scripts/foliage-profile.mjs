// Read-only probes of the current editor, with argument-safe invocation on Windows.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const stage = process.argv[2] ?? "baseline";
const op = (name, args = {}) => {
  const result = spawnSync(process.execPath, ["scripts/engine-op.mjs", name, JSON.stringify(args)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 90_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};
const result = {
  time: new Date().toISOString(),
  foliage: op("entity_list", { nameContains: "Scatter" }),
  settings: op("scene_getSettings"),
  stationary: op("profile_frameStats"),
  orbit: op("profile_orbit", { seconds: 8, phases: true, spikes: true, spikeThresholdMs: 16 }),
};
mkdirSync("artifacts/foliage", { recursive: true });
writeFileSync(`artifacts/foliage/performance-${stage}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ stationary: result.stationary, orbit: result.orbit }, null, 2));
