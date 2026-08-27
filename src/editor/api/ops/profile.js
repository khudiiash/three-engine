/**
 * GPU frame profiling — where the milliseconds actually go.
 *
 * The performance panel reports one aggregate GPU number, which is enough to
 * know a frame is slow and useless for knowing WHY. Every attempt to answer
 * "why" from outside the editor runs into the same wall: a headless probe's
 * viewport is a fraction of a real one, and screen-space GI cost is per-pixel,
 * so its numbers do not extrapolate. The measurement has to happen in the
 * editor that is actually slow.
 *
 * `profile.giPasses` dispatches each GI pass on its own, K times, with the
 * WebGPU timestamp queries resolved around it — so every pass reports its own
 * cost at the resolution the user is really running. It suspends the render
 * loop for the duration (otherwise the editor's own dispatches land inside the
 * measurement window) and restores it afterwards.
 */
import { defineOp } from "../registry.js";
import { engine } from "../../engineInstance.js";
import { auditDrawCalls } from "../../../engine/drawCallAudit.js";

/**
 * Named screen-chain passes, in the order they run.
 *
 * ⚠ `bvhReflect` was MISSING from this list until 2026-08-16, and it is the
 * most expensive thing GI dispatches on a high/ultra scene: a full-screen,
 * hit-shaded exact-reflection BVH trace, run EVERY frame it is enabled
 * (`GISystem.#tick`, right after the gbuffer). Its absence is what made this op
 * report ~7 ms for a module that moves 18 ms between the `low` and `ultra`
 * presets, and it sent two sessions of frame-rate work at the raster side of
 * the frame looking for a cost that was sitting in GI all along. An
 * instrument's omissions read as zeros, and zeros read as innocence — anything
 * `giCompute` dispatches belongs here.
 */
const SCREEN_PASSES = [
  "lightShadowPass",
  "lightShadowFilterPass",
  "lightShadowWidePass",
  "lightShadowWidePass2",
  "emitterShadowPass",
  "emitterShadowFilterPass",
  "bvhReflect",
];

