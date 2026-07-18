# GI / SDF Handoff — 2026-07-16

## Goal and non-negotiable requirements

The requested end state is the best practical fully dynamic global illumination
for this WebGPU engine while retaining roughly 60 FPS on a desktop GPU.

The user has repeatedly clarified that the implementation must:

- Treat directional, point, spot, and emissive-material sources as one GI system.
- Keep emissive sources contributing even when they are outside the camera frame.
- Produce actual distance-field ray-traced soft visibility, not a blurred shadow map.
- Update moving objects and lighting in real time without 100–200 ms CPU stalls.
- Remain stable under camera rotation and camera distance changes.
- Smoothly accumulate multi-bounce illumination instead of visibly switching fields.
- Exclude editor gizmos, helpers, selection meshes, and GI debug meshes.
- Prefer visual iteration over writing a large test suite.
- Eventually exploit Virtual Geometry/Nanite-style data if it helps voxel/SDF quality.

The current implementation is still work in progress. The last source build passes,
but the newest direct material-space SDF shadow replacement has **not yet been
visually verified by the user**.

## Worktree warning

The worktree is heavily dirty and contains changes from multiple sessions. Do not
reset or discard unrelated files. Relevant modified/new GI files include:

- `src/modules/gi/GISystem.js`
- `src/modules/gi/GlobalIlluminationComponent.js`
- `src/modules/gi/giCompute.js`
- `src/modules/gi/giDeferred.js`
- `src/modules/gi/voxelizer.js`
- `src/modules/gi/gpuVoxelizer.js` (new)
- `src/modules/gi/sdfField.js` (new)
- `src/modules/gi/dfShadows.js` (new/currently rewritten)
- `src/modules/gi/index.js`
- `src/engine/Engine.js`
- `src/editor/panels/ViewportPanel.jsx`

There are also unrelated editor/test changes and untracked ReSTIR smoke files. Do
not assume those belong to this GI implementation.

## Current architecture

### Automatic camera-centered clipmaps

`GISystem.computeAutoClipmapLayout()` now derives 1–3 cubic cascades from the active
camera FOV, aspect, a capped 128 m useful GI range, and a coverage margin.

- Cascade world scale is 4×.
- Clipmaps are centered on camera position, not camera forward direction.
- Rotating the camera therefore does not recenter or revoxelize the world.
- Translation recenters in probe-spacing increments with a dead band.
- Recentering is time-sliced and atomically publishes new static voxel data.
- Probe irradiance is shifted so surviving probes retain history.

The component's legacy manual size/follow/cascade settings are effectively replaced
by automatic coverage.

### Static and dynamic voxelization

Static geometry still uses the CPU voxelizer, but it is asynchronous/time-sliced:

- `voxelizeRegionAsync(..., timeSliceMs: 2)` yields during work.
- Volumes are voxelized sequentially rather than all at once.
- New grids are built off to the side and published atomically.
- This was added to remove the editor-drag CPU spikes and partial-grid flashes.

Dynamic objects use `gpuVoxelizer.js`:

- A shared `DynamicVoxelPool` stores object-space triangles and per-mesh matrices.
- Capacity is 64 meshes / 32,768 triangles.
- Triangle data uploads only when the dynamic set changes.
- World matrices upload each active frame.
- Each live voxel grid is recomposed as `static grid + dynamic triangle splats`.
- The finest cascade is prioritized every moving frame; coarser cascades catch up.
- Small movers are skipped in cascades where they are sub-voxel.

Motion is detected by world-matrix hashing every 10 frames. A moved mesh is promoted
to the GPU dynamic layer and later returned to the static bake after settling.

### Editor-only exclusion

GI traversal and the deferred normal/depth prepass exclude editor content:

- `voxelizer.js` rejects objects on `EDITOR_LAYER`.
- It also rejects `editorOnly` and GI debug objects/subtrees.
- `ViewportPanel.jsx` puts transform controls, helper meshes, pickers, and similar
  editor objects on `EDITOR_LAYER`.
- `GISystem.#runDeferred()` disables `EDITOR_LAYER` and temporarily hides editor-only
  subtrees.

This addressed gizmos and editor overlays appearing in voxel GI.

### Unified emission source collection

`GISystem.#collectEmissionSources()` gathers:

- The primary directional light separately.
- Additional directional lights.
- Point lights.
- Spot lights.
- Emissive mesh proxies.

Emissive meshes are periodically rescanned through `readMeshGIColors()`. A bounded
sphere proxy is derived from each emissive mesh's world bounding sphere and projected
area. Sources are selected per clipmap by influence/strength, including sources
outside a volume whose range overlaps it. This is intended to keep off-screen and
slightly off-volume emitters contributing.

Up to `MAX_LOCAL_LIGHTS = 8` sources are packed into one interleaved `lightData`
storage buffer. Each source uses four vec4 records:

1. position + range
2. color + type
3. direction + outer cone cosine
4. inner cosine + decay + source radius

### Storage-buffer limit fix

The initial compute graph used 15 storage buffers and failed on the WebGPU default
limit of 8:

> The number of storage buffers (15) in the Compute stage exceeds the maximum
> per-stage limit (8).

This was fixed without requesting non-portable device limits:

- Probe rays, irradiance, scratch, ray directions, and texel directions are packed
  into one `probeData` buffer with explicit offsets.
- Four local-light buffers are packed into the single `lightData` buffer above.
- Main GI compute now stays at the portable 8-storage-buffer limit.
- The temporary custom `requestDevice(requiredLimits)` attempt was removed from
  `Engine.js`.

Do not split these back into separate storage buffers.

This portability rule is also recorded in the root `AGENTS.md`, which must be
read before future GI work. The limit applies to the fully composed TSL graph:
per-cascade helper bindings multiply when three cascades are used by one
deferred compute pass. Always runtime-validate GI changes with
`scripts/gi-gpu-smoke.html`; a Vite build cannot detect binding-count failures.

### Live SDF generation

`sdfField.js` builds an unsigned distance field from the **live** voxel occupancy:

- Occupied voxels seed nearest coordinates.
- A 3D jump flood sequence propagates nearest seeds.
- A second unit-jump pass repairs small diagonal JFA holes.
- The complete field is published atomically into a filterable half-float 3D texture.
- `SDF_MAX` is 16 voxels.

This replaced a slow chamfer relaxation that took many frames to converge and left
moving-object shadows trailing behind.

