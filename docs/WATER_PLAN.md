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

## Open

- A GI harness irradiance receipt for the water terms (mirrored sun, the
  through-water attenuation and sky mirror).
- At 500 m a 6 m walk re-snaps the rings by a 10 m cell (7.0 vs 5.0 for one
  tick of motion) — per-level snapping with trims would remove the pop.

## Harness

`npm run smoke:water-premium` (`?scales=5,60,500`, `?shape=sphere|cylinder|
cone|capsule&fill=.75`, `?shaftMip=N`), `smoke:water-surface`,
`smoke:water-spectrum`, `smoke:water-props`, `smoke:water-rate`,
`scripts/water-bindings-smoke.html?msaa=1`, `npm run test:water`.