defineOp({
  name: "profile.giPasses",
  readOnly: true,
  description:
    "Per-pass GPU cost of the GI module, measured with real WebGPU timestamp queries at the CURRENT viewport resolution. Use this instead of guessing which pass owns a slow frame — it reports the shadow trace, each filter/wide pass, the resolve, and every pass in the GI frame queue separately, plus the resolve/shadow pixel counts that drive all of them. Suspends rendering for a few hundred milliseconds while it measures.",
  params: {
    samples: {
      type: "number",
      default: 40,
      description: "Dispatches per pass (higher = steadier numbers, longer freeze). Max 200.",
    },
  },
  async run({ samples = 40 }) {
    const K = Math.max(4, Math.min(200, Math.round(samples)));
    const renderer = engine?.renderer;
    const sys = engine?.modules?.get("gi")?.system;
    if (!renderer) throw new Error("No renderer.");
    if (!sys?.state?.screen) throw new Error("The GI module is not active in this scene.");
    if (!renderer.backend?.trackTimestamp) {
      throw new Error(
        "This adapter has no timestamp-query support, so GPU pass timings are unavailable. " +
          "Enable timestamp queries in scene settings, or read the aggregate GPU number in the performance panel.",
      );
    }
    const screen = sys.state.screen;

    const wasSuspended = engine.renderSuspended;
    engine.renderSuspended = true;
    await new Promise((r) => setTimeout(r, 250));
    try {
      // ⚠ `info.compute.timestamp` is ASSIGNED per resolve, not accumulated —
      // `Backend.resolveTimestampsAsync` does `info[type].timestamp =
      // duration` where `duration` is the batch it just resolved. So the
      // before/after subtraction this op used to do computed `thisBatch −
      // prevBatch`: for K same-pass dispatches after a 1-dispatch warm batch
      // that is K·d − d, a −1/K bias that read as clean numbers for a whole
      // phase, and for the rep-major chain below it was the DIFFERENCE
      // between successive passes — negative chain totals on a live frame.
      // The resolve's RETURN VALUE is the batch duration; use it directly.
      const timeOne = async (compute) => {
        if (!compute) return null;
        // Warm first: the very first dispatch pays pipeline + bind-group setup,
        // which is not what "cost per frame" means. The resolve flushes it out
        // of the next batch.
        renderer.compute(compute);
        await renderer.resolveTimestampsAsync("compute");
        for (let i = 0; i < K; i++) renderer.compute(compute);
        const dur = await renderer.resolveTimestampsAsync("compute");
        return +(((dur ?? 0)) / K).toFixed(4);
      };

      // A pass that EXISTS is not necessarily a pass that RUNS: the emitter
      // trace + filter are skipped per frame while the scene has no emissive
      // meshes. Timing them anyway is useful (it says what promoting one
      // would cost) but reporting the number bare would inflate the frame.
      // filter(Boolean): the seat array is positional and may carry interior
      // holes (sticky promotion) — count occupants, not slots.
      const emittersLive = (sys._emitterInfos?.filter(Boolean).length ?? 0) > 0;
      const giShadowLive = (sys.state?.lightSlots ?? []).some((s) => (s?.giShadow?.value ?? 0) > 0);
      // Exact reflections need high/ultra AND `exactReflections` AND a material
      // in bucket 0/3 to consume them (`GISystem.#bvhReflectionsEnabled`, which
      // is private). Mirror its OBSERVABLE half here: the bucket tally is the
      // consumer test, and `__giNoBvhReflections` is the live hatch. Getting
      // this wrong only mislabels a number, never hides one.
      const reflectionsLive =
        !!screen.bvhReflect &&
        globalThis.__giNoBvhReflections !== true &&
        ((sys._bucketTally?.[0] ?? 0) + (sys._bucketTally?.[3] ?? 0) > 0);
      const skipReason = (name) => {
        if (name.startsWith("emitter") && !emittersLive) return "0 emitters";
        if (name.startsWith("lightShadow") && !giShadowLive) return "no light uses Shadow Source \"gi\"";
        if (name === "bvhReflect" && !reflectionsLive) return "exact reflections off (tier, hatch, or no bucket 0/3 material)";
        return null;
      };
      const passes = {};
      let liveTotal = 0;
      for (const name of SCREEN_PASSES) {
        const compute = screen[name]?.compute;
        if (!compute) continue;
        const ms = await timeOne(compute);
        const why = skipReason(name);
        passes[name] = why ? `${ms} (NOT dispatched — ${why})` : ms;
        if (!why && typeof ms === "number") liveTotal += ms;
      }
      const resolveCompute = screen.resolve?.compute ?? screen.resolve;
      if (resolveCompute) {
        passes.resolve = await timeOne(resolveCompute);
        if (typeof passes.resolve === "number") liveTotal += passes.resolve;
      }

      // Named, and sorted most-expensive-first: the point of this op is to
      // find the pass that owns the frame, and a positional array of twenty
      // numbers hides it.
      const queue = sys.state.queue ?? [];
      const labels = sys.state.queueLabels ?? [];
      const queueEntries = [];
      for (let i = 0; i < queue.length; i++) {
        queueEntries.push({ pass: labels[i] ?? `queue[${i}]`, ms: await timeOne(queue[i]) });
      }
      const queueMs = {};
      for (const e of [...queueEntries].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))) {
        // The frame loop dispatch-skips the shadow chains (GISystem's
        // `frameSkip`), but this op times raw queue nodes — so a skipped
        // pass shows its WOULD-BE cost. Annotate it the way screenPassesMs
        // does, or the number reads as live frame cost (it misread as a
        // 1.9ms/frame leak once already).
        const why = skipReason(e.pass);
        const value = why && typeof e.ms === "number" ? `${e.ms} (NOT dispatched — ${why})` : e.ms;
        // Duplicate labels (one merge per cascade level) keep their index.
        queueMs[queueMs[e.pass] === undefined ? e.pass : `${e.pass} #${queueEntries.indexOf(e)}`] = value;
      }
      // ── §19 STAGE 3.4: GI2's OWN CHAIN ──────────────────────────────────
      //
      // GI2's passes are NOT in `state.queue` — the queue is rate-gated,
      // idle-skipped and split into feedback/no-feedback halves, none of which
      // a window frame can be, so `#tick` dispatches them in §M.2's order
      // directly. Timing them therefore needs its own list, and without it this
      // op reports a GI frame of ~0 ms on a path that IS the GI frame.
      //
      // Read live off the system rather than re-derived: `_gi2Passes` is the
      // exact ordered list the last tick submitted, so what is timed here is
      // what actually ran — not a plan of what should have.
      const gi2Ms = {};
      let gi2TotalMs = 0;
      const gi2Chain = sys._gi2Passes?.all ?? [];
      for (let i = 0; i < gi2Chain.length; i++) {
        const node = gi2Chain[i];
        const name = node?.__giPassName ?? `gi2[${i}]`;
        const ms = await timeOne(node);
        gi2Ms[gi2Ms[name] === undefined ? name : `${name} #${i}`] = ms;
        if (typeof ms === "number") gi2TotalMs += ms;
      }
      // SRC probe population (opt-in via `__giSrcProbes`), timed PER GROUP.
      //
      // It used to be one number, on the stated grounds that "the interesting
      // question is what the chain costs, not which of two clears is slower".
      // That held while this was fourteen tiny dispatches. It stopped holding at
      // 44 dispatches and 91ms on the user's Sponza — ~50x the entire screen
      // total — at which point "what does the chain cost" has an obvious answer
      // and the only useful question is which group owns it. Its telemetry still
      // rides along because "3.1ms" and "3.1ms at load 0.94 with 900 dropped
      // inserts" call for completely different responses.
      let srcProbes = null;
      if (screen.srcProbes) {
        // ══ REP-MAJOR, NOT PASS-MAJOR — THE CHAIN'S STATE IS PART OF ITS COST ═
        //
        // `timeOne` dispatches one pass K times in isolation, and the SRC chain
        // is a per-frame ALGORITHM: [D1] accumulates counts a clear pass resets,
        // [D3] partitions a cursor it expects zeroed, [D5] hands out slices of
        // exactly what [D1] counted. K isolated reps of each violate all of
        // that — counts inflate K×, the partition marches K× past the buffer,
        // and [D5] hands the deposit garbage offsets. The old numbers survived
        // by luck: a deposit tracing from garbage offsets COSTS the same as one
        // tracing from real ones, so the timing held while the state lied.
        //
        // The per-probe ray cap ended the luck. Its [D5] DENIES claims outside
        // the probe's segment, and against K×-inflated state that is every
        // claim — so the deposit timed an empty dispatch: `0.68 ms, 0 rays
        // fired` on a frame whose live telemetry says 21,520 shaded hits.
        // An instrument that breaks when the code gets safer is mis-built.
        //
        // So the chain is timed REP-MAJOR: each rep dispatches every pass in
        // frame order, per-pass timestamps accumulate across reps. Every rep is
        // a legal frame (uniforms don't advance, so it is the SAME frame
        // re-run), the per-group attribution is unchanged, and the stats
        // buffer afterwards holds a real frame's tallies — which is what
        // `readStats` below relays. Reps are capped at 8: one rep already
        // times 44 dispatches, and a timestamp resolve per dispatch makes
        // reps linearly expensive wall-clock.
        const chain = screen.srcProbes.passes;
        for (const pass of chain) renderer.compute(pass);
        await renderer.resolveTimestampsAsync("compute");
        const reps = Math.min(K, 8);
        const perPass = new Array(chain.length).fill(0);
        for (let rep = 0; rep < reps; rep++) {
          for (let i = 0; i < chain.length; i++) {
            renderer.compute(chain[i]);
            perPass[i] += (await renderer.resolveTimestampsAsync("compute")) ?? 0;
          }
        }
        let srcMs = 0;
        for (let i = 0; i < perPass.length; i++) {
          perPass[i] = +(perPass[i] / reps).toFixed(4);
          srcMs += perPass[i];
        }
        // Group boundaries come from srcSystem in `passes` order. Asserted
        // rather than trusted: a group list that has drifted from the pass list
        // would silently attribute cost to the wrong stage, which is worse than
        // the single sum this replaced.
        const groups = screen.srcProbes.passGroups ?? [];
        const groupTotal = groups.reduce((n, g) => n + g.count, 0);
        const groupMs = {};
        if (groups.length && groupTotal === perPass.length) {
          let at = 0;
          for (const g of groups) {
            const slice = perPass.slice(at, at + g.count);
            at += g.count;
            groupMs[g.label] = {
              ms: +slice.reduce((a, b) => a + b, 0).toFixed(3),
              dispatches: g.count,
              worstPassMs: +Math.max(0, ...slice).toFixed(3),
            };
          }
        } else if (groups.length) {
          groupMs.ERROR = `passGroups sum ${groupTotal} != ${perPass.length} passes — ` +
            "srcSystem's group list has drifted from its pass list; per-group numbers withheld.";
        } else {
          // AND SAY SO. This branch used to fall through silently, so a missing
          // `passGroups` produced `{}` — indistinguishable from "every group
          // measured 0ms", and it cost three runs to tell those apart. An
          // absent input is a louder failure than a wrong one, not a quieter.
          groupMs.ERROR = "srcProbes.passGroups is absent — the per-group breakdown cannot be " +
            "computed. Either srcSystem did not publish it, or this editor is running a stale " +
            `module. Object has ${perPass.length} passes totalling ${srcMs.toFixed(3)}ms.`;
        }
        const stats = await screen.srcProbes.readStats(renderer);
        srcProbes = {
          totalMs: +srcMs.toFixed(3),
          dispatches: screen.srcProbes.passes.length,
          // Sorted most-expensive-first, same discipline as `queueMs`: the
          // point of this op is to find what owns the frame, and an unsorted
          // map of eight entries hides it.
          groupMs: Object.fromEntries(
            Object.entries(groupMs).sort((a, b) => (b[1]?.ms ?? 0) - (a[1]?.ms ?? 0)),
          ),
          spacing0: stats.spacing0,
          megabytes: +(stats.bytes / 1048576).toFixed(2),
          reanchors: stats.reanchors,
          cascades: stats.cascades.map((c) => ({
            cascade: c.cascade,
            live: c.live,
            capacity: c.probeCapacity,
            loadFactor: +c.loadFactor.toFixed(3),
            meanProbeSteps: +c.meanProbeSteps.toFixed(2),
            failedInserts: c.failed,
          })),
          // Read from the RUN, not from the phase plan. This note said
          // "Produces no light yet" for as long as that was true and then for a
          // while after it stopped being true, which is the failure mode that
          // matters: it is consulted precisely when someone is deciding whether
          // a dark frame is expected. `shaded` is the deposit kernel's own
          // per-frame tally, so the note now reports what the GPU did.
          //
          // ⚠ THE TALLIES LIVE UNDER `stats.rays`, NOT ON `stats`. This op read
          // `stats.shaded` for a whole phase and reported `shadedHitsPerFrame:
          // 0` against frames that were visibly shading — §12.39.3 logged it as
          // a suspend-race in the counters, and it was never a race at all: an
          // `undefined ?? 0` wearing the same costume as an empty readback. The
          // deposit's `readStats` is the one place these words are decoded;
          // this op only relays it.
          shadedHitsPerFrame: stats.rays?.shaded ?? 0,
          // The transport's fired count, kernel-tallied. Under the per-probe
          // ray cap this is the REAL total — the boot line's `rays/frame` is an
          // upper bound there, and dividing a deposit time by the bound would
          // overstate the kernel by exactly the cap's savings.
          raysPerFrame: stats.rays?.rays ?? 0,
          probeRayCap: screen.srcProbes.probeRayCap ?? null,
          unattributedRate: stats.rays?.unattributedRate != null
            ? +(stats.rays.unattributedRate * 100).toFixed(2) + "%"
            : null,
          // §15 front 5 ("smooth light no matter where we go"): the ladder's
          // health decides whether bins carry the full-range answer or a
          // patchy partial one. orphanRate is the number to watch — healthy
          // ~0.01; the user-visible "patches updating" state reads 0.3+.
          // Relayed verbatim from the merge/seed/tiles readbacks so an
          // agent can watch it over MCP without a custom page.
          merge: stats.merge ?? null,
          seed: stats.seed ?? null,
          tiles: stats.tiles ?? null,
          note: stats.rays?.shaded
            ? `Hit shading is LIVE — ${stats.rays.shaded} hits shaded last frame. Radiance carries ` +
              "albedo, sun, lights and emission."
            : "Populating probes but shading NO hits — every deposited radiance is zero, so the " +
              "diffuse term is sky-visibility only. Check `__giSrcShade`.",
        };
      }
      // The canvas backing store IS the drawing buffer, and reading it avoids
      // both a three import and getDrawingBufferSize's Vector2 contract.
      const canvas = renderer.domElement;
      return {
        marcher: screen.lightShadow?.marcher ?? "(gi shadows off)",
        adoptedMovers: sys._dynSet?.count?.() ?? 0,
        pixels: {
          drawingBuffer: canvas ? [canvas.width, canvas.height] : null,
          resolve: [screen.width, screen.height],
          shadow: [screen.shadowWidth, screen.shadowHeight],
          emitterShadow: [screen.emitterShadowWidth, screen.emitterShadowHeight],
        },
        emitters: sys._emitterInfos?.filter(Boolean).length ?? 0,
        screenPassesMs: passes,
        // What the frame ACTUALLY pays — passes marked "NOT dispatched" are
        // timed for reference (what enabling them would cost) but excluded.
        screenTotalMs: +liveTotal.toFixed(3),
        srcProbes,
        // §19 Stage 3.4. Empty on the SRC path; on GI2 this IS the GI frame,
        // and `gi2TotalMs` is the number §M.4's 4 ms budget is written against.
        gi2Ms,
        gi2TotalMs: +gi2TotalMs.toFixed(3),
        queueMs,
        queueTotalMs: +queueEntries
          .filter((e) => !skipReason(e.pass))
          .map((e) => e.ms)
          .filter((v) => typeof v === "number")
          .reduce((a, b) => a + b, 0)
          .toFixed(3),
        note:
          "Every screen pass is per-resolve-pixel work — halving the GI Resolve Scale quarters all of them. " +
          "Queue entries are the cascade/occupancy chain (volume-sized, mostly resolution-independent).",
      };
    } finally {
      engine.renderSuspended = wasSuspended;
    }
  },
});

