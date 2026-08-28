// §19 STAGE 6.2 — WAIT FOR THE EMITTER SEATS, NOT JUST FOR FIRST LIGHT
//
// ⭐⭐⭐ THE BUG THIS EXISTS TO DELETE: every gi2 probe reported Bistro as having
// **0 emitters** while the user's live editor, on the very same scene file, seats
// four lamps. Nothing was wrong with the scene, the admission gate, or the
// probe's pose. The probes were simply READING TOO EARLY.
//
// `[gi2] first light` fires on GEOMETRY-ready. That is deliberate — GI2's
// `#readyToRebuild` geometry gate (`GISystem.js` ~:4629) exists precisely so the
// window does not wait on the material/texture tail, and the comment there
// records that Bistro spends 26.9 of its 29.7 s from scene open inside that
// gate. But a `.mat` asset carries its real emissive on `emissiveNode`, not on
// `material.emissive`, and that node lands with the material tail — up to ~27 s
// AFTER first light. `#buildEntries` runs before any of them have resolved, so
// every candidate scores `peak = 0`, and only `#checkFingerprint` re-minting
// entries later produces the 95 candidates and 4 seats.
//
// So the probes' `first light` + a 14 s settle was a RACE, and it is a race that
// always resolves the same way in the harness (too early) and the other way in a
// live editor session (open for minutes). That is the worst shape a race can
// have: perfectly reproducible, and reproducibly wrong.
//
// ⚠ THE `sys: false` BRANCH IS NOT DEFENSIVE PADDING. A probe whose accessor is
// missing returns 0 seats — the same number a genuinely dark scene returns. If
// this helper collapsed the two, it would hand back a confident zero measured by
// an instrument that could not see its subject. It reports which one happened.

/**
 * Blocks until the GI system has seated at least one emitter, or until
 * `timeoutMs`. Returns what it saw so the caller can print or assert on it.
 *
 * @param {import("puppeteer").Page} page
 * @param {{timeoutMs?: number, pollMs?: number, minSeats?: number}} [opts]
 * @returns {Promise<{seats: number, cands: number, sys: boolean, ms: number, timedOut: boolean}>}
 */
export async function waitForEmitterSeats(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const pollMs = opts.pollMs ?? 500;
  const minSeats = opts.minSeats ?? 1;

  const read = () => page.evaluate(() => {
    // `__giSys` is the accessor every gi2 runner installs in its own
    // `evaluateOnNewDocument` preamble. Absent means the caller wired this
    // helper into a probe that never installed it — reported, never guessed at.
    const sys = typeof globalThis.__giSys === "function" ? globalThis.__giSys() : null;
    if (!sys) return { sys: false, seats: 0, cands: 0 };
    return {
      sys: true,
      // `_emitterInfos` is sparse — `#chooseEmitterSeats` writes into slots, so
      // `.length` counts holes and `filter(Boolean)` counts lamps.
      seats: sys._emitterInfos?.filter(Boolean).length ?? 0,
      cands: sys._emitterCands?.length ?? 0,
    };
  }).catch(() => ({ sys: false, seats: 0, cands: 0 }));

  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let last = await read();
  while (last.seats < minSeats && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    last = await read();
  }
  return { ...last, ms: Date.now() - t0, timedOut: last.seats < minSeats };
}

/**
 * The same wait, plus the one line the probe should print. Kept together because
 * the interesting part is the DIAGNOSIS in the failure branches, and a caller
 * that hand-rolls the log tends to print `0` and move on — which is the exact
 * behaviour that hid this for a session.
 */
export async function reportEmitterSeats(page, opts = {}) {
  const r = await waitForEmitterSeats(page, opts);
  if (!r.sys) {
    console.log("  emitter seats: UNREADABLE — no globalThis.__giSys accessor in this probe; "
      + "the number below is not a measurement of the scene");
  } else if (r.timedOut) {
    console.log(`  emitter seats: STILL 0 after ${(r.ms / 1000).toFixed(0)}s `
      + `(${r.cands} candidates) — a real fault, not the first-light race`);
  } else {
    console.log(`  emitter seats: ${r.seats} of ${r.cands} candidates, `
      + `${(r.ms / 1000).toFixed(1)}s after first light`);
  }
  return r;
}