An important sampling correction was made: a world point converted to voxel-space
already has texel-center coordinates, so SDF sampling uses `g / dims`, not
`(g + 0.5) / dims`. The extra half voxel shifted traces into neighboring cells.

### Radiance injection and probes

`giCompute.js` currently does:

1. Cached direct-light injection into occupied voxels.
2. SDF sphere-traced visibility for sun and selected local/emissive sources.
3. Radiance combination:
   `albedo * (direct + probe feedback) + emissive`.
4. Alpha-weighted radiance mip pyramid construction.
5. Probe ray marching and octahedral irradiance integration.
6. Probe temporal accumulation with user hysteresis.

Probe feedback gain was reduced from 0.95 to 0.6. The old gain made nearly white
rooms integrate toward extreme overexposure.

Two occupancy checks between a surface voxel and its selected feedback probe reject
obvious probe transport through thin blockers.

### Visible GI gather

Visible diffuse GI is evaluated once at half resolution in `giDeferred.js`, then
edge-aware reconstructed in materials.

There were two attempted gathers:

- Sparse probe-field final gather: camera-stable, but produced giant rectangular
  probe-cell patches on walls and washed-out lighting.
- Dense voxel cone gather: now active again via `nodes.coneDiffuseFn(P, N)`.

The active cone gather:

- Uses the mipmapped 3D radiance atlas.
- Uses six diffuse cones in the inner cascade and cheaper lite cones outside.
- Uses a fixed world-space start phase (`0.65 * voxelSize`).
- Removed hashed per-voxel jitter because it produced rectangular/diagonal patterns
  that changed as receiver positions crossed voxel boundaries.
- Contains accumulated probe feedback inside the voxel radiance, so probes are not
  directly visible as a coarse final gather.

The old screen temporal history was disabled at this point in development because
its linearly filtered geometry history produced false reprojection matches, diagonal
stripes, and slowly fading trails while rotating. It was briefly restored with
nearest-filtered geometry history, then removed again after forward/backward camera
motion still reproduced diagonal bands. The current implementation has no screen
history.

### Shadows: iteration history and current state

Several shadow implementations were tried:

1. **Half-resolution screen-space SDF trace**
   - Produced view-dependent patterns, snapping, black failures, and diagonal trails.
   - Removed.

2. **World-aligned 3D cached visibility textures**
   - Camera-stable in principle.
   - In practice the cached visibility voxel size became giant blurred rectangular
     shadow patches, and most useful shadows disappeared.
   - Fully removed from allocation, warmup, and update scheduling.

3. **Current implementation: direct material-space cascaded SDF trace**
   - Implemented in the latest `dfShadows.js`.
   - Replaces the primary directional light's normal shadow lookup through
     `light.shadow.shadowNode`.
   - Traces from `positionWorld + normalWorld * bias`.
   - Chooses the finest containing SDF cascade and falls back to coarser cascades as
     the ray exits.
   - Uses up to four SDF textures, 32 maximum sphere-trace steps, a safety factor,
     and the minimum-distance / distance ratio for soft penumbrae.
   - Sun rotation changes only a direction uniform; it does not rebuild a shadow
     texture.
   - Shadow sampling becomes active after the first four SDF cascades are published.

**Critical:** this newest version only passed `npm run build`. It has not yet been
visually tested or runtime-WebGPU-validated after a clean reload. The previous user
screenshot was from the removed 3D visibility-cache implementation and showed almost
no shadows plus giant blurred rectangles.

Potential risks in the current direct material trace:

- It may be too expensive at high resolution/overdraw.
- Four extra sampled 3D textures may approach the per-stage sampled-texture limit on
  complex materials.
- TSL/WGSL pipeline creation is runtime-only; the Vite build does not prove shader
  validity.
- Thin geometry still inherits voxel/SDF limitations.

If direct per-material tracing is too expensive, the next fallback should be one
deterministic full-resolution screen compute trace using a full-resolution G-buffer,
with no temporal history and no stochastic phase. Do **not** restore the coarse 3D
visibility cache.

### Engine resize changes

`Engine.js` gained queued WebGPU-safe renderer resizing:

- Animation encoding pauses.
- Submitted GPU work is drained.
- Canvas size and DPR are applied atomically through `setDrawingBufferSize()`.
- GI pauses allocation/update while `_resizeInFlight` is active.

This avoided destroyed texture/attachment generations during renderer or dock resize.

## Latest verification

Last command:

```text
npm run build
```

Result: success, 2242 modules transformed.

Only normal Vite warnings remained:

- `node:fs` / `node:path` externalized for browser compatibility.
- Large chunk warnings.

No broad automated test suite was run because the user explicitly preferred visual
testing. The latest material SDF shaders still require a clean live reload and console
inspection.

## Known remaining problems / incomplete work

1. **Latest direct SDF shadows are unverified.**
   Test after a full reload, not only HMR. Inspect WebGPU validation output.

2. **GI visual quality was still unacceptable before the last changes.**
   Previous symptoms included:
   - Shadows nearly absent.
   - Giant blurred rectangular light/shadow patches.
   - Earlier diagonal stripes under camera rotation.
   - Earlier drastic lighting transitions with camera distance.
   - Earlier overexposure in white rooms.

3. **Local/emissive direct visible shadows are not a separate full-resolution
   analytic pass.**
   They are SDF-shadowed during per-voxel radiance injection and then seen through
   cone-traced indirect lighting. This is camera-independent and supports off-screen
   emitters, but sharp first-bounce local-light penumbrae are limited by voxel
   resolution.

4. **`traceEmissiveDirect` in `giCompute.js` is currently unused.**
   It was removed from the visible screen gather because sampling it on a changing
   half-resolution screen grid caused camera-dependent patterns. It can be deleted or
   redesigned into a world-aligned cache.

5. **Probe visibility is incomplete.**
   There are no DDGI-style depth moments/Chebyshev visibility values. The current
   occupancy checks only reduce obvious feedback leakage.

6. **Thin surfaces remain difficult.**
   The SDF is unsigned and voxel-derived. Thin walls, foliage, and sub-voxel geometry
   can leak or disappear. Screen-space near-field traces or per-mesh SDFs are still
   needed for a Lumen-like solution.

7. **Virtual Geometry is not integrated.**
   The user suggested reusing its Nanite-like hierarchy. A promising next step is to
   use Virtual Geometry cluster bounds/coarse triangles as voxelization/SDF input,
   avoiding full-resolution CPU geometry traversal and improving stable conservative
   coverage. No such integration exists yet.