/**
 * The other half of the frame, and the half nobody could see.
 *
 * `profile.giPasses` measures COMPUTE dispatches. Everything else in the frame
 * — the scene draw and every postprocess effect — is a RENDER pass, and for two
 * sessions the only way to attribute it was subtraction: total minus GI minus a
 * postprocess-off A/B run by hand. That arithmetic said the scene draw costs
 * ~16 ms for 262 k triangles on a 4070, which is absurd per-triangle and
 * therefore per-PIXEL, and left ~26 ms of a 33 ms frame unattributed across
 * SSR + 5 blurs, GTAO, 11 Bloom passes and Godrays. Guessing which of those
 * owns the frame is exactly what this op exists to stop.
 *
 * HOW: post effects declare their work in `updateBefore` — the hook the node
 * system calls to render an effect's own passes before the quad that samples
 * them. Calling it directly, K times, with `resolveTimestampsAsync("render")`
 * around the batch gives that effect's real GPU cost at the real resolution.
 * The scene draw comes along for free: `PassNode` is a node in the same graph
 * and its `updateBefore` IS `renderer.render(scene, camera)`.
 *
 * ⚠ FILTER ON `updateBeforeType`, NOT ON THE METHOD. The base `Node` class
 * defines an empty `updateBefore`, so `typeof node.updateBefore === "function"`
 * matches every node in the graph and would report hundreds of 0.00 ms rows.
 * `updateBeforeType` is `'none'` unless a node actually opts in.
 */
defineOp({
  name: "profile.renderPasses",
  readOnly: true,
  description:
    "Per-pass GPU cost of the RENDER side of the frame — the scene draw and each postprocess effect — measured with real WebGPU timestamp queries at the current viewport resolution. The companion to profile.giPasses, which only sees compute dispatches: use both and the frame adds up instead of leaving a large unattributed remainder. Reports each effect separately (SSR, GTAO, every Bloom mip, Godrays) plus the whole-pipeline total, so the residual between them is visible rather than assumed. Suspends rendering while it measures.",
  params: {
    samples: {
      type: "number",
      default: 20,
      description: "Renders per pass (higher = steadier numbers, longer freeze). Max 200.",
    },
  },
  async run({ samples = 20 }) {
    const K = Math.max(4, Math.min(200, Math.round(samples)));
    const renderer = engine?.renderer;
    if (!renderer) throw new Error("No renderer.");
    if (!renderer.backend?.trackTimestamp) {
      throw new Error(
        "This adapter has no timestamp-query support, so GPU pass timings are unavailable. " +
          "Enable timestamp queries in scene settings, or read the aggregate GPU number in the performance panel.",
      );
    }
    const nodeFrame = renderer._nodes?.nodeFrame;
    if (!nodeFrame) throw new Error("The renderer has no node frame yet — render at least one frame first.");

    // The postprocess component that owns the camera currently being drawn.
    // Without one there is no output graph, and the only render pass in the
    // frame is the scene draw itself — still worth timing, so we fall through.
    let post = null;
    for (const ent of engine.entities?.values?.() ?? []) {
      const component = ent.getComponent?.("postprocess");
      if (component?.pipeline && component.outputNode) {
        post = component;
        break;
      }
    }

    const wasSuspended = engine.renderSuspended;
    engine.renderSuspended = true;
    await new Promise((r) => setTimeout(r, 250));
    const previousFrameRenderer = nodeFrame.renderer;
    try {
      nodeFrame.renderer = renderer;

      // ⚠ RESOLVE AFTER EVERY CALL, NEVER ONCE AFTER K OF THEM.
      //
      // `profile.giPasses` batches K dispatches and resolves once, and that is
      // safe for compute because a GI pass is ONE dispatch. A render is not: a
      // full `pipeline.render()` opens ~20 render passes, and three's WebGPU
      // timestamp pool holds **256 queries** (`WebGPUTimestampQueryPool`,
      // `maxQueries = 256` = 128 pass pairs). K=24 full renders overflows it
      // after the fifth, every later `allocateQueriesForContext` returns null,
      // and the resolve then reports a fraction of the truth as if it were the
      // whole — the first build of this op read 0.53 ms for a 32 ms frame.
      //
      // There is a second reason: `_resolveQueries` returns
      // `framesDuration[frames.at(-1)]` — the total of the LAST FRAME ONLY,
      // grouped by `renderer.info.frame`. One resolve per call keeps exactly
      // one frame group in flight, so the number is unambiguous.
      const timeRender = async (run) => {
        try {
          run(); // warm: the first call pays pipeline + bind-group setup
        } catch (error) {
          return { ms: null, error: error?.message ?? String(error) };
        }
        await renderer.resolveTimestampsAsync("render");
        let total = 0;
        for (let i = 0; i < K; i++) {
          run();
          total += (await renderer.resolveTimestampsAsync("render")) ?? 0;
        }
        return { ms: +(total / K).toFixed(4) };
      };

      // Establish sane renderer state (current target, MRT, bind groups) before
      // driving any node by hand: an effect's updateBefore inherits whatever
      // target is bound, and a half-configured renderer is the documented way
      // to get an empty fragment output struct and a dropped command encoder.
      // ⚠ ADVANCE THE NODE FRAME BETWEEN PIPELINE RENDERS, or the total is not
      // a frame. `PassNode.updateBefore` is `NodeUpdateType.FRAME`, and the
      // node system runs a FRAME-typed update ONCE per `renderer.info.frame` —
      // so K back-to-back `pipeline.render()` calls render the scene on the
      // first one only and post-only on the other K−1, reporting a "frame"
      // total with no scene in it. This is exactly what `Renderer._renderScene`
      // does per real frame.
      const advanceFrame = () => {
        renderer._nodes.nodeFrame.update();
        renderer.info.frame = renderer._nodes.nodeFrame.frameId;
      };
      let frameTotalMs = null;
      if (post) {
        post.pipeline.outputNode = post.outputNode;
        const total = await timeRender(() => {
          advanceFrame();
          post.pipeline.render();
        });
        frameTotalMs = total.ms;
      }

      // THE SCENE DRAW, from a direct reference rather than the graph walk.
      // `PostprocessComponent.scenePass` is the `pass(scene, camera)` node the
      // component owns, and `PassNode.updateBefore` IS
      // `renderer.render(scene, camera)` into its MRT — main opaque, depth,
      // normal/matParams attachments, the lot. It is reported separately from
      // the walk because it is the single number this op exists for, and it
      // must not depend on the walk finding anything.
      const scenePass = post?.scenePass ?? null;
      const sceneDraw = scenePass ? await timeRender(() => scenePass.updateBefore(nodeFrame)) : null;

      // ⚠ THE EFFECT LIST COMES FROM THE COMPILER, NOT FROM A GRAPH WALK.
      //
      // The first build of this op walked `outputNode` for nodes with a
      // non-`none` `updateBeforeType` and found THREE nodes, all `none` — every
      // effect was invisible, because addons return a PassTextureNode over the
      // effect rather than the effect itself, and the hop is not a node child.
      // `compilePostGraph` now records them as it builds (`compiled.effects`),
      // which additionally labels each one with the USER'S graph node type, so
      // the profile reads "bloom" rather than "UnrealBloomNode #3".
      const collected = (post?.compiled?.effects ?? [])
        .filter((entry) => entry?.node && entry.node !== scenePass)
        .map((entry) => ({ label: entry.label ?? "effect", node: entry.node }));

      const used = new Map();
      const label = (base) => {
        const n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        return n === 1 ? base : `${base} #${n}`;
      };

      const rows = [];
      for (const { label: base, node } of collected) {
        const { ms, error } = await timeRender(() => node.updateBefore(nodeFrame));
        rows.push({
          pass: label(base),
          node: node.constructor?.name ?? "Node",
          updateBeforeType: node.updateBeforeType,
          ms,
          ...(error ? { error } : {}),
        });
      }
      rows.sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1));

      const attributed =
        (sceneDraw?.ms ?? 0) + rows.reduce((a, r) => a + (typeof r.ms === "number" ? r.ms : 0), 0);
      const canvas = renderer.domElement;
      return {
        pixels: canvas ? [canvas.width, canvas.height] : null,
        postprocess: post ? post.entity?.name ?? "(postprocess)" : null,
        // THE HEADLINE: the scene draw, measured rather than derived by
        // subtracting GI and a postprocess-off A/B from the frame total.
        sceneDrawMs: sceneDraw?.ms ?? null,
        ...(sceneDraw?.error ? { sceneDrawError: sceneDraw.error } : {}),
        // The whole pipeline for one frame — scene draw, every effect, the
        // output transform. Compare against `attributedMs`: a large residual
        // means real cost lives somewhere this walk did not reach.
        frameTotalMs,
        attributedMs: +attributed.toFixed(3),
        unattributedMs: frameTotalMs != null ? +(frameTotalMs - attributed).toFixed(3) : null,
        passes: rows,
        // Kept in the output on purpose: an empty `passes` list is otherwise
        // indistinguishable from "the frame has no effects", and this says
        // immediately whether the compiler handed over any effects at all.
        effectsFound: collected.length,
        note:
          "`sceneDrawMs` is the main scene render (PassNode) — on a GI scene it is the frame's biggest " +
          "item because the GI irradiance gather is compiled INTO every lit material's fragment shader, " +
          "which no compute profiler can see. Each row in `passes` is one effect's `updateBefore` at the " +
          "real viewport size. Add this to profile.giPasses for the whole frame.",
      };
    } finally {
      nodeFrame.renderer = previousFrameRenderer;
      engine.renderSuspended = wasSuspended;
    }
  },
});

