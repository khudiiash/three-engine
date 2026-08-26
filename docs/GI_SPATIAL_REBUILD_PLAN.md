# ⚠ SUPERSEDED FOR "WHAT NEXT" — READ `docs/GI_SCALE_PLAN.md` (§19, 2026-08-26)

The §19 scale plan replaces every "next unit" list below with a staged
restructure (window clipmap + bit-DDA + screen probes + fixed budgets). This
file stays as the history and the receipts for §1-18.

# GI: emitter delivery fix + world-anchored spatial rebuild

---

## ▶ NEXT SESSION STARTS HERE

# ══ §18.16 — THE CPU IS DRAW SUBMISSION, NOT GEOMETRY (2026-08-25) ══

## ⭐⭐ THE CONTROLLED EXPERIMENT THAT SETTLES "IT MUST BE THE TRIANGLES"

Merging deletes NO triangles — it submits the same ones in fewer draws. That
makes it a clean control, and it was already in hand:

| step | draws | triangles | CPU |
|---|---|---|---|
| baseline | 1153 | 7.27 M | 44.5 ms |
| + `shadowMerging` | 672 | **7.30 M (+0.5%)** | **33.9 ms** |
| + non-caster merge | 527 | 5.86 M | 29.3 ms |
| later boot | 466 | 6.01 M | 28.7 ms |

**Triangles rose 0.5% while CPU fell 24%.** Per-draw cost measured
**~35-45 µs regardless of triangle density** (shadow pass 1.13 M tris in 49
draws; main pass 2.02 M tris in 299). Of 17.4 ms GPU, **~15.6 ms is GI compute**
— leaving ~2 ms for all 6 M triangles. ⛔ **VIRTUAL GEOMETRY IS THE WRONG AXIS**
and structurally conflicts with both merge systems (they bake world-space
vertices; VG swaps geometry in place). ⛔ **OCCLUSION CULLING IS A NET LOSS
HERE**: 570 occluder draws to cull 74 of 1040 (7%), CPU 33.9 → 38.3 ms. Full
ledger: memory `bistro-cpu-is-draws-not-triangles`.

## ✅ G1 SHIPPED — THE GI G-BUFFER DRAWS THE DEPTH PROXIES

`renderGiGBuffer` was the frame's second full scene submission: **317 draws /
10.96 ms**, `floorIfMerged` 9. `shadowMerge.js` had already merged that same
geometry on the same "what does a depth pass read" key, so the prepass now draws
ITS proxies instead of their members. Proxies gained a world-space `normal`
(`mergeGeometries` applies the normal matrix) and advertise eligibility with a
new additive **`GI_DEPTH_LAYER` (bit 20)**, set only when the built geometry
really kept normals. `#collectCasters` now also takes NON-casters (`casts` is in
the depth key, so each proxy is homogeneous and inherits the right
`castShadow`) — on Bistro they were most of the draws that survived the first
cut. **Result: prepass 10.96 → 5.5 ms, draws 1153 → 466-527, CPU 44.5 → 28.7 ms.**

⚠ **THE SUBSTITUTION IS ALL-OR-NOTHING PER GROUP.** Draw a proxy while any
member is independently hidden and that member's triangles reappear as geometry
nothing on screen has; hide members without drawing the proxy and the street
vanishes from GI. Both silent. Sharp/medium-tier groups are skipped WHOLESALE
and checked **per frame** — `GI_SHARP_LAYER` is written when an async roughness
floor lands, so a build-time answer is the blind-census bug again. Receipt:
`profile.frameStats.shadows.gbufferSwap` = `{groups, used, unsafe, parkedSharp,
parkedHidden, hidden}`. Gates: `test:shadow-merge` 26 checks, `test:merging`,
`test:shadow-freeze`; every new guard fail-verified.

⚠ **A FIXTURE BUG FOUND ON THE WAY**: `run-shadow-merge-test.mjs`' `step()` set
`_dirtiedAt = 0` to "skip the settle debounce", but Node's `performance.now()`
counts from PROCESS START — early in a run `now - 0` is UNDER `SETTLE_MS`, so
"0" ARMED the debounce instead of skipping it. Every REBUILD was silently
skipped (the first build passes because `groups.length === 0` bypasses the
guard), and the suite passed or failed on how long earlier tests took. Now
`-Infinity`. Same trap the merging tests already carry a banner for.

## ⛔ RENDER BUNDLES: SHIPPED OPT-IN, MEASURED NET ZERO — AND WHY

`performance.renderBundles` parents merge proxies into a three `BundleGroup`.
Within ONE boot, identical 556 draws: renderEncode 16.32 → 15.33, but
gbufferPrepass 8.37 → 9.25; **total CPU 33.03 both ways.**

**ROOT CAUSE, AND IT IS OURS:** `NodeMaterialObserver.needsRefresh()` returns
`true` on `hasNode` BEFORE it ever reaches the `isBundle` / `isStatic` fast
path, and `containsNode()` is true if ANY material property is a node. GI's
`#markObservedMaterial` sets `material.giMonitorNode = float(0)` **precisely to
force that** — and GISystem's resize path depends on it ("every observed
material has hasNode = true, so its bindings refresh per frame") to re-point
persistent nodes at new targets without a shader rebuild. So the bundle skips
only the GPU encode; three still runs `updateBefore` → `geometries/nodes/
bindings.updateForRender` → `updateAfter` per object per frame. **This also
means `object.static` can never help any GI scene.**

▶ **NEXT UNIT: make that refresh EVENT-DRIVEN** (on GI resize/rebuild) instead
of per-frame. It unblocks render bundles AND `static`, and it is the same wall
as the ~21% of JS time in material cache-key hashing ([[camera-motion-perf]]).

⚠⚠ **A BUNDLE IGNORES THE LAYER MASK.** `_projectObject` handles
`isBundleGroup` OUTSIDE its `layers.test(camera.layers)` branch, and bundles key
on `(group, camera, renderContext)` — the g-buffer's pass 1 and its mirror-mask
pass 2 share all three, so a pass-1 bundle would replay into pass 2 and stamp
every proxy into `giNormal.w = 1`: the four-times-reverted masked-mode failure
by a new road. `visible` is the ONLY gate checked before the bundle branch, and
is what `renderGiGBuffer` uses to hold bundles out of pass 2.

## ▶ THE NEXT UNIT, SPECCED — AND THE TWO FACTS THAT SHAPE IT

**FACT 1: `hasNode` SHORT-CIRCUITS BEFORE `object.static`.** `needsRefresh()`
tests `hasNode` first and only reaches `renderObject.object.static` if it is
false. The observer is built from **whichever material actually renders the
object**, so the same mesh can be blocked in one pass and free in another:

| pass | material the observer sees | `hasNode` | is `static` reachable? |
|---|---|---|---|
| main colour | the mesh's own (GI-marked; uber adds colorNode/normalNode/…) | **true** | no |
| ShadowMap | three's depth override | **false** | **YES** |
| GI g-buffer | `gbuffer.material` (MeshBasicNodeMaterial, `lights = false`) | **false** | **YES** |

⇒ **SAFE GROUND, NO GI CHANGES NEEDED:** marking a genuinely unmoving mesh
`static = true` costs nothing in the main pass (short-circuited) and skips
`updateBefore` → `geometries/nodes/bindings.updateForRender` → `updateAfter` in
the two override passes — which is ~400 of the frame's draws. Neither override
binds anything GI re-points, so there is no stale-binding exposure at all.
✅ Already done for the depth proxies (`proxy.static = true`, gated by
`test:shadow-merge`; too small a population — 69 of ~693 draws — to measure).
▶ **TO EXTEND IT to the ~165 unmerged entity meshes in the g-buffer, they need a
MOTION WATCHER first**: `static` skips the binding update, so a mesh that moves
afterwards draws at a STALE TRANSFORM (wrong GI lighting, wrong shadow) — a
silent bug. `shadowMerge#watchForMotion` covers only absorbed members; this
needs its own, on the same round-robin amortisation. That is the unit.

**FACT 2: THE PER-FRAME REFRESH IS NOT WHAT MAKES A GI TARGET SWAP LAND — THE
TEXTURE VERSION IS.** `createGiTargets`' own banner says it: three invalidates a
cached bind group only when `binding.generation !== textureData.generation`, and
`textureData.generation` IS `texture.version`; a fresh texture is version 0, so
GI forces `++targetGeneration` per generation or the swap is invisible and the
next submit dies with "Destroyed texture used in a submit".

⇒ The generation check lives INSIDE `bindings.updateForRender`, which is what
`needsRefresh: false` skips. So dropping `giMonitorNode` does not need targets to
become stable — it needs **ONE guaranteed refresh per render object after a
re-point**. `equals()` cannot supply it (it monitors the world matrix and the
material's own uniforms, never node texture values), and `static = false` alone
cannot either. The candidate hammer is `material.needsUpdate = true` on the
observed set at re-point time, which rebuilds the node-builder state and trips
`firstInitialization` — and may be CHEAP rather than a compile wave, because
`NodeManager.nodeBuilderCache` is keyed on the material cache key and the key
does not change. **PRICE THAT BEFORE BUILDING ON IT.**

⛔ Do NOT start with an in-place `setSize` refactor of the ~20 targets. It was
the first plan and Fact 2 retires it: the rebind path is already solved, and
that refactor would touch the exact code with the documented dead-binding and
black-field scars for no additional benefit.

## ⚠ TWO THINGS LEFT OPEN, NEITHER CAUSED BY THE ABOVE

1. **"Cast shadows disappeared."** Reproduces with `shadowMerging` OFF, and
   survives reverting the WHOLE GI module in stages (`GISystem`, `giScreen`,
   `giLight`, `lightTree`, `reflectionProbeCapture`). The shadow map renders
   correctly in every arm — **49 draws / 1,126,001 triangles**. But the
   HEAD-`GISystem` arm renders DARK and high-contrast, like the last known-good
   frame. ⇒ Best hypothesis: **not a shadow-map failure but indirect light
   grown bright enough to fill the shadows in** — which is exactly what the
   uncommitted `giLight.js` work targets ("shadowed walls went near-black").
   NOT PROVEN; settle it with `__giColourProbe`'s `irradiance` in both arms.
   ⚠ `shadows: false` is NOT a valid A/B: it only stops the map UPDATING, it
   does not remove the compiled shadow branch. Exposure IS a valid instrument
   check (0.3 visibly darkens), and `environment.intensity = 0` barely changes
   the image — GI owns the indirect here.
2. **`shadowMerging` costs the shadow pass 1.67 M triangles** (2.80 M → 1.13 M).
   The draw collapse is the point; the triangle loss is not, and it predates
   this session's work.

# ══ §18.15 — THE GREEN REFLECTIONS, LOCALISED TO ONE TERM (2026-08-25) ══

## ⭐⭐ THE FINDING, AS A MEASUREMENT

`npm run probe:gi-green` (scripts/run-gi-green-terms.mjs) drives a new **term
mask** — a vec4 uniform inside `createGiBvhHitShade`, one scalar per term of the
reflected radiance — and reads the §18.13 colour probe back once per arm. The
reflected radiance is a SUM of four independently-sourced terms and
`bvhRadiance` only ever shows the sum, which is why FIVE code-reading theories
about this cast have now been wrong. Bistro, ultra, settled:

| arm (mask) | rgb | green | lum |
|---|---|---|---|
| all — shipped (1,1,1,1) | 6.1 / 9.4 / 6.3 | **×1.52** | 8.5 |
| gather only — the field (1,0,0,0) | 3.1 / 3.2 / 3.3 | ×0.99 | 3.2 |
| probe atlas only (0,1,0,0) | 0.0 / 0.0 / 0.0 | — | 0.0 |
| **emitter direct only (0,0,1,0)** | 1.7 / **4.9** / 1.6 | **×2.99** | 4.0 |
| analytic/sun only (0,0,0,1) | 1.4 / 1.4 / 1.3 | ×1.02 | 1.4 |
| all **minus emitter** (1,1,0,1) | 4.5 / 4.5 / 4.6 | **×1.00** | 4.5 |

**Removing one term takes the cast from ×1.52 to exactly ×1.00.** Two things to
read off it: the emitter term is a near-pure green wash, and it carries MORE
LUMINANCE THAN THE SUN (4.0 vs 1.4) in a daylit street — so it is not only the
wrong colour, it is the wrong magnitude. Note also that the probe atlas
contributes ZERO here: §18.12's chroma-import fix was real, but on this scene
that term is inert, which retires it as a suspect.

⚠ The aggregate the harness prints alongside kills the "it is just the scene's
green neon" answer for good: **116 emitters, power-weighted chroma ×1.42, with
17 strongly-green emitters carrying 21% of emitted power** — and the FIELD,
which delivers all 116 through the light tree, reads ×0.99. The same scene's
emitters are neutral when delivered properly.

## ⭐⭐ THE CAUSE — TWO DESCRIPTIONS OF THE SAME LAMPS

- the resolve (`giScreen.js:647`) and the emitter shadow pass
  (`giScreen.js:1701`) load emitters from **LIGHT TREE RECORDS** — split into
  connected pieces by `splitSparseEmitter` and fill-damped by
  `emitterFromMesh`;
- the exact-reflection hit shading uses the **GLOBAL ANALYTIC SEATS** instead,
  deliberately and by comment ("a hit is a different world point — its tile is
  not this pixel's"), and a seat was the RAW material emissive on a shape
  fitted to the WHOLE MESH (`#buildEntries` → `#refreshEmitterSlots`, whose OBB
  fallback is `geometry.boundingBox`).

**THE SEAT DUMP IS THE PICTURE** (`profile.frameStats.giEmitterSeats`, Bistro):

```
slot 0: rgb 0.00/0.00/0.00   r 20.94m at -6.7,6.0,-16.9
slot 1: rgb 0.00/0.00/0.00   r 20.88m at -6.6,6.0,-16.9
slot 2: rgb 0.00/0.02/0.00   r  3.87m at -6.4,4.3, -7.8     ← pure green
slot 3: rgb 0.00/0.02/0.00   r  3.87m at -4.7,4.0, 3.9      ← pure green
```

Every reflection in the scene was lit by **two 21-metre emitters and two
3.9-metre ones, half of them pure green** — the whole-mesh bounding spheres of
string-light meshes, not lamps. (The rgb column above is already damped by the
fix; undamped, slots 2 and 3 are radiance 10 green.) Nothing logged this before,
which is why five theories could each sound right.

§13.7g already measured what that costs and the log says it out loud: a glTF
puts a whole string of party bulbs in ONE mesh, both irradiance models scale
with the fitted shape's projected area, and **Bistro's string lights measured
fill 0.0035 — ~285× too much light**. The tree was fixed in §13.7g/h. The
analytic seats never were, and the reflection hit shading is their biggest
consumer. The chroma follows the energy because the sparsest emitters in this
scene are the saturated ones.

## THE FIX

`#refreshEmitterSlots` damps each seat's colour by its mesh's **pre-split**
fill, which `collectEmitters` now hands back as `out.meshFits` (the post-split
list cannot answer the question — every piece reads fill ≈ 1 by construction).
Total power is preserved exactly: `π·crossSection·(L·area/crossSection) =
π·area·L`, the same identity the tree's own damping rests on. A seat cannot BE
several pieces, so damping is its whole correction — and it is the same
correction from the same fit, not a new model.

Receipts: `[gi] emitter seats: N of 4 damped …` names slot and fill;
`__giEmitterSeatFill = false` reverts; `profile.frameStats.giEmitterSeats`
reports each seat's rgb, green ratio and radius live. Bistro's line reads
**`slot:fill 0:1.8e-4, 1:6.0e-5, 2:1.9e-3, 3:1.7e-3` — 526× to 16,700× too
bright**, all four of them.

### ⭐ THE FIX, MEASURED ON THE SAME RIG

| arm | rgb | green | lum | before |
|---|---|---|---|---|
| all (shipped) | 5.1/5.1/5.2 | **×1.00** | 5.1 | ×1.52, lum 8.5 |
| gather only | 3.4/3.5/3.7 | ×0.99 | 3.5 | 3.2 |
| **emitter only** | **0.0/0.0/0.0** | — | **0.0** | ×2.99, lum 4.0 |
| sun only | 1.4/1.4/1.3 | ×1.02 | 1.4 | 1.4 — UNCHANGED |

The controls are what make this a result rather than a coincidence: the sun term
is identical before and after, the field is within run spread, and the ONE term
that moved is the one the mask identified. Gates: `test:gi-hit-shade`,
`test:gi-emitter-power` (16), `test:gi-emitter-split`, `test:gi-emitter-shapes`
(855) all green.

⚠ **THE EMITTER TERM AT HITS IS NOW EXACTLY ZERO, NOT MERELY SMALLER.** Damped
by 5000–16,000×, these seats fall under `emitterCutoff`'s fade and are zeroed
outright. Two reasons that is acceptable and one reason it is temporary: the
fill damping is exact in the FAR field by construction (`emitterFromMesh` says
so) and these shapes are 21 m across, so the near field it under-serves is
inside the fitted volume; emissive light still reaches reflections through the
gather, since the light tree's NEE carries all 116 emitters. But a NIGHT scene
would want that direct term back, and it should come from a per-hit tree
sample, not from a bigger constant.

ALSO FIXED, same class: `reflectionProbeCapture.js` was still on
`maxTraceDistance: 4` after §18.14 raised its documented twin to 16 — "one
formula, two consumers" with two different occlusion horizons.

▶ **DEBT**: both march caps are still constants in METRES; they want a fraction
of the GI volume extent, which GISystem knows and neither kernel does.

▶ **THE REAL FIX IS STILL AHEAD.** Damping makes the four seats deliver their
TRUE share, which is small — so reflections now get much less emitter direct
than they did, and the diffuse field loses the analytic copy it was
double-counting alongside the tree's NEE. Correct, but the reflection hit path
still lights a 116-emitter scene from four seats chosen by scene-wide power.
The right answer is a per-hit light-tree sample (the tile cut cannot serve an
off-screen point, which is why the seats were used at all).

## ⛔⛔ FOUR MORE BLIND-INSTRUMENT TRAPS, SAME DAY

1. **The rig measured the wrong scene.** Bistro is saved with
   `global-illumination.reflections: false`; a plain boot has no exact chain, so
   the rig read the diffuse frame while reporting on reflections. Now forced ON
   at scene READ by a shim `load_scene` override — nothing is written back.
2. **Flipping the prop LIVE is a different experiment.** It rebuilds the GI
   mid-session, and the run that did it read `bvhRadiance` as uniformly BLACK on
   every arm — a second compile wave was still landing while the arms sampled.
   The verdict block cheerfully named "gather only" the greenest term. **The rig
   now refuses to report when the shipped image is black**, with its own retry.
3. **Editing anything under `src/` while a puppeteer harness runs invalidates
   the run** — vite HMR reloads the page mid-measurement.
4. **`Engine.init` → "reading 'backend'" on a null renderer** hit 4 of 8 boots,
   on the SCENE LOAD as often as the first boot: no WebGPU device, most likely
   GPU pressure from the user's own editor (9 GB heap) on the same card. The
   retry has to wrap the load, not just the hub click.

# ══ §18.13/14 — THE COLOUR PROBE, AND FOUR BLIND INSTRUMENTS (2026-08-25) ══

## ⛔⛔ THE LESSON OF THE DAY, BEFORE THE FINDINGS

**Three theories about "all reflections are greenish" were wrong in a row**, each
plausible from reading the code, none surviving the user's screen:
1. the scene's own green neon (a subagent panel's high-confidence answer);
2. the §18.7 emitter cull removing warm balance;
3. the probe-atlas chroma import at giScreen.js:849.

(2) and (3) were real defects worth fixing on their own merits — they were not
THIS bug. **The pattern is reasoning where measuring was possible.**

**FOUR instruments reported confidently about subjects they could not see, in
one day:**

| instrument | how it lied |
|---|---|
| `_tierTally` census | counted at BUILD time, before the async GPU roughness floors landed — "0 sharp" on a scene of mirrors |
| `hitHistWeightAtMotion` | PEAK-HELD its best case, so it could only ever report good news |
| `_bvhHitShadeHeldFrames` | counted a DECISION, not a DISPATCH — wrote "0, healthy" on frames the idle list had already dropped the pass |
| `__giColourProbe` (mine) | sampled at tick 31, before the reflection chain had dispatched — reported `rgb 0.0/0.0/0.0` for empty textures and called them black |

The fourth is the sharpest: **I had already fixed exactly this `settled`-and-reset
discipline on the mask-coverage probe hours earlier and did not carry it over.**

⭐ **RULE: when a receipt says "fine" and the user says "broken", suspect the
receipt first. And gate every probe on its subject EXISTING, resetting the
counter whenever it does not.**

## ⭐⭐ THE COLOUR PROBE (`__giColourProbe`) — THE ONE THAT WORKED

Reads back each stage of the reflection chain and reports mean RGB plus a green
ratio `g/((r+b)/2)`. Exposed as `profile.frameStats.giColourProbe`. Bistro, ultra,
settled (90 frames after the chain was live):

| stage | rgb | green |
|---|---|---|
| `bvhColor` — raw hit albedo | 170.5 / 170.5 / 170.5 | **×1.00** |
| `bvhRadiance` — shaded hit | 67.1 / 101.1 / 73.5 | **×1.44** |
| `irradiance` — diffuse field | 182.2 / 191.5 / 208.3 | **×0.98** |

**Albedo in is neutral. The diffuse field is neutral. The green is MANUFACTURED
BY THE HIT SHADING.** One reading localised what three sessions of theory could
not. This is the template for any future "wrong colour" report.

## §18.14 — THE 4 m EMITTER MARCH CAP AT REFLECTION HITS

`createGiBvhHitShade` passes `maxTraceDistance: 4` to the emitter shadow march,
and its own header calls that "a soft, bounded leak, reflections only": an
occluder further than 4 m from the hit point STOPS OCCLUDING. Bistro is a ~47 m
street, so every reflected surface across the road took the green shopfront neon
**unshadowed** — the whole cast, from one term.

⭐ **RAISING IT IS NEARLY FREE**, which is why it beats damping the emitter:
`shadowTraceFn(..., maxT, float(32), ...)` is a FIXED 32 steps, so `maxT` sets
step SIZE, not step COUNT. Reach costs precision, never time. Set to **16 m**
(0.5 m/step, ~2 GI cells at this scene's 1 m spacing). `__giHitEmitterMarchCap`
is the A/B. ⚠ Still a constant in METRES — derive it from the GI volume extent
(GISystem knows it, the kernel does not). Same class as the two constants this
session already had to retract.

## §18.10 — THE TWO-SIDED COSINE (fixed, user-confirmed)

`analyticDirectAt` takes `dot(dirTo, N).abs()` because it shades a FIELD CELL,
which has no side. `createGiBvhHitShade` shades a HIT and face-forwards its
normal one line earlier — so every reflected surface pointing AWAY from the sun
took the sun's FULL irradiance where the same surface rendered directly takes
zero. `srcShade.js:239` already clamps for exactly this reason and its header
spells out the trap. Added `oneSided` (default false — every field-cell caller
byte-identical), passed `true` from BOTH hit shaders (the exact reflection and
the probe capture, whose formulas are deliberately identical).
**User-confirmed: this was the "brown patches all over the scene".**

## §18.11 — THE EMITTER GATE HAD TO BECOME RELATIVE

The §18.7 absolute gate (`pi*A*L < 0.05`) was justified from TWO data points and
**culled 26 of Bistro's emitters**, taking the light tree 114 → 88. Emitter
powers are a continuum whose SCALE is an authoring property; no wattage is right
for two scenes. Now a FRACTION of the scene's own total emitted power (0.2%),
applied in `collectEmitters`. Unit-invariant, and it can never empty the tree.
`npm run test:gi-emitter-power` — 16 checks, including the Bistro failure
("a uniformly-lit scene loses nothing").

⚠ ALSO FIXED: `#belowEmitterPowerGate` read `entry.analytic.power`, but
`entry.analytic` is an `analyticShapeOf` result — `{type, center, half}`, no area
and no power. It failed open and the FIELD half of the cull never fired once.
It now consults what `collectEmitters` actually admitted.

▶ **OPEN**: `bvhColor` read 170.5/170.5/170.5 — all three channels identical.
That may mean reflected surfaces carry NO albedo variation (the palette-vs-atlas
R7b gap, and a candidate for the brown patches). The probe reports only the MEAN,
which cannot separate "every texel is grey" from "a varied image averaging grey".
**Add a variance statistic before asserting either.**

# ══ §18.6 — THE IDLE LIST HAD A HOLE (2026-08-25) ══

**USER-CONFIRMED FIXED**: *"reflections are responsive now, that's great."*

## ⭐⭐ THE FINDING

The GI tick's IDLE SLEEP replaces the whole pass queue with a hand-written
"camera-dependent passes only" list (GISystem.js ~3305-3344). Every entry in
that list carries its own comment saying it must ride idle *or it would lag
every camera move*. **The exact-reflection hit chain was not in it** —
`bvhHitShade`, `bvhHitTemporal.filter`, `bvhHitTemporal.snapshot` live only in
`state.queue`, which idle discards wholesale.

Two things turned that omission into a two-second freeze:

```js
const idle = !freeze && globalThis.__giNoIdleSleep !== true &&
  (this._fieldQuietFrames ?? 0) > GI_IDLE_AFTER_FRAMES &&   // 180
  this._frame % GI_IDLE_HEARTBEAT_FRAMES !== 0;             // 30
```

1. **`#fieldInputHash()` HAS NO CAMERA TERM.** It digests light slots, emitter
   slots, sky radiance, `bounceGain`, `_dynSet.version` and three blend knobs —
   and nothing about the view. So orbiting never resets `_fieldQuietFrames`;
   the counter climbs *straight through* the motion.
2. Past 180 quiet frames, idle engages and **stays** engaged while the camera
   moves. The hit chain then dispatches on the heartbeat alone: **1 frame in
   30** — about two seconds at the 15-18 fps this scene moves at.

**Why it looked like a reflection bug.** The TRACE is dispatched outside the
queue, so it kept running every frame: hit `t`, hit normal and albedo stayed
current while the RADIANCE materials sample was frozen — fresh geometry, stale
light. And materials read `bvhRadiance` at `giUV`, the surface's own
reprojection, so the frozen image **translates with the surface** while its
content never changes. The user's words, mechanically: *"reflection just moves
to the side when camera moves to the side, not changing the angle as it
should."* And *"works properly sometimes, then gets overwhelmed"* is not a load
threshold at all — it is the 180-frame timer arming.

## ✅ THE FIX — GATE ON THE VIEW, NOT ON THE WORLD

The chain now rides the idle list whenever `this._gbufHeld !== true`. A parked
camera keeps today's saving (and the held-view cadence at ~3455 still governs
it); a moving camera gets a live reflection. `_gbufHeld` is already computed
each tick and is exactly the "the view has not changed" signal.

⚠ **The general defect is that the idle list is a hand-maintained DUPLICATE of
"which passes are camera-dependent", and it has now silently diverged once.**
Any pass added to `state.queue` must be audited against it. Better still,
derive one from the other.

## ⭐⭐ THE THIRD BLIND RECEIPT IN ONE DAY

`_bvhHitShadeHeldFrames` counts only the frames the HELD-VIEW CADENCE chose to
skip. On every frame the idle list had already removed the pass, the `else`
branch ran and wrote **0 — "not held, healthy"** — while zero dispatches
occurred. It described a *decision*, not a *dispatch*.

Now measured from the queue that is actually submitted:

```js
const dispatching = frameQueue.includes(hitShadeNode);
this._bvhHitShadeGapFrames = dispatching ? 0 : (this._bvhHitShadeGapFrames ?? 0) + 1;
```

**Live confirmation, Bistro at ultra:** `fieldQuietFrames 454` (idle engaged,
not inert), **`hitShadeGapMax 29`** (the predicted 1-in-30, measured), and
`hitShadeHeldFrames 1` against a true gap of 16 — the old receipt understating
by 16x. `hitShadeGapMax` is deliberately a MAXIMUM, not the peak-held best case
that misled this same investigation twice.

⛔ **THE PATTERN, THREE TIMES IN ONE DAY** — the tier census counted before its
inputs resolved; `hitHistWeightAtMotion` peak-held its best case; this counted a
decision instead of a dispatch. **Every one of them reported health while the
subject was broken.** When a receipt says "fine" and the user says "broken",
suspect the receipt first.

▶ **STILL OPEN: emissive/indirect light lags under camera motion**, and the
reflection fix did not touch it (user, same message). Different path — the idle
list DOES contain `resolve`, `irrTemporalPass`, `irrHistoryPass` and the whole
emitter shadow chain, so the cause is elsewhere. Leading suspects: the
irradiance history weight (0.9, and its only motion term is LIGHT motion, never
camera), and probe population churn (measured: cascade-0 live probes 4215 parked
-> 20668 moving, cascade-2 orphanRate 0.035 -> 0.18, knownFrac 0.794 -> 0.752).

# ══ §18.5 — THE LADDER COULD NOT SEE (2026-08-25) ══

Three findings from one morning, all of them instrument problems rather than
algorithm problems. Read this before touching §18's R8.

## ⭐⭐ 1. THE CENSUS WAS COUNTING "NOT KNOWN YET" AS "MEDIUM"

`_tierTally` is filled inside `#collectMeshes`, which runs at **build** time —
before the per-channel roughness floors have come back off the GPU. Every mapped
material is `MEDIUM`-by-default at that moment, so the boot line reported
**"0 sharp, 102 medium"** for a scene whose windows are mirrors, and that
non-finding was nearly used as evidence that the ladder had no population to
work with.

**Fixed by `GISystem.reflectTierCensus()`** — walks at READ time, and keeps
PENDING as its own column. Exposed as `giTiers` in `profile.frameStats`, so it
can be read without a screenshot. First real reading, Bistro at ultra, mid-boot:

| | sharp | medium | coarse | pending |
|---|---|---|---|---|
| materials | 0 | 131 | 3 | **128** |
| meshes | 0 | 1610 | 17 | 1568 |
| triangles | 0 | 4.28 M | 0.28 M | — |

**128 of the 131 "medium" materials were "ask again later".** The census was
blind, exactly as [[probe-blind-statistics]] predicts, and the fix was to teach
the instrument to say so.

## ⭐⭐ 2. THE FLOOR DRAIN WAS COUPLED TO THE FRAME RATE IT EXISTS TO REPAIR

`giRoughnessFloorStats` is what the whole ladder tiers on, and it filled at
**2 materials per 16 FRAMES**, with at most 2 readbacks in flight.

On a mid-boot Bistro sitting at 4 fps that is 16 frames = **four seconds**, so
128 pending floors needed roughly **eight minutes** — and every one of those
minutes is spent tracing full-resolution reflections for materials whose exact
weight is provably zero. The slower the frame, the slower the repair. Backwards.

**Fixed:** the drain now runs on **wall clock** (120 ms) with a batch that scales
to the backlog (8 while >32 pending, 2 when settled), and the in-flight readback
cap went 2 → 6. Each readback is 32x32 ≈ 4 kB; the cap, not the cadence, is the
real bound on GPU stalls.

## ⭐⭐ 3. COARSE SURFACES CAN SKIP THE TRACE — PROVED, NOT ASSUMED

All **three** consumers of the BVH reflection textures gate on the identical
ramp, verified by reading each site:

| site | gate |
|---|---|
| `giLight.js` exact blend | `exactHit.a * smoothstep(0.45, 0.15, roughness)` |
| `giLight.js` mirror trace | `smoothstep(0.45, 0.15, roughness)` |
| `giLight.js` env-on-miss | `smoothstep(0.45, 0.15, roughness)` |

Above roughness **0.45 every one of them is exactly 0**. The ladder tiers on the
map's **floor** (p5 over the texture), and floor > 0.45 ⇒ *every texel* of that
material is above 0.45 ⇒ the traced reflection it pays for is multiplied out of
the image at every pixel.

⚠ This does NOT contradict §16 R4's refutation. R4 removed materials from the
reflection PATH by bucket, which took real light from MEDIUM surfaces
(0.15–0.45), where the ramp is non-zero. This is the COARSE rung only, and the
proof is per-texel rather than per-material.

**`coarseTriangleShare` in `giTiers` is the number that decides R8a's worth.**
Blind (mid-boot, 128 floors unresolved) it read **6%**. Settled it reads **89%**
— the instrument had been reporting very nearly the opposite of the truth.

| | sharp | medium | coarse |
|---|---|---|---|
| materials | 1 | 40 | **93** |
| meshes | 14 | 90 | **1523** |
| triangles | 136 | 509,937 | **4,053,119** |

## ⭐⭐ 3b. R8a IS THEREFORE A MASK-POPULATION CHANGE, NOT A STRIDE CHANGE

The original R8a spec was "tier the block stride". The census says something
simpler and much stronger is available: the prepass already has a mechanism for
skipping pixels — the mirror mask — and it was **pointed at the wrong set**.

`GI_MIRROR_LAYER` is "reads a reflection" = buckets 0 and 3 = **104 of 111
materials** on Bistro, because "has a roughness MAP" is all bucket 3 means. As a
cost lever it excluded nothing, which is why masked mode was all risk and no
reward for three sessions.

**The mask pass now draws `GI_SHARP_LAYER`** — redefined as the ladder's SHARP +
MEDIUM rungs, i.e. floor <= 0.45, i.e. "the traced reflection survives the
blend". That is **104 meshes of 1631**, and the 89% it excludes is multiplied by
zero at every texel.

### MEASURED, live, Bistro at ultra, 1803x887 resolve

| pass | mask off | mask on (tier population) |
|---|---|---|
| **bvhReflect** | **23.22 ms** | **10.09 ms** |
| resolve | 8.94 | 4.72 |
| screen total | 36.67 | 19.29 |
| ao (with the new micro ring) | 1.01 | 1.02 |

⚠ **The two arms are not a perfectly matched pair** — the volume auto-fit slid
between boots (`probes 8980 → 19883`), so the resolve delta in particular is not
attributable to the mask. `bvhReflect` is per-traced-pixel work and the 23.22 →
10.09 halving is structural, but re-measure both arms in one boot before quoting
the frame-level number.

Re-measured on a clean boot with the shipped defaults, floors drained
(`pendingMaterials` 37, `coarseTriangleShare` 0.888):

| pass | settled, shipped |
|---|---|
| **bvhReflect** | **11.82 ms** (from 23.22) |
| **bvhHitShade** | **14.56 ms** — now the frame's largest |
| resolve | 4.79 |
| screen total | 20.40 (from 36.67) |

⚠ **11.82 ms is far higher than the 89% triangle share predicts (~2.5 ms), and
the reason is the next unit's whole premise: TRIANGLES ARE NOT PIXELS.** The
fine set is 104 meshes, but they are the windows, glass and polished floors —
the big ones. Screen coverage fell far less than triangle count did.

### ▶ R8b: bvhHitShade, and why another gate is NOT the answer

The hit-shade already benefits from the mask *logically* — its inner guard is
`hitTexel.x >= 0 && albedoTexel.w > 0.5`, and the prepass writes `t = -1` on
every masked-skip, so masked pixels do no shading work. 14.56 ms is therefore
**not** wasted threads; it is occupancy. This kernel's own header records it:
"register pressure from the cone marcher collapsed the whole kernel's
occupancy". Every workgroup containing even one traced pixel pays the full
register cost, and with the fine set being large contiguous surfaces, most
workgroups contain one. **Adding a `g1.w` gate would change nothing** — do not
spend a session on it.

### ▶ THE NEXT UNIT IS PER-TIER STRIDE *WITHIN* THE FINE SET

This is the roughness ladder the user actually asked for: *"for some surfaces we
need much cleaner reflection while others, like a wet carpet, would do with a
very low res on time trace."*

The census makes the split obvious — **SHARP is 1 material, 14 meshes, 136
triangles.** Essentially the entire fine set is MEDIUM (40 materials, 90 meshes,
510 K triangles), spanning floor 0.15–0.45 where `exactWeight` runs 1.0 → 0.0.
A MEDIUM surface at floor 0.40 has weight ~0.03; at 0.16, ~0.99.

So: **SHARP keeps stride 1; MEDIUM goes to stride 2–3.** giLight already
prefilters the exact reflection by roughness (the 12-tap two-ring hexagonal blur
at giLight.js ~2100, radius `smoothstep(0.02, 0.45, roughness) * 12 texels`), so
a MEDIUM surface's traced image is being blurred anyway — tracing it at full
resolution first is paying for detail that is deliberately destroyed downstream.

⚠ The known hazard is the one that forced ultra to stride 1 in the first place:
at a silhouette, block replication validates neighbours out to −1 and giLight
falls to the PROBE reflection on exactly those texels, interleaving two images
per texel — the "salt-and-pepper stipple" on the user's mirror walls. That
argument applies with full force to SHARP and much less to MEDIUM, whose
prefilter blurs across the stipple. **Implement as two dispatches (SHARP at
stride 1, MEDIUM strided), not as one dispatch with a varying stride** — the
replication/validation logic in `createGiBvhReflect` assumes a uniform block.

## ✅ THE GATE PASSED — MASKED MODE IS ON BY DEFAULT

The standing condition for re-enabling masked mode was a rig asserting that
non-mirror gbuffer pixels survive the mask pass. It exists and it passed:

| arm | `giMaskCoverage` |
|---|---|
| mask OFF | 4096/4096 = **100.0%** |
| mask ON | 4096/4096 = **100.0%** |

`#bvhMaskEnabled()` now returns `globalThis.__giBvhMask !== false`.

⚠ The rig's own first cut was blind in the classic way — it sampled during the
compile wave, where `wantsMirrorMask` is forced false, so a build configured
mask-ON reported "mask OFF". It now requires `wantsMirrorMask ===
#bvhMaskEnabled()` and resets its counter whenever that fails. Its `.catch` logs
rather than swallowing, and the result is mirrored into
`profile.frameStats.giMaskCoverage` so a scrolled-away console line cannot be
mistaken for a clean run.

**GATE ADDED: `npm run test:gi-gbuffer-clear`, 12 checks**, asserting the
`autoClear*` flags and the background at *draw time* (snapshotted inside a fake
`render()`, because reading them after the call returns proves nothing — the
`finally` restores them), plus full restoration including through a throw.
**Negative control run: reverting the fix fails 2 of 12.**

## ⭐ 4. AO's MINIMUM FEATURE SIZE WAS ITS RING RADIUS

**User (2026-08-25):** *"a very weak AO, almost invisible between meshes,
possibly it works only on larger meshes."* That names a RESOLUTION limit, and no
amount of `aoStrength` can reach it.

Both existing rings are anchored in WORLD space (`aoRadius` 0.5 m projected to
pixels), and N taps spread √-uniform over radius r put the innermost at
`r·√(0.5/N)`. At a 900-row resolve, 50° fov, 10 m out:

| | radius | innermost tap |
|---|---|---|
| wide ring | 48 px | 11 px |
| contact ring | 12 px | 3.5 px |
| **a 2 cm gap between two props** | **1.9 px** | — |

Every tap in both rings steps straight over the contact. A large mesh fills a
big share of the 12–48 px disc and shades normally — which is precisely *"it
works only on larger meshes"*.

**Fixed: a third MICRO ring pinned at a fixed 3 px**, 6 taps, phase 2.4.
Two surfaces that touch are adjacent IN PIXELS at every distance — the one
invariant a world-anchored radius throws away. Its falloff still normalizes in
world units, which is what keeps it an occlusion term and not an edge detector:
a tap 2 px away that is 20 m behind is a silhouette against the background and
its falloff sends it to 0. Joins the same multiplicative union,
`1-(1-w)(1-c)(1-m)`.

---

# ══ §18 — THE FRAME, NOT THE FIELD (2026-08-24 night, USER MANDATE) ══

**THE MANDATE (user, verbatim intent):** *"quality is quite great at this point,
we need just to work on performance and speed. It must never get below 60 fps."*
and *"this is not about tuning, this is about making structural changes in order
to achieve better results."* So: §16/§17's quality units are DONE being the
priority. Everything below is frame cost, and a constant is not an answer.

## ⭐ THE FINDING: SHADOW FREEZING HAS BEEN 100% INERT UNDER CSM

Measured live on the user's Bistro at ultra, editor viewport **parked**, static
geometry, not playing — i.e. the best case the engine will ever see:

| | before | after | |
|---|---|---|---|
| CPU frame | 86.65 ms | **22.69 ms** | 3.8x |
| `renderEncode` | 63.22 ms | **15.60 ms** | 4.1x |
| draw calls | 1147 | **376** | -771 |
| triangles | 6.61 M | **2.44 M** | -63% |

The draw ledger said it outright once it was read per pass:

| pass | draws | `floorIfMerged` |
|---|---|---|
| ShadowMap 4096² (cascade 0) | 554 | 8 |
| main rt 1878x1066 | 301 | 9 |
| ShadowMap 4096² (cascade 1) | 288 | 6 |

**842 of 1144 draws were the two shadow cascades, re-rendered every frame on a
scene that had not moved.** `ShadowFreezeSystem` existed, ran (2.0 ms/frame),
and reported itself healthy the whole time.

### The mechanism, exactly

The flag the system writes is `shadow.autoUpdate`, and its ONLY reader is
`ShadowNode.updateBefore` (three r185, ShadowNode.js:855 — `let needsUpdate =
shadow.needsUpdate || shadow.autoUpdate;` gating `this.updateShadow(frame)`).
Two facts about CSM each independently defeat it, and the light has both:

1. **The CSM parent's flag is unread.** `LightComponent#syncCSM` sets
   `light.shadow.shadowNode = this.#csm` (LightComponent.js:597).
   `AnalyticLightNode.setupShadow` takes a custom `shadowNode` and SKIPS
   `setupShadowNode()`, so no `ShadowNode` is ever built for that light and
   nothing reads its `autoUpdate`. Freezing it removes zero draws.
2. **A CSM cascade is not a Light.** `CSMShadowNode._init` builds one
   `class LwLight extends Object3D` per cascade (CSMShadowNode.js:26) with
   `castShadow = true`, a real cloned `DirectionalLightShadow`, wrapped in a
   real TSL `shadow(lwLight, lShadow)` node, added to the scene graph by
   `updateBefore`. It carries **no `isLight`** — verified live against
   r185.1: `isLight: undefined | castShadow: true | ctor: LwLight`.

`ShadowFreezeSystem.update()` filtered candidates with
`object.isLight && object.castShadow && object.shadow`. So it found ONLY the
one object it could not stop, and never the two that owned the maps and DO
honour the flag. `frozenLights` read 1 — a freeze that owned a light it could
not freeze. **Textbook [[probe-blind-statistics]]: the instrument could not see
its subject and returned a clean result.**

### ✅ SHIPPED

- **`collectFreezableCasters(scene)`** (shadowFreeze.js) replaces the
  `isLight` filter and asks the structural question instead — *does a plain
  `ShadowNode` own this map?* Takes anything with `castShadow === true` and its
  own `shadow.camera`; rejects anything whose `shadow.shadowNode` is set (a
  custom node means nothing reads the flag) and GI-mode lights.
- **No feedback loop, and it is verified, not assumed.** This file's standing
  rule is never to fingerprint a value the freeze's own output gates.
  `CSMShadowNode.updateBefore` writes `lwLight.position` / `target.position`
  **ungated by `autoUpdate`** (CSMShadowNode.js:561-563), so the cascade pose is
  an input three refreshes unconditionally — exactly what the rule demands. It
  is also **texel-snapped** upstream (`Math.floor(_center.x / texelWidth)`), so
  the freeze survives sub-texel drift for free.
- **The twin bug, fixed with the same predicate** (sceneSettings.js:526): the
  author's own Scene Settings "shadow auto update" checkbox used the identical
  `isLight` filter, so the manual escape hatch was ALSO inert on CSM scenes.
  Both call sites now share `collectFreezableCasters` — two copies of that
  filter drifting apart is how this survived.
- **A RECEIPT, because the absence of one hid this for as long as CSM has been
  on.** `profile.frameStats` now reports `shadows: { managed, frozen }`.
  `managed: 0` on a shadowed scene = the system cannot see the maps;
  `frozen: 0` while `managed > 0` on a still scene = something keeps
  invalidating them. Live now: `{ managed: 2, frozen: 2 }`.
- **Gate: `npm run test:shadow-freeze`, 20 -> 26 checks.** The six new ones drive
  the REAL `CSMShadowNode` (it instantiates headless — `_init({camera,
  renderer:{coordinateSystem, reversedDepthBuffer}})`), not a mock, because the
  bug was entirely about three's actual object shapes and a hand-rolled stand-in
  would have been built from the same wrong assumption. **Negative control run:
  reverting the predicate to `isLight` fails 4 of the 6 with
  "THE REGRESSION: 2 of 2 cascades still re-render every frame".**

⚠ HONEST CONFOUND: the A/B spans an editor reload, which also reset the heap
(6404 -> 2144 MB), so part of the per-draw improvement (55.1 -> 41.5 us/draw) is
reduced GC pressure rather than the fix. **The -771 draws and -4.2M triangles
are unambiguously the fix**; the ms split between the two causes is not
separated.

## ⛔ WHAT THIS DOES *NOT* FIX — AND IT IS THE MANDATE

A frozen cascade is a **parked-camera** win. Under camera motion the cascade
centre crosses a texel (4096² over a ~60 m cascade ≈ 1.5 cm) and both cascades
correctly redraw — **so a moving camera returns to the 1144-draw / ~63 ms
frame that was measured before the fix.** That measurement IS the under-motion
cost; it is not a projection. For "60 fps under ANY conditions" the redraw has
to become CHEAP, not rare.

## UNITS (next, in leverage order — measured targets, not guesses)

- **▶ F1 — SHADOW-ONLY MERGE — BUILT + STRUCTURALLY VERIFIED LIVE 2026-08-24
  night; ms receipt still owed.** ⭐ On the user's Bistro with
  `performance.shadowMerging = true`: **`mergedProxies: 44, mergedReplaced:
  551`** — 551 individual casters now submit as 44 proxies, against the
  cascade's own 554 draw count. Shadows verified intact by screenshot (awnings,
  lamp posts, chairs, scooter all casting correctly). ⚠ THE ms NUMBER IS NOT
  YET CLEAN: the measurement was taken while the scene was still settling after
  a reload (heap climbing 2.3 → 5.1 GB, texture 566 → 892 MB, GI mid-rebuild,
  `drawCalls` reading 1454 from a rebuild frame). Re-measure on a settled
  Bistro, parked AND while orbiting, before quoting a saving. `src/engine/shadowMerge.js` + `SHADOW_PROXY_LAYER = 22` +
  `performance.shadowMerging` (default FALSE — it rewrites `castShadow` across
  the scene, so a defect reads as MISSING SHADOWS, the more expensive failure).
  Gate: `npm run test:shadow-merge`, 17 checks, all green.
  WHAT IT DOES: collects what the depth pass draws TODAY (merging's batch
  proxies + the meshes merging refused), groups them on the depth key ONLY,
  splits by locality so cascades can still cull, and swaps in position-only
  proxies; originals keep layer 0 and get `castShadow = false`.
  ROUTING (both ends mandatory — see the `SHADOW_PROXY_LAYER` header):
  proxies sit on bit 22 ALONE (`layers.set`, not `enable`), and every shadow
  camera enables bit 22 explicitly in `#syncCSMCascadeShadows` /
  `#configureShadow`. ⭐ CORRECTION TO AN EARLIER ASSUMPTION: no camera in this
  engine calls `layers.enableAll()` (only raycasters do), so a VIEW camera's
  mask is layer 0 plus EDITOR/DEBUG/UI and never bit 22 — the colour pass is
  safe for free. That is exactly why the shadow side is mandatory: the cascade
  would otherwise INHERIT that same mask and the merged half of the scene would
  stop casting entirely.
  GI EXCLUSION (both, deliberately redundant): the proxy's exclusive layer is
  added to `#collectMeshes`' `editorOnly` test and `#gbufferFingerprint`'s
  `skipLayers`, AND the proxy carries `userData.__giDebug = true`, GI's own
  opt-out, so a GI walk added later stays correct by construction.
  ⭐ TWO DEFECTS THE 49-AGENT MAP CAUGHT IN THE FIRST CUT, both fixed + gated:
  (1) **THE RESURRECT/DOUBLE-DRAW CLASS.** `merging.js` claims a member via
  `visible = false` and every component write to `visible` defers to that claim
  (`MeshComponent#applyVisibility`'s banner — six sites used to resurrect
  members and draw them twice; on Bistro that was the load/hang loop). This
  system claims through a DIFFERENT channel, `castShadow = false`, and that
  channel had NO guard: `MeshComponent`:169/:441 and `ModelComponent`:62/:192
  all write `castShadow` unconditionally, so any prop change or model reload put
  the original back in the depth pass with its triangles ALSO inside the proxy —
  once per cascade, invisible in the colour pass, so it reads as "shadows got
  slower" rather than as a bug. Fixed by `applyCastShadow(mesh, value, engine)`,
  routed through all four sites: asymmetric like the visibility rule (OFF
  applies immediately — it cannot resurrect; ON is deferred to the owner), the
  authored value is recorded so `#teardown` REPLAYS it instead of writing a
  blanket `true`, and any change invalidates the merge.
  (2) **MOVERS.** A merge bakes world-space vertices, so a caster that moves
  afterwards leaves its shadow standing where it used to be. `merging.js`
  carries `#watchForMotion` for exactly this; this system needs its OWN because
  it absorbs a strictly larger set (every caster, including the ~429 meshes
  merging refuses), so merging's watcher does not cover them. Added, amortised
  over 4 frames on a round-robin cursor, and a caught mover joins a permanent
  `_movers` set so it is left unmerged rather than re-absorbed every frame.
  ⚠ OPEN: the culling trade. A proxy cannot be culled member-by-member, so a
  cascade rasterises triangles it used to reject. That is a good trade only
  while the frame is CPU-bound on submission — re-check it if shadow
  rasterisation ever dominates.
  ORIGINAL ANALYSIS: The depth pass
  replaces every material with one shared override
  (`scene.overrideMaterial = getShadowMaterial(light)`, ShadowNode.js:746;
  Renderer.js:3562-3577 honours it), so in a cascade a mesh's material identity,
  its maps and its `colorNode` are all IRRELEVANT — only alphaTest / side /
  layers / castShadow survive. Yet `merging.js` keys its groups on the COLOUR
  pass: `material.uuid` on the free path (merging.js:1106) plus texture-array
  and shading signatures on the uber path, refusing outright on
  `uberIncompatibility` — *that* is the log's "142 custom colorNode". The
  arithmetic closes exactly: 125 merge proxies + 287 below-threshold + 142
  colorNode = **554**, the first cascade's draw count to the unit.
  Build a SECOND grouping pass keyed only on what a depth pass consumes
  (position, uv only where alpha is live, side, alphaTest, alphaMap, layers) —
  no textures copied, no uber variant, no GI compile wave, so none of the trades
  that force the current 3-mesh / 42 MB caution apply. Route it with layers:
  proxies on a dedicated shadow layer the cascade cameras enable and the main
  camera does not; originals keep `castShadow = false` so they drop out of the
  depth pass and stay in the colour pass.
  TARGET: 554 -> ~8 and 288 -> ~8 by the profiler's own `floorIfMerged`, i.e.
  ~826 of 842 shadow draws removed **even while the camera moves**.
  ⚠ RISKS TO SETTLE FIRST: the new layer bit vs the documented UI/DEBUG layer
  collision ([[ui-depth]]); GI's own mesh walks / static BVH must not adopt the
  proxies; `fingerprintCasters` will now see them.