8. **No post-change GPU timing exists.**
   Before the direct material shadow rewrite, simple screenshots showed roughly
   4–5 ms GPU, but that is not evidence for the current shader. Profile after shaders
   compile and after GI convergence.

9. **Historical comments need context.**
   The module overview now reflects the history-free screen resolve and world-space
   temporal caches. Older sections in this handoff describe intermediate history/SDF
   states and are explicitly marked as superseded. Some `giCompute.js` comments may
   still describe the abandoned probe final gather.

## Recommended immediate debugging sequence

1. Full reload the editor to avoid partially applied HMR shader graphs.
2. Confirm no WebGPU validation errors or sampled-texture-limit errors.
3. Check whether `_dfShadowReady.value` reaches 1 after the first four `sdfReady`
   flags become true.
4. Temporarily return the raw direct-SDF shadow factor as material color if shadows
   are still absent. This separates:
   - custom Three shadow-node wiring,
   - wrong sun direction,
   - empty/bad SDF,
   - excessive bias/threshold.
5. Verify direction by flipping `sunDirToLight` once; Three's light convention here is:
   - `getWorldDirection()` gives local +Z in world space,
   - the component aims lights down local -Z,
   - therefore +Z is the receiver-to-source direction.
6. Use the existing `voxels` debug view and add an SDF slice/debug view if needed.
7. Profile the direct material trace. If it is over budget:
   - reduce shadow steps from 32 to 24 first,
   - reduce shadow cascades from 4 to 3 if texture pressure exists,
   - then consider one full-resolution deterministic compute trace.
8. Once direct shadows work, tune softness/bias before changing architecture:
   - receiver bias: currently 1.75 selected-cascade voxels,
   - hit threshold: 0.28 voxel,
   - softness: `0.025 + shadow.radius * 0.015`, clamped to 0.12.
9. Re-check GI with bounce = 1, sky intensity = 1, reflections disabled, and a simple
   Cornell-box-style scene before adding more features.

## What not to reintroduce

- Do not request a 16-storage-buffer device limit; keep portable 8-buffer packing.
- Do not make editor gizmos voxelizable.
- Do not re-enable stochastic screen history until reprojection is proven artifact-free.
- Do not use the removed coarse 3D visibility cache for final shadows.
- Do not return visible diffuse GI to the sparse probe lattice without proper DDGI
  visibility and a better reconstruction strategy.
- Do not synchronously revoxelize all cascades during an editor drag.

## Continuation update — Stage 1 triangle proxy scene implemented

The follow-up work completed GI Plan Stage 1 without changing the active
lighting result. The stable voxel GI + shadow-map direct-light baseline remains
the default.

### New proxy-ray subsystem

`src/modules/gi/rayProxy.js` now provides:

- Topology-preserving meshopt fallback proxies targeting roughly 500–2000
  triangles (`LockBorder`; no sloppy/prune simplification).
- Reuse of Virtual Geometry's coarsest **complete** root cut. This cut is
  object-space and camera-independent.
- Per-geometry cached threaded BLASes using preorder nodes and miss links.
- A TLAS over rigid instances that refits current world transforms without
  rebuilding BLAS data.
- CPU reference tracing for verification.
- One vec4-addressed packed buffer containing TLAS nodes, instance references,
  BLAS nodes, triangles, and inverse instance transforms. Stage 2 can therefore
  add triangle traversal with one storage buffer instead of breaking the
  portable eight-buffer limit.
- Skinned meshes remain excluded.

### Import cache and Virtual Geometry bridge

- New GLB-unpacked `.geom` assets write a content-hashed
  `.geom.meta.giRayProxy` cache during import.
- `geometryAsset.js` loads this optional sidecar into geometry user data.
- The ray scene validates the source hash, so geometry edits safely invalidate
  stale proxies and fall back to rebuilding.
- Geometry `.meta` sidecars now ship in player exports.
- Virtual Geometry exposes `getVirtualGeometryRecord()` and
  `getCoarsestClusterIndices()`, and notifies GI when a DAG becomes ready.

### Opt-in runtime/debug wiring

The Global Illumination component has:

- `Triangle Ray Proxies (experimental)` / `rayProxies`, default **off**.
- `ray-proxies` debug view, showing the exact proxy triangles in cyan wireframe.

Enabling this currently builds and refits the proxy scene only. It does **not**
replace the voxel probe tracer yet, so disabling the flag is the one-line
revert and the rendered GI baseline is unchanged.

### Verification

Passed:

```text
node scripts/test-gi-ray-proxy.mjs
node scripts/test-gi.mjs
npm run build
npm run build:player
```

The focused ray-proxy check covers randomized threaded-vs-brute-force rays,
transformed meshes, a moving rigid instance after TLAS refit, import-cache
selection, GPU packing shape, and Virtual Geometry's coarsest root cut.

### Next step

GI Plan Stage 2 is now the next implementation: add a GPU threaded triangle
tracer to the existing probe trace pass, shade triangle hits from the current
voxel radiance cache, and keep the voxel marcher behind an A/B flag. Do not
route direct shadows or per-pixel screen rays through this proxy scene.

## Continuation update — Stage 2 and probe visibility implemented

### Triangle probe traversal

The probe trace compute pass now has an opt-in threaded TLAS/BLAS path:

- `rayProxies` builds and maintains the packed proxy scene.
- `triangleProbeRays` switches probe transport between triangle rays and the
  existing voxel marcher at runtime.
- Triangle hits sample the existing voxel radiance atlas, so injection,
  temporal integration, and final gathering keep the same lighting pipeline.
- Topology uploads are versioned. Transform-only changes upload refitted TLAS
  nodes and inverse instance records rather than the full proxy scene.
- Direct shadows and per-pixel lighting do not use proxy rays.

The actual WebGPU smoke path ran successfully with triangle rays enabled. The
measured probe-update delta in the small smoke scene was effectively neutral
(roughly 0.5–0.6 ms for either path at 640×360).

### Directional probe visibility

Stage 3 quality item 1 is implemented:

- Probe rays now return radiance plus hit distance. Misses return the clipmap
  diagonal as their unoccluded distance.
- Integration stores directional first and second distance moments beside
  irradiance in the existing packed `probeData` storage buffer.
- Visibility uses a narrower directional lobe than irradiance and a shorter
  temporal history so moving blockers react promptly.
- Multi-bounce feedback evaluates a Chebyshev visibility bound from the
  selected probe toward the receiving voxel, with bias and light-bleed
  reduction.
