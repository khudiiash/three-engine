# Radiance Cascades (3D) — Implementation Plan

**Goal:** replace the temporally-accumulated probe field in `src/modules/gi/` with **3D Radiance Cascades (RC)** as the main global-illumination transport, keeping the parts of the current module that already work (voxel clipmaps, light/emissive injection, dynamic GPU splats, deferred resolve, material integration, SSR hybrid).

**Why:** every remaining complaint about the current GI is a symptom of one architectural fact — the probe field is a *temporal feedback loop* (round-robin windows + EMA hysteresis + multi-bounce feedback). That makes it inherently laggy (light "redraws later"), forces the fast-vs-flicker tradeoff, requires the recenter fade hack, and needs per-case motion heuristics (grace frames, motion sweeps, realtimeInject). Radiance cascades re-compute the *entire* radiance field **every frame** at amortized cost: angular resolution grows with distance while spatial resolution shrinks, so total ray count stays bounded. Result: 1-frame response to any change, no convergence, no hysteresis tuning, no recenter flash.

---

## 1. Radiance Cascades in 3D — the math we're committing to

A cascade hierarchy `c0 … cN` of probe grids centered on the camera:

| Per cascade `i` | Rule |
|---|---|
| Probe spacing | `s0 · 2^i` (probe count per axis halves → count ÷8) |
| Directions per probe | `D0 · 4^i` (octahedral map, res doubles per axis) |
| Ray interval | `[t_i, t_{i+1})`, `t_i = t0 · 4^i` (t_0 = 0; last cascade ends at sky) |

Each ray stores **RGBA** = radiance over its interval + transmittance (A = accumulated opacity). Total ray count *halves* per cascade in 3D (×4 dirs, ÷8 probes), so the hierarchy converges — c0 dominates cost.

**Merge (top-down, `cN → c0`):** for each ray `r` of probe `p` in cascade `i`, sample cascade `i+1` at the 8 surrounding probes (trilinear) and the 4 child directions of `r`, average, then composite through the interval: `L = L_near + T_near · L_far`. After merging, **c0 holds the fully-integrated radiance field**; the screen only ever reads c0.

**Final gather:** per pixel — trilinear-interpolate the 8 surrounding c0 probes, integrate the (few) c0 directions against the cosine lobe of the G-buffer normal. c0 needs only 4–8 directions because all far detail has been folded in by merging.

### Concrete starting parameterization ("balanced" tier)

Camera-centered, ~32×16×32 m coverage before sky:

| Cascade | Probes | Dirs (octa) | Interval | Rays |
|---|---|---|---|---|
| c0 | 64×32×64 | 4 (2×2) | 0 – 0.75 m | 524k |
| c1 | 32×16×32 | 16 (4×4) | 0.75 – 3 m | 262k |
| c2 | 16×8×16 | 64 (8×8) | 3 – 12 m | 131k |
| c3 | 8×4×8 | 256 (16×16) | 12 – 48 m | 66k |
| c4 | 4×2×4 | 1024 (32×32) | 48 m – sky | 33k |

≈ **1.0 M rays/frame**, each a short DDA march over only its interval in the existing voxel clipmap (with radiance-mip acceleration for far cascades: coarse cascade rays step in coarse voxel mips — cost per ray stays roughly constant across cascades). Storage at RGBA16F ≈ **8–9 MB total** — an order of magnitude *less* than the current probe+moments buffers.

Storage layout: one `Storage3DTexture` (or 2D atlas) per cascade, probe-major with the octahedral direction tile inlined per probe (same trick as the current `OCTA_RES`/`MIP_GAP` atlas in `giCompute.js`), RGBA16F, ping-pong not required (merge writes a second "merged" texture per cascade, read by cascade `i-1`).

---

## 2. What is kept, replaced, removed

