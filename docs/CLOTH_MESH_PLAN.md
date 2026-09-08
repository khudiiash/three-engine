# Cloth on an arbitrary mesh

**The ask (2026-09-07, user):** *"we need to be able to turn any arbitrary mesh
to cloth (if possible), like we take a model of a boat with sails, and we want
to turn sails into cloth. Of course, many meshes won't work, like a human model
for example, i assume we could skip for meshes we can't simulate as a cloth."*

## Where it started

`GridSimulationComponent.findPlane()` rejected any mesh carrying a
`geometryAsset` and any `geometry` kind other than `plane`, so the Cloth
component attached, set `surfaceError`, nulled its simulation and did nothing.
That was deliberate: `gridSimulation.js#constrain` unrolls a **fixed
twelve-neighbour stencil at shader-build time** with rest lengths folded in as
JavaScript constants (`Math.hypot(ox * dx, oy * dy)`), so it can only simulate a
plane it generated itself.

## Why it is tractable

⭐ **The solver is already Jacobi.** `constrain` ping-pongs between two buffers
and never reads a value another thread wrote in the same pass. An arbitrary
constraint graph therefore needs no colouring, no ordering and no atomics —
only the neighbour list changes. That removes the hardest part of a general
cloth solver before it starts.

Everything else in the cloth path is already topology-agnostic: Verlet
integration, the anchor system (which pins by particle index), per-particle
collision against the primitive and triangle collider fields, and the commit.

## Stage 1 — SHIPPED: the topology (`src/engine/vfx/clothMeshTopology.js`)

The CPU half, and deliberately all of the hard part. No GPU, no three renderer
state, so every rule is testable in Node — which matters because "which meshes
qualify" is a judgement that will be argued with, and should be arguable
against numbers. `npm run test:cloth-topology`, 23 checks.

It produces exactly what the solver needs:

| buffer | replaces |
|---|---|
| `rest` (x, y, z, pinned) | the grid's `initial(x, y)` and its `pinned()` predicate |
| `springs` (neighbour, restLength, weight, fanSuccessor) | the unrolled stencil |
| `simOf` | nothing — new, because welding collapses render seams |

### The decisions worth not re-litigating

- **⛔ Thinness is measured on PRINCIPAL axes, never a bounding box.** A sail is
  thin along its own normal, which is almost never a world axis: a 3 × 3 m sheet
  rotated 45° has an axis-aligned box of 2.1 × 2.1 × 3 and reads as solid. The
  covariance's smallest eigenvalue is the thickness whatever the orientation.
  Closed form (Smith 1961), no iteration.
- **⛔ Welding is not optional.** Sponza's curtain: 7 739 render vertices for
  7 174 distinct positions. Two copies of a seam vertex share no spring, so an
  unwelded sheet tears along every UV seam on frame one.
- **⛔ Islands are found and pinned separately.** A boat's two sails are one
  geometry with two pieces at different heights; pinning "the top" globally
  nails the upper sail's head and drops the lower one. That curtain is three
  separate 2.3 m drapes in one asset.
- **⛔ The pin band is a fraction of the PINNED axis.** Sizing it to the piece's
  overall extent fixed a horizontal sheet pinning all 23 of its vertices
  (`Mesh_0_9`) and broke the opposite case — an 11 m banner then pinned 36 % of
  itself. The band stays on the pinned axis and the flat case is DETECTED and
  reported instead.
- **Fixed stride, not CSR ranges.** The graph gets ONE storage binding at
  `maxDegree` slots per particle with a sentinel, because the solver already
  binds positions, previous, scratch, anchors and both collider fields and
  WebGPU only guarantees eight per stage. The stride is the mesh's own measured
  maximum, so nothing is truncated.
- **The fan successor rides a spring's spare `w` lane.** The render mesh needs a
  vertex normal and a mesh has no grid neighbours to cross. Every ring edge is
  already a structural spring, so ordering the one-ring by triangle winding and
  storing each neighbour's fan successor costs no extra binding and gives the
  shader `sum(cross(a - p, b - p))` — the area-weighted vertex normal.
- **Shear is inert on a mesh cloth and says so.** A triangle already resists
  shear through its own three edges; only a grid quad needs a diagonal. Reported
  in `notes` rather than left as a slider that does nothing.

### Receipts on the real assets

| mesh | verdict |
|---|---|
| `Mesh_0_18` (the blue curtain) | **accept** — 7 174 particles, 3 islands, 21 495 structural + 21 406 dihedral springs, 184 pinned, 4.8 % thick, 42 ms |
| `Mesh_0_5` (a pillar) | reject — solid, 48 % thick |
| `Mesh_0_9` (a horizontal panel) | reject — every vertex would be pinned |
| `Mesh_0_1` | reject — 23 085 particles, over the 20 000 budget |

Spring degree on the curtain: **median 12** — exactly the old grid stencil's
twelve neighbours, so a mesh cloth costs the same per particle as the grid it
replaces. p99 14, max 16.

**Fan normals validated against the asset's own authored normals**: median dot
**1.000**, p05 0.802, and of the 1.9 % pointing the other way, *all 147* sit on
a welded rim position where the shell's front and back surfaces genuinely
oppose. Nothing unexplained.

## Stage 2 — SHIPPED: the solver

Running live on Sponza's curtain:

```
error: null            simulated: true
analysis: { ok: true, particles: 7174, islands: 3, springs: 42901, pinned: 184 }
notes:  "3 separate pieces in one mesh — each drapes on its own..."
        "Shear has no effect on a mesh cloth..."
```

Two consecutive reads of `gpuBounds` return identical values: it settles rather
than diverging, with no console errors and no NaN.


1. ✅ `createGridSimulation` takes a packed `topology`; for cloth it sizes
   `positions`/`previous`/`scratch` to `topology.count` and binds `rest` and
   `springs` as two `instancedArray`s.
2. ✅ `initial(x, y)` → `rest.element(index).xyz`; `pinned()` →
   `rest.element(index).w > 0.5`.
3. ✅ `constrain` → a `Loop` over the particle's stride, stopping at `SPRING_END`,
   mixing `stiffness`/`bend` by the spring's `weight` with a single `mix()`
   rather than a branch in the innermost loop.
4. ✅ `heightfieldVertex`'s cloth branch → walk the fan successors for the normal.
5. ✅ `collideEdges` → take its "predecessor" neighbours from the spring list
   instead of grid arithmetic.
6. ✅ The render geometry is the SOURCE geometry, with a `simIndex` attribute per
   render vertex so the surface kernel scatters particle positions back through
   `simOf`.
7. ✅ `GridSimulationComponent.findPlane` gains a mesh path, and the Inspector
   shows `analysis.reason` / `analysis.notes` instead of "requires a plane mesh".

⚠ `gridSimulation.js` is 1 500 lines and shared with water. Every change above
sits inside an existing `kind === "cloth"` branch; the water path must not be
touched, and `npm run test:water` is the gate that says it was not.

## Stage 3 — after that

- The Sponza curtain is a **closed shell 0.2 m thick**, so simulating it drapes
  a bag rather than a sheet: front and back are joined only at the rim. It will
  move, but a sail modelled as a single open surface is the case this is for.
  Worth measuring before deciding whether thick shells need their two sides
  stitched.
- `sceneCollision` on that curtain currently finds zero colliders: every
  collider in the prefab is disabled but one. Cloth will fall through the
  architecture until they are enabled.


### What the wiring cost, beyond the obvious

- **⛔ EVERY per-particle kernel had to move off `wCount`/`count`.** For water
  and a grid cloth those equal the particle count, so the paths are unchanged —
  but a mesh cloth left on the old size would dispatch the grid's 32 × 32 =
  1 024 threads over a 7 174-particle buffer. Five sixths of the cloth would
  never be integrated **and the rest would look like it worked**. Seven kernels:
  init, integrate, commit, pinEntities, collide, collideEdges, constrain.
- **⛔ THE RELAXATION DIVISOR IS THE WEIGHT SUM, NOT A CONSTANT.** The grid
  divides by `4 + shear*4 + bend*4` because it knows it has exactly twelve
  neighbours. A mesh vertex has three to sixteen, so the same constant
  over-corrects a boundary vertex and under-corrects a dense one — the sheet
  would ripple along its own topology.
- **⛔ AND THE LIVE BUG NO OFFLINE TEST COULD FIND.** `syncPlane`'s validity
  test required NO geometry asset, so a mesh cloth was never valid and never
  re-attached. A `.geom` mesh renders a **placeholder box** until its asset
  arrives, so the analysis ran on the box, refused it — *"thickness is 100 % of
  its longest axis"* — and nothing asked again. The real curtain measures 4.8 %.
  Now tracked by the geometry OBJECT, because the stuck case is exactly the one
  where the analysis failed and there is no `planeSource` to compare against.

### Water is untouched

`test:water` fails one check, `a driven body's wake stays bounded` at
0.24732489691340093 against a 0.25396825396825395 bound. **Pre-existing**: the
original `gridSimulation.js` produces the identical figure, digit for digit,
which is also the receipt that the water path is behaviourally unchanged.

### ⛔⛔ THE REGRESSION THAT SHIPPED: A ZERO-FILLED PADDING TAIL

The user photographed the curtain torn into vertical threads and smeared to the
floor, and guessed it was the three pieces in one geometry. It was not — it was
one line in the packer.

The spring graph is stored at a fixed stride with a sentinel. `packClothTopology`
wrote that sentinel **only at the first unused slot**, on the assumption that the
shader's `Break()` would never reach the rest of the tail. It did reach it, and
a zero-filled slot is not inert: `(0, 0, 0, 0)` reads as **a spring to particle
0 with a rest length of zero**, so every particle in the sheet was dragged
toward particle 0.