- **F2 — PER-DRAW ENCODE: 41.5 us against this project's own 24 us ceiling.**
  `#markObservedMaterial` (GISystem.js:12243) gives every GI-lit material a
  `giMonitorNode`, which makes three's `NodeMaterialObserver.hasNode` true,
  which makes `needsRefresh` true for EVERY render object EVERY frame. It is
  load-bearing and must not simply be deleted — it is what stops a moved lamp
  lighting its old position (harness-proven). The structural move is to put
  GI's changing uniforms in a shared `renderGroup` UBO updated once per frame,
  so the per-object refresh is not what carries them. ~6.6 ms at 376 draws,
  and it scales every future draw.
- **F3 — THREE FULL-SCENE FINGERPRINT WALKS PER FRAME.**
  `fingerprintCasters` (shadowFreeze.js:75, 1.165 ms) and `#gbufferFingerprint`
  (GISystem.js:9782, most of gi.gbufferPrepass) are the SAME traverse with the
  same 16x `Math.round`/`Math.imul` per mesh; `#checkFingerprint`
  (GISystem.js:3253) does a third full collect every 5th frame. Replace with ONE
  engine-owned content key bumped by the events that already exist
  (`hierarchy-changed`, transform commits, visibility, merging commits,
  instanceMatrix uploads). ~2 ms, and it makes the freeze's walk cheap enough to
  stop being a tax on the optimisation it serves.
- **F4 — ~60 SEPARATE `queue.submit()`s PER FRAME.** `giCompute`
  (GISystem.js:346) loops `renderer.compute(node)` one node at a time ON PURPOSE
  (so a pipeline created mid-dispatch is attributable to its node), and three's
  `Renderer.compute` creates a command encoder + compute pass + submit per call
  (WebGPUBackend beginCompute/finishCompute). Make the per-node path
  CONDITIONAL: pass the whole array once every node already has a pipeline, fall
  back to the loop only while any is pending. Est. 2.3-5.7 ms of gi.screenChain's
  3.5 ms band. ⚠ magnitude UNVERIFIED — mechanism is certain from source, the
  per-submit cost is not measured here.
- **F5 — MERGE COVERAGE: dicing manufactures the singletons it then discards.**
  `#rebuild` dices by locality FIRST and applies `MIN_GROUP_SIZE = 3` SECOND
  (merging.js:1257-1272), which is what prints "287 below the 3-mesh threshold
  **after splitting**". Invert the order: re-merge adjacent under-sized cells of
  the same key in Morton order until each survivor clears the threshold. 287
  meshes recovered; a cell of one is strictly worse than not dicing.
- **F6 — the SRC probe chain (~44 dispatches) is exempt BY DESIGN from the
  converged-idle gate** (GISystem.js:2760/2784), because probe retirement is
  frame-counted so skipping a frame ages probes. Make aging wall-clock or
  evidence-driven, then let SRC ride the same `idle` list the resolve rides.
- **F7 — unconditional telemetry on the shipping path**: `#maybeLogSrcProbeStats`
  (GISystem.js:8100) is gated on a 60-frame cadence only, NOT on
  `__giLogSrcProbes` (which gates just the console line), and pulls 8+ chained
  GPU readbacks plus a whole-pool CPU reduction. Gate the READBACK on demand.

## ⭐ STATE AT SESSION END — THE FRAME FLIPPED TO GPU-BOUND, AND THE GPU IS ONE THING

Settled Bistro, parked, shadow-merge on: **CPU 26.14 ms / GPU 51.63 ms,
`bound: "gpu"`**, 422 draws. The CPU side went 86.65 → 26.14 ms this session and
is no longer the ceiling. `profile.giPasses` attributes the GPU frame outright:

| pass | ms |
|---|---|
| **bvhHitShade** | **26.03** |
| **bvhReflect** | **25.77** |
| resolve | 5.17 |
| emitterShadowPass | 4.25 |
| whole SRC probe chain (63 dispatches) | 12.32 |

**bvhReflect + bvhHitShade = 51.8 ms, i.e. the ENTIRE GPU frame.** Everything
else is rounding. The bucket line is still "2 mirror, 102 dynamic-roughness",
so the dense full-screen prepass traces every pixel for a term that only 2
materials consume sharply — which is exactly the case §17's **R8
roughness-tiered prepass RESOLUTION** was spec'd for after R4 classification was
refuted as a default (the energy is real, so the fix is RESOLUTION, not path
membership: rough pixels at stride 4 = 1/16 the rays via the existing block
replication, mirror pixels at stride 1).

### ✅ SHIPPED — THE REFLECTION HOLDS (2026-08-24, fps 18 → 37 on Bistro)

| | before | after |
|---|---|---|
| **fps** | 18 | **37** |
| GPU | 53.3 ms | **23.6 ms** |
| CPU | 22-33 ms | 17.3 ms |

Receipt: `profile.frameStats` gained `giHold: { reflectHeldFrames,
hitShadeHeldFrames }` — live `286 / 1`.

- **`bvhReflect` is HELD EXACTLY when `gbufHeld`.** The pass TRACES ONLY (hit t,
  face normal, hit albedo — never light, per its own header), so its inputs are
  exactly the g-buffer, the camera and the BVH — and `gbufHeld` already proves
  all three unchanged (it folds in both camera matrices, every drawn mesh's
  world transform, geometry IDENTITY so a BVH rebuild breaks it, the target's
  identity, and it BAILS on any skinned/morphing mesh). On a held frame the
  kernel would recompute a BIT-IDENTICAL result, which is why there is no
  heartbeat. `__giReflectHold = false` reverts.
- **`bvhHitShade` rides a 1-in-3 CADENCE**, not a hold — it also consumes the
  SRC probe field, which keeps converging on a parked camera (the probe chain is
  exempt from the idle gate, unit F6). ⚠ And only after
  `GI_HELD_HIT_SHADE_SETTLE = 45` held frames at FULL rate: dropping to a
  cadence the instant the camera stops would make the reflection converge 3x
  slower exactly when the user is looking at it, and "reflections update a
  second or two after I stop" is a LIVE complaint about this chain.
  `__giHitShadeHold = false` reverts.
- ⚠ **`this._gbufHeld` is published on the instance ON PURPOSE**: the two
  consumers sit in a DIFFERENT SCOPE of the same tick from where `gbufHeld` is
  defined, and a bare reference there is a ReferenceError that throws the whole
  GI tick every frame (shipped that way for one boot — fps 5, GI dead).
- ⛔ **THIS IS A HELD-VIEW WIN ONLY.** While the camera moves `gbufHeld` is
  false and both passes run at full rate, i.e. back to ~18 fps. The
  moving-camera fix is R8a below.

⚠ METHOD NOTE, recorded because it cost most of a session: the frame was read as
CPU-bound from an early `gpuMs 19.29` sample taken MID-BOOT, before the
reflection kernels had compiled. Settled, the GPU was ~52 ms all along. **Re-read
the bound after the scene settles before choosing a direction.**

### ⛔⛔ THE STILLNESS TRAP — the user's standing correction, 2026-08-24

*"we gain performance from camera stillness, but it drops 3x when it starts
moving, defying our dynamic orientation again."* Every win this session was a
HELD-VIEW win — shadow freeze, shadow merge, the reflection hold, the hit-shade
cadence. **This engine is for games. A parked-camera optimisation optimises the
case that does not matter.** Judge every future unit by its MOVING number.

⚠⚠ AND READ THE TIER BEFORE QUOTING ANY NUMBER ([[probe-blind-statistics]]
rule 9, violated again here): mid-session the user switched the **GI component's**
`quality` to `high` while `project.settings.build.quality` stayed `"ultra"` —
two different knobs. A 48 fps reading at high was briefly compared against an
18 fps ultra baseline. The corrected, tier-consistent picture, from the user:

| GI quality | still | moving |
|---|---|---|
| ultra, session start | 18 | ~18 |
| ultra, after the holds | **30** | **15** |
| high, after the holds | 48 | — |

So the holds are real (18 → 30 still at ultra) and, exactly as designed, do
NOTHING for motion. 15 fps moving is the number that matters.

### ⭐ THE REFLECTION FREEZE — TWO SUSPECTS ELIMINATED BY MEASUREMENT

User: *"when a reflective object is moving or rotating, reflections look
correct, but when the camera orbits around it, it shows the same perspective
for the whole motion, until the camera stops."* Receipts added to
`profile.frameStats.giHold` (`hitHistWeight`, `hitHistWeightAtMotion`,
`camMotionEma`, `reflectHeldFrames`) and measured live:

- **R7c WORKS.** `hitHistWeightAtMotion: 0.045` — exactly `0.9 x 0.05`. The
  history weight does collapse to near-raw under camera motion, and the GLOSSY
  chain shares the same uniform (`#armGlossyTemporal` binds
  `_giBvhHitHistWeightU`, verified). NOT a stale temporal buffer.
- **THE REFLECT HOLD IS NOT IT.** `reflectHeldFrames` 1710 → 9 on a camera
  move; the hold releases and the trace re-runs while orbiting. (A hold count
  climbing between MCP calls is an artifact of the gaps between them — a real
  continuous orbit never lets it engage.)

⇒ The frozen image is a THIRD source, shown INSTEAD of the traced reflection
while moving. Leading candidate: the **reflection probe atlas** — world-anchored
cubemaps captured ~one face per frame, which genuinely do show "the same
perspective" from any orbit position, and which the material falls back to when
the traced/glossy signal is rejected. ⚠ AWAITING THE USER'S EYES on the one
question that separates it: during the orbit is the frozen reflection SHARP
(a correct image from the wrong viewpoint ⇒ something freezes the trace) or
BLURRY/washed (⇒ the probe fallback)?

### ▶ R8a GROUNDWORK LAID (inert), AND WHY IT STOPPED THERE

`GI_SHARP_LAYER = 21` + bucket-0-only tagging in `#collectMeshes` are IN and
INERT (nothing reads the bit yet; a stale tag would cost RESOLUTION, never a
missing reflection — which is why this is safe where the mirror MASK was not).
Deliberately NOT `GI_MIRROR_LAYER`, which tags buckets 0 AND 3 = 104 of 111
materials and is therefore useless as a cost lever.

WHAT REMAINS, and it is surgery, not wiring: `createGiBvhReflect` traces INLINE
inside its `If(live)` block, so a per-block stride needs either (a) the trace
restructured into a TSL `Loop` over sub-pixels — in a kernel with a documented
history of ruled lines, stipple and dark holes — or (b) a SECOND compiled
instance (~92 kB more WGSL onto a 1469 kB / ~3 min boot). Pick (a), and gate it
with the prepass-content rig before trusting it.

### ⭐⭐ R8 RE-SPEC'D BY MEASUREMENT — THE TRACE WAS ONLY HALF THE BILL

A forced global `stride 4` arm was compiled and measured live on Bistro
(temporary, since removed). The result splits R8 in two and refutes the
one-unit framing:

| pass | stride 1 (ultra today) | stride 4 | scales? |
|---|---|---|---|
| **bvhReflect** (the TRACE) | 25.77 ms | **2.70 ms** | ⭐ 9.5x |
| **bvhHitShade** (the SHADE) | 26.03 ms | **25.06 ms** | ⛔ NOT AT ALL |

**Why:** `createGiBvhHitShade` ends `})().compute(width * height)` — ONE THREAD
PER RADIANCE-GRID TEXEL, unconditionally. Its `sourceStride` parameter only
QUANTISES WHERE IT READS (the anchor-snapping that killed the "ruled lines"
bug); it has never reduced the thread count. So the shade pass pays full price
at every stride, and a stride change alone can never fix more than half the GPU
frame.

**Why the trace is so expensive today:** `#bvhReflectStride()` is
`qualityTierOf(config) === "ultra" ? 1 : 2` (GISystem.js:7639-7641) and this
project BUILDS ULTRA — so the prepass traces ONE BVH RAY PER PIXEL over
1803x887 against a 2.8M-triangle BVH8. Ultra chose stride 1 purely to protect
MIRRORS from replication stipple ("salt-and-pepper on the user's mirror walls",
"mosaic patchwork on CURVED mirror columns") — and Bistro's bucket line is
**2 mirror against 102 dynamic-roughness**. A screenshot at forced stride 4
shows NO visible degradation on this scene. Paying 23 ms per frame to protect
two materials is the waste, and that is exactly what tiering removes.

⇒ **R8 IS NOW TWO UNITS:**
- **R8a — TIERED TRACE.** Mirror blocks keep stride 1; rough blocks go to
  stride 4. Worth **~23 ms**, and the machinery (validated block replication)
  already exists — only the stride becomes per-block.
- **R8b — THE SHADE. ⛔ MY FIRST DIAGNOSIS WAS WRONG; CORRECTED BY THE MAP.**
  I claimed bvhHitShade was shading ~16x redundantly and was worth ~19-22 ms via
  anchor-rate dispatch. **The arithmetic refutes that.** `radianceDiv: 3` is
  hardcoded (GISystem.js:7266), so the shade grid is a FIXED
  round(1803/3) x round(887/3) = **601 x 296 = 177,896 threads, at every
  stride** — which is exactly why the measurement showed 26.03 -> 25.06 ms
  (constant, not merely "not scaling"). Distinct source anchors by stride:
  s=1 -> 1.6M (capped by the grid, so **1:1 — ZERO redundancy to harvest**),
  s=3 -> exactly 1:1 with the grid, s=4 -> 100,122 (**43.7%** duplicates).
  So anchor-rating buys NOTHING at today's ultra stride 1 and at most ~44% of
  25 ms even at stride 4.
  ⇒ **The real R8b question is not redundancy, it is that each shade thread
  costs ~140 ns** (25 ms / 177,896). That is the probe gather + emitter slots +
  palette + reflection-probe work per thread. Investigate what is IN the thread
  before proposing a dispatch change. R8b is now UNSCOPED pending that.

## ⭐⭐ THE MIRROR-MASK CLEAR BUG — ROOT CAUSE FOUND AFTER FOUR REVERTS

Not `renderer.autoClear` failing to survive a context switch (the standing
guess). The real chain, verified in three's source:

- A WebGPU render pass's loadOp is decided ONLY by
  `renderContext.clearColor/clearDepth/clearStencil` (WebGPUBackend.js:852-916).
- Those three are written in exactly one place: `Background.update`, called
  unconditionally from `Renderer._renderScene` on EVERY `renderer.render()`.
- Its gate is `if ( renderer.autoClear === true || forceClear === true )`
  (Background.js:185) — **an OR. So `renderer.autoClear = false` is IGNORED
  whenever `forceClear` is set.**
- `forceClear` is set whenever `scene.background` is an opaque Color
  (Background.js:71-78) — and this engine ALWAYS installs one unless an
  HDRI/texture skybox is present (`sceneSettings.js:446` and `:468`).

⇒ On any scene with a plain colour background — **a Cornell box** — the mask
pass began from a fully cleared MRT pair AND cleared depth, so only
GI_MIRROR_LAYER meshes survived as gbuffer geometry and every diffuse wall went
black. **Sponza survived only because its mask covered most materials.** That is
the entire four-revert history, and it was never about `setMRT` or the override
swap.

**FIX (small, and it is the same one `godraysShadow.js` already uses at line
211):** null `scene.background` for the duration of the mask pass — that alone
takes Background.js's null branch, leaves `forceClear` false, lets
`autoClear = false` reach the "clear nothing" path, AND removes the full-screen
background MESH a texture background would otherwise unshift (which bypasses
`camera.layers` entirely). Restore it in the existing `finally`. Exact anchors
in the map result. ⚠ Still gate it with a readback rig asserting a NON-mirror
pixel's `output.w` survives the mask pass before re-flipping `__giBvhMask`.

⭐ **THE TIER SIGNAL — a design that sidesteps the four mask reverts.** Do NOT
revive the second gbuffer pass. Render a SEPARATE, SMALL, single-channel mirror
mask into its OWN render target (cleared to 0, drawing only GI_MIRROR_LAYER
meshes — 2 materials on Bistro), ideally at BLOCK resolution since only
per-block granularity is needed. This cannot reproduce the Cornell wipe, because
it never shares an attachment with the gbuffer: the failure mode of a wrong or
missing bit is a COARSER TRACE, never a black wall. That asymmetry is the whole
argument — the mask was catastrophic when it gated whether a pixel is traced AT
ALL, and is benign when it only picks a resolution.

⇒ **R8 IS STILL THE HIGHEST-VALUE UNIT IN THE PLAN**, ahead of F2-F5: it is
~50 ms of a ~52 ms GPU frame, and the CPU work that remains (F2 per-draw encode
~6 ms, F3 fingerprints ~2 ms, F4 submits ~2-5 ms) cannot be seen until the GPU
stops being the ceiling. It also touches the user's open visual complaint — the
window reflections are both slow AND laggy.
⚠ R8's design constraint stands: the per-pixel tier signal must NOT come from
the mirror-mask second gbuffer pass (the Cornell black-walls bug, fourth mask
revert) — carry the tier in the MAIN gbuffer pass instead.

---

# ══ §16 — THE DYNAMIC GI OVERHAUL (2026-08-24, USER MANDATE) ══

*(This banner is authoritative over everything below it. The §12.82 banner
below remains the convergence chronology; its "START HERE" is superseded.)*

**THE MANDATE (user, 2026-08-24, verbatim intent):** GI for a GAME ENGINE —
fully dynamic, 60+ fps on any settings with no drops, robust under many moving
objects, spawning objects, camera movement, light movement. Four fronts:
1. **Convergence**: no blocky-rectangle patches, smooth light, low latency on
   camera rotation onto new surfaces and on sun motion.
2. **Reflections**: BVH + probe reflections look bad, cost ~50% of the frame,
   and need manual probe volume/size setup. Must just work, zero setup.
3. **Boot**: Bistro freezes the editor 20-30 s until GI loads. GI must appear
   fast.
4. **Lattice**: optimal, sparse, seamless, adapts to any world scale — denser
   near the camera, sparser far away.
Core-architecture rewrites are explicitly authorized. Every unit still ships
with BOTH numbers (visual receipt + frame cost at ultra — the project builds
ULTRA; measure there, probe-blind-statistics rule 9).

## THE 2026-08-24 CODE MAP'S THREE HEADLINE FACTS (verified against src)

- **Retention is dead by a stale gate.** `srcProbes.js:1283` gates the S1
  retain bundle on `worldKeysEnabled()`, but the bundle and `createAgePass`
  (761-799) fully support the shipped anchor-relative arm (arm-aware position
  recovery, re-anchor `kill`, 1800-frame maxAge, 0.6 highWater). As shipped,
  every probe unseen 60 frames dies with its payload — look away and back =
  whole-neighbourhood cold start at α 0.02. The comment at 1266-1282 says the
  anchor arm was ARMED 08-22 late; the code says it never was.
- **The Bistro freeze is (a) one synchronous #rebuild tick** (mesh walks +
  ~136 MB alloc + static shadow BVH + per-geometry MeshBVH + full TSL graph,
  GISystem.js:8117-8965) **plus (b) suspended-mode compile wave** — with a
  postprocess override the wave holds the LAST FRAME for its whole duration
  (GISystem.js:3263/3299) instead of keeping the viewport live.
- **Zero-setup reflections exist but are off**: auto room probes are
  `__giAutoRoomProbes === true` opt-in and level-design-only
  (GISystem.js:1306-1381); no fallback for imported scenes; the exact path is
  DENSE full-screen because masked mode is a broken opt-in
  (GISystem.js:7340-7389).

## UNITS (implementation order; ✅ = shipped with receipts, ▶ = in flight)

**FRONT 1 — CONVERGENCE**
- **✅ D1 — anchor-arm retention (SHIPPED 2026-08-24).** Dropped
  `worldKeysEnabled() &&` from the retain gate (srcProbes.js). NOT the vetoed
  world-keys flip: keys stay anchor-relative, the re-anchor kill stays.
  RECEIPTS: `test:gi-spin-retention` PASS — the shipped arm now holds
  1299-1752 probes across turns (was 0 held, whole neighbourhood deleted at
  60 frames), 0 dropped inserts (crowding guard), recovery 120ms → 120ms
  (not worse), storm-room dip 3.0% → 4.6% (within gate). `test:gi-src-probes`
  16/16 PASS (lifecycle invariants), `test:gi-src-deposit` PASS (block cycle
  is still a permutation — no leak/double-free under held blocks). Still
  owed: mid-play tiles empty-texel% and walk-probe checker AT ULTRA on the
  user's Level.