- The former two binary occupancy taps were removed.
- Clipmap scrolling preserves both irradiance and visibility histories;
  teleports seed unoccluded maximum-distance moments.
- No new storage binding was added.

`npm run build` passes after this change. Visual verification is intentionally
left to the editor scene rather than expanding the test suite.

### Next development item

Continue Stage 3 with PCSS/contact-hardening sun shadows on Three's existing
shadow map. Keep it separate from the parked SDF direct-shadow experiments.

## Continuation update — Stage 3 quality passes implemented

### PCSS directional shadows

`src/engine/pcssShadowFilter.js` adds a native WebGPU/TSL PCSS filter:

- Blocker search reads the directional light's real depth map, so static,
  dynamic, and skinned shadow casters all participate.
- Average blocker distance drives contact-hardening penumbra growth.
- A fixed light-space Vogel pattern avoids temporal noise and camera-space
  grain.
- Search and filter radii are bounded to prevent extreme blur/cost.
- Reversed-depth renderers are handled explicitly.

The Light component now exposes `PCSSShadowMap` under `Map Type`.
`Radius / Light Size` is interpreted as directional source radius in world
units for PCSS. Switching shadow-map type rebuilds the light so Three cannot
retain an already-compiled shadow filter. Reverting is a single inspector
selection back to PCF/PCFSoft.

### Cone-trace moiré cleanup

The existing deferred resolve now performs a deterministic four-neighbour
current-frame filter before optional history:

- Neighbours are weighted by world-normal and view-depth agreement.
- Coplanar low-frequency GI variation is smoothed.
- Silhouettes and unrelated geometry remain separated.
- AO blends only partially so contact definition is retained.
- No new texture, binding, or dispatch was added.
- At this stage screen temporal history remained disabled; the later strict
  world-space history pass supersedes that state.

`npm run build` passed after the completed Stage 3 code. PCSS and the moiré
filter are intentionally awaiting visual editor review rather than another
automated test sweep.

## Continuation update — bounded lighting convergence and leak cleanup

The former runtime treated lighting/geometry changes as immediate cache
invalidations. One selected volume could execute a full per-voxel direct
shadow march, every JFA SDF pass, radiance mip publication, and probe update
in the same frame. Multiple pending volumes could also be served together.
This explained both the visible lighting snap and movement GPU spikes.

The runtime now behaves as an asynchronous accumulated field:

- Direct-light injection uses eight interleaved voxel chunks. Interleaving
  avoids a contiguous update plane moving through the scene.
- Each chunk blends toward the latest direct-light target.
- The radiance buffer independently applies a time-based exponential blend.
- New `Lighting Response (s)` GI property defaults to `0.5`; higher values
  spread convergence farther in time.
- Only one clipmap volume receives GI maintenance per frame.
- JFA SDF snapshots advance one pass per service instead of all passes in one
  frame.
- When direct lighting and SDF work are both pending they alternate, bounding
  the heavy work submitted in a frame.
- The last complete SDF remains published while the next moving-object
  snapshot is built.
- Sky/environment GI changes also interpolate and request bounded probe
  convergence.

Memory/rebuild fixes:

- Every retired volume now disposes its compute nodes before releasing its
  storage attributes and 3D textures.
- Storage attributes are explicitly removed from the WebGPU renderer so their
  GPU buffers are destroyed promptly.
- Deferred compute nodes are disposed when rebuilt while their stable
  textures are retained.
- Shared triangle-ray and dynamic-voxel buffers are released on disable/final
  disposal.
- Camera aspect is quantized into stable coverage buckets, preventing dock
  resizing from generating a stream of new clipmap allocations and shader
  graphs.
- Experimental mesh-SDF/capsule baking no longer runs while DF shadows are
  disabled.

Focused validation passed:

```text
npm run build
node scripts/test-gi.mjs
```

The next verification should be visual: drag a light continuously, move a
rigid object, translate the camera through a clipmap recenter, and watch
process/GPU memory across repeated viewport resizing.

## Continuation update — full resolved-GI temporal accumulation (superseded)

The asynchronous voxel/radiance updates removed most lighting snaps, but a
clipmap publish/recenter could still replace the final cone-traced result in a
single frame. AO was also only spatially filtered and therefore changed
immediately.

This screen-reprojection experiment accumulated the half-resolution GI resolve before
publication, but it is no longer active:

- `Lighting Response (s)` drives an exponential final-history blend as well as
  the underlying direct/radiance convergence.
- Clipmap swaps/recenters, cone radiance, sky contribution, and AO therefore
  share one gradual visual response.
- History is reprojected through previous camera matrices into world space.
- Previous geometry depth/normal is nearest-filtered; interpolated geometry
  history had been the source of plausible false matches and diagonal trails.
- Strict world-position and world-normal checks reject moving objects,
  silhouettes, disocclusions, and unrelated surfaces.
- The deterministic current-frame spatial result is accumulated, not the raw
  cone sample, so stable surfaces retain the moiré cleanup.
- AO uses the same accepted history with a slightly faster response to preserve
  contact definition.

Focused validation passed:

```text
npm run build
node scripts/test-gi.mjs
```

The remaining verification is visual: orbit and translate the camera across
clipmap boundaries, then move an occluder and confirm that indirect lighting/AO
fade smoothly on static receivers without trails following the moving object.

## Continuation update — world-space-only temporal GI and memory reduction

The screen-history experiment above reproduced the reported failure modes:
forward/backward camera motion caused history rejection snaps and diagonal bands.
It also added two half-resolution history textures and an extra copy dispatch.
Screen temporal reprojection has therefore been removed completely.

Current temporal behaviour is world-space:

- Cascade selection uses continuous camera distance rather than `gridMin`, so an
  atomic clipmap recenter cannot move the cascade boundary in one frame.
- A recenter fades the old cascade into its coarser parent while staging the new
  cache, publishes content/origin/probe shift together, then fades the new cascade
  back in through `Lighting Response (s)`.
- Radiance RGB and voxel opacity use the same exponential accumulation. AO therefore
  changes gradually with moving geometry without a camera-history buffer.
- Direct-light chunks write an invisible staging cache. Only a complete eight-chunk
  generation publishes, preventing every-eighth-voxel stripe patterns.

Memory/compile reductions:

- The global per-cascade JFA SDF was removed from GI injection. Indirect visibility
  now uses a bounded occupancy march; the radiance mip/cone integration supplies the
  soft result.
- This removes two full vec4 seed buffers, the SDF 3D texture, and the seed/jump/
  publish compute pipelines from every cascade.
