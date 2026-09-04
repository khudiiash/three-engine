# Level GI fidelity investigation — 2026-09-04

Status: partial fix only. Finer banding and the full higher-order bounce deficit
remain unresolved; further experiments stopped at the user's budget concern.
Do not treat a build or a passing
small-room smoke as evidence of visual parity with the path tracer.

## Scope and reproduction

- User scene: `GAME/scenes/Level.scene`; scene assets are not modified.
- Camera position: `(4.1819469965, 1.3137984706, -7.2593093954)`.
- Camera target: `(1.7260693067, 0.8981785730, 7.0073983115)`; vertical FOV 60°.
- Sun is held at its authored pose in the isolated test editor.
- `scripts/run-gi-level-fidelity.mjs` reproduces the scene in a scratch browser
  profile using the read-only project shim. Reports and images are written under
  `.gi-shots/level-fidelity/`. Frozen-field comparisons avoid boot-to-boot sampling
  differences; beauty/path-tracer comparisons must use identical viewport sizes.
- `.no-hmr` is present: a running editor does not automatically use source edits.

## Verified corrections

### Ray packets must retain distinct sequence indices

Cold-priority scheduling could append the same representative pixel repeatedly,
overwriting its one shared `pixelRayBase`. Accepted packets then duplicated the
last packet's directions; a later rejected packet could invalidate earlier work.
The scheduler now reserves a contiguous range once and packs each packet ordinal
beside the pixel index in the existing worklist word. Deposit reconstructs the
packet's distinct base. No storage binding is added, and unpacked callers retain
their existing contract.

The live smoke previously allocated 22,590 rays but traced 20,900; it now traces
all 22,590. Targeted real-deposit checks cover full and partial representative
reservations, ordinary pixels sharing the budget, and successive frames.

### A partial surface stencil is not an unanswered gather

Fine tiles contain the complete interval integral `L0 + T0 * mergedC1`. Coarse
tiles do not contain `L0` or `T0`, so replacing fine tiles merely because their
angular confidence is below one discards nearby bounce. Surface-only population
also naturally leaves some 3D stencil corners empty. The final screen gather
uses coarse fallback only when fine gathering has no usable answer at all;
partial fine stencils retain their properly renormalized fine result.

GPU regression fixtures preserve fine irradiance with full spatial coverage at
alpha 1, .55, .1 and .01, with complete and partial surface stencils. The corrected
gather passes CPU/GPU comparison and furnace tests. An intermediate spatial-weight
blend had negligible global impact and did not fix the wall. The final fallback
rule reduces the strongest measured gray-wall row jump by 99.4% (.049012 to
.000289), recovering 18.46% mean irradiance in that region on identical frozen
P/N and probe textures. These are regional results, not proof that all banding is
gone; the user still reports smaller bands.

### Environment rotation must match raster and tracer

The GI environment sampler rotates lookup directions, whereas the scene setting
rotates the environment itself. The lookup now uses the inverse yaw, matching
Three's inverse environment transform. GPU merge fixtures at +90°, -90° and
250° fail with the original sign and pass with the correction.

### Nearest-cascade sun chroma must match the reference shader

The GPU paths initialized nearest-cascade chroma compensation to one, skipping
the existing cascade-zero coefficient that the CPU reference applied. Both
deposit and secondary shading now initialize from the shared helper. Real GPU
hit shading agrees with the CPU reference; the old initializer differs by 10.1%
on the colored cascade-zero fixture. This is not a neutral brightness multiplier.

## Validation and eliminated hypotheses

- Full SRC smoke: `GI-SMOKE PASS storage=8`, nonzero tracing, no WebGPU validation
  errors. Run with `node scripts/run-gpu-page.mjs
  "http://127.0.0.1:5287/scripts/gi-gpu-smoke.html?src=1&mode=hybrid-exact-complex"
  70000` against a fresh Vite server. The smoke accounts for dead atlas blocks
  skipped by the existing live-block optimization and forces a real structural
  rebuild when checking build-time opt-outs.
- Gather GPU suite passes; shade GPU suite passes; environment merge suite passes;
  ray scheduling suite passes. CPU SRC reference and Vite build also pass.
- New `gi-irradiance-temporal-audit.html` compares the actual GPU temporal filter
  with controlled float textures. Seven cases pass, including bit-exact weight-zero
  passthrough. The Level's filtered/raw median ratio is approximately 1.002: the
  main energy loss is upstream of the temporal filter.
- Disabling gather plane weighting or coarse fallback on the frozen field does
  not remove the bands. Smooth G-buffer positions and flat wall normals rule out
  a corresponding geometry-normal discontinuity.
- Replacing sun-map visibility with BVH visibility does not resolve the deficit.
- Raising loop albedo from .9 to .99 only in a test browser does not resolve it;
  the production stability ceiling is unchanged.
- Disabling merge-link occlusion increases mean gathered light in an isolated
  boot, but still leaves bands and a substantial deficit. This is a diagnostic,
  not a justified change to the shipping default.

## Remaining visual result

`final/beauty.png` and `final/path-tracer.png` show an intermediate source state versus
the tracer at the same 1206×517 viewport. The GI image remains too dark and banded.
The tracer's default is 15 bounces. In the same frozen tracer scene, limiting it
to two bounces makes it darker than GI: the gray-wall linear mean falls from
.0741 to .00401, and the ceiling from .1226 to .01224. The large remaining energy
gap therefore involves higher-order transport, not simply a missing first bounce
or a display exposure mismatch.

## Bounded offscreen-receiver experiment — disabled by default

The actual secondary hit list contained 36.4% hits with no fine-probe support.
`srcSecondaryReceivers.js` snapshots up to 8,192 static surface hits into a sampled
texture and replays them as virtual receivers through next frame's existing
population, ray budget and deposit. It is explicitly opt-in through
`__giSrcSecondaryReceivers=true`; no project or live-editor flag was changed.

The causal GPU fixture proves an unseen A→B→emitter path returns energy to A,
and checks invalid records, ray-facing normals, resize and stale-slot retirement.
Receiver-enabled full smoke passes with 8 storage buffers, 29,260 allocated and
traced rays, and no validation errors. However, the final real-scene experiment
(`final-receivers/`) overshoots the tracer in beauty even though its gathered
irradiance gain is much smaller. It is therefore NOT promoted as a finished fix.

The unfinished surface-origin experiment was removed. The final Vite build and
gather regression pass. No live-editor reload or scene/asset edits were performed.