- **✅ D1c — §12.87 TILE COVERAGE IS A FRACTION BY DEFAULT (SHIPPED
  2026-08-26).** Flipped `__giTileCoverFraction` to default-on in BOTH twins
  (`srcTiles.js` GPU, `srcRef.js` mirror); `false` is now the opt-out. The
  change had been sitting opt-in with its own comment saying it would ship
  "OPT-IN until a measurement earns it" — this is that measurement.

  WHY IT IS A CONVERGENCE UNIT, not a cosmetic one. `bakeProbeIrradiance`
  renormalises over the KNOWN bins, i.e. it EXTRAPOLATES them across the whole
  cosine lobe, and a flag told the gather that a one-bin extrapolation was as
  trustworthy as a fully sampled texel. So whichever corner won a cell handed
  that whole cell its single-bin constant, and which corner wins churns as
  probes re-mint — precisely this front's "blocky-rectangle patches". The
  honest fraction lets better-sampled neighbours carry the cell. It cannot
  darken: the gather's `acc` and `wsum` both carry the factor, so a uniformly
  discounted probe renormalises to the same mean and only RATIOS move.

  RECEIPTS, AND THEY ARE ASYMMETRIC — READ BOTH HALVES. The evidence for this
  unit is a LIVE OBSERVATION, not a harness number, and `probe:gi-walk` was
  run and could NOT confirm it. Do not cite this entry as if the probe had.

  (a) THE LIVE A/B — the user's own editor, ultra, their Level, against "when
  camera moves and sees a new surface … patches look like a checkerboard, some
  darker, some brighter": the fraction took the patches to **almost gone at no
  fps cost**, where `__giSrcProbeRayCap = 0` cost **60 → 45 fps** and cleared
  LESS. That comparison is the unit's central finding and it redirects D2/D4:
  a starved probe's problem is not that it has too few rays, it is that it
  VOTES AS IF IT HAD ENOUGH. Cheap honesty about confidence beats expensive
  extra evidence.

  (b) THE HARNESS — `ARMS=base,nocoverfrac QUALITY=ultra probe:gi-walk`, run
  TWICE. **Null, and the instrument is why.** Between-arm gap: leg1 `checker`
  0.0638 (base) vs 0.0648, ~1.5%, and leg0 REVERSED at 0.0753 vs 0.0596.
  Between-RUN gap for the SAME arm: base leg1 `checker` 0.0898 → 0.0638 (29%)
  and `crease` p99 0.97064 → 0.65323 (33%). The replicate moves several times
  further than the arms differ, the sign of the arm difference flips between
  runs on both metrics, and the aggregate `err0` verdict flips with it (run 1
  base 0.02120 vs 0.01322; run 2 base 0.00764 vs 0.05395). So the probe cannot
  resolve an effect this size at n=1 per arm, and no reading from it — in
  either direction — is admissible here. Clean in both runs otherwise: no
  `storage` line, no WebGPU validation error, no `pageerror`.

  The unit ships on (a) plus the estimator argument above, which stands on its
  own: a biased extrapolation must not carry a full vote. It is NOT resting on
  (b). The offline gates that DO bear on it are the twin-agreement ones, and
  those pass: `test:gi-src-tiles`, `test:gi-src-gather`, `test:gi-src-ref`,
  `smoke:gi-gpu` (storage still 8/stage).

  ⚠ TWO INSTRUMENT DEFECTS THIS EXPOSED, both worth fixing before anyone
  trusts `probe:gi-walk` on a convergence unit again. They join the SEVEN
  uncontrolled inputs already in its header.
    · **leg0 measures a near-black frame.** Tail mean luma 0.00579 (and
      0.00026 on a cold run), so `checker` — a first difference normalised by
      the mean — is computed on noise. leg0 needs a lit camera position or its
      readings should not be reported at all.
    · **A cold run puts the compile wave inside the measuring window**
      (`SLOWEST PIPELINE #105 [bvhHitShade] 36.6s`, first frame after the wave
      17086 ms), and one arm's probe pool COLLAPSED at rest (leg1 nocoverfrac
      c0 live 4779 → 323), which makes its orphan rate a ratio over an empty
      store. Both runs also fired the §12.56 `reflProbeCapture` watchdog.
    · Wanted: repeated runs per arm with a paired-difference verdict, so the
      probe reports an effect against its OWN replicate spread instead of a
      single number per arm.

  ⚠ A FALSE ALARM, KILLED HERE SO IT IS NOT RE-RAISED. leg0's `tiles cover %`
  and `knownBins` are BIT-IDENTICAL between the two arms, which reads as "the
  hatch is not reaching the bake". It is not — both statistics are computed
  from `TS_TEXELS` (incremented on `wsum > 0`) and `TS_KNOWN` (a count of
  known bins), and NEITHER reads `cover`. Identical is the expected result and
  says nothing about whether the fraction is live.

  SCALE OF THE DEFECT, newly measured: **89.5% of tile texels sampled only
  part of their lobe** (20,622 of 23,040 on the tiles gate's synthetic field).
  One-bin extrapolation was never a tail case.

  GATE CHANGES THIS FORCED, and they are not rubber stamps. The GPU
  premultiplies `cover` into the atlas RGB (it must — its gather divides by
  `Σ w·c` once) while the mirror keeps coverage in a separate array and
  multiplies at gather time. Both compute `Σ w·c·E / Σ w·c` and agree at the
  GATHER; only their stored bytes differ. So `test:gi-src-tiles` now compares
  its interior arm against `mirror × cover`, and its coverage arm asserts alpha
  **IS** the sampled fraction rather than a 0/1 flag — strictly stronger than
  the assertion it replaces, since it pins every intermediate value. A new arm
  fails if nothing is fractional, so the suite cannot silently revert to
  testing the flag.

  ⚠ MEASURED PRECISION COST, recorded so it is not rediscovered as a bug.
  `test:gi-src-gather`'s coverage arm goes **0.12% → 2.79%** worst GPU-vs-mirror
  error (confirmed causal by forcing the hatch off and re-running). It is
  CONDITIONING, not a defect: with `c ∈ {0,1}` numerator and denominator round
  almost identically, and with continuous `c` they carry coverage's full
  dynamic range through different f16/filter-weight roundings, amplified by the
  spread of `E` across the tap (~7× on that field). That arm's bound is now 4%
  with the arithmetic written down; every other arm stays at 1% and still
  passes at 0.44%, which is what says the estimator did not move.

  ⚠ IT COMPOUNDS WITH D3's MATURITY, intentionally — `cover = sampledFraction ×
  maturity`, two different ignorances (WHICH directions are unknown vs HOW MUCH
  any of them is worth), so a product is the right composition.

  CONTROL ARM: `ARMS=nocoverfrac` in `run-gi-walk-patches.mjs` restores the
  flag, so `base` has something to be compared against. Read `checker` and
  `crease` — but see (b): the arm is only worth running once the probe can
  resolve a ~10% effect, i.e. after the two instrument defects above are
  fixed. Still owed, and NOT discharged by (b): a walk-probe `checker` delta
  at ultra on the user's Level, which is also what D1 above still owes.
- **D2 — seed pass made real.** (a) `SEED_NOBLOCK` counter at the silent
  srcSeed.js:216 exit; (b) un-gate the §12.59.2 LOD+1 spatial rescue from
  world keys (srcSeed.js:173) with arm-aware cell recovery mirroring [B]'s
  keying (`nearestCell` + `latticeOrigin(anchor, s)` on the default arm);
  (c) measure MID-WALK (the at-rest samples that read `seed 0` were blind).
- **D3 — probe maturity in the gather.** A converging probe today votes at
  full trilinear weight = a cell-sized rectangle popping in view. Add a
  per-probe maturity term (evidence-based, from birth stamp or bin count);
  gather weight = trilinear × coverage × max(maturity, floor), renormalized
  (R1: absence/immaturity is never a dark vote — a lone cold corner still
  carries its cell). Cold cells then FADE IN under converged neighbours
  instead of popping.
- **D4 — persistent coarse shell (LOD+1 population).** [B] inserts only at
  floor(lodAtDistance) (srcProbes.js:1314-1331) — nothing exists above, so
  fresh regions have NO prior and lodBias has nothing to read. Insert a
  sparse LOD+1 shell (8× fewer probes); D2's rescue and D3's maturity then
  have a warm coarse answer to lean on. Watch pool pressure (§12.80.1 grows).
- **✅ D1b — the crowding VALVE (SHIPPED 2026-08-24).** D1's retention made
  the binary highWater guard live for the first time, and it is a sawtooth
  by construction: the frame `live` crosses 60% of capacity, EVERY held
  probe reverts to the visibility age at once — mass retirement (parents
  included → orphan spike → dim), refill to the boundary, repeat. The
  user's Bistro parks EXACTLY at the boundary (19.4-19.6k of 32768), and
  during street traversal the pre-valve build hit the FULL pool (32768 +
  689 dropped inserts, live console). Now the hold age fades LINEARLY from
  retain.maxAge at highWater to the visibility age at highWater+0.25
  (srcProbes createAgePass) — retirement meets insertion at an equilibrium.
  R1's "no binary anything", applied to population control. Gate:
  test:gi-spin-retention (still holds/never drops inserts/recovery intact).
- **D5 — sun-motion responsiveness** (after D1-D3 land): the §12.43 window
  discards history 43-58% of frames under a day cycle. The banner's named
  unit (suppress window arming for the split sun) rides the opt-in §12.82
  split whose delivery is short (stale V) — measure the D1-D3 world first;
  the patchiness under sun motion may be mostly D3's missing maturity term.

**FRONT 2 — REFLECTIONS**
- **R1 — zero-setup probes.** (a) Flip auto room probes default-ON
  (GISystem.js:1307 `!== true` → `!== false`); (b) scene-AABB fallback probe
  when no rooms derive and no hand probes exist (same rec shape, capture
  point picked for clearance — the U4a poisoned-reference trap); (c) probes
  remain uniform-writes, no rebuild. User mandate covers the default flip.
- **R2 — masked exact path** (the ~50% lever): locate the masked-consumption
  bug (`run-gi-mask-bisect.mjs`, dense arm healthy / masked broken); flip
  `#bvhMaskEnabled` when green → prepass + hit shade pay only mirror pixels.
  Fallback if unfixable: consumer-aware stride/div off `_bucketTally`.
  ▶ 2026-08-24 CODE-READING LEAD (unverified, R13 — needs the bisect rig):
  `wantsMirrorMask` (GISystem.js ~2549) has NO `_compileWaveActive` gate,
  unlike every other nested pipeline creator (KTX2 blit, texture averages,
  skinned readback). The maskMaterial/maskMrtNode pair compiles its FIRST
  pipeline at the first masked gbuffer render — if that lands inside the
  wave's pinned-MRT await window it is the §12.56 empty-struct poison,
  which matches the exact signature ("masked boots break; stopping the
  mask pass live does NOT recover" — a cached invalid pipeline). The
  prepass's masked-skip markers themselves are CORRECT (skip = -1 field
  fallback, traced miss = -2 env). Hardening regardless of verdict: gate
  the mask pass on `!this._compileWaveActive` — B2 widened the window
  (frames now flow through the wave on postprocess scenes).
- **✅ R3a/b SHIPPED 2026-08-24; R3c deferred.** (a) capture no longer forces
  `recordShadowTrace: null` (`__giProbeRecordShadows=false` reverts) — the
  cone's black-cross lattice stops baking into the atlas. RECEIPT: the
  offset-anchoring gate dropped 0.29 → 0.2366/0.2387 (two boots) and the
  one-flag A/B restored 0.3292 — the cone's OVER-OCCLUSION was baked into
  the gate's reference; the CENTRED probe's discrimination went UP (0.5464
  vs ~0.53), so the floor was re-anchored 0.24 → 0.21 with the receipt in
  the test. (b) hit-shade output luminance-capped at 6 like the capture
  (`__giHitLumCap`); `test:gi-hit-shade` ALL PASS (traced ×1.957 vs flat
  ×1.192 discrimination intact). (c) tile cut at hits DEFERRED — the tile
  set is keyed by receiver pixel, the hit is elsewhere; needs its own
  design. ⚠ `run-gi-reflection-probe-test.mjs` now pins
  `__giAutoRoomProbes=false` (R1 contaminated its no-probe control arm).

**FRONT 3 — BOOT**
- **B1 — BVH builds off the main thread.** Static shadow BVH
  (dynamicObjects.js:487, flat typed arrays, transferable) and per-geometry
  MeshBVH BLAS (bvhScene.js:85) into a Web Worker (first worker in src/ —
  new Vite/Tauri infra). Late attach paths already exist (staged
  #commitStaticBvhAttach; #maybeResyncBvhScene 60-frame window).
- **✅ B2 — live viewport through the wave (SHIPPED 2026-08-24, RECEIPT
  LIVE).** `backgroundCompile = !!pendingLight` (dropped `!overrideOwnsCamera`);
  the late-suspend now covers the PassNode warm whenever ANY override owns
  the camera. RECEIPT on the user's Bistro (postprocess active): `[gi]
  compile wave: materials 21080ms, computes 12105ms (viewport remained
  live)` — the 20-30 s freeze is gone; one 1011 ms first-resumed-frame
  hitch remains (known postprocess recompile, pre-existing). Warm-set
  shrink still open.

**R4 — ROUGHNESS-FLOOR CLASSIFICATION (SHIPPED 2026-08-24; the Bistro
146-286 ms discovery).** The user's Bistro classifies "2 mirror, 102
dynamic-roughness" — 102/111 materials carry roughness maps, so ALL were
exact-reflection consumers and ultra's dense prepass traced the whole
screen through a 1.5 M-tri BVH (bvhReflect 146.39 ms measured live; 286 ms
at their larger viewport) to feed a term `smoothstep(0.45,0.15,rough)`
zeroes on nearly every pixel. Now: `giRoughnessSourceOf` (giLight) walks
the roughness expression (roughnessMap, or wrappers/mul over ONE texture ×
const/uniform factors); GISystem resolves each map's FLOOR async (p5 of
per-texel min RGB via readTexturePixelsGPU — KTX2-safe, ≤2 in flight,
never during the wave); a floor above the mirror gate reclassifies the
material to bucket 1/2 through the EXISTING #refreshMirrorBucket healing,
and the consumer tally is now LIVE-updated on flips so the dense prepass
dispatch STOPS without a rebuild. `__giRoughnessFloorClassify = false`
reverts. ⚠ With 2 true mirrors left the prepass still runs dense — the
full Bistro fix is R4 + R2 masked (pay only mirror pixels). INTERIM: the
user's Bistro runs `reflections: false` (set live 2026-08-24; flip back to
test).
- **B3 — coarse boot rung (§13.14.6, architectural).** Boot the LOW-rung
  compute chain (coarse field first), upgrade in the background. Blocked on
  tier-stable WGSL text (R11 discipline applied to tier constants) or a
  compute-only second wave. The only path to R18's ≤1 s.

**FRONT 4 — LATTICE + DYNAMIC ROBUSTNESS**
- **L1 — metric-pinned LOD0 reach for ANY s0 source** (not just the census):
  derive `__giLod0ReachScale` beside the precedence chain
  (srcSystem.js:254-259) so no future s0 refinement re-opens §12.90b.
- **L2 — census default-ON below ultra** (it is a structural no-op at ultra;
  measured win at high: checker 0.0653→0.045-0.057) — after D1-D4 receipts,
  with the +110-190 MB pool bill priced per tier.
- **L3 — world keys pathway.** Precondition (b) — the merge-orphan answer —
  is MET (per-cascade + live/opaque split landed 08-23; samples read 0live =
  zero photons lost). Precondition (a) — a live instrument on the user's
  Level accepted by their eyes — stays open; D1 retention removes most of
  the felt difference meanwhile. No flip without the user watching.
- **M1 — R19 movers (the dynamic mandate's core):** (a) mover overflow →
  no-GI-occlusion, never re-voxelize-every-frame; (b) relevance-based slot
  eviction (today 15/16 slots can sit on never-moved objects); (c) TLAS over
  mover instances (per-geometry BLAS + per-frame AABB refit) to raise the
  16-mover ceiling to hundreds. Spawning objects must never trigger a
  rebuild storm — adoption only.

**✅ S1 — DIRECTIONAL SKY SHIPPED 2026-08-24 (occlusion half continues via
D1's orphan collapse).** binUnmorton/binDirTable in srcMath (Morton density
argument in its header); per-bin equirect sampling at srcMerge [G.2] and
srcTiles' residual term (inline, capture-identical rotation math); skyEnv
bundle = the persistent env-miss nodes + an env-ONLY intensity uniform
(`_giSkyEnvIntensityU` — no background fallback, sceneSkyRadiance's
contract); threaded through createSrcProbeSystem INCLUDING setSize (whose
arg-forwarding gap was ALSO dropping the census spacing0 on resize —
fixed). Unarmed path (no env, every fixture) proven bit-identical:
test:gi-src-merge diffs 784,128 bins at worst 2.65e-7 post-change. ⚠ GATE
DEBT: no dedicated armed-path rig yet (a two-tone-env directionality gate
is specced below); the armed path is verified by a headless Bistro boot
(env present → armed) + the user's eyes on their HDRI.

**S1's original analysis (kept for the gate design):**
Verified against code: GI's entire sky is `skyRadiance`, a FLAT
`uniform(Color)` polled from `sceneSkyRadiance` (env MEAN × intensity,
GISystem.js) — the HDRI's directionality never enters the transport; every
escaping ray returns the same colour in every direction. The occlusion half
is the ORPHAN leak: an orphaned c0 bin composites `T_self·sky` through only
its own ~0.72 m interval (srcMerge fallback → srcTiles `L + T·sky`), i.e.
sky with ~no occlusion — the documented "flat indoor fill" defect, 17-35%
of bins on Bistro-class scenes. Unit:
- (a) DIRECTIONAL COMPOSITE (concrete): bins are EQUAL-AREA CYLINDRICAL,
  Morton-ordered (srcMath.js binDir/binMorton). Upload a per-cascade
  BIN-DIRECTION LUT (`Float32Array(nBins×3)`, inverse-Morton + binDir on
  the CPU — the tileCosineWeights pattern: no in-kernel trig) and sample
  the environment equirect (`envNode.sample(equirectUV(rotY(dir)))
  .level(0)` — the env-miss bundle's exact read) at the two composite
  sites: srcMerge [G.2] top-cascade close and srcTiles' `L + T·sky`. ARMS
  ONLY when an environment texture exists — envless scenes keep the flat
  `skyRadiance` term bit-identical, so every existing gate is untouched
  and the CPU mirror needs no env sampler (KTX2 defeats CPU sampling — the
  R-D trap). Energy: scale the directional read so its cosine-integral
  matches the flat mean `sceneSkyRadiance` produced (presets/energy rule);
  read sceneSkyRadiance's derivation first. Positive receipt: a NEW gate
  with a two-tone env — a top-cascade bin facing the bright half must
  read brighter through [G.2] than its dark-half mirror bin, and an
  interior pixel must stay DARKER than an open-sky pixel (occlusion
  intact). Cost: one texture sample per known bin with T>0 (top cascade +
  orphans) — sparse when the ladder is healthy.
- (b) ORPHAN REDUCTION: D1 retention keeps parents alive across
  look-arounds (landed); measure per-cascade orphanLiveRate on Bistro
  post-D1; if live orphans persist, the next lever is a grandparent (c+2)
  fallback in the merge corner resolve before decorating the fallback with
  occupancy sky-visibility.
- (c) The §12.64 IBL suppression is CONFIRMED live (console receipt) — the
  ambient the user sees is GI's own flat sky, not three's IBL.

**✅ F2 FOLLOW STABILIZATION (SHIPPED 2026-08-24, the Bistro "patches
constantly flickering between dim and lit" report).** Live console showed
`follow: slide` every 0.5-2 s with the anchor REVERSING (-5.5→-9.9→-3.3→
-16.5→+6.6 m) — an orbiting editor camera crossed the central third every
fraction of a second and the 500 ms throttle turned the follow into a
metronome; each slide armed a settle window and walked the box edge + far-
field feather through the visible scene. Fix: the editor publishes its
orbit pivot as `engine.cameraFocus` (ViewportPanel, live reference); the
follow tracks the focus (edit mode) through a ~0.8 s EMA and jumps the
anchor to the SAME smoothed point. Orbiting now produces ~zero slides;
walking still follows ~1 s behind (covered by the far field).

**STANDING RULES FOR THIS ARC:** R1 (no dark votes) applies to every
convergence unit; every default flip carries its own hatch; measure at ULTRA
on the user's scenes (Level + Bistro); the ~2/9 dead boot means single-boot
A/Bs are void — repeat arms (`ARMS=x,x2`); quality stays ONE property (no new
tuning knobs — everything auto-derives or rides the tier).

## §16 SESSION LEDGER — 2026-08-24 (what shipped, in one place)

SHIPPED + GATED: D1 retention (orphans 17-35% → 4.1% live Bistro), D1b
crowding valve, D2 seed (SEED_NOBLOCK + anchor-arm LOD+1 rescue; firing live
— 11 probes/frame on Bistro, 0 cold), D3 tile maturity (transient-only,
steady state bit-identical), R1 auto probes + 48 m interior size gate,
R2 masked exact path DEFAULT-ON (wave gate was the missing §12.56 piece),
R3a capture record-march (offset gate re-anchored 0.24→0.21 with the A/B
receipt; passed 0.2416 post-change), R3b hit luminance cap, R4
roughness-floor classification + live consumer tally, S1 directional sky
(unarmed path bit-identical by the merge twin), B2 live-viewport wave
(receipt: "viewport remained live" on the user's Bistro with postprocess),
F2 follow on orbit pivot + EMA. Full 10-suite battery green post-batch.

NEXT ARC (each a full unit with its own gates): B1 worker BVH (static
shadow BVH + MeshBVH BLAS off the main thread — shapes verified
transferable, late-attach paths exist); M1 R19 movers (overflow →
no-occlusion, relevance eviction, TLAS); B3 coarse boot rung (§13.14.6);
D4 coarse shell (BLOCKED on ray-allocation design — unfed shell probes
stay UNKNOWN and seed nothing; Bistro's block pool is at ceiling); S1
armed-path rig (two-tone env); D5 sun-window suppression; boot kernel
diet round 2 (the poles are now bvhHitShade 239 kB cold / reflProbeCapture
203 kB warm — R3a grew the capture; masked mode shrinks bvhHitShade's
dispatch, not its compile).

---

# ══ §17 — ONE-BVH REFLECTIONS + THE SPATIAL LEDGER (2026-08-24 evening) ══

**USER MANDATE (after §16 landed):** reflections must be FAST and show the
REAL scene; probe placement/updates must be memory- and perf-optimal;
"calculate only what we actually need". Worker-thread BVH explicitly
approved. Bistro at medium measured 15 fps and it was CPU (89 ms CPU vs
24 ms GPU, 3179 draws, 13.3 GB heap → GPU DEVICE DIED — the documented
heap-kill signature).

## THE THREE MAP FACTS THAT DECIDE THE DESIGN (verified, reader fan-out)

1. **The exact-reflection path's top level is a LINEAR LOOP over ≤128 mesh
   AABBs per ray** (bvhScene.js:780-822, no TLAS), and the 452 unseated
   Bistro meshes VANISH from reflections (rays pass through; full miss
   writes t=-2 = "environment proven visible" → sky painted through props).
   Both user complaints (wrong content + cost) are this one structure.
2. **The static shadow BVH already IS the answer**: world-space BVH8 over
   EVERY static placement (no mesh/tri caps, 768 placements, Bistro ~2.9M
   tris), traversal ALREADY CLOSEST-HIT (`anyHit` param is dead code —
   dynamicObjects.js:806-810 tracks bestT, near-child-first, bestT-pruned),
   every triangle carries its OCCUPANCY SLOT inline (word 9), and the
   8-word surface palette (albedo/emissive/emitterId/live) sits in the SAME
   `bits` buffer — a hit can shade with ZERO new bindings. The dyn set's
   traceDynBody is also closest-hit with objId+albedo, and min(t)
   composition already ships in both shadow arms.
3. **The uniform grid is NOT the memory problem**: at Bistro the occupancy
   BITS are ~9.6 MB of the 366 MB (2.6%); ~70% is surface-record machinery
   (records 33 MB + fit SCRATCH 82.5 MB + exact-triangle pool 112-140 MB).
   And the dense 1 m probe volume ALLOCATES NOTHING and is CONSUMED BY
   NOTHING ("probe lattice, NOT traced" in its own boot line) — it survives
   only as the fit's spacing quantum. Diffuse is already fully sparse.

## UNITS

- **R7 — ONE-BVH REFLECTIONS (the centrepiece). ▶ R7a IMPLEMENTED
  2026-08-24 late (gates in flight):** `giStaticBvh8Slot` wgslFn
  (dynamicObjects.js — separate fn, C8-suffixed helpers, oct-normal +
  bitcast slot in one vec4; the shared shadow fn untouched),
  `traceStaticBvhSlot` wrapper on the dyn set (same live base/mask
  uniforms), `#oneBvhBundle()` in GISystem (trace + palette
  bits/wordOffset/words/slots from surfaceAttribution), and
  createGiBvhReflect's core branches on the bundle at build time —
  palette-shaded hits (live=0 → mid-grey, R1), ray-faced normal decoded
  via octDecodeTSL and re-encoded with the storage convention, dyn min(t)
  union unchanged, incumbent path kept and auto-selected whenever the
  bundle or the static region is absent. `__giOneBvhReflect = false`
  forces the incumbent.
  (a) A closest-hit WGSL variant `giStaticBvh8Closest` compiled ONLY into
  the reflection prepass (do NOT widen the shared shadow fn's return — that
  recompiles every shadow consumer): returns t + normal + SLOT (+ u,v — 
  already computed at dynamicObjects.js:802-805 and discarded).
  (b) createGiBvhReflect swaps its firstHit core to: static closest-hit ∪
  dyn.trace, min(t) — full scene coverage, one traversal per ray.
  (c) Shading at hits: slot → palette mean albedo + premultiplied emissive
  (gated: palette requires srcShadeEnabled — ensure allocated for the
  reflection consumer).
  (d) R7b TEXTURED REFINEMENT: slot→bvhScene-mesh table (≤768 u32
  uniforms); when the winning slot belongs to one of the ≤128
  atlas-seated meshes, run THAT ONE mesh's BLAS in a t±ε window to recover
  barycentric UV → the textured atlas albedo. Cost: 1 BVH8 + ≤1 BLAS per
  ray (vs 128 slab tests + k BLAS walks). Sharp mirrors keep texture
  detail on the big meshes; everything else gets correct geometry with
  mean albedo.
  R7b DESIGN (settled 2026-08-24 night, pre-implementation):
  · Mapping source: `field.placements` carries `{slot, mesh, instanceId}`
    (GISystem#occupancyContentOf; slots stable-for-life via _occSlotMap).
    At #syncBvhScene cadence build Int32Array(paletteSlots).fill(-1);
    for each placement with instanceId == null whose mesh is seated in
    bvhScene.meshes, table[slot] = bvhScene table index. Instanced
    placements stay -1 (bvhScene's worldToLocal is the MESH matrix, not
    the per-instance one — the window walk would miss anyway; palette
    fallback is correct). Upload as attributeArray("int").toReadOnly().
    Slots spawned after the sync stay -1 → palette fallback, graceful.
  · Window walk (giScreen prepass, inside the accepted oneBvhHit branch):
    mi = table[slot]; if mi ≥ 0: ε = max(0.01, t·0.002);
    ro2 = (origin + R·t) − R·ε, local-transform via worldToLocal[mi],
    bvhMeshFirstHitFn(..., maxT = 2ε) — t is world-parameter-identical
    in local space (bvhScene's CRITICAL unnormalized-rd note), so ε in
    world units is valid directly. Accept ONLY hits inside the window;
    resolve UV → atlas via the SAME post-loop math as firstHit (extract
    that block into a shared resolveHitAlbedo(meshIdx, tri, uv) helper
    on the scene object rather than duplicating the offset math).
  · Any window miss keeps the palette albedo — no black, no env leak.
  · createGiBvhReflect already receives BOTH bvhScene and oneBvh; the
    refinement re-binds the incumbent's 5 buffers + atlas into the
    prepass (what the incumbent bound anyway).
  · Hatch: `__giBvhTexRefine = false` (build-time, like the others).
  · Static-merge meshes: both systems see the same merged mesh objects
    and merged geometry keeps UVs valid against the shared material's
    map — no special case.
  (e) Hatch `__giOneBvhReflect = false` keeps the incumbent path for A/B.
  Gates: test:gi-hit-shade + test:gi-reflection-probes (unchanged
  semantics), a NEW prepass-content assertion (a small unseated prop must
  appear in the reflection under R7 and be absent under the hatch), and a
  Bistro-scale ms receipt (bvhReflect 146 ms dense → target <20 dense /
  <5 masked).
  Caveats carried: 44-deep stack silent subtree drop = conservative miss;
  degrade ladder can drop the static region on portable → fall back to
  the incumbent automatically (it checks region presence).
- **✅ R7c — VIEW-DEPENDENT TEMPORAL WEIGHT (2026-08-24, user: "reflections
  look like hanging, update 1-2 s after I move").** The hit-radiance AND
  glossy temporal filters bound the DIFFUSE filter's weight, whose policy
  ("camera motion stales nothing — reprojection handles it") is correct
  for irradiance and WRONG for reflections: surface-anchored reprojection
  validates history whose IMAGE is stale the moment the view ray changes.
  Both chains now ride `_giBvhHitHistWeightU`: near-raw while the camera
  moves (motion masks the noise the filter exists to smooth; fast attack),
  recovering to the diffuse base over ~1/3 s at rest (0.85^n release).
  Camera motion = matrixWorld position/basis delta per tick (2 mm /
  ~0.03°). `__giBvhHitHistWeight` pins it. Invisible before R7a because
  the reflected content was too wrong to see lag in. Probe captures stay
  untouched — they are world-anchored (box projection + depth parallax
  handle the view), not lagging.
- **B1 — WORKER BVH (user-approved).** buildStaticSceneBvhWords + the
  MeshBVH BLAS builds off the main thread (flat inputs, transferable
  words; staged-attach + 60-frame resync windows already tolerate late
  arrival). Kills the ~1.2 s boot stall and the 200-600 ms rebuild stalls.
- **S2-mem — THE REAL MEMORY LEVERS (not a brick map):**
  (a) release the 82.5 MB fit SCRATCH after the build (it is scratch);
  (b) the exact-triangle pool (112-140 MB) gets a budget + spill-to-voxel
  policy ordered by cell density (the 40k densest cells already keep
  voxel-box hits — extend that ladder downward under a byte budget);
  (c) the REBUILD HEAP LEAK is now a session-killer (13.3 GB → device
  loss) — next session opens with a real retainer-graph snapshot, not a
  fourth guess.
  ✅ (c) ANSWERED by the 18-agent retention audit (2026-08-24 night, 12
  CONFIRMED / 0 refuted; full detail in the audit result + memory). The
  3.8 GB post-GC IDLE baseline (measured headless on Bistro ultra) is
  single-generation CPU mirrors nothing reads back: bits 449 MB
  (occupancyField:613), SRC bin-store shadows 171 MB (srcSystem:745),
  surfScratch 86 MB, plus asset caches (blobUrlCache 160 MB/scene,
  merging _uberCache ≤960 MB ceiling, KTX2 transcode copies). The CLIMB
  is orphan storms, each priced: ⭐ giOwner PINNING (GISystem:530 —
  `data.giOwner` never cleared; three's session-lifetime Pipelines.caches
  → pipeline → backend dict → giOwner → whole TSL graph + buffers; turns
  every orphan below into a HARD leak, ~800 MB-1.4 GB/churny session);
  buildStaticSceneBvhWords ~780 MB TRANSIENT per static-BVH rebuild
  (soup + slice copies + plain-JS tris array of 26M doubles — and live
  editing fires one per mover batch); occupancyField dispose() is EMPTY
  (~573 MB retained per scene switch); makeField degrade ladder can
  allocate the full field ×3 per build (~500 MB spikes); resize storm
  #syncScreenResolveSize replaces ~20 screen kernels on a 2-px tolerance
  with NO releaseComputeNodes sweep (~500 MB per resize);
  ensureComputes geometry-revision chain swap (~280 MB) and
  #rebuildSrcProbesForPools pool-grow swap (~150 MB) — same missing
  sweep. FIX ORDER: (1) null giOwner/giTiming once the pipeline settles;
  (2) releaseComputeNodes at the FOUR incremental swap sites (resolve
  resize, ensureComputes, pool grow, #syncBvhScene incremental) — the
  exact call #dispose already makes; (3) implement field dispose();
  (4) detach post-upload CPU mirrors (⚠ verify re-upload/device-restore
  paths first — incremental setGeometry may write CPU-side); (5) worker
  BVH (B1) also caps the 780 MB transient by moving it off-heap.
- **S3-sched — DEMAND-GATED POOL SWEEPS ("only what we need"):** tiles
  bake ALL 21,875 blocks × 64 texels EVERY frame; decay/merge sweep the
  whole bin pool. Gate per-block work on a dirty bit (deposits landed /
  seed wrote / claim changed) — at rest with the ray stride, most blocks
  are untouched most frames. This is §12.77-A3's indirect-dispatch class;
  start with the TILE bake (biggest texel count, cleanest dirty signal).
- **P2 — STREAMING REFLECTION PROBES (large scenes):** the 8-slot atlas
  gains slot EVICTION + placement along the detail box (grid of candidate
  anchors at ~12 m, nearest-N to the camera own slots, capture points
  clearance-checked against occupancy; one capture/frame amortized as
  today). Kills the manual-volume friction at street scale without the
  scene-AABB smear (declined by the §16 size gate).
- **M-check — the 3179-draw merge disengagement** on the user's live
  Bistro: after their restart, verify merging re-engages (healthy ~384
  draws); if the R4 floor-resolution storm (102 materials' cache keys
  flipping over ~13 s) re-invalidates merge groups, BATCH the flips (one
  pass once all floors resolve, or exempt GI-internal needsUpdate from
  merging's material-edit watcher).
- **⛔ R4 CLASSIFICATION REFUTED AS A DEFAULT (2026-08-24, ~15:40 — the
  user's eyes + three A/B boots, STRONGER than the fix below).** With the
  channel floors finally working, the FIRST live reclassification produced
  "started to look bad" — shadowed arcades near-black. Attribution chain:
  AO exonerated (on/off identical); classification-off boot = bright;
  floor→bucket-2 = black (directional chain compiled out); floor→bucket-1
  = STILL murky ⇒ the missing energy is the canMirror block's HIT-SHADED
  EXACT RADIANCE itself. At grazing angles Fresnel drives rough-surface
  specular high — R4's founding premise ("the dense prepass computes a
  term smoothstep zeroes") is TRUE of the mirror gate and FALSE of the
  hit-shade path, which on Sponza paints a real share of every shadowed
  wall. The 22.7 ms is lighting, not waste. Classification is back to
  OPT-IN (`__giRoughnessFloorClassify === true`); the channel-floor
  machinery, idle drain, flip/floor/census receipts, and the node gate
  (run-gi-roughness-floor-test.mjs, armed) all remain — they are the
  substrate for the REAL unit:
  **→ NEXT: R8 ROUGHNESS-TIERED PREPASS RESOLUTION.** Rough pixels are
  low-frequency by definition: trace them at stride 4 (1/16 rays) with
  the EXISTING block-replication machinery and keep stride 1 only for
  true mirror pixels (floor < mirror gate). Same energy, ~10-20 ms →
  ~2-4 ms expected on Sponza/Bistro-class scenes. The floors classify
  RESOLUTION TIERS instead of path membership.
  ⚠ R8 DESIGN CONSTRAINT added same night: the per-pixel roughness/tier
  signal must NOT come from the mirror-mask second gbuffer pass — that
  pass WIPES pass 1's geometry (the Cornell black-walls bug, fourth mask
  revert; see GISystem#bvhMaskEnabled's banner and memory). Either fix
  the mask's clear semantics first (rig: assert a non-mirror pixel's
  position.w survives the mask pass) or carry the tier in the MAIN
  gbuffer pass (e.g. quantized floor in position.w's spare bits / a
  third MRT written by the one pass), which also deletes the second
  full-scene submission entirely — the better end state.
- **✅ R4-FIX — THE PACKED-MAP CHANNEL BLINDNESS (2026-08-24 night, user:
  "10 fps on ultra, dropped notably recently").** Live Sponza profile: 31 ms
  GPU frame, of which bvhReflect 12.3 + bvhHitShade 10.4 = 22.7 ms — and
  the bucket line read "0 mirror, 0 specular, 15 diffuse-only, 24
  dynamic-roughness". R4's floor stat was p5 of per-texel min(RGB); on a
  glTF PACKED metallicRoughness texture B is METALNESS ≈ 0 on every
  dielectric texel, so the floor read 0 on every packed map and NO such
  material ever left the consumer set — R4's Level-rig receipt was real
  but the Level's ambientCG-style GRAYSCALE roughness maps are the one
  layout min-RGB survives. Fix: per-channel p5 floors
  ({r,g,b,min} in giRoughnessFloorStats; legacy number = min) + the source
  walk names the sampled channel (roughnessMap → "g", three's PBR
  convention; a graph SplitNode names its own; unknown → min fallback,
  conservative). Gate: scripts/run-gi-roughness-floor-test.mjs (9 checks,
  node-side, no editor). This likely also shrinks Bistro's "102
  dynamic-roughness" the same way.

---

# ══ CHRONOLOGY: §12.82 — THE SUN SPLIT WORKS AND CHANGES NOTHING. THE STALE TERM IS `V`. ══

**▶ NEXT UNIT, and it is cheap: suppress the §12.43 tracking window's arming for
the SPLIT sun.** The Level's log says `light-track window: open 43-58% of frames
— armed by shadow ... lifts the probe ray cap to OFF` on every run: GI throws
accumulated history away every time the sun turns, and the split does not stop
it. With the sun analytic that arming is no longer earned. No new storage.
Second candidate: `V` (see the verdict section) — expensive, and the reason the
first one is worth trying first.

*(2026-08-23, session 2. This banner is authoritative over everything below it,
including the previous session's banner, which is kept at `-11` as the
chronology. Read the METHOD section first — the numbers in `-11` were taken
before two of the six controls existed and their MAGNITUDES cannot be compared
against anything measured after.)*

## ⛔⛔ THE HARNESS HAD **SIX** UNCONTROLLED INPUTS, NOT FOUR — AND TWO OF THEM WERE FOUND THIS SESSION

`-11` closed four and declared the probe usable for A/B. It was not. Two more
turned up, each found the same way: **two runs of the IDENTICAL arm disagreeing.**

**5. THE SUN'S PHASE.** The arm that reproduces the user's complaint
(`SUNPIN=off`) does not pin the sun at all, so a run starts its walk at whatever
angle the clock had reached — and the angle sets how much light the room gets.
Two honest `PINSUN=0` runs measured leg0 `checker` **0.0415 and 0.0042, a 10×
spread**, from nothing but where in the day they landed. *(This is why the
handoff's headline 9× and this session's numbers do not line up: they are
different times of day.)*

⭐ **The day cycle is now IDENTIFIED, and it is content, not engine**:
`GAME/scripts/Rotator.ts`, an `@executeInEditMode` script that ASSIGNS
`rotation.x = sin(elapsed·0.1) − 1`, `rotation.y = cos(elapsed·0.1)` every editor
tick. A pure function of `engine.time.elapsed`, period 2π/0.1 = **62.83 s**,
peak 0.1 rad/s — which is exactly the measured 0.00217 rad/frame. So the fix is
not to stop the sun (that deletes the phenomenon) but to **start every leg at the
same point in the cycle**: `SUNPHASE`/`SUNPERIOD` wait on `elapsed mod period`,
and the run PRINTS the sun's world direction it waited for. Two arms whose
`sun@start` lines differ were not the same experiment.

**6. THE CHARACTER'S POSE.** `mixer.timeScale = 0` freezes the figure WHEREVER
boot timing left it, and a skinned character standing in the room is a large
occluder and a large receiver. Two runs of the identical arm, both reporting
`scene STATIC`, measured leg0 `checker` **0.0042 and 0.0842 — 20×**. Worse,
`stopAllAction()` (which the probe called) made it *unfixable*: it stops the
actions at that arbitrary pose and makes `setTime` a no-op. Now
`setTime(POSE)` + `update(0)` drives every clip to a fixed point and the run
prints a **bone-only pose hash** beside the fingerprint, because the combined
hash mixed bones with lights and could not tell a drifting pose from a drifting
light. `POSE=<sec>` moves the pin.

⭐⭐ **AND A THIRD, WHICH WAS A PLAIN BUG IN THE PROBE: the property is
`engine.time.SCALE`, not `.timeScale`.** `TimeSystem` exposes `get/set scale`
(forwarding to `engine.setTimeScale`); `engine.time.timeScale = 0` merely
defined a new own property and did nothing. **Every conclusion of the form
"neither the mixers nor `engine.time` drive the sun, so it must be pinned by
force" rests on that typo** — the day cycle is elapsed-driven, so stopping game
time stops it exactly, at whatever phase it holds, with no per-frame quaternion
fight. `SUNPIN=all` now does that.

⚠ **`ARMS=x,x2` runs the same arm twice** — a trailing digit is stripped. That
repeat is the only thing that has ever found an uncontrolled input here, and it
had been silently running as `base` under another name. (So no arm may END in a
digit; `sunsplitcos1` is now `sunsplitflatcos` for exactly that reason.)

## ⭐ AND ONE FINDING THAT REFRAMES THE FRONT: **leg1's blockiness is NOT the sun**

With the pose and phase controlled, on the Level at `SUNDEG=40`:

| | leg0 | leg1 |
|---|---|---|
| sun PINNED (`SUNPIN=all`) | `checker` **0.0042–0.0046** | `checker` **0.0535–0.0543** |
| sun RUNNING (`SUNPIN=off`, phase 0.25) | **0.0129 → 0.0055** | **0.0359 → 0.0332** |

**leg1 is BLOCKIER with the sun pinned than with it moving, and it does not
settle in either arm.** So there are at least two distinct artifacts under the
one complaint: a sun-staleness transient (leg0, ~3× on arrival, decaying over
~2–3 s) and a large, static, POSE-DEPENDENT blockiness (leg1, ~0.054, permanent)
that the day cycle has nothing to do with. **The second is bigger.** Chasing the
sun cannot fix leg1, and no arm that reports only leg0 will notice.

## §12.82 — THE SUN SPLIT: BUILT, GATED, **DEFAULT OFF, DELIVERY SHORT**

The unit `-11` scoped is implemented end to end. `src/` carries it, every SRC
gate passes, and **it is opt-in (`__giSrcSunSplit = true`) because it currently
loses a quarter to a half of the picture.** Do not arm it for anything but
measurement until the open question below is answered.

**What it does.** `BIN_R/G/B` stop carrying the sun. Four words per bin carry
what a rotating sun does NOT change — `BIN_SR/SG/SB` = `Σ w·(ρ/π)·V_sun` (the
transfer: albedo × shadow, no cosine, no irradiance) and `BIN_SN` = the hit
normal, octahedral 15:15 + a present flag, last write wins — and `[F]` closes it
every frame against the CURRENT sun:

    L = ΣR·Lmax/Σcount + (ΣS/Σcount) · E_sun(now) · max(0, n̂ · l(now))

**The payload does not grow** (still 4 words), which is what makes it affordable:
the merge, the tiles, the gather and the screen resolve are untouched, because
the sun is closed BEFORE the payload is written. `BIN_WORDS` 5 → 9; on the
Level's pool that is 52 → 94 MB of `scratch`. Nine was the budget: eleven (the
obvious `Σ w·V·n` in three signed words) does not fit under the 128 MiB binding
limit at the grown Bistro pool, where [J]'s hit list and the per-block statistics
ride the same buffer.

### ✅ WHAT IS PROVEN

- **The split is an exact identity at the hit.** `test:gi-src-shade` gained six
  checks: split-then-closed == un-split to **0.0000%**; the sun-free half ==
  the same scene with the sun REMOVED, exactly; the transfer is non-zero on
  every hit the sun reached; it is bounded by 1/π; naming a different slot
  splits nothing (the INDEX is read, not the kind); and `sunFacing` marks
  exactly the hits the sun reaches and is not stuck at 1.
- **`packNormal`/`unpackNormal` are twins.** `test:gi-src-math` gained four
  families. ⚠ The pack is NOT bit-exact and must not be asserted as such: it
  FLOORS a continuous octahedral coordinate, so a direction within f32 rounding
  of a cell boundary lands in adjacent cells on the two sides — 5 of 694 cases,
  always ±1, one 3e-5 rad quantum. The gate checks ADJACENCY and COUNTS the
  boundary cases, the same shape as the LOD-boundary tolerance.
- **`test:gi-src-deposit`, `-merge`, `-gather` all still pass** at 9 words.

### ⛔⛔ THE BUG THAT ATE HALF THE PICTURE — FOUND, AND THE RULE IT LEAVES

For most of the session the split lost **a quarter to a half of the picture with
the sun PINNED** — where a mechanism that only re-aims the sun must be a
NO-OP. The cause was one line, and the way it hid is the part worth keeping.

**The line.** The cached normal must be held across frames and zeroed only when
its block is handed to another probe. The obvious form is

    atomicStore(e, select(k.greaterThan(0), atomicLoad(e), uint(0)))

— read it back, write it unchanged when the block survives. **That zeroes the
word every frame.** `ConditionalNode` does not emit a ternary: it `isolate()`s
each branch and emits a real `if` statement assigning into a hoisted property,
and an `atomicLoad` of the very word being `atomicStore`d does not survive that
round trip. The fix is an `If` that writes ONLY when reclaiming — which is also
one fewer read-modify-write per bin per frame on the hottest buffer in the
module:

    If(k.lessThanEqual(0), () => { atomicStore(e, uint(0)); });

⭐ **THE RULE, and it generalizes past this file: never round-trip an atomic
through a conditional in order to "keep" it. Write only when you mean to
change it.**

**How it hid, which is the methodological point.** *Nothing said so.* Every
counter stayed healthy — merge orphan rate, mean corners, `noBlock`, the shade
tallies, all UNCHANGED between the arms. `test:gi-src-shade` passed at 0.0000%,
correctly: the defect is not in the expression, it is in the STORE, and a
per-hit gate cannot see a per-frame store. The image just looked like plausible,
slightly dimmer lighting.

**What found it was arithmetic on two counters, not a picture.** `[F]` counts
resolved bins carrying RADIANCE and how many of those carry a normal; `[J]`
counts hits and how many FACE the sun. Then:

- **48–53% of HITS face the sun** — exactly the geometric expectation.
- but only **2.5–13% of LIT BINS carried a normal**, and the normal count
  tracked THIS FRAME's facing hits at a flat **0.73** across every sample.
- while radiance plainly SURVIVED across frames: **47,540 lit bins against
  13,045 hits in the frame.**

Radiance persists, the normal does not, and the normal count is one frame's
worth. That is a per-frame wipe, stated in numbers, before any hypothesis about
cosines. **And it predicted the loss quantitatively**: delivery measured 24% of
what was removed, against `hits/lit-bins` = 13045/47540 = **27%**.

⚠ **THE FOUR WRONG TURNS, EACH OF WHICH PRODUCED A CONFIDENT NUMBER FIRST:**
1. *"The cosine must be it."* `__giSunSplitCos = false` closes with cos = 1, a
   strict over-estimate, and recovered only 0.05005 → 0.05982 against a 0.0763
   control. It could not have been the cosine, and the arm said so — but only
   because it was run.
2. *"Only 5.6% of resolved bins have a normal — there's the bug."* Wrong
   denominator: most RESOLVED bins are pure transmittance and correctly have no
   surface at all. Re-pointing it at bins carrying radiance was what made the
   ratio mean something.
3. *"Then 9% of LIT bins is fine too — most bins are lit by bounce."* Also
   wrong, and it nearly closed the investigation. The hit-side rate is what
   settled it: 50% of hits face the sun, so 9% of bins cannot be right.
4. *"The pick must be naming a point light."* It is not — `[gi] §12.82 sun
   slot: 0 of 4 — kind 1, luma 9.145, dir 0.811,0.366,0.457`, a unit vector.
   That log line now exists because the probe was dropping every boot receipt
   (it printed only the last six `[gi]` lines); it keeps them now.

**⭐ THE DIAGNOSTIC THAT CLOSED IT IS KEPT**: `__giSunSplitHoldNormal` removes
the decay's store on `BIN_SN` entirely. It is deliberately wrong (a reclaimed
block inherits a dead probe's direction) and it is the control that separates
"the decay eats it" from "[J] never stored it" — 9% → 52–63% and the luma back
to baseline is what named the line.

### ✅ THE CORRECTNESS GATE, AND THE FORM IT HAS TO TAKE

**With the sun PINNED and the pose PINNED, the split must be a NO-OP.** A
mechanism that only re-aims the sun cannot change a static image, so this is the
gate — and it is the one that found the bug above, twice over. Run
`FREEZE=1 SUNPIN=all SUNDEG=40 ARMS=base,sunsplit npm run probe:gi-walk` and
compare within the SAME session; the control drifts ~30–60% between sessions
(GPU clock state), so a cross-session comparison means nothing.

Post-fix, same run:

| | control (`base`) | `sunsplit` |
|---|---|---|
| leg1 tail luma | 0.08151 | **0.0822** (+0.8% — neutral) |
| leg1 `checker` | 0.0662 | **0.0485** (−27%) |
| leg0 `checker` | 0.0046 | 0.0042 |
| lit bins with a normal | — | **50–62%** (against 47–53% of hits facing) |
| fps | 38.9 | 39.1 |

⚠ **leg0's LUMA is not a usable statistic** and should not be quoted: at 0.003
the control alone ranged 0.00259 → 0.00418 (60%) across sessions. leg1 is the
bright, well-sampled leg and is the one to read.

### ⛔⛔⛔ THE VERDICT: IT WORKS, AND IT BUYS NOTHING. **THE SUN'S STALENESS IS NOT IN THE COSINE — IT IS IN `V`.**

With the split correct and energy-neutral, the payoff measurement — sun RUNNING,
phase-aligned, pose pinned, both arms in ONE session:

| | control (`base`) | `sunsplit` |
|---|---|---|
| leg0 `checker` arrival → settled | 0.0133 → 0.0051 (1976 ms) | **0.0132 → 0.0056 (1787 ms)** |
| leg1 `checker` | 0.0351 → 0.0285 | **0.0359 → 0.0278** |
| leg0 / leg1 tail luma | 0.03953 / 0.25095 | 0.03973 / 0.25915 |
| `ripple` leg0 | 0.622 | 0.656 |
| fps | 36.8 | 34.6 |

**Identical, inside the run-to-run band.** Taking the sun's COSINE and
IRRADIANCE out of the temporal store changes the walk transient by nothing.

**⭐ AND THAT REFUTES THE UNIT'S OWN PREMISE, WHICH IS THE RESULT.** The sun
demonstrably owns the leg0 transient — pinned 0.0046 vs moving 0.0133, ~3× —
and making its two analytic factors analytic recovers none of it. So the stale
term that matters is one of the three the split does NOT touch:

1. ⭐ **`V` — VISIBILITY, and this is the leading candidate.** It is the one
   factor of `ρ·V·cos·E` that is NOT sun-independent and cannot be made analytic
   without re-tracing a shadow ray per bin per frame — the cost this whole module
   exists to avoid. It is also the factor that CHANGES MOST as a sun sweeps
   across an interior: beams move over the floor, and every shadow boundary in
   the room is a `V` edge. The split makes the smooth factors exact and leaves
   the discontinuous one stale, which is precisely backwards for this artifact.
2. **The MULTI-BOUNCE term.** `Lb = ρ/π · E_atlas` carries sun-derived light and
   stays fully accumulated in `BIN_R/G/B`. In a dark room that is most of the
   sun's arrival.
3. ⭐ **The §12.43 TRACKING WINDOW, which is cheap to test and worth testing
   first.** The Level's own log, every run: `light-track window: 1 arms in 2.0s,
   open 43-58% of frames — armed by shadow, peak 0.60 (threshold 0.5). An open
   window lifts the probe ray cap to OFF.` The window arms on the LIGHT MATRIX
   moving and then **deliberately discards accumulated history**. The split does
   not stop it arming — so GI is still throwing history away every time the sun
   turns, for a change the store now handles analytically. **Suppressing that
   arming for the SPLIT source is the natural follow-on unit and needs no new
   storage at all.**

### ⚖ SO WHAT TO DO WITH IT — the honest options

It is correct, gated, fps-neutral (39.1 vs 38.9 static; 34.6 vs 36.8 moving, both
inside the band) and it costs **42 MB of VRAM**. It buys nothing measurable on
this scene *today*.

- **Do NOT ship it as-is.** `__giSrcSunSplit` stays default OFF.
- **If the tracking-window follow-on lands and the pair helps**, arm both
  together and re-measure — the split is the thing that makes suppressing the
  window defensible, because with it the store no longer stales on sun rotation.
- **If that fails too, revert `BIN_WORDS` to 5** and keep only the harness
  controls, the gates and [[tsl-atomic-select-trap]]. The mechanism is written
  down here well enough to rebuild.

### ⚠ TWO THINGS THIS UNIT ALREADY PAID FOR — keep them

- **An AVERTED hit must never write the bin's normal.** One word holds one
  normal, last write wins, so an averted hit's normal zeroes `[F]`'s cosine and
  silences the transfer the bin's sun-facing hits spent many frames
  accumulating. Ungated, that cost **44% of the picture's luma at leg0 and 21%
  at leg1 WITH THE SUN PINNED**, and made the blockiness WORSE (leg1 `checker`
  0.0305 → 0.0557, rising rather than settling) because which normal won flipped
  frame to frame. Gated on `sunFacing`, the split is unbiased across the two
  populations. (This is a REAL fix and it is in; it was simply not the whole
  loss.)
- **`BIN_SN` MUST NOT BE DECAYED.** It is a packed pair of bit-fields plus a
  flag; `floor(x·keep)` on that is not a dimmer normal, it is a DIFFERENT
  direction, walking across the octahedral map a few thousand texels a second
  while every counter reads healthy. The decay stores it through unchanged and
  zeroes it only when the block is reclaimed.

### ⚠ THE MEMORY IS SPENT WHETHER OR NOT THE SPLIT IS ARMED — a live decision

`BIN_WORDS` is **9 unconditionally**. The four extra words cost ~42 MB of
`scratch` on the Level (52 → 94 MB) even with `__giSrcSunSplit` off, because a
layout that changes with a hatch is two addressings of the same buffer and this
module's own history is full of silent bugs from exactly that. **If the split is
ultimately not shipped, take `BIN_WORDS` back to 5 rather than leaving the
words allocated** — and if it IS shipped, the number stands as measured, with
the constructor's existing throw (which prints the arithmetic) as the guard for
a future pool that no longer fits.

### The seed composes with the split — worked through, do not "fix" it

`srcSeed` copies a parent's RESOLVED payload (sun already closed in) into the
SUN-FREE accumulator, which reads like a double delivery. It is not: the seed
also adds its weight to `BIN_COUNT`, and `[F]` divides both sums by it, so the
result is `w_seed·L_parent(full) + w_ray·L(full, now)` — a convex blend, which is
what the seed is for. The seeded fraction carries a STALE sun, decaying out at
the ordinary rate. (Moot in practice: every run reads `seed 0 probes`.)

---

**-11. THE PREVIOUS SESSION'S BANNER (2026-08-23, session 1), KEPT AS
CHRONOLOGY — everything from here down to `-10` is it.** ⚠ Its DIAGNOSIS
stands: the day cycle stales the store, and the unit it scoped is the one built
above. Its **MAGNITUDES do not.** Every number in it was taken before controls 5
(sun phase) and 6 (character pose) existed, so its headline "arrival 0.0415 →
0.0044, 9×" is one sample of a quantity that moves 10× with the time of day and
20× with where the walk cycle stopped. **Compare nothing against it.** Its
"identical runs now agree to 1–10%" was true only of the arms it repeated, all of
which pinned the sun; the arm that reproduces the user's complaint does not.

## The finding, in one paragraph

The user's "patches of light updating / bright and dark checkerboard when I
enter a new room, which gradually gets properly lit" **is convergence speed, as
they said from the start — and it is caused by their day cycle.** The sun
rotates continuously (~0.12°/frame, ≈5.6°/s, a full turn every ~64 s; this is
DELIBERATE, it is the dynamic-GI demo). Each probe stores ACCUMULATED RADIANCE,
and radiance is a function of sun angle, so every stored value is stale by an
amount proportional to how long ago that probe was last refreshed. Walk into a
new room and its probes are stale by DIFFERENT amounts — **neighbours disagree,
and that disagreement IS the bright/dark patchwork.** It resolves as evidence
accumulates.

Receipts (`probe:gi-walk`, character frozen, camera pinned after a 9 m walk,
leg0): **sun moving → arrival blockiness 0.0415–0.0419, decaying to 0.0044 over
~2.1–2.9 s. Same walk, sun PINNED → 0.0046 arrival, no decay at all.** A 9×
difference, reproducible to ~1%.

## ⛔ IT IS NOT FIXABLE BY TUNING — both levers are spent

| leg0, sun live | arrival | settled floor | settle |
|---|---|---|---|
| base | 0.0415 | 0.0044 | 2084 ms |
| `probeRayCap` 16→64 (verified to arm, rays ×3.8) | 0.0552 | 0.0052 | 1961 ms |
| α 0.06→0.3 | 0.0325 | **0.0078** | **2660 ms** |

**α ×5 leaves the picture 77% BLOCKIER at rest and settles SLOWER** — it buys
speed by converging on fewer effective samples, which is the wrong trade for
this artifact. The ray cap does nothing. Do not spend another session here.

## ⭐ THE UNIT: TAKE THE SUN OUT OF THE TEMPORAL STORE

No blend rate can fix a stored quantity that goes stale. **Split the probe
payload: cache the sun-INDEPENDENT part (geometry, visibility, albedo — none of
which change when the sun rotates) and re-evaluate the sun term ANALYTICALLY
each frame from the current angle.** Then a rotating sun invalidates nothing,
and only genuine multi-bounce residue accumulates slowly. This is what makes the
demo's dynamic GI actually dynamic.
Scope: touches the deposit's payload format ([E]/[J], `srcDeposit.js`) and the
shade path (`srcShade.js`); the merge/gather consume the same payload so their
readers move with it. NOT started — no design has been validated yet.
Gate before/after: `FREEZE=1 PINSUN=0 npm run probe:gi-walk`, statistic
`checker` on leg0 (arrival + settle ms), plus a 60 fps receipt on the Level.

## The instrument (built this session, working)

`npm run probe:gi-walk` — walks the Level room-to-room via `level.rooms()`, then
STOPS and measures the pinned window.
**`FREEZE=1 PINSUN=0` is the condition that reproduces the user's complaint**
(character frozen so it does not confound, day cycle running as they play it).
`SUNDEG=40` + `PINSUN=1` is the static control. `TELEM=1` is a separate run
(readbacks stall frames).

**⭐⭐ `checker` IS THE ONLY STATISTIC THAT CAN SEE THIS ARTIFACT**: absolute
neighbour differences (`|L(x,y)−L(x+1,y)| + vertical`) on a 320×320 crop AT
NATIVE RESOLUTION, normalized by local mean. Two independent reasons every
earlier attempt failed — the user's own included ("we kinda tried to measure it
a while ago, and couldn't, because dark and bright patches cancel out on each
other"): **(1) MEANS CANCEL** — a bright patch beside a dark one leaves the frame
mean untouched, and `err0`/`lum`/`ripple`/`tiles.meanLum`/`gather.meanLum` are
all means; **(2) DOWNSAMPLING ALIASES IT AWAY** — the probe captured 686×342 →
240×150 before measuring. Absolute differences cannot cancel; 1:1 cannot alias.

**⚠⚠ FOUR UNCONTROLLED INPUTS had to be found before ANY A/B on this harness
meant anything** — each produced confident numbers first, and two identical runs
once settled **48× apart**: (1) the scene animates a character (~10–15 s loop);
(2) the "is it static" fingerprint hashed intensity+colour but **not
ORIENTATION**, certifying a scene whose sun was turning; (3) **ORDER** — freezing
AFTER the convergence wait snaps the sun to `SUNDEG` and measures before the
field catches up; (4) the day cycle drives sun **INTENSITY** too. All four are
closed and the fingerprint is re-checked at END of run (`held throughout`);
identical runs now agree to 1–10%. **Demonstrate reproducibility before trusting
any arm.**

## Eliminated — do not re-propose without new evidence

Cold probes / §12.59.2 spatial seed (⚠ but see caveat below), bin-pool
starvation (`noBlock 0`), probe retirement (`live` collapsing is CORRECT — it is
the visible-cell count), the §12.61 rest cadence, multi-bounce, the surprise α,
converged-idle sleep (the SRC transport is not in `state.queue`), **the §12.80
shadow checkerboard — removing it is WORSE (leg0 0.0048 → 0.0197)**, and both
tuning levers above.
⚠ CAVEAT ON THE SEED: its counters read `0/0/0` while ~45 probes/frame are
minted during a walk, but `readStats` does its readbacks SEQUENTIALLY so the
seed words come from a different frame than the probe words. Settling it needs
the seed stats polled ALONE, at rate, during a walk. Currently UNMEASURED, not
refuted.
⭐ REFUTED AND WORTH KNOWING: **GI is NOT non-deterministic** — identical inputs
give identical results once the four inputs above are controlled.

## Open, unrelated to front 4

`Destroyed texture "ShadowDepthTexture" used in a submit` storms reproduce on
DESKTOP limits (with `renderPipeline_selectionOutlineMask` failing alongside) —
[[gi-portable-envelope]] recorded it as portable-only; it is merely intermittent.

## State of the tree

**`src/` IS UNTOUCHED — nothing was shipped this session.** One fix was written
and REVERTED: reading a directional light's aim from `light.parent` instead of
`light.matrixWorld` (to dodge the shadow fit's cancellation jitter) measured
IDENTICAL (`parentDir == maxDir`), so it fixed nothing and was backed out rather
than shipped on principle. New/changed files: `scripts/run-gi-walk-patches.mjs`
(new), `scripts/run-gi-light-jitter-probe.mjs` (now reports the OWNER's
rotation, which is what named the day cycle), `package.json` (`probe:gi-walk`),
this doc. The `GISystem.js`/`srcSystem.js` diffs in `git status` PRE-DATE this
session.

---


**-10. FRONT 4 MEASURED AT LAST (2026-08-23, user: "continue on black patches,
this is possibly the most important one"). THE RECORDED THEORY IS REFUTED, THE
SYMPTOM IS NOW A NUMBER, AND SEVEN MECHANISMS ARE DEAD.**

**⛔⛔⛔ THE HARNESS IS NOT REPRODUCIBLE, AND UNTIL IT IS, NO A/B ON IT MEANS
ANYTHING. Two IDENTICAL runs — same arm, same path, same pinned sun, both
certifying `scene STATIC` — settled to brightnesses 48× APART** (leg0 tail mean
luma 0.00294 vs 0.1404), with `err0` differing 15–25× on other legs. Everything
this session reported as an A/B magnitude (α ×5, ray cap ×4, secondary off, rest
cadence off, sun pinned vs moving, and the "α buys ~30%" figure) was measured
inside that band and **must be treated as unmeasured**. What survives is only
the non-comparative readings: what armed, what dispatched, what a counter read.

Three causes found and fixed so far, each of which produced confident numbers
before it was found — the pattern is the lesson:
1. **The scene animates** (character mixer, ~10–15 s loop) — `FREEZE=1`.
2. **The fingerprint that certified "static" hashed intensity and colour but NOT
   ORIENTATION**, so it certified a scene whose sun was turning 0.12°/frame.
3. **⚠ ORDER: freezing AFTER the convergence wait** snapped the sun from
   wherever the day cycle had carried it to the fixed `SUNDEG` angle — a large
   lighting discontinuity — and measured before the field caught up, a different
   jump distance every run. Freeze now precedes the convergence gate.
**RESOLVED — IT WAS A FOURTH UNCONTROLLED INPUT: the day cycle drives the sun's
INTENSITY as well as its angle.** Pinning orientation but not intensity left
every run at a different brightness. With intensity pinned and the fingerprint
re-checked at END of run (`held throughout`), two identical runs now agree to
**1–10% on every statistic** — leg0 maxStep 0.2626 vs 0.2598, leg1 maxStep
0.4293 vs 0.4318, leg1 tail luma 0.02440 vs 0.02469. **The harness is usable for
A/B from here.**
⭐ AND IT REFUTES THE SCARIER READING: GI is NOT non-deterministic. Identical
inputs give identical results; that lead is closed.

**⭐ WHAT SURVIVES ON THE CLEAN HARNESS — and this is now the real front 4.**
Scene fully static (mixers + 30 light pins, verified end-to-end), camera pinned:
- leg0 `ripple` **0.53–0.63** — the picture still moves ±50% in the tail — with
  a **0.26 single-frame per-tile pop arriving ~10 s AFTER the camera stopped**.
- leg1 a **0.43 pop 0.4 s after arrival**, `patch0` 2.4 (error concentrated in a
  few regions, i.e. the visible patchwork rather than a uniform tint).
Nothing in the scene is moving. That is "patches of light updating" reproduced,
isolated and repeatable — the first time this session that is true.

⚠⚠ METHOD, and this session is the case study: an instrument that attributes
"everything that changed" to the system under test must PROVE every other input
held still, FOR THE WHOLE MEASUREMENT, and must demonstrate REPRODUCIBILITY
before a single arm is compared on it. This one ran ~10 arms across three
sessions' worth of conclusions before either check existed.

**⭐⭐⭐ ROOT CAUSE, 2026-08-23: THE SUN IS ROTATING. CONTINUOUSLY. ~0.12° PER
FRAME (≈5.6°/s — a full revolution every ~64 s), ON A PARKED CAMERA.**
`probe:gi-light-jitter`, extended to measure the OWNER as well as the light:

    DirectionalLight  parent Sun  maxDir 0.00217  parentDir 0.00217
                                  parentPos 0.00000  maxPos 2.98  moving 120/120

`parentDir == maxDir` with `parentPos == 0` proves it is **the Sun ENTITY's own
orientation**, not the shadow fit (which writes only the light's local position
and target — that is what `maxPos 2.98` is, and it is correctly ignored for
directional lights). 0.00217 rad/frame is **0.81× ALPHA_MOTION_SAT**, i.e. right
in the band srcConfig already names as "a CONTINUOUS sun (the user's day-cycle
script: 2–6× ALPHA_MOTION_SAT)". **This scene has a day cycle running, and GI is
faithfully tracking a light that never stops moving.**

**THAT IS WHY EVERY LEVER MEASURED AS A NO-OP.** α ×5, ray cap ×4 (verified to
arm), secondary off, rest cadence off, surprise off, idle sleep, seeding — none
of them can converge an estimate whose TARGET moves every frame. Worse, the
motion is above the arming threshold, so the §12.43 tracking window keeps
re-arming: the irradiance history weight is driven to zero, the decay root is
relaxed and the ray cap is lifted — **GI deliberately discards accumulated
history, continuously, because it has correctly concluded the sun is moving.**
The user's "patches of light updating" is a field permanently mid-convergence.

⚠ A FIX ATTEMPT WAS MADE AND REVERTED: reading the aim from `light.parent`
instead of `light.matrixWorld` (to dodge the shadow fit's cancellation jitter)
measured IDENTICAL — `parentDir == maxDir` — so it fixed nothing and was backed
out rather than shipped on principle. The jitter theory was wrong; the sun is
genuinely rotating.

**THE REAL QUESTION IS NOW A DIFFERENT ONE, and it is the one to design against:
how should GI look correct while the sun moves continuously?** Not "how do we
converge faster" — there is no converged state to reach. Directions worth
weighing: (a) is the day cycle meant to run this fast, or at all, in the editor?
(5.6°/s is a 64 s day — if that is a debug speed, the whole symptom may be a
content setting); (b) the sun's direct+first-bounce term is analytic and could
be recomputed per frame rather than accumulated, leaving only the slow
multi-bounce residue in the temporal store; (c) accumulate in a frame that
FOLLOWS the sun (sun-relative bins) so a rotating sun does not invalidate
history at all. ⚠ FIRST: confirm with the user whether the day cycle is
intentional here.

**⛔⛔⛔ READ THIS BEFORE ANY NUMBER BELOW: THE PROBE'S FOUNDING PREMISE WAS
WRONG ON THIS SCENE, AND SEVERAL VERDICTS BELOW ARE CONTAMINATED.** The whole
design rests on "pin the camera and every remaining change IS the GI field" —
which assumes a STATIC scene. **This Level animates a skinned character in the
editor, continuously, on a ~10–15 s loop.** A per-sample fingerprint of the
scene's own inputs (6 bones + 15 lights, `sceneFingerprint()`) changes at EVERY
sample: 13643 → 13631 → 13643, smoothly, forever. So:
- The "sustained limit cycle / `ripple` 0.25–1.37 with the camera pinned" is
  **the animation loop**, not a GI feedback loop. Its ~10–20 s period IS the
  clip's period.
- It is also why NO GI knob ever moved the tail — α ×5, ray cap ×4, secondary
  off, rest cadence off, surprise off. **GI was correctly tracking a moving
  scene**, and the instrument was scoring that as a GI defect.
- Any verdict below that leaned on `ripple` or on the late tail is void until
  re-run. `err0` / `maxStep` at ARRIVAL are less affected but not clean either.
**`FREEZE=1` is now mandatory for a convergence measurement**: it zeroes every
`AnimationComponent` mixer plus `engine.time.timeScale`, then VERIFIES the
fingerprint actually stopped (it prints `FROZEN(n mixers, scene STATIC)` or
names the residual drift — a freeze that silently failed would restore the exact
bug it exists to remove).
**A real transient SURVIVES the freeze**, so the target is still there: frozen,
leg0 overshoots 4× and settles in ~5–6 s; leg1 peaks at 0.29 and is STILL
decaying (0.046) at +15 s. That — not the oscillation — is front 4.
⚠ METHOD, the general form: an instrument that attributes "everything that
changed" to the system under test must PROVE the other inputs held still. This
one ran six arms and three sessions' worth of conclusions before it did.

**⭐ THE INSTRUMENT: `npm run probe:gi-walk`** (scripts/run-gi-walk-patches.mjs).
Walks the real Level room-to-room using `level.rooms()`' own capture points,
then **STOPS and only then measures**. That is the whole trick: while the camera
moves, parallax changes every pixel and the GI transient is a few percent on
top, so any statistic taken during motion measures the camera. Pinned, every
remaining frame-to-frame change IS the field. Reports `err0` (distance from the
settled frame), `settle95`, **`maxStep`** (largest single-frame per-tile jump —
a pop is what the eye catches, the mean hides it), **`patch0`** (std/mean of
per-tile error = is the error a uniform tint or a patchwork), **`ripple`**
(coefficient of variation of whole-frame brightness over the SECOND HALF of the
window — the only statistic that can tell a converged field from a limit cycle,
because an error-vs-reference curve cannot when the reference is itself a point
on the cycle), an absolute `lum` trace with timestamps, per-cascade probe
telemetry at arrival AND at rest, and the console window around each arrival.
`TELEM=1` is a SEPARATE run on purpose — `readStats` is a GPU readback that
stalls the frame it lands on, and `maxStep` compares consecutive frames, so a
stalled frame manufactures exactly the pop the statistic exists to detect.

**⚠ THREE INSTRUMENT TRAPS PAID FOR HERE, all of which produced confident
wrong numbers first:** (a) the Level's GI takes **~30 s** to build, so the first
three runs measured the BOOT — the probe now waits for `[gi] field ready:` and
that marker must be stamped AFTER `scene.open`, because the editor boots into
the previous scene and fires it too; (b) `ensureEngine()` is what CREATES the
engine, so a node-side wait for GI's console markers placed before it waits
forever (240 s of it); (c) `level.rooms()` returns a room on a stray storey at
**y = −498** on this Level — walking to it is an 18 m vertical teleport that
swamped every statistic, so waypoints are filtered to the median storey.

**WHAT IS ESTABLISHED (Level, high, 686×342 viewport, reproduced across 6 runs):**
- **Stop walking and the picture is still wrong for 7–20+ seconds.** leg0:
  `err0 0.117, settle95 7057 ms`, brightness 0.118 → peaks 0.247 at +3 s → 0.003
  by +7 s (a 2× overshoot then a 40× fall). leg1: `err0 0.21`, brightness 0.25 →
  0.02 over ~18 s. **The overshoot is the "black/white patches updating".**
- **`maxStep` up to 0.98 and `patch0` 1.2–3.6** — the error is not a uniform
  tint, it is a few regions very wrong against a converged background, which is
  exactly the visible-patchwork shape. The error heatmaps show whole SURFACES
  (a doorway, a wall, the character) converging at different rates.
- **At some poses it NEVER settles: `ripple` 0.25–1.37 with the camera pinned
  and the scene static** — leg1's brightness oscillates ±40% with a ~10–20 s
  period, indefinitely. A limit cycle, not slow convergence.
- **The engine logs NOTHING during any of it** (console window −3 s…+22 s around
  every arrival is silent). No re-mint, no watchdog, no pool grow.
- **At rest the ladder is NOT healthy: merge orphan 27–31%, corners 4.08–4.70/8**,
  and it DEGRADES from arrival (18–27% / 5.2–5.3) as the probe population relaxes.
  ⛔ This directly contradicts -9's "at rest the ladder is HEALTHY (orphan 1.4%)"
  — that reading did not describe this scene at this pose.

**⛔⛔ REFUTED — do not spend another session on any of these:**
1. **The cold-probe/seed theory that -9 named as the designed fix is DEAD.**
   `seed 0 probes, 0 cold, 0 orphan` in EVERY sample of every run. §12.59.2's
   LOD+1 spatial seed targets a mechanism that measures ZERO here. (It is also
   gated on `worldKeysEnabled()`, twice vetoed, so it could not have shipped as
   built anyway.)
2. **Bin-pool starvation** (the Bistro cause): `noBlock 0`, `failed 0`, c0 live
   peaks at 2665/16384. Not this.
3. **Probe retirement/`live` collapsing** (1769 → 243 within ~2 s of stopping)
   is CORRECT BEHAVIOUR, not a bug: `live` is the count of distinct VISIBLE
   cells, and `attempts` is 58653 = pixelCount every frame because
   `createInsertPass` counts only non-empty keys and every pixel has geometry.
   Chasing it cost a run.
4. **The §12.61 rest cadence**: `__giSrcRestCadence=false` changed nothing
   (`ripple` and the transient persist). Measured `stride 1` at arrival and only
   **2** at rest — so the strided pixel selection (`thread·stride + phase`) is
   NOT the "grid-like pattern" either; that theory died on the measurement.
5. **Multi-bounce feedback**: `__giSrcSecondary=false` — ripple 0.87, worse.
6. **The surprise-driven α**: `__giSrcSurprise=false` — ripple 0.29, unchanged.
7. **Converged-idle sleep** (`GI_IDLE_AFTER_FRAMES` 180 / heartbeat 30): the SRC
   transport is explicitly NOT in `state.queue` and is dispatched ahead of it
   (GISystem ~2490, with the comment saying why). Not gated by idle.

**⚠ ALSO FOUND: the `Destroyed texture "ShadowDepthTexture" used in a submit`
storm is NOT portable-only.** It reproduced here on DESKTOP limits, during and
after the walk, alongside `Async render pipeline creation failed
(renderPipeline_selectionOutlineMask…)`. -9 recorded it as portable-only and
intermittent; it is just intermittent. Whether it is causally connected to the
brightness transient is UNTESTED — a broken shadow map would unshadow the sun
and over-light the field, which is the right SHAPE for the overshoot, and that
is the first thing the next session should check.

**⭐⭐ THE ARITHMETIC CLOSES — IT IS CONVERGENCE SPEED, AND THE USER SAID SO
FIRST ("this is convergence speed + temporal accumulation, they are slow").
No bug is needed to explain the measurement:**

>  **τ (frames per e-fold) = (1 / α) × (frames per BIN refresh)**

- `TEMPORAL_ALPHA_STILL = 0.02` ⇒ **50 refreshes** per e-fold once parked
  (`TEMPORAL_ALPHA` 0.1 while moving; `CAM_SETTLE_ALPHA` 0.05 is the floor held
  after a move — for `REST_CAM_HOLD_MS` 600 + `REST_CAM_FADE_MS` 400 ≈ **1 s**).
- `probeRayCap = 16` at high over `binCount(0) = 32` bins (W0 = 4) ⇒ a c0 bin is
  refreshed **once every 2 frames**. Rays are traced per PIXEL and summed per
  probe ([D1]), then **hard-clamped at the source** ([D1']), so `tracedRays`
  (117 306/frame measured) is an upper bound and the real deposit rate is
  ≈ live × cap. Up the ladder each parent sums ~3 children (measured 838 → 228 →
  73 → 24) while bins go ×4, so per-bin evidence drifts ~4/3 worse per level:
  ≈ 2 → 2.2 → 2.8 → 3.7 frames per refresh.
- ⇒ τ ≈ 100–200 frames ≈ **2–4 s** at the measured 47 fps, and settling (~3τ) is
  **7–12 s. That is the measured 7–20 s.** Nothing is broken; both factors are
  simply conservative.

**AND IT EXPLAINS THE 27–31% MERGE ORPHAN RATE as the same thing, not a second
defect:** a bin that has not been refreshed decays under `MIN_WEIGHT`
(`DEPOSIT_SCALE >> 6`) and is written `PAYLOAD_UNKNOWN`; the merge's 4→1
pre-average then finds `known == 0` and the corner is absent. Orphan rate is a
READOUT of per-bin refresh sparsity. (The population/consumer mismatch noted
below — the ladder inserts ONE parent per child via `keyCellOf` = nearest cell
while the merge reads the EIGHT trilinear corners of `floor(f)` — is real and
still worth its own look, but it is NOT the convergence explanation.)

**⛔⛔ AND THEN THE LEVERS THEMSELVES WERE MEASURED, AND THE TWO OBVIOUS ONES
ARE BOTH VOID ON THIS SCENE. Convergence is limited by NEITHER α NOR the ray
budget.** (Instruments: `probe:gi-walk TELEM=1` now prints `alpha` from
`__giSrcAlphaLive`, `meanU` from `__giSrcSurpriseLive`, `boosted` from
`__giSrcBoostedLive`, and the REAL fired `rays` from `stats.totalRays` — the
published `tracedRays` is only an upper bound because [D1'] clamps per probe.)

1. ⛔ **"Raise α / hold the settle floor longer" — VOID. α is ALREADY 0.04–0.10
   on the Level, not `ALPHA_STILL` 0.02**, measured continuously with the camera
   pinned. `readAlpha()` is scene-motion driven and something in this scene
   keeps it near `TEMPORAL_ALPHA` 0.1. So the premise of the whole lever was
   wrong and extending `CAM_SETTLE_ALPHA`'s envelope would buy ≈nothing. **It
   was refuted before a line of it was written** — which is the only reason to
   measure before building.
2. ⚠ **The per-block fast-α ALREADY EXISTS AND NEVER FIRES.** The decay mixes
   `keep′` toward `surpriseF = TEMPORAL_ALPHA / α_now` per block (srcDeposit's
   `surprise` bundle), so a surprised block would already converge at α 0.1.
   Measured **`meanU` ≈ 0.00000 and `boosted` 0** in every sample of every run —
   which by srcSystem's own three-way diagnostic (~1888) is the **"never
   surprised"** state: the governor or `SURPRISE_MIN_EVIDENCE`. Worth arming,
   but note (1): α is already high, so the ceiling this can reach is small.
3. ⛔ **"Spend the unspent ray budget" — VOID, and this one is the surprise.**
   The observation was real: the deposit fires **3 864–12 676 rays/frame against
   a tier ceiling of 131 072**, because `probeRayCap = 16` binds on every probe
   and only 243–838 probes are live (`live × 16` matches the fired count
   exactly). But `__giSrcProbeRayCap = 64` — **verified to arm, rays 3 864 →
   14 734 (3.8×)** — moved NOTHING: err0 0.0374 → 0.0378, maxStep 0.909 →
   0.853, patch0 1.55 → 1.46, ripple 0.168 → 0.176, fps 34.4 → 34.0.
   **4× the evidence rate buys no convergence, so the bottleneck is downstream
   of the deposit.**

**WHERE THE LAG MUST THEREFORE LIVE — measure a STAGE before touching anything
else.** Two candidates, both with their own time constant:
- **The multi-bounce iteration.** leg1's brightness RISES 0.14 → 0.57 over 16 s
  with the camera pinned; `__giSrcSecondary=false` flips that same leg to a
  DECAY. Energy iterating toward its geometric-series equilibrium one partial
  bounce per frame is exactly a slow monotone ramp, and no amount of c0 evidence
  speeds up an iteration count.
- **The screen-side irradiance temporal filter.** `_giIrrHistWeightU` runs up to
  **0.98** and is deliberately **held HIGH under camera motion** (reprojection is
  supposed to cover it), i.e. τ up to ~50 frames ≈ 1.5 s of display lag on top of
  whatever the field does. `__giIrrHistWeight` pins it for an A/B.
The next unit is an attribution probe: trace deposit → merge → tiles → gather →
displayed on one timeline and see which stage's curve lags which. Guessing has
now cost three refuted levers; the chain has four stages and each publishes a
mean already.

**-9. THE 2026-08-23 FOUR-FRONT SESSION (user: emissive leaks / slow GI init /
"on mobile only emissive lighting works" / patches updating as the camera
moves). Two ROOT CAUSES found and fixed, one unit rebuilt and left OPT-IN,
one diagnosed only.**

- **⭐⭐ MOBILE (front 3) IS A PORTABLE-LIMIT VIOLATION, AND IT KILLED THE WHOLE
  TRANSPORT.** `buildSurfAccumCompute` bound **NINE storage buffers** against
  the WebGPU baseline of EIGHT (pairSlot/pairTri/pairChunk + index + bits +
  localToWorld + vertexBuffer + attrScratch + surfScratch). On any baseline
  device `occupancy#7`'s pipeline layout is invalid, every bind group built
  from it fails, the occupancy chain never runs — and with no field there is
  no transport, so the sun's bounce disappears while the SCREEN-SPACE emitter
  term keeps working. That asymmetry is exactly the user's report, and it is
  the signature to remember: **live resolve over a dead transport = emissive
  only.** Reproduced on the 4070 by pinning all five limits `resolveRendererLimits`
  raises back to their spec defaults (new `probe:gi-portable`): pre-fix the arm
  logged the 9-vs-8 validation error, an invalid-layout cascade and DEVICE
  LOST; post-fix 0 kernels over the limit and a live field (rays 18104,
  secondaryHits 17161, tiles lit 83072, gather mean 0.0441).
  **FIX: the (slot, triangle, chunk) work list is ONE interleaved buffer**
  (`pairWork`, `PAIR_WORDS = 3`) — 9 → 7 on the surface fit, 8 → 6 on
  complexWrite, 7 → 5 on the voxelizer. AoS with a CONSTANT stride, not SoA at
  `pairCap` offsets: a scene-dependent baked offset is an R11 text change per
  boot and kills the disk cache.
  **WHY IT SHIPPED INVISIBLY, and both holes are now closed:** (a)
  `sceneSettings.js` has asked desktop adapters for 16 storage buffers since
  2026-08-16, so no desktop could see it; (b) `gi-gpu-smoke`'s portable audit
  walked `state.queue` + `srcProbes.passes` only — **the occupancy chain is
  dispatched separately and was never in the audited set**. The smoke now
  censuses `prewarmComputes()` too AND **FAILS** on >8 (it previously only
  logged, on the theory that the pinned device's refusal would surface
  elsewhere — it does not: the refusal is an uncaptured error on a skipped
  dispatch, so the arm stayed green on a build that cannot run on a phone).
  A deferred `#auditPortableBindings()` also runs in the engine 5 s after each
  compile wave and names any kernel over 8 against the BASELINE, never against
  this device's limit (`__giPortableAudit = false` silences it).
  ⚠ STILL OPEN, portable-only and intermittent: a `Destroyed texture
  "ShadowDepthTexture" used in a submit` storm (300+). NOT the gi-shadow
  decline — the `nolightshadow` arm (desktop limits, `__giNoLightShadows`)
  reproduces the decline with ZERO such errors.

- **⭐ GI INIT (front 2) WAS ONE KERNEL: `emitterShadowPass`, 4 JS-INLINED
  MARCHES.** `probe:gi-boot` warm on the Level: TTFF 6.5 s and 12.9 s across
  two boots (the 2× spread is why in-boot latency is never the instrument),
  with emitterShadowPass **81% and 90% of it**. The dumped WGSL named the
  cause — `giDynTrace00110` and `giEmitterFactor` at FOUR call sites each,
  4 loops / 216 ifs / 103 kB — while a 250 kB kernel beside it compiled 2×
  faster. §13.14.5's per-inline law again: cost tracks CALL SITES, not bytes.
  **FIX: `slots.forEach` → a GPU `Loop` with the predicated-gather shape
  `createSrcHitLighting` already uses for the light slots** (select a virtual
  slot per iteration, select the result back out; slot keys are INTERSECTED
  rather than listed so `exHalf`/`moved` do not need a second definition of
  what a slot is). Emission change, not an estimator change — every slot still
  gets its own march, its own analytic factor, its own admission gate.
  **RECEIPTS, both axes:** isolated compile (`probe:wgsl-compile`, 3 reps, one
  process) **6095 → 1593 ms = 3.8× faster**, kernel 103 → 92 kB, call sites
  4 → 1; frame cost (GPU timestamps, 60 samples, Level @ high) **1.31 →
  0.66/0.56 ms = ~2× cheaper**. Gates: emitter-tsl 41 green, emitter-shapes
  855 green, shadowed-bulb delivers 0.6488 (vs 0.6475/0.6482 recorded).
  The pole is now the RESOLVE (2.0 s isolated) and no single kernel dominates:
  post-fix the top five sum ~7 s isolated where the emitter kernel ALONE was
  6.1 s before.

- **U3 REBUILT SMOOTH (front 1) — AND IT STAYS OPT-IN, with its cost finally
  measured.** The revert's three named preconditions are met: (a) suppression
  is SMOOTH — new `occupancyAtWorld`, `occupiedAtWorld` trilinearly filtered
  (⚠ half-voxel shift: the binary reader FLOORS to a cell index, so
  interpolating means interpolating between CENTRES; without the shift every
  reading is biased half a voxel toward −xyz, 11 cm on a 0.22 m grid, in a
  test whose whole job is deciding which side of a 0.25 m wall a probe is on);
  (b) two shoulders — a per-sample one at 0.5 (GEOMETRIC: filtered-binary
  reads exactly 0.5 ON the surface, so anything lower makes the one-voxel
  skirt occlude) and a PATH one over the mean (a wall is a RUN of blocked
  samples, a graze is one); (c) the gate can now see collateral.
  **MEASURED: the leak returns EXACTLY to the 0.333 neutral baseline on both
  crops — and the BINARY reader, today, removes almost nothing (0.423 →
  0.411).** The filtered read is strictly more sensitive; the historical
  one-bit receipts do not describe today's field.
  **⚠ THE COST, and it is why this is not flipped: ~28% of LEGITIMATE in-room
  indirect light** (collateral arm, red source dark: control 0.0310 → 0.0224,
  ratio 0.72–0.77 across runs). Suppressed corners are the BRIGHT ones — on
  thin geometry the probe nearest a surface is IN it, carrying that surface's
  own bounce. Whether that is correctness or over-suppression is a question
  for the user's eyes on their Level, per the standing rule.
  **TWO INSTRUMENT FIXES, both of which had been scoring the right answer as a
  failure:** the ±20% CONTROL band failed a COMPLETE removal (every crop of
  room B is leak-lit — the control crop itself read redness 0.404 against the
  0.333 baseline), and the leak is red-TINTED not pure red, so its own green
  and blue move the achromatic component too (predicted removal 0.0095 vs
  0.0083 measured) — a min-channel statistic cannot separate them either.
  So: the lit rig REPORTS control, and a new **`REDSTRENGTH=0` COLLATERAL ARM**
  (source dark, no leak to remove, every difference is collateral) ASSERTS it.
  Default arms are now `off,on`. Both configurations green.
  ⛔ **U3b (merge LOS) measured INERT on this rig** — alone it moved the leak
  0.413 → 0.426 while cutting 52.4% of corners; the gather term does the whole
  job. It stays opt-in and should be re-justified before it is ever flipped.

- **FRONT 4 (patches while moving) DIAGNOSED, NOT TOUCHED.** At rest on the
  Level the ladder is HEALTHY (`merge orphan 1.4%`, corners 4.55/8, 103224
  bins) — so the mid-play 32–45% orphan rate and the visible patches are the
  COLD-PROBE transient, not a broken merge: probe insertion is
  visibility-driven, so entering a room mints a wave of probes that converge
  in view. The designed unit is §12.59.2's LOD+1 SPATIAL seed fallback (built
  once on `backup/gi-arc-0822`, reverted with the arc). It is a look change
  and must go to the user ALONE, per the arc's post-mortem.
  ⚠ Recorded while looking: the `smoke:gi-gpu ?src=1` "39% of bins found no
  parent (mean 4.00/8 corners)" failure is NOT the dead-merge bug — it is
  FLAT for 42 s of live frames, and **4.00/8 is geometrically forced on that
  planar scene** (the probes sit on a floor; the parent shell's upper corners
  do not exist). That assert is partly measuring the rig.

**-8. THE DISPLAY-VALIDITY UNIT (2026-08-22, after the user's "we still got
those black patches everywhere" on the reverted arm).** The black-rectangle
class was traced to an R1 violation at the DISPLAY: `srcScreenGather` wrote
`vec4(E, 1)` even when the gather found NOTHING (shellTotal 0), so an
absence rendered as confident black; the §12.65 temporal filter then (a)
blended real history toward that black every frame and (b) its variance
clip — moments over an all-black unknown neighbourhood, σ = 0 — CRUSHED
valid history to zero. Post-revert forensics that motivated it: reanchors 1
within minutes of play, c1 live 9193 → 1037, tiles 65% empty texels,
meanKnownBins 10/32, seed rescuing 0 — the reverted arm re-exposes cold
churn as rectangles, so the fix had to live at the display, arm-agnostic.
SHIPPED: gather alpha = validity (known: shellTotal > 0), resolve threads
it through the composite (`knownF`, max'd with the F3 far-field weight;
irradiance + rawCopy alphas), and `createGiIrradianceTemporalPass` grew
`validityAlpha` (irradiance chain only): unknown raw + validated known
history → HOLD history outright (bypasses history.weight — stale beats
black by the user's bar), variance clip skipped for unknown centres and
unknown neighbours excluded from moments, stored alpha = output validity so
held light self-sustains until real data lands. Never-seen regions (no
history) stay honestly dark. giLight reads rgb only (verified — the
bilateral weights by gbuffer position); glossy/hit chains untouched
(validityAlpha false). Gate: `test:gi-src-gather` re-run on the change.

**-7. ⛔⛔ WORLD KEYS: THE USER'S SECOND LIVE VETO (2026-08-22, late
evening). "It was a lot better before we moved to world keys. Now it is
just trash."** Reverted to OPT-IN (`worldKeysEnabled() === true` arms;
srcMath's header carries the full stop-order) together with -6's
detail-box level arming (the 20 m camera-following box put the F3
far-field boundary INSIDE the house and slid every few steps; it shipped
in the same hour, so the veto covers both — if its density win returns it
does so ALONE, via the hatch, with its own live look). CPU gates re-ran
green on the reverted defaults (src-math 694, worldkeys, src-ref);
delivered by reload, post-revert frame clean. **THE STANDING LESSON, NOW
PAID TWICE: every rig receipt for world keys was true and none predicted
the live look. The re-flip precondition is a discriminating instrument ON
THE USER'S LEVEL that the user has personally accepted — plus the
mid-play merge-orphan question (30-45%) answered, since world-keys /
locality-retirement sit on its suspect list and an orphaned bin's partial
answer is a visible "patch updating" no crop-mean gate sees.** Kept from
-6: U3b (arm-agnostic), auto room probes, radianceDiv 3 below ultra, the
profile merge/seed/tiles relay. Also recorded: the user's acceptance bar,
in their words — "never see any blocks, neither black or white patches
updating; always properly lit smooth light, no matter where we go" — and
their deliberate sky-light-0 choice (see -6's corrected bullet).

**-6. THE 2026-08-22 EVENING SESSION (user: "nothing is fixed yet" → the
sky-light find). Five ships, one root named, receipts below (⚠ read -7:
two of these were REVERTED the same night):**
- **U3b SHIPPED default-on** — merge-side cross-wall LOS (`mergeLosWeight`,
  srcMerge [G.1] corner march over `occupiedAtWorld`, floor 1e-3, samples
  4/6/8 by cascade, `MERGE_LOS` telemetry, `__giMergeLosWeight=false` hatch).
  Gate grew ARM_FLAGS (off/on/merge/both; default off,merge) + merge-stats
  forensics. RIG VERDICT INCONCLUSIVE ON THE ENDGAME: with the auto-retry
  retired the rig's ladder NEVER heals (orphan 45%, minLum 0 at measurement;
  the march armed and cut 48.2% of corners, never-worse/control/noise all
  green, baseline-return FAIL 0.392→0.382) — on a broken ladder the leak is
  corner-selection, which merge-side validity cannot reach BY DESIGN. Also
  named: a straddling parent CELL with a same-side centre carries the far
  room's deposits and a centre-to-centre march cannot convict it — if the
  healthy-ladder receipt stays weak, the next step is deposit-side or
  split-parent validity, not more marching.
- **U4b SHIPPED** — auto per-room reflection probes: `levelRooms()`
  (level-design/rooms.js — per-storey flood fill of wall footprints,
  openings rasterized SOLID so doorways don't merge rooms; gate
  `test:level-rooms` ALL PASS), `LevelComponent.rooms()` duck-typed, GISystem
  `#syncAutoRoomProbes` (60-frame cadence, hand-placed probes override their
  room, slots after hand probes, `__giAutoRoomProbes=false` hatch). LIVE on
  the Level first boot: "3 room(s) derived beside 3 hand-placed".
- **DETAIL BOX: LEVEL SCENES ARM AT ROOM SCALE (20 m)** regardless of the
  60 m trigger — ⭐ the AXIS CAPS make extent the direct density dial: the
  city-rule 42 m box at ultra still pinned voxel 42·1.05/128 ≈ 0.37 and
  probes at the 48-axis 1.0 m; the 20 m box lands **voxel ~0.18, probes
  0.50** at the SAME budgets (live: "22.5x9.5x22.5m, probes 0.50m"). This is
  the honest answer to fronts 2 (0.37 m block quantum) and 4 (density), and
  it shrinks the 70-of-88 thin-mesh shared-record population.
- **HIT-SHADE radianceDiv 3 BELOW ULTRA** (`createGiBvhTarget` option;
  ultra keeps 2) — bvhHitShade measured 4.42 ms of a 16.6 ms GPU frame at
  "high" (the 50 fps report); div 3 is ~-55% of it. Cost is whole-kernel
  register pressure, ∝ threads.
- **⭐⭐ SKY LIGHT 0 IS THE USER'S INTENT — DO NOT RE-FLIP IT.** I enabled
  `environment.lighting` (the frame read evenly lit) and the user corrected
  me: it is OFF DELIBERATELY because "ambient or sky intensity just fill
  the whole scene evenly, so contrast gets lost — there are never true
  dark corners." Reverted and re-saved. **The real finding hiding in
  their reason: the occluded-sky design SHOULD give them exactly what they
  want** (sky only through openings, sealed corners truly dark — the merge
  resolves T→0 through walls), and the "even fill" they measured is the
  ORPHAN DEFECT: 30-45% of bins never resolve their parent chain and
  composite `T_self·sky` with only ~1 m of occlusion — flat sky fill
  indoors. The same defect reads as crushed black at sky 0 (bins that
  should carry bounced light carry nothing). FIXING THE LADDER'S
  ORPHAN/CONVERGENCE RATE IS THEREFORE THE SINGLE UNIT THAT SERVES BOTH
  ARCS: contrast-correct sky (so the user can turn it back on and keep
  dark corners) AND front 5's camera-dependence. Sell any sky-lighting
  suggestion to the user ONLY with an orphan-rate receipt in hand.
- **⚠ METHOD: every editor reload re-mints the field — the user kept
  judging 30-60 s convergence transients as "worse and worse".** Batch
  edits, reload ONCE, and tell the user when the frame is judgeable.
- **ULTRA LEDGER (post-change, editor view):** emitter-shadow chain is the
  new dominant GI cost (~5.3 ms pass + ~1.4 filter/wide at 743×358);
  resolve is FULL-RES at ultra (2.2-3.2 ms); bvhHitShade/bvhReflect
  dispatched ZERO at a mirrorless view (consumer gate works); srcProbes
  5.7 ms. 60 fps at ultra needs the emitter-shadow estimator priced next.
  Steady-state merge orphaning 32-45% mid-play with movement is the
  standing QUALITY suspect (parents' bins UNKNOWN under ray striding —
  front 5's camera-dependence); the §12.56 signature line on this scene is
  the known minLum-0 false-positive shape, but the orphan rate is real.
- Open from tonight: U2 naming (unchanged), the masked-prepass bug
  (unchanged), pool-grow compile hitch mid-play (c0 16384→21875→32768 with
  two ~20 s reflProbeCapture recompiles), the leak gate's healthy-ladder
  U3b receipt.

**⚑⚑ STANDING USER RULE (2026-08-22, memorize-grade): PERFORMANCE IS TOP
PRIORITY — over 60 fps under ANY conditions; never ship what looks bad OR
drops below 60. Every feature carries its visual receipt AND its Level-scale
frame cost.**

**-5. THE USER'S POST-FIX VERDICT (2026-08-22 evening, 5 screenshots at
56-57 fps steady): "world keys is great" — but four items stand:**
(1) **"lighting blocks update on the way — must not happen"** → named: cold
COLUMNS at the walk frontier (cascade-parent seed skips them by design; its
own header deferred the spatial fallback) + retention expiring at 1 min.
BUILT same night: §12.59.2's LOD+1 SPATIAL seed fallback (srcSeed.js —
same-cascade probe one LOD up, whose 2× cell reaches back into converged
space; 1:1 bin mapping, flag-checked probe lookup against trap 3;
world-keys arm; `SEED_SPATIAL` telemetry) + retention age 3600 → 14400
(safe by the 60%-capacity yield). Validation boot pending.
(2) **"more blocky artifacts on walls"** under world keys — the lattice is
world-LOCKED now, so block boundaries persist instead of swimming; U2's
naming run (which channel quantizes) is still the path, now with the
world-anchored profile.
(3) **mirror almost black** → U4b auto per-room reflection probes (started:
level-design rooms exist, ReflectionProbeComponent exists — placement
wiring is the remaining work).
(4) **emissive leaks + glossy quality** → U3b (ladder cross-wall validity)
and the probe/glossy chain (U5/R-C) — next sessions.

**-4. ⭐⭐⭐ §12.56 RESOLVED ON THIS SCENE — IT WAS NEVER A PIPELINE RACE
(2026-08-22, last hours).** Three instruments, in order: (1) an
`uncapturederror` listener now lives at device init (Engine.js) — nothing in
the engine had EVER subscribed to the device error stream — and across
two-strike-confirmed dead signatures it caught ZERO errors, refuting the
"async pipeline failed validation" theory outright; (2) a no-retry control
boot (`__giNoDeadFieldRetry=true`) healed with ZERO re-mints — the "dead
merge" is extreme-contention SLOW CONVERGENCE misread by a wall-clock
watchdog, and every re-mint was a freeze that also RESET convergence;
(3) the frame-counted second strike STILL fired — which cracked the
signature itself: **minLum is the minimum over ALL tiles, and any scene
with a permanently unlit region (the user's Level: Sky Light 0, shadowed
interiors) pins minLum at 0.0000 in the HEALTHY steady state** — the
dead-merge signature never clears there at any progress clock, and the
with-retry boots stayed dark at measurement while the no-retry boot healed
(the re-mint RESETS convergence and delays the heal it claims to be).
**FINAL: the auto-retry is RETIRED to log-only** (`__giDeadFieldRetry =
true` re-arms for A/B); the watchdog stays as telemetry and the
uncapturederror listener names any real GPU failure from now on.
VALIDATED: the retired-retry boot logged the signature once, re-minted
ZERO times, healed naturally — and its anchor-relative recovery-after-walk
was only a mild dip (−18% floor, healed in 3 s), which HONESTLY REVISES
the -3 entry's black-room evidence: the catastrophic −100% returns were
substantially the retry's own field wipe, and the residual transient is
the milder thing U1's retention polishes (its rig gates measured that
cleanly: recovery 720→120 ms, transient −33.7%→+6.6%). The U1 default
stands on those receipts + the movement-cost exoneration. METHOD:
a watchdog's timebase must be the watched thing's PROGRESS CLOCK, never
wall-clock — and a threshold on a MINIMUM statistic is broken by one
legitimate zero. The long-open `smoke:gi-gpu ?src=1` failure and the
"dead boots are deterministic" claims should be re-read in this light.

**-3. ⭐⭐ THE USER'S "HEAVY FREEZES" WERE THE §12.56 AUTO-RETRY FALSE-FIRING —
FIXED WITH TWO-STRIKE CONFIRMATION (2026-08-22 night).** The retry's single
+5 s check could not tell "pipeline failed validation" from "pipeline still
COMPILING": on a contended machine the wave's pipelines land for 10–26 s and
[J]'s can compile on first dispatch, so `secondaryHits === 0` at +5 s was
routinely a pipeline in flight. The watchdog then re-minted a HEALTHY field
(full chain rebuild + compile storm mid-play = the freeze), re-checked the
retry's own wave mid-compile, burned attempt 2 identically and stamped a
false "DEAD FIELD" — the user's live ledger shows attempts 1/2 and 2/2 firing
during their play session, and the detail-density probe reproduced the full
false sequence on a boot whose field measured ALIVE two minutes later. Fix
(GISystem watchdog): the dead signature must PERSIST across two readbacks
8 s apart before any re-mint — a compiling pipeline lands between strikes, a
genuinely invalid one is dead on both; real-wedge recovery is ~8 s later,
which is nothing against a false re-mint. The Level-scale probe
(`run-gi-detail-density-probe.mjs`, frozen GAME snapshot) also EXONERATED
world keys + retention for movement cost: wkret walked BEST of five arms
(median 25 ms vs base 50) — the U1 revert's freeze attribution was wrong;
its re-flip now waits only on contention-clean confirmation + the dim note.
Probe receipts: the §13 F1 detail box WORKS on the Level
(`detailExtent:16` → voxel 0.31→0.14, legacy probes 1.00→0.50, SAME
budgets; SRC s0 stays tier-fixed 0.45 — the box refines the FIELD-CELL
quantum, which is the 0.33 m block scale the user's wall artifacts sit at)
and movement got CHEAPER with it (median 50→41.7 ms, heavy frames 83→20,
slides 3→17 at ~0.3 ms each). ⚠ Probe traps burned: a dead/converging
field renders raster-only and BIT-IDENTICAL across arms (quality crops need
an ALIVE gate, not just convergence); recovery must re-issue the held pose
(walk-end pose compared against held pose = meaningless percentages);
cross-arm absolutes are confounded by the user's live editor over a
30-minute run.
ALIVE-vs-ALIVE PAIR RESULTS (two-strike watchdog live — it caught ONE
genuine two-strike-confirmed dead-merge and healed it, no false
exhaustion): (a) blockIndex DID NOT move with the finer field cells
(base 2.9–3.6 vs detail16 2.7–3.6 at this pose/lighting) — the detail
box's visual payoff is UNPROVEN by single-boot step energy; the U2
method rule applies (N≥4 or a within-boot dial) before any policy
ship. (b) The STARK repeatable contrast is RECOVERY AFTER MOVEMENT:
base (anchor-relative) returns to a DARK view (−38…−100%, still dark
+3 s — the §5 symptom quantified at Level scale) while detail16 and
wkret return BRIGHT (+14…+54%) — movement-stable lighting is the
world-keys/detail-follow win the user can feel, and the U1 re-flip
case now rests on it plus the exonerated freeze attribution.
**→ ✅ U1 RE-FLIPPED DEFAULT-ON the same night** after the deciding pair:
base's third alive-held run again returned from the walk BLACK (ceiling
−100%, still black +3 s) while wkret's post-walk crops read 0.91/0.88 lit
and stable — five boots, one direction. CPU gates re-ran green post-flip.
srcMath's header carries the full story; `__giSrcWorldKeys=false` is the
hatch.

**-2. THE 2026-08-22-LATE SESSION: U1 + U3 FLIPPED ON, THEN ⛔ REVERTED THE
SAME NIGHT BY THE USER'S LIVE LOOK (5 screenshots, mid-play).** "A lot worse
overall, heavy freezes when moving around, many consistent blocky artifacts
on the walls." Attribution from the screenshots: stair-stepped light
boundaries at occupancy-voxel granularity on walls = the LOS march's BINARY
0/1 corner suppression (the Q9c lattice-artifact family — the gate measured
CROP MEANS and a mean cannot see a stair-step); the BLACK floor inside the
mirror = the hit-shade gather starving where LOS floors every corner; the
movement freezes = the world-keys/retention arm at Level scale (~10× the
rig's population — the freezeless gate ran on a ~1k-probe rig and did not
transfer). Both hatches are OPT-IN again (`__giSrcWorldKeys === true`,
`__giGatherLosWeight === true`); srcMath's two headers carry the re-flip
preconditions: LOS needs SMOOTH suppression + a starved-black clamp + a
BOUNDARY-smoothness gate; world keys need a Level-scale movement price with
retention bisected. ⚠ METHOD: a rig gate that passes is not evidence about
the user's scene (the standing rule, paid again — at editor scale BOTH flips
regressed within minutes of play). All receipts below remain valid AT RIG
SCALE. THE NEXT GI UNITS: fix-and-re-price U1/U3 per the preconditions, and
**U3b — LADDER CROSS-WALL VALIDITY** (§15 U3 block, the ⭐⭐ entry): on a
healthy field the through-wall leak rides the cascade MERGE (parent cells
span walls), fix in srcMerge's parent lookup — same one-bit march at merge
rate. The los rig doubles as the best §12.56 reproducer yet (fires 3/3
boots on `scripts/.gi-gather-los-high-p0.5`).

**-1. THE SIX-FRONT ARC (2026-08-22) IS THE CURRENT FRAME — read §15.** The
user's consolidated GI verdict: (1) reflections still bad on both tiers,
(2) blocky artifacts at low sun intensity, (3) skinned-proxy bounce carries no
colour, (4) probe distribution/density, (4b) emissive leaks through walls,
(5) lighting changes as the camera rotates in a static room. §15 maps the six
to three roots and units U1–U7 with an execution order. ⚠ The round-3
reflection build (nested stand-in everywhere + widened probe floor) is BUILT,
ALL GREEN and **UNDELIVERED** — play mode blocked the reload; deliver it and
re-look before re-judging any reflection symptom.

**0. THE QUALITY ARC IS OPEN — read §14 first (2026-08-20).** The user's ten
symptoms, seven mechanisms, units Q1–Q9. Q1 (prevVP writer), Q2 (capsule
self-shadow + joint bridges), Q3 (checkerboard motion smear-fill), Q4 (C2
falloff + halved tier cutoffs + range-gate fade), Q5 (validated rescue/clip),
Q6 (distance-robust filter eps), Q7 (emitter area sampling + temporal ON),
Q7b (moving-occluder history clip), and the k=1 gather normal weight are ALL
SHIPPED UNPRICED-LIVE — the user's next look decides what gets re-tuned.
Remaining: Q8 (tile-weight bilinear), wide₂ decorrelation, the skinned 0.85
floor re-price, §12.56 auto-retry, mobile ladder. (AO pricing is CLOSED — see
0b below: the oracle ladder was replaced, not priced.)

**0b. AO + GLOSSY REFLECTIONS SHIPPED DEFAULT-ON 2026-08-21 (gate:
`npm run probe:gi-ao-glossy`).** The two parked "completeness" terms, made
affordable and flipped:

- **AO (`ao: true` in giConfig).** The occupancy-oracle ladder inlined in the
  resolve (never priceable — §13.7f's unfinishable compile; §13.7d's 0.7 m
  blind zone) is REPLACED by `createGiAoPass` (giScreen.js): a screen-space
  8-tap Alchemy-style pass over the GI gbuffer's world positions, own half of
  nothing — it runs at resolve res on `srcProbes.passes`, and the resolve
  pays ONE texture sample on the indirect term only. IGN rotation is
  per-pixel-stable, so no temporal debt. Live dials unchanged
  (`__giAoOverride = {strength, radius}`); `__giConfigOverride={ao:false}` is
  the kill. Measured on the gate rig: pass 0.021 ms; full-vs-zero strength
  swings the box-contact strip ×1.023 against ×1.001 on open floor
  (discrimination 23:1). ⚠ RIG LESSON: an emitter-lit floor is mostly
  emitter-DIRECT light, which AO deliberately does not touch — gate on the
  live dial's SWING, never default-vs-off cross-boot.
- **Glossy radiance (§12.71b v2, `__giGlossyRadiance !== false`).** The v1
  ledger's three preconditions are built, so the default flipped:
  `createSrcGlossyGather` ([I'] in srcSystem, half gather res) evaluates
  `gatherAt(P, N, reflect(V,N))` — gatherAt grew an optional `sampleDir`
  param; the tap direction changes, the §13.7d one-sided weight stays on the
  surface normal — with a hue-preserving luminance cap (`__giGlossyCap`,
  default 6) at the write; the §12.65 temporal filter is REUSED on the
  radiance chain (`#armGlossyTemporal`, ratio-aware gbuffer reads, byte-
  identical WGSL at 1:1) sharing the irr filter's prevVP/weight uniforms —
  a reader, never a second writer; the resolve samples the filtered texture
  into the radiance target and giLight's already-wired specular slot does
  the rest (mirrors still take exact-BVH/SSR over it). Measured: metal
  sphere 0.28 lum vs 0.00 on the off arm (the "pitch black metal" state),
  held-pose drift 0.7% (v1 was flickering blobs), glossy gather + temporal
  0.036 ms. Emitter de-dup is answered by R5: zeroed field emission means
  the bins carry lit surfaces, not emitter disks.
- Plumbing notes: both new passes + the far-field pair now push MATCHING
  `passGroups` entries (profile.giPasses' sum assertion was silently broken
  by farField's group-less pushes on any detail-extent scene — fixed at all
  three sites).
- **EDITOR-SCALE PRICE (ultra, 1920×1080 window): 0.431 ms combined** — ao
  0.17, glossy gather 0.131, glossy temporal 0.13 — beside the diffuse
  gather's own 1.01 ms; ~1.3% of the user's ~33 ms ultra frame. AO
  discrimination IMPROVES at full res (contact ×1.079 vs open ×1.001).
- **The RESIZE re-arm path is validated** (the probe shrinks the window 28%
  and re-samples): both terms live after `#syncScreenResolveSize` rebuilds
  them. ⚠ GATE LESSON: the post-resize sample must be POLLED — a resize
  rebuilds ~56 pipelines and frames present black GI until the async
  compiles land; a one-shot sample read 0.0000 on a healthy rebuild. A real
  dead binding stays black past the poll's 25 s timeout.
- **`smoke:gi-gpu` is GREEN again.** It was red since `88bd34b`
  (sceneSettings.js asks the adapter for 16 storage buffers; the smoke
  asserts the portable-8 pin at device creation — every arm died before any
  GI code ran). Fix: `globalThis.__engineLimitsCap` in
  `resolveRendererLimits` — a per-key CEILING on the ask — and the smoke
  pins `{maxStorageBuffersPerShaderStage: 8}`, so its assertion again means
  "GI fits the portable envelope" on any adapter.
- ⚠ OPEN, PRE-EXISTING: the smoke's **`?src=1` arm FAILS** — "39% of known
  bins found no parent value (mean 4.00/8 corners) — the cascade ladder is
  not connected". Attribution is clean: it fails identically with
  `__giGlossyRadiance=false` (this change structurally inert). It was
  invisible because ALL smoke arms died at device creation since `88bd34b`,
  so the break landed unnoticed sometime after — candidates: world-keys /
  locality retirement (08-17) or the static-merge commit itself. Live GI is
  demonstrably healthy (gather parity 0.14%, temporal, shadowed-bulb all
  green), so suspect the ARM'S OWN assert is stale against the retention
  changes before suspecting the merge.

**0c. THE FIRST LIVE LOOK'S FIVE REPORTS, ALL ACTED ON 2026-08-21 (same
day).** The user's Level, ultra: "glossy reflects only emissives", "quite far
from what is actually there" (mirror columns = mosaic patches), "no hdri env
in the reflection", "no character in the mirror", "AO weak or absent", plus
"add ao/reflections toggles to the component".

- **First separate the boot from the code:** that session's editor hit the
  §12.56 dead-[J] race (the watchdog said so at 18:34) — with [J] dead the
  bins carry no shaded radiance, glossy degrades to emitter highlights and
  the room to flat sky-ambient. It recovered on the field re-mint; a fresh
  boot was clean. §12.56 auto-retry stays the top reliability item.
- **ENV-ON-MISS (§12.71b v3):** an exact-reflection ray that traced the
  whole static BVH and LEFT has proven the environment visible along R — the
  one occlusion-correct place to sample the HDRI (§12.64's suppression was
  about UNOCCLUDED per-material IBL). Prepass: traced miss = t −2 (−1 stays
  "never traced"); resolve: negative alpha in the bvh color target (the
  exact-hit blend now CLAMPS alpha — an unclamped mix would extrapolate);
  giLight composite: equirectUV sample of the scene env, rotated to match
  environmentRotation, gated by the mirror-roughness ramp and `step(1e-4,
  intensity)` (no env = term inert, never a black darkening). Equirect only;
  a cube env keeps intensity 0. Persistent node + placeholder texture, so an
  env change is a value swap.
- **THE MOSAIC ON CURVED MIRRORS = the stride replication:** blocks handed
  neighbours a t whose reconstruction (their OWN normal) shades a different
  surface. Normal tolerance 0.9 → 0.965, rejected neighbours now write −2
  (env/field fallback — smooth) instead of −1, stride default 3 → 2 on the
  ultra-only path. Verified live: the columns went from colour patchwork to
  coherent wall/glow/sky reflections.
- **AO "weak or absent" was the PIXEL CLAMP:** at a 931-px resolve, 0.6 m at
  4 m wants 149 px of tap radius and the clamp held 48 — the taps spanned a
  THIRD of the authored radius while the falloff normalized against all of
  it. Fix: clamp 3..64 + falloff renormalized to the EFFECTIVE radius the
  taps actually cover; defaults 0.6/0.6 → 0.8/0.8.
- **THE COMPONENT HAS THREE PROPERTIES NOW** (user request): `quality` +
  `ao` + `reflections` toggles. Coherent with the one-knob doctrine: a
  toggle removes a whole term at a whole cost, it cannot mis-TUNE anything —
  no tuning knob returns. `reflections: false` kills the glossy chain, the
  material specular arming AND exactReflections; only an explicit `false`
  acts. Both structural in `#structuralSignature`.
- **The character in mirrors stays out of scope for the BVH** (skinned tris
  can't live in a static BVH — "Chainer" is excluded to capsule proxies);
  that reflection belongs to SSR, which the user's SRC.post already chains.

**0d. "REFLECT THEM AS THEY ACTUALLY ARE" — THE SAME-DAY ATTEMPT, ITS TWO
RECEIPTS, AND THE PLAN (2026-08-21 evening).** The user's follow-up: reflected
surfaces are FLAT COLORS (hit shading = atlas albedo × field + UNSHADOWED
emitter/sun direct — no occlusion at hits), and screen-space is explicitly
rejected ("SSR sees only what is on screen — useless in most cases").

- **RECEIPT 1 — traced hit shadows in the resolve: 66 ms, and it is REGISTER
  PRESSURE, not marches.** Flipping §12.56's diet default-on (occupancy-cone
  emitter shadows + a new sun cone via `analyticDirectAt`'s new optional
  `shadowFn`) took the user's resolve 5.95 → 66.6 ms — and the MASKED arm
  read the same 66 ms with ~10× fewer hit pixels. Equal cost across a 10×
  hit-count difference convicts whole-kernel occupancy collapse (the marcher
  bloats the pipeline's register footprint; every pixel pays, branch taken
  or not). CONSEQUENCE: no in-resolve gating can ever make traced hit
  shadows affordable — they must live in their OWN pass. Both defaults
  REVERTED same-day (hit shadows opt-in `__giHitEmitterShadows = true`,
  auto-on only under a working mask via `bvhShade.masked`; the machinery —
  cone-not-record-march, sun shadowFn — is SHIPPED and correct, just not
  default).
- **RECEIPT 2 — the masked-mode visual bug is REAL.** The §12.56 reframe
  ("the mask only shifts compile-race odds") plus the new watchdog re-roll
  justified a flip attempt; the boot was clean, but the user's first PLAY
  frame was WASHED OUT (blown-white regions) at 10 fps — the documented
  masked-side bug, reproduced live. Re-reverted. Diagnose with
  `MIRROR=1 run-gi-emissive-cost.mjs` + `run-gi-mask-bisect.mjs` before any
  third attempt.
- **UNIT R-A (next): a dedicated BVH hit-shade pass.** Extract the resolve's
  `bvhShade` branch into its own kernel: prepass → hitShadePass (reads hit
  t/normal + albedo, reconstructs, shades with gather + CONE-shadowed
  emitter/sun direct, writes bvhRadiance + the −1 miss marker) → resolve
  never binds the marcher or inlines gatherAt again (its 168 kB WGSL
  shrinks, compile and register pressure both). The 2026-08-02 "16 uniform
  buffers vs baseline 12" objection is OBSOLETE on desktop: sceneSettings
  now asks the adapter for 24 — gate the pass on
  `device.limits.maxUniformBuffersPerShaderStage ≥ 16`, decline to the
  field-only mirror on baseline devices. With the pass separate, traced hit
  shadows are a per-PIPELINE cost the resolve never pays, and masked mode
  (when its bug falls) shrinks the pass's own dispatch.

  **✅ R-A SHIPPED 2026-08-22** (the morning after receipt 1; trigger: "on
  ultra those are washed out solid colors without GI or any lighting" —
  which was exactly the unshadowed-dense trade rendered visible).
  `createGiBvhHitShade` (giScreen.js) is the resolve's bvhShade block
  verbatim, in its own kernel, with **traced cone shadows DEFAULT-ON at
  every density** — `__giHitEmitterShadows = false` is now the escape hatch
  back to flat hits (it used to be the dense default). The resolve lost the
  block, the marcher, and its always-inlined gatherAt copy entirely (its
  kernel shrinks; the 66 ms register-pressure class cannot recur there).
  Wiring: built beside the resolve in `#buildScreenResolve` from the same
  `inputs` bundle; rides all three queues right after the resolve;
  rebuild+splice at BOTH stale-closure sites (`#syncScreenResolveSize`,
  `#rebuildSrcProbesForPools`) — it closes over the gather closure and the
  bvh targets exactly like the resolve does. Miss markers (0 / 1 / −1)
  unchanged, giLight untouched, `light.bvhReflectShaded` still keys on the
  bundle. Gate: `npm run test:gi-hit-shade` (rig
  `makeHitShadeProject.mjs`: ultra, mirror wall −Z, ceiling panel, wide
  occluder; crops project floor points' MIRROR IMAGES — reflected
  lit/shadow contrast ×2.97 traced vs ×2.12 flat-arm, noise 0.2%, 0
  pageerrors, boot line `hit-shaded` both arms). The flat arm measured the
  old bug: ~2.7× too much light in the mirror. `QUALITY=high FORCE_EXACT=1`
  is the same gate's exact-at-high pricing arm (via `__giConfigOverride`).

  **⚠ LIVE PRICE, SAME DAY (user's Level, ultra, 1719×931): bvhHitShade
  43.26 ms — the 17 fps report.** Register pressure was only HALF of
  receipt 1; the other half is the raw march cost at DENSE: every resolve
  pixel runs up to 3 emitter cones + a sun cone + the inlined gatherAt.
  Cross-check: emitterShadowPass runs the same cones at 731×396 for
  5.93 ms — scale to 1.6M pixels ≈ 33 ms, plus gather ≈ the measured 43.
  The fix is the glossy chain's own trick: shade hits at HALF the resolve
  grid (the prepass already block-replicates t at stride 2 — full-res hit
  shading was resolution theater), temporal-filter at that grid, let the
  material's screenUV sample upsample. ~11 ms ultra / ~2.7 ms high
  projected. Same-day round 2 also shipped: rejection marker −2→−1 (block
  seams straddling detail painted SKY speckle fringes via env-on-miss — a
  rejection proves nothing about the environment), the §12.65 temporal
  pair on the hit radiance (`#armBvhHitTemporal`, markerAlpha mode keeps
  the −1/0/1 marker out of the blend), and the user's SSR node un-broken
  live (thickness 0→0.35 — zero thickness never registers a hit;
  maxLuminance 1→6 — every bright reflection clamped to grey;
  maxRoughness 1→0.6 — the documented bright-rectangle guard). The mix
  the user asked for (SSR first, exact/probe/field beneath) was already
  the layering; SSR was simply configured inert.
- **UNIT R-B (the cheap, good, world-space answer): BOX-PROJECTED REFLECTION
  PROBES.** The industry default for exactly this ask: small cubemaps
  captured in-world, PMREM'd for roughness, box-projection parallax
  correction — a texture fetch per pixel at runtime, world-space, shows LIT
  surfaces. This engine's wrinkle: the deferred GI terms are SCREEN-SPACE
  textures keyed to the main camera, so a naive CubeCamera capture reads
  garbage GI — the capture must use the LEGACY IN-MATERIAL gather path
  (giLight's no-gbuffer arm, which still exists precisely for "no screen"
  contexts) at small faces (128–256 px), amortized (a face per N frames, or
  on room change). Best case is exactly the user's level: box rooms make
  box projection nearly exact. Design: a ReflectionProbe component (auto
  one per level-design room is the zero-authoring path), capture through
  GI-lit materials, giLight blends probe → glossy field → exact BVH by
  availability and roughness. This is the "cheap reflections that look
  good" answer; R-A stays the mirror-exactness answer at ultra.

  **✅ R-B SHIPPED 2026-08-21 (same night)** — with one architecture change over the sketch
  above: the capture is a TRACE, not a CubeCamera. The gbuffer holds no
  albedo (it's applied in-material), so a rasterized capture would have
  needed the legacy material arm compiled per-material; instead the capture
  kernel (`reflectionProbeCapture.js`) runs one thread per octahedral texel
  of a 128² tile, traces `bvhScene.firstHit` from the probe centre, and
  shades hits with EXACTLY the resolve's bvhShade formula (albedo × (gather
  + cone-shadowed emitter direct + cone-shadowed analytic direct) / π ×
  intensity), env-on-miss through the same `_giEnvMissNode` bundle. This is
  the receipt-1 marcher IN ITS OWN PASS — 16 k texels, register budget
  nobody else pays. Storage: ONE 2D atlas (`reflectionProbes.js`,
  384×1024 = 3 levels × 8 slots of 128² oct tiles, half-float), 3
  cone-blurred roughness levels (golden-spiral direction-space taps, level
  mix by the sharp/soft/rough smoothstep ladder). Sampling: in-material in
  giLight's spec composite between the field lookup and the exact blend —
  box-feathered weight, BPCEM parallax correction, 2×8 unconditional
  `textureSampleLevel` fetches. Wiring: `ReflectionProbeComponent`
  (`reflection-probe`, box = `size`×entity scale, gizmo box), probe
  EXISTENCE in the structural signature (everything else is uniform
  writes), slots/atlas system-lifetime, per-frame slot sync + at most ONE
  round-robin capture dispatch per frame (dirty first, refresh every 16
  frames), staleness re-arm on bvhScene/srcProbes/shadowTraceFn identity.
  `#syncBvhScene` now builds the BVH for probes at EVERY tier —
  probes-only builds skip the per-pixel prepass and the exact material arm
  (own boot line). Gate: `npm run test:gi-reflection-probes` (rig
  `makeReflProbeProject.mjs`: red wall −X / green wall +X / metal sphere;
  the hue split must arrive THROUGH the probe atlas).
  Traps recorded:
  · a BLACK metal sphere is an EMPTY ATLAS before it is a broken shader:
    the sphere's only light is the probe reflection and the atlas is zero
    until the capture pipeline lands (~12 s wave; WGSL changes cold-cache
    the driver) — the gate POLLS its first sample (resize-gate lesson
    generalized). The sampler was ALSO rewritten to pure dataflow after a
    black run; that attribution is UNVERIFIED (the race may explain it) —
    pure dataflow kept as the safe idiom regardless;
  · guard the parallax normalize (0×NaN poisons the weighted sum) and
    derive box-exit signs via step (sign(0)=0 divides by zero);
  · the capture kernel is a boot's slowest single compile (11.6 s / 159 kB
    WGSL on the gate rig, background wave) — named `reflProbeCapture` in
    the pipeline ledger; if it ever needs to shrink, split trace→scratch /
    shade→scratch like R-A;
  · GATE LESSON: the SRC field is POSITIONAL — it already carries wall hue
    on this rig (off-arm split 0.18), so probe-vs-field hue is parity, not
    a discriminator; the probe's adds are anchoring, sharpness and
    behind-the-camera coverage, and the gate asserts the split THROUGH the
    probe (it dominates inside its box).
  Deliberate v1 limits: static BVH only (no movers/characters in probe
  reflections), world-axis-aligned boxes, deferred-path only, probes ride
  the `reflections` toggle. R-C and per-room auto-placement remain open.

  **LIVE ROUND, SAME NIGHT (user's GAME/Level).** "It looks almost the
  same" → three real findings:
  1. **Placement matters and the user's first guess was the natural one**:
     one 30×10×30 probe on the LEVEL ROOT, capture point [0,0,0] = lying on
     the floor, box spanning three rooms. Replaced live over MCP with three
     room-fitted probes at eye height (probe edits are uniform writes — no
     rebuild, order add-before-remove so the count never touches 0). The
     per-room auto-placement item graduates from nice-to-have to REQUIRED:
     nobody will hand-place these correctly.
  2. **"On high it reflects just some random mess" = a FLAT-MIRROR
     magnification limit, not a bug.** A big flat mirror blows a small
     angular window of the oct tile across the whole surface — 128²
     (~2°/texel) reads as soft blurry blocks (the user's grey-blue mush =
     their skylights in the capture). TILE bumped 128→256 (still 65k
     amortized rays; blur taps 24→32). Structural: flat mirrors want
     PlanarReflectionComponent or ultra's exact BVH at ANY probe
     resolution; probes are the glossy/curved/every-tier answer. ⚠ A
     first "fix" attempt suppressed the SDF mirror arm under probe
     coverage — MISDIAGNOSIS, reverted: the deferred build nulls
     `mirrorTraceFn`/`mirrorSampleFn` (GISystem ~7700), so the SDF mirror
     block never even compiles there. Check whether a block COMPILES
     before blaming it.
  3. **"On ultra still flat" decomposes into (a) hits shaded UNSHADOWED at
     DENSE** (the receipt-1 trade — R-A is the fix) **and (b) SKY through
     walls**: 85 eligible meshes vs the 64-seat BVH cap seated "the first
     64" in WALK ORDER, leaving whole walls unseated — rays flew through
     them, "proved" the environment visible, env-on-miss drew sky indoors.
     FIXED: seat-by-size (world-AABB area ranking in `buildBvhScene`) —
     overflow is now the smallest props. A cap RAISE stays open (per-ray
     mesh-loop cost at DENSE is why 64).
  ⚠ HARNESS RULE, learned twice tonight: vite serves SOURCE to a running
  gate — editing src/ while a gate's page is live contaminates the run
  (HMR mid-boot rendered the probe arm black and burned a full
  investigation on a phantom). Land edits, THEN launch; never overlap.
- **✅ R-B2: THE COSINE IRRADIANCE TILE — SHIPPED 2026-08-22** ("incorrect
  reflections in the perfect mirror"). The probe atlas grew a 4th level
  that is a full COSINE-HEMISPHERE convolution (blur pass special-cases it:
  64 cosine-distributed golden-spiral taps, weight 1 each — the cosine is
  in the distribution, so the tile stores E(dir)/π exactly). The nested-
  render irradiance fallback had been sampling the widest CONE level
  (0.45 rad ≈ 26°) and multiplying by π — a 26° cone along N is NOT
  irradiance: it misses the bright sunlit floor and returns the saturated
  hue of whatever faces the surface, which rendered the planar mirror's
  room as swirly green walls over a red-brown floor. The roughness→level
  ladder gained a third smoothstep (0.55–0.9) so roughness-1 lands on the
  cosine tile — which also widens rough-metal probe reflections toward
  physical.
- **✅ NESTED-RENDER REFLECTION ARBITRATION — SHIPPED 2026-08-22.** Every
  screen-keyed reflection source in giLight's chain (deferred cascade
  texture, exact-BVH blend, mirror trace) holds MAIN-view data and stamps
  garbage inside a planar reflector's mirrored render. In nested views
  (`light.giNestedView`) the probes are now the ONLY reflection source:
  probe weight forced to 1, exact/mirror gates ×0; without probes the
  directional term is killed (dim beats ghost).
- **✅ R-C STOPGAP: PROBE FLOOR AT HIT SHADING — SHIPPED 2026-08-22**
  ("many artifacts" on the chrome box). The field gather is screen-fed —
  behind the camera its pools are patchy and a starved gather reads
  near-black (the brown/dark mottle on glossy tops). createGiBvhHitShade
  now floors the BOUNCE term with the probe cosine tile by LUMINANCE
  (whole-winner select, never a mix — mixing tints; floor-only because a
  starved gather always errs dark; ÷intensity to undo the atlas's
  premultiply). Inert without probes. NOT added to the capture's twin
  formula — the capture writes the atlas this reads. Real R-C below
  supersedes this.
- **✅ R-D: CHARACTERS IN EXACT REFLECTIONS — SHIPPED 2026-08-22** ("no
  character in another material with roughness 0 metalness 1"). Skinned
  meshes are BVH-excluded and the SDF arm that once drew them in mirrors
  never compiles on the deferred path (mirrorTraceFn nulled) — so exact
  reflections showed a world without the player. createGiBvhReflect now
  UNIONS the dynamic-object set's tracer (`_dynSet.trace`, objId arm) over
  the static BVH: nearest t wins, proxy normal rides .zw like a BVH hit,
  `surfaceAt` mean albedo rides the color target — downstream hit shading
  lights a reflected character like any surface (field gather + probe
  floor + cone-shadowed direct). Covers ALL dyn-set shapes (per-bone flesh
  boxes/capsules + bridges, adopted movers). `dynamicBlocked` is skipped
  when the union is live (those pixels resolve instead of flagging);
  `__giBvhDynReflect=false` is the hatch. Dispatch guard: the kernel
  closes over the dyn set's `bits` — a `dynSet` identity mismatch at
  dispatch skips + marks `_bvhSceneStale` instead of submitting against a
  retired buffer. KNOWN v1 LIMITS: mean-albedo flat colour (no card
  lookup yet), and the §12.65 hit-radiance EMA will trail a fast-moving
  reflection slightly. NO dedicated visual gate yet — the proxy-fit test
  is CPU-only; verified live on the user's Level (a browser rig needs a
  vendored skinned character — debt).
- **✅ PLANAR "BOOTS BLACK" KILLED FOR REAL — 2026-08-22.** Two stacked
  causes beyond the already-fixed material race: the attach chain can run
  before the WebGPU renderer exists (component now rAF-defers), and — the
  killer — the reflector's first mirrored pass created its pipelines while
  the GI compile wave had the postprocess MRT pinned (the documented
  invalid-pipeline class: cached, silent, black forever; why remove+add
  post-wave always "fixed" it). GISystem now emits `gi-compile-wave-done`
  at the wave commit point and PlanarReflectionComponent re-arms on it.
  Verified: cold load boots a lit mirror, no manual step.
- **✅ ROUND 2 POLISH — 2026-08-22 morning** ("shadows in mirrors look very
  weird" / "proxies don't inherit colours" / "a lot of artifacts"):
  · **Sun-shadow giUV**: `#acquireLightShadowNode` sampled the gi-traced
    shadow channel by screenUV — in a mirror's nested render its position
    validation mostly rejected (dark) but coincidentally ADMITTED main-view
    lit values near surfaces: the bright/dark patchwork on mirrored floors.
    All taps (bilateral + PCSS blocker + spiral) now project through
    `_giResolveVPU` like giLight's giUV — identical in the main render.
  · **Soft probe floor**: the hit-shade luminance floor became a smoothstep
    blend (field ≥80% of probe → pure field, ≤35% → pure probe) — the
    whole-winner select was flipping per hit point (speckle, recoloured).
  · **KTX2-safe per-bone proxy colours**: the fit's CPU canvas sampler
    cannot decode compressed skins (this project compresses textures!), so
    the fit now also keeps per-bone UV SUBSAMPLES; GISystem's
    #resolveSkinnedProxyColors blits the texture on the GPU
    (readTexturePixelsGPU, sibling of the bounce-albedo average), means
    each bone's texels, mutates the fit's SHARED colour arrays (bridges +
    adopted entries hold the same instances) and `dyn.touchSurface`s every
    proxy to force the words 34..36 re-publish.
  · **Ultra traces per-pixel** (`strideDefault` 1 at ultra, 2 below): the
    stride-2 replication rejections interleave the exact image and the
    probe fallback PER TEXEL on complex reflected content — the mirror-wall
    salt-and-pepper. Banner Sponza pays the full 13 ms at ultra; that is
    the tier's contract.
- **UNIT R-C (endgame): reflection-driven probe population** — seed SRC
  probes at reflection HIT points (the prepass already produces them per
  pixel) so the field exists behind the camera where mirrors look, and hit
  shading inherits converged, NEE-shadowed radiance instead of flat direct.
  Latency = probe convergence; cost = population budget, not per-pixel
  marches.

**1. ✅ SPARSE-EMITTER SPLITTING — SHIPPED 2026-08-17.** See §13.7h below.
Measured on the user's own cafe, boot ledger: **19 of 19** sparse meshes refit,
worst fill **6.0e-5 → 3.5e-1**, and only **5 of 130** emitters still sparse
(was 19 of 95). Gate: `npm run test:gi-emitter-split`.

**2. ✅ S1's DEFAULT FLIP SHIPPED 2026-08-22 (late).** `worldKeysEnabled()` is
now `!== false` (srcMath.js) — world-absolute keys + locality retention are the
default; `__giSrcWorldKeys = false` is the A/B escape hatch. The three GPU
gates all passed (`npm run test:gi-worldkeys-flip`, storm rig, high): G1 pixel
diff mean 2.49/255 p99 7 vs a 0.40 cross-boot noise floor; G3 teleport max
frame 17 ms at median 8.3 (shipped's own max was 42); G4 across three 200 m
laps: live 995→995, 0 dropped inserts, **0 re-anchors vs shipped's 15**, heap
slope equal to shipped's pre-existing drift. CPU gates re-run green post-flip
(src-ref bit-identical 14.4%→11.1%, worldkeys 6/6, src-math 694). ⚠ OPEN
OBSERVATION: the world arm converges ~4.7% dimmer at the held pose (0.2079 vs
0.2182) — smooth, not structural (p99 7); consistent with the lattice sitting
at a different phase than the anchor-relative one. Watch for it on the user's
next live look before chasing it.

**3. E3/E6** (`collectEmitters` over pre-merge members — wins back 448 draw
calls), then the cleanups: `AttributeNode: uv not found` spam, the jsHeap slope,
and `COUNTER_FRESH` reading 0 through `readPressure`.

**4. The 5 emitters still sparse after the split** are single connected pieces
that do not fill their own bounds (worst 3.5e-1, i.e. 3× too bright before
damping). §13.7g handles them correctly and they are no longer a delivery
failure — but if one is a facade mask, the right fix is the SPATIAL one the old
refusal comment describes, not a tighter fit.

✔ **The user's project is back as found.** `Spotlight_Emissive.mat`'s diagnostic
`emissiveStrength` 150 was reverted to 1 (2026-08-17). Nothing else was touched.

⚠ **METHOD RULE EARNED TODAY, THE HARD WAY.** Every emissive rig in this repo
authors a FLAT emissive colour, so none of them could reproduce the bug that
actually cost five sessions (a TEXTURE-driven `emissive` input). A rig that
passes is not evidence about the user's scene. **Read their material and their
live ledger first** — `console_read` + `material_get` over MCP found it in
minutes after rigs had missed it for weeks.

New gates registered this session: `test:gi-shadowed-bulb`,
`test:gi-emitter-size`, `test:gi-src-worldkeys` (pure Node),
`test:gi-spin-retention`, `test:gi-seat-churn`, `test:gi-emitter-split`.

---

## §15 — THE SIX-FRONT ARC (2026-08-22): the user's consolidated verdict

User's list (Level, ultra, mid-play, 11 screenshots): **(1)** reflections —
"achieve exact reflections without spending much performance", proposes
SSR + reflection probes, "both planar reflection for mirrors and reflective
materials are shit"; **(2)** "at lower sun intensity, getting blocky
artifacts, a lot"; **(3)** skeletal-proxy bounce gives no colour (proxies
smaller than the voxel grid); **(4)** "distribute probes smarter … higher
density without losing performance"; **(4b)** emissive light still goes
through walls easily; **(5)** "illumination in the room depends a lot on
screen space — as we rotate the camera, lighting changes, though the room and
the sun are static".

**Read the verdicts first ([[gi-spatial-rebuild-verdicts]]): a global density
raise is REFUTED (S1 dense ring: 1,049× waste, 5.71 GB), a placement rewrite
is measured second-order (1.3–1.5×, not 3×), and the SSR+probes+exact
layering the user proposes ALREADY IS the architecture (§0d — SSR was inert
by props, now configured; exact BVH beneath it; probes beneath that; field
last). The gap is the QUALITY of the lower tiers and the world-anchoring of
the field, not the arbiter.**

### The mechanism map

| # | symptom | mechanism | unit |
|---|---------|-----------|------|
| 5 | rotation changes static-room lighting | field is screen-KEYED: probe insertion + ray allocation are visibility-driven, cold probes converge on entry into view; `__giSrcWorldKeys` still OFF by default | U1 |
| 2 | low-sun blockiness | low sun → indirect dominates → lattice/upsample quantization IS the image; exact channel unnamed | U2 first |
| 4b | emissive through walls | gather admits behind-wall probes; LOS validity designed (§14 R5) but unbuilt; thin-slab shared records | U3 |
| 1 | dirty/murky reflections | (a) round-3 build undelivered; (b) probe capture mush + cross-room boxes → phantom walls, green smear; (c) hit-shade field starvation (stopgap floors luminance only) | U4, U5 |
| 4 | probe density | honest levers: LOS validity (probes stop lying = perceived density), LOD bias 1.3–1.5×, world keys enabling both | U3, U6 |
| 3 | colourless proxy bounce | 0.4 m character vs ~1.1 m probe spacing — transport bounce diluted by construction; machinery verified present (movers ARE hit geometry, shaded in colour) | U7 |

### Units, in execution order

**U0 — DELIVER THE PENDING BUILD.** Blocked on play. Reload, orbit the planar
mirror, re-judge. Several photographed artifacts (mirrored-floor patchwork,
camera-dependent smudges) are already fixed in it.

**U4a — DEPTH-AWARE PROBE PARALLAX (kills phantom walls structurally).** The
capture is a TRACE — hit distance t is already computed and thrown away.
Store t in the level-0 tile's alpha (half-float, free channel), and correct
the sample direction by stored depth: u₀ = the current box-projected dir,
W₀ = C + u₀·t(u₀), s ≈ max(dot(W₀−P, R), ε), u₁ = normalize(P + R·s − C),
one iteration (optionally two), sample colour at u₁ on the roughness level.
Miss texels (env) keep pure box projection (encode miss as t ≤ 0). Box stays
as the feather/weight. Phantom walls die because the lookup lands on the
surface the probe actually SAW, not on a box face; cross-room probes stop
relocating partitions. Sampler stays PURE DATAFLOW (select/mix, no If).
Gate: `test:gi-reflection-probes` + a new off-centre-probe assertion (probe
deliberately displaced from room centre; wall reflection must not shear).

**U4a receipts (2026-08-22, first build):** depth stored in level-0 alpha
(capture EMA carries it; blur's verbatim level-0 copy delivers it), sampler
reprojects by it, `__giProbeDepthParallax=false` reverts. MEASURED on the new
PLACEMENT-INVARIANCE arm (probe displaced [1.8, 2.2, 0.9] in the [0,2.2,0]
reference's room): box-projection-only control collapses the displaced
probe's hue split to **0.1801 — the no-probe field baseline, i.e. the probe
adds nothing when its box lies about the walls**; depth parallax holds
**0.2921**. The SECOND iteration sharpened the WELL-FITTED reference
0.5275 → **0.6302** (interior geometry lands where it is) and moved the
displaced probe 0.00 — the displaced residual is CAPTURE CONTENT (coarser
angular resolution on far walls + the sphere's white blob in different
directions), not iteration count; nobody should chase a third. The gate
therefore asserts an ANCHORING FLOOR on the displaced arm (split ≥ 0.24
against the 0.18 collapse), not per-limb parity. TWO
findings from the arm before it even went green:
· **CAPTURE-POINT CLEARANCE IS A PLACEMENT RULE.** The rig's room-centre
  probe sat 5 cm off the metal sphere's crown — HALF that capture was the
  sphere's own surface at point-blank, smeared over the room by projection,
  and the "reference" the invariance arm compared against was the poisoned
  image. U4b auto-placement must pick capture points with clearance from
  geometry, not just room centres.
· **THE CAPTURE PAINTS METALS AS WHITE DIFFUSE.** Hit shading is
  albedo × E / π for every surface; a metal mirror (albedo ~white, no
  diffuse) becomes a bright white-lit blob in the capture, contaminating
  every lookup that grazes it. The resolve's twin formula shares this. Fix
  candidate: carry metalness into the BVH surface data and kill the diffuse
  term by it (a mirror seen by a probe should show ITS reflection source or
  nothing) — priced later, noted now.

**U1 — WORLD-ANCHORED FIELD DEFAULT-ON (the §5 cure).** The flip checklist
already written (NEXT item 2): convert `srcRef.js` mirror + `srcGizmos.js`
to world-absolute keys (mechanical), pixel-diff gate, freezeless gate,
memory-fixed-across-a-walk gate, then flip `__giSrcWorldKeys`.
**✅ THE MECHANICAL CONVERSION SHIPPED 2026-08-22 (evening):** srcRef.js —
`keyCellFor` helper (origin-relative cell → world cell by INTEGER ADDITION
of the origin's own cell index, `worldCellAt`'s composition, identity when
off) at all four pack sites (c0 seed, ladder, merge corner lookup, gather
corner lookup) + `makeProbe` unwraps residues via `keyWorldCell` against
the camera's cell and takes position = cell × s; srcGizmos.js — centre =
`vec3(keyWorldCell(key, cameraPosition, s)).mul(s)` under world keys (JS
branch, flag fixed per compile). The src-ref gate grew CONTRACT-AWARE key
cases (world arm: bijection via pack→keyWorldCell(cell as its own ref);
"every cell representable, LODs still refuse" replaces the refusal case).
GATES: `test:gi-src-ref` ALL PASS on BOTH arms with bit-identical
transport numbers (14.4%→11.1% both) — the conversion is numerically
exact; `test:gi-src-worldkeys` + `test:gi-src-math` (694) green.
**✅ FLIPPED 2026-08-22 (late)** — the three GPU gates shipped as ONE
harness (`test:gi-worldkeys-flip`, three arms: shipped / shipped2 noise
floor / world) and passed; receipts in NEXT item 2 above. ⚠⚠ TWO
INSTRUMENT TRAPS, both burned a full run:
· **arms sharing one browser inherit each other's UI layout** through a
  channel `localStorage.clear()` does NOT close (the third page booted a
  520-px viewport against the first two's 342 px, run after run) — a
  cross-arm pixel diff then measures the LAYOUT (first run: mean 7.42
  "FAIL", entirely canvas framing). ONE BROWSER PER ARM, record each arm's
  canvas size, and abort the arm the moment it mismatches.
· the shared-browser third arm also read live=639 (vs 941) — a phantom
  population deficit that vanished with a clean browser (real: 995).
  Never diagnose population policy from an arm whose canvas differs.
REMAINING in U1: drive the held-pose transient (spin-retention: +6.6%
mean) toward <2% — cold-insert convergence (warm-start inserts from the
parent LOD's value instead of zero — an absence must not be a dark vote),
visibility-strided rays. Instrument: orbit-and-hold rig — same wall crop,
N approach directions, assert cross-direction luminance spread. Plus the
open ~4.7% dim observation (NEXT item 2).

**U3 — LOS GATHER VALIDITY (`__giGatherLosWeight`), build + price.** Design
settled in §14 ROUND 5: march probe→pixel visibility through the occupancy
field, weight the gather by it; supersedes the plane weight (Q9c artifacts)
and kept-weight-fraction (darkens mid-walls). Kills through-wall bounce (4b)
AND behind-wall probes diluting gathers (= sharper response from the SAME
probe count — the honest density multiplier). If per-texel marching prices
high, cache per-probe visibility against the gather cell in the probe record
(invalidate on occupancy stamp).

**✅ U3 BUILT + GATE GREEN 2026-08-22 (late). Gate: `npm run
test:gi-gather-los`.** The march: 4 samples along lifted-P→probe (lift = one
occupancy voxel — hugging-ray false positives excluded by GEOMETRY, no plane
heuristic), each a `freeRadiusAtWorld(maxLevel 0, near-field only)` sharedFn
call against a threshold TIGHT to the voxel (smoothstep 0.15–0.45·voxel),
t stops at 0.85 so a probe is never convicted by its own voxel; suppression
rides the corner WEIGHT, so acc/wsum carry the same factor and an
all-suppressed point renormalizes to the blocked mean (R1 — never a dark
vote). Armed at BOTH gather instances via one closure from srcSystem.
Rig: sealed two-room box, red panel in A, dim white in B, camera visits A
(population!) then measures from B; the discriminator is CHROMATIC (redness
r/(r+g+b) vs the 1/3 neutral baseline — survives exposure drift).
MEASURED (high, canvas-pinned, one browser per arm): leak redness
0.357/0.382 (0.5 m partition) and 0.429/0.474 (0.1 m) → **exactly 0.333 on
every crop with LOS ON — complete removal in BOTH regimes**; legitimate
light held (control ratio 0.89–0.92 = the leaked share leaving the room);
held-pose noise ≤ 0.4%.

FOUR receipts that cost a run each, in order:
· **probe insertion is visibility-driven, so a leak rig must WALK the
  camera through the source room first** — an unvisited room has no probes
  to leak (redness ≡ 1/3 with nothing to suppress). Under U1's locality
  retention the visited room's probes then SURVIVE the move — the gate
  measures exactly the post-U1 shape of symptom 4b.
· **a chromatic discriminator dies under a filmic curve** — agx read
  redness ≡ 1/3 on a red-lit face; the rig runs toneMapping "none".
· **⭐ THE LEAK'S MAIN ARTERY IS THE SECONDARY GATHER, NOT THE SCREEN
  GATHER.** [J] shades ray hits by gathering corners; a validity-blind
  gather there DEPOSITS the wrong room's light into this room's bins, where
  no screen-side weight can reach it (measured: whole-room control redness
  0.36 with the screen instance alone armed, effect ~0). Arming [J] is what
  produced complete removal — including the thin-slab case the
  shared-record caveat predicted LOS could not fix. Any future validity
  term must be threaded to EVERY gather instance.
· **gate on "returns to baseline", not a fixed drop** — Δ ≥ 0.03 scored a
  COMPLETE removal of a 0.025-deep leak as FAIL.
**⭐⭐ U3b DISCOVERED BY THE GATE'S OWN FLAKINESS (2026-08-22, last find of
the night): ON A HEALTHY FIELD THE THROUGH-WALL LEAK RIDES THE CASCADE
LADDER, NOT CORNER SELECTION.** The gate went bimodal across identical
code — five runs removed the leak COMPLETELY (0.333 exactly), then runs
started removing ~nothing (0.398 → 0.387) — and the forensic boots (LOG_GI=1)
correlated it: this rig trips the §12.56 dead-merge race on ~EVERY boot
(3/3, orphaning 22–24%), and the two outcomes split by WHETHER THE
MEASUREMENT LANDED BEFORE OR AFTER THE AUTO-RETRY'S RE-MINT. Pre-heal the
ladder is broken, c0 tiles carry only their own cell's direct deposits, the
leak is purely corner-SELECTION — LOS removes all of it. Post-heal the
ladder works, and c1/c2 PARENT CELLS (0.7–1.4 m) SPAN the 0.5 m partition:
the merge mixes room A's radiance into parents that the B-side c0 bins then
inherit, so the red sits in the B-side probes' OWN TILES and every nearby
corner is poisoned — no gather-side weight can reach payload. The model
fits all eight runs (off-arm depth is ladder-independent because A-side
corners carry red either way ✓; on-arm splits exactly by ladder state ✓).
**U3b — LADDER CROSS-WALL VALIDITY — is therefore the actual 4b endgame:**
weight the cascade merge's parent contributions by occupancy between child
and parent cell centres (the same one-bit march, at MERGE rate — thousands
of bins, not megapixels — so the price argument is even better than the
gather's), or split parents at occupancy boundaries. Start in srcMerge's
parent-lookup (the corner lookup sites keyCellFor touched). The los-gate's
baseline-return criteria are ADVISORY until U3b ships (its hard gates:
never-worse, luminance-never-rises, control, armed receipts). The rig
NOTE: retry-fires-every-boot makes this scene the best §12.56 reproducer
yet (`scripts/.gi-gather-los-high-p0.5`, ARMS=off, LOG_GI=1).

**PRICED, THEN DEFAULT-ON (same night).** The first march used the distance
oracle (`freeRadiusAtWorld` maxLevel-0, near-field 27-voxel scan) and priced
**×18 on the gather** (0.051 → 0.933 ms on the rig — ~18 ms scaled to the
editor's ultra gather; dead on arrival). Replaced by the field's existing
`occupiedAtWorld` ONE-BIT sharedFn (one word fetch per sample — the march
only ever asks "is this sample inside geometry"): gate still ALL PASS with
identical complete removal, price **gather +0.005 ms, chain total +1.7%**.
`gatherLosWeight()` is now `!== false` — DEFAULT-ON, `__giGatherLosWeight =
false` is the escape hatch. Mirror-diff pages are safe by CONSTRUCTION (an
instance built without the `losOccupied` closure cannot arm — the gate page
builds no volume); GPU gates now run LOS-on by default (los-gate's own off
arm sets false explicitly, per the every-flag-explicit rule). ⚠ A near-miss
recorded: `occupiedAtWorld` already EXISTED (line ~3660, built for the
composite) — grep for the primitive before writing it; the module is 5k
lines and has usually already paid for the thing once.

**U2 — NAME THE LOW-SUN CHANNEL BEFORE TOUCHING IT.** Rig: interior room,
sun intensity swept 3 → 0.2, held pose, crops on wall/ceiling; A/B one
channel per arm — emitter-shadow upsample, irr temporal, checkerboard, AO,
gather bilateral eps — and read which OFF arm deletes the blocks. The
screenshots' ceiling rectangles are probe-lattice-period sized: prime
suspect is the gather/bilateral at low contrast (eps floors tuned at normal
light levels), NOT density. Fix follows the name; do not guess.

**U2 receipts (2026-08-22, `probe:gi-lowsun-blocky` built + first ladder).**
The instrument: opens the user's GAME read-only, `scene.open`s Level
explicitly (lastScene follows the user around), VERIFIED pose inside the
west room (the old flat-walls pose now stares at featureless exterior —
three runs measured exactly that; pose must be re-issued until
`camera.position` holds because the scene's async editor-camera restore
stomps a one-shot setCamera), ONE BOOT PER ARM at pinned
`__giConfigOverride={quality:"ultra"}`, multi-scale step energy
(step2/8/16 + blockIndex = step8/step2) per raycast-found flat region.
Sun scaled live (verified exactly ×SUN); pass-scale dials must NOT be
flipped live — a resize-forced rebuild trips the unfocused-page occupancy
re-arm trap (3× washed frames that would masquerade as a treatment
effect). FINDINGS:
· ⚑⚑ **3 of 6 headless boots had DEAD EMITTER DELIVERY** (interior
  ceilings 0.00003 linear under full sun; the §12.56 dead-[J] family, now
  reproducing ~50% headless). This poisons any cross-boot A/B whose arms
  don't sanity-check the boot — and it is a reproducer the §12.56
  auto-retry unit has been waiting for. A dead-boot marker (ceiling mean
  < 0.001) belongs in every arm.
· ⛔ **RETRACTED (same day): the emitter-shadow-resolution effect does
  NOT survive replication.** Pooling every healthy boot at the matched
  region rectangle: lowsun ceiling-911 step8 = {0.0124, 0.0170, 0.0233,
  0.0245} vs emsh1 = {0.0181, 0.0208} — the "25% improvement" sits inside
  the healthy boot-to-boot spread (2×!). The initial "confirmed across
  two pairs" was two chance pairings, written down before the spread was
  known. **METHOD RULE: at this scene's boot variance, a cross-boot A/B
  needs N≥4 boots per arm with medians+spread, or a within-boot dial —
  never a single pair.** The block source is UNNAMED again; refuted so
  far: tile-cut seams, emitter-shadow resolution. Candidates standing:
  the gather/bilateral, the irr temporal, probe-lattice structure. All
  dead-batch readings (shadow1/aooff/srcoff bit-identical arms) are
  DISCARDED, not evidence.
· Watchdog validation detail: the compound signature fired ONCE on the
  dead boot (line captured in-probe) and did not re-fire on the
  converging post-heal field — calibration holds. ⚠ One boot showed the
  probe's "dead" marker healing WITHOUT any watchdog line — the marker
  (ceiling < 0.001 at settle+9 s) can catch slow convergence, so treat a
  probe "dead" without a captured watchdog line as unconfirmed.
· ⚠⚠ **THE HONEST LEDGER AFTER THE DEAD-STATE SNAPSHOT RUN (late
  2026-08-22).** Three corrections, each earned by a better instrument:
  (1) **most "dead boots" were SLOW CONVERGENCE, not wedges** — under GPU
  contention (user's live editor + headless Chrome sharing the 4070, FPS
  2–18 measured) a fixed 9 s settle reads tiles mid-convergence; both
  "heals" in the snapshot run happened with NO watchdog line = natural
  convergence mislabeled. Confirmed genuine wedge count for the day: ONE
  (the captured `orphaning 20% … minLum 0.0037` fire). The "5 dead, 5
  healed" claim above OVERCOUNTS — the retry is correctly built and
  caught the one true wedge, but the reproducer rate is unknown, not 50%.
  (2) **at detection time the true dead state is BLACK BINS with a
  HEALTHY merge** (orphanRate 0.0055, population normal, deposits
  landing) — the 20% orphanRate develops LATER; tile luminance
  (meanLum ≪ 0.1, minLum 0) is the primary symptom, orphanRate the
  trailing one. The watchdog signature should eventually key on tiles,
  after the convergence confound is removed.
  (3) **the late runs are CONTAMINATED by live editing** — the user was
  working in the Level while the probe read its autosaves (ceilings
  0.318 vs 0.07–0.16, region ids shifted). INSTRUMENT REQUIREMENTS for
  round 3, all three mandatory: a FROZEN copy of the scene (snapshot
  project dir, never the live one), CONVERGENCE POLLING before
  classifying anything (two reads within 3%, the refl-gate idiom — never
  a fixed settle), and an idle GPU (don't measure while the user's
  editor is rendering).
· Dead boots are DETERMINISTIC (two dead boots measured bit-identical
  stats); rate over the day: 5 of 10.
· ⭐ **THE DEAD PASS IS NAMED: the cascade MERGE.** readStats diff, dead
  vs healthy boot (same scene, same pose, same arm): `merge.orphanRate`
  **0.200 vs 0.010** (20×), `tiles.meanLum` 0.28 vs 0.48, `tiles.minLum`
  0.0002 vs 0.014 — the bins the tiles read carry no merged radiance, so
  emitter-bounce-lit surfaces (interior ceilings) go black while sun-lit
  surfaces look normal. `rays.secondaryHits` is NONZERO in the dead boot,
  so the dead-[J] watchdog signature never fires for this state. This
  also re-convicts the long-open `smoke:gi-gpu ?src=1` failure ("39% of
  known bins found no parent") as the SAME bug wedged deterministically —
  it was mis-filed as "the arm's own assert is stale".
· **§12.56 AUTO-RETRY BUILT (2026-08-22):** the post-wave watchdog now
  detects BOTH signatures (dead [J]: shaded>1000 ∧ secondaryHits=0; dead
  merge: bins>5000 ∧ orphanRate>0.12 ∧ **tiles.minLum<0.005**) and calls
  `requestRebuild()` — the recovery the 08-21 live incident proved —
  bounded at 2 consecutive attempts, budget reset on a healthy readback,
  hard error with reload advice at exhaustion. **VALIDATED: 5 dead boots
  across two probe batches, 5 healed** (one batch rolled dead 4/4 — the
  rate is worse than the first 50% estimate). The minLum term is
  calibration, not decoration: a field still CONVERGING minutes after a
  re-mint reads orphanRate 0.08–0.15 (minLum ≥0.008) and an
  orphanRate-only threshold would spend the second retry on it; DEAD
  reads 0.200 with minLum 0.0002. ROOT CAUSE still open: what makes the
  merge/ladder pipeline invalid on a coin-flip at boot — hunt with the
  reproducer (`probe:gi-lowsun-blocky` ARMS=lowsun×N), prime suspects
  world-keys / locality-retirement (08-17) or the static-merge commit,
  per the smoke's original candidates.
· ⛔ **TILE-CUT SEAMS REFUTED as the block source (2026-08-22).** The
  §12.70 top-4-per-tile grid matches the block period, so `nocut`
  (`__giEmitterTileCut=false` + `__giSrcLightTree=false`) was the obvious
  suspect — measured on matched healed pairs: ceiling step8 0.0124 vs
  0.0125, floor 0.278 vs 0.280, wall 0.154 vs 0.156 — identical within
  noise (`shadowRays` 29k→38k proves the arm was live). The coarse
  structure is INSIDE the emitter-shadow estimate (its content, not the
  per-tile emitter selection); resolution helps (~25%), so next arms
  target the estimator: `__giShadowTemporal=false`, the penumbra
  width/blur chain (Q7 family), and the gather bilateral.

**U4b — AUTO PER-ROOM REFLECTION PROBES (graduated to REQUIRED in §0d).**
One probe per level-design room (the module knows the rooms); fallback for
imported scenes: flood-fill the occupancy grid's empty space into boxes.
Hand-placed probes remain overrides. With U4a shipped, box fit matters less
— placement becomes coverage, not geometry.

**U7 — NEAR-FIELD MOVER SPLAT (#3, "character tints the wall").** Don't wait
for transport dilution: splat each proxy's albedo × (sun + emitter direct at
the proxy) into probes whose cells the proxy overlaps (weight ∝ solid angle,
capped, energy-conserving), through the same words-34..39 surface the
mover-hit path reads. Rig: saturated-red character 0.3 m from a white sunlit
wall; wall-crop chroma must move under `__giMoverSplat` A/B and STAY when
the character leaves (no ghost tint — the temporal clip family applies).

**U5 — R-C PROPER (endgame for reflection dirt):** seed SRC probes at
reflection HIT points (the prepass already emits them per pixel) so the
field exists behind the camera where mirrors look; hit shading inherits
converged NEE-shadowed radiance; the luminance-floor stopgap retires.

**U6 — GRADIENT-DRIVEN LOD BIAS (the measured honest densifier).** 78% of
live c0 probes sit below 5% of the scene's p99 luminance — demote dim/
redundant, spend slots on bright-gradient regions. AFTER U1 (world keys make
the bias stable under motion). Expect 1.3–1.5×, sell it as such.

---

## §14 — THE QUALITY ARC (2026-08-20): ten symptoms, seven mechanisms

User report (with screenshots, on GAME/Level, `high`, 4070): (1) muddy emissive
shadows, (2) emissive light leaking through walls, (3) bright outlines when the
camera moves, (4) blocky checkerboard light patterns when moving — worse far
away, (5) capsule proxies have holes and self-shadow the character, (6) mobile
is much muddier and blockier ("slower is OK, muddier is not"), (7) larger
scenes look worse, (8) realism, (9) perf headroom, (10) emissives cut off
sharply — "smooth gradients, no dither, no mud, no ghosting."

Four full code maps (emitter shadow channel, falloff/cutoffs,
temporal/checkerboard, skinned proxies) collapse those ten into SEVEN
mechanisms. Symptom → mechanism:

| # | symptom | mechanism |
|---|---|---|
| 1, 6 | mud | **M1** — the emitter raw is ONE BINARY point sample per texel (`GISystem.js` `#buildEmitterRecordTrace`, `select(hit,0,1)`), no jitter, no temporal integration; all softness is a screen-space blur of that mask at 0.11–0.28 linear resolution (three multiplied scales), rgba8, then an UNVALIDATED bilinear up to resolve res |
| 4, 6 | checkerboard | **M2** — §12.80.2's checkerboard shadow trace fills the untraced half with LAST FRAME'S TEXEL AT THE SAME COORD (giScreen "skipping the store IS the fill"), and the temporal filter that was supposed to integrate the phases DOES NOT EXIST on the default analytic arm (`history: null`); the spatial filter's voxel-scale world eps rejects every neighbour at distance (passthrough), the wide passes gate out at `rMax<0.75 ∝ 1/viewDist`, and the 4-tap material bilateral magnifies the surviving pattern to ≥4×4 canvas px |
| 3 | bright outlines | **M3** — the irradiance temporal 3×3 silhouette rescue accepts any neighbour by POSITION ONLY (eps = occupancy voxMax) and blends it at weight 0.9; the 08-19 variance clip cannot catch it because its σ is computed over an UNVALIDATED 3×3 that is widest exactly at silhouettes |
| 2, 10 | leaks + sharp cutoff | **M4** — trace admission `emitterLum > traceCut` is HARD while the contribution fade runs [cutD/3, cutD] BELOW it: the whole visible band [cutD/3, cutD] is delivered UNSHADOWED (= pours through walls, dim but visible in dark rooms) and the fade is C1-not-C2 with tier cutoffs 4–8× the historical reach value (high 0.006) — a Mach band over a 1.73× distance ring. `dist<shadowRange` has the same hard shape. Fix exists opt-in (`__giEmitterShadowGateFade`) but its header argues from 0.0015, not the shipped 0.012/0.006 |
| 5 | capsule holes + self-shadow | **M5** — self-exclusion in `dynamicObjects.js:1308` is OBB-ONLY (`type<1.5`; capsule=4 can never be excluded) AND both static-BVH shadow arms pass `{}` so no exclude point even arrives; holes = no joint bridging (each capsule rigid to ONE bone; wedge notch opens on the outside of every bend) + the axial 0.99 quantile shortens every capsule at both ends |
| 4 (blocks), 10 | emitter banding | **M6** — tile-cut weights `w[0..3]` + `comp` are read NEAREST at the emitter buffer's resolution (~2–4 resolve px per tile): piecewise-constant blocks that sweep across surfaces as the camera moves |
| 6, 7 | mobile & scale | **M7** — every temporal error above scales with PER-FRAME CAMERA DISPLACEMENT (∝1/fps): mobile at 30fps eats 2–4× the stale-texel error and far more rescue invocations; high-DPR buffers bind the 1.6M/1.9M pixel budgets so every texel covers more canvas px; and `validEps`/filter eps track the occupancy VOXEL, which grows with volume extent — the same halos and leaks get physically wider as scenes grow |

Realism (8) and perf (9) ride the same fixes: the emitter march is the measured
GI pole (3.4 ms of 8.3 on Level at high — 41%), `ao:false` at every tier and
`__giGatherNormalWeight` off are the two priced-but-parked contrast levers.

### Units (Q1–Q9), in leverage order

- **Q1 — the prevVP writer (prereq for everything temporal on the emitter arm).**
  `_giShadowPrevVPU` — bound by the emitter temporal chain — has its ONLY
  writer inside `if (state.screen?.lightShadowPass && this._giShadowFrameU)`
  (GISystem.js:2041), and `_giShadowFrameU` exists only on the NON-default
  stochastic light arm. On the default build the emitter history reprojects
  through an IDENTITY matrix forever and its weight is never motion-adapted.
  **This is why the §12.80.2-era emitter-temporal rig read "bistable": the
  chain under test was structurally inert.** Fix: one VP-store maintenance
  point (copy to irr + emitter consumers, then ONE store update), emitter
  weight adaptation moved outside the gate. DONE 2026-08-20.
- **Q2 — capsule self-shadow + holes.** (a) Generalize the self-exclusion to a
  SIGNED per-type distance (reuse the penumbra block's own `dCapsule`/`dSphere`
  12 lines below; exclude when `d·scale < slack`, slack ∝ radius — the true
  skin sits INSIDE the proxy shell, so the test must be signed, not `|d|`);
  (b) pass `excludePoint` at the two static-BVH call sites (GISystem.js:3749,
  :4013 — today `{}`, so even the OBB exclusion is dead on the default arm);
  (c) joint-bridging sphere proxies at every kept parent–child joint (a
  capsule with aspect 0 at the child bone's origin, r = max of the two —
  origin is rigid to the joint, so it needs no interpolated matrix);
  (d) axial quantile 0.99 → 1.0 (radius keeps 0.99 — outlier protection
  matters radially, not axially). Gates: `test:gi-skinned-proxy`,
  `test:gi-proxy-fit`. DONE 2026-08-20.
- **Q3 — checkerboard under motion.** The untraced half must never show a
  stale world: under camera motion each traced thread ALSO writes its result
  to its stale-parity row neighbour (smear fill: half-res-for-a-frame instead
  of wrong-for-a-frame; zero extra rays), driven by a camera-motion uniform.
  Plus the flagged hazard: the parity uniform gets `.setGroup(renderGroup)`
  like its sibling. Gate: `probe:gi-shadow-viewdist` unchanged + live pan A/B.
  DONE 2026-08-20.
- **Q4 — emitter falloff made C2 and shadow-complete.** Contribution fade
  moves ABOVE the admission threshold: `smootherstep(traceCut, 3·traceCut,
  lum)` — zero exactly where tracing ends, so no visible photon is ever
  UNSHADOWED (this is the wall-leak fix) and the outer edge is C2 (no Mach
  band). The luma half of `__giEmitterShadowGateFade` becomes unnecessary
  (contribution is 0 at the admission boundary); the RANGE ramp
  (0.85–1.0·shadowRange) flips DEFAULT ON. Tier cutoffs halve (low 0.02→0.012,
  medium 0.012→0.006, high 0.006→0.003, ultra 0.002→0.0015) to keep reach ≈
  today's zero-point — priced live: emitterShadowPass before/after on Level.
  DONE 2026-08-20 (pricing recorded below).
- **Q5 — silhouette rescue + variance clip get geometry-validated.** Rescue
  acceptance adds a normal-agreement test (`dot(Nn,N) > 0.7`); the clip's
  3×3 moments weight each tap by the same plane/normal validation so σ stops
  exploding at silhouettes (M3). Gate: live pan capture; `__giIrrHistWeight=0`
  is the 1-frame A/B that names the pass.
- **Q6 — distance-robust filter eps.** The bilateral's plane eps switches from
  the flat occupancy voxMax to `max(voxMax, k·viewDist·texelAngle)` so the
  filter keeps its neighbourhood at distance instead of degenerating to a
  passthrough (M2's far-field half, and most of "worse far away").
- **Q7 — emitter area sampling + temporal ON (the mud killer).** With Q1
  fixed: jitter the emitter target point over the source disc per frame
  (IGN × reff, perpendicular to the ray), flip `__giEmitterTemporal` default
  ON so the EMA converges the stochastic coverage to true area visibility —
  penumbra from PHYSICS instead of from blurring a binary mask. DONE
  2026-08-20: `emitterSlotShadow` takes a `targetJitter` (only the RAY moves —
  cosθ/graze/k/luma admission stay on the centre so energy and gating are
  jitter-free), `createGiEmitterShadowPass` grows a `frame` uniform, the
  phase pins to 0 with `__giShadowTemporal = false` exactly like the light
  arm. Hatches: `__giEmitterTemporal = false` (chain), `__giEmitterAreaSample
  = false` (jitter alone). `test:gi-shadowed-bulb` default arm 0.6475 vs
  0.6482 pre-change (delivery unchanged); the OFF-arms read +12% — the
  jittered rays legitimately see past the shade's edge (area-light physics).
  STILL TO DO from this unit: decorrelate wide₂'s IGN bearings from wide₁
  (they sample the SAME 16 spokes, so the claimed 256-effective-samples never
  happened), and re-lower the 0.85 skinned emitter-buffer floor once the
  self-shadow fix + accumulation prove out (it was mitigating M5+M1 — worth
  ~2× the emitter-buffer pixels).
- **Q7b — moving-occluder ghosting (found live BY THE USER minutes after Q7
  landed: "the character is emitting smoke while running").** Position
  validation cannot see that an OCCLUDER moved — the floor a character runs
  across reprojects perfectly, so its history (the shadow of ten frames ago)
  blended at ~0.9. FIX (same mechanism as Q5): the shadow filter's temporal
  block clamps history to mean ± 1.5σ of the plane-validated spatial taps it
  already reads — where the shadow has left, σ→0 and the trail clips away in
  a frame; at a real static edge σ is wide and accumulation is untouched.
  `__giShadowTemporalClip` retunes γ (≤0 disables). Applies to the light
  arm's stochastic path too (moving crates). DONE 2026-08-20.
- **Q8 — tile-cut weight bilinear (M6).** Interpolate each kept emitter's
  weight across the 4 surrounding tiles BY ID (0 where absent), keep `comp`
  NEAREST (the §12.70 warning about interpolating compensation stands).
- **Q9 — the standing arcs, priced not guessed:** §12.56 auto-retry (this very
  session booted into the dead-[J] race — top reliability item); AO
  compile-cost diet then `ao` per-tier enable (realism); emitter-march diet +
  pool shrink-on-slack (perf); mobile preset = Q3+Q5+Q6 first (they scale
  1/fps), THEN resolution. **Gather normal weight: ARMED at k=1 (the soft
  half) 2026-08-20** through one shared reader (`gatherNormalWeightExp`,
  srcMath.js) so the CPU mirror agrees; `__giGatherNormalWeight = false`
  restores position-only, `true` = the full k=2. This is the thin-wall
  bounce-leak lever (63/90 Level meshes sub-2-cell; the red wall bleeding
  into the dark bedroom). `test:gi-src-gather` + `test:gi-src-ref` green on
  the armed default — the src-ref "coarsening leaks BRIGHT" arm now pins the
  hatch off for the direction claim (that direction IS the position-only
  leak) and bounds the armed default separately.

### ROUND 2 — same evening, user in the loop (2026-08-20)

The user's first look verdict: "blockiness almost resolved" (Q3+Q6 worked),
but grid-like dots appeared on most surfaces, the emitter shadows grew a
speckle aura around the moving character, and the capsule shadow still had
holes. Three corrections, all landed and verified live:

1. **The grid dots were the k=1 wrap weight (Q9b).** The DDGI
   `(n·d)·0.5+0.5` form modulates FRONT probes too, and on a flat wall that
   modulation beats at the LATTICE period. The weight is now ONE-SIDED
   (`smoothstep(-0.35, 0, n·d)`, GPU + CPU mirror through the same shared
   reader): every front probe keeps weight exactly 1 — a flat wall's gather
   is pure trilinear again — while behind-the-plane probes still fade to the
   1e-3 floor. The leak fix was always about the behind probes.
2. **The speckle aura parked the area sample.** `__giEmitterAreaSample` is
   OPT-IN again: around a moving occluder the Q7b clip + motion weight
   correctly refuse history, so the raw binary jitter reached the screen
   with only the despeckle behind it. The temporal CHAIN stays default-on.
   The jitter needs its own instrument (pose-held convergence + a
   moving-occluder noise floor) before it ships on. Also shipped alongside:
   wide₂ now carries `rotSalt: 1.2` so the chained wide passes finally
   sample DIFFERENT bearings (build + resize-splice sites).
3. **⭐ THE FIT LEDGER FOUND THE SHADOW HOLES IN ONE BOOT.** New always-on
   `[gi] skinned fit ledger` + `absorbs` lines (skinnedProxy.js,
   `__giSkinnedProxyLog = false` silences): the user's rig has 14 fleshed
   bones against budget 12, the two lowest-volume bones were BOTH SHINS,
   and their absorb into the thighs was (correctly) refused by the growth
   guard — so the character's lower legs cast nothing at all. A refused
   absorb now PROMOTES the bone to its own capsule (bounded at 2× budget;
   the mover-cap widening already counts it). Live: `LowerLeg_L/R PROMOTED`,
   27 proxies = 14 capsules + 13 bridges — the leg chain is continuous.
   Also fixed while in there: a FOREIGN skin's flesh (glTF duplicate chain)
   now joins the fit via bone-NAME mapping onto the rep skeleton — it used
   to be excluded entirely (map trap #6), i.e. any body part living on the
   second skin shaped no capsule.

### ROUND 3 — the shadow that was never ours (2026-08-20, late)

Grid gone after Q9c (the one-sided weight moved from the direction COSINE to
the SIGNED PLANE DISTANCE — the cosine still varied with the pixel's lateral
offset to each behind-probe, which beat at the lattice period as soft squares;
plane distance is invariant under in-plane motion, so a flat wall's corner
weights are constants and the pattern is impossible by construction. Gates
mirror-green).

**⭐⭐ THEN THE CAPSULE-HOLE THREAD DISSOLVED: the character's wall shadow was
a SHADOW MAP, not GI.** The user's Sun had `shadowMode: "map"` in the saved
scene (this session's early boots logged gi-traced; later boots logged "no
light uses Shadow Source gi" — the §12.80 forget-bug family, then autosaved).
The tell was IN the screenshot the whole time: the shadow's head had the
STEPPED VOXEL CROWN — a capsule cannot cast steps; that is the exact mesh.
The "holes" line up with the REAL air gaps between the model's separate voxel
boxes (armpit/waist), which the light's angle sees and the camera doesn't.
Every capsule change was invisible to that image. Sun set back to "gi" via
the component (undoable, scene left dirty for the user to save).

**⚠ METHOD RULE, paid for twice tonight: BEFORE debugging a shadow, name the
CHANNEL that casts it.** A stepped/detailed silhouette = exact geometry
(shadow map or BVH); smooth blobs = capsules; check the boot log's
"Shadow Source" claims first. Also earned: the fit ledger grew vertex
accounting (`verts N/M assigned` + bad-index/unmappable counts) and the
exact-cover rule (quantile trims only engage ≥400 owned verts — on a low-poly
voxel character every vertex is structure, and the trims were trimming the
body itself). The Chainer fit is proven tight: 744/744 assigned, radii
unchanged under exact cover.

Still open from the user's last look: the far-room emitter shadow mud (the
Q7 instrumented area-sample arc is the fix; the far room is also simply few
emitter-buffer texels — resolution floor by distance is a candidate), and a
faint different-shade border along wall edges (attribute FIRST:
`__giGatherNormalWeight = false` + reload names or clears the gather weight
in one boot).

### ROUND 4 — the box, not the capsule (2026-08-20, night)

User's verdict on gi-mode capsule shadows: still holes, PLUS self-shadow on
the character's own back, PLUS a bright outline in bright light, PLUS
emissive light reaching the second floor. Landed:

1. **⭐ PER-BONE FLESH BOXES (OBB) are the default proxy shape**
   (`skinnedBoxShape`/`skinnedBoneMatrix`; `__giSkinnedProxyShape =
   "capsule"` reverts). The capsule was the wrong SHAPE for this content,
   and both remaining defects were the same wrongness: a capsule INSCRIBES a
   boxy character's flesh, so (a) the skin sits centimetres OUTSIDE the
   shell where the signed self-exclusion cannot claim it — rays graze back
   into the proxy = the dark blotch on the character's own back; (b) round
   shells leave lit slits between arm and torso that the real boxes don't
   have = the shadow holes. The fit already computed the per-axis flesh box
   (mid/ext); it now ships as the OBB with `center` in shape.center (the
   dyn-set sync composes `M × translate(center)` — the classify convention),
   halfExtents in bone-local units, matrix = the bare live bone matrix.
   Skin lies ON the box surface, where the |d|<3cm OBB exclusion catches it.
   `growBox` (asymmetric, quarter-of-max-extent bound) makes the absorb
   verdict; bridges stay spheres. Gates green.
2. **The gather normal weight is OPT-IN again** — third artifact in one
   evening (bright corner/edge bands: suppressing dark behind-probes and
   RENORMALIZING redistributes their share onto bright front probes, so
   corners brighten where reality darkens). The plane-distance formula stays
   (finally geometry-sound); what's missing is the energy story — a
   suppressed probe should DARKEN like occlusion (scale by kept-weight
   fraction), not redistribute. Needs its own pricing rig before any
   default. The thin-wall bleed complaint therefore REMAINS OPEN, wired to
   that unit.
3. **Floor-1 emissive lighting floor 2 — named, not patched:** the 0.25 m
   slabs vs 0.22 m cells put both slab faces in ONE surface record (the
   boot's own 63/90 warning) — the bright downstairs-ceiling cell IS the
   upstairs floor's record. The honest fixes: per-face (two-sided) surface
   records, or finer cells. Emitter DIRECT doesn't reach there (cosine
   horizon + the Q4 shadow-complete fade); this is the field.
4. **Bright mesh outline in bright light — open, A/B named:**
   `__giIrrHistWeight = 0` live in devtools while moving; outline gone =
   irradiance temporal (strengthen Q5), outline stays = upsample fringe
   (material bilateral's no-valid-tap path).

### ROUND 5 — the shadow was never ours, part two (2026-08-21)

User's verdict on round 4: holes still there, emissive leak still there,
bright outline still there. All three got named mechanisms this round; two
got fixes, one got its design.

1. **⭐⭐ THE "HOLES" ARE A BIND-POSE GHOST, not a proxy defect.** The user's
   screenshot was the tell round 3's method rule asked for: the shadow has
   SPREAD ARMS while the live character's arms are down, and its edges are
   voxel-stepped — that is the character's BIND-POSE triangles in a STATIC
   channel, not any proxy. Mechanism: `#occupancyContentOf`'s skip
   (`isSkinnedMesh && #skinnedGroupOf`) only fires when the fit ALREADY
   exists — a rig that hydrates after the field build (async GLB, the
   `.geom` skinnedmesh component attaching late; the boot log shows the fit
   ledgers printing ~80s AFTER the field logs) was voxelized in T-pose and
   its triangles packed into the static shadow BVH. The proxies cast
   correctly alongside it; every proxy improvement was invisible against the
   stamped ghost. The "holes" are the voxel model's REAL air gaps plus the
   bind pose's arm positions. FIX: **bind-pose ghost eviction** in
   `#refreshSkinnedProxies` — once per (groups, field) identity, any
   placement whose mesh belongs to a fitted group gets the exact-dynamic
   adoption treatment (`_giAnalytic`, voxel-slot park, `setStaticMaskBit`,
   atlas clear) with a console warn naming it. Also: the mover cap is sized
   from `proxySlots` at BUILD time, so a late rig can find the set full —
   the refresh now requests ONE field rebuild per field to re-size the
   header (guarded against thrash; the existing `_warnedSkinnedCap` warning
   stays).
   ⚠ SCENE WART FOUND: the Player's "Body" entity carries BOTH a `model`
   component (CH.glb) and a `skinnedmesh` component (Chainer.geom) — two
   overlapping skinned characters (the two fit ledgers: 344 and 744 verts),
   double proxies, double ghosts. Engine handles it; the user may want to
   drop one.
2. **Bright outline NAMED BY THE USER'S OWN A/B: gi shadow mode only, map
   mode clean** — so it is the half-res light-shadow chain, not the irr
   temporal. Mechanism: the position-validated bilateral upsample validated
   taps by EUCLIDEAN distance with a threshold of 2% of view distance (~8
   half-res texels of world footprint — needed at that size to keep GRAZED
   floors valid, since neighbouring texels on a grazed plane are far apart
   in world). 8 texels of slack across a SILHOUETTE admits the other
   surface's traced value: a sunlit background blends into the mesh rim =
   the bright outline, growing with distance because the slack does. FIX:
   validity gains a PLANE test (|N·rel| < 1.5 texels' world footprint,
   floored 2cm) — plane distance is grazing-invariant (the Q6/Q9c lesson),
   so silhouettes reject at texel scale while grazing floors keep every
   tap. The PCSS disc's flat +15cm plane slack rides the same texel
   footprint now (`planeEpsU·2`). Fail-dark policy unchanged.
3. **Thin walls (user: "we need to handle thin walls better") — the design
   is LINE-OF-SIGHT PROBE VALIDITY, not per-face records.** Two findings
   narrowed it: (a) `srcShade` face-forwards hit normals, so hit shading is
   already two-sided-correct; the record's shared albedo/colour is a
   SECONDARY defect. (b) The primary leak is the GATHER: a floor-2 receiver
   trilinearly blends probes that sit BELOW the slab (§13.7d's own comment
   names the awning case). The plane-distance weight (Q9c, opt-in) was a
   crude proxy for the real question — CAN THIS RECEIVER SEE THIS PROBE.
   Marching the receiver→probe segment through the OCCUPANCY FIELD answers
   it exactly: suppression equals real occlusion, so the renormalization
   stays an honest estimator (interpolating over visible probes) and the
   round-4 corner-brightening cannot happen — the suppressed probes are
   exactly the ones a real corner occludes. Segment ≤ spacing·√3 ≈ 3-6
   level-0 DDA steps × 8 corners per shell. Cost to price on the gather
   pass; CPU mirror in srcRef must step IDENTICALLY (test:gi-src-gather).
   Hatch `__giGatherLosWeight`, default OFF until the pricing rig and a
   live look pass. Supersedes the "AO-like kept-weight-fraction" idea —
   that darkened flat mid-walls by the behind-probe share, which is not an
   occlusion effect.

### ROUND 6 — grow the box to its joints (2026-08-21, morning)

User verdict on the emitter shadow (with two screenshots): "the proxies
follow the skeleton exactly, but they are not scaled properly, leaving
holes in the silhouette" — a fragmented LADDER of separate blocks.
Mechanism: the round-4 flesh box is the EXACT vertex-span AABB, so it
faithfully reproduces the voxel model's real air gaps at every joint
(round 3's finding) — and unlike the capsule it has no end-cap overshoot
to bridge them (a capsule reaches halfSeg+r past the span at each end; the
box stops at the last vertex). Landed:

1. **Joint growth**: each flesh box grows to contain its OWN joint (bone
   origin) and every DIRECT CHILD joint (positions through the same
   `boneInverses` bind transforms the vertices used), so neighbouring
   boxes MEET at the shared joint by construction. Bounded (a child
   farther than ~3× the box's extent is a mount, not anatomy). The box
   gets its OWN `boxCenter` — growth shifts it on nearly every bone, and
   the `__giSkinnedProxyShape="capsule"` hatch must keep the pure flesh
   mid. `growBox` (absorbs) now operates on `boxCenter` too.
2. **The OBB self-exclusion went SIGNED** (`de·scale < 0.03`, on-or-inside
   — was `|de|·scale < 0.03`, a surface band): grown boxes contain skin
   INSIDE them, where the |d| band re-admitted the box as its own
   occluder. Classified exact OBB adoptees are unchanged (receivers sit ON
   their surface, where the two tests agree).
3. **The proxy log prints WORLD box dims** for box-shipped segments
   (`box=WxHxDm`) — the ladder was diagnosed blind because the log printed
   only capsule params while boxes traced. Live Chainer: thigh
   0.12×0.22×0.12 meets shin 0.12×0.24×0.12 at the knee, shin meets foot
   at the ankle; mover cap sized 51 = high 24 + 27 proxies.
4. Gate: `test:gi-skinned-proxy` gained per-box joint-containment
   assertions — 51 checks green (was 40).

### Instrument notes (2026-08-20)
- ⚠ `smoke:gi-gpu` is BROKEN since `88bd34b` (2026-08-18): the engine's limits
  ask went to `maxStorageBuffersPerShaderStage: 16` (sceneSettings.js:385)
  and the smoke asserts a portable-8 device. Not caused by §14; fix the smoke
  (request 8 in its harness or assert ≤16) before trusting any red from it.
- The GI gates need `npx vite --port 5201 --strictPort` running.
- Boot latency observed twice live: the occupancy chain arms only while
  frames tick, so an UNFOCUSED editor sits at boot-ambient (washed-out,
  no field) indefinitely — "2 minutes to first field" was really "the window
  was in the background". Diagnose focus before diagnosing the chain.

⚠ Instrument rules that carried over: hold-the-pose-and-sample-twice for any
temporal claim; a probe that hides the lamp behind a shade for any delivery
claim; quote GI pass ms, never harness fps; `camera:"game"` for play-mode
screenshots.

---

## §13.7h — SPARSE-EMITTER SPLITTING (shipped 2026-08-17)

**One glTF mesh is not one light.** A glTF splits by MATERIAL, so a whole run of
party bulbs, every downlight in a ceiling, or every window pane on a facade
arrives as a single mesh — and `emitterFromMesh` fitted ONE shape to it. Live
ledger before: `P=1.8e+1 area=3.8e-2m² fill=0.000 rgb=0.0/0.0/0.0 r=12.03m`.

`collectEmitters` now refits a sparse mesh as **one emitter per connected
piece**. Connectivity, not a spatial grid: the pieces are already named by the
geometry (a bulb is a closed shell sharing no vertex with the next), and any
grid cell size splits a single long neon tube — which must stay ONE light —
while merging bulbs that happen to sit close. Vertices are welded by exact
position first, so a de-indexed or merged mesh does not read as one piece per
triangle. Result is cached on the geometry in LOCAL index space, because
`#refreshLightTree` re-runs `collectEmitters` whenever a lamp moves.

**Two things are easy to get wrong here and both were, first time:**

1. **Fill is nearly scale-invariant under merging.** Cut a 2-D scatter of N
   pieces into k groups and each holds N/k pieces across an extent ~E/√k, so its
   cross-section falls by the same k and the fill does not move. So the per-mesh
   cap's acceptance test cannot be a fill test — measured, 80 bulbs into 16
   groups gives meanFill 0.017 against the whole string's 0.022, and a fill-only
   rule REFUSES every capped split. The second criterion is PLACEMENT (mean
   fitted radius halved), which is the other half of the original bug anyway:
   every receiver stood INSIDE a 12 m sphere where the irradiance model has no
   meaning, and no radiance could have fixed that.
2. **Morton chunking is not good enough, and per-axis normalization is worse.**
   Normalizing each axis to its own range makes a 1.5 m step in Y compare equal
   to an 11.9 m step in X, so Morton sorts by the SHORT axes and every group
   spans the whole mesh (worst group radius 2.34 m against 2.86 m unsplit — the
   cap achieved nothing). Isotropic quantization fixed half of it (1.57 m); the
   rest was Morton's own boundary jumps. **Repeated median splits of the widest
   group** give 0.97 m and need no reasoning about curve order.

Refused when neither criterion wins — co-located duplicate pieces would
otherwise become N copies of the same wrong shape at N times the tile-cut cost.
Solid meshes (every lamp anyone has already authored) pass through
**bit-identical**; that is asserted, not assumed. Power and area are conserved
exactly across a split — this is a change of MODEL, not of content.

Hatches: `__giEmitterSplit = false`, `__giEmitterSplitBudget` (default 256 added
scene-wide; emitter count is a per-frame cost in the §12.70 tile cut).

⚠ `(meshId, instanceId)` in a packed record **is no longer an emitter identity** —
every piece of a split mesh carries the same pair.

---

## ⚑ SESSION RESULTS 2026-08-17 (read this first — two sections below are overturned)

**Shipped:** the Phase-E gate (`test:gi-shadowed-bulb`), B1, B2, B3, and S1's
core swap behind `__giSrcWorldKeys` with its property gate
(`test:gi-src-worldkeys`). Build green; `test:gi-src-math` (the TSL/mirror twin),
`test:gi-src-ref`, `test:gi-lighttree` all pass.

### ⛔ PART 1 PHASE E IS REFUTED. Do not spend another session on it.

E0 ran on the rig E4 asked for — one r=0.05 m bulb at authored strength 2000,
**hidden behind a shade so every measured pixel is delivered light**, wall patch
0.5 m away, no sun, no environment. That last property is why no existing rig
could see this: in the storm / NEE / emitter-scale rooms the lamps are IN FRAME,
and a lamp's own raster-emissive pixels are bright with the entire transport
severed. A centre-crop luminance statistic passes on a dead transport there.

| arm (95 tree emitters, measured bulb UN-SEATED) | lit | dark | delta | snr |
|---|---|---|---|---|
| tree + tile cut armed (**the default**) | 0.77852 | 0.66039 | **1.18e-1** | 385 |
| both hatches off (field emission) | 0.84786 | 0.84541 | 2.45e-3 | 22.6 |

**The armed path delivers 48× MORE than field emission, not zero.** Verified at
1 emitter (seated, delta 6.5e-1) and at 95 (un-seated, above) — i.e. at the
user's own emitter count, with the measured bulb proved un-seated by the seat
score (decoys out-rank it 2.4×). R5-zeroing-over-dead-delivery does not
reproduce; the tree/tile-cut path is what makes a small hidden emitter visible
at all, and the *field* path is the weak one.

So E1/E2/E3/E5/E6 are not chasing the reported symptom. If "emitters deliver
zero" is still visible in the user's scene, it is **scene-specific** and the next
step is to run this rig's method (hide the emitter, measure delivered light) on
that scene rather than to re-derive delivery from theory. E6 (`collectEmitters`
walking pre-merge members to win back the 448 draw calls) is still worth doing —
but as a PERF item, not a correctness one.

### ✅ E1 WAS REAL AFTER ALL — a texture-driven `emissive` baked BLACK

Found on the user's live scene, not on a rig. `tslGraph` compiles the BSDF's
emissive pair to `emissiveNode = mul(colorInput, strength)`. `resolveMaterialSurface`
had `emissiveTexture ? null : constantColorOf(…)`: a texture-driven emissive was
REFUSED outright, so the mesh emitted nothing and `emissiveStrength` multiplied a
node GI never evaluated — 1, 100 and 1500 were bit-identical darkness. The
"emitter bakes BLACK" warning was gated on `!emissiveTexture`, so this case
printed **nothing at all**.

Fixed: a texture-driven emissive resolves to its **mean × strength**. The old
refusal's spatial argument (a mask averaged over a facade misplaces the glow) is
right and is now WARNED about; its energy argument was backwards — emitted power
is `area × mean(radiance)`, so the mean is the energy-correct summary, the same
identity `textureAverageColor` is already trusted for on bounce albedo. The
strength needs `textureScaleOf` because that `mul` bakes it into the node and
`material.emissiveIntensity` stays at 1. `resolveMaterialSurface` is shared, so
the light tree is fixed by the same change. Verified live: the café went from
black to fully lit.

⚠ **METHOD.** This is the family E1 predicted ("authored strength is DISCARDED"),
on the branch E1 did not name — and it was dismissed earlier in this same session
on RIG evidence. Every emissive rig in this repo authors a FLAT COLOUR, so none
of them can reproduce it. Read the user's actual material and ledger before
generalising from a rig.

### ⛔ STILL OPEN — SPARSE EMITTERS DELIVER LITERALLY ZERO

Same scene, live ledger:
`P=1.8e+1 area=3.8e-2m² fill=0.000 rgb=0.0/0.0/0.0 r=12.03m` — an entire
string-light run welded into ONE emitter with a **12 m fitted radius**. §13.7g's
sparse correction damps its radiance ~12,000× to zero, and every receiver in the
café sits INSIDE that fitted sphere, where the sphere irradiance model is
meaningless. **19 of 95 emitters are in this state.**

The correction is not wrong in itself (it preserves far-field total power) — it
is papering over the real defect: `collectEmitters` fits ONE light to a mesh
holding dozens of separate bulbs. **Fix: split a sparse emissive mesh into spatial
clusters, one emitter per cluster at fill ≈ 1.** Needs no authoring change from
the user. NOT IMPLEMENTED — this is the top remaining emissive item.

### ⛔ "SMALL EMISSIVE OBJECTS DON'T EMIT" IS NOT A GI BUG — IT IS THE UNITS

User report after the delivery gate went green. `npm run test:gi-emitter-size`
runs the two sweeps that separate a transport bug from physics, with tone mapping
OFF and the readback linearized (AgX at a 0.65 mean would compress a real falloff
into a fake "reach cutoff"):

**Sweep A — radius at MATCHED TOTAL POWER** (radiance scaled by `(r₀/r)²` so
`π·A·L` is constant, confirmed by the ledger reading `P=4.7e+0` on every arm):

| radius | strength needed | delivered | vs r=0.2 |
|---|---|---|---|
| 0.2 m | 3 | 3.269e-2 | 1.000× |
| 0.1 m | 12 | 2.977e-2 | 0.911× |
| 0.05 m | 48 | 2.909e-2 | 0.890× |
| 0.025 m | 192 | 2.891e-2 | **0.885×** |

**Sweep B — falloff at r=0.05** out to 1.6 m is NOT steeper than inverse-square,
so the plan's E2 suspect (a reach/cutoff derived from geometric radius) is
CLEARED. ⚠ Only the low side of that ratio is a verdict — an enclosed room with a
wide crop is shallower than 1/d² by construction, so the measured 3.3–6.2× is
expected and is not evidence of super-physical reach.

**The finding:** the transport delivers small emitters correctly (0.885× at 8×
smaller radius). Look at the STRENGTH column — holding delivered light constant
took **3 at r=0.2 and 192 at r=0.025, a 64× authoring difference**, because
`strength` is RADIANCE and `power = π·area·radiance` falls with the square of
size. A bulb-sized mesh at a panel-sized strength is asking for a light two
orders of magnitude dimmer, and nothing told the author that.

**Shipped:** an `[gi] emitter SCALE hint` line that names the smallest emitter,
its power deficit, and the strength it would need for parity — verified live
(a 0.05 m bulb at strength 20 among 0.15 m decoys at 200 correctly asks for
~1.8e+3; area ratio 9.0 = strength ratio 9.0). `__giLogEmitterScaleHint = false`
silences it.

⚠ **DELIBERATELY A DIAGNOSTIC, NOT A CORRECTION.** Rescaling emission by area —
so `strength` means power and a small mesh is as bright as a big one — is the
authoring affordance people expect from other engines, and it is a ONE-LINE
change here. It is not made because it changes the look of every scene already
authored against the current meaning. **That is a product decision for the user,
and it is the open question this section leaves.**

### ⛔ S1's DENSE RING IS NOT BUILDABLE. The torus belongs on the KEY.

Priced in `run-gi-src-worldkeys-test.mjs` case 0, at s₀ = 0.35:

- c0/L0 alone: **16,777,216 cells to hold ~16,000 live probes — 1,049× waste.**
- all 40 (cascade, LOD) levels: 191,692,800 cells = **5.71 GB** of probe records
  and **338 GB** of direction bins.

A probe population is a **2-D manifold** (visible surfaces) inside a 3-D
lattice; a dense ring pays for the third dimension and gets nothing back. This
is the same arithmetic as §12.16 (0.24% of allocated bins ever sampled, 604 MB
against a 128 MiB limit) — the plan's own rejected-alternatives section names
that wall as the reason not to grow the hash, and the dense ring walks into it
from the other side. The plan's "32³ ring at 1 m covers 32 m" sketch is also
inconsistent with `LOD0_REACH = 64`: c0/L0 needs 256 cells per axis at s₀, not 32.

**What shipped instead — world-absolute keys.** Every property S1 wanted comes
from probe IDENTITY being a pure function of the world cell. That does not
require STORAGE to be indexed that way, so the hash stays sparse and the memory
stays honest. The 9-bit cell field now holds `worldCell mod 512` instead of a
cell relative to a camera-following anchor:

- **The re-anchor is gone.** `worldCellAt` = `round(anchor/s)` + `round((p −
  round(anchor/s)·s)/s)` ≡ `round(p/s)` for any integer origin cell, so the key
  does not depend on where the anchor is. The anchor keeps only its numerical
  job (holding the f32 division camera-relative — trap 4 in `srcMathTsl`) and may
  now follow the camera every frame at zero cost. `REANCHOR_CHEBYSHEV`, the
  cold-guard re-arm and "wholesale history loss on long moves" are unreachable.
- **The alias is unreachable by construction.** Live span on one axis at LOD L is
  `2·lodRadius(L+1)`; the key repeats every 512 cells of that level's spacing;
  period/extent = **2·2^cascade ≥ 2**. Asserted over all 40 pairs, not argued.
- **No cell is ever unrepresentable.** `packProbeKey` used to return EMPTY past
  ±256 cells — a probe that silently does not exist, the "lights fine at spawn,
  goes flat after a walk" failure. A toroidal window cannot produce it.
- **A 100 m teleport renumbers ZERO surviving probes** (101,484 (point, cascade,
  LOD) triples checked). Today's keying renumbers all of them past 64·s₀.

Gates: `test:gi-src-worldkeys` (8 cases, all pass, pure Node — these are claims
about integer arithmetic and should not need a browser). Live parity on the
shadowed-bulb rig, three ways — shipped **0.64866**, world keys **0.64930**
(+0.10%), world keys + retention **0.64952** (+0.13%). That is the LOD-boundary
tolerance class `test:gi-src-math` already documents, and it is the check that
matters most for retention: a held payload could have inflated delivered energy,
and it does not.

### ✅ AND LOCALITY RETIREMENT, which is what the symptom was actually about

World keys are the enabler; this is the unit that moves the picture. The shipped
rule retires a probe `PROBE_MAX_AGE` frames after the last PIXEL looked at it, so
turning the camera deletes the neighbourhood behind you along with its payload.
Retirement is now keyed to **locality** (is the probe still inside the shell its
LOD serves?) while visibility keeps deciding only who gets RAYS — which was
already right, since `srcRays` budgets off `pixelProbe`, so a retained probe costs
storage and nothing else.

**Two bounds, both load-bearing.** `outOfReach` retires immediately regardless of
age (which is also what keeps the ±256-cell alias proof true rather than merely
likely). `crowded` falls back to the visibility age above 60% of slot capacity —
retention grows the population from "visible surface cells" to "every surface cell
in the neighbourhood", and a failed insert is a probe that DOES NOT EXIST, which
is strictly worse than a cold one.

**The companion nobody would guess: the decay had to be frozen.** The decay pass
multiplies every allocated bin by `keep` every frame, so a probe held for a second
comes back holding `keep^60` — black. Retention alone would hold a slot whose
payload had faded, turning an absence into a DARK VOTE, which is exactly what R1
forbids. A sixth per-block region (`blockHeldBase`) carries a hold stamp and the
decay reads `keep = 1` on it. ⚠ The stamp keys on **visibility**
(`PROBE_AGE == 0`), NOT on "did it get rays": under the ray stride a *visible*
probe gets rays only every S-th frame and the decay is deliberately the S-th root
so the product over S frames is `1−α` (§12.23) — freezing on ray count would decay
visible probes S times too slowly and un-calibrate every temporal number in §12.

`npm run test:gi-spin-retention` — 360° spin in 90° steps, then a 100 m teleport
and back, three arms (shipped / world-keys-only / retention) so a win cannot be
attributed to the wrong half:

| arm | mean dip | mean recover | held↑ | FAILED↑ | reanchors |
|---|---|---|---|---|---|
| shipped | −33.7% | 720 ms | 0 | 0 | **3** |
| retain | **+6.6%** | **120 ms** | **1299** | 0 | **0** |

Per-pose, the shipped arm's 180°/270° turns and the teleport return show −64%,
−67% and −82% transients taking 1.26–1.62 s to settle; the retention arm's worst
is 11.0% settling in 180 ms. `held` climbs 433 → 866 → 1299 as the camera turns
(the neighbourhood being kept instead of churned) and `liveC0` accumulates
433 → 1732 and stays, where the shipped arm sits pinned at 1237. Zero re-anchors
across the 100 m teleport, against three for the shipped arm.

⚠ Confound to know about: the two arms booted at different gbuffer sizes (51,813
vs 78,780 px), so absolute `settled` luminance is NOT comparable across arms. Every
statistic above is within-arm (dip and recovery are relative to that arm's own
settled value), which is why the gate is written that way. Re-run with a pinned
resolve size before quoting cross-arm energy. Also `fresh↑` reads 0 on both arms —
`COUNTER_FRESH` is not surviving the `readPressure` path; harmless here (`held` and
`live` carry the finding) but it is a broken instrument worth fixing.

⚠ **ALL OF THIS IS OFF BY DEFAULT** (`__giSrcWorldKeys = true` opts in;
`__giSrcProbeRetain = false` disarms retention within it), as the plan requires.
Before the flip: `srcRef.js`'s mirror and `srcGizmos.js` are NOT converted (both
gate/debug-only, and the CPU suites run with the hatch down); S1 gate 1's
bit-comparable parked-camera arm has only been run as a luminance mean, not a
pixel diff; and gate 3's "no frame > 2× median" freezeless assertion is not
measured — the spin rig reports recovery, not frame times.

### ✅ S2 — seats retired as a delivery path

The plan gated this on "after Phase E proves delivery", and the shadowed-bulb rig
is that proof, so it went in. `#chooseEmitterSeats` no longer scores by
`power/d²` to the camera; it scores by RAW POWER, so seat identity is a property
of the SCENE and the `#checkFingerprint` camera-cadence re-rank is skipped
entirely (it could only re-derive a constant). Seats change only when the scene
does — a lamp dimming, spawning, despawning.

`npm run test:gi-seat-churn` — 12 static lamps (past MAX_EMITTERS), 48-step
orbit, **full delivery armed on BOTH arms**:

| arm | seat flips | same-pose jitter | worst | energy |
|---|---|---|---|---|
| follow (shipped) | **12** / 48 | 6.626e-4 | 2.652e-3 | 0.58300 |
| anchored (S2) | **0** / 48 | **4.973e-4** (0.75×) | **1.779e-3** | 0.58228 |

The follow arm's seat trail shows the churn directly:
`208,226,206,228 → 208,210,206,228 → 208,210,206,212 → …` — continuous turnover
across the lap. Energy ratio 0.999, so it is the same picture.

⚠ **`__giEmitterSeatsFollowCamera` exists ONLY so this A/B can be honest.** The
obvious control — tile cut off vs on — also changes what the un-seated lamps
deliver, so a jitter delta would be confounded with an energy change. Both arms
here run full delivery and differ in the seat policy alone.

⚠ **The jitter statistic took two attempts, and the first one lied.** Measuring
`|Δlum|` between consecutive ORBIT STEPS reported ratio **1.00** — which reads as
"S2 buys nothing" and was the instrument failing: moving the camera changes the
crop's content, and that swamps any temporal effect by ~60×. Holding the pose and
sampling twice removes it. Anyone re-measuring flicker during movement in this
module should hold the pose.

**Honest size of the win:** seats owned about **a quarter** of the same-pose
temporal instability on this rig (25% mean, 33% worst), not all of it. The
mechanism is gone and it cost nothing, but if flicker during movement is still
visible after this, the remaining three quarters are elsewhere — §12.63's flicker
instruments are the next place to look, not the seat code.

### Shipped from Part 2's ship-first list

- **B1** — pool sizes and the surface-pool hint persist per project+scene in
  `engine.prefs`. Boots stop re-climbing `700000→1400000→2800000`, and the
  surface hint's **forced ~20 s rebuild is not re-paid every boot**.
- **B2** — a pool grow no longer runs the whole resize path. It used to poke
  `screen.width = 0` to defeat the tolerance check, which bought the store swap
  *and* a fresh `createGiTargets` for every target at the size it already was —
  zeroing the §12.65 irradiance history, the emitter-shadow history and the
  light-shadow history. `#rebuildSrcProbesForPools` swaps the store, rebuilds only
  the resolve (it genuinely binds the store's buffers), and leaves every target
  and its history alone.
- **B3** — the surface-pool hint is compared against `SURFACE_POOL_CEILINGS`
  (now exported) BEFORE the forced rebuild. At the ceiling the hint is clamped
  and the stall is refused once, out loud, naming the lever that works (demand,
  not supply). This is the `forced rebuild 1/2` line the user saw every ultra boot
  — a ~20 s stall that allocated exactly what was already there.

---

Plan for the next session. Supersedes `GI_BUGFIX_HANDOFF.md` (its A1 ran and
confirmed density; its bug-A section is folded into Part 2 here). Everything
below carries its receipt from the 2026-08-17 session; nothing is theory
unless marked HYPOTHESIS.

**State as of writing:** scene is on `quality: "high"` (user may revert — it
was set for the A1 test and it does mask the record-pool starvation). The
slide/ray-cap fix is VERIFIED live (slides no longer arm the light-track
window; `armed by none, open 100%` lines are gone). Merge-refusal for
emissiveNode is live and costs 448 draw calls (504→952, gbufferPrepass
5.6→10.5 ms) — Part 1 E6 is the fix-forward that recovers them. Pools still
reset to floors every boot. User-visible state: black patches lag the camera,
light flickers on movement, fps halves on movement, emitters deliver ZERO.

**Method rules (each cost a wrong verdict this session):**
- Screenshot `camera:"game"` at the user's pose. The editor camera hid the
  bug twice.
- Instruments over theory: `dropped N inserts`, `deposit noBlock`, emitter
  ledger `fill/rgb/P`, light-track `open %`, `surface records …/…`.
- ZERO output is a severed path; a scaling bug still scales. The user proved
  emitters sit in shadow at 10,000 strength with no visible contribution —
  do not spend another round on radiance math until delivery is proven.

---

## Part 1 — Phase E: emitters deliver nothing

### The finding

`#isNeeEmitterMesh` (GISystem.js ~8459) returns true for **every tree
candidate** while `__giSrcLightTree` is armed (default ON), and three sites
zero those meshes' emissive on that answer: `#slotSurface` (~8510, the
field/voxel surface), the analytic-only occluder spheres (~10438), and
`isPromotedEmitter` for the dynamic set (~9881). That is R5/W5b working as
designed — an emitter the transport samples must not also emit on contact.

So all 95 emitters have field emission ZEROED, on the promise that the tree
delivers instead: [J] NEE in transport + the W4b per-pixel tile cut on
screen. The boot warning "analytic slots cover the 4 most apparent — the
rest emit through the field only" is **false under an armed tree** (the
field path it names is the thing R5 deletes) — fix the text when the rest
is fixed. If tree delivery fails for the 91 un-seated emitters, they
contribute exactly zero, which is exactly the report.

### E0 — confirm the severed path (one boot, no code)

Boot with `__giSrcLightTree = false` **and** `__giEmitterTileCut = false`
(⚠ W5b: the hatches are coupled — flip BOTH, the build warns if the cut is
armed alone; every rig this session learned this the hard way). Bulbs light
via restored field emission ⇒ R5 zeroing over dead delivery is confirmed and
Phase E is a delivery hunt. Bulbs still dark ⇒ stop, the bug is upstream of
delivery (go to E1 first).

### E1 — the intensity question (D1), settled by ledger

`resolveMaterialSurface` (voxelizeOnce.js): when `emissiveNode` folds to a
constant, `emissiveIntensity := 1` — assuming the node premultiplies. Engine
materials may carry strength in a uniform the folder cannot see, in which
case authored strength is DISCARDED. Test without code: set the café bulb
to strength 100, rescan, read its ledger line; then 10,000, rescan, read
again. `rgb` must scale ×100. If it does not, fold the material's intensity
into the resolved constant (only when the fold didn't already include it —
check the uber material's emissive graph shape before writing). This bug
would ALSO cap tree-NEE energy, so fix it regardless of E0's outcome.

### E2 — stage-walk the delivery (only if E0 lit the bulbs)

Instrument at the café pose, bulb 0.5 m from a wall:
1. Is the bulb's id in its own pixel-tile's cut list? (`EXTRA=` dev globals
   in `run-gi-emitter-scale.mjs` already decode lists.)
2. Is `emitterShadowPass` dispatching, and is the bulb's shadow channel
   nonzero at those pixels? ⚠ Memory records a §12.56-family race where
   `_emitterInfos` settles empty and shadow targets FAIL CLOSED (all-zero
   shadow × direct = zero everywhere) — check dispatch gating for the
   un-seated pseudo-slot path specifically.
3. Is the resolve's `emitterDirectAt` term nonzero there (debug view)?
Fix at the first failing stage. Candidate mechanisms, in order: fail-closed
shadow for pseudo-slots; reach/cutoff derived from geometric radius so a
0.05 m emitter is range-capped regardless of power (make it power-derived:
reach to where P/(4πd²) < ε); tile-cut ranking artifacts.

### E3 — the un-merge was necessary but not sufficient; make it free (E6)

Merging no longer welds emissive meshes (correct for fitting — fill went
0.001 → 1.0) but costs 448 draws on a CPU-bound scene. Fix-forward:
**`collectEmitters` walks pre-merge member meshes** (`proxy.members` /
`userData.mergedInto` both exist) and skips proxies — merged drawing, per-
member emitter fitting. Then REVERT `emissiveRefusal` in merging.js and
retarget the new gate case in `run-merging-test.mjs` (it currently asserts
refusal; it should assert per-member emitters from a merged group).

### E4 — gates

- Existing: `test:gi-lighttree-nee` (parity 4-lamp), `run-gi-emitter-scale`
  N=12 (⚠ set BOTH hatches explicitly on BOTH arms — post-flip they no
  longer discriminate otherwise), `test:merging`.
- NEW, the user's exact case as a rig: one small emitter (r≈0.05 m,
  authored strength ≥1000) in full shadow, a neutral patch 0.5 m away —
  gate on patch luminance ≫ noise vs an emitter-off arm, at BOTH hatch
  settings. This is the gate that would have caught R5-over-dead-delivery
  the day it shipped.

### E5 — stopgap if the delivery fix runs deep

Make the zeroing honest instead of hopeful: zero only emitters with a
PROVEN screen path (the 4 seats + ids verified present in tile lists), let
the rest keep field emission. Double-lit is a lesser evil than unlit; note
it in the console line.

---

## Part 2 — Phase S: the world-anchored rebuild ("the spatial problem")

### Requirement (user's words)

Camera may move fast, move a lot, move far. Handling must be fast,
seamless, freezeless.

### Why the current architecture cannot meet it

Every failure this session traced to one root: **GI state is keyed to what
is on screen right now.**

| Mechanism (receipt) | Consequence |
|---|---|
| Probes exist per visible pixel, retire when pixels leave; hash full at floor (`dropped 12467 inserts (16384/16384)`) | Turning the camera destroys a warm cache and cold-starts a new one at α≈0.02 → black patches that "cannot keep up" |
| Pool growth doubles/demand-sizes ON PRESSURE, and every grow REBUILDS the probe store; pools reset to floors each boot | unlit→lit flashes, "GI restarts", boot re-pays the ladder |
| Re-anchor re-keys every probe past 64·s₀ drift (`REANCHOR_CHEBYSHEV`) | wholesale history loss on long moves |
| Bins cannot back the slot ceiling (131k c0 → 16.8 M bins ≈ 604 MB vs 128 MiB binding limit; block-backed cap 21,875) | growth can never catch this scene — the wall is architectural |
| Emitter seats ranked `power/d²` TO THE CAMERA, re-ranked on move | light pops/flicker during movement |
| Detail box slides armed the light-settle window (FIXED: `_giSlideHeld` split — keep this pattern) | was the 3.8× deposit cost on every walk |

### S1 — toroidal clipmap probe store (the core swap)

Replace hash + freeStack + re-anchor with a **fixed-footprint, camera-
centred, world-anchored ring buffer** per cascade:

- Probe index = `worldCell mod ringSize` (toroidal). A probe's storage slot
  is a pure function of its world cell — no insert, no hash, no failure
  mode, no retirement of survivors, no re-anchor EVER.
- Camera movement re-purposes only the strip of cells that wrapped:
  O(strip), not O(population). A fast pan touches a bounded strip per
  frame; survivors keep payload and history untouched.
- Memory is fixed at build from the tier: `ringSize³` probes, `ringSize³ ×
  binCount` bins, sized once, **growth deleted as a concept**. (Today's
  c0 live ≈ 14–16k on this scene; a 32³ ring = 32,768 cells at 1 m spacing
  covers a 32 m radius neighbourhood — do the sizing pass against measured
  live counts per cascade before fixing ringSize.)
- RAYS stay screen-driven (visibility decides who gets rays this frame —
  that part of SRC is right); STORAGE becomes locality-driven (a probe that
  leaves view keeps its payload until its cell wraps out of the ring).
- Teleports/far moves: the whole ring re-purposes over a few frames under a
  per-frame strip budget (~2 ms); the §13 F3 far-field constant (already
  shipped, already the out-of-box answer) covers unfilled strips — the
  cover story exists, use it.
- Cascades already space 2× apart — keep them as concentric rings (fine c0
  near, coarse far), far field beyond the last ring = F3.

What survives verbatim: gather/merge/deposit kernels (they address probes
by index — the index derivation changes, the payload layout need not),
tiles atlas, [J], the screen chain, F1/F2/F3 (the slide becomes trivial:
the ring IS the slide), the `_giSlideHeld` α-floor pattern for uncovered
strips.

### S2 — emitters go fully world-anchored (after Phase E proves delivery)

The light tree is already world-anchored and live-refreshed (W5a). Once
tile-cut delivery is verified for all N (Phase E), retire the camera-ranked
4-seat promotion (`#chooseEmitterSeats` churn = the flicker) — seats become
at most a cache, never the delivery path, and seat re-ranking stops touching
the image.

### Ship-first interim units (kill the visible symptoms while S1 is built)

- **B1** persist grown pools + `_surfacePoolHint` per project+scene
  (`engine.prefs`); boots stop re-climbing (today: `700000→1400000` again
  every boot).
- **B2** hold the previous irradiance texture through a probe-store rebuild
  (targets are persistent) — no unlit flash.
- **B3** when the surface-pool hint exceeds its ceiling, clamp + log once,
  never force a rebuild that cannot succeed (`forced rebuild 1/2` fires
  per boot at ultra).

### Gates for S1

1. Parked static camera: bit-comparable image vs the hash arm (hatch
   `__giSrcClipmap`, keep the old store for A/B through the whole phase).
2. 360° spin: ZERO survivor retirements (counter), luminance recovery time
   vs today's — measured, expect ×N.
3. 100 m teleport: full refill under budget with no frame > 2× median
   (freezeless is a GATE, not a hope).
4. Memory: exactly fixed across a 5-min walk (no grow lines in console).
5. Rigs to reuse: `run-gi-volume-follow.mjs` (dolly + luminance-in-page),
   flicker instruments from §12.63, `run-gi-emitter-scale` for delivery.

### Alternatives considered and rejected

- Grow the hash + persist pools: dies on the 604 MB bin wall; re-anchor
  churn remains; growth rebuilds remain.
- Keep hash, add LRU retention for off-screen probes: halves the symptom,
  keeps insert failure, re-anchor, and growth — three of the four
  mechanisms survive.

---

## Cleanups to carry (small, do opportunistically)

- Fix the "emit through the field only" boot warning text (false under
  armed tree).
- `AttributeNode: uv not found` spam — the attribute-set group key exists;
  find the one straggler.
- The 7.2 GB jsHeap reading (fresh boot showed 1.9 GB — session growth, not
  static): park 60 s, measure slope; earlier session recorded +20 MB/s idle.
- `quality` back to user's choice once S1 lands (high is currently masking
  record-pool starvation at ultra).