- Automatic coverage is capped to three useful cascades and 128 m reach instead of
  allocating a fifth cascade solely because the editor camera far plane is 2000 m.
- Deferred history textures are gone, experimental mesh-SDF resources allocate only
  when enabled, and final deferred resources are explicitly disposed.

First-bounce color bleeding:

- Three renders directional lights from `light.position` toward `light.target`;
  `Object3D.getWorldDirection()` does not represent that convention.
- GI now derives the same target-based direction as the visible light.
- Cached outgoing voxel radiance remains
  `surfaceAlbedo * (incidentDirect / PI + multiBounce) + emissive`, so a lit red
  wall emits proportionally stronger red indirect radiance as incident light
  increases.

Focused validation passed:

```text
npm run build
node scripts/test-gi.mjs
```

A full editor reload is required before visual/memory verification because the
storage-buffer layouts and compute graphs changed.

## Continuation update — moving AO, visible first bounce, and retained memory

Moving-object AO now keeps one continuous representation throughout the
dynamic-to-static transition:

- Transform motion is polled every two frames while preserving the existing
  roughly one-second settle delay.
- A stopped object remains in the dynamic voxel pool while its settled pose is
  baked into every static cascade.
- The dynamic copy is removed only after all cascade bakes complete, avoiding
  the missing-object/present-object opacity jump that made AO redraw suddenly.
- The dynamic pool is rebuilt only when its object set changes.

First-bounce color bleeding received two important corrections:

- Sampled surface radiance is converted back to irradiance with the missing
  hemispherical `PI` factor. Previously the reflected contribution was
  effectively divided by `PI` twice and was easily lost beside sky light.
- The diffuse cone ring is now 60 degrees from the surface normal instead of
  45 degrees, covering common wall-to-floor and wall-to-ceiling transport.
- A brightly lit red wall should therefore inject proportionally stronger red
  irradiance into nearby receivers.

Concrete memory-retention and allocation paths were reduced:

- Exact triangle ray traversal is compiled only into the inner cascade. Outer
  cascades keep the cheaper voxel probe path.
- Outer cascades use 32-cubed voxel fields and identical four-axis probe
  layouts, reducing storage and allowing compute-pipeline reuse.
- The ray-proxy geometry cache is bounded to 24 entries.
- Moving TLAS refits update matrices and bounds in place rather than allocating
  replacement arrays every frame.
- Emissive/local-light discovery is cached and polled every six frames.
- GI teardown now clears retained dynamic objects, emissive sources, local
  lights, mesh lists, ray-scene state, proxy cache, and uploaded layout state.

Focused validation passed:

```text
npm run build
node scripts/test-gi.mjs
node scripts/test-gi-ray-proxy.mjs
git diff --check
```

A full editor reload is required before checking the new GPU layouts and memory
plateau. Live browser memory profiling was not available in this session, so a
continued steady rise after reload should be classified by whether it is the JS
heap, renderer textures/buffers, or total process/GPU memory.

## Continuation update — direct-light-dependent indirect intensity

The remaining first-bounce problem was in incident-light visibility rather
than the cone transport:

- The direct-injection shadow test used fixed-distance samples. A sample could
  step completely over a one-voxel wall, so visibly shadowed and exposed
  surfaces received the same cached direct irradiance.
- Direct injection now uses conservative 3D grid traversal and visits every
  crossed voxel. Thin static and dynamic blockers therefore modulate outgoing
  surface radiance reliably.
- Static and dynamic voxel normals now preserve material sidedness in the
  previously unused high byte. BackSide normals are flipped and DoubleSide
  surfaces orient their injection normal toward each incident light, matching
  Three's visible material lighting.
- The light-facing normal is also used for the shadow-ray origin, preventing a
  visibly lit back face from either receiving zero energy or immediately
  self-occluding.

Focused validation passed:

```text
npm run build
node scripts/test-gi.mjs
git diff --check
```

A full editor reload is required because existing voxel-normal GPU buffers do
not contain the new sidedness flag.

## Continuation update — raster/GI light-state and energy parity

The on/off comparison revealed a separate primary-light lifecycle bug:

- The primary directional light was cached without revalidating effective
  Object3D visibility. Hiding or disabling it removed raster lighting while GI
  continued injecting the cached sun indefinitely.
- Primary and local GI lights now require the component, light, and every
  ancestor to be visible, plus positive intensity. The primary cache is
  validated every frame and periodically rescanned so reveal/hide operations
  work without relying on a component-change event.
- The direct cache changed from fixed-range RGB8 to RGBE8 in the same 32 bits.
  Low-energy reflected punctual light no longer quantizes to black, while
  bright near-field energy no longer clips at the old range.
- Point/spot attenuation now matches Three's visible light calculation,
  including its sub-one-metre inverse-square response and Hermite spotlight
  penumbra.

Focused validation passed:

```text
npm run build
node scripts/test-gi.mjs
node --check src/modules/gi/GISystem.js
node --check src/modules/gi/giCompute.js
git diff --check
```

Reload is required because the direct-cache packed representation changed.

## Continuation update — emissive receiver lighting and shadows

Emissive meshes previously illuminated cached surface voxels only so those
surfaces could bounce light onward. The visible receiver did not read its own
incident emissive term; raster point/spot/directional lights hid that omission
because Three shades them directly, but an emissive ceiling panel has no
corresponding analytic light node.

The direct-light sweep now publishes a second compact RGBE8 cache containing
only shadowed emissive-proxy irradiance:

- The existing world-space voxel DDA computes emitter visibility and shadows.
- The result follows the same staged publication and temporal response as the
  main direct cache.
- The visible GI gather samples the receiver's aligned surface voxel and
  converts cached `E/PI` back to irradiance.
- Raster lights are excluded from this receiver term, preventing their direct
  lighting from being counted twice.
- The two extra u32 fields are bounded per cascade and add roughly 2.5 MB at
  the default 64/32/32 cascade resolutions.

Focused validation passed:

```text
npm run build
node scripts/test-gi.mjs
git diff --check
```

A full reload is required because two GPU storage buffers were added per
cascade.

### Binding-limit correction

The first receiver lookup also read each cascade's albedo and normal buffers.
The combined three-cascade deferred compute therefore requested nine storage
buffers, exceeding WebGPU's portable per-stage limit of eight. Empty receiver
cache voxels are already exact RGBE black, so they serve as their own validity
mask. The lookup now reads only the emissive receiver buffer: three storage
bindings total across three cascades.

