# Foliage

The optional `foliage` module provides procedural oak, pine, birch, meadow grass,
and wildflowers. A Foliage component owns an individual plant or an entire
scatter layer; generated plants do not become separate entities.

## Authoring

Select a Mesh, Model, or Terrain and use **Procedural Foliage → Trees / Grass /
Flowers** in its inspector. The same actions appear as **Scatter Trees / Grass /
Flowers** in the hierarchy context menu for a mesh surface or a group containing
meshes. These actions enable the Foliage module, create a child layer referencing
the selected surface, and select it for editing.

With the module enabled, the hierarchy's create menu also offers **Foliage Tree**,
**Foliage Grass**, and **Foliage Flowers**. Creating under a surface scatters on
that surface; creating without one places a single plant. Switch **Placement**
between **Single plant** and **Scatter on surface** in the Foliage inspector.
The **Surface** field accepts Mesh, Model, Terrain, or a group of mesh surfaces.
An empty reference uses the Foliage entity's own mesh, model or terrain, or its
parent's surfaces.

All controls are scene properties and use the editor's command/undo system.
Changing **Species** applies its shape, colors, placement, and distance preset
together in one undo step. **New variation** increments the seed, changing both
the prototype and its seeded distribution. Use separate layers with different
species or seeds for mixed vegetation.

| Control | Meaning |
| --- | --- |
| Plants / m² | Population per square metre of accepted world-space triangle area, before the plant limit and minimum-spacing rejection. |
| Plant limit | Maximum population in this layer, including plants currently outside draw distance. |
| Height / Width | Procedural shape dimensions in metres. Crown extents are approximate botanical envelopes. |
| Foliage / Bark / Flower color | Vertex colors on the generated geometry; color changes also invalidate its impostor atlas. |
| Scale | Seeded uniform per-plant scale range. |
| Spacing | Minimum three-dimensional root-to-root distance in metres, enforced across spatial-cell boundaries. |
| Slope ° | Allowed face angle from world up: 0° is upward ground, 90° a wall, 180° an underside. |
| Altitude | Allowed world-space Y range. Triangles crossing its boundaries are clipped when calculating eligible area. |
| Follow normal | Align local plant up to its source face normal; disable for upright trees on hillsides. |
| Wind / Wind response | Enable animation and choose how strongly this plant responds to the shared Scene wind. |
| Gust response / Gust size / Turbulence | Response to Scene gusts, world-space gust-pattern size, and finer leaf/blade-tip movement. Defaults: 0.6, 12 metres, and 0.25. |
| Collider bending / Bend strength / Extra reach | Visual displacement around nearby colliders and character controllers, with an added influence distance in metres. |
| Detail distance | Change from detailed geometry to the simpler mesh. |
| Impostor distance | Change from the simpler mesh to its baked, dynamically lit billboard once the atlas is ready. |
| Draw distance | Hide chunks beyond this distance. |
| Cell size | World-space chunk size. Smaller cells improve detail/culling precision; larger cells reduce CPU bookkeeping. Plant size also caps the effective cell size; rendering shares at most three batches per layer. |
| Cast / Receive shadows | Normal engine shadow participation. |

Species presets establish useful starting scales and distances; they are not
fixed performance guarantees:

| Preset | Height × width, m | Plants / m² | Spacing, m | Detail / impostor / draw distance, m |
| --- | --- | --- | --- | --- |
| Oak | 8 × 6 | 0.015 | 4 | 35 / 90 / 350 |
| Pine | 10 × 4 | 0.025 | 3 | 35 / 90 / 350 |
| Birch | 9 × 4 | 0.03 | 2.5 | 30 / 80 / 300 |
| Grass | 0.65 × 0.65 | 3 | 0.15 | 12 / 30 / 65 |
| Wildflowers | 0.8 × 0.6 | 0.8 | 0.3 | 15 / 35 / 80 |

## Terrain and mesh surfaces

Placement samples actual triangle area, including indexed and nonindexed meshes,
nested imported models, instance transforms, and nonuniform or mirrored parent
transforms. Disconnected surfaces do not populate their empty bounding box.
Degenerate triangles are skipped. Batched and merged source meshes remain
plantable even while the optimizer hides them; render proxies and generated
foliage are excluded from sampling.