Reproduced exactly, on the CPU, over the real curtain:

| padding read as springs | worst stretch | mean | bounding box |
|---|---|---|---|
| no | 1.58x | 1.013 | 11.0 x 2.3 x 4.6 m |
| **yes** | **2 114x** | **54.8** | **10.7 x 66.2 x 52.7 m** |

Two fixes, because one of them is a rule rather than a repair:

1. Every unused slot carries `SPRING_END`, not just the first.
2. **Correctness does not depend on control flow when the data can carry it.**
   All three spring loops — constraint, fan normal, edge contact — now GUARD on
   `x >= 0` instead of relying on `Break()`, which is deleted. With the tail
   filled and the guard in place the two arms of the table above are identical,
   so the result no longer depends on whether the loop stops early at all.

⚠ Note what the offline tests could NOT catch: 23 topology checks passed
throughout, because they tested the *analysis*, and the analysis was right. The
fault was in the packing-to-shader contract, which only the GPU exercises. The
CPU reproduction above is what closed it, and `test:cloth-topology` now pins the
whole tail rather than the first terminator.

### ⭐ THE TEARING WAS NEVER THE SOLVER — IT WAS A COLLIDER THE CLOTH LIVES INSIDE

The user reported the cloth still torn after the padding fix: *"nothing
changed"*, and they were right. Two corrections to my own account:

**⛔ I called the padding bug the cause on evidence that already contradicted
it.** The live `gpuBounds` before that fix spanned 4.0 m in Y — nowhere near the
66 m my CPU reproduction predicted for a padding blow-up. I had that number in
hand and fitted the hypothesis to the experiment instead of to the measurement.
The padding fix is still correct and still worth having; it was not this bug.

**⛔ AND THE INSTRUMENT WAS MEASURING ONE SEVENTH OF THE CLOTH.**
`createGridSimulation` published `count` — the GRID's 1 024 — in its returned
object, and `vfx.cloth.status` reads back `positions` over that. On a
7 174-particle mesh cloth it sampled 14 % of the sheet and reported healthy
bounds while the rest was free to be anywhere. Now publishes `particleCount`.
*An instrument that silently measures a subset reports a fix that is not there.*

**The actual cause.** With the full read, the cloth spanned **4.5 m against a
2.27 m rest**, with particles **1.1 m ABOVE the pin line** — which gravity
cannot do. A three-way bisect settled it:

| | Y span |
|---|---|
| rest | 2.27 m |
| scene collision ON | **4.52 m** |
| scene collision OFF | 2.36 m |
| collision ON, `Mesh_0_9`'s collider disabled | **2.31 m** |

`Mesh_0_9` is a 23-vertex mesh whose auto-generated CONVEX hull spans
**21.9 x 3.3 x 9.8 m and contains the curtain whole**. It was the only enabled
collider in the prefab. Contact was pushing all 7 174 particles out toward that
hull's surface. The mesh-cloth solver holds its rest length to within 2 %.

**The engine-side fix is a diagnostic, not a behaviour change.** A cloth that
starts inside a box arguably SHOULD be pushed out; what was wrong is that
nothing said so. `vfx.cloth.status` now reports `engulfedBy` — every enabled
collider whose bounds contain the cloth — and adds a note naming it and saying
what to do. `primitiveCount: 1` was true and useless.

### ⛔ AND THEN IT WAS OFFSET ON X

With the collider disabled the cloth drapes correctly — and sits about a metre
to the side of the curtain it replaces.

`syncAppearance` carries the simulation mesh to where the source sits:

```js
mesh.matrix.copy(source.mesh.matrix);
mesh.matrix.multiply(makeTranslation(center.x, center.y - height / 2, center.z));
```

That translation exists because the GRID cloth builds its lattice around a local
origin at the TOP CENTRE (`initial` is `(ix*dx - width/2, height - iy*dy, 0)`),
so it has to be moved onto the plane it stands in for. **A mesh cloth's geometry
IS the source geometry, already in the source mesh's own coordinates**, so the
same translation moves it off the thing it replaces. On the user's curtain the
bounding-box centre is (0.97, 1.13, -0.32), which is the X offset they
photographed almost exactly.

⚠ **AND NO BOUNDS CHECK COULD HAVE CAUGHT IT.** Every receipt to that point
compared the cloth's SIZE against its rest size, and the size was right the
whole time — an offset translates a box without changing its extents. Three
rounds of numbers said "correct"; it took an eye. Worth remembering the next
time a span is offered as proof that geometry is in the right place.

A mesh cloth now takes `source.mesh.matrix` and nothing else.

### ⛔⛔ AND THE FLOOR COLLIDER WAS THE SAME BUG, WEARING A HAT

*"why adding collider to the floor completely breaks the cloth?"* — because
`Mesh_0_9`, the collider that engulfed the curtains, **is** the floor. It is one
mesh holding the ground and the gallery above it: 7 vertices at y = 0 and 16 at
y = 3.32, 21 triangles. Its shape was CONVEX, which is what an auto-generated
collider defaults to.

```
mesh encloses   162 m³
its CONVEX HULL 713 m³   ->  4x, a brick from the floor to the balcony
```

Disabling it was never the answer — the character has to walk on it. The answer
is that a floor with a raised gallery cannot be a convex hull. Set to
**Concave** it cooks to its real 21 triangles: the character walks on the actual
surface, the cloth collides against it, and `engulfedBy` goes empty.

`PhysicsSystem` now warns when a built hull exceeds 3x its source mesh's volume
— see the physics memory for why the volume must come from `collider.volume()`
after creation rather than from the `massWeights` already at hand.

### 2026-09-08 — "it does not react to the character" and "looks a bit torn up"

Two separate faults, both measured before either was touched.