The initial one-buffer lookup still exposed nearest-voxel cells as large square
lighting regions. Receiver irradiance is now reconstructed trilinearly from
eight world-space voxel centres, with a short normal-axis search to find the
surface layer. Emissive lighting and shadows remain world locked but transition
continuously across voxel boundaries.

## Continuation update — emissive area accuracy and smooth publication

The emissive source proxy itself was still a single point at the mesh centre.
For a large ceiling panel that produced an inaccurate point-light silhouette:
objects blocking the centre ray could darken an entire receiver region even
when most of the panel remained visible.

- Emissive meshes now derive an oriented rectangular proxy from the two
  largest transformed bounding-box axes.
- A centre-weighted ray plus four stable off-centre rays integrate receiver
  cosine, emitter cosine, and independent voxel-DDA visibility across the
  panel. Keeping the centre ray prevents a centred blocker from falling
  between every area sample.
- Partial occlusion therefore produces a soft fractional shadow instead of
  one binary centre-ray result.
- The completed emissive shadow target no longer replaces the visible receiver
  cache atomically. A separate cheap full-volume compute blends it
  exponentially over subsequent service frames using `Lighting Response`.
- Initial/recentered data still publishes immediately while hidden by cascade
  staging/fade, preventing a refill-from-black delay.

Focused validation passed:

```text
npm run build
node scripts/test-gi.mjs
node --check src/modules/gi/GISystem.js
node --check src/modules/gi/giCompute.js
git diff --check
```

### Centred-occluder correction

The initial four off-centre area samples could all pass around a sphere placed
directly between a receiver and the middle of a ceiling panel. The area proxy
now retains a centre-weighted visibility ray, so that arrangement produces a
real partial shadow while the surrounding rays preserve soft area coverage.

Receiver reconstruction also no longer chooses the brightest point from its
short normal-axis search. It chooses the point with the strongest
normal-aligned occupied-voxel support, which preserves valid black shadow
values instead of borrowing an unoccluded neighbour. The normal and emissive
buffers use six storage bindings across three cascades, still below WebGPU's
portable limit of eight. Area-shadow rays start 0.6 voxel from the receiver,
close enough to retain nearby blockers without immediately hitting the
receiver voxel itself.

### Voxel debug-view correction

The voxel view was visually misleading rather than proving that interiors had
become occupied. It rendered 0.9-cell opaque cubes and stopped after the first
60,000 occupied linear indices, so adjacent surface samples appeared as solid
slabs and the cutoff appeared as rectangular or horizontal blocks.

The view now reads back the live composited GPU albedo grid, uses the packed
occupancy byte rather than any nonzero word, uniformly subsamples the full
grid when necessary, and renders 0.38-cell separated markers. Dynamic splats
are therefore included and empty space remains visibly empty.

### Enclosure and near-emitter visibility correction

Diffuse cones previously added their remaining sky term whenever their fixed
step loop ended. A default eight-step cone from the centre of the 64-voxel
inner cascade ends before reaching the clipmap boundary, so loop exhaustion
was incorrectly treated as an opening. Sealed rooms therefore remained
sky-lit and removing a wall produced little change.

- Diffuse sky is now added only after the cone demonstrably exits the clipmap.
- Inner diffuse traces use at least ten steps, enough to prove an escape from
  the centre of the default grid; 32-voxel lite cascades use at least eight.
- Residual sky transmittance uses stronger opaque-wall extinction so
  coarse-mip filtering does not turn one-voxel walls into translucent sheets.
- Geometry removal still fades through the existing radiance-opacity temporal
  blend, so opening a wall reveals the environment gradually.

Emissive visibility also no longer trims the final 1.5 voxels of every shadow
ray. That blanket exclusion allowed a ceiling close to an emissive panel to
be skipped. Rays now march to the source and ignore only emissive occupancy
at the endpoint; any non-emissive ceiling or wall immediately below it blocks
the light.

### Raster-direct shadow bypass and deferred receiver correction

The sealed-room screenshots were still dominated by Three's analytic direct
lighting, not the GI cache. `LightComponent` defaults `castShadow` to false,
and GI previously enabled a replacement shadow only when experimental DF sun
shadows were selected. Directional, point, and spot lights could therefore
shade through walls after the GI transport had correctly rejected them.

`Auto Direct Shadows` now defaults on for GI. While GI is active, visible
positive-intensity analytic lights receive normal shadow maps; the optional DF
node replaces only the primary sun lookup. Every light's original
`castShadow` and `shadowNode` values are restored when it leaves the active set
or GI is disabled.

The half-resolution receiver prepass also used a FrontSide-only override
material and inherited the renderer's current auto-clear flags. Back-facing or
double-sided objects could be absent from its depth/normal buffer, while stale
pixels survived until camera movement overwrote them. The override is now
DoubleSide with explicit depth writes, and the prepass forces color/depth clear
for its render before restoring the previous renderer state.

### Exact emissive source gate and material-pipeline invalidation

The shared default material could retain a render bundle compiled before the
custom GI light type entered the renderer library. Moving the camera happened
to invalidate that bundle, explaining why a default box acquired GI only after
camera motion. Adding/removing the GI scene light now marks every lit material
for recompilation immediately.

Coarse voxels also cannot represent a thin ceiling and an emissive panel when
both occupy the same endpoint cell. `Exact Emissive Visibility` is now a
default-on, bounded use of the triangle proxy scene independent of the
experimental triangle-probe transport:

- The oriented area proxy stores its third-axis half-thickness.
- Samples are moved from the bounding-box centre to the emitter face toward
  the receiver.
- One exact centre ray is evaluated only when the cheap voxel DDA reported
  clear visibility.
- A triangle hit within 2.5 voxels of the emitter gates the whole panel
  (ceiling/backing); a mid-path hit affects only the centre weight so ordinary
  object shadows remain soft.
- Direct caches are explicitly refreshed when proxy data first becomes ready.

Debug View now includes `gi-only`, which renders the resolved deferred GI
input without base color, raster lights, environment IBL, or material
emission.

The first exact-visibility build had a dead upload gate: proxy data was
uploaded only when both experimental triangle-probe flags were enabled, even
though `Exact Emissive Visibility` independently allocated and built the ray
scene. As a result the exact ceiling/backing ray stayed disabled and the
emissive receiver cache remained visibly unoccluded. `#syncRayDataUpload()`
now uploads whenever exact emissive visibility is enabled, while the separate
`rayTracingEnabled` uniform still keeps experimental probe transport opt-in.