### Kept (unchanged or lightly adapted)
- **Voxel clipmaps as the ray-march medium** — `voxelizer.js` (CPU static, incremental region re-bake, `shiftGrid` scrolling), `gpuVoxelizer.js` (dynamic splat pool with stride-decimation), partial-buffer uploads. RC rays march exactly the buffers `marchRadiance` marches today.
- **Direct + emissive injection** — `injectDirectNode` populating `voxDirect` / `voxEmissiveDirect` / sun shadow march. RC interval rays *sample lit voxels*, so everything already injected (sun, `MAX_LOCAL_LIGHTS` loop, emissive area proxies) transfers for free.
- **Deferred half/full-res evaluation + bilateral resolve** — `giDeferred.js` (`resScale`, 5×5 bilateral, normal/depth gates). Only its *source sampler* changes (cone gather → c0 gather).
- **Material integration** — `GIProbeVolumeLightNode` (irradiance + `context.ambientOcclusion` + `context.radiance` for reflections). Interface unchanged; internals re-pointed at RC output.
- **SSR hybrid reflections** — `postGraph.js` composite (`ssr.a==0` miss mask → GI fallback). Fallback source becomes an RC directional lookup (c1/c2 ray in the reflection direction — RC natively stores directional radiance, which is *better* than today's single cone).
- **Module shell** — `index.js` module registration, `GlobalIlluminationComponent` schema/preset pattern, editor debug-view plumbing, `gi-diag*` harness family + `run-gpu-page.mjs` headed-Chrome recipe.

### Replaced
- **Probe trace/integrate/moments pipeline** (`traceNode`/`integrateNode`, round-robin `probesPerFrame`, hysteresis EMA, `PROBE_MOTION_SWEEPS`, `DYNAMIC_RESPONSE_SECONDS` grace logic) → cascade **interval-trace + merge** passes, re-run every frame.
- **Cone gather** (`coneDiffuseFn`, `coneSteps`, aniso radiance mips as the *gather* source) → c0 final gather. Aniso mips survive only if we keep them as the far-cascade march accelerator (decide in Phase 1; plain isotropic mips may suffice).
- **AO channel**: derive from **c0/c1 interval opacity** (near-field alpha ≈ bent-cone occlusion) instead of cone `skyReach`/contact terms. Same `gi.w` slot into the light node.

### Removed (the complexity RC deletes)
- All motion-latency machinery: `radianceBlend`/`directBlend` EMA response, grace frames, motion sweeps, `realtimeInject` chunk-budget escalation, per-volume `lastDynamicFrame`.
- The **recenter fade** (`cascadeTarget=0` blend dip): RC has no temporal history in the probe field, so recentering = scroll the probe grid origins, done. (The *voxel* clipmap keeps its existing shift-recenter; the GPU direct-cache shift problem stays but is masked far less since probes no longer accumulate.)
- Multi-bounce probe feedback loop as the *primary* bounce mechanism (see §3.4 — feedback survives in a simpler, non-latency-critical form).

---

## 3. Pass structure (per frame)

```
[unchanged] voxelize static (incremental) / dynamic splat / injectDirect (chunked)
1. Interval trace   — one compute dispatch per cascade (cN…c0, order-free):
                      ray = probeCenter + dir·t, DDA over voxel clipmap interval
                      [t_i, t_i+1); sample voxDirect+voxEmissiveDirect+feedback
                      radiance at hits; out: RGBA16F interval texture.
2. Merge            — one dispatch per cascade, top-down cN→c0:
                      merged_i = interval_i ⊕ trilinear(merged_i+1, 4 child dirs);
                      cN merges with sky (skyColor·skyIntensity per escaped ray).
3. Screen gather    — giDeferred pass: per pixel trilinear 8×c0 probes ×
                      cosine-weighted dirs → irradiance + AO(w); existing
                      bilateral resolve on top.
4. Bounce feedback  — write c0 irradiance (cheap SH/ambient per cell) back into
                      the voxel radiance buffer (replaces current probe-feedback
                      inject); next frame's rays see it = bounce 2+.
```

Amortization levers (only if profiling demands): trace c3/c4 on alternate frames (far field changes slowly, still no visible lag); c0/c1 always every frame. Merge is cheap (pure texture math, no marching).

### 3.1 Interval trace details
- Direction set: fixed octahedral texel directions per cascade (`octaTexelDirections` already exists in `giCompute.js` — reuse).
- March: reuse `marchShadow`-style DDA (nested `If/Else`, whole-vector assigns — **the TSL pattern that works**; the `.ElseIf`+component-assign variant killed probes in v18). Far cascades step through radiance mips (coarser step per cascade) to keep steps/ray ~8–16 everywhere.
- Hit shading: voxel albedo × (voxDirect + voxEmissive + feedback radiance), same side/ambiguity gates as today (`radianceSideGate` incl. the v19.1 ambiguous-cell gate — this is what keeps sealed rooms at 0.000).
- Escape (A < 1 at interval end): contributes nothing; sky is composited only at cN so it's occluded correctly by *all* nearer intervals.

### 3.2 Merge details & leak control
- Vanilla RC leaks light through thin walls at probe scale ("bilinear leak"). Mitigations, in order of cost: (a) normal-offset the *gather* sample point (we already have `normalBias`), (b) opacity-weighted trilinear at merge time — down-weight a neighbor probe if the voxel grid says the segment probe→neighbor is blocked (1 cheap opacity lookup per tap; voxel occupancy is resident), (c) if still leaking: the "bilinear fix" variant (trace from child-probe positions). Start with (a)+(b); (c) is a contained change to the trace pass only.
- Ringing at interval boundaries: use `t_i` overlap of ½ voxel + stochastic per-probe interval jitter folded into the bilateral resolve (no temporal history needed).

### 3.3 Screen gather
- c0 probe grid is denser than today's probes (64×32×64 vs current probe counts) → less blockiness at the source. Keep the 5×5 bilateral resolve initially; expect to *shrink* it (RC output is far smoother than mip-cone output — the "large rect blocks" came from the trilinear radiance-mip pyramid, which is no longer the visible path).
- AO: `w = 1 − alpha(c0 ∪ c1)` shaped by the existing smoothstep enclosure curve (v19.4 lesson: don't let near-wall contact darken whole rooms).

### 3.4 Bounces
- Bounce 1 (direct → surface): **1 frame latency, always** — this is the headline win.
- Bounce 2+: c0 irradiance written back into voxel radiance each frame. This is a feedback loop again, *but* it only carries the (dim) secondary energy, so its convergence lag is visually negligible — no hysteresis tuning, fixed blend ~0.5. `bounce` prop keeps scaling the fed-back energy.

---

## 4. Integration with the module shell

- **Component:** add `giMode: "cascades" | "probes"` (default `"probes"` until Phase 4 sign-off, then flip). New custom-mode props: `cascadeCount`, `c0Spacing`, `c0Directions`, `intervalScale`. Presets:
  - `performance`: 4 cascades, c0 48×24×48 × 4 dirs, giResScale 0.5
  - `balanced`: table in §1, giResScale 0.5
  - `quality`: c0 80×40×80 × 8 dirs, 5 cascades, giResScale 1.0
  - Deprecate (hide, keep serialized): `probesPerFrame`, `hysteresis`, `lightingResponse`, `coneSteps`, `realtimeLighting`, `probeMotionSweeps`.
- **Debug views:** `cascade-0`…`cascade-N` (raw interval radiance as probe-sprite grid), `cascade-merged`, keep `gi-only`, `voxels`, `enclosure`, `shadow`.
- **Recenter:** each cascade grid scrolls independently in its own probe-spacing increments (coarser cascades scroll rarely). No fade, no history shift. Voxel clipmap recenter unchanged.
- **File layout:** new `radianceCascades.js` (data + trace/merge TSL nodes) + `rcGather.js` (deferred sampler + light-node source); `GISystem.js` orchestrates both modes during transition; delete probe-path code when `"probes"` mode is retired.

---

## 5. Implementation phases

Each phase ends with a headless GPU check (`npx vite --port 5199 --strictPort` + `node scripts/run-gpu-page.mjs http://localhost:5199/scripts/<harness>.html 90000`, `HEADED=1` for timing) — no editor click-throughs until a phase explicitly asks for a user visual.

**Phase 0 — Spike (1 session).** New `scripts/gi-diag-rc.js/.html`: Cornell room from the existing diag, hand-rolled *single* cascade (c1-like: 16³ probes × 16 dirs) tracing the live voxel clipmap; readback probe texels. Proves: TSL trace node compiles fast (<1 s — watch the `Loop()` vs unrolled-JS-for lesson), interval radiance is sane (lit wall bright, sealed room 0), storage-texture layout works. **Gate: go/no-go on the whole plan.**

**Phase 1 — Cascade hierarchy + trace.** `radianceCascades.js`: allocation for N cascades from a preset table, per-cascade trace dispatch, octahedral direction indexing, mip-accelerated far march. Debug view `cascade-i`. Harness asserts: per-cascade energy present, ray-count/only-interval coverage (near emissive lights c0 but not c3), total trace GPU time budget < 3 ms desktop (measure with the perf-tools timestamp stats).

**Phase 2 — Merge + screen gather.** Top-down merge pass; `rcGather.js` deferred sampler; `GIProbeVolumeLightNode` reads RC when `giMode==="cascades"`. Harness (extend `gi-diag-rc`): **sealed/open protocol must reproduce current bar — sealed ≈ 0.000, open > 0, ratio ≫ 100**; color-bleed RGB assertion near red/green walls; sky occlusion (interior pixel sees no sky term).

**Phase 3 — Dynamics + response (the payoff).** Wire dynamic splat scene into RC harness: drag emissive box across room, assert radiance tracks **same-frame** (RAD R/L crossover within ≤ 2 frames of the box crossing — vs ~300–700 ms today); moving occluder shadow updates ≤ 2 frames; **zero** main-thread spikes > 5 ms attributable to GI during drag. Bounce feedback in; verify bounce 2 energy in `gi-diag` and stability (no oscillation over 13 s time-series).

**Phase 4 — Parity features.** AO channel from interval opacity (compare `aoStrength` look vs current in editor — *user visual*), reflections fallback from RC directional lookup (rewire `context.radiance` + verify `gi-diag-hybrid.js` still passes), recenter fly-through (`gi-diag-recenter.js`: center tracks, **no cascadeBlend fade events at all**), quality tiers, memory report (expect < 200 MB total at balanced incl. voxels). **User visual sign-off on: blockiness vs current, sealed-room look, mover responsiveness.**

**Phase 5 — Switchover + cleanup.** Default `giMode: "cascades"`; migrate presets; delete probe trace/integrate/moments code + motion-latency machinery (≈ large negative diff in `giCompute.js`/`GISystem.js`); update module description; memory-file update; keep `"probes"` behind a flag for one release only if Phase 4 surfaced look regressions.

---

## 6. Risks & mitigations (informed by this module's history)

| Risk | Mitigation |
|---|---|
| **Shader compile stalls** (the 13 s `injectDirect` lesson) | Trace/merge shaders are *small* (no light loop — lights live in voxels). Keep all per-direction/per-tap loops as GPU `Loop()`, never JS-unrolled; budget: no pipeline > 1.5 s compile, measured in Phase 0. |
| **8-storage-buffer bind limit** (ReSTIR lesson) | Cascades are *textures* (sampled 3D/atlas), not storage buffers; trace reads voxel buffers (already ≤ limit) + writes 1 storage texture. |
| **TSL DDA footguns** (v18 dead-probe bug) | Copy the proven `marchShadow` control-flow pattern verbatim; Phase 0 exists to catch this class early. |
| **Bilinear/trilinear light leaks** through thin walls | §3.2 ladder: normal offset → opacity-weighted merge taps → bilinear-fix variant. Sealed-room 0.000 assertion is the regression tripwire in every phase. |
| **c0 memory/time blowup on quality tier** | c0 dominates (~50 % of rays); tier table caps c0; dispatch is camera-centered so cost is scene-independent. Alternate-frame far cascades as pressure valve. |
| **Voxel medium still coarse** (blockiness has a floor) | RC removes the *mip-pyramid* block artifact (the visible one), but hit shading still quantizes to voxels. Honest ceiling stays: voxelRes is the lever; RC makes higher voxelRes cheaper to afford by deleting probe-sweep cost. |
| **Sky/env double-count** with HDRI environment | Keep current convention: RC composites sky only at cN escape; `replaceAmbient` behavior unchanged; env IBL still occluded via `gi.w`. |
| **Big-bang rewrite risk** | `giMode` A/B flag until Phase 4 sign-off; every phase keeps `npm run build` + all `test-gi.mjs` suites green; old path untouched until Phase 5. |

## 7. Success criteria (definition of done)

1. Moving an emissive object or occluder: GI response ≤ 2 frames (measured in harness), no spikes, no flicker — with **zero** motion-special-case code.
2. Sealed room: 0.000 leak; open ratio ≫ 100 (current bar held).
3. Camera fly-through: no lighting flash/fade on recenter (`gi-diag-recenter` clean).
4. GPU cost at balanced ≤ current balanced (±20 %), memory strictly lower.
5. Net LOC in `src/modules/gi/` goes **down** after Phase 5.
6. User visual: less blocky than current at same voxelRes, colors bleed, quality tiers feel distinct.

## 8. References

- A. Sannikov, *Radiance Cascades* (Exilecon 2023 / paper draft) — core interval/merge math.
- tmpvar & shadertoy RC 3D prototypes — 3D parameterization sanity checks (dirs ×4, probes ÷8, intervals ×4).
- This repo: `scripts/gi-diag*.js` harness family, `scripts/run-gpu-page.mjs` (headed-Chrome WebGPU recipe), `giCompute.js` octahedral atlas helpers, `voxelizer.js` clipmap shift.