**⭐ THE CHARACTER WAS INVISIBLE TO THE CLOTH.**
`PhysicsSystem.#createColliders` returns early for a character-controller
entity — *"owns its own capsule"* — so a character's shape never comes from a
`collider` component, and `ParticleColliderField` walks only for that component.
The cloth reacted to everything else in the scene, which is exactly what made it
look like a cloth bug. The field now presents a character controller as the
capsule it builds. ⚠ Capsules are approximated by an ENCLOSING SPHERE here (see
that file's header), so a 1.8 m character reads as a 1.2 m ball and cloth
reacts about a body's width early. Crude, but it is what every capsule collider
in this field already does; a tighter fit means a real capsule type, not a
special case for one entity.

**⭐ A MODELLED CLOTH IS A SHELL, AND ITS TWO FACES WERE FREE.** A curtain or
sail authored with thickness is a front face and a back face joined only around
the rim — nothing connects them anywhere else, so the layers slide and separate
and the cloth reads as torn. Measured on the curtain: **100 % of 7 174 vertices
have a partner within 11 cm that is more than two rings away in the graph**,
median separation 5.8 cm.

`buildThicknessSprings` gives each vertex one spring to its nearest such
partner, at their rest separation. Simulated 200 steps on the real mesh:

| | face separation vs rest |
|---|---|
| without | mean **0.72x**, worst 1.8x |
| with | mean **1.00x**, worst 1.2x |

4 242 springs, max degree 16 -> 20, analysis 49 -> 103 ms.
`{ thickness: false }` is the A/B arm.

⚠ **THE 2-RING EXCLUSION IS THE TRICK, and my first test did not pin it.**
Without it the "nearest distant partner" is just the vertex next door, so every
binding duplicates a spring that already exists: the surface stiffens and the
layers stay free. The first fixture had in-plane spacing (0.5 m) far larger than
the gap (0.06 m), so the exclusion never mattered and removing it still passed.
The fixture is now finer than the shell is thick (0.05 vs 0.08), and the check
compares against the 2-ring of the UNBOUND graph — verified to fail with the
exclusion removed.

⛔ **AND THE ENGULFMENT WARNING CRIED WOLF ON ITS OWN ADVICE.** Told to make the
floor Concave, the user did — and was then warned the cloth was inside it. A
concave/mesh collider is a SURFACE: its triangles are where the geometry is, and
its bounding box says nothing about what fills it. The check now runs only for
shapes that fill their volume (convex, box, sphere, capsule).

### ⛔ AND THE THICKNESS SPRINGS BROKE EDGE CONTACT

*"added more colliders on the scene, half of the cloths started getting
glitched"* — cloths shot out into long thin spikes. The timing was the clue:
`triangleCount` went from **21 to 7 993** across four concave colliders, so the
edge-CONTACT path did real work for the first time since thickness springs
shipped.

A spring's family was readable from two lanes until thickness arrived:

| family | weight | successor |
|---|---|---|
| structural (interior) | 0 | >= 0 |
| structural (boundary) | 0 | **-1** |
| dihedral / bend | 1 | -1 |
| thickness | 0 | **-1** ← indistinguishable |

`collideEdges` asks for structural springs to sweep contact ALONG — and a
thickness spring joins the two faces, so it started sweeping a segment straight
THROUGH the cloth to the opposite side. Against 8 000 triangles that flings
particles.

Thickness springs now carry `SPRING_THICKNESS = -2` in the successor lane. The
normal fan's `w >= 0` test is untouched, contact excludes `w < -1.5`, and a
boundary edge at -1 is still admitted. Two checks pin it — the marker itself,
and that it survives packing into the buffer the shader reads — both verified to
fail when the marker is removed.

**The lesson is the same one this file keeps learning:** a value that encodes a
FAMILY needs its own symbol, not the absence of another field. "Structural with
no successor" meant one thing on Monday and two things on Tuesday, and nothing
complained.

### ⛔⛔ 11 FPS — THE COST IS INHERENT, NOT A BUG

*"we have 11 fps, which means there is something wrong"*. Measured rather than
guessed, with GI idle (14 dispatches):

| | |
|---|---|
| `gpuRenderMs` | **2.23 ms** |
| `gpuComputeMs` | **30.69 ms** |
| `cpuMs` | 8.69 ms |
| verdict | `bound: "gpu"` |

Drawing the scene costs two milliseconds. **The cloth solver costs thirty.**

Three cloths on Sponza's curtains:

| mesh | particles | springs |
|---|---|---|
| Mesh_0_18 | 7 174 | 47 143 |
| Mesh_0_19 | 9 480 | 62 142 |
| Mesh_0_20 | 7 174 | 47 143 |
| **total** | **23 828** | **156 428** |

A 32x32 grid cloth is 1 024 particles at 12 springs. **These are 25x that**, and
the substep loop runs the full six iterations every frame (capped, so there is
no death spiral — `for (... i < 6; ...)`).

**This is the feature working as designed, and the design has a hole:** a mesh
cloth simulates at RENDER resolution. 7 174 particles is the curtain's vertex
count, chosen by whoever modelled it for how it should look, not for what a
solver should carry. Nothing in the pipeline separates the two.

▶ **THE REAL FIX IS A COARSE SIMULATION MESH.** Simulate a decimated proxy
(~1 000 particles) and skin the render mesh to it. `collisionGeometry.js`
already decimates for `concave` colliders, and `simOf` is already the
render-to-sim indirection — it would carry skin weights instead of an identity
map. That is a feature, not a tuning pass, and it is what makes this usable at
scene scale.

**Shipped meanwhile:** the constraint loop's early exit is back. The stride is
the mesh's WORST degree (20) while the median is 13, so running to the end cost
~1.5x on the dominant term. It was removed while the padding was live data —
putting it back then would have been a silent correctness bet; now the tail is
`SPRING_END` and the guard makes the result right, so the break only stops
early. Same in the normal and contact walks.

⚠ **STILL UNEXPLAINED: why some cloths look right and others do not.** All three
analyse `ok` with sane counts. The colours come from textures so the report's
"green works, red and blue do not" could not be mapped to entities from the
material files. Next step is to identify the three by entity rather than by
colour and compare their `gpuBounds` — not to guess again.

### ⭐ THE SOLVER WAS DISPATCH-BOUND, AND THE SUBSTEP CAP WAS SELF-SUSTAINING

The arithmetic was never the problem. Seventeen steps x six substeps x three
cloths is **306 compute dispatches per frame**, each over only ~7 000 threads:

```
2.4 M thread invocations per frame / 30.7 ms  =  79 MILLION invocations/second
```

A GPU does tens of billions. Almost all of that time was pipeline binds and
barriers between dispatches far too small to fill the machine. Making the maths
cheaper could not have helped.

And six substeps was **self-sustaining**: the cap is only reached when a frame
is already slow enough for the accumulator to demand it, so a slow frame bought
the most expensive solve, which kept the frame slow. At 60 fps a cloth needs
exactly two substeps of h = 1/120 — it was the SIX that was aspirational.

The cap is now a work budget in particle-substeps (`SUBSTEP_PARTICLE_BUDGET`,
6 144 = the 1 024-particle grid cloth's six, so that path is untouched;
`__clothSubstepBudget` overrides). A 7 000-particle cloth lands on the floor of
two. Measured live, with the viewport rendering:

| | before | after |
|---|---|---|
| fps | 11-15 | **31** |
| `gpuComputeMs` | 30.69 | **14.73** |
| `gpuMs` | 32.91 | 16.87 |

⚠ The "after" frame had GI mid-rebuild at 79 dispatches, so part of 14.73 ms is
not cloth at all.

▶ **STILL THE REAL FIX: a coarse simulation mesh.** Two substeps of a
7 000-particle solve is a workaround for simulating at RENDER resolution. 102
dispatches is better than 306; ~1 000 particles skinned to the render mesh would
make it a non-issue and restore the six substeps that quality wants.

### ⛔ THE INSTRUMENT PROMISED BOUNDS AND RETURNED NOTHING

`vfx.cloth.status` has advertised *"...and GPU position bounds"* in its own
description, and accepted a `readPositions` boolean, since the day it shipped.
The body never read them. Three consecutive calls with `readPositions: true`
came back with no bounds and **no error**, and I nearly reasoned from that
silence — the exact shape of [[probe-blind-statistics]]: *before believing any
null, can the instrument see its subject?*

It can now, and it reports **per ISLAND, not per entity**, which is the part
that matters. The three Sponza cloth entities hold 3, 4 and 3 disconnected
pieces. The user is describing CURTAINS — *"green cloths both working, while
red and blue are not"* — so an entity-wide box averages a broken piece together
with its healthy neighbours and reports a perfectly ordinary number. Each
island's live box is now put beside its own REST box in the same local space:

```
growth = |live span| / |rest span|      > 3 EXPLODED   < 0.25 COLLAPSED
```

A ratio against the piece's own rest size is the only honest reading — a span
in metres cannot be judged without knowing how big the piece started.

### ▶ AND ONE CLOTH IS CONFIGURED NOT TO COLLIDE

`Mesh_0_19` (9 480 particles, 4 islands) reports `sceneCollision: false`,
`primitiveCount: 0`, `triangleCount: 0`. The other two get the same four
concave colliders and the character capsule. This is an authored component
prop, not a bug — but it means four of the ten visible curtains pass through
every wall and floor in the scene, and no amount of solver work will change
that. ⚠ It is the user's scene data; flipping it is their call, not mine.

### ⭐⭐⭐ CONTACT WAS THE LAST THING THAT HAPPENED, AND NOTHING RELAXED IT

The substep ran **every** Jacobi relaxation pass, then committed, then
collided:

```
integrate, solve x8, commit, collide, collideEdges, commit, collideEdges, commit, collide
                     ^^^^^^^ all eight here            ^^^^ and nothing after any of these
```

A contact moves a particle directly — a character pushing into a curtain, a
wall ejecting a vertex — and the structural springs tying it to its neighbours
were not solved again until the NEXT substep. The stretch had nowhere to go, so
it accumulated. ("after I interact with the cloth via my character, they get
broken as well", user.)

⭐ **And the passes were being spent on the wrong end.** Before collision the
only displacement in the buffer is one integration step of gravity:
g·h² ≈ **0.7 MILLIMETRES** at h = 1/120. Eight passes smoothed sub-millimetre
error while a contact that can move a vertex tens of centimetres in the same
substep got none.

So the passes are **split, not added** — 4 before, 4 after — and the dispatch
count does not move, which matters because this solver is launch-bound. Parity
is what makes it free: `solveA` reads `scratch` → writes `positions`, `solveB`
the reverse, so passes come in A/B pairs and the tail must lead with `solveB`
to land back in `positions`. `previous` is deliberately not rewritten after the
tail — a position projection is *supposed* to change the implied velocity.
`__clothSolveSplit = 8` restores the old order as an A/B arm.

Measured on `Mesh_0_20`, live:

| island | stretch | billow | verdict |
|---|---|---|---|
| 0 | 2.22 → **0.92** | 18.0 → **5.95** | TORN → healthy |
| 1 | 1.67 → **0.89** | 15.3 → **4.91** | TORN → healthy |
| 2 | 1.01 → 1.01 | 4.93 → 3.40 | healthy |

And it got FASTER — fps 31 → **38**, `gpuComputeMs` 14.73 → **12.26** — because
a torn cloth drags a huge bounding box through the collision BVH.

⚠ **My own substep budget made this worse before it was found.** Cutting 6
substeps to 2 gave the un-relaxed contact error a third as many chances to
heal. The reorder is what makes the cut safe.

### ⛔ A FLAT BAND CANNOT HOLD A HEM THAT IS NOT FLAT

The curtains are modelled DRAPED OVER THEIR ROD, so the top edge is a wave, not
a line. Measured on all three cloths: the hem rises and falls **8.4–11.4 cm**
while `PIN_BAND` of a 2.26 m drape is **4.5 cm**. Only the crests were held —
**38–47 of 60 columns** — and every unheld column sagged away between two
pinned neighbours. That is the sawtooth along the top of the curtain the user
photographed, and no solver work could ever have fixed it: those vertices were
never attached to anything.

The band is now sized from the hem's own measured relief (`PIN_HEM_HEADROOM`),
floored at `PIN_BAND` and capped at `PIN_BAND_LIMIT`. **60/60 columns held on
all ten islands.** A flat-topped banner has no relief and keeps the tight band
— which is what protects the 11 m banner that a blanket widening broke before.

### ⛔ REFUTED: the closed shells are not the rods

`Mesh_0_6` really does carry certified closed sub-shells, and the story wrote
itself: a curtain wrapped over a rod would start inside a solid and be ejected
every frame. Certifying them offline puts them at
`[-8.386, 3.944, -2.545] → [7.341, 4.062, 1.948]` and the same box at y 7.32 —
two **15.7 × 0.12 × 4.5 m slabs, the gallery FLOORS** — and not one curtain
vertex lies inside either. The arm (`__clothClosedContact`) is kept so the next
person need not guess either.

### ⛔ REFUTED: wind is not what bunches the two bad curtains

The pattern looked decisive — both bad pieces sat at z ≈ +2.05/+2.10 and every
piece at z ≈ −2 was clean, and wind pushes along +Z, so the bad ones were the
ones being pressed INTO the wall behind them. Setting `wind = 0` on `Mesh_0_18`
and re-reading:

| island | billow, wind 2 → 0 | Y span |
|---|---|---|
| 1 | 2.95 → **1.36** | 2.268 → 2.270 (correct) |
| 2 | 2.90 → **1.45** | 2.263 → 2.267 (correct) |
| **0** | 5.09 → 4.39 | 1.580 → **1.463 (still short)** |

Wind is exactly what makes the healthy ones billow, and removing it does not
free island 0 — it gets slightly SHORTER. Not wind.

▶ **STILL OPEN — two of ten pieces hang ~35 % short.** `Mesh_0_18` island 0
and `Mesh_0_20` island 1, both with their bottom edge held around y ≈ 0.80
(sim-local) instead of reaching the floor, and both riding ~0.34 m higher at
the centre than their healthy neighbours. Searching all four concave colliders
for any surface between y 0.2 and 1.6 under their footprints found **nothing**
— so it is not a ledge they are draped on, at least not in the space those
coordinates were compared in. ⚠ `readClothPositions` reports SIM-LOCAL
coordinates and the collider `.geom` files are in their own local space; the
comparison assumed the parent `xjxbsGoSey` is identity and that is NOT
verified. Check that before trusting the null.

⛔ Node trap while doing it: `fs.readFileSync(...).buffer` is a SHARED POOL, so
a small file sits at a non-zero `byteOffset` and `.buffer.slice(0)` hands back
the pool rather than the file. `Mesh_0_9` (21 triangles) threw "Unsupported
geometry container version 0"; the large ones had silently been fine.

### ⭐⭐⭐ A CONTACT CANNOT BE THICKER THAN THE CLOTH IT PUSHES

*"its like those curtains are fighting themselves"* (user) was the clue, and it
is literally true.

A shell cloth has two faces. A contact pushes whatever it touches to
`collisionRadius` clear of the collider — **both faces, independently** — so a
shell needs `2 × radius` of its own thickness. And the thickness springs are
**distance-only**: they are exactly as satisfied with the shell inside-out, at
precisely the same rest length. Nothing ever un-inverts it.

Measured on Sponza at the authored `collisionRadius` of 0.03 (a 0.06 m demand):

| island type | median shell | thinner than the contact DIAMETER | thinner than the RADIUS |
|---|---|---|---|
| 2434-vertex | 0.0577 m | **68 %** | 1 % |
| 2306-vertex | 0.0274 m | **83 %** | **68 %** |

Every curtain in the scene was one touch away from inverting. The two that
looked wrong were simply the two the character had walked into — which is why
identical geometry behaved differently in different bays, and why the ones with
`sceneCollision` off were all fine.

`clothContactRadiusLimit` = `shellThickness × 0.4`, from the **10th percentile**
of the thickness springs, not the median — the constraint has to hold where the
shell is thinnest. Sponza: **3.00 cm authored → 1.09 cm applied**, with a note
in the inspector so a silently-ignored setting does not become the next bug
report.

### ⛔ THREE REFUTATIONS ALONG THE WAY

- **Wind.** Both bad pieces sat at z ≈ +2 and wind blows +Z, into the wall
  behind them. Setting `wind = 0` freed nothing (island 0 got *shorter*).
  ⚠ And the test was WEAK: the prop changed but the cloth was never reset, so
  it only showed wind is not what HOLDS the tangle, not that wind did not cause
  it.
- **Fold-to-fold thickness springs.** Plausible — a deep-folded curtain could
  pair a vertex with the next fold rather than the far face. Measured: the
  springs are 0.03–0.14 m, **0.3–0.6× the mesh edge**. Genuine shell springs.
- **Colliders intersecting the rest pose.** A vertex-in-box test found 12
  triangles under two islands and looked decisive; ⛔ a vertex test MISSES THE
  WALL, since one large triangle passes through a thin curtain with all three
  corners outside. Proper triangle-box overlap gave 42 for a BAD island and 42
  for a GOOD one. No signal.

⭐ The tell that broke it open: the islands are **geometrically identical**
across the three meshes (the same 3032-spring and 2420-spring variants
repeated), yet a different one fails in each. So the cause could not be
topology — it had to be history, and the only history is what touched them.

### ⭐⭐ SPRING STRAIN OUTRANKS EVERY BOX READING

⛔ The box had a THIRD blind spot, after the diagonal and the maximum: **it
cannot tell BLOWING from CRUMPLED.** 2.26 m of fabric swinging out at 30° in
the wind measures 1.9 m tall and scores `gather` 0.84 while every thread in it
is at exactly its rest length. The extents are a function of POSE as much as of
damage — change the `wind` prop and they move.

Strain is not. Each structural spring has an authored rest length, and
`|live − rest| / rest` reads the same however the cloth is oriented. So the
verdict now answers to strain first, and the box only breaks ties.

Live Sponza, after the contact-radius cap:

| island | mean strain | worst spring | box said |
|---|---|---|---|
| 0 | 0.073 | **4.70 — 5.7× its rest length** | "healthy" at gather 0.76 |
| 1 | 0.074 | 1.34 | healthy |
| 2 | 0.024 | 0.62 | healthy |

⚠ Even the CLEANEST island carries a spring 62 % over rest and a mean of 2.4 %,
against a `stiffness` of 0.95. That is not damage, it is **Jacobi not
converging**: 4+4 passes at two substeps is not enough for a 7 000-particle
sheet. ▶ The coarse simulation mesh would fix the convergence and the cost at
once — far fewer particles means the same passes propagate much further.

⚠ `strainOf` filters bend springs by `weight > 0.5`, but THICKNESS springs also
carry weight 0, so they are counted as structural. Arguably right (a thickness
spring at 5.7× means the shell HAS been pulled open) but it is not what the
field name says. Separate them via the `-2` successor lane before quoting these
as pure structural numbers.

### ⭐⭐⭐ IT WAS DIVERGING, NOT UNDER-CONVERGING — LONG-RANGE ATTACHMENTS

Splitting the strain by spring type is what made it legible. THICKNESS springs
also carry weight 0, so the first strain reading called them structural and
said "the cloth is torn" for what might have been a shell problem. Split:

| island | **structural** worst | shell worst | trend |
|---|---|---|---|
| 0 | **15.01** (16× rest) | 3.27 | was 4.70 — **rising while watched** |
| 1 | 1.44 | 0.56 | stable |
| 2 | 0.65 | 0.24 | stable |

It is the STRUCTURAL springs, and island 0 got worse between two readings
minutes apart. **That is divergence.** More passes cannot fix a diverging
solve, and the coarse sim mesh would only have moved the threshold.

Why it diverges: a Jacobi pass propagates a constraint **one ring**. This
curtain is ~60 rings from its pinned hem to its bottom edge, and the solver
runs 8 passes over 2 substeps — so the pin's influence *physically cannot*
reach the hem within a frame. Gravity pulls every frame; the pin answers sixty
frames later; the error compounds.

**Long-range attachments** (Kim, Chentanez & Müller-Fischer 2012) bound it
without iterating: a particle can never be further from its pin than the fabric
between them is long. That distance is a property of the MESH — multi-source
Dijkstra from every pinned vertex over the mesh edges, computed once — and it
is enforced in ONE step however far the pin is. It lives inside the existing
constraint kernel, so it costs **no extra dispatch** in a launch-bound solver.

⚠ GEODESIC, not straight-line: a straight-line limit lets a curtain hang
*through a wall* to reach its pin. ⚠ `LRA_SLACK = 1.02`, because clamping to
the taut length holds every particle out on a rigid string — a draped sheet is
always slightly shorter than its own fabric.

⛔ The first version of the test suite passed with `LRA_SLACK = 1e9`. Structure
alone (every particle has a pin, the distance is geodesic, islands do not cross)
says nothing about whether the limit ever ENGAGES. The added test asserts the
bottom row's limit hugs the sheet height, and fails against the slack version.


### ⛔ LRA SHIPPED ON AND MADE IT WORSE — NOW OFF BY DEFAULT

Live result with long-range attachments enabled: **all three** islands hoisted,
centres at y 2.56-2.66 against 1.11 hanging correctly, each squashed to ~0.96 m
of a 2.26 m drop and all three reported TORN. That is strictly worse than the
one-diverging-island it was built to bound. It is now behind `__clothLra`,
default OFF.

⛔ AND THE FIX I REACHED FOR FIRST WAS NOT THE BUG. Running Dijkstra over the
merged graph does walk BEND and THICKNESS springs, which are genuine shortcuts,
and restricting it to structural edges is right — but measured on the real
curtain, **both variants satisfy the rest pose at all 7 174 vertices** (0
violations, furthest vertex 2.192 m from its pin against a 2.250 m limit). The
filter is kept because it is correct; it is NOT the explanation, and the plan
doc said so before the code did.

▶ The remaining suspect is the APPLICATION, not the analysis. The constraint is
a hard projection applied inside every Jacobi pass — 8 per substep — with no
relaxation. Over-relaxing a constraint that always pulls toward a single point
pumps energy toward that point, which is exactly the observed hoisting. Next to
measure: apply it ONCE per substep (after the last pass), or with a relaxation
factor matched to the pass count.

⚠ The test suite passed the whole time, and would have again: it checks the
ANALYSIS (geodesic, per-island pins, tight limit, rest pose admitted) and
nothing about how often the projection runs. A solver-behaviour claim needs a
solver-behaviour test.

### ⭐⭐⭐ ONE CURTAIN WAS SPEAKING FOR ANOTHER (user's diagnosis, and it was right)

*"this issue is related to the fact that both curtains sit on the same
geometry. One works well, another one does not."*

`shellThickness` — which caps the contact radius — was reduced over **the whole
`.geom`**, and a curtain file holds several pieces:

| | shell | radius cap |
|---|---|---|
| island 0 alone | 5.47 cm | 2.19 cm |
| island 1 alone | **2.74 cm** | **1.09 cm** |
| island 2 alone | 5.47 cm | 2.19 cm |
| all three together | 2.74 cm | **1.09 cm for all of them** |

So two curtains that could safely carry a 2.19 cm contact ran at 1.09 cm —
**half the contact they needed, because of a different curtain elsewhere in the
same file.** Too small a radius misses contacts, which is how a curtain gets
into the wall it then cannot get out of.

Fixed per island, with a per-PARTICLE `contactRadius` buffer, because a uniform
cannot express a quantity that varies between the pieces of one geometry.

▶ **THE GENERAL RULE, and the audit it demands: any quantity describing A CLOTH
must be reduced over that cloth's own island, never over the asset.** Survivors
of the audit, both accept/reject gates rather than per-frame behaviour, so
neither is causing this — but both are the same shape and should be made per
island before someone hits them:

- the thinness gate takes the WORST island, so one solid piece in a file
  rejects every curtain in it;
- `CLOTH_MAX_PARTICLES` counts the whole file, so enough small pieces reject
  each other.

Genuinely per island already: the thickness-spring search radius, the pin band
and its hem relief, and the long-range attachment graph.

### ⭐⭐⭐ THE TWO-SIDED CONTACT IS BISTABLE, AND THE WRONG STATE IS STABLE

`projectClothMeshContact` chose its side from `d0` — where the particle WAS.
That is right for a floor you can legitimately be under, and catastrophic for a
wall a curtain is pressed against: once a particle ends up behind the wall its
`old` is behind too, so contact dutifully pushes it BACK behind, every substep,
forever. Its neighbours stay in front and the spring between them spans the
wall for good.

It fits every observation: identical geometry with identical caps, one torn and
one clean; the torn one hanging in a recessed alcove with the wind pressing it
into the back wall, the clean one hanging free in front of an arch; the tear
never recovering; and disabling `sceneCollision` making every piece clean.

⛔⛔ AND THE OBVIOUS FIX IS REFUTED, MEASURED, ON THE LIVE SCENE. Taking the
side from the triangle's WINDING assumes a cooked collider is wound
consistently. Sponza's are not. It shipped as the default for one reload and
made **every** island worse — the previously PRISTINE one worst of all:

| island | mean strain | worst spring |
|---|---|---|
| 2 (was pristine) | 0.014 → **0.174** | 0.30 → **17.25** |
| 0 | 0.077 → 0.171 | 7.24 → 21.98 |
| 1 | 0.091 → 0.124 | 1.41 → 12.48 |

A wrongly wound triangle pushes cloth INTO the wall, and a decimated collider
has enough of them to wreck every piece. Reverted; `__clothOneSidedContact`
opts in for geometry known to be clean.

⚠ "Prefer the front unless BOTH ends are behind" was tried first and is not
even a candidate: a stuck particle has both ends behind, which is the entire
condition.

▶ **THE BISTABILITY IS REAL AND STILL UNFIXED.** What it needs, and what I did
not have: a CPU model of the CONTACT, the way `relaxPass` models the constraint
solve. Two speculative solver changes shipped and were reverted in one session
(`__clothLra`, then this). The lesson is the method, not the hypotheses — build
the model first, and the candidate has to survive a fixture with a
deliberately mis-wound triangle in it before it goes near the scene.

### ⚠ STRAIN LIMITING HELPS, AND IS NOT THE FIX — THE NUMBERS SAY SO

Provot strain limiting went in alongside, inside the existing constraint loop
(no extra dispatch). Measured on a held-particle fixture, worst structural
stretch:

| passes | 8 | 24 | 60 | 400 |
|---|---|---|---|---|
| no limit | 4.69 | 3.63 | 2.91 | 1.98 |
| limit 1.5 | 4.11 | **2.71** | 2.08 | 1.73 |
| limit 1.2 | 4.28 | 2.92 | 2.22 | 2.08 |
| limit 1.05 | 4.61 | 3.21 | 2.91 | 2.27 |

⛔ It never reaches the bound, and a TIGHTER limit is WORSE. Jacobi divides
each particle's correction by the number of VIOLATED springs, so once many are
violated their corrections point in different directions and average into mush.
That is the method, not a tuning mistake. It is kept as a safety BOUND — the
damage from any future bad contact is capped instead of unbounded — and the
test asserts the measured 15 % improvement rather than the bound I first
claimed.

⚠ It is LOCAL, which is the whole safety argument against repeating the
`__clothLra` hoist: a neighbour-to-neighbour projection has no attractor, and a
test asserts the cloth's centre of mass does not drift over 40 passes.

⭐ THE METHOD NOTE: this file now carries a CPU model of `constrainMesh`
(`relaxPass`). After LRA shipped with five passing tests and hoisted every
curtain, the rule is explicit — **a claim about solver behaviour needs a
solver, not an analysis check.** Both fixtures here were wrong on the first
try and said so: a particle merely nudged is pulled home in one substep by a
dozen neighbours, and monotone decrease is the wrong convergence assertion once
the limiter stops acting.


### ⛔⛔ STRAIN LIMITING PRODUCED NaN — OFF BY DEFAULT

One reload with it on and `vfx.cloth.status` reported **2 128 of 7 174
particles non-finite**: a whole island reduced to its 306 pinned vertices, the
rest with no position at all.

The arithmetic says how. Both ends of a violated spring move by HALF the excess
in the same Jacobi pass, which exactly closes it — but when `len` is far past
`rest x maxStretch` the excess approaches `len` ITSELF, so the two ends each
travel half the gap, MEET, and the soft spring correction applied in the same
pass carries them through one another. Flip, grow, repeat.

⛔⛔ **AND THE CPU TEST BLESSED IT.** Every fixture in the suite HOLDS one end —
which was the point, since the failure being modelled is a contact re-pushing a
particle. With one end fixed only half the closure happens and it converges
neatly. The diverging case is FREE-FREE at large stretch, and there was no
fixture for it. *A test that only exercises the case a fix was designed for
will bless the fix.* One now asserts the divergence, so re-enabling
`__clothMaxStretch` means making it pass first.

### ▶ THE SESSION'S SCORE, HONESTLY

Landed and measured:
- contact reordered around the solve (4/4 split) — 18x → 2.3x, 31 → 38 fps;
- the pin band follows the modelled hem — 60/60 top columns held;
- the contact radius is capped by the shell, **per island** (the user's own
  diagnosis) — island 2 went 0.028 → 0.014 mean strain, 0.76 → 0.30 worst;
- the instruments: per-island bounds, strain split by spring family, and a CPU
  model of the constraint solve.

Reverted after measuring worse, all behind flags:
- `__clothLra` long-range attachments — hoisted every curtain;
- `__clothOneSidedContact` winding-based side — cooked colliders are not
  consistently wound; wrecked even the pristine island;
- `__clothMaxStretch` strain limiting — NaN.

⚠ **Three speculative solver changes in one session, all reverted.** The common
cause is not bad hypotheses, it is that there is no offline model to test a
CONTACT change against — only the constraint solve has one (`relaxPass`). The
next contact change should not be attempted before that model exists, with a
fixture carrying a deliberately mis-wound triangle and a free-free pair.

### ⭐⭐⭐ THE MODEL CORRECTED THE DIAGNOSIS, AND THEN GAVE THE FIX

`tests/cloth-contact.test.mjs` now carries `contactPass`, a CPU model of
`projectClothMeshContact` minus the BVH. It was built after three shipped-and-
reverted attempts, and the first thing it did was **contradict the story those
attempts were built on**.

⛔ The description was: *"contact pushes the particle back to whichever side it
came from, so one that ends up behind a wall is held there."* It does not push
it anywhere. A particle further behind a wall than the contact radius is **not
touched at all** — the swept test finds no crossing (it did not cross during
this step) and the face test finds it outside the slab, so contact abandons it
and the spring to its neighbours in front spans the wall for good.

**The fault is DETECTION, not side selection.** No amount of reasoning about
`side` could have reached that, which is exactly why both side-selection fixes
failed against a live scene.

▶ **THE FIX: sweep from the last position contact CERTIFIED**, not from
`previous` (`clothSafe`, `__clothSafeSweep`). In ordinary motion the two are
the same value, so the sweep is bit-for-bit what shipped before and there is no
second traversal; they diverge exactly when a particle has been moved somewhere
invalid without contact seeing it — which the substep can inflict on itself
through the relaxation passes that follow the last `collide`.

⭐ It consults NO winding and makes no global decision. The seed is the cloth's
REST pose, so *"which side does this cloth belong on"* is answered by how the
asset was authored — the actual question, and one a triangle normal was the
wrong way to ask.

⚠ The safe position records the RESOLVED point, never merely wherever the
particle ended up: an unchecked one would poison the origin after a single
undetected tunnel and recovery could never fire again. There is a test for it.

⛔ And the mis-wound-triangle fixture — the one whose absence cost a live
regression — only bites where the bad face is the ONLY one covering the
particle. Written at the quad's centre first, it PASSED, because the correctly
wound triangle also covers that point and wins on earliest contact time. A
fixture can reproduce the geometry and still not reproduce the bug.

### ⚠⚠ THE SAFE SWEEP SPLITS THE SCENE EXACTLY IN HALF — OPT-IN

Measured live on all six curtains that have scene collision:

| side | curtains | strain |
|---|---|---|
| free-hanging (−Z) | **3 of 3 HEALTHY** | **0.015 – 0.020** |
| wind-pressed (+Z) | 3 of 3 torn | hoisted to centre y ≈ 3.0 against 1.13 |

Those healthy numbers are the best of the entire session — an order of
magnitude better than anything before them (previous best 0.014, typical
0.028–0.09). And the split is perfect by side, which says what is wrong rather
than leaving it to be guessed:

⛔ `safe` is written in `collide`, and **four relaxation passes run after the
last one**. The origin therefore lags the particle by those passes, so the
sweep is longer than the motion it describes — long enough, for cloth already
lying against a wall, to cross triangles the particle never actually crossed
and be ejected up the wall's face. Free-hanging cloth sweeps across nothing, so
it gets the fix with none of the cost.

▶ Two candidates, both testable against `contactPass` before they go near the
scene:
- update `safe` after the tail passes as well, so it cannot lag;
- keep `old` as the primary origin and consult `safe` only as a FALLBACK when
  the primary finds nothing — one extra traversal, in the rare case only.

⚠ Net count is worse (5 broken vs 2–3), so it is off by default and the scene
is back to the previous behaviour. The finding is kept because it is the first
change all session to make any curtain measure genuinely correct.

### ⭐ THE COLOURS, AT LAST — AND "RED DOESN'T INTERACT" IS AUTHORED DATA

Material colour is `#cacaca` on all three curtain materials; the colour is in
the diffuse TEXTURE, which is why no amount of reading `.mat` files mapped
entity to colour all session. Settled by pointing the viewport at a curtain
whose entity id was known:

**`Mesh_0_19` is RED — and it is the one with `sceneCollision: false`.**

So *"red curtains don't interact with character"* is exactly right, and it is
not a bug: those four curtains collide with nothing at all. ⚠ Turning it on
will subject them to the contact fault that breaks the others, so it is the
user's call, not a silent fix.

### ⛔ REFUTED: "fighting themselves from the beginning" is not the topology

Two offline tests, both negative:

- **Rest-pose contact.** Only **0–4 of 2434** vertices per island are within
  the contact radius of a collider at rest (nearest collider 0.35–1.58 cm
  against a 1.09–2.19 cm cap). The curtains do not start inside the walls.
- **Rest-pose equilibrium.** Relaxing the authored pose with no gravity, no
  wind and no contact moves it by **0.000 mm over eight passes**, on both
  meshes. The spring system — structural, bend AND thickness — is exactly
  satisfied by the pose it was measured from, so the cloth is not fighting
  itself before anything touches it.

▶ Whatever "from the beginning" is, it develops within the first frames of
motion, and the discriminator is unchanged and now confirmed on every reading
this session: **wind is +Z, and every curtain the wind presses INTO nearby
geometry breaks while every curtain it blows into open corridor is clean.**

| side | wind pushes it | result, every reading |
|---|---|---|
| z ≈ +1.6 | into the arcade behind it | torn |
| z ≈ −2.2 | into the open corridor | healthy (0.015–0.020) |


### ⭐⭐⭐ THE MODEL FOUND THE OVER-FIRE, AND THE FALLBACK FORM SHIPS

The split result was not a tuning problem. `contactPass` reproduces the cause
in a corner fixture: a LONGER sweep reaches triangles the short one never came
near, `remember` keeps the EARLIEST crossing, and the push is then measured
against THAT triangle's plane —

```
penetration = radius - dot(point - anchor, normal)
```

— so a crossing picked up on a perpendicular alcove wall a metre away is a
metre-sized shove. Measured in the fixture: **5x the displacement** of the
shipped sweep, on a particle sitting quietly against the back wall.

So the origin is NOT replaced. The ordinary sweep from `previous` keeps first
refusal and is untouched; the safe origin is consulted **only when it finds
nothing** — the stranded case and nothing else — and only when the particle has
drifted from its certified position by more than a contact radius. On a settled
cloth that drift is sub-millimetre and the recovery never runs; a relaxation
pass shoving a particle through a wall always exceeds it. That guard is also
what keeps the cost off the common path in a solver that is launch-bound.

Four tests pin it: ordinary contact is bit-for-bit what ships, a stranded
particle is recovered, cloth authored under a floor stays under it, and a free
particle advances its own safe position so the staleness cannot grow.

⭐ THE METHOD, VINDICATED: this is the first change all session designed
entirely against the CPU model and only then shipped — after three that went
the other way round and were reverted.

### ⛔ REFUTED: the residual strain is NOT under-convergence from the substep cut

Forced back to six substeps (three times the constraint iterations) and
re-measured on `Mesh_0_20`:

| island | 2 substeps | 6 substeps |
|---|---|---|
| 0 | 0.060 / 1.87 | 0.057 / 1.58 |
| 1 | 0.149 / 2.48 | 0.109 / 1.41 |
| 2 | 0.035 / 1.95 | 0.056 / 1.62 |

**Tripling the iterations barely moves it, and island 2 got worse.** So the
residual mean strain is a force balance, not an iteration shortfall — a hanging
cloth with finite stiffness carries its own weight by stretching, and ~6 % may
simply be what that looks like. ⚠ Which also means the coarse simulation mesh
would buy FRAME RATE but not this; do not sell it as a fix for the look.

⚠ And it puts `MEAN_STRAIN_LIMIT = 0.05` in doubt: it was set from a single
reading of the most relaxed island in the scene, so the current TORN verdicts
may be false positives.

### ⭐⭐⭐ "FIGHTING THEMSELVES" IS ABOUT MOTION, AND EVERY INSTRUMENT MEASURED SHAPE

Bounds, strain and the verdicts all describe one frozen frame. A cloth that is
the right size, in the right place, with springs near rest scores perfectly
while buzzing — which is the user's report, and what a whole session of "the
numbers say it improved" kept walking past.

The readback now carries per-island MOTION between two successive calls, and
the useful figure is not speed but COHERENCE:

```
coherence = |mean displacement| / mean |displacement|
```

- **1.0** — every particle moving the same way: wind, a swing, a settle.
- **0.0** — pure disagreement: the springs sawing against each other.

A curtain in wind moves a long way and moves TOGETHER. A cloth fighting itself
moves just as far with its particles pulling against one another, so the
vectors cancel and the ratio collapses. Speed alone cannot tell those apart,
which is why no previous number could see the complaint.

### ⭐⭐⭐ THE MOTION INSTRUMENT FOUND IT IN ONE READING

| island | mean move | max move | **coherence** | strain |
|---|---|---|---|---|
| 0 | 12.3 mm | 43 mm | **0.96** | 0.055 |
| 1 | **253.8 mm** | **1205 mm** | **0.56** | 0.795 |
| 2 | 15.4 mm | 45 mm | **0.99** | 0.055 |

Islands 0 and 2 sway together in the wind and their 0.055 strain is gravity
sag. Island 1 moves twenty times as far with **half its motion cancelling
out** — the fighting, isolated to one piece, in the first reading the new
instrument ever produced.

### ⛔⛔ AND THE CAUSE WAS MY OWN PERCENTILE

The constraint is `2 x radius <= shell`, so **every thickness spring below the
chosen percentile is GUARANTEED to have its two faces driven through each
other**, and each is a permanent inside-out patch. `SHELL_PERCENTILE = 0.1` was
picked without ever checking what it left behind:

| percentile | thin island | thick islands |
|---|---|---|
| 10 % | cap 1.09 cm → **30 inverting** | cap 2.19 cm → **142 inverting** |
| 5 % | 1.09 cm → 30 | 1.85 cm → 78 |
| 2 % | 1.09 cm → 30 | 1.43 cm → 2 |
| **1 %** | 0.55 cm → **0** | 1.15 cm → **0** |

Thirty guaranteed inversions is more than enough to wreck a curtain, and island
1 is exactly the piece carrying them. Now 1 %, with a test asserting the
invariant directly — *nothing* thinner than twice the cap.

⚠ Not the strict minimum: one degenerate pair would collapse the cap to nothing
and disable contact for the whole piece.

⛔ THE FIXTURE FAILED FIRST, TWICE OVER. `shell()` spans x from 0 to 2 and the
thin strip was squeezed at `x < -0.6`, so the geometry was never touched and
the test passed at BOTH percentiles while proving nothing. And the strip has to
be NARROWER than the percentile under test, or the percentile lands inside the
thin group and the cap comes out small by luck. Fixed, it now leaves **54 of
862 springs inverting at 10 % and zero at 1 %**.

### ⚠ THE PERCENTILE FIX IS REAL BUT NOT SUFFICIENT — IT VARIES BY RUN

`Mesh_0_20` after the fix: island 1 went 0.795 → 0.114 strain, coherence
0.56 → 0.97. A later reload of `Mesh_0_18`: island 1 at strain **0.802**,
`shellStrain` **1.661**, `worstShell` **19.97** — the same signature as before.
Same code, different run. So the inversion is intermittent, not eliminated, and
a single good reading is not evidence of a fix. ⚠ Judge this only across
several reloads.

### ▶ NEXT, AND SMALLER THAN THE COARSE MESH: SIMULATE THE MID-SURFACE

Every remaining failure is the SHELL tearing, and the geometry says why:

```
shell thickness   1.4 - 2.9 cm
mesh edge         ~9 cm
```

**The two faces are six times closer together than the triangles are wide.**
Simulating that as two independent sheets held apart by distance-only springs
is the problem itself — no contact radius can be small enough to be safe when
the faces are that close, and the cap is already down to 0.55 cm.

So collapse it. The thickness springs ALREADY identify every front/back vertex
pair, so:

1. pair each front vertex with its back vertex (`buildThicknessSprings` output);
2. simulate the MIDPOINT — ~3 600 particles instead of 7 174;
3. reconstruct both render faces by offsetting along the surface normal.

That removes shell inversion as a CATEGORY — there is no second face left to
invert — halves the particle count, and reuses machinery that already exists
and is tested. It is materially smaller than the decimate-and-skin coarse mesh,
and it does not need skin weights or per-particle frames.

⚠ It changes what a "cloth" IS for a shell asset, so it wants the user's
go-ahead, and it should be built against the CPU models (`relaxPass`,
`contactPass`) before it goes near the scene — the way the last two fixes went,
and the three before them did not.

### ⭐⭐⭐ SHIPPED: A SHELL IS SIMULATED AS ITS MID-SURFACE

Sponza's curtains are shells **1.4–2.9 cm thick built from triangles ~9 cm
wide** — the two faces are six times closer together than the triangles are
wide. A contact pushes BOTH faces clear of a collider, so it needs `2 × radius`
of thickness; at 1.4 cm no radius is small enough. The cap was already down to
0.55 cm and the shell still tore (`worstShell` 19.97, mean shell strain 1.661).
That is not a setting to tune, it is the wrong thing to simulate.

Each front vertex is now paired with its back vertex, the pair is simulated as
ONE particle at their midpoint, and the render mesh rebuilds both faces by
stepping along the surface normal the lighting already uses — so the thickness
follows the cloth as it folds rather than being frozen into it. Measured on the
real assets:

| | before | after |
|---|---|---|
| particles | 7 174 | **4 139** |
| thickness springs | 4 242 | **57** (rim only) |
| contact cap | 0.5–1.2 cm | **2.5–3.3 cm** |

**There is no second face left to invert.** And the contact cap stops being a
constraint at all, because it was only ever tight to protect a shell that no
longer exists.

⭐ THE IMPLEMENTATION IS A RE-ENTRY, not a parallel path: the analysis calls
ITSELF on the collapsed mesh, so springs, pinning, islands and the cap are all
recomputed by the same code. `simOf` is re-pointed through the collapse and
each render vertex carries a signed offset.

⚠ ONLY MUTUAL PAIRS COLLAPSE. `buildThicknessSprings` gives each vertex its own
nearest partner and that is NOT symmetric — v can choose u while u chooses w.
Collapsing a chain would weld three vertices into one and pucker the sheet.

⚠ THE RIM LEGITIMATELY SURVIVES: the stitching triangles make each rim vertex a
real topological neighbour of its opposite number, so it is never paired. A
small fixture is dominated by its rim (an 8×8 shell goes 162 → 115, which looks
like a poor collapse and is not one) — the first version of the test asserted
0.62 against exactly that and failed for the right reason.

⚠ Every other shell test in the suite now has to ask for `midSurface: false`,
so a test asserts the collapse is ON BY DEFAULT — otherwise it could be
disabled by accident and the suite would stay green.

### ⛔⛔ THE MID-SURFACE SHIPPED WITH EVERY BACK FACE LIT INSIDE-OUT

*"lighting on those also got broken"* (user), immediately, on the very next
look at the scene.

The fan normal belongs to the MID-SURFACE. That is right for the face on the
+offset side and **exactly backwards** for the face on the −offset side, so
half of every curtain was shaded as though it faced the other way. The offset's
SIGN is precisely which side a render vertex is on, so the normal now carries
that sign.

⚠⚠ **AND THE WHOLE SUITE PASSED THROUGH IT.** 64 topology tests, 25 health, 16
contact — and not one of them looks at a NORMAL. Every test written for this
feature checked geometry: particle counts, midpoints, offsets equal and
opposite, triangles non-degenerate, render indices in range. The reconstruction
was verified as *positions* and shipped without anyone asking how it would be
LIT.

▶ The same blind spot is why this took a user screenshot to find, twice over —
once for shading and once for the flap artifacts inverted normals produce on a
single-sided material. **A change that moves render vertices needs a shading
check, and the suite has no way to make one.** The nearest available guard is
that both faces produce offsets of opposite sign, which is asserted — but it
says nothing about what is done with them downstream.

### ⭐⭐⭐ THE OTHER WAY ROUND: SPLIT THE GEOMETRY, NOT THE SOLVER

`geometry.splitIslands` (op + MCP, `src/engine/geometryIslands.js`,
`tests/geometry-islands.test.mjs`).

An imported model routinely packs unrelated surfaces into one mesh — Sponza
ships its curtains three and four to a `.geom` — and every per-object decision
then has to be made for the GROUP: one cloth component for three curtains, one
collider, one enabled flag. Worse, anything DERIVED from the mesh is derived
from all of them at once, which is the whole class of bug this session kept
hitting (**one thin curtain in a file dragged every other curtain's contact
radius to half what it needed**).

Splitting removes the class rather than working around it: each piece becomes
its own entity carrying the original's components, transform, parent and tags,
so a split curtain arrives with its cloth and collider already configured.

⛔⛔ **ISLANDS COME FROM WELDED POSITIONS, NEVER FROM INDICES.** A model with UV
seams or split normals stores the same point several times — Sponza's curtain
has 7 739 vertices for 7 174 distinct positions — and index connectivity would
call every seam a separate piece, shattering one curtain into dozens of
ribbons. ⚠ And a quantised hash key alone is not a weld: two points a fraction
of an epsilon apart can land either side of a cell boundary and never be
compared, so the 27-cell neighbourhood search is what makes the epsilon mean
what it says. Both are pinned by tests.

⭐ CROSS-CHECK: the splitter and the cloth analysis are independent
implementations and they agree exactly — 3, 4 and 3 pieces on Mesh_0_18/19/20.

⚠ **IT DEFAULTS TO A DRY RUN, and that came from the data.** Sweeping the
scene, `Mesh_0_6` is 28 pieces and **`Mesh_0_1` (the vines) is 671**. Splitting
that blind would create 671 entities. `apply` is false by default and
`maxPieces` (32) refuses beyond that until raised deliberately.

⚠ Edit-mode topology (`editMesh`, `edges`, `hiddenEdges`) is dropped — it is
indexed against the original vertex numbering and remapping it wrong would
corrupt the mesh the moment Edit Mode opened it. `droppedEditTopology` reports
when it happened.

⛔ THE GLUE BUG THE UNIT TESTS COULD NOT SEE: `loadGeometryAsset` returns a
THREE.BufferGeometry, NOT the asset definition. Handing it to the splitter gave
an object with no `positions`, which reported a confident *"single connected
surface"* for a mesh that is three — a wrong ANSWER rather than an error. Found
by running it live, which is the only place op glue is exercised.

### ⭐ SPLIT IS AN ASSET OPERATION, AND EVERY USER OF THE ASSET FOLLOWS

The first version split the ENTITY that was clicked. That is wrong the moment an
asset is instanced: splitting the `.geom` and updating one entity leaves every
other user pointing at a mesh that no longer describes what they are. So the
operation takes an asset (by `path`, or via any `entityId` that references it),
splits the file into one `.geom` per piece, and replaces **every** entity using
it with one entity per piece **under that entity's own parent**. Five instances
become five sets of pieces, not one.

⚠ Stored asset paths MIX SEPARATORS — the scene holds
`C:\Users\...\GAME/sponza2/Geometry/Mesh_0_20.geom` — so matching users by a
plain string compare would silently miss the very entities the operation exists
to update. Normalised on both sides.

Exposed in the three places a person would look, all routing through
`splitGeometryIslandsWithPrompt` so the question is asked identically:

- the `.geom` context menu in the Assets panel (`assetActions.js`);
- a mesh entity's context menu in the Hierarchy, single selection only and only
  when there is a `.geom` behind it — otherwise it is a menu entry that can only
  fail;
- the Mesh component's own menu in the Inspector, where someone looking at the
  geometry field is already standing.

⚠⚠ **THE CONFIRMATION IS THE FEATURE, NOT POLITENESS.** Piece count is invisible
until measured, and the real number is pieces x users. The dry run always runs
first and the dialog shows its counts, because nobody should discover 671 by
watching their hierarchy fill up. ⚠ The count is deliberately NOT computed while
building the menu: welding a whole mesh to label a right-click would stall the
menu for a number the dialog is about to show anyway.

### ⭐⭐⭐ WHERE ON THE CLOTH, NOT JUST HOW MUCH

The split worked and the user's verdict was *"now it finally works. Only issue:
it got a bit squashed in places."* — with a screenshot of a curtain whose lower
third has concertina'd into sharp pleats while the top hangs smooth.

⛔ **That curtain measures a perfectly healthy 0.016 mean strain, gather 1.00,
`worstShell` 0.02.** Every reading averages over a whole piece, so a defect
confined to the bottom third is invisible to all of them. That is now the shape
of the miss THREE TIMES RUNNING — the bounding-box diagonal, the maximum
in-plane ratio, and the whole-piece mean — so the answer is RESOLUTION, not
another threshold.

The readback now slices each piece into horizontal bands by REST height (the
band a particle belongs to never changes, however far it moves) and reports:

```
squash = live vertical extent of the band / rest vertical extent
```

1.0 is hanging as modelled; below ~0.8 that band of fabric is compressed into
itself, which is what "squashed" looks like from outside.

⚠ Bands are the PIECE's own fifths, taken from its rest height, not the scene's
— otherwise a curtain high on a wall and one at floor level would not be
comparable.

### ⛔⛔ THE "SQUASHED" CURTAIN WAS 430 POTHOLES, NOT A SQUASH

The band instrument said the cloth was NOT compressed anywhere — squash
0.98–1.07 through every fifth of two different curtains — while the screenshot
plainly showed sharp vertical pleats. Both were true: the SOLVE was fine and the
RECONSTRUCTION was not.

Each vertex nominates its own nearest partner for the shell pairing, and that
relation is not symmetric, so first-claim-wins strands a large minority. The
first version made every stranded vertex its own particle **at its own
position**, which gives it `offset 0` — so it rendered ON the mid-surface while
every neighbour rendered a half-thickness out. Measured on the real curtains:

```
Mesh_0_19_1   2306 verts -> 938 pairs, 430 unpaired — rim 0, INTERIOR 430 (18.6 %)
Mesh_0_19_3   2434 verts -> 1050 pairs, 334 unpaired — rim 0, INTERIOR 334 (13.7 %)
```

**A 2.2 cm pothole at nearly one vertex in five, scattered through the mesh.**
That is what "squashed in places" looks like once it is lit.

Two fixes: candidates are matched SHORTEST FIRST (so the best pairs are made
before anything is stranded), and a stranded vertex is now pushed onto the
mid-surface using the offset vectors of its paired NEIGHBOURS — each of them
spans the shell, and a vertex on the same face shares their direction.
Interior vertices at offset ~0 fell 18.6 % → 8.0 % and 13.7 % → 5.2 %; what
remains is the fold of a closed shell, where zero thickness is correct.

⛔⛔ THE TEST WAS WRONG TWICE, IN OPPOSITE DIRECTIONS, before it was right:
- the regular `shell()` fixture pairs PERFECTLY, so it stranded nothing and
  passed against the broken code;
- "flat while ALL its neighbours are proud" then scored the broken version 0
  and the fixed version 1 — **exactly backwards** — because stranded vertices
  CLUSTER, so each one has a flat neighbour and none are counted.

The measure that works is direct: on a fixture whose two faces are deliberately
offset half a cell, count vertices at offset ~0 that are not at the fold.
**90 of 578 broken, 0 fixed.**

### ⛔⛔ THE MID-SURFACE COLLAPSE IS OFF BY DEFAULT — IT ONLY PARTIALLY FUSES

Three screenshots, three curtains, three different failures: one collapsed flat
onto the floor, one horizontally compressed with a notch cut out of it, one with
its lower third torn into hanging strips. Every curtain in the scene that is
ACTUALLY SIMULATED was broken — the blue and green ones that look perfect have
no cloth component at all.

The measurement that settled it:

```
Mesh_0_19_1   2306 verts -> 938 pairs, 430 stranded (18.6 %, all INTERIOR)
              sim triangles 3364 of a source 4608
              (a clean collapse gives ~2300 + rim)
```

**A thousand triangles survive as OVERLAPPING front/back sheets.** The collapse
depends on every front vertex having a mutual partner on the back face, and on
real geometry the two faces DO NOT CORRESPOND 1:1 — so no complete matching
exists and the result is two nearly-coincident surfaces sewn together. That is a
corrupt simulation mesh however well the solver behaves, and it explains all
three pictures at once.

⛔ TWO ATTEMPTS TO RESCUE THE STRANDED VERTICES BOTH MADE IT WORSE:
- leaving them at their own position renders them ON the mid-surface — a
  half-thickness pothole at one vertex in five ("squashed in places");
- projecting them onto it using their neighbours' offsets put **32-44 of them
  on the WRONG SIDE**, which folds the render mesh back through itself. That is
  the ribbing and the notches.

⚠⚠ AND THE USER'S EARLIER STATE WAS BETTER THAN WHAT I REPLACED IT WITH.
"Now it finally works… a bit squashed" was the pothole version; the wrong-side
version is worse. Shipping a fix that trades a mild defect for a severe one and
calling it progress is the failure here, not the hypothesis.

▶ `midSurface: true` opts back in; the machinery and its tests are kept. Making
it viable needs the pairing to be near-COMPLETE — matching the two faces
properly, rather than taking one nearest-neighbour guess per vertex and hoping
it is mutual.

▶ Default is now the pre-collapse solver, which last measured healthy on every
piece: per-island contact radius at the 1 % shell percentile, contact reordered
around the solve, the hem-following pin band.

### ⭐⭐⭐ THE CLOTH WAS RUNNING IN SLOW MOTION, AND THAT IS WHY PLAY MODE LOOKED WRONG

*"cloth started moving unnatural, like gravity is super strong or it is made of
rubber"* — on entering play mode. Nothing about the cloth had changed.

The substep loop advanced a FIXED `h = 1/120` and **discarded whatever the
frame could not afford**:

| | substeps allowed | simulated per frame | speed |
|---|---|---|---|
| editor ~38 fps | 2 (wants 3.2) | 1/60 s | **0.63×** |
| play mode 120 fps | 1 needed | 1/120 s | **1.00×** |

**A whole session was spent judging a cloth at two-thirds speed.** Every
"floaty", every "too slow to settle", every comparison between one reload and
the next was made at whatever speed that frame rate happened to buy.

The step SIZE adapts now: the frame's time is divided between however many
substeps the budget allows and ALL of it is simulated (`clothSubsteps`).

⚠ TWO CORRECTIONS TRAVEL WITH IT, and both are in `clothVelocityScale`:
- Verlet stores velocity as a DISPLACEMENT over the previous step, so a change
  of step size must be rescaled by the ratio or it reads as an impulse — a
  visible jolt every time the frame rate moves;
- damping is authored per REFERENCE step, so it must be re-exponentiated for
  the step actually taken. Without that, a cloth simulated in fewer, larger
  steps is LESS DAMPED PER SECOND and rings — which is the "made of rubber"
  half of the report, and it would have appeared exactly where the budget bites.

⚠ A hitch longer than `MAX_CLOTH_FRAME` (1/20 s) is DROPPED rather than
stretched across the same few substeps: a 300 ms step is not cloth motion at
any step size, and a loading stall must not launch a curtain.

`__clothFixedStep = true` restores the old loop.

### ⭐ WIND IS A VECTOR

*"our wind is only Z, we must be able to choose any direction"*. The schema
carries a `vec3` (default `[0, 0, 2]`, exactly what the scalar meant). ⚠ A scene
saved with a NUMBER still loads — `applyProps` reads one as `[0, 0, wind]`, so
there is no migration pass and nothing breaks. The GUST rides the wind's own
direction now rather than always pushing +Z, and vanishes with it instead of
dividing by zero when the wind is still.

### ▶ OPEN: A 400 ms FREEZE EVERY 8.00 SECONDS

Reported as "freezes every time my character contacts with it", but the ledger
says otherwise — it is a metronome:

```
1048741  1056747  1064740  1072742  1080742  1088741   (ms)
    +8006    +7993    +8002    +8000    +7999
```

350–403 ms each, **306 blocks over 100 ms in one session**, and one of each
pair carries `computePipelines: 9, shaderModules: 9, bytes: 74448`. Nine
compute pipelines is a cloth simulation being REBUILT from scratch.

⚠ `spikeWatch` on a 577 ms frame accounted for only **2.8 ms** in marked
phases, so the ledger's `(unattributed)` is a missing mark, not missing work.

▶ NEXT: find what invalidates the simulation on an 8 s cadence. Prime suspect
is `mesh.geometry` changing identity — `GridSimulationComponent` re-attaches
when `mesh.geometry !== this.analysedGeometry`, and a re-attach rebuilds every
kernel. The project watcher and virtual-geometry LOD both swap geometries.

### ⭐ THE REBUILD IS MARKED NOW — AN UNMARKED FREEZE IS AN ANONYMOUS ONE

`attachSimulation` / `detachSimulation` are wrapped in freeze-ledger spans
(`vfx:attach cloth`, `vfx:detach cloth`). Building a simulation mints ~9 compute
pipelines and their shader modules, and **the driver parses WGSL on the calling
thread**, so a rebuild is a 350–400 ms main-thread block that never shows up in
a JS profile. Nothing marked it, so 306 blocks over 100 ms were all filed under
`(unattributed)` while the user was reporting freezes.

⚠ The ledger's own note says it: *"a large `(unattributed)` is a missing mark,
not an absence of work"*. This was exactly the case it warns about, and the
warning went unread for a whole session.

⚠ No 8-second timer exists anywhere in the source, so the cadence is emergent
rather than scheduled — which is another reason to name the work before
theorising about what schedules it.

### ⛔ REFUTED: the 8-second freeze is NOT the cloth, and NOT contact-triggered

Marking `attachSimulation`/`detachSimulation` settled it in one reload: the
span never fires, so **the simulation is not being rebuilt**. The nine compute
pipelines in the earlier ledger rows were boot-time compilation, not a rebuild
— the PERIODIC blocks report `gpu: null`, no pipeline work at all.

Wall-clock, in an editor sitting IDLE with a clean scene and play mode off:

```
17:33:46.677  17:33:54.678  17:34:02.668  17:34:10.721  17:34:18.677  17:34:26.673
      +8001         +7990         +8053         +7956         +7996
```

Two ~350 ms blocks 600 ms apart, every 8.00 s — **~700 ms of frozen main
thread per 8 s, about 9 % of all wall time**, doing pure CPU work that nothing
names.

Ruled out with instruments rather than argument:
- the CLOTH (the new span never fires);
- AUTOSAVE (needs a dirty scene, fires at 10 s, and the scene is clean);
- a POLLING watcher — `projectWatcher.js` is event-driven with a 180 ms
  coalesce, so if it is involved then something is TOUCHING FILES every 8 s.

▶ `assets:listProject`, `assets:loadFlags` and `assets:refresh` are marked now.
The project holds **3 539 assets** and cataloguing them took 1.3 s at boot, so a
repeat is the right order of magnitude for a 350 ms block — and the pair
structure fits a walk followed by a flags load.

⚠⚠ THE LESSON, AND IT COST A WHOLE INVESTIGATION: the user reported the freeze
as "every time my character contacts the cloth", and it is a METRONOME that
runs whether or not anything is touched. A reported TRIGGER is a hypothesis,
not data. The ledger had the answer the whole time and could not say it,
because the work was unmarked — *"a large `(unattributed)` is a missing mark,
not an absence of work"*, which is printed in the tool's own note.