### Empty-space connectivity and emitter removal

Treating every probe/cone miss as sky kept sealed rooms illuminated and made
opening a wall ineffective. The CPU voxel publish now runs a six-connected
boundary flood over empty cells and stores an exterior-connectivity bit in the
unused top bit of the packed normal word.

- Probe misses inject sky only when their origin is in boundary-connected
  empty space.
- Diffuse cones use the same receiver classification. Once an opening connects
  the room to the exterior, cone opacity decides which directions see sky; the
  cone no longer also has to reach the clipmap boundary within its finite step
  budget.
- Emissive area samples reject exterior-to-sealed-component transport before
  the normal DDA/exact visibility checks.
- The mask adds no buffer or binding and therefore stays within the portable
  eight-storage-buffer limit.

Emissive material changes now also carry a stable source signature. Changing
or disabling emission schedules a staged voxel rebuild so old emissive surface
radiance cannot remain baked after its proxy has disappeared.

### High-hysteresis convergence correction

The active Cornell test scene used probe hysteresis `0.97`. Runtime
invalidations requested a fixed six sweeps, leaving `0.97^6 ~= 83%` of the
previous value. At startup that previous value was black; moving an object
kept requesting sweeps, which is why initially black meshes suddenly acquired
normal GI after movement. The same retained history hid wall-opening and
light-removal changes.

- Irradiance now uses history only when the probe's visibility record says
  that history is valid. A new probe publishes its first fresh result instead
  of blending it against zero.
- While geometry/direct/probe convergence work is pending, effective
  hysteresis is capped at `0.5`; the configured high value is restored after
  convergence for steady-state stability.
- Light changes now receive the same six-sweep convergence window as geometry
  changes.

The saved Cornell geometry was also reconstructed through the real CPU
voxelizer: its closed room is classified enclosed, and removing `FrontWall`
correctly connects the room to exterior space. Its directional-light vector
passes through that front opening, so the remaining missing response was
temporal retention rather than connectivity.

The WebGPU smoke deadline is now 60 seconds and reports per-volume warmup,
voxel, direct, radiance, and convergence state on timeout. Headless Chrome
rendered only 35 frames in the old 20-second window while the deliberately
frame-spread startup still required more than 40 pipeline warmup dispatches;
the engine had not stalled. With the corrected harness the full resize,
camera-motion, rebuild, dynamic-voxel, local-light, and triangle-ray smoke
passes.

## 2026-07-17 visual-regression follow-up

- The default material base color is white again.
- The material GI node now always samples the persistent deferred texture;
  `_deferredReady=0` no longer becomes frozen in a cached stationary-camera
  render bundle. The texture is initialized black before its first write.
- Clipmaps are detail tiers rather than full-frustum containers. The inner
  tier is about 19 m wide at the default layout instead of roughly 50 m,
  reducing its voxel size from ~0.8 m to ~0.3 m so ordinary room walls and
  their bounce normals remain representable. Outer tiers retain long range.
- Boundary connectivity in the visible cone gather is trilinearly reconstructed;
  the earlier nearest-bit lookup caused hard voxel rectangles in room corners.
- Unknown probe/deferred history starts dark rather than injecting unverified sky.
- Exact emissive triangle visibility is default-off and requires the separate
  `rayProxies` opt-in. Its asynchronously enabled endpoint ray could hit the
  emitter's own proxy and make correct emissive bounce fade after a few seconds.
- Active convergence now uses four sweeps with a `0.35` history cap instead of
  six sweeps at `0.5`, and moving/direct-light work prioritizes the inner cascade.
- Static GI voxelization uses Virtual Geometry's camera-independent complete
  root cut, never its initially-empty/camera-selected live draw range.
- Runtime WebGPU smoke passed after these changes and remains at no more than
  eight storage buffers per compute stage.
- Contact AO is now subtle, squared, and strength-controlled. Enclosure
  visibility is independent of contact strength and only darkens near-zero
  sky visibility; this removes dirty open-room corner bands while allowing a
  genuinely sealed room to suppress environment IBL completely.
- Follow-up visual review showed even attenuated voxel contact AO remained too
  blurry, so the visible cone result now carries enclosure visibility only;
  fine contact AO is reserved for a future depth-aware screen-space pass.
- When a static mesh first moves, its old baked AABB is cleared from every
  static cascade immediately and its current pose is supplied by the dynamic
  splat. Live motion temporarily bypasses the settled-grid connectivity bit and
  trusts voxel DDA visibility. This makes an opening respond from the first
  frames instead of waiting 3-5 seconds for the background CPU rebake.
- Clearing a mover resets the radiance response clock, preventing the first
  post-idle temporal step from taking the old 35% cap and causing a large jump.
- The editor transform gizmo now emits `transform-changed` on every
  `objectChange` (single and multi-selection). GI handles that signal
  synchronously: it updates world matrices, detects/promotes movers, marks
  convergence work, and refreshes the dynamic triangle pool without waiting
  for an idle/static-scene scan. Per-frame transform polling remains as a
  fallback for animation and non-editor mutation paths.
- Dynamic Virtual Geometry splats use the same camera-independent original
  geometry/root cut as static voxelization. They no longer inherit a stale or
  initially-empty camera-selected live `drawRange` while an object is moved.
- Instrumented GPU readback shows radiance/probe changes within the first
  sampled half-second of motion; production build, GI module tests, and the
  full runtime WebGPU smoke pass after the immediate-transform changes.

### 2026-07-18 rollback boundary

At the user's request, runtime changes described by the bullets below this
boundary were rolled back. The restored target is the last verified state
above: the remaining known issues are missing/weak colored transport and GI
beginning after motion rather than continuously during it. Later experiments
(partial direct-cache publication, dynamic receiver fallback, clipmap slabs,
mesh mobility, 64-way slicing, overlap composition, camera-history changes,
and material-event/scheduler rewrites) must be treated as superseded history,
not current implementation.
- First-motion promotion no longer arms the debounced CPU voxelizer. That was
  the source of two delayed visible rebuilds: one shortly after motion began
  and another after the settled-pose timeout. Motion now stays entirely on
  the cleared-static + dynamic-splat path; only the settled pose requests one
  background bake, and its dynamic copy survives until that bake publishes.
- Dynamic direct lighting no longer hides all 16 interleaved cache chunks
  until a complete sweep. The chunk written this frame is published at once
  (including the emissive receiver cache), while untouched chunks preserve
  history and fill temporally. Moving emissive meshes also invalidate their
  finite-area proxy transform on the editor event rather than waiting for the
  periodic light scan.
