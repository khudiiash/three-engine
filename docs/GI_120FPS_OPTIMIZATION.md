# GI 120 fps optimization — Balls, 2026-09-11

## Contract

Target the currently open GAME/scenes/Balls.scene at its actual viewport, with 120 presented frames/s and margin. Preserve authored quality, resolution, geometry, lighting energy, transport update cadence and temporal response. Portable WebGPU: at most eight storage buffers per stage. Test motion as well as a parked camera; GPU timings alone do not prove frame rate.

## Original live baseline

Clean engine worktree. Scene saved, 364 entities; 350 balls batch into shared geometry. Editor camera position `[-3.1313174832475985, 1.9481157465585555, 9.025092182836563]`, target `[-2.032031634006045, -0.7404068789767213, 1.0456863264680534]`, FOV 60.

Drawing buffer 1768×962, GI resolve 1250×680, emitter shadows 344×187. High GI, bounce 1, AO 1, reflections .25. Render scale 1; dynamic resolution and adaptive quality disabled. Existing persisted GI debug flags are retained: gather normal bias 0, gather smoothing 0, SRC logging true, resolve follows viewport false, static draws true.

| Capture | Presented fps | CPU/frame | GPU/frame | Detail |
| --- | ---: | ---: | ---: | --- |
| Initial parked read | 101 | 4.91 ms | 3.49 ms | 19 draws, ~337k triangles |
| Parked CPU, 60 frames | — | 5.67 ms | 3.50 ms | GI screen chain 2.21 ms, GI total 2.73 ms |
| Frame audit, 2 s | 93.7 | 6.07 ms including callback | — | 0.21 ms other work; 4.39 ms actual wait |
| Camera orbit, 8 s at 20°/s | 83.3 | 6.55 ms captured mean | 2.79 ms last window | World chain 15 Hz, GI screen chain 2.27 ms |

Raw local receipts: `.gi-baseline-{frame,cpu,audit,passes,orbit}.json` and `.gi-baseline-view.png`. These are measurements in the user's live Tauri editor, through its supported MCP ops. GPU pass profiling pauses the renderer and dispatches passes in isolation; its sum is **not** a per-frame total.

Main GPU costs: world deposit 1.38 ms and shade .90 ms at 15 Hz; GTAO plus filters .71 ms every frame; screen gather .31 ms; emitter shadows ~.48 ms. World idle currently rejects the emissive-only scene as `no lights`; changing convergence/sleep is outside the exact-work optimizations until separately justified.

## Retained changes

- `giComputeSubmissionBatch.js` aggregates adjacent command-buffer submissions within the original synchronous `giCompute` loop. Each pass, uniform update, timestamp and dependency remains in its original order. Queue writes, completion fences, resource disposal and readback copies flush pending submissions first. The shared uniform-buffer and immediate `mapAsync` boundaries are correctness requirements. Runtime A/B: `__giComputeSubmitBatch = false`.
- `giGtaoHold.js` reuses deterministic GTAO and its bilateral filters only after the whole chain successfully dispatched with identical g-buffer generation/resources, camera uniforms, AO settings and output resources. The first changed frame recomputes the entire chain. World/cone/ray-traced AO is excluded. Runtime A/B: `__giGtaoHold = false`.
- Profiling now reports GTAO holds and actual submit savings. `profile.giAoParity` reads the live native half-float texture and proves that a strength change reaches pixels before restoring the original value/output. `profile.gpuIsolation` stops the editor loop and holds simulation, with explicit release and a bounded automatic timeout.

Those initial changes did not alter authored settings, resolutions, shader math, probe/ray counts, world update cadence, temporal weights or geometry.

## Regression recovery and measurements

The user initially reported 30–40 fps after an original 100–110 fps, then corrected the report: the browser had cached an older build. The current published player showed about 85 fps settled and 45 fps under heavy motion. Diagnostic counter sharding and shared command encoders were removed from production. The separate test Vite was stopped, and the live editor was reloaded to remove previously installed renderer wrappers. A flag alone cannot uninstall those wrappers.

Counter sharding passed exact GPU output checks but made the isolated screen gather about 3.5–3.8 times slower than the unsharded control. It was rejected. Shared command encoders passed functional GPU checks but had no reliable performance win and were also rejected. Their source and receipts are archived under ignored `.gi-shots/optimization120/`.

The additional Vite server and browser workloads contaminated intermediate performance measurements. Stopping the owned test server and disabling the experiments recovered 105 fps. The user subsequently identified the 30–40 fps browser observation as a cached older build; it is excluded from comparisons of the current player. Subsequent checks used the existing local Vite and stopped the editor loop during external GPU tests.

