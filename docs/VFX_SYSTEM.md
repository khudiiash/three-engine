# Particles, VFX, Cloth and Water

## Module boundaries

| Module | Authoring | Runtime |
|---|---|---|
| Particles | Window > Particles, React Flow graph | Existing GPU particle systems, forces, colliders, lighting and shadows |
| VFX | Window > VFX, layered timeline | Timed sprites, rings, meshes, ribbons, lights, groups and particle graph instances |
| Cloth | Cloth component inspector; Hierarchy > Create > Cloth | GPU grid cloth fitted to a plane, with fabric and constraint controls |
| Water | Water component inspector; Hierarchy > Create > Water | GPU wave surface with physical optical controls and foam |

The component/module IDs are `particles`, `vfx`, `cloth`, `water`. Particles
remain built in for old scenes; their module catalog entry documents this.
The other three modules are independently enabled. Hierarchy creation enables
the appropriate module. The original particle dock key stays `particles`;
the separate composition editor uses `vfx`.

Old scenes using the former combined `vfx` module automatically enable the
referenced cloth/water modules on load. Existing graphs and `.vfx` simulation
documents remain readable, with inline fallback data preserved. Legacy surface
graphs are compatibility data, not the new cloth/water editing workflow.

## Particles

The original graph editor retains presets, Apply, Autosave, Restart, placement,
wires, frames, reroutes and disabled-node metadata. Small socket fields accept
numeric and vector constants without separate value nodes. Connected inputs
take precedence; disconnecting restores the authored constant. Untouched inputs
keep the compiler's automatic defaults. Numeric changes update uniforms;
changes to constant presence/type or graph structure rebuild the pipeline.

Multiple System nodes remain independent GPU emitters. Rendering supports
billboards and instanced meshes, standard lighting, shadow casting/reception,
bounded primitive collider interaction, neighbour interaction and the optional
point-light bridge. Collision response is one-way; particles do not push Rapier
bodies. Unsupported triangle colliders and approximated capsules are not full
mesh-accurate collision support.

## VFX composition

Add a VFX component or create VFX in the hierarchy, then open Window > VFX.
Add elements, drag clips to change their start time, resize their right edges,
or enter exact start/duration values. One drag is one undo operation. Duplicate,
delete, enable and parent layers; parent cycles are rejected.

Each element can animate position, rotation, uniform scale, opacity and light
intensity with linear, smooth or step keyframes. Keys use seconds relative to
the element's start. The timeline supports play, pause/resume, stop, seeking,
looping and playback speed. Impact and Aura are starter compositions.

Sprites support textures, camera facing and flipbook columns/rows/frame rate.
Rings support width and arc; meshes currently provide sphere, box and cone.
Ribbons are curve-shaped strips, with editable point data through the timeline
document/API. Layers support additive or alpha blending, tint, lighting and
shadows. Particle layers reference existing particle `.vfx` graph assets and
retain their own GPU buffers, collider settings and GI emission behavior.

Timeline data is serialized in the VFX component. Generated objects are runtime
children, never extra serialized entities. Export includes layer textures,
referenced particle documents and dependencies inside inline particle graphs.
Script methods are `play(from?)`, `pause()`, `resume()`, `stop()` and `seek(t)`.
Editor/MCP operations are `vfx.timeline.get`, `vfx.timeline.set` and
`vfx.timeline.playback`.

