// GI2 soup-cache invalidation: triangle group/active-slot topology rebuilds;
// plain palette value changes remain uniform-only re-tints.
import {
  gi2SoupTopologyKey,
  gi2SoupUpdateKind,
  normalizedSoupGroups,
} from "../src/modules/gi/window/soupTopology.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const opaque = () => ({
  transparent: false,
  isVolumeNodeMaterial: false,
  userData: {},
  color: { r: 0.2, g: 0.3, b: 0.4 },
  emissive: { r: 0, g: 0, b: 0 },
});
const geometry = {
  uuid: "shared-geometry",
  index: { count: 12 }, // four triangles
  groups: [
    { start: 0, count: 6, materialIndex: 0 },
    { start: 6, count: 6, materialIndex: 1 },
  ],
};
const mesh = { uuid: "mesh", geometry, material: [opaque(), opaque()] };
const base = gi2SoupTopologyKey([mesh]);

mesh.material[0].color.r = 0.91;
mesh.material[1].emissive.g = 40;
const recoloured = gi2SoupTopologyKey([mesh]);
check("plain color/emissive edits keep the soup topology key", recoloured === base);
check("plain palette edits schedule retint only",
  gi2SoupUpdateKind(base, recoloured, true) === "retint");

geometry.groups[0].count = 3;
const rangeChanged = gi2SoupTopologyKey([mesh]);
check("group count changes invalidate the soup key", rangeChanged !== base);
check("topology changes schedule a soup rebuild even without a generic content delta",
  gi2SoupUpdateKind(base, rangeChanged, false) === "rebuild");
geometry.groups[0].count = 6;

geometry.groups[1].materialIndex = 0;
const slotChanged = gi2SoupTopologyKey([mesh]);
check("group materialIndex changes invalidate triangle palette mapping", slotChanged !== base);
geometry.groups[1].materialIndex = 1;

// Ordering is not topology: the worker sorts ranges before consuming them.
geometry.groups.reverse();
check("semantically identical reordered groups keep a deterministic key",
  gi2SoupTopologyKey([mesh]) === base);
geometry.groups.reverse();

mesh.material[1].transparent = true;
const inactive = gi2SoupTopologyKey([mesh]);
check("deactivating a referenced material slot invalidates soup membership", inactive !== base);
mesh.material[1].transparent = false;
check("reactivating the slot returns to the original topology", gi2SoupTopologyKey([mesh]) === base);

// The actual finish-build path supplies explicit materialActive arrays on
// enriched placements; cover that form independently of live materials.
const placement = {
  geometryKey: "g0",
  mesh: { geometry },
  materialActive: [true, false],
};
const placementInactive = gi2SoupTopologyKey([placement]);
placement.materialActive = [true, true];
check("explicit worker active-slot topology participates in the cache key",
  gi2SoupTopologyKey([placement]) !== placementInactive);

const normal = normalizedSoupGroups(geometry);
check("group normalization matches worker triangle ranges",
  normal.length === 2
    && normal[0].start === 0 && normal[0].end === 2
    && normal[1].start === 2 && normal[1].end === 4);
check("unchanged content schedules no soup work", gi2SoupUpdateKind(base, base, false) === "none");

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