At the user's later camera position, after GI was active and settled:

| Same-session capture | Presented fps | CPU mean | GI screen-chain CPU | World updates/s |
| --- | ---: | ---: | ---: | ---: |
| Stationary, retained changes | 120 | 4.14 ms latest | — | 15 |
| Camera orbit, submission batching on | 109.8 | 4.442 ms | 1.334 ms | 14.6 |
| Same orbit, submission batching off | 83.8 | 4.559 ms | 1.511 ms | 14.4 |
| Same orbit, submission batching on again | 116.5 | 4.442 ms | 1.324 ms | 15.0 |

Orbit captures count actual frames over eight seconds at 20 degrees/s and restore the camera. They retain all quality settings. The stationary capture had 18 GI dispatches on the sampled frame, GPU compute 4.07 ms, 19 draws and 337,035 triangles; it was not an empty pre-GI frame. Submission counters recorded 210,521 requested submissions reduced to 31,828 actual submissions, with zero flush errors.

Do not compare the current camera directly to the initial camera as a controlled A/B: the user moved the view, and exploration also populated more world probes. Several `.gi-restored-*` captures reported 120 fps with zero GI GPU work during boot; those captures are invalid and excluded. GPU pass profiles dispatch kernels in isolation and are not frame-budget totals.

## Validation and remaining acceptance

- 46 dispatch/submission/GTAO tests passed, plus six existing GI lifecycle tests. Submission tests cover queue ordering, reusable submit arrays, uniform overwrites, fences, resource destruction, readback, nested scopes and errors. GTAO tests exercise the production dispatch block and all invalidation boundaries.
- Live AO parity passed at 1250×680: all 6,800,000 bytes matched between held/fresh/repeated/restored results. Halving AO strength changed 401,652 bytes, proving a responsive fixture. The final reload was also checked at the then-current 1253×680 resolve: all 6,816,320 bytes matched, and the strength control changed 831,161 bytes (`.gi-final-ao-parity.json`).
- Final real GPU reruns passed after removal of rejected experiments: submission parity (`.gi-final-batch-gpu.log`), the required portable-eight smoke (`.gi-final-portable-gpu.log`), and the full SRC composed graph with `?src=1` (`.gi-final-src-gpu.log`). All emitted `GI-SMOKE PASS` with zero validation errors. The batching fixture preserved dependent/uniform/copy/readback/render outputs exactly and reduced five warm submissions to one. Tests used the existing Vite at `http://localhost:1420` (bound to IPv6 loopback, so IPv4 `127.0.0.1` refused the connection); no second server was started. The live editor was verified at zero callbacks/fps during isolation and explicitly resumed afterwards.
- Existing broader cadence and GTAO-quality suites each contain one pre-existing structural expectation inconsistent with the initial checkout; this task did not change those contracts or tests.

**The 120 fps target remains unmet during Play and camera movement.** The final Play capture (`.gi-final-play.json`) recorded 97 fps, CPU 6.56 ms and GPU 12.38 ms. The original Play capture recorded 84 fps, CPU 8.51 ms and GPU 8.97 ms, but these captures do not control the same motion and simulation time: they are observations, not a clean A/B performance win. Stationary 120 fps and the controlled orbit submission results do not complete the original performance contract.

Final editor state: Play stopped and normal rendering resumed; stationary capture after all GPU tests was 120 fps, CPU 4.12 ms, GPU 3.80 ms, render scale 1 and active GI dispatches. No console errors. The five original persisted GI flags remain; both temporary optimization overrides were removed. Rejected encoder fields are absent from the fresh renderer's stats, confirming the reload removed the experimental wrappers. `.gi-final-view.png` records the inspected current view.

## Next candidate: unchanged uniform-array uploads

Three already suppresses unchanged scalar, vector and matrix uploads through `UniformsGroup`'s JavaScript-number cache. `NodeUniformBuffer`, used by GI uniform arrays, instead inherits `Buffer.update()` returning `true`; eligible arrays can therefore upload identical packed bytes repeatedly. A possible exact optimization is to skip a full-buffer `backend.updateBinding` upload only for `isNodeUniformBuffer` when its packed bytes match the last successful upload to the same GPU buffer. Compare integer bytes without float tolerances, always upload after buffer creation/replacement, preserve write ordering and partial updates, and exclude GPU-written storage buffers. Dynamic header uploads already have a dirty-dispatch gate, so they are not evidence of a steady-state bottleneck.

Before implementing, measure actual redundant upload counts, bytes and submission flushes in the live moving/Play scene. Require exact output parity, lifecycle coverage and a controlled same-camera/same-motion A/B/A performance gain; source inspection alone does not establish that this candidate closes the remaining frame-time gap. No implementation of this candidate is retained.