Seeking evaluates layer transforms and resets particle systems; it does not
replay GPU history to the requested timestamp. Ribbons are authored strips,
not history trails. Arbitrary imported mesh layers, background distortion,
subemitter event routing, exposed composition parameters and standalone
composition assets remain follow-on work. This is a first composition editor,
not Effekseer feature parity. References: [Effekseer documentation](https://effekseer.github.io/en/documentation.html),
especially parent-child effects, ribbons, models, curves and materials.

## Cloth

Cloth turns an existing plane MeshComponent into simulated cloth. Hierarchy
creation adds the plane and Cloth together; adding Cloth to an empty entity or
an unsupported mesh creates no standalone surface. The plane determines its
dimensions. Disabling or removing Cloth restores the plane. Rendering and
normals deform on the GPU; picking uses the authored rest mesh.

Controls include simulation resolution, gravity, wind/gusts, velocity retention,
stretch/shear stiffness, bend resistance and pinning (top edge, top corners,
left edge, left corners or free). Cotton, silk and canvas adjust constraint
behavior. All appearance comes from the plane's mesh material: color, roughness,
textures, sheen and shader graph remain material settings. Cloth has no separate
appearance controls and borrows the exact material instance without modifying
or disposing it. Material edits/reassignment and mesh shadow settings follow
through to the deformed surface. Legacy cloth graph appearance values are
ignored; the plane's material is authoritative.

Nonzero wind includes a varying flutter force, so the cloth keeps responding
after its initial movement even with extra gust strength set to zero. Gravity
is world-down, including when the source plane is rotated.

One-way scene collider contacts are enabled by default, with contact thickness
and friction controls. Projection runs after cloth constraints in a separate
compute pass and supports oriented boxes and spheres. The shared GPU collider
field follows the scene collider's fit-to-mesh dimensions, automatic center,
offset, local rotation and hierarchy transforms. Convex colliders use oriented
geometry bounds; capsules use enclosing spheres. Sensors and disabled ancestors
are excluded, while off-camera colliders still participate. The cloth's own
collider is excluded, and generated cloth bounds never feed back into fitting.
Cloth additionally supports Concave and Mesh colliders through a separate,
cached triangle BVH. Cooked concave collision geometry is used when available;
the authored triangles are the fallback. Swept vertex-to-triangle contact and
resting contact preserve openings instead of filling them with bounding boxes.
Spatial grid-edge contacts also check the rendered triangle diagonals and
propagate the pinned boundary's side through a separate Jacobi pass. This
addresses initial sheet/surface intersections that temporal vertex sweeps miss.
Certified watertight shells additionally support nearest-surface overlap
recovery; open or inconsistently wound meshes retain surface-only semantics.
The shared field has an 8,192-triangle budget; over-budget colliders are omitted
as whole objects with an inspector diagnostic, never partially truncated.
Terrain/heightfield colliders and rigid-body impulses remain unsupported. The
primitive projection path is discrete; triangle sweeping is not cloth
self-collision or a general continuous deformable collision solver.

`vfx.cloth.status({entityId, readPositions?})` reports the live fields, included
triangle colliders, errors and optional GPU position bounds. This is useful for
checking the actual scene instead of inferring collision support from settings.

The solver is grid cloth, not a garment sewing system. Skinned attachments,
tearing, self-collision and two-way rigid-body feedback remain outside this
implementation.

Entity anchors are configured in **Cloth > Entity anchors > Add anchor**.
Each entry selects a target entity, a grid point (U/V: `0,0` top-left to `1,1`
bottom-right), and an offset in the target's local space. Up to 32 anchors
follow target translation, rotation and scale, including parent transforms.
Missing targets or disabled anchors release their points. Existing pin presets remain
available; select **None** to use only entity anchors. Anchors belong to the
scene instance even when its simulation settings come from a shared asset.

## Water

**Create > Water** creates a **Box** Mesh and a Water component. The box *is*
the body of water: its X/Z are the footprint, its Y is the depth, the wave
heightfield is its lid, and its sides and floor are the water itself. A Plane
Mesh is still accepted and still means "this surface, with `waterDepth` of water
below it" — every existing water scene keeps working — but a box is what a new
one starts as, because a camera can be inside it.

The immutable built-in `Water` material (`builtin:Water.mat`) supplies a
physical BSDF with IOR 1.333, transmission, roughness and an editable **Water
Color** graph node for shallow/deep tint, optical depth, absorption and crest
foam. The first material edit forks a project `.mat`; swapping/forking it does
not alter other water surfaces. Runtime effects use an owned clone and leave the
source material untouched. Generated solid colliders are suppressed while water
is active, but explicit colliders remain authored obstacles.

The GPU surface combines five directional wave bands, three octaves of advected
value noise, and a separately propagated disturbance heightfield. Moving or
submerging rigid bodies inject wakes. The solver owns the `n²` lid vertices; the
skirt that closes the body (four walls to the volume floor, plus that floor) is
written by the same kernel from the same buffers, so a wall's top edge *is* the
lid's own rim vertex and cannot crack away from it. Depth is a uniform —
deepening the water rebuilds nothing.

### Buoyancy

With physics enabled, buoyancy applies gravity-opposing impulses proportional to
**displaced volume × water density**, plus linear/angular fluid drag. Density,
not a mass-only threshold, determines floating: 500 kg in 1 m³ floats in
1000 kg/m³ water, while the same mass in 0.125 m³ sinks; for a fixed volume,
mass alone decides. Volume comes from the actual Rapier colliders (cooked convex
hulls included), quadrature-sampled, so a sphere displaces a sphere's worth.
Physics runs in the fixed-step Rapier update over the water volume.

⚠ The horizontality guard on the surface query tests the mesh's local **+Y axis**,
not a matrix element. It used to read `|inverse.elements[5]| < .2`, which for an
axis-aligned mesh is `1/scaleY` — so it silently rejected every water surface
scaled thicker than 5 units as "tilted" and returned a query that answered
`null` everywhere. Nothing floated and nothing was logged. Regression-tested in
`tests/water-physics.test.mjs` against the exact transform that hit it.

### The underwater medium

Underwater is **not a toggle**. It is one number per pixel: how many metres of
water lie between the eye and whatever that pixel shows. That is computed on
`scene.fogNode` — the eye→fragment segment is clipped against the volume box,
with the top face lifted onto the actual wave from the slot's surface map, and
the clipped length drives Beer-Lambert absorption toward the water's colour
(`deepColor` over `1/absorption` metres, the same pair the material's own
transmission reads). One expression is simultaneously the submerged view, the
correct half-and-half when the eye is on the waterline, the depth tint on a
submerged object seen from above, and nothing at all for the rest of the scene.
The project's authored `scene.fog` is replicated inside the same node rather
than replaced.

### Caustics

Caustics are a **map**, not a screen-space derivative. The refracted footprint's
compression is measured once per slot texel in a compute pass, from the
neighbouring texels' landing points on the volume floor, and read back by both
consumers: the raster caustic light and the GI sun term. The previous
implementation used `dFdx`/`dFdy`, which exist only in a fragment shader — so GI
kernels structurally could not see it, which is what "GI almost does not work
with water" was. Snell runs in world space, because a water mesh is routinely
non-uniformly scaled and a non-uniform scale is not a similarity.

In GI the gain multiplies a directional slot's **visibility** rather than its
irradiance. That placement is load-bearing: with the §12.82 sun split armed (the
default) the irradiance is not stored at all — the transfer is, and is re-closed
against the current sun every frame — so a caustic folded into irradiance would
be discarded each frame, while folded into visibility it rides the cached
transfer. Probes therefore see a caustic-lit floor and bounce it.

The map is in surface parameterization, so a receiver finds its texel by walking
back up the flat refracted ray. The MIT
[jeantimex/webgpu-water](https://github.com/jeantimex/webgpu-water) reference
instead splats each beam where it lands, which additionally sums overlapping
folds; a gather cannot, so a fold reads as one bright filament rather than two
summed. That buys a pass with no atomics, no scatter, no per-frame clear, and a
gain bounded by construction (a firefly in a light is a firefly in every bounce
that light takes). Caustics do not ray-test intervening occluders.

### Slots

The medium, the caustic light and the GI sun term all bind **engine-owned water
slots** (`waterSlots.js`), not a component's textures — a graph that binds a
component's resources must be rebuilt whenever that component is, which for GI
is a multi-second compile wave and for `scene.fogNode` is every material in the
project. Water can appear, change resolution and vanish without one rebuild; an
empty slot publishes `active = 0`. Two slots exist (each is a live binding and a
slab test in every material's fragment shader); a third pool of water simulates
and renders but does not light or fog. The raster caustic light is likewise one
light for the whole pool.

Reflections are a mirrored scene render with water Fresnel, roughness blur and
wave-normal distortion; the active GI reflection toggle controls it. This is a
planar approximation and costs one half-resolution scene render per visible
water surface. Shoreline foam, volumetric flow and overturning waves remain
outside this heightfield implementation.

Visual reference: [jeantimex/webgpu-water](https://github.com/jeantimex/webgpu-water),
the MIT-licensed WebGPU port of Evan Wallace's pool demonstration. The engine
uses original TSL implementations integrated with arbitrary scene meshes,
materials and Rapier; the reference's pool/sphere shader is not copied into it.

## GI integration

The former particle receiver only sampled optional reflection probes. Normal
SRC GI can run without those probes, leaving lit particles with no indirect
light. Transparent effect receivers now use a directional world-space
irradiance texture populated by a compute pass from SRC. Fragment shaders
sample the texture: SRC's atomic hash buffers are compute-only and cannot be
read directly in fragment shaders. Optional probe lighting remains a fallback.

The texture stores six signed-axis irradiances on an 8³ lattice around visible
effect receivers. Mesh bounds follow their transformed geometry; particle
bounds use GPU position readbacks at most twice per second, with one readback
in flight and a motion margin. Outside that coverage the sample returns zero,
never the lighting from a clamped volume edge. Widely separated or rapidly
moving effects can therefore receive a coarser or temporarily absent cache
sample; this remains an approximate diffuse receiver path.

This cache approximates diffuse indirect illumination; it is not a separate
path trace for every particle. Dynamic cloth/water receive raster GI, with
deformation identified for temporal handling. CPU static GI occupancy and the
reference path tracer exclude GPU-deformed rest meshes: baking those would
create false occlusion. Receiving GI is distinct from contributing exact
animated geometry to the GI acceleration structure.

Cloth now also contributes diffuse color bounce and occlusion through a live
128-triangle transport proxy refitted directly from GPU-rendered positions.
The proxy shares the existing packed dynamic-object pool and adds no storage
bindings to GI tracing shaders. Effective shader-graph albedo/emission follow
the mesh material; texture detail is averaged as for other dynamic objects.
Fine folds are approximated by the bounded grid. The reference path tracer
does not use this raster-GI transport proxy.

Particle **GI Emission** remains an approximate sphere emitter per System,
using sampled live positions/colors. Unborn particles contribute nothing;
disabled systems suppress their emitter, and power changes update live. The
GI Fire preset enables this without proxy point lights. Enable the GI module
and the System's Lit setting for receiving indirect light.

Reflection capture now separates tracing hit data from SRC shading through
textures, preserving the portable eight-storage-buffer limit when a sharp
water material activates reflection probes. Never raise the requested device
limit to hide a composed-graph binding failure.

## Simulation graph assets

Existing `.vfx` files contain `{version: 1, kind, graph}` for particles, cloth or
water. The Particles editor saves/opens particle graphs. Surface document data
remains supported by runtime and JSON inspection. Linked graph edits update
instances while simulation state stays independent. Clearing an asset restores
the inline graph. Validation rejects bad versions, dangling edges and cycles;
late loads cannot overwrite newly assigned or published graphs.

Legacy graph operations remain `vfx.create`, `vfx.get`, `vfx.set`, `vfx.assign`,
`vfx.modules`, `vfx.addModule` and `vfx.setEnabled`; timeline operations use the
explicit `vfx.timeline.*` family. This retains existing automation compatibility.

## Verification

- `npm run test:water` / `npm run test:water-material`: layered wave sampling,
  real Rapier displacement/density equilibrium, and editable built-in shader parity.
- `npm run smoke:water-surface`: GPU/CPU wave parity, wake propagation and
  depth-dependent moving caustics, including a zero-light control.
- `npm run smoke:water-authoring`: hierarchy creation, material fork and undo.
- `npm run smoke:water-appearance`: actual built-in Water with active GI;
  reflection toggle, red-to-green object reflection outside the object's direct
  screen bounds, and isolated water GI reception with direct lighting disabled.
  The water gather uses tight surface bounds rather than its expanded culling
  sphere, so the irradiance texture retains useful resolution near the surface.
- `npm run preview:water`: render the pool showcase to
  `artifacts/water-showcase.png`. Water browser checks use fresh Vite port 5307.
- `npm run test:vfx-timeline`: interpolation, hierarchy, lifecycle, export,
  migration, and particle socket constant precedence/hot updates.
- `npm run test:vfx-assets`: graph validation, load races, shared instances,
  reroute preservation and dependency export.
- `npm run test:particle-colliders`: actual collider fitting/rotation, geometry
  bounds, convex/capsule approximations and hierarchy/sensor filtering.
- `npm run test:cloth-colliders`: concave holes, cooked triangle geometry,
  hierarchy transforms, BVH cache invalidation and explicit budget rejection.
- `npm run test:cloth-anchors` / `npm run smoke:cloth-anchors`: entity references,
  transformed moving targets, preset coexistence, deletion and live edits.
  `smoke:cloth-anchors-ui` checks actual inputs and undo (fresh Vite port 5321).
- `npm run test:cloth-gi` / `npm run smoke:cloth-gi`: graph albedo over stale
  scalar color, contributor lifecycle and measured red bounce on a neutral
  receiver with the source hidden during capture (Vite port 5307).
- `npm run smoke:gi-grid-bvh`: GPU-written vertices, conservative packed bounds,
  moving geometry and both BVH arities; also run the required generic GI smoke.
- `npm run smoke:cloth-concave`: real WebGPU triangle contacts, an open gap,
  moving transformed colliders, closed-shell overlap recovery and fast falls
  onto thin surfaces. An optional `?actual=/artifacts/<snapshot>.json` fixture
  checks structural and rendered diagonal edges against the original mesh at
  five and ten seconds. Start fresh Vite on `127.0.0.1:5307`, or pass the
  fixture URL to the script.
- `npm run test:vfx-stack` / `npm run test:vfx-graph`: graph compatibility,
  presets, solver settings, borrowed mesh material ownership and surface bounds.
- `npm run smoke:vfx-workspace`: fresh Vite localhost:5307, actual four-module
  hierarchy/editor workflow and timeline interaction.
- `npm run smoke:vfx-particles`: actual GPU collider/lighting/shadow pipelines.
- `npm run smoke:vfx-simulations`: GPU pinning/waves/normals/materials,
  transmission, resource restart and disposal (fresh Vite localhost:5283).
- GI changes require `GI-SMOKE PASS` with no validation errors, plus the active
  scene GI receiver test; a Vite build cannot validate GPU pipelines.
- `npm run smoke:vfx-gi`: fresh Vite 127.0.0.1:5295, actual SRC GI on/off pixel
  comparisons for particles, cloth and water with no authored reflection probes.
  Append `?level=1` to the fixture URL to exercise the highest quality settings.

Active receiver coverage runs against a fresh
`npx vite --host 127.0.0.1 --port 5295 --strictPort`:

```
node scripts/run-gpu-page.mjs http://127.0.0.1:5295/scripts/vfx-gi-smoke.html 70000
node scripts/run-gpu-page.mjs "http://127.0.0.1:5295/scripts/vfx-gi-smoke.html?level=1" 70000
node scripts/run-gpu-page.mjs http://127.0.0.1:5295/scripts/gi-gpu-smoke.html 70000
```

Set `GPU_SMOKE_PROFILE` to a unique temporary folder for each command. The
receiver test compares real particles, cloth and water with the active SRC
light present/absent, checks deformation tags, and compiles automatic
reflection-probe capture under the portable eight-buffer limit at Low/Ultra.

Browser harnesses use isolated Chromium profiles. `test:build` gates export
decisions; production editor and player builds catch integration errors. A full
exported-game visual round trip is separate from CPU dependency rewriting and
editor scene save/reload.

### Authoring water that behaves

Three settings decide whether water reads as water, and all three are about
UNITS rather than taste:

- **Density, not mass.** A Rigidbody's `Mass from` can be `density` (kg/m³),
  which is what an author actually means and the only one of the two that
  survives the object being scaled — an absolute mass is a property of one size,
  so scaling a crate 3× makes it 27× too light and it stops sinking in. 500
  floats half out of the water at any size; 2400 is concrete. Rapier derives the
  mass from each collider's own volume.
- **Waves are in metres.** `waveHeight` and `waveLength` are world-space, so the
  same numbers mean the same ripple on a puddle and on a lake. They used to be
  in the mesh's local units, which turned `waveLength 0.5` on a 40× box into a
  20 m swell — and a 20 m swell has no caustics worth the name.
- **Resolution bounds the ripple.** A heightfield cannot carry a wave shorter
  than a few of its cells, so `waveLength` is clamped up to the grid's Nyquist
  limit rather than aliasing. A 40 m body at resolution 64 has 60 cm cells and
  therefore ~2 m as its finest wave; raise the resolution for finer water, and
  remember the caustics can only be as sharp as the surface feeding them.

### Body/water coupling, and why it is a displacement pair

A body does not pump the surface, it displaces it. Following
jeantimex/webgpu-water's `sphere.frag`, each body emits its footprint ADDED
where it was and SUBTRACTED where it is; at rest the two cancel exactly, so a
floating object injects nothing and nothing accumulates. Injecting a
rate-proportional bump instead — the obvious first design — piles up for as long
as the body moves and then rings it off, which is what "wiggling like a jello"
was. The footprint is the WATERPLANE (`sqrt(A/pi)`) and its depth the mean
submersion (`volume/A`), both of which the buoyancy solve already computes.

Three things keep that stable and each of them was a real failure first:
a **deadband** (a resting body micro-bobs forever, and each bob emitted a dipole
of zero volume but positive energy); a **release on exit** (a body that submerges
fully, sinks out, or leaves the footprint must give its dent back, or the solver
radiates an abandoned hole forever — "interaction is triggered even when fully
submerged"); and **pair-safe queue eviction**, since discarding half a pair
leaves a one-way pump.

The solver itself now runs at half the CFL limit rather than 0.845 of it, caps
each injection's slope at a third of its own footprint, and hard-bounds the
disturbance field. An explicit wave solver has no guarantee against divergence,
and a diverged heightfield fills the screen with grid-scale spikes.

`tests/water-interaction.test.mjs` runs the real `WaterPhysics` and real Rapier
against a line-for-line CPU mirror of the GPU solver, and asserts the three
things impressions cannot: a splash decays, a resting body adds no energy over
thirty seconds, and a driven body's wake is bounded and calms once it stops.

### Reflections

A planar mirrored render, distorted by the wave normal. The distortion is
measured in VIEW space on both sides; it used to subtract a world-space flat
normal from a view-space wave normal, which is not a quantity and displaced the
reflection by an amount that depended on where the camera pointed.

The mirrored camera sits BELOW the surface, which has two consequences that were
both wrong until measured: it renders the water body itself (a closed hull does
not hide itself the way a single plane did), and it would be fogged by the
underwater medium even though a reflected ray travels in air. Both are suspended
for that one render.

`npm run smoke:water-reflection` measures WHERE the reflection lands against the
analytic mirror image — `(x, 2h-y, z)` projected through the same camera — in
two configurations including a 40x10x40 box with waves and a high object.
Current error: 3.3 px and 1.5 px of 512. A reflection is displaced along the
VIEW direction and a shadow along the LIGHT direction, so the two do not
coincide and should not be expected to.