- Post-change diagnostic readback measured a changed radiance field and probe
  mean at the first 504 ms sample during a continuous wall drag; the response
  then progressed at every subsequent sample. Runtime WebGPU smoke still
  passes without exceeding eight compute-stage storage buffers.
- Emissive endpoint visibility now trims the source mesh's own emissive voxels
  across its complete oriented-box depth rather than a fixed 1.25 voxels;
  non-emissive blockers in the same interval still occlude. Thick emissive
  meshes blend from planar cosine emission toward a volumetric box proxy, so
  a cube illuminates adjacent walls from its side faces instead of casting a
  dark silhouette through its own volume. Thin emissive panels retain planar
  area-light behaviour.
- Skinned meshes remain excluded from rigid voxelization, but unsupported
  emissive-receiver-cache samples now fall back to the directional probe
  field. Animated characters therefore receive nearby emissive/indirect light
  without freezing their bind-pose triangles into the voxel grid.
- Cascade selection follows the actually published, snapped clipmap centre
  and eases between recenter positions. It no longer slides continuously with
  the camera while sampling stationary voxel data, which caused distracting
  camera-distance lighting changes on a moving/followed character.
- Live dynamic direct updates now process and publish four interleaved chunks
  per frame. The maximum wait for an affected residue is four rendered frames,
  and the lighting changes while the object is moving rather than beginning
  only after release.
- Editor/play camera identity changes no longer rebuild world-space GI when
  projection/layout is compatible. The view-dependent deferred raw/resolved
  textures are explicitly cleared on play changes and camera cuts, preventing
  the previous editor camera's mask from appearing in the first game frames.
- The probe-only fallback was insufficient for small emitters on skinned
  receivers. Unsupported/non-voxelized surfaces now evaluate the existing
  finite-area emissive proxy buffer directly, including range attenuation,
  thick-vs-planar emission, and voxel DDA visibility. Static receivers retain
  the accumulated cache path, so this extra work is limited to dynamic gaps.
- Camera recentering finally implements the survivor/slab algorithm described
  by the original comments and tests. Static albedo/normal/emissive arrays are
  shifted into staging and only newly exposed X/Y/Z boundary slabs are
  time-slice voxelized; only true teleports rebuild the complete cascade.
  Previously every normal camera recenter rebuilt every voxel and delayed the
  start of temporal response by the reported 3-5 seconds.
- MeshComponent now exposes serialized `GI Mobility`: `auto`, `static`, or
  `dynamic`. The value is mirrored to `mesh.userData.giMobility` so transport
  code does not guess. Static meshes never enter the mover pool and atomically
  rebake after authored transform bursts; dynamic meshes are excluded from
  static voxelization and enter the GPU pool before first motion; auto retains
  backward-compatible promotion/settling inference.
- The first dynamic-skinned emissive fallback accidentally referenced its
  light/occupancy buffers from every cascade in the monolithic deferred
  compute, producing 15 storage-buffer bindings on an eight-buffer adapter.
  Detailed emissive receiver/proxy evaluation is now compiled only into the
  inner cascade; lite outer cascades bind only their probe field. Never solve
  this by requesting the adapter's optional 16-buffer limit.
- Dynamic receiver cache support is no longer treated as object identity: a
  character near a wall could inherit the wall's support and suppress live
  emission. Inner-cascade shading now combines cached and live proxy estimates
  with a component-wise max, and live rays target the closest point on the
  emitter OBB instead of its possibly wall-embedded centre. Diffuse cone mips
  apply constant-luminance chroma restoration to counter neutral filtering of
  saturated reflected bounce.
- The first live version was too expensive: four direct-cache chunks plus a
  128-cell DDA per half-resolution receiver dropped motion to 30-40 fps. Live
  cache work is now adaptive (two chunks only above 75 fps, otherwise one),
  and dynamic receiver emission uses the lightweight proxy evaluation while
  static surfaces retain the full shadowed accumulated cache.
- Direct-light invalidation is split into 64 small slices to avoid the
  remaining 120-to-50 FPS rebuild hitch. Slices are phases of a 4x4x4 voxel
  lattice, not linear residues: on a 64-wide grid the latter were literal X
  columns and appeared as repeated rectangular lighting/AO rebuild patterns.
- Auto meshes no longer silently settle back from the GPU dynamic layer into
  sequential per-cascade CPU bakes. Once moved they remain dynamic for the
  session, eliminating the second/third update after the user stops. Use the
  explicit Static mobility mode when an authoritative rebake is intended.
- Ordinary survivor/slab clipmap recenters retain cascade visibility and
  radiance feedback. Only true teleports fade/reset history; normal camera
  movement no longer fades out and then repeats the same accumulation.
- Overlap composition now keeps CPU voxel albedo/emission paired with the
  same dominant face that supplies its normal. GPU dynamic splats preserve
  authoritative occupied static cells, avoiding independent color/normal
  replacement and the large AO ghosts seen when a mover overlaps a wall.
- Dynamic-pool presence is no longer mistaken for motion. Matrix uploads and
  voxel/direct invalidation occur only when the pool set or a world matrix
  actually changes; the previous logic restarted the sweep every frame, so
  it could never catch up and permanently consumed update-frame GPU time.
- Cascades now start finite direct updates round-robin instead of fully
  serializing inner, middle, then outer work. The deterministic direct target
  is swept once (radiance/probes own temporal convergence), eliminating the
  repeated identical redraws and long inter-cascade pauses.
- Shader Graph uniform edits publish a lightweight `materialUniform` change.
  Emission strength/color therefore refreshes finite-area proxies and direct
  caches on the next GI tick without revoxelizing all three static cascades.
- Follow-up regression fix: partial direct-cache chunks are no longer copied
  into the visible cache. Although cheap, those incomplete spatial phases
  appeared as dark rectangles drifting over surfaces. Live emissive proxies
  provide the immediate response; the shadow target publishes only when its
  sweep is complete and then enters the existing temporal radiance blend.
- GI also subscribes directly to the shared material cache, independent of
  mesh subscriber callbacks, so in-place Shader Graph emission uniforms
  cannot miss invalidation. A headless live-node check confirmed the CPU GI
  reader follows an emission-strength uniform change without recompilation.
- Healthy frames advance `cascadeCount` small chunks per round-robin visit,
  completing the hidden three-cascade target in roughly 64 rendered frames;
  the budget returns to one automatically below 75 FPS.