The later `UPLOADS=1` player audit observed 31,998 unchanged uploads out of 40,012 while settled, and 20,030 out of 28,092 during motion, each over ten seconds. It forwards every real write and compares exact bytes by binding and GPUBuffer identity, including partial ranges. This instrumentation adds CPU overhead and is disabled for performance measurements; no speedup from skipping those uploads has been established, so no production upload suppression is retained.

Raw local measurements, screenshots, test logs and rejected experiments are retained under `.gi-shots/optimization120/`. For repeat measurements, wait for GI dispatches and real compute timings after boot, avoid concurrent builds/tests, use one unchanged camera and boot for A/B/A, and serialize all GPU workloads. `suspendSimulation` alone does not stop raster rendering; isolation must also stop the engine loop. Keep browser profiles outside the Vite workspace.

## Actual browser motion and session aging

The user clarified the workload: a static camera, many colliding balls, and a moving emissive sphere. The native screenshot corresponds to a 2872×1532 physical canvas. The player resolves GI/GTAO at 1732×924 and emitter shadows at 476×254, substantially larger than the earlier editor view. All browser runs retain those resolutions, authored quality, light response, physics and input behavior; the harness sends pointer moves without clicks.

The exact published player was copied from the existing local export into an isolated test folder and served unchanged. Its `scene.json` matches the deployed build. Browser runs were serialized after the user closed the competing game tab; the original then measured 97.1 fps settled and 47.5 fps under a ten-second pointer sweep (`browser-isolated-original.json`). Cold/warm driver state and ongoing physics matter: report repeated captures rather than treating an isolated kernel sum as a frame total.

Three concrete lifecycle issues were identified:

- **SRC statistics scheduling:** `_frame` is a fingerprint counter reset by component changes, not a monotonic clock. It triggered 39 GPU statistics readbacks in ten seconds of heavy motion instead of about eight. `readStats` also drives adaptive ray-cap feedback. `#maybeLogSrcProbeStats` now uses an independent tick and retains the pending-read and retired-state protections. The twenty-second fixed run made 16 reads at 46.9 fps, matching the intended cadence. The profiler uses passive `readPressure` for snapshots; it never triggers extra `readStats` feedback.
- **FPS text GPU buffers:** the HUD rebuilds every 250 ms. Replacing position/UV/index attributes on the same live geometry orphaned the previous GPU buffers; Three's memory accounting strongly retained them. Across the 191-second stats-only soak, ordinary attributes grew 342→1502 and index attributes 170→750 while geometry count stayed five. The SDF text builder now reuses same-sized attributes, updates their versions, and disposes the whole previous geometry before a glyph-count replacement. Tests prove unchanged positions, UVs, winding and bounds, and reproduce the old leak as a negative control.
- **Timestamp history:** Three retains every frame-qualified GPU timing UID in a JavaScript Map. The engine now retains eight query-pool capacities (8,192 entries per pool), including every latest successful batch. Pending/failed reads, pool totals, Map identity, and immediate profiler/Inspector reads are preserved. No GPU work or rendered pixels are changed.

Probe population also grows after movement, but this is not evidence of a duplicate leak. Records describe distinct spatial cells, have no ball ownership, and remain valid interpolation neighbors until their existing retention rules expire. The measured SRC allocation stayed bounded; deleting those records early would change lighting. Adapter-wide `nvidia-smi memory.used` is contextual telemetry, not a measurement of this browser process alone.

The per-object world-box rejection experiment passed exact GPU comparisons but was slower and was removed. Grouped rejection, which skips consecutive sets of 16 objects and preserves intersection order, passed portable-eight parity and measured 0.625→0.569 ms in a warmed 65,536-ray ordered-grid fixture. More representative captured ball layouts overturned that result, so it was removed too.

The fresh player soak (`browser-candidate-soak.json`) completed 193 seconds with **10 ordinary attributes, four index attributes and 853 memory records throughout**, and both timestamp maps held at 8,192 entries. The JavaScript heap varied between 145 and 167 MiB and returned to 146 MiB. No browser/GPU errors occurred. These are direct measurements of the fixed lifecycle paths; they do not establish that every cause of session slowdown has been eliminated.

On the same player build, grouped traversal off/on recorded 92.9/104.5 fps settled and 46.7/46.6 fps during twenty-second pointer sweeps. Thus consecutive grouping has no demonstrated heavy-motion frame-rate benefit. The longer soaks are unsuitable as controlled comparisons of recovery speed: they ended in different rest states (one held its g-buffer at 15 Hz world updates; another still updated geometry and used 30 Hz). Those captures did not measure sleeping bodies, so continued physics cannot be confirmed as their cause. The probe budget also responds to the resulting field. Screenshots confirm that the scene and FPS text render, but different physical poses cannot establish full-frame pixel parity.