defineOp({
  name: "profile.frameStats",
  readOnly: true,
  description:
    "Live frame-rate and renderer counters — the same numbers the viewport's Stats overlay shows. `fps` counts frames the renderer actually PRESENTED over a one-second window; ticks that ran but skipped the draw (a GI compile wave, a renderer resize) are reported separately as `skippedFps`, and an idle viewport the editor has suspended reports 0 for both. Use this to check whether a change actually made the editor faster. `culling` reports what the occlusion and LOD systems are doing: `occlusion.occluders` is 0 when no object in the scene is large enough to be worth rendering into the occluder depth pass, in which case nothing can ever be culled.",
  params: {
    settleMs: {
      type: "number",
      default: 1100,
      description:
        "How long to let the frame window fill before reading, in ms. The window is one second, so anything below ~1000 reports a partial count. 0 reads immediately. Max 10000.",
    },
  },
  async run({ settleMs = 1100 }) {
    const stats = engine?.stats;
    if (!stats) throw new Error("No engine.");
    const wait = Math.max(0, Math.min(10_000, Math.round(settleMs)));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // sample() recounts against the clock. Reading `readout` directly would
    // report whatever the last tick left behind — which for a suspended
    // viewport is a stale frame rate for a canvas that is not drawing.
    const r = stats.sample();
    const drawing = r.fps > 0;
    return {
      fps: Math.round(r.fps),
      skippedFps: Math.round(r.skippedFps),
      cpuMs: +(r.workMs || r.frameMs).toFixed(2),
      gpuMs: +(r.gpuMs > 0 ? r.gpuMs : r.renderMs).toFixed(2),
      gpuMsIsReal: r.gpuMs > 0,
      renderScale: +r.renderScale.toFixed(3),
      drawCalls: r.drawCalls,
      triangles: r.triangles,
      textureMemMB: +(r.textureMem / 1048576).toFixed(1),
      jsHeapMB: r.jsHeapBytes == null ? null : +(r.jsHeapBytes / 1048576).toFixed(1),
      playing: !!engine.playing,
      // The three view-culling systems, because "occluded 0" and "occluded 0 of
      // 0" are completely different reports and the Stats overlay shows neither
      // when the count is zero. `occluders` is the one that actually diagnoses
      // it: a scene with occlusion on and ZERO occluders never even runs the
      // depth pass, so nothing downstream can cull anything.
      culling: {
        occlusion: engine.occlusion?.stats ?? null,
        lodHidden: [...engine.entities.values()].filter((e) => e._lodHidden === true).length,
      },
      // §18 W3 — the frame-rate floor's own state. Without this, a scene that
      // is holding 60 fps and a scene that is holding 60 fps BY SPENDING GI
      // RESOLUTION look identical from the outside, which is the one thing this
      // controller must never be allowed to hide. `scale` 1 means it has not
      // spent anything; `lastReason` says what it reacted to.
      governor: engine.frameGovernor?.stats ?? null,
      // Shadow freezing is routinely the single biggest draw-call lever in the
      // frame (a shadow map is a full extra submission of every caster, and it
      // is NOT reduced by view frustum culling), and it had no receipt at all
      // until a CSM scene was found re-rendering 842 of its 1144 draws every
      // frame on a parked camera. `managed` 0 on a shadowed scene means the
      // system cannot see the maps; `frozen` 0 while `managed` > 0 on a still
      // scene means it sees them and something keeps invalidating them.
      // The two GPU passes that dominate a GI frame (bvhReflect ~26 ms +
      // bvhHitShade ~26 ms of ~52 ms on Bistro at ultra). Both are HELD while
      // the g-buffer key is unchanged — the trace exactly, the shade on a
      // cadence. A non-zero count here is the only way to tell "the view is
      // held and the GPU is idle" from "the gate never engaged".
      giHold: {
        reflectHeldFrames: engine.modules?.get?.("gi")?.system?._bvhReflectHeldFrames ?? null,
        hitShadeHeldFrames: engine.modules?.get?.("gi")?.system?._bvhHitShadeHeldFrames ?? null,
        // §17 R7c's reflection history weight. ~0.9 means the reflection is a
        // ~10-frame exponential smear = "a stale image lagging behind"; near 0
        // means it is passing raw and R7c is doing its job. `atMotion` is
        // peak-held from a frame the camera was ACTUALLY moving, because the
        // motion EMA decays long before any reader can sample it.
        hitHistWeight: engine.modules?.get?.("gi")?.system?._giBvhHitHistWeightU?.value ?? null,
        hitHistWeightAtMotion: engine.modules?.get?.("gi")?.system?._giHitWeightAtMotion ?? null,
        camMotionEma: engine.modules?.get?.("gi")?.system?._giCamMotionEma ?? null,
        // ⚠ THE TWO ABOVE DESCRIBE DECISIONS; THESE DESCRIBE DISPATCHES.
        // `hitShadeHeldFrames` counts only the frames the HELD-VIEW cadence
        // chose to skip — it reported 0 ("healthy") on every frame the idle
        // sleep had already dropped the pass from the queue entirely, which is
        // how a reflection re-shading once every 30 frames went unnoticed for
        // sessions. `hitShadeGapFrames` asks the submitted queue instead, and
        // `hitShadeGapMax` is the WORST gap seen — deliberately a maximum, not
        // the peak-held best case that misled the same investigation twice.
        hitShadeGapFrames: engine.modules?.get?.("gi")?.system?._bvhHitShadeGapFrames ?? null,
        hitShadeGapMax: engine.modules?.get?.("gi")?.system?._bvhHitShadeGapMax ?? null,
        // The idle gate's inputs. `#fieldInputHash` has NO camera term, so
        // `fieldQuietFrames` climbs straight through a camera orbit; past
        // GI_IDLE_AFTER_FRAMES (180) the queue is replaced by a reduced list.
        // A high count here WITH the camera moving is the signature to watch.
        fieldQuietFrames: engine.modules?.get?.("gi")?.system?._fieldQuietFramesSeen ?? null,
      },
      // §18 THE LADDER's live census (GISystem.reflectTierCensus). Counted at
      // READ time, not build time, because the per-channel roughness floors it
      // reads land asynchronously off the GPU — the build-time tally reported
      // "0 sharp" for a scene full of mirrors purely because it asked too
      // early. `pendingMaterials` is how much of the medium column is still
      // "ask again later"; `coarseTriangleShare` is the budget a per-tier trace
      // stride can reclaim at zero visual cost (those materials' roughness
      // floor is above 0.45, where the exact reflection's weight is 0).
      giTiers: engine.modules?.get?.("gi")?.system?.reflectTierCensus?.() ?? null,
      // ⭐ §19 STAGE 3.4 — THE GI2 RECEIPT (audits §K.8 + §L.7).
      //
      // Null on the SRC path, which is itself the reading that matters: this
      // block existing at all says the window is the lit path. It is a
      // SNAPSHOT, not a readback — the GPU counters it reports were fetched by
      // `#tick` on its own slow cadence (every 30 GI frames), so asking for
      // frame stats never costs a stall and never perturbs the number it is
      // measuring.
      //
      // What each group answers, because a flat list of twenty counters is
      // unreadable:
      //   · `firstOccupancyMs` per level + `firstLightMs` — the two boot gates.
      //     A level missing from the map has never built a brick.
      //   · `voxelizer.overflowed` / `.starved` / `.deferred` — the budget's
      //     own honesty. `starved > 0` means a brick could not advance AT ALL
      //     and the window will never finish; `deferred` is merely "next frame".
      //   · `gather.windowHits` / `.screenHits` / `.skyMiss` — where the rays
      //     went. All three zero WITH `probesValid > 0` is a dead trace;
      //     `probesValid` zero is a dead g-buffer, a different bug entirely.
      //   · `gather.reprojHits` / `.alphaForced` — §L.3's temporal term, the
      //     ONLY history in GI2. `alphaForced` climbing is a lighting change
      //     being tracked, not an artefact.
      //   · `soupMB` — the one number that is main-thread heap and is HELD
      //     across rebuilds on purpose (see GISystem's dispose note).
      gi2: (() => {
        const s = engine.modules?.get?.("gi")?.system?._gi2Stats;
        if (!s) return null;
        return {
          tier: s.tier,
          built: s.built,
          frame: s.frame,
          windowMB: s.windowMB,
          cacheMB: s.cacheMB,
          soupTris: s.soupTris,
          soupMB: s.soupMB,
          soupBuildMs: Math.round(s.soupBuildMs ?? 0),
          soupStallMs: +(s.soupStallMs ?? 0).toFixed(1),
          soupTruncated: s.soupTruncated,
          palClasses: s.palClasses,
          // §19 Stage 4.0b (audits §O.4): "N classes" and "N of them emit" are
          // different facts, and Bistro shipped `0 with emission` for three
          // sessions because only the first was ever published.
          palEmissiveClasses: s.palEmissiveClasses,
          palEmitterBand: s.palEmitterBand,
          probes: s.probes,
          raysPerFrame: s.rays,
          movers: s.movers,
          scrolls: s.scrolls,
          firstOccupancyMs: s.occupancyMs ?? {},
          firstLightMs: s.msToFirstLight || null,
          // ⭐⭐ §19 Stage 4.3b (audits §R): the number the USER measures.
          // `firstLightMs` is quoted from the GI2 build — i.e. from after the
          // asset gate — and on Bistro it read 2.8 s on a boot the user timed
          // at 31 s. This one is quoted from `engine.sceneOpenAt`.
          firstLightFromSceneOpenMs: s.firstLightFromSceneOpenMs ?? null,
          // §R.2: worker runs of the triangle soup for THIS scene open. 1 is
          // the gate; 2 means merging (or something else that swaps meshes)
          // moved the placement set out from under the key.
          soupBuilds: s.soupBuilds ?? 0,
          soupReadyMs: s.msToSoup || null,
          voxelizerReadyMs: s.msToVoxelizer || null,
          gather: {
            probesPlaced: s.probesPlaced ?? null,
            probesValid: s.probesValid ?? null,
            raysTraced: s.raysTraced ?? null,
            screenHits: s.screenHits ?? null,
            windowHits: s.windowHits ?? null,
            skyMiss: s.skyMiss ?? null,
            freshShades: s.freshShades ?? null,
            reprojHits: s.reprojHits ?? null,
            alphaForced: s.alphaForced ?? null,
            injectWrites: s.injectWrites ?? null,
            handoffs: s.handoffs ?? null,
          },
          voxelizer: s.voxelizer
            ? {
              dirty: s.voxelizer.dirty,
              built: s.voxelizer.built,
              pairsWritten: s.voxelizer.pairsWritten,
              pairsNeeded: s.voxelizer.pairsNeeded,
              voxelsSet: s.voxelizer.voxelsSet,
              dustVoxels: s.voxelizer.dustVoxels,
              overflowed: s.voxelizer.overflowed,
              starved: s.voxelizer.starved,
              deferred: s.voxelizer.deferred,
              resumed: s.voxelizer.resumed,
              invalid: s.voxelizer.invalid,
              slotFull: s.voxelizer.slotFull,
              cellOverflow: s.voxelizer.cellOverflow,
              perLevel: s.voxelizer.perLevel,
            }
            : null,
          dynamic: s.dynamic
            ? {
              triangles: s.dynamic.trianglesPacked,
              satItems: s.dynamic.satItems,
              voxelsSet: s.dynamic.voxelsSet,
              outside: s.dynamic.outside,
              spanOverflow: s.dynamic.spanOverflow,
            }
            : null,
        };
      })(),
      // §19 Stage 0.4 — "alive" | "pending" | "dead" (null: GI never built).
      // The IBL blackout is gated on this: until the transport has PROVEN it
      // delivers light, materials keep their environment ambient. On a device
      // that reads "dead", GI is off and the scene is lit by IBL + direct —
      // which is why "mobile looks flat" and "mobile is black" are now
      // different reports with different receipts. See GISystem.transportState.
      giTransport: engine.modules?.get?.("gi")?.system?.transportState ?? null,
      // ⭐ §19 STAGE 0.2b — THE QUANTITY THAT MUST BE FLAT ACROSS A REBUILD.
      // Three's own counters (`Info.memory`), not a GI estimate: `count` is
      // every storage attribute the renderer currently holds a GPU buffer for
      // and `mb` is their bytes. Before 0.2b GI destroyed exactly ZERO of them
      // — audit §I measured +1,853 MB of live storage per ultra↔high rebuild
      // on Bistro, with `memoryMap` (`mapEntries`, a plain Map that pins every
      // attribute it ever saw) climbing +733/+790/+934 entries alongside. A
      // climbing `count` here IS the session-killer, whatever the heap says.
      giStorage: (() => {
        const info = engine?.renderer?.info;
        const mem = info?.memory;
        if (!mem) return null;
        return {
          count: mem.storageAttributes ?? null,
          mb: mem.storageAttributesSize != null
            ? +(mem.storageAttributesSize / 1e6).toFixed(1) : null,
          mapEntries: info.memoryMap?.size ?? null,
          freedByGi: engine.modules?.get?.("gi")?.system?._giFreedBuffers ?? 0,
        };
      })(),
      // §19 0.3b — the reflection-probe RECAPTURE channel. The atlas used to be
      // a one-shot whose content was decided by when a 159 kB kernel finished
      // compiling (reflectionProbeCapture.js's header has the 34% receipt), so
      // "how many times has it been re-captured, and what asked" is the receipt
      // that the image is no longer reading a clock. `lastReason` is
      // "transport-steady" (first proven light) or "settle" (SRC at rest).
      giReflProbeRecapture: (() => {
        const sched = engine.modules?.get?.("gi")?.system?._reflProbeSchedule;
        return sched
          ? { pending: sched.pending, lastReason: sched.lastReason, count: sched.count }
          : null;
      })(),
      // §18's masked-mode gate (armed by `__giMaskCoverageProbe`). `pct` is the
      // share of gbuffer texels carrying geometry; it must be IDENTICAL with
      // the mask on and off. Reported here as well as logged because a console
      // line can scroll past and a null result must be distinguishable from a
      // result of zero — this is the rig that decides whether a four-times-
      // reverted feature ships.
      giMaskCoverage: engine.modules?.get?.("gi")?.system?._maskCoverage ?? null,
      // §18.13 colour probe. `wait` climbing proves the tick reaches the probe
      // at all — distinguishing "the readback failed" from "the code never
      // ran", which a silent console cannot.
      // §18.15 — WHICH FOUR EMITTERS THE ANALYTIC PATH IS USING. The exact-
      // reflection hit shading lights the WHOLE scene from the four global
      // emitter seats (a hit is a different world point than the pixel, so it
      // cannot use the per-pixel tile cut), and on a 116-emitter scene nothing
      // said which four those are. The term probe measured the reflected
      // radiance as x2.99 green with an emitted-power aggregate of only x1.42,
      // so the seats' own chroma is the question — and `radius` answers the
      // other half: a seat fitted to a whole mesh of scattered bulbs is a
      // metres-wide sphere whose solid angle is orders of magnitude too large.
      giEmitterSeats: (() => {
        const slots = engine.modules?.get?.("gi")?.system?.state?.emitterSlots;
        if (!Array.isArray(slots)) return null;
        return slots.map((s, i) => {
          const c = s.color?.value;
          const r = c?.r ?? 0, g = c?.g ?? 0, b = c?.b ?? 0;
          return {
            slot: i,
            rgb: [Number(r.toFixed(3)), Number(g.toFixed(3)), Number(b.toFixed(3))],
            green: Number((g / Math.max(1e-6, (r + b) / 2)).toFixed(2)),
            radius: Number((s.radius?.value ?? 0).toFixed(3)),
            reff: Number((s.reff?.value ?? 0).toFixed(3)),
          };
        });
      })(),
      // Who asked for each GI rebuild and when — the answer to "gi reloads
      // for no reason". `asks` counts requests (several can coalesce into one
      // run), `runs` counts executions, and the log names the last twelve with
      // their age. A `resolve-resize` entry carries giCostScale, so a governor
      // rung change is distinguishable from a window resize at a glance.
      giRebuilds: (() => {
        const system = engine.modules?.get?.("gi")?.system;
        if (!system) return null;
        const now = performance.now();
        return {
          runs: system.rebuilds ?? 0,
          asks: system.rebuildAsks ?? 0,
          log: (system.rebuildLog ?? []).map((e) => ({
            reason: e.reason,
            secondsAgo: Math.round((now - e.at) / 1000),
          })),
        };
      })(),
      // ⭐ §19 STAGE 1.3 — THE ENGINE CONTENT KEY. `counts` says which kind of
      // change is churning; `auditsMissed` is the number that matters: it is
      // non-zero only when a consumer's periodic re-walk found a change no
      // producer announced, i.e. a hole in the producer set (see
      // engine/contentKey.js). A settled, parked scene should show a version
      // that is not moving and `auditsMissed: 0`.
      contentKey: engine.content?.stats?.() ?? null,
      giColourProbe: {
        wait: engine.modules?.get?.("gi")?.system?._colourProbeWait ?? null,
        done: engine.modules?.get?.("gi")?.system?._colourProbeDone ?? null,
        result: engine.modules?.get?.("gi")?.system?._colourProbeResult ?? null,
      },
      // Why the main pass still submits what it does. `undersizedAfterSplit` is
      // the locality split dicing groups below MIN_GROUP_SIZE; `rejects` names
      // the gate that ate the rest. Without this the answer lives only in a
      // change-gated console line from whenever the last rebuild happened.
      merging: engine.merging?.lastReport ?? null,
      shadows: {
        managed: engine.shadowFreeze?.managedLights ?? 0,
        frozen: engine.shadowFreeze?.frozenLights ?? 0,
        // `frozen: 0` has at least four different causes and used to look the
        // same for all of them. This names the one in force.
        freezeReason: engine.shadowFreeze?.reason ?? null,
        // Depth-only merging of the casters themselves (shadowMerge.js).
        // `replaced` is the number of individual meshes the cascades no longer
        // submit; `proxies` is what they submit instead. A `frozen` cascade
        // costs nothing either way — these are the numbers that matter once the
        // camera MOVES and the maps correctly redraw.
        mergedProxies: engine.shadowMerge?.stats?.proxies ?? 0,
        mergedReplaced: engine.shadowMerge?.stats?.replaced ?? 0,
        // How many times the merge has been thrown away and rebuilt this
        // session, and what asked for the last one. On a settled scene this
        // should stop moving; if it keeps climbing, every shadow map is being
        // un-frozen with it (the proxies' object ids are in the freeze's
        // fingerprint) and every rebuild re-copies the merged vertices.
        mergedRebuilds: engine.shadowMerge?.rebuilds ?? 0,
        mergedRebuiltBy: engine.shadowMerge?.lastRebuildReason ?? null,
        // ⭐ TRIANGLES AS BAKED, BEFORE ANY FRUSTUM CULL. The per-pass triangle
        // count in `profile.drawCalls` is post-culling, so it moves with proxy
        // GRANULARITY as well as with content — which makes it useless for
        // answering "did the merge capture the whole scene". This one does not
        // move with the camera, so a cold-boot value below the settled value is
        // the merge having baked less than the scene contains.
        mergedTriangles: engine.shadowMerge?.stats?.triangles ?? 0,
        // The same sum taken from the members' CURRENT geometry, not the bake.
        // `mergedTriangles` is what the proxies froze at build time; this is
        // what they would contain if rebuilt right now. Divergence = a missed
        // invalidation (the watcher has a gap); equal-but-low = the members
        // themselves were coarse at build time and the deficit is upstream.
        mergedMemberTrianglesNow: (() => {
          let t = 0;
          for (const g of engine.shadowMerge?.groups ?? []) {
            for (const m of g.members ?? []) {
              const geo = m.geometry;
              t += (geo?.index ? geo.index.count : geo?.attributes?.position?.count ?? 0) / 3;
            }
          }
          return Math.round(t);
        })(),
        // Member composition: shadowMerge's caster set includes merging.js's
        // COLOUR proxies, and those carry most of the scene's triangles. If the
        // boot-final member set holds fewer of them than a later rebuild does,
        // the deficit is an ordering problem between the two merges, not a
        // geometry-staleness problem.
        mergedBatchProxyMembers: (() => {
          let count = 0;
          let tris = 0;
          for (const g of engine.shadowMerge?.groups ?? []) {
            for (const m of g.members ?? []) {
              if (!/^Merged\(/.test(m?.name ?? "")) continue;
              count++;
              const geo = m.geometry;
              tris += (geo?.index ? geo.index.count : geo?.attributes?.position?.count ?? 0) / 3;
            }
          }
          return { count, tris: Math.round(tris) };
        })(),
        // §18 G1 — the same proxies standing in for GI's g-buffer prepass. A
        // healthy `mergedProxies` beside a zero here means the merge is working
        // and the prepass is getting none of it (geometry without normals),
        // which is otherwise invisible.
        gbufferProxies: engine.shadowMerge?.stats?.gbufferProxies ?? 0,
        gbufferReplaced: engine.shadowMerge?.stats?.gbufferReplaced ?? 0,
        // What the prepass DID with them last frame. `used: 0` beside a healthy
        // `gbufferProxies` means every group was refused, and the two `parked*`
        // counters say by which rule.
        gbufferSwap: engine.modules?.get?.("gi")?.system?._gbufProxyStats ?? null,
      },
      note: drawing
        ? r.skippedFps > 0
          ? `Drawing ${Math.round(r.fps)} frames/s and skipping ${Math.round(r.skippedFps)} — something is suspending the render mid-wave.`
          : "Rendering normally."
        : r.skippedFps > 0
          ? "The loop is running and presenting NOTHING — rendering is suspended (a GI compile wave or a renderer resize). The viewport is frozen on its last image."
          : "The render loop is stopped: the editor suspends an unfocused viewport, so this is expected unless the viewport is the focused panel.",
    };
  },
});

defineOp({
  name: "profile.gi2",
  readOnly: true,
  description:
    "GI2's own receipts (§19 Stage 3.4/K.8/L.7) — the window, the voxelizer budget, the dynamic layer and the screen-probe gather, read FRESH off the GPU rather than from the tick's 30-frame snapshot. Returns null when GI is not built or when the build constant `GI2_PATH` is false, i.e. when the SRC path is the lit one; that null is the answer to \"which transport is running\". The two boot numbers are `firstOccupancyMs` (per window level) and `firstLightMs`, both measured from the moment the GI2 build started, not from page load. `firstLightFromSceneOpenMs` (§19 Stage 4.3b) is the same event measured from SCENE OPEN — the clock the user counts on, which also includes everything GI waits for before it starts building; when the two disagree by seconds, the gap is the wait, not the GI. `soupBuilds` is how many times the triangle-soup worker ran for this scene open; 1 is the contract (a merge rebuild must not restart it). `dynamic.voxelsSet` above zero every frame is what says an animated character is actually in the dynamic layer. Pass `kernelSamples` above zero to also get `kernelMs` — the per-kernel GPU cost of the exact ordered chain the last tick submitted, named by pass — which briefly suspends rendering the way profile.giPasses does. Use profile.frameStats.gi2 instead when you want the counters without paying for a readback.",
  params: {
    kernelSamples: {
      type: "number",
      default: 0,
      description:
        "Dispatches per GI2 kernel for the per-kernel `kernelMs` breakdown. 0 (default) skips the timing pass entirely and returns counters only, with no freeze. Max 200.",
    },
  },
  async run({ kernelSamples = 0 } = {}) {
    const sys = engine?.modules?.get?.("gi")?.system;
    const gi2 = sys?._gi2;
    if (!gi2) return null;
    const stats = await gi2.stats(engine.renderer);
    const out = { ...stats, describe: gi2.describe(), kernelMs: null, kernelTotalMs: null };
    const K = Math.max(0, Math.min(200, Math.round(kernelSamples)));
    if (K < 1) return out;
    const renderer = engine?.renderer;
    // ⚠ SAME PRECONDITION AS `profile.giPasses`, SAID THE SAME WAY: without
    // timestamp queries there are no per-pass numbers to report, and a block
    // of zeros reads as "the chain is free" rather than "the instrument is
    // blind" (memory: check the instrument can see its subject).
    if (!renderer?.backend?.trackTimestamp) {
      out.kernelMs = { error: "This adapter has no timestamp-query support, so per-kernel GPU timings are unavailable." };
      return out;
    }
    // ⭐ THE CHAIN THE LAST TICK ACTUALLY SUBMITTED, not a re-derived plan.
    // `_gi2Passes.all` is `before + after` in submit order (and it is where
    // the light-shadow chain splices in), so a kernel that a stage SPLIT IN
    // TWO shows up here without anybody remembering to add it — the same
    // reasoning `gather.frameOrder` carries.
    const chain = sys._gi2Passes?.all ?? [];
    if (!chain.length) return out;
    const wasSuspended = engine.renderSuspended;
    engine.renderSuspended = true;
    await new Promise((r) => setTimeout(r, 120));
    try {
      const kernelMs = {};
      let total = 0;
      for (let i = 0; i < chain.length; i++) {
        const node = chain[i];
        if (!node) continue;
        const name = node.__giPassName ?? `gi2[${i}]`;
        // Warm first (the first dispatch pays pipeline + bind-group setup),
        // then K reps and ONE resolve whose RETURN VALUE is the batch — never
        // a before/after subtraction of `info.compute.timestamp`, which is
        // assigned per resolve and not accumulated (see profile.giPasses).
        renderer.compute(node);
        await renderer.resolveTimestampsAsync("compute");
        for (let k = 0; k < K; k++) renderer.compute(node);
        const dur = await renderer.resolveTimestampsAsync("compute");
        const ms = +(((dur ?? 0)) / K).toFixed(4);
        kernelMs[kernelMs[name] === undefined ? name : `${name} #${i}`] = ms;
        total += ms;
      }
      out.kernelMs = kernelMs;
      out.kernelTotalMs = +total.toFixed(3);
    } finally {
      engine.renderSuspended = wasSuspended;
    }
    return out;
  },
});

defineOp({
  name: "profile.drawCalls",
  readOnly: true,
  description:
    "Draw-call breakdown: every submission of one real frame, attributed to its render pass, its object and its material. Use this instead of guessing why a scene submits too much — it separates the main opaque pass from shadow cascades, depth prepasses and post-render overlays, names the material behind each draw, and reports the floor each pass would reach if every draw sharing a pipeline state were merged. Its total is legitimately higher than the stats overlay's, which stops counting before the post-render passes.",
  params: {
    frames: {
      type: "number",
      default: 1,
      description: "Frames to capture. More than one distinguishes a steady frame from a one-off bake. Max 10.",
    },
  },
  async run({ frames = 1 }) {
    if (!engine) throw new Error("No engine.");
    return auditDrawCalls(engine, { frames });
  },
});

defineOp({
  name: "profile.textures",
  readOnly: true,
  description:
    "Every texture the renderer is holding, with its real byte size, sorted biggest first — the breakdown behind the Stats overlay's single 'Textures' number. Use it when texture memory is higher than the scene seems to justify: it separates SOURCE art (a mesh's colour/normal/ORM maps) from RENDER TARGETS (GI buffers, post chain, shadow maps), reports which source maps are still uncompressed, and flags textures the renderer still holds that no material in the open scene references any more — the signature of an asset cache retaining GPU memory after its models were deleted.",
  params: {
    limit: {
      type: "number",
      default: 20,
      description: "How many of the largest textures to list individually. Max 200.",
    },
  },
  async run({ limit = 20 }) {
    if (!engine?.renderer) throw new Error("No engine.");
    const info = engine.renderer.info;
    // three tracks byte size per texture in `info.memoryMap` (Info.createTexture
    // / destroyTexture). It is a real Map, so the aggregate the overlay shows
    // can be itemised rather than guessed at — which is the whole point here:
    // "textures are 543 MB" and "543 MB of WHAT" are different questions and
    // only the second one is actionable.
    const map = info.memoryMap;
    if (!map || typeof map.entries !== "function") {
      return { error: "This three build does not expose info.memoryMap; upgrade or read info.memory only." };
    }

    // What the OPEN SCENE actually references. Anything tracked but absent from
    // this set is memory the renderer is holding for nobody.
    const referenced = new Set();
    const TEX_KEYS = [
      "map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap",
      "bumpMap", "displacementMap", "lightMap", "envMap", "specularMap", "clearcoatMap",
      "clearcoatNormalMap", "clearcoatRoughnessMap", "sheenColorMap", "sheenRoughnessMap",
      "transmissionMap", "thicknessMap", "iridescenceMap", "anisotropyMap", "specularColorMap",
      "specularIntensityMap",
    ];
    const noteMaterial = (m) => {
      if (!m) return;
      for (const k of TEX_KEYS) if (m[k]) referenced.add(m[k]);
      // Node materials hang textures off arbitrary node properties, so the
      // fixed key list above under-counts them. Catch the common ones.
      for (const v of Object.values(m)) {
        if (v && v.isTexture) referenced.add(v);
        else if (v && v.isNode && v.value?.isTexture) referenced.add(v.value);
      }
    };
    engine.scene?.traverse?.((o) => {
      const m = o.material;
      if (Array.isArray(m)) m.forEach(noteMaterial);
      else noteMaterial(m);
    });
    if (engine.scene?.background?.isTexture) referenced.add(engine.scene.background);
    if (engine.scene?.environment?.isTexture) referenced.add(engine.scene.environment);

    // ⚠⚠ THREE COUNTS A COMPRESSED TEXTURE AS **ONE BYTE**.
    // `Info._getTextureMemorySize`: `if (texture.isCompressedTexture) return 1;`
    // — "fallback estimate since exact format decompressed isn't readily
    // available without format maps". So `info.memory.texturesSize`, and the
    // Stats overlay's Textures figure with it, does not merely undercount
    // compressed art: it counts it as nothing. Compressing a project therefore
    // makes that number fall by the FULL uncompressed size, which looks like a
    // bigger win than it is, while the same number can never show what the
    // compressed set actually costs. This op estimates it properly instead.
    const BYTES_PER_PIXEL = {
      33776: 0.5, 33777: 0.5,          // S3TC DXT1 (BC1)
      33778: 1, 33779: 1,              // S3TC DXT3/DXT5 (BC2/BC3)
      36196: 0.5, 37492: 0.5,          // ETC1 / ETC2 RGB
      37496: 1,                        // ETC2 EAC RGBA
      36492: 1, 36495: 1,              // BPTC (BC7) — what UASTC transcodes to on desktop
      37808: 1,                        // ASTC 4x4
    };
    const compressedBytes = (tex) => {
      const w = tex.image?.width ?? tex.mipmaps?.[0]?.width ?? 0;
      const h = tex.image?.height ?? tex.mipmaps?.[0]?.height ?? 0;
      if (!w || !h) return 0;
      // Default 1 B/px: BC7 is what our UASTC path lands on, and over-reporting
      // a BC1 map by 2× is a smaller lie than three's 1 byte.
      const bpp = BYTES_PER_PIXEL[tex.format] ?? 1;
      // A full mip chain adds a third; `generateMipmaps` is irrelevant here
      // because KTX2 carries its own levels.
      const mips = (tex.mipmaps?.length ?? 0) > 1 ? 4 / 3 : 1;
      return w * h * bpp * mips;
    };

    const rows = [];
    let total = 0;
    let threeReported = 0;
    const bucket = { renderTarget: 0, compressed: 0, uncompressed: 0, unreferenced: 0 };
    const count = { renderTarget: 0, compressed: 0, uncompressed: 0, unreferenced: 0 };
    for (const [tex, size] of map.entries()) {
      // memoryMap ALSO holds BufferAttributes, whose value is `{size, type}`
      // rather than a number. Filtering on isTexture is what keeps geometry out
      // of a texture report — without it the row count runs an order of
      // magnitude high and every extra row carries a null size.
      if (!tex?.isTexture) continue;
      const reported = typeof size === "number" ? size : 0;
      threeReported += reported;
      const bytes = tex.isCompressedTexture ? compressedBytes(tex) : reported;
      total += bytes;
      const isTarget = !!(tex.isRenderTargetTexture || tex.isDepthTexture || tex.__isRenderTarget);
      const isCompressed = !!tex.isCompressedTexture;
      const kind = isTarget ? "renderTarget" : isCompressed ? "compressed" : "uncompressed";
      bucket[kind] += bytes;
      count[kind]++;
      // A render target is never "referenced by a material" and must not be
      // reported as a leak — only source art can be orphaned this way.
      const orphan = !isTarget && !referenced.has(tex);
      if (orphan) { bucket.unreferenced += bytes; count.unreferenced++; }
      rows.push({
        name: tex.name || tex.userData?.path || tex.source?.data?.src?.slice?.(-60) || "(unnamed)",
        kind,
        mb: +(bytes / 1048576).toFixed(2),
        size: tex.image ? `${tex.image.width ?? "?"}x${tex.image.height ?? "?"}` : "?",
        orphan: orphan || undefined,
      });
    }
    rows.sort((a, b) => b.mb - a.mb);
    const mb = (b) => +(b / 1048576).toFixed(1);
    return {
      trackedTextures: count.renderTarget + count.compressed + count.uncompressed,
      trueTotalMB: mb(total),
      statsOverlayMB: mb(threeReported),
      byKind: {
        renderTargets: { count: count.renderTarget, mb: mb(bucket.renderTarget) },
        compressedSource: { count: count.compressed, mb: mb(bucket.compressed) },
        uncompressedSource: { count: count.uncompressed, mb: mb(bucket.uncompressed) },
      },
      notReferencedByOpenScene: { count: count.unreferenced, mb: mb(bucket.unreferenced) },
      largest: rows.slice(0, Math.max(1, Math.min(200, Math.round(limit)))),
      note:
        "`statsOverlayMB` is what the Stats overlay shows and it counts every COMPRESSED texture as 1 byte " +
        "(three's own fallback), so it understates a compressed project badly; `trueTotalMB` estimates the real cost. " +
        "`uncompressedSource` is what compression can still take — expect 4x from it (RGBA8 -> BC7) or 8x (-> BC1), " +
        "set by FORMAT, never by how much the file shrank on disk. `renderTargets` is what compression can never take.",
    };
  },
});

defineOp({
  name: "profile.cpuFrame",
  readOnly: true,
  description:
    "Where the CPU half of the frame goes, broken down by engine-tick phase and measured with real wall-clock marks inside Engine.#tick. The counterpart to profile.giPasses and profile.renderPasses, which only see GPU work: when `profile.frameStats` reports cpuMs well above gpuMs the frame is CPU-bound and NO renderer setting can fix it, so use this to find which phase owns the time before touching a shader, a quality preset or a draw count. Reports the mean ms per frame over a multi-frame capture, plus the same frame's gpuMs and draw count so the two halves can be compared directly. `renderEncode` is WebGPU command encoding — high there means too many draw submissions, not expensive pixels.",
  params: {
    frames: {
      type: "number",
      default: 60,
      description:
        "Frames to average over. One tick is not a measurement on a scene with GC pauses. Max 600.",
    },
  },
  async run({ frames = 60 }) {
    const stats = engine?.stats;
    if (!stats) throw new Error("No engine.");
    const want = Math.max(1, Math.min(600, Math.round(frames)));
    stats.beginPhaseCapture(want);
    // Wait for the capture to fill rather than for a fixed duration: on a 10
    // fps scene a 1 s wait would collect six frames and report the mean of a
    // sample too small to separate a GC pause from a phase. Capped so a
    // suspended viewport (which ticks but may not reach every phase) cannot
    // hang the call.
    const deadline = Date.now() + 20_000;
    while (!stats.phaseCaptureComplete() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const capture = stats.readPhaseCapture();
    const r = stats.sample();
    const cpuMs = +(r.workMs || r.frameMs).toFixed(2);
    const gpuMs = +(r.gpuMs > 0 ? r.gpuMs : r.renderMs).toFixed(2);
    const top = capture.phases[0];
    return {
      ...capture,
      // The comparison that decides whether any of this matters. A frame with
      // cpuMs >> gpuMs cannot be fixed by lowering quality, and that is the
      // single most expensive misdiagnosis available on this engine.
      cpuMs,
      gpuMs,
      gpuMsIsReal: r.gpuMs > 0,
      bound: cpuMs > gpuMs * 1.25 ? "cpu" : gpuMs > cpuMs * 1.25 ? "gpu" : "balanced",
      drawCalls: r.drawCalls,
      triangles: r.triangles,
      jsHeapMB: r.jsHeapBytes == null ? null : +(r.jsHeapBytes / 1048576).toFixed(1),
      note:
        (capture.complete
          ? `Averaged ${capture.frames} frames. `
          : `INCOMPLETE — only ${capture.frames} frames in 20 s; the loop is stalled or suspended, and the means below are over what was collected. `) +
        (top ? `Costliest phase: ${top.name} at ${top.ms} ms (${top.pct}%). ` : "") +
        (capture.subPhases?.length
          ? `\`subPhases\` breaks a module's work out INSIDE its phase (gi.* sits inside preRender); it sums to less than its parent, and the shortfall is real unmarked time, not zero. Costliest: ${capture.subPhases[0].name} at ${capture.subPhases[0].ms} ms. `
          : "") +
        "`totalMs` is the sum of the phases and should track frameStats' cpuMs; a large gap means time is " +
        "going somewhere #tick does not mark (host-side work, or a GC pause landing between phases).",
    };
  },
});
