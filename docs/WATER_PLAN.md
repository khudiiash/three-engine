# WATER — the structural rebuild (2026-09-06)

The report that started it (user, with screenshots and two references):
foam "not realistic" (blotches); caustics "random, too low poly"; the splash
"looks quite good, but only at specific scale — make it larger and it does not
work"; god rays "not very accurate, flickery"; and the standing constraint:
"don't merely tune — structural changes using the solutions used in the
references" ([Popov72/OceanDemo](https://github.com/Popov72/OceanDemo),
[jeantimex/webgpu-water](https://github.com/jeantimex/webgpu-water)), with
"one system must configure both a small smooth pool and an ocean".

Every stage below shipped with a receipt from a harness page, never from a
screenshot. `npm run test:water` (39) and the smokes listed at the end are the
gate.

---

## Architecture — three fields, one surface

```
 SEA (world-space, spectral)          RIPPLES (local, interactive)         LOOK
 waterSpectrum.js / waterSpectrumCPU  gridSimulation.js                    waterSurfaceLook.js / waterFoam.js
 JONSWAP·TMA directional spectrum     wave equation + viscosity            per-pixel normal = sea slope
 → h0 (once per settings)             volume-pair wakes (waterPhysics.js)  (derivative cascades, mipped) +
 → dispersion → shared-memory IFFT    a 32 m WINDOW around the camera      ripple-window normal (texture)
 → 3 cascades of displacement (λ·D)   at 4–6 cm cells, shifted by whole    foam value → sheet / filaments /
   + derivatives + (per vertex) the   cells, sponge at open-water edges    flecks; contact foam at the lid's
   Jacobian of the COMPOSED surface   foam field (.w) sourced by the       outline
                                      Jacobian + churn, spread, 3.5 s
 ONE model: a pool is the calm end of the same spectrum (seaState presets)
```

- **Lid** — a flat n×n grid below 64 m (4 cm cells, `waterAutoResolution`),
  clipmap rings above (65² levels on one coarsest-snapped centre). Every
  vertex is `rest + Σ cascades(world) + rippleWindow(rest)`; its normal is
  FLAT — both slopes compose per pixel from textures, so a splash reads the
  same on a 4 cm mesh and a metre one.
- **Shape** — `waterVolume.js#waterVolumeShape` (box / cylinder / sphere /
  cone / capsule, `fill`); `waterShape.js` is the TSL twin: lid outline, wall
  for the solver, exact quadric clip for the medium, receiver tests.
- **Medium** (`waterMedium.js`, `scene.fogNode`) — per-pixel path length
  through the volume, absorption + in-scatter, shafts = the caustic map read
  along the ray at mip 5 with an HG phase (g .62).
- **Caustics** (`waterSlots.js`) — 512² beams refracted through the sea's
  slope (derivative cascades at the beam's own mip) + the ripple window's
  normal, drawn as area compression into a 1024² map over a camera-centred
  16 m window; receivers walk their beam back to the map; the map clears to
  NEUTRAL (1) where no beam lands.
- **GI** (`srcShade.js`) — the refracted sun's caustic gain multiplies the sun's
  visibility at underwater hits; the MIRRORED sun is a second directional
  source at hits above the water (Fresnel reflectance × the reflected lens ×
  a real shadow ray to the surface), so the probes carry the pool's light
  around the room.

### Controls (existing fields; one preset added)
| field | meaning |
|---|---|
| `seaState` | custom / pool / pond / lake / ocean — writes the wave fields |
| `waveHeight` | significant height (σ = min(H/2, 0.05·λ) — the breaking limit) |
| `waveLength` | peak wavelength λp; cascades L0 = clamp(12·λp, 8, 1024), L1 = L0/15, L2 = L1/3.4 |
| `waveDirection`, `choppiness` | wind angle (+ a swell at +50°); λ capped at Tessendorf's folding limit |
| `rippleStrength` | spectrum above 4·kp · `surfaceDetail` the sub-vertex slope |
| `waveOctaves`, `waveGain`, `waveSpeed` | cutoff, spectral tilt, time scale (1 = real time) |
| `foam`, `foamThreshold` | Jacobian threshold mix(1.3, .6, foam), contact width |
| `fill` | the waterline as a fraction of the primitive's height |

---

## Stages and receipts

| stage | what | receipt |
|---|---|---|
| 0 | auto grid (4 cm), camera caustic window, foam look, medium phase | splash identical at 5 and 20 m |
| 1 | spectral sea in TSL, CPU specification | `smoke:water-spectrum` GPU vs CPU maps 0.087 % |
| 2 | composition, Jacobian foam source, buoyancy on a GPU readback, presets | `smoke:water-surface` vertex parity 0.66 mm; `smoke:water-props` 20/20 controls alive |
| 3 | lens from the real surface; god rays | `smoke:water-rate` 0 % turnover with waves stopped; premium god-ray arm: phase 2.7 : 1 : 0.9, one-frame change 1.8× smooth motion, map border 1.000 |
| 3b | the water lights what is above it, and is seen through, in GI | mirrored sun (shadow ray to the surface) at hits above; hits seen THROUGH the water get exp(−σ·path)·(1−F) and F × the sun-extracted sky mirror (the hit record carries the ray direction: 16 → 20 words); `test:gi-src-shade` 50 checks, `test:gi-src-deposit` PASS, the secondary probe's multibounce arm PASS; a harness irradiance receipt is open |
| 4.1–4.2 | the ripple window | same splash at 5/60/500 m; a 6 m window step 4.75 vs 4.81 for one tick of motion; open-water edge absorbs (0.22× of a wall) |
| 4.3 | clipmap lid over 64 m | 500 m = 9 levels / 38 k vertices, 2048 boundary vertices worst gap 0.007 mm, rim 0.000 mm |
| 4b | any primitive, `fill` | sphere/cylinder/cone/capsule: lid on the outline 0.000 mm, shell seam 0.000 mm, medium chord 4.97 m for 4.96 m, field calm (0.3 vs 0.4 cm RMS) |
| 5 | this document, memory | — |

Live editor (5 m box, ultra, GI on): error channel empty after every stage's
reload; 107–118 fps; water GPU ≈ 2 ms.

---

## The traps (each cost real time; all have receipts)

1. A sampler reads texel i at (i+½)/N; the FFT transform put it at i/N — half a
   texel is most of a wave at a band edge. `uv + 0.5/N`.
2. Band cutoffs at exactly 6 texels sit on lattice points; f32/f64 rounding
   decided membership of the most energetic texels. Cutoffs are 6.5.
3. `.compute(number)` prepends an early return — non-uniform control flow before
   a `workgroupBarrier()`. An ARRAY count is a dispatch size.
4. The fragment stage's 16-sampler limit is a scene-wide budget only the editor
   can count (`[water] … binds N sampled textures`): cascades are texture
   arrays, both slots share one 4-layer array, the hidden source material is
   `giWater`.
5. Per-cascade Jacobian memory whites out a steep sea; the fold test belongs to
   Σ gradients before the product. Cap λ at the folding limit, σ at 0.05·λp.
6. The ripple window's edge inside the pool is a Neumann wall — the outer 16
   cells damp height AND history together; measure the reflection from 2.0 s
   (a 2-D wave's tail dominates the first two seconds in both arms).
7. The wall rule must cover the history: the viscosity averages neighbour
   VELOCITIES; a dry neighbour's zeroed history read against a mirrored height
   fed height/4 back every substep and took a cylinder's field to the limit.
8. Clipmap levels on one coarsest-snapped centre need no trims; the morph
   band's diagonal must be the index buffer's (i+1, j−1)–(i−1, j+1).
9. A vec3 storage attribute reads back at a 16-byte stride.
10. The shell's top ring must be the lid's expression bit for bit; `dir·radius`
    is a few ulps off and a wake at the wall makes that a 7 mm seam.
11. An `If` body that RETURNS the assign node is read by TSL as a typed
    expression ("expected a float", 42× per compile). Blocks only.
12. A caustic map cleared to BLACK darkens every receiver whose beam walks into
    the border — "black stripes quickly flickering on the pool walls". Clear
    to 1, and refuse a receiver whose beam entered outside the lid.
13. "Change over 0.2 s" measures MOTION; flicker is one frame's change against a
    twelfth of it.
14. Refraction thickness must be the WATER COLUMN along the bent ray: a fixed
    22 cm on a physically capped sea moved the floor by centimetres — "no
    water refraction".
15. Foam is made by BREAKING water: a churn gate at 0.12 m/s foamed a whole
    pool under a bobbing crate, and the `foam` dial did not reach it. Steep
    crests (> 25°) or splash speeds (> 0.5 m/s), scaled by the dial.
16. The GI tests need `npx vite --port 5201`; the water smokes use 5307.
17. A pool whose floor shows no caustic while a default sphere in it does is
    a MATERIAL: `buildPbrGraph` made every map-based material without a
    metalness map a metal (metalness 1 = no diffuse, no caustic, no bounce).
18. "Flickering stripes on the pool walls" underwater was the water body's
    side shell z-fighting the pool's walls; the shell carries a polygon
    offset now. Reproduce the user's SCENE before touching the effect.
20. The fog node is in EVERY material: its size is the editor's responsiveness.
    A floor material read 362 kB of fragment WGSL (24 shaft taps unrolled ×
    2 slots + four primitives' clips ×2 + the caustic light ×2) — 10–15 s
    freezes on every minted material. A GPU loop and `pool.compileShape()`
    (claimed slots, used shapes) bring it to 50 kB. Measure the floor's kB
    (bindings smoke) before adding anything to the medium.
21. Reflected caustics leave AWAY from the sun; a receiver on the sun's side
    is physically dark. A reflection focuses ~8× closer than a refraction,
    so the reflected lens keeps the floor map's focus from D/8 up.
22. The refraction column must end at the first wall, not at floor depth —
    a grazing exit point outside the pool reads the sky inside the water.
19. Caustic receivers: the window reaches past the rim by the beams' lateral
    travel; walls read the map at the grazing mip plus a defocus that grows
    with height above the floor; the caustic light's cosine is the geometric
    normal.
23. A WATER LID MUST NOT CAST A SHADOW-MAP SHADOW. The user's Water had
    `castShadow` on, so the pool floor never received the sun the lens was
    meant to modulate — "caustics are way too dim, even when increased
    intensity". Water never casts now; its shadow IS the caustic gain (focus
    × absorption). Cloth still casts.
24. The refracted caustic is a MULTIPLIER on the sun, and a light node can
    only add. A `colorNode` hook on the sun (0abe2b6) silenced the water
    light's own mirrored-sun add (catcher 77.3 = 77.3), and three caches ONE
    light node per light (`_lightsNodeRef`), so a hook installed after the
    scene compiled was never seen in the editor. The water light now adds
    E·cos·(gain − 1) × the SUN'S OWN shadow node, found through
    `builder.lightsNode` (lights build in id order; the sun's node already
    carries `shadowNode`). Receipt: in the post's shadow the floor reads
    66.5 with the lens on and 66.5 off; beside it 177 vs 211; floor contrast
    25.4 % vs 13.0 %; catcher 80.9 vs 77.3.
25. The shadow map lags a `castShadow` toggle by a frame (one update per
    frame id per camera): a receipt that toggles a caster reads the previous
    state. Compute the shadow region from geometry instead.
26. three's transmission scales its refracted ray PER AXIS by the mesh's
    scale (`getVolumeTransmissionRay`: `normalize(r) · thickness ·
    modelScale`). On a 5 × 3 × 5 pool the sideways travel is 5/3 of the
    downward one, so every surface pixel read the framebuffer far beyond
    where its ray lands — a crate at the waterline painted onto the water
    beside it (four reports). The surface refracts for itself now: Snell in
    world space, the column to the first wall/floor, the exit projected and
    read from the same viewport copy, tinted colour × Beer over the column.
    `material.transmission` stays 0 on a water lid.
27. The "incorrect reflection" under a floating red crate was never a
    reflection — a mirror can only ADD light and the block was darker than
    the floor. It was the crate's submerged half, seen through a surface that
    multiplied everything by the material's diffuse colour (three's
    transmission does: `transmittance = diffuseColor · Beer`), a flat teal
    filter with almost no red. The interface is clear now — Fresnel and the
    material's own attenuation only; the water's colour is the MEDIUM's
    absorption over the real path. Diagnose a dark ghost by its SIGN first.
28. (REVERTED 2026-09-06 evening — the pass rendered a wrong image in the
    editor and the user asked for it to go; the surface reads the framebuffer
    copy again and the crate copy is the OPEN item.) SCREEN-SPACE REFRACTION
    CANNOT BE SAVED BY A DEPTH TEST. The framebuffer
    near a floating crate holds the crate's faces ABOVE the water, and a
    displaced sample reads them onto the surface around it however exact the
    ray ("the copy's still there, just fully bright red now" — the sixth
    report). Rejecting them still leaves nothing to show where the floor
    behind them should be. Only a render that never drew them does: the
    surface now renders its own REFRACTION PASS, like the mirror — the scene
    clipped to the half the eye is NOT in by an oblique near plane
    (Lengyel), half resolution, the medium armed — and its depth is the
    column to the first thing behind each pixel (the straw's break, no post
    chain needed). ⚠ Through a VIRTUAL camera: three keeps one render list
    per (scene, camera), and a nested render through the real camera
    re-inits the list the outer transparent pass is walking ("Cannot
    destructure property 'object' of 'renderList[i]'"). Receipt:
    `smoke:water-premium ?crate=1` (a half-submerged red cube shot with and
    without the surface; calm: `&waveHeight=.02&choppiness=.2`).

29. The crate painted onto the water behind itself was the REFRACTION SAMPLE
    (the framebuffer at the displaced pixel holds the crate's above-water
    faces), never the mirror — it vanishes at grazing angles, which a mirror
    image would not. Fixed with a DEPTH TEST: the water copies the viewport's
    opaque depth before it draws, unprojects what sits at the refracted pixel,
    and reads straight through the pixel if that stands above the lid's
    plane; the same depth bounds the column (the straw). ⚠ three's
    `viewportDepthTexture` decides a depth texture's sample count from the
    target CURRENT at build or first bind, so a compile path with another
    target current binds a single-sample 1×1 to a multisampled declaration
    ("Sample count (1) … doesn't match expectation"). A texture carrying its
    own `renderTarget.samples` is read from that everywhere: one per render
    target, pinned at creation, chosen by `updateReference`, keyed by the
    EFFECTIVE target (`_getFrameBufferTarget()` for a multisampled canvas,
    where `getRenderTarget()` is null and `currentSamples` 0 — the copy's
    source has 4). Receipts: MSAA and plain bindings smokes clean, `?crate=1`.

30. The god rays are `albedo × (clamp(gain − 1, 0, 1.5) + 0.2)` per tap:
    the filaments' positive EXCESS over the flat sun at the water colour's
    albedo, plus a haze FLOOR outside the clamp — the forward glow looking up
    at the sun on CALM water, where filaments are nothing ("god rays
    underwater got almost absent"). The old white-cleared map averaged above
    one and carried that haze implicitly. A bias INSIDE the clamp vanished:
    the map is skewed (median 0.53, p99 6.8), so most taps clamped to zero.
    And the volume taps must NOT take the receivers' defocus (four mip
    levels at the surface) nor the fade-to-one: the beam is the surface's
    lensing running the whole column, only its convergence grows with depth
    (`{ volume: true }` on `waterCausticGainLocalNode`). Mip 5. Receipt: up
    119 / across 59 / down 56 (1.99 : 1 : 0.94), one frame changes 0.66 % /
    3.75 % of the term, floor contrast 24.3 % vs 13.0 %.
31. The flicker gate is ABSOLUTE — one frame's change as a share of the
    shaft term (4 %; the term is a fraction of the pixel, the standing rule
    is 3 % per pixel). The ratio against a twelfth of 0.2 s's change (trap
    13) is informational: with the waves at rest the term barely moves over
    0.2 s and a 3 % frame reads as 5×.

32. THE OCEAN LOOK (2026-09-06, evening). Five things stood between the sea
    and the Popov demo, none of them the spectrum: (a) whitecaps were gated
    at J < 0.19 while the composed Jacobian at the folding limit never drops
    below ~0.45 (p1 0.47, p5 0.60 — the same on a pond and an ocean, the
    limit normalizes it): `seaFoamNode` opens at J < mix(0.45, 0.85, foam),
    ramp 0.25; (b) foam per VERTEX cannot carry a whitecap on a clipmap ring
    whose vertices are metres apart and whose Jacobian is a coarse mip: the
    fold is read per PIXEL in `waterFoamNode` from the same cascades the
    normal reads; (c) the persistent field must be seeded by the rare FOLD
    only (`seaFoldNode`, J < 0.45) — the whitecap gate as a source turned a
    pool into a 90 % sheet in a second; (d) the medium fogged the LID: the
    eye ray clipped at the surface height where it crosses the rest plane,
    so on a metre of swell a trough fragment counted metres of "water"
    reached through air — every trough a hard sheet of the scatter colour;
    the lid has its own segment (`waterLidSegmentNode`: none from above,
    all from below, chosen per material by `builder.object.userData.waterLid`
    inside the fog `Fn`); (e) a planar mirror of a flat sky bent by 2 % is
    glass — the sky is now read per pixel along the true reflected ray
    (`pmremTexture` of the scene environment or texture background,
    prefiltered by roughness), the mirror rendered without a background so
    its alpha says where it saw geometry. Plus: the variance a cascade loses
    to distance becomes roughness (`seaLostSlopeVarianceNode`, Beckmann
    m² = 2σ²) so the far sea sparkles instead of turning to glass; the crest
    glow is in metres (`positionLocal.y × waveScale.y`) and only the top
    quarter glows. Receipt: `?ocean=1&depth=10&roughness=.15` + ocean
    settings — whitecaps 0.4 % (gate 0.3–30 %), green sheets 0 %.
33. OPEN: a box water 30 m deep or more shows a flat 32 m rectangle where the
    ripple window sits (fine at 10 m). Something in the window's lid path
    scales with `waveScale.y`; an ocean is a plane or a box ≤ 10 m deep
    until it is found.
34. `godRays` (0–3, default 1) scales the shafts alone (`slot.uniforms.shafts`),
    apart from `causticIntensity`.

35. OBJECTS SHADOW THE BEAMS THROUGH THE MAP. Each caustic beam's landing
    point is tested against the sun's shadow map (a depth compare with the
    sun's bias) when the map is splatted, so a beam landing in the crate's
    shadow leaves the map and both the floor caustics and the shafts inherit
    it at no per-material cost. ⚠ three WebGPU keeps the shadow map on the
    light's SHADOW NODE (`shadowNode.shadowMap.depthTexture`), never on
    `light.shadow.map`; the caustic light node finds that node during a
    material build and stores it on the slot pool (`pool.sunShadowNode`), so
    a map splatted before any material has built has no shadow — the harness
    ticks twice after its first shot before reading the map. Receipt: the map
    in the post's shadow 0.000 vs 0.826 outside.
    The exact per-tap alternative (a shadow sample per shaft tap in the
    medium) is the fallback if beams must end ABOVE an occluder rather than
    at its floor shadow.
36. A DISABLED ENTITY ONLY HID ITS OBJECT3D. The Pool entity (the walls, the
    water and the Global Illumination component) disabled in the editor
    still ran every component: GI collected no meshes (the subtree was
    invisible), built its kernels over an EMPTY scene and failed every frame
    (`src:deposit` "Cannot read properties of null (reading 'x')",
    `bvhHitShade` "params.shadowTraceFn is not a function"), and the water
    kept registering its refraction pass with it. Now an entity disabled in
    the current mode DETACHES its components and its subtree's
    (`Entity.reconcileActivity`: the setters, `setParent`, `setPlaying` and
    a per-frame walk from the roots); a detached component stores prop
    changes without reacting (`Component.setProp` gate — several
    components re-run `onAttach` themselves on a prop change) and fires no
    enable/disable hooks; GI's dispose releases the water's trace/shade pair
    with the build. Receipt: `npm run test:entity-activity` (6).
37. THE OCEAN WAS A LAGOON (user, 2026-09-07: "our default ocean looks
    pathetic", a 500 × 10 × 500 cylinder). Four faults, each with a receipt:
    (a) THE SEA'S TEXTURE-ARRAY MIPS WERE NEVER GENERATED — three regenerates
    a storage texture's mips only when a sampled binding of it is rebuilt
    after a store binding marked it, and the arrays are bound once and
    cached — so every `.level(n > 0)` read (the clipmap's coarse rings, far
    pixels' hardware mip, the caustic lens's band-limited cascades, the foam
    memory's coverage) read zero. Receipt: lid RMS height per clipmap level
    0.57/0.75/0.97/0.87/0.73/0.41/0.00/0.00/0.00 m before (level 5 = 0.8 ×
    mip 0 + 0.2 × an empty mip 1), 0.57…0.42/0.28/0.17 after
    (`spectrum.generateMipmaps` after the sea's own compute submission,
    before anything samples). (b) THE CLIPMAP ADDED ITS LEVEL INDEX TO THE
    CLAMPED LOD, and that LOD came from the base grid's cell (a local unit ×
    500 m = a metre), so the swell left the geometry from the fourth ring
    out: "the tiny rect in the centre that actually does some waves". Now
    `seaLodRaw` (unclamped, from the level-0 cell) + level, clamped at zero.
    (c) THE SKY WAS REFLECTED TWICE — the material's own image-based
    lighting plus the sky-by-direction term of trap 32 — and the horizon
    read brighter than the sky it mirrored. With an environment on the
    scene the mirror renders without a background and counts only where it
    saw geometry; without one it keeps the background, as before. (d) THE
    OCEAN IS A DIFFERENT WATER: the preset now writes a wind sea (H 1 m,
    λ 24 m, chop 1) AND its look (deep blue in-scatter, saturation .75,
    transmission 1, foam .3); pool/pond/lake still leave the look alone,
    and editing a field a preset carries flips it to custom.
38. WHITECAPS ARE A MEMORY, NOT A GATE. The per-pixel gate on the composed
    Jacobian is instantaneous and mip-averages toward "nothing" past a few
    tens of metres, while the reference carries streaky foam to the
    horizon. The sea keeps a camera-following window (`FOAM_WINDOW_METRES`
    512 at 1024², texel-snapped like the caustic and ripple windows) of
    max(whitecap now, last frame × e^(−dt/6 s)) over the COMPOSED Jacobian
    (never per cascade, see the ⛔ in waterSpectrum.js); a crest that folds
    leaves a trail as it travels. The look is the memory's own distribution
    (linear, ocean preset: median .14, p90 .46, p99 1 — ⚠ the readback is
    sRGB, linearize before setting a threshold on it): a sheet above .55,
    streaks where a fractal stretched 4:1 along the wind falls under
    1.6 × the value, bubbles over both, and past 60–240 m the mip-filtered
    coverage as a tone. The ripple field no longer carries sea foam at all
    (one value with two looks was a seam at the window's edge): it is the
    INTERACTION foam — wakes, splashes, rim churn — with the wake look.
    Receipts: whitecaps 12.9 % of the water, far band 3.7 %, green sheets
    0 %, the lid at 11 sampled textures.
39. THE CAUSTIC LENS KEEPS ITS OLD BAND (deliberately). With the mips real
    the fine cascades reached the lens for the first time and the 20 m
    arm's shaft term changed 12.5 % a frame (baseline 6.2 %, gate 4 %; the
    5 m arm 0.13 %). A cascade now fades out of the lens as its texel drops
    under the band limit (`lens.weights`, 1 at mip ≤ ½, 0 at ≥ 1½), and the
    band limit is at least four beam spacings (a splat sampled 2.3× per
    wave jittered). Receipts: 5 m floor 25.0 % vs 13.1 %, catcher 81.0 vs
    77.3, shafts 0.16 %/0.26 %; 20 m shafts 6.09 %/4.83 % = the previous
    commit's 6.19 %/4.99 % (measured on a worktree of 17d4b44). ⚠ THE 20 m
    AND 60 m SHAFT FLICKER IS PRE-EXISTING and above the gate; the ripple-
    scale shimmer the fine cascades would add is real physics and needs a
    temporal term on the shaft taps before it can ship.
40. HARNESS: `pose()` now applies the camera follow with a zero-length tick
    (the windows and the ring centre were at the origin, 175 m from the
    ocean poses, so every earlier ocean shot looked at the coarsest rings);
    a vec3 storage attribute reads back with a 16-byte stride (four floats
    per vertex); `?hdr=`, `?toneMapping=`, `?sun=`, `?sunIntensity=`,
    `?color=`, `?deepColor=`, `?waterDepth=`, `?foamDebug=sea` (the raw
    memory, with its linear percentiles), `?seaMips=0`, `?poseTick=0`; the
    `ocean-eye` pose and the lid-geometry receipt (RMS per clipmap level,
    the sea's σ and cascade-0 RMS beside it).

## Open

- The refraction pass is a second scene render per water surface per camera
  (half resolution), beside the mirror's: two nested renders per frame. A
  big scene with an ocean pays draw calls twice more; a shared pass for
  several surfaces, or skipping it when nothing crosses the waterline, is
  the saving if it shows in `profile.frameStats`.
- The medium's shafts are lit by the caustic map only: an object's shadow
  (the sun's shadow map) does not cut the beams under it. One shadow tap per
  few shaft taps would, at a cost to the fog node every material carries.

- A GI harness irradiance receipt for the water terms (mirrored sun, the
  through-water attenuation and sky mirror).
- At 500 m a 6 m walk re-snaps the rings by a 10 m cell (7.0 vs 5.0 for one
  tick of motion) — per-level snapping with trims would remove the pop.

## Harness

`npm run smoke:water-premium` (`?scales=5,60,500`, `?shape=sphere|cylinder|
cone|capsule&fill=.75`, `?shaftMip=N`, `?crate=1` — the floating crate seen
through the surface, with and without it; the ocean: `?scales=500&shape=
cylinder&fill=1&depth=10&ocean=1&hdr=/artifacts/sky/user.hdr&toneMapping=
linear&sun=3.7,19.58,-1.68&sunIntensity=4` plus the preset's fields as
overrides), `smoke:water-surface`,
`smoke:water-spectrum`, `smoke:water-props`, `smoke:water-rate`,
`scripts/water-bindings-smoke.html?msaa=1`, `npm run test:water`.