Every plant stores its source triangle and barycentric attachment. Terrain
sculpting updates positions and normals on those same attachments, preserving
seed, scale, yaw, and plant identity. Changing height alone therefore preserves
the root's XZ location. A source transform also moves its attached distribution.
Source topology changes or changes to placement parameters produce a fresh
deterministic distribution. Scene reload reconstructs the generated resources
from serialized component properties and the referenced surface; asynchronous
mesh/model geometry arrival replaces any initial placeholder distribution.

Slope, altitude, density, and spacing are distribution constraints. Reseating
existing attachments after a sculpt preserves plants rather than deleting or
repopulating them whenever a face crosses a constraint. Edit a placement control
or choose **New variation** to recalculate the distribution. Current skinned and
morph geometry can be sampled as a snapshot; continuously following arbitrary
animated deformation is not the runtime's attachment contract. Terrain's painted
material-layer weights do not currently mask foliage, and there is no foliage
painting or erasing brush.

## Rendering and scale

The tree generator starts from a species scaffold: spreading low forks for oak,
a slender leader and arching/drooping limbs for birch, and apical whorls for pine.
A bounded space-colonization pass grows fine branches toward nearby attraction
points, removes reached points, and biases continuation by inherited direction
and species tropism. A spatial hash bounds neighborhood searches. Pipe-model
weights set relative branch vigor; an additional monotone taper connects those
coarse structural pipes to thin leafy shoots. Shared curve points and parallel
transport frames produce tapered branch surfaces rather than disconnected rods.
The attraction/kill-distance method and pipe formulation follow
[Runions, Lane and Prusinkiewicz (2007)](https://algorithmicbotany.org/papers/colonization.egwnp2007.pdf).
This is a deliberately bounded adaptation, not an implementation of
[Interactive Invigoration's volumetric strand model (2024)](https://storage.googleapis.com/pirk.io/projects/invigoration/index.html).

Skeletons are cached across LODs and color changes, with limits of 640 nodes,
1,600 attraction points, 30 growth iterations, and 24 cached skeletons. Tree
foliage uses folded spray cards with procedurally generated alpha-tested masks:
18 small leaves per broadleaf card, or 256 needles in irregular paired pine fascicles.
The longest template leaf is approximately 10.5 cm for oak, 8.2 cm for birch,
and 13 cm for pine needles, before the spray's 0.82-1.14 size variation.
Increasing spray coverage adds more leaf silhouettes rather than turning a card
into one oversized polygon leaf. Pine cards measure 0.34 by 0.32 m and roll
around smooth lateral boughs as well as terminal shoots, filling the crown
without flat fern-like sprays. Young pine crown massing and paired needles use
[botanical references](https://landscapeplants.oregonstate.edu/plants/pinus-nigra)
as guidance; the preset is a procedural approximation. Bark uses metre-based
branch UVs and generated surface detail.

Grass remains curved tapered blades, and wildflowers retain their petaled shape.
Each layer shares a prototype and material across all of its instances; yaw and
size vary per plant. A seed changes the prototype as a whole, so a single layer
does not contain independently generated branch topology for every tree.

`createFoliagePrototype(props, lod)` supports three decreasing geometry levels
with stable seeded branch layouts. The runtime uses detailed LOD0, simpler LOD1,
and the engine's existing octahedral impostor implementation for its final tier.
The third generated geometry level remains available to callers. Distant plants
use two-triangle instanced quads, alpha-tested coverage, and baked albedo/normal
atlases that respond to current scene lighting. The runtime bakes 4 × 4 views at
64 pixels per view and caches the resulting atlas by renderer and shape
properties. Until baking finishes, the simpler mesh continues drawing.

World-space cells are split at 1,024 plants, along their widest spatial axis, so
their children occupy smaller regions. Species size caps the effective cell size.
Cells choose detail and retain detached source buffers, while **three shared
render meshes per layer** submit its near, middle, and impostor populations.
Typed-array ranges are packed only when LOD membership or placement changes;
ordinary wind updates and camera rotation do not rewrite instance transforms.
Batch attributes use version-driven upload usage: Three's `DynamicDrawUsage`
uploads even unchanged buffers on every render pass. A regression drives the
installed Three attribute manager, verifying zero stationary uploads and fresh
ranges after a LOD repack; its previous-usage control makes 180 redundant uploads.
Three r185 also synchronizes its private instance-matrix mirror after geometry
upload. A Foliage-only `OnBeforeObjectUpdate` forwards versions and partial ranges
to the compiled position and wind matrix mirrors before upload. Matching arrays
limits the hook to this object's matrices; no dependency or renderer patch is
installed. The GPU gate covers immediate repacks and untouched partial-upload
tails for static and dynamic usage at capacities 4 and 1,100.
An instrumented eight-second GI camera sweep measured foliage writes falling
from 1,072.3 MB to 75.4 MB (93.0%); a three-second stationary interval fell from
322.5 MB to 7.37 MB (97.7%). Stationary grass/flower matrices and impostor
placement buffers now upload zero bytes until repacking. Remaining stationary
foliage writes are the much smaller tree uniform buffers. Byte-attribution runs
are separate from uninstrumented FPS measurements.
Thus smaller cells improve distance decisions without adding a draw per cell.

LOD uses the nearest point of a tight detail box and projected plant size, with
authored distances as upper bounds and 8% hysteresis to stop boundary jitter.
Separate conservative motion bounds drive frustum and shadow culling. Selected
offscreen cells remain in the batches so they can cast shadows; a batch is culled
as a whole. Transitions are discrete, without a dissolve. Short grass/flower
distances and moderate cell sizes matter as much as population; increasing an
authored detail distance cannot force subpixel plant detail to stay at its most
expensive level.

The inspector's plants/cells/draws are component counters. Draws count the active
shared render batches, at most three per layer, before renderer frustum culling
and extra shadow passes. Triangles count all selected instances. These counters
are not GPU timing or a complete renderer draw-call measurement.

Hard bounds are **100,000 plants per component**, **1,000,000 sampled source
triangles**, and at most **20 placement attempts per requested plant**, capped at
2,000,000 attempts. Exceeding the triangle budget gives a diagnostic requesting a
simpler or smaller source; a crowded spacing request can legitimately place fewer
plants. Population and triangle caps bound work and memory, but initial generation
and surface rebuilding still run on the main thread. The layer retains placement
records, source triangle data, instance transforms, and impostor attributes.
Multiple layers add those costs. There is no terrain streaming, GPU procedural
placement, or zero-freeze guarantee for maximum-sized rebuilds.

## Animation, interaction, and lighting

Wind combines traveling gust fronts, delayed recovery, and finer tip motion.
Grass curves along circular centerlines of fixed arc length. Its rest fit keeps
the original roots, tips, widths and topology; intermediate points moved by at
most 3.844 cm across six default-geometry seeds. Flower stems bend while each
flower head follows one attachment as a rigid group. Tree motion rotates the
trunk, primary limbs, and leaf cards around their own attachments, with slower
woody response and faster flutter. The same rotations update surface normals.
Wind and interaction controls
update uniforms without reallocating instance matrices. Modal simulation
suspension and disabled entities pause updates; frame delta is clamped to 0.1
seconds. Impostors receive coarse whole-plant sway; their baked individual leaves
do not independently deform or react to local collider bending.

The motion design follows the two-scale moving field described by
[Sucker Punch's effects team](https://blog.playstation.com/2021/01/12/how-stunning-visual-effects-bring-ghost-of-tsushima-to-life/)
and the approach demonstrated in
[SimonDev's Quick_Grass](https://github.com/simondevyoutube/Quick_Grass).
Two samples from a shared 64-pixel noise texture run in the vertex stage.
Hierarchical motion also draws on the separate main/detail response in
[Crytek's vegetation animation](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis)
and the shallow branch hierarchy and frequency bands described by
[Renaldas Zioma](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees).
This is procedural motion, not a physical branch solver. Smooth force limits
retain variation in strong weather. Root transforms use the same update cadence
as Three's instance positions, including the first frame after batch compaction.

Direction, force, and gust frequency always come from **Scene → Wind**, using
`engine.settings.wind.{vector,gust,gustFrequency}` and shared scene elapsed time.
Per-layer controls adjust plant response, gust-pattern scale, and turbulence;
they do not create independent wind directions or clocks. The Wind checkbox
turns that layer's animation off. A missing scene wind block uses the engine
defaults: vector `[0, 0, 2]`, gust `0`, and frequency `1` Hz. A legacy scalar
wind vector means `[0, 0, scalar]`, preserving the historical +Z direction.
Previously serialized Foliage `windDirection` and `windSpeed` values remain
loadable for compatibility but do not override Scene wind.

Interaction uses at most eight enabled collider/character influences nearest the
camera. Boxes use oriented extents, spheres use their radius, convex colliders
use an oriented bounds approximation, and capsules use an enclosing sphere.
Sensors, disabled entities/components, and unsupported concave triangle shapes
are excluded. Bending is visual, capped to one metre of combined collider push;
it does not simulate breakage or make scattered trunks solid. Add an ordinary
scene collider where gameplay should stop against a tree.

Foliage uses lit `MeshStandardNodeMaterial` surfaces, direct shadows, and the
engine's existing GI reception path. The near, simpler, and impostor meshes are
tagged as dynamic foliage and excluded from GI transport geometry. They can
receive world GI, but the forest does not currently contribute its own colored
bounce or occlude GI rays. This avoids expanding every instance into the GI BVH.
Cached foliage-specific GI override materials preserve the billboard's alpha
cutout, baked normals, sidedness and vertex positions in the deferred prepass.
Foliage deformation uses uniforms and attributes rather than additional storage
buffers; the composed GI graph must continue to pass the portable eight-buffer
smoke test.

The material combines vertex color with generated leaf coverage, veins, normal
detail, bark patterns, and a small direct back-light contribution for thin leaves.
It has no imported botanical asset dependency or seasonal growth system.
Nonuniformly scaled single plants keep their full matrix
in mesh levels; the existing impostor representation uses the largest scale axis
for conservative billboard sizing and approximates their distant proportions.

## Code contracts

- `foliageGeometry.js`: `FOLIAGE_SPECIES`, `foliageRandom(seed)`, and
  `createFoliagePrototype(props, lod = 0)` returning a `BufferGeometry` with
  `position`, `normal`, `color`, and `uv` attributes. Trees share one interleaved
  buffer with four vec4 attributes: `treeBranch` (primary pivot, flexibility),
  `treeBranchAxis` (axis, wind weight), `treeLeaf` (attachment, phase), and
  `treeLeafAxis` (length axis, surface part: 0 bark / 1 leaf / 2 needle).
  Meadow geometry retains scalar `foliageWind` and one interleaved buffer with
  `foliageBlade` (root X/Z, rest length, attachment progression) and
  `foliageCurve` (rest direction X/Z, arc angle, signed cross-section offset).
  Negative curve angles identify flower attachments and unchanged undergrowth.
  Including both instance-matrix readers, trees use 16 attributes / 7 buffers,
  meadow uses 15 attributes / 8 buffers. Tree diagnostic metadata
  exposes actual card/branch counts and physical leaf dimensions.
- `treeGrowth.js`: `growTreeSkeleton(props)` returns the cached rooted graph,
  curved scaffold, pipe weights/radii, branch paths, terminal sites, and measured
  growth-work counters. No growth computation runs during ordinary camera motion.
- `foliageScatter.js`: `collectSurfaceTriangles(rootOrRoots, options)` returns
  transformed triangle positions, normals, cumulative areas, bounds, stats, and a
  `topologyKey`. A triangle-budget overflow throws an explicit `RangeError`.
  `scatterFoliage(rootOrSurface, props)` returns `{ instances, surface, stats }`;
  instances carry world position/normal/quaternion, scale, yaw, seed, source
  `triangleIndex`, and `barycentric` weights. The optional lower-level `count`
  overrides density while retaining the population cap.
- `reseatFoliageInstances(surface, instances)` mutates positions, normals, and
  orientations while retaining other identity fields, returning
  `{ instances, updated, invalid }`. Compare `topologyKey` before reseating;
  position/version or world-transform changes alone do not invalidate topology.
- `FoliageComponent`: owns placement/resource lifetime, source-change tracking,
  chunking, atlas references, motion uniforms, distance selection, and diagnostic
  `stats`. Generated resources are disposed on detach; late atlas promises cannot
  repopulate a detached or superseded component.
- `foliageWarmup.js`: prepares hidden detail variants for the ordinary main
  framebuffer. GI and post-processing own their pass variants: Three reads live
  MRT state during asynchronous node construction, so temporarily installing an
  MRT for compilation can produce an incorrect graph and black GI. Temporary
  visibility is restored before awaiting. Resources being compiled are retained
  through reshape/detach and disposed when the outstanding compile releases them.

## Validation

Run `npm run test:foliage` for geometry, scatter, runtime, authoring, and actual
Terrain attachment tests. These include disabled/deleted colliders, module
teardown/re-enable, shared matrices across detail levels, world-space entity
bounds, live terrain reseating, and Terrain's canonical grid dimensions.

Start a fresh `npx vite --host 127.0.0.1 --port 5335 --strictPort`, then run the
GPU tests sequentially:

```text
npm run smoke:foliage
npm run smoke:foliage-surface
npm run smoke:foliage-ui
npm run smoke:impostor-lighting
node scripts/run-gpu-page.mjs http://127.0.0.1:5335/scripts/gi-gpu-smoke.html 70000
npm run preview:foliage-trees
npm run preview:foliage-wind
npm run profile:foliage
```

The foliage runners create isolated Chromium profiles. For the generic runner,
set `GPU_SMOKE_PROFILE` to a fresh temporary directory if another Chrome profile
is already in use. The GI fixture enables active SRC explicitly and waits for
the irradiance dispatch; a field allocation alone does not establish lighting.
Source ground, wall and emitter meshes are hidden during receiver comparisons,
so their own bright pixels cannot impersonate foliage GI reception. Both captures
use the same compiled material/light graph; a zero irradiance texture is the
control for the real positive field. Removing/re-adding the GI light rebuilds
asynchronous variants and can measure compiler readiness instead of lighting.
Manual render-target captures wait for foliage warmup while the engine loop is
still running, including after moving into the impostor tier. Stopping first
prevents queued preparation from completing and can falsely report zero GI
reception while the irradiance texture itself contains valid light.

Editor verification drives the actual Terrain preset button, module persistence,
density edits, entity surface picker, species presets, real keyboard undo/redo,
and scene reload. Production editor and player builds are also checked. The
repository's broader script-types test retains 17 existing unrelated failures;
the added Foliage registration checks pass.
An unrelated missing array bracket in `architectureEnvironment.js` was also
corrected when it blocked every module-index import during final verification.

GPU measurements and screenshots are written to `artifacts/foliage/`. The
component's `drawCalls` statistic counts selected shared batches before renderer
frustum rejection and excludes extra shadow/GI passes. CPU update timing is
not GPU frame time or an FPS guarantee. Initial procedural generation, instance
uploads and atlas baking have a separate construction cost; this implementation
does not promise hitch-free authoring of maximum-size layers.

### Regression evidence

The surface gate drives the actual production vertex shader, using both a small
uniform-buffer instance batch and a 1,100-instance attribute batch. Twenty
consecutive matrix repacks and draw-count changes preserve roots and radial
blade distances within 0.000006 m. Its served `--old-matrix` arm restores the
previous static/per-object wind reader and fails with a 1.231 m error. This
catches the one-frame towering-grass regression without waiting for it to settle.

The generated-geometry motion gate separately checks 24 consecutive repacks at
capacities 4 and 1,100: grass arc-length error stays below 0.5 micrometres. Its
old rigid-rotation arm fails by 7.61 cm. Flower heads move 15.7 cm while changing
shape by less than 1.5 micrometres; tree roots and branch joints stay attached,
with separate leaf flutter, branch sway and rotating normals. These measurements
establish deformation continuity, not a physical simulation of wood or stems.

The main-render impostor gate uses the component's actual cloned material.
It verifies `alphaTest = 0.35` and compares the cutout with an opaque rectangle.
Testing only the GI override would miss this failure: that override explicitly
copies the alpha threshold even when the main material clone loses it. Near
leaf geometry, native shadows, and all five albedo/normal atlas pairs also have
GPU coverage checks. Scene wind edits reach an already-compiled blade, and zero
scene force and gust return it to rest.

Far wind preserves undeformed atlas coordinates while moving the billboard's
geometry and GI positions. The final regression shifts the tip by 6.9 pixels while
the root strip moves 0.75 pixels and 98.9% of the cutout coverage remains; restoring
the previous projection leaves the silhouette stationary and fails the check.
Full integration also verifies positive GI changes with the source meshes hidden
(31,202 near foliage pixels and 44,632 far foliage pixels on the final fixture).

`smoke:impostor-lighting` compares absolute near/far RGB, including the actual
4-by-64 grass atlas with dark authored color and low ambient light. The neutral
bake uses PI irradiance to avoid applying Lambert's factor twice, retains Three's
already face-correct normal, and pads transparent border RGB/normals within each
tile without changing alpha. Each previous defect independently fails the gate.
Controlled grass matches ambient RGB within 1.3% and directional RGB within
6.1%. Existing in-memory atlases need regeneration after these bake changes.

`scripts/foliage-wind-preview.html` provides grass, flowers, oak, birch and pine
under calm, steady, gusty and strong Scene wind, with a direction control.
`preview:foliage-wind` records grass/flower/oak WebM clips and stills in
`artifacts/foliage/wind/`; each clip switches from a breeze to force 10 / gust 10.

### Camera-motion performance

`profile:foliage` recreates the captured 50 m scene with 7,500 grass plants,
2,000 flowers and 37 trees at 1300 x 724, DPR 1 and MSAA 4. It compares the
previous cell/draw strategy with the current one using identical current tree
geometry and shaders; source hashes must remain unchanged between runs. Both
arms retain every authored plant. Measurements count frames after actual engine
renders and verify that the rendered camera changes throughout a full sweep.
GPU timings are fresh timestamp-query samples, separate from CPU and presented
frame intervals. The isolated browser is uncapped to expose rendering headroom;
this is not a measurement of the editor shell or a universal hardware guarantee.

The original captured scene has no active GI component. Set `FOLIAGE_GI=1` and
`FOLIAGE_ARMS=current` for an explicitly active SRC GI arm, which records its
own field/gather state, nonzero irradiance readback and actual scene wind configuration. Reports and images
are under `artifacts/foliage/performance-*`; use mean, P95 and worst frame time,
not a stationary FPS reading alone. The 120 FPS budget is 8.33 ms per frame.
Initial generation and pipeline preparation are reported separately from steady
camera motion. The generic GI fixture also remains mandatory after TSL changes.

Final measured runs on 2026-09-10 used the same production source hash
`cd2eccab830a0eb7c6e3f0179a139c0c9e549e662831d231dfb37e7217b2f8ac` and
an NVIDIA Lovelace adapter (the browser did not expose its model). These are
isolated benchmark results, not a guarantee for every scene or GPU.

| Camera sweep | Average FPS | P95 frame time | Worst frame | Frames above 8.33 ms |
|---|---:|---:|---:|---:|
| Previous cell/draw strategy, warm, GI off | 151.9 | 10.4 ms | 16.3 ms | 206 / 1,216 |
| Current strategy, first, GI off | 206.7 | 7.1 ms | 13.0 ms | 23 / 1,241 |
| Current strategy, warm, GI off | 205.8 | 7.1 ms | 11.9 ms | 30 / 1,647 |
| Current strategy, first, active SRC GI | 127.9 | 18.5 ms | 214.4 ms | 170 / 769 |
| Current strategy, warm, active SRC GI | 138.5 | 16.2 ms | 125.6 ms | 248 / 1,108 |

Both current warm averages exceed 120 FPS, but neither establishes a strict
120 FPS minimum. Ordinary motion misses the budget in 1.8% of measured frames;
the active-GI stress case still has substantial frame-time spikes.
All current timed windows have zero shader builds or synchronous pipeline
creation. Active GI is verified by about 625,000 nonzero irradiance channels
and actual ray, deposit and gather dispatches. Its 25 fresh warm GPU samples
average 5.3 ms; this is distinct from presented frame intervals. Remaining long
frames include GI pre-render/screen-chain work, GPU queue submission, and pauses
without a recorded owner. The upload fix removes the repeated large foliage
transfers; it does not prove those remaining spikes solved. All authored plants
and shadows remain enabled in the final timings.

Full reports retain intervals, upload/compile activity and GPU samples:
`artifacts/foliage/performance-isolated-{legacy,current}.json` and
`artifacts/foliage/performance-isolated-current-gi.json`.
The final CPU suite passes 60 tests; full foliage, surface, editor UI, impostor
lighting and portable-eight-buffer GI smoke tests pass, as do editor/player
production builds. Tree stills and wind clips were regenerated from the final
production geometry and shaders.
