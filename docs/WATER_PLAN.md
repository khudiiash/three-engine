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
41. GI BLACKS OUT THE MATERIAL'S IBL. GI installs a black
    `scene.environmentNode` so its probes replace image-based lighting, and
    leaves the water out of its radiance block — after trap 37(c) moved the
    sky onto the lid's IBL, a GI scene's sea reflected nothing ("no sky
    reflection from the surface … cartoonish"). The lid samples the
    environment texture itself along the reflected ray, with the same
    analytic environment BRDF (Karis) the IBL applies, gated by a uniform
    that is 1 exactly while `scene.environmentNode` overrides a texture
    environment; `skyNode.value` follows the scene's texture. Receipt: the
    sea under the horizon reads 48 % of the sky over it with the IBL, 34 %
    with GI's node emulated (`?giEnv=1` — the foam loses the sky irradiance
    the harness has no GI to replace), 0 % before. ⚠ Plain Fresnel on that
    term read 108 %: a rough far sea at grazing returns a fraction of the
    sky, and the BRDF says how much.
42. THE EYE'S SIDE COMES FROM THE SURFACE UNDER IT. The rest plane decided
    above/below (with a ±1.5 × wave-height band): on a metre of swell an eye
    in a trough was "under water" for metres — fog over the far surface,
    the whole lid on the water-side Fresnel (total-internal-reflection
    white on every near slope) — and one on a crest "in the air" ("depth
    issues under grazing angles"). The component reads the surface under
    the eye from the sea's CPU copy (the buoyancy query) with a hysteresis
    of centimetres, publishes `simulation.eyeBelow` (the mirror's flip)
    and the slot's `eyeBelow` uniform (the medium's lid segment); the lid's
    Fresnel and refraction branch on `frontFacing` per fragment. Receipt:
    the eye 15 cm over a −2.05 m trough keeps the sky at 91 % of the 1.2 m
    eye's; the rest plane would have called it under water.
43. FOAM RIDES A FLOW. "After interaction with an object, foam patterns on
    the water remain static." The ripple field now carries the column's
    horizontal velocity (`flow` .xy, local units/s): shallow-water momentum
    on the committed heights every substep (du/dt = −g ∂h/∂x, damped 0.6/s,
    capped at 0.4 cell per substep), a body's press driving water outward
    and its release drawing it back (in metres: the dent's local depth ×
    sy/sx), and the foam advected through it semi-Lagrangian in the foam
    field's kernel. The pattern the foam is DRAWN with rides an accumulated
    drift (.zw, forgetting over 6 s) the lid reads from `flowTexture`. No
    pressure projection — the wave equation plays that role. Receipts: a
    splash leaves 0.18 / 0.09 / 0.06 m/s peak flow at 5 / 20 / 60 m and the
    pattern drifts 6.8 cm at all three (scale-invariant), foam and shaft
    receipts unchanged. The sea's whitecaps (the memory) do not ride it: the
    crests carry them.
44. WHITECAPS AGAINST THE REAL THING (a storm sea beside ours, user
    2026-09-07): foam is SPARSE — a sheet only where a crest has just broken
    (memory > .7), thin streaks along the crests behind it (a 9:1 stretched
    fractal under 1.3 × the value), holes in both, 0.75 albedo. The
    transmitted light is lighter and greener along the crests (thin water:
    `waterCrestGradientNode`, ×1.4 green at the crest, fading in between 10
    and 50 cm of wave height so a pool's ripples never turn green) and the
    subsurface term is a bright teal, not the body's own dark blue, which
    glowed invisibly against itself. Receipts: whitecaps 6.7 %, far band
    1.2 %, sheets 0 %.
45. INTERACTION RUNS IN THE WATER'S TIME, AT METRE-SCALE SPEEDS. "The
    contact looks too fast, as well as foam movement speed" on an ocean at
    waveSpeed .5: the ripple solver ran at the SWELL's phase speed (6 m/s
    for a 24 m peak) while a wake or a splash ring is a wave a few metres
    long — now c = sqrt(g·min(λp, 5 m)/2π) (a pool's 1.5 m peak unchanged;
    at 3 m a body driven at 6 m/s piled its bow wave onto the injection
    clamp). The flow's momentum, damping and drift, the body's push and the
    foam's decay, source and spread all use the tick × `u.speed`.
46. A HULL PRESSES A HULL-SHAPED DENT. "The contact is round, it does not
    consider the collider shape at all" (a boat). An elongated collider
    (aspect ≥ 1.8) is a row of up to four columns along its long axis, each
    as wide as the hull, pressed by its own draught and released by the
    exact record of its press (`addWaterImpulse(..., capRadius)` caps a
    column's depth against its own width). ⛔ A COMPACT BODY STAYS ONE DENT,
    bit for bit: split into a 4 × 4 grid, a crate's columns were narrower
    than the slope cap lets a dent be deep (a falling crate's splash read no
    harder than its floating draught), and sixteen overlapping columns
    re-emitted with wandering centroids PUMPED the field (energy wound up,
    the wake sat on the clamp) — the interaction tests caught both.
    `test:water` 39 (the conservation assertion is now against what was
    pressed; the footprint's reach is the union of its columns).
47. FOAM FORMS WHERE THE WATER BREAKS. A fishing boat towed a white blanket
    twenty metres wide ("foam madness"): vertical motion alone was a foam
    source, and a hull's rim moves fast everywhere it goes. Steepness gates
    the churn now (`breaking = steep.smoothstep(.3, .7)` × churn) — the bow
    wave's breaking crest foams, the dent's floor does not. Receipt: foam
    4 s after the harness splash 3.6 % of the lid (was 8.6 %), flow and
    caustic receipts unchanged. The React "Maximum update depth" loop in the
    editor's mirror is not water: `Engine.emit` now logs the emitter's stack
    once a second sees 30 `hierarchy-changed` flushes — read the console.
48. ⛔ A BIND GROUP A FRAME IS A DEVICE LOSS. Trap 37(a)'s per-frame mip
    regeneration went through three's mipmap pass, which creates a texture
    view and a bind group for every layer of every level on every call —
    ~60 a frame for the two 3-layer arrays and the whitecap memory, on top
    of the caustic map's 11. WebGPU frees a bind group only when it is
    collected, Dawn's D3D12 backend backs them with descriptor heaps, and a
    few minutes in: "ID3D12Device::CreateDescriptorHeap failed with
    E_OUTOFMEMORY", device lost, the renderer rebuilt (user, 2026-09-07).
    `gpuMipmaps.js` builds views, bind groups and a blit pipeline ONCE per
    GPU texture (keyed by the GPUTexture, so a rebuild re-caches) and only
    encodes render passes per frame. Receipt: lid RMS per clipmap level
    still 0.86 … 0.44/0.29/0.18 m (mips live), pool receipts unchanged,
    bindings smoke 0 validation errors. Rule: anything that runs every
    frame must not call `createBindGroup`/`createView` — cache them.
49. THE CURRENT (`current` m/s, `currentDirection` degrees, 2026-09-07):
    "make it look like the boat is floating without actually moving it, so
    I need to scroll the ocean." Every sample of the sea is taken at
    world + `scroll` (a spectrum uniform the tick advances by the current),
    so geometry, normals, whitecaps, caustics and the buoyancy query (the
    readback carries `scroll`) all stream under a fixed lid. The whitecap
    memory stays on the eye in world space and its contents take the value
    that was upstream a tick ago (whole texels, remainder carried). The
    ripple field — a wake's heights and foam — is advected by the current
    once a tick, semi-Lagrangian, before the substeps, and the wake
    pattern's drift adds the current. Receipts: over a frozen sea
    (`waveSpeed=0`) a 10 m/s current moves the lid under a fixed point
    0.13 → −0.78 m in a second with the CPU query agreeing to the
    centimetre; on the 5 m pool a 0.6 m/s current carries the splash
    foam's centroid 1.38 m in 2.5 s (1.5 expected). ⚠ Direction 0 runs
    along +X; at waveDirection 0 that is along the crests (the sea varies
    least there) — a boat heading into the waves wants the current AGAINST
    the wave direction.
50. ⛔ THE FOAM KERNEL TRUSTS `scratch`. `foamField` reads `scratch.w` as the
    foam copy the last `integrate` left there. A tick with no substep (one
    shorter than a substep, or the harness's zero-length follow tick) runs
    no integrate, and a shift or advection sequence that ended on
    `previous` left previous.w in scratch — the foam field read it as its
    own and was wiped in one tick (the current's advection at any speed,
    even 0.001 m/s; the identity copies "killed" the foam until probes at
    1.5/4 s showed the field intact and the attribute dying at the pose's
    zero tick). Both the window shift and the advection now end on
    `positions`. Harness: `fieldProbe(label)` logs the texture's height
    RMS and foam sum beside the attribute's.
51. ⛔ A RESAMPLE A FRAME IS A BLUR A FRAME. The current first carried the
    ripple field semi-Lagrangian (bilinear at a fraction of a cell every
    tick): the wake's height RMS was down a quarter at 1.5 s and the
    contact ripples were gone within seconds ("can't see contact ripples at
    all", user, 2026-09-07). The field is carried by WHOLE cells now — the
    tick accumulates the current in cells and shifts by the integer part,
    the remainder waits — exactly as the whitecap memory and the window
    shift do. Receipt (5 m pool, 0.6 m/s): height RMS 1.05 cm at 1.5 s
    against 1.18 with no current and 0.90 bilinear; the foam centroid still
    rides 1.37 m in 2.5 s. What is still lost is the wave leaving the grid
    downstream, which a current through a pool must do.
52. ⭐ FOAM IS PARTICLES (Gao, Tessendorf & Reinhardt 2021, "Foam, Splash,
    and Rippling for Spectrum-Based Ocean Surfaces"). The whitecap memory
    — a grid holding max(gate, last × decay), shifted whole texels — could
    only make patches with hard edges and smear them ("foam still looks
    awful", user, 2026-09-07). The paper's model, now `waterSpectrum.js`:
    a pool of foamSize²/8 particles (131 k behind a 1024² map). A dead one
    probes a random point of the 512 m window (30 % of the dead per frame)
    and is BORN where the MINIMUM EIGENVALUE of the horizontal
    displacement's Jacobian is under the threshold (`seaFoldAt`: a fold
    along one direction, which the determinant can miss; threshold
    .45 + .4·foam, the paper's .55), moved along the crest — the maximum
    eigenvector — by ±0.1 λp (the whitecap coverage rule); or it takes a
    hull seed (`addWaterFoam` → `passes({seeds})`, wanted at
    FOAM_SEED_DENSITY = 4 particles/m²/s, the probes sized on the CPU to
    the busiest seed). A live one RIDES THE SURFACE'S OWN HORIZONTAL
    VELOCITY — λ·∂D/∂t, one more FFT per cascade (`fftKernel` takes a
    single texture now), times the sea's time scale — plus the current,
    for half to a full life of twice the peak period (7.8–15.6 s at the
    ocean preset), fading as 1 − e^{−remaining/(T/3)}. Every frame the live
    ones are splatted (a nested render like the caustic pass, additive
    Gaussians of 0.07 λp × a per-particle 0.6–1.4, row 0 at the top) into
    a render target whose mip chain is allocated through `mipmaps.length`
    with `generateMipmaps` false — three's own post-render mip pass is the
    per-level bind-group allocation of trap 45 — and blitted by
    gpuMipmaps.js. The lid reads the map as it read the memory
    (`seaFoamWindowNode`); the per-pixel gate is GONE from the look — on
    the minimum eigenvalue it painted every steep face a snow blanket, and
    the particles whiten a breaking crest in a fifth of a second on their
    own (9 probes/m²/s). Receipts (500 m, ocean preset, 8 s warm-up):
    whitecaps 5.7 % of the water, far band 3.22 %, raw map mean .095, p90
    .24, p99 1.0, above .1 20.7 %, above .5 4.4 %; 78 864 of 131 072 live at
    the steady state; a 1 m hull seed births 67 particles in 2 s; the 5 m
    pool arm unchanged; `test:water` 40. Traps found on the way: three's
    `hash` TRUNCATES its float seed (a PCG on uint arithmetic keyed by
    index × frame, or the next frame re-probes its neighbour's points);
    flat-topped discs summed leave RINGS (Gaussians sum smooth); the pool
    is at its steady state only after a lifetime (the harness warms 8 s
    before the ocean shots). Splashes (Stage B) are next.
53. ⭐ SPRAY IS THE PAPER'S SECOND POOL (the same unit, later that day):
    splashCount = foam pool / 8 (16 k) in `waterSpectrum.js` — (x, y, z,
    age), (vx, vy, vz, life), (intensity, size) and a RETURNS buffer. A
    dead one is born within 100 m of the eye at a fold under the foam
    threshold − .1, on the crest's front face (along the crest ±0.05 λp,
    forward along the wave), thrown with twice the surface velocity,
    forward at 0.6 × and up at 0.7–1.5 × `speed` = 1.6 √(g σ) (3.5 m/s on
    the ocean preset) plus Box–Muller Gaussian turbulence at 0.3–0.35 of
    it — the paper's velocity rules, whose emission-time turbulence the
    paper reports makes PIC/FLIP unnecessary; or at an IMPACT seed
    (`waterPhysics.js`: a body meeting the water faster than 1 m/s at its
    first contact, or 2.5 m/s later, half a second between crowns per
    body → `simulation.addWaterSplash(x, z, r, speed)` → a crown of
    40 r² v particles, 20–600, up at 0.5–1.2 × and out at 0.35 × the entry
    speed). It flies ballistic IN THE SEA'S TIME (gravity, 0.4/s drag) and
    where it meets `seaDisplacementAt(...).y` it dies and writes (x, z,
    intensity, 1) into its own return slot; the foam step, which runs
    after it in the same queue, has a third branch — 30 % of the dead foam
    particles read a random return slot and are born where a splash
    landed (≈ one foam particle per returning splash per frame: secondary
    foam without atomics or a readback). Drawn as billboards
    (`spectrum.splashMesh`, added to the lid's object by
    GridSimulationComponent; `sp.scale` = the sea's metres per local unit,
    set by the solver; 0.5 σ metres, a soft white dot fading with age,
    renderOrder 100, `fog: false`). Receipts (ocean preset): 321 splash
    particles live after the warm-up; a 1 m / 4 m/s impact throws 229 the
    frame after and leaves 320 live foam particles within 4 m two seconds
    on; `test:water` 41 (a 3 m drop hands ONE crown at its entry speed, a
    body at rest none); the 5 m pool arm unchanged. Open: the returns do
    not yet drive the ripple field (the paper's eWave feedback) — that is
    a readback of the return slots every few frames into
    `addWaterImpulse` pairs, deferred until the look asks for it.
54. ⛔ PRODUCTION IS A RATE PER SQUARE METRE, NOT A SHARE OF THE POOL —
    and the pool must never be the thing that bounds it. The first pool
    probed 30 % of its DEAD particles a frame: bounded by nothing but the
    pool, it filled to the cap, and the user's boat sat in a leopard skin
    of blobs from the eye to the horizon, a stationary churn of births and
    deaths that did not stream with the current, with the hull's own
    seeds starved ("looks bad, not following the current", 2026-09-07).
    Four rules now: (1) FOAM_RATE = 16 probes per square metre per
    second over the window, whatever the pool (`tryRate` = rate × area ×
    dt / pool); (2) THE DENSITY GATE — a birth only where the map is not
    white yet, probability (0.9 − map)/0.9, so a fold fills to a sheet and
    stops; (3) SIZE BY DISTANCE — a speck is max(disc, 0.025 × its
    distance from the eye) wide and its birth chance falls with the
    square of that, so coverage per square metre is the same at 250 m as
    at 5 m while the far rings hold thousands of specks, not a million;
    (4) A LIVE COUNTER (an atomic the step increments, reset before it,
    read back every 20 frames) sizes the seeds' probes to the DEAD, so a
    hull's tail and a splash's foam come on a busy sea. With the reference
    ("better more small dots than large white blobs", user): the disc is
    0.025 λp (0.6 m on the preset), specks 0.5–1.5× that, a fold's
    specks are 2.5 : 1 streaks along the wind (or the current). Receipts
    (ocean preset, 8 s warm-up): foam .3 — 10 k live, whitecaps 1.2 %,
    far specks 0.94 %, hull seed 65; foam 1 — 111 k live (85 % of the
    pool), whitecaps 26 %, hull seed still 75; a 2 m/s current — 10 486
    particles alive across a second moved 1.97 m along it (2.00 expected:
    THE FOAM RIDES THE CURRENT, receipt `ocean: sea foam under a …
    current`); `test:water` 41, the 5 m pool arm passes. The far-band
    receipt is SPECKS over the band's mean (> 0.2 %), not white pixels: at
    250 m a speck is a few pixels the mips dim, as in the reference.
55. ⛔ ONE PARTICLE SYSTEM, ONE MOTION — the map IS the foam. After trap 54
    the user still saw the old foam: "flickery, unnatural, a noise pattern
    that does not move with it", and the new dots "don't move with the
    current". Three causes, none of them the pool: (1) the LOOK multiplied
    the map by fractal noise sampled at the WORLD position (bubbles,
    streak, patch) — the noise stood still while the particles streamed,
    and its `clock` animation flickered; (2) the RIPPLE FIELD's foam was
    still DRAWN as its own layer (sheet/torn/flecks with the same fbm) on
    top of the particles; (3) the SPRAY did not get the current (a frame
    trick the boat sits still in — everything on screen must ride it,
    drops in the air included). Now `waterFoam.js` draws the map with a
    soft threshold and nothing else (`sea.smoothstep(.06, .55)`, far the
    mip coverage), the ripple field is a particle SOURCE — gridSimulation
    hands the sea `spectrum.ripple` (the field's foam and flow at a local
    point, the scale; the kernels are built at the first tick so they can
    read it) and a dead particle probes the window at twice FOAM_RATE with
    the field's foam × 4 as its chance, while a live one inside the window
    rides the field's FLOW — and the splash step adds `currentVel · dt`.
    Spray is a cloud: the pool is a quarter of the foam's (32 k), the fold
    probe share .5 within 80 m, a crown 200 r² v (60–4000), and
    SPLASH_SPRITES = 4 billboards per drop, jittered three sizes around
    it. Receipts: whitecaps 3.5 %, far specks 2.07 %, hull seed 80, spray
    761 live, a 1 m / 4 m/s impact throws 1 170 drops (4 680 sprites,
    23 957 pixels brightened from 6 m) and leaves 428 foam particles; 2 m/s
    current — 1.97 m in a second; the 5 m pool's splash has 442 live foam
    particles within 3 m four seconds on (born from the field); the pool
    arm passes; `test:water` 41.
56. ⭐ SEA OF THIEVES' RECIPE ("if we could copy it that would be awesome",
    user). Its SIGGRAPH 2018 talk (Ang, Catling, Ciardi, Kozin): foam at
    wave peaks by the Jacobian, foam around intersecting objects from
    depth comparisons in a camera-centred window, the buffer progressively
    BLURRED WITH FEEDBACK so the foam disperses into a soft mask, and the
    mask "blended with artist-authored textures" — the mask is only WHERE,
    the texture is what foam LOOKS like; calm/normal/stormy states change
    generation, dispersion and blending. Ours now: the mask is the
    particle map ∨ the contact ring (both ride the water), with DISPERSION
    — a speck's splat grows 2.5× over its life and thins with it; the
    look is `waterFoamTexture.js`, a 512² tileable texture baked once on
    the CPU (135 ms): R the LACE (F2 − F1 walls of a warped periodic
    lattice at two scales), G the BUBBLES (domes with dark centres), B the
    PATCHES (a slow fractal); sampled in the WATER'S OWN FRAME — the
    pixel's rest position (world − the sea's horizontal displacement there)
    + the sea's scroll, so it rides the current and the orbital motion
    with the foam — at 2.2 m, 0.55 m and 0.35 m, and DISSOLVED by the
    mask: `grain.smoothstep(1 − mask ± .12)` keeps only the brightest
    walls under a faint mask (thin lace) and nearly all of it under a
    strong one (a sheet with bubble holes); the patches make the mask's
    edge ragged. The STYLIZED mode is the talk's own look — the soft
    dispersed mask with a coarse lace bite, hard-edged and flat
    (`u.stylized` mixes the two). Beside it: the lid WRITES DEPTH now (an
    authored material's `depthWrite: false` let the clipmap's far rings
    paint far crests over near ones at grazing angles and spray behind a
    crest show through it — "far waves appear in front of the close ones,
    same with sprays"); the water gained two dials, `splash` (spray
    amount 0–3: crowns, contact spray, the fold probes) and `splashSize`
    (0.3–3); and CONTACT SPRAY: a hull moving through the water faster
    than 1.5 m/s hands the sea COUNTED splash seeds off its LEADING
    waterline every frame — (through − 1) × 30 drops/s per leading sample
    at 0.6 × its speed (`addWaterSplash(x, z, r, v, count)`, each seed
    accepted by its share of the busiest, `sp.accepts`). Receipts (ocean
    preset): whitecaps 2.8 %, far specks 1.11 %, hull seed 77, a 1 m /
    4 m/s impact brightens 38 349 pixels from 6 m and leaves 374 foam
    particles; the 5 m pool's splash has 435 foam particles four seconds
    on; `test:water` physics 20 (a hull in a 3 m/s current hands > 20
    counted seeds in 2 s on its leading side; one at rest none), spectrum
    12. ⚠ `tests/water-interaction.test.mjs` fails on an UNCOMMITTED
    working-tree change to PhysicsSystem.js (`this.engine.batchHierarchy
    is not a function` — the test's engine stub lacks it); not this unit's.
57. ⭐ THE FOAM'S FLUID, AND WHAT THE USER'S SCREEN TAUGHT (a lot better,
    then four reports). (1) "Fluid motion like the 2D fluid sims":
    `waterFoamFlow.js` — a stable-fluids field on a 128 m camera window
    at 256² (half-metre cells): NOT the surface velocity projected (that
    would delete the crests' convergence) but a PERTURBATION `w` on top
    of it — shifted with the window, advected by sea + w (semi-Lagrangian),
    kicked by a three-octave divergence-free curl noise where crests fold
    (2.5 m/s² at a full fold), relaxed to the ripple field's flow inside
    its window (a hull's push, a splash's ring — the field carries it to
    the particles now), rolled up by vorticity confinement (ε .5 × cell),
    damped at .35/s, projected divergence-free by 12 Jacobi sweeps
    (warm-started) — 17 dispatches of 256² a frame. A foam particle inside
    the window moves at sea + w + current. Receipt: rms 0.11–0.12 m/s,
    peak 1.6–1.7 m/s, no blow-up; the current receipt still 1.96 m. (2)
    "Flickery, stuttering": a newborn speck popped in at full brightness
    (a half-second fade-in now) and the lace was tiled at 0.35–0.55 m —
    7 mm cells shimmering under any motion (4.5 / 1.3 / 1.6 m tiles now,
    feather .18). (3) "Spray flashes, flat planes that do not billboard":
    the billboard basis was built in the water's LOCAL space, and an
    ocean is scaled 500 × 60 × 500 — a camera-facing plane in local space
    is skewed edge-on in world space; the basis is world metres now and
    only the offset goes back through the inverse model matrix. (4) "The
    splashes are just under the water surface": spray was born at the
    SEA's height, but a bow wave lifts the lid by the ripple field's
    height, and the lid writes depth now — birth and death read sea +
    ripple. Beside these: a crown is a SHEET first (velocity smooth
    around the ring, three lobes, the rim fastest, turbulence .04 at
    emission) that TEARS with age (a random walk growing to 2.5 m/s² by
    0.8 s), drawn bigger and translucent early (opacity .45 → .9), its
    four billboards spreading apart as it ages; a wave SLAMMING the hull
    (the surface's climb at the body + its sinking > 1.5 m/s) and a bow
    in a current (> 1.5 m/s through, 60 drops/s per leading sample per
    m/s over the first, at the full speed) throw counted spray. Physics
    tests 20 (crowns are the uncounted seeds), spectrum 12, the pool arm
    passes (431 foam particles from the splash).
58. ⭐ THE SPRAY'S GRID, THE LACE ON THE FLUID, THE DIAL'S REACH. (a) "A
    bit of fluid motion like grantkot": a PIC/FLIP-lite — a 96 × 32 × 96
    grid of 25 cm cells around the eye (floor at −2 m); each frame the
    grid is cleared, every drop scatters Σv, Σp (relative to its cell's
    corner) and a count into its cell by fixed-point (×256) i32 atomics,
    and the splash step gathers its cell and six faces: a third of the
    way to the shared velocity (PIC), pulled toward the neighbourhood's
    centre of mass while loose (cohesion, 2.5 m/s² across a cell) and
    pushed away when packed (> 10 a cell, 0.6 m/s² each) — sheets and
    tendrils instead of beads; two dispatches of the pool and a clear.
    ⚠ `ivec3` must be imported, and `.toIVec3()` is not a TSL method —
    `ivec3(node)` is. (b) "Still flickering": the particles ride the
    FLUID's swirl but the lace's rest frame carried only the sea and the
    current, so the mask slid across the lace and the dissolve's edge
    shimmered — a FLOW MAP now: two lace samples advected by the swirl
    over a 3 s period, half a period apart, cross-faded by triangle
    weights (`spectrum.flow.at(p)` per pixel; the flow object is made
    EAGERLY so the look can read it, its kernels at the first tick), the
    dissolve feather .25. (c) "Even on 0.1 there is too much of it": the
    dial only set the fold threshold — the hull seeds, the ripple field's
    births, the splash returns and the contact ring ignored it. Now the
    seeds' want × (.2 + .8 foam), the ripple probes × (.15 + .85 foam),
    the returns' share × (.3 + .7 foam), the contact ring × (.3 + .7
    foam), and the density cap .5 + .4 foam. Receipts: foam .3 — 11 k
    live, whitecaps 3.5 %, far specks 1.9 %, hull seed 48, crown 47 541
    px, 488 foam from returns; foam .1 — 2.4 k live, far specks 0.08 %
    (the far-band gate is for the preset's .3); the pool arm passes;
    physics 20 + spectrum 12. ⚠ The user's "Binding size for [Buffer] is
    zero … bindGroup_object entries[5] Vertex ReadOnlyStorage" is NOT in
    the console since their 11:04 reload and matches no water material
    (the spray binds three storage buffers, the splat two); the spray
    mesh opts out of batching/merging regardless — paste the lines before
    it if it recurs.

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