Validation after the lifecycle fixes: 67 focused CPU tests, 73 existing UI checks, player build, dynamic intersection/publication GPU parity, and both the default and SRC-enabled full composed WebGPU smoke passed. The composed shaders remain within eight storage buffers. Browser profiling logs are written separately from command stdout, and browser closure runs even if a diagnostic write fails.

The final shadow experiments are **all rejected**. On the captured resting ball layout, original/consecutive/spatial traces measured 0.604/0.740/0.668 ms; on the seeded collision layout, 0.606/0.753/0.693 ms. Spatial grouping also raised CPU synchronization from about 0.10 to 0.20 ms. Every arm passed exact ray-output comparisons, but correctness alone is not a performance result. `dynamicObjects.js` is restored to its original version; experimental source, fixtures and measurements are archived under the ignored receipts directory. The retained production work consists of submission batching, exact GTAO reuse, the SRC statistics clock, SDF text buffer lifecycle and bounded timestamp history.

## Final browser verification and handoff

The final player contains all retained fixes and the original dynamic intersection shader. It is available locally at `http://127.0.0.1:5349/browser-player-final/`; the public site was not changed. The authored scene and assets were copied from the original export. Both scene files have SHA-256 `7413BD0CF07D053D6BD1C1FF7D22FE8499E5D9A2A45F166622DBF27F6F1740BE`. The original export markup is preserved, with only the engine entry and build timestamp replaced.

Two final runs used the unchanged 2872×1532 canvas and twenty-second capture windows:

| Capture | Settled fps | Heavy motion fps | Post-motion fps |
| --- | ---: | ---: | --- |
| `browser-final.json` | 94.5 | 52.1 | 68.1, 70.1, 60.5; geometry remained active at the endpoints |
| `browser-final-physics.json` | 90.1 | 47.1 | 73.4 while settling, then 86.7 fully rested |

The second run additionally counted actual Rapier body state outside the timing windows. Initially all 350 dynamic bodies slept; during the sweep all 350 were awake, with maximum linear/angular speeds of 23.04 m/s and 44.49 rad/s. Both post-motion endpoints had zero awake bodies and zero speeds. The last twenty-second window contained 1,735 rested frame samples out of 1,735, zero GTAO dispatches and 300 world updates (15 Hz). GPU time returned from 20.21 ms during motion to 9.15 ms, versus 8.79 ms initially. This capture demonstrates recovery once the balls sleep, rather than a permanently invalidated g-buffer.

World cadence also responds to moving occluders: `readAlpha()` includes `sceneMotion()` and the dynamic-object motion signal, despite its `mLightNoCam` label. Stopping the emissive sphere alone therefore does not imply that world transport can return to its existing rest cadence. The profiler now reads the actual `__giSrcRestTermsLive` and `__giSrcRestDriveNoCamLive` globals; older receipts omitted this breakdown because they referenced a nonexistent system field. Per-pass dispatch counts remain the measured cadence evidence.

Resource counts stayed at 10 ordinary attributes, four index attributes, 853 memory records and 8,192 timestamps per pool in both final runs. In the longer final run the JavaScript heap ended at 143 MiB after ranging from 150 to 162 MiB. Both runs recorded zero browser/GPU errors. Probe retention remained bounded and continued to influence workload after motion; these measurements do not prove every possible long-session slowdown is resolved.

Final checks after removing every shadow experiment: the player build passed, the dynamic-object suite passed, and both the default and SRC-enabled composed GPU smoke emitted `GI-SMOKE PASS` with no WebGPU validation errors at the portable eight-buffer limit (`final-player-build.log`, `final-dynobj-original.log`, `final-portable-retry.log`, `final-src-after-removal.log`). One earlier smoke attempt ended with a detached browser frame and is excluded; the rerun passed. The 67 focused tests and 73 existing UI checks also passed. Subsequent changes are diagnostic/report-only and do not change the tested player runtime.

**Acceptance remains incomplete: heavy motion is approximately 47–52 fps, not 120 fps.** The retained lifecycle fixes remove demonstrated unbounded growth; they do not establish a substantial heavy-motion speedup over the original isolated 47.5 fps. Full-frame visual equality across independently evolving physics runs has not been established. The authored quality settings and original shader math remain unchanged, exact GTAO/submission parity passed, and the UI lifecycle tests preserve glyph geometry.

All test browsers are closed. The user is free to resume other GPU workloads; further measurements would require another isolated interval. The CPU-only static preview server stays available for review.
